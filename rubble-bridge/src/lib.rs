//! vibe-land's rigid-body world on rubble.
//!
//! rubble (AVBD, Slang kernels, run here through wgpu: Metal on the Mac,
//! Vulkan on Linux) owns every dynamic body: motion, gravity, contacts and
//! friction are rubble's alone. This crate is a thin host over
//! `engine_webgpu::WgpuSim` with plain arrays at the boundary, so the server
//! never sees rubble's record layouts and needs no PhysX at all.
//!
//! Ids are rubble body indices. rubble bodies are append-only, so callers that
//! recycle bodies (projectiles) keep their own pools.

use engine_schema::{AvbdParams, BodyFlags, BodyState, Collider, Material, ShapeType, WorldCapacity};
use engine_webgpu::WgpuSim;
use glam::{Mat3, Quat, Vec3};

pub type BodyId = u32;

/// World construction parameters.
#[derive(Clone, Copy, Debug)]
pub struct WorldConfig {
    /// Fixed step (s). rubble takes one implicit step per tick, no substeps.
    pub dt: f32,
    /// Gravity along +Y (m/s^2); rubble supports the Y axis only.
    pub gravity_y: f32,
    pub iterations: u32,
    pub max_bodies: u32,
    pub max_colliders: u32,
    pub max_contacts: u32,
    /// rubble's hierarchical broadphase grid (levels sized from every
    /// collider). On by default: vibe-land's worlds mix scales -- metre-scale
    /// chunks and terrain beside 0.3 m balls -- which overflow the uniform
    /// grid's oversized-static list.
    pub hierarchical_grid: bool,
}

impl Default for WorldConfig {
    fn default() -> Self {
        Self {
            dt: 1.0 / 60.0,
            gravity_y: -9.81,
            iterations: 10,
            max_bodies: 16_384,
            max_colliders: 65_536,
            max_contacts: 262_144,
            hierarchical_grid: true,
        }
    }
}

/// A body's state as rubble last solved it. `position` is the centre of mass.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BodyPose {
    pub id: BodyId,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub dynamic: bool,
    pub sleeping: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RayHit {
    pub body: BodyId,
    pub collider: u32,
    pub point: [f32; 3],
    pub normal: [f32; 3],
    pub distance: f32,
}

/// One box in a compound body, in the body's input frame.
#[derive(Clone, Copy, Debug)]
pub struct BoxPart {
    pub center: [f32; 3],
    pub rotation: [f32; 4],
    pub half_extents: [f32; 3],
}

pub struct RubbleWorld {
    sim: WgpuSim,
    /// Collider index -> body, for ray hits.
    collider_body: Vec<BodyId>,
    config: WorldConfig,
}

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

fn static_body(position: [f32; 3], rotation: [f32; 4]) -> BodyState {
    BodyState {
        position,
        inv_mass: 0.0,
        orientation: rotation,
        inv_inertia: [0.0; 3],
        flags: 0,
        linear_vel: [0.0; 3],
        sleep_timer: 0.0,
        angular_vel: [0.0; 3],
        generation: 0,
        initial_pos: position,
        initial_pad: 0.0,
        initial_rot: rotation,
    }
}

fn box_params(half: [f32; 3]) -> [f32; 4] {
    [half[0], half[1], half[2], Vec3::from(half).length()]
}

/// Solid box inertia about its centre (principal axes = box axes).
fn box_inertia(mass: f32, half: [f32; 3]) -> Vec3 {
    let [x, y, z] = half.map(|h| 2.0 * h);
    Vec3::new(y * y + z * z, x * x + z * z, x * x + y * y) * (mass / 12.0)
}

impl RubbleWorld {
    pub fn new(config: WorldConfig) -> anyhow::Result<Self> {
        let capacity = WorldCapacity {
            max_bodies: config.max_bodies,
            max_colliders: config.max_colliders,
            max_contacts: config.max_contacts,
            max_candidates: config.max_contacts * 2,
            ..WorldCapacity::default()
        };
        let mut sim = WgpuSim::new(capacity)?;
        let mut params = AvbdParams::default();
        params.dt = config.dt;
        params.gravity_y = config.gravity_y;
        params.iterations = config.iterations;
        sim.set_params(params);
        if config.hierarchical_grid {
            sim.set_grid_levels(Some(true));
        }
        Ok(Self { sim, collider_body: Vec::new(), config })
    }

    pub fn config(&self) -> WorldConfig {
        self.config
    }

    /// Material table entry (rubble has 64). Friction combines as sqrt(a*b).
    pub fn set_material(&mut self, index: u32, friction: f32, restitution: f32) {
        self.sim.set_material(index, Material { friction, restitution, contact_offset: 0.01, _pad: 0.0 });
    }

