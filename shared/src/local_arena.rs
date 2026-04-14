use std::collections::HashMap;

use nalgebra::{Point3, Quaternion, UnitQuaternion, Vector3};
use rapier3d::control::DynamicRayCastVehicleController;
use rapier3d::prelude::*;

use crate::constants::BTN_RELOAD;
use crate::constants::{FLAG_DEAD, FLAG_IN_VEHICLE, FLAG_ON_GROUND};
pub use crate::movement::{vehicle_wheel_params, MoveConfig, Vec3d, VEHICLE_MAX_STEER_RAD};
use crate::protocol::*;
pub use crate::simulation::{simulate_player_tick, PlayerTickResult};
use crate::vehicle::{create_vehicle_physics, reset_vehicle_body, vehicle_suspension_filter};
pub use vibe_netcode::physics_arena::DynamicArena;

pub type Vec3 = Vector3<f32>;

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[cfg(not(target_arch = "wasm32"))]
fn now_marker() -> Instant {
    Instant::now()
}

#[cfg(target_arch = "wasm32")]
fn now_marker() {}

#[cfg(not(target_arch = "wasm32"))]
fn elapsed_ms(started: Instant) -> f32 {
    started.elapsed().as_secs_f32() * 1000.0
}

#[cfg(target_arch = "wasm32")]
fn elapsed_ms(_: ()) -> f32 {
    0.0
}

pub struct Vehicle {
    pub chassis_body: RigidBodyHandle,
    pub chassis_collider: ColliderHandle,
    pub controller: DynamicRayCastVehicleController,
    pub vehicle_type: u8,
    pub driver_id: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct PlayerMotorState {
    pub collider: ColliderHandle,
    pub position: Vec3d,
    pub velocity: Vec3d,
    pub yaw: f64,
    pub pitch: f64,
    pub on_ground: bool,
    pub hp: u8,
    pub dead: bool,
    pub last_input: InputCmd,
    /// Optional per-player override for the KCC's max horizontal move
    /// speed (m/s). When `Some`, the simulation uses this value instead
    /// of the walk/sprint tiers from `MoveConfig`, letting bots move at
    /// arbitrary continuous speeds independent of the human's
    /// walk/sprint buttons.
    pub max_speed_override: Option<f64>,
}

/// Browser-local authoritative physics world: wraps `DynamicArena` and adds
/// vibe-land-specific player and vehicle state management.
pub struct PhysicsArena {
    pub dynamic: DynamicArena,
    pub players: HashMap<u32, PlayerMotorState>,
    next_spawn_index: u32,
    pub vehicles: HashMap<u32, Vehicle>,
    next_vehicle_id: u32,
    pub vehicle_of_player: HashMap<u32, u32>,
}

impl PhysicsArena {
    pub fn new(config: MoveConfig) -> Self {
        Self {
            dynamic: DynamicArena::new(config),
            players: HashMap::new(),
            next_spawn_index: 0,
            vehicles: HashMap::new(),
            next_vehicle_id: 1,
            vehicle_of_player: HashMap::new(),
        }
    }

    pub fn config(&self) -> &MoveConfig {
        self.dynamic.config()
    }

    pub fn sync_broad_phase(&mut self) {
        self.dynamic.sync_broad_phase();
    }

