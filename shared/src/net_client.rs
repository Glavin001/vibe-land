//! The client's half of the game protocol: decoders for packets the server sends and encoders for
//! packets a client sends.
//!
//! One implementation for every client. The Unreal client links it natively (client-core); the web
//! client is moving onto it through WASM (it still has a TypeScript copy in
//! `client/src/net/protocol.ts`). The server's encoders and decoders live in
//! `server/src/protocol.rs`, whose tests round-trip every packet here against them.
//!
//! Decoders never panic: a short or malformed packet is a [`DecodeError`]. Every packet starts
//! with its kind byte (`constants::PKT_*`); [`decode_server_packet`] dispatches on it and hands
//! back the city stream's packets (wire 4 and friends) untouched for their own decoders.

use crate::constants::*;
use crate::protocol::*;
use crate::unit_conv::{angle_to_i16, f32_to_snorm16};

/// `GET /session-config?match_id=…` (server: `SessionConfig` in `server/src/main.rs`). Fields a
/// server may omit are optional; older servers that omit `city_wire_version` speak wire 2.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct SessionConfig {
    pub match_id: String,
    /// The WebTransport URL (`…/game`).
    pub url: String,
    /// SHA-256 of the server's self-signed certificate, hex; empty when the certificate is CA
    /// signed (then the client validates it normally instead of pinning).
    #[serde(default)]
    pub server_certificate_hash_hex: String,
    pub sim_hz: u16,
    pub snapshot_hz: u16,
    pub interpolation_delay_ms: u16,
    pub protocol_version: u16,
    #[serde(default)]
    pub physics_backend: u8,
    #[serde(default)]
    pub client_movement_mode: u8,
    #[serde(default)]
    pub city_world: bool,
    /// SHA-256 (hex) of the uncompressed city manifest, for `GET /city-manifest/:hash`.
    #[serde(default)]
    pub city_manifest_hash: Option<String>,
    #[serde(default)]
    pub city_wire_version: Option<u8>,
}

