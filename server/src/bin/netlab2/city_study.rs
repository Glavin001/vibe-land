//! Calibration study stimuli (milestone 5): real truth from a city capture,
//! with one artifact injected at known magnitudes into one body, rendered
//! from a lab client's eye.
//!
//!     netlab2 city-study --capture <capture dir> --out <dir>
//!         [--windows 2] [--levels 0.25,0.5,1,2,4]
//!         [--classes pop,screen_error,smoothness,contact_timing,cause_effect]
//!         [--width 1280] [--seed 1]
//!
//! Per class it picks `--windows` three-second windows where a suitable body
//! is most prominent, and renders, per window, one clip of the untouched
//! truth and one per level with the artifact injected (`study.json` lists
//! them). The study page shows the truth and one test clip in random order
//! and asks which looked wrong; `scripts/netlab/fit-calibration.py` fits each
//! class's threshold and slope from the answers.
//!
//! The injections, on the chosen body only (every other chunk is truth):
//! - `pop` (px): a persistent jump of that size at 1.5 s, across the screen.
//! - `screen_error` (px): the same offset held for the whole window.
//! - `smoothness` (px rms): a fresh random offset every frame, so the
//!   frame-to-frame step error has that rms.
//! - `contact_timing` (ms): the body shown that late through a contact.
//! - `cause_effect` (frames): a freshly broken piece shown that many frames
//!   late, so it stays attached after the break and then follows.
//!
//! Pixel magnitudes are on a 1080-line pane of the presented view (the
//! scorer's unit). The presented view is a spectator to the side of the
//! body's path (away from the scene's centre, 6 m up, at least 20 m back and
//! far enough that the whole path stays in view) looking at its middle, with a ring round the body for the first 0.6 s of every clip
//! (at where that clip draws it) so the inspector knows what to watch,
//! zoomed until it is about 60 px tall; the page records the size the video
//! was actually shown at, so the fit can rescale. The body is debris-sized
//! (0.25-2.5 m) and moving for most of the window.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use glam::Vec3;

use vibe_land_destruction::ids;
use vibe_land_destruction::netlab::cameras::SceneExtent;
use vibe_land_destruction::perception::{PerceptualModel, Projector};
use vibe_land_destruction::types::Camera;

use crate::chunks::ChunkTruth;
use crate::city_clips::{chunk_colour, Canvas, FFMPEG, FONT};
use crate::city_lab::CityCapture;
use crate::city_perceptual::slot_table;
use crate::{die, Args};

const WINDOW_S: f32 = 3.0;
/// Where in the window the event the class needs should fall.
const EVENT_FROM_S: f32 = 0.8;
const EVENT_TO_S: f32 = 2.2;
/// When a pop happens.
const POP_AT_S: f32 = 1.5;
/// How tall the body is drawn in the presented view (1080-line pane).
const TARGET_PX: f32 = 60.0;
/// A contact: acceleration this far from gravity's (m/s^2).
const CONTACT_ACCEL: f32 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Class {
    Pop,
    ScreenError,
    Smoothness,
    ContactTiming,
    CauseEffect,
}

impl Class {
    fn parse(name: &str) -> Self {
        match name {
            "pop" => Class::Pop,
            "screen_error" => Class::ScreenError,
            "smoothness" => Class::Smoothness,
            "contact_timing" => Class::ContactTiming,
            "cause_effect" => Class::CauseEffect,
            _ => die(&format!("unknown class {name}")),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Class::Pop => "pop",
            Class::ScreenError => "screen_error",
            Class::Smoothness => "smoothness",
            Class::ContactTiming => "contact_timing",
            Class::CauseEffect => "cause_effect",
        }
    }
}

/// The presented view's field of view before zooming.
const BASE_FOV: f32 = 60.0;
/// A body counts as moving above this speed (m/s).
const MOVING: f32 = 1.0;

