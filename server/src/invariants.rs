//! Invariants watched every tick, so faults are found without anyone looking.
//!
//! The destruction stage already counts its own faults (cumulative counters in
//! its observation spans); an invariant fires when one of them increases or a
//! tick's stage reports error bits. Each anomaly is logged and, rate-limited
//! per kind (`VIBE_ANOMALY_INTERVAL_S`, default 60 s; at most
//! `VIBE_ANOMALY_DUMP_MAX` = 20 per match), dumped with the flight recorder's
//! repro bundle to `debug-reports/anomaly-<unix>-<match>-tick<N>-<kind>/`.
//! `scripts/vl repro` replays such a dump; `vl triage` groups them.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Counters that must never increase, and why.
pub(crate) const WATCHED: &[(&str, &str)] = &[
    ("native_velocity_explosions", "a body's speed jumped by more than the solver-fault threshold in one tick"),
    ("native_escaped_bodies", "a body left the world"),
    ("native_error_frames", "the stage rejected a step (error bits; under the reject policy a lost simulation step)"),
    ("native_missed_frames", "the stage skipped frames"),
];

#[derive(Debug, Clone)]
pub(crate) struct Anomaly {
    pub kind: String,
    pub why: &'static str,
    pub detail: serde_json::Value,
}

pub(crate) struct Invariants {
    last: HashMap<&'static str, f64>,
    last_dump: HashMap<String, Instant>,
    dumps: u32,
    interval: Duration,
    max_dumps: u32,
}

impl Invariants {
    pub(crate) fn from_env() -> Self {
        let interval = std::env::var("VIBE_ANOMALY_INTERVAL_S").ok().and_then(|v| v.parse().ok()).unwrap_or(60.0f32);
        let max_dumps = std::env::var("VIBE_ANOMALY_DUMP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
        Self { last: HashMap::new(), last_dump: HashMap::new(), dumps: 0, interval: Duration::from_secs_f32(interval), max_dumps }
    }

    /// The anomalies of this tick.
    pub(crate) fn check<'a>(&mut self, stage_error: u32, spans: impl Iterator<Item = (&'a str, f64)>) -> Vec<Anomaly> {
        let mut out = Vec::new();
        if stage_error != 0 {
            out.push(Anomaly { kind: "stage_error".into(), why: "the destruction stage reported error bits this tick",
                detail: serde_json::json!({"error_bits": stage_error}) });
        }
        for (name, value) in spans {
            let Some((key, why)) = WATCHED.iter().find(|(k, _)| *k == name) else { continue };
            let previous = self.last.insert(key, value);
            if let Some(previous) = previous {
                if value > previous {
                    out.push(Anomaly { kind: key.trim_start_matches("native_").to_string(), why,
                        detail: serde_json::json!({"counter": key, "from": previous, "to": value}) });
                }
            }
        }
        out
    }

    /// Whether this anomaly should be dumped now (rate limits).
    pub(crate) fn should_dump(&mut self, kind: &str) -> bool {
        if self.dumps >= self.max_dumps || self.last_dump.get(kind).is_some_and(|at| at.elapsed() < self.interval) {
            return false;
        }
        self.dumps += 1;
        self.last_dump.insert(kind.to_string(), Instant::now());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_on_increase_and_stage_errors_only() {
        let mut inv = Invariants { last: HashMap::new(), last_dump: HashMap::new(), dumps: 0, interval: Duration::from_secs(60), max_dumps: 20 };
        assert!(inv.check(0, [("native_velocity_explosions", 0.0), ("other", 5.0)].into_iter()).is_empty(), "first sight sets the baseline");
        assert!(inv.check(0, [("native_velocity_explosions", 0.0)].into_iter()).is_empty());
        let a = inv.check(0, [("native_velocity_explosions", 2.0)].into_iter());
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "velocity_explosions");
        let b = inv.check(4096, std::iter::empty());
        assert_eq!(b[0].kind, "stage_error");
        assert!(inv.should_dump("stage_error"));
        assert!(!inv.should_dump("stage_error"), "rate-limited per kind");
        assert!(inv.should_dump("velocity_explosions"));
    }
}
