//! `netlab2 city`: the destruction stream on its own, for N players at once,
//! through any replication strategy, scored on one card.
//!
//!   netlab2 city --capture <city capture dir> | --bundle <session bundle>
//!                --out <dir> [--strategy shared-v2] [--clients N]
//!                [--camera <spec>]... [--link <profile>] [--seed N]
//!                [--budget-kbps K [--burst-kbps B --burst-s S]]
//!                [--rate-adapt 0|1] [--jobs J] [--client-root C] [--no-client]
//!
//! This is the lab the two replication approaches are compared in
//! (docs/netcode-lab.md). What it holds fixed, so a difference in the card
//! is the strategy's:
//!
//! - **Truth**: one city capture (the encoder tape: every awake island's pose
//!   every tick, every fracture, settle and wake), recorded once.
//! - **Players**: N clients, each with a camera (a recorded player's track or
//!   a generated script, `CameraSpec`) and its own link.
//! - **Links**: netlab2's QUIC model per client (`link::LinkSim`), seeded per
//!   client. Downlink as production's sender queues it; an uplink for the
//!   client's feedback (datagram acks), on the same profile, so a strategy
//!   that listens to acks learns them when a real server would.
//! - **Budget**: production's per-link rate controller (`link_rate.rs`), and
//!   optionally the spec's burstable token bucket on top (decision D9: the
//!   tighter of the two).
//! - **Client**: the production client, headless (`clientStage.mts`), on a
//!   tape of exactly what arrived; it writes every chunk as the city layer
//!   draws it.
//! - **Score**: every chunk drawn vs truth (`chunks.rs`), per client and
//!   overall, plus bytes and the integrity gates.
//!
//! Every client joins cold at the capture's first tick with the strategy's
//! join message; the clock is ideal (ticks exactly 1/hz apart), so the
//! comparison is of netcode, not of server stalls.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};

use serde::Serialize;

use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::cameras::{build_client_set, CameraSpec, ClientSpec, PlayerTracks};
use vibe_land_destruction::netlab::capture::{self as city_capture, CaptureDir, CaptureMeta};
use vibe_land_destruction::netlab::tape::TapeReader;
use vibe_land_destruction::replication::{
    self, ClientFeedback, ClientView, ReplicationStrategy, SendBudget, SendRequest, SharedV2, TokenBucket,
};

use crate::link::{LinkSim, Profile};
use crate::link_rate::{LinkSample, RateConfig, RateController, SendPlan};
use crate::report::Pct;
use crate::stream::Lane;
use crate::vltape::{ClientTape, TapePacket, CHANNEL_WT_DATAGRAM, CHANNEL_WT_RELIABLE};
use crate::{die, Args};

/// Where the lab's tape clock starts: tick `first` is queued at this time.
pub const ORIGIN_MS: f64 = 1000.0;
/// How often a client acknowledges datagrams (its input cadence), ms.
const ACK_INTERVAL_MS: f64 = 1000.0 / 30.0;
/// Datagram ordinals one ack covers: the newest and the 64 before it.
const ACK_WINDOW: usize = 65;
/// Bytes of one ack datagram on the wire (kind, newest, mask, header).
const ACK_BYTES: usize = 16;
/// G3 is judged on the steady state: windows from this long after the join
/// (the bootstrap is one reliable burst, reported on its own).
const JOIN_SETTLE_MS: f64 = 2000.0;
/// The packet kind the uplink model tags acks with (never on a tape).
const KIND_ACK: u8 = 0xA0;

// ── inputs ──────────────────────────────────────────────────────────────────

/// One city capture: the truth every strategy is fed.
pub struct CityCapture {
    pub dir: PathBuf,
    pub meta: CaptureMeta,
    pub manifest: DestructionManifest,
    pub checkpoint: Option<vibe_land_destruction::encoder::EncoderCheckpoint>,
    pub tracks: PlayerTracks,
}

impl CityCapture {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        let capture = CaptureDir::open(dir)?;
        let manifest: DestructionManifest = serde_json::from_slice(&std::fs::read(capture.manifest_path())?)?;
        let checkpoint = city_capture::read_checkpoint(dir)?;
        let tracks = PlayerTracks::from_samples(&capture.cameras()?);
        Ok(Self { dir: dir.to_path_buf(), meta: capture.meta.clone(), manifest, checkpoint, tracks })
    }

    pub fn tape_path(&self) -> PathBuf {
        self.dir.join(city_capture::TAPE_FILE)
    }
}

/// Everything that defines a city run, echoed into its card.
#[derive(Clone, Debug, Serialize)]
pub struct CitySpec {
    pub capture: String,
    pub strategy: String,
    pub link: String,
    pub profile: Profile,
    pub seed: u64,
    pub rate_adapt: bool,
    /// Sustained / burst kbit/s and burst seconds of the token bucket.
    pub bucket: Option<(f64, f64, f64)>,
    pub clients: Vec<ClientSpec>,
    pub knobs: BTreeMap<String, String>,
}

/// A strategy by name, resumed from the capture's state.
pub fn build_strategy(name: &str, capture: &CityCapture, knobs: &BTreeMap<String, String>) -> Box<dyn ReplicationStrategy> {
    match name {
        "shared-v2" => {
            let mut encoder = match capture.checkpoint.clone() {
                Some(mut checkpoint) => {
                    apply_encoder_knobs(&mut checkpoint.config, knobs);
                    ChunkStreamEncoder::from_checkpoint(&capture.manifest, checkpoint)
                        .unwrap_or_else(|e| die(&format!("encoder checkpoint: {e}")))
                }
                None => {
                    let mut config = EncoderConfig::validated(capture.meta.hz);
                    apply_encoder_knobs(&mut config, knobs);
                    ChunkStreamEncoder::new(&capture.manifest, config)
                }
            };
            // The capture's live players are not the lab's: every lab client
            // joins cold.
            for client in encoder.clients() {
                encoder.remove_client(client);
            }
            Box::new(SharedV2::new(encoder))
        }
        "per-player" => {
            let ledger = capture
                .checkpoint
                .as_ref()
                .map(|c| c.ledger().clone())
                .unwrap_or_else(|| vibe_land_destruction::topology::CityLedger::from_manifest(&capture.manifest));
            let strategy = vibe_land_destruction::per_player::PerPlayer::new(&capture.manifest, ledger, per_player_config(capture, knobs));
            Box::new(match knobs.get("model") {
                Some(_) => strategy.with_model(perceptual_model(knobs)),
                None => strategy,
            })
        }
        other => die(&format!("unknown --strategy {other}: shared-v2 | per-player")),
    }
}

