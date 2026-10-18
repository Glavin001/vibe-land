//! Compare what a client DISPLAYED against server truth, in data.
//!
//! Both inputs are TWSTATE1 recordings over the same actor table: `truth`
//! comes from the authoritative trace, `client` from
//! `client/tools/replay-city-client.mts` (the shipping client fed the exact
//! bytes the server sent). Joining them frame by frame answers the questions
//! video cannot:
//!
//!   * how far is the client's pose from truth, per chunk, after removing the
//!     interpolation delay -- and what IS that delay, measured rather than
//!     assumed;
//!   * where does the client hold still while truth moves (freeze), jump
//!     harder than truth ever did (excess step), or move against truth's
//!     direction (reversal) -- the artifact classes that pose error alone
//!     misses, and the ones a player actually notices;
//!   * which building each failure belongs to, and at which frames, so the
//!     matching video frames can be pulled without watching the whole run.
//!
//! Every threshold below is a visibility judgement, not a codec constant, and
//! is stated in metres so it can be argued with.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use anyhow::{bail, ensure, Context, Result};
use glam::{Quat, Vec3};
use serde::Serialize;

/// Client motion below this in one frame counts as "did not move".
const STILL_M: f32 = 0.002;
/// Truth motion above this in one frame counts as "should have moved".
const MOVING_M: f32 = 0.02;
/// Consecutive frames of still-while-truth-moves before it is a freeze.
const FREEZE_FRAMES: usize = 5;
/// A client step this much larger than truth's own step is an exaggeration.
const EXCESS_RATIO: f32 = 3.0;
/// ... but never flag steps smaller than this; quantisation is not a defect.
const EXCESS_FLOOR_M: f32 = 0.25;
/// Both steps must exceed this before their directions are worth comparing.
const REVERSAL_M: f32 = 0.05;
/// Frames of lag searched when estimating the client's presentation delay.
/// Must exceed the client's worst legitimate delay: the adaptive-flush
/// governor stretches to 250 ms (15 frames at 30 fps output... 8 frames) plus
/// interpolation margin; 24 covers 800 ms of 30 fps frames with headroom.
const MAX_LAG_FRAMES: usize = 24;

#[derive(Clone, Copy)]
struct Pose {
    position: Vec3,
    #[allow(dead_code)]
    rotation: Quat,
}

struct Recording {
    fps: u32,
    /// `frames[f][slot]` -- carried forward, since frames are written as
    /// subsets and an unwritten slot keeps its previous pose (which is exactly
    /// what the renderer draws).
    frames: Vec<Vec<Pose>>,
}

fn read_u32(bytes: &[u8], at: &mut usize) -> Result<u32> {
    ensure!(*at + 4 <= bytes.len(), "truncated u32 at {at}");
    let value = u32::from_le_bytes(bytes[*at..*at + 4].try_into().expect("4 bytes"));
    *at += 4;
    Ok(value)
}

fn read_f32(bytes: &[u8], at: &mut usize) -> Result<f32> {
    ensure!(*at + 4 <= bytes.len(), "truncated f32 at {at}");
    let value = f32::from_le_bytes(bytes[*at..*at + 4].try_into().expect("4 bytes"));
    *at += 4;
    Ok(value)
}

fn read_pose(bytes: &[u8], at: &mut usize) -> Result<Pose> {
    let x = read_f32(bytes, at)?;
    let y = read_f32(bytes, at)?;
    let z = read_f32(bytes, at)?;
    let qx = read_f32(bytes, at)?;
    let qy = read_f32(bytes, at)?;
    let qz = read_f32(bytes, at)?;
    let qw = read_f32(bytes, at)?;
    Ok(Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::from_xyzw(qx, qy, qz, qw),
    })
}

