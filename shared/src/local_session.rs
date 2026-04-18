use std::collections::VecDeque;

use crate::{
    constants::{
        DYNAMIC_BODY_IMPULSE, HITSCAN_MAX_DISTANCE_M, HIT_ZONE_NONE, MAX_PENDING_INPUTS,
        OUT_OF_BOUNDS_Y_M, PKT_DEBUG_STATS, PKT_FIRE, PKT_INPUT_BUNDLE, PKT_PING, PKT_SHOT_RESULT,
        PKT_SNAPSHOT, PKT_VEHICLE_ENTER, PKT_VEHICLE_EXIT, PKT_WELCOME, PLAYER_EYE_HEIGHT_M,
        RIFLE_FIRE_INTERVAL_MS, SIM_HZ, SNAPSHOT_HZ_LOCAL,
    },
    physics_arena::{MoveConfig, PhysicsArena},
    protocol::*,
    seq::seq_is_newer,
    unit_conv::{i16_to_angle, snorm16_to_f32},
    vehicle::{read_vehicle_debug_snapshot, VehicleDebugSnapshot},
    world_document::WorldDocument,
};
use bytes::{Buf, BufMut, BytesMut};

const LOCAL_PLAYER_ID: u32 = 1;
const LOCAL_RESPAWN_DELAY_MS: u32 = 3_000;

#[derive(Default)]
struct PlayerRuntime {
    pending_inputs: VecDeque<InputCmd>,
    last_applied_input: InputCmd,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    next_allowed_fire_ms: u32,
    respawn_at_ms: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalDeathCause {
    #[allow(dead_code)]
    HpDamage,
    EnergyDepletion,
    OutOfBounds,
}

pub struct LocalSession {
    arena: PhysicsArena,
    connected: bool,
    player: PlayerRuntime,
    queued_shots: Vec<FireCmd>,
    outbound_packets: Vec<Vec<u8>>,
    server_tick: u32,
}

impl LocalSession {
    pub fn new() -> Self {
        Self::from_world_document(WorldDocument::demo()).expect("default world document is valid")
    }

    pub fn from_world_json(world_json: &str) -> Result<Self, String> {
        let world: WorldDocument =
            serde_json::from_str(world_json).map_err(|error| error.to_string())?;
        Self::from_world_document(world)
    }

    pub fn from_world_document(world: WorldDocument) -> Result<Self, String> {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .map_err(|error| error.to_string())?;

        Ok(Self {
            arena,
            connected: false,
            player: PlayerRuntime::default(),
            queued_shots: Vec::new(),
            outbound_packets: Vec::new(),
            server_tick: 0,
        })
    }

    pub fn connect(&mut self) {
        if self.connected {
            return;
        }

        self.connected = true;
        self.player = PlayerRuntime::default();
        self.arena.spawn_player(LOCAL_PLAYER_ID);

        let server_time_us = self.server_time_us();
        self.outbound_packets
            .push(encode_welcome_packet(&WelcomePacket {
                player_id: LOCAL_PLAYER_ID,
                sim_hz: SIM_HZ,
                snapshot_hz: SNAPSHOT_HZ_LOCAL,
                server_time_us,
                interpolation_delay_ms: 0,
            }));
    }

    pub fn disconnect(&mut self) {
        if !self.connected {
            return;
        }
        self.connected = false;
        self.queued_shots.clear();
        self.player = PlayerRuntime::default();
        self.outbound_packets.clear();
        self.arena.remove_player(LOCAL_PLAYER_ID);
    }

    pub fn handle_client_packet(&mut self, bytes: &[u8]) -> Result<(), String> {
        if !self.connected {
            return Ok(());
        }
        if bytes.is_empty() {
            return Err("empty client packet".to_string());
        }

        let mut buf = bytes;
        let kind = buf.get_u8();
        match kind {
            PKT_INPUT_BUNDLE => {
                let frames = decode_input_bundle_frames(&mut buf)?;
                enqueue_inputs(&mut self.player, frames);
            }
            PKT_FIRE => {
                self.queued_shots.push(decode_fire_cmd(&mut buf)?);
            }
            PKT_VEHICLE_ENTER => {
                let vehicle_id = decode_vehicle_enter(&mut buf)?;
                if self.arena.vehicles.contains_key(&vehicle_id) {
                    self.arena.enter_vehicle(LOCAL_PLAYER_ID, vehicle_id);
                }
            }
            PKT_VEHICLE_EXIT => {
                let vehicle_id = decode_vehicle_exit(&mut buf)?;
                if self.arena.vehicle_of_player.get(&LOCAL_PLAYER_ID) == Some(&vehicle_id) {
                    self.arena.exit_vehicle(LOCAL_PLAYER_ID);
                }
            }
            PKT_PING | PKT_DEBUG_STATS => {}
            other => return Err(format!("unsupported local session packet kind {other}")),
        }
        Ok(())
    }

