mod demo_world;
mod lag_comp;
mod movement;
mod protocol;
mod voxel_world;

use std::{
    backtrace::Backtrace,
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, RwLock as StdRwLock,
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use bytes::BufMut;
use futures_util::{sink::SinkExt, stream::StreamExt, FutureExt};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, RwLock as AsyncRwLock};
use tracing::{error, info, warn};
use vibe_land_shared::constants::{
    DEFAULT_BATTERY_HEIGHT_M, DEFAULT_BATTERY_RADIUS_M, DYNAMIC_BODY_AOI_EXIT_RADIUS_M,
    DYNAMIC_BODY_AOI_RADIUS_M, DYNAMIC_BODY_IMPULSE, FLAG_MELEEING, HITSCAN_MAX_DISTANCE_M,
    MAX_PENDING_INPUTS, MELEE_COOLDOWN_MS, MELEE_DAMAGE, MELEE_ENERGY_COST,
    MELEE_FLAG_DURATION_TICKS, MELEE_HALF_CONE_COS, MELEE_HIT_RECOVERY_MS, MELEE_RANGE_M,
    OUT_OF_BOUNDS_Y_M, PLAYER_AOI_RADIUS_M, PLAYER_EYE_HEIGHT_M, RIFLE_FIRE_INTERVAL_MS,
    RIFLE_BODY_DAMAGE, RIFLE_HEAD_DAMAGE, RIFLE_SHOT_ENERGY_COST, SIM_HZ,
    SNAPSHOT_HZ_MULTIPLAYER, SPAWN_PROTECTION_MS,
    VEHICLE_AOI_RADIUS_M, VEHICLE_INPUT_CATCHUP_THRESHOLD,
};
use wtransport::{error::SendDatagramError, Connection, Endpoint, Identity, ServerConfig};

use crate::{
    demo_world::seed_world_for_match,
    lag_comp::{HistoricalCapsule, HistoricalDynamicBody, HitZone, LagCompHistory},
    movement::{MoveConfig, PhysicsArena, PlayerDamageOutcome},
    protocol::{
        client_datagram_to_packet, cms_to_mps, decode_client_datagram, decode_client_hello,
        decode_client_packet, encode_server_packet, energy_to_centi, f32_to_snorm16,
        make_net_battery_state, make_net_dynamic_body_state, make_net_player_state,
        make_net_shot_fired, meters_to_mm, mm_to_meters, BatterySyncPacket, ClientPacket,
        DamageEventPacket, FireCmd, InputCmd, LocalPlayerEnergyPacket, MeleeCmd, NetBatteryState,
        ServerPacket, ShotResultPacket, SnapshotPacket, WelcomePacket, BTN_RELOAD, HIT_ZONE_BODY,
        HIT_ZONE_HEAD, HIT_ZONE_NONE, PKT_BATTERY_SYNC, PKT_LOCAL_PLAYER_ENERGY, PKT_PING,
        PKT_SNAPSHOT, PKT_SNAPSHOT_V2, SHOT_RESOLUTION_BLOCKED_BY_WORLD, SHOT_RESOLUTION_DYNAMIC,
        SHOT_RESOLUTION_MISS, SHOT_RESOLUTION_PLAYER,
    },
    voxel_world::VoxelWorld,
};
const SNAPSHOT_HZ: u16 = SNAPSHOT_HZ_MULTIPLAYER;
const CHUNK_RADIUS_ON_JOIN: i32 = 4;
const SERVER_PING_INTERVAL_TICKS: u32 = SIM_HZ as u32;
const MAX_LAG_COMP_MS: u32 = 250;
const MAX_CLIENT_FIRE_FUTURE_MS: u32 = 50;
const RESPAWN_DELAY_MS: u32 = 3_000;
const NEARBY_PLAYER_RADIUS_M: f32 = 12.0;
const ROLLING_METRIC_SAMPLES: usize = 180;
const PLAYER_OUTBOUND_QUEUE_CAPACITY: usize = 64;
const PLAYER_HANDLE_REUSE_COOLDOWN_TICKS: u32 = SIM_HZ as u32 * 10;
const PLAYER_ROSTER_SYNC_INTERVAL_TICKS: u32 = SIM_HZ as u32 * 2;
const COLD_VEHICLE_REFRESH_TICKS: u32 = SIM_HZ as u32 / 2;
const COLD_DYNAMIC_REFRESH_TICKS: u32 = SIM_HZ as u32;
const HOT_LINEAR_SPEED_THRESHOLD_MPS: f32 = 0.05;
const HOT_ANGULAR_SPEED_THRESHOLD_RADPS: f32 = 0.05;
const HOT_DYNAMIC_NEAR_RADIUS_M: f32 = 12.0;
const MATCH_HEALTH_LOG_INTERVAL_TICKS: u32 = SIM_HZ as u32 * 10;
const STRICT_SNAPSHOT_DATAGRAM_TARGET_BYTES: usize = 1100;
const SNAPSHOT_HEADER_BYTES: usize = 23;
const SNAPSHOT_PLAYER_STATE_BYTES: usize = 29;
const SNAPSHOT_DYNAMIC_BODY_STATE_BYTES: usize = 43;
const SNAPSHOT_VEHICLE_STATE_BYTES: usize = 50;
const STRICT_SNAPSHOT_RESERVED_VEHICLES: usize = 2;
const SNAPSHOT_V2_HEADER_BYTES: usize = 23;
const SNAPSHOT_V2_SELF_PLAYER_BYTES: usize = 12;
const SNAPSHOT_V2_REMOTE_PLAYER_BYTES: usize = 19;
const SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES: usize = 20;
const SNAPSHOT_V2_DYNAMIC_BOX_BYTES: usize = 28;
const SNAPSHOT_V2_VEHICLE_BYTES: usize = 30;

fn rifle_damage(zone: HitZone) -> u8 {
    match zone {
        HitZone::Body => RIFLE_BODY_DAMAGE,
        HitZone::Head => RIFLE_HEAD_DAMAGE,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeathCause {
    HpDamage,
    EnergyDepletion,
    OutOfBounds,
    VehicleCollision,
}

// ── Server stats (broadcast to /ws-stats clients) ────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ClientTransport {
    #[default]
    WebSocket,
    WebTransport,
}

impl ClientTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::WebSocket => "websocket",
            Self::WebTransport => "webtransport",
        }
    }
}

fn parse_respawn_delay_ms(value: Option<&str>) -> u32 {
    value
        .and_then(|raw| raw.parse::<u32>().ok())
        .unwrap_or(RESPAWN_DELAY_MS)
}

fn spawn_protection_ticks() -> u32 {
    SPAWN_PROTECTION_MS
        .saturating_mul(SIM_HZ as u32)
        .saturating_add(999)
        / 1000
}

fn server_build_profile() -> &'static str {
    #[cfg(debug_assertions)]
    {
        "debug"
    }
    #[cfg(not(debug_assertions))]
    {
        "release"
    }
}

#[derive(serde::Serialize, Clone, Default)]
struct SummaryStatsSnapshot {
    avg: f32,
    p95: f32,
    max: f32,
}

#[derive(Default)]
struct RollingSamples {
    values: VecDeque<f32>,
}

impl RollingSamples {
    fn record(&mut self, value: f32) {
        self.values.push_back(value);
        while self.values.len() > ROLLING_METRIC_SAMPLES {
            self.values.pop_front();
        }
    }

    fn snapshot(&self) -> SummaryStatsSnapshot {
        if self.values.is_empty() {
            return SummaryStatsSnapshot::default();
        }

        let mut sorted: Vec<f32> = self.values.iter().copied().collect();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let avg = sorted.iter().sum::<f32>() / sorted.len() as f32;
        let p95_index = ((sorted.len() - 1) as f32 * 0.95).round() as usize;
        SummaryStatsSnapshot {
            avg,
            p95: sorted[p95_index.min(sorted.len() - 1)],
            max: *sorted.last().unwrap_or(&0.0),
        }
    }
}

#[derive(Default)]
struct MatchTimingStats {
    total_ms: RollingSamples,
    player_sim_ms: RollingSamples,
    player_move_math_ms: RollingSamples,
    player_query_ctx_ms: RollingSamples,
    player_kcc_ms: RollingSamples,
    player_kcc_horizontal_ms: RollingSamples,
    player_kcc_support_ms: RollingSamples,
    player_kcc_merged_ms: RollingSamples,
    player_support_probe_ms: RollingSamples,
    player_collider_sync_ms: RollingSamples,
    player_dynamic_contact_query_ms: RollingSamples,
    player_dynamic_interaction_ms: RollingSamples,
    player_dynamic_impulse_apply_ms: RollingSamples,
    player_history_record_ms: RollingSamples,
    vehicle_ms: RollingSamples,
    dynamics_ms: RollingSamples,
    hitscan_ms: RollingSamples,
    snapshot_ms: RollingSamples,
}

#[derive(serde::Serialize, Clone, Default)]
struct MatchTimingSnapshot {
    total_ms: SummaryStatsSnapshot,
    player_sim_ms: SummaryStatsSnapshot,
    player_move_math_ms: SummaryStatsSnapshot,
    player_query_ctx_ms: SummaryStatsSnapshot,
    player_kcc_ms: SummaryStatsSnapshot,
    player_kcc_horizontal_ms: SummaryStatsSnapshot,
    player_kcc_support_ms: SummaryStatsSnapshot,
    player_kcc_merged_ms: SummaryStatsSnapshot,
    player_support_probe_ms: SummaryStatsSnapshot,
    player_collider_sync_ms: SummaryStatsSnapshot,
    player_dynamic_contact_query_ms: SummaryStatsSnapshot,
    player_dynamic_interaction_ms: SummaryStatsSnapshot,
    player_dynamic_impulse_apply_ms: SummaryStatsSnapshot,
    player_history_record_ms: SummaryStatsSnapshot,
    vehicle_ms: SummaryStatsSnapshot,
    dynamics_ms: SummaryStatsSnapshot,
    hitscan_ms: SummaryStatsSnapshot,
    snapshot_ms: SummaryStatsSnapshot,
}

impl MatchTimingStats {
    fn snapshot(&self) -> MatchTimingSnapshot {
        MatchTimingSnapshot {
            total_ms: self.total_ms.snapshot(),
            player_sim_ms: self.player_sim_ms.snapshot(),
            player_move_math_ms: self.player_move_math_ms.snapshot(),
            player_query_ctx_ms: self.player_query_ctx_ms.snapshot(),
            player_kcc_ms: self.player_kcc_ms.snapshot(),
            player_kcc_horizontal_ms: self.player_kcc_horizontal_ms.snapshot(),
            player_kcc_support_ms: self.player_kcc_support_ms.snapshot(),
            player_kcc_merged_ms: self.player_kcc_merged_ms.snapshot(),
            player_support_probe_ms: self.player_support_probe_ms.snapshot(),
            player_collider_sync_ms: self.player_collider_sync_ms.snapshot(),
            player_dynamic_contact_query_ms: self.player_dynamic_contact_query_ms.snapshot(),
            player_dynamic_interaction_ms: self.player_dynamic_interaction_ms.snapshot(),
            player_dynamic_impulse_apply_ms: self.player_dynamic_impulse_apply_ms.snapshot(),
            player_history_record_ms: self.player_history_record_ms.snapshot(),
            vehicle_ms: self.vehicle_ms.snapshot(),
            dynamics_ms: self.dynamics_ms.snapshot(),
            hitscan_ms: self.hitscan_ms.snapshot(),
            snapshot_ms: self.snapshot_ms.snapshot(),
        }
    }
}

#[derive(Default)]
struct MatchSnapshotStats {
    bytes_per_client: RollingSamples,
    bytes_per_tick: RollingSamples,
    players_per_client: RollingSamples,
    dynamic_bodies_per_client: RollingSamples,
    vehicles_per_client: RollingSamples,
    visible_batteries_per_client: RollingSamples,
    dynamic_bodies_considered_per_tick: RollingSamples,
    dynamic_contacts_raw_per_tick: RollingSamples,
    dynamic_contacts_kept_per_tick: RollingSamples,
    dynamic_bodies_pushed_per_tick: RollingSamples,
    dynamic_impulses_applied_per_tick: RollingSamples,
    contacted_dynamic_mass_per_tick: RollingSamples,
    player_kcc_horizontal_calls_per_tick: RollingSamples,
    player_kcc_support_calls_per_tick: RollingSamples,
    player_support_probe_count_per_tick: RollingSamples,
    player_support_probe_hit_count_per_tick: RollingSamples,
    awake_dynamic_bodies_total: RollingSamples,
    awake_dynamic_bodies_near_players: RollingSamples,
    players_in_vehicles: RollingSamples,
    dead_players_skipped: RollingSamples,
}

#[derive(serde::Serialize, Clone, Default)]
struct MatchNetworkSnapshot {
    inbound_bps: u64,
    outbound_bps: u64,
    inbound_packets_per_sec: u64,
    outbound_packets_per_sec: u64,
    total_inbound_bytes: u64,
    total_outbound_bytes: u64,
    total_inbound_packets: u64,
    total_outbound_packets: u64,
    reliable_packets_sent: u64,
    datagram_packets_sent: u64,
    datagram_fallbacks: u64,
    malformed_packets: u64,
    snapshot_reliable_sent: u64,
    snapshot_datagram_sent: u64,
    websocket_snapshot_reliable_sent: u64,
    webtransport_snapshot_reliable_sent: u64,
    webtransport_snapshot_datagram_sent: u64,
    strict_snapshot_drops: u64,
    strict_snapshot_drop_oversize: u64,
    strict_snapshot_drop_connection_closed: u64,
    strict_snapshot_drop_unsupported_peer: u64,
    strict_snapshot_drop_other: u64,
    dropped_outbound_packets: u64,
    dropped_outbound_snapshots: u64,
    snapshot_bytes_per_client: SummaryStatsSnapshot,
    snapshot_bytes_per_tick: SummaryStatsSnapshot,
    snapshot_players_per_client: SummaryStatsSnapshot,
    snapshot_dynamic_bodies_per_client: SummaryStatsSnapshot,
    snapshot_vehicles_per_client: SummaryStatsSnapshot,
    visible_batteries_per_client: SummaryStatsSnapshot,
    local_player_energy_packets_sent: u64,
    local_player_energy_bytes_sent: u64,
    battery_sync_packets_sent: u64,
    battery_sync_bytes_sent: u64,
    dynamic_bodies_considered_per_tick: SummaryStatsSnapshot,
    dynamic_contacts_raw_per_tick: SummaryStatsSnapshot,
    dynamic_contacts_kept_per_tick: SummaryStatsSnapshot,
    dynamic_bodies_pushed_per_tick: SummaryStatsSnapshot,
    dynamic_impulses_applied_per_tick: SummaryStatsSnapshot,
    contacted_dynamic_mass_per_tick: SummaryStatsSnapshot,
    player_kcc_horizontal_calls_per_tick: SummaryStatsSnapshot,
    player_kcc_support_calls_per_tick: SummaryStatsSnapshot,
    player_support_probe_count_per_tick: SummaryStatsSnapshot,
    player_support_probe_hit_count_per_tick: SummaryStatsSnapshot,
    awake_dynamic_bodies_total: SummaryStatsSnapshot,
    awake_dynamic_bodies_near_players: SummaryStatsSnapshot,
    players_in_vehicles: SummaryStatsSnapshot,
    dead_players_skipped: SummaryStatsSnapshot,
}

#[derive(serde::Serialize, Clone, Default)]
struct MatchLoadSnapshot {
    nearby_radius_m: f32,
    avg_nearby_players: f32,
    max_nearby_players: u32,
    websocket_players: usize,
    webtransport_players: usize,
    void_kills: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StrictSnapshotDropCause {
    Oversize,
    ConnectionClosed,
    UnsupportedByPeer,
    Other,
}

#[derive(Default)]
struct MatchIoTelemetry {
    inbound_bytes: std::sync::atomic::AtomicU64,
    outbound_bytes: std::sync::atomic::AtomicU64,
    inbound_packets: std::sync::atomic::AtomicU64,
    outbound_packets: std::sync::atomic::AtomicU64,
    reliable_packets_sent: std::sync::atomic::AtomicU64,
    datagram_packets_sent: std::sync::atomic::AtomicU64,
    datagram_fallbacks: std::sync::atomic::AtomicU64,
    malformed_packets: std::sync::atomic::AtomicU64,
    snapshot_reliable_sent: std::sync::atomic::AtomicU64,
    snapshot_datagram_sent: std::sync::atomic::AtomicU64,
    strict_snapshot_drops: std::sync::atomic::AtomicU64,
    strict_snapshot_drop_oversize: std::sync::atomic::AtomicU64,
    strict_snapshot_drop_connection_closed: std::sync::atomic::AtomicU64,
    strict_snapshot_drop_unsupported_peer: std::sync::atomic::AtomicU64,
    strict_snapshot_drop_other: std::sync::atomic::AtomicU64,
    websocket_snapshot_reliable_sent: std::sync::atomic::AtomicU64,
    webtransport_snapshot_reliable_sent: std::sync::atomic::AtomicU64,
    webtransport_snapshot_datagram_sent: std::sync::atomic::AtomicU64,
    local_player_energy_packets_sent: std::sync::atomic::AtomicU64,
    local_player_energy_bytes_sent: std::sync::atomic::AtomicU64,
    battery_sync_packets_sent: std::sync::atomic::AtomicU64,
    battery_sync_bytes_sent: std::sync::atomic::AtomicU64,
    dropped_outbound_packets: std::sync::atomic::AtomicU64,
    dropped_outbound_snapshots: std::sync::atomic::AtomicU64,
}

impl MatchIoTelemetry {
    fn observe_inbound(&self, bytes: usize) {
        self.inbound_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
        self.inbound_packets.fetch_add(1, Ordering::Relaxed);
    }

