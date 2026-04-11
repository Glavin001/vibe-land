use anyhow::{bail, ensure, Result};
use bytes::{Buf, BufMut, BytesMut};

// Re-export all shared types, constants, and utilities
pub use vibe_land_shared::constants::*;
pub use vibe_land_shared::unit_conv::*;
pub use vibe_land_shared::protocol::*;

// ── Server-only types ───────────────────────────

#[derive(Clone, Debug)]
pub struct ClientHello {
    pub match_id: String,
}

#[derive(Clone, Debug)]
pub enum ClientPacket {
    InputBundle(Vec<InputCmd>),
    Fire(FireCmd),
    BlockEdit(BlockEditCmd),
    Ping(u32),
    VehicleEnter(VehicleEnterCmd),
    VehicleExit(VehicleExitCmd),
    DebugStats { correction_m: f32, physics_ms: f32 },
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
    BlockEdit(BlockEditCmd),
    VehicleEnter(VehicleEnterCmd),
    VehicleExit(VehicleExitCmd),
    Ping(u32),
    DebugStats { correction_m: f32, physics_ms: f32 },
}

#[derive(Clone, Debug)]
pub enum ServerReliablePacket {
    Welcome(WelcomePacket),
    ShotResult(ShotResultPacket),
    ChunkFull(ChunkFullPacket),
    ChunkDiff(ChunkDiffPacket),
}

#[derive(Clone, Debug)]
pub enum ServerDatagramPacket {
    Snapshot(SnapshotPacket),
}

// ── Server-only decode/encode functions ─────────

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
        PKT_BLOCK_EDIT => {
            ensure!(buf.remaining() >= 14, "short block edit datagram");
            let chunk = [buf.get_i16_le(), buf.get_i16_le(), buf.get_i16_le()];
            let expected_version = buf.get_u32_le();
            let local = [buf.get_u8(), buf.get_u8(), buf.get_u8()];
            let op = buf.get_u8();
            let material = buf.get_u16_le();
            ClientDatagram::BlockEdit(BlockEditCmd { chunk, expected_version, local, op, material })
        }
        PKT_VEHICLE_ENTER => {
            ensure!(buf.remaining() >= 5, "short vehicle enter datagram");
            let vehicle_id = buf.get_u32_le();
            let seat = buf.get_u8();
            ClientDatagram::VehicleEnter(VehicleEnterCmd { vehicle_id, seat })
        }
        PKT_VEHICLE_EXIT => {
            ensure!(buf.remaining() >= 4, "short vehicle exit datagram");
            let vehicle_id = buf.get_u32_le();
            ClientDatagram::VehicleExit(VehicleExitCmd { vehicle_id })
        }
        PKT_PING => {
            ensure!(buf.remaining() >= 4, "short ping datagram");
            ClientDatagram::Ping(buf.get_u32_le())
        }
        PKT_DEBUG_STATS => {
            ensure!(buf.remaining() >= 8, "short debug stats datagram");
            let correction_m = f32::from_le_bytes([buf.get_u8(), buf.get_u8(), buf.get_u8(), buf.get_u8()]);
            let physics_ms = f32::from_le_bytes([buf.get_u8(), buf.get_u8(), buf.get_u8(), buf.get_u8()]);
            ClientDatagram::DebugStats { correction_m, physics_ms }
        }
        other => bail!("unknown client datagram packet kind {other}"),
    })
}

