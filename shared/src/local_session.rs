use std::collections::{HashMap, VecDeque};

use crate::{
    constants::{
        FLAG_DEAD, HIT_ZONE_BODY, HIT_ZONE_HEAD, HIT_ZONE_NONE, PKT_DEBUG_STATS, PKT_FIRE,
        PKT_INPUT_BUNDLE, PKT_PING, PKT_SHOT_RESULT, PKT_SNAPSHOT, PKT_VEHICLE_ENTER,
        PKT_VEHICLE_EXIT, PKT_WELCOME,
    },
    local_arena::{MoveConfig, PhysicsArena},
    protocol::*,
    seq::seq_is_newer,
    unit_conv::{i16_to_angle, snorm16_to_f32},
    world_document::WorldDocument,
};
use bytes::{Buf, BufMut, BytesMut};
use vibe_netcode::lag_comp::{classify_player_hitscan, HitZone};

const SIM_HZ: u16 = 60;
const SNAPSHOT_HZ: u16 = SIM_HZ;
const MAX_PENDING_INPUTS: usize = 120;
pub const LOCAL_PLAYER_ID: u32 = 1;
const LOCAL_RIFLE_INTERVAL_MS: u32 = 100;
const PLAYER_EYE_HEIGHT_M: f32 = 0.8;
const HITSCAN_MAX_DISTANCE: f32 = 1000.0;
const DYNAMIC_BODY_IMPULSE: f32 = 6.0;
const HITSCAN_BODY_DAMAGE: u8 = 25;
const HITSCAN_HEAD_DAMAGE: u8 = 100;
const BOT_RESPAWN_TICKS: u32 = 60 * 3; // 3 seconds

#[derive(Default)]
struct PlayerRuntime {
    pending_inputs: VecDeque<InputCmd>,
    last_applied_input: InputCmd,
    last_received_input_seq: Option<u16>,
    last_ack_input_seq: u16,
    next_allowed_fire_ms: u32,
    /// True when this runtime is for a bot (driven by the client-side
    /// practice bot runtime). Bots have their own lifecycle — they don't
    /// receive welcome packets and they're auto-respawned on death.
    is_bot: bool,
    /// Ticks remaining until respawn (only used for bots; 0 means alive).
    respawn_cooldown_ticks: u32,
}

pub struct LocalPreviewSession {
    arena: PhysicsArena,
    connected: bool,
    /// Per-player runtime state. The human player (if connected) lives at
    /// key {@link LOCAL_PLAYER_ID}; bots live at ids >= {@link BOT_ID_BASE}.
    players: HashMap<u32, PlayerRuntime>,
    queued_shots: Vec<(u32, FireCmd)>,
    outbound_packets: Vec<Vec<u8>>,
    server_tick: u32,
}

impl LocalPreviewSession {
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
        self.players.insert(LOCAL_PLAYER_ID, PlayerRuntime::default());
        self.arena.spawn_player(LOCAL_PLAYER_ID);