    fn observe_outbound_reliable(
        &self,
        bytes: usize,
        transport: ClientTransport,
        is_snapshot: bool,
    ) {
        let bytes = bytes as u64;
        self.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.outbound_packets.fetch_add(1, Ordering::Relaxed);
        self.reliable_packets_sent.fetch_add(1, Ordering::Relaxed);
        if is_snapshot {
            self.snapshot_reliable_sent.fetch_add(1, Ordering::Relaxed);
            match transport {
                ClientTransport::WebSocket => {
                    self.websocket_snapshot_reliable_sent
                        .fetch_add(1, Ordering::Relaxed);
                }
                ClientTransport::WebTransport => {
                    self.webtransport_snapshot_reliable_sent
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    fn observe_outbound_datagram(
        &self,
        bytes: usize,
        transport: ClientTransport,
        is_snapshot: bool,
    ) {
        let bytes = bytes as u64;
        self.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.outbound_packets.fetch_add(1, Ordering::Relaxed);
        self.datagram_packets_sent.fetch_add(1, Ordering::Relaxed);
        if is_snapshot {
            self.snapshot_datagram_sent.fetch_add(1, Ordering::Relaxed);
            if transport == ClientTransport::WebTransport {
                self.webtransport_snapshot_datagram_sent
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn observe_datagram_fallback(&self) {
        self.datagram_fallbacks.fetch_add(1, Ordering::Relaxed);
    }

    fn observe_malformed_packet(&self) {
        self.malformed_packets.fetch_add(1, Ordering::Relaxed);
    }

    fn observe_outbound_drop(&self, is_snapshot: bool) {
        self.dropped_outbound_packets
            .fetch_add(1, Ordering::Relaxed);
        if is_snapshot {
            self.dropped_outbound_snapshots
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    fn observe_strict_snapshot_drop(&self, cause: StrictSnapshotDropCause) {
        self.strict_snapshot_drops.fetch_add(1, Ordering::Relaxed);
        match cause {
            StrictSnapshotDropCause::Oversize => {
                self.strict_snapshot_drop_oversize
                    .fetch_add(1, Ordering::Relaxed);
            }
            StrictSnapshotDropCause::ConnectionClosed => {
                self.strict_snapshot_drop_connection_closed
                    .fetch_add(1, Ordering::Relaxed);
            }
            StrictSnapshotDropCause::UnsupportedByPeer => {
                self.strict_snapshot_drop_unsupported_peer
                    .fetch_add(1, Ordering::Relaxed);
            }
            StrictSnapshotDropCause::Other => {
                self.strict_snapshot_drop_other
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn observe_packet_kind(&self, kind: u8, bytes: usize) {
        let bytes = bytes as u64;
        match kind {
            PKT_LOCAL_PLAYER_ENERGY => {
                self.local_player_energy_packets_sent
                    .fetch_add(1, Ordering::Relaxed);
                self.local_player_energy_bytes_sent
                    .fetch_add(bytes, Ordering::Relaxed);
            }
            PKT_BATTERY_SYNC => {
                self.battery_sync_packets_sent
                    .fetch_add(1, Ordering::Relaxed);
                self.battery_sync_bytes_sent
                    .fetch_add(bytes, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Default)]
struct IoSnapshot {
    inbound_bytes: u64,
    outbound_bytes: u64,
    inbound_packets: u64,
    outbound_packets: u64,
}

#[derive(serde::Serialize, Clone, Default)]
struct PlayerStatsSnapshot {
    id: u32,
    identity: String,
    transport: String,
    one_way_ms: u32,
    pending_inputs: usize,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    hp: u8,
    pos_m: [f32; 3],
    vel_ms: [f32; 3],
    on_ground: bool,
    in_vehicle: bool,
    dead: bool,
    // Server-observed network quality
    input_jitter_ms: f32,
    avg_bundle_size: f32,
    // Client-reported experience metrics (1 Hz)
    correction_m: f32,
    physics_ms: f32,
    has_debug_stats: bool,
}

#[derive(serde::Serialize, Clone, Default)]
struct MatchStatsSnapshot {
    id: String,
    scenario_tag: String,
    server_tick: u32,
    player_count: usize,
    dynamic_body_count: usize,
    vehicle_count: usize,
    battery_count: usize,
    chunk_count: usize,
    load: MatchLoadSnapshot,
    timings: MatchTimingSnapshot,
    network: MatchNetworkSnapshot,
    players: Vec<PlayerStatsSnapshot>,
}

#[derive(serde::Serialize, Clone, Default)]
struct GlobalStatsSnapshot {
    server_build_profile: String,
    sim_hz: u16,
    snapshot_hz: u16,
    matches: Vec<MatchStatsSnapshot>,
}

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct SharedAppState {
    inner: Arc<AppState>,
}

struct AppState {
    matches: AsyncRwLock<HashMap<String, MatchHandle>>,
    next_player_id: AtomicU32,
    verifier: SpacetimeVerifier,
    cert_hash_hex: String,
    wt_base_url: String,
    strict_snapshot_datagrams: bool,
    respawn_delay_ms: u32,
    stats_tx: Arc<tokio::sync::watch::Sender<GlobalStatsSnapshot>>,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
}

#[derive(Clone)]
struct MatchHandle {
    tx: mpsc::UnboundedSender<MatchEvent>,
    telemetry: Arc<MatchIoTelemetry>,
}

struct SpacetimeVerifier {
    http: reqwest::Client,
    base_url: String,
}

#[derive(Debug, serde::Deserialize)]
struct WsQuery {
    identity: String,
    token: String,
}

#[derive(Debug, serde::Deserialize)]
struct SessionConfigQuery {
    match_id: String,
}

#[derive(serde::Serialize)]
struct SessionConfig {
    match_id: String,
    url: String,
    server_certificate_hash_hex: String,
    sim_hz: u16,
    snapshot_hz: u16,
    interpolation_delay_ms: u16,
}

struct PlayerConnection {
    player_id: u32,
    identity: String,
    transport: ClientTransport,
    tx: mpsc::Sender<Vec<u8>>,
}

enum MatchEvent {
    Connect(PlayerConnection),
    Disconnect {
        player_id: u32,
    },
    Packet {
        player_id: u32,
        packet: ClientPacket,
    },
}

struct PlayerRuntime {
    identity: String,
    transport: ClientTransport,
    tx: mpsc::Sender<Vec<u8>>,
    pending_inputs: VecDeque<InputCmd>,
    last_applied_input: InputCmd,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    estimated_one_way_ms: u32,
    pending_server_ping: Option<(u32, Instant)>,
    // Input arrival jitter tracking (server-observed)
    last_bundle_recv: Option<Instant>,
    bundle_intervals_ms: VecDeque<f32>, // last ~60 intervals (~1s)
    bundle_sizes: VecDeque<u32>,        // inputs per bundle
    // Client-reported debug stats (1 Hz)
    client_correction_m: f32,
    client_physics_ms: f32,
    client_debug_seen: bool,
    last_processed_shot_id: Option<u32>,
    next_allowed_fire_ms: u32,
    last_processed_swing_id: Option<u32>,
    next_allowed_melee_ms: u32,
    melee_flag_clear_tick: u32,
    spawn_protection_ends_at_tick: u32,
    respawn_at_ms: Option<u32>,
    visible_dynamic_bodies: HashSet<u32>,
    visible_batteries: HashSet<u32>,
    battery_full_resync_pending: bool,
    last_sent_energy_centi: Option<u32>,
    last_sent_dynamic_body_pose: HashMap<u32, ([f32; 3], [f32; 4])>,
    last_sent_vehicle_tick: HashMap<u32, u32>,
    last_sent_dynamic_tick: HashMap<u32, u32>,
}

#[derive(Clone, Copy)]
struct DynamicBodyMetaRuntime {
    handle: u16,
    shape_type: u8,
    half_extents_m: [f32; 3],
}

enum DynamicBodySelection {
    Sphere(protocol::DynamicSphereStateV2),
    Box(protocol::DynamicBoxStateV2),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutboundDelivery {
    Reliable,
    ReliableFallback,
    Datagram,
    StrictDrop,
}

struct QueuedShot {
    player_id: u32,
    cmd: FireCmd,
}

struct QueuedMelee {
    player_id: u32,
    cmd: MeleeCmd,
}

struct MatchState {
    id: String,
    arena: PhysicsArena,
    world: VoxelWorld,
    history: LagCompHistory,
    players: HashMap<u32, PlayerRuntime>,
    queued_shots: Vec<QueuedShot>,
    queued_melees: Vec<QueuedMelee>,
    server_tick: u32,
    stats_tx: Arc<tokio::sync::watch::Sender<GlobalStatsSnapshot>>,
    io: Arc<MatchIoTelemetry>,
    last_io_snapshot: Option<(Instant, IoSnapshot)>,
    timings: MatchTimingStats,
    snapshot_stats: MatchSnapshotStats,
    void_kills: u64,
    strict_snapshot_datagrams: bool,
    respawn_delay_ms: u32,
    last_logged_datagram_fallbacks: u64,
    last_logged_dropped_outbound_packets: u64,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
    next_player_handle: u16,
    reusable_player_handles: VecDeque<(u32, u8)>,
    free_player_handles: VecDeque<u8>,
    player_handles: HashMap<u32, u8>,
    dynamic_body_handles: HashMap<u32, DynamicBodyMetaRuntime>,
    vehicle_handles: HashMap<u32, u8>,
}

#[tokio::main]
async fn main() -> Result<()> {
    load_repo_env();

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    install_panic_hook();
    #[cfg(debug_assertions)]
    warn!(
        "running a debug server build; authoritative player/KCC performance numbers are not representative, use `cargo run --release -p web-fps-server` for perf validation"
    );

    // Build TLS identity for WebTransport.
    // If WT_CERT_PEM + WT_KEY_PEM are set, load a CA-signed cert (production).
    // Otherwise generate a self-signed cert (dev/local) and expose its hash for
    // the browser's serverCertificateHashes pinning API.
    let (identity, cert_hash_hex) = match (
        std::env::var("WT_CERT_PEM").ok(),
        std::env::var("WT_KEY_PEM").ok(),
    ) {
        (Some(cert_path), Some(key_path)) => {
            let identity = Identity::load_pemfiles(&cert_path, &key_path).await?;
            info!(%cert_path, "WebTransport: loaded CA-signed certificate");
            // Empty hash signals the client to skip certificate pinning
            (identity, String::new())
        }
        _ => {
            let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
            let cert_der = identity.certificate_chain().as_slice()[0].der().to_vec();
            let cert_hash_hex = hex::encode(Sha256::digest(&cert_der));
            info!("WebTransport: using self-signed certificate (dev mode)");
            (identity, cert_hash_hex)
        }
    };

    // Determine WebTransport bind address and public base URL
    let wt_addr: SocketAddr = std::env::var("WT_BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4002".to_string())
        .parse()?;
    let wt_host = std::env::var("WT_HOST").unwrap_or_else(|_| "localhost".to_string());
    let wt_base_url = std::env::var("WT_PUBLIC_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("https://{}:{}", wt_host, wt_addr.port()));
    let strict_snapshot_datagrams = std::env::var("WT_STRICT_SNAPSHOT_DATAGRAMS")
        .ok()
        .map(|value| !matches!(value.as_str(), "0" | "false" | "FALSE" | "no" | "off"))
        .unwrap_or(true);
    let respawn_delay_ms = parse_respawn_delay_ms(
        std::env::var("VIBE_SERVER_RESPAWN_DELAY_MS")
            .ok()
            .as_deref(),
    );

    info!(%wt_base_url, cert_hash = %cert_hash_hex, "WebTransport identity ready");
    info!(
        strict_snapshot_datagrams,
        respawn_delay_ms, "WebTransport snapshot transport policy loaded"
    );

    let (stats_tx, _stats_rx) = tokio::sync::watch::channel(GlobalStatsSnapshot::default());
    let stats_tx = Arc::new(stats_tx);

    let state = SharedAppState {
        inner: Arc::new(AppState {
            matches: AsyncRwLock::new(HashMap::new()),
            next_player_id: AtomicU32::new(1),
            verifier: SpacetimeVerifier {
                http: reqwest::Client::new(),
                base_url: std::env::var("SPACETIMEDB_BASE_URL")
                    .unwrap_or_else(|_| "https://maincloud.spacetimedb.com".to_string()),
            },
            cert_hash_hex,
            wt_base_url,
            strict_snapshot_datagrams,
            respawn_delay_ms,
            stats_tx,
            stats_registry: Arc::new(StdRwLock::new(HashMap::new())),
        }),
    };

    // Start WebTransport server
    let wt_config = ServerConfig::builder()
        .with_bind_address(wt_addr)
        .with_identity(identity)
        .build();
    let wt_endpoint = Endpoint::server(wt_config)?;
    info!(%wt_addr, "WebTransport endpoint listening");

    {
        let app_inner = state.inner.clone();
        tokio::spawn(async move {
            loop {
                let incoming = wt_endpoint.accept().await;
                let app = app_inner.clone();
                tokio::spawn(async move {
                    let request = match incoming.await {
                        Ok(r) => r,
                        Err(err) => {
                            warn!(error = ?err, "WT incoming session failed");
                            return;
                        }
                    };
                    let path = request.path().to_string();
                    let connection = match request.accept().await {
                        Ok(c) => c,
                        Err(err) => {
                            warn!(error = ?err, "WT session accept failed");
                            return;
                        }
                    };
                    if path != "/game" {
                        warn!(%path, "WT session rejected: unknown path");
                        return;
                    }
                    if let Err(err) = handle_wt_session(app, connection).await {
                        error!(error = ?err, "WT session error");
                    }
                });
            }
        });
    }

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/session-config", get(session_config_handler))
        .route("/ws/stats", get(ws_stats_handler))
        .route("/ws/:match_id", get(ws_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4001".to_string())
        .parse()?;
    info!(%addr, "starting web fps server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_repo_env() {
    let repo_env = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env");
    match dotenvy::from_path(&repo_env) {
        Ok(()) => info!(path = %repo_env.display(), "loaded repo .env"),
        Err(err) => warn!(path = %repo_env.display(), error = %err, "failed to load repo .env"),
    }
}

async fn session_config_handler(
    Query(query): Query<SessionConfigQuery>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let config = SessionConfig {
        url: format!("{}/game", state.inner.wt_base_url),
        server_certificate_hash_hex: state.inner.cert_hash_hex.clone(),
        match_id: query.match_id,
        sim_hz: SIM_HZ,
        snapshot_hz: SNAPSHOT_HZ,
        interpolation_delay_ms: (1000 / SNAPSHOT_HZ) * 2,
    };
    axum::Json(config)
}

async fn ws_stats_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let mut stats_rx = state.inner.stats_tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        // Send current state immediately on connect
        let initial = serde_json::to_string(&*stats_rx.borrow()).unwrap_or_default();
        if socket.send(Message::Text(initial.into())).await.is_err() {
            return;
        }

        loop {
            match stats_rx.changed().await {
                Ok(()) => {
                    let json = serde_json::to_string(&*stats_rx.borrow()).unwrap_or_default();
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break, // sender dropped
            }
        }
    })
}

async fn handle_wt_session(app: Arc<AppState>, connection: Connection) -> Result<()> {
    // Accept the client's first bidi stream which carries the framed ClientHello
    let (mut send_stream, mut recv_stream) = connection.accept_bi().await?;

    // Read all bytes from the stream (client closes its write side after sending ClientHello)
    let mut raw = Vec::new();
    recv_stream.read_to_end(&mut raw).await?;

    // Strip 4-byte LE length prefix from frameReliablePacket
    anyhow::ensure!(raw.len() >= 4, "ClientHello too short");
    let payload_len = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    anyhow::ensure!(raw.len() >= 4 + payload_len, "ClientHello truncated");
    let hello = decode_client_hello(&raw[4..4 + payload_len])?;

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), hello.match_id.clone()).await;

    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(PLAYER_OUTBOUND_QUEUE_CAPACITY);

    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: format!("wt-player-{player_id}"),
        transport: ClientTransport::WebTransport,
        tx: out_tx,
    }))?;

    // Writer: prefer datagrams for snapshots/pings; fall back to reliable stream
    // if the datagram is too large for the current QUIC path MTU.
    let conn_write = connection.clone();
    let telemetry = handle.telemetry.clone();
    let strict_snapshot_datagrams = app.strict_snapshot_datagrams;
    let writer = tokio::spawn(async move {
        let mut buf = bytes::BytesMut::with_capacity(4096);
        while let Some(bytes) = out_rx.recv().await {
            if bytes.is_empty() {
                continue;
            }
            let first = bytes[0];
            let datagram_result = if wants_unreliable_delivery(first) {
                Some(conn_write.send_datagram(bytes.as_slice()))
            } else {
                None
            };
            let delivery = classify_outbound_delivery(
                first,
                strict_snapshot_datagrams,
                datagram_result
                    .as_ref()
                    .is_some_and(|result| result.is_ok()),
            );
            match delivery {
                OutboundDelivery::Datagram => {
                    telemetry.observe_outbound_datagram(
                        bytes.len(),
                        ClientTransport::WebTransport,
                        is_snapshot_packet_kind(first),
                    );
                }
                OutboundDelivery::StrictDrop => {
                    telemetry.observe_strict_snapshot_drop(
                        datagram_result
                            .as_ref()
                            .and_then(|result| result.as_ref().err())
                            .map(strict_snapshot_drop_cause_from_send_error)
                            .unwrap_or(StrictSnapshotDropCause::Other),
                    );
                    continue;
                }
                OutboundDelivery::ReliableFallback => {
                    telemetry.observe_datagram_fallback();
                    buf.clear();
                    buf.put_u32_le(bytes.len() as u32);
                    buf.put_slice(&bytes);
                    if let Err(err) = send_stream.write_all(&buf).await {
                        warn!(player_id, error = ?err, "WT reliable writer stopped");
                        break;
                    }
                    telemetry.observe_outbound_reliable(
                        bytes.len(),
                        ClientTransport::WebTransport,
                        is_snapshot_packet_kind(first),
                    );
                    telemetry.observe_packet_kind(first, bytes.len());
                }
                OutboundDelivery::Reliable => {
                    buf.clear();
                    buf.put_u32_le(bytes.len() as u32);
                    buf.put_slice(&bytes);
                    if let Err(err) = send_stream.write_all(&buf).await {
                        warn!(player_id, error = ?err, "WT reliable writer stopped");
                        break;
                    }
                    telemetry.observe_outbound_reliable(
                        bytes.len(),
                        ClientTransport::WebTransport,
                        is_snapshot_packet_kind(first),
                    );
                    telemetry.observe_packet_kind(first, bytes.len());
                }
            }
        }
        info!(player_id, "WT writer task exited");
    });

    // Reader: receive client datagrams → route to match
    let tx_to_match = handle.tx.clone();
    let telemetry = handle.telemetry.clone();
    let reader = tokio::spawn(async move {
        loop {
            match connection.receive_datagram().await {
                Ok(datagram) => {
                    let payload = datagram.payload();
                    telemetry.observe_inbound(payload.len());
                    match decode_client_datagram(&payload) {
                        Ok(dgram) => {
                            let packet = client_datagram_to_packet(dgram);
                            if tx_to_match
                                .send(MatchEvent::Packet { player_id, packet })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(err) => {
                            telemetry.observe_malformed_packet();
                            warn!(player_id, error = ?err, "dropping malformed WT datagram")
                        }
                    }
                }
                Err(err) => {
                    warn!(player_id, error = ?err, "WT datagram reader stopped");
                    break;
                }
            }
        }
        let _ = tx_to_match.send(MatchEvent::Disconnect { player_id });
        info!(player_id, "WT reader task exited");
    });

    let _ = tokio::join!(writer, reader);
    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(match_id): Path<String>,
    Query(query): Query<WsQuery>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let app = state.inner.clone();
    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_socket(app, match_id, query, socket).await {
            error!(error = ?err, "socket handler failed");
        }
    })
}

async fn handle_socket(
    app: Arc<AppState>,
    match_id: String,
    query: WsQuery,
    socket: WebSocket,
) -> Result<()> {
    app.verifier.verify(&query.identity, &query.token).await?;

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), match_id.clone()).await;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(PLAYER_OUTBOUND_QUEUE_CAPACITY);

    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: query.identity.clone(),
        transport: ClientTransport::WebSocket,
        tx: out_tx.clone(),
    }))?;

    let telemetry = handle.telemetry.clone();
    let writer = tokio::spawn(async move {
        while let Some(packet) = out_rx.recv().await {
            let packet_len = packet.len();
            let packet_kind = packet.first().copied().unwrap_or_default();
            let is_snapshot = packet.first().copied().is_some_and(is_snapshot_packet_kind);
            if let Err(err) = ws_tx.send(Message::Binary(packet.into())).await {
                warn!(player_id, error = ?err, "websocket writer stopped");
                break;
            }
            telemetry.observe_outbound_reliable(
                packet_len,
                ClientTransport::WebSocket,
                is_snapshot,
            );
            telemetry.observe_packet_kind(packet_kind, packet_len);
        }
        info!(player_id, "websocket writer task exited");
    });

    let tx_to_match = handle.tx.clone();
    let telemetry = handle.telemetry.clone();
    let reader = tokio::spawn(async move {
        while let Some(result) = ws_rx.next().await {
            let message = match result {
                Ok(message) => message,
                Err(err) => {
                    warn!(player_id, error = ?err, "websocket reader stopped");
                    break;
                }
            };
            match message {
                Message::Binary(bytes) => {
                    telemetry.observe_inbound(bytes.len());
                    match decode_client_packet(&bytes) {
                        Ok(packet) => {
                            if tx_to_match
                                .send(MatchEvent::Packet { player_id, packet })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(err) => {
                            telemetry.observe_malformed_packet();
                            warn!(player_id, error = ?err, "dropping malformed packet")
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tx_to_match.send(MatchEvent::Disconnect { player_id });
        info!(player_id, "websocket reader task exited");
    });

    let _ = tokio::join!(writer, reader);
    Ok(())
}

async fn get_or_create_match(app: Arc<AppState>, match_id: String) -> MatchHandle {
    if let Some(existing) = app.matches.read().await.get(&match_id).cloned() {
        if !existing.tx.is_closed() {
            return existing;
        }
        warn!(%match_id, "dropping stale closed match handle from read cache");
    }

    let mut write = app.matches.write().await;
    if let Some(existing) = write.get(&match_id).cloned() {
        if !existing.tx.is_closed() {
            return existing;
        }
        warn!(%match_id, "dropping stale closed match handle before recreating match");
        write.remove(&match_id);
    }

    let (tx, rx) = mpsc::unbounded_channel();
    let telemetry = Arc::new(MatchIoTelemetry::default());
    let handle = MatchHandle {
        tx: tx.clone(),
        telemetry: telemetry.clone(),
    };
    write.insert(match_id.clone(), handle.clone());
    drop(write);
    spawn_match_loop(app, match_id, handle.clone(), rx, telemetry);
    handle
}

async fn run_match_loop(
    match_id: String,
    mut rx: mpsc::UnboundedReceiver<MatchEvent>,
    strict_snapshot_datagrams: bool,
    respawn_delay_ms: u32,
    stats_tx: Arc<tokio::sync::watch::Sender<GlobalStatsSnapshot>>,
    telemetry: Arc<MatchIoTelemetry>,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
) {
    let mut arena = PhysicsArena::new(MoveConfig::default());
    let world = VoxelWorld::new();
    seed_world_for_match(&mut arena, &match_id).expect("world document should instantiate");
    let dynamic_body_handles = arena
        .snapshot_dynamic_bodies()
        .into_iter()
        .enumerate()
        .map(|(index, (id, _, _, half_extents, _, _, shape_type))| {
            (
                id,
                DynamicBodyMetaRuntime {
                    handle: (index as u16).saturating_add(1),
                    shape_type,
                    half_extents_m: half_extents,
                },
            )
        })
        .collect();
    let vehicle_handles = arena
        .snapshot_vehicles()
        .into_iter()
        .enumerate()
        .map(|(index, state)| (state.id, (index as u8).saturating_add(1)))
        .collect();

    let mut state = MatchState {
        id: match_id,
        arena,
        world,
        history: LagCompHistory::new(1000),
        players: HashMap::new(),
        queued_shots: Vec::new(),
        queued_melees: Vec::new(),
        server_tick: 0,
        stats_tx,
        io: telemetry,
        last_io_snapshot: None,
        timings: MatchTimingStats::default(),
        snapshot_stats: MatchSnapshotStats::default(),
        void_kills: 0,
        strict_snapshot_datagrams,
        respawn_delay_ms,
        last_logged_datagram_fallbacks: 0,
        last_logged_dropped_outbound_packets: 0,
        stats_registry,
        next_player_handle: 1,
        reusable_player_handles: VecDeque::new(),
        free_player_handles: VecDeque::new(),
        player_handles: HashMap::new(),
        dynamic_body_handles,
        vehicle_handles,
    };

    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / SIM_HZ as f64));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                state.tick();
            }
            Some(event) = rx.recv() => {
                state.handle_event(event);
            }
            else => break,
        }
    }

    {
        let mut registry = state
            .stats_registry
            .write()
            .expect("stats registry poisoned");
        registry.remove(&state.id);
        let _ = state.stats_tx.send(global_stats_from_registry(&registry));
    }
}

fn spawn_match_loop(
    app: Arc<AppState>,
    match_id: String,
    handle: MatchHandle,
    rx: mpsc::UnboundedReceiver<MatchEvent>,
    telemetry: Arc<MatchIoTelemetry>,
) {
    info!(%match_id, "spawning match loop");
    tokio::spawn(async move {
        let outcome = std::panic::AssertUnwindSafe(run_match_loop(
            match_id.clone(),
            rx,
            app.strict_snapshot_datagrams,
            app.respawn_delay_ms,
            app.stats_tx.clone(),
            telemetry,
            app.stats_registry.clone(),
        ))
        .catch_unwind()
        .await;

        match outcome {
            Ok(()) => {
                warn!(%match_id, "match loop exited");
            }
            Err(payload) => {
                error!(
                    %match_id,
                    panic = %describe_panic_payload(&payload),
                    "match loop panicked"
                );
            }
        }

        let removed = {
            let mut matches = app.matches.write().await;
            matches
                .get(&match_id)
                .map(|existing| existing.tx.same_channel(&handle.tx))
                .unwrap_or(false)
                .then(|| matches.remove(&match_id))
                .flatten()
                .is_some()
        };
        if removed {
            warn!(%match_id, "removed dead match handle after match loop termination");
        }

        {
            let mut registry = app.stats_registry.write().expect("stats registry poisoned");
            registry.remove(&match_id);
            let _ = app.stats_tx.send(global_stats_from_registry(&registry));
        }
    });
}

impl MatchState {
    fn current_server_time_ms(&self) -> u32 {
        self.server_tick * (1000 / SIM_HZ as u32)
    }

    fn resolve_vehicle_runtime_id(&self, wire_vehicle_id: u32) -> Option<u32> {
        if self.arena.vehicles.contains_key(&wire_vehicle_id) {
            return Some(wire_vehicle_id);
        }
        let handle = u8::try_from(wire_vehicle_id).ok()?;
        self.vehicle_handles
            .iter()
            .find_map(|(vehicle_id, vehicle_handle)| {
                (*vehicle_handle == handle).then_some(*vehicle_id)
            })
    }

    fn reclaim_player_handles(&mut self) {
        let now = self.current_server_time_ms();
        while self
            .reusable_player_handles
            .front()
            .is_some_and(|(release_at_ms, _)| *release_at_ms <= now)
        {
            if let Some((_, handle)) = self.reusable_player_handles.pop_front() {
                self.free_player_handles.push_back(handle);
            }
        }
    }

    fn allocate_player_handle(&mut self) -> Option<u8> {
        self.reclaim_player_handles();
        if let Some(handle) = self.free_player_handles.pop_front() {
            return Some(handle);
        }
        if self.next_player_handle > u16::from(u8::MAX) {
            return None;
        }
        let handle = self.next_player_handle as u8;
        self.next_player_handle += 1;
        Some(handle)
    }

    fn release_player_handle(&mut self, player_id: u32) {
        if let Some(handle) = self.player_handles.remove(&player_id) {
            let release_at_ms = self.current_server_time_ms()
                + PLAYER_HANDLE_REUSE_COOLDOWN_TICKS * (1000 / SIM_HZ as u32);
            self.reusable_player_handles
                .push_back((release_at_ms, handle));
        }
    }

    fn build_player_roster_packet(&self) -> protocol::PlayerRosterPacket {
        let mut entries: Vec<_> = self
            .player_handles
            .iter()
            .map(|(player_id, handle)| protocol::PlayerRosterEntry {
                handle: *handle,
                player_id: *player_id,
            })
            .collect();
        entries.sort_by_key(|entry| entry.handle);
        protocol::PlayerRosterPacket { entries }
    }

    fn queue_roster_sync(&self) {
        let packet = encode_server_packet(&ServerPacket::PlayerRoster(
            self.build_player_roster_packet(),
        ));
        for runtime in self.players.values() {
            let _ = try_queue_packet(&runtime.tx, packet.clone(), &self.io);
        }
    }

    fn send_initial_metadata(&self, tx: &mpsc::Sender<Vec<u8>>) {
        let mut entries: Vec<_> = self
            .dynamic_body_handles
            .iter()
            .map(|(body_id, entry)| protocol::DynamicBodyMetaEntry {
                handle: entry.handle,
                body_id: *body_id,
                shape_type: entry.shape_type,
                hx_cm: (entry.half_extents_m[0] * 100.0).round() as u16,
                hy_cm: (entry.half_extents_m[1] * 100.0).round() as u16,
                hz_cm: (entry.half_extents_m[2] * 100.0).round() as u16,
            })
            .collect();
        entries.sort_by_key(|entry| entry.handle);
        let packet = ServerPacket::DynamicBodyMeta(protocol::DynamicBodyMetaPacket { entries });
        let _ = try_queue_packet(tx, encode_server_packet(&packet), &self.io);
        let _ = try_queue_packet(
            tx,
            encode_server_packet(&ServerPacket::PlayerRoster(
                self.build_player_roster_packet(),
            )),
            &self.io,
        );
    }

    fn handle_event(&mut self, event: MatchEvent) {
        match event {
            MatchEvent::Connect(conn) => {
                let Some(player_handle) = self.allocate_player_handle() else {
                    warn!(match_id = %self.id, player_id = conn.player_id, "player handle pool exhausted");
                    return;
                };
                self.arena.spawn_player(conn.player_id);
                let identity = conn.identity.clone();
                let transport = conn.transport.as_str();
                self.player_handles.insert(conn.player_id, player_handle);
                self.players.insert(
                    conn.player_id,
                    PlayerRuntime {
                        identity: conn.identity,
                        transport: conn.transport,
                        tx: conn.tx.clone(),
                        pending_inputs: VecDeque::new(),
                        last_applied_input: InputCmd::default(),
                        last_received_input_seq: None,
                        last_ack_input_seq: 0,
                        estimated_one_way_ms: 40,
                        pending_server_ping: None,
                        last_bundle_recv: None,
                        bundle_intervals_ms: VecDeque::new(),
                        bundle_sizes: VecDeque::new(),
                        client_correction_m: 0.0,
                        client_physics_ms: 0.0,
                        client_debug_seen: false,
                        last_processed_shot_id: None,
                        next_allowed_fire_ms: 0,
                        last_processed_swing_id: None,
                        next_allowed_melee_ms: 0,
                        melee_flag_clear_tick: 0,
                        spawn_protection_ends_at_tick: 0,
                        respawn_at_ms: None,
                        visible_dynamic_bodies: HashSet::new(),
                        visible_batteries: HashSet::new(),
                        battery_full_resync_pending: true,
                        last_sent_energy_centi: None,
                        last_sent_dynamic_body_pose: HashMap::new(),
                        last_sent_vehicle_tick: HashMap::new(),
                        last_sent_dynamic_tick: HashMap::new(),
                    },
                );
                self.activate_spawn_protection(conn.player_id);
                info!(
                    match_id = %self.id,
                    player_id = conn.player_id,
                    %identity,
                    transport,
                    active_players = self.players.len(),
                    "player connected to match"
                );

                let server_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
                let welcome = ServerPacket::Welcome(WelcomePacket {
                    player_id: conn.player_id,
                    sim_hz: SIM_HZ,
                    snapshot_hz: SNAPSHOT_HZ,
                    server_time_us,
                    interpolation_delay_ms: (1000 / SNAPSHOT_HZ) * 2,
                });
                let _ = try_queue_packet(&conn.tx, encode_server_packet(&welcome), &self.io);
                self.send_initial_metadata(&conn.tx);
                self.queue_roster_sync();

                if let Some((pos, _, _, _, _, _)) = self.arena.snapshot_player(conn.player_id) {
                    for key in self.world.visible_chunks_around(pos, CHUNK_RADIUS_ON_JOIN) {
                        if let Some(full) = self.world.chunk_full_packet(key) {
                            let _ = try_queue_packet(
                                &conn.tx,
                                encode_server_packet(&ServerPacket::ChunkFull(full)),
                                &self.io,
                            );
                        }
                    }
                }
            }
            MatchEvent::Disconnect { player_id } => {
                let disconnect_runtime = self.players.get(&player_id).map(|runtime| {
                    (
                        runtime.transport.as_str().to_string(),
                        runtime.pending_inputs.len(),
                        runtime
                            .last_bundle_recv
                            .map(|instant| instant.elapsed().as_secs_f32() * 1000.0),
                        runtime.last_received_input_seq,
                        runtime.last_ack_input_seq,
                    )
                });
                let latest_health = self
                    .stats_registry
                    .read()
                    .ok()
                    .and_then(|registry| registry.get(&self.id).cloned());
                self.players.remove(&player_id);
                self.release_player_handle(player_id);
                self.arena.remove_player(player_id);
                self.history.remove_player(player_id);
                if let Some((
                    transport,
                    pending_inputs,
                    input_silence_ms,
                    last_received_input_seq,
                    last_ack_input_seq,
                )) = disconnect_runtime
                {
                    info!(
                        match_id = %self.id,
                        player_id,
                        transport,
                        pending_inputs,
                        input_silence_ms,
                        last_received_input_seq,
                        last_ack_input_seq,
                        active_players = self.players.len(),
                        tick_ms_p95 = latest_health.as_ref().map(|stats| stats.timings.total_ms.p95),
                        max_pending_inputs = latest_health
                            .as_ref()
                            .map(|stats| stats.players.iter().map(|player| player.pending_inputs).max().unwrap_or(0)),
                        datagram_fallbacks = latest_health.as_ref().map(|stats| stats.network.datagram_fallbacks),
                        strict_snapshot_drops = latest_health.as_ref().map(|stats| stats.network.strict_snapshot_drops),
                        "player disconnected from match"
                    );
                } else {
                    info!(
                        match_id = %self.id,
                        player_id,
                        active_players = self.players.len(),
                        "player disconnected from match"
                    );
                }
                self.queue_roster_sync();
            }
            MatchEvent::Packet { player_id, packet } => {
                let Some(runtime) = self.players.get_mut(&player_id) else {
                    return;
                };
                let is_dead = self
                    .arena
                    .players
                    .get(&player_id)
                    .map(|state| state.dead)
                    .unwrap_or(false);
                match packet {
                    ClientPacket::InputBundle(cmds) => {
                        // Track inter-arrival timing for jitter measurement
                        let now = Instant::now();
                        if let Some(last) = runtime.last_bundle_recv {
                            let interval_ms = last.elapsed().as_secs_f32() * 1000.0;
                            runtime.bundle_intervals_ms.push_back(interval_ms);
                            if runtime.bundle_intervals_ms.len() > 60 {
                                runtime.bundle_intervals_ms.pop_front();
                            }
                        }
                        runtime.last_bundle_recv = Some(now);
                        let bundle_len = cmds.len() as u32;
                        runtime.bundle_sizes.push_back(bundle_len);
                        if runtime.bundle_sizes.len() > 60 {
                            runtime.bundle_sizes.pop_front();
                        }
                        enqueue_inputs(runtime, cmds);
                    }
                    ClientPacket::Fire(cmd) => {
                        if is_dead {
                            return;
                        }
                        runtime.spawn_protection_ends_at_tick = 0;
                        let _ = self.arena.set_player_spawn_protected(player_id, false);
                        self.queued_shots.push(QueuedShot { player_id, cmd });
                    }
                    ClientPacket::Melee(cmd) => {
                        if is_dead {
                            return;
                        }
                        runtime.spawn_protection_ends_at_tick = 0;
                        let _ = self.arena.set_player_spawn_protected(player_id, false);
                        self.queued_melees.push(QueuedMelee { player_id, cmd });
                    }
                    ClientPacket::BlockEdit(cmd) => {
                        if is_dead {
                            return;
                        }
                        match self.world.apply_edit(&mut self.arena, &cmd) {
                            Ok(diff) => {
                                let packet = encode_server_packet(&ServerPacket::ChunkDiff(diff));
                                for player in self.players.values() {
                                    let _ = try_queue_packet(&player.tx, packet.clone(), &self.io);
                                }
                            }
                            Err(err) => {
                                warn!(player_id, error = %err, "block edit rejected");
                                if let Some(full) = self.world.chunk_full_for_coords(cmd.chunk) {
                                    let _ = try_queue_packet(
                                        &runtime.tx,
                                        encode_server_packet(&ServerPacket::ChunkFull(full)),
                                        &self.io,
                                    );
                                }
                            }
                        }
                    }
                    ClientPacket::Ping(value) => {
                        if let Some((nonce, sent_at)) = runtime.pending_server_ping {
                            if nonce == value {
                                let rtt_ms = sent_at.elapsed().as_millis() as u32;
                                runtime.estimated_one_way_ms = (rtt_ms / 2).clamp(10, 250);
                                runtime.pending_server_ping = None;
                                return;
                            }
                        }
                        let _ = try_queue_packet(
                            &runtime.tx,
                            encode_server_packet(&ServerPacket::Pong(value)),
                            &self.io,
                        );
                    }
                    ClientPacket::VehicleEnter(cmd) => {
                        if !is_dead {
                            let _ = runtime;
                            if let Some(vehicle_id) =
                                self.resolve_vehicle_runtime_id(cmd.vehicle_id)
                            {
                                self.arena.enter_vehicle(player_id, vehicle_id);
                                if self.arena.vehicle_of_player.get(&player_id) == Some(&vehicle_id)
                                {
                                    if let Some(runtime) = self.players.get_mut(&player_id) {
                                        clear_runtime_inputs_for_vehicle_entry(runtime);
                                    }
                                }
                            }
                        }
                    }
                    ClientPacket::VehicleExit(_cmd) => {
                        if !is_dead {
                            self.arena.exit_vehicle(player_id);
                        }
                    }
                    ClientPacket::DebugStats {
                        correction_m,
                        physics_ms,
                    } => {
                        runtime.client_correction_m = correction_m;
                        runtime.client_physics_ms = physics_ms;
                        runtime.client_debug_seen = true;
                    }
                }
            }
        }
    }

    fn tick(&mut self) {
        let tick_started = Instant::now();
        self.server_tick += 1;
        self.reclaim_player_handles();
        let dt = 1.0 / SIM_HZ as f32;
        let server_time_ms = self.server_tick * (1000 / SIM_HZ as u32);

        self.process_respawns(server_time_ms);
        self.expire_spawn_protection();

        let ids: Vec<u32> = self.players.keys().copied().collect();
        let player_sim_started = Instant::now();
        let mut player_move_math_ms = 0.0f32;
        let mut player_query_ctx_ms = 0.0f32;
        let mut player_kcc_ms = 0.0f32;
        let mut player_kcc_horizontal_ms = 0.0f32;
        let mut player_kcc_support_ms = 0.0f32;
        let mut player_kcc_merged_ms = 0.0f32;
        let mut player_support_probe_ms = 0.0f32;
        let mut player_collider_sync_ms = 0.0f32;
        let mut player_dynamic_contact_query_ms = 0.0f32;
        let mut player_dynamic_interaction_ms = 0.0f32;
        let mut player_dynamic_impulse_apply_ms = 0.0f32;
        let mut player_history_record_ms = 0.0f32;
        let mut dynamic_bodies_considered_per_tick = 0.0f32;
        let mut dynamic_contacts_raw_per_tick = 0.0f32;
        let mut dynamic_contacts_kept_per_tick = 0.0f32;
        let mut dynamic_bodies_pushed_per_tick = 0.0f32;
        let mut dynamic_impulses_applied_per_tick = 0.0f32;
        let mut contacted_dynamic_mass_per_tick = 0.0f32;
        let mut player_kcc_horizontal_calls_per_tick = 0.0f32;
        let mut player_kcc_support_calls_per_tick = 0.0f32;
        let mut player_support_probe_count_per_tick = 0.0f32;
        let mut player_support_probe_hit_count_per_tick = 0.0f32;
        let mut players_in_vehicles = 0.0f32;
        let mut dead_players_skipped = 0.0f32;
        let mut player_centers = Vec::with_capacity(ids.len());
        let mut on_foot_energy_drains = Vec::with_capacity(ids.len());
        for player_id in ids.iter().copied() {
            if self.arena.vehicle_of_player.contains_key(&player_id) {
                players_in_vehicles += 1.0;
            }
            if self
                .arena
                .players
                .get(&player_id)
                .is_some_and(|state| state.dead)
            {
                dead_players_skipped += 1.0;
            }
            let (previous_input, was_on_ground) = self
                .arena
                .players
                .get(&player_id)
                .map(|state| (state.last_input.clone(), state.on_ground))
                .unwrap_or_default();
            let input = self
                .players
                .get_mut(&player_id)
                .map(|runtime| {
                    // Vehicle controls are continuous state, not precious per-frame
                    // history. Once the backlog grows unhealthy, catch the server up
                    // to the newest useful control state instead of replaying stale
                    // steering/throttle for hundreds of milliseconds.
                    take_input_for_tick_with_vehicle_catchup(
                        runtime,
                        self.arena.vehicle_of_player.contains_key(&player_id),
                    )
                })
                .unwrap_or_default();
            on_foot_energy_drains.push((player_id, previous_input, input.clone(), was_on_ground));
            if let Some(result) = self.arena.simulate_player_tick(player_id, &input, dt) {
                player_move_math_ms += result.timings.move_math_ms;
                player_query_ctx_ms += result.timings.query_ctx_ms;
                player_kcc_ms += result.timings.kcc_query_ms;
                player_kcc_horizontal_ms += result.timings.kcc_horizontal_ms;
                player_kcc_support_ms += result.timings.kcc_support_ms;
                player_kcc_merged_ms += result.timings.kcc_merged_ms;
                player_support_probe_ms += result.timings.support_probe_ms;
                player_collider_sync_ms += result.timings.collider_sync_ms;
                player_dynamic_contact_query_ms += result.timings.dynamic_contact_query_ms;
                player_dynamic_interaction_ms += result.timings.dynamic_interaction_ms;
                player_dynamic_impulse_apply_ms += result.timings.dynamic_impulse_apply_ms;
                dynamic_bodies_considered_per_tick += result.dynamic_stats.considered_count as f32;
                dynamic_contacts_raw_per_tick += result.dynamic_stats.raw_contact_count as f32;
                dynamic_contacts_kept_per_tick += result.dynamic_stats.kept_contact_count as f32;
                dynamic_bodies_pushed_per_tick += result.dynamic_stats.pushed_count as f32;
                dynamic_impulses_applied_per_tick +=
                    result.dynamic_stats.impulses_applied_count as f32;
                contacted_dynamic_mass_per_tick += result.dynamic_stats.contacted_mass;
                if result.timings.kcc_horizontal_ms > 0.0 {
                    player_kcc_horizontal_calls_per_tick += 1.0;
                }
                if result.timings.kcc_support_ms > 0.0 {
                    player_kcc_support_calls_per_tick += 1.0;
                }
                player_support_probe_count_per_tick +=
                    result.dynamic_stats.support_probe_count as f32;
                player_support_probe_hit_count_per_tick +=
                    result.dynamic_stats.support_probe_hit_count as f32;
            }

            if let Some((pos, _vel, _yaw, _pitch, hp, flags)) =
                self.arena.snapshot_player(player_id)
            {
                player_centers.push(pos);
                if hp > 0 && pos[1] < OUT_OF_BOUNDS_Y_M {
                    self.kill_player_with_cause(player_id, server_time_ms, DeathCause::OutOfBounds);
                    self.void_kills += 1;
                }
                let alive = hp > 0 && (flags & 0x4) == 0;
                let center = pos;
                let history_started = Instant::now();
                self.history.record(
                    player_id,
                    HistoricalCapsule {
                        server_tick: self.server_tick,
                        server_time_ms,
                        center,
                        radius: self.arena.config().capsule_radius,
                        half_segment: self.arena.config().capsule_half_segment,
                        alive,
                    },
                );
                player_history_record_ms += history_started.elapsed().as_secs_f32() * 1000.0;
            }
        }
        self.timings
            .player_sim_ms
            .record(player_sim_started.elapsed().as_secs_f32() * 1000.0);
        self.timings.player_move_math_ms.record(player_move_math_ms);
        self.timings.player_query_ctx_ms.record(player_query_ctx_ms);
        self.timings.player_kcc_ms.record(player_kcc_ms);
        self.timings
            .player_kcc_horizontal_ms
            .record(player_kcc_horizontal_ms);
        self.timings
            .player_kcc_support_ms
            .record(player_kcc_support_ms);
        self.timings
            .player_kcc_merged_ms
            .record(player_kcc_merged_ms);
        self.timings
            .player_support_probe_ms
            .record(player_support_probe_ms);
        self.timings
            .player_collider_sync_ms
            .record(player_collider_sync_ms);
        self.timings
            .player_dynamic_contact_query_ms
            .record(player_dynamic_contact_query_ms);
        self.timings
            .player_dynamic_interaction_ms
            .record(player_dynamic_interaction_ms);
        self.timings
            .player_dynamic_impulse_apply_ms
            .record(player_dynamic_impulse_apply_ms);
        self.timings
            .player_history_record_ms
            .record(player_history_record_ms);
        self.snapshot_stats
            .dynamic_bodies_considered_per_tick
            .record(dynamic_bodies_considered_per_tick);
        self.snapshot_stats
            .dynamic_contacts_raw_per_tick
            .record(dynamic_contacts_raw_per_tick);
        self.snapshot_stats
            .dynamic_contacts_kept_per_tick
            .record(dynamic_contacts_kept_per_tick);
        self.snapshot_stats
            .dynamic_bodies_pushed_per_tick
            .record(dynamic_bodies_pushed_per_tick);
        self.snapshot_stats
            .dynamic_impulses_applied_per_tick
            .record(dynamic_impulses_applied_per_tick);
        self.snapshot_stats
            .contacted_dynamic_mass_per_tick
            .record(contacted_dynamic_mass_per_tick);
        self.snapshot_stats
            .player_kcc_horizontal_calls_per_tick
            .record(player_kcc_horizontal_calls_per_tick);
        self.snapshot_stats
            .player_kcc_support_calls_per_tick
            .record(player_kcc_support_calls_per_tick);
        self.snapshot_stats
            .player_support_probe_count_per_tick
            .record(player_support_probe_count_per_tick);
        self.snapshot_stats
            .player_support_probe_hit_count_per_tick
            .record(player_support_probe_hit_count_per_tick);
        self.snapshot_stats
            .players_in_vehicles
            .record(players_in_vehicles);
        self.snapshot_stats
            .dead_players_skipped
            .record(dead_players_skipped);

        let (vehicle_ms, dynamics_ms) = self.arena.step_vehicles_and_dynamics(dt);
        for player_id in self.arena.apply_vehicle_player_collisions() {
            self.kill_player_with_cause(player_id, server_time_ms, DeathCause::VehicleCollision);
        }
        let (awake_dynamic_bodies_total, awake_dynamic_bodies_near_players) =
            awake_dynamic_body_counts(&self.arena, &player_centers);
        self.snapshot_stats
            .awake_dynamic_bodies_total
            .record(awake_dynamic_bodies_total as f32);
        self.snapshot_stats
            .awake_dynamic_bodies_near_players
            .record(awake_dynamic_bodies_near_players as f32);
        for (body_id, pos, quat, half_extents, _vel, _angvel, shape_type) in
            self.arena.snapshot_dynamic_bodies()
        {
            self.history.record_dynamic_body(
                body_id,
                HistoricalDynamicBody {
                    server_tick: self.server_tick,
                    server_time_ms,
                    position: pos,
                    quaternion: quat,
                    half_extents,
                    shape_type,
                    alive: true,
                },
            );
        }
        self.timings.dynamics_ms.record(dynamics_ms);
        self.timings.vehicle_ms.record(vehicle_ms);

        let alive_player_ids: Vec<u32> = self
            .arena
            .players
            .iter()
            .filter_map(|(&player_id, state)| (!state.dead).then_some(player_id))
            .collect();
        for &player_id in &alive_player_ids {
            let gained_energy: f32 = self
                .arena
                .collect_batteries_for_player(player_id)
                .into_iter()
                .map(|(_, energy)| energy)
                .sum();
            if gained_energy > 0.0 {
                if let Some(state) = self.arena.players.get_mut(&player_id) {
                    state.energy += gained_energy;
                }
            }
        }
        for (player_id, previous_input, input, was_on_ground) in on_foot_energy_drains {
            if self.arena.apply_on_foot_energy_drain(
                player_id,
                &previous_input,
                &input,
                was_on_ground,
                dt,
            ) {
                self.kill_player_with_cause(player_id, server_time_ms, DeathCause::EnergyDepletion);
            }
        }
        for player_id in self.arena.apply_vehicle_energy_drain(dt) {
            self.kill_player_with_cause(player_id, server_time_ms, DeathCause::EnergyDepletion);
        }

        let hitscan_started = Instant::now();
        self.process_hitscan(server_time_ms);
        self.timings
            .hitscan_ms
            .record(hitscan_started.elapsed().as_secs_f32() * 1000.0);
        self.process_melee(server_time_ms);

        self.sync_reliable_world_state();

        if self.server_tick % (SIM_HZ as u32 / SNAPSHOT_HZ as u32) == 0 {
            self.broadcast_snapshot();
        }

        if self.server_tick % PLAYER_ROSTER_SYNC_INTERVAL_TICKS == 0 {
            self.queue_roster_sync();
        }

        if self.server_tick % SERVER_PING_INTERVAL_TICKS == 0 {
            self.send_server_latency_pings();
            self.publish_stats();
        }

        self.timings
            .total_ms
            .record(tick_started.elapsed().as_secs_f32() * 1000.0);
    }

    fn send_server_latency_pings(&mut self) {
        for (&player_id, runtime) in &mut self.players {
            let nonce = ((self.server_tick & 0xffff) << 16) | (player_id & 0xffff);
            runtime.pending_server_ping = Some((nonce, Instant::now()));
            let _ = try_queue_packet(
                &runtime.tx,
                encode_server_packet(&ServerPacket::Ping(nonce)),
                &self.io,
            );
        }
    }

    fn publish_stats(&mut self) {
        let websocket_players = self
            .players
            .values()
            .filter(|runtime| runtime.transport == ClientTransport::WebSocket)
            .count();
        let webtransport_players = self.players.len().saturating_sub(websocket_players);

        let mut player_snapshots = Vec::with_capacity(self.players.len());
        let mut positions = Vec::with_capacity(self.players.len());
        for (&player_id, runtime) in &self.players {
            if let Some((pos, vel, _yaw, _pitch, hp, flags)) = self.arena.snapshot_player(player_id)
            {
                positions.push(pos);
                // Jitter = stddev of inter-arrival intervals
                let input_jitter_ms = {
                    let ivs = &runtime.bundle_intervals_ms;
                    if ivs.len() >= 2 {
                        let mean = ivs.iter().sum::<f32>() / ivs.len() as f32;
                        let var =
                            ivs.iter().map(|&x| (x - mean).powi(2)).sum::<f32>() / ivs.len() as f32;
                        var.sqrt()
                    } else {
                        0.0
                    }
                };
                let avg_bundle_size = if runtime.bundle_sizes.is_empty() {
                    0.0
                } else {
                    runtime.bundle_sizes.iter().sum::<u32>() as f32
                        / runtime.bundle_sizes.len() as f32
                };
                player_snapshots.push(PlayerStatsSnapshot {
                    id: player_id,
                    identity: runtime.identity.clone(),
                    transport: runtime.transport.as_str().to_string(),
                    one_way_ms: runtime.estimated_one_way_ms,
                    pending_inputs: runtime.pending_inputs.len(),
                    last_received_input_seq: runtime.last_received_input_seq,
                    last_ack_input_seq: runtime.last_ack_input_seq,
                    hp,
                    pos_m: pos,
                    vel_ms: vel,
                    on_ground: (flags & 0x1) != 0,
                    in_vehicle: (flags & 0x2) != 0,
                    dead: (flags & 0x4) != 0,
                    input_jitter_ms,
                    avg_bundle_size,
                    correction_m: runtime.client_correction_m,
                    physics_ms: runtime.client_physics_ms,
                    has_debug_stats: runtime.client_debug_seen,
                });
            }
        }
        player_snapshots.sort_by_key(|p| p.id);

        let (avg_nearby_players, max_nearby_players) = compute_density_metrics(&positions);
        let now = Instant::now();
        let io_snapshot = IoSnapshot {
            inbound_bytes: self.io.inbound_bytes.load(Ordering::Relaxed),
            outbound_bytes: self.io.outbound_bytes.load(Ordering::Relaxed),
            inbound_packets: self.io.inbound_packets.load(Ordering::Relaxed),
            outbound_packets: self.io.outbound_packets.load(Ordering::Relaxed),
        };
        let (inbound_bps, outbound_bps, inbound_packets_per_sec, outbound_packets_per_sec) =
            if let Some((last_at, last_io)) = self.last_io_snapshot.replace((now, io_snapshot)) {
                let elapsed_s = now
                    .saturating_duration_since(last_at)
                    .as_secs_f64()
                    .max(0.001);
                (
                    ((io_snapshot
                        .inbound_bytes
                        .saturating_sub(last_io.inbound_bytes)) as f64
                        / elapsed_s)
                        .round() as u64,
                    ((io_snapshot
                        .outbound_bytes
                        .saturating_sub(last_io.outbound_bytes)) as f64
                        / elapsed_s)
                        .round() as u64,
                    ((io_snapshot
                        .inbound_packets
                        .saturating_sub(last_io.inbound_packets)) as f64
                        / elapsed_s)
                        .round() as u64,
                    ((io_snapshot
                        .outbound_packets
                        .saturating_sub(last_io.outbound_packets)) as f64
                        / elapsed_s)
                        .round() as u64,
                )
            } else {
                (0, 0, 0, 0)
            };

        let match_stats = MatchStatsSnapshot {
            id: self.id.clone(),
            scenario_tag: self.id.clone(),
            server_tick: self.server_tick,
            player_count: self.players.len(),
            dynamic_body_count: self.arena.dynamic.dynamic_bodies.len(),
            vehicle_count: self.arena.vehicles.len(),
            battery_count: self.arena.batteries.len(),
            chunk_count: self.world.chunks.len(),
            load: MatchLoadSnapshot {
                nearby_radius_m: NEARBY_PLAYER_RADIUS_M,
                avg_nearby_players,
                max_nearby_players,
                websocket_players,
                webtransport_players,
                void_kills: self.void_kills,
            },
            timings: self.timings.snapshot(),
            network: MatchNetworkSnapshot {
                inbound_bps,
                outbound_bps,
                inbound_packets_per_sec,
                outbound_packets_per_sec,
                total_inbound_bytes: io_snapshot.inbound_bytes,
                total_outbound_bytes: io_snapshot.outbound_bytes,
                total_inbound_packets: io_snapshot.inbound_packets,
                total_outbound_packets: io_snapshot.outbound_packets,
                reliable_packets_sent: self.io.reliable_packets_sent.load(Ordering::Relaxed),
                datagram_packets_sent: self.io.datagram_packets_sent.load(Ordering::Relaxed),
                datagram_fallbacks: self.io.datagram_fallbacks.load(Ordering::Relaxed),
                malformed_packets: self.io.malformed_packets.load(Ordering::Relaxed),
                snapshot_reliable_sent: self.io.snapshot_reliable_sent.load(Ordering::Relaxed),
                snapshot_datagram_sent: self.io.snapshot_datagram_sent.load(Ordering::Relaxed),
                websocket_snapshot_reliable_sent: self
                    .io
                    .websocket_snapshot_reliable_sent
                    .load(Ordering::Relaxed),
                webtransport_snapshot_reliable_sent: self
                    .io
                    .webtransport_snapshot_reliable_sent
                    .load(Ordering::Relaxed),
                webtransport_snapshot_datagram_sent: self
                    .io
                    .webtransport_snapshot_datagram_sent
                    .load(Ordering::Relaxed),
                strict_snapshot_drops: self.io.strict_snapshot_drops.load(Ordering::Relaxed),
                strict_snapshot_drop_oversize: self
                    .io
                    .strict_snapshot_drop_oversize
                    .load(Ordering::Relaxed),
                strict_snapshot_drop_connection_closed: self
                    .io
                    .strict_snapshot_drop_connection_closed
                    .load(Ordering::Relaxed),
                strict_snapshot_drop_unsupported_peer: self
                    .io
                    .strict_snapshot_drop_unsupported_peer
                    .load(Ordering::Relaxed),
                strict_snapshot_drop_other: self
                    .io
                    .strict_snapshot_drop_other
                    .load(Ordering::Relaxed),
                dropped_outbound_packets: self.io.dropped_outbound_packets.load(Ordering::Relaxed),
                dropped_outbound_snapshots: self
                    .io
                    .dropped_outbound_snapshots
                    .load(Ordering::Relaxed),
                snapshot_bytes_per_client: self.snapshot_stats.bytes_per_client.snapshot(),
                snapshot_bytes_per_tick: self.snapshot_stats.bytes_per_tick.snapshot(),
                snapshot_players_per_client: self.snapshot_stats.players_per_client.snapshot(),
                snapshot_dynamic_bodies_per_client: self
                    .snapshot_stats
                    .dynamic_bodies_per_client
                    .snapshot(),
                snapshot_vehicles_per_client: self.snapshot_stats.vehicles_per_client.snapshot(),
                visible_batteries_per_client: self
                    .snapshot_stats
                    .visible_batteries_per_client
                    .snapshot(),
                local_player_energy_packets_sent: self
                    .io
                    .local_player_energy_packets_sent
                    .load(Ordering::Relaxed),
                local_player_energy_bytes_sent: self
                    .io
                    .local_player_energy_bytes_sent
                    .load(Ordering::Relaxed),
                battery_sync_packets_sent: self
                    .io
                    .battery_sync_packets_sent
                    .load(Ordering::Relaxed),
                battery_sync_bytes_sent: self.io.battery_sync_bytes_sent.load(Ordering::Relaxed),
                dynamic_bodies_considered_per_tick: self
                    .snapshot_stats
                    .dynamic_bodies_considered_per_tick
                    .snapshot(),
                dynamic_contacts_raw_per_tick: self
                    .snapshot_stats
                    .dynamic_contacts_raw_per_tick
                    .snapshot(),
                dynamic_contacts_kept_per_tick: self
                    .snapshot_stats
                    .dynamic_contacts_kept_per_tick
                    .snapshot(),
                dynamic_bodies_pushed_per_tick: self
                    .snapshot_stats
                    .dynamic_bodies_pushed_per_tick
                    .snapshot(),
                dynamic_impulses_applied_per_tick: self
                    .snapshot_stats
                    .dynamic_impulses_applied_per_tick
                    .snapshot(),
                contacted_dynamic_mass_per_tick: self
                    .snapshot_stats
                    .contacted_dynamic_mass_per_tick
                    .snapshot(),
                player_kcc_horizontal_calls_per_tick: self
                    .snapshot_stats
                    .player_kcc_horizontal_calls_per_tick
                    .snapshot(),
                player_kcc_support_calls_per_tick: self
                    .snapshot_stats
                    .player_kcc_support_calls_per_tick
                    .snapshot(),
                player_support_probe_count_per_tick: self
                    .snapshot_stats
                    .player_support_probe_count_per_tick
                    .snapshot(),
                player_support_probe_hit_count_per_tick: self
                    .snapshot_stats
                    .player_support_probe_hit_count_per_tick
                    .snapshot(),
                awake_dynamic_bodies_total: self
                    .snapshot_stats
                    .awake_dynamic_bodies_total
                    .snapshot(),
                awake_dynamic_bodies_near_players: self
                    .snapshot_stats
                    .awake_dynamic_bodies_near_players
                    .snapshot(),
                players_in_vehicles: self.snapshot_stats.players_in_vehicles.snapshot(),
                dead_players_skipped: self.snapshot_stats.dead_players_skipped.snapshot(),
            },
            players: player_snapshots,
        };

        let global = {
            let mut registry = self
                .stats_registry
                .write()
                .expect("stats registry poisoned");
            registry.insert(self.id.clone(), match_stats.clone());
            global_stats_from_registry(&registry)
        };

        let datagram_fallbacks = self.io.datagram_fallbacks.load(Ordering::Relaxed);
        if datagram_fallbacks > self.last_logged_datagram_fallbacks {
            warn!(
                match_id = %self.id,
                newly_added = datagram_fallbacks - self.last_logged_datagram_fallbacks,
                total = datagram_fallbacks,
                "match observed WebTransport datagram fallback"
            );
            self.last_logged_datagram_fallbacks = datagram_fallbacks;
        }

        let dropped_outbound_packets = self.io.dropped_outbound_packets.load(Ordering::Relaxed);
        let strict_snapshot_drops = self.io.strict_snapshot_drops.load(Ordering::Relaxed);
        if dropped_outbound_packets > self.last_logged_dropped_outbound_packets {
            warn!(
                match_id = %self.id,
                newly_added = dropped_outbound_packets - self.last_logged_dropped_outbound_packets,
                total = dropped_outbound_packets,
                dropped_snapshots = self.io.dropped_outbound_snapshots.load(Ordering::Relaxed),
                "match dropped outbound packets because client queues were full"
            );
            self.last_logged_dropped_outbound_packets = dropped_outbound_packets;
        }

        if !self.players.is_empty() && self.server_tick % MATCH_HEALTH_LOG_INTERVAL_TICKS == 0 {
            info!(
                match_id = %self.id,
                server_tick = self.server_tick,
                players = self.players.len(),
                batteries = match_stats.battery_count,
                websocket_players,
                webtransport_players,
                inbound_bytes_per_sec = inbound_bps,
                outbound_bytes_per_sec = outbound_bps,
                reliable_packets_sent = self.io.reliable_packets_sent.load(Ordering::Relaxed),
                datagram_packets_sent = self.io.datagram_packets_sent.load(Ordering::Relaxed),
                datagram_fallbacks,
                strict_snapshot_drops,
                strict_snapshot_drop_oversize = self.io.strict_snapshot_drop_oversize.load(Ordering::Relaxed),
                strict_snapshot_drop_connection_closed = self.io.strict_snapshot_drop_connection_closed.load(Ordering::Relaxed),
                strict_snapshot_drop_unsupported_peer = self.io.strict_snapshot_drop_unsupported_peer.load(Ordering::Relaxed),
                strict_snapshot_drop_other = self.io.strict_snapshot_drop_other.load(Ordering::Relaxed),
                dropped_outbound_packets,
                snapshot_reliable_sent = self.io.snapshot_reliable_sent.load(Ordering::Relaxed),
                snapshot_datagram_sent = self.io.snapshot_datagram_sent.load(Ordering::Relaxed),
                snapshot_bytes_per_client_avg = match_stats.network.snapshot_bytes_per_client.avg,
                snapshot_bytes_per_client_p95 = match_stats.network.snapshot_bytes_per_client.p95,
                snapshot_bytes_per_client_max = match_stats.network.snapshot_bytes_per_client.max,
                snapshot_bytes_per_tick_avg = match_stats.network.snapshot_bytes_per_tick.avg,
                snapshot_bytes_per_tick_p95 = match_stats.network.snapshot_bytes_per_tick.p95,
                snapshot_bytes_per_tick_max = match_stats.network.snapshot_bytes_per_tick.max,
                snapshot_players_per_client_avg = match_stats.network.snapshot_players_per_client.avg,
                snapshot_players_per_client_p95 = match_stats.network.snapshot_players_per_client.p95,
                snapshot_dynamic_bodies_per_client_avg = match_stats.network.snapshot_dynamic_bodies_per_client.avg,
                snapshot_dynamic_bodies_per_client_p95 = match_stats.network.snapshot_dynamic_bodies_per_client.p95,
                snapshot_vehicles_per_client_avg = match_stats.network.snapshot_vehicles_per_client.avg,
                visible_batteries_per_client_avg = match_stats.network.visible_batteries_per_client.avg,
                visible_batteries_per_client_p95 = match_stats.network.visible_batteries_per_client.p95,
                local_player_energy_packets_sent = match_stats.network.local_player_energy_packets_sent,
                local_player_energy_bytes_sent = match_stats.network.local_player_energy_bytes_sent,
                battery_sync_packets_sent = match_stats.network.battery_sync_packets_sent,
                battery_sync_bytes_sent = match_stats.network.battery_sync_bytes_sent,
                player_sim_ms_avg = match_stats.timings.player_sim_ms.avg,
                player_sim_ms_p95 = match_stats.timings.player_sim_ms.p95,
                move_math_ms_avg = match_stats.timings.player_move_math_ms.avg,
                player_query_ctx_ms_avg = match_stats.timings.player_query_ctx_ms.avg,
                kcc_ms_avg = match_stats.timings.player_kcc_ms.avg,
                player_kcc_horizontal_ms_avg = match_stats.timings.player_kcc_horizontal_ms.avg,
                player_kcc_support_ms_avg = match_stats.timings.player_kcc_support_ms.avg,
                player_kcc_merged_ms_avg = match_stats.timings.player_kcc_merged_ms.avg,
                player_support_probe_ms_avg = match_stats.timings.player_support_probe_ms.avg,
                collider_sync_ms_avg = match_stats.timings.player_collider_sync_ms.avg,
                player_dynamic_contact_query_ms_avg = match_stats.timings.player_dynamic_contact_query_ms.avg,
                player_dynamic_interaction_ms_avg = match_stats.timings.player_dynamic_interaction_ms.avg,
                player_dynamic_impulse_apply_ms_avg = match_stats.timings.player_dynamic_impulse_apply_ms.avg,
                player_history_record_ms_avg = match_stats.timings.player_history_record_ms.avg,
                dynamic_contacts_raw_per_tick_p95 = match_stats.network.dynamic_contacts_raw_per_tick.p95,
                dynamic_contacts_kept_per_tick_p95 = match_stats.network.dynamic_contacts_kept_per_tick.p95,
                dynamic_impulses_applied_per_tick_p95 = match_stats.network.dynamic_impulses_applied_per_tick.p95,
                player_support_probe_count_per_tick_p95 = match_stats.network.player_support_probe_count_per_tick.p95,
                player_support_probe_hit_count_per_tick_p95 = match_stats.network.player_support_probe_hit_count_per_tick.p95,
                awake_dynamic_bodies_total_p95 = match_stats.network.awake_dynamic_bodies_total.p95,
                awake_dynamic_bodies_near_players_p95 = match_stats.network.awake_dynamic_bodies_near_players.p95,
                players_in_vehicles_p95 = match_stats.network.players_in_vehicles.p95,
                dead_players_skipped_p95 = match_stats.network.dead_players_skipped.p95,
                vehicle_ms_avg = match_stats.timings.vehicle_ms.avg,
                dynamics_ms_avg = match_stats.timings.dynamics_ms.avg,
                hitscan_ms_avg = match_stats.timings.hitscan_ms.avg,
                snapshot_ms_avg = match_stats.timings.snapshot_ms.avg,
                snapshot_ms_p95 = match_stats.timings.snapshot_ms.p95,
                snapshot_ms_max = match_stats.timings.snapshot_ms.max,
                tick_ms_avg = match_stats.timings.total_ms.avg,
                tick_ms_p95 = match_stats.timings.total_ms.p95,
                tick_ms_max = match_stats.timings.total_ms.max,
                "match health"
            );
        }

        let _ = self.stats_tx.send(global);
    }

    fn process_respawns(&mut self, server_time_ms: u32) {
        let respawns: Vec<u32> = self
            .players
            .iter()
            .filter_map(|(&player_id, runtime)| {
                runtime
                    .respawn_at_ms
                    .filter(|&deadline| deadline <= server_time_ms)
                    .map(|_| player_id)
            })
            .collect();

        for player_id in respawns {
            if let Some(runtime) = self.players.get_mut(&player_id) {
                runtime.respawn_at_ms = None;
                runtime.pending_inputs.clear();
                runtime.last_applied_input = InputCmd::default();
                runtime.last_ack_input_seq = runtime.last_received_input_seq.unwrap_or(0);
                runtime.visible_batteries.clear();
                runtime.battery_full_resync_pending = true;
                runtime.last_sent_energy_centi = None;
            }
            let _ = self.arena.respawn_player(player_id);
            self.activate_spawn_protection(player_id);
        }
    }

    fn activate_spawn_protection(&mut self, player_id: u32) {
        let until_tick = self.server_tick.saturating_add(spawn_protection_ticks());
        let _ = self.arena.set_player_spawn_protected(player_id, true);
        if let Some(runtime) = self.players.get_mut(&player_id) {
            runtime.spawn_protection_ends_at_tick = until_tick;
        }
    }

    fn clear_spawn_protection(&mut self, player_id: u32) {
        let _ = self.arena.set_player_spawn_protected(player_id, false);
        if let Some(runtime) = self.players.get_mut(&player_id) {
            runtime.spawn_protection_ends_at_tick = 0;
        }
    }

    fn expire_spawn_protection(&mut self) {
        let expired_ids: Vec<u32> = self
            .players
            .iter()
            .filter_map(|(&player_id, runtime)| {
                (runtime.spawn_protection_ends_at_tick != 0
                    && runtime.spawn_protection_ends_at_tick <= self.server_tick)
                    .then_some(player_id)
            })
            .collect();
        for player_id in expired_ids {
            self.clear_spawn_protection(player_id);
        }
    }

    fn kill_player(&mut self, player_id: u32, server_time_ms: u32) {
        self.kill_player_with_cause(player_id, server_time_ms, DeathCause::HpDamage);
    }

    fn kill_player_with_cause(&mut self, player_id: u32, server_time_ms: u32, cause: DeathCause) {
        let battery_drop = if matches!(cause, DeathCause::HpDamage | DeathCause::VehicleCollision) {
            self.arena.players.get(&player_id).and_then(|state| {
                if !state.dead && state.energy > 0.0 {
                    Some((state.position, state.energy))
                } else {
                    None
                }
            })
        } else {
            None
        };

        self.arena.exit_vehicle(player_id);
        self.arena.set_player_dead(player_id, true);

        if let Some((position, energy)) = battery_drop {
            let terrain_y = self.arena.terrain_y_at(position.x, position.z);
            let mut snapped = position;
            snapped.y = terrain_y + DEFAULT_BATTERY_HEIGHT_M as f64 * 0.5 + 0.02;
            let _ = self.arena.spawn_battery(
                snapped,
                energy,
                DEFAULT_BATTERY_RADIUS_M,
                DEFAULT_BATTERY_HEIGHT_M,
            );
        }
        if let Some(state) = self.arena.players.get_mut(&player_id) {
            state.energy = 0.0;
        }
        if let Some(runtime) = self.players.get_mut(&player_id) {
            runtime.respawn_at_ms = Some(server_time_ms.saturating_add(self.respawn_delay_ms));
            runtime.pending_inputs.clear();
            runtime.last_applied_input = InputCmd::default();
            runtime.last_sent_energy_centi = None;
        }
        self.clear_spawn_protection(player_id);
    }

    fn maybe_send_local_player_energy_update(&mut self, player_id: u32) {
        let Some(energy_centi) = self.arena.player_energy(player_id).map(energy_to_centi) else {
            return;
        };
        let Some(runtime) = self.players.get_mut(&player_id) else {
            return;
        };
        if runtime.last_sent_energy_centi == Some(energy_centi) {
            return;
        }

        let packet =
            encode_server_packet(&ServerPacket::LocalPlayerEnergy(LocalPlayerEnergyPacket {
                energy_centi,
            }));
        if try_queue_packet(&runtime.tx, packet, &self.io) {
            runtime.last_sent_energy_centi = Some(energy_centi);
        }
    }

    fn sync_batteries_for_player(
        &mut self,
        player_id: u32,
        battery_snapshots: &[(u32, [f32; 3], NetBatteryState)],
    ) {
        let Some((recipient_pos, _, _, _, _, _)) = self.arena.snapshot_player(player_id) else {
            return;
        };

        let mut current_visible_ids = HashSet::new();
        let mut current_visible_states = Vec::new();
        for (battery_id, position, state) in battery_snapshots.iter().copied() {
            if distance_sq(position, recipient_pos) <= PLAYER_AOI_RADIUS_M * PLAYER_AOI_RADIUS_M {
                current_visible_ids.insert(battery_id);
                current_visible_states.push((battery_id, state));
            }
        }

        self.snapshot_stats
            .visible_batteries_per_client
            .record(current_visible_ids.len() as f32);

        let Some(runtime) = self.players.get_mut(&player_id) else {
            return;
        };

        let full_resync = runtime.battery_full_resync_pending;
        let mut battery_states = Vec::new();
        let mut removed_ids = Vec::new();

        if full_resync {
            battery_states.extend(current_visible_states.iter().map(|(_, state)| *state));
        } else {
            for battery_id in runtime
                .visible_batteries
                .iter()
                .filter(|battery_id| !current_visible_ids.contains(battery_id))
            {
                removed_ids.push(*battery_id);
            }
            for (battery_id, state) in &current_visible_states {
                if !runtime.visible_batteries.contains(battery_id) {
                    battery_states.push(*state);
                }
            }
        }

        if !full_resync && battery_states.is_empty() && removed_ids.is_empty() {
            return;
        }

        let packet = encode_server_packet(&ServerPacket::BatterySync(BatterySyncPacket {
            full_resync,
            battery_states,
            removed_ids,
        }));
        if try_queue_packet(&runtime.tx, packet, &self.io) {
            runtime.visible_batteries = current_visible_ids;
            runtime.battery_full_resync_pending = false;
        }
    }

    fn sync_reliable_world_state(&mut self) {
        let battery_snapshots: Vec<(u32, [f32; 3], NetBatteryState)> = self
            .arena
            .snapshot_batteries()
            .into_iter()
            .map(|(id, position, energy, radius, height)| {
                (
                    id,
                    position,
                    make_net_battery_state(id, position, energy, radius, height),
                )
            })
            .collect();
        let player_ids: Vec<u32> = self.players.keys().copied().collect();

        for &player_id in &player_ids {
            self.maybe_send_local_player_energy_update(player_id);
        }
        for player_id in player_ids {
            self.sync_batteries_for_player(player_id, &battery_snapshots);
        }
    }

    fn compute_fire_server_time_ms(&self, cmd: &FireCmd, server_time_ms: u32) -> u32 {
        let requested_ms = (cmd.client_fire_time_us / 1000).min(u64::from(u32::MAX)) as u32;
        let min_time = server_time_ms.saturating_sub(MAX_LAG_COMP_MS);
        let max_time = server_time_ms.saturating_add(MAX_CLIENT_FIRE_FUTURE_MS);
        requested_ms.clamp(min_time, max_time)
    }

    fn build_shot_result(
        &self,
        shot_id: u32,
        weapon: u8,
        victim_id: Option<u32>,
        hit_zone: u8,
        server_resolution: u8,
        server_dynamic_body_id: u32,
        server_dynamic_hit_toi_m: f32,
        server_dynamic_impulse_mag: f32,
    ) -> ServerPacket {
        ServerPacket::ShotResult(ShotResultPacket {
            shot_id,
            weapon,
            hit_player_id: victim_id.unwrap_or(0),
            confirmed: victim_id.is_some(),
            hit_zone,
            server_resolution,
            server_dynamic_body_id,
            server_dynamic_hit_toi_cm: (server_dynamic_hit_toi_m.max(0.0) * 100.0)
                .round()
                .clamp(0.0, u16::MAX as f32) as u16,
            server_dynamic_impulse_centi: (server_dynamic_impulse_mag.max(0.0) * 100.0)
                .round()
                .clamp(0.0, u16::MAX as f32) as u16,
        })
    }

    fn process_hitscan(&mut self, server_time_ms: u32) {
        let shots = std::mem::take(&mut self.queued_shots);
        for queued in shots {
            let can_process = {
                let Some(runtime) = self.players.get_mut(&queued.player_id) else {
                    continue;
                };
                let duplicate_or_stale = runtime
                    .last_processed_shot_id
                    .map(|last| queued.cmd.shot_id <= last)
                    .unwrap_or(false);
                if duplicate_or_stale || runtime.next_allowed_fire_ms > server_time_ms {
                    false
                } else {
                    runtime.last_processed_shot_id = Some(queued.cmd.shot_id);
                    runtime.next_allowed_fire_ms =
                        server_time_ms.saturating_add(RIFLE_FIRE_INTERVAL_MS);
                    true
                }
            };

            if !can_process {
                continue;
            }

            let Some(shooter_state) = self.arena.players.get(&queued.player_id) else {
                continue;
            };
            if shooter_state.dead || self.arena.vehicle_of_player.contains_key(&queued.player_id) {
                continue;
            }

            let mut shooter_depleted = false;
            if let Some(shooter_state) = self.arena.players.get_mut(&queued.player_id) {
                shooter_state.energy = (shooter_state.energy - RIFLE_SHOT_ENERGY_COST).max(0.0);
                if shooter_state.energy <= 0.0 {
                    shooter_depleted = true;
                }
            }
            if shooter_depleted {
                self.kill_player_with_cause(
                    queued.player_id,
                    server_time_ms,
                    DeathCause::EnergyDepletion,
                );
                continue;
            }

            let origin_time_ms = self.compute_fire_server_time_ms(&queued.cmd, server_time_ms);
            let target_time_ms = origin_time_ms
                .saturating_sub((queued.cmd.client_interp_ms as u32).min(MAX_LAG_COMP_MS));
            let origin = self
                .history
                .sample_player(queued.player_id, origin_time_ms)
                .map(|capsule| {
                    [
                        capsule.center[0],
                        capsule.center[1] + PLAYER_EYE_HEIGHT_M,
                        capsule.center[2],
                    ]
                })
                .or_else(|| {
                    self.arena
                        .snapshot_player(queued.player_id)
                        .map(|(pos, _, _, _, _, _)| [pos[0], pos[1] + PLAYER_EYE_HEIGHT_M, pos[2]])
                });
            let Some(origin) = origin else {
                continue;
            };

            let world_toi = self.arena.cast_static_world_ray(
                origin,
                queued.cmd.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(queued.player_id),
            );
            let dynamic_hit = self.arena.cast_dynamic_body_ray(
                origin,
                queued.cmd.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(queued.player_id),
            );
            let blocker_toi = match (world_toi, dynamic_hit.map(|(_, toi, _)| toi)) {
                (Some(world), Some(dynamic)) => Some(world.min(dynamic)),
                (Some(world), None) => Some(world),
                (None, Some(dynamic)) => Some(dynamic),
                (None, None) => None,
            };

            let player_hit = self.history.resolve_hitscan(
                queued.player_id,
                origin,
                queued.cmd.dir,
                target_time_ms,
                blocker_toi,
            );

            // Pre-compute the authoritative trace endpoint + classification for the
            // shot-fired broadcast. This is used purely for visual trace rendering
            // on all clients, independent of the ShotResult payload sent only to
            // the shooter (which retains its original semantics).
            let (shot_fired_end, shot_fired_kind, shot_fired_zone): ([f32; 3], u8, u8) = {
                let project = |toi: f32| -> [f32; 3] {
                    [
                        origin[0] + queued.cmd.dir[0] * toi,
                        origin[1] + queued.cmd.dir[1] * toi,
                        origin[2] + queued.cmd.dir[2] * toi,
                    ]
                };
                if let Some(hit) = player_hit.as_ref() {
                    let zone_code = match hit.zone {
                        HitZone::Body => HIT_ZONE_BODY,
                        HitZone::Head => HIT_ZONE_HEAD,
                    };
                    (project(hit.distance), SHOT_RESOLUTION_PLAYER, zone_code)
                } else {
                    let dynamic_toi_only = dynamic_hit.map(|(_, toi, _)| toi);
                    match (world_toi, dynamic_toi_only) {
                        (Some(w), Some(d)) if w < d => {
                            (project(w), SHOT_RESOLUTION_BLOCKED_BY_WORLD, HIT_ZONE_NONE)
                        }
                        (_, Some(d)) => (project(d), SHOT_RESOLUTION_DYNAMIC, HIT_ZONE_NONE),
                        (Some(w), None) => {
                            (project(w), SHOT_RESOLUTION_BLOCKED_BY_WORLD, HIT_ZONE_NONE)
                        }
                        (None, None) => (
                            project(HITSCAN_MAX_DISTANCE_M),
                            SHOT_RESOLUTION_MISS,
                            HIT_ZONE_NONE,
                        ),
                    }
                }
            };

            let result = if let Some(hit) = player_hit {
                let prev_hp = self
                    .arena
                    .players
                    .get(&hit.victim_id)
                    .map(|s| s.hp)
                    .unwrap_or(0);
                let damage_outcome = self
                    .arena
                    .apply_player_damage(hit.victim_id, rifle_damage(hit.zone));
                let new_hp = self
                    .arena
                    .players
                    .get(&hit.victim_id)
                    .map(|s| s.hp)
                    .unwrap_or(0);
                let applied_damage = prev_hp.saturating_sub(new_hp);
                if matches!(
                    damage_outcome,
                    PlayerDamageOutcome::Damaged | PlayerDamageOutcome::Killed
                ) {
                    self.stagger_melee_after_damage(hit.victim_id, server_time_ms);
                }
                if matches!(damage_outcome, PlayerDamageOutcome::Killed) {
                    self.kill_player(hit.victim_id, server_time_ms);
                }
                let hit_zone_byte = match hit.zone {
                    HitZone::Body => HIT_ZONE_BODY,
                    HitZone::Head => HIT_ZONE_HEAD,
                };
                if applied_damage > 0 {
                    if let Some(victim_conn) = self.players.get(&hit.victim_id) {
                        let attacker_pos = self
                            .arena
                            .snapshot_player(queued.player_id)
                            .map(|(pos, _, _, _, _, _)| pos)
                            .unwrap_or([origin[0], origin[1] - PLAYER_EYE_HEIGHT_M, origin[2]]);
                        let damage_packet = ServerPacket::DamageEvent(DamageEventPacket {
                            attacker_player_id: queued.player_id,
                            damage_amount: applied_damage,
                            hit_zone: hit_zone_byte,
                            attacker_px_mm: meters_to_mm(attacker_pos[0]),
                            attacker_py_mm: meters_to_mm(attacker_pos[1]),
                            attacker_pz_mm: meters_to_mm(attacker_pos[2]),
                            server_time_ms,
                        });
                        let _ = try_queue_packet(
                            &victim_conn.tx,
                            encode_server_packet(&damage_packet),
                            &self.io,
                        );
                    }
                }
                self.build_shot_result(
                    queued.cmd.shot_id,
                    queued.cmd.weapon,
                    Some(hit.victim_id),
                    hit_zone_byte,
                    SHOT_RESOLUTION_PLAYER,
                    0,
                    0.0,
                    0.0,
                )
            } else if let Some((dynamic_body_id, dynamic_toi, normal)) = dynamic_hit {
                if world_toi.map(|world| world < dynamic_toi).unwrap_or(false) {
                    self.build_shot_result(
                        queued.cmd.shot_id,
                        queued.cmd.weapon,
                        None,
                        HIT_ZONE_NONE,
                        SHOT_RESOLUTION_BLOCKED_BY_WORLD,
                        dynamic_body_id,
                        dynamic_toi,
                        0.0,
                    )
                } else {
                    let impact_point = [
                        origin[0] + queued.cmd.dir[0] * dynamic_toi,
                        origin[1] + queued.cmd.dir[1] * dynamic_toi,
                        origin[2] + queued.cmd.dir[2] * dynamic_toi,
                    ];
                    let impulse = [
                        queued.cmd.dir[0] * DYNAMIC_BODY_IMPULSE + normal[0] * 0.5,
                        queued.cmd.dir[1] * DYNAMIC_BODY_IMPULSE + normal[1] * 0.5,
                        queued.cmd.dir[2] * DYNAMIC_BODY_IMPULSE + normal[2] * 0.5,
                    ];
                    let impulse_mag = (impulse[0] * impulse[0]
                        + impulse[1] * impulse[1]
                        + impulse[2] * impulse[2])
                        .sqrt();
                    let _ = self.arena.apply_dynamic_body_impulse(
                        dynamic_body_id,
                        impulse,
                        impact_point,
                    );
                    self.build_shot_result(
                        queued.cmd.shot_id,
                        queued.cmd.weapon,
                        None,
                        HIT_ZONE_NONE,
                        SHOT_RESOLUTION_DYNAMIC,
                        dynamic_body_id,
                        dynamic_toi,
                        impulse_mag,
                    )
                }
            } else {
                self.build_shot_result(
                    queued.cmd.shot_id,
                    queued.cmd.weapon,
                    None,
                    HIT_ZONE_NONE,
                    SHOT_RESOLUTION_MISS,
                    0,
                    0.0,
                    0.0,
                )
            };

            if let Some(shooter) = self.players.get(&queued.player_id) {
                let _ = try_queue_packet(&shooter.tx, encode_server_packet(&result), &self.io);
            }

            // Broadcast the shot-fired trace to every connected player so remote
            // observers see the bullet. Stamped with the current server tick so
            // clients can suppress packets whose render window has already expired.
            let server_fire_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
            let shot_fired = ServerPacket::ShotFired(make_net_shot_fired(
                queued.player_id,
                queued.cmd.shot_id,
                queued.cmd.weapon,
                shot_fired_kind,
                shot_fired_zone,
                server_fire_time_us,
                origin,
                shot_fired_end,
            ));
            let encoded = encode_server_packet(&shot_fired);
            for player in self.players.values() {
                let _ = try_queue_packet(&player.tx, encoded.clone(), &self.io);
            }
        }
    }

    /// Block the victim from swinging melee for a short window after taking damage
    /// (from any source — melee or hitscan). Keeps the later of the existing cooldown
    /// or the stagger window.
    fn stagger_melee_after_damage(&mut self, victim_id: u32, server_time_ms: u32) {
        if let Some(runtime) = self.players.get_mut(&victim_id) {
            let until = server_time_ms.saturating_add(MELEE_HIT_RECOVERY_MS);
            if runtime.next_allowed_melee_ms < until {
                runtime.next_allowed_melee_ms = until;
            }
        }
    }

    // TODO: lag-compensate melee
    fn process_melee(&mut self, server_time_ms: u32) {
        let swings = std::mem::take(&mut self.queued_melees);
        for queued in swings {
            let can_process = {
                let Some(runtime) = self.players.get_mut(&queued.player_id) else {
                    continue;
                };
                let duplicate = runtime
                    .last_processed_swing_id
                    .map(|prev| prev == queued.cmd.swing_id)
                    .unwrap_or(false);
                if duplicate || runtime.next_allowed_melee_ms > server_time_ms {
                    false
                } else {
                    runtime.last_processed_swing_id = Some(queued.cmd.swing_id);
                    runtime.next_allowed_melee_ms =
                        server_time_ms.saturating_add(MELEE_COOLDOWN_MS);
                    true
                }
            };

            if !can_process {
                continue;
            }

            if self.arena.vehicle_of_player.contains_key(&queued.player_id) {
                continue;
            }
            let Some((attacker_pos, _, _, _, attacker_hp, attacker_flags)) =
                self.arena.snapshot_player(queued.player_id)
            else {
                continue;
            };
            if attacker_hp == 0 || (attacker_flags & vibe_land_shared::constants::FLAG_DEAD) != 0 {
                continue;
            }

            let mut depleted = false;
            if let Some(attacker_state) = self.arena.players.get_mut(&queued.player_id) {
                attacker_state.energy = (attacker_state.energy - MELEE_ENERGY_COST).max(0.0);
                if attacker_state.energy <= 0.0 {
                    depleted = true;
                }
            }
            if depleted {
                self.kill_player_with_cause(
                    queued.player_id,
                    server_time_ms,
                    DeathCause::EnergyDepletion,
                );
                continue;
            }

            let eye = [
                attacker_pos[0],
                attacker_pos[1] + PLAYER_EYE_HEIGHT_M,
                attacker_pos[2],
            ];
            let cos_p = queued.cmd.pitch.cos();
            let aim = [
                queued.cmd.yaw.sin() * cos_p,
                queued.cmd.pitch.sin(),
                queued.cmd.yaw.cos() * cos_p,
            ];
            let aim_xz_len = (aim[0] * aim[0] + aim[2] * aim[2]).sqrt();
            if aim_xz_len > 1e-4 {
                let aim_xz = [aim[0] / aim_xz_len, aim[2] / aim_xz_len];
                let capsule_radius = self.arena.config().capsule_radius;
                let max_reach = MELEE_RANGE_M + capsule_radius;
                let max_reach_sq = max_reach * max_reach;

                let mut best: Option<(u32, f32)> = None;
                let victim_ids: Vec<u32> = self
                    .arena
                    .players
                    .keys()
                    .copied()
                    .filter(|id| *id != queued.player_id)
                    .collect();
                for victim_id in victim_ids {
                    if self.arena.vehicle_of_player.contains_key(&victim_id) {
                        continue;
                    }
                    let Some((victim_pos, _, _, _, victim_hp, victim_flags)) =
                        self.arena.snapshot_player(victim_id)
                    else {
                        continue;
                    };
                    if victim_hp == 0
                        || (victim_flags & vibe_land_shared::constants::FLAG_DEAD) != 0
                    {
                        continue;
                    }
                    let dx = victim_pos[0] - eye[0];
                    let dy = victim_pos[1] - attacker_pos[1];
                    let dz = victim_pos[2] - eye[2];
                    let dist_sq = dx * dx + dy * dy + dz * dz;
                    if dist_sq > max_reach_sq {
                        continue;
                    }
                    let planar_len = (dx * dx + dz * dz).sqrt();
                    if planar_len > 1e-4 {
                        let to_victim_xz = [dx / planar_len, dz / planar_len];
                        let dot = aim_xz[0] * to_victim_xz[0] + aim_xz[1] * to_victim_xz[1];
                        if dot < MELEE_HALF_CONE_COS {
                            continue;
                        }
                    }
                    let dist = dist_sq.sqrt();
                    if best.map(|(_, d)| dist < d).unwrap_or(true) {
                        best = Some((victim_id, dist));
                    }
                }

                if let Some((victim_id, _)) = best {
                    let prev_hp = self
                        .arena
                        .players
                        .get(&victim_id)
                        .map(|s| s.hp)
                        .unwrap_or(0);
                    let damage_outcome = self.arena.apply_player_damage(victim_id, MELEE_DAMAGE);
                    let new_hp = self
                        .arena
                        .players
                        .get(&victim_id)
                        .map(|s| s.hp)
                        .unwrap_or(0);
                    let applied_damage = prev_hp.saturating_sub(new_hp);
                    if matches!(
                        damage_outcome,
                        PlayerDamageOutcome::Damaged | PlayerDamageOutcome::Killed
                    ) {
                        self.stagger_melee_after_damage(victim_id, server_time_ms);
                    }
                    if matches!(damage_outcome, PlayerDamageOutcome::Killed) {
                        self.kill_player(victim_id, server_time_ms);
                    }
                    if applied_damage > 0 {
                        if let Some(victim_conn) = self.players.get(&victim_id) {
                            let damage_packet = ServerPacket::DamageEvent(DamageEventPacket {
                                attacker_player_id: queued.player_id,
                                damage_amount: applied_damage,
                                hit_zone: HIT_ZONE_BODY,
                                attacker_px_mm: meters_to_mm(attacker_pos[0]),
                                attacker_py_mm: meters_to_mm(attacker_pos[1]),
                                attacker_pz_mm: meters_to_mm(attacker_pos[2]),
                                server_time_ms,
                            });
                            let _ = try_queue_packet(
                                &victim_conn.tx,
                                encode_server_packet(&damage_packet),
                                &self.io,
                            );
                        }
                    }
                }
            }

            if let Some(runtime) = self.players.get_mut(&queued.player_id) {
                runtime.melee_flag_clear_tick = self.server_tick + MELEE_FLAG_DURATION_TICKS;
            }
        }
    }

    fn broadcast_snapshot(&mut self) {
        let snapshot_started = Instant::now();
        let server_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
        let mut player_states = Vec::with_capacity(self.players.len());
        for &player_id in self.players.keys() {
            if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(player_id) {
                let energy = self.arena.player_energy(player_id).unwrap_or(0.0);
                let meleeing = self
                    .players
                    .get(&player_id)
                    .map(|runtime| self.server_tick < runtime.melee_flag_clear_tick)
                    .unwrap_or(false);
                let flags = if meleeing {
                    flags | FLAG_MELEEING
                } else {
                    flags
                };
                player_states.push((
                    player_id,
                    pos,
                    make_net_player_state(player_id, pos, vel, yaw, pitch, hp, flags, energy),
                ));
            }
        }

        let dynamic_body_states: Vec<_> = self
            .arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(|(id, pos, quat, he, vel, angvel, shape_type)| {
                (
                    id,
                    pos,
                    quat,
                    make_net_dynamic_body_state(id, pos, quat, he, vel, angvel, shape_type),
                )
            })
            .collect();

        let vehicle_states: Vec<_> = self
            .arena
            .snapshot_vehicles()
            .into_iter()
            .map(|state| {
                (
                    state.id,
                    [
                        mm_to_meters(state.px_mm),
                        mm_to_meters(state.py_mm),
                        mm_to_meters(state.pz_mm),
                    ],
                    state,
                )
            })
            .collect();

        let recipient_ids: Vec<u32> = self.players.keys().copied().collect();

        let mut snapshot_bytes_this_tick = 0usize;
        for recipient_id in recipient_ids {
            let Some((_, recipient_pos, local_player_state)) = player_states
                .iter()
                .find(|(player_id, _, _)| *player_id == recipient_id)
            else {
                continue;
            };
            let Some(runtime) = self.players.get_mut(&recipient_id) else {
                continue;
            };
            let tx = runtime.tx.clone();
            let ack_input_seq = runtime.last_ack_input_seq;

            if !self.strict_snapshot_datagrams {
                let mut filtered_players: Vec<_> = player_states
                    .iter()
                    .filter(|(player_id, pos, _)| {
                        *player_id == recipient_id
                            || distance_sq(*pos, *recipient_pos)
                                <= PLAYER_AOI_RADIUS_M * PLAYER_AOI_RADIUS_M
                    })
                    .collect();
                filtered_players.sort_by(|a, b| {
                    let a_self = a.0 == recipient_id;
                    let b_self = b.0 == recipient_id;
                    b_self.cmp(&a_self).then_with(|| {
                        distance_sq(a.1, *recipient_pos)
                            .total_cmp(&distance_sq(b.1, *recipient_pos))
                    })
                });

                let mut filtered_dynamic_candidates: Vec<_> = dynamic_body_states
                    .iter()
                    .filter(|(body_id, pos, _, _)| {
                        dynamic_body_within_aoi(
                            runtime.visible_dynamic_bodies.contains(body_id),
                            *pos,
                            *recipient_pos,
                        )
                    })
                    .collect();
                filtered_dynamic_candidates.sort_by(|a, b| {
                    distance_sq(a.1, *recipient_pos).total_cmp(&distance_sq(b.1, *recipient_pos))
                });

                let mut filtered_vehicle_candidates: Vec<_> = vehicle_states
                    .iter()
                    .filter(|(_, pos, state)| {
                        state.driver_id == recipient_id
                            || distance_sq(*pos, *recipient_pos)
                                <= VEHICLE_AOI_RADIUS_M * VEHICLE_AOI_RADIUS_M
                    })
                    .collect();
                filtered_vehicle_candidates.sort_by(|a, b| {
                    let a_local = a.2.driver_id == recipient_id;
                    let b_local = b.2.driver_id == recipient_id;
                    b_local.cmp(&a_local).then_with(|| {
                        distance_sq(a.1, *recipient_pos)
                            .total_cmp(&distance_sq(b.1, *recipient_pos))
                    })
                });

                let mut filtered_dynamic_bodies = Vec::new();
                let mut next_visible_dynamic_bodies = HashSet::new();
                let mut next_sent_dynamic_body_pose = HashMap::new();
                for (body_id, pos, quat, state) in filtered_dynamic_candidates {
                    next_visible_dynamic_bodies.insert(*body_id);
                    filtered_dynamic_bodies.push(*state);
                    next_sent_dynamic_body_pose.insert(*body_id, (*pos, *quat));
                }
                runtime.visible_dynamic_bodies = next_visible_dynamic_bodies;
                runtime.last_sent_dynamic_body_pose = next_sent_dynamic_body_pose;

                let filtered_vehicles = filtered_vehicle_candidates
                    .into_iter()
                    .map(|(_, _, state)| *state)
                    .collect();

                let packet = ServerPacket::Snapshot(SnapshotPacket {
                    server_time_us,
                    server_tick: self.server_tick,
                    ack_input_seq,
                    player_states: filtered_players
                        .into_iter()
                        .map(|(_, _, state)| *state)
                        .collect(),
                    projectile_states: Vec::new(),
                    dynamic_body_states: filtered_dynamic_bodies,
                    vehicle_states: filtered_vehicles,
                });
                let encoded = encode_server_packet(&packet);
                snapshot_bytes_this_tick += encoded.len();
                self.snapshot_stats
                    .bytes_per_client
                    .record(encoded.len() as f32);
                self.snapshot_stats
                    .players_per_client
                    .record(packet_player_count(&packet) as f32);
                self.snapshot_stats
                    .dynamic_bodies_per_client
                    .record(packet_dynamic_body_count(&packet) as f32);
                self.snapshot_stats
                    .vehicles_per_client
                    .record(packet_vehicle_count(&packet) as f32);
                let _ = try_queue_packet(&tx, encoded, &self.io);
                continue;
            }

            let mut budget_remaining =
                STRICT_SNAPSHOT_DATAGRAM_TARGET_BYTES.saturating_sub(SNAPSHOT_V2_HEADER_BYTES);

            let self_state = protocol::SelfPlayerStateV2 {
                vx_cms: local_player_state.vx_cms,
                vy_cms: local_player_state.vy_cms,
                vz_cms: local_player_state.vz_cms,
                yaw_i16: local_player_state.yaw_i16,
                pitch_i16: local_player_state.pitch_i16,
                hp: local_player_state.hp,
                flags: (local_player_state.flags & 0xff) as u8,
            };
            budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_SELF_PLAYER_BYTES);

            let reserved_vehicle_budget = vehicle_states
                .iter()
                .filter(|(_, _, state)| state.driver_id == recipient_id)
                .take(STRICT_SNAPSHOT_RESERVED_VEHICLES)
                .count()
                .saturating_mul(SNAPSHOT_V2_VEHICLE_BYTES);
            budget_remaining = budget_remaining.saturating_sub(reserved_vehicle_budget);

            let mut remote_player_states = Vec::new();
            for (player_id, pos, state) in player_states.iter().filter(|(player_id, pos, _)| {
                *player_id != recipient_id
                    && distance_sq(*pos, *recipient_pos)
                        <= PLAYER_AOI_RADIUS_M * PLAYER_AOI_RADIUS_M
            }) {
                let Some(handle) = self.player_handles.get(player_id).copied() else {
                    continue;
                };
                let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(*recipient_pos, *pos) else {
                    continue;
                };
                if budget_remaining < SNAPSHOT_V2_REMOTE_PLAYER_BYTES {
                    break;
                }
                remote_player_states.push(protocol::RemotePlayerStateV2 {
                    handle,
                    dx_q2_5mm: dx,
                    dy_q2_5mm: dy,
                    dz_q2_5mm: dz,
                    vx_cms: state.vx_cms,
                    vy_cms: state.vy_cms,
                    vz_cms: state.vz_cms,
                    yaw_i16: state.yaw_i16,
                    pitch_i16: state.pitch_i16,
                    hp: state.hp,
                    flags: (state.flags & 0xff) as u8,
                });
                budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_REMOTE_PLAYER_BYTES);
            }

            let mut selected_vehicle_states = Vec::new();
            let mut reserved_vehicle_ids = HashSet::new();
            for (vehicle_id, pos, state) in vehicle_states
                .iter()
                .filter(|(_, _, state)| state.driver_id == recipient_id)
            {
                let Some(handle) = self.vehicle_handles.get(vehicle_id).copied() else {
                    continue;
                };
                let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(*recipient_pos, *pos) else {
                    continue;
                };
                let driver_handle = self
                    .player_handles
                    .get(&state.driver_id)
                    .copied()
                    .unwrap_or_default();
                selected_vehicle_states.push(protocol::VehicleStateV2 {
                    handle,
                    vehicle_type: state.vehicle_type,
                    driver_handle,
                    flags: state.flags,
                    dx_q2_5mm: dx,
                    dy_q2_5mm: dy,
                    dz_q2_5mm: dz,
                    qx_snorm: state.qx_snorm,
                    qy_snorm: state.qy_snorm,
                    qz_snorm: state.qz_snorm,
                    qw_snorm: state.qw_snorm,
                    vx_cms: state.vx_cms,
                    vy_cms: state.vy_cms,
                    vz_cms: state.vz_cms,
                    wx_mrads: state.wx_mrads,
                    wy_mrads: state.wy_mrads,
                    wz_mrads: state.wz_mrads,
                });
                reserved_vehicle_ids.insert(*vehicle_id);
                runtime
                    .last_sent_vehicle_tick
                    .insert(*vehicle_id, self.server_tick);
            }

            let mut vehicle_hot = Vec::new();
            let mut vehicle_cold = Vec::new();
            for (vehicle_id, pos, state) in vehicle_states.iter().filter(|(_, pos, state)| {
                state.driver_id == recipient_id
                    || distance_sq(*pos, *recipient_pos)
                        <= VEHICLE_AOI_RADIUS_M * VEHICLE_AOI_RADIUS_M
            }) {
                if reserved_vehicle_ids.contains(vehicle_id) {
                    continue;
                }
                let Some(handle) = self.vehicle_handles.get(vehicle_id).copied() else {
                    continue;
                };
                let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(*recipient_pos, *pos) else {
                    continue;
                };
                let driver_handle = self
                    .player_handles
                    .get(&state.driver_id)
                    .copied()
                    .unwrap_or_default();
                let record = protocol::VehicleStateV2 {
                    handle,
                    vehicle_type: state.vehicle_type,
                    driver_handle,
                    flags: state.flags,
                    dx_q2_5mm: dx,
                    dy_q2_5mm: dy,
                    dz_q2_5mm: dz,
                    qx_snorm: state.qx_snorm,
                    qy_snorm: state.qy_snorm,
                    qz_snorm: state.qz_snorm,
                    qw_snorm: state.qw_snorm,
                    vx_cms: state.vx_cms,
                    vy_cms: state.vy_cms,
                    vz_cms: state.vz_cms,
                    wx_mrads: state.wx_mrads,
                    wy_mrads: state.wy_mrads,
                    wz_mrads: state.wz_mrads,
                };
                let hot = state.driver_id == recipient_id
                    || state.driver_id != 0
                    || speed_sq3([
                        cms_to_mps(state.vx_cms),
                        cms_to_mps(state.vy_cms),
                        cms_to_mps(state.vz_cms),
                    ]) > HOT_LINEAR_SPEED_THRESHOLD_MPS * HOT_LINEAR_SPEED_THRESHOLD_MPS
                    || speed_sq3([
                        state.wx_mrads as f32 / 1000.0,
                        state.wy_mrads as f32 / 1000.0,
                        state.wz_mrads as f32 / 1000.0,
                    ]) > HOT_ANGULAR_SPEED_THRESHOLD_RADPS * HOT_ANGULAR_SPEED_THRESHOLD_RADPS
                    || runtime
                        .last_sent_vehicle_tick
                        .get(vehicle_id)
                        .map(|last| {
                            self.server_tick.saturating_sub(*last) >= COLD_VEHICLE_REFRESH_TICKS
                        })
                        .unwrap_or(true);
                if hot {
                    vehicle_hot.push((*vehicle_id, distance_sq(*pos, *recipient_pos), record));
                } else {
                    vehicle_cold.push((*vehicle_id, distance_sq(*pos, *recipient_pos), record));
                }
            }
            vehicle_hot.sort_by(|a, b| a.1.total_cmp(&b.1));
            vehicle_cold.sort_by(|a, b| a.1.total_cmp(&b.1));

            for (vehicle_id, _, record) in vehicle_hot.into_iter().chain(vehicle_cold.into_iter()) {
                if budget_remaining < SNAPSHOT_V2_VEHICLE_BYTES {
                    break;
                }
                runtime
                    .last_sent_vehicle_tick
                    .insert(vehicle_id, self.server_tick);
                selected_vehicle_states.push(record);
                budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_VEHICLE_BYTES);
            }

            let mut all_visible_dynamic_bodies = HashSet::new();
            let mut dynamic_hot = Vec::new();
            let mut dynamic_cold = Vec::new();
            for (body_id, pos, quat, state) in
                dynamic_body_states.iter().filter(|(body_id, pos, _, _)| {
                    let visible = dynamic_body_within_aoi(
                        runtime.visible_dynamic_bodies.contains(body_id),
                        *pos,
                        *recipient_pos,
                    );
                    visible
                })
            {
                all_visible_dynamic_bodies.insert(*body_id);
                let Some(meta) = self.dynamic_body_handles.get(body_id).copied() else {
                    continue;
                };
                let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(*recipient_pos, *pos) else {
                    continue;
                };
                let dist_sq = distance_sq(*pos, *recipient_pos);
                let moving = speed_sq3([
                    cms_to_mps(state.vx_cms),
                    cms_to_mps(state.vy_cms),
                    cms_to_mps(state.vz_cms),
                ]) > HOT_LINEAR_SPEED_THRESHOLD_MPS * HOT_LINEAR_SPEED_THRESHOLD_MPS
                    || speed_sq3([
                        state.wx_mrads as f32 / 1000.0,
                        state.wy_mrads as f32 / 1000.0,
                        state.wz_mrads as f32 / 1000.0,
                    ]) > HOT_ANGULAR_SPEED_THRESHOLD_RADPS * HOT_ANGULAR_SPEED_THRESHOLD_RADPS;
                let needs_refresh = runtime
                    .last_sent_dynamic_tick
                    .get(body_id)
                    .map(|last| {
                        self.server_tick.saturating_sub(*last) >= COLD_DYNAMIC_REFRESH_TICKS
                    })
                    .unwrap_or(true);

                if meta.shape_type == 1 {
                    let record = protocol::DynamicSphereStateV2 {
                        handle: meta.handle,
                        dx_q2_5mm: dx,
                        dy_q2_5mm: dy,
                        dz_q2_5mm: dz,
                        vx_cms: state.vx_cms,
                        vy_cms: state.vy_cms,
                        vz_cms: state.vz_cms,
                        wx_mrads: state.wx_mrads,
                        wy_mrads: state.wy_mrads,
                        wz_mrads: state.wz_mrads,
                    };
                    if moving
                        || dist_sq <= HOT_DYNAMIC_NEAR_RADIUS_M * HOT_DYNAMIC_NEAR_RADIUS_M
                        || needs_refresh
                    {
                        dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Sphere(record)));
                    } else {
                        dynamic_cold.push((
                            *body_id,
                            dist_sq,
                            DynamicBodySelection::Sphere(record),
                        ));
                    }
                } else {
                    let record = protocol::DynamicBoxStateV2 {
                        handle: meta.handle,
                        dx_q2_5mm: dx,
                        dy_q2_5mm: dy,
                        dz_q2_5mm: dz,
                        qx_snorm: f32_to_snorm16(quat[0]),
                        qy_snorm: f32_to_snorm16(quat[1]),
                        qz_snorm: f32_to_snorm16(quat[2]),
                        qw_snorm: f32_to_snorm16(quat[3]),
                        vx_cms: state.vx_cms,
                        vy_cms: state.vy_cms,
                        vz_cms: state.vz_cms,
                        wx_mrads: state.wx_mrads,
                        wy_mrads: state.wy_mrads,
                        wz_mrads: state.wz_mrads,
                    };
                    if moving
                        || dist_sq <= HOT_DYNAMIC_NEAR_RADIUS_M * HOT_DYNAMIC_NEAR_RADIUS_M
                        || needs_refresh
                    {
                        dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Box(record)));
                    } else {
                        dynamic_cold.push((*body_id, dist_sq, DynamicBodySelection::Box(record)));
                    }
                }
                runtime
                    .last_sent_dynamic_body_pose
                    .insert(*body_id, (*pos, *quat));
            }
            runtime.visible_dynamic_bodies = all_visible_dynamic_bodies;
            dynamic_hot.sort_by(|a, b| a.1.total_cmp(&b.1));
            dynamic_cold.sort_by(|a, b| a.1.total_cmp(&b.1));

            let mut sphere_states = Vec::new();
            let mut box_states = Vec::new();
            for (body_id, _, selection) in dynamic_hot.into_iter().chain(dynamic_cold.into_iter()) {
                let record_size = match &selection {
                    DynamicBodySelection::Sphere(_) => SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES,
                    DynamicBodySelection::Box(_) => SNAPSHOT_V2_DYNAMIC_BOX_BYTES,
                };
                if budget_remaining < record_size {
                    continue;
                }
                match selection {
                    DynamicBodySelection::Sphere(record) => sphere_states.push(record),
                    DynamicBodySelection::Box(record) => box_states.push(record),
                }
                runtime
                    .last_sent_dynamic_tick
                    .insert(body_id, self.server_tick);
                budget_remaining = budget_remaining.saturating_sub(record_size);
            }

            let packet = ServerPacket::SnapshotV2(protocol::SnapshotV2Packet {
                server_tick: self.server_tick,
                ack_input_seq,
                anchor_px_mm: local_player_state.px_mm,
                anchor_py_mm: local_player_state.py_mm,
                anchor_pz_mm: local_player_state.pz_mm,
                self_state,
                remote_players: remote_player_states,
                sphere_states,
                box_states,
                vehicle_states: selected_vehicle_states,
            });
            let encoded = encode_server_packet(&packet);
            snapshot_bytes_this_tick += encoded.len();
            self.snapshot_stats
                .bytes_per_client
                .record(encoded.len() as f32);
            self.snapshot_stats
                .players_per_client
                .record(packet_player_count(&packet) as f32);
            self.snapshot_stats
                .dynamic_bodies_per_client
                .record(packet_dynamic_body_count(&packet) as f32);
            self.snapshot_stats
                .vehicles_per_client
                .record(packet_vehicle_count(&packet) as f32);
            let _ = try_queue_packet(&tx, encoded, &self.io);
        }
        self.snapshot_stats
            .bytes_per_tick
            .record(snapshot_bytes_this_tick as f32);
        self.timings
            .snapshot_ms
            .record(snapshot_started.elapsed().as_secs_f32() * 1000.0);
    }
}

fn take_input_for_tick(runtime: &mut PlayerRuntime) -> InputCmd {
    if let Some(input) = runtime.pending_inputs.pop_front() {
        runtime.last_ack_input_seq = input.seq;
        runtime.last_applied_input = input.clone();
        return input;
    }
    runtime.last_applied_input.clone()
}

fn take_input_for_tick_with_vehicle_catchup(
    runtime: &mut PlayerRuntime,
    collapse_vehicle_backlog: bool,
) -> InputCmd {
    if collapse_vehicle_backlog && runtime.pending_inputs.len() >= VEHICLE_INPUT_CATCHUP_THRESHOLD {
        if let Some(mut newest) = runtime.pending_inputs.pop_back() {
            let skipped_reset = runtime
                .pending_inputs
                .iter()
                .any(|input| input.buttons & BTN_RELOAD != 0);
            runtime.pending_inputs.clear();
            if skipped_reset {
                newest.buttons |= BTN_RELOAD;
            }
            runtime.last_ack_input_seq = newest.seq;
            runtime.last_applied_input = newest.clone();
            return newest;
        }
    }
    take_input_for_tick(runtime)
}

fn clear_runtime_inputs_for_vehicle_entry(runtime: &mut PlayerRuntime) {
    let ack_seq = runtime
        .last_received_input_seq
        .unwrap_or(runtime.last_ack_input_seq);
    runtime.pending_inputs.clear();
    runtime.last_ack_input_seq = ack_seq;
    runtime.last_applied_input = InputCmd {
        seq: ack_seq,
        buttons: 0,
        move_x: 0,
        move_y: 0,
        yaw: runtime.last_applied_input.yaw,
        pitch: runtime.last_applied_input.pitch,
    };
}

fn enqueue_inputs(runtime: &mut PlayerRuntime, cmds: Vec<InputCmd>) {
    for cmd in cmds {
        let is_new = runtime
            .last_received_input_seq
            .map(|last| seq_is_newer(cmd.seq, last))
            .unwrap_or(true);
        if !is_new {
            continue;
        }
        runtime.last_received_input_seq = Some(cmd.seq);
        runtime.pending_inputs.push_back(cmd);
        while runtime.pending_inputs.len() > MAX_PENDING_INPUTS {
            runtime.pending_inputs.pop_front();
        }
    }
}

fn compute_density_metrics(positions: &[[f32; 3]]) -> (f32, u32) {
    if positions.is_empty() {
        return (0.0, 0);
    }

    let radius_sq = NEARBY_PLAYER_RADIUS_M * NEARBY_PLAYER_RADIUS_M;
    let mut total = 0u32;
    let mut max = 0u32;

    for (i, pos) in positions.iter().enumerate() {
        let mut nearby = 0u32;
        for (j, other) in positions.iter().enumerate() {
            if i == j {
                continue;
            }
            let dx = pos[0] - other[0];
            let dy = pos[1] - other[1];
            let dz = pos[2] - other[2];
            if dx * dx + dy * dy + dz * dz <= radius_sq {
                nearby += 1;
            }
        }
        total += nearby;
        max = max.max(nearby);
    }

    (total as f32 / positions.len() as f32, max)
}

fn awake_dynamic_body_counts(arena: &PhysicsArena, player_centers: &[[f32; 3]]) -> (u32, u32) {
    let near_radius_sq = HOT_DYNAMIC_NEAR_RADIUS_M * HOT_DYNAMIC_NEAR_RADIUS_M;
    let mut awake_total = 0u32;
    let mut awake_near_players = 0u32;

    for dynamic_body in arena.dynamic.dynamic_bodies.values() {
        let Some(rb) = arena.dynamic.sim.rigid_bodies.get(dynamic_body.body_handle) else {
            continue;
        };
        if rb.is_sleeping() {
            continue;
        }
        awake_total += 1;

        let pos = rb.translation();
        let body_center = [pos.x, pos.y, pos.z];
        if player_centers
            .iter()
            .any(|player_center| distance_sq(body_center, *player_center) <= near_radius_sq)
        {
            awake_near_players += 1;
        }
    }

    (awake_total, awake_near_players)
}

fn distance_sq(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    dx * dx + dy * dy + dz * dz
}

fn quantize_relative_q2_5mm(value_m: f32) -> Option<i16> {
    let encoded = (value_m / 0.0025).round();
    if !(i16::MIN as f32..=i16::MAX as f32).contains(&encoded) {
        return None;
    }
    Some(encoded as i16)
}

fn quantize_relative_vec_q2_5mm(origin: [f32; 3], target: [f32; 3]) -> Option<(i16, i16, i16)> {
    Some((
        quantize_relative_q2_5mm(target[0] - origin[0])?,
        quantize_relative_q2_5mm(target[1] - origin[1])?,
        quantize_relative_q2_5mm(target[2] - origin[2])?,
    ))
}

fn speed_sq3(v: [f32; 3]) -> f32 {
    v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
}

fn dynamic_body_within_aoi(was_visible: bool, body_pos: [f32; 3], recipient_pos: [f32; 3]) -> bool {
    let dist_sq = distance_sq(body_pos, recipient_pos);
    if was_visible {
        dist_sq <= DYNAMIC_BODY_AOI_EXIT_RADIUS_M * DYNAMIC_BODY_AOI_EXIT_RADIUS_M
    } else {
        dist_sq <= DYNAMIC_BODY_AOI_RADIUS_M * DYNAMIC_BODY_AOI_RADIUS_M
    }
}

fn packet_player_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.player_states.len(),
        ServerPacket::SnapshotV2(snapshot) => 1 + snapshot.remote_players.len(),
        _ => 0,
    }
}

