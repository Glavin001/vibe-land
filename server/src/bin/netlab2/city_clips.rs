//! Worst-clip review for the city lab: the truth and what each run's client
//! drew, side by side from that client's own camera, rendered to mp4.
//!
//!     netlab2 city-clips --capture <capture dir> --runs <run dir>[,<run dir>...]
//!         [--client 1] [--top 2] [--window-s 4] [--pre-s 1] [--slow 1]
//!         [--width 640] [--zoom 4] [--no-tint] [--out <dir>]
//!
//! Each run directory is a `netlab2 city` output (one per strategy, same
//! capture, clients and seed). The windows are each run's worst moments by
//! the perceptual evaluator's own event log (the penalty the scorecard
//! counts, binned by time), so a clip shows exactly what was scored. Every
//! clip carries every run, so a window that is one run's worst also shows
//! how the other ran through it.
//!
//! The renderer is a CPU rasteriser of the chunk boxes (the scorer's own
//! geometry, not the game's meshes): standing structures in a muted colour
//! per structure, loose pieces in a colour per chunk, so the same chunk is
//! the same colour in every pane. Unless `--no-tint`, a drawn piece is
//! tinted magenta in proportion to its on-screen error against the truth
//! (2 px untinted, 24 px fully, in the scorer's 1920x1080 pixels), which
//! points the eye at what was scored. `--zoom X` adds a second row: the same
//! eye with the field of view narrowed X times, aimed at where the window's
//! scored bodies were (the player saw the top row; the bottom is for review).
//!
//! Output: `clip-NN.mp4`, `clip-NN.jpg` (its middle frame) and `clips.json`
//! / `clips.md` (each window, why it was chosen, each run's penalty in it).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use glam::{Quat, Vec3};

use vibe_land_destruction::ids;
use vibe_land_destruction::netlab::cameras::ClientSpec;
use vibe_land_destruction::perception::{box_corners, ArtifactClass, PerceptualModel, Projector};
use vibe_land_destruction::types::Camera;

use crate::chunks::{ChunkFrame, ChunkReader, ChunkTruth, DrawnTables};
use crate::city_lab::{client_dir, CityCapture, ORIGIN_MS};
use crate::city_perceptual::slot_table;
use crate::{die, Args};

pub(crate) const FFMPEG: &str = "/opt/homebrew/bin/ffmpeg";
pub(crate) const FONT: &str = "/System/Library/Fonts/Supplemental/Arial.ttf";
/// Event-log bin width when ranking windows.
const BIN_S: f64 = 0.25;

type Event = (f64, ArtifactClass, u32, f64);

struct Run {
    dir: PathBuf,
    name: String,
    events: Vec<Event>,
}

#[derive(Clone, Debug, serde::Serialize)]
struct Window {
    start_s: f64,
    end_s: f64,
    /// The run whose worst moment this is.
    chosen_for: String,
    /// Per run: the scored penalty inside the window, and its top classes.
    penalty: BTreeMap<String, f64>,
    classes: BTreeMap<String, Vec<(String, f64)>>,
    /// Truth bodies the window's events were scored on (the zoom aims at
    /// them).
    #[serde(skip)]
    bodies: std::collections::HashSet<u32>,
}

