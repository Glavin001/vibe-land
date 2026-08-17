//! Motion-masked precision: how coarsely each body may be reconstructed.
//!
//! Humans are poor judges of absolute position error in fast, cluttered motion
//! and acute detectors of a short list of qualitative artifacts -- freezes,
//! reversals, gravity-inconsistent acceleration, interpenetration. Fast motion
//! actively suppresses change detection (motion silencing), and the same
//! principle is what video encoders exploit when they coarsen quantization on
//! high-activity macroblocks.
//!
//! So the shell bound stops being a single global constant and becomes a
//! function of each body's own motion: tight when it is settling or at rest,
//! loose while it is tumbling through a collapse. The artifact detectors in
//! `metrics.rs` stay hard gates -- this trades only positional precision, and
//! only where the research says it cannot be resolved.
//!
//! Purely an encoder-side decision. The receiver applies whatever repairs
//! arrive and never needs to know which bound produced them, so this changes
//! no wire format and requires no determinism.

use glam::Vec3;
use serde::Serialize;

use crate::trace::{ActorDef, Tick};

#[derive(Clone, Copy, Debug)]
pub struct MaskConfig {
    pub enabled: bool,
    /// Bound applied to a body at rest -- the quality floor.
    pub base_m: f32,
    /// Loosest bound any body may reach, however fast it is moving.
    ///
    /// The default of 4x base is the measured perceptual ceiling on collapse
    /// content: at 4x every acceptance criterion passes and rendered output
    /// shows no localized stall against the unmasked reconstruction, while at
    /// 8x pixel and excess-step error cross their thresholds monotonically and
    /// rendered tile SSIM drops. Validated on one scenario; re-check when more
    /// exist.
    pub cap_m: f32,
    /// Motion at or below which no masking applies, in metres/second.
    pub motion_low: f32,
    /// Motion at or above which the full cap applies.
    pub motion_high: f32,
    /// Multiplier applied to the previous scale when motion drops, per block.
    /// Bounds loosen instantly but recover gradually, so a body coming to rest
    /// is corrected through the receiver's damped path rather than snapping.
    pub tighten_factor: f32,
}

impl Default for MaskConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_m: 0.005,
            cap_m: 0.020,
            motion_low: 0.5,
            motion_high: 5.0,
            tighten_factor: 0.5,
        }
    }
}

impl MaskConfig {
    /// Loosest bound that can ever be emitted, for validation and gating.
    pub fn ceiling_m(&self) -> f32 {
        if self.enabled {
            self.cap_m.max(self.base_m)
        } else {
            self.base_m
        }
    }

    pub(crate) fn target_scale(&self, motion: f32) -> f32 {
        let ceiling = (self.cap_m / self.base_m).max(1.0);
        if motion <= self.motion_low {
            return 1.0;
        }
        if motion >= self.motion_high {
            return ceiling;
        }
        let span = (self.motion_high - self.motion_low).max(f32::EPSILON);
        1.0 + (ceiling - 1.0) * ((motion - self.motion_low) / span)
    }
}

/// Per-actor masking state, carried across blocks so the tighten-rate limit
/// spans them rather than resetting at every block boundary.
#[derive(Clone, Debug, Default)]
pub struct MaskState {
    scale: Vec<f32>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MaskTelemetry {
    pub masked_actor_blocks: u64,
    pub total_actor_blocks: u64,
    pub scale_sum: f64,
    pub scale_max: f32,
    pub bound_max_m: f32,
}

impl MaskTelemetry {
    pub fn masked_pct(&self) -> f64 {
        if self.total_actor_blocks == 0 {
            0.0
        } else {
            100.0 * self.masked_actor_blocks as f64 / self.total_actor_blocks as f64
        }
    }

    pub fn scale_mean(&self) -> f64 {
        if self.total_actor_blocks == 0 {
            1.0
        } else {
            self.scale_sum / self.total_actor_blocks as f64
        }
    }
}

impl MaskState {
    /// Per-actor shell bounds for one block.
    ///
    /// Motion is the peak over the block of linear speed plus angular speed
    /// scaled by the body's radius -- the same combination `rigid_shell_error`
    /// uses, so the metric that decides the bound and the metric the bound is
    /// applied to agree. Peak rather than mean because a body that is briefly
    /// fast within the block is masked for the whole of it, which is the
    /// conservative direction for a block-granular decision.
    pub fn bounds_for_block(
        &mut self,
        ticks: &[Tick],
        actors: &[ActorDef],
        config: &MaskConfig,
        telemetry: &mut MaskTelemetry,
    ) -> Vec<f32> {
        if !config.enabled {
            return vec![config.base_m; actors.len()];
        }
        if self.scale.len() != actors.len() {
            self.scale = vec![1.0; actors.len()];
        }
        let mut motion = vec![0.0_f32; actors.len()];
        for tick in ticks {
            for (actor, state) in tick.states.iter().enumerate() {
                let radius = actors[actor].bounding_radius;
                let combined =
                    state.linear_velocity.length() + state.angular_velocity.length() * radius;
                if combined > motion[actor] {
                    motion[actor] = combined;
                }
            }
        }
        let mut bounds = vec![config.base_m; actors.len()];
        for actor in 0..actors.len() {
            let target = config.target_scale(motion[actor]);
            let previous = self.scale[actor].max(1.0);
            // Loosen immediately, tighten at a bounded rate.
            let scale = if target >= previous {
                target
            } else {
                (previous * config.tighten_factor).max(target).max(1.0)
            };
            self.scale[actor] = scale;
            bounds[actor] = (config.base_m * scale).min(config.cap_m);
            telemetry.total_actor_blocks += 1;
            if scale > 1.0 {
                telemetry.masked_actor_blocks += 1;
            }
            telemetry.scale_sum += scale as f64;
            telemetry.scale_max = telemetry.scale_max.max(scale);
            telemetry.bound_max_m = telemetry.bound_max_m.max(bounds[actor]);
        }
        bounds
    }

