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
    /// Energy batteries in the world (dropped on death): changed or all of them, and removals.
    BatterySync(crate::protocol::BatterySyncPacket),
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
        PKT_BATTERY_SYNC => {
            // protocol.ts decodeBatterySyncPacket: flag, counts, 24-byte states, removed ids.
            let full_resync = r.u8()? != 0;
            let (states, removed) = (r.u16()? as usize, r.u16()? as usize);
            let mut battery_states = Vec::with_capacity(states.min(4096));
            for _ in 0..states {
                battery_states.push(crate::protocol::NetBatteryState {
                    id: r.u32()?,
                    px_mm: r.i32()?,
                    py_mm: r.i32()?,
                    pz_mm: r.i32()?,
                    energy_centi: r.u32()?,
                    radius_cm: r.u16()?,
                    height_cm: r.u16()?,
                });
            }
            let mut removed_ids = Vec::with_capacity(removed.min(4096));
            for _ in 0..removed {
                removed_ids.push(r.u32()?);
            }
            ServerMessage::BatterySync(crate::protocol::BatterySyncPacket { full_resync, battery_states, removed_ids })
        }
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

/// Welcome body bytes from servers that send protocol version, physics backend and movement mode
/// (22; the packet is 23 with its kind byte). Older servers send 18 and are protocol 1, Rapier, full
/// prediction (as the TypeScript decoder reads them).
const WELCOME_WITH_CAPABILITIES_BYTES: usize = 22;

