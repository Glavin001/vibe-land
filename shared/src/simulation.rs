use nalgebra::{vector, Isometry3, Vector3};
use rapier3d::control::{
    CharacterAutostep, CharacterCollision, CharacterLength, KinematicCharacterController,
};
use rapier3d::prelude::*;

use crate::constants::*;
use crate::movement::*;
use crate::protocol::InputCmd;

/// Core collision world + KCC simulation shared between server (native) and
/// client (WASM).  Owns the Rapier collision primitives but does NOT own a
/// `PhysicsPipeline` — dynamic rigid-body simulation is server-only.
pub struct SimWorld {
    pub config: MoveConfig,

    // Collision world — pub so the server can layer a PhysicsPipeline on top.
    pub rigid_bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub integration_parameters: IntegrationParameters,
    pub island_manager: IslandManager,
    pub broad_phase: BroadPhaseBvh,
    pub narrow_phase: NarrowPhase,

    controller: KinematicCharacterController,
    modified_colliders: Vec<ColliderHandle>,
    removed_colliders: Vec<ColliderHandle>,
}

impl SimWorld {
    pub fn new(config: MoveConfig) -> Self {
        let mut controller = KinematicCharacterController::default();
        controller.offset = CharacterLength::Absolute(config.collision_offset);
        controller.autostep = Some(CharacterAutostep {
            max_height: CharacterLength::Absolute(config.max_step_height),
            min_width: CharacterLength::Absolute(config.min_step_width),
            include_dynamic_bodies: false,
        });
        controller.snap_to_ground = Some(CharacterLength::Absolute(config.snap_to_ground));
        controller.max_slope_climb_angle = config.max_slope_radians;
        controller.min_slope_slide_angle = config.min_slide_radians;

        let mut sim = Self {
            config,
            rigid_bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            integration_parameters: IntegrationParameters::default(),
            island_manager: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            controller,
            modified_colliders: Vec::new(),
            removed_colliders: Vec::new(),
        };

        sim.integration_parameters.dt = 1.0 / 60.0;
        sim.integration_parameters.num_solver_iterations = 2;
        sim
    }

    // ── Collider management ──────────────────────────

