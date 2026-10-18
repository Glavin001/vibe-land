//! A live match writing its own encoder tape.
//!
//! `record-city-trace` records the Blast backend, offline, with one synthetic
//! camera and no players. The server people play on runs the native backend,
//! serves several cameras at once, and has meteors, vehicles and a real join
//! sequence -- none of which the offline recorder can produce. This captures
//! from the match itself: the exact `BodySnapshotInput`s and
//! `DestructionTickOutput` the encoder was fed each tick (the same VLTAPE02
//! the replay tools already read), plus sidecars for what the tape header
//! cannot hold -- every player's camera per send tick, the events that drove
//! the destruction, and the server's own per-tick counters so a window of the
//! tape can be labelled by how many bodies were awake.
//!
//! Nothing here touches the tick's critical path beyond one clone and a
//! channel send: file I/O happens on a writer thread, and if that thread
//! falls behind the tick drops the sample and counts it rather than waiting.
//! A capture with dropped ticks is reported as such and is not used for
//! measurement; a capture that slowed the match it was recording would be
//! measuring itself.

use std::collections::VecDeque;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use vibe_netcode::destruction_backend::DestructionTickOutput;

use crate::encoder::BodySnapshotInput;
use crate::manifest::DestructionManifest;
use crate::netlab::tape::{TapeCamera, TapeWriter};
use crate::types::Camera;

/// File names inside a capture directory. Shared with the readers so the
/// layout is spelled once.
pub const TAPE_FILE: &str = "encoder.tape";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const META_FILE: &str = "capture.json";
pub const CAMERAS_FILE: &str = "cameras.jsonl";
pub const EVENTS_FILE: &str = "events.jsonl";
pub const STATS_FILE: &str = "stats.jsonl";
/// The encoder's state immediately before the first captured tick was
/// ingested (zstd-compressed JSON of `EncoderCheckpoint`). With it a replay
/// of a capture that began mid-match resumes the encoder exactly.
pub const CHECKPOINT_FILE: &str = "encoder-checkpoint.json.zst";

/// Ticks the writer may lag before the tick loop starts dropping samples:
/// ten seconds at 60 Hz, ~6 GB of headroom at the largest tick size seen.
const QUEUE_TICKS: usize = 600;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptureMeta {
    pub hz: u32,
    pub scene: String,
    pub backend: String,
    pub wire: u8,
    pub manifest_hash: String,
    pub first_tick: Option<u32>,
    pub last_tick: Option<u32>,
    pub ticks: u32,
    /// Ticks the writer thread could not keep up with. Non-zero disqualifies
    /// the capture.
    pub dropped_ticks: u64,
    pub created_unix: u64,
    pub fingerprint: serde_json::Value,
}

/// One player's camera on one send tick.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CameraSample {
    pub tick: u32,
    pub player: u32,
    pub eye: [f32; 3],
    pub dir: [f32; 3],
    pub fov: f32,
}

/// The server's counters for one tick, enough to label a window of the tape.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TickStats {
    pub tick: u32,
    pub awake: u32,
    pub step_ms: f32,
    pub encode_ms: f32,
    pub players: u32,
    pub sent_records: u64,
    pub sent_bytes: u64,
    pub reliable_bytes: u64,
    pub outbound_drops: u64,
    pub desync_repairs: u64,
}

enum Message {
    Tick { tick: u32, snapshots: Vec<BodySnapshotInput>, output: DestructionTickOutput },
    Checkpoint(Box<crate::encoder::EncoderCheckpoint>),
    Cameras(String),
    Event(String),
    Stats(String),
    Finish,
}

struct Files {
    dir: PathBuf,
    tape: TapeWriter,
    cameras: BufWriter<std::fs::File>,
    events: BufWriter<std::fs::File>,
    stats: BufWriter<std::fs::File>,
}

pub struct NetlabCapture {
    dir: PathBuf,
    sender: Option<SyncSender<Message>>,
    worker: Option<JoinHandle<std::io::Result<u32>>>,
    meta: CaptureMeta,
    /// Ticks handed to the writer (not the same as ticks written until the
    /// worker has drained).
    pushed: u32,
    /// Retry queue for sidecar lines when the channel is momentarily full;
    /// they are tiny and order matters more than immediacy.
    deferred: VecDeque<Message>,
    checkpointed: bool,
}

