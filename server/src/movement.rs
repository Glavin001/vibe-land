use std::collections::HashMap;

use nalgebra::{vector, Isometry3, Vector3};
use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::pipeline::QueryPipeline;
use rapier3d::prelude::*;

use crate::protocol::{InputCmd, BTN_BACK, BTN_CROUCH, BTN_FORWARD, BTN_JUMP, BTN_LEFT, BTN_RIGHT, BTN_SPRINT};

pub type Vec3 = Vector3<f32>;

#[derive(Clone, Debug)]
pub struct MoveConfig {
    pub walk_speed: f32,
    pub sprint_speed: f32,
    pub crouch_speed: f32,
    pub ground_accel: f32,
    pub air_accel: f32,
    pub friction: f32,
    pub gravity: f32,
    pub jump_speed: f32,
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

#[derive(Clone, Debug)]
pub struct PlayerMotorState {
    pub collider: ColliderHandle,
    pub position: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub on_ground: bool,
    pub hp: u8,
    pub last_input: InputCmd,
}

pub struct PhysicsArena {
    pub config: MoveConfig,
    pub players: HashMap<u32, PlayerMotorState>,

    pub rigid_bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub query_pipeline: QueryPipeline,
    pub integration_parameters: IntegrationParameters,

    controller: KinematicCharacterController,
    next_spawn_index: u32,
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
            query_pipeline: QueryPipeline::new(),
            integration_parameters: IntegrationParameters::default(),
            controller,
            next_spawn_index: 0,
        };

        arena.integration_parameters.dt = 1.0 / 60.0;
        arena
    }

    pub fn spawn_player(&mut self, player_id: u32) -> Vec3 {
        let lane = self.next_spawn_index % 8;
        self.next_spawn_index += 1;
        let spawn = vector![lane as f32 * 2.0, 2.0, 0.0];

        let collider = ColliderBuilder::capsule_y(
            self.config.capsule_half_segment,
            self.config.capsule_radius,
        )
        .translation(spawn)
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
                velocity: Vec3::zeros(),
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
            self.colliders.remove(player.collider, &mut IslandManager::new(), &mut self.rigid_bodies, true);
        }
    }

    pub fn add_static_cuboid(&mut self, center: Vec3, half_extents: Vec3, user_data: u128) -> ColliderHandle {
        self.colliders.insert(
            ColliderBuilder::cuboid(half_extents.x, half_extents.y, half_extents.z)
                .translation(center)
                .user_data(user_data)
                .build(),
        )
    }

    pub fn remove_collider(&mut self, handle: ColliderHandle) {
        self.colliders.remove(handle, &mut IslandManager::new(), &mut self.rigid_bodies, true);
    }

    pub fn simulate_player_tick(&mut self, player_id: u32, input: &InputCmd, dt: f32) {
        let cfg = self.config.clone();
        let Some(state) = self.players.get_mut(&player_id) else { return; };

        state.yaw = input.yaw;
        state.pitch = input.pitch.clamp(-1.55, 1.55);
        state.last_input = input.clone();

        let wish = build_wish_dir(input, state.yaw);

        let max_speed = if input.buttons & BTN_CROUCH != 0 {
            cfg.crouch_speed
        } else if input.buttons & BTN_SPRINT != 0 {
            cfg.sprint_speed
        } else {
            cfg.walk_speed
        };

        apply_horizontal_friction(&mut state.velocity, cfg.friction, dt, state.on_ground);
        accelerate(
            &mut state.velocity,
            wish,
            max_speed,
            if state.on_ground { cfg.ground_accel } else { cfg.air_accel },
            dt,
        );

        if state.on_ground && (input.buttons & BTN_JUMP != 0) {
            state.velocity.y = cfg.jump_speed;
            state.on_ground = false;
        }

        state.velocity.y -= cfg.gravity * dt;
        let desired_translation = state.velocity * dt;

        let collider = self.colliders.get(state.collider).expect("missing player collider");
        let character_shape = collider.shape();
        let character_pos = Isometry3::translation(state.position.x, state.position.y, state.position.z);

        self.query_pipeline.update(&self.colliders);
        let filter = QueryFilter::default().exclude_collider(state.collider);

        let corrected = self.controller.move_shape(
            dt,
            &self.rigid_bodies,
            &self.colliders,
            &self.query_pipeline,
            character_shape,
            &character_pos,
            desired_translation,
            filter,
            |_| {},
        );

        let corrected_translation = corrected.translation;
        state.position += corrected_translation;

        let collider = self.colliders.get_mut(state.collider).expect("missing player collider");
        collider.set_translation(state.position);

        // Grounded heuristic: if we wanted to move downward and got clipped on Y, treat it as ground.
        let was_falling = desired_translation.y <= 0.0;
        let y_clipped = corrected_translation.y > desired_translation.y - 0.001;
        state.on_ground = was_falling && y_clipped && corrected_translation.y.abs() < 0.001;
        if state.on_ground && state.velocity.y < 0.0 {
            state.velocity.y = 0.0;
        }

        // Reflect actual collision result into horizontal velocity too, so prediction error stays small.
        state.velocity.x = corrected_translation.x / dt;
        state.velocity.z = corrected_translation.z / dt;
    }

    pub fn snapshot_player(&self, player_id: u32) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&player_id)?;
        let mut flags = 0u16;
        if state.on_ground {
            flags |= 1 << 0;
        }
        Some((
            [state.position.x, state.position.y, state.position.z],
            [state.velocity.x, state.velocity.y, state.velocity.z],
            state.yaw,
            state.pitch,
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
        let mut filter = QueryFilter::default();
        if let Some(player_id) = exclude_player {
            if let Some(player) = self.players.get(&player_id) {
                filter = filter.exclude_collider(player.collider);
            }
        }
        self.query_pipeline.update(&self.colliders);
        self.query_pipeline
            .cast_ray(&self.rigid_bodies, &self.colliders, &ray, max_toi, true, filter)
            .map(|(_handle, toi)| toi)
    }
}

