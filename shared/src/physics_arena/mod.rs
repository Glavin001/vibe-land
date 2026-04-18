use std::collections::HashMap;

use nalgebra::{Point3, Vector3};
use rapier3d::control::DynamicRayCastVehicleController;
use rapier3d::prelude::*;

use crate::movement::Vec3d;
pub use crate::movement::{vehicle_wheel_params, MoveConfig, VEHICLE_MAX_STEER_RAD};
use crate::protocol::*;
pub use crate::simulation::{simulate_player_tick, PlayerTickResult};
pub use vibe_netcode::physics_arena::DynamicArena;
use crate::world_document::SpawnArea;

mod player;
mod spawn;
mod vehicle;

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
}

/// Shared authoritative physics world: wraps `DynamicArena` and adds
/// vibe-land-specific player and vehicle state management.
pub struct PhysicsArena {
    pub dynamic: DynamicArena,
    pub players: HashMap<u32, PlayerMotorState>,
    next_spawn_index: u32,
    pub vehicles: HashMap<u32, Vehicle>,
    next_vehicle_id: u32,
    pub vehicle_of_player: HashMap<u32, u32>,
    pub spawn_areas: Vec<SpawnArea>,
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
            spawn_areas: Vec::new(),
        }
    }

    pub fn set_spawn_areas(&mut self, areas: Vec<SpawnArea>) {
        self.spawn_areas = areas;
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

    pub fn step_dynamics(&mut self, dt: f32) {
        self.dynamic.step_dynamics(dt);
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        self.dynamic.snapshot_dynamic_bodies()
    }
}