impl NetlabCapture {
    /// Open `dir` (created if missing) and start the writer thread.
    pub fn open(
        dir: &Path,
        hz: u32,
        manifest: &DestructionManifest,
        scene: &str,
        backend: &str,
        wire: u8,
        fingerprint: serde_json::Value,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(manifest)?)?;
        // The header camera is a placeholder overview; the replay reads the
        // per-player track from the sidecar. Kept so VLTAPE02 readers and the
        // five earlier tapes need no format change.
        let overview = overview_camera(manifest);
        let tape = TapeWriter::create_zstd(&dir.join(TAPE_FILE), hz, manifest.hash(), overview)?;
        let files = Files {
            dir: dir.to_path_buf(),
            tape,
            cameras: BufWriter::new(std::fs::File::create(dir.join(CAMERAS_FILE))?),
            events: BufWriter::new(std::fs::File::create(dir.join(EVENTS_FILE))?),
            stats: BufWriter::new(std::fs::File::create(dir.join(STATS_FILE))?),
        };
        let meta = CaptureMeta {
            hz,
            scene: scene.to_string(),
            backend: backend.to_string(),
            wire,
            manifest_hash: manifest.hash_hex(),
            first_tick: None,
            last_tick: None,
            ticks: 0,
            dropped_ticks: 0,
            created_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            fingerprint,
        };
        std::fs::write(dir.join(META_FILE), serde_json::to_vec_pretty(&meta)?)?;

        let (sender, receiver) = sync_channel::<Message>(QUEUE_TICKS);
        let worker = std::thread::Builder::new()
            .name("netlab-capture".into())
            .spawn(move || run_writer(files, receiver))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            sender: Some(sender),
            worker: Some(worker),
            meta,
            pushed: 0,
            deferred: VecDeque::new(),
            checkpointed: false,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn meta(&self) -> &CaptureMeta {
        &self.meta
    }

    /// The encoder's input for one tick. Never blocks: a full queue drops the
    /// tick and counts it.
    pub fn push_tick(
        &mut self,
        tick: u32,
        snapshots: &[BodySnapshotInput],
        output: &DestructionTickOutput,
    ) {
        self.flush_deferred();
        let message =
            Message::Tick { tick, snapshots: snapshots.to_vec(), output: output.clone() };
        match self.try_send(message) {
            Ok(()) => {
                self.pushed += 1;
                self.meta.first_tick.get_or_insert(tick);
                self.meta.last_tick = Some(tick);
            }
            Err(_) => self.meta.dropped_ticks += 1,
        }
    }

    pub fn push_cameras(&mut self, tick: u32, cameras: &[(u32, Camera)]) {
        let mut lines = String::new();
        for (player, camera) in cameras {
            let sample = CameraSample {
                tick,
                player: *player,
                eye: camera.eye.to_array(),
                dir: camera.direction.to_array(),
                fov: camera.fov_degrees,
            };
            if let Ok(line) = serde_json::to_string(&sample) {
                lines.push_str(&line);
                lines.push('\n');
            }
        }
        if !lines.is_empty() {
            self.send_or_defer(Message::Cameras(lines));
        }
    }

    /// Anything that drove the destruction: a meteor, a shot, a demolish
    /// request, a join. `value` should carry a `"kind"`.
    pub fn push_event(&mut self, tick: u32, mut value: serde_json::Value) {
        if let serde_json::Value::Object(map) = &mut value {
            map.insert("tick".into(), serde_json::Value::from(tick));
        }
        if let Ok(mut line) = serde_json::to_string(&value) {
            line.push('\n');
            self.send_or_defer(Message::Event(line));
        }
    }

    /// The encoder state the first captured tick will be ingested into.
    /// Call before the first `push_tick`; serialised on the writer thread.
    /// A capture without one can only be replayed from a fresh encoder,
    /// which is exact only when the capture began before the match did.
    pub fn push_checkpoint(&mut self, checkpoint: crate::encoder::EncoderCheckpoint) {
        self.checkpointed = true;
        self.send_or_defer(Message::Checkpoint(Box::new(checkpoint)));
    }

    /// True until a checkpoint has been pushed.
    pub fn needs_checkpoint(&self) -> bool {
        !self.checkpointed
    }

    pub fn push_stats(&mut self, stats: &TickStats) {
        if let Ok(mut line) = serde_json::to_string(stats) {
            line.push('\n');
            self.send_or_defer(Message::Stats(line));
        }
    }