impl SessionConfig {
    pub fn from_json(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    /// The city stream version this match speaks (2 when the server predates the field).
    pub fn city_wire(&self) -> u8 {
        self.city_wire_version.unwrap_or(2)
    }
}

/// Why a server packet could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The packet was empty.
    Empty,
    /// The packet ended before a field it must contain.
    Truncated { kind: u8, needed: usize, remaining: usize },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Empty => write!(f, "empty packet"),
            DecodeError::Truncated { kind, needed, remaining } => {
                write!(f, "packet kind {kind} truncated: needed {needed} more bytes, {remaining} left")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// A server packet as the client sees it.
#[derive(Clone, Debug)]
pub enum ServerMessage {
    Welcome(WelcomePacket),
    SnapshotV2(SnapshotV2Packet),
    PlayerRoster(PlayerRosterPacket),
    /// To the shooter: how the server resolved one of its shots.
    ShotResult(ShotResultPacket),
    /// To everyone: a hitscan shot the server resolved (origin and end, for tracers).
    ShotFired(ShotFiredPacket),
    /// To the victim: who hit it, how hard, from where.
    DamageEvent(DamageEventPacket),
    /// The local player's energy (hundredths).
    LocalPlayerEnergy(LocalPlayerEnergyPacket),
    /// Shapes of the snapshot's dynamic bodies (cannonballs, meteors), by handle.
    DynamicBodyMeta(DynamicBodyMetaPacket),
    /// The server's latency probe; echo the nonce back with [`encode_ping`].
    Ping(u32),
    Pong(u32),
    /// A packet this module leaves to another decoder (the city stream, vehicles, effects), or one
    /// the client does not handle yet. `kind` is its first byte; the full packet is the caller's.
    Other { kind: u8 },
}

/// Decode one server packet (reliable or datagram: the server falls back to the reliable stream
/// for oversized datagrams, so a client must accept every kind on either lane).
pub fn decode_server_packet(bytes: &[u8]) -> Result<ServerMessage, DecodeError> {
    let (&kind, body) = bytes.split_first().ok_or(DecodeError::Empty)?;
    let mut r = Reader { bytes: body, kind };
    Ok(match kind {
        PKT_WELCOME => ServerMessage::Welcome(decode_welcome(&mut r)?),
        PKT_SNAPSHOT_V2 => ServerMessage::SnapshotV2(decode_snapshot_v2(&mut r)?),
        PKT_PLAYER_ROSTER => ServerMessage::PlayerRoster(decode_player_roster(&mut r)?),
        PKT_SHOT_RESULT => ServerMessage::ShotResult(ShotResultPacket {
            shot_id: r.u32()?,
            weapon: r.u8()?,
            confirmed: r.u8()? != 0,
            hit_player_id: r.u32()?,
            hit_zone: r.u8()?,
            server_resolution: r.u8()?,
            server_dynamic_body_id: r.u32()?,
            server_dynamic_hit_toi_cm: r.u16()?,
            server_dynamic_impulse_centi: r.u16()?,
        }),
        PKT_SHOT_FIRED => ServerMessage::ShotFired(ShotFiredPacket {
            shooter_player_id: r.u32()?,
            shot_id: r.u32()?,
            weapon: r.u8()?,
            hit_kind: r.u8()?,
            hit_zone: r.u8()?,
            server_fire_time_us: r.u64()?,
            origin_px_mm: r.i32()?,
            origin_py_mm: r.i32()?,
            origin_pz_mm: r.i32()?,
            end_px_mm: r.i32()?,
            end_py_mm: r.i32()?,
            end_pz_mm: r.i32()?,
        }),
        PKT_DAMAGE_EVENT => ServerMessage::DamageEvent(DamageEventPacket {
            attacker_player_id: r.u32()?,
            damage_amount: r.u8()?,
            hit_zone: r.u8()?,
            attacker_px_mm: r.i32()?,
            attacker_py_mm: r.i32()?,
            attacker_pz_mm: r.i32()?,
            server_time_ms: r.u32()?,
        }),
        PKT_LOCAL_PLAYER_ENERGY => ServerMessage::LocalPlayerEnergy(LocalPlayerEnergyPacket { energy_centi: r.u32()? }),
        PKT_DYNAMIC_BODY_META => {
            let count = r.u16()? as usize;
            let mut entries = Vec::with_capacity(count.min(1024));
            for _ in 0..count {
                entries.push(DynamicBodyMetaEntry {
                    handle: r.u16()?,
                    body_id: r.u32()?,
                    shape_type: r.u8()?,
                    hx_cm: r.u16()?,
                    hy_cm: r.u16()?,
                    hz_cm: r.u16()?,
                });
            }
            ServerMessage::DynamicBodyMeta(DynamicBodyMetaPacket { entries })
        }
        PKT_PING => ServerMessage::Ping(r.u32()?),
        PKT_PONG => ServerMessage::Pong(r.u32()?),
        _ => ServerMessage::Other { kind },
    })
}

fn decode_welcome(r: &mut Reader) -> Result<WelcomePacket, DecodeError> {
    Ok(WelcomePacket {
        player_id: r.u32()?,
        protocol_version: r.u16()?,
        physics_backend: r.u8()?,
        client_movement_mode: r.u8()?,
        sim_hz: r.u16()?,
        snapshot_hz: r.u16()?,
        server_time_us: r.u64()?,
        interpolation_delay_ms: r.u16()?,
    })
}

fn decode_player_roster(r: &mut Reader) -> Result<PlayerRosterPacket, DecodeError> {
    let count = r.u8()? as usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        entries.push(PlayerRosterEntry { handle: r.u8()?, player_id: r.u32()? });
    }
    Ok(PlayerRosterPacket { entries })
}

const REMOTE_PLAYER_BYTES: usize = 19;
const SPHERE_BYTES: usize = 20;
const BOX_BYTES: usize = 28;
const VEHICLE_BYTES: usize = 30;
const SELF_WITH_SUPPORT_BYTES: usize = 27;
const SELF_FULL_BYTES: usize = 33;

fn decode_snapshot_v2(r: &mut Reader) -> Result<SnapshotV2Packet, DecodeError> {
    let server_tick = r.u32()?;
    let ack_input_seq = r.u16()?;
    let anchor_px_mm = r.i32()?;
    let anchor_py_mm = r.i32()?;
    let anchor_pz_mm = r.i32()?;
    let remote_count = r.u8()? as usize;
    let sphere_count = r.u8()? as usize;
    let box_count = r.u8()? as usize;
    let vehicle_count = r.u8()? as usize;
    let entity_bytes = remote_count * REMOTE_PLAYER_BYTES
        + sphere_count * SPHERE_BYTES
        + box_count * BOX_BYTES
        + vehicle_count * VEHICLE_BYTES;

    // The self state is 33 bytes (support block with angular velocity), 27 (support block from
    // servers that predate angular velocity) or 12 (compact: no support block), told apart by the
    // bytes left after the entities -- exactly as the TypeScript decoder does.
    let left = r.remaining();
    let full = left >= SELF_FULL_BYTES + entity_bytes;
    let with_support = full || left >= SELF_WITH_SUPPORT_BYTES + entity_bytes;

    let mut self_state = SelfPlayerStateV2 {
        vx_cms: r.i16()?,
        vy_cms: r.i16()?,
        vz_cms: r.i16()?,
        yaw_i16: r.i16()?,
        pitch_i16: r.i16()?,
        hp: r.u8()?,
        flags: r.u8()?,
        ..Default::default()
    };
    if with_support {
        self_state.support_handle = r.u16()?;
        self_state.support_local_q2_5mm = [r.i16()?, r.i16()?, r.i16()?];
        self_state.support_velocity_cms = [r.i16()?, r.i16()?, r.i16()?];
        self_state.support_flags = r.u8()?;
    }
    if full {
        self_state.support_angular_velocity_mrads = [r.i16()?, r.i16()?, r.i16()?];
    }

    let mut remote_players = Vec::with_capacity(remote_count);
    for _ in 0..remote_count {
        remote_players.push(RemotePlayerStateV2 {
            handle: r.u8()?,
            dx_q2_5mm: r.i16()?,
            dy_q2_5mm: r.i16()?,
            dz_q2_5mm: r.i16()?,
            vx_cms: r.i16()?,
            vy_cms: r.i16()?,
            vz_cms: r.i16()?,
            yaw_i16: r.i16()?,
            pitch_i16: r.i16()?,
            hp: r.u8()?,
            flags: r.u8()?,
        });
    }
    let mut sphere_states = Vec::with_capacity(sphere_count);
    for _ in 0..sphere_count {
        sphere_states.push(DynamicSphereStateV2 {
            handle: r.u16()?,
            dx_q2_5mm: r.i16()?,
            dy_q2_5mm: r.i16()?,
            dz_q2_5mm: r.i16()?,
            vx_cms: r.i16()?,
            vy_cms: r.i16()?,
            vz_cms: r.i16()?,
            wx_mrads: r.i16()?,
            wy_mrads: r.i16()?,
            wz_mrads: r.i16()?,
        });
    }
    let mut box_states = Vec::with_capacity(box_count);
    for _ in 0..box_count {
        box_states.push(DynamicBoxStateV2 {
            handle: r.u16()?,
            dx_q2_5mm: r.i16()?,
            dy_q2_5mm: r.i16()?,
            dz_q2_5mm: r.i16()?,
            qx_snorm: r.i16()?,
            qy_snorm: r.i16()?,
            qz_snorm: r.i16()?,
            qw_snorm: r.i16()?,
            vx_cms: r.i16()?,
            vy_cms: r.i16()?,
            vz_cms: r.i16()?,
            wx_mrads: r.i16()?,
            wy_mrads: r.i16()?,
            wz_mrads: r.i16()?,
        });
    }
    let mut vehicle_states = Vec::with_capacity(vehicle_count);
    for _ in 0..vehicle_count {
        vehicle_states.push(VehicleStateV2 {
            handle: r.u8()?,
            vehicle_type: r.u8()?,
            driver_handle: r.u8()?,
            flags: r.u8()?,
            dx_q2_5mm: r.i16()?,
            dy_q2_5mm: r.i16()?,
            dz_q2_5mm: r.i16()?,
            qx_snorm: r.i16()?,
            qy_snorm: r.i16()?,
            qz_snorm: r.i16()?,
            qw_snorm: r.i16()?,
            vx_cms: r.i16()?,
            vy_cms: r.i16()?,
            vz_cms: r.i16()?,
            wx_mrads: r.i16()?,
            wy_mrads: r.i16()?,
            wz_mrads: r.i16()?,
        });
    }

    // Optional tail, each part absent from older servers: the wall-clock trailer, then the
    // removals section, then the input-queue section.
    let mut packet = SnapshotV2Packet {
        server_tick,
        ack_input_seq,
        anchor_px_mm,
        anchor_py_mm,
        anchor_pz_mm,
        self_state,
        remote_players,
        sphere_states,
        box_states,
        vehicle_states,
        compact_self: !with_support,
        ..Default::default()
    };
    if r.remaining() >= SNAPSHOT_V2_TRAILER_BYTES {
        packet.server_wall_us = r.u32()?;
        if r.remaining() >= 2 && r.peek() == Some(SNAPSHOT_V2_REMOVALS_TAG) {
            r.u8()?;
            let count = r.u8()? as usize;
            if r.remaining() >= count * SNAPSHOT_V2_REMOVAL_BYTES {
                for _ in 0..count {
                    packet.removals.push(SnapshotRemoval { handle: r.u16()?, age_ticks: r.u8()? });
                }
            }
        }
        if r.remaining() >= 3 && r.peek() == Some(SNAPSHOT_V2_INPUT_QUEUE_TAG) {
            r.u8()?;
            packet.input_queue = Some((r.u8()?, r.u8()?));
        }
    }
    Ok(packet)
}

/// Movement capability bits a client advertises in its hello. A client that renders the server's
/// authoritative movement without predicting it (the Unreal client today) sends
/// [`CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE`], which PhysX servers require.
pub fn encode_client_hello(match_id: &str, movement_caps: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(6 + match_id.len());
    out.push(PKT_CLIENT_HELLO);
    out.extend_from_slice(&(match_id.len() as u16).to_le_bytes());
    out.extend_from_slice(match_id.as_bytes());
    out.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    out.push(movement_caps);
    out
}

/// A reliable-stream frame: `[u32 LE length][packet]`, the framing of every packet on the session's
/// bidirectional stream (the hello first).
pub fn frame_reliable(packet: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + packet.len());
    out.extend_from_slice(&(packet.len() as u32).to_le_bytes());
    out.extend_from_slice(packet);
    out
}

