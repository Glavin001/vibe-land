//! A paired session bundle, loaded as frozen server truth.
//!
//! Everything the lab replays comes from here and nothing else: the
//! authoritative world per tick (`world.bin`), the snapshot recipients'
//! non-world inputs and the selection state at capture start
//! (`snapshot-inputs.jsonl`, `snapshot-baseline.json`), the city encoder's
//! inputs, cameras, events and starting state (`city/`), the server's tick
//! timings (`ticks.jsonl`), what it actually sent (`sendlog.bin`) and what
//! the client actually received and drew (`client.vltape`).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use vibe_land_destruction::encoder::EncoderCheckpoint;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::capture::{self as city_capture, CameraSample, CaptureMeta};

use crate::send_log::{self, SendRecord};
use crate::session_capture::{self as sc, SnapshotBaseline, SnapshotInputs, TickTruth};
use crate::vltape::ClientTape;

/// The per-tick costs the lab uses to place packets inside a tick.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct TickTiming {
    pub tick: u32,
    pub mono_us: u64,
    #[serde(default)]
    pub total_ms: f32,
    #[serde(default)]
    pub player_sim_ms: f32,
    #[serde(default)]
    pub vehicle_ms: f32,
    #[serde(default)]
    pub dynamics_ms: f32,
    #[serde(default)]
    pub hitscan_ms: f32,
    /// Shot routing, between dynamics and hitscan (captures since
    /// 2026-09-24; before, it was inside the unattributed residual).
    #[serde(default)]
    pub shots_ms: f32,
    #[serde(default)]
    pub city_ms: f32,
    #[serde(default)]
    pub snapshot_ms: f32,
    #[serde(default)]
    pub publish_ms: f32,
}

pub struct CityInputs {
    pub dir: PathBuf,
    pub meta: CaptureMeta,
    pub manifest: DestructionManifest,
    /// Raw camera samples in file order: the order the live server called
    /// `client_datagrams` in on each send tick.
    pub cameras: Vec<CameraSample>,
    pub events: Vec<serde_json::Value>,
    pub checkpoint: Option<EncoderCheckpoint>,
}

pub struct Bundle {
    pub dir: PathBuf,
    pub server_dir: PathBuf,
    pub session: serde_json::Value,
    pub player: u32,
    pub sim_hz: u32,
    pub tape: ClientTape,
    pub world: Vec<TickTruth>,
    pub world_index: HashMap<u32, usize>,
    pub timings: BTreeMap<u32, TickTiming>,
    pub sendlog: Vec<SendRecord>,
    pub snapshot_inputs: Option<BTreeMap<u32, SnapshotInputs>>,
    pub snapshot_baseline: Option<SnapshotBaseline>,
    pub city: Option<CityInputs>,
    /// Tape clock (ms) = server capture clock (us) / 1000 + this.
    pub clock_offset_ms: f64,
    /// How `clock_offset_ms` was estimated.
    pub clock_offset_source: String,
    pub warnings: Vec<String>,
}