/// Parses the TWSTATE1 written by `ReplayWriter` (and by the TS replayer,
/// which appends to a header this crate produced).
fn read_recording(path: &Path) -> Result<Recording> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() > 44, "{} is too small", path.display());
    ensure!(&bytes[0..8] == b"TWSTATE1", "{} is not TWSTATE1", path.display());
    let mut at = 8usize;
    let version = read_u32(&bytes, &mut at)?;
    ensure!(version == 1, "unsupported TWSTATE1 version {version}");
    let fps = read_u32(&bytes, &mut at)?;
    let frame_count = read_u32(&bytes, &mut at)? as usize;
    let _pane_width = read_u32(&bytes, &mut at)?;
    let _pane_height = read_u32(&bytes, &mut at)?;
    let _buildings = read_u32(&bytes, &mut at)?;
    let cameras = read_u32(&bytes, &mut at)? as usize;
    let _duration = read_f32(&bytes, &mut at)?;
    let _reserved = read_f32(&bytes, &mut at)?;
    at += cameras * (12 + 12 + 4);

    let mut actor_count = 0usize;
    let mut frames: Vec<Vec<Pose>> = Vec::with_capacity(frame_count);
    let mut current: Vec<Pose> = Vec::new();
    loop {
        ensure!(at < bytes.len(), "{} ended without a terminator", path.display());
        let tag = bytes[at];
        at += 1;
        match tag {
            1 => {
                let _id = read_u32(&bytes, &mut at)?;
                at += 1; // part
                let shapes = read_u32(&bytes, &mut at)? as usize;
                // kind + params(12) + local pose(28)
                at += shapes * (1 + 12 + 28);
                actor_count += 1;
            }
            2 => {
                if current.is_empty() {
                    current = vec![
                        Pose {
                            position: Vec3::ZERO,
                            rotation: Quat::IDENTITY,
                        };
                        actor_count
                    ];
                }
                let _index = read_u32(&bytes, &mut at)?;
                let updates = read_u32(&bytes, &mut at)? as usize;
                for _ in 0..updates {
                    let slot = read_u32(&bytes, &mut at)? as usize;
                    let pose = read_pose(&bytes, &mut at)?;
                    at += 1; // sleeping flag
                    ensure!(slot < current.len(), "slot {slot} outside actor table");
                    current[slot] = pose;
                }
                frames.push(current.clone());
            }
            3 => at += cameras * (12 + 12 + 4),
            255 => break,
            other => bail!("unknown TWSTATE1 record {other} at {at}"),
        }
    }
    Ok(Recording { fps, frames })
}

#[derive(Serialize, Clone)]
pub struct ArtifactEvent {
    pub kind: &'static str,
    pub slot: u32,
    pub structure: Option<u32>,
    /// Truth frame the event starts at, and the video timestamp that matches.
    pub frame: u32,
    pub seconds: f32,
    /// Metres: freeze = how far truth moved while the client held still;
    /// excess/reversal = the client's own step.
    pub magnitude_m: f32,
    pub error_m: f32,
}

#[derive(Serialize)]
pub struct StructureReport {
    pub structure: u32,
    pub chunks: usize,
    pub err_p50_m: f32,
    pub err_p95_m: f32,
    pub err_max_m: f32,
    pub freezes: usize,
    pub excess_steps: usize,
    pub reversals: usize,
}

#[derive(Serialize)]
pub struct SecondStat {
    pub second: u32,
    /// Chunks whose TRUTH moved this second -- the denominator that matters.
    pub moving: usize,
    /// p95 position error over moving chunks only, this second.
    pub err_p95_moving_m: f32,
    pub freezes: usize,
    pub excess_steps: usize,
    pub reversals: usize,
}

#[derive(Serialize)]
pub struct DiffReport {
    pub frames: usize,
    pub chunks: usize,
    pub fps: u32,
    /// Measured presentation delay: the frame offset that minimises error.
    pub lag_frames: usize,
    pub lag_ms: f32,
    pub err_p50_m: f32,
    pub err_p95_m: f32,
    pub err_max_m: f32,
    /// Error with no lag correction -- the difference between these two is
    /// what the interpolation delay costs, as opposed to what the wire costs.
    pub err_p95_unaligned_m: f32,
    /// Percentiles over chunks whose truth was moving at the sampled frame.
    /// At district scale 96% of chunks never move, so the all-chunk
    /// percentiles read 0.0 regardless of quality; these are the honest rows.
    pub err_p50_moving_m: f32,
    pub err_p95_moving_m: f32,
    pub freezes: usize,
    pub excess_steps: usize,
    pub reversals: usize,
    pub structures: Vec<StructureReport>,
    pub worst: Vec<ArtifactEvent>,
    pub timeline: Vec<SecondStat>,
}

fn percentile(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f32 * q).round() as usize;
    sorted[index]
}

