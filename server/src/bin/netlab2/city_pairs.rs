//! "Can you tell?" pairs for the calibration study: the full truth and what a
//! lab run's player actually drew, from that player's own camera, as two
//! separate unlabeled clips of the same moment.
//!
//!     netlab2 city-pairs --capture <capture dir> --runs <run dir>[,<run dir>...]
//!         [--client 1] [--worst 2] [--random 2] [--nulls 1] [--window-s 3]
//!         [--width 1280] [--seed 1] --out <dir>
//!
//! The study page (`scripts/netlab/study/index.html`) shows the two in random
//! order and asks which looked wrong, then how much it would bother in a
//! match (0-4). If the inspector cannot pick the netcode's clip more often
//! than chance, the netcode is indistinguishable from the full data there,
//! whatever the perceptual model says.
//!
//! Windows, per run:
//! - `--worst` the run's worst windows by the scorer's own event log (where
//!   the model says it should show);
//! - `--random` windows at random (seeded): what playing it is mostly like,
//!   so the set does not only show failures.
//!
//! Plus `--nulls` pairs whose both clips are the truth (identical): how often
//! the inspector picks a clip when there is nothing to find.
//!
//! Human time is the scarce input, so a study is normally designed rather
//! than drawn: `--list` writes every window of every run (`--step-s` apart)
//! with the scorer's penalty in it, by class, to `<out>/candidates.json`, and
//! renders nothing; `scripts/netlab/pairs-plan.py` picks the trials that teach
//! the most (spread over predicted difficulty, both netcodes at the same
//! moment, varied artifact classes) and `--plan <plan.json>` renders exactly
//! those.
//!
//! The truth is drawn at the run's own render time (the client draws the
//! server's past by its playout delay), so the delay itself is not a
//! difference. Both clips go through the same renderer: the scorer's chunk
//! boxes on a CPU rasteriser (`city_clips::Canvas`), no tint, no labels, a
//! chunk's colour fixed whatever body it is on. The
//! game's renderer (textures, lighting, dust, motion blur) would hide more;
//! this set is the stricter test.
//!
//! Output: `<out>/clips/*.mp4` and `<out>/study.json` in the study page's
//! format. Each test's `level` is the run's sustained budget (kbit/s, 0 for
//! none) and `magnitude` the scorer's penalty inside the window; the class
//! names the strategy, so answers split by netcode.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use vibe_land_destruction::netlab::cameras::ClientSpec;
use vibe_land_destruction::perception::{PerceptualModel, Projector};

use crate::chunks::ChunkTruth;
use crate::city_clips::{chunk_colour, mix, Canvas, DrawnRun, FFMPEG};
use crate::city_lab::{client_dir, CityCapture, ORIGIN_MS};
use crate::city_perceptual::slot_table;
use crate::{die, Args};

const FRAME_MS: f64 = 1000.0 / 60.0;

/// A chunk's colour, whatever body it is on: its structure's material with
/// a little per-chunk variation so pieces read apart. The game does not
/// recolour a piece when it breaks loose, so neither clip may (a body
/// marked loose before it moves would otherwise give the netcode away).
fn colour_of(slot: u32, structure: u32) -> [f32; 3] {
    mix(chunk_colour(slot, structure, true), chunk_colour(slot, structure, false), 0.3)
}

struct Pair {
    client: usize,
    id: String,
    class: String,
    level: f64,
    magnitude: f64,
    run: Option<PathBuf>,
    start_s: f64,
    end_s: f64,
    why: &'static str,
}

/// Seeded splitmix64.
struct Rng(u64);

