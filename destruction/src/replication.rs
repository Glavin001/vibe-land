//! How the server turns destruction truth into what each client receives.
//!
//! Two approaches are supported and compared on one scorecard (Netlab's city
//! lab, `netlab2 city`; docs/netcode-lab.md):
//!
//! - **Shared world** ([`SharedV2`], wire v2): every record is encoded once,
//!   with identical bytes for every client (MoQ-publishable); only selection
//!   and packet composition are per client. This is the production stream.
//! - **Per player** (wire 4, the destruction netcode spec): every byte is
//!   spent on what one player sees, against what that player has
//!   acknowledged.
//!
//! The trait is the seam both the live server and the lab drive, so a lab
//! measurement is of the code that ships. A strategy is fed one simulated
//! tick at a time and asked, at each of its send ticks, for each client's
//! packets under that client's link budget.

use crate::encoder::{ChunkStreamEncoder, ClientSelectionSummary, SharedRecords};
use crate::types::Camera;
use crate::encoder::BodySnapshotInput;
use vibe_netcode::destruction_backend::DestructionTickOutput;

/// The lane a packet is queued on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    /// The ordered reliable stream.
    Reliable,
    /// Unreliable datagrams.
    Datagram,
}

/// One packet for one client, in queue order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub lane: Lane,
    pub bytes: Vec<u8>,
}

impl Outgoing {
    pub fn reliable(bytes: Vec<u8>) -> Self {
        Self { lane: Lane::Reliable, bytes }
    }

    pub fn datagram(bytes: Vec<u8>) -> Self {
        Self { lane: Lane::Datagram, bytes }
    }
}

/// What one send may spend for one client: the link's plan
/// (`server/src/link_rate.rs` `SendPlan`, mirrored here so the strategies do
/// not depend on the server crate), optionally capped further by a
/// [`TokenBucket`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendBudget {
    /// The strategy's own per-send ceiling.
    Full,
    /// At most this many record bytes, in a send standing for `sends` of the
    /// stream's nominal sends.
    Limited { allowance_bytes: usize, sends: u32 },
    /// Not this send.
    Skip,
}

impl SendBudget {
    /// The budget for records once `topology_bytes` of topology went first,
    /// out of the same allowance (`SendPlan::after_topology`).
    pub fn after_topology(self, topology_bytes: usize) -> Self {
        match self {
            SendBudget::Limited { allowance_bytes, sends } => SendBudget::Limited {
                allowance_bytes: allowance_bytes.saturating_sub(topology_bytes),
                sends,
            },
            budget => budget,
        }
    }

    /// The allowance handed to an encoder (`None`: its own ceiling).
    pub fn allowance(self) -> Option<usize> {
        match self {
            SendBudget::Full => None,
            SendBudget::Limited { allowance_bytes, .. } => Some(allowance_bytes),
            SendBudget::Skip => Some(0),
        }
    }

    pub fn ceiling_sends(self) -> u32 {
        match self {
            SendBudget::Limited { sends, .. } => sends.max(1),
            _ => 1,
        }
    }

    /// The tighter of this budget and a byte cap (`None`: no cap).
    pub fn capped(self, cap_bytes: Option<usize>) -> Self {
        let Some(cap) = cap_bytes else {
            return self;
        };
        match self {
            SendBudget::Full => SendBudget::Limited { allowance_bytes: cap, sends: 1 },
            SendBudget::Limited { allowance_bytes, sends } => {
                SendBudget::Limited { allowance_bytes: allowance_bytes.min(cap), sends }
            }
            SendBudget::Skip => SendBudget::Skip,
        }
    }
}

/// Where a client is looking and what it can see, as the server knows it.
#[derive(Clone, Copy, Debug)]
pub struct ClientView {
    pub camera: Camera,
    /// The car this client drives (its body-key structure): its own
    /// prediction draws it, from its every-tick state, so the stream skips it.
    pub own_car: Option<u32>,
}

/// What a client tells the server about its stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientFeedback {
    /// Datagram acknowledgement: `newest` is the highest stream sequence the
    /// client has received; bit `i` of `mask` is set when `newest - 1 - i`
    /// was received too.
    DatagramAcks { newest: u32, mask: u64 },
    /// Application-level event ack: `through` is the first events sequence
    /// the client has not received (every earlier one it has).
    EventsReceived { through: u32 },
}

