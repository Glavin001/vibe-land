#![cfg(feature = "physx-gpu")]

use std::collections::HashMap;

use anyhow::{Context, Result};
use nalgebra::{DMatrix, Vector3};
use vibe_land_physx_bridge as bridge;
use vibe_land_shared::{
    constants::{
        BTN_JUMP, BTN_SPRINT, FLAG_DEAD, FLAG_IN_VEHICLE, FLAG_ON_GROUND, FLAG_SPAWN_PROTECTED,
        JUMP_ENERGY_COST, ON_FOOT_IDLE_DRAIN_PER_SEC, ON_FOOT_SPRINT_DRAIN_PER_SEC,
        ON_FOOT_WALK_DRAIN_PER_SEC, SHAPE_BOX, SHAPE_SPHERE, STARTING_ENERGY,
        VEHICLE_INTERACT_RADIUS_M,
    },
    movement::{build_wish_dir, VEHICLE_DAMAGE_MIN_SPEED_M_S, VEHICLE_LETHAL_SPEED_M_S},
    physics_arena::{MoveConfig, PlayerDamageOutcome, PlayerTickResult},
    protocol::{make_net_vehicle_state, InputCmd, NetVehicleState},
    world_document::{
        EffectiveTerrainMaterial, SpawnArea, TerrainMaterialField, WorldDocumentArena,
    },
};
use vibe_netcode::movement::{accelerate, apply_horizontal_friction, Vec3d};

use crate::movement::{PhysicsHealth, PlayerStateSummary, PlayerSupportState};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_DYNAMIC: u32 = 1 << 1;
const GROUP_PLAYER: u32 = 1 << 2;
const GROUP_VEHICLE: u32 = 1 << 3;
const GROUP_BATTERY: u32 = 1 << 4;
const GROUP_CHUNK: u32 = 1 << 5;
pub const ALL_GROUPS: u32 =
    GROUP_STATIC | GROUP_DYNAMIC | GROUP_PLAYER | GROUP_VEHICLE | GROUP_BATTERY | GROUP_CHUNK;

const NS_STATIC: u32 = 0x1000_0000;
const NS_DYNAMIC: u32 = 0x2000_0000;
const NS_PLAYER: u32 = 0x4000_0000;
const NS_VEHICLE: u32 = 0x6000_0000;
const NS_BATTERY: u32 = 0x7000_0000;
const ID_MASK: u32 = 0x0fff_ffff;

#[derive(Clone)]
struct PlayerState {
    position: Vec3d,
    velocity: Vec3d,
    yaw: f64,
    pitch: f64,
    last_input: InputCmd,
    on_ground: bool,
    hp: u8,
    dead: bool,
    spawn_protected: bool,
    energy: f32,
    controller_present: bool,
    support_entity_id: Option<u32>,
}

struct DynamicMeta {
    half_extents: [f32; 3],
    shape_type: u8,
}

struct VehicleMeta {
    vehicle_type: u8,
    driver_id: u32,
    latest_input: InputCmd,
}

struct BatteryState {
    position: [f32; 3],
    energy: f32,
    radius: f32,
    height: f32,
}

/// Rust gameplay adapter over the single-threaded C++ PhysX scene.
pub struct PhysxPhysicsArena {
    world: bridge::World,
    config: MoveConfig,
    players: HashMap<u32, PlayerState>,
    dynamic: HashMap<u32, DynamicMeta>,
    vehicles: HashMap<u32, VehicleMeta>,
    vehicle_of_player: HashMap<u32, u32>,
    batteries: HashMap<u32, BatteryState>,
    spawn_areas: Vec<SpawnArea>,
    runtime_static: HashMap<u64, (u32, u128)>,
    next_static_id: u32,
    next_dynamic_id: u32,
    next_battery_id: u32,
    material_field: Option<TerrainMaterialField>,
    /// The GPU buffer capacities this scene was created with. Published beside
    /// the high-water marks so utilisation reads as a ratio: with no caps on
    /// body or bond count, overrunning one of these is a real failure mode, and
    /// "1.9M contacts" means nothing without the ceiling next to it.
    gpu_max_rigid_contacts: u32,
    gpu_max_rigid_patches: u32,
    contact_events: Vec<bridge::ContactEvent>,
    cached_body_snapshots: Vec<bridge::BodySnapshot>,
    cached_vehicle_snapshots: Vec<bridge::VehicleSnapshot>,
    snapshots_valid: bool,
    /// Interior of the old single `dynamics_ms` bracket: the three FFI
    /// readbacks after the step, the player refresh, and the vehicle control
    /// loop before it. Without these, `dynamics_ms - physics_last_step_ms` was
    /// a real cost with no name.
    last_readback_ms: f32,
    last_refresh_players_ms: f32,
    last_vehicle_control_ms: f32,
}

