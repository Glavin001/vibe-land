use std::collections::HashMap;

use anyhow::Result;
use nalgebra::{DMatrix, Vector3};
use rapier3d::prelude::ColliderHandle;
use vibe_land_shared::{
    physics_arena::{PhysicsArena as RapierPhysicsArena, PlayerTickResult},
    protocol::{InputCmd, NetVehicleState},
    world_document::{
        EffectiveTerrainMaterial, SpawnArea, TerrainMaterialField, WorldDocumentArena,
    },
};
use vibe_netcode::{movement::Vec3d, physics_backend::PhysicsBackendKind};

#[cfg(feature = "physx-gpu")]
use crate::physx_runtime::PhysxPhysicsArena;

pub type Vec3 = Vector3<f32>;
pub use vibe_land_shared::physics_arena::{MoveConfig, PlayerDamageOutcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PhysicsColliderHandle(u64);

#[derive(Clone, Debug, Default)]
pub struct PlayerStateSummary {
    pub position: Vec3d,
    pub last_input: InputCmd,
    pub on_ground: bool,
    pub hp: u8,
    pub dead: bool,
    pub energy: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlayerSupportState {
    pub entity_id: u32,
    pub is_vehicle: bool,
    pub local_position: [f32; 3],
    pub velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub flags: u8,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PhysicsHealth {
    pub gpu_active: bool,
    pub gpu_warning_count: u32,
    pub contact_pairs: u32,
    pub active_dynamic_bodies: u32,
    pub last_step_ms: f32,
    /// Step phases. `simulate` only dispatches under GPU dynamics, so `fetch`
    /// carries GPU compute plus the result readback.
    pub last_controller_ms: f32,
    pub last_simulate_ms: f32,
    pub last_fetch_ms: f32,
    /// The split inside `fetch`: time blocked waiting on the GPU versus the
    /// call that copies results back. Only populated under
    /// `VIBE_PHYSX_PROFILE_FETCH=1` (it polls, which burns a core), and it is
    /// the number that says whether overlapping CPU work with the simulate
    /// window would buy anything.
    pub last_gpu_wait_ms: f32,
    pub last_fetch_copy_ms: f32,
    /// The rest of what `dynamics_ms` brackets, which is NOT the step:
    /// the three FFI readbacks after it, the player refresh, and the vehicle
    /// control loop before it. `dynamics_ms - last_step_ms` used to be a real
    /// cost with no name attached to it.
    pub last_readback_ms: f32,
    pub last_refresh_players_ms: f32,
    pub last_vehicle_control_ms: f32,
    /// PhysX's own high-water marks for the two GPU buffers that have a fixed
    /// capacity, with those capacities beside them. Exceeding one degrades
    /// hard, and nothing was reporting them.
    pub gpu_rigid_contact_high_water: u32,
    pub gpu_rigid_patch_high_water: u32,
    pub gpu_max_rigid_contacts: u32,
    pub gpu_max_rigid_patches: u32,
}

enum PhysicsBackend {
    Rapier(RapierPhysicsArena),
    #[cfg(feature = "physx-gpu")]
    Physx(PhysxPhysicsArena),
}

/// Server-owned physics facade. Engine-specific handles never leave this type.
pub struct PhysicsArena {
    backend: PhysicsBackend,
    next_collider_token: u64,
    rapier_colliders: HashMap<PhysicsColliderHandle, ColliderHandle>,
}

impl PhysicsArena {
    pub fn new(config: MoveConfig, backend: PhysicsBackendKind) -> Result<Self> {
        let backend = match backend {
            PhysicsBackendKind::Rapier => PhysicsBackend::Rapier(RapierPhysicsArena::new(config)),
            PhysicsBackendKind::PhysxGpu => {
                #[cfg(feature = "physx-gpu")]
                {
                    PhysicsBackend::Physx(PhysxPhysicsArena::new(config)?)
                }
                #[cfg(not(feature = "physx-gpu"))]
                {
                    anyhow::bail!("PhysX GPU backend was not compiled into this server")
                }
            }
        };
        Ok(Self {
            backend,
            next_collider_token: 1,
            rapier_colliders: HashMap::new(),
        })
    }

    #[cfg(test)]
    pub fn new_rapier(config: MoveConfig) -> Self {
        Self::new(config, PhysicsBackendKind::Rapier).expect("Rapier backend is available")
    }

    pub fn config(&self) -> &MoveConfig {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.config(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.config(),
        }
    }

    #[cfg(feature = "destruction")]
    pub fn physx_world_mut(&mut self) -> Option<&mut vibe_land_physx_bridge::World> {
        match &mut self.backend {
            PhysicsBackend::Rapier(_) => None,
            PhysicsBackend::Physx(arena) => Some(arena.world_mut()),
        }
    }

    pub fn set_spawn_areas(&mut self, areas: Vec<SpawnArea>) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.set_spawn_areas(areas),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.set_spawn_areas(areas),
        }
    }

    #[cfg(test)]
    pub fn spawn_areas(&self) -> &[SpawnArea] {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => &arena.spawn_areas,
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.spawn_areas(),
        }
    }

    pub fn add_static_cuboid(
        &mut self,
        center: Vec3,
        half_extents: Vec3,
        user_data: u128,
    ) -> PhysicsColliderHandle {
        let token = PhysicsColliderHandle(self.next_collider_token);
        self.next_collider_token = self.next_collider_token.saturating_add(1);
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => {
                let native = arena.add_static_cuboid(center, half_extents, user_data);
                self.rapier_colliders.insert(token, native);
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                arena.add_runtime_static_cuboid(token.0, center, half_extents, user_data)
            }
        }
        token
    }

    pub fn remove_collider(&mut self, handle: PhysicsColliderHandle) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => {
                if let Some(native) = self.rapier_colliders.remove(&handle) {
                    arena.remove_collider(native);
                }
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.remove_runtime_collider(handle.0),
        }
    }

    pub fn collider_user_data(&self, handle: PhysicsColliderHandle) -> Option<u128> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => self
                .rapier_colliders
                .get(&handle)
                .and_then(|native| arena.collider_user_data(*native)),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.runtime_collider_user_data(handle.0),
        }
    }

    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.wake_bodies_near(center, radius),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.wake_bodies_near(center, radius),
        }
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vec3, radius: f32) -> u32 {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.spawn_dynamic_ball(position, radius),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.spawn_dynamic_ball(position, radius),
        }
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.spawn_player(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.spawn_player(player_id),
        }
    }

    pub fn remove_player(&mut self, player_id: u32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.remove_player(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.remove_player(player_id),
        }
    }

    pub fn respawn_player(&mut self, player_id: u32) -> Option<[f32; 3]> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.respawn_player(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.respawn_player(player_id),
        }
    }

    pub fn simulate_player_tick(
        &mut self,
        player_id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<PlayerTickResult> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.simulate_player_tick(player_id, input, dt),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.simulate_player_tick(player_id, input, dt),
        }
    }

    pub fn snapshot_player(
        &self,
        player_id: u32,
    ) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.snapshot_player(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.snapshot_player(player_id),
        }
    }

    pub fn player_state(&self, player_id: u32) -> Option<PlayerStateSummary> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => {
                arena
                    .players
                    .get(&player_id)
                    .map(|state| PlayerStateSummary {
                        position: state.position,
                        last_input: state.last_input.clone(),
                        on_ground: state.on_ground,
                        hp: state.hp,
                        dead: state.dead,
                        energy: state.energy,
                    })
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.player_state(player_id),
        }
    }

    pub fn player_ids(&self) -> Vec<u32> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.players.keys().copied().collect(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.player_ids(),
        }
    }

    pub fn player_support(&self, player_id: u32) -> Option<PlayerSupportState> {
        #[cfg(not(feature = "physx-gpu"))]
        let _ = player_id;
        match &self.backend {
            PhysicsBackend::Rapier(_) => None,
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.player_support(player_id),
        }
    }

    pub fn alive_player_ids(&self) -> Vec<u32> {
        self.player_ids()
            .into_iter()
            .filter(|id| self.player_state(*id).is_some_and(|state| !state.dead))
            .collect()
    }

    pub fn player_hp(&self, player_id: u32) -> u8 {
        self.player_state(player_id).map_or(0, |state| state.hp)
    }

    pub fn player_is_dead(&self, player_id: u32) -> bool {
        self.player_state(player_id).is_some_and(|state| state.dead)
    }

    pub fn add_player_energy(&mut self, player_id: u32, delta: f32) -> Option<f32> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => {
                let state = arena.players.get_mut(&player_id)?;
                state.energy = (state.energy + delta).max(0.0);
                Some(state.energy)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.add_player_energy(player_id, delta),
        }
    }

    pub fn player_energy(&self, player_id: u32) -> Option<f32> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.player_energy(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.player_energy(player_id),
        }
    }

    pub fn set_player_dead(&mut self, player_id: u32, dead: bool) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.set_player_dead(player_id, dead),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.set_player_dead(player_id, dead),
        }
    }

    pub fn set_player_spawn_protected(&mut self, player_id: u32, value: bool) -> bool {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.set_player_spawn_protected(player_id, value),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.set_player_spawn_protected(player_id, value),
        }
    }

    pub fn apply_player_damage(&mut self, player_id: u32, damage: u8) -> PlayerDamageOutcome {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.apply_player_damage(player_id, damage),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.apply_player_damage(player_id, damage),
        }
    }

    pub fn is_player_in_vehicle(&self, player_id: u32) -> bool {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.vehicle_of_player.contains_key(&player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.is_player_in_vehicle(player_id),
        }
    }

    pub fn player_vehicle_id(&self, player_id: u32) -> Option<u32> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.vehicle_of_player.get(&player_id).copied(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.player_vehicle_id(player_id),
        }
    }

    pub fn vehicle_exists(&self, vehicle_id: u32) -> bool {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.vehicles.contains_key(&vehicle_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.vehicle_exists(vehicle_id),
        }
    }

    pub fn enter_vehicle(&mut self, player_id: u32, vehicle_id: u32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.enter_vehicle(player_id, vehicle_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.enter_vehicle(player_id, vehicle_id),
        }
    }

    pub fn exit_vehicle(&mut self, player_id: u32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.exit_vehicle(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.exit_vehicle(player_id),
        }
    }

    pub fn step_vehicles_and_dynamics(&mut self, dt: f32) -> (f32, f32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.step_vehicles_and_dynamics(dt),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.step_vehicles_and_dynamics(dt),
        }
    }

    #[cfg(test)]
    pub fn step_dynamics(&mut self, dt: f32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.dynamic.step_dynamics(dt),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                let _ = arena.step_vehicles_and_dynamics(dt);
            }
        }
    }

    pub fn apply_vehicle_player_collisions(&mut self) -> Vec<u32> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.apply_vehicle_player_collisions(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.apply_vehicle_player_collisions(),
        }
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.snapshot_dynamic_bodies(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.snapshot_dynamic_bodies(),
        }
    }

    pub fn snapshot_vehicles(&self) -> Vec<NetVehicleState> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.snapshot_vehicles(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.snapshot_vehicles(),
        }
    }

    pub fn cast_static_world_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        exclude_player: Option<u32>,
    ) -> Option<f32> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => {
                arena.cast_static_world_ray(origin, direction, max_distance, exclude_player)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                arena.cast_static_world_ray(origin, direction, max_distance, exclude_player)
            }
        }
    }

    pub fn cast_dynamic_body_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        exclude_player: Option<u32>,
    ) -> Option<(u32, f32, [f32; 3])> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => {
                arena.cast_dynamic_body_ray(origin, direction, max_distance, exclude_player)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                arena.cast_dynamic_body_ray(origin, direction, max_distance, exclude_player)
            }
        }
    }

    pub fn apply_dynamic_body_impulse(
        &mut self,
        body_id: u32,
        impulse: [f32; 3],
        point: [f32; 3],
    ) -> bool {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => {
                arena.apply_dynamic_body_impulse(body_id, impulse, point)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                arena.apply_dynamic_body_impulse(body_id, impulse, point)
            }
        }
    }

    pub fn terrain_y_at(&self, x: f64, z: f64) -> f64 {
        self.cast_static_world_ray([x as f32, 40.0, z as f32], [0.0, -1.0, 0.0], 100.0, None)
            .map(|distance| 40.0 - distance as f64)
            .unwrap_or(0.0)
    }

    pub fn spawn_battery(&mut self, position: Vec3d, energy: f32, radius: f32, height: f32) -> u32 {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.spawn_battery(position, energy, radius, height),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.spawn_battery(position, energy, radius, height),
        }
    }

    pub fn collect_batteries_for_player(&mut self, player_id: u32) -> Vec<(u32, f32)> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.collect_batteries_for_player(player_id),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.collect_batteries_for_player(player_id),
        }
    }

    pub fn snapshot_batteries(&self) -> Vec<(u32, [f32; 3], f32, f32, f32)> {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => arena.snapshot_batteries(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.snapshot_batteries(),
        }
    }

    pub fn apply_on_foot_energy_drain(
        &mut self,
        player_id: u32,
        previous_input: &InputCmd,
        input: &InputCmd,
        was_on_ground: bool,
        dt: f32,
    ) -> bool {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.apply_on_foot_energy_drain(
                player_id,
                previous_input,
                input,
                was_on_ground,
                dt,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.apply_on_foot_energy_drain(
                player_id,
                previous_input,
                input,
                was_on_ground,
                dt,
            ),
        }
    }

    pub fn apply_vehicle_energy_drain(&mut self, dt: f32) -> Vec<u32> {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => arena.apply_vehicle_energy_drain(dt),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.apply_vehicle_energy_drain(dt),
        }
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => (
                arena.dynamic.dynamic_bodies.len(),
                arena.vehicles.len(),
                arena.batteries.len(),
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.counts(),
        }
    }

    pub fn health(&self) -> PhysicsHealth {
        match &self.backend {
            PhysicsBackend::Rapier(_) => PhysicsHealth::default(),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => arena.health(),
        }
    }

    /// Generic bridge spans stashed by the health() read; empty off physx.
    #[cfg(feature = "physx-gpu")]
    pub fn take_physics_spans(&self) -> Vec<vibe_land_physx_bridge::NamedSpan> {
        match &self.backend {
            PhysicsBackend::Rapier(_) => Vec::new(),
            PhysicsBackend::Physx(arena) => arena.take_physics_spans(),
        }
    }
    #[cfg(not(feature = "physx-gpu"))]
    pub fn take_physics_spans(&self) -> Vec<vibe_land_destruction::types::NamedSpan> {
        Vec::new()
    }

    pub fn awake_dynamic_body_counts(
        &self,
        player_centers: &[[f32; 3]],
        near_radius: f32,
    ) -> (u32, u32) {
        match &self.backend {
            PhysicsBackend::Rapier(arena) => {
                let near_radius_sq = near_radius * near_radius;
                let mut total = 0;
                let mut near = 0;
                for dynamic in arena.dynamic.dynamic_bodies.values() {
                    let Some(body) = arena.dynamic.sim.rigid_bodies.get(dynamic.body_handle) else {
                        continue;
                    };
                    if body.is_sleeping() {
                        continue;
                    }
                    total += 1;
                    let position = body.translation();
                    if player_centers.iter().any(|center| {
                        let dx = position.x - center[0];
                        let dy = position.y - center[1];
                        let dz = position.z - center[2];
                        dx * dx + dy * dy + dz * dz <= near_radius_sq
                    }) {
                        near += 1;
                    }
                }
                (total, near)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                arena.awake_dynamic_body_counts(player_centers, near_radius)
            }
        }
    }
}