fn packet_dynamic_body_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.dynamic_body_states.len(),
        ServerPacket::SnapshotV2(snapshot) => {
            snapshot.sphere_states.len() + snapshot.box_states.len()
        }
        _ => 0,
    }
}

fn packet_vehicle_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.vehicle_states.len(),
        ServerPacket::SnapshotV2(snapshot) => snapshot.vehicle_states.len(),
        _ => 0,
    }
}

fn is_snapshot_packet_kind(kind: u8) -> bool {
    kind == PKT_SNAPSHOT || kind == PKT_SNAPSHOT_V2
}

fn wants_unreliable_delivery(kind: u8) -> bool {
    is_snapshot_packet_kind(kind) || kind == PKT_PING
}

fn strict_snapshot_drop_cause_from_send_error(err: &SendDatagramError) -> StrictSnapshotDropCause {
    match err {
        SendDatagramError::TooLarge => StrictSnapshotDropCause::Oversize,
        SendDatagramError::NotConnected => StrictSnapshotDropCause::ConnectionClosed,
        SendDatagramError::UnsupportedByPeer => StrictSnapshotDropCause::UnsupportedByPeer,
    }
}

fn classify_outbound_delivery(
    kind: u8,
    strict_snapshot_datagrams: bool,
    datagram_send_ok: bool,
) -> OutboundDelivery {
    if datagram_send_ok {
        return OutboundDelivery::Datagram;
    }
    if is_snapshot_packet_kind(kind) && strict_snapshot_datagrams {
        return OutboundDelivery::StrictDrop;
    }
    if wants_unreliable_delivery(kind) {
        return OutboundDelivery::ReliableFallback;
    }
    OutboundDelivery::Reliable
}

