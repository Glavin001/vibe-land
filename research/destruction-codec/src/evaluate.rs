use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{ensure, Context, Result};
use glam::Vec3;
use serde::Serialize;

use crate::{
    codec::{
        angular_error_degrees, packetize, predict_ballistic, projected_error_pixels,
        quantize_vec_i16, quantized_absolute_pose, rigid_shell_error_meters, worst_camera_error,
        Classifier, ClassifierConfig, DatagramRecord, LossModel, LossRng, PhysicalClass,
        PredictorParams, WireChoice, ABSOLUTE_BYTES, BALLISTIC_BYTES, DATAGRAM_HEADER, DELTA_BYTES,
        MOTION_ABSOLUTE_BYTES, MOTION_DELTA_BYTES, RAW_STATE_BYTES, RELIABLE_HEADER,
    },
    hierarchy::{
        decode_gop_block, encode_gop_block, BlockMode, Counters as HierarchyCounters,
        HierarchyConfig, HierarchyTrackKey, TopologyState, TrackCounter,
    },
    interest::{InterestConfig, InterestTrack, InterestViewTrack},
    metrics::{ContinuityConfig, ContinuityTracker},
    presentation::{MotionSnapshot, PresentationConfig, PresentationTrack, PresentedState},
    replay::ReplayWriter,
    scheduler::{
        compute_priority, select_with_ceiling, BudgetCandidate, PriorityConfig, PriorityInput,
    },
    trace::{ActorState, Pose, Tick, TraceReader},
};

#[derive(Clone, Debug)]
pub struct AnalysisConfig {
    /// Trajectory-span cap in ticks on the live path; 0 = block-bounded.
    pub hier_max_span_ticks: usize,
    /// Budgeted selection on the live hierarchy path.
    pub hier_budget: crate::budget::BudgetConfig,
    /// Motion-masked per-body precision on the live hierarchy path.
    pub hier_mask: crate::mask::MaskConfig,
    /// Entropy-code root-segment blocks on the live hierarchy path.
    pub hier_root_rans: bool,
    /// Carry zstd context from the previous block into delta blocks (R6).
    pub hier_block_context: bool,
    pub pixel_budgets: Vec<f32>,
    pub primary_pixel_budget: f32,
    pub loss_rates: Vec<f64>,
    pub seed: u64,
    pub bitrate_budget_mbps: Option<f64>,
    pub strict_total_budget: bool,
    pub snapshot_fps: u32,
    pub output_fps: u32,
    pub distance_scales: Vec<f32>,
    pub chase_projectile: bool,
    pub baseline_interval_ms: u32,
    pub quiescent_ticks: u16,
    pub interpolation_delay_ms: u32,
    pub max_extrapolation_ms: u32,
    pub correction_ms: u32,
    pub telemetry_only: bool,
    pub primary_only: bool,
    pub max_moving_update_ms: u32,
    pub contact_update_ms: u32,
    pub snap_distance_m: f32,
    pub telemetry_loss_rate: f32,
    pub single_view_interest: bool,
    pub omniscient: bool,
    pub world_shell_budget_cm: f32,
    pub interest_fov_margin_deg: f32,
    pub interest_lookahead_ms: u32,
    pub interest_grace_ms: u32,
    pub interest_proximity_m: f32,
    pub live_hierarchy: bool,
    pub hier_gop_ms: u32,
    pub hier_anchor_interval_ms: u32,
    pub hier_paced: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Variant {
    RawFixed,
    QuantizedAbsolute,
    FixedRateDelta,
    QuiescentSuppression,
    QuiescentBallistic,
    FullModePriority,
}

impl Variant {
    const ALL: [Self; 6] = [
        Self::RawFixed,
        Self::QuantizedAbsolute,
        Self::FixedRateDelta,
        Self::QuiescentSuppression,
        Self::QuiescentBallistic,
        Self::FullModePriority,
    ];
    fn label(self) -> &'static str {
        match self {
            Self::RawFixed => "raw_fixed_state",
            Self::QuantizedAbsolute => "quantized_absolute",
            Self::FixedRateDelta => "fixed_rate_delta",
            Self::QuiescentSuppression => "quiescent_suppression",
            Self::QuiescentBallistic => "quiescent_ballistic",
            Self::FullModePriority => "full_mode_priority",
        }
    }
    fn has_classifier(self) -> bool {
        matches!(
            self,
            Self::QuiescentSuppression | Self::QuiescentBallistic | Self::FullModePriority
        )
    }
    fn has_ballistic(self) -> bool {
        matches!(self, Self::QuiescentBallistic | Self::FullModePriority)
    }
}

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Clean,
    Random(f64),
    Burst,
}

impl Scenario {
    fn label(self) -> String {
        match self {
            Self::Clean => "random_0pct".to_string(),
            Self::Random(rate) => {
                let percent = rate * 100.0;
                if percent.fract().abs() < 1e-9 {
                    format!("random_{}pct", percent as u32)
                } else {
                    format!("random_{percent:.3}pct")
                }
            }
            Self::Burst => "burst_100ms".to_string(),
        }
    }
}

#[derive(Clone, Debug)]
struct Endpoint {
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    class: PhysicalClass,
    baseline_id: Option<u32>,
    baseline_pose: Option<Pose>,
    last_update_tick: u32,
}

