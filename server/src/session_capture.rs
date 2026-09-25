//! Paired client+server capture: one recording of a play session from both
//! ends, joined by a shared session id.
//!
//! A client that starts a tape (the RECORD TAPE button, or the e2e bridge)
//! asks the match to start a session capture. The match keeps at most ONE
//! capture running and reference-counts the sessions that asked for it, so
//! several clients -- or one client's overlapping requests -- share one set of
//! writers and one per-tick cost; the capture stops when its last session
//! does. The first session's bundle holds the capture files under `server/`;
//! a session that joined a running capture points its manifest there and
//! records its own tick window.
//!
//! Bundle layout, `debug-reports/session-<id>/`:
//!   session.json          the manifest, merged into
//!                         as start, stop and the client's tape upload land
//!   client.vltape         the client's tape (VLCTAPE2)
//!   stats-start.json      /match-stats as the capture started and stopped,
//!   stats-stop.json       including the 300-tick timing ring
//!   server/               (the session that opened the capture)
//!     world.bin           per-tick authoritative players, vehicles and
//!                         dynamic bodies, before interest or quantisation
//!     sendlog.bin         every packet sent to every client (send_log.rs)
//!     ticks.jsonl         per-tick timings, with tick, monotonic and wall time,
//!                         and the physics step's phases (`TickTiming`)
//!     selections.jsonl    per-client interest / byte-budget decisions
//!     session-capture.json  writer metadata: ticks written and dropped
//!     city/               the netlab encoder capture (city matches only)
//!
//! One clock: every record carries the server tick, and microseconds since
//! the capture epoch; `epoch_unix_us` in each header (and the manifest) puts
//! that on the wall clock.
//!
//! Nothing here slows the tick beyond building the records: files are written
//! by writer threads fed through bounded channels, and a full channel drops
//! the record and counts it (`dropped_ticks`, `dropped_records`) rather than
//! stalling. A capture with drops says so in its metadata.

use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub const MANIFEST_FILE: &str = "session.json";
pub const CLIENT_TAPE_FILE: &str = "client.vltape";
pub const SERVER_DIR: &str = "server";
pub const WORLD_FILE: &str = "world.bin";
pub const SEND_LOG_FILE: &str = "sendlog.bin";
pub const TICKS_FILE: &str = "ticks.jsonl";
pub const SELECTIONS_FILE: &str = "selections.jsonl";
/// Per snapshot tick, each recipient's non-world snapshot inputs (acked
/// input sequence, support, melee flag): with `world.bin` these are exactly
/// what `snapshot_builder::build_recipient_snapshot` was called with.
pub const SNAPSHOT_INPUTS_FILE: &str = "snapshot-inputs.jsonl";
/// Written once when the capture opens: every connected player's snapshot
/// interest memory and the match's handle tables, so an offline replay can
/// start mid-match from the exact state the live selection was in.
pub const SNAPSHOT_BASELINE_FILE: &str = "snapshot-baseline.json";
pub const CAPTURE_META_FILE: &str = "session-capture.json";
pub const CITY_DIR: &str = "city";
pub const STATS_START_FILE: &str = "stats-start.json";
pub const STATS_STOP_FILE: &str = "stats-stop.json";
pub const WORLD_MAGIC: &[u8; 8] = b"VLWORLD1";
pub const MANIFEST_FORMAT: &str = "vibe-session-bundle/1";

/// Ticks the tick writer may lag before it drops: ten seconds at 60 Hz.
const QUEUE_TICKS: usize = 600;

/// A client-chosen id becomes a directory name, so it is held to a strict
/// alphabet: no separators, no dots, nothing a path could be built from.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn bundle_dir(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("session-{session_id}"))
}

pub fn unix_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros() as u64)
        .unwrap_or(0)
}

pub fn micros_since(epoch: Instant) -> u64 {
    epoch.elapsed().as_micros() as u64
}

// ── Per-tick records ───────────────────────────────────────────────────────

/// A player as the arena has them this tick.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlayerTruth {
    pub id: u32,
    /// Snapshot-V2 handle (0 if none).
    pub handle: u8,
    pub hp: u8,
    pub flags: u16,
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
}

/// A vehicle. The arena reports vehicles already in wire units (mm, snorm,
/// cm/s), so these are those values converted back -- exact to the wire's
/// own precision, which is what a received snapshot is compared against.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VehicleTruth {
    pub id: u32,
    pub handle: u8,
    pub vehicle_type: u8,
    pub flags: u8,
    pub driver: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
}

/// A non-city dynamic body: balls, boxes, cannonballs, meteors.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodyTruth {
    pub id: u32,
    /// Snapshot-V2 handle (0 if none).
    pub handle: u16,
    pub shape: u8,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub half_extents: [f32; 3],
    pub velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TickTruth {
    pub tick: u32,
    pub mono_us: u64,
    pub unix_us: u64,
    pub players: Vec<PlayerTruth>,
    pub vehicles: Vec<VehicleTruth>,
    pub bodies: Vec<BodyTruth>,
}

pub const PLAYER_BYTES: usize = 40;
pub const VEHICLE_BYTES: usize = 63;
pub const BODY_BYTES: usize = 71;

struct Out<'a>(&'a mut Vec<u8>);

impl Out<'_> {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32s(&mut self, v: &[f32]) {
        for x in v {
            self.0.extend_from_slice(&x.to_le_bytes());
        }
    }
}

impl TickTruth {
    /// One tick of `world.bin`:
    ///   [u32 tick][u64 mono_us][u64 unix_us][u16 players][u16 vehicles][u32 bodies]
    ///   players  x40: [u32 id][u8 handle][u8 hp][u16 flags][f32 pos3][f32 vel3][f32 yaw][f32 pitch]
    ///   vehicles x63: [u32 id][u8 handle][u8 type][u8 flags][u32 driver][f32 pos3][f32 quat4][f32 vel3][f32 angvel3]
    ///   bodies   x71: [u32 id][u16 handle][u8 shape][f32 pos3][f32 quat4][f32 half3][f32 vel3][f32 angvel3]
    pub fn encode_into(&self, out: &mut Vec<u8>) {
        let mut o = Out(out);
        o.u32(self.tick);
        o.u64(self.mono_us);
        o.u64(self.unix_us);
        o.u16(self.players.len().min(u16::MAX as usize) as u16);
        o.u16(self.vehicles.len().min(u16::MAX as usize) as u16);
        o.u32(self.bodies.len() as u32);
        for p in self.players.iter().take(u16::MAX as usize) {
            o.u32(p.id);
            o.u8(p.handle);
            o.u8(p.hp);
            o.u16(p.flags);
            o.f32s(&p.position);
            o.f32s(&p.velocity);
            o.f32s(&[p.yaw, p.pitch]);
        }
        for v in self.vehicles.iter().take(u16::MAX as usize) {
            o.u32(v.id);
            o.u8(v.handle);
            o.u8(v.vehicle_type);
            o.u8(v.flags);
            o.u32(v.driver);
            o.f32s(&v.position);
            o.f32s(&v.rotation);
            o.f32s(&v.velocity);
            o.f32s(&v.angular_velocity);
        }
        for b in &self.bodies {
            o.u32(b.id);
            o.u16(b.handle);
            o.u8(b.shape);
            o.f32s(&b.position);
            o.f32s(&b.rotation);
            o.f32s(&b.half_extents);
            o.f32s(&b.velocity);
            o.f32s(&b.angular_velocity);
        }
    }