fn decode_welcome(r: &mut Reader) -> Result<WelcomePacket, DecodeError> {
    let player_id = r.u32()?;
    let (protocol_version, physics_backend, client_movement_mode) = if r.remaining() + 4 >= WELCOME_WITH_CAPABILITIES_BYTES {
        (r.u16()?, r.u8()?, r.u8()?)
    } else {
        (1, PHYSICS_BACKEND_RAPIER, CLIENT_MOVEMENT_FULL_PREDICTION)
    };
    Ok(WelcomePacket {
        player_id,
        protocol_version,
        physics_backend,
        client_movement_mode,
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

/// A reliable server packet (kind byte included) as its kind and wire integers, for the web
/// (`client/src/net/sharedDecode.ts`), or `None` for a kind this module does not decode (the web
/// keeps its own decoder for those). After the kind, in wire order:
/// Welcome: player id, protocol version, physics backend, movement mode, sim Hz, snapshot Hz,
/// server time µs, interpolation delay ms. ShotResult: shot id, weapon, confirmed (0/1), hit
/// player, hit zone, resolution, dynamic body id, hit TOI cm, impulse centi. ShotFired: shooter,
/// shot id, weapon, hit kind, hit zone, fire time µs, origin mm ×3, end mm ×3. DamageEvent:
/// attacker, damage, hit zone, attacker mm ×3, server time ms. LocalPlayerEnergy: energy centi.
/// PlayerRoster: count, then (handle, player id) each. DynamicBodyMeta: count, then (handle, body
/// id, shape, half extents cm ×3) each. Ping, Pong: the value.
pub fn server_packet_flat(bytes: &[u8]) -> Result<Option<Vec<f64>>, DecodeError> {
    let kind = f64::from(*bytes.first().ok_or(DecodeError::Empty)?);
    Ok(Some(match decode_server_packet(bytes)? {
        ServerMessage::Welcome(w) => vec![
            kind,
            f64::from(w.player_id),
            f64::from(w.protocol_version),
            f64::from(w.physics_backend),
            f64::from(w.client_movement_mode),
            f64::from(w.sim_hz),
            f64::from(w.snapshot_hz),
            w.server_time_us as f64,
            f64::from(w.interpolation_delay_ms),
        ],
        ServerMessage::ShotResult(s) => vec![
            kind,
            f64::from(s.shot_id),
            f64::from(s.weapon),
            f64::from(u8::from(s.confirmed)),
            f64::from(s.hit_player_id),
            f64::from(s.hit_zone),
            f64::from(s.server_resolution),
            f64::from(s.server_dynamic_body_id),
            f64::from(s.server_dynamic_hit_toi_cm),
            f64::from(s.server_dynamic_impulse_centi),
        ],
        ServerMessage::ShotFired(s) => vec![
            kind,
            f64::from(s.shooter_player_id),
            f64::from(s.shot_id),
            f64::from(s.weapon),
            f64::from(s.hit_kind),
            f64::from(s.hit_zone),
            s.server_fire_time_us as f64,
            f64::from(s.origin_px_mm),
            f64::from(s.origin_py_mm),
            f64::from(s.origin_pz_mm),
            f64::from(s.end_px_mm),
            f64::from(s.end_py_mm),
            f64::from(s.end_pz_mm),
        ],
        ServerMessage::DamageEvent(d) => vec![
            kind,
            f64::from(d.attacker_player_id),
            f64::from(d.damage_amount),
            f64::from(d.hit_zone),
            f64::from(d.attacker_px_mm),
            f64::from(d.attacker_py_mm),
            f64::from(d.attacker_pz_mm),
            f64::from(d.server_time_ms),
        ],
        ServerMessage::LocalPlayerEnergy(e) => vec![kind, f64::from(e.energy_centi)],
        ServerMessage::PlayerRoster(r) => {
            let mut out = vec![kind, r.entries.len() as f64];
            for e in &r.entries {
                out.extend([f64::from(e.handle), f64::from(e.player_id)]);
            }
            out
        }
        ServerMessage::DynamicBodyMeta(m) => {
            let mut out = vec![kind, m.entries.len() as f64];
            for e in &m.entries {
                out.extend([f64::from(e.handle), f64::from(e.body_id), f64::from(e.shape_type)]);
                out.extend([e.hx_cm, e.hy_cm, e.hz_cm].map(f64::from));
            }
            out
        }
        ServerMessage::Ping(v) | ServerMessage::Pong(v) => vec![kind, f64::from(v)],
        ServerMessage::SnapshotV2(_) | ServerMessage::BatterySync(_) | ServerMessage::Other { .. } => return Ok(None),
    }))
}

/// Layout of [`snapshot_v2_flat`]: the header slots, then the self state, then each list.
pub const SNAPSHOT_V2_FLAT_HEADER: usize = 13;
pub const SNAPSHOT_V2_FLAT_SELF: usize = 18;
pub const SNAPSHOT_V2_FLAT_REMOTE: usize = 11;
pub const SNAPSHOT_V2_FLAT_SPHERE: usize = 10;
pub const SNAPSHOT_V2_FLAT_BOX: usize = 14;
pub const SNAPSHOT_V2_FLAT_VEHICLE: usize = 17;
pub const SNAPSHOT_V2_FLAT_REMOVAL: usize = 2;

/// A SnapshotV2 packet (kind byte included) as one flat array of its wire integers, for a client
/// that builds its own objects from it (the web: `client/src/net/sharedDecode.ts`). Every value is
/// the integer the wire carries (no unit conversion), so a reader that converts as the TypeScript
/// decoder does gets bit-identical numbers.
///
/// Header (`SNAPSHOT_V2_FLAT_HEADER` slots): server tick, ack input seq, anchor x/y/z mm, server
/// wall µs (-1 when the packet has no trailer), counts of remote players, spheres, boxes,
/// vehicles, removals (-1 when the packet has no removals section), input-queue depth and target
/// (-1 when absent). Then the self state (vx vy vz yaw pitch hp flags, support handle, local
/// q2.5 mm ×3, velocity cm/s ×3, flags, angular mrad/s ×3), then each list in wire field order,
/// then the removals (raw handle, age ticks).
pub fn snapshot_v2_flat(bytes: &[u8]) -> Result<Vec<f64>, DecodeError> {
    let ServerMessage::SnapshotV2(s) = decode_server_packet(bytes)? else {
        return Err(DecodeError::Truncated { kind: bytes.first().copied().unwrap_or(0), needed: 1, remaining: 0 });
    };
    // Which optional tail parts the packet carries: the decoder reads each exactly when these hold
    // (`decode_snapshot_v2`), and absent parts leave defaults the web must not see as values.
    let entities = s.remote_players.len() * REMOTE_PLAYER_BYTES
        + s.sphere_states.len() * SPHERE_BYTES
        + s.box_states.len() * BOX_BYTES
        + s.vehicle_states.len() * VEHICLE_BYTES;
    let header = 1 + 4 + 2 + 12 + 4;
    let left = bytes.len() - header;
    let self_len = if left >= SELF_FULL_BYTES + entities {
        SELF_FULL_BYTES
    } else if left >= SELF_WITH_SUPPORT_BYTES + entities {
        SELF_WITH_SUPPORT_BYTES
    } else {
        SNAPSHOT_V2_COMPACT_SELF_PLAYER_BYTES
    };
    let trailer_at = header + self_len + entities;
    let has_trailer = bytes.len() >= trailer_at + SNAPSHOT_V2_TRAILER_BYTES;
    let tail = trailer_at + SNAPSHOT_V2_TRAILER_BYTES;
    let has_removals = has_trailer
        && bytes.len() >= tail + 2
        && bytes[tail] == SNAPSHOT_V2_REMOVALS_TAG
        && bytes.len() - (tail + 2) >= usize::from(bytes[tail + 1]) * SNAPSHOT_V2_REMOVAL_BYTES;

    let mut out = Vec::with_capacity(
        SNAPSHOT_V2_FLAT_HEADER
            + SNAPSHOT_V2_FLAT_SELF
            + s.remote_players.len() * SNAPSHOT_V2_FLAT_REMOTE
            + s.sphere_states.len() * SNAPSHOT_V2_FLAT_SPHERE
            + s.box_states.len() * SNAPSHOT_V2_FLAT_BOX
            + s.vehicle_states.len() * SNAPSHOT_V2_FLAT_VEHICLE
            + s.removals.len() * SNAPSHOT_V2_FLAT_REMOVAL,
    );
    let (depth, target) = s.input_queue.map_or((-1.0, -1.0), |(d, t)| (f64::from(d), f64::from(t)));
    out.extend_from_slice(&[
        f64::from(s.server_tick),
        f64::from(s.ack_input_seq),
        f64::from(s.anchor_px_mm),
        f64::from(s.anchor_py_mm),
        f64::from(s.anchor_pz_mm),
        if has_trailer { f64::from(s.server_wall_us) } else { -1.0 },
        s.remote_players.len() as f64,
        s.sphere_states.len() as f64,
        s.box_states.len() as f64,
        s.vehicle_states.len() as f64,
        if has_removals { s.removals.len() as f64 } else { -1.0 },
        depth,
        target,
    ]);
    let st = &s.self_state;
    out.extend([st.vx_cms, st.vy_cms, st.vz_cms, st.yaw_i16, st.pitch_i16].map(f64::from));
    out.extend([f64::from(st.hp), f64::from(st.flags), f64::from(st.support_handle)]);
    out.extend(st.support_local_q2_5mm.map(f64::from));
    out.extend(st.support_velocity_cms.map(f64::from));
    out.push(f64::from(st.support_flags));
    out.extend(st.support_angular_velocity_mrads.map(f64::from));
    for p in &s.remote_players {
        out.push(f64::from(p.handle));
        out.extend([p.dx_q2_5mm, p.dy_q2_5mm, p.dz_q2_5mm, p.vx_cms, p.vy_cms, p.vz_cms, p.yaw_i16, p.pitch_i16].map(f64::from));
        out.extend([f64::from(p.hp), f64::from(p.flags)]);
    }
    for b in &s.sphere_states {
        out.push(f64::from(b.handle));
        out.extend([b.dx_q2_5mm, b.dy_q2_5mm, b.dz_q2_5mm, b.vx_cms, b.vy_cms, b.vz_cms, b.wx_mrads, b.wy_mrads, b.wz_mrads].map(f64::from));
    }
    for b in &s.box_states {
        out.push(f64::from(b.handle));
        out.extend(
            [b.dx_q2_5mm, b.dy_q2_5mm, b.dz_q2_5mm, b.qx_snorm, b.qy_snorm, b.qz_snorm, b.qw_snorm, b.vx_cms, b.vy_cms, b.vz_cms, b.wx_mrads, b.wy_mrads, b.wz_mrads]
                .map(f64::from),
        );
    }
    for v in &s.vehicle_states {
        out.extend([v.handle, v.vehicle_type, v.driver_handle, v.flags].map(f64::from));
        out.extend(
            [v.dx_q2_5mm, v.dy_q2_5mm, v.dz_q2_5mm, v.qx_snorm, v.qy_snorm, v.qz_snorm, v.qw_snorm, v.vx_cms, v.vy_cms, v.vz_cms, v.wx_mrads, v.wy_mrads, v.wz_mrads]
                .map(f64::from),
        );
    }
    if has_removals {
        for r in &s.removals {
            out.extend([f64::from(r.handle), f64::from(r.age_ticks)]);
        }
    }
    Ok(out)
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

/// A car's asset, announced on the reliable stream (`PKT_VEHICLE_ASSET`, server
/// `vehicle_assets::asset_packet`: JSON `{handle, vehicle: PreparedVehicle}` after the kind byte).
/// Its geometry is `GET /vehicle-assets/<geometry_hash>/metadata.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct VehicleAsset {
    pub handle: u8,
    pub geometry_hash: String,
    pub asset_hash: String,
    /// The car's configuration (model, appearance, ...), as JSON.
    pub configuration: serde_json::Value,
    /// The server's prepared driving setup (acceleration, topSpeed, tyreFriction, maxSteerRadians,
    /// steeringResponse, ...: `PreparedDriving`), as JSON; null when absent.
    pub driving: serde_json::Value,
}

/// Decode a `PKT_VEHICLE_ASSET` packet.
pub fn decode_vehicle_asset(bytes: &[u8]) -> Result<VehicleAsset, DecodeError> {
    let (&kind, body) = bytes.split_first().ok_or(DecodeError::Empty)?;
    let malformed = || DecodeError::Truncated { kind, needed: body.len() + 1, remaining: body.len() };
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|_| malformed())?;
    let handle = value.get("handle").and_then(serde_json::Value::as_u64).and_then(|h| u8::try_from(h).ok()).ok_or_else(malformed)?;
    let vehicle = value.get("vehicle").ok_or_else(malformed)?;
    let text = |key: &str| vehicle.get(key).and_then(serde_json::Value::as_str).map(str::to_owned);
    Ok(VehicleAsset {
        handle,
        geometry_hash: text("geometryHash").ok_or_else(malformed)?,
        asset_hash: text("assetHash").unwrap_or_default(),
        configuration: vehicle.get("configuration").cloned().unwrap_or(serde_json::Value::Null),
        driving: vehicle.get("driving").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// One wheel of a [`VehicleRig`]: suspension travel (m), steer and spin angles (rad), on the ground.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RigWheel {
    pub travel_m: f32,
    pub steer_rad: f32,
    pub rotation_rad: f32,
    pub grounded: bool,
}

/// A car's wheel states (`PKT_VEHICLE_RIG`, server `vehicle_assets::rig_packet`): the server tick,
/// the car's handle and its four wheels. Detached-part groups may follow (not decoded here).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VehicleRig {
    pub server_tick: u32,
    pub handle: u8,
    pub wheels: [RigWheel; 4],
}

/// Decode a `PKT_VEHICLE_RIG` packet's fixed 58-byte part.
pub fn decode_vehicle_rig(bytes: &[u8]) -> Result<VehicleRig, DecodeError> {
    let (&kind, body) = bytes.split_first().ok_or(DecodeError::Empty)?;
    let mut r = Reader { bytes: body, kind };
    let server_tick = r.u32()?;
    let handle = r.u8()?;
    let mut wheels = [RigWheel::default(); 4];
    for w in &mut wheels {
        *w = RigWheel { travel_m: r.f32()?, steer_rad: r.f32()?, rotation_rad: r.f32()?, grounded: r.u8()? != 0 };
    }
    Ok(VehicleRig { server_tick, handle, wheels })
}

/// One contact the server judged audible (`PKT_AUDIO_CONTACTS`, server `contact_audio.rs`):
/// the two entities, impact (0) or scrape (1), where, the surface normal, the speeds into and
/// along it (m/s), a perceptual intensity in [0, 1] and size (cube root of the reduced mass in
/// tonnes).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AudioContact {
    pub entity_a: u32,
    pub entity_b: u32,
    pub kind: u8,
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub normal_speed: f32,
    pub tangent_speed: f32,
    pub intensity: f32,
    pub size: f32,
}

/// Decode a `PKT_AUDIO_CONTACTS` datagram: `[kind][version 1][count][0][u32 tick]` then
/// `count` 52-byte records.
pub fn decode_audio_contacts(bytes: &[u8]) -> Result<(u32, Vec<AudioContact>), DecodeError> {
    let (&kind, body) = bytes.split_first().ok_or(DecodeError::Empty)?;
    let mut r = Reader { bytes: body, kind };
    let _version = r.u8()?;
    let count = r.u8()? as usize;
    let _reserved = r.u8()?;
    let tick = r.u32()?;
    let mut contacts = Vec::with_capacity(count);
    for _ in 0..count {
        let entity_a = r.u32()?;
        let entity_b = r.u32()?;
        let kind = r.u8()?;
        let _ = (r.u8()?, r.u16()?);
        let mut f = [0.0f32; 10];
        for v in &mut f {
            *v = r.f32()?;
        }
        contacts.push(AudioContact {
            entity_a,
            entity_b,
            kind,
            position: [f[0], f[1], f[2]],
            normal: [f[3], f[4], f[5]],
            normal_speed: f[6],
            tangent_speed: f[7],
            intensity: f[8],
            size: f[9],
        });
    }
    Ok((tick, contacts))
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

// ── Client quantisation, exactly as the web client does it ───
// client/src/net/protocol.ts quantises in f64 with JavaScript's rounding and integer conversions;
// these reproduce it bit for bit, so the Unreal client (f32 values, widened exactly) and the web
// (through the shared WASM, `encode_*_js`) send the same bytes for the same inputs.

/// JavaScript's ToInt32: truncate, wrap modulo 2^32; NaN and infinities are 0.
pub fn js_to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc().rem_euclid(4_294_967_296.0);
    (if m >= 2_147_483_648.0 { m - 4_294_967_296.0 } else { m }) as i32
}

/// JavaScript's `Math.round`: halves toward +∞.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `angleToI16`: the angle's turn fraction on 0..65535, as the server's `i16_to_angle` reads it.
pub fn client_angle_i16(angle_rad: f64) -> i16 {
    let tau = std::f64::consts::PI * 2.0;
    let normalized = (((angle_rad % tau) + tau) % tau) / tau * 65535.0;
    (js_to_int32(js_round(normalized)) & 0xffff) as u16 as i16
}

/// `f32ToSnorm16`, written as `setInt16` writes it.
pub fn client_snorm16(value: f64) -> i16 {
    let clamped = if value.is_nan() { value } else { value.clamp(-1.0, 1.0) };
    js_to_int32(js_round(clamped * 32767.0)) as i16
}

/// `clampI8`, written as `setInt8` writes it.
pub fn client_i8(value: f64) -> i8 {
    let r = js_round(value);
    let clamped = if r.is_nan() { r } else { r.clamp(-127.0, 127.0) };
    js_to_int32(clamped) as i8
}

/// `setUint64` of a JavaScript number: floored, at least 0, the low and high 32-bit words.
pub fn js_u64(value: f64) -> u64 {
    let n = if value.is_nan() { 0.0 } else { value.floor().max(0.0) };
    let low = js_to_int32(n) as u32;
    let high = js_to_int32((n / 4_294_967_296.0).floor()) as u32;
    (u64::from(high) << 32) | u64::from(low)
}

/// A JavaScript number masked as `x & 0xffff`.
fn js_u16(x: f64) -> u16 {
    (js_to_int32(x) & 0xffff) as u16
}

/// An input bundle from the web's numbers (`encodeInputBundle`): six per frame, (seq, buttons,
/// moveX, moveY, yaw, pitch). Errors as the web's does on an empty or over-255-frame bundle.
pub fn encode_input_bundle_js(frames: &[f64]) -> Result<Vec<u8>, &'static str> {
    let count = frames.len() / 6;
    if count == 0 {
        return Err("input bundle cannot be empty");
    }
    if count > 255 {
        return Err("input bundle too large");
    }
    let mut out = Vec::with_capacity(2 + count * 10);
    out.push(PKT_INPUT_BUNDLE);
    out.push(count as u8);
    for f in frames.chunks_exact(6) {
        out.extend_from_slice(&js_u16(f[0]).to_le_bytes());
        out.extend_from_slice(&js_u16(f[1]).to_le_bytes());
        out.push(client_i8(f[2]) as u8);
        out.push(client_i8(f[3]) as u8);
        out.extend_from_slice(&client_angle_i16(f[4]).to_le_bytes());
        out.extend_from_slice(&client_angle_i16(f[5]).to_le_bytes());
    }
    Ok(out)
}

/// A fire command from the web's numbers (`encodeFirePacket`).
#[allow(clippy::too_many_arguments)]
pub fn encode_fire_js(seq: f64, shot_id: f64, weapon: f64, client_fire_time_us: f64, interp_ms: f64, dynamic_interp_ms: f64, dir: [f64; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(26);
    out.push(PKT_FIRE);
    out.extend_from_slice(&js_u16(seq).to_le_bytes());
    out.extend_from_slice(&(js_to_int32(shot_id) as u32).to_le_bytes());
    out.push((js_to_int32(weapon) & 0xff) as u8);
    out.extend_from_slice(&js_u64(client_fire_time_us).to_le_bytes());
    out.extend_from_slice(&js_u16(interp_ms).to_le_bytes());
    out.extend_from_slice(&js_u16(dynamic_interp_ms).to_le_bytes());
    for c in dir {
        out.extend_from_slice(&client_snorm16(c).to_le_bytes());
    }
    out
}

/// A melee swing from the web's numbers (`encodeMeleePacket`).
pub fn encode_melee_js(seq: f64, swing_id: f64, client_time_us: f64, yaw: f64, pitch: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(19);
    out.push(PKT_MELEE);
    out.extend_from_slice(&js_u16(seq).to_le_bytes());
    out.extend_from_slice(&(js_to_int32(swing_id) as u32).to_le_bytes());
    out.extend_from_slice(&js_u64(client_time_us).to_le_bytes());
    out.extend_from_slice(&client_angle_i16(yaw).to_le_bytes());
    out.extend_from_slice(&client_angle_i16(pitch).to_le_bytes());
    out
}

/// A client hello from the web's values (`encodeClientHello`).
pub fn encode_client_hello_js(match_id: &str, protocol_version: f64, movement_caps: f64) -> Vec<u8> {
    let mut out = Vec::with_capacity(6 + match_id.len());
    out.push(PKT_CLIENT_HELLO);
    out.extend_from_slice(&js_u16(match_id.len() as f64).to_le_bytes());
    out.extend_from_slice(match_id.as_bytes());
    out.extend_from_slice(&js_u16(protocol_version).to_le_bytes());
    out.push((js_to_int32(movement_caps) & 0xff) as u8);
    out
}

/// The web's `>>> 0` of a JavaScript number.
pub fn js_u32(x: f64) -> u32 {
    js_to_int32(x) as u32
}

/// The most frames one input bundle carries (the count is a u8).
pub const INPUT_BUNDLE_MAX_FRAMES: usize = 255;

/// An input bundle: the newest `frames` (oldest first), 10 bytes each. Angles are quantised for the
/// server's `unit_conv::i16_to_angle` exactly as the web client quantises them ([`client_angle_i16`]);
/// at most [`INPUT_BUNDLE_MAX_FRAMES`] are sent (the newest).
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
        out.extend_from_slice(&client_angle_i16(f64::from(f.yaw)).to_le_bytes());
        out.extend_from_slice(&client_angle_i16(f64::from(f.pitch)).to_le_bytes());
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
        out.extend_from_slice(&client_snorm16(f64::from(c)).to_le_bytes());
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
    out.extend_from_slice(&client_angle_i16(f64::from(cmd.yaw)).to_le_bytes());
    out.extend_from_slice(&client_angle_i16(f64::from(cmd.pitch)).to_le_bytes());
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
        // Under 19 bytes a Welcome is truncated; 19 to 22 is the pre-capabilities layout.
        for len in 1..19 {
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
    fn a_welcome_without_capabilities_is_protocol_1_rapier_full_prediction() {
        // The layout servers sent before protocol version, backend and movement mode (19 bytes),
        // read as the TypeScript decoder reads it.
        let mut w = vec![PKT_WELCOME];
        w.extend(7u32.to_le_bytes());
        w.extend(60u16.to_le_bytes());
        w.extend(30u16.to_le_bytes());
        w.extend(123_456u64.to_le_bytes());
        w.extend(50u16.to_le_bytes());
        let ServerMessage::Welcome(p) = decode_server_packet(&w).unwrap() else { panic!() };
        assert_eq!(
            p,
            WelcomePacket {
                player_id: 7,
                protocol_version: 1,
                physics_backend: PHYSICS_BACKEND_RAPIER,
                client_movement_mode: CLIENT_MOVEMENT_FULL_PREDICTION,
                sim_hz: 60,
                snapshot_hz: 30,
                server_time_us: 123_456,
                interpolation_delay_ms: 50,
            }
        );
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
