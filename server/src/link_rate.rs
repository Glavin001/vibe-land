//! Per-link rate adaptation for the /city pose stream.
//!
//! The city encoder picks, per client and per send, the records that remove
//! the most visible error per byte, under a byte allowance. Until now that
//! allowance was one fixed ceiling (10.4 kB per send, ~2.5 Mbit/s at 30 Hz)
//! for every client. A link slower than the stream's peaks could not carry
//! it: the excess waited in the QUIC sender's datagram buffer (1 MiB,
//! drop-oldest), and on a 0.5 Mbit/s link a pose arrived seconds after it
//! was sent (docs/netcode-tuning.md, measured in Netlab v2).
//!
//! This controller gives each connection its own allowance and cadence,
//! from what the server can read about that connection's link:
//!
//! - **the datagram send buffer** (`quinn::Connection::datagram_send_buffer_space`):
//!   datagrams go first in the QUIC sender, so a buffer that stays non-empty
//!   from one send to the next means the path cannot carry what is offered;
//!   its size divided by the path rate is the queueing delay every datagram
//!   (snapshots included) is about to pay;
//! - **bytes on the wire** (`stats().udp_tx.bytes`): while the buffer stays
//!   backlogged the sender is never idle, so the wire rate over that span is
//!   the path's capacity (the delivery-rate sample BBR itself uses);
//! - **bytes the server queued** on this connection (all lanes): the part
//!   the city stream does not own (snapshots, topology, baselines, ...) is
//!   subtracted from the capacity before the city gets its share;
//! - the RTT also sets how quickly a standing queue is drained;
//! - **RTT** (`stats().path.rtt`) above its windowed minimum: quinn 0.11's
//!   BBR does not hold datagrams back on a slow path (measured, see
//!   `quic_rate_tests` in main.rs), so there the queue forms in the network
//!   and shows up as round-trip time instead of buffered bytes;
//! - **lost packets and bytes** (`stats().path`): delivery is what went on
//!   the wire less what was declared lost; a heavy loss share with a queue
//!   standing cuts the estimate at once. Loss alone never throttles: the
//!   server runs BBR precisely because loss on these links is mostly not
//!   congestion (`wt_transport_config`).
//!
//! The congestion window is readable too (`stats().path.cwnd`) but is not
//! used: with BBR it is a function of the same bandwidth estimate, and the
//! backlog already says whether the path keeps up.
//!
//! **Control law** (a delay-based, BBR-like controller):
//!
//! - `Free` (the start state): the static ceiling applies unchanged, so a
//!   link that keeps up sends exactly what it sent before. It becomes
//!   `Limited` only when the datagram buffer has held at least
//!   `backlog_bytes` at `enter_samples` consecutive sends (≈100 ms): a burst
//!   that the path drains within one send interval never counts.
//! - `Limited`: the city's byte rate is
//!   `headroom × capacity − other traffic − standing excess / drain time`,
//!   where the standing excess is the buffered bytes beyond
//!   `target_queue_ms` of capacity. Capacity is the max of the wire-rate
//!   samples over `capacity_window_ms`: a span where datagrams waited at
//!   every read measures the path; a span where the sender idled counts
//!   only if it is higher (it is still a delivery the path made). One phase
//!   in eight offers `probe_gain` times the share, so a faster path shows
//!   up as a higher delivery; the next phase drains what the probe queued.
//! - **Cadence:** the rate fills a token bucket; a send smaller than
//!   `min_send_bytes` is not worth its packet, so the send is skipped and
//!   the budget is carried to the next one (the send rate falls, each send
//!   gets bigger).
//! - Back to `Free` once the path has been measured carrying the static
//!   ceiling's rate plus the other traffic, with no standing queue, for
//!   `release_ms`. A constrained link stays
//!   `Limited` through its quiet stretches (the allowance does not bind
//!   then), so the next burst is paced from its first send.
//!
//! **Priority under the budget** is the encoder's own: required records
//! (hard deadlines, interest entries) first, then error removed per byte
//! (`scheduler::select_with_ceiling`). The allowance only moves the cut line.
//!
//! The same code runs in Netlab v2's server stage, fed by its link model
//! (seam S15 in docs/netlab-v2.md).

/// quinn's datagram send buffer, as the server configures it
/// (`wt_transport_config`): occupancy is this minus
/// `datagram_send_buffer_space()`.
pub const QUIC_DATAGRAM_SEND_BUFFER_BYTES: usize = 1024 * 1024;

/// A span whose RTT inflation grew by more than this, ms, is a queue filling.
const GROWING_QUEUE_MS: f64 = 5.0;

/// Everything the controller reads about one connection, at one send.
/// Counters are cumulative since the connection opened.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinkSample {
    /// A monotonic clock, microseconds.
    pub at_us: u64,
    /// Bytes waiting in the QUIC sender's datagram buffer.
    pub datagram_buffered_bytes: u64,
    /// UDP payload bytes the QUIC sender has written (all packets, all lanes).
    pub wire_bytes: u64,
    /// QUIC packets sent / declared lost.
    pub sent_packets: u64,
    pub lost_packets: u64,
    /// Bytes of the packets declared lost.
    pub lost_bytes: u64,
    /// Smoothed round-trip time, microseconds.
    pub rtt_us: u64,
    /// Application bytes the server queued on this connection (all lanes).
    pub submitted_bytes: u64,
    /// Of those, the bytes queued on the ordered reliable stream.
    pub reliable_submitted_bytes: u64,
}

