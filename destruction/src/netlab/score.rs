//! Score what a client displayed against what the server simulated.
//!
//! Truth is the encoder tape: full-precision poses of every awake body every
//! tick, plus the topology events that say which chunks each body carries.
//! The client side is the VLPRES01 stream the shipping TS client wrote when
//! replaying that client's packets. Every metric is weighted by the number
//! of chunks a body carries, because a 500-chunk slab a metre off is a
//! different wrong from a shard a metre off, and every error is reported
//! both as centre-of-mass distance and as the lever-arm bound (what the
//! farthest chunk of the body moved), because a big body with a small
//! rotation error has its corners in the wrong place.
//!
//! The scorer compares delay-compensated: the client presents the sim tick
//! `render_tick - playout_delay`, so truth is interpolated there. The
//! uncompensated error (against truth at the render tick) is reported too,
//! as the latency the player actually sees.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;

use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use crate::ids;
use crate::manifest::{island_radius, DestructionManifest};
use crate::netlab::cameras::{CameraSpec, PlayerTracks, SceneExtent};
use crate::netlab::gates::{GateHits, GateState};
use crate::netlab::presented::PresentedReader;
use crate::netlab::tape::TapeReader;
use crate::quant::{projected_error_pixels, quaternion_angle_radians, rigid_shell_error_meters};
use crate::topology::CityLedger;
use crate::types::{Camera, Pose};

pub const PANE_WIDTH: u32 = 1920;
pub const PANE_HEIGHT: u32 = 1080;
/// The pixel error budget the encoder is tuned to.
pub const PIXEL_BUDGET: f32 = 2.0;
/// Perceptibility: a displacement is noticed when it exceeds the pixel
/// budget AND a fraction of the body's own on-screen size. Displacement
/// detection relative to object size sits around 10-20% in cluttered scenes
/// (Weber-like; individual shards in a rubble cluster are masked by their
/// neighbours), so a 3-px shard one pixel off is invisible and a 200-px slab
/// ten pixels off is not.
pub const PERCEPTIBLE_SIZE_FRACTION: f32 = 0.15;
/// Screen-space jerk (change in per-frame velocity) the truth does not
/// have, above this, reads as jitter or rubber-banding.
pub const JITTER_PX_PER_FRAME2: f32 = 1.5;
/// Free flight: acceleration within this of gravity for at least two ticks.
pub const FREE_FLIGHT_ACCEL_TOLERANCE: f32 = 3.0;
/// Truth speed under this is at rest, for the coverage check.
pub const REST_SPEED: f32 = 0.05;
/// Truth history kept per body, in ticks (covers the playout delay range
/// plus a margin).
const HISTORY_TICKS: usize = 128;
/// A body whose truth is this far outside the scene's extent has left the
/// world -- the native backend's known ejection fault, not a streaming
/// error -- and is counted apart rather than allowed to own the p99.
pub const ESCAPE_MARGIN_M: f32 = 150.0;

// --- weighted log histogram -------------------------------------------------

const HIST_BINS: usize = 640;
const HIST_MIN: f64 = 1e-5;
const HIST_MAX: f64 = 1e4;

/// A weighted histogram on a log scale: percentiles over tens of millions of
/// body-frames without holding them.
#[derive(Clone, Debug)]
pub struct WeightedHist {
    bins: Vec<f64>,
    weight: f64,
    sum: f64,
    max: f32,
    samples: u64,
}

impl Default for WeightedHist {
    fn default() -> Self {
        Self { bins: vec![0.0; HIST_BINS], weight: 0.0, sum: 0.0, max: 0.0, samples: 0 }
    }
}

impl WeightedHist {
    fn bin_of(value: f64) -> usize {
        if value <= HIST_MIN {
            return 0;
        }
        let t = (value.ln() - HIST_MIN.ln()) / (HIST_MAX.ln() - HIST_MIN.ln());
        ((t * HIST_BINS as f64) as usize).min(HIST_BINS - 1)
    }

    fn value_of(bin: usize) -> f64 {
        if bin == 0 {
            return 0.0;
        }
        let t = (bin as f64 + 0.5) / HIST_BINS as f64;
        (HIST_MIN.ln() + t * (HIST_MAX.ln() - HIST_MIN.ln())).exp()
    }

    pub fn add(&mut self, value: f32, weight: f32) {
        if !value.is_finite() || weight <= 0.0 {
            return;
        }
        let value = value.max(0.0);
        self.bins[Self::bin_of(f64::from(value))] += f64::from(weight);
        self.weight += f64::from(weight);
        self.sum += f64::from(value) * f64::from(weight);
        self.max = self.max.max(value);
        self.samples += 1;
    }

    pub fn percentile(&self, q: f64) -> f32 {
        if self.weight <= 0.0 {
            return 0.0;
        }
        let target = self.weight * q;
        let mut acc = 0.0;
        for (bin, w) in self.bins.iter().enumerate() {
            acc += w;
            if acc >= target {
                return Self::value_of(bin) as f32;
            }
        }
        self.max
    }

