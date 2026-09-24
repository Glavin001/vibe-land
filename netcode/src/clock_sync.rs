/// Client-side server-clock estimation.
///
/// Implements:
/// - `RttEstimator`         — Jacobson EWMA (TCP algorithm) for RTT/jitter estimation
/// - `ServerClockEstimator` — a rate-aware, slewed, monotonic estimate of server
///   simulation time, and an interpolation delay sized from observed snapshot
///   arrivals
///
/// The client carries a TypeScript copy of `ServerClockEstimator`
/// (`client/src/net/serverClockModel.ts`) for tests and tools that run without
/// WASM. Keep the two in step: `serverClockModel.test.ts` runs both over the
/// same traces and requires them to agree.
use std::collections::VecDeque;

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
        self.rttvar_us = (1.0 - BETA) * self.rttvar_us + BETA * (rtt_us - prev_srtt).abs();
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

// ── Server Clock Estimator ─────────────────────────────────────────────────────

/// Samples older than this (local time) leave the rate window.
pub const RATE_WINDOW_US: f64 = 1_000_000.0;
/// The rate is only measured over at least this much time.
pub const RATE_MIN_SPAN_US: f64 = 250_000.0;
/// Time constant (local µs) smoothing a rate measured from arrivals, which
/// carry the network's jitter. A rate measured from the server's wall-clock
/// stamps is exact over its window and is used as measured.
pub const RATE_SMOOTHING_TAU_US: f64 = 300_000.0;
/// Plausible server rates (sim µs per wall µs).
pub const RATE_MIN: f64 = 0.02;
pub const RATE_MAX: f64 = 2.0;
/// The lowest-latency path (server wall → local) is the minimum over this window.
pub const WALL_OFFSET_WINDOW_US: f64 = 4_000_000.0;
/// Arrival history for the delay quantile.
pub const ARRIVAL_HISTORY: usize = 128;
/// Quantile of per-arrival drain the delay covers.
pub const DELAY_QUANTILE: f64 = 0.95;
/// Hard cap on the recommended delay (sim time).
pub const MAX_DELAY_US: f64 = 250_000.0;
/// Time constant of the output's pull towards the model (local time).
pub const SLEW_TAU_US: f64 = 300_000.0;
/// The output may run at most this much faster than the modelled rate.
pub const MAX_CATCH_UP: f64 = 1.5;
/// Beyond this much sim time behind the model the output jumps forward.
pub const SNAP_FORWARD_US: f64 = 1_000_000.0;
/// Local time going back by more than this is a new timeline (a replay seek).
pub const RESET_BACKWARDS_US: f64 = 1_000_000.0;

#[derive(Clone, Copy, Debug)]
struct ClockSample {
    server_us: f64,
    arrival_us: f64,
    /// When the sample was produced, on the local clock: its arrival over the
    /// lowest-latency path seen recently when the server stamped its wall
    /// clock, the arrival itself otherwise.
    produced_us: f64,
    /// Unwrapped server wall clock (µs), when stamped.
    wall_us: Option<f64>,
}

