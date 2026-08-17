use std::path::PathBuf;

use anyhow::{bail, ensure, Result};
use clap::{Args, Parser, Subcommand};
use destruction_codec::{
    ack_baseline, archive, budget, census, debris_codec, debris_tracks, evaluate, exact_island,
    mask, root_coder, synthetic,
};
use evaluate::AnalysisConfig;

#[derive(Parser)]
#[command(
    name = "destruction-codec",
    version,
    about = "Offline TWTRACE1 rigid-body rate-distortion evaluator",
    long_about = "Validates TWTRACE1, runs six codec ablations, simulates deterministic loss, \
                  measures physical and four-camera perceptual error, and writes a TWSTATE1 replay."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Analyze a TWTRACE1 file and emit JSON, CSV, and reconstructed replay.
    Analyze(AnalyzeArgs),
    /// Convert authoritative TWTRACE1 poses to a renderable TWSTATE1 replay.
    Replay(ReplayArgs),
    /// Write a deterministic TWTRACE1 fixture with all classifier regimes.
    Synthetic(SyntheticArgs),
    /// Encode and evaluate a camera-independent, track-partitioned world archive.
    Archive(ArchiveArgs),
    /// Offline Fiedler-style acked-baseline ablation with TWSTATE1 replay.
    AckBaseline(AckBaselineArgs),
    /// Rewrite unbroken D6 islands into exact rigid compounds for hierarchy upside.
    ExactIslandProxy(ExactIslandProxyArgs),
    /// Qualify the v2 root coder against dumped real GOP blocks (R4 fixture gate).
    #[command(hide = true)]
    RootCoderBench(RootCoderBenchArgs),
    /// Per-body segment/impulse/sample-run codec measured over a hindsight window.
    DebrisCodec(DebrisCodecArgs),
    /// Track-split x subscription strategy matrix with simulated moving viewers.
    DebrisTracks(DebrisTracksArgs),
}

#[derive(Args)]
struct DebrisTracksArgs {
    /// Input TWTRACE1 path.
    #[arg(long)]
    trace: PathBuf,
    /// Output directory for tracks_report.json.
    #[arg(long)]
    out_dir: PathBuf,
    /// Edge length of a detail cell, in metres.
    #[arg(long, default_value_t = 90.0)]
    cell_size_m: f32,
    /// Per-track recovery point interval; a subscriber joins at the next one.
    #[arg(long, default_value_t = 1000.0)]
    keyframe_ms: f32,
    /// Encoder flush span in milliseconds.
    #[arg(long, default_value_t = 250.0)]
    flush_ms: f32,
    /// Compression block size in milliseconds.
    #[arg(long, default_value_t = 250.0)]
    block_ms: f32,
    /// Per-viewer received budget used by the budget-capped strategies.
    #[arg(long, default_value_t = 3.0)]
    budget_mbps: f64,
    /// Loosest bound masking may reach, in millimetres.
    #[arg(long, default_value_t = 20.0)]
    mask_cap_mm: f32,
    /// Stop after this many ticks (0 = whole trace).
    #[arg(long, default_value_t = 0)]
    max_ticks: u32,
    /// Longest sampled stride the coarse tier may use (temporal LOD depth).
    #[arg(long, default_value_t = 30)]
    coarse_max_stride: u8,
    /// Smallest body the world-wide coarse tier carries (0 = everything).
    #[arg(long, default_value_t = 1.1)]
    coarse_min_radius_m: f32,
    /// Shell bound for the world-wide coarse tier, in centimetres.
    #[arg(long, default_value_t = 20.0)]
    coarse_shell_cm: f32,
    /// Encode window for the world-wide far tier, in milliseconds. Longer
    /// spans amortize the per-run header, which is the far-field cost floor.
    #[arg(long, default_value_t = 2000.0)]
    far_flush_ms: f32,
    /// Coarsest delta grid for the far tier, as 1 mm << exp. A 20 cm bound has
    /// no use for a millimetre grid.
    #[arg(long, default_value_t = 7)]
    coarse_step_exp: u8,
    /// Displayed frame rate for viewer recordings.
    #[arg(long, default_value_t = 30)]
    output_fps: u32,
    /// Record what this viewer kind receives, as a renderable state file.
    #[arg(long)]
    render_viewer: Option<String>,
    /// Put the viewer's own camera in all four panes at native 1080p, for
    /// cropping to a full-resolution solo video.
    #[arg(long)]
    render_solo: bool,
    /// Distances of the three fixed vantage panes from world centre, metres.
    #[arg(long, value_delimiter = ',', default_value = "50,100,190")]
    rig_distances_m: Vec<f32>,
    /// Publishing strategies to evaluate.
    #[arg(long, value_delimiter = ',', default_value = "PS1,PS2")]
    splits: Vec<String>,
    /// Subscription strategies to evaluate.
    #[arg(long, value_delimiter = ',', default_value = "SS1,SS2")]
    subscribes: Vec<String>,
}

