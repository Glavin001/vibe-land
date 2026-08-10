//! Per-body physical-class tracking and ballistic prediction.
//!
//! Ported from /root/workspace/destruction-codec/src/codec.rs (2026-08-10).
//! Quiescence is decided from app-level velocity plus contact stability, never
//! the engine sleep flag (the PhysX Direct GPU API disables sleeping).
//! Ballistic is deliberately conservative: no contacts, no intact joints,
//! not kinematic.

use glam::{Quat, Vec3};

use crate::types::{
    BodyState, Pose, FLAG_CONTACT_BEGIN, FLAG_CONTACT_END, FLAG_JOINT_BREAK, FLAG_SLEEP_EVENT,
    FLAG_WAKE_EVENT,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PhysicalClass {
    Quiescent,
    Ballistic,
    ContactActive,
    ImpactBurst,
}

#[derive(Clone, Copy, Debug)]
pub struct ClassifierConfig {
    pub enter_ticks: u16,
    pub exit_ticks: u16,
    pub linear_enter: f32,
    pub angular_enter: f32,
    pub linear_exit: f32,
    pub angular_exit: f32,
    pub impact_burst_ticks: u8,
}

impl Default for ClassifierConfig {
    fn default() -> Self {
        Self {
            enter_ticks: 20,
            exit_ticks: 2,
            linear_enter: 0.03,
            angular_enter: 0.04,
            linear_exit: 0.08,
            angular_exit: 0.10,
            impact_burst_ticks: 6,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Classifier {
    class: PhysicalClass,
    quiet_ticks: u16,
    active_ticks: u16,
    free_ticks: u16,
    stable_contacts: u16,
    previous_contacts: u16,
    burst_left: u8,
}

impl Default for Classifier {
    fn default() -> Self {
        Self {
            class: PhysicalClass::ContactActive,
            quiet_ticks: 0,
            active_ticks: 0,
            free_ticks: 0,
            stable_contacts: 0,
            previous_contacts: u16::MAX,
            burst_left: 0,
        }
    }
}

impl Classifier {
    pub fn class(&self) -> PhysicalClass {
        self.class
    }

    pub fn update(&mut self, state: BodyState, cfg: ClassifierConfig) -> PhysicalClass {
        let event_mask = FLAG_CONTACT_BEGIN
            | FLAG_CONTACT_END
            | FLAG_JOINT_BREAK
            | FLAG_SLEEP_EVENT
            | FLAG_WAKE_EVENT;
        let contacts_stable =
            state.contacts == self.previous_contacts && state.flags & event_mask == 0;
        self.previous_contacts = state.contacts;
        self.stable_contacts = if contacts_stable {
            self.stable_contacts.saturating_add(1)
        } else {
            0
        };
        if state.flags & (FLAG_CONTACT_BEGIN | FLAG_JOINT_BREAK | FLAG_WAKE_EVENT) != 0 {
            self.burst_left = cfg.impact_burst_ticks;
        }

        let speed = state.linear_velocity.length();
        let angular = state.angular_velocity.length();
        let quiet = speed <= cfg.linear_enter
            && angular <= cfg.angular_enter
            && self.stable_contacts >= cfg.enter_ticks
            && !state.kinematic();
        self.quiet_ticks = if quiet {
            self.quiet_ticks.saturating_add(1)
        } else {
            0
        };
        let clearly_active = speed > cfg.linear_exit
            || angular > cfg.angular_exit
            || !contacts_stable
            || state.kinematic();
        self.active_ticks = if clearly_active {
            self.active_ticks.saturating_add(1)
        } else {
            0
        };

        let ballistic_eligible =
            state.contacts == 0 && state.intact_joints == 0 && !state.kinematic();
        self.free_ticks = if ballistic_eligible {
            self.free_ticks.saturating_add(1)
        } else {
            0
        };
        self.class = if self.burst_left > 0 {
            self.burst_left -= 1;
            PhysicalClass::ImpactBurst
        } else if (self.class == PhysicalClass::Quiescent && self.active_ticks < cfg.exit_ticks)
            || self.quiet_ticks >= cfg.enter_ticks
        {
            PhysicalClass::Quiescent
        } else if ballistic_eligible
            && (self.class == PhysicalClass::Ballistic || self.free_ticks >= cfg.exit_ticks)
        {
            PhysicalClass::Ballistic
        } else {
            PhysicalClass::ContactActive
        };
        self.class
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PredictorParams {
    pub gravity: Vec3,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub dt: f32,
    pub steps: u32,
}

pub fn predict_ballistic(
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    params: PredictorParams,
) -> (Pose, Vec3, Vec3) {
    let mut pose = pose;
    let mut lv = linear_velocity;
    let mut av = angular_velocity;
    for _ in 0..params.steps {
        // Mirrors common discrete rigid-body integration: acceleration, then
        // rational damping, then semi-implicit position/orientation update.
        lv += params.gravity * params.dt;
        lv *= 1.0 / (1.0 + params.linear_damping * params.dt);
        av *= 1.0 / (1.0 + params.angular_damping * params.dt);
        pose.position += lv * params.dt;
        let angle = av.length() * params.dt;
        if angle > 1e-8 {
            pose.rotation =
                (Quat::from_axis_angle(av.normalize(), angle) * pose.rotation).normalize();
        }
    }
    (pose, lv, av)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifier_ballistic_is_conservative() {
        let base = BodyState {
            pose: Pose::default(),
            linear_velocity: Vec3::Y,
            angular_velocity: Vec3::ZERO,
            contacts: 0,
            intact_joints: 0,
            flags: 0,
        };
        let mut free = Classifier::default();
        assert_eq!(
            free.update(base, ClassifierConfig::default()),
            PhysicalClass::ContactActive
        );
        assert_eq!(
            free.update(base, ClassifierConfig::default()),
            PhysicalClass::Ballistic
        );
        let constrained = BodyState {
            intact_joints: 1,
            ..base
        };
        assert_eq!(
            Classifier::default().update(constrained, ClassifierConfig::default()),
            PhysicalClass::ContactActive
        );
    }

    #[test]
    fn stable_slow_body_becomes_quiescent() {
        let resting = BodyState {
            pose: Pose::default(),
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            contacts: 3,
            intact_joints: 0,
            flags: 0,
        };
        let cfg = ClassifierConfig::default();
        let mut classifier = Classifier::default();
        // Contact stability must accumulate before quiet ticks start counting,
        // so quiescence entry takes ~2x enter_ticks updates.
        let mut class = PhysicalClass::ContactActive;
        for _ in 0..(cfg.enter_ticks * 2 + 3) {
            class = classifier.update(resting, cfg);
        }
        assert_eq!(class, PhysicalClass::Quiescent);
    }

    #[test]
    fn impact_burst_overrides_and_decays() {
        let cfg = ClassifierConfig::default();
        let mut classifier = Classifier::default();
        let hit = BodyState {
            pose: Pose::default(),
            linear_velocity: Vec3::X,
            angular_velocity: Vec3::ZERO,
            contacts: 1,
            intact_joints: 0,
            flags: FLAG_CONTACT_BEGIN,
        };
        assert_eq!(classifier.update(hit, cfg), PhysicalClass::ImpactBurst);
        let calm = BodyState { flags: 0, ..hit };
        for _ in 0..(cfg.impact_burst_ticks - 1) {
            assert_eq!(classifier.update(calm, cfg), PhysicalClass::ImpactBurst);
        }
        assert_ne!(classifier.update(calm, cfg), PhysicalClass::ImpactBurst);
    }

    #[test]
    fn predictor_applies_gravity_and_damping() {
        let (pose, velocity, _) = predict_ballistic(
            Pose::default(),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::ZERO,
            PredictorParams {
                gravity: Vec3::new(0.0, -10.0, 0.0),
                linear_damping: 0.0,
                angular_damping: 0.0,
                dt: 0.1,
                steps: 1,
            },
        );
        assert!((pose.position - Vec3::new(0.1, -0.1, 0.0)).length() < 1e-6);
        assert_eq!(velocity, Vec3::new(1.0, -1.0, 0.0));
    }
}