/// The per-player stream's configuration, with `pp.*` knobs.
pub fn per_player_config(capture: &CityCapture, knobs: &BTreeMap<String, String>) -> vibe_land_destruction::per_player::PerPlayerConfig {
    let mut config = vibe_land_destruction::per_player::PerPlayerConfig::validated(capture.meta.hz.max(1));
    for (key, value) in knobs {
        let f = || value.parse::<f64>().unwrap_or_else(|_| die(&format!("knob {key}={value}: number")));
        match key.as_str() {
            "pp.tolerance_px" => config.tolerance_px = f() as f32,
            "pp.horizon_ticks" => config.horizon_ticks = f() as f32,
            "pp.delay_ticks" => config.delay_ticks = f() as f32,
            "pp.ceiling_bytes" => config.ceiling_bytes = f() as usize,
            "pp.send_hz" => config.send_interval_ticks = (config.sim_hz as f64 / f()).round().max(1.0) as u32,
            "pp.heartbeat_sends" => config.heartbeat_sends = f() as u32,
            "pp.backtest" => config.backtest_modes = f() != 0.0,
            "pp.event_copies" => config.event_copies = f() as u32,
            "pp.send_threads" => config.send_threads = f() as u32,
            _ => {}
        }
    }
    config
}

/// The encoder knobs `netlab2 run` understands, by the same names.
fn apply_encoder_knobs(config: &mut EncoderConfig, knobs: &BTreeMap<String, String>) {
    let knobs: BTreeMap<String, String> = knobs.iter().filter(|(k, _)| !k.starts_with("pp.") && *k != "model").map(|(k, v)| (k.clone(), v.clone())).collect();
    let stream = crate::stream_config(crate::stream::Pace::Ideal, &knobs);
    stream.city.apply(config);
}

// ── one client's link ───────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Queued {
    depart_ms: f64,
    lane: Lane,
    kind: u8,
    bytes: Vec<u8>,
}

/// Per-client stream totals for the card.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ClientStream {
    pub packets: u64,
    pub bytes: u64,
    pub reliable_bytes: u64,
    pub datagram_bytes: u64,
    pub delivered: u64,
    pub delivered_bytes: u64,
    pub by_fate: BTreeMap<String, u64>,
    pub by_kind_bytes: BTreeMap<String, u64>,
    /// Bytes queued per second of stream, kbit/s.
    pub kbit_s_mean: f64,
    /// The busiest trailing 1 s window of queued bytes, kbit/s (gate G3).
    pub kbit_s_max_1s: f64,
    /// The busiest 100 ms window, as kbit/s.
    pub kbit_s_max_100ms: f64,
    /// The busiest trailing 1 s window after the join (G3's steady state).
    pub kbit_s_max_1s_steady: f64,
    /// Bytes queued at the join (the bootstrap), on their own.
    pub join_bytes: u64,
    pub datagram_latency_ms: Pct,
    pub reliable_latency_ms: Pct,
    pub reliable_hol_ms: Pct,
    pub sends: u64,
    pub sends_skipped: u64,
    pub sends_limited: u64,
    pub record_bytes: u64,
    pub topology_copy_bytes: u64,
    pub acks_sent: u64,
    pub acks_delivered: u64,
    /// The rate controller's state changes into Limited.
    pub entered_limited: u64,
}

struct LabClient {
    spec: ClientSpec,
    down: LinkSim,
    up: LinkSim,
    controller: Option<RateController>,
    origin_ms: Option<f64>,
    bucket: Option<TokenBucket>,
    queued: Vec<Queued>,
    /// Per datagram ordinal (the n-th datagram this client was queued since
    /// it joined): its index on the downlink.
    datagram_index: Vec<usize>,
    next_ack_ms: f64,
    /// Feedback on its way up: (arrival at the server, feedback).
    inflight: VecDeque<(f64, ClientFeedback)>,
    stats: ClientStream,
}

impl LabClient {
    fn new(spec: ClientSpec, profile: &Profile, seed: u64, rate_adapt: bool, bucket: Option<TokenBucket>) -> Self {
        Self {
            spec,
            down: LinkSim::new(profile, seed.wrapping_mul(2).wrapping_add(1)),
            up: LinkSim::new(profile, seed.wrapping_mul(2).wrapping_add(2)),
            controller: rate_adapt.then(|| RateController::new(RateConfig::PRODUCTION)),
            origin_ms: None,
            bucket,
            queued: Vec::new(),
            datagram_index: Vec::new(),
            next_ack_ms: ORIGIN_MS,
            inflight: VecDeque::new(),
            stats: ClientStream::default(),
        }
    }

    fn queue(&mut self, at_ms: f64, lane: replication::Lane, bytes: Vec<u8>) {
        let lane = match lane {
            replication::Lane::Reliable => Lane::Reliable,
            replication::Lane::Datagram => Lane::Datagram,
        };
        let kind = bytes.first().copied().unwrap_or(0);
        let index = self.down.admit(at_ms, lane, kind, bytes.len());
        // Ack ordinals number the datagrams that carry one: every datagram
        // but a per-player events copy (that carries an event sequence).
        if lane == Lane::Datagram && kind != vibe_land_perplayer::wire::PKT_PP_EVENTS {
            self.datagram_index.push(index);
        }
        if let Some(bucket) = self.bucket.as_mut() {
            bucket.spend(at_ms / 1000.0, bytes.len());
        }
        self.queued.push(Queued { depart_ms: at_ms, lane, kind, bytes });
    }