#[derive(Args)]
struct DebrisCodecArgs {
    /// Input TWTRACE1 path.
    #[arg(long)]
    trace: PathBuf,
    /// Output directory for debris_report.json and CSVs.
    #[arg(long)]
    out_dir: PathBuf,
    /// Shell error tolerance in centimetres (the fidelity bound the fitter holds).
    #[arg(long, default_value_t = 2.0)]
    shell_cm: f32,
    /// Rotation tolerance in degrees.
    #[arg(long, default_value_t = 3.0)]
    rotation_deg: f32,
    /// Velocity change treated as a contact discontinuity (m/s).
    #[arg(long, default_value_t = 0.15)]
    velocity_mps: f32,
    /// Angular velocity change treated as a discontinuity (rad/s).
    #[arg(long, default_value_t = 0.5)]
    angular_rps: f32,
    /// Encoder flush span in milliseconds; this is the required encode lead.
    #[arg(long, default_value_t = 50.0)]
    flush_ms: f32,
    /// Compression block size in milliseconds.
    #[arg(long, default_value_t = 250.0)]
    block_ms: f32,
    /// Stop after this many ticks (0 = whole trace).
    #[arg(long, default_value_t = 0)]
    max_ticks: u32,
    /// Modelled debris sleep: linear speed under which a body counts as quiet.
    #[arg(long, default_value_t = 0.15)]
    sleep_linear_mps: f32,
    /// Modelled debris sleep: angular speed under which a body counts as quiet.
    #[arg(long, default_value_t = 0.15)]
    sleep_angular_rps: f32,
    /// Consecutive quiet ticks before a body is declared at rest (0 = off).
    #[arg(long, default_value_t = 0)]
    sleep_ticks: u32,
    /// Loosen the shell bound for moving bodies, as the live path does.
    #[arg(long)]
    mask_precision: bool,
    /// Loosest bound masking may reach, in millimetres.
    #[arg(long, default_value_t = 20.0)]
    mask_cap_mm: f32,
    /// Displayed frame rate used by the acceptance gates.
    #[arg(long, default_value_t = 30)]
    output_fps: u32,
    /// Receiver interpolation delay, on top of the encode window.
    #[arg(long, default_value_t = 100)]
    interpolation_delay_ms: u32,
    /// Maximum dead-reckoning horizon when the buffer under-runs.
    #[arg(long, default_value_t = 125)]
    max_extrapolation_ms: u32,
    /// Time for a revised trajectory to reconcile without a pose snap.
    #[arg(long, default_value_t = 100)]
    correction_ms: u32,
    /// Displayed steps larger than this are lifecycle snaps, not smoothing.
    #[arg(long, default_value_t = 5.0)]
    snap_distance_m: f32,
    /// Worst-camera pixel budget used by the acceptance gates.
    #[arg(long, default_value_t = 2.0)]
    pixel_budget: f32,
    /// Coarsest sampled-delta grid to consider, as 1 mm << exp (0 = 1 mm only).
    #[arg(long, default_value_t = 2)]
    sample_step_max_exp: u8,
    /// Allow second-order framing of sampled deltas where it encodes smaller.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    sample_second_order: bool,
    /// Finalize spans across bodies in parallel (byte-identical to serial).
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    encode_parallel: bool,
    /// Per-block ceiling in megabits/s; over-budget blocks lose precision, never coverage.
    #[arg(long)]
    budget_mbps: Option<f64>,
    /// Bodies with a smaller bounding radius are never synced (class C).
    #[arg(long, default_value_t = 0.0)]
    sync_min_radius_m: f32,
}

#[derive(Args)]
struct RootCoderBenchArgs {
    /// Directory of root_block_<tick>_<count>.bin fixtures.
    #[arg(long)]
    dir: PathBuf,
}