    /// Fraction of weight at or above `threshold`.
    pub fn fraction_over(&self, threshold: f32) -> f32 {
        if self.weight <= 0.0 {
            return 0.0;
        }
        let start = Self::bin_of(f64::from(threshold));
        let over: f64 = self.bins[start..].iter().sum();
        (over / self.weight) as f32
    }

    pub fn summary(&self) -> Pct {
        Pct {
            samples: self.samples,
            weight: self.weight as f32,
            mean: if self.weight > 0.0 { (self.sum / self.weight) as f32 } else { 0.0 },
            p50: self.percentile(0.5),
            p95: self.percentile(0.95),
            p99: self.percentile(0.99),
            max: self.max,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Pct {
    pub samples: u64,
    pub weight: f32,
    pub mean: f32,
    pub p50: f32,
    pub p95: f32,
    pub p99: f32,
    pub max: f32,
}

// --- phases and buckets ------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Phase {
    /// Free flight, first `FRESH_FALL_TICKS` ticks.
    JustFreed,
    Falling,
    Tumbling,
    /// In contact and fast.
    Landing,
    /// In contact, slow but not at rest.
    Settling,
    Resting,
    /// Truth declared it settled (no more snapshots).
    Settled,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Self::JustFreed => "just-freed",
            Self::Falling => "falling",
            Self::Tumbling => "tumbling",
            Self::Landing => "landing",
            Self::Settling => "settling",
            Self::Resting => "resting",
            Self::Settled => "settled",
        }
    }
}

pub fn size_bucket(chunks: u32) -> &'static str {
    match chunks {
        0..=1 => "1",
        2..=10 => "2-10",
        11..=100 => "11-100",
        _ => "100+",
    }
}

pub fn radius_bucket(radius: f32) -> &'static str {
    if radius < 1.0 {
        "<1m"
    } else if radius < 3.0 {
        "1-3m"
    } else if radius < 8.0 {
        "3-8m"
    } else {
        "8m+"
    }
}

// --- accumulators ----------------------------------------------------------------

#[derive(Clone, Debug, Default)]
struct Cell {
    body_frames: u64,
    weight: f64,
    pos_m: WeightedHist,
    rot_deg: WeightedHist,
    lever_m: WeightedHist,
    pixel: WeightedHist,
    lever_uncompensated_m: WeightedHist,
    freeze: f64,
    excess: f64,
    reversal: f64,
    teleport: f64,
    gravity: f64,
    /// Visible bodies, weighted by on-screen area (px^2): what the viewer
    /// actually looks at.
    visible_area: f64,
    visible_frames: u64,
    perceptible_area: f64,
    perceptible_frames: u64,
    jitter_area: f64,
    artifact_area: f64,
    pixel_by_area: WeightedHist,
}

impl Cell {
    fn observe(&mut self, m: &Measure, weight: f32) {
        self.body_frames += 1;
        self.weight += f64::from(weight);
        self.pos_m.add(m.pos_m, weight);
        self.rot_deg.add(m.rot_deg, weight);
        self.lever_m.add(m.lever_m, weight);
        if let Some(pixel) = m.pixel {
            self.pixel.add(pixel, weight);
        }
        self.lever_uncompensated_m.add(m.lever_uncompensated_m, weight);
        let w = f64::from(weight);
        if m.gates.freeze {
            self.freeze += w;
        }
        if m.gates.excess {
            self.excess += w;
        }
        if m.gates.reversal {
            self.reversal += w;
        }
        if m.gates.teleport {
            self.teleport += w;
        }
        if m.gates.gravity {
            self.gravity += w;
        }
        if let (Some(area), Some(pixel)) = (m.area_px, m.pixel) {
            let area = f64::from(area.max(1.0));
            self.visible_area += area;
            self.visible_frames += 1;
            self.pixel_by_area.add(pixel, area as f32);
            if m.perceptible {
                self.perceptible_area += area;
                self.perceptible_frames += 1;
            }
            if m.jitter {
                self.jitter_area += area;
            }
            if m.jitter || m.gates.freeze || m.gates.reversal || m.gates.teleport || m.gates.excess {
                self.artifact_area += area;
            }
        }
    }

