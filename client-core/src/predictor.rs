//! A bounded presentation offset for the local player on server-authoritative (PhysX) matches.
//!
//! Port of the web client's `physics/thinAuthoritativePredictor.ts`. The server moves the player
//! (a PhysX character controller); the client draws the server's interpolated pose plus a small
//! offset that leads it in the direction the player is pushing, so input feels immediate. It never
//! collides with anything: the offset is capped (0.35 m horizontal, 0.22 m vertical) and decays
//! toward the authoritative pose with a 45 ms half-life.
//!
//! One deliberate difference: the web predicts sprint at 9 m/s; this uses the server's own speeds
//! (`vibe_netcode::movement::MoveConfig`: walk 6, sprint 8.5), so the lead matches what the server
//! will actually do.

use glam::Vec3;
use vibe_land_shared::constants::{BTN_JUMP, BTN_SPRINT};
use vibe_netcode::movement::MoveConfig;

use crate::input::InputState;

const MAX_PREDICTION_HORIZON_S: f32 = 0.05;
const MAX_HORIZONTAL_OFFSET_M: f32 = 0.35;
const MAX_VERTICAL_OFFSET_M: f32 = 0.22;
const JUMP_PRESENTATION_SPEED_MPS: f32 = 4.0;
const CORRECTION_HALF_LIFE_S: f32 = 0.045;

pub struct ThinPredictor {
    offset: Vec3,
    velocity: Vec3,
    grounded: bool,
    jump_consumed: bool,
    in_vehicle: bool,
    walk: f32,
    sprint: f32,
}

impl Default for ThinPredictor {
    fn default() -> Self {
        let cfg = MoveConfig::default();
        Self {
            offset: Vec3::ZERO,
            velocity: Vec3::ZERO,
            grounded: false,
            jump_consumed: false,
            in_vehicle: false,
            walk: cfg.walk_speed as f32,
            sprint: cfg.sprint_speed as f32,
        }
    }
}

impl ThinPredictor {
    /// The authoritative state this frame (velocity including whatever the player stands on).
    pub fn observe(&mut self, velocity: Vec3, grounded: bool, in_vehicle: bool, dt_s: f32) {
        self.in_vehicle = in_vehicle;
        self.grounded = grounded;
        if grounded {
            self.jump_consumed = false;
        }
        self.velocity = velocity;
        self.offset *= 0.5f32.powf(dt_s.max(0.0) / CORRECTION_HALF_LIFE_S);
    }

    /// The presented position for this frame.
    pub fn update(&mut self, authoritative: Vec3, dt_s: f32, input: &InputState) -> Vec3 {
        if self.in_vehicle {
            self.offset = Vec3::ZERO;
            return authoritative;
        }
        let dt = dt_s.clamp(0.0, MAX_PREDICTION_HORIZON_S);
        let len = input.move_x.hypot(input.move_y);
        let (mx, my) = if len > 1.0 { (input.move_x / len, input.move_y / len) } else { (input.move_x, input.move_y) };
        let speed = if input.buttons & BTN_SPRINT != 0 { self.sprint } else { self.walk };
        let (sin, cos) = input.yaw.sin_cos();
        // shared::movement::build_wish_dir: forward (sin, cos), right (-cos, sin).
        let desired_x = (-mx * cos + my * sin) * speed;
        let desired_z = (mx * sin + my * cos) * speed;
        self.offset.x += (desired_x - self.velocity.x) * dt;
        self.offset.z += (desired_z - self.velocity.z) * dt;
        if input.buttons & BTN_JUMP != 0 && self.grounded && !self.jump_consumed {
            self.offset.y += JUMP_PRESENTATION_SPEED_MPS * dt;
            self.jump_consumed = true;
        }
        let horizontal = self.offset.x.hypot(self.offset.z);
        if horizontal > MAX_HORIZONTAL_OFFSET_M {
            let s = MAX_HORIZONTAL_OFFSET_M / horizontal;
            self.offset.x *= s;
            self.offset.z *= s;
        }
        self.offset.y = self.offset.y.clamp(-MAX_VERTICAL_OFFSET_M, MAX_VERTICAL_OFFSET_M);
        authoritative + self.offset
    }

    pub fn offset(&self) -> Vec3 {
        self.offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leads_in_the_pushed_direction_and_stays_bounded() {
        let mut p = ThinPredictor::default();
        let forward = InputState { move_y: 1.0, ..Default::default() }; // yaw 0: forward is +z
        let mut pos = Vec3::ZERO;
        for _ in 0..600 {
            p.observe(Vec3::ZERO, true, false, 1.0 / 60.0);
            pos = p.update(Vec3::ZERO, 1.0 / 60.0, &forward);
        }
        assert!(pos.z > 0.3 && pos.z <= MAX_HORIZONTAL_OFFSET_M + 1e-6, "{pos}");
        assert!(pos.x.abs() < 1e-6);
    }

    #[test]
    fn no_lead_once_the_server_moves_at_the_pushed_speed() {
        let mut p = ThinPredictor::default();
        let forward = InputState { move_y: 1.0, ..Default::default() };
        for _ in 0..600 {
            p.observe(Vec3::new(0.0, 0.0, 6.0), true, false, 1.0 / 60.0);
            p.update(Vec3::ZERO, 1.0 / 60.0, &forward);
        }
        assert!(p.offset().length() < 1e-3, "{}", p.offset());
    }

    #[test]
    fn decays_with_a_45_ms_half_life() {
        let mut p = ThinPredictor::default();
        p.offset = Vec3::new(0.2, 0.0, 0.0);
        p.observe(Vec3::ZERO, true, false, 0.045);
        assert!((p.offset().x - 0.1).abs() < 1e-6);
    }

    #[test]
    fn in_a_vehicle_the_pose_is_authoritative() {
        let mut p = ThinPredictor::default();
        p.offset = Vec3::new(0.2, 0.1, 0.0);
        p.observe(Vec3::ZERO, false, true, 0.0);
        assert_eq!(p.update(Vec3::ONE, 0.016, &InputState { move_y: 1.0, ..Default::default() }), Vec3::ONE);
    }
}
