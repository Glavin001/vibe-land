use std::collections::HashMap;
use std::time::Instant;

use nalgebra::{DMatrix, Quaternion, UnitQuaternion, Vector3};
use rapier3d::control::DynamicRayCastVehicleController;
use rapier3d::prelude::*;
use vibe_land_shared::world_document::WorldDocumentArena;

use crate::protocol::*;
pub use vibe_land_shared::movement::{
    vehicle_wheel_params, MoveConfig, Vec3d, VEHICLE_MAX_STEER_RAD,
};
pub use vibe_land_shared::simulation::{
    simulate_player_tick_with_mode, PlayerKccMode, PlayerTickResult,
};
use vibe_land_shared::vehicle::{
    create_vehicle_physics, reset_vehicle_body, vehicle_suspension_filter,
};
pub use vibe_netcode::physics_arena::DynamicArena;

pub type Vec3 = Vector3<f32>;

pub struct Vehicle {
    pub chassis_body: RigidBodyHandle,
    pub chassis_collider: ColliderHandle,
    pub controller: DynamicRayCastVehicleController,
    pub vehicle_type: u8,
    pub driver_id: Option<u32>,
}

/// A battery consumable lying on the ground. Batteries are plain data
/// (not physics rigid bodies): pickup is a distance check in `tick()`.
#[derive(Clone, Debug)]
pub struct Battery {
    pub id: u32,
    pub position: Vec3d,
    pub energy: f32,
    pub radius: f32,
    pub height: f32,
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
    /// Player energy in arbitrary "energy units" (unbounded). Drained while in
    /// a vehicle, refilled by battery pickups. Reaching 0 triggers death and
    /// respawn, just like HP.
    pub energy: f32,
}

/// Server-side physics world: wraps `DynamicArena` (generic netcode library)
/// and adds game-specific player state management.
pub struct PhysicsArena {
    pub dynamic: DynamicArena,
    pub players: HashMap<u32, PlayerMotorState>,
    next_spawn_index: u32,
    player_kcc_mode: PlayerKccMode,

    pub vehicles: HashMap<u32, Vehicle>,
    next_vehicle_id: u32,
    pub vehicle_of_player: HashMap<u32, u32>,

    pub batteries: HashMap<u32, Battery>,
    next_battery_id: u32,
}

impl PhysicsArena {
    pub fn new(config: MoveConfig) -> Self {
        Self::with_player_kcc_mode(config, PlayerKccMode::OnePassSupportPredicate)
    }

    pub fn with_player_kcc_mode(config: MoveConfig, player_kcc_mode: PlayerKccMode) -> Self {
        Self {
            dynamic: DynamicArena::new(config),
            players: HashMap::new(),
            next_spawn_index: 0,
            player_kcc_mode,
            vehicles: HashMap::new(),
            next_vehicle_id: 1,
            vehicle_of_player: HashMap::new(),
            batteries: HashMap::new(),
            next_battery_id: vibe_land_shared::constants::BATTERY_ID_RANGE_START,
        }
    }

    /// Convenience accessor for the shared config.
    pub fn config(&self) -> &MoveConfig {
        self.dynamic.config()
    }

    /// Flush pending collider changes into the broad-phase BVH.
    pub fn sync_broad_phase(&mut self) {
        self.dynamic.sync_broad_phase();
    }

