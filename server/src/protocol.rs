use anyhow::{bail, ensure, Result};
use bytes::{Buf, BufMut, BytesMut};

pub const PKT_INPUT: u8 = 1;
pub const PKT_FIRE: u8 = 2;
pub const PKT_BLOCK_EDIT: u8 = 3;
pub const PKT_PING: u8 = 4; // client -> server echo of a server ping nonce, or client-initiated ping

pub const PKT_WELCOME: u8 = 101;
pub const PKT_SNAPSHOT: u8 = 102;
pub const PKT_CHUNK_FULL: u8 = 103;
pub const PKT_CHUNK_DIFF: u8 = 104;
pub const PKT_SHOT_RESULT: u8 = 105;
pub const PKT_PONG: u8 = 106; // server -> client response for client-initiated ping
pub const PKT_SERVER_PING: u8 = 107; // server -> client latency probe; client should echo with PKT_PING immediately

pub const BTN_FORWARD: u16 = 1 << 0;
pub const BTN_BACK: u16 = 1 << 1;
pub const BTN_LEFT: u16 = 1 << 2;
pub const BTN_RIGHT: u16 = 1 << 3;
pub const BTN_JUMP: u16 = 1 << 4;
pub const BTN_CROUCH: u16 = 1 << 5;
pub const BTN_SPRINT: u16 = 1 << 6;
pub const BTN_PRIMARY_FIRE: u16 = 1 << 7;
pub const BTN_SECONDARY_FIRE: u16 = 1 << 8;
pub const BTN_RELOAD: u16 = 1 << 9;

pub const BLOCK_ADD: u8 = 1;
pub const BLOCK_REMOVE: u8 = 2;

#[derive(Clone, Debug, Default)]
pub struct InputCmd {
    pub seq: u16,
    pub client_tick: u32,
    pub buttons: u16,
    pub move_x: i8,
    pub move_y: i8,
    pub yaw: f32,
    pub pitch: f32,
}

#[derive(Clone, Debug)]
pub struct FireCmd {
    pub seq: u16,
    pub shot_id: u32,
    pub weapon: u8,
    pub client_interp_ms: u16,
    pub origin: [f32; 3],
    pub dir: [f32; 3],
}

#[derive(Clone, Debug)]
pub struct BlockEditCmd {
    pub request_id: u32,
    pub chunk: [i16; 3],
    pub local: [u8; 3],
    pub op: u8,
    pub material: u16,
    pub expected_version: u32,
}

#[derive(Clone, Debug)]
pub enum ClientPacket {
    Input(InputCmd),
    Fire(FireCmd),
    BlockEdit(BlockEditCmd),
    Ping(u32),
}

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
    pub hp: u8,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug)]
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
pub struct WelcomePacket {
    pub player_id: u32,
    pub sim_hz: u16,
    pub snapshot_hz: u16,
    pub chunk_size: u8,
}

