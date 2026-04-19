// ── Button flags (client input) ──────────────────
pub const BTN_FORWARD: u16 = 1 << 0;
pub const BTN_BACK: u16 = 1 << 1;
pub const BTN_LEFT: u16 = 1 << 2;
pub const BTN_RIGHT: u16 = 1 << 3;
pub const BTN_JUMP: u16 = 1 << 4;
pub const BTN_CROUCH: u16 = 1 << 5;
pub const BTN_SPRINT: u16 = 1 << 6;
pub const BTN_SECONDARY_FIRE: u16 = 1 << 7;
pub const BTN_RELOAD: u16 = 1 << 8;

// ── Player state flags ──────────────────────────
pub const FLAG_ON_GROUND: u16 = 1 << 0;
pub const FLAG_IN_VEHICLE: u16 = 1 << 1;
pub const FLAG_DEAD: u16 = 1 << 2;
pub const FLAG_MELEEING: u16 = 1 << 3;

// ── Packet type IDs ─────────────────────────────
pub const PKT_CLIENT_HELLO: u8 = 1;
pub const PKT_INPUT_BUNDLE: u8 = 2;
pub const PKT_FIRE: u8 = 3;
pub const PKT_BLOCK_EDIT: u8 = 4;
pub const PKT_VEHICLE_ENTER: u8 = 5;
pub const PKT_VEHICLE_EXIT: u8 = 6;
pub const PKT_DEBUG_STATS: u8 = 7;
pub const PKT_MELEE: u8 = 8;

pub const PKT_WELCOME: u8 = 101;
pub const PKT_SNAPSHOT: u8 = 102;
pub const PKT_SHOT_RESULT: u8 = 103;
pub const PKT_CHUNK_FULL: u8 = 104;
pub const PKT_CHUNK_DIFF: u8 = 105;
pub const PKT_PING: u8 = 110;
pub const PKT_PONG: u8 = 111;
pub const PKT_SNAPSHOT_V2: u8 = 112;
pub const PKT_PLAYER_ROSTER: u8 = 113;
pub const PKT_DYNAMIC_BODY_META: u8 = 114;
pub const PKT_LOCAL_PLAYER_ENERGY: u8 = 115;
pub const PKT_BATTERY_SYNC: u8 = 116;
pub const PKT_DAMAGE_EVENT: u8 = 117;

// ── Weapon types ────────────────────────────────
pub const WEAPON_HITSCAN: u8 = 1;
pub const WEAPON_ROCKET: u8 = 2;

// ── Hit zones ───────────────────────────────────
pub const HIT_ZONE_NONE: u8 = 0;
pub const HIT_ZONE_BODY: u8 = 1;
pub const HIT_ZONE_HEAD: u8 = 2;

// ── Block operations ────────────────────────────
pub const BLOCK_ADD: u8 = 1;
pub const BLOCK_REMOVE: u8 = 2;

// ── Shape types ─────────────────────────────────
pub const SHAPE_BOX: u8 = 0;
pub const SHAPE_SPHERE: u8 = 1;

// ── Area-of-interest (AOI) radii ────────────────
// The server uses these to decide which players, dynamic bodies, and vehicles
// get streamed to each recipient. Clients mirror the same value to size the
// visual fog so sight ends where replication ends (no pop-in at the
// streaming boundary). Keep all four in lockstep unless there's a specific
// reason to differ.
pub const PLAYER_AOI_RADIUS_M: f32 = 80.0;
pub const DYNAMIC_BODY_AOI_RADIUS_M: f32 = 80.0;
pub const DYNAMIC_BODY_AOI_EXIT_RADIUS_M: f32 = 80.0;
pub const VEHICLE_AOI_RADIUS_M: f32 = 80.0;

// ── Shared gameplay/runtime constants ───────────
pub const SIM_HZ: u16 = 60;
pub const SNAPSHOT_HZ_MULTIPLAYER: u16 = 30;
pub const SNAPSHOT_HZ_LOCAL: u16 = SIM_HZ;
pub const MAX_PENDING_INPUTS: usize = 120;
pub const VEHICLE_INPUT_CATCHUP_THRESHOLD: usize = 4;
pub const RIFLE_FIRE_INTERVAL_MS: u32 = 100;
pub const PLAYER_EYE_HEIGHT_M: f32 = 0.8;
// ── Melee combat ────────────────────────────────
pub const MELEE_DAMAGE: u8 = 35;
pub const MELEE_COOLDOWN_MS: u32 = 900;
pub const MELEE_RANGE_M: f32 = 1.0;
/// cos(60°) — any target within this dot-product of the aim direction is in the cone.
pub const MELEE_HALF_CONE_COS: f32 = 0.5;
pub const MELEE_ENERGY_COST: f32 = 2.0;
/// Sim ticks to hold FLAG_MELEEING in the snapshot after a successful swing.
pub const MELEE_FLAG_DURATION_TICKS: u32 = 12;
/// How long (ms) a player is blocked from swinging melee after taking damage.
pub const MELEE_HIT_RECOVERY_MS: u32 = 400;
pub const HITSCAN_MAX_DISTANCE_M: f32 = 1000.0;
pub const DYNAMIC_BODY_IMPULSE: f32 = 6.0;
pub const OUT_OF_BOUNDS_Y_M: f32 = -12.0;

// ── Energy / consumables ────────────────────────
/// Energy each player starts with and is restored to on respawn.
pub const STARTING_ENERGY: f32 = 1000.0;
/// Baseline energy drained per second while on foot and idle.
pub const ON_FOOT_IDLE_DRAIN_PER_SEC: f32 = 1.0;
/// Energy drained per second while moving on foot.
pub const ON_FOOT_WALK_DRAIN_PER_SEC: f32 = 2.0;
/// Energy drained per second while sprinting on foot.
pub const ON_FOOT_SPRINT_DRAIN_PER_SEC: f32 = 3.0;
/// Additional one-time energy cost applied when a grounded jump begins.
pub const JUMP_ENERGY_COST: f32 = 2.0;
/// Baseline energy drained per second while occupying a vehicle.
pub const VEHICLE_IDLE_DRAIN_PER_SEC: f32 = 1.0;
/// Additional vehicle drain scaled by current speed in metres per second.
pub const VEHICLE_SPEED_DRAIN_COEF: f32 = 0.57;
/// Energy consumed by a single rifle shot.
pub const RIFLE_SHOT_ENERGY_COST: f32 = 1.25;
/// Additional pickup slack so overlapping batteries feel generous.
pub const BATTERY_PICKUP_SLACK_M: f32 = 0.3;
/// Default runtime/authored battery dimensions in metres.
pub const DEFAULT_BATTERY_RADIUS_M: f32 = 0.4;
pub const DEFAULT_BATTERY_HEIGHT_M: f32 = 0.8;
/// Battery ids live in a separate range for easier debugging and to avoid
/// collisions with other runtime entity ids.
pub const BATTERY_ID_RANGE_START: u32 = 0x4000_0000;
