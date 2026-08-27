mod app_config;
mod city;
#[cfg(all(test, feature = "destruction"))]
mod city_bench;
mod demo_world;
mod heartbeat;
mod lag_comp;
mod movement;
#[cfg(feature = "physx-gpu")]
mod physx_runtime;
mod protocol;
mod voxel_world;

use std::{
    backtrace::Backtrace,
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, RwLock as StdRwLock,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use bytes::BufMut;
use futures_util::{sink::SinkExt, stream::StreamExt, FutureExt};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, RwLock as AsyncRwLock};
use tracing::{error, info, warn};
use vibe_land_shared::constants::{
    DEFAULT_BATTERY_HEIGHT_M, DEFAULT_BATTERY_RADIUS_M, DYNAMIC_BODY_AOI_EXIT_RADIUS_M,
    DYNAMIC_BODY_AOI_RADIUS_M, DYNAMIC_BODY_IMPULSE, FLAG_MELEEING, HITSCAN_MAX_DISTANCE_M,
    MAX_PENDING_INPUTS, MELEE_COOLDOWN_MS, MELEE_DAMAGE, MELEE_ENERGY_COST,
    PLAYER_INPUT_CATCHUP_THRESHOLD,
    MELEE_FLAG_DURATION_TICKS, MELEE_HALF_CONE_COS, MELEE_HIT_RECOVERY_MS, MELEE_RANGE_M,
    OUT_OF_BOUNDS_Y_M, PLAYER_AOI_RADIUS_M, PLAYER_EYE_HEIGHT_M, RIFLE_BODY_DAMAGE,
    RIFLE_FIRE_INTERVAL_MS, RIFLE_HEAD_DAMAGE, RIFLE_SHOT_ENERGY_COST, SHAPE_SPHERE, SIM_HZ,
    SPAWN_PROTECTION_MS, VEHICLE_AOI_RADIUS_M, VEHICLE_INPUT_CATCHUP_THRESHOLD,
    VEHICLE_INTERACT_RADIUS_M,
};
use wtransport::{error::SendDatagramError, Connection, Endpoint, Identity, ServerConfig};

use crate::{
    app_config::PhysicsRuntimeConfig,
    demo_world::seed_world_for_match,
    lag_comp::{HistoricalCapsule, HistoricalDynamicBody, HitZone, LagCompHistory},
    movement::{MoveConfig, PhysicsArena, PlayerDamageOutcome},
    protocol::{
        client_datagram_to_packet, cms_to_mps, decode_client_datagram, decode_client_hello,
        decode_client_packet, encode_server_packet, energy_to_centi, f32_to_snorm16,
        make_net_battery_state, make_net_dynamic_body_state, make_net_player_state,
        make_net_shot_fired, meters_to_mm, mm_to_meters, BatterySyncPacket, ClientPacket,
        DamageEventPacket, FireCmd, InputCmd, LocalPlayerEnergyPacket, MeleeCmd, NetBatteryState,
        ServerPacket, ShotResultPacket, SnapshotPacket, WelcomePacket, BTN_JUMP, BTN_RELOAD,
        HIT_ZONE_BODY,
        HIT_ZONE_HEAD, HIT_ZONE_NONE, PKT_BATTERY_SYNC, PKT_CITY_CHUNKS, PKT_CITY_DEBRIS,
        PKT_LOCAL_PLAYER_ENERGY, PKT_PING, PKT_SNAPSHOT, PKT_SNAPSHOT_V2,
        SHOT_RESOLUTION_BLOCKED_BY_WORLD, SHOT_RESOLUTION_DYNAMIC, SHOT_RESOLUTION_MISS,
        SHOT_RESOLUTION_PLAYER,
    },
    voxel_world::VoxelWorld,
};
const CHUNK_RADIUS_ON_JOIN: i32 = 4;
const SERVER_PING_INTERVAL_TICKS: u32 = SIM_HZ as u32;
const MAX_LAG_COMP_MS: u32 = 250;
const MAX_CLIENT_FIRE_FUTURE_MS: u32 = 50;
const RESPAWN_DELAY_MS: u32 = 3_000;
const NEARBY_PLAYER_RADIUS_M: f32 = 12.0;
const ROLLING_METRIC_SAMPLES: usize = 180;
/// Per-player outbound queue depth.
///
/// Raised from 64 after topology messages were measured being dropped on a
/// full queue during a collapse: a burst of reliable city state plus a phone's
/// drain rate filled 64 slots in a tick. The queue is the only buffer between
/// a 60 Hz producer and a client's link, and overflowing it costs correctness
/// for city state, not just latency.
const PLAYER_OUTBOUND_QUEUE_CAPACITY: usize = 256;
/// A session that opens a stream and then says nothing holds a task and a QUIC
/// stream open; drop it rather than letting it accumulate.
const CLIENT_HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CLIENT_HELLO_BYTES: usize = 4096;
/// Client uplink packets are inputs and commands -- tens of bytes, not frames.
const MAX_CLIENT_STREAM_PACKET_BYTES: usize = 8192;
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
const SNAPSHOT_V2_SELF_PLAYER_BYTES: usize = 33;
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