    pub fn enqueue_input(&mut self, input: InputCmd) {
        if !self.connected {
            return;
        }
        enqueue_inputs(&mut self.player, vec![input]);
    }

    pub fn queue_fire_cmd(&mut self, cmd: FireCmd) {
        if !self.connected {
            return;
        }
        self.queued_shots.push(cmd);
    }

    pub fn enter_vehicle(&mut self, vehicle_id: u32) {
        if !self.connected {
            return;
        }
        if self.arena.vehicles.contains_key(&vehicle_id) {
            self.arena.enter_vehicle(LOCAL_PLAYER_ID, vehicle_id);
        }
    }

    pub fn exit_vehicle(&mut self, vehicle_id: u32) {
        if !self.connected {
            return;
        }
        if self.arena.vehicle_of_player.get(&LOCAL_PLAYER_ID) == Some(&vehicle_id) {
            self.arena.exit_vehicle(LOCAL_PLAYER_ID);
        }
    }

    pub fn tick(&mut self, dt: f32) {
        if !self.connected {
            return;
        }

        self.server_tick += 1;
        let server_time_ms = self.server_time_ms();

        self.process_respawn(server_time_ms);

        let input = take_input_for_tick(&mut self.player);
        self.arena.simulate_player_tick(LOCAL_PLAYER_ID, &input, dt);
        self.arena.step_vehicles_and_dynamics(dt);
        self.process_hitscan(server_time_ms);

        let gained_energy: f32 = self
            .arena
            .collect_batteries_for_player(LOCAL_PLAYER_ID)
            .into_iter()
            .map(|(_, energy)| energy)
            .sum();
        if gained_energy > 0.0 {
            if let Some(player) = self.arena.players.get_mut(&LOCAL_PLAYER_ID) {
                player.energy += gained_energy;
            }
        }
        let depleted = self.arena.apply_vehicle_energy_drain(dt);
        if depleted.contains(&LOCAL_PLAYER_ID) {
            self.kill_local_player(server_time_ms, LocalDeathCause::EnergyDepletion);
        }

        if let Some((position, _, _, _, hp, _)) = self.arena.snapshot_player(LOCAL_PLAYER_ID) {
            if hp > 0 && position[1] < OUT_OF_BOUNDS_Y_M {
                self.kill_local_player(server_time_ms, LocalDeathCause::OutOfBounds);
            }
        }

        if self.server_tick % (SIM_HZ as u32 / SNAPSHOT_HZ_LOCAL as u32) == 0 {
            self.outbound_packets.push(self.build_snapshot_packet());
        }
    }

    fn process_respawn(&mut self, server_time_ms: u32) {
        let Some(deadline) = self.player.respawn_at_ms else {
            return;
        };
        if deadline > server_time_ms {
            return;
        }
        self.player.respawn_at_ms = None;
        self.player.pending_inputs.clear();
        self.player.last_applied_input = InputCmd::default();
        let _ = self.arena.respawn_player(LOCAL_PLAYER_ID);
    }

    fn kill_local_player(&mut self, server_time_ms: u32, cause: LocalDeathCause) {
        let battery_drop = if matches!(cause, LocalDeathCause::HpDamage) {
            self.arena.players.get(&LOCAL_PLAYER_ID).and_then(|player| {
                if !player.dead && player.energy > 0.0 {
                    Some((player.position, player.energy))
                } else {
                    None
                }
            })
        } else {
            None
        };

        self.arena.exit_vehicle(LOCAL_PLAYER_ID);
        self.arena.set_player_dead(LOCAL_PLAYER_ID, true);
        if let Some((position, energy)) = battery_drop {
            let _ = self.arena.spawn_battery(
                position,
                energy,
                crate::constants::DEFAULT_BATTERY_RADIUS_M,
                crate::constants::DEFAULT_BATTERY_HEIGHT_M,
            );
        }
        if let Some(player) = self.arena.players.get_mut(&LOCAL_PLAYER_ID) {
            player.energy = 0.0;
        }
        self.player.respawn_at_ms = Some(server_time_ms.saturating_add(LOCAL_RESPAWN_DELAY_MS));
        self.player.pending_inputs.clear();
        self.player.last_applied_input = InputCmd::default();
    }