impl WorldDocumentArena for PhysicsArena {
    fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
        material: EffectiveTerrainMaterial,
    ) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::add_static_heightfield(
                arena, center, heights, scale, user_data, material,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::add_static_heightfield(
                arena, center, heights, scale, user_data, material,
            ),
        }
    }

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
        user_data: u128,
    ) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::add_static_cuboid(
                arena,
                center,
                rotation,
                half_extents,
                user_data,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::add_static_cuboid(
                arena,
                center,
                rotation,
                half_extents,
                user_data,
            ),
        }
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    ) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::spawn_dynamic_box_with_id(
                arena,
                id,
                position,
                rotation,
                half_extents,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::spawn_dynamic_box_with_id(
                arena,
                id,
                position,
                rotation,
                half_extents,
            ),
        }
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => {
                WorldDocumentArena::spawn_dynamic_ball_with_id(arena, id, position, radius)
            }
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => {
                WorldDocumentArena::spawn_dynamic_ball_with_id(arena, id, position, radius)
            }
        }
    }

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vector3<f32>,
        rotation: [f32; 4],
    ) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::spawn_vehicle_with_id(
                arena,
                id,
                vehicle_type,
                position,
                rotation,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::spawn_vehicle_with_id(
                arena,
                id,
                vehicle_type,
                position,
                rotation,
            ),
        }
    }

    fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::spawn_battery_with_id(
                arena, id, position, energy, radius, height,
            ),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::spawn_battery_with_id(
                arena, id, position, energy, radius, height,
            ),
        }
    }

    fn rebuild_broad_phase(&mut self) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::rebuild_broad_phase(arena),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::rebuild_broad_phase(arena),
        }
    }

    fn set_material_field(&mut self, field: Option<TerrainMaterialField>) {
        match &mut self.backend {
            PhysicsBackend::Rapier(arena) => WorldDocumentArena::set_material_field(arena, field),
            #[cfg(feature = "physx-gpu")]
            PhysicsBackend::Physx(arena) => WorldDocumentArena::set_material_field(arena, field),
        }
    }
}