/// Destructible-city telemetry, surfaced to the in-page debug overlay so the
/// sim cost and the render cost can be told apart while playing.
#[derive(serde::Serialize, Clone, Default)]
struct CityStatsSnapshot {
    structures: u32,
    /// Which city wire this match speaks. On the panel beside the client's own
    /// view of it: a mismatch is invisible in play -- the client discards the
    /// other wire's pose records by design -- and it silently stops the city
    /// being destroyed on screen while the server keeps fracturing.
    wire_version: u8,
    /// Wire v3 governor internals -- the knobs the F9 panel cannot show.
    /// Zero/1.0 on v2 matches.
    v3_span_ticks: u32,
    v3_rate_scale: f32,
    v3_ema_mbps: f32,
    v3_epoch: u8,
    v3_span_encode_ms: f32,
    /// Intra-window (since last publish) per-tick aggregates: what happened
    /// WITHIN this second, not just the tick that coincided with publish.
    window_step_ms: city::WindowSummary,
    window_ingest_ms: city::WindowSummary,
    window_span_encode_ms: city::WindowSummary,
    window_awake: city::WindowSummary,
    /// min/avg/p95/max per span timer over every tick since the last publish.
    ///
    /// Prefer these to the single-sample fields above. The publish fires every
    /// 60 ticks and the bond scan every 30, so the instantaneous sample is
    /// harmonically locked to the expensive tick -- it is a biased estimator of
    /// per-tick cost, not a neutral one.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    phase_windows: std::collections::BTreeMap<String, city::WindowSummary>,
    chunk_bodies: u32,
    awake_bodies: u32,
    broken_bonds: u32,
    /// Whole 60 Hz city step in ms, not codec time alone.
    ///
    /// The parent of `begin_ms`, `solve_ms`, `end_ms`, `readback_ms_host`,
    /// `settle_ms` and `ingest_ms`. Those do not account for all of it: the
    /// post-fracture push re-apply, topology drain and baseline emit are
    /// untimed, and show up as the difference. Treat `step_ms` minus the
    /// children as real unattributed cost, not as rounding.
    step_ms: f32,
    /// Host wall time of the whole native destruction tick.
    ///
    /// A PARENT of `begin_ms`, `solve_ms`, `end_ms`, `readback_ms`, `events_ms`
    /// and `filters_ms` -- it brackets beginTick through endTick, so it must
    /// never be added to them. It is also a wall-clock span rather than a sum
    /// of those parts, and measures ~20% above them: per-slot dispatch and the
    /// topology-diff decision live in the gap.
    stress_solve_ms: f32,
    /// Sub-phases of the native tick, all children of `stress_solve_ms`.
    /// `solve_ms` is the CUDA/parallel solveTick ALONE -- `begin_ms` and
    /// `end_ms` carry the injection and fracture walks that used to be folded
    /// into it.
    solve_ms: f32,
    /// Native-side GPU readback. Distinct from `readback_ms_host`, which is the
    /// host stage outside the native tick; they are not the same measurement.
    readback_ms: f32,
    events_ms: f32,
    /// beginTick / solveTick / endTick, split apart: reporting them as one
    /// "stress solve" number hid that the injection walk costs more than the
    /// GPU solve.
    ///
    /// `begin_ms` is NOT serial. It is dispatched across the stress executor
    /// by default (`VIBE_CITY_SNAPSHOT_BEGIN`, on unless set to 0); only the
    /// wakeUp apply inside it runs serially, and that is a handful of bodies
    /// even during a collapse. `end_ms` IS still serial. The older "serial
    /// beginTick" wording here outlived the change and sent at least one
    /// investigation after a parallelisation that had already happened.
    begin_ms: f32,
    end_ms: f32,
    /// Host-side stages. Without these the overlay shows a large "city step"
    /// with only the Blast phases beneath it, and the majority of the cost is
    /// invisible: at 10k bodies the Blast phases are 6.4 ms of a 23.5 ms step.
    readback_ms_host: f32,
    settle_ms: f32,
    ingest_ms: f32,
    /// Host wall time of the whole native destruction tick, FFI hop included.
    /// A parent of the Blast phases and measurably larger than their sum.
    tick_ffi_ms: f32,
    /// Event drain (broken bonds, migrations, island events) and the
    /// destruction-stats FFI readback: two stages that were measured all along
    /// and never published, so `step_ms` minus its children over-reported the
    /// unattributed remainder.
    drain_ms: f32,
    stats_ffi_ms: f32,
    /// `backend.post_step` in full -- the parent of the destruction phases,
    /// measured by the host rather than summed from them.
    post_step_ms: f32,
    /// Broadcasting this tick's reliable and v3 packets to every viewer. Scales
    /// with packets x players and clones each packet per viewer.
    fan_out_ms: f32,
    /// Clients re-bootstrapped after a reliable city packet was dropped on a
    /// full outbound queue. MUST stay 0 in normal play: every repair means a
    /// player briefly saw a city that had stopped being destroyed.
    city_desync_repairs: u64,
    /// The 1 Hz stats publish (JSON, per-player packets, registry writes,
    /// telemetry line). Lands entirely on one tick, so it shows up as a spike
    /// in the tick window rather than in any average.
    publish_ms: f32,
    /// The 30 Hz stream encode: shared record build, then per-client interest
    /// and datagram packing.
    ///
    /// NOT part of `step_ms`. This is a separate pass at half the rate, so
    /// these two must never be added to the `step_ms` sub-phases -- doing so
    /// double-counts across two different tick rates.
    encode_shared_ms: f32,
    client_datagrams_ms: f32,
    /// Structures whose stress solve is running on the GPU, so a silent
    /// fallback to the CPU solver is visible rather than merely slower.
    gpu_stress_structures: u32,
    /// Per-tick GPU solve time. The adapter's own counter is cumulative since
    /// the destructible was created; the bridge reports the delta, so this
    /// belongs on the same scale as every other ms field here.
    gpu_stress_solve_ms: f32,
    filters_ms: f32,
    /// The three phases that used to sit untimed inside `stress_solve_ms`,
    /// visible only as the gap between it and the sum of its children. The
    /// CCD walk and the support-load resolve are both O(live bodies) EVERY
    /// tick -- the CCD walk runs before the quiet-skip gate, which is why the
    /// gap was present at idle with nothing happening.
    ccd_ms: f32,
    support_loads_ms: f32,
    /// Contact pairs the support resolve consumed. `support_loads_ms` scales
    /// with this, so a ms comparison across runs without it is meaningless.
    support_pair_loads: u32,
    shape_readback_ms: f32,
    /// The adapter's own per-phase timers, deltaed to per-tick. These
    /// decompose the phases the bridge times from OUTSIDE the adapter:
    /// `begin_ms` ~= contact_processing + gravity, `solve_ms` ~= stress_solve_cpu
    /// + gpu_stress_solve, `end_ms` ~= fracture_topology + mapping_validation.
    /// They were computed every tick and discarded, which left 2-3.5 ms inside
    /// the largest phase in the tick unaccounted for.
    blast_contact_processing_ms: f32,
    blast_gravity_ms: f32,
    blast_stress_solve_cpu_ms: f32,
    blast_fracture_topology_ms: f32,
    blast_mapping_validation_ms: f32,
    /// Inside blast_fracture_topology_ms, which is the largest phase in the
    /// tick during a collapse and had never been opened up. Children of it,
    /// never summed with it: generate (solver call) / prep (sort, limit, node
    /// snapshot, parent motion) / apply (solver island split) / scene (event
    /// sort + applySplit under the write lock) / rebuild (rebuildLookupTables,
    /// three whole-population hash maps). Remainder is topology minus these
    /// five minus mapping validation.
    blast_fracture_generate_ms: f32,
    blast_fracture_prep_ms: f32,
    blast_fracture_apply_ms: f32,
    blast_fracture_scene_ms: f32,
    blast_fracture_rebuild_ms: f32,
    blast_sleeping_actors_skipped: u64,
    /// The last two untimed blocks inside the `stress_solve_ms` bracket:
    /// per-slot dispatch (live-slot gather + telemetry read + topology
    /// compare) and the 1-in-30 bond-utilisation scan. With these, the bracket
    /// minus its children is genuinely zero rather than "small enough to round
    /// to 0.00 at two decimals".
    slot_dispatch_ms: f32,
    bond_sample_ms: f32,
    /// Slot-ticks where topology was unchanged and the event diff was skipped.
    /// `events_ms`/`filters_ms` are `0.0` on exactly these ticks, and without
    /// this counter a working skip and a broken measurement are
    /// indistinguishable from the value alone.
    quiet_slot_ticks: u64,
    /// Contacts routed into the stress solver, cumulative. Routing happens per
    /// contact POINT and twice per point (once per shape), so
    /// `contacts_queued / (2 * support_pair_loads)` is the points-per-manifold
    /// factor. Both of these were assigned all the way through the netcode
    /// struct and then dropped here, so the pipeline could not be sized at all.
    contacts_queued: u64,
    contacts_processed: u32,
    contacts_dropped: u32,
    /// Running totals of the island partition. `solver_islands_skipped` beside
    /// them is a gauge of the LAST tick, and a bond break zeroes it by design,
    /// so it reads 0 through a whole demolition while skipping works. Difference
    /// these two across samples for the real rate.
    solver_islands_skipped_accum: u64,
    solver_islands_total_accum: u64,
    escaped_bodies_parked: u64,
    /// Live entries in the two per-body bookkeeping containers. Both are keyed
    /// by (structure_id, bodyId) and erased on retire, so they must track live
    /// bodies. Pointer-keyed and unpruned they grew without bound, and a
    /// recycled actor inherited the dead body's CCD state -- meaning the new
    /// body never got speculative CCD and could tunnel.
    ccd_tracked_bodies: u32,
    identity_stamped_bodies: u32,
    sleeping_bodies: u32,
    /// Bonds over their own elastic limit in the last solve. Fracture only
    /// runs when this is non-zero, so a persistent 0 while shooting means the
    /// load never reached the bonds -- not that the material held.
    overstressed_bonds: u32,
    /// Worst stress / elastic-limit ratio across bonds (1.0 = at the limit).
    bond_utilisation_max: f32,
    bonds_above_half_utilisation: u32,
    packets_per_sec: u64,
    records_per_sec: u64,
    bytes_per_sec: u64,
    topo_seq: u32,
    baseline_id: u16,
    min_body_y: f32,
    /// PhysX engine-asleep -> awake transitions for DYNAMIC bodies. Frozen
    /// bodies are kinematic and are skipped before this is reached, so this is
    /// NOT a count of freezes being undone -- see `unfreeze_flips` for that.
    /// The two count different populations and must not be combined.
    resettled_wakes: u64,
    /// PERMANENTLY ZERO: nothing in the tree increments this. Kept published
    /// only so removing it is a deliberate wire change rather than a silent
    /// one -- but it is not evidence of anything, and must not be cited as
    /// "no settles were deferred".
    settle_deferred_penetrating: u64,
    unmapped_body_skips: u32,
    duplicate_body_records: u64,
    /// Contact islands the PhysX solver saw, and how many it skipped as
    /// settled. PhysX sleeps per island, never per body, so this is the only
    /// field that distinguishes a merged city-block pile -- which can only
    /// sleep or wake as a whole -- from the same body count spread over
    /// thousands of independent islands.
    solver_island_count: u32,
    solver_islands_skipped: u32,
    /// Settled debris held kinematic, out of the rigid-body solver, and the
    /// transitions that produced it. Sustained flips with no new damage is
    /// the signature of a freeze policy fighting the engine.
    frozen_bodies: u32,
    freeze_flips: u64,
    unfreeze_flips: u64,
    /// Frozen bodies released because dynamic debris struck them -- the
    /// engine's own contact reports driving the wake. Rises during collapses
    /// onto old rubble; flat at rest.
    contact_wakes: u64,
    /// Sleep/wake edges this tick. `awake_bodies` is a level and cannot say
    /// whether a pile is failing to settle or being repeatedly re-woken.
    chunk_sleep_events: u64,
    chunk_wake_events: u64,
    /// Awake bodies that have completed their pose-quiet window -- i.e. have
    /// not left a 2 cm shell for `pose_ticks`. Counted whenever pose freezing
    /// OR the census is on (`freeze.rs`), and pose freezing is ON by default,
    /// so this is a live number in normal play. (It was previously documented
    /// as census-only, which is wrong.)
    ///
    /// Read it as "completed the window but was NOT admitted" -- a body that
    /// passes the window is emitted as a freeze candidate in the same branch,
    /// so anything still counted here was refused: squeezed, unsupported, or
    /// over the per-tick batch. It is NOT "bodies sitting still that nobody
    /// tried to freeze". Note the window is scaled by the per-body unfreeze
    /// backoff, so a churned body needs far longer than `pose_ticks` to
    /// appear here at all.
    pose_quiet_awake_bodies: u32,
    /// ZERO UNLESS `VIBE_CITY_POSE_CENSUS=1`. Hard-gated on the census flag in
    /// `freeze.rs`, which defaults off, so a `0` here is the switch, not a
    /// measurement -- do not read it as "no floating rubble".
    unsupported_resting_bodies: u32,
    backstop_releases: u64,
    /// Must stay zero. Non-zero means a frozen body reached a serial-issuing
    /// path and aliased onto the structure's support actor.
    frozen_serial_blocks: u64,
    degraded: bool,
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
    /// When this binary was built and when this process started, so a
    /// screenshot can be told apart from a stale one. Reading a metric off a
    /// server that predates the change being tested has wasted real time in
    /// this project more than once.
    server_build: String,
    server_started: String,
    physics_backend: String,
    physics_gpu_required: bool,
    physics_gpu_active: bool,
    physics_gpu_warning_count: u32,
    physics_contact_pairs: u32,
    /// PhysX's high-water marks for the two fixed-capacity GPU buffers, with
    /// their configured ceilings. Overrunning one degrades hard and is the
    /// failure mode a no-caps simulation actually has; these were computed in
    /// C++, carried to WorldStats, and then dropped by health().
    physics_gpu_rigid_contact_high_water: u32,
    physics_gpu_rigid_patch_high_water: u32,
    physics_gpu_max_rigid_contacts: u32,
    physics_gpu_max_rigid_patches: u32,
    physics_active_dynamic_bodies: u32,
    physics_last_step_ms: f32,
    /// Step phases. `simulate` only dispatches under GPU dynamics, so
    /// `fetch` carries GPU compute plus the result readback.
    physics_simulate_ms: f32,
    physics_fetch_ms: f32,
    /// The split inside `fetch`, only under `VIBE_PHYSX_PROFILE_FETCH=1`:
    /// blocked-on-GPU versus result copy. A large `gpu_wait` is dead time the
    /// tick could be spending on encode.
    physics_gpu_wait_ms: f32,
    physics_fetch_copy_ms: f32,
    /// The part of `dynamics_ms` that is NOT the step. `physics_last_step_ms`
    /// covers only `world.step()`; these three cover the FFI readbacks after
    /// it, the player refresh, and the vehicle control loop before it, which
    /// together were the unexplained difference between the two.
    physics_readback_ms: f32,
    physics_refresh_players_ms: f32,
    physics_vehicle_control_ms: f32,
    physics_controller_ms: f32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    city: Option<CityStatsSnapshot>,
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
    physics: PhysicsRuntimeConfig,
    stats_tx: Arc<tokio::sync::watch::Sender<GlobalStatsSnapshot>>,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
    /// Per-body freeze-machine states, refreshed at the stats cadence, for
    /// the body-color debug overlay. Cheap to keep warm (one small Vec per
    /// match per second); only serialized when the endpoint is hit.
    body_states_registry: Arc<StdRwLock<HashMap<String, Vec<(u32, u8, u32, i32)>>>>,
    /// Match ids awaiting a city reset. The HTTP handler cannot touch the
    /// simulation directly -- the match loop owns it -- so the request is left
    /// here and consumed on the next tick, between steps where rebuilding the
    /// scene is safe.
    reset_requests: Arc<StdRwLock<HashSet<String>>>,
    /// Inbound-UDP reachability evidence.
    ///
    /// A box cannot test its own reachability from inside: a bind succeeding
    /// says the socket exists, not that anything on the internet can send to
    /// it, and hairpinning a probe back through the host's own NAT fails on
    /// plenty of hosts that forward player traffic perfectly well. So instead
    /// of probing, this records what actually happened.
    ///
    /// `session_configs_served` counts clients that asked where to connect --
    /// each one is a browser about to open QUIC. `wt_attempts` counts
    /// connection attempts that reached the socket. A gap between them is the
    /// signature of a black-holed UDP path, and it is the only evidence that
    /// distinguishes that from "nobody has tried yet".
    wt_attempts: Arc<AtomicU64>,
    session_configs_served: AtomicU64,
    /// Milliseconds since process start at the first `/session-config`, or 0.
    first_session_config_ms: AtomicU64,
    started: std::time::Instant,
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
    protocol_version: u16,
    physics_backend: u8,
    client_movement_mode: u8,
    city_world: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    city_manifest_hash: Option<String>,
    /// Reliable-channel byte layout this match speaks. The client decodes
    /// against this rather than assuming, so a v2 client and a v3 match fail
    /// loudly at the handshake instead of throwing mid-stream.
    city_wire_version: u8,
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
    /// Inputs dropped to stay current. Non-zero means the loop is behind.
    inputs_skipped_for_catchup: u64,
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
    physics: PhysicsRuntimeConfig,
    last_logged_datagram_fallbacks: u64,
    last_logged_dropped_outbound_packets: u64,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
    /// Per-body freeze-machine states, refreshed at the stats cadence, for
    /// the body-color debug overlay. Cheap to keep warm (one small Vec per
    /// match per second); only serialized when the endpoint is hit.
    body_states_registry: Arc<StdRwLock<HashMap<String, Vec<(u32, u8, u32, i32)>>>>,
    next_player_handle: u16,
    reusable_player_handles: VecDeque<(u32, u8)>,
    free_player_handles: VecDeque<u8>,
    player_handles: HashMap<u32, u8>,
    dynamic_body_handles: HashMap<u32, DynamicBodyMetaRuntime>,
    vehicle_handles: HashMap<u32, u8>,
    city: Option<city::CityRuntime>,
    reset_requests: Arc<StdRwLock<HashSet<String>>>,
    /// Players whose city ledger is known to be holed by a dropped reliable
    /// packet, awaiting a re-bootstrap once their queue drains.
    city_desync_players: HashSet<u32>,
    city_desync_repairs: u64,
    /// Last tick's packet fan-out cost, and the last 1 Hz publish block's cost.
    /// Both were untimed while being O(packets x players) and "serialize the
    /// world to JSON, then write a file, on the tick thread" respectively.
    /// `last_publish_ms` is necessarily one second stale in the snapshot it
    /// appears in -- it measures the block that builds that snapshot.
    last_fan_out_ms: f32,
    last_publish_ms: f32,
}

