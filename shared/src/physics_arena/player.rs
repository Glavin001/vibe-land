use nalgebra as na;

use super::{elapsed_ms, now_marker, PhysicsArena};
use crate::constants::{FLAG_DEAD, FLAG_IN_VEHICLE, FLAG_ON_GROUND};
use crate::protocol::InputCmd;

impl PhysicsArena {
    pub fn simulate_player_tick(
        &mut self,
        player_id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<super::PlayerTickResult> {
        if self.vehicle_of_player.contains_key(&player_id) {
            if let Some(state) = self.players.get_mut(&player_id) {
                state.last_input = input.clone();
            }
            return None;
        }

        let (player_x, player_z) = {
            let Some(state) = self.players.get_mut(&player_id) else {
                return None;
            };
            if state.dead {
                state.last_input = InputCmd::default();
                state.velocity = super::Vec3d::zeros();
                return None;
            }
            state.last_input = input.clone();
            (state.position.x as f32, state.position.z as f32)
        };

        let ground_material_multiplier = self
            .sample_terrain_material(player_x, player_z)
            .friction_multiplier();

        let state = self
            .players
            .get_mut(&player_id)
            .expect("player existed a moment ago");
        let mut tick_result = super::simulate_player_tick(
            &self.dynamic.sim,
            state.collider,
            &mut state.position,
            &mut state.velocity,
            &mut state.yaw,
            &mut state.pitch,
            &mut state.on_ground,
            input,
            dt,
            ground_material_multiplier,
        );
        let sync_started = now_marker();
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        tick_result.timings.collider_sync_ms = elapsed_ms(sync_started);

        let impulse_started = now_marker();
        let mut impulses_applied_count = 0usize;
        for impulse in &tick_result.dynamic_impulses {
            if self.apply_dynamic_body_impulse(
                impulse.body_id,
                impulse.impulse,
                impulse.contact_point,
            ) {
                impulses_applied_count += 1;
            }
        }
        tick_result.timings.dynamic_impulse_apply_ms = elapsed_ms(impulse_started);
        tick_result.dynamic_stats.impulses_applied_count = impulses_applied_count;

        Some(tick_result)
    }

    pub fn snapshot_player(
        &self,
        player_id: u32,
    ) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&player_id)?;
        let mut flags = 0u16;
        if state.on_ground {
            flags |= FLAG_ON_GROUND;
        }
        if state.dead {
            flags |= FLAG_DEAD;
        }

        if let Some(&vehicle_id) = self.vehicle_of_player.get(&player_id) {
            flags |= FLAG_IN_VEHICLE;
            if let Some(vehicle) = self.vehicles.get(&vehicle_id) {
                if let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) {
                    let p = rb.translation();
                    let v = rb.linvel();
                    return Some((
                        [p.x, p.y, p.z],
                        [v.x, v.y, v.z],
                        state.yaw as f32,
                        state.pitch as f32,
                        state.hp,
                        flags,
                    ));
                }
            }
        }

        Some((
            [
                state.position.x as f32,
                state.position.y as f32,
                state.position.z as f32,
            ],
            [
                state.velocity.x as f32,
                state.velocity.y as f32,
                state.velocity.z as f32,
            ],
            state.yaw as f32,
            state.pitch as f32,
            state.hp,
            flags,
        ))
    }

    pub fn cast_static_world_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_player: Option<u32>,
    ) -> Option<f32> {
        let exclude = exclude_player
            .and_then(|pid| self.players.get(&pid))
            .map(|p| p.collider);
        self.dynamic.sim.cast_ray(origin, dir, max_toi, exclude)
    }

    pub fn cast_dynamic_body_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_player: Option<u32>,
    ) -> Option<(u32, f32, [f32; 3])> {
        let exclude = exclude_player
            .and_then(|pid| self.players.get(&pid))
            .map(|p| p.collider);
        let ray = rapier3d::prelude::Ray::new(
            na::point![origin[0], origin[1], origin[2]],
            na::vector![dir[0], dir[1], dir[2]],
        );
        let mut best: Option<(u32, f32, [f32; 3])> = None;
        for (&id, db) in &self.dynamic.dynamic_bodies {
            if Some(db.collider_handle) == exclude {
                continue;
            }
            let Some(collider) = self.dynamic.sim.colliders.get(db.collider_handle) else {
                continue;
            };
            let collider_pose = collider
                .parent()
                .and_then(|parent| self.dynamic.sim.rigid_bodies.get(parent))
                .and_then(|parent_rb| {
                    collider
                        .position_wrt_parent()
                        .map(|wrt_parent| *parent_rb.position() * *wrt_parent)
                })
                .unwrap_or(*collider.position());
            let Some(hit) =
                collider
                    .shape()
                    .cast_ray_and_get_normal(&collider_pose, &ray, max_toi, true)
            else {
                continue;
            };
            if best
                .map(|(_, toi, _)| hit.time_of_impact < toi)
                .unwrap_or(true)
            {
                let n = hit.normal;
                best = Some((id, hit.time_of_impact, [n.x, n.y, n.z]));
            }
        }
        best
    }

    pub fn apply_dynamic_body_impulse(
        &mut self,
        dynamic_body_id: u32,
        impulse: [f32; 3],
        contact_point: [f32; 3],
    ) -> bool {
        let Some(db) = self.dynamic.dynamic_bodies.get(&dynamic_body_id) else {
            return false;
        };
        let Some(rb) = self.dynamic.sim.rigid_bodies.get_mut(db.body_handle) else {
            return false;
        };
        let world_com = *rb.center_of_mass();
        let impulse = na::vector![impulse[0], impulse[1], impulse[2]];
        let point = na::point![contact_point[0], contact_point[1], contact_point[2]];
        let torque = (point - world_com).cross(&impulse);
        rb.apply_impulse(impulse, true);
        rb.apply_torque_impulse(torque, true);
        true
    }

    pub fn set_player_dead(&mut self, player_id: u32, dead: bool) {
        if let Some(state) = self.players.get_mut(&player_id) {
            state.dead = dead;
            if dead {
                state.hp = 0;
                state.velocity = super::Vec3d::zeros();
                state.on_ground = false;
            }
        }
    }
}
