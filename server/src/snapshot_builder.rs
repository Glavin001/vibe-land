//! The per-recipient game snapshot: interest, byte budget, quantisation and
//! packet assembly for players, vehicles and non-city dynamic bodies.
//!
//! This is the body of `MatchState::broadcast_snapshot`'s per-recipient loop,
//! lifted out unchanged so that two callers run the same code:
//!
//! - the live match, which gathers the world from the physics arena once per
//!   snapshot tick and calls [`build_recipient_snapshot`] for every player;
//! - Netlab v2 (`src/bin/netlab2`), which rebuilds the same inputs from a
//!   session capture's frozen truth (`world.bin` + `snapshot-inputs.jsonl`)
//!   and calls the same function offline.
//!
//! Everything the function reads is in its arguments; everything it keeps
//! between ticks for one recipient is in [`RecipientInterest`]. Nothing here
//! touches the arena, the clock, the transport or the stats -- the caller
//! encodes, counts and queues the packet it returns.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::protocol::{
    self, cms_to_mps, f32_to_snorm16, NetDynamicBodyState, NetPlayerState, NetVehicleState,
    ServerPacket, SnapshotPacket,
};
use crate::session_capture::SnapshotSelection;
use vibe_land_shared::constants::{
    DYNAMIC_BODY_AOI_EXIT_RADIUS_M, DYNAMIC_BODY_AOI_RADIUS_M, PLAYER_AOI_RADIUS_M, SHAPE_SPHERE,
    SIM_HZ, VEHICLE_AOI_RADIUS_M,
};

pub const COLD_VEHICLE_REFRESH_TICKS: u32 = SIM_HZ as u32 / 2;
pub const COLD_DYNAMIC_REFRESH_TICKS: u32 = SIM_HZ as u32;
pub const HOT_LINEAR_SPEED_THRESHOLD_MPS: f32 = 0.05;
pub const HOT_ANGULAR_SPEED_THRESHOLD_RADPS: f32 = 0.05;
pub const HOT_DYNAMIC_NEAR_RADIUS_M: f32 = 12.0;
pub const STRICT_SNAPSHOT_DATAGRAM_TARGET_BYTES: usize = 1100;
pub const STRICT_SNAPSHOT_RESERVED_VEHICLES: usize = 2;
pub const SNAPSHOT_V2_HEADER_BYTES: usize = 23;
pub const SNAPSHOT_V2_SELF_PLAYER_BYTES: usize = 33;
pub const SNAPSHOT_V2_REMOTE_PLAYER_BYTES: usize = 19;
pub const SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES: usize = 20;
pub const SNAPSHOT_V2_DYNAMIC_BOX_BYTES: usize = 28;
pub const SNAPSHOT_V2_VEHICLE_BYTES: usize = 30;

/// The knobs of the snapshot selection. [`SnapshotConfig::PRODUCTION`] is
/// what the live server uses; Netlab v2 varies copies of it to price each
/// shortcut on identical frozen truth.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotConfig {
    /// Byte target of one V2 snapshot datagram, header included.
    pub datagram_target_bytes: usize,
    pub player_aoi_radius_m: f32,
    pub vehicle_aoi_radius_m: f32,
    pub dynamic_aoi_radius_m: f32,
    /// Hysteresis: a body already visible stays so out to this radius.
    pub dynamic_aoi_exit_radius_m: f32,
    /// Resting (cold) entities are resent at least this often.
    pub cold_vehicle_refresh_ticks: u32,
    pub cold_dynamic_refresh_ticks: u32,
    /// Speeds above which an entity is hot (sent every snapshot it fits).
    pub hot_linear_speed_mps: f32,
    pub hot_angular_speed_radps: f32,
    /// Bodies nearer than this are always hot.
    pub hot_dynamic_near_radius_m: f32,
    /// Vehicles the recipient drives, reserved ahead of the budget.
    pub reserved_vehicles: usize,
}