#[derive(Args)]
struct AnalyzeArgs {
    /// Input TWTRACE1 path.
    #[arg(long)]
    trace: PathBuf,
    /// Output directory for reports and reconstructed.towerstate.
    #[arg(long)]
    out_dir: PathBuf,
    /// Comma-separated worst-camera pixel thresholds to sweep.
    #[arg(long, value_delimiter = ',', default_value = "1,2,4")]
    pixel_budgets: Vec<f32>,
    /// Pixel threshold used for reconstructed replay and pass/fail criteria.
    #[arg(long, default_value_t = 2.0)]
    primary_pixel_budget: f32,
    /// Additional random datagram loss percentages. Required 0%, 1%, and 5%
    /// cases are always included.
    #[arg(long, value_delimiter = ',', default_value = "0,1,5")]
    loss_rates: Vec<f64>,
    /// Deterministic loss PRNG seed.
    #[arg(long, default_value_t = 0x544f_5745_52_u64)]
    seed: u64,
    /// Optional full-codec sender cap in megabits/s; periodic baselines and
    /// reliable transitions may exceed it to preserve bounded recovery.
    #[arg(long)]
    bitrate_budget_mbps: Option<f64>,
    /// Enforce the bitrate budget over every trailing one-second window,
    /// including scheduled reliable baselines.
    #[arg(long, requires = "bitrate_budget_mbps")]
    strict_total_budget: bool,
    /// Fixed-rate ablation snapshot frequency.
    #[arg(long, default_value_t = 60)]
    snapshot_fps: u32,
    /// TWSTATE1 reconstructed replay frequency.
    #[arg(long, default_value_t = 30)]
    output_fps: u32,
    /// Camera-distance multipliers used for the perceptual bandwidth sweep.
    #[arg(long, value_delimiter = ',', default_value = "0.5,1,2,4")]
    distance_scales: Vec<f32>,
    /// Replace the fourth evaluation camera with a close projectile chase view.
    #[arg(long)]
    chase_projectile: bool,
    /// Periodic global absolute-baseline interval.
    #[arg(long, default_value_t = 1000)]
    baseline_interval_ms: u32,
    /// Stable low-speed ticks required to enter app-level quiescence.
    #[arg(long, default_value_t = 20)]
    quiescent_ticks: u16,
    /// Snapshot interpolation delay used by the presentation decoder.
    #[arg(long, default_value_t = 100)]
    interpolation_delay_ms: u32,
    /// Maximum dead-reckoning horizon when the snapshot buffer under-runs.
    #[arg(long, default_value_t = 125)]
    max_extrapolation_ms: u32,
    /// Time for a revised trajectory to reconcile without a pose snap.
    #[arg(long, default_value_t = 100)]
    correction_ms: u32,
    /// Run only raw and primary clean passes for synchronized video telemetry.
    #[arg(long)]
    telemetry_only: bool,
    /// Skip the invariant raw pass during telemetry configuration sweeps.
    #[arg(long, requires = "telemetry_only")]
    primary_only: bool,
    /// Maximum update age for a moving body before deadline priority applies.
    #[arg(long, default_value_t = 500)]
    max_moving_update_ms: u32,
    /// Target update interval for moving contact-rich bodies.
    #[arg(long, default_value_t = 83)]
    contact_update_ms: u32,
    /// Presentation revisions larger than this are lifecycle snaps, not smoothing.
    #[arg(long, default_value_t = 5.0)]
    snap_distance_m: f32,
    /// Random datagram loss used by the telemetry pass.
    #[arg(long, default_value_t = 0.0)]
    telemetry_loss_rate: f32,
    /// Replicate only the chase/player view plus predictive safety interest.
    #[arg(long)]
    single_view_interest: bool,
    /// Make scheduling camera-independent and gate it by rigid-shell error.
    #[arg(long, conflicts_with = "single_view_interest")]
    omniscient: bool,
    /// Maximum center-plus-rotational shell error used by omniscient scheduling.
    #[arg(long, default_value_t = 2.0)]
    world_shell_budget_cm: f32,
    /// Extra vertical/horizontal frustum margin on each side.
    #[arg(long, default_value_t = 12.0)]
    interest_fov_margin_deg: f32,
    /// Prefetch bodies whose linear trajectory enters the view this soon.
    #[arg(long, default_value_t = 250)]
    interest_lookahead_ms: u32,
    /// Continue replication this long after a body leaves interest.
    #[arg(long, default_value_t = 500)]
    interest_grace_ms: u32,
    /// Always replicate bodies within this distance of the camera.
    #[arg(long, default_value_t = 25.0)]
    interest_proximity_m: f32,
    /// Stream the compact hierarchy codec from the live omniscient sender.
    #[arg(
        long,
        requires = "omniscient",
        requires = "telemetry_only",
        conflicts_with = "single_view_interest"
    )]
    live_hierarchy: bool,
    /// Entropy-code root-segment blocks with adaptive rANS when smaller.
    #[arg(long)]
    root_rans: bool,
    /// Carry zstd context across delta blocks. Keyframes stay standalone, so
    /// recovery points are unaffected and no new dependency is introduced.
    #[arg(long)]
    block_context: bool,
    /// Loosen each body's shell bound while it is moving fast, where motion
    /// masks positional error. Artifact gates stay hard.
    #[arg(long)]
    mask_precision: bool,
    /// Loosest shell bound a masked body may reach, in millimetres.
    /// 4x the base bound is the measured perceptual ceiling; past it pixel and
    /// excess-step error cross their thresholds.
    #[arg(long, default_value_t = 20.0)]
    mask_cap_mm: f32,
    /// Per-block wire budget in megabits/s for discretionary repairs. Repairs
    /// past the hard cap, past the deadline, or on settling bodies are always
    /// sent; the rest compete by accumulated surprise.
    #[arg(long)]
    budget_mbps: Option<f64>,
    /// Hard shell-error cap for deferred repairs, as a multiple of the bound.
    #[arg(long, default_value_t = 4.0)]
    budget_hard_cap_factor: f32,
    /// A body wanting a repair is never starved longer than this many ticks.
    #[arg(long, default_value_t = 30)]
    budget_max_deferral_ticks: u32,

    /// Motion at or below which no masking applies, in metres/second.
    #[arg(long, default_value_t = 0.5)]
    mask_motion_low: f32,
    /// Motion at or above which the full cap applies, in metres/second.
    #[arg(long, default_value_t = 5.0)]
    mask_motion_high: f32,
    /// Cap trajectory spans to this many ticks, independent of block length.
    #[arg(long, default_value_t = 0)]
    max_span_ticks: usize,
    /// Live hierarchy send-unit length (sender-side buffering per block).
    #[arg(long, default_value_t = 1000)]
    hier_gop_ms: u32,
    /// Interval between full keyframe blocks (island map + child locals).
    #[arg(long, default_value_t = 10_000)]
    hier_anchor_interval_ms: u32,
    /// Spread each block's bytes over the following block's ticks in the
    /// sliding-window ledger, modeling a paced stream instead of a burst.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    hier_paced: bool,
}