    fn report(&self) -> CellReport {
        CellReport {
            body_frames: self.body_frames,
            weight: self.weight as f32,
            pos_m: self.pos_m.summary(),
            rot_deg: self.rot_deg.summary(),
            lever_m: self.lever_m.summary(),
            pixel: self.pixel.summary(),
            pixel_over_budget: self.pixel.fraction_over(PIXEL_BUDGET),
            lever_uncompensated_m: self.lever_uncompensated_m.summary(),
            gates: GateReport {
                freeze: self.freeze as f32,
                excess: self.excess as f32,
                reversal: self.reversal as f32,
                teleport: self.teleport as f32,
                gravity: self.gravity as f32,
            },
            visual: VisualReport {
                visible_frames: self.visible_frames,
                visible_area: self.visible_area as f32,
                pixel_by_area: self.pixel_by_area.summary(),
                perceptible_fraction: if self.visible_area > 0.0 {
                    (self.perceptible_area / self.visible_area) as f32
                } else {
                    0.0
                },
                perceptible_frames: self.perceptible_frames,
                jitter_fraction: if self.visible_area > 0.0 {
                    (self.jitter_area / self.visible_area) as f32
                } else {
                    0.0
                },
                artifact_fraction: if self.visible_area > 0.0 {
                    (self.artifact_area / self.visible_area) as f32
                } else {
                    0.0
                },
            },
        }
    }
}

