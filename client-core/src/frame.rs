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
    /// The player's position as the server simulates it.
    pub pos: [f32; 3],
    /// Yaw and pitch: radians in server space, degrees in Unreal.
    pub yaw: f32,
    pub pitch: f32,
    pub hp: u32,
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
    pub local: VlPlayer,
    pub remote_players: Vec<VlPlayer>,
    pub assignments: Vec<VlChunkAssignment>,
    pub body_poses: Vec<VlBodyPose>,
    pub stats: VlStats,
}

impl SceneFrame {
    pub(crate) fn clear_changes(&mut self) {
        self.remote_players.clear();
        self.assignments.clear();
        self.body_poses.clear();
    }
}
