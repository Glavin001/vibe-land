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

pub const BLOCK_ADD: u8 = 1;
pub const BLOCK_REMOVE: u8 = 2;

pub const SHAPE_BOX: u8 = 0;
pub const SHAPE_SPHERE: u8 = 1;

pub const PKT_CHUNK_FULL: u8 = 104;
pub const PKT_CHUNK_DIFF: u8 = 105;
pub const PKT_PING: u8 = 110;
pub const PKT_PONG: u8 = 111;

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

/// Server-side representation of the latest input for a player.
/// Same layout as InputFrame.
pub type InputCmd = InputFrame;

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
pub enum ClientPacket {
    InputBundle(Vec<InputCmd>),
    Fire(FireCmd),
    BlockEdit(BlockEditCmd),
    Ping(u32),
}

#[derive(Clone, Debug)]
pub enum ServerPacket {
    Welcome(WelcomePacket),
    Snapshot(SnapshotPacket),
    ShotResult(ShotResultPacket),
    ChunkFull(ChunkFullPacket),
    ChunkDiff(ChunkDiffPacket),
    Ping(u32),
    Pong(u32),
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
            let frames = decode_input_bundle_frames(&mut buf)?;
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
            out.put_u16_le(pkt.dynamic_body_states.len() as u16);
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
            for d in &pkt.dynamic_body_states {
                out.put_u32_le(d.id);
                out.put_u8(d.shape_type);
                out.put_i32_le(d.px_mm);
                out.put_i32_le(d.py_mm);
                out.put_i32_le(d.pz_mm);
                out.put_i16_le(d.qx_snorm);
                out.put_i16_le(d.qy_snorm);
                out.put_i16_le(d.qz_snorm);
                out.put_i16_le(d.qw_snorm);
                out.put_u16_le(d.hx_cm);
                out.put_u16_le(d.hy_cm);
                out.put_u16_le(d.hz_cm);
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

pub fn make_net_dynamic_body_state(
    id: u32,
    pos: [f32; 3],
    quat: [f32; 4], // x, y, z, w
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

fn f32_to_snorm16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

pub fn meters_to_mm(value: f32) -> i32 {
    (value * 1000.0).round() as i32
}

pub fn meters_to_cms_i16(value: f32) -> i16 {
    (value.clamp(-327.67, 327.67) * 100.0).round() as i16
}

pub fn angle_to_i16(angle_rad: f32) -> i16 {
    let normalized = angle_rad.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU;
    let u16_val = (normalized * 65535.0).round() as u16;
    u16_val as i16
}

pub fn i16_to_angle(encoded: i16) -> f32 {
    (encoded as u16 as f32 / 65535.0) * std::f32::consts::TAU
}

pub fn snorm16_to_f32(value: i16) -> f32 {
    (value as f32 / 32767.0).clamp(-1.0, 1.0)
}

const PKT_BLOCK_EDIT: u8 = 4;

pub fn decode_client_packet(bytes: &[u8]) -> Result<ClientPacket> {
    ensure!(!bytes.is_empty(), "empty client packet");
    let mut buf = bytes;
    let kind = buf.get_u8();
    Ok(match kind {
        PKT_INPUT_BUNDLE => {
            ClientPacket::InputBundle(decode_input_bundle_frames(&mut buf)?)
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
            ClientPacket::Fire(FireCmd {
                seq,
                shot_id,
                weapon,
                client_interp_ms,
                dir,
            })
        }
        PKT_BLOCK_EDIT => {
            ensure!(buf.remaining() >= 14, "short block edit packet");
            let chunk = [buf.get_i16_le(), buf.get_i16_le(), buf.get_i16_le()];
            let expected_version = buf.get_u32_le();
            let local = [buf.get_u8(), buf.get_u8(), buf.get_u8()];
            let op = buf.get_u8();
            let material = buf.get_u16_le();
            ClientPacket::BlockEdit(BlockEditCmd {
                chunk,
                expected_version,
                local,
                op,
                material,
            })
        }
        PKT_PING => {
            ensure!(buf.remaining() >= 4, "short ping packet");
            ClientPacket::Ping(buf.get_u32_le())
        }
        other => bail!("unknown client packet kind {other}"),
    })
}

fn decode_input_bundle_frames(buf: &mut &[u8]) -> Result<Vec<InputFrame>> {
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
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_client_packet_preserves_full_input_bundle() {
        let bytes = [
            PKT_INPUT_BUNDLE,
            2,
            1,
            0,
            1,
            0,
            127u8,
            0,
            0,
            0,
            0,
            0,
            2,
            0,
            3,
            0,
            0,
            127u8,
            0,
            0,
            0,
            0,
            0,
        ];

        let packet = decode_client_packet(&bytes).expect("bundle should decode");
        match packet {
            ClientPacket::InputBundle(frames) => {
                assert_eq!(frames.len(), 2);
                assert_eq!(frames[0].seq, 1);
                assert_eq!(frames[0].buttons, 1);
                assert_eq!(frames[0].move_x, 127);
                assert_eq!(frames[1].seq, 2);
                assert_eq!(frames[1].buttons, 3);
                assert_eq!(frames[1].move_y, 127);
            }
            other => panic!("expected input bundle, got {other:?}"),
        }
    }

    // ──────────────────────────────────────────────
    // encode/decode round-trip: Welcome
    // ──────────────────────────────────────────────

    #[test]
    fn welcome_encode_decode_roundtrip() {
        let packet = ServerPacket::Welcome(WelcomePacket {
            player_id: 42,
            sim_hz: 60,
            snapshot_hz: 30,
            server_time_us: 5_000_000,
            interpolation_delay_ms: 100,
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_WELCOME);
        // Verify the bytes decode back to expected values
        let view = &encoded[1..];
        let player_id = u32::from_le_bytes([view[0], view[1], view[2], view[3]]);
        let sim_hz = u16::from_le_bytes([view[4], view[5]]);
        assert_eq!(player_id, 42);
        assert_eq!(sim_hz, 60);
    }

    // ──────────────────────────────────────────────
    // encode/decode round-trip: Snapshot
    // ──────────────────────────────────────────────

    #[test]
    fn snapshot_encode_preserves_player_state() {
        let packet = ServerPacket::Snapshot(SnapshotPacket {
            server_time_us: 1_000_000,
            server_tick: 60,
            ack_input_seq: 42,
            player_states: vec![
                NetPlayerState {
                    id: 1,
                    px_mm: 5000,
                    py_mm: 1000,
                    pz_mm: -3000,
                    vx_cms: 100,
                    vy_cms: -50,
                    vz_cms: 200,
                    yaw_i16: 1000,
                    pitch_i16: -500,
                    flags: 1,
                },
            ],
            projectile_states: vec![],
            dynamic_body_states: vec![],
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_SNAPSHOT);

        // Verify player count encoded correctly
        let view = &encoded[1..];
        // server_time (8) + server_tick (4) + ack_input_seq (2) = 14
        let player_count = u16::from_le_bytes([view[14], view[15]]);
        assert_eq!(player_count, 1);
    }

    #[test]
    fn snapshot_encode_empty_no_players() {
        let packet = ServerPacket::Snapshot(SnapshotPacket {
            server_time_us: 0,
            server_tick: 0,
            ack_input_seq: 0,
            player_states: vec![],
            projectile_states: vec![],
            dynamic_body_states: vec![],
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_SNAPSHOT);
        // Check player count = 0
        let view = &encoded[1..];
        let player_count = u16::from_le_bytes([view[14], view[15]]);
        assert_eq!(player_count, 0);
    }

    // ──────────────────────────────────────────────
    // encode/decode round-trip: ShotResult
    // ──────────────────────────────────────────────

    #[test]
    fn shot_result_encode() {
        let packet = ServerPacket::ShotResult(ShotResultPacket {
            shot_id: 123,
            weapon: 1,
            confirmed: true,
            hit_player_id: 5,
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_SHOT_RESULT);
        let shot_id = u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]);
        assert_eq!(shot_id, 123);
    }

    // ──────────────────────────────────────────────
    // Input bundle parsing: single frame
    // ──────────────────────────────────────────────

    #[test]
    fn decode_single_input_frame() {
        let bytes = [
            PKT_INPUT_BUNDLE,
            1,  // count
            42, 0,  // seq
            17, 0,  // buttons (BTN_FORWARD | BTN_JUMP)
            127, 0,  // moveX, moveY
            0, 0,  // yaw
            0, 0,  // pitch
        ];

        let packet = decode_client_packet(&bytes).unwrap();
        match packet {
            ClientPacket::InputBundle(frames) => {
                assert_eq!(frames.len(), 1);
                assert_eq!(frames[0].seq, 42);
                assert_eq!(frames[0].buttons, 17);
                assert_eq!(frames[0].move_x, 127);
            }
            other => panic!("expected input bundle, got {other:?}"),
        }
    }

    // ──────────────────────────────────────────────
    // Unit conversion helpers
    // ──────────────────────────────────────────────

    #[test]
    fn meters_to_mm_and_back() {
        let original = 5.123_f32;
        let mm = meters_to_mm(original);
        let back = mm as f32 / 1000.0;
        assert!((back - original).abs() < 0.001);
    }

    #[test]
    fn angle_encode_decode_roundtrip() {
        let original = 1.5_f32; // radians
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        assert!((decoded - original).abs() < 0.01, "got {} vs {}", decoded, original);
    }

    #[test]
    fn angle_encode_negative() {
        let original = -1.0_f32;
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        // -1.0 wraps to [0, 2PI) range. Check equivalence modulo TAU.
        let expected_wrapped = original.rem_euclid(std::f32::consts::TAU);
        assert!((decoded - expected_wrapped).abs() < 0.01, "got {} vs {}", decoded, expected_wrapped);
    }

    // ──────────────────────────────────────────────
    // Chunk packets
    // ──────────────────────────────────────────────

    #[test]
    fn chunk_full_encode() {
        let packet = ServerPacket::ChunkFull(ChunkFullPacket {
            chunk: [1, -2, 3],
            version: 5,
            blocks: vec![
                BlockCell { x: 0, y: 0, z: 0, material: 1 },
                BlockCell { x: 1, y: 2, z: 3, material: 2 },
            ],
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_CHUNK_FULL);
        // chunk x = 1 (i16 LE)
        let chunk_x = i16::from_le_bytes([encoded[1], encoded[2]]);
        assert_eq!(chunk_x, 1);
        let chunk_y = i16::from_le_bytes([encoded[3], encoded[4]]);
        assert_eq!(chunk_y, -2);
    }

    #[test]
    fn chunk_diff_encode() {
        let packet = ServerPacket::ChunkDiff(ChunkDiffPacket {
            chunk: [0, 0, 0],
            version: 2,
            edits: vec![
                BlockEditNet { x: 5, y: 10, z: 15, op: 1, material: 3 },
            ],
        });

        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_CHUNK_DIFF);
        // edit count
        let edit_count = encoded[1 + 6 + 4]; // after type + chunk(6) + version(4)
        assert_eq!(edit_count, 1);
    }

    // ──────────────────────────────────────────────
    // Ping/Pong
    // ──────────────────────────────────────────────

    #[test]
    fn ping_encode() {
        let packet = ServerPacket::Ping(0xDEAD_BEEF);
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_PING);
        let nonce = u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]);
        assert_eq!(nonce, 0xDEAD_BEEF);
    }
}

pub fn encode_server_packet(packet: &ServerPacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(2048);
    match packet {
        ServerPacket::Welcome(pkt) => {
            out.put_u8(PKT_WELCOME);
            out.put_u32_le(pkt.player_id);
            out.put_u16_le(pkt.sim_hz);
            out.put_u16_le(pkt.snapshot_hz);
            out.put_u64_le(pkt.server_time_us);
            out.put_u16_le(pkt.interpolation_delay_ms);
        }
        ServerPacket::Snapshot(pkt) => {
            out.put_u8(PKT_SNAPSHOT);
            out.put_u64_le(pkt.server_time_us);
            out.put_u32_le(pkt.server_tick);
            out.put_u16_le(pkt.ack_input_seq);
            out.put_u16_le(pkt.player_states.len() as u16);
            out.put_u16_le(pkt.projectile_states.len() as u16);
            out.put_u16_le(pkt.dynamic_body_states.len() as u16);
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
            for d in &pkt.dynamic_body_states {
                out.put_u32_le(d.id);
                out.put_u8(d.shape_type);
                out.put_i32_le(d.px_mm);
                out.put_i32_le(d.py_mm);
                out.put_i32_le(d.pz_mm);
                out.put_i16_le(d.qx_snorm);
                out.put_i16_le(d.qy_snorm);
                out.put_i16_le(d.qz_snorm);
                out.put_i16_le(d.qw_snorm);
                out.put_u16_le(d.hx_cm);
                out.put_u16_le(d.hy_cm);
                out.put_u16_le(d.hz_cm);
            }
        }
        ServerPacket::ShotResult(pkt) => {
            out.put_u8(PKT_SHOT_RESULT);
            out.put_u32_le(pkt.shot_id);
            out.put_u8(pkt.weapon);
            out.put_u8(pkt.confirmed as u8);
            out.put_u32_le(pkt.hit_player_id);
        }
        ServerPacket::ChunkFull(pkt) => {
            out.put_u8(PKT_CHUNK_FULL);
            out.put_i16_le(pkt.chunk[0]);
            out.put_i16_le(pkt.chunk[1]);
            out.put_i16_le(pkt.chunk[2]);
            out.put_u32_le(pkt.version);
            out.put_u16_le(pkt.blocks.len() as u16);
            for b in &pkt.blocks {
                out.put_u8(b.x);
                out.put_u8(b.y);
                out.put_u8(b.z);
                out.put_u16_le(b.material);
            }
        }
        ServerPacket::ChunkDiff(pkt) => {
            out.put_u8(PKT_CHUNK_DIFF);
            out.put_i16_le(pkt.chunk[0]);
            out.put_i16_le(pkt.chunk[1]);
            out.put_i16_le(pkt.chunk[2]);
            out.put_u32_le(pkt.version);
            out.put_u8(pkt.edits.len() as u8);
            for e in &pkt.edits {
                out.put_u8(e.x);
                out.put_u8(e.y);
                out.put_u8(e.z);
                out.put_u8(e.op);
                out.put_u16_le(e.material);
            }
        }
        ServerPacket::Ping(v) => {
            out.put_u8(PKT_PING);
            out.put_u32_le(*v);
        }
        ServerPacket::Pong(v) => {
            out.put_u8(PKT_PONG);
            out.put_u32_le(*v);
        }
    }
    out.to_vec()
}