/// Estimates the server's simulation clock on the local clock.
///
/// Server time on the wire is `tick × tick_us`. A server that cannot hold its
/// tick rate advances that clock slower than wall time, so the estimator
/// measures the rate (sim µs per local µs) instead of assuming 1.0:
///
/// - **Rate.** From the server's wall-clock stamp when the snapshot carries one
///   (`observe_server_time_with_wall`): sim advance over server wall advance, a
///   measurement no network delay can disturb. Otherwise from arrivals.
/// - **Model.** The newest sample, advanced at that rate by at most one
///   snapshot interval (the sim time the next snapshot will add), plus the
///   one-way latency. A server that stops sending has stopped; the client
///   does not run ahead of it. Capping at one step rather than at the delay
///   keeps the model continuous across arrivals: when the next snapshot comes
///   it lands where the model already is, however long it took.
/// - **Output.** `server_now_us` moves with the model, and a step in the model
///   decays over `SLEW_TAU_US` instead of being taken at once: the output
///   speeds up by at most `MAX_CATCH_UP` and slows down, to a stop if need be,
///   but never goes backwards. It jumps only forwards, and only when it is more
///   than `SNAP_FORWARD_US` behind.
/// - **Delay.** `recommended_delay_us` is the `DELAY_QUANTILE` of the sim time
///   that elapses between snapshot arrivals (arrival gap × rate), floored at
///   the observed snapshot interval and capped at `MAX_DELAY_US`.
pub struct ServerClockEstimator {
    rtt: RttEstimator,
    sim_hz: f64,
    samples: VecDeque<ClockSample>,
    latest: Option<ClockSample>,
    rate: f64,
    rate_measured: bool,
    wall_unwrapped: Option<(u32, f64)>,
    wall_offset_us: Option<f64>,
    /// (arrival gap × rate, sim step) per arrival.
    arrivals: VecDeque<(f64, f64)>,
    delay_us: f64,
    snapshot_interval_us: f64,
    out_server_us: f64,
    /// The model's value at `out_local_us`: the output's error is measured
    /// against it.
    out_target_us: f64,
    out_local_us: f64,
    out_initialized: bool,
}

impl ServerClockEstimator {
    /// `sim_hz` is the server's nominal tick rate.
    pub fn new(sim_hz: f64) -> Self {
        let tick_us = 1_000_000.0 / sim_hz.max(1.0);
        Self {
            rtt: RttEstimator::new(),
            sim_hz,
            samples: VecDeque::new(),
            latest: None,
            rate: 1.0,
            rate_measured: false,
            wall_unwrapped: None,
            wall_offset_us: None,
            arrivals: VecDeque::new(),
            delay_us: tick_us,
            snapshot_interval_us: tick_us,
            out_server_us: 0.0,
            out_target_us: 0.0,
            out_local_us: 0.0,
            out_initialized: false,
        }
    }

    fn tick_us(&self) -> f64 {
        1_000_000.0 / self.sim_hz.max(1.0)
    }

    /// Feed a new RTT measurement (in milliseconds, as typically provided by the client).
    pub fn observe_rtt(&mut self, rtt_ms: f64) {
        self.rtt.observe(rtt_ms * 1000.0);
    }

    /// Feed a server→client time observation with no server wall clock.
    ///
    /// `server_us` — the server's simulation timestamp (µs) from the packet.
    /// `local_us`  — our local monotonic timestamp (µs) when the packet arrived.
    pub fn observe_server_time(&mut self, server_us: f64, local_us: f64) {
        self.observe(server_us, local_us, None);
    }

    /// Feed an observation stamped with the server's wall clock (`wall_us`,
    /// µs modulo 2^32, on any origin) when the snapshot was produced.
    pub fn observe_server_time_with_wall(&mut self, server_us: f64, wall_us: u32, local_us: f64) {
        self.observe(server_us, local_us, Some(wall_us));
    }

