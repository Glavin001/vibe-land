use nalgebra::Vector3;

use super::{PhysicsArena, PlayerMotorState};
use crate::movement::Vec3d;
use crate::protocol::InputCmd;

impl PhysicsArena {
    fn spawn_lane_position(lane: u32) -> (f64, f64) {
        (lane as f64 * 2.0, 0.0)
    }

    fn spawn_lane_is_clear(&self, x: f64, z: f64) -> bool {
        const SPAWN_CLEARANCE_RADIUS_M: f64 = 2.5;
        let clearance_sq = SPAWN_CLEARANCE_RADIUS_M * SPAWN_CLEARANCE_RADIUS_M;

        if self.players.values().any(|player| {
            let dx = player.position.x - x;
            let dz = player.position.z - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        if self.dynamic.dynamic_bodies.values().any(|body| {
            let Some(rb) = self.dynamic.sim.rigid_bodies.get(body.body_handle) else {
                return false;
            };
            let pos = rb.translation();
            let dx = pos.x as f64 - x;
            let dz = pos.z as f64 - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        if self.vehicles.values().any(|vehicle| {
            let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) else {
                return false;
            };
            let pos = rb.translation();
            let dx = pos.x as f64 - x;
            let dz = pos.z as f64 - z;
            dx * dx + dz * dz < clearance_sq
        }) {
            return false;
        }

        true
    }

    fn next_spawn_position(&mut self) -> Vec3d {
        let selected_lane = (0..8)
            .map(|offset| self.next_spawn_index + offset)
            .find(|candidate| {
                let (x, z) = Self::spawn_lane_position(candidate % 8);
                self.spawn_lane_is_clear(x, z)
            })
            .unwrap_or(self.next_spawn_index);
        self.next_spawn_index = selected_lane.saturating_add(1);

        let lane = selected_lane % 8;
        let (x, z) = Self::spawn_lane_position(lane);
        let terrain_y = self
            .cast_static_world_ray([x as f32, 40.0, z as f32], [0.0, -1.0, 0.0], 100.0, None)
            .map(|toi| 40.0 - toi as f64)
            .unwrap_or(0.0);
        Vector3::<f64>::new(x, terrain_y + 2.0, z)
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        let spawn = self.next_spawn_position();

        let handle = self.dynamic.sim.create_player_collider(spawn, player_id);
        self.players.insert(
            player_id,
            PlayerMotorState {
                collider: handle,
                position: spawn,
                velocity: Vec3d::zeros(),
                yaw: 0.0,
                pitch: 0.0,
                on_ground: false,
                hp: 100,
                dead: false,
                last_input: InputCmd::default(),
                energy: crate::constants::STARTING_ENERGY,
            },
        );

        spawn
    }

    pub fn remove_player(&mut self, player_id: u32) {
        self.detach_player_from_vehicles(player_id);
        if let Some(player) = self.players.remove(&player_id) {
            self.dynamic.sim.remove_player_collider(player.collider);
        }
    }

    pub fn respawn_player(&mut self, player_id: u32) -> Option<[f32; 3]> {
        let spawn = self.next_spawn_position();
        let state = self.players.get_mut(&player_id)?;
        state.position = spawn;
        state.velocity = Vec3d::zeros();
        state.yaw = 0.0;
        state.pitch = 0.0;
        state.on_ground = false;
        state.hp = 100;
        state.dead = false;
        state.last_input = InputCmd::default();
        state.energy = crate::constants::STARTING_ENERGY;
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        Some([spawn.x as f32, spawn.y as f32, spawn.z as f32])
    }
}