    pub fn rebuild_broad_phase(&mut self) {
        self.dynamic.rebuild_broad_phase();
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        let lane = self.next_spawn_index % 8;
        self.next_spawn_index += 1;
        let spawn = Vector3::<f64>::new(lane as f64 * 2.0, 2.0, 0.0);

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
                max_speed_override: None,
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

    pub fn add_static_cuboid(
        &mut self,
        center: Vec3,
        half_extents: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.dynamic
            .add_static_cuboid(center, half_extents, user_data)
    }

    pub fn add_static_cuboid_rotated(
        &mut self,
        center: Vec3,
        rotation: [f32; 4],
        half_extents: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.dynamic
            .add_static_cuboid_rotated(center, rotation, half_extents, user_data)
    }

    pub fn add_static_heightfield(
        &mut self,
        center: Vec3,
        heights: nalgebra::DMatrix<f32>,
        scale: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.dynamic
            .add_static_heightfield(center, heights, scale, user_data)
    }

    pub fn add_static_trimesh(
        &mut self,
        vertices: Vec<Point3<f32>>,
        indices: Vec<[u32; 3]>,
        user_data: u128,
    ) -> ColliderHandle {
        self.dynamic
            .add_static_trimesh(vertices, indices, user_data)
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.dynamic.remove_collider(handle);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.dynamic.collider_user_data(handle)
    }

    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        self.dynamic.wake_bodies_near(center, radius);
    }

    pub fn simulate_player_tick(
        &mut self,
        player_id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<PlayerTickResult> {
        if self.vehicle_of_player.contains_key(&player_id) {
            if let Some(state) = self.players.get_mut(&player_id) {
                state.last_input = input.clone();
            }
            return None;
        }

        let Some(state) = self.players.get_mut(&player_id) else {
            return None;
        };
        if state.dead {
            state.last_input = InputCmd::default();
            state.velocity = Vec3d::zeros();
            return None;
        }
        state.last_input = input.clone();

        let max_speed_override = state.max_speed_override;
        let mut tick_result = simulate_player_tick(
            &self.dynamic.sim,
            state.collider,
            &mut state.position,
            &mut state.velocity,
            &mut state.yaw,
            &mut state.pitch,
            &mut state.on_ground,
            input,
            dt,
            max_speed_override,
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
            nalgebra::point![origin[0], origin[1], origin[2]],
            nalgebra::vector![dir[0], dir[1], dir[2]],
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
        let impulse = nalgebra::vector![impulse[0], impulse[1], impulse[2]];
        let point = nalgebra::point![contact_point[0], contact_point[1], contact_point[2]];
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
                state.velocity = Vec3d::zeros();
                state.on_ground = false;
            }
        }
    }

    /// Sets an override for the KCC's max horizontal move speed for the
    /// given player. Pass `None` to restore the default walk/sprint tiers.
    /// Returns true if the player exists.
    pub fn set_player_max_speed_override(
        &mut self,
        player_id: u32,
        max_speed: Option<f64>,
    ) -> bool {
        if let Some(state) = self.players.get_mut(&player_id) {
            state.max_speed_override = max_speed;
            true
        } else {
            false
        }
    }

    /// Applies damage to `player_id`, clamping hp at 0 and setting the dead
    /// flag when hp reaches zero. Returns true if this damage killed the
    /// player (was alive, now dead).
    pub fn apply_player_damage(&mut self, player_id: u32, damage: u8) -> bool {
        let Some(state) = self.players.get_mut(&player_id) else {
            return false;
        };
        if state.dead || state.hp == 0 {
            return false;
        }
        state.hp = state.hp.saturating_sub(damage);
        if state.hp == 0 {
            state.dead = true;
            state.velocity = Vec3d::zeros();
            return true;
        }
        false
    }

    pub fn respawn_player(&mut self, player_id: u32) -> Option<[f32; 3]> {
        let lane = self.next_spawn_index % 8;
        self.next_spawn_index += 1;
        let spawn = Vector3::<f64>::new(lane as f64 * 2.0, 2.0, 0.0);
        let state = self.players.get_mut(&player_id)?;
        state.position = spawn;
        state.velocity = Vec3d::zeros();
        state.yaw = 0.0;
        state.pitch = 0.0;
        state.on_ground = false;
        state.hp = 100;
        state.dead = false;
        state.last_input = InputCmd::default();
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        Some([spawn.x as f32, spawn.y as f32, spawn.z as f32])
    }

    pub fn spawn_dynamic_box(&mut self, position: Vec3, half_extents: Vec3) -> u32 {
        self.dynamic.spawn_dynamic_box(position, half_extents)
    }