fn try_queue_packet(
    tx: &mpsc::Sender<Vec<u8>>,
    packet: Vec<u8>,
    telemetry: &MatchIoTelemetry,
) -> bool {
    let is_snapshot = packet.first().copied().is_some_and(is_snapshot_packet_kind);
    let is_droppable = is_snapshot || packet.first().copied().is_some_and(|kind| kind == PKT_PING);
    match tx.try_send(packet) {
        Ok(()) => true,
        Err(tokio::sync::mpsc::error::TrySendError::Full(packet)) => {
            if is_droppable {
                telemetry.observe_outbound_drop(is_snapshot);
            } else {
                warn!(
                    packet_kind = packet.first().copied().unwrap_or_default(),
                    "dropping non-droppable outbound packet because client queue is full"
                );
                telemetry.observe_outbound_drop(is_snapshot);
            }
            false
        }
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
    }
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let backtrace = Backtrace::force_capture();
        eprintln!("panic: {panic_info}\n{backtrace}");
        error!(panic = %panic_info, backtrace = %backtrace, "panic hook triggered");
        default_hook(panic_info);
    }));
}

fn describe_panic_payload(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        return (*message).to_string();
    }
    "non-string panic payload".to_string()
}

fn global_stats_from_registry(
    registry: &HashMap<String, MatchStatsSnapshot>,
) -> GlobalStatsSnapshot {
    let mut matches: Vec<_> = registry.values().cloned().collect();
    matches.sort_by(|a, b| a.id.cmp(&b.id));
    GlobalStatsSnapshot {
        server_build_profile: server_build_profile().to_string(),
        sim_hz: SIM_HZ,
        snapshot_hz: SNAPSHOT_HZ,
        matches,
    }
}

