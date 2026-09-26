mod vehicle_assets;
mod garage;
mod garage_bombardment;
mod vehicle_tuning;
mod grass_layout;
mod app_config;
mod city;
mod contact_audio;
#[cfg(all(test, feature = "destruction"))]
mod city_bench;
#[cfg(all(test, feature = "physx-city"))]
mod city_qa;
#[cfg(all(test, feature = "native-destruction"))]
mod perf_bench;
mod demo_world;
mod energy_stream;
mod heartbeat;
mod lag_comp;
mod link_rate;
mod match_stats_frame;
mod meteor;
mod movement;
mod outbound;
#[cfg(feature = "physx-gpu")]
mod physx_runtime;
mod protocol;
mod send_log;
mod session_capture;
mod session_match;
mod snapshot_builder;
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
use futures_util::{sink::SinkExt, stream::StreamExt, FutureExt};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, RwLock as AsyncRwLock};
use tracing::{error, info, warn};
use vibe_land_shared::constants::{
    DEFAULT_BATTERY_HEIGHT_M, DEFAULT_BATTERY_RADIUS_M, DYNAMIC_BODY_IMPULSE, FLAG_MELEEING, HITSCAN_MAX_DISTANCE_M,
    MAX_PENDING_INPUTS, MELEE_COOLDOWN_MS, MELEE_DAMAGE, MELEE_ENERGY_COST,
    MAX_INPUT_FRAMES_PER_TICK,
    MELEE_FLAG_DURATION_TICKS, MELEE_HALF_CONE_COS, MELEE_HIT_RECOVERY_MS, MELEE_RANGE_M,
    OUT_OF_BOUNDS_Y_M, PLAYER_AOI_RADIUS_M, PLAYER_EYE_HEIGHT_M, RIFLE_BODY_DAMAGE,
    RIFLE_FIRE_INTERVAL_MS, RIFLE_HEAD_DAMAGE, RIFLE_SHOT_ENERGY_COST, SHAPE_SPHERE, SIM_HZ,
    SPAWN_PROTECTION_MS, VEHICLE_INPUT_CATCHUP_THRESHOLD,
    VEHICLE_INTERACT_RADIUS_M, WEAPON_CANNONBALL, WEAPON_METEOR,
};
use wtransport::{error::SendDatagramError, Connection, Endpoint, Identity, ServerConfig};

use crate::{
    app_config::PhysicsRuntimeConfig,
    demo_world::seed_world_for_match,
    lag_comp::{HistoricalCapsule, HistoricalDynamicBody, HitZone, LagCompHistory},
    movement::{MoveConfig, PhysicsArena, PlayerDamageOutcome},
    protocol::{
        client_datagram_to_packet, decode_client_datagram, decode_client_hello,
        decode_client_packet, encode_server_packet, energy_to_centi,
        make_net_battery_state, make_net_dynamic_body_state, make_net_player_state,
        make_net_shot_fired, meters_to_mm, mm_to_meters, BatterySyncPacket, ClientPacket,
        DamageEventPacket, FireCmd, InputCmd, LocalPlayerEnergyPacket, MeleeCmd, NetBatteryState,
        ServerPacket, ShotResultPacket, WelcomePacket, BTN_JUMP, BTN_RELOAD,
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

/// How many fired balls a match reserves ids and client metadata for.
///
/// Matches the arena's own live-ball ceiling: the ids are a ring, so this is
/// both the number of balls that can be in the air and the number of handles
/// the join-time metadata has to carry.
const CANNONBALL_POOL: usize = 24;
/// How many meteors a match reserves ids and client metadata for. A ring, like
/// the cannonball's: the ninth launch retires the first. Eight is more than
/// anyone can watch fall at once.
const METEOR_POOL: usize = 8;
const ROLLING_METRIC_SAMPLES: usize = 180;
/// Per-player queue depth for each delivery lane. Datagrams cannot occupy
/// reliable slots or wait behind a blocked reliable write. Exhausting reliable
/// capacity terminates that connection instead of leaving a holed state stream.
const PLAYER_OUTBOUND_QUEUE_CAPACITY: usize = 256;
/// A session that opens a stream and then says nothing holds a task and a QUIC
/// stream open; drop it rather than letting it accumulate.
const CLIENT_HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CLIENT_HELLO_BYTES: usize = 4096;
/// Client uplink packets are inputs and commands -- tens of bytes, not frames.
const MAX_CLIENT_STREAM_PACKET_BYTES: usize = 8192;
const PLAYER_HANDLE_REUSE_COOLDOWN_TICKS: u32 = SIM_HZ as u32 * 10;
const PLAYER_ROSTER_SYNC_INTERVAL_TICKS: u32 = SIM_HZ as u32 * 2;
use snapshot_builder::HOT_DYNAMIC_NEAR_RADIUS_M;
#[cfg(test)]
use snapshot_builder::periodic_refresh_due;
#[cfg(test)]
use vibe_land_shared::constants::{DYNAMIC_BODY_AOI_EXIT_RADIUS_M, DYNAMIC_BODY_AOI_RADIUS_M};
const MATCH_HEALTH_LOG_INTERVAL_TICKS: u32 = SIM_HZ as u32 * 10;
const SNAPSHOT_HEADER_BYTES: usize = 23;
const SNAPSHOT_PLAYER_STATE_BYTES: usize = 29;
const SNAPSHOT_DYNAMIC_BODY_STATE_BYTES: usize = 43;
const SNAPSHOT_VEHICLE_STATE_BYTES: usize = 50;

/// The server's wall clock for snapshot stamps: µs since the first call,
/// modulo 2^32. Clients only difference consecutive stamps, so the origin is
/// arbitrary and the wrap (every ~71 minutes) is unwrapped on their side.
fn server_wall_clock_us() -> u32 {
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let origin = *ORIGIN.get_or_init(Instant::now);
    (origin.elapsed().as_micros() % (1u128 << 32)) as u32
}

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

    /// Most recent sample (0 when empty). Exists for the tick residual,
    /// which must subtract this-tick values, not window aggregates.
    fn last(&self) -> f32 {
        self.values.back().copied().unwrap_or(0.0)
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
    /// 60 Hz input frames simulated per tick, summed over players. Reads 1.0
    /// per player at 60 Hz and rises as the tick slows — the direct evidence
    /// that the player's input stream is being consumed at the rate it was
    /// produced rather than dropped, which is what rubber-banding was.
    input_frames_per_tick: RollingSamples,
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
    /// Whole-tick city block (tick_city wall), so the residual below can
    /// subtract ONE bracket instead of guessing which city children overlap.
    city_total_ms: RollingSamples,
    /// total − (every timed block). The tick contains genuinely untimed work
    /// (respawns, spawn protection, batteries, melee, reliable-world sync,
    /// roster, collisions) — this is where bracket gaps and double-counts
    /// become a number instead of an invisible assumption. Client-side has
    /// had this for its frame since day one; the server never did.
    tick_unattributed_ms: RollingSamples,
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
    /// Post-fracture push re-apply, previously inside the `step_ms`
    /// unattributed remainder. A child of `step_ms`, sibling of `post_step_ms`.
    push_reapply_ms: f32,
    /// `step_ms` minus every child that claims part of it.
    step_residual_ms: f32,
    /// Host wall time of the whole native destruction tick, FFI hop included.
    /// A parent of the Blast phases and measurably larger than their sum.
    tick_ffi_ms: f32,
    /// Event drain (broken bonds, migrations, island events) and the
    /// destruction-stats FFI readback: two stages that were measured all along
    /// and never published, so `step_ms` minus its children over-reported the
    /// unattributed remainder.
    drain_ms: f32,
    /// Supporter ingest and freeze cascades: the bulk of what used to be the
    /// post_step remainder.
    support_ingest_ms: f32,
    cascade_ms: f32,
    /// Wall time of Runtime::post_step and what none of its children claim.
    /// Published so the accounting can be checked rather than believed.
    post_step_total_ms: f32,
    post_step_residual_ms: f32,
    stats_ffi_ms: f32,
    /// `backend.post_step` in full -- the parent of the destruction phases,
    /// measured by the host rather than summed from them.
    post_step_ms: f32,
    /// Fracture-frame resimulation, per tick: the pre-step capture (every
    /// tick), and on ticks that split, the rewind, the PhysX re-step and the
    /// second destruction tick. These are what a ~100 ms spike is made of.
    resim_capture_ms: f32,
    resim_restore_ms: f32,
    resim_step_ms: f32,
    resim_tick_ms: f32,
    resim_passes: u32,
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
    /// The stream encode (60 Hz; 30 Hz before): shared record build, then per-client interest
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
    /// The adapter's own per-phase timers, deltaed to per-tick — and
    /// **SUMMED ACROSS EVERY LIVE SLOT**, while `begin_ms`/`solve_ms`/
    /// `end_ms` are WALL-CLOCK around a loop whose slots run CONCURRENTLY on
    /// the stress pool. A `blast_*` number can therefore legitimately exceed
    /// its "parent" phase, and reading one as wall time nearly bought a CUDA
    /// gravity kernel for what is ~0.5 ms of wall. The old doc here equated
    /// them ("begin ≈ contact_processing + gravity") — that equation only
    /// holds when a single slot is live. Rough decomposition intuition per
    /// slot still applies: contact+gravity feed `begin`, stress_solve_cpu +
    /// gpu_stress feed `solve`, topology+validation feed `end` — but compare
    /// CPU-time sums with CPU-time sums, wall with wall, never across.
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
    /// P1b clusters: broadphase entries holding the frozen population, and
    /// how many frozen bodies sit inside them (the rest are standalone).
    frozen_aggregates: u32,
    frozen_aggregate_actors: u32,
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
    input_frames_per_tick: SummaryStatsSnapshot,
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
    city_total_ms: SummaryStatsSnapshot,
    /// total − every timed block, per tick. Persistently large means a
    /// bracket gap; persistently negative-before-clamp would mean overlap.
    tick_unattributed_ms: SummaryStatsSnapshot,
}

impl MatchTimingStats {
    fn snapshot(&self) -> MatchTimingSnapshot {
        MatchTimingSnapshot {
            total_ms: self.total_ms.snapshot(),
            player_sim_ms: self.player_sim_ms.snapshot(),
            input_frames_per_tick: self.input_frames_per_tick.snapshot(),
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
            city_total_ms: self.city_total_ms.snapshot(),
            tick_unattributed_ms: self.tick_unattributed_ms.snapshot(),
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
    /// The match's send log: current tick, and the session capture's sink
    /// while one runs. Shared with every connection's outbound queues.
    send_hub: Arc<send_log::SendLogHub>,
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

/// One generically-authored bridge metric in the snapshot. `k`: 0 wall-clock
/// ms, 1 slot-summed ms (NOT comparable to wall parents), 2 count.
#[derive(serde::Serialize, Clone, Debug, Default)]
struct SpanValue {
    v: f64,
    k: u8,
}

const TICK_RING_CAP: usize = 300;

/// One tick's headline numbers for the debug-report ring.
#[derive(serde::Serialize, Clone, Debug, Default)]
struct TickRingEntry {
    t: u32,
    total: f32,
    dyn_ms: f32,
    city: f32,
    awake: u32,
    frozen: u32,
    flips: u64,
}

#[derive(serde::Serialize, Clone, Default)]
struct MatchStatsSnapshot {
    id: String,
    scenario_tag: String,
    /// Generic named spans from the bridges, namespaced "physics/" and
    /// "destruction/". A new metric authored with one span_add call in C++
    /// lands here (and in traces and debug reports) with no struct plumbing.
    spans: std::collections::BTreeMap<String, SpanValue>,
    /// Env/build identity of THIS process, captured once at startup — the
    /// suite env gap survived three runs because nothing recorded what a run
    /// executed under. Constant per process; ~free at 1 Hz.
    fingerprint: Option<vibe_land_destruction::fingerprint::Fingerprint>,
    /// Last ~300 ticks of headline numbers. Populated ONLY on the registry
    /// copy (which the debug-report handler snapshots into server.json);
    /// empty — and therefore absent from the JSON — on the copy pushed to
    /// clients every second, which must stay lean.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tick_ring: Vec<TickRingEntry>,
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
    /// CPU-narrowphase pair count — NOT POPULATED under the GPU pipeline,
    /// where it read a confident 0 through every capture (185k contacts in
    /// flight, "0 pairs"). Absent under GPU rather than zero: a metric that
    /// cannot be measured must not look like a measurement. GPU pair
    /// activity lives in the spans (gpu_found_lost_pairs) and the contact
    /// high-water fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    physics_contact_pairs: Option<u32>,
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
    /// Queued demolition requests, per match. See `city_demolish_handler`.
    demolish_requests: Arc<StdRwLock<HashMap<String, DemolishRequest>>>,
    /// Queued meteor targets, per match. See `city_meteor_handler`.
    meteor_requests: Arc<StdRwLock<HashMap<String, Vec<[f32; 3]>>>>,
    /// Matches asked to close their netlab capture cleanly.
    capture_stop_requests: Arc<StdRwLock<HashSet<String>>>,
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

/// Where and how a client connects. WebTransport only: this deliberately
/// carries no WebSocket URL, enabled or not, so nothing can discover or fall
/// back to the WebSocket game route from it.
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
    tx: outbound::Sender,
    /// What the city rate controller reads about this connection's link
    /// (WebTransport only).
    link: Option<Arc<dyn link_rate::LinkProbe>>,
}

enum MatchEvent {
    GarageBombardment { enabled: bool, reply: tokio::sync::oneshot::Sender<Result<garage_bombardment::Status, (StatusCode, String)>> },
    TuneGarageVehicle {
        expected_asset_hash: String,
        vehicle: vehicle_assets::PreparedVehicle,
        reply: tokio::sync::oneshot::Sender<Result<vehicle_tuning::TuneResponse, (StatusCode, String)>>,
    },
    PublishVehicle {
        asset: Arc<vehicle_assets::DrivableVehicle>,
        reply: tokio::sync::oneshot::Sender<Result<CityVehicleResponse, (StatusCode, String)>>,
    },
    Connect(PlayerConnection),
    Disconnect {
        player_id: u32,
    },
    Packet {
        player_id: u32,
        packet: ClientPacket,
    },
    /// Start or stop a paired session capture (HTTP, see `session_*_handler`).
    Session(session_match::SessionCommand),
}

struct PlayerRuntime {
    identity: String,
    transport: ClientTransport,
    tx: outbound::Sender,
    link: Option<Arc<dyn link_rate::LinkProbe>>,
    /// This client's city stream allowance and cadence, from its link.
    city_rate: link_rate::RateController,
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
    next_allowed_camera_drop_ms: u32,
    melee_flag_clear_tick: u32,
    spawn_protection_ends_at_tick: u32,
    respawn_at_ms: Option<u32>,
    /// The snapshot selection's memory of this recipient (see snapshot_builder).
    snapshot_interest: snapshot_builder::RecipientInterest,
    visible_batteries: HashSet<u32>,
    battery_full_resync_pending: bool,
    /// When this player's own energy is next worth sending.
    energy_gate: energy_stream::EnergySendGate,
}

type DynamicBodyMetaRuntime = snapshot_builder::BodyMeta;

impl From<movement::PlayerSupportState> for snapshot_builder::SupportInput {
    fn from(state: movement::PlayerSupportState) -> Self {
        Self {
            entity_id: state.entity_id,
            is_vehicle: state.is_vehicle,
            local_position: state.local_position,
            velocity: state.velocity,
            angular_velocity: state.angular_velocity,
            flags: state.flags,
        }
    }
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
    contact_audio: contact_audio::ContactAudioReducer,
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
    /// Last ~300 ticks of headline numbers for debug-report forensics. The
    /// 1 Hz snapshot cannot show spikes between report presses; this can.
    /// Rides only the REGISTRY copy of the snapshot (the report handler's
    /// source), never the packet pushed to clients.
    tick_ring: std::collections::VecDeque<TickRingEntry>,
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
    garage: Option<Arc<garage::Session>>,
    bombardment: garage_bombardment::Bombardment,
    custom_vehicles: HashMap<u32, Arc<vehicle_assets::DrivableVehicle>>,
    /// Where the next meteor comes from. Seeded per match so two matches do
    /// not rain from the same bearings in the same order.
    meteor_rng: meteor::Rng,
    reset_requests: Arc<StdRwLock<HashSet<String>>>,
    /// Queued demolition requests, per match. See `city_demolish_handler`.
    demolish_requests: Arc<StdRwLock<HashMap<String, DemolishRequest>>>,
    /// Queued meteor targets, per match. See `city_meteor_handler`.
    meteor_requests: Arc<StdRwLock<HashMap<String, Vec<[f32; 3]>>>>,
    capture_stop_requests: Arc<StdRwLock<HashSet<String>>>,
    /// Rounds the queued demolition releases per tick.
    demolish_per_tick: usize,
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
    /// Wall clock at the previous tick. The input budget is derived from it:
    /// the loop's MissedTickBehavior::Skip means simulated time falls behind
    /// real time under load, and the player's input stream must be consumed
    /// at the rate it was produced regardless.
    last_tick_instant: Option<Instant>,
    /// Unspent 60 Hz input frames owed by the passage of real time. Carries
    /// the fraction a rounded budget would discard.
    input_credit: f32,
    /// Observer pipeline (VIBE_CITY_OBSERVER_PIPELINE=1): tick N's deferred
    /// city observer bundle, flushed inside tick N+1's GPU wait. None when
    /// the flag is off, on non-city matches, and on staging-error ticks.
    staged_city: Option<city::StagedCityTick>,
    /// Wall time of the last deferred-bundle flush. Runs between the split
    /// step's halves, so neither dynamics_ms nor tick_city's bracket sees
    /// it; folded into city_total_ms so the tick residual stays honest.
    last_observer_flush_ms: f32,
    /// Meteors launched this tick and the time the launches took, for the
    /// per-tick capture record. Reset at the top of every tick.
    tick_meteors_launched: u32,
    tick_meteor_launch_ms: f32,
    /// The running paired session capture, if any; see `session_match`.
    session_capture: Option<session_capture::ActiveCapture>,
    session_max_us: u64,
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
    let websocket_game_enabled =
        websocket_game_transport_enabled(std::env::var(WEBSOCKET_GAME_TRANSPORT_ENV).ok().as_deref());
    if websocket_game_enabled {
        warn!(
            "WebSocket game transport ENABLED by {}=1: /ws/:match_id accepts players",
            WEBSOCKET_GAME_TRANSPORT_ENV
        );
    } else {
        info!(
            "WebSocket game transport disabled: /ws/:match_id refuses (set {}=1 to enable)",
            WEBSOCKET_GAME_TRANSPORT_ENV
        );
    }

    info!(%wt_base_url, cert_hash = %cert_hash_hex, "WebTransport identity ready");
    info!(
        strict_snapshot_datagrams,
        respawn_delay_ms,
        physics_backend = physics.backend.name(),
        snapshot_hz = physics.snapshot_hz(),
        "server runtime policy loaded"
    );
    if let Some(reason) = city::city_unavailable_reason(physics.backend) {
        warn!(%reason, "/city matches will be refused");
    }

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
            demolish_requests: Arc::new(StdRwLock::new(HashMap::new())),
            meteor_requests: Arc::new(StdRwLock::new(HashMap::new())),
            capture_stop_requests: Arc::new(StdRwLock::new(HashSet::new())),
            wt_attempts: wt_attempts.clone(),
            session_configs_served: AtomicU64::new(0),
            first_session_config_ms: AtomicU64::new(0),
            started: std::time::Instant::now(),
        }),
    };
    // Taken before the router consumes `state`.
    let watchdog_state = state.inner.clone();

    // Start WebTransport server
    let mut wt_config = ServerConfig::builder()
        .with_bind_address(wt_addr)
        .with_identity(identity)
        .build();
    wt_config
        .quic_config_mut()
        .transport_config(std::sync::Arc::new(wt_transport_config()));
    let wt_endpoint = Endpoint::server(wt_config)?;
    info!(%wt_addr, "WebTransport endpoint listening");
    // Said once, at startup, next to everything else that decides what this
    // process is. A deployment that silently picked up a different build of the
    // destruction SDK is otherwise indistinguishable from a healthy one.
    info!(physx_sdk = %linked_physx_sdk(), "destruction SDK");

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
        .merge(grass_layout::router(grass_layout::GrassStore::from_env()))
        .route("/healthz", get(health_handler))
        .route("/session-config", get(session_config_handler))
        .route("/vehicle-assets/session", post(garage_session_handler).layer(axum::extract::DefaultBodyLimit::max(8192)))
        .route("/vehicle-assets/session/:id", axum::routing::delete(garage::close_handler).get(garage::inspect_handler))
        .route("/vehicle-assets/session/:id/bombardment", post(garage_bombardment_handler).layer(axum::extract::DefaultBodyLimit::max(256)))
        .route("/vehicle-assets/session/:id/tuning", post(garage_tuning_handler).layer(axum::extract::DefaultBodyLimit::max(8192)))
        .route("/vehicle-assets/prepare", post(vehicle_assets::prepare).layer(axum::extract::DefaultBodyLimit::max(8192)))
        .route("/vehicle-assets/city", post(city_vehicle_handler).layer(axum::extract::DefaultBodyLimit::max(8192)))
        .route("/vehicle-assets/:hash/:file", get(vehicle_assets::asset))
        .route("/city-manifest/:hash", get(city_manifest_handler))
        .route("/city-visuals/:hash", get(city_visuals_handler))
        .route("/match-stats/:match_id", get(match_stats_handler))
        // Nested under /match-stats so the caddy proxy block that already
        // forwards that prefix needs no change for phones to reach it.
        .route("/match-stats/:match_id/report", post(debug_report_handler))
        .route(
            "/match-stats/:match_id/tape",
            post(city_tape_handler).layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/match-stats/:match_id/bodies", get(match_body_states_handler))
        // Paired client+server capture; see session_capture.rs. Under
        // /match-stats for the same reason as the report routes above.
        .route("/match-stats/:match_id/session/:session_id/start", post(session_start_handler))
        .route("/match-stats/:match_id/session/:session_id/stop", post(session_stop_handler))
        .route(
            "/match-stats/:match_id/session/:session_id/tape",
            post(session_tape_handler).layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/match-stats/:match_id/session-clock", get(session_clock_handler))
        .route("/city-reset/:match_id", post(city_reset_handler))
        .route("/city-demolish/:match_id", post(city_demolish_handler))
        .route("/city-meteor/:match_id", post(city_meteor_handler))
        .route("/city-capture-stop/:match_id", post(city_capture_stop_handler))
        .route("/city-buildings", get(city_buildings_handler))
        .route("/ws/stats", get(ws_stats_handler))
        // The game's WebSocket transport. Disabled unless explicitly enabled;
        // see `game_websocket_route`. `/ws/stats` above is the stats
        // dashboard feed, not a game transport, and is unaffected.
        .route(
            "/ws/:match_id",
            game_websocket_route(websocket_game_enabled, get(ws_handler)),
        )
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

    // Match the Caddy deployment: the standalone HTTPS page and its assets
    // need cross-origin isolation for SharedArrayBuffer-backed browser features.
    let app = app.layer(axum::middleware::map_response(
        |mut response: axum::response::Response| async move {
            response.headers_mut().insert(
                "cross-origin-opener-policy",
                axum::http::HeaderValue::from_static("same-origin"),
            );
            response.headers_mut().insert(
                "cross-origin-embedder-policy",
                axum::http::HeaderValue::from_static("require-corp"),
            );
            response
        },
    ));

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
    /// Which destruction engine `/city` is configured to run, and the PhysX SDK
    /// this binary linked. A deployment that cannot answer both cannot say what
    /// it is running: the two Blast paths and the native stage need different
    /// SDKs, and a successful build does not establish which one loaded.
    destruction_backend: String,
    physx_sdk: String,
}

/// The PhysX SDK this binary was built against, revision and path.
///
/// This used to read `option_env!("VIBE_PHYSX_SDK_ROOT")` here, which is always
/// None: that variable is emitted by physx-bridge's build script, and
/// `option_env!` only sees variables set by the build script of the crate it is
/// compiled in. So `/healthz` reported "unknown" for every deployment that ever
/// ran, including the one that spent hours on an engine which cannot construct
/// a GPU scene on this card.
fn linked_physx_sdk() -> String {
    #[cfg(feature = "physx-city")]
    {
        vibe_land_physx_bridge::physx_sdk_identity()
    }
    #[cfg(not(feature = "physx-city"))]
    {
        "not linked".to_string()
    }
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
        destruction_backend: city::selected_backend()
            .map(|backend| backend.as_str().to_string())
            .unwrap_or_else(|error| format!("invalid: {error}")),
        physx_sdk: linked_physx_sdk(),
    })
}

/// VIBE_CITY_OBSERVER_PIPELINE=1: run tick N's city observer bundle (encoder
/// ingest → encode → sends) inside tick N+1's GPU wait via the split physics
/// step. Simulation order is untouched — the deferral is observer-only, and
/// the owner accepted the ≤1-tick shift in visual emission (2026-08-27).
/// Default OFF until the gate battery is green.
fn observer_pipeline_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("VIBE_CITY_OBSERVER_PIPELINE")
            .map(|value| !value.is_empty() && value != "0")
            .unwrap_or(false)
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

async fn garage_session_handler(
    State(state): State<SharedAppState>, Json(request): Json<vehicle_assets::PrepareRequest>,
) -> axum::response::Response {
    if state.inner.physics.backend != vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu {
        return (StatusCode::SERVICE_UNAVAILABLE, "Test drives require a PhysX GPU server.").into_response();
    }
    garage::create(request).await.into_response()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CityVehicleResponse {
    match_id: String,
    vehicle_id: u32,
    position: [f32; 3],
    vehicle: vehicle_assets::PreparedVehicle,
}

// The random private-session ID is the existing garage capability. This route
// never accepts arbitrary city IDs, dimensions, mass, geometry or native torque.
async fn garage_tuning_handler(
    State(state): State<SharedAppState>, axum::extract::Path(id): axum::extract::Path<String>,
    Json(request): Json<vehicle_tuning::TuneRequest>,
) -> Result<Json<vehicle_tuning::TuneResponse>, (StatusCode, String)> {
    let session=garage::lookup(&id).filter(|s|!s.closing())
        .ok_or((StatusCode::NOT_FOUND,"This test drive has ended.".into()))?;
    let current=session.current_vehicle.lock().unwrap().clone();
    if current.asset_hash!=request.expected_asset_hash {
        return Err((StatusCode::CONFLICT,"The vehicle setup changed. Reopen the test drive to synchronize.".into()));
    }
    let handle=find_match(&state,&id).await
        .ok_or((StatusCode::CONFLICT,"Join the test drive before applying tuning.".into()))?;
    let vehicle=vehicle_tuning::resolve(&current,request.driving,session.geometry.mass).await?;
    let (reply,response)=tokio::sync::oneshot::channel();
    handle.tx.send(MatchEvent::TuneGarageVehicle{expected_asset_hash:request.expected_asset_hash,vehicle,reply})
        .map_err(|_|(StatusCode::SERVICE_UNAVAILABLE,"The test drive has ended.".into()))?;
    tokio::time::timeout(Duration::from_secs(3),response).await
        .map_err(|_|(StatusCode::GATEWAY_TIMEOUT,"Tuning acknowledgement timed out. Check the current setup before retrying.".into()))?
        .map_err(|_|(StatusCode::SERVICE_UNAVAILABLE,"The test drive has ended.".into()))?.map(Json)
}

async fn garage_bombardment_handler(
    State(state): State<SharedAppState>, axum::extract::Path(id): axum::extract::Path<String>,
    Json(request): Json<garage_bombardment::Request>,
) -> Result<Json<garage_bombardment::Status>, (StatusCode, String)> {
    garage::lookup(&id).filter(|s|!s.closing())
        .ok_or((StatusCode::NOT_FOUND,"This test drive has ended.".into()))?;
    let handle=find_match(&state,&id).await
        .ok_or((StatusCode::CONFLICT,"Join the test drive first.".into()))?;
    let (reply,response)=tokio::sync::oneshot::channel();
    handle.tx.send(MatchEvent::GarageBombardment{enabled:request.enabled,reply})
        .map_err(|_|(StatusCode::SERVICE_UNAVAILABLE,"The test drive has ended.".into()))?;
    tokio::time::timeout(Duration::from_secs(3),response).await
        .map_err(|_|(StatusCode::GATEWAY_TIMEOUT,"Bombardment acknowledgement timed out.".into()))?
        .map_err(|_|(StatusCode::SERVICE_UNAVAILABLE,"The test drive has ended.".into()))?.map(Json)
}

async fn city_vehicle_handler(
    State(state): State<SharedAppState>, Json(request): Json<vehicle_assets::PrepareRequest>,
) -> Result<Json<CityVehicleResponse>, (StatusCode, String)> {
    if state.inner.physics.backend != vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "City vehicles require a PhysX GPU server.".into()));
    }
    if std::env::var("VIBE_CITY_VEHICLES").is_ok_and(|v| v == "0") {
        return Err((StatusCode::FORBIDDEN, "Vehicles are disabled in this city.".into()));
    }
    let asset = Arc::new(vehicle_assets::prepare_drivable(request).await?);
    let handle = get_or_create_match(state.inner.clone(), "city-default".into()).await;
    let (reply, response) = tokio::sync::oneshot::channel();
    handle.tx.send(MatchEvent::PublishVehicle { asset, reply })
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "The city is unavailable. Try again shortly.".into()))?;
    tokio::time::timeout(Duration::from_secs(60), response).await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "The city did not finish loading. Try again shortly.".into()))?
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "The city stopped before the vehicle was added.".into()))?
        .map(Json)
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
/// One-button debug reports: the client posts everything IT can see, the
/// server staples on its own live match-stats snapshot, and the pair lands in
/// a uniquely-named folder under debug-reports/. "I sent a report" is then a
/// complete bug report — no downloading JSON on a phone and forwarding it.
async fn debug_report_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let snapshot = state
        .inner
        .stats_registry
        .read()
        .expect("stats registry poisoned")
        .get(&match_id)
        .cloned();
    let Some(stats) = snapshot else {
        return (StatusCode::NOT_FOUND, "unknown match").into_response();
    };
    // Stored verbatim: the payload is the CLIENT's testimony, and rewriting
    // testimony during intake is how evidence gets corrupted. Only shape is
    // checked, so a garbage post cannot fill the disk with noise.
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return (StatusCode::BAD_REQUEST, "payload is not JSON").into_response();
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let folder = format!("report-{stamp}-{match_id}-tick{}", stats.server_tick);
    let dir = debug_reports_root().join(&folder);
    let server_json = match serde_json::to_vec_pretty(&stats) {
        Ok(json) => json,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("stats serialize failed: {error}"),
            )
                .into_response();
        }
    };
    let write = std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(dir.join("client.json"), &body))
        .and_then(|()| std::fs::write(dir.join("server.json"), &server_json));
    if let Err(error) = write {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("report write failed: {error}"),
        )
            .into_response();
    }
    info!(%match_id, folder, bytes = body.len(), "debug report stored");
    (StatusCode::OK, Json(serde_json::json!({ "folder": folder }))).into_response()
}

