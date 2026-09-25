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
/// With `SnapshotConfig::idle_cold`: a remote player whose record has not
/// changed is resent at least this often (the vehicles' rate).
pub const COLD_PLAYER_REFRESH_TICKS: u32 = SIM_HZ as u32 / 2;
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
    /// Send the self state without its support block when the block carries
    /// nothing the client uses (see `SnapshotV2Packet::compact_self`).
    /// Captures record it (`SnapshotBaseline::compact_self`); a capture
    /// without the field replays with it off, byte for byte.
    #[serde(default)]
    pub compact_self: bool,
    /// Tell the recipient which bodies and vehicles its stream stopped
    /// carrying (`SnapshotV2Packet::removals`), instead of leaving the client
    /// to infer it (client/src/net/bodyPresence.ts, and a 3 s stale rule for
    /// vehicles). Recorded in captures like `compact_self`.
    #[serde(default)]
    pub removals: bool,
    /// Remote players and vehicles whose record has not changed (standing
    /// players, parked cars, occupied or not) are sent like resting bodies:
    /// a few times as they come to rest, then once per cold refresh, and at
    /// once when anything the client draws changes. Without it every remote
    /// player in interest is sent every snapshot, and so is every vehicle
    /// with a driver. Recorded in captures like `compact_self`.
    #[serde(default)]
    pub idle_cold: bool,
    /// With `idle_cold`: an unchanged remote player is resent this often.
    #[serde(default = "default_cold_player_refresh_ticks")]
    pub cold_player_refresh_ticks: u32,
}

fn default_cold_player_refresh_ticks() -> u32 {
    COLD_PLAYER_REFRESH_TICKS
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
        compact_self: true,
        removals: true,
        idle_cold: true,
        cold_player_refresh_ticks: COLD_PLAYER_REFRESH_TICKS,
    };

    /// The selection as it was before `compact_self`, `removals` and
    /// `idle_cold`: what a capture that records none of them was made with.
    pub const LEGACY_FORMAT: Self =
        Self { compact_self: false, removals: false, idle_cold: false, ..Self::PRODUCTION };
}

/// Snapshots that carry a remote player or vehicle after its record stops
/// changing (`SnapshotConfig::idle_cold`), before it goes cold: a client that
/// loses one still gets the entity's resting state (a player's with zero
/// velocity) within a tick or two, instead of extrapolating its last moving
/// sample until the cold refresh.
pub const SNAPSHOT_REST_SENDS: u8 = 3;
/// Position change (mm, any axis) below which a player or vehicle record is
/// unchanged; under the 2.5 mm wire quantum.
pub const IDLE_POSITION_TOLERANCE_MM: i32 = 2;
/// Orientation change (snorm16 units, any component) below which a vehicle
/// record is unchanged (about 0.01 degrees).
pub const IDLE_ROTATION_TOLERANCE_SNORM: i32 = 2;

/// How many consecutive snapshots restate one removal. A client that loses
/// all of them falls back to inferring the removal, as before.
pub const SNAPSHOT_REMOVAL_REPEATS: u8 = 6;
/// Removals entries per snapshot at most. The section (2 + 3 B each) is not
/// charged to the byte budget: at this cap a full snapshot stays under the
/// 1,160-byte datagram limit (1,100 + 26).
pub const SNAPSHOT_REMOVALS_PER_PACKET: usize = 8;

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
    /// With `SnapshotConfig::removals`: bodies sent to this recipient and
    /// still in its interest, with the handle they were sent under.
    #[serde(default)]
    pub streamed_bodies: HashMap<u32, u16>,
    /// With `SnapshotConfig::removals`: the same for vehicles.
    #[serde(default)]
    pub streamed_vehicles: HashMap<u32, u8>,
    /// With `SnapshotConfig::removals`: vehicles in this recipient's interest
    /// at the last snapshot (driven, or within the vehicle radius).
    #[serde(default)]
    pub visible_vehicles: HashSet<u32>,
    /// Removals still to be restated.
    #[serde(default)]
    pub pending_removals: Vec<PendingRemoval>,
    /// With `SnapshotConfig::removals`: bodies / vehicles that entered this
    /// recipient's stream (first send, or back after a removal), and how many
    /// more consecutive snapshots carry them whatever their hot/cold state.
    /// A client drops what the server says it removed, so a lost first send
    /// of an entity at rest would otherwise leave it undrawn until its cold
    /// refresh (0.5-1 s).
    #[serde(default)]
    pub entry_sends_bodies: HashMap<u32, u8>,
    #[serde(default)]
    pub entry_sends_vehicles: HashMap<u32, u8>,
    /// With `SnapshotConfig::idle_cold`: each remote player's record as last
    /// sent to this recipient (what "unchanged" is judged against).
    #[serde(default)]
    pub sent_players: HashMap<u32, SentRecord>,
    /// With `idle_cold`: every player's position (mm) at the last snapshot
    /// tick, to tell a player standing still (its record then carries zero
    /// velocity) from one moving.
    #[serde(default)]
    pub player_positions_mm: HashMap<u32, [i32; 3]>,
    /// With `idle_cold`: each vehicle's record as last sent.
    #[serde(default)]
    pub sent_vehicles: HashMap<u32, SentRecord>,
}