use vibe_land_shared::seq::seq_is_newer;

impl SpacetimeVerifier {
    async fn verify(&self, identity: &str, _token: &str) -> Result<()> {
        if std::env::var("SKIP_SPACETIMEDB_VERIFY").is_ok() {
            info!(%identity, "skipping SpacetimeDB verification (MVP mode)");
            return Ok(());
        }
        let url = format!(
            "{}/v1/identity/{identity}/verify",
            self.base_url.trim_end_matches('/')
        );

        let response = self.http.get(url).bearer_auth(_token).send().await?;

        if response.status().is_success() {
            Ok(())
        } else {
            anyhow::bail!("Spacetime identity verify failed: {}", response.status())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_outbound_delivery, clear_runtime_inputs_for_vehicle_entry,
        compute_density_metrics, dynamic_body_within_aoi, enqueue_inputs, is_snapshot_packet_kind,
        parse_respawn_delay_ms, rifle_damage, server_build_profile,
        strict_snapshot_drop_cause_from_send_error, take_input_for_tick,
        take_input_for_tick_with_vehicle_catchup, try_queue_packet, HitZone, InputCmd,
        MatchIoTelemetry, OutboundDelivery, PlayerRuntime, StrictSnapshotDropCause, BTN_RELOAD,
        MAX_PENDING_INPUTS, PKT_PING, PKT_SNAPSHOT, PKT_SNAPSHOT_V2,
        PLAYER_OUTBOUND_QUEUE_CAPACITY, RIFLE_BODY_DAMAGE, RIFLE_HEAD_DAMAGE,
    };
    use std::collections::{HashMap, HashSet, VecDeque};
    use tokio::sync::mpsc;
    use vibe_land_shared::seq::seq_is_newer;
    use wtransport::error::SendDatagramError;

    fn runtime() -> PlayerRuntime {
        let (tx, _rx) = mpsc::channel(PLAYER_OUTBOUND_QUEUE_CAPACITY);
        PlayerRuntime {
            identity: "test-player".to_string(),
            transport: super::ClientTransport::WebSocket,
            tx,
            pending_inputs: VecDeque::new(),
            last_applied_input: InputCmd::default(),
            last_received_input_seq: None,
            last_ack_input_seq: 0,
            estimated_one_way_ms: 40,
            pending_server_ping: None,
            last_bundle_recv: None,
            bundle_intervals_ms: VecDeque::new(),
            bundle_sizes: VecDeque::new(),
            client_correction_m: 0.0,
            client_physics_ms: 0.0,
            client_debug_seen: false,
            last_processed_shot_id: None,
            next_allowed_fire_ms: 0,
            last_processed_swing_id: None,
            next_allowed_melee_ms: 0,
            melee_flag_clear_tick: 0,
            spawn_protection_ends_at_tick: 0,
            respawn_at_ms: None,
            visible_dynamic_bodies: HashSet::new(),
            visible_batteries: HashSet::new(),
            battery_full_resync_pending: true,
            last_sent_energy_centi: None,
            last_sent_dynamic_body_pose: HashMap::new(),
            last_sent_vehicle_tick: HashMap::new(),
            last_sent_dynamic_tick: HashMap::new(),
        }
    }

    fn input(seq: u16) -> InputCmd {
        InputCmd {
            seq,
            buttons: seq,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    #[test]
    fn seq_is_newer_handles_wraparound() {
        assert!(seq_is_newer(2, 0xfffe));
        assert!(!seq_is_newer(0xfffe, 2));
        assert!(!seq_is_newer(0x8000, 0));
    }

    #[test]
    fn enqueue_inputs_rejects_stale_and_duplicate_frames() {
        let mut runtime = runtime();

        enqueue_inputs(&mut runtime, vec![input(10), input(11)]);
        enqueue_inputs(&mut runtime, vec![input(11), input(9), input(12)]);

        let queued: Vec<u16> = runtime.pending_inputs.iter().map(|cmd| cmd.seq).collect();
        assert_eq!(queued, vec![10, 11, 12]);
        assert_eq!(runtime.last_received_input_seq, Some(12));
    }

    #[test]
    fn enqueue_inputs_keeps_newest_frames_when_queue_overflows() {
        let mut runtime = runtime();
        let frames = (1..=(MAX_PENDING_INPUTS as u16 + 5)).map(input).collect();

        enqueue_inputs(&mut runtime, frames);

        assert_eq!(runtime.pending_inputs.len(), MAX_PENDING_INPUTS);
        assert_eq!(runtime.pending_inputs.front().map(|cmd| cmd.seq), Some(6));
        assert_eq!(
            runtime.pending_inputs.back().map(|cmd| cmd.seq),
            Some(MAX_PENDING_INPUTS as u16 + 5)
        );
    }

    #[test]
    fn take_input_for_tick_consumes_queue_then_repeats_last_applied() {
        let mut runtime = runtime();
        enqueue_inputs(&mut runtime, vec![input(21), input(22)]);

        let first = take_input_for_tick(&mut runtime);
        let second = take_input_for_tick(&mut runtime);
        let repeated = take_input_for_tick(&mut runtime);

        assert_eq!(first.seq, 21);
        assert_eq!(second.seq, 22);
        assert_eq!(repeated.seq, 22);
        assert_eq!(runtime.last_ack_input_seq, 22);
    }

    #[test]
    fn vehicle_catchup_skips_stale_inputs_and_acks_newest_control() {
        let mut runtime = runtime();
        enqueue_inputs(&mut runtime, (21..=24).map(input).collect());

        let applied = take_input_for_tick_with_vehicle_catchup(&mut runtime, true);

        assert_eq!(applied.seq, 24);
        assert!(runtime.pending_inputs.is_empty());
        assert_eq!(runtime.last_ack_input_seq, 24);
        assert_eq!(runtime.last_applied_input.seq, 24);
    }

    #[test]
    fn vehicle_entry_clears_stale_walk_inputs_and_bulk_acks_received_seq() {
        let mut runtime = runtime();
        runtime.last_applied_input.yaw = 1.25;
        runtime.last_applied_input.pitch = -0.5;
        enqueue_inputs(&mut runtime, (21..=25).map(input).collect());

        clear_runtime_inputs_for_vehicle_entry(&mut runtime);

        assert!(runtime.pending_inputs.is_empty());
        assert_eq!(runtime.last_ack_input_seq, 25);
        assert_eq!(runtime.last_applied_input.seq, 25);
        assert_eq!(runtime.last_applied_input.buttons, 0);
        assert_eq!(runtime.last_applied_input.move_x, 0);
        assert_eq!(runtime.last_applied_input.move_y, 0);
        assert_eq!(runtime.last_applied_input.yaw, 1.25);
        assert_eq!(runtime.last_applied_input.pitch, -0.5);
    }

    #[test]
    fn vehicle_catchup_preserves_reset_pressed_in_skipped_history() {
        let mut runtime = runtime();
        let mut frames: Vec<_> = (21..=24).map(input).collect();
        frames[1].buttons |= BTN_RELOAD;
        enqueue_inputs(&mut runtime, frames);

        let applied = take_input_for_tick_with_vehicle_catchup(&mut runtime, true);

        assert_eq!(applied.seq, 24);
        assert_ne!(applied.buttons & BTN_RELOAD, 0);
    }

    #[test]
    fn on_foot_backlog_keeps_ordered_processing() {
        let mut runtime = runtime();
        enqueue_inputs(&mut runtime, (21..=30).map(input).collect());

        let applied = take_input_for_tick_with_vehicle_catchup(&mut runtime, false);

        assert_eq!(applied.seq, 21);
        assert_eq!(runtime.pending_inputs.len(), 9);
        assert_eq!(runtime.last_ack_input_seq, 21);
    }

    #[test]
    fn rifle_damage_matches_hit_zone() {
        assert_eq!(rifle_damage(HitZone::Body), RIFLE_BODY_DAMAGE);
        assert_eq!(rifle_damage(HitZone::Head), RIFLE_HEAD_DAMAGE);
        assert!(rifle_damage(HitZone::Head) > rifle_damage(HitZone::Body));
    }

    #[test]
    fn respawn_delay_uses_default_and_accepts_override() {
        assert_eq!(parse_respawn_delay_ms(None), super::RESPAWN_DELAY_MS);
        assert_eq!(parse_respawn_delay_ms(Some("0")), 0);
        assert_eq!(parse_respawn_delay_ms(Some("250")), 250);
        assert_eq!(
            parse_respawn_delay_ms(Some("bad-value")),
            super::RESPAWN_DELAY_MS
        );
    }

    #[test]
    fn server_build_profile_matches_cfg() {
        #[cfg(debug_assertions)]
        assert_eq!(server_build_profile(), "debug");
        #[cfg(not(debug_assertions))]
        assert_eq!(server_build_profile(), "release");
    }

    #[test]
    fn try_queue_packet_drops_snapshot_when_queue_is_full() {
        let telemetry = MatchIoTelemetry::default();
        let (tx, mut rx) = mpsc::channel(1);

        assert!(try_queue_packet(
            &tx,
            vec![PKT_PING, 1, 2, 3, 4],
            &telemetry
        ));
        assert!(!try_queue_packet(&tx, vec![PKT_SNAPSHOT, 0], &telemetry));
        assert_eq!(
            telemetry
                .dropped_outbound_snapshots
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(rx.try_recv().ok(), Some(vec![PKT_PING, 1, 2, 3, 4]));
    }

    #[test]
    fn snapshot_packet_helper_recognizes_v1_and_v2() {
        assert!(is_snapshot_packet_kind(PKT_SNAPSHOT));
        assert!(is_snapshot_packet_kind(PKT_SNAPSHOT_V2));
        assert!(!is_snapshot_packet_kind(PKT_PING));
    }

    #[test]
    fn strict_snapshot_datagrams_drop_v2_instead_of_falling_back() {
        assert_eq!(
            classify_outbound_delivery(PKT_SNAPSHOT_V2, true, false),
            OutboundDelivery::StrictDrop
        );
        assert_eq!(
            classify_outbound_delivery(PKT_SNAPSHOT_V2, false, false),
            OutboundDelivery::ReliableFallback
        );
        assert_eq!(
            classify_outbound_delivery(PKT_SNAPSHOT_V2, true, true),
            OutboundDelivery::Datagram
        );
    }

    #[test]
    fn telemetry_counts_webtransport_snapshot_datagrams() {
        let telemetry = MatchIoTelemetry::default();
        telemetry.observe_outbound_datagram(256, super::ClientTransport::WebTransport, true);

        assert_eq!(
            telemetry
                .snapshot_datagram_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(
            telemetry
                .webtransport_snapshot_datagram_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(
            telemetry
                .snapshot_reliable_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn strict_snapshot_drop_causes_are_classified() {
        assert_eq!(
            strict_snapshot_drop_cause_from_send_error(&SendDatagramError::TooLarge),
            StrictSnapshotDropCause::Oversize
        );
        assert_eq!(
            strict_snapshot_drop_cause_from_send_error(&SendDatagramError::NotConnected),
            StrictSnapshotDropCause::ConnectionClosed
        );
        assert_eq!(
            strict_snapshot_drop_cause_from_send_error(&SendDatagramError::UnsupportedByPeer),
            StrictSnapshotDropCause::UnsupportedByPeer
        );
    }

    #[test]
    fn density_metrics_count_nearby_players() {
        let (avg, max) =
            compute_density_metrics(&[[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [30.0, 0.0, 0.0]]);
        assert!(avg > 0.0);
        assert_eq!(max, 1);
    }

    #[test]
    fn global_stats_aggregates_multiple_matches() {
        let mut registry = HashMap::new();
        registry.insert(
            "b".to_string(),
            super::MatchStatsSnapshot {
                id: "b".to_string(),
                ..Default::default()
            },
        );
        registry.insert(
            "a".to_string(),
            super::MatchStatsSnapshot {
                id: "a".to_string(),
                ..Default::default()
            },
        );

        let global = super::global_stats_from_registry(&registry);
        let ids: Vec<_> = global
            .matches
            .into_iter()
            .map(|match_stats| match_stats.id)
            .collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn visible_dynamic_body_within_aoi_stays_replicated() {
        // Body within exit radius stays replicated when already visible
        assert!(dynamic_body_within_aoi(
            true,
            [super::DYNAMIC_BODY_AOI_EXIT_RADIUS_M - 0.1, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ));
    }

    #[test]
    fn newly_visible_dynamic_body_must_be_inside_entry_aoi() {
        assert!(dynamic_body_within_aoi(
            false,
            [super::DYNAMIC_BODY_AOI_RADIUS_M - 0.1, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ));
        assert!(!dynamic_body_within_aoi(
            false,
            [super::DYNAMIC_BODY_AOI_RADIUS_M + 0.1, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ));
    }
}
