//! Tick flight recorder: the last few hundred ticks' full timing records
//! (`TickTiming`: brackets, PhysX phases, stage counts, engine zones when the
//! profiler is on), always on and bounded, and an automatic dump of the ticks
//! around a costly one.
//!
//! A spike over `VIBE_SPIKE_DUMP_MS` (default 33 ms; 0 disables dumps) arms a
//! dump; the recorder waits for `VIBE_SPIKE_WINDOW_TICKS` (default 120) more
//! ticks so the dump holds the spike with its lead-in and its aftermath, and
//! later spikes inside that window join the same dump. Dumps land in the debug
//! reports directory as `spike-<unix>-<match>-tick<N>/` (`ticks.jsonl` in the
//! session-capture format, `meta.json`), at most one per
//! `VIBE_SPIKE_DUMP_INTERVAL_S` (default 30 s) and `VIBE_SPIKE_DUMP_MAX`
//! (default 20) per match. `scripts/vl perf explain <dir>` reads them.
//!
//! `VIBE_FLIGHT_RECORDER=0` turns the recorder off. Building a record costs a
//! scan of the tick's spans (no allocation unless the engine profiler runs).

use crate::session_capture::TickTiming;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Whether the flight recorder runs (`VIBE_FLIGHT_RECORDER`, default on).
pub(crate) fn enabled() -> bool {
    std::env::var("VIBE_FLIGHT_RECORDER").map_or(true, |v| v != "0")
}

/// The ticks to write, and why.
pub(crate) struct SpikeDump {
    /// The first spike that armed the dump, and every spike inside it.
    pub spike_tick: u32,
    pub spikes: Vec<(u32, f32)>,
    pub threshold_ms: f32,
    pub ticks: Vec<TickTiming>,
}

struct Pending {
    spike_tick: u32,
    spikes: Vec<(u32, f32)>,
    until_tick: u32,
}

pub(crate) struct TickRecorder {
    ring: VecDeque<TickTiming>,
    capacity: usize,
    threshold_ms: f32,
    window: u32,
    interval: Duration,
    max_dumps: u32,
    dumps: u32,
    last_dump: Option<Instant>,
    pending: Option<Pending>,
}

impl TickRecorder {
    pub(crate) fn from_env() -> Self {
        let window = env_u32("VIBE_SPIKE_WINDOW_TICKS", 120);
        Self {
            ring: VecDeque::new(),
            // Room for a full window either side of the spike.
            capacity: (2 * window as usize + 1).max(600),
            threshold_ms: env_f32("VIBE_SPIKE_DUMP_MS", 33.0),
            window,
            interval: Duration::from_secs_f32(env_f32("VIBE_SPIKE_DUMP_INTERVAL_S", 30.0)),
            max_dumps: env_u32("VIBE_SPIKE_DUMP_MAX", 20),
            dumps: 0,
            last_dump: None,
            pending: None,
        }
    }

    /// The recent ticks, oldest first.
    pub(crate) fn recent(&self) -> impl Iterator<Item = &TickTiming> {
        self.ring.iter()
    }

    /// Record a tick; returns a dump when one is due.
    pub(crate) fn push(&mut self, timing: TickTiming) -> Option<SpikeDump> {
        let tick = timing.tick;
        let total = timing.total_ms;
        self.ring.push_back(timing);
        while self.ring.len() > self.capacity {
            self.ring.pop_front();
        }
        let spike = self.threshold_ms > 0.0 && total > self.threshold_ms;
        if spike {
            match self.pending.as_mut() {
                Some(pending) => pending.spikes.push((tick, total)),
                None if self.dumps < self.max_dumps
                    && self.last_dump.map_or(true, |at| at.elapsed() >= self.interval) =>
                {
                    self.pending = Some(Pending { spike_tick: tick, spikes: vec![(tick, total)], until_tick: tick + self.window });
                }
                None => {}
            }
        }
        let due = self.pending.as_ref().is_some_and(|pending| tick >= pending.until_tick);
        if !due {
            return None;
        }
        let pending = self.pending.take().expect("checked");
        let from = pending.spike_tick.saturating_sub(self.window);
        let ticks = self.ring.iter().filter(|t| t.tick >= from && t.tick <= pending.until_tick).cloned().collect();
        self.dumps += 1;
        self.last_dump = Some(Instant::now());
        Some(SpikeDump { spike_tick: pending.spike_tick, spikes: pending.spikes, threshold_ms: self.threshold_ms, ticks })
    }
}