pub fn cmd_city_clips(args: &Args) {
    let capture = CityCapture::open(&args.path("capture")).unwrap_or_else(|e| die(&format!("--capture: {e}")));
    let run_dirs: Vec<PathBuf> =
        args.get("runs").unwrap_or_else(|| die("--runs <dir>[,<dir>...] is required")).split(',').map(PathBuf::from).collect();
    let client: usize = args.get("client").map_or(1, |c| c.parse().unwrap_or_else(|_| die("--client N")));
    let top: usize = args.get("top").map_or(2, |c| c.parse().unwrap_or_else(|_| die("--top N")));
    let window_s: f64 = args.get("window-s").map_or(4.0, |c| c.parse().unwrap_or_else(|_| die("--window-s S")));
    let pre_s: f64 = args.get("pre-s").map_or(1.0, |c| c.parse().unwrap_or_else(|_| die("--pre-s S")));
    let slow: f64 = args.get("slow").map_or(1.0, |c| c.parse().unwrap_or_else(|_| die("--slow X")));
    let width: usize = args.get("width").map_or(640, |c| c.parse().unwrap_or_else(|_| die("--width PX")));
    let tint = args.get("no-tint").is_none();
    let zoom: Option<f32> = args.get("zoom").map(|c| c.parse().unwrap_or_else(|_| die("--zoom X")));
    let out = args.get("out").map_or_else(|| run_dirs[0].join("clips"), PathBuf::from);
    std::fs::create_dir_all(&out).unwrap_or_else(|e| die(&format!("{}: {e}", out.display())));
    let model = match args.get("model") {
        Some(path) => PerceptualModel::load(Path::new(path)).unwrap_or_else(|e| die(&format!("--model {path}: {e}"))),
        None => PerceptualModel::literature(),
    };

    // The client's camera, as the first run recorded it (every run of one
    // comparison shares the client set).
    let spec: ClientSpec = std::fs::read(client_dir(&run_dirs[0], client).join("stream.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v["client"].clone()).ok())
        .unwrap_or_else(|| die("the first run has no stream.json for that client"));

    // Each run's scored events, from the evaluator itself.
    let runs: Vec<Run> = std::thread::scope(|scope| {
        let handles: Vec<_> = run_dirs
            .iter()
            .map(|dir| {
                let (capture, spec, model) = (&capture, &spec, model.clone());
                scope.spawn(move || {
                    let cdir = client_dir(dir, client);
                    let mut events = Vec::new();
                    crate::city_perceptual::evaluate_client(
                        &cdir.join(crate::chunks::CHUNKS_FILE),
                        &capture.tape_path(),
                        &capture.manifest,
                        capture.checkpoint.as_ref(),
                        &spec.camera,
                        &capture.tracks,
                        ORIGIN_MS,
                        model,
                        Some(&mut events),
                    )
                    .unwrap_or_else(|e| die(&format!("{}: {e}", cdir.display())));
                    let name = std::fs::read(dir.join("scorecard.json"))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                        .and_then(|v| v["spec"]["strategy"].as_str().map(str::to_string))
                        .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
                    Run { dir: dir.clone(), name, events }
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("evaluator thread")).collect()
    });
    // Two runs of one strategy (a knob A/B) are told apart by directory.
    let mut runs = runs;
    let names: Vec<String> = runs.iter().map(|r| r.name.clone()).collect();
    for run in &mut runs {
        if names.iter().filter(|n| **n == run.name).count() > 1 {
            let parent = run.dir.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            run.name = format!("{} ({parent})", run.name);
        }
    }

    let windows = choose_windows(&runs, &model, top, window_s, pre_s);
    if windows.is_empty() {
        die("no scored events in any run: nothing to show");
    }
    for (i, w) in windows.iter().enumerate() {
        eprintln!(
            "clip-{i:02}: {:.2}..{:.2} s, worst for {}: {}",
            w.start_s,
            w.end_s,
            w.chosen_for,
            w.penalty.iter().map(|(k, v)| format!("{k} {v:.2}")).collect::<Vec<_>>().join(", ")
        );
    }
    let focus = match zoom {
        Some(_) => focus_points(&capture, &runs[0], &spec, &windows, client).unwrap_or_else(|e| die(&format!("focus: {e}"))),
        None => vec![None; windows.len()],
    };
    let options = RenderOptions { width, slow, tint, client, zoom, pane: model.pane };
    render(&capture, &runs, &spec, &windows, &focus, &out, &options).unwrap_or_else(|e| die(&format!("render: {e}")));
    write_index(&out, &runs, &windows, client, slow).unwrap_or_else(|e| die(&format!("index: {e}")));
    eprintln!("clips in {}", out.display());
}

/// Each run's `top` worst windows by scored penalty, without overlaps.
fn choose_windows(runs: &[Run], model: &PerceptualModel, top: usize, window_s: f64, pre_s: f64) -> Vec<Window> {
    let penalty_in = |run: &Run, a: f64, b: f64| -> (f64, Vec<(String, f64)>) {
        let mut by: BTreeMap<&'static str, f64> = BTreeMap::new();
        let mut total = 0.0;
        for &(t, class, _, m) in &run.events {
            if t >= a && t < b {
                let p = model.penalty(class, m, 1.0);
                total += p;
                *by.entry(class.name()).or_default() += p;
            }
        }
        let mut classes: Vec<(String, f64)> = by.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        classes.sort_by(|a, b| b.1.total_cmp(&a.1));
        classes.truncate(3);
        (total, classes)
    };
    let mut chosen: Vec<Window> = Vec::new();
    for run in runs {
        // Penalty per bin, then the best sum over a window's bins.
        let mut bins: BTreeMap<i64, f64> = BTreeMap::new();
        for &(t, class, _, m) in &run.events {
            *bins.entry((t / BIN_S).floor() as i64).or_default() += model.penalty(class, m, 1.0);
        }
        let span = (window_s / BIN_S).round().max(1.0) as i64;
        let mut starts: Vec<(f64, f64)> = bins
            .keys()
            .map(|&b| {
                // A window whose `pre_s` lead-in ends at this bin.
                let start = b as f64 * BIN_S - pre_s;
                let first = (start / BIN_S).floor() as i64;
                let sum: f64 = bins.range(first..first + span).map(|(_, v)| v).sum();
                (sum, start)
            })
            .collect();
        starts.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut taken = 0;
        for (_, start) in starts {
            if taken >= top {
                break;
            }
            let end = start + window_s;
            if chosen.iter().any(|w| start < w.end_s && w.start_s < end) {
                continue;
            }
            let mut window = Window {
                start_s: start,
                end_s: end,
                chosen_for: run.name.clone(),
                penalty: BTreeMap::new(),
                classes: BTreeMap::new(),
                bodies: Default::default(),
            };
            for r in runs {
                window.bodies.extend(r.events.iter().filter(|e| e.0 >= start && e.0 < end && e.2 != u32::MAX).map(|e| e.2));
                let (p, c) = penalty_in(r, start, end);
                window.penalty.insert(r.name.clone(), p);
                window.classes.insert(r.name.clone(), c);
            }
            chosen.push(window);
            taken += 1;
        }
    }
    chosen.sort_by(|a, b| a.start_s.total_cmp(&b.start_s));
    chosen
}

/// One run's drawn world, advanced frame by frame.
struct DrawnRun {
    reader: ChunkReader,
    tables: DrawnTables,
    pending: Option<ChunkFrame>,
    current: Option<(u32, f32)>,
    scratch: Vec<u32>,
}

impl DrawnRun {
    fn open(path: &Path) -> std::io::Result<Self> {
        let mut reader = ChunkReader::open(path)?;
        let tables = DrawnTables::new(reader.chunk_count);
        let pending = reader.next_frame()?;
        Ok(Self { reader, tables, pending, current: None, scratch: Vec::new() })
    }

    /// Apply every frame sampled at or before `ms`; the newest's (sim tick,
    /// render tick).
    fn advance(&mut self, ms: f64) -> std::io::Result<Option<(u32, f32)>> {
        while self.pending.as_ref().is_some_and(|f| f.sample_ms <= ms + 1e-6) {
            let frame = self.pending.take().unwrap();
            self.scratch.clear();
            self.tables.apply(&frame, &mut self.scratch);
            let render =
                if frame.render_tick >= 0.0 { frame.render_tick - frame.playout_delay_ticks } else { frame.sim_tick as f32 };
            self.current = Some((frame.sim_tick, render));
            self.pending = self.reader.next_frame()?;
        }
        Ok(self.current)
    }
}

struct RenderOptions {
    width: usize,
    slow: f64,
    tint: bool,
    client: usize,
    /// A second row: the same eye, the field of view narrowed this much,
    /// aimed at the window's scored bodies.
    zoom: Option<f32>,
    /// The scorer's pane: tint errors are in its pixels.
    pane: (u32, u32),
}

/// Per window: where its scored bodies were in the truth (the mean of
/// their chunks over the window's frames), or None when none was seen.
fn focus_points(
    capture: &CityCapture,
    run: &Run,
    spec: &ClientSpec,
    windows: &[Window],
    client: usize,
) -> std::io::Result<Vec<Option<Vec3>>> {
    let mut drawn = DrawnRun::open(&client_dir(&run.dir, client).join(crate::chunks::CHUNKS_FILE))?;
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let count = truth.chunk_count;
    let mut out = Vec::with_capacity(windows.len());
    let frame_ms = 1000.0 / 60.0;
    for window in windows {
        let (mut sum, mut n) = (Vec3::ZERO, 0u32);
        let mut t = window.start_s * 1000.0;
        while t < window.end_s * 1000.0 {
            if let Some((sim_tick, render)) = drawn.advance(t)? {
                truth.advance_to(sim_tick)?;
                let seconds = ((t - ORIGIN_MS) / 1000.0) as f32;
                if let Some(camera) = spec.camera.camera_in_run(sim_tick, seconds, &capture.tracks) {
                    let projector = Projector::new(camera, (1920, 1080));
                    for slot in 0..count {
                        if let Some(c) = truth.chunk_at(slot, render) {
                            if window.bodies.contains(&c.key) && projector.sphere_on_screen(c.position, 0.0) {
                                sum += c.position;
                                n += 1;
                            }
                        }
                    }
                }
                truth.trim(render.floor().max(0.0) as u32);
            }
            t += frame_ms;
        }
        out.push((n > 0).then(|| sum / n as f32));
    }
    Ok(out)
}

fn render(
    capture: &CityCapture,
    runs: &[Run],
    spec: &ClientSpec,
    windows: &[Window],
    focus: &[Option<Vec3>],
    out: &Path,
    options: &RenderOptions,
) -> std::io::Result<()> {
    let width = options.width;
    let height = width * 9 / 16;
    let panes = runs.len() + 1;
    let rows = if options.zoom.is_some() { 2 } else { 1 };
    let slots = slot_table(&capture.manifest);
    let mut structure_of: Vec<u32> = Vec::with_capacity(slots.len());
    for structure in &capture.manifest.structures {
        let n = structure.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0);
        structure_of.extend(std::iter::repeat(structure.structure_id).take(n as usize));
    }
    let mut drawn: Vec<DrawnRun> = runs
        .iter()
        .map(|r| DrawnRun::open(&client_dir(&r.dir, options.client).join(crate::chunks::CHUNKS_FILE)))
        .collect::<std::io::Result<_>>()?;
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let mut canvas = vec![0u8; rows * panes * width * height * 3];
    let mut pane = Canvas::new(width, height);
    // The drawing clock: the first run's frames (every stage samples at
    // 60 frames/s on the lab's clock).
    let frame_ms = 1000.0 / 60.0;
    let first_ms = windows[0].start_s * 1000.0;
    let mut t = (first_ms / frame_ms).floor() * frame_ms;
    let label = |text: &str, x: usize, y: usize, size: usize| {
        format!(
            "drawtext=fontfile={FONT}:text='{}':x={x}+10:y={y}+10:fontsize={size}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6",
            text.replace(['\'', ':', ','], " ")
        )
    };
    for (index, window) in windows.iter().enumerate() {
        let path = out.join(format!("clip-{index:02}.mp4"));
        let names: Vec<String> = std::iter::once("truth".to_string()).chain(runs.iter().map(|r| r.name.clone())).collect();
        let mut filters: Vec<String> = names.iter().enumerate().map(|(i, l)| label(l, i * width, 0, height / 18)).collect();
        let zoom_row = options.zoom.zip(focus[index]);
        if let Some((z, _)) = zoom_row {
            filters.push(label(&format!("zoom {z}x"), 0, height, height / 22));
        }
        let still_filters = filters.clone();
        filters.push(format!(
            "drawtext=fontfile={FONT}:text='client c{:02}  t=%{{eif\\:{:.0}+t*{}*1000\\:d}} ms  worst for {}':x=w-tw-10:y=h-th-10:fontsize={}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6",
            options.client,
            window.start_s * 1000.0,
            1.0 / options.slow,
            window.chosen_for.replace(['\'', ':', ','], " "),
            height / 22
        ));
        let size = format!("{}x{}", panes * width, rows * height);
        let mut ffmpeg = Command::new(FFMPEG)
            .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &size, "-r"])
            .arg(format!("{}", 60.0 / options.slow))
            .args(["-i", "-", "-vf"])
            .arg(filters.join(","))
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart"])
            .arg(&path)
            .stdin(Stdio::piped())
            .spawn()?;
        let mut stdin = ffmpeg.stdin.take().expect("ffmpeg stdin");
        let start_ms = window.start_s * 1000.0;
        let end_ms = window.end_s * 1000.0;
        let mut written = 0;
        let mut middle: Option<Vec<u8>> = None;
        let total_frames = ((end_ms - start_ms) / frame_ms) as usize;
        while t < end_ms {
            let mut frames: Vec<Option<(u32, f32)>> = Vec::with_capacity(drawn.len());
            for d in &mut drawn {
                frames.push(d.advance(t)?);
            }
            let Some((sim_tick, render0)) = frames[0] else {
                t += frame_ms;
                continue;
            };
            truth.advance_to(sim_tick)?;
            let floor = frames.iter().flatten().map(|f| f.1).fold(render0, f32::min);
            let seconds = ((t - ORIGIN_MS) / 1000.0) as f32;
            if let Some(camera) = (t >= start_ms).then(|| spec.camera.camera_in_run(sim_tick, seconds, &capture.tracks)).flatten() {
                let scorer = Projector::new(camera, options.pane);
                let mut cameras = vec![camera];
                if let Some((z, at)) = zoom_row {
                    let fov = (2.0 * ((camera.fov_degrees.to_radians() * 0.5).tan() / z).atan()).to_degrees();
                    cameras.push(Camera { eye: camera.eye, direction: (at - camera.eye).normalize_or_zero(), fov_degrees: fov });
                }
                for (row, view) in cameras.iter().enumerate() {
                    let projector = Projector::new(*view, (width as u32, height as u32));
                    // Truth at the first run's render time.
                    pane.clear(view);
                    for slot in 0..slots.len() as u32 {
                        if let Some(c) = truth.chunk_at(slot, render0) {
                            let standing = ids::body_entity_parts(c.key).1 == 0;
                            let colour = chunk_colour(slot, structure_of[slot as usize], standing);
                            pane.draw_box(&projector, view, c.position, c.rotation, slots[slot as usize].half_extents, colour);
                        }
                    }
                    pane.blit(&mut canvas, panes, row, 0);
                    for (i, d) in drawn.iter().enumerate() {
                        let render = frames[i].map_or(render0, |f| f.1);
                        pane.clear(view);
                        for slot in 0..slots.len() as u32 {
                            let Some(c) = d.tables.chunk(slot).filter(|c| c.drawn) else { continue };
                            let standing = ids::body_entity_parts(c.key).1 == 0;
                            let mut colour = chunk_colour(slot, structure_of[slot as usize], standing);
                            if options.tint && !standing {
                                // The error in the scorer's pixels, from the
                                // client's own view (not the zoom's).
                                let error_px = truth.chunk_at(slot, render).and_then(|tc| {
                                    let a = scorer.project(c.position)?.0;
                                    let b = scorer.project(tc.position)?.0;
                                    Some(a.distance(b))
                                });
                                let k = error_px.map_or(1.0, |e| ((e - 2.0) / 22.0).clamp(0.0, 1.0));
                                colour = mix(colour, [235.0, 40.0, 220.0], k);
                            }
                            pane.draw_box(&projector, view, c.position, c.rotation, slots[slot as usize].half_extents, colour);
                        }
                        pane.blit(&mut canvas, panes, row, i + 1);
                    }
                }
                stdin.write_all(&canvas)?;
                if written == total_frames / 2 {
                    middle = Some(canvas.clone());
                }
                written += 1;
            }
            truth.trim(floor.floor().max(0.0) as u32);
            t += frame_ms;
        }
        drop(stdin);
        let status = ffmpeg.wait()?;
        if !status.success() {
            return Err(std::io::Error::other(format!("ffmpeg failed on {}", path.display())));
        }
        if let Some(frame) = middle {
            // The middle frame as a still, for reports.
            let mut still = Command::new(FFMPEG)
                .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &size, "-i", "-", "-vf"])
                .arg(still_filters.join(","))
                .args(["-frames:v", "1", "-q:v", "3"])
                .arg(out.join(format!("clip-{index:02}.jpg")))
                .stdin(Stdio::piped())
                .spawn()?;
            still.stdin.take().expect("ffmpeg stdin").write_all(&frame)?;
            still.wait()?;
        }
        eprintln!("wrote {} ({written} frames)", path.display());
    }
    Ok(())
}