#[derive(Args)]
struct SyntheticArgs {
    /// Destination .towertrace path.
    #[arg(long)]
    output: PathBuf,
    /// Fixture physics tick rate.
    #[arg(long, default_value_t = 60)]
    physics_hz: u32,
    /// Fixture duration (minimum 3 seconds).
    #[arg(long, default_value_t = 6.0)]
    seconds: f32,
    /// Replace an existing output file.
    #[arg(long)]
    force: bool,
    /// Emit TWTRACE1 v3 with exact rigid islands and shared global IDs.
    #[arg(long)]
    exact_islands: bool,
    /// Actor count (defaults to 4, or 48 with --exact-islands).
    #[arg(long)]
    actors: Option<u32>,
    /// Actors per exact island (star-bonded to the island root).
    #[arg(long, default_value_t = 8)]
    island_size: u32,
}

#[derive(Args)]
struct ReplayArgs {
    #[arg(long)]
    trace: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value_t = 30)]
    output_fps: u32,
}

#[derive(Args)]
struct AckBaselineArgs {
    /// Input TWTRACE1 path.
    #[arg(long)]
    trace: PathBuf,
    /// Output directory for report + reconstructed.towerstate.
    #[arg(long)]
    out_dir: PathBuf,
    /// Random datagram loss probability in [0, 1).
    #[arg(long, default_value_t = 0.01)]
    loss_rate: f64,
    /// Ticks between Absolute delivery and baseline ack (0 = immediate).
    #[arg(long, default_value_t = 0)]
    ack_delay_ticks: u32,
    /// Forced Absolute refresh interval for non-quiescent actors.
    #[arg(long, default_value_t = 1000)]
    baseline_interval_ms: u32,
    /// Optional adaptive sender Mbps ceiling (never a fill target).
    #[arg(long)]
    bitrate_budget_mbps: Option<f64>,
    /// Schedule by chase-view interest instead of omniscient shell error.
    #[arg(long, conflicts_with = "omniscient")]
    single_view_interest: bool,
    /// Camera-independent rigid-shell scheduling (default when interest is off).
    #[arg(long, default_value_t = false)]
    omniscient: bool,
    /// Shell error budget (cm) for omniscient adaptive scheduling.
    #[arg(long, default_value_t = 2.0)]
    world_shell_budget_cm: f32,
    /// Maximum update age for a moving body before deadline priority applies.
    #[arg(long, default_value_t = 500)]
    max_moving_update_ms: u32,
    /// Target update interval for moving contact-rich bodies.
    #[arg(long, default_value_t = 83)]
    contact_update_ms: u32,
    /// TWSTATE1 fps for the acked-baseline reconstruction.
    #[arg(long, default_value_t = 30)]
    output_fps: u32,
    /// Deterministic loss PRNG seed.
    #[arg(long, default_value_t = 0x4143_4b42_u64)]
    seed: u64,
}

