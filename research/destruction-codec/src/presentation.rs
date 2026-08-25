//! Buffered, render-time presentation of sparse rigid-body snapshots.
//!
//! [`PresentationTrack::sample`] is stateful and is intended to be called with
//! monotonically increasing render ticks. The configured interpolation delay is
//! subtracted from the render tick before the snapshot buffer is evaluated.

use std::collections::VecDeque;

use glam::{Quat, Vec3};

use crate::{
    codec::PhysicalClass,
    trace::{ActorDef, Pose},
};

const EPSILON: f32 = 1.0e-6;

#[derive(Clone, Copy, Debug)]
pub struct PresentationConfig {
    pub interpolation_delay_ticks: u32,
    pub max_extrapolation_ticks: u32,
    /// Approximate time in seconds for a late correction to settle.
    pub correction_seconds: f32,
    /// Duration of one physics tick in seconds.
    pub dt: f32,
    pub gravity: Vec3,
    /// Larger path revisions are treated as discontinuous lifecycle moves.
    pub snap_distance_meters: f32,
}

impl Default for PresentationConfig {
    fn default() -> Self {
        Self {
            interpolation_delay_ticks: 2,
            max_extrapolation_ticks: 4,
            correction_seconds: 0.1,
            dt: 1.0 / 60.0,
            gravity: Vec3::new(0.0, -9.81, 0.0),
            snap_distance_meters: 5.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MotionSnapshot {
    pub tick: u32,
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub class: PhysicalClass,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PresentedState {
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub position_correction: Vec3,
    pub rotation_correction_degrees: f32,
    pub correction_linear_velocity: Vec3,
    pub correction_angular_velocity: Vec3,
}

#[derive(Clone, Copy, Debug, Default)]
struct Correction {
    position: Vec3,
    linear_velocity: Vec3,
    rotation: Vec3,
    angular_velocity: Vec3,
}

#[derive(Clone, Copy, Debug)]
struct PreviousSample {
    render_tick: f32,
    state: PresentedState,
    revision: u64,
}

/// Per-actor snapshot buffer and presentation state.
///
/// Snapshots may arrive out of order. A snapshot with an existing timestamp
/// replaces the older value at that timestamp.
pub struct PresentationTrack {
    config: PresentationConfig,
    linear_damping: f32,
    angular_damping: f32,
    snapshots: VecDeque<MotionSnapshot>,
    correction: Correction,
    previous: Option<PreviousSample>,
    revision: u64,
}

impl PresentationTrack {
    pub fn new(actor: &ActorDef, mut config: PresentationConfig) -> Self {
        if !config.dt.is_finite() || config.dt <= 0.0 {
            config.dt = 1.0 / 60.0;
        }
        if !config.correction_seconds.is_finite() || config.correction_seconds < 0.0 {
            config.correction_seconds = 0.0;
        }
        if !config.gravity.is_finite() {
            config.gravity = Vec3::ZERO;
        }
        if !config.snap_distance_meters.is_finite() || config.snap_distance_meters <= 0.0 {
            config.snap_distance_meters = 5.0;
        }

        Self {
            config,
            linear_damping: finite_nonnegative(actor.linear_damping),
            angular_damping: finite_nonnegative(actor.angular_damping),
            snapshots: VecDeque::new(),
            correction: Correction::default(),
            previous: None,
            revision: 0,
        }
    }

    /// Inserts a timestamped snapshot, coalescing snapshots at the same tick.
    pub fn push(&mut self, mut snapshot: MotionSnapshot) {
        snapshot.pose.rotation = normalized(snapshot.pose.rotation);

        match self
            .snapshots
            .binary_search_by_key(&snapshot.tick, |entry| entry.tick)
        {
            Ok(index) => self.snapshots[index] = snapshot,
            Err(index) => self.snapshots.insert(index, snapshot),
        }
        self.revision = self.revision.wrapping_add(1);
    }

    /// Samples the track at a fractional render tick.
    ///
    /// Callers should normally sample in nondecreasing render-tick order.
    /// Sampling an empty track returns [`PresentedState::default`].
    pub fn sample(&mut self, render_tick: f32) -> PresentedState {
        if self.snapshots.is_empty() {
            return PresentedState::default();
        }

        let render_tick = if render_tick.is_finite() {
            render_tick
        } else {
            0.0
        };
        let target_tick = render_tick - self.config.interpolation_delay_ticks as f32;
        let raw = self.raw_state(target_tick);

        let elapsed_seconds = self.previous.map_or(0.0, |previous| {
            ((render_tick - previous.render_tick).max(0.0)) * self.config.dt
        });

        if let Some(previous) = self.previous {
            if render_tick < previous.render_tick {
                self.correction = Correction::default();
            } else if previous.revision != self.revision {
                // Re-anchor the revised path to the pose already on screen.
                // This makes a correction continuous even when a late packet
                // substantially changes the interpolation/extrapolation path.
                let revised_previous = self
                    .raw_state(previous.render_tick - self.config.interpolation_delay_ticks as f32);
                let correction = Correction {
                    position: previous.state.pose.position - revised_previous.pose.position,
                    linear_velocity: previous.linear_velocity() - revised_previous.linear_velocity,
                    rotation: rotation_vector(
                        previous.state.pose.rotation * revised_previous.pose.rotation.conjugate(),
                    ),
                    angular_velocity: previous.state.angular_velocity
                        - revised_previous.angular_velocity,
                };
                self.correction = if correction.position.length() > self.config.snap_distance_meters
                {
                    Correction::default()
                } else {
                    correction
                };
            }
        }

        self.decay_correction(elapsed_seconds);

        let state = PresentedState {
            pose: Pose {
                position: raw.pose.position + self.correction.position,
                rotation: normalized(
                    Quat::from_scaled_axis(self.correction.rotation) * raw.pose.rotation,
                ),
            },
            linear_velocity: raw.linear_velocity + self.correction.linear_velocity,
            angular_velocity: raw.angular_velocity + self.correction.angular_velocity,
            position_correction: self.correction.position,
            rotation_correction_degrees: self.correction.rotation.length().to_degrees(),
            correction_linear_velocity: self.correction.linear_velocity,
            correction_angular_velocity: self.correction.angular_velocity,
        };

        self.previous = Some(PreviousSample {
            render_tick,
            state,
            revision: self.revision,
        });
        self.prune(target_tick);
        state
    }

    fn raw_state(&self, target_tick: f32) -> PresentedState {
        let first = self.snapshots.front().expect("checked by sample");
        if target_tick <= first.tick as f32 {
            return snapshot_state(*first);
        }

        for index in 1..self.snapshots.len() {
            let right = self.snapshots[index];
            if target_tick <= right.tick as f32 {
                let left = self.snapshots[index - 1];
                return interpolate(
                    left,
                    right,
                    target_tick,
                    self.config.dt,
                    self.config.snap_distance_meters,
                );
            }
        }

        self.extrapolate(
            *self.snapshots.back().expect("checked by sample"),
            target_tick,
        )
    }

    fn extrapolate(&self, snapshot: MotionSnapshot, target_tick: f32) -> PresentedState {
        let extra_ticks = (target_tick - snapshot.tick as f32)
            .max(0.0)
            .min(self.config.max_extrapolation_ticks as f32);
        let seconds = extra_ticks * self.config.dt;

        if snapshot.class == PhysicalClass::Quiescent {
            return PresentedState {
                pose: snapshot.pose,
                linear_velocity: Vec3::ZERO,
                angular_velocity: Vec3::ZERO,
                position_correction: Vec3::ZERO,
                rotation_correction_degrees: 0.0,
                correction_linear_velocity: Vec3::ZERO,
                correction_angular_velocity: Vec3::ZERO,
            };
        }

        let gravity = if snapshot.class == PhysicalClass::Ballistic {
            self.config.gravity
        } else {
            Vec3::ZERO
        };
        let (position_delta, linear_velocity) = damped_translation(
            snapshot.linear_velocity,
            gravity,
            self.linear_damping,
            seconds,
        );
        let (angular_delta, angular_velocity) =
            damped_motion(snapshot.angular_velocity, self.angular_damping, seconds);

        PresentedState {
            pose: Pose {
                position: snapshot.pose.position + position_delta,
                rotation: integrate_rotation(snapshot.pose.rotation, angular_delta),
            },
            linear_velocity,
            angular_velocity,
            position_correction: Vec3::ZERO,
            rotation_correction_degrees: 0.0,
            correction_linear_velocity: Vec3::ZERO,
            correction_angular_velocity: Vec3::ZERO,
        }
    }

    fn decay_correction(&mut self, seconds: f32) {
        if self.config.correction_seconds <= EPSILON {
            self.correction = Correction::default();
            return;
        }

        // Four time constants leaves roughly nine percent of a critically
        // damped zero-velocity displacement after correction_seconds.
        let omega = 4.0 / self.config.correction_seconds;
        (self.correction.position, self.correction.linear_velocity) = critical_step(
            self.correction.position,
            self.correction.linear_velocity,
            omega,
            seconds,
        );
        (self.correction.rotation, self.correction.angular_velocity) = critical_step(
            self.correction.rotation,
            self.correction.angular_velocity,
            omega,
            seconds,
        );
    }

    fn prune(&mut self, target_tick: f32) {
        // Keep one older sample plus the next sample. If all samples are old,
        // retain the last two so a late replacement can still reconcile from
        // the previous segment without unbounded buffer growth.
        while self.snapshots.len() > 2 && self.snapshots[1].tick as f32 <= target_tick {
            self.snapshots.pop_front();
        }
    }
}

impl PreviousSample {
    fn linear_velocity(self) -> Vec3 {
        self.state.linear_velocity
    }
}

fn snapshot_state(snapshot: MotionSnapshot) -> PresentedState {
    PresentedState {
        pose: snapshot.pose,
        linear_velocity: snapshot.linear_velocity,
        angular_velocity: snapshot.angular_velocity,
        position_correction: Vec3::ZERO,
        rotation_correction_degrees: 0.0,
        correction_linear_velocity: Vec3::ZERO,
        correction_angular_velocity: Vec3::ZERO,
    }
}

fn interpolate(
    left: MotionSnapshot,
    right: MotionSnapshot,
    target_tick: f32,
    dt: f32,
    snap_distance_meters: f32,
) -> PresentedState {
    let tick_span = (right.tick - left.tick) as f32;
    if tick_span <= 0.0 {
        return snapshot_state(right);
    }
    let seconds = tick_span * dt;
    let plausible_motion = left
        .linear_velocity
        .length()
        .max(right.linear_velocity.length())
        * seconds;
    if left.pose.position.distance(right.pose.position) > plausible_motion + snap_distance_meters {
        return if target_tick < right.tick as f32 {
            snapshot_state(left)
        } else {
            snapshot_state(right)
        };
    }

    let u = ((target_tick - left.tick as f32) / tick_span).clamp(0.0, 1.0);
    let u2 = u * u;
    let u3 = u2 * u;
    let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
    let h10 = u3 - 2.0 * u2 + u;
    let h01 = -2.0 * u3 + 3.0 * u2;
    let h11 = u3 - u2;

    let position = h00 * left.pose.position
        + h10 * seconds * left.linear_velocity
        + h01 * right.pose.position
        + h11 * seconds * right.linear_velocity;

    let dh00 = 6.0 * u2 - 6.0 * u;
    let dh10 = 3.0 * u2 - 4.0 * u + 1.0;
    let dh01 = -dh00;
    let dh11 = 3.0 * u2 - 2.0 * u;
    let linear_velocity = (dh00 * left.pose.position
        + dh10 * seconds * left.linear_velocity
        + dh01 * right.pose.position
        + dh11 * seconds * right.linear_velocity)
        / seconds;

    PresentedState {
        pose: Pose {
            position,
            rotation: shortest_slerp(left.pose.rotation, right.pose.rotation, u),
        },
        linear_velocity,
        angular_velocity: left.angular_velocity.lerp(right.angular_velocity, u),
        position_correction: Vec3::ZERO,
        rotation_correction_degrees: 0.0,
        correction_linear_velocity: Vec3::ZERO,
        correction_angular_velocity: Vec3::ZERO,
    }
}

fn damped_translation(
    initial_velocity: Vec3,
    acceleration: Vec3,
    damping: f32,
    seconds: f32,
) -> (Vec3, Vec3) {
    if damping <= EPSILON {
        return (
            initial_velocity * seconds + 0.5 * acceleration * seconds * seconds,
            initial_velocity + acceleration * seconds,
        );
    }

    let decay = (-damping * seconds).exp();
    let velocity_factor = (1.0 - decay) / damping;
    let terminal_velocity = acceleration / damping;
    let velocity = terminal_velocity + (initial_velocity - terminal_velocity) * decay;
    let displacement =
        terminal_velocity * seconds + (initial_velocity - terminal_velocity) * velocity_factor;
    (displacement, velocity)
}

fn damped_motion(initial: Vec3, damping: f32, seconds: f32) -> (Vec3, Vec3) {
    if damping <= EPSILON {
        return (initial * seconds, initial);
    }

    let decay = (-damping * seconds).exp();
    (initial * ((1.0 - decay) / damping), initial * decay)
}

fn integrate_rotation(rotation: Quat, angular_delta: Vec3) -> Quat {
    normalized(Quat::from_scaled_axis(angular_delta) * rotation)
}

fn shortest_slerp(start: Quat, end: Quat, amount: f32) -> Quat {
    let start = normalized(start);
    let mut end = normalized(end);
    if start.dot(end) < 0.0 {
        end = -end;
    }
    normalized(start.slerp(end, amount))
}

fn rotation_vector(rotation: Quat) -> Vec3 {
    let mut rotation = normalized(rotation);
    if rotation.w < 0.0 {
        rotation = -rotation;
    }

    let vector = Vec3::new(rotation.x, rotation.y, rotation.z);
    let sin_half = vector.length();
    if sin_half <= EPSILON {
        return vector * 2.0;
    }

    vector * (2.0 * sin_half.atan2(rotation.w.clamp(-1.0, 1.0)) / sin_half)
}

fn critical_step(position: Vec3, velocity: Vec3, omega: f32, seconds: f32) -> (Vec3, Vec3) {
    if seconds <= 0.0 {
        return (position, velocity);
    }

    let offset = velocity + omega * position;
    let decay = (-omega * seconds).exp();
    (
        (position + offset * seconds) * decay,
        (velocity - omega * offset * seconds) * decay,
    )
}

fn normalized(rotation: Quat) -> Quat {
    if rotation.is_finite() && rotation.length_squared() > EPSILON {
        rotation.normalize()
    } else {
        Quat::IDENTITY
    }
}

fn finite_nonnegative(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(linear_damping: f32, angular_damping: f32) -> ActorDef {
        ActorDef {
            id: 7,
            part: 0,
            linear_damping,
            angular_damping,
            shapes: Vec::new(),
            bounding_radius: 1.0,
        }
    }

    fn config() -> PresentationConfig {
        PresentationConfig {
            interpolation_delay_ticks: 0,
            max_extrapolation_ticks: 4,
            correction_seconds: 0.5,
            dt: 1.0,
            gravity: Vec3::new(0.0, -10.0, 0.0),
            snap_distance_meters: 5.0,
        }
    }

    fn snapshot(
        tick: u32,
        position: Vec3,
        linear_velocity: Vec3,
        class: PhysicalClass,
    ) -> MotionSnapshot {
        MotionSnapshot {
            tick,
            pose: Pose {
                position,
                rotation: Quat::IDENTITY,
            },
            linear_velocity,
            angular_velocity: Vec3::ZERO,
            class,
        }
    }

    fn assert_near(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1.0e-4,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn hermite_is_exact_at_endpoints_and_nearby() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.push(snapshot(
            0,
            Vec3::ZERO,
            Vec3::new(2.0, 0.0, 0.0),
            PhysicalClass::ContactActive,
        ));
        track.push(snapshot(
            10,
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::new(-1.0, 0.0, 0.0),
            PhysicalClass::ContactActive,
        ));

        let start = track.sample(0.0);
        assert_eq!(start.pose.position, Vec3::ZERO);
        assert_eq!(start.linear_velocity, Vec3::new(2.0, 0.0, 0.0));

        let near_end = track.sample(9.999);
        assert!((near_end.pose.position.x - 10.0).abs() < 0.002);
        let end = track.sample(10.0);
        assert_near(end.pose.position.x, 10.0);
        assert_near(end.linear_velocity.x, -1.0);
    }

    #[test]
    fn moving_contact_body_does_not_freeze_between_sparse_updates() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.push(snapshot(
            0,
            Vec3::ZERO,
            Vec3::X,
            PhysicalClass::ContactActive,
        ));
        track.push(snapshot(
            10,
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::X,
            PhysicalClass::ContactActive,
        ));

        let a = track.sample(3.0).pose.position.x;
        let b = track.sample(4.0).pose.position.x;
        assert_near(a, 3.0);
        assert_near(b, 4.0);
        assert!(b > a);
    }

    #[test]
    fn ballistic_extrapolation_applies_gravity() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.push(snapshot(
            0,
            Vec3::ZERO,
            Vec3::new(2.0, 0.0, 0.0),
            PhysicalClass::Ballistic,
        ));

        let state = track.sample(1.0);
        assert_near(state.pose.position.x, 2.0);
        assert_near(state.pose.position.y, -5.0);
        assert_near(state.linear_velocity.y, -10.0);
    }

    #[test]
    fn extrapolation_is_bounded() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.config.max_extrapolation_ticks = 2;
        track.push(snapshot(
            0,
            Vec3::ZERO,
            Vec3::X,
            PhysicalClass::ContactActive,
        ));

        let at_limit = track.sample(2.0);
        let much_later = track.sample(100.0);
        assert_eq!(at_limit.pose.position, much_later.pose.position);
        assert_eq!(at_limit.linear_velocity, much_later.linear_velocity);
    }

    #[test]
    fn same_tick_snapshots_are_coalesced() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.push(snapshot(3, Vec3::X, Vec3::ZERO, PhysicalClass::Quiescent));
        track.push(snapshot(
            3,
            Vec3::new(9.0, 0.0, 0.0),
            Vec3::ZERO,
            PhysicalClass::Quiescent,
        ));

        assert_eq!(track.snapshots.len(), 1);
        assert_near(track.sample(3.0).pose.position.x, 9.0);
    }