fn write_index(out: &Path, runs: &[Run], windows: &[Window], client: usize, slow: f64) -> std::io::Result<()> {
    std::fs::write(
        out.join("clips.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "client": client,
            "slow": slow,
            "runs": runs.iter().map(|r| serde_json::json!({"name": r.name, "dir": r.dir})).collect::<Vec<_>>(),
            "windows": windows,
        }))?,
    )?;
    let mut md = String::new();
    use std::fmt::Write as _;
    let _ = writeln!(md, "# Worst clips, client c{client:02}\n");
    let _ = writeln!(
        md,
        "Panes left to right: truth, {}. Loose pieces are tinted magenta by their on-screen error (2 px none, 24 px full). Penalty is the scorecard's, inside the window.\n",
        runs.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
    );
    let _ = write!(md, "| clip | window s | worst for |");
    for r in runs {
        let _ = write!(md, " {} penalty | {} top classes |", r.name, r.name);
    }
    let _ = writeln!(md);
    let _ = writeln!(md, "|---|---|---|{}", "---:|---|".repeat(runs.len()));
    for (i, w) in windows.iter().enumerate() {
        let _ = write!(md, "| clip-{i:02} | {:.2}..{:.2} | {} |", w.start_s, w.end_s, w.chosen_for);
        for r in runs {
            let classes = w.classes[&r.name].iter().map(|(c, p)| format!("{c} {p:.2}")).collect::<Vec<_>>().join(", ");
            let _ = write!(md, " {:.2} | {} |", w.penalty[&r.name], classes);
        }
        let _ = writeln!(md);
    }
    std::fs::write(out.join("clips.md"), md)
}