/// What the scan learnt about one truth body.
#[derive(Default)]
struct BodyScan {
    born: u32,
    /// Its largest chunk's bounding radius (m).
    radius: f32,
    /// tick -> (centre, speed) while loose.
    seen: BTreeMap<u32, (Vec3, f32)>,
    contacts: Vec<u32>,
}

#[derive(Clone, Debug, serde::Serialize)]
struct Window {
    id: String,
    class: &'static str,
    unit: String,
    start_tick: u32,
    end_tick: u32,
    body: u32,
    /// The event the class is about (pop step, contact, birth), tick.
    event_tick: u32,
    zoom: f32,
    eye: [f32; 3],
    aim: [f32; 3],
    fov: f32,
    truth_clip: String,
    tests: Vec<Test>,
}

#[derive(Clone, Debug, serde::Serialize)]
struct Test {
    level: f64,
    magnitude: f64,
    clip: String,
}

pub fn cmd_city_study(args: &Args) {
    let capture = CityCapture::open(&args.path("capture")).unwrap_or_else(|e| die(&format!("--capture: {e}")));
    let out = args.path("out");
    std::fs::create_dir_all(&out).unwrap_or_else(|e| die(&format!("{}: {e}", out.display())));
    let windows_per_class: usize = args.get("windows").map_or(2, |v| v.parse().unwrap_or_else(|_| die("--windows N")));
    let levels: Vec<f64> = args
        .get("levels")
        .unwrap_or("0.25,0.5,1,2,4")
        .split(',')
        .map(|v| v.parse().unwrap_or_else(|_| die("--levels a,b,c")))
        .collect();
    let classes: Vec<Class> = args
        .get("classes")
        .unwrap_or("pop,screen_error,smoothness,contact_timing,cause_effect")
        .split(',')
        .map(Class::parse)
        .collect();
    let width: usize = args.get("width").map_or(1280, |v| v.parse().unwrap_or_else(|_| die("--width PX")));
    let seed: u64 = args.get("seed").map_or(1, |v| v.parse().unwrap_or_else(|_| die("--seed N")));
    let model = PerceptualModel::literature();

    eprintln!("scanning the capture for bodies worth looking at");
    let (scan, hz) = scan(&capture).unwrap_or_else(|e| die(&format!("scan: {e}")));
    let centre = SceneExtent::of(&capture.manifest).centre();
    let mut windows = Vec::new();
    for &class in &classes {
        let picked = pick_windows(&scan, class, windows_per_class, hz);
        if picked.len() < windows_per_class {
            eprintln!("{}: only {} suitable windows", class.name(), picked.len());
        }
        let theta = model.classes[class.name()].theta;
        let unit = model.classes[class.name()].unit.clone();
        for (i, (start, body, event)) in picked.into_iter().enumerate() {
            let id = format!("{}-{i}", class.name());
            // A spectator outside the body, zoomed so it is about
            // TARGET_PX tall.
            let b = &scan[&body];
            let centres: Vec<Vec3> = b.seen.range(start..start + (WINDOW_S * hz as f32) as u32).map(|(_, v)| v.0).collect();
            // Aim at the middle of its path, far enough back that the whole
            // path stays in view.
            let (lo, hi) = centres.iter().fold((Vec3::splat(f32::MAX), Vec3::splat(f32::MIN)), |(lo, hi), c| (lo.min(*c), hi.max(*c)));
            let aim = (lo + hi) * 0.5;
            let half = centres.iter().map(|c| c.distance(aim)).fold(0.0f32, f32::max) + b.radius;
            let tan_half = (BASE_FOV.to_radians() * 0.5).tan();
            let back = (half * 1.3 / tan_half).max(20.0);
            // Side-on to its path (so it crosses the view rather than
            // coming at the lens), on the side away from the scene's centre.
            let outward = Vec3::new(aim.x - centre.x, 0.0, aim.z - centre.z).try_normalize().unwrap_or(Vec3::Z);
            let travel = centres.last().copied().unwrap_or(aim) - centres.first().copied().unwrap_or(aim);
            let side = Vec3::Y.cross(Vec3::new(travel.x, 0.0, travel.z)).try_normalize().unwrap_or(outward);
            let side = if side.dot(outward) < 0.0 { -side } else { side };
            let eye = aim + side * back + Vec3::Y * 6.0;
            let depth = (aim - eye).length();
            let base_focal = 540.0 / (BASE_FOV.to_radians() * 0.5).tan();
            let height_px = 2.0 * b.radius * base_focal / depth;
            let fits = (tan_half * depth / (half * 1.15)).max(1.0);
            let zoom = (TARGET_PX / height_px.max(1.0)).clamp(1.0, fits.min(8.0));
            let fov = (2.0 * ((BASE_FOV.to_radians() * 0.5).tan() / zoom).atan()).to_degrees();
            let tests = levels
                .iter()
                .enumerate()
                .map(|(k, &level)| {
                    let mut magnitude = theta * level;
                    if class == Class::CauseEffect {
                        magnitude = magnitude.round().max(1.0);
                    }
                    Test { level, magnitude, clip: format!("{id}-L{k}.mp4") }
                })
                .collect();
            windows.push(Window {
                id: id.clone(),
                class: class.name(),
                unit: unit.clone(),
                start_tick: start,
                end_tick: start + (WINDOW_S * hz as f32) as u32,
                body,
                event_tick: event,
                zoom,
                eye: eye.to_array(),
                aim: aim.to_array(),
                fov,
                truth_clip: format!("{id}-truth.mp4"),
                tests,
            });
        }
    }
    windows.sort_by_key(|w| w.start_tick);
    for window in &windows {
        eprintln!(
            "{}: ticks {}..{} body {} event {} zoom {:.1}",
            window.id, window.start_tick, window.end_tick, window.body, window.event_tick, window.zoom
        );
        render_window(&capture, hz, window, &out, width, seed).unwrap_or_else(|e| die(&format!("{}: {e}", window.id)));
    }
    std::fs::write(
        out.join("study.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "format": "vibe-land calibration study 1",
            "capture": capture.dir,
            "base_fov": BASE_FOV,
            "pane_lines": 1080,
            "window_s": WINDOW_S,
            "seed": seed,
            "model": model,
            "windows": windows,
        }))
        .expect("json"),
    )
    .unwrap_or_else(|e| die(&format!("study.json: {e}")));
    eprintln!("{} windows, {} clips in {}", windows.len(), windows.iter().map(|w| w.tests.len() + 1).sum::<usize>(), out.display());
}