    fn observe(&mut self, server_us: f64, local_us: f64, wall: Option<u32>) {
        if let Some(latest) = self.latest {
            if local_us < latest.arrival_us - RESET_BACKWARDS_US {
                self.reset_timeline();
            } else if server_us <= latest.server_us {
                // Duplicate or reordered: it says nothing new about the clock.
                return;
            }
        }

        let wall_us = wall.map(|raw| self.unwrap_wall(raw));
        if wall_us.is_none() {
            // A stream that stops stamping must not keep a stale mapping.
            self.wall_unwrapped = None;
            self.wall_offset_us = None;
        }

        let mut sample = ClockSample {
            server_us,
            arrival_us: local_us,
            produced_us: local_us,
            wall_us,
        };
        let keep_from = local_us - RATE_WINDOW_US.max(WALL_OFFSET_WINDOW_US);
        while self
            .samples
            .front()
            .is_some_and(|s| s.arrival_us < keep_from)
        {
            self.samples.pop_front();
        }
        if let Some(wall_us) = wall_us {
            // The lowest-latency path: min(arrival - wall) over the window.
            let from = local_us - WALL_OFFSET_WINDOW_US;
            let offset = self
                .samples
                .iter()
                .filter(|s| s.arrival_us >= from)
                .filter_map(|s| s.wall_us.map(|w| s.arrival_us - w))
                .fold(local_us - wall_us, f64::min);
            self.wall_offset_us = Some(offset);
            sample.produced_us = wall_us + offset;
        }
        self.samples.push_back(sample);

        let since_last_us = self
            .latest
            .map_or(0.0, |prev| (local_us - prev.arrival_us).max(0.0));
        self.update_rate(local_us, since_last_us);

        if let Some(prev) = self.latest {
            let gap_us = (local_us - prev.arrival_us).max(0.0);
            let step_us = server_us - prev.server_us;
            self.arrivals.push_back((gap_us * self.rate, step_us));
            while self.arrivals.len() > ARRIVAL_HISTORY {
                self.arrivals.pop_front();
            }
            self.update_delay();
        }

        self.latest = Some(sample);
        if !self.out_initialized {
            self.out_server_us = self.model_us(local_us);
            self.out_target_us = self.out_server_us;
            self.out_local_us = local_us;
            self.out_initialized = true;
        }
    }

    fn unwrap_wall(&mut self, raw: u32) -> f64 {
        let unwrapped = match self.wall_unwrapped {
            None => raw as f64,
            Some((last_raw, last)) => last + (raw.wrapping_sub(last_raw) as i32) as f64,
        };
        self.wall_unwrapped = Some((raw, unwrapped));
        unwrapped
    }

    fn update_rate(&mut self, local_us: f64, since_last_us: f64) {
        let from = local_us - RATE_WINDOW_US;
        let Some(first) = self.samples.iter().find(|s| s.arrival_us >= from).copied() else {
            return;
        };
        let last = *self.samples.back().expect("just pushed");
        let (span_us, smoothing) = match (first.wall_us, last.wall_us) {
            (Some(w0), Some(w1)) => (w1 - w0, 1.0),
            _ => (
                last.arrival_us - first.arrival_us,
                1.0 - (-since_last_us / RATE_SMOOTHING_TAU_US).exp(),
            ),
        };
        if span_us < RATE_MIN_SPAN_US {
            return;
        }
        let measured = ((last.server_us - first.server_us) / span_us).clamp(RATE_MIN, RATE_MAX);
        if self.rate_measured {
            self.rate += (measured - self.rate) * smoothing;
        } else {
            self.rate = measured;
            self.rate_measured = true;
        }
    }

    fn update_delay(&mut self) {
        let mut drains: Vec<f64> = self.arrivals.iter().map(|&(d, _)| d).collect();
        let mut steps: Vec<f64> = self.arrivals.iter().map(|&(_, s)| s).collect();
        let drain = quantile(&mut drains, DELAY_QUANTILE);
        self.snapshot_interval_us = quantile(&mut steps, 0.5).max(1.0);
        self.delay_us = drain.max(self.snapshot_interval_us).min(MAX_DELAY_US);
    }

    fn reset_timeline(&mut self) {
        let tick_us = self.tick_us();
        self.samples.clear();
        self.latest = None;
        self.arrivals.clear();
        self.wall_unwrapped = None;
        self.wall_offset_us = None;
        self.rate = 1.0;
        self.rate_measured = false;
        self.out_initialized = false;
        self.delay_us = tick_us;
        self.snapshot_interval_us = tick_us;
    }

    /// Where the model puts server time at `local_us`, before smoothing.
    fn model_us(&self, local_us: f64) -> f64 {
        let Some(latest) = self.latest else {
            return local_us;
        };
        let ahead =
            (self.rate * (local_us - latest.produced_us)).clamp(0.0, self.snapshot_interval_us);
        latest.server_us + ahead + self.rtt.rtt_us() / 2.0
    }

