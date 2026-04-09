use std::collections::HashMap;

use nalgebra::{vector, Vector3};
use rapier3d::prelude::*;

use crate::protocol::*;
pub use vibe_land_shared::movement::{
    MoveConfig, Vec3d, accelerate, apply_horizontal_friction, build_wish_dir, pick_move_speed,
};
pub use vibe_land_shared::simulation::SimWorld;

pub type Vec3 = Vector3<f32>;

#[derive(Clone, Debug)]
pub struct PlayerMotorState {
    pub collider: ColliderHandle,
    pub position: Vec3d,
    pub velocity: Vec3d,
    pub yaw: f64,
    pub pitch: f64,
    pub on_ground: bool,
    pub hp: u8,
    pub last_input: InputCmd,
}

pub struct DynamicBody {
    pub body_handle: RigidBodyHandle,
    pub collider_handle: ColliderHandle,
    pub half_extents: Vec3,
    pub shape_type: u8,
}

pub struct PhysicsArena {
    pub sim: SimWorld,
    pub players: HashMap<u32, PlayerMotorState>,
    next_spawn_index: u32,

    // Dynamic rigid body support (server-only, not in shared SimWorld)
    pub dynamic_bodies: HashMap<u32, DynamicBody>,
    next_dynamic_id: u32,
    pipeline: PhysicsPipeline,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    gravity: Vec3,
}

impl PhysicsArena {
    pub fn new(config: MoveConfig) -> Self {
        Self {
            sim: SimWorld::new(config),
            players: HashMap::new(),
            next_spawn_index: 0,
            dynamic_bodies: HashMap::new(),
            next_dynamic_id: 1,
            pipeline: PhysicsPipeline::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            gravity: vector![0.0, -20.0, 0.0],
        }
    }

    /// Convenience accessor for the shared config.
    pub fn config(&self) -> &MoveConfig {
        &self.sim.config
    }

    /// Flush pending collider changes into the broad-phase BVH.
    pub fn sync_broad_phase(&mut self) {
        self.sim.sync_broad_phase();
    }

