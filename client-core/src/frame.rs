//! What the core hands a renderer: plain `#[repr(C)]` records in flat arrays, written in the
//! renderer's [`Space`](crate::coords::Space). The native binding exposes them as pointers valid
//! until the next poll; the WASM binding as typed-array views. Same layout, no serialisation.
//!
//! The city is a fixed table of chunks (from the manifest). Each chunk rides either its standing
//! structure (drawn at its rest pose) or a dynamic body. The core reports *changes* to that
//! assignment, and each frame the poses of bodies that moved, so a renderer's per-frame work scales
//! with moving bodies, not with chunks.

/// [`VlChunkAssignment::body`] for a chunk standing in its structure, drawn at its rest pose.
pub const VL_BODY_STANDING: u32 = 0xFFFF_FFFF; // u32::MAX, spelled out for cbindgen
/// [`VlChunkAssignment::body`] for a chunk the physics removed; hide it.
pub const VL_BODY_REMOVED: u32 = 0xFFFF_FFFE; // u32::MAX - 1

/// [`VlChunk::flags`] bit: a support (anchoring) chunk.
pub const VL_CHUNK_SUPPORT: u32 = 1;
/// [`VlChunk::flags`] bit: the chunk's collider is a convex hull (its box is the hull's bounds).
pub const VL_CHUNK_HULL: u32 = 2;

/// [`VlBodyPose::flags`] bit: the body has settled; this is its final pose until it wakes.
pub const VL_POSE_SETTLED: u32 = 1;

/// [`VlPlayer::flags`] bit: this record is valid (the local player before the first snapshot is not).
pub const VL_PLAYER_VALID: u32 = 1;

/// One chunk of the city, fixed for the life of the manifest. Index = position in the chunk table.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlChunk {
    pub structure: u32,
    pub node: u32,
    /// World pose of the chunk's centre at rest (its structure's pose applied to its centroid).
    pub rest_pos: [f32; 3],
    pub rest_quat: [f32; 4],
    /// Full box extents in the chunk's own axes (for a hull, its bounds).
    pub extents: [f32; 3],
    /// Display colour, 0xRRGGBBAA (from the manifest's material appearance; grey when unauthored).
    pub color_rgba: u32,
    pub flags: u32,
}

/// A chunk now rides `body` (or stands, or is removed). On a body, the chunk's world pose is the
/// body's pose applied to `local_pos` (the chunk keeps the body's rotation).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlChunkAssignment {
    /// Index into the chunk table.
    pub chunk: u32,
    pub structure: u32,
    /// The body id within `structure`, or [`VL_BODY_STANDING`] / [`VL_BODY_REMOVED`].
    pub body: u32,
    /// The chunk's centre in the body's frame (zero unless on a body).
    pub local_pos: [f32; 3],
}

/// A dynamic body's world pose this frame (its centre-of-mass frame).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlBodyPose {
    pub structure: u32,
    pub body: u32,
    pub pos: [f32; 3],
    pub quat: [f32; 4],
    pub flags: u32,
}

/// A player, interpolated to the render time.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlPlayer {
    pub player_id: u32,
    pub flags: u32,
    /// The player's position as the server simulates it (the capsule's centre; the eye is
    /// [`VL_EYE_HEIGHT_M`] above it).
    pub pos: [f32; 3],
    /// Yaw and pitch: radians in server space, degrees in Unreal.
    pub yaw: f32,
    pub pitch: f32,
    pub hp: u32,
    /// Velocity (per second, in the renderer's units).
    pub vel: [f32; 3],
    /// The server's player flags: [`VL_STATE_ON_GROUND`], [`VL_STATE_IN_VEHICLE`], ...
    pub state_flags: u32,
}

/// The eye above a player's reported position (`shared::constants::PLAYER_EYE_HEIGHT_M`), metres.
pub const VL_EYE_HEIGHT_M: f32 = 0.8;

/// [`VlPlayer::state_flags`] bits (`shared::constants::FLAG_*`).
pub const VL_STATE_ON_GROUND: u32 = 1;
pub const VL_STATE_IN_VEHICLE: u32 = 2;
pub const VL_STATE_DEAD: u32 = 4;
pub const VL_STATE_MELEEING: u32 = 8;
pub const VL_STATE_SPAWN_PROTECTED: u32 = 16;