#[derive(Args)]
struct ExactIslandProxyArgs {
    /// Input TWTRACE1 v3 path with durable topology.
    #[arg(long)]
    trace: PathBuf,
    /// Output exact-island proxy TWTRACE1 path.
    #[arg(long)]
    output: PathBuf,
    /// Optional JSON report path (defaults to <output>.report.json).
    #[arg(long)]
    report: Option<PathBuf>,
    /// Replace an existing output file.
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct ArchiveArgs {
    /// Input TWTRACE1 path.
    #[arg(long)]
    trace: PathBuf,
    /// Output directory for archive, metrics, and spectator reports.
    #[arg(long)]
    out_dir: PathBuf,
    /// Maximum center-plus-rotation rigid-shell error in millimeters.
    #[arg(long, default_value_t = 20.0)]
    shell_error_mm: f32,
    /// Independently decodable group-of-pictures duration.
    #[arg(long, default_value_t = 1000)]
    gop_ms: u32,
    /// Maximum lookahead/trajectory-segment duration.
    #[arg(long, default_value_t = 250)]
    max_segment_ms: u32,
    /// Detailed spatial-track cell size.
    #[arg(long, default_value_t = 128.0)]
    cell_size_m: f32,
    /// Coarse spatial-track supercell size.
    #[arg(long, default_value_t = 512.0)]
    supercell_size_m: f32,
    /// Desired maximum active tracks for a normal spectator.
    #[arg(long, default_value_t = 30)]
    target_tracks: usize,
    /// Transport-enforced active subscription cap.
    #[arg(long, default_value_t = 50)]
    hard_track_cap: usize,
    /// Optional JSON array of post-encode spectator route specifications.
    #[arg(long)]
    routes: Option<PathBuf>,
    /// Return a failing exit code unless whole-world and every route gate pass.
    #[arg(long)]
    require_pass: bool,
    /// Also measure per-field symbol entropy and write symbol_audit.json.
    #[arg(long)]
    symbol_audit: bool,
    /// Entropy-code residual blocks with adaptive rANS instead of packed bytes.
    /// Measured, not adopted: zstd already reaches this stream's order-0 entropy.
    #[arg(long)]
    residual_rans: bool,
    /// Entropy-code root-segment blocks with adaptive rANS when smaller.
    #[arg(long)]
    root_rans: bool,
    /// Carry zstd context across delta blocks. Keyframes stay standalone, so
    /// recovery points are unaffected and no new dependency is introduced.
    #[arg(long)]
    block_context: bool,
    /// Loosen each body's shell bound while it is moving fast, where motion
    /// masks positional error. Artifact gates stay hard.
    #[arg(long)]
    mask_precision: bool,
    /// Loosest shell bound a masked body may reach, in millimetres.
    /// 4x the base bound is the measured perceptual ceiling; past it pixel and
    /// excess-step error cross their thresholds.
    #[arg(long, default_value_t = 20.0)]
    mask_cap_mm: f32,
    /// Per-block wire budget in megabits/s for discretionary repairs. Repairs
    /// past the hard cap, past the deadline, or on settling bodies are always
    /// sent; the rest compete by accumulated surprise.
    #[arg(long)]
    budget_mbps: Option<f64>,
    /// Hard shell-error cap for deferred repairs, as a multiple of the bound.
    #[arg(long, default_value_t = 4.0)]
    budget_hard_cap_factor: f32,
    /// A body wanting a repair is never starved longer than this many ticks.
    #[arg(long, default_value_t = 30)]
    budget_max_deferral_ticks: u32,

    /// Motion at or below which no masking applies, in metres/second.
    #[arg(long, default_value_t = 0.5)]
    mask_motion_low: f32,
    /// Motion at or above which the full cap applies, in metres/second.
    #[arg(long, default_value_t = 5.0)]
    mask_motion_high: f32,
}

fn main() -> Result<()> {
    let result = dispatch();
    // P1 census prints only when CODEC_CENSUS is set; inert otherwise.
    census::report();
    result
}

fn dispatch() -> Result<()> {
    match Cli::parse().command {
        Command::Analyze(args) => analyze(args),
        Command::Replay(args) => {
            evaluate::write_ground_truth_replay(&args.trace, &args.output, args.output_fps)
        }
        Command::Synthetic(args) => synthetic(args),
        Command::Archive(args) => archive(args),
        Command::AckBaseline(args) => ack_baseline_cmd(args),
        Command::ExactIslandProxy(args) => exact_island_proxy_cmd(args),
        Command::RootCoderBench(args) => root_coder_bench(args),
        Command::DebrisTracks(args) => debris_tracks::run(debris_tracks::DebrisTracksOptions {
            trace: args.trace,
            out_dir: args.out_dir,
            cell_size_m: args.cell_size_m,
            keyframe_ms: args.keyframe_ms,
            flush_ms: args.flush_ms,
            block_ms: args.block_ms,
            budget_mbps: args.budget_mbps,
            mask_cap_mm: args.mask_cap_mm,
            max_ticks: (args.max_ticks > 0).then_some(args.max_ticks),
            coarse_max_stride: args.coarse_max_stride,
            coarse_min_radius_m: args.coarse_min_radius_m,
            coarse_shell_cm: args.coarse_shell_cm,
            far_flush_ms: args.far_flush_ms,
            coarse_step_exp: args.coarse_step_exp,
            output_fps: args.output_fps,
            render_viewer: args.render_viewer,
            render_solo: args.render_solo,
            rig_distances_m: [
                args.rig_distances_m.first().copied().unwrap_or(50.0),
                args.rig_distances_m.get(1).copied().unwrap_or(100.0),
                args.rig_distances_m.get(2).copied().unwrap_or(190.0),
            ],
            splits: args.splits,
            subscribes: args.subscribes,
        }),
        Command::DebrisCodec(args) => debris_codec::run(debris_codec::DebrisCodecOptions {
            trace: args.trace,
            out_dir: args.out_dir,
            shell_cm: args.shell_cm,
            rotation_deg: args.rotation_deg,
            velocity_mps: args.velocity_mps,
            angular_rps: args.angular_rps,
            flush_ms: args.flush_ms,
            block_ms: args.block_ms,
            max_ticks: (args.max_ticks > 0).then_some(args.max_ticks),
            sleep_linear_mps: args.sleep_linear_mps,
            sleep_angular_rps: args.sleep_angular_rps,
            sleep_ticks: args.sleep_ticks,
            mask_precision: args.mask_precision,
            mask_cap_mm: args.mask_cap_mm,
            output_fps: args.output_fps,
            interpolation_delay_ms: args.interpolation_delay_ms,
            max_extrapolation_ms: args.max_extrapolation_ms,
            correction_ms: args.correction_ms,
            snap_distance_m: args.snap_distance_m,
            pixel_budget: args.pixel_budget,
            sample_step_max_exp: args.sample_step_max_exp,
            sample_second_order: args.sample_second_order,
            encode_parallel: args.encode_parallel,
            budget_mbps: args.budget_mbps,
            sync_min_radius_m: args.sync_min_radius_m,
            live_reference_bytes: debris_codec::default_live_reference(),
            archive_reference_bytes: debris_codec::default_archive_reference(),
        }),
    }
}

/// R4 fixture gate: on each dumped real root block, compare achievable v2
/// coder output against zstd of the same bytes, and verify exact round-trip.
/// The rule this enforces: entropy coders qualify on achievable output against
/// the incumbent, never on entropy estimates.
fn root_coder_bench(args: RootCoderBenchArgs) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(&args.dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "bin"))
        .collect();
    entries.sort();
    ensure!(!entries.is_empty(), "no fixtures in {}", args.dir.display());
    let mut total_packed = 0_u64;
    let mut total_zstd = 0_u64;
    let mut total_v2 = 0_u64;
    println!(
        "{:>10} {:>9} {:>10} {:>10} {:>10} {:>7}",
        "block", "segments", "packed", "zstd", "v2", "v2/zstd"
    );
    for path in &entries {
        let stem = path.file_stem().unwrap().to_string_lossy();
        let mut parts = stem.rsplit('_');
        let count: usize = parts.next().unwrap().parse()?;
        let tick: u32 = parts.next().unwrap().parse()?;
        let packed = std::fs::read(path)?;
        let zstd_len = zstd::bulk::compress(&packed, 3)?.len();
        let coded = root_coder::encode_v2(&packed, count)?;
        let rebuilt = root_coder::decode_v2(&coded, count)?;
        ensure!(rebuilt == packed, "v2 round-trip mismatch on {}", path.display());
        println!(
            "{:>10} {:>9} {:>10} {:>10} {:>10} {:>7.3}",
            tick,
            count,
            packed.len(),
            zstd_len,
            coded.len(),
            coded.len() as f64 / zstd_len as f64
        );
        total_packed += packed.len() as u64;
        total_zstd += zstd_len as u64;
        total_v2 += coded.len() as u64;
    }
    let ratio = total_v2 as f64 / total_zstd as f64;
    println!(
        "TOTAL packed={total_packed} zstd={total_zstd} v2={total_v2}  v2/zstd={ratio:.3}"
    );
    println!(
        "FIXTURE GATE (< 0.85 required): {}",
        if ratio < 0.85 { "PASS" } else { "FAIL" }
    );
    Ok(())
}