    /// Decodes one tick from the front of `bytes`; returns it and its length.
    // The reference reader for the format; the server itself only writes.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn decode(bytes: &[u8]) -> Option<(Self, usize)> {
        struct In<'a> {
            b: &'a [u8],
            at: usize,
        }
        impl In<'_> {
            fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
                let out = self.b.get(self.at..self.at + N)?.try_into().ok()?;
                self.at += N;
                Some(out)
            }
            fn u8(&mut self) -> Option<u8> {
                Some(self.take::<1>()?[0])
            }
            fn u16(&mut self) -> Option<u16> {
                Some(u16::from_le_bytes(self.take()?))
            }
            fn u32(&mut self) -> Option<u32> {
                Some(u32::from_le_bytes(self.take()?))
            }
            fn u64(&mut self) -> Option<u64> {
                Some(u64::from_le_bytes(self.take()?))
            }
            fn f32(&mut self) -> Option<f32> {
                Some(f32::from_le_bytes(self.take()?))
            }
            fn v3(&mut self) -> Option<[f32; 3]> {
                Some([self.f32()?, self.f32()?, self.f32()?])
            }
            fn v4(&mut self) -> Option<[f32; 4]> {
                Some([self.f32()?, self.f32()?, self.f32()?, self.f32()?])
            }
        }
        let mut i = In { b: bytes, at: 0 };
        let tick = i.u32()?;
        let mono_us = i.u64()?;
        let unix_us = i.u64()?;
        let (np, nv, nb) = (i.u16()? as usize, i.u16()? as usize, i.u32()? as usize);
        let mut players = Vec::with_capacity(np.min(4096));
        for _ in 0..np {
            let id = i.u32()?;
            let handle = i.u8()?;
            let hp = i.u8()?;
            let flags = i.u16()?;
            let position = i.v3()?;
            let velocity = i.v3()?;
            let (yaw, pitch) = (i.f32()?, i.f32()?);
            players.push(PlayerTruth { id, handle, hp, flags, position, velocity, yaw, pitch });
        }
        let mut vehicles = Vec::with_capacity(nv.min(4096));
        for _ in 0..nv {
            vehicles.push(VehicleTruth {
                id: i.u32()?,
                handle: i.u8()?,
                vehicle_type: i.u8()?,
                flags: i.u8()?,
                driver: i.u32()?,
                position: i.v3()?,
                rotation: i.v4()?,
                velocity: i.v3()?,
                angular_velocity: i.v3()?,
            });
        }
        let mut bodies = Vec::with_capacity(nb.min(65_536));
        for _ in 0..nb {
            bodies.push(BodyTruth {
                id: i.u32()?,
                handle: i.u16()?,
                shape: i.u8()?,
                position: i.v3()?,
                rotation: i.v4()?,
                half_extents: i.v3()?,
                velocity: i.v3()?,
                angular_velocity: i.v3()?,
            });
        }
        let at = i.at;
        Some((Self { tick, mono_us, unix_us, players, vehicles, bodies }, at))
    }
}

/// The tick's cost, bracket by bracket, as the match measured it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TickTiming {
    pub tick: u32,
    pub mono_us: u64,
    pub unix_us: u64,
    pub total_ms: f32,
    pub player_sim_ms: f32,
    pub vehicle_ms: f32,
    pub dynamics_ms: f32,
    pub hitscan_ms: f32,
    pub city_ms: f32,
    pub snapshot_ms: f32,
    pub publish_ms: f32,
    pub unattributed_ms: f32,
    pub players: u32,
    pub awake_city_bodies: u32,
    /// The capture's own cost on the tick thread: building this tick's truth
    /// and selection records and handing them to the writer.
    pub capture_ms: f32,

    // ---- Added 2026-09-24 (TICK_TIMING_VERSION 2). Every field below is
    // absent from older captures and defaults when read; nothing above was
    // renamed or re-typed. Readers that see `timing_version` >= 2 may rely on
    // `snapshot_ms` being this tick's own value (0 on a tick that sent no
    // snapshot); before it, a non-snapshot tick repeated the last snapshot
    // tick's cost.
    /// 0 in captures older than this field; `TICK_TIMING_VERSION` since.
    #[serde(default)]
    pub timing_version: u32,
    /// Whether this tick broadcast the game snapshot (`snapshot_ms` is its cost).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_sent: Option<bool>,
    /// Routing the tick's queued shots into the city: meteor launches aimed
    /// by players and cannonballs thrown. A top-level bracket, so it no longer
    /// lands in `unattributed_ms`.
    #[serde(default)]
    pub shots_ms: f32,
    /// Meteors launched this tick (player-fired and scripted), and the time
    /// the launches took. The time is inside `shots_ms` (player-fired) or
    /// `city_ms` (scripted `/city-meteor`), not an extra bracket.
    #[serde(default)]
    pub meteors_launched: u32,
    #[serde(default)]
    pub meteor_launch_ms: f32,
    /// The PhysX step's phases (PhysX GPU backend only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physx: Option<PhysxPhases>,
    /// The native destruction stage's tick (native destruction only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<StagePhases>,
    /// The tick's largest engine profile zones (at or above
    /// `ENGINE_ZONE_FLOOR_MS`, at most `ENGINE_ZONE_LIMIT`), by name
    /// (`VIBE_PHYSX_PROFILE=1` only). Zone
    /// times are summed over calls and threads, and the `cuda.*` ones are GPU
    /// time from events, so they overlap and do not add up to a wall-clock
    /// parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_zones: Option<BTreeMap<String, f32>>,
    /// What collecting `physx`, `stage` and `engine_zones` cost the tick
    /// thread, microseconds. Included in `capture_ms`.
    #[serde(default)]
    pub phases_us: f32,
}

/// `TickTiming::timing_version` of records this server writes.
pub const TICK_TIMING_VERSION: u32 = 2;

/// Engine zones below this are left out of `TickTiming::engine_zones`, and
/// at most `ENGINE_ZONE_LIMIT` of the largest are kept, so a profiled
/// half-hour capture stays tens of megabytes.
pub const ENGINE_ZONE_FLOOR_MS: f32 = 0.05;
pub const ENGINE_ZONE_LIMIT: usize = 24;

/// The PhysX step, phase by phase, as the bridge timed it this tick.
///
/// `dynamics_ms` = `controller_ms` + `submit_ms` + `fetch_ms` +
/// `readback_ms` + `players_ms` + a small remainder (bookkeeping between the
/// brackets). With GPU dynamics `submit_ms` only dispatches; the simulation
/// (and the native destruction stage inside it) runs while the server does
/// `overlap_ms` of other work, and `fetch_ms` is the rest of the wait.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PhysxPhases {
    /// Vehicle model + character-controller interactions before `simulate`.
    pub controller_ms: f32,
    /// The `simulate()` call: the step's submission.
    pub submit_ms: f32,
    /// Server work run between submit and fetch (the deferred city observer
    /// flush of the split step). Counted in `city_ms`, not `dynamics_ms`.
    pub overlap_ms: f32,
    /// `fetchResults`: the GPU wait (the destruction stage runs in here),
    /// PhysX's result copy and our contact callbacks.
    pub fetch_ms: f32,
    /// Our contact callbacks, inside `fetch_ms`.
    pub callbacks_ms: f32,
    /// The pure GPU wait inside `fetch_ms`, on the bridge's sampled ticks
    /// only (1 in 16 by default); absent on the others.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_wait_ms: Option<f32>,
    /// Contact, body and vehicle readbacks after the fetch.
    pub readback_ms: f32,
    /// Refreshing the players from the scene after the fetch.
    pub players_ms: f32,
    /// PhysX's active dynamic bodies after the step.
    pub awake_bodies: u32,
    /// Broad-phase pairs found and lost this step.
    pub found_pairs: u32,
    pub lost_pairs: u32,
}