/// What a viewer sees: visible bodies weighted by the screen area they
/// occupy. `perceptible_fraction` is the share of looked-at area that is
/// noticeably wrong; `artifact_fraction` the share showing a temporal
/// artefact (freeze, reversal, teleport, excess or jitter). These two are
/// the headline numbers.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct VisualReport {
    pub visible_frames: u64,
    pub visible_area: f32,
    pub pixel_by_area: Pct,
    pub perceptible_fraction: f32,
    pub perceptible_frames: u64,
    pub jitter_fraction: f32,
    pub artifact_fraction: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GateReport {
    /// Chunk-weighted body-frames failing each gate.
    pub freeze: f32,
    pub excess: f32,
    pub reversal: f32,
    pub teleport: f32,
    pub gravity: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CellReport {
    pub body_frames: u64,
    pub weight: f32,
    pub pos_m: Pct,
    pub rot_deg: Pct,
    pub lever_m: Pct,
    /// Camera-projected, visible bodies only.
    pub pixel: Pct,
    pub pixel_over_budget: f32,
    pub lever_uncompensated_m: Pct,
    pub gates: GateReport,
    pub visual: VisualReport,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scorecard {
    pub source: String,
    pub presented: String,
    pub client_camera: String,
    pub profile: String,
    pub hz: u32,
    pub frame_hz: u32,
    pub window: (u32, u32),
    pub frames: u64,
    pub seconds: f32,
    pub gravity: f32,
    /// Mean vertical acceleration of truth bodies in free flight -- the
    /// gravity the tape actually fell at.
    pub measured_free_fall_accel: f32,
    pub awake_peak: u32,
    pub awake_mean: f32,
    pub bodies_scored: u64,
    pub overall: CellReport,
    pub by_phase: BTreeMap<String, CellReport>,
    pub by_size: BTreeMap<String, CellReport>,
    pub by_radius: BTreeMap<String, CellReport>,
    /// Truth bodies awake and moving that the client had no pose for at all
    /// (chunk-weighted body-frames) -- coverage, not accuracy.
    pub missing_moving_weight: f32,
    pub missing_moving_body_frames: u64,
    /// Final presented pose vs truth settle pose for bodies truth settled.
    pub settle_pos_m: Pct,
    pub settle_lever_m: Pct,
    pub settled_bodies: u64,
    /// Playout delay the client ran at (ticks).
    pub playout_delay_ticks: Pct,
    pub worst: Vec<WorstBody>,
    /// Bodies whose truth left the scene extent (+margin): a physics fault,
    /// excluded from every error figure above.
    pub escaped_bodies: u64,
    pub escaped_body_frames: u64,
    /// Client-side resync requests the offline replay could not answer.
    pub scene_extent: ([f32; 3], [f32; 3]),
}

// --- truth model ------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct TruthSample {
    tick: u32,
    pose: Pose,
    velocity: Vec3,
    free: bool,
}

struct TruthBody {
    history: VecDeque<TruthSample>,
    settled: Option<Pose>,
    prev_velocity: Option<(u32, Vec3)>,
    free_run: u32,
    chunks: u32,
    radius: f32,
}

impl TruthBody {
    fn latest(&self) -> Option<&TruthSample> {
        self.history.back()
    }

    /// Truth pose at a (fractional) tick, interpolated; None before the
    /// first sample.
    fn pose_at(&self, tick: f32) -> Option<(Pose, Vec3, bool)> {
        if let Some(settled) = self.settled {
            if self.history.back().map_or(true, |last| tick >= last.tick as f32) {
                return Some((settled, Vec3::ZERO, false));
            }
        }
        let first = self.history.front()?;
        if tick <= first.tick as f32 {
            return Some((first.pose, first.velocity, first.free));
        }
        let last = self.history.back()?;
        if tick >= last.tick as f32 {
            return Some((last.pose, last.velocity, last.free));
        }
        let index = self.history.partition_point(|sample| (sample.tick as f32) <= tick);
        let a = self.history[index - 1];
        let b = self.history[index];
        let span = (b.tick - a.tick).max(1) as f32;
        let t = ((tick - a.tick as f32) / span).clamp(0.0, 1.0);
        Some((
            Pose {
                position: a.pose.position.lerp(b.pose.position, t),
                rotation: a.pose.rotation.slerp(b.pose.rotation, t),
            },
            a.velocity.lerp(b.velocity, t),
            a.free && b.free,
        ))
    }
}

struct PresentedBody {
    pose: Pose,
    prev_pose: Option<Pose>,
    prev_truth: Option<Pose>,
    prev_client_step: Option<Vec3>,
    prev_truth_step: Option<Vec3>,
    gates: GateState,
}

struct Measure {
    pos_m: f32,
    rot_deg: f32,
    lever_m: f32,
    pixel: Option<f32>,
    lever_uncompensated_m: f32,
    gates: GateHits,
    /// On-screen area in px^2 when visible.
    area_px: Option<f32>,
    perceptible: bool,
    jitter: bool,
}

pub struct ScoreOptions {
    pub camera: CameraSpec,
    pub profile: String,
    pub window: Option<(u32, u32)>,
    pub gravity: f32,
    /// Report the N bodies with the largest lever error, with when and how.
    pub dump_worst: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorstBody {
    pub key: u32,
    pub chunks: u32,
    pub radius: f32,
    pub worst_lever_m: f32,
    pub at_tick: u32,
    pub phase: String,
    pub truth_pos: [f32; 3],
    pub presented_pos: [f32; 3],
    pub frames: u32,
    pub mean_lever_m: f32,
}

pub fn score(
    tape_path: &Path,
    manifest: &DestructionManifest,
    tracks: &PlayerTracks,
    presented_path: &Path,
    options: &ScoreOptions,
) -> std::io::Result<Scorecard> {
    let mut tape = TapeReader::open(tape_path)?;
    if tape.manifest_hash != manifest.hash() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "tape was recorded against a different manifest",
        ));
    }
    let mut presented = PresentedReader::open(presented_path)?;
    let hz = tape.hz;
    let dt = 1.0 / hz as f32;
    let frame_dt = 1.0 / presented.frame_hz.max(1) as f32;
    let gravity = Vec3::new(0.0, -options.gravity, 0.0);

    let structure_chunks: HashMap<u32, Vec<(Vec3, f32)>> = manifest
        .structures
        .iter()
        .map(|structure| {
            (
                structure.structure_id,
                structure
                    .chunks
                    .iter()
                    .map(|chunk| (Vec3::from_array(chunk.centroid), chunk.radius))
                    .collect(),
            )
        })
        .collect();
    let mut ledger = CityLedger::from_manifest(manifest);
    let mut truth: HashMap<u32, TruthBody> = HashMap::new();
    let mut shown: HashMap<u32, PresentedBody> = HashMap::new();

    let mut overall = Cell::default();
    let mut by_phase: BTreeMap<Phase, Cell> = BTreeMap::new();
    let mut by_size: BTreeMap<&'static str, Cell> = BTreeMap::new();
    let mut by_radius: BTreeMap<&'static str, Cell> = BTreeMap::new();
    let mut missing_moving_weight = 0.0f64;
    let mut missing_moving_body_frames = 0u64;
    let mut playout = WeightedHist::default();
    let mut free_fall_accel_sum = 0.0f64;
    let mut free_fall_accel_n = 0u64;
    let mut awake_peak = 0u32;
    let mut awake_sum = 0u64;
    let mut awake_ticks = 0u64;
    let mut frames = 0u64;
    let mut window_first = u32::MAX;
    let mut window_last = 0u32;
    let mut bodies_scored: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut worst: HashMap<u32, WorstBody> = HashMap::new();
    let extent = SceneExtent::of(manifest);
    let escape_min = extent.min - ESCAPE_MARGIN_M;
    let escape_max = extent.max + ESCAPE_MARGIN_M;
    let mut escaped: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut escaped_body_frames = 0u64;

    let mut pending_tick = tape.next_tick()?;

    while let Some(frame) = presented.next_frame()? {
        // Advance truth through every tick up to the frame's sim tick.
        while let Some(tick) = pending_tick.as_ref() {
            if tick.tick > frame.sim_tick {
                break;
            }
            let tick = pending_tick.take().expect("checked");
            awake_peak = awake_peak.max(tick.snapshots.len() as u32);
            awake_sum += tick.snapshots.len() as u64;
            awake_ticks += 1;
            for batch in &tick.output.batches {
                ledger.apply_batch(batch);
                for promotion in &batch.promoted_islands {
                    let key = ids::body_entity(promotion.structure_id, promotion.island_id);
                    let nodes: Vec<u32> = promotion
                        .chunks
                        .iter()
                        .map(|&chunk| ids::chunk_id_parts(chunk).1)
                        .collect();
                    let radius = structure_chunks
                        .get(&promotion.structure_id)
                        .map_or(1.0, |chunks| island_radius(chunks, &nodes));
                    let body = truth.entry(key).or_insert_with(|| TruthBody {
                        history: VecDeque::new(),
                        settled: None,
                        prev_velocity: None,
                        free_run: 0,
                        chunks: 0,
                        radius,
                    });
                    body.chunks = nodes.len() as u32;
                    body.radius = radius;
                    body.settled = None;
                    body.history.push_back(TruthSample {
                        tick: tick.tick,
                        pose: Pose {
                            position: Vec3::from_array(promotion.position),
                            rotation: Quat::from_array(promotion.rotation),
                        },
                        velocity: Vec3::from_array(promotion.linear_velocity),
                        free: false,
                    });
                }
                for &retired in &batch.retired_island_ids {
                    truth.remove(&ids::body_entity(batch.structure_id, retired));
                }
                // Membership changed by migration: refresh chunk counts.
                if !batch.migrations.is_empty() {
                    for migration in &batch.migrations {
                        for island in [migration.from_island_id, migration.to_island_id] {
                            let key = ids::body_entity(batch.structure_id, island);
                            if let (Some(body), Some(ledger_island)) =
                                (truth.get_mut(&key), ledger.island(batch.structure_id, island))
                            {
                                body.chunks = ledger_island.nodes.len() as u32;
                                body.radius = structure_chunks
                                    .get(&batch.structure_id)
                                    .map_or(1.0, |chunks| island_radius(chunks, &ledger_island.nodes));
                            }
                        }
                    }
                }
            }
            for snapshot in &tick.snapshots {
                let key = snapshot.body_entity;
                let (structure_id, serial) = ids::body_entity_parts(key);
                let velocity = Vec3::from_array(snapshot.linear_velocity);
                let body = truth.entry(key).or_insert_with(|| {
                    let (chunks, radius) = ledger
                        .island(structure_id, serial)
                        .map(|island| {
                            (
                                island.nodes.len() as u32,
                                structure_chunks
                                    .get(&structure_id)
                                    .map_or(1.0, |chunks| island_radius(chunks, &island.nodes)),
                            )
                        })
                        .unwrap_or((1, 1.0));
                    TruthBody {
                        history: VecDeque::new(),
                        settled: None,
                        prev_velocity: None,
                        free_run: 0,
                        chunks,
                        radius,
                    }
                });
                body.settled = None;
                // Free flight from the truth itself: acceleration matches
                // gravity for two consecutive ticks. Contacts are not
                // reported by the native backend, so this is the only signal.
                let free = match body.prev_velocity {
                    Some((prev_tick, prev)) if tick.tick > prev_tick => {
                        let accel = (velocity - prev) / ((tick.tick - prev_tick) as f32 * dt);
                        let is_free = (accel - gravity).length() < FREE_FLIGHT_ACCEL_TOLERANCE;
                        if is_free {
                            body.free_run += 1;
                            free_fall_accel_sum += f64::from(accel.y);
                            free_fall_accel_n += 1;
                        } else {
                            body.free_run = 0;
                        }
                        body.free_run >= 2
                    }
                    _ => false,
                };
                body.prev_velocity = Some((tick.tick, velocity));
                body.history.push_back(TruthSample {
                    tick: tick.tick,
                    pose: Pose {
                        position: Vec3::from_array(snapshot.position),
                        rotation: Quat::from_array(snapshot.rotation),
                    },
                    velocity,
                    free,
                });
                while body.history.len() > HISTORY_TICKS {
                    body.history.pop_front();
                }
            }
            for settle in &tick.output.settled {
                ledger.apply_settle(settle);
                let key = ids::body_entity(settle.structure_id, settle.island_id);
                if let Some(body) = truth.get_mut(&key) {
                    body.settled = Some(Pose {
                        position: Vec3::from_array(settle.position),
                        rotation: Quat::from_array(settle.rotation),
                    });
                    body.prev_velocity = None;
                    body.free_run = 0;
                }
            }
            for &(structure_id, serial) in &tick.output.wakes {
                ledger.apply_wake(structure_id, serial);
                if let Some(body) = truth.get_mut(&ids::body_entity(structure_id, serial)) {
                    body.settled = None;
                }
            }
            pending_tick = tape.next_tick()?;
        }

        // Apply the client's frame.
        for (key, pose) in &frame.changed {
            let entry = shown.entry(*key).or_insert_with(|| PresentedBody {
                pose: *pose,
                prev_pose: None,
                prev_truth: None,
                prev_client_step: None,
                prev_truth_step: None,
                gates: GateState::default(),
            });
            entry.pose = *pose;
        }
        for key in &frame.retired {
            shown.remove(key);
        }

        let in_window = options
            .window
            .map_or(true, |(from, to)| frame.sim_tick >= from && frame.sim_tick <= to);
        if !in_window {
            // Keep gate state warm but score nothing.
            for body in shown.values_mut() {
                body.prev_pose = Some(body.pose);
            }
            continue;
        }
        frames += 1;
        window_first = window_first.min(frame.sim_tick);
        window_last = window_last.max(frame.sim_tick);
        playout.add(frame.playout_delay_ticks, 1.0);
        let sample_tick = frame.render_tick - frame.playout_delay_ticks;
        let camera: Option<Camera> = options.camera.camera_at(frame.sim_tick, hz, tracks);

        for (key, body) in shown.iter_mut() {
            let (_, serial) = ids::body_entity_parts(*key);
            if serial == 0 {
                continue; // the anchored remnant is not streamed
            }
            let Some(truth_body) = truth.get(key) else {
                body.prev_pose = Some(body.pose);
                continue;
            };
            let Some((truth_pose, truth_velocity, truth_free)) = truth_body.pose_at(sample_tick)
            else {
                body.prev_pose = Some(body.pose);
                continue;
            };
            if truth_pose.position.cmplt(escape_min).any() || truth_pose.position.cmpgt(escape_max).any() {
                escaped.insert(*key);
                escaped_body_frames += 1;
                body.prev_pose = Some(body.pose);
                body.prev_truth = Some(truth_pose);
                continue;
            }
            let truth_now = truth_body
                .pose_at(frame.render_tick)
                .map_or(truth_pose, |(pose, _, _)| pose);
            let weight = truth_body.chunks.max(1) as f32;
            let radius = truth_body.radius;
            let pos_m = truth_pose.position.distance(body.pose.position);
            let rot_deg = quaternion_angle_radians(truth_pose.rotation, body.pose.rotation).to_degrees();
            let lever_m = rigid_shell_error_meters(truth_pose, body.pose, radius);
            let lever_uncompensated_m = rigid_shell_error_meters(truth_now, body.pose, radius);
            let pixel = camera.map(|camera| {
                projected_error_pixels(truth_pose, body.pose, radius, camera, PANE_WIDTH, PANE_HEIGHT)
            });
            // Visible only: the projection returns 0 for off-screen bodies
            // and a pixel error of exactly zero for an on-screen body with
            // no error is the same number, so track visibility by truth
            // position instead.
            let (pixel, projected_radius_px) = match (camera, pixel) {
                (Some(camera), Some(value)) if is_visible(camera, truth_pose.position, radius) => {
                    (Some(value), Some(projected_radius_px(camera, truth_pose.position, radius)))
                }
                _ => (None, None),
            };
            let area_px = projected_radius_px.map(|r| std::f32::consts::PI * r * r);
            let perceptible = match (pixel, projected_radius_px) {
                (Some(px), Some(r)) => px > PIXEL_BUDGET.max(PERCEPTIBLE_SIZE_FRACTION * r),
                _ => false,
            };
            let client_step = match body.prev_pose {
                Some(prev) => body.pose.position - prev.position,
                None => Vec3::ZERO,
            };
            let truth_step = match body.prev_truth {
                Some(prev) => truth_pose.position - prev.position,
                None => Vec3::ZERO,
            };
            let gates = if body.prev_pose.is_some() && body.prev_truth.is_some() {
                body.gates.observe(
                    client_step,
                    truth_step,
                    body.pose.position.y,
                    truth_pose.position.y,
                    truth_free,
                    frame_dt,
                )
            } else {
                GateHits::default()
            };
            // Jitter: screen-space jerk the truth does not have.
            let jitter = match (camera, body.prev_client_step, body.prev_truth_step, pixel) {
                (Some(camera), Some(prev_client), Some(prev_truth), Some(_)) => {
                    let jerk = (client_step - prev_client) - (truth_step - prev_truth);
                    let depth = (truth_pose.position - camera.eye).dot(camera.direction.normalize_or_zero()).max(0.5);
                    let focal = PANE_HEIGHT as f32 * 0.5 / (camera.fov_degrees.to_radians() * 0.5).tan();
                    jerk.length() * focal / depth > JITTER_PX_PER_FRAME2
                }
                _ => false,
            };
            if body.prev_pose.is_some() && body.prev_truth.is_some() {
                body.prev_client_step = Some(client_step);
                body.prev_truth_step = Some(truth_step);
            }
            body.prev_pose = Some(body.pose);
            body.prev_truth = Some(truth_pose);

            let speed = truth_velocity.length();
            let angular = truth_body
                .latest()
                .map_or(0.0, |_| 0.0);
            let _ = angular;
            let phase = if truth_body.settled.is_some() {
                Phase::Settled
            } else if truth_free {
                if truth_body.free_run <= u32::from(crate::classify::FRESH_FALL_TICKS) {
                    Phase::JustFreed
                } else {
                    Phase::Falling
                }
            } else if speed > 0.5 {
                Phase::Landing
            } else if speed > REST_SPEED {
                Phase::Settling
            } else {
                Phase::Resting
            };
            if options.dump_worst > 0 {
                let entry = worst.entry(*key).or_insert_with(|| WorstBody {
                    key: *key,
                    chunks: truth_body.chunks,
                    radius,
                    worst_lever_m: 0.0,
                    at_tick: frame.sim_tick,
                    phase: phase.name().to_string(),
                    truth_pos: truth_pose.position.to_array(),
                    presented_pos: body.pose.position.to_array(),
                    frames: 0,
                    mean_lever_m: 0.0,
                });
                entry.frames += 1;
                entry.mean_lever_m += (lever_m - entry.mean_lever_m) / entry.frames as f32;
                if lever_m > entry.worst_lever_m {
                    entry.worst_lever_m = lever_m;
                    entry.at_tick = frame.sim_tick;
                    entry.phase = phase.name().to_string();
                    entry.truth_pos = truth_pose.position.to_array();
                    entry.presented_pos = body.pose.position.to_array();
                    entry.chunks = truth_body.chunks;
                }
            }
            let measure = Measure {
                pos_m,
                rot_deg,
                lever_m,
                pixel,
                lever_uncompensated_m,
                gates,
                area_px,
                perceptible,
                jitter,
            };
            overall.observe(&measure, weight);
            by_phase.entry(phase).or_default().observe(&measure, weight);
            by_size.entry(size_bucket(truth_body.chunks)).or_default().observe(&measure, weight);
            by_radius.entry(radius_bucket(radius)).or_default().observe(&measure, weight);
            bodies_scored.insert(*key);
        }

        // Coverage: truth bodies moving now that the client has never drawn.
        for (key, truth_body) in &truth {
            let (_, serial) = ids::body_entity_parts(*key);
            if serial == 0 || shown.contains_key(key) || truth_body.settled.is_some() {
                continue;
            }
            if let Some(latest) = truth_body.latest() {
                if latest.pose.position.cmplt(escape_min).any()
                    || latest.pose.position.cmpgt(escape_max).any()
                {
                    continue;
                }
                if latest.tick + 2 >= frame.sim_tick && latest.velocity.length() > REST_SPEED {
                    missing_moving_weight += f64::from(truth_body.chunks.max(1));
                    missing_moving_body_frames += 1;
                }
            }
        }
    }

    // Settle error: where the client left each body truth settled.
    let mut settle_pos = WeightedHist::default();
    let mut settle_lever = WeightedHist::default();
    let mut settled_bodies = 0u64;
    for (key, truth_body) in &truth {
        let Some(settled) = truth_body.settled else { continue };
        let Some(body) = shown.get(key) else { continue };
        if escaped.contains(key) {
            continue;
        }
        settled_bodies += 1;
        let weight = truth_body.chunks.max(1) as f32;
        settle_pos.add(settled.position.distance(body.pose.position), weight);
        settle_lever.add(rigid_shell_error_meters(settled, body.pose, truth_body.radius), weight);
    }

    let mut worst: Vec<WorstBody> = worst.into_values().collect();
    worst.sort_by(|a, b| b.worst_lever_m.total_cmp(&a.worst_lever_m));
    worst.truncate(options.dump_worst);

    Ok(Scorecard {
        source: tape_path.display().to_string(),
        presented: presented_path.display().to_string(),
        client_camera: options.camera.label(),
        profile: options.profile.clone(),
        hz,
        frame_hz: presented.frame_hz,
        window: if frames > 0 { (window_first, window_last) } else { (0, 0) },
        frames,
        seconds: frames as f32 / presented.frame_hz.max(1) as f32,
        gravity: options.gravity,
        measured_free_fall_accel: if free_fall_accel_n > 0 {
            (free_fall_accel_sum / free_fall_accel_n as f64) as f32
        } else {
            0.0
        },
        awake_peak,
        awake_mean: if awake_ticks > 0 { awake_sum as f32 / awake_ticks as f32 } else { 0.0 },
        bodies_scored: bodies_scored.len() as u64,
        overall: overall.report(),
        by_phase: by_phase.iter().map(|(k, v)| (k.name().to_string(), v.report())).collect(),
        by_size: by_size.iter().map(|(k, v)| (k.to_string(), v.report())).collect(),
        by_radius: by_radius.iter().map(|(k, v)| (k.to_string(), v.report())).collect(),
        missing_moving_weight: missing_moving_weight as f32,
        missing_moving_body_frames,
        settle_pos_m: settle_pos.summary(),
        settle_lever_m: settle_lever.summary(),
        settled_bodies,
        playout_delay_ticks: playout.summary(),
        worst,
        escaped_bodies: escaped.len() as u64,
        escaped_body_frames,
        scene_extent: (extent.min.to_array(), extent.max.to_array()),
    })
}

