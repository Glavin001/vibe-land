//! Vehicle input pacing (`VIBE_VEHICLE_INPUT_PACING=1`, off by default).
//!
//! The server applies a driver's inputs one per tick. Shipping, it repeats the
//! last input when the queue is empty and collapses a backlog of
//! `VEHICLE_INPUT_CATCHUP_THRESHOLD` or more to the newest: each such tick
//! applies an input the driver's prediction did not, and the next snapshot
//! corrects the car. Measured live, hundreds to thousands a minute
//! (docs/vehicle-city-measurement.md).
//!
//! Pacing is the standard remedy, a jitter buffer whose depth the client
//! steers by running its input clock slightly fast or slow (Overwatch: Tim
//! Ford, "Overwatch Gameplay Architecture and Netcode", GDC 2017). The server:
//!
//! - accepts any input newer than the last it applied, in sequence order, so
//!   a packet overtaken by a later one still lands in its place
//!   ([`enqueue_ordered`]); the client resends every unacked input;
//! - never collapses the queue;
//! - measures each input's lateness (arrival tick against sequence) and
//!   reports a target depth: the spread of lateness from its least to its
//!   95th percentile ([`ArrivalJitter`]). A queue that deep absorbs 95% of the
//!   arrival jitter, as a playout buffer sized from a delay quantile does
//!   (WebRTC NetEq). The quantile matches the client's render clock. The
//!   client's input clock runs at its own rate (and, pacing, deliberately
//!   off real time), so lateness is taken after removing that rate, the
//!   linear trend of arrival against sequence (clock skew removal: Moon,
//!   Skelly and Towsley, "Estimation and removal of clock skew from network
//!   delay measurements", IEEE INFOCOM 1999). Without it, pacing's own drift
//!   read as jitter, raised the target and paced harder: live, the queue grew
//!   from 5 to 18 inputs in 12 s.
//!
//! The pipeline was chosen in simulation
//! (`client/netlab/vehicle/inputPipeline.ts`): on LTE at 60 Hz, 1,533
//! mispredicted ticks a minute shipping against 0.9 paced, for about 4 ticks
//! more input delay.

use std::collections::VecDeque;

use vibe_land_shared::seq::seq_is_newer;

use crate::protocol::InputCmd;

/// Quantile of input lateness the queue absorbs.
pub const TARGET_QUANTILE: f32 = 0.95;
/// Inputs whose lateness sets the target: two seconds at 60 Hz, the window
/// simulated.
pub const JITTER_WINDOW: usize = 120;

/// Input lateness, and the queue depth that absorbs its jitter.
#[derive(Debug, Default)]
pub struct ArrivalJitter {
    /// (unwrapped sequence, arrival tick) of each input's first arrival, newest last.
    arrivals: VecDeque<(i64, i64)>,
    last_seq: Option<u16>,
    unwrapped: i64,
}

impl ArrivalJitter {
    /// An input `seq` reached the server before simulating `tick`. Only the
    /// first arrival of each sequence counts (resends are copies of it).
    pub fn observe(&mut self, seq: u16, tick: u32) {
        match self.last_seq {
            None => self.unwrapped = seq as i64,
            Some(last) if seq_is_newer(seq, last) => {
                self.unwrapped += seq.wrapping_sub(last) as i64;
            }
            Some(_) => return,
        }
        self.last_seq = Some(seq);
        self.arrivals.push_back((self.unwrapped, tick as i64));
        while self.arrivals.len() > JITTER_WINDOW {
            self.arrivals.pop_front();
        }
    }

