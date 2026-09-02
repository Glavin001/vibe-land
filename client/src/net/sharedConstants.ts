// AUTO-GENERATED from shared/src/constants.rs — do not edit manually.
// Regenerate with: node scripts/gen-constants.mjs

// ── Button flags (client input) ──────────────────
export const BTN_FORWARD = 1 << 0;
export const BTN_BACK = 1 << 1;
export const BTN_LEFT = 1 << 2;
export const BTN_RIGHT = 1 << 3;
export const BTN_JUMP = 1 << 4;
export const BTN_CROUCH = 1 << 5;
export const BTN_SPRINT = 1 << 6;
export const BTN_SECONDARY_FIRE = 1 << 7;
export const BTN_RELOAD = 1 << 8;

// ── Player state flags ──────────────────────────
export const FLAG_ON_GROUND = 1 << 0;
export const FLAG_IN_VEHICLE = 1 << 1;
export const FLAG_DEAD = 1 << 2;
export const FLAG_MELEEING = 1 << 3;
export const FLAG_SPAWN_PROTECTED = 1 << 4;

// ── Packet type IDs ─────────────────────────────
export const PKT_CLIENT_HELLO = 1;
export const PKT_INPUT_BUNDLE = 2;
export const PKT_FIRE = 3;
export const PKT_BLOCK_EDIT = 4;
export const PKT_VEHICLE_ENTER = 5;
export const PKT_VEHICLE_EXIT = 6;
export const PKT_DEBUG_STATS = 7;
export const PKT_MELEE = 8;

export const PKT_WELCOME = 101;
export const PKT_SNAPSHOT = 102;
export const PKT_SHOT_RESULT = 103;
export const PKT_CHUNK_FULL = 104;
export const PKT_CHUNK_DIFF = 105;
export const PKT_PING = 110;
export const PKT_PONG = 111;
export const PKT_SNAPSHOT_V2 = 112;
export const PKT_PLAYER_ROSTER = 113;
export const PKT_DYNAMIC_BODY_META = 114;
export const PKT_LOCAL_PLAYER_ENERGY = 115;
export const PKT_BATTERY_SYNC = 116;
export const PKT_SHOT_FIRED = 117;
export const PKT_DAMAGE_EVENT = 118;

// ── Destructible city streams (destruction/src/wire.rs defines the layouts) ──
export const PKT_CITY_RESYNC_REQUEST = 9;
export const PKT_CITY_CHUNKS = 119;
export const PKT_CITY_TOPOLOGY = 120;
export const PKT_CITY_BASELINE = 121;
export const PKT_CITY_BOOTSTRAP = 122;
/// The city manifest itself, gzipped, pushed on join.
///
/// Clients used to fetch this over HTTP from the game server. That works only
/// when the page and the server share an origin: a rented GPU box serves plain
/// HTTP on a random port, which an HTTPS page may not fetch, and its
/// WebTransport certificate is self-signed so an HTTPS fetch is refused too.
/// Sending it down the session that is already open sidesteps all of it.
export const PKT_CITY_MANIFEST = 123;
/// Per-match server telemetry as JSON, pushed roughly once a second.
///
/// The overlay used to poll `/match-stats` over HTTP, which a browser cannot
/// reach on a rented box for the same reason it cannot fetch the manifest.
/// Sent on the session so the numbers describe the server actually being
/// played on, rather than whichever one the page happens to share an origin
/// with.
export const PKT_MATCH_STATS = 124;

/// Wire-v3 debris pose packet: self-healing datagram stream from the live
/// debris codec. Broadcast, loss-tolerant, dictionary-compressed.
export const PKT_CITY_DEBRIS = 125;
/// Client -> server: bodies whose chains a lost packet poisoned; the server
/// restates exactly these. The loss-heal cost scales with actual loss.
export const PKT_CITY_NACK = 126;
// Chunk kinematic stream rate (sim ticks between sends: SIM_HZ / this).
export const CITY_CHUNK_STREAM_HZ = 30;
export const CITY_BASELINE_INTERVAL_MS = 1000;
// Per-client byte ceiling per 30 Hz send (~2.5 Mbps); a cap, never a fill target.
export const CITY_CLIENT_CEILING_BYTES_PER_SEND = 10400;

// ── Protocol/runtime capabilities ───────────────
export const PROTOCOL_VERSION = 3;
export const PHYSICS_BACKEND_RAPIER = 0;
export const PHYSICS_BACKEND_PHYSX_GPU = 1;
export const CLIENT_MOVEMENT_FULL_PREDICTION = 0;
export const CLIENT_MOVEMENT_THIN_AUTHORITATIVE = 1;
export const CLIENT_MOVEMENT_CAP_FULL_PREDICTION = 1 << 0;
export const CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE = 1 << 1;

// ── Weapon types ────────────────────────────────
export const WEAPON_HITSCAN = 1;
export const WEAPON_ROCKET = 2;

// ── Hit zones ───────────────────────────────────
export const HIT_ZONE_NONE = 0;
export const HIT_ZONE_BODY = 1;
export const HIT_ZONE_HEAD = 2;

// ── Block operations ────────────────────────────
export const BLOCK_ADD = 1;
export const BLOCK_REMOVE = 2;

