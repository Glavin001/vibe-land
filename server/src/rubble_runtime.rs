//! The physics arena on rubble: rubble owns every dynamic rigid body.
//!
//! rubble (AVBD on the GPU through wgpu) integrates the dynamic bodies --
//! world-document boxes and balls, fired balls and meteors -- against the
//! static world. What rubble does not have yet stays in the Rapier arena this
//! wraps: the player character controller, the stock vehicles and batteries.
//! Players meet rubble bodies through kinematic mirrors: every tick each
//! rubble body's pose is written into Rapier as a kinematic body of the same
//! shape, so players stand on and bump into them. That coupling is one-way
//! (a player cannot push a rubble body) until rubble has kinematic bodies and
//! a character controller of its own.
//!
//! No PhysX anywhere: this module and `vibe-land-rubble-bridge` are the whole
//! engine side of `--features rubble`.

use std::sync::{Arc, Mutex, MutexGuard};
use std::collections::{HashMap, VecDeque};

use anyhow::Result;
use nalgebra::{DMatrix, Isometry3, Quaternion, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::{
    ColliderBuilder, ColliderHandle, Group, InteractionGroups, RigidBodyBuilder, RigidBodyHandle,
};
use vibe_land_rubble_bridge::{BodyId, RubbleWorld, WorldConfig};
use vibe_land_shared::physics_arena::PhysicsArena as RapierPhysicsArena;
use vibe_land_shared::world_document::{EffectiveTerrainMaterial, TerrainMaterialField, WorldDocumentArena};

use crate::movement::{MoveConfig, PhysicsHealth};

type Vec3 = Vector3<f32>;

/// Shape codes of `snapshot_dynamic_bodies`, as the Rapier and PhysX arenas.
const SHAPE_BOX: u8 = 0;
const SHAPE_SPHERE: u8 = 1;
/// As `physx_runtime`: a launched ball starts clear of the shooter's capsule,
/// and at most this many fired balls live at once (the oldest is retired).
const MUZZLE_CLEARANCE_M: f32 = 0.6;
const MAX_LIVE_LAUNCHED_BALLS: usize = 24;
/// Where a retired body is parked: rubble bodies are append-only, so a
/// retired ball becomes a static body far below the world, out of every pair.
const PARKED_Y: f32 = -10_000.0;

#[derive(Clone, Copy, Debug)]
struct RubbleBody {
    body: BodyId,
    half_extents: [f32; 3],
    shape_type: u8,
    /// The kinematic mirror players collide with.
    mirror: RigidBodyHandle,
}

#[derive(Clone, Copy, Debug)]
enum Pool {
    Ball,
    Meteor,
}

#[derive(Clone, Copy, Debug)]
struct LaunchedBall {
    id: u32,
    expires_at: u64,
}

pub struct RubblePhysicsArena {
    /// Players, stock vehicles, batteries and the static world for the
    /// character controller. Its own dynamic arena holds only mirrors.
    pub rapier: RapierPhysicsArena,
    /// Shared with the city (`rubble_city`), which builds its structures in
    /// the same world. A mutex because rubble's ray casts dispatch GPU work
    /// while the facade's ray queries take `&self`; never held across calls.
    world: Arc<Mutex<RubbleWorld>>,
    bodies: HashMap<u32, RubbleBody>,
    /// rubble body -> game id, for ray hits.
    by_body: HashMap<BodyId, u32>,
    /// Retired projectile bodies, reused by the next launch of that radius.
    free_spheres: Vec<(f32, BodyId)>,
    next_dynamic_id: u32,
    ball_pool: Vec<u32>,
    ball_cursor: usize,
    meteor_pool: Vec<u32>,
    meteor_cursor: usize,
    launched_balls: VecDeque<LaunchedBall>,
    launch_tick: u64,
    /// Static rubble bodies made for runtime cuboids, by Rapier handle.
    runtime_statics: HashMap<ColliderHandle, BodyId>,
    /// Top of the lowest static surface, for "fell through the ground" checks.
    lowest_ground_y: Option<f32>,
    last_step_ms: f32,
    /// Steps rubble refused (a capacity overflow): nothing moved those ticks.
    /// Reported as `PhysicsHealth::gpu_warning_count`.
    failed_steps: u32,
}

fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<f32>().ok()).filter(|v| v.is_finite()).unwrap_or(default)
}