fn ack_baseline_cmd(args: AckBaselineArgs) -> Result<()> {
    ensure!(
        args.trace.is_file(),
        "trace does not exist: {}",
        args.trace.display()
    );
    ensure!(
        (0.0..1.0).contains(&args.loss_rate),
        "loss-rate must be in [0,1)"
    );
    let config = ack_baseline::AckBaselineConfig {
        loss_rate: args.loss_rate,
        ack_delay_ticks: args.ack_delay_ticks,
        baseline_interval_ms: args.baseline_interval_ms,
        output_fps: args.output_fps,
        seed: args.seed,
        bitrate_budget_mbps: args.bitrate_budget_mbps,
        single_view_interest: args.single_view_interest,
        // Default: omniscient shell scheduling unless chase interest is requested.
        omniscient: !args.single_view_interest,
        world_shell_budget_cm: args.world_shell_budget_cm,
        max_moving_update_ms: args.max_moving_update_ms,
        contact_update_ms: args.contact_update_ms,
        pixel_budget: 2.0,
    };
    let report = ack_baseline::run(&args.trace, &args.out_dir, &config)?;
    println!(
        "ack-baseline: scheduler={} budget={:?} interest={} modes={} reconstructed={}",
        report.scheduler,
        report.bitrate_budget_mbps,
        report.single_view_interest,
        report.modes.len(),
        report.reconstructed_towerstate
    );
    for mode in &report.modes {
        println!(
            "  {}: avg={:.2} Mbps peak={:.2} p95={:.2} abs={} delta={} omitted={} dropped={} shell_cm={:.3}",
            mode.mode,
            mode.average_mbps,
            mode.peak_one_second_mbps,
            mode.p95_one_second_mbps,
            mode.absolute_records,
            mode.delta_records,
            mode.omitted_actor_ticks,
            mode.dropped_datagrams,
            mode.max_shell_cm
        );
    }
    Ok(())
}

