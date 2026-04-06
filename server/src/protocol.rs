use anyhow::{bail, ensure, Result};
use bytes::{Buf, BufMut, BytesMut};

pub const PKT_CLIENT_HELLO: u8 = 1; // reliable stream
pub const PKT_INPUT_BUNDLE: u8 = 2; // datagram
pub const PKT_FIRE: u8 = 3; // datagram

pub const PKT_WELCOME: u8 = 101; // reliable stream
pub const PKT_SNAPSHOT: u8 = 102; // datagram
pub const PKT_SHOT_RESULT: u8 = 103; // reliable stream

pub const BTN_FORWARD: u16 = 1 << 0;
pub const BTN_BACK: u16 = 1 << 1;
pub const BTN_LEFT: u16 = 1 << 2;
pub const BTN_RIGHT: u16 = 1 << 3;
pub const BTN_JUMP: u16 = 1 << 4;
pub const BTN_CROUCH: u16 = 1 << 5;
pub const BTN_SPRINT: u16 = 1 << 6;

pub const FLAG_ON_GROUND: u16 = 1 << 0;

pub const WEAPON_HITSCAN: u8 = 1;
pub const WEAPON_ROCKET: u8 = 2;

#[derive(Clone, Debug)]
pub struct ClientHello {
    pub match_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct InputFrame {
    pub seq: u16,
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
    pub dir: [f32; 3],
}

#[derive(Clone, Debug)]
pub enum ClientDatagram {
    InputBundle(Vec<InputFrame>),
    Fire(FireCmd),
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
}

#[derive(Clone, Debug)]
pub struct ShotResultPacket {
    pub shot_id: u32,
    pub weapon: u8,
    pub confirmed: bool,
    pub hit_player_id: u32,
}

#[derive(Clone, Debug)]
pub enum ServerReliablePacket {
    Welcome(WelcomePacket),
    ShotResult(ShotResultPacket),
}

#[derive(Clone, Debug)]
pub enum ServerDatagramPacket {
    Snapshot(SnapshotPacket),
}

pub fn decode_client_hello(bytes: &[u8]) -> Result<ClientHello> {
    ensure!(!bytes.is_empty(), "empty hello packet");
    let mut buf = bytes;
    let kind = buf.get_u8();
    ensure!(kind == PKT_CLIENT_HELLO, "expected hello packet");
    ensure!(buf.remaining() >= 2, "short hello packet");
    let match_len = buf.get_u16_le() as usize;
    ensure!(buf.remaining() >= match_len, "truncated match id");
    let match_id = std::str::from_utf8(&buf[..match_len])?.to_string();
    Ok(ClientHello { match_id })
}

pub fn decode_client_datagram(bytes: &[u8]) -> Result<ClientDatagram> {
    ensure!(!bytes.is_empty(), "empty client datagram");
    let mut buf = bytes;
    let kind = buf.get_u8();
    Ok(match kind {
        PKT_INPUT_BUNDLE => {
            ensure!(buf.remaining() >= 1, "short input bundle header");
            let count = buf.get_u8() as usize;
            ensure!(count > 0, "input bundle cannot be empty");
            ensure!(buf.remaining() >= count * 10, "short input bundle payload");
            let mut frames = Vec::with_capacity(count);
            for _ in 0..count {
                frames.push(InputFrame {
                    seq: buf.get_u16_le(),
                    buttons: buf.get_u16_le(),
                    move_x: buf.get_i8(),
                    move_y: buf.get_i8(),
                    yaw: i16_to_angle(buf.get_i16_le()),
                    pitch: i16_to_angle(buf.get_i16_le()),
                });
            }
            ClientDatagram::InputBundle(frames)
        }
        PKT_FIRE => {
            ensure!(buf.remaining() >= 15, "short fire packet");
            let seq = buf.get_u16_le();
            let shot_id = buf.get_u32_le();
            let weapon = buf.get_u8();
            let client_interp_ms = buf.get_u16_le();
            let dir = [
                snorm16_to_f32(buf.get_i16_le()),
                snorm16_to_f32(buf.get_i16_le()),
                snorm16_to_f32(buf.get_i16_le()),
            ];
            ClientDatagram::Fire(FireCmd {
                seq,
                shot_id,
                weapon,
                client_interp_ms,
                dir,
            })
        }
        other => bail!("unknown client datagram packet kind {other}"),
    })
}

pub fn encode_server_reliable(packet: &ServerReliablePacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(128);
    match packet {
        ServerReliablePacket::Welcome(pkt) => {
            out.put_u8(PKT_WELCOME);
            out.put_u32_le(pkt.player_id);
            out.put_u16_le(pkt.sim_hz);
            out.put_u16_le(pkt.snapshot_hz);
            out.put_u64_le(pkt.server_time_us);
            out.put_u16_le(pkt.interpolation_delay_ms);
        }
        ServerReliablePacket::ShotResult(pkt) => {
            out.put_u8(PKT_SHOT_RESULT);
            out.put_u32_le(pkt.shot_id);
            out.put_u8(pkt.weapon);
            out.put_u8(pkt.confirmed as u8);
            out.put_u32_le(pkt.hit_player_id);
        }
    }
    out.to_vec()
}

pub fn encode_server_datagram(packet: &ServerDatagramPacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(2048);
    match packet {
        ServerDatagramPacket::Snapshot(pkt) => {
            out.put_u8(PKT_SNAPSHOT);
            out.put_u64_le(pkt.server_time_us);
            out.put_u32_le(pkt.server_tick);
            out.put_u16_le(pkt.ack_input_seq);
            out.put_u16_le(pkt.player_states.len() as u16);
            out.put_u16_le(pkt.projectile_states.len() as u16);
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
                out.put_u16_le(p.flags);
            }
            for p in &pkt.projectile_states {
                out.put_u32_le(p.id);
                out.put_u32_le(p.owner_id);
                out.put_u32_le(p.source_shot_id);
                out.put_u8(p.kind);
                out.put_i32_le(p.px_mm);
                out.put_i32_le(p.py_mm);
                out.put_i32_le(p.pz_mm);
                out.put_i16_le(p.vx_cms);
                out.put_i16_le(p.vy_cms);
                out.put_i16_le(p.vz_cms);
            }
        }
    }
    out.to_vec()
}

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

pub fn meters_to_mm(value: f32) -> i32 {
    (value * 1000.0).round() as i32
}

pub fn meters_to_cms_i16(value: f32) -> i16 {
    (value.clamp(-327.67, 327.67) * 100.0).round() as i16
}

pub fn angle_to_i16(angle_rad: f32) -> i16 {
    let normalized = angle_rad.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU;
    (normalized * 65535.0).round() as i16
}

pub fn i16_to_angle(encoded: i16) -> f32 {
    (encoded as u16 as f32 / 65535.0) * std::f32::consts::TAU
}

pub fn snorm16_to_f32(value: i16) -> f32 {
    (value as f32 / 32767.0).clamp(-1.0, 1.0)
}
