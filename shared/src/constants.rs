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

// ── Packet type IDs ─────────────────────────────
pub const PKT_CLIENT_HELLO: u8 = 1;
pub const PKT_INPUT_BUNDLE: u8 = 2;
pub const PKT_FIRE: u8 = 3;
pub const PKT_BLOCK_EDIT: u8 = 4;
pub const PKT_VEHICLE_ENTER: u8 = 5;
pub const PKT_VEHICLE_EXIT: u8 = 6;
pub const PKT_DEBUG_STATS: u8 = 7;

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

// ── Shared gameplay/runtime constants ───────────
pub const SIM_HZ: u16 = 60;
pub const SNAPSHOT_HZ_MULTIPLAYER: u16 = 30;
pub const SNAPSHOT_HZ_LOCAL: u16 = SIM_HZ;
pub const MAX_PENDING_INPUTS: usize = 120;
pub const VEHICLE_INPUT_CATCHUP_THRESHOLD: usize = 4;
pub const RIFLE_FIRE_INTERVAL_MS: u32 = 100;
pub const PLAYER_EYE_HEIGHT_M: f32 = 0.8;
pub const HITSCAN_MAX_DISTANCE_M: f32 = 1000.0;
pub const DYNAMIC_BODY_IMPULSE: f32 = 6.0;
pub const OUT_OF_BOUNDS_Y_M: f32 = -12.0;

// ── Energy / consumables ────────────────────────
/// Energy each player starts with (and is reset to on respawn).
pub const STARTING_ENERGY: f32 = 1000.0;
/// Energy consumed per second while sitting in a vehicle, even when idle.
pub const VEHICLE_IDLE_DRAIN_PER_SEC: f32 = 1.0;
/// Additional energy-per-second drain scaled by the vehicle's current speed
/// (metres per second). So `drain = IDLE + COEF * speed_mps`.
pub const VEHICLE_SPEED_DRAIN_COEF: f32 = 0.3;
/// Energy consumed by a single rifle shot. Firing is expensive to keep
/// ammo-as-fuel meaningful: at the default starting energy of 1000, a
/// player gets ~100 shots before needing to refill.
pub const RIFLE_SHOT_ENERGY_COST: f32 = 10.0;
/// Extra slack (metres) added to battery pickup radius checks so pickups feel
/// generous rather than pixel-perfect.
pub const BATTERY_PICKUP_SLACK_M: f32 = 0.3;
/// Default cylinder radius and height used for batteries dropped at runtime
/// (e.g. from a killed player).
pub const DEFAULT_BATTERY_RADIUS_M: f32 = 0.4;
pub const DEFAULT_BATTERY_HEIGHT_M: f32 = 0.8;
/// Battery IDs start at this offset so they can't collide with dynamic-body /
/// vehicle IDs in logs or debug overlays.
pub const BATTERY_ID_RANGE_START: u32 = 0x4000_0000;