    pub fn drain_packets(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.outbound_packets)
    }

    pub fn drain_packet_blob(&mut self) -> Vec<u8> {
        let packets = self.drain_packets();
        let total_len = packets.iter().map(|pkt| 4 + pkt.len()).sum();
        let mut out = BytesMut::with_capacity(total_len);
        for packet in packets {
            out.put_u32_le(packet.len() as u32);
            out.extend_from_slice(&packet);
        }
        out.to_vec()
    }

    fn process_hitscan(&mut self, server_time_ms: u32) {
        let shots = std::mem::take(&mut self.queued_shots);
        for shot in shots {
            if self.player.next_allowed_fire_ms > server_time_ms {
                continue;
            }
            self.player.next_allowed_fire_ms =
                server_time_ms.saturating_add(RIFLE_FIRE_INTERVAL_MS);

            if self.arena.vehicle_of_player.contains_key(&LOCAL_PLAYER_ID) {
                continue;
            }
            let Some((pos, _vel, _yaw, _pitch, hp, _flags)) =
                self.arena.snapshot_player(LOCAL_PLAYER_ID)
            else {
                continue;
            };
            if hp == 0 {
                continue;
            }

            let mut depleted = false;
            if let Some(player) = self.arena.players.get_mut(&LOCAL_PLAYER_ID) {
                if player.dead {
                    continue;
                }
                player.energy = (player.energy - crate::constants::RIFLE_SHOT_ENERGY_COST).max(0.0);
                depleted = player.energy <= 0.0;
            }
            if depleted {
                self.kill_local_player(server_time_ms, LocalDeathCause::EnergyDepletion);
                continue;
            }

            let origin = [pos[0], pos[1] + PLAYER_EYE_HEIGHT_M, pos[2]];
            let world_toi = self.arena.cast_static_world_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(LOCAL_PLAYER_ID),
            );
            let dynamic_hit = self.arena.cast_dynamic_body_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(LOCAL_PLAYER_ID),
            );

            let result = if let Some((dynamic_body_id, dynamic_toi, normal)) = dynamic_hit {
                if world_toi.map(|world| world < dynamic_toi).unwrap_or(false) {
                    make_shot_result(
                        shot.shot_id,
                        shot.weapon,
                        SHOT_RESOLUTION_BLOCKED_BY_WORLD,
                        0,
                        0.0,
                        0.0,
                    )
                } else {
                    let impact_point = [
                        origin[0] + shot.dir[0] * dynamic_toi,
                        origin[1] + shot.dir[1] * dynamic_toi,
                        origin[2] + shot.dir[2] * dynamic_toi,
                    ];
                    let impulse = [
                        shot.dir[0] * DYNAMIC_BODY_IMPULSE + normal[0] * 0.5,
                        shot.dir[1] * DYNAMIC_BODY_IMPULSE + normal[1] * 0.5,
                        shot.dir[2] * DYNAMIC_BODY_IMPULSE + normal[2] * 0.5,
                    ];
                    let _ = self.arena.apply_dynamic_body_impulse(
                        dynamic_body_id,
                        impulse,
                        impact_point,
                    );
                    make_shot_result(
                        shot.shot_id,
                        shot.weapon,
                        SHOT_RESOLUTION_DYNAMIC,
                        dynamic_body_id,
                        dynamic_toi,
                        DYNAMIC_BODY_IMPULSE,
                    )
                }
            } else {
                make_shot_result(shot.shot_id, shot.weapon, SHOT_RESOLUTION_MISS, 0, 0.0, 0.0)
            };