    /// Estimated server time (µs) at `local_us`: rate-aware, slewed, and
    /// monotonic in `local_us`. Advances the estimator's output; a call for a
    /// local time earlier than the previous call returns the previous value.
    pub fn server_now_us(&mut self, local_us: f64) -> f64 {
        if self.latest.is_none() {
            return local_us;
        }
        let target = self.model_us(local_us);
        if !self.out_initialized || local_us < self.out_local_us - RESET_BACKWARDS_US {
            self.out_server_us = target;
            self.out_target_us = target;
            self.out_local_us = local_us;
            self.out_initialized = true;
            return target;
        }
        let dt = local_us - self.out_local_us;
        if dt <= 0.0 {
            return self.out_server_us;
        }
        // Follow the model's own motion -- at the server's rate while snapshots
        // flow, not at all once the model stops -- and let any step in it (a
        // late or early snapshot, a new rate or delay) decay over SLEW_TAU_US.
        let error = self.out_server_us - self.out_target_us;
        let next = if target - self.out_server_us > SNAP_FORWARD_US {
            target
        } else {
            let followed = target + error * (-dt / SLEW_TAU_US).exp();
            followed.clamp(
                self.out_server_us,
                self.out_server_us + self.rate * dt * MAX_CATCH_UP,
            )
        };
        self.out_server_us = next;
        self.out_target_us = target;
        self.out_local_us = local_us;
        next
    }

    /// `server_time ≈ local_time + offset` at the last evaluated point. Does
    /// not advance the output.
    pub fn clock_offset_us(&self) -> f64 {
        if self.out_initialized {
            self.out_server_us - self.out_local_us
        } else if let Some(latest) = self.latest {
            latest.server_us - latest.arrival_us
        } else {
            0.0
        }
    }

    /// Measured server rate: sim µs per local µs (1.0 until measured).
    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Whether the newest sample carried the server's wall clock.
    pub fn has_wall_clock(&self) -> bool {
        self.wall_offset_us.is_some()
    }

    /// Recommended interpolation delay (µs of sim time).
    pub fn recommended_delay_us(&self) -> f64 {
        self.delay_us
    }

    /// Median sim-time step between received snapshots (µs).
    pub fn snapshot_interval_us(&self) -> f64 {
        self.snapshot_interval_us
    }

    /// Current jitter estimate in microseconds (from the RTT estimator).
    pub fn jitter_us(&self) -> f64 {
        self.rtt.jitter_us()
    }

    /// Recommended interpolation delay in milliseconds (sim time).
    pub fn interpolation_delay_ms(&self) -> f64 {
        self.delay_us / 1000.0
    }

    /// Smoothed RTT in milliseconds.
    pub fn rtt_ms(&self) -> f64 {
        self.rtt.rtt_ms()
    }
}

impl Default for ServerClockEstimator {
    fn default() -> Self {
        Self::new(60.0)
    }
}

