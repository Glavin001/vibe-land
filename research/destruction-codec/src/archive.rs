//! Camera-independent rigid-body archive and post-encode spectator evaluator.
//!
//! The encoder never receives a camera. It writes bounded-error transform
//! segments, then projects those immutable records into shared spatial/tier
//! tracks. Spectator routes are evaluated only after the archive hash is fixed.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{ensure, Context, Result};
use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use crate::{
    codec::{
        angular_error_degrees, decode_quat32, encode_quat32, projected_error_pixels,
        rigid_shell_error_meters,
    },
    hierarchy::{self, HierarchyConfig, HierarchyReport},
    interest::sphere_in_view,
    replay::ReplayWriter,
    trace::{ActorDef, ActorState, Camera, Pose, TraceReader},
};

const MAGIC: &[u8; 8] = b"TWARCH1\0";
const GLOBAL_EVENTS_TRACK: u32 = 0;

#[derive(Clone, Debug)]
pub struct ArchiveConfig {
    pub shell_error_mm: f32,
    pub gop_ms: u32,
    pub max_segment_ms: u32,
    pub cell_size_m: f32,
    pub supercell_size_m: f32,
    pub target_tracks: usize,
    pub hard_track_cap: usize,
    pub route_file: Option<PathBuf>,
    pub require_pass: bool,
    pub symbol_audit: bool,
    pub residual_rans: bool,
    pub root_rans: bool,
    pub mask: crate::mask::MaskConfig,
    pub budget: crate::budget::BudgetConfig,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum PositionModel {
    Hold,
    Linear,
    Ballistic,
    Hermite,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum RotationModel {
    Hold,
    Slerp,
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    tick: u32,
    pose: Pose,
    linear_velocity: Vec3,
}

#[derive(Clone, Debug)]
struct MotionSegment {
    start_tick: u32,
    end_tick: u32,
    position_model: PositionModel,
    rotation_model: RotationModel,
    start_pose: Pose,
    end_pose: Pose,
    start_velocity: Vec3,
    end_velocity: Vec3,
    rotation_full_precision: bool,
    encoded_bytes: usize,
    detail_track: u32,
    coarse_track: u32,
}

impl MotionSegment {
    fn pose_at(&self, tick: u32, hz: u32, gravity: Vec3) -> Pose {
        let duration_ticks = self.end_tick.saturating_sub(self.start_tick);
        let alpha = if duration_ticks == 0 {
            0.0
        } else {
            tick.saturating_sub(self.start_tick) as f32 / duration_ticks as f32
        }
        .clamp(0.0, 1.0);
        let duration = duration_ticks as f32 / hz as f32;
        let local_time = alpha * duration;
        let position = match self.position_model {
            PositionModel::Hold => self.start_pose.position,
            PositionModel::Linear => self.start_pose.position.lerp(self.end_pose.position, alpha),
            PositionModel::Ballistic => {
                self.start_pose.position
                    + self.start_velocity * local_time
                    + gravity * (0.5 * local_time * local_time)
            }
            PositionModel::Hermite => hermite(
                self.start_pose.position,
                self.end_pose.position,
                self.start_velocity,
                self.end_velocity,
                alpha,
                duration,
            ),
        };
        let rotation = match self.rotation_model {
            RotationModel::Hold => self.start_pose.rotation,
            RotationModel::Slerp => {
                let end = if self.start_pose.rotation.dot(self.end_pose.rotation) < 0.0 {
                    -self.end_pose.rotation
                } else {
                    self.end_pose.rotation
                };
                self.start_pose.rotation.slerp(end, alpha).normalize()
            }
        };
        Pose { position, rotation }
    }
}

#[derive(Clone, Copy, Debug)]
struct ArchiveEvent {
    tick: u32,
    flags: u8,
    mode: u8,
}

#[derive(Default)]
struct ActorBuilder {
    pending: Vec<Sample>,
    segments: Vec<MotionSegment>,
    events: Vec<ArchiveEvent>,
    exact_overrides: BTreeMap<u32, Pose>,
    previous_mode: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
enum TrackTier {
    Events,
    Coarse,
    Detail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct TrackKey {
    tier: TrackTier,
    x: i32,
    z: i32,
}

#[derive(Clone, Debug)]
struct TrackData {
    id: u32,
    key: TrackKey,
    total_bytes: u64,
    tick_bytes: Vec<u64>,
}

#[derive(Clone, Debug, Serialize)]
struct TrackReport {
    id: u32,
    tier: TrackTier,
    x: i32,
    z: i32,
    total_bytes: u64,
    average_mbps: f64,
    peak_tick_mbps: f64,
}

#[derive(Clone, Debug, Serialize)]
struct CodecModelReport {
    segments: u64,
    hold_segments: u64,
    linear_segments: u64,
    ballistic_segments: u64,
    hermite_segments: u64,
    event_records: u64,
    exact_override_records: u64,
    max_segment_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
struct BaselineReport {
    source_trace_bytes: u64,
    raw_modeled_bytes: u64,
    semantic_lossless_bytes: u64,
    archive_bytes: u64,
    seekable_zstd_bytes: u64,
    archive_ratio_vs_raw: f64,
    seekable_zstd_ratio_vs_raw: f64,
    archive_average_mbps: f64,
    seekable_zstd_average_mbps: f64,
    encode_wall_ms: f64,
    decode_validation_wall_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
struct GopReport {
    index: u32,
    start_tick: u32,
    end_tick: u32,
    segment_records: u64,
    event_records: u64,
    exact_override_records: u64,
    uncompressed_bytes: u64,
    compressed_bytes: u64,
    file_offset: u64,
}

#[derive(Clone, Debug, Serialize)]
struct ErrorReport {
    shell_cm_p95: f64,
    shell_cm_p99: f64,
    shell_cm_max: f64,
    shell_max_actor: usize,
    shell_max_tick: u32,
    shell_max_segment_start: u32,
    shell_max_segment_end: u32,
    shell_max_position_model: PositionModel,
    shell_max_rotation_model: RotationModel,
    shell_max_actor_radius: f32,
    position_cm_p99: f64,
    rotation_deg_p99: f64,
    event_mismatches: u64,
    final_divergent_bodies: u64,
    pass: bool,
}

#[derive(Clone, Debug, Serialize)]
struct ResidualReport {
    samples: u64,
    fixed_i16_bytes: u64,
    zigzag_leb128_bytes: u64,
    best_rice_k: u8,
    best_rice_bytes: u64,
    zero_run_bytes: u64,
    shannon_lower_bound_bytes_with_table: u64,
    zstd_level3_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
struct AdvancedAblationReport {
    contact_cluster_status: &'static str,
    contact_cluster_reason: &'static str,
    coherent_timing_groups: u64,
    metadata_only_upper_bound_bytes_saved: u64,
    contact_pair_samples: u64,
    coherent_contact_pair_samples: u64,
    max_contact_pairs_per_tick: usize,
    unbounded_visibility_status: &'static str,
    unbounded_visibility_reason: &'static str,
    safely_omittable_for_arbitrary_camera: u64,
    timing_header_batching_status: &'static str,
    field_mask_status: &'static str,
    residual_entropy_status: &'static str,
    static_suppression_status: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct ArchiveReport {
    schema_version: u32,
    trace: String,
    physics_hz: u32,
    tick_count: u32,
    actor_count: usize,
    duration_seconds: f64,
    shell_error_mm: f32,
    gop_ms: u32,
    max_segment_ms: u32,
    track_object_ms: u32,
    cell_size_m: f32,
    supercell_size_m: f32,
    target_tracks: usize,
    hard_track_cap: usize,
    routes_file: Option<String>,
    deterministic_route_seed: u64,
    camera_independent: bool,
    post_encode_track_decode: bool,
    archive_hash_fnv1a64: String,
    baselines: BaselineReport,
    codec_models: CodecModelReport,
    whole_world_error: ErrorReport,
    residual_coders: ResidualReport,
    gops: Vec<GopReport>,
    random_seek_p95_compressed_bytes: u64,
    track_publish_total_bytes: u64,
    track_count_global: usize,
    tracks: Vec<TrackReport>,
    spectators: Vec<SpectatorReport>,
    all_standard_routes_pass: bool,
    origin_bytes_invariant_to_viewer_count: bool,
    advanced_ablations: AdvancedAblationReport,
    hierarchy: HierarchyReport,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RouteKind {
    StationaryNear,
    ProjectileChase,
    Orbit,
    DistantSkyline,
    BoundaryFlythrough,
    Teleport,
    HotspotToHotspot,
    SeededRandom,
}

#[derive(Clone, Debug, Deserialize)]
struct RouteSpec {
    name: String,
    kind: RouteKind,
    #[serde(default = "default_fov")]
    fov_degrees: f32,
}

fn default_fov() -> f32 {
    60.0
}

#[derive(Clone, Debug, Serialize)]
struct SpectatorReport {
    name: String,
    route_kind: String,
    average_mbps: f64,
    peak_one_second_mbps: f64,
    active_tracks_max: usize,
    active_tracks_p95: f64,
    track_churn: u64,
    visible_samples: u64,
    missing_visible_samples: u64,
    screen_px_p95: f64,
    screen_px_p99: f64,
    screen_px_max: f64,
    shell_cm_p99: f64,
    shell_cm_max: f64,
    freeze_pct: f64,
    reversal_pct: f64,
    reveal_pop_px_max: f64,
    handoff_error_cm_max: f64,
    camera_independent_encode_hash: String,
    transport_profiles: Vec<TransportProfileReport>,
    #[serde(skip_serializing)]
    timeline: Vec<SpectatorFrame>,
    pass: bool,
}

#[derive(Clone, Debug, Serialize)]
struct SpectatorFrame {
    route: String,
    frame: u32,
    simulation_time: f64,
    rolling_mbps: f64,
    active_tracks: usize,
    visible_bodies: u64,
    missing_visible_bodies: u64,
    screen_error_px_max: f64,
    shell_error_cm_max: f64,
}

#[derive(Clone, Debug, Serialize)]
struct TransportProfileReport {
    name: &'static str,
    cap_mbps: f64,
    offered_bytes: u64,
    delivered_bytes: u64,
    stale_cancelled_bytes: u64,
    max_queue_ms: f64,
    pass_250ms_queue_gate: bool,
}

#[derive(Default)]
struct Histogram {
    bins: Vec<u64>,
    upper: f64,
    count: u64,
    max: f64,
}

impl Histogram {
    fn new(bin_count: usize, upper: f64) -> Self {
        Self {
            bins: vec![0; bin_count],
            upper,
            count: 0,
            max: 0.0,
        }
    }

    fn add(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        let normalized = (value.max(0.0) / self.upper).clamp(0.0, 1.0);
        let index = (normalized * (self.bins.len() - 1) as f64).round() as usize;
        self.bins[index] += 1;
        self.count += 1;
        self.max = self.max.max(value);
    }

    fn percentile(&self, percentile: f64) -> f64 {
        if self.count == 0 {
            return 0.0;
        }
        let target = (self.count as f64 * percentile).ceil() as u64;
        let mut seen = 0;
        for (index, count) in self.bins.iter().copied().enumerate() {
            seen += count;
            if seen >= target {
                return (index as f64 / (self.bins.len() - 1) as f64 * self.upper).min(self.max);
            }
        }
        self.max
    }
}

pub fn run(trace_path: &Path, out_dir: &Path, config: &ArchiveConfig) -> Result<()> {
    ensure!(config.shell_error_mm.is_finite() && config.shell_error_mm > 0.0);
    ensure!(config.gop_ms > 0 && config.max_segment_ms > 0);
    ensure!(
        config.cell_size_m.is_finite() && config.cell_size_m > 0.0,
        "cell size must be positive"
    );
    ensure!(
        config.supercell_size_m.is_finite() && config.supercell_size_m >= config.cell_size_m,
        "supercell size must be at least cell size"
    );
    ensure!(
        config.target_tracks > 0 && config.target_tracks <= config.hard_track_cap,
        "track target must be in 1..=hard cap"
    );
    fs::create_dir_all(out_dir)?;

    let encode_start = Instant::now();
    let mut trace = TraceReader::open(trace_path)?;
    let header = trace.header.clone();
    let actors = trace.actors.clone();
    let hz = header.physics_hz;
    let gop_ticks = ms_to_ticks(config.gop_ms, hz);
    let max_segment_ticks = ms_to_ticks(config.max_segment_ms, hz).min(gop_ticks);
    let shell_bound = config.shell_error_mm / 1000.0;
    let mut builders: Vec<_> = (0..actors.len()).map(|_| ActorBuilder::default()).collect();
    let mut bounds_min = Vec3::splat(f32::INFINITY);
    let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
    let mut contact_pair_samples = 0_u64;
    let mut coherent_contact_pair_samples = 0_u64;
    let mut max_contact_pairs_per_tick = 0_usize;

    while let Some(tick) = trace.next_tick()? {
        for (actor_index, state) in tick.states.iter().copied().enumerate() {
            if state.pose.position.abs().max_element() < 2_000.0 {
                bounds_min = bounds_min.min(state.pose.position);
                bounds_max = bounds_max.max(state.pose.position);
            }
            let mode = mode_of(state);
            let builder = &mut builders[actor_index];
            let discontinuity = builder
                .pending
                .last()
                .is_some_and(|previous| previous.pose.position.distance(state.pose.position) > 5.0);
            let boundary = tick.index > 0
                && (tick.index % gop_ticks == 0
                    || state.flags != 0
                    || discontinuity
                    || builder
                        .previous_mode
                        .is_some_and(|previous| previous != mode));
            if boundary {
                flush_pending(
                    builder,
                    &actors[actor_index],
                    hz,
                    header.gravity,
                    shell_bound,
                );
            }
            let reliable_flags = state.flags & (16 | 32 | 64);
            if reliable_flags != 0
                || discontinuity
                || builder
                    .previous_mode
                    .is_none_or(|previous| previous != mode)
            {
                builder.events.push(ArchiveEvent {
                    tick: tick.index,
                    flags: reliable_flags | if discontinuity { 0x80 } else { 0 },
                    mode,
                });
            }
            builder.previous_mode = Some(mode);
            let sample = Sample {
                tick: tick.index,
                pose: state.pose,
                linear_velocity: state.linear_velocity,
            };
            builder.pending.push(sample);
            let span = builder
                .pending
                .last()
                .expect("just pushed")
                .tick
                .saturating_sub(builder.pending[0].tick);
            let fits = choose_models(
                &builder.pending,
                &actors[actor_index],
                hz,
                header.gravity,
                shell_bound,
            )
            .is_some();
            if span >= max_segment_ticks || !fits {
                let current = builder.pending.pop().expect("pending has current");
                let previous = builder.pending.last().copied();
                flush_pending(
                    builder,
                    &actors[actor_index],
                    hz,
                    header.gravity,
                    shell_bound,
                );
                if let Some(previous) = previous {
                    builder.pending.push(previous);
                }
                builder.pending.push(current);
            }
        }
        contact_pair_samples += tick.contact_pairs.len() as u64;
        max_contact_pairs_per_tick = max_contact_pairs_per_tick.max(tick.contact_pairs.len());
        coherent_contact_pair_samples += tick
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
    for (actor_index, builder) in builders.iter_mut().enumerate() {
        flush_pending(
            builder,
            &actors[actor_index],
            hz,
            header.gravity,
            shell_bound,
        );
    }
    repair_outliers(
        trace_path,
        &actors,
        &mut builders,
        hz,
        header.gravity,
        shell_bound,
    )?;

    let mut tracks = assign_tracks(
        &mut builders,
        header.tick_count,
        hz,
        config.cell_size_m,
        config.supercell_size_m,
    );
    let archive_path = out_dir.join("omniscient.twarchive");
    let compressed_archive_path = out_dir.join("omniscient.twarchive.zstblocks");
    write_compressed_tracks(
        out_dir,
        &mut tracks,
        &builders,
        hz,
        header.tick_count,
        gop_ticks,
        header.gravity,
    )?;
    let mut decoded_builders =
        decode_compressed_tracks(out_dir, tracks.len(), actors.len(), hz, header.gravity)?;
    ensure!(
        builders
            .iter()
            .map(|builder| builder.segments.len())
            .sum::<usize>()
            == decoded_builders
                .iter()
                .map(|builder| builder.segments.len())
                .sum::<usize>(),
        "post-encode track decode lost motion segments"
    );
    repair_outliers(
        trace_path,
        &actors,
        &mut decoded_builders,
        hz,
        header.gravity,
        shell_bound,
    )?;
    for (encoded, repaired) in builders.iter_mut().zip(&decoded_builders) {
        encoded.exact_overrides.extend(
            repaired
                .exact_overrides
                .iter()
                .map(|(&tick, &pose)| (tick, pose)),
        );
    }
    write_compressed_tracks(
        out_dir,
        &mut tracks,
        &builders,
        hz,
        header.tick_count,
        gop_ticks,
        header.gravity,
    )?;
    let decoded_builders =
        decode_compressed_tracks(out_dir, tracks.len(), actors.len(), hz, header.gravity)?;
    let builders = decoded_builders;
    let archive_write = write_archive(
        &archive_path,
        &compressed_archive_path,
        &builders,
        &tracks,
        hz,
        header.tick_count,
        gop_ticks,
    )?;
    let archive_bytes = archive_write.uncompressed_bytes;
    let archive_hash = fnv1a_file(&archive_path)?;
    let encode_wall_ms = encode_start.elapsed().as_secs_f64() * 1000.0;

    let validation_start = Instant::now();
    let (whole_world_error, residual_coders) = validate_archive(
        trace_path,
        &actors,
        &builders,
        hz,
        header.gravity,
        shell_bound,
    )?;
    let decode_validation_wall_ms = validation_start.elapsed().as_secs_f64() * 1000.0;
    write_comparison_replays(
        trace_path,
        &out_dir.join("raw.towerstate"),
        &out_dir.join("reconstructed.towerstate"),
        &actors,
        &builders,
        30,
    )?;

    // Spectator files are intentionally loaded after the immutable archive and
    // hash exist. This ordering is part of the encode-once invariant.
    let routes = load_routes(config.route_file.as_deref())?;
    let spectators = evaluate_spectators(SpectatorContext {
        trace_path,
        actors: &actors,
        builders: &builders,
        tracks: &tracks,
        routes: &routes,
        bounds_min,
        bounds_max,
        config,
        archive_hash: &archive_hash,
    })?;
    ensure!(
        fnv1a_file(&archive_path)? == archive_hash,
        "spectator evaluation mutated the canonical archive"
    );

    write_track_csv(out_dir.join("tracks.csv"), &tracks, hz, header.tick_count)?;
    write_spectator_csv(out_dir.join("spectators.csv"), &spectators)?;
    write_spectator_timeline_csv(out_dir.join("spectator_timeline.csv"), &spectators)?;
    write_gop_csv(out_dir.join("gops.csv"), &archive_write.gops)?;
    let track_reports = track_reports(&tracks, hz, header.tick_count);
    let track_publish_total_bytes = tracks.iter().map(|track| track.total_bytes).sum();
    let duration = header.tick_count as f64 / hz as f64;
    let source_trace_bytes = fs::metadata(trace_path)?.len();
    let samples = header.tick_count as u64 * actors.len() as u64;
    let raw_modeled_bytes = samples * 61;
    let semantic_lossless_bytes = samples * 57 + header.tick_count as u64 * 13;
    let codec_models = codec_model_report(&builders, hz);
    let hierarchy = hierarchy::evaluate(
        trace_path,
        out_dir,
        &actors,
        HierarchyConfig {
            max_span_ticks: 0,
            symbol_audit: config.symbol_audit,
            mask: config.mask,
            budget: config.budget,
            root_rans: config.root_rans,
            residual_rans: config.residual_rans,
            shell_bound_m: shell_bound,
            gop_ticks,
            cell_size_m: config.cell_size_m,
            target_tracks: config.target_tracks,
            baseline_seekable_bytes: archive_write.compressed_bytes,
        },
    )?;
    let mut seek_sizes: Vec<_> = archive_write
        .gops
        .iter()
        .map(|gop| gop.compressed_bytes)
        .collect();
    seek_sizes.sort_unstable();
    let random_seek_p95_compressed_bytes = percentile_u64(&seek_sizes, 0.95);
    let advanced_ablations = advanced_ablation_report(
        &builders,
        contact_pair_samples,
        coherent_contact_pair_samples,
        max_contact_pairs_per_tick,
        &hierarchy,
        &residual_coders,
    );
    let report = ArchiveReport {
        schema_version: 1,
        trace: trace_path.display().to_string(),
        physics_hz: hz,
        tick_count: header.tick_count,
        actor_count: actors.len(),
        duration_seconds: duration,
        shell_error_mm: config.shell_error_mm,
        gop_ms: config.gop_ms,
        max_segment_ms: config.max_segment_ms,
        track_object_ms: (config.gop_ms.min(250)),
        cell_size_m: config.cell_size_m,
        supercell_size_m: config.supercell_size_m,
        target_tracks: config.target_tracks,
        hard_track_cap: config.hard_track_cap,
        routes_file: config
            .route_file
            .as_ref()
            .map(|path| path.display().to_string()),
        deterministic_route_seed: 0x54_57_41_52_43_48_31,
        camera_independent: true,
        post_encode_track_decode: true,
        archive_hash_fnv1a64: archive_hash.clone(),
        baselines: BaselineReport {
            source_trace_bytes,
            raw_modeled_bytes,
            semantic_lossless_bytes,
            archive_bytes,
            seekable_zstd_bytes: archive_write.compressed_bytes,
            archive_ratio_vs_raw: raw_modeled_bytes as f64 / archive_bytes.max(1) as f64,
            seekable_zstd_ratio_vs_raw: raw_modeled_bytes as f64
                / archive_write.compressed_bytes.max(1) as f64,
            archive_average_mbps: archive_bytes as f64 * 8.0 / duration / 1_000_000.0,
            seekable_zstd_average_mbps: archive_write.compressed_bytes as f64 * 8.0
                / duration
                / 1_000_000.0,
            encode_wall_ms,
            decode_validation_wall_ms,
        },
        codec_models,
        whole_world_error,
        residual_coders,
        gops: archive_write.gops,
        random_seek_p95_compressed_bytes,
        track_publish_total_bytes,
        track_count_global: tracks.len(),
        tracks: track_reports,
        all_standard_routes_pass: spectators.iter().all(|route| route.pass),
        origin_bytes_invariant_to_viewer_count: true,
        spectators,
        advanced_ablations,
        hierarchy,
    };
    serde_json::to_writer_pretty(
        BufWriter::new(File::create(out_dir.join("archive_report.json"))?),
        &report,
    )?;
    write_summary(out_dir.join("README.md"), &report)?;
    ensure!(
        !config.require_pass || (report.whole_world_error.pass && report.all_standard_routes_pass),
        "omniscient archive regression failed; inspect {}",
        out_dir.join("archive_report.json").display()
    );
    Ok(())
}

fn ms_to_ticks(ms: u32, hz: u32) -> u32 {
    ((ms as u64 * hz as u64).div_ceil(1000) as u32).max(1)
}

fn mode_of(state: ActorState) -> u8 {
    if state.sleeping() {
        0
    } else if state.kinematic() {
        1
    } else {
        2
    }
}

fn flush_pending(
    builder: &mut ActorBuilder,
    actor: &ActorDef,
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
) {
    if builder.pending.is_empty() {
        return;
    }
    // Keep serialization/decoder arithmetic away from the strict gate edge.
    // The post-encode validator still enforces the full configured bound.
    let model_shell_bound = shell_bound * 0.75;
    let (position_model, rotation_model, encoded_bytes) =
        choose_models(&builder.pending, actor, hz, gravity, model_shell_bound).unwrap_or((
            PositionModel::Hermite,
            RotationModel::Slerp,
            67,
        ));
    let start = builder.pending[0];
    let end = *builder.pending.last().expect("non-empty");
    let (start_pose, start_full_precision) =
        archive_rotation(start.pose, actor.bounding_radius, shell_bound);
    let (end_pose, end_full_precision) =
        archive_rotation(end.pose, actor.bounding_radius, shell_bound);
    let rotation_full_precision = start_full_precision || end_full_precision;
    let rotation_count = if matches!(rotation_model, RotationModel::Slerp) {
        2
    } else {
        1
    };
    builder.segments.push(MotionSegment {
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
        detail_track: 0,
        coarse_track: 0,
    });
    builder.pending.clear();
}

fn choose_models(
    samples: &[Sample],
    actor: &ActorDef,
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
) -> Option<(PositionModel, RotationModel, usize)> {
    if samples.len() <= 1 {
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
    candidates.into_iter().find(|(position, rotation, _)| {
        model_fits(
            samples,
            actor.bounding_radius,
            hz,
            gravity,
            shell_bound,
            *position,
            *rotation,
        )
    })
}

fn model_fits(
    samples: &[Sample],
    radius: f32,
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
    position_model: PositionModel,
    rotation_model: RotationModel,
) -> bool {
    let first = samples[0];
    let last = *samples.last().expect("non-empty");
    let segment = MotionSegment {
        start_tick: first.tick,
        end_tick: last.tick,
        position_model,
        rotation_model,
        start_pose: archive_rotation(first.pose, radius, shell_bound).0,
        end_pose: archive_rotation(last.pose, radius, shell_bound).0,
        start_velocity: first.linear_velocity,
        end_velocity: last.linear_velocity,
        rotation_full_precision: false,
        encoded_bytes: 0,
        detail_track: 0,
        coarse_track: 0,
    };
    samples.iter().all(|sample| {
        rigid_shell_error_meters(
            sample.pose,
            segment.pose_at(sample.tick, hz, gravity),
            radius,
        ) <= shell_bound
    })
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

fn cell(value: f32, size: f32) -> i32 {
    (value / size).floor() as i32
}

fn assign_tracks(
    builders: &mut [ActorBuilder],
    tick_count: u32,
    hz: u32,
    cell_size: f32,
    supercell_size: f32,
) -> Vec<TrackData> {
    let mut keys = BTreeSet::new();
    keys.insert(TrackKey {
        tier: TrackTier::Events,
        x: 0,
        z: 0,
    });
    for builder in builders.iter() {
        for segment in &builder.segments {
            let midpoint = segment
                .start_pose
                .position
                .lerp(segment.end_pose.position, 0.5);
            keys.insert(TrackKey {
                tier: TrackTier::Detail,
                x: cell(midpoint.x, cell_size),
                z: cell(midpoint.z, cell_size),
            });
            keys.insert(TrackKey {
                tier: TrackTier::Coarse,
                x: cell(midpoint.x, supercell_size),
                z: cell(midpoint.z, supercell_size),
            });
        }
    }
    let mut key_to_id = BTreeMap::new();
    let mut tracks = Vec::with_capacity(keys.len());
    for (index, key) in keys.into_iter().enumerate() {
        let id = index as u32;
        key_to_id.insert(key, id);
        tracks.push(TrackData {
            id,
            key,
            total_bytes: 0,
            tick_bytes: vec![0; tick_count as usize],
        });
    }
    debug_assert_eq!(
        key_to_id[&TrackKey {
            tier: TrackTier::Events,
            x: 0,
            z: 0
        }],
        GLOBAL_EVENTS_TRACK
    );
    let coarse_interval = (hz / 10).max(1);
    for builder in builders {
        for event in &builder.events {
            tracks[GLOBAL_EVENTS_TRACK as usize].tick_bytes[event.tick as usize] += 4;
            tracks[GLOBAL_EVENTS_TRACK as usize].total_bytes += 4;
        }
        for segment in &mut builder.segments {
            let midpoint = segment
                .start_pose
                .position
                .lerp(segment.end_pose.position, 0.5);
            let detail_key = TrackKey {
                tier: TrackTier::Detail,
                x: cell(midpoint.x, cell_size),
                z: cell(midpoint.z, cell_size),
            };
            let coarse_key = TrackKey {
                tier: TrackTier::Coarse,
                x: cell(midpoint.x, supercell_size),
                z: cell(midpoint.z, supercell_size),
            };
            segment.detail_track = key_to_id[&detail_key];
            segment.coarse_track = key_to_id[&coarse_key];
            let emit_tick = segment.end_tick.min(tick_count.saturating_sub(1)) as usize;
            let detail = &mut tracks[segment.detail_track as usize];
            detail.tick_bytes[emit_tick] += segment.encoded_bytes as u64;
            detail.total_bytes += segment.encoded_bytes as u64;
            let mut tick = segment.start_tick;
            while tick <= segment.end_tick {
                let coarse = &mut tracks[segment.coarse_track as usize];
                coarse.tick_bytes[tick as usize] += 16;
                coarse.total_bytes += 16;
                match tick.checked_add(coarse_interval) {
                    Some(next) if next > tick => tick = next,
                    _ => break,
                }
            }
        }
    }
    tracks
}

fn write_compressed_tracks(
    out_dir: &Path,
    tracks: &mut [TrackData],
    builders: &[ActorBuilder],
    hz: u32,
    tick_count: u32,
    gop_ticks: u32,
    gravity: Vec3,
) -> Result<()> {
    let object_ticks = (hz / 4).max(1).min(gop_ticks);
    let object_count = tick_count.div_ceil(object_ticks) as usize;
    let mut buffers = vec![vec![Vec::<u8>::new(); object_count]; tracks.len()];
    let coarse_interval = (hz / 10).max(1);
    for (actor, builder) in builders.iter().enumerate() {
        for event in &builder.events {
            let buffer =
                &mut buffers[GLOBAL_EVENTS_TRACK as usize][(event.tick / object_ticks) as usize];
            buffer.push(0);
            buffer.extend_from_slice(&(actor as u32).to_le_bytes());
            buffer.extend_from_slice(&((event.tick % object_ticks) as u16).to_le_bytes());
            buffer.extend_from_slice(&[event.flags, event.mode]);
        }
        for (&tick, &pose) in &builder.exact_overrides {
            let segment = segment_at(&builder.segments, tick);
            let buffer =
                &mut buffers[segment.detail_track as usize][(tick / object_ticks) as usize];
            buffer.push(1);
            buffer.extend_from_slice(&(actor as u32).to_le_bytes());
            buffer.extend_from_slice(&((tick % object_ticks) as u16).to_le_bytes());
            write_vec3(buffer, pose.position)?;
            write_rotation(buffer, pose.rotation, true)?;
        }
        for segment in &builder.segments {
            let object = (segment.start_tick / object_ticks) as usize;
            buffers[segment.detail_track as usize][object].push(2);
            write_segment(
                &mut buffers[segment.detail_track as usize][object],
                actor as u32,
                segment,
                object as u32 * object_ticks,
            )?;
            let mut tick = segment.start_tick;
            while tick <= segment.end_tick {
                let pose = quantize_coarse(segment.pose_at(tick, hz, gravity));
                let buffer =
                    &mut buffers[segment.coarse_track as usize][(tick / object_ticks) as usize];
                buffer.push(3);
                buffer.extend_from_slice(&(actor as u32).to_le_bytes());
                buffer.extend_from_slice(&((tick % object_ticks) as u16).to_le_bytes());
                for component in pose.position.to_array() {
                    let value = (component / 0.01)
                        .round()
                        .clamp(i16::MIN as f32, i16::MAX as f32)
                        as i16;
                    buffer.extend_from_slice(&value.to_le_bytes());
                }
                buffer.extend_from_slice(&encode_quat32(pose.rotation).to_le_bytes());
                match tick.checked_add(coarse_interval) {
                    Some(next) if next > tick => tick = next,
                    _ => break,
                }
            }
        }
    }
    let tracks_dir = out_dir.join("tracks");
    fs::create_dir_all(&tracks_dir)?;
    for track in tracks.iter_mut() {
        track.total_bytes = 0;
        track.tick_bytes.fill(0);
        let mut writer = BufWriter::new(File::create(
            tracks_dir.join(format!("track-{:02}.zstblocks", track.id)),
        )?);
        writer.write_all(b"TWTRACK1")?;
        writer.write_all(&track.id.to_le_bytes())?;
        writer.write_all(&object_ticks.to_le_bytes())?;
        for (object, payload) in buffers[track.id as usize].iter().enumerate() {
            if payload.is_empty() {
                continue;
            }
            let compressed = zstd::bulk::compress(payload, 3)?;
            writer.write_all(&(object as u32).to_le_bytes())?;
            writer.write_all(&(payload.len() as u32).to_le_bytes())?;
            writer.write_all(&(compressed.len() as u32).to_le_bytes())?;
            writer.write_all(&compressed)?;
            let bytes = compressed.len() as u64 + 12;
            let emit_tick = ((object as u32 + 1) * object_ticks)
                .min(tick_count)
                .saturating_sub(1) as usize;
            track.tick_bytes[emit_tick] += bytes;
            track.total_bytes += bytes;
        }
        writer.flush()?;
        let header_bytes = 16_u64;
        track.total_bytes += header_bytes;
        track.tick_bytes[0] += header_bytes;
    }
    Ok(())
}

fn decode_compressed_tracks(
    out_dir: &Path,
    track_count: usize,
    actor_count: usize,
    hz: u32,
    gravity: Vec3,
) -> Result<Vec<ActorBuilder>> {
    let mut builders: Vec<ActorBuilder> =
        (0..actor_count).map(|_| ActorBuilder::default()).collect();
    for track_id in 0..track_count {
        let path = out_dir
            .join("tracks")
            .join(format!("track-{track_id:02}.zstblocks"));
        let mut bytes = Vec::new();
        File::open(&path)?.read_to_end(&mut bytes)?;
        let mut reader = ByteReader::new(&bytes);
        ensure!(reader.take(8)? == b"TWTRACK1", "invalid track magic");
        ensure!(reader.u32()? == track_id as u32, "track ID/header mismatch");
        let object_ticks = reader.u32()?;
        while !reader.is_empty() {
            let object = reader.u32()?;
            let uncompressed_len = reader.u32()? as usize;
            let compressed_len = reader.u32()? as usize;
            let payload = zstd::bulk::decompress(reader.take(compressed_len)?, uncompressed_len)?;
            decode_track_payload(&payload, object * object_ticks, &mut builders, hz, gravity)?;
        }
    }
    for builder in &mut builders {
        builder.segments.sort_by_key(|segment| segment.start_tick);
        builder.events.sort_by_key(|event| event.tick);
    }
    Ok(builders)
}

fn decode_track_payload(
    payload: &[u8],
    object_start_tick: u32,
    builders: &mut [ActorBuilder],
    hz: u32,
    gravity: Vec3,
) -> Result<()> {
    let mut reader = ByteReader::new(payload);
    while !reader.is_empty() {
        match reader.u8()? {
            0 => {
                let actor = reader.u32()? as usize;
                let tick = object_start_tick + reader.u16()? as u32;
                let flags = reader.u8()?;
                let mode = reader.u8()?;
                builders
                    .get_mut(actor)
                    .context("event actor outside track actor table")?
                    .events
                    .push(ArchiveEvent { tick, flags, mode });
            }
            1 => {
                let actor = reader.u32()? as usize;
                let tick = object_start_tick + reader.u16()? as u32;
                let pose = Pose {
                    position: reader.vec3()?,
                    rotation: reader.quat(true)?,
                };
                builders
                    .get_mut(actor)
                    .context("override actor outside track actor table")?
                    .exact_overrides
                    .insert(tick, pose);
            }
            2 => {
                let record_start = reader.offset;
                let actor = reader.varint()? as usize;
                let start_tick = object_start_tick + reader.varint()? as u32;
                let end_tick = start_tick + reader.varint()? as u32;
                let position_model = match reader.u8()? {
                    0 => PositionModel::Hold,
                    1 => PositionModel::Linear,
                    2 => PositionModel::Ballistic,
                    3 => PositionModel::Hermite,
                    tag => anyhow::bail!("unknown position model tag {tag}"),
                };
                let rotation_model = match reader.u8()? {
                    0 => RotationModel::Hold,
                    1 => RotationModel::Slerp,
                    tag => anyhow::bail!("unknown rotation model tag {tag}"),
                };
                let rotation_full_precision = reader.u8()? != 0;
                let detail_track = reader.varint()? as u32;
                let coarse_track = reader.varint()? as u32;
                let start_position = reader.vec3()?;
                let mut end_position = start_position;
                let mut start_velocity = Vec3::ZERO;
                let mut end_velocity = Vec3::ZERO;
                match position_model {
                    PositionModel::Hold => {}
                    PositionModel::Linear => end_position = reader.vec3()?,
                    PositionModel::Ballistic => {
                        start_velocity = reader.vec3()?;
                        let duration = end_tick.saturating_sub(start_tick) as f32 / hz as f32;
                        end_position = start_position
                            + start_velocity * duration
                            + gravity * (0.5 * duration * duration);
                    }
                    PositionModel::Hermite => {
                        end_position = reader.vec3()?;
                        start_velocity = reader.vec3()?;
                        end_velocity = reader.vec3()?;
                    }
                }
                let start_rotation = reader.quat(rotation_full_precision)?;
                let end_rotation = if matches!(rotation_model, RotationModel::Slerp) {
                    reader.quat(rotation_full_precision)?
                } else {
                    start_rotation
                };
                let encoded_bytes = reader.offset.saturating_sub(record_start);
                builders
                    .get_mut(actor)
                    .context("segment actor outside track actor table")?
                    .segments
                    .push(MotionSegment {
                        start_tick,
                        end_tick,
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
                        encoded_bytes,
                        detail_track,
                        coarse_track,
                        rotation_full_precision,
                    });
            }
            3 => {
                let _actor = reader.u32()?;
                let _tick = reader.u16()?;
                reader.skip(6 + 4)?;
            }
            tag => anyhow::bail!("unknown track record tag {tag}"),
        }
    }
    Ok(())
}

struct ByteReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ByteReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn is_empty(&self) -> bool {
        self.offset == self.bytes.len()
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .context("track offset overflow")?;
        ensure!(end <= self.bytes.len(), "truncated track payload");
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn skip(&mut self, len: usize) -> Result<()> {
        self.take(len).map(|_| ())
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn vec3(&mut self) -> Result<Vec3> {
        Ok(Vec3::new(self.f32()?, self.f32()?, self.f32()?))
    }

    fn quat(&mut self, full_precision: bool) -> Result<Quat> {
        if full_precision {
            Ok(Quat::from_xyzw(
                self.f32()?,
                self.f32()?,
                self.f32()?,
                self.f32()?,
            ))
        } else {
            Ok(decode_quat32(self.u32()?))
        }
    }

    fn varint(&mut self) -> Result<u64> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        anyhow::bail!("track varint exceeds u64")
    }
}

struct ArchiveWriteResult {
    uncompressed_bytes: u64,
    compressed_bytes: u64,
    gops: Vec<GopReport>,
}

fn write_archive(
    path: &Path,
    compressed_path: &Path,
    builders: &[ActorBuilder],
    tracks: &[TrackData],
    hz: u32,
    tick_count: u32,
    gop_ticks: u32,
) -> Result<ArchiveWriteResult> {
    let mut writer = BufWriter::new(File::create(path)?);
    let mut compressed_writer = BufWriter::new(File::create(compressed_path)?);
    writer.write_all(MAGIC)?;
    compressed_writer.write_all(b"TWARCZ1\0")?;
    for output in [&mut writer, &mut compressed_writer] {
        output.write_all(&1_u32.to_le_bytes())?;
        output.write_all(&hz.to_le_bytes())?;
        output.write_all(&tick_count.to_le_bytes())?;
        output.write_all(&(builders.len() as u32).to_le_bytes())?;
        output.write_all(&(tracks.len() as u32).to_le_bytes())?;
        output.write_all(&gop_ticks.to_le_bytes())?;
        for track in tracks {
            output.write_all(&track.id.to_le_bytes())?;
            output.write_all(&[match track.key.tier {
                TrackTier::Events => 0,
                TrackTier::Coarse => 1,
                TrackTier::Detail => 2,
            }])?;
            output.write_all(&track.key.x.to_le_bytes())?;
            output.write_all(&track.key.z.to_le_bytes())?;
        }
    }

    let gop_count = tick_count.div_ceil(gop_ticks) as usize;
    let mut segment_refs = vec![Vec::<(u32, &MotionSegment)>::new(); gop_count];
    let mut event_refs = vec![Vec::<(u32, ArchiveEvent)>::new(); gop_count];
    let mut override_refs = vec![Vec::<(u32, u32, Pose)>::new(); gop_count];
    for (actor, builder) in builders.iter().enumerate() {
        for event in &builder.events {
            event_refs[(event.tick / gop_ticks) as usize].push((actor as u32, *event));
        }
        for segment in &builder.segments {
            segment_refs[(segment.start_tick / gop_ticks) as usize].push((actor as u32, segment));
        }
        for (&tick, &pose) in &builder.exact_overrides {
            override_refs[(tick / gop_ticks) as usize].push((actor as u32, tick, pose));
        }
    }

    let header_bytes = 8 + 6 * 4 + tracks.len() as u64 * 13;
    let mut file_offset = header_bytes;
    let mut gops = Vec::with_capacity(gop_count);
    for gop_index in 0..gop_count {
        let start_tick = gop_index as u32 * gop_ticks;
        let end_tick = start_tick
            .saturating_add(gop_ticks)
            .min(tick_count)
            .saturating_sub(1);
        let mut payload = Vec::new();
        write_varint(&mut payload, event_refs[gop_index].len() as u64)?;
        for (actor, event) in &event_refs[gop_index] {
            write_varint(&mut payload, *actor as u64)?;
            write_varint(&mut payload, event.tick.saturating_sub(start_tick) as u64)?;
            payload.extend_from_slice(&[event.flags, event.mode]);
        }
        write_varint(&mut payload, override_refs[gop_index].len() as u64)?;
        for (actor, tick, pose) in &override_refs[gop_index] {
            write_varint(&mut payload, *actor as u64)?;
            write_varint(&mut payload, tick.saturating_sub(start_tick) as u64)?;
            write_vec3(&mut payload, pose.position)?;
            write_rotation(&mut payload, pose.rotation, true)?;
        }
        write_varint(&mut payload, segment_refs[gop_index].len() as u64)?;
        for (actor, segment) in &segment_refs[gop_index] {
            write_segment(&mut payload, *actor, segment, start_tick)?;
        }
        let compressed = zstd::bulk::compress(&payload, 3)?;
        writer.write_all(&(gop_index as u32).to_le_bytes())?;
        writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        writer.write_all(&payload)?;
        compressed_writer.write_all(&(gop_index as u32).to_le_bytes())?;
        compressed_writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        compressed_writer.write_all(&(compressed.len() as u32).to_le_bytes())?;
        compressed_writer.write_all(&compressed)?;
        gops.push(GopReport {
            index: gop_index as u32,
            start_tick,
            end_tick,
            segment_records: segment_refs[gop_index].len() as u64,
            event_records: event_refs[gop_index].len() as u64,
            exact_override_records: override_refs[gop_index].len() as u64,
            uncompressed_bytes: payload.len() as u64,
            compressed_bytes: compressed.len() as u64,
            file_offset,
        });
        file_offset += 8 + payload.len() as u64;
    }
    writer.flush()?;
    compressed_writer.flush()?;
    Ok(ArchiveWriteResult {
        uncompressed_bytes: fs::metadata(path)?.len(),
        compressed_bytes: fs::metadata(compressed_path)?.len(),
        gops,
    })
}

fn write_segment(
    writer: &mut impl Write,
    actor: u32,
    segment: &MotionSegment,
    gop_start_tick: u32,
) -> Result<()> {
    write_varint(writer, actor as u64)?;
    write_varint(
        writer,
        segment.start_tick.saturating_sub(gop_start_tick) as u64,
    )?;
    write_varint(
        writer,
        segment.end_tick.saturating_sub(segment.start_tick) as u64,
    )?;
    writer.write_all(&[
        position_tag(segment.position_model),
        rotation_tag(segment.rotation_model),
        u8::from(segment.rotation_full_precision),
    ])?;
    write_varint(writer, segment.detail_track as u64)?;
    write_varint(writer, segment.coarse_track as u64)?;
    write_position_fields(writer, segment)?;
    write_rotation(
        writer,
        segment.start_pose.rotation,
        segment.rotation_full_precision,
    )?;
    if matches!(segment.rotation_model, RotationModel::Slerp) {
        write_rotation(
            writer,
            segment.end_pose.rotation,
            segment.rotation_full_precision,
        )?;
    }
    Ok(())
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

fn write_vec3(writer: &mut impl Write, value: Vec3) -> Result<()> {
    writer.write_all(&value.x.to_le_bytes())?;
    writer.write_all(&value.y.to_le_bytes())?;
    writer.write_all(&value.z.to_le_bytes())?;
    Ok(())
}

fn write_rotation(writer: &mut impl Write, value: Quat, full_precision: bool) -> Result<()> {
    if full_precision {
        writer.write_all(&value.x.to_le_bytes())?;
        writer.write_all(&value.y.to_le_bytes())?;
        writer.write_all(&value.z.to_le_bytes())?;
        writer.write_all(&value.w.to_le_bytes())?;
    } else {
        writer.write_all(&encode_quat32(value).to_le_bytes())?;
    }
    Ok(())
}

fn write_position_fields(writer: &mut impl Write, segment: &MotionSegment) -> Result<()> {
    write_vec3(writer, segment.start_pose.position)?;
    match segment.position_model {
        PositionModel::Hold => {}
        PositionModel::Linear => write_vec3(writer, segment.end_pose.position)?,
        PositionModel::Ballistic => write_vec3(writer, segment.start_velocity)?,
        PositionModel::Hermite => {
            write_vec3(writer, segment.end_pose.position)?;
            write_vec3(writer, segment.start_velocity)?;
            write_vec3(writer, segment.end_velocity)?;
        }
    }
    Ok(())
}

fn write_varint(writer: &mut impl Write, mut value: u64) -> Result<()> {
    while value >= 0x80 {
        writer.write_all(&[((value as u8 & 0x7f) | 0x80)])?;
        value >>= 7;
    }
    writer.write_all(&[value as u8])?;
    Ok(())
}

fn segment_for_tick<'a>(
    segments: &'a [MotionSegment],
    index: &mut usize,
    tick: u32,
) -> &'a MotionSegment {
    while *index + 1 < segments.len() && segments[*index].end_tick < tick {
        *index += 1;
    }
    &segments[*index]
}

fn reconstructed_pose(
    builder: &ActorBuilder,
    segment: &MotionSegment,
    tick: u32,
    hz: u32,
    gravity: Vec3,
) -> Pose {
    builder
        .exact_overrides
        .get(&tick)
        .copied()
        .unwrap_or_else(|| segment.pose_at(tick, hz, gravity))
}

fn repair_outliers(
    trace_path: &Path,
    actors: &[ActorDef],
    builders: &mut [ActorBuilder],
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
) -> Result<()> {
    let mut trace = TraceReader::open(trace_path)?;
    let mut indices = vec![0_usize; actors.len()];
    while let Some(tick) = trace.next_tick()? {
        for (actor, truth) in tick.states.iter().copied().enumerate() {
            let segment =
                segment_for_tick(&builders[actor].segments, &mut indices[actor], tick.index);
            let reconstruction = segment.pose_at(tick.index, hz, gravity);
            if rigid_shell_error_meters(truth.pose, reconstruction, actors[actor].bounding_radius)
                > shell_bound
            {
                builders[actor].exact_overrides.insert(
                    tick.index,
                    Pose {
                        position: truth.pose.position,
                        rotation: truth.pose.rotation.normalize(),
                    },
                );
            }
        }
    }
    Ok(())
}

fn validate_archive(
    trace_path: &Path,
    actors: &[ActorDef],
    builders: &[ActorBuilder],
    hz: u32,
    gravity: Vec3,
    shell_bound: f32,
) -> Result<(ErrorReport, ResidualReport)> {
    let mut trace = TraceReader::open(trace_path)?;
    let mut indices = vec![0_usize; actors.len()];
    let mut shell = Histogram::new(4096, shell_bound as f64 * 4.0);
    let mut position = Histogram::new(4096, shell_bound as f64 * 4.0);
    let mut rotation = Histogram::new(4096, 5.0);
    let mut final_divergent = 0;
    let mut shell_max_actor = 0;
    let mut shell_max_tick = 0;
    let mut shell_max_value = 0.0_f32;
    let mut shell_max_segment = &builders[0].segments[0];
    let mut residual_bytes = Vec::new();
    let mut zigzag_bytes = 0_u64;
    let mut rice_bits = [0_u64; 9];
    let mut zero_run_bytes = 0_u64;
    let mut zero_run = 0_u64;
    let mut residual_hist = BTreeMap::<i16, u64>::new();
    let mut sample_components = 0_u64;
    let mut last_tick = 0;
    let mut event_mismatches = 0_u64;
    let mut previous_modes = vec![None::<u8>; actors.len()];
    while let Some(tick) = trace.next_tick()? {
        last_tick = tick.index;
        for (actor, truth) in tick.states.iter().copied().enumerate() {
            let mode = mode_of(truth);
            let event = builders[actor]
                .events
                .binary_search_by_key(&tick.index, |event| event.tick)
                .ok()
                .map(|index| builders[actor].events[index]);
            let reliable_flags = truth.flags & (16 | 32 | 64);
            if reliable_flags != 0
                && event.is_none_or(|event| event.flags & reliable_flags != reliable_flags)
            {
                event_mismatches += 1;
            }
            if previous_modes[actor].is_none_or(|previous| previous != mode)
                && event.is_none_or(|event| event.mode != mode)
            {
                event_mismatches += 1;
            }
            previous_modes[actor] = Some(mode);
            let segment =
                segment_for_tick(&builders[actor].segments, &mut indices[actor], tick.index);
            let reconstructed =
                reconstructed_pose(&builders[actor], segment, tick.index, hz, gravity);
            let shell_error =
                rigid_shell_error_meters(truth.pose, reconstructed, actors[actor].bounding_radius);
            if shell_error > shell_max_value {
                shell_max_value = shell_error;
                shell_max_actor = actor;
                shell_max_tick = tick.index;
                shell_max_segment = segment;
            }
            shell.add(shell_error as f64);
            position.add(truth.pose.position.distance(reconstructed.position) as f64);
            rotation.add(angular_error_degrees(truth.pose.rotation, reconstructed.rotation) as f64);
            for component in (truth.pose.position - reconstructed.position).to_array() {
                let quantized = (component * 1000.0)
                    .round()
                    .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                residual_bytes.extend_from_slice(&quantized.to_le_bytes());
                *residual_hist.entry(quantized).or_default() += 1;
                let zigzag = ((quantized as i32) << 1) ^ ((quantized as i32) >> 15);
                zigzag_bytes += varint_len(zigzag as u64);
                for (k, bits) in rice_bits.iter_mut().enumerate() {
                    *bits += (zigzag as u64 >> k) + 1 + k as u64;
                }
                if quantized == 0 {
                    zero_run += 1;
                } else {
                    if zero_run > 0 {
                        zero_run_bytes += 1 + varint_len(zero_run);
                        zero_run = 0;
                    }
                    zero_run_bytes += 1 + varint_len(zigzag as u64);
                }
                sample_components += 1;
            }
            if tick.index + 1 == trace.header.tick_count && shell_error > shell_bound {
                final_divergent += 1;
            }
        }
    }
    if zero_run > 0 {
        zero_run_bytes += 1 + varint_len(zero_run);
    }
    let (best_rice_k, best_rice_bits) = rice_bits
        .iter()
        .copied()
        .enumerate()
        .min_by_key(|(_, bits)| *bits)
        .expect("rice candidates");
    let entropy_bits = residual_hist.values().fold(0.0, |sum, count| {
        let probability = *count as f64 / sample_components.max(1) as f64;
        sum - *count as f64 * probability.log2()
    });
    let table_bytes = residual_hist.len() as u64 * 10;
    let zstd_level3_bytes = zstd::bulk::compress(&residual_bytes, 3)?.len() as u64;
    let error = ErrorReport {
        shell_cm_p95: shell.percentile(0.95) * 100.0,
        shell_cm_p99: shell.percentile(0.99) * 100.0,
        shell_cm_max: shell.max * 100.0,
        shell_max_actor,
        shell_max_tick,
        shell_max_segment_start: shell_max_segment.start_tick,
        shell_max_segment_end: shell_max_segment.end_tick,
        shell_max_position_model: shell_max_segment.position_model,
        shell_max_rotation_model: shell_max_segment.rotation_model,
        shell_max_actor_radius: actors[shell_max_actor].bounding_radius,
        position_cm_p99: position.percentile(0.99) * 100.0,
        rotation_deg_p99: rotation.percentile(0.99),
        event_mismatches,
        final_divergent_bodies: final_divergent,
        pass: shell.max <= shell_bound as f64 * 1.001
            && final_divergent == 0
            && event_mismatches == 0,
    };
    let residual = ResidualReport {
        samples: sample_components / 3,
        fixed_i16_bytes: sample_components * 2,
        zigzag_leb128_bytes: zigzag_bytes,
        best_rice_k: best_rice_k as u8,
        best_rice_bytes: best_rice_bits.div_ceil(8),
        zero_run_bytes,
        shannon_lower_bound_bytes_with_table: (entropy_bits.ceil() as u64).div_ceil(8)
            + table_bytes,
        zstd_level3_bytes,
    };
    ensure!(
        last_tick + 1 == trace.header.tick_count,
        "validation did not consume trace"
    );
    Ok((error, residual))
}

fn write_comparison_replays(
    trace_path: &Path,
    raw_path: &Path,
    reconstructed_path: &Path,
    actors: &[ActorDef],
    builders: &[ActorBuilder],
    output_fps: u32,
) -> Result<()> {
    let mut trace = TraceReader::open(trace_path)?;
    let mut raw_writer = ReplayWriter::create(raw_path, &trace.header, actors, output_fps)?;
    let mut reconstructed_writer =
        ReplayWriter::create(reconstructed_path, &trace.header, actors, output_fps)?;
    let mut segment_indices = vec![0_usize; actors.len()];
    let mut last_frame = None;
    while let Some(tick) = trace.next_tick()? {
        let frame = tick.index.saturating_mul(output_fps) / trace.header.physics_hz;
        if last_frame == Some(frame) {
            continue;
        }
        last_frame = Some(frame);
        let raw_poses: Vec<_> = tick.states.iter().map(|state| state.pose).collect();
        let sleeping: Vec<_> = tick.states.iter().map(|state| state.sleeping()).collect();
        let reconstructed: Vec<_> = (0..actors.len())
            .map(|actor| {
                let segment = segment_for_tick(
                    &builders[actor].segments,
                    &mut segment_indices[actor],
                    tick.index,
                );
                reconstructed_pose(
                    &builders[actor],
                    segment,
                    tick.index,
                    trace.header.physics_hz,
                    trace.header.gravity,
                )
            })
            .collect();
        raw_writer.write_frame(&raw_poses, &sleeping)?;
        reconstructed_writer.write_frame(&reconstructed, &sleeping)?;
    }
    raw_writer.finish()?;
    reconstructed_writer.finish()
}

fn varint_len(mut value: u64) -> u64 {
    let mut bytes = 1;
    while value >= 0x80 {
        value >>= 7;
        bytes += 1;
    }
    bytes
}

fn load_routes(path: Option<&Path>) -> Result<Vec<RouteSpec>> {
    if let Some(path) = path {
        let routes: Vec<RouteSpec> =
            serde_json::from_reader(File::open(path).with_context(|| path.display().to_string())?)?;
        ensure!(
            !routes.is_empty(),
            "route file must contain at least one route"
        );
        return Ok(routes);
    }
    Ok(vec![
        route("stationary-near", RouteKind::StationaryNear),
        route("projectile-chase", RouteKind::ProjectileChase),
        route("orbit", RouteKind::Orbit),
        route("distant-skyline", RouteKind::DistantSkyline),
        route("boundary-flythrough", RouteKind::BoundaryFlythrough),
        route("teleport-late-join", RouteKind::Teleport),
        route("hotspot-to-hotspot", RouteKind::HotspotToHotspot),
        route("seeded-random", RouteKind::SeededRandom),
    ])
}

fn route(name: &str, kind: RouteKind) -> RouteSpec {
    RouteSpec {
        name: name.to_string(),
        kind,
        fov_degrees: default_fov(),
    }
}

fn route_camera(
    route: &RouteSpec,
    tick: u32,
    tick_count: u32,
    bounds_min: Vec3,
    bounds_max: Vec3,
    chase_target: Vec3,
) -> Camera {
    let center = (bounds_min + bounds_max) * 0.5;
    let extent = (bounds_max - bounds_min).max_element().max(20.0);
    let progress = tick as f32 / tick_count.max(1) as f32;
    let eye = match route.kind {
        RouteKind::StationaryNear => center + Vec3::new(0.0, extent * 0.15, -extent * 0.75),
        RouteKind::ProjectileChase => chase_target + Vec3::new(0.0, 2.5, -8.0),
        RouteKind::Orbit => {
            let angle = progress * std::f32::consts::TAU;
            center + Vec3::new(angle.sin(), 0.35, angle.cos()) * extent
        }
        RouteKind::DistantSkyline => center + Vec3::new(extent * 2.5, extent, -extent * 3.0),
        RouteKind::BoundaryFlythrough => {
            center
                + Vec3::new(
                    (progress * 2.0 - 1.0) * extent * 2.0,
                    extent * 0.25,
                    -extent * 0.8,
                )
        }
        RouteKind::Teleport => {
            if progress < 0.5 {
                center + Vec3::new(-extent, extent * 0.2, -extent)
            } else {
                center + Vec3::new(extent, extent * 0.8, extent)
            }
        }
        RouteKind::HotspotToHotspot => {
            let phase = (progress * 4.0).fract();
            center
                + Vec3::new(
                    if phase < 0.5 { -extent } else { extent },
                    extent * 0.25,
                    -extent * 0.7,
                )
        }
        RouteKind::SeededRandom => {
            let a = progress * 17.0;
            center
                + Vec3::new(
                    (a * 1.7).sin() * extent * 1.3,
                    extent * (0.2 + 0.4 * (a * 0.7).sin().abs()),
                    (a * 1.1).cos() * extent * 1.3,
                )
        }
    };
    let target = if matches!(route.kind, RouteKind::ProjectileChase) {
        chase_target
    } else {
        center
    };
    Camera {
        eye,
        direction: (target - eye).normalize_or_zero(),
        fov_degrees: route.fov_degrees,
    }
}

struct RouteRuntime {
    report: SpectatorReport,
    screen: Histogram,
    shell: Histogram,
    active_counts: Histogram,
    tick_bytes: Vec<u64>,
    previous_active: BTreeSet<u32>,
    previous_truth: Vec<Pose>,
    previous_reconstruction: Vec<Option<Pose>>,
    previous_visible: Vec<bool>,
    previous_level: Vec<u8>,
    moving_samples: u64,
    freezes: u64,
    reversals: u64,
}

struct SpectatorContext<'a> {
    trace_path: &'a Path,
    actors: &'a [ActorDef],
    builders: &'a [ActorBuilder],
    tracks: &'a [TrackData],
    routes: &'a [RouteSpec],
    bounds_min: Vec3,
    bounds_max: Vec3,
    config: &'a ArchiveConfig,
    archive_hash: &'a str,
}

fn evaluate_spectators(context: SpectatorContext<'_>) -> Result<Vec<SpectatorReport>> {
    let SpectatorContext {
        trace_path,
        actors,
        builders,
        tracks,
        routes,
        bounds_min,
        bounds_max,
        config,
        archive_hash,
    } = context;
    let mut trace = TraceReader::open(trace_path)?;
    let hz = trace.header.physics_hz;
    let output_interval = (hz / 30).max(1);
    let mut segment_indices = vec![0_usize; actors.len()];
    let mut runtimes: Vec<_> = routes
        .iter()
        .map(|route| RouteRuntime {
            report: SpectatorReport {
                name: route.name.clone(),
                route_kind: format!("{:?}", route.kind).to_lowercase(),
                average_mbps: 0.0,
                peak_one_second_mbps: 0.0,
                active_tracks_max: 0,
                active_tracks_p95: 0.0,
                track_churn: 0,
                visible_samples: 0,
                missing_visible_samples: 0,
                screen_px_p95: 0.0,
                screen_px_p99: 0.0,
                screen_px_max: 0.0,
                shell_cm_p99: 0.0,
                shell_cm_max: 0.0,
                freeze_pct: 0.0,
                reversal_pct: 0.0,
                reveal_pop_px_max: 0.0,
                handoff_error_cm_max: 0.0,
                camera_independent_encode_hash: archive_hash.to_string(),
                transport_profiles: Vec::new(),
                timeline: Vec::new(),
                pass: false,
            },
            screen: Histogram::new(4096, 4096.0),
            shell: Histogram::new(4096, 10.0),
            active_counts: Histogram::new(config.hard_track_cap + 1, config.hard_track_cap as f64),
            tick_bytes: vec![0; trace.header.tick_count as usize],
            previous_active: BTreeSet::new(),
            previous_truth: vec![Pose::default(); actors.len()],
            previous_reconstruction: vec![None; actors.len()],
            previous_visible: vec![false; actors.len()],
            previous_level: vec![0; actors.len()],
            moving_samples: 0,
            freezes: 0,
            reversals: 0,
        })
        .collect();
    while let Some(tick) = trace.next_tick()? {
        let mut canonical = Vec::with_capacity(actors.len());
        let mut segments = Vec::with_capacity(actors.len());
        for actor in 0..actors.len() {
            let segment = segment_for_tick(
                &builders[actor].segments,
                &mut segment_indices[actor],
                tick.index,
            );
            canonical.push(reconstructed_pose(
                &builders[actor],
                segment,
                tick.index,
                hz,
                trace.header.gravity,
            ));
            segments.push(segment);
        }
        let chase_target = canonical
            .iter()
            .zip(actors)
            .find(|(_, actor)| actor.part == 5)
            .map_or((bounds_min + bounds_max) * 0.5, |(pose, _)| {
                if pose.position.abs().max_element() < 2_000.0 {
                    pose.position
                } else {
                    (bounds_min + bounds_max) * 0.5
                }
            });
        for (route_index, route) in routes.iter().enumerate() {
            let camera = route_camera(
                route,
                tick.index,
                trace.header.tick_count,
                bounds_min,
                bounds_max,
                chase_target,
            );
            let active = desired_tracks(
                camera,
                tracks,
                config,
                trace.header.pane_width,
                trace.header.pane_height,
            );
            let runtime = &mut runtimes[route_index];
            runtime.report.track_churn += active
                .symmetric_difference(&runtime.previous_active)
                .count() as u64;
            runtime.previous_active = active.clone();
            runtime.report.active_tracks_max = runtime.report.active_tracks_max.max(active.len());
            runtime.active_counts.add(active.len() as f64);
            runtime.tick_bytes[tick.index as usize] = active
                .iter()
                .map(|track| tracks[*track as usize].tick_bytes[tick.index as usize])
                .sum();
            if tick.index % output_interval != 0 {
                continue;
            }
            let visible_before = runtime.report.visible_samples;
            let missing_before = runtime.report.missing_visible_samples;
            let mut frame_screen_max = 0.0_f64;
            let mut frame_shell_max = 0.0_f64;
            for actor in 0..actors.len() {
                let truth = tick.states[actor].pose;
                let visible = sphere_in_view(
                    truth.position,
                    actors[actor].bounding_radius,
                    camera,
                    trace.header.pane_width,
                    trace.header.pane_height,
                    0.0,
                );
                if !visible {
                    runtime.previous_visible[actor] = false;
                    continue;
                }
                runtime.report.visible_samples += 1;
                let segment = segments[actor];
                let (reconstruction, level) = if active.contains(&segment.detail_track) {
                    (Some(canonical[actor]), 2)
                } else if active.contains(&segment.coarse_track) {
                    (
                        Some(coarse_pose(
                            &builders[actor].segments,
                            tick.index,
                            hz,
                            trace.header.gravity,
                        )),
                        1,
                    )
                } else {
                    (None, 0)
                };
                let Some(reconstruction) = reconstruction else {
                    runtime.report.missing_visible_samples += 1;
                    runtime.previous_reconstruction[actor] = None;
                    runtime.previous_visible[actor] = true;
                    runtime.previous_level[actor] = 0;
                    continue;
                };
                let screen_error = projected_error_pixels(
                    truth,
                    reconstruction,
                    actors[actor].bounding_radius,
                    camera,
                    trace.header.pane_width,
                    trace.header.pane_height,
                ) as f64;
                let shell_error =
                    rigid_shell_error_meters(truth, reconstruction, actors[actor].bounding_radius)
                        as f64;
                runtime.screen.add(screen_error);
                runtime.shell.add(shell_error);
                frame_screen_max = frame_screen_max.max(screen_error);
                frame_shell_max = frame_shell_max.max(shell_error);
                if !runtime.previous_visible[actor] {
                    runtime.report.reveal_pop_px_max =
                        runtime.report.reveal_pop_px_max.max(screen_error);
                }
                if runtime.previous_level[actor] != 0
                    && runtime.previous_level[actor] != level
                    && runtime.previous_reconstruction[actor].is_some()
                {
                    let previous = runtime.previous_reconstruction[actor].expect("checked");
                    let truth_delta = truth.position - runtime.previous_truth[actor].position;
                    let reconstructed_delta = reconstruction.position - previous.position;
                    runtime.report.handoff_error_cm_max = runtime
                        .report
                        .handoff_error_cm_max
                        .max((reconstructed_delta - truth_delta).length() as f64 * 100.0);
                }
                if let Some(previous_reconstruction) = runtime.previous_reconstruction[actor] {
                    let truth_step = runtime.previous_truth[actor]
                        .position
                        .distance(truth.position);
                    let truth_screen_step = projected_error_pixels(
                        truth,
                        runtime.previous_truth[actor],
                        actors[actor].bounding_radius,
                        camera,
                        trace.header.pane_width,
                        trace.header.pane_height,
                    );
                    let reconstructed_screen_step = projected_error_pixels(
                        reconstruction,
                        previous_reconstruction,
                        actors[actor].bounding_radius,
                        camera,
                        trace.header.pane_width,
                        trace.header.pane_height,
                    );
                    if truth_step > 0.01 && truth_screen_step > 0.5 {
                        runtime.moving_samples += 1;
                        if reconstructed_screen_step < 0.05 {
                            runtime.freezes += 1;
                        }
                        let truth_delta = truth.position - runtime.previous_truth[actor].position;
                        let reconstructed_delta =
                            reconstruction.position - previous_reconstruction.position;
                        if truth_delta.dot(reconstructed_delta) < 0.0 {
                            runtime.reversals += 1;
                        }
                    }
                }
                runtime.previous_truth[actor] = truth;
                runtime.previous_reconstruction[actor] = Some(reconstruction);
                runtime.previous_visible[actor] = true;
                runtime.previous_level[actor] = level;
            }
            let rate_start = tick.index.saturating_sub(hz.saturating_sub(1)) as usize;
            let rolling_bytes: u64 = runtime.tick_bytes[rate_start..=tick.index as usize]
                .iter()
                .sum();
            runtime.report.timeline.push(SpectatorFrame {
                route: route.name.clone(),
                frame: tick.index.saturating_mul(30) / hz,
                simulation_time: tick.index as f64 / hz as f64,
                rolling_mbps: rolling_bytes as f64 * 8.0 / 1_000_000.0,
                active_tracks: active.len(),
                visible_bodies: runtime.report.visible_samples - visible_before,
                missing_visible_bodies: runtime.report.missing_visible_samples - missing_before,
                screen_error_px_max: frame_screen_max,
                shell_error_cm_max: frame_shell_max * 100.0,
            });
        }
    }
    let duration = trace.header.tick_count as f64 / hz as f64;
    for runtime in &mut runtimes {
        let total: u64 = runtime.tick_bytes.iter().sum();
        runtime.report.average_mbps = total as f64 * 8.0 / duration / 1_000_000.0;
        runtime.report.peak_one_second_mbps = peak_window_mbps(&runtime.tick_bytes, hz);
        runtime.report.active_tracks_p95 = runtime.active_counts.percentile(0.95);
        runtime.report.screen_px_p95 = runtime.screen.percentile(0.95);
        runtime.report.screen_px_p99 = runtime.screen.percentile(0.99);
        runtime.report.screen_px_max = runtime.screen.max;
        runtime.report.shell_cm_p99 = runtime.shell.percentile(0.99) * 100.0;
        runtime.report.shell_cm_max = runtime.shell.max * 100.0;
        runtime.report.freeze_pct =
            runtime.freezes as f64 * 100.0 / runtime.moving_samples.max(1) as f64;
        runtime.report.reversal_pct =
            runtime.reversals as f64 * 100.0 / runtime.moving_samples.max(1) as f64;
        runtime.report.transport_profiles = transport_profiles(&runtime.tick_bytes, hz);
        runtime.report.pass = runtime.report.active_tracks_max <= config.hard_track_cap
            && runtime.report.missing_visible_samples == 0
            && runtime.report.screen_px_p99 <= 1.0
            && runtime.report.screen_px_max <= 4.0
            && runtime.report.freeze_pct == 0.0
            && runtime.report.reversal_pct <= 0.5;
    }
    Ok(runtimes.into_iter().map(|runtime| runtime.report).collect())
}

fn transport_profiles(tick_bytes: &[u64], hz: u32) -> Vec<TransportProfileReport> {
    [
        ("constrained-2mbps", 2.0),
        ("constrained-5mbps", 5.0),
        ("normal-10mbps", 10.0),
        ("high-quality-15mbps", 15.0),
        ("edge-20mbps", 20.0),
    ]
    .into_iter()
    .map(|(name, cap_mbps)| {
        let service_per_tick = cap_mbps * 1_000_000.0 / 8.0 / hz as f64;
        let max_backlog = service_per_tick * hz as f64 * 2.0;
        let mut backlog = 0.0_f64;
        let mut delivered = 0.0_f64;
        let mut cancelled = 0.0_f64;
        let mut max_queue_ms = 0.0_f64;
        for offered in tick_bytes.iter().copied() {
            backlog += offered as f64;
            if backlog > max_backlog {
                cancelled += backlog - max_backlog;
                backlog = max_backlog;
            }
            let sent = backlog.min(service_per_tick);
            backlog -= sent;
            delivered += sent;
            max_queue_ms = max_queue_ms.max(backlog / service_per_tick * 1000.0 / hz as f64);
        }
        TransportProfileReport {
            name,
            cap_mbps,
            offered_bytes: tick_bytes.iter().sum(),
            delivered_bytes: delivered.round() as u64,
            stale_cancelled_bytes: cancelled.round() as u64,
            max_queue_ms,
            pass_250ms_queue_gate: max_queue_ms <= 250.0 && cancelled == 0.0,
        }
    })
    .collect()
}

fn desired_tracks(
    camera: Camera,
    tracks: &[TrackData],
    config: &ArchiveConfig,
    pane_width: u32,
    pane_height: u32,
) -> BTreeSet<u32> {
    let detail_x = cell(camera.eye.x, config.cell_size_m);
    let detail_z = cell(camera.eye.z, config.cell_size_m);
    let coarse_x = cell(camera.eye.x, config.supercell_size_m);
    let coarse_z = cell(camera.eye.z, config.supercell_size_m);
    let coarse_track_count = tracks
        .iter()
        .filter(|track| track.key.tier == TrackTier::Coarse)
        .count();
    let mut selected = BTreeSet::from([GLOBAL_EVENTS_TRACK]);
    for track in tracks {
        let include = match track.key.tier {
            TrackTier::Events => true,
            TrackTier::Coarse => {
                let center = Vec3::new(
                    (track.key.x as f32 + 0.5) * config.supercell_size_m,
                    camera.eye.y,
                    (track.key.z as f32 + 0.5) * config.supercell_size_m,
                );
                coarse_track_count <= 16
                    || ((track.key.x - coarse_x).abs() <= 1 && (track.key.z - coarse_z).abs() <= 1)
                    || sphere_in_view(
                        center,
                        config.supercell_size_m * std::f32::consts::FRAC_1_SQRT_2,
                        camera,
                        pane_width,
                        pane_height,
                        10.0,
                    )
            }
            TrackTier::Detail => {
                let center = Vec3::new(
                    (track.key.x as f32 + 0.5) * config.cell_size_m,
                    camera.eye.y,
                    (track.key.z as f32 + 0.5) * config.cell_size_m,
                );
                let local =
                    (track.key.x - detail_x).abs() <= 1 && (track.key.z - detail_z).abs() <= 1;
                let close_visible = center.distance(camera.eye) <= config.cell_size_m * 8.0
                    && sphere_in_view(
                        center,
                        config.cell_size_m * std::f32::consts::FRAC_1_SQRT_2,
                        camera,
                        pane_width,
                        pane_height,
                        10.0,
                    );
                local || close_visible
            }
        };
        if include {
            selected.insert(track.id);
        }
    }
    if selected.len() > config.target_tracks {
        let mut detail: Vec<_> = selected
            .iter()
            .copied()
            .filter(|id| tracks[*id as usize].key.tier == TrackTier::Detail)
            .collect();
        detail.sort_by_key(|id| {
            let key = tracks[*id as usize].key;
            (key.x - detail_x).abs() + (key.z - detail_z).abs()
        });
        for id in detail.into_iter().rev() {
            if selected.len() <= config.target_tracks {
                break;
            }
            selected.remove(&id);
        }
    }
    selected
}

fn coarse_pose(segments: &[MotionSegment], tick: u32, hz: u32, gravity: Vec3) -> Pose {
    let interval = (hz / 10).max(1);
    let previous = tick / interval * interval;
    let next = previous.saturating_add(interval);
    let previous_index = segment_index_at(segments, previous);
    let next_index = segment_index_at(segments, next);
    if previous_index != next_index {
        return quantize_coarse(segment_at(segments, tick).pose_at(tick, hz, gravity));
    }
    let previous_segment = &segments[previous_index];
    let next_segment = &segments[next_index];
    let a = quantize_coarse(previous_segment.pose_at(previous, hz, gravity));
    if next == previous {
        return a;
    }
    let b = quantize_coarse(next_segment.pose_at(next, hz, gravity));
    let alpha = (tick.saturating_sub(previous) as f32 / (next - previous) as f32).clamp(0.0, 1.0);
    Pose {
        position: a.position.lerp(b.position, alpha),
        rotation: a.rotation.slerp(b.rotation, alpha),
    }
}

fn segment_at(segments: &[MotionSegment], tick: u32) -> &MotionSegment {
    &segments[segment_index_at(segments, tick)]
}

fn segment_index_at(segments: &[MotionSegment], tick: u32) -> usize {
    segments
        .partition_point(|segment| segment.end_tick < tick)
        .min(segments.len() - 1)
}

fn quantize_coarse(pose: Pose) -> Pose {
    Pose {
        position: (pose.position / 0.01).round() * 0.01,
        rotation: pose.rotation,
    }
}

fn peak_window_mbps(bytes: &[u64], hz: u32) -> f64 {
    let window = hz.max(1) as usize;
    let mut sum = 0_u64;
    let mut max = 0_u64;
    for (index, value) in bytes.iter().copied().enumerate() {
        sum += value;
        if index >= window {
            sum -= bytes[index - window];
        }
        max = max.max(sum);
    }
    max as f64 * 8.0 / 1_000_000.0
}

fn percentile_u64(sorted: &[u64], percentile: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() as f64 * percentile).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn track_reports(tracks: &[TrackData], hz: u32, tick_count: u32) -> Vec<TrackReport> {
    let duration = tick_count as f64 / hz as f64;
    tracks
        .iter()
        .map(|track| TrackReport {
            id: track.id,
            tier: track.key.tier,
            x: track.key.x,
            z: track.key.z,
            total_bytes: track.total_bytes,
            average_mbps: track.total_bytes as f64 * 8.0 / duration / 1_000_000.0,
            peak_tick_mbps: track.tick_bytes.iter().copied().max().unwrap_or(0) as f64
                * 8.0
                * hz as f64
                / 1_000_000.0,
        })
        .collect()
}

fn codec_model_report(builders: &[ActorBuilder], hz: u32) -> CodecModelReport {
    let mut report = CodecModelReport {
        segments: 0,
        hold_segments: 0,
        linear_segments: 0,
        ballistic_segments: 0,
        hermite_segments: 0,
        event_records: 0,
        exact_override_records: 0,
        max_segment_ms: 0.0,
    };
    for builder in builders {
        report.event_records += builder.events.len() as u64;
        report.exact_override_records += builder.exact_overrides.len() as u64;
        for segment in &builder.segments {
            report.segments += 1;
            match segment.position_model {
                PositionModel::Hold => report.hold_segments += 1,
                PositionModel::Linear => report.linear_segments += 1,
                PositionModel::Ballistic => report.ballistic_segments += 1,
                PositionModel::Hermite => report.hermite_segments += 1,
            }
            report.max_segment_ms = report.max_segment_ms.max(
                segment.end_tick.saturating_sub(segment.start_tick) as f64 * 1000.0 / hz as f64,
            );
        }
    }
    report
}

fn advanced_ablation_report(
    builders: &[ActorBuilder],
    contact_pair_samples: u64,
    coherent_contact_pair_samples: u64,
    max_contact_pairs_per_tick: usize,
    hierarchy: &HierarchyReport,
    residual_coders: &ResidualReport,
) -> AdvancedAblationReport {
    let mut groups = BTreeMap::<(u32, u32, u32, u8, u8), u64>::new();
    for builder in builders {
        for segment in &builder.segments {
            *groups
                .entry((
                    segment.detail_track,
                    segment.start_tick,
                    segment.end_tick,
                    position_tag(segment.position_model),
                    rotation_tag(segment.rotation_model),
                ))
                .or_default() += 1;
        }
    }
    let coherent_timing_groups = groups.values().filter(|count| **count > 1).count() as u64;
    let metadata_only_upper_bound_bytes_saved = groups
        .values()
        .map(|count| count.saturating_sub(1) * 5)
        .sum();
    let residual_ratio = if residual_coders.fixed_i16_bytes == 0 {
        0.0
    } else {
        residual_coders.zstd_level3_bytes as f64 / residual_coders.fixed_i16_bytes as f64
    };
    AdvancedAblationReport {
        contact_cluster_status: if contact_pair_samples == 0 {
            "rejected_for_missing_pairs"
        } else {
            "measured_not_adopted"
        },
        contact_cluster_reason: if contact_pair_samples == 0 {
            "no contact pairs in this trace; durable joint/bond topology is the hierarchy authority"
        } else {
            "contact pairs were measured, but only velocity-coherent edges are candidates; no shared transform is adopted without a post-decode net byte win"
        },
        coherent_timing_groups,
        metadata_only_upper_bound_bytes_saved,
        contact_pair_samples,
        coherent_contact_pair_samples,
        max_contact_pairs_per_tick,
        unbounded_visibility_status: "rejected",
        unbounded_visibility_reason:
            "an arbitrary free camera has no conservative permanently-occluded set",
        safely_omittable_for_arbitrary_camera: 0,
        timing_header_batching_status: if hierarchy.topology_available {
            "implemented_in_hierarchy_event_stream"
        } else if metadata_only_upper_bound_bytes_saved > 0 {
            "measured_upper_bound"
        } else {
            "no_groups"
        },
        field_mask_status: if hierarchy.position_only_root_fields
            + hierarchy.rotation_only_root_fields
            + hierarchy.unchanged_root_fields
            > 0
        {
            "implemented_in_hierarchy_root_stream"
        } else {
            "pending_topology"
        },
        residual_entropy_status: if residual_ratio > 0.0 && residual_ratio <= 0.15 {
            "measured_zstd_beats_15pct"
        } else if residual_ratio > 0.0 {
            "measured_zstd_below_adoption_threshold"
        } else {
            "no_samples"
        },
        static_suppression_status: if hierarchy.static_root_updates_suppressed > 0 {
            "implemented_in_hierarchy_root_stream"
        } else {
            "no_static_roots_observed"
        },
    }
}

fn fnv1a_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    Ok(format!("{hash:016x}"))
}

fn write_track_csv(path: PathBuf, tracks: &[TrackData], hz: u32, ticks: u32) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    for report in track_reports(tracks, hz, ticks) {
        writer.serialize(report)?;
    }
    writer.flush()?;
    Ok(())
}

fn write_spectator_csv(path: PathBuf, spectators: &[SpectatorReport]) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    writer.write_record([
        "name",
        "average_mbps",
        "peak_one_second_mbps",
        "active_tracks_max",
        "missing_visible_samples",
        "screen_px_p99",
        "screen_px_max",
        "freeze_pct",
        "reversal_pct",
        "pass",
    ])?;
    for spectator in spectators {
        writer.write_record([
            spectator.name.clone(),
            spectator.average_mbps.to_string(),
            spectator.peak_one_second_mbps.to_string(),
            spectator.active_tracks_max.to_string(),
            spectator.missing_visible_samples.to_string(),
            spectator.screen_px_p99.to_string(),
            spectator.screen_px_max.to_string(),
            spectator.freeze_pct.to_string(),
            spectator.reversal_pct.to_string(),
            spectator.pass.to_string(),
        ])?;
    }
    writer.flush()?;
    Ok(())
}

fn write_spectator_timeline_csv(path: PathBuf, spectators: &[SpectatorReport]) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    for frame in spectators.iter().flat_map(|spectator| &spectator.timeline) {
        writer.serialize(frame)?;
    }
    writer.flush()?;
    Ok(())
}

fn write_gop_csv(path: PathBuf, gops: &[GopReport]) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    for gop in gops {
        writer.serialize(gop)?;
    }
    writer.flush()?;
    Ok(())
}

fn write_summary(path: PathBuf, report: &ArchiveReport) -> Result<()> {
    let mut writer = BufWriter::new(File::create(path)?);
    writeln!(writer, "# Omniscient world codec benchmark")?;
    writeln!(writer)?;
    writeln!(
        writer,
        "- Canonical archive: {:.3} Mbps average, {:.2}x smaller than modeled raw.",
        report.baselines.archive_average_mbps, report.baselines.archive_ratio_vs_raw
    )?;
    writeln!(
        writer,
        "- Whole-world shell error: p99 {:.3} cm, max {:.3} cm, pass={}.",
        report.whole_world_error.shell_cm_p99,
        report.whole_world_error.shell_cm_max,
        report.whole_world_error.pass
    )?;
    writeln!(
        writer,
        "- Published tracks: {}, encode-once hash `{}`.",
        report.track_count_global, report.archive_hash_fnv1a64
    )?;
    writeln!(
        writer,
        "- Spectator routes: {}/{}, all pass={}.",
        report.spectators.iter().filter(|route| route.pass).count(),
        report.spectators.len(),
        report.all_standard_routes_pass
    )?;
    writeln!(
        writer,
        "- Hierarchy ablation: topology={}, mode={}, delivered {:.2}% vs independent (candidate {:.2}%), adopted={}, max shell {:.3} cm.",
        report.hierarchy.topology_available,
        report.hierarchy.selected_mode,
        report.hierarchy.reduction_vs_independent_pct,
        report.hierarchy.hierarchy_candidate_reduction_vs_independent_pct,
        report.hierarchy.adopted,
        report.hierarchy.max_shell_cm
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(tick: u32, x: f32) -> Sample {
        Sample {
            tick,
            pose: Pose {
                position: Vec3::new(x, 0.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            linear_velocity: Vec3::X,
        }
    }

    #[test]
    fn linear_trajectory_selects_compact_model() {
        let actor = ActorDef {
            id: 0,
            part: 0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            shapes: Vec::new(),
            bounding_radius: 0.5,
        };
        let samples = [sample(0, 0.0), sample(1, 0.5), sample(2, 1.0)];
        let selected = choose_models(&samples, &actor, 2, Vec3::ZERO, 0.001).unwrap();
        assert!(matches!(selected.0, PositionModel::Linear));
    }

    #[test]
    fn spectator_track_selection_obeys_target() {
        let tracks: Vec<_> = (0..40)
            .map(|index| TrackData {
                id: index,
                key: if index == 0 {
                    TrackKey {
                        tier: TrackTier::Events,
                        x: 0,
                        z: 0,
                    }
                } else {
                    TrackKey {
                        tier: TrackTier::Detail,
                        x: index as i32 % 7 - 3,
                        z: index as i32 / 7 - 3,
                    }
                },
                total_bytes: 0,
                tick_bytes: vec![0],
            })
            .collect();
        let selected = desired_tracks(
            Camera {
                eye: Vec3::ZERO,
                direction: Vec3::Z,
                fov_degrees: 60.0,
            },
            &tracks,
            &ArchiveConfig {
                symbol_audit: false,
                root_rans: false,
                mask: crate::mask::MaskConfig::default(),
                budget: crate::budget::BudgetConfig::default(),
                residual_rans: false,
                shell_error_mm: 20.0,
                gop_ms: 1000,
                max_segment_ms: 250,
                cell_size_m: 128.0,
                supercell_size_m: 512.0,
                target_tracks: 5,
                hard_track_cap: 50,
                route_file: None,
                require_pass: false,
            },
            1920,
            1080,
        );
        assert!(selected.len() <= 5);
        assert!(selected.contains(&GLOBAL_EVENTS_TRACK));
    }

    #[test]
    fn route_does_not_enter_encoder_model_selection() {
        let before = [sample(0, 0.0), sample(1, 0.5), sample(2, 1.0)];
        let actor = ActorDef {
            id: 0,
            part: 0,
            linear_damping: 0.0,
            angular_damping: 0.0,
            shapes: Vec::new(),
            bounding_radius: 0.5,
        };
        let a = choose_models(&before, &actor, 2, Vec3::ZERO, 0.01);
        let _unrelated_camera = route_camera(
            &route("arbitrary", RouteKind::Orbit),
            1,
            3,
            Vec3::ZERO,
            Vec3::ONE,
            Vec3::ZERO,
        );
        let b = choose_models(&before, &actor, 2, Vec3::ZERO, 0.01);
        assert_eq!(
            a.map(|value| (position_tag(value.0), rotation_tag(value.1), value.2)),
            b.map(|value| (position_tag(value.0), rotation_tag(value.1), value.2))
        );
    }
}