/// The native destruction stage's part of the tick.
///
/// The counts come from the stage's status and the events the server took
/// this tick, so they are there on every tick. The stage publishes no timings
/// of its own; its phase times (`zones`) exist only when the engine profiler
/// runs (`VIBE_PHYSX_PROFILE=1`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StagePhases {
    pub frame: u64,
    /// Engine error bits; non-zero means the step was rejected.
    pub error: u32,
    /// Stress solver iterations and whether the solve converged.
    pub iterations: u32,
    pub converged: bool,
    /// Stress evaluations: the trial plus one per corrected re-solve.
    pub passes: u32,
    /// Corrected rigid re-solves run inside the step.
    pub corrections: u32,
    /// Bond-broken events committed this tick, and how many of the stage's
    /// breaks came from the evaluations after a correction.
    pub bonds_broken: u32,
    pub bonds_broken_after_correction: u32,
    pub crushed_chunks: u32,
    /// Normal contacts the stage loaded the bond graph with.
    pub contacts: u32,
    /// New bodies (a split tick has at least one) and chunks that moved body.
    pub bodies_promoted: u32,
    pub chunks_migrated: u32,
    /// The bridge's observation of the step on the host (`native_tick_ms`),
    /// after the fetch. Inside `city_ms`.
    pub observe_ms: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zones: Option<StageZones>,
}

/// The stage's phase times from the engine profiler, grouped. CPU zones are
/// wall time on the thread that ran them; `*_gpu_ms` are GPU time between
/// CUDA events. They overlap each other (the CPU waits for the GPU inside
/// `finish_ms`; task-thread zones run beside the step's own thread), so they
/// are phases to compare, not parts of a sum.
///
/// Zones nested inside another (`finishDetail.*`, `detail.*`, the other
/// `*Detail.*`) are not counted again in a group; the ones worth naming are
/// broken out (`finish_gpu_wait_ms`, `trial_broadphase_wait_ms`) and every
/// zone is also in `TickTiming::engine_zones`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StageZones {
    /// `GpuDestruction.submit`: prepare, borrow the solved contacts, advance.
    pub submit_ms: f32,
    /// `GpuDestruction.finishAndReserve`: waits for the stage's GPU work and
    /// reserves the new bodies; `finish_gpu_wait_ms` is its wait
    /// (`finishDetail.waitForGpu`).
    pub finish_ms: f32,
    pub finish_gpu_wait_ms: f32,
    /// Contact loads, stress solve and material update on the GPU.
    pub stress_gpu_ms: f32,
    /// Topology, split candidates and the commit on the GPU.
    pub fracture_gpu_ms: f32,
    /// The trial rigid solve's broad phase (`trialDetail.postBroadPhase`),
    /// the wait for it inside that (`trialDetail.broadPhaseWait`), its
    /// narrow phase, and its other detail zones.
    pub trial_broadphase_ms: f32,
    pub trial_broadphase_wait_ms: f32,
    pub trial_narrowphase_ms: f32,
    pub trial_other_ms: f32,
    /// `GpuDestruction.correctedCollisionSolve`: the corrected rigid re-solve.
    pub correction_ms: f32,
    /// Host work that sets the correction up and accepts it: restore,
    /// install, bindings, metadata, checkpoint, cache resets, acceptance.
    pub correction_prep_ms: f32,
    /// Rewinding state and installing the fragments and owners on the GPU.
    pub correction_gpu_ms: f32,
    /// `task.prepareIslandRepair`, on a task thread.
    pub island_repair_ms: f32,
    /// Native body allocation and its host compatibility records.
    pub body_alloc_ms: f32,
    /// Every other top-level `GpuDestruction.*` zone, summed (`task.*`,
    /// publication, ...).
    pub other_ms: f32,
}

impl StageZones {
    /// Groups this tick's engine spans (`name`, `value`, `kind` as the bridge
    /// publishes them: kind 1 is a zone total, kind 2 a count). None when no
    /// `GpuDestruction.*` zone is present, i.e. the profiler is off.
    pub fn from_spans<'a>(spans: impl IntoIterator<Item = (&'a str, f64, u8)>) -> Option<Self> {
        let mut out = Self::default();
        let mut any = false;
        for (name, value, kind) in spans {
            if kind != 1 {
                continue;
            }
            let Some(zone) = name.strip_prefix("GpuDestruction.") else {
                continue;
            };
            any = true;
            let ms = value as f32;
            let slot = match zone {
                "submit" => &mut out.submit_ms,
                "finishAndReserve" => &mut out.finish_ms,
                "finishDetail.waitForGpu" => &mut out.finish_gpu_wait_ms,
                "cuda.contactLoads" | "cuda.stress" | "cuda.materials" => &mut out.stress_gpu_ms,
                "cuda.topologyAndCandidates" | "cuda.commitAndStressTopology" => {
                    &mut out.fracture_gpu_ms
                }
                "trialDetail.postBroadPhase" => &mut out.trial_broadphase_ms,
                "trialDetail.broadPhaseWait" => &mut out.trial_broadphase_wait_ms,
                "trialDetail.postNarrowPhase" => &mut out.trial_narrowphase_ms,
                zone if zone.starts_with("trialDetail.") => &mut out.trial_other_ms,
                "correctedCollisionSolve" => &mut out.correction_ms,
                "restoreInstall" | "preparationCompletion" | "applyBindings"
                | "publishReservedMetadata" | "validatePreparation" | "checkpoint"
                | "resetContactCaches" | "acceptCorrection" => &mut out.correction_prep_ms,
                "cuda.rewindState" | "cuda.installFragments" | "cuda.installOwners"
                | "cuda.finalSplitState" | "cuda.finalSplitFragments"
                | "cuda.finalSplitOwners" => &mut out.correction_gpu_ms,
                "task.prepareIslandRepair" => &mut out.island_repair_ms,
                zone if zone.starts_with("cuda.allocationAndPreparation")
                    || zone.starts_with("compatibility.") =>
                {
                    &mut out.body_alloc_ms
                }
                // Nested inside a zone counted above, or (`contactStress`,
                // compiled out of release SDKs) the parent of them all: in
                // engine_zones only.
                "contactStress" => continue,
                zone if zone.starts_with("detail.") || zone.contains("Detail.") => continue,
                _ => &mut out.other_ms,
            };
            *slot += ms;
        }
        any.then_some(out)
    }
}

/// The largest engine zones (kind 1) at or above `ENGINE_ZONE_FLOOR_MS`, at
/// most `ENGINE_ZONE_LIMIT`, by name; None when there are none (the profiler
/// is off).
pub fn engine_zones<'a>(
    spans: impl IntoIterator<Item = (&'a str, f64, u8)>,
) -> Option<BTreeMap<String, f32>> {
    let mut zones: Vec<(&str, f64)> = spans
        .into_iter()
        .filter(|&(_, value, kind)| kind == 1 && value as f32 >= ENGINE_ZONE_FLOOR_MS)
        .map(|(name, value, _)| (name, value))
        .collect();
    if zones.is_empty() {
        return None;
    }
    zones.sort_by(|a, b| b.1.total_cmp(&a.1));
    zones.truncate(ENGINE_ZONE_LIMIT);
    Some(
        zones
            .into_iter()
            .map(|(name, value)| (name.to_string(), (value * 1000.0).round() as f32 / 1000.0))
            .collect(),
    )
}