    fn push_collider(&mut self, collider: Collider) -> u32 {
        let id = self.sim.add_collider(collider);
        debug_assert_eq!(id as usize, self.collider_body.len());
        self.collider_body.push(collider.body);
        id
    }

    fn box_collider(body: BodyId, center: [f32; 3], rotation: [f32; 4], half: [f32; 3], material: u32) -> Collider {
        Collider {
            body,
            shape: ShapeType::Box as u32,
            material,
            generation: 0,
            local_pos: center,
            density: 0.0,
            local_rot: rotation,
            params: box_params(half),
        }
    }

    pub fn add_static_box(&mut self, position: [f32; 3], rotation: [f32; 4], half: [f32; 3], material: u32) -> BodyId {
        let body = self.sim.add_body(static_body(position, rotation));
        self.push_collider(Self::box_collider(body, [0.0; 3], IDENTITY, half, material));
        body
    }

    pub fn add_dynamic_box(&mut self, position: [f32; 3], rotation: [f32; 4], half: [f32; 3], mass: f32, material: u32) -> BodyId {
        let state = BodyState::dynamic(position.into(), Quat::from_array(rotation), mass, box_inertia(mass, half));
        let body = self.sim.add_body(state);
        self.push_collider(Self::box_collider(body, [0.0; 3], IDENTITY, half, material));
        body
    }

    pub fn add_dynamic_sphere(&mut self, position: [f32; 3], radius: f32, mass: f32, material: u32) -> BodyId {
        let i = 0.4 * mass * radius * radius;
        let state = BodyState::dynamic(position.into(), Quat::IDENTITY, mass, Vec3::splat(i));
        let body = self.sim.add_body(state);
        self.push_collider(Collider {
            body,
            shape: ShapeType::Sphere as u32,
            material,
            generation: 0,
            local_pos: [0.0; 3],
            density: 0.0,
            local_rot: IDENTITY,
            params: [radius, 0.0, 0.0, radius],
        });
        body
    }

    /// A static compound (e.g. an intact structure anchored to the ground):
    /// `parts` in the body frame placed at `position`/`rotation`.
    pub fn add_static_compound(&mut self, position: [f32; 3], rotation: [f32; 4], parts: &[BoxPart], material: u32) -> BodyId {
        let body = self.sim.add_body(static_body(position, rotation));
        for part in parts {
            self.push_collider(Self::box_collider(body, part.center, part.rotation, part.half_extents, material));
        }
        body
    }

    pub fn step(&mut self) -> anyhow::Result<()> {
        self.sim.step().map_err(|e| anyhow::anyhow!("rubble step: {e:?}"))?;
        Ok(())
    }

    pub fn body_count(&self) -> u32 {
        self.sim.body_count()
    }

    pub fn body(&self, id: BodyId) -> BodyPose {
        pose(id, &self.sim.read_body(id))
    }

    /// Every body's state in one readback.
    pub fn bodies(&self) -> Vec<BodyPose> {
        self.sim.download_bodies().iter().enumerate().map(|(i, b)| pose(i as u32, b)).collect()
    }

    /// Overwrite a dynamic body's velocity (and wake it).
    pub fn set_velocity(&mut self, id: BodyId, linear: [f32; 3], angular: [f32; 3]) {
        let mut b = self.sim.read_body(id);
        b.linear_vel = linear;
        b.angular_vel = angular;
        wake(&mut b);
        self.sim.write_bodies(id, &[b]);
    }

    /// Move a body (and zero nothing else): a teleport, for respawn and pools.
    pub fn set_pose(&mut self, id: BodyId, position: [f32; 3], rotation: [f32; 4]) {
        let mut b = self.sim.read_body(id);
        b.position = position;
        b.orientation = rotation;
        wake(&mut b);
        self.sim.write_bodies(id, &[b]);
    }

    pub fn wake(&mut self, id: BodyId) {
        let mut b = self.sim.read_body(id);
        wake(&mut b);
        self.sim.write_bodies(id, &[b]);
    }

    /// Retire a body. rubble bodies are append-only, so it becomes static at
    /// `parked` (far outside the world), where it pairs with nothing, and its
    /// index can be revived later.
    pub fn park(&mut self, id: BodyId, parked: [f32; 3]) {
        let mut b = self.sim.read_body(id);
        b.inv_mass = 0.0;
        b.inv_inertia = [0.0; 3];
        b.flags = 0;
        b.linear_vel = [0.0; 3];
        b.angular_vel = [0.0; 3];
        b.position = parked;
        self.sim.write_bodies(id, &[b]);
    }