    /// The queue depth (inputs left after a tick) that absorbs the
    /// [`TARGET_QUANTILE`] of arrival jitter; None before any input.
    pub fn target(&self) -> Option<u8> {
        let n = self.arrivals.len();
        if n == 0 {
            return None;
        }
        // Ticks per input: the least-squares slope of arrival on sequence
        // (1 when the client's clock runs at the server's). Estimated over a
        // full window only: on a few inputs a line fits their jitter too.
        let (x0, y0) = self.arrivals[0];
        let mean = |f: fn(&(i64, i64)) -> i64, origin: i64| {
            self.arrivals.iter().map(|a| (f(a) - origin) as f64).sum::<f64>() / n as f64
        };
        let (mx, my) = (mean(|a| a.0, x0), mean(|a| a.1, y0));
        let (mut sxy, mut sxx) = (0.0, 0.0);
        for &(x, y) in &self.arrivals {
            let (dx, dy) = ((x - x0) as f64 - mx, (y - y0) as f64 - my);
            sxy += dx * dy;
            sxx += dx * dx;
        }
        let slope = if n == JITTER_WINDOW && sxx > 0.0 { sxy / sxx } else { 1.0 };
        let mut lateness: Vec<f64> =
            self.arrivals.iter().map(|&(x, y)| (y - y0) as f64 - slope * (x - x0) as f64).collect();
        lateness.sort_unstable_by(f64::total_cmp);
        let at = ((TARGET_QUANTILE * n as f32) as usize).min(n - 1);
        // Arrivals are whole ticks: a fractional spread is the fit's residue
        // (a straggler tilts the line by 1e-4 a tick), so the nearest tick.
        let spread = (lateness[at] - lateness[0]).round();
        Some(spread.clamp(0.0, u8::MAX as f64) as u8)
    }
}