/// Nearest-rank quantile (sorts `values`). 0 for an empty slice.
fn quantile(values: &mut [f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((q * values.len() as f64).ceil() as usize).clamp(1, values.len());
    values[rank - 1]
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TICK_US: f64 = 16_667.0;

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
        let delta = (e.rtt_us() - 100_000.0).abs();
        assert!(delta < 100.0, "delta={delta}");
    }

    #[test]
    fn rtt_estimator_rejects_outliers() {
        let mut e = RttEstimator::new();
        e.observe(100_000.0);
        let before = e.rtt_us();
        e.observe(1_000_000.0);
        assert_eq!(e.rtt_us(), before);
    }

    #[test]
    fn first_sample_includes_one_way_latency() {
        let mut c = ServerClockEstimator::new(60.0);
        c.observe_rtt(50.0);
        c.observe_server_time(1_000_000.0, 950_000.0);
        let now = c.server_now_us(950_000.0);
        assert!((now - 1_025_000.0).abs() < 1.0, "now={now}");
    }

    #[test]
    fn interpolation_delay_starts_at_one_tick() {
        let c = ServerClockEstimator::new(60.0);
        assert!((c.interpolation_delay_ms() - 16.667).abs() < 0.01);
    }

    struct Sim {
        c: ServerClockEstimator,
        /// (local, server_now, newest server time received) per 120 Hz frame.
        frames: Vec<(f64, f64, f64)>,
    }

    /// Snapshot `i` carries tick `i + 1`, is sent at `send_at(i)` (server
    /// wall, µs) and arrives `latency_us(i)` later; the client reads the clock
    /// at 120 Hz.
    fn run(
        send_at: impl Fn(usize) -> f64,
        snapshots: usize,
        latency_us: impl Fn(usize) -> f64,
        stamp_wall: bool,
    ) -> Sim {
        let mut c = ServerClockEstimator::new(60.0);
        let mut events: Vec<(f64, f64, f64)> = (0..snapshots)
            .map(|i| {
                let sent = send_at(i);
                (sent + latency_us(i), (i as f64 + 1.0) * TICK_US, sent)
            })
            .collect();
        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let end = events.last().unwrap().0;
        let mut frames = Vec::new();
        let mut next = 0;
        let mut newest = 0.0f64;
        let mut t = events[0].0;
        while t <= end {
            while next < events.len() && events[next].0 <= t {
                let (arrive, server, sent) = events[next];
                if stamp_wall {
                    let wall = (sent.max(0.0) as u64 % (1u64 << 32)) as u32;
                    c.observe_server_time_with_wall(server, wall, arrive);
                } else {
                    c.observe_server_time(server, arrive);
                }
                newest = newest.max(server);
                next += 1;
            }
            let now = c.server_now_us(t);
            frames.push((t, now, newest));
            t += 8_333.0;
        }
        Sim { c, frames }
    }

    fn backward_steps(sim: &Sim) -> usize {
        sim.frames.windows(2).filter(|w| w[1].1 < w[0].1).count()
    }

    fn playout_rate(sim: &Sim, from_us: f64, to_us: f64) -> f64 {
        let a = sim.frames.iter().find(|f| f.0 >= from_us).unwrap();
        let b = sim.frames.iter().rev().find(|f| f.0 <= to_us).unwrap();
        (b.1 - a.1) / (b.0 - a.0)
    }

    #[test]
    fn steady_60hz_runs_at_rate_one_one_tick_behind() {
        for wall in [false, true] {
            let sim = run(|i| i as f64 * TICK_US, 600, |_| 2_000.0, wall);
            assert_eq!(backward_steps(&sim), 0);
            assert!((sim.c.rate() - 1.0).abs() < 0.01, "rate={}", sim.c.rate());
            let r = playout_rate(&sim, 3e6, 9.5e6);
            assert!((r - 1.0).abs() < 0.01, "playout rate {r}");
            let delay = sim.c.interpolation_delay_ms();
            assert!((16.0..20.0).contains(&delay), "delay={delay}");
            // Rendering one delay behind never runs past the newest snapshot.
            let ahead = sim
                .frames
                .iter()
                .skip(60)
                .filter(|f| f.1 - sim.c.recommended_delay_us() > f.2 + 1.0)
                .count();
            assert_eq!(ahead, 0, "wall={wall}");
        }
    }

    #[test]
    fn slowed_server_rate_is_measured_and_followed() {
        // 35 ticks per wall second: the sim runs at 0.583x.
        for wall in [false, true] {
            let sim = run(|i| i as f64 * 1e6 / 35.0, 700, |_| 1_000.0, wall);
            assert_eq!(backward_steps(&sim), 0);
            let expected = 35.0 * TICK_US / 1e6;
            assert!(
                (sim.c.rate() - expected).abs() / expected < 0.02,
                "rate={} expected={expected}",
                sim.c.rate()
            );
            let r = playout_rate(&sim, 5e6, 19e6);
            assert!((r - expected).abs() / expected < 0.02, "playout {r}");
        }
    }

    fn varying_sends() -> Vec<f64> {
        // 20–60 Hz, changing every wall second, plus a 500 ms stall every 120 ticks.
        let mut t = 0.0;
        let mut sends = Vec::new();
        for i in 0..1500 {
            let second = (t / 1e6) as usize;
            let hz = [60.0, 20.0, 45.0, 30.0, 55.0, 25.0][second % 6];
            t += 1e6 / hz;
            if i % 120 == 119 {
                t += 500_000.0;
            }
            sends.push(t);
        }
        sends
    }

    #[test]
    fn varying_rate_and_stalls_never_go_backwards_or_snap() {
        let sends = varying_sends();
        for wall in [false, true] {
            let sim = run(
                |i| sends[i],
                sends.len(),
                |i| 1_000.0 + (i % 7) as f64 * 1_500.0,
                wall,
            );
            assert_eq!(backward_steps(&sim), 0, "wall={wall}");
            // Every frame's step is bounded by the catch-up rate: no hard snaps.
            let max_step = sim
                .frames
                .windows(2)
                .map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0))
                .fold(0.0, f64::max);
            assert!(max_step <= RATE_MAX * MAX_CATCH_UP + 1e-9, "step rate {max_step}");
            // It never runs more than the delay cap ahead of the stream.
            let worst_ahead = sim
                .frames
                .iter()
                .skip(120)
                .map(|f| f.1 - f.2)
                .fold(f64::MIN, f64::max);
            assert!(worst_ahead <= MAX_DELAY_US + 1.0, "ahead {worst_ahead}");
        }
    }

    #[test]
    fn stall_freezes_instead_of_running_ahead() {
        // 60 Hz, then a single 600 ms tick.
        let sim = run(
            |i| i as f64 * TICK_US + if i >= 200 { 600_000.0 } else { 0.0 },
            400,
            |_| 1_000.0,
            true,
        );
        assert_eq!(backward_steps(&sim), 0);
        let delay = sim.c.recommended_delay_us();
        for f in sim.frames.iter().filter(|f| f.0 > 3.4e6 && f.0 < 3.9e6) {
            assert!(f.1 <= f.2 + delay.max(40_000.0) + 1.0, "{f:?}");
        }
    }

    #[test]
    fn wall_clock_rate_ignores_network_jitter() {
        // A 40 Hz server; arrivals jittered by up to 30 ms.
        let sim = run(
            |i| i as f64 * 25_000.0,
            400,
            |i| 5_000.0 + ((i * 7919) % 31) as f64 * 1_000.0,
            true,
        );
        let expected = 40.0 * TICK_US / 1e6;
        assert!(sim.c.has_wall_clock());
        assert!(
            (sim.c.rate() - expected).abs() / expected < 0.01,
            "rate={}",
            sim.c.rate()
        );
        // The delay covers the jitter, not just the 25 ms send interval.
        assert!(sim.c.interpolation_delay_ms() > 20.0, "{}", sim.c.interpolation_delay_ms());
        assert_eq!(backward_steps(&sim), 0);
    }

    #[test]
    fn wall_clock_unwraps_across_u32() {
        let base = (1u64 << 32) as f64 - 500_000.0;
        let sim = run(|i| base + i as f64 * TICK_US, 120, |_| 1_000.0, true);
        assert!((sim.c.rate() - 1.0).abs() < 0.01, "rate={}", sim.c.rate());
        assert_eq!(backward_steps(&sim), 0);
    }

    #[test]
    fn delay_is_capped() {
        // One snapshot per 400 ms of wall time.
        let sim = run(|i| i as f64 * 400_000.0, 40, |_| 1_000.0, false);
        assert!(sim.c.recommended_delay_us() <= MAX_DELAY_US);
    }

    #[test]
    fn local_clock_jumping_back_starts_a_new_timeline() {
        let mut c = ServerClockEstimator::new(60.0);
        for i in 0..120 {
            c.observe_server_time(i as f64 * TICK_US, 5e6 + i as f64 * TICK_US);
        }
        let _ = c.server_now_us(7e6);
        // A replay seeks back to the start of its tape.
        c.observe_server_time(0.0, 0.0);
        let now = c.server_now_us(0.0);
        assert!(now.abs() < 1.0, "now={now}");
    }
}