impl SnapshotConfig {
    pub const PRODUCTION: Self = Self {
        datagram_target_bytes: STRICT_SNAPSHOT_DATAGRAM_TARGET_BYTES,
        player_aoi_radius_m: PLAYER_AOI_RADIUS_M,
        vehicle_aoi_radius_m: VEHICLE_AOI_RADIUS_M,
        dynamic_aoi_radius_m: DYNAMIC_BODY_AOI_RADIUS_M,
        dynamic_aoi_exit_radius_m: DYNAMIC_BODY_AOI_EXIT_RADIUS_M,
        cold_vehicle_refresh_ticks: COLD_VEHICLE_REFRESH_TICKS,
        cold_dynamic_refresh_ticks: COLD_DYNAMIC_REFRESH_TICKS,
        hot_linear_speed_mps: HOT_LINEAR_SPEED_THRESHOLD_MPS,
        hot_angular_speed_radps: HOT_ANGULAR_SPEED_THRESHOLD_RADPS,
        hot_dynamic_near_radius_m: HOT_DYNAMIC_NEAR_RADIUS_M,
        reserved_vehicles: STRICT_SNAPSHOT_RESERVED_VEHICLES,
    };
}

impl Default for SnapshotConfig {
    fn default() -> Self {
        Self::PRODUCTION
    }
}

/// A dynamic body's snapshot identity, fixed at match start.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodyMeta {
    pub handle: u16,
    pub shape_type: u8,
    pub half_extents_m: [f32; 3],
}

/// What the recipient stands on, as the arena reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SupportInput {
    pub entity_id: u32,
    pub is_vehicle: bool,
    pub local_position: [f32; 3],
    pub velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub flags: u8,
}

/// The world as one snapshot tick sees it, before interest or budget: built
/// once per tick and shared by every recipient.
pub struct SnapshotWorld<'a> {
    pub server_tick: u32,
    pub server_time_us: u64,
    /// The server's wall clock when the tick's state became available (µs,
    /// modulo 2^32, process-local origin): the SnapshotV2 trailer.
    pub server_wall_us: u32,
    /// `(id, position, wire state)`, flags already carrying FLAG_MELEEING.
    pub players: &'a [(u32, [f32; 3], NetPlayerState)],
    /// `(id, position, rotation, wire state)`.
    pub bodies: &'a [(u32, [f32; 3], [f32; 4], NetDynamicBodyState)],
    /// `(id, position, wire state)`.
    pub vehicles: &'a [(u32, [f32; 3], NetVehicleState)],
    pub player_handles: &'a HashMap<u32, u8>,
    pub vehicle_handles: &'a HashMap<u32, u8>,
    pub body_meta: &'a HashMap<u32, BodyMeta>,
}

/// One recipient's inputs this tick that are not world state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecipientInput {
    pub id: u32,
    pub ack_input_seq: u16,
    pub support: Option<SupportInput>,
}

/// What the selection remembers about one recipient between snapshots.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecipientInterest {
    pub visible_dynamic_bodies: HashSet<u32>,
    pub last_sent_dynamic_body_pose: HashMap<u32, ([f32; 3], [f32; 4])>,
    pub last_sent_vehicle_tick: HashMap<u32, u32>,
    pub last_sent_dynamic_tick: HashMap<u32, u32>,
}

enum DynamicBodySelection {
    Sphere(protocol::DynamicSphereStateV2),
    Box(protocol::DynamicBoxStateV2),
}

pub fn distance_sq(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    dx * dx + dy * dy + dz * dz
}

fn quantize_relative_q2_5mm(value_m: f32) -> Option<i16> {
    let encoded = (value_m / 0.0025).round();
    if !(i16::MIN as f32..=i16::MAX as f32).contains(&encoded) {
        return None;
    }
    Some(encoded as i16)
}

pub fn quantize_relative_vec_q2_5mm(
    origin: [f32; 3],
    target: [f32; 3],
) -> Option<(i16, i16, i16)> {
    Some((
        quantize_relative_q2_5mm(target[0] - origin[0])?,
        quantize_relative_q2_5mm(target[1] - origin[1])?,
        quantize_relative_q2_5mm(target[2] - origin[2])?,
    ))
}

fn speed_sq3(v: [f32; 3]) -> f32 {
    v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
}

pub fn periodic_refresh_due(last_sent_tick: Option<u32>, current_tick: u32, interval: u32) -> bool {
    last_sent_tick
        .map(|last| current_tick.saturating_sub(last) >= interval)
        .unwrap_or(true)
}

