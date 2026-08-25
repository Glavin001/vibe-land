//! Shared pose/camera/body-state types for the destruction streaming core.
//!
//! Ported from /root/workspace/destruction-codec/src/trace.rs (2026-08-10),
//! trimmed to the types the live server needs.

use glam::{Quat, Vec3};

pub const FLAG_SLEEP: u8 = 1;
pub const FLAG_KINEMATIC: u8 = 2;
pub const FLAG_CONTACT_BEGIN: u8 = 4;
pub const FLAG_CONTACT_END: u8 = 8;
pub const FLAG_JOINT_BREAK: u8 = 16;
pub const FLAG_SLEEP_EVENT: u8 = 32;
pub const FLAG_WAKE_EVENT: u8 = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub position: Vec3,
    pub rotation: Quat,
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub direction: Vec3,
    pub fov_degrees: f32,
}

/// Per-tick kinematic state of one streamed rigid body (an island actor).
#[derive(Clone, Copy, Debug, Default)]
pub struct BodyState {
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub contacts: u16,
    pub intact_joints: u16,
    pub flags: u8,
}

impl BodyState {
    pub fn sleeping(self) -> bool {
        self.flags & FLAG_SLEEP != 0
    }

    pub fn kinematic(self) -> bool {
        self.flags & FLAG_KINEMATIC != 0
    }
}