    /// Current scale for one actor; 1.0 means fully tightened to the base bound.
    pub fn scale_of(&self, actor: usize) -> f32 {
        self.scale.get(actor).copied().unwrap_or(1.0)
    }
}

/// Motion magnitude of a single body, in the same units the bound is expressed
/// in. Exposed so callers can report why a body was masked.
pub fn motion_magnitude(linear: Vec3, angular: Vec3, radius: f32) -> f32 {
    linear.length() + angular.length() * radius
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{ActorState, Pose, TopologyTick};

    fn config() -> MaskConfig {
        MaskConfig {
            enabled: true,
            ..MaskConfig::default()
        }
    }

    fn actor(radius: f32) -> ActorDef {
        ActorDef {
            id: 0,
            part: 0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            shapes: Vec::new(),
            bounding_radius: radius,
        }
    }

    fn tick(index: u32, velocity: Vec3) -> Tick {
        Tick {
            index,
            simulation_time: index as f32 / 120.0,
            states: vec![ActorState {
                pose: Pose::default(),
                linear_velocity: velocity,
                angular_velocity: Vec3::ZERO,
                contacts: 0,
                intact_joints: 0,
                flags: 0,
            }],
            contact_pairs: Vec::new(),
            topology: TopologyTick::default(),
        }
    }

    #[test]
    fn a_body_at_rest_keeps_the_base_bound() {
        let mut state = MaskState::default();
        let mut telemetry = MaskTelemetry::default();
        let bounds = state.bounds_for_block(
            &[tick(0, Vec3::ZERO)],
            &[actor(1.0)],
            &config(),
            &mut telemetry,
        );
        assert_eq!(bounds[0], config().base_m);
        assert_eq!(telemetry.masked_actor_blocks, 0);
    }

    #[test]
    fn a_fast_body_reaches_the_cap_but_never_exceeds_it() {
        let mut state = MaskState::default();
        let mut telemetry = MaskTelemetry::default();
        let bounds = state.bounds_for_block(
            &[tick(0, Vec3::new(50.0, 0.0, 0.0))],
            &[actor(1.0)],
            &config(),
            &mut telemetry,
        );
        assert_eq!(bounds[0], config().cap_m);
        assert!(bounds[0] <= config().ceiling_m());
    }

    #[test]
    fn the_bound_tightens_gradually_and_settles_at_base() {
        // Deliberately a looser cap than the shipped default: at the default
        // 2x, one halving reaches base in a single block, which would not
        // exercise the rate limit this test exists to cover.
        let configuration = MaskConfig {
            cap_m: 0.040,
            ..config()
        };
        let mut state = MaskState::default();
        let mut telemetry = MaskTelemetry::default();
        let actors = [actor(1.0)];
        // One fast block, then rest. The bound must not snap straight back:
        // a body coming to a stop is corrected through the damped path.
        let fast = state.bounds_for_block(
            &[tick(0, Vec3::new(50.0, 0.0, 0.0))],
            &actors,
            &configuration,
            &mut telemetry,
        )[0];
        assert_eq!(fast, configuration.cap_m);
        let mut previous = fast;
        let mut blocks = 0;
        loop {
            let bound =
                state.bounds_for_block(&[tick(1, Vec3::ZERO)], &actors, &configuration, &mut telemetry)[0];
            assert!(bound <= previous, "bound must not loosen while at rest");
            blocks += 1;
            if (bound - configuration.base_m).abs() < f32::EPSILON {
                break;
            }
            assert!(blocks < 32, "bound never returned to base");
            previous = bound;
        }
        assert!(blocks > 1, "bound snapped back in a single block");
    }

    #[test]
    fn masking_disabled_reproduces_the_base_bound_everywhere() {
        let mut state = MaskState::default();
        let mut telemetry = MaskTelemetry::default();
        let configuration = MaskConfig::default();
        let bounds = state.bounds_for_block(
            &[tick(0, Vec3::new(50.0, 0.0, 0.0))],
            &[actor(1.0), actor(2.0)],
            &configuration,
            &mut telemetry,
        );
        assert!(bounds.iter().all(|&bound| bound == configuration.base_m));
    }
}
