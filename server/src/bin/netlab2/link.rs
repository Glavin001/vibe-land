//! The deterministic link between the server's queues and the client.
//!
//! Two links:
//!
//! - **recorded**: every packet arrives exactly when the recorded client
//!   received it (or is lost where the live one was). A lab packet takes the
//!   fate and arrival time of the live packet it corresponds to (same tick,
//!   kind and ordinal); this is the calibration link.
//! - **simulated**: a seeded model of the production transport, WebTransport
//!   over QUIC (quinn 0.11, as the server builds it):
//!     * two server-side lanes, as `outbound.rs` queues them: the ordered
//!       reliable stream and datagrams (`wants_unreliable_delivery`);
//!     * one QUIC sender, paced at the bottleneck rate (the ideal of the BBR
//!       controller the server configures): packets wait at the SENDER, not
//!       in the network, which is where quinn keeps them;
//!     * inside the sender, datagrams go first (quinn writes DATAGRAM frames
//!       before STREAM frames in every packet) and are held in a 1 MiB
//!       buffer that drops its OLDEST datagram when full (quinn's
//!       `datagram_send_buffer_size`, drop-oldest send); a datagram larger
//!       than the path allows is refused and, except for snapshots under the
//!       strict rule, re-sent on the reliable stream (`classify_outbound_delivery`);
//!     * stream bytes are cut into QUIC packets; a lost packet is detected
//!       one smoothed RTT x 9/8 later (the time threshold; the stream is never
//!       idle because datagrams flow at 60 Hz and carry the ACKs) and sent
//!       again, ahead of new data; the application sees a frame only when it
//!       and every byte before it have arrived (head-of-line blocking);
//!     * the path: one-way delay + uniform jitter, per-packet Bernoulli loss
//!       or a Gilbert-Elliott burst model, optional straggler reordering --
//!       the parameters of the live netlab's `netemProfiles.json`.
//!   Production has no feedback from the link into either encoder (the
//!   snapshot budget and the city ceiling are fixed per send); the only
//!   coupling is the outbound queues, and the model reports when the
//!   reliable backlog passes quinn's send window, which is where production
//!   would stall the writer, fill the 256-deep queue and close the
//!   connection (`Outcome::ReliableOverflow`).

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::stream::{is_snapshot_kind, Lane, Outgoing};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeModel {
    /// Percent chance per packet of entering the bad (all-lost) state.
    pub p: f64,
    /// Percent chance per packet of leaving it.
    pub r: f64,
}

/// A link profile. Field names and meanings are `netemProfiles.json`'s.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    /// One-way delay, ms.
    pub delay_ms: f64,
    /// Uniform jitter half-width, ms.
    pub jitter_ms: f64,
    pub loss_pct: f64,
    pub reorder_pct: Option<f64>,
    /// Bottleneck rate; none = unlimited.
    pub rate_mbit: Option<f64>,
    /// netem's queue limit (packets). Informational under the paced model,
    /// where the queue is at the sender.
    pub limit_pkts: Option<u32>,
    pub gemodel_pct: Option<GeModel>,
    /// Largest datagram payload the path takes (quinn: path MTU minus
    /// headers; 1200-byte initial MTU gives ~1160).
    pub max_datagram_bytes: Option<usize>,
    /// Free text.
    pub comment: Option<String>,
}

pub const UDP_OVERHEAD_BYTES: usize = 28 + 32; // IPv4+UDP, QUIC short header + AEAD + frame
pub const STREAM_CHUNK_BYTES: usize = 1140;
pub const DATAGRAM_BUFFER_BYTES: usize = 1024 * 1024;
/// quinn's default send window (8 x 1.25 MB).
pub const SEND_WINDOW_BYTES: usize = 10 * 1024 * 1024;
pub const DEFAULT_MAX_DATAGRAM_BYTES: usize = 1160;

pub fn load_profiles(json: &str) -> Result<BTreeMap<String, Profile>, String> {
    #[derive(Deserialize)]
    struct File {
        profiles: BTreeMap<String, Profile>,
    }
    serde_json::from_str::<File>(json).map(|file| file.profiles).map_err(|e| e.to_string())
}