/// A ping datagram carrying `nonce`; also the echo a client sends back for a server ping.
pub fn encode_ping(nonce: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(5);
    out.push(PKT_PING);
    out.extend_from_slice(&nonce.to_le_bytes());
    out
}

/// A city resync request (full: no structure list). On wire 4 the server answers with a fresh
/// per-player bootstrap, restarting the stream; clients send it when their structure hashes
/// disagree with the server's, at most every few seconds.
pub fn encode_city_resync_request(last_topo_seq: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(5);
    out.push(PKT_CITY_RESYNC_REQUEST);
    out.extend_from_slice(&last_topo_seq.to_le_bytes());
    out
}

/// A meteor the server launched (`PKT_METEOR_LAUNCHED`, server/src/meteor.rs): its body (streamed
/// later as a snapshot sphere), who called it, and the ballistic arc a client draws until the body
/// is in its snapshots. Absolute floats in server space, metres and seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeteorLaunched {
    pub body_id: u32,
    pub shooter_player_id: u32,
    pub server_launch_time_us: u64,
    pub start: [f32; 3],
    pub velocity: [f32; 3],
    pub target: [f32; 3],
    pub radius_m: f32,
    /// Magnitude, downward.
    pub gravity_ms2: f32,
    pub flight_time_s: f32,
}