/// One client's turn in a batched send (`ReplicationStrategy::client_sends`).
#[derive(Clone, Copy, Debug)]
pub struct SendRequest {
    pub client: u64,
    pub view: ClientView,
    pub tick: u32,
    pub budget: Option<SendBudget>,
}

/// One client's packets for one send, plus what the selection decided.
#[derive(Clone, Debug, Default)]
pub struct ClientSend {
    pub packets: Vec<Outgoing>,
    /// Bytes of the packets that carried topology ahead of the records.
    pub topology_bytes: usize,
    /// Record bytes queued (`packets` less the topology).
    pub record_bytes: usize,
    /// The selection's totals (wire v2's send audit), when records ran.
    pub selection: Option<ClientSelectionSummary>,
}

/// A server-side replication strategy (see the module docs).
pub trait ReplicationStrategy {
    /// Short stable name for reports (`shared-v2`, `per-player`).
    fn name(&self) -> &'static str;

    /// The city wire version its packets are (a client picks its decoder by
    /// it): 2 shared world, 4 per player.
    fn wire_version(&self) -> u8 {
        2
    }

    /// Sim ticks per stream send.
    fn send_interval_ticks(&self) -> u32;

    /// The per-send byte ceiling the strategy applies by itself.
    fn ceiling_bytes(&self) -> usize;

    fn add_client(&mut self, client: u64);

    fn remove_client(&mut self, client: u64);

    /// A client joining at `tick`: what it is sent first (reliable), and the
    /// strategy's per-client state set to match.
    fn join(&mut self, client: u64, tick: u32) -> Vec<Outgoing>;

    /// One simulated tick of truth. Returns what every client is sent, in
    /// queue order, before any send of this tick.
    fn ingest_tick(
        &mut self,
        tick: u32,
        active: &[BodySnapshotInput],
        output: &DestructionTickOutput,
    ) -> Vec<Outgoing>;

    /// Work shared by every client of a send tick. Called once per send
    /// tick, before `client_send`.
    fn begin_send(&mut self, tick: u32);

    /// Whether `client` has anything to send this send without records (so
    /// the caller can skip asking its link for a plan).
    fn has_pending(&self, client: u64) -> bool;

    /// Whether this send has records at all (after `begin_send`).
    fn has_records(&self) -> bool;

    /// The link's smoothed round trip to `client`, as the server reads it.
    fn note_link_rtt(&mut self, _client: u64, _rtt_ms: f32) {}

    /// One client's packets this send, under `budget` (`None`: the send has
    /// no records for anyone; only pending topology may go).
    fn client_send(
        &mut self,
        client: u64,
        view: &ClientView,
        tick: u32,
        budget: Option<SendBudget>,
    ) -> ClientSend;

    /// Every listed client's packets this send, in the order listed: the
    /// same as `client_send` for each in turn. A strategy whose clients are
    /// independent may run them at once.
    fn client_sends(&mut self, requests: &[SendRequest]) -> Vec<ClientSend> {
        requests.iter().map(|r| self.client_send(r.client, &r.view, r.tick, r.budget)).collect()
    }

    /// Feedback from `client`, as it arrived at the server.
    fn on_feedback(&mut self, _client: u64, _feedback: ClientFeedback) {}

    /// The strategy's own counters, for reports.
    fn report(&self) -> String {
        String::new()
    }
}

/// The production shared-world stream, wire v2: `ChunkStreamEncoder` driven
/// in the live call order (`server/src/city.rs::feed_encoder`,
/// `MatchState::tick_city` / `city_datagrams_for`).
pub struct SharedV2 {
    encoder: ChunkStreamEncoder,
    shared: Option<SharedRecords>,
    hash_interval_ticks: u32,
}

/// `server/src/city.rs` `TOPO_HASH_INTERVAL_TICKS`.
pub const TOPO_HASH_INTERVAL_TICKS: u32 = 120;

impl SharedV2 {
    pub fn new(encoder: ChunkStreamEncoder) -> Self {
        Self { encoder, shared: None, hash_interval_ticks: TOPO_HASH_INTERVAL_TICKS }
    }

    pub fn encoder(&self) -> &ChunkStreamEncoder {
        &self.encoder
    }

    pub fn encoder_mut(&mut self) -> &mut ChunkStreamEncoder {
        &mut self.encoder
    }
}

