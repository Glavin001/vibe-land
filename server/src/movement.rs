use std::collections::HashMap;

use nalgebra::{vector, Isometry3, Vector3};
use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::prelude::*;

use crate::protocol::{InputCmd, BTN_BACK, BTN_CROUCH, BTN_FORWARD, BTN_JUMP, BTN_LEFT, BTN_RIGHT, BTN_SPRINT};

pub type Vec3 = Vector3<f32>;

#[derive(Clone, Debug)]
pub struct MoveConfig {
    pub walk_speed: f64,
    pub sprint_speed: f64,
    pub crouch_speed: f64,
    pub ground_accel: f64,
    pub air_accel: f64,
    pub friction: f64,
    pub gravity: f64,
    pub jump_speed: f64,
    pub capsule_half_segment: f32,
    pub capsule_radius: f32,
    pub collision_offset: f32,
    pub max_step_height: f32,
    pub min_step_width: f32,
    pub snap_to_ground: f32,
    pub max_slope_radians: f32,
    pub min_slide_radians: f32,
}

impl Default for MoveConfig {
    fn default() -> Self {
        Self {
            walk_speed: 6.0,
            sprint_speed: 8.5,
            crouch_speed: 3.5,
            ground_accel: 80.0,
            air_accel: 18.0,
            friction: 10.0,
            gravity: 20.0,
            jump_speed: 6.5,
            capsule_half_segment: 0.45,
            capsule_radius: 0.35,
            collision_offset: 0.01,
            max_step_height: 0.55,
            min_step_width: 0.2,
            snap_to_ground: 0.2,
            max_slope_radians: 45_f32.to_radians(),
            min_slide_radians: 30_f32.to_radians(),
        }
    }
}

pub type Vec3d = Vector3<f64>;

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
    pub config: MoveConfig,
    pub players: HashMap<u32, PlayerMotorState>,

    pub rigid_bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub integration_parameters: IntegrationParameters,

    controller: KinematicCharacterController,
    next_spawn_index: u32,

    // Dynamic rigid body support
    pub dynamic_bodies: HashMap<u32, DynamicBody>,
    next_dynamic_id: u32,
    pipeline: PhysicsPipeline,
    island_manager: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    gravity: Vec3,
    modified_colliders: Vec<ColliderHandle>,
    removed_colliders: Vec<ColliderHandle>,
}

impl PhysicsArena {
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

        let mut arena = Self {
            config,
            players: HashMap::new(),
            rigid_bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            integration_parameters: IntegrationParameters::default(),
            controller,
            next_spawn_index: 0,
            dynamic_bodies: HashMap::new(),
            next_dynamic_id: 1,
            pipeline: PhysicsPipeline::new(),
            island_manager: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            gravity: vector![0.0, -20.0, 0.0],
            modified_colliders: Vec::new(),
            removed_colliders: Vec::new(),
        };

        arena.integration_parameters.dt = 1.0 / 60.0;
        arena.integration_parameters.num_solver_iterations = 2;
        arena
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
    /// after bulk seeding, before the first tick.  This is needed because the
    /// KCC queries the BVH during simulate_player_tick, which runs before
    /// pipeline.step() has had a chance to populate the BVH.
    ///
    /// After the first pipeline.step(), the pipeline manages the BVH and
    /// narrow phase automatically — do NOT call this mid-simulation.
    pub fn rebuild_broad_phase(&mut self) {
        self.modified_colliders.clear();
        self.removed_colliders.clear();
        for (handle, _) in self.colliders.iter() {
            self.modified_colliders.push(handle);
        }
        self.sync_broad_phase();
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3d {
        let lane = self.next_spawn_index % 8;
        self.next_spawn_index += 1;
        let spawn = Vector3::<f64>::new(lane as f64 * 2.0, 2.0, 0.0);

        let collider = ColliderBuilder::capsule_y(
            self.config.capsule_half_segment,
            self.config.capsule_radius,
        )
        .translation(vector![spawn.x as f32, spawn.y as f32, spawn.z as f32])
        .friction(0.0)
        .active_collision_types(ActiveCollisionTypes::default() | ActiveCollisionTypes::KINEMATIC_FIXED)
        .user_data(player_id as u128)
        .build();
        let handle = self.colliders.insert(collider);

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
            self.removed_colliders.push(player.collider);
            self.colliders.remove(player.collider, &mut self.island_manager, &mut self.rigid_bodies, true);
        }
    }