/// What one client's snapshot left out, and why.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SnapshotSelection {
    /// Remote players inside the area of interest / sent / deferred by the
    /// datagram byte budget.
    pub players_aoi: u32,
    pub players_sent: u32,
    pub players_budget: u32,
    /// Vehicles inside the AOI (or driven by the client) / changed enough or
    /// due a refresh / sent / deferred by the budget.
    pub vehicles_aoi: u32,
    pub vehicles_hot: u32,
    pub vehicles_sent: u32,
    pub vehicles_budget: u32,
    /// Dynamic bodies inside the AOI / selected as hot / skipped as unchanged
    /// and not due a refresh (coalesced) / sent / deferred by the budget.
    pub bodies_aoi: u32,
    pub bodies_hot: u32,
    pub bodies_unchanged: u32,
    pub bodies_sent: u32,
    pub bodies_budget: u32,
    /// Entities in the AOI too far from the client to quantize relative to it.
    pub out_of_range: u32,
    /// Bytes of the snapshot (the budget is the strict datagram target).
    pub bytes: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stream", rename_all = "snake_case")]
pub enum SelectionKind {
    Snapshot(SnapshotSelection),
    City(vibe_land_destruction::encoder::ClientSelectionSummary),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Selection {
    pub tick: u32,
    pub player: u32,
    #[serde(flatten)]
    pub kind: SelectionKind,
}

/// One snapshot tick's recipient inputs (see `SNAPSHOT_INPUTS_FILE`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SnapshotInputs {
    pub tick: u32,
    /// The SnapshotV2 wall-clock trailer stamped this tick.
    #[serde(default)]
    pub server_wall_us: Option<u32>,
    pub recipients: Vec<crate::snapshot_builder::RecipientInput>,
    /// Players whose snapshot flags carried FLAG_MELEEING this tick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub meleeing: Vec<u32>,
}

/// The snapshot selection's state as the capture opened (see
/// `SNAPSHOT_BASELINE_FILE`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SnapshotBaseline {
    /// The last completed tick when the capture opened; the first captured
    /// tick is the next one.
    pub tick: u32,
    pub strict_snapshot_datagrams: bool,
    pub snapshot_hz: u32,
    pub interest: BTreeMap<u32, crate::snapshot_builder::RecipientInterest>,
    pub player_handles: BTreeMap<u32, u8>,
    pub vehicle_handles: BTreeMap<u32, u8>,
    pub body_meta: BTreeMap<u32, crate::snapshot_builder::BodyMeta>,
    /// The SnapshotV2 format options the server ran with
    /// (`SnapshotConfig::compact_self` / `removals`). A capture from before
    /// they existed has neither field and replays with both off.
    #[serde(default)]
    pub compact_self: bool,
    #[serde(default)]
    pub removals: bool,
    /// `SnapshotConfig::idle_cold`, recorded the same way.
    #[serde(default)]
    pub idle_cold: bool,
}

/// Everything the tick hands the writer, once per tick.
pub struct TickBundle {
    pub truth: TickTruth,
    pub timing: TickTiming,
    pub selections: Vec<Selection>,
}

enum TickMessage {
    Tick(Box<TickBundle>),
    SnapshotInputs(Box<SnapshotInputs>),
    Finish,
}

struct TickFiles {
    world: BufWriter<std::fs::File>,
    ticks: BufWriter<std::fs::File>,
    selections: BufWriter<std::fs::File>,
    snapshot_inputs: BufWriter<std::fs::File>,
}

/// The writer thread behind `world.bin`, `ticks.jsonl`, `selections.jsonl`.
pub struct TickWriter {
    tx: SyncSender<TickMessage>,
    worker: Option<JoinHandle<std::io::Result<u64>>>,
    pub pushed: u64,
    pub dropped: u64,
    pub first_tick: Option<u32>,
    pub last_tick: Option<u32>,
    pub dropped_inputs: u64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TickWriterSummary {
    pub ticks: u64,
    pub dropped_ticks: u64,
    pub first_tick: Option<u32>,
    pub last_tick: Option<u32>,
}

impl TickWriter {
    pub fn open(dir: &Path, epoch_unix_us: u64, sim_hz: u32) -> std::io::Result<Self> {
        Self::open_with_capacity(dir, epoch_unix_us, sim_hz, QUEUE_TICKS)
    }

    pub fn open_with_capacity(
        dir: &Path,
        epoch_unix_us: u64,
        sim_hz: u32,
        capacity: usize,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let mut world = BufWriter::new(std::fs::File::create(dir.join(WORLD_FILE))?);
        let header = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "sim_hz": sim_hz,
            "epoch_unix_us": epoch_unix_us,
            "tick_header": "u32 tick, u64 mono_us, u64 unix_us, u16 players, u16 vehicles, u32 bodies",
            "player": "u32 id, u8 handle, u8 hp, u16 flags, f32 pos[3], f32 vel[3], f32 yaw, f32 pitch",
            "vehicle": "u32 id, u8 handle, u8 type, u8 flags, u32 driver, f32 pos[3], f32 quat[4], f32 vel[3], f32 angvel[3]",
            "body": "u32 id, u16 handle, u8 shape, f32 pos[3], f32 quat[4], f32 half_extents[3], f32 vel[3], f32 angvel[3]",
            "record_bytes": {"player": PLAYER_BYTES, "vehicle": VEHICLE_BYTES, "body": BODY_BYTES},
        }))?;
        world.write_all(WORLD_MAGIC)?;
        world.write_all(&(header.len() as u32).to_le_bytes())?;
        world.write_all(&header)?;
        let files = TickFiles {
            world,
            ticks: BufWriter::new(std::fs::File::create(dir.join(TICKS_FILE))?),
            selections: BufWriter::new(std::fs::File::create(dir.join(SELECTIONS_FILE))?),
            snapshot_inputs: BufWriter::new(std::fs::File::create(dir.join(SNAPSHOT_INPUTS_FILE))?),
        };
        let (tx, rx) = sync_channel(capacity.max(1));
        let worker = std::thread::Builder::new()
            .name("session-capture".into())
            .spawn(move || run_tick_writer(files, rx))?;
        Ok(Self {
            tx,
            worker: Some(worker),
            pushed: 0,
            dropped: 0,
            first_tick: None,
            last_tick: None,
            dropped_inputs: 0,
        })
    }

    /// Never blocks: a full queue drops the tick and counts it.
    pub fn push(&mut self, bundle: TickBundle) {
        let tick = bundle.truth.tick;
        match self.tx.try_send(TickMessage::Tick(Box::new(bundle))) {
            Ok(()) => {
                self.pushed += 1;
                self.first_tick.get_or_insert(tick);
                self.last_tick = Some(tick);
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => self.dropped += 1,
        }
    }

    /// One snapshot tick's recipient inputs. Never blocks; a full queue
    /// drops them and counts it (`dropped_inputs`), which makes the capture
    /// unusable for byte-exact offline snapshot replay from that tick on.
    pub fn push_snapshot_inputs(&mut self, inputs: SnapshotInputs) {
        match self.tx.try_send(TickMessage::SnapshotInputs(Box::new(inputs))) {
            Ok(()) => {}
            Err(_) => self.dropped_inputs += 1,
        }
    }

    pub fn finish(mut self) -> std::io::Result<TickWriterSummary> {
        let _ = self.tx.send(TickMessage::Finish);
        let ticks = match self.worker.take() {
            Some(worker) => worker
                .join()
                .map_err(|_| std::io::Error::other("session capture writer panicked"))??,
            None => 0,
        };
        Ok(TickWriterSummary {
            ticks,
            dropped_ticks: self.dropped,
            first_tick: self.first_tick,
            last_tick: self.last_tick,
        })
    }
}