#[tokio::main]
async fn main() -> Result<()> {
    load_repo_env();

    // `from_default_env()` with RUST_LOG unset builds an EMPTY filter, which
    // discards everything -- not even ERROR survives. A container image does
    // not set RUST_LOG, so every rented box has been running with the log
    // stream silently switched off, and diagnosing one meant inferring from
    // the absence of output that was never going to appear. Default to `info`
    // and let RUST_LOG override it as usual.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    install_panic_hook();
    let physics = PhysicsRuntimeConfig::from_env()?;
    if physics.backend == vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu {
        drop(
            PhysicsArena::new(MoveConfig::default(), physics.backend)
                .context("PhysX GPU startup validation failed")?,
        );
        info!("validated PhysX GPU and CUDA scene initialization");
    }
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
            // Still publish the leaf SHA-256 so browsers that do not trust the
            // issuing CA (agent webviews, local tunnels) can pin via
            // serverCertificateHashes. Trusted CA clients ignore the pin.
            let cert_der = identity.certificate_chain().as_slice()[0].der().to_vec();
            let cert_hash_hex = hex::encode(Sha256::digest(&cert_der));
            (identity, cert_hash_hex)
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
    anyhow::ensure!(
        physics.backend != vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu
            || strict_snapshot_datagrams,
        "PhysX GPU sessions require WT_STRICT_SNAPSHOT_DATAGRAMS=1 for the V2 60 Hz stream"
    );
    let respawn_delay_ms = parse_respawn_delay_ms(
        std::env::var("VIBE_SERVER_RESPAWN_DELAY_MS")
            .ok()
            .as_deref(),
    );

    info!(%wt_base_url, cert_hash = %cert_hash_hex, "WebTransport identity ready");
    info!(
        strict_snapshot_datagrams,
        respawn_delay_ms,
        physics_backend = physics.backend.name(),
        snapshot_hz = physics.snapshot_hz(),
        "server runtime policy loaded"
    );

    let (stats_tx, _stats_rx) = tokio::sync::watch::channel(GlobalStatsSnapshot::default());
    let stats_tx = Arc::new(stats_tx);

    // Declared before the state so /healthz and the accept loop share one
    // counter: a second Arc would leave health reporting a number nobody
    // increments, which is the same class of silent-wrong this whole change
    // exists to remove.
    let wt_attempts = Arc::new(AtomicU64::new(0));

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
            physics,
            stats_tx,
            stats_registry: Arc::new(StdRwLock::new(HashMap::new())),
            body_states_registry: Arc::new(StdRwLock::new(HashMap::new())),
            reset_requests: Arc::new(StdRwLock::new(HashSet::new())),
            wt_attempts: wt_attempts.clone(),
            session_configs_served: AtomicU64::new(0),
            first_session_config_ms: AtomicU64::new(0),
            started: std::time::Instant::now(),
        }),
    };
    // Taken before the router consumes `state`.
    let watchdog_state = state.inner.clone();

    // Start WebTransport server
    let wt_config = ServerConfig::builder()
        .with_bind_address(wt_addr)
        .with_identity(identity)
        .build();
    let wt_endpoint = Endpoint::server(wt_config)?;
    info!(%wt_addr, "WebTransport endpoint listening");

    {
        let app_inner = state.inner.clone();
        let attempts = wt_attempts.clone();
        tokio::spawn(async move {
            // Counts every QUIC connection attempt that actually reached this
            // socket. This is the one number that separates the two failures
            // that look identical from a browser -- both present as
            // QUIC_NETWORK_IDLE_TIMEOUT with no packets back:
            //
            //   attempts stay 0  -> the datagrams never arrive. The listener
            //                       is bound (a bind failure is fatal well
            //                       before this point), so the loss is
            //                       upstream: host port forwarding, or a
            //                       missing UDP mapping.
            //   attempts climb   -> packets arrive and the handshake itself
            //                       is failing. Look at the certificate.
            //
            // Diagnosing this by staring at logs that were never emitted cost
            // real time and two wrong conclusions.
            loop {
                let incoming = wt_endpoint.accept().await;
                let seen = attempts.fetch_add(1, Ordering::Relaxed) + 1;
                info!(
                    remote = %incoming.remote_address(),
                    attempts = seen,
                    "WT connection attempt reached the listener"
                );
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

    let heartbeat_state = state.inner.clone();
    let app = Router::new()
        .route("/healthz", get(health_handler))
        .route("/session-config", get(session_config_handler))
        .route("/city-manifest/:hash", get(city_manifest_handler))
        .route("/match-stats/:match_id", get(match_stats_handler))
        .route("/match-stats/:match_id/bodies", get(match_body_states_handler))
        .route("/city-reset/:match_id", post(city_reset_handler))
        .route("/ws/stats", get(ws_stats_handler))
        .route("/ws/:match_id", get(ws_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:4001".to_string())
        .parse()?;
    info!(%addr, "starting web fps server");
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // The standalone web listener: the same API plus the built client, over
    // TLS. It exists because a browser will not open a WebTransport session
    // from an insecure context, and `http://<public-ip>` is not one -- only
    // localhost is exempt. Serving the page over HTTPS from the box makes the
    // context secure and puts /session-config same-origin, so no CORS and no
    // mixed content either.
    //
    // Plain HTTP on BIND_ADDR stays exactly as it was: the Docker HEALTHCHECK,
    // the dev-server proxy and the fleet all still use it.
    // Never `?`: a certificate problem must not take down a game server that is
    // otherwise healthy. The listener reports and stays down instead.
    // Actively prove the advertised endpoint is reachable, before anyone is
    // billed for a box that cannot serve players.
    //
    // Blocking only matters when the result can end the process. In `warn`
    // mode nothing is decided by it, so waiting would just delay serving --
    // and by a full timeout precisely on the hosts that do not hairpin, which
    // is the common case for someone running this on a laptop.
    {
        let url = watchdog_state.wt_base_url.clone();
        let hash = watchdog_state.cert_hash_hex.clone();
        let counter = wt_attempts.clone();
        if std::env::var("UDP_VERIFY").as_deref() == Ok("fatal") {
            verify_public_udp_or_exit(&url, &hash, &counter).await;
        } else {
            tokio::spawn(async move { verify_public_udp_or_exit(&url, &hash, &counter).await });
        }
    }

    spawn_udp_reachability_watchdog(watchdog_state.clone());

    if let Err(error) = spawn_web_listener(app.clone()).await {
        error!(%error, "web listener failed to start; continuing without it");
    }

    // Both listeners are up, so the first beat can truthfully claim the server
    // is reachable -- that beat is what promotes this box to READY.
    match heartbeat::HeartbeatConfig::from_env() {
        Some(config) => heartbeat::spawn(heartbeat_state, config),
        None => info!("heartbeat disabled: CONTROL_PLANE_URL/SERVER_DO_ID/HEARTBEAT_TOKEN not set"),
    }

    axum::serve(listener, app).await?;
    Ok(())
}

/// Serves the built client and the API over TLS, for a box someone runs by hand.
///
/// Skipped unless a certificate is configured: without `WT_CERT_PEM`/`WT_KEY_PEM`
/// there is nothing to serve HTTPS with. In the container the entrypoint always
/// mints one, so this is always on there; under a bare `cargo run` it stays off
/// and nothing changes.
///
/// `VIBE_WEB_DIR` is the built client. If it is absent the listener still comes
/// up and serves the API -- useful for a server-only image -- it just has no
/// page to hand out.
/// Prove at boot that the address we are about to advertise actually reaches
/// this process, and refuse to run if it does not.
///
/// The failure this exists for: a host accepts the UDP port mapping, forwards
/// nothing, and the box looks perfect from every angle a machine can check --
/// it boots, heartbeats, serves /city, answers /healthz "ok" -- while every
/// player times out. It bills by the hour the whole time. Nothing short of a
/// human opening a browser noticed, which is the thing worth removing.
///
/// The probe opens a real WebTransport connection to our *own public*
/// endpoint, pinning the certificate hash we just generated the way a browser
/// would. It deliberately asks for a path the session handler rejects, so a
/// successful probe cannot create a phantom player.
///
/// Reachability is judged on whether the packets arrived, not on whether the
/// handshake finished: `wt_attempts` moving means a QUIC Initial reached the
/// listener, which is the property under test. A handshake that then fails for
/// its own reasons still proves the path.
///
/// The caveat, stated because it decides the default: this traverses the
/// host's NAT back to itself. A host that forwards player traffic correctly
/// can still fail to hairpin, so a failed probe is not proof of a bad box.
/// That is why `UDP_VERIFY` defaults to `warn` -- loud, and visible in the
/// logs, without destroying working hosts on a signal that has known false
/// negatives. Set `UDP_VERIFY=fatal` once a host is known to hairpin, and a
/// bad box kills itself at boot instead of billing quietly.
async fn verify_public_udp_or_exit(public_url: &str, cert_hash_hex: &str, attempts: &AtomicU64) {
    let mode = std::env::var("UDP_VERIFY").unwrap_or_else(|_| "warn".to_string());
    if mode == "off" {
        return;
    }
    let timeout_ms: u64 = std::env::var("UDP_VERIFY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(12_000);

    let before = attempts.load(Ordering::Relaxed);
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        probe_public_udp(public_url, cert_hash_hex),
    )
    .await;
    // Give the server side a moment to register the attempt it just saw.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    let arrived = attempts.load(Ordering::Relaxed) > before;

    match (&result, arrived) {
        // Either signal is sufficient: the handshake completing, or packets
        // simply showing up at the listener.
        (Ok(Ok(())), _) | (_, true) => {
            info!(
                endpoint = %public_url,
                handshake = result.as_ref().map(|r| r.is_ok()).unwrap_or(false),
                "UDP reachability verified: the advertised endpoint reaches this process"
            );
        }
        _ => {
            let (detail, network_evidence) = match &result {
                Ok(Err(ProbeFailure::NoResponse(detail))) => (detail.clone(), true),
                Ok(Err(ProbeFailure::Local(detail))) => (detail.clone(), false),
                Err(_) => (format!("timed out after {timeout_ms}ms"), true),
                Ok(Ok(())) => unreachable!("handled above"),
            };
            if !network_evidence {
                warn!(
                    endpoint = %public_url,
                    detail = %detail,
                    "UDP reachability probe could not run. This says nothing about the host -- \
                     the probe never reached the network -- so it is not treated as a failure \
                     even under UDP_VERIFY=fatal."
                );
                return;
            }
            if mode == "fatal" {
                error!(
                    endpoint = %public_url,
                    detail = %detail,
                    "UDP UNREACHABLE: nothing sent to the advertised endpoint came back to \
                     this process. Players would load the page and then time out on the QUIC \
                     handshake. The listener is bound -- a bind failure is fatal earlier -- so \
                     this host is not forwarding the UDP port. A port mapping cannot be added \
                     to a running instance, so exiting to have this box replaced."
                );
                std::process::exit(78); // EX_CONFIG, same as a missing mapping
            }
            warn!(
                endpoint = %public_url,
                detail = %detail,
                "could not verify UDP reachability. This host may simply not route traffic \
                 back to itself (NAT hairpin), which is common and harmless -- but it is also \
                 what a host that forwards nothing looks like. If players cannot connect, this \
                 is why. Set UDP_VERIFY=fatal to refuse to run unverified."
            );
        }
    }
}

/// One WebTransport connection to our own public address, pinning our own
/// certificate hash exactly as a browser does.
async fn probe_public_udp(public_url: &str, cert_hash_hex: &str) -> Result<(), ProbeFailure> {
    let mut digest = [0u8; 32];
    let bytes = (0..cert_hash_hex.len().min(64))
        .step_by(2)
        .map(|i| u8::from_str_radix(&cert_hash_hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|error| ProbeFailure::Local(format!("certificate hash is not hex: {error}")))?;
    if bytes.len() != 32 {
        return Err(ProbeFailure::Local(format!(
            "certificate hash is {} bytes, expected 32",
            bytes.len()
        )));
    }
    digest.copy_from_slice(&bytes);

    // Bind the probe socket in the same address family as the target. The
    // default is a dual-stack v6 bind, which fails outright with "Address
    // family not supported" on an IPv4-only host -- and that error arrives
    // looking exactly like unreachability. Running this caught it; a host
    // without IPv6 would otherwise have been declared dead and destroyed.
    let target_is_v4 = public_url
        .trim_start_matches("https://")
        .trim_start_matches('[')
        .split(':')
        .next()
        .map(|host| host.parse::<std::net::Ipv4Addr>().is_ok())
        .unwrap_or(false);
    let bind: SocketAddr = if target_is_v4 {
        (std::net::Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
    };

    let config = wtransport::ClientConfig::builder()
        .with_bind_address(bind)
        .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(digest)])
        .build();
    let endpoint = wtransport::Endpoint::client(config)
        .map_err(|error| ProbeFailure::Local(format!("could not open a probe socket: {error}")))?;
    // A path the session handler rejects: this must never become a player.
    let url = format!("{}/__reachability-probe", public_url.trim_end_matches('/'));
    match endpoint.connect(&url).await {
        Ok(_) => Ok(()),
        Err(error) => Err(ProbeFailure::NoResponse(format!("{error}"))),
    }
}

/// Why a probe did not succeed.
///
/// The distinction is the whole safety of this feature. `NoResponse` means the
/// probe was sent and nothing came back, which is evidence about the network.
/// `Local` means the probe never left the building -- a socket we could not
/// open, a hash we could not parse -- which is evidence about *us* and says
/// nothing about the host. Only the former may ever be fatal; treating a local
/// error as unreachability would destroy working boxes, which is exactly what
/// the first version of this did on an IPv4-only host.
enum ProbeFailure {
    Local(String),
    NoResponse(String),
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(detail) | Self::NoResponse(detail) => write!(f, "{detail}"),
        }
    }
}

/// Notice a box whose UDP path is black-holed, and stop pretending it is
/// healthy.
///
/// Binding the socket is fatal on failure, so a running server always has a
/// listening socket -- which is exactly why this failure was invisible. The
/// box boots, heartbeats, serves its page, answers /healthz with "ok", and is
/// handed players who then cannot connect. Two hosts did this before anyone
/// worked out the datagrams were being dropped upstream.
///
/// There is no way to test inbound reachability from inside the box. A probe
/// to our own public address has to hairpin back through the host's NAT,
/// which fails on plenty of hosts that carry player traffic perfectly well --
/// so a failed probe would condemn good boxes. Instead this waits for the one
/// piece of evidence that is unambiguous: a client fetched /session-config,
/// so a browser was told where to open QUIC and is trying right now. If no
/// connection attempt reaches the socket within the grace window after that,
/// the packets are not arriving.
///
/// On an orchestrated box, exiting is the useful response: the port mapping
/// cannot be changed on a running instance, so the box can never serve
/// players and the fleet should replace it. `UDP_WATCHDOG=fatal` selects
/// that; the entrypoint turns it on where a replacement is automatic, and it
/// stays off by default so a `docker run` on a laptop is not killed while its
/// owner is still opening a browser tab.
fn spawn_udp_reachability_watchdog(state: Arc<AppState>) {
    let mode = std::env::var("UDP_WATCHDOG").unwrap_or_else(|_| "warn".to_string());
    if mode == "off" {
        return;
    }
    let fatal = mode == "fatal";
    let grace_ms: u64 = std::env::var("UDP_WATCHDOG_GRACE_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(45_000);

    tokio::spawn(async move {
        let mut reported = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;

            let attempts = state.wt_attempts.load(Ordering::Relaxed);
            if attempts > 0 {
                // Reachability is proven for the life of the process; a later
                // quiet spell is just nobody playing.
                return;
            }
            let first = state.first_session_config_ms.load(Ordering::Relaxed);
            if first == 0 {
                continue; // nobody has asked where to connect yet
            }
            let waited = state.started.elapsed().as_millis() as u64 - first;
            if waited < grace_ms {
                continue;
            }

            let served = state.session_configs_served.load(Ordering::Relaxed);
            if !reported {
                error!(
                    session_configs_served = served,
                    wt_connection_attempts = 0,
                    waited_ms = waited,
                    wt_base_url = %state.wt_base_url,
                    "UDP appears unreachable: clients were told where to connect but not one \
                     QUIC packet has reached this socket. The listener is bound (a bind failure \
                     is fatal at startup), so the datagrams are being dropped upstream -- the \
                     host is not forwarding this UDP port."
                );
                reported = true;
            }
            if fatal {
                error!(
                    "UDP_WATCHDOG=fatal: exiting so this box is replaced. A port mapping \
                     cannot be added to a running instance, so this one can never serve players."
                );
                // 78 = EX_CONFIG, the same code the entrypoint uses for a
                // missing port mapping. Both mean "this host cannot do the
                // job", which is what the orchestrator acts on.
                std::process::exit(78);
            }
        }
    });
}

async fn spawn_web_listener(app: Router) -> anyhow::Result<()> {
    let Some(bind) = std::env::var("WEB_BIND_ADDR")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    let (Some(cert_path), Some(key_path)) = (
        std::env::var("WT_CERT_PEM").ok(),
        std::env::var("WT_KEY_PEM").ok(),
    ) else {
        info!("WEB_BIND_ADDR set but no WT_CERT_PEM/WT_KEY_PEM; web listener disabled");
        return Ok(());
    };

    let addr: SocketAddr = bind.parse()?;

    // rustls panics -- does not return an error -- when no process-level crypto
    // provider is installed, and axum-server does not install one. wtransport
    // sets its own up internally, which is not the same thing. Installing ring
    // here is idempotent by intent: a second call returns Err, which is the
    // "someone already did it" case and not a failure.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path).await?;

    let web_dir =
        std::env::var("VIBE_WEB_DIR").unwrap_or_else(|_| "/opt/vibe-land/web".to_string());
    let app = match std::path::Path::new(&web_dir).join("index.html") {
        // A single-page app: unknown paths are client routes such as /city, so
        // they must fall back to index.html rather than 404.
        index if index.is_file() => {
            info!(%web_dir, %addr, "serving the client over https");
            app.fallback_service(
                tower_http::services::ServeDir::new(&web_dir)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
        }
        _ => {
            info!(%web_dir, %addr, "no client bundle; https listener serves the api only");
            app
        }
    };

    tokio::spawn(async move {
        if let Err(error) = axum_server::bind_rustls(addr, tls)
            .serve(app.into_make_service())
            .await
        {
            error!(%error, "web listener stopped");
        }
    });
    Ok(())
}

#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    physics_backend: &'static str,
    physics_gpu_required: bool,
    sim_hz: u16,
    snapshot_hz: u16,
    /// Load, so a container smoke test and the Docker HEALTHCHECK can tell
    /// "listening" apart from "listening and actually running matches".
    active_matches: u32,
    players: u32,
    /// Whether any QUIC connection attempt has ever reached the UDP socket.
    /// False is not a fault on its own -- it also means "no client has tried
    /// yet" -- but false while `session_configs_served` climbs is a box that
    /// cannot serve players, which used to be indistinguishable from a
    /// healthy one.
    udp_verified: bool,
    wt_connection_attempts: u64,
    session_configs_served: u64,
}

async fn health_handler(State(state): State<SharedAppState>) -> Json<HealthResponse> {
    let (active_matches, players) = heartbeat::fleet_stats(&state.inner).await;
    Json(HealthResponse {
        status: "ok",
        physics_backend: state.inner.physics.backend.name(),
        physics_gpu_required: state.inner.physics.capabilities.gpu_required,
        sim_hz: state.inner.physics.sim_hz(),
        snapshot_hz: state.inner.physics.snapshot_hz(),
        active_matches,
        players,
        udp_verified: state.inner.wt_attempts.load(Ordering::Relaxed) > 0,
        wt_connection_attempts: state.inner.wt_attempts.load(Ordering::Relaxed),
        session_configs_served: state.inner.session_configs_served.load(Ordering::Relaxed),
    })
}

fn load_repo_env() {
    let repo_env = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env");
    // The path is baked in at compile time, so on a deployed box it points at
    // the *builder's* checkout and will never exist. Returning quietly keeps
    // container logs free of a warning that looks like a misconfiguration.
    if !repo_env.exists() {
        return;
    }
    match dotenvy::from_path(&repo_env) {
        Ok(()) => info!(path = %repo_env.display(), "loaded repo .env"),
        Err(err) => warn!(path = %repo_env.display(), error = %err, "failed to load repo .env"),
    }
}

async fn session_config_handler(
    Query(query): Query<SessionConfigQuery>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    // Each of these is a browser being told where to open QUIC. Recording the
    // first one starts the clock the reachability watchdog measures against.
    state
        .inner
        .session_configs_served
        .fetch_add(1, Ordering::Relaxed);
    let _ = state.inner.first_session_config_ms.compare_exchange(
        0,
        state.inner.started.elapsed().as_millis() as u64,
        Ordering::Relaxed,
        Ordering::Relaxed,
    );
    let config_match_id = query.match_id.clone();
    let city_world = city::is_city_match(&query.match_id);
    let city_manifest_hash = if city_world {
        city::manifest_asset().map(|(hash, _, _)| hash.clone())
    } else {
        None
    };
    let config = SessionConfig {
        url: format!("{}/game", state.inner.wt_base_url),
        server_certificate_hash_hex: state.inner.cert_hash_hex.clone(),
        match_id: query.match_id,
        sim_hz: state.inner.physics.sim_hz(),
        snapshot_hz: state.inner.physics.snapshot_hz(),
        interpolation_delay_ms: state.inner.physics.interpolation_delay_ms(),
        protocol_version: vibe_land_shared::constants::PROTOCOL_VERSION,
        physics_backend: state.inner.physics.backend.wire_id(),
        client_movement_mode: state.inner.physics.client_movement_mode(),
        city_world: city_world && city_manifest_hash.is_some(),
        city_manifest_hash,
        city_wire_version: city::city_wire_version(&config_match_id),
    };
    axum::Json(config)
}

/// Content-addressed city manifest: gzip-encoded canonical JSON, immutable.
/// Per-match telemetry for the in-page debug overlay: sim tick cost, body
/// counts, and city stream volume, so client-side and server-side slowness can
/// be told apart while playing.
async fn match_stats_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let snapshot = state
        .inner
        .stats_registry
        .read()
        .expect("stats registry poisoned")
        .get(&match_id)
        .cloned();
    match snapshot {
        Some(stats) => (StatusCode::OK, Json(stats)).into_response(),
        None => (StatusCode::NOT_FOUND, "unknown match").into_response(),
    }
}

async fn match_body_states_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    // Per-body freeze-machine states for the debug overlay: pairs of
    // [packed body entity, state], state = 0 awake, 1 awake-quiet
    // (admission pending), 2 asleep, 3 frozen, 4 foreign-blocked.
    let states = state
        .inner
        .body_states_registry
        .read()
        .expect("body states registry poisoned")
        .get(&match_id)
        .cloned();
    match states {
        Some(states) => (StatusCode::OK, Json(states)).into_response(),
        None => (StatusCode::NOT_FOUND, "unknown match").into_response(),
    }
}

/// Request an undamaged city for this match. Applied by the match loop on its
/// next tick, so this returns "accepted", not "done".
/// When this binary was built, from its own file mtime -- no build script or
/// codegen needed, and it cannot drift from the artefact actually running.
fn server_build_stamp() -> String {
    static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STAMP
        .get_or_init(|| {
            std::env::current_exe()
                .and_then(|path| std::fs::metadata(path))
                .and_then(|meta| meta.modified())
                .map(format_stamp)
                .unwrap_or_else(|_| "unknown".to_string())
        })
        .clone()
}

/// When this process started. Distinct from the build stamp: a restart on an
/// unchanged binary resets the world without changing the code.
fn server_started_stamp() -> String {
    static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STAMP
        .get_or_init(|| format_stamp(std::time::SystemTime::now()))
        .clone()
}

/// `HH:MM:SS` in UTC. Enough to spot a stale artefact in a screenshot; a full
/// date would not fit the overlay and is never the question being asked.
fn format_stamp(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day = secs % 86_400;
    format!("{:02}:{:02}:{:02}", day / 3600, (day % 3600) / 60, day % 60)
}

async fn city_reset_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    if !city::is_city_match(&match_id) {
        return (StatusCode::BAD_REQUEST, "not a city match").into_response();
    }
    state
        .inner
        .reset_requests
        .write()
        .expect("reset requests poisoned")
        .insert(match_id.clone());
    info!(%match_id, "city reset requested");
    (StatusCode::ACCEPTED, "reset queued").into_response()
}

