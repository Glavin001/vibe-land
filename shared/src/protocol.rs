use crate::unit_conv::*;

// ── Core types ──────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct InputFrame {
    pub seq: u16,
    pub buttons: u16,
    pub move_x: i8,
    pub move_y: i8,
    pub yaw: f32,
    pub pitch: f32,
}

pub type InputCmd = InputFrame;

#[derive(Clone, Copy, Debug, Default)]
pub struct NetPlayerState {
    pub id: u32,
    pub px_mm: i32,
    pub py_mm: i32,
    pub pz_mm: i32,
    pub vx_cms: i16,
    pub vy_cms: i16,
    pub vz_cms: i16,
    pub yaw_i16: i16,
    pub pitch_i16: i16,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NetProjectileState {
    pub id: u32,
    pub owner_id: u32,
    pub source_shot_id: u32,
    pub kind: u8,
    pub px_mm: i32,
    pub py_mm: i32,
    pub pz_mm: i32,
    pub vx_cms: i16,
    pub vy_cms: i16,
    pub vz_cms: i16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NetDynamicBodyState {
    pub id: u32,
    pub shape_type: u8,
    pub px_mm: i32,
    pub py_mm: i32,
    pub pz_mm: i32,
    pub qx_snorm: i16,
    pub qy_snorm: i16,
    pub qz_snorm: i16,
    pub qw_snorm: i16,
    pub hx_cm: u16,
    pub hy_cm: u16,
    pub hz_cm: u16,
}

#[derive(Clone, Debug)]
pub struct FireCmd {
    pub seq: u16,
    pub shot_id: u32,
    pub weapon: u8,
    pub client_interp_ms: u16,
    pub dir: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct BlockCell {
    pub x: u8,
    pub y: u8,
    pub z: u8,
    pub material: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct BlockEditNet {
    pub x: u8,
    pub y: u8,
    pub z: u8,
    pub op: u8,
    pub material: u16,
}

#[derive(Clone, Debug)]
pub struct BlockEditCmd {
    pub chunk: [i16; 3],
    pub expected_version: u32,
    pub local: [u8; 3],
    pub op: u8,
    pub material: u16,
}

#[derive(Clone, Debug)]
pub struct ChunkFullPacket {
    pub chunk: [i16; 3],
    pub version: u32,
    pub blocks: Vec<BlockCell>,
}

#[derive(Clone, Debug)]
pub struct ChunkDiffPacket {
    pub chunk: [i16; 3],
    pub version: u32,
    pub edits: Vec<BlockEditNet>,
}

#[derive(Clone, Debug)]
pub struct WelcomePacket {
    pub player_id: u32,
    pub sim_hz: u16,
    pub snapshot_hz: u16,
    pub server_time_us: u64,
    pub interpolation_delay_ms: u16,
}

#[derive(Clone, Debug)]
pub struct SnapshotPacket {
    pub server_time_us: u64,
    pub server_tick: u32,
    pub ack_input_seq: u16,
    pub player_states: Vec<NetPlayerState>,
    pub projectile_states: Vec<NetProjectileState>,
    pub dynamic_body_states: Vec<NetDynamicBodyState>,
}

#[derive(Clone, Debug)]
pub struct ShotResultPacket {
    pub shot_id: u32,
    pub weapon: u8,
    pub confirmed: bool,
    pub hit_player_id: u32,
}

// ── High-level state conversion helpers ─────────

/// Convert meters-based values into network format.
pub fn make_net_player_state(
    player_id: u32,
    pos: [f32; 3],
    vel: [f32; 3],
    yaw: f32,
    pitch: f32,
    flags: u16,
) -> NetPlayerState {
    NetPlayerState {
        id: player_id,
        px_mm: meters_to_mm(pos[0]),
        py_mm: meters_to_mm(pos[1]),
        pz_mm: meters_to_mm(pos[2]),
        vx_cms: meters_to_cms_i16(vel[0]),
        vy_cms: meters_to_cms_i16(vel[1]),
        vz_cms: meters_to_cms_i16(vel[2]),
        yaw_i16: angle_to_i16(yaw),
        pitch_i16: angle_to_i16(pitch),
        flags,
    }
}

pub fn make_net_projectile_state(
    id: u32,
    owner_id: u32,
    source_shot_id: u32,
    kind: u8,
    pos: [f32; 3],
    vel: [f32; 3],
) -> NetProjectileState {
    NetProjectileState {
        id,
        owner_id,
        source_shot_id,
        kind,
        px_mm: meters_to_mm(pos[0]),
        py_mm: meters_to_mm(pos[1]),
        pz_mm: meters_to_mm(pos[2]),
        vx_cms: meters_to_cms_i16(vel[0]),
        vy_cms: meters_to_cms_i16(vel[1]),
        vz_cms: meters_to_cms_i16(vel[2]),
    }
}

pub fn make_net_dynamic_body_state(
    id: u32,
    pos: [f32; 3],
    quat: [f32; 4],
    half_extents: [f32; 3],
    shape_type: u8,
) -> NetDynamicBodyState {
    NetDynamicBodyState {
        id,
        shape_type,
        px_mm: meters_to_mm(pos[0]),
        py_mm: meters_to_mm(pos[1]),
        pz_mm: meters_to_mm(pos[2]),
        qx_snorm: f32_to_snorm16(quat[0]),
        qy_snorm: f32_to_snorm16(quat[1]),
        qz_snorm: f32_to_snorm16(quat[2]),
        qw_snorm: f32_to_snorm16(quat[3]),
        hx_cm: (half_extents[0] * 100.0).round() as u16,
        hy_cm: (half_extents[1] * 100.0).round() as u16,
        hz_cm: (half_extents[2] * 100.0).round() as u16,
    }
}

/// Decoded player state in meters (for physics simulation).
pub struct PlayerStateMeters {
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub yaw: f64,
    pub pitch: f64,
    pub flags: u16,
}

pub fn net_player_state_to_meters(state: &NetPlayerState) -> PlayerStateMeters {
    PlayerStateMeters {
        position: [
            mm_to_meters(state.px_mm) as f64,
            mm_to_meters(state.py_mm) as f64,
            mm_to_meters(state.pz_mm) as f64,
        ],
        velocity: [
            cms_to_mps(state.vx_cms) as f64,
            cms_to_mps(state.vy_cms) as f64,
            cms_to_mps(state.vz_cms) as f64,
        ],
        yaw: i16_to_angle(state.yaw_i16) as f64,
        pitch: i16_to_angle(state.pitch_i16) as f64,
        flags: state.flags,
    }
}
