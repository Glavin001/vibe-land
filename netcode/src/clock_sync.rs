/// Clock synchronization algorithms from Lightyear.
///
/// Implements:
/// - `RttEstimator`         — Jacobson EWMA (TCP algorithm) for RTT/jitter estimation
/// - `ServerClockEstimator` — adaptive-alpha EMA clock offset with speed-adjustment hysteresis

// ── RTT Estimator ─────────────────────────────────────────────────────────────

/// Jacobson/Karels EWMA RTT estimator (TCP algorithm).
///
/// Constants match Lightyear exactly:
///   α = 1/12  ≈ 0.0833  (SRTT smoothing)
///   β = 1/6   ≈ 0.1667  (RTTVAR smoothing)
pub struct RttEstimator {
    srtt_us: f64,
    rttvar_us: f64,
    initialized: bool,
}

impl RttEstimator {
    pub fn new() -> Self {
        Self {
            srtt_us: 0.0,
            rttvar_us: 0.0,
            initialized: false,
        }
    }

    /// Feed one RTT sample (in microseconds).
    pub fn observe(&mut self, rtt_us: f64) {
        if !self.initialized {
            // First sample: unsmoothed for faster convergence (Lightyear pattern #2).
            self.srtt_us = rtt_us;
            self.rttvar_us = rtt_us / 2.0;
            self.initialized = true;
            return;
        }

        // Outlier rejection: skip implausibly large or implausibly fast samples.
        let max_accepted = (self.srtt_us + 3.0 * self.rttvar_us)
            .min(self.srtt_us * 3.0)
            .min(self.srtt_us + 500_000.0); // +500 ms cap
        let min_accepted = self.srtt_us * 1.2;
        if rtt_us > max_accepted || (rtt_us < min_accepted && rtt_us < self.srtt_us) {
            return;
        }

        // α = 1/12, β = 1/6
        const ALPHA: f64 = 1.0 / 12.0;
        const BETA: f64 = 1.0 / 6.0;

        let prev_srtt = self.srtt_us;
        self.srtt_us = (1.0 - ALPHA) * self.srtt_us + ALPHA * rtt_us;
        self.rttvar_us =
            (1.0 - BETA) * self.rttvar_us + BETA * (rtt_us - prev_srtt).abs();
    }

    /// Smoothed RTT in microseconds.
    pub fn rtt_us(&self) -> f64 {
        self.srtt_us
    }

    /// One-way jitter estimate = RTTVAR / 2 in microseconds.
    pub fn jitter_us(&self) -> f64 {
        self.rttvar_us / 2.0
    }

    /// Smoothed RTT in milliseconds.
    pub fn rtt_ms(&self) -> f64 {
        self.srtt_us / 1000.0
    }

    /// Jitter in milliseconds.
    pub fn jitter_ms(&self) -> f64 {
        self.jitter_us() / 1000.0
    }
}

impl Default for RttEstimator {
    fn default() -> Self {
        Self::new()
    }
}

// ── Speed-adjustment hysteresis state machine ─────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SyncState {
    DoNothing,
    SpeedAdjust,
    Resync,
}

// ── Server Clock Estimator ─────────────────────────────────────────────────────

/// Tracks the offset between server time and local time using an adaptive-alpha EMA.
///
/// - Alpha adapts between 0.02 (high jitter) and 0.10 (low jitter) based on `RttEstimator`.
/// - First sample is applied unsmoothed for fast initial convergence.
/// - Speed-adjustment hysteresis prevents oscillation:
///     - Resync (snap)      if error > 10 ticks worth of time
///     - SpeedAdjust        if error > 1 tick AND 3 consecutive measurements agree
///     - DoNothing          otherwise
pub struct ServerClockEstimator {
    rtt: RttEstimator,
    /// Estimated offset: server_time_us - local_time_us
    offset_us: f64,
    initialized: bool,

    // Speed-adjustment hysteresis
    sync_state: SyncState,
    consecutive_errors: u32,
    sim_hz: f64,
}

impl ServerClockEstimator {
    /// Create a new estimator.
    ///
    /// `sim_hz` is the simulation tick rate used to express the error threshold
    /// in ticks (e.g. 20 for a 20 Hz server).
    pub fn new(sim_hz: f64) -> Self {
        Self {
            rtt: RttEstimator::new(),
            offset_us: 0.0,
            initialized: false,
            sync_state: SyncState::DoNothing,
            consecutive_errors: 0,
            sim_hz,
        }
    }

    /// Feed a new RTT measurement (in milliseconds, as typically provided by the client).
    pub fn observe_rtt(&mut self, rtt_ms: f64) {
        self.rtt.observe(rtt_ms * 1000.0);
    }