    fn try_send(&mut self, message: Message) -> Result<(), Message> {
        let Some(sender) = self.sender.as_ref() else {
            return Err(message);
        };
        match sender.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(message)) | Err(TrySendError::Disconnected(message)) => {
                Err(message)
            }
        }
    }

    fn send_or_defer(&mut self, message: Message) {
        self.flush_deferred();
        if let Err(message) = self.try_send(message) {
            self.deferred.push_back(message);
        }
    }

    fn flush_deferred(&mut self) {
        while let Some(message) = self.deferred.pop_front() {
            if let Err(message) = self.try_send(message) {
                self.deferred.push_front(message);
                return;
            }
        }
    }

    /// Stop the writer, wait for it to drain, and write the final metadata.
    pub fn finish(mut self) -> std::io::Result<CaptureMeta> {
        self.finish_inner()
    }

    fn finish_inner(&mut self) -> std::io::Result<CaptureMeta> {
        if let Some(sender) = self.sender.take() {
            // Drain the retry queue with a blocking send: the tick loop is
            // done and the only cost now is waiting on the disk.
            while let Some(message) = self.deferred.pop_front() {
                let _ = sender.send(message);
            }
            let _ = sender.send(Message::Finish);
        }
        if let Some(worker) = self.worker.take() {
            let written = worker
                .join()
                .map_err(|_| std::io::Error::other("capture writer thread panicked"))??;
            self.meta.ticks = written;
        }
        std::fs::write(self.dir.join(META_FILE), serde_json::to_vec_pretty(&self.meta)?)?;
        Ok(self.meta.clone())
    }
}

impl Drop for NetlabCapture {
    fn drop(&mut self) {
        if self.sender.is_some() {
            if let Err(error) = self.finish_inner() {
                eprintln!("netlab capture: finishing on drop failed: {error}");
            }
        }
    }
}

fn run_writer(
    mut files: Files,
    receiver: std::sync::mpsc::Receiver<Message>,
) -> std::io::Result<u32> {
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Tick { tick, snapshots, output } => {
                files.tape.push(tick, &snapshots, &output)?;
            }
            Message::Checkpoint(checkpoint) => write_checkpoint(&files.dir, &checkpoint)?,
            Message::Cameras(lines) => files.cameras.write_all(lines.as_bytes())?,
            Message::Event(line) => files.events.write_all(line.as_bytes())?,
            Message::Stats(line) => files.stats.write_all(line.as_bytes())?,
            Message::Finish => break,
        }
    }
    files.cameras.flush()?;
    files.events.flush()?;
    files.stats.flush()?;
    files.tape.finish()
}

fn write_checkpoint(dir: &Path, checkpoint: &crate::encoder::EncoderCheckpoint) -> std::io::Result<()> {
    let json = serde_json::to_vec(checkpoint)?;
    let packed = zstd::encode_all(json.as_slice(), 3)?;
    std::fs::write(dir.join(CHECKPOINT_FILE), packed)
}

/// Reads a capture's encoder checkpoint; `None` when it has none.
pub fn read_checkpoint(dir: &Path) -> std::io::Result<Option<crate::encoder::EncoderCheckpoint>> {
    let packed = match std::fs::read(dir.join(CHECKPOINT_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let json = zstd::decode_all(packed.as_slice())?;
    Ok(Some(serde_json::from_slice(&json)?))
}

/// A camera looking down on the whole scene, for the tape header only.
pub fn overview_camera(manifest: &DestructionManifest) -> TapeCamera {
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            for axis in 0..3 {
                let value = structure.world_position[axis] + chunk.centroid[axis];
                min[axis] = min[axis].min(value - chunk.radius);
                max[axis] = max[axis].max(value + chunk.radius);
            }
        }
    }
    if min[0] > max[0] {
        return TapeCamera {
            eye: [0.0, 40.0, 130.0],
            direction: [0.0, -0.3, -0.95],
            fov_degrees: 80.0,
        };
    }
    let centre = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let extent = (max[0] - min[0]).max(max[2] - min[2]).max(1.0);
    let eye = [centre[0], max[1] + extent * 0.35, max[2] + extent * 0.6];
    let mut direction = [centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]];
    let length = (direction[0] * direction[0]
        + direction[1] * direction[1]
        + direction[2] * direction[2])
        .sqrt()
        .max(1e-6);
    for axis in &mut direction {
        *axis /= length;
    }
    TapeCamera { eye, direction, fov_degrees: 80.0 }
}

