use std::collections::{HashMap, VecDeque};

use crate::{
    constants::{
        DYNAMIC_BODY_IMPULSE, FLAG_DEAD, HITSCAN_MAX_DISTANCE_M, HIT_ZONE_BODY, HIT_ZONE_HEAD,
        HIT_ZONE_NONE, MAX_PENDING_INPUTS, OUT_OF_BOUNDS_Y_M, PKT_DEBUG_STATS, PKT_FIRE,
        PKT_INPUT_BUNDLE, PKT_PING, PKT_SHOT_RESULT, PKT_SNAPSHOT, PKT_VEHICLE_ENTER,
        PKT_VEHICLE_EXIT, PKT_WELCOME, PLAYER_EYE_HEIGHT_M, RIFLE_FIRE_INTERVAL_MS, SIM_HZ,
        SNAPSHOT_HZ_LOCAL,
    },
    debug_render::{render_debug_buffers, DebugLineBuffers},
    physics_arena::{MoveConfig, PhysicsArena},
    protocol::*,
    seq::seq_is_newer,
    unit_conv::{i16_to_angle, snorm16_to_f32},
    vehicle::{read_vehicle_debug_snapshot, VehicleDebugSnapshot},
    world_document::WorldDocument,
};
use bytes::{Buf, BufMut, BytesMut};
use vibe_netcode::lag_comp::{classify_player_hitscan, HitZone};

pub const LOCAL_PLAYER_ID: u32 = 1;
const HITSCAN_BODY_DAMAGE: u8 = 25;
const HITSCAN_HEAD_DAMAGE: u8 = 100;
const BOT_RESPAWN_TICKS: u32 = 60 * 3;
const LOCAL_RESPAWN_DELAY_MS: u32 = 3_000;

#[cfg(target_arch = "wasm32")]
use crate::destructibles::DestructibleRuntimeConfig;

#[derive(Default)]
struct PlayerRuntime {
    pending_inputs: VecDeque<InputCmd>,
    last_applied_input: InputCmd,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    next_allowed_fire_ms: u32,
    is_bot: bool,
    respawn_cooldown_ticks: u32,
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
    players: HashMap<u32, PlayerRuntime>,
    queued_shots: Vec<(u32, FireCmd)>,
    outbound_packets: Vec<Vec<u8>>,
    server_tick: u32,
}

impl LocalSession {
    pub fn new() -> Self {
        #[cfg(target_arch = "wasm32")]
        {
            return Self::from_world_document_with_destructible_runtime_config(
                WorldDocument::demo(),
                DestructibleRuntimeConfig::default(),
            )
            .expect("default world document is valid");
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            Self::from_world_document(WorldDocument::demo())
                .expect("default world document is valid")
        }
    }

    pub fn from_world_json(world_json: &str) -> Result<Self, String> {
        let world: WorldDocument =
            serde_json::from_str(world_json).map_err(|error| error.to_string())?;
        #[cfg(target_arch = "wasm32")]
        {
            return Self::from_world_document_with_destructible_runtime_config(
                world,
                DestructibleRuntimeConfig::default(),
            );
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            Self::from_world_document(world)
        }
    }