/// Where debug reports, tapes and session bundles are written:
/// `VIBE_DEBUG_REPORTS_DIR`, or `debug-reports` under the working directory.
fn debug_reports_root() -> PathBuf {
    std::env::var("VIBE_DEBUG_REPORTS_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("debug-reports"))
}

/// A city tape -- the inbound stream a client recorded, opened on a
/// bootstrap -- stored beside the debug reports so the storm a player hit can
/// be replayed into the renderer anywhere. A player's manual tape runs as long
/// as they keep recording (tens to hundreds of megabytes), so it gets its own
/// body limit rather than the report handler's. Not parsed: the client
/// formats it and the client reads it; only its magic is checked.
async fn city_tape_handler(
    Path(match_id): Path<String>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if !city::is_city_match(&match_id) {
        return (StatusCode::BAD_REQUEST, "not a city match").into_response();
    }
    // VLTAPE01: the city stream alone; VLCTAPE2 (and the first such tapes,
    // written as VLTAPE02): every inbound channel.
    if !session_capture::is_client_tape(&body) {
        return (StatusCode::BAD_REQUEST, "not a city tape").into_response();
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let folder = format!("tape-{stamp}-{match_id}");
    let dir = debug_reports_root().join(&folder);
    let write = std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(dir.join("city.vltape"), &body));
    if let Err(error) = write {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("tape write failed: {error}"),
        )
            .into_response();
    }
    info!(%match_id, folder, bytes = body.len(), "city tape stored");
    (StatusCode::OK, Json(serde_json::json!({ "folder": folder }))).into_response()
}

// ── Paired session capture ──────────────────────────────────────────────────
//
// A client that starts a tape asks for a server capture under a session id it
// chose; the match records until the client says stop (or leaves), then the
// client uploads its tape into the same bundle. HTTP rather than a packet on
// the game session: it needs no wire-protocol change on either side, a server
// without the routes answers 404 and the client simply records standalone,
// the e2e harness and curl can drive it, and every request gets a synchronous
// answer carrying the server tick and clocks it started at -- which is itself
// a clock sample for the client.

#[derive(serde::Deserialize, Default)]
struct SessionStartRequest {
    player_id: Option<u32>,
}

async fn find_match(state: &SharedAppState, match_id: &str) -> Option<MatchHandle> {
    state
        .inner
        .matches
        .read()
        .await
        .get(match_id)
        .filter(|handle| !handle.tx.is_closed())
        .cloned()
}

fn session_reply_response(result: session_match::SessionReply) -> axum::response::Response {
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err((code, message)) => (
            StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message,
        )
            .into_response(),
    }
}