/// On-screen radius of a body, in pixels.
fn projected_radius_px(camera: Camera, position: Vec3, radius: f32) -> f32 {
    let depth = (position - camera.eye).dot(camera.direction.normalize_or_zero()).max(0.5);
    let focal = PANE_HEIGHT as f32 * 0.5 / (camera.fov_degrees.to_radians() * 0.5).tan();
    radius * focal / depth
}

fn is_visible(camera: Camera, position: Vec3, radius: f32) -> bool {
    let direction = camera.direction.normalize_or_zero();
    let relative = position - camera.eye;
    let depth = relative.dot(direction);
    if depth + radius <= 0.1 {
        return false;
    }
    let half_vertical = (camera.fov_degrees.to_radians() * 0.5).tan();
    let aspect = PANE_WIDTH as f32 / PANE_HEIGHT as f32;
    let reference_up = if direction.dot(Vec3::Y).abs() > 0.99 { Vec3::X } else { Vec3::Y };
    let right = direction.cross(reference_up).normalize();
    let up = right.cross(direction).normalize();
    let depth = depth.max(0.1);
    let angular_radius = radius / depth;
    (relative.dot(right) / depth).abs() <= half_vertical * aspect + angular_radius
        && (relative.dot(up) / depth).abs() <= half_vertical + angular_radius
}

