use crate::constants::*;
use crate::protocol::InputCmd;

pub type Vec3d = nalgebra::Vector3<f64>;

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

/// Build the horizontal wish direction from input axes and yaw angle.
/// Falls back to button-derived movement if analog axes are zero.
pub fn build_wish_dir(input: &InputCmd, yaw: f64) -> Vec3d {
    let forward = Vec3d::new(yaw.sin(), 0.0, yaw.cos());
    let right = Vec3d::new(-forward.z, 0.0, forward.x);

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

/// Apply ground friction to horizontal velocity.
pub fn apply_horizontal_friction(velocity: &mut Vec3d, friction: f64, dt: f64, on_ground: bool) {
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

/// Accelerate velocity toward wish direction at the given speed.
pub fn accelerate(velocity: &mut Vec3d, wish_dir: Vec3d, wish_speed: f64, accel: f64, dt: f64) {
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

/// Pick movement speed based on button state.
pub fn pick_move_speed(config: &MoveConfig, buttons: u16) -> f64 {
    if buttons & BTN_CROUCH != 0 {
        config.crouch_speed
    } else if buttons & BTN_SPRINT != 0 {
        config.sprint_speed
    } else {
        config.walk_speed
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

    #[test]
    fn wish_dir_uses_move_axes() {
        let mut cmd = input();
        cmd.move_x = 127; // RIGHT strafe at yaw=0 → -X (Three.js camera convention)
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x < -0.99);
        assert!(wish.z.abs() < 0.001);
    }

    #[test]
    fn wish_dir_falls_back_to_buttons() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_RIGHT;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x < -0.7); // RIGHT → -X at yaw=0
        assert!(wish.z > 0.7);  // FORWARD → +Z at yaw=0
    }

    #[test]
    fn wish_dir_forward_only() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.z > 0.99);
    }

    #[test]
    fn wish_dir_opposing_cancel() {
        let mut cmd = input();
        cmd.buttons = BTN_FORWARD | BTN_BACK;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.norm() < 0.01);
    }

    /// Regression test: right strafe must match Three.js camera screen-right.
    /// Three.js cameras look down -Z locally; when the game points at +Z via
    /// lookAt, screen-right becomes -X in world space at yaw=0.
    /// Bug: previously right = (cos, 0, -sin) = +X at yaw=0, which was the
    /// OPPOSITE of Three.js camera screen-right, causing A/D keys to be swapped.
    #[test]
    fn right_strafe_matches_camera_screen_right() {
        // At yaw=0 (camera looks +Z), screen-right is -X
        let mut cmd = input();
        cmd.move_x = 127; // D key = BTN_RIGHT
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x < -0.99, "D key at yaw=0 must move -X (camera right), got x={}", wish.x);
        assert!(wish.z.abs() < 0.01);

        // A key = BTN_LEFT should be opposite (+X)
        cmd.move_x = -127;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(wish.x > 0.99, "A key at yaw=0 must move +X (camera left), got x={}", wish.x);

        // At yaw=π/2 (camera looks +X), screen-right is +Z
        cmd.move_x = 127;
        let wish = build_wish_dir(&cmd, std::f64::consts::FRAC_PI_2);
        assert!(wish.z > 0.99, "D key at yaw=π/2 must move +Z, got z={}", wish.z);
        assert!(wish.x.abs() < 0.01);

        // At yaw=π/2, forward (+X direction)
        cmd.move_x = 0;
        cmd.move_y = 127;
        let wish = build_wish_dir(&cmd, std::f64::consts::FRAC_PI_2);
        assert!(wish.x > 0.99, "W key at yaw=π/2 must move +X, got x={}", wish.x);
    }

    /// Regression: left strafe and right strafe must be exact opposites.
    #[test]
    fn left_and_right_strafe_are_opposite() {
        for yaw in [0.0, 0.5, 1.0, 2.0, -1.0, std::f64::consts::PI] {
            let mut cmd_r = input();
            cmd_r.move_x = 127;
            let wish_r = build_wish_dir(&cmd_r, yaw);

            let mut cmd_l = input();
            cmd_l.move_x = -127;
            let wish_l = build_wish_dir(&cmd_l, yaw);

            let dot = wish_r.x * wish_l.x + wish_r.z * wish_l.z;
            assert!(dot < -0.99, "Left and right must be opposite at yaw={yaw}, dot={dot}");
        }
    }

    #[test]
    fn friction_reduces_speed() {
        let mut vel = Vec3d::new(5.0, 0.0, 0.0);
        apply_horizontal_friction(&mut vel, 10.0, 1.0 / 60.0, true);
        assert!(vel.x < 5.0);
        assert!(vel.x > 0.0);
    }

    #[test]
    fn friction_no_effect_in_air() {
        let mut vel = Vec3d::new(5.0, 0.0, 0.0);
        apply_horizontal_friction(&mut vel, 10.0, 1.0 / 60.0, false);
        assert!((vel.x - 5.0).abs() < 1e-10);
    }

    #[test]
    fn accelerate_adds_speed() {
        let mut vel = Vec3d::new(0.0, 0.0, 0.0);
        let wish = Vec3d::new(0.0, 0.0, 1.0);
        accelerate(&mut vel, wish, 6.0, 80.0, 1.0 / 60.0);
        assert!(vel.z > 0.0);
    }

    #[test]
    fn pick_speed_variants() {
        let cfg = MoveConfig::default();
        assert_eq!(pick_move_speed(&cfg, 0), 6.0);
        assert_eq!(pick_move_speed(&cfg, BTN_SPRINT), 8.5);
        assert_eq!(pick_move_speed(&cfg, BTN_CROUCH), 3.5);
    }
}
