//! Track-split and subscription strategies for the per-body debris stream.
//!
//! The codec publishes once; a viewer receives only what it subscribes to. This
//! module measures the two decisions that sit either side of that: **how the
//! world is split into tracks** and **how a moving viewer picks tracks to
//! subscribe**. Both are pluggable, because neither has an obviously right
//! answer and the trade-offs only show up against real viewer motion.
//!
//! Three facts about this stream shape everything here:
//!
//! 1. **Bytes are duty-cycle-concentrated and spatially local.** A collapsing
//!    building is megabits per second for a few seconds; settled ground is
//!    free. So a static partition has wildly uneven, time-varying track rates,
//!    and the subscription -- not the partition -- has to adapt.
//! 2. **The stream is stateful.** Sampled runs continue from a carried chain
//!    and segments run for seconds. A track whose records reference state
//!    published elsewhere is not independently decodable, so a body moving
//!    between tracks must restart, and every track needs periodic keyframes or
//!    a subscriber can never join.
//! 3. **Every body needs *a* source at all times.** A viewer that subscribes
//!    only to what is near it would see distant bodies vanish. Splits therefore
//!    carry a coarse tier covering everything, and coverage -- the share of
//!    visible body-frames with no subscribed source -- is the primary quality
//!    gate, ahead of bitrate.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use glam::Vec3;
use serde::Serialize;

use crate::codec::rigid_shell_error_meters;
use crate::debris_codec::{
    decode_block, encode_block, Encoder, Playback, Record, SleepPolicy, Tolerances,
    DEFAULT_STRIDE_LADDER,
};
use crate::interest::sphere_in_view;
use crate::replay::ReplayWriter;
use crate::mask::MaskConfig;
use crate::trace::{ActorState, Camera, Pose, TraceReader};

/// A published track: an independently decodable stream with its own fidelity
/// contract. `cell` is `None` for world-wide tiers.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct TrackMeta {
    pub id: usize,
    pub name: String,
    pub tier: Tier,
    pub cell: Option<(i32, i32)>,
    pub shell_cm: f32,
    pub step_max_exp: u8,
    /// Sampled strides this tier may use -- how far it can drop in temporal rate.
    pub stride_ladder: Vec<u8>,
    /// This tier's encode window. Longer spans amortize the per-run header --
    /// the measured floor of a world-wide tier -- at the price of latency,
    /// which distance is already hiding.
    pub flush_ms: f32,
    /// Bodies smaller than this are not carried by this tier at all.
    pub min_radius_m: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum Tier {
    /// Everything, loose and slow. The floor every viewer always holds.
    Coarse,
    /// Full contract, spatially scoped.
    Detail,
    /// Full contract, scoped to a supercell -- the middle of a pyramid.
    Mid,
}

// ---------------------------------------------------------------------------
// Axis 1: publishing strategies
// ---------------------------------------------------------------------------

/// How the world is divided into published tracks.
///
/// `assign` runs once per body per flush span, so a body changes track at most
/// once per span and the resulting restart is cheap.
pub(crate) trait TrackSplit {
    fn name(&self) -> String;
    fn tracks(&self) -> Vec<TrackMeta>;
    /// Detail-tier track for this body this span, if any. Coarse tiers are
    /// driven separately (every body goes to them).
    fn assign(&self, body: usize, position: Vec3, radius: f32, moving: bool) -> Option<usize>;
    /// Tracks that receive every body regardless of assignment.
    fn broadcast_tracks(&self) -> Vec<usize>;
}

/// Strides for a coarse tier: sparse at the top so a long hold is cheap to
/// find, dense at the bottom so it can still fall back to the fine ladder.
fn coarse_ladder(max_stride: u8) -> Vec<u8> {
    let mut ladder: Vec<u8> = Vec::new();
    let mut stride = max_stride.max(1) as u32;
    while stride > 6 {
        ladder.push(stride.min(u8::MAX as u32) as u8);
        stride = (stride as f32 * 0.68) as u32;
    }
    ladder.extend_from_slice(&DEFAULT_STRIDE_LADDER);
    ladder
}

fn cell_of(position: Vec3, size: f32) -> (i32, i32) {
    (
        (position.x / size).floor() as i32,
        (position.z / size).floor() as i32,
    )
}

/// PS1: one track. The control -- today's stream plus keyframe overhead.
pub(crate) struct MonoSplit;

impl TrackSplit for MonoSplit {
    fn name(&self) -> String {
        "PS1-mono".into()
    }
    fn tracks(&self) -> Vec<TrackMeta> {
        vec![TrackMeta {
            id: 0,
            name: "world".into(),
            tier: Tier::Detail,
            cell: None,
            shell_cm: 0.5,
            step_max_exp: 2,
            stride_ladder: DEFAULT_STRIDE_LADDER.to_vec(),
            min_radius_m: 0.0,
            flush_ms: 250.0,
        }]
    }
    fn assign(&self, _body: usize, _position: Vec3, _radius: f32, _moving: bool) -> Option<usize> {
        Some(0)
    }
    fn broadcast_tracks(&self) -> Vec<usize> {
        Vec::new()
    }
}

/// PS2: a detail track per spatial cell, plus one world-wide coarse tier so
/// nothing is ever unsourced.
pub(crate) struct GridSplit {
    pub cell_size_m: f32,
    pub cells: Vec<(i32, i32)>,
    pub coarse_shell_cm: f32,
    pub coarse_step_exp: u8,
    pub coarse_max_stride: u8,
    pub coarse_min_radius_m: f32,
    pub coarse_flush_ms: f32,
}

impl GridSplit {
    /// Cells are discovered from the trace's own body layout, so the split
    /// adapts to whatever world it is handed.
    pub(crate) fn discover(positions: &[Vec3], cell_size_m: f32) -> Vec<(i32, i32)> {
        let mut cells: BTreeSet<(i32, i32)> = BTreeSet::new();
        for position in positions {
            cells.insert(cell_of(*position, cell_size_m));
        }
        cells.into_iter().collect()
    }

    fn detail_index(&self, cell: (i32, i32)) -> Option<usize> {
        self.cells.iter().position(|candidate| *candidate == cell)
    }
}

impl TrackSplit for GridSplit {
    fn name(&self) -> String {
        format!("PS2-grid{:.0}", self.cell_size_m)
    }
    fn tracks(&self) -> Vec<TrackMeta> {
        let mut tracks = vec![TrackMeta {
            id: 0,
            name: "coarse".into(),
            tier: Tier::Coarse,
            cell: None,
            shell_cm: self.coarse_shell_cm,
            step_max_exp: self.coarse_step_exp,
            stride_ladder: coarse_ladder(self.coarse_max_stride),
            min_radius_m: self.coarse_min_radius_m,
            flush_ms: self.coarse_flush_ms,
        }];
        for (index, cell) in self.cells.iter().enumerate() {
            tracks.push(TrackMeta {
                id: index + 1,
                name: format!("detail-{}_{}", cell.0, cell.1),
                tier: Tier::Detail,
                cell: Some(*cell),
                shell_cm: 0.5,
                step_max_exp: 2,
                stride_ladder: DEFAULT_STRIDE_LADDER.to_vec(),
                min_radius_m: 0.0,
                flush_ms: 250.0,
            });
        }
        tracks
    }
    fn assign(&self, _body: usize, position: Vec3, _radius: f32, _moving: bool) -> Option<usize> {
        self.detail_index(cell_of(position, self.cell_size_m))
            .map(|index| index + 1)
    }
    fn broadcast_tracks(&self) -> Vec<usize> {
        vec![0]
    }
}

