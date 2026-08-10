//! Per-client replication interest with predictive entry and hysteresis.
//!
//! Ported from /root/workspace/destruction-codec/src/interest.rs (2026-08-10).
//! This is deliberately separate from rendering visibility. A body remains
//! relevant briefly after leaving the view, may be prefetched before entering,
//! and can stay relevant when close enough to affect the viewer physically.
//!
//! Winning offline config: 5° fov margin, 200 ms lookahead, 250 ms grace,
//! 10 m proximity (all visual gates passing at 1% loss, 7.42 Mbps avg).

use glam::{Quat, Vec3};

use crate::types::{Camera, Pose};

#[derive(Clone, Copy, Debug)]
pub struct InterestConfig {
    pub fov_margin_degrees: f32,
    pub lookahead_ticks: u32,
    pub grace_ticks: u32,
    pub proximity_meters: f32,
    pub dt: f32,
    pub pane_width: u32,
    pub pane_height: u32,
}

impl InterestConfig {
    /// The offline-validated configuration at a given tick rate.
    pub fn validated(hz: u32) -> Self {
        Self {
            fov_margin_degrees: 5.0,
            lookahead_ticks: (hz / 5).max(1),      // 200 ms
            grace_ticks: (hz / 4).max(1),          // 250 ms
            proximity_meters: 10.0,
            dt: 1.0 / hz.max(1) as f32,
            pane_width: 1920,
            pane_height: 1080,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InterestDecision {
    pub relevant: bool,
    pub entering: bool,
    pub visible_now: bool,
    pub prefetched: bool,
    pub nearby: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct InterestView {
    pub current: Camera,
    pub predicted: Camera,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InterestTrack {
    relevant_until_tick: u32,
    was_relevant: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct InterestViewTrack {
    previous: Option<Camera>,
}

impl InterestViewTrack {
    pub fn update(&mut self, camera: Camera, config: InterestConfig) -> InterestView {
        let Some(previous) = self.previous.replace(camera) else {
            return InterestView {
                current: camera,
                predicted: camera,
            };
        };
        let lookahead_seconds = config.lookahead_ticks as f32 * config.dt;
        let eye_velocity = (camera.eye - previous.eye) / config.dt.max(1e-6);
        let previous_direction = previous.direction.normalize_or_zero();
        let current_direction = camera.direction.normalize_or_zero();
        let predicted_direction =
            if previous_direction == Vec3::ZERO || current_direction == Vec3::ZERO {
                current_direction
            } else {
                let delta = Quat::from_rotation_arc(previous_direction, current_direction);
                let scaled_axis = delta.to_scaled_axis();
                let multiplier = (lookahead_seconds / config.dt.max(1e-6)).min(8.0);
                let predicted_rotation = Quat::from_scaled_axis(scaled_axis * multiplier);
                (predicted_rotation * current_direction).normalize_or_zero()
            };
        InterestView {
            current: camera,
            predicted: Camera {
                eye: camera.eye + eye_velocity * lookahead_seconds,
                direction: predicted_direction,
                fov_degrees: camera.fov_degrees,
            },
        }
    }
}

impl InterestTrack {
    pub fn update(
        &mut self,
        tick: u32,
        pose: Pose,
        linear_velocity: Vec3,
        radius: f32,
        view: InterestView,
        config: InterestConfig,
    ) -> InterestDecision {
        let visible_now = sphere_in_view(
            pose.position,
            radius,
            view.current,
            config.pane_width,
            config.pane_height,
            config.fov_margin_degrees,
        );
        let lookahead_seconds = config.lookahead_ticks as f32 * config.dt;
        let predicted_position = pose.position + linear_velocity * lookahead_seconds;
        let prefetched = !visible_now
            && (sphere_in_view(
                predicted_position,
                radius,
                view.current,
                config.pane_width,
                config.pane_height,
                config.fov_margin_degrees,
            ) || sphere_in_view(
                predicted_position,
                radius,
                view.predicted,
                config.pane_width,
                config.pane_height,
                config.fov_margin_degrees,
            ));
        let nearby = pose.position.distance(view.current.eye) - radius <= config.proximity_meters;
        let directly_relevant = visible_now || prefetched || nearby;
        if directly_relevant {
            self.relevant_until_tick = tick.saturating_add(config.grace_ticks);
        }
        let relevant = directly_relevant || tick <= self.relevant_until_tick;
        let entering = relevant && !self.was_relevant;
        self.was_relevant = relevant;
        InterestDecision {
            relevant,
            entering,
            visible_now,
            prefetched,
            nearby,
        }
    }
}

pub fn sphere_in_view(
    position: Vec3,
    radius: f32,
    camera: Camera,
    pane_width: u32,
    pane_height: u32,
    fov_margin_degrees: f32,
) -> bool {
    let direction = camera.direction.normalize_or_zero();
    if direction == Vec3::ZERO {
        return false;
    }
    let reference_up = if direction.dot(Vec3::Y).abs() > 0.99 {
        Vec3::X
    } else {
        Vec3::Y
    };
    let right = direction.cross(reference_up).normalize();
    let up = right.cross(direction).normalize();
    let relative = position - camera.eye;
    let depth = relative.dot(direction);
    if depth + radius <= 0.1 {
        return false;
    }
    let expanded_fov = (camera.fov_degrees + 2.0 * fov_margin_degrees)
        .clamp(1.0, 179.0)
        .to_radians();
    let half_vertical = (expanded_fov * 0.5).tan();
    let aspect = pane_width as f32 / pane_height.max(1) as f32;
    let angular_radius = radius / depth.max(0.1);
    let x = relative.dot(right) / depth.max(0.1);
    let y = relative.dot(up) / depth.max(0.1);
    x.abs() <= half_vertical * aspect + angular_radius && y.abs() <= half_vertical + angular_radius
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Quat;

    fn camera() -> Camera {
        Camera {
            eye: Vec3::ZERO,
            direction: Vec3::Z,
            fov_degrees: 60.0,
        }
    }

    fn config() -> InterestConfig {
        InterestConfig {
            fov_margin_degrees: 0.0,
            lookahead_ticks: 10,
            grace_ticks: 5,
            proximity_meters: 2.0,
            dt: 0.1,
            pane_width: 1920,
            pane_height: 1080,
        }
    }

    fn static_view() -> InterestView {
        InterestView {
            current: camera(),
            predicted: camera(),
        }
    }

    fn pose(position: Vec3) -> Pose {
        Pose {
            position,
            rotation: Quat::IDENTITY,
        }
    }

    #[test]
    fn visible_body_enters_then_receives_exit_grace() {
        let mut track = InterestTrack::default();
        let entered = track.update(
            10,
            pose(Vec3::Z * 10.0),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(entered.visible_now);
        assert!(entered.entering);

        let grace = track.update(
            12,
            pose(Vec3::new(100.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(grace.relevant);
        assert!(!grace.entering);

        let expired = track.update(
            16,
            pose(Vec3::new(100.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.5,
            static_view(),
            config(),
        );
        assert!(!expired.relevant);
    }

    #[test]
    fn velocity_lookahead_prefetches_before_frustum_entry() {
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(20.0, 0.0, 10.0)),
            Vec3::new(-20.0, 0.0, 0.0),
            0.5,
            static_view(),
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.prefetched);
        assert!(decision.relevant);
    }

    #[test]
    fn camera_motion_prefetches_future_view() {
        let mut view = InterestViewTrack::default();
        view.update(camera(), config());
        let turning = Camera {
            direction: Vec3::new(0.1, 0.0, 1.0).normalize(),
            ..camera()
        };
        let moving_view = view.update(turning, config());
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(15.0, 0.0, 10.0)),
            Vec3::ZERO,
            0.1,
            moving_view,
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.prefetched);
    }

    #[test]
    fn proximity_keeps_body_relevant_behind_camera() {
        let mut track = InterestTrack::default();
        let decision = track.update(
            1,
            pose(Vec3::new(0.0, 0.0, -1.0)),
            Vec3::ZERO,
            0.25,
            static_view(),
            config(),
        );
        assert!(!decision.visible_now);
        assert!(decision.nearby);
        assert!(decision.relevant);
    }

    #[test]
    fn margin_prevents_edge_churn() {
        let point = Vec3::new(12.0, 0.0, 10.0);
        assert!(!sphere_in_view(point, 0.1, camera(), 1920, 1080, 0.0));
        assert!(sphere_in_view(point, 0.1, camera(), 1920, 1080, 10.0));
    }
}