            self.outbound_packets
                .push(encode_shot_result_packet(&result));
        }
    }

    fn build_snapshot_packet(&self) -> Vec<u8> {
        let mut player_states = Vec::new();
        if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(LOCAL_PLAYER_ID)
        {
            let energy = self.arena.player_energy(LOCAL_PLAYER_ID).unwrap_or(0.0);
            player_states.push(make_net_player_state(
                LOCAL_PLAYER_ID,
                pos,
                vel,
                yaw,
                pitch,
                hp,
                flags,
                energy,
            ));
        }

        let dynamic_body_states = self
            .arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(|(id, pos, quat, he, vel, angvel, shape_type)| {
                make_net_dynamic_body_state(id, pos, quat, he, vel, angvel, shape_type)
            })
            .collect();
        let vehicle_states = self.arena.snapshot_vehicles();

        encode_snapshot_packet(&SnapshotPacket {
            server_time_us: self.server_time_us(),
            server_tick: self.server_tick,
            ack_input_seq: self.player.last_ack_input_seq,
            player_states,
            projectile_states: Vec::new(),
            dynamic_body_states,
            vehicle_states,
        })
    }

    fn server_time_ms(&self) -> u32 {
        self.server_tick * (1000 / SIM_HZ as u32)
    }

    pub fn server_time_us(&self) -> u64 {
        (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64)
    }

    pub fn server_tick(&self) -> u32 {
        self.server_tick
    }

    pub fn player_id(&self) -> u32 {
        LOCAL_PLAYER_ID
    }

    pub fn ack_input_seq(&self) -> u16 {
        self.player.last_ack_input_seq
    }

    pub fn local_player_state(&self) -> Option<NetPlayerState> {
        let (pos, vel, yaw, pitch, hp, flags) = self.arena.snapshot_player(LOCAL_PLAYER_ID)?;
        let energy = self.arena.player_energy(LOCAL_PLAYER_ID).unwrap_or(0.0);
        Some(make_net_player_state(
            LOCAL_PLAYER_ID,
            pos,
            vel,
            yaw,
            pitch,
            hp,
            flags,
            energy,
        ))
    }

    pub fn dynamic_body_states(&self) -> Vec<NetDynamicBodyState> {
        self.arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(|(id, pos, quat, he, vel, angvel, shape_type)| {
                make_net_dynamic_body_state(id, pos, quat, he, vel, angvel, shape_type)
            })
            .collect()
    }

    pub fn vehicle_states(&self) -> Vec<NetVehicleState> {
        self.arena.snapshot_vehicles()
    }

    pub fn battery_states(&self) -> Vec<NetBatteryState> {
        self.arena
            .snapshot_batteries()
            .into_iter()
            .map(|(id, pos, energy, radius, height)| {
                make_net_battery_state(id, pos, energy, radius, height)
            })
            .collect()
    }

    pub fn cast_scene_ray(&self, origin: [f32; 3], dir: [f32; 3], max_toi: f32) -> Option<f32> {
        self.arena
            .cast_static_world_ray(origin, dir, max_toi, Some(LOCAL_PLAYER_ID))
    }

    pub fn vehicle_debug(&self, vehicle_id: u32) -> Option<VehicleDebugSnapshot> {
        let vehicle = self.arena.vehicles.get(&vehicle_id)?;
        read_vehicle_debug_snapshot(
            &self.arena.dynamic.sim,
            vehicle.chassis_body,
            &vehicle.controller,
        )
    }
}

fn take_input_for_tick(runtime: &mut PlayerRuntime) -> InputCmd {
    if let Some(input) = runtime.pending_inputs.pop_front() {
        runtime.last_ack_input_seq = input.seq;
        runtime.last_applied_input = input.clone();
        return input;
    }
    runtime.last_applied_input.clone()
}

fn enqueue_inputs(runtime: &mut PlayerRuntime, cmds: Vec<InputCmd>) {
    for cmd in cmds {
        let is_new = runtime
            .last_received_input_seq
            .map(|last| seq_is_newer(cmd.seq, last))
            .unwrap_or(true);
        if !is_new {
            continue;
        }
        runtime.last_received_input_seq = Some(cmd.seq);
        runtime.pending_inputs.push_back(cmd);
        while runtime.pending_inputs.len() > MAX_PENDING_INPUTS {
            runtime.pending_inputs.pop_front();
        }
    }
}

fn make_shot_result(
    shot_id: u32,
    weapon: u8,
    server_resolution: u8,
    server_dynamic_body_id: u32,
    server_dynamic_hit_toi_m: f32,
    server_dynamic_impulse_mag: f32,
) -> ShotResultPacket {
    ShotResultPacket {
        shot_id,
        weapon,
        confirmed: false,
        hit_player_id: 0,
        hit_zone: HIT_ZONE_NONE,
        server_resolution,
        server_dynamic_body_id,
        server_dynamic_hit_toi_cm: (server_dynamic_hit_toi_m.max(0.0) * 100.0)
            .round()
            .clamp(0.0, u16::MAX as f32) as u16,
        server_dynamic_impulse_centi: (server_dynamic_impulse_mag.max(0.0) * 100.0)
            .round()
            .clamp(0.0, u16::MAX as f32) as u16,
    }
}

fn decode_input_bundle_frames(buf: &mut &[u8]) -> Result<Vec<InputCmd>, String> {
    if !buf.has_remaining() {
        return Err("short input bundle".to_string());
    }
    let count = buf.get_u8() as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if buf.remaining() < 10 {
            return Err("truncated input frame".to_string());
        }
        out.push(InputCmd {
            seq: buf.get_u16_le(),
            buttons: buf.get_u16_le(),
            move_x: buf.get_i8(),
            move_y: buf.get_i8(),
            yaw: i16_to_angle(buf.get_i16_le()),
            pitch: i16_to_angle(buf.get_i16_le()),
        });
    }
    Ok(out)
}