    pub fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vec3,
        rotation: [f32; 4],
        half_extents: Vec3,
    ) -> u32 {
        self.dynamic
            .spawn_dynamic_box_with_id(id, position, rotation, half_extents)
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vec3, radius: f32) -> u32 {
        self.dynamic.spawn_dynamic_ball(position, radius)
    }

    pub fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vec3, radius: f32) -> u32 {
        self.dynamic
            .spawn_dynamic_ball_with_id(id, position, radius)
    }

    pub fn spawn_vehicle(&mut self, vehicle_type: u8, position: Vec3) -> u32 {
        let id = self.next_vehicle_id;
        self.next_vehicle_id += 1;
        self.spawn_vehicle_with_id(id, vehicle_type, position, [0.0, 0.0, 0.0, 1.0]);
        id
    }

    pub fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vec3,
        rotation: [f32; 4],
    ) -> u32 {
        let pose = nalgebra::Isometry3::from_parts(
            nalgebra::Translation3::new(position.x, position.y, position.z),
            UnitQuaternion::from_quaternion(Quaternion::new(
                rotation[3],
                rotation[0],
                rotation[1],
                rotation[2],
            )),
        );
        let (chassis_body, chassis_collider, controller) =
            create_vehicle_physics(&mut self.dynamic.sim, pose);

        self.vehicles.insert(
            id,
            Vehicle {
                chassis_body,
                chassis_collider,
                controller,
                vehicle_type,
                driver_id: None,
            },
        );

        self.next_vehicle_id = self.next_vehicle_id.max(id.saturating_add(1));
        id
    }

    pub fn step_vehicles(&mut self, dt: f32) {
        if self.vehicles.is_empty() {
            return;
        }

        let vehicle_ids: Vec<u32> = self.vehicles.keys().copied().collect();
        for vid in vehicle_ids {
            if let Some(driver_id) = self
                .vehicles
                .get(&vid)
                .and_then(|vehicle| vehicle.driver_id)
            {
                if !self.players.contains_key(&driver_id) {
                    self.detach_player_from_vehicles(driver_id);
                } else if self.vehicle_of_player.get(&driver_id) != Some(&vid) {
                    self.vehicle_of_player.insert(driver_id, vid);
                }
            }

            let (reset_requested, steering, engine_force, brake) = {
                let vehicle = match self.vehicles.get(&vid) {
                    Some(v) => v,
                    None => continue,
                };
                if let Some(driver_id) = vehicle.driver_id {
                    if let Some(player) = self.players.get(&driver_id) {
                        let (steering, engine_force, brake) =
                            vehicle_wheel_params(&player.last_input);
                        (
                            player.last_input.buttons & BTN_RELOAD != 0,
                            steering,
                            engine_force,
                            brake,
                        )
                    } else {
                        (false, 0.0, 0.0, 0.0)
                    }
                } else {
                    (false, 0.0, 0.0, 0.0)
                }
            };

            let vehicle = self.vehicles.get_mut(&vid).unwrap();
            if reset_requested {
                if let Some(rb) = self.dynamic.sim.rigid_bodies.get_mut(vehicle.chassis_body) {
                    reset_vehicle_body(rb);
                }
            }
            for (i, wheel) in vehicle.controller.wheels_mut().iter_mut().enumerate() {
                if i < 2 {
                    wheel.steering = if reset_requested { 0.0 } else { steering };
                }
                wheel.engine_force = if !reset_requested && i >= 2 {
                    engine_force
                } else {
                    0.0
                };
                wheel.brake = if reset_requested { 0.0 } else { brake };
            }

            let chassis_collider = vehicle.chassis_collider;
            let filter = vehicle_suspension_filter(chassis_collider);
            let queries = self.dynamic.sim.broad_phase.as_query_pipeline_mut(
                self.dynamic.sim.narrow_phase.query_dispatcher(),
                &mut self.dynamic.sim.rigid_bodies,
                &mut self.dynamic.sim.colliders,
                filter,
            );
            vehicle.controller.update_vehicle(dt, queries);
        }
    }

    pub fn enter_vehicle(&mut self, player_id: u32, vehicle_id: u32) {
        if !self.players.contains_key(&player_id) || !self.vehicles.contains_key(&vehicle_id) {
            return;
        }

        self.detach_player_from_vehicles(player_id);

        if let Some(current_driver_id) = self
            .vehicles
            .get(&vehicle_id)
            .and_then(|vehicle| vehicle.driver_id)
        {
            if current_driver_id != player_id {
                if self.players.contains_key(&current_driver_id) {
                    self.vehicle_of_player.insert(current_driver_id, vehicle_id);
                    return;
                }
                self.detach_player_from_vehicles(current_driver_id);
            }
        }

        if let Some(player) = self.players.get(&player_id) {
            if let Some(c) = self.dynamic.sim.colliders.get_mut(player.collider) {
                c.set_collision_groups(InteractionGroups::none());
            }
        }
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = Some(player_id);
        }
        self.vehicle_of_player.insert(player_id, vehicle_id);
    }

    pub fn exit_vehicle(&mut self, player_id: u32) {
        if let Some(vehicle_id) = self.detach_player_from_vehicles(player_id) {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                if let Some(rb) = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body) {
                    let p = *rb.translation();
                    if let Some(state) = self.players.get_mut(&player_id) {
                        state.position =
                            Vec3d::new((p.x + 2.5) as f64, (p.y + 1.0) as f64, p.z as f64);
                        if let Some(c) = self.dynamic.sim.colliders.get_mut(state.collider) {
                            c.set_collision_groups(InteractionGroups::all());
                        }
                        self.dynamic
                            .sim
                            .sync_player_collider(state.collider, &state.position);
                    }
                }
            }
        }
    }

    fn detach_player_from_vehicles(&mut self, player_id: u32) -> Option<u32> {
        self.vehicle_of_player.remove(&player_id);

        let vehicle_ids: Vec<u32> = self
            .vehicles
            .iter()
            .filter_map(|(&vehicle_id, vehicle)| {
                (vehicle.driver_id == Some(player_id)).then_some(vehicle_id)
            })
            .collect();

        for vehicle_id in &vehicle_ids {
            if let Some(vehicle) = self.vehicles.get_mut(vehicle_id) {
                vehicle.driver_id = None;
            }
        }

        vehicle_ids.into_iter().next()
    }

    pub fn snapshot_vehicles(&self) -> Vec<NetVehicleState> {
        self.vehicles
            .iter()
            .filter_map(|(&id, vehicle)| {
                let rb = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body)?;
                let p = rb.translation();
                let r = rb.rotation();
                let lv = rb.linvel();
                let av = rb.angvel();

                let mut wheel_data = [0u16; 4];
                for (i, wheel) in vehicle.controller.wheels().iter().enumerate().take(4) {
                    let spin =
                        ((wheel.rotation / std::f32::consts::TAU).fract().abs() * 255.0) as u8;
                    let steer = (wheel.steering / VEHICLE_MAX_STEER_RAD * 127.0)
                        .clamp(-127.0, 127.0) as i8 as u8;
                    wheel_data[i] = ((spin as u16) << 8) | (steer as u16);
                }

                Some(make_net_vehicle_state(
                    id,
                    vehicle.vehicle_type,
                    0,
                    vehicle.driver_id.unwrap_or(0),
                    [p.x, p.y, p.z],
                    [r.i, r.j, r.k, r.w],
                    [lv.x, lv.y, lv.z],
                    [av.x, av.y, av.z],
                    wheel_data,
                ))
            })
            .collect()
    }

    pub fn step_dynamics(&mut self, dt: f32) {
        self.dynamic.step_dynamics(dt);
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        self.dynamic.snapshot_dynamic_bodies()
    }
}