impl Rng {
    fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub fn cmd_city_pairs(args: &Args) {
    let capture = CityCapture::open(&args.path("capture")).unwrap_or_else(|e| die(&format!("--capture: {e}")));
    let runs: Vec<PathBuf> =
        args.get("runs").unwrap_or_else(|| die("--runs <dir>[,<dir>...] is required")).split(',').map(PathBuf::from).collect();
    let num = |name: &str, default: f64| args.get(name).map_or(default, |v| v.parse().unwrap_or_else(|_| die(&format!("--{name} N"))));
    let client = num("client", 1.0) as usize;
    // --list only: every listed client's view is a candidate.
    let list_clients: Vec<usize> = args
        .get("clients")
        .map(|v| v.split(',').map(|c| c.parse().unwrap_or_else(|_| die("--clients 0,1,..."))).collect())
        .unwrap_or_else(|| vec![client]);
    let worst = num("worst", 2.0) as usize;
    let random = num("random", 2.0) as usize;
    let nulls = num("nulls", 1.0) as usize;
    let window_s = num("window-s", 3.0);
    let width = num("width", 1280.0) as usize;
    let seed = num("seed", 1.0) as u64;
    let out = PathBuf::from(args.get("out").unwrap_or_else(|| die("--out <dir> is required")));
    let clips = out.join("clips");
    std::fs::create_dir_all(&clips).unwrap_or_else(|e| die(&format!("{}: {e}", clips.display())));
    let model = PerceptualModel::literature();
    let mut rng = Rng(seed ^ 0x5eed);
    let list = args.get("list").is_some();
    let step_s = num("step-s", 1.5);
    let plan: Option<Vec<serde_json::Value>> = args.get("plan").map(|path| {
        let v: serde_json::Value = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| die(&format!("--plan {path}: unreadable")));
        v["trials"].as_array().cloned().unwrap_or_else(|| die("--plan: no trials"))
    });
    let mut candidates: Vec<serde_json::Value> = Vec::new();