    /// Bring a parked sphere back as a dynamic body of `mass` at `position`,
    /// at rest. Its collider (and so its radius) is the one it was made with.
    pub fn revive_sphere(&mut self, id: BodyId, position: [f32; 3], radius: f32, mass: f32) {
        let i = 0.4 * mass * radius * radius;
        let mut b = BodyState::dynamic(position.into(), Quat::IDENTITY, mass, Vec3::splat(i));
        b.generation = self.sim.read_body(id).generation;
        self.sim.write_bodies(id, &[b]);
    }

    /// Instantaneous impulse `j` (N s) at world `point`: dv = J/m, dw = I^-1 (r x J),
    /// with the world inverse inertia R diag(I^-1) R^T. Host-side until rubble's
    /// force command lands on the GPU.
    pub fn apply_impulse(&mut self, id: BodyId, impulse: [f32; 3], point: [f32; 3]) {
        let mut b = self.sim.read_body(id);
        if b.inv_mass <= 0.0 {
            return;
        }
        let j = Vec3::from(impulse);
        let r = Vec3::from(point) - Vec3::from(b.position);
        let rot = Mat3::from_quat(Quat::from_array(b.orientation));
        let inv_inertia_world = rot * Mat3::from_diagonal(b.inv_inertia.into()) * rot.transpose();
        b.linear_vel = (Vec3::from(b.linear_vel) + j * b.inv_mass).to_array();
        b.angular_vel = (Vec3::from(b.angular_vel) + inv_inertia_world * r.cross(j)).to_array();
        wake(&mut b);
        self.sim.write_bodies(id, &[b]);
    }

    /// Batched world ray casts (`dir` need not be normalised).
    pub fn raycast(&mut self, rays: &[([f32; 3], [f32; 3], f32, Option<BodyId>)]) -> Vec<Option<RayHit>> {
        let rays: Vec<engine_vehicle::Ray> = rays
            .iter()
            .map(|&(origin, dir, max_dist, exclude_body)| engine_vehicle::Ray {
                origin,
                dir: Vec3::from(dir).normalize_or_zero().to_array(),
                max_dist,
                exclude_body,
            })
            .collect();
        self.sim
            .raycast_batch(&rays)
            .into_iter()
            .map(|hit| {
                hit.map(|h| RayHit {
                    body: self.collider_body.get(h.collider as usize).copied().unwrap_or(u32::MAX),
                    collider: h.collider,
                    point: h.point,
                    normal: h.normal,
                    distance: h.distance,
                })
            })
            .collect()
    }
}

fn wake(b: &mut BodyState) {
    if b.inv_mass > 0.0 {
        b.flags = (b.flags & !(BodyFlags::Sleeping as u32)) | BodyFlags::Awake as u32;
        b.sleep_timer = 0.0;
    }
}