impl PhysxPhysicsArena {
    pub fn new(config: MoveConfig) -> Result<Self> {
        let mut world_config = bridge::WorldConfig::default();
        world_config.gpu_max_rigid_contacts = env_u32(
            "VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS",
            world_config.gpu_max_rigid_contacts,
        )?;
        world_config.gpu_max_rigid_patches = env_u32(
            "VIBE_PHYSX_GPU_MAX_RIGID_PATCHES",
            world_config.gpu_max_rigid_patches,
        )?;
        world_config.gpu_heap_capacity = env_u32(
            "VIBE_PHYSX_GPU_HEAP_CAPACITY",
            world_config.gpu_heap_capacity,
        )?;
        world_config.gpu_found_lost_pairs_capacity = env_u32(
            "VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY",
            world_config.gpu_found_lost_pairs_capacity,
        )?;
        world_config.gpu_collision_stack_size = env_u32(
            "VIBE_PHYSX_GPU_COLLISION_STACK_SIZE",
            world_config.gpu_collision_stack_size,
        )?;
        let world = bridge::World::new(world_config)
            .context("failed to initialize required PhysX GPU scene")?;
        Ok(Self {
            world,
            config,
            players: HashMap::new(),
            dynamic: HashMap::new(),
            vehicles: HashMap::new(),
            vehicle_of_player: HashMap::new(),
            batteries: HashMap::new(),
            spawn_areas: Vec::new(),
            runtime_static: HashMap::new(),
            next_static_id: 1,
            next_dynamic_id: 1,
            next_battery_id: 1,
            material_field: None,
            contact_events: Vec::new(),
            cached_body_snapshots: Vec::new(),
            cached_vehicle_snapshots: Vec::new(),
            snapshots_valid: false,
            gpu_max_rigid_contacts: world_config.gpu_max_rigid_contacts,
            gpu_max_rigid_patches: world_config.gpu_max_rigid_patches,
            last_readback_ms: 0.0,
            last_refresh_players_ms: 0.0,
            last_vehicle_control_ms: 0.0,
        })
    }

    fn current_body_snapshots(&self) -> Vec<bridge::BodySnapshot> {
        if self.snapshots_valid {
            self.cached_body_snapshots.clone()
        } else {
            self.world
                .body_snapshots()
                .expect("PhysX body readback failed")
        }
    }

    fn current_vehicle_snapshots(&self) -> Vec<bridge::VehicleSnapshot> {
        if self.snapshots_valid {
            self.cached_vehicle_snapshots.clone()
        } else {
            self.world
                .vehicle_snapshots()
                .expect("PhysX vehicle readback failed")
        }
    }

    pub fn config(&self) -> &MoveConfig {
        &self.config
    }

    #[cfg(feature = "destruction")]
    pub fn world_mut(&mut self) -> &mut bridge::World {
        &mut self.world
    }

    #[cfg(feature = "destruction")]
    pub fn world(&self) -> &bridge::World {
        &self.world
    }

    pub fn set_spawn_areas(&mut self, areas: Vec<SpawnArea>) {
        self.spawn_areas = areas;
    }

    pub fn spawn_areas(&self) -> &[SpawnArea] {
        &self.spawn_areas
    }

    fn spawn_position(&self, id: u32) -> Vec3d {
        if let Some(area) = self
            .spawn_areas
            .get(id as usize % self.spawn_areas.len().max(1))
        {
            Vec3d::new(
                area.position[0] as f64,
                area.position[1] as f64 + 1.2,
                area.position[2] as f64,
            )
        } else {
            Vec3d::new((id % 8) as f64 * 1.5, 2.0, ((id / 8) % 8) as f64 * 1.5)
        }
    }

    fn player_bridge_id(id: u32) -> u32 {
        NS_PLAYER | (id & ID_MASK)
    }

    fn add_player_controller(&mut self, id: u32, position: Vec3d) -> Result<()> {
        self.world.add_capsule_player(bridge::CapsulePlayerDesc {
            entity_id: Self::player_bridge_id(id),
            user_id: id,
            position: bridge::Vec3::new(position.x as f32, position.y as f32, position.z as f32),
            cylinder_height: self.config.capsule_half_segment * 2.0,
            radius: self.config.capsule_radius,
            step_offset: self.config.max_step_height,
            contact_offset: self.config.collision_offset.max(0.01),
            slope_limit_radians: self.config.max_slope_radians,
            collision_group: GROUP_PLAYER,
            collision_mask: GROUP_STATIC | GROUP_DYNAMIC | GROUP_VEHICLE | GROUP_CHUNK,
        })?;
        Ok(())
    }

    pub fn spawn_player(&mut self, id: u32) -> Vec3d {
        let position = self.spawn_position(id);
        self.add_player_controller(id, position)
            .expect("PhysX player controller creation failed");
        self.players.insert(
            id,
            PlayerState {
                position,
                velocity: Vec3d::zeros(),
                yaw: 0.0,
                pitch: 0.0,
                last_input: InputCmd::default(),
                on_ground: false,
                hp: 100,
                dead: false,
                spawn_protected: false,
                energy: STARTING_ENERGY,
                controller_present: true,
                support_entity_id: None,
            },
        );
        position
    }

    pub fn remove_player(&mut self, id: u32) {
        if self.players.remove(&id).is_some() {
            let _ = self.world.remove_actor(Self::player_bridge_id(id));
        }
        self.exit_vehicle(id);
    }

    pub fn respawn_player(&mut self, id: u32) -> Option<[f32; 3]> {
        let position = self.spawn_position(id);
        let bridge_id = Self::player_bridge_id(id);
        if self
            .players
            .get(&id)
            .is_some_and(|state| state.controller_present)
        {
            let _ = self.world.remove_actor(bridge_id);
        }
        self.add_player_controller(id, position).ok()?;
        let state = self.players.get_mut(&id)?;
        state.position = position;
        state.velocity = Vec3d::zeros();
        state.hp = 100;
        state.dead = false;
        state.energy = STARTING_ENERGY;
        state.on_ground = false;
        state.controller_present = true;
        Some([position.x as f32, position.y as f32, position.z as f32])
    }