    let mut pairs: Vec<Pair> = Vec::new();
    for (r, run) in runs.iter().enumerate() {
        let spec = client_spec(run, client);
        let card: serde_json::Value = std::fs::read(run.join("scorecard.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| die(&format!("{}: no scorecard.json", run.display())));
        let strategy = card["spec"]["strategy"].as_str().unwrap_or("unknown").to_string();
        let level = card["spec"]["bucket"][0].as_f64().unwrap_or(0.0);
        let cdir = client_dir(run, client);
        let mut events = Vec::new();
        crate::city_perceptual::evaluate_client(
            &cdir.join(crate::chunks::CHUNKS_FILE),
            &capture.tape_path(),
            &capture.manifest,
            capture.checkpoint.as_ref(),
            &spec.camera,
            &capture.tracks,
            ORIGIN_MS,
            model.clone(),
            Some(&mut events),
        )
        .unwrap_or_else(|e| die(&format!("{}: {e}", cdir.display())));
        let (first_s, last_s) = frame_span(&cdir.join(crate::chunks::CHUNKS_FILE)).unwrap_or_else(|e| die(&format!("{e}")));
        // Leave the join's first second out: every netcode starts empty.
        let lo = first_s + 1.0;
        let hi = last_s - window_s;
        if hi <= lo {
            die(&format!("{}: shorter than a window", run.display()));
        }
        let penalty_in = |a: f64, b: f64| -> f64 {
            events.iter().filter(|e| e.0 >= a && e.0 < b).map(|e| model.penalty(e.1, e.3, 1.0)).sum()
        };
        if list {
            for &view in &list_clients {
                let (events, motion) = if view == client {
                    (events.clone(), motion_series(&capture, run, view, &spec).unwrap_or_else(|e| die(&format!("{e}"))))
                } else {
                    let vspec = client_spec(run, view);
                    let vdir = client_dir(run, view);
                    let mut ev = Vec::new();
                    crate::city_perceptual::evaluate_client(
                        &vdir.join(crate::chunks::CHUNKS_FILE),
                        &capture.tape_path(),
                        &capture.manifest,
                        capture.checkpoint.as_ref(),
                        &vspec.camera,
                        &capture.tracks,
                        ORIGIN_MS,
                        model.clone(),
                        Some(&mut ev),
                    )
                    .unwrap_or_else(|e| die(&format!("{}: {e}", vdir.display())));
                    (ev, motion_series(&capture, run, view, &vspec).unwrap_or_else(|e| die(&format!("{e}"))))
                };
                let mut s = lo;
                while s <= hi {
                    let mut by_class: std::collections::BTreeMap<&str, f64> = std::collections::BTreeMap::new();
                    for e in events.iter().filter(|e| e.0 >= s && e.0 < s + window_s) {
                        *by_class.entry(e.1.name()).or_default() += model.penalty(e.1, e.3, 1.0);
                    }
                    let frames: Vec<&(f64, f32, u32)> = motion.iter().filter(|m| m.0 >= s && m.0 < s + window_s).collect();
                    let n = frames.len().max(1) as f32;
                    let active = frames.iter().filter(|m| m.1 >= ACTION_AREA_PX2).count() as f32 / n;
                    let mean_area = frames.iter().map(|m| m.1).sum::<f32>() / n;
                    let mean_moving = frames.iter().map(|m| m.2 as f32).sum::<f32>() / n;
                    candidates.push(serde_json::json!({
                        "run": run.display().to_string(),
                        "client": view,
                        "strategy": strategy,
                        "level": level,
                        "start_s": s,
                        "penalty": events.iter().filter(|e| e.0 >= s && e.0 < s + window_s).map(|e| model.penalty(e.1, e.3, 1.0)).sum::<f64>(),
                        "by_class": by_class,
                        "action_frames": active,
                        "moving_area_px2": mean_area,
                        "moving_chunks": mean_moving,
                    }));
                    s += step_s;
                }
            }
            continue;
        }
        if let Some(plan) = &plan {
            for t in plan.iter().filter(|t| t["run"].as_str() == Some(&run.display().to_string())) {
                let s = t["start_s"].as_f64().unwrap_or_else(|| die("--plan: a trial without start_s"));
                let null = t["null"].as_bool().unwrap_or(false);
                let view = t["client"].as_u64().map_or(client, |c| c as usize);
                pairs.push(Pair {
                    client: view,
                    id: t["id"].as_str().unwrap_or_else(|| die("--plan: a trial without id")).to_string(),
                    class: if null { "null".into() } else { format!("netcode {strategy}") },
                    level: if null { 0.0 } else { level },
                    magnitude: if null { 0.0 } else { penalty_in(s, s + window_s) },
                    run: Some(run.clone()),
                    start_s: s,
                    end_s: s + window_s,
                    why: if null { "null" } else { "plan" },
                });
            }
            continue;
        }
        // Worst: slide in quarter seconds, take the best non-overlapping.
        let mut starts: Vec<(f64, f64)> = Vec::new();
        let mut s = lo;
        while s <= hi {
            starts.push((penalty_in(s, s + window_s), s));
            s += 0.25;
        }
        starts.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut chosen: Vec<(f64, &'static str)> = Vec::new();
        for &(p, s) in &starts {
            if chosen.iter().filter(|c| c.1 == "worst").count() >= worst || p <= 0.0 {
                break;
            }
            if chosen.iter().all(|&(c, _)| (c - s).abs() >= window_s) {
                chosen.push((s, "worst"));
            }
        }
        for _ in 0..random {
            chosen.push((lo + rng.unit() * (hi - lo), "random"));
        }
        let tag = format!("r{r:02}");
        for (k, (s, why)) in chosen.into_iter().enumerate() {
            pairs.push(Pair {
                client,
                id: format!("{tag}-{k}"),
                class: format!("netcode {strategy}"),
                level,
                magnitude: penalty_in(s, s + window_s),
                run: Some(run.clone()),
                start_s: s,
                end_s: s + window_s,
                why,
            });
        }
        if r == 0 {
            for k in 0..nulls {
                let s = lo + rng.unit() * (hi - lo);
                pairs.push(Pair {
                    client,
                    id: format!("null-{k}"),
                    class: "null".into(),
                    level: 0.0,
                    magnitude: 0.0,
                    run: Some(run.clone()),
                    start_s: s,
                    end_s: s + window_s,
                    why: "null",
                });
            }
        }
    }

    if list {
        std::fs::write(
            out.join("candidates.json"),
            serde_json::to_vec_pretty(&serde_json::json!({"capture": capture.dir.display().to_string(), "window_s": window_s, "candidates": candidates}))
                .expect("json"),
        )
        .unwrap_or_else(|e| die(&format!("candidates.json: {e}")));
        eprintln!("{} candidate windows in {}", candidates.len(), out.display());
        return;
    }
    let mut windows = Vec::new();
    for pair in &pairs {
        let run = pair.run.as_ref().expect("a run");
        let spec = client_spec(run, pair.client);
        let truth_clip = format!("{}-truth.mp4", pair.id);
        let test_clip = format!("{}-test.mp4", pair.id);
        let diff = render_pair(&capture, run, pair.client, &spec, pair, width, &clips.join(&truth_clip), &clips.join(&test_clip))
            .unwrap_or_else(|e| die(&format!("{}: {e}", pair.id)));
        eprintln!("{}: {} {:.2}..{:.2} s ({}), penalty {:.1}", pair.id, pair.class, pair.start_s, pair.end_s, pair.why, pair.magnitude);
        windows.push(serde_json::json!({
            "id": pair.id,
            "class": pair.class,
            "unit": "penalty in the window",
            "truth_clip": truth_clip,
            "tests": [{"clip": test_clip, "level": pair.level, "magnitude": pair.magnitude}],
            "run": run.display().to_string(),
            "client": pair.client,
            "start_s": pair.start_s,
            "end_s": pair.end_s,
            "why": pair.why,
            "pixel_diff": diff,
        }));
    }
    let study = serde_json::json!({
        "format": "vibe-land calibration study 1",
        "kind": "can you tell: truth against the netcode's drawing",
        "capture": capture.dir.display().to_string(),
        "window_s": window_s,
        "seed": seed,
        "model": model,
        "windows": windows,
    });
    std::fs::write(out.join("study.json"), serde_json::to_vec_pretty(&study).expect("json"))
        .unwrap_or_else(|e| die(&format!("study.json: {e}")));
    eprintln!("{} pairs in {}", pairs.len(), out.display());
}

fn client_spec(run: &Path, client: usize) -> ClientSpec {
    std::fs::read(client_dir(run, client).join("stream.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v["client"].clone()).ok())
        .unwrap_or_else(|| die(&format!("{}: no stream.json for client {client}", run.display())))
}

/// A frame "has action" when debris that moved since the last frame covers at
/// least this much of the scorer's 1920x1080 pane (about a 45 px square):
/// a study design choice, so a window is not mostly an empty view.
const ACTION_AREA_PX2: f32 = 2000.0;

/// Per drawn frame of a run's client: (time s, screen area of truth debris
/// that moved more than a pixel since the last frame, px^2 on the scorer's
/// pane, and how many such chunks). What the viewer can see happening.
fn motion_series(capture: &CityCapture, run: &Path, client: usize, spec: &ClientSpec) -> std::io::Result<Vec<(f64, f32, u32)>> {
    let slots = slot_table(&capture.manifest);
    let mut drawn = DrawnRun::open(&client_dir(run, client).join(crate::chunks::CHUNKS_FILE))?;
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let mut last: Vec<Option<glam::Vec2>> = vec![None; slots.len()];
    let mut out = Vec::new();
    let mut t = ORIGIN_MS;
    while !drawn.finished() {
        let Some((sim_tick, render)) = drawn.advance(t)? else {
            t += FRAME_MS;
            continue;
        };
        truth.advance_to(sim_tick)?;
        let seconds = ((t - ORIGIN_MS) / 1000.0) as f32;
        if let Some(camera) = spec.camera.camera_in_run(sim_tick, seconds, &capture.tracks) {
            let projector = Projector::new(camera, (1920, 1080));
            let (mut area, mut moving) = (0.0f32, 0u32);
            for slot in 0..slots.len() as u32 {
                let Some(c) = truth.chunk_at(slot, render) else {
                    last[slot as usize] = None;
                    continue;
                };
                if vibe_land_destruction::ids::body_entity_parts(c.key).1 == 0 {
                    last[slot as usize] = None;
                    continue;
                }
                let Some((p, depth)) = projector.project(c.position) else {
                    last[slot as usize] = None;
                    continue;
                };
                let on = p.x.abs() <= 960.0 && p.y.abs() <= 540.0;
                if on {
                    if let Some(q) = last[slot as usize] {
                        if p.distance(q) > 1.0 {
                            let r = slots[slot as usize].half_extents.length() * projector.focal_px() / depth;
                            area += std::f32::consts::PI * r * r;
                            moving += 1;
                        }
                    }
                }
                last[slot as usize] = on.then_some(p);
            }
            out.push((t / 1000.0, area, moving));
        }
        truth.trim(render.floor().max(0.0) as u32);
        t += FRAME_MS;
    }
    Ok(out)
}

/// The first and last drawn frame times, s on the lab's clock.
fn frame_span(path: &Path) -> std::io::Result<(f64, f64)> {
    let mut reader = crate::chunks::ChunkReader::open(path)?;
    let (mut first, mut last) = (None, 0.0);
    while let Some(frame) = reader.next_frame()? {
        first.get_or_insert(frame.sample_ms);
        last = frame.sample_ms;
    }
    Ok((first.unwrap_or(0.0) / 1000.0, last / 1000.0))
}

/// One window: the truth and the run's drawing, each to its own clip, frame
/// for frame. A null pair writes the truth twice.
#[allow(clippy::too_many_arguments)]
fn render_pair(
    capture: &CityCapture,
    run: &Path,
    client: usize,
    spec: &ClientSpec,
    pair: &Pair,
    width: usize,
    truth_path: &Path,
    test_path: &Path,
) -> std::io::Result<PixelDiff> {
    let height = width * 9 / 16;
    let mut diff = PixelDiff::default();
    let mut truth_frame = vec![0u8; width * height * 3];
    let slots = slot_table(&capture.manifest);
    let mut structure_of: Vec<u32> = Vec::with_capacity(slots.len());
    for structure in &capture.manifest.structures {
        let n = structure.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0);
        structure_of.extend(std::iter::repeat(structure.structure_id).take(n as usize));
    }
    let mut drawn = DrawnRun::open(&client_dir(run, client).join(crate::chunks::CHUNKS_FILE))?;
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let spawn = |path: &Path| {
        Command::new(FFMPEG)
            .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s"])
            .arg(format!("{width}x{height}"))
            .args(["-r", "60", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart"])
            .arg(path)
            .stdin(Stdio::piped())
            .spawn()
    };
    let mut truth_ff = spawn(truth_path)?;
    let mut test_ff = spawn(test_path)?;
    let mut truth_in = truth_ff.stdin.take().expect("stdin");
    let mut test_in = test_ff.stdin.take().expect("stdin");
    let mut pane = Canvas::new(width, height);
    let mut frame = vec![0u8; width * height * 3];
    let null = pair.class == "null";
    let (start_ms, end_ms) = (pair.start_s * 1000.0, pair.end_s * 1000.0);
    let mut t = (start_ms.min(ORIGIN_MS) / FRAME_MS).floor() * FRAME_MS;
    let mut written = 0usize;
    while t < end_ms {
        let Some((sim_tick, render)) = drawn.advance(t)? else {
            t += FRAME_MS;
            continue;
        };
        truth.advance_to(sim_tick)?;
        let seconds = ((t - ORIGIN_MS) / 1000.0) as f32;
        if t >= start_ms {
            if let Some(camera) = spec.camera.camera_in_run(sim_tick, seconds, &capture.tracks) {
                let projector = Projector::new(camera, (width as u32, height as u32));
                pane.clear(&camera);
                for slot in 0..slots.len() as u32 {
                    if let Some(c) = truth.chunk_at(slot, render) {
                        let colour = colour_of(slot, structure_of[slot as usize]);
                        pane.draw_box(&projector, &camera, c.position, c.rotation, slots[slot as usize].half_extents, colour);
                    }
                }
                pane.blit(&mut frame, 1, 0, 0);
                truth_in.write_all(&frame)?;
                truth_frame.copy_from_slice(&frame);
                if !null {
                    pane.clear(&camera);
                    for slot in 0..slots.len() as u32 {
                        let Some(c) = drawn.tables.chunk(slot).filter(|c| c.drawn) else { continue };
                        let colour = colour_of(slot, structure_of[slot as usize]);
                        pane.draw_box(&projector, &camera, c.position, c.rotation, slots[slot as usize].half_extents, colour);
                    }
                    pane.blit(&mut frame, 1, 0, 0);
                }
                test_in.write_all(&frame)?;
                // The renderer is deterministic: any pixel that differs is the
                // netcode's.
                let px = frame.chunks_exact(3).zip(truth_frame.chunks_exact(3)).filter(|(a, b)| a != b).count();
                let shifted = shifted_pixels(&frame, &truth_frame, width, height);
                diff.frames += 1;
                diff.frames_differing += u32::from(px > 0);
                diff.pixels_total += px as u64;
                diff.pixels_max = diff.pixels_max.max(px as u32);
                diff.frames_shifted += u32::from(shifted > 0);
                diff.shifted_total += shifted as u64;
                diff.shifted_max = diff.shifted_max.max(shifted as u32);
                written += 1;
            }
        }
        truth.trim(render.floor().max(0.0) as u32);
        t += FRAME_MS;
    }
    drop(truth_in);
    drop(test_in);
    for (ff, path) in [(&mut truth_ff, truth_path), (&mut test_ff, test_path)] {
        if !ff.wait()?.success() {
            return Err(std::io::Error::other(format!("ffmpeg failed on {}", path.display())));
        }
    }
    if written == 0 {
        return Err(std::io::Error::other("no frames in the window"));
    }
    diff.pane = (width as u32, height as u32);
    Ok(diff)
}

/// How the two clips of a pair differ, pixel for pixel, before encoding.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
struct PixelDiff {
    frames: u32,
    frames_differing: u32,
    /// Differing pixels summed over the frames.
    pixels_total: u64,
    /// The most in one frame.
    pixels_max: u32,
    /// The same, counting only visible differences (`shifted_pixels`: past
    /// a just-noticeable colour difference, and not a 1-2 px shift).
    frames_shifted: u32,
    shifted_total: u64,
    shifted_max: u32,
    pane: (u32, u32),
}

/// Edge tolerance for `shifted_pixels`, px: the common tolerance of image
/// regression comparisons (a 5x5 neighbourhood).
const EDGE_TOLERANCE_PX: i64 = 2;

/// A colour difference smaller than this is not seen: the just-noticeable
/// difference in CIELAB, Delta E*ab 2.3 (Sharma & Trussell, 1997). Shading a
/// face by its angle to the light makes a slightly rotated piece one colour
/// step lighter over its whole face, which no one can see.
const JND_DELTA_E: f32 = 2.3;

/// sRGB (8 bit) to CIELAB (D65).
fn lab(rgb: &[u8]) -> [f32; 3] {
    let lin = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(rgb[0]), lin(rgb[1]), lin(rgb[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Pixels that differ visibly between the frames: a colour difference over
/// `JND_DELTA_E`, with no colour within it anywhere `EDGE_TOLERANCE_PX`
/// around in the other frame (both directions, so a piece missing from
/// either clip counts). A surface shifted by a pixel or two, or shaded a
/// step differently, does not.
fn shifted_pixels(a: &[u8], b: &[u8], width: usize, height: usize) -> usize {
    let to_lab = |img: &[u8]| img.chunks_exact(3).map(lab).collect::<Vec<[f32; 3]>>();
    let (la, lb) = (to_lab(a), to_lab(b));
    let close = |p: [f32; 3], q: [f32; 3]| {
        let (d0, d1, d2) = (p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        d0 * d0 + d1 * d1 + d2 * d2 <= JND_DELTA_E * JND_DELTA_E
    };
    let idx = |x: i64, y: i64| y.clamp(0, height as i64 - 1) as usize * width + x.clamp(0, width as i64 - 1) as usize;
    let found = |img: &[[f32; 3]], x: i64, y: i64, colour: [f32; 3]| {
        (-EDGE_TOLERANCE_PX..=EDGE_TOLERANCE_PX)
            .any(|dy| (-EDGE_TOLERANCE_PX..=EDGE_TOLERANCE_PX).any(|dx| close(img[idx(x + dx, y + dy)], colour)))
    };
    let mut n = 0;
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let (pa, pb) = (la[idx(x, y)], lb[idx(x, y)]);
            if close(pa, pb) {
                continue;
            }
            if !found(&lb, x, y, pa) || !found(&la, x, y, pb) {
                n += 1;
            }
        }
    }
    n
}