    /// The link's plan for this send (`MatchState::city_datagrams_for`).
    fn plan(&mut self, at_ms: f64, send_interval_s: f64, ceiling: usize) -> (SendPlan, f64) {
        let signals = self.down.signals(at_ms);
        let Some(controller) = self.controller.as_mut() else {
            return (SendPlan::Full, signals.rtt_ms);
        };
        let origin = *self.origin_ms.get_or_insert(at_ms - 1000.0);
        let sample = LinkSample {
            at_us: ((at_ms - origin) * 1000.0).max(0.0) as u64,
            datagram_buffered_bytes: signals.datagram_buffered_bytes,
            wire_bytes: signals.wire_bytes,
            sent_packets: signals.sent_packets,
            lost_packets: signals.lost_packets,
            lost_bytes: signals.lost_bytes,
            rtt_us: (signals.rtt_ms * 1000.0) as u64,
            submitted_bytes: signals.submitted_bytes,
            reliable_submitted_bytes: signals.reliable_submitted_bytes,
        };
        let before = controller.state();
        let plan = controller.plan(sample, send_interval_s, ceiling);
        if before != controller.state() && controller.state() == crate::link_rate::RateState::Limited {
            self.stats.entered_limited += 1;
        }
        (plan, signals.rtt_ms)
    }

    /// Acks the client sends at instants before `until_ms`, up the uplink.
    fn send_acks(&mut self, until_ms: f64) {
        while self.next_ack_ms < until_ms {
            let at = self.next_ack_ms;
            self.next_ack_ms += ACK_INTERVAL_MS;
            self.down.poll(at);
            let n = self.datagram_index.len();
            let from = n.saturating_sub(4 * ACK_WINDOW);
            let mut newest: Option<usize> = None;
            let mut received = Vec::new();
            for ordinal in from..n {
                if self.down.datagram_arrival(self.datagram_index[ordinal]).is_some_and(|t| t <= at) {
                    newest = Some(ordinal);
                    received.push(ordinal);
                }
            }
            let Some(newest) = newest else { continue };
            let mut mask = 0u64;
            for ordinal in received {
                if ordinal < newest && newest - 1 - ordinal < 64 {
                    mask |= 1 << (newest - 1 - ordinal);
                }
            }
            let index = self.up.admit(at, Lane::Datagram, KIND_ACK, ACK_BYTES);
            self.up.poll(at + 1e-3);
            self.stats.acks_sent += 1;
            if let Some(arrive) = self.up.datagram_arrival(index) {
                self.stats.acks_delivered += 1;
                self.inflight.push_back((arrive, ClientFeedback::DatagramAcks { newest: newest as u32, mask }));
            }
        }
    }
}

// ── the run ─────────────────────────────────────────────────────────────────

pub struct CityRun {
    pub spec: CitySpec,
    pub first_tick: u32,
    pub last_tick: u32,
    pub hz: u32,
    pub clients: Vec<(ClientSpec, ClientStream)>,
    pub server_cost: ServerCost,
}

fn tick_ms(tick: u32, first: u32, hz: u32) -> f64 {
    ORIGIN_MS + (f64::from(tick) - f64::from(first)) * 1000.0 / f64::from(hz)
}