    pub fn simulate_player_tick(
        &mut self,
        id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<PlayerTickResult> {
        let in_vehicle = self.vehicle_of_player.get(&id).copied();
        if let Some(vehicle_id) = in_vehicle {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                vehicle.latest_input = input.clone();
            }
            if let Some(state) = self.players.get_mut(&id) {
                state.last_input = input.clone();
            }
            return Some(PlayerTickResult::default());
        }

        let state = self.players.get_mut(&id)?;
        if state.dead || !state.controller_present {
            return Some(PlayerTickResult::default());
        }
        state.yaw = input.yaw as f64;
        state.pitch = input.pitch.clamp(-1.55, 1.55) as f64;

        let wish = build_wish_dir(input, state.yaw);
        apply_horizontal_friction(
            &mut state.velocity,
            self.config.friction,
            dt as f64,
            state.on_ground,
        );
        let speed = if input.buttons & BTN_SPRINT != 0 {
            self.config.sprint_speed
        } else {
            self.config.walk_speed
        };
        accelerate(
            &mut state.velocity,
            wish,
            speed,
            if state.on_ground {
                self.config.ground_accel
            } else {
                self.config.air_accel
            },
            dt as f64,
        );
        if input.buttons & BTN_JUMP != 0 && state.on_ground && state.energy >= JUMP_ENERGY_COST {
            state.velocity.y = self.config.jump_speed;
            state.on_ground = false;
        } else if !state.on_ground {
            state.velocity.y -= self.config.gravity * dt as f64;
        } else {
            state.velocity.y = -0.5;
        }
        self.world
            .move_player(
                Self::player_bridge_id(id),
                bridge::Vec3::new(
                    (state.velocity.x * dt as f64) as f32,
                    (state.velocity.y * dt as f64) as f32,
                    (state.velocity.z * dt as f64) as f32,
                ),
            )
            .expect("PhysX CCT move failed");
        state.last_input = input.clone();
        Some(PlayerTickResult::default())
    }

    fn refresh_players(&mut self) {
        let snapshots = self
            .world
            .player_snapshots()
            .expect("PhysX player state readback failed");
        for snapshot in snapshots {
            let Some(state) = self.players.get_mut(&snapshot.user_id) else {
                continue;
            };
            state.position = Vec3d::new(
                snapshot.pose.position.x as f64,
                snapshot.pose.position.y as f64,
                snapshot.pose.position.z as f64,
            );
            state.velocity = Vec3d::new(
                snapshot.velocity.x as f64,
                snapshot.velocity.y as f64,
                snapshot.velocity.z as f64,
            );
            state.on_ground = snapshot.grounded;
            state.support_entity_id = snapshot.has_support.then_some(snapshot.support_entity_id);
        }
    }