/// Chunk-slot ranges per structure, in the dense order `build_chunk_table`
/// uses (structures in manifest order, chunks in structure order).
fn structure_of_slot(manifest_json: &str, chunks: usize) -> Result<Vec<u32>> {
    let value: serde_json::Value = serde_json::from_str(manifest_json)?;
    let structures = value
        .get("structures")
        .and_then(|s| s.as_array())
        .context("manifest has no structures array")?;
    let mut out = Vec::with_capacity(chunks);
    for structure in structures {
        let id = structure
            .get("structure_id")
            .or_else(|| structure.get("structureId"))
            .and_then(|v| v.as_u64())
            .unwrap_or(out.len() as u64) as u32;
        let count = structure
            .get("chunks")
            .and_then(|c| c.as_array())
            .map(|c| c.len())
            .unwrap_or(0);
        for _ in 0..count {
            out.push(id);
        }
    }
    ensure!(
        out.len() == chunks,
        "manifest describes {} chunks, recording has {chunks}",
        out.len()
    );
    Ok(out)
}

pub struct StateDiffOptions {
    pub truth: std::path::PathBuf,
    pub client: std::path::PathBuf,
    pub manifest: Option<std::path::PathBuf>,
    pub out: Option<std::path::PathBuf>,
    pub worst: usize,
}

