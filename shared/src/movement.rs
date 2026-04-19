// Re-export generic movement types and math from the netcode library.
pub use vibe_netcode::movement::{accelerate, apply_horizontal_friction, MoveConfig, Vec3d};

use crate::constants::*;
use crate::protocol::InputCmd;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerNavigationProfile {
    pub walkable_radius: f32,
    pub walkable_height: f32,
    pub walkable_climb: f32,
    pub walkable_slope_angle_degrees: f32,
}

pub fn player_navigation_profile(config: &MoveConfig) -> PlayerNavigationProfile {
    PlayerNavigationProfile {
        walkable_radius: config.capsule_radius,
        walkable_height: 2.0 * (config.capsule_half_segment + config.capsule_radius),
        walkable_climb: config.max_step_height,
        walkable_slope_angle_degrees: config.max_slope_radians.to_degrees(),
    }
}

pub fn default_player_navigation_profile() -> PlayerNavigationProfile {
    player_navigation_profile(&MoveConfig::default())
}

// ── Vehicle tuning constants ─────────────────────
pub const VEHICLE_MAX_STEER_RAD: f32 = 0.5;
pub const VEHICLE_ENGINE_FORCE: f32 = 4000.0; // 2 rear wheels × 4000 N / ~600 kg ≈ 13 m/s² — sporty car
pub const VEHICLE_BRAKE_FORCE: f32 = 2000.0;
pub const VEHICLE_SUSPENSION_STIFFNESS: f32 = 80.0;
pub const VEHICLE_SUSPENSION_DAMPING: f32 = 20.0; // critically-damped at ~300kg chassis
pub const VEHICLE_SUSPENSION_REST_LENGTH: f32 = 0.3;
pub const VEHICLE_SUSPENSION_TRAVEL: f32 = 0.2;
pub const VEHICLE_WHEEL_RADIUS: f32 = 0.35;
pub const VEHICLE_FRICTION_SLIP: f32 = 1.8;
// Chassis collider density. The chassis is now a Cybertruck-style wedge
// (`VEHICLE_CHASSIS_HULL_VERTICES`), whose convex-hull volume is ≈ 2.85 m³ —
// roughly 73% of the previous cuboid's 3.888 m³. Density was 155 kg/m³ for
// the cuboid; scaled by 3.888 / 2.85 ≈ 1.36 to preserve mass and keep the
// suspension near critically damped at the same ~300 kg chassis mass.
pub const VEHICLE_CHASSIS_DENSITY: f32 = 211.0;

// ── Vehicle-vs-player collision damage tuning ────
/// Chassis speed at which a fully direct vehicle hit deals 100 HP
/// (instant kill). Near the natural terminal velocity of the current
/// chassis (4000 N rear engine force, ~600 kg, 0.1 linear damping).
pub const VEHICLE_LETHAL_SPEED_M_S: f32 = 25.0;
/// Below this chassis speed, vehicle-vs-player overlaps deal no damage.
/// Prevents stationary-jitter and vehicle-enter overlaps from dealing
/// spurious damage.
pub const VEHICLE_DAMAGE_MIN_SPEED_M_S: f32 = 3.0;
/// Floor on the directness multiplier so a glancing top-speed sideswipe
/// still deals meaningful damage (~20 HP at top speed).
pub const VEHICLE_DAMAGE_MIN_DIRECT_FACTOR: f32 = 0.2;

/// Vehicle control inputs derived from a player `InputCmd`.
pub struct VehicleInputCmd {
    pub throttle: f32,   // 0..1  (move_y > 0)
    pub reverse: f32,    // 0..1  (move_y < 0)
    pub steer: f32,      // -1..1 (move_x, positive = right)
    pub handbrake: bool, // BTN_JUMP
}

/// Map a generic `InputCmd` to vehicle controls.
/// Pure function — called identically on server and WASM client for determinism.
pub fn input_to_vehicle_cmd(input: &InputCmd) -> VehicleInputCmd {
    let move_y = if input.move_y != 0 {
        input.move_y as f32 / 127.0
    } else if input.buttons & BTN_FORWARD != 0 {
        1.0
    } else if input.buttons & BTN_BACK != 0 {
        -1.0
    } else {
        0.0
    };

    let move_x = if input.move_x != 0 {
        input.move_x as f32 / 127.0
    } else if input.buttons & BTN_LEFT != 0 {
        -1.0
    } else if input.buttons & BTN_RIGHT != 0 {
        1.0
    } else {
        0.0
    };

    VehicleInputCmd {
        throttle: move_y.max(0.0),
        reverse: (-move_y).max(0.0),
        // move_x positive = BTN_RIGHT = camera-right. In our world yaw convention,
        // camera-right at yaw=0 is -X, so steer right means negative move_x. Negate so
        // positive steer = turn right in vehicle's forward direction.
        steer: -move_x.clamp(-1.0, 1.0),
        handbrake: input.buttons & BTN_JUMP != 0,
    }
}

