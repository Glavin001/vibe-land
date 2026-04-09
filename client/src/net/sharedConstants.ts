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

// ── Packet type IDs ─────────────────────────────
export const PKT_CLIENT_HELLO = 1;
export const PKT_INPUT_BUNDLE = 2;
export const PKT_FIRE = 3;
export const PKT_BLOCK_EDIT = 4;

export const PKT_WELCOME = 101;
export const PKT_SNAPSHOT = 102;
export const PKT_SHOT_RESULT = 103;
export const PKT_CHUNK_FULL = 104;
export const PKT_CHUNK_DIFF = 105;
export const PKT_PING = 110;
export const PKT_PONG = 111;

// ── Weapon types ────────────────────────────────
export const WEAPON_HITSCAN = 1;
export const WEAPON_ROCKET = 2;

// ── Block operations ────────────────────────────
export const BLOCK_ADD = 1;
export const BLOCK_REMOVE = 2;

// ── Shape types ─────────────────────────────────
export const SHAPE_BOX = 0;
export const SHAPE_SPHERE = 1;
