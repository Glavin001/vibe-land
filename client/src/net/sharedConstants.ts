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

// ── Packet type IDs ─────────────────────────────
export const PKT_CLIENT_HELLO = 1;
export const PKT_INPUT_BUNDLE = 2;
export const PKT_FIRE = 3;
export const PKT_BLOCK_EDIT = 4;
export const PKT_VEHICLE_ENTER = 5;
export const PKT_VEHICLE_EXIT = 6;
export const PKT_DEBUG_STATS = 7;

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

// ── Shared gameplay/runtime constants ───────────
export const SIM_HZ = 60;
export const SNAPSHOT_HZ_MULTIPLAYER = 30;
export const SNAPSHOT_HZ_LOCAL = SIM_HZ;
export const MAX_PENDING_INPUTS = 120;
export const VEHICLE_INPUT_CATCHUP_THRESHOLD = 4;
export const RIFLE_FIRE_INTERVAL_MS = 100;
export const PLAYER_EYE_HEIGHT_M = 0.8;
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
