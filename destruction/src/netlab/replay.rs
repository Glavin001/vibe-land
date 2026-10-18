//! Replay a tape through the encoder for many clients at once, writing each
//! client's byte stream and the cost of producing it.
//!
//! This is `netlab-encoder`'s loop generalised: the same ingest / topology /
//! baseline / send cadence, but with N clients whose cameras come from the
//! capture's recorded tracks or from synthetic specs, and with every client's
//! packets logged in the format the shipping TS client replays. The server
//! side of the netcode is O(bodies x clients) per send, and nothing before
//! this measured it at more than a handful of clients.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::encoder::{ChunkStreamEncoder, EncoderConfig};
use crate::manifest::DestructionManifest;
use crate::netlab::cameras::{ClientSpec, PlayerTracks};
use crate::netlab::capture::CaptureDir;
use crate::netlab::packets::PacketLog;
use crate::netlab::tape::TapeReader;

/// Periodic ledger hash cadence, mirroring `server/src/city.rs`.
pub const TOPO_HASH_INTERVAL_TICKS: u32 = 120;

/// Encoder knobs a replay may override, echoed into every output so a
/// scorecard is self-describing.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Knobs {
    pub send_hz: Option<u32>,
    pub ceiling_bytes: Option<usize>,
    pub error_budget_px: Option<f32>,
    pub burst_capacity_sends: Option<u32>,
    pub burst_max_multiple: Option<u32>,
    pub max_eval: Option<usize>,
}

impl Knobs {
    pub fn apply(&self, hz: u32) -> EncoderConfig {
        let mut config = EncoderConfig::validated(hz);
        // Mirror CityRuntime::from_parts.
        config.send_interval_ticks = (hz / self.send_hz.unwrap_or(30).max(1)).max(1);
        config.interest.proximity_meters = 120.0;
        if let Some(value) = self.ceiling_bytes {
            config.client_ceiling_bytes = if value == 0 { usize::MAX } else { value };
        }
        if let Some(value) = self.error_budget_px {
            config.error_budget_px = value;
        }
        if let Some(value) = self.burst_capacity_sends {
            config.burst_capacity_sends = value;
        }
        if let Some(value) = self.burst_max_multiple {
            config.burst_max_multiple = value;
        }
        // MAX_EVAL is read from the environment by the encoder itself.
        if let Some(value) = self.max_eval {
            std::env::set_var("VIBE_CITY_MAX_EVAL", value.to_string());
        }
        config
    }
}

pub struct ReplayInput {
    pub tape: PathBuf,
    pub manifest: DestructionManifest,
    pub tracks: PlayerTracks,
    pub hz: u32,
    /// Informational: where the tape came from.
    pub source: String,
}

impl ReplayInput {
    pub fn from_capture(dir: &Path) -> std::io::Result<Self> {
        let capture = CaptureDir::open(dir)?;
        let manifest: DestructionManifest =
            serde_json::from_slice(&std::fs::read(capture.manifest_path())?)?;
        let tracks = PlayerTracks::from_samples(&capture.cameras()?);
        Ok(Self {
            tape: capture.tape_path(),
            manifest,
            tracks,
            hz: capture.meta.hz,
            source: dir.display().to_string(),
        })
    }

    pub fn from_tape(tape: &Path, manifest: &Path) -> std::io::Result<Self> {
        let manifest: DestructionManifest = serde_json::from_slice(&std::fs::read(manifest)?)?;
        let reader = TapeReader::open(tape)?;
        Ok(Self {
            tape: tape.to_path_buf(),
            manifest,
            tracks: PlayerTracks::default(),
            hz: reader.hz,
            source: tape.display().to_string(),
        })
    }
}

/// Summary statistics of a set of millisecond samples.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct MsStats {
    pub samples: usize,
    pub mean: f32,
    pub p50: f32,
    pub p95: f32,
    pub max: f32,
    pub total: f32,
}