impl ReplicationStrategy for SharedV2 {
    fn name(&self) -> &'static str {
        "shared-v2"
    }

    fn send_interval_ticks(&self) -> u32 {
        self.encoder.config().send_interval_ticks.max(1)
    }

    fn ceiling_bytes(&self) -> usize {
        self.encoder.config().client_ceiling_bytes
    }

    fn add_client(&mut self, client: u64) {
        self.encoder.add_client(client);
    }

    fn remove_client(&mut self, client: u64) {
        self.encoder.remove_client(client);
    }

    fn join(&mut self, client: u64, tick: u32) -> Vec<Outgoing> {
        self.encoder.add_client(client);
        let bootstrap = self.encoder.bootstrap_message(tick);
        self.encoder.note_client_bootstrap(client);
        vec![Outgoing::reliable(bootstrap)]
    }

    fn ingest_tick(
        &mut self,
        tick: u32,
        active: &[BodySnapshotInput],
        output: &DestructionTickOutput,
    ) -> Vec<Outgoing> {
        self.encoder.ingest_tick(tick, active, output, &output.wakes);
        let mut reliable = self.encoder.take_topology_messages();
        if let Some(baselines) = self.encoder.maybe_emit_baseline(tick) {
            reliable.extend(baselines);
        }
        if tick % self.hash_interval_ticks == 0 {
            reliable.push(self.encoder.topology_hash_message());
        }
        reliable.into_iter().map(Outgoing::reliable).collect()
    }

    fn begin_send(&mut self, tick: u32) {
        self.shared = Some(self.encoder.encode_send(tick));
    }

    fn has_pending(&self, client: u64) -> bool {
        self.encoder.has_topology_copies(client)
    }

    fn has_records(&self) -> bool {
        self.shared.as_ref().is_some_and(|shared| !shared.records.is_empty())
    }

    fn note_link_rtt(&mut self, client: u64, rtt_ms: f32) {
        self.encoder.note_link_rtt(client, rtt_ms);
    }

    fn client_send(
        &mut self,
        client: u64,
        view: &ClientView,
        tick: u32,
        budget: Option<SendBudget>,
    ) -> ClientSend {
        // As `MatchState::city_datagrams_for`: the topology copies first,
        // then the records under what the copies left of the allowance.
        let mut datagrams = Vec::new();
        let topology_bytes = self.encoder.add_topology_copies(client, tick, &mut datagrams);
        let mut out = ClientSend { topology_bytes, ..Default::default() };
        let records = self.shared.as_ref().filter(|shared| !shared.records.is_empty());
        if let (Some(budget), Some(shared)) = (budget, records) {
            if budget != SendBudget::Skip {
                let before = datagrams.len();
                datagrams.extend(self.encoder.client_datagrams_within(
                    client,
                    view.camera,
                    shared,
                    budget.after_topology(topology_bytes).allowance(),
                    budget.ceiling_sends(),
                ));
                out.record_bytes = datagrams[before..].iter().map(Vec::len).sum();
                out.selection = Some(self.encoder.last_client_selection());
            }
        }
        out.packets = datagrams.into_iter().map(Outgoing::datagram).collect();
        out
    }
}

/// A burstable byte budget: `rate` bytes per second sustained, with up to
/// `capacity` bytes saved for a burst (the destruction netcode spec's
/// 512 kbit/s sustained, 1.5 Mbit/s for up to 3 s). Applied on top of the
/// link's own plan, never instead of it: a client gets the tighter of the
/// two (decision D9, docs/netcode-lab.md).
///
/// Every byte the client is queued is spent from it, reliable ones included
/// (they go first, whatever the budget). A send's records get what is left
/// under both limits: the bucket's level, and the peak rate over the
/// trailing second less what that second already carried -- so no 1 s
/// window exceeds the peak (gate G3) unless reliable traffic alone does.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TokenBucket {
    pub rate_bytes_per_s: f64,
    pub capacity_bytes: f64,
    /// The most any trailing second may carry.
    pub peak_bytes_per_s: f64,
    level: f64,
    last_s: Option<f64>,
    /// Bytes spent in the trailing second: (time, bytes).
    recent: std::collections::VecDeque<(f64, usize)>,
    recent_bytes: usize,
}