    /// Feed a server→client time observation.
    ///
    /// `server_us` — the server's monotonic timestamp (µs) from the packet.
    /// `local_us`  — our local monotonic timestamp (µs) when the packet arrived.
    ///
    /// We correct for one-way latency using `RTT / 2` before computing the offset.
    pub fn observe_server_time(&mut self, server_us: i64, local_us: i64) {
        // One-way latency estimate = SRTT / 2.
        let one_way_us = self.rtt.rtt_us() / 2.0;
        // The server sent the packet `one_way_us` ago; adjust forward.
        let adjusted_server_us = server_us as f64 + one_way_us;
        let raw_offset = adjusted_server_us - local_us as f64;

        if !self.initialized {
            // First estimate: unsmoothed for fast convergence (Lightyear pattern).
            self.offset_us = raw_offset;
            self.initialized = true;
            return;
        }

        // Adaptive alpha: low jitter → high alpha (tracks faster), high jitter → low alpha.
        let jitter_ms = self.rtt.jitter_ms();
        let normalized = ((jitter_ms - 1.0) / 9.0).clamp(0.0, 1.0);
        let alpha = 0.10 - normalized * 0.08; // 0.02 … 0.10

        let error_us = raw_offset - self.offset_us;
        let tick_us = 1_000_000.0 / self.sim_hz;

        // Speed-adjustment hysteresis (3-state machine).
        let new_state = if error_us.abs() > 10.0 * tick_us {
            SyncState::Resync
        } else if error_us.abs() > tick_us {
            SyncState::SpeedAdjust
        } else {
            SyncState::DoNothing
        };

        if new_state == self.sync_state {
            self.consecutive_errors += 1;
        } else {
            self.consecutive_errors = 1;
            self.sync_state = new_state;
        }

        match self.sync_state {
            SyncState::Resync => {
                // Hard snap.
                self.offset_us = raw_offset;
            }
            SyncState::SpeedAdjust if self.consecutive_errors >= 3 => {
                // Accelerated adjustment: 5% base, scales with relative error.
                let scale = (error_us.abs() / (10.0 * tick_us)).min(1.0);
                let adjustment = 1.0 + 0.05 * scale * 2.0;
                // Nudge the EMA by a step proportional to the adjustment factor.
                self.offset_us += alpha * error_us * adjustment;
            }
            _ => {
                // Normal EMA.
                self.offset_us += alpha * error_us;
            }
        }
    }

    /// Estimated clock offset in microseconds: `server_time ≈ local_time + offset`.
    pub fn clock_offset_us(&self) -> f64 {
        self.offset_us
    }

    /// Current jitter estimate in microseconds (from the RTT estimator).
    pub fn jitter_us(&self) -> f64 {
        self.rtt.jitter_us()
    }

    /// Recommended interpolation delay in milliseconds.
    ///
    /// Formula: `jitter * 4 + 5 ms` (covers 4σ = 99.9 % of jitter + 5 ms buffer).
    pub fn interpolation_delay_ms(&self) -> f64 {
        let jitter_ms = self.rtt.jitter_ms();
        (jitter_ms * 4.0 + 5.0).max(5.0)
    }

    /// Smoothed RTT in milliseconds.
    pub fn rtt_ms(&self) -> f64 {
        self.rtt.rtt_ms()
    }
}

impl Default for ServerClockEstimator {
    fn default() -> Self {
        Self::new(20.0)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_estimator_first_sample_unsmoothed() {
        let mut e = RttEstimator::new();
        e.observe(100_000.0); // 100 ms
        assert_eq!(e.rtt_us(), 100_000.0);
        // rttvar = rtt/2 = 50_000; jitter = rttvar/2 = 25_000
        assert_eq!(e.jitter_us(), 25_000.0);
    }

    #[test]
    fn rtt_estimator_smooths_subsequent_samples() {
        let mut e = RttEstimator::new();
        e.observe(100_000.0);
        e.observe(100_000.0);
        // SRTT should stay at 100 ms
        let delta = (e.rtt_us() - 100_000.0).abs();
        assert!(delta < 100.0, "delta={delta}");
    }

    #[test]
    fn rtt_estimator_rejects_outliers() {
        let mut e = RttEstimator::new();
        e.observe(100_000.0);
        let before = e.rtt_us();
        // 1 second spike — should be rejected
        e.observe(1_000_000.0);
        assert_eq!(e.rtt_us(), before);
    }

    #[test]
    fn clock_estimator_first_sample_unsmoothed() {
        let mut c = ServerClockEstimator::new(20.0);
        c.observe_rtt(50.0);
        c.observe_server_time(1_000_000, 950_000); // raw offset = 50_000 + 25_000 (one-way)
        assert!((c.clock_offset_us() - 75_000.0).abs() < 100.0);
    }

    #[test]
    fn clock_estimator_snaps_on_large_error() {
        let mut c = ServerClockEstimator::new(20.0);
        c.observe_rtt(50.0);
        // Establish a baseline
        c.observe_server_time(1_000_000, 950_000);
        // Huge jump — should Resync
        c.observe_server_time(2_000_000, 950_000);
        // offset should have snapped close to the new raw value
        assert!(c.clock_offset_us() > 900_000.0, "offset={}", c.clock_offset_us());
    }

    #[test]
    fn interpolation_delay_minimum() {
        let c = ServerClockEstimator::new(20.0);
        // No observations yet — jitter = 0, delay should be at least 5 ms.
        assert!(c.interpolation_delay_ms() >= 5.0);
    }
}