    #[test]
    fn late_correction_does_not_cause_a_position_jump() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.config.snap_distance_meters = 1_000.0;
        track.push(snapshot(
            0,
            Vec3::ZERO,
            Vec3::X,
            PhysicalClass::ContactActive,
        ));
        let before = track.sample(4.0);
        assert_near(before.pose.position.x, 4.0);

        track.push(snapshot(
            4,
            Vec3::new(100.0, 0.0, 0.0),
            Vec3::ZERO,
            PhysicalClass::ContactActive,
        ));
        let corrected = track.sample(4.0);
        assert_near(corrected.pose.position.x, before.pose.position.x);

        let next = track.sample(4.01);
        assert!((next.pose.position.x - corrected.pose.position.x).abs() < 1.0);
        assert!(next.pose.position.x < 100.0);
    }

    #[test]
    fn discontinuous_lifecycle_move_is_not_smoothed_across_world() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        track.push(snapshot(
            0,
            Vec3::new(-100.0, 0.0, 0.0),
            Vec3::ZERO,
            PhysicalClass::Quiescent,
        ));
        track.sample(1.0);
        track.push(snapshot(
            1,
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::X,
            PhysicalClass::Ballistic,
        ));
        let spawned = track.sample(1.0);
        assert_eq!(spawned.pose.position, Vec3::new(10.0, 0.0, 0.0));
        assert_eq!(spawned.position_correction, Vec3::ZERO);
    }

    #[test]
    fn quaternion_interpolation_takes_the_shortest_path() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        let start = snapshot(0, Vec3::ZERO, Vec3::ZERO, PhysicalClass::ContactActive);
        let mut end = snapshot(10, Vec3::ZERO, Vec3::ZERO, PhysicalClass::ContactActive);
        end.pose.rotation = -Quat::from_rotation_y(0.2);
        track.push(start);
        track.push(end);

        let midpoint = track.sample(5.0).pose.rotation;
        let expected = Quat::from_rotation_y(0.1);
        assert!(midpoint.dot(expected).abs() > 0.99999);
    }

    #[test]
    fn pruning_keeps_previous_bracketing_snapshot() {
        let mut track = PresentationTrack::new(&actor(0.0, 0.0), config());
        for tick in 0..6 {
            track.push(snapshot(
                tick,
                Vec3::X * tick as f32,
                Vec3::X,
                PhysicalClass::ContactActive,
            ));
        }

        track.sample(3.5);
        assert_eq!(track.snapshots.front().unwrap().tick, 3);
        assert_eq!(track.snapshots[1].tick, 4);
    }
}