fn exact_island_proxy_cmd(args: ExactIslandProxyArgs) -> Result<()> {
    ensure!(
        args.trace.is_file(),
        "trace does not exist: {}",
        args.trace.display()
    );
    if args.output.exists() && !args.force {
        bail!(
            "{} already exists; pass --force to replace it",
            args.output.display()
        );
    }
    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let report = exact_island::write_exact_island_proxy(&args.trace, &args.output)?;
    let report_path = args
        .report
        .unwrap_or_else(|| PathBuf::from(format!("{}.report.json", args.output.display())));
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
    println!(
        "exact-island-proxy: snapped={} max_snap_shell_mm={:.2} report={}",
        report.snapped_child_pose_samples,
        report.max_snap_shell_m * 1000.0,
        report_path.display()
    );
    Ok(())
}

fn archive(args: ArchiveArgs) -> Result<()> {
    ensure!(
        args.trace.is_file(),
        "trace does not exist: {}",
        args.trace.display()
    );
    if let Some(routes) = &args.routes {
        ensure!(
            routes.is_file(),
            "route file does not exist: {}",
            routes.display()
        );
    }
    archive::run(
        &args.trace,
        &args.out_dir,
        &archive::ArchiveConfig {
            shell_error_mm: args.shell_error_mm,
            gop_ms: args.gop_ms,
            max_segment_ms: args.max_segment_ms,
            cell_size_m: args.cell_size_m,
            supercell_size_m: args.supercell_size_m,
            target_tracks: args.target_tracks,
            hard_track_cap: args.hard_track_cap,
            route_file: args.routes,
            require_pass: args.require_pass,
            symbol_audit: args.symbol_audit,
            residual_rans: args.residual_rans,
            root_rans: args.root_rans,
            budget: budget::BudgetConfig {
                enabled: args.budget_mbps.is_some(),
                target_mbps: args.budget_mbps.unwrap_or(0.0),
                hard_cap_factor: args.budget_hard_cap_factor,
                max_deferral_ticks: args.budget_max_deferral_ticks,
                ..budget::BudgetConfig::default()
            },
            mask: mask::MaskConfig {
                enabled: args.mask_precision,
                base_m: args.shell_error_mm / 1000.0,
                cap_m: args.mask_cap_mm / 1000.0,
                motion_low: args.mask_motion_low,
                motion_high: args.mask_motion_high,
                ..mask::MaskConfig::default()
            },
        },
    )
}