/// Markdown summary of one scorecard.
pub fn markdown(card: &Scorecard) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "### {} · camera {} · link {} · window {}..{} ({:.1} s, {} frames)\n",
        card.presented, card.client_camera, card.profile, card.window.0, card.window.1, card.seconds, card.frames
    );
    let _ = writeln!(
        out,
        "awake peak {} mean {:.0} · bodies scored {} · playout {:.1} ticks · measured free-fall {:.2} m/s² (scored at {:.2})\n",
        card.awake_peak, card.awake_mean, card.bodies_scored, card.playout_delay_ticks.p50, card.measured_free_fall_accel, card.gravity
    );
    let _ = writeln!(out, "| cell | body-frames | weight | lever p50 | lever p95 | lever p99 | lever max | pos p95 | rot p95° | px p95 | px>2 | uncomp p95 | freeze | excess | reversal | teleport | gravity | vis frames | perceptible | jitter | artifact |");
    let _ = writeln!(out, "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    let row = |out: &mut String, name: &str, cell: &CellReport| {
        let _ = writeln!(
            out,
            "| {} | {} | {:.0} | {:.3} | {:.3} | {:.3} | {:.2} | {:.3} | {:.1} | {:.1} | {:.1}% | {:.3} | {:.0} | {:.0} | {:.0} | {:.0} | {:.0} | {} | {:.2}% | {:.2}% | {:.2}% |",
            name,
            cell.body_frames,
            cell.weight,
            cell.lever_m.p50,
            cell.lever_m.p95,
            cell.lever_m.p99,
            cell.lever_m.max,
            cell.pos_m.p95,
            cell.rot_deg.p95,
            cell.pixel.p95,
            cell.pixel_over_budget * 100.0,
            cell.lever_uncompensated_m.p95,
            cell.gates.freeze,
            cell.gates.excess,
            cell.gates.reversal,
            cell.gates.teleport,
            cell.gates.gravity,
            cell.visual.visible_frames,
            cell.visual.perceptible_fraction * 100.0,
            cell.visual.jitter_fraction * 100.0,
            cell.visual.artifact_fraction * 100.0
        );
    };
    row(&mut out, "overall", &card.overall);
    for (name, cell) in &card.by_phase {
        row(&mut out, name, cell);
    }
    for (name, cell) in &card.by_size {
        row(&mut out, &format!("chunks {name}"), cell);
    }
    for (name, cell) in &card.by_radius {
        row(&mut out, &format!("radius {name}"), cell);
    }
    for body in &card.worst {
        let _ = writeln!(
            out,
            "- worst body {:#x} ({} chunks, r {:.1} m): lever {:.2} m at tick {} [{}] truth ({:.1}, {:.1}, {:.1}) shown ({:.1}, {:.1}, {:.1}); mean {:.3} over {} frames",
            body.key, body.chunks, body.radius, body.worst_lever_m, body.at_tick, body.phase,
            body.truth_pos[0], body.truth_pos[1], body.truth_pos[2],
            body.presented_pos[0], body.presented_pos[1], body.presented_pos[2],
            body.mean_lever_m, body.frames
        );
    }
    let _ = writeln!(
        out,
        "\nmissing moving: {:.0} chunk-frames ({} body-frames) · settled {} bodies: pos p95 {:.3} m max {:.3} · lever p95 {:.3} m · escaped the world: {} bodies ({} body-frames, excluded)\n",
        card.missing_moving_weight,
        card.missing_moving_body_frames,
        card.settled_bodies,
        card.settle_pos_m.p95,
        card.settle_pos_m.max,
        card.settle_lever_m.p95,
        card.escaped_bodies,
        card.escaped_body_frames
    );
    out
}