/// The local player: the server's pose plus the presentation offset that hides input latency.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlLocal {
    /// Presented pose (authoritative + offset); yaw and pitch are the server's last acknowledged
    /// view (a renderer uses its own camera angles).
    pub player: VlPlayer,
    /// Where the camera goes: the presented position plus the eye height.
    pub eye: [f32; 3],
    /// Energy (0..1000), or a negative value before the server has sent it.
    pub energy: f32,
    /// The newest input sequence the server has applied, and the next one this client will send.
    pub ack_input_seq: u32,
    pub next_input_seq: u32,
    /// Length of the presentation offset, metres (how far the drawn pose leads the server's).
    pub prediction_offset_m: f32,
}

/// What the renderer's player is doing this frame, in the renderer's space: axes in [-1, 1]
/// (`move_x` right, `move_y` forward), view angles (radians for the server, degrees for Unreal),
/// `VL_BTN_*` bits.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlInput {
    pub move_x: f32,
    pub move_y: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: u32,
}

/// [`VlInput::buttons`] bits (`shared::constants::BTN_*`).
pub const VL_BTN_JUMP: u32 = 16;
pub const VL_BTN_CROUCH: u32 = 32;
pub const VL_BTN_SPRINT: u32 = 64;
/// In a vehicle: reset the car.
pub const VL_BTN_RELOAD: u32 = 256;

/// Weapons (`shared::constants::WEAPON_*`).
pub const VL_WEAPON_RIFLE: u32 = 1;
pub const VL_WEAPON_CANNON: u32 = 3;
pub const VL_WEAPON_METEOR: u32 = 4;

/// [`VlEvent::kind`]: a hitscan shot the server resolved (anyone's, including this client's):
/// `player` shot from `p0` to `p1`; `a` = how it resolved (0 miss, 1 player, 2 dynamic body, 3 blocked by the world:
/// `SHOT_RESOLUTION_*`), `b` = hit zone (0 none, 1 body, 2 head).
pub const VL_EVENT_SHOT_FIRED: u32 = 1;
/// The server's verdict on one of this client's shots: `id` = shot, `a` = confirmed (0/1),
/// `player` = the player hit (0 if none), `b` = hit zone.
pub const VL_EVENT_SHOT_RESULT: u32 = 2;
/// This player was hit: `player` = attacker, `a` = damage, `b` = hit zone, `p0` = attacker.
pub const VL_EVENT_DAMAGE: u32 = 3;
/// This client fired (sent the moment it did, for the local muzzle effect and tracer): `id` =
/// shot, `p0` = eye, `p1` = the aim direction (unit).
pub const VL_EVENT_LOCAL_SHOT: u32 = 4;

/// Something that happened, in arrival order. Positions in the renderer's space.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlEvent {
    pub kind: u32,
    pub player: u32,
    pub id: u32,
    pub weapon: u32,
    pub a: u32,
    pub b: u32,
    pub p0: [f32; 3],
    pub p1: [f32; 3],
}

/// Where the session is, as the core sees it.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VlCoreState {
    #[default]
    WaitingForConfig = 0,
    /// Session config received; waiting for the city manifest.
    WaitingForManifest = 1,
    /// Manifest decoded; waiting for the server's Welcome.
    WaitingForWelcome = 2,
    /// Joined the match.
    Playing = 3,
    /// Something the core cannot continue from (see `last_error`).
    Failed = 4,
}

/// Counters and clocks, for overlays, logs and test gates.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlStats {
    pub state: u32,
    pub player_id: u32,
    pub city_wire: u32,
    pub chunks: u32,
    pub live_bodies: u32,
    pub remote_players: u32,
    pub snapshots: u64,
    pub newest_server_tick: u32,
    /// The city stream's render tick (NaN before the clock has a sample).
    pub city_render_tick: f32,
    /// The players' render tick (NaN before the first snapshot).
    pub player_render_tick: f32,
    pub decode_errors: u64,
    pub unknown_packets: u64,
    pub keyframes: u64,
    pub late_keyframes: u64,
    pub events_applied: u64,
    pub fractures: u64,
    pub hash_checks: u64,
    pub hash_mismatches: u64,
    pub bootstraps: u64,
    pub resync_requests: u64,
    pub acks_sent: u64,
}

/// One frame's output. Arrays are rebuilt each poll (assignments and poses hold only changes).
#[derive(Clone, Debug, Default)]
pub struct SceneFrame {
    pub local: VlLocal,
    pub remote_players: Vec<VlPlayer>,
    pub assignments: Vec<VlChunkAssignment>,
    pub body_poses: Vec<VlBodyPose>,
    /// Events since the previous poll.
    pub events: Vec<VlEvent>,
    pub stats: VlStats,
}

impl SceneFrame {
    pub(crate) fn clear_changes(&mut self) {
        self.remote_players.clear();
        self.assignments.clear();
        self.body_poses.clear();
        self.events.clear();
    }
}
