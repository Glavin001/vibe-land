//! Artifact gates: the things a player calls "wrong" that a positional
//! percentile averages away.
//!
//! The thresholds are the ones `research/destruction-codec`'s state-diff has
//! used since the codec work, ported here so the live-stream scorer and the
//! codec scorer agree on what a freeze or a reversal is. Positional slack is
//! cheap; these are not (codec-verify: "artifact gates are the fidelity
//! contract, not L2 pose error").

use glam::Vec3;

/// A client step under this is "still".
pub const STILL_M: f32 = 0.002;
/// A truth step over this is "moving".
pub const MOVING_M: f32 = 0.02;
/// Still-while-truth-moves for this many consecutive frames is a freeze.
pub const FREEZE_FRAMES: u32 = 5;
/// A client step more than this many times the truth step, and over the
/// floor, is an excess (a jump the physics did not make).
pub const EXCESS_RATIO: f32 = 3.0;
pub const EXCESS_FLOOR_M: f32 = 0.25;
/// Both steps over this and pointing opposite ways is a reversal.
pub const REVERSAL_M: f32 = 0.05;
/// One-frame client step over this is a teleport (the client's own snap
/// distance).
pub const TELEPORT_M: f32 = 5.0;
/// Presented vertical acceleration differing from truth's by more than this
/// while truth is in free flight is a gravity inconsistency. Half of g: a
/// path extrapolated with no gravity, or with double gravity, both trip it;
/// interpolation through centimetre-quantised knots does not.
pub const GRAVITY_MS2: f32 = 5.0;
/// Frames the acceleration is measured over. A second difference over one
/// frame at 60 Hz amplifies a centimetre of knot quantisation into tens of
/// m/s^2; over ten frames it is about one.
pub const GRAVITY_WINDOW_FRAMES: usize = 10;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GateHits {
    pub freeze: bool,
    pub excess: bool,
    pub reversal: bool,
    pub teleport: bool,
    pub gravity: bool,
}

/// Per-body running state the gates need between frames.
#[derive(Clone, Copy, Debug, Default)]
pub struct GateState {
    pub still_run: u32,
    pub frozen: bool,
    /// Vertical positions over the gravity window, presented and truth, plus
    /// how many consecutive frames truth has been in free flight.
    pub presented_y: [f32; GRAVITY_WINDOW_FRAMES + 1],
    pub truth_y: [f32; GRAVITY_WINDOW_FRAMES + 1],
    pub history: u8,
    pub free_run: u32,
}