/// Decode a `PKT_METEOR_LAUNCHED` packet (it is routed with the city stream's kinds, so
/// [`decode_server_packet`] leaves it to this).
pub fn decode_meteor_launched(bytes: &[u8]) -> Result<MeteorLaunched, DecodeError> {
    let (&kind, body) = bytes.split_first().ok_or(DecodeError::Empty)?;
    let mut r = Reader { bytes: body, kind };
    let mut v3 = |r: &mut Reader| -> Result<[f32; 3], DecodeError> { Ok([r.f32()?, r.f32()?, r.f32()?]) };
    Ok(MeteorLaunched {
        body_id: r.u32()?,
        shooter_player_id: r.u32()?,
        server_launch_time_us: r.u64()?,
        start: v3(&mut r)?,
        velocity: v3(&mut r)?,
        target: v3(&mut r)?,
        radius_m: r.f32()?,
        gravity_ms2: r.f32()?,
        flight_time_s: r.f32()?,
    })
}

/// Drop the player at a pose (`PKT_CITY_CAMERA_DROP`, reliable stream): leaving the aerial camera
/// puts the player where the camera is. Server space; the server rate-limits it and rejects
/// non-finite or far-out poses.
pub fn encode_city_camera_drop(position: [f32; 3], yaw: f32, pitch: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(21);
    out.push(PKT_CITY_CAMERA_DROP);
    for v in position.into_iter().chain([yaw, pitch]) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// The most frames one input bundle carries (the count is a u8).
pub const INPUT_BUNDLE_MAX_FRAMES: usize = 255;

/// An input bundle: the newest `frames` (oldest first), 10 bytes each. Angles are quantised as the
/// server decodes them (`unit_conv::angle_to_i16`); at most [`INPUT_BUNDLE_MAX_FRAMES`] are sent
/// (the newest).
pub fn encode_input_bundle(frames: &[InputFrame]) -> Vec<u8> {
    let frames = &frames[frames.len().saturating_sub(INPUT_BUNDLE_MAX_FRAMES)..];
    let mut out = Vec::with_capacity(2 + frames.len() * 10);
    out.push(PKT_INPUT_BUNDLE);
    out.push(frames.len() as u8);
    for f in frames {
        out.extend_from_slice(&f.seq.to_le_bytes());
        out.extend_from_slice(&f.buttons.to_le_bytes());
        out.push(f.move_x as u8);
        out.push(f.move_y as u8);
        out.extend_from_slice(&angle_to_i16(f.yaw).to_le_bytes());
        out.extend_from_slice(&angle_to_i16(f.pitch).to_le_bytes());
    }
    out
}

/// A fire command. `dir` is a unit vector in server space (quantised to snorm16 per component);
/// `client_fire_time_us` is the client's estimate of the server clock at the shot, and the two
/// interpolation delays let the server rewind what the shooter saw (lag compensation).
pub fn encode_fire(cmd: &FireCmd) -> Vec<u8> {
    let mut out = Vec::with_capacity(26);
    out.push(PKT_FIRE);
    out.extend_from_slice(&cmd.seq.to_le_bytes());
    out.extend_from_slice(&cmd.shot_id.to_le_bytes());
    out.push(cmd.weapon);
    out.extend_from_slice(&cmd.client_fire_time_us.to_le_bytes());
    out.extend_from_slice(&cmd.client_interp_ms.to_le_bytes());
    out.extend_from_slice(&cmd.client_dynamic_interp_ms.to_le_bytes());
    for c in cmd.dir {
        out.extend_from_slice(&f32_to_snorm16(c).to_le_bytes());
    }
    out
}

/// A melee swing.
pub fn encode_melee(cmd: &MeleeCmd) -> Vec<u8> {
    let mut out = Vec::with_capacity(19);
    out.push(PKT_MELEE);
    out.extend_from_slice(&cmd.seq.to_le_bytes());
    out.extend_from_slice(&cmd.swing_id.to_le_bytes());
    out.extend_from_slice(&cmd.client_time_us.to_le_bytes());
    out.extend_from_slice(&angle_to_i16(cmd.yaw).to_le_bytes());
    out.extend_from_slice(&angle_to_i16(cmd.pitch).to_le_bytes());
    out
}

/// Ask to drive `vehicle_id` (seat 0, the driver).
pub fn encode_vehicle_enter(vehicle_id: u32, seat: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(6);
    out.push(PKT_VEHICLE_ENTER);
    out.extend_from_slice(&vehicle_id.to_le_bytes());
    out.push(seat);
    out
}

/// Leave `vehicle_id`.
pub fn encode_vehicle_exit(vehicle_id: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(5);
    out.push(PKT_VEHICLE_EXIT);
    out.extend_from_slice(&vehicle_id.to_le_bytes());
    out
}

/// A bounds-checked little-endian reader. Each read fails with [`DecodeError::Truncated`] instead
/// of panicking.
struct Reader<'a> {
    bytes: &'a [u8],
    kind: u8,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.first().copied()
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        if self.bytes.len() < N {
            return Err(DecodeError::Truncated { kind: self.kind, needed: N, remaining: self.bytes.len() });
        }
        let (head, tail) = self.bytes.split_at(N);
        self.bytes = tail;
        Ok(head.try_into().expect("split_at returned N bytes"))
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    fn i16(&mut self) -> Result<i16, DecodeError> {
        Ok(i16::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(i32::from_le_bytes(self.take()?))
    }
    fn f32(&mut self) -> Result<f32, DecodeError> {
        Ok(f32::from_le_bytes(self.take::<4>()?))
    }
    fn u64(&mut self) -> Result<u64, DecodeError> {
        Ok(u64::from_le_bytes(self.take()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_truncated_packets_are_errors_not_panics() {
        assert_eq!(decode_server_packet(&[]).unwrap_err(), DecodeError::Empty);
        for len in 1..23 {
            let mut welcome = vec![0u8; len];
            welcome[0] = PKT_WELCOME;
            assert!(matches!(decode_server_packet(&welcome), Err(DecodeError::Truncated { kind: PKT_WELCOME, .. })), "len {len}");
        }
        for len in 1..34 {
            let mut snapshot = vec![0u8; len];
            snapshot[0] = PKT_SNAPSHOT_V2;
            assert!(decode_server_packet(&snapshot).is_err(), "len {len}");
        }
    }

    #[test]
    fn unknown_kinds_pass_through() {
        // 132 is perplayer::wire::PKT_PP_KEYFRAMES (shared does not depend on perplayer).
        assert!(matches!(decode_server_packet(&[132, 1, 2, 3]), Ok(ServerMessage::Other { kind: 132 })));
    }

    #[test]
    fn session_config_parses_a_live_server_response() {
        // Captured from a synthetic-city server, 2026-10-17.
        let json = br#"{"match_id":"citypp-m0","url":"https://127.0.0.1:4102/game",
            "server_certificate_hash_hex":"0483035904f4ae6e906fe0fbbe4f5e1767b3fa1b34bbb274db906bbc5995e893",
            "sim_hz":60,"snapshot_hz":30,"interpolation_delay_ms":66,"protocol_version":3,
            "physics_backend":0,"client_movement_mode":0,"city_world":true,
            "city_manifest_hash":"52d5f0d373f33a06ae44eaf7f2620c07ee82a0d19f6c6a077996e2dba8388269",
            "city_wire_version":4}"#;
        let config = SessionConfig::from_json(json).unwrap();
        assert_eq!(config.city_wire(), 4);
        assert_eq!(config.url, "https://127.0.0.1:4102/game");
        assert_eq!(config.snapshot_hz, 30);
        let older = br#"{"match_id":"m","url":"u","sim_hz":60,"snapshot_hz":30,"interpolation_delay_ms":66,"protocol_version":3}"#;
        assert_eq!(SessionConfig::from_json(older).unwrap().city_wire(), 2);
    }

    #[test]
    fn hello_layout() {
        let hello = encode_client_hello("citypp-x", CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE);
        assert_eq!(hello[0], PKT_CLIENT_HELLO);
        assert_eq!(u16::from_le_bytes([hello[1], hello[2]]), 8);
        assert_eq!(&hello[3..11], b"citypp-x");
        assert_eq!(u16::from_le_bytes([hello[11], hello[12]]), PROTOCOL_VERSION);
        assert_eq!(hello[13], CLIENT_MOVEMENT_CAP_THIN_AUTHORITATIVE);
        let framed = frame_reliable(&hello);
        assert_eq!(u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize, hello.len());
    }
}