fn analyze(args: AnalyzeArgs) -> Result<()> {
    ensure!(
        args.trace.is_file(),
        "trace does not exist: {}",
        args.trace.display()
    );
    ensure!(
        args.primary_pixel_budget.is_finite() && args.primary_pixel_budget > 0.0,
        "primary-pixel-budget must be positive"
    );
    ensure!(
        args.pixel_budgets
            .iter()
            .all(|value| value.is_finite() && *value > 0.0),
        "pixel budgets must be finite and positive"
    );
    ensure!(
        args.loss_rates
            .iter()
            .all(|value| value.is_finite() && (0.0..=100.0).contains(value)),
        "loss rates are percentages in 0..=100"
    );
    let bitrate_valid = match args.bitrate_budget_mbps {
        None => true,
        Some(value) => value.is_finite() && value > 0.0,
    };
    ensure!(bitrate_valid, "bitrate budget must be positive");
    ensure!(
        args.baseline_interval_ms > 0,
        "baseline interval must be positive"
    );
    ensure!(args.quiescent_ticks > 0, "quiescent ticks must be positive");
    ensure!(args.correction_ms > 0, "correction-ms must be positive");
    ensure!(
        args.max_moving_update_ms > 0 && args.contact_update_ms > 0,
        "motion update intervals must be positive"
    );
    ensure!(
        args.snap_distance_m.is_finite() && args.snap_distance_m > 0.0,
        "snap-distance-m must be positive"
    );
    ensure!(
        args.telemetry_loss_rate.is_finite() && (0.0..=1.0).contains(&args.telemetry_loss_rate),
        "telemetry-loss-rate must be in [0, 1]"
    );
    ensure!(
        args.interest_fov_margin_deg.is_finite()
            && (0.0..90.0).contains(&args.interest_fov_margin_deg),
        "interest-fov-margin-deg must be in [0, 90)"
    );
    ensure!(
        args.interest_proximity_m.is_finite() && args.interest_proximity_m >= 0.0,
        "interest-proximity-m must be non-negative"
    );
    ensure!(
        args.world_shell_budget_cm.is_finite() && args.world_shell_budget_cm > 0.0,
        "world-shell-budget-cm must be positive"
    );
    ensure!(
        args.distance_scales
            .iter()
            .all(|value| value.is_finite() && *value > 0.0),
        "distance scales must be finite and positive"
    );
    if args.live_hierarchy {
        ensure!(
            args.hier_gop_ms >= 100,
            "hier-gop-ms must be at least 100 ms"
        );
        ensure!(
            args.hier_anchor_interval_ms >= args.hier_gop_ms,
            "hier-anchor-interval-ms must be at least hier-gop-ms"
        );
    }

    let mut pixels = args.pixel_budgets;
    if !pixels
        .iter()
        .any(|value| (*value - args.primary_pixel_budget).abs() < f32::EPSILON)
    {
        pixels.push(args.primary_pixel_budget);
    }
    pixels.sort_by(f32::total_cmp);
    pixels.dedup_by(|a, b| (*a - *b).abs() < f32::EPSILON);

    let mut losses: Vec<f64> = args.loss_rates.into_iter().map(|v| v / 100.0).collect();
    for required in [0.0, 0.01, 0.05] {
        if !losses.iter().any(|value| (*value - required).abs() < 1e-12) {
            losses.push(required);
        }
    }
    losses.sort_by(f64::total_cmp);
    losses.dedup_by(|a, b| (*a - *b).abs() < 1e-12);

    evaluate::analyze(
        &args.trace,
        &args.out_dir,
        &AnalysisConfig {
            pixel_budgets: pixels,
            primary_pixel_budget: args.primary_pixel_budget,
            loss_rates: losses,
            seed: args.seed,
            bitrate_budget_mbps: args.bitrate_budget_mbps,
            strict_total_budget: args.strict_total_budget,
            snapshot_fps: args.snapshot_fps,
            output_fps: args.output_fps,
            distance_scales: args.distance_scales,
            chase_projectile: args.chase_projectile,
            baseline_interval_ms: args.baseline_interval_ms,
            quiescent_ticks: args.quiescent_ticks,
            interpolation_delay_ms: args.interpolation_delay_ms,
            max_extrapolation_ms: args.max_extrapolation_ms,
            correction_ms: args.correction_ms,
            telemetry_only: args.telemetry_only,
            primary_only: args.primary_only,
            max_moving_update_ms: args.max_moving_update_ms,
            contact_update_ms: args.contact_update_ms,
            snap_distance_m: args.snap_distance_m,
            telemetry_loss_rate: args.telemetry_loss_rate,
            single_view_interest: args.single_view_interest,
            omniscient: args.omniscient,
            world_shell_budget_cm: args.world_shell_budget_cm,
            interest_fov_margin_deg: args.interest_fov_margin_deg,
            interest_lookahead_ms: args.interest_lookahead_ms,
            interest_grace_ms: args.interest_grace_ms,
            interest_proximity_m: args.interest_proximity_m,
            live_hierarchy: args.live_hierarchy,
            hier_max_span_ticks: args.max_span_ticks,
            hier_gop_ms: args.hier_gop_ms,
            hier_root_rans: args.root_rans,
            hier_block_context: args.block_context,
            hier_budget: budget::BudgetConfig {
                enabled: args.budget_mbps.is_some(),
                target_mbps: args.budget_mbps.unwrap_or(0.0),
                hard_cap_factor: args.budget_hard_cap_factor,
                max_deferral_ticks: args.budget_max_deferral_ticks,
                ..budget::BudgetConfig::default()
            },
            hier_mask: mask::MaskConfig {
                enabled: args.mask_precision,
                base_m: args.world_shell_budget_cm / 100.0,
                cap_m: args.mask_cap_mm / 1000.0,
                motion_low: args.mask_motion_low,
                motion_high: args.mask_motion_high,
                ..mask::MaskConfig::default()
            },
            hier_anchor_interval_ms: args.hier_anchor_interval_ms,
            hier_paced: args.hier_paced,
        },
    )
}

fn synthetic(args: SyntheticArgs) -> Result<()> {
    if args.output.exists() && !args.force {
        bail!(
            "{} already exists; pass --force to replace it",
            args.output.display()
        );
    }
    if let Some(parent) = args.output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let actors = args
        .actors
        .unwrap_or(if args.exact_islands { 48 } else { 4 });
    synthetic::write_topology_fixture(
        &args.output,
        args.physics_hz,
        args.seconds,
        args.exact_islands,
        actors,
        args.island_size,
    )?;
    println!("wrote {}", args.output.display());
    Ok(())
}