fn run_tick_writer(mut files: TickFiles, rx: Receiver<TickMessage>) -> std::io::Result<u64> {
    let mut written = 0u64;
    let mut buffer = Vec::with_capacity(64 * 1024);
    while let Ok(message) = rx.recv() {
        match message {
            TickMessage::Tick(bundle) => {
                buffer.clear();
                bundle.truth.encode_into(&mut buffer);
                files.world.write_all(&buffer)?;
                serde_json::to_writer(&mut files.ticks, &bundle.timing)?;
                files.ticks.write_all(b"\n")?;
                for selection in &bundle.selections {
                    serde_json::to_writer(&mut files.selections, selection)?;
                    files.selections.write_all(b"\n")?;
                }
                written += 1;
            }
            TickMessage::SnapshotInputs(inputs) => {
                serde_json::to_writer(&mut files.snapshot_inputs, &*inputs)?;
                files.snapshot_inputs.write_all(b"\n")?;
            }
            TickMessage::Finish => break,
        }
    }
    files.world.flush()?;
    files.ticks.flush()?;
    files.selections.flush()?;
    files.snapshot_inputs.flush()?;
    Ok(written)
}

/// Reads `world.bin` whole; a trailing partial tick is ignored.
// The reference reader for the format; the server itself only writes.
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_world(path: &Path) -> std::io::Result<(serde_json::Value, Vec<TickTruth>)> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 12 || &bytes[..8] != WORLD_MAGIC {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a VLWORLD1 file"));
    }
    let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let mut at = 12 + header_len;
    let header = serde_json::from_slice(bytes.get(12..at).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "short world header")
    })?)?;
    let mut ticks = Vec::new();
    while let Some((tick, used)) = TickTruth::decode(&bytes[at..]) {
        ticks.push(tick);
        at += used;
    }
    Ok((header, ticks))
}

// ── Sessions ───────────────────────────────────────────────────────────────

/// A point on the server's clock.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerMark {
    pub tick: u32,
    pub unix_us: u64,
    /// Microseconds since the capture epoch.
    pub mono_us: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionEntry {
    pub session_id: String,
    pub player_id: Option<u32>,
    /// The session's own bundle directory.
    pub bundle: PathBuf,
    pub start: ServerMark,
}

/// Why a session ended.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Requested,
    PlayerDisconnected,
    MaxDuration,
    MatchEnded,
}

/// The session registry of one match: which sessions share the running
/// capture. Pure bookkeeping, so the rules can be tested without a match.
#[derive(Debug, Default)]
pub struct Sessions {
    active: BTreeMap<String, SessionEntry>,
}

#[derive(Debug, PartialEq)]
pub enum StartOutcome {
    /// No capture was running: open one in this session's bundle.
    OpenCapture,
    /// A capture is running; this session shares it.
    JoinCapture,
    /// This session is already running (a retried request).
    AlreadyActive,
}

impl Sessions {
    pub fn len(&self) -> usize {
        self.active.len()
    }

    pub fn get(&self, id: &str) -> Option<&SessionEntry> {
        self.active.get(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.active.keys().cloned().collect()
    }

    pub fn classify_start(&self, id: &str) -> StartOutcome {
        if self.active.contains_key(id) {
            StartOutcome::AlreadyActive
        } else if self.active.is_empty() {
            StartOutcome::OpenCapture
        } else {
            StartOutcome::JoinCapture
        }
    }

    pub fn insert(&mut self, entry: SessionEntry) {
        self.active.insert(entry.session_id.clone(), entry);
    }

    /// Removes a session; the bool says whether it was the last one, i.e.
    /// whether the capture should now stop.
    pub fn remove(&mut self, id: &str) -> Option<(SessionEntry, bool)> {
        let entry = self.active.remove(id)?;
        Some((entry, self.active.is_empty()))
    }

    /// Sessions that must end on their own: their player left, or they ran
    /// past the cap (a client that crashed never sends its stop).
    pub fn expired(
        &self,
        connected: impl Fn(u32) -> bool,
        now_mono_us: u64,
        max_us: u64,
    ) -> Vec<(String, StopReason)> {
        self.active
            .values()
            .filter_map(|entry| {
                if entry.player_id.is_some_and(|player| !connected(player)) {
                    Some((entry.session_id.clone(), StopReason::PlayerDisconnected))
                } else if now_mono_us.saturating_sub(entry.start.mono_us) > max_us {
                    Some((entry.session_id.clone(), StopReason::MaxDuration))
                } else {
                    None
                }
            })
            .collect()
    }
}

/// The encoder (city stream) half of a capture.
pub enum CityCapture {
    /// Not a city match.
    NotCity,
    /// Being opened on a helper thread (the manifest write is slow).
    Opening(Receiver<std::io::Result<vibe_land_destruction::netlab::capture::NetlabCapture>>),
    /// Recording, installed in the city runtime by this capture.
    Owned,
    /// The process-wide `VIBE_CITY_TAPE_OUT` capture was already recording;
    /// it is left alone.
    External(PathBuf),
    Failed(String),
}

impl CityCapture {
    pub fn describe(&self) -> serde_json::Value {
        match self {
            CityCapture::NotCity => serde_json::json!({"state": "not-city"}),
            CityCapture::Opening(_) => serde_json::json!({"state": "opening"}),
            CityCapture::Owned => serde_json::json!({"state": "recording"}),
            CityCapture::External(dir) => {
                serde_json::json!({"state": "external", "dir": dir.to_string_lossy()})
            }
            CityCapture::Failed(error) => serde_json::json!({"state": "failed", "error": error}),
        }
    }
}

/// The one running capture of a match, and the sessions sharing it.
pub struct ActiveCapture {
    pub epoch: Instant,
    pub epoch_unix_us: u64,
    /// Where the capture's files live (`<first bundle>/server`).
    pub server_dir: PathBuf,
    pub opened_by: String,
    pub started: ServerMark,
    pub sessions: Sessions,
    pub ticks: TickWriter,
    pub send_log: crate::send_log::SendLogWriter,
    pub city: CityCapture,
    /// This tick's selection records, flushed with the tick's bundle.
    pub selections: Vec<Selection>,
}

impl ActiveCapture {
    pub fn mark(&self, tick: u32) -> ServerMark {
        ServerMark { tick, unix_us: unix_us(), mono_us: micros_since(self.epoch) }
    }

