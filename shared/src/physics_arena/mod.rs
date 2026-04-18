use std::collections::HashMap;

use nalgebra::{Point3, Vector3};
use rapier3d::control::DynamicRayCastVehicleController;
use rapier3d::prelude::*;

pub use crate::movement::{vehicle_wheel_params, MoveConfig, VEHICLE_MAX_STEER_RAD};
use crate::protocol::*;
pub use crate::simulation::{simulate_player_tick, PlayerTickResult};
use crate::{
    constants::{
        BTN_BACK, BTN_FORWARD, BTN_JUMP, BTN_LEFT, BTN_RIGHT, BTN_SPRINT, JUMP_ENERGY_COST,
        ON_FOOT_IDLE_DRAIN_PER_SEC, ON_FOOT_SPRINT_DRAIN_PER_SEC, ON_FOOT_WALK_DRAIN_PER_SEC,
    },
    movement::Vec3d,
};
pub use vibe_netcode::physics_arena::DynamicArena;

mod player;
mod spawn;
mod terrain_material_hook;
mod vehicle;

pub use terrain_material_hook::{
    is_terrain_material_collider, tag_terrain_user_data, TerrainMaterialHook,
    TERRAIN_MATERIAL_USER_DATA_FLAG,
};

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
    pub max_speed_override: Option<f64>,
    pub energy: f32,
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
    pub batteries: HashMap<u32, Battery>,
    next_battery_id: u32,
    /// Per-tile terrain material lookup populated by `WorldDocument::instantiate`
    /// when authored material splatmaps exist. `None` means "use Rapier defaults
    /// everywhere" — preserves original behaviour for unauthored worlds.
    pub material_field: Option<crate::world_document::TerrainMaterialField>,
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
            batteries: HashMap::new(),
            next_battery_id: crate::constants::BATTERY_ID_RANGE_START,
            material_field: None,
        }
    }

    pub fn config(&self) -> &MoveConfig {
        self.dynamic.config()
    }

    /// Sample blended friction/restitution at a world position. Returns the
    /// DEFAULT (grass-like) material when no `material_field` is installed.
    pub fn sample_terrain_material(
        &self,
        x: f32,
        z: f32,
    ) -> crate::world_document::EffectiveTerrainMaterial {
        match &self.material_field {
            Some(field) => field.sample(x, z),
            None => crate::world_document::EffectiveTerrainMaterial::DEFAULT,
        }
    }

    pub fn set_material_field(
        &mut self,
        field: Option<crate::world_document::TerrainMaterialField>,
    ) {
        self.material_field = field;
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

    pub fn add_static_heightfield_with_material(
        &mut self,
        center: Vec3,
        heights: nalgebra::DMatrix<f32>,
        scale: Vec3,
        user_data: u128,
        friction: f32,
        restitution: f32,
    ) -> ColliderHandle {
        self.dynamic.add_static_heightfield_with_material(
            center,
            heights,
            scale,
            user_data,
            friction,
            restitution,
        )
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
        match self.material_field.as_ref() {
            Some(field) => {
                let hook = TerrainMaterialHook::new(field);
                self.dynamic.step_dynamics_with_hooks(dt, &hook);
            }
            None => self.dynamic.step_dynamics(dt),
        }
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        self.dynamic.snapshot_dynamic_bodies()
    }

    pub fn player_energy(&self, player_id: u32) -> Option<f32> {
        self.players.get(&player_id).map(|state| state.energy)
    }

    pub fn spawn_battery(&mut self, position: Vec3d, energy: f32, radius: f32, height: f32) -> u32 {
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

    pub fn snapshot_batteries(&self) -> Vec<(u32, [f32; 3], f32, f32, f32)> {
        self.batteries
            .values()
            .map(|battery| {
                (
                    battery.id,
                    [
                        battery.position.x as f32,
                        battery.position.y as f32,
                        battery.position.z as f32,
                    ],
                    battery.energy,
                    battery.radius,
                    battery.height,
                )
            })
            .collect()
    }

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
        let player_radius = cfg.capsule_radius;
        let slack = crate::constants::BATTERY_PICKUP_SLACK_M;
        let mut collected = Vec::new();
        let mut collected_ids = Vec::new();

        for battery in self.batteries.values() {
            let dx = (battery.position.x - player_pos.x) as f32;
            let dy = (battery.position.y - player_pos.y) as f32;
            let dz = (battery.position.z - player_pos.z) as f32;
            let horiz = (dx * dx + dz * dz).sqrt();
            let horiz_limit = player_radius + battery.radius + slack;
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

    pub fn apply_vehicle_energy_drain(&mut self, dt: f32) -> Vec<u32> {
        use crate::constants::{VEHICLE_IDLE_DRAIN_PER_SEC, VEHICLE_SPEED_DRAIN_COEF};

        let drain_inputs: Vec<_> = self
            .vehicle_of_player
            .iter()
            .filter_map(|(&player_id, &vehicle_id)| {
                let vehicle = self.vehicles.get(&vehicle_id)?;
                let body = self.dynamic.sim.rigid_bodies.get(vehicle.chassis_body)?;
                let velocity = body.linvel();
                let speed =
                    (velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z)
                        .sqrt();
                Some((player_id, speed))
            })
            .collect();

        let mut depleted = Vec::new();
        for (player_id, speed) in drain_inputs {
            let Some(player) = self.players.get_mut(&player_id) else {
                continue;
            };
            if player.dead {
                continue;
            }
            let drain = (VEHICLE_IDLE_DRAIN_PER_SEC + VEHICLE_SPEED_DRAIN_COEF * speed) * dt;
            player.energy = (player.energy - drain).max(0.0);
            if player.energy <= 0.0 {
                depleted.push(player_id);
            }
        }
        depleted
    }

    pub fn apply_on_foot_energy_drain(
        &mut self,
        player_id: u32,
        previous_input: &InputCmd,
        input: &InputCmd,
        was_on_ground: bool,
        dt: f32,
    ) -> bool {
        if self.vehicle_of_player.contains_key(&player_id) {
            return false;
        }

        let Some(player) = self.players.get_mut(&player_id) else {
            return false;
        };
        if player.dead {
            return false;
        }

        let drain = on_foot_energy_drain_for_tick(previous_input, input, was_on_ground, dt);
        if drain <= 0.0 {
            return false;
        }

        player.energy = (player.energy - drain).max(0.0);
        player.energy <= 0.0
    }
}

fn input_has_move_intent(input: &InputCmd) -> bool {
    if input.move_x != 0 || input.move_y != 0 {
        return true;
    }

    input.buttons & (BTN_FORWARD | BTN_BACK | BTN_LEFT | BTN_RIGHT) != 0
}

fn jump_started(previous_input: &InputCmd, input: &InputCmd, was_on_ground: bool) -> bool {
    was_on_ground && input.buttons & BTN_JUMP != 0 && previous_input.buttons & BTN_JUMP == 0
}

fn on_foot_energy_drain_for_tick(
    previous_input: &InputCmd,
    input: &InputCmd,
    was_on_ground: bool,
    dt: f32,
) -> f32 {
    let per_second = if input_has_move_intent(input) {
        if input.buttons & BTN_SPRINT != 0 {
            ON_FOOT_SPRINT_DRAIN_PER_SEC
        } else {
            ON_FOOT_WALK_DRAIN_PER_SEC
        }
    } else {
        ON_FOOT_IDLE_DRAIN_PER_SEC
    };
    let jump_cost = if jump_started(previous_input, input, was_on_ground) {
        JUMP_ENERGY_COST
    } else {
        0.0
    };
    per_second * dt + jump_cost
}

#[cfg(test)]
mod tests {
    use super::{input_has_move_intent, jump_started, on_foot_energy_drain_for_tick};
    use crate::{
        constants::{
            BTN_FORWARD, BTN_JUMP, BTN_SPRINT, JUMP_ENERGY_COST, ON_FOOT_IDLE_DRAIN_PER_SEC,
            ON_FOOT_SPRINT_DRAIN_PER_SEC, ON_FOOT_WALK_DRAIN_PER_SEC,
        },
        protocol::InputCmd,
    };

    fn input() -> InputCmd {
        InputCmd::default()
    }

    #[test]
    fn movement_intent_covers_axes_and_legacy_buttons() {
        let mut analog = input();
        analog.move_y = 64;
        assert!(input_has_move_intent(&analog));

        let mut legacy = input();
        legacy.buttons = BTN_FORWARD;
        assert!(input_has_move_intent(&legacy));

        assert!(!input_has_move_intent(&input()));
    }

    #[test]
    fn on_foot_energy_drain_matches_idle_walk_and_sprint_rates() {
        let idle = on_foot_energy_drain_for_tick(&input(), &input(), true, 1.0);
        assert_eq!(idle, ON_FOOT_IDLE_DRAIN_PER_SEC);

        let mut walk = input();
        walk.move_y = 127;
        assert_eq!(
            on_foot_energy_drain_for_tick(&input(), &walk, true, 1.0),
            ON_FOOT_WALK_DRAIN_PER_SEC
        );

        let mut sprint = walk.clone();
        sprint.buttons |= BTN_SPRINT;
        assert_eq!(
            on_foot_energy_drain_for_tick(&walk, &sprint, true, 1.0),
            ON_FOOT_SPRINT_DRAIN_PER_SEC
        );
    }

    #[test]
    fn jump_cost_only_applies_once_when_grounded() {
        let previous = input();
        let mut jumping = input();
        jumping.buttons = BTN_JUMP;

        assert!(jump_started(&previous, &jumping, true));
        assert_eq!(
            on_foot_energy_drain_for_tick(&previous, &jumping, true, 0.0),
            JUMP_ENERGY_COST
        );
        assert_eq!(
            on_foot_energy_drain_for_tick(&jumping, &jumping, true, 0.0),
            0.0
        );
        assert_eq!(
            on_foot_energy_drain_for_tick(&previous, &jumping, false, 0.0),
            0.0
        );
    }
}