    pub fn snapshot_player(&self, id: u32) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&id)?;
        let mut flags = 0;
        if state.on_ground {
            flags |= FLAG_ON_GROUND;
        }
        if state.dead {
            flags |= FLAG_DEAD;
        }
        if state.spawn_protected {
            flags |= FLAG_SPAWN_PROTECTED;
        }
        if self.vehicle_of_player.contains_key(&id) {
            flags |= FLAG_IN_VEHICLE;
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

    pub fn player_state(&self, id: u32) -> Option<PlayerStateSummary> {
        let state = self.players.get(&id)?;
        Some(PlayerStateSummary {
            position: state.position,
            last_input: state.last_input.clone(),
            on_ground: state.on_ground,
            hp: state.hp,
            dead: state.dead,
            energy: state.energy,
        })
    }

    pub fn player_ids(&self) -> Vec<u32> {
        self.players.keys().copied().collect()
    }

    pub fn player_support(&self, id: u32) -> Option<PlayerSupportState> {
        let player = self.players.get(&id)?;
        let bridge_entity_id = player.support_entity_id?;
        let body = self
            .current_body_snapshots()
            .into_iter()
            .find(|body| body.entity_id == bridge_entity_id)?;
        let player_position = nalgebra::Point3::new(
            player.position.x as f32,
            player.position.y as f32,
            player.position.z as f32,
        );
        let support_position = nalgebra::Point3::new(
            body.pose.position.x,
            body.pose.position.y,
            body.pose.position.z,
        );
        let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
            body.pose.rotation.w,
            body.pose.rotation.x,
            body.pose.rotation.y,
            body.pose.rotation.z,
        ));
        let support_to_player = player_position - support_position;
        let local = rotation.inverse_transform_vector(&support_to_player);
        let angular_velocity = Vector3::new(
            body.angular_velocity.x,
            body.angular_velocity.y,
            body.angular_velocity.z,
        );
        let point_velocity = Vector3::new(
            body.linear_velocity.x,
            body.linear_velocity.y,
            body.linear_velocity.z,
        ) + angular_velocity.cross(&support_to_player);
        let is_vehicle = bridge_entity_id & 0xf000_0000 == NS_VEHICLE;
        Some(PlayerSupportState {
            entity_id: body.user_id,
            is_vehicle,
            local_position: local.into(),
            velocity: point_velocity.into(),
            angular_velocity: angular_velocity.into(),
            flags: u8::from(body.sleeping),
        })
    }

    pub fn add_player_energy(&mut self, id: u32, delta: f32) -> Option<f32> {
        let state = self.players.get_mut(&id)?;
        state.energy = (state.energy + delta).max(0.0);
        Some(state.energy)
    }

    pub fn player_energy(&self, id: u32) -> Option<f32> {
        self.players.get(&id).map(|state| state.energy)
    }

    pub fn set_player_dead(&mut self, id: u32, dead: bool) {
        let Some(state) = self.players.get_mut(&id) else {
            return;
        };
        state.dead = dead;
        if dead && state.controller_present {
            let _ = self.world.remove_actor(Self::player_bridge_id(id));
            state.controller_present = false;
        }
    }

    pub fn set_player_spawn_protected(&mut self, id: u32, value: bool) -> bool {
        let Some(state) = self.players.get_mut(&id) else {
            return false;
        };
        state.spawn_protected = value;
        true
    }

    pub fn apply_player_damage(&mut self, id: u32, damage: u8) -> PlayerDamageOutcome {
        let Some(state) = self.players.get_mut(&id) else {
            return PlayerDamageOutcome::Ignored;
        };
        if state.dead || state.spawn_protected {
            return PlayerDamageOutcome::Ignored;
        }
        state.hp = state.hp.saturating_sub(damage);
        if state.hp == 0 {
            PlayerDamageOutcome::Killed
        } else {
            PlayerDamageOutcome::Damaged
        }
    }

    pub fn is_player_in_vehicle(&self, id: u32) -> bool {
        self.vehicle_of_player.contains_key(&id)
    }

    pub fn player_vehicle_id(&self, id: u32) -> Option<u32> {
        self.vehicle_of_player.get(&id).copied()
    }

    pub fn vehicle_exists(&self, id: u32) -> bool {
        self.vehicles.contains_key(&id)
    }

    pub fn enter_vehicle(&mut self, player_id: u32, vehicle_id: u32) {
        let Some(player) = self.players.get(&player_id) else {
            return;
        };
        let Some(vehicle) = self.vehicles.get(&vehicle_id) else {
            return;
        };
        if vehicle.driver_id != 0 && vehicle.driver_id != player_id {
            return;
        }
        if self.vehicle_of_player.get(&player_id) == Some(&vehicle_id) {
            return;
        }
        let Some(vehicle_snapshot) = self
            .current_vehicle_snapshots()
            .into_iter()
            .find(|state| state.user_id == vehicle_id)
        else {
            return;
        };
        let dx = player.position.x as f32 - vehicle_snapshot.pose.position.x;
        let dy = player.position.y as f32 - vehicle_snapshot.pose.position.y;
        let dz = player.position.z as f32 - vehicle_snapshot.pose.position.z;
        if dx * dx + dy * dy + dz * dz > VEHICLE_INTERACT_RADIUS_M * VEHICLE_INTERACT_RADIUS_M {
            return;
        }

        self.exit_vehicle(player_id);
        if let Some(state) = self.players.get_mut(&player_id) {
            if state.controller_present {
                self.world
                    .remove_actor(Self::player_bridge_id(player_id))
                    .expect("failed to remove seated player's PhysX controller");
                state.controller_present = false;
            }
            state.position = Vec3d::new(
                vehicle_snapshot.pose.position.x as f64,
                vehicle_snapshot.pose.position.y as f64,
                vehicle_snapshot.pose.position.z as f64,
            );
            state.velocity = Vec3d::new(
                vehicle_snapshot.linear_velocity.x as f64,
                vehicle_snapshot.linear_velocity.y as f64,
                vehicle_snapshot.linear_velocity.z as f64,
            );
            state.on_ground = false;
            state.support_entity_id = None;
        }
        self.vehicle_of_player.insert(player_id, vehicle_id);
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = player_id;
        }
    }

    pub fn exit_vehicle(&mut self, player_id: u32) {
        let Some(vehicle_id) = self.vehicle_of_player.remove(&player_id) else {
            return;
        };
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            if vehicle.driver_id == player_id {
                vehicle.driver_id = 0;
            }
        }
        let Some(player) = self.players.get(&player_id) else {
            return;
        };
        if player.dead || player.controller_present {
            return;
        }
        let Some(vehicle_snapshot) = self
            .current_vehicle_snapshots()
            .into_iter()
            .find(|state| state.user_id == vehicle_id)
        else {
            return;
        };
        let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
            vehicle_snapshot.pose.rotation.w,
            vehicle_snapshot.pose.rotation.x,
            vehicle_snapshot.pose.rotation.y,
            vehicle_snapshot.pose.rotation.z,
        ));
        let side = rotation.transform_vector(&Vector3::new(1.8, 0.0, 0.0));
        let exit_position = Vec3d::new(
            (vehicle_snapshot.pose.position.x + side.x) as f64,
            (vehicle_snapshot.pose.position.y + 0.5) as f64,
            (vehicle_snapshot.pose.position.z + side.z) as f64,
        );
        self.add_player_controller(player_id, exit_position)
            .expect("failed to restore exited player's PhysX controller");
        if let Some(state) = self.players.get_mut(&player_id) {
            state.position = exit_position;
            state.velocity = Vec3d::new(
                vehicle_snapshot.linear_velocity.x as f64,
                vehicle_snapshot.linear_velocity.y as f64,
                vehicle_snapshot.linear_velocity.z as f64,
            );
            state.controller_present = true;
            state.on_ground = false;
            state.support_entity_id = None;
        }
    }

    pub fn step_vehicles_and_dynamics(&mut self, _dt: f32) -> (f32, f32) {
        let vehicles_started = std::time::Instant::now();
        for (&id, vehicle) in &self.vehicles {
            if vehicle.driver_id == 0 {
                continue;
            }
            let throttle = vehicle.latest_input.move_y as f32 / 127.0;
            let steer = vehicle.latest_input.move_x as f32 / 127.0;
            let brake = if throttle.abs() < 0.01 { 0.2 } else { 0.0 };
            self.world
                .drive_vehicle(NS_VEHICLE | (id & ID_MASK), throttle, steer, brake)
                .expect("PhysX vehicle control failed");
        }
        self.last_vehicle_control_ms =
            vehicles_started.elapsed().as_secs_f32() * 1000.0;
        let started = std::time::Instant::now();
        self.world.step().expect("PhysX GPU simulation step failed");
        // `dynamics_ms` used to be ONE bracket around the step and everything
        // below it, so three separate FFI readbacks and the player refresh were
        // folded into a number labelled as the simulation step. Only the step
        // is `physics_last_step_ms`; the difference was unattributed.
        let after_step = std::time::Instant::now();
        self.contact_events = self
            .world
            .take_contact_events()
            .expect("PhysX contact event readback failed");
        self.cached_body_snapshots = self
            .world
            .body_snapshots()
            .expect("PhysX body readback failed");
        self.cached_vehicle_snapshots = self
            .world
            .vehicle_snapshots()
            .expect("PhysX vehicle readback failed");
        let after_readback = std::time::Instant::now();
        self.last_readback_ms =
            after_readback.duration_since(after_step).as_secs_f32() * 1000.0;
        for body in &self.cached_body_snapshots {
            if body.entity_id & 0xf000_0000 != NS_BATTERY {
                continue;
            }
            if let Some(battery) = self.batteries.get_mut(&body.user_id) {
                battery.position = [
                    body.pose.position.x,
                    body.pose.position.y,
                    body.pose.position.z,
                ];
            }
        }
        self.snapshots_valid = true;
        let before_players = std::time::Instant::now();
        self.refresh_players();
        self.last_refresh_players_ms =
            before_players.elapsed().as_secs_f32() * 1000.0;
        let ms = started.elapsed().as_secs_f32() * 1000.0;
        // Returned as (vehicle_ms, dynamics_ms). The first was hardcoded 0.0
        // and published as `vehicle_ms`, so the panel showed a real-looking
        // zero for a cost nobody had measured. It is now the actual vehicle
        // control cost, measured above the step.
        (self.last_vehicle_control_ms, ms)
    }

    pub fn apply_vehicle_player_collisions(&mut self) -> Vec<u32> {
        const PLAYER_IMPACT_MASS_KG: f32 = 80.0;
        let minimum_impulse = VEHICLE_DAMAGE_MIN_SPEED_M_S * PLAYER_IMPACT_MASS_KG;
        let lethal_impulse = VEHICLE_LETHAL_SPEED_M_S * PLAYER_IMPACT_MASS_KG;
        let mut damage_by_player: HashMap<u32, u8> = HashMap::new();

        for event in &self.contact_events {
            let (vehicle_entity, player_entity) = if event.entity_a & 0xf000_0000 == NS_VEHICLE
                && event.entity_b & 0xf000_0000 == NS_PLAYER
            {
                (event.entity_a, event.entity_b)
            } else if event.entity_b & 0xf000_0000 == NS_VEHICLE
                && event.entity_a & 0xf000_0000 == NS_PLAYER
            {
                (event.entity_b, event.entity_a)
            } else {
                continue;
            };
            let vehicle_id = vehicle_entity & ID_MASK;
            let player_id = player_entity & ID_MASK;
            if self.vehicle_of_player.contains_key(&player_id)
                || self
                    .vehicles
                    .get(&vehicle_id)
                    .is_some_and(|vehicle| vehicle.driver_id == player_id)
                || self
                    .players
                    .get(&player_id)
                    .is_none_or(|player| player.dead || player.hp == 0)
            {
                continue;
            }
            let impulse = (event.impulse.x * event.impulse.x
                + event.impulse.y * event.impulse.y
                + event.impulse.z * event.impulse.z)
                .sqrt();
            if impulse < minimum_impulse {
                continue;
            }
            let damage = ((impulse / lethal_impulse).clamp(0.0, 1.0) * 100.0)
                .round()
                .clamp(1.0, 100.0) as u8;
            damage_by_player
                .entry(player_id)
                .and_modify(|existing| *existing = (*existing).max(damage))
                .or_insert(damage);
        }

        let mut killed = Vec::new();
        for (player_id, damage) in damage_by_player {
            if matches!(
                self.apply_player_damage(player_id, damage),
                PlayerDamageOutcome::Killed
            ) {
                killed.push(player_id);
            }
        }
        killed
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        self.current_body_snapshots()
            .into_iter()
            .filter_map(|body| {
                let id = body.user_id;
                let meta = self.dynamic.get(&id)?;
                Some((
                    id,
                    [
                        body.pose.position.x,
                        body.pose.position.y,
                        body.pose.position.z,
                    ],
                    [
                        body.pose.rotation.x,
                        body.pose.rotation.y,
                        body.pose.rotation.z,
                        body.pose.rotation.w,
                    ],
                    meta.half_extents,
                    [
                        body.linear_velocity.x,
                        body.linear_velocity.y,
                        body.linear_velocity.z,
                    ],
                    [
                        body.angular_velocity.x,
                        body.angular_velocity.y,
                        body.angular_velocity.z,
                    ],
                    meta.shape_type,
                ))
            })
            .collect()
    }

    pub fn snapshot_vehicles(&self) -> Vec<NetVehicleState> {
        self.current_vehicle_snapshots()
            .into_iter()
            .filter_map(|snapshot| {
                let meta = self.vehicles.get(&snapshot.user_id)?;
                Some(make_net_vehicle_state(
                    snapshot.user_id,
                    meta.vehicle_type,
                    0,
                    meta.driver_id,
                    [
                        snapshot.pose.position.x,
                        snapshot.pose.position.y,
                        snapshot.pose.position.z,
                    ],
                    [
                        snapshot.pose.rotation.x,
                        snapshot.pose.rotation.y,
                        snapshot.pose.rotation.z,
                        snapshot.pose.rotation.w,
                    ],
                    [
                        snapshot.linear_velocity.x,
                        snapshot.linear_velocity.y,
                        snapshot.linear_velocity.z,
                    ],
                    [
                        snapshot.angular_velocity.x,
                        snapshot.angular_velocity.y,
                        snapshot.angular_velocity.z,
                    ],
                    [0; 4],
                ))
            })
            .collect()
    }

    pub fn cast_static_world_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        _exclude_player: Option<u32>,
    ) -> Option<f32> {
        let hit = self
            .world
            .raycast(bridge::RaycastRequest {
                origin: array_vec3(origin),
                direction: array_vec3(direction),
                max_distance,
                collision_mask: GROUP_STATIC,
                ignore_entity_id: 0,
                has_ignore_entity: false,
            })
            .ok()?;
        hit.hit.then_some(hit.distance)
    }

    pub fn cast_dynamic_body_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        _exclude_player: Option<u32>,
    ) -> Option<(u32, f32, [f32; 3])> {
        let hit = self
            .world
            .raycast(bridge::RaycastRequest {
                origin: array_vec3(origin),
                direction: array_vec3(direction),
                max_distance,
                collision_mask: GROUP_DYNAMIC,
                ignore_entity_id: 0,
                has_ignore_entity: false,
            })
            .ok()?;
        hit.hit.then_some((
            hit.user_id,
            hit.distance,
            [hit.normal.x, hit.normal.y, hit.normal.z],
        ))
    }

    pub fn apply_dynamic_body_impulse(
        &mut self,
        id: u32,
        impulse: [f32; 3],
        point: [f32; 3],
    ) -> bool {
        self.world
            .apply_impulse_at_point(
                NS_DYNAMIC | (id & ID_MASK),
                array_vec3(impulse),
                array_vec3(point),
            )
            .is_ok()
    }

    pub fn add_runtime_static_cuboid(
        &mut self,
        token: u64,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    ) {
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        let entity = NS_STATIC | (logical & ID_MASK);
        self.world
            .add_static_box(bridge::StaticBoxDesc {
                entity_id: entity,
                user_id: logical,
                pose: pose(center, [0.0, 0.0, 0.0, 1.0]),
                half_extents: vec3(half_extents),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX runtime static creation failed");
        self.runtime_static.insert(token, (entity, user_data));
    }

    pub fn remove_runtime_collider(&mut self, token: u64) {
        if let Some((entity, _)) = self.runtime_static.remove(&token) {
            let _ = self.world.remove_actor(entity);
        }
    }

    pub fn runtime_collider_user_data(&self, token: u64) -> Option<u128> {
        self.runtime_static
            .get(&token)
            .map(|(_, user_data)| *user_data)
    }

    pub fn wake_bodies_near(&mut self, center: Vector3<f32>, radius: f32) {
        self.world
            .wake_bodies_near(vec3(center), radius)
            .expect("PhysX wake query failed");
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vector3<f32>, radius: f32) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
        self.spawn_dynamic_ball_with_id(id, position, radius);
        id
    }

    pub fn spawn_battery(&mut self, position: Vec3d, energy: f32, radius: f32, height: f32) -> u32 {
        let id = self.next_battery_id;
        self.next_battery_id = self.next_battery_id.saturating_add(1);
        self.spawn_battery_with_id(
            id,
            Vector3::new(position.x as f32, position.y as f32, position.z as f32),
            energy,
            radius,
            height,
        );
        id
    }

    pub fn collect_batteries_for_player(&mut self, player_id: u32) -> Vec<(u32, f32)> {
        let Some(player) = self.players.get(&player_id) else {
            return Vec::new();
        };
        let collected: Vec<u32> = self
            .batteries
            .iter()
            .filter_map(|(&id, battery)| {
                let dx = battery.position[0] - player.position.x as f32;
                let dy = battery.position[1] - player.position.y as f32;
                let dz = battery.position[2] - player.position.z as f32;
                (dx * dx + dy * dy + dz * dz <= 1.5 * 1.5).then_some(id)
            })
            .collect();
        collected
            .into_iter()
            .filter_map(|id| {
                let battery = self.batteries.remove(&id)?;
                let _ = self.world.remove_actor(NS_BATTERY | (id & ID_MASK));
                Some((id, battery.energy))
            })
            .collect()
    }

    pub fn snapshot_batteries(&self) -> Vec<(u32, [f32; 3], f32, f32, f32)> {
        self.batteries
            .iter()
            .map(|(&id, battery)| {
                (
                    id,
                    battery.position,
                    battery.energy,
                    battery.radius,
                    battery.height,
                )
            })
            .collect()
    }

    pub fn apply_on_foot_energy_drain(
        &mut self,
        id: u32,
        previous_input: &InputCmd,
        input: &InputCmd,
        was_on_ground: bool,
        dt: f32,
    ) -> bool {
        let Some(state) = self.players.get_mut(&id) else {
            return false;
        };
        if state.dead || self.vehicle_of_player.contains_key(&id) {
            return false;
        }
        let moving = input.move_x != 0 || input.move_y != 0;
        let rate = if moving && input.buttons & BTN_SPRINT != 0 {
            ON_FOOT_SPRINT_DRAIN_PER_SEC
        } else if moving {
            ON_FOOT_WALK_DRAIN_PER_SEC
        } else {
            ON_FOOT_IDLE_DRAIN_PER_SEC
        };
        let jump_started = was_on_ground
            && input.buttons & BTN_JUMP != 0
            && previous_input.buttons & BTN_JUMP == 0;
        state.energy =
            (state.energy - rate * dt - if jump_started { JUMP_ENERGY_COST } else { 0.0 }).max(0.0);
        state.energy <= 0.0
    }

    pub fn apply_vehicle_energy_drain(&mut self, dt: f32) -> Vec<u32> {
        let mut depleted = Vec::new();
        for &player_id in self.vehicle_of_player.keys() {
            if let Some(player) = self.players.get_mut(&player_id) {
                player.energy = (player.energy - ON_FOOT_IDLE_DRAIN_PER_SEC * dt).max(0.0);
                if player.energy <= 0.0 {
                    depleted.push(player_id);
                }
            }
        }
        depleted
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.dynamic.len(),
            self.vehicles.len(),
            self.batteries.len(),
        )
    }

    /// Generic named spans stashed by the most recent stats read inside
    /// [`Self::health`]; call AFTER health() for spans of the same read.
    pub fn take_physics_spans(&self) -> Vec<vibe_land_physx_bridge::NamedSpan> {
        self.world.take_world_spans()
    }

    pub fn health(&self) -> PhysicsHealth {
        let stats = self.world.stats().expect("PhysX stats readback failed");
        PhysicsHealth {
            gpu_active: true,
            gpu_warning_count: stats.gpu_warning_count,
            contact_pairs: stats.contact_pairs,
            active_dynamic_bodies: stats.active_dynamic_bodies,
            last_step_ms: stats.last_step_ms,
            last_controller_ms: stats.last_controller_ms,
            last_simulate_ms: stats.last_simulate_ms,
            last_fetch_ms: stats.last_fetch_ms,
            last_gpu_wait_ms: stats.last_gpu_wait_ms,
            last_fetch_copy_ms: stats.last_fetch_copy_ms,
            last_readback_ms: self.last_readback_ms,
            last_refresh_players_ms: self.last_refresh_players_ms,
            last_vehicle_control_ms: self.last_vehicle_control_ms,
            // Computed in C++ and carried all the way to WorldStats, then
            // dropped here: health() copied 9 of 16 fields. These two are the
            // only warning that a GPU buffer is about to overrun, which is the
            // failure mode a no-caps simulation actually has.
            gpu_rigid_contact_high_water: stats.gpu_rigid_contact_high_water,
            gpu_rigid_patch_high_water: stats.gpu_rigid_patch_high_water,
            gpu_max_rigid_contacts: self.gpu_max_rigid_contacts,
            gpu_max_rigid_patches: self.gpu_max_rigid_patches,
        }
    }

    pub fn awake_dynamic_body_counts(
        &self,
        player_centers: &[[f32; 3]],
        near_radius: f32,
    ) -> (u32, u32) {
        let near_radius_sq = near_radius * near_radius;
        let snapshots = self.current_body_snapshots();
        let mut total = 0;
        let mut near = 0;
        for body in snapshots {
            if body.sleeping || !self.dynamic.contains_key(&body.user_id) {
                continue;
            }
            total += 1;
            if player_centers.iter().any(|center| {
                let dx = body.pose.position.x - center[0];
                let dy = body.pose.position.y - center[1];
                let dz = body.pose.position.z - center[2];
                dx * dx + dy * dy + dz * dz <= near_radius_sq
            }) {
                near += 1;
            }
        }
        (total, near)
    }
}