/// What happened to one packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Fate {
    Delivered,
    /// A datagram lost on the path.
    Lost,
    /// Pushed out of the sender's datagram buffer by newer datagrams.
    SenderDropped,
    /// Too large for a datagram and a snapshot (strict rule): dropped.
    StrictDrop,
    /// Delivered on the reliable stream after the datagram was refused.
    Fallback,
    /// Recorded link: the live server never delivered it.
    RecordedNotDelivered,
    /// Recorded link: no live counterpart to take a time from.
    RecordedUnmatched,
}

#[derive(Clone, Copy, Debug)]
pub struct Delivery {
    pub arrive_ms: Option<f64>,
    /// The channel it arrived on (tape channel code).
    pub channel: u8,
    pub fate: Fate,
    /// Reliable only: time spent waiting for earlier stream bytes after its
    /// own bytes had all arrived (head-of-line blocking), ms.
    pub hol_ms: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LinkStats {
    pub udp_packets: u64,
    pub udp_bytes: u64,
    pub udp_lost: u64,
    pub stream_retransmits: u64,
    pub datagrams_lost: u64,
    pub datagrams_sender_dropped: u64,
    pub datagrams_strict_dropped: u64,
    pub datagrams_fallback: u64,
    pub max_stream_backlog_bytes: u64,
    /// The reliable backlog exceeded quinn's send window: production would
    /// have filled the outbound queue and closed the connection here.
    pub send_window_overflows: u64,
    pub first_overflow_ms: Option<f64>,
    pub max_sender_delay_ms: f64,
}

/// Seeded PRNG (splitmix64): the same seed replays the same losses.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The path: loss process, delay, jitter, stragglers.
struct Path {
    profile: Profile,
    rng: Rng,
    bad: bool,
}

impl Path {
    fn lost(&mut self) -> bool {
        if let Some(ge) = &self.profile.gemodel_pct {
            if self.bad {
                if self.rng.unit() * 100.0 < ge.r {
                    self.bad = false;
                }
            } else if self.rng.unit() * 100.0 < ge.p {
                self.bad = true;
            }
            if self.bad {
                return true;
            }
        }
        self.rng.unit() * 100.0 < self.profile.loss_pct
    }