fn quat_array(rotation: &UnitQuaternion<f32>) -> [f32; 4] {
    [rotation.i, rotation.j, rotation.k, rotation.w]
}

fn unit_quat(r: [f32; 4]) -> UnitQuaternion<f32> {
    UnitQuaternion::from_quaternion(Quaternion::new(r[3], r[0], r[1], r[2]))
}

impl RubblePhysicsArena {
    pub fn new(config: MoveConfig) -> Result<Self> {
        let gravity = vibe_netcode::movement::world_gravity(&config);
        anyhow::ensure!(
            gravity[0] == 0.0 && gravity[2] == 0.0,
            "rubble integrates gravity along Y only; world gravity is {gravity:?}"
        );
        let mut world = RubbleWorld::new(WorldConfig {
            dt: 1.0 / f32::from(vibe_land_shared::constants::SIM_HZ),
            gravity_y: gravity[1],
            ..WorldConfig::default()
        })?;
        // The PhysX world material (physx-bridge WorldConfig): same variables,
        // same defaults, so the two engines are fed one set of numbers.
        world.set_material(0, env_f32("VIBE_WORLD_FRICTION", 0.5), env_f32("VIBE_WORLD_RESTITUTION", 0.1));
        Ok(Self {
            rapier: RapierPhysicsArena::new(config),
            world: Arc::new(Mutex::new(world)),
            bodies: HashMap::new(),
            by_body: HashMap::new(),
            free_spheres: Vec::new(),
            next_dynamic_id: 1,
            ball_pool: Vec::new(),
            ball_cursor: 0,
            meteor_pool: Vec::new(),
            meteor_cursor: 0,
            launched_balls: VecDeque::new(),
            launch_tick: 0,
            runtime_statics: HashMap::new(),
            lowest_ground_y: None,
            last_step_ms: 0.0,
            failed_steps: 0,
        })
    }

    /// The world, for the city to build its structures in.
    pub fn shared_world(&self) -> Arc<Mutex<RubbleWorld>> {
        self.world.clone()
    }

