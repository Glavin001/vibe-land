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

// ── Energy / consumables ────────────────────────
/// Energy each player starts with (and is reset to on respawn).
export const STARTING_ENERGY = 1000.0;
/// Energy consumed per second while sitting in a vehicle, even when idle.
export const VEHICLE_IDLE_DRAIN_PER_SEC = 1.0;
/// Additional energy-per-second drain scaled by the vehicle's current speed
/// (metres per second). So `drain = IDLE + COEF * speed_mps`.
export const VEHICLE_SPEED_DRAIN_COEF = 0.3;
/// Extra slack (metres) added to battery pickup radius checks so pickups feel
/// generous rather than pixel-perfect.
export const BATTERY_PICKUP_SLACK_M = 0.3;
/// Default cylinder radius and height used for batteries dropped at runtime
/// (e.g. from a killed player).
export const DEFAULT_BATTERY_RADIUS_M = 0.4;
export const DEFAULT_BATTERY_HEIGHT_M = 0.8;
/// Battery IDs start at this offset so they can't collide with dynamic-body /
/// vehicle IDs in logs or debug overlays.
export const BATTERY_ID_RANGE_START = 0x40000000;