impl GateState {
    /// `client_step` and `truth_step` are this frame's displacement of the
    /// presented and truth poses; `truth_free` says truth is in free flight.
    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &mut self,
        client_step: Vec3,
        truth_step: Vec3,
        presented_y: f32,
        truth_y: f32,
        truth_free: bool,
        frame_dt: f32,
    ) -> GateHits {
        let mut hits = GateHits::default();
        let client_len = client_step.length();
        let truth_len = truth_step.length();

        if client_len < STILL_M && truth_len > MOVING_M {
            self.still_run += 1;
        } else {
            self.still_run = 0;
            self.frozen = false;
        }
        if self.still_run >= FREEZE_FRAMES {
            // Counted once per freeze, on the frame it becomes one, and again
            // for every further frame it persists -- so the count is frames
            // frozen, not freezes.
            hits.freeze = true;
            self.frozen = true;
        }
        if client_len > TELEPORT_M {
            hits.teleport = true;
        } else if client_len > EXCESS_FLOOR_M && client_len > EXCESS_RATIO * truth_len {
            hits.excess = true;
        }
        if client_len > REVERSAL_M && truth_len > REVERSAL_M && client_step.dot(truth_step) < 0.0 {
            hits.reversal = true;
        }

        self.presented_y.rotate_left(1);
        self.presented_y[GRAVITY_WINDOW_FRAMES] = presented_y;
        self.truth_y.rotate_left(1);
        self.truth_y[GRAVITY_WINDOW_FRAMES] = truth_y;
        self.history = self.history.saturating_add(1);
        self.free_run = if truth_free { self.free_run + 1 } else { 0 };
        let window = GRAVITY_WINDOW_FRAMES as u32;
        if self.history as u32 > window && self.free_run > window && frame_dt > 0.0 {
            let half = GRAVITY_WINDOW_FRAMES / 2;
            let span = (half as f32 * frame_dt).powi(2);
            let accel = |y: &[f32; GRAVITY_WINDOW_FRAMES + 1]| {
                (y[GRAVITY_WINDOW_FRAMES] - 2.0 * y[half] + y[0]) / span
            };
            if (accel(&self.presented_y) - accel(&self.truth_y)).abs() > GRAVITY_MS2
                && client_len >= STILL_M
            {
                hits.gravity = true;
            }
        }
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_freeze_is_detected_at_exactly_freeze_frames() {
        let mut state = GateState::default();
        for frame in 1..=FREEZE_FRAMES + 2 {
            let hits = state.observe(Vec3::ZERO, Vec3::new(0.0, -0.1, 0.0), 0.0, -0.1 * frame as f32, true, 1.0 / 60.0);
            assert_eq!(hits.freeze, frame >= FREEZE_FRAMES, "frame {frame}");
        }
        // Motion clears it.
        let hits = state.observe(Vec3::new(0.0, -0.1, 0.0), Vec3::new(0.0, -0.1, 0.0), -0.1, -0.9, true, 1.0 / 60.0);
        assert!(!hits.freeze);
    }

    #[test]
    fn reversal_teleport_and_excess_are_distinct() {
        let mut state = GateState::default();
        let hits = state.observe(Vec3::new(0.0, 0.1, 0.0), Vec3::new(0.0, -0.1, 0.0), 0.0, 0.0, false, 1.0 / 60.0);
        assert!(hits.reversal && !hits.excess && !hits.teleport);
        let hits = state.observe(Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.01, 0.0, 0.0), 0.0, 0.0, false, 1.0 / 60.0);
        assert!(hits.excess && !hits.teleport);
        let hits = state.observe(Vec3::new(6.0, 0.0, 0.0), Vec3::new(6.0, 0.0, 0.0), 0.0, 0.0, false, 1.0 / 60.0);
        assert!(hits.teleport && !hits.excess);
    }

    /// A presented body held still while truth falls freely is a gravity
    /// inconsistency only once it is also moving (a plain freeze otherwise).
    #[test]
    fn gravity_inconsistency_needs_three_frames_and_free_flight() {
        let mut state = GateState::default();
        let dt = 1.0 / 60.0;
        let g = -9.81f32;
        let mut first_hit = None;
        for frame in 0..30 {
            let t = frame as f32 * dt;
            let truth_y = 0.5 * g * t * t;
            // Presented: moving linearly, no gravity.
            let presented_y = -0.5 * t;
            let hits = state.observe(
                Vec3::new(0.0, -0.5 * dt, 0.0),
                Vec3::new(0.0, g * t * dt, 0.0),
                presented_y,
                truth_y,
                true,
                dt,
            );
            if hits.gravity && first_hit.is_none() {
                first_hit = Some(frame);
            }
        }
        assert_eq!(first_hit, Some(GRAVITY_WINDOW_FRAMES as i32));
        // The same body, presented with the right gravity, never trips it.
        let mut state = GateState::default();
        for frame in 0..30 {
            let t = frame as f32 * dt;
            let y = 0.5 * g * t * t + 0.01 * ((frame % 2) as f32); // a centimetre of knot jitter
            let hits = state.observe(Vec3::new(0.0, g * t * dt, 0.0), Vec3::new(0.0, g * t * dt, 0.0), y, y, true, dt);
            assert!(!hits.gravity, "frame {frame}");
        }
    }
}