    pub fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    ) -> ColliderHandle {
        self.colliders.insert(
            ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                .translation(center)
                .user_data(user_data)
                .build(),
        )
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.colliders
            .remove(handle, &mut self.island_manager, &mut self.rigid_bodies, true);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.colliders.get(handle).map(|c| c.user_data)
    }

    /// Flush pending collider changes into the broad-phase BVH.
    pub fn sync_broad_phase(&mut self) {
        if self.modified_colliders.is_empty() && self.removed_colliders.is_empty() {
            return;
        }
        let mut events = Vec::new();
        self.broad_phase.update(
            &self.integration_parameters,
            &self.colliders,
            &self.rigid_bodies,
            &self.modified_colliders,
            &self.removed_colliders,
            &mut events,
        );
        self.modified_colliders.clear();
        self.removed_colliders.clear();
    }

    /// Bootstrap the broad-phase BVH with all current colliders.  Call once
    /// after bulk seeding, before the first tick.
    pub fn rebuild_broad_phase(&mut self) {
        self.modified_colliders.clear();
        self.removed_colliders.clear();
        for (handle, _) in self.colliders.iter() {
            self.modified_colliders.push(handle);
        }
        self.sync_broad_phase();
    }

    // ── Player capsule management ────────────────────

    /// Create a kinematic player capsule collider at `position`.
    pub fn create_player_collider(&mut self, position: Vec3d, player_id: u32) -> ColliderHandle {
        let collider = ColliderBuilder::capsule_y(
            self.config.capsule_half_segment,
            self.config.capsule_radius,
        )
        .translation(vector![position.x as f32, position.y as f32, position.z as f32])
        .friction(0.0)
        .active_collision_types(
            ActiveCollisionTypes::default() | ActiveCollisionTypes::KINEMATIC_FIXED,
        )
        .user_data(player_id as u128)
        .build();
        self.colliders.insert(collider)
    }

    pub fn remove_player_collider(&mut self, handle: ColliderHandle) {
        self.removed_colliders.push(handle);
        self.colliders
            .remove(handle, &mut self.island_manager, &mut self.rigid_bodies, true);
    }

    // ── Simulation tick ──────────────────────────────

    /// Run one simulation step for a single player.  Updates position,
    /// velocity, and on_ground in place.  Returns the full collision events
    /// (needed by `solve_character_collision_impulses` for server-side pushing).
    pub fn simulate_tick(
        &self,
        collider_handle: ColliderHandle,
        position: &mut Vec3d,
        velocity: &mut Vec3d,
        yaw: &mut f64,
        pitch: &mut f64,
        on_ground: &mut bool,
        input: &InputCmd,
        dt: f32,
    ) -> Vec<CharacterCollision> {
        let cfg = &self.config;
        let dt64 = dt as f64;

        // Phase 1: Update orientation + movement math (all f64)
        *yaw = input.yaw as f64;
        *pitch = (input.pitch as f64).clamp(-1.55, 1.55);

        let wish = build_wish_dir(input, *yaw);
        let max_speed = pick_move_speed(cfg, input.buttons);

        apply_horizontal_friction(velocity, cfg.friction, dt64, *on_ground);
        accelerate(
            velocity,
            wish,
            max_speed,
            if *on_ground { cfg.ground_accel } else { cfg.air_accel },
            dt64,
        );

        if *on_ground && (input.buttons & BTN_JUMP != 0) {
            velocity.y = cfg.jump_speed;
            *on_ground = false;
        }

        velocity.y -= cfg.gravity * dt64;

        // Phase 2: Convert to f32 for Rapier KCC
        let desired = *velocity * dt64;
        let desired_translation_f32 =
            vector![desired.x as f32, desired.y as f32, desired.z as f32];
        let position_f32 =
            vector![position.x as f32, position.y as f32, position.z as f32];

        // Phase 3: Run KCC (all f32 — Rapier's native precision)
        let collider = self.colliders.get(collider_handle).expect("missing player collider");
        let character_shape = collider.shape();
        let character_pos =
            Isometry3::translation(position_f32.x, position_f32.y, position_f32.z);

        let filter = QueryFilter::default().exclude_collider(collider_handle);
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );

        let mut collisions: Vec<CharacterCollision> = Vec::new();
        let corrected = self.controller.move_shape(
            dt,
            &query_pipeline,
            character_shape,
            &character_pos,
            desired_translation_f32,
            |collision| {
                collisions.push(collision);
            },
        );

        // Phase 4: Apply f32 KCC results back to f64 state
        let ct = corrected.translation;
        position.x += ct.x as f64;
        position.y += ct.y as f64;
        position.z += ct.z as f64;

        *on_ground = corrected.grounded;
        if *on_ground && velocity.y < 0.0 {
            velocity.y = 0.0;
        }

        velocity.x = ct.x as f64 / dt64;
        velocity.z = ct.z as f64 / dt64;

        collisions
    }

    /// Update the collider position to match the player's current position.
    /// Call after `simulate_tick` to keep the collider in sync.
    pub fn sync_player_collider(&mut self, handle: ColliderHandle, position: &Vec3d) {
        let pos_f32 = vector![position.x as f32, position.y as f32, position.z as f32];
        if let Some(collider) = self.colliders.get_mut(handle) {
            collider.set_translation(pos_f32);
        }
    }

    // ── Dynamic body impulses ─────────────────────────

    /// Apply physics-correct impulses from KCC collisions to dynamic bodies.
    /// Uses Rapier's built-in solver which accounts for contact normals,
    /// penetration depth, and mass ratios.
    pub fn solve_character_collision_impulses(
        &mut self,
        collider_handle: ColliderHandle,
        character_mass: f32,
        collisions: &[CharacterCollision],
        dt: f32,
    ) {
        let character_shape = self.colliders.get(collider_handle)
            .map(|c| c.shape().clone_dyn())
            .expect("missing player collider");
        let filter = QueryFilter::default().exclude_collider(collider_handle);
        let mut query_pipeline = self.broad_phase.as_query_pipeline_mut(
            self.narrow_phase.query_dispatcher(),
            &mut self.rigid_bodies,
            &mut self.colliders,
            filter,
        );
        self.controller.solve_character_collision_impulses(
            dt,
            &mut query_pipeline,
            &*character_shape,
            character_mass,
            collisions,
        );
    }

    // ── Raycasting ───────────────────────────────────

    pub fn cast_ray(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_collider: Option<ColliderHandle>,
    ) -> Option<f32> {
        let ray = Ray::new(
            nalgebra::point![origin[0], origin[1], origin[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        let mut filter = QueryFilter::default();
        if let Some(handle) = exclude_collider {
            filter = filter.exclude_collider(handle);
        }
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );
        query_pipeline
            .cast_ray(&ray, max_toi, true)
            .map(|(_handle, toi)| toi)
    }

    /// Cast a ray and return both the time-of-impact and the surface normal.
    pub fn cast_ray_and_get_normal(
        &self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_collider: Option<ColliderHandle>,
    ) -> Option<(f32, [f32; 3])> {
        let ray = Ray::new(
            nalgebra::point![origin[0], origin[1], origin[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        let mut filter = QueryFilter::default();
        if let Some(handle) = exclude_collider {
            filter = filter.exclude_collider(handle);
        }
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );
        query_pipeline
            .cast_ray_and_get_normal(&ray, max_toi, true)
            .map(|(_handle, intersection)| {
                let n = intersection.normal;
                (intersection.time_of_impact, [n.x, n.y, n.z])
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn sim_with_ground() -> SimWorld {
        let mut sim = SimWorld::new(MoveConfig::default());
        sim.add_static_cuboid(
            vector![0.0, -0.5, 0.0],
            vector![50.0, 0.5, 50.0],
            0,
        );
        sim.rebuild_broad_phase();
        sim
    }

    /// Helper: run one player tick end-to-end.
    fn tick_player(
        sim: &mut SimWorld,
        collider: ColliderHandle,
        pos: &mut Vec3d,
        vel: &mut Vec3d,
        yaw: &mut f64,
        pitch: &mut f64,
        on_ground: &mut bool,
        input: &InputCmd,
        dt: f32,
    ) {
        sim.simulate_tick(collider, pos, vel, yaw, pitch, on_ground, input, dt);
        sim.sync_player_collider(collider, pos);
    }

    #[test]
    fn forward_movement() {
        let mut sim = sim_with_ground();
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        // Settle
        let idle = input();
        for _ in 0..60 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(on_ground, "should be grounded after settling");

        // Walk forward
        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..30 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
        }
        assert!(pos.z > 0.5, "should have moved forward, got z={}", pos.z);
    }

    #[test]
    fn jump_and_gravity() {
        let mut sim = sim_with_ground();
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        // Settle
        let idle = input();
        for _ in 0..120 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(on_ground);
        let ground_y = pos.y;

        // Jump
        let mut jump = input();
        jump.buttons = BTN_JUMP;
        tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &jump, 1.0 / 60.0);
        assert!(vel.y > 0.0, "jump should give positive y velocity");

        // Rise
        let idle = input();
        for _ in 0..10 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }
        assert!(pos.y > ground_y, "should be above ground after jump");
    }

    #[test]
    fn determinism() {
        let run = || {
            let mut sim = sim_with_ground();
            let mut pos = Vec3d::new(0.0, 2.0, 0.0);
            let mut vel = Vec3d::zeros();
            let mut yaw = 0.0;
            let mut pitch = 0.0;
            let mut on_ground = false;
            let collider = sim.create_player_collider(pos, 1);
            sim.rebuild_broad_phase();

            let idle = input();
            for _ in 0..60 {
                tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
            }
            let mut fwd = input();
            fwd.move_y = 127;
            fwd.buttons = BTN_SPRINT;
            for _ in 0..60 {
                tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
            }
            pos
        };

        let p1 = run();
        let p2 = run();
        for i in 0..3 {
            assert!(
                (p1[i] - p2[i]).abs() < 1e-6,
                "position[{i}] diverged: {} vs {}",
                p1[i],
                p2[i],
            );
        }
    }

    #[test]
    fn wall_collision() {
        let mut sim = sim_with_ground();
        sim.add_static_cuboid(
            vector![0.0, 2.5, 3.0],
            vector![10.0, 5.0, 0.5],
            0,
        );
        let mut pos = Vec3d::new(0.0, 2.0, 0.0);
        let mut vel = Vec3d::zeros();
        let mut yaw = 0.0;
        let mut pitch = 0.0;
        let mut on_ground = false;
        let collider = sim.create_player_collider(pos, 1);
        sim.rebuild_broad_phase();

        // Settle
        let idle = input();
        for _ in 0..60 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &idle, 1.0 / 60.0);
        }

        // Walk into wall
        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..120 {
            tick_player(&mut sim, collider, &mut pos, &mut vel, &mut yaw, &mut pitch, &mut on_ground, &fwd, 1.0 / 60.0);
        }

        assert!(pos.z < 3.0, "should be stopped by wall, got z={}", pos.z);
        assert!(pos.z > 0.5, "should have moved toward wall");
    }

    #[test]
    fn raycast_hits_ground() {
        let sim = sim_with_ground();
        let hit = sim.cast_ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 100.0, None);
        assert!(hit.is_some(), "ray should hit ground");
        let toi = hit.unwrap();
        assert!((toi - 5.0).abs() < 0.1, "toi should be ~5.0, got {}", toi);
    }
}