/// The server stage and links: writes each client's tape and timeline.
pub fn run_city_stream(capture: &CityCapture, spec: &CitySpec, out: &Path) -> std::io::Result<CityRun> {
    std::fs::create_dir_all(out)?;
    let mut strategy = build_strategy(&spec.strategy, capture, &spec.knobs);
    let hz = capture.meta.hz.max(1);
    let interval = strategy.send_interval_ticks().max(1);
    let send_interval_s = f64::from(interval) / f64::from(hz);
    let ceiling = strategy.ceiling_bytes();
    let mut clients: BTreeMap<u64, LabClient> = BTreeMap::new();
    for (index, client) in spec.clients.iter().enumerate() {
        let bucket = spec.bucket.map(|(sustained, burst, seconds)| TokenBucket::new(sustained, burst, seconds));
        clients.insert(
            client.id,
            LabClient::new(client.clone(), &spec.profile, spec.seed.wrapping_mul(1000).wrapping_add(index as u64), spec.rate_adapt, bucket),
        );
    }

    let mut reader = TapeReader::open(&capture.tape_path())?;
    let (mut ingest_ms, mut send_ms, mut send_wall_ms) = (Vec::new(), Vec::new(), Vec::new());
    let (mut client_us_total, mut client_sends) = (0.0f64, 0u64);
    let mut first_tick = None;
    let mut last_tick = 0;
    while let Some(entry) = reader.next_tick()? {
        let tick = entry.tick;
        let first = *first_tick.get_or_insert(tick);
        last_tick = tick;
        let t = tick_ms(tick, first, hz);
        // Feedback that reached the server by now.
        for (id, client) in clients.iter_mut() {
            while client.inflight.front().is_some_and(|(arrive, _)| *arrive <= t) {
                let (_, feedback) = client.inflight.pop_front().unwrap();
                strategy.on_feedback(*id, feedback);
            }
        }
        if tick == first {
            for (id, client) in clients.iter_mut() {
                for packet in strategy.join(*id, tick) {
                    client.queue(t, packet.lane, packet.bytes);
                }
            }
        }
        let started = thread_cpu();
        let broadcast = strategy.ingest_tick(tick, &entry.snapshots, &entry.output);
        ingest_ms.push((thread_cpu() - started).as_secs_f32() * 1000.0);
        for client in clients.values_mut() {
            for packet in &broadcast {
                client.queue(t, packet.lane, packet.bytes.clone());
            }
        }
        if tick % interval == 0 {
            let mut send_cpu = std::time::Duration::ZERO;
            let shared_started = thread_cpu();
            strategy.begin_send(tick);
            send_cpu += thread_cpu() - shared_started;
            let has_records = strategy.has_records();
            // Every client's plan first (each link is its own), then one
            // batched send (a strategy may run its clients at once), then
            // each result back onto its link.
            let mut requests: Vec<SendRequest> = Vec::new();
            let mut plans: Vec<Option<SendPlan>> = Vec::new();
            for (id, client) in clients.iter_mut() {
                let seconds = (tick - first) as f32 / hz as f32;
                let Some(camera) = client.spec.camera.camera_in_run(tick, seconds, &capture.tracks) else {
                    continue;
                };
                if !has_records && !strategy.has_pending(*id) {
                    continue;
                }
                let mut plan = None;
                let budget = if has_records {
                    let (link_plan, rtt) = client.plan(t, send_interval_s, ceiling);
                    strategy.note_link_rtt(*id, rtt as f32);
                    plan = Some(link_plan);
                    let budget = match link_plan {
                        SendPlan::Full => SendBudget::Full,
                        SendPlan::Limited { allowance_bytes, sends } => SendBudget::Limited { allowance_bytes, sends },
                        SendPlan::Skip => SendBudget::Skip,
                    };
                    let cap = client.bucket.as_mut().map(|bucket| bucket.allowance(t / 1000.0, send_interval_s));
                    Some(budget.capped(cap))
                } else {
                    None
                };
                requests.push(SendRequest { client: *id, view: ClientView { camera }, tick, budget });
                plans.push(plan);
            }
            let batch_cpu = thread_cpu();
            let batch_wall = std::time::Instant::now();
            let sends = strategy.client_sends(&requests);
            let spent = thread_cpu() - batch_cpu;
            send_wall_ms.push(batch_wall.elapsed().as_secs_f32() * 1000.0);
            send_cpu += spent;
            if !requests.is_empty() {
                client_us_total += spent.as_secs_f64() * 1e6;
                client_sends += requests.len() as u64;
            }
            for ((request, plan), send) in requests.iter().zip(plans).zip(sends) {
                let client = clients.get_mut(&request.client).expect("requested client");
                let budget = request.budget;
                client.stats.sends += 1;
                match budget {
                    Some(SendBudget::Skip) => client.stats.sends_skipped += 1,
                    Some(SendBudget::Limited { .. }) => client.stats.sends_limited += 1,
                    _ => {}
                }
                client.stats.record_bytes += send.record_bytes as u64;
                client.stats.topology_copy_bytes += send.topology_bytes as u64;
                let bytes: usize = send.packets.iter().map(|p| p.bytes.len()).sum();
                if let Some(controller) = client.controller.as_mut() {
                    match (plan, budget) {
                        (Some(plan), Some(budget)) if budget != SendBudget::Skip => controller.sent(bytes, plan),
                        _ => controller.sent_topology(send.topology_bytes),
                    }
                }
                for packet in send.packets {
                    client.queue(t, packet.lane, packet.bytes);
                }
            }
            send_ms.push(send_cpu.as_secs_f32() * 1000.0);
        }
        let next = tick_ms(tick + 1, first, hz);
        for client in clients.values_mut() {
            client.send_acks(next);
        }
    }
    let first_tick = first_tick.ok_or_else(|| std::io::Error::other("the capture's tape has no ticks"))?;
    std::fs::write(out.join("strategy.txt"), strategy.report())?;
    let server_cost = ServerCost {
        sends: send_ms.len() as u64,
        ticks: ingest_ms.len() as u64,
        ingest_ms: Pct::of(ingest_ms),
        send_ms: Pct::of(send_ms),
        send_wall_ms: Pct::of(send_wall_ms),
        per_client_us: if client_sends > 0 { client_us_total / client_sends as f64 } else { 0.0 },
    };
    std::fs::write(out.join("server-cost.json"), serde_json::to_vec_pretty(&server_cost)?)?;

    // Each client's deliveries, tape and totals.
    let mut results = Vec::new();
    for (index, (_, client)) in clients.into_iter().enumerate() {
        let dir = client_dir(out, index);
        std::fs::create_dir_all(&dir)?;
        let LabClient { spec: client_spec, down, queued, mut stats, .. } = client;
        let (deliveries, _link_stats) = down.finish();
        let mut tape: Vec<(f64, usize, TapePacket)> = Vec::new();
        let (mut dgram_lat, mut rel_lat, mut rel_hol) = (Vec::new(), Vec::new(), Vec::new());
        let mut windows: Vec<(f64, usize)> = Vec::new();
        for (seq, (packet, delivery)) in queued.iter().zip(&deliveries).enumerate() {
            stats.packets += 1;
            stats.bytes += packet.bytes.len() as u64;
            match packet.lane {
                Lane::Reliable => stats.reliable_bytes += packet.bytes.len() as u64,
                Lane::Datagram => stats.datagram_bytes += packet.bytes.len() as u64,
            }
            *stats.by_kind_bytes.entry(crate::kind_name(packet.kind)).or_default() += packet.bytes.len() as u64;
            *stats.by_fate.entry(format!("{:?}", delivery.fate).to_lowercase()).or_default() += 1;
            windows.push((packet.depart_ms, packet.bytes.len()));
            if let Some(arrive) = delivery.arrive_ms {
                stats.delivered += 1;
                stats.delivered_bytes += packet.bytes.len() as u64;
                if delivery.channel == CHANNEL_WT_DATAGRAM {
                    dgram_lat.push((arrive - packet.depart_ms) as f32);
                } else {
                    rel_lat.push((arrive - packet.depart_ms) as f32);
                    rel_hol.push(delivery.hol_ms as f32);
                }
                let channel = if delivery.channel == CHANNEL_WT_DATAGRAM { CHANNEL_WT_DATAGRAM } else { CHANNEL_WT_RELIABLE };
                tape.push((arrive, seq, TapePacket { t_ms: arrive, channel, bytes: packet.bytes.clone() }));
            }
        }
        stats.datagram_latency_ms = Pct::of(dgram_lat);
        stats.reliable_latency_ms = Pct::of(rel_lat);
        stats.reliable_hol_ms = Pct::of(rel_hol);
        let duration_s = (f64::from(last_tick - first_tick) + 1.0) / f64::from(hz);
        stats.kbit_s_mean = stats.bytes as f64 * 8.0 / 1000.0 / duration_s.max(1e-9);
        stats.kbit_s_max_1s = max_window_kbit_s(&windows, 1000.0);
        let steady: Vec<(f64, usize)> = windows.iter().copied().filter(|(t, _)| *t >= ORIGIN_MS + JOIN_SETTLE_MS).collect();
        stats.kbit_s_max_1s_steady = max_window_kbit_s(&steady, 1000.0);
        stats.join_bytes = windows.iter().filter(|(t, _)| *t <= ORIGIN_MS).map(|(_, b)| *b as u64).sum();
        stats.kbit_s_max_100ms = max_window_kbit_s(&windows, 100.0);
        tape.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let packets: Vec<TapePacket> = tape.into_iter().map(|(_, _, p)| p).collect();
        write_city_tape(&dir.join("lab.vltape"), capture, &client_spec, hz, first_tick, last_tick, &packets, spec)?;
        // The server's tick timeline on the tape clock (ideal pace).
        let ticks: Vec<serde_json::Value> = (first_tick..=last_tick)
            .map(|tick| serde_json::json!([tick, tick_ms(tick, first_tick, hz)]))
            .collect();
        std::fs::write(dir.join("timeline.json"), serde_json::to_vec(&serde_json::json!({"clock": "tape ms", "ticks": ticks}))?)?;
        std::fs::write(dir.join("stream.json"), serde_json::to_vec_pretty(&serde_json::json!({"client": client_spec, "stream": stats}))?)?;
        results.push((client_spec, stats));
    }
    Ok(CityRun { spec: spec.clone(), first_tick, last_tick, hz, clients: results, server_cost })
}