fn scan(capture: &CityCapture) -> std::io::Result<(HashMap<u32, BodyScan>, u32)> {
    let hz = capture.meta.hz.max(1);
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let slots = slot_table(&capture.manifest);
    let first = capture.meta.first_tick.unwrap_or(0);
    let last = capture.meta.last_tick.unwrap_or(first);
    let mut bodies: HashMap<u32, BodyScan> = HashMap::new();
    let mut history: HashMap<u32, [Vec3; 3]> = HashMap::new();
    let dt = 1.0 / hz as f32;
    let g = Vec3::new(0.0, -(vibe_netcode::movement::GRAVITY as f32), 0.0);
    for tick in first..=last {
        truth.advance_to(tick)?;
        // Per loose body: its chunks' centre and largest radius this tick.
        let mut parts: HashMap<u32, (Vec3, u32, f32)> = HashMap::new();
        for slot in 0..slots.len() as u32 {
            let Some(c) = truth.chunk_at(slot, tick as f32) else { continue };
            if ids::body_entity_parts(c.key).1 == 0 || c.settled {
                continue;
            }
            let e = parts.entry(c.key).or_insert((Vec3::ZERO, 0, 0.0));
            e.0 += c.position;
            e.1 += 1;
            e.2 = e.2.max(slots[slot as usize].half_extents.length());
        }
        for (key, (sum, n, radius)) in parts {
            let centre = sum / n as f32;
            let body = bodies.entry(key).or_insert_with(|| BodyScan { born: tick, ..Default::default() });
            body.radius = body.radius.max(radius * (n as f32).cbrt());
            let h = history.entry(key).or_insert([centre; 3]);
            *h = [h[1], h[2], centre];
            let accel = (h[2] - 2.0 * h[1] + h[0]) / (dt * dt);
            if tick > body.born + 2 && (accel - g).length() > CONTACT_ACCEL {
                body.contacts.push(tick);
            }
            body.seen.insert(tick, (centre, (h[2] - h[1]).length() / dt));
        }
        truth.trim(tick);
    }
    Ok((bodies, hz))
}

