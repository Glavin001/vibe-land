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
//! - measures each input's lateness (arrival tick minus sequence) and reports
//!   a target depth: the spread of lateness from its least to its 95th
//!   percentile ([`ArrivalJitter`]). A queue that deep absorbs 95% of the
//!   arrival jitter, as a playout buffer sized from a delay quantile does
//!   (WebRTC NetEq). The quantile matches the client's render clock.
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
    /// Arrival tick minus unwrapped sequence, newest last.
    lateness: VecDeque<i64>,
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
        self.lateness.push_back(tick as i64 - self.unwrapped);
        while self.lateness.len() > JITTER_WINDOW {
            self.lateness.pop_front();
        }
    }

    /// The queue depth (inputs left after a tick) that absorbs the
    /// [`TARGET_QUANTILE`] of arrival jitter; None before any input.
    pub fn target(&self) -> Option<u8> {
        if self.lateness.is_empty() {
            return None;
        }
        let mut sorted: Vec<i64> = self.lateness.iter().copied().collect();
        sorted.sort_unstable();
        let at = ((TARGET_QUANTILE * sorted.len() as f32) as usize).min(sorted.len() - 1);
        Some((sorted[at] - sorted[0]).clamp(0, u8::MAX as i64) as u8)
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
        for i in 0..120u32 {
            jitter.observe(i as u16, i + 100 + (i % 10));
        }
        assert_eq!(jitter.target(), Some(9));
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
        assert_eq!(jitter.lateness.len(), 4);
        assert_eq!(jitter.target(), Some(0));
    }

    #[test]
    fn the_window_forgets_old_jitter() {
        let mut jitter = ArrivalJitter::default();
        for i in 0..120u32 {
            jitter.observe(i as u16, i + (i % 10));
        }
        assert_eq!(jitter.target(), Some(9));
        for i in 120..240u32 {
            jitter.observe(i as u16, i + 9);
        }
        assert_eq!(jitter.target(), Some(0));
    }
}