    fn transit_ms(&mut self) -> f64 {
        let jitter = (self.rng.unit() * 2.0 - 1.0) * self.profile.jitter_ms;
        let mut delay = (self.profile.delay_ms + jitter).max(0.0);
        if let Some(reorder) = self.profile.reorder_pct {
            if self.rng.unit() * 100.0 < reorder {
                delay += self.profile.jitter_ms * 3.0;
            }
        }
        delay
    }
}

/// A stream chunk waiting to go (or go again).
#[derive(Clone, Copy)]
struct Chunk {
    /// Byte range end within the stream (exclusive).
    end: u64,
    bytes: usize,
    ready_ms: f64,
    retransmit: bool,
}

/// Runs the simulated link over the server stage's packets (sorted by
/// departure). Deterministic for a given profile and seed.
pub fn simulate(packets: &[Outgoing], profile: &Profile, seed: u64) -> (Vec<Delivery>, LinkStats) {
    let mut stats = LinkStats::default();
    let mut path = Path { profile: profile.clone(), rng: Rng::new(seed), bad: false };
    let bytes_per_ms = profile.rate_mbit.map(|mbit| mbit * 1e6 / 8.0 / 1000.0);
    let max_datagram = profile.max_datagram_bytes.unwrap_or(DEFAULT_MAX_DATAGRAM_BYTES);
    let rtt_ms = 2.0 * profile.delay_ms.max(0.05);
    let detect_ms = rtt_ms * 9.0 / 8.0 + profile.jitter_ms;

    let mut deliveries: Vec<Delivery> = packets
        .iter()
        .map(|_| Delivery { arrive_ms: None, channel: 0, fate: Fate::Lost, hol_ms: 0.0 })
        .collect();

    // Stream frames: (packet index, end offset of the frame in the stream).
    let mut frames: Vec<(usize, u64)> = Vec::new();
    let mut stream_len: u64 = 0;
    // Datagrams in the sender buffer: (packet index, bytes, ready).
    let mut dgram_buf: VecDeque<(usize, usize, f64)> = VecDeque::new();
    let mut dgram_buf_bytes = 0usize;
    let mut chunks: VecDeque<Chunk> = VecDeque::new();
    // Retransmissions become ready later; kept apart and merged in by time.
    let mut retransmits: Vec<Chunk> = Vec::new();
    // Arrival time of each stream chunk's bytes (by end offset).
    let mut chunk_arrivals: BTreeMap<u64, (u64, f64)> = BTreeMap::new(); // end -> (start, arrive)

    let mut link_free_ms = f64::MIN;
    let mut next = 0usize;
    let serialize = |bytes: usize| -> f64 {
        match bytes_per_ms {
            Some(rate) => (bytes + UDP_OVERHEAD_BYTES) as f64 / rate,
            None => 0.0,
        }
    };

    // Event loop: at each step, send whatever the sender has (datagrams
    // first, then retransmissions, then new stream data) once the link is
    // free; admit packets from the server as their departure times pass.
    loop {
        // Earliest thing that could happen next.
        let next_depart = packets.get(next).map(|p| p.depart_ms);
        let sender_has_work = !dgram_buf.is_empty() || !chunks.is_empty() || !retransmits.is_empty();
        if next_depart.is_none() && !sender_has_work {
            break;
        }
        let earliest_work = [
            dgram_buf.front().map(|d| d.2),
            chunks.front().map(|c| c.ready_ms),
            retransmits.iter().map(|c| c.ready_ms).min_by(|a, b| a.total_cmp(b)),
        ]
        .into_iter()
        .flatten()
        .min_by(|a, b| a.total_cmp(b));
        let send_at = earliest_work.map(|t| t.max(link_free_ms));
        // Admit a server packet if it departs no later than the next send.
        if let Some(depart) = next_depart {
            if send_at.map_or(true, |s| depart <= s) {
                let index = next;
                next += 1;
                let packet = &packets[index];
                match packet.lane {
                    Lane::Datagram if packet.bytes.len() <= max_datagram => {
                        dgram_buf.push_back((index, packet.bytes.len(), packet.depart_ms));
                        dgram_buf_bytes += packet.bytes.len();
                        while dgram_buf_bytes > DATAGRAM_BUFFER_BYTES {
                            let (dropped, bytes, _) = dgram_buf.pop_front().unwrap();
                            dgram_buf_bytes -= bytes;
                            deliveries[dropped].fate = Fate::SenderDropped;
                            stats.datagrams_sender_dropped += 1;
                        }
                    }
                    Lane::Datagram if is_snapshot_kind(packet.kind) => {
                        deliveries[index].fate = Fate::StrictDrop;
                        stats.datagrams_strict_dropped += 1;
                    }
                    _ => {
                        if packet.lane == Lane::Datagram {
                            stats.datagrams_fallback += 1;
                            deliveries[index].fate = Fate::Fallback;
                        } else {
                            deliveries[index].fate = Fate::Delivered;
                        }
                        let frame_bytes = packet.bytes.len() as u64 + 4;
                        let start = stream_len;
                        stream_len += frame_bytes;
                        frames.push((index, stream_len));
                        let mut at = start;
                        while at < stream_len {
                            let end = (at + STREAM_CHUNK_BYTES as u64).min(stream_len);
                            // Coalesce with a not-yet-sent tail chunk.
                            if let Some(last) = chunks.back_mut() {
                                if !last.retransmit && last.end == at && last.bytes + ((end - at) as usize) <= STREAM_CHUNK_BYTES {
                                    last.bytes += (end - at) as usize;
                                    last.end = end;
                                    at = end;
                                    continue;
                                }
                            }
                            chunks.push_back(Chunk { end, bytes: (end - at) as usize, ready_ms: packet.depart_ms, retransmit: false });
                            at = end;
                        }
                        let queued: u64 = chunks.iter().chain(retransmits.iter()).map(|c| c.bytes as u64).sum();
                        stats.max_stream_backlog_bytes = stats.max_stream_backlog_bytes.max(queued);
                        if queued > SEND_WINDOW_BYTES as u64 {
                            stats.send_window_overflows += 1;
                            stats.first_overflow_ms.get_or_insert(packet.depart_ms);
                        }
                    }
                }
                continue;
            }
        }
        let Some(now) = send_at else {
            continue;
        };
        // Pick: a ready datagram, else a ready retransmission, else new data.
        if let Some(&(index, bytes, ready)) = dgram_buf.front() {
            if ready <= now {
                dgram_buf.pop_front();
                dgram_buf_bytes -= bytes;
                let done = now + serialize(bytes);
                link_free_ms = done;
                stats.udp_packets += 1;
                stats.udp_bytes += (bytes + UDP_OVERHEAD_BYTES) as u64;
                stats.max_sender_delay_ms = stats.max_sender_delay_ms.max(now - ready);
                if path.lost() {
                    stats.udp_lost += 1;
                    stats.datagrams_lost += 1;
                    deliveries[index].fate = Fate::Lost;
                } else {
                    deliveries[index] = Delivery {
                        arrive_ms: Some(done + path.transit_ms()),
                        channel: crate::vltape::CHANNEL_WT_DATAGRAM,
                        fate: Fate::Delivered,
                        hol_ms: 0.0,
                    };
                }
                continue;
            }
        }
        retransmits.sort_by(|a, b| a.ready_ms.total_cmp(&b.ready_ms));
        let chunk = if retransmits.first().is_some_and(|c| c.ready_ms <= now) {
            Some(retransmits.remove(0))
        } else if chunks.front().is_some_and(|c| c.ready_ms <= now) {
            chunks.pop_front()
        } else {
            None
        };
        let Some(chunk) = chunk else {
            // The earliest-ready item is always at the front of one of the
            // three queues, so something is sendable at `now`.
            unreachable!("link sender had work but nothing was ready");
        };
        let done = now + serialize(chunk.bytes);
        link_free_ms = done;
        stats.udp_packets += 1;
        stats.udp_bytes += (chunk.bytes + UDP_OVERHEAD_BYTES) as u64;
        if path.lost() {
            stats.udp_lost += 1;
            stats.stream_retransmits += 1;
            retransmits.push(Chunk { ready_ms: done + detect_ms, retransmit: true, ..chunk });
        } else {
            let arrive = done + path.transit_ms();
            let start = chunk.end - chunk.bytes as u64;
            chunk_arrivals.insert(chunk.end, (start, arrive));
        }
    }

    // In-order delivery: a frame is readable once every byte up to its end
    // has arrived; the stream is contiguous, so walk chunks in offset order.
    let mut contiguous_ms = f64::MIN;
    let mut chunk_iter = chunk_arrivals.iter();
    let mut covered: u64 = 0;
    for (index, frame_end) in frames {
        let mut own_ms = f64::MIN;
        while covered < frame_end {
            let Some((&end, &(start, arrive))) = chunk_iter.next() else {
                break;
            };
            debug_assert_eq!(start, covered, "stream chunks must tile the stream");
            covered = end;
            contiguous_ms = contiguous_ms.max(arrive);
            own_ms = own_ms.max(arrive);
        }
        if covered < frame_end {
            deliveries[index].arrive_ms = None;
            deliveries[index].fate = Fate::Lost;
            continue;
        }
        let own = if own_ms == f64::MIN { contiguous_ms } else { own_ms };
        deliveries[index].arrive_ms = Some(contiguous_ms);
        deliveries[index].channel = crate::vltape::CHANNEL_WT_RELIABLE;
        deliveries[index].hol_ms = (contiguous_ms - own).max(0.0);
    }
    (deliveries, stats)
}

/// The recorded link: each packet arrives when (and on the channel) the
/// live client received it; a lab packet takes its live counterpart's fate.
pub fn recorded(
    bundle: &crate::bundle::Bundle,
    packets: &[Outgoing],
) -> Vec<Delivery> {
    let mut fallback_latency: HashMap<Lane, f64> = HashMap::new();
    for (lane, latency) in &crate::stream::join(bundle).median_latency_ms {
        fallback_latency.insert(*lane, *latency);
    }
    packets
        .iter()
        .map(|packet| match packet.tape_index {
            Some(index) => {
                let taped = &bundle.tape.packets[index];
                Delivery {
                    arrive_ms: Some(taped.t_ms),
                    channel: taped.base_channel(),
                    fate: Fate::Delivered,
                    hol_ms: 0.0,
                }
            }
            None => match packet.live_record {
                Some(record) if bundle.sendlog[record].outcome > 1 => Delivery {
                    arrive_ms: None,
                    channel: 0,
                    fate: Fate::RecordedNotDelivered,
                    hol_ms: 0.0,
                },
                // Delivered live but not on the tape (after it stopped), or
                // no live counterpart: the lane's typical latency.
                _ => Delivery {
                    arrive_ms: Some(
                        packet.depart_ms + fallback_latency.get(&packet.lane).copied().unwrap_or(0.5),
                    ),
                    channel: match packet.lane {
                        Lane::Reliable => crate::vltape::CHANNEL_WT_RELIABLE,
                        Lane::Datagram => crate::vltape::CHANNEL_WT_DATAGRAM,
                    },
                    fate: Fate::RecordedUnmatched,
                    hol_ms: 0.0,
                },
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::Origin;

    fn packet(depart_ms: f64, lane: Lane, kind: u8, bytes: usize, seq: u64) -> Outgoing {
        let mut body = vec![0u8; bytes];
        body[0] = kind;
        Outgoing {
            depart_ms,
            seq,
            tick: 0,
            lane,
            kind,
            bytes: body,
            origin: Origin::Lab,
            tape_index: None,
            live_record: None,
            ordinal: 0,
        }
    }

    fn stream(n: usize, bytes: usize, every_ms: f64) -> Vec<Outgoing> {
        (0..n)
            .map(|i| {
                let lane = if i % 2 == 0 { Lane::Datagram } else { Lane::Reliable };
                let kind = if lane == Lane::Datagram { 112 } else { 120 };
                packet(i as f64 * every_ms, lane, kind, bytes, i as u64)
            })
            .collect()
    }

    #[test]
    fn same_seed_same_outcome_other_seed_differs() {
        let profile = Profile { delay_ms: 40.0, jitter_ms: 10.0, loss_pct: 5.0, ..Default::default() };
        let packets = stream(4000, 300, 2.0);
        let (a, _) = simulate(&packets, &profile, 7);
        let (b, _) = simulate(&packets, &profile, 7);
        let (c, _) = simulate(&packets, &profile, 8);
        let key = |d: &[Delivery]| d.iter().map(|x| (x.fate, x.arrive_ms.map(|t| (t * 1000.0) as i64))).collect::<Vec<_>>();
        assert_eq!(key(&a), key(&b));
        assert_ne!(key(&a), key(&c));
    }

    #[test]
    fn clean_link_delivers_everything_after_the_delay() {
        let profile = Profile { delay_ms: 25.0, ..Default::default() };
        let packets = stream(200, 500, 5.0);
        let (deliveries, stats) = simulate(&packets, &profile, 1);
        for (packet, delivery) in packets.iter().zip(&deliveries) {
            let arrive = delivery.arrive_ms.expect("delivered");
            assert!((arrive - packet.depart_ms - 25.0).abs() < 1e-6, "{arrive} vs {}", packet.depart_ms);
        }
        assert_eq!(stats.udp_lost, 0);
    }

    #[test]
    fn datagram_loss_rate_matches_the_profile_and_reliable_loses_nothing() {
        let profile = Profile { delay_ms: 10.0, loss_pct: 10.0, ..Default::default() };
        let packets = stream(20_000, 200, 1.0);
        let (deliveries, stats) = simulate(&packets, &profile, 3);
        let datagrams: Vec<_> = packets.iter().zip(&deliveries).filter(|(p, _)| p.lane == Lane::Datagram).collect();
        let lost = datagrams.iter().filter(|(_, d)| d.fate == Fate::Lost).count() as f64;
        let rate = lost / datagrams.len() as f64;
        assert!((rate - 0.10).abs() < 0.015, "datagram loss {rate}");
        let reliable_lost = packets
            .iter()
            .zip(&deliveries)
            .filter(|(p, d)| p.lane == Lane::Reliable && d.arrive_ms.is_none())
            .count();
        assert_eq!(reliable_lost, 0, "the reliable stream must deliver everything");
        assert!(stats.stream_retransmits > 0);
    }

    #[test]
    fn reliable_stream_is_in_order_with_head_of_line_blocking() {
        let profile = Profile { delay_ms: 30.0, loss_pct: 20.0, ..Default::default() };
        let packets: Vec<_> = (0..3000).map(|i| packet(i as f64 * 3.0, Lane::Reliable, 120, 400, i)).collect();
        let (deliveries, _) = simulate(&packets, &profile, 11);
        let mut last = f64::MIN;
        let mut blocked = 0;
        for delivery in &deliveries {
            let arrive = delivery.arrive_ms.expect("reliable is reliable");
            assert!(arrive >= last, "reliable frames must never be delivered out of order");
            last = arrive;
            if delivery.hol_ms > 0.0 {
                blocked += 1;
            }
        }
        assert!(blocked > 0, "a lost chunk must hold back the frames behind it");
        // A retransmission costs about one RTT x 9/8 on top of the path.
        let worst = deliveries
            .iter()
            .zip(&packets)
            .map(|(d, p)| d.arrive_ms.unwrap() - p.depart_ms)
            .fold(0.0f64, f64::max);
        assert!(worst >= 30.0 + 67.5, "worst {worst}");
    }

    #[test]
    fn datagrams_can_overtake_each_other_under_jitter() {
        let profile = Profile { delay_ms: 50.0, jitter_ms: 20.0, ..Default::default() };
        let packets: Vec<_> = (0..500).map(|i| packet(i as f64, Lane::Datagram, 112, 100, i)).collect();
        let (deliveries, _) = simulate(&packets, &profile, 5);
        let arrivals: Vec<f64> = deliveries.iter().map(|d| d.arrive_ms.unwrap()).collect();
        assert!(arrivals.windows(2).any(|w| w[1] < w[0]), "jitter must reorder datagrams");
    }

    #[test]
    fn bandwidth_caps_throughput_and_queues_at_the_sender() {
        // 1 Mbit/s = 125 bytes/ms; offer 2x that.
        let profile = Profile { delay_ms: 20.0, rate_mbit: Some(1.0), ..Default::default() };
        let packets: Vec<_> = (0..1000).map(|i| packet(i as f64 * 4.0, Lane::Reliable, 120, 1000 - 4 - 60, i)).collect();
        let (deliveries, stats) = simulate(&packets, &profile, 1);
        let last = deliveries.last().unwrap().arrive_ms.unwrap();
        let bytes = stats.udp_bytes as f64;
        let achieved = bytes / (last - 20.0);
        assert!(achieved <= 125.0 * 1.01, "throughput {achieved} B/ms over a 125 B/ms link");
        assert!(last > 3990.0 * 1.9, "a 2x overload must take about twice as long: {last}");
        assert!(stats.max_stream_backlog_bytes > 100_000);
    }

    #[test]
    fn oversized_snapshot_is_dropped_and_other_datagrams_fall_back() {
        let profile = Profile { delay_ms: 5.0, max_datagram_bytes: Some(1000), ..Default::default() };
        let packets = vec![
            packet(0.0, Lane::Datagram, 112, 1200, 0),
            packet(1.0, Lane::Datagram, 119, 1200, 1),
        ];
        let (deliveries, stats) = simulate(&packets, &profile, 1);
        assert_eq!(deliveries[0].fate, Fate::StrictDrop);
        assert_eq!(deliveries[1].fate, Fate::Fallback);
        assert_eq!(deliveries[1].channel, crate::vltape::CHANNEL_WT_RELIABLE);
        assert_eq!(stats.datagrams_fallback, 1);
    }

    #[test]
    fn datagram_buffer_drops_oldest_when_the_link_cannot_keep_up() {
        let profile = Profile { delay_ms: 5.0, rate_mbit: Some(0.1), ..Default::default() };
        let packets: Vec<_> = (0..3000).map(|i| packet(i as f64 * 0.1, Lane::Datagram, 119, 1100, i)).collect();
        let (deliveries, stats) = simulate(&packets, &profile, 1);
        assert!(stats.datagrams_sender_dropped > 0);
        // Oldest go first: the last datagram offered is still delivered.
        assert_eq!(deliveries.last().unwrap().fate, Fate::Delivered);
    }

    #[test]
    fn gilbert_elliott_loses_in_bursts() {
        let profile = Profile {
            delay_ms: 5.0,
            gemodel_pct: Some(GeModel { p: 1.0, r: 20.0 }),
            ..Default::default()
        };
        let packets: Vec<_> = (0..50_000).map(|i| packet(i as f64, Lane::Datagram, 112, 100, i)).collect();
        let (deliveries, _) = simulate(&packets, &profile, 9);
        let lost: Vec<bool> = deliveries.iter().map(|d| d.fate == Fate::Lost).collect();
        let losses = lost.iter().filter(|l| **l).count() as f64;
        let runs = lost.windows(2).filter(|w| w[1] && !w[0]).count() as f64;
        // Mean burst length is 1/r = 5 packets.
        let mean_burst = losses / runs.max(1.0);
        assert!(mean_burst > 3.0 && mean_burst < 7.5, "mean burst {mean_burst}");
    }
}