impl TokenBucket {
    /// `sustained_kbit_s` with a bucket that funds `burst_kbit_s` for
    /// `burst_s` seconds; starts full.
    pub fn new(sustained_kbit_s: f64, burst_kbit_s: f64, burst_s: f64) -> Self {
        let rate = sustained_kbit_s * 1000.0 / 8.0;
        let peak = burst_kbit_s.max(sustained_kbit_s) * 1000.0 / 8.0;
        let capacity = ((peak - rate) * burst_s).max(0.0);
        Self {
            rate_bytes_per_s: rate,
            capacity_bytes: capacity,
            peak_bytes_per_s: peak,
            level: capacity,
            last_s: None,
            recent: Default::default(),
            recent_bytes: 0,
        }
    }

    fn refill(&mut self, now_s: f64) {
        match self.last_s {
            Some(last) => {
                let elapsed = (now_s - last).max(0.0);
                self.level = (self.level + elapsed * self.rate_bytes_per_s).min(self.capacity_bytes + self.rate_bytes_per_s);
            }
            None => self.level = self.level.max(0.0),
        }
        self.last_s = Some(now_s);
        // Conservative at the edge: a send a hair under a second old by
        // float rounding is still in the window (a trailing-second measure
        // of the same sends must never see more than the peak).
        while self.recent.front().is_some_and(|(t, _)| *t < now_s - 1.0 - 1e-6) {
            let (_, bytes) = self.recent.pop_front().unwrap();
            self.recent_bytes -= bytes;
        }
    }

    /// Bytes a send at `now_s` may use, sends `interval_s` apart: the level
    /// plus this interval's refill, at most what the trailing second leaves
    /// of the peak.
    pub fn allowance(&mut self, now_s: f64, interval_s: f64) -> usize {
        self.refill(now_s);
        // The first send of a fresh bucket also gets its own interval's refill.
        let first = if self.recent.is_empty() && self.level >= self.capacity_bytes { self.rate_bytes_per_s * interval_s } else { 0.0 };
        let window = self.peak_bytes_per_s - self.recent_bytes as f64;
        (self.level + first).min(window).max(0.0) as usize
    }

    /// `bytes` were queued at `now_s`.
    pub fn spend(&mut self, now_s: f64, bytes: usize) {
        self.refill(now_s);
        self.level -= bytes as f64;
        self.recent.push_back((now_s, bytes));
        self.recent_bytes += bytes;
    }