// ── Shape types ─────────────────────────────────
export const SHAPE_BOX = 0;
export const SHAPE_SPHERE = 1;

// ── Vehicle interaction ─────────────────────────
export const VEHICLE_INTERACT_RADIUS_M = 4.0;

// ── Area-of-interest (AOI) radii ────────────────
// The server uses these to decide which players, dynamic bodies, and vehicles
// get streamed to each recipient. Clients mirror the same value to size the
// visual fog so sight ends where replication ends (no pop-in at the
// streaming boundary). Keep all four in lockstep unless there's a specific
// reason to differ.
export const PLAYER_AOI_RADIUS_M = 80.0;
export const DYNAMIC_BODY_AOI_RADIUS_M = 80.0;
export const DYNAMIC_BODY_AOI_EXIT_RADIUS_M = 80.0;
export const VEHICLE_AOI_RADIUS_M = 80.0;

// ── Shared gameplay/runtime constants ───────────
export const SIM_HZ = 60;
export const SNAPSHOT_HZ_MULTIPLAYER = 30;
export const SNAPSHOT_HZ_LOCAL = SIM_HZ;
export const MAX_PENDING_INPUTS = 120;
export const VEHICLE_INPUT_CATCHUP_THRESHOLD = 4;
/// On-foot backlog depth that triggers a jump to the newest input. Small on
/// purpose: the point is to track the player's current intent, not to replay
/// a queue. MAX_PENDING_INPUTS remains the hard cap for pathological cases.
///
/// UNUSED since the rubber-band fix: on foot the server now DRAINS the
/// backlog (simulating each frame) instead of skipping to the newest, so
/// there is no depth at which frames get discarded. Kept only so the vehicle
/// path's threshold has an obvious sibling; see MAX_INPUT_FRAMES_PER_TICK.
export const PLAYER_INPUT_CATCHUP_THRESHOLD = 3;
/// Most 60 Hz input frames one tick may simulate for a player.
///
/// The tick's real budget is wall-clock elapsed / dt, so a client cannot buy
/// speed by sending faster; this only bounds the worst case.
///
/// 8 frames = 133 ms of movement, ~0.24 ms of KCC work at the measured 0.03
/// ms per frame. Was 4, which live reports showed was under the requirement:
/// a heavy collapse produced 69 ms ticks (4.13 frames) with a p95 of 87 ms
/// (5.2), so the cap itself became the thing holding the backlog open.
export const MAX_INPUT_FRAMES_PER_TICK = 8;
export const RIFLE_FIRE_INTERVAL_MS = 100;
export const RIFLE_BODY_DAMAGE = 14;
export const RIFLE_HEAD_DAMAGE = 16;
export const PLAYER_EYE_HEIGHT_M = 0.8;
export const SPAWN_PROTECTION_MS = 3000;
// ── Melee combat ────────────────────────────────
export const MELEE_DAMAGE = 35;
export const MELEE_COOLDOWN_MS = 900;
export const MELEE_RANGE_M = 1.0;
/// cos(60°) — any target within this dot-product of the aim direction is in the cone.
export const MELEE_HALF_CONE_COS = 0.5;
export const MELEE_ENERGY_COST = 2.0;
/// Sim ticks to hold FLAG_MELEEING in the snapshot after a successful swing.
export const MELEE_FLAG_DURATION_TICKS = 12;
/// How long (ms) a player is blocked from swinging melee after taking damage.
export const MELEE_HIT_RECOVERY_MS = 400;
export const HITSCAN_MAX_DISTANCE_M = 1000.0;
export const DYNAMIC_BODY_IMPULSE = 6.0;
export const OUT_OF_BOUNDS_Y_M = -12.0;

// ── Energy / consumables ────────────────────────
/// Energy each player starts with and is restored to on respawn.
export const STARTING_ENERGY = 1000.0;
/// Baseline energy drained per second while on foot and idle.
export const ON_FOOT_IDLE_DRAIN_PER_SEC = 1.0;
/// Energy drained per second while moving on foot.
export const ON_FOOT_WALK_DRAIN_PER_SEC = 2.0;
/// Energy drained per second while sprinting on foot.
export const ON_FOOT_SPRINT_DRAIN_PER_SEC = 3.0;
/// Additional one-time energy cost applied when a grounded jump begins.
export const JUMP_ENERGY_COST = 2.0;
/// Baseline energy drained per second while occupying a vehicle.
export const VEHICLE_IDLE_DRAIN_PER_SEC = 1.0;
/// Additional vehicle drain scaled by current speed in metres per second.
export const VEHICLE_SPEED_DRAIN_COEF = 0.57;
/// Energy consumed by a single rifle shot.
export const RIFLE_SHOT_ENERGY_COST = 1.25;
/// Additional pickup slack so overlapping batteries feel generous.
export const BATTERY_PICKUP_SLACK_M = 0.3;
/// Default runtime/authored battery dimensions in metres.
export const DEFAULT_BATTERY_RADIUS_M = 0.4;
export const DEFAULT_BATTERY_HEIGHT_M = 0.8;
/// Battery ids live in a separate range for easier debugging and to avoid
/// collisions with other runtime entity ids.
export const BATTERY_ID_RANGE_START = 0x40000000;