fn spec_wire_version(strategy: &str) -> u8 {
    if strategy == "per-player" {
        4
    } else {
        2
    }
}

pub fn client_dir(out: &Path, index: usize) -> PathBuf {
    out.join(format!("c{index:02}"))
}

/// The busiest trailing window of `ms` over (time, bytes), as kbit/s.
fn max_window_kbit_s(points: &[(f64, usize)], ms: f64) -> f64 {
    let mut sorted: Vec<(f64, usize)> = points.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut lo, mut sum, mut best) = (0usize, 0usize, 0usize);
    for hi in 0..sorted.len() {
        sum += sorted[hi].1;
        while sorted[hi].0 - sorted[lo].0 >= ms {
            sum -= sorted[lo].1;
            lo += 1;
        }
        best = best.max(sum);
    }
    best as f64 * 8.0 / ms
}

/// A city-only client tape: the transport channels as delivered, no
/// recorded frames (the client stage draws at a fixed cadence).
#[allow(clippy::too_many_arguments)]
fn write_city_tape(
    path: &Path,
    capture: &CityCapture,
    client: &ClientSpec,
    hz: u32,
    first_tick: u32,
    last_tick: u32,
    packets: &[TapePacket],
    spec: &CitySpec,
) -> std::io::Result<()> {
    let tape = ClientTape {
        header: serde_json::json!({
            "version": 2,
            "capturedAt": "netlab2 city",
            "matchId": "netlab-city",
            "manifestHash": capture.manifest.hash_hex(),
            "wireVersion": spec_wire_version(&spec.strategy),
            "simHz": hz,
            "userAgent": "netlab2 city",
            "durationMs": tick_ms(last_tick, first_tick, hz) + 1000.0 / f64::from(hz),
            "frames": 0,
            "frameBytes": 60,
            "localPlayerId": client.id,
            "transport": "webtransport",
            "session": null,
            "clockOriginMs": 0.0,
        }),
        frame_bytes: 60,
        frames_raw: Vec::new(),
        frames: Vec::new(),
        packets: Vec::new(),
    };
    tape.write_with_packets(
        path,
        packets,
        serde_json::json!({
            "netlab": {
                "lab": "city",
                "strategy": spec.strategy,
                "link": spec.link,
                "seed": spec.seed,
                "camera": client.camera.label(),
            }
        }),
    )
}

// ── scoring ─────────────────────────────────────────────────────────────────

/// One client's card.
#[derive(Clone, Debug, Serialize)]
pub struct ClientCard {
    pub id: u64,
    pub camera: String,
    pub stream: ClientStream,
    pub city_sync: Option<crate::score::CitySync>,
    pub chunks: Option<crate::chunks::ChunkStats>,
    pub all_draws: Option<crate::unified::AllDraws>,
    /// What this client's screen showed, as noticed artifacts (V1-V13).
    pub perceptual: Option<vibe_land_destruction::netlab::perceptual::PerceptualReport>,
    pub client_cpu_ms: Option<f64>,
    pub notes: Vec<String>,
    #[serde(skip)]
    pub client_stats: Option<serde_json::Value>,
}

/// Integrity gates (the spec's G1-G6) as far as the lab measures them yet.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Gates {
    /// G1: structure hash mismatches across every client (0 to pass).
    pub g1_hash_mismatches: u64,
    pub g1_hash_checks: u64,
    /// G3: clients whose busiest 1 s window exceeded the bucket's peak
    /// (only with a bucket).
    pub g3_cap: Option<f64>,
    pub g3_clients_over: u64,
    pub g3_worst_kbit_s: f64,
    /// G2: events applied before the drawing reached their tick (v2 applies
    /// on arrival by design, D6), and applied after it passed (late).
    pub g2_events_applied: u64,
    pub g2_events_early: u64,
    pub g2_events_late: u64,
    /// G5: visible body-frames where a body the truth has at rest moved.
    pub g5_resurrection_frames: u64,
    /// Corrections onto the settle pose (not a G5 failure; scored as pops).
    pub g5_settle_snap_frames: u64,
    /// Gates the lab does not measure yet, and why.
    pub pending: Vec<String>,
    pub pass: bool,
}

/// This thread's CPU time: what the strategy costs, unaffected by whatever
/// else the machine runs (wall time on a shared machine is not).
fn thread_cpu() -> std::time::Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime writes the timespec it is given.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    std::time::Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

/// C2: what the strategy cost the server, per send and per client, in
/// thread CPU time.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ServerCost {
    pub sends: u64,
    pub ticks: u64,
    /// The truth ingest per tick (shared), ms.
    pub ingest_ms: Pct,
    /// Every client's packets for one send, ms (the calling thread's CPU:
    /// with `pp.send_threads` > 1 the workers' time is not in it).
    pub send_ms: Pct,
    /// The batched send's wall time, ms (what parallel sends shorten).
    pub send_wall_ms: Pct,
    /// One client's packets, us (mean).
    pub per_client_us: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CityCard {
    pub spec: CitySpec,
    pub hz: u32,
    pub first_tick: u32,
    pub last_tick: u32,
    pub gates: Gates,
    /// C2: what the strategy cost the server.
    pub server_cost: ServerCost,
    /// Origin egress, kbit/s: per player it is every client's stream; a
    /// shared stream behind relays publishes somewhere between the busiest
    /// client's and that (the union of what any client needed).
    pub egress_total_kbit_s: f64,
    pub egress_max_client_kbit_s: f64,
    /// The perceptual model the cards were scored with.
    pub model: vibe_land_destruction::perception::PerceptualModel,
    /// Mean over clients of Q and of the penalty per minute.
    pub q_mean: Option<f64>,
    pub q_min: Option<f64>,
    pub penalty_per_minute_mean: Option<f64>,
    pub clients: Vec<ClientCard>,
    /// Bytes across clients: mean of means, max of maxima, kbit/s.
    pub kbit_s_mean: f64,
    pub kbit_s_max_1s: f64,
}