pub fn dynamic_body_within_aoi(
    config: &SnapshotConfig,
    was_visible: bool,
    body_pos: [f32; 3],
    recipient_pos: [f32; 3],
) -> bool {
    let dist_sq = distance_sq(body_pos, recipient_pos);
    if was_visible {
        dist_sq <= config.dynamic_aoi_exit_radius_m * config.dynamic_aoi_exit_radius_m
    } else {
        dist_sq <= config.dynamic_aoi_radius_m * config.dynamic_aoi_radius_m
    }
}

/// The snapshot for one recipient, and (for V2) what it left out and why.
///
/// `strict` selects the budgeted V2 datagram snapshot (every WebTransport
/// match; PhysX GPU matches require it) over the unbudgeted V1 snapshot.
/// Returns `None` when the recipient has no player state this tick.
pub fn build_recipient_snapshot(
    world: &SnapshotWorld<'_>,
    recipient: &RecipientInput,
    interest: &mut RecipientInterest,
    strict: bool,
    config: &SnapshotConfig,
) -> Option<(ServerPacket, SnapshotSelection)> {
    let recipient_id = recipient.id;
    let (_, recipient_pos, local_player_state) = world
        .players
        .iter()
        .find(|(player_id, _, _)| *player_id == recipient_id)?;
    let recipient_pos = *recipient_pos;
    let ack_input_seq = recipient.ack_input_seq;

    if !strict {
        let mut filtered_players: Vec<_> = world
            .players
            .iter()
            .filter(|(player_id, pos, _)| {
                *player_id == recipient_id
                    || distance_sq(*pos, recipient_pos)
                        <= config.player_aoi_radius_m * config.player_aoi_radius_m
            })
            .collect();
        filtered_players.sort_by(|a, b| {
            let a_self = a.0 == recipient_id;
            let b_self = b.0 == recipient_id;
            b_self.cmp(&a_self).then_with(|| {
                distance_sq(a.1, recipient_pos).total_cmp(&distance_sq(b.1, recipient_pos))
            })
        });

        let mut filtered_dynamic_candidates: Vec<_> = world
            .bodies
            .iter()
            .filter(|(body_id, pos, _, _)| {
                dynamic_body_within_aoi(
                    config,
                    interest.visible_dynamic_bodies.contains(body_id),
                    *pos,
                    recipient_pos,
                )
            })
            .collect();
        filtered_dynamic_candidates.sort_by(|a, b| {
            distance_sq(a.1, recipient_pos).total_cmp(&distance_sq(b.1, recipient_pos))
        });

        let mut filtered_vehicle_candidates: Vec<_> = world
            .vehicles
            .iter()
            .filter(|(_, pos, state)| {
                state.driver_id == recipient_id
                    || distance_sq(*pos, recipient_pos)
                        <= config.vehicle_aoi_radius_m * config.vehicle_aoi_radius_m
            })
            .collect();
        filtered_vehicle_candidates.sort_by(|a, b| {
            let a_local = a.2.driver_id == recipient_id;
            let b_local = b.2.driver_id == recipient_id;
            b_local.cmp(&a_local).then_with(|| {
                distance_sq(a.1, recipient_pos).total_cmp(&distance_sq(b.1, recipient_pos))
            })
        });

        let mut filtered_dynamic_bodies = Vec::new();
        let mut next_visible_dynamic_bodies = HashSet::new();
        let mut next_sent_dynamic_body_pose = HashMap::new();
        for (body_id, pos, quat, state) in filtered_dynamic_candidates {
            next_visible_dynamic_bodies.insert(*body_id);
            filtered_dynamic_bodies.push(*state);
            next_sent_dynamic_body_pose.insert(*body_id, (*pos, *quat));
        }
        interest.visible_dynamic_bodies = next_visible_dynamic_bodies;
        interest.last_sent_dynamic_body_pose = next_sent_dynamic_body_pose;

        let filtered_vehicles = filtered_vehicle_candidates
            .into_iter()
            .map(|(_, _, state)| *state)
            .collect();

        let packet = ServerPacket::Snapshot(SnapshotPacket {
            server_time_us: world.server_time_us,
            server_tick: world.server_tick,
            ack_input_seq,
            player_states: filtered_players
                .into_iter()
                .map(|(_, _, state)| *state)
                .collect(),
            projectile_states: Vec::new(),
            dynamic_body_states: filtered_dynamic_bodies,
            vehicle_states: filtered_vehicles,
        });
        // V1 has no byte budget: everything in the AOI is sent.
        let players = packet_player_count(&packet).saturating_sub(1) as u32;
        let vehicles = packet_vehicle_count(&packet) as u32;
        let bodies = packet_dynamic_body_count(&packet) as u32;
        let selection = SnapshotSelection {
            players_aoi: players,
            players_sent: players,
            vehicles_aoi: vehicles,
            vehicles_hot: vehicles,
            vehicles_sent: vehicles,
            bodies_aoi: bodies,
            bodies_hot: bodies,
            bodies_sent: bodies,
            ..Default::default()
        };
        return Some((packet, selection));
    }

    let mut selection = SnapshotSelection::default();

    let mut budget_remaining = config
        .datagram_target_bytes
        .saturating_sub(SNAPSHOT_V2_HEADER_BYTES + protocol::SNAPSHOT_V2_TRAILER_BYTES);

    let support_state = recipient.support;
    let support_dynamic_id = support_state
        .filter(|support| !support.is_vehicle)
        .map(|support| support.entity_id);
    let support_vehicle_id = support_state
        .filter(|support| support.is_vehicle)
        .map(|support| support.entity_id);
    let support = support_state.and_then(|support| {
        let handle = if support.is_vehicle {
            world
                .vehicle_handles
                .get(&support.entity_id)
                .map(|handle| 0x8000 | u16::from(*handle))
        } else {
            world
                .body_meta
                .get(&support.entity_id)
                .map(|entry| entry.handle)
        }?;
        Some((
            handle,
            support.local_position.map(|value| {
                (value * 400.0)
                    .round()
                    .clamp(i16::MIN as f32, i16::MAX as f32) as i16
            }),
            support.velocity.map(|value| {
                (value * 100.0)
                    .round()
                    .clamp(i16::MIN as f32, i16::MAX as f32) as i16
            }),
            support.angular_velocity.map(|value| {
                (value * 1000.0)
                    .round()
                    .clamp(i16::MIN as f32, i16::MAX as f32) as i16
            }),
            support.flags,
        ))
    });
    let self_state = protocol::SelfPlayerStateV2 {
        vx_cms: local_player_state.vx_cms,
        vy_cms: local_player_state.vy_cms,
        vz_cms: local_player_state.vz_cms,
        yaw_i16: local_player_state.yaw_i16,
        pitch_i16: local_player_state.pitch_i16,
        hp: local_player_state.hp,
        flags: (local_player_state.flags & 0xff) as u8,
        support_handle: support.map_or(0, |value| value.0),
        support_local_q2_5mm: support.map_or([0; 3], |value| value.1),
        support_velocity_cms: support.map_or([0; 3], |value| value.2),
        support_angular_velocity_mrads: support.map_or([0; 3], |value| value.3),
        support_flags: support.map_or(0, |value| value.4),
    };
    budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_SELF_PLAYER_BYTES);

    let mut reserved_vehicle_ids: HashSet<u32> = world
        .vehicles
        .iter()
        .filter(|(_, _, state)| state.driver_id == recipient_id)
        .take(config.reserved_vehicles)
        .map(|(vehicle_id, _, _)| *vehicle_id)
        .collect();
    if let Some(vehicle_id) = support_vehicle_id {
        reserved_vehicle_ids.insert(vehicle_id);
    }
    let reserved_vehicle_budget = reserved_vehicle_ids
        .len()
        .saturating_mul(SNAPSHOT_V2_VEHICLE_BYTES);
    budget_remaining = budget_remaining.saturating_sub(reserved_vehicle_budget);
    let reserved_support_dynamic_bytes = support_dynamic_id
        .and_then(|body_id| world.body_meta.get(&body_id))
        .map(|meta| {
            if meta.shape_type == SHAPE_SPHERE {
                SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES
            } else {
                SNAPSHOT_V2_DYNAMIC_BOX_BYTES
            }
        })
        .unwrap_or(0);
    budget_remaining = budget_remaining.saturating_sub(reserved_support_dynamic_bytes);

    let mut remote_player_states = Vec::new();
    let mut remote_player_candidates: Vec<_> = world
        .players
        .iter()
        .filter(|(player_id, pos, _)| {
            *player_id != recipient_id
                && distance_sq(*pos, recipient_pos)
                    <= config.player_aoi_radius_m * config.player_aoi_radius_m
        })
        .collect();
    remote_player_candidates.sort_by(|a, b| {
        distance_sq(a.1, recipient_pos).total_cmp(&distance_sq(b.1, recipient_pos))
    });
    selection.players_aoi = remote_player_candidates.len() as u32;
    for (index, (player_id, pos, state)) in remote_player_candidates.into_iter().enumerate() {
        let Some(handle) = world.player_handles.get(player_id).copied() else {
            continue;
        };
        let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(recipient_pos, *pos) else {
            selection.out_of_range += 1;
            continue;
        };
        if budget_remaining < SNAPSHOT_V2_REMOTE_PLAYER_BYTES {
            selection.players_budget = (selection.players_aoi as usize - index) as u32;
            break;
        }
        remote_player_states.push(protocol::RemotePlayerStateV2 {
            handle,
            dx_q2_5mm: dx,
            dy_q2_5mm: dy,
            dz_q2_5mm: dz,
            vx_cms: state.vx_cms,
            vy_cms: state.vy_cms,
            vz_cms: state.vz_cms,
            yaw_i16: state.yaw_i16,
            pitch_i16: state.pitch_i16,
            hp: state.hp,
            flags: (state.flags & 0xff) as u8,
        });
        budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_REMOTE_PLAYER_BYTES);
    }
    selection.players_sent = remote_player_states.len() as u32;

    let mut selected_vehicle_states = Vec::new();
    for (vehicle_id, pos, state) in world
        .vehicles
        .iter()
        .filter(|(vehicle_id, _, _)| reserved_vehicle_ids.contains(vehicle_id))
    {
        let Some(handle) = world.vehicle_handles.get(vehicle_id).copied() else {
            continue;
        };
        let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(recipient_pos, *pos) else {
            continue;
        };
        let driver_handle = world
            .player_handles
            .get(&state.driver_id)
            .copied()
            .unwrap_or_default();
        selected_vehicle_states.push(protocol::VehicleStateV2 {
            handle,
            vehicle_type: state.vehicle_type,
            driver_handle,
            flags: state.flags,
            dx_q2_5mm: dx,
            dy_q2_5mm: dy,
            dz_q2_5mm: dz,
            qx_snorm: state.qx_snorm,
            qy_snorm: state.qy_snorm,
            qz_snorm: state.qz_snorm,
            qw_snorm: state.qw_snorm,
            vx_cms: state.vx_cms,
            vy_cms: state.vy_cms,
            vz_cms: state.vz_cms,
            wx_mrads: state.wx_mrads,
            wy_mrads: state.wy_mrads,
            wz_mrads: state.wz_mrads,
        });
        interest
            .last_sent_vehicle_tick
            .insert(*vehicle_id, world.server_tick);
    }

    let reserved_vehicles_sent = selected_vehicle_states.len();
    let mut vehicle_hot = Vec::new();
    for (vehicle_id, pos, state) in world.vehicles.iter().filter(|(_, pos, state)| {
        state.driver_id == recipient_id
            || distance_sq(*pos, recipient_pos)
                <= config.vehicle_aoi_radius_m * config.vehicle_aoi_radius_m
    }) {
        if reserved_vehicle_ids.contains(vehicle_id) {
            continue;
        }
        selection.vehicles_aoi += 1;
        let Some(handle) = world.vehicle_handles.get(vehicle_id).copied() else {
            continue;
        };
        let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(recipient_pos, *pos) else {
            selection.out_of_range += 1;
            continue;
        };
        let driver_handle = world
            .player_handles
            .get(&state.driver_id)
            .copied()
            .unwrap_or_default();
        let record = protocol::VehicleStateV2 {
            handle,
            vehicle_type: state.vehicle_type,
            driver_handle,
            flags: state.flags,
            dx_q2_5mm: dx,
            dy_q2_5mm: dy,
            dz_q2_5mm: dz,
            qx_snorm: state.qx_snorm,
            qy_snorm: state.qy_snorm,
            qz_snorm: state.qz_snorm,
            qw_snorm: state.qw_snorm,
            vx_cms: state.vx_cms,
            vy_cms: state.vy_cms,
            vz_cms: state.vz_cms,
            wx_mrads: state.wx_mrads,
            wy_mrads: state.wy_mrads,
            wz_mrads: state.wz_mrads,
        };
        let hot = state.driver_id == recipient_id
            || state.driver_id != 0
            || speed_sq3([
                cms_to_mps(state.vx_cms),
                cms_to_mps(state.vy_cms),
                cms_to_mps(state.vz_cms),
            ]) > config.hot_linear_speed_mps * config.hot_linear_speed_mps
            || speed_sq3([
                state.wx_mrads as f32 / 1000.0,
                state.wy_mrads as f32 / 1000.0,
                state.wz_mrads as f32 / 1000.0,
            ]) > config.hot_angular_speed_radps * config.hot_angular_speed_radps
            || periodic_refresh_due(
                interest.last_sent_vehicle_tick.get(vehicle_id).copied(),
                world.server_tick,
                config.cold_vehicle_refresh_ticks,
            );
        if hot {
            vehicle_hot.push((*vehicle_id, distance_sq(*pos, recipient_pos), record));
        }
    }
    vehicle_hot.sort_by(|a, b| a.1.total_cmp(&b.1));
    let vehicle_hot_count = vehicle_hot.len();

    for (vehicle_id, _, record) in vehicle_hot {
        if budget_remaining < SNAPSHOT_V2_VEHICLE_BYTES {
            break;
        }
        interest
            .last_sent_vehicle_tick
            .insert(vehicle_id, world.server_tick);
        selected_vehicle_states.push(record);
        budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_VEHICLE_BYTES);
    }
    selection.vehicles_aoi += reserved_vehicles_sent as u32;
    selection.vehicles_hot = (vehicle_hot_count + reserved_vehicles_sent) as u32;
    selection.vehicles_sent = selected_vehicle_states.len() as u32;
    selection.vehicles_budget = (vehicle_hot_count + reserved_vehicles_sent)
        .saturating_sub(selected_vehicle_states.len()) as u32;

    let mut all_visible_dynamic_bodies = HashSet::new();
    let mut dynamic_hot = Vec::new();
    let mut dynamic_cold = Vec::new();
    for (body_id, pos, quat, state) in world.bodies.iter().filter(|(body_id, pos, _, _)| {
        dynamic_body_within_aoi(
            config,
            interest.visible_dynamic_bodies.contains(body_id),
            *pos,
            recipient_pos,
        )
    }) {
        all_visible_dynamic_bodies.insert(*body_id);
        let Some(meta) = world.body_meta.get(body_id).copied() else {
            continue;
        };
        let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(recipient_pos, *pos) else {
            selection.out_of_range += 1;
            continue;
        };
        let dist_sq = distance_sq(*pos, recipient_pos);
        let moving = speed_sq3([
            cms_to_mps(state.vx_cms),
            cms_to_mps(state.vy_cms),
            cms_to_mps(state.vz_cms),
        ]) > config.hot_linear_speed_mps * config.hot_linear_speed_mps
            || speed_sq3([
                state.wx_mrads as f32 / 1000.0,
                state.wy_mrads as f32 / 1000.0,
                state.wz_mrads as f32 / 1000.0,
            ]) > config.hot_angular_speed_radps * config.hot_angular_speed_radps;
        let needs_refresh = periodic_refresh_due(
            interest.last_sent_dynamic_tick.get(body_id).copied(),
            world.server_tick,
            config.cold_dynamic_refresh_ticks,
        );
        let near = dist_sq <= config.hot_dynamic_near_radius_m * config.hot_dynamic_near_radius_m;

        if meta.shape_type == SHAPE_SPHERE {
            let record = protocol::DynamicSphereStateV2 {
                handle: meta.handle,
                dx_q2_5mm: dx,
                dy_q2_5mm: dy,
                dz_q2_5mm: dz,
                vx_cms: state.vx_cms,
                vy_cms: state.vy_cms,
                vz_cms: state.vz_cms,
                wx_mrads: state.wx_mrads,
                wy_mrads: state.wy_mrads,
                wz_mrads: state.wz_mrads,
            };
            if support_dynamic_id == Some(*body_id) || moving || near || needs_refresh {
                dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Sphere(record)));
            } else if needs_refresh {
                dynamic_cold.push((*body_id, dist_sq, DynamicBodySelection::Sphere(record)));
            }
        } else {
            let record = protocol::DynamicBoxStateV2 {
                handle: meta.handle,
                dx_q2_5mm: dx,
                dy_q2_5mm: dy,
                dz_q2_5mm: dz,
                qx_snorm: f32_to_snorm16(quat[0]),
                qy_snorm: f32_to_snorm16(quat[1]),
                qz_snorm: f32_to_snorm16(quat[2]),
                qw_snorm: f32_to_snorm16(quat[3]),
                vx_cms: state.vx_cms,
                vy_cms: state.vy_cms,
                vz_cms: state.vz_cms,
                wx_mrads: state.wx_mrads,
                wy_mrads: state.wy_mrads,
                wz_mrads: state.wz_mrads,
            };
            if support_dynamic_id == Some(*body_id) || moving || near || needs_refresh {
                dynamic_hot.push((*body_id, dist_sq, DynamicBodySelection::Box(record)));
            } else if needs_refresh {
                dynamic_cold.push((*body_id, dist_sq, DynamicBodySelection::Box(record)));
            }
        }
        interest
            .last_sent_dynamic_body_pose
            .insert(*body_id, (*pos, *quat));
    }
    selection.bodies_aoi = all_visible_dynamic_bodies.len() as u32;
    selection.bodies_hot = (dynamic_hot.len() + dynamic_cold.len()) as u32;
    interest.visible_dynamic_bodies = all_visible_dynamic_bodies;
    dynamic_hot.sort_by(|a, b| a.1.total_cmp(&b.1));
    dynamic_cold.sort_by(|a, b| a.1.total_cmp(&b.1));
    if let Some(support_body_id) = support_dynamic_id {
        dynamic_hot.sort_by_key(|(body_id, _, _)| *body_id != support_body_id);
        dynamic_cold.sort_by_key(|(body_id, _, _)| *body_id != support_body_id);
    }

    let mut sphere_states = Vec::new();
    let mut box_states = Vec::new();
    for (body_id, _, choice) in dynamic_hot.into_iter().chain(dynamic_cold.into_iter()) {
        let record_size = match &choice {
            DynamicBodySelection::Sphere(_) => SNAPSHOT_V2_DYNAMIC_SPHERE_BYTES,
            DynamicBodySelection::Box(_) => SNAPSHOT_V2_DYNAMIC_BOX_BYTES,
        };
        let reserved_support = support_dynamic_id == Some(body_id);
        if !reserved_support && budget_remaining < record_size {
            continue;
        }
        match choice {
            DynamicBodySelection::Sphere(record) => sphere_states.push(record),
            DynamicBodySelection::Box(record) => box_states.push(record),
        }
        interest
            .last_sent_dynamic_tick
            .insert(body_id, world.server_tick);
        if !reserved_support {
            budget_remaining = budget_remaining.saturating_sub(record_size);
        }
    }

    selection.bodies_sent = (sphere_states.len() + box_states.len()) as u32;
    selection.bodies_budget = selection.bodies_hot.saturating_sub(selection.bodies_sent);
    selection.bodies_unchanged = selection
        .bodies_aoi
        .saturating_sub(selection.bodies_hot)
        .saturating_sub(selection.out_of_range);
    let packet = ServerPacket::SnapshotV2(protocol::SnapshotV2Packet {
        server_tick: world.server_tick,
        ack_input_seq,
        anchor_px_mm: local_player_state.px_mm,
        anchor_py_mm: local_player_state.py_mm,
        anchor_pz_mm: local_player_state.pz_mm,
        self_state,
        remote_players: remote_player_states,
        sphere_states,
        box_states,
        vehicle_states: selected_vehicle_states,
        server_wall_us: world.server_wall_us,
    });
    Some((packet, selection))
}

pub fn packet_player_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.player_states.len(),
        ServerPacket::SnapshotV2(snapshot) => 1 + snapshot.remote_players.len(),
        _ => 0,
    }
}

pub fn packet_dynamic_body_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.dynamic_body_states.len(),
        ServerPacket::SnapshotV2(snapshot) => {
            snapshot.sphere_states.len() + snapshot.box_states.len()
        }
        _ => 0,
    }
}

pub fn packet_vehicle_count(packet: &ServerPacket) -> usize {
    match packet {
        ServerPacket::Snapshot(snapshot) => snapshot.vehicle_states.len(),
        ServerPacket::SnapshotV2(snapshot) => snapshot.vehicle_states.len(),
        _ => 0,
    }
}