/// Something that can report a connection's `LinkSample`.
pub trait LinkProbe: Send + Sync {
    fn sample(&self) -> Option<LinkSample>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateConfig {
    pub enabled: bool,
    /// Buffered datagram bytes that count as a backlog (two full datagrams).
    pub backlog_bytes: u64,
    /// Round-trip time above the path's minimum that counts as a queue in
    /// the network, ms.
    pub rtt_queue_ms: f64,
    /// Consecutive backlogged sends before a link counts as constrained.
    pub enter_samples: u32,
    /// The minimum RTT is taken over this long, ms.
    pub min_rtt_window_ms: f64,
    /// Share of the measured capacity the connection aims to use.
    pub headroom: f64,
    /// Queueing delay allowed to stand, ms.
    pub target_queue_ms: f64,
    /// Extra queue allowed when it is seen as RTT: the send bursts' own, ms.
    pub burst_queue_ms: f64,
    /// A standing excess is drained over this long (at least two RTTs), ms.
    pub drain_ms: f64,
    /// Span of one capacity sample, ms.
    pub sample_span_ms: f64,
    /// How long a capacity sample counts (max filter), ms.
    pub capacity_window_ms: f64,
    /// Offered-rate gain of the probing phase (one phase in eight; the next
    /// one offers `2 - probe_gain` to drain it).
    pub probe_gain: f64,
    /// A probe that found more capacity makes the next one bolder, up to this.
    pub probe_gain_max: f64,
    /// Smallest city send worth a packet; below it sends are merged.
    pub min_send_bytes: usize,
    /// The city's rate never goes below this, bytes/s.
    pub min_rate_bytes_per_s: f64,
    /// Reliable-stream bytes waiting this long on a limited link make the
    /// city give the backlog back within `reliable_drain_ms`, ms (0: not
    /// read). They never make a link limited. See `reliable_backlog`.
    pub reliable_queue_ms: f64,
    pub reliable_drain_ms: f64,
    /// Per-packet bytes the QUIC sender adds to what the server queued, as
    /// assumed by the reliable-backlog estimate: a low bound (short header,
    /// AEAD tag, frame header), so the estimate errs low.
    pub packet_overhead_bytes: f64,
    /// Back to `Free` after the path has carried the static ceiling's rate
    /// plus the other traffic (with no standing queue) for this long, ms.
    pub release_ms: f64,
    /// Loss share (over `loss_window_ms`) that, with a standing queue, cuts
    /// the capacity estimate at once (limited state only).
    pub policer_loss: f64,
    pub loss_window_ms: f64,
    /// A loss window with fewer packets sent says nothing.
    pub policer_min_packets: u64,
}

impl RateConfig {
    pub const PRODUCTION: Self = Self {
        enabled: true,
        backlog_bytes: 2 * 1200,
        rtt_queue_ms: 60.0,
        enter_samples: 3,
        min_rtt_window_ms: 10_000.0,
        headroom: 0.9,
        target_queue_ms: 20.0,
        burst_queue_ms: 15.0,
        drain_ms: 250.0,
        sample_span_ms: 200.0,
        capacity_window_ms: 1500.0,
        probe_gain: 1.25,
        probe_gain_max: 2.5,
        min_send_bytes: 400,
        min_rate_bytes_per_s: 4_000.0,
        reliable_queue_ms: 60.0,
        reliable_drain_ms: 150.0,
        packet_overhead_bytes: 24.0,
        release_ms: 5_000.0,
        policer_loss: 0.10,
        loss_window_ms: 2_000.0,
        policer_min_packets: 60,
    };

    /// `VIBE_CITY_RATE_ADAPT=0` turns adaptation off (every client gets the
    /// static ceiling, as before).
    pub fn from_env() -> Self {
        let mut config = Self::PRODUCTION;
        if let Ok(value) = std::env::var("VIBE_CITY_RATE_ADAPT") {
            config.enabled = !matches!(value.trim(), "0" | "off" | "false");
        }
        config
    }

    /// The server's configuration, read from the environment once.
    pub fn configured() -> Self {
        static CONFIG: std::sync::OnceLock<RateConfig> = std::sync::OnceLock::new();
        *CONFIG.get_or_init(Self::from_env)
    }
}

/// What one city send may do for one client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendPlan {
    /// The static ceiling, unchanged: the link keeps up.
    Full,
    /// At most this many record bytes.
    Limited { allowance_bytes: usize },
    /// Not this send: the budget carries to the next one.
    Skip,
}

impl SendPlan {
    /// The plan for the pose records once `topology_bytes` of topology
    /// copies have been taken out of it: topology goes first, whatever the
    /// plan (it is what the poses mean), and in the limited state it is paid
    /// for from the same allowance, so a fracture's burst of topology does
    /// not push the connection past its rate.
    pub fn after_topology(self, topology_bytes: usize) -> Self {
        match self {
            SendPlan::Limited { allowance_bytes } => {
                SendPlan::Limited { allowance_bytes: allowance_bytes.saturating_sub(topology_bytes) }
            }
            plan => plan,
        }
    }