/// Compute the wheel parameters (steering angle, engine force, brake force) for one tick.
///
/// Single source of truth shared by the server-side physics pipeline and the WASM
/// client prediction world — callers must not reimplement this logic inline.
///
/// Sign convention: Rapier's wheel forward = surface_normal × axle = (+Y)×(+X) = −Z,
/// so positive engine_force drives in −Z.  Negating the throttle/reverse maps W→forward.
pub fn vehicle_wheel_params(input: &InputCmd) -> (f32, f32, f32) {
    let v = input_to_vehicle_cmd(input);
    let steering = v.steer * VEHICLE_MAX_STEER_RAD;
    let engine_force = (v.reverse - v.throttle) * VEHICLE_ENGINE_FORCE;
    let brake = if v.handbrake {
        VEHICLE_BRAKE_FORCE * 2.0
    } else {
        0.0
    };
    (steering, engine_force, brake)
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
        move_x = (if input.buttons & BTN_RIGHT != 0 {
            1.0
        } else {
            0.0
        }) + (if input.buttons & BTN_LEFT != 0 {
            -1.0
        } else {
            0.0
        });
        move_y = (if input.buttons & BTN_FORWARD != 0 {
            1.0
        } else {
            0.0
        }) + (if input.buttons & BTN_BACK != 0 {
            -1.0
        } else {
            0.0
        });
    }

    let mut wish = right * move_x + forward * move_y;
    wish.y = 0.0;
    if wish.norm_squared() > 0.0001 {
        wish = wish.normalize();
    }
    wish
}

const BACKWARD_SPEED_MULTIPLIER: f64 = 0.9;

fn input_move_y(input: &InputCmd) -> f64 {
    if input.move_x == 0 && input.move_y == 0 {
        (if input.buttons & BTN_FORWARD != 0 {
            1.0
        } else {
            0.0
        }) + (if input.buttons & BTN_BACK != 0 {
            -1.0
        } else {
            0.0
        })
    } else {
        input.move_y as f64 / 127.0
    }
}

/// Pick movement speed based on stance and forward/backward input.
pub fn pick_move_speed(config: &MoveConfig, input: &InputCmd) -> f64 {
    let base_speed = if input.buttons & BTN_CROUCH != 0 {
        config.crouch_speed
    } else if input.buttons & BTN_SPRINT != 0 {
        config.sprint_speed
    } else {
        config.walk_speed
    };

    if input_move_y(input) < 0.0 {
        base_speed * BACKWARD_SPEED_MULTIPLIER
    } else {
        base_speed
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
        assert!(wish.z > 0.7); // FORWARD → +Z at yaw=0
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
    #[test]
    fn right_strafe_matches_camera_screen_right() {
        // At yaw=0 (camera looks +Z), screen-right is -X
        let mut cmd = input();
        cmd.move_x = 127;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(
            wish.x < -0.99,
            "D key at yaw=0 must move -X (camera right), got x={}",
            wish.x
        );
        assert!(wish.z.abs() < 0.01);

        cmd.move_x = -127;
        let wish = build_wish_dir(&cmd, 0.0);
        assert!(
            wish.x > 0.99,
            "A key at yaw=0 must move +X (camera left), got x={}",
            wish.x
        );

        cmd.move_x = 127;
        let wish = build_wish_dir(&cmd, std::f64::consts::FRAC_PI_2);
        assert!(
            wish.z > 0.99,
            "D key at yaw=π/2 must move +Z, got z={}",
            wish.z
        );
        assert!(wish.x.abs() < 0.01);

        cmd.move_x = 0;
        cmd.move_y = 127;
        let wish = build_wish_dir(&cmd, std::f64::consts::FRAC_PI_2);
        assert!(
            wish.x > 0.99,
            "W key at yaw=π/2 must move +X, got x={}",
            wish.x
        );
    }

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
            assert!(
                dot < -0.99,
                "Left and right must be opposite at yaw={yaw}, dot={dot}"
            );
        }
    }

    #[test]
    fn pick_speed_variants() {
        let cfg = MoveConfig::default();
        assert_eq!(pick_move_speed(&cfg, &input()), 6.0);

        let mut sprint = input();
        sprint.buttons = BTN_SPRINT;
        assert_eq!(pick_move_speed(&cfg, &sprint), 8.5);

        let mut crouch = input();
        crouch.buttons = BTN_CROUCH;
        assert_eq!(pick_move_speed(&cfg, &crouch), 3.5);
    }

    #[test]
    fn backward_speed_is_reduced_for_axes_and_buttons() {
        let cfg = MoveConfig::default();

        let mut backward_axis = input();
        backward_axis.move_y = -127;
        assert_eq!(pick_move_speed(&cfg, &backward_axis), cfg.walk_speed * 0.9);

        let mut backward_button = input();
        backward_button.buttons = BTN_BACK;
        assert_eq!(pick_move_speed(&cfg, &backward_button), cfg.walk_speed * 0.9);

        let mut sprint_backward = input();
        sprint_backward.buttons = BTN_SPRINT;
        sprint_backward.move_y = -127;
        assert_eq!(pick_move_speed(&cfg, &sprint_backward), cfg.sprint_speed * 0.9);
    }

    #[test]
    fn default_player_navigation_profile_matches_move_config() {
        let cfg = MoveConfig::default();
        let profile = default_player_navigation_profile();
        assert_eq!(profile.walkable_radius, cfg.capsule_radius);
        assert_eq!(
            profile.walkable_height,
            2.0 * (cfg.capsule_half_segment + cfg.capsule_radius)
        );
        assert_eq!(profile.walkable_climb, cfg.max_step_height);
        assert_eq!(
            profile.walkable_slope_angle_degrees,
            cfg.max_slope_radians.to_degrees()
        );
    }
}
