//! Network-definitive settle policy.
//!
//! Per docs/destruction-netcode.md: sleep is policy, not a threshold — the
//! network needs a definitive "at rest now" moment. A promoted island body is
//! force-slept a fixed time after promotion, or earlier after a sustained run
//! of ticks below an energy floor. The caller executes the sleep in the engine
//! and emits a settle event with the final pose.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub struct SettleConfig {
    /// Hard deadline: force-sleep this many ticks after promotion.
    pub force_sleep_ticks: u32,
    /// Consecutive below-floor ticks required for an early settle.
    pub quiet_ticks: u32,
    pub linear_floor: f32,
    pub angular_floor: f32,
}

impl SettleConfig {
    pub fn validated(hz: u32) -> Self {
        Self {
            force_sleep_ticks: hz * 5, // 5 s
            quiet_ticks: hz / 2,       // 500 ms
            linear_floor: 0.05,
            angular_floor: 0.1,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct TrackState {
    promoted_tick: u64,
    quiet_run: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct SettleSample {
    pub body_entity: u32,
    pub linear_speed: f32,
    pub angular_speed: f32,
}

#[derive(Clone, Debug, Default)]
pub struct SettleTracker {
    tracks: HashMap<u32, TrackState>,
}

impl SettleTracker {
    pub fn promote(&mut self, body_entity: u32, tick: u64) {
        self.tracks.insert(
            body_entity,
            TrackState {
                promoted_tick: tick,
                quiet_run: 0,
            },
        );
    }

    pub fn retire(&mut self, body_entity: u32) {
        self.tracks.remove(&body_entity);
    }

    /// A body woke back up (external impulse after settle); resume tracking.
    pub fn wake(&mut self, body_entity: u32, tick: u64) {
        self.promote(body_entity, tick);
    }

    pub fn tracked(&self) -> usize {
        self.tracks.len()
    }

    /// Returns the body entities that must be put to sleep this tick.
    pub fn update(
        &mut self,
        tick: u64,
        samples: impl IntoIterator<Item = SettleSample>,
        config: SettleConfig,
    ) -> Vec<u32> {
        let mut settled = Vec::new();
        for sample in samples {
            let Some(track) = self.tracks.get_mut(&sample.body_entity) else {
                continue;
            };
            let quiet = sample.linear_speed < config.linear_floor
                && sample.angular_speed < config.angular_floor;
            track.quiet_run = if quiet { track.quiet_run + 1 } else { 0 };
            let deadline = tick.saturating_sub(track.promoted_tick)
                >= config.force_sleep_ticks as u64;
            if deadline || track.quiet_run >= config.quiet_ticks {
                settled.push(sample.body_entity);
            }
        }
        for body in &settled {
            self.tracks.remove(body);
        }
        settled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SettleConfig {
        SettleConfig {
            force_sleep_ticks: 10,
            quiet_ticks: 3,
            linear_floor: 0.05,
            angular_floor: 0.1,
        }
    }

    fn quiet(body: u32) -> SettleSample {
        SettleSample {
            body_entity: body,
            linear_speed: 0.01,
            angular_speed: 0.01,
        }
    }

    fn moving(body: u32) -> SettleSample {
        SettleSample {
            body_entity: body,
            linear_speed: 2.0,
            angular_speed: 0.0,
        }
    }

    #[test]
    fn sustained_quiet_settles_early() {
        let mut tracker = SettleTracker::default();
        tracker.promote(7, 0);
        assert!(tracker.update(1, [quiet(7)], config()).is_empty());
        assert!(tracker.update(2, [quiet(7)], config()).is_empty());
        assert_eq!(tracker.update(3, [quiet(7)], config()), vec![7]);
        // Settled bodies stop being tracked.
        assert_eq!(tracker.tracked(), 0);
    }

    #[test]
    fn motion_resets_the_quiet_run() {
        let mut tracker = SettleTracker::default();
        tracker.promote(7, 0);
        tracker.update(1, [quiet(7)], config());
        tracker.update(2, [moving(7)], config());
        assert!(tracker.update(3, [quiet(7)], config()).is_empty());
    }

    #[test]
    fn force_sleep_deadline_settles_a_jittering_body() {
        let mut tracker = SettleTracker::default();
        tracker.promote(7, 0);
        let mut settled = Vec::new();
        for tick in 1..=10 {
            settled = tracker.update(tick, [moving(7)], config());
        }
        assert_eq!(settled, vec![7]);
    }

    #[test]
    fn wake_restarts_tracking() {
        let mut tracker = SettleTracker::default();
        tracker.promote(7, 0);
        for tick in 1..=3 {
            tracker.update(tick, [quiet(7)], config());
        }
        assert_eq!(tracker.tracked(), 0);
        tracker.wake(7, 20);
        assert!(tracker.update(21, [quiet(7)], config()).is_empty());
        assert_eq!(tracker.tracked(), 1);
    }
}