pub fn run(options: StateDiffOptions) -> Result<()> {
    let truth = read_recording(&options.truth)?;
    let client = read_recording(&options.client)?;
    ensure!(
        truth.fps == client.fps,
        "fps mismatch: truth {} vs client {}",
        truth.fps,
        client.fps
    );
    let chunks = truth
        .frames
        .first()
        .map(|frame| frame.len())
        .unwrap_or_default();
    ensure!(chunks > 0, "truth recording has no frames");
    ensure!(
        client.frames.first().map(|f| f.len()).unwrap_or_default() == chunks,
        "actor table mismatch"
    );

    let structure_of = match &options.manifest {
        Some(path) => Some(structure_of_slot(
            &std::fs::read_to_string(path)
                .with_context(|| format!("read {}", path.display()))?,
            chunks,
        )?),
        None => None,
    };

    // --- measure the presentation delay instead of assuming it -------------
    // Sample a spread of frames and slots; the lag that minimises total error
    // is the client's effective interpolation delay.
    let common = truth.frames.len().min(client.frames.len());
    ensure!(common > MAX_LAG_FRAMES + 2, "recordings are too short");
    let sample_slots: Vec<usize> = (0..chunks).step_by((chunks / 256).max(1)).collect();
    let sample_frames: Vec<usize> = (1..common - MAX_LAG_FRAMES)
        .step_by(((common - MAX_LAG_FRAMES) / 200).max(1))
        .collect();
    let mut best_lag = 0usize;
    let mut best_error = f64::INFINITY;
    for lag in 0..=MAX_LAG_FRAMES {
        let mut total = 0.0f64;
        for &frame in &sample_frames {
            for &slot in &sample_slots {
                total += f64::from(
                    truth.frames[frame][slot]
                        .position
                        .distance(client.frames[frame + lag][slot].position),
                );
            }
        }
        if total < best_error {
            best_error = total;
            best_lag = lag;
        }
    }

    // --- per-second lag: variable-latency streams (the adaptive-flush
    // governor) make a single global offset wrong by up to the full
    // flush delta, which reads as meters of phantom error at debris
    // velocities. Estimate lag per second on moving chunks, smoothed by
    // reusing the previous second's lag when it is within noise. --------
    let per_second_lag: Vec<usize> = {
        let fps = truth.fps as usize;
        let seconds_total = (common - MAX_LAG_FRAMES) / fps;
        let mut lags = Vec::with_capacity(seconds_total);
        let mut previous = best_lag;
        for second in 0..seconds_total {
            let first = (second * fps).max(1);
            let last_frame = ((second + 1) * fps).min(common - MAX_LAG_FRAMES);
            let mut best = previous;
            let mut best_err = f64::INFINITY;
            for lag in 0..=MAX_LAG_FRAMES {
                let mut total = 0.0f64;
                let mut samples = 0usize;
                for frame in (first..last_frame).step_by(3) {
                    for &slot in &sample_slots {
                        let truth_now = truth.frames[frame][slot].position;
                        // Only moving chunks inform lag; static ones agree at
                        // every offset.
                        if truth_now.distance(truth.frames[frame - 1][slot].position) < MOVING_M {
                            continue;
                        }
                        total += f64::from(
                            truth_now.distance(client.frames[frame + lag][slot].position),
                        );
                        samples += 1;
                    }
                }
                if samples > 0 {
                    let mean = total / samples as f64;
                    // Prefer the incumbent unless a lag is clearly better:
                    // hysteresis keeps noise from flapping the alignment.
                    let margin = if lag == previous { 1.0 } else { 0.97 };
                    if mean * margin < best_err {
                        best_err = mean;
                        best = lag;
                    }
                }
            }
            lags.push(best);
            previous = best;
        }
        lags
    };
    let lag_for = |frame: usize| -> usize {
        let fps = truth.fps as usize;
        per_second_lag
            .get(frame / fps)
            .copied()
            .unwrap_or(best_lag)
    };

    // --- per-chunk sweep ---------------------------------------------------
    let mut errors: Vec<f32> = Vec::with_capacity(chunks * 64);
    let mut errors_unaligned: Vec<f32> = Vec::with_capacity(chunks * 64);
    let mut events: Vec<ArtifactEvent> = Vec::new();
    let mut per_structure: BTreeMap<u32, (Vec<f32>, usize, usize, usize, usize)> = BTreeMap::new();
    let mut freeze_run = vec![0usize; chunks];
    let mut freeze_distance = vec![0.0f32; chunks];
    let last = common - best_lag;
    let mut errors_moving: Vec<f32> = Vec::new();
    let fps = truth.fps as usize;
    let seconds_total = last / fps + 1;
    let mut second_errors: Vec<Vec<f32>> = vec![Vec::new(); seconds_total];
    let mut second_counts: Vec<[usize; 3]> = vec![[0; 3]; seconds_total];

    for frame in 1..last {
        let lag = lag_for(frame);
        if lag_for(frame - 1) != lag {
            // Alignment shifted between these frames; step comparisons across
            // the boundary would manufacture phantom jumps.
            continue;
        }
        for slot in 0..chunks {
            let truth_now = truth.frames[frame][slot].position;
            let truth_prev = truth.frames[frame - 1][slot].position;
            let client_now = client.frames[frame + lag][slot].position;
            let client_prev = client.frames[frame + lag - 1][slot].position;
            let error = truth_now.distance(client_now);
            let structure = structure_of.as_ref().map(|map| map[slot]);
            let entry = per_structure
                .entry(structure.unwrap_or(0))
                .or_insert_with(|| (Vec::new(), 0, 0, 0, 0));
            // Subsample the error series: 3k chunks x 1.3k frames is 4M
            // samples per run, and percentiles do not need all of them.
            if frame % 4 == 0 {
                errors.push(error);
                entry.0.push(error);
                errors_unaligned.push(truth_now.distance(client.frames[frame][slot].position));
            }
            entry.4 += 1;

            let truth_step = truth_now - truth_prev;
            let client_step = client_now - client_prev;
            let truth_len = truth_step.length();
            let client_len = client_step.length();
            if truth_len > MOVING_M {
                errors_moving.push(error);
                second_errors[frame / fps].push(error);
            }

            // Freeze: the client holds still while truth is moving. Reported
            // once per run of frames, carrying how far truth travelled during
            // the hold -- a 5-frame freeze on a chunk that moved 3 cm is
            // invisible; one on a chunk that fell 4 m is the whole complaint.
            if client_len < STILL_M && truth_len > MOVING_M {
                freeze_run[slot] += 1;
                freeze_distance[slot] += truth_len;
            } else {
                if freeze_run[slot] >= FREEZE_FRAMES {
                    events.push(ArtifactEvent {
                        kind: "freeze",
                        slot: slot as u32,
                        structure,
                        frame: (frame - freeze_run[slot]) as u32,
                        seconds: (frame - freeze_run[slot]) as f32 / truth.fps as f32,
                        magnitude_m: freeze_distance[slot],
                        error_m: error,
                    });
                    entry.1 += 1;
                    second_counts[frame / fps][0] += 1;
                }
                freeze_run[slot] = 0;
                freeze_distance[slot] = 0.0;
            }

            // Excess step: the client moved further in one frame than truth
            // ever did -- the "more sudden and exaggerated" failure.
            if client_len > EXCESS_FLOOR_M && client_len > truth_len * EXCESS_RATIO {
                events.push(ArtifactEvent {
                    kind: "excess-step",
                    slot: slot as u32,
                    structure,
                    frame: frame as u32,
                    seconds: frame as f32 / truth.fps as f32,
                    magnitude_m: client_len,
                    error_m: error,
                });
                entry.2 += 1;
                second_counts[frame / fps][1] += 1;
            } else if truth_len > REVERSAL_M
                && client_len > REVERSAL_M
                && client_step.dot(truth_step) < 0.0
            {
                events.push(ArtifactEvent {
                    kind: "reversal",
                    slot: slot as u32,
                    structure,
                    frame: frame as u32,
                    seconds: frame as f32 / truth.fps as f32,
                    magnitude_m: client_len,
                    error_m: error,
                });
                entry.3 += 1;
                second_counts[frame / fps][2] += 1;
            }
        }
    }

    errors.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    errors_unaligned.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let structures: Vec<StructureReport> = per_structure
        .into_iter()
        .map(|(structure, (mut errs, freezes, excess, reversals, samples))| {
            errs.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
            StructureReport {
                structure,
                chunks: samples / last.max(1),
                err_p50_m: percentile(&errs, 0.50),
                err_p95_m: percentile(&errs, 0.95),
                err_max_m: errs.last().copied().unwrap_or(0.0),
                freezes,
                excess_steps: excess,
                reversals,
            }
        })
        .collect();

    let mut worst = events.clone();
    worst.sort_by(|a, b| {
        b.magnitude_m
            .partial_cmp(&a.magnitude_m)
            .expect("finite")
    });
    worst.truncate(options.worst);

    errors_moving.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let timeline: Vec<SecondStat> = second_errors
        .iter_mut()
        .zip(&second_counts)
        .enumerate()
        .map(|(second, (errs, counts))| {
            errs.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
            SecondStat {
                second: second as u32,
                moving: errs.len() / fps.max(1),
                err_p95_moving_m: percentile(errs, 0.95),
                freezes: counts[0],
                excess_steps: counts[1],
                reversals: counts[2],
            }
        })
        .collect();
    let report = DiffReport {
        frames: last,
        chunks,
        fps: truth.fps,
        lag_frames: best_lag,
        lag_ms: best_lag as f32 * 1000.0 / truth.fps as f32,
        err_p50_m: percentile(&errors, 0.50),
        err_p95_m: percentile(&errors, 0.95),
        err_max_m: errors.last().copied().unwrap_or(0.0),
        err_p95_unaligned_m: percentile(&errors_unaligned, 0.95),
        err_p50_moving_m: percentile(&errors_moving, 0.50),
        err_p95_moving_m: percentile(&errors_moving, 0.95),
        freezes: events.iter().filter(|e| e.kind == "freeze").count(),
        excess_steps: events.iter().filter(|e| e.kind == "excess-step").count(),
        reversals: events.iter().filter(|e| e.kind == "reversal").count(),
        structures,
        worst,
        timeline,
    };

    let lag_min = per_second_lag.iter().copied().min().unwrap_or(best_lag);
    let lag_max = per_second_lag.iter().copied().max().unwrap_or(best_lag);
    println!(
        "frames {} | chunks {} | presentation delay {} frames ({:.0} ms global; per-second {}..{} frames)",
        report.frames, report.chunks, report.lag_frames, report.lag_ms, lag_min, lag_max
    );
    println!(
        "position error vs truth: p50 {:.1} cm | p95 {:.1} cm | max {:.2} m   (p95 without lag correction {:.1} cm)",
        report.err_p50_m * 100.0,
        report.err_p95_m * 100.0,
        report.err_max_m,
        report.err_p95_unaligned_m * 100.0
    );
    println!(
        "moving chunks only: p50 {:.1} cm | p95 {:.1} cm",
        report.err_p50_moving_m * 100.0,
        report.err_p95_moving_m * 100.0
    );
    println!(
        "artifacts: {} freezes | {} excess steps | {} reversals",
        report.freezes, report.excess_steps, report.reversals
    );
    if report.structures.len() > 1 {
        println!("\n  structure  chunks   err p95   err max   freeze  excess  reversal");
        for structure in &report.structures {
            println!(
                "  {:>9}  {:>6}  {:>7.1} cm  {:>6.2} m  {:>6}  {:>6}  {:>8}",
                structure.structure,
                structure.chunks,
                structure.err_p95_m * 100.0,
                structure.err_max_m,
                structure.freezes,
                structure.excess_steps,
                structure.reversals
            );
        }
    }
    if !report.worst.is_empty() {
        println!("\n  worst events (pull these frames from the video):");
        for event in report.worst.iter().take(12) {
            println!(
                "  {:>12} slot {:>5} structure {:>3}  t={:>6.2}s  {:.2} m  (err {:.2} m)",
                event.kind,
                event.slot,
                event
                    .structure
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "-".into()),
                event.seconds,
                event.magnitude_m,
                event.error_m
            );
        }
    }

    if let Some(path) = &options.out {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(&report)?)
            .with_context(|| format!("write {}", path.display()))?;
        println!("\nwrote {}", path.display());
    }
    Ok(())
}