    /// Drain every writer and record what was written. Slow (joins writer
    /// threads); run it off the tick thread, after the send-log sink has been
    /// detached from the match's hub.
    pub fn finish(
        self,
        city: Option<vibe_land_destruction::netlab::capture::NetlabCapture>,
        stop: ServerMark,
    ) -> serde_json::Value {
        let snapshot_inputs_dropped = self.ticks.dropped_inputs;
        let ticks = self.ticks.finish();
        let sends = self.send_log.finish();
        let city_meta = city.map(|capture| capture.finish());
        let summary = serde_json::json!({
            "opened_by": self.opened_by,
            "epoch_unix_us": self.epoch_unix_us,
            "start": self.started,
            "stop": stop,
            "tick_writer": match &ticks {
                Ok(summary) => serde_json::to_value(summary).unwrap_or_default(),
                Err(error) => serde_json::json!({"error": error.to_string()}),
            },
            "snapshot_inputs_dropped": snapshot_inputs_dropped,
            "send_log": match &sends {
                Ok(summary) => serde_json::to_value(summary).unwrap_or_default(),
                Err(error) => serde_json::json!({"error": error.to_string()}),
            },
            "city": match city_meta {
                Some(Ok(meta)) => serde_json::json!({
                    "dir": CITY_DIR,
                    "first_tick": meta.first_tick,
                    "last_tick": meta.last_tick,
                    "ticks": meta.ticks,
                    "dropped_ticks": meta.dropped_ticks,
                }),
                Some(Err(error)) => serde_json::json!({"error": error.to_string()}),
                None => self.city.describe(),
            },
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&summary) {
            let _ = std::fs::write(self.server_dir.join(CAPTURE_META_FILE), bytes);
        }
        summary
    }
}

/// `session.json`. Written in three steps -- start, stop, client upload --
/// by merging objects, so each writer owns its own keys.
pub fn merge_manifest(dir: &Path, patch: serde_json::Value) -> std::io::Result<serde_json::Value> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(dir)?;
    let path = dir.join(MANIFEST_FILE);
    let mut current = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({})),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(error),
    };
    merge_json(&mut current, patch);
    if let serde_json::Value::Object(map) = &mut current {
        map.insert("format".into(), MANIFEST_FORMAT.into());
    }
    let tmp = dir.join(format!("{MANIFEST_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(&current)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(current)
}

/// Deep-merges objects; anything else in `patch` replaces.
pub fn merge_json(into: &mut serde_json::Value, patch: serde_json::Value) {
    match (into, patch) {
        (serde_json::Value::Object(into), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                match into.get_mut(&key) {
                    Some(existing) => merge_json(existing, value),
                    None => {
                        into.insert(key, value);
                    }
                }
            }
        }
        (into, patch) => *into = patch,
    }
}

/// A path from one bundle to a file in another, for a session that shares a
/// capture opened by an earlier one.
pub fn relative_to_bundle(bundle: &Path, target: &Path) -> String {
    match (bundle.parent(), target.strip_prefix(bundle)) {
        (_, Ok(inside)) => inside.to_string_lossy().into_owned(),
        (Some(root), Err(_)) => match target.strip_prefix(root) {
            Ok(sibling) => format!("../{}", sibling.to_string_lossy()),
            Err(_) => target.to_string_lossy().into_owned(),
        },
        (None, Err(_)) => target.to_string_lossy().into_owned(),
    }
}

/// Client tapes: VLCTAPE2 (full inbound stream), VLTAPE01 (city stream
/// only), and the first full-stream tapes, which were written as VLTAPE02 --
/// the netlab encoder tape's magic -- and are told apart from an encoder
/// tape by their JSON header.
pub fn is_client_tape(body: &[u8]) -> bool {
    if body.len() < 13 {
        return false;
    }
    match &body[..8] {
        b"VLTAPE01" | b"VLCTAPE2" => true,
        b"VLTAPE02" => {
            let length = u32::from_le_bytes(body[8..12].try_into().unwrap()) as usize;
            body[12] == b'{'
                && 12 + length <= body.len()
                && serde_json::from_slice::<serde_json::Value>(&body[12..12 + length])
                    .is_ok_and(|value| value.is_object())
        }
        _ => false,
    }
}