fn decode_fire_cmd(buf: &mut &[u8]) -> Result<FireCmd, String> {
    if buf.remaining() < 25 {
        return Err("short fire packet".to_string());
    }
    Ok(FireCmd {
        seq: buf.get_u16_le(),
        shot_id: buf.get_u32_le(),
        weapon: buf.get_u8(),
        client_fire_time_us: buf.get_u64_le(),
        client_interp_ms: buf.get_u16_le(),
        client_dynamic_interp_ms: buf.get_u16_le(),
        dir: [
            snorm16_to_f32(buf.get_i16_le()),
            snorm16_to_f32(buf.get_i16_le()),
            snorm16_to_f32(buf.get_i16_le()),
        ],
    })
}

fn decode_vehicle_enter(buf: &mut &[u8]) -> Result<u32, String> {
    if buf.remaining() < 5 {
        return Err("short vehicle enter packet".to_string());
    }
    let vehicle_id = buf.get_u32_le();
    let _seat = buf.get_u8();
    Ok(vehicle_id)
}

fn decode_vehicle_exit(buf: &mut &[u8]) -> Result<u32, String> {
    if buf.remaining() < 4 {
        return Err("short vehicle exit packet".to_string());
    }
    Ok(buf.get_u32_le())
}

fn encode_welcome_packet(pkt: &WelcomePacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(19);
    out.put_u8(PKT_WELCOME);
    out.put_u32_le(pkt.player_id);
    out.put_u16_le(pkt.sim_hz);
    out.put_u16_le(pkt.snapshot_hz);
    out.put_u64_le(pkt.server_time_us);
    out.put_u16_le(pkt.interpolation_delay_ms);
    out.to_vec()
}

fn encode_shot_result_packet(pkt: &ShotResultPacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(20);
    out.put_u8(PKT_SHOT_RESULT);
    out.put_u32_le(pkt.shot_id);
    out.put_u8(pkt.weapon);
    out.put_u8(pkt.confirmed as u8);
    out.put_u32_le(pkt.hit_player_id);
    out.put_u8(pkt.hit_zone);
    out.put_u8(pkt.server_resolution);
    out.put_u32_le(pkt.server_dynamic_body_id);
    out.put_u16_le(pkt.server_dynamic_hit_toi_cm);
    out.put_u16_le(pkt.server_dynamic_impulse_centi);
    out.to_vec()
}