/// PS5: structural bodies go world-wide at a loose contract (silhouettes are
/// always right), small debris stays cell-local. Tests the netcode doc's L0
/// idea directly.
pub(crate) struct ClassSplit {
    pub grid: GridSplit,
    pub structural_radius_m: f32,
}

impl TrackSplit for ClassSplit {
    fn name(&self) -> String {
        format!("PS5-class{:.1}", self.structural_radius_m)
    }
    fn tracks(&self) -> Vec<TrackMeta> {
        self.grid.tracks()
    }
    fn assign(&self, body: usize, position: Vec3, radius: f32, moving: bool) -> Option<usize> {
        if radius >= self.structural_radius_m {
            // Structural bodies ride the world tier only.
            return None;
        }
        self.grid.assign(body, position, radius, moving)
    }
    fn broadcast_tracks(&self) -> Vec<usize> {
        vec![0]
    }
}

/// PS4: split each cell by activity. Moving bodies land in the cell's hot
/// track; everything quiet shares one cheap world-wide cold track. The point is
/// that spikes concentrate in hot tracks, so a budget policy can shed exactly
/// the expensive thing without losing coverage of the settled world.
pub(crate) struct ActivitySplit {
    pub grid: GridSplit,
}

impl TrackSplit for ActivitySplit {
    fn name(&self) -> String {
        format!("PS4-activity{:.0}", self.grid.cell_size_m)
    }
    fn tracks(&self) -> Vec<TrackMeta> {
        self.grid.tracks()
    }
    fn assign(&self, body: usize, position: Vec3, radius: f32, moving: bool) -> Option<usize> {
        if !moving {
            return None;
        }
        self.grid.assign(body, position, radius, moving)
    }
    fn broadcast_tracks(&self) -> Vec<usize> {
        vec![0]
    }
}

// ---------------------------------------------------------------------------
// Axis 2: subscription strategies
// ---------------------------------------------------------------------------

/// How a viewer chooses tracks. Stateful: hysteresis and min-hold live here,
/// because churn is a cost the relay and the join latency both pay.
pub(crate) trait Subscribe {
    fn name(&self) -> String;
    fn choose(
        &mut self,
        tick: u32,
        camera: &Camera,
        tracks: &[TrackMeta],
        rates: &[f64],
        cell_size_m: f32,
        pane: (u32, u32),
    ) -> BTreeSet<usize>;
}

/// Keeps a chosen set stable for a minimum hold so a viewer skimming a boundary
/// does not thrash subscriptions.
#[derive(Default)]
struct HoldState {
    held: BTreeMap<usize, u32>,
}

impl HoldState {
    fn apply(&mut self, tick: u32, mut chosen: BTreeSet<usize>, hold_ticks: u32) -> BTreeSet<usize> {
        for (track, until) in self.held.iter() {
            if *until > tick {
                chosen.insert(*track);
            }
        }
        for track in chosen.iter() {
            self.held.insert(*track, tick + hold_ticks);
        }
        self.held.retain(|_, until| *until > tick);
        chosen
    }
}

/// Planar distance from a point to the nearest edge of a cell (0 inside it).
fn cell_edge_distance(point: Vec3, cell: (i32, i32), size: f32) -> f32 {
    let min_x = cell.0 as f32 * size;
    let min_z = cell.1 as f32 * size;
    let dx = (min_x - point.x).max(point.x - (min_x + size)).max(0.0);
    let dz = (min_z - point.z).max(point.z - (min_z + size)).max(0.0);
    (dx * dx + dz * dz).sqrt()
}

fn cell_center(cell: (i32, i32), size: f32) -> Vec3 {
    Vec3::new(
        (cell.0 as f32 + 0.5) * size,
        0.0,
        (cell.1 as f32 + 0.5) * size,
    )
}

/// SS1: subscribe detail for cells within a radius of the camera. The simplest
/// thing that could work, and the baseline every other strategy must beat.
pub(crate) struct RadiusSubscribe {
    pub radius_m: f32,
    pub hold_ticks: u32,
    state: HoldState,
}

impl RadiusSubscribe {
    pub(crate) fn new(radius_m: f32, hold_ticks: u32) -> Self {
        Self {
            radius_m,
            hold_ticks,
            state: HoldState::default(),
        }
    }
}

impl Subscribe for RadiusSubscribe {
    fn name(&self) -> String {
        format!("SS1-radius{:.0}", self.radius_m)
    }
    fn choose(
        &mut self,
        tick: u32,
        camera: &Camera,
        tracks: &[TrackMeta],
        _rates: &[f64],
        cell_size_m: f32,
        _pane: (u32, u32),
    ) -> BTreeSet<usize> {
        let mut chosen = BTreeSet::new();
        for track in tracks {
            match (track.tier, track.cell) {
                // A track with no cell covers the whole world, so every viewer
                // holds it regardless of tier -- that is what makes it a floor.
                (Tier::Coarse, _) | (_, None) => {
                    chosen.insert(track.id);
                }
                (_, Some(cell)) => {
                    // Distance to the cell's edge: measuring to its centre
                    // silently inflates the reach by half a cell.
                    if cell_edge_distance(camera.eye, cell, cell_size_m) <= self.radius_m {
                        chosen.insert(track.id);
                    }
                }
                _ => {}
            }
        }
        self.state.apply(tick, chosen, self.hold_ticks)
    }
}

/// SS2: view-directed. A cell is worth detail if the camera is in or beside it,
/// or if it is in frustum within a reach limit -- the same shape the archive
/// path's `desired_tracks` uses, which is the closest thing to a validated
/// selection rule the repo has.
pub(crate) struct FrustumSubscribe {
    pub reach_cells: f32,
    pub fov_margin_deg: f32,
    pub hold_ticks: u32,
    state: HoldState,
}

impl FrustumSubscribe {
    pub(crate) fn new(reach_cells: f32, fov_margin_deg: f32, hold_ticks: u32) -> Self {
        Self {
            reach_cells,
            fov_margin_deg,
            hold_ticks,
            state: HoldState::default(),
        }
    }

    fn wanted(
        &self,
        camera: &Camera,
        tracks: &[TrackMeta],
        cell_size_m: f32,
        pane: (u32, u32),
    ) -> Vec<(usize, f32)> {
        let eye_cell = cell_of(camera.eye, cell_size_m);
        let mut wanted = Vec::new();
        for track in tracks {
            let Some(cell) = track.cell else { continue };
            if track.tier == Tier::Coarse {
                continue;
            }
            let center = cell_center(cell, cell_size_m);
            let distance = cell_edge_distance(camera.eye, cell, cell_size_m);
            let adjacent =
                (cell.0 - eye_cell.0).abs() <= 1 && (cell.1 - eye_cell.1).abs() <= 1;
            let in_view = distance <= cell_size_m * self.reach_cells
                && sphere_in_view(
                    center,
                    cell_size_m * 0.75,
                    *camera,
                    pane.0,
                    pane.1,
                    self.fov_margin_deg,
                );
            if adjacent || in_view {
                wanted.push((track.id, distance));
            }
        }
        wanted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        wanted
    }
}