fn pose(id: BodyId, b: &BodyState) -> BodyPose {
    BodyPose {
        id,
        position: b.position,
        rotation: b.orientation,
        linear_velocity: b.linear_vel,
        angular_velocity: b.angular_vel,
        dynamic: b.is_dynamic(),
        sleeping: b.is_sleeping(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: f32 = 9.81;

    fn ground(world: &mut RubbleWorld) {
        world.set_material(0, 0.6, 0.0);
        // Top face at y = 0.
        world.add_static_box([0.0, -5.0, 0.0], IDENTITY, [200.0, 5.0, 200.0], 0);
    }

    /// A sphere placed touching the ground stays there: its centre one radius
    /// up, within rubble's contact offset plus one step of gravity (g*dt^2),
    /// the depth a new contact sinks before it ramps up.
    #[test]
    fn a_sphere_placed_on_the_ground_rests_one_radius_up() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        let r = 0.5;
        let ball = world.add_dynamic_sphere([0.0, r, 0.0], r, 10.0, 0);
        for _ in 0..120 {
            world.step().unwrap();
        }
        let dt = world.config().dt;
        let p = world.body(ball);
        let tolerance = 0.01 + G * dt * dt;
        assert!((p.position[1] - r).abs() <= tolerance, "rest height {} vs radius {r} (tol {tolerance})", p.position[1]);
        assert!(Vec3::from(p.linear_velocity).length() <= G * dt);
    }

    /// The same after a fall. Fails on rubble main: the overlap a contact has on
    /// impact is kept (alpha = 0.99 holds 99% of C0 each step, and the shared
    /// step plan never runs the post-stabilisation pass FLAG_POST_STAB asks
    /// for; only the JS host does). A 3 m drop rests 6 cm deep. The fix belongs
    /// in rubble (post-stabilisation in engine-exec's rigid_plan), not here.
    #[test]
    #[ignore = "rubble gap: impact penetration is kept (no post-stabilisation in the Rust step plan)"]
    fn a_dropped_sphere_rests_one_radius_above_the_ground() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        let r = 0.5;
        let ball = world.add_dynamic_sphere([0.0, 3.0, 0.0], r, 10.0, 0);
        for _ in 0..240 {
            world.step().unwrap();
        }
        let dt = world.config().dt;
        let p = world.body(ball);
        let tolerance = 0.01 + G * dt * dt;
        assert!((p.position[1] - r).abs() <= tolerance, "rest height {} vs radius {r} (tol {tolerance})", p.position[1]);
    }

    /// Free fall before contact matches y = y0 - g t^2/2 for an implicit
    /// (backward Euler) integrator: y_n = y0 - g dt^2 n(n+1)/2.
    #[test]
    fn free_fall_matches_the_implicit_integrator() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        let ball = world.add_dynamic_sphere([0.0, 50.0, 0.0], 0.5, 1.0, 0);
        let n = 30;
        for _ in 0..n {
            world.step().unwrap();
        }
        let dt = world.config().dt;
        let expected = 50.0 - G * dt * dt * (n * (n + 1)) as f32 / 2.0;
        let y = world.body(ball).position[1];
        assert!((y - expected).abs() < 1e-3, "y {y} vs {expected}");
    }

    /// An impulse through the centre of mass changes only linear velocity, by J/m.
    #[test]
    fn a_central_impulse_changes_momentum_by_j() {
        let mut world = RubbleWorld::new(WorldConfig { gravity_y: 0.0, ..WorldConfig::default() }).expect("wgpu device");
        let m = 4.0;
        let ball = world.add_dynamic_sphere([0.0, 10.0, 0.0], 0.5, m, 0);
        world.apply_impulse(ball, [8.0, 0.0, 0.0], [0.0, 10.0, 0.0]);
        let p = world.body(ball);
        assert!((p.linear_velocity[0] - 8.0 / m).abs() < 1e-6);
        assert!(Vec3::from(p.angular_velocity).length() < 1e-6);
    }

    /// A parked body stops taking part (no gravity, no contacts); revived, it
    /// is a dynamic body again where it was put, and falls.
    #[test]
    fn a_parked_sphere_is_inert_and_revives() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        let ball = world.add_dynamic_sphere([0.0, 3.0, 0.0], 0.5, 2.0, 0);
        world.park(ball, [0.0, -10_000.0, 0.0]);
        for _ in 0..10 {
            world.step().unwrap();
        }
        let parked = world.body(ball);
        assert!(!parked.dynamic && parked.position[1] == -10_000.0, "{parked:?}");
        world.revive_sphere(ball, [4.0, 5.0, 0.0], 0.5, 2.0);
        for _ in 0..10 {
            world.step().unwrap();
        }
        let revived = world.body(ball);
        assert!(revived.dynamic && revived.position[1] < 5.0 && (revived.position[0] - 4.0).abs() < 1e-4, "{revived:?}");
    }

    /// A city: thousands of static chunk boxes far larger than the small
    /// dynamic bodies (balls) beside them. The step must not overflow rubble's
    /// oversized-static list (1024 entries, which a uniform grid sized from a
    /// 0.3 m ball fills with every 2 m chunk), and the ball must still land on
    /// one of them.
    #[test]
    fn a_city_of_large_statics_steps_beside_small_balls() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        for i in 0..1100 {
            let (x, z) = ((i % 40) as f32 * 4.0 - 80.0, (i / 40) as f32 * 4.0 - 60.0);
            world.add_static_box([x, 1.0, z], IDENTITY, [1.0, 1.0, 1.0], 0);
        }
        // Above the box at (0, 1, 0), whose top is y = 2.
        let ball = world.add_dynamic_sphere([0.0, 4.0, 0.0], 0.3, 50.0, 0);
        for _ in 0..120 {
            world.step().expect("a city-scale step");
        }
        let y = world.body(ball).position[1];
        assert!(y > 2.0 && y < 2.6, "the ball rests on the box top: y {y}");
    }

    #[test]
    fn a_ray_down_hits_the_ground_and_names_its_body() {
        let mut world = RubbleWorld::new(WorldConfig::default()).expect("wgpu device");
        ground(&mut world);
        let hit = world.raycast(&[([3.0, 4.0, 1.0], [0.0, -1.0, 0.0], 10.0, None)])[0].expect("ground hit");
        assert!((hit.distance - 4.0).abs() < 1e-3, "distance {}", hit.distance);
        assert_eq!(hit.body, 0);
    }
}