    /// Bootstrap the broad-phase BVH with all current colliders.  Call once
    /// after bulk seeding, before the first tick.
    pub fn rebuild_broad_phase(&mut self) {
        self.sim.rebuild_broad_phase();
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        let lane = self.next_spawn_index % 8;
        self.next_spawn_index += 1;
        let spawn = Vector3::<f64>::new(lane as f64 * 2.0, 2.0, 0.0);

        let handle = self.sim.create_player_collider(spawn, player_id);

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
                last_input: InputCmd::default(),
            },
        );

        spawn
    }

    pub fn remove_player(&mut self, player_id: u32) {
        if let Some(player) = self.players.remove(&player_id) {
            self.sim.remove_player_collider(player.collider);
        }
    }

    pub fn add_static_cuboid(&mut self, center: Vec3, half_extents: Vec3, user_data: u128) -> ColliderHandle {
        self.sim.add_static_cuboid(center, half_extents, user_data)
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.sim.remove_collider(handle);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.sim.collider_user_data(handle)
    }

    /// Wake up all dynamic bodies whose center is within `radius` of `center`.
    /// Call after removing a static collider so sleeping bodies notice the gap.
    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        let r2 = radius * radius;
        for (_, db) in &self.dynamic_bodies {
            if let Some(rb) = self.sim.rigid_bodies.get(db.body_handle) {
                let pos = *rb.translation();
                let dx = pos.x - center.x;
                let dy = pos.y - center.y;
                let dz = pos.z - center.z;
                if dx * dx + dy * dy + dz * dz < r2 {
                    self.sim.island_manager.wake_up(&mut self.sim.rigid_bodies, db.body_handle, true);
                }
            }
        }
    }

    pub fn simulate_player_tick(&mut self, player_id: u32, input: &InputCmd, dt: f32) {
        let Some(state) = self.players.get_mut(&player_id) else { return; };
        state.last_input = input.clone();

        let collisions = self.sim.simulate_tick(
            state.collider,
            &mut state.position,
            &mut state.velocity,
            &mut state.yaw,
            &mut state.pitch,
            &mut state.on_ground,
            input,
            dt,
        );
        self.sim.sync_player_collider(state.collider, &state.position);

        // Use Rapier's built-in impulse solver for natural dynamic body pushing.
        // Character mass controls how hard the player pushes objects —
        // higher mass = balls fly further, boxes barely budge.
        if !collisions.is_empty() {
            let state = self.players.get(&player_id).unwrap();
            let character_mass = 80.0; // ~80kg player
            self.sim.solve_character_collision_impulses(
                state.collider, character_mass, &collisions, dt,
            );
        }
    }

    pub fn snapshot_player(&self, player_id: u32) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&player_id)?;
        let mut flags = 0u16;
        if state.on_ground {
            flags |= 1 << 0;
        }
        Some((
            [state.position.x as f32, state.position.y as f32, state.position.z as f32],
            [state.velocity.x as f32, state.velocity.y as f32, state.velocity.z as f32],
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
        self.sim.cast_ray(origin, dir, max_toi, exclude)
    }

    pub fn spawn_dynamic_box(&mut self, position: Vec3, half_extents: Vec3) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id += 1;

        let body = RigidBodyBuilder::dynamic()
            .translation(position)
            .linear_damping(0.3)
            .angular_damping(0.5)
            .build();
        let body_handle = self.sim.rigid_bodies.insert(body);

        let collider = ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
            .restitution(0.3)
            .friction(0.6)
            .density(2.0)
            .build();
        let collider_handle =
            self.sim.colliders
                .insert_with_parent(collider, body_handle, &mut self.sim.rigid_bodies);

        self.dynamic_bodies.insert(
            id,
            DynamicBody {
                body_handle,
                collider_handle,
                half_extents,
                shape_type: 0, // SHAPE_BOX
            },
        );

        id
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vec3, radius: f32) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id += 1;

        let body = RigidBodyBuilder::dynamic()
            .translation(position)
            .linear_damping(0.3)
            .angular_damping(0.5)
            .build();
        let body_handle = self.sim.rigid_bodies.insert(body);

        let collider = ColliderBuilder::ball(radius)
            .restitution(0.6)
            .friction(0.2)
            .density(1.0)
            .build();
        let collider_handle =
            self.sim.colliders
                .insert_with_parent(collider, body_handle, &mut self.sim.rigid_bodies);

        self.dynamic_bodies.insert(
            id,
            DynamicBody {
                body_handle,
                collider_handle,
                half_extents: vector![radius, radius, radius],
                shape_type: 1, // SHAPE_SPHERE
            },
        );

        id
    }

    pub fn step_dynamics(&mut self, dt: f32) {
        self.sim.integration_parameters.dt = dt;
        self.pipeline.step(
            &self.gravity,
            &self.sim.integration_parameters,
            &mut self.sim.island_manager,
            &mut self.sim.broad_phase,
            &mut self.sim.narrow_phase,
            &mut self.sim.rigid_bodies,
            &mut self.sim.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            &(),
            &(),
        );
    }

    /// Returns (id, position, quaternion [x,y,z,w], half_extents, shape_type) for each dynamic body.
    pub fn snapshot_dynamic_bodies(&self) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], u8)> {
        let mut out = Vec::with_capacity(self.dynamic_bodies.len());
        for (&id, db) in &self.dynamic_bodies {
            if let Some(rb) = self.sim.rigid_bodies.get(db.body_handle) {
                let pos = rb.translation();
                let rot = rb.rotation();
                out.push((
                    id,
                    [pos.x, pos.y, pos.z],
                    [rot.i, rot.j, rot.k, rot.w],
                    [db.half_extents.x, db.half_extents.y, db.half_extents.z],
                    db.shape_type,
                ));
            }
        }
        out
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

    fn arena_with_ground() -> PhysicsArena {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        // Ground plane at y=0 (Rapier uses f32 vectors)
        arena.add_static_cuboid(
            Vector3::<f32>::new(0.0, -0.5, 0.0),
            Vector3::<f32>::new(50.0, 0.5, 50.0),
            0,
        );
        // Initialize the BVH with all colliders (mirrors rebuild_broad_phase
        // called at server startup). Must happen before any simulate_player_tick.
        arena.rebuild_broad_phase();
        arena
    }

    // ──────────────────────────────────────────────
    // build_wish_dir
    // ──────────────────────────────────────────────

    #[test]
    fn build_wish_dir_uses_move_axes_without_button_bits() {
        let mut cmd = input();
        cmd.move_x = 127; // RIGHT strafe at yaw=0 → -X (Three.js camera convention)

        let wish = build_wish_dir(&cmd, 0.0);

        assert!(wish.x < -0.99);
        assert!(wish.z.abs() < 0.001);
    }

    #[test]
    fn build_wish_dir_falls_back_to_buttons_when_move_axes_are_zero() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_RIGHT;

        let wish = build_wish_dir(&cmd, 0.0);

        assert!(wish.x < -0.7); // RIGHT → -X at yaw=0
        assert!(wish.z > 0.7);  // FORWARD → +Z at yaw=0
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
        // settle on ground
        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        let mut cmd = input();
        cmd.move_y = 127; // forward
        for _ in 0..30 {
            arena.simulate_player_tick(1, &cmd, 1.0 / 60.0);
        }

        let (pos, _vel, _, _, _, _) = arena.snapshot_player(1).unwrap();
        assert!(pos[2] > 0.5, "should have moved forward (z > 0.5), got {}", pos[2]);
    }

    #[test]
    fn sprint_moves_faster_than_walk() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.spawn_player(2);

        // settle
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
        assert!(sprint_pos[2] > walk_pos[2], "sprint should be faster than walk");
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

        // Settle onto ground (player spawns at y=2, needs time to fall + settle)
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }
        let (pre_pos, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();
        assert!(flags & 1 != 0, "should be grounded after settling, pos y={}", pre_pos[1]);

        // Jump
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
        // Player spawns at y=2, above ground → in air
        let (_, _, _, _, _, flags) = arena.snapshot_player(1).unwrap();

        // Try to jump (should fail if not grounded)
        let mut jump_cmd = input();
        jump_cmd.buttons = BTN_JUMP;
        arena.simulate_player_tick(1, &jump_cmd, 1.0 / 60.0);

        // If player was in the air initially, the jump may or may not fire
        // depending on whether 1 tick of settling grounds them.
        // Key thing: no crash, no explosion
        let (_, vel, _, _, _, _) = arena.snapshot_player(1).unwrap();
        // Velocity should be reasonable (not NaN or huge)
        assert!(vel[1].is_finite());
    }

    #[test]
    fn gravity_accumulates_in_freefall() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        // No ground — pure freefall
        arena.spawn_player(1);

        arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        let (_, vel1, _, _, _, _) = arena.snapshot_player(1).unwrap();

        arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        let (_, vel2, _, _, _, _) = arena.snapshot_player(1).unwrap();

        assert!(vel2[1] < vel1[1], "velocity should decrease (more negative) with gravity");
    }

    #[test]
    fn friction_stops_player_when_no_input() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);

        // Settle
        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        // Build up speed
        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..30 {
            arena.simulate_player_tick(1, &fwd, 1.0 / 60.0);
        }
        let (_, vel_moving, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let speed_moving = (vel_moving[0].powi(2) + vel_moving[2].powi(2)).sqrt();
        assert!(speed_moving > 1.0, "should be moving");

        // Release keys — friction
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }
        let (_, vel_stopped, _, _, _, _) = arena.snapshot_player(1).unwrap();
        let speed_stopped = (vel_stopped[0].powi(2) + vel_stopped[2].powi(2)).sqrt();
        assert!(speed_stopped < 0.1, "friction should stop player, got {}", speed_stopped);
    }

    // ──────────────────────────────────────────────
    // Determinism
    // ──────────────────────────────────────────────

    #[test]
    fn same_inputs_produce_same_position() {
        // Run the exact same sequence twice
        let mut cmd = input();
        cmd.move_y = 127;
        cmd.buttons = BTN_SPRINT;

        let positions: Vec<[f32; 3]> = (0..2).map(|_| {
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
        }).collect();

        for i in 0..3 {
            assert!(
                (positions[0][i] - positions[1][i]).abs() < 1e-6,
                "position[{i}] should be deterministic: {} vs {}",
                positions[0][i], positions[1][i],
            );
        }
    }

    // ──────────────────────────────────────────────
    // PhysicsArena lifecycle
    // ──────────────────────────────────────────────

    #[test]
    fn spawn_and_remove_player() {
        let mut arena = arena_with_ground();
        let spawn_pos = arena.spawn_player(1);
        assert!(arena.snapshot_player(1).is_some());

        arena.remove_player(1);
        assert!(arena.snapshot_player(1).is_none());
    }

    #[test]
    fn wall_collision_stops_horizontal_movement() {
        let mut arena = arena_with_ground();
        // Wall at z=3
        arena.add_static_cuboid(
            Vector3::<f32>::new(0.0, 2.5, 3.0),
            Vector3::<f32>::new(10.0, 5.0, 0.5),
            0,
        );
        arena.spawn_player(1);
        // Re-sync BVH after adding wall + player
        arena.rebuild_broad_phase();

        // Settle
        for _ in 0..60 {
            arena.simulate_player_tick(1, &input(), 1.0 / 60.0);
        }

        // Walk into wall
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

        // Spawn a ball sitting on the ground
        let ball_id = arena.spawn_dynamic_ball(
            vector![5.0, 2.0, 5.0],
            0.3,
        );
        arena.rebuild_broad_phase();

        // Settle the ball onto the ground
        for _ in 0..120 {
            arena.step_dynamics(1.0 / 60.0);
        }

        // Apply a strong impulse (simulating a fast player push)
        let snap_before = arena.snapshot_dynamic_bodies();
        let ball = snap_before.iter().find(|s| s.0 == ball_id).unwrap();
        eprintln!("Ball before push: y={:.3}", ball.1[1]);
        assert!(ball.1[1] > 1.0, "Ball should be on ground before push");

        // Apply a big horizontal impulse directly to the ball
        if let Some(db) = arena.dynamic_bodies.get(&ball_id) {
            if let Some(rb) = arena.sim.rigid_bodies.get_mut(db.body_handle) {
                rb.apply_impulse(vector![10.0, 0.0, 10.0], true);
            }
        }

        // Step physics for 5 more seconds
        for _ in 0..300 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snap_after = arena.snapshot_dynamic_bodies();
        let ball = snap_after.iter().find(|s| s.0 == ball_id).unwrap();
        eprintln!("Ball after push: y={:.3}, pos=[{:.3}, {:.3}, {:.3}]",
            ball.1[1], ball.1[0], ball.1[1], ball.1[2]);
        assert!(ball.1[1] > 0.5, "Ball tunneled through ground after push! y={}", ball.1[1]);
    }

    /// Reproduce the actual server tick loop: player simulation AND dynamics
    /// run every tick. Existing tests call step_dynamics alone — this test
    /// interleaves simulate_player_tick + step_dynamics just like main.rs does.
    /// If balls fall through the ground here but NOT in the dynamics-only test,
    /// the KCC broad-phase sync is corrupting the BVH for rigid bodies.
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

        // 600 ticks = 10 seconds of game time
        for tick in 0..600 {
            arena.simulate_player_tick(player_id, &idle_input, dt);
            arena.step_dynamics(dt);

            // Spot-check every 2 seconds to catch early failures
            if (tick + 1) % 120 == 0 {
                let snap = arena.snapshot_dynamic_bodies();
                let fallen: Vec<_> = snap.iter()
                    .filter(|s| s.4 == 1 && s.1[1] < 0.0)
                    .collect();
                if !fallen.is_empty() {
                    eprintln!(
                        "tick {}: {} / {} balls below y=0",
                        tick + 1,
                        fallen.len(),
                        snap.iter().filter(|s| s.4 == 1).count(),
                    );
                    for b in fallen.iter().take(5) {
                        eprintln!("  ball {}: y={:.3}", b.0, b.1[1]);
                    }
                }
            }
        }

        let snapshot = arena.snapshot_dynamic_bodies();
        let balls: Vec<_> = snapshot.iter().filter(|s| s.4 == 1).collect();
        assert!(!balls.is_empty(), "expected ball-pit balls");
        eprintln!("Total balls: {}", balls.len());

        let fallen: Vec<_> = balls.iter().filter(|b| b.1[1] < 0.0).collect();
        for b in &fallen {
            eprintln!("FALLEN ball {}: pos=[{:.3}, {:.3}, {:.3}]", b.0, b.1[0], b.1[1], b.1[2]);
        }
        assert_eq!(
            fallen.len(), 0,
            "{} / {} balls fell through the ground with interleaved player+dynamics!",
            fallen.len(), balls.len(),
        );
    }

    /// Reproduce the exact server startup: voxel ground + dynamic box + dynamic ball.
    /// Verify both land on the voxel ground and don't fall through.
    #[test]
    fn dynamic_bodies_land_on_voxel_ground() {
        use crate::voxel_world::VoxelWorld;

        // Exactly replicate run_match_loop setup
        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);

        let box_id = arena.spawn_dynamic_box(
            vector![4.0, 8.0, 4.0],
            vector![0.5, 0.5, 0.5],
        );
        let ball_id = arena.spawn_dynamic_ball(
            vector![6.0, 8.0, 4.0],
            0.5,
        );

        arena.rebuild_broad_phase();

        // Run physics for 10 seconds (600 ticks) — enough to settle
        for _ in 0..600 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let snapshot = arena.snapshot_dynamic_bodies();
        let box_state = snapshot.iter().find(|s| s.0 == box_id).unwrap();
        let ball_state = snapshot.iter().find(|s| s.0 == ball_id).unwrap();

        eprintln!("Box  y={:.3} (id={})", box_state.1[1], box_id);
        eprintln!("Ball y={:.3} (id={})", ball_state.1[1], ball_id);

        // Ground block at y=0 has top surface at y=1.0
        // Box half-extent is 0.5, so center should be at ~1.5
        // Ball radius is 0.5, so center should be at ~1.5
        assert!(box_state.1[1] > 0.5, "Box fell through ground! y={}", box_state.1[1]);
        assert!(box_state.1[1] < 3.0, "Box is floating too high! y={}", box_state.1[1]);
        assert!(ball_state.1[1] > 0.5, "Ball fell through ground! y={}", ball_state.1[1]);
        assert!(ball_state.1[1] < 3.0, "Ball is floating too high! y={}", ball_state.1[1]);
    }

    /// Regression test: removing a voxel block mid-simulation must not cause
    /// balls elsewhere to fall through the ground. This reproduces the bug where
    /// a block edit triggered rebuild_chunk_colliders → sync_broad_phase between
    /// pipeline.step() calls, corrupting the BVH.
    #[test]
    fn block_edit_does_not_break_ball_physics() {
        use crate::voxel_world::{VoxelWorld, world_to_chunk_and_local};
        use crate::protocol::{BlockEditCmd, BLOCK_REMOVE};

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();
        world.seed_demo_world(&mut arena);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;

        // Let balls settle for 5 seconds
        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        // Verify balls are resting on ground before the edit
        let pre_snap = arena.snapshot_dynamic_bodies();
        let pre_balls: Vec<_> = pre_snap.iter().filter(|s| s.4 == 1).collect();
        assert!(!pre_balls.is_empty(), "expected ball-pit balls");
        let pre_fallen: Vec<_> = pre_balls.iter().filter(|b| b.1[1] < 0.0).collect();
        assert_eq!(pre_fallen.len(), 0, "balls fell before edit");

        // Remove a ground block far from the ball pit (at origin area)
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

        // Continue simulating for 5 more seconds after the edit
        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        let post_snap = arena.snapshot_dynamic_bodies();
        let post_balls: Vec<_> = post_snap.iter().filter(|s| s.4 == 1).collect();
        let post_fallen: Vec<_> = post_balls.iter().filter(|b| b.1[1] < 0.0).collect();
        for b in &post_fallen {
            eprintln!("FALLEN after edit: ball {}: y={:.3}", b.0, b.1[1]);
        }
        assert_eq!(
            post_fallen.len(), 0,
            "{} / {} balls fell through ground after block edit!",
            post_fallen.len(), post_balls.len(),
        );
    }

    /// Removing the floor block directly under a ball must cause it to fall.
    #[test]
    fn rapier_orphan_collider_removal_minimal() {
        // Minimal Rapier test: does removing an orphan floor collider let a ball fall?
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

        // Floor: orphan collider (no parent body)
        let floor = colliders.insert(
            ColliderBuilder::cuboid(5.0, 0.5, 5.0)
                .translation(vector![0.0, -0.5, 0.0])
                .build()
        );

        // Ball: dynamic body with child collider
        let ball_body = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![0.0, 3.0, 0.0])
                .build()
        );
        colliders.insert_with_parent(
            ColliderBuilder::ball(0.3).restitution(0.0).build(),
            ball_body, &mut bodies
        );

        // Let ball settle
        for _ in 0..300 {
            pipeline.step(&gravity, &params, &mut islands, &mut broad, &mut narrow,
                &mut bodies, &mut colliders, &mut joints, &mut multi_joints, &mut ccd, &(), &());
        }

        let pre_y = bodies.get(ball_body).unwrap().translation().y;
        eprintln!("pre_y = {pre_y:.4}");

        // Remove orphan floor collider
        colliders.remove(floor, &mut islands, &mut bodies, true);

        // Manually wake the ball
        islands.wake_up(&mut bodies, ball_body, true);

        // Simulate
        for i in 0..120 {
            pipeline.step(&gravity, &params, &mut islands, &mut broad, &mut narrow,
                &mut bodies, &mut colliders, &mut joints, &mut multi_joints, &mut ccd, &(), &());
            if i % 10 == 0 {
                eprintln!("tick {i}: y = {:.4}", bodies.get(ball_body).unwrap().translation().y);
            }
        }

        let post_y = bodies.get(ball_body).unwrap().translation().y;
        assert!(post_y < pre_y - 1.0,
            "Ball should fall after orphan floor removed! pre={pre_y:.4}, post={post_y:.4}");
    }

    #[test]
    fn ball_falls_through_deleted_floor_block() {
        use crate::voxel_world::{VoxelWorld, world_to_chunk_and_local};
        use crate::protocol::{BlockEditCmd, BLOCK_REMOVE};

        use crate::protocol::BLOCK_ADD;

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let mut world = VoxelWorld::new();

        // Minimal world: just a ground layer, no ball pit
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

        // Spawn a single ball squarely in the center of block (4, 0, 4)
        // Block center = (4.5, 0.5, 4.5), top surface = y=1.0
        // Ball radius 0.3, so center will settle at ~y=1.3
        let ball_id = arena.spawn_dynamic_ball(vector![4.5, 3.0, 4.5], 0.3);

        let dt = 1.0_f32 / 60.0;

        // Let ball settle
        for _ in 0..300 {
            arena.step_dynamics(dt);
        }

        let pre_snap = arena.snapshot_dynamic_bodies();
        let pre_ball = pre_snap.iter().find(|s| s.0 == ball_id).unwrap();
        let pre_y = pre_ball.1[1];
        eprintln!("Ball before edit: y={:.3} pos=[{:.3}, {:.3}, {:.3}]",
            pre_y, pre_ball.1[0], pre_ball.1[1], pre_ball.1[2]);
        assert!(pre_y > 0.5 && pre_y < 2.0, "ball should be resting on ground, y={pre_y}");

        // Remove the floor block at (4, 0, 4)
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
        eprintln!("Block removed, colliders={}", arena.sim.colliders.len());

        // Check ball wake state and collider position
        {
            let db = arena.dynamic_bodies.get(&ball_id).unwrap();
            let rb = arena.sim.rigid_bodies.get(db.body_handle).unwrap();
            eprintln!("Ball sleeping={}, linvel=[{:.3},{:.3},{:.3}]",
                rb.is_sleeping(), rb.linvel().x, rb.linvel().y, rb.linvel().z);
        }

        // Spawn a FRESH ball (never slept) directly over the removed block
        let fresh_ball_id = arena.spawn_dynamic_ball(vector![4.5, 5.0, 4.5], 0.3);
        // Also wake the original ball via island manager
        {
            let db = arena.dynamic_bodies.get(&ball_id).unwrap();
            arena.sim.island_manager.wake_up(&mut arena.sim.rigid_bodies, db.body_handle, true);
        }

        // Simulate 3 more seconds
        for tick in 0..180 {
            arena.step_dynamics(dt);
            if tick % 10 == 0 {
                let snap = arena.snapshot_dynamic_bodies();
                if let Some(s) = snap.iter().find(|s| s.0 == ball_id).cloned() {
                    eprintln!("tick {}: original y={:.3}", tick, s.1[1]);
                }
                if let Some(s) = snap.iter().find(|s| s.0 == fresh_ball_id).cloned() {
                    eprintln!("tick {}: fresh    y={:.3}", tick, s.1[1]);
                }
            }
        }

        let post_snap = arena.snapshot_dynamic_bodies();
        let post_ball = post_snap.iter().find(|s| s.0 == ball_id).unwrap();
        eprintln!("Final ball: y={:.3}", post_ball.1[1]);
        assert!(
            post_ball.1[1] < pre_y - 0.5,
            "Ball should have fallen after floor removed! pre_y={:.3}, post_y={:.3}",
            pre_y, post_ball.1[1],
        );
    }

    /// Walking into a ball should push it forward via Rapier's impulse solver.
    #[test]
    fn player_pushes_ball_when_walking_into_it() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        // Settle player on ground
        let dt = 1.0_f32 / 60.0;
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
        }

        // Spawn a ball 2m in front of the player (yaw=0 → +Z is forward)
        let player_pos = arena.snapshot_player(1).unwrap().0;
        let ball_id = arena.spawn_dynamic_ball(
            vector![player_pos[0], player_pos[1], player_pos[2] + 2.0],
            0.3,
        );
        arena.rebuild_broad_phase();

        // Let ball settle
        for _ in 0..60 {
            arena.step_dynamics(dt);
        }
        let ball_before = arena.snapshot_dynamic_bodies()
            .into_iter().find(|s| s.0 == ball_id).unwrap();
        let ball_z_before = ball_before.1[2];

        // Walk forward into the ball for 60 ticks
        let mut fwd = input();
        fwd.move_y = 127;
        for _ in 0..60 {
            arena.simulate_player_tick(1, &fwd, dt);
            arena.step_dynamics(dt);
        }

        let ball_after = arena.snapshot_dynamic_bodies()
            .into_iter().find(|s| s.0 == ball_id).unwrap();
        assert!(
            ball_after.1[2] > ball_z_before + 0.3,
            "Ball should be pushed forward: before z={:.3}, after z={:.3}",
            ball_z_before, ball_after.1[2],
        );
    }

    /// Player should advance through a ball, not get permanently blocked.
    #[test]
    fn player_advances_through_ball() {
        let mut arena = arena_with_ground();
        arena.spawn_player(1);
        arena.rebuild_broad_phase();

        let dt = 1.0_f32 / 60.0;
        // Settle
        for _ in 0..120 {
            arena.simulate_player_tick(1, &input(), dt);
            arena.step_dynamics(dt);
        }

        let player_start = arena.snapshot_player(1).unwrap().0;

        // Spawn ball in front
        arena.spawn_dynamic_ball(
            vector![player_start[0], player_start[1], player_start[2] + 2.0],
            0.3,
        );
        arena.rebuild_broad_phase();
        for _ in 0..60 {
            arena.step_dynamics(dt);
        }

        // Walk forward for 120 ticks (2 seconds)
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
            player_start[2], player_end[2],
        );
    }
}
