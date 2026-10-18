//! Motion-continuity diagnostics for detecting freezes, reversals and lurches.

use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct ContinuityConfig {
    pub truth_moving_speed: f32,
    pub presented_still_speed: f32,
    pub angular_moving_speed: f32,
    pub dt: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ContinuitySample {
    pub truth_moving: bool,
    pub frozen: bool,
    // Callers with a displayed-error tolerance (e.g. the live hierarchy pass)
    // recompute a visible-only freeze run themselves; kept here as part of
    // the tracker's raw contract and covered by this module's own tests.
    #[allow(dead_code)]
    pub freeze_started: bool,
    #[allow(dead_code)]
    pub freeze_run_ticks: u32,
    pub linear_reversal: bool,
    pub angular_reversal: bool,
    pub velocity_error: f32,
    pub angular_velocity_error: f32,
    pub excess_acceleration: f32,
    pub excess_angular_acceleration: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ContinuityTracker {
    previous_truth_velocity: Option<Vec3>,
    previous_presented_velocity: Option<Vec3>,
    previous_truth_angular_velocity: Option<Vec3>,
    previous_presented_angular_velocity: Option<Vec3>,
    freeze_run_ticks: u32,
}

impl ContinuityTracker {
    pub fn observe(
        &mut self,
        truth_velocity: Vec3,
        truth_angular_velocity: Vec3,
        presented_velocity: Vec3,
        presented_angular_velocity: Vec3,
        config: ContinuityConfig,
    ) -> ContinuitySample {
        let truth_moving = truth_velocity.length() >= config.truth_moving_speed;
        let frozen = truth_moving && presented_velocity.length() <= config.presented_still_speed;
        let freeze_started = frozen && self.freeze_run_ticks == 0;
        self.freeze_run_ticks = if frozen {
            self.freeze_run_ticks.saturating_add(1)
        } else {
            0
        };
        let linear_reversal = truth_moving
            && presented_velocity.length() >= config.presented_still_speed
            && truth_velocity.dot(presented_velocity) < 0.0;
        let angular_reversal = truth_angular_velocity.length() >= config.angular_moving_speed
            && presented_angular_velocity.length() >= config.angular_moving_speed
            && truth_angular_velocity.dot(presented_angular_velocity) < 0.0;

        let excess_acceleration = match (
            self.previous_truth_velocity,
            self.previous_presented_velocity,
        ) {
            (Some(previous_truth), Some(previous_presented)) => {
                let truth_acceleration =
                    (truth_velocity - previous_truth) / config.dt.max(f32::EPSILON);
                let presented_acceleration =
                    (presented_velocity - previous_presented) / config.dt.max(f32::EPSILON);
                (presented_acceleration - truth_acceleration).length()
            }
            _ => 0.0,
        };
        let excess_angular_acceleration = match (
            self.previous_truth_angular_velocity,
            self.previous_presented_angular_velocity,
        ) {
            (Some(previous_truth), Some(previous_presented)) => {
                let truth_acceleration =
                    (truth_angular_velocity - previous_truth) / config.dt.max(f32::EPSILON);
                let presented_acceleration =
                    (presented_angular_velocity - previous_presented) / config.dt.max(f32::EPSILON);
                (presented_acceleration - truth_acceleration).length()
            }
            _ => 0.0,
        };

        self.previous_truth_velocity = Some(truth_velocity);
        self.previous_presented_velocity = Some(presented_velocity);
        self.previous_truth_angular_velocity = Some(truth_angular_velocity);
        self.previous_presented_angular_velocity = Some(presented_angular_velocity);

        ContinuitySample {
            truth_moving,
            frozen,
            freeze_started,
            freeze_run_ticks: self.freeze_run_ticks,
            linear_reversal,
            angular_reversal,
            velocity_error: (presented_velocity - truth_velocity).length(),
            angular_velocity_error: (presented_angular_velocity - truth_angular_velocity).length(),
            excess_acceleration,
            excess_angular_acceleration,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ContinuityConfig {
        ContinuityConfig {
            truth_moving_speed: 0.5,
            presented_still_speed: 0.05,
            angular_moving_speed: 0.1,
            dt: 1.0 / 60.0,
        }
    }

    #[test]
    fn detects_moving_truth_held_at_rest() {
        let mut tracker = ContinuityTracker::default();
        let sample = tracker.observe(Vec3::X, Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, config());
        assert!(sample.frozen);
        assert!(sample.freeze_started);
        assert_eq!(sample.freeze_run_ticks, 1);
    }

    #[test]
    fn detects_linear_and_angular_backtracking() {
        let mut tracker = ContinuityTracker::default();
        let sample = tracker.observe(Vec3::X, Vec3::Y, -Vec3::X, -Vec3::Y, config());
        assert!(sample.linear_reversal);
        assert!(sample.angular_reversal);
    }

    #[test]
    fn reports_excess_lurch_not_authoritative_impulse() {
        let mut smooth = ContinuityTracker::default();
        smooth.observe(Vec3::X, Vec3::ZERO, Vec3::X, Vec3::ZERO, config());
        let matched_impulse = smooth.observe(-Vec3::X, Vec3::ZERO, -Vec3::X, Vec3::ZERO, config());
        assert!(matched_impulse.excess_acceleration < 1e-5);

        let mut lurch = ContinuityTracker::default();
        lurch.observe(Vec3::X, Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, config());
        let unexpected = lurch.observe(Vec3::X, Vec3::ZERO, Vec3::X * 8.0, Vec3::ZERO, config());
        assert!(unexpected.excess_acceleration > 100.0);
    }
}