    pub fn level_bytes(&self) -> f64 {
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoder::tests::{close_camera, manifest, promotion_output, snapshot};
    use crate::encoder::EncoderConfig;

    /// The trait adds no behaviour: SharedV2 through it queues exactly what
    /// the live call order (`feed_encoder`, `tick_city`,
    /// `city_datagrams_for`) gets from the encoder directly, budgets and
    /// topology copies included.
    #[test]
    fn shared_v2_through_the_trait_is_the_live_call_order() {
        let manifest = manifest();
        let mut direct = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        let mut strategy = SharedV2::new(ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60)));
        let mut via: Vec<Vec<u8>> = Vec::new();
        let mut live: Vec<Vec<u8>> = Vec::new();
        for client in [1u64, 2] {
            direct.add_client(client);
            live.push(direct.bootstrap_message(9));
            direct.note_client_bootstrap(client);
            via.extend(strategy.join(client, 9).into_iter().map(|p| p.bytes));
        }
        let budgets = [SendBudget::Full, SendBudget::Limited { allowance_bytes: 40, sends: 1 }, SendBudget::Skip];
        for tick in 10..200u32 {
            let output = if tick == 10 { promotion_output() } else { DestructionTickOutput::default() };
            let input = [snapshot(tick as f32 * 0.05)];
            direct.ingest_tick(tick, &input, &output, &output.wakes);
            live.extend(direct.take_topology_messages());
            if let Some(baselines) = direct.maybe_emit_baseline(tick) {
                live.extend(baselines);
            }
            if tick % TOPO_HASH_INTERVAL_TICKS == 0 {
                live.push(direct.topology_hash_message());
            }
            via.extend(strategy.ingest_tick(tick, &input, &output).into_iter().map(|p| p.bytes));
            if tick % strategy.send_interval_ticks() != 0 {
                continue;
            }
            let shared = direct.encode_send(tick);
            strategy.begin_send(tick);
            assert_eq!(!shared.records.is_empty(), strategy.has_records());
            for client in [1u64, 2] {
                let budget = budgets[(tick as usize + client as usize) % budgets.len()];
                let records = (!shared.records.is_empty()).then_some(&shared);
                if records.is_none() && !direct.has_topology_copies(client) {
                    assert!(!strategy.has_pending(client));
                    continue;
                }
                let mut packets = Vec::new();
                let copies = direct.add_topology_copies(client, tick, &mut packets);
                if let Some(shared) = records {
                    if budget != SendBudget::Skip {
                        packets.extend(direct.client_datagrams_within(
                            client,
                            close_camera(),
                            shared,
                            budget.after_topology(copies).allowance(),
                            budget.ceiling_sends(),
                        ));
                    }
                }
                live.extend(packets);
                let send = strategy.client_send(
                    client,
                    &ClientView { camera: close_camera(), own_car: None },
                    tick,
                    records.map(|_| budget),
                );
                assert_eq!(send.topology_bytes, copies);
                via.extend(send.packets.into_iter().map(|p| p.bytes));
            }
        }
        assert!(live.len() > 20, "the fixture must exercise the stream ({} packets)", live.len());
        assert_eq!(via, live);
    }

    #[test]
    fn a_budget_capped_takes_the_tighter_of_the_two() {
        assert_eq!(SendBudget::Full.capped(Some(800)), SendBudget::Limited { allowance_bytes: 800, sends: 1 });
        assert_eq!(
            SendBudget::Limited { allowance_bytes: 500, sends: 2 }.capped(Some(800)),
            SendBudget::Limited { allowance_bytes: 500, sends: 2 }
        );
        assert_eq!(SendBudget::Skip.capped(Some(800)), SendBudget::Skip);
        assert_eq!(SendBudget::Full.capped(None), SendBudget::Full);
    }

    #[test]
    fn the_bucket_holds_the_sustained_rate_and_funds_a_bounded_burst() {
        // 512 kbit/s sustained, 1.5 Mbit/s for 3 s, sends at 60 Hz, a client
        // that would take everything it is allowed.
        let mut bucket = TokenBucket::new(512.0, 1536.0, 3.0);
        let dt = 1.0 / 60.0;
        let mut sends: Vec<(f64, usize)> = Vec::new();
        for i in 0..(60 * 10) {
            let now = i as f64 * dt;
            let allow = bucket.allowance(now, dt);
            bucket.spend(now, allow);
            sends.push((now, allow));
        }
        let kbit = |from: f64, to: f64| {
            sends.iter().filter(|(t, _)| *t >= from && *t < to).map(|(_, b)| *b as f64).sum::<f64>() * 8.0 / 1000.0
        };
        // The burst: the first seconds run at the peak...
        assert!(kbit(0.0, 1.0) > 1536.0 * 0.97, "first second {}", kbit(0.0, 1.0));
        // ...no trailing second ever exceeds it...
        for i in 0..sends.len() {
            let t = sends[i].0;
            assert!(kbit(t, t + 1.0) <= 1536.0 * 1.001, "window at {t}: {}", kbit(t, t + 1.0));
        }
        // ...and once the bucket is drained the sustained rate holds.
        let late = kbit(8.0, 10.0) / 2.0;
        assert!((500.0..=525.0).contains(&late), "drained rate {late} kbit/s");
        // 10 s: about 3 s at the peak, then the sustained rate.
        let mean = kbit(0.0, 10.0) / 10.0;
        assert!((780.0..=860.0).contains(&mean), "mean {mean} kbit/s");
    }

    #[test]
    fn reliable_bytes_count_against_the_trailing_second() {
        let mut bucket = TokenBucket::new(512.0, 1536.0, 3.0);
        let dt = 1.0 / 60.0;
        // 20 kB of reliable topology lands first; the records that follow get
        // only what the second has left.
        bucket.spend(0.0, 20_000);
        let mut total = 20_000usize;
        for i in 0..60 {
            let now = i as f64 * dt;
            let allow = bucket.allowance(now, dt);
            bucket.spend(now, allow);
            total += allow;
        }
        assert!(total as f64 * 8.0 / 1000.0 <= 1536.0 * 1.001, "{} kbit in the first second", total as f64 * 8.0 / 1000.0);
    }
}