/// Everything a reader needs from a capture directory.
pub struct CaptureDir {
    pub dir: PathBuf,
    pub meta: CaptureMeta,
}

impl CaptureDir {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        let meta: CaptureMeta =
            serde_json::from_slice(&std::fs::read(dir.join(META_FILE))?)?;
        Ok(Self { dir: dir.to_path_buf(), meta })
    }

    pub fn tape_path(&self) -> PathBuf {
        self.dir.join(TAPE_FILE)
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.dir.join(MANIFEST_FILE)
    }

    pub fn cameras(&self) -> std::io::Result<Vec<CameraSample>> {
        read_jsonl(&self.dir.join(CAMERAS_FILE))
    }

    pub fn stats(&self) -> std::io::Result<Vec<TickStats>> {
        read_jsonl(&self.dir.join(STATS_FILE))
    }

    pub fn events(&self) -> std::io::Result<Vec<serde_json::Value>> {
        read_jsonl(&self.dir.join(EVENTS_FILE))
    }
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<Vec<T>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(line).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{}:{}: {error}", path.display(), index + 1),
            )
        })?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlab::tape::TapeReader;
    use vibe_netcode::destruction_backend::SettleEvent;

    fn manifest() -> DestructionManifest {
        serde_json::from_str(r#"{"version":1,"structures":[]}"#).expect("empty manifest")
    }

    /// The reader-facing contract: a capture is a tape plus sidecars whose
    /// tick numbers agree, and its metadata says how many ticks it holds.
    #[test]
    fn a_capture_round_trips_tape_cameras_events_and_stats() {
        let dir = std::env::temp_dir().join(format!("vl-capture-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let manifest = manifest();
        let mut capture = NetlabCapture::open(
            &dir,
            60,
            &manifest,
            "test.json",
            "native",
            2,
            serde_json::json!({"git": "test"}),
        )
        .expect("open");

        let snapshot = BodySnapshotInput {
            body_entity: 0x8000_0001,
            position: [1.0, 2.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linear_velocity: [0.0, -1.0, 0.0],
            angular_velocity: [0.0; 3],
            contacts: 0,
            flags: 0,
        };
        let output = DestructionTickOutput {
            batches: Vec::new(),
            settled: vec![SettleEvent {
                structure_id: 0,
                island_id: 1,
                position: [0.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
            }],
            wakes: Vec::new(),
        };
        for tick in 100..103 {
            capture.push_tick(tick, &[snapshot], &output);
            if tick % 2 == 0 {
                capture.push_cameras(
                    tick,
                    &[(
                        7,
                        Camera {
                            eye: glam::Vec3::new(1.0, 2.0, 3.0),
                            direction: glam::Vec3::NEG_Z,
                            fov_degrees: 80.0,
                        },
                    )],
                );
            }
            capture.push_stats(&TickStats { tick, awake: 1, ..Default::default() });
        }
        capture.push_event(101, serde_json::json!({"kind": "meteor", "target": [1, 2, 3]}));
        let meta = capture.finish().expect("finish");
        assert_eq!(meta.ticks, 3);
        assert_eq!(meta.first_tick, Some(100));
        assert_eq!(meta.last_tick, Some(102));
        assert_eq!(meta.dropped_ticks, 0);

        let opened = CaptureDir::open(&dir).expect("open dir");
        assert_eq!(opened.meta.backend, "native");
        let mut reader = TapeReader::open(&opened.tape_path()).expect("tape");
        let mut ticks = Vec::new();
        while let Some(tick) = reader.next_tick().expect("read") {
            assert_eq!(tick.snapshots.len(), 1);
            assert_eq!(tick.output, output);
            ticks.push(tick.tick);
        }
        assert_eq!(ticks, vec![100, 101, 102]);
        let cameras = opened.cameras().expect("cameras");
        assert_eq!(cameras.iter().map(|c| c.tick).collect::<Vec<_>>(), vec![100, 102]);
        assert_eq!(cameras[0].player, 7);
        let stats = opened.stats().expect("stats");
        assert_eq!(stats.len(), 3);
        let events = opened.events().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["tick"], 101);
        assert_eq!(events[0]["kind"], "meteor");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