impl MsStats {
    pub fn of(samples: &mut Vec<f32>) -> Self {
        if samples.is_empty() {
            return Self::default();
        }
        samples.sort_by(|a, b| a.total_cmp(b));
        let total: f32 = samples.iter().sum();
        let at = |q: f32| samples[((samples.len() - 1) as f32 * q).round() as usize];
        Self {
            samples: samples.len(),
            mean: total / samples.len() as f32,
            p50: at(0.5),
            p95: at(0.95),
            max: samples[samples.len() - 1],
            total,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClientReport {
    pub id: u64,
    pub spec: ClientSpec,
    pub dir: String,
    pub first_tick: u32,
    pub pose_bytes: u64,
    pub reliable_bytes: u64,
    pub datagrams: u64,
    pub reliable_packets: u64,
    pub records: u64,
    pub pose_mbps: f64,
    pub reliable_mbps: f64,
    /// `client_datagrams` wall time per send, this client only.
    pub datagrams_ms: MsStats,
    /// The `AuditReport` as JSON (its cells hold static strs and cannot be
    /// deserialised as a struct).
    pub audit: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplayReport {
    pub source: String,
    pub hz: u32,
    pub first_tick: u32,
    pub last_tick: u32,
    pub ticks: u32,
    pub seconds: f64,
    pub sends: u32,
    pub knobs: Knobs,
    pub ceiling_bytes: usize,
    pub send_interval_ticks: u32,
    pub clients: Vec<ClientReport>,
    /// `encode_send` (shared, client-independent) per send.
    pub encode_send_ms: MsStats,
    /// Sum over all clients of `client_datagrams` per send.
    pub client_datagrams_total_ms: MsStats,
    /// Shared + all clients, per send: the tick-budget number.
    pub per_send_ms: MsStats,
    /// Everything reliable, per client (same bytes to all).
    pub reliable_bytes_per_client: u64,
    pub egress_bytes_total: u64,
    pub egress_mbps_total: f64,
    pub peak_awake: usize,
    pub mean_awake: f64,
    pub replay_wall_s: f32,
}

pub struct ReplayOptions {
    pub out_dir: PathBuf,
    pub clients: Vec<ClientSpec>,
    pub knobs: Knobs,
    /// Clients whose sends feed the audit; empty = none.
    pub audit_clients: Vec<u64>,
    /// Skip writing packets (timing-only runs).
    pub write_packets: bool,
    /// When set, packets are written only for these clients (the rest are
    /// timed and counted but not logged -- a hundred clients' bytes are not
    /// worth a hundred files when eight get scored).
    pub packet_clients: Option<std::collections::HashSet<u64>>,
}

struct ClientState {
    spec: ClientSpec,
    log: Option<PacketLog>,
    dir: PathBuf,
    joined: bool,
    first_tick: u32,
    datagrams_ms: Vec<f32>,
    records: u64,
    pose_bytes: u64,
    datagrams: u64,
    reliable_bytes: u64,
    reliable_packets: u64,
}

pub fn run(input: &ReplayInput, options: &ReplayOptions) -> std::io::Result<ReplayReport> {
    let started = Instant::now();
    let mut reader = TapeReader::open(&input.tape)?;
    if reader.manifest_hash != input.manifest.hash() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "tape was recorded against a different manifest",
        ));
    }
    let hz = reader.hz;
    let config = options.knobs.apply(hz);
    let mut encoder = ChunkStreamEncoder::new(&input.manifest, config);
    if !options.audit_clients.is_empty() {
        encoder.enable_send_audit();
        encoder.set_audit_clients(options.audit_clients.iter().copied());
    }

    let mut clients: Vec<ClientState> = Vec::with_capacity(options.clients.len());
    for spec in &options.clients {
        let dir = options.out_dir.join("pkts").join(client_dir_name(spec));
        let logged = options.write_packets
            && options.packet_clients.as_ref().map_or(true, |set| set.contains(&spec.id));
        let log = if logged { Some(PacketLog::create(&dir)?) } else { None };
        clients.push(ClientState {
            spec: spec.clone(),
            log,
            dir,
            joined: false,
            first_tick: 0,
            datagrams_ms: Vec::new(),
            records: 0,
            pose_bytes: 0,
            datagrams: 0,
            reliable_bytes: 0,
            reliable_packets: 0,
        });
    }

    let mut encode_send_ms = Vec::new();
    let mut client_total_ms = Vec::new();
    let mut per_send_ms = Vec::new();
    let mut reliable_bytes_per_client = 0u64;
    let mut first_tick = None;
    let mut last_tick = 0u32;
    let mut ticks = 0u32;
    let mut sends = 0u32;
    let mut peak_awake = 0usize;
    let mut awake_sum = 0u64;

    while let Some(entry) = reader.next_tick()? {
        let tick = entry.tick;
        first_tick.get_or_insert(tick);
        last_tick = tick;
        ticks += 1;
        peak_awake = peak_awake.max(entry.snapshots.len());
        awake_sum += entry.snapshots.len() as u64;

        // Joins happen between ticks: the bootstrap is the ledger as of the
        // previous tick, and this tick's topology messages follow it -- the
        // order the server produces. A recorded player joins when its track
        // begins; synthetic viewers are present from the first tick.
        for client in clients.iter_mut() {
            if client.joined {
                continue;
            }
            let present = client.spec.camera.camera_at(tick, hz, &input.tracks).is_some();
            if !present {
                continue;
            }
            client.joined = true;
            client.first_tick = tick;
            encoder.add_client(client.spec.id);
            let bootstrap = encoder.bootstrap_message(tick);
            client.reliable_bytes += bootstrap.len() as u64;
            client.reliable_packets += 1;
            if let Some(log) = client.log.as_mut() {
                log.push(tick, 'r', &bootstrap)?;
            }
        }

        encoder.ingest_tick(tick, &entry.snapshots, &entry.output, &[]);

        let mut reliable: Vec<Vec<u8>> = encoder.take_topology_messages();
        if let Some(baselines) = encoder.maybe_emit_baseline(tick) {
            reliable.extend(baselines);
        }
        if tick % TOPO_HASH_INTERVAL_TICKS == 0 {
            reliable.push(encoder.topology_hash_message());
        }
        for packet in &reliable {
            reliable_bytes_per_client += packet.len() as u64;
            for client in clients.iter_mut() {
                if !client.joined {
                    continue;
                }
                client.reliable_bytes += packet.len() as u64;
                client.reliable_packets += 1;
                if let Some(log) = client.log.as_mut() {
                    log.push(tick, 'r', packet)?;
                }
            }
        }

        if tick % config.send_interval_ticks == 0 {
            sends += 1;
            let send_started = Instant::now();
            let shared = encoder.encode_send(tick);
            let shared_ms = send_started.elapsed().as_secs_f32() * 1000.0;
            let mut total_client_ms = 0.0f32;
            if !shared.records.is_empty() {
                for client in clients.iter_mut() {
                    if !client.joined {
                        continue;
                    }
                    let Some(camera) = client.spec.camera.camera_at(tick, hz, &input.tracks)
                    else {
                        continue;
                    };
                    let client_started = Instant::now();
                    let packets = encoder.client_datagrams(client.spec.id, camera, &shared);
                    let ms = client_started.elapsed().as_secs_f32() * 1000.0;
                    client.datagrams_ms.push(ms);
                    total_client_ms += ms;
                    for packet in &packets {
                        client.records +=
                            u64::from(crate::wire::datagram_record_count(packet));
                        client.pose_bytes += packet.len() as u64;
                        client.datagrams += 1;
                        if let Some(log) = client.log.as_mut() {
                            log.push(tick, 'd', packet)?;
                        }
                    }
                }
            }
            encode_send_ms.push(shared_ms);
            client_total_ms.push(total_client_ms);
            per_send_ms.push(shared_ms + total_client_ms);
        }
    }

    let first_tick = first_tick.unwrap_or(0);
    let seconds = ticks as f64 / hz as f64;
    let mut reports = Vec::with_capacity(clients.len());
    let mut egress = 0u64;
    let audit_report = encoder
        .send_audit()
        .and_then(|audit| serde_json::to_value(audit.report()).ok());
    for mut client in clients {
        if let Some(log) = client.log.take() {
            log.finish()?;
        }
        let (pose_bytes, reliable_bytes, datagrams, reliable_packets) = (
            client.pose_bytes,
            client.reliable_bytes,
            client.datagrams,
            client.reliable_packets,
        );
        egress += pose_bytes + reliable_bytes;
        let meta = serde_json::json!({
            "hz": hz,
            "ticks": ticks,
            "first_tick": first_tick,
            "last_tick": last_tick,
            "wire": 2,
            "client": client.spec.id,
            "camera": client.spec.camera,
            "profile": client.spec.profile,
            "knobs": options.knobs,
            "source": input.source,
        });
        if client.dir.is_dir() {
            std::fs::write(client.dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
        }
        let audited = options.audit_clients.contains(&client.spec.id);
        reports.push(ClientReport {
            id: client.spec.id,
            spec: client.spec.clone(),
            dir: client.dir.display().to_string(),
            first_tick: client.first_tick,
            pose_bytes,
            reliable_bytes,
            datagrams,
            reliable_packets,
            records: client.records,
            pose_mbps: pose_bytes as f64 * 8.0 / seconds.max(1e-9) / 1e6,
            reliable_mbps: reliable_bytes as f64 * 8.0 / seconds.max(1e-9) / 1e6,
            datagrams_ms: MsStats::of(&mut client.datagrams_ms),
            // One audit for the whole encoder, attributed to the audited set.
            audit: if audited && options.audit_clients.len() == 1 {
                audit_report.clone()
            } else {
                None
            },
        });
    }
    let report = ReplayReport {
        source: input.source.clone(),
        hz,
        first_tick,
        last_tick,
        ticks,
        seconds,
        sends,
        knobs: options.knobs.clone(),
        ceiling_bytes: config.client_ceiling_bytes,
        send_interval_ticks: config.send_interval_ticks,
        clients: reports,
        encode_send_ms: MsStats::of(&mut encode_send_ms),
        client_datagrams_total_ms: MsStats::of(&mut client_total_ms),
        per_send_ms: MsStats::of(&mut per_send_ms),
        reliable_bytes_per_client,
        egress_bytes_total: egress,
        egress_mbps_total: egress as f64 * 8.0 / seconds.max(1e-9) / 1e6,
        peak_awake,
        mean_awake: awake_sum as f64 / ticks.max(1) as f64,
        replay_wall_s: started.elapsed().as_secs_f32(),
    };
    std::fs::create_dir_all(&options.out_dir)?;
    std::fs::write(options.out_dir.join("replay.json"), serde_json::to_vec_pretty(&report)?)?;
    if let Some(audit) = audit_report {
        std::fs::write(options.out_dir.join("audit.json"), serde_json::to_vec_pretty(&audit)?)?;
    }
    if let Some(audit) = encoder.send_audit() {
        std::fs::write(options.out_dir.join("audit.txt"), audit.table(hz as f32))?;
    }
    Ok(report)
}

pub fn client_dir_name(spec: &ClientSpec) -> String {
    format!("{}-{}", spec.id, spec.camera.label().replace(':', "_"))
}

/// A short human table of the report.
pub fn summary(report: &ReplayReport) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "ticks {} ({:.1} s) | sends {} | clients {} | ceiling {} B | awake peak {} mean {:.0} | wall {:.2} s",
        report.ticks,
        report.seconds,
        report.sends,
        report.clients.len(),
        report.ceiling_bytes,
        report.peak_awake,
        report.mean_awake,
        report.replay_wall_s
    );
    let _ = writeln!(
        out,
        "encode_send ms  p50 {:.3} p95 {:.3} max {:.3} | clients total ms p50 {:.3} p95 {:.3} max {:.3} | per send p50 {:.3} p95 {:.3} max {:.3}",
        report.encode_send_ms.p50,
        report.encode_send_ms.p95,
        report.encode_send_ms.max,
        report.client_datagrams_total_ms.p50,
        report.client_datagrams_total_ms.p95,
        report.client_datagrams_total_ms.max,
        report.per_send_ms.p50,
        report.per_send_ms.p95,
        report.per_send_ms.max
    );
    let _ = writeln!(
        out,
        "reliable {:.3} Mbps/client | egress total {:.2} Mbps ({} clients)",
        report.reliable_bytes_per_client as f64 * 8.0 / report.seconds.max(1e-9) / 1e6,
        report.egress_mbps_total,
        report.clients.len()
    );
    let shown = report.clients.len().min(12);
    for client in &report.clients[..shown] {
        let _ = writeln!(
            out,
            "  client {:>6} {:<10} {:<10} poses {:.3} Mbps {:>7} dg {:>8} rec | datagrams ms p50 {:.3} p95 {:.3} max {:.3}",
            client.id,
            client.spec.camera.label(),
            client.spec.profile,
            client.pose_mbps,
            client.datagrams,
            client.records,
            client.datagrams_ms.p50,
            client.datagrams_ms.p95,
            client.datagrams_ms.max
        );
    }
    if report.clients.len() > shown {
        let _ = writeln!(out, "  ... {} more clients", report.clients.len() - shown);
    }
    out
}

/// Clients as a map for lookups by id.
pub fn clients_by_id(report: &ReplayReport) -> HashMap<u64, &ClientReport> {
    report.clients.iter().map(|client| (client.id, client)).collect()
}