        let server_time_us = self.server_time_us();
        self.outbound_packets
            .push(encode_welcome_packet(&WelcomePacket {
                player_id: LOCAL_PLAYER_ID,
                sim_hz: SIM_HZ,
                snapshot_hz: SNAPSHOT_HZ,
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
        // Tear down every player (human + bots) so the arena is clean if
        // the session is reused.
        let ids: Vec<u32> = self.players.keys().copied().collect();
        for id in ids {
            self.arena.remove_player(id);
        }
        self.players.clear();
        self.outbound_packets.clear();
    }

    /// Spawn a bot as a first-class player in the arena. Returns true if the
    /// bot was added (false if the id already existed or the session is not
    /// connected).
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

    /// Set (or clear) a bot's max horizontal move speed override (m/s).
    /// Pass `None` to restore the default walk/sprint tiers. Returns true
    /// if the id was a known bot. Refuses to touch the local player.
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

    /// Remove a bot from the arena. Returns true if the id was a known bot.
    pub fn disconnect_bot(&mut self, bot_id: u32) -> bool {
        if bot_id == LOCAL_PLAYER_ID {
            return false;
        }
        let Some(runtime) = self.players.remove(&bot_id) else {
            return false;
        };
        if !runtime.is_bot {
            // Put it back; we only disconnect bots through this path.
            self.players.insert(bot_id, runtime);
            return false;
        }
        self.arena.remove_player(bot_id);
        true
    }

    /// Push a bot's input packet. Bots use the same wire format as the
    /// human client; supported kinds are `PKT_INPUT_BUNDLE`, `PKT_FIRE`,
    /// `PKT_VEHICLE_ENTER`, and `PKT_VEHICLE_EXIT`. Vehicle enter/exit
    /// routes straight through `arena.enter_vehicle` /
    /// `arena.exit_vehicle`, which already take a generic player id.
    pub fn handle_bot_packet(&mut self, bot_id: u32, bytes: &[u8]) -> Result<(), String> {
        if bot_id == LOCAL_PLAYER_ID {
            return Err("cannot push bot input for local player id".to_string());
        }
        {
            let Some(runtime) = self.players.get(&bot_id) else {
                return Err(format!("unknown bot id {bot_id}"));
            };
            if !runtime.is_bot {
                return Err(format!("player {bot_id} is not a bot"));
            }
        }
        if bytes.is_empty() {
            return Err("empty bot packet".to_string());
        }
        let mut buf = bytes;
        let kind = buf.get_u8();
        match kind {
            PKT_INPUT_BUNDLE => {
                let frames = decode_input_bundle_frames(&mut buf)?;
                let runtime = self
                    .players
                    .get_mut(&bot_id)
                    .expect("bot runtime existed in the check above");
                enqueue_inputs(runtime, frames);
                Ok(())
            }
            PKT_FIRE => {
                let shot = decode_fire_cmd(&mut buf)?;
                self.queued_shots.push((bot_id, shot));
                Ok(())
            }
            PKT_VEHICLE_ENTER => {
                let vehicle_id = decode_vehicle_enter(&mut buf)?;
                if self.arena.vehicles.contains_key(&vehicle_id) {
                    self.arena.enter_vehicle(bot_id, vehicle_id);
                }
                Ok(())
            }
            PKT_VEHICLE_EXIT => {
                let vehicle_id = decode_vehicle_exit(&mut buf)?;
                if self.arena.vehicle_of_player.get(&bot_id) == Some(&vehicle_id) {
                    self.arena.exit_vehicle(bot_id);
                }
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
            other => return Err(format!("unsupported local preview packet kind {other}")),
        }
        Ok(())
    }

    pub fn tick(&mut self, dt: f32) {
        if !self.connected {
            return;
        }

        self.server_tick += 1;
        let server_time_ms = self.server_time_ms();

        // Drive each connected player's KCC for this tick. The iteration
        // order doesn't matter for correctness since the arena is a shared
        // physics world and each player is a kinematic capsule.
        let player_ids: Vec<u32> = self.players.keys().copied().collect();
        for id in player_ids {
            // Bot respawn handling: tick cooldown, then respawn in place
            // when it reaches zero. We skip input processing while dead.
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
            self.arena.simulate_player_tick(id, &input, dt);
        }

        self.arena.step_vehicles(dt);
        self.arena.step_dynamics(dt);
        self.process_hitscan(server_time_ms);

        if self.server_tick % (SIM_HZ as u32 / SNAPSHOT_HZ as u32) == 0 {
            self.outbound_packets.push(self.build_snapshot_packet());
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
            let Some(shooter) = self.players.get_mut(&shooter_id) else {
                continue;
            };
            if shooter.next_allowed_fire_ms > server_time_ms {
                continue;
            }
            shooter.next_allowed_fire_ms = server_time_ms.saturating_add(LOCAL_RIFLE_INTERVAL_MS);

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

            let origin = [pos[0], pos[1] + PLAYER_EYE_HEIGHT_M, pos[2]];
            let world_toi = self.arena.cast_static_world_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE,
                Some(shooter_id),
            );
            let dynamic_hit = self.arena.cast_dynamic_body_ray(
                origin,
                shot.dir,
                HITSCAN_MAX_DISTANCE,
                Some(shooter_id),
            );
            let player_hit = self.cast_player_hitscan(shooter_id, origin, shot.dir);

            // Find the nearest obstacle between the shooter and any candidate
            // target (wall, dynamic body, or player).
            let nearest_toi = [
                world_toi,
                dynamic_hit.map(|(_, toi, _)| toi),
                player_hit.map(|(_, toi, _)| toi),
            ]
            .into_iter()
            .flatten()
            .fold(f32::MAX, f32::min);

            let mut result = make_shot_result(shot.shot_id, shot.weapon);

            // Resolve player hit first — they deal damage and are the only
            // target that fills hit_player_id.
            if let Some((victim_id, toi, zone)) = player_hit {
                if toi <= nearest_toi + 1e-3 {
                    result.confirmed = true;
                    result.hit_player_id = victim_id;
                    result.hit_zone = match zone {
                        HitZone::Head => HIT_ZONE_HEAD,
                        HitZone::Body => HIT_ZONE_BODY,
                    };
                    let damage = match zone {
                        HitZone::Head => HITSCAN_HEAD_DAMAGE,
                        HitZone::Body => HITSCAN_BODY_DAMAGE,
                    };
                    self.apply_damage(victim_id, damage);
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
                }
            }

            self.outbound_packets
                .push(encode_shot_result_packet(&result));
        }
    }

    /// Casts a ray from `shooter_id`'s muzzle through every other connected
    /// player's capsule/head pair and returns the nearest hit's (victim id,
    /// time-of-impact, hit zone). Returns None if no player is intersected.
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
            let Some((pos, _vel, _yaw, _pitch, hp, flags)) =
                self.arena.snapshot_player(victim_id)
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
            if hit.distance > HITSCAN_MAX_DISTANCE {
                continue;
            }
            if best
                .map(|(_, toi, _)| hit.distance < toi)
                .unwrap_or(true)
            {
                best = Some((victim_id, hit.distance, hit.zone));
            }
        }
        best
    }