async fn ask_match(
    handle: &MatchHandle,
    command: impl FnOnce(tokio::sync::oneshot::Sender<session_match::SessionReply>) -> session_match::SessionCommand,
    wait: Duration,
) -> session_match::SessionReply {
    let (reply, answer) = tokio::sync::oneshot::channel();
    if handle.tx.send(MatchEvent::Session(command(reply))).is_err() {
        return Err((404, "match has ended".into()));
    }
    match tokio::time::timeout(wait, answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err((500, "match dropped the request".into())),
        Err(_) => Err((504, "match did not answer in time".into())),
    }
}

fn server_build_identity(stats: Option<&MatchStatsSnapshot>) -> serde_json::Value {
    serde_json::json!({
        "server_build": server_build_stamp(),
        "server_started": server_started_stamp(),
        "profile": server_build_profile(),
        "physics_backend": stats.map(|stats| stats.physics_backend.clone()),
        "fingerprint": stats.and_then(|stats| serde_json::to_value(&stats.fingerprint).ok()),
    })
}

async fn session_start_handler(
    Path((match_id, session_id)): Path<(String, String)>,
    State(state): State<SharedAppState>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if !session_capture::valid_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "session id must be 1-64 of [A-Za-z0-9_-]").into_response();
    }
    let request: SessionStartRequest = if body.is_empty() {
        SessionStartRequest::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(request) => request,
            Err(error) => return (StatusCode::BAD_REQUEST, format!("bad request: {error}")).into_response(),
        }
    };
    let Some(handle) = find_match(&state, &match_id).await else {
        return (StatusCode::NOT_FOUND, "unknown match").into_response();
    };
    let bundle = session_capture::bundle_dir(&debug_reports_root(), &session_id);
    let player_id = request.player_id;
    let result = ask_match(
        &handle,
        |reply| session_match::SessionCommand::Start {
            session_id: session_id.clone(),
            player_id,
            bundle: bundle.clone(),
            reply,
        },
        Duration::from_secs(5),
    )
    .await;
    let Ok(started) = result else {
        return session_reply_response(result);
    };
    if !started["already_active"].as_bool().unwrap_or(false) {
        let stats = state
            .inner
            .stats_registry
            .read()
            .expect("stats registry poisoned")
            .get(&match_id)
            .cloned();
        if let Some(stats) = &stats {
            if let Ok(bytes) = serde_json::to_vec_pretty(stats) {
                let _ = std::fs::create_dir_all(&bundle);
                let _ = std::fs::write(bundle.join(session_capture::STATS_START_FILE), bytes);
            }
        }
        let dir = started["server_dir"].as_str().unwrap_or(session_capture::SERVER_DIR).to_string();
        let file = |name: &str| format!("{dir}/{name}");
        let patch = serde_json::json!({
            "session_id": session_id,
            "match_id": match_id,
            "client_player_id": player_id,
            "created_unix_us": session_capture::unix_us(),
            "server": {
                "dir": dir,
                "capture_epoch_unix_us": started["capture_epoch_unix_us"],
                "capture_start": started["capture_start"],
                "start": started["start"],
                "opened_capture": !started["joined"].as_bool().unwrap_or(false),
                "opened_by": started["opened_by"],
                "shared_with_at_start": started["shared_with"],
                "sim_hz": started["sim_hz"],
                "files": {
                    "world": file(session_capture::WORLD_FILE),
                    "send_log": file(session_capture::SEND_LOG_FILE),
                    "ticks": file(session_capture::TICKS_FILE),
                    "selections": file(session_capture::SELECTIONS_FILE),
                    "capture_meta": file(session_capture::CAPTURE_META_FILE),
                    "city_capture": file(session_capture::CITY_DIR),
                },
                "city_capture_at_start": started["city_capture"],
                "build": server_build_identity(stats.as_ref()),
            },
            "stats": {"start": session_capture::STATS_START_FILE},
        });
        if let Err(error) = session_capture::merge_manifest(&bundle, patch) {
            warn!(%error, session_id, "session manifest write failed");
        }
    }
    (StatusCode::OK, Json(started)).into_response()
}

async fn session_stop_handler(
    Path((match_id, session_id)): Path<(String, String)>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    if !session_capture::valid_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "session id must be 1-64 of [A-Za-z0-9_-]").into_response();
    }
    let Some(handle) = find_match(&state, &match_id).await else {
        return (StatusCode::NOT_FOUND, "unknown match").into_response();
    };
    // Generous: the last session out waits for the writers to drain.
    let result = ask_match(
        &handle,
        |reply| session_match::SessionCommand::Stop { session_id: session_id.clone(), reply },
        Duration::from_secs(120),
    )
    .await;
    session_reply_response(result)
}

/// The client's tape, into its session's bundle.
async fn session_tape_handler(
    Path((match_id, session_id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if !session_capture::valid_session_id(&session_id) {
        return (StatusCode::BAD_REQUEST, "session id must be 1-64 of [A-Za-z0-9_-]").into_response();
    }
    let Some(header) = session_capture::client_tape_header(&body) else {
        return (StatusCode::BAD_REQUEST, "not a client tape").into_response();
    };
    let bundle = session_capture::bundle_dir(&debug_reports_root(), &session_id);
    let existed = bundle.join(session_capture::MANIFEST_FILE).exists();
    let write = std::fs::create_dir_all(&bundle)
        .and_then(|()| std::fs::write(bundle.join(session_capture::CLIENT_TAPE_FILE), &body));
    if let Err(error) = write {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("tape write failed: {error}")).into_response();
    }
    let keep = [
        "version", "capturedAt", "matchId", "localPlayerId", "transport", "durationMs", "packets",
        "bytes", "prelude", "channels", "frames", "clockOriginMs", "wallClockOriginMs", "pairing",
        "userAgent", "client", "wireVersion", "manifestHash", "session",
    ];
    let summary: serde_json::Map<String, serde_json::Value> = keep
        .iter()
        .filter_map(|key| header.get(*key).map(|value| (key.to_string(), value.clone())))
        .collect();
    let patch = serde_json::json!({
        "session_id": session_id,
        "match_id": match_id,
        "client": {
            "tape": session_capture::CLIENT_TAPE_FILE,
            "magic": String::from_utf8_lossy(&body[..8]),
            "bytes": body.len(),
            "uploaded_unix_us": session_capture::unix_us(),
            "header": summary,
        },
        // A tape for a session this server never started (it restarted, or
        // it predates session capture on a mixed deploy): kept, and said so.
        "server_capture_missing": !existed,
    });
    let manifest = match session_capture::merge_manifest(&bundle, patch) {
        Ok(manifest) => manifest,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("manifest write failed: {error}"))
                .into_response()
        }
    };
    let folder = bundle.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    info!(%match_id, session_id, bytes = body.len(), folder, "session tape stored");
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "folder": folder,
            "paired": manifest.get("server").is_some(),
        })),
    )
        .into_response()
}

/// A clock sample: the match's current tick and the server's clocks, read
/// without a trip through the match loop. The client brackets it with its own
/// send and receive times.
async fn session_clock_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    let Some(handle) = find_match(&state, &match_id).await else {
        return (StatusCode::NOT_FOUND, "unknown match").into_response();
    };
    let hub = &handle.telemetry.send_hub;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "tick": hub.tick(),
            "unix_us": session_capture::unix_us(),
            "capture_mono_us": hub.now_us(),
        })),
    )
        .into_response()
}

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

/// Where to take a building's footing out, and how hard.
///
/// Defaults aim at the corner of the downtown scene that the QA harness has
/// been shooting at all along, so `POST /city-demolish/city-default` with an
/// empty body does something useful.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
struct DemolishRequest {
    /// Centre of the footing, world XZ. Ignored when `tallest` is set.
    x: f32,
    z: f32,
    /// Aim at the tallest column in the city instead of x/z.
    tallest: bool,
    /// How wide a footing to take out.
    radius_m: f32,
    /// Only chunks below this height count as supports.
    below_y: f32,
    /// Cap on rounds, so one request cannot spawn ten thousand bodies.
    rounds: usize,
    /// Cut only within this half-angle of `heading_deg`, with the height limit
    /// ramping across it: a wedge, so the building goes over sideways. 0 is a
    /// full circle and drops it straight down.
    wedge_deg: f32,
    heading_deg: f32,
    /// Fraction of targets dropped at random. A clean cut leaves two rigid
    /// pieces; a real collapse is hundreds of fractures, and that is the
    /// regime the visual artefacts live in.
    jitter: f32,
    /// Rounds released per tick. Progressive, for the same reason.
    per_tick: usize,
}

impl Default for DemolishRequest {
    fn default() -> Self {
        Self {
            x: -36.0,
            z: -36.0,
            tallest: false,
            radius_m: 10.0,
            below_y: 6.0,
            rounds: 48,
            wedge_deg: 0.0,
            heading_deg: 0.0,
            jitter: 0.0,
            per_tick: 8,
        }
    }
}

/// Bring a building down on command, repeatably.
///
/// The engine cannot break a bond to order, so this is spelled as impulses at
/// the footing -- see `CityRuntime::demolish_supports`. It exists because the
/// artefacts worth chasing happen during a whole building's collapse, and
/// driving that from a browser is neither repeatable nor quick: the same sixty
/// rounds, aimed the same way, break anywhere between 900 and 7,700 bonds
/// depending on where the player spawned.
async fn city_demolish_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
    body: Option<Json<DemolishRequest>>,
) -> impl IntoResponse {
    if !city::is_city_match(&match_id) {
        return (StatusCode::BAD_REQUEST, "not a city match").into_response();
    }
    let request = body.map(|Json(r)| r).unwrap_or_default();
    info!(%match_id, ?request, "city demolition requested");
    state
        .inner
        .demolish_requests
        .write()
        .expect("demolish requests poisoned")
        .insert(match_id.clone(), request);
    (StatusCode::ACCEPTED, "demolition queued").into_response()
}

/// One or more world-space points a meteor should land on.
#[derive(Clone, Debug, serde::Deserialize)]
struct MeteorRequest {
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    z: f32,
    /// Several at once, each `[x, y, z]`; `x/y/z` above is the one-target
    /// spelling. Released one per tick in order.
    #[serde(default)]
    targets: Vec<[f32; 3]>,
}

/// Drop a meteor on an exact point, without a player having to aim at it.
///
/// A player-fired meteor lands wherever the aim ray first meets the world,
/// which is right for play and wrong for a measurement that wants to say
/// "one rock per building": from any vantage point some roofs are behind
/// other roofs. This is the same launch path (same arc planner, same pool,
/// same `PKT_METEOR_LAUNCHED`), only the target is given instead of found.
async fn city_meteor_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
    body: Option<Json<MeteorRequest>>,
) -> impl IntoResponse {
    if !city::is_city_match(&match_id) {
        return (StatusCode::BAD_REQUEST, "not a city match").into_response();
    }
    let request = body.map(|Json(r)| r);
    let mut targets: Vec<[f32; 3]> = Vec::new();
    if let Some(request) = request {
        if !request.targets.is_empty() {
            targets.extend(request.targets);
        } else {
            targets.push([request.x, request.y, request.z]);
        }
    }
    if targets.is_empty() {
        return (StatusCode::BAD_REQUEST, "no target").into_response();
    }
    let queued = targets.len();
    state
        .inner
        .meteor_requests
        .write()
        .expect("meteor requests poisoned")
        .entry(match_id)
        .or_default()
        .extend(targets);
    (StatusCode::ACCEPTED, format!("{queued} meteor(s) queued")).into_response()
}

/// Close the match's netlab capture cleanly (the tape's zstd frame is only
/// valid once finished), so the recording process can then be stopped.
async fn city_capture_stop_handler(
    Path(match_id): Path<String>,
    State(state): State<SharedAppState>,
) -> impl IntoResponse {
    if !city::is_city_match(&match_id) {
        return (StatusCode::BAD_REQUEST, "not a city match").into_response();
    }
    state
        .inner
        .capture_stop_requests
        .write()
        .expect("capture stop requests poisoned")
        .insert(match_id);
    (StatusCode::ACCEPTED, "capture stop queued").into_response()
}

/// The buildings in the city scene, as the bond graph defines them.
///
/// A scene pack is one flat scenario; the manifest has one structure per grid
/// cell, not one per building. What a player calls a building is a connected
/// component of the intact bond graph, so that is what this reports, in
/// world space, so a driver can aim at each one in turn.
async fn city_buildings_handler() -> impl IntoResponse {
    let Some((_, manifest, _)) = city::manifest_asset() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "city scene unavailable").into_response();
    };
    let buildings = vibe_land_destruction::buildings::enumerate(manifest);
    Json(buildings).into_response()
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

async fn city_visuals_handler(
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !city::manifest_asset().is_some_and(|(expected, _, _)| *expected == hash) {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"Unknown city manifest"}))).into_response();
    }
    match city::visual_asset() {
        Ok(Some(data)) => ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(data)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"This server has no town-kit visuals configured"}))).into_response(),
        Err(error) => (StatusCode::CONFLICT, Json(serde_json::json!({"error":error.to_string()}))).into_response(),
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

/// A WebTransport connection's link, as quinn reports it: the signals the
/// city rate controller reads (`link_rate.rs`).
struct QuicLinkProbe {
    connection: Connection,
    submitted: Arc<std::sync::atomic::AtomicU64>,
    reliable_submitted: Arc<std::sync::atomic::AtomicU64>,
    epoch: Instant,
}

impl link_rate::LinkProbe for QuicLinkProbe {
    fn sample(&self) -> Option<link_rate::LinkSample> {
        let quic = self.connection.quic_connection();
        let stats = quic.stats();
        let space = quic.datagram_send_buffer_space();
        Some(link_rate::LinkSample {
            at_us: self.epoch.elapsed().as_micros() as u64,
            datagram_buffered_bytes: link_rate::QUIC_DATAGRAM_SEND_BUFFER_BYTES.saturating_sub(space) as u64,
            wire_bytes: stats.udp_tx.bytes,
            sent_packets: stats.path.sent_packets,
            lost_packets: stats.path.lost_packets,
            lost_bytes: stats.path.lost_bytes,
            rtt_us: stats.path.rtt.as_micros() as u64,
            submitted_bytes: self.submitted.load(Ordering::Relaxed),
            reliable_submitted_bytes: self.reliable_submitted.load(Ordering::Relaxed),
        })
    }
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