    /// The allowance to hand the encoder (`None`: its own ceiling).
    pub fn allowance(self) -> Option<usize> {
        match self {
            SendPlan::Full => None,
            SendPlan::Limited { allowance_bytes } => Some(allowance_bytes),
            SendPlan::Skip => Some(0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RateState {
    Free,
    Limited,
}

/// Counters for reports: how often each plan was chosen.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct RateTotals {
    pub sends_full: u64,
    pub sends_limited: u64,
    pub sends_skipped: u64,
    pub entered_limited: u64,
    pub released: u64,
    pub policer_cuts: u64,
    /// Sum of allowances handed out in the limited state, bytes.
    pub limited_allowance_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct RateController {
    config: RateConfig,
    state: RateState,
    /// Recent samples (for spans), oldest first.
    history: std::collections::VecDeque<LinkSample>,
    /// Capacity samples: (at_us, wire bytes/s).
    capacity_samples: std::collections::VecDeque<(u64, f64)>,
    /// Capacity estimate, wire bytes/s (0: none yet).
    capacity: f64,
    /// Non-city bytes the server queued, bytes/s (EWMA).
    other_rate: f64,
    /// Estimated bytes queued on the reliable stream and not yet sent.
    ///
    /// The QUIC sender writes datagrams before stream data, so a link the
    /// datagrams fill starves the stream without a byte waiting in the
    /// datagram buffer: every send drains within its interval, and the stream
    /// gets only the gaps. Measured in Netlab (1 Mbit/s, no loss): the link
    /// stayed `Free` with 158-628 B buffered while topology waited 0.3-2.2 s
    /// behind the pose stream. quinn does not report a stream's unsent bytes,
    /// so this is what the server queued on the stream less what went on the
    /// wire that was not datagrams (wire bytes, less `packet_overhead_bytes`
    /// per packet, less the datagram bytes that left the buffer), floored at
    /// zero each read. Retransmissions and an underestimated overhead make it
    /// err low; it never throttles a link whose stream keeps moving.
    reliable_backlog: f64,
    /// Reliable bytes queued so far, and (estimated) sent, cumulative; and
    /// when each read's new reliable bytes were queued (cumulative total
    /// after them, read time), for the age of the oldest unsent byte.
    reliable_queued_total: f64,
    reliable_sent_total: f64,
    reliable_marks: std::collections::VecDeque<(f64, u64)>,
    backlog_streak: u32,
    /// Windowed minimum RTT: (at_us, rtt_us), increasing rtt.
    min_rtt: std::collections::VecDeque<(u64, u64)>,
    /// Last send whose limited allowance was below the static ceiling.
    last_below_ceiling_us: u64,
    last_policer_cut_us: u64,
    probe_cycle: Option<u64>,
    probe_gain_now: f64,
    capacity_at_probe: f64,
    /// The longest queue beyond the target seen this probe cycle, ms: a
    /// probe that found more only by queueing it did not find a faster path.
    cycle_max_queue_ms: f64,
    /// Samples over the last loss window, oldest first.
    loss_marks: std::collections::VecDeque<LinkSample>,
    tokens: f64,
    /// City bytes queued since the previous plan (told through `sent`).
    city_bytes_since_plan: u64,
    last: Option<LinkSample>,
    /// The latest city rate in the limited state, bytes/s (reports).
    city_rate: f64,
    totals: RateTotals,
}

impl RateController {
    pub fn new(config: RateConfig) -> Self {
        Self {
            config,
            state: RateState::Free,
            history: Default::default(),
            capacity_samples: Default::default(),
            capacity: 0.0,
            other_rate: 0.0,
            reliable_backlog: 0.0,
            reliable_queued_total: 0.0,
            reliable_sent_total: 0.0,
            reliable_marks: Default::default(),
            backlog_streak: 0,
            min_rtt: Default::default(),
            last_below_ceiling_us: 0,
            last_policer_cut_us: 0,
            probe_cycle: None,
            probe_gain_now: config.probe_gain,
            capacity_at_probe: 0.0,
            cycle_max_queue_ms: 0.0,
            loss_marks: Default::default(),
            tokens: 0.0,
            city_bytes_since_plan: 0,
            last: None,
            city_rate: 0.0,
            totals: RateTotals::default(),
        }
    }

    pub fn state(&self) -> RateState {
        self.state
    }

    /// Capacity estimate, wire bytes/s.
    pub fn capacity_bytes_per_s(&self) -> f64 {
        self.capacity
    }

    /// The city's rate in the limited state, bytes/s.
    #[allow(dead_code)] // reports (Netlab v2)
    pub fn city_rate_bytes_per_s(&self) -> f64 {
        self.city_rate
    }

    /// Non-city bytes the server queues on this connection, bytes/s.
    #[allow(dead_code)] // reports (Netlab v2)
    pub fn other_rate_bytes_per_s(&self) -> f64 {
        self.other_rate
    }

    #[allow(dead_code)] // reports (Netlab v2)
    pub fn totals(&self) -> RateTotals {
        self.totals
    }

    /// Decide this send from the connection's current sample.
    /// `send_interval_s` is the nominal time between city sends.
    pub fn plan(&mut self, sample: LinkSample, send_interval_s: f64, ceiling_bytes: usize) -> SendPlan {
        let config = self.config;
        if !config.enabled {
            self.totals.sends_full += 1;
            return SendPlan::Full;
        }
        let dt_s = self
            .last
            .map_or(send_interval_s, |last| {
                sample.at_us.saturating_sub(last.at_us) as f64 / 1e6
            })
            .clamp(0.0, 0.5);

        // Non-city traffic this connection carries, bytes/s.
        if let Some(last) = self.last {
            if dt_s > 0.0 {
                let submitted = sample.submitted_bytes.saturating_sub(last.submitted_bytes);
                let other = submitted.saturating_sub(self.city_bytes_since_plan) as f64 / dt_s;
                // ~1 s time constant.
                let alpha = (dt_s / 1.0).min(1.0);
                self.other_rate += alpha * (other - self.other_rate);
            }
            if config.reliable_queue_ms > 0.0 {
                let submitted = sample.submitted_bytes.saturating_sub(last.submitted_bytes) as f64;
                let reliable = sample
                    .reliable_submitted_bytes
                    .saturating_sub(last.reliable_submitted_bytes) as f64;
                let datagrams_sent = (submitted - reliable)
                    - (sample.datagram_buffered_bytes as f64 - last.datagram_buffered_bytes as f64);
                let payload = sample.wire_bytes.saturating_sub(last.wire_bytes) as f64
                    - config.packet_overhead_bytes
                        * sample.sent_packets.saturating_sub(last.sent_packets) as f64;
                let stream_sent = (payload - datagrams_sent).max(0.0);
                self.reliable_queued_total += reliable;
                self.reliable_sent_total =
                    (self.reliable_sent_total + stream_sent).min(self.reliable_queued_total);
                self.reliable_backlog = self.reliable_queued_total - self.reliable_sent_total;
                if reliable > 0.0 {
                    // Queued since the last read, stamped with this one: the
                    // age errs short by up to one read interval, never long
                    // (bytes queued the instant before a read, or across a
                    // slow server tick, have not waited for the link).
                    self.reliable_marks.push_back((self.reliable_queued_total, sample.at_us));
                }
                while self
                    .reliable_marks
                    .front()
                    .is_some_and(|(total, _)| *total <= self.reliable_sent_total)
                {
                    self.reliable_marks.pop_front();
                }
            }
        }
        self.city_bytes_since_plan = 0;

        self.note_rtt(sample);
        let queued_in_network = self.rtt_inflation_ms(sample) >= config.rtt_queue_ms;
        let stream_wait_ms = self.reliable_wait_ms(sample.at_us);
        let stream_starved = config.reliable_queue_ms > 0.0 && stream_wait_ms >= config.reliable_queue_ms;
        // A waiting stream does not make a link count as constrained: live
        // on loopback, stream bytes waited 60 ms at joins with nothing in
        // the datagram buffer (the estimate cannot tell a starved stream
        // from one that is flow-controlled, or from bytes still in the
        // server's own queue), and the link went `Limited` for the whole
        // session. Only a link the datagram or network-queue signals have
        // found constrained gives its city share to a waiting stream.
        let backlogged = sample.datagram_buffered_bytes >= config.backlog_bytes || queued_in_network;
        if backlogged {
            self.backlog_streak += 1;
        } else {
            self.backlog_streak = 0;
        }
        self.history.push_back(sample);
        let loss_share = self.loss_share(sample);
        self.update_capacity(sample);
        self.last = Some(sample);

        match self.state {
            RateState::Free => {
                if self.backlog_streak >= config.enter_samples && self.capacity > 0.0 {
                    self.state = RateState::Limited;
                    self.totals.entered_limited += 1;
                    self.last_below_ceiling_us = sample.at_us;
                    self.tokens = 0.0;
                } else {
                    self.totals.sends_full += 1;
                    return SendPlan::Full;
                }
            }
            RateState::Limited => {
                if loss_share.is_some_and(|share| share > config.policer_loss)
                    && self.queue_delay_ms(sample) > self.target_queue_ms(sample)
                    && sample.at_us.saturating_sub(self.last_policer_cut_us) as f64 / 1000.0
                        >= config.loss_window_ms
                {
                    // Losing this much with a queue standing: the path is
                    // dropping what its queue cannot hold (it got slower, or
                    // a probe overran a shallow queue). Cut now rather than
                    // wait for the capacity window. Loss without a queue is
                    // not congestion and is left alone.
                    self.capacity *= 0.85;
                    self.capacity_samples.clear();
                    self.last_policer_cut_us = sample.at_us;
                    self.totals.policer_cuts += 1;
                }
            }
        }

        // The city's share of the path.
        let rtt_s = sample.rtt_us as f64 / 1e6;
        let drain_s = (config.drain_ms / 1000.0).max(2.0 * rtt_s);
        // The standing queue, wherever it is: bytes waiting in the sender, or
        // round-trip time above the path's minimum. Beyond the target it is
        // drained.
        let queue_ms = self.queue_delay_ms(sample);
        let excess = (queue_ms - self.target_queue_ms(sample)).max(0.0) / 1000.0 * self.capacity;
        let gain = self.gain(sample.at_us, sample.rtt_us);
        self.cycle_max_queue_ms = self.cycle_max_queue_ms.max(queue_ms - self.target_queue_ms(sample));
        // Reliable bytes kept waiting behind the datagrams on a limited link:
        // the city gives them the path until they are out, within
        // `reliable_drain_ms`. Only once they have waited
        // `reliable_queue_ms`: the estimate runs a read ahead of the wire
        // (bytes the server queued that the connection has not taken yet).
        let stream_yield = if stream_starved {
            self.reliable_backlog / (config.reliable_drain_ms / 1000.0)
        } else {
            0.0
        };
        let rate = (gain * config.headroom * self.capacity
            - self.other_rate
            - excess / drain_s
            - stream_yield)
            .max(config.min_rate_bytes_per_s);
        self.city_rate = rate;
        let nominal = rate * send_interval_s;
        // Back to the static ceiling only once the path has been measured
        // carrying it (the full-ceiling stream plus everything else, with no
        // standing queue), for a while. A constrained link stays limited
        // through its quiet stretches, so the next burst is paced from its
        // first send instead of queueing for `enter_samples` sends first.
        let ceiling_rate = ceiling_bytes as f64 / send_interval_s.max(1e-3);
        if self.capacity < ceiling_rate + self.other_rate || excess > 0.0 || stream_starved {
            self.last_below_ceiling_us = sample.at_us;
        } else if sample.at_us.saturating_sub(self.last_below_ceiling_us) as f64 / 1000.0
            >= config.release_ms
        {
            self.state = RateState::Free;
            self.backlog_streak = 0;
            self.totals.released += 1;
            self.totals.sends_full += 1;
            return SendPlan::Full;
        }
        let cap = (2.0 * nominal).max(config.min_send_bytes as f64);
        self.tokens = (self.tokens + rate * dt_s).min(cap);
        if self.tokens < config.min_send_bytes as f64 {
            self.totals.sends_skipped += 1;
            return SendPlan::Skip;
        }
        let allowance_bytes = self.tokens.floor() as usize;
        self.totals.sends_limited += 1;
        self.totals.limited_allowance_bytes += allowance_bytes as u64;
        SendPlan::Limited { allowance_bytes }
    }

    /// What the send queued (its city bytes), for the plan it was given.
    pub fn sent(&mut self, city_bytes: usize, plan: SendPlan) {
        self.city_bytes_since_plan += city_bytes as u64;
        if let SendPlan::Limited { .. } = plan {
            self.tokens = (self.tokens - city_bytes as f64).max(0.0);
        }
    }

    /// City bytes queued outside a plan: topology copies on a send with no
    /// records, or one the plan skipped. They are city bytes, and in the
    /// limited state they spend the budget the next records would have.
    pub fn sent_topology(&mut self, bytes: usize) {
        self.city_bytes_since_plan += bytes as u64;
        if self.state == RateState::Limited {
            self.tokens = (self.tokens - bytes as f64).max(0.0);
        }
    }

    fn update_capacity(&mut self, sample: LinkSample) {
        let config = self.config;
        let span_us = (config.sample_span_ms * 1000.0) as u64;
        // Keep just enough history for one span.
        while self.history.len() > 2
            && sample.at_us.saturating_sub(self.history[1].at_us) >= span_us
        {
            self.history.pop_front();
        }
        let window_us = (config.capacity_window_ms * 1000.0) as u64;
        while self
            .capacity_samples
            .front()
            .is_some_and(|(at, _)| sample.at_us.saturating_sub(*at) > window_us)
        {
            self.capacity_samples.pop_front();
        }
        let Some(first) = self.history.front().copied() else {
            return;
        };
        let elapsed_us = sample.at_us.saturating_sub(first.at_us);
        if elapsed_us < span_us / 2 || elapsed_us == 0 {
            return;
        }
        // Delivered: what went on the wire, less the share the path lost,
        // less what the network queue took on meanwhile (its growth in RTT
        // times the rate it drains at) -- bytes sent into a growing queue
        // have not arrived yet. The lost share is taken over the loss window,
        // not this span: losses are declared about an RTT late, so a span's
        // own count belongs to the span before it.
        let wire = sample.wire_bytes.saturating_sub(first.wire_bytes) as f64;
        let sent = wire * (1.0 - self.lost_byte_share(sample));
        let growth_ms = self.rtt_inflation_ms(sample) - self.rtt_inflation_ms(first);
        let delivered = (sent - growth_ms / 1000.0 * self.capacity).max(0.0);
        let rate = delivered / (elapsed_us as f64 / 1e6);
        // Delivery can never exceed the path, so a sample bounds it from
        // below -- when it is a delivery. Bytes sent into a growing network
        // queue have not arrived, and the correction for them leans on a
        // smoothed, one-RTT-late RTT; so does the correction for a draining
        // one. Only spans whose queue held steady measure the path; the
        // others may lower the estimate (a growing queue says the path is
        // slower than what was sent) but never raise it.
        // Busy: datagrams waiting in the sender at every read, or a standing
        // network queue. A smoothed RTT a few tens of ms up is not one: each
        // send is a burst the path drains within the send interval, and the
        // packets at its tail wait behind its head.
        let busy_throughout = self.history.iter().all(|s| {
            s.datagram_buffered_bytes > 0 || self.rtt_inflation_ms(*s) >= config.rtt_queue_ms
        });
        let steady = growth_ms.abs() <= GROWING_QUEUE_MS;
        let accept = if busy_throughout {
            // The sender (or the network queue) was never idle: this is the
            // path, and it may lower the estimate once the older, higher
            // samples leave the window.
            steady || (growth_ms > 0.0 && rate < self.capacity)
        } else {
            // The sender idled at times: only a higher delivery counts (BBR's
            // rule for app-limited samples).
            steady && rate > self.capacity
        };
        if accept {
            self.capacity_samples.push_back((sample.at_us, rate));
        }
        if let Some(max) = self.capacity_samples.iter().map(|(_, r)| *r).reduce(f64::max) {
            // Up at once; down by at most a fifth per span, so one short,
            // noisy span (losses declared late, a lagging RTT) cannot halve
            // the estimate once the older samples have left the window. A
            // standing queue with heavy loss still cuts at once (`plan`).
            self.capacity = if max >= self.capacity {
                max
            } else {
                let step_us = self
                    .history
                    .len()
                    .checked_sub(2)
                    .map_or(span_us, |i| sample.at_us.saturating_sub(self.history[i].at_us));
                max.max(self.capacity * (1.0 - 0.2 * (step_us as f64 / span_us as f64).min(1.0)))
            };
        }
    }

    /// The probing gain for this send. Time runs in cycles of eight phases
    /// (a phase is the larger of the RTT and one sample span): the first
    /// offers `probe_gain` times the estimate, so a faster path shows up as
    /// a higher delivery; the second drains what that queued; the rest offer
    /// the estimate. A probe that found at least 10% more makes the next one
    /// bolder (x1.5, up to `probe_gain_max`); one that found nothing resets
    /// it, so a saturated path is probed gently.
    fn gain(&mut self, at_us: u64, rtt_us: u64) -> f64 {
        let config = self.config;
        let phase_us = rtt_us.max((config.sample_span_ms * 1000.0) as u64).max(1);
        let phase = at_us / phase_us;
        let cycle = phase / 8;
        if self.probe_cycle != Some(cycle) {
            // A new cycle: judge the last probe.
            if self.probe_cycle.is_some()
                && self.capacity > 1.1 * self.capacity_at_probe
                && self.cycle_max_queue_ms <= 0.0
            {
                self.probe_gain_now = (self.probe_gain_now * 1.5).min(config.probe_gain_max);
            } else {
                self.probe_gain_now = config.probe_gain;
            }
            self.probe_cycle = Some(cycle);
            self.capacity_at_probe = self.capacity;
            self.cycle_max_queue_ms = 0.0;
        }
        match phase % 8 {
            0 => self.probe_gain_now,
            1 => 2.0 - config.probe_gain,
            _ => 1.0,
        }
    }

    /// Keep the windowed minimum RTT (a monotonic deque).
    fn note_rtt(&mut self, sample: LinkSample) {
        if sample.rtt_us == 0 {
            return;
        }
        while self.min_rtt.back().is_some_and(|(_, rtt)| *rtt >= sample.rtt_us) {
            self.min_rtt.pop_back();
        }
        self.min_rtt.push_back((sample.at_us, sample.rtt_us));
        let window_us = (self.config.min_rtt_window_ms * 1000.0) as u64;
        while self.min_rtt.len() > 1
            && self.min_rtt.front().is_some_and(|(at, _)| sample.at_us.saturating_sub(*at) > window_us)
        {
            self.min_rtt.pop_front();
        }
    }

    /// The queue allowed to stand, ms. In the network it is seen through a
    /// smoothed RTT that already carries each send's own burst (the tail of
    /// a send waits behind its head), so that part is allowed too.
    fn target_queue_ms(&self, sample: LinkSample) -> f64 {
        if self.rtt_inflation_ms(sample) > 0.0 && sample.datagram_buffered_bytes == 0 {
            self.config.target_queue_ms + self.config.burst_queue_ms
        } else {
            self.config.target_queue_ms
        }
    }

    /// Round-trip time above the path's minimum, ms.
    fn rtt_inflation_ms(&self, sample: LinkSample) -> f64 {
        match self.min_rtt.front() {
            Some((_, min)) => sample.rtt_us.saturating_sub(*min) as f64 / 1000.0,
            None => 0.0,
        }
    }

    /// Queueing delay ahead of a packet sent now: the sender's buffer at
    /// the estimated rate, or the network's (RTT inflation), whichever is
    /// larger.
    fn queue_delay_ms(&self, sample: LinkSample) -> f64 {
        let sender = if self.capacity > 0.0 {
            sample.datagram_buffered_bytes as f64 / self.capacity * 1000.0
        } else {
            0.0
        };
        sender.max(self.rtt_inflation_ms(sample))
    }

    /// How long the oldest reliable byte not yet sent has waited, ms.
    fn reliable_wait_ms(&self, at_us: u64) -> f64 {
        self.reliable_marks
            .front()
            .map_or(0.0, |(_, queued_us)| at_us.saturating_sub(*queued_us) as f64 / 1000.0)
    }

    /// The estimated reliable-stream backlog, bytes (reports).
    #[allow(dead_code)] // reports (Netlab v2)
    pub fn reliable_backlog_bytes(&self) -> f64 {
        self.reliable_backlog
    }

    /// Lost share of the wire bytes over the loss window so far.
    fn lost_byte_share(&self, sample: LinkSample) -> f64 {
        let Some(first) = self.loss_marks.front() else {
            return 0.0;
        };
        let wire = sample.wire_bytes.saturating_sub(first.wire_bytes);
        if wire == 0 {
            return 0.0;
        }
        (sample.lost_bytes.saturating_sub(first.lost_bytes) as f64 / wire as f64).min(1.0)
    }

    /// Lost share of the packets sent over the last loss window (None until
    /// the window holds enough packets to say).
    fn loss_share(&mut self, sample: LinkSample) -> Option<f64> {
        let window_us = (self.config.loss_window_ms * 1000.0) as u64;
        self.loss_marks.push_back(sample);
        while self.loss_marks.len() > 2
            && self.loss_marks.get(1).is_some_and(|mark| sample.at_us.saturating_sub(mark.at_us) >= window_us)
        {
            self.loss_marks.pop_front();
        }
        let first = self.loss_marks.front()?;
        let sent = sample.sent_packets.saturating_sub(first.sent_packets);
        if sent < self.config.policer_min_packets {
            return None;
        }
        Some(sample.lost_packets.saturating_sub(first.lost_packets) as f64 / sent as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEND_HZ: f64 = 30.0;
    const CEILING: usize = 10_400;

    /// A fluid model of one connection: the server's other traffic
    /// (snapshots, ~45 kbit/s) queued alongside the city stream, and the
    /// bottleneck's queue either at the sender (it paces at the path rate,
    /// the lab's ideal BBR) or in the network (the sender does not hold
    /// back, as measured with quinn's BBR: the queue shows up as RTT and
    /// what does not fit is dropped).
    struct Link {
        rate_bytes_per_s: f64,
        loss: f64,
        base_rtt_us: u64,
        /// None: the queue is at the sender. Some(ms): in the network, this deep.
        network_queue_ms: Option<f64>,
        other_bytes_per_send: f64,
        queue: f64,
        wire: f64,
        packets: f64,
        lost: f64,
        lost_bytes: f64,
        submitted: f64,
        at_us: u64,
        /// The reliable stream (sender-queue links): bytes queued per send,
        /// served after the datagrams, as quinn does; its FIFO of (bytes left,
        /// queued at us); what the server queued on it; the longest any
        /// byte waited, us; and the QUIC bytes each packet adds on the wire.
        reliable_per_send: Box<dyn FnMut(u64) -> f64>,
        stream: std::collections::VecDeque<(f64, u64)>,
        reliable_submitted: f64,
        stream_wait_max_us: u64,
        overhead_per_packet: f64,
    }

    impl Link {
        fn new(rate_mbit: f64) -> Self {
            Self {
                rate_bytes_per_s: rate_mbit * 1e6 / 8.0,
                loss: 0.0,
                base_rtt_us: 60_000,
                network_queue_ms: None,
                other_bytes_per_send: 45_000.0 / 8.0 / SEND_HZ,
                queue: 0.0,
                wire: 0.0,
                packets: 0.0,
                lost: 0.0,
                lost_bytes: 0.0,
                submitted: 0.0,
                at_us: 1_000_000,
                reliable_per_send: Box::new(|_| 0.0),
                stream: Default::default(),
                reliable_submitted: 0.0,
                stream_wait_max_us: 0,
                overhead_per_packet: 0.0,
            }
        }

        fn in_network(rate_mbit: f64, queue_ms: f64) -> Self {
            Self { network_queue_ms: Some(queue_ms), ..Self::new(rate_mbit) }
        }

        fn sample(&self) -> LinkSample {
            let (buffered, rtt_us) = match self.network_queue_ms {
                None => (self.queue as u64, self.base_rtt_us),
                Some(_) => (0, self.base_rtt_us + (self.queue_delay_ms() * 1000.0) as u64),
            };
            LinkSample {
                at_us: self.at_us,
                datagram_buffered_bytes: buffered,
                wire_bytes: self.wire as u64,
                sent_packets: self.packets as u64,
                lost_packets: self.lost as u64,
                lost_bytes: self.lost_bytes as u64,
                rtt_us,
                submitted_bytes: self.submitted as u64,
                reliable_submitted_bytes: self.reliable_submitted as u64,
            }
        }

        /// Queue this send's bytes, then let one send interval pass.
        fn step(&mut self, city_bytes: f64) {
            let queued = city_bytes + self.other_bytes_per_send;
            self.submitted += queued;
            let reliable = (self.reliable_per_send)(self.at_us);
            if reliable > 0.0 {
                self.submitted += reliable;
                self.reliable_submitted += reliable;
                self.stream.push_back((reliable, self.at_us));
            }
            let dt = 1.0 / SEND_HZ;
            match self.network_queue_ms {
                None => {
                    // Datagrams first; the stream gets what is left.
                    self.queue += queued;
                    let per_byte = 1.0 + self.overhead_per_packet / 1200.0;
                    let capacity = self.rate_bytes_per_s * dt / per_byte;
                    let drained = self.queue.min(capacity);
                    self.queue -= drained;
                    let mut left = capacity - drained;
                    let mut stream_sent = 0.0;
                    while left > 0.0 {
                        let Some(front) = self.stream.front_mut() else { break };
                        let take = front.0.min(left);
                        front.0 -= take;
                        left -= take;
                        stream_sent += take;
                        if front.0 <= 1e-9 {
                            let (_, queued_at) = self.stream.pop_front().expect("front");
                            let done_us = self.at_us + ((capacity - left) / capacity * dt * 1e6) as u64;
                            self.stream_wait_max_us = self.stream_wait_max_us.max(done_us - queued_at);
                        }
                    }
                    let packets = (drained + stream_sent) / 1200.0;
                    self.wire += drained + stream_sent + packets * self.overhead_per_packet;
                    self.packets += packets;
                    self.lost += packets * self.loss;
                    self.lost_bytes += drained * self.loss;
                }
                Some(limit_ms) => {
                    // Everything goes on the wire; the bottleneck keeps what
                    // fits in its queue and drops the rest.
                    self.wire += queued;
                    self.packets += queued / 1200.0;
                    let room = (limit_ms / 1000.0 * self.rate_bytes_per_s - self.queue).max(0.0);
                    let kept = queued.min(room);
                    let dropped = queued - kept;
                    self.queue += kept;
                    self.queue -= self.queue.min(self.rate_bytes_per_s * dt);
                    let random = kept * self.loss;
                    self.lost += (dropped + random) / 1200.0;
                    self.lost_bytes += dropped + random;
                }
            }
            self.at_us += (dt * 1e6) as u64;
        }

        fn queue_delay_ms(&self) -> f64 {
            self.queue / self.rate_bytes_per_s * 1000.0
        }
    }

    /// One send against `link` with a city demand of `demand` bytes.
    fn send(controller: &mut RateController, link: &mut Link, demand: f64) -> (SendPlan, f64) {
        let plan = controller.plan(link.sample(), 1.0 / SEND_HZ, CEILING);
        let bytes = match plan {
            SendPlan::Full => demand.min(CEILING as f64),
            SendPlan::Limited { allowance_bytes } => demand.min(allowance_bytes as f64),
            SendPlan::Skip => 0.0,
        };
        controller.sent(bytes as usize, plan);
        link.step(bytes);
        (plan, bytes)
    }

    /// The city stream's worst case: every send wants the whole ceiling.
    const SATURATING: f64 = CEILING as f64;

    /// On a limited link the city fills its share of the path, and the QUIC
    /// sender serves datagrams before stream data, so a reliable burst (a
    /// baseline, a fracture's topology) drains through what the datagrams
    /// leave. The controller reads the stream's own backlog and gives it the
    /// path.
    #[test]
    fn a_reliable_stream_on_a_limited_link_is_given_the_path() {
        let run = |config: RateConfig| {
            let mut controller = RateController::new(config);
            let mut link = Link::new(1.0);
            link.overhead_per_packet = 32.0;
            // 6 kB on the stream every 2 s.
            link.reliable_per_send = Box::new(|at_us| if (at_us / 33_333) % 60 == 5 { 6_000.0 } else { 0.0 });
            for n in 0..(30.0 * SEND_HZ) as usize {
                if n == (6.0 * SEND_HZ) as usize {
                    // After the first bursts: the controller has learnt the path.
                    link.stream_wait_max_us = 0;
                }
                send(&mut controller, &mut link, SATURATING);
            }
            assert_eq!(controller.state(), RateState::Limited);
            link.stream_wait_max_us as f64 / 1000.0
        };
        let with = run(RateConfig::PRODUCTION);
        let blind = run(RateConfig { reliable_queue_ms: 0.0, ..RateConfig::PRODUCTION });
        assert!(with < 300.0, "reliable bytes waited {with:.0} ms");
        assert!(blind > 2.0 * with, "without the signal: {blind:.0} ms, with: {with:.0} ms");
    }

    /// A waiting stream alone never makes a link limited: the backlog
    /// estimate cannot tell a stream starved by datagrams from one that is
    /// flow-controlled or still in the server's queue (live, loopback: the
    /// links went limited at joins for the whole session).
    #[test]
    fn a_waiting_stream_alone_does_not_limit_a_link() {
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        let mut link = Link::new(1.0);
        link.overhead_per_packet = 32.0;
        link.reliable_per_send = Box::new(|at_us| if (at_us / 33_333) % 60 == 5 { 6_000.0 } else { 0.0 });
        // Demand just under what the path carries after the snapshots: the
        // datagram buffer never holds a whole send, but the stream waits.
        let demand = 125_000.0 / SEND_HZ - link.other_bytes_per_send - 150.0;
        for n in 0..(20.0 * SEND_HZ) as usize {
            let (plan, _) = send(&mut controller, &mut link, demand);
            assert_eq!(plan, SendPlan::Full, "send {n} throttled");
        }
        assert!(link.stream_wait_max_us > 200_000, "the stream did wait: {} us", link.stream_wait_max_us);
    }

    /// The stream backlog never throttles a link whose stream keeps moving:
    /// bursts of reliable bytes on fast paths, with loss.
    #[test]
    fn reliable_bursts_on_a_fast_link_are_not_throttled() {
        for (rate_mbit, loss) in [(1000.0, 0.0), (50.0, 0.03), (5.0, 0.0)] {
            let mut controller = RateController::new(RateConfig::PRODUCTION);
            let mut link = Link::new(rate_mbit);
            link.loss = loss;
            link.overhead_per_packet = 32.0;
            // A 32 kB baseline every 2 s and fracture topology bursts.
            link.reliable_per_send = Box::new(|at_us| match (at_us / 33_333) % 60 {
                5 => 32_000.0,
                20 | 21 | 22 => 4_000.0,
                _ => 0.0,
            });
            for n in 0..3_000 {
                let demand = if n % 150 < 60 { SATURATING } else { 800.0 };
                let (plan, _) = send(&mut controller, &mut link, demand);
                assert_eq!(plan, SendPlan::Full, "{rate_mbit} Mbit/s, loss {loss}: send {n} throttled");
            }
            assert_eq!(controller.totals().entered_limited, 0);
        }
    }

    #[test]
    fn a_fast_link_is_never_throttled() {
        // Loopback- to cable-class paths, with the heaviest demand the
        // stream can make and with bursty demand, with and without random
        // loss: every send keeps the static ceiling.
        for (rate_mbit, loss) in [(1000.0, 0.0), (50.0, 0.0), (50.0, 0.03), (20.0, 0.20), (5.0, 0.0)] {
            let mut controller = RateController::new(RateConfig::PRODUCTION);
            let mut link = Link::new(rate_mbit);
            link.loss = loss;
            for n in 0..3_000 {
                // Collapse bursts: 2 s of saturating sends every 5 s.
                let demand = if n % 150 < 60 { SATURATING } else { 800.0 };
                let (plan, _) = send(&mut controller, &mut link, demand);
                assert_eq!(plan, SendPlan::Full, "{rate_mbit} Mbit/s, loss {loss}: send {n} throttled");
            }
            assert_eq!(controller.state(), RateState::Free);
            assert_eq!(controller.totals().entered_limited, 0);
        }
    }

    #[test]
    fn disabled_is_always_the_static_ceiling() {
        let mut controller =
            RateController::new(RateConfig { enabled: false, ..RateConfig::PRODUCTION });
        let mut link = Link::new(0.5);
        for _ in 0..600 {
            assert_eq!(send(&mut controller, &mut link, SATURATING).0, SendPlan::Full);
        }
    }

    #[test]
    fn step_response_on_a_half_megabit_link() {
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        let mut link = Link::new(0.5);
        // Quiet start, then the stream saturates.
        for _ in 0..60 {
            send(&mut controller, &mut link, 300.0);
        }
        assert_eq!(controller.state(), RateState::Free, "a quiet stream fits");
        let mut entered_after = None;
        let mut delays = Vec::new();
        let mut city = 0.0;
        for n in 0..300 {
            let (_, bytes) = send(&mut controller, &mut link, SATURATING);
            if entered_after.is_none() && controller.state() == RateState::Limited {
                entered_after = Some(n);
            }
            if n >= 60 {
                delays.push(link.queue_delay_ms());
                city += bytes;
            }
        }
        // Limited after the entry streak: three sends of backlog (~100 ms),
        // plus the send that built the first one.
        let entered = entered_after.expect("the saturated link is limited");
        assert!(entered <= 4, "entered after {entered} sends");
        // Settled (after 2 s): the queue stays short...
        let worst = delays.iter().cloned().fold(0.0, f64::max);
        let mean = delays.iter().sum::<f64>() / delays.len() as f64;
        assert!(worst < 150.0, "queue delay reached {worst:.0} ms");
        assert!(mean < 60.0, "mean queue delay {mean:.0} ms");
        // ...and the city still gets most of the path: 0.9 x 62.5 kB/s less
        // the other 5.6 kB/s is ~50.6 kB/s, minus probing and drain.
        let city_rate = city / (240.0 / SEND_HZ);
        assert!(
            (40_000.0..56_000.0).contains(&city_rate),
            "city rate {city_rate:.0} B/s"
        );
        // Unthrottled, the same demand would have queued 10.4 kB every send
        // against 2 kB of path: seconds of delay within the first second.
    }

    /// The queue in the network (quinn's BBR does not hold back): a
    /// shallow bottleneck queue fills and drops, a deep one fills and
    /// delays. Either way the controller finds the path from RTT and loss,
    /// and the queue it leaves is short.
    #[test]
    fn step_response_with_the_queue_in_the_network() {
        for queue_ms in [200.0, 2_000.0] {
            let mut controller = RateController::new(RateConfig::PRODUCTION);
            let mut link = Link::in_network(1.0, queue_ms);
            for _ in 0..30 {
                send(&mut controller, &mut link, 300.0);
            }
            assert_eq!(controller.state(), RateState::Free, "a quiet stream fits");
            let mut entered_after = None;
            let mut delays = Vec::new();
            let mut lost_from = 0.0;
            for n in 0..450 {
                send(&mut controller, &mut link, SATURATING);
                if entered_after.is_none() && controller.state() == RateState::Limited {
                    entered_after = Some(n);
                }
                if n == 150 {
                    lost_from = link.lost_bytes;
                }
                if n >= 150 {
                    delays.push(link.queue_delay_ms());
                }
            }
            let entered = entered_after.expect("limited");
            assert!(entered <= 8, "{queue_ms} ms queue: entered after {entered} sends");
            let mean = delays.iter().sum::<f64>() / delays.len() as f64;
            let worst = delays.iter().cloned().fold(0.0, f64::max);
            assert!(mean < 60.0, "{queue_ms} ms queue: mean queue delay {mean:.0} ms");
            assert!(worst < 200.0, "{queue_ms} ms queue: worst {worst:.0} ms");
            // Settled: little is dropped (probes may overrun a shallow queue).
            let offered = (link.submitted - 0.0) / (link.at_us as f64 / 1e6);
            let lost_share = (link.lost_bytes - lost_from) / (offered * 10.0);
            assert!(lost_share < 0.05, "{queue_ms} ms queue: {:.1}% lost", 100.0 * lost_share);
            let capacity = controller.capacity_bytes_per_s();
            assert!(
                (capacity / 125_000.0 - 1.0).abs() < 0.25,
                "{queue_ms} ms queue: capacity {capacity:.0} B/s at 1 Mbit/s"
            );
        }
    }

    #[test]
    fn a_capacity_drop_is_followed_and_the_queue_it_leaves_is_drained() {
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        let mut link = Link::new(2.0);
        for _ in 0..300 {
            send(&mut controller, &mut link, SATURATING);
        }
        assert_eq!(controller.state(), RateState::Limited);
        let before = controller.capacity_bytes_per_s();
        assert!((before / 250_000.0 - 1.0).abs() < 0.15, "capacity {before:.0} B/s at 2 Mbit/s");
        // The path falls to a quarter.
        link.rate_bytes_per_s = 0.5e6 / 8.0;
        let mut worst: f64 = 0.0;
        for n in 0..300 {
            send(&mut controller, &mut link, SATURATING);
            worst = worst.max(link.queue_delay_ms());
            if n >= 90 {
                assert!(
                    link.queue_delay_ms() < 150.0,
                    "send {n}: {:.0} ms queued 3 s after the drop",
                    link.queue_delay_ms()
                );
            }
        }
        // The capacity window (1.5 s) holds the old estimate for a while; the
        // drain term bounds what queues meanwhile.
        assert!(worst < 1_500.0, "queue delay peaked at {worst:.0} ms");
        let after = controller.capacity_bytes_per_s();
        assert!((after / 62_500.0 - 1.0).abs() < 0.2, "capacity {after:.0} B/s at 0.5 Mbit/s");
    }

    #[test]
    fn random_loss_is_not_congestion_but_loss_with_a_queue_is() {
        // 3% and 25% random loss on a limited link with no queue: no cuts,
        // and the estimate stays on the path.
        for loss in [0.03, 0.25] {
            let mut controller = RateController::new(RateConfig::PRODUCTION);
            let mut link = Link::new(1.0);
            link.loss = loss;
            for _ in 0..900 {
                send(&mut controller, &mut link, SATURATING);
            }
            assert_eq!(controller.state(), RateState::Limited);
            assert_eq!(controller.totals().policer_cuts, 0, "{loss}: random loss is not a policer");
            // Delivered (goodput) is the capacity the stream can use.
            let expected = 125_000.0 * (1.0 - loss);
            let capacity = controller.capacity_bytes_per_s();
            assert!((capacity / expected - 1.0).abs() < 0.2, "{loss}: capacity {capacity:.0} vs {expected:.0}");
        }
        // The queue in the network, and the path falls to a half or a
        // quarter: the bottleneck's 200 ms queue fills and drops. The RTT
        // and the delivery samples bring the stream down within ~3 s and
        // what is dropped meanwhile is bounded.
        for cut in [0.5, 0.25] {
            let mut controller = RateController::new(RateConfig::PRODUCTION);
            let mut link = Link::in_network(1.0, 200.0);
            for _ in 0..600 {
                send(&mut controller, &mut link, SATURATING);
            }
            assert_eq!(controller.state(), RateState::Limited);
            let cuts_before = controller.totals().policer_cuts;
            let rate = 125_000.0 * cut;
            link.rate_bytes_per_s = rate;
            let dropped_before = link.lost_bytes;
            for n in 0..300 {
                send(&mut controller, &mut link, SATURATING);
                if n >= 90 {
                    assert!(link.queue_delay_ms() < 150.0, "x{cut} send {n}: {:.0} ms", link.queue_delay_ms());
                }
            }
            let _ = cuts_before;
            let capacity = controller.capacity_bytes_per_s();
            assert!((capacity / rate - 1.0).abs() < 0.25, "x{cut}: capacity {capacity:.0} vs {rate:.0}");
            // Dropped after the fall: under 2 s of the new path's rate.
            let dropped = link.lost_bytes - dropped_before;
            assert!(dropped < 2.0 * rate, "x{cut}: {dropped:.0} B dropped");
        }
        // Loss the city cannot pace away (other traffic alone overruns the
        // path, its queue stands full and drops a quarter): the estimate is
        // cut at once, every loss window, rather than held by old samples.
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        let mut link = Link::in_network(1.0, 200.0);
        for _ in 0..300 {
            send(&mut controller, &mut link, SATURATING);
        }
        link.rate_bytes_per_s = 0.3e6 / 8.0;
        link.other_bytes_per_send = 0.4e6 / 8.0 / SEND_HZ;
        for _ in 0..300 {
            send(&mut controller, &mut link, SATURATING);
        }
        assert!(controller.totals().policer_cuts >= 2, "cuts: {}", controller.totals().policer_cuts);
        assert!(controller.city_rate_bytes_per_s() <= RateConfig::PRODUCTION.min_rate_bytes_per_s + 1.0);
    }

    #[test]
    fn a_faster_path_is_found_and_the_link_is_released() {
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        let mut link = Link::new(0.5);
        for _ in 0..300 {
            send(&mut controller, &mut link, SATURATING);
        }
        assert_eq!(controller.state(), RateState::Limited);
        // The path gets much faster (a handover to wifi).
        link.rate_bytes_per_s = 20e6 / 8.0;
        let mut released_after = None;
        for n in 0..1_800 {
            send(&mut controller, &mut link, SATURATING);
            if controller.state() == RateState::Free {
                released_after = Some(n);
                break;
            }
        }
        // Probing finds the path (one 25% step per 8 phases of 200 ms), then
        // the share must cover the ceiling for release_ms.
        let n = released_after.expect("released to the static ceiling");
        assert!(n < 450, "released after {:.1} s", n as f64 / SEND_HZ);
        assert_eq!(controller.totals().released, 1);
    }

    #[test]
    fn a_very_slow_link_merges_sends_instead_of_sending_crumbs() {
        let mut controller = RateController::new(RateConfig::PRODUCTION);
        // 96 kbit/s path with 45 kbit/s of snapshots already on it.
        let mut link = Link::new(0.096);
        let mut skipped = 0;
        let mut sizes = Vec::new();
        for n in 0..900 {
            let (plan, bytes) = send(&mut controller, &mut link, SATURATING);
            if n < 300 {
                continue;
            }
            match plan {
                SendPlan::Skip => skipped += 1,
                SendPlan::Limited { .. } => sizes.push(bytes),
                SendPlan::Full => panic!("send {n} unthrottled on a 96 kbit/s path"),
            }
        }
        assert!(skipped > 0, "the cadence falls");
        assert!(
            sizes.iter().all(|&b| b >= RateConfig::PRODUCTION.min_send_bytes as f64),
            "every send is worth a packet"
        );
        assert!(link.queue_delay_ms() < 300.0, "queue {:.0} ms", link.queue_delay_ms());
    }
}