    fn apply_damage(&mut self, victim_id: u32, damage: u8) {
        let is_bot = self
            .players
            .get(&victim_id)
            .map(|runtime| runtime.is_bot)
            .unwrap_or(false);
        let died = self.arena.apply_player_damage(victim_id, damage);
        if died && is_bot {
            if let Some(runtime) = self.players.get_mut(&victim_id) {
                runtime.respawn_cooldown_ticks = BOT_RESPAWN_TICKS;
            }
        }
    }

    fn build_snapshot_packet(&self) -> Vec<u8> {
        let mut player_states = Vec::new();
        // The human player goes first so the client's self-resolution logic
        // (which matches on id) finds it quickly. Bots follow in any order.
        if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(LOCAL_PLAYER_ID)
        {
            player_states.push(make_net_player_state(
                LOCAL_PLAYER_ID,
                pos,
                vel,
                yaw,
                pitch,
                hp,
                flags,
            ));
        }
        for (&id, _) in &self.players {
            if id == LOCAL_PLAYER_ID {
                continue;
            }
            if let Some((pos, vel, yaw, pitch, hp, flags)) = self.arena.snapshot_player(id) {
                player_states.push(make_net_player_state(id, pos, vel, yaw, pitch, hp, flags));
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

    fn server_time_us(&self) -> u64 {
        (self.server_tick as u64) * (1_000_000 / SIM_HZ as u64)
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

fn make_shot_result(shot_id: u32, weapon: u8) -> ShotResultPacket {
    ShotResultPacket {
        shot_id,
        weapon,
        confirmed: false,
        hit_player_id: 0,
        hit_zone: HIT_ZONE_NONE,
        server_resolution: 0,
        server_dynamic_body_id: 0,
        server_dynamic_hit_toi_cm: 0,
        server_dynamic_impulse_centi: 0,
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
    let mut out = BytesMut::with_capacity(12);
    out.put_u8(PKT_SHOT_RESULT);
    out.put_u32_le(pkt.shot_id);
    out.put_u8(pkt.weapon);
    out.put_u8(pkt.confirmed as u8);
    out.put_u32_le(pkt.hit_player_id);
    out.put_u8(pkt.hit_zone);
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
    use crate::unit_conv::angle_to_i16;

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

    #[test]
    fn connect_queues_welcome_packet() {
        let mut session = LocalPreviewSession::new();
        session.connect();

        let packets = session.drain_packets();
        assert!(!packets.is_empty());
        assert_eq!(packets[0][0], PKT_WELCOME);
    }

    #[test]
    fn tick_acknowledges_latest_input_in_snapshot() {
        let mut session = LocalPreviewSession::new();
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
    fn local_preview_can_enter_authored_vehicle() {
        let mut session = LocalPreviewSession::new();
        session.connect();
        let _ = session.drain_packets();

        session.tick(1.0 / 60.0);
        let initial_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("initial local preview snapshot");
        let initial_vehicle = decode_snapshot_vehicle_states(&initial_snapshot);
        assert!(
            !initial_vehicle.is_empty(),
            "demo local preview should expose at least one vehicle"
        );
        let (vehicle_id, _, _, _, _) = *initial_vehicle
            .iter()
            .find(|(_, driver, _, _, _)| *driver == 0)
            .expect("at least one authored vehicle should start unoccupied");

        session
            .handle_client_packet(&encode_vehicle_enter_packet_for_test(vehicle_id))
            .unwrap();

        session.tick(1.0 / 60.0);

        let latest_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("latest local preview snapshot");
        let latest_vehicle = decode_snapshot_vehicle_states(&latest_snapshot);
        let (_, latest_driver_id, _, _, _) = *latest_vehicle
            .iter()
            .find(|(id, _, _, _, _)| *id == vehicle_id)
            .expect("entered vehicle should still be in snapshot");
        assert_eq!(
            latest_driver_id, LOCAL_PLAYER_ID,
            "local preview vehicle should be driven by the local player after enter"
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
        let mut session = LocalPreviewSession::new();
        session.connect();
        let _ = session.drain_packets();

        assert!(session.connect_bot(101));
        // duplicate id: rejected
        assert!(!session.connect_bot(101));
        // disallow using the local player id
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
        let mut session = LocalPreviewSession::new();
        session.connect();
        let _ = session.drain_packets();
        assert!(session.connect_bot(202));

        // Push a forward-walking input for the bot and tick a handful of
        // frames so the KCC integrates position.
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
        assert!(dz > 0.0, "bot should have moved after 10 ticks of forward input");
    }

    fn encode_vehicle_exit_packet_for_test(vehicle_id: u32) -> Vec<u8> {
        let mut out = BytesMut::with_capacity(5);
        out.put_u8(PKT_VEHICLE_EXIT);
        out.put_u32_le(vehicle_id);
        out.to_vec()
    }

    #[test]
    fn bot_can_enter_and_drive_a_vehicle() {
        let mut session = LocalPreviewSession::new();
        session.connect();
        let _ = session.drain_packets();
        assert!(session.connect_bot(404));

        // Tick once so the vehicle state is represented in a snapshot the
        // test can inspect.
        session.tick(1.0 / 60.0);
        let initial_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("initial snapshot after connect_bot");
        let initial_vehicles = decode_snapshot_vehicle_states(&initial_snapshot);
        assert!(
            !initial_vehicles.is_empty(),
            "demo local preview should expose at least one authored vehicle"
        );
        let (vehicle_id, _, start_px, _, start_pz) = *initial_vehicles
            .iter()
            .find(|(_, driver, _, _, _)| *driver == 0)
            .expect("at least one authored vehicle should start unoccupied");

        // Route the enter packet through `handle_bot_packet` — this is the
        // path `PracticeBotRuntime` uses when a bot reaches the
        // `entering_vehicle` FSM state.
        session
            .handle_bot_packet(404, &encode_vehicle_enter_packet_for_test(vehicle_id))
            .expect("bot vehicle enter should be accepted");
        session.tick(1.0 / 60.0);

        // The arena should now record the bot as the vehicle's driver, and
        // `vehicle_of_player` should mirror that.
        assert_eq!(
            session.arena.vehicle_of_player.get(&404),
            Some(&vehicle_id),
            "bot should be seated in the vehicle after handle_bot_packet"
        );
        let seated_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("snapshot after bot entered vehicle");
        let seated_vehicles = decode_snapshot_vehicle_states(&seated_snapshot);
        let (_, seated_driver_id, _, _, _) = *seated_vehicles
            .iter()
            .find(|(id, _, _, _, _)| *id == vehicle_id)
            .expect("seated vehicle should still be in the snapshot");
        assert_eq!(
            seated_driver_id, 404,
            "snapshot driver_id should reflect the seated bot"
        );

        // Push a forward-throttle input bundle and tick for ~0.5 s of sim
        // time. With `input_to_vehicle_cmd` driving the raycast vehicle,
        // chassis-local forward (−Z) should translate the vehicle along
        // world −Z (authored vehicle spawns unrotated in the demo world).
        let frame = InputCmd {
            seq: 1,
            buttons: 0,
            move_x: 0,
            move_y: 127,
            yaw: 0.0,
            pitch: 0.0,
        };
        let bytes = encode_single_input_bundle(&frame);
        session
            .handle_bot_packet(404, &bytes)
            .expect("bot input bundle should be accepted while driving");
        for _ in 0..30 {
            session.tick(1.0 / 60.0);
        }
        let driven_snapshot = session
            .drain_packets()
            .into_iter()
            .rev()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("snapshot after driving the vehicle");
        let driven_vehicles = decode_snapshot_vehicle_states(&driven_snapshot);
        let (_, _, end_px, _, end_pz) = *driven_vehicles
            .iter()
            .find(|(id, _, _, _, _)| *id == vehicle_id)
            .expect("driven vehicle should still be in the snapshot");
        let dx = (end_px - start_px).abs();
        let dz = (end_pz - start_pz).abs();
        assert!(
            dx > 0 || dz > 0,
            "bot-driven vehicle should have moved from its spawn after 30 forward ticks"
        );

        // Exit cleanly via `handle_bot_packet` and confirm the driver slot
        // clears.
        session
            .handle_bot_packet(404, &encode_vehicle_exit_packet_for_test(vehicle_id))
            .expect("bot vehicle exit should be accepted");
        session.tick(1.0 / 60.0);
        assert!(
            !session.arena.vehicle_of_player.contains_key(&404),
            "bot should no longer be seated after exit packet"
        );
        let exited_snapshot = session
            .drain_packets()
            .into_iter()
            .find(|pkt| pkt[0] == PKT_SNAPSHOT)
            .expect("snapshot after bot exited");
        let exited_vehicles = decode_snapshot_vehicle_states(&exited_snapshot);
        let (_, exited_driver_id, _, _, _) = *exited_vehicles
            .iter()
            .find(|(id, _, _, _, _)| *id == vehicle_id)
            .expect("exited vehicle should still be in the snapshot");
        assert_eq!(
            exited_driver_id, 0,
            "vehicle should be unoccupied again after exit"
        );
    }

    #[test]
    fn disconnect_bot_removes_it_from_snapshots() {
        let mut session = LocalPreviewSession::new();
        session.connect();
        let _ = session.drain_packets();
        assert!(session.connect_bot(303));
        assert!(session.disconnect_bot(303));
        // Cannot disconnect twice.
        assert!(!session.disconnect_bot(303));
        // Cannot disconnect the local player via this path.
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
}