/// Queue `cmd` in sequence order unless it is not newer than `last_applied`
/// or already queued. Keeps at most `max` (the oldest go).
pub fn enqueue_ordered(queue: &mut VecDeque<InputCmd>, last_applied: u16, cmd: InputCmd, max: usize) {
    if !seq_is_newer(cmd.seq, last_applied) {
        return;
    }
    // Most inputs are the newest: search from the back.
    let mut at = queue.len();
    while at > 0 {
        let queued = queue[at - 1].seq;
        if queued == cmd.seq {
            return;
        }
        if seq_is_newer(cmd.seq, queued) {
            break;
        }
        at -= 1;
    }
    queue.insert(at, cmd);
    while queue.len() > max {
        queue.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lateness 0..=9 ticks, each 12 times in 120, in a seeded shuffle:
    /// jitter, uncorrelated with sequence.
    fn shuffled_lateness() -> Vec<u32> {
        let mut values: Vec<u32> = (0..120).map(|i| i % 10).collect();
        let mut state = 0x2545_f491_u32;
        for i in (1..values.len()).rev() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            values.swap(i, state as usize % (i + 1));
        }
        values
    }

    /// The true spread is 9. The clock-rate fit over 120 inputs carries a
    /// standard error of about sd(jitter) / (sd(seq) sqrt(n)) = 2.9 / (34.6 x
    /// 11) = 0.008 ticks per input: under half a tick across the window, so
    /// the target is the spread or one more.
    const SPREAD_9: std::ops::RangeInclusive<u8> = 9..=10;

    fn cmd(seq: u16) -> InputCmd {
        InputCmd { seq, ..InputCmd::default() }
    }

    fn seqs(queue: &VecDeque<InputCmd>) -> Vec<u16> {
        queue.iter().map(|c| c.seq).collect()
    }

    #[test]
    fn an_overtaken_input_lands_in_its_place() {
        let mut queue = VecDeque::new();
        for seq in [11, 13, 12, 14] {
            enqueue_ordered(&mut queue, 10, cmd(seq), 120);
        }
        assert_eq!(seqs(&queue), [11, 12, 13, 14]);
    }

    #[test]
    fn resends_and_applied_inputs_are_ignored() {
        let mut queue = VecDeque::new();
        // The client resends every unacked input: 9 and 10 were applied.
        for seq in [9, 10, 11, 12, 11, 12, 13] {
            enqueue_ordered(&mut queue, 10, cmd(seq), 120);
        }
        assert_eq!(seqs(&queue), [11, 12, 13]);
    }

    #[test]
    fn ordering_survives_sequence_wraparound() {
        let mut queue = VecDeque::new();
        for seq in [1, 0xffff, 0, 2] {
            enqueue_ordered(&mut queue, 0xfffe, cmd(seq), 120);
        }
        assert_eq!(seqs(&queue), [0xffff, 0, 1, 2]);
    }

    #[test]
    fn a_full_queue_drops_its_oldest() {
        let mut queue = VecDeque::new();
        for seq in 1..=5 {
            enqueue_ordered(&mut queue, 0, cmd(seq), 3);
        }
        assert_eq!(seqs(&queue), [3, 4, 5]);
    }

    #[test]
    fn steady_arrivals_need_no_queue() {
        let mut jitter = ArrivalJitter::default();
        // Every input arrives 6 ticks after it was made: delay, no jitter.
        for i in 0..200u32 {
            jitter.observe(i as u16, i + 6);
        }
        assert_eq!(jitter.target(), Some(0));
    }

    #[test]
    fn the_target_is_the_jitter_spread_at_the_quantile() {
        let mut jitter = ArrivalJitter::default();
        // Lateness 0..9 ticks, each equally often: 95% arrive within 9 of
        // the earliest (index floor(0.95 * 120) = 114 of 120 sorted is 9).
        for (i, late) in shuffled_lateness().into_iter().enumerate() {
            jitter.observe(i as u16, i as u32 + 100 + late);
        }
        assert!(SPREAD_9.contains(&jitter.target().unwrap()), "{:?}", jitter.target());
        // A single late straggler in the window moves no quantile below it.
        let mut jitter = ArrivalJitter::default();
        for i in 0..120u32 {
            let late = if i == 60 { 30 } else { 0 };
            jitter.observe(i as u16, i + 100 + late);
        }
        assert_eq!(jitter.target(), Some(0));
    }

    #[test]
    fn copies_and_old_inputs_do_not_count_and_seq_unwraps() {
        let mut jitter = ArrivalJitter::default();
        jitter.observe(0xfffe, 10);
        jitter.observe(0xfffe, 50); // a resend
        jitter.observe(0xfffd, 50); // older
        jitter.observe(0xffff, 11);
        jitter.observe(0, 12); // wraps
        jitter.observe(1, 13);
        assert_eq!(jitter.arrivals.len(), 4);
        assert_eq!(jitter.target(), Some(0));
    }

    #[test]
    fn a_client_pacing_its_clock_is_not_jitter() {
        // Live 2026-10-11 (wall course, LTE): the queue grew from 5 to 14-18
        // inputs over a 12 s drive. A client running its input clock 5% fast
        // (pacing toward a deeper target) makes each input arrive a little
        // earlier than the last relative to its sequence: steady drift, no
        // jitter. Read as jitter, it raises the target, which speeds the
        // client further.
        let mut jitter = ArrivalJitter::default();
        for i in 0..120u32 {
            jitter.observe(i as u16, 100 + (i as f32 / 1.05) as u32);
        }
        assert!(jitter.target().unwrap() <= 1, "drift read as jitter: {:?}", jitter.target());
        // And slow (5% under real time) the same.
        let mut jitter = ArrivalJitter::default();
        for i in 0..120u32 {
            jitter.observe(i as u16, 100 + (i as f32 / 0.95) as u32);
        }
        assert!(jitter.target().unwrap() <= 1, "drift read as jitter: {:?}", jitter.target());
    }

    #[test]
    fn the_window_forgets_old_jitter() {
        let mut jitter = ArrivalJitter::default();
        for (i, late) in shuffled_lateness().into_iter().enumerate() {
            jitter.observe(i as u16, i as u32 + late);
        }
        assert!(SPREAD_9.contains(&jitter.target().unwrap()), "{:?}", jitter.target());
        for i in 120..240u32 {
            jitter.observe(i as u16, i + 9);
        }
        assert_eq!(jitter.target(), Some(0));
    }
}