fn encode_snapshot_packet(pkt: &SnapshotPacket) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(2048);
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
        out.put_u8(p.hp);
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
        out.put_i16_le(d.wx_mrads);
        out.put_i16_le(d.wy_mrads);
        out.put_i16_le(d.wz_mrads);
    }
    for v in &pkt.vehicle_states {
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
        for wheel in v.wheel_data {
            out.put_u16_le(wheel);
        }
    }
    out.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::BTN_FORWARD;
    use crate::physics_arena::{MoveConfig, PhysicsArena};
    use crate::unit_conv::angle_to_i16;
    use crate::world_document::{
        DynamicEntity, DynamicEntityKind, WorldDocument, WorldMeta, WorldTerrain, WorldTerrainTile,
    };
    const BROKEN_WORLD_DOCUMENT_JSON: &str = include_str!("../../worlds/broken.world.json");

    fn decode_snapshot_ack(bytes: &[u8]) -> u16 {
        let mut buf = bytes;
        assert_eq!(buf.get_u8(), PKT_SNAPSHOT);
        let _server_time = buf.get_u64_le();
        let _server_tick = buf.get_u32_le();
        buf.get_u16_le()
    }

    fn encode_single_input_bundle(input: &InputCmd) -> Vec<u8> {
        let mut out = BytesMut::with_capacity(12);
        out.put_u8(PKT_INPUT_BUNDLE);
        out.put_u8(1);
        out.put_u16_le(input.seq);
        out.put_u16_le(input.buttons);
        out.put_i8(input.move_x);
        out.put_i8(input.move_y);
        out.put_i16_le(angle_to_i16(input.yaw));
        out.put_i16_le(angle_to_i16(input.pitch));
        out.to_vec()
    }

    fn encode_vehicle_enter_packet_for_test(vehicle_id: u32) -> Vec<u8> {
        let mut out = BytesMut::with_capacity(6);
        out.put_u8(PKT_VEHICLE_ENTER);
        out.put_u32_le(vehicle_id);
        out.put_u8(0);
        out.to_vec()
    }

    fn decode_snapshot_vehicle_states(bytes: &[u8]) -> Vec<(u32, u32, i32, i32, i32)> {
        let mut buf = bytes;
        assert_eq!(buf.get_u8(), PKT_SNAPSHOT);
        let _server_time = buf.get_u64_le();
        let _server_tick = buf.get_u32_le();
        let _ack = buf.get_u16_le();
        let player_count = buf.get_u16_le() as usize;
        let projectile_count = buf.get_u16_le() as usize;
        let dynamic_count = buf.get_u16_le() as usize;
        let vehicle_count = buf.get_u16_le() as usize;

        for _ in 0..player_count {
            buf.advance(29);
        }
        for _ in 0..projectile_count {
            buf.advance(31);
        }
        for _ in 0..dynamic_count {
            buf.advance(43);
        }

        let mut vehicles = Vec::with_capacity(vehicle_count);
        for _ in 0..vehicle_count {
            let id = buf.get_u32_le();
            let _vehicle_type = buf.get_u8();
            let _flags = buf.get_u8();
            let driver_id = buf.get_u32_le();
            let px = buf.get_i32_le();
            let py = buf.get_i32_le();
            let pz = buf.get_i32_le();
            buf.advance(20);
            for _ in 0..4 {
                let _wheel = buf.get_u16_le();
            }
            vehicles.push((id, driver_id, px, py, pz));
        }
        vehicles
    }

    fn make_smooth_hill_world() -> WorldDocument {
        let grid_size = 9usize;
        let mut heights = Vec::with_capacity(grid_size * grid_size);
        for row in 0..grid_size {
            for col in 0..grid_size {
                let dx = col as f32 - 4.0;
                let dz = row as f32 - 4.0;
                let dist = (dx * dx + dz * dz).sqrt();
                heights.push((5.0 - dist * 1.25).max(0.0));
            }
        }
        WorldDocument {
            version: 2,
            meta: WorldMeta {
                name: "Smooth Hill".to_string(),
                description: "Brush-like hill for local session tests.".to_string(),
            },
            terrain: WorldTerrain {
                tile_grid_size: grid_size as u16,
                tile_half_extent_m: 10.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
        }
    }

    fn make_flat_test_world() -> WorldDocument {
        WorldDocument {
            version: 2,
            meta: WorldMeta {
                name: "Flat Test".to_string(),
                description: "Minimal local session test fixture.".to_string(),
            },
            terrain: WorldTerrain {
                tile_grid_size: 2,
                tile_half_extent_m: 10.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights: vec![0.0; 4],
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
        }
    }

    fn isolated_energy_session() -> LocalSession {
        let mut session =
            LocalSession::from_world_document(make_flat_test_world()).expect("valid flat world");
        session.connect();
        let _ = session.drain_packets();
        session
    }

    fn broken_world() -> WorldDocument {
        serde_json::from_str(BROKEN_WORLD_DOCUMENT_JSON)
            .expect("broken world document asset should deserialize")
    }

    fn terrain_height_for_world(world: &WorldDocument, x: f32, z: f32) -> f32 {
        world.sample_heightfield_surface_at_world_position(x, z)
    }

    #[test]
    fn connect_queues_welcome_packet() {
        let mut session = LocalSession::new();
        session.connect();

        let packets = session.drain_packets();
        assert!(!packets.is_empty());
        assert_eq!(packets[0][0], PKT_WELCOME);
    }

    #[test]
    fn connect_spawns_local_player_with_starting_energy() {
        let mut session = LocalSession::new();
        session.connect();

        let player = session
            .local_player_state()
            .expect("local player should exist after connect");
        assert_eq!(
            player.energy_centi,
            energy_to_centi(crate::constants::STARTING_ENERGY)
        );
    }

    #[test]
    fn tick_acknowledges_latest_input_in_snapshot() {
        let mut session = LocalSession::new();
        session.connect();
        let _ = session.drain_packets();

        let input = InputCmd {
            seq: 7,
            buttons: BTN_FORWARD,
            move_x: 0,
            move_y: 127,
            yaw: 0.0,
            pitch: 0.0,
        };
        let bytes = encode_single_input_bundle(&input);
        session.handle_client_packet(&bytes).unwrap();

        session.tick(1.0 / 60.0);
        session.tick(1.0 / 60.0);
        let packets = session.drain_packets();
        let snapshot = packets
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .unwrap();
        assert_eq!(decode_snapshot_ack(&snapshot), 7);
    }

    #[test]
    fn local_session_can_enter_authored_vehicle() {
        let mut session = LocalSession::new();
        session.connect();
        let _ = session.drain_packets();

        session.tick(1.0 / 60.0);
        let initial_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("initial local session snapshot");
        let initial_vehicle = decode_snapshot_vehicle_states(&initial_snapshot);
        assert!(
            !initial_vehicle.is_empty(),
            "demo local session should expose at least one vehicle"
        );
        let (vehicle_id, driver_id, _, _, _) = initial_vehicle[0];
        assert_eq!(driver_id, 0, "authored vehicle should start unoccupied");

        session
            .handle_client_packet(&encode_vehicle_enter_packet_for_test(vehicle_id))
            .unwrap();

        session.tick(1.0 / 60.0);

        let latest_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("latest local session snapshot");
        let latest_vehicle = decode_snapshot_vehicle_states(&latest_snapshot);
        assert_eq!(latest_vehicle.len(), initial_vehicle.len());
        let entered = latest_vehicle
            .iter()
            .find(|(id, _, _, _, _)| *id == vehicle_id)
            .expect("entered vehicle should still be present");
        assert_eq!(
            entered.1, LOCAL_PLAYER_ID,
            "local session vehicle should be driven by the local player after enter"
        );
    }

    #[test]
    fn hp_death_drops_battery_with_remaining_energy() {
        let mut session = isolated_energy_session();

        let remaining_energy = 321.5;
        session
            .arena
            .players
            .get_mut(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .energy = remaining_energy;

        session.kill_local_player(session.server_time_ms(), LocalDeathCause::HpDamage);

        let batteries = session.battery_states();
        assert_eq!(
            batteries.len(),
            1,
            "hp death should spawn exactly one battery"
        );
        assert_eq!(batteries[0].energy_centi, energy_to_centi(remaining_energy));
        assert_eq!(
            session
                .local_player_state()
                .expect("player state should still be queryable")
                .energy_centi,
            0,
            "corpse energy should be zeroed after battery drop"
        );
    }

    #[test]
    fn rifle_energy_depletion_death_does_not_drop_battery() {
        let mut session = isolated_energy_session();

        session
            .arena
            .players
            .get_mut(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .energy = crate::constants::RIFLE_SHOT_ENERGY_COST;

        session.queue_fire_cmd(FireCmd {
            seq: 1,
            shot_id: 7,
            weapon: 1,
            client_fire_time_us: session.server_time_us(),
            client_interp_ms: 0,
            client_dynamic_interp_ms: 0,
            dir: [1.0, 0.0, 0.0],
        });
        session.process_hitscan(session.server_time_ms());

        assert!(
            session.battery_states().is_empty(),
            "energy depletion deaths should not drop a battery"
        );
        let player = session
            .arena
            .players
            .get(&LOCAL_PLAYER_ID)
            .expect("local player exists");
        assert!(player.dead, "energy depletion should kill the player");
        assert_eq!(
            player.energy, 0.0,
            "energy should clamp to zero on depletion"
        );
    }

    #[test]
    fn overlapping_battery_pickup_restores_energy_and_removes_battery() {
        let mut session = isolated_energy_session();

        let player_position = session
            .arena
            .players
            .get(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .position;
        session
            .arena
            .players
            .get_mut(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .energy = 100.0;
        let _ = session.arena.spawn_battery(
            player_position,
            42.5,
            crate::constants::DEFAULT_BATTERY_RADIUS_M,
            crate::constants::DEFAULT_BATTERY_HEIGHT_M,
        );

        session.tick(1.0 / 60.0);

        assert!(
            session.battery_states().is_empty(),
            "picked-up battery should be removed from the world"
        );
        assert_eq!(
            session
                .local_player_state()
                .expect("local player state")
                .energy_centi,
            energy_to_centi(142.5)
        );
    }

    fn local_session_keeps_smooth_hill_vehicle_supported() {
        let mut world = make_smooth_hill_world();
        let hill_x = 0.0f32;
        let hill_z = 0.0f32;
        let vehicle_x = hill_x + 1.5;
        let vehicle_y = world.sample_heightfield_surface_at_world_position(vehicle_x, hill_z) + 3.0;
        world.dynamic_entities = vec![DynamicEntity {
            id: 32,
            kind: DynamicEntityKind::Vehicle,
            position: [vehicle_x, vehicle_y, hill_z],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: None,
            radius: None,
            vehicle_type: Some(0),
            energy: None,
            height: None,
        }];

        let mut session = LocalSession::from_world_document(world.clone()).expect("valid world");
        session.connect();
        let _ = session.drain_packets();

        let mut latest_snapshot = None;
        for _ in 0..240 {
            session.tick(1.0 / 60.0);
            latest_snapshot = session
                .drain_packets()
                .into_iter()
                .find(|pkt| pkt[0] == PKT_SNAPSHOT)
                .or(latest_snapshot);
        }

        let latest_snapshot = latest_snapshot.expect("latest snapshot");
        let vehicles = decode_snapshot_vehicle_states(&latest_snapshot);
        let (_, _, px_mm, py_mm, pz_mm) = vehicles
            .into_iter()
            .find(|(id, ..)| *id == 32)
            .expect("vehicle present");
        let px = px_mm as f32 / 1000.0;
        let py = py_mm as f32 / 1000.0;
        let pz = pz_mm as f32 / 1000.0;
        let terrain_y = world.sample_heightfield_surface_at_world_position(px, pz);
        assert!(
            py > terrain_y - 0.25,
            "local session hill vehicle fell through terrain: pos=({px:.3}, {py:.3}, {pz:.3}) terrain_y={terrain_y:.3}",
        );
    }

    #[test]
    fn physics_arena_with_spawned_player_keeps_broken_world_authored_dynamics_supported() {
        let world = broken_world();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate broken world");
        arena.spawn_player(1);

        for _ in 0..360 {
            let _ = arena.simulate_player_tick(1, &InputCmd::default(), 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        for entity in &world.dynamic_entities {
            match entity.kind {
                DynamicEntityKind::Vehicle => {
                    let vehicle = arena
                        .snapshot_vehicles()
                        .into_iter()
                        .find(|vehicle| vehicle.id == entity.id)
                        .expect("authored vehicle should exist");
                    let px = vehicle.px_mm as f32 / 1000.0;
                    let py = vehicle.py_mm as f32 / 1000.0;
                    let pz = vehicle.pz_mm as f32 / 1000.0;
                    let terrain_y = terrain_height_for_world(&world, px, pz);
                    assert!(
                        py > terrain_y - 0.25,
                        "arena+player vehicle {} fell through: pos=({px:.3}, {py:.3}, {pz:.3}) terrain_y={terrain_y:.3}",
                        entity.id,
                    );
                }
                _ => {
                    let body = arena
                        .snapshot_dynamic_bodies()
                        .into_iter()
                        .find(|(id, ..)| *id == entity.id)
                        .expect("authored dynamic body should exist");
                    let terrain_y = terrain_height_for_world(&world, body.1[0], body.1[2]);
                    assert!(
                        body.1[1] > terrain_y - 0.25,
                        "arena+player {} {} fell through: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
                        match entity.kind {
                            DynamicEntityKind::Ball => "ball",
                            DynamicEntityKind::Box => "box",
                            DynamicEntityKind::Vehicle => "vehicle",
                            DynamicEntityKind::Battery => "battery",
                        },
                        entity.id,
                        body.1[0],
                        body.1[1],
                        body.1[2],
                    );
                }
            }
        }
    }

    #[test]
    fn local_session_keeps_broken_world_authored_dynamics_supported() {
        let world = broken_world();
        let mut session = LocalSession::from_world_document(world.clone()).expect("valid world");
        session.connect();
        let _ = session.drain_packets();

        for _ in 0..360 {
            session.tick(1.0 / 60.0);
            let _ = session.drain_packets();
        }

        for state in session.dynamic_body_states() {
            let px = state.px_mm as f32 / 1000.0;
            let py = state.py_mm as f32 / 1000.0;
            let pz = state.pz_mm as f32 / 1000.0;
            let terrain_y = terrain_height_for_world(&world, px, pz);
            assert!(
                py > terrain_y - 0.25,
                "local session dynamic {} fell through: pos=({px:.3}, {py:.3}, {pz:.3}) terrain_y={terrain_y:.3}",
                state.id,
            );
        }

        for vehicle in session.vehicle_states() {
            let px = vehicle.px_mm as f32 / 1000.0;
            let py = vehicle.py_mm as f32 / 1000.0;
            let pz = vehicle.pz_mm as f32 / 1000.0;
            let terrain_y = terrain_height_for_world(&world, px, pz);
            assert!(
                py > terrain_y - 0.25,
                "local session vehicle {} fell through: pos=({px:.3}, {py:.3}, {pz:.3}) terrain_y={terrain_y:.3}",
                vehicle.id,
            );
        }
    }
}