async fn city_manifest_handler(
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;
    match city::manifest_asset() {
        Some((expected_hash, _, gzipped)) if *expected_hash == hash => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_ENCODING, "gzip"),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            gzipped.clone(),
        )
            .into_response(),
        Some(_) => (StatusCode::NOT_FOUND, "unknown manifest hash").into_response(),
        None => (StatusCode::NOT_FOUND, "city manifest unavailable").into_response(),
    }
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

    // Read exactly the framed ClientHello rather than reading to end-of-stream.
    //
    // Reading to end waits for the client's FIN, which makes the handshake
    // depend on every browser's WebTransport implementation delivering that
    // promptly. When one does not, this blocks forever: no Welcome is sent, no
    // error is raised, and the player sits on "Connecting..." with nothing in
    // the log to explain it. The frame is length-prefixed, so the exact size is
    // known up front and there is no reason to wait for a close.
    let payload = tokio::time::timeout(CLIENT_HELLO_TIMEOUT, async {
        let mut length = [0u8; 4];
        recv_stream.read_exact(&mut length).await?;
        let payload_len = u32::from_le_bytes(length) as usize;
        anyhow::ensure!(
            payload_len > 0 && payload_len <= MAX_CLIENT_HELLO_BYTES,
            "ClientHello length out of range: {payload_len}"
        );
        let mut payload = vec![0u8; payload_len];
        recv_stream.read_exact(&mut payload).await?;
        Ok::<_, anyhow::Error>(payload)
    })
    .await
    .context("timed out waiting for ClientHello")??;
    let hello = decode_client_hello(&payload)?;
    if app.physics.backend == vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu {
        anyhow::ensure!(
            hello.protocol_version >= vibe_land_shared::constants::PROTOCOL_VERSION,
            "PhysX GPU sessions require protocol version {}",
            vibe_land_shared::constants::PROTOCOL_VERSION
        );
        anyhow::ensure!(
            hello.movement_capabilities
                & vibe_land_shared::constants::CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE
                != 0,
            "client does not support thin authoritative movement"
        );
    }

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

    // Second inbound path: the same control stream the ClientHello arrived on,
    // carrying length-prefixed client packets.
    //
    // Safari can receive WebTransport datagrams but cannot send them
    // (`datagrams.writable` is undefined), which used to demote those sessions
    // all the way to WebSocket -- surrendering UDP in both directions to work
    // around a limit that only affects the client's tiny uplink. Reading input
    // here lets the expensive server-to-client stream stay on datagrams.
    let tx_stream = handle.tx.clone();
    let stream_telemetry = handle.telemetry.clone();
    let stream_reader = tokio::spawn(async move {
        loop {
            let mut length = [0u8; 4];
            if recv_stream.read_exact(&mut length).await.is_err() {
                break; // clean close, or the peer never used this path
            }
            let payload_len = u32::from_le_bytes(length) as usize;
            if payload_len == 0 || payload_len > MAX_CLIENT_STREAM_PACKET_BYTES {
                warn!(player_id, payload_len, "closing WT uplink: implausible frame length");
                break;
            }
            let mut payload = vec![0u8; payload_len];
            if recv_stream.read_exact(&mut payload).await.is_err() {
                break;
            }
            stream_telemetry.observe_inbound(payload.len());
            match decode_client_datagram(&payload) {
                Ok(dgram) => {
                    let packet = client_datagram_to_packet(dgram);
                    if tx_stream
                        .send(MatchEvent::Packet { player_id, packet })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(err) => {
                    stream_telemetry.observe_malformed_packet();
                    warn!(player_id, error = ?err, "dropping malformed WT stream packet");
                }
            }
        }
        info!(player_id, "WT stream uplink reader exited");
    });

    // The datagram reader owns disconnect: it is the path every client has, and
    // the stream reader ending simply means this client never needed it.
    let _ = tokio::join!(writer, reader);
    stream_reader.abort();
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
    physics: PhysicsRuntimeConfig,
    stats_tx: Arc<tokio::sync::watch::Sender<GlobalStatsSnapshot>>,
    telemetry: Arc<MatchIoTelemetry>,
    stats_registry: Arc<StdRwLock<HashMap<String, MatchStatsSnapshot>>>,
    body_states_registry: Arc<StdRwLock<HashMap<String, Vec<(u32, u8, u32, i32)>>>>,
    reset_requests: Arc<StdRwLock<HashSet<String>>>,
) {
    let mut arena = PhysicsArena::new(MoveConfig::default(), physics.backend)
        .expect("selected authoritative physics backend should initialize");
    let world = VoxelWorld::new();
    seed_world_for_match(&mut arena, &match_id).expect("world document should instantiate");
    let dynamic_body_handles = arena
        .snapshot_dynamic_bodies()
        .into_iter()
        .enumerate()
        .map(|(index, (id, _, _, half_extents, _, _, shape_type))| {
            let handle = u16::try_from(index + 1)
                .expect("snapshot V2 supports at most 65,535 dynamic bodies per match");
            (
                id,
                DynamicBodyMetaRuntime {
                    handle,
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
        .map(|(index, state)| {
            (
                state.id,
                u8::try_from(index + 1)
                    .expect("snapshot V2 supports at most 255 vehicles per match"),
            )
        })
        .collect();

    let city = if city::is_city_match(&match_id) {
        #[cfg(feature = "destruction")]
        let world = arena.physx_world_mut();
        #[cfg(not(feature = "destruction"))]
        let world = None;
        match city::CityRuntime::open(SIM_HZ as u32, world) {
            Ok(mut runtime) => {
                // Fixed for the life of the match: the version is announced in
                // the session config, so every client that joins has already
                // agreed to this layout.
                runtime.set_wire_version(city::city_wire_version(&match_id));
                info!(
                    %match_id,
                    structures = runtime.manifest.structures.len(),
                    chunks = runtime.manifest.total_chunks(),
                    bonds = runtime.manifest.total_bonds(),
                    physx = runtime.is_physx(),
                    city_wire = runtime.wire_version(),
                    "destructible city initialized"
                );
                Some(runtime)
            }
            Err(error) => {
                warn!(%match_id, %error, "destructible city unavailable for this match");
                None
            }
        }
    } else {
        None
    };

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
        physics,
        last_logged_datagram_fallbacks: 0,
        last_logged_dropped_outbound_packets: 0,
        stats_registry,
        body_states_registry,
        reset_requests,
        city_desync_players: HashSet::new(),
        city_desync_repairs: 0,
        last_fan_out_ms: 0.0,
        last_publish_ms: 0.0,
        next_player_handle: 1,
        reusable_player_handles: VecDeque::new(),
        free_player_handles: VecDeque::new(),
        player_handles: HashMap::new(),
        dynamic_body_handles,
        vehicle_handles,
        city,
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
        let _ = state.stats_tx.send(global_stats_from_registry(
            &registry,
            state.physics.snapshot_hz(),
        ));
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
    std::thread::Builder::new()
        .name(format!("match-{match_id}"))
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("match runtime should initialize");
            runtime.block_on(async move {
                let outcome = std::panic::AssertUnwindSafe(run_match_loop(
                    match_id.clone(),
                    rx,
                    app.strict_snapshot_datagrams,
                    app.respawn_delay_ms,
                    app.physics,
                    app.stats_tx.clone(),
                    telemetry,
                    app.stats_registry.clone(),
                    app.body_states_registry.clone(),
                    app.reset_requests.clone(),
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
                    let _ = app.stats_tx.send(global_stats_from_registry(
                        &registry,
                        app.physics.snapshot_hz(),
                    ));
                }
            });
        })
        .expect("match simulation thread should start");
}

impl MatchState {
    fn current_server_time_ms(&self) -> u32 {
        self.server_tick * (1000 / SIM_HZ as u32)
    }

    fn resolve_vehicle_runtime_id(&self, wire_vehicle_id: u32) -> Option<u32> {
        if self.arena.vehicle_exists(wire_vehicle_id) {
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
                        inputs_skipped_for_catchup: 0,
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
                    protocol_version: vibe_land_shared::constants::PROTOCOL_VERSION,
                    physics_backend: self.physics.backend.wire_id(),
                    client_movement_mode: self.physics.client_movement_mode(),
                    sim_hz: SIM_HZ,
                    snapshot_hz: self.physics.snapshot_hz(),
                    server_time_us,
                    interpolation_delay_ms: self.physics.interpolation_delay_ms(),
                });
                let _ = try_queue_packet(&conn.tx, encode_server_packet(&welcome), &self.io);
                self.send_initial_metadata(&conn.tx);
                self.queue_roster_sync();

                if let Some(city) = self.city.as_mut() {
                    city.add_client(u64::from(conn.player_id));
                    // Manifest first: it describes the geometry every later city
                    // packet refers to, so a client cannot use bootstrap without it.
                    if let Some((_, _, gzipped)) = city::manifest_asset() {
                        let mut packet = Vec::with_capacity(gzipped.len() + 1);
                        packet.push(vibe_land_shared::constants::PKT_CITY_MANIFEST);
                        packet.extend_from_slice(gzipped);
                        let _ = try_queue_packet(&conn.tx, packet, &self.io);
                    }
                    // A bootstrap dropped here is the worst case of all: the
                    // client never had a ledger, so it never sees a sequence
                    // gap either -- it renders the intact manifest forever and
                    // reports nothing wrong. Enrol it for repair instead.
                    let mut delivered =
                        try_queue_packet(&conn.tx, city.bootstrap(self.server_tick), &self.io);
                    if let Some(lanes) = city.full_lane_map() {
                        delivered = try_queue_packet(&conn.tx, lanes, &self.io) && delivered;
                    }
                    if !delivered {
                        warn!(
                            match_id = %self.id,
                            player_id = conn.player_id,
                            "city bootstrap dropped at join; scheduling repair"
                        );
                        self.city_desync_players.insert(conn.player_id);
                    }
                }

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
                if let Some(city) = self.city.as_mut() {
                    city.remove_client(u64::from(player_id));
                }
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
                let is_dead = self.arena.player_is_dead(player_id);
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
                                let can_enter = self
                                    .arena
                                    .player_state(player_id)
                                    .and_then(|player| {
                                        self.arena
                                            .snapshot_vehicles()
                                            .into_iter()
                                            .find(|vehicle| vehicle.id == vehicle_id)
                                            .map(|vehicle| {
                                                let dx = player.position.x as f32
                                                    - mm_to_meters(vehicle.px_mm);
                                                let dy = player.position.y as f32
                                                    - mm_to_meters(vehicle.py_mm);
                                                let dz = player.position.z as f32
                                                    - mm_to_meters(vehicle.pz_mm);
                                                (vehicle.driver_id == 0
                                                    || vehicle.driver_id == player_id)
                                                    && dx * dx + dy * dy + dz * dz
                                                        <= VEHICLE_INTERACT_RADIUS_M
                                                            * VEHICLE_INTERACT_RADIUS_M
                                            })
                                    })
                                    .unwrap_or(false);
                                if can_enter {
                                    self.arena.enter_vehicle(player_id, vehicle_id);
                                }
                                if self.arena.player_vehicle_id(player_id) == Some(vehicle_id) {
                                    if let Some(runtime) = self.players.get_mut(&player_id) {
                                        clear_runtime_inputs_for_vehicle_entry(runtime);
                                    }
                                }
                            }
                        }
                    }
                    ClientPacket::VehicleExit(cmd) => {
                        if !is_dead {
                            if self.resolve_vehicle_runtime_id(cmd.vehicle_id).is_some_and(
                                |vehicle_id| {
                                    self.arena.player_vehicle_id(player_id) == Some(vehicle_id)
                                },
                            ) {
                                self.arena.exit_vehicle(player_id);
                            }
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
                    ClientPacket::CityNack { bodies } => {
                        if let Some(city) = self.city.as_mut() {
                            city.restate_bodies(&bodies);
                        }
                    }
                    ClientPacket::CityResyncRequest {
                        last_topo_seq,
                        structures,
                    } => {
                        if let Some(city) = self.city.as_mut() {
                            if structures.is_empty() {
                                info!(
                                    match_id = %self.id,
                                    player_id,
                                    last_topo_seq,
                                    "city topology resync requested; sending bootstrap"
                                );
                                let bootstrap = city.bootstrap(self.server_tick);
                                let _ = try_queue_packet(&runtime.tx, bootstrap, &self.io);
                            } else {
                                // Hash mismatch named the structures — this is
                                // the detector actually firing, so the repair
                                // counter finally means what it says.
                                info!(
                                    match_id = %self.id,
                                    player_id,
                                    last_topo_seq,
                                    ?structures,
                                    "city ledger hash mismatch; sending structure bootstrap"
                                );
                                let bootstrap =
                                    city.structure_bootstrap(self.server_tick, &structures);
                                if try_queue_packet(&runtime.tx, bootstrap, &self.io) {
                                    self.city_desync_repairs += 1;
                                }
                            }
                            if let Some(lanes) = city.full_lane_map() {
                                let _ = try_queue_packet(&runtime.tx, lanes, &self.io);
                            }
                            // The datagram-side half of a resync: every lane
                            // restates absolutely over the coming spans.
                            city.begin_join_restate();
                        }
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
            if self.arena.is_player_in_vehicle(player_id) {
                players_in_vehicles += 1.0;
            }
            if self.arena.player_is_dead(player_id) {
                dead_players_skipped += 1.0;
            }
            let (previous_input, was_on_ground) = self
                .arena
                .player_state(player_id)
                .map(|state| (state.last_input, state.on_ground))
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
                        self.arena.is_player_in_vehicle(player_id),
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

        // Fracture-frame resimulation capture. Must be immediately before the
        // step: taken any later, the destruction tick has already drained the
        // contact queue and the capture is against the wrong frame.
        #[cfg(feature = "destruction")]
        {
            let mut city = self.city.take();
            if let Some(city_ref) = city.as_mut() {
                city_ref.pre_step(self.arena.physx_world_mut());
            }
            self.city = city;
        }
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

        let alive_player_ids = self.arena.alive_player_ids();
        for &player_id in &alive_player_ids {
            let gained_energy: f32 = self
                .arena
                .collect_batteries_for_player(player_id)
                .into_iter()
                .map(|(_, energy)| energy)
                .sum();
            if gained_energy > 0.0 {
                let _ = self.arena.add_player_energy(player_id, gained_energy);
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

        self.route_city_shots();

        let hitscan_started = Instant::now();
        self.process_hitscan(server_time_ms);
        self.timings
            .hitscan_ms
            .record(hitscan_started.elapsed().as_secs_f32() * 1000.0);
        self.process_melee(server_time_ms);

        self.sync_reliable_world_state();

        self.tick_city(dt);

        if self.server_tick % (SIM_HZ as u32 / self.physics.snapshot_hz() as u32) == 0 {
            self.broadcast_snapshot();
        }

        if self.server_tick % PLAYER_ROSTER_SYNC_INTERVAL_TICKS == 0 {
            self.queue_roster_sync();
        }

        if self.server_tick % SERVER_PING_INTERVAL_TICKS == 0 {
            let publish_started = Instant::now();
            self.send_server_latency_pings();
            self.publish_stats();
            self.log_city_telemetry();
            self.last_publish_ms = publish_started.elapsed().as_secs_f32() * 1000.0;
        }

        self.timings
            .total_ms
            .record(tick_started.elapsed().as_secs_f32() * 1000.0);
    }

    /// Re-bootstrap clients whose ledger we know is holed.
    ///
    /// The same repair the client asks for when it spots a sequence gap, driven
    /// from the server instead -- because the gap it would spot is not
    /// guaranteed to exist. A client that loses topology from the very first
    /// message never sees a discontinuity at all: it holds an intact city,
    /// reports zero gaps, and waits forever. The server is the only party that
    /// knows a drop happened, so it is the party that has to fix it.
    ///
    /// Deferred until the client's queue has drained, since re-sending into a
    /// full queue is what caused the hole in the first place.
    fn repair_city_desyncs(&mut self) {
        if self.city_desync_players.is_empty() {
            return;
        }
        // Enough headroom for bootstrap + lane map plus the tick's ordinary
        // traffic; a queue that is merely no longer full will overflow again.
        const REPAIR_HEADROOM: usize = PLAYER_OUTBOUND_QUEUE_CAPACITY / 2;
        let ready: Vec<u32> = self
            .city_desync_players
            .iter()
            .copied()
            .filter(|player_id| {
                self.players
                    .get(player_id)
                    .is_none_or(|runtime| runtime.tx.capacity() >= REPAIR_HEADROOM)
            })
            .collect();
        for player_id in ready {
            self.city_desync_players.remove(&player_id);
            let Some(runtime) = self.players.get(&player_id) else {
                // Gone; nothing to repair.
                continue;
            };
            let Some(city) = self.city.as_mut() else {
                continue;
            };
            let bootstrap = city.bootstrap(self.server_tick);
            let lanes = city.full_lane_map();
            // The datagram half: every lane restates absolutely over the
            // coming spans, so poses match the freshly-bootstrapped ledger.
            city.begin_join_restate();
            let queued = try_queue_packet(&runtime.tx, bootstrap, &self.io)
                && lanes.is_none_or(|lanes| try_queue_packet(&runtime.tx, lanes, &self.io));
            if queued {
                self.city_desync_repairs += 1;
                info!(
                    match_id = %self.id,
                    player_id,
                    "city ledger repaired: bootstrap re-sent after a dropped reliable packet"
                );
            } else {
                // Still congested -- try again next tick rather than leaving
                // the client holed.
                self.city_desync_players.insert(player_id);
            }
        }
    }

    /// Route queued hitscan shots into city destruction before
    /// `process_hitscan` drains them (players/vehicles still take the same
    /// hitscan resolution afterwards).
    fn route_city_shots(&mut self) {
        if self.city.is_none() {
            return;
        }
        let shots: Vec<(glam::Vec3, glam::Vec3)> = self
            .queued_shots
            .iter()
            .filter_map(|queued| {
                let state = self.arena.player_state(queued.player_id)?;
                if state.dead {
                    return None;
                }
                Some((
                    glam::Vec3::new(
                        state.position.x as f32,
                        state.position.y as f32 + PLAYER_EYE_HEIGHT_M,
                        state.position.z as f32,
                    ),
                    glam::Vec3::from_array(queued.cmd.dir),
                ))
            })
            .collect();
        let shot_count = shots.len();
        let mut city = self.city.take().expect("checked above");
        let broken_before = city.stats().broken_bonds;
        let mut hits = 0u32;
        for (origin, direction) in shots {
            #[cfg(feature = "destruction")]
            let world = self.arena.physx_world_mut();
            #[cfg(not(feature = "destruction"))]
            let world = None;
            if city.apply_shot_ray(origin, direction, world) {
                hits += 1;
            }
        }
        if shot_count > 0 {
            tracing::info!(
                match_id = %self.id,
                shots = shot_count,
                hits,
                broken_bonds_before = broken_before,
                "city shot routing"
            );
        }
        self.city = Some(city);
    }

    /// Camera used for per-client interest: player eye + aim direction, using
    /// the same yaw/pitch convention as the client's aimDirectionFromAngles.
    fn city_camera_for_player(&self, player_id: u32) -> Option<vibe_land_destruction::types::Camera> {
        let state = self.arena.player_state(player_id)?;
        let yaw = state.last_input.yaw;
        let pitch = state.last_input.pitch;
        let cos_pitch = pitch.cos();
        Some(vibe_land_destruction::types::Camera {
            eye: glam::Vec3::new(
                state.position.x as f32,
                state.position.y as f32 + PLAYER_EYE_HEIGHT_M,
                state.position.z as f32,
            ),
            direction: glam::Vec3::new(
                yaw.sin() * cos_pitch,
                pitch.sin(),
                yaw.cos() * cos_pitch,
            ),
            fov_degrees: 80.0,
        })
    }

    fn tick_city(&mut self, dt: f32) {
        let Some(send_interval) = self.city.as_ref().map(|city| city.send_interval_ticks())
        else {
            return;
        };
        let send_due = self.server_tick % send_interval == 0 && !self.players.is_empty();
        // Cameras are precomputed so the arena borrow ends before the city
        // runtime is borrowed mutably.
        let cameras: Vec<(u32, vibe_land_destruction::types::Camera)> = if send_due {
            self.players
                .keys()
                .filter_map(|&id| self.city_camera_for_player(id).map(|camera| (id, camera)))
                .collect()
        } else {
            Vec::new()
        };

        let mut city = self.city.take().expect("checked above");
        #[cfg(feature = "destruction")]
        let world = self.arena.physx_world_mut();
        #[cfg(not(feature = "destruction"))]
        let world = None;
        // Between steps is the only safe point to rebuild: the scene is not
        // mid-simulate, and the bootstrap we send afterwards describes the
        // city the very next step will advance.
        let reset_requested = self
            .reset_requests
            .write()
            .expect("reset requests poisoned")
            .remove(&self.id);
        if reset_requested {
            match city.reset(SIM_HZ as u32, world) {
                Ok(()) => {
                    // The client ledger still describes the demolished city and
                    // no incremental topology event can say "start over", so
                    // every client needs a fresh bootstrap.
                    let bootstrap = city.bootstrap(self.server_tick);
                    // Wire v3: the rebuilt encoder restarts lane ids and its
                    // epoch, so a bootstrap alone leaves every client holding
                    // a lane map for a world that no longer exists. Send the
                    // new map beside it and restate every body, exactly as
                    // join and resync do.
                    let lanes = city.full_lane_map();
                    city.begin_join_restate();
                    for runtime in self.players.values() {
                        let _ =
                            try_queue_packet(&runtime.tx, bootstrap.clone(), &self.io);
                        if let Some(lanes) = lanes.clone() {
                            let _ = try_queue_packet(&runtime.tx, lanes, &self.io);
                        }
                    }
                    tracing::info!(
                        match_id = %self.id,
                        players = self.players.len(),
                        "city reset; re-bootstrapped clients"
                    );
                }
                Err(error) => {
                    tracing::error!(match_id = %self.id, %error, "city reset failed");
                }
            }
        }
        #[cfg(feature = "destruction")]
        let world = self.arena.physx_world_mut();
        #[cfg(not(feature = "destruction"))]
        let world = None;
        let broken_before = city.stats().broken_bonds;
        let awake_before = city.stats().awake_chunk_bodies;
        // 60 Hz: destruction step + reliable topology/baseline broadcast
        // (byte-identical for every client — encode once, clone the buffer).
        let city_step_started = std::time::Instant::now();
        let reliable = city.step(
            self.server_tick,
            dt,
            vibe_netcode::movement::default_world_gravity(),
            world,
        );
        let city_step_wall_ms = city_step_started.elapsed().as_secs_f32() * 1000.0;
        city.record_tick_sample(city_step_wall_ms);
        let v3_datagrams = city.take_v3_datagrams();
        let broken_after = city.stats().broken_bonds;
        let awake_after = city.stats().awake_chunk_bodies;
        if broken_after > broken_before || awake_after > awake_before {
            tracing::info!(
                match_id = %self.id,
                tick = self.server_tick,
                broken_bonds_before = broken_before,
                broken_bonds_after = broken_after,
                delta_broken = broken_after.saturating_sub(broken_before),
                awake_before,
                awake_after,
                "city stress fracture (queueContact → broken bonds)"
            );
        }
        let fan_out_started = std::time::Instant::now();
        // A dropped topology message is NOT a lost frame -- it is a permanent
        // hole in the client's world model. The ledger is a delta stream, so a
        // client that misses one renders a city that stops being destroyed and
        // never recovers on its own (observed live: server at topo_seq 951 and
        // 1,980 broken bonds while the client's ledger read zero). The drop is
        // detectable exactly when it happens, so record who it happened to and
        // repair them authoritatively below.
        let mut desynced: Vec<u32> = Vec::new();
        for packet in &reliable {
            for (player_id, runtime) in self.players.iter() {
                if !try_queue_packet(&runtime.tx, packet.clone(), &self.io)
                    && !desynced.contains(player_id)
                {
                    desynced.push(*player_id);
                }
            }
        }
        // Wire v3: span-based, encode-once pose datagrams -- the same bytes go
        // to every client, so nobody can be starved by a per-client ranking
        // (measured leaving moving bodies 40+ s stale on v2, and shown on
        // video displaying a different scene than the simulation).
        for packet in &v3_datagrams {
            for runtime in self.players.values() {
                let _ = try_queue_packet(&runtime.tx, packet.clone(), &self.io);
            }
        }
        self.last_fan_out_ms = fan_out_started.elapsed().as_secs_f32() * 1000.0;
        for player_id in desynced {
            if self.city_desync_players.insert(player_id) {
                warn!(
                    match_id = %self.id,
                    player_id,
                    "city ledger desynced: reliable packet dropped on a full client queue"
                );
            }
        }
        self.repair_city_desyncs();
        // Chunk stream cadence (wire v2 only): shared encode once, per-client
        // interest + ceiling selection, own datagram sequence space per client.
        let v2_pose_stream = v3_datagrams.is_empty()
            && city.wire_version() != vibe_land_destruction::wire::CITY_WIRE_V3;
        if send_due && v2_pose_stream {
            // Timed because it was the single largest unmeasured cost: at 10k
            // bodies the tick was 44 ms while the city step and physx step
            // together accounted for only 26 ms. encode_shared walks every
            // active body, and client_datagrams walks all of its records again
            // PER CLIENT doing interest tests -- so this scales with bodies
            // times players, and nothing reported it.
            let encode_started = std::time::Instant::now();
            let shared = city.encode_shared(self.server_tick);
            let shared_ms = encode_started.elapsed().as_secs_f32() * 1000.0;
            let datagrams_started = std::time::Instant::now();
            if !shared.records.is_empty() {
                for (player_id, camera) in cameras {
                    let packets = city.client_datagrams(u64::from(player_id), camera, &shared);
                    if let Some(runtime) = self.players.get(&player_id) {
                        for packet in packets {
                            let _ = try_queue_packet(&runtime.tx, packet, &self.io);
                        }
                    }
                }
            }
            city.record_encode_timings(
                shared_ms,
                datagrams_started.elapsed().as_secs_f32() * 1000.0,
            );
        }
        self.city = Some(city);
    }

    /// 1 Hz destructible-city telemetry: stream volume, encode cost, and the
    /// live/awake body split. Silent on non-city matches.
    fn log_city_telemetry(&mut self) {
        let players = self.players.len();
        let Some(city) = self.city.as_mut() else {
            return;
        };
        let (records, bytes, packets) = city.take_stream_counters();
        let stats = city.stats();
        let encoder = city.encoder_stats();
        if bytes == 0 && stats.chunk_bodies == 0 {
            return;
        }
        info!(
            match_id = %self.id,
            players,
            chunk_bodies = stats.chunk_bodies,
            awake_bodies = stats.awake_chunk_bodies,
            encoder_awake = encoder.awake_bodies,
            broken_bonds = stats.broken_bonds,
            packets_per_sec = packets,
            records_per_sec = records,
            kbytes_per_sec = bytes / 1024,
            mbps = (bytes as f32 * 8.0 / 1_000_000.0),
            encode_ms = city.last_encode_ms,
            topo_seq = encoder.topo_seq,
            baseline_id = encoder.baseline_id,
            // Non-zero means two island bodies claimed the same network id;
            // the encoder drops the duplicate rather than failing the match.
            duplicate_body_records = encoder.duplicate_body_records,
            min_body_y = stats.min_body_y,
            settle_deferred = stats.settle_deferred_penetrating,
            unmapped_body_skips = stats.unmapped_body_skips,
            resettled_wakes = stats.resettled_wakes,
            solve_ms = stats.solve_ms,
            readback_ms = stats.readback_ms,
            events_ms = stats.events_ms,
            filters_ms = stats.filters_ms,
            sleeping_bodies = stats.sleeping_chunk_bodies,
            overstressed_bonds = stats.overstressed_bonds,
            bond_utilisation_max = stats.bond_utilisation_max,
            "city stream"
        );
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

        let (dynamic_body_count, vehicle_count, battery_count) = self.arena.counts();
        let physics_health = self.arena.health();
        let city_window = self
            .city
            .as_mut()
            .map(|city| city.tick_window.drain())
            .unwrap_or_default();
        // Drained in the same pass, so the phase windows cover exactly the
        // same ticks as window_step_ms rather than a shifted window.
        let phase_windows = self
            .city
            .as_mut()
            .map(|city| city.tick_window.phases.drain())
            .unwrap_or_default();
        let match_stats = MatchStatsSnapshot {
            id: self.id.clone(),
            scenario_tag: self.id.clone(),
            server_build: server_build_stamp(),
            server_started: server_started_stamp(),
            physics_backend: self.physics.backend.name().to_string(),
            physics_gpu_required: self.physics.capabilities.gpu_required,
            physics_gpu_active: physics_health.gpu_active,
            physics_gpu_warning_count: physics_health.gpu_warning_count,
            physics_contact_pairs: physics_health.contact_pairs,
            physics_gpu_rigid_contact_high_water: physics_health.gpu_rigid_contact_high_water,
            physics_gpu_rigid_patch_high_water: physics_health.gpu_rigid_patch_high_water,
            physics_gpu_max_rigid_contacts: physics_health.gpu_max_rigid_contacts,
            physics_gpu_max_rigid_patches: physics_health.gpu_max_rigid_patches,
            physics_active_dynamic_bodies: physics_health.active_dynamic_bodies,
            physics_last_step_ms: physics_health.last_step_ms,
            physics_simulate_ms: physics_health.last_simulate_ms,
            physics_fetch_ms: physics_health.last_fetch_ms,
            physics_gpu_wait_ms: physics_health.last_gpu_wait_ms,
            physics_fetch_copy_ms: physics_health.last_fetch_copy_ms,
            physics_readback_ms: physics_health.last_readback_ms,
            physics_refresh_players_ms: physics_health.last_refresh_players_ms,
            physics_vehicle_control_ms: physics_health.last_vehicle_control_ms,
            physics_controller_ms: physics_health.last_controller_ms,
            server_tick: self.server_tick,
            player_count: self.players.len(),
            dynamic_body_count,
            vehicle_count,
            battery_count,
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
            city: self.city.as_ref().map(|city| {
                let stats = city.stats();
                let city_window = city_window.clone();
                let encoder = city.encoder_stats();
                let (records, bytes, packets) = city.last_stream_counters();
                let encode_timings = city.last_encode_timings();
                CityStatsSnapshot {
                    structures: stats.structures,
                    wire_version: city.wire_version(),
                    v3_span_ticks: city.governor_snapshot().0,
                    v3_rate_scale: city.governor_snapshot().1,
                    v3_ema_mbps: city.governor_snapshot().2,
                    v3_epoch: city.governor_snapshot().3,
                    v3_span_encode_ms: city.governor_snapshot().4,
                    window_step_ms: city_window.0.clone(),
                    window_ingest_ms: city_window.1.clone(),
                    window_span_encode_ms: city_window.2.clone(),
                    window_awake: city_window.3.clone(),
                    phase_windows: phase_windows.clone(),
                    chunk_bodies: stats.chunk_bodies,
                    awake_bodies: stats.awake_chunk_bodies,
                    broken_bonds: stats.broken_bonds,
                    step_ms: city.last_encode_ms,
                    stress_solve_ms: stats.stress_solve_ms,
                    solve_ms: stats.solve_ms,
                    readback_ms: stats.readback_ms,
                    events_ms: stats.events_ms,
                    begin_ms: stats.begin_ms,
                    end_ms: stats.end_ms,
                    readback_ms_host: stats.readback_ms_host,
                    settle_ms: stats.settle_ms,
                    ingest_ms: stats.ingest_ms,
                    tick_ffi_ms: stats.tick_ffi_ms,
                    drain_ms: stats.drain_ms,
                    stats_ffi_ms: stats.stats_ffi_ms,
                    post_step_ms: stats.post_step_ms,
                    fan_out_ms: self.last_fan_out_ms,
                    city_desync_repairs: self.city_desync_repairs,
                    publish_ms: self.last_publish_ms,
                    encode_shared_ms: encode_timings.0,
                    client_datagrams_ms: encode_timings.1,
                    gpu_stress_structures: stats.gpu_stress_structures,
                    gpu_stress_solve_ms: stats.gpu_stress_solve_ms,
                    filters_ms: stats.filters_ms,
                    ccd_ms: stats.ccd_ms,
                    support_loads_ms: stats.support_loads_ms,
                    support_pair_loads: stats.support_pair_loads,
                    shape_readback_ms: stats.shape_readback_ms,
                    blast_contact_processing_ms: stats.blast_contact_processing_ms,
                    blast_gravity_ms: stats.blast_gravity_ms,
                    blast_stress_solve_cpu_ms: stats.blast_stress_solve_cpu_ms,
                    blast_fracture_topology_ms: stats.blast_fracture_topology_ms,
                    blast_mapping_validation_ms: stats.blast_mapping_validation_ms,
                    blast_fracture_generate_ms: stats.blast_fracture_generate_ms,
                    blast_fracture_prep_ms: stats.blast_fracture_prep_ms,
                    blast_fracture_apply_ms: stats.blast_fracture_apply_ms,
                    blast_fracture_scene_ms: stats.blast_fracture_scene_ms,
                    blast_fracture_rebuild_ms: stats.blast_fracture_rebuild_ms,
                    blast_sleeping_actors_skipped: stats.blast_sleeping_actors_skipped,
                    slot_dispatch_ms: stats.slot_dispatch_ms,
                    bond_sample_ms: stats.bond_sample_ms,
                    quiet_slot_ticks: stats.quiet_slot_ticks,
                    contacts_queued: stats.contacts_queued,
                    contacts_processed: stats.contacts_processed,
                    contacts_dropped: stats.contacts_dropped,
                    solver_islands_skipped_accum: stats.solver_islands_skipped_accum,
                    solver_islands_total_accum: stats.solver_islands_total_accum,
                    escaped_bodies_parked: stats.escaped_bodies_parked,
                    ccd_tracked_bodies: stats.ccd_tracked_bodies,
                    identity_stamped_bodies: stats.identity_stamped_bodies,
                    sleeping_bodies: stats.sleeping_chunk_bodies,
                    overstressed_bonds: stats.overstressed_bonds,
                    bond_utilisation_max: stats.bond_utilisation_max,
                    bonds_above_half_utilisation: stats.bonds_above_half_utilisation,
                    packets_per_sec: packets,
                    records_per_sec: records,
                    bytes_per_sec: bytes,
                    topo_seq: encoder.topo_seq,
                    baseline_id: encoder.baseline_id,
                    min_body_y: stats.min_body_y,
                    resettled_wakes: stats.resettled_wakes,
                    settle_deferred_penetrating: stats.settle_deferred_penetrating,
                    unmapped_body_skips: stats.unmapped_body_skips,
                    duplicate_body_records: encoder.duplicate_body_records,
                    solver_island_count: stats.solver_island_count,
                    solver_islands_skipped: stats.solver_islands_skipped,
                    frozen_bodies: stats.frozen_chunk_bodies,
                    freeze_flips: stats.freeze_flips,
                    unfreeze_flips: stats.unfreeze_flips,
                    contact_wakes: stats.contact_wakes,
                    chunk_sleep_events: stats.chunk_sleep_events,
                    chunk_wake_events: stats.chunk_wake_events,
                    pose_quiet_awake_bodies: stats.pose_quiet_awake_bodies,
                    unsupported_resting_bodies: stats.unsupported_resting_bodies,
                    backstop_releases: stats.backstop_releases,
                    frozen_serial_blocks: stats.frozen_serial_blocks,
                    degraded: city.is_degraded(),
                }
            }),
        };

        // Everything that follows -- JSON serialization, a packet clone per
        // player, the registry writes, and a blocking telemetry file write --
        // used to run inline on the tick thread once a second. It is the one
        // block whose cost is unrelated to the simulation and lands entirely
        // on a single tick, which is what a 182.9 ms outlier looks like from
        // the outside. The tick thread now only CAPTURES (a struct build and
        // a compact per-body state Vec) and hands the rest to a blocking
        // task; nothing here feeds the next tick, so lateness is harmless.
        let body_states = self
            .city
            .as_ref()
            .map(|city| (self.id.clone(), city.debug_body_states()));
        let player_txs: Vec<_> = self
            .players
            .values()
            .map(|runtime| runtime.tx.clone())
            .collect();
        let io = Arc::clone(&self.io);
        let stats_registry = Arc::clone(&self.stats_registry);
        let body_states_registry = Arc::clone(&self.body_states_registry);
        let stats_tx = Arc::clone(&self.stats_tx);
        let match_id = self.id.clone();
        let server_tick = self.server_tick;
        let snapshot_hz = self.physics.snapshot_hz();
        let published = match_stats.clone();
        tokio::task::spawn_blocking(move || {
            // Same snapshot the HTTP endpoint serves, pushed to the players it
            // describes. Reliable rather than datagram: it is ~1 Hz and being
            // truncated by an MTU would make it unparseable.
            if !player_txs.is_empty() {
                match serde_json::to_vec(&published) {
                    Ok(json) => {
                        let mut packet = Vec::with_capacity(json.len() + 1);
                        packet.push(vibe_land_shared::constants::PKT_MATCH_STATS);
                        packet.extend_from_slice(&json);
                        for tx in &player_txs {
                            let _ = try_queue_packet(tx, packet.clone(), &io);
                        }
                    }
                    Err(err) => {
                        warn!(match_id = %match_id, error = ?err, "match stats serialize failed")
                    }
                }
            }

            // Persistent server-side telemetry: the exact snapshot players see,
            // appended as JSONL so any session can be analyzed retroactively --
            // bodies vs tick cost, governor behaviour, encoder spikes -- without
            // anyone screenshotting a panel. Enabled by VIBE_CITY_TELEMETRY=path.
            write_city_telemetry(server_tick, &published);

            let global = {
                let mut registry = stats_registry.write().expect("stats registry poisoned");
                registry.insert(match_id.clone(), published);
                global_stats_from_registry(&registry, snapshot_hz)
            };
            if let Some((id, states)) = body_states {
                // Per-body freeze states for the body-color debug overlay,
                // refreshed at the same cadence as the stats snapshot.
                body_states_registry
                    .write()
                    .expect("body states registry poisoned")
                    .insert(id, states);
            }
            let _ = stats_tx.send(global);
        });

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
                physx_simulate_ms = match_stats.physics_simulate_ms,
                physx_fetch_ms = match_stats.physics_fetch_ms,
                physx_controller_ms = match_stats.physics_controller_ms,
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
            self.arena.player_state(player_id).and_then(|state| {
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
        let _ = self.arena.add_player_energy(player_id, -f32::MAX);
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

            let Some(shooter_state) = self.arena.player_state(queued.player_id) else {
                continue;
            };
            if shooter_state.dead || self.arena.is_player_in_vehicle(queued.player_id) {
                continue;
            }

            let shooter_depleted = self
                .arena
                .add_player_energy(queued.player_id, -RIFLE_SHOT_ENERGY_COST)
                .is_some_and(|energy| energy <= 0.0);
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
                let prev_hp = self.arena.player_hp(hit.victim_id);
                let damage_outcome = self
                    .arena
                    .apply_player_damage(hit.victim_id, rifle_damage(hit.zone));
                let new_hp = self.arena.player_hp(hit.victim_id);
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

            if self.arena.is_player_in_vehicle(queued.player_id) {
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

            let depleted = self
                .arena
                .add_player_energy(queued.player_id, -MELEE_ENERGY_COST)
                .is_some_and(|energy| energy <= 0.0);
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
                    .player_ids()
                    .into_iter()
                    .filter(|id| *id != queued.player_id)
                    .collect();
                for victim_id in victim_ids {
                    if self.arena.is_player_in_vehicle(victim_id) {
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
                    if dist > 1e-4 {
                        let direction = [dx / dist, dy / dist, dz / dist];
                        let blocked_by_static = self
                            .arena
                            .cast_static_world_ray(eye, direction, dist, Some(queued.player_id))
                            .is_some_and(|toi| toi < dist - 0.1);
                        let blocked_by_dynamic = self
                            .arena
                            .cast_dynamic_body_ray(eye, direction, dist, Some(queued.player_id))
                            .is_some_and(|(_, toi, _)| toi < dist - 0.1);
                        if blocked_by_static || blocked_by_dynamic {
                            continue;
                        }
                    }
                    if best.map(|(_, d)| dist < d).unwrap_or(true) {
                        best = Some((victim_id, dist));
                    }
                }

                if let Some((victim_id, _)) = best {
                    let prev_hp = self.arena.player_hp(victim_id);
                    let damage_outcome = self.arena.apply_player_damage(victim_id, MELEE_DAMAGE);
                    let new_hp = self.arena.player_hp(victim_id);
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

            let support_state = self.arena.player_support(recipient_id);
            let support_dynamic_id = support_state
                .filter(|support| !support.is_vehicle)
                .map(|support| support.entity_id);
            let support_vehicle_id = support_state
                .filter(|support| support.is_vehicle)
                .map(|support| support.entity_id);
            let support = support_state.and_then(|support| {
                let handle = if support.is_vehicle {
                    self.vehicle_handles
                        .get(&support.entity_id)
                        .map(|handle| 0x8000 | u16::from(*handle))
                } else {
                    self.dynamic_body_handles
                        .get(&support.entity_id)
                        .map(|entry| entry.handle)
                }?;
                Some((
                    handle,
                    support.local_position.map(|value| {
                        (value * 400.0)
                            .round()
                            .clamp(i16::MIN as f32, i16::MAX as f32) as i16
                    }),
                    support.velocity.map(|value| {
                        (value * 100.0)
                            .round()
                            .clamp(i16::MIN as f32, i16::MAX as f32) as i16
                    }),
                    support.angular_velocity.map(|value| {
                        (value * 1000.0)
                            .round()
                            .clamp(i16::MIN as f32, i16::MAX as f32) as i16
                    }),
                    support.flags,
                ))
            });
            let self_state = protocol::SelfPlayerStateV2 {
                vx_cms: local_player_state.vx_cms,
                vy_cms: local_player_state.vy_cms,
                vz_cms: local_player_state.vz_cms,
                yaw_i16: local_player_state.yaw_i16,
                pitch_i16: local_player_state.pitch_i16,
                hp: local_player_state.hp,
                flags: (local_player_state.flags & 0xff) as u8,
                support_handle: support.map_or(0, |value| value.0),
                support_local_q2_5mm: support.map_or([0; 3], |value| value.1),
                support_velocity_cms: support.map_or([0; 3], |value| value.2),
                support_angular_velocity_mrads: support.map_or([0; 3], |value| value.3),
                support_flags: support.map_or(0, |value| value.4),
            };
            budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_SELF_PLAYER_BYTES);

            let mut reserved_vehicle_ids: HashSet<u32> = vehicle_states
                .iter()
                .filter(|(_, _, state)| state.driver_id == recipient_id)
                .take(STRICT_SNAPSHOT_RESERVED_VEHICLES)
                .map(|(vehicle_id, _, _)| *vehicle_id)
                .collect();
            if let Some(vehicle_id) = support_vehicle_id {
                reserved_vehicle_ids.insert(vehicle_id);
            }
            let reserved_vehicle_budget = reserved_vehicle_ids
                .len()
                .saturating_mul(SNAPSHOT_V2_VEHICLE_BYTES);
            budget_remaining = budget_remaining.saturating_sub(reserved_vehicle_budget);
            let reserved_support_dynamic_bytes = support_dynamic_id
                .and_then(|body_id| self.dynamic_body_handles.get(&body_id))
                .map(|meta| {
                    if meta.shape_type == SHAPE_SPHERE {
                        SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES
                    } else {
                        SNAPSHOT_V2_DYNAMIC_BOX_BYTES
                    }
                })
                .unwrap_or(0);
            budget_remaining = budget_remaining.saturating_sub(reserved_support_dynamic_bytes);

            let mut remote_player_states = Vec::new();
            let mut remote_player_candidates: Vec<_> = player_states
                .iter()
                .filter(|(player_id, pos, _)| {
                    *player_id != recipient_id
                        && distance_sq(*pos, *recipient_pos)
                            <= PLAYER_AOI_RADIUS_M * PLAYER_AOI_RADIUS_M
                })
                .collect();
            remote_player_candidates.sort_by(|a, b| {
                distance_sq(a.1, *recipient_pos).total_cmp(&distance_sq(b.1, *recipient_pos))
            });
            for (player_id, pos, state) in remote_player_candidates {
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
            for (vehicle_id, pos, state) in vehicle_states
                .iter()
                .filter(|(vehicle_id, _, _)| reserved_vehicle_ids.contains(vehicle_id))
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
                runtime
                    .last_sent_vehicle_tick
                    .insert(*vehicle_id, self.server_tick);
            }

            let mut vehicle_hot = Vec::new();
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
                    || periodic_refresh_due(
                        runtime.last_sent_vehicle_tick.get(vehicle_id).copied(),
                        self.server_tick,
                        COLD_VEHICLE_REFRESH_TICKS,
                    );
                if hot {
                    vehicle_hot.push((*vehicle_id, distance_sq(*pos, *recipient_pos), record));
                }
            }
            vehicle_hot.sort_by(|a, b| a.1.total_cmp(&b.1));

            for (vehicle_id, _, record) in vehicle_hot {
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
                let needs_refresh = periodic_refresh_due(
                    runtime.last_sent_dynamic_tick.get(body_id).copied(),
                    self.server_tick,
                    COLD_DYNAMIC_REFRESH_TICKS,
                );

                if meta.shape_type == SHAPE_SPHERE {
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
                    if support_dynamic_id == Some(*body_id)
                        || moving
                        || dist_sq <= HOT_DYNAMIC_NEAR_RADIUS_M * HOT_DYNAMIC_NEAR_RADIUS_M
                        || needs_refresh
                    {
                        dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Sphere(record)));
                    } else if needs_refresh {
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
                    if support_dynamic_id == Some(*body_id)
                        || moving
                        || dist_sq <= HOT_DYNAMIC_NEAR_RADIUS_M * HOT_DYNAMIC_NEAR_RADIUS_M
                        || needs_refresh
                    {
                        dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Box(record)));
                    } else if needs_refresh {
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
            if let Some(support_body_id) = support_dynamic_id {
                dynamic_hot.sort_by_key(|(body_id, _, _)| *body_id != support_body_id);
                dynamic_cold.sort_by_key(|(body_id, _, _)| *body_id != support_body_id);
            }

            let mut sphere_states = Vec::new();
            let mut box_states = Vec::new();
            for (body_id, _, selection) in dynamic_hot.into_iter().chain(dynamic_cold.into_iter()) {
                let record_size = match &selection {
                    DynamicBodySelection::Sphere(_) => SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES,
                    DynamicBodySelection::Box(_) => SNAPSHOT_V2_DYNAMIC_BOX_BYTES,
                };
                let reserved_support = support_dynamic_id == Some(body_id);
                if !reserved_support && budget_remaining < record_size {
                    continue;
                }
                match selection {
                    DynamicBodySelection::Sphere(record) => sphere_states.push(record),
                    DynamicBodySelection::Box(record) => box_states.push(record),
                }
                runtime
                    .last_sent_dynamic_tick
                    .insert(body_id, self.server_tick);
                if !reserved_support {
                    budget_remaining = budget_remaining.saturating_sub(record_size);
                }
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

/// Edge-triggered buttons: a press must survive a backlog collapse, because
/// skipping the frame it arrived on would swallow the action entirely.
/// Movement and hold-style buttons are level-triggered, so the newest frame
/// already carries the correct state and OR-ing them would fabricate input.
const LATCHED_BUTTONS: u16 = BTN_JUMP | BTN_RELOAD;

fn take_input_for_tick(runtime: &mut PlayerRuntime) -> InputCmd {
    // Stay current instead of draining a backlog.
    //
    // Clients send at a fixed 60 Hz. If the match loop falls behind (a heavy
    // city collapse pushed it to ~30-45 Hz), popping one frame per tick
    // consumes fewer than arrive, so the queue grows until it saturates at
    // MAX_PENDING_INPUTS = 120 — two seconds of input. Steady state is then
    // the server applying two-second-old movement and *yaw*, which feels like
    // walking in a direction you were facing a moment ago rather than like
    // lag. Vehicles already collapsed their backlog; on foot did not.
    //
    // Whatever else degrades, the player's own body should track their input,
    // so jump to the newest frame and keep only the latched presses from the
    // ones skipped.
    if runtime.pending_inputs.len() >= PLAYER_INPUT_CATCHUP_THRESHOLD {
        if let Some(mut newest) = runtime.pending_inputs.pop_back() {
            let mut latched = 0u16;
            for skipped in runtime.pending_inputs.iter() {
                latched |= skipped.buttons & LATCHED_BUTTONS;
            }
            runtime.inputs_skipped_for_catchup += runtime.pending_inputs.len() as u64;
            runtime.pending_inputs.clear();
            newest.buttons |= latched;
            runtime.last_ack_input_seq = newest.seq;
            runtime.last_applied_input = newest.clone();
            return newest;
        }
    }
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
    arena.awake_dynamic_body_counts(player_centers, HOT_DYNAMIC_NEAR_RADIUS_M)
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

fn periodic_refresh_due(last_sent_tick: Option<u32>, current_tick: u32, interval: u32) -> bool {
    last_sent_tick
        .map(|last| current_tick.saturating_sub(last) >= interval)
        .unwrap_or(true)
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

/// Append one telemetry line: `{"ts_ms":..,"tick":..,"stats":{...}}`.
/// File is opened (truncated) on first write per process, so one file = one
/// world lifetime, matching "restart is the reset".
fn write_city_telemetry(tick: u32, stats: &MatchStatsSnapshot) {
    use std::io::Write as _;
    static SINK: std::sync::OnceLock<
        Option<std::sync::Mutex<std::io::BufWriter<std::fs::File>>>,
    > = std::sync::OnceLock::new();
    let sink = SINK.get_or_init(|| {
        let path = std::env::var("VIBE_CITY_TELEMETRY").ok()?;
        let file = std::fs::File::create(&path)
            .map_err(|error| {
                warn!(path = %path, ?error, "city telemetry sink failed to open");
                error
            })
            .ok()?;
        Some(std::sync::Mutex::new(std::io::BufWriter::new(file)))
    });
    let Some(sink) = sink else { return };
    let Ok(json) = serde_json::to_string(stats) else { return };
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut writer) = sink.lock() {
        let _ = writeln!(writer, "{{\"ts_ms\":{ts_ms},\"tick\":{tick},\"stats\":{json}}}");
        let _ = writer.flush();
    }
}

fn wants_unreliable_delivery(kind: u8) -> bool {
    is_snapshot_packet_kind(kind)
        || kind == PKT_PING
        || kind == PKT_CITY_CHUNKS
        || kind == vibe_land_shared::constants::PKT_CITY_DEBRIS
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
    // Droppable = the receiver recovers on its own. Pose streams do: v2 chunk
    // records are re-sent every tick, and v3 debris spans heal through the nack
    // loop and lane restatement (they ride unreliable datagrams by design
    // anyway). City TOPOLOGY does not -- it is a delta stream over the client's
    // ledger, so a hole in it is permanent. Under congestion the queue must
    // therefore shed poses, never state.
    let is_droppable = is_snapshot
        || packet.first().copied().is_some_and(|kind| {
            kind == PKT_PING || kind == PKT_CITY_CHUNKS || kind == PKT_CITY_DEBRIS
        });
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
    snapshot_hz: u16,
) -> GlobalStatsSnapshot {
    let mut matches: Vec<_> = registry.values().cloned().collect();
    matches.sort_by(|a, b| a.id.cmp(&b.id));
    GlobalStatsSnapshot {
        server_build_profile: server_build_profile().to_string(),
        sim_hz: SIM_HZ,
        snapshot_hz,
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
        parse_respawn_delay_ms, periodic_refresh_due, rifle_damage, server_build_profile,
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
            inputs_skipped_for_catchup: 0,
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

        let global = super::global_stats_from_registry(
            &registry,
            vibe_land_shared::constants::SNAPSHOT_HZ_MULTIPLAYER,
        );
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

    #[test]
    fn unchanged_state_recovers_after_periodic_refresh_window() {
        assert!(!periodic_refresh_due(Some(100), 159, 60));
        assert!(periodic_refresh_due(Some(100), 160, 60));
        assert!(periodic_refresh_due(None, 1, 60));
    }
}