/// The client tape's JSON header, for the manifest.
pub fn client_tape_header(body: &[u8]) -> Option<serde_json::Value> {
    if !is_client_tape(body) {
        return None;
    }
    let length = u32::from_le_bytes(body[8..12].try_into().ok()?) as usize;
    serde_json::from_slice(body.get(12..12 + length)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vl-session-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn truth(tick: u32) -> TickTruth {
        TickTruth {
            tick,
            mono_us: tick as u64 * 16_667,
            unix_us: 1_700_000_000_000_000 + tick as u64,
            players: vec![PlayerTruth {
                id: 1,
                handle: 1,
                hp: 100,
                flags: 3,
                position: [1.0, 2.0, 3.0],
                velocity: [0.5, 0.0, 0.0],
                yaw: 0.25,
                pitch: -0.1,
            }],
            vehicles: vec![VehicleTruth {
                id: 9,
                handle: 2,
                vehicle_type: 0,
                flags: 1,
                driver: 1,
                position: [10.0, 0.5, -4.0],
                rotation: [0.0, 0.7071, 0.0, 0.7071],
                velocity: [3.0, 0.0, 0.0],
                angular_velocity: [0.0, 0.1, 0.0],
            }],
            bodies: (0..3)
                .map(|i| BodyTruth {
                    id: 100 + i,
                    handle: 5 + i as u16,
                    shape: (i % 2) as u8,
                    position: [i as f32, 1.0, 0.0],
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    half_extents: [0.25; 3],
                    velocity: [0.0, -9.8, 0.0],
                    angular_velocity: [0.0; 3],
                })
                .collect(),
        }
    }

    #[test]
    fn session_ids_cannot_name_a_path() {
        assert!(valid_session_id("20260924-101112-ab12cd"));
        assert!(valid_session_id("e2e_1"));
        for bad in ["", "..", "a/b", "a\\b", "a.b", "a b", &"x".repeat(65)] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn world_ticks_round_trip_and_sizes_match_the_header() {
        let tick = truth(42);
        let mut bytes = Vec::new();
        tick.encode_into(&mut bytes);
        assert_eq!(bytes.len(), 28 + PLAYER_BYTES + VEHICLE_BYTES + 3 * BODY_BYTES);
        let (back, used) = TickTruth::decode(&bytes).unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(back, tick);
        // A torn tail is not a tick.
        assert!(TickTruth::decode(&bytes[..bytes.len() - 1]).is_none());
    }

    #[test]
    fn the_tick_writer_writes_world_timings_and_selections() {
        let dir = temp("writer");
        let mut writer = TickWriter::open(&dir, 1_700_000_000_000_000, 60).unwrap();
        for tick in 10..13 {
            writer.push(TickBundle {
                truth: truth(tick),
                timing: TickTiming { tick, total_ms: 2.5, ..Default::default() },
                selections: vec![
                    Selection {
                        tick,
                        player: 1,
                        kind: SelectionKind::Snapshot(SnapshotSelection {
                            bodies_aoi: 3,
                            bodies_sent: 2,
                            bodies_budget: 1,
                            ..Default::default()
                        }),
                    },
                    Selection {
                        tick,
                        player: 1,
                        kind: SelectionKind::City(Default::default()),
                    },
                ],
            });
        }
        let summary = writer.finish().unwrap();
        assert_eq!(
            summary,
            TickWriterSummary { ticks: 3, dropped_ticks: 0, first_tick: Some(10), last_tick: Some(12) }
        );
        let (header, ticks) = read_world(&dir.join(WORLD_FILE)).unwrap();
        assert_eq!(header["epoch_unix_us"], 1_700_000_000_000_000u64);
        assert_eq!(ticks.iter().map(|t| t.tick).collect::<Vec<_>>(), vec![10, 11, 12]);
        assert_eq!(ticks[1], truth(11));
        let timings: Vec<TickTiming> = std::fs::read_to_string(dir.join(TICKS_FILE))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(timings.len(), 3);
        assert_eq!(timings[2].tick, 12);
        let selections: Vec<serde_json::Value> = std::fs::read_to_string(dir.join(SELECTIONS_FILE))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(selections.len(), 6);
        assert_eq!(selections[0]["stream"], "snapshot");
        assert_eq!(selections[0]["bodies_budget"], 1);
        assert_eq!(selections[1]["stream"], "city");
        assert_eq!(selections[1]["tick"], 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `ticks.jsonl` line as servers wrote it before the phase fields.
    const OLD_TICK_LINE: &str = r#"{"tick":18450,"mono_us":1000,"unix_us":2000,"total_ms":146.2,"player_sim_ms":0.1,"vehicle_ms":0.0,"dynamics_ms":143.9,"hitscan_ms":0.0,"city_ms":1.2,"snapshot_ms":0.05,"publish_ms":0.0,"unattributed_ms":0.9,"players":1,"awake_city_bodies":275,"capture_ms":0.3}"#;

    fn phased_timing() -> TickTiming {
        TickTiming {
            tick: 7,
            total_ms: 120.0,
            dynamics_ms: 118.0,
            timing_version: TICK_TIMING_VERSION,
            snapshot_sent: Some(false),
            shots_ms: 0.4,
            meteors_launched: 1,
            meteor_launch_ms: 0.35,
            physx: Some(PhysxPhases {
                controller_ms: 0.1,
                submit_ms: 0.6,
                overlap_ms: 0.8,
                fetch_ms: 116.5,
                callbacks_ms: 0.2,
                gpu_wait_ms: None,
                readback_ms: 0.5,
                players_ms: 0.05,
                awake_bodies: 900,
                found_pairs: 120,
                lost_pairs: 80,
            }),
            stage: Some(StagePhases {
                frame: 99,
                iterations: 16,
                passes: 2,
                corrections: 1,
                bonds_broken: 410,
                bodies_promoted: 84,
                chunks_migrated: 300,
                contacts: 5000,
                observe_ms: 0.9,
                zones: Some(StageZones { correction_ms: 60.0, stress_gpu_ms: 1.4, ..Default::default() }),
                ..Default::default()
            }),
            engine_zones: Some(BTreeMap::from([("GpuDestruction.correctedCollisionSolve".to_string(), 60.0)])),
            phases_us: 4.0,
            ..Default::default()
        }
    }

    #[test]
    fn old_tick_lines_still_parse_with_the_new_fields_defaulted() {
        let old: TickTiming = serde_json::from_str(OLD_TICK_LINE).unwrap();
        assert_eq!(old.tick, 18450);
        assert_eq!(old.dynamics_ms, 143.9);
        assert_eq!(old.timing_version, 0, "no version: the pre-phase format");
        assert_eq!(old.snapshot_sent, None);
        assert_eq!(old.shots_ms, 0.0);
        assert!(old.physx.is_none() && old.stage.is_none() && old.engine_zones.is_none());
    }

    #[test]
    fn phase_fields_round_trip_and_keep_every_old_key() {
        let timing = phased_timing();
        let line = serde_json::to_string(&timing).unwrap();
        let back: TickTiming = serde_json::from_str(&line).unwrap();
        assert_eq!(back, timing);
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        let old: serde_json::Value = serde_json::from_str(OLD_TICK_LINE).unwrap();
        for key in old.as_object().unwrap().keys() {
            assert!(value.get(key).is_some(), "{key} was renamed or dropped");
        }
        assert_eq!(value["timing_version"], TICK_TIMING_VERSION);
        assert_eq!(value["physx"]["fetch_ms"], 116.5);
        assert_eq!(value["stage"]["bodies_promoted"], 84);
        assert_eq!(value["stage"]["zones"]["correction_ms"], 60.0);
        // Unsampled GPU wait is left out, not written as a zero.
        assert!(value["physx"].get("gpu_wait_ms").is_none());
    }

    #[test]
    fn a_tick_without_physx_or_stage_writes_no_empty_groups() {
        let timing = TickTiming { timing_version: TICK_TIMING_VERSION, ..Default::default() };
        let value = serde_json::to_value(&timing).unwrap();
        for key in ["physx", "stage", "engine_zones", "snapshot_sent"] {
            assert!(value.get(key).is_none(), "{key}");
        }
    }

    #[test]
    fn stage_zones_group_the_engine_spans() {
        let spans = [
            ("GpuDestruction.contactStress", 70.0, 1u8),
            ("GpuDestruction.submit", 2.0, 1),
            ("GpuDestruction.finishAndReserve", 5.0, 1),
            ("GpuDestruction.finishDetail.waitForGpu", 4.5, 1),
            ("GpuDestruction.cuda.contactLoads", 0.25, 1),
            ("GpuDestruction.cuda.stress", 1.0, 1),
            ("GpuDestruction.cuda.materials", 0.25, 1),
            ("GpuDestruction.cuda.topologyAndCandidates", 0.5, 1),
            ("GpuDestruction.cuda.commitAndStressTopology", 0.5, 1),
            ("GpuDestruction.trialDetail.postBroadPhase", 3.0, 1),
            ("GpuDestruction.trialDetail.broadPhaseWait", 2.5, 1),
            ("GpuDestruction.trialDetail.postNarrowPhase", 1.5, 1),
            ("GpuDestruction.trialDetail.updateDynamics", 0.25, 1),
            ("GpuDestruction.correctedCollisionSolve", 55.0, 1),
            ("GpuDestruction.correctedCollisionSolve.calls", 1.0, 2),
            ("GpuDestruction.detail.postBroadPhase", 9.0, 1),
            ("GpuDestruction.restoreInstall", 3.0, 1),
            ("GpuDestruction.applyBindings", 1.0, 1),
            ("GpuDestruction.cuda.rewindState", 0.5, 1),
            ("GpuDestruction.cuda.finalSplitOwners", 0.5, 1),
            ("GpuDestruction.task.prepareIslandRepair", 6.0, 1),
            ("GpuDestruction.cuda.allocationAndPreparationRetry", 0.75, 1),
            ("GpuDestruction.compatibility.allocateNativeBodies", 0.25, 1),
            ("GpuDestruction.task.sleepCommit", 0.125, 1),
            ("Sim.solveQueueTasks", 9.0, 1),
            ("native_tick_ms", 0.9, 0),
        ];
        let zones = StageZones::from_spans(spans.iter().copied()).unwrap();
        assert_eq!(zones.submit_ms, 2.0);
        assert_eq!(zones.finish_ms, 5.0);
        assert_eq!(zones.finish_gpu_wait_ms, 4.5);
        assert_eq!(zones.stress_gpu_ms, 1.5);
        assert_eq!(zones.fracture_gpu_ms, 1.0);
        assert_eq!(zones.trial_broadphase_ms, 3.0);
        assert_eq!(zones.trial_broadphase_wait_ms, 2.5);
        assert_eq!(zones.trial_narrowphase_ms, 1.5);
        assert_eq!(zones.trial_other_ms, 0.25);
        assert_eq!(zones.correction_ms, 55.0, "the .calls count is not a time");
        assert_eq!(zones.correction_prep_ms, 4.0);
        assert_eq!(zones.correction_gpu_ms, 1.0);
        assert_eq!(zones.island_repair_ms, 6.0);
        assert_eq!(zones.body_alloc_ms, 1.0);
        // Only sleepCommit: the parent contactStress and the nested
        // detail.postBroadPhase are not counted twice.
        assert_eq!(zones.other_ms, 0.125);
        // The profiler off: no zones at all, and not a row of zeros.
        assert!(StageZones::from_spans([("native_tick_ms", 0.9, 0u8)]).is_none());
        let engine = engine_zones(spans.iter().copied()).unwrap();
        assert_eq!(engine["Sim.solveQueueTasks"], 9.0);
        assert!(!engine.contains_key("native_tick_ms"), "not a zone");
        assert!(!engine.contains_key("GpuDestruction.correctedCollisionSolve.calls"));
        assert!(engine_zones([("GpuDestruction.submit", 0.01, 1u8)]).is_none(), "below the floor");
        let many: Vec<(String, f64, u8)> =
            (0..100).map(|i| (format!("zone{i}"), 1.0 + i as f64, 1u8)).collect();
        let kept = engine_zones(many.iter().map(|(n, v, k)| (n.as_str(), *v, *k))).unwrap();
        assert_eq!(kept.len(), ENGINE_ZONE_LIMIT);
        assert!(kept.contains_key("zone99") && !kept.contains_key("zone0"), "the largest are kept");
    }

    #[test]
    fn the_writer_puts_phase_fields_in_ticks_jsonl() {
        let dir = temp("phases");
        let mut writer = TickWriter::open(&dir, 0, 60).unwrap();
        writer.push(TickBundle { truth: truth(7), timing: phased_timing(), selections: Vec::new() });
        writer.finish().unwrap();
        let line = std::fs::read_to_string(dir.join(TICKS_FILE)).unwrap();
        let back: TickTiming = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(back, phased_timing());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stalled_tick_writer_drops_instead_of_blocking_the_tick() {
        let dir = temp("drop");
        let mut writer = TickWriter::open_with_capacity(&dir, 0, 60, 1).unwrap();
        let started = Instant::now();
        let big = TickTruth {
            bodies: vec![BodyTruth::default(); 20_000],
            ..TickTruth::default()
        };
        for tick in 0..200 {
            let mut t = big.clone();
            t.tick = tick;
            writer.push(TickBundle { truth: t, timing: TickTiming::default(), selections: Vec::new() });
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let summary = writer.finish().unwrap();
        assert_eq!(summary.ticks + summary.dropped_ticks, 200);
        let (_, ticks) = read_world(&dir.join(WORLD_FILE)).unwrap();
        assert_eq!(ticks.len() as u64, summary.ticks);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_share_one_capture_and_the_last_one_out_stops_it() {
        let mut sessions = Sessions::default();
        let entry = |id: &str, player: u32, mono_us: u64| SessionEntry {
            session_id: id.into(),
            player_id: Some(player),
            bundle: PathBuf::from(format!("debug-reports/session-{id}")),
            start: ServerMark { tick: 1, unix_us: 0, mono_us },
        };
        assert_eq!(sessions.classify_start("a"), StartOutcome::OpenCapture);
        sessions.insert(entry("a", 1, 0));
        assert_eq!(sessions.classify_start("a"), StartOutcome::AlreadyActive);
        assert_eq!(sessions.classify_start("b"), StartOutcome::JoinCapture);
        sessions.insert(entry("b", 2, 10));
        assert_eq!(sessions.len(), 2);
        let (removed, last) = sessions.remove("a").unwrap();
        assert_eq!(removed.player_id, Some(1));
        assert!(!last, "b still records");
        assert!(sessions.remove("a").is_none(), "a second stop is a no-op");
        let (_, last) = sessions.remove("b").unwrap();
        assert!(last);
        assert_eq!(sessions.classify_start("c"), StartOutcome::OpenCapture);
    }

    #[test]
    fn sessions_end_when_their_player_leaves_or_they_run_too_long() {
        let mut sessions = Sessions::default();
        for (id, player, start) in [("a", 1, 0), ("b", 2, 5_000_000), ("c", 3, 0)] {
            sessions.insert(SessionEntry {
                session_id: id.into(),
                player_id: Some(player),
                bundle: PathBuf::new(),
                start: ServerMark { tick: 0, unix_us: 0, mono_us: start },
            });
        }
        let expired = sessions.expired(|player| player != 3, 6_000_000, 5_500_000);
        assert_eq!(
            expired,
            vec![
                ("a".to_string(), StopReason::MaxDuration),
                ("c".to_string(), StopReason::PlayerDisconnected),
            ]
        );
    }

    #[test]
    fn the_manifest_merges_start_stop_and_client_parts() {
        let dir = temp("manifest");
        merge_manifest(&dir, serde_json::json!({"session_id": "a", "server": {"start": {"tick": 5}}}))
            .unwrap();
        merge_manifest(&dir, serde_json::json!({"server": {"stop": {"tick": 9}}})).unwrap();
        let merged = merge_manifest(&dir, serde_json::json!({"client": {"tape": CLIENT_TAPE_FILE}}))
            .unwrap();
        assert_eq!(merged["format"], MANIFEST_FORMAT);
        assert_eq!(merged["server"]["start"]["tick"], 5);
        assert_eq!(merged["server"]["stop"]["tick"], 9);
        assert_eq!(merged["client"]["tape"], CLIENT_TAPE_FILE);
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(on_disk, merged);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_joining_session_points_at_the_capture_in_the_first_bundle() {
        let root = Path::new("debug-reports");
        let first = bundle_dir(root, "a");
        let second = bundle_dir(root, "b");
        let server = first.join(SERVER_DIR);
        assert_eq!(relative_to_bundle(&first, &server), "server");
        assert_eq!(relative_to_bundle(&second, &server), "../session-a/server");
    }

    #[test]
    fn client_tapes_are_told_apart_from_encoder_tapes() {
        let tape = |magic: &[u8], header: &[u8]| {
            let mut out = magic.to_vec();
            out.extend_from_slice(&(header.len() as u32).to_le_bytes());
            out.extend_from_slice(header);
            out
        };
        let json = br#"{"version":2,"localPlayerId":7}"#;
        assert!(is_client_tape(&tape(b"VLCTAPE2", json)));
        assert!(is_client_tape(&tape(b"VLTAPE01", json)));
        // A legacy full-stream client tape: VLTAPE02 with a JSON header.
        assert!(is_client_tape(&tape(b"VLTAPE02", json)));
        assert_eq!(client_tape_header(&tape(b"VLTAPE02", json)).unwrap()["localPlayerId"], 7);
        // The netlab encoder tape: VLTAPE02, then u32 hz and a manifest hash.
        let mut encoder = b"VLTAPE02".to_vec();
        encoder.extend_from_slice(&60u32.to_le_bytes());
        encoder.extend_from_slice(&[b'{'; 32]);
        assert!(!is_client_tape(&encoder));
        assert!(!is_client_tape(b"NOTATAPE0000{}"));
        assert!(!is_client_tape(b"VLCTAPE2"));
    }
}