/// Convert a [`ClientDatagram`] (WebTransport) to a [`ClientPacket`] (match event).
pub fn client_datagram_to_packet(d: ClientDatagram) -> ClientPacket {
    match d {
        ClientDatagram::InputBundle(frames) => ClientPacket::InputBundle(frames),
        ClientDatagram::Fire(cmd) => ClientPacket::Fire(cmd),
        ClientDatagram::BlockEdit(cmd) => ClientPacket::BlockEdit(cmd),
        ClientDatagram::VehicleEnter(cmd) => ClientPacket::VehicleEnter(cmd),
        ClientDatagram::VehicleExit(cmd) => ClientPacket::VehicleExit(cmd),
        ClientDatagram::Ping(n) => ClientPacket::Ping(n),
        ClientDatagram::DebugStats { correction_m, physics_ms } => ClientPacket::DebugStats { correction_m, physics_ms },
    }
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
        ServerReliablePacket::ChunkFull(pkt) => {
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
        ServerReliablePacket::ChunkDiff(pkt) => {
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
            out.put_u16_le(pkt.vehicle_states.len() as u16);
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
                out.put_i16_le(d.vx_cms);
                out.put_i16_le(d.vy_cms);
                out.put_i16_le(d.vz_cms);
            }
            encode_vehicle_states(&mut out, &pkt.vehicle_states);
        }
    }
    out.to_vec()
}

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
        PKT_VEHICLE_ENTER => {
            ensure!(buf.remaining() >= 5, "short vehicle enter packet");
            let vehicle_id = buf.get_u32_le();
            let seat = buf.get_u8();
            ClientPacket::VehicleEnter(VehicleEnterCmd { vehicle_id, seat })
        }
        PKT_VEHICLE_EXIT => {
            ensure!(buf.remaining() >= 4, "short vehicle exit packet");
            let vehicle_id = buf.get_u32_le();
            ClientPacket::VehicleExit(VehicleExitCmd { vehicle_id })
        }
        PKT_DEBUG_STATS => {
            ensure!(buf.remaining() >= 8, "short debug stats packet");
            let correction_m = f32::from_le_bytes([buf.get_u8(), buf.get_u8(), buf.get_u8(), buf.get_u8()]);
            let physics_ms = f32::from_le_bytes([buf.get_u8(), buf.get_u8(), buf.get_u8(), buf.get_u8()]);
            ClientPacket::DebugStats { correction_m, physics_ms }
        }
        other => bail!("unknown client packet kind {other}"),
    })
}