impl WorldDocumentArena for PhysxPhysicsArena {
    fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        _user_data: u128,
        material: EffectiveTerrainMaterial,
    ) {
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        let world_rows = heights.nrows();
        let world_columns = heights.ncols();
        assert!(
            world_rows >= 2 && world_columns >= 2,
            "PhysX heightfields require at least 2x2 samples"
        );
        // World documents store row-major samples as [z][x]. PhysX heightfields
        // index rows on +X and columns on +Z, and their actor pose is the minimum
        // X/Z corner rather than the center used by the shared world contract.
        let mut physx_samples = Vec::with_capacity(world_rows * world_columns);
        for x in 0..world_columns {
            for z in 0..world_rows {
                physx_samples.push(heights[(z, x)]);
            }
        }
        let corner = Vector3::new(center.x - scale.x * 0.5, center.y, center.z - scale.z * 0.5);
        self.world
            .add_heightfield(
                bridge::HeightfieldDesc {
                    entity_id: NS_STATIC | (logical & ID_MASK),
                    user_id: logical,
                    pose: pose(corner, [0.0, 0.0, 0.0, 1.0]),
                    rows: world_columns as u32,
                    columns: world_rows as u32,
                    height_scale: 0.01,
                    row_scale: scale.x / (world_columns - 1) as f32,
                    column_scale: scale.z / (world_rows - 1) as f32,
                    friction: material.friction,
                    restitution: material.restitution,
                    collision_group: GROUP_STATIC,
                    collision_mask: ALL_GROUPS,
                },
                &physx_samples,
            )
            .expect("PhysX heightfield creation failed");
    }

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
        _user_data: u128,
    ) {
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        self.world
            .add_static_box(bridge::StaticBoxDesc {
                entity_id: NS_STATIC | (logical & ID_MASK),
                user_id: logical,
                pose: pose(center, rotation),
                half_extents: vec3(half_extents),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX static box creation failed");
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    ) {
        self.next_dynamic_id = self.next_dynamic_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_box(bridge::DynamicBoxDesc {
                entity_id: NS_DYNAMIC | (id & ID_MASK),
                user_id: id,
                pose: pose(position, rotation),
                half_extents: vec3(half_extents),
                mass: (half_extents.x * half_extents.y * half_extents.z * 8.0).max(1.0),
                collision_group: GROUP_DYNAMIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX dynamic box creation failed");
        self.snapshots_valid = false;
        self.dynamic.insert(
            id,
            DynamicMeta {
                half_extents: half_extents.into(),
                shape_type: SHAPE_BOX,
            },
        );
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        self.next_dynamic_id = self.next_dynamic_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_sphere(bridge::DynamicSphereDesc {
                entity_id: NS_DYNAMIC | (id & ID_MASK),
                user_id: id,
                pose: pose(position, [0.0, 0.0, 0.0, 1.0]),
                radius,
                mass: (4.0 / 3.0 * std::f32::consts::PI * radius.powi(3)).max(0.1),
                collision_group: GROUP_DYNAMIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX dynamic sphere creation failed");
        self.snapshots_valid = false;
        self.dynamic.insert(
            id,
            DynamicMeta {
                half_extents: [radius; 3],
                shape_type: SHAPE_SPHERE,
            },
        );
    }

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vector3<f32>,
        rotation: [f32; 4],
    ) {
        self.world
            .add_vehicle_chassis(bridge::VehicleChassisDesc {
                entity_id: NS_VEHICLE | (id & ID_MASK),
                user_id: id,
                pose: pose(position, rotation),
                half_extents: bridge::Vec3::new(1.0, 0.45, 2.0),
                mass: 1200.0,
                collision_group: GROUP_VEHICLE,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX vehicle creation failed");
        self.snapshots_valid = false;
        self.vehicles.insert(
            id,
            VehicleMeta {
                vehicle_type,
                driver_id: 0,
                latest_input: InputCmd::default(),
            },
        );
    }

    fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        self.next_battery_id = self.next_battery_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_sphere(bridge::DynamicSphereDesc {
                entity_id: NS_BATTERY | (id & ID_MASK),
                user_id: id,
                pose: pose(position, [0.0, 0.0, 0.0, 1.0]),
                radius: radius.max(height * 0.5),
                mass: 0.25,
                collision_group: GROUP_BATTERY,
                collision_mask: GROUP_STATIC,
            })
            .expect("PhysX battery creation failed");
        self.snapshots_valid = false;
        self.batteries.insert(
            id,
            BatteryState {
                position: position.into(),
                energy,
                radius,
                height,
            },
        );
    }

    fn rebuild_broad_phase(&mut self) {}

    fn set_material_field(&mut self, field: Option<TerrainMaterialField>) {
        self.material_field = field;
    }
}

fn vec3(value: Vector3<f32>) -> bridge::Vec3 {
    bridge::Vec3::new(value.x, value.y, value.z)
}

fn pose(position: Vector3<f32>, rotation: [f32; 4]) -> bridge::Pose {
    bridge::Pose {
        position: vec3(position),
        rotation: bridge::Quat {
            x: rotation[0],
            y: rotation[1],
            z: rotation[2],
            w: rotation[3],
        },
    }
}

fn array_vec3(value: [f32; 3]) -> bridge::Vec3 {
    bridge::Vec3::new(value[0], value[1], value[2])
}

fn env_u32(name: &str, default: u32) -> Result<u32> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use super::*;

    fn gpu_test_guard() -> MutexGuard<'static, ()> {
        static GPU_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        GPU_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn gpu_world_drives_authoritative_player_and_body_state() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::add_static_cuboid(
            &mut arena,
            Vector3::new(0.0, -0.5, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(20.0, 0.5, 20.0),
            1,
        );
        WorldDocumentArena::spawn_dynamic_ball_with_id(
            &mut arena,
            7,
            Vector3::new(0.0, 4.0, 0.0),
            0.5,
        );
        arena.spawn_player(42);

        for seq in 0..120 {
            let input = InputCmd {
                seq,
                move_y: 127,
                ..InputCmd::default()
            };
            arena.simulate_player_tick(42, &input, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let player = arena.snapshot_player(42).unwrap();
        assert!(player.0[1] > 0.4);
        assert!(player.0[2] > 1.0);
        assert_eq!(arena.snapshot_dynamic_bodies()[0].0, 7);
        assert!(arena.world.stats().unwrap().completed_steps >= 120);
    }

    #[test]
    fn heightfield_adapter_preserves_world_xz_layout_and_spacing() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        let heights = DMatrix::from_row_slice(
            3,
            4,
            &[
                0.0, 1.0, 2.0, 3.0, //
                10.0, 11.0, 12.0, 13.0, //
                20.0, 21.0, 22.0, 23.0,
            ],
        );
        WorldDocumentArena::add_static_heightfield(
            &mut arena,
            Vector3::new(10.0, 0.0, 20.0),
            heights,
            Vector3::new(6.0, 1.0, 4.0),
            1,
            EffectiveTerrainMaterial::DEFAULT,
        );

        let hit_at_11 = arena
            .cast_static_world_ray([9.0, 100.0, 20.0], [0.0, -1.0, 0.0], 200.0, None)
            .expect("first asymmetric terrain sample should be raycastable");
        let hit_at_12 = arena
            .cast_static_world_ray([11.0, 100.0, 20.0], [0.0, -1.0, 0.0], 200.0, None)
            .expect("second asymmetric terrain sample should be raycastable");

        assert!((100.0 - hit_at_11 - 11.0).abs() < 0.02);
        assert!((100.0 - hit_at_12 - 12.0).abs() < 0.02);
    }

    #[test]
    fn dynamic_metadata_uses_shared_wire_shape_constants() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::spawn_dynamic_box_with_id(
            &mut arena,
            1,
            Vector3::new(0.0, 2.0, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(0.5, 0.5, 0.5),
        );
        WorldDocumentArena::spawn_dynamic_ball_with_id(
            &mut arena,
            2,
            Vector3::new(2.0, 2.0, 0.0),
            0.5,
        );

        assert_eq!(arena.dynamic[&1].shape_type, SHAPE_BOX);
        assert_eq!(arena.dynamic[&2].shape_type, SHAPE_SPHERE);
    }

    #[test]
    fn vehicle_entry_requires_proximity_and_preserves_single_driver_lifecycle() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        let player_position = arena.spawn_player(10);
        WorldDocumentArena::spawn_vehicle_with_id(
            &mut arena,
            7,
            0,
            Vector3::new(
                player_position.x as f32,
                player_position.y as f32,
                player_position.z as f32,
            ),
            [0.0, 0.0, 0.0, 1.0],
        );
        arena.spawn_player(11);
        arena.players.get_mut(&11).unwrap().position = Vec3d::new(100.0, 2.0, 100.0);

        arena.enter_vehicle(10, 7);
        assert_eq!(arena.player_vehicle_id(10), Some(7));
        assert!(!arena.players[&10].controller_present);

        arena.enter_vehicle(11, 7);
        assert_eq!(arena.player_vehicle_id(11), None);
        assert_eq!(arena.vehicles[&7].driver_id, 10);

        arena.exit_vehicle(10);
        assert_eq!(arena.player_vehicle_id(10), None);
        assert!(arena.players[&10].controller_present);
        assert_eq!(arena.vehicles[&7].driver_id, 0);
    }
}
