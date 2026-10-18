//! When to tell a player their own energy.
//!
//! Energy drains every tick (1-3 units a second on foot), and the server used
//! to send it reliably whenever the hundredths changed: every tick, 3,570
//! messages in one 101 s session, 68% of the reliable stream's messages. The
//! player sees it as an integer on the HUD (`EnergyBar`, refreshed at 10 Hz)
//! and a bar in 1% steps, so almost all of those told the client nothing it
//! showed.
//!
//! Now a message goes when the displayed integer changes, on any gain
//! (battery, respawn) and on reaching zero -- but never within
//! [`MIN_INTERVAL_TICKS`] of the previous one, so at most 10 a second. A change
//! held back by that limit is not lost: it is re-evaluated every tick and goes
//! out when the interval ends. A change too small to cross an integer goes out
//! within [`KEYFRAME_TICKS`], so the exact value (the debug overlay shows a
//! decimal) never stays stale for long. The client smooths between messages
//! (`client/src/net/energyDisplay.ts`).
use vibe_land_shared::constants::SIM_HZ;

/// 10 messages a second at most.
pub(crate) const MIN_INTERVAL_TICKS: u32 = SIM_HZ as u32 / 10;
/// The exact value is refreshed at least once a second while it changes.
pub(crate) const KEYFRAME_TICKS: u32 = SIM_HZ as u32;
/// One displayed unit of energy, in hundredths.
const DISPLAY_UNIT_CENTI: u32 = 100;

#[derive(Debug, Default)]
pub(crate) struct EnergySendGate {
    /// What the client was last sent; `None` forces the next send.
    last_sent_centi: Option<u32>,
    last_sent_tick: u32,
}

impl EnergySendGate {
    /// Should `energy_centi` be sent at `tick`? Call [`Self::sent`] only once
    /// it was actually queued.
    pub(crate) fn due(&self, tick: u32, energy_centi: u32) -> bool {
        let Some(last) = self.last_sent_centi else {
            return true;
        };
        if last == energy_centi {
            return false;
        }
        let since = tick.wrapping_sub(self.last_sent_tick);
        if since < MIN_INTERVAL_TICKS {
            return false;
        }
        let visible = energy_centi / DISPLAY_UNIT_CENTI != last / DISPLAY_UNIT_CENTI
            || energy_centi > last
            || energy_centi == 0;
        visible || since >= KEYFRAME_TICKS
    }

    pub(crate) fn sent(&mut self, tick: u32, energy_centi: u32) {
        self.last_sent_centi = Some(energy_centi);
        self.last_sent_tick = tick;
    }

    /// Send the next value whatever it is (a respawn, a death).
    pub(crate) fn force(&mut self) {
        self.last_sent_centi = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the gate like the match loop does: one decision per tick.
    fn run(gate: &mut EnergySendGate, start: u32, values: &[u32]) -> Vec<(u32, u32)> {
        let mut sent = Vec::new();
        for (i, &v) in values.iter().enumerate() {
            let tick = start + i as u32;
            if gate.due(tick, v) {
                gate.sent(tick, v);
                sent.push((tick, v));
            }
        }
        sent
    }

    /// A steady drain of `per_sec` units a second from 1000.00, one value per tick.
    fn drain(per_sec: f32, seconds: u32) -> Vec<u32> {
        (0..seconds * SIM_HZ as u32)
            .map(|t| ((1000.0 - per_sec * t as f32 / SIM_HZ as f32) * 100.0).round() as u32)
            .collect()
    }

    #[test]
    fn continuous_drain_sends_once_per_displayed_unit_not_per_tick() {
        let mut gate = EnergySendGate::default();
        let values = drain(3.0, 10);
        let sent = run(&mut gate, 0, &values);
        // First value, then one per integer crossed: 1000 -> 970.
        assert!(sent.len() <= 1 + 31, "{} sends", sent.len());
        assert!(sent.len() >= 30, "{} sends", sent.len());
        // Every displayed integer the client saw is the true one at that tick.
        for (tick, v) in &sent {
            assert_eq!(*v, values[*tick as usize]);
        }
    }

    #[test]
    fn never_more_than_ten_a_second_even_under_a_fast_drain() {
        let mut gate = EnergySendGate::default();
        // 40 units a second: an integer every 1.5 ticks.
        let sent = run(&mut gate, 0, &drain(40.0, 5));
        for pair in sent.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= MIN_INTERVAL_TICKS);
        }
        let per_sec = sent.len() as f32 / 5.0;
        assert!(per_sec <= 10.0 + 0.2, "{per_sec}/s");
    }

    #[test]
    fn a_change_right_after_a_send_is_deferred_not_dropped() {
        let mut gate = EnergySendGate::default();
        gate.sent(100, 50_000);
        // A battery pickup one tick later: held by the rate limit...
        assert!(!gate.due(101, 80_000));
        assert!(!gate.due(100 + MIN_INTERVAL_TICKS - 1, 80_000));
        // ...and sent as soon as the interval ends.
        assert!(gate.due(100 + MIN_INTERVAL_TICKS, 80_000));
    }

    #[test]
    fn sub_unit_changes_wait_for_the_keyframe() {
        let mut gate = EnergySendGate::default();
        gate.sent(0, 50_050); // 500.50
        // 500.10: same integer on the HUD.
        for tick in MIN_INTERVAL_TICKS..KEYFRAME_TICKS {
            assert!(!gate.due(tick, 50_010), "tick {tick}");
        }
        assert!(gate.due(KEYFRAME_TICKS, 50_010));
        // Nothing changed: no keyframe for its own sake on a reliable stream.
        gate.sent(KEYFRAME_TICKS, 50_010);
        assert!(!gate.due(KEYFRAME_TICKS * 5, 50_010));
    }

    #[test]
    fn gains_and_depletion_are_always_significant() {
        let mut gate = EnergySendGate::default();
        gate.sent(0, 50_050);
        assert!(gate.due(MIN_INTERVAL_TICKS, 50_060)); // +0.1: a gain
        gate.sent(0, 30);
        assert!(gate.due(MIN_INTERVAL_TICKS, 0)); // 0.30 -> 0: empty
    }

    #[test]
    fn force_bypasses_the_rate_limit() {
        let mut gate = EnergySendGate::default();
        gate.sent(10, 100_000);
        gate.force();
        assert!(gate.due(11, 100_000));
    }

    #[test]
    fn tick_wraparound_does_not_stall_sends() {
        let mut gate = EnergySendGate::default();
        gate.sent(u32::MAX - 2, 50_000);
        assert!(gate.due((u32::MAX - 2).wrapping_add(MIN_INTERVAL_TICKS), 49_900));
    }
}