impl Subscribe for FrustumSubscribe {
    fn name(&self) -> String {
        format!("SS2-frustum{:.0}", self.reach_cells)
    }
    fn choose(
        &mut self,
        tick: u32,
        camera: &Camera,
        tracks: &[TrackMeta],
        _rates: &[f64],
        cell_size_m: f32,
        pane: (u32, u32),
    ) -> BTreeSet<usize> {
        let mut chosen: BTreeSet<usize> = tracks
            .iter()
            .filter(|track| track.tier == Tier::Coarse || track.cell.is_none())
            .map(|track| track.id)
            .collect();
        for (id, _) in self.wanted(camera, tracks, cell_size_m, pane) {
            chosen.insert(id);
        }
        self.state.apply(tick, chosen, self.hold_ticks)
    }
}

/// SS3: view-directed, then shed the farthest detail tracks while the projected
/// received rate is over budget. Application-level shedding is mandatory here:
/// the netcode doc records that MoQ's numeric priority could not be trusted to
/// do it in the relay.
pub(crate) struct BudgetSubscribe {
    pub inner: FrustumSubscribe,
    pub budget_mbps: f64,
}

impl Subscribe for BudgetSubscribe {
    fn name(&self) -> String {
        format!("SS3-budget{:.1}", self.budget_mbps)
    }
    fn choose(
        &mut self,
        tick: u32,
        camera: &Camera,
        tracks: &[TrackMeta],
        rates: &[f64],
        cell_size_m: f32,
        pane: (u32, u32),
    ) -> BTreeSet<usize> {
        let mut chosen: BTreeSet<usize> = tracks
            .iter()
            .filter(|track| track.tier == Tier::Coarse || track.cell.is_none())
            .map(|track| track.id)
            .collect();
        let wanted = self.inner.wanted(camera, tracks, cell_size_m, pane);
        // Nearest first, stopping when the budget is spent: quality degrades
        // from the edge of view inward, never in the middle of the action.
        let mut projected: f64 = chosen.iter().map(|id| rates[*id]).sum();
        for (id, _) in wanted {
            let cost = rates[id];
            if projected + cost > self.budget_mbps && !chosen.is_empty() {
                continue;
            }
            projected += cost;
            chosen.insert(id);
        }
        self.inner.state.apply(tick, chosen, self.inner.hold_ticks)
    }
}

/// SS5: the coarse floor alone. Establishes what a viewer sees when nothing
/// local is subscribed -- the bird's-eye case, and the honest lower bound.
pub(crate) struct CoarseOnlySubscribe;

impl Subscribe for CoarseOnlySubscribe {
    fn name(&self) -> String {
        "SS5-coarse-only".into()
    }
    fn choose(
        &mut self,
        _tick: u32,
        _camera: &Camera,
        tracks: &[TrackMeta],
        _rates: &[f64],
        _cell_size_m: f32,
        _pane: (u32, u32),
    ) -> BTreeSet<usize> {
        tracks
            .iter()
            .filter(|track| track.tier == Tier::Coarse || track.cell.is_none())
            .map(|track| track.id)
            .collect()
    }
}

/// SS6: subscribe the busiest tracks until the budget is spent, ignoring the
/// camera entirely -- a spectator auto-director. Also the adversarial coverage
/// test: it will happily watch the wrong side of the map.
pub(crate) struct GreedyRateSubscribe {
    pub budget_mbps: f64,
    state: HoldState,
    pub hold_ticks: u32,
}

impl GreedyRateSubscribe {
    pub(crate) fn new(budget_mbps: f64, hold_ticks: u32) -> Self {
        Self {
            budget_mbps,
            state: HoldState::default(),
            hold_ticks,
        }
    }
}

impl Subscribe for GreedyRateSubscribe {
    fn name(&self) -> String {
        format!("SS6-greedy{:.1}", self.budget_mbps)
    }
    fn choose(
        &mut self,
        tick: u32,
        _camera: &Camera,
        tracks: &[TrackMeta],
        rates: &[f64],
        _cell_size_m: f32,
        _pane: (u32, u32),
    ) -> BTreeSet<usize> {
        let mut chosen: BTreeSet<usize> = tracks
            .iter()
            .filter(|track| track.tier == Tier::Coarse || track.cell.is_none())
            .map(|track| track.id)
            .collect();
        let mut ranked: Vec<(usize, f64)> = tracks
            .iter()
            .filter(|track| track.tier != Tier::Coarse)
            .map(|track| (track.id, rates[track.id]))
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut projected: f64 = chosen.iter().map(|id| rates[*id]).sum();
        for (id, cost) in ranked {
            if cost <= 0.0 || projected + cost > self.budget_mbps {
                continue;
            }
            projected += cost;
            chosen.insert(id);
        }
        self.state.apply(tick, chosen, self.hold_ticks)
    }
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

/// Deterministic camera paths, shaped after the archive path's spectator routes
/// so the two experiments stay comparable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewerKind {
    /// Chases whichever cell is currently loudest, close in.
    ActionFollower,
    /// Crosses the whole map at a steady pace, through quiet and loud alike.
    RoamingTourist,
    /// Sees everything at once -- the adversarial case for spatial splits.
    BirdsEye,
    /// Jumps between hotspots, the worst case for join latency.
    Teleporter,
}

impl ViewerKind {
    fn name(self) -> &'static str {
        match self {
            ViewerKind::ActionFollower => "action-follower",
            ViewerKind::RoamingTourist => "roaming-tourist",
            ViewerKind::BirdsEye => "birds-eye",
            ViewerKind::Teleporter => "teleporter",
        }
    }

    fn all() -> [ViewerKind; 4] {
        [
            ViewerKind::ActionFollower,
            ViewerKind::RoamingTourist,
            ViewerKind::BirdsEye,
            ViewerKind::Teleporter,
        ]
    }
}