impl Bundle {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        let session: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(sc::MANIFEST_FILE))?)?;
        let server_rel = session["server"]["dir"].as_str().unwrap_or(sc::SERVER_DIR);
        let server_dir = dir.join(server_rel);
        let tape = ClientTape::read(&dir.join(sc::CLIENT_TAPE_FILE))?;
        let player = session["client_player_id"]
            .as_u64()
            .map(|id| id as u32)
            .or_else(|| tape.local_player_id())
            .ok_or_else(|| std::io::Error::other("bundle names no client player"))?;
        let sim_hz = session["server"]["sim_hz"].as_u64().unwrap_or(60) as u32;
        let mut warnings = Vec::new();

        let (_, world) = sc::read_world(&server_dir.join(sc::WORLD_FILE))?;
        let world_index = world.iter().enumerate().map(|(i, t)| (t.tick, i)).collect();
        let mut timings = BTreeMap::new();
        for line in std::fs::read_to_string(server_dir.join(sc::TICKS_FILE))?.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let timing: TickTiming = serde_json::from_str(line)?;
            timings.insert(timing.tick, timing);
        }
        let (_, sendlog) = send_log::read_send_log(&server_dir.join(sc::SEND_LOG_FILE))?;

        let snapshot_inputs = match std::fs::read_to_string(server_dir.join(sc::SNAPSHOT_INPUTS_FILE)) {
            Ok(text) => {
                let mut map = BTreeMap::new();
                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                    let inputs: SnapshotInputs = serde_json::from_str(line)?;
                    map.insert(inputs.tick, inputs);
                }
                Some(map)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warnings.push(
                    "no snapshot-inputs.jsonl (capture predates Netlab v2): acked input \
                     sequences are recovered from the client tape and support is assumed \
                     absent; snapshot bytes are not expected to match exactly"
                        .into(),
                );
                None
            }
            Err(error) => return Err(error),
        };
        let snapshot_baseline = match std::fs::read(server_dir.join(sc::SNAPSHOT_BASELINE_FILE)) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warnings.push(
                    "no snapshot-baseline.json: the snapshot selection starts with empty \
                     interest memory (every body due a refresh on the first tick)"
                        .into(),
                );
                None
            }
            Err(error) => return Err(error),
        };

        let city_dir = server_dir.join(sc::CITY_DIR);
        let city = if city_dir.join(city_capture::META_FILE).is_file() {
            let capture = city_capture::CaptureDir::open(&city_dir)?;
            let manifest: DestructionManifest =
                serde_json::from_slice(&std::fs::read(capture.manifest_path())?)?;
            let checkpoint = city_capture::read_checkpoint(&city_dir)?;
            if checkpoint.is_none() {
                warnings.push(
                    "city capture has no encoder checkpoint (predates Netlab v2): the encoder \
                     starts fresh at the first captured tick, so city bytes are not expected \
                     to match the live stream"
                        .into(),
                );
            }
            Some(CityInputs {
                dir: city_dir.clone(),
                cameras: capture.cameras()?,
                events: capture.events()?,
                meta: capture.meta,
                manifest,
                checkpoint,
            })
        } else {
            None
        };

        let (clock_offset_ms, clock_offset_source) = estimate_clock_offset(&tape);
        Ok(Self {
            dir: dir.to_path_buf(),
            server_dir,
            session,
            player,
            sim_hz,
            tape,
            world,
            world_index,
            timings,
            sendlog,
            snapshot_inputs,
            snapshot_baseline,
            city,
            clock_offset_ms,
            clock_offset_source,
            warnings,
        })
    }

    pub fn truth(&self, tick: u32) -> Option<&TickTruth> {
        self.world_index.get(&tick).map(|&i| &self.world[i])
    }

    pub fn first_tick(&self) -> u32 {
        self.world.first().map_or(0, |t| t.tick)
    }

    pub fn last_tick(&self) -> u32 {
        self.world.last().map_or(0, |t| t.tick)
    }

    /// Server capture clock (us) to tape clock (ms).
    pub fn server_to_tape_ms(&self, mono_us: u64) -> f64 {
        mono_us as f64 / 1000.0 + self.clock_offset_ms
    }

    /// End of tick `tick` on the tape clock, when its timing is known.
    pub fn tick_end_tape_ms(&self, tick: u32) -> Option<f64> {
        self.timings.get(&tick).map(|t| self.server_to_tape_ms(t.mono_us))
    }
}

/// The server capture clock against the tape clock, from the pairing clock
/// samples the client took while recording: each is an NTP-style bracket
/// (request sent, answer received, server clock read in between), so the
/// midpoint estimate is good to half the round trip -- about a millisecond on
/// loopback. The median over samples rejects the odd slow round trip.
fn estimate_clock_offset(tape: &ClientTape) -> (f64, String) {
    let origin = tape.clock_origin_ms();
    let mut offsets: Vec<(f64, f64)> = Vec::new();
    if let Some(samples) = tape.header["pairing"]["clockSamples"].as_array() {
        for sample in samples {
            let (Some(sent), Some(received), Some(mono)) = (
                sample["sentPerfMs"].as_f64(),
                sample["receivedPerfMs"].as_f64(),
                sample["serverMonoUs"].as_f64(),
            ) else {
                continue;
            };
            let midpoint_tape_ms = (sent + received) / 2.0 - origin;
            offsets.push((midpoint_tape_ms - mono / 1000.0, received - sent));
        }
    }
    if offsets.is_empty() {
        return (0.0, "none: no pairing clock samples (tape clock assumed = server clock)".into());
    }
    let mut values: Vec<f64> = offsets.iter().map(|(offset, _)| *offset).collect();
    values.sort_by(|a, b| a.total_cmp(b));
    let median = values[values.len() / 2];
    let mut rtts: Vec<f64> = offsets.iter().map(|(_, rtt)| *rtt).collect();
    rtts.sort_by(|a, b| a.total_cmp(b));
    (
        median,
        format!(
            "median of {} pairing clock samples (rtt p50 {:.2} ms, spread {:.2} ms)",
            values.len(),
            rtts[rtts.len() / 2],
            values[values.len() - 1] - values[0]
        ),
    )
}
