//! Offline hierarchy-root codec ablation.
//!
//! Durable topology comes from the authoritative joint/bond graph. Child-local
//! transforms are external shared manifest data addressed by stable global IDs;
//! the stream carries island-root trajectories, topology changes, and only the
//! leaf poses whose root-relative prediction would violate the shell bound.

use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{ensure, Context, Result};
use glam::{Quat, Vec3};
use serde::Serialize;

use crate::{
    codec::{decode_quat32, encode_quat32, projected_error_pixels, rigid_shell_error_meters},
    budget::{BudgetConfig, BudgetState, BudgetTelemetry},
    mask::{MaskConfig, MaskState, MaskTelemetry},
    residual_coder::{self, ResidualCoding, ResidualRecord},
    root_coder,
    symbol_audit::{bucket_log2, ResidualSymbol, RootSymbol, SymbolLog},
    interest::sphere_in_view,
    replay::ReplayWriter,
    trace::{ActorDef, Header, Pose, Tick, TraceReader},
};

const MAGIC: &[u8; 8] = b"TWHIER1\0";
const WIRE_VERSION: u32 = 8;
const POSITION_CELL_M: f32 = 32.0;
const POSITION_QUANTA: f32 = u16::MAX as f32;
const VELOCITY_STEP_MPS: f32 = 1.0 / 512.0;
const RESIDUAL_POSITION_STEP_M: f32 = 0.000_25;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
enum HierarchyTier {
    Events,
    Root,
    Residual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct HierarchyTrackKey {
    tier: HierarchyTier,
    x: i32,
    z: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct HierarchyTrackReport {
    tier: HierarchyTier,
    x: i32,
    z: i32,
    records: u64,
    raw_bytes: u64,
    modeled_compressed_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HierarchyReport {
    pub topology_available: bool,
    pub shared_manifest: bool,
    pub manifest_hash_fnv1a64: String,
    pub durable_edge_count: usize,
    pub topology_epochs: u32,
    pub broken_edge_events: u64,
    pub root_pose_records: u64,
    pub residual_pose_records: u64,
    pub omitted_child_pose_records: u64,
    pub residual_pct_of_children: f64,
    pub static_root_updates_suppressed: u64,
    pub full_root_fields: u64,
    pub position_only_root_fields: u64,
    pub rotation_only_root_fields: u64,
    pub unchanged_root_fields: u64,
    pub topology_bytes: u64,
    pub root_bytes: u64,
    pub residual_bytes: u64,
    /// Per-stream zstd sizes, measured by compressing each stream alone. The
    /// container compresses all three jointly, so these do not sum to
    /// `compressed_bytes`; they bound what replacing one stream's coder can buy.
    pub topology_zstd_bytes: u64,
    pub root_zstd_bytes: u64,
    pub residual_zstd_bytes: u64,
    pub split_zstd_total_bytes: u64,
    pub residual_share_of_split_pct: f64,
    /// [identity, quat32_delta, snorm16_delta, full] residual rotation tiers.
    pub residual_rotation_tiers: [u64; 4],
    /// Residual coder selection per GOP, and what each form would have cost.
    pub residual_rans_blocks: u64,
    pub residual_packed_blocks: u64,
    pub residual_packed_bytes: u64,
    pub residual_coded_bytes: u64,
    /// Motion-masking telemetry: how much precision was traded, and where.
    pub mask_telemetry: MaskTelemetry,
    pub mask_masked_pct: f64,
    pub mask_scale_mean: f64,
    /// Budgeted-selection outcome: how much was deferred, and how far behind.
    pub budget_candidates: u64,
    pub budget_emitted: u64,
    pub budget_deferred: u64,
    pub budget_required: u64,
    pub budget_deferred_pct: f64,
    pub budget_deferred_error_cm_p99: f64,
    pub budget_deferral_age_ticks_p99: f64,
    /// R1b: consecutive-tick residual run statistics. records/run near 1 means
    /// isolated repairs; large means per-tick streams a segment could replace.
    pub residual_runs: u64,
    pub residual_records_per_run: f64,
    pub residual_run_length_hist: [u64; 16],
    /// R1c: fitted-run length histogram (ticks, log2 buckets), weighted per island.
    pub fit_run_length_hist: [u64; 16],
    /// Root coder selection per GOP, and what each form would have cost.
    pub root_rans_blocks: u64,
    pub root_packed_blocks: u64,
    pub root_packed_bytes: u64,
    pub root_coded_bytes: u64,
    /// Awake bodies per tick: how much of the world is actually in motion.
    pub awake_bodies_mean: f64,
    pub awake_bodies_p50: u32,
    pub awake_bodies_p95: u32,
    pub awake_bodies_peak: u32,
    pub total_bodies: usize,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
    pub average_mbps: f64,
    pub selected_mode: &'static str,
    pub hierarchy_candidate_compressed_bytes: u64,
    pub hierarchy_candidate_average_mbps: f64,
    pub hierarchy_candidate_p50_gop_mbps: f64,
    pub hierarchy_candidate_p95_gop_mbps: f64,
    pub hierarchy_candidate_peak_gop_mbps: f64,
    pub hierarchy_candidate_reduction_vs_independent_pct: f64,
    pub encode_wall_ms: f64,
    pub decode_validation_wall_ms: f64,
    pub decoded_replay_frames: u32,
    pub baseline_seekable_bytes: u64,
    pub reduction_vs_independent_pct: f64,
    pub max_shell_cm: f64,
    pub post_zstd_decode_pass: bool,
    pub exact_event_pass: bool,
    pub adoption_threshold_pct: f64,
    pub adopted: bool,
    pub contact_pair_samples: u64,
    pub velocity_coherent_contact_pairs: u64,
    pub contact_cluster_adopted: bool,
    pub contact_cluster_reason: &'static str,
    pub global_track_count: usize,
    pub max_active_tracks: usize,
    pub track_reports: Vec<HierarchyTrackReport>,
}

#[derive(Clone, Debug, Serialize)]
struct HierarchyFrameTelemetry {
    route: &'static str,
    frame: u32,
    simulation_time: f64,
    active_tracks: usize,
    rolling_mbps: f64,
    visible_bodies: u64,
    missing_visible_bodies: u64,
    screen_error_px_max: f64,
    shell_error_cm_max: f64,
}

struct PendingFrameTelemetry {
    frame: u32,
    simulation_time: f64,
    visible_bodies: u64,
    screen_error_px_max: f64,
    shell_error_cm_max: f64,
}

#[derive(Default)]
pub(crate) struct Counters {
    pub(crate) topology_epochs: u32,
    pub(crate) broken_edge_events: u64,
    pub(crate) root_pose_records: u64,
    pub(crate) residual_pose_records: u64,
    pub(crate) omitted_child_pose_records: u64,
    pub(crate) static_root_updates_suppressed: u64,
    pub(crate) full_root_fields: u64,
    pub(crate) position_only_root_fields: u64,
    pub(crate) rotation_only_root_fields: u64,
    pub(crate) unchanged_root_fields: u64,
    pub(crate) topology_bytes: u64,
    pub(crate) root_bytes: u64,
    pub(crate) residual_bytes: u64,
    // Per-stream zstd sizes. The shipped container compresses the whole payload
    // as one blob, so these are measurement only: they attribute the compressed
    // total to topology/roots/residuals, which is what bounds any coder that
    // replaces a single stream. They do not sum to `compressed_bytes`.
    pub(crate) topology_zstd_bytes: u64,
    pub(crate) root_zstd_bytes: u64,
    pub(crate) residual_zstd_bytes: u64,
    /// Residual rotation tier census: identity / quat32-delta / snorm16-delta / full.
    pub(crate) residual_rotation_tiers: [u64; 4],
    /// Populated only when a symbol-entropy audit was requested.
    pub(crate) symbols: Option<SymbolLog>,
    /// Residual coder selection: how each GOP's residual block was emitted.
    pub(crate) residual_rans_blocks: u64,
    pub(crate) residual_packed_blocks: u64,
    pub(crate) residual_packed_bytes: u64,
    pub(crate) residual_coded_bytes: u64,
    /// Motion-masking telemetry.
    pub(crate) mask_telemetry: MaskTelemetry,
    /// Budgeted-selection telemetry.
    pub(crate) budget_telemetry: BudgetTelemetry,
    /// R1a: one row per encoded block -- raw stream splits and record counts,
    /// so peak blocks can be attributed to a stream rather than guessed at.
    pub(crate) block_rows: Vec<BlockRow>,
    /// R1b: histogram of consecutive-tick residual run lengths per body,
    /// log2-bucketed. Long runs are per-tick repair streams that a single
    /// independent segment could replace.
    pub(crate) residual_run_lengths: [u64; 16],
    pub(crate) residual_runs: u64,
    /// R1b scratch: last residual tick + current run length per actor.
    pub(crate) residual_run_state: Vec<(u32, u32)>,
    /// R1c: histogram of fitted-run lengths in ticks, log2-bucketed. Short
    /// runs during the burst are the global-split fragmentation signature.
    pub(crate) fit_run_lengths: [u64; 16],
    /// Root coder selection per GOP, and what each form would have cost.
    pub(crate) root_rans_blocks: u64,
    pub(crate) root_packed_blocks: u64,
    pub(crate) root_packed_bytes: u64,
    pub(crate) root_coded_bytes: u64,
    /// Awake (non-sleeping) body count per tick, for capacity reporting.
    pub(crate) awake_per_tick: Vec<u32>,
    pub(crate) contact_pair_samples: u64,
    pub(crate) velocity_coherent_contact_pairs: u64,
    pub(crate) max_shell_m: f32,
}

/// R1a: per-block accounting row.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub(crate) struct BlockRow {
    pub(crate) start_tick: u32,
    pub(crate) ticks: u32,
    pub(crate) keyframe: bool,
    pub(crate) topology_raw: u64,
    pub(crate) root_raw: u64,
    pub(crate) residual_raw: u64,
    pub(crate) root_records: u64,
    pub(crate) residual_records: u64,
    pub(crate) compressed: u64,
}

impl Counters {
    /// Closes any still-open residual runs so the histogram covers the tail.
    pub(crate) fn flush_residual_runs(&mut self) {
        for index in 0..self.residual_run_state.len() {
            let (_, length) = self.residual_run_state[index];
            if length > 0 {
                self.residual_run_lengths[bucket_log2(length).min(15) as usize] += 1;
                self.residual_runs += 1;
            }
            self.residual_run_state[index] = (u32::MAX, 0);
        }
    }
}

#[derive(Default)]
pub(crate) struct TrackCounter {
    records: u64,
    raw_bytes: u64,
}

pub struct HierarchyConfig {
    /// Cap on trajectory-span length in ticks; 0 leaves spans bounded only by
    /// the block. Separates span length from block length.
    pub max_span_ticks: usize,
    pub symbol_audit: bool,
    /// Motion-masked per-body precision.
    pub mask: MaskConfig,
    /// Budgeted selection of repairs.
    pub budget: BudgetConfig,
    /// Entropy-code the root-segment block when it comes out smaller.
    pub root_rans: bool,
    /// Opt-in: entropy-code the residual block instead of packing bytes.
    pub residual_rans: bool,
    pub shell_bound_m: f32,
    pub gop_ticks: u32,
    pub cell_size_m: f32,
    pub target_tracks: usize,
    pub baseline_seekable_bytes: u64,
}

struct DeliverySelection {
    mode: &'static str,
    compressed_bytes: u64,
    reduction_pct: f64,
    hierarchy_adopted: bool,
}

fn select_delivery(
    hierarchy_bytes: u64,
    independent_bytes: u64,
    topology_available: bool,
    post_decode_pass: bool,
) -> DeliverySelection {
    let hierarchy_reduction = if independent_bytes == 0 {
        0.0
    } else {
        100.0 * (1.0 - hierarchy_bytes as f64 / independent_bytes as f64)
    };
    // Deliver hierarchy whenever it is strictly smaller and gate-valid. Adopt
    // it as the preferred codec only at the plan's 30% threshold. Otherwise
    // fall back so the delivered size never exceeds the independent archive.
    let hierarchy_beats_independent =
        post_decode_pass && (independent_bytes == 0 || hierarchy_bytes < independent_bytes);
    let hierarchy_adopted =
        topology_available && hierarchy_beats_independent && hierarchy_reduction >= 30.0;
    if hierarchy_beats_independent {
        DeliverySelection {
            mode: if hierarchy_adopted {
                "hierarchy"
            } else {
                "hierarchy_partial"
            },
            compressed_bytes: hierarchy_bytes,
            reduction_pct: hierarchy_reduction,
            hierarchy_adopted,
        }
    } else {
        DeliverySelection {
            mode: "independent_fallback",
            compressed_bytes: independent_bytes,
            reduction_pct: 0.0,
            hierarchy_adopted: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PositionModel {
    Hold,
    Linear,
    Ballistic,
    Hermite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RotationModel {
    Hold,
    Slerp,
}

#[derive(Clone, Copy, Debug)]
struct RootSample {
    tick: u32,
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    sleeping: bool,
}

#[derive(Clone, Debug)]
struct RootSegment {
    root: u32,
    start_tick: u32,
    end_tick: u32,
    position_model: PositionModel,
    rotation_model: RotationModel,
    start_pose: Pose,
    end_pose: Pose,
    start_velocity: Vec3,
    end_velocity: Vec3,
    rotation_full_precision: bool,
    #[allow(dead_code)]
    encoded_bytes: usize,
}

#[derive(Clone, Copy, Debug)]
enum ResidualPosition {
    Delta([i16; 3]),
    Absolute(Vec3),
}

/// Rotation repairs are coded *against the prediction*, cheapest tier first.
/// A residual is usually triggered by position drift, so the predicted
/// orientation is frequently already inside the shell bound and costs a tag.
#[derive(Clone, Copy, Debug)]
enum ResidualRotation {
    /// The predicted rotation already fits; no payload.
    Identity,
    /// 32-bit smallest-three of `predicted.inverse() * truth`.
    Quat32Delta(u32),
    /// snorm16 of `predicted.inverse() * truth`.
    Snorm16Delta([i16; 4]),
    /// Absolute full-precision escape hatch.
    Full(Quat),
}

#[derive(Clone, Copy, Debug)]
struct PackedResidual {
    position: ResidualPosition,
    rotation: ResidualRotation,
}

impl PackedResidual {
    fn pose(self, predicted: Pose) -> Pose {
        let position = match self.position {
            ResidualPosition::Delta(delta) => {
                predicted.position
                    + Vec3::new(delta[0] as f32, delta[1] as f32, delta[2] as f32)
                        * RESIDUAL_POSITION_STEP_M
            }
            ResidualPosition::Absolute(position) => position,
        };
        let base = predicted.rotation.normalize();
        let rotation = match self.rotation {
            ResidualRotation::Identity => base,
            ResidualRotation::Quat32Delta(packed) => (base * decode_quat32(packed)).normalize(),
            ResidualRotation::Snorm16Delta(components) => {
                (base
                    * Quat::from_xyzw(
                        components[0] as f32 / i16::MAX as f32,
                        components[1] as f32 / i16::MAX as f32,
                        components[2] as f32 / i16::MAX as f32,
                        components[3] as f32 / i16::MAX as f32,
                    )
                    .normalize())
                .normalize()
            }
            ResidualRotation::Full(rotation) => rotation,
        };
        Pose { position, rotation }
    }
}

impl RootSegment {
    fn pose_at(&self, tick: u32, hz: u32, gravity: Vec3) -> Pose {
        let duration_ticks = self.end_tick.saturating_sub(self.start_tick).max(1);
        let alpha = (tick.saturating_sub(self.start_tick) as f32) / duration_ticks as f32;
        let position = match self.position_model {
            PositionModel::Hold => self.start_pose.position,
            PositionModel::Linear => self.start_pose.position.lerp(self.end_pose.position, alpha),
            PositionModel::Ballistic => {
                let dt = tick.saturating_sub(self.start_tick) as f32 / hz as f32;
                self.start_pose.position + self.start_velocity * dt + gravity * (0.5 * dt * dt)
            }
            PositionModel::Hermite => hermite(
                self.start_pose.position,
                self.end_pose.position,
                self.start_velocity,
                self.end_velocity,
                alpha,
                duration_ticks as f32 / hz as f32,
            ),
        };
        let rotation = match self.rotation_model {
            RotationModel::Hold => self.start_pose.rotation,
            RotationModel::Slerp => self
                .start_pose
                .rotation
                .slerp(self.end_pose.rotation, alpha)
                .normalize(),
        };
        Pose { position, rotation }
    }
}

/// Velocity a segment's motion model implies at its own end tick -- the
/// natural continuity prediction for the *next* same-root segment's start
/// velocity/end-position, since that is the instant the two segments meet.
fn prev_boundary_velocity(segment: &RootSegment, hz: u32, gravity: Vec3) -> Vec3 {
    let duration_ticks = segment.end_tick.saturating_sub(segment.start_tick);
    let dt = duration_ticks as f32 / hz.max(1) as f32;
    match segment.position_model {
        PositionModel::Hold => Vec3::ZERO,
        PositionModel::Linear => {
            if dt > 0.0 {
                (segment.end_pose.position - segment.start_pose.position) / dt
            } else {
                Vec3::ZERO
            }
        }
        PositionModel::Ballistic => segment.start_velocity + gravity * dt,
        PositionModel::Hermite => segment.end_velocity,
    }
}

/// Receiver-visible topology state carried across stream blocks: the island
/// map and the literal decoded child-local transforms. The encoder maintains
/// an identical copy so residual decisions match what the receiver holds.
#[derive(Clone, Debug, Default)]
pub(crate) struct TopologyState {
    pub(crate) roots: Vec<u32>,
    pub(crate) locals: Vec<Pose>,
    /// Last trajectory segment emitted for each root, carried across delta
    /// blocks so the first segment of a root in the next block can be coded
    /// against it instead of absolutely. Without this, every root pays a full
    /// absolute position and rotation at every block boundary -- measured as
    /// the bulk of the 7% gap between 250 ms and 500 ms blocks, which is a
    /// boundary artifact rather than a latency cost. Keyframes clear it, as
    /// they do the rest of the carried state.
    pub(crate) last_segments: BTreeMap<u32, RootSegment>,
}

/// How a GOP block anchors receiver state.
pub(crate) enum BlockMode<'a> {
    /// Seekable archive block: full island map + locals header, no stream
    /// framing byte. Byte-identical to wire v4.
    Archive,
    /// Live stream block that re-anchors the receiver (bootstrap/recovery):
    /// carries the full map + locals and overwrites the carried state.
    StreamKeyframe(&'a mut TopologyState),
    /// Live stream block that extends carried receiver state; topology arrives
    /// as events only, including block-boundary ticks.
    StreamDelta(&'a mut TopologyState),
}

pub(crate) struct GopEvent {
    pub(crate) rel_tick: u32,
    pub(crate) epoch: u32,
    pub(crate) broken: Vec<u64>,
    pub(crate) changed: Vec<(u32, u32, Pose)>,
}

/// A parsed GOP block. Reconstruction is pure: it reads only wire data plus
/// the carried [`TopologyState`], never ground truth.
pub(crate) struct DecodedGop {
    pub(crate) start_tick: u32,
    pub(crate) tick_count: u32,
    pub(crate) keyframe: bool,
    header_roots: Vec<u32>,
    header_locals: Vec<Pose>,
    events: Vec<GopEvent>,
    segments: Vec<RootSegment>,
    segment_index: BTreeMap<u32, Vec<usize>>,
    residuals: BTreeMap<(u32, usize), PackedResidual>,
}

pub(crate) fn decode_gop_block(
    payload: &[u8],
    actor_count: usize,
    rest_poses: &[Pose],
    expected_epoch_anchors: bool,
    stream: bool,
    hz: u32,
    gravity: Vec3,
    carried: &TopologyState,
) -> Result<DecodedGop> {
    let mut reader = Reader::new(payload);
    let start_tick = reader.u32()?;
    let tick_count = reader.u32()?;
    let wire_actor_count = reader.u32()? as usize;
    ensure!(
        wire_actor_count == actor_count,
        "hierarchy actor count mismatch"
    );
    let keyframe = if stream { reader.u8()? != 0 } else { true };
    let mut header_roots = Vec::new();
    let mut header_locals = Vec::new();
    let epoch_anchors;
    if keyframe {
        header_roots.reserve(actor_count);
        for _ in 0..actor_count {
            let root = reader.var_u32()?;
            ensure!(
                root < actor_count as u32,
                "hierarchy root actor out of range"
            );
            header_roots.push(root);
        }
        epoch_anchors = reader.u8()? != 0;
        ensure!(
            epoch_anchors == expected_epoch_anchors,
            "hierarchy epoch-anchor mode mismatch"
        );
        header_locals.reserve(actor_count);
        if epoch_anchors {
            for _ in 0..actor_count {
                header_locals.push(reader.compact_pose()?);
            }
        } else {
            for (actor, &root) in header_roots.iter().enumerate() {
                header_locals.push(relative_pose(rest_poses[root as usize], rest_poses[actor]));
            }
        }
    } else {
        epoch_anchors = reader.u8()? != 0;
        ensure!(
            epoch_anchors == expected_epoch_anchors,
            "hierarchy epoch-anchor mode mismatch"
        );
    }

    let event_count = reader.u32()? as usize;
    let mut events = Vec::with_capacity(event_count);
    for _ in 0..event_count {
        let rel_tick = reader.var_u32()?;
        let epoch = reader.u32()?;
        let broken_count = reader.u32()? as usize;
        let mut broken = Vec::with_capacity(broken_count);
        for _ in 0..broken_count {
            broken.push(reader.u64()?);
        }
        let changed_count = reader.u32()? as usize;
        let mut changed = Vec::with_capacity(changed_count);
        for _ in 0..changed_count {
            let actor = reader.var_u32()?;
            let root = reader.var_u32()?;
            ensure!(
                actor < actor_count as u32 && root < actor_count as u32,
                "hierarchy changed-root actor out of range"
            );
            let local = if epoch_anchors {
                reader.compact_pose()?
            } else {
                relative_pose(rest_poses[root as usize], rest_poses[actor as usize])
            };
            changed.push((actor, root, local));
        }
        events.push(GopEvent {
            rel_tick,
            epoch,
            broken,
            changed,
        });
    }

    // A keyframe re-anchors everything, so it never continues carried
    // segments; delta blocks do.
    let carried_segments: BTreeMap<u32, RootSegment> = if keyframe {
        BTreeMap::new()
    } else {
        carried.last_segments.clone()
    };
    let segment_count = reader.u32()? as usize;
    let segments = match reader.u8()? {
        0 => read_root_segments(
            &mut reader,
            segment_count,
            start_tick,
            actor_count,
            hz,
            gravity,
            &carried_segments,
        )?,
        1 => {
            let length = reader.u32()? as usize;
            let packed = root_coder::decode(reader.take(length)?, segment_count)?;
            let mut packed_reader = Reader::new(&packed);
            let segments = read_root_segments(
                &mut packed_reader,
                segment_count,
                start_tick,
                actor_count,
                hz,
                gravity,
                &carried_segments,
            )?;
            ensure!(
                packed_reader.is_empty(),
                "trailing hierarchy root block bytes"
            );
            segments
        }
        tag => anyhow::bail!("unknown hierarchy root coder tag {tag}"),
    };
    let mut segment_index = BTreeMap::<u32, Vec<usize>>::new();
    for (index, segment) in segments.iter().enumerate() {
        segment_index.entry(segment.root).or_default().push(index);
    }

    let residual_count = reader.u32()? as usize;
    let mut residuals = BTreeMap::<(u32, usize), PackedResidual>::new();
    match reader.u8()? {
        // rANS-coded block.
        1 => {
            let length = reader.u32()? as usize;
            let bytes = reader.take(length)?;
            for record in residual_coder::decode(bytes, residual_count)? {
                ensure!(
                    (record.actor as usize) < actor_count,
                    "hierarchy residual actor out of range"
                );
                residuals.insert(
                    (start_tick + record.rel_tick, record.actor as usize),
                    packed_from_coding(record.coding)?,
                );
            }
        }
        // Packed byte form. Mirrors the encoder: within one tick an actor is a
        // gap from its predecessor, and the first record of a tick is absolute.
        0 => {
            let mut previous_rel = u32::MAX;
            let mut previous_actor = 0_u32;
            for _ in 0..residual_count {
                let rel = reader.var_u32()?;
                let coded = reader.var_u32()?;
                let actor = if rel == previous_rel {
                    previous_actor
                        .checked_add(coded)
                        .and_then(|actor| actor.checked_add(1))
                        .context("hierarchy residual actor gap overflow")?
                } else {
                    coded
                };
                ensure!(
                    (actor as usize) < actor_count,
                    "hierarchy residual actor out of range"
                );
                previous_rel = rel;
                previous_actor = actor;
                residuals.insert((start_tick + rel, actor as usize), reader.packed_residual()?);
            }
        }
        tag => anyhow::bail!("unknown hierarchy residual coder tag {tag}"),
    }
    ensure!(reader.is_empty(), "trailing hierarchy GOP payload");
    Ok(DecodedGop {
        start_tick,
        tick_count,
        keyframe,
        header_roots,
        header_locals,
        events,
        segments,
        segment_index,
        residuals,
    })
}

impl DecodedGop {
    /// Applies the keyframe header (if any) to the carried state. Must run
    /// before the first `apply_tick_events`/`reconstruct_actor` of the block.
    pub(crate) fn begin(&self, state: &mut TopologyState) -> Result<()> {
        if self.keyframe {
            state.roots = self.header_roots.clone();
            state.locals = self.header_locals.clone();
        }
        ensure!(
            state.roots.len() == state.locals.len() && !state.roots.is_empty(),
            "hierarchy stream block decoded without carried topology state"
        );
        // Carry this block's tail segment per root, so the next delta block can
        // code its first record for that root against it. Mirrors what the
        // encoder stores; the two must stay identical or continuity decoding
        // diverges.
        state.last_segments.clear();
        for segment in &self.segments {
            state
                .last_segments
                .entry(segment.root)
                .and_modify(|existing| {
                    if segment.start_tick >= existing.start_tick {
                        *existing = segment.clone();
                    }
                })
                .or_insert_with(|| segment.clone());
        }
        Ok(())
    }

    /// Applies this tick's topology events and returns them for inspection.
    pub(crate) fn apply_tick_events(
        &self,
        state: &mut TopologyState,
        local_tick: u32,
    ) -> &[GopEvent] {
        let begin = self
            .events
            .partition_point(|event| event.rel_tick < local_tick);
        let end = self
            .events
            .partition_point(|event| event.rel_tick <= local_tick);
        for event in &self.events[begin..end] {
            for &(actor, root, local) in &event.changed {
                state.roots[actor as usize] = root;
                state.locals[actor as usize] = local;
            }
        }
        &self.events[begin..end]
    }

    fn segment_pose(&self, tick: u32, actor: u32, hz: u32, gravity: Vec3) -> Option<Pose> {
        self.segment_index.get(&actor).and_then(|indices| {
            indices
                .iter()
                .map(|&index| &self.segments[index])
                .find(|segment| tick >= segment.start_tick && tick <= segment.end_tick)
                .map(|segment| segment.pose_at(tick, hz, gravity))
        })
    }

    /// Reconstructs one actor at one tick from wire data + carried state.
    pub(crate) fn reconstruct_actor(
        &self,
        state: &TopologyState,
        tick: u32,
        actor: usize,
        hz: u32,
        gravity: Vec3,
    ) -> Result<Pose> {
        let predicted = if let Some(own) = self.segment_pose(tick, actor as u32, hz, gravity) {
            own
        } else {
            let root = state.roots[actor];
            let root_pose = self
                .segment_pose(tick, root, hz, gravity)
                .with_context(|| {
                    format!(
                        "missing encoded hierarchy root pose at tick {tick}, actor {actor}, root {root}"
                    )
                })?;
            compose_pose(root_pose, state.locals[actor])
        };
        Ok(self
            .residuals
            .get(&(tick, actor))
            .map(|residual| residual.pose(predicted))
            .unwrap_or(predicted))
    }

    /// True when the actor's pose this tick came from a Hold segment (its own
    /// or its root's) with no residual — i.e. the wire carried no new motion.
    pub(crate) fn is_hold_tick(&self, state: &TopologyState, tick: u32, actor: usize) -> bool {
        if self.residuals.contains_key(&(tick, actor)) {
            return false;
        }
        let lookup = |target: u32| {
            self.segment_index.get(&target).and_then(|indices| {
                indices
                    .iter()
                    .map(|&index| &self.segments[index])
                    .find(|segment| tick >= segment.start_tick && tick <= segment.end_tick)
            })
        };
        let segment = lookup(actor as u32).or_else(|| lookup(state.roots[actor]));
        segment.is_some_and(|segment| {
            matches!(segment.position_model, PositionModel::Hold)
                && matches!(segment.rotation_model, RotationModel::Hold)
        })
    }
}

pub fn evaluate(
    trace_path: &Path,
    out_dir: &Path,
    actors: &[ActorDef],
    config: HierarchyConfig,
) -> Result<HierarchyReport> {
    let mut manifest_trace = TraceReader::open(trace_path)?;
    ensure!(
        manifest_trace.actors.len() == actors.len(),
        "hierarchy actor table mismatch"
    );
    let topology_available = !manifest_trace.topology.edges.is_empty();
    // Approximate D6 assemblies and post-break membership need locals rebaked
    // at epoch boundaries. Exact Blast-style bonds (kind=2) keep shared
    // rest-pose locals from the pre-fractured manifest.
    let epoch_anchors = manifest_trace
        .topology
        .edges
        .iter()
        .any(|edge| edge.kind != 2);
    let global_ids = manifest_trace.topology.actor_global_ids.clone();
    let durable_edge_count = manifest_trace.topology.edges.len();
    let header = manifest_trace.header.clone();
    let first_tick = manifest_trace
        .next_tick()?
        .context("hierarchy trace has no ticks")?;
    let rest_poses: Vec<_> = first_tick.states.iter().map(|state| state.pose).collect();
    let manifest_hash = manifest_hash(&global_ids, &rest_poses, &manifest_trace.topology.edges);
    drop(manifest_trace);

    let path = out_dir.join("hierarchy.twhier.zstblocks");
    let mut writer = BufWriter::new(File::create(&path)?);
    writer.write_all(MAGIC)?;
    writer.write_all(&WIRE_VERSION.to_le_bytes())?;
    writer.write_all(&(actors.len() as u32).to_le_bytes())?;
    writer.write_all(&header.physics_hz.to_le_bytes())?;
    writer.write_all(&header.tick_count.to_le_bytes())?;
    writer.write_all(&config.gop_ticks.to_le_bytes())?;
    writer.write_all(&manifest_hash.to_le_bytes())?;

    let mut trace = TraceReader::open(trace_path)?;
    let mut counters = Counters::default();
    let mut mask_state = MaskState::default();
    let mut budget_state = BudgetState::default();
    if config.symbol_audit {
        counters.symbols = Some(SymbolLog::default());
    }
    let mut tracks = BTreeMap::<HierarchyTrackKey, TrackCounter>::new();
    let mut compressed_bytes = 36_u64;
    let mut uncompressed_bytes = 36_u64;
    let duration = header.tick_count as f64 / header.physics_hz as f64;
    let gop_count = header.tick_count.div_ceil(config.gop_ticks);
    let mut gop_compressed_bytes = Vec::with_capacity(gop_count as usize);
    let mut replay = ReplayWriter::create(
        &out_dir.join("hierarchy-reconstructed.towerstate"),
        &header,
        actors,
        30,
    )?;
    let mut frame_telemetry = Vec::new();
    let mut last_output_frame = None;
    let mut encode_wall = Duration::ZERO;
    let mut decode_validation_wall = Duration::ZERO;
    let mut decode_state = TopologyState::default();

    for gop in 0..gop_count {
        let mut ticks = Vec::with_capacity(config.gop_ticks as usize);
        for _ in 0..config.gop_ticks {
            if let Some(tick) = trace.next_tick()? {
                ticks.push(tick);
            } else {
                break;
            }
        }
        if ticks.is_empty() {
            break;
        }
        let encode_start = Instant::now();
        let payload = encode_gop_block(
            &ticks,
            &rest_poses,
            actors,
            header.physics_hz,
            header.gravity,
            &config,
            epoch_anchors,
            BlockMode::Archive,
            &mut counters,
            &mut tracks,
            &mut mask_state,
            &mut budget_state,
        )?;
        let compressed = zstd::bulk::compress(&payload, 3)?;
        if let Some(row) = counters.block_rows.last_mut() {
            row.compressed = compressed.len() as u64 + 12;
        }
        budget_state.observe_block(
            &config.budget,
            ticks.len() as f64 / header.physics_hz.max(1) as f64,
            payload.len() as u64,
            compressed.len() as u64,
        );
        encode_wall += encode_start.elapsed();
        let decode_start = Instant::now();
        validate_gop(
            &zstd::bulk::decompress(&compressed, payload.len())?,
            &ticks,
            &rest_poses,
            actors,
            header.physics_hz,
            header.gravity,
            // Masked bodies sit above the base bound, and deferred repairs sit
            // above that again, so the hard gate is the loosest error the
            // combined policy can ever leave on screen.
            config.mask.ceiling_m() * config.budget.hard_cap_factor.max(1.0),
            epoch_anchors,
            false,
            &mut decode_state,
            &mut counters,
            &mut replay,
            &mut frame_telemetry,
            &mut last_output_frame,
            &header,
        )?;
        decode_validation_wall += decode_start.elapsed();
        writer.write_all(&gop.to_le_bytes())?;
        writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        writer.write_all(&(compressed.len() as u32).to_le_bytes())?;
        writer.write_all(&compressed)?;
        let block_bytes = compressed.len() as u64 + 12;
        gop_compressed_bytes.push(block_bytes);
        compressed_bytes += block_bytes;
        uncompressed_bytes += payload.len() as u64 + 12;
    }
    writer.flush()?;
    replay.finish()?;
    trace.finish()?;

    let compression_ratio = compressed_bytes as f64 / uncompressed_bytes.max(1) as f64;
    let track_reports: Vec<_> = tracks
        .into_iter()
        .map(|(key, value)| HierarchyTrackReport {
            tier: key.tier,
            x: key.x,
            z: key.z,
            records: value.records,
            raw_bytes: value.raw_bytes,
            modeled_compressed_bytes: (value.raw_bytes as f64 * compression_ratio).ceil() as u64,
        })
        .collect();
    write_track_csv(out_dir.join("hierarchy_tracks.csv"), &track_reports)?;
    let child_samples = counters.residual_pose_records + counters.omitted_child_pose_records;
    let hierarchy_candidate_reduction = if config.baseline_seekable_bytes == 0 {
        0.0
    } else {
        100.0 * (1.0 - compressed_bytes as f64 / config.baseline_seekable_bytes.max(1) as f64)
    };
    // Masked bodies may legitimately exceed the base bound, so the pass check
    // is against the loosest bound the policy can emit. Whether that policy is
    // perceptually acceptable is decided by the artifact gates, not this one.
    let post_zstd_decode_pass = counters.max_shell_m
        <= config.mask.ceiling_m() * config.budget.hard_cap_factor.max(1.0) * 1.000_01;
    let delivery = select_delivery(
        compressed_bytes,
        config.baseline_seekable_bytes,
        topology_available,
        post_zstd_decode_pass,
    );
    let global_track_count = track_reports.len();
    let max_active_tracks = global_track_count.min(config.target_tracks);
    let hierarchy_candidate_average_mbps = compressed_bytes as f64 * 8.0 / duration / 1_000_000.0;
    let gop_seconds = config.gop_ticks as f64 / header.physics_hz as f64;
    let mut sorted_gop_bytes = gop_compressed_bytes.clone();
    sorted_gop_bytes.sort_unstable();
    let gop_mbps = |bytes: u64| bytes as f64 * 8.0 / gop_seconds / 1_000_000.0;
    let hierarchy_candidate_p50_gop_mbps = gop_mbps(percentile_u64(&sorted_gop_bytes, 0.50));
    let hierarchy_candidate_p95_gop_mbps = gop_mbps(percentile_u64(&sorted_gop_bytes, 0.95));
    let hierarchy_candidate_peak_gop_mbps = gop_mbps(sorted_gop_bytes.last().copied().unwrap_or(0));
    let average_mbps = delivery.compressed_bytes as f64 * 8.0 / duration / 1_000_000.0;
    write_frame_telemetry_csv(
        out_dir.join("hierarchy_frame_telemetry.csv"),
        &frame_telemetry,
        max_active_tracks,
        &gop_compressed_bytes,
        config.gop_ticks,
        header.physics_hz,
    )?;
    counters.flush_residual_runs();
    let mut awake = std::mem::take(&mut counters.awake_per_tick);
    awake.sort_unstable();
    let split_zstd_total =
        counters.topology_zstd_bytes + counters.root_zstd_bytes + counters.residual_zstd_bytes;
    if let Some(log) = counters.symbols.as_ref() {
        let report = crate::symbol_audit::audit(
            log,
            counters.residual_bytes,
            counters.residual_zstd_bytes,
            counters.root_bytes,
            counters.root_zstd_bytes,
        );
        let path = out_dir.join("symbol_audit.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&report)?)
            .with_context(|| format!("write {}", path.display()))?;
    }
    Ok(HierarchyReport {
        topology_available,
        shared_manifest: true,
        manifest_hash_fnv1a64: format!("{manifest_hash:016x}"),
        durable_edge_count,
        topology_epochs: counters.topology_epochs,
        broken_edge_events: counters.broken_edge_events,
        root_pose_records: counters.root_pose_records,
        residual_pose_records: counters.residual_pose_records,
        omitted_child_pose_records: counters.omitted_child_pose_records,
        residual_pct_of_children: if child_samples == 0 {
            0.0
        } else {
            counters.residual_pose_records as f64 * 100.0 / child_samples as f64
        },
        static_root_updates_suppressed: counters.static_root_updates_suppressed,
        full_root_fields: counters.full_root_fields,
        position_only_root_fields: counters.position_only_root_fields,
        rotation_only_root_fields: counters.rotation_only_root_fields,
        unchanged_root_fields: counters.unchanged_root_fields,
        topology_bytes: counters.topology_bytes,
        root_bytes: counters.root_bytes,
        residual_bytes: counters.residual_bytes,
        topology_zstd_bytes: counters.topology_zstd_bytes,
        root_zstd_bytes: counters.root_zstd_bytes,
        residual_zstd_bytes: counters.residual_zstd_bytes,
        split_zstd_total_bytes: split_zstd_total,
        residual_rotation_tiers: counters.residual_rotation_tiers,
        residual_rans_blocks: counters.residual_rans_blocks,
        residual_packed_blocks: counters.residual_packed_blocks,
        residual_packed_bytes: counters.residual_packed_bytes,
        residual_coded_bytes: counters.residual_coded_bytes,
        mask_masked_pct: counters.mask_telemetry.masked_pct(),
        mask_scale_mean: counters.mask_telemetry.scale_mean(),
        budget_candidates: counters.budget_telemetry.candidates,
        budget_emitted: counters.budget_telemetry.emitted,
        budget_deferred: counters.budget_telemetry.deferred,
        budget_required: counters.budget_telemetry.required,
        budget_deferred_pct: counters.budget_telemetry.deferred_pct(),
        budget_deferred_error_cm_p99: counters.budget_telemetry.quantile_error(0.99) * 100.0,
        budget_deferral_age_ticks_p99: counters.budget_telemetry.quantile_age(0.99),
        residual_runs: counters.residual_runs,
        residual_records_per_run: if counters.residual_runs == 0 {
            0.0
        } else {
            counters.residual_pose_records as f64 / counters.residual_runs as f64
        },
        residual_run_length_hist: counters.residual_run_lengths,
        fit_run_length_hist: counters.fit_run_lengths,
        mask_telemetry: counters.mask_telemetry.clone(),
        root_rans_blocks: counters.root_rans_blocks,
        root_packed_blocks: counters.root_packed_blocks,
        root_packed_bytes: counters.root_packed_bytes,
        root_coded_bytes: counters.root_coded_bytes,
        awake_bodies_mean: if awake.is_empty() {
            0.0
        } else {
            awake.iter().map(|&n| n as f64).sum::<f64>() / awake.len() as f64
        },
        awake_bodies_p50: quantile_u32(&awake, 0.50),
        awake_bodies_p95: quantile_u32(&awake, 0.95),
        awake_bodies_peak: awake.last().copied().unwrap_or(0),
        total_bodies: actors.len(),
        residual_share_of_split_pct: if split_zstd_total == 0 {
            0.0
        } else {
            100.0 * counters.residual_zstd_bytes as f64 / split_zstd_total as f64
        },
        uncompressed_bytes,
        compressed_bytes: delivery.compressed_bytes,
        average_mbps,
        selected_mode: delivery.mode,
        hierarchy_candidate_compressed_bytes: compressed_bytes,
        hierarchy_candidate_average_mbps,
        hierarchy_candidate_p50_gop_mbps,
        hierarchy_candidate_p95_gop_mbps,
        hierarchy_candidate_peak_gop_mbps,
        hierarchy_candidate_reduction_vs_independent_pct: hierarchy_candidate_reduction,
        encode_wall_ms: encode_wall.as_secs_f64() * 1000.0,
        decode_validation_wall_ms: decode_validation_wall.as_secs_f64() * 1000.0,
        decoded_replay_frames: frame_telemetry.len() as u32,
        baseline_seekable_bytes: config.baseline_seekable_bytes,
        reduction_vs_independent_pct: delivery.reduction_pct,
        max_shell_cm: counters.max_shell_m as f64 * 100.0,
        post_zstd_decode_pass,
        exact_event_pass: true,
        adoption_threshold_pct: 30.0,
        adopted: delivery.hierarchy_adopted,
        contact_pair_samples: counters.contact_pair_samples,
        velocity_coherent_contact_pairs: counters.velocity_coherent_contact_pairs,
        contact_cluster_adopted: false,
        contact_cluster_reason: "contact coherence is measured separately from durable topology; no ephemeral cluster is adopted without a post-decode net byte win",
        global_track_count,
        max_active_tracks,
        track_reports,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn encode_gop_block(
    ticks: &[Tick],
    rest_poses: &[Pose],
    actors: &[ActorDef],
    hz: u32,
    gravity: Vec3,
    config: &HierarchyConfig,
    epoch_anchors: bool,
    mode: BlockMode<'_>,
    counters: &mut Counters,
    tracks: &mut BTreeMap<HierarchyTrackKey, TrackCounter>,
    mask_state: &mut MaskState,
    budget_state: &mut BudgetState,
) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    let first = &ticks[0];
    // Per-body shell bounds for this block. Encoder-side only: the receiver
    // applies whatever repairs arrive and never needs to know the bound.
    let bounds = mask_state.bounds_for_block(
        ticks,
        actors,
        &config.mask,
        &mut counters.mask_telemetry,
    );
    write_u32(&mut payload, first.index);
    write_u32(&mut payload, ticks.len() as u32);
    write_u32(&mut payload, actors.len() as u32);
    let archive_mode = matches!(mode, BlockMode::Archive);
    let (keyframe, carried) = match mode {
        BlockMode::Archive => (true, None),
        BlockMode::StreamKeyframe(state) => {
            payload.push(1);
            (true, Some(state))
        }
        BlockMode::StreamDelta(state) => {
            payload.push(0);
            (false, Some(state))
        }
    };
    let mut current_locals: Vec<Pose>;
    if keyframe {
        for &root in &first.topology.island_roots {
            write_var_u32(&mut payload, root);
        }
        payload.push(u8::from(epoch_anchors));
        current_locals = first
            .topology
            .island_roots
            .iter()
            .enumerate()
            .map(|(actor, &root)| {
                let root = root as usize;
                if epoch_anchors {
                    relative_pose(first.states[root].pose, first.states[actor].pose)
                } else {
                    relative_pose(rest_poses[root], rest_poses[actor])
                }
            })
            .collect();
        if epoch_anchors {
            for (actor, local) in current_locals.iter_mut().enumerate() {
                *local = write_compact_pose(
                    &mut payload,
                    *local,
                    actors[actor].bounding_radius,
                    config.shell_bound_m * 0.5,
                );
            }
        }
    } else {
        payload.push(u8::from(epoch_anchors));
        let state = carried
            .as_ref()
            .expect("delta block always carries topology state");
        ensure!(
            state.locals.len() == actors.len() && state.roots.len() == actors.len(),
            "hierarchy delta block without carried topology state"
        );
        current_locals = state.locals.clone();
    }
    let initial_locals = current_locals.clone();
    counters.topology_bytes += payload.len() as u64;

    // Batched topology events: one timing header per GOP change, not per body.
    // Keyframe blocks absorb block-boundary changes into the header map; delta
    // blocks must emit them as events, including the block's first tick.
    let event_count_offset = payload.len();
    write_u32(&mut payload, 0);
    let mut event_count = 0_u32;
    let mut event_locals = BTreeMap::<(u32, u32), Pose>::new();
    for (local_tick, tick) in ticks.iter().enumerate() {
        let has_break = !tick.topology.broken_edges.is_empty();
        let has_change = !tick.topology.changed_roots.is_empty();
        let emit = (has_break || has_change) && (local_tick > 0 || !keyframe);
        if !emit {
            if local_tick == 0 && !has_break && !has_change {
                // Initial island map is already in the GOP header or carried.
                counters.topology_epochs = counters.topology_epochs.max(tick.topology.epoch);
            }
            continue;
        }
        let event_before = payload.len();
        write_var_u32(&mut payload, local_tick as u32);
        write_u32(&mut payload, tick.topology.epoch);
        write_u32(&mut payload, tick.topology.broken_edges.len() as u32);
        for &edge in &tick.topology.broken_edges {
            write_u64(&mut payload, edge);
        }
        write_u32(&mut payload, tick.topology.changed_roots.len() as u32);
        for &(actor, root) in &tick.topology.changed_roots {
            write_var_u32(&mut payload, actor);
            write_var_u32(&mut payload, root);
            if epoch_anchors {
                let local = write_compact_pose(
                    &mut payload,
                    relative_pose(
                        tick.states[root as usize].pose,
                        tick.states[actor as usize].pose,
                    ),
                    actors[actor as usize].bounding_radius,
                    config.shell_bound_m * 0.5,
                );
                event_locals.insert((tick.index, actor), local);
            }
        }
        let topology_bytes = (payload.len() - event_before) as u64;
        counters.topology_bytes += topology_bytes;
        counters.broken_edge_events += tick.topology.broken_edges.len() as u64;
        counters.topology_epochs = counters.topology_epochs.max(tick.topology.epoch);
        add_track(
            tracks,
            HierarchyTrackKey {
                tier: HierarchyTier::Events,
                x: 0,
                z: 0,
            },
            1,
            topology_bytes,
        );
        event_count += 1;
    }
    payload[event_count_offset..event_count_offset + 4].copy_from_slice(&event_count.to_le_bytes());

    let mut segments = build_root_segments_hybrid(
        ticks,
        actors,
        hz,
        gravity,
        &bounds,
        // Masking loosens position only; a moving body must still move.
        if config.mask.enabled {
            config.mask.motion_low
        } else {
            f32::INFINITY
        },
        epoch_anchors,
        rest_poses,
        &mut counters.fit_run_lengths,
        // Costs are compared post-compression, using the stream's own running
        // statistics: segments and residuals compress very differently, and
        // the ratios differ again between archive and live paths. Priors only
        // cover the first blocks; after that the stream prices itself.
        if counters.residual_pose_records > 1_000 {
            counters.residual_zstd_bytes as f64 / counters.residual_pose_records as f64
        } else {
            RESIDUAL_RECORD_BYTES_PRIOR * RESIDUAL_ZSTD_RATIO_PRIOR
        },
        if counters.root_bytes > 100_000 {
            counters.root_zstd_bytes as f64 / counters.root_bytes as f64
        } else {
            ROOT_ZSTD_RATIO_PRIOR
        },
        config.shell_bound_m,
        archive_mode,
        config.max_span_ticks,
    );
    // Wire v7 emits segments in (root, start_tick) order so a root id becomes a
    // gap varint and the previous same-root segment is always the immediately
    // preceding record. Order carries no meaning to either side -- both index
    // segments by root and search by tick containment -- so sorting is safe.
    segments.sort_by_key(|segment| (segment.root, segment.start_tick));
    // Build the packed segment form into its own buffer so the block can be
    // emitted either packed or entropy-coded, whichever is smaller.
    let mut segment_body = Vec::new();
    let mut segment_count = 0_u32;
    // Predictions must be taken from what the receiver will reconstruct, not
    // from the fitted floats, so each written segment is recorded in decoded
    // form and later records predict against that.
    let mut decoded_segments: Vec<RootSegment> = Vec::with_capacity(segments.len());
    let mut previous_root_by_root: HashMap<u32, usize> = HashMap::new();
    let mut stream_previous_root = 0_u32;
    // Delta blocks continue the previous block's per-root segment state; a
    // keyframe starts clean, which is what makes it a recovery point.
    let carried_segments: BTreeMap<u32, RootSegment> = match (&carried, keyframe) {
        (Some(state), false) => state.last_segments.clone(),
        _ => BTreeMap::new(),
    };
    for (segment_index, segment) in segments.iter().enumerate() {
        let before = segment_body.len();
        let root_gap = segment.root.saturating_sub(stream_previous_root);
        write_var_u32(&mut segment_body, root_gap);
        // A predecessor is either the immediately preceding record (same root,
        // zero gap) or, for a root's first record in a delta block, the
        // segment carried from the previous block. The receiver derives the
        // same thing from the same two sources.
        let in_block = previous_root_by_root
            .get(&segment.root)
            .map(|&index| &decoded_segments[index]);
        let previous = if segment_index > 0 && root_gap == 0 {
            in_block
        } else {
            carried_segments.get(&segment.root)
        };
        let has_previous = previous.is_some();
        let duration = segment.end_tick.saturating_sub(segment.start_tick);

        if let Some(previous) = previous.filter(|_| has_previous) {
            ensure!(
                segment.start_tick > previous.end_tick,
                "hierarchy root segments overlap for root {}",
                segment.root
            );
            write_var_u32(&mut segment_body, segment.start_tick - previous.end_tick - 1);
        } else {
            write_var_u32(&mut segment_body, segment.start_tick.saturating_sub(first.index));
        }
        write_var_u32(&mut segment_body, duration);

        // Choose the cheaper start-position encoding per record, so a stale or
        // distant predecessor can never make v7 larger than the absolute form.
        let mut absolute_start = Vec::new();
        let decoded_absolute_start = write_cell_vec3(&mut absolute_start, segment.start_pose.position);
        let (start_cells, start_locals) = cell_components(segment.start_pose.position);
        let mut delta_start = Vec::new();
        if let Some(previous) = previous.filter(|_| has_previous) {
            let start_prediction = previous.pose_at(segment.start_tick, hz, gravity).position;
            let (predicted_cells, predicted_locals) = cell_components(start_prediction);
            write_cell_delta(
                &mut delta_start,
                start_cells,
                start_locals,
                predicted_cells,
                predicted_locals,
            );
        }
        let start_continuity = has_previous && delta_start.len() < absolute_start.len();

        // Inherit the predecessor's end rotation only when doing so reproduces
        // exactly what the absolute encoding would have decoded to. That keeps
        // reconstruction bit-identical and needs no shell re-check.
        let absolute_start_rotation = decoded_rotation(
            segment.start_pose.rotation,
            segment.rotation_full_precision,
        );
        let rotation_inherit = match previous.filter(|_| has_previous) {
            Some(previous) => {
                quat_bits(previous.end_pose.rotation) == quat_bits(absolute_start_rotation)
            }
            None => false,
        };

        // End position, same both-ways treatment, predicted by continuing the
        // predecessor's motion across this segment's duration.
        let carries_end_position = matches!(
            segment.position_model,
            PositionModel::Linear | PositionModel::Hermite
        );
        let decoded_start_position = if start_continuity {
            decode_cell_local(start_cells, start_locals)
        } else {
            decoded_absolute_start
        };
        let mut absolute_end = Vec::new();
        let mut decoded_absolute_end = Vec3::ZERO;
        let mut delta_end = Vec::new();
        let (end_cells, end_locals) = cell_components(segment.end_pose.position);
        if carries_end_position {
            decoded_absolute_end = write_cell_vec3(&mut absolute_end, segment.end_pose.position);
            if let Some(previous) = previous.filter(|_| has_previous) {
                let dt = duration as f32 / hz.max(1) as f32;
                let boundary = prev_boundary_velocity(previous, hz, gravity);
                let end_prediction =
                    decoded_start_position + boundary * dt + gravity * (0.5 * dt * dt);
                let (predicted_cells, predicted_locals) = cell_components(end_prediction);
                write_cell_delta(
                    &mut delta_end,
                    end_cells,
                    end_locals,
                    predicted_cells,
                    predicted_locals,
                );
            }
        }
        let end_continuity =
            carries_end_position && has_previous && delta_end.len() < absolute_end.len();

        let mut flags = position_tag(segment.position_model) & 0b11;
        flags |= (rotation_tag(segment.rotation_model) & 1) << 2;
        flags |= u8::from(segment.rotation_full_precision) << 3;
        flags |= u8::from(start_continuity) << 4;
        flags |= u8::from(rotation_inherit) << 5;
        flags |= u8::from(end_continuity) << 6;
        segment_body.push(flags);

        segment_body.extend_from_slice(if start_continuity {
            &delta_start
        } else {
            &absolute_start
        });

        match segment.position_model {
            PositionModel::Hold => {
                counters.unchanged_root_fields += 1;
                if ticks
                    .iter()
                    .find(|tick| tick.index == segment.start_tick)
                    .is_some_and(|tick| {
                        tick.states[segment.root as usize].kinematic()
                            || tick.states[segment.root as usize].sleeping()
                    })
                {
                    counters.static_root_updates_suppressed += 1;
                }
            }
            PositionModel::Linear => {
                segment_body.extend_from_slice(if end_continuity {
                    &delta_end
                } else {
                    &absolute_end
                });
                counters.position_only_root_fields += 1;
            }
            PositionModel::Ballistic => {
                write_velocity(&mut segment_body, segment.start_velocity);
                counters.position_only_root_fields += 1;
            }
            PositionModel::Hermite => {
                segment_body.extend_from_slice(if end_continuity {
                    &delta_end
                } else {
                    &absolute_end
                });
                write_velocity(&mut segment_body, segment.start_velocity);
                write_velocity(&mut segment_body, segment.end_velocity);
                counters.full_root_fields += 1;
            }
        }
        if !rotation_inherit {
            write_rotation(
                &mut segment_body,
                segment.start_pose.rotation,
                segment.rotation_full_precision,
            );
        }
        if matches!(segment.rotation_model, RotationModel::Slerp) {
            write_rotation(
                &mut segment_body,
                segment.end_pose.rotation,
                segment.rotation_full_precision,
            );
            counters.rotation_only_root_fields += 1;
        }

        // Record this segment exactly as the receiver will reconstruct it.
        let decoded_start_rotation = if rotation_inherit {
            previous
                .filter(|_| has_previous)
                .map_or(absolute_start_rotation, |previous| {
                    previous.end_pose.rotation
                })
        } else {
            absolute_start_rotation
        };
        let decoded_end_position = if !carries_end_position {
            decoded_start_position
        } else if end_continuity {
            decode_cell_local(end_cells, end_locals)
        } else {
            decoded_absolute_end
        };
        let decoded_end_rotation = if matches!(segment.rotation_model, RotationModel::Slerp) {
            decoded_rotation(segment.end_pose.rotation, segment.rotation_full_precision)
        } else {
            decoded_start_rotation
        };
        let (decoded_start_velocity, decoded_end_velocity) = match segment.position_model {
            PositionModel::Hold | PositionModel::Linear => (Vec3::ZERO, Vec3::ZERO),
            PositionModel::Ballistic => {
                let velocity = decoded_velocity(segment.start_velocity);
                (velocity, velocity)
            }
            PositionModel::Hermite => (
                decoded_velocity(segment.start_velocity),
                decoded_velocity(segment.end_velocity),
            ),
        };
        previous_root_by_root.insert(segment.root, decoded_segments.len());
        decoded_segments.push(RootSegment {
            root: segment.root,
            start_tick: segment.start_tick,
            end_tick: segment.end_tick,
            position_model: segment.position_model,
            rotation_model: segment.rotation_model,
            start_pose: Pose {
                position: decoded_start_position,
                rotation: decoded_start_rotation,
            },
            end_pose: Pose {
                position: decoded_end_position,
                rotation: decoded_end_rotation,
            },
            start_velocity: decoded_start_velocity,
            end_velocity: decoded_end_velocity,
            rotation_full_precision: segment.rotation_full_precision,
            encoded_bytes: 0,
        });
        stream_previous_root = segment.root;
        let bytes = (segment_body.len() - before) as u64;
        counters.root_bytes += bytes;
        counters.root_pose_records += 1;
        add_track(
            tracks,
            track_key(
                HierarchyTier::Root,
                segment.start_pose.position,
                config.cell_size_m,
            ),
            1,
            bytes,
        );
        segment_count += 1;
    }

    // Emit the block in whichever form is smaller. The entropy coder is a pure
    // transcoder of these same bytes, so the choice cannot affect what the
    // receiver reconstructs -- only how many bytes carry it.
    let segment_count_offset = payload.len();
    write_u32(&mut payload, segment_count);
    let coded_segments = if config.root_rans {
        root_coder::encode_if_smaller(&segment_body, segment_count as usize)?
    } else {
        None
    };
    match &coded_segments {
        Some(coded) => {
            payload.push(1);
            write_u32(&mut payload, coded.len() as u32);
            payload.extend_from_slice(coded);
            counters.root_rans_blocks += 1;
        }
        None => {
            payload.push(0);
            payload.extend_from_slice(&segment_body);
            counters.root_packed_blocks += 1;
        }
    }
    counters.root_packed_bytes += segment_body.len() as u64;
    counters.root_coded_bytes += coded_segments
        .as_ref()
        .map_or(segment_body.len(), |coded| coded.len()) as u64;

    // Select sparse repairs against the literal wire representation, not the
    // in-memory fitted segments. This makes serialization quantization part of
    // the encoder decision and shares the exact parser with validation.
    let mut segment_reader = Reader::new(&segment_body);
    let wire_segments = read_root_segments(
        &mut segment_reader,
        segment_count as usize,
        first.index,
        actors.len(),
        hz,
        gravity,
        &carried_segments,
    )?;
    ensure!(
        segment_reader.is_empty(),
        "trailing encoded hierarchy root bytes"
    );

    if crate::census::enabled() && !keyframe {
        // R6 sizing: a root's first record in a delta block is the only one a
        // cross-block continuation could ever remove -- later records in the
        // same block describe motion this block genuinely discovered.
        let (mut first_in_block, mut static_repeat, mut same_model) = (0_u64, 0_u64, 0_u64);
        let mut seen_root: Option<u32> = None;
        for segment in &wire_segments {
            if seen_root == Some(segment.root) {
                continue;
            }
            seen_root = Some(segment.root);
            first_in_block += 1;
            let Some(previous) = carried_segments.get(&segment.root) else {
                continue;
            };
            if previous.position_model == segment.position_model
                && previous.rotation_model == segment.rotation_model
            {
                same_model += 1;
            }
            let both_static = matches!(previous.position_model, PositionModel::Hold)
                && matches!(segment.position_model, PositionModel::Hold)
                && matches!(previous.rotation_model, RotationModel::Hold)
                && matches!(segment.rotation_model, RotationModel::Hold);
            if both_static
                && rigid_shell_error_meters(
                    previous.end_pose,
                    segment.start_pose,
                    actors[segment.root as usize].bounding_radius,
                ) <= config.shell_bound_m
            {
                static_repeat += 1;
            }
        }
        crate::census::record_continuity(
            first_in_block,
            static_repeat,
            same_model,
            wire_segments.len() as u64,
        );
    }

    // R1 symbol audit: measure predicted-relative coding of root segments
    // against the literal wire-reparsed segments, in (root, start_tick)
    // sorted order -- the order a wire that delta-codes continuity would
    // actually emit them in. Audit-only: nothing here changes wire bytes.
    if let Some(log) = counters.symbols.as_mut() {
        let tick_pos: HashMap<u32, usize> =
            ticks.iter().enumerate().map(|(i, t)| (t.index, i)).collect();
        let mut island_counts: Vec<HashMap<u32, u32>> = vec![HashMap::new(); ticks.len()];
        for (i, tick) in ticks.iter().enumerate() {
            for &root in &tick.topology.island_roots {
                *island_counts[i].entry(root).or_default() += 1;
            }
        }

        let mut order: Vec<usize> = (0..wire_segments.len()).collect();
        order.sort_by_key(|&i| (wire_segments[i].root, wire_segments[i].start_tick));

        let mut prev_by_root: HashMap<u32, usize> = HashMap::new();
        let mut stream_previous_root = 0_u32;
        for &i in &order {
            let segment = &wire_segments[i];
            let members = tick_pos
                .get(&segment.start_tick)
                .and_then(|&pos| island_counts[pos].get(&segment.root))
                .copied()
                .unwrap_or(0);
            let (start_cell, start_local) = cell_components(segment.start_pose.position);
            let duration = segment.end_tick.saturating_sub(segment.start_tick);
            let prev = prev_by_root.get(&segment.root).map(|&pi| &wire_segments[pi]);

            let mut symbol = RootSymbol {
                root_gap: segment.root.saturating_sub(stream_previous_root),
                duration,
                position_model: position_tag(segment.position_model),
                rotation_model: rotation_tag(segment.rotation_model),
                full_precision: segment.rotation_full_precision,
                island_size_bucket: bucket_log2(members),
                duration_bucket: bucket_log2(duration),
                had_prev: prev.is_some(),
                start_cell,
                start_local,
                start_tick_symbol: segment.start_tick.saturating_sub(first.index),
                ..Default::default()
            };

            if let Some(prev) = prev {
                let predicted = prev.pose_at(segment.start_tick, hz, gravity);
                let (pred_cell, pred_local) = cell_components(predicted.position);
                symbol.start_tick_symbol = segment
                    .start_tick
                    .saturating_sub(prev.end_tick)
                    .saturating_sub(1);
                for axis in 0..3 {
                    symbol.start_dcell[axis] = start_cell[axis] - pred_cell[axis];
                    symbol.start_dlocal[axis] = start_local[axis] as i32 - pred_local[axis] as i32;
                }

                let base_rotation = prev.end_pose.rotation.normalize();
                let truth_rotation = segment.start_pose.rotation.normalize();
                symbol.start_rot_pred_exact =
                    encode_quat32(truth_rotation) == encode_quat32(base_rotation);
                let delta_rotation = (base_rotation.inverse() * truth_rotation).normalize();
                symbol.start_rot_delta_q32 = encode_quat32(delta_rotation);

                if matches!(segment.rotation_model, RotationModel::Slerp) {
                    let end_delta = (segment.start_pose.rotation.normalize().inverse()
                        * segment.end_pose.rotation.normalize())
                    .normalize();
                    symbol.end_rot_delta_q32 = encode_quat32(end_delta);
                }

                let boundary_velocity = prev_boundary_velocity(prev, hz, gravity);
                let quantize_velocity = |v: Vec3| {
                    [
                        (v.x / VELOCITY_STEP_MPS).round() as i32,
                        (v.y / VELOCITY_STEP_MPS).round() as i32,
                        (v.z / VELOCITY_STEP_MPS).round() as i32,
                    ]
                };

                if matches!(
                    segment.position_model,
                    PositionModel::Linear | PositionModel::Hermite
                ) {
                    let dt = duration as f32 / hz.max(1) as f32;
                    let end_predicted = segment.start_pose.position
                        + boundary_velocity * dt
                        + gravity * (0.5 * dt * dt);
                    let (end_pred_cell, end_pred_local) = cell_components(end_predicted);
                    let (end_cell, end_local) = cell_components(segment.end_pose.position);
                    for axis in 0..3 {
                        symbol.end_dcell[axis] = end_cell[axis] - end_pred_cell[axis];
                        symbol.end_dlocal[axis] =
                            end_local[axis] as i32 - end_pred_local[axis] as i32;
                    }
                }

                if matches!(
                    segment.position_model,
                    PositionModel::Ballistic | PositionModel::Hermite
                ) {
                    let truth_q = quantize_velocity(segment.start_velocity);
                    let pred_q = quantize_velocity(boundary_velocity);
                    for axis in 0..3 {
                        symbol.dvel_start[axis] = truth_q[axis] - pred_q[axis];
                    }
                }

                if matches!(segment.position_model, PositionModel::Hermite) {
                    let dt = duration as f32 / hz.max(1) as f32;
                    let end_predicted_v = segment.start_velocity + gravity * dt;
                    let truth_q = quantize_velocity(segment.end_velocity);
                    let pred_q = quantize_velocity(end_predicted_v);
                    for axis in 0..3 {
                        symbol.dvel_end[axis] = truth_q[axis] - pred_q[axis];
                    }
                }
            }

            prev_by_root.insert(segment.root, i);
            stream_previous_root = segment.root;
            log.roots.push(symbol);
        }
    }

    // Repairs are collected first, then selected under the block's byte
    // allowance, then serialized. Deferring one is safe by construction: a
    // residual is a per-tick correction that never feeds prediction state, so a
    // body whose repair is withheld simply stays on its predicted trajectory
    // and the receiver needs no knowledge that a choice was made.
    struct Candidate {
        rel_tick: u32,
        actor: u32,
        shell_m: f32,
        payload: Vec<u8>,
        coding: ResidualCoding,
        compact: Pose,
        position: Vec3,
        priority: f32,
        required: bool,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let segment_index = index_segments_by_root(&wire_segments);
    // Audit-only scratch: island membership counts and per-actor repair recency.
    let mut island_sizes = vec![0_u32; actors.len()];
    let mut last_residual_tick = vec![None::<u32>; actors.len()];
    let block_ticks = ticks.len() as u32;
    current_locals = initial_locals;
    for tick in ticks {
        for &(actor, root) in &tick.topology.changed_roots {
            current_locals[actor as usize] = if !epoch_anchors {
                relative_pose(rest_poses[root as usize], rest_poses[actor as usize])
            } else if tick.index == first.index && keyframe {
                // Block-boundary changes are absorbed by the keyframe header.
                current_locals[actor as usize]
            } else {
                event_locals
                    .get(&(tick.index, actor))
                    .copied()
                    .with_context(|| {
                        format!(
                            "missing compact epoch local at tick {}, actor {}",
                            tick.index, actor
                        )
                    })?
            };
        }
        let rel_tick = tick.index.saturating_sub(first.index);
        counters.awake_per_tick.push(
            tick.states
                .iter()
                .filter(|state| !state.sleeping() && !state.kinematic())
                .count() as u32,
        );
        // P1 census (measurement only, env-gated, no effect on wire bytes):
        // occlusion is expensive enough to want a spatial index, so it is built
        // once per sampled tick rather than per body.
        let census_grid = crate::census::enabled()
            .then(|| crate::census::Grid::build(&tick.states, actors))
            .flatten();
        for (actor, state) in tick.states.iter().enumerate() {
            let topology_root = tick.topology.island_roots[actor] as usize;
            let (predicted, basis) = reconstructed_segment_pose(
                &segment_index,
                tick.index,
                actor as u32,
                topology_root as u32,
                current_locals[actor],
                hz,
                gravity,
            )?;
            // Masking may only loosen a body's bound while its reconstruction
            // basis is itself dynamic. A moving body predicted by a fully
            // static root segment does not move at all between repairs, so a
            // loosened bound there produces stop-motion -- measured as 90
            // bodies frozen in one frame when a second building's debris
            // started moving against its still-static tower root. Such bodies
            // revert to the base bound; everything else keeps its slack.
            let moving = crate::mask::motion_magnitude(
                state.linear_velocity,
                state.angular_velocity,
                actors[actor].bounding_radius,
            ) > config.mask.motion_low;
            let bound = if config.mask.enabled && moving && basis.position_hold {
                config.mask.base_m
            } else {
                bounds[actor]
            };
            let shell =
                rigid_shell_error_meters(state.pose, predicted, actors[actor].bounding_radius);
            if shell <= bound {
                if actor != topology_root
                    && segment_pose_at(&segment_index, tick.index, actor as u32, hz, gravity)
                        .is_none()
                {
                    counters.omitted_child_pose_records += 1;
                }
                continue;
            }
            let mut payload = Vec::new();
            let mut coding = ResidualCoding::default();
            let compact = write_packed_residual(
                &mut payload,
                state.pose,
                predicted,
                actors[actor].bounding_radius,
                bound,
                &mut [0_u64; 4],
                &mut coding,
            );
            ensure!(
                rigid_shell_error_meters(state.pose, compact, actors[actor].bounding_radius)
                    <= bound,
                "compact residual exceeds this body's shell bound"
            );

            // Accumulated surprise, in the Tribes sense: error already deferred
            // compounds with this tick's, so a body repeatedly passed over
            // climbs the ordering rather than starving.
            let entry = budget_state.entry(actor);
            let bound = bound.max(1e-6);
            let error_ratio = (shell + entry.deferred_error_m) / bound;
            let age_ratio =
                entry.age_ticks as f32 / config.budget.max_deferral_ticks.max(1) as f32;
            let priority = error_ratio + 2.0 * age_ratio;
            // Never deferred: past the hard cap, past the heartbeat deadline, or
            // settling -- a body coming to rest at a wrong pose is a freeze, and
            // freezes are among the few artifacts observers reliably detect.
            let required = !config.budget.enabled
                || shell > bound * config.budget.hard_cap_factor
                || entry.age_ticks >= config.budget.max_deferral_ticks
                || state.sleeping();

            if let Some(grid) = census_grid.as_ref() {
                crate::census::record(
                    grid,
                    actor,
                    state,
                    actors[actor].bounding_radius,
                    state.pose.position - predicted.position,
                    payload.len(),
                );
            }

            candidates.push(Candidate {
                rel_tick,
                actor: actor as u32,
                shell_m: shell,
                payload,
                coding,
                compact,
                position: state.pose.position,
                priority,
                required,
            });
        }
        counters.contact_pair_samples += tick.contact_pairs.len() as u64;
        counters.velocity_coherent_contact_pairs += tick
            .contact_pairs
            .iter()
            .filter(|(first, second)| {
                let first = tick.states[*first as usize];
                let second = tick.states[*second as usize];
                first.linear_velocity.distance(second.linear_velocity) <= 0.1
                    && first.angular_velocity.distance(second.angular_velocity) <= 0.1
            })
            .count() as u64;
    }

    // Topology and root segments are already committed, so the residual
    // allowance is what remains of the block's budget after them.
    let selected: Vec<usize> = if config.budget.enabled {
        let costs: Vec<crate::budget::CandidateCost> = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| crate::budget::CandidateCost {
                index,
                // Framing is three varints at most on top of the payload.
                cost_bytes: candidate.payload.len() + 3,
                priority: candidate.priority,
                required: candidate.required,
            })
            .collect();
        let ceiling = budget_state.residual_ceiling_bytes(
            &config.budget,
            block_ticks as f64 / hz.max(1) as f64,
            payload.len() as u64,
        );
        crate::budget::select(&costs, ceiling)
    } else {
        (0..candidates.len()).collect()
    };

    let mut emitted = vec![false; candidates.len()];
    for &index in &selected {
        emitted[index] = true;
    }
    counters.budget_telemetry.blocks += 1;
    counters.budget_telemetry.candidates += candidates.len() as u64;
    counters.budget_telemetry.emitted += selected.len() as u64;
    counters.budget_telemetry.deferred += (candidates.len() - selected.len()) as u64;

    // Build the packed byte form into its own buffer while collecting the same
    // records for the rANS coder, then emit whichever is smaller. Coding the
    // block both ways means the entropy coder can never cost more than the
    // bytes it replaces.
    let mut residual_body = Vec::new();
    let mut residual_records: Vec<ResidualRecord> = Vec::new();
    let mut residual_count = 0_u32;
    let mut previous_rel_tick = u32::MAX;
    let mut previous_actor: Option<u32> = None;
    for (index, candidate) in candidates.iter().enumerate() {
        if !emitted[index] {
            // Deferral is what the cap bounds. Anything past it was marked
            // required above and therefore cannot reach this branch.
            ensure!(
                candidate.shell_m
                    <= bounds[candidate.actor as usize]
                        * config.budget.hard_cap_factor.max(1.0)
                        * 1.000_01,
                "deferred residual exceeds the hard cap"
            );
            budget_state.note_deferred(candidate.actor as usize, candidate.shell_m, 1);
            counters
                .budget_telemetry
                .deferred_error_samples
                .push(candidate.shell_m);
            let entry = budget_state.entry(candidate.actor as usize);
            counters
                .budget_telemetry
                .deferral_age_samples
                .push(entry.age_ticks);
            continue;
        }
        if candidate.required {
            counters.budget_telemetry.required += 1;
        }
        if candidate.rel_tick != previous_rel_tick {
            previous_actor = None;
            previous_rel_tick = candidate.rel_tick;
        }
        let before = residual_body.len();
        write_var_u32(&mut residual_body, candidate.rel_tick);
        let actor_gap = match previous_actor {
            Some(previous) => candidate.actor - previous - 1,
            None => candidate.actor,
        };
        write_var_u32(&mut residual_body, actor_gap);
        previous_actor = Some(candidate.actor);
        residual_body.extend_from_slice(&candidate.payload);
        counters.residual_rotation_tiers[((candidate.coding.tag >> 1) & 0b11) as usize] += 1;
        budget_state.note_emitted(candidate.actor as usize);
        {
            // R1b: extend or close this actor's consecutive-tick residual run.
            let actor = candidate.actor as usize;
            if counters.residual_run_state.len() <= actor {
                counters
                    .residual_run_state
                    .resize(actor + 1, (u32::MAX, 0));
            }
            let absolute = first.index + candidate.rel_tick;
            let (last, length) = counters.residual_run_state[actor];
            if last != u32::MAX && absolute == last + 1 {
                counters.residual_run_state[actor] = (absolute, length + 1);
            } else {
                if length > 0 {
                    counters.residual_run_lengths[bucket_log2(length).min(15) as usize] += 1;
                    counters.residual_runs += 1;
                }
                counters.residual_run_state[actor] = (absolute, 1);
            }
        }

        if counters.symbols.is_some() {
            let actor = candidate.actor as usize;
            let tick_index = first.index + candidate.rel_tick;
            island_sizes.clear();
            island_sizes.resize(actors.len(), 0);
            if let Some(tick) = ticks.iter().find(|tick| tick.index == tick_index) {
                for &root in &tick.topology.island_roots {
                    island_sizes[root as usize] += 1;
                }
            }
            let topology_root = ticks
                .iter()
                .find(|tick| tick.index == tick_index)
                .map_or(actor, |tick| tick.topology.island_roots[actor] as usize);
            let since = last_residual_tick[actor].map_or(u32::MAX, |t| candidate.rel_tick - t);
            let symbol = ResidualSymbol {
                actor_gap,
                tag: candidate.coding.tag,
                delta: candidate.coding.delta,
                island_size_bucket: bucket_log2(island_sizes[topology_root]),
                since_last_bucket: if since == u32::MAX {
                    15
                } else {
                    bucket_log2(since)
                },
                position_model: segment_index
                    .get(&(topology_root as u32))
                    .and_then(|segments| {
                        segments
                            .iter()
                            .find(|s| tick_index >= s.start_tick && tick_index <= s.end_tick)
                    })
                    .map_or(255, |s| position_tag(s.position_model)),
                emitted_previous_tick: since == 1,
                fold: ((tick_index / hz.max(1)) % 2) as u8,
            };
            last_residual_tick[actor] = Some(candidate.rel_tick);
            if let Some(log) = counters.symbols.as_mut() {
                log.residuals.push(symbol);
            }
        }

        residual_records.push(ResidualRecord {
            rel_tick: candidate.rel_tick,
            actor: candidate.actor,
            coding: candidate.coding,
        });
        let bytes = (residual_body.len() - before) as u64;
        residual_count += 1;
        counters.residual_pose_records += 1;
        counters.residual_bytes += bytes;
        add_track(
            tracks,
            track_key(HierarchyTier::Residual, candidate.position, config.cell_size_m),
            1,
            bytes,
        );
    }
    let _ = &candidates;

    let residual_block_offset = payload.len();
    write_u32(&mut payload, residual_count);
    let coded = if config.residual_rans {
        residual_coder::encode(&residual_records)
    } else {
        Vec::new()
    };
    if config.residual_rans && coded.len() < residual_body.len() {
        payload.push(1);
        write_u32(&mut payload, coded.len() as u32);
        payload.extend_from_slice(&coded);
        counters.residual_rans_blocks += 1;
    } else {
        payload.push(0);
        payload.extend_from_slice(&residual_body);
        counters.residual_packed_blocks += 1;
    }
    counters.residual_packed_bytes += residual_body.len() as u64;
    counters.residual_coded_bytes += coded.len() as u64;

    // Split-stream attribution. The three streams are already contiguous and in
    // this order, so slicing costs nothing and cannot perturb the wire: header
    // and topology events, then root segments, then residuals.
    counters.topology_zstd_bytes +=
        zstd::bulk::compress(&payload[..segment_count_offset], 3)?.len() as u64;
    counters.root_zstd_bytes +=
        zstd::bulk::compress(&payload[segment_count_offset..residual_block_offset], 3)?.len() as u64;
    counters.residual_zstd_bytes +=
        zstd::bulk::compress(&payload[residual_block_offset..], 3)?.len() as u64;
    counters.block_rows.push(BlockRow {
        start_tick: first.index,
        ticks: ticks.len() as u32,
        keyframe,
        topology_raw: segment_count_offset as u64,
        root_raw: (residual_block_offset - segment_count_offset) as u64,
        residual_raw: (payload.len() - residual_block_offset) as u64,
        root_records: segment_count as u64,
        residual_records: residual_count as u64,
        compressed: 0, // filled by the caller once zstd of the whole block is known
    });

    if let Some(state) = carried {
        state.roots = ticks
            .last()
            .expect("non-empty GOP")
            .topology
            .island_roots
            .clone();
        state.locals = current_locals;
        // Tail segment per root, in decoded form, for the next delta block.
        state.last_segments.clear();
        for segment in &decoded_segments {
            state
                .last_segments
                .entry(segment.root)
                .and_modify(|existing| {
                    if segment.start_tick >= existing.start_tick {
                        *existing = segment.clone();
                    }
                })
                .or_insert_with(|| segment.clone());
        }
    }
    Ok(payload)
}

/// What a segment fit is allowed to do for one body.
///
/// `shell_m` is how far the reconstruction may sit from truth. `max_hold_speed`
/// is the separate, perceptual constraint: above it, a run may not be
/// reconstructed as stationary at all. Loosening the shell bound trades
/// positional precision, which observers tolerate in fast motion; letting a
/// moving body be coded as `Hold` instead manufactures a freeze, which is one
/// of the few motion artifacts observers reliably detect. The two must be
/// controlled independently.
#[derive(Clone, Copy, Debug)]
struct FitPolicy {
    shell_m: f32,
    max_hold_speed: f32,
}

/// Shared, immutable inputs for fitting one island. Bundled so the serial and
/// parallel drivers call exactly the same function.
struct FitContext<'a> {
    actors: &'a [ActorDef],
    hz: u32,
    gravity: Vec3,
    bounds: &'a [f32],
    max_hold_speed: f32,
    epoch_anchors: bool,
    rest_poses: &'a [Pose],
    /// Base shell bound; event locals on the wire are quantized to half this.
    base_bound_m: f32,
}

impl FitContext<'_> {
    fn policy(&self, actor: u32) -> FitPolicy {
        FitPolicy {
            shell_m: self.bounds[actor as usize],
            max_hold_speed: self.max_hold_speed,
        }
    }
}

fn build_root_segments_hybrid(
    ticks: &[Tick],
    actors: &[ActorDef],
    hz: u32,
    gravity: Vec3,
    bounds: &[f32],
    max_hold_speed: f32,
    epoch_anchors: bool,
    rest_poses: &[Pose],
    fit_run_lengths: &mut [u64; 16],
    residual_cost_per_record: f64,
    root_zstd_ratio: f64,
    base_bound_m: f32,
    per_member: bool,
    max_span_ticks: usize,
) -> Vec<RootSegment> {
    if ticks.is_empty() {
        return Vec::new();
    }
    let context = FitContext {
        actors,
        hz,
        gravity,
        bounds,
        max_hold_speed,
        epoch_anchors,
        rest_poses,
        base_bound_m,
    };

    // Islands are segmented independently: an island's span ends only when its
    // OWN member set changes, not when any bond breaks anywhere in the scene.
    // The previous global rule re-anchored every island's segments on every
    // scene-wide epoch tick, producing 264,851 single-tick island-runs on the
    // reference trace -- fragmentation concentrated exactly at the burst.
    // When an actor moves between islands, both islands' member sets change,
    // so each actor's successive (island, span) memberships tile the block and
    // spans per root are disjoint by construction; an actor's root therefore
    // never changes mid-span, which is what keeps decode indifferent to how
    // spans are chosen.
    struct IslandSpan {
        start: usize,
        end: usize,
        root: u32,
        members: Vec<u32>,
    }
    let mut spans: Vec<IslandSpan> = Vec::new();
    let mut open: BTreeMap<u32, (usize, Vec<u32>)> = BTreeMap::new();
    {
        let mut initial: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for (actor, &root) in ticks[0].topology.island_roots.iter().enumerate() {
            initial.entry(root).or_default().push(actor as u32);
        }
        for (root, members) in initial {
            open.insert(root, (0, members));
        }
    }
    for index in 1..ticks.len() {
        // Optional span-length cap, independent of block length. Block size
        // and span length are otherwise locked together (a span cannot outlive
        // its block), which conflates two different effects: block size drives
        // latency and per-block overhead, span length drives prediction
        // quality and segment count.
        if max_span_ticks > 0 {
            let expired: Vec<u32> = open
                .iter()
                .filter(|(_, (start, _))| index - start >= max_span_ticks)
                .map(|(&root, _)| root)
                .collect();
            for root in expired {
                if let Some((start, members)) = open.remove(&root) {
                    spans.push(IslandSpan {
                        start,
                        end: index,
                        root,
                        members: members.clone(),
                    });
                    open.insert(root, (index, members));
                }
            }
        }
        let previous = &ticks[index - 1].topology.island_roots;
        let current = &ticks[index].topology.island_roots;
        if previous == current {
            continue;
        }
        let mut affected: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for actor in 0..current.len() {
            if previous[actor] != current[actor] {
                affected.insert(previous[actor]);
                affected.insert(current[actor]);
            }
        }
        for &root in &affected {
            if let Some((start, members)) = open.remove(&root) {
                // A span cap can expire and reopen a span at this same tick,
                // so a membership change here would otherwise close a
                // zero-length span and hand an empty sample run to the fitter.
                if start < index {
                    spans.push(IslandSpan {
                        start,
                        end: index,
                        root,
                        members,
                    });
                }
            }
        }
        let mut fresh: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for (actor, &root) in current.iter().enumerate() {
            if affected.contains(&root) {
                fresh.entry(root).or_default().push(actor as u32);
            }
        }
        for (root, members) in fresh {
            open.insert(root, (index, members));
        }
    }
    for (root, (start, members)) in std::mem::take(&mut open) {
        if start < ticks.len() {
            spans.push(IslandSpan {
                start,
                end: ticks.len(),
                root,
                members,
            });
        }
    }
    for span in &spans {
        let bucket =
            crate::symbol_audit::bucket_log2((span.end - span.start) as u32).min(15) as usize;
        fit_run_lengths[bucket] += 1;
    }

    // Fit jobs: one per (span, member). Jagged, so an offset table maps a
    // span's members to their slots; members are actor-ascending from the
    // BTreeMap grouping, so a member's slot is its position in that list.
    let mut job_offsets: Vec<usize> = Vec::with_capacity(spans.len() + 1);
    let mut jobs: Vec<(usize, u32)> = Vec::new();
    for (span_index, span) in spans.iter().enumerate() {
        job_offsets.push(jobs.len());
        for &member in &span.members {
            jobs.push((span_index, member));
        }
    }
    job_offsets.push(jobs.len());

    let mut fits: Vec<Vec<RootSegment>> = vec![Vec::new(); jobs.len()];
    let threads = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(jobs.len().max(1));

    if threads <= 1 {
        for (slot, &(span_index, actor)) in fits.iter_mut().zip(&jobs) {
            let span = &spans[span_index];
            *slot = fit_actor_run(
                &ticks[span.start..span.end],
                actor,
                actors,
                hz,
                gravity,
                context.policy(actor),
            );
        }
    } else {
        let next = AtomicUsize::new(0);
        let context_ref = &context;
        let spans_ref = &spans;
        let jobs_ref = &jobs;
        let completed: Vec<(usize, Vec<RootSegment>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    scope.spawn(|| {
                        let mut local = Vec::new();
                        loop {
                            // Dynamic hand-out: fit cost varies by orders of
                            // magnitude between a settled body and a tumbling
                            // one, so fixed ranges would idle most threads.
                            let index = next.fetch_add(1, AtomicOrdering::Relaxed);
                            let Some(&(span_index, actor)) = jobs_ref.get(index) else {
                                break;
                            };
                            let span = &spans_ref[span_index];
                            local.push((
                                index,
                                fit_actor_run(
                                    &ticks[span.start..span.end],
                                    actor,
                                    context_ref.actors,
                                    context_ref.hz,
                                    context_ref.gravity,
                                    context_ref.policy(actor),
                                ),
                            ));
                        }
                        local
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|handle| handle.join().expect("trajectory fit thread panicked"))
                .collect()
        });
        for (index, segments) in completed {
            fits[index] = segments;
        }
    }

    // Selection, per island-span. Two regimes, adopted where each was measured
    // to win: per-child min choice on archive GOPs (-13.6%), the island-binary
    // rule on stream blocks whose 30-tick economics price the same trade at
    // breakeven and were measured to lose under the min choice.
    let mut segments = Vec::new();
    for (span_index, span) in spans.iter().enumerate() {
        let base = job_offsets[span_index];
        let slot_of = |member: u32| -> usize {
            base + span
                .members
                .binary_search(&member)
                .expect("member missing from its own span")
        };
        let run = &ticks[span.start..span.end];
        let root_segs = &fits[slot_of(span.root)];
        if span.members.len() == 1 {
            segments.extend(root_segs.iter().cloned());
            continue;
        }
        let violations = per_member_violations(&context, run, span.root, &span.members, root_segs);
        if per_member {
            segments.extend(root_segs.iter().cloned());
            for (slot, &member) in span.members.iter().enumerate() {
                if member == span.root {
                    continue;
                }
                let own_bytes: u64 = fits[slot_of(member)]
                    .iter()
                    .map(|segment| segment.encoded_bytes as u64)
                    .sum();
                let own_cost = own_bytes as f64 * root_zstd_ratio;
                let residual_cost = violations[slot] as f64 * residual_cost_per_record;
                if own_cost < residual_cost {
                    segments.extend(fits[slot_of(member)].iter().cloned());
                }
            }
        } else {
            let hierarchy_bytes: u64 = root_segs
                .iter()
                .map(|segment| segment.encoded_bytes as u64)
                .sum::<u64>()
                + violations.iter().sum::<u64>() * LEGACY_REPAIR_ESTIMATE_BYTES;
            let independent_bytes: u64 = span
                .members
                .iter()
                .map(|&member| {
                    fits[slot_of(member)]
                        .iter()
                        .map(|segment| segment.encoded_bytes as u64)
                        .sum::<u64>()
                })
                .sum();
            if independent_bytes <= hierarchy_bytes {
                for &member in &span.members {
                    segments.extend(fits[slot_of(member)].iter().cloned());
                }
            } else {
                segments.extend(root_segs.iter().cloned());
            }
        }
    }
    segments
}

/// Priors for the promotion estimator before the stream has produced enough
/// of its own statistics: mean packed residual record bytes (measured
/// 31,905,299 / 2,611,806 on the reference trace) and the root stream's zstd
/// ratio. Both are replaced by running measurements after the first blocks --
/// the archive and live paths have materially different residual economics
/// (post-zstd ~6.5 vs ~12+ bytes/record), and a fixed constant that helps one
/// path was measured to hurt the other.
const RESIDUAL_RECORD_BYTES_PRIOR: f64 = 12.0;
/// The pre-per-member estimate of one residual repair, kept for the
/// island-binary path so delta-block behavior reproduces the measured
/// baseline exactly.
const LEGACY_REPAIR_ESTIMATE_BYTES: u64 = 40;
const ROOT_ZSTD_RATIO_PRIOR: f64 = 0.75;
const RESIDUAL_ZSTD_RATIO_PRIOR: f64 = 0.6;

/// Per-member counts of ticks where the root-relative prediction misses that
/// member's shell bound -- i.e. how many per-tick residual records the member
/// would cost if it stays hierarchical. Indexed parallel to `members`.
fn per_member_violations(
    context: &FitContext<'_>,
    run: &[Tick],
    root: u32,
    members: &[u32],
    hierarchy_segs: &[RootSegment],
) -> Vec<u64> {
    let anchor = &run[0];
    let mut violations = vec![0_u64; members.len()];
    for (slot, &member) in members.iter().enumerate() {
        if member == root {
            continue;
        }
        let local = if context.epoch_anchors {
            relative_pose(
                anchor.states[root as usize].pose,
                anchor.states[member as usize].pose,
            )
        } else {
            relative_pose(
                context.rest_poses[root as usize],
                context.rest_poses[member as usize],
            )
        };
        for tick in run {
            let root_pose = hierarchy_segs
                .iter()
                .find(|segment| tick.index >= segment.start_tick && tick.index <= segment.end_tick)
                .map(|segment| segment.pose_at(tick.index, context.hz, context.gravity))
                .unwrap_or(tick.states[root as usize].pose);
            let predicted = compose_pose(root_pose, local);
            let shell = rigid_shell_error_meters(
                tick.states[member as usize].pose,
                predicted,
                context.actors[member as usize].bounding_radius,
            );
            if shell > context.bounds[member as usize] {
                violations[slot] += 1;
            }
        }
    }
    violations
}

fn fit_actor_run(
    run: &[Tick],
    actor: u32,
    actors: &[ActorDef],
    hz: u32,
    gravity: Vec3,
    policy: FitPolicy,
) -> Vec<RootSegment> {
    let samples: Vec<_> = run
        .iter()
        .map(|tick| RootSample {
            tick: tick.index,
            pose: tick.states[actor as usize].pose,
            linear_velocity: tick.states[actor as usize].linear_velocity,
            angular_velocity: tick.states[actor as usize].angular_velocity,
            sleeping: tick.states[actor as usize].sleeping()
                || tick.states[actor as usize].kinematic(),
        })
        .collect();
    fit_root_run(&samples, actor, &actors[actor as usize], hz, gravity, policy)
}

fn fit_root_run(
    samples: &[RootSample],
    root: u32,
    actor: &ActorDef,
    hz: u32,
    gravity: Vec3,
    policy: FitPolicy,
) -> Vec<RootSegment> {
    if samples.is_empty() {
        return Vec::new();
    }
    let mut segments = Vec::new();
    let mut start = 0usize;
    while start < samples.len() {
        let mut end = start;
        let mut chosen =
            provisional_segment(&samples[start..=end], root, actor, hz, gravity, policy);
        while end + 1 < samples.len() {
            let candidate = provisional_segment(
                &samples[start..=end + 1],
                root,
                actor,
                hz,
                gravity,
                policy,
            );
            if segment_fits(
                &candidate,
                &samples[start..=end + 1],
                actor.bounding_radius,
                hz,
                gravity,
                policy.shell_m,
            ) {
                chosen = candidate;
                end += 1;
            } else {
                break;
            }
        }
        segments.push(chosen);
        start = end + 1;
    }
    segments
}

fn provisional_segment(
    samples: &[RootSample],
    root: u32,
    actor: &ActorDef,
    hz: u32,
    gravity: Vec3,
    policy: FitPolicy,
) -> RootSegment {
    let model_policy = FitPolicy {
        shell_m: policy.shell_m * 0.75,
        max_hold_speed: policy.max_hold_speed,
    };
    let (position_model, rotation_model, encoded_bytes) =
        choose_models(samples, actor, hz, gravity, model_policy).unwrap_or((
            PositionModel::Hermite,
            RotationModel::Slerp,
            67,
        ));
    let start = samples[0];
    let end = *samples.last().expect("non-empty");
    // Rebuild with the safety budget used during model selection. The looser
    // outer bound can quantize an endpoint that fitting kept full precision.
    let (start_pose, start_full) =
        archive_rotation(start.pose, actor.bounding_radius, model_policy.shell_m);
    let (end_pose, end_full) =
        archive_rotation(end.pose, actor.bounding_radius, model_policy.shell_m);
    let rotation_full_precision = start_full || end_full;
    let rotation_count = if matches!(rotation_model, RotationModel::Slerp) {
        2
    } else {
        1
    };
    RootSegment {
        root,
        start_tick: start.tick,
        end_tick: end.tick,
        position_model,
        rotation_model,
        start_pose,
        end_pose,
        start_velocity: start.linear_velocity,
        end_velocity: end.linear_velocity,
        rotation_full_precision,
        encoded_bytes: encoded_bytes
            + if rotation_full_precision {
                12 * rotation_count
            } else {
                0
            },
    }
}

fn choose_models(
    samples: &[RootSample],
    actor: &ActorDef,
    hz: u32,
    gravity: Vec3,
    policy: FitPolicy,
) -> Option<(PositionModel, RotationModel, usize)> {
    if samples.len() <= 1 {
        return Some((PositionModel::Hold, RotationModel::Hold, 23));
    }
    if samples.iter().all(|sample| sample.sleeping)
        && samples
            .iter()
            .all(|sample| sample.pose.position.distance(samples[0].pose.position) <= 1e-5)
    {
        return Some((PositionModel::Hold, RotationModel::Hold, 23));
    }
    let candidates = [
        (PositionModel::Hold, RotationModel::Hold, 23),
        (PositionModel::Hold, RotationModel::Slerp, 27),
        (PositionModel::Linear, RotationModel::Hold, 35),
        (PositionModel::Linear, RotationModel::Slerp, 39),
        (PositionModel::Ballistic, RotationModel::Hold, 35),
        (PositionModel::Ballistic, RotationModel::Slerp, 39),
        (PositionModel::Hermite, RotationModel::Hold, 59),
        (PositionModel::Hermite, RotationModel::Slerp, 63),
    ];
    // A run that carries real motion may not be reconstructed as stationary,
    // however much positional slack the shell bound allows. Withdrawing Hold
    // here is what separates "coarser" from "frozen".
    let radius = actor.bounding_radius.max(0.01);
    let translating = samples
        .iter()
        .any(|sample| !sample.sleeping && sample.linear_velocity.length() > policy.max_hold_speed);
    let rotating = samples.iter().any(|sample| {
        !sample.sleeping && sample.angular_velocity.length() * radius > policy.max_hold_speed
    });
    candidates
        .into_iter()
        .filter(|(position, rotation, _)| {
            !(translating && matches!(position, PositionModel::Hold))
                && !(rotating && matches!(rotation, RotationModel::Hold))
        })
        .find(|(position, rotation, _)| {
            let segment =
                provisional_with_models(samples, 0, *position, *rotation, actor, policy.shell_m);
            segment_fits(
                &segment,
                samples,
                actor.bounding_radius,
                hz,
                gravity,
                policy.shell_m,
            )
        })
}

fn provisional_with_models(
    samples: &[RootSample],
    root: u32,
    position_model: PositionModel,
    rotation_model: RotationModel,
    actor: &ActorDef,
    shell_bound: f32,
) -> RootSegment {
    let start = samples[0];
    let end = *samples.last().expect("non-empty");
    let (start_pose, start_full) = archive_rotation(start.pose, actor.bounding_radius, shell_bound);
    let (end_pose, end_full) = archive_rotation(end.pose, actor.bounding_radius, shell_bound);
    RootSegment {
        root,
        start_tick: start.tick,
        end_tick: end.tick,
        position_model,
        rotation_model,
        start_pose,
        end_pose,
        start_velocity: start.linear_velocity,
        end_velocity: end.linear_velocity,
        rotation_full_precision: start_full || end_full,
        encoded_bytes: 0,
    }
}

fn segment_fits(
    segment: &RootSegment,
    samples: &[RootSample],
    radius: f32,
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
) -> bool {
    samples.iter().all(|sample| {
        rigid_shell_error_meters(
            sample.pose,
            segment.pose_at(sample.tick, hz, gravity),
            radius,
        ) <= shell_bound
    })
}

fn segment_pose_at(
    index: &BTreeMap<u32, Vec<&RootSegment>>,
    tick: u32,
    actor: u32,
    hz: u32,
    gravity: Vec3,
) -> Option<Pose> {
    index
        .get(&actor)
        .and_then(|actor_segments| {
            actor_segments
                .iter()
                .copied()
                .find(|segment| tick >= segment.start_tick && tick <= segment.end_tick)
        })
        .map(|segment| segment.pose_at(tick, hz, gravity))
}

/// How a body's pose is being predicted this tick: from its own segment, or
/// composed from its root's -- and in the latter case whether that root
/// segment is fully static. A static basis matters to the masking policy:
/// between sparse repairs such a body's implied pose does not move at all, so
/// loosening its bound converts smooth error into stop-motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PredictionBasis {
    own: bool,
    /// The basis segment's position model is Hold: between repairs the
    /// implied position does not translate at all.
    position_hold: bool,
}

fn reconstructed_segment_pose(
    index: &BTreeMap<u32, Vec<&RootSegment>>,
    tick: u32,
    actor: u32,
    topology_root: u32,
    local: Pose,
    hz: u32,
    gravity: Vec3,
) -> Result<(Pose, PredictionBasis)> {
    if let Some(own) = index.get(&actor).and_then(|segments| {
        segments
            .iter()
            .copied()
            .find(|segment| tick >= segment.start_tick && tick <= segment.end_tick)
    }) {
        Ok((
            own.pose_at(tick, hz, gravity),
            PredictionBasis {
                own: true,
                position_hold: matches!(own.position_model, PositionModel::Hold),
            },
        ))
    } else {
        let segment = index
            .get(&topology_root)
            .and_then(|segments| {
                segments
                    .iter()
                    .copied()
                    .find(|segment| tick >= segment.start_tick && tick <= segment.end_tick)
            })
            .with_context(|| {
                format!(
                    "missing encoded hierarchy root pose at tick {tick}, actor {actor}, root {topology_root}"
                )
            })?;
        Ok((
            compose_pose(segment.pose_at(tick, hz, gravity), local),
            PredictionBasis {
                own: false,
                position_hold: matches!(segment.position_model, PositionModel::Hold),
            },
        ))
    }
}

/// Nearest-rank quantile over a pre-sorted slice.
fn quantile_u32(sorted: &[u32], q: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len());
    sorted[rank - 1]
}

fn index_segments_by_root(segments: &[RootSegment]) -> BTreeMap<u32, Vec<&RootSegment>> {
    let mut index = BTreeMap::<u32, Vec<&RootSegment>>::new();
    for segment in segments {
        index.entry(segment.root).or_default().push(segment);
    }
    index
}

fn read_root_segments(
    reader: &mut Reader<'_>,
    segment_count: usize,
    gop_start_tick: u32,
    actor_count: usize,
    hz: u32,
    gravity: Vec3,
    carried: &BTreeMap<u32, RootSegment>,
) -> Result<Vec<RootSegment>> {
    let mut segments: Vec<RootSegment> = Vec::with_capacity(segment_count);
    let mut root = 0_u32;
    for index in 0..segment_count {
        let root_gap = reader.var_u32()?;
        root = root
            .checked_add(root_gap)
            .context("hierarchy root gap overflow")?;
        ensure!(
            root < actor_count as u32,
            "hierarchy root actor out of range"
        );
        // Records arrive in (root, start_tick) order, so an in-block
        // predecessor exists exactly when this is not the first record and the
        // root gap is zero -- and it is then the immediately preceding record.
        // Otherwise a root's first record in a delta block continues from the
        // segment carried out of the previous block, if there is one.
        let in_block = (index > 0 && root_gap == 0).then(|| segments.len() - 1);
        let previous: Option<&RootSegment> = match in_block {
            Some(position) => Some(&segments[position]),
            None => carried.get(&root),
        };

        let start_tick = match previous {
            Some(previous) => {
                let gap = reader.var_u32()?;
                previous
                    .end_tick
                    .checked_add(gap)
                    .and_then(|tick| tick.checked_add(1))
                    .context("hierarchy root start tick overflow")?
            }
            None => gop_start_tick + reader.var_u32()?,
        };
        let has_previous = previous.is_some();
        let duration = reader.var_u32()?;

        let flags = reader.u8()?;
        ensure!(
            flags & 0b1000_0000 == 0,
            "unknown hierarchy root segment flag bits {flags}"
        );
        let position_model = match flags & 0b11 {
            0 => PositionModel::Hold,
            1 => PositionModel::Linear,
            2 => PositionModel::Ballistic,
            _ => PositionModel::Hermite,
        };
        let rotation_model = if flags & 0b100 == 0 {
            RotationModel::Hold
        } else {
            RotationModel::Slerp
        };
        let rotation_full_precision = flags & 0b1000 != 0;
        let start_continuity = flags & 0b1_0000 != 0;
        let rotation_inherit = flags & 0b10_0000 != 0;
        let end_continuity = flags & 0b100_0000 != 0;
        ensure!(
            has_previous || !(start_continuity || rotation_inherit || end_continuity),
            "hierarchy root segment claims continuity without a predecessor"
        );

        // Resolve the predecessor by value before parsing payload, so the
        // borrow does not conflict with pushing onto `segments`.
        let previous_segment: Option<RootSegment> = previous.cloned();
        let start_position = if start_continuity {
            let previous = previous_segment
                .as_ref()
                .context("continuity implies a predecessor")?;
            let predicted = previous.pose_at(start_tick, hz, gravity).position;
            reader.cell_vec3_delta(predicted)?
        } else {
            reader.cell_vec3()?
        };

        let end_predicted = || -> Vec3 {
            let previous = previous_segment
                .as_ref()
                .expect("continuity implies a predecessor");
            let dt = duration as f32 / hz.max(1) as f32;
            let boundary = prev_boundary_velocity(previous, hz, gravity);
            start_position + boundary * dt + gravity * (0.5 * dt * dt)
        };
        let (end_position, start_velocity, end_velocity) = match position_model {
            PositionModel::Hold => (start_position, Vec3::ZERO, Vec3::ZERO),
            PositionModel::Linear => {
                let end = if end_continuity {
                    reader.cell_vec3_delta(end_predicted())?
                } else {
                    reader.cell_vec3()?
                };
                (end, Vec3::ZERO, Vec3::ZERO)
            }
            PositionModel::Ballistic => {
                let velocity = reader.velocity()?;
                (start_position, velocity, velocity)
            }
            PositionModel::Hermite => {
                let end = if end_continuity {
                    reader.cell_vec3_delta(end_predicted())?
                } else {
                    reader.cell_vec3()?
                };
                (end, reader.velocity()?, reader.velocity()?)
            }
        };
        let start_rotation = if rotation_inherit {
            previous_segment
                .as_ref()
                .context("continuity implies a predecessor")?
                .end_pose
                .rotation
        } else {
            reader.rotation(rotation_full_precision)?
        };
        let end_rotation = if matches!(rotation_model, RotationModel::Slerp) {
            reader.rotation(rotation_full_precision)?
        } else {
            start_rotation
        };
        segments.push(RootSegment {
            root,
            start_tick,
            end_tick: start_tick + duration,
            position_model,
            rotation_model,
            start_pose: Pose {
                position: start_position,
                rotation: start_rotation,
            },
            end_pose: Pose {
                position: end_position,
                rotation: end_rotation,
            },
            start_velocity,
            end_velocity,
            rotation_full_precision,
            encoded_bytes: 0,
        });
    }
    Ok(segments)
}

#[allow(clippy::too_many_arguments)]
fn validate_gop(
    payload: &[u8],
    truth_ticks: &[Tick],
    rest_poses: &[Pose],
    actors: &[ActorDef],
    hz: u32,
    gravity: Vec3,
    shell_bound_m: f32,
    expected_epoch_anchors: bool,
    stream: bool,
    state: &mut TopologyState,
    counters: &mut Counters,
    replay_writer: &mut ReplayWriter,
    frame_telemetry: &mut Vec<PendingFrameTelemetry>,
    last_output_frame: &mut Option<u32>,
    header: &Header,
) -> Result<()> {
    let decoded = decode_gop_block(
        payload,
        actors.len(),
        rest_poses,
        expected_epoch_anchors,
        stream,
        header.physics_hz,
        header.gravity,
        state,
    )?;
    ensure!(
        decoded.tick_count as usize == truth_ticks.len()
            && decoded.start_tick == truth_ticks[0].index,
        "hierarchy GOP header mismatch"
    );
    decoded.begin(state)?;
    for (local_tick, truth) in truth_ticks.iter().enumerate() {
        let output_frame = truth.index.saturating_mul(30) / hz;
        let emit_frame = *last_output_frame != Some(output_frame);
        let mut reconstructed_poses = emit_frame.then(|| Vec::with_capacity(actors.len()));
        let mut sleeping = emit_frame.then(|| Vec::with_capacity(actors.len()));
        let mut frame_shell_m = 0.0_f32;
        let mut frame_screen_px = 0.0_f32;
        let mut visible_bodies = 0_u64;
        for event in decoded.apply_tick_events(state, local_tick as u32) {
            ensure!(
                event.epoch == truth.topology.epoch,
                "hierarchy epoch mismatch"
            );
            ensure!(
                event.broken == truth.topology.broken_edges,
                "hierarchy broken-edge mismatch"
            );
        }
        ensure!(
            state.roots == truth.topology.island_roots,
            "hierarchy island map mismatch at tick {}",
            truth.index
        );
        for (actor, truth_state) in truth.states.iter().enumerate() {
            let reconstructed =
                decoded.reconstruct_actor(state, truth.index, actor, hz, gravity)?;
            let shell = rigid_shell_error_meters(
                truth_state.pose,
                reconstructed,
                actors[actor].bounding_radius,
            );
            counters.max_shell_m = counters.max_shell_m.max(shell);
            frame_shell_m = frame_shell_m.max(shell);
            ensure!(
                shell <= shell_bound_m * 1.000_01,
                "post-zstd hierarchy shell error exceeded bound at tick {}, actor {}, root {}, residual {}: {} m",
                truth.index,
                actor,
                state.roots[actor],
                decoded.residuals.contains_key(&(truth.index, actor)),
                shell
            );
            if let Some(poses) = reconstructed_poses.as_mut() {
                poses.push(reconstructed);
                sleeping
                    .as_mut()
                    .expect("sleeping output accompanies poses")
                    .push(truth_state.sleeping());
                let mut actor_visible = false;
                for camera in header.cameras {
                    if sphere_in_view(
                        truth_state.pose.position,
                        actors[actor].bounding_radius,
                        camera,
                        header.pane_width,
                        header.pane_height,
                        0.0,
                    ) {
                        actor_visible = true;
                        frame_screen_px = frame_screen_px.max(projected_error_pixels(
                            truth_state.pose,
                            reconstructed,
                            actors[actor].bounding_radius,
                            camera,
                            header.pane_width,
                            header.pane_height,
                        ));
                    }
                }
                visible_bodies += u64::from(actor_visible);
            }
        }
        if let Some(poses) = reconstructed_poses {
            replay_writer.write_frame(
                &poses,
                &sleeping.expect("sleeping output accompanies poses"),
            )?;
            frame_telemetry.push(PendingFrameTelemetry {
                frame: output_frame,
                simulation_time: truth.index as f64 / hz as f64,
                visible_bodies,
                screen_error_px_max: frame_screen_px as f64,
                shell_error_cm_max: frame_shell_m as f64 * 100.0,
            });
            *last_output_frame = Some(output_frame);
        }
    }
    Ok(())
}

pub(crate) fn relative_pose(parent: Pose, child: Pose) -> Pose {
    let inverse = parent.rotation.normalize().conjugate();
    Pose {
        position: inverse * (child.position - parent.position),
        rotation: (inverse * child.rotation).normalize(),
    }
}

pub(crate) fn compose_pose(parent: Pose, local: Pose) -> Pose {
    Pose {
        position: parent.position + parent.rotation * local.position,
        rotation: (parent.rotation * local.rotation).normalize(),
    }
}

fn manifest_hash(
    global_ids: &[u64],
    rest_poses: &[Pose],
    edges: &[crate::trace::TopologyEdge],
) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    let mut add = |bytes: &[u8]| {
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    for (&global, pose) in global_ids.iter().zip(rest_poses) {
        add(&global.to_le_bytes());
        for component in pose.position.to_array() {
            add(&component.to_le_bytes());
        }
        for component in pose.rotation.to_array() {
            add(&component.to_le_bytes());
        }
    }
    for edge in edges {
        add(&edge.global_id.to_le_bytes());
        add(&edge.first.to_le_bytes());
        add(&edge.second.to_le_bytes());
        add(&[edge.kind]);
    }
    hash
}

fn archive_rotation(pose: Pose, radius: f32, shell_bound: f32) -> (Pose, bool) {
    let normalized = Pose {
        position: pose.position,
        rotation: pose.rotation.normalize(),
    };
    let quantized = Pose {
        position: pose.position,
        rotation: decode_quat32(encode_quat32(normalized.rotation)),
    };
    if radius <= 10.0
        && rigid_shell_error_meters(normalized, quantized, radius) <= shell_bound * 0.25
    {
        (quantized, false)
    } else {
        (normalized, true)
    }
}

fn hermite(p0: Vec3, p1: Vec3, v0: Vec3, v1: Vec3, t: f32, duration: f32) -> Vec3 {
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    p0 * h00 + v0 * (duration * h10) + p1 * h01 + v1 * (duration * h11)
}

fn position_tag(model: PositionModel) -> u8 {
    match model {
        PositionModel::Hold => 0,
        PositionModel::Linear => 1,
        PositionModel::Ballistic => 2,
        PositionModel::Hermite => 3,
    }
}

fn rotation_tag(model: RotationModel) -> u8 {
    match model {
        RotationModel::Hold => 0,
        RotationModel::Slerp => 1,
    }
}

fn track_key(tier: HierarchyTier, position: Vec3, cell_size: f32) -> HierarchyTrackKey {
    HierarchyTrackKey {
        tier,
        x: (position.x / cell_size).floor() as i32,
        z: (position.z / cell_size).floor() as i32,
    }
}

fn add_track(
    tracks: &mut BTreeMap<HierarchyTrackKey, TrackCounter>,
    key: HierarchyTrackKey,
    records: u64,
    bytes: u64,
) {
    let track = tracks.entry(key).or_default();
    track.records += records;
    track.raw_bytes += bytes;
}

fn write_track_csv(path: impl AsRef<Path>, tracks: &[HierarchyTrackReport]) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    writer.write_record([
        "tier",
        "cell_x",
        "cell_z",
        "records",
        "raw_bytes",
        "modeled_compressed_bytes",
    ])?;
    for track in tracks {
        writer.write_record([
            format!("{:?}", track.tier).to_lowercase(),
            track.x.to_string(),
            track.z.to_string(),
            track.records.to_string(),
            track.raw_bytes.to_string(),
            track.modeled_compressed_bytes.to_string(),
        ])?;
    }
    writer.flush()?;
    Ok(())
}

fn write_frame_telemetry_csv(
    path: impl AsRef<Path>,
    frames: &[PendingFrameTelemetry],
    active_tracks: usize,
    gop_compressed_bytes: &[u64],
    gop_ticks: u32,
    physics_hz: u32,
) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    let gop_seconds = gop_ticks as f64 / physics_hz as f64;
    for frame in frames {
        let gop = (frame.simulation_time / gop_seconds).floor() as usize;
        let rolling_mbps = gop_compressed_bytes
            .get(gop.min(gop_compressed_bytes.len().saturating_sub(1)))
            .copied()
            .unwrap_or(0) as f64
            * 8.0
            / gop_seconds
            / 1_000_000.0;
        writer.serialize(HierarchyFrameTelemetry {
            route: "hierarchy-four-cameras",
            frame: frame.frame,
            simulation_time: frame.simulation_time,
            active_tracks,
            rolling_mbps,
            visible_bodies: frame.visible_bodies,
            missing_visible_bodies: 0,
            screen_error_px_max: frame.screen_error_px_max,
            shell_error_cm_max: frame.shell_error_cm_max,
        })?;
    }
    writer.flush()?;
    Ok(())
}

fn percentile_u64(sorted: &[u64], percentile: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * percentile.clamp(0.0, 1.0)).floor() as usize;
    sorted[index]
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn write_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn write_var_u32(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn zigzag_i32(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

fn unzigzag_i32(value: u32) -> i32 {
    ((value >> 1) as i32) ^ -((value & 1) as i32)
}

fn write_vec3(out: &mut Vec<u8>, value: Vec3) {
    for component in value.to_array() {
        out.extend_from_slice(&component.to_le_bytes());
    }
}

/// Reconstructs a position from its cell/local integer pair using exactly the
/// expression `Reader::cell_vec3` applies, so a value decodes identically
/// whether it arrived absolutely or as a delta.
fn decode_cell_local(cells: [i32; 3], locals: [u16; 3]) -> Vec3 {
    let mut decoded = [0.0_f32; 3];
    for axis in 0..3 {
        decoded[axis] = cells[axis] as f32 * POSITION_CELL_M
            + locals[axis] as f32 * POSITION_CELL_M / POSITION_QUANTA;
    }
    Vec3::from_array(decoded)
}

/// Writes a cell/local pair as per-axis deltas against a prediction.
///
/// The integer pair is carried, never a merged grid index: `(c, 65535)` and
/// `(c + 1, 0)` are adjacent lattice points whose decoded `f32` differs, so
/// collapsing them into one coordinate would silently change reconstruction.
fn write_cell_delta(
    out: &mut Vec<u8>,
    cells: [i32; 3],
    locals: [u16; 3],
    predicted_cells: [i32; 3],
    predicted_locals: [u16; 3],
) {
    for axis in 0..3 {
        write_var_u32(
            out,
            zigzag_i32(cells[axis].wrapping_sub(predicted_cells[axis])),
        );
        write_var_u32(
            out,
            zigzag_i32(locals[axis] as i32 - predicted_locals[axis] as i32),
        );
    }
}

/// What `write_rotation` + `Reader::rotation` round-trip a rotation to.
fn decoded_rotation(value: Quat, full_precision: bool) -> Quat {
    if full_precision {
        value
    } else {
        decode_quat32(encode_quat32(value))
    }
}

/// What `write_velocity` + `Reader::velocity` round-trip a velocity to.
fn decoded_velocity(value: Vec3) -> Vec3 {
    let scaled = value / VELOCITY_STEP_MPS;
    if scaled
        .to_array()
        .into_iter()
        .all(|component| component.abs() <= i16::MAX as f32)
    {
        Vec3::from_array(
            scaled
                .to_array()
                .map(|component| component.round() as i16 as f32 * VELOCITY_STEP_MPS),
        )
    } else {
        value
    }
}

/// Bit pattern of a quaternion's components, for exact-equality tests where
/// `PartialEq` on floats would be too loose to guarantee bit-identical output.
fn quat_bits(value: Quat) -> [u32; 4] {
    value.to_array().map(f32::to_bits)
}

/// The cell/local decomposition `write_cell_vec3` serializes, without writing.
fn cell_components(value: Vec3) -> ([i32; 3], [u16; 3]) {
    let mut cells = [0_i32; 3];
    let mut locals = [0_u16; 3];
    for (index, component) in value.to_array().into_iter().enumerate() {
        let cell = (component / POSITION_CELL_M).floor() as i32;
        let origin = cell as f32 * POSITION_CELL_M;
        cells[index] = cell;
        locals[index] =
            (((component - origin) / POSITION_CELL_M).clamp(0.0, 1.0) * POSITION_QUANTA).round()
                as u16;
    }
    (cells, locals)
}

fn write_cell_vec3(out: &mut Vec<u8>, value: Vec3) -> Vec3 {
    let mut decoded = [0.0; 3];
    for (index, component) in value.to_array().into_iter().enumerate() {
        let cell = (component / POSITION_CELL_M).floor() as i32;
        let origin = cell as f32 * POSITION_CELL_M;
        let local = ((component - origin) / POSITION_CELL_M).clamp(0.0, 1.0);
        let quantized = (local * POSITION_QUANTA).round() as u16;
        write_var_u32(out, zigzag_i32(cell));
        out.extend_from_slice(&quantized.to_le_bytes());
        decoded[index] = origin + quantized as f32 * POSITION_CELL_M / POSITION_QUANTA;
    }
    Vec3::from_array(decoded)
}

fn write_velocity(out: &mut Vec<u8>, value: Vec3) -> Vec3 {
    let scaled = value / VELOCITY_STEP_MPS;
    if scaled
        .to_array()
        .into_iter()
        .all(|component| component.round().abs() <= i16::MAX as f32)
    {
        out.push(0);
        let mut decoded = [0.0; 3];
        for (index, component) in scaled.to_array().into_iter().enumerate() {
            let quantized = component.round() as i16;
            out.extend_from_slice(&quantized.to_le_bytes());
            decoded[index] = quantized as f32 * VELOCITY_STEP_MPS;
        }
        Vec3::from_array(decoded)
    } else {
        out.push(1);
        write_vec3(out, value);
        value
    }
}

fn write_quat(out: &mut Vec<u8>, value: Quat) {
    for component in value.to_array() {
        out.extend_from_slice(&component.to_le_bytes());
    }
}

fn write_rotation(out: &mut Vec<u8>, value: Quat, full_precision: bool) {
    if full_precision {
        write_quat(out, value);
    } else {
        out.extend_from_slice(&encode_quat32(value).to_le_bytes());
    }
}

fn write_compact_pose(out: &mut Vec<u8>, value: Pose, radius: f32, shell_bound: f32) -> Pose {
    let mut compact = Vec::with_capacity(26);
    let position = write_cell_vec3(&mut compact, value.position);
    let normalized = value.rotation.normalize();
    let quantized_code = encode_quat32(normalized);
    let quantized = decode_quat32(quantized_code);
    let full_precision = radius > 10.0
        || rigid_shell_error_meters(
            Pose {
                position: value.position,
                rotation: normalized,
            },
            Pose {
                position: value.position,
                rotation: quantized,
            },
            radius,
        ) > shell_bound * 0.25;
    compact.push(u8::from(full_precision));
    if full_precision {
        write_quat(&mut compact, normalized);
    } else {
        compact.extend_from_slice(&quantized_code.to_le_bytes());
    }
    let decoded = Pose {
        position,
        rotation: if full_precision {
            normalized
        } else {
            quantized
        },
    };
    if rigid_shell_error_meters(value, decoded, radius) <= shell_bound {
        out.push(0);
        out.extend_from_slice(&compact);
        decoded
    } else {
        out.push(1);
        write_vec3(out, value.position);
        write_quat(out, normalized);
        Pose {
            position: value.position,
            rotation: normalized,
        }
    }
}

/// Rebuilds the packed representation from the rANS-decoded description. Both
/// forms describe the same quantized values, so reconstruction is identical.
fn packed_from_coding(coding: ResidualCoding) -> Result<PackedResidual> {
    let position = if coding.tag & 1 == 0 {
        ResidualPosition::Delta(coding.delta)
    } else {
        let mut decoded = [0.0_f32; 3];
        for index in 0..3 {
            decoded[index] = coding.absolute_cell[index] as f32 * POSITION_CELL_M
                + coding.absolute_local[index] as f32 * POSITION_CELL_M / POSITION_QUANTA;
        }
        ResidualPosition::Absolute(Vec3::from_array(decoded))
    };
    let rotation = match (coding.tag >> 1) & 0b11 {
        0 => ResidualRotation::Identity,
        1 => ResidualRotation::Quat32Delta(coding.quat32),
        2 => ResidualRotation::Snorm16Delta(coding.snorm),
        3 => ResidualRotation::Full(
            Quat::from_xyzw(
                coding.full[0],
                coding.full[1],
                coding.full[2],
                coding.full[3],
            )
            .normalize(),
        ),
        tier => anyhow::bail!("unknown residual rotation tier {tier}"),
    };
    Ok(PackedResidual { position, rotation })
}

fn write_packed_residual(
    out: &mut Vec<u8>,
    value: Pose,
    predicted: Pose,
    radius: f32,
    shell_bound: f32,
    rotation_tiers: &mut [u64; 4],
    observed: &mut ResidualCoding,
) -> Pose {
    // One combined tag byte for both fields, backfilled once the rotation tier
    // is known: bit 0 is the position tier, bits 1-2 the rotation tier. Two
    // near-always-zero tag bytes per record were 5.2 MB of the v4 stream.
    let tag_offset = out.len();
    out.push(0);

    let scaled_delta = (value.position - predicted.position) / RESIDUAL_POSITION_STEP_M;
    let (position, position_tag) = if scaled_delta
        .to_array()
        .into_iter()
        .all(|component| component.round().abs() <= i16::MAX as f32)
    {
        let mut delta = [0_i16; 3];
        for (output, component) in delta.iter_mut().zip(scaled_delta.to_array()) {
            *output = component.round() as i16;
            out.extend_from_slice(&output.to_le_bytes());
        }
        observed.delta = delta;
        (ResidualPosition::Delta(delta), 0_u8)
    } else {
        let (cell, local) = cell_components(value.position);
        observed.absolute_cell = cell;
        observed.absolute_local = local;
        (
            ResidualPosition::Absolute(write_cell_vec3(out, value.position)),
            1_u8,
        )
    };

    // Code the rotation against the prediction and take the cheapest tier whose
    // reconstruction still satisfies the shell bound. The bound is evaluated on
    // the full pose, so the position tier chosen above is already accounted for.
    let normalized = value.rotation.normalize();
    let delta = (predicted.rotation.normalize().inverse() * normalized).normalize();
    let fits = |rotation: ResidualRotation| {
        let candidate = PackedResidual { position, rotation }.pose(predicted);
        rigid_shell_error_meters(value, candidate, radius) <= shell_bound
    };

    let quat32 = encode_quat32(delta);
    let components = delta
        .to_array()
        .map(|component| (component.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16);
    let rotation = if fits(ResidualRotation::Identity) {
        ResidualRotation::Identity
    } else if fits(ResidualRotation::Quat32Delta(quat32)) {
        ResidualRotation::Quat32Delta(quat32)
    } else if fits(ResidualRotation::Snorm16Delta(components)) {
        ResidualRotation::Snorm16Delta(components)
    } else {
        ResidualRotation::Full(normalized)
    };

    let rotation_tag = match rotation {
        ResidualRotation::Identity => 0_u8,
        ResidualRotation::Quat32Delta(packed) => {
            observed.quat32 = packed;
            out.extend_from_slice(&packed.to_le_bytes());
            1
        }
        ResidualRotation::Snorm16Delta(components) => {
            observed.snorm = components;
            for component in components {
                out.extend_from_slice(&component.to_le_bytes());
            }
            2
        }
        ResidualRotation::Full(value) => {
            observed.full = value.to_array();
            write_quat(out, value);
            3
        }
    };
    rotation_tiers[rotation_tag as usize] += 1;
    out[tag_offset] = position_tag | (rotation_tag << 1);
    observed.tag = out[tag_offset];

    PackedResidual { position, rotation }.pose(predicted)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .context("hierarchy overflow")?;
        ensure!(end <= self.bytes.len(), "truncated hierarchy payload");
        let bytes = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn var_u32(&mut self) -> Result<u32> {
        let mut value = 0_u32;
        for shift in (0..35).step_by(7) {
            let byte = self.u8()?;
            ensure!(
                shift < 28 || byte & 0xf0 == 0,
                "hierarchy varint exceeds u32"
            );
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        anyhow::bail!("unterminated hierarchy varint")
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into()?))
    }

    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn vec3(&mut self) -> Result<Vec3> {
        Ok(Vec3::new(self.f32()?, self.f32()?, self.f32()?))
    }

    fn cell_vec3(&mut self) -> Result<Vec3> {
        let mut decoded = [0.0; 3];
        for component in &mut decoded {
            let cell = unzigzag_i32(self.var_u32()?);
            let quantized = u16::from_le_bytes(self.take(2)?.try_into()?);
            *component = cell as f32 * POSITION_CELL_M
                + quantized as f32 * POSITION_CELL_M / POSITION_QUANTA;
        }
        Ok(Vec3::from_array(decoded))
    }

    /// Cell/local pair coded as per-axis deltas against a prediction. Carries
    /// the integer pair rather than a merged coordinate so the reconstruction
    /// is bit-identical to the absolute path.
    fn cell_vec3_delta(&mut self, predicted: Vec3) -> Result<Vec3> {
        let (predicted_cells, predicted_locals) = cell_components(predicted);
        let mut cells = [0_i32; 3];
        let mut locals = [0_u16; 3];
        for axis in 0..3 {
            cells[axis] = predicted_cells[axis].wrapping_add(unzigzag_i32(self.var_u32()?));
            let local = predicted_locals[axis] as i32 + unzigzag_i32(self.var_u32()?);
            ensure!(
                (0..=i32::from(u16::MAX)).contains(&local),
                "hierarchy cell-local delta out of range"
            );
            locals[axis] = local as u16;
        }
        Ok(decode_cell_local(cells, locals))
    }

    fn velocity(&mut self) -> Result<Vec3> {
        match self.u8()? {
            0 => {
                let mut decoded = [0.0; 3];
                for component in &mut decoded {
                    let quantized = i16::from_le_bytes(self.take(2)?.try_into()?);
                    *component = quantized as f32 * VELOCITY_STEP_MPS;
                }
                Ok(Vec3::from_array(decoded))
            }
            1 => self.vec3(),
            tag => anyhow::bail!("unknown hierarchy velocity tag {tag}"),
        }
    }

    fn quat(&mut self) -> Result<Quat> {
        Ok(Quat::from_xyzw(
            self.f32()?,
            self.f32()?,
            self.f32()?,
            self.f32()?,
        ))
    }

    fn rotation(&mut self, full_precision: bool) -> Result<Quat> {
        if full_precision {
            self.quat()
        } else {
            Ok(decode_quat32(self.u32()?))
        }
    }

    fn compact_pose(&mut self) -> Result<Pose> {
        match self.u8()? {
            0 => {
                let position = self.cell_vec3()?;
                let full_precision = self.u8()? != 0;
                Ok(Pose {
                    position,
                    rotation: self.rotation(full_precision)?,
                })
            }
            1 => Ok(Pose {
                position: self.vec3()?,
                rotation: self.quat()?.normalize(),
            }),
            tag => anyhow::bail!("unknown hierarchy compact pose tag {tag}"),
        }
    }

    fn packed_residual(&mut self) -> Result<PackedResidual> {
        let tag = self.u8()?;
        ensure!(tag & !0b111 == 0, "unknown hierarchy residual tag bits {tag}");
        let position = match tag & 1 {
            0 => {
                let mut delta = [0_i16; 3];
                for component in &mut delta {
                    *component = i16::from_le_bytes(self.take(2)?.try_into()?);
                }
                ResidualPosition::Delta(delta)
            }
            _ => ResidualPosition::Absolute(self.cell_vec3()?),
        };
        let rotation = match (tag >> 1) & 0b11 {
            0 => ResidualRotation::Identity,
            1 => ResidualRotation::Quat32Delta(u32::from_le_bytes(self.take(4)?.try_into()?)),
            2 => {
                let mut components = [0_i16; 4];
                for component in &mut components {
                    *component = i16::from_le_bytes(self.take(2)?.try_into()?);
                }
                ResidualRotation::Snorm16Delta(components)
            }
            _ => ResidualRotation::Full(self.quat()?.normalize()),
        };
        Ok(PackedResidual { position, rotation })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{ActorState, TopologyTick};

    #[test]
    fn relative_pose_round_trip_is_exact_enough() {
        let parent = Pose {
            position: Vec3::new(4.0, 2.0, -3.0),
            rotation: Quat::from_rotation_y(0.7),
        };
        let child = Pose {
            position: Vec3::new(5.0, 3.0, 8.0),
            rotation: Quat::from_rotation_x(-0.2),
        };
        let reconstructed = compose_pose(parent, relative_pose(parent, child));
        assert!(reconstructed.position.distance(child.position) < 1e-5);
        assert!(reconstructed.rotation.dot(child.rotation).abs() > 0.999_99);
    }

    #[test]
    fn delivery_never_exceeds_independent_baseline() {
        let fallback = select_delivery(200, 100, true, true);
        assert_eq!(fallback.mode, "independent_fallback");
        assert_eq!(fallback.compressed_bytes, 100);
        assert!(!fallback.hierarchy_adopted);

        let adopted = select_delivery(50, 100, true, true);
        assert_eq!(adopted.mode, "hierarchy");
        assert_eq!(adopted.compressed_bytes, 50);
        assert!(adopted.hierarchy_adopted);

        let partial = select_delivery(90, 100, true, true);
        assert_eq!(partial.mode, "hierarchy_partial");
        assert_eq!(partial.compressed_bytes, 90);
        assert!(!partial.hierarchy_adopted);
    }

    #[test]
    fn compact_vectors_round_trip_within_wire_budget() {
        for value in [
            Vec3::new(0.0, 1.25, -2.5),
            Vec3::new(127.99, -4096.5, 10_000.0),
        ] {
            let mut bytes = Vec::new();
            let encoded = write_cell_vec3(&mut bytes, value);
            let decoded = Reader::new(&bytes).cell_vec3().unwrap();
            assert_eq!(encoded, decoded);
            assert!(decoded.distance(value) <= 0.000_43);
            assert!(bytes.len() < 12);
        }

        let velocity = Vec3::new(12.25, -3.0, 0.125);
        let mut bytes = Vec::new();
        let encoded = write_velocity(&mut bytes, velocity);
        let decoded = Reader::new(&bytes).velocity().unwrap();
        assert_eq!(encoded, decoded);
        assert!(decoded.distance(velocity) <= VELOCITY_STEP_MPS);
        assert_eq!(bytes.len(), 7);
    }

    #[test]
    fn hierarchy_varints_round_trip_actor_and_tick_ranges() {
        for value in [0, 1, 127, 128, 6_119, u32::MAX] {
            let mut bytes = Vec::new();
            write_var_u32(&mut bytes, value);
            assert_eq!(Reader::new(&bytes).var_u32().unwrap(), value);
        }
    }

    #[test]
    fn compact_pose_matches_literal_wire_for_real_trace_sample() {
        let pose = Pose {
            position: Vec3::new(-1.263_040_2, 0.140_000_64, -26.245_184),
            rotation: Quat::from_xyzw(0.680_467_55, 0.192_259_13, -0.192_258_85, 0.680_467_96),
        };
        let mut bytes = Vec::new();
        let encoded = write_compact_pose(&mut bytes, pose, 2.103_140_6, 0.005);
        let decoded = Reader::new(&bytes).compact_pose().unwrap();
        assert!(encoded.position.distance(decoded.position) < 1e-7);
        assert!(encoded.rotation.dot(decoded.rotation).abs() > 0.999_999);
        assert!(
            rigid_shell_error_meters(pose, decoded, 2.103_140_6) <= 0.005,
            "error={} bytes={bytes:?} encoded={encoded:?} decoded={decoded:?}",
            rigid_shell_error_meters(pose, decoded, 2.103_140_6)
        );
    }

    fn stream_fixture_actor(id: u32) -> ActorDef {
        ActorDef {
            id,
            part: 0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            shapes: Vec::new(),
            bounding_radius: 0.5,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn stream_fixture_tick(
        index: u32,
        hz: u32,
        island_roots: Vec<u32>,
        epoch: u32,
        broken_edges: Vec<u64>,
        changed_roots: Vec<(u32, u32)>,
        root_origin: Vec3,
        root_velocity: Vec3,
    ) -> Tick {
        let locals = [
            Pose::default(),
            Pose {
                position: Vec3::new(1.0, 0.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            Pose {
                position: Vec3::new(0.0, 1.0, 0.0),
                rotation: Quat::IDENTITY,
            },
        ];
        let root_pose = Pose {
            position: root_origin + root_velocity * (index as f32 / hz as f32),
            rotation: Quat::IDENTITY,
        };
        let states = island_roots
            .iter()
            .enumerate()
            .map(|(actor, &root)| {
                let pose = if root == 0 {
                    compose_pose(root_pose, locals[actor])
                } else {
                    // Split-off island holds its last attached pose.
                    compose_pose(
                        Pose {
                            position: root_origin + root_velocity * (6.0 / hz as f32),
                            rotation: Quat::IDENTITY,
                        },
                        locals[actor],
                    )
                };
                ActorState {
                    pose,
                    linear_velocity: if root == 0 { root_velocity } else { Vec3::ZERO },
                    angular_velocity: Vec3::ZERO,
                    contacts: 0,
                    intact_joints: 0,
                    flags: 0,
                }
            })
            .collect();
        Tick {
            index,
            simulation_time: index as f32 / hz as f32,
            states,
            contact_pairs: Vec::new(),
            topology: TopologyTick {
                epoch,
                broken_edges,
                changed_roots,
                island_roots,
            },
        }
    }

    #[test]
    fn stream_delta_block_reconstructs_with_carried_state() {
        let hz = 120;
        let shell_bound = 0.005_f32;
        let actors: Vec<_> = (0..3).map(stream_fixture_actor).collect();
        let gravity = Vec3::new(0.0, -9.81, 0.0);
        let velocity = Vec3::new(0.5, 0.0, 0.0);
        let config = HierarchyConfig {
            max_span_ticks: 0,
            symbol_audit: false,
            mask: MaskConfig::default(),
            budget: BudgetConfig::default(),
            root_rans: false,
            residual_rans: false,
            shell_bound_m: shell_bound,
            gop_ticks: 6,
            cell_size_m: 128.0,
            target_tracks: 30,
            baseline_seekable_bytes: 0,
        };
        let first_block: Vec<_> = (0..6)
            .map(|index| {
                stream_fixture_tick(
                    index,
                    hz,
                    vec![0, 0, 0],
                    0,
                    Vec::new(),
                    Vec::new(),
                    Vec3::ZERO,
                    velocity,
                )
            })
            .collect();
        // Actor 2 splits into its own island exactly at the second block's
        // first tick: a delta block must carry this as a boundary event.
        let second_block: Vec<_> = (6..12)
            .map(|index| {
                stream_fixture_tick(
                    index,
                    hz,
                    vec![0, 0, 2],
                    1,
                    if index == 6 { vec![42] } else { Vec::new() },
                    if index == 6 { vec![(2, 2)] } else { Vec::new() },
                    Vec3::ZERO,
                    velocity,
                )
            })
            .collect();
        let rest_poses: Vec<_> = first_block[0]
            .states
            .iter()
            .map(|state| state.pose)
            .collect();

        // Archive and stream-keyframe payloads differ only by the framing byte.
        let mut archive_counters = Counters::default();
        let mut archive_tracks = BTreeMap::new();
        let archive_payload = encode_gop_block(
            &first_block,
            &rest_poses,
            &actors,
            hz,
            gravity,
            &config,
            true,
            BlockMode::Archive,
            &mut archive_counters,
            &mut archive_tracks,
            &mut MaskState::default(),
            &mut BudgetState::default(),
        )
        .unwrap();

        let mut encoder_state = TopologyState::default();
        let mut counters = Counters::default();
        let mut tracks = BTreeMap::new();
        let mut stream_mask = MaskState::default();
        let mut stream_budget = BudgetState::default();
        let keyframe_payload = encode_gop_block(
            &first_block,
            &rest_poses,
            &actors,
            hz,
            gravity,
            &config,
            true,
            BlockMode::StreamKeyframe(&mut encoder_state),
            &mut counters,
            &mut tracks,
            &mut stream_mask,
            &mut stream_budget,
        )
        .unwrap();
        assert_eq!(keyframe_payload[..12], archive_payload[..12]);
        assert_eq!(keyframe_payload[12], 1);
        assert_eq!(keyframe_payload[13..], archive_payload[12..]);

        let delta_payload = encode_gop_block(
            &second_block,
            &rest_poses,
            &actors,
            hz,
            gravity,
            &config,
            true,
            BlockMode::StreamDelta(&mut encoder_state),
            &mut counters,
            &mut tracks,
            &mut stream_mask,
            &mut stream_budget,
        )
        .unwrap();

        let mut state = TopologyState::default();
        // A delta block decodes only against the exact state its predecessor
        // left behind -- continuity coding reads the carried tail segments --
        // so the pre-delta state is snapshotted for the re-decode below.
        let mut state_before_delta = TopologyState::default();
        for (payload, truth) in [
            (&keyframe_payload, &first_block),
            (&delta_payload, &second_block),
        ] {
            if std::ptr::eq(payload, &delta_payload) {
                state_before_delta = state.clone();
            }
            let decoded = decode_gop_block(payload, actors.len(), &rest_poses, true, true, hz, gravity, &state).unwrap();
            assert_eq!(decoded.keyframe, truth[0].index == 0);
            decoded.begin(&mut state).unwrap();
            for (local_tick, tick) in truth.iter().enumerate() {
                decoded.apply_tick_events(&mut state, local_tick as u32);
                assert_eq!(state.roots, tick.topology.island_roots);
                for (actor, truth_state) in tick.states.iter().enumerate() {
                    let reconstructed = decoded
                        .reconstruct_actor(&state, tick.index, actor, hz, gravity)
                        .unwrap();
                    let shell = rigid_shell_error_meters(
                        truth_state.pose,
                        reconstructed,
                        actors[actor].bounding_radius,
                    );
                    assert!(
                        shell <= shell_bound * 1.000_01,
                        "shell {shell} at tick {}, actor {actor}",
                        tick.index
                    );
                }
            }
        }
        // Encoder-carried state matches the receiver's literal decoded state.
        assert_eq!(encoder_state.roots, state.roots);
        for (encoder_local, decoder_local) in encoder_state.locals.iter().zip(&state.locals) {
            assert!(encoder_local.position.distance(decoder_local.position) < 1e-7);
            assert!(encoder_local.rotation.dot(decoder_local.rotation).abs() > 0.999_999);
        }
        // A settled split-off island reads back as a hold tick.
        assert!(
            decode_gop_block(
                &delta_payload,
                actors.len(),
                &rest_poses,
                true,
                true,
                hz,
                gravity,
                &state_before_delta,
            )
                .unwrap()
                .is_hold_tick(&state, 11, 2)
        );
    }

    /// The v7 delta path must decode to exactly the same `f32` the absolute
    /// path would produce, for every prediction. This is what lets wire v7 be
    /// a pure re-representation: reconstruction, and therefore every shell and
    /// visual gate, is untouched.
    #[test]
    fn cell_delta_decodes_bit_identically_to_the_absolute_path() {
        // Includes values that land on cell boundaries, where `(c, 65535)` and
        // `(c + 1, 0)` are distinct lattice points with different decoded f32 --
        // the case a merged grid index would silently corrupt.
        let values = [
            Vec3::ZERO,
            Vec3::new(31.999_996, -32.000_004, 63.999_996),
            Vec3::new(-0.000_004, 32.0, -64.0),
            Vec3::new(123.456, -789.012, 0.5),
            Vec3::new(-1.27, 0.14, -26.24),
        ];
        let predictions = [
            Vec3::ZERO,
            Vec3::new(32.0, -32.0, 64.0),
            Vec3::new(-1000.0, 1000.0, 0.0),
            Vec3::new(31.999_996, -32.000_004, 63.999_996),
        ];
        for value in values {
            let mut absolute = Vec::new();
            let decoded_absolute = write_cell_vec3(&mut absolute, value);
            let (cells, locals) = cell_components(value);
            for predicted in predictions {
                let (predicted_cells, predicted_locals) = cell_components(predicted);
                let mut delta = Vec::new();
                write_cell_delta(&mut delta, cells, locals, predicted_cells, predicted_locals);
                let mut reader = Reader::new(&delta);
                let decoded_delta = reader.cell_vec3_delta(predicted).unwrap();
                assert!(reader.is_empty(), "delta reader left trailing bytes");
                assert_eq!(
                    decoded_delta.to_array().map(f32::to_bits),
                    decoded_absolute.to_array().map(f32::to_bits),
                    "delta path diverged for {value:?} predicted from {predicted:?}"
                );
            }
        }
    }

    #[test]
    fn cell_delta_rejects_a_local_component_out_of_range() {
        // A corrupt stream must fail loudly rather than wrap into a wrong cell.
        let mut bytes = Vec::new();
        write_var_u32(&mut bytes, zigzag_i32(0));
        write_var_u32(&mut bytes, zigzag_i32(-1));
        write_var_u32(&mut bytes, zigzag_i32(0));
        write_var_u32(&mut bytes, zigzag_i32(0));
        write_var_u32(&mut bytes, zigzag_i32(0));
        write_var_u32(&mut bytes, zigzag_i32(0));
        let mut reader = Reader::new(&bytes);
        // Prediction quantizes to local 0 on x, so a -1 delta underflows.
        assert!(reader.cell_vec3_delta(Vec3::ZERO).is_err());
    }

    #[test]
    fn packed_residual_round_trips_against_prediction() {
        let predicted = Pose {
            position: Vec3::new(-1.27, 0.14, -26.24),
            rotation: Quat::from_rotation_y(0.25),
        };
        let truth = Pose {
            position: Vec3::new(-1.263_040_2, 0.140_000_64, -26.245_184),
            rotation: Quat::from_xyzw(0.680_467_55, 0.192_259_13, -0.192_258_85, 0.680_467_96),
        };
        let mut bytes = Vec::new();
        let encoded = write_packed_residual(&mut bytes, truth, predicted, 2.103_140_6, 0.005, &mut [0; 4], &mut ResidualCoding::default());
        let decoded = Reader::new(&bytes)
            .packed_residual()
            .unwrap()
            .pose(predicted);
        assert!(encoded.position.distance(decoded.position) < 1e-7);
        assert!(encoded.rotation.dot(decoded.rotation).abs() > 0.999_999);
        assert!(rigid_shell_error_meters(truth, decoded, 2.103_140_6) <= 0.005);
        assert!(bytes.len() < 28);
    }
}