fn vec3_from_yaw(yaw: f32) -> Vec3 {
    vector![yaw.sin(), 0.0, yaw.cos()]
}

fn build_wish_dir(input: &InputCmd, yaw: f32) -> Vec3 {
    let forward = vec3_from_yaw(yaw);
    let right = vector![forward.z, 0.0, -forward.x];

    let mut move_x = input.move_x as f32 / 127.0;
    let mut move_y = input.move_y as f32 / 127.0;

    // Fall back to button-derived movement so older callers still behave.
    if move_x.abs() <= f32::EPSILON && move_y.abs() <= f32::EPSILON {
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

fn apply_horizontal_friction(velocity: &mut Vec3, friction: f32, dt: f32, on_ground: bool) {
    if !on_ground {
        return;
    }
    let horizontal = vector![velocity.x, 0.0, velocity.z];
    let speed = horizontal.norm();
    if speed <= f32::EPSILON {
        return;
    }
    let drop = speed * friction * dt;
    let new_speed = (speed - drop).max(0.0);
    let ratio = if speed > 0.0 { new_speed / speed } else { 0.0 };
    velocity.x *= ratio;
    velocity.z *= ratio;
}

fn accelerate(velocity: &mut Vec3, wish_dir: Vec3, wish_speed: f32, accel: f32, dt: f32) {
    if wish_dir.norm_squared() <= 0.0001 {
        return;
    }
    let current_speed = velocity.dot(&wish_dir);
    let add_speed = (wish_speed - current_speed).max(0.0);
    if add_speed <= 0.0 {
        return;
    }
    let accel_speed = (accel * wish_speed * dt).min(add_speed);
    *velocity += wish_dir * accel_speed;
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

    #[test]
    fn build_wish_dir_uses_move_axes_without_button_bits() {
        let mut cmd = input();
        cmd.move_x = 127;

        let wish = build_wish_dir(&cmd, 0.0);

        assert!(wish.x > 0.99);
        assert!(wish.z.abs() < 0.001);
    }

    #[test]
    fn build_wish_dir_falls_back_to_buttons_when_move_axes_are_zero() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_RIGHT;

        let wish = build_wish_dir(&cmd, 0.0);

        assert!(wish.x > 0.7);
        assert!(wish.z > 0.7);
    }
}