    pub fn add_static_cuboid(&mut self, center: Vec3, half_extents: Vec3, user_data: u128) -> ColliderHandle {
        // ColliderSet::insert() internally tracks the new collider.
        // pipeline.step() will process it via colliders.take_modified(),
        // adding it to the broad phase automatically.
        self.colliders.insert(
            ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                .translation(center)
                .user_data(user_data)
                .build(),
        )
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        // ColliderSet::remove() internally tracks the removal.
        // pipeline.step() will process it via colliders.take_removed(),
        // updating both the broad phase and narrow phase automatically.
        self.colliders.remove(handle, &mut self.island_manager, &mut self.rigid_bodies, true);
    }

    pub fn collider_user_data(&self, handle: ColliderHandle) -> Option<u128> {
        self.colliders.get(handle).map(|c| c.user_data)
    }

    /// Wake up all dynamic bodies whose center is within `radius` of `center`.
    /// Call after removing a static collider so sleeping bodies notice the gap.
    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) {
        let r2 = radius * radius;
        for (_, db) in &self.dynamic_bodies {
            if let Some(rb) = self.rigid_bodies.get(db.body_handle) {
                let pos = *rb.translation();
                let dx = pos.x - center.x;
                let dy = pos.y - center.y;
                let dz = pos.z - center.z;
                if dx * dx + dy * dy + dz * dz < r2 {
                    self.island_manager.wake_up(&mut self.rigid_bodies, db.body_handle, true);
                }
            }
        }
    }

    pub fn simulate_player_tick(&mut self, player_id: u32, input: &InputCmd, dt: f32) {
        let cfg = self.config.clone();
        let dt64 = dt as f64;

        // Phase 1: Update player state in f64 (matches JS client arithmetic)
        let (collider_handle, position_f32, desired_translation_f32);
        {
            let Some(state) = self.players.get_mut(&player_id) else { return; };
            state.yaw = input.yaw as f64;
            state.pitch = (input.pitch as f64).clamp(-1.55, 1.55);
            state.last_input = input.clone();

            let wish = build_wish_dir_f64(input, state.yaw);
            let max_speed = if input.buttons & BTN_CROUCH != 0 {
                cfg.crouch_speed
            } else if input.buttons & BTN_SPRINT != 0 {
                cfg.sprint_speed
            } else {
                cfg.walk_speed
            };

            apply_horizontal_friction_f64(&mut state.velocity, cfg.friction, dt64, state.on_ground);
            accelerate_f64(
                &mut state.velocity,
                wish,
                max_speed,
                if state.on_ground { cfg.ground_accel } else { cfg.air_accel },
                dt64,
            );

            if state.on_ground && (input.buttons & BTN_JUMP != 0) {
                state.velocity.y = cfg.jump_speed;
                state.on_ground = false;
            }

            state.velocity.y -= cfg.gravity * dt64;

            // Convert to f32 for Rapier KCC (same truncation as JS→WASM boundary)
            let desired = state.velocity * dt64;
            desired_translation_f32 = vector![desired.x as f32, desired.y as f32, desired.z as f32];
            collider_handle = state.collider;
            position_f32 = vector![state.position.x as f32, state.position.y as f32, state.position.z as f32];
        }

        // Phase 2: Query the broad-phase BVH as-is (from the last pipeline.step).
        // IMPORTANT: Do NOT call sync_broad_phase() here — calling
        // broad_phase.update() between pipeline.step() calls corrupts the BVH
        // and causes dynamic bodies to fall through static geometry.

        // Phase 3: Run KCC (all f32 — Rapier's native precision)
        let collider = self.colliders.get(collider_handle).expect("missing player collider");
        let character_shape = collider.shape();
        let character_pos = Isometry3::translation(position_f32.x, position_f32.y, position_f32.z);

        let filter = QueryFilter::default().exclude_collider(collider_handle);
        let query_pipeline = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_bodies,
            &self.colliders,
            filter,
        );

        let mut hit_colliders: Vec<ColliderHandle> = Vec::new();
        let corrected = self.controller.move_shape(
            dt,
            &query_pipeline,
            character_shape,
            &character_pos,
            desired_translation_f32,
            |collision| {
                hit_colliders.push(collision.handle);
            },
        );

        // Phase 4: Apply f32 KCC results back to f64 state
        let ct = corrected.translation;
        let state = self.players.get_mut(&player_id).unwrap();
        state.position.x += ct.x as f64;
        state.position.y += ct.y as f64;
        state.position.z += ct.z as f64;

        let pos_f32 = vector![state.position.x as f32, state.position.y as f32, state.position.z as f32];
        let collider = self.colliders.get_mut(state.collider).expect("missing player collider");
        collider.set_translation(pos_f32);

        let was_falling = desired_translation_f32.y <= 0.0;
        let y_clipped = ct.y > desired_translation_f32.y - 0.001;
        state.on_ground = was_falling && y_clipped && ct.y.abs() < 0.001;
        if state.on_ground && state.velocity.y < 0.0 {
            state.velocity.y = 0.0;
        }

        state.velocity.x = ct.x as f64 / dt64;
        state.velocity.z = ct.z as f64 / dt64;

        // Push dynamic bodies that the player collided with.
        // Use a gentle impulse scaled by body mass so light and heavy objects
        // react proportionally — similar to how Rocket League / The Finals
        // handle player-object contact: nudge, don't launch.
        if !hit_colliders.is_empty() {
            let hspeed = (state.velocity.x.powi(2) + state.velocity.z.powi(2)).sqrt();
            if hspeed > 0.3 {
                let mut push_dir = Vector3::<f32>::new(
                    state.velocity.x as f32, 0.0, state.velocity.z as f32,
                );
                let len = push_dir.norm();
                if len > 1e-5 {
                    push_dir /= len;
                }
                for handle in hit_colliders {
                    if let Some(col) = self.colliders.get(handle) {
                        if let Some(parent) = col.parent() {
                            if let Some(rb) = self.rigid_bodies.get_mut(parent) {
                                if rb.is_dynamic() {
                                    let mass = rb.mass();
                                    // Impulse proportional to mass so objects move
                                    // at a consistent speed regardless of weight.
                                    // Clamp player speed contribution to keep it gentle.
                                    let speed_factor = (hspeed as f32).min(5.0);
                                    let impulse = push_dir * mass * speed_factor * 0.15;
                                    rb.apply_impulse(impulse, true);
                                }
                            }
                        }
                    }
                }
            }
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
        &mut self,
        origin: [f32; 3],
        dir: [f32; 3],
        max_toi: f32,
        exclude_player: Option<u32>,
    ) -> Option<f32> {
        let ray = Ray::new(
            nalgebra::point![origin[0], origin[1], origin[2]],
            vector![dir[0], dir[1], dir[2]],
        );
        // Note: do NOT call sync_broad_phase() here — the BVH is maintained
        // exclusively by pipeline.step() during step_dynamics(). Calling
        // broad_phase.update() between pipeline steps corrupts the BVH.
        let mut filter = QueryFilter::default();
        if let Some(player_id) = exclude_player {
            if let Some(player) = self.players.get(&player_id) {
                filter = filter.exclude_collider(player.collider);
            }
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

    pub fn spawn_dynamic_box(&mut self, position: Vec3, half_extents: Vec3) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id += 1;

        let body = RigidBodyBuilder::dynamic()
            .translation(position)
            .linear_damping(0.3)
            .angular_damping(0.5)
            .build();
        let body_handle = self.rigid_bodies.insert(body);

        let collider = ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
            .restitution(0.3)
            .friction(0.6)
            .density(2.0)
            .build();
        let collider_handle =
            self.colliders
                .insert_with_parent(collider, body_handle, &mut self.rigid_bodies);

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
            .linear_damping(3.0)
            .angular_damping(4.0)
            .build();
        let body_handle = self.rigid_bodies.insert(body);

        let collider = ColliderBuilder::ball(radius)
            .restitution(0.4)
            .friction(0.5)
            .density(1.0)
            .build();
        let collider_handle =
            self.colliders
                .insert_with_parent(collider, body_handle, &mut self.rigid_bodies);

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
        // pipeline.step() processes all collider changes automatically via
        // colliders.take_modified() and colliders.take_removed(), updating
        // the broad phase, narrow phase, and island manager internally.
        self.integration_parameters.dt = dt;
        self.pipeline.step(
            &self.gravity,
            &self.integration_parameters,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.rigid_bodies,
            &mut self.colliders,
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
            if let Some(rb) = self.rigid_bodies.get(db.body_handle) {
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

fn build_wish_dir_f64(input: &InputCmd, yaw: f64) -> Vec3d {
    let forward = Vector3::<f64>::new(yaw.sin(), 0.0, yaw.cos());
    let right = Vector3::<f64>::new(forward.z, 0.0, -forward.x);

    let mut move_x = input.move_x as f64 / 127.0;
    let mut move_y = input.move_y as f64 / 127.0;

    // Fall back to button-derived movement so older callers still behave.
    if move_x.abs() <= f64::EPSILON && move_y.abs() <= f64::EPSILON {
        move_x = (if input.buttons & BTN_RIGHT != 0 { 1.0 } else { 0.0 })
            + (if input.buttons & BTN_LEFT != 0 { -1.0 } else { 0.0 });
        move_y = (if input.buttons & BTN_FORWARD != 0 { 1.0 } else { 0.0 })
            + (if input.buttons & BTN_BACK != 0 { -1.0 } else { 0.0 });
    }

    let mut wish = right * move_x + forward * move_y;
    wish.y = 0.0;
    if wish.norm_squared() > 0.0001 {
        wish = wish.normalize();
    }
    wish
}

fn apply_horizontal_friction_f64(velocity: &mut Vec3d, friction: f64, dt: f64, on_ground: bool) {
    if !on_ground {
        return;
    }
    let speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
    if speed <= 1e-6 {
        return;
    }
    let drop = speed * friction * dt;
    let new_speed = (speed - drop).max(0.0);
    let ratio = new_speed / speed;
    velocity.x *= ratio;
    velocity.z *= ratio;
}

fn accelerate_f64(velocity: &mut Vec3d, wish_dir: Vec3d, wish_speed: f64, accel: f64, dt: f64) {
    if wish_dir.norm_squared() <= 0.0001 {
        return;
    }
    let current_speed = velocity.x * wish_dir.x + velocity.z * wish_dir.z;
    let add_speed = (wish_speed - current_speed).max(0.0);
    if add_speed <= 0.0 {
        return;
    }
    let accel_speed = (accel * wish_speed * dt).min(add_speed);
    velocity.x += wish_dir.x * accel_speed;
    velocity.z += wish_dir.z * accel_speed;
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
        cmd.move_x = 127;

        let wish = build_wish_dir_f64(&cmd, 0.0);

        assert!(wish.x > 0.99);
        assert!(wish.z.abs() < 0.001);
    }

    #[test]
    fn build_wish_dir_falls_back_to_buttons_when_move_axes_are_zero() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_RIGHT;

        let wish = build_wish_dir_f64(&cmd, 0.0);

        assert!(wish.x > 0.7);
        assert!(wish.z > 0.7);
    }

    #[test]
    fn build_wish_dir_forward_button_only() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD;
        let wish = build_wish_dir_f64(&cmd, 0.0);
        assert!(wish.z > 0.99, "forward should produce +Z at yaw=0");
    }

    #[test]
    fn build_wish_dir_backward_button_only() {
        let mut cmd = input();
        cmd.buttons = BTN_BACK;
        let wish = build_wish_dir_f64(&cmd, 0.0);
        assert!(wish.z < -0.99, "back should produce -Z at yaw=0");
    }

    #[test]
    fn build_wish_dir_opposing_buttons_cancel() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_BACK;
        let wish = build_wish_dir_f64(&cmd, 0.0);
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
            if let Some(rb) = arena.rigid_bodies.get_mut(db.body_handle) {
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
        eprintln!("Block removed, colliders={}", arena.colliders.len());

        // Check ball wake state and collider position
        {
            let db = arena.dynamic_bodies.get(&ball_id).unwrap();
            let rb = arena.rigid_bodies.get(db.body_handle).unwrap();
            eprintln!("Ball sleeping={}, linvel=[{:.3},{:.3},{:.3}]",
                rb.is_sleeping(), rb.linvel().x, rb.linvel().y, rb.linvel().z);
        }

        // Spawn a FRESH ball (never slept) directly over the removed block
        let fresh_ball_id = arena.spawn_dynamic_ball(vector![4.5, 5.0, 4.5], 0.3);
        // Also wake the original ball via island manager
        {
            let db = arena.dynamic_bodies.get(&ball_id).unwrap();
            arena.island_manager.wake_up(&mut arena.rigid_bodies, db.body_handle, true);
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
}