/// Write a dump into `root/spike-<unix>-<match>-tick<N>/` off the tick thread.
pub(crate) fn write_dump(root: std::path::PathBuf, match_id: String, meta: serde_json::Value, dump: SpikeDump) {
    std::thread::spawn(move || {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let dir = root.join(format!("spike-{stamp}-{match_id}-tick{}", dump.spike_tick));
        let mut lines = String::new();
        for tick in &dump.ticks {
            match serde_json::to_string(tick) {
                Ok(line) => {
                    lines.push_str(&line);
                    lines.push('\n');
                }
                Err(error) => tracing::warn!(%error, "spike dump: tick serialize failed"),
            }
        }
        let mut meta = meta;
        meta["match_id"] = serde_json::json!(match_id);
        meta["spike_tick"] = serde_json::json!(dump.spike_tick);
        meta["spikes"] = serde_json::json!(dump.spikes);
        meta["threshold_ms"] = serde_json::json!(dump.threshold_ms);
        meta["ticks"] = serde_json::json!(dump.ticks.len());
        let written = std::fs::create_dir_all(&dir)
            .and_then(|()| std::fs::write(dir.join("ticks.jsonl"), lines))
            .and_then(|()| std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta).unwrap_or_default()));
        match written {
            Ok(()) => tracing::info!(dir = %dir.display(), spikes = dump.spikes.len(), "spike dump stored"),
            Err(error) => tracing::warn!(%error, dir = %dir.display(), "spike dump write failed"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder(threshold: f32, window: u32) -> TickRecorder {
        TickRecorder {
            ring: VecDeque::new(),
            capacity: 600,
            threshold_ms: threshold,
            window,
            interval: Duration::from_secs(0),
            max_dumps: 2,
            dumps: 0,
            last_dump: None,
            pending: None,
        }
    }

    fn tick(n: u32, ms: f32) -> TickTiming {
        TickTiming { tick: n, total_ms: ms, ..Default::default() }
    }

    #[test]
    fn dumps_the_window_around_a_spike_once_its_aftermath_is_recorded() {
        let mut r = recorder(33.0, 5);
        for n in 0..20 {
            assert!(r.push(tick(n, 5.0)).is_none());
        }
        assert!(r.push(tick(20, 80.0)).is_none(), "the aftermath is not recorded yet");
        for n in 21..25 {
            assert!(r.push(tick(n, if n == 22 { 40.0 } else { 5.0 })).is_none());
        }
        let dump = r.push(tick(25, 5.0)).expect("due five ticks after the spike");
        assert_eq!(dump.spike_tick, 20);
        assert_eq!(dump.spikes, vec![(20, 80.0), (22, 40.0)], "a later spike joins the same dump");
        assert_eq!(dump.ticks.first().unwrap().tick, 15);
        assert_eq!(dump.ticks.last().unwrap().tick, 25);
    }

    #[test]
    fn stops_after_the_dump_limit_and_never_dumps_with_threshold_zero() {
        let mut r = recorder(33.0, 1);
        let mut dumps = 0;
        for n in 0..40 {
            if r.push(tick(n, if n % 4 == 0 { 50.0 } else { 5.0 })).is_some() {
                dumps += 1;
            }
        }
        assert_eq!(dumps, 2);
        let mut off = recorder(0.0, 1);
        assert!((0..10).all(|n| off.push(tick(n, 500.0)).is_none()));
    }
}