/// The perceptual model a run scores (and per-player ranks) with: `--model
/// <json>` (a calibration fit), else the literature seeds.
pub fn perceptual_model(knobs: &BTreeMap<String, String>) -> vibe_land_destruction::perception::PerceptualModel {
    match knobs.get("model") {
        Some(path) => vibe_land_destruction::perception::PerceptualModel::load(Path::new(path))
            .unwrap_or_else(|e| die(&format!("--model {path}: {e}"))),
        None => vibe_land_destruction::perception::PerceptualModel::literature(),
    }
}

pub fn score_city(capture: &CityCapture, run: &CityRun, out: &Path) -> std::io::Result<CityCard> {
    let model = perceptual_model(&run.spec.knobs);
    let mut gates = Gates { pass: true, ..Default::default() };
    gates.pending = vec![
        "G4 solid geometry: needs the static occupancy grid".into(),
        "G6 server time: reported as C2 (server_cost); its budget is set at scale (milestone 8)".into(),
    ];
    let tick_end: HashMap<u32, f64> =
        (run.first_tick..=run.last_tick).map(|tick| (tick, tick_ms(tick, run.first_tick, run.hz))).collect();
    // Clients are independent: score them in parallel.
    let cards: Vec<ClientCard> = std::thread::scope(|scope| {
        let handles: Vec<_> = run
            .clients
            .iter()
            .enumerate()
            .map(|(index, (client, stream))| {
                let dir = client_dir(out, index);
                let (tick_end, model) = (&tick_end, model.clone());
                scope.spawn(move || score_client(capture, client, stream, &dir, tick_end, model))
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("client scoring thread")).collect()
    });
    for (card, (_, stream)) in cards.iter().zip(&run.clients) {
        if let Some(sync) = &card.city_sync {
            gates.g1_hash_mismatches += sync.hash_mismatches;
            gates.g1_hash_checks += sync.hash_checks;
        }
        if let Some((_, burst, _)) = run.spec.bucket {
            gates.g3_cap = Some(burst);
            gates.g3_worst_kbit_s = gates.g3_worst_kbit_s.max(stream.kbit_s_max_1s_steady);
            // A 1 s window may hold the bucket's peak for at most 1 s.
            if stream.kbit_s_max_1s_steady > burst * 1.001 {
                gates.g3_clients_over += 1;
            }
        }
        if let Some(stats) = &card.client_stats {
            let n = |k: &str| stats["city"][k].as_u64().unwrap_or(0);
            gates.g2_events_applied += n("eventsApplied");
            gates.g2_events_early += n("eventsAppliedEarly");
            gates.g2_events_late += n("eventsLate");
        }
        if let Some(p) = &card.perceptual {
            gates.g5_resurrection_frames += p.g5_resurrection_frames;
            gates.g5_settle_snap_frames += p.g5_settle_snap_frames;
        }
    }
    gates.pass = gates.g1_hash_mismatches == 0
        && gates.g3_clients_over == 0
        && gates.g2_events_early == 0
        && gates.g5_resurrection_frames == 0;
    let n = cards.len().max(1) as f64;
    let qs: Vec<f64> = cards.iter().filter_map(|c| c.perceptual.as_ref().map(|p| p.q)).collect();
    let penalties: Vec<f64> = cards.iter().filter_map(|c| c.perceptual.as_ref().map(|p| p.penalty_per_minute)).collect();
    let card = CityCard {
        spec: run.spec.clone(),
        hz: run.hz,
        first_tick: run.first_tick,
        last_tick: run.last_tick,
        gates,
        server_cost: run.server_cost.clone(),
        egress_total_kbit_s: cards.iter().map(|c| c.stream.kbit_s_mean).sum(),
        egress_max_client_kbit_s: cards.iter().map(|c| c.stream.kbit_s_mean).fold(0.0, f64::max),
        model,
        q_mean: (!qs.is_empty()).then(|| qs.iter().sum::<f64>() / qs.len() as f64),
        q_min: qs.iter().copied().reduce(f64::min),
        penalty_per_minute_mean: (!penalties.is_empty()).then(|| penalties.iter().sum::<f64>() / penalties.len() as f64),
        kbit_s_mean: cards.iter().map(|c| c.stream.kbit_s_mean).sum::<f64>() / n,
        kbit_s_max_1s: cards.iter().map(|c| c.stream.kbit_s_max_1s).fold(0.0, f64::max),
        clients: cards,
    };
    std::fs::write(out.join("scorecard.json"), serde_json::to_vec_pretty(&card)?)?;
    std::fs::write(out.join("scorecard.md"), card_markdown(&card))?;
    Ok(card)
}

fn score_client(
    capture: &CityCapture,
    client: &ClientSpec,
    stream: &ClientStream,
    dir: &Path,
    tick_end: &HashMap<u32, f64>,
    model: vibe_land_destruction::perception::PerceptualModel,
) -> ClientCard {
    let mut card = ClientCard {
        id: client.id,
        camera: client.camera.label(),
        stream: stream.clone(),
        city_sync: None,
        chunks: None,
        all_draws: None,
        perceptual: None,
        client_cpu_ms: None,
        notes: Vec::new(),
        client_stats: None,
    };
    if let Ok(bytes) = std::fs::read(dir.join("client-stats.json")) {
        if let Ok(stats) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            card.city_sync = crate::score::CitySync::from_client_stats(&stats);
            card.client_cpu_ms = stats["clientCpuMs"].as_f64();
            card.client_stats = Some(stats);
        }
    }
    let chunks = dir.join(crate::chunks::CHUNKS_FILE);
    if !chunks.is_file() {
        card.notes.push("no drawn-chunks.bin: the client stage did not run".into());
        return card;
    }
    let mut acc = crate::unified::AllDrawsAcc::default();
    match crate::chunks::score_chunks(
        &chunks,
        &capture.tape_path(),
        &capture.manifest,
        capture.checkpoint.as_ref(),
        &mut acc,
        None,
        tick_end,
    ) {
        Ok(stats) => card.chunks = Some(stats),
        Err(error) => card.notes.push(format!("chunks not scored: {error}")),
    }
    card.all_draws = Some(acc.report());
    match crate::city_perceptual::evaluate_client(
        &chunks,
        &capture.tape_path(),
        &capture.manifest,
        capture.checkpoint.as_ref(),
        &client.camera,
        &capture.tracks,
        ORIGIN_MS,
        model,
        None,
    ) {
        Ok(report) => card.perceptual = Some(report),
        Err(error) => card.notes.push(format!("perceptual not scored: {error}")),
    }
    card
}

