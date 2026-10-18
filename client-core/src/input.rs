//! The local player's input: sampled by the renderer each frame, cut into the server's fixed 60 Hz
//! input frames and quantised the way the server decodes them.
//!
//! Port of the web client's `runtime/fixedInputBundler.ts` and `scene/inputBuilder.ts`: one frame
//! per `1/sim_hz` of renderer time, at most [`MAX_CATCHUP_STEPS`] per call (a long stall does not
//! flood the server), the remainder clamped to one step; sequence numbers start at 1 and wrap at
//! u16. Axes become `round(axis · 127)`, and their direction bits are OR'd into the buttons
//! (`shared::movement::build_wish_dir` falls back to them when the axes are zero).

use vibe_land_shared::constants::{BTN_BACK, BTN_FORWARD, BTN_LEFT, BTN_RIGHT, BTN_SECONDARY_FIRE};
use vibe_land_shared::net_client::js_round;
use vibe_land_shared::protocol::InputFrame;

/// Frames emitted per call at most (`CLIENT_MAX_CATCHUP_STEPS` on the web).
pub const MAX_CATCHUP_STEPS: u32 = 4;

/// What the player is doing now, in server space: axes in [-1, 1] (`move_x` right, `move_y`
/// forward), view angles in radians, `BTN_*` bits.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputState {
    pub move_x: f32,
    pub move_y: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub buttons: u16,
}

/// An axis in [-1, 1] as the frame's i8, as `inputBuilder.ts` `axisToMove` computes it (f64,
/// `Math.round`); a non-finite axis is 0.
pub fn axis_i8(value: f64) -> i8 {
    if !value.is_finite() {
        return 0;
    }
    js_round(value * 127.0).clamp(-127.0, 127.0) as i8
}

/// One input frame as the server will read it.
pub fn quantise(seq: u16, input: &InputState) -> InputFrame {
    quantise_web(
        seq,
        f64::from(input.move_x),
        f64::from(input.move_y),
        f64::from(input.yaw),
        f64::from(input.pitch),
        input.buttons,
    )
}

/// One input frame from the web's numbers (`buildInputFromState`): the axes and their direction
/// bits; the view angles are carried as given (the encoder quantises them).
pub fn quantise_web(
    seq: u16,
    move_x: f64,
    move_y: f64,
    yaw: f64,
    pitch: f64,
    buttons: u16,
) -> InputFrame {
    let (move_x, move_y) = (axis_i8(move_x), axis_i8(move_y));
    let mut buttons = buttons & !BTN_SECONDARY_FIRE;
    if move_x > 0 {
        buttons |= BTN_RIGHT;
    } else if move_x < 0 {
        buttons |= BTN_LEFT;
    }
    if move_y > 0 {
        buttons |= BTN_FORWARD;
    } else if move_y < 0 {
        buttons |= BTN_BACK;
    }
    let finite = |v: f64| if v.is_finite() { v as f32 } else { 0.0 };
    InputFrame {
        seq,
        buttons,
        move_x,
        move_y,
        yaw: finite(yaw),
        pitch: finite(pitch),
    }
}

pub struct InputBundler {
    step_s: f64,
    accumulator_s: f64,
    next_seq: u16,
    max_catchup: u32,
}

impl InputBundler {
    pub fn new(sim_hz: u32) -> Self {
        Self::with_step(1.0 / f64::from(sim_hz.max(1)), MAX_CATCHUP_STEPS)
    }

    /// A bundler with the web's `FixedInputBundler(fixedDtSec, maxCatchupSteps)` parameters.
    pub fn with_step(step_s: f64, max_catchup: u32) -> Self {
        Self {
            step_s,
            accumulator_s: 0.0,
            next_seq: 1,
            max_catchup,
        }
    }

    /// Start again from `next_seq` with nothing accumulated (`reset`).
    pub fn reset(&mut self, next_seq: u16) {
        self.accumulator_s = 0.0;
        self.next_seq = next_seq;
    }

    /// The time accumulated toward the next frame, at most one step (`remainderSec`).
    pub fn remainder_s(&self) -> f64 {
        self.accumulator_s.clamp(0.0, self.step_s)
    }

    /// The sequence number the next frame will carry (fire commands are stamped with it).
    pub fn next_seq(&self) -> u16 {
        self.next_seq
    }

    /// Advance by `dt_s` of renderer time; the frames due, oldest first.
    pub fn produce(&mut self, dt_s: f64, input: &InputState) -> Vec<InputFrame> {
        self.produce_with(dt_s, |seq| quantise(seq, input))
    }

    /// [`produce`](Self::produce) with the frame built by `frame` from its sequence number.
    pub fn produce_with(
        &mut self,
        dt_s: f64,
        mut frame: impl FnMut(u16) -> InputFrame,
    ) -> Vec<InputFrame> {
        if dt_s.is_finite() && dt_s > 0.0 {
            self.accumulator_s += dt_s;
        }
        let mut frames = Vec::new();
        while self.accumulator_s >= self.step_s && (frames.len() as u32) < self.max_catchup {
            frames.push(frame(self.next_seq));
            self.next_seq = self.next_seq.wrapping_add(1);
            self.accumulator_s -= self.step_s;
        }
        self.accumulator_s = self.accumulator_s.min(self.step_s);
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_frame_per_step_with_capped_catchup() {
        let mut b = InputBundler::new(60);
        let input = InputState::default();
        assert!(b.produce(0.5 / 60.0, &input).is_empty());
        let frames = b.produce(0.6 / 60.0, &input);
        assert_eq!(frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![1]);
        // A one-second stall: four frames, and only one step of backlog survives.
        assert_eq!(b.produce(1.0, &input).len(), 4);
        assert_eq!(b.produce(0.0, &input).len(), 1);
        assert!(b.produce(0.0, &input).is_empty());
        assert_eq!(b.next_seq(), 7);
    }

    #[test]
    fn sixty_frames_a_second_at_any_frame_rate() {
        for fps in [30.0f64, 59.94, 60.0, 144.0, 240.0] {
            let mut b = InputBundler::new(60);
            let n: usize = (0..(fps * 10.0) as usize)
                .map(|_| b.produce(1.0 / fps, &InputState::default()).len())
                .sum();
            assert!((n as i64 - 600).abs() <= 1, "{fps} fps: {n} frames in 10 s");
        }
    }

    #[test]
    fn axes_quantise_and_set_direction_bits() {
        let f = quantise(
            5,
            &InputState {
                move_x: -1.0,
                move_y: 0.5,
                buttons: BTN_SECONDARY_FIRE,
                ..Default::default()
            },
        );
        assert_eq!((f.move_x, f.move_y), (-127, 64));
        assert_eq!(f.buttons, BTN_LEFT | BTN_FORWARD);
        let f = quantise(
            5,
            &InputState {
                move_x: 3.0,
                move_y: f32::NAN,
                ..Default::default()
            },
        );
        assert_eq!((f.move_x, f.move_y, f.buttons), (127, 0, BTN_RIGHT));
    }

    #[test]
    fn sequence_wraps() {
        let mut b = InputBundler::new(60);
        b.next_seq = u16::MAX;
        let frames = b.produce(2.0 / 60.0 + 1e-9, &InputState::default());
        assert_eq!(
            frames.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![u16::MAX, 0]
        );
    }
}