/// Where the camera is at this tick. `hotspot` is the busiest cell centre,
/// which the follower and teleporter aim at.
fn viewer_camera(
    kind: ViewerKind,
    tick: u32,
    ticks: u32,
    bounds_min: Vec3,
    bounds_max: Vec3,
    hotspot: Vec3,
) -> Camera {
    let center = 0.5 * (bounds_min + bounds_max);
    let extent = (bounds_max - bounds_min).max(Vec3::splat(1.0));
    let span = extent.x.max(extent.z);
    let progress = tick as f32 / ticks.max(1) as f32;
    match kind {
        ViewerKind::ActionFollower => {
            let angle = progress * std::f32::consts::TAU * 0.35;
            let eye = hotspot + Vec3::new(angle.cos() * 70.0, 28.0, angle.sin() * 70.0);
            Camera {
                eye,
                direction: (hotspot - eye).normalize_or_zero(),
                fov_degrees: 60.0,
            }
        }
        ViewerKind::RoamingTourist => {
            // A full 360 degree sweep across one 5 s clip is 72 deg/s -- visibly
            // whipping. A spectator walks; this covers a gentle arc close to
            // the buildings instead of a fast lap around the whole map. Over
            // the full 10 s trace this is ~10 deg/s.
            let angle = progress * std::f32::consts::TAU * 0.18;
            let radius = span * 0.22;
            let eye = center + Vec3::new(angle.cos() * radius, 14.0, angle.sin() * radius);
            let tangent = Vec3::new(-angle.sin(), 0.0, angle.cos());
            // Mostly tangential (a walking pan) with enough pull toward the
            // skyline that buildings stay framed instead of sliding off-screen.
            let look = eye + (tangent * 0.72 + (center - eye).normalize_or_zero() * 0.55);
            Camera {
                eye,
                direction: (look - eye).normalize_or_zero(),
                fov_degrees: 60.0,
            }
        }
        ViewerKind::BirdsEye => {
            let eye = center + Vec3::new(0.0, span * 1.1 + 120.0, span * 0.55);
            Camera {
                eye,
                direction: (center - eye).normalize_or_zero(),
                fov_degrees: 60.0,
            }
        }
        ViewerKind::Teleporter => {
            // Jump every two seconds between opposite quadrants and the hotspot.
            let slot = (progress * 6.0).floor() as i32;
            let anchor = match slot % 3 {
                0 => hotspot,
                1 => center + Vec3::new(span * 0.35, 0.0, span * 0.35),
                _ => center + Vec3::new(-span * 0.35, 0.0, -span * 0.35),
            };
            let eye = anchor + Vec3::new(0.0, 40.0, 85.0);
            Camera {
                eye,
                direction: (anchor - eye).normalize_or_zero(),
                fov_degrees: 60.0,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Encoding the split
// ---------------------------------------------------------------------------

struct TrackStream {
    meta: TrackMeta,
    encoder: Encoder,
    pending: Vec<Record>,
    tails: Vec<Option<([i32; 3], u64)>>,
    /// (first_tick, compressed_len, keyframe, records)
    blocks: Vec<(u32, usize, bool, Vec<Record>)>,
    uncompressed: u64,
    compressed: u64,
    sampled_frames: u64,
    /// Per-tier cadence: this stream's own span, block and keyframe grids.
    span_ticks: u32,
    block_ticks: u32,
    keyframe_ticks: u32,
    block_first_tick: u32,
    block_is_keyframe: bool,
}

fn tolerances_for(meta: &TrackMeta, mask_cap_mm: f32) -> Tolerances {
    Tolerances::new(
        meta.shell_cm / 100.0,
        3.0,
        0.15,
        0.5,
        MaskConfig {
            enabled: true,
            base_m: meta.shell_cm / 100.0,
            cap_m: (mask_cap_mm / 1000.0).max(meta.shell_cm / 100.0 * 4.0),
            ..MaskConfig::default()
        },
    )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct TrackRow {
    id: usize,
    name: String,
    tier: Tier,
    compressed_bytes: u64,
    mbps: f64,
    /// Where a tier's bytes actually go, so a floor can be attacked at its
    /// real cause rather than its assumed one.
    segments: u64,
    impulses: u64,
    sample_runs: u64,
    sampled_frames: u64,
    rests: u64,
    segment_pct: f64,
    impulse_pct: f64,
    sample_pct: f64,
    rest_pct: f64,
    bytes_per_sampled_frame: f64,
}

#[derive(Serialize)]
struct ViewerRow {
    split: String,
    subscribe: String,
    viewer: String,
    received_bytes: u64,
    received_mbps_avg: f64,
    received_mbps_p95: f64,
    received_mbps_peak: f64,
    tracks_avg: f64,
    tracks_max: usize,
    joins_per_min: f64,
    resync_pct: f64,
    coverage_missing_pct: f64,
    detail_pct: f64,
    coarse_pct: f64,
    visible_error_p95_cm: f32,
    visible_error_max_cm: f32,
    meets_3mbps: bool,
    meets_2p5mbps: bool,
}

#[derive(Serialize)]
struct TracksReport {
    trace: String,
    bodies: usize,
    ticks: u32,
    duration_seconds: f64,
    cell_size_m: f32,
    keyframe_ms: f32,
    single_stream_reference_bytes: u64,
    splits: Vec<SplitRow>,
    viewers: Vec<ViewerRow>,
}

#[derive(Serialize)]
struct SplitRow {
    name: String,
    track_count: usize,
    published_bytes: u64,
    published_mbps: f64,
    overhead_vs_mono: f64,
    keyframe_bytes: u64,
    tracks: Vec<TrackRow>,
}

pub struct DebrisTracksOptions {
    pub trace: PathBuf,
    pub out_dir: PathBuf,
    pub cell_size_m: f32,
    pub keyframe_ms: f32,
    pub flush_ms: f32,
    pub block_ms: f32,
    pub budget_mbps: f64,
    pub mask_cap_mm: f32,
    pub max_ticks: Option<u32>,
    pub coarse_max_stride: u8,
    pub coarse_min_radius_m: f32,
    pub coarse_shell_cm: f32,
    pub far_flush_ms: f32,
    pub coarse_step_exp: u8,
    pub output_fps: u32,
    pub render_viewer: Option<String>,
    /// Write the viewer's own camera into all four panes at native 1080p, so
    /// one quadrant can be cropped out as a full-resolution solo video.
    pub render_solo: bool,
    /// Distances (metres) of the three fixed vantage panes from world centre,
    /// used only when `render_solo` is off.
    pub rig_distances_m: [f32; 3],
    pub splits: Vec<String>,
    pub subscribes: Vec<String>,
}

fn reader_header_for(trace: &std::path::Path) -> Result<crate::trace::Header> {
    Ok(TraceReader::open(trace)?.header.clone())
}

fn actor_defs_for(trace: &std::path::Path) -> Result<Vec<crate::trace::ActorDef>> {
    Ok(TraceReader::open(trace)?.actors.clone())
}

pub fn run(options: DebrisTracksOptions) -> Result<()> {
    fs::create_dir_all(&options.out_dir)
        .with_context(|| format!("create {}", options.out_dir.display()))?;

    let reader = TraceReader::open(&options.trace)?;
    let physics_hz = reader.header.physics_hz;
    let dt = 1.0 / physics_hz as f32;
    let gravity = reader.header.gravity;
    let body_count = reader.actors.len();
    let radii: Vec<f32> = reader
        .actors
        .iter()
        .map(|actor| actor.bounding_radius.max(0.01))
        .collect();
    let pane = (reader.header.pane_width, reader.header.pane_height);
    drop(reader);

    let span_ticks = ((options.flush_ms / 1000.0) * physics_hz as f32).round().max(1.0) as u32;
    let mut block_ticks = ((options.block_ms / 1000.0) * physics_hz as f32)
        .round()
        .max(span_ticks as f32) as u32;
    block_ticks -= block_ticks % span_ticks;
    let keyframe_ticks = (((options.keyframe_ms / 1000.0) * physics_hz as f32).round() as u32)
        .max(block_ticks)
        / block_ticks
        * block_ticks;

    // Body home positions and world bounds, from the first tick.
    let mut probe = TraceReader::open(&options.trace)?;
    let first = probe
        .next_tick()?
        .ok_or_else(|| anyhow::anyhow!("trace has no ticks"))?;
    let start_positions: Vec<Vec3> = first.states.iter().map(|state| state.pose.position).collect();
    drop(probe);
    let mut bounds_min = Vec3::splat(f32::MAX);
    let mut bounds_max = Vec3::splat(f32::MIN);
    for (position, radius) in start_positions.iter().zip(&radii) {
        // Sentinel parking spots would swamp the bounds.
        if position.abs().max_element() > 5000.0 {
            continue;
        }
        bounds_min = bounds_min.min(*position - Vec3::splat(*radius));
        bounds_max = bounds_max.max(*position + Vec3::splat(*radius));
    }
    let cells = GridSplit::discover(&start_positions, options.cell_size_m);

    let mut report = TracksReport {
        trace: options.trace.display().to_string(),
        bodies: body_count,
        ticks: 0,
        duration_seconds: 0.0,
        cell_size_m: options.cell_size_m,
        keyframe_ms: options.keyframe_ms,
        single_stream_reference_bytes: 0,
        splits: Vec::new(),
        viewers: Vec::new(),
    };
    let mut mono_bytes = 0_u64;

    for split_name in &options.splits {
        let split: Box<dyn TrackSplit> = match split_name.as_str() {
            "PS1" => Box::new(MonoSplit),
            "PS2" => Box::new(GridSplit {
                cell_size_m: options.cell_size_m,
                cells: cells.clone(),
                coarse_shell_cm: options.coarse_shell_cm,
                coarse_step_exp: options.coarse_step_exp,
                coarse_max_stride: options.coarse_max_stride,
                coarse_min_radius_m: options.coarse_min_radius_m,
                coarse_flush_ms: options.far_flush_ms,
            }),
            "PS4" => Box::new(ActivitySplit {
                grid: GridSplit {
                    cell_size_m: options.cell_size_m,
                    cells: cells.clone(),
                    coarse_shell_cm: options.coarse_shell_cm,
                    coarse_step_exp: options.coarse_step_exp,
                    coarse_max_stride: options.coarse_max_stride,
                    coarse_min_radius_m: options.coarse_min_radius_m,
                    coarse_flush_ms: options.far_flush_ms,
                },
            }),
            "PS5" => Box::new(ClassSplit {
                grid: GridSplit {
                    cell_size_m: options.cell_size_m,
                    cells: cells.clone(),
                    coarse_shell_cm: options.coarse_shell_cm,
                    coarse_step_exp: options.coarse_step_exp,
                    coarse_max_stride: options.coarse_max_stride,
                    coarse_min_radius_m: options.coarse_min_radius_m,
                    coarse_flush_ms: options.far_flush_ms,
                },
                structural_radius_m: 1.1,
            }),
            other => anyhow::bail!("unknown split {other}"),
        };

        let (streams, ticks_seen, hotspots) = encode_split(
            &options,
            split.as_ref(),
            body_count,
            &radii,
            dt,
            gravity,
            physics_hz,
            span_ticks,
            block_ticks,
            keyframe_ticks,
        )?;
        report.ticks = ticks_seen;
        report.duration_seconds = ticks_seen as f64 / physics_hz as f64;

        let published: u64 = streams.iter().map(|stream| stream.compressed).sum();
        let keyframe_bytes: u64 = streams
            .iter()
            .flat_map(|stream| stream.blocks.iter())
            .filter(|(_, _, keyframe, _)| *keyframe)
            .map(|(_, len, _, _)| *len as u64)
            .sum();
        if split_name == "PS1" {
            mono_bytes = published;
            report.single_stream_reference_bytes = published;
        }
        let duration = report.duration_seconds.max(1e-9);
        report.splits.push(SplitRow {
            name: split.name(),
            track_count: streams.len(),
            published_bytes: published,
            published_mbps: published as f64 * 8.0 / duration / 1.0e6,
            overhead_vs_mono: if mono_bytes > 0 {
                published as f64 / mono_bytes as f64
            } else {
                1.0
            },
            keyframe_bytes,
            tracks: streams
                .iter()
                .map(|stream| {
                    let raw = stream.uncompressed.max(1) as f64;
                    let seg = stream.encoder.kind_byte(0) + stream.encoder.kind_byte(4);
                    let imp = stream.encoder.kind_byte(1);
                    let smp = stream.encoder.kind_byte(2);
                    let rst = stream.encoder.kind_byte(3);
                    let frames = stream.sampled_frames;
                    TrackRow {
                        id: stream.meta.id,
                        name: stream.meta.name.clone(),
                        tier: stream.meta.tier,
                        compressed_bytes: stream.compressed,
                        mbps: stream.compressed as f64 * 8.0 / duration / 1.0e6,
                        segments: stream.encoder.kind_count(0) + stream.encoder.kind_count(4),
                        impulses: stream.encoder.kind_count(1),
                        sample_runs: stream.encoder.kind_count(2),
                        sampled_frames: frames,
                        rests: stream.encoder.kind_count(3),
                        segment_pct: seg as f64 * 100.0 / raw,
                        impulse_pct: imp as f64 * 100.0 / raw,
                        sample_pct: smp as f64 * 100.0 / raw,
                        rest_pct: rst as f64 * 100.0 / raw,
                        bytes_per_sampled_frame: smp as f64 / frames.max(1) as f64,
                    }
                })
                .collect(),
        });

        // Decode every track once and replay it per viewer, rather than paying
        // the decode again for each strategy in the matrix.
        let mut playbacks: Vec<Vec<Playback>> = Vec::with_capacity(streams.len());
        let mut block_bytes: Vec<BTreeMap<u32, (usize, bool)>> = Vec::with_capacity(streams.len());
        for stream in &streams {
            // Both sides carry tails across blocks in the same order, exactly as
            // publisher and subscriber do; a fresh vector per block would
            // misparse every continuity run.
            let mut encode_tails = vec![None; body_count];
            let mut decode_tails = vec![None; body_count];
            let mut per_body: Vec<Playback> =
                (0..body_count).map(|_| Playback::default()).collect();
            let mut bytes = BTreeMap::new();
            for (first_tick, compressed, keyframe, records) in &stream.blocks {
                bytes.insert(*first_tick, (*compressed, *keyframe));
                let mut sorted = records.clone();
                let payload = encode_block(&mut sorted, *first_tick, &mut encode_tails, false);
                for record in decode_block(&payload, &mut decode_tails, false)? {
                    per_body[record.body() as usize].events.push(record);
                }
            }
            for playback in per_body.iter_mut() {
                playback.events.sort_by_key(|record| record.tick());
            }
            playbacks.push(per_body);
            block_bytes.push(bytes);
        }

        for subscribe_name in &options.subscribes {
            for kind in ViewerKind::all() {
                let row = simulate_viewer(
                    &options,
                    split.as_ref(),
                    &split.name(),
                    subscribe_name,
                    kind,
                    &mut playbacks,
                    &block_bytes,
                    body_count,
                    &radii,
                    dt,
                    gravity,
                    physics_hz,
                    block_ticks,
                    keyframe_ticks,
                    ticks_seen,
                    bounds_min,
                    bounds_max,
                    &hotspots,
                    pane,
                )?;
                println!(
                    "{:14} {:16} {:16} recv {:6.3} Mbps (p95 {:6.3} peak {:6.3})  tracks {:.1}/{:2}  cover-miss {:5.2}%  detail {:5.1}%  err p95 {:5.2} cm  3Mbps {}",
                    row.split,
                    row.subscribe,
                    row.viewer,
                    row.received_mbps_avg,
                    row.received_mbps_p95,
                    row.received_mbps_peak,
                    row.tracks_avg,
                    row.tracks_max,
                    row.coverage_missing_pct,
                    row.detail_pct,
                    row.visible_error_p95_cm,
                    if row.meets_3mbps { "yes" } else { "NO" }
                );
                report.viewers.push(row);
            }
        }
    }

    fs::write(
        options.out_dir.join("tracks_report.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    Ok(())
}

/// Runs the trace once, driving one encoder per track.
#[allow(clippy::too_many_arguments)]
fn encode_split(
    options: &DebrisTracksOptions,
    split: &dyn TrackSplit,
    body_count: usize,
    radii: &[f32],
    dt: f32,
    gravity: Vec3,
    physics_hz: u32,
    span_ticks: u32,
    block_ticks: u32,
    keyframe_ticks: u32,
) -> Result<(Vec<TrackStream>, u32, Vec<Vec3>)> {
    let metas = split.tracks();
    let broadcast = split.broadcast_tracks();
    let mut streams: Vec<TrackStream> = metas
        .into_iter()
        .map(|meta| {
            let tolerances = tolerances_for(&meta, options.mask_cap_mm);
            // Each tier keeps its own grids: span, then a block that is a whole
            // number of spans, then a keyframe that is a whole number of blocks.
            let stream_span = ((meta.flush_ms / 1000.0) * physics_hz as f32)
                .round()
                .max(1.0) as u32;
            let mut stream_block = ((options.block_ms / 1000.0) * physics_hz as f32)
                .round()
                .max(stream_span as f32) as u32;
            stream_block -= stream_block % stream_span;
            let mut stream_keyframe = (((options.keyframe_ms / 1000.0) * physics_hz as f32)
                .round() as u32)
                .max(stream_block);
            stream_keyframe -= stream_keyframe % stream_block;
            TrackStream {
                span_ticks: stream_span,
                block_ticks: stream_block,
                keyframe_ticks: stream_keyframe,
                block_first_tick: 0,
                block_is_keyframe: true,
                encoder: Encoder::new(
                    body_count,
                    dt,
                    gravity,
                    radii.to_vec(),
                    tolerances,
                    SleepPolicy::off(),
                    meta.step_max_exp,
                    meta.stride_ladder.clone(),
                    true,
                    0.0,
                    true,
                ),
                meta,
                pending: Vec::new(),
                tails: vec![None; body_count],
                blocks: Vec::new(),
                uncompressed: 0,
                compressed: 0,
                sampled_frames: 0,
            }
        })
        .collect();

    let mut assignment: Vec<Option<usize>> = vec![None; body_count];
    let mut reader = TraceReader::open(&options.trace)?;
    let mut ticks_seen = 0_u32;
    // Per-cell activity, for the hotspot the follower/teleporter chase.
    let mut hotspots: Vec<Vec3> = Vec::new();
    let mut activity: BTreeMap<(i32, i32), f32> = BTreeMap::new();

    while let Some(tick) = reader.next_tick()? {
        if let Some(limit) = options.max_ticks {
            if tick.index >= limit {
                break;
            }
        }
        ticks_seen = tick.index + 1;

        // Close any stream whose own block boundary falls on this tick.
        for stream in streams.iter_mut() {
            let block_first = (tick.index / stream.block_ticks) * stream.block_ticks;
            if block_first != stream.block_first_tick {
                let payload =
                    encode_block(&mut stream.pending, stream.block_first_tick, &mut stream.tails, false);
                let compressed = zstd::bulk::compress(&payload, 3)?.len() + 12;
                stream.uncompressed += payload.len() as u64;
                stream.compressed += compressed as u64;
                let taken = std::mem::take(&mut stream.pending);
                stream.sampled_frames += taken
                    .iter()
                    .map(|record| match record {
                        Record::SampleRun { frames, .. } => frames.len() as u64,
                        _ => 0,
                    })
                    .sum::<u64>();
                stream.blocks.push((
                    stream.block_first_tick,
                    compressed,
                    stream.block_is_keyframe,
                    taken,
                ));
                stream.block_first_tick = block_first;
                stream.block_is_keyframe = block_first % stream.keyframe_ticks == 0;
                if stream.block_is_keyframe {
                    stream
                        .encoder
                        .begin_keyframe(block_first, &mut stream.pending);
                }
            }
        }

        // Reassignment stays on the detail cadence so migration granularity is
        // independent of how slowly a coarse tier is flushed.
        if tick.index % span_ticks == 0 {
            activity.clear();
            for (body, state) in tick.states.iter().enumerate() {
                let moving = state.linear_velocity.length() > 0.2 && !state.sleeping();
                let next = split.assign(body, state.pose.position, radii[body], moving);
                if next != assignment[body] {
                    if let Some(track) = next {
                        streams[track].encoder.force_restart(body);
                    }
                    assignment[body] = next;
                }
                if moving {
                    *activity
                        .entry(cell_of(state.pose.position, options.cell_size_m))
                        .or_insert(0.0) += 1.0;
                }
            }
            let hotspot = activity
                .iter()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(cell, _)| cell_center(*cell, options.cell_size_m))
                .unwrap_or(Vec3::ZERO);
            hotspots.push(hotspot);
        }

        for (body, state) in tick.states.iter().enumerate() {
            if let Some(track) = assignment[body] {
                streams[track].encoder.push(body, tick.index, state);
            }
            for track in &broadcast {
                // A world-wide tier may carry only the bodies big enough to
                // read at distance; the rest exist solely in detail tracks.
                if radii[body] >= streams[*track].meta.min_radius_m {
                    streams[*track].encoder.push(body, tick.index, state);
                }
            }
        }

        for stream in streams.iter_mut() {
            if (tick.index + 1) % stream.span_ticks == 0 {
                let first = stream.block_first_tick;
                stream.encoder.finalize_span(first, &mut stream.pending);
            }
        }
    }
    for stream in streams.iter_mut() {
        let first = stream.block_first_tick;
        stream.encoder.finalize_span(first, &mut stream.pending);
        let payload = encode_block(&mut stream.pending, first, &mut stream.tails, false);
        let compressed = zstd::bulk::compress(&payload, 3)?.len() + 12;
        stream.uncompressed += payload.len() as u64;
        stream.compressed += compressed as u64;
        stream.blocks.push((
            first,
            compressed,
            stream.block_is_keyframe,
            std::mem::take(&mut stream.pending),
        ));
    }
    let _ = physics_hz;
    Ok((streams, ticks_seen, hotspots))
}

/// Replays the trace against one viewer's subscription decisions and scores
/// what that viewer would actually have seen.
#[allow(clippy::too_many_arguments)]
fn simulate_viewer(
    options: &DebrisTracksOptions,
    split: &dyn TrackSplit,
    split_name: &str,
    subscribe_name: &str,
    kind: ViewerKind,
    playbacks: &mut [Vec<Playback>],
    block_bytes: &[BTreeMap<u32, (usize, bool)>],
    body_count: usize,
    radii: &[f32],
    dt: f32,
    gravity: Vec3,
    physics_hz: u32,
    block_ticks: u32,
    keyframe_ticks: u32,
    ticks_seen: u32,
    bounds_min: Vec3,
    bounds_max: Vec3,
    hotspots: &[Vec3],
    pane: (u32, u32),
) -> Result<ViewerRow> {
    let metas = split.tracks();
    let hold_ticks = (2.0 * physics_hz as f32) as u32;
    let mut subscriber: Box<dyn Subscribe> = match subscribe_name {
        "SS1" => Box::new(RadiusSubscribe::new(90.0, hold_ticks)),
        "SS2" => Box::new(FrustumSubscribe::new(6.0, 10.0, hold_ticks)),
        "SS3" => Box::new(BudgetSubscribe {
            inner: FrustumSubscribe::new(6.0, 10.0, hold_ticks),
            budget_mbps: options.budget_mbps,
        }),
        "SS5" => Box::new(CoarseOnlySubscribe),
        "SS6" => Box::new(GreedyRateSubscribe::new(options.budget_mbps, hold_ticks)),
        other => anyhow::bail!("unknown subscribe strategy {other}"),
    };

    for track in playbacks.iter_mut() {
        for playback in track.iter_mut() {
            playback.rewind();
        }
    }

    // Optional recording of exactly what this viewer receives, from their own
    // moving camera. Truth is written alongside for an honest A/B.
    let mut replay = match &options.render_viewer {
        Some(want) if *want == kind.name() => {
            // The writer sizes itself from the header, so a truncated run must
            // say so or its recording ends up missing its terminator.
            let mut header = reader_header_for(&options.trace)?;
            header.tick_count = ticks_seen;
            if options.render_solo {
                // The recorded trace's pane is small (960x540, sized for a
                // 2x2 grid); the solo crop reads directly off this pane, so it
                // is bumped to native 1080p rather than upscaled after the fact.
                header.pane_width = 1920;
                header.pane_height = 1080;
            }
            let actors = actor_defs_for(&options.trace)?;
            let stem = format!("{split_name}-{subscribe_name}-{}", kind.name());
            Some((
                ReplayWriter::create(
                    &options.out_dir.join(format!("view-{stem}.towerstate")),
                    &header,
                    &actors,
                    options.output_fps,
                )?,
                ReplayWriter::create(
                    &options.out_dir.join(format!("truth-{stem}.towerstate")),
                    &header,
                    &actors,
                    options.output_fps,
                )?,
                (header.physics_hz / options.output_fps).max(1),
            ))
        }
        _ => None,
    };

    let mut reader = TraceReader::open(&options.trace)?;
    let mut received_bytes = 0_u64;
    let mut resync_bytes = 0_u64;
    let mut tick_bytes = vec![0_u64; ticks_seen as usize];
    let mut subscribed: BTreeSet<usize> = BTreeSet::new();
    let mut joined_at: BTreeMap<usize, u32> = BTreeMap::new();
    let mut joins = 0_u64;
    let mut tracks_sum = 0_f64;
    let mut tracks_max = 0_usize;
    let mut ticks_counted = 0_u64;
    let mut visible = 0_u64;
    let mut missing = 0_u64;
    let mut from_detail = 0_u64;
    let mut from_coarse = 0_u64;
    let mut errors: Vec<f32> = Vec::new();
    let mut error_max = 0.0_f32;
    // Live rates drive the budget strategies: the last full block per track.
    let mut live_rates = vec![0.0_f64; playbacks.len()];
    let track_block_seconds: Vec<f64> = metas
        .iter()
        .map(|meta| {
            let span = ((meta.flush_ms / 1000.0) * physics_hz as f32).round().max(1.0) as u32;
            let block = (((options.block_ms / 1000.0) * physics_hz as f32).round() as u32)
                .max(span)
                / span
                * span;
            block as f64 / physics_hz as f64
        })
        .collect();

    while let Some(tick) = reader.next_tick()? {
        if tick.index >= ticks_seen {
            break;
        }
        let hotspot = hotspots
            .get((tick.index / (physics_hz / 4).max(1)) as usize)
            .copied()
            .unwrap_or_else(|| hotspots.last().copied().unwrap_or(Vec3::ZERO));
        let camera = viewer_camera(kind, tick.index, ticks_seen, bounds_min, bounds_max, hotspot);

        if tick.index % block_ticks == 0 {
            for (index, bytes) in block_bytes.iter().enumerate() {
                // Tracks flush on their own cadence now, so a rate is the most
                // recent block of THAT track spread over its own span.
                live_rates[index] = bytes
                    .range(..=tick.index)
                    .next_back()
                    .map(|(first, (len, _))| {
                        let span = track_block_seconds[index].max(1e-9);
                        let _ = first;
                        *len as f64 * 8.0 / span / 1.0e6
                    })
                    .unwrap_or(0.0);
            }
            let chosen = subscriber.choose(
                tick.index,
                &camera,
                &metas,
                &live_rates,
                options.cell_size_m,
                pane,
            );
            for track in chosen.difference(&subscribed) {
                joins += 1;
                // A track is only usable from its next keyframe.
                let next_keyframe = tick.index.div_ceil(keyframe_ticks) * keyframe_ticks;
                joined_at.insert(*track, next_keyframe);
            }
            for track in subscribed.difference(&chosen) {
                joined_at.remove(track);
            }
            subscribed = chosen;
            tracks_sum += subscribed.len() as f64;
            tracks_max = tracks_max.max(subscribed.len());
            ticks_counted += 1;

            for track in &subscribed {
                // Charge only blocks that actually close in this window.
                if let Some((len, keyframe)) = block_bytes[*track].get(&tick.index) {
                    let usable = joined_at.get(track).is_some_and(|from| tick.index >= *from);
                    if usable || *keyframe {
                        received_bytes += *len as u64;
                        tick_bytes[tick.index as usize] += *len as u64;
                        if *keyframe {
                            resync_bytes += *len as u64;
                        }
                    }
                }
                // Slow tiers close between subscription ticks; charge those too.
                for (first, (len, keyframe)) in block_bytes[*track]
                    .range(tick.index + 1..tick.index + block_ticks)
                {
                    let usable = joined_at.get(track).is_some_and(|from| *first >= *from);
                    if usable || *keyframe {
                        received_bytes += *len as u64;
                        tick_bytes[*first as usize] += *len as u64;
                        if *keyframe {
                            resync_bytes += *len as u64;
                        }
                    }
                }
            }
        }

        // Advance every subscribed track's playback and score what is visible.
        for track in subscribed.iter() {
            let usable = joined_at.get(track).is_some_and(|from| tick.index >= *from);
            if !usable {
                continue;
            }
            for body in 0..body_count {
                playbacks[*track][body].advance_to(tick.index, dt, gravity);
            }
        }

        if let Some((view, truth, stride)) = replay.as_mut() {
            if tick.index % *stride == 0 {
                // Three fixed vantage points plus the viewer's own camera. The
                // vantage points must not move: an earlier version aimed them
                // at the busiest cell, which hops between cells every span, so
                // the panes teleported and buildings swung in and out of frame
                // -- an artifact of the recording, not of the stream.
                let focus = 0.5 * (bounds_min + bounds_max) + Vec3::new(0.0, 30.0, 0.0);
                let rig = |distance: f32, height: f32| {
                    let eye = focus + Vec3::new(0.0, height, distance);
                    Camera {
                        eye,
                        direction: (focus - eye).normalize_or_zero(),
                        fov_degrees: 60.0,
                    }
                };
                let four = if options.render_solo {
                    // All four slots carry the viewer's own camera, so every
                    // quadrant is identical and one can be cropped out full
                    // resolution -- this is what makes the solo video possible
                    // without a renderer change.
                    [camera; 4]
                } else {
                    // Closer than the original rig (120/220/380 m): close
                    // enough to actually judge per-body texture quality, not
                    // just silhouette survival.
                    [
                        camera,
                        rig(options.rig_distances_m[0], options.rig_distances_m[0] * 0.3),
                        rig(options.rig_distances_m[1], options.rig_distances_m[1] * 0.3),
                        rig(options.rig_distances_m[2], options.rig_distances_m[2] * 0.3),
                    ]
                };
                view.write_cameras(&four)?;
                truth.write_cameras(&four)?;
                let mut seen: Vec<(u32, Pose, bool)> = Vec::new();
                for body in 0..body_count {
                    let mut best: Option<(u32, Pose)> = None;
                    for track in subscribed.iter() {
                        let usable =
                            joined_at.get(track).is_some_and(|from| tick.index >= *from);
                        if !usable {
                            continue;
                        }
                        let playback = &playbacks[*track][body];
                        let (Some(pose), Some(freshness)) = (
                            playback.pose_at(tick.index, dt, gravity),
                            playback.last_event_tick(),
                        ) else {
                            continue;
                        };
                        if best.as_ref().is_none_or(|(seen, _)| freshness > *seen) {
                            best = Some((freshness, pose));
                        }
                    }
                    if let Some((_, pose)) = best {
                        seen.push((body as u32, pose, false));
                    }
                }
                view.write_frame_subset(&seen)?;
                let all: Vec<(u32, Pose, bool)> = tick
                    .states
                    .iter()
                    .enumerate()
                    .map(|(body, state)| (body as u32, state.pose, state.sleeping()))
                    .collect();
                truth.write_frame_subset(&all)?;
            }
        }

        if tick.index % (physics_hz / 30).max(1) != 0 {
            continue;
        }
        for (body, state) in tick.states.iter().enumerate() {
            if state.pose.position.abs().max_element() > 5000.0 {
                continue;
            }
            if !sphere_in_view(
                state.pose.position,
                radii[body],
                camera,
                pane.0,
                pane.1,
                0.0,
            ) {
                continue;
            }
            visible += 1;
            // A body that has moved between cells appears in both its old and
            // new track. The old one still holds a stale pose, so preferring
            // detail alone would read the wrong track; the freshest record wins,
            // which is the rule a real client can apply with no side channel.
            let mut best: Option<(u8, u32, Pose)> = None;
            for track in subscribed.iter() {
                let usable = joined_at.get(track).is_some_and(|from| tick.index >= *from);
                if !usable {
                    continue;
                }
                let playback = &playbacks[*track][body];
                let Some(pose) = playback.pose_at(tick.index, dt, gravity) else {
                    continue;
                };
                let Some(freshness) = playback.last_event_tick() else {
                    continue;
                };
                let level = match metas[*track].tier {
                    Tier::Coarse => 1,
                    _ => 2,
                };
                let better = match best {
                    None => true,
                    Some((best_level, best_fresh, _)) => {
                        freshness > best_fresh || (freshness == best_fresh && level > best_level)
                    }
                };
                if better {
                    best = Some((level, freshness, pose));
                }
            }
            match best {
                Some((level, _, pose)) => {
                    if level == 2 {
                        from_detail += 1;
                    } else {
                        from_coarse += 1;
                    }
                    let error = rigid_shell_error_meters(state.pose, pose, radii[body]) * 100.0;
                    error_max = error_max.max(error);
                    if (visible % 37) == 0 {
                        errors.push(error);
                    }
                }
                None => missing += 1,
            }
        }
    }

    if let Some((view, truth, _)) = replay {
        view.finish()?;
        truth.finish()?;
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p95 = if errors.is_empty() {
        0.0
    } else {
        errors[((errors.len() as f64 * 0.95) as usize).min(errors.len() - 1)]
    };
    let duration = ticks_seen as f64 / physics_hz as f64;
    let window = physics_hz as usize;
    let mut windows: Vec<f64> = Vec::new();
    for start in (0..tick_bytes.len()).step_by(window.max(1)) {
        let end = (start + window).min(tick_bytes.len());
        let sum: u64 = tick_bytes[start..end].iter().sum();
        let seconds = (end - start) as f64 / physics_hz as f64;
        windows.push(sum as f64 * 8.0 / seconds.max(1e-9) / 1.0e6);
    }
    windows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let received_avg = received_bytes as f64 * 8.0 / duration / 1.0e6;
    let p95_rate = windows
        .get(((windows.len() as f64 * 0.95) as usize).min(windows.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0.0);
    let peak_rate = windows.last().copied().unwrap_or(0.0);

    Ok(ViewerRow {
        split: split_name.to_string(),
        subscribe: subscriber.name(),
        viewer: kind.name().to_string(),
        received_bytes,
        received_mbps_avg: received_avg,
        received_mbps_p95: p95_rate,
        received_mbps_peak: peak_rate,
        tracks_avg: tracks_sum / ticks_counted.max(1) as f64,
        tracks_max,
        joins_per_min: joins as f64 / (duration / 60.0).max(1e-9),
        resync_pct: resync_bytes as f64 * 100.0 / received_bytes.max(1) as f64,
        coverage_missing_pct: missing as f64 * 100.0 / visible.max(1) as f64,
        detail_pct: from_detail as f64 * 100.0 / visible.max(1) as f64,
        coarse_pct: from_coarse as f64 * 100.0 / visible.max(1) as f64,
        visible_error_p95_cm: p95,
        visible_error_max_cm: error_max,
        meets_3mbps: p95_rate <= 3.0,
        meets_2p5mbps: p95_rate <= 2.5,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_discovery_buckets_by_cell() {
        let positions = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(95.0, 0.0, 5.0),
            Vec3::new(-10.0, 0.0, -10.0),
        ];
        let cells = GridSplit::discover(&positions, 90.0);
        assert_eq!(cells, vec![(-1, -1), (0, 0), (1, 0)]);
    }

    #[test]
    fn a_radius_subscriber_always_holds_the_coarse_floor() {
        // Coverage depends on it: without a coarse tier a viewer that subscribes
        // nothing nearby would simply lose the rest of the world.
        let split = GridSplit {
            cell_size_m: 90.0,
            cells: vec![(0, 0), (5, 5)],
            coarse_shell_cm: 4.0,
            coarse_step_exp: 4,
            coarse_max_stride: 30,
            coarse_min_radius_m: 0.0,
            coarse_flush_ms: 250.0,
        };
        let metas = split.tracks();
        let mut subscriber = RadiusSubscribe::new(50.0, 0);
        let camera = Camera {
            eye: Vec3::new(45.0, 20.0, 45.0),
            direction: Vec3::new(0.0, 0.0, 1.0),
            fov_degrees: 60.0,
        };
        let chosen = subscriber.choose(0, &camera, &metas, &[0.0; 3], 90.0, (1920, 1080));
        assert!(chosen.contains(&0), "coarse track must always be held");
        assert!(chosen.contains(&1), "the camera's own cell must be detail");
        assert!(!chosen.contains(&2), "a far cell must not be subscribed");
    }

    #[test]
    fn a_greedy_subscriber_follows_rate_not_camera() {
        let split = GridSplit {
            cell_size_m: 90.0,
            cells: vec![(0, 0), (9, 9)],
            coarse_shell_cm: 4.0,
            coarse_step_exp: 4,
            coarse_max_stride: 30,
            coarse_min_radius_m: 0.0,
            coarse_flush_ms: 250.0,
        };
        let metas = split.tracks();
        let mut subscriber = GreedyRateSubscribe::new(10.0, 0);
        let camera = Camera {
            eye: Vec3::ZERO,
            direction: Vec3::Z,
            fov_degrees: 60.0,
        };
        // The far cell is the loud one, so it wins despite the camera.
        let chosen = subscriber.choose(0, &camera, &metas, &[0.5, 0.1, 4.0], 90.0, (1920, 1080));
        assert!(chosen.contains(&2));
    }
}