fn card_markdown(card: &CityCard) -> String {
    use std::fmt::Write;
    let mut md = String::new();
    let _ = writeln!(md, "# City lab: {} on {}\n", card.spec.strategy, card.spec.link);
    let _ = writeln!(
        md,
        "Capture `{}`, ticks {}..{} at {} Hz, seed {}, rate adaptation {}, bucket {}.\n",
        card.spec.capture,
        card.first_tick,
        card.last_tick,
        card.hz,
        card.spec.seed,
        if card.spec.rate_adapt { "on" } else { "off" },
        card.spec.bucket.map_or("none".into(), |(s, b, d)| format!("{s} kbit/s, {b} kbit/s for {d} s")),
    );
    let g = &card.gates;
    let _ = writeln!(
        md,
        "**Gates: {}.** G1 hash mismatches {} of {} checks; G3 {}.",
        if g.pass { "pass" } else { "FAIL" },
        g.g1_hash_mismatches,
        g.g1_hash_checks,
        g.g3_cap.map_or("no cap".into(), |cap| format!(
            "{} clients over {cap} kbit/s (worst 1 s window {:.0})",
            g.g3_clients_over, g.g3_worst_kbit_s
        )),
    );
    let _ = writeln!(
        md,
        "G2: {} events applied, {} before the drawing reached their tick, {} after it passed. G5: {} body-frames moved while at rest ({} more were corrections onto the rest pose).",
        g.g2_events_applied, g.g2_events_early, g.g2_events_late, g.g5_resurrection_frames, g.g5_settle_snap_frames
    );
    let c = &card.server_cost;
    let _ = writeln!(
        md,
        "C2 server cost: ingest p50/p99 {:.3}/{:.3} ms per tick; every client's send p50/p99 {:.3}/{:.3} ms; {:.1} us per client send.",
        c.ingest_ms.p50, c.ingest_ms.p99, c.send_ms.p50, c.send_ms.p99, c.per_client_us
    );
    let _ = writeln!(
        md,
        "Origin egress: {:.1} kbit/s for every client's stream (per-player's cost); a relayed shared stream publishes between {:.1} and that.",
        card.egress_total_kbit_s, card.egress_max_client_kbit_s
    );
    for pending in &g.pending {
        let _ = writeln!(md, "- pending: {pending}");
    }
    let _ = writeln!(md, "\nBytes: {:.1} kbit/s mean per client, busiest 1 s window {:.1} kbit/s.", card.kbit_s_mean, card.kbit_s_max_1s);
    if let (Some(q), Some(q_min), Some(p)) = (card.q_mean, card.q_min, card.penalty_per_minute_mean) {
        let _ = writeln!(
            md,
            "\n**Q {q:.1} mean, {q_min:.1} worst client** (penalty {p:.2} per client-minute; perceptual model {}).",
            card.model.calibration
        );
    }
    let _ = writeln!(md);
    let _ = writeln!(md, "| client | camera | kbit/s | max 1 s | debris pos@render p99 m | debris pos@now p99 m | missing | wrong id | hash mism. |");
    let _ = writeln!(md, "|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for client in &card.clients {
        let debris = client.all_draws.as_ref().and_then(|a| a.classes.get("chunk_debris").cloned()).unwrap_or_default();
        let _ = writeln!(
            md,
            "| {} | {} | {:.1} | {:.1} | {:.3} | {:.3} | {:.0} | {:.0} | {} |",
            client.id,
            client.camera,
            client.stream.kbit_s_mean,
            client.stream.kbit_s_max_1s,
            debris.pos_render_m.p99,
            debris.pos_now_m.p99,
            debris.missing,
            debris.wrong_identity,
            client.city_sync.as_ref().map_or("-".into(), |s| s.hash_mismatches.to_string()),
        );
    }
    let _ = writeln!(md, "\nNoticed artifacts per client-minute (events at or above threshold / penalty):\n");
    let classes: Vec<String> = card
        .clients
        .iter()
        .find_map(|c| c.perceptual.as_ref())
        .map(|p| p.classes.iter().filter(|(_, c)| c.samples > 0.0 || c.events > 0).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    let _ = writeln!(md, "| client | Q | {} |", classes.join(" | "));
    let _ = writeln!(md, "|---|---:|{}", classes.iter().map(|_| "---:|").collect::<String>());
    for client in &card.clients {
        let Some(p) = &client.perceptual else { continue };
        let cells: Vec<String> = classes
            .iter()
            .map(|k| p.classes.get(k).map_or("-".into(), |c| format!("{:.1} / {:.2}", c.events_at_theta_per_minute, c.penalty_per_minute)))
            .collect();
        let _ = writeln!(md, "| {} | {:.1} | {} |", client.id, p.q, cells.join(" | "));
    }
    if let Some(p) = card.clients.iter().find_map(|c| c.perceptual.as_ref()) {
        let _ = writeln!(md, "\nNot measured yet: {}.", p.not_measured.join("; "));
    }
    md
}

// ── the command ─────────────────────────────────────────────────────────────

pub fn city_spec(args: &Args, capture: &CityCapture, capture_label: String) -> CitySpec {
    let link = args.get("link").unwrap_or("loopback").to_string();
    let profile = crate::load_profile(&link, args.get("profiles"));
    let seed = args.get("seed").map_or(1, |s| s.parse().unwrap_or_else(|_| die("--seed N")));
    let rate_adapt = args.get("rate-adapt").map_or(true, |v| v != "0");
    let bucket = args.get("budget-kbps").map(|value| {
        let num = |key: &str, default: f64| {
            args.get(key).map_or(default, |v| v.parse::<f64>().unwrap_or_else(|_| die(&format!("--{key} number"))))
        };
        let sustained: f64 = value.parse().unwrap_or_else(|_| die("--budget-kbps number"));
        (sustained, num("burst-kbps", sustained * 3.0), num("burst-s", 3.0))
    });
    let mut knobs = BTreeMap::new();
    for knob in args.all("knob") {
        for part in knob.split(',').filter(|p| !p.is_empty()) {
            let (k, v) = part.split_once('=').unwrap_or_else(|| die(&format!("--knob {part}: k=v")));
            knobs.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    // --model <json>: score (and, per player, rank) with a calibrated model.
    if let Some(path) = args.get("model") {
        knobs.insert("model".into(), path.to_string());
    }
    let cameras = args.all("camera");
    let clients: Vec<ClientSpec> = if cameras.is_empty() {
        let count = args.get("clients").map_or(capture.tracks.players().len().max(1), |n| {
            n.parse().unwrap_or_else(|_| die("--clients N"))
        });
        build_client_set(count, &capture.tracks, &capture.manifest, &[link.clone()], seed as u32)
    } else {
        cameras
            .iter()
            .enumerate()
            .map(|(index, text)| ClientSpec {
                id: 1 + index as u64,
                camera: CameraSpec::parse(text).unwrap_or_else(|e| die(&e)),
                profile: link.clone(),
            })
            .collect()
    };
    CitySpec {
        capture: capture_label,
        strategy: args.get("strategy").unwrap_or("shared-v2").to_string(),
        link,
        profile,
        seed,
        rate_adapt,
        bucket,
        clients,
        knobs,
    }
}

/// The capture a `--capture` or `--bundle` names.
pub fn open_capture(args: &Args) -> (CityCapture, String) {
    let dir = match (args.get("capture"), args.get("bundle")) {
        (Some(dir), _) => PathBuf::from(dir),
        (None, Some(bundle)) => {
            let bundle = PathBuf::from(bundle);
            let server = if bundle.join("server").is_dir() { bundle.join("server") } else { bundle.clone() };
            server.join(crate::session_capture::CITY_DIR)
        }
        (None, None) => die("--capture <city capture dir> or --bundle <session bundle> is required"),
    };
    let capture = CityCapture::open(&dir).unwrap_or_else(|e| die(&format!("{}: {e}", dir.display())));
    (capture, dir.display().to_string())
}

/// A finished run read back from its directory (`--rescore`): the spec as
/// the command line gives it, each client's stream totals from its
/// `stream.json`, the tick range from the capture.
fn read_run(capture: &CityCapture, spec: CitySpec, out: &Path) -> std::io::Result<CityRun> {
    let mut clients = Vec::new();
    for index in 0..spec.clients.len() {
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(client_dir(out, index).join("stream.json"))?)?;
        let client: ClientSpec = serde_json::from_value(value["client"].clone())?;
        let stream: ClientStream = serde_json::from_value(value["stream"].clone())?;
        clients.push((client, stream));
    }
    let first = capture.meta.first_tick.unwrap_or(0);
    let last = capture.meta.last_tick.unwrap_or(first);
    let server_cost = std::fs::read(out.join("server-cost.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Ok(CityRun { spec, first_tick: first, last_tick: last, hz: capture.meta.hz.max(1), clients, server_cost })
}

pub fn cmd_city(args: &Args) {
    let (capture, label) = open_capture(args);
    let out = args.path("out");
    let spec = city_spec(args, &capture, label);
    if args.get("rescore").is_some() {
        let run = read_run(&capture, spec, &out).unwrap_or_else(|e| die(&format!("--rescore: {e}")));
        let card = score_city(&capture, &run, &out).unwrap_or_else(|e| die(&e.to_string()));
        println!("{}", card_markdown(&card));
        return;
    }
    let run = run_city_stream(&capture, &spec, &out).unwrap_or_else(|e| die(&e.to_string()));
    eprintln!(
        "netlab2 city: {} clients, ticks {}..{}, {} on {}",
        run.clients.len(),
        run.first_tick,
        run.last_tick,
        spec.strategy,
        spec.link
    );
    let pp_client_ts = args.get("pp-client") == Some("ts");
    if args.get("no-client").is_none() && spec.strategy == "per-player" && !pp_client_ts {
        // The shared client core, in-process (the browser runs it as WASM).
        let config = per_player_config(&capture, &spec.knobs);
        let timeline: Vec<(u32, f64)> = (run.first_tick..=run.last_tick).map(|t| (t, tick_ms(t, run.first_tick, run.hz))).collect();
        std::thread::scope(|scope| {
            for index in 0..run.clients.len() {
                let (dir, timeline, manifest) = (client_dir(&out, index), &timeline, &capture.manifest);
                scope.spawn(move || {
                    crate::city_pp_stage::run(&dir, manifest, config, timeline).unwrap_or_else(|e| die(&format!("per-player client stage: {e}")))
                });
            }
        });
    } else if args.get("no-client").is_none() {
        let jobs: usize = args.get("jobs").map_or(4, |j| j.parse().unwrap_or_else(|_| die("--jobs N")));
        let client_root = crate::client_root(args);
        let manifest = capture.dir.join(city_capture::MANIFEST_FILE);
        let dirs: Vec<PathBuf> = (0..run.clients.len()).map(|index| client_dir(&out, index)).collect();
        for batch in dirs.chunks(jobs.max(1)) {
            let handles: Vec<_> = batch
                .iter()
                .map(|dir| {
                    let (dir, root, manifest) = (dir.clone(), client_root.clone(), manifest.clone());
                    std::thread::spawn(move || {
                        crate::run_client_stage(&dir.join("lab.vltape"), &dir, "60", &root, "city", &manifest)
                    })
                })
                .collect();
            for handle in handles {
                handle.join().expect("client stage thread").unwrap_or_else(|e| die(&e.to_string()));
            }
        }
    }
    let card = score_city(&capture, &run, &out).unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", card_markdown(&card).lines().take(12).collect::<Vec<_>>().join("\n"));
}