    fn world(&self) -> MutexGuard<'_, RubbleWorld> {
        self.world.lock().expect("rubble world poisoned")
    }

    fn note_ground(&mut self, top: f32) {
        self.lowest_ground_y = Some(self.lowest_ground_y.map_or(top, |y| y.min(top)));
    }

    // ── Kinematic mirrors ────────────────────────────────────────────────

    fn insert_mirror(&mut self, id: u32, position: Vec3, rotation: [f32; 4], half: [f32; 3], shape_type: u8) -> RigidBodyHandle {
        let sim = &mut self.rapier.dynamic.sim;
        let body = RigidBodyBuilder::kinematic_position_based()
            .pose(Isometry3::from_parts(Translation3::new(position.x, position.y, position.z), unit_quat(rotation)))
            .build();
        let handle = sim.rigid_bodies.insert(body);
        let collider = if shape_type == SHAPE_SPHERE {
            ColliderBuilder::ball(half[0])
        } else {
            ColliderBuilder::cuboid(half[0], half[1], half[2])
        }
        // The Rapier arena's dynamic-body groups, so the character controller
        // treats a mirror exactly as it treated a Rapier dynamic body.
        .collision_groups(InteractionGroups::new(Group::GROUP_2, Group::GROUP_1 | Group::GROUP_2))
        .user_data(id as u128)
        .build();
        sim.colliders.insert_with_parent(collider, handle, &mut sim.rigid_bodies);
        handle
    }

    fn sync_mirrors(&mut self) {
        let poses = self.world().bodies();
        let sim = &mut self.rapier.dynamic.sim;
        for body in self.bodies.values() {
            let Some(pose) = poses.get(body.body as usize) else { continue };
            if let Some(rb) = sim.rigid_bodies.get_mut(body.mirror) {
                let p = pose.position;
                rb.set_next_kinematic_position(Isometry3::from_parts(Translation3::new(p[0], p[1], p[2]), unit_quat(pose.rotation)));
            }
        }
    }

    // ── Dynamic bodies ───────────────────────────────────────────────────

    fn register(&mut self, id: u32, body: BodyId, position: Vec3, rotation: [f32; 4], half: [f32; 3], shape_type: u8) {
        let mirror = self.insert_mirror(id, position, rotation, half, shape_type);
        self.bodies.insert(id, RubbleBody { body, half_extents: half, shape_type, mirror });
        self.by_body.insert(body, id);
        self.next_dynamic_id = self.next_dynamic_id.max(id.saturating_add(1));
    }

    fn spawn_box(&mut self, id: u32, position: Vec3, rotation: [f32; 4], half: Vec3) {
        // The PhysX arena's mass for a world-document box (its volume, >= 1 kg).
        let mass = (half.x * half.y * half.z * 8.0).max(1.0);
        let body = self.world().add_dynamic_box(position.into(), rotation, half.into(), mass, 0);
        self.register(id, body, position, rotation, half.into(), SHAPE_BOX);
    }

    fn spawn_sphere(&mut self, id: u32, position: Vec3, radius: f32, mass: f32) -> BodyId {
        let reuse = self.free_spheres.iter().position(|&(r, _)| r == radius).map(|i| self.free_spheres.swap_remove(i).1);
        let body = match reuse {
            // A parked sphere of this radius: give it the new mass and bring it back.
            Some(body) => {
                self.world().revive_sphere(body, position.into(), radius, mass);
                body
            }
            None => self.world().add_dynamic_sphere(position.into(), radius, mass, 0),
        };
        self.register(id, body, position, [0.0, 0.0, 0.0, 1.0], [radius; 3], SHAPE_SPHERE);
        body
    }

    fn retire(&mut self, id: u32) {
        let Some(body) = self.bodies.remove(&id) else { return };
        self.by_body.remove(&body.body);
        let sim = &mut self.rapier.dynamic.sim;
        sim.rigid_bodies.remove(
            body.mirror,
            &mut sim.island_manager,
            &mut sim.colliders,
            &mut self.rapier.dynamic.impulse_joints,
            &mut self.rapier.dynamic.multibody_joints,
            true,
        );
        self.world().park(body.body, [0.0, PARKED_Y, 0.0]);
        if body.shape_type == SHAPE_SPHERE {
            self.free_spheres.push((body.half_extents[0], body.body));
        }
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vec3, radius: f32) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
        WorldDocumentArena::spawn_dynamic_ball_with_id(self, id, position, radius);
        id
    }

    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        let mut world = self.world();
        for pose in world.bodies() {
            let d = Vec3::from(pose.position) - center;
            if pose.dynamic && pose.sleeping && d.norm_squared() < radius * radius {
                world.wake(pose.id);
            }
        }
    }

    pub fn reserve_ball_pool(&mut self, count: usize) -> Vec<u32> {
        for _ in 0..count {
            self.ball_pool.push(self.next_dynamic_id);
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
        }
        self.ball_pool.clone()
    }

    pub fn reserve_meteor_pool(&mut self, count: usize) -> Vec<u32> {
        for _ in 0..count {
            self.meteor_pool.push(self.next_dynamic_id);
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
        }
        self.meteor_pool.clone()
    }

    fn take_pool_id(&mut self, pool: Pool) -> u32 {
        let (ids, cursor) = match pool {
            Pool::Ball => (&self.ball_pool, &mut self.ball_cursor),
            Pool::Meteor => (&self.meteor_pool, &mut self.meteor_cursor),
        };
        if ids.is_empty() {
            let fresh = self.next_dynamic_id;
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
            return fresh;
        }
        let slot = *cursor % ids.len();
        *cursor = slot.wrapping_add(1);
        let reserved = ids[slot];
        if self.bodies.contains_key(&reserved) {
            self.retire(reserved);
            self.launched_balls.retain(|ball| ball.id != reserved);
        }
        reserved
    }

    fn launch_body(&mut self, id: u32, position: Vec3, velocity: Vec3, radius: f32, mass: f32, ttl_ticks: u32) -> Option<u32> {
        let body = self.spawn_sphere(id, position, radius, mass);
        self.world().set_velocity(body, velocity.into(), [0.0; 3]);
        self.launched_balls.push_back(LaunchedBall { id, expires_at: self.launch_tick + u64::from(ttl_ticks.max(1)) });
        while self.launched_balls.len() > MAX_LIVE_LAUNCHED_BALLS {
            if let Some(oldest) = self.launched_balls.pop_front() {
                self.retire(oldest.id);
            }
        }
        Some(id)
    }

    pub fn launch_ball(&mut self, position: Vec3, direction: Vec3, radius: f32, mass: f32, speed: f32, ttl_ticks: u32) -> Option<u32> {
        let length = direction.norm();
        if !length.is_finite() || length <= 0.0 || !(radius > 0.0) || !(mass > 0.0) || !(speed > 0.0) {
            return None;
        }
        let unit = direction / length;
        let muzzle = position + unit * (radius + MUZZLE_CLEARANCE_M);
        let id = self.take_pool_id(Pool::Ball);
        self.launch_body(id, muzzle, unit * speed, radius, mass, ttl_ticks)
    }

    pub fn launch_ball_from_muzzle(&mut self, position: Vec3, velocity: Vec3, radius: f32, mass: f32, ttl_ticks: u32) -> Option<u32> {
        if !position.iter().chain(velocity.iter()).all(|x| x.is_finite()) || !(radius > 0.0) || !(mass > 0.0) || ttl_ticks == 0 {
            return None;
        }
        let id = self.take_pool_id(Pool::Ball);
        self.launch_body(id, position, velocity, radius, mass, ttl_ticks)
    }

    pub fn launch_meteor(&mut self, position: Vec3, velocity: Vec3, radius: f32, mass: f32, ttl_ticks: u32) -> Option<u32> {
        if !velocity.iter().all(|x| x.is_finite()) || !(radius > 0.0) || !(mass > 0.0) {
            return None;
        }
        let id = self.take_pool_id(Pool::Meteor);
        self.launch_body(id, position, velocity, radius, mass, ttl_ticks)
    }

    /// rubble has no CCD clamp yet, so nothing is ever clamped.
    pub fn balls_clamped(&self) -> u64 {
        0
    }

    pub fn launched_ball_count(&self) -> usize {
        self.launched_balls.len()
    }

    fn expire_launched_balls(&mut self) {
        self.launch_tick = self.launch_tick.saturating_add(1);
        while self.launched_balls.front().is_some_and(|ball| ball.expires_at <= self.launch_tick) {
            let ball = self.launched_balls.pop_front().expect("checked above");
            self.retire(ball.id);
        }
    }

    /// One tick: rubble steps the dynamic bodies, the mirrors take their new
    /// poses, then Rapier steps the vehicles (and moves the mirrors).
    pub fn step_vehicles_and_dynamics(&mut self, dt: f32) -> (f32, f32) {
        self.expire_launched_balls();
        let started = std::time::Instant::now();
        let stepped = self.world().step();
        if let Err(error) = stepped {
            self.failed_steps = self.failed_steps.saturating_add(1);
            tracing::error!(%error, failed_steps = self.failed_steps, "rubble step failed");
        }
        self.last_step_ms = started.elapsed().as_secs_f32() * 1000.0;
        self.sync_mirrors();
        let (vehicle_ms, rapier_ms) = self.rapier.step_vehicles_and_dynamics(dt);
        (vehicle_ms, rapier_ms + self.last_step_ms)
    }

    pub fn snapshot_dynamic_bodies(&self) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        let poses = self.world().bodies();
        self.bodies
            .iter()
            .filter_map(|(&id, body)| {
                let p = poses.get(body.body as usize)?;
                Some((id, p.position, p.rotation, body.half_extents, p.linear_velocity, p.angular_velocity, body.shape_type))
            })
            .collect()
    }

    /// The first rubble body along the ray, when it is a dynamic one:
    /// `(id, distance, point)`. A static surface in front blocks it.
    pub fn cast_dynamic_body_ray(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32, _exclude_player: Option<u32>) -> Option<(u32, f32, [f32; 3])> {
        let hit = self.world().raycast(&[(origin, direction, max_distance, None)])[0]?;
        let id = *self.by_body.get(&hit.body)?;
        Some((id, hit.distance, hit.point))
    }

    /// The first solid point along a ray (terrain, structure or body).
    pub fn cast_solid_ray_point(&self, origin: [f32; 3], direction: [f32; 3], max_distance: f32) -> Option<[f32; 3]> {
        let hit = self.world().raycast(&[(origin, direction, max_distance, None)])[0]?;
        Some(hit.point)
    }

    pub fn apply_dynamic_body_impulse(&mut self, body_id: u32, impulse: [f32; 3], point: [f32; 3]) -> bool {
        let Some(body) = self.bodies.get(&body_id) else { return false };
        self.world().apply_impulse(body.body, impulse, point);
        true
    }

    pub fn lowest_ground_y(&self) -> Option<f32> {
        self.lowest_ground_y
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        (self.bodies.len(), self.rapier.vehicles.len(), self.rapier.batteries.len())
    }

    pub fn awake_dynamic_body_counts(&self, player_centers: &[[f32; 3]], near_radius: f32) -> (u32, u32) {
        let poses = self.world().bodies();
        let (mut total, mut near) = (0, 0);
        for body in self.bodies.values() {
            let Some(p) = poses.get(body.body as usize) else { continue };
            if p.sleeping {
                continue;
            }
            total += 1;
            if player_centers.iter().any(|c| (Vec3::from(p.position) - Vec3::from(*c)).norm_squared() <= near_radius * near_radius) {
                near += 1;
            }
        }
        (total, near)
    }

    pub fn health(&self) -> PhysicsHealth {
        PhysicsHealth {
            gpu_active: true,
            gpu_warning_count: self.failed_steps,
            last_step_ms: self.last_step_ms,
            ..PhysicsHealth::default()
        }
    }

    // ── Runtime static cuboids (both worlds) ─────────────────────────────

    pub fn add_static_cuboid(&mut self, center: Vec3, half_extents: Vec3, user_data: u128) -> ColliderHandle {
        let native = self.rapier.add_static_cuboid(center, half_extents, user_data);
        let body = self.world().add_static_box(center.into(), [0.0, 0.0, 0.0, 1.0], half_extents.into(), 0);
        self.runtime_statics.insert(native, body);
        native
    }

    pub fn remove_collider(&mut self, native: ColliderHandle) {
        self.rapier.remove_collider(native);
        if let Some(body) = self.runtime_statics.remove(&native) {
            self.world().park(body, [0.0, PARKED_Y, 0.0]);
        }
    }
}