/// The best (start tick, body, event tick) windows for a class: a
/// debris-sized body loose and moving for as much of the window (from its
/// event, for a break) as possible.
fn pick_windows(scan: &HashMap<u32, BodyScan>, class: Class, count: usize, hz: u32) -> Vec<(u32, u32, u32)> {
    let span = (WINDOW_S * hz as f32) as u32;
    let (from, to) = ((EVENT_FROM_S * hz as f32) as u32, (EVENT_TO_S * hz as f32) as u32);
    let mut candidates: Vec<(f32, u32, u32, u32)> = Vec::new();
    let mut keys: Vec<&u32> = scan.keys().collect();
    keys.sort();
    for &key in keys {
        let body = &scan[&key];
        if !(0.25..=2.5).contains(&body.radius) {
            continue;
        }
        let events: Vec<u32> = match class {
            Class::ContactTiming => body.contacts.clone(),
            Class::CauseEffect => vec![body.born],
            _ => body.seen.keys().copied().step_by((hz / 2).max(1) as usize).collect(),
        };
        for event in events {
            let start = match class {
                Class::Pop | Class::ScreenError | Class::Smoothness => event,
                _ => event.saturating_sub((from + to) / 2),
            };
            let event_tick = match class {
                Class::Pop => start + (POP_AT_S * hz as f32) as u32,
                Class::ScreenError | Class::Smoothness => start,
                _ => event,
            };
            if matches!(class, Class::ContactTiming | Class::CauseEffect)
                && !(start + from..=start + to).contains(&event_tick)
            {
                continue;
            }
            // Loose for 80% of the window (of what follows a break), and
            // moving for most of that.
            let counted_from = if class == Class::CauseEffect { event } else { start };
            let needed = (start + span).saturating_sub(counted_from);
            let loose: Vec<f32> = body.seen.range(counted_from..start + span).map(|(_, v)| v.1).collect();
            if (loose.len() as f32) < needed as f32 * 0.8 {
                continue;
            }
            let moving = loose.iter().filter(|&&v| v > MOVING).count() as f32 / loose.len().max(1) as f32;
            if moving < 0.5 {
                continue;
            }
            candidates.push((moving * loose.len() as f32 / needed.max(1) as f32, start, key, event_tick));
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut picked: Vec<(u32, u32, u32)> = Vec::new();
    for (_, start, key, event) in candidates {
        if picked.len() >= count {
            break;
        }
        // Distinct moments: windows at least a window apart.
        if picked.iter().any(|&(s, _, _)| s.abs_diff(start) < span) {
            continue;
        }
        picked.push((start, key, event));
    }
    picked
}

/// How long the cue ring shows, s.
const CUE_S: f32 = 0.6;

/// A white ring, 2 px wide, centred at (cx, cy) in image pixels.
fn ring(frame: &mut [u8], width: usize, height: usize, cx: f32, cy: f32, r: f32) {
    let (x0, x1) = ((cx - r - 2.0).floor().max(0.0) as usize, ((cx + r + 2.0).ceil() as usize).min(width.saturating_sub(1)));
    let (y0, y1) = ((cy - r - 2.0).floor().max(0.0) as usize, ((cy + r + 2.0).ceil() as usize).min(height.saturating_sub(1)));
    for y in y0..=y1 {
        for x in x0..=x1 {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if (d - r).abs() <= 1.0 {
                frame[(y * width + x) * 3..][..3].copy_from_slice(&[255, 255, 255]);
            }
        }
    }
}

/// Deterministic normal deviates (Box-Muller over a splitmix64 stream).
struct Noise(u64);

impl Noise {
    fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    }

    fn normal(&mut self) -> f32 {
        let u = self.next_f32().max(1e-7);
        let v = self.next_f32();
        (-2.0 * u.ln()).sqrt() * (std::f32::consts::TAU * v).cos()
    }
}

#[allow(clippy::too_many_arguments)]
fn render_window(
    capture: &CityCapture,
    hz: u32,
    window: &Window,
    out: &Path,
    width: usize,
    seed: u64,
) -> std::io::Result<()> {
    let height = width * 9 / 16;
    let slots = slot_table(&capture.manifest);
    let mut structure_of: Vec<u32> = Vec::with_capacity(slots.len());
    for structure in &capture.manifest.structures {
        let n = structure.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0);
        structure_of.extend(std::iter::repeat(structure.structure_id).take(n as usize));
    }
    let class = Class::parse(window.class);
    // Time shifts reach back up to the largest lag.
    let max_lag_ticks = window
        .tests
        .iter()
        .map(|t| match class {
            Class::ContactTiming => t.magnitude as f32 / 1000.0 * hz as f32,
            Class::CauseEffect => t.magnitude as f32 * hz as f32 / 60.0,
            _ => 0.0,
        })
        .fold(0.0f32, f32::max);
    // The body's slots: its members at any tick of the window.
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let mut members: Vec<u32> = Vec::new();
    for tick in window.start_tick.saturating_sub(max_lag_ticks.ceil() as u32 + 1)..window.end_tick {
        truth.advance_to(tick)?;
        if tick >= window.start_tick {
            for slot in 0..slots.len() as u32 {
                if truth.key_at(slot, tick) == window.body && !members.contains(&slot) {
                    members.push(slot);
                }
            }
        }
    }
    let view = Camera {
        eye: Vec3::from_array(window.eye),
        direction: (Vec3::from_array(window.aim) - Vec3::from_array(window.eye)).normalize_or_zero(),
        fov_degrees: window.fov,
    };
    // Render from a fresh truth: the clips need the past the scan trimmed.
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let label = |text: &str| {
        format!(
            "drawtext=fontfile={FONT}:text='{text}':x=12:y=12:fontsize={}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=6",
            height / 24
        )
    };
    let spawn = |path: &Path, text: &str| -> std::io::Result<std::process::Child> {
        Command::new(FFMPEG)
            .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s"])
            .arg(format!("{width}x{height}"))
            .args(["-r"])
            .arg(format!("{hz}"))
            .args(["-i", "-", "-vf"])
            .arg(label(text))
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart"])
            .arg(path)
            .stdin(Stdio::piped())
            .spawn()
    };
    let mut clips: Vec<std::process::Child> = Vec::new();
    clips.push(spawn(&out.join(&window.truth_clip), " ")?);
    for test in &window.tests {
        clips.push(spawn(&out.join(&test.clip), " ")?);
    }
    let mut canvas = Canvas::new(width, height);
    let mut frame = vec![0u8; width * height * 3];
    let mut noise: Vec<Noise> = (0..window.tests.len()).map(|k| Noise(seed ^ (window.start_tick as u64) << 8 ^ k as u64)).collect();
    let side = if (window.start_tick ^ window.body) & 1 == 0 { 1.0 } else { -1.0 };
    for tick in window.start_tick.saturating_sub(max_lag_ticks.ceil() as u32 + 1)..window.end_tick {
        truth.advance_to(tick)?;
        if tick < window.start_tick {
            continue;
        }
        let projector = Projector::new(view, (width as u32, height as u32));
        let pane = Projector::new(view, (1920, 1080));
        let forward = view.direction;
        let right = forward.cross(Vec3::Y).normalize_or_zero();
        let up = right.cross(forward).normalize_or_zero();
        let t = (tick - window.start_tick) as f32 / hz as f32;
        // Metres per pane pixel at the body's depth now.
        let body_depth = members
            .iter()
            .filter_map(|&s| truth.chunk_at(s, tick as f32))
            .map(|c| (c.position - view.eye).dot(forward))
            .fold(f32::NAN, |a, d| if a.is_nan() { d } else { a.min(d) });
        let metres_per_px = if body_depth.is_finite() { body_depth.max(0.5) / pane.focal_px() } else { 0.0 };
        for (clip, child) in clips.iter_mut().enumerate() {
            // clip 0 is the truth; clip k is test k - 1.
            let test = clip.checked_sub(1).map(|k| &window.tests[k]);
            let (offset, lag) = match (test, class) {
                (None, _) => (Vec3::ZERO, 0.0),
                (Some(test), Class::Pop) => {
                    let on = t >= POP_AT_S;
                    (if on { right * side * test.magnitude as f32 * metres_per_px } else { Vec3::ZERO }, 0.0)
                }
                (Some(test), Class::ScreenError) => (right * side * test.magnitude as f32 * metres_per_px, 0.0),
                (Some(test), Class::Smoothness) => {
                    // Per axis sigma/2: the frame-to-frame step has rms ~sigma.
                    let n = &mut noise[clip - 1];
                    let s = test.magnitude as f32 * 0.5 * metres_per_px;
                    (right * n.normal() * s + up * n.normal() * s, 0.0)
                }
                (Some(test), Class::ContactTiming) => (Vec3::ZERO, test.magnitude as f32 / 1000.0 * hz as f32),
                (Some(test), Class::CauseEffect) => (Vec3::ZERO, test.magnitude as f32 * hz as f32 / 60.0),
            };
            canvas.clear(&view);
            for slot in 0..slots.len() as u32 {
                let manipulated = test.is_some() && members.contains(&slot);
                let at = if manipulated { tick as f32 - lag } else { tick as f32 };
                let Some(c) = truth.chunk_at(slot, at) else { continue };
                let standing = ids::body_entity_parts(c.key).1 == 0;
                let colour = chunk_colour(slot, structure_of[slot as usize], standing);
                let position = if manipulated { c.position + offset } else { c.position };
                canvas.draw_box(&projector, &view, position, c.rotation, slots[slot as usize].half_extents, colour);
            }
            canvas.blit(&mut frame, 1, 0, 0);
            if t < CUE_S {
                // The cue: a ring round the body as this clip draws it.
                let drawn: Vec<(Vec3, f32)> = members
                    .iter()
                    .filter_map(|&s| {
                        let at = if test.is_some() { tick as f32 - lag } else { tick as f32 };
                        let c = truth.chunk_at(s, at)?;
                        Some((if test.is_some() { c.position + offset } else { c.position }, slots[s as usize].half_extents.length()))
                    })
                    .collect();
                if !drawn.is_empty() {
                    let centre = drawn.iter().map(|d| d.0).sum::<Vec3>() / drawn.len() as f32;
                    let radius = drawn.iter().map(|d| d.0.distance(centre) + d.1).fold(0.0f32, f32::max);
                    if let Some((p, depth)) = projector.project(centre) {
                        let r = radius * projector.focal_px() / depth + 12.0;
                        ring(&mut frame, width, height, p.x + width as f32 * 0.5, height as f32 * 0.5 - p.y, r);
                    }
                }
            }
            child.stdin.as_mut().expect("ffmpeg stdin").write_all(&frame)?;
        }
        truth.trim(tick.saturating_sub(max_lag_ticks.ceil() as u32 + 2));
    }
    for mut child in clips {
        drop(child.stdin.take());
        if !child.wait()?.success() {
            return Err(std::io::Error::other("ffmpeg failed"));
        }
    }
    Ok(())
}