fn encode_vehicle_states(out: &mut bytes::BytesMut, states: &[NetVehicleState]) {
    for v in states {
        out.put_u32_le(v.id);
        out.put_u8(v.vehicle_type);
        out.put_u8(v.flags);
        out.put_u32_le(v.driver_id);
        out.put_i32_le(v.px_mm);
        out.put_i32_le(v.py_mm);
        out.put_i32_le(v.pz_mm);
        out.put_i16_le(v.qx_snorm);
        out.put_i16_le(v.qy_snorm);
        out.put_i16_le(v.qz_snorm);
        out.put_i16_le(v.qw_snorm);
        out.put_i16_le(v.vx_cms);
        out.put_i16_le(v.vy_cms);
        out.put_i16_le(v.vz_cms);
        out.put_i16_le(v.wx_mrads);
        out.put_i16_le(v.wy_mrads);
        out.put_i16_le(v.wz_mrads);
        for &wd in &v.wheel_data {
            out.put_u16_le(wd);
        }
    }
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
            out.put_u16_le(pkt.vehicle_states.len() as u16);
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
                out.put_i16_le(d.vx_cms);
                out.put_i16_le(d.vy_cms);
                out.put_i16_le(d.vz_cms);
            }
            encode_vehicle_states(&mut out, &pkt.vehicle_states);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_client_packet_preserves_full_input_bundle() {
        let bytes = [
            PKT_INPUT_BUNDLE, 2,
            1, 0, 1, 0, 127u8, 0, 0, 0, 0, 0,
            2, 0, 3, 0, 0, 127u8, 0, 0, 0, 0, 0,
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

    #[test]
    fn welcome_encode_decode_roundtrip() {
        let packet = ServerPacket::Welcome(WelcomePacket {
            player_id: 42, sim_hz: 60, snapshot_hz: 30,
            server_time_us: 5_000_000, interpolation_delay_ms: 100,
        });
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_WELCOME);
        let view = &encoded[1..];
        assert_eq!(u32::from_le_bytes([view[0], view[1], view[2], view[3]]), 42);
        assert_eq!(u16::from_le_bytes([view[4], view[5]]), 60);
    }

    #[test]
    fn snapshot_encode_preserves_player_state() {
        let packet = ServerPacket::Snapshot(SnapshotPacket {
            server_time_us: 1_000_000, server_tick: 60, ack_input_seq: 42,
            player_states: vec![NetPlayerState {
                id: 1, px_mm: 5000, py_mm: 1000, pz_mm: -3000,
                vx_cms: 100, vy_cms: -50, vz_cms: 200,
                yaw_i16: 1000, pitch_i16: -500, flags: 1,
            }],
            projectile_states: vec![], dynamic_body_states: vec![], vehicle_states: vec![],
        });
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_SNAPSHOT);
        let view = &encoded[1..];
        assert_eq!(u16::from_le_bytes([view[14], view[15]]), 1);
    }

    #[test]
    fn snapshot_encode_empty_no_players() {
        let packet = ServerPacket::Snapshot(SnapshotPacket {
            server_time_us: 0, server_tick: 0, ack_input_seq: 0,
            player_states: vec![], projectile_states: vec![], dynamic_body_states: vec![], vehicle_states: vec![],
        });
        let encoded = encode_server_packet(&packet);
        let view = &encoded[1..];
        assert_eq!(u16::from_le_bytes([view[14], view[15]]), 0);
    }

    #[test]
    fn shot_result_encode() {
        let packet = ServerPacket::ShotResult(ShotResultPacket {
            shot_id: 123, weapon: 1, confirmed: true, hit_player_id: 5,
        });
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_SHOT_RESULT);
        assert_eq!(u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]), 123);
    }

    #[test]
    fn decode_single_input_frame() {
        let bytes = [
            PKT_INPUT_BUNDLE, 1, 42, 0, 17, 0, 127, 0, 0, 0, 0, 0,
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

    #[test]
    fn meters_to_mm_and_back() {
        let original = 5.123_f32;
        let mm = meters_to_mm(original);
        let back = mm as f32 / 1000.0;
        assert!((back - original).abs() < 0.001);
    }

    #[test]
    fn angle_encode_decode_roundtrip() {
        let original = 1.5_f32;
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        assert!((decoded - original).abs() < 0.01);
    }

    #[test]
    fn angle_encode_negative() {
        let original = -1.0_f32;
        let encoded = angle_to_i16(original);
        let decoded = i16_to_angle(encoded);
        let expected_wrapped = original.rem_euclid(std::f32::consts::TAU);
        assert!((decoded - expected_wrapped).abs() < 0.01);
    }

    #[test]
    fn chunk_full_encode() {
        let packet = ServerPacket::ChunkFull(ChunkFullPacket {
            chunk: [1, -2, 3], version: 5,
            blocks: vec![
                BlockCell { x: 0, y: 0, z: 0, material: 1 },
                BlockCell { x: 1, y: 2, z: 3, material: 2 },
            ],
        });
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_CHUNK_FULL);
        assert_eq!(i16::from_le_bytes([encoded[1], encoded[2]]), 1);
        assert_eq!(i16::from_le_bytes([encoded[3], encoded[4]]), -2);
    }

    #[test]
    fn chunk_diff_encode() {
        let packet = ServerPacket::ChunkDiff(ChunkDiffPacket {
            chunk: [0, 0, 0], version: 2,
            edits: vec![BlockEditNet { x: 5, y: 10, z: 15, op: 1, material: 3 }],
        });
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_CHUNK_DIFF);
        assert_eq!(encoded[1 + 6 + 4], 1);
    }

    #[test]
    fn ping_encode() {
        let packet = ServerPacket::Ping(0xDEAD_BEEF);
        let encoded = encode_server_packet(&packet);
        assert_eq!(encoded[0], PKT_PING);
        assert_eq!(u32::from_le_bytes([encoded[1], encoded[2], encoded[3], encoded[4]]), 0xDEAD_BEEF);
    }
}