/// What a record looked like when it was last sent to one recipient, in the
/// wire's absolute units (`SnapshotConfig::idle_cold`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentRecord {
    pub tick: u32,
    pub position_mm: [i32; 3],
    /// Everything else the client draws or keys on, exactly: a player's
    /// yaw, pitch, hp, flags and whether it stood still; a vehicle's
    /// orientation (compared with a tolerance), type, driver and flags.
    pub rest: [i16; 4],
    pub exact: [i32; 4],
    /// Snapshots still to carry it although unchanged (`SNAPSHOT_REST_SENDS`).
    /// A record seen for the first time counts as changed, so an entity
    /// entering the stream is in its first `SNAPSHOT_REST_SENDS` snapshots.
    pub rest_sends_left: u8,
}

impl SentRecord {
    fn changed(&self, position_mm: [i32; 3], rest: [i16; 4], rest_tolerance: i32, exact: [i32; 4]) -> bool {
        self.exact != exact
            || (0..3).any(|i| (self.position_mm[i] - position_mm[i]).abs() > IDLE_POSITION_TOLERANCE_MM)
            || (0..4).any(|i| (i32::from(self.rest[i]) - i32::from(rest[i])).abs() > rest_tolerance)
    }
}

/// The idle-cold decision for one player or vehicle (`SnapshotConfig::idle_cold`):
/// whether it is due this snapshot, and the record to remember if it is sent.
fn idle_cold_due(
    sent: Option<&SentRecord>,
    tick: u32,
    position_mm: [i32; 3],
    rest: [i16; 4],
    rest_tolerance: i32,
    exact: [i32; 4],
    refresh_ticks: u32,
) -> (bool, SentRecord) {
    let changed = sent.is_none_or(|s| s.changed(position_mm, rest, rest_tolerance, exact));
    let rest_sends_left = match sent {
        Some(s) if !changed => s.rest_sends_left,
        _ => SNAPSHOT_REST_SENDS,
    };
    let due = changed
        || rest_sends_left > 0
        || periodic_refresh_due(sent.map(|s| s.tick), tick, refresh_ticks);
    let record = SentRecord {
        tick,
        // An unchanged record keeps the pose it was judged against, so a
        // slow drift is sent once it adds up to the tolerance.
        position_mm: match sent {
            Some(s) if !changed => s.position_mm,
            _ => position_mm,
        },
        rest: match sent {
            Some(s) if !changed => s.rest,
            _ => rest,
        },
        exact,
        rest_sends_left: rest_sends_left.saturating_sub(1),
    };
    (due, record)
}

/// Consecutive snapshots that carry an entity entering the stream
/// (`RecipientInterest::entry_sends_*`), the first send included.
pub const SNAPSHOT_ENTRY_SENDS: u8 = 3;

fn note_entry_send(map: &mut HashMap<u32, u8>, id: u32, entered: bool) {
    if entered {
        map.insert(id, SNAPSHOT_ENTRY_SENDS - 1);
    } else if let Some(left) = map.get_mut(&id) {
        *left = left.saturating_sub(1);
        if *left == 0 {
            map.remove(&id);
        }
    }
}

/// A removal the recipient has not been told often enough yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRemoval {
    /// The body or vehicle id (to cancel it if the entity comes back).
    pub id: u32,
    pub vehicle: bool,
    /// The wire handle: a body's, or `0x8000 | vehicle handle`.
    pub handle: u16,
    /// The first snapshot tick that did not carry it.
    pub tick: u32,
    pub sends_left: u8,
}

impl RecipientInterest {
    fn note_removed(&mut self, id: u32, vehicle: bool, handle: u16, tick: u32) {
        self.pending_removals.retain(|p| !(p.id == id && p.vehicle == vehicle));
        self.pending_removals.push(PendingRemoval {
            id,
            vehicle,
            handle,
            tick,
            sends_left: SNAPSHOT_REMOVAL_REPEATS,
        });
    }

    fn note_streamed(&mut self, id: u32, vehicle: bool) {
        self.pending_removals.retain(|p| !(p.id == id && p.vehicle == vehicle));
    }

    /// This snapshot's removals section, oldest first.
    fn take_removals(&mut self, tick: u32) -> Vec<protocol::SnapshotRemoval> {
        let mut out = Vec::new();
        for pending in self.pending_removals.iter_mut().take(SNAPSHOT_REMOVALS_PER_PACKET) {
            out.push(protocol::SnapshotRemoval {
                handle: pending.handle,
                age_ticks: tick.saturating_sub(pending.tick).min(u32::from(u8::MAX)) as u8,
            });
            pending.sends_left = pending.sends_left.saturating_sub(1);
        }
        self.pending_removals.retain(|p| p.sends_left > 0);
        out
    }
}