    pub fn from_world_document(world: WorldDocument) -> Result<Self, String> {
        #[cfg(target_arch = "wasm32")]
        {
            return Self::from_world_document_with_destructible_runtime_config(
                world,
                DestructibleRuntimeConfig::default(),
            );
        }

        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut arena = PhysicsArena::new(MoveConfig::default());
            world
                .instantiate(&mut arena)
                .map_err(|error| error.to_string())?;

            Ok(Self {
                arena,
                connected: false,
                players: HashMap::new(),
                queued_shots: Vec::new(),
                outbound_packets: Vec::new(),
                server_tick: 0,
            })
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn from_world_json_with_destructible_runtime_config(
        world_json: &str,
        destructible_runtime_config: DestructibleRuntimeConfig,
    ) -> Result<Self, String> {
        let world: WorldDocument =
            serde_json::from_str(world_json).map_err(|error| error.to_string())?;
        Self::from_world_document_with_destructible_runtime_config(
            world,
            destructible_runtime_config,
        )
    }

    #[cfg(target_arch = "wasm32")]
    pub fn from_world_document_with_destructible_runtime_config(
        world: WorldDocument,
        destructible_runtime_config: DestructibleRuntimeConfig,
    ) -> Result<Self, String> {
        let mut arena = PhysicsArena::new_with_destructible_runtime_config(
            MoveConfig::default(),
            destructible_runtime_config,
        );
        world
            .instantiate(&mut arena)
            .map_err(|error| error.to_string())?;

        Ok(Self {
            arena,
            connected: false,
            players: HashMap::new(),
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
        self.players
            .insert(LOCAL_PLAYER_ID, PlayerRuntime::default());
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
        let ids: Vec<u32> = self.players.keys().copied().collect();
        for id in ids {
            self.arena.remove_player(id);
        }
        self.players.clear();
        self.outbound_packets.clear();
    }

    pub fn connect_bot(&mut self, bot_id: u32) -> bool {
        if !self.connected || bot_id == LOCAL_PLAYER_ID || self.players.contains_key(&bot_id) {
            return false;
        }
        let mut runtime = PlayerRuntime::default();
        runtime.is_bot = true;
        self.players.insert(bot_id, runtime);
        self.arena.spawn_player(bot_id);
        true
    }

    pub fn set_bot_max_speed(&mut self, bot_id: u32, max_speed: Option<f64>) -> bool {
        if bot_id == LOCAL_PLAYER_ID {
            return false;
        }
        let is_bot = self
            .players
            .get(&bot_id)
            .map(|runtime| runtime.is_bot)
            .unwrap_or(false);
        if !is_bot {
            return false;
        }
        self.arena.set_player_max_speed_override(bot_id, max_speed)
    }

    pub fn disconnect_bot(&mut self, bot_id: u32) -> bool {
        if bot_id == LOCAL_PLAYER_ID {
            return false;
        }
        let Some(runtime) = self.players.remove(&bot_id) else {
            return false;
        };
        if !runtime.is_bot {
            self.players.insert(bot_id, runtime);
            return false;
        }
        self.arena.remove_player(bot_id);
        true
    }

    pub fn handle_bot_packet(&mut self, bot_id: u32, bytes: &[u8]) -> Result<(), String> {
        if bot_id == LOCAL_PLAYER_ID {
            return Err("cannot push bot input for local player id".to_string());
        }
        let Some(runtime) = self.players.get_mut(&bot_id) else {
            return Err(format!("unknown bot id {bot_id}"));
        };
        if !runtime.is_bot {
            return Err(format!("player {bot_id} is not a bot"));
        }
        if bytes.is_empty() {
            return Err("empty bot packet".to_string());
        }
        let mut buf = bytes;
        match buf.get_u8() {
            PKT_INPUT_BUNDLE => {
                let frames = decode_input_bundle_frames(&mut buf)?;
                enqueue_inputs(runtime, frames);
                Ok(())
            }
            other => Err(format!("unsupported bot packet kind {other}")),
        }
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
                let Some(runtime) = self.players.get_mut(&LOCAL_PLAYER_ID) else {
                    return Ok(());
                };
                enqueue_inputs(runtime, frames);
            }
            PKT_FIRE => {
                self.queued_shots
                    .push((LOCAL_PLAYER_ID, decode_fire_cmd(&mut buf)?));
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
        if let Some(runtime) = self.players.get_mut(&LOCAL_PLAYER_ID) {
            enqueue_inputs(runtime, vec![input]);
        }
    }

    pub fn queue_fire_cmd(&mut self, cmd: FireCmd) {
        if !self.connected {
            return;
        }
        self.queued_shots.push((LOCAL_PLAYER_ID, cmd));
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

        let mut local_input = InputCmd::default();
        let mut previous_local_input = InputCmd::default();
        let mut local_was_on_ground = false;
        let player_ids: Vec<u32> = self.players.keys().copied().collect();
        for id in player_ids {
            let mut skip_sim = false;
            if let Some(runtime) = self.players.get_mut(&id) {
                if runtime.is_bot && runtime.respawn_cooldown_ticks > 0 {
                    runtime.respawn_cooldown_ticks -= 1;
                    if runtime.respawn_cooldown_ticks == 0 {
                        self.arena.respawn_player(id);
                    } else {
                        skip_sim = true;
                    }
                }
            }
            if skip_sim {
                continue;
            }
            let input = {
                let Some(runtime) = self.players.get_mut(&id) else {
                    continue;
                };
                take_input_for_tick(runtime)
            };
            if id == LOCAL_PLAYER_ID {
                let (previous_input, was_on_ground) = self
                    .arena
                    .players
                    .get(&LOCAL_PLAYER_ID)
                    .map(|state| (state.last_input.clone(), state.on_ground))
                    .unwrap_or_default();
                previous_local_input = previous_input;
                local_was_on_ground = was_on_ground;
                local_input = input.clone();
            }
            self.arena.simulate_player_tick(id, &input, dt);
        }
        self.arena.step_vehicles_and_dynamics(dt);

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
        let depleted_on_foot = self.arena.apply_on_foot_energy_drain(
            LOCAL_PLAYER_ID,
            &previous_local_input,
            &local_input,
            local_was_on_ground,
            dt,
        );
        let depleted = self.arena.apply_vehicle_energy_drain(dt);
        if depleted_on_foot || depleted.contains(&LOCAL_PLAYER_ID) {
            self.kill_local_player(server_time_ms, LocalDeathCause::EnergyDepletion);
        }

        if let Some((position, _, _, _, hp, _)) = self.arena.snapshot_player(LOCAL_PLAYER_ID) {
            if hp > 0 && position[1] < OUT_OF_BOUNDS_Y_M {
                self.kill_local_player(server_time_ms, LocalDeathCause::OutOfBounds);
            }
        }

        self.process_hitscan(server_time_ms);

        if self.server_tick % (SIM_HZ as u32 / SNAPSHOT_HZ_LOCAL as u32) == 0 {
            self.outbound_packets.push(self.build_snapshot_packet());
        }
    }

    fn process_respawn(&mut self, server_time_ms: u32) {
        let Some(deadline) = self
            .players
            .get(&LOCAL_PLAYER_ID)
            .and_then(|runtime| runtime.respawn_at_ms)
        else {
            return;
        };
        if deadline > server_time_ms {
            return;
        }
        if let Some(runtime) = self.players.get_mut(&LOCAL_PLAYER_ID) {
            runtime.respawn_at_ms = None;
            runtime.pending_inputs.clear();
            runtime.last_applied_input = InputCmd::default();
        }
        let _ = self.arena.respawn_player(LOCAL_PLAYER_ID);
    }

    fn kill_local_player(&mut self, server_time_ms: u32, cause: LocalDeathCause) {
        let battery_drop = if matches!(cause, LocalDeathCause::HpDamage) {
            self.arena.players.get(&LOCAL_PLAYER_ID).and_then(|player| {
                if player.energy > 0.0 {
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
        if let Some(runtime) = self.players.get_mut(&LOCAL_PLAYER_ID) {
            runtime.respawn_at_ms = Some(server_time_ms.saturating_add(LOCAL_RESPAWN_DELAY_MS));
            runtime.pending_inputs.clear();
            runtime.last_applied_input = InputCmd::default();
        }
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
        for (shooter_id, shot) in shots {
            {
                let Some(shooter) = self.players.get_mut(&shooter_id) else {
                    continue;
                };
                if shooter.next_allowed_fire_ms > server_time_ms {
                    continue;
                }
                shooter.next_allowed_fire_ms =
                    server_time_ms.saturating_add(RIFLE_FIRE_INTERVAL_MS);
            }

            if self.arena.vehicle_of_player.contains_key(&shooter_id) {
                continue;
            }
            let Some((pos, _vel, _yaw, _pitch, hp, _flags)) =
                self.arena.snapshot_player(shooter_id)
            else {
                continue;
            };
            if hp == 0 {
                continue;
            }

            if shooter_id == LOCAL_PLAYER_ID {
                let mut depleted = false;
                if let Some(player) = self.arena.players.get_mut(&LOCAL_PLAYER_ID) {
                    if player.dead {
                        continue;
                    }
                    player.energy =
                        (player.energy - crate::constants::RIFLE_SHOT_ENERGY_COST).max(0.0);
                    depleted = player.energy <= 0.0;
                }
                if depleted {
                    self.kill_local_player(server_time_ms, LocalDeathCause::EnergyDepletion);
                    continue;
                }
            }

            let origin = [pos[0], pos[1] + PLAYER_EYE_HEIGHT_M, pos[2]];
            let world_toi = self.arena.cast_static_world_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(shooter_id),
            );
            let dynamic_hit = self.arena.cast_dynamic_body_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE_M,
                Some(shooter_id),
            );
            let player_hit = self.cast_player_hitscan(shooter_id, origin, shot.dir);

            let nearest_toi = [
                world_toi,
                dynamic_hit.map(|(_, toi, _)| toi),
                player_hit.map(|(_, toi, _)| toi),
            ]
            .into_iter()
            .flatten()
            .fold(f32::MAX, f32::min);

            let mut result =
                make_shot_result(shot.shot_id, shot.weapon, SHOT_RESOLUTION_MISS, 0, 0.0, 0.0);

            if let Some((victim_id, toi, zone)) = player_hit {
                if toi <= nearest_toi + 1e-3 {
                    result.confirmed = true;
                    result.hit_player_id = victim_id;
                    result.hit_zone = match zone {
                        HitZone::Head => HIT_ZONE_HEAD,
                        HitZone::Body => HIT_ZONE_BODY,
                    };
                    result.server_resolution = SHOT_RESOLUTION_PLAYER;
                    let damage = match zone {
                        HitZone::Head => HITSCAN_HEAD_DAMAGE,
                        HitZone::Body => HITSCAN_BODY_DAMAGE,
                    };
                    self.apply_damage(victim_id, damage, server_time_ms);
                }
            } else if let Some((dynamic_body_id, dynamic_toi, normal)) = dynamic_hit {
                if world_toi.map(|world| world >= dynamic_toi).unwrap_or(true) {
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
                    result.server_resolution = SHOT_RESOLUTION_DYNAMIC;
                    result.server_dynamic_body_id = dynamic_body_id;
                    result.server_dynamic_hit_toi_cm = (dynamic_toi.max(0.0) * 100.0)
                        .round()
                        .clamp(0.0, u16::MAX as f32)
                        as u16;
                    result.server_dynamic_impulse_centi = (DYNAMIC_BODY_IMPULSE.max(0.0) * 100.0)
                        .round()
                        .clamp(0.0, u16::MAX as f32)
                        as u16;
                }
            } else if world_toi.is_some() {
                result.server_resolution = SHOT_RESOLUTION_BLOCKED_BY_WORLD;
            }

            self.outbound_packets
                .push(encode_shot_result_packet(&result));
        }
    }

    fn cast_player_hitscan(
        &self,
        shooter_id: u32,
        origin: [f32; 3],
        dir: [f32; 3],
    ) -> Option<(u32, f32, HitZone)> {
        let capsule_half_segment = self.arena.config().capsule_half_segment;
        let capsule_radius = self.arena.config().capsule_radius;
        let mut best: Option<(u32, f32, HitZone)> = None;
        for &victim_id in self.players.keys() {
            if victim_id == shooter_id {
                continue;
            }
            let Some((pos, _vel, _yaw, _pitch, hp, flags)) = self.arena.snapshot_player(victim_id)
            else {
                continue;
            };
            if hp == 0 || (flags & FLAG_DEAD) != 0 {
                continue;
            }
            let Some(hit) = classify_player_hitscan(
                origin,
                dir,
                pos,
                capsule_half_segment,
                capsule_radius,
                None,
            ) else {
                continue;
            };
            if hit.distance > HITSCAN_MAX_DISTANCE_M {
                continue;
            }
            if best.map(|(_, toi, _)| hit.distance < toi).unwrap_or(true) {
                best = Some((victim_id, hit.distance, hit.zone));
            }
        }
        best
    }

    fn apply_damage(&mut self, victim_id: u32, damage: u8, server_time_ms: u32) {
        let is_bot = self
            .players
            .get(&victim_id)
            .map(|runtime| runtime.is_bot)
            .unwrap_or(false);
        let died = self.arena.apply_player_damage(victim_id, damage);
        if !died {
            return;
        }
        if victim_id == LOCAL_PLAYER_ID {
            self.kill_local_player(server_time_ms, LocalDeathCause::HpDamage);
            return;
        }
        if is_bot {
            if let Some(runtime) = self.players.get_mut(&victim_id) {
                runtime.respawn_cooldown_ticks = BOT_RESPAWN_TICKS;
            }
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
        for (&id, _) in &self.players {
            if id == LOCAL_PLAYER_ID {
                continue;
            }
            if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(id) {
                player_states.push(make_net_player_state(
                    id, pos, vel, yaw, pitch, hp, flags, 0.0,
                ));
            }
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

        let ack_input_seq = self
            .players
            .get(&LOCAL_PLAYER_ID)
            .map(|runtime| runtime.last_ack_input_seq)
            .unwrap_or(0);

        encode_snapshot_packet(&SnapshotPacket {
            server_time_us: self.server_time_us(),
            server_tick: self.server_tick,
            ack_input_seq,
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
        self.players
            .get(&LOCAL_PLAYER_ID)
            .map(|runtime| runtime.last_ack_input_seq)
            .unwrap_or(0)
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

    pub fn remote_player_states(&self) -> Vec<NetPlayerState> {
        let mut ids = self
            .players
            .keys()
            .copied()
            .filter(|id| *id != LOCAL_PLAYER_ID)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.into_iter()
            .filter_map(|id| {
                let (pos, vel, yaw, pitch, hp, flags) = self.arena.snapshot_player(id)?;
                Some(make_net_player_state(
                    id, pos, vel, yaw, pitch, hp, flags, 0.0,
                ))
            })
            .collect()
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

    pub fn debug_render(
        &self,
        debug_pipeline: &mut rapier3d::pipeline::DebugRenderPipeline,
        mode_bits: u32,
    ) -> DebugLineBuffers {
        let destructible_body_handles = self.arena.destructible_debug_body_handles();
        render_debug_buffers(
            debug_pipeline,
            mode_bits,
            &self.arena.dynamic.sim.rigid_bodies,
            &self.arena.dynamic.sim.colliders,
            &self.arena.dynamic.impulse_joints,
            &self.arena.dynamic.multibody_joints,
            &self.arena.dynamic.sim.narrow_phase,
            Some(&destructible_body_handles),
        )
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

    pub fn destructible_chunk_transforms(&self) -> &[f32] {
        self.arena.destructible_chunk_transforms()
    }

    pub fn destructible_debug_state(&self) -> Box<[f64]> {
        self.arena.destructible_debug_state()
    }

    pub fn destructible_debug_config(&self) -> Box<[f64]> {
        self.arena.destructible_debug_config()
    }

    pub fn drain_destructible_fracture_events(&mut self) -> Box<[u32]> {
        self.arena.drain_destructible_fracture_events()
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
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
            destructibles: vec![],
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
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
            destructibles: vec![],
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
    fn idle_energy_depletion_death_does_not_drop_battery() {
        let mut session = isolated_energy_session();
        let dt = 1.0 / SIM_HZ as f32;
        session
            .arena
            .players
            .get_mut(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .energy = crate::constants::ON_FOOT_IDLE_DRAIN_PER_SEC * dt * 0.5;

        session.tick(dt);

        assert!(
            session.battery_states().is_empty(),
            "idle depletion deaths should not drop a battery"
        );
        let player = session
            .arena
            .players
            .get(&LOCAL_PLAYER_ID)
            .expect("local player exists");
        assert!(
            player.dead,
            "idle drain should kill the player when energy runs out"
        );
        assert_eq!(
            player.energy, 0.0,
            "energy should clamp to zero on depletion"
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

    fn decode_snapshot_player_ids(bytes: &[u8]) -> Vec<u32> {
        let mut buf = bytes;
        assert_eq!(buf.get_u8(), PKT_SNAPSHOT);
        let _server_time = buf.get_u64_le();
        let _server_tick = buf.get_u32_le();
        let _ack = buf.get_u16_le();
        let player_count = buf.get_u16_le() as usize;
        let _projectile_count = buf.get_u16_le() as usize;
        let _dynamic_count = buf.get_u16_le() as usize;
        let _vehicle_count = buf.get_u16_le() as usize;
        let mut ids = Vec::with_capacity(player_count);
        for _ in 0..player_count {
            ids.push(buf.get_u32_le());
            buf.advance(25);
        }
        ids
    }

    #[test]
    fn connect_bot_spawns_extra_player_state() {
        let mut session = LocalSession::new();
        session.connect();
        let _ = session.drain_packets();

        assert!(session.connect_bot(101));
        assert!(!session.connect_bot(101));
        assert!(!session.connect_bot(LOCAL_PLAYER_ID));

        session.tick(1.0 / 60.0);
        let snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .unwrap();
        let ids = decode_snapshot_player_ids(&snapshot);
        assert!(ids.contains(&LOCAL_PLAYER_ID));
        assert!(ids.contains(&101));
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn bot_input_drives_its_own_kcc() {
        let mut session = LocalSession::new();
        session.connect();
        let _ = session.drain_packets();
        assert!(session.connect_bot(202));

        let frame = InputCmd {
            seq: 1,
            buttons: crate::constants::BTN_FORWARD,
            move_x: 0,
            move_y: 127,
            yaw: 0.0,
            pitch: 0.0,
        };
        let bytes = encode_single_input_bundle(&frame);
        session.handle_bot_packet(202, &bytes).unwrap();
        let start = session.arena.snapshot_player(202).unwrap().0;
        for _ in 0..10 {
            session.tick(1.0 / 60.0);
        }
        let after = session.arena.snapshot_player(202).unwrap().0;
        let dz = (after[2] - start[2]).abs();
        assert!(
            dz > 0.0,
            "bot should have moved after 10 ticks of forward input"
        );
    }

    #[test]
    fn disconnect_bot_removes_it_from_snapshots() {
        let mut session = LocalSession::new();
        session.connect();
        let _ = session.drain_packets();
        assert!(session.connect_bot(303));
        assert!(session.disconnect_bot(303));
        assert!(!session.disconnect_bot(303));
        assert!(!session.disconnect_bot(LOCAL_PLAYER_ID));

        session.tick(1.0 / 60.0);
        let snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .unwrap();
        let ids = decode_snapshot_player_ids(&snapshot);
        assert!(!ids.contains(&303));
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
    fn bot_fire_does_not_deplete_local_player_energy() {
        let mut session = isolated_energy_session();
        assert!(session.connect_bot(404));

        let starting_energy = 250.0;
        session
            .arena
            .players
            .get_mut(&LOCAL_PLAYER_ID)
            .expect("local player exists")
            .energy = starting_energy;

        session.queued_shots.push((
            404,
            FireCmd {
                seq: 1,
                shot_id: 8,
                weapon: 1,
                client_fire_time_us: session.server_time_us(),
                client_interp_ms: 0,
                client_dynamic_interp_ms: 0,
                dir: [1.0, 0.0, 0.0],
            },
        ));
        session.process_hitscan(session.server_time_ms());

        assert_eq!(
            session
                .arena
                .players
                .get(&LOCAL_PLAYER_ID)
                .expect("local player exists")
                .energy,
            starting_energy,
            "bot shots should not spend local-player energy"
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
            energy_to_centi(
                100.0 + 42.5 - crate::constants::ON_FOOT_IDLE_DRAIN_PER_SEC / SIM_HZ as f32
            )
        );
    }

    #[test]
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

    #[test]
    fn local_session_debug_render_produces_rapier_shape_lines() {
        let mut session = LocalSession::new();
        session.connect();

        let mut pipeline = crate::debug_render::default_debug_pipeline();
        let buffers = session.debug_render(
            &mut pipeline,
            rapier3d::pipeline::DebugRenderMode::COLLIDER_SHAPES.bits(),
        );

        assert!(
            !buffers.vertices.is_empty(),
            "expected debug-render vertices"
        );
        assert_eq!(buffers.vertices.len() % 3, 0);
        assert_eq!(buffers.colors.len(), (buffers.vertices.len() / 3) * 4);
    }
}