    /// Bootstrap the broad-phase BVH with all current colliders.
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
                energy: vibe_land_shared::constants::STARTING_ENERGY,
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
        heights: DMatrix<f32>,
        scale: Vec3,
        user_data: u128,
    ) -> ColliderHandle {
        self.dynamic
            .add_static_heightfield(center, heights, scale, user_data)
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.dynamic.remove_collider(handle);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.dynamic.collider_user_data(handle)
    }

    /// Wake up all dynamic bodies whose center is within `radius` of `center`.
    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        self.dynamic.wake_bodies_near(center, radius);
    }

    pub fn simulate_player_tick(
        &mut self,
        player_id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<PlayerTickResult> {
        // Players driving a vehicle don't move independently — store input for vehicle use.
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

        let mut tick_result = simulate_player_tick_with_mode(
            &self.dynamic.sim,
            state.collider,
            &mut state.position,
            &mut state.velocity,
            &mut state.yaw,
            &mut state.pitch,
            &mut state.on_ground,
            input,
            dt,
            self.player_kcc_mode,
        );
        let sync_started = Instant::now();
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        tick_result.timings.collider_sync_ms = sync_started.elapsed().as_secs_f32() * 1000.0;

        let impulse_started = Instant::now();
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
        tick_result.timings.dynamic_impulse_apply_ms =
            impulse_started.elapsed().as_secs_f32() * 1000.0;
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

        // When driving, report chassis position so client can keep player in vehicle.
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

    /// Current energy for `player_id`, or `None` if the player doesn't exist.
    pub fn player_energy(&self, player_id: u32) -> Option<f32> {
        self.players.get(&player_id).map(|state| state.energy)
    }

    /// Spawn a battery at `position` using an auto-assigned id.
    pub fn spawn_battery(
        &mut self,
        position: Vec3d,
        energy: f32,
        radius: f32,
        height: f32,
    ) -> u32 {
        let id = self.next_battery_id;
        self.next_battery_id = self.next_battery_id.saturating_add(1);
        self.batteries.insert(
            id,
            Battery {
                id,
                position,
                energy,
                radius,
                height,
            },
        );
        id
    }

    /// Spawn a battery at an explicit id (used by world document loading).
    pub fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vec3d,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        self.batteries.insert(
            id,
            Battery {
                id,
                position,
                energy,
                radius,
                height,
            },
        );
    }

    pub fn remove_battery(&mut self, id: u32) -> Option<Battery> {
        self.batteries.remove(&id)
    }

    /// Snapshot all batteries as `(id, position, energy, radius, height)`.
    pub fn snapshot_batteries(&self) -> Vec<(u32, [f32; 3], f32, f32, f32)> {
        self.batteries
            .values()
            .map(|b| {
                (
                    b.id,
                    [b.position.x as f32, b.position.y as f32, b.position.z as f32],
                    b.energy,
                    b.radius,
                    b.height,
                )
            })
            .collect()
    }

    /// Collect any batteries overlapping the given alive player and return the
    /// total energy gained. The player's own `energy` is **not** modified by
    /// this call — callers decide how to apply the delta (and can log or emit
    /// events). Returns an empty list if the player is dead or missing.
    pub fn collect_batteries_for_player(&mut self, player_id: u32) -> Vec<(u32, f32)> {
        let Some(player) = self.players.get(&player_id) else {
            return Vec::new();
        };
        if player.dead {
            return Vec::new();
        }

        let player_pos = player.position;
        let cfg = self.dynamic.config();
        let player_half_height = cfg.capsule_half_segment + cfg.capsule_radius;
        let player_r = cfg.capsule_radius;
        let slack = vibe_land_shared::constants::BATTERY_PICKUP_SLACK_M;

        let mut collected: Vec<(u32, f32)> = Vec::new();
        let mut collected_ids: Vec<u32> = Vec::new();
        for battery in self.batteries.values() {
            let dx = (battery.position.x - player_pos.x) as f32;
            let dz = (battery.position.z - player_pos.z) as f32;
            let dy = (battery.position.y - player_pos.y) as f32;
            let horiz = (dx * dx + dz * dz).sqrt();
            let horiz_limit = player_r + battery.radius + slack;
            let vert_limit = player_half_height + battery.height * 0.5 + slack;
            if horiz <= horiz_limit && dy.abs() <= vert_limit {
                collected.push((battery.id, battery.energy));
                collected_ids.push(battery.id);
            }
        }
        for id in collected_ids {
            self.batteries.remove(&id);
        }
        collected
    }

    /// Drain energy from every driver based on their vehicle's current speed.
    /// Dead players are skipped. Returns the list of players whose energy
    /// just crossed zero (so the caller can kill them with the appropriate
    /// death cause).
    pub fn apply_vehicle_energy_drain(&mut self, dt: f32) -> Vec<u32> {
        use vibe_land_shared::constants::{VEHICLE_IDLE_DRAIN_PER_SEC, VEHICLE_SPEED_DRAIN_COEF};
        let mut depleted: Vec<u32> = Vec::new();
        // Snapshot (driver_id, speed) first so we don't borrow `self` twice.
        let drain_inputs: Vec<(u32, f32)> = self
            .vehicle_of_player
            .iter()
            .filter_map(|(&player_id, &vehicle_id)| {
                let vehicle = self.vehicles.get(&vehicle_id)?;
                let rb = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body)?;
                let v = rb.linvel();
                let speed = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
                Some((player_id, speed))
            })
            .collect();

        for (player_id, speed) in drain_inputs {
            let Some(state) = self.players.get_mut(&player_id) else {
                continue;
            };
            if state.dead {
                continue;
            }
            let drain = (VEHICLE_IDLE_DRAIN_PER_SEC + VEHICLE_SPEED_DRAIN_COEF * speed) * dt;
            state.energy = (state.energy - drain).max(0.0);
            if state.energy <= 0.0 {
                depleted.push(player_id);
            }
        }
        depleted
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
            vector![dir[0], dir[1], dir[2]],
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
        let impulse = vector![impulse[0], impulse[1], impulse[2]];
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
        state.energy = vibe_land_shared::constants::STARTING_ENERGY;
        self.dynamic
            .sim
            .sync_player_collider(state.collider, &state.position);
        Some([spawn.x as f32, spawn.y as f32, spawn.z as f32])
    }

    // ── Dynamic body delegation ──────────────────────────────────────────────

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

    // ── Vehicle management ──────────────────────────────────────────────────

    /// Spawn a vehicle of the given type at `position`.  Returns its ID.
    pub fn spawn_vehicle(&mut self, vehicle_type: u8, position: Vec3) -> u32 {
        let id = self.next_vehicle_id;
        self.next_vehicle_id += 1;

        let pose = nalgebra::Isometry3::translation(position.x, position.y, position.z);
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

    /// Apply driver inputs to each vehicle and update suspension.
    /// Call BEFORE `step_dynamics` so forces are integrated in the same tick.
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

            // Collect driver input from the player driving this vehicle.
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

            // Apply inputs to wheels.
            let vehicle = self.vehicles.get_mut(&vid).unwrap();
            if reset_requested {
                if let Some(rb) = self.dynamic.sim.rigid_bodies.get_mut(vehicle.chassis_body) {
                    reset_vehicle_body(rb);
                }
            }
            for (i, wheel) in vehicle.controller.wheels_mut().iter_mut().enumerate() {
                if i < 2 {
                    wheel.steering = if reset_requested { 0.0 } else { steering };
                    // front-wheel steering
                }
                wheel.engine_force = if !reset_requested && i >= 2 {
                    engine_force
                } else {
                    0.0
                }; // RWD
                wheel.brake = if reset_requested { 0.0 } else { brake };
            }

            // Run suspension + traction.
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

    /// Put `player_id` into `vehicle_id`.
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
            // Ghost the player collider so it doesn't interfere with the chassis.
            if let Some(c) = self.dynamic.sim.colliders.get_mut(player.collider) {
                c.set_collision_groups(InteractionGroups::none());
            }
        }
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = Some(player_id);
        }
        self.vehicle_of_player.insert(player_id, vehicle_id);
    }

    /// Remove `player_id` from their current vehicle.
    pub fn exit_vehicle(&mut self, player_id: u32) {
        if let Some(vehicle_id) = self.detach_player_from_vehicles(player_id) {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                // Teleport player 2.5 m to the right of the chassis.
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

    /// Snapshot all vehicles for broadcasting.
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

impl WorldDocumentArena for PhysicsArena {
    fn add_static_heightfield(
        &mut self,
        center: Vec3,
        heights: DMatrix<f32>,
        scale: Vec3,
        user_data: u128,
    ) {
        PhysicsArena::add_static_heightfield(self, center, heights, scale, user_data);
    }

    fn add_static_cuboid(
        &mut self,
        center: Vec3,
        rotation: [f32; 4],
        half_extents: Vec3,
        user_data: u128,
    ) {
        PhysicsArena::add_static_cuboid_rotated(self, center, rotation, half_extents, user_data);
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vec3,
        rotation: [f32; 4],
        half_extents: Vec3,
    ) {
        PhysicsArena::spawn_dynamic_box_with_id(self, id, position, rotation, half_extents);
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vec3, radius: f32) {
        PhysicsArena::spawn_dynamic_ball_with_id(self, id, position, radius);
    }

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vec3,
        rotation: [f32; 4],
    ) {
        PhysicsArena::spawn_vehicle_with_id(self, id, vehicle_type, position, rotation);
    }

    fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vec3,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        let pos = Vec3d::new(position.x as f64, position.y as f64, position.z as f64);
        PhysicsArena::spawn_battery_with_id(self, id, pos, energy, radius, height);
    }

    fn rebuild_broad_phase(&mut self) {
        PhysicsArena::rebuild_broad_phase(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_land_shared::movement::build_wish_dir;

    fn input() -> InputCmd {
        InputCmd {
            seq: 1,
            buttons: 0,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    fn arena_with_ground_kcc_mode(player_kcc_mode: PlayerKccMode) -> PhysicsArena {
        let mut arena = PhysicsArena::with_player_kcc_mode(MoveConfig::default(), player_kcc_mode);
        arena.add_static_cuboid(
            Vector3::<f32>::new(0.0, -0.5, 0.0),
            Vector3::<f32>::new(50.0, 0.5, 50.0),
            0,
        );
        arena.rebuild_broad_phase();
        arena
    }

    fn arena_with_ground() -> PhysicsArena {
        arena_with_ground_kcc_mode(PlayerKccMode::TwoPass)
    }

    // ──────────────────────────────────────────────
    // build_wish_dir
    // ──────────────────────────────────────────────

    #[test]
    fn build_wish_dir_uses_move_axes_without_button_bits() {
        let mut cmd = input();
        cmd.move_x = 127;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x < -0.99);
        assert!(wish.z.abs() < 0.001);
    }

    #[test]
    fn build_wish_dir_falls_back_to_buttons_when_move_axes_are_zero() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_RIGHT;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x < -0.7);
        assert!(wish.z > 0.7);
    }

    #[test]
    fn build_wish_dir_forward_button_only() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.z > 0.99, "forward should produce +Z at yaw=0");
    }

    #[test]
    fn build_wish_dir_backward_button_only() {
        let mut cmd = input();
        cmd.buttons = BTN_BACK;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.z < -0.99, "back should produce -Z at yaw=0");
    }

    #[test]
    fn build_wish_dir_opposing_buttons_cancel() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_BACK;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.norm() < 0.01, "opposing buttons should cancel");
    }

    // ──────────────────────────────────────────────
    // simulate_player_tick — movement
    // ──────────────────────────────────────────────

    #[test]
    fn forward_movement_produces_positive_z() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        let mut cmd = input();
        cmd.move_y = 127;
        for _ in 0..30 {
            arena.simulate_player_tick(1, &cmd, 1.0 / 60.0);
        }

        let (pos, _vel, _, _, _, _) = arena.snapshot_player(1).unwrap();
        assert!(
            pos[2] > 0.5,
            "should have moved forward (z > 0.5), got {}",
            pos[2]
        );
    }

    #[test]
    fn sprint_moves_faster_than_walk() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.spawn_player(2);

        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
            arena.simulate_player_tick(2, &input(), 1.0 / 60.0);
        }

        let mut walk_cmd = input();
        walk_cmd.move_y = 127;

        let mut sprint_cmd = input();
        sprint_cmd.move_y = 127;
        sprint_cmd.buttons = BTN_SPRINT;

        for _ in 0..30 {
            arena.simulate_player_tick(1, &walk_cmd, 1.0 / 60.0);
            arena.simulate_player_tick(2, &sprint_cmd, 1.0 / 60.0);
        }

        let (walk_pos, _, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let (sprint_pos, _, _, _, _, _) = arena.snapshot_player(2).unwrap();
        assert!(
            sprint_pos[2] > walk_pos[2],
            "sprint should be faster than walk"
        );
    }

    #[test]
    fn crouch_speed_is_slowest() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.spawn_player(2);

        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
            arena.simulate_player_tick(2, &input(), 1.0 / 60.0);
        }

        let mut walk_cmd = input();
        walk_cmd.move_y = 127;

        let mut crouch_cmd = input();
        crouch_cmd.move_y = 127;
        crouch_cmd.buttons = BTN_CROUCH;

        for _ in 0..30 {
            arena.simulate_player_tick(1, &walk_cmd, 1.0 / 60.0);
            arena.simulate_player_tick(2, &crouch_cmd, 1.0 / 60.0);
        }

        let (walk_pos, _, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let (crouch_pos, _, _, _, _, _) = arena.snapshot_player(2).unwrap();
        assert!(crouch_pos[2] < walk_pos[2], "crouch should be slower");
    }

    #[test]
    fn jump_only_fires_when_grounded() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);

        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }
        let (pre_pos, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
        assert!(
            flags & 1 != 0,
            "should be grounded after settling, pos y={}",
            pre_pos[1]
        );

        let mut jump_cmd = input();
        jump_cmd.buttons = BTN_JUMP;
        arena.simulate_player_tick(1, &jump_cmd, 1.0 / 60.0);

        let (_, vel, _, _, _, _) = arena.snapshot_player(1).unwrap();
        assert!(vel[1] > 0.0, "jump should produce positive y velocity");
    }

    #[test]
    fn jump_ignored_in_air() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);

        let mut jump_cmd = input();
        jump_cmd.buttons = BTN_JUMP;
        arena.simulate_player_tick(1, &jump_cmd, 1.0 / 60.0);

        let (_, vel, _, _, _, _) = arena.snapshot_player(1).unwrap();
        assert!(vel[1].is_finite());
    }

    #[test]
    fn gravity_accumulates_in_freefall() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        arena.spawn_player(1);

        arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        let (_, vel1, _, _, _, _) = arena.snapshot_player(1).unwrap();

        arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        let (_, vel2, _, _, _, _) = arena.snapshot_player(1).unwrap();

        assert!(
            vel2[1] < vel1[1],
            "velocity should decrease (more negative) with gravity"
        );
    }

    #[test]
    fn friction_stops_player_when_no_input() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);

        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..30 {
            arena.simulate_player_tick(1, &fwd, 1.0 / 60.0);
        }
        let (_, vel_moving, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let speed_moving = (vel_moving[0].powi(2) + vel_moving[2].powi(2)).sqrt();
        assert!(speed_moving > 1.0, "should be moving");

        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }
        let (_, vel_stopped, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let speed_stopped = (vel_stopped[0].powi(2) + vel_stopped[2].powi(2)).sqrt();
        assert!(
            speed_stopped < 0.1,
            "friction should stop player, got {}",
            speed_stopped
        );
    }

    // ──────────────────────────────────────────────
    // Determinism
    // ──────────────────────────────────────────────

    #[test]
    fn same_inputs_produce_same_position() {
        let mut cmd = input();
        cmd.move_y = 127;
        cmd.buttons = BTN_SPRINT;

        let positions: Vec<[f32; 3]> = (0..2)
            .map(|_| {
                let mut arena = arena_with_ground();
                arena.spawn_player(1);
                for _ in 0..60 {
                    arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
                }
                for _ in 0..60 {
                    arena.simulate_player_tick(1, &cmd, 1.0 / 60.0);
                }
                let (pos, _, _, _, _, _) = arena.snapshot_player(1).unwrap();
                pos
            })
            .collect();

        for i in 0..3 {
            assert!(
                (positions[0][i] - positions[1][i]).abs() < 1e-6,
                "position[{i}] should be deterministic: {} vs {}",
                positions[0][i],
                positions[1][i],
            );
        }
    }

    // ──────────────────────────────────────────────
    // PhysicsArena lifecycle
    // ──────────────────────────────────────────────

    #[test]
    fn spawn_and_remove_player() {
        let mut arena = arena_with_ground();
        let _spawn_pos = arena.spawn_player(1);
        assert!(arena.snapshot_player(1).is_some());

        arena.remove_player(1);
        assert!(arena.snapshot_player(1).is_none());
    }

    #[test]
    fn removing_driver_releases_vehicle() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        let vehicle_id = arena.spawn_vehicle(0, vector![0.0, 2.0, 0.0]);

        arena.enter_vehicle(1, vehicle_id);
        assert_eq!(
            arena.vehicles.get(&vehicle_id).and_then(|v| v.driver_id),
            Some(1)
        );
        assert_eq!(arena.vehicle_of_player.get(&1), Some(&vehicle_id));

        arena.remove_player(1);

        assert_eq!(
            arena.vehicles.get(&vehicle_id).and_then(|v| v.driver_id),
            None
        );
        assert!(!arena.vehicle_of_player.contains_key(&1));
    }

    #[test]
    fn stale_vehicle_driver_does_not_block_entry() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        let vehicle_id = arena.spawn_vehicle(0, vector![0.0, 2.0, 0.0]);

        if let Some(vehicle) = arena.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = Some(99);
        }

        arena.enter_vehicle(1, vehicle_id);

        assert_eq!(
            arena.vehicles.get(&vehicle_id).and_then(|v| v.driver_id),
            Some(1)
        );
        assert_eq!(arena.vehicle_of_player.get(&1), Some(&vehicle_id));
    }

    #[test]
    fn occupied_vehicle_stays_locked_for_other_players() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.spawn_player(2);
        let vehicle_id = arena.spawn_vehicle(0, vector![0.0, 2.0, 0.0]);

        arena.enter_vehicle(1, vehicle_id);
        arena.enter_vehicle(2, vehicle_id);

        assert_eq!(
            arena.vehicles.get(&vehicle_id).and_then(|v| v.driver_id),
            Some(1)
        );
        assert_eq!(arena.vehicle_of_player.get(&1), Some(&vehicle_id));
        assert!(!arena.vehicle_of_player.contains_key(&2));
    }

    #[test]
    fn wall_collision_stops_horizontal_movement() {
        let mut arena = arena_with_ground();
        arena.add_static_cuboid(
            Vector3::<f32>::new(0.0, 2.5, 3.0),
            Vector3::<f32>::new(10.0, 5.0, 0.5),
            0,
        );
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &fwd, 1.0 / 60.0);
        }

        let (pos, _, _, _, _, _) = arena.snapshot_player(1).unwrap();
        assert!(pos[2] < 3.0, "should be stopped by wall, got z={}", pos[2]);
        assert!(pos[2] > 0.5, "should have moved toward wall");
    }

    /// Verify that a pushed ball doesn't tunnel through the ground.
    #[test]
    fn pushed_ball_stays_above_ground() {
        use crate::voxel_world::VoxelWorld;

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);

        let ball_id = arena.spawn_dynamic_ball(vector![5.0, 2.0, 5.0], 0.3);
        arena.rebuild_broad_phase();

        for _ in 0..120 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snap_before = arena.snapshot_dynamic_bodies();
        let ball = snap_before.iter().find(|s| s.0 == ball_id).unwrap();
        eprintln!("Ball before push: y={:.3}", ball.1[1]);
        assert!(ball.1[1] > 1.0, "Ball should be on ground before push");

        if let Some(db) = arena.dynamic.dynamic_bodies.get(&ball_id) {
            if let Some(rb) = arena.dynamic.sim.rigid_bodies.get_mut(db.body_handle) {
                rb.apply_impulse(vector![10.0, 0.0, 10.0], true);
            }
        }

        for _ in 0..300 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snap_after = arena.snapshot_dynamic_bodies();
        let ball = snap_after.iter().find(|s| s.0 == ball_id).unwrap();
        eprintln!("Ball after push: y={:.3}", ball.1[1]);
        assert!(
            ball.1[1] > 0.5,
            "Ball tunneled through ground after push! y={}",
            ball.1[1]
        );
    }

    #[test]
    fn balls_survive_interleaved_player_and_dynamics() {
        use crate::voxel_world::VoxelWorld;

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);
        arena.rebuild_broad_phase();

        let player_id = 1u32;
        arena.spawn_player(player_id);
        arena.rebuild_broad_phase();

        let idle_input = input();
        let dt = 1.0_f32 / 60.0;

        for tick in 0..600 {
            arena.simulate_player_tick(player_id, &idle_input, dt);
            arena.step_dynamics(dt);

            if (tick + 1) % 120 == 0 {
                let snap = arena.snapshot_dynamic_bodies();
                let fallen: Vec<_> = snap.iter().filter(|s| s.6 == 1 && s.1[1] < 0.0).collect();
                if !fallen.is_empty() {
                    eprintln!(
                        "tick {}: {} / {} balls below y=0",
                        tick + 1,
                        fallen.len(),
                        snap.iter().filter(|s| s.6 == 1).count(),
                    );
                }
            }
        }

        let snapshot = arena.snapshot_dynamic_bodies();
        let balls: Vec<_> = snapshot.iter().filter(|s| s.6 == 1).collect();
        assert!(!balls.is_empty(), "expected ball-pit balls");

        let fallen: Vec<_> = balls.iter().filter(|b| b.1[1] < 0.0).collect();
        assert_eq!(
            fallen.len(),
            0,
            "{} / {} balls fell through the ground with interleaved player+dynamics!",
            fallen.len(),
            balls.len(),
        );
    }

    #[test]
    fn dynamic_bodies_land_on_voxel_ground() {
        use crate::voxel_world::VoxelWorld;

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);

        let box_id = arena.spawn_dynamic_box(vector![4.0, 8.0, 4.0], vector![0.5, 0.5, 0.5]);
        let ball_id = arena.spawn_dynamic_ball(vector![6.0, 8.0, 4.0], 0.5);

        arena.rebuild_broad_phase();

        for _ in 0..600 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snapshot = arena.snapshot_dynamic_bodies();
        let box_state = snapshot.iter().find(|s| s.0 == box_id).unwrap();
        let ball_state = snapshot.iter().find(|s| s.0 == ball_id).unwrap();

        assert!(
            box_state.1[1] > 0.5,
            "Box fell through ground! y={}",
            box_state.1[1]
        );
        assert!(
            box_state.1[1] < 3.0,
            "Box is floating too high! y={}",
            box_state.1[1]
        );
        assert!(
            ball_state.1[1] > 0.5,
            "Ball fell through ground! y={}",
            ball_state.1[1]
        );
        assert!(
            ball_state.1[1] < 3.0,
            "Ball is floating too high! y={}",
            ball_state.1[1]
        );
    }

    #[test]
    fn block_edit_does_not_break_ball_physics() {
        use crate::protocol::{BlockEditCmd, BLOCK_REMOVE};
        use crate::voxel_world::{world_to_chunk_and_local, VoxelWorld};

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;

        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        let pre_snap = arena.snapshot_dynamic_bodies();
        let pre_balls: Vec<_> = pre_snap.iter().filter(|s| s.6 == 1).collect();
        assert!(!pre_balls.is_empty(), "expected ball-pit balls");
        let pre_fallen: Vec<_> = pre_balls.iter().filter(|b| b.1[1] < 0.0).collect();
        assert_eq!(pre_fallen.len(), 0, "balls fell before edit");

        let (key, local) = world_to_chunk_and_local(0, 0, 0);
        let chunk_version = world.chunks.get(&key).map(|c| c.version).unwrap_or(0);
        let cmd = BlockEditCmd {
            chunk: [key.x as i16, key.y as i16, key.z as i16],
            local: [local[0], local[1], local[2]],
            expected_version: chunk_version,
            op: BLOCK_REMOVE,
            material: 0,
        };
        let _ = world.apply_edit(&mut arena, &cmd);

        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        let post_snap = arena.snapshot_dynamic_bodies();
        let post_balls: Vec<_> = post_snap.iter().filter(|s| s.6 == 1).collect();
        let post_fallen: Vec<_> = post_balls.iter().filter(|b| b.1[1] < 0.0).collect();
        assert_eq!(
            post_fallen.len(),
            0,
            "{} / {} balls fell through ground after block edit!",
            post_fallen.len(),
            post_balls.len(),
        );
    }

    #[test]
    fn ball_falls_through_deleted_floor_block() {
        use crate::protocol::{BlockEditCmd, BLOCK_ADD, BLOCK_REMOVE};
        use crate::voxel_world::{world_to_chunk_and_local, VoxelWorld};

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();

        for x in 0..8 {
            for z in 0..8 {
                let (key, local) = world_to_chunk_and_local(x, 0, z);
                let cmd = BlockEditCmd {
                    chunk: [key.x as i16, key.y as i16, key.z as i16],
                    local: [local[0], local[1], local[2]],
                    expected_version: world.chunks.get(&key).map(|c| c.version).unwrap_or(0),
                    op: BLOCK_ADD,
                    material: 1,
                };
                let _ = world.apply_edit(&mut arena, &cmd);
            }
        }

        let ball_id = arena.spawn_dynamic_ball(vector![4.5, 3.0, 4.5], 0.3);

        let dt = 1.0_f32 / 60.0;
        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        let pre_snap = arena.snapshot_dynamic_bodies();
        let pre_ball = pre_snap.iter().find(|s| s.0 == ball_id).unwrap();
        let pre_y = pre_ball.1[1];
        assert!(
            pre_y > 0.5 && pre_y < 2.0,
            "ball should be resting on ground, y={pre_y}"
        );

        let (key, local) = world_to_chunk_and_local(4, 0, 4);
        let chunk_version = world.chunks.get(&key).map(|c| c.version).unwrap_or(0);
        let cmd = BlockEditCmd {
            chunk: [key.x as i16, key.y as i16, key.z as i16],
            local: [local[0], local[1], local[2]],
            expected_version: chunk_version,
            op: BLOCK_REMOVE,
            material: 0,
        };
        let result = world.apply_edit(&mut arena, &cmd);
        assert!(result.is_ok(), "apply_edit failed: {:?}", result.err());

        {
            let db = arena.dynamic.dynamic_bodies.get(&ball_id).unwrap();
            let rb = arena.dynamic.sim.rigid_bodies.get(db.body_handle).unwrap();
            eprintln!("Ball sleeping={}", rb.is_sleeping());
        }

        let fresh_ball_id = arena.spawn_dynamic_ball(vector![4.5, 5.0, 4.5], 0.3);
        {
            let db = arena.dynamic.dynamic_bodies.get(&ball_id).unwrap();
            arena.dynamic.sim.island_manager.wake_up(
                &mut arena.dynamic.sim.rigid_bodies,
                db.body_handle,
                true,
            );
        }

        for _ in 0..180 {
            arena.step_dynamics(dt);
        }
        let _ = fresh_ball_id; // used above

        let post_snap = arena.snapshot_dynamic_bodies();
        let post_ball = post_snap.iter().find(|s| s.0 == ball_id).unwrap();
        assert!(
            post_ball.1[1] < pre_y - 0.5,
            "Ball should have fallen after floor removed! pre_y={:.3}, post_y={:.3}",
            pre_y,
            post_ball.1[1],
        );
    }

    #[test]
    fn cast_dynamic_body_ray_uses_current_authoritative_body_pose() {
        let mut arena = arena_with_ground();
        let ball_id = arena.spawn_dynamic_ball(vector![0.0, 1.0, 6.0], 0.3);
        arena.rebuild_broad_phase();

        let origin = [0.0, 1.0, 0.0];
        let dir = [0.0, 0.0, 1.0];
        let first_hit = arena.cast_dynamic_body_ray(origin, dir, 20.0, None);
        assert_eq!(first_hit.map(|(id, _, _)| id), Some(ball_id));

        let db = arena.dynamic.dynamic_bodies.get(&ball_id).unwrap();
        let rb = arena
            .dynamic
            .sim
            .rigid_bodies
            .get_mut(db.body_handle)
            .unwrap();
        rb.set_translation(vector![3.0, 1.0, 6.0], true);
        arena
            .dynamic
            .sim
            .rigid_bodies
            .propagate_modified_body_positions_to_colliders(&mut arena.dynamic.sim.colliders);
        arena.sync_broad_phase();

        let stale_hit = arena.cast_dynamic_body_ray(origin, dir, 20.0, None);
        assert!(
            stale_hit.is_none(),
            "raycast should miss the old position after the authoritative body moved"
        );

        let moved_origin = [3.0, 1.0, 0.0];
        let moved_hit = arena.cast_dynamic_body_ray(moved_origin, dir, 20.0, None);
        assert_eq!(moved_hit.map(|(id, _, _)| id), Some(ball_id));
    }

    #[test]
    fn rapier_orphan_collider_removal_minimal() {
        let mut pipeline = PhysicsPipeline::new();
        let gravity = vector![0.0, -9.81, 0.0];
        let mut params = IntegrationParameters::default();
        params.dt = 1.0 / 60.0;
        let mut islands = IslandManager::new();
        let mut broad = BroadPhaseBvh::new();
        let mut narrow = NarrowPhase::new();
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();
        let mut multi_joints = MultibodyJointSet::new();
        let mut ccd = CCDSolver::new();

        let floor = colliders.insert(
            ColliderBuilder::cuboid(5.0, 0.5, 5.0)
                .translation(vector![0.0, -0.5, 0.0])
                .build(),
        );

        let ball_body = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![0.0, 3.0, 0.0])
                .build(),
        );
        colliders.insert_with_parent(
            ColliderBuilder::ball(0.3).restitution(0.0).build(),
            ball_body,
            &mut bodies,
        );

        for _ in 0..300 {
            pipeline.step(
                &gravity,
                &params,
                &mut islands,
                &mut broad,
                &mut narrow,
                &mut bodies,
                &mut colliders,
                &mut joints,
                &mut multi_joints,
                &mut ccd,
                &(),
                &(),
            );
        }

        let pre_y = bodies.get(ball_body).unwrap().translation().y;

        colliders.remove(floor, &mut islands, &mut bodies, true);
        islands.wake_up(&mut bodies, ball_body, true);

        for _ in 0..120 {
            pipeline.step(
                &gravity,
                &params,
                &mut islands,
                &mut broad,
                &mut narrow,
                &mut bodies,
                &mut colliders,
                &mut joints,
                &mut multi_joints,
                &mut ccd,
                &(),
                &(),
            );
        }

        let post_y = bodies.get(ball_body).unwrap().translation().y;
        assert!(
            post_y < pre_y - 1.0,
            "Ball should fall after orphan floor removed! pre={pre_y:.4}, post={post_y:.4}"
        );
    }

    #[test]
    fn player_pushes_ball_when_walking_into_it() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
        }

        let player_pos = arena.snapshot_player(1).unwrap().0;
        let ball_id = arena.spawn_dynamic_ball(
            vector![player_pos[0], player_pos[1], player_pos[2] + 2.0],
            0.3,
        );
        arena.rebuild_broad_phase();

        for _ in 0..60 {
            arena.step_dynamics(dt);
        }
        let ball_before = arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .find(|s| s.0 == ball_id)
            .unwrap();
        let ball_z_before = ball_before.1[2];

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..60 {
            arena.simulate_player_tick(1, &fwd, dt);
            arena.step_dynamics(dt);
        }

        let ball_after = arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .find(|s| s.0 == ball_id)
            .unwrap();
        assert!(
            ball_after.1[2] > ball_z_before + 0.3,
            "Ball should be pushed forward: before z={:.3}, after z={:.3}",
            ball_z_before,
            ball_after.1[2],
        );
    }

    #[test]
    fn player_advances_through_ball() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
        }

        let player_start = arena.snapshot_player(1).unwrap().0;
        arena.spawn_dynamic_ball(
            vector![player_start[0], player_start[1], player_start[2] + 2.0],
            0.3,
        );
        arena.rebuild_broad_phase();
        for _ in 0..60 {
            arena.step_dynamics(dt);
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &fwd, dt);
            arena.step_dynamics(dt);
        }

        let player_end = arena.snapshot_player(1).unwrap().0;
        assert!(
            player_end[2] > player_start[2] + 1.0,
            "Player should advance past ball: start z={:.3}, end z={:.3}",
            player_start[2],
            player_end[2],
        );
    }

    #[test]
    fn player_can_stand_stably_on_dynamic_box() {
        let mut arena = arena_with_ground();
        let box_id = arena.spawn_dynamic_box(vector![0.0, 3.0, 0.0], vector![0.6, 0.6, 0.6]);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        for _ in 0..240 {
            arena.step_dynamics(dt);
        }

        arena.spawn_player(1);
        if let Some(state) = arena.players.get_mut(&1) {
            state.position = Vector3::<f64>::new(0.0, 4.0, 0.0);
            state.velocity = Vec3d::zeros();
            arena
                .dynamic
                .sim
                .sync_player_collider(state.collider, &state.position);
        }

        let mut settle_ticks = 0usize;
        for _ in 0..180 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
            let (_, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
            if flags & FLAG_ON_GROUND != 0 {
                settle_ticks += 1;
            }
        }

        let mut ys = Vec::new();
        let mut grounded_ticks = 0usize;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
            let (pos, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
            ys.push(pos[1]);
            if flags & FLAG_ON_GROUND != 0 {
                grounded_ticks += 1;
            }
        }

        let box_state = arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .find(|s| s.0 == box_id)
            .unwrap();
        let max_y = ys.iter().copied().fold(f32::MIN, f32::max);
        let min_y = ys.iter().copied().fold(f32::MAX, f32::min);
        assert!(
            settle_ticks > 60,
            "player should land on the dynamic box during settle, grounded={settle_ticks}"
        );
        assert!(
            grounded_ticks > 90,
            "player should remain grounded on dynamic box most ticks, grounded={grounded_ticks}"
        );
        assert!(
            max_y - min_y < 0.18,
            "standing on dynamic box should be stable, y range={:.3}",
            max_y - min_y
        );
        assert!(
            box_state.1[1] > 0.5,
            "dynamic box should remain resting on the floor, y={:.3}",
            box_state.1[1]
        );
    }

    #[test]
    fn one_pass_support_predicate_advances_through_ball() {
        let mut arena = arena_with_ground_kcc_mode(PlayerKccMode::OnePassSupportPredicate);
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
        }

        let player_start = arena.snapshot_player(1).unwrap().0;
        arena.spawn_dynamic_ball(
            vector![player_start[0], player_start[1], player_start[2] + 2.0],
            0.3,
        );
        arena.rebuild_broad_phase();
        for _ in 0..60 {
            arena.step_dynamics(dt);
        }

        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &fwd, dt);
            arena.step_dynamics(dt);
        }

        let player_end = arena.snapshot_player(1).unwrap().0;
        assert!(
            player_end[2] > player_start[2] + 1.0,
            "merged KCC should still advance past ball: start z={:.3}, end z={:.3}",
            player_start[2],
            player_end[2],
        );
    }

    #[test]
    fn one_pass_support_predicate_can_stand_on_dynamic_box() {
        let mut arena = arena_with_ground_kcc_mode(PlayerKccMode::OnePassSupportPredicate);
        let box_id = arena.spawn_dynamic_box(vector![0.0, 3.0, 0.0], vector![0.6, 0.6, 0.6]);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        for _ in 0..240 {
            arena.step_dynamics(dt);
        }

        arena.spawn_player(1);
        if let Some(state) = arena.players.get_mut(&1) {
            state.position = Vector3::<f64>::new(0.0, 4.0, 0.0);
            state.velocity = Vec3d::zeros();
            arena
                .dynamic
                .sim
                .sync_player_collider(state.collider, &state.position);
        }

        let mut settle_ticks = 0usize;
        for _ in 0..180 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
            let (_, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
            if flags & FLAG_ON_GROUND != 0 {
                settle_ticks += 1;
            }
        }

        let mut grounded_ticks = 0usize;
        let mut ys = Vec::new();
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
            let (pos, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
            ys.push(pos[1]);
            if flags & FLAG_ON_GROUND != 0 {
                grounded_ticks += 1;
            }
        }

        let box_state = arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .find(|s| s.0 == box_id)
            .unwrap();
        let max_y = ys.iter().copied().fold(f32::MIN, f32::max);
        let min_y = ys.iter().copied().fold(f32::MAX, f32::min);
        assert!(
            settle_ticks > 60,
            "merged KCC should land on dynamic box during settle, grounded={settle_ticks}"
        );
        assert!(
            grounded_ticks > 90,
            "merged KCC should remain grounded on dynamic box, grounded={grounded_ticks}"
        );
        assert!(
            max_y - min_y < 0.2,
            "merged KCC standing on dynamic box should stay stable, y range={:.3}",
            max_y - min_y
        );
        assert!(
            box_state.1[1] > 0.5,
            "dynamic box should remain resting on the floor, y={:.3}",
            box_state.1[1]
        );
    }

    // ──────────────────────────────────────────────
    // Energy + battery tests
    // ──────────────────────────────────────────────

    fn battery_arena() -> PhysicsArena {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena
    }

    #[test]
    fn player_spawns_with_full_energy() {
        let arena = battery_arena();
        assert_eq!(
            arena.player_energy(1),
            Some(vibe_land_shared::constants::STARTING_ENERGY)
        );
    }

    #[test]
    fn walking_does_not_drain_energy() {
        let mut arena = battery_arena();
        // No vehicle entered — drain should be zero for the player on foot.
        let depleted = arena.apply_vehicle_energy_drain(1.0);
        assert!(depleted.is_empty());
        assert_eq!(
            arena.player_energy(1),
            Some(vibe_land_shared::constants::STARTING_ENERGY)
        );
    }

    #[test]
    fn vehicle_idle_energy_drain_matches_formula() {
        let mut arena = battery_arena();
        // Spawn a vehicle at the player's feet and put the player inside.
        let vehicle_id = arena.spawn_vehicle(0, Vec3::new(0.0, 0.5, 0.0));
        arena.enter_vehicle(1, vehicle_id);
        let start = arena.player_energy(1).unwrap();
        // Zero-velocity chassis: drain = IDLE_DRAIN_PER_SEC * dt.
        arena.apply_vehicle_energy_drain(1.0);
        let end = arena.player_energy(1).unwrap();
        let delta = start - end;
        let expected = vibe_land_shared::constants::VEHICLE_IDLE_DRAIN_PER_SEC;
        assert!(
            (delta - expected).abs() < 0.1,
            "idle drain was {delta}, expected ~{expected}"
        );
    }

    #[test]
    fn energy_depletion_returns_depleted_player_id() {
        let mut arena = battery_arena();
        let vehicle_id = arena.spawn_vehicle(0, Vec3::new(0.0, 0.5, 0.0));
        arena.enter_vehicle(1, vehicle_id);
        // Drain everything in one giant step.
        if let Some(state) = arena.players.get_mut(&1) {
            state.energy = 0.5;
        }
        let depleted = arena.apply_vehicle_energy_drain(10.0);
        assert_eq!(depleted, vec![1]);
        assert_eq!(arena.player_energy(1), Some(0.0));
    }

    #[test]
    fn collect_batteries_picks_up_overlap() {
        let mut arena = battery_arena();
        // Battery directly on top of the player spawn position.
        let player_pos = arena.players.get(&1).unwrap().position;
        arena.spawn_battery(player_pos, 500.0, 0.4, 0.8);
        let collected = arena.collect_batteries_for_player(1);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].1, 500.0);
        assert!(arena.batteries.is_empty(), "battery should be removed on pickup");
    }

    #[test]
    fn collect_batteries_skips_far_batteries() {
        let mut arena = battery_arena();
        // Battery 20 m away from the player.
        arena.spawn_battery(Vec3d::new(20.0, 2.0, 20.0), 500.0, 0.4, 0.8);
        let collected = arena.collect_batteries_for_player(1);
        assert!(collected.is_empty());
        assert_eq!(arena.batteries.len(), 1);
    }

    #[test]
    fn collect_batteries_skips_dead_players() {
        let mut arena = battery_arena();
        arena.set_player_dead(1, true);
        let player_pos = arena.players.get(&1).unwrap().position;
        arena.spawn_battery(player_pos, 500.0, 0.4, 0.8);
        let collected = arena.collect_batteries_for_player(1);
        assert!(collected.is_empty());
        assert_eq!(arena.batteries.len(), 1);
    }

    #[test]
    fn respawn_resets_energy() {
        let mut arena = battery_arena();
        if let Some(state) = arena.players.get_mut(&1) {
            state.energy = 12.3;
        }
        arena.set_player_dead(1, true);
        arena.respawn_player(1);
        assert_eq!(
            arena.player_energy(1),
            Some(vibe_land_shared::constants::STARTING_ENERGY)
        );
    }

    #[test]
    fn spawn_battery_ids_are_out_of_dynamic_body_range() {
        let mut arena = battery_arena();
        let id = arena.spawn_battery(Vec3d::new(0.0, 2.0, 0.0), 100.0, 0.4, 0.8);
        assert!(id >= vibe_land_shared::constants::BATTERY_ID_RANGE_START);
    }

    #[test]
    fn snapshot_batteries_reports_all_batteries() {
        let mut arena = battery_arena();
        let a = arena.spawn_battery(Vec3d::new(1.0, 2.0, 0.0), 100.0, 0.4, 0.8);
        let b = arena.spawn_battery(Vec3d::new(-1.0, 2.0, 0.0), 200.0, 0.5, 1.0);
        let snap = arena.snapshot_batteries();
        assert_eq!(snap.len(), 2);
        let ids: Vec<u32> = snap.iter().map(|s| s.0).collect();
        assert!(ids.contains(&a));
        assert!(ids.contains(&b));
    }
}