/// `idle_cold_due` for a vehicle: its pose, and exactly its type, driver,
/// flags and whether it moves (so the snapshot it stops in counts as a
/// change, and is followed by the rest sends with zero velocity).
fn vehicle_idle_cold_due(
    interest: &RecipientInterest,
    vehicle_id: u32,
    tick: u32,
    state: &NetVehicleState,
    driver_handle: u8,
    config: &SnapshotConfig,
) -> (bool, SentRecord) {
    let moving = state.vx_cms != 0
        || state.vy_cms != 0
        || state.vz_cms != 0
        || state.wx_mrads != 0
        || state.wy_mrads != 0
        || state.wz_mrads != 0;
    idle_cold_due(
        interest.sent_vehicles.get(&vehicle_id),
        tick,
        [state.px_mm, state.py_mm, state.pz_mm],
        [state.qx_snorm, state.qy_snorm, state.qz_snorm, state.qw_snorm],
        IDLE_ROTATION_TOLERANCE_SNORM,
        [i32::from(state.vehicle_type), i32::from(driver_handle), i32::from(state.flags), i32::from(moving)],
        config.cold_vehicle_refresh_ticks,
    )
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

    let mut current_visible_vehicles: HashSet<u32> = HashSet::new();
    if config.removals {
        for (vehicle_id, pos, state) in world.vehicles.iter() {
            if reserved_vehicle_ids.contains(vehicle_id)
                || state.driver_id == recipient_id
                || distance_sq(*pos, recipient_pos)
                    <= config.vehicle_aoi_radius_m * config.vehicle_aoi_radius_m
            {
                current_visible_vehicles.insert(*vehicle_id);
            }
        }
    }

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
    // With `idle_cold`: only the players whose record changed, is settling
    // (`SNAPSHOT_REST_SENDS`) or is due its refresh; a player standing still
    // is sent with zero velocity (a grounded one reports the controller's
    // -0.5 m/s ground snap, which a client would extrapolate).
    let mut due_players = Vec::with_capacity(remote_player_candidates.len());
    for (player_id, pos, state) in remote_player_candidates {
        let Some(handle) = world.player_handles.get(player_id).copied() else {
            continue;
        };
        let Some((dx, dy, dz)) = quantize_relative_vec_q2_5mm(recipient_pos, *pos) else {
            selection.out_of_range += 1;
            continue;
        };
        let mut record = protocol::RemotePlayerStateV2 {
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
        };
        let mut remember = None;
        if config.idle_cold {
            let position_mm = [state.px_mm, state.py_mm, state.pz_mm];
            let still = interest.player_positions_mm.get(player_id).is_some_and(|previous| {
                (0..3).all(|i| (previous[i] - position_mm[i]).abs() <= 1)
            });
            if still {
                (record.vx_cms, record.vy_cms, record.vz_cms) = (0, 0, 0);
            }
            let (due, sent) = idle_cold_due(
                interest.sent_players.get(player_id),
                world.server_tick,
                position_mm,
                [record.yaw_i16, record.pitch_i16, 0, 0],
                0,
                [i32::from(record.hp), i32::from(record.flags), i32::from(still), 0],
                config.cold_player_refresh_ticks,
            );
            if !due {
                continue;
            }
            remember = Some(sent);
        }
        due_players.push((*player_id, record, remember));
    }
    let due_player_count = due_players.len();
    for (index, (player_id, record, remember)) in due_players.into_iter().enumerate() {
        if budget_remaining < SNAPSHOT_V2_REMOTE_PLAYER_BYTES {
            selection.players_budget = (due_player_count - index) as u32;
            break;
        }
        if let Some(sent) = remember {
            interest.sent_players.insert(player_id, sent);
        }
        remote_player_states.push(record);
        budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_REMOTE_PLAYER_BYTES);
    }
    selection.players_sent = remote_player_states.len() as u32;
    if config.idle_cold {
        // A player that leaves interest is sent at once (and settles again)
        // when it comes back; every player's position is kept for the next
        // snapshot's standing-still test.
        let in_interest: HashSet<u32> = world
            .players
            .iter()
            .filter(|(player_id, pos, _)| {
                *player_id != recipient_id
                    && distance_sq(*pos, recipient_pos)
                        <= config.player_aoi_radius_m * config.player_aoi_radius_m
            })
            .map(|(player_id, _, _)| *player_id)
            .collect();
        interest.sent_players.retain(|player_id, _| in_interest.contains(player_id));
        interest.player_positions_mm = world
            .players
            .iter()
            .map(|(player_id, _, state)| (*player_id, [state.px_mm, state.py_mm, state.pz_mm]))
            .collect();
    }

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
        if config.idle_cold {
            let (_, sent) = vehicle_idle_cold_due(interest, *vehicle_id, world.server_tick, state, driver_handle, config);
            interest.sent_vehicles.insert(*vehicle_id, sent);
        }
        if config.removals {
            let entered = interest.streamed_vehicles.insert(*vehicle_id, handle).is_none();
            note_entry_send(&mut interest.entry_sends_vehicles, *vehicle_id, entered);
            interest.note_streamed(*vehicle_id, true);
        }
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
        let refresh = periodic_refresh_due(
            interest.last_sent_vehicle_tick.get(vehicle_id).copied(),
            world.server_tick,
            config.cold_vehicle_refresh_ticks,
        ) || (config.removals && interest.entry_sends_vehicles.contains_key(vehicle_id));
        // Without `idle_cold` a vehicle with a driver is sent every snapshot,
        // parked or not; with it, a vehicle is sent while it moves or its
        // record changes (a driver getting in counts), then settles and goes
        // cold like any other.
        let (hot, remember) = if config.idle_cold {
            let (due, sent) = vehicle_idle_cold_due(interest, *vehicle_id, world.server_tick, state, driver_handle, config);
            (state.driver_id == recipient_id || moving || due || refresh, Some(sent))
        } else {
            (state.driver_id == recipient_id || state.driver_id != 0 || moving || refresh, None)
        };
        if hot {
            vehicle_hot.push((*vehicle_id, distance_sq(*pos, recipient_pos), record, remember));
        }
    }
    vehicle_hot.sort_by(|a, b| a.1.total_cmp(&b.1));
    let vehicle_hot_count = vehicle_hot.len();

    for (vehicle_id, _, record, remember) in vehicle_hot {
        if budget_remaining < SNAPSHOT_V2_VEHICLE_BYTES {
            break;
        }
        interest
            .last_sent_vehicle_tick
            .insert(vehicle_id, world.server_tick);
        if let Some(sent) = remember {
            interest.sent_vehicles.insert(vehicle_id, sent);
        }
        if config.removals {
            let entered = interest.streamed_vehicles.insert(vehicle_id, record.handle).is_none();
            note_entry_send(&mut interest.entry_sends_vehicles, vehicle_id, entered);
            interest.note_streamed(vehicle_id, true);
        }
        selected_vehicle_states.push(record);
        budget_remaining = budget_remaining.saturating_sub(SNAPSHOT_V2_VEHICLE_BYTES);
    }
    selection.vehicles_aoi += reserved_vehicles_sent as u32;
    selection.vehicles_hot = (vehicle_hot_count + reserved_vehicles_sent) as u32;
    if config.idle_cold {
        // A vehicle that leaves interest is sent at once when it comes back.
        let in_interest: HashSet<u32> = world
            .vehicles
            .iter()
            .filter(|(vehicle_id, pos, state)| {
                reserved_vehicle_ids.contains(vehicle_id)
                    || state.driver_id == recipient_id
                    || distance_sq(*pos, recipient_pos)
                        <= config.vehicle_aoi_radius_m * config.vehicle_aoi_radius_m
            })
            .map(|(vehicle_id, _, _)| *vehicle_id)
            .collect();
        interest.sent_vehicles.retain(|vehicle_id, _| in_interest.contains(vehicle_id));
    }
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
        ) || (config.removals && interest.entry_sends_bodies.contains_key(body_id));
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
    let previous_visible_bodies =
        std::mem::replace(&mut interest.visible_dynamic_bodies, all_visible_dynamic_bodies);
    if config.removals {
        // Left this recipient's interest, or the world, since the last
        // snapshot: say so, and send it at once should it come back.
        let mut left: Vec<u32> = previous_visible_bodies
            .difference(&interest.visible_dynamic_bodies)
            .copied()
            .collect();
        left.sort_unstable();
        for body_id in left {
            interest.last_sent_dynamic_tick.remove(&body_id);
            interest.entry_sends_bodies.remove(&body_id);
            if let Some(handle) = interest.streamed_bodies.remove(&body_id) {
                interest.note_removed(body_id, false, handle, world.server_tick);
            }
        }
        let mut left: Vec<u32> = interest
            .visible_vehicles
            .difference(&current_visible_vehicles)
            .copied()
            .collect();
        left.sort_unstable();
        for vehicle_id in left {
            interest.last_sent_vehicle_tick.remove(&vehicle_id);
            interest.entry_sends_vehicles.remove(&vehicle_id);
            if let Some(handle) = interest.streamed_vehicles.remove(&vehicle_id) {
                interest.note_removed(
                    vehicle_id,
                    true,
                    protocol::SNAPSHOT_V2_REMOVAL_VEHICLE_BIT | u16::from(handle),
                    world.server_tick,
                );
            }
        }
        interest.visible_vehicles = current_visible_vehicles;
    }
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
        if config.removals {
            let handle = match &choice {
                DynamicBodySelection::Sphere(record) => record.handle,
                DynamicBodySelection::Box(record) => record.handle,
            };
            let entered = interest.streamed_bodies.insert(body_id, handle).is_none();
            note_entry_send(&mut interest.entry_sends_bodies, body_id, entered);
            interest.note_streamed(body_id, false);
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
    let removals = if config.removals { interest.take_removals(world.server_tick) } else { Vec::new() };
    // The client reads only the support's velocity; a support that is not
    // moving (the city's structures, the ground) says what no support says.
    let compact_self = config.compact_self
        && self_state.support_velocity_cms == [0; 3]
        && self_state.support_angular_velocity_mrads == [0; 3];
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
        compact_self,
        removals,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        encode_server_packet, make_net_dynamic_body_state, make_net_player_state, NetVehicleState,
        SNAPSHOT_V2_REMOVALS_TAG, SNAPSHOT_V2_REMOVAL_VEHICLE_BIT, SNAPSHOT_V2_TRAILER_BYTES,
    };

    const RECIPIENT: u32 = 1;

    struct Scene {
        tick: u32,
        players: Vec<(u32, [f32; 3], NetPlayerState)>,
        bodies: Vec<(u32, [f32; 3], [f32; 4], NetDynamicBodyState)>,
        vehicles: Vec<(u32, [f32; 3], NetVehicleState)>,
        player_handles: HashMap<u32, u8>,
        vehicle_handles: HashMap<u32, u8>,
        body_meta: HashMap<u32, BodyMeta>,
    }

    fn player(id: u32, pos: [f32; 3]) -> (u32, [f32; 3], NetPlayerState) {
        (id, pos, make_net_player_state(id, pos, [0.0; 3], 0.0, 0.0, 100, 0, 0.0))
    }

    fn ball(id: u32, pos: [f32; 3], vel: [f32; 3]) -> (u32, [f32; 3], [f32; 4], NetDynamicBodyState) {
        let q = [0.0, 0.0, 0.0, 1.0];
        (id, pos, q, make_net_dynamic_body_state(id, pos, q, [0.2; 3], vel, [0.0; 3], SHAPE_SPHERE))
    }

    fn car(id: u32, pos: [f32; 3]) -> (u32, [f32; 3], NetVehicleState) {
        let state = NetVehicleState {
            id,
            px_mm: (pos[0] * 1000.0) as i32,
            py_mm: (pos[1] * 1000.0) as i32,
            pz_mm: (pos[2] * 1000.0) as i32,
            qw_snorm: i16::MAX,
            ..Default::default()
        };
        (id, pos, state)
    }

    impl Scene {
        fn new() -> Self {
            Scene {
                tick: 100,
                players: vec![player(RECIPIENT, [0.0, 1.0, 0.0])],
                bodies: Vec::new(),
                vehicles: Vec::new(),
                player_handles: HashMap::from([(RECIPIENT, 1)]),
                vehicle_handles: HashMap::new(),
                body_meta: HashMap::new(),
            }
        }

        fn add_ball(&mut self, id: u32, handle: u16, pos: [f32; 3], vel: [f32; 3]) {
            self.bodies.push(ball(id, pos, vel));
            self.body_meta
                .insert(id, BodyMeta { handle, shape_type: SHAPE_SPHERE, half_extents_m: [0.2; 3] });
        }

        fn build(
            &mut self,
            interest: &mut RecipientInterest,
            config: &SnapshotConfig,
            support: Option<SupportInput>,
        ) -> protocol::SnapshotV2Packet {
            let world = SnapshotWorld {
                server_tick: self.tick,
                server_time_us: u64::from(self.tick) * 16_666,
                server_wall_us: self.tick * 16_666,
                players: &self.players,
                bodies: &self.bodies,
                vehicles: &self.vehicles,
                player_handles: &self.player_handles,
                vehicle_handles: &self.vehicle_handles,
                body_meta: &self.body_meta,
            };
            let recipient = RecipientInput { id: RECIPIENT, ack_input_seq: 0, support };
            let (packet, _) = build_recipient_snapshot(&world, &recipient, interest, true, config).unwrap();
            self.tick += 1;
            match packet {
                ServerPacket::SnapshotV2(packet) => packet,
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn a_body_retired_after_it_was_sent_is_named_in_the_next_snapshots() {
        let mut scene = Scene::new();
        scene.add_ball(7, 3, [5.0, 1.0, 0.0], [10.0, 0.0, 0.0]);
        let mut interest = RecipientInterest::default();
        let first = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert_eq!(first.sphere_states.len(), 1);
        assert!(first.removals.is_empty());
        // Retired by the server: gone from the world.
        scene.bodies.clear();
        let retired_at = scene.tick;
        let mut seen = Vec::new();
        for _ in 0..(SNAPSHOT_REMOVAL_REPEATS as usize + 2) {
            let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
            seen.push((packet.server_tick, packet.removals.clone()));
        }
        for (i, (tick, removals)) in seen.iter().enumerate() {
            if i < SNAPSHOT_REMOVAL_REPEATS as usize {
                assert_eq!(removals.len(), 1, "snapshot {tick}");
                assert_eq!(removals[0].handle, 3);
                assert_eq!(*tick - u32::from(removals[0].age_ticks), retired_at);
            } else {
                assert!(removals.is_empty(), "restated only {} times", SNAPSHOT_REMOVAL_REPEATS);
            }
        }
    }

    #[test]
    fn a_body_never_sent_is_never_named_and_one_that_returns_is_sent_at_once() {
        let mut scene = Scene::new();
        let mut interest = RecipientInterest::default();
        // In interest, never sent: a body the client never heard of.
        scene.add_ball(7, 3, [5.0, 1.0, 0.0], [0.0; 3]);
        interest.visible_dynamic_bodies.insert(7);
        interest.last_sent_dynamic_tick.insert(7, scene.tick);
        interest.last_sent_dynamic_body_pose.insert(7, ([5.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]));
        scene.bodies.clear();
        let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert!(packet.removals.is_empty());

        // Sent, leaves interest, comes back 10 ticks later at rest and far
        // (cold, not near): sent at once, not a cold refresh later, and its
        // pending removal is cancelled.
        scene.add_ball(8, 4, [30.0, 1.0, 0.0], [0.0; 3]);
        assert_eq!(scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None).sphere_states.len(), 1);
        scene.bodies[0].1 = [200.0, 1.0, 0.0];
        let left = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert_eq!(left.removals.len(), 1);
        scene.bodies[0].1 = [30.0, 1.0, 0.0];
        let back = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert_eq!(back.sphere_states.len(), 1, "a body back in interest is sent at once");
        assert!(back.removals.is_empty(), "its removal is withdrawn");
    }

    #[test]
    fn a_vehicle_that_leaves_interest_is_named_with_the_vehicle_bit() {
        let mut scene = Scene::new();
        scene.vehicles.push(car(40, [10.0, 0.5, 0.0]));
        scene.vehicle_handles.insert(40, 2);
        let mut interest = RecipientInterest::default();
        assert_eq!(scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None).vehicle_states.len(), 1);
        scene.vehicles[0].1 = [95.0, 0.5, 0.0];
        let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert!(packet.vehicle_states.is_empty());
        assert_eq!(packet.removals.len(), 1);
        assert_eq!(packet.removals[0].handle, SNAPSHOT_V2_REMOVAL_VEHICLE_BIT | 2);
        assert_eq!(packet.removals[0].age_ticks, 0);
    }

    #[test]
    fn an_entity_entering_the_stream_is_in_its_first_three_snapshots_even_at_rest() {
        let mut scene = Scene::new();
        scene.vehicles.push(car(40, [30.0, 0.5, 0.0]));
        scene.vehicle_handles.insert(40, 2);
        scene.add_ball(7, 3, [30.0, 1.0, 5.0], [0.0; 3]);
        let mut interest = RecipientInterest::default();
        let carried = |p: &protocol::SnapshotV2Packet| (p.vehicle_states.len(), p.sphere_states.len());
        let mut seen = Vec::new();
        for _ in 0..5 {
            seen.push(carried(&scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None)));
        }
        assert_eq!(seen, vec![(1, 1), (1, 1), (1, 1), (0, 0), (0, 0)]);
        // The legacy format sends an entity at rest once, then at its refresh.
        let mut interest = RecipientInterest::default();
        let mut seen = Vec::new();
        for _ in 0..3 {
            seen.push(carried(&scene.build(&mut interest, &SnapshotConfig::LEGACY_FORMAT, None)));
        }
        assert_eq!(seen, vec![(1, 1), (0, 0), (0, 0)]);
    }

    #[test]
    fn the_legacy_format_sends_no_removals_and_the_full_self_state() {
        let mut scene = Scene::new();
        scene.add_ball(7, 3, [5.0, 1.0, 0.0], [10.0, 0.0, 0.0]);
        let mut interest = RecipientInterest::default();
        let legacy = SnapshotConfig::LEGACY_FORMAT;
        scene.build(&mut interest, &legacy, None);
        scene.bodies.clear();
        let packet = scene.build(&mut interest, &legacy, None);
        assert!(packet.removals.is_empty());
        assert!(!packet.compact_self);
        let bytes = encode_server_packet(&ServerPacket::SnapshotV2(packet));
        assert_eq!(bytes.len(), SNAPSHOT_V2_HEADER_BYTES + SNAPSHOT_V2_SELF_PLAYER_BYTES + SNAPSHOT_V2_TRAILER_BYTES);
        assert!(interest.streamed_bodies.is_empty() && interest.pending_removals.is_empty());
    }

    #[test]
    fn the_support_block_is_left_out_unless_the_support_moves() {
        let mut scene = Scene::new();
        let mut interest = RecipientInterest::default();
        let still = SupportInput { entity_id: 99, ..Default::default() };
        let size = |p: protocol::SnapshotV2Packet| encode_server_packet(&ServerPacket::SnapshotV2(p)).len();
        let header_trailer = SNAPSHOT_V2_HEADER_BYTES + SNAPSHOT_V2_TRAILER_BYTES;
        // No support, and a support standing still: 12-byte self state.
        assert_eq!(size(scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None)), header_trailer + 12);
        assert_eq!(size(scene.build(&mut interest, &SnapshotConfig::PRODUCTION, Some(still))), header_trailer + 12);
        // A moving support (a platform, a car): the whole block.
        scene.add_ball(99, 5, [0.0, 0.0, 0.0], [0.0; 3]);
        let moving = SupportInput { entity_id: 99, velocity: [1.0, 0.0, 0.0], ..Default::default() };
        let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, Some(moving));
        assert!(!packet.compact_self);
        assert_eq!(packet.self_state.support_handle, 5);
        let spinning = SupportInput { entity_id: 99, angular_velocity: [0.0, 0.5, 0.0], ..Default::default() };
        assert!(!scene.build(&mut interest, &SnapshotConfig::PRODUCTION, Some(spinning)).compact_self);
    }

    #[test]
    fn a_snapshot_with_removals_carries_the_full_self_state_then_the_section() {
        let mut scene = Scene::new();
        scene.add_ball(7, 0x0123, [5.0, 1.0, 0.0], [10.0, 0.0, 0.0]);
        let mut interest = RecipientInterest::default();
        scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        scene.bodies.clear();
        let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
        assert!(packet.compact_self && packet.removals.len() == 1);
        let bytes = encode_server_packet(&ServerPacket::SnapshotV2(packet));
        let section = SNAPSHOT_V2_HEADER_BYTES + SNAPSHOT_V2_SELF_PLAYER_BYTES + SNAPSHOT_V2_TRAILER_BYTES;
        assert_eq!(bytes.len(), section + 2 + 3);
        assert_eq!(bytes[section], SNAPSHOT_V2_REMOVALS_TAG);
        assert_eq!(bytes[section + 1], 1);
        assert_eq!(u16::from_le_bytes([bytes[section + 2], bytes[section + 3]]), 0x0123);
        assert_eq!(bytes[section + 4], 0);
    }

    fn walker(id: u32, pos: [f32; 3], vel: [f32; 3], yaw: f32) -> (u32, [f32; 3], NetPlayerState) {
        (id, pos, make_net_player_state(id, pos, vel, yaw, 0.0, 100, 0, 0.0))
    }

    /// Remote players and vehicles carried by each of `n` snapshots.
    fn carried(scene: &mut Scene, interest: &mut RecipientInterest, config: &SnapshotConfig, n: usize) -> Vec<(usize, usize)> {
        (0..n)
            .map(|_| {
                let p = scene.build(interest, config, None);
                (p.remote_players.len(), p.vehicle_states.len())
            })
            .collect()
    }

    #[test]
    fn a_standing_player_is_sent_until_it_settles_then_at_its_cold_refresh() {
        let mut scene = Scene::new();
        // Grounded and standing: the controller reports a -0.5 m/s ground snap.
        scene.players.push(walker(2, [10.0, 1.0, 0.0], [0.0, -0.5, 0.0], 1.0));
        scene.player_handles.insert(2, 2);
        let mut interest = RecipientInterest::default();
        let mut sent = Vec::new();
        for _ in 0..40 {
            let packet = scene.build(&mut interest, &SnapshotConfig::PRODUCTION, None);
            sent.push(packet.remote_players.first().map(|p| p.vy_cms));
        }
        // New in interest (and not yet known to stand still): sent with its
        // velocity; then standing still, with zero velocity, three times; then
        // not until its refresh 30 ticks after the last send.
        assert_eq!(&sent[..5], &[Some(-50), Some(0), Some(0), Some(0), None]);
        let refreshes: Vec<usize> = (4..40).filter(|&i| sent[i].is_some()).collect();
        assert_eq!(refreshes, vec![33]);
        assert_eq!(sent[33], Some(0));
        // Without it (the format before this change): every snapshot, as reported.
        let mut interest = RecipientInterest::default();
        let legacy = SnapshotConfig { idle_cold: false, ..SnapshotConfig::PRODUCTION };
        assert!(carried(&mut scene, &mut interest, &legacy, 40).iter().all(|&(players, _)| players == 1));
        let packet = scene.build(&mut interest, &legacy, None);
        assert_eq!(packet.remote_players[0].vy_cms, -50);
    }

    #[test]
    fn a_player_that_moves_or_turns_is_sent_at_once() {
        let mut scene = Scene::new();
        scene.players.push(walker(2, [10.0, 1.0, 0.0], [0.0, -0.5, 0.0], 1.0));
        scene.player_handles.insert(2, 2);
        let mut interest = RecipientInterest::default();
        let config = SnapshotConfig::PRODUCTION;
        carried(&mut scene, &mut interest, &config, 10);
        assert_eq!(carried(&mut scene, &mut interest, &config, 1), vec![(0, 0)], "cold");
        // It turns in place: sent the snapshot it does.
        scene.players[1] = walker(2, [10.0, 1.0, 0.0], [0.0, -0.5, 0.0], 1.2);
        let packet = scene.build(&mut interest, &config, None);
        assert_eq!(packet.remote_players.len(), 1);
        assert_eq!(packet.remote_players[0].vy_cms, 0, "standing, turning");
        carried(&mut scene, &mut interest, &config, 5);
        assert_eq!(carried(&mut scene, &mut interest, &config, 1), vec![(0, 0)], "cold again");
        // It steps off: sent the first snapshot it has moved in, with its velocity.
        scene.players[1] = walker(2, [10.05, 1.0, 0.0], [3.0, 0.0, 0.0], 1.2);
        let packet = scene.build(&mut interest, &config, None);
        assert_eq!(packet.remote_players.len(), 1);
        assert_eq!(packet.remote_players[0].vx_cms, 300);
        // A 1 mm shuffle is not a change (under the 2.5 mm wire quantum), but
        // the settle sends still follow the step.
        scene.players[1] = walker(2, [10.051, 1.0, 0.0], [0.0, -0.5, 0.0], 1.2);
        assert_eq!(carried(&mut scene, &mut interest, &config, 5), vec![(1, 0), (1, 0), (1, 0), (0, 0), (0, 0)]);
    }

    #[test]
    fn a_player_back_in_interest_is_sent_at_once() {
        let mut scene = Scene::new();
        scene.players.push(walker(2, [10.0, 1.0, 0.0], [0.0; 3], 0.0));
        scene.player_handles.insert(2, 2);
        let mut interest = RecipientInterest::default();
        let config = SnapshotConfig::PRODUCTION;
        carried(&mut scene, &mut interest, &config, 10);
        scene.players[1] = walker(2, [100.0, 1.0, 0.0], [0.0; 3], 0.0);
        assert_eq!(carried(&mut scene, &mut interest, &config, 1), vec![(0, 0)]);
        scene.players[1] = walker(2, [10.0, 1.0, 0.0], [0.0; 3], 0.0);
        assert_eq!(carried(&mut scene, &mut interest, &config, 1), vec![(1, 0)]);
    }

    #[test]
    fn a_parked_car_with_a_driver_goes_cold_and_is_sent_when_it_moves() {
        let mut scene = Scene::new();
        let mut parked = car(40, [20.0, 0.5, 0.0]);
        parked.2.driver_id = 2;
        scene.vehicles.push(parked);
        scene.vehicle_handles.insert(40, 2);
        scene.players.push(walker(2, [20.0, 1.3, 0.0], [0.0; 3], 0.0));
        scene.player_handles.insert(2, 2);
        let mut interest = RecipientInterest::default();
        let config = SnapshotConfig::PRODUCTION;
        let seen: Vec<usize> = carried(&mut scene, &mut interest, &config, 40).iter().map(|c| c.1).collect();
        assert_eq!(&seen[..4], &[1, 1, 1, 0], "sent as it enters the stream, then cold");
        assert_eq!(seen.iter().sum::<usize>(), 4, "and once more at its 30-tick refresh");
        // The driver pulls away: sent that snapshot.
        scene.vehicles[0].2.vx_cms = 150;
        scene.vehicles[0].2.px_mm += 25;
        assert_eq!(carried(&mut scene, &mut interest, &config, 1)[0].1, 1);
        // Stopped again: settles, then cold; the driver getting out is a change.
        scene.vehicles[0].2.vx_cms = 0;
        let seen: Vec<usize> = carried(&mut scene, &mut interest, &config, 5).iter().map(|c| c.1).collect();
        assert_eq!(seen, vec![1, 1, 1, 0, 0]);
        scene.vehicles[0].2.driver_id = 0;
        assert_eq!(carried(&mut scene, &mut interest, &config, 1)[0].1, 1);
        // Without it: a vehicle with a driver is sent every snapshot.
        let mut interest = RecipientInterest::default();
        scene.vehicles[0].2.driver_id = 2;
        let legacy = SnapshotConfig { idle_cold: false, ..SnapshotConfig::PRODUCTION };
        assert!(carried(&mut scene, &mut interest, &legacy, 40).iter().all(|c| c.1 == 1));
    }

    #[test]
    fn an_older_interest_baseline_reads_the_new_fields_as_empty() {
        let old = r#"{"visible_dynamic_bodies":[3],"last_sent_dynamic_body_pose":{},"last_sent_vehicle_tick":{},"last_sent_dynamic_tick":{"3":10}}"#;
        let interest: RecipientInterest = serde_json::from_str(old).unwrap();
        assert!(interest.streamed_bodies.is_empty() && interest.pending_removals.is_empty());
        assert!(interest.sent_players.is_empty() && interest.sent_vehicles.is_empty());
        let old_config = serde_json::to_value(SnapshotConfig::PRODUCTION).unwrap();
        let mut old_config = old_config.as_object().unwrap().clone();
        old_config.remove("compact_self");
        old_config.remove("removals");
        old_config.remove("idle_cold");
        old_config.remove("cold_player_refresh_ticks");
        let config: SnapshotConfig = serde_json::from_value(serde_json::Value::Object(old_config)).unwrap();
        assert_eq!(config, SnapshotConfig::LEGACY_FORMAT);
    }
}