impl WorldDocumentArena for RubblePhysicsArena {
    /// Into Rapier for the character controller; into rubble only when the
    /// heightfield is flat, as one box with its top at that height. rubble has
    /// no heightfield shape yet, so a sloped one has no rubble collision (a gap).
    fn add_static_heightfield(&mut self, center: Vector3<f32>, heights: DMatrix<f32>, scale: Vector3<f32>, user_data: u128, material: EffectiveTerrainMaterial) {
        let (min, max) = heights.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &h| (lo.min(h), hi.max(h)));
        if min.is_finite() && min == max {
            let top = center.y + min * scale.y;
            let half = [scale.x * 0.5, 5.0, scale.z * 0.5];
            self.world().add_static_box([center.x, top - half[1], center.z], [0.0, 0.0, 0.0, 1.0], half, 0);
            self.note_ground(top);
        } else {
            tracing::warn!("rubble has no heightfield shape: this sloped terrain collides with players only");
        }
        WorldDocumentArena::add_static_heightfield(&mut self.rapier, center, heights, scale, user_data, material);
    }

    fn add_static_cuboid(&mut self, center: Vector3<f32>, rotation: [f32; 4], half_extents: Vector3<f32>, user_data: u128) {
        self.world().add_static_box(center.into(), rotation, half_extents.into(), 0);
        self.note_ground(center.y + half_extents.y);
        WorldDocumentArena::add_static_cuboid(&mut self.rapier, center, rotation, half_extents, user_data);
    }

    fn spawn_dynamic_box_with_id(&mut self, id: u32, position: Vector3<f32>, rotation: [f32; 4], half_extents: Vector3<f32>) {
        self.spawn_box(id, position, rotation, half_extents);
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        // The PhysX arena's mass for a world-document ball (its volume, >= 0.1 kg).
        let mass = (4.0 / 3.0 * std::f32::consts::PI * radius.powi(3)).max(0.1);
        self.spawn_sphere(id, position, radius, mass);
    }

    fn spawn_vehicle_with_id(&mut self, id: u32, vehicle_type: u8, position: Vector3<f32>, rotation: [f32; 4]) {
        WorldDocumentArena::spawn_vehicle_with_id(&mut self.rapier, id, vehicle_type, position, rotation);
    }

    fn spawn_battery_with_id(&mut self, id: u32, position: Vector3<f32>, energy: f32, radius: f32, height: f32) {
        WorldDocumentArena::spawn_battery_with_id(&mut self.rapier, id, position, energy, radius, height);
    }

    fn rebuild_broad_phase(&mut self) {
        WorldDocumentArena::rebuild_broad_phase(&mut self.rapier);
    }

    fn set_material_field(&mut self, field: Option<TerrainMaterialField>) {
        WorldDocumentArena::set_material_field(&mut self.rapier, field);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena() -> RubblePhysicsArena {
        let mut arena = RubblePhysicsArena::new(MoveConfig::default()).expect("wgpu device");
        // Flat ground, top at y = 0.
        WorldDocumentArena::add_static_cuboid(&mut arena, Vector3::new(0.0, -1.0, 0.0), [0.0, 0.0, 0.0, 1.0], Vector3::new(100.0, 1.0, 100.0), 0);
        arena
    }

    fn step(arena: &mut RubblePhysicsArena, ticks: u32) {
        let dt = 1.0 / f32::from(vibe_land_shared::constants::SIM_HZ);
        for _ in 0..ticks {
            arena.step_vehicles_and_dynamics(dt);
        }
    }

    /// A world-document box lands on the ground and comes to rest one half
    /// height up; its mirror (what players collide with) follows it.
    #[test]
    fn a_world_box_rests_on_the_ground_and_its_mirror_follows() {
        let mut arena = arena();
        let half = Vector3::new(0.5, 0.5, 0.5);
        WorldDocumentArena::spawn_dynamic_box_with_id(&mut arena, 7, Vector3::new(0.0, 0.5, 0.0), [0.0, 0.0, 0.0, 1.0], half);
        step(&mut arena, 120);
        let snaps = arena.snapshot_dynamic_bodies();
        let (id, pos, ..) = snaps.iter().find(|s| s.0 == 7).copied().expect("box 7 streams");
        assert_eq!(id, 7);
        let dt = 1.0 / f32::from(vibe_land_shared::constants::SIM_HZ);
        assert!((pos[1] - 0.5).abs() <= 0.01 + 9.81 * dt * dt, "rest height {}", pos[1]);
        let mirror = arena.bodies[&7].mirror;
        let rb = &arena.rapier.dynamic.sim.rigid_bodies[mirror];
        let next = rb.next_position().translation.vector;
        assert!((next - Vector3::from(pos)).norm() < 1e-4, "mirror {next:?} vs body {pos:?}");
    }

    /// A launched ball leaves the muzzle at the requested speed and comes
    /// from the reserved pool; retiring it frees the id for the next launch.
    #[test]
    fn a_launched_ball_flies_from_the_pool() {
        let mut arena = arena();
        let pool = arena.reserve_ball_pool(2);
        let id = arena
            .launch_ball(Vector3::new(0.0, 2.0, 0.0), Vector3::new(1.0, 0.0, 0.0), 0.3, 50.0, 40.0, 600)
            .expect("launched");
        assert_eq!(id, pool[0]);
        let ball = arena.snapshot_dynamic_bodies().into_iter().find(|s| s.0 == id).unwrap();
        assert!((ball.4[0] - 40.0).abs() < 1e-3, "launch speed {:?}", ball.4);
        assert_eq!(arena.launched_ball_count(), 1);
        step(&mut arena, 1);
        let after = arena.snapshot_dynamic_bodies().into_iter().find(|s| s.0 == id).unwrap();
        assert!(after.1[0] > ball.1[0], "the ball moved along +x");
    }

    /// Hitscan finds a dynamic body and names it by its game id.
    #[test]
    fn a_ray_finds_a_dynamic_body_by_game_id() {
        let mut arena = arena();
        WorldDocumentArena::spawn_dynamic_box_with_id(&mut arena, 42, Vector3::new(5.0, 0.5, 0.0), [0.0, 0.0, 0.0, 1.0], Vector3::new(0.5, 0.5, 0.5));
        let hit = arena.cast_dynamic_body_ray([0.0, 0.5, 0.0], [1.0, 0.0, 0.0], 20.0, None).expect("hit");
        assert_eq!(hit.0, 42);
        assert!((hit.1 - 4.5).abs() < 1e-3, "distance {}", hit.1);
    }
}