pub(crate) fn mix(a: [f32; 3], b: [f32; 3], k: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

fn hash(x: u32) -> u32 {
    let mut h = x.wrapping_mul(0x9E37_79B1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85EB_CA77);
    h ^ (h >> 13)
}

/// Standing: a muted tone per structure. Loose: a bright hue per chunk.
pub(crate) fn chunk_colour(slot: u32, structure: u32, standing: bool) -> [f32; 3] {
    if standing {
        let h = hash(structure);
        let v = 150.0 + (h & 31) as f32;
        return [v, v * 0.93, v * 0.84];
    }
    let hue = (hash(slot) % 360) as f32;
    hsv(hue, 0.65, 0.95)
}

fn hsv(h: f32, s: f32, v: f32) -> [f32; 3] {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [(r + m) * 255.0, (g + m) * 255.0, (b + m) * 255.0]
}

/// A colour and depth buffer for one pane.
pub(crate) struct Canvas {
    width: usize,
    height: usize,
    rgb: Vec<[u8; 3]>,
    depth: Vec<f32>,
}

const LIGHT: Vec3 = Vec3::new(0.35, 0.85, 0.4);

impl Canvas {
    pub(crate) fn new(width: usize, height: usize) -> Self {
        Self { width, height, rgb: vec![[0; 3]; width * height], depth: vec![f32::INFINITY; width * height] }
    }

    /// Sky above the horizon, a ground plane at y = 0 below it (fogged
    /// with distance, with a 10 m grid so camera motion reads).
    pub(crate) fn clear(&mut self, camera: &Camera) {
        self.depth.fill(f32::INFINITY);
        let forward = camera.direction.normalize_or_zero();
        let reference_up = if forward.dot(Vec3::Y).abs() > 0.99 { Vec3::X } else { Vec3::Y };
        let right = forward.cross(reference_up).normalize_or_zero();
        let up = right.cross(forward).normalize_or_zero();
        let focal = self.height as f32 * 0.5 / (camera.fov_degrees.max(1.0).to_radians() * 0.5).tan();
        let (hw, hh) = (self.width as f32 * 0.5, self.height as f32 * 0.5);
        for y in 0..self.height {
            for x in 0..self.width {
                let ray = (forward * focal + right * (x as f32 + 0.5 - hw) + up * (hh - y as f32 - 0.5)).normalize();
                let colour = if ray.y < -1e-4 && camera.eye.y > 0.0 {
                    let s = camera.eye.y / -ray.y;
                    let hit = camera.eye + ray * s;
                    let line = |v: f32| {
                        let f = (v / 10.0).rem_euclid(1.0);
                        f.min(1.0 - f) * 10.0 < 0.06 * (1.0 + s / 60.0)
                    };
                    let base = if line(hit.x) || line(hit.z) { [88.0, 96.0, 84.0] } else { [108.0, 118.0, 100.0] };
                    let fog = (s / 400.0).clamp(0.0, 1.0);
                    mix(base, [190.0, 205.0, 220.0], fog)
                } else {
                    let k = ray.y.clamp(0.0, 1.0);
                    mix([190.0, 205.0, 220.0], [110.0, 150.0, 205.0], k)
                };
                self.rgb[y * self.width + x] = [colour[0] as u8, colour[1] as u8, colour[2] as u8];
            }
        }
    }

    pub(crate) fn draw_box(&mut self, projector: &Projector, camera: &Camera, position: Vec3, rotation: Quat, half: Vec3, colour: [f32; 3]) {
        if !projector.sphere_on_screen(position, half.length()) {
            return;
        }
        let corners = box_corners(position, rotation, half);
        let (hw, hh) = (self.width as f32 * 0.5, self.height as f32 * 0.5);
        let projected: Vec<Option<(glam::Vec2, f32)>> =
            corners.iter().map(|c| projector.project(*c).map(|(p, d)| (glam::Vec2::new(p.x + hw, hh - p.y), d))).collect();
        // Faces as corner quads (bit order x, y, z) and their normals.
        const FACES: [([usize; 4], Vec3); 6] = [
            ([0, 1, 3, 2], Vec3::NEG_Z),
            ([4, 6, 7, 5], Vec3::Z),
            ([0, 4, 5, 1], Vec3::NEG_Y),
            ([2, 3, 7, 6], Vec3::Y),
            ([0, 2, 6, 4], Vec3::NEG_X),
            ([1, 5, 7, 3], Vec3::X),
        ];
        for (face, normal) in FACES {
            let n = rotation * normal;
            let centre = position + n * (half * normal).abs().max_element();
            if n.dot(camera.eye - centre) <= 0.0 {
                continue;
            }
            let shade = 0.45 + 0.55 * n.dot(LIGHT.normalize()).max(0.0);
            let c = [(colour[0] * shade) as u8, (colour[1] * shade) as u8, (colour[2] * shade) as u8];
            let quad: Vec<_> = face.iter().filter_map(|&i| projected[i]).collect();
            if quad.len() >= 3 {
                self.triangle(c, quad[0], quad[1], quad[2]);
                if quad.len() == 4 {
                    self.triangle(c, quad[0], quad[2], quad[3]);
                }
            }
        }
    }

    fn triangle(&mut self, colour: [u8; 3], a: (glam::Vec2, f32), b: (glam::Vec2, f32), c: (glam::Vec2, f32)) {
        let min_x = a.0.x.min(b.0.x).min(c.0.x).floor().max(0.0) as i64;
        let max_x = a.0.x.max(b.0.x).max(c.0.x).ceil().min(self.width as f32 - 1.0) as i64;
        let min_y = a.0.y.min(b.0.y).min(c.0.y).floor().max(0.0) as i64;
        let max_y = a.0.y.max(b.0.y).max(c.0.y).ceil().min(self.height as f32 - 1.0) as i64;
        if min_x > max_x || min_y > max_y {
            return;
        }
        let edge = |p: glam::Vec2, q: glam::Vec2, r: glam::Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        let area = edge(a.0, b.0, c.0);
        if area.abs() < 1e-6 {
            return;
        }
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let p = glam::Vec2::new(x as f32 + 0.5, y as f32 + 0.5);
                let w0 = edge(b.0, c.0, p) / area;
                let w1 = edge(c.0, a.0, p) / area;
                let w2 = edge(a.0, b.0, p) / area;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                let depth = w0 * a.1 + w1 * b.1 + w2 * c.1;
                let i = y as usize * self.width + x as usize;
                if depth < self.depth[i] {
                    self.depth[i] = depth;
                    self.rgb[i] = colour;
                }
            }
        }
    }

    /// Copy into pane `index` of row `row` of a grid `panes` wide.
    pub(crate) fn blit(&self, canvas: &mut [u8], panes: usize, row: usize, index: usize) {
        let stride = panes * self.width * 3;
        for y in 0..self.height {
            let row = &mut canvas[(row * self.height + y) * stride + index * self.width * 3..][..self.width * 3];
            for x in 0..self.width {
                row[x * 3..x * 3 + 3].copy_from_slice(&self.rgb[y * self.width + x]);
            }
        }
    }
}
