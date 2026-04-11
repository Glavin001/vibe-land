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

// ── Weapon types ────────────────────────────────
pub const WEAPON_HITSCAN: u8 = 1;
pub const WEAPON_ROCKET: u8 = 2;

// ── Block operations ────────────────────────────
pub const BLOCK_ADD: u8 = 1;
pub const BLOCK_REMOVE: u8 = 2;

// ── Shape types ─────────────────────────────────
pub const SHAPE_BOX: u8 = 0;
pub const SHAPE_SPHERE: u8 = 1;