#[derive(Clone, Debug)]
pub struct SnapshotPacket {
    pub server_tick: u32,
    pub ack_input_seq: u16,
    pub player_states: Vec<NetPlayerState>,
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
pub struct ShotResultPacket {
    pub shot_id: u32,
    pub hit_player_id: u32,
    pub damage: u16,
    pub confirmed: bool,
}

#[derive(Clone, Debug)]
pub enum ServerPacket {
    Welcome(WelcomePacket),
    Snapshot(SnapshotPacket),
    ChunkFull(ChunkFullPacket),
    ChunkDiff(ChunkDiffPacket),
    ShotResult(ShotResultPacket),
    Pong(u32),
    Ping(u32),
}

pub fn decode_client_packet(bytes: &[u8]) -> Result<ClientPacket> {
    ensure!(!bytes.is_empty(), "empty packet");
    let mut buf = bytes;
    let kind = buf.get_u8();
    Ok(match kind {
        PKT_INPUT => {
            ensure!(buf.remaining() >= 14, "short input packet");
            let seq = buf.get_u16_le();
            let client_tick = buf.get_u32_le();
            let buttons = buf.get_u16_le();
            let move_x = buf.get_i8();
            let move_y = buf.get_i8();
            let yaw = i16_to_angle(buf.get_i16_le());
            let pitch = i16_to_angle(buf.get_i16_le());
            ClientPacket::Input(InputCmd {
                seq,
                client_tick,
                buttons,
                move_x,
                move_y,
                yaw,
                pitch,
            })
        }
        PKT_FIRE => {
            ensure!(buf.remaining() >= 31, "short fire packet");
            let seq = buf.get_u16_le();
            let shot_id = buf.get_u32_le();
            let weapon = buf.get_u8();
            let client_interp_ms = buf.get_u16_le();
            let origin = [
                mm_to_meters(buf.get_i32_le()),
                mm_to_meters(buf.get_i32_le()),
                mm_to_meters(buf.get_i32_le()),
            ];
            let dir = [
                snorm16_to_f32(buf.get_i16_le()),
                snorm16_to_f32(buf.get_i16_le()),
                snorm16_to_f32(buf.get_i16_le()),
            ];
            ClientPacket::Fire(FireCmd {
                seq,
                shot_id,
                weapon,
                client_interp_ms,
                origin,
                dir,
            })
        }
        PKT_BLOCK_EDIT => {
            ensure!(buf.remaining() >= 22, "short block edit packet");
            ClientPacket::BlockEdit(BlockEditCmd {
                request_id: buf.get_u32_le(),
                chunk: [buf.get_i16_le(), buf.get_i16_le(), buf.get_i16_le()],
                local: [buf.get_u8(), buf.get_u8(), buf.get_u8()],
                op: buf.get_u8(),
                material: buf.get_u16_le(),
                expected_version: buf.get_u32_le(),
            })
        }
        PKT_PING => {
            ensure!(buf.remaining() >= 4, "short ping packet");
            ClientPacket::Ping(buf.get_u32_le())
        }
        other => bail!("unknown client packet kind {other}"),
    })
}

pub fn encode_server_packet(packet: &ServerPacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(1024);
    match packet {
        ServerPacket::Welcome(pkt) => {
            out.put_u8(PKT_WELCOME);
            out.put_u32_le(pkt.player_id);
            out.put_u16_le(pkt.sim_hz);
            out.put_u16_le(pkt.snapshot_hz);
            out.put_u8(pkt.chunk_size);
        }
        ServerPacket::Snapshot(pkt) => {
            out.put_u8(PKT_SNAPSHOT);
            out.put_u32_le(pkt.server_tick);
            out.put_u16_le(pkt.ack_input_seq);
            out.put_u16_le(pkt.player_states.len() as u16);
            for p in &pkt.player_states {
                out.put_u32_le(p.id);
                out.put_i32_le(p.px_mm);
                out.put_i32_le(p.py_mm);
                out.put_i32_le(p.pz_mm);
                out.put_i16_le(p.vx_cms);
                out.put_i16_le(p.vy_cms);
                out.put_i16_le(p.vz_cms);
                out.put_i16_le(p.yaw_i16);
                out.put_i16_le(p.pitch_i16);
                out.put_u8(p.hp);
                out.put_u16_le(p.flags);
            }
        }
        ServerPacket::ChunkFull(pkt) => {
            out.put_u8(PKT_CHUNK_FULL);
            out.put_i16_le(pkt.chunk[0]);
            out.put_i16_le(pkt.chunk[1]);
            out.put_i16_le(pkt.chunk[2]);
            out.put_u32_le(pkt.version);
            out.put_u16_le(pkt.blocks.len() as u16);
            for block in &pkt.blocks {
                out.put_u8(block.x);
                out.put_u8(block.y);
                out.put_u8(block.z);
                out.put_u16_le(block.material);
            }
        }
        ServerPacket::ChunkDiff(pkt) => {
            out.put_u8(PKT_CHUNK_DIFF);
            out.put_i16_le(pkt.chunk[0]);
            out.put_i16_le(pkt.chunk[1]);
            out.put_i16_le(pkt.chunk[2]);
            out.put_u32_le(pkt.version);
            out.put_u16_le(pkt.edits.len() as u16);
            for edit in &pkt.edits {
                out.put_u8(edit.x);
                out.put_u8(edit.y);
                out.put_u8(edit.z);
                out.put_u8(edit.op);
                out.put_u16_le(edit.material);
            }
        }
        ServerPacket::ShotResult(pkt) => {
            out.put_u8(PKT_SHOT_RESULT);
            out.put_u32_le(pkt.shot_id);
            out.put_u32_le(pkt.hit_player_id);
            out.put_u16_le(pkt.damage);
            out.put_u8(pkt.confirmed as u8);
        }
        ServerPacket::Pong(value) => {
            out.put_u8(PKT_PONG);
            out.put_u32_le(*value);
        }
        ServerPacket::Ping(value) => {
            out.put_u8(PKT_SERVER_PING);
            out.put_u32_le(*value);
        }
    }
    out.to_vec()
}

pub fn meters_to_mm(value: f32) -> i32 {
    (value * 1000.0).round() as i32
}

pub fn mm_to_meters(value: i32) -> f32 {
    value as f32 / 1000.0
}

pub fn meters_to_cms_i16(value: f32) -> i16 {
    (value.clamp(-327.67, 327.67) * 100.0).round() as i16
}

pub fn cms_i16_to_meters(value: i16) -> f32 {
    value as f32 / 100.0
}

pub fn angle_to_i16(angle_rad: f32) -> i16 {
    let normalized = angle_rad.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU;
    (normalized * 65535.0).round() as i16
}

pub fn i16_to_angle(encoded: i16) -> f32 {
    (encoded as u16 as f32 / 65535.0) * std::f32::consts::TAU
}

pub fn f32_to_snorm16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

pub fn snorm16_to_f32(value: i16) -> f32 {
    (value as f32 / 32767.0).clamp(-1.0, 1.0)
}

pub fn make_net_player_state(
    id: u32,
    pos: [f32; 3],
    vel: [f32; 3],
    yaw: f32,
    pitch: f32,
    hp: u8,
    flags: u16,
) -> NetPlayerState {
    NetPlayerState {
        id,
        px_mm: meters_to_mm(pos[0]),
        py_mm: meters_to_mm(pos[1]),
        pz_mm: meters_to_mm(pos[2]),
        vx_cms: meters_to_cms_i16(vel[0]),
        vy_cms: meters_to_cms_i16(vel[1]),
        vz_cms: meters_to_cms_i16(vel[2]),
        yaw_i16: angle_to_i16(yaw),
        pitch_i16: angle_to_i16(pitch),
        hp,
        flags,
    }
}
