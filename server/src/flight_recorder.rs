//! The match's flight recorder, for reproduction: what every player did and
//! where they were over the last minute, and (in the city) every damage event
//! since the last reset, dumped as a `repro/` bundle into each debug report,
//! spike dump and anomaly dump. `scripts/vl repro` replays it on a fresh
//! server. Format: docs/repro-bundle.md.
//!
//! Bounded and on by default (`VIBE_FLIGHT_RECORDER=0` turns it off with the
//! tick recorder): inputs are a few bytes per player per frame, poses one
//! record per player every `POSE_EVERY_TICKS`.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;

/// Bundle format version (docs/repro-bundle.md).
pub(crate) const REPRO_VERSION: u32 = 1;
/// Inputs and poses kept: the last minute at 60 Hz.
pub(crate) const HORIZON_TICKS: u32 = 60 * 60;
pub(crate) const POSE_EVERY_TICKS: u32 = 6;

/// One input frame the server applied for a player on a tick.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct InputRecord {
    pub tick: u32,
    pub player: u32,
    pub seq: u16,
    pub buttons: u16,
    pub move_x: i8,
    pub move_y: i8,
    pub yaw: f32,
    pub pitch: f32,
    pub in_vehicle: bool,
}

/// Where a player was.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct PoseRecord {
    pub tick: u32,
    pub player: u32,
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub hp: u8,
    pub in_vehicle: bool,
}

#[derive(Default)]
pub(crate) struct FlightRecorder {
    inputs: VecDeque<InputRecord>,
    poses: VecDeque<PoseRecord>,
}

impl FlightRecorder {
    pub(crate) fn push_input(&mut self, record: InputRecord) {
        let now = record.tick;
        self.inputs.push_back(record);
        while self.inputs.front().is_some_and(|r| r.tick + HORIZON_TICKS <= now) {
            self.inputs.pop_front();
        }
    }

    pub(crate) fn push_pose(&mut self, record: PoseRecord) {
        let now = record.tick;
        self.poses.push_back(record);
        while self.poses.front().is_some_and(|r| r.tick + HORIZON_TICKS <= now) {
            self.poses.pop_front();
        }
    }

    pub(crate) fn inputs(&self) -> Vec<InputRecord> {
        self.inputs.iter().cloned().collect()
    }

    pub(crate) fn poses(&self) -> Vec<PoseRecord> {
        self.poses.iter().cloned().collect()
    }
}

/// Everything a reproduction needs, taken on the tick thread.
pub(crate) struct ReproBundle {
    pub meta: serde_json::Value,
    pub events: Vec<(u32, serde_json::Value)>,
    pub inputs: Vec<InputRecord>,
    pub poses: Vec<PoseRecord>,
    pub ticks: Vec<crate::session_capture::TickTiming>,
}

fn jsonl<T: Serialize>(rows: impl IntoIterator<Item = T>) -> String {
    let mut out = String::new();
    for row in rows {
        if let Ok(line) = serde_json::to_string(&row) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out
}

/// Write `dir/repro/` off the tick thread.
pub(crate) fn write_bundle(dir: PathBuf, bundle: ReproBundle) {
    std::thread::spawn(move || {
        let repro = dir.join("repro");
        let events = bundle.events.iter().map(|(tick, value)| serde_json::json!({"tick": tick, "event": value}));
        let written = std::fs::create_dir_all(&repro)
            .and_then(|()| std::fs::write(repro.join("meta.json"), serde_json::to_vec_pretty(&bundle.meta).unwrap_or_default()))
            .and_then(|()| std::fs::write(repro.join("events.jsonl"), jsonl(events)))
            .and_then(|()| std::fs::write(repro.join("inputs.jsonl"), jsonl(bundle.inputs.iter())))
            .and_then(|()| std::fs::write(repro.join("poses.jsonl"), jsonl(bundle.poses.iter())))
            .and_then(|()| std::fs::write(repro.join("ticks.jsonl"), jsonl(bundle.ticks.iter())));
        match written {
            Ok(()) => tracing::info!(dir = %repro.display(), events = bundle.events.len(), inputs = bundle.inputs.len(), "repro bundle stored"),
            Err(error) => tracing::warn!(%error, dir = %repro.display(), "repro bundle write failed"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_last_minute() {
        let mut r = FlightRecorder::default();
        for tick in 0..(HORIZON_TICKS + 100) {
            r.push_input(InputRecord { tick, player: 1, seq: 0, buttons: 0, move_x: 0, move_y: 0, yaw: 0., pitch: 0., in_vehicle: false });
        }
        let inputs = r.inputs();
        assert_eq!(inputs.first().unwrap().tick, 100);
        assert_eq!(inputs.len(), HORIZON_TICKS as usize);
    }
}