impl Default for Endpoint {
    fn default() -> Self {
        Self {
            pose: Pose::default(),
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            class: PhysicalClass::ContactActive,
            baseline_id: None,
            baseline_pose: None,
            last_update_tick: 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct EncoderActor {
    endpoint: Endpoint,
    classifier: Classifier,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    actor: usize,
    class: PhysicalClass,
    choice: WireChoice,
    bytes: usize,
    reliable: bool,
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    baseline_id: Option<u32>,
    priority: f32,
    hard_deadline: bool,
}

#[derive(Default, Clone, Debug)]
struct ModeAccumulator {
    samples: u64,
    records: u64,
    omitted: u64,
    payload_bytes: u64,
    reliable_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct VariantRow {
    variant: String,
    pixel_budget: f32,
    loss_scenario: String,
    total_bytes: u64,
    payload_bytes: u64,
    datagram_header_bytes: u64,
    reliable_bytes: u64,
    datagrams: u64,
    average_mbps: f64,
    peak_one_second_mbps: f64,
    p95_one_second_mbps: f64,
    steady_last_20pct_mbps: f64,
    position_cm_p50: f32,
    position_cm_p95: f32,
    position_cm_p99: f32,
    position_cm_max: f32,
    rotation_deg_p95: f32,
    rotation_deg_p99: f32,
    pixel_p50: f32,
    pixel_p95: f32,
    pixel_p99: f32,
    pixel_max: f32,
    samples_above_budget_pct: f64,
    max_excursion_ms: f64,
    stale_p99_ms: f64,
    stale_max_ms: f64,
    freeze_pct: f64,
    freeze_events: u64,
    max_freeze_ms: f64,
    linear_reversal_pct: f64,
    angular_reversal_pct: f64,
    velocity_error_mps_p95: f32,
    angular_velocity_error_radps_p95: f32,
    excess_acceleration_mps2_p95: f32,
    excess_angular_acceleration_radps2_p95: f32,
    update_innovation_cm_p95: f32,
    update_innovation_deg_p95: f32,
    moving_deadline_misses: u64,
    resync_p99_ms: f64,
    invalid_delta_records: u64,
    final_above_budget_bodies: u64,
    permanently_divergent_bodies: u64,
    encoder_wall_ms: f64,
}

#[derive(Serialize)]
struct ModeRow {
    class: PhysicalClass,
    samples: u64,
    records: u64,
    omitted: u64,
    payload_bytes: u64,
    reliable_bytes: u64,
}

#[derive(Serialize)]
struct DistanceRow {
    distance_scale: f32,
    total_bytes: u64,
    average_mbps: f64,
    peak_one_second_mbps: f64,
    pixel_p95: f32,
    pixel_p99: f32,
    position_cm_p95: f32,
}

#[derive(Serialize)]
struct TimelineRow {
    second_start: u32,
    raw_mbps: f64,
    reduced_mbps: f64,
    reduction_ratio: f64,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct FrameTelemetry {
    frame: u32,
    time_seconds: f64,
    frame_mbps: f64,
    rolling_one_second_mbps: f64,
    interested_bodies: u32,
    interest_entries: u32,
    chase_visible_bodies: u32,
    chase_moving_bodies: u32,
    position_cm_p50: f32,
    position_cm_p95: f32,
    position_cm_max: f32,
    rotation_deg_p95: f32,
    chase_pixel_p50: f32,
    chase_pixel_p95: f32,
    chase_pixel_p99: f32,
    chase_pixel_max: f32,
    correction_cm_p95: f32,
    correction_cm_max: f32,
    correction_rotation_deg_p95: f32,
    correction_speed_mps_p95: f32,
    correction_angular_speed_radps_p95: f32,
    excess_step_cm_p95: f32,
    excess_step_cm_max: f32,
    excess_rotation_step_deg_p95: f32,
    excess_rotation_step_deg_max: f32,
    freeze_pct: f64,
    linear_reversal_pct: f64,
    angular_reversal_pct: f64,
    stale_ms_p95: f32,
    stale_ms_max: f32,
    /// Longest consecutive frozen-while-moving run of any body, as of this
    /// frame, in presentation milliseconds.
    freeze_run_ms: f32,
    chase_camera_position_error_m: f32,
    chase_camera_direction_error_deg: f32,
}

struct PassResult {
    row: VariantRow,
    modes: BTreeMap<PhysicalClass, ModeAccumulator>,
    per_second_rates: Vec<f64>,
    frames: Vec<FrameTelemetry>,
}

struct ChaseCameraTrack {
    previous_position: Option<Vec3>,
    eye: Option<Vec3>,
    direction: Vec3,
}

impl Default for ChaseCameraTrack {
    fn default() -> Self {
        Self {
            previous_position: None,
            eye: None,
            direction: Vec3::NEG_Z,
        }
    }
}

impl ChaseCameraTrack {
    fn update(
        &mut self,
        projectile_position: Option<Vec3>,
        fallback: crate::trace::Camera,
    ) -> crate::trace::Camera {
        let Some(position) = projectile_position
            .filter(|position| position.y > -200.0 && position.abs().max_element() < 500.0)
        else {
            self.previous_position = None;
            self.eye = None;
            return fallback;
        };
        let Some(previous) = self.previous_position.replace(position) else {
            return fallback;
        };
        let motion = position - previous;
        if motion.length_squared() > 0.0025 {
            let forward = motion.normalize();
            self.direction = self.direction.lerp(forward, 0.35).normalize_or_zero();
        }
        if self.direction.length_squared() < 0.5 {
            return fallback;
        }
        let desired_eye = position - self.direction * 12.0 + Vec3::Y * 4.0;
        let eye = self
            .eye
            .map_or(desired_eye, |current| current.lerp(desired_eye, 0.32));
        self.eye = Some(eye);
        let target = position + self.direction * 5.0;
        crate::trace::Camera {
            eye,
            direction: (target - eye).normalize(),
            fov_degrees: 70.0,
        }
    }
}

#[derive(Serialize)]
struct Criteria {
    full_vs_fixed_delta_ratio: f64,
    two_x_vs_fixed_delta: bool,
    peak_le_3_mbps: bool,
    steady_le_0_5_mbps: bool,
    visual_p95_le_2px: bool,
    visual_p99_le_4px: bool,
    max_excursion_le_100ms: bool,
    freeze_le_0_1pct: bool,
    max_freeze_le_100ms: bool,
    reversal_le_1pct: bool,
    loss_1pct_resync_p99_le_100ms: bool,
    loss_1pct_no_permanent_divergence: bool,
    overall_pass: bool,
}

#[derive(Serialize)]
struct Summary {
    schema_version: u32,
    trace: String,
    physics_hz: u32,
    tick_count: u32,
    actor_count: usize,
    duration_seconds: f64,
    primary_pixel_budget: f32,
    interpolation_delay_ms: u32,
    max_extrapolation_ms: u32,
    correction_ms: u32,
    byte_accounting: &'static str,
    compression: &'static str,
    quantiles: &'static str,
    criteria: Criteria,
    primary: VariantRow,
    loss_1pct: VariantRow,
    limitations: Vec<&'static str>,
}

#[derive(Serialize)]
struct VideoTelemetrySummary {
    trace: String,
    bitrate_budget_mbps: Option<f64>,
    interpolation_delay_ms: u32,
    max_extrapolation_ms: u32,
    correction_ms: u32,
    max_moving_update_ms: u32,
    contact_update_ms: u32,
    snap_distance_m: f32,
    telemetry_loss_rate: f32,
    single_view_interest: bool,
    omniscient: bool,
    world_shell_budget_cm: f32,
    interest_fov_margin_deg: f32,
    interest_lookahead_ms: u32,
    interest_grace_ms: u32,
    interest_proximity_m: f32,
    aggregate_metric_scope: &'static str,
    raw: Option<VariantRow>,
    buffered: VariantRow,
    visual_acceptance: VisualAcceptance,
    #[serde(skip_serializing_if = "Option::is_none")]
    live_hierarchy: Option<LiveHierarchySummary>,
}

/// Live compact-hierarchy stream accounting. `average_mbps` is comparable to
/// the archive hierarchy average (bytes over duration); `peak_block_mbps` is
/// comparable to the archive per-GOP peak. The sliding-window peaks depend on
/// where block bytes land in time: `burst` charges the whole block to its
/// close tick, `paced` spreads it over the following block interval.
#[derive(Clone, Serialize)]
struct LiveHierarchySummary {
    gop_ms: u32,
    anchor_interval_ms: u32,
    paced: bool,
    /// Sender GOP buffering plus presentation interpolation delay.
    end_to_end_delay_ms: u32,
    /// Paced delivery finishes one block interval after block close.
    paced_delivery_extra_delay_ms: u32,
    blocks: u64,
    keyframe_blocks: u64,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    reliable_bootstrap_bytes: u64,
    topology_bytes: u64,
    root_bytes: u64,
    residual_bytes: u64,
    root_pose_records: u64,
    residual_pose_records: u64,
    omitted_child_pose_records: u64,
    residual_pct_of_children: f64,
    average_mbps: f64,
    p50_block_mbps: f64,
    p95_block_mbps: f64,
    peak_block_mbps: f64,
    sliding_peak_burst_mbps: f64,
    sliding_peak_paced_mbps: f64,
    max_shell_cm: f64,
    shell_bound_cm: f32,
    /// Budgeted-selection outcome on this path.
    budget_candidates: u64,
    budget_emitted: u64,
    budget_deferred: u64,
    budget_required: u64,
    budget_deferred_pct: f64,
    budget_deferred_error_cm_p99: f64,
    budget_deferral_age_ticks_p99: f64,
    residual_runs: u64,
    residual_records_per_run: f64,
    encode_ms_p50_per_block: f64,
    encode_ms_p95_per_block: f64,
    encode_ms_max_per_block: f64,
    decode_ms_p95_per_block: f64,
    /// Total encode wall time over trace duration; below 1.0 is realtime.
    realtime_encode_factor: f64,
}

#[derive(Serialize)]
pub(crate) struct VisualAcceptance {
    pub(crate) pass: bool,
    frame_pixel_p95_p99: f64,
    frame_pixel_p95_max: f64,
    frame_position_p95_cm_p99: f64,
    frame_position_p95_cm_max: f64,
    frame_correction_p95_cm_p99: f64,
    frame_correction_p95_cm_max: f64,
    frame_correction_speed_p95_mps_p99: f64,
    pub(crate) frame_excess_step_p95_cm_p99: f64,
    frame_excess_step_p95_cm_max: f64,
    pub(crate) frame_freeze_run_ms_max: f64,
    pub(crate) frame_freeze_pct_max: f64,
    pub(crate) frame_linear_reversal_pct_p99: f64,
    pub(crate) frame_linear_reversal_pct_max: f64,
    moving_stale_p95_ms_p99: f64,
    pub(crate) moving_stale_ms_max: f64,
    camera_position_error_m_p99: f64,
    camera_position_error_m_max: f64,
    camera_direction_error_deg_p99: f64,
    camera_direction_error_deg_max: f64,
    thresholds: VisualThresholds,
}

#[derive(Clone, Copy, Serialize)]
struct VisualThresholds {
    frame_pixel_p95_p99: f64,
    frame_pixel_p95_max: f64,
    frame_position_p95_cm_p99: f64,
    frame_position_p95_cm_max: f64,
    frame_correction_p95_cm_p99: f64,
    frame_correction_p95_cm_max: f64,
    frame_correction_speed_p95_mps_p99: f64,
    frame_excess_step_p95_cm_p99: f64,
    frame_excess_step_p95_cm_max: f64,
    frame_freeze_run_ms_max: f64,
    frame_freeze_pct_max: f64,
    frame_linear_reversal_pct_p99: f64,
    frame_linear_reversal_pct_max: f64,
    moving_stale_p95_ms_p99: f64,
    moving_stale_ms_max: f64,
    camera_position_error_m_p99: f64,
    camera_position_error_m_max: f64,
    camera_direction_error_deg_p99: f64,
    camera_direction_error_deg_max: f64,
}

pub(crate) fn assess_visual_acceptance(frames: &[FrameTelemetry]) -> VisualAcceptance {
    let thresholds = VisualThresholds {
        frame_pixel_p95_p99: 1.0,
        frame_pixel_p95_max: 4.0,
        frame_position_p95_cm_p99: 5.0,
        frame_position_p95_cm_max: 25.0,
        frame_correction_p95_cm_p99: 2.0,
        frame_correction_p95_cm_max: 25.0,
        frame_correction_speed_p95_mps_p99: 0.5,
        frame_excess_step_p95_cm_p99: 2.0,
        frame_excess_step_p95_cm_max: 10.0,
        // Freeze gating is duration-first: no body may stay frozen while
        // moving for longer than the ~100 ms temporal-integration window (the
        // same standard the datagram path's max_freeze_le_100ms criterion has
        // always used), with an instantaneous mass cap so a scene-wide
        // one-frame hitch still fails. The previous threshold of exactly zero
        // rejected single body-frames -- 33 ms on one body of thousands --
        // which is below what rendered-output comparison can even resolve
        // (Phase C measured zero localized stall at configurations this gate
        // rejected).
        frame_freeze_run_ms_max: 100.0,
        frame_freeze_pct_max: 1.0,
        frame_linear_reversal_pct_p99: 0.5,
        frame_linear_reversal_pct_max: 2.0,
        moving_stale_p95_ms_p99: 100.0,
        // A newly moving body's timestamp can be old for one output frame while
        // its pose remains correct. The p99 gate catches sustained starvation;
        // this maximum only rejects pathological multi-second gaps.
        moving_stale_ms_max: 1_000.0,
        camera_position_error_m_p99: 0.1,
        camera_position_error_m_max: 0.5,
        camera_direction_error_deg_p99: 0.5,
        camera_direction_error_deg_max: 2.0,
    };
    let frame_pixel_p95_p99 = frame_quantile(frames, 0.99, |row| row.chase_pixel_p95);
    let frame_pixel_p95_max = frame_max(frames, |row| row.chase_pixel_p95);
    let frame_position_p95_cm_p99 = frame_quantile(frames, 0.99, |row| row.position_cm_p95);
    let frame_position_p95_cm_max = frame_max(frames, |row| row.position_cm_p95);
    let frame_correction_p95_cm_p99 = frame_quantile(frames, 0.99, |row| row.correction_cm_p95);
    let frame_correction_p95_cm_max = frame_max(frames, |row| row.correction_cm_p95);
    let frame_correction_speed_p95_mps_p99 =
        frame_quantile(frames, 0.99, |row| row.correction_speed_mps_p95);
    let frame_excess_step_p95_cm_p99 = frame_quantile(frames, 0.99, |row| row.excess_step_cm_p95);
    let frame_excess_step_p95_cm_max = frame_max(frames, |row| row.excess_step_cm_p95);
    // Rate gates are evaluated only where the rate is statistically meaningful.
    let sampled = well_sampled(frames);
    let rate_frames = if sampled.is_empty() { frames } else { &sampled };
    let frame_freeze_run_ms_max = frame_max(frames, |row| row.freeze_run_ms);
    let frame_freeze_pct_max = frame_max(rate_frames, |row| row.freeze_pct as f32);
    let frame_linear_reversal_pct_p99 =
        frame_quantile(rate_frames, 0.99, |row| row.linear_reversal_pct as f32);
    let frame_linear_reversal_pct_max =
        frame_max(rate_frames, |row| row.linear_reversal_pct as f32);
    let moving_stale_p95_ms_p99 = frame_quantile(frames, 0.99, |row| row.stale_ms_p95);
    let moving_stale_ms_max = frame_max(frames, |row| row.stale_ms_max);
    let camera_position_error_m_p99 =
        frame_quantile(frames, 0.99, |row| row.chase_camera_position_error_m);
    let camera_position_error_m_max = frame_max(frames, |row| row.chase_camera_position_error_m);
    let camera_direction_error_deg_p99 =
        frame_quantile(frames, 0.99, |row| row.chase_camera_direction_error_deg);
    let camera_direction_error_deg_max =
        frame_max(frames, |row| row.chase_camera_direction_error_deg);
    let pass = frame_pixel_p95_p99 <= thresholds.frame_pixel_p95_p99
        && frame_pixel_p95_max <= thresholds.frame_pixel_p95_max
        && frame_position_p95_cm_p99 <= thresholds.frame_position_p95_cm_p99
        && frame_position_p95_cm_max <= thresholds.frame_position_p95_cm_max
        && frame_correction_p95_cm_p99 <= thresholds.frame_correction_p95_cm_p99
        && frame_correction_p95_cm_max <= thresholds.frame_correction_p95_cm_max
        && frame_correction_speed_p95_mps_p99 <= thresholds.frame_correction_speed_p95_mps_p99
        && frame_excess_step_p95_cm_p99 <= thresholds.frame_excess_step_p95_cm_p99
        && frame_excess_step_p95_cm_max <= thresholds.frame_excess_step_p95_cm_max
        && frame_freeze_run_ms_max <= thresholds.frame_freeze_run_ms_max
        && frame_freeze_pct_max <= thresholds.frame_freeze_pct_max
        && frame_linear_reversal_pct_p99 <= thresholds.frame_linear_reversal_pct_p99
        && frame_linear_reversal_pct_max <= thresholds.frame_linear_reversal_pct_max
        && moving_stale_p95_ms_p99 <= thresholds.moving_stale_p95_ms_p99
        && moving_stale_ms_max <= thresholds.moving_stale_ms_max
        && camera_position_error_m_p99 <= thresholds.camera_position_error_m_p99
        && camera_position_error_m_max <= thresholds.camera_position_error_m_max
        && camera_direction_error_deg_p99 <= thresholds.camera_direction_error_deg_p99
        && camera_direction_error_deg_max <= thresholds.camera_direction_error_deg_max;
    VisualAcceptance {
        frame_freeze_run_ms_max,
        pass,
        frame_pixel_p95_p99,
        frame_pixel_p95_max,
        frame_position_p95_cm_p99,
        frame_position_p95_cm_max,
        frame_correction_p95_cm_p99,
        frame_correction_p95_cm_max,
        frame_correction_speed_p95_mps_p99,
        frame_excess_step_p95_cm_p99,
        frame_excess_step_p95_cm_max,
        frame_freeze_pct_max,
        frame_linear_reversal_pct_p99,
        frame_linear_reversal_pct_max,
        moving_stale_p95_ms_p99,
        moving_stale_ms_max,
        camera_position_error_m_p99,
        camera_position_error_m_max,
        camera_direction_error_deg_p99,
        camera_direction_error_deg_max,
        thresholds,
    }
}

fn frame_quantile(
    frames: &[FrameTelemetry],
    q: f32,
    value: impl Fn(&FrameTelemetry) -> f32,
) -> f64 {
    let mut values: Vec<_> = frames.iter().map(value).collect();
    quantile(&mut values, q) as f64
}

fn frame_max(frames: &[FrameTelemetry], value: impl Fn(&FrameTelemetry) -> f32) -> f64 {
    frames.iter().map(value).fold(0.0, f32::max) as f64
}

/// Frames carrying enough moving bodies for a *percentage* over them to mean
/// anything.
///
/// The reversal and freeze gates are rates whose denominator is the moving-body
/// count, and that count collapses to single digits in the settled tail of a
/// collapse. A max taken over those frames is dominated by one body flipping in
/// a frame with ten movers -- 10% -- while a frame with 4,305 movers reports
/// 0.5% for far more actual reversals. Measured directly: the max was
/// non-monotonic in codec quality (10.0 / 5.4 / 3.2 as precision got *worse*),
/// which is the signature of small-sample noise rather than degradation.
const MIN_RATE_SAMPLE_BODIES: u32 = 100;

fn well_sampled(frames: &[FrameTelemetry]) -> Vec<FrameTelemetry> {
    frames
        .iter()
        .filter(|row| row.chase_moving_bodies >= MIN_RATE_SAMPLE_BODIES)
        .cloned()
        .collect()
}

pub fn analyze(trace_path: &Path, out_dir: &Path, config: &AnalysisConfig) -> Result<()> {
    ensure!(
        !config.pixel_budgets.is_empty(),
        "at least one pixel budget is required"
    );
    ensure!(config
        .pixel_budgets
        .iter()
        .all(|v| *v > 0.0 && v.is_finite()));
    fs::create_dir_all(out_dir)
        .with_context(|| format!("create output directory {}", out_dir.display()))?;
    let metadata = TraceReader::open(trace_path)?;
    ensure!(
        config.snapshot_fps > 0 && config.snapshot_fps <= metadata.header.physics_hz,
        "snapshot-fps must be in 1..=physics_hz"
    );
    ensure!(
        config.output_fps > 0 && config.output_fps <= metadata.header.physics_hz,
        "output-fps must be in 1..=physics_hz"
    );
    let physics_hz = metadata.header.physics_hz;
    let tick_count = metadata.header.tick_count;
    let actor_count = metadata.actors.len();
    drop(metadata);

    let replay_path = out_dir.join("reconstructed.towerstate");
    if config.live_hierarchy {
        return run_live_hierarchy(trace_path, out_dir, config, &replay_path);
    }
    if config.telemetry_only {
        let raw = if config.primary_only {
            None
        } else {
            Some(run_pass(
                trace_path,
                Variant::RawFixed,
                config.primary_pixel_budget,
                1.0,
                Scenario::Clean,
                config,
                None,
            )?)
        };
        let buffered = run_pass(
            trace_path,
            Variant::FullModePriority,
            config.primary_pixel_budget,
            1.0,
            Scenario::Random(config.telemetry_loss_rate as f64),
            config,
            Some(&replay_path),
        )?;
        if let Some(raw) = &raw {
            write_csv(out_dir.join("raw_frame_telemetry.csv"), &raw.frames)?;
        }
        write_csv(
            out_dir.join("presentation_frame_telemetry.csv"),
            &buffered.frames,
        )?;
        let visual_acceptance = assess_visual_acceptance(&buffered.frames);
        serde_json::to_writer_pretty(
            BufWriter::new(File::create(out_dir.join("video_metrics.json"))?),
            &VideoTelemetrySummary {
                trace: trace_path.display().to_string(),
                bitrate_budget_mbps: config.bitrate_budget_mbps,
                interpolation_delay_ms: config.interpolation_delay_ms,
                max_extrapolation_ms: config.max_extrapolation_ms,
                correction_ms: config.correction_ms,
                max_moving_update_ms: config.max_moving_update_ms,
                contact_update_ms: config.contact_update_ms,
                snap_distance_m: config.snap_distance_m,
                telemetry_loss_rate: config.telemetry_loss_rate,
                single_view_interest: config.single_view_interest,
                omniscient: config.omniscient,
                world_shell_budget_cm: config.world_shell_budget_cm,
                interest_fov_margin_deg: config.interest_fov_margin_deg,
                interest_lookahead_ms: config.interest_lookahead_ms,
                interest_grace_ms: config.interest_grace_ms,
                interest_proximity_m: config.interest_proximity_m,
                aggregate_metric_scope: if config.omniscient {
                    "all bodies, camera-independent rigid-shell scheduling"
                } else if config.single_view_interest {
                    "bodies inside the player/chase camera frustum"
                } else {
                    "all bodies, worst error across four cameras"
                },
                raw: raw.map(|result| result.row),
                buffered: buffered.row,
                visual_acceptance,
                live_hierarchy: None,
            },
        )?;
        return Ok(());
    }
    let mut rows = Vec::new();
    let mut primary_modes = BTreeMap::new();
    let mut raw_timeline = None;
    let mut reduced_timeline = None;
    let mut raw_frame_telemetry = None;
    let mut reduced_frame_telemetry = None;
    for &pixel_budget in &config.pixel_budgets {
        for variant in Variant::ALL {
            let write_replay = variant == Variant::FullModePriority
                && (pixel_budget - config.primary_pixel_budget).abs() < f32::EPSILON;
            let result = run_pass(
                trace_path,
                variant,
                pixel_budget,
                1.0,
                Scenario::Clean,
                config,
                write_replay.then_some(replay_path.as_path()),
            )?;
            if write_replay {
                primary_modes = result.modes;
                reduced_timeline = Some(result.per_second_rates);
                reduced_frame_telemetry = Some(result.frames);
            } else if variant == Variant::RawFixed
                && (pixel_budget - config.primary_pixel_budget).abs() < f32::EPSILON
            {
                raw_timeline = Some(result.per_second_rates);
                raw_frame_telemetry = Some(result.frames);
            }
            rows.push(result.row);
        }
    }
    let raw_timeline = raw_timeline.context("missing primary raw timeline")?;
    let reduced_timeline = reduced_timeline.context("missing primary reduced timeline")?;
    ensure!(
        raw_timeline.len() == reduced_timeline.len(),
        "raw/reduced timeline length mismatch"
    );
    let timeline_rows: Vec<_> = raw_timeline
        .into_iter()
        .zip(reduced_timeline)
        .enumerate()
        .map(|(second, (raw_mbps, reduced_mbps))| TimelineRow {
            second_start: second as u32,
            raw_mbps,
            reduced_mbps,
            reduction_ratio: raw_mbps / reduced_mbps.max(f64::EPSILON),
        })
        .collect();
    write_csv(out_dir.join("timeline.csv"), &timeline_rows)?;
    write_timeline_svg(&out_dir.join("timeline.svg"), &timeline_rows)?;
    write_csv(
        out_dir.join("raw_frame_telemetry.csv"),
        &raw_frame_telemetry.context("missing raw frame telemetry")?,
    )?;
    write_csv(
        out_dir.join("presentation_frame_telemetry.csv"),
        &reduced_frame_telemetry.context("missing reduced frame telemetry")?,
    )?;
    for scenario in config
        .loss_rates
        .iter()
        .copied()
        .filter(|rate| *rate > 0.0)
        .map(Scenario::Random)
        .chain(std::iter::once(Scenario::Burst))
    {
        rows.push(
            run_pass(
                trace_path,
                Variant::FullModePriority,
                config.primary_pixel_budget,
                1.0,
                scenario,
                config,
                None,
            )?
            .row,
        );
    }

    write_csv(out_dir.join("per_variant.csv"), &rows)?;
    let rate_rows: Vec<_> = rows
        .iter()
        .filter(|r| r.loss_scenario == "random_0pct")
        .cloned()
        .collect();
    write_csv(out_dir.join("rate_distortion.csv"), &rate_rows)?;
    let mut distance_rows = Vec::new();
    for &distance_scale in &config.distance_scales {
        let row = run_pass(
            trace_path,
            Variant::FullModePriority,
            config.primary_pixel_budget,
            distance_scale,
            Scenario::Clean,
            config,
            None,
        )?
        .row;
        distance_rows.push(DistanceRow {
            distance_scale,
            total_bytes: row.total_bytes,
            average_mbps: row.average_mbps,
            peak_one_second_mbps: row.peak_one_second_mbps,
            pixel_p95: row.pixel_p95,
            pixel_p99: row.pixel_p99,
            position_cm_p95: row.position_cm_p95,
        });
    }
    write_csv(out_dir.join("distance_sweep.csv"), &distance_rows)?;
    let mode_rows: Vec<_> = primary_modes
        .into_iter()
        .map(|(class, value): (PhysicalClass, ModeAccumulator)| ModeRow {
            class,
            samples: value.samples,
            records: value.records,
            omitted: value.omitted,
            payload_bytes: value.payload_bytes,
            reliable_bytes: value.reliable_bytes,
        })
        .collect();
    write_csv(out_dir.join("per_mode.csv"), &mode_rows)?;

    let primary = find_row(
        &rows,
        "full_mode_priority",
        config.primary_pixel_budget,
        "random_0pct",
    )?;
    let fixed = find_row(
        &rows,
        "fixed_rate_delta",
        config.primary_pixel_budget,
        "random_0pct",
    )?;
    let loss_1pct = find_row(
        &rows,
        "full_mode_priority",
        config.primary_pixel_budget,
        "random_1pct",
    )?;
    let ratio = fixed.total_bytes as f64 / primary.total_bytes.max(1) as f64;
    let criteria = Criteria {
        full_vs_fixed_delta_ratio: ratio,
        two_x_vs_fixed_delta: ratio >= 2.0,
        peak_le_3_mbps: primary.peak_one_second_mbps <= 3.0,
        steady_le_0_5_mbps: primary.steady_last_20pct_mbps <= 0.5,
        visual_p95_le_2px: primary.pixel_p95 <= 2.0,
        visual_p99_le_4px: primary.pixel_p99 <= 4.0,
        max_excursion_le_100ms: primary.max_excursion_ms <= 100.0,
        freeze_le_0_1pct: primary.freeze_pct <= 0.1,
        max_freeze_le_100ms: primary.max_freeze_ms <= 100.0,
        reversal_le_1pct: primary.linear_reversal_pct <= 1.0 && primary.angular_reversal_pct <= 1.0,
        loss_1pct_resync_p99_le_100ms: loss_1pct.resync_p99_ms <= 100.0,
        loss_1pct_no_permanent_divergence: loss_1pct.permanently_divergent_bodies == 0,
        overall_pass: ratio >= 2.0
            && primary.peak_one_second_mbps <= 3.0
            && primary.steady_last_20pct_mbps <= 0.5
            && primary.pixel_p95 <= 2.0
            && primary.pixel_p99 <= 4.0
            && primary.max_excursion_ms <= 100.0
            && primary.freeze_pct <= 0.1
            && primary.max_freeze_ms <= 100.0
            && primary.linear_reversal_pct <= 1.0
            && primary.angular_reversal_pct <= 1.0
            && loss_1pct.resync_p99_ms <= 100.0
            && loss_1pct.permanently_divergent_bodies == 0,
    };
    let summary = Summary {
        schema_version: 2,
        trace: trace_path.display().to_string(),
        physics_hz,
        tick_count,
        actor_count,
        duration_seconds: tick_count as f64 / physics_hz as f64,
        primary_pixel_budget: config.primary_pixel_budget,
        interpolation_delay_ms: config.interpolation_delay_ms,
        max_extrapolation_ms: config.max_extrapolation_ms,
        correction_ms: config.correction_ms,
        byte_accounting: "explicit modeled serialization: record sizes + 16-byte datagram headers + 12-byte reliable-message headers",
        compression: "none (packet-local compression not implemented)",
        quantiles: "exact sample quantiles (nearest-rank after sorting)",
        criteria,
        primary: primary.clone(),
        loss_1pct: loss_1pct.clone(),
        limitations: vec![
            "Reliable transition bytes are modeled as delivered immediately; stream framing, retransmission, QUIC/TLS/IP overhead, jitter, and congestion control are excluded.",
            "Wire records are size-accounted and packetized but the evaluator does not retain a production packet bytestream.",
            "Priority uses the four recorded cameras conservatively; player interaction relevance is unavailable in TWTRACE1.",
            "Rotation uses a documented 32-bit smallest-three quaternion; velocity anchors use modeled signed 16-bit components.",
        ],
    };
    serde_json::to_writer_pretty(
        BufWriter::new(File::create(out_dir.join("summary.json"))?),
        &summary,
    )?;
    write_output_readme(out_dir, trace_path, config)?;
    Ok(())
}

/// Live omniscient sender streaming the compact hierarchy codec: GOP-buffered
/// blocks (keyframe on bootstrap and anchor cadence, delta otherwise), per-block
/// zstd, receiver-side reconstruction feeding the shared presentation and
/// telemetry pipeline. Lossless stream framing: loss adds delivery latency on a
/// reliable-ish stream and is not modeled as corruption here.
fn run_live_hierarchy(
    trace_path: &Path,
    out_dir: &Path,
    config: &AnalysisConfig,
    replay_path: &Path,
) -> Result<()> {
    let started = Instant::now();
    let mut manifest_trace = TraceReader::open(trace_path)?;
    let header = manifest_trace.header.clone();
    let actors = manifest_trace.actors.clone();
    let epoch_anchors = manifest_trace
        .topology
        .edges
        .iter()
        .any(|edge| edge.kind != 2);
    let topology_available = !manifest_trace.topology.edges.is_empty();
    let first_tick = manifest_trace
        .next_tick()?
        .context("live hierarchy trace has no ticks")?;
    ensure!(
        topology_available && first_tick.topology.island_roots.len() == actors.len(),
        "live hierarchy requires a TWTRACE1 v3 trace with a topology manifest"
    );
    let rest_poses: Vec<Pose> = first_tick.states.iter().map(|state| state.pose).collect();
    drop(manifest_trace);

    let hz = header.physics_hz;
    let dt = 1.0 / hz as f32;
    let ms_to_ticks =
        |milliseconds: u32| (milliseconds as u64 * hz as u64).div_ceil(1000).max(1) as u32;
    let gop_ticks = ms_to_ticks(config.hier_gop_ms);
    let anchor_ticks = ms_to_ticks(config.hier_anchor_interval_ms);
    let shell_bound_m = config.world_shell_budget_cm / 100.0;
    let hier_config = HierarchyConfig {
        max_span_ticks: config.hier_max_span_ticks,
        symbol_audit: false,
        mask: config.hier_mask,
        budget: config.hier_budget,
        root_rans: config.hier_root_rans,
        residual_rans: false,
        shell_bound_m,
        gop_ticks,
        cell_size_m: 128.0,
        target_tracks: 30,
        baseline_seekable_bytes: 0,
    };
    let presentation_config = PresentationConfig {
        // The receiver cannot present a tick before its block closes: one GOP
        // of sender buffering on top of the configured interpolation delay.
        interpolation_delay_ticks: gop_ticks + ms_to_ticks(config.interpolation_delay_ms),
        max_extrapolation_ticks: ms_to_ticks(config.max_extrapolation_ms),
        correction_seconds: config.correction_ms as f32 / 1000.0,
        dt,
        gravity: header.gravity,
        snap_distance_meters: config.snap_distance_m,
    };
    let continuity_config = ContinuityConfig {
        truth_moving_speed: 0.5,
        presented_still_speed: 0.05,
        angular_moving_speed: 0.1,
        dt,
    };
    let replay = ReplayWriter::create(replay_path, &header, &actors, config.output_fps)?;
    let mut telemetry = TelemetryPass::new(
        &actors,
        header.pane_width,
        header.pane_height,
        hz,
        config.output_fps,
        header.cameras,
        config.chase_projectile,
        false,
        config.primary_pixel_budget,
        presentation_config,
        continuity_config,
        Some(replay),
    );

    telemetry.warmup_ticks = presentation_config.interpolation_delay_ticks;
    telemetry.freeze_tolerance_cm = config.world_shell_budget_cm;
    telemetry.replay_truth_sleeping = true;

    let mut trace = TraceReader::open(trace_path)?;
    let mut encoder_state = TopologyState::default();
    let mut mask_state = crate::mask::MaskState::default();
    let mut budget_state = crate::budget::BudgetState::default();
    let mut receiver_state = TopologyState::default();
    let mut counters = HierarchyCounters::default();
    let mut tracks = BTreeMap::<HierarchyTrackKey, TrackCounter>::new();
    let tick_count = header.tick_count as usize;
    // Stream bootstrap: magic, version, actor count, hz, tick/gop config, and
    // the shared-manifest hash, mirroring the archive container header.
    let bootstrap_bytes = 36_u64;
    let mut burst_ledger = vec![0_u64; tick_count];
    let mut paced_ledger = vec![0_u64; tick_count];
    burst_ledger[0] += bootstrap_bytes;
    paced_ledger[0] += bootstrap_bytes;
    let mut compressed_bytes = 0_u64;
    let mut uncompressed_bytes = 0_u64;
    let mut block_sizes = Vec::<u64>::new();
    let mut keyframe_blocks = 0_u64;
    let mut encode_block_ms = Vec::<f64>::new();
    let mut decode_block_ms = Vec::<f64>::new();
    let mut max_shell_m = 0.0_f32;
    let mut prev_pose: Vec<Option<Pose>> = vec![None; actors.len()];
    let mut prev_hold = vec![false; actors.len()];
    let mut update_history: Vec<VecDeque<u32>> = vec![VecDeque::new(); actors.len()];
    let mut receiver_class = vec![PhysicalClass::ContactActive; actors.len()];
    let mut last_keyframe_start = 0_u32;
    let mut block_compressor = crate::block_zstd::BlockCompressor::new(config.hier_block_context);
    let mut block_decompressor =
        crate::block_zstd::BlockDecompressor::new(config.hier_block_context);

    loop {
        let mut ticks = Vec::with_capacity(gop_ticks as usize);
        for _ in 0..gop_ticks {
            if let Some(tick) = trace.next_tick()? {
                ticks.push(tick);
            } else {
                break;
            }
        }
        if ticks.is_empty() {
            break;
        }
        for tick in &ticks {
            telemetry.begin_tick(tick);
        }
        let block_start = ticks[0].index;
        let keyframe = block_sizes.is_empty()
            || block_start.saturating_sub(last_keyframe_start) >= anchor_ticks;
        if keyframe {
            last_keyframe_start = block_start;
            keyframe_blocks += 1;
        }
        let encode_started = Instant::now();
        let payload = encode_gop_block(
            &ticks,
            &rest_poses,
            &actors,
            hz,
            header.gravity,
            &hier_config,
            epoch_anchors,
            if keyframe {
                BlockMode::StreamKeyframe(&mut encoder_state)
            } else {
                BlockMode::StreamDelta(&mut encoder_state)
            },
            &mut counters,
            &mut tracks,
            &mut mask_state,
            &mut budget_state,
        )?;
        let compressed = block_compressor.compress(&payload, keyframe)?;
        if let Some(row) = counters.block_rows.last_mut() {
            row.compressed = compressed.len() as u64 + 12;
        }
        budget_state.observe_block(
            &config.hier_budget,
            ticks.len() as f64 / header.physics_hz.max(1) as f64,
            payload.len() as u64,
            compressed.len() as u64,
        );
        encode_block_ms.push(encode_started.elapsed().as_secs_f64() * 1000.0);

        let block_bytes = compressed.len() as u64 + 12;
        block_sizes.push(block_bytes);
        compressed_bytes += block_bytes;
        uncompressed_bytes += payload.len() as u64 + 12;
        let close_index = ticks.last().expect("non-empty block").index as usize;
        burst_ledger[close_index] += block_bytes;
        // Paced delivery: spread the block over the next block interval. The
        // final block has no following ticks and is spread over its own.
        let pace_start = if close_index + 1 < tick_count {
            close_index + 1
        } else {
            ticks[0].index as usize
        };
        let pace_end = (pace_start + gop_ticks as usize).min(tick_count);
        let pace_slots = (pace_end - pace_start).max(1) as u64;
        for (offset, slot) in paced_ledger[pace_start..pace_end].iter_mut().enumerate() {
            let share =
                block_bytes / pace_slots + u64::from((offset as u64) < block_bytes % pace_slots);
            *slot += share;
        }

        let decode_started = Instant::now();
        // Decoded through the receiver's own context, so a mismatch between the
        // two sides shows up here as a decode failure rather than silently.
        let decoded = decode_gop_block(
            &block_decompressor.decompress(&compressed, payload.len(), keyframe)?,
            actors.len(),
            &rest_poses,
            epoch_anchors,
            true,
            header.physics_hz,
            header.gravity,
            &receiver_state,
        )?;
        decoded.begin(&mut receiver_state)?;
        for (local_tick, tick) in ticks.iter().enumerate() {
            decoded.apply_tick_events(&mut receiver_state, local_tick as u32);
            for actor in 0..actors.len() {
                let pose = decoded.reconstruct_actor(
                    &receiver_state,
                    tick.index,
                    actor,
                    hz,
                    header.gravity,
                )?;
                let shell = rigid_shell_error_meters(
                    tick.states[actor].pose,
                    pose,
                    actors[actor].bounding_radius,
                );
                max_shell_m = max_shell_m.max(shell);
                ensure!(
                    // Masked bodies sit above the base bound, and deferred
                    // repairs above that again, so the hard gate is the
                    // loosest error the combined policy can ever leave on
                    // screen. Whether it is acceptable is the artifact gates'
                    // job, not this one's.
                    shell
                        <= config.hier_mask.ceiling_m().max(shell_bound_m)
                            * config.hier_budget.hard_cap_factor.max(1.0)
                            * 1.000_01,
                    "live hierarchy shell error exceeded bound at tick {}, actor {}: {} m",
                    tick.index,
                    actor,
                    shell
                );
                let hold = decoded.is_hold_tick(&receiver_state, tick.index, actor)
                    && prev_pose[actor].is_some_and(|previous| {
                        previous.position == pose.position && previous.rotation == pose.rotation
                    });
                if hold && prev_hold[actor] {
                    prev_pose[actor] = Some(pose);
                    continue;
                }
                if !hold && prev_hold[actor] {
                    // Close the coalesced hold span with a synthetic snapshot
                    // one tick back so interpolation never spans the hold gap.
                    if let Some(previous) = prev_pose[actor] {
                        telemetry.presentation[actor].push(MotionSnapshot {
                            tick: tick.index.saturating_sub(1),
                            pose: previous,
                            linear_velocity: Vec3::ZERO,
                            angular_velocity: Vec3::ZERO,
                            class: PhysicalClass::Quiescent,
                        });
                    }
                }
                let (linear_velocity, angular_velocity) = if hold {
                    (Vec3::ZERO, Vec3::ZERO)
                } else if let Some(previous) = prev_pose[actor] {
                    let step = pose.position - previous.position;
                    if step.length() > config.snap_distance_m {
                        // Lifecycle teleport (e.g. a projectile parked at a
                        // sentinel position): a finite-difference velocity is
                        // meaningless and would poison presentation tangents.
                        (Vec3::ZERO, Vec3::ZERO)
                    } else {
                        let mut delta_rotation = pose.rotation * previous.rotation.conjugate();
                        if delta_rotation.w < 0.0 {
                            delta_rotation = -delta_rotation;
                        }
                        (step / dt, delta_rotation.to_scaled_axis() / dt)
                    }
                } else {
                    (Vec3::ZERO, Vec3::ZERO)
                };
                receiver_class[actor] = if hold {
                    PhysicalClass::Quiescent
                } else {
                    PhysicalClass::ContactActive
                };
                if !hold {
                    update_history[actor].push_back(tick.index);
                }
                telemetry.presentation[actor].push(MotionSnapshot {
                    tick: tick.index,
                    pose,
                    linear_velocity,
                    angular_velocity,
                    class: receiver_class[actor],
                });
                prev_pose[actor] = Some(pose);
                prev_hold[actor] = hold;
            }
        }
        decode_block_ms.push(decode_started.elapsed().as_secs_f64() * 1000.0);

        for tick in &ticks {
            // Staleness is scored on the displayed (delay-shifted) timeline:
            // the newest delivered update at or before the presented tick.
            let target = tick
                .index
                .saturating_sub(presentation_config.interpolation_delay_ticks);
            for history in update_history.iter_mut() {
                while history.len() >= 2 && history[1] <= target {
                    history.pop_front();
                }
            }
            telemetry.observe_tick(
                tick.index,
                0,
                0,
                &|actor| {
                    let last = update_history[actor]
                        .front()
                        .copied()
                        .filter(|&t| t <= target)
                        .unwrap_or(0);
                    tick.index - target + last
                },
                &|actor| receiver_class[actor] == PhysicalClass::Quiescent,
            )?;
        }
    }
    trace.finish()?;

    let canonical_ledger = if config.hier_paced {
        &paced_ledger
    } else {
        &burst_ledger
    };
    telemetry.backfill_frame_rates(canonical_ledger);
    let final_above_budget = telemetry.final_above_budget();
    telemetry.finish_replay()?;

    let total_bytes = bootstrap_bytes + compressed_bytes;
    let duration = tick_count as f64 / hz as f64;
    let one_second = window_rates(canonical_ledger, hz as usize);
    let steady_start = tick_count * 4 / 5;
    let steady_bytes: u64 = canonical_ledger[steady_start..].iter().sum();
    let steady_seconds = (tick_count - steady_start).max(1) as f64 / hz as f64;
    let sample_count = telemetry.pixel_errors.len().max(1) as f64;
    let row = VariantRow {
        variant: "live_hierarchy".to_string(),
        pixel_budget: config.primary_pixel_budget,
        loss_scenario: "stream_clean".to_string(),
        total_bytes,
        payload_bytes: compressed_bytes - block_sizes.len() as u64 * 12,
        datagram_header_bytes: block_sizes.len() as u64 * 12,
        reliable_bytes: bootstrap_bytes,
        datagrams: block_sizes.len() as u64,
        average_mbps: total_bytes as f64 * 8.0 / duration.max(dt as f64) / 1_000_000.0,
        peak_one_second_mbps: one_second.iter().copied().fold(0.0, f64::max),
        p95_one_second_mbps: quantile_f64(&one_second, 0.95),
        steady_last_20pct_mbps: steady_bytes as f64 * 8.0 / steady_seconds / 1_000_000.0,
        position_cm_p50: quantile(&mut telemetry.position_errors, 0.50),
        position_cm_p95: quantile(&mut telemetry.position_errors, 0.95),
        position_cm_p99: quantile(&mut telemetry.position_errors, 0.99),
        position_cm_max: telemetry
            .position_errors
            .iter()
            .copied()
            .fold(0.0, f32::max),
        rotation_deg_p95: quantile(&mut telemetry.rotation_errors, 0.95),
        rotation_deg_p99: quantile(&mut telemetry.rotation_errors, 0.99),
        pixel_p50: quantile(&mut telemetry.pixel_errors, 0.50),
        pixel_p95: quantile(&mut telemetry.pixel_errors, 0.95),
        pixel_p99: quantile(&mut telemetry.pixel_errors, 0.99),
        pixel_max: telemetry.pixel_errors.iter().copied().fold(0.0, f32::max),
        samples_above_budget_pct: telemetry.above_count as f64 * 100.0 / sample_count,
        max_excursion_ms: telemetry.max_above_ticks as f64 * 1000.0 / hz as f64,
        stale_p99_ms: quantile(&mut telemetry.stale_samples, 0.99) as f64,
        stale_max_ms: telemetry.stale_samples.iter().copied().fold(0.0, f32::max) as f64,
        freeze_pct: telemetry.frozen_samples as f64 * 100.0
            / telemetry.moving_samples.max(1) as f64,
        freeze_events: telemetry.freeze_events,
        max_freeze_ms: telemetry.max_freeze_ticks as f64 * 1000.0 / hz as f64,
        linear_reversal_pct: telemetry.linear_reversals as f64 * 100.0
            / telemetry.moving_samples.max(1) as f64,
        angular_reversal_pct: telemetry.angular_reversals as f64 * 100.0
            / telemetry.angular_moving_samples.max(1) as f64,
        velocity_error_mps_p95: quantile(&mut telemetry.velocity_errors, 0.95),
        angular_velocity_error_radps_p95: quantile(&mut telemetry.angular_velocity_errors, 0.95),
        excess_acceleration_mps2_p95: quantile(&mut telemetry.excess_accelerations, 0.95),
        excess_angular_acceleration_radps2_p95: quantile(
            &mut telemetry.excess_angular_accelerations,
            0.95,
        ),
        update_innovation_cm_p95: 0.0,
        update_innovation_deg_p95: 0.0,
        moving_deadline_misses: 0,
        resync_p99_ms: 0.0,
        invalid_delta_records: 0,
        final_above_budget_bodies: final_above_budget,
        permanently_divergent_bodies: 0,
        encoder_wall_ms: started.elapsed().as_secs_f64() * 1000.0,
    };

    let mut sorted_blocks = block_sizes.clone();
    sorted_blocks.sort_unstable();
    let block_percentile = |quantile: f64| -> u64 {
        if sorted_blocks.is_empty() {
            return 0;
        }
        let index = ((sorted_blocks.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).floor() as usize;
        sorted_blocks[index]
    };
    let gop_seconds = gop_ticks as f64 / hz as f64;
    let block_mbps = |bytes: u64| bytes as f64 * 8.0 / gop_seconds / 1_000_000.0;
    let mut sorted_encode = encode_block_ms.clone();
    sorted_encode.sort_by(f64::total_cmp);
    let mut sorted_decode = decode_block_ms.clone();
    sorted_decode.sort_by(f64::total_cmp);
    let ms_percentile = |sorted: &[f64], quantile: f64| -> f64 {
        if sorted.is_empty() {
            return 0.0;
        }
        sorted[((sorted.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).floor() as usize]
    };
    let child_samples = counters.residual_pose_records + counters.omitted_child_pose_records;
    counters.flush_residual_runs();
    // R1a: per-block stream attribution for peak analysis.
    {
        let mut writer = csv::Writer::from_path(out_dir.join("live_blocks.csv"))?;
        writer.write_record([
            "start_tick",
            "ticks",
            "keyframe",
            "topology_raw",
            "root_raw",
            "residual_raw",
            "root_records",
            "residual_records",
            "compressed",
            "mbps",
        ])?;
        for row in &counters.block_rows {
            let seconds = row.ticks as f64 / header.physics_hz.max(1) as f64;
            writer.write_record([
                row.start_tick.to_string(),
                row.ticks.to_string(),
                (row.keyframe as u8).to_string(),
                row.topology_raw.to_string(),
                row.root_raw.to_string(),
                row.residual_raw.to_string(),
                row.root_records.to_string(),
                row.residual_records.to_string(),
                row.compressed.to_string(),
                format!("{:.3}", row.compressed as f64 * 8.0 / seconds / 1e6),
            ])?;
        }
        writer.flush()?;
    }
    let summary = LiveHierarchySummary {
        gop_ms: config.hier_gop_ms,
        anchor_interval_ms: config.hier_anchor_interval_ms,
        paced: config.hier_paced,
        end_to_end_delay_ms: config.hier_gop_ms + config.interpolation_delay_ms,
        paced_delivery_extra_delay_ms: if config.hier_paced {
            config.hier_gop_ms
        } else {
            0
        },
        blocks: block_sizes.len() as u64,
        keyframe_blocks,
        compressed_bytes,
        uncompressed_bytes,
        reliable_bootstrap_bytes: bootstrap_bytes,
        topology_bytes: counters.topology_bytes,
        root_bytes: counters.root_bytes,
        residual_bytes: counters.residual_bytes,
        root_pose_records: counters.root_pose_records,
        residual_pose_records: counters.residual_pose_records,
        omitted_child_pose_records: counters.omitted_child_pose_records,
        residual_pct_of_children: if child_samples == 0 {
            0.0
        } else {
            counters.residual_pose_records as f64 * 100.0 / child_samples as f64
        },
        average_mbps: total_bytes as f64 * 8.0 / duration / 1_000_000.0,
        p50_block_mbps: block_mbps(block_percentile(0.50)),
        p95_block_mbps: block_mbps(block_percentile(0.95)),
        peak_block_mbps: block_mbps(sorted_blocks.last().copied().unwrap_or(0)),
        sliding_peak_burst_mbps: window_rates(&burst_ledger, hz as usize)
            .iter()
            .copied()
            .fold(0.0, f64::max),
        sliding_peak_paced_mbps: window_rates(&paced_ledger, hz as usize)
            .iter()
            .copied()
            .fold(0.0, f64::max),
        max_shell_cm: max_shell_m as f64 * 100.0,
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
        shell_bound_cm: config.world_shell_budget_cm,
        encode_ms_p50_per_block: ms_percentile(&sorted_encode, 0.50),
        encode_ms_p95_per_block: ms_percentile(&sorted_encode, 0.95),
        encode_ms_max_per_block: sorted_encode.last().copied().unwrap_or(0.0),
        decode_ms_p95_per_block: ms_percentile(&sorted_decode, 0.95),
        realtime_encode_factor: encode_block_ms.iter().sum::<f64>() / 1000.0 / duration,
    };

    write_csv(
        out_dir.join("presentation_frame_telemetry.csv"),
        &telemetry.frame_telemetry,
    )?;
    let visual_acceptance = assess_visual_acceptance(&telemetry.frame_telemetry);
    serde_json::to_writer_pretty(
        BufWriter::new(File::create(out_dir.join("video_metrics.json"))?),
        &VideoTelemetrySummary {
            trace: trace_path.display().to_string(),
            bitrate_budget_mbps: config.bitrate_budget_mbps,
            interpolation_delay_ms: config.interpolation_delay_ms,
            max_extrapolation_ms: config.max_extrapolation_ms,
            correction_ms: config.correction_ms,
            max_moving_update_ms: config.max_moving_update_ms,
            contact_update_ms: config.contact_update_ms,
            snap_distance_m: config.snap_distance_m,
            telemetry_loss_rate: config.telemetry_loss_rate,
            single_view_interest: config.single_view_interest,
            omniscient: config.omniscient,
            world_shell_budget_cm: config.world_shell_budget_cm,
            interest_fov_margin_deg: config.interest_fov_margin_deg,
            interest_lookahead_ms: config.interest_lookahead_ms,
            interest_grace_ms: config.interest_grace_ms,
            interest_proximity_m: config.interest_proximity_m,
            aggregate_metric_scope:
                "all bodies, camera-independent rigid-shell gate, live hierarchy stream",
            raw: None,
            buffered: row,
            visual_acceptance,
            live_hierarchy: Some(summary),
        },
    )?;
    Ok(())
}

pub fn write_ground_truth_replay(trace_path: &Path, output: &Path, output_fps: u32) -> Result<()> {
    let mut trace = TraceReader::open(trace_path)?;
    ensure!(
        output_fps > 0 && output_fps <= trace.header.physics_hz,
        "output-fps must be in 1..=physics_hz"
    );
    let mut writer = ReplayWriter::create(output, &trace.header, &trace.actors, output_fps)?;
    let mut last_frame = None;
    while let Some(tick) = trace.next_tick()? {
        let frame = tick.index.saturating_mul(output_fps) / trace.header.physics_hz;
        if last_frame == Some(frame) {
            continue;
        }
        let poses: Vec<_> = tick.states.iter().map(|state| state.pose).collect();
        let sleeping: Vec<_> = tick.states.iter().map(|state| state.sleeping()).collect();
        writer.write_frame(&poses, &sleeping)?;
        last_frame = Some(frame);
    }
    trace.finish()?;
    writer.finish()
}

fn find_row<'a>(
    rows: &'a [VariantRow],
    variant: &str,
    pixel: f32,
    loss: &str,
) -> Result<&'a VariantRow> {
    rows.iter()
        .find(|r| {
            r.variant == variant
                && (r.pixel_budget - pixel).abs() < f32::EPSILON
                && r.loss_scenario == loss
        })
        .with_context(|| format!("missing result row {variant}/{pixel}/{loss}"))
}

fn run_pass(
    trace_path: &Path,
    variant: Variant,
    pixel_budget: f32,
    camera_distance_scale: f32,
    scenario: Scenario,
    config: &AnalysisConfig,
    replay_path: Option<&Path>,
) -> Result<PassResult> {
    let started = Instant::now();
    let mut trace = TraceReader::open(trace_path)?;
    let mut cameras = trace.header.cameras;
    for camera in &mut cameras {
        camera.eye *= camera_distance_scale;
    }
    let hz = trace.header.physics_hz;
    let dt = 1.0 / hz as f32;
    let fixed_interval = (hz / config.snapshot_fps).max(1);
    let baseline_ticks = (config.baseline_interval_ms as u64 * hz as u64)
        .div_ceil(1000)
        .max(1) as u32;
    let budget_per_tick = config
        .bitrate_budget_mbps
        .map(|mbps| (mbps * 1_000_000.0 / 8.0 / hz as f64) as usize);
    let budget_per_second = config
        .bitrate_budget_mbps
        .map(|mbps| (mbps * 1_000_000.0 / 8.0) as usize);
    let classifier_cfg = ClassifierConfig {
        enter_ticks: config.quiescent_ticks,
        ..ClassifierConfig::default()
    };
    let ms_to_ticks =
        |milliseconds: u32| (milliseconds as u64 * hz as u64).div_ceil(1000).max(1) as u32;
    let priority_config = PriorityConfig {
        max_moving_age_ticks: ms_to_ticks(config.max_moving_update_ms),
        contact_target_age_ticks: ms_to_ticks(config.contact_update_ms),
        ..PriorityConfig::from_hz(hz)
    };
    let presentation_config = PresentationConfig {
        interpolation_delay_ticks: ms_to_ticks(config.interpolation_delay_ms),
        max_extrapolation_ticks: ms_to_ticks(config.max_extrapolation_ms),
        correction_seconds: config.correction_ms as f32 / 1000.0,
        dt,
        gravity: trace.header.gravity,
        snap_distance_meters: config.snap_distance_m,
    };
    let interest_config = InterestConfig {
        fov_margin_degrees: config.interest_fov_margin_deg,
        lookahead_ticks: ms_to_ticks(config.interest_lookahead_ms),
        grace_ticks: ms_to_ticks(config.interest_grace_ms),
        proximity_meters: config.interest_proximity_m,
        dt,
        pane_width: trace.header.pane_width,
        pane_height: trace.header.pane_height,
    };
    let mut encoder = vec![EncoderActor::default(); trace.actors.len()];
    let mut decoder = vec![Endpoint::default(); trace.actors.len()];
    let mut interest_tracks = vec![InterestTrack::default(); trace.actors.len()];
    let mut interest_view = InterestViewTrack::default();
    let continuity_config = ContinuityConfig {
        truth_moving_speed: 0.5,
        presented_still_speed: 0.05,
        angular_moving_speed: 0.1,
        dt,
    };
    let mut sequence = 0_u32;
    let mut baseline_id = 0_u32;
    let mut rng = LossRng::new(config.seed ^ scenario_seed(scenario));
    let loss_model = match scenario {
        Scenario::Clean => LossModel::Random(0.0),
        Scenario::Random(rate) => LossModel::Random(rate),
        Scenario::Burst => LossModel::Burst {
            start_tick: trace.header.tick_count / 2,
            length_ticks: (hz / 10).max(1),
        },
    };
    let mut tick_bytes = vec![0_u64; trace.header.tick_count as usize];
    let mut update_innovation_cm = Vec::new();
    let mut update_innovation_deg = Vec::new();
    let mut resync_samples = Vec::new();
    let mut loss_open_tick = vec![None::<u32>; trace.actors.len()];
    let mut invalid_delta = 0_u64;
    let mut moving_deadline_misses = 0_u64;
    let mut payload_bytes = 0_u64;
    let mut header_bytes = 0_u64;
    let mut reliable_bytes = 0_u64;
    let mut datagrams = 0_u64;
    let mut mode = BTreeMap::<PhysicalClass, ModeAccumulator>::new();
    let replay = replay_path
        .map(|path| ReplayWriter::create(path, &trace.header, &trace.actors, config.output_fps))
        .transpose()?;
    let mut telemetry = TelemetryPass::new(
        &trace.actors,
        trace.header.pane_width,
        trace.header.pane_height,
        hz,
        config.output_fps,
        cameras,
        config.chase_projectile,
        config.single_view_interest && variant == Variant::FullModePriority,
        pixel_budget,
        presentation_config,
        continuity_config,
        replay,
    );

    while let Some(tick) = trace.next_tick()? {
        telemetry.begin_tick(&tick);
        let tick_cameras = if config.chase_projectile {
            projectile_chase_cameras(cameras, &trace.actors, &tick.states)
        } else {
            cameras
        };
        let interest_cameras = interest_view.update(tick_cameras[3], interest_config);
        let is_baseline = tick.index % baseline_ticks == 0;
        if is_baseline {
            baseline_id = baseline_id.wrapping_add(1);
        }
        for actor in 0..encoder.len() {
            let encoder_predicts = variant == Variant::FullModePriority
                || (encoder[actor].endpoint.class == PhysicalClass::Ballistic
                    && variant.has_ballistic());
            if tick.index > 0 && encoder_predicts {
                advance_endpoint(
                    &mut encoder[actor].endpoint,
                    &trace.actors[actor],
                    trace.header.gravity,
                    dt,
                );
            }
            let decoder_predicts = variant == Variant::FullModePriority
                || (decoder[actor].class == PhysicalClass::Ballistic && variant.has_ballistic());
            if tick.index > 0 && decoder_predicts {
                advance_endpoint(
                    &mut decoder[actor],
                    &trace.actors[actor],
                    trace.header.gravity,
                    dt,
                );
            }
        }

        let mut candidates = Vec::new();
        let mut reliable_this_tick = 0_u64;
        let mut interested_this_tick = 0_u32;
        let mut interest_entries_this_tick = 0_u32;
        for (actor_index, truth) in tick.states.iter().copied().enumerate() {
            let previous_class = encoder[actor_index].endpoint.class;
            let class = if variant.has_classifier() {
                encoder[actor_index]
                    .classifier
                    .update(truth, classifier_cfg)
            } else {
                PhysicalClass::ContactActive
            };
            mode.entry(class).or_default().samples += 1;
            let (interested, interest_entry) =
                if config.single_view_interest && variant == Variant::FullModePriority {
                    let decision = interest_tracks[actor_index].update(
                        tick.index,
                        truth.pose,
                        truth.linear_velocity,
                        trace.actors[actor_index].bounding_radius,
                        interest_cameras,
                        interest_config,
                    );
                    (decision.relevant, decision.entering)
                } else {
                    (true, false)
                };
            interested_this_tick += u32::from(interested);
            interest_entries_this_tick += u32::from(interest_entry);
            let transition = class != previous_class;
            // ImpactBurst is a scheduling hint within contact-active motion,
            // not a stateful wire mode. Reliability is reserved for anchors
            // whose loss would make subsequent prediction undecodable.
            let reliable_transition = interested
                && variant.has_classifier()
                && (tick.index == 0
                    || (transition
                        && (class == PhysicalClass::Ballistic
                            || previous_class == PhysicalClass::Ballistic
                            || class == PhysicalClass::Quiescent
                            || previous_class == PhysicalClass::Quiescent)));
            if !interested {
                encoder[actor_index].endpoint.class = class;
                mode.entry(class).or_default().omitted += 1;
                continue;
            }
            if reliable_transition {
                let wire_pose = quantized_absolute_pose(truth.pose);
                let motion_transition =
                    variant == Variant::FullModePriority && class != PhysicalClass::Quiescent;
                let (wire_linear_velocity, wire_angular_velocity) =
                    if class == PhysicalClass::Ballistic || motion_transition {
                        (
                            quantize_vec_i16(truth.linear_velocity, 0.01),
                            quantize_vec_i16(truth.angular_velocity, 0.001),
                        )
                    } else {
                        (truth.linear_velocity, truth.angular_velocity)
                    };
                let transition_size = if motion_transition {
                    MOTION_ABSOLUTE_BYTES
                } else if class == PhysicalClass::Ballistic {
                    BALLISTIC_BYTES
                } else {
                    ABSOLUTE_BYTES
                } + RELIABLE_HEADER;
                reliable_this_tick += transition_size as u64;
                let acc = mode.entry(class).or_default();
                acc.records += 1;
                acc.reliable_bytes += transition_size as u64;
                if tick.index > 0 {
                    update_innovation_cm.push(
                        (wire_pose.position - decoder[actor_index].pose.position).length() * 100.0,
                    );
                    update_innovation_deg.push(angular_error_degrees(
                        wire_pose.rotation,
                        decoder[actor_index].pose.rotation,
                    ));
                }
                for endpoint in [
                    &mut encoder[actor_index].endpoint,
                    &mut decoder[actor_index],
                ] {
                    endpoint.pose = wire_pose;
                    endpoint.linear_velocity = wire_linear_velocity;
                    endpoint.angular_velocity = wire_angular_velocity;
                    endpoint.class = class;
                    endpoint.last_update_tick = tick.index;
                    endpoint.baseline_id = Some(baseline_id);
                    endpoint.baseline_pose = Some(wire_pose);
                }
                telemetry.presentation[actor_index].push(MotionSnapshot {
                    tick: tick.index,
                    pose: wire_pose,
                    linear_velocity: wire_linear_velocity,
                    angular_velocity: wire_angular_velocity,
                    class,
                });
                if let Some(start) = loss_open_tick[actor_index].take() {
                    resync_samples.push((tick.index - start) as f32 * 1000.0 / hz as f32);
                }
            } else {
                encoder[actor_index].endpoint.class = class;
            }
            let needs_interest_anchor = interest_entry && !reliable_transition;

            let (predicted_error, error_budget) = if config.omniscient {
                (
                    rigid_shell_error_meters(
                        truth.pose,
                        encoder[actor_index].endpoint.pose,
                        trace.actors[actor_index].bounding_radius,
                    ) * 100.0,
                    config.world_shell_budget_cm,
                )
            } else {
                (
                    worst_camera_error(
                        truth.pose,
                        encoder[actor_index].endpoint.pose,
                        &trace.actors[actor_index],
                        &tick_cameras,
                        trace.header.pane_width,
                        trace.header.pane_height,
                    ),
                    pixel_budget,
                )
            };
            let priority = compute_priority(
                PriorityInput {
                    class,
                    projected_error_ratio: predicted_error / error_budget,
                    age_ticks: tick
                        .index
                        .saturating_sub(encoder[actor_index].endpoint.last_update_tick),
                    contacts: truth.contacts,
                    linear_speed: truth.linear_velocity.length(),
                    angular_speed: truth.angular_velocity.length(),
                    linear_velocity_innovation: (truth.linear_velocity
                        - encoder[actor_index].endpoint.linear_velocity)
                        .length(),
                    angular_velocity_innovation: (truth.angular_velocity
                        - encoder[actor_index].endpoint.angular_velocity)
                        .length(),
                    contact_begin: truth.flags & 4 != 0,
                    joint_break: truth.flags & 16 != 0,
                    wake: truth.flags & 64 != 0,
                    interest_entry: needs_interest_anchor,
                },
                priority_config,
            );
            let scheduled = tick.index % fixed_interval == 0;
            let should_update = match variant {
                Variant::RawFixed | Variant::QuantizedAbsolute | Variant::FixedRateDelta => {
                    scheduled
                }
                Variant::QuiescentSuppression => class != PhysicalClass::Quiescent && scheduled,
                Variant::QuiescentBallistic => {
                    class != PhysicalClass::Quiescent
                        && (class != PhysicalClass::Ballistic || predicted_error > error_budget)
                        && scheduled
                }
                Variant::FullModePriority => priority.should_send,
            };
            let final_tick = tick.index + 1 == trace.header.tick_count;
            let force_baseline = needs_interest_anchor
                || ((is_baseline || final_tick)
                    && class != PhysicalClass::Quiescent
                    && predicted_error > 0.0
                    && matches!(
                        variant,
                        Variant::FixedRateDelta
                            | Variant::QuiescentSuppression
                            | Variant::QuiescentBallistic
                            | Variant::FullModePriority
                    )
                    && !reliable_transition);
            if !should_update && !force_baseline {
                mode.entry(class).or_default().omitted += 1;
                continue;
            }
            let wire_pose = if variant == Variant::RawFixed {
                truth.pose
            } else {
                quantized_absolute_pose(truth.pose)
            };
            let (choice, mut bytes, required_baseline) = if variant == Variant::RawFixed {
                (WireChoice::Raw, RAW_STATE_BYTES, None)
            } else if force_baseline || variant == Variant::QuantizedAbsolute {
                (WireChoice::Absolute, ABSOLUTE_BYTES, Some(baseline_id))
            } else if matches!(
                variant,
                Variant::FixedRateDelta
                    | Variant::QuiescentSuppression
                    | Variant::QuiescentBallistic
                    | Variant::FullModePriority
            ) && encoder[actor_index].endpoint.baseline_id == Some(baseline_id)
                && delta_fits(
                    wire_pose.position,
                    encoder[actor_index]
                        .endpoint
                        .baseline_pose
                        .expect("matching baseline ID")
                        .position,
                )
            {
                (WireChoice::Delta, DELTA_BYTES, Some(baseline_id))
            } else {
                (WireChoice::Absolute, ABSOLUTE_BYTES, None)
            };
            if variant == Variant::FullModePriority {
                bytes = match choice {
                    WireChoice::Raw => RAW_STATE_BYTES,
                    WireChoice::Absolute => MOTION_ABSOLUTE_BYTES,
                    WireChoice::Delta => MOTION_DELTA_BYTES,
                };
            }
            candidates.push(Candidate {
                actor: actor_index,
                class,
                choice,
                bytes,
                reliable: force_baseline,
                pose: wire_pose,
                linear_velocity: if variant == Variant::RawFixed {
                    truth.linear_velocity
                } else if variant == Variant::FullModePriority {
                    quantize_vec_i16(truth.linear_velocity, 0.01)
                } else {
                    encoder[actor_index].endpoint.linear_velocity
                },
                angular_velocity: if variant == Variant::RawFixed {
                    truth.angular_velocity
                } else if variant == Variant::FullModePriority {
                    quantize_vec_i16(truth.angular_velocity, 0.001)
                } else {
                    encoder[actor_index].endpoint.angular_velocity
                },
                baseline_id: required_baseline,
                priority: priority.score,
                hard_deadline: priority.hard_deadline || needs_interest_anchor,
            });
        }

        if variant == Variant::FullModePriority {
            let limit = if config.strict_total_budget {
                budget_per_second.map(|budget| {
                    let start = tick.index.saturating_sub(hz.saturating_sub(1)) as usize;
                    let already_sent: u64 = tick_bytes[start..tick.index as usize].iter().sum();
                    budget.saturating_sub(already_sent as usize)
                })
            } else {
                budget_per_tick
            };
            let budget_candidates: Vec<_> = candidates
                .iter()
                .enumerate()
                .map(|(index, candidate)| BudgetCandidate {
                    index,
                    cost_bytes: candidate.bytes
                        + if candidate.reliable {
                            RELIABLE_HEADER
                        } else {
                            0
                        },
                    priority: candidate.priority,
                    required: candidate.hard_deadline
                        || (candidate.reliable && !config.strict_total_budget),
                })
                .collect();
            let selection =
                select_with_ceiling(&budget_candidates, limit, reliable_this_tick as usize);
            let mut selected = vec![false; candidates.len()];
            for index in selection.selected_indices {
                selected[index] = true;
            }
            moving_deadline_misses += candidates
                .iter()
                .enumerate()
                .filter(|(index, candidate)| candidate.hard_deadline && !selected[*index])
                .count() as u64;
            let mut index = 0;
            candidates.retain(|_| {
                let keep = selected[index];
                index += 1;
                keep
            });
        }
        for candidate in &candidates {
            let actor = &mut encoder[candidate.actor];
            let endpoint = &mut actor.endpoint;
            endpoint.pose = candidate.pose;
            endpoint.linear_velocity = candidate.linear_velocity;
            endpoint.angular_velocity = candidate.angular_velocity;
            endpoint.last_update_tick = tick.index;
            if candidate.choice == WireChoice::Absolute
                && candidate.baseline_id == Some(baseline_id)
            {
                endpoint.baseline_id = Some(baseline_id);
                endpoint.baseline_pose = Some(candidate.pose);
            }
            let acc = mode.entry(endpoint.class).or_default();
            acc.records += 1;
            if candidate.reliable {
                acc.reliable_bytes += candidate.bytes as u64;
            } else {
                acc.payload_bytes += candidate.bytes as u64;
            }
        }
        let reliable_candidates: Vec<_> = candidates
            .iter()
            .filter(|candidate| candidate.reliable)
            .collect();
        if !reliable_candidates.is_empty() {
            reliable_this_tick += DATAGRAM_HEADER as u64;
            for candidate in reliable_candidates {
                reliable_this_tick += candidate.bytes as u64;
                let endpoint = &mut decoder[candidate.actor];
                if tick.index > 0 {
                    update_innovation_cm
                        .push((candidate.pose.position - endpoint.pose.position).length() * 100.0);
                    update_innovation_deg.push(angular_error_degrees(
                        candidate.pose.rotation,
                        endpoint.pose.rotation,
                    ));
                }
                endpoint.pose = candidate.pose;
                endpoint.linear_velocity = candidate.linear_velocity;
                endpoint.angular_velocity = candidate.angular_velocity;
                endpoint.class = candidate.class;
                endpoint.last_update_tick = tick.index;
                endpoint.baseline_id = candidate.baseline_id;
                endpoint.baseline_pose = Some(candidate.pose);
                if let Some(start) = loss_open_tick[candidate.actor].take() {
                    resync_samples.push((tick.index - start) as f32 * 1000.0 / hz as f32);
                }
                telemetry.presentation[candidate.actor].push(MotionSnapshot {
                    tick: tick.index,
                    pose: candidate.pose,
                    linear_velocity: candidate.linear_velocity,
                    angular_velocity: candidate.angular_velocity,
                    class: candidate.class,
                });
            }
        }
        let packet_records: Vec<_> = candidates
            .iter()
            .filter(|candidate| !candidate.reliable)
            .map(|candidate| DatagramRecord {
                actor: candidate.actor as u32,
                choice: candidate.choice,
                bytes: candidate.bytes,
            })
            .collect();
        let packets = packetize(&packet_records, &mut sequence, baseline_id, tick.index);
        for packet in packets {
            debug_assert_eq!(packet.tick, tick.index);
            debug_assert_eq!(packet.baseline_id, baseline_id);
            debug_assert!(packet.sequence < sequence);
            datagrams += 1;
            payload_bytes += (packet.bytes - DATAGRAM_HEADER) as u64;
            header_bytes += DATAGRAM_HEADER as u64;
            tick_bytes[tick.index as usize] += packet.bytes as u64;
            let dropped = loss_model.dropped(tick.index, &mut rng);
            for record in packet.records {
                let candidate = candidates
                    .iter()
                    .find(|candidate| {
                        !candidate.reliable && candidate.actor == record.actor as usize
                    })
                    .expect("packet candidate");
                debug_assert_eq!(candidate.choice, record.choice);
                if dropped {
                    loss_open_tick[candidate.actor].get_or_insert(tick.index);
                    continue;
                }
                if candidate.choice == WireChoice::Delta
                    && decoder[candidate.actor].baseline_id != candidate.baseline_id
                {
                    invalid_delta += 1;
                    loss_open_tick[candidate.actor].get_or_insert(tick.index);
                    continue;
                }
                let endpoint = &mut decoder[candidate.actor];
                if tick.index > 0 {
                    update_innovation_cm
                        .push((candidate.pose.position - endpoint.pose.position).length() * 100.0);
                    update_innovation_deg.push(angular_error_degrees(
                        candidate.pose.rotation,
                        endpoint.pose.rotation,
                    ));
                }
                endpoint.pose = candidate.pose;
                endpoint.linear_velocity = candidate.linear_velocity;
                endpoint.angular_velocity = candidate.angular_velocity;
                endpoint.class = candidate.class;
                endpoint.last_update_tick = tick.index;
                if candidate.choice == WireChoice::Absolute
                    && candidate.baseline_id == Some(baseline_id)
                {
                    endpoint.baseline_id = Some(baseline_id);
                    endpoint.baseline_pose = Some(candidate.pose);
                }
                if let Some(start) = loss_open_tick[candidate.actor].take() {
                    resync_samples.push((tick.index - start) as f32 * 1000.0 / hz as f32);
                }
                telemetry.presentation[candidate.actor].push(MotionSnapshot {
                    tick: tick.index,
                    pose: candidate.pose,
                    linear_velocity: candidate.linear_velocity,
                    angular_velocity: candidate.angular_velocity,
                    class: candidate.class,
                });
            }
        }
        reliable_bytes += reliable_this_tick;
        tick_bytes[tick.index as usize] += reliable_this_tick;

        telemetry.observe_tick(
            tick.index,
            interested_this_tick,
            interest_entries_this_tick,
            &|actor| decoder[actor].last_update_tick,
            &|actor| decoder[actor].class == PhysicalClass::Quiescent,
        )?;
    }
    telemetry.backfill_frame_rates(&tick_bytes);
    let final_above_budget = telemetry.final_above_budget();
    let permanent = loss_open_tick
        .iter()
        .filter(|start| start.is_some())
        .count() as u64;
    trace.finish()?;
    telemetry.finish_replay()?;

    let total_bytes = payload_bytes + header_bytes + reliable_bytes;
    let duration = tick_bytes.len() as f64 / hz as f64;
    let one_second = window_rates(&tick_bytes, hz as usize);
    let steady_start = tick_bytes.len() * 4 / 5;
    let steady_bytes: u64 = tick_bytes[steady_start..].iter().sum();
    let steady_seconds = (tick_bytes.len() - steady_start).max(1) as f64 / hz as f64;
    let sample_count = telemetry.pixel_errors.len().max(1) as f64;
    let row = VariantRow {
        variant: variant.label().to_string(),
        pixel_budget,
        loss_scenario: scenario.label(),
        total_bytes,
        payload_bytes,
        datagram_header_bytes: header_bytes,
        reliable_bytes,
        datagrams,
        average_mbps: total_bytes as f64 * 8.0 / duration.max(dt as f64) / 1_000_000.0,
        peak_one_second_mbps: one_second.iter().copied().fold(0.0, f64::max),
        p95_one_second_mbps: quantile_f64(&one_second, 0.95),
        steady_last_20pct_mbps: steady_bytes as f64 * 8.0 / steady_seconds / 1_000_000.0,
        position_cm_p50: quantile(&mut telemetry.position_errors, 0.50),
        position_cm_p95: quantile(&mut telemetry.position_errors, 0.95),
        position_cm_p99: quantile(&mut telemetry.position_errors, 0.99),
        position_cm_max: telemetry
            .position_errors
            .iter()
            .copied()
            .fold(0.0, f32::max),
        rotation_deg_p95: quantile(&mut telemetry.rotation_errors, 0.95),
        rotation_deg_p99: quantile(&mut telemetry.rotation_errors, 0.99),
        pixel_p50: quantile(&mut telemetry.pixel_errors, 0.50),
        pixel_p95: quantile(&mut telemetry.pixel_errors, 0.95),
        pixel_p99: quantile(&mut telemetry.pixel_errors, 0.99),
        pixel_max: telemetry.pixel_errors.iter().copied().fold(0.0, f32::max),
        samples_above_budget_pct: telemetry.above_count as f64 * 100.0 / sample_count,
        max_excursion_ms: telemetry.max_above_ticks as f64 * 1000.0 / hz as f64,
        stale_p99_ms: quantile(&mut telemetry.stale_samples, 0.99) as f64,
        stale_max_ms: telemetry.stale_samples.iter().copied().fold(0.0, f32::max) as f64,
        freeze_pct: telemetry.frozen_samples as f64 * 100.0
            / telemetry.moving_samples.max(1) as f64,
        freeze_events: telemetry.freeze_events,
        max_freeze_ms: telemetry.max_freeze_ticks as f64 * 1000.0 / hz as f64,
        linear_reversal_pct: telemetry.linear_reversals as f64 * 100.0
            / telemetry.moving_samples.max(1) as f64,
        angular_reversal_pct: telemetry.angular_reversals as f64 * 100.0
            / telemetry.angular_moving_samples.max(1) as f64,
        velocity_error_mps_p95: quantile(&mut telemetry.velocity_errors, 0.95),
        angular_velocity_error_radps_p95: quantile(&mut telemetry.angular_velocity_errors, 0.95),
        excess_acceleration_mps2_p95: quantile(&mut telemetry.excess_accelerations, 0.95),
        excess_angular_acceleration_radps2_p95: quantile(
            &mut telemetry.excess_angular_accelerations,
            0.95,
        ),
        update_innovation_cm_p95: quantile(&mut update_innovation_cm, 0.95),
        update_innovation_deg_p95: quantile(&mut update_innovation_deg, 0.95),
        moving_deadline_misses,
        resync_p99_ms: quantile(&mut resync_samples, 0.99) as f64,
        invalid_delta_records: invalid_delta,
        final_above_budget_bodies: final_above_budget,
        permanently_divergent_bodies: permanent,
        encoder_wall_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    Ok(PassResult {
        row,
        modes: mode,
        per_second_rates: per_second_rates(&tick_bytes, hz as usize),
        frames: telemetry.frame_telemetry,
    })
}

/// Presentation sampling, aggregate error accounting, frame telemetry, and
/// replay output shared by every live pass. The wire path owns encoding and
/// delivery; it feeds decoded `MotionSnapshot`s into `presentation` and this
/// struct turns them into the displayed-quality record.
pub(crate) struct TelemetryPass {
    actors: Vec<crate::trace::ActorDef>,
    pane_width: u32,
    pane_height: u32,
    hz: u32,
    output_fps: u32,
    cameras: [crate::trace::Camera; 4],
    chase_projectile: bool,
    /// Interest-scoped runs aggregate only chase-visible bodies and measure
    /// pixels in the chase camera; otherwise the worst of all four cameras.
    single_view_scope: bool,
    interpolation_delay_ticks: u32,
    /// Ticks before displayed playback starts (client join/buffering): the
    /// replay still writes the held join frame, but no quality metrics or
    /// frame-telemetry rows are scored.
    pub(crate) warmup_ticks: u32,
    /// Freeze/reversal events are scored only while the displayed pose is more
    /// than this far from delay-aligned truth. A wire that tracks truth inside
    /// its error tolerance is suppressing sub-threshold motion by design, not
    /// visibly stalling; a genuine stall of a moving body exceeds any small
    /// tolerance within a tick or two. Zero keeps the historical behavior.
    pub(crate) freeze_tolerance_cm: f32,
    visible_freeze_run: Vec<u32>,
    /// Write delay-aligned truth sleep flags into the replay instead of the
    /// wire-derived estimate. The flag only drives the renderer's debug tint;
    /// the archive proof pipeline uses truth flags for tint-clean A/B videos.
    pub(crate) replay_truth_sleeping: bool,
    pixel_budget: f32,
    continuity_config: ContinuityConfig,
    pub(crate) presentation: Vec<PresentationTrack>,
    continuity: Vec<ContinuityTracker>,
    truth_history: VecDeque<(u32, Vec<ActorState>)>,
    position_errors: Vec<f32>,
    rotation_errors: Vec<f32>,
    pixel_errors: Vec<f32>,
    stale_samples: Vec<f32>,
    /// Per-body consecutive frozen-while-moving output frames.
    frame_freeze_runs: Vec<u32>,
    velocity_errors: Vec<f32>,
    angular_velocity_errors: Vec<f32>,
    excess_accelerations: Vec<f32>,
    excess_angular_accelerations: Vec<f32>,
    above_run: Vec<u32>,
    above_count: u64,
    max_above_ticks: u32,
    moving_samples: u64,
    angular_moving_samples: u64,
    frozen_samples: u64,
    freeze_events: u64,
    max_freeze_ticks: u32,
    linear_reversals: u64,
    angular_reversals: u64,
    pub(crate) frame_telemetry: Vec<FrameTelemetry>,
    last_telemetry_frame: Option<u32>,
    truth_chase_camera: ChaseCameraTrack,
    presented_chase_camera: ChaseCameraTrack,
    projectile_actor: Option<usize>,
    previous_frame_truth: Vec<Pose>,
    previous_frame_presented: Vec<Pose>,
    last_truth: Vec<ActorState>,
    last_presented: Vec<PresentedState>,
    last_cameras: [crate::trace::Camera; 4],
    replay: Option<ReplayWriter>,
    last_replay_frame: Option<u32>,
}

impl TelemetryPass {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        actors: &[crate::trace::ActorDef],
        pane_width: u32,
        pane_height: u32,
        hz: u32,
        output_fps: u32,
        cameras: [crate::trace::Camera; 4],
        chase_projectile: bool,
        single_view_scope: bool,
        pixel_budget: f32,
        presentation_config: PresentationConfig,
        continuity_config: ContinuityConfig,
        replay: Option<ReplayWriter>,
    ) -> Self {
        Self {
            actors: actors.to_vec(),
            pane_width,
            pane_height,
            hz,
            output_fps,
            cameras,
            chase_projectile,
            single_view_scope,
            interpolation_delay_ticks: presentation_config.interpolation_delay_ticks,
            warmup_ticks: 0,
            freeze_tolerance_cm: 0.0,
            visible_freeze_run: vec![0_u32; actors.len()],
            replay_truth_sleeping: false,
            pixel_budget,
            continuity_config,
            presentation: actors
                .iter()
                .map(|actor| PresentationTrack::new(actor, presentation_config))
                .collect(),
            continuity: vec![ContinuityTracker::default(); actors.len()],
            truth_history: VecDeque::new(),
            position_errors: Vec::new(),
            rotation_errors: Vec::new(),
            pixel_errors: Vec::new(),
            stale_samples: Vec::new(),
            frame_freeze_runs: vec![0_u32; actors.len()],
            velocity_errors: Vec::new(),
            angular_velocity_errors: Vec::new(),
            excess_accelerations: Vec::new(),
            excess_angular_accelerations: Vec::new(),
            above_run: vec![0_u32; actors.len()],
            above_count: 0,
            max_above_ticks: 0,
            moving_samples: 0,
            angular_moving_samples: 0,
            frozen_samples: 0,
            freeze_events: 0,
            max_freeze_ticks: 0,
            linear_reversals: 0,
            angular_reversals: 0,
            frame_telemetry: Vec::new(),
            last_telemetry_frame: None,
            truth_chase_camera: ChaseCameraTrack::default(),
            presented_chase_camera: ChaseCameraTrack::default(),
            projectile_actor: actors.iter().position(|actor| actor.part == 5),
            previous_frame_truth: Vec::new(),
            previous_frame_presented: Vec::new(),
            last_truth: Vec::new(),
            last_presented: Vec::new(),
            last_cameras: cameras,
            replay,
            last_replay_frame: None,
        }
    }

    pub(crate) fn begin_tick(&mut self, tick: &Tick) {
        self.truth_history
            .push_back((tick.index, tick.states.clone()));
    }

    /// Samples presentation at this tick against delay-shifted truth and
    /// accumulates every displayed-quality aggregate and frame-telemetry row.
    /// `last_update_tick` and `replay_sleeping` expose the wire path's
    /// per-actor delivery state without coupling to its representation.
    pub(crate) fn observe_tick(
        &mut self,
        tick_index: u32,
        interested_this_tick: u32,
        interest_entries_this_tick: u32,
        last_update_tick: &dyn Fn(usize) -> u32,
        replay_sleeping: &dyn Fn(usize) -> bool,
    ) -> Result<()> {
        let target_tick = tick_index.saturating_sub(self.interpolation_delay_ticks);
        let mut truth_history = std::mem::take(&mut self.truth_history);
        while truth_history.len() > 1 && truth_history[1].0 <= target_tick {
            truth_history.pop_front();
        }
        let target_truth = &truth_history
            .front()
            .expect("current truth retained for presentation")
            .1;
        let presentation_cameras = if self.chase_projectile {
            projectile_chase_cameras(self.cameras, &self.actors, target_truth)
        } else {
            self.cameras
        };
        self.last_cameras = presentation_cameras;
        self.last_presented.clear();
        self.last_presented.reserve(self.presentation.len());
        for track in &mut self.presentation {
            self.last_presented.push(track.sample(tick_index as f32));
        }
        let output_frame = tick_index.saturating_mul(self.output_fps) / self.hz;
        let scoring = tick_index >= self.warmup_ticks;
        let emit_telemetry = scoring && self.last_telemetry_frame != Some(output_frame);
        let telemetry_cameras = if emit_telemetry {
            let truth_position = self
                .projectile_actor
                .map(|actor| target_truth[actor].pose.position);
            let presented_position = self
                .projectile_actor
                .map(|actor| self.last_presented[actor].pose.position);
            let truth_camera = self
                .truth_chase_camera
                .update(truth_position, self.cameras[3]);
            let presented_camera = self
                .presented_chase_camera
                .update(presented_position, self.cameras[3]);
            Some((truth_camera, presented_camera))
        } else {
            None
        };
        let mut frame_position_cm = Vec::new();
        let mut frame_rotation_deg = Vec::new();
        let mut frame_chase_pixels = Vec::new();
        let mut frame_correction_cm = Vec::new();
        let mut frame_correction_rotation = Vec::new();
        let mut frame_correction_speed = Vec::new();
        let mut frame_correction_angular_speed = Vec::new();
        let mut frame_excess_step_cm = Vec::new();
        let mut frame_excess_rotation_step = Vec::new();
        let mut frame_stale_ms = Vec::new();
        let mut frame_visible = 0_u32;
        let mut frame_moving = 0_u32;
        let mut frame_frozen = 0_u32;
        let mut frame_freeze_run_max = 0_u32;
        let mut frame_linear_reversals = 0_u32;
        let mut frame_angular_moving = 0_u32;
        let mut frame_angular_reversals = 0_u32;

        if scoring {
            for (actor_index, truth) in target_truth.iter().enumerate() {
                let presented = self.last_presented[actor_index];
                let position_cm = (truth.pose.position - presented.pose.position).length() * 100.0;
                let rotation_deg =
                    angular_error_degrees(truth.pose.rotation, presented.pose.rotation);
                let actor = &self.actors[actor_index];
                let pixels = if self.single_view_scope {
                    projected_error_pixels(
                        truth.pose,
                        presented.pose,
                        actor.bounding_radius,
                        presentation_cameras[3],
                        self.pane_width,
                        self.pane_height,
                    )
                } else {
                    worst_camera_error(
                        truth.pose,
                        presented.pose,
                        actor,
                        &presentation_cameras,
                        self.pane_width,
                        self.pane_height,
                    )
                };
                let aggregate_in_scope = !self.single_view_scope
                    || actor_visible(
                        presented.pose,
                        actor.bounding_radius,
                        presentation_cameras[3],
                        self.pane_width,
                        self.pane_height,
                    );
                let motion = self.continuity[actor_index].observe(
                    truth.linear_velocity,
                    truth.angular_velocity,
                    presented.linear_velocity,
                    presented.angular_velocity,
                    self.continuity_config,
                );
                let visible = position_cm > self.freeze_tolerance_cm;
                let visibly_frozen = motion.frozen && visible;
                self.visible_freeze_run[actor_index] = if visibly_frozen {
                    self.visible_freeze_run[actor_index].saturating_add(1)
                } else {
                    0
                };
                let visible_freeze_started =
                    visibly_frozen && self.visible_freeze_run[actor_index] == 1;
                let visible_linear_reversal = motion.linear_reversal && visible;
                let visible_angular_reversal = motion.angular_reversal && visible;
                if aggregate_in_scope {
                    self.position_errors.push(position_cm);
                    self.rotation_errors.push(rotation_deg);
                    self.pixel_errors.push(pixels);
                    self.stale_samples.push(
                        tick_index.saturating_sub(last_update_tick(actor_index)) as f32 * 1000.0
                            / self.hz as f32,
                    );
                    if motion.truth_moving {
                        self.moving_samples += 1;
                    }
                    if truth.angular_velocity.length()
                        >= self.continuity_config.angular_moving_speed
                    {
                        self.angular_moving_samples += 1;
                    }
                    self.frozen_samples += u64::from(visibly_frozen);
                    self.freeze_events += u64::from(visible_freeze_started);
                    self.max_freeze_ticks = self
                        .max_freeze_ticks
                        .max(self.visible_freeze_run[actor_index]);
                    self.linear_reversals += u64::from(visible_linear_reversal);
                    self.angular_reversals += u64::from(visible_angular_reversal);
                    self.velocity_errors.push(motion.velocity_error);
                    self.angular_velocity_errors
                        .push(motion.angular_velocity_error);
                    self.excess_accelerations.push(motion.excess_acceleration);
                    self.excess_angular_accelerations
                        .push(motion.excess_angular_acceleration);
                }
                if let Some((_, displayed_camera)) = telemetry_cameras {
                    if actor_visible(
                        presented.pose,
                        actor.bounding_radius,
                        displayed_camera,
                        self.pane_width,
                        self.pane_height,
                    ) {
                        frame_visible += 1;
                        frame_position_cm.push(position_cm);
                        frame_rotation_deg.push(rotation_deg);
                        frame_chase_pixels.push(projected_error_pixels(
                            truth.pose,
                            presented.pose,
                            actor.bounding_radius,
                            displayed_camera,
                            self.pane_width,
                            self.pane_height,
                        ));
                        frame_correction_cm.push(presented.position_correction.length() * 100.0);
                        frame_correction_rotation.push(presented.rotation_correction_degrees);
                        frame_correction_speed.push(presented.correction_linear_velocity.length());
                        frame_correction_angular_speed
                            .push(presented.correction_angular_velocity.length());
                        if motion.truth_moving {
                            frame_moving += 1;
                            frame_frozen += u32::from(visibly_frozen);
                            // Consecutive frozen output frames per body: the
                            // duration gate reads the longest run, in ms.
                            if visibly_frozen {
                                self.frame_freeze_runs[actor_index] =
                                    self.frame_freeze_runs[actor_index].saturating_add(1);
                                frame_freeze_run_max =
                                    frame_freeze_run_max.max(self.frame_freeze_runs[actor_index]);
                            } else {
                                self.frame_freeze_runs[actor_index] = 0;
                            }
                            frame_linear_reversals += u32::from(visible_linear_reversal);
                            frame_stale_ms.push(
                                tick_index.saturating_sub(last_update_tick(actor_index)) as f32
                                    * 1000.0
                                    / self.hz as f32,
                            );
                        }
                        if self.previous_frame_truth.len() == target_truth.len() {
                            let truth_step = truth.pose.position
                                - self.previous_frame_truth[actor_index].position;
                            let presented_step = presented.pose.position
                                - self.previous_frame_presented[actor_index].position;
                            frame_excess_step_cm
                                .push((presented_step - truth_step).length() * 100.0);
                            let truth_rotation_step = truth.pose.rotation
                                * self.previous_frame_truth[actor_index].rotation.conjugate();
                            let presented_rotation_step = presented.pose.rotation
                                * self.previous_frame_presented[actor_index]
                                    .rotation
                                    .conjugate();
                            frame_excess_rotation_step.push(angular_error_degrees(
                                truth_rotation_step,
                                presented_rotation_step,
                            ));
                        }
                        if truth.angular_velocity.length()
                            >= self.continuity_config.angular_moving_speed
                        {
                            frame_angular_moving += 1;
                            frame_angular_reversals += u32::from(visible_angular_reversal);
                        }
                    }
                }
                if pixels > self.pixel_budget {
                    self.above_count += 1;
                    self.above_run[actor_index] += 1;
                    self.max_above_ticks = self.max_above_ticks.max(self.above_run[actor_index]);
                } else {
                    self.above_run[actor_index] = 0;
                }
            }
        }
        if let Some((truth_camera, displayed_camera)) = telemetry_cameras {
            self.frame_telemetry.push(FrameTelemetry {
                frame: output_frame,
                time_seconds: output_frame as f64 / self.output_fps as f64,
                frame_mbps: 0.0,
                rolling_one_second_mbps: 0.0,
                interested_bodies: interested_this_tick,
                interest_entries: interest_entries_this_tick,
                chase_visible_bodies: frame_visible,
                chase_moving_bodies: frame_moving,
                position_cm_p50: quantile(&mut frame_position_cm, 0.50),
                position_cm_p95: quantile(&mut frame_position_cm, 0.95),
                position_cm_max: frame_position_cm.iter().copied().fold(0.0, f32::max),
                rotation_deg_p95: quantile(&mut frame_rotation_deg, 0.95),
                chase_pixel_p50: quantile(&mut frame_chase_pixels, 0.50),
                chase_pixel_p95: quantile(&mut frame_chase_pixels, 0.95),
                chase_pixel_p99: quantile(&mut frame_chase_pixels, 0.99),
                chase_pixel_max: frame_chase_pixels.iter().copied().fold(0.0, f32::max),
                correction_cm_p95: quantile(&mut frame_correction_cm, 0.95),
                correction_cm_max: frame_correction_cm.iter().copied().fold(0.0, f32::max),
                correction_rotation_deg_p95: quantile(&mut frame_correction_rotation, 0.95),
                correction_speed_mps_p95: quantile(&mut frame_correction_speed, 0.95),
                correction_angular_speed_radps_p95: quantile(
                    &mut frame_correction_angular_speed,
                    0.95,
                ),
                excess_step_cm_p95: quantile(&mut frame_excess_step_cm, 0.95),
                excess_step_cm_max: frame_excess_step_cm.iter().copied().fold(0.0, f32::max),
                excess_rotation_step_deg_p95: quantile(&mut frame_excess_rotation_step, 0.95),
                excess_rotation_step_deg_max: frame_excess_rotation_step
                    .iter()
                    .copied()
                    .fold(0.0, f32::max),
                freeze_pct: frame_frozen as f64 * 100.0 / frame_moving.max(1) as f64,
                linear_reversal_pct: frame_linear_reversals as f64 * 100.0
                    / frame_moving.max(1) as f64,
                angular_reversal_pct: frame_angular_reversals as f64 * 100.0
                    / frame_angular_moving.max(1) as f64,
                freeze_run_ms: frame_freeze_run_max as f32 * 1000.0 / self.output_fps as f32,
                stale_ms_p95: quantile(&mut frame_stale_ms, 0.95),
                stale_ms_max: frame_stale_ms.iter().copied().fold(0.0, f32::max),
                chase_camera_position_error_m: truth_camera.eye.distance(displayed_camera.eye),
                chase_camera_direction_error_deg: truth_camera
                    .direction
                    .angle_between(displayed_camera.direction)
                    .to_degrees(),
            });
            self.last_telemetry_frame = Some(output_frame);
            self.previous_frame_truth.clear();
            self.previous_frame_truth
                .extend(target_truth.iter().map(|state| state.pose));
            self.previous_frame_presented.clear();
            self.previous_frame_presented
                .extend(self.last_presented.iter().map(|state| state.pose));
        }
        if let Some(writer) = self.replay.as_mut() {
            if self.last_replay_frame != Some(output_frame) {
                let poses: Vec<_> = self.last_presented.iter().map(|state| state.pose).collect();
                let sleeping: Vec<_> = if self.replay_truth_sleeping {
                    target_truth.iter().map(|state| state.sleeping()).collect()
                } else {
                    (0..self.actors.len()).map(replay_sleeping).collect()
                };
                writer.write_frame(&poses, &sleeping)?;
                self.last_replay_frame = Some(output_frame);
            }
        }
        self.last_truth.clone_from(target_truth);
        self.truth_history = truth_history;
        Ok(())
    }

    /// Backfills per-frame and rolling one-second Mbps from the byte ledger.
    pub(crate) fn backfill_frame_rates(&mut self, tick_bytes: &[u64]) {
        for frame in &mut self.frame_telemetry {
            let start_tick =
                (frame.frame as u64 * self.hz as u64 / self.output_fps as u64) as usize;
            let end_tick = (((frame.frame + 1) as u64 * self.hz as u64)
                .div_ceil(self.output_fps as u64) as usize)
                .min(tick_bytes.len());
            let frame_seconds =
                (end_tick.saturating_sub(start_tick)).max(1) as f64 / self.hz as f64;
            let frame_bytes: u64 = tick_bytes[start_tick.min(tick_bytes.len())..end_tick]
                .iter()
                .sum();
            frame.frame_mbps = frame_bytes as f64 * 8.0 / frame_seconds / 1_000_000.0;
            let window_start = end_tick.saturating_sub(self.hz as usize);
            let window_seconds = (end_tick - window_start).max(1) as f64 / self.hz as f64;
            let window_bytes: u64 = tick_bytes[window_start..end_tick].iter().sum();
            frame.rolling_one_second_mbps =
                window_bytes as f64 * 8.0 / window_seconds / 1_000_000.0;
        }
    }

    fn final_above_budget(&self) -> u64 {
        self.last_truth
            .iter()
            .enumerate()
            .filter(|(actor, truth)| {
                let definition = &self.actors[*actor];
                if self.single_view_scope {
                    actor_visible(
                        self.last_presented[*actor].pose,
                        definition.bounding_radius,
                        self.last_cameras[3],
                        self.pane_width,
                        self.pane_height,
                    ) && projected_error_pixels(
                        truth.pose,
                        self.last_presented[*actor].pose,
                        definition.bounding_radius,
                        self.last_cameras[3],
                        self.pane_width,
                        self.pane_height,
                    ) > self.pixel_budget
                } else {
                    worst_camera_error(
                        truth.pose,
                        self.last_presented[*actor].pose,
                        definition,
                        &self.last_cameras,
                        self.pane_width,
                        self.pane_height,
                    ) > self.pixel_budget
                }
            })
            .count() as u64
    }

    pub(crate) fn finish_replay(&mut self) -> Result<()> {
        if let Some(writer) = self.replay.take() {
            writer.finish()?;
        }
        Ok(())
    }
}

fn projectile_chase_cameras(
    mut cameras: [crate::trace::Camera; 4],
    actors: &[crate::trace::ActorDef],
    states: &[ActorState],
) -> [crate::trace::Camera; 4] {
    let chase = actors
        .iter()
        .zip(states)
        .find(|(actor, state)| {
            actor.part == 5
                && state.pose.position.y > -200.0
                && state.pose.position.abs().max_element() < 500.0
                && state.linear_velocity.length_squared() > 0.25
        })
        .map(|(_, state)| {
            let forward = state.linear_velocity.normalize();
            let eye = state.pose.position - forward * 12.0 + Vec3::Y * 4.0;
            let target = state.pose.position + forward * 5.0;
            crate::trace::Camera {
                eye,
                direction: (target - eye).normalize(),
                fov_degrees: 70.0,
            }
        });
    if let Some(chase) = chase {
        cameras[3] = chase;
    }
    cameras
}

fn actor_visible(
    pose: Pose,
    radius: f32,
    camera: crate::trace::Camera,
    pane_width: u32,
    pane_height: u32,
) -> bool {
    let direction = camera.direction.normalize();
    let reference_up = if direction.dot(Vec3::Y).abs() > 0.99 {
        Vec3::X
    } else {
        Vec3::Y
    };
    let right = direction.cross(reference_up).normalize();
    let up = right.cross(direction).normalize();
    let relative = pose.position - camera.eye;
    let depth = relative.dot(direction);
    if depth + radius <= 0.1 {
        return false;
    }
    let half_vertical = (camera.fov_degrees.to_radians() * 0.5).tan();
    let aspect = pane_width as f32 / pane_height.max(1) as f32;
    let angular_radius = radius / depth.max(0.1);
    let x = relative.dot(right) / depth.max(0.1);
    let y = relative.dot(up) / depth.max(0.1);
    x.abs() <= half_vertical * aspect + angular_radius && y.abs() <= half_vertical + angular_radius
}

fn advance_endpoint(
    endpoint: &mut Endpoint,
    actor: &crate::trace::ActorDef,
    gravity: Vec3,
    dt: f32,
) {
    match endpoint.class {
        PhysicalClass::Quiescent => {}
        PhysicalClass::Ballistic => {
            let (pose, lv, av) = predict_ballistic(
                endpoint.pose,
                endpoint.linear_velocity,
                endpoint.angular_velocity,
                PredictorParams {
                    gravity,
                    linear_damping: actor.linear_damping,
                    angular_damping: actor.angular_damping,
                    dt,
                    steps: 1,
                },
            );
            endpoint.pose = pose;
            endpoint.linear_velocity = lv;
            endpoint.angular_velocity = av;
        }
        PhysicalClass::ContactActive | PhysicalClass::ImpactBurst => {
            endpoint.linear_velocity *= 1.0 / (1.0 + actor.linear_damping * dt);
            endpoint.angular_velocity *= 1.0 / (1.0 + actor.angular_damping * dt);
            endpoint.pose.position += endpoint.linear_velocity * dt;
            let angle = endpoint.angular_velocity.length() * dt;
            if angle > 1e-8 {
                endpoint.pose.rotation =
                    (glam::Quat::from_axis_angle(endpoint.angular_velocity.normalize(), angle)
                        * endpoint.pose.rotation)
                        .normalize();
            }
        }
    }
}

fn delta_fits(position: Vec3, baseline_position: Vec3) -> bool {
    let cm = (position - baseline_position) * 100.0;
    cm.min_element() >= i16::MIN as f32 && cm.max_element() <= i16::MAX as f32
}

fn scenario_seed(scenario: Scenario) -> u64 {
    match scenario {
        Scenario::Clean => 0,
        Scenario::Random(rate) => rate.to_bits(),
        Scenario::Burst => 0xb075_7001,
    }
}

pub(crate) fn window_rates(bytes: &[u64], window: usize) -> Vec<f64> {
    if bytes.is_empty() {
        return vec![0.0];
    }
    let window = window.min(bytes.len()).max(1);
    let mut sum: u64 = bytes[..window].iter().sum();
    let mut rates = vec![sum as f64 * 8.0 / 1_000_000.0];
    for index in window..bytes.len() {
        sum = sum + bytes[index] - bytes[index - window];
        rates.push(sum as f64 * 8.0 / 1_000_000.0);
    }
    rates
}

fn per_second_rates(bytes: &[u64], hz: usize) -> Vec<f64> {
    bytes
        .chunks(hz.max(1))
        .map(|chunk| {
            let seconds = chunk.len() as f64 / hz.max(1) as f64;
            chunk.iter().sum::<u64>() as f64 * 8.0 / seconds.max(f64::EPSILON) / 1_000_000.0
        })
        .collect()
}

fn write_timeline_svg(path: &Path, rows: &[TimelineRow]) -> Result<()> {
    ensure!(!rows.is_empty(), "cannot plot an empty timeline");
    let width = 1100.0;
    let height = 480.0;
    let left = 76.0;
    let right = 28.0;
    let top = 54.0;
    let bottom = 64.0;
    let plot_width = width - left - right;
    let plot_height = height - top - bottom;
    let max_value = rows
        .iter()
        .flat_map(|row| [row.raw_mbps, row.reduced_mbps])
        .fold(3.0_f64, f64::max)
        .ceil();
    let x = |index: usize| {
        left + index as f64 * plot_width / rows.len().saturating_sub(1).max(1) as f64
    };
    let y = |value: f64| top + plot_height * (1.0 - value / max_value);
    let points = |select: fn(&TimelineRow) -> f64| {
        rows.iter()
            .enumerate()
            .map(|(index, row)| format!("{:.2},{:.2}", x(index), y(select(row))))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut grid = String::new();
    for step in 0..=5 {
        let value = max_value * step as f64 / 5.0;
        let py = y(value);
        grid.push_str(&format!(
            "<line x1=\"{left}\" y1=\"{py:.2}\" x2=\"{:.2}\" y2=\"{py:.2}\" stroke=\"#d7dce2\" stroke-width=\"1\"/><text x=\"{:.2}\" y=\"{:.2}\" text-anchor=\"end\" font-size=\"12\" fill=\"#4b5563\">{value:.0}</text>",
            width - right,
            left - 10.0,
            py + 4.0
        ));
    }
    let target_y = y(3.0);
    let svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">\
<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\
<text x=\"{left}\" y=\"28\" font-family=\"sans-serif\" font-size=\"20\" font-weight=\"600\" fill=\"#111827\">Authoritative rigid-body stream bandwidth</text>\
<text x=\"{left}\" y=\"46\" font-family=\"sans-serif\" font-size=\"12\" fill=\"#6b7280\">One-second buckets · 6,119 bodies · 120 Hz PhysX · 30 Hz raw reference · 2 px reduced-codec budget</text>\
<g font-family=\"sans-serif\">{grid}\
<line x1=\"{left}\" y1=\"{target_y:.2}\" x2=\"{:.2}\" y2=\"{target_y:.2}\" stroke=\"#6b7280\" stroke-width=\"2\" stroke-dasharray=\"7 6\"/>\
<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"12\" fill=\"#4b5563\">3 Mbps target</text>\
<polyline points=\"{}\" fill=\"none\" stroke=\"#c2413a\" stroke-width=\"3\"/>\
<polyline points=\"{}\" fill=\"none\" stroke=\"#2563b8\" stroke-width=\"3\"/>\
<line x1=\"{left}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#111827\"/>\
<line x1=\"{left}\" y1=\"{top}\" x2=\"{left}\" y2=\"{:.2}\" stroke=\"#111827\"/>\
<text x=\"{:.2}\" y=\"{:.2}\" text-anchor=\"middle\" font-size=\"13\" fill=\"#111827\">Simulation time (seconds)</text>\
<text x=\"18\" y=\"{:.2}\" transform=\"rotate(-90 18 {:.2})\" text-anchor=\"middle\" font-size=\"13\" fill=\"#111827\">Application bitrate (Mbps)</text>\
<text x=\"{left}\" y=\"{:.2}\" font-size=\"12\" fill=\"#4b5563\">0</text>\
<text x=\"{:.2}\" y=\"{:.2}\" text-anchor=\"end\" font-size=\"12\" fill=\"#4b5563\">{} s</text>\
<line x1=\"{:.2}\" y1=\"22\" x2=\"{:.2}\" y2=\"22\" stroke=\"#c2413a\" stroke-width=\"3\"/><text x=\"{:.2}\" y=\"26\" font-size=\"12\" fill=\"#111827\">Raw state</text>\
<line x1=\"{:.2}\" y1=\"22\" x2=\"{:.2}\" y2=\"22\" stroke=\"#2563b8\" stroke-width=\"3\"/><text x=\"{:.2}\" y=\"26\" font-size=\"12\" fill=\"#111827\">Reduced codec</text>\
</g></svg>",
        width - right,
        width - right - 108.0,
        target_y - 6.0,
        points(|row| row.raw_mbps),
        points(|row| row.reduced_mbps),
        top + plot_height,
        width - right,
        top + plot_height,
        top + plot_height,
        left + plot_width / 2.0,
        height - 18.0,
        top + plot_height / 2.0,
        top + plot_height / 2.0,
        top + plot_height + 20.0,
        width - right,
        top + plot_height + 20.0,
        rows.len(),
        width - 298.0,
        width - 270.0,
        width - 262.0,
        width - 176.0,
        width - 148.0,
        width - 140.0
    );
    fs::write(path, svg).with_context(|| format!("write timeline SVG {}", path.display()))
}

fn quantile(values: &mut [f32], q: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f32::total_cmp);
    values[((values.len() - 1) as f32 * q).round() as usize]
}

pub(crate) fn quantile_f64(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

pub(crate) fn write_csv<T: Serialize>(path: PathBuf, rows: &[T]) -> Result<()> {
    let mut writer =
        csv::Writer::from_path(&path).with_context(|| format!("create CSV {}", path.display()))?;
    for row in rows {
        writer.serialize(row)?;
    }
    writer.flush()?;
    Ok(())
}

fn write_output_readme(out_dir: &Path, trace_path: &Path, config: &AnalysisConfig) -> Result<()> {
    let text = format!(
        "# Destruction codec evaluation\n\n\
         Source trace: `{}`\n\n\
         Primary reconstruction: full mode + priority, {:.2} px, {} fps.\n\
         Presentation: {} ms interpolation delay, {} ms extrapolation limit, \
         {} ms correction horizon.\n\n\
         - `summary.json`: machine-readable pass/fail criteria and primary/loss metrics.\n\
         - `per_variant.csv`: all ablations, rate points, and loss scenarios.\n\
         - `per_mode.csv`: primary clean-run physical-class accounting.\n\
         - `rate_distortion.csv`: clean rate-distortion sweep.\n\
         - `distance_sweep.csv`: full-codec bandwidth at configured camera-distance scales.\n\
         - `reconstructed.towerstate`: render-compatible decoded replay.\n\n\
         Render with:\n\n\
         ```sh\n\
         cd /root/workspace/physx-tower/tower-demo\n\
         cargo run --release -- render --state {}/reconstructed.towerstate \
         --output replay.mp4 --chase-projectile\n\
         ```\n\n\
         Bytes are an explicit wire model (record payloads, 16-byte datagram headers, and \
         12-byte reliable message headers), not captured QUIC traffic. See `summary.json` \
         limitations before drawing transport-cost conclusions.\n",
        trace_path.display(),
        config.primary_pixel_budget,
        config.output_fps,
        config.interpolation_delay_ms,
        config.max_extrapolation_ms,
        config.correction_ms,
        out_dir.display(),
    );
    fs::write(out_dir.join("README.md"), text)?;
    Ok(())
}

#[cfg(test)]
mod acceptance_tests {
    use super::*;

    #[test]
    fn pristine_frames_pass_visual_acceptance() {
        let assessment = assess_visual_acceptance(&vec![FrameTelemetry::default(); 120]);
        assert!(assessment.pass);
    }

    #[test]
    fn a_sustained_freeze_rejects_configuration() {
        // A body frozen while moving for longer than the temporal-integration
        // window is the artifact observers reliably detect.
        let mut frames = vec![FrameTelemetry::default(); 120];
        frames[60].freeze_run_ms = 133.0;
        let assessment = assess_visual_acceptance(&frames);
        assert!(!assessment.pass);
        assert!(assessment.frame_freeze_run_ms_max > 100.0);
    }

    #[test]
    fn a_scene_wide_one_frame_hitch_rejects_configuration() {
        let mut frames = vec![FrameTelemetry::default(); 120];
        frames[60].freeze_pct = 40.0;
        frames[60].chase_moving_bodies = 4_000;
        let assessment = assess_visual_acceptance(&frames);
        assert!(!assessment.pass);
    }

    #[test]
    fn a_single_body_frame_freeze_is_below_the_gate() {
        // 33 ms on one body of thousands is below what rendered-output
        // comparison resolves (Phase C measured zero localized stall at
        // configurations the old zero-tolerance threshold rejected).
        let mut frames = vec![FrameTelemetry::default(); 120];
        frames[60].freeze_pct = 0.03;
        frames[60].freeze_run_ms = 33.4;
        frames[60].chase_moving_bodies = 4_000;
        let assessment = assess_visual_acceptance(&frames);
        assert!(assessment.pass);
    }

    #[test]
    fn rare_large_correction_rejects_configuration() {
        let mut frames = vec![FrameTelemetry::default(); 120];
        frames[60].correction_cm_p95 = 100.0;
        let assessment = assess_visual_acceptance(&frames);
        assert!(!assessment.pass);
        assert!(assessment.frame_correction_p95_cm_max > 25.0);
    }
}