    if city::is_city_match(&hello.match_id) {
        if let Some(reason) = city::city_unavailable_reason(app.physics.backend) {
            error!(match_id = %hello.match_id, %reason, "refusing city match");
            // The client logs the close reason; without it the player would
            // be connected to a city nothing can collide with.
            connection.close(wtransport::VarInt::from_u32(2), reason.as_bytes());
            anyhow::bail!("refused city match {}: {reason}", hello.match_id);
        }
    }

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), hello.match_id.clone()).await;

    let (out_tx, out_rx) = outbound::channel_with_tap(
        PLAYER_OUTBOUND_QUEUE_CAPACITY,
        Some(send_log::Tap::new(player_id, false, handle.telemetry.send_hub.clone())),
    );

    let link: Arc<dyn link_rate::LinkProbe> = Arc::new(QuicLinkProbe {
        connection: connection.clone(),
        submitted: out_tx.submitted_counter(),
        reliable_submitted: out_tx.reliable_submitted_counter(),
        epoch: Instant::now(),
    });
    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: format!("wt-player-{player_id}"),
        transport: ClientTransport::WebTransport,
        tx: out_tx,
        link: Some(link),
    }))?;

    // Independent writer lanes: a flow-controlled reliable stream must not
    // prevent QUIC datagrams from being submitted. Reliable frames remain FIFO.
    let conn_write = connection.clone();
    let telemetry = handle.telemetry.clone();
    let strict_snapshot_datagrams = app.strict_snapshot_datagrams;
    let writer = tokio::spawn(async move {
        let result = outbound::write_webtransport(
            &mut send_stream,
            out_rx,
            |bytes| {
                let kind = bytes[0];
                let sent = conn_write.send_datagram(bytes);
                match classify_outbound_delivery(kind, strict_snapshot_datagrams, sent.is_ok()) {
                    OutboundDelivery::Datagram => {
                        telemetry.observe_outbound_datagram(
                            bytes.len(),
                            ClientTransport::WebTransport,
                            is_snapshot_packet_kind(kind),
                        );
                        outbound::DatagramResult::Sent
                    }
                    OutboundDelivery::StrictDrop => {
                        telemetry.observe_strict_snapshot_drop(
                            sent.as_ref()
                                .err()
                                .map(strict_snapshot_drop_cause_from_send_error)
                                .unwrap_or(StrictSnapshotDropCause::Other),
                        );
                        outbound::DatagramResult::Dropped
                    }
                    OutboundDelivery::ReliableFallback => {
                        telemetry.observe_datagram_fallback();
                        outbound::DatagramResult::Fallback
                    }
                    OutboundDelivery::Reliable => {
                        unreachable!("only datagram packets enter this lane")
                    }
                }
            },
            |bytes| {
                telemetry.observe_outbound_reliable(
                    bytes.len(),
                    ClientTransport::WebTransport,
                    is_snapshot_packet_kind(bytes[0]),
                );
                telemetry.observe_packet_kind(bytes[0], bytes.len());
            },
            |bytes| telemetry.observe_outbound_drop(is_snapshot_packet_kind(bytes[0])),
        )
        .await;
        if let Err(err) = result {
            warn!(player_id, error = ?err, "WT writer failed; closing session");
        }
        // Also releases the datagram reader so a failed writer cannot leave a
        // connected player receiving an incomplete reliable state stream.
        conn_write.close(
            wtransport::VarInt::from_u32(1),
            b"server outbound stream closed",
        );
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
                warn!(
                    player_id,
                    payload_len, "closing WT uplink: implausible frame length"
                );
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

/// Opt-in for the WebSocket game transport (`/ws/:match_id`). Off unless set
/// to exactly `1`: the game is WebTransport-only, and a session on WebSocket
/// plays over an ordered reliable stream instead of the lossy datagrams the
/// pose and debris streams are designed and measured against.
const WEBSOCKET_GAME_TRANSPORT_ENV: &str = "VIBE_ENABLE_WEBSOCKET";

/// What `/ws/:match_id` answers while the WebSocket game transport is disabled.
const WEBSOCKET_GAME_TRANSPORT_DISABLED: &str =
    "WebSocket game transport is disabled; connect over WebTransport (/session-config). \
     The server enables it only with VIBE_ENABLE_WEBSOCKET=1.";

fn websocket_game_transport_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

/// The `/ws/:match_id` route: the real handler when the WebSocket game
/// transport is enabled, otherwise a refusal for every method -- decided before
/// any upgrade is attempted, so a disabled server never opens a game socket.
fn game_websocket_route<S>(
    enabled: bool,
    handler: axum::routing::MethodRouter<S>,
) -> axum::routing::MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    if enabled {
        handler
    } else {
        axum::routing::any(websocket_game_transport_disabled_handler)
    }
}

async fn websocket_game_transport_disabled_handler() -> (StatusCode, &'static str) {
    (StatusCode::FORBIDDEN, WEBSOCKET_GAME_TRANSPORT_DISABLED)
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
    if city::is_city_match(&match_id) {
        if let Some(reason) = city::city_unavailable_reason(app.physics.backend) {
            error!(%match_id, %reason, "refusing city match");
            anyhow::bail!("refused city match {match_id}: {reason}");
        }
    }

    let player_id = app.next_player_id.fetch_add(1, Ordering::Relaxed);
    let handle = get_or_create_match(app.clone(), match_id.clone()).await;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = outbound::channel_with_tap(
        PLAYER_OUTBOUND_QUEUE_CAPACITY,
        Some(send_log::Tap::new(player_id, true, handle.telemetry.send_hub.clone())),
    );

    handle.tx.send(MatchEvent::Connect(PlayerConnection {
        player_id,
        identity: query.identity.clone(),
        transport: ClientTransport::WebSocket,
        tx: out_tx.clone(),
        link: None,
    }))?;

    let telemetry = handle.telemetry.clone();
    let mut writer = tokio::spawn(async move {
        let mut failed = out_rx.failed.clone();
        let tap = out_rx.tap();
        loop {
            let outgoing = tokio::select! {
                biased;
                _ = outbound::failed(&mut failed) => break,
                packet = out_rx.recv() => match packet { Some(packet) => packet, None => break },
            };
            let pending = tap
                .as_deref()
                .and_then(|tap| tap.prepare(&outgoing.bytes, outgoing.tick, outgoing.queued));
            let packet = outgoing.bytes;
            let packet_len = packet.len();
            let packet_kind = packet.first().copied().unwrap_or_default();
            let is_snapshot = packet.first().copied().is_some_and(is_snapshot_packet_kind);
            let sent = tokio::select! {
                biased;
                _ = outbound::failed(&mut failed) => break,
                sent = ws_tx.send(Message::Binary(packet.into())) => sent,
            };
            if let Err(err) = sent {
                warn!(player_id, error = ?err, "websocket writer stopped");
                break;
            }
            if let Some(pending) = pending {
                pending.finish(send_log::Lane::WebSocket, send_log::Outcome::Sent);
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
    let mut reader = tokio::spawn(async move {
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
        info!(player_id, "websocket reader task exited");
    });

    tokio::select! { _ = &mut writer => {}, _ = &mut reader => {} }
    writer.abort();
    reader.abort();
    let _ = handle.tx.send(MatchEvent::Disconnect { player_id });
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
    // Queued demolition requests, per match. See `city_demolish_handler`.
    demolish_requests: Arc<StdRwLock<HashMap<String, DemolishRequest>>>,
    meteor_requests: Arc<StdRwLock<HashMap<String, Vec<[f32; 3]>>>>,
    capture_stop_requests: Arc<StdRwLock<HashSet<String>>>,
) {
    let mut arena = PhysicsArena::new(MoveConfig::default(), physics.backend)
        .expect("selected authoritative physics backend should initialize");
    let world = VoxelWorld::new();
    let garage = garage::lookup(&match_id);
    if let Some(session) = &garage {
        session.world.instantiate(&mut arena).expect("garage terrain should instantiate");
        arena.set_spawn_areas(session.world.spawn_areas.clone());
        if let Err(error) = arena.spawn_prepared_vehicle(garage::VEHICLE_ID, 0,
            nalgebra::Vector3::new(0.0, session.geometry.origin_height + 0.15, 3.0), &session.geometry) {
            error!(%error, "garage vehicle could not initialize"); return;
        }
    } else if garage::is_garage(&match_id) { return; }
    else { seed_world_for_match(&mut arena, &match_id).expect("world document should instantiate"); }
    let mut dynamic_body_handles: HashMap<u32, DynamicBodyMetaRuntime> = arena
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
    // Fired balls get their handles here, before any client has joined, because
    // the metadata packet a client receives on join is the only one it gets and
    // it replaces rather than merges. A ball whose handle arrived later would
    // be dropped by the client as an unknown body, which is to say invisible --
    // and an invisible projectile is the exact thing this weapon exists to fix.
    {
        let radius = if garage.is_some() { garage_bombardment::BALL_RADIUS } else { city::city_ball_radius_m() };
        let mut next_handle = u16::try_from(dynamic_body_handles.len() + 1)
            .expect("snapshot V2 supports at most 65,535 dynamic bodies per match");
        for id in arena.reserve_ball_pool(CANNONBALL_POOL) {
            dynamic_body_handles.insert(
                id,
                DynamicBodyMetaRuntime {
                    handle: next_handle,
                    shape_type: SHAPE_SPHERE,
                    half_extents_m: [radius; 3],
                },
            );
            next_handle = next_handle.saturating_add(1);
        }
        // Meteors get their own ring for the same reason, with their own
        // radius: the metadata is per id, so a meteor through a cannonball's
        // id would be drawn at cannonball size.
        let meteor_radius = meteor::MeteorTuning::from_env().radius_m;
        for id in arena.reserve_meteor_pool(METEOR_POOL) {
            dynamic_body_handles.insert(
                id,
                DynamicBodyMetaRuntime {
                    handle: next_handle,
                    shape_type: SHAPE_SPHERE,
                    half_extents_m: [meteor_radius; 3],
                },
            );
            next_handle = next_handle.saturating_add(1);
        }
    }
    // Handles in id order: the PhysX arena enumerates its vehicles from a hash
    // map, and a thin client keys a vehicle by this handle.
    let mut seeded_vehicles = arena.snapshot_vehicles();
    seeded_vehicles.sort_by_key(|state| state.id);
    let vehicle_handles = seeded_vehicles
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
        #[cfg(feature = "physx-city")]
        let world = arena.physx_world_mut();
        #[cfg(not(feature = "physx-city"))]
        let world = None;
        match city::CityRuntime::open(SIM_HZ as u32, world) {
            Ok(mut runtime) => {
                // Fixed for the life of the match: the version is announced in
                // the session config, so every client that joins has already
                // agreed to this layout.
                runtime.set_wire_version(city::city_wire_version(&match_id));
                // Where the ground is, so bodies that go through it are logged
                // and retired at a floor under it instead of falling to the
                // 1 km world bound.
                runtime.set_ground_reference(arena.lowest_ground_y());
                // The engine may refuse a step only on the native stage, and
                // the arena must learn that from the city it actually opened.
                arena.set_tolerate_rejected_steps(runtime.backend_name() == "native");
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
                error!(%match_id, error = ?error, "destructible city unavailable for this match");
                None
            }
        }
    } else {
        None
    };

    // Per-match, so two matches do not rain meteors from the same bearings.
    let match_seed = {
        let digest = Sha256::digest(match_id.as_bytes());
        u64::from_le_bytes(digest[..8].try_into().expect("eight bytes of a digest"))
    };
    let mut state = MatchState {
        id: match_id,
        arena,
        world,
        history: LagCompHistory::new(1000),
        contact_audio: contact_audio::ContactAudioReducer::default(),
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
        tick_ring: std::collections::VecDeque::with_capacity(TICK_RING_CAP),
        stats_registry,
        body_states_registry,
        reset_requests,
        demolish_requests,
        meteor_requests,
        capture_stop_requests,
        demolish_per_tick: 8,
        city_desync_players: HashSet::new(),
        city_desync_repairs: 0,
        last_fan_out_ms: 0.0,
        last_publish_ms: 0.0,
        last_tick_instant: None,
        input_credit: 1.0,
        staged_city: None,
        last_observer_flush_ms: 0.0,
        tick_meteors_launched: 0,
        tick_meteor_launch_ms: 0.0,
        session_capture: None,
        session_max_us: session_match::session_max_us(),
        next_player_handle: 1,
        reusable_player_handles: VecDeque::new(),
        free_player_handles: VecDeque::new(),
        player_handles: HashMap::new(),
        dynamic_body_handles,
        vehicle_handles,
        meteor_rng: meteor::Rng::new(match_seed),
        city,
        custom_vehicles: garage.as_ref().map(|session| [(garage::VEHICLE_ID, Arc::new(vehicle_assets::DrivableVehicle {
            vehicle: session.vehicle.clone(), geometry: session.geometry.clone(),
        }))].into_iter().collect()).unwrap_or_default(),
        garage,
        bombardment: Default::default(),
    };

    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / SIM_HZ as f64));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut garage_last_occupied = Instant::now();
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if state.garage.is_some() {
                    if state.garage.as_ref().is_some_and(|session|session.closing()) {break;}
                    if !state.players.is_empty() {garage_last_occupied = Instant::now();}
                    else if garage_last_occupied.elapsed() > Duration::from_secs(60) {break;}
                }
                state.tick();
            }
            Some(event) = rx.recv() => {
                state.handle_event(event);
            }
            else => break,
        }
    }

    if state.garage.is_some() {garage::close(&state.id);}
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
                    app.demolish_requests.clone(),
                    app.meteor_requests.clone(),
                    app.capture_stop_requests.clone(),
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
    fn tune_garage_vehicle(&mut self, expected:&str, vehicle:vehicle_assets::PreparedVehicle)
        -> Result<vehicle_tuning::TuneResponse,(StatusCode,String)> {
        let session=self.garage.as_ref().filter(|s|!s.closing())
            .ok_or((StatusCode::NOT_FOUND,"This test drive has ended.".into()))?;
        let id=garage::VEHICLE_ID;
        let existing=self.custom_vehicles.get(&id)
            .ok_or((StatusCode::NOT_FOUND,"The test vehicle is unavailable.".into()))?;
        if existing.vehicle.asset_hash!=expected || existing.vehicle.geometry_hash!=vehicle.geometry_hash {
            return Err((StatusCode::CONFLICT,"The vehicle setup changed before this update could apply.".into()));
        }
        self.arena.tune_prepared_vehicle(id,&vehicle.driving)
            .map_err(|error|(StatusCode::UNPROCESSABLE_ENTITY,error))?;
        let mut geometry=existing.geometry.clone();
        geometry.driving=Some(vehicle.driving.clone());
        *session.current_vehicle.lock().unwrap()=vehicle.clone();
        self.custom_vehicles.insert(id,Arc::new(vehicle_assets::DrivableVehicle{vehicle:vehicle.clone(),geometry}));
        if let Some(&handle)=self.vehicle_handles.get(&id) {
            let packet=vehicle_assets::asset_packet(handle,&vehicle);
            for runtime in self.players.values() {let _=try_queue_packet(&runtime.tx,packet.clone(),&self.io);}
        }
        Ok(vehicle_tuning::TuneResponse{vehicle,server_tick:self.server_tick})
    }

    fn publish_city_vehicle(&mut self, asset: Arc<vehicle_assets::DrivableVehicle>) -> Result<CityVehicleResponse, (StatusCode, String)> {
        if self.city.is_none() {
            return Err((StatusCode::SERVICE_UNAVAILABLE, "The city is still unavailable on this server.".into()));
        }
        // Retrying a publish reuses its existing car rather than filling the city.
        if let Some((&id, existing)) = self.custom_vehicles.iter().find(|(_, a)| a.vehicle.asset_hash == asset.vehicle.asset_hash) {
            if let Some(car) = self.arena.snapshot_vehicles().iter().find(|car| car.id == id) {
                return Ok(CityVehicleResponse { match_id: self.id.clone(), vehicle_id: id,
                    position: [car.px_mm as f32 * 0.001, car.py_mm as f32 * 0.001, car.pz_mm as f32 * 0.001], vehicle: existing.vehicle.clone() });
            }
        }
        const FIRST_ID: u32 = 20_000;
        const CAPACITY: u32 = 8;
        let cars = self.arena.snapshot_vehicles();
        let slot = (0..CAPACITY).find(|slot| {
            let id = FIRST_ID + slot;
            let x = city::spawn_ring_radius_m() + 14.0;
            let z = *slot as f32 * 8.0 - 28.0;
            !self.arena.vehicle_exists(id)
                && cars.iter().all(|car| (car.px_mm as f32 * 0.001 - x).hypot(car.pz_mm as f32 * 0.001 - z) > 6.0)
                && self.players.keys().all(|player| self.arena.player_state(*player).is_none_or(|p|
                    (p.position.x as f32 - x).hypot(p.position.z as f32 - z) > 6.0))
        }).ok_or((StatusCode::CONFLICT, "The city's garage parking is full or occupied. Try an existing configuration or wait for a clear space.".into()))?;
        let id = FIRST_ID + slot;
        let handle = (1..=u8::MAX).find(|handle| !self.vehicle_handles.values().any(|v| v == handle))
            .ok_or((StatusCode::CONFLICT, "The city has reached its vehicle limit.".into()))?;
        let position = [city::spawn_ring_radius_m() + 14.0, asset.geometry.origin_height + 0.15, slot as f32 * 8.0 - 28.0];
        self.arena.spawn_prepared_vehicle(id, 0, nalgebra::Vector3::from(position), &asset.geometry)
            .map_err(|error| {
                error!(%error, "city vehicle could not initialize");
                (StatusCode::INTERNAL_SERVER_ERROR, "The vehicle could not be spawned in the city.".into())
            })?;
        self.vehicle_handles.insert(id, handle);
        let packet = vehicle_assets::asset_packet(handle, &asset.vehicle);
        for runtime in self.players.values() {
            let _ = try_queue_packet(&runtime.tx, packet.clone(), &self.io);
        }
        let vehicle = asset.vehicle.clone();
        self.custom_vehicles.insert(id, asset);
        Ok(CityVehicleResponse { match_id: self.id.clone(), vehicle_id: id, position, vehicle })
    }

    fn current_server_time_ms(&self) -> u32 {
        self.server_tick * (1000 / SIM_HZ as u32)
    }

    /// The id a `VehicleEnter`/`VehicleExit` packet names. A V2 client only
    /// ever sees u8 handles, so under strict snapshot datagrams the handle
    /// table is consulted first; a legacy client sends the runtime id and gets
    /// it back directly. Either way an id that is not a handle still resolves
    /// as itself, so the city's ids above 255 cannot collide with a handle.
    fn resolve_vehicle_runtime_id(&self, wire_vehicle_id: u32) -> Option<u32> {
        let by_handle = || {
            let handle = u8::try_from(wire_vehicle_id).ok()?;
            self.vehicle_handles
                .iter()
                .find_map(|(vehicle_id, vehicle_handle)| {
                    (*vehicle_handle == handle).then_some(*vehicle_id)
                })
        };
        if self.strict_snapshot_datagrams {
            return by_handle().or_else(|| self.arena.vehicle_exists(wire_vehicle_id).then_some(wire_vehicle_id));
        }
        if self.arena.vehicle_exists(wire_vehicle_id) {
            return Some(wire_vehicle_id);
        }
        by_handle()
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

    fn send_initial_metadata(&self, tx: &outbound::Sender) {
        for (id, asset) in &self.custom_vehicles {
            if let Some(handle) = self.vehicle_handles.get(id) {
                let _ = try_queue_packet(tx, vehicle_assets::asset_packet(*handle, &asset.vehicle), &self.io);
            }
        }
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
            MatchEvent::GarageBombardment {enabled,reply} => {
                if !reply.is_closed() {
                    let result=if self.garage.as_ref().is_some_and(|session|!session.closing()) {
                        Ok(self.bombardment.set_enabled(enabled,self.server_tick))
                    } else { Err((StatusCode::NOT_FOUND,"This test drive has ended.".into())) };
                    let _=reply.send(result);
                }
            }
            MatchEvent::TuneGarageVehicle {expected_asset_hash,vehicle,reply} => {
                if !reply.is_closed() {let _=reply.send(self.tune_garage_vehicle(&expected_asset_hash,vehicle));}
            }
            MatchEvent::PublishVehicle { asset, reply } => {
                if !reply.is_closed() {
                    let result = self.publish_city_vehicle(asset);
                    let _ = reply.send(result);
                }
            }
            MatchEvent::Session(command) => self.handle_session_command(command),
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
                        link: conn.link.clone(),
                        city_rate: link_rate::RateController::new(link_rate::RateConfig::configured()),
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
                        next_allowed_camera_drop_ms: 0,
                        melee_flag_clear_tick: 0,
                        spawn_protection_ends_at_tick: 0,
                        respawn_at_ms: None,
                        snapshot_interest: Default::default(),
                        visible_batteries: HashSet::new(),
                        battery_full_resync_pending: true,
                        energy_gate: crate::energy_stream::EnergySendGate::default(),
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
                    city.capture_event(
                        self.server_tick,
                        serde_json::json!({"kind": "join", "player": conn.player_id}),
                    );
                    // A bootstrap dropped here is the worst case of all: the
                    // client never had a ledger, so it never sees a sequence
                    // gap either -- it renders the intact manifest forever and
                    // reports nothing wrong. Enrol it for repair instead.
                    let mut delivered =
                        try_queue_packet(&conn.tx, city.bootstrap(self.server_tick), &self.io);
                    if let Some(lanes) = city.full_lane_map() {
                        delivered = try_queue_packet(&conn.tx, lanes, &self.io) && delivered;
                    }
                    // The manifest is NOT sent here, although the client
                    // cannot use anything above until it has one. It fetches it
                    // over HTTP and asks for a copy down the session only when
                    // that fails; see PKT_CITY_MANIFEST and CityManifestRequest.
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
                    city.capture_event(
                        self.server_tick,
                        serde_json::json!({"kind": "leave", "player": player_id}),
                    );
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
                    ClientPacket::CityCameraDrop(cmd) => {
                        // The connection supplies player_id: a packet cannot move anyone else.
                        let now_ms = self.server_tick * (1000 / SIM_HZ as u32);
                        if is_dead || !city::is_city_match(&self.id) || now_ms < runtime.next_allowed_camera_drop_ms {
                            return;
                        }
                        if self.arena.drop_player_from_camera(player_id, &cmd) {
                            runtime.next_allowed_camera_drop_ms = now_ms.saturating_add(500);
                            runtime.pending_inputs.clear();
                            runtime.last_applied_input = InputCmd { yaw: cmd.yaw, pitch: cmd.pitch, ..InputCmd::default() };
                        }
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
                    ClientPacket::CityManifestRequest => {
                        // 1.8 MB down the ordered reliable lane, so it is sent
                        // to the one client that could not get it any other way
                        // and to nobody else. Everything that client has queued
                        // behind it waits, which is the cost of the only route
                        // that works from a rented box.
                        if let Some((_, _, gzipped)) = city::manifest_asset() {
                            info!(
                                match_id = %self.id,
                                player_id,
                                bytes = gzipped.len(),
                                "city manifest requested over the session; HTTP fetch must have failed"
                            );
                            let mut packet = Vec::with_capacity(gzipped.len() + 1);
                            packet.push(vibe_land_shared::constants::PKT_CITY_MANIFEST);
                            packet.extend_from_slice(gzipped);
                            let _ = try_queue_packet(&runtime.tx, packet, &self.io);
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
                                city.note_client_bootstrap(u64::from(player_id));
                                let _ = try_queue_packet(&runtime.tx, bootstrap, &self.io);
                            } else {
                                // Scoped requests can report hash mismatch,
                                // missing migration destination, or rejected
                                // settle pose; the protocol carries IDs only.
                                info!(
                                    match_id = %self.id,
                                    player_id,
                                    last_topo_seq,
                                    ?structures,
                                    "city structure resync requested; sending structure bootstrap"
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
        // Every packet queued from here on is stamped with this tick.
        self.io.send_hub.set_tick(self.server_tick);
        self.poll_session_capture();
        self.reclaim_player_handles();
        self.tick_meteors_launched = 0;
        self.tick_meteor_launch_ms = 0.0;
        let dt = 1.0 / SIM_HZ as f32;
        // How many 60 Hz input frames this tick is entitled to consume.
        //
        // The loop is a fixed 60 Hz interval with MissedTickBehavior::Skip, so
        // when a tick overruns its budget the missed ticks are dropped and
        // simulated time falls behind the wall clock. Clients keep sending 60
        // frames a second regardless, so the server must consume them at the
        // rate they were PRODUCED, not at the rate it happens to be ticking —
        // otherwise the player's body advances slower than their own client
        // predicts and every reconcile yanks them backwards.
        //
        // Budgeting by real elapsed time is also what keeps this from being a
        // speed exploit: a client that floods input still cannot move faster
        // than wall-clock, because the budget is wall-clock / dt. The cap
        // bounds the cost of one slow tick (KCC is ~0.03 ms per frame, so 4
        // is ~0.12 ms) and stops a long stall from teleporting anyone.
        // Credit, not rounding. A 69 ms tick earns 4.13 frames; rounding to 4
        // silently loses 0.13 every tick, which is a backlog growing at ~2
        // frames/s -- measured live at pending_inputs 21 -> 89 over a minute
        // and a half, i.e. the player's input arriving 1.5 s late. The
        // fraction has to carry.
        //
        // Credit is capped so a long stall cannot bank unbounded movement and
        // then spend it in one tick.
        let elapsed_since_last_tick = self
            .last_tick_instant
            .map(|previous| tick_started.saturating_duration_since(previous).as_secs_f32());
        self.last_tick_instant = Some(tick_started);
        let (input_budget, remaining_credit) =
            spend_input_credit(self.input_credit, elapsed_since_last_tick, dt);
        self.input_credit = remaining_credit;
        let server_time_ms = self.server_tick * (1000 / SIM_HZ as u32);

        self.process_respawns(server_time_ms);
        self.expire_spawn_protection();

        let ids: Vec<u32> = self.players.keys().copied().collect();
        let player_sim_started = Instant::now();
        let mut player_move_math_ms = 0.0f32;
        let mut input_frames_applied = 0.0f32;
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
            let in_vehicle = self.arena.is_player_in_vehicle(player_id);
            // Vehicle controls are continuous state, not precious per-frame
            // history, and the vehicle is integrated by PhysX rather than by
            // replaying frames — so one newest-wins control per tick stays
            // correct there. On foot, every frame is displacement the client
            // has already predicted, so the tick drains as many as real time
            // says were produced.
            let mut applied: Vec<InputCmd> = Vec::new();
            if let Some(runtime) = self.players.get_mut(&player_id) {
                // A backlog is time the server OWED this player and failed to
                // simulate; draining it needs one frame beyond the real-time
                // allowance, or the queue just sits at whatever depth it
                // reached and the player stays permanently that far behind.
                // Exactly one, so the fastest anyone can move is real time
                // plus a frame per tick while they are actually behind.
                let frames = if in_vehicle {
                    1
                } else if runtime.pending_inputs.len() > input_budget {
                    (input_budget + 1).min(MAX_INPUT_FRAMES_PER_TICK)
                } else {
                    input_budget
                };
                for index in 0..frames {
                    // The first frame always applies: with an empty queue
                    // take_input_for_tick repeats the last applied input,
                    // which is how a client that has gone quiet keeps its
                    // held movement. Later frames require a real queued one,
                    // or a quiet client would be moved twice.
                    if index > 0 && runtime.pending_inputs.is_empty() {
                        break;
                    }
                    applied.push(take_input_for_tick_with_vehicle_catchup(
                        runtime, in_vehicle,
                    ));
                }
            }
            if applied.is_empty() {
                applied.push(InputCmd::default());
            }
            input_frames_applied += applied.len() as f32;
            // Each frame is simulated in order, with its own dt, and the
            // energy drain and previous-input/on-ground pair are re-read
            // between frames — the drain is per frame of movement, not per
            // tick, and a jump landing inside the tick must be seen by the
            // frame after it.
            let mut frame_previous_input = previous_input;
            let mut frame_was_on_ground = was_on_ground;
            let mut last_result = None;
            for frame in &applied {
                on_foot_energy_drains.push((
                    player_id,
                    frame_previous_input,
                    frame.clone(),
                    frame_was_on_ground,
                ));
                last_result = self.arena.simulate_player_tick(player_id, frame, dt);
                frame_previous_input = frame.clone();
                frame_was_on_ground = self
                    .arena
                    .player_state(player_id)
                    .map(|state| state.on_ground)
                    .unwrap_or(frame_was_on_ground);
            }
            if let Some(result) = last_result {
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
        self.timings
            .input_frames_per_tick
            .record(input_frames_applied);
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

        if self.garage.is_some() {
            let target=self.arena.snapshot_vehicles().iter().find(|car|car.id==garage::VEHICLE_ID && car.driver_id!=0)
                .map(|car|(nalgebra::Vector3::new(car.px_mm as f32,car.py_mm as f32,car.pz_mm as f32)/1000.0,
                    nalgebra::Vector3::new(car.vx_cms as f32,car.vy_cms as f32,car.vz_cms as f32)/100.0));
            if let Some(shot)=self.bombardment.next_shot(self.server_tick,target) {
                if self.arena.launch_ball_from_muzzle(shot.origin,shot.velocity,garage_bombardment::BALL_RADIUS,
                    garage_bombardment::BALL_MASS,garage_bombardment::BALL_TTL).is_some() {
                    self.bombardment.record_launch();
                }
            }
        }

        // Fracture-frame resimulation capture. Must be immediately before the
        // step: taken any later, the destruction tick has already drained the
        // contact queue and the capture is against the wrong frame.
        #[cfg(feature = "physx-city")]
        {
            let mut city = self.city.take();
            if let Some(city_ref) = city.as_mut() {
                city_ref.pre_step(self.arena.physx_world_mut());
            }
            self.city = city;
        }
        let (vehicle_ms, dynamics_ms) = if observer_pipeline_enabled()
            && self.arena.supports_split_step()
        {
            // Split step: dispatch, then run last tick's deferred city
            // observer bundle inside the GPU wait. The bundle takes no World;
            // the scene is mid-simulate and any PhysX call here is illegal
            // (gpu_warning_count is the runtime tripwire).
            self.arena.begin_dynamics(dt);
            self.flush_staged_city_observer();
            self.arena.finish_dynamics()
        } else {
            self.arena.step_vehicles_and_dynamics(dt)
        };
        self.arena.reduce_audio_contacts(&mut self.contact_audio, self.server_tick);
        if self.server_tick % (u32::from(SIM_HZ) / 20).max(1) == 0 {
            for (&player_id, player) in &self.players {
                if let Some((pos, ..)) = self.arena.snapshot_player(player_id) {
                    if let Some(packet) = self.contact_audio.packet_for(self.server_tick, pos) {
                        let _ = try_queue_packet(&player.tx, packet, &self.io);
                    }
                }
            }
            self.contact_audio.clear_window();
        }
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

        // Its own bracket: a player-fired meteor launch (a raycast, a new
        // actor, a packet to every client) used to land in unattributed.
        let shots_started = Instant::now();
        self.route_city_shots();
        let shots_ms = shots_started.elapsed().as_secs_f32() * 1000.0;

        let hitscan_started = Instant::now();
        self.process_hitscan(server_time_ms);
        self.timings
            .hitscan_ms
            .record(hitscan_started.elapsed().as_secs_f32() * 1000.0);
        self.process_melee(server_time_ms);

        self.sync_reliable_world_state();

        let city_started = Instant::now();
        self.tick_city(dt);
        // The deferred flush ran between the split step's halves, where
        // neither dynamics_ms nor this bracket sees it; fold it in here so
        // city work stays city-attributed and the residual stays honest.
        let city_total_ms = city_started.elapsed().as_secs_f32() * 1000.0
            + self.last_observer_flush_ms;
        self.timings.city_total_ms.record(city_total_ms);

        // `timings.snapshot_ms` is a rolling record of snapshot ticks only, so
        // its `last()` on any other tick is the previous snapshot tick's cost.
        // This tick's own value is what the residual and the capture need.
        let snapshot_sent =
            self.server_tick % (SIM_HZ as u32 / self.physics.snapshot_hz() as u32) == 0;
        let mut snapshot_tick_ms = 0.0f32;
        if snapshot_sent {
            self.broadcast_snapshot();
            snapshot_tick_ms = self.timings.snapshot_ms.last();
        }

        if self.server_tick % PLAYER_ROSTER_SYNC_INTERVAL_TICKS == 0 {
            self.queue_roster_sync();
        }

        let mut publish_tick_ms = 0.0f32;
        if self.server_tick % SERVER_PING_INTERVAL_TICKS == 0 {
            let publish_started = Instant::now();
            self.send_server_latency_pings();
            self.publish_stats();
            self.log_city_telemetry();
            self.last_publish_ms = publish_started.elapsed().as_secs_f32() * 1000.0;
            publish_tick_ms = self.last_publish_ms;
        }

        let total_ms = tick_started.elapsed().as_secs_f32() * 1000.0;
        self.timings.total_ms.record(total_ms);
        // The residual: what this tick spent that no bracket claims. The
        // subtraction uses ONLY per-tick locals and top-level brackets (never
        // a child of another bracket), so double-subtraction is impossible by
        // construction. Negative would mean overlapping brackets — clamped
        // visible at 0 but recorded raw in spirit via the warn path.
        let attributed = self.timings.player_sim_ms.last()
            + self.timings.vehicle_ms.last()
            + self.timings.dynamics_ms.last()
            + self.timings.hitscan_ms.last()
            + shots_ms
            + city_total_ms
            + snapshot_tick_ms
            + publish_tick_ms;
        self.timings
            .tick_unattributed_ms
            .record((total_ms - attributed).max(0.0));
        let city_stats = self.city.as_ref().map(|city| city.stats());
        self.tick_ring.push_back(TickRingEntry {
            t: self.server_tick,
            total: total_ms,
            dyn_ms: self.timings.dynamics_ms.last(),
            city: city_total_ms,
            awake: city_stats
                .as_ref()
                .map(|stats| stats.awake_chunk_bodies)
                .unwrap_or(0),
            frozen: city_stats
                .as_ref()
                .map(|stats| stats.frozen_chunk_bodies)
                .unwrap_or(0),
            flips: city_stats
                .as_ref()
                .map(|stats| stats.freeze_flips + stats.unfreeze_flips)
                .unwrap_or(0),
        });
        while self.tick_ring.len() > TICK_RING_CAP {
            self.tick_ring.pop_front();
        }
        self.record_session_tick(session_match::TickCosts {
            total_ms,
            city_ms: city_total_ms,
            publish_ms: publish_tick_ms,
            unattributed_ms: (total_ms - attributed).max(0.0),
            snapshot_ms: snapshot_tick_ms,
            snapshot_sent,
            shots_ms,
            meteors_launched: self.tick_meteors_launched,
            meteor_launch_ms: self.tick_meteor_launch_ms,
            overlap_ms: self.last_observer_flush_ms,
        });
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
            city.note_client_bootstrap(u64::from(player_id));
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
        let shots: Vec<(glam::Vec3, glam::Vec3, u8, u32)> = self
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
                    queued.cmd.weapon,
                    queued.player_id,
                ))
            })
            .collect();
        let shot_count = shots.len();
        let mut city = self.city.take().expect("checked above");
        let broken_before = city.stats().broken_bonds;
        let mut hits = 0u32;
        let mut balls = 0u32;
        let mut meteors = 0u32;
        for (origin, direction, weapon, shooter) in shots {
            // A meteor is aimed, not thrown: the ray picks a point on the
            // world and the rock is launched from far outside it on an arc
            // through that point. Whatever it meets first is what it hits.
            if weapon == WEAPON_METEOR {
                if let Some(event) = self.launch_meteor_at(origin, direction, shooter) {
                    meteors += 1;
                    city.capture_event(self.server_tick, event);
                }
                continue;
            }
            // A cannonball is not routed into the city at all. It is thrown
            // into the scene and then it is the scene's problem: what it hits
            // and what that breaks is decided by PhysX solving its contacts,
            // which is exactly how the engine's own demos deliver a shot.
            if city.capturing() {
                city.capture_event(
                    self.server_tick,
                    serde_json::json!({
                        "kind": "shot",
                        "weapon": weapon,
                        "shooter": shooter,
                        "origin": origin.to_array(),
                        "direction": direction.to_array(),
                    }),
                );
            }
            if weapon == WEAPON_CANNONBALL {
                let launched = self.arena.launch_ball(
                    nalgebra::Vector3::new(origin.x, origin.y, origin.z),
                    nalgebra::Vector3::new(direction.x, direction.y, direction.z),
                    city::city_ball_radius_m(),
                    city::city_ball_mass_kg(),
                    city::city_ball_speed_ms(),
                    city::city_ball_ttl_ticks(),
                );
                if launched.is_some() {
                    balls += 1;
                }
                continue;
            }
            #[cfg(feature = "physx-city")]
            let world = self.arena.physx_world_mut();
            #[cfg(not(feature = "physx-city"))]
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
                balls_launched = balls,
                meteors_launched = meteors,
                balls_live = self.arena.launched_ball_count(),
                broken_bonds_before = broken_before,
                "city shot routing"
            );
        }
        self.city = Some(city);
    }

    /// Aim a meteor along `direction` from `origin` and launch it. True when
    /// a rock left the sky.
    ///
    /// The ray needs something solid to land on; aimed at the sky, nothing is
    /// launched, because a meteor through a point in the air is a meteor
    /// nobody sees land. Every client is told the arc so it can draw the fall
    /// from the start, which is well outside the range the body snapshot can
    /// express (see `PKT_METEOR_LAUNCHED`).
    fn launch_meteor_at(
        &mut self,
        origin: glam::Vec3,
        direction: glam::Vec3,
        shooter: u32,
    ) -> Option<serde_json::Value> {
        let Some(target) = self.arena.cast_solid_ray_point(
            origin.to_array(),
            direction.to_array(),
            HITSCAN_MAX_DISTANCE_M,
        ) else {
            tracing::info!(match_id = %self.id, shooter, "meteor aimed at nothing");
            return None;
        };
        self.launch_meteor_at_point(glam::Vec3::from_array(target), shooter)
    }

    /// Launch a meteor onto an exact world point. Returns the capture event
    /// describing the launch, or `None` if no rock left the sky.
    fn launch_meteor_at_point(
        &mut self,
        target: glam::Vec3,
        shooter: u32,
    ) -> Option<serde_json::Value> {
        let started = Instant::now();
        let event = self.plan_and_launch_meteor(target, shooter);
        self.tick_meteor_launch_ms += started.elapsed().as_secs_f32() * 1000.0;
        if event.is_some() {
            self.tick_meteors_launched += 1;
        }
        event
    }

    fn plan_and_launch_meteor(
        &mut self,
        target: glam::Vec3,
        shooter: u32,
    ) -> Option<serde_json::Value> {
        let gravity = {
            let g = vibe_netcode::movement::default_world_gravity();
            glam::Vec3::new(g[0], g[1], g[2])
        };
        let tuning = meteor::MeteorTuning::from_env();
        let launch = meteor::plan(target, gravity, &tuning, &mut self.meteor_rng);
        let Some(body_id) = self.arena.launch_meteor(
            nalgebra::Vector3::new(launch.start.x, launch.start.y, launch.start.z),
            nalgebra::Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z),
            tuning.radius_m,
            tuning.mass_kg,
            tuning.ttl_ticks,
        ) else {
            return None;
        };
        let packet = meteor::encode_meteor_launched(&meteor::MeteorLaunchedPacket {
            body_id,
            shooter_player_id: shooter,
            server_launch_time_us: (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64),
            start: launch.start.to_array(),
            velocity: launch.velocity.to_array(),
            target: target.to_array(),
            radius_m: tuning.radius_m,
            gravity_ms2: -gravity.y,
            flight_time_s: launch.flight_time_s,
        });
        for player in self.players.values() {
            let _ = try_queue_packet(&player.tx, packet.clone(), &self.io);
        }
        tracing::info!(
            match_id = %self.id,
            shooter,
            body_id,
            target = ?target.to_array(),
            start = ?launch.start.to_array(),
            speed = launch.velocity.length(),
            flight_s = launch.flight_time_s,
            mass_kg = tuning.mass_kg,
            "meteor launched"
        );
        Some(serde_json::json!({
            "kind": "meteor",
            "shooter": shooter,
            "body_id": body_id,
            "target": target.to_array(),
            "start": launch.start.to_array(),
            "velocity": launch.velocity.to_array(),
            "flight_s": launch.flight_time_s,
            "radius_m": tuning.radius_m,
            "mass_kg": tuning.mass_kg,
        }))
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

    /// Flush tick N−1's staged city observer bundle (ingest → encode →
    /// sends), scheduled inside the split step's GPU wait. Everything here is
    /// the tail of tick_city, verbatim, run one tick later against the
    /// staged output; it takes no World and must never touch PhysX — the
    /// scene is mid-simulate.
    fn flush_staged_city_observer(&mut self) {
        self.last_observer_flush_ms = 0.0;
        let Some(staged) = self.staged_city.take() else {
            return;
        };
        #[cfg(not(feature = "physx-city"))]
        let _ = staged;
        #[cfg(feature = "physx-city")]
        {
            let started = Instant::now();
            let staged_tick = staged.sim_tick;
            let Some(send_interval) =
                self.city.as_ref().map(|city| city.send_interval_ticks())
            else {
                return;
            };
            // Cadence keyed to the STAGED tick so the stream keeps the exact
            // send pattern of the combined path, one tick later.
            let send_due =
                staged_tick % send_interval == 0 && !self.players.is_empty();
            let cameras: Vec<(u32, vibe_land_destruction::types::Camera)> = if send_due {
                self.players
                    .keys()
                    .filter_map(|&id| {
                        self.city_camera_for_player(id).map(|camera| (id, camera))
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let mut city = self.city.take().expect("checked above");
            let reliable = city.flush_staged(staged);
            let v3_datagrams = city.take_v3_datagrams();
            let fan_out_started = std::time::Instant::now();
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
            let v2_pose_stream = v3_datagrams.is_empty()
                && city.wire_version() != vibe_land_destruction::wire::CITY_WIRE_V3;
            if send_due && v2_pose_stream {
                let encode_started = std::time::Instant::now();
                let shared = city.encode_shared(staged_tick);
                let shared_ms = encode_started.elapsed().as_secs_f32() * 1000.0;
                let datagrams_started = std::time::Instant::now();
                let has_records = !shared.records.is_empty();
                for (player_id, camera) in cameras {
                    let Some(packets) = self.city_datagrams_for(
                        &mut city,
                        player_id,
                        camera,
                        has_records.then_some(&shared),
                        staged_tick,
                    ) else {
                        continue;
                    };
                    if let Some(runtime) = self.players.get(&player_id) {
                        for packet in packets {
                            let _ = try_queue_packet(&runtime.tx, packet, &self.io);
                        }
                    }
                }
                city.record_encode_timings(
                    shared_ms,
                    datagrams_started.elapsed().as_secs_f32() * 1000.0,
                );
            }
            self.city = Some(city);
            self.repair_city_desyncs();
            self.last_observer_flush_ms = started.elapsed().as_secs_f32() * 1000.0;
        }
    }

    /// One client's city datagrams for this send: its pending topology
    /// copies first (`EncoderConfig::topology_datagram_copies`), then its
    /// pose records under its link's rate plan (`link_rate.rs`) -- the static
    /// ceiling while the link keeps up, a smaller allowance (less what the
    /// copies took) when it does not, or none when the budget is carried to
    /// the next send. `shared` is `None` when no body has a record this send;
    /// the copies still go. `None` when there is nothing to send.
    fn city_datagrams_for(
        &mut self,
        city: &mut city::CityRuntime,
        player_id: u32,
        camera: vibe_land_destruction::types::Camera,
        shared: Option<&vibe_land_destruction::encoder::SharedRecords>,
        tick: u32,
    ) -> Option<Vec<Vec<u8>>> {
        let client = u64::from(player_id);
        if shared.is_none() && !city.has_topology_copies(client) {
            return None;
        }
        let send_interval_s = f64::from(city.send_interval_ticks().max(1)) / f64::from(SIM_HZ);
        let ceiling = city.client_ceiling_bytes();
        let plan = shared.map(|_| match self.players.get_mut(&player_id) {
            Some(runtime) => match runtime.link.as_ref().and_then(|link| link.sample()) {
                Some(sample) => {
                    city.note_link_rtt(client, sample.rtt_us as f32 / 1000.0);
                    let before = runtime.city_rate.state();
                    let plan = runtime.city_rate.plan(sample, send_interval_s, ceiling);
                    let after = runtime.city_rate.state();
                    if before != after {
                        info!(
                            match_id = %self.id,
                            player_id,
                            state = ?after,
                            capacity_kbit_s = runtime.city_rate.capacity_bytes_per_s() * 8.0 / 1000.0,
                            buffered_bytes = sample.datagram_buffered_bytes,
                            "city stream rate adaptation"
                        );
                    }
                    plan
                }
                None => link_rate::SendPlan::Full,
            },
            None => link_rate::SendPlan::Full,
        });
        let mut packets = Vec::new();
        let copies = city.add_topology_copies(client, tick, &mut packets);
        match (plan, shared) {
            (Some(plan), Some(shared)) if plan != link_rate::SendPlan::Skip => {
                packets.extend(city.client_datagrams_within(
                    client,
                    camera,
                    shared,
                    plan.after_topology(copies).allowance(),
                    plan.ceiling_sends(),
                ));
                self.note_selection(session_capture::Selection {
                    tick,
                    player: player_id,
                    kind: session_capture::SelectionKind::City(city.last_client_selection()),
                });
                if let Some(runtime) = self.players.get_mut(&player_id) {
                    runtime.city_rate.sent(packets.iter().map(Vec::len).sum(), plan);
                }
            }
            _ => {
                if let Some(runtime) = self.players.get_mut(&player_id) {
                    runtime.city_rate.sent_topology(copies);
                }
            }
        }
        (!packets.is_empty()).then_some(packets)
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
        if send_due {
            city.capture_cameras(self.server_tick, &cameras);
        }
        // Scripted meteors: one per tick so the pool ring is never asked for
        // more than the sky can hold in one frame.
        let meteor_target = self
            .meteor_requests
            .write()
            .expect("meteor requests poisoned")
            .get_mut(&self.id)
            .and_then(|queue| if queue.is_empty() { None } else { Some(queue.remove(0)) });
        if let Some(target) = meteor_target {
            if let Some(event) = self.launch_meteor_at_point(glam::Vec3::from_array(target), 0) {
                city.capture_event(self.server_tick, event);
            }
        }
        if city.capturing()
            && self
                .capture_stop_requests
                .write()
                .expect("capture stop requests poisoned")
                .remove(&self.id)
        {
            city.finish_capture();
        }
        // Before the world is bound for the reset below, which borrows it for
        // the rest of this block.
        if let Some(request) = self
            .demolish_requests
            .write()
            .expect("demolish requests poisoned")
            .remove(&self.id)
        {
            city.set_demolition_shape(request.heading_deg, request.wedge_deg, request.jitter);
            let (centre, height) = if request.tallest {
                city.tallest_footprint()
                    .map(|(c, h)| (c, h))
                    .unwrap_or(([request.x, request.z], 0.0))
            } else {
                ([request.x, request.z], 0.0)
            };
            let queued = city.demolish_supports(
                centre,
                request.radius_m,
                request.below_y,
                request.rounds,
                self.arena.physx_world_mut(),
            );
            self.demolish_per_tick = request.per_tick.max(1);
            info!(
                match_id = %self.id, queued, ?centre, height,
                "city demolition queued"
            );
            city.capture_event(
                self.server_tick,
                serde_json::json!({
                    "kind": "demolish",
                    "centre": centre,
                    "radius_m": request.radius_m,
                    "below_y": request.below_y,
                    "rounds": request.rounds,
                    "queued": queued,
                    "wedge_deg": request.wedge_deg,
                    "heading_deg": request.heading_deg,
                    "jitter": request.jitter,
                    "per_tick": request.per_tick,
                }),
            );
        }
        // A few rounds a tick, every tick, so the structure fails
        // progressively instead of being cut in half in one frame.
        {
            let per_tick = self.demolish_per_tick;
            let world = self.arena.physx_world_mut();
            city.drain_demolition(per_tick, world);
        }
        #[cfg(feature = "physx-city")]
        let world = self.arena.physx_world_mut();
        #[cfg(not(feature = "physx-city"))]
        let world = None;
        // Between steps is the only safe point to rebuild: the scene is not
        // mid-simulate, and the bootstrap we send afterwards describes the
        // city the very next step will advance.
        let mut reset_requested = self
            .reset_requests
            .write()
            .expect("reset requests poisoned")
            .remove(&self.id);
        // A stage that has stopped producing frames asks for the same repair a
        // player would have asked for, and cannot say so itself: the server
        // keeps its tick rate, the clients keep their connections, and the only
        // symptom is that the city has quietly become indestructible. Two
        // seconds of that is enough to act on. See CityRuntime::needs_rebuild.
        if !reset_requested && city.needs_rebuild() {
            error!(
                match_id = %self.id,
                players = self.players.len(),
                "the destruction stage has produced no frame for two seconds; rebuilding the city"
            );
            reset_requested = true;
        }
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
        #[cfg(feature = "physx-city")]
        let world = self.arena.physx_world_mut();
        #[cfg(not(feature = "physx-city"))]
        let world = None;
        let broken_before = city.stats().broken_bonds;
        let awake_before = city.stats().awake_chunk_bodies;
        // 60 Hz: destruction step + reliable topology/baseline broadcast
        // (byte-identical for every client — encode once, clone the buffer).
        let city_step_started = std::time::Instant::now();
        let (reliable, staged) = if observer_pipeline_enabled() {
            city.step_stage(
                self.server_tick,
                dt,
                vibe_netcode::movement::default_world_gravity(),
                world,
            )
        } else {
            (
                city.step(
                    self.server_tick,
                    dt,
                    vibe_netcode::movement::default_world_gravity(),
                    world,
                ),
                None,
            )
        };
        let city_step_wall_ms = city_step_started.elapsed().as_secs_f32() * 1000.0;
        city.record_tick_sample(city_step_wall_ms);
        // A staged tick's datagrams do not exist yet — its live-lane ingest
        // runs at flush, which drains them there.
        let v3_datagrams = if staged.is_some() {
            Vec::new()
        } else {
            city.take_v3_datagrams()
        };
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
        let mut reliable_bytes_out: u64 = 0;
        let mut outbound_drops: u64 = 0;
        for packet in &reliable {
            for (player_id, runtime) in self.players.iter() {
                if try_queue_packet(&runtime.tx, packet.clone(), &self.io) {
                    reliable_bytes_out += packet.len() as u64;
                } else {
                    outbound_drops += 1;
                    if !desynced.contains(player_id) {
                        desynced.push(*player_id);
                    }
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
        // Chunk stream cadence (wire v2 only): shared encode once, per-client
        // interest + ceiling selection, own datagram sequence space per client.
        let v2_pose_stream = staged.is_none()
            && v3_datagrams.is_empty()
            && city.wire_version() != vibe_land_destruction::wire::CITY_WIRE_V3;
        let mut encode_ms_this_tick = 0.0_f32;
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
            let has_records = !shared.records.is_empty();
            for (player_id, camera) in cameras {
                let Some(packets) = self.city_datagrams_for(
                    &mut city,
                    player_id,
                    camera,
                    has_records.then_some(&shared),
                    self.server_tick,
                ) else {
                    continue;
                };
                if let Some(runtime) = self.players.get(&player_id) {
                    for packet in packets {
                        if !try_queue_packet(&runtime.tx, packet, &self.io) {
                            outbound_drops += 1;
                        }
                    }
                }
            }
            let datagrams_ms = datagrams_started.elapsed().as_secs_f32() * 1000.0;
            encode_ms_this_tick = shared_ms + datagrams_ms;
            city.record_encode_timings(shared_ms, datagrams_ms);
        }
        if city.capturing() {
            let (sent_records, sent_bytes) = city.stream_totals();
            city.capture_stats(&vibe_land_destruction::netlab::capture::TickStats {
                tick: self.server_tick,
                awake: awake_after as u32,
                step_ms: city_step_wall_ms,
                encode_ms: encode_ms_this_tick,
                players: self.players.len() as u32,
                sent_records,
                sent_bytes,
                reliable_bytes: reliable_bytes_out,
                outbound_drops,
                desync_repairs: self.city_desync_repairs as u64,
            });
        }
        self.city = Some(city);
        self.staged_city = staged;
        // After the city is restored: repairs need `self.city` to build the
        // bootstrap. Called while it was taken out, the else-continue dropped
        // desynced players from the repair set without repairing them.
        self.repair_city_desyncs();
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
        let mut spans = std::collections::BTreeMap::new();
        for span in self.arena.take_physics_spans() {
            spans.insert(
                format!("physics/{}", span.name),
                SpanValue { v: span.value, k: span.kind },
            );
        }
        if let Some(city) = self.city.as_ref() {
            for span in city.extra_spans() {
                spans.insert(
                    format!("destruction/{}", span.name),
                    SpanValue { v: span.value, k: span.kind },
                );
            }
        }
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
        static FINGERPRINT: std::sync::OnceLock<vibe_land_destruction::fingerprint::Fingerprint> =
            std::sync::OnceLock::new();
        let match_stats = MatchStatsSnapshot {
            id: self.id.clone(),
            spans,
            tick_ring: Vec::new(),
            fingerprint: Some(
                FINGERPRINT
                    .get_or_init(|| vibe_land_destruction::fingerprint::capture_with_build(
                        cfg!(feature = "cuda-stress"),
                    ))
                    .clone(),
            ),
            scenario_tag: self.id.clone(),
            server_build: server_build_stamp(),
            server_started: server_started_stamp(),
            physics_backend: self.physics.backend.name().to_string(),
            physics_gpu_required: self.physics.capabilities.gpu_required,
            physics_gpu_active: physics_health.gpu_active,
            physics_gpu_warning_count: physics_health.gpu_warning_count,
            physics_contact_pairs: if physics_health.gpu_active {
                None
            } else {
                Some(physics_health.contact_pairs)
            },
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
                    push_reapply_ms: city.last_push_reapply_ms,
                    step_residual_ms: city.last_step_residual_ms,
                    tick_ffi_ms: stats.tick_ffi_ms,
                    drain_ms: stats.drain_ms,
                    support_ingest_ms: stats.support_ingest_ms,
                    cascade_ms: stats.cascade_ms,
                    post_step_total_ms: stats.post_step_total_ms,
                    post_step_residual_ms: stats.post_step_residual_ms,
                    stats_ffi_ms: stats.stats_ffi_ms,
                    post_step_ms: stats.post_step_ms,
                    resim_capture_ms: stats.resim_capture_ms,
                    resim_restore_ms: stats.resim_restore_ms,
                    resim_step_ms: stats.resim_step_ms,
                    resim_tick_ms: stats.resim_tick_ms,
                    resim_passes: stats.resim_passes,
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
                    frozen_aggregates: stats.frozen_aggregates,
                    frozen_aggregate_actors: stats.frozen_aggregate_actors,
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
        // The registry copy carries the tick ring; the telemetry copy does not
        // (serde skips the empty vec).
        let mut registry_copy = match_stats.clone();
        registry_copy.tick_ring = self.tick_ring.iter().cloned().collect();
        tokio::task::spawn_blocking(move || {
            // The numbers the players' stats overlay shows, pushed to the
            // players they describe as a ~250-byte datagram (see
            // match_stats_frame). The full snapshot -- ~15 kB of JSON that
            // used to go here, on the ordered stream in front of topology --
            // stays on GET /match-stats/:id.
            if !player_txs.is_empty() {
                match serde_json::to_value(&published) {
                    Ok(json) => {
                        let packet = match_stats_frame::encode(server_tick, &json);
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
                registry.insert(match_id.clone(), registry_copy);
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
                runtime.energy_gate.force();
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
            runtime.energy_gate.force();
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
        let tick = self.server_tick;
        if !runtime.energy_gate.due(tick, energy_centi) {
            return;
        }

        let packet =
            encode_server_packet(&ServerPacket::LocalPlayerEnergy(LocalPlayerEnergyPacket {
                energy_centi,
            }));
        if try_queue_packet(&runtime.tx, packet, &self.io) {
            runtime.energy_gate.sent(tick, energy_centi);
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

            // A cannonball has already been thrown by route_city_shots. It
            // hits things by colliding with them, so resolving it a second
            // time as an instant ray would damage players the ball never
            // reached. The fire rate and energy cost above still applied.
            if queued.cmd.weapon == WEAPON_CANNONBALL || queued.cmd.weapon == WEAPON_METEOR {
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
        let vehicle_rigs: Vec<_> = self.custom_vehicles.iter().filter_map(|(id, asset)| {
            let handle = *self.vehicle_handles.get(id)?;
            let wheels = self.arena.vehicle_rig(*id, asset.geometry.neutral_jounce)?;
            Some(vehicle_assets::rig_packet(self.server_tick, handle, wheels))
        }).collect();
        let server_time_us = (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64);
        // When this tick's state became available: stamped on every SnapshotV2
        // so clients can tell a slow simulation from a slow network.
        let server_wall_us = server_wall_clock_us();
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
        let world = snapshot_builder::SnapshotWorld {
            server_tick: self.server_tick,
            server_time_us,
            server_wall_us,
            players: &player_states,
            bodies: &dynamic_body_states,
            vehicles: &vehicle_states,
            player_handles: &self.player_handles,
            vehicle_handles: &self.vehicle_handles,
            body_meta: &self.dynamic_body_handles,
        };

        // Per-recipient interest / budget decisions, kept only while a
        // session capture runs (the counts themselves are free).
        let capturing = self.session_capture.is_some();
        let mut selections: Vec<session_capture::Selection> = Vec::new();
        let mut recipient_inputs: Vec<snapshot_builder::RecipientInput> = Vec::new();
        let mut snapshot_bytes_this_tick = 0usize;
        for recipient_id in recipient_ids {
            let Some(runtime) = self.players.get_mut(&recipient_id) else {
                continue;
            };
            let recipient = snapshot_builder::RecipientInput {
                id: recipient_id,
                ack_input_seq: runtime.last_ack_input_seq,
                support: if self.strict_snapshot_datagrams {
                    self.arena.player_support(recipient_id).map(Into::into)
                } else {
                    None
                },
            };
            let Some((packet, selection)) = snapshot_builder::build_recipient_snapshot(
                &world,
                &recipient,
                &mut runtime.snapshot_interest,
                self.strict_snapshot_datagrams,
                &snapshot_builder::SnapshotConfig::PRODUCTION,
            ) else {
                continue;
            };
            let tx = runtime.tx.clone();
            let encoded = encode_server_packet(&packet);
            snapshot_bytes_this_tick += encoded.len();
            self.snapshot_stats
                .bytes_per_client
                .record(encoded.len() as f32);
            self.snapshot_stats
                .players_per_client
                .record(snapshot_builder::packet_player_count(&packet) as f32);
            self.snapshot_stats
                .dynamic_bodies_per_client
                .record(snapshot_builder::packet_dynamic_body_count(&packet) as f32);
            self.snapshot_stats
                .vehicles_per_client
                .record(snapshot_builder::packet_vehicle_count(&packet) as f32);
            if capturing {
                let mut selection = selection;
                selection.bytes = encoded.len() as u32;
                selections.push(session_capture::Selection {
                    tick: self.server_tick,
                    player: recipient_id,
                    kind: session_capture::SelectionKind::Snapshot(selection),
                });
                recipient_inputs.push(recipient);
            }
            let _ = try_queue_packet(&tx, encoded, &self.io);
            for rig in &vehicle_rigs {let _ = try_queue_packet(&tx, rig.clone(), &self.io);}
        }
        for selection in selections {
            self.note_selection(selection);
        }
        if capturing {
            self.note_snapshot_inputs(server_wall_us, recipient_inputs);
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

/// How many 60 Hz input frames a tick may simulate, and the credit left over.
///
/// Split out of `tick` so the arithmetic is testable: the first version of it
/// rounded, discarding the fraction every tick, and the resulting backlog
/// only showed up in a live report as pending_inputs climbing to 89.
///
/// `elapsed` is None on the very first tick, which gets one frame.
fn spend_input_credit(credit: f32, elapsed: Option<f32>, dt: f32) -> (usize, f32) {
    let Some(elapsed) = elapsed else {
        return (1, 0.0);
    };
    // Capped so a long stall (a GC pause, a scene rebuild) cannot bank
    // unbounded movement and release it in a single tick.
    let earned = (credit + elapsed / dt).min(MAX_INPUT_FRAMES_PER_TICK as f32);
    let frames = (earned.floor() as usize).clamp(1, MAX_INPUT_FRAMES_PER_TICK);
    // Spent by time passing, not by anyone consuming it: an idle player must
    // not bank credit while away and sprint on their next input.
    (frames, (earned - frames as f32).max(0.0))
}

fn take_input_for_tick(runtime: &mut PlayerRuntime) -> InputCmd {
    // Ordered, one frame at a time. The caller decides HOW MANY frames a tick
    // is allowed to consume (see input_budget_for_tick); this function never
    // skips one.
    //
    // It used to jump to the newest frame whenever three were pending,
    // discarding the rest and acking the newest anyway. That is what made
    // walking rubber-band. Clients send a fixed 60 Hz; under a city collapse
    // the match loop runs at ~31 Hz; so the server applied ~31 frames a
    // second and threw away ~29, while telling the client it had applied all
    // of them. The client replays every unacked frame from the acked state,
    // arrives ~half a step ahead of where the server actually put the player,
    // exceeds the 0.15 m correction threshold, and gets pulled back — every
    // tick, forever. Measured live: 60.3 input/s sent against a 31.2 Hz
    // server, correction_m 0.19-0.32.
    //
    // Dropping frames also cannot be fixed by acking honestly: the server
    // would then integrate only half the player's motion and they would walk
    // at half speed. The frames have to be SIMULATED, which is what the
    // budgeted loop in the caller does.
    //
    // `on_foot_backlog_keeps_ordered_processing` guards this and has been red
    // since the skip was introduced.
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

use snapshot_builder::distance_sq;

#[cfg(test)]
fn dynamic_body_within_aoi(was_visible: bool, body_pos: [f32; 3], recipient_pos: [f32; 3]) -> bool {
    snapshot_builder::dynamic_body_within_aoi(
        &snapshot_builder::SnapshotConfig::PRODUCTION,
        was_visible,
        body_pos,
        recipient_pos,
    )
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

/// QUIC transport settings for the game connection.
///
/// The one that matters is the congestion controller. quinn defaults to Cubic,
/// which reads every lost packet as congestion, and on a link that loses
/// packets for other reasons -- wifi, cellular, a saturated uplink somewhere --
/// that puts a hard ceiling on the reliable lane at roughly
/// `MSS / (RTT * sqrt(loss))`. At 8% loss and 360 ms round trip that is about
/// 12 KiB/s, and the measured lane ran at 12 KiB/s: the controller was the
/// whole story. The visible symptom is a city that breaks on the server and
/// takes 28 seconds to break on the player's screen, because the topology
/// describing it is queued behind that ceiling.
///
/// BBR estimates bandwidth and round trip directly instead of treating loss as
/// the signal, which is exactly the mismatch here. It is not free -- it can be
/// less fair to competing loss-based flows on a shared bottleneck -- so it is
/// switchable, and the default is whichever the measurement below supports.
///
///   VIBE_WT_CONGESTION=bbr|cubic
fn wt_transport_config() -> wtransport::quinn::TransportConfig {
    let mut transport = wtransport::quinn::TransportConfig::default();
    // quinn's default, stated: the city rate controller reads occupancy as
    // this size minus `datagram_send_buffer_space()`.
    transport.datagram_send_buffer_size(link_rate::QUIC_DATAGRAM_SEND_BUFFER_BYTES);
    let choice = std::env::var("VIBE_WT_CONGESTION").unwrap_or_else(|_| "bbr".to_string());
    match choice.as_str() {
        "cubic" => {
            transport.congestion_controller_factory(std::sync::Arc::new(
                wtransport::quinn::congestion::CubicConfig::default(),
            ));
        }
        _ => {
            transport.congestion_controller_factory(std::sync::Arc::new(
                wtransport::quinn::congestion::BbrConfig::default(),
            ));
        }
    }
    info!(congestion = %choice, "WebTransport congestion controller");
    transport
}

fn wants_unreliable_delivery(kind: u8) -> bool {
    is_snapshot_packet_kind(kind)
        || kind == vibe_land_shared::constants::PKT_VEHICLE_RIG
        || kind == PKT_PING
        || kind == PKT_CITY_CHUNKS
        || kind == vibe_land_shared::constants::PKT_CITY_DEBRIS
        || kind == vibe_land_shared::constants::PKT_AUDIO_CONTACTS
        // Latest-wins telemetry: a lost frame is replaced a second later, and
        // it must never sit in front of topology on the ordered stream.
        || kind == vibe_land_shared::constants::PKT_MATCH_STATS
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
    if kind == vibe_land_shared::constants::PKT_AUDIO_CONTACTS
        || (is_snapshot_packet_kind(kind) && strict_snapshot_datagrams) {
        return OutboundDelivery::StrictDrop;
    }
    if wants_unreliable_delivery(kind) {
        return OutboundDelivery::ReliableFallback;
    }
    OutboundDelivery::Reliable
}

fn try_queue_packet(
    tx: &outbound::Sender,
    packet: Vec<u8>,
    telemetry: &MatchIoTelemetry,
) -> bool {
    let kind = packet.first().copied().unwrap_or_default();
    let is_snapshot = is_snapshot_packet_kind(kind);
    match tx.enqueue(packet, wants_unreliable_delivery(kind)) {
        outbound::Enqueue::Queued => true,
        outbound::Enqueue::DatagramDropped => {
            telemetry.observe_outbound_drop(is_snapshot);
            false
        }
        outbound::Enqueue::ReliableOverflow => {
            telemetry.observe_outbound_drop(is_snapshot);
            warn!(packet_kind = kind, "reliable outbound queue exhausted; closing client connection");
            false
        }
        outbound::Enqueue::Closed => false,
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
    use vibe_land_shared::seq::seq_is_newer;
    use wtransport::error::SendDatagramError;

    mod websocket_gate {
        use super::super::{
            game_websocket_route, websocket_game_transport_enabled, SessionConfig,
            WEBSOCKET_GAME_TRANSPORT_DISABLED,
        };
        use axum::{body::Body, http::Request, http::StatusCode, routing::get, Router};
        use tower::ServiceExt;

        #[test]
        fn disabled_unless_exactly_one() {
            assert!(!websocket_game_transport_enabled(None));
            for value in ["", "0", "true", "yes", "on", "TRUE", " 1", "1 "] {
                assert!(
                    !websocket_game_transport_enabled(Some(value)),
                    "{value:?} must not enable WebSocket"
                );
            }
            assert!(websocket_game_transport_enabled(Some("1")));
        }

        fn router(enabled: bool) -> Router {
            Router::new()
                .route("/ws/stats", get(|| async { "stats" }))
                .route(
                    "/ws/:match_id",
                    game_websocket_route(enabled, get(|| async { "game socket" })),
                )
        }

        fn upgrade_request(path: &str) -> Request<Body> {
            Request::builder()
                .uri(path)
                .header("connection", "upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .unwrap()
        }

        async fn call(router: Router, request: Request<Body>) -> (StatusCode, String) {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap();
            (status, String::from_utf8(bytes.to_vec()).unwrap())
        }

        #[tokio::test]
        async fn game_route_refuses_when_disabled() {
            let (status, body) = call(
                router(false),
                upgrade_request("/ws/default?identity=p&token=t"),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert_eq!(body, WEBSOCKET_GAME_TRANSPORT_DISABLED);
            assert!(body.contains("VIBE_ENABLE_WEBSOCKET=1"));

            // Every method, not just the upgrade GET.
            let post = Request::builder()
                .method("POST")
                .uri("/ws/city-default")
                .body(Body::empty())
                .unwrap();
            assert_eq!(call(router(false), post).await.0, StatusCode::FORBIDDEN);
        }

        #[tokio::test]
        async fn game_route_serves_the_handler_when_enabled() {
            let (status, body) = call(router(true), upgrade_request("/ws/default")).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, "game socket");
        }

        #[tokio::test]
        async fn stats_stream_is_not_the_game_route() {
            // `/ws/stats` is the dashboard feed and stays up either way.
            for enabled in [false, true] {
                let (status, body) = call(router(enabled), upgrade_request("/ws/stats")).await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(body, "stats");
            }
        }

        #[test]
        fn session_config_advertises_webtransport_only() {
            let config = SessionConfig {
                match_id: "default".to_string(),
                url: "https://localhost:4002/game".to_string(),
                server_certificate_hash_hex: "00".to_string(),
                sim_hz: 60,
                snapshot_hz: 60,
                interpolation_delay_ms: 100,
                protocol_version: 3,
                physics_backend: 1,
                client_movement_mode: 0,
                city_world: false,
                city_manifest_hash: None,
                city_wire_version: 2,
            };
            let json = serde_json::to_value(&config).unwrap();
            let object = json.as_object().unwrap();
            for (key, value) in object {
                let key = key.to_ascii_lowercase();
                assert!(
                    !key.contains("ws") && !key.contains("websocket"),
                    "session config must not advertise a WebSocket field: {key}"
                );
                if let Some(text) = value.as_str() {
                    assert!(
                        !text.starts_with("ws:") && !text.starts_with("wss:") && !text.contains("/ws/"),
                        "session config must not carry a WebSocket URL: {key}={text}"
                    );
                }
            }
            assert!(object["url"].as_str().unwrap().starts_with("https://"));
        }
    }

    fn runtime() -> PlayerRuntime {
        let (tx, _rx) = super::outbound::channel(PLAYER_OUTBOUND_QUEUE_CAPACITY);
        PlayerRuntime {
            identity: "test-player".to_string(),
            transport: super::ClientTransport::WebSocket,
            tx,
            link: None,
            city_rate: super::link_rate::RateController::new(super::link_rate::RateConfig::PRODUCTION),
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
            next_allowed_camera_drop_ms: 0,
            melee_flag_clear_tick: 0,
            spawn_protection_ends_at_tick: 0,
            respawn_at_ms: None,
            snapshot_interest: Default::default(),
            visible_batteries: HashSet::new(),
            battery_full_resync_pending: true,
            energy_gate: crate::energy_stream::EnergySendGate::default(),
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
    fn a_60hz_tick_earns_exactly_one_frame() {
        let dt = 1.0 / 60.0;
        let (frames, credit) = super::spend_input_credit(0.0, Some(dt), dt);
        assert_eq!(frames, 1);
        assert!(credit.abs() < 1e-4, "no credit should accumulate at 60 Hz: {credit}");
    }

    #[test]
    fn slow_ticks_consume_the_input_they_were_produced_at() {
        // The live failure: a 69 ms tick earns 4.13 frames. Rounding applied 4
        // and dropped 0.13 every tick, which is what grew pending_inputs to
        // 89. Over many ticks the credit version must apply the full 4.13
        // frames per tick on average, or the backlog returns.
        let dt = 1.0 / 60.0;
        let elapsed = 0.069_f32;
        let mut credit = 0.0;
        let mut applied = 0usize;
        let ticks = 600;
        for _ in 0..ticks {
            let (frames, next) = super::spend_input_credit(credit, Some(elapsed), dt);
            applied += frames;
            credit = next;
        }
        let produced = (ticks as f32 * elapsed / dt).round() as usize;
        let shortfall = produced.saturating_sub(applied);
        assert!(
            shortfall <= 1,
            "applied {applied} of {produced} frames produced; shortfall {shortfall}"
        );
    }

    #[test]
    fn a_long_stall_cannot_bank_unbounded_movement() {
        let dt = 1.0 / 60.0;
        // Two seconds of stall = 120 frames' worth of real time.
        let (frames, credit) = super::spend_input_credit(0.0, Some(2.0), dt);
        assert_eq!(frames, super::MAX_INPUT_FRAMES_PER_TICK);
        assert!(credit < 1.0, "credit must not carry a stall forward: {credit}");
    }

    #[test]
    fn the_first_tick_takes_a_single_frame() {
        let (frames, credit) = super::spend_input_credit(0.0, None, 1.0 / 60.0);
        assert_eq!(frames, 1);
        assert_eq!(credit, 0.0);
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

    #[tokio::test]
    async fn try_queue_packet_drops_snapshot_when_queue_is_full() {
        let telemetry = MatchIoTelemetry::default();
        let (tx, mut rx) = super::outbound::channel(1);

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
        assert_eq!(rx.recv().await.map(|p| p.bytes), Some(vec![PKT_PING, 1, 2, 3, 4]));
    }

    #[tokio::test]
    async fn outbound_reliable_state_survives_datagram_pressure_and_fails_explicitly() {
        let telemetry = MatchIoTelemetry::default();
        let (tx, mut rx) = super::outbound::channel(1);
        assert!(try_queue_packet(&tx, vec![PKT_SNAPSHOT, 0], &telemetry));
        assert!(!try_queue_packet(&tx, vec![PKT_SNAPSHOT, 1], &telemetry));
        assert!(try_queue_packet(&tx, vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 2], &telemetry));
        assert!(!try_queue_packet(&tx, vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 3], &telemetry));
        super::outbound::failed(&mut rx.failed).await;
        assert_eq!(telemetry.dropped_outbound_packets.load(std::sync::atomic::Ordering::Relaxed), 2);
        assert_eq!(telemetry.dropped_outbound_snapshots.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(!try_queue_packet(&tx, vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 4], &telemetry));
    }

    /// Match stats used to be a ~15 kB reliable packet; on a connection whose
    /// ordered stream is backed up behind topology that was both a delay for
    /// the topology behind it and a step towards a fatal reliable overflow.
    /// Now they take the datagram lane and cannot touch either.
    #[tokio::test]
    async fn match_stats_stay_off_the_ordered_stream_while_topology_is_queued() {
        let telemetry = MatchIoTelemetry::default();
        let (tx, mut rx) = super::outbound::channel(1);
        let topology = vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 1];
        assert!(try_queue_packet(&tx, topology.clone(), &telemetry));
        // The reliable queue is now full; a reliable stats packet would fail
        // the connection.
        let stats = super::match_stats_frame::encode(7, &serde_json::json!({ "player_count": 2 }));
        assert!(try_queue_packet(&tx, stats.clone(), &telemetry));
        assert!(!*rx.failed.borrow());
        assert_eq!(telemetry.dropped_outbound_packets.load(std::sync::atomic::Ordering::Relaxed), 0);
        drop(tx);
        let mut got = Vec::new();
        while let Some(p) = rx.recv().await {
            got.push(p.bytes);
        }
        got.sort();
        let mut want = vec![topology, stats];
        want.sort();
        assert_eq!(got, want);
    }

    /// Even when the peer refuses datagrams and the frame falls back to the
    /// reliable stream, it is written after the topology already queued.
    #[tokio::test]
    async fn a_match_stats_fallback_is_written_behind_queued_topology() {
        use tokio::io::AsyncReadExt;
        let telemetry = MatchIoTelemetry::default();
        let (tx, rx) = super::outbound::channel(8);
        let topo_a = vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 1];
        let topo_b = vec![vibe_land_shared::constants::PKT_CITY_TOPOLOGY, 2];
        let stats = super::match_stats_frame::encode(7, &serde_json::json!({ "player_count": 2 }));
        assert!(try_queue_packet(&tx, stats.clone(), &telemetry));
        assert!(try_queue_packet(&tx, topo_a.clone(), &telemetry));
        assert!(try_queue_packet(&tx, topo_b.clone(), &telemetry));
        drop(tx);
        let (mut writer, mut reader) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move {
            super::outbound::write_webtransport(
                &mut writer,
                rx,
                |_| super::outbound::DatagramResult::Fallback,
                |_| {},
                |_| panic!("fallback dropped"),
            )
            .await
        });
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap().unwrap();
        let mut frames = Vec::new();
        let mut o = 0;
        while o < bytes.len() {
            let len = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize;
            frames.push(bytes[o + 4..o + 4 + len].to_vec());
            o += 4 + len;
        }
        assert_eq!(frames, vec![topo_a, topo_b, stats]);
    }

    #[test]
    fn snapshot_packet_helper_recognizes_v1_and_v2() {
        assert!(is_snapshot_packet_kind(PKT_SNAPSHOT));
        assert!(is_snapshot_packet_kind(PKT_SNAPSHOT_V2));
        assert!(!is_snapshot_packet_kind(PKT_PING));
    }

    #[test]
    fn audio_contacts_never_block_the_reliable_state_stream() {
        let kind = vibe_land_shared::constants::PKT_AUDIO_CONTACTS;
        assert!(super::wants_unreliable_delivery(kind));
        assert_eq!(classify_outbound_delivery(kind, false, false), OutboundDelivery::StrictDrop);
        assert_eq!(classify_outbound_delivery(kind, true, true), OutboundDelivery::Datagram);
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

/// The production signal path on the real transport, without privileges: a
/// WebTransport session through a userspace relay that paces the
/// server-to-client direction (a token-bucket bottleneck with a 200 ms drop-
/// tail queue, like netem's `rate`), the server configured as in production
/// (`wt_transport_config`, BBR), and the city stream's worst case offered:
/// the full ceiling every send, plus snapshot-sized traffic at 60 Hz.
#[cfg(test)]
mod quic_rate_tests {
    use super::link_rate::{LinkProbe, RateConfig, RateController, SendPlan};
    use super::{wt_transport_config, QuicLinkProbe};
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tokio::net::UdpSocket;

    #[derive(Debug)]
    struct PacedRun {
        /// (seconds since start when sent, one-way ms) per received datagram.
        latency_ms: Vec<(f64, f64)>,
        /// Seconds since start of every datagram sent.
        sent_at: Vec<f64>,
        sent: usize,
        limited_sends: u64,
        capacity_kbit_s: f64,
        peak_buffered: u64,
    }

    fn pct(values: &[f64], q: f64) -> f64 {
        let mut v = values.to_vec();
        v.sort_by(f64::total_cmp);
        v.get(((v.len().saturating_sub(1)) as f64 * q).round() as usize).copied().unwrap_or(f64::NAN)
    }

    async fn paced_session(adapt: bool, rate_mbit: f64, one_way_ms: u64, seconds: f64) -> PacedRun {
        use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig, VarInt};
        let identity = Identity::self_signed(["localhost", "127.0.0.1"]).unwrap();
        let hash = identity.certificate_chain().as_slice()[0].hash();
        let mut config = ServerConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_identity(identity)
            .build();
        config.quic_config_mut().transport_config(Arc::new(wt_transport_config()));
        let server = Endpoint::server(config).unwrap();
        let server_addr = server.local_addr().unwrap();

        // The relay: client <-> front | back <-> server.
        let front = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let back = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let relay_addr = front.local_addr().unwrap();
        let client_addr: Arc<Mutex<Option<SocketAddr>>> = Arc::new(Mutex::new(None));
        let (up_front, up_back, up_client) = (front.clone(), back.clone(), client_addr.clone());
        let up = tokio::spawn(async move {
            let mut buf = vec![0u8; 65_536];
            while let Ok((n, from)) = up_front.recv_from(&mut buf).await {
                *up_client.lock().unwrap() = Some(from);
                let _ = up_back.send_to(&buf[..n], server_addr).await;
            }
        });
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(Instant, Vec<u8>)>();
        let down_back = back.clone();
        let down_in = tokio::spawn(async move {
            let bytes_per_s = rate_mbit * 1e6 / 8.0;
            let mut free_at = Instant::now();
            let mut buf = vec![0u8; 65_536];
            while let Ok((n, _)) = down_back.recv_from(&mut buf).await {
                let now = Instant::now();
                let start = free_at.max(now);
                if start - now > Duration::from_millis(200) {
                    continue; // the bottleneck queue is full: drop-tail
                }
                free_at = start + Duration::from_secs_f64((n + 28) as f64 / bytes_per_s);
                let _ = tx.send((free_at + Duration::from_millis(one_way_ms), buf[..n].to_vec()));
            }
        });
        let (down_front, down_client) = (front.clone(), client_addr.clone());
        let down_out = tokio::spawn(async move {
            while let Some((due, bytes)) = rx.recv().await {
                tokio::time::sleep_until(due.into()).await;
                let to = *down_client.lock().unwrap();
                if let Some(to) = to {
                    let _ = down_front.send_to(&bytes, to).await;
                }
            }
        });

        let client = Endpoint::client(
            ClientConfig::builder()
                .with_bind_default()
                .with_server_certificate_hashes([hash])
                .build(),
        )
        .unwrap();
        let url = format!("https://{relay_addr}/rate-test");
        let (server_conn, client_conn) = tokio::join!(
            async { server.accept().await.await.unwrap().accept().await.unwrap() },
            async { client.connect(url).await.unwrap() },
        );
        let epoch = Instant::now();
        // The client: one-way latency of every datagram (same clock).
        let receiver = tokio::spawn(async move {
            let mut latency = Vec::new();
            while let Ok(datagram) = client_conn.receive_datagram().await {
                let payload = datagram.payload();
                let sent_ns = u64::from_le_bytes(payload[..8].try_into().unwrap());
                let now_ns = epoch.elapsed().as_nanos() as u64;
                latency.push((sent_ns as f64 / 1e9, now_ns.saturating_sub(sent_ns) as f64 / 1e6));
            }
            latency
        });

        let submitted = Arc::new(AtomicU64::new(0));
        let probe = QuicLinkProbe {
            connection: server_conn.clone(),
            submitted: submitted.clone(),
            reliable_submitted: Arc::new(AtomicU64::new(0)),
            epoch,
        };
        let mut controller = RateController::new(RateConfig { enabled: adapt, ..RateConfig::PRODUCTION });
        let max = server_conn.max_datagram_size().unwrap_or(1100).min(1100);
        let sent_at = std::cell::RefCell::new(Vec::new());
        let send = |bytes: usize| {
            let mut left = bytes;
            let mut sent = 0;
            while left > 0 {
                let size = left.min(max).max(16);
                let mut payload = vec![0u8; size];
                payload[..8].copy_from_slice(&(epoch.elapsed().as_nanos() as u64).to_le_bytes());
                if server_conn.send_datagram(payload).is_ok() {
                    sent += 1;
                    sent_at.borrow_mut().push(epoch.elapsed().as_secs_f64());
                }
                submitted.fetch_add(size as u64, Ordering::Relaxed);
                left = left.saturating_sub(size);
            }
            sent
        };
        let mut ticker = tokio::time::interval(Duration::from_micros(16_667));
        let mut sent = 0;
        let mut peak_buffered = 0;
        let mut tick = 0u64;
        while epoch.elapsed().as_secs_f64() < seconds {
            ticker.tick().await;
            tick += 1;
            // Snapshot-sized traffic every tick (~45 kbit/s).
            sent += send(94);
            if tick % 2 == 0 {
                let sample = probe.sample().unwrap();
                if std::env::var("RATE_DEBUG").is_ok() && tick % 60 == 0 {
                    let stats = server_conn.quic_connection().stats();
                    eprintln!(
                        "t {:.1}s adapt {adapt} cwnd {} rtt {:?} sent {} lost {} wire {} buffered {} state {:?} cap {:.0}",
                        epoch.elapsed().as_secs_f64(), stats.path.cwnd, stats.path.rtt, stats.path.sent_packets,
                        stats.path.lost_packets, stats.udp_tx.bytes, sample.datagram_buffered_bytes,
                        controller.state(), controller.capacity_bytes_per_s() * 8.0 / 1000.0
                    );
                }
                peak_buffered = peak_buffered.max(sample.datagram_buffered_bytes);
                let plan = controller.plan(sample, 1.0 / 30.0, 10_400);
                let bytes = match plan {
                    SendPlan::Full => 10_400,
                    SendPlan::Limited { allowance_bytes, .. } => allowance_bytes.min(10_400),
                    SendPlan::Skip => 0,
                };
                sent += send(bytes);
                controller.sent(bytes, plan);
            }
        }
        // Let what is in flight land, then close.
        tokio::time::sleep(Duration::from_millis(300)).await;
        server_conn.close(VarInt::from_u32(0), b"done");
        let latency = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .expect("client finished")
            .unwrap();
        for task in [up, down_in, down_out] {
            task.abort();
        }
        PacedRun {
            latency_ms: latency,
            sent_at: sent_at.into_inner(),
            sent,
            limited_sends: controller.totals().sends_limited,
            capacity_kbit_s: controller.capacity_bytes_per_s() * 8.0 / 1000.0,
            peak_buffered,
        }
    }

    /// Latency percentiles and delivered share of datagrams sent after `from_s`.
    fn after(run: &PacedRun, from_s: f64) -> (f64, f64, f64) {
        let latency: Vec<f64> =
            run.latency_ms.iter().filter(|(t, _)| *t >= from_s).map(|(_, ms)| *ms).collect();
        let sent = run.sent_at.iter().filter(|t| **t >= from_s).count().max(1);
        (pct(&latency, 0.5), pct(&latency, 0.99), latency.len() as f64 / sent as f64)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "real time, ~20 s: cargo test --bin web-fps-server -- --ignored rate_adaptation_on_real_quic"]
    async fn rate_adaptation_on_real_quic_through_a_paced_relay() {
        let (rate_mbit, one_way_ms, seconds) = (1.0, 15, 8.0);
        let off = paced_session(false, rate_mbit, one_way_ms, seconds).await;
        let on = paced_session(true, rate_mbit, one_way_ms, seconds).await;
        for (name, run) in [("off", &off), ("on", &on)] {
            let (p50, p99, delivered) = after(run, 0.0);
            let (s50, s99, settled) = after(run, 3.0);
            eprintln!(
                "adaptation {name}: sent {} datagrams; all: one-way p50 {p50:.1} p99 {p99:.1} ms, \
                 delivered {:.1}%; from 3 s: p50 {s50:.1} p99 {s99:.1} ms, delivered {:.1}%; \
                 peak quinn datagram buffer {} B; limited sends {}; capacity estimate {:.0} kbit/s",
                run.sent,
                100.0 * delivered,
                100.0 * settled,
                run.peak_buffered,
                run.limited_sends,
                run.capacity_kbit_s,
            );
        }
        // Measured, quinn 0.11 + BBR: the sender does not hold datagrams
        // back (its buffer stays empty); the bottleneck queue fills and the
        // path drops what it cannot carry.
        let (off50, _, off_delivered) = after(&off, 3.0);
        assert!(off.peak_buffered < 10_000, "off: buffer {}", off.peak_buffered);
        assert!(off50 > 150.0, "off: p50 {off50:.0} ms: the relay queue is full");
        assert!(off_delivered < 0.6, "off: {:.0}% delivered", 100.0 * off_delivered);
        // With adaptation: found from RTT and loss, the queue drains and
        // nothing more is lost; the estimate lands on the relay's rate (QUIC
        // payload is ~95% of the IP rate).
        let (on50, on99, on_delivered) = after(&on, 3.0);
        assert!(on.limited_sends > 0);
        assert!(on50 < 60.0 && on99 < 200.0, "on: p50 {on50:.0} p99 {on99:.0} ms");
        assert!(on_delivered > 0.98, "on: {:.1}% delivered", 100.0 * on_delivered);
        assert!(
            (on.capacity_kbit_s / (rate_mbit * 1000.0) - 0.95).abs() < 0.25,
            "capacity {:.0} kbit/s",
            on.capacity_kbit_s
        );
    }
}
