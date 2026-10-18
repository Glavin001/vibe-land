//! A recorded live session through the lab's eyes: what a real player's
//! client drew, from the packets it actually received, when it actually
//! received them, against the server's truth at the server's actual tick
//! times.
//!
//!     netlab2 city-live --bundle <debug-reports/session-...> [--player <id>] --out <dir>
//!
//! The lab's own runs tick the server at an exact 60 Hz; a live server does
//! not. When a tick overruns its budget the truth itself advances in slow
//! motion, and the client's render clock has to follow it. This replays the
//! session's client tape (`client.vltape`: arrival-ordered packets) through
//! the per-player client core (`city_pp_stage`, the same core the browser
//! runs as WASM), with the frame clock mapped to the server's recorded tick
//! times (`server/ticks.jsonl`, via the tape's pairing clock samples), and
//! scores the result like any lab run.
//!
//! Output (a run directory `city-clips`/`city-pairs` can read):
//! - `c00/lab.vltape` (the live tape), `c00/stream.json`, `c00/drawn-chunks.bin`;
//! - `scorecard.json`: the perceptual report;
//! - `clock.json` and `clock.md`: the server's tick cadence and the client's
//!   render clock against wall time (`render_clock` below).

use std::path::{Path, PathBuf};

use serde_json::json;

use vibe_land_destruction::netlab::cameras::{CameraSpec, ClientSpec};
use vibe_land_destruction::perception::PerceptualModel;
use vibe_land_destruction::per_player::PerPlayerConfig;

use crate::chunks::ChunkReader;
use crate::city_lab::{client_dir, CityCapture};
use crate::vltape::ClientTape;
use crate::{die, Args};

pub fn cmd_city_live(args: &Args) {
    let bundle = PathBuf::from(args.get("bundle").unwrap_or_else(|| die("--bundle <session dir> is required")));
    let out = PathBuf::from(args.get("out").unwrap_or_else(|| die("--out <dir> is required")));
    let server = if bundle.join("server").is_dir() { bundle.join("server") } else { bundle.clone() };
    let capture = CityCapture::open(&server.join(crate::session_capture::CITY_DIR)).unwrap_or_else(|e| die(&format!("capture: {e}")));
    let tape_path = bundle.join("client.vltape");
    let tape = ClientTape::read(&tape_path).unwrap_or_else(|e| die(&format!("{}: {e}", tape_path.display())));
    let player: u32 = args
        .get("player")
        .map(|p| p.parse().unwrap_or_else(|_| die("--player <id>")))
        .unwrap_or_else(|| tape.header["localPlayerId"].as_u64().unwrap_or(1) as u32);

    // Server tick -> tape clock (ms): each tick's wall time from the server's
    // tick log, placed on the tape's clock by the pairing samples.
    let ticks = read_ticks(&server.join("ticks.jsonl")).unwrap_or_else(|e| die(&format!("ticks.jsonl: {e}")));
    let origin = tape.header["clockOriginMs"].as_f64().unwrap_or(0.0);
    let samples = tape.header["pairing"]["clockSamples"].as_array().cloned().unwrap_or_default();
    // Offset from server unix time to tape time, from the sample with the
    // shortest round trip (its midpoint is the best estimate).
    let offset_ms = samples
        .iter()
        .filter_map(|s| {
            let (sent, received, unix) = (s["sentPerfMs"].as_f64()?, s["receivedPerfMs"].as_f64()?, s["serverUnixUs"].as_f64()?);
            Some((received - sent, (sent + received) * 0.5 - origin - unix / 1000.0))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, offset)| offset)
        .unwrap_or_else(|| die("the tape has no pairing clock samples"));
    let timeline: Vec<(u32, f64)> = ticks
        .iter()
        .filter(|(t, _)| *t >= capture.meta.first_tick.unwrap_or(0) && *t <= capture.meta.last_tick.unwrap_or(u32::MAX))
        .map(|&(t, unix_us)| (t, unix_us / 1000.0 + offset_ms))
        .collect();
    if timeline.is_empty() {
        die("no server ticks overlap the capture");
    }

    let dir = client_dir(&out, 0);
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| die(&format!("{}: {e}", dir.display())));
    std::fs::copy(&tape_path, dir.join("lab.vltape")).unwrap_or_else(|e| die(&format!("copy tape: {e}")));
    let camera = CameraSpec::parse(&format!("player:{player}")).unwrap_or_else(|e| die(&e));
    let spec = ClientSpec { id: 0, camera, profile: "live".into() };
    std::fs::write(dir.join("stream.json"), serde_json::to_vec_pretty(&json!({"client": spec})).unwrap())
        .unwrap_or_else(|e| die(&format!("stream.json: {e}")));
    let config = PerPlayerConfig::validated(capture.meta.hz.max(1));
    crate::city_pp_stage::run(&dir, &capture.manifest, config, &timeline).unwrap_or_else(|e| die(&format!("client stage: {e}")));

    let report = crate::city_perceptual::evaluate_client(
        &dir.join(crate::chunks::CHUNKS_FILE),
        &capture.tape_path(),
        &capture.manifest,
        capture.checkpoint.as_ref(),
        &spec.camera,
        &capture.tracks,
        timeline[0].1,
        PerceptualModel::literature(),
        None,
    )
    .unwrap_or_else(|e| die(&format!("score: {e}")));
    let clock = render_clock(&dir.join(crate::chunks::CHUNKS_FILE), &timeline).unwrap_or_else(|e| die(&format!("clock: {e}")));
    let cadence = tick_cadence(&timeline);
    std::fs::write(
        out.join("scorecard.json"),
        serde_json::to_vec_pretty(&json!({
            "spec": {"strategy": "per-player (live tape)", "bucket": null, "capture": capture.dir.display().to_string()},
            "hz": capture.meta.hz,
            "clients": [{"id": 0, "camera": spec.camera, "perceptual": report}],
            "penalty_per_minute_mean": report.penalty_per_minute,
        }))
        .unwrap(),
    )
    .unwrap_or_else(|e| die(&format!("scorecard: {e}")));
    std::fs::write(out.join("clock.json"), serde_json::to_vec_pretty(&json!({"server": cadence, "render": clock})).unwrap())
        .unwrap_or_else(|e| die(&format!("clock.json: {e}")));
    let md = clock_markdown(&cadence, &clock);
    std::fs::write(out.join("clock.md"), &md).unwrap_or_else(|e| die(&format!("clock.md: {e}")));
    println!("{md}");
    println!("perceptual penalty per minute: {:.0}", report.penalty_per_minute);
}

fn read_ticks(path: &Path) -> std::io::Result<Vec<(u32, f64)>> {
    let text = std::fs::read_to_string(path)?;
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| Some((v["tick"].as_u64()? as u32, v["unix_us"].as_f64()?)))
        .collect())
}

/// The server's tick cadence: per second of the session, ticks completed and
/// the longest gap between two ticks.
fn tick_cadence(timeline: &[(u32, f64)]) -> serde_json::Value {
    let t0 = timeline[0].1;
    let mut seconds: Vec<(u32, f64)> = Vec::new();
    for w in timeline.windows(2) {
        let s = ((w[1].1 - t0) / 1000.0).floor() as usize;
        if seconds.len() <= s {
            seconds.resize(s + 1, (0, 0.0));
        }
        seconds[s].0 += 1;
        seconds[s].1 = seconds[s].1.max(w[1].1 - w[0].1);
    }
    json!(seconds.iter().enumerate().map(|(s, (n, gap))| json!({"second": s, "ticks": n, "max_gap_ms": gap})).collect::<Vec<_>>())
}

/// The client's render clock against wall time: each drawn frame's render
/// tick (what moment of the simulation it showed) and when it was drawn.
/// A viewer sees motion in wall time, so the shown simulation time must
/// advance smoothly: a frame that shows no advance (a stall), or a burst
/// after one, is a visible hitch whatever the poses' accuracy at their own
/// tick. The spatial scorer cannot see this: it compares each frame with the
/// truth at that frame's own render tick.
fn render_clock(chunks: &Path, timeline: &[(u32, f64)]) -> std::io::Result<serde_json::Value> {
    let mut reader = ChunkReader::open(chunks)?;
    let mut frames: Vec<(f64, f32)> = Vec::new();
    while let Some(frame) = reader.next_frame()? {
        if frame.render_tick >= 0.0 {
            frames.push((frame.sample_ms, frame.render_tick - frame.playout_delay_ticks));
        }
    }
    let t0 = timeline[0].1;
    let tick_ms = 1000.0 / 60.0;
    // Per second: the shown simulation's rate against wall time (1 = real
    // time), frames that showed no advance, and the largest single advance.
    let mut per_second: Vec<(f64, f64, u32, f32, u32)> = Vec::new();
    // Lead: how far each frame's shown tick is past the newest tick the
    // server had finished when it was drawn (positive: drawn from
    // prediction alone, ahead of any data).
    let mut lead: Vec<f32> = Vec::new();
    for &(ms, render) in &frames {
        let s = ((ms - t0) / 1000.0).floor().max(0.0) as usize;
        let done = timeline.partition_point(|&(_, at)| at <= ms);
        let newest = timeline[done.saturating_sub(1)].0 as f32;
        if lead.len() <= s {
            lead.resize(s + 1, f32::NEG_INFINITY);
        }
        lead[s] = lead[s].max(render - newest);
    }
    for w in frames.windows(2) {
        let s = ((w[1].0 - t0) / 1000.0).floor().max(0.0) as usize;
        if per_second.len() <= s {
            per_second.resize(s + 1, (0.0, 0.0, 0, 0.0, 0));
        }
        let wall = w[1].0 - w[0].0;
        let shown = f64::from(w[1].1 - w[0].1) * tick_ms;
        let e = &mut per_second[s];
        e.0 += wall;
        e.1 += shown;
        e.2 += u32::from(shown <= 0.0);
        e.3 = e.3.max(w[1].1 - w[0].1);
        e.4 += 1;
    }
    Ok(json!(per_second
        .iter()
        .enumerate()
        .map(|(s, (wall, shown, stalls, max_step, n))| json!({
            "second": s, "frames": n, "rate": if *wall > 0.0 { shown / wall } else { 0.0 },
            "stalled_frames": stalls, "max_step_ticks": max_step,
            "max_lead_ticks": lead.get(s).copied().unwrap_or(0.0),
        }))
        .collect::<Vec<_>>()))
}

fn clock_markdown(cadence: &serde_json::Value, render: &serde_json::Value) -> String {
    let mut md = String::from("| s | server ticks | longest tick gap ms | shown rate (1 = real time) | stalled frames | largest step (ticks) | most ahead of the server (ticks) |\n|---:|---:|---:|---:|---:|---:|---:|\n");
    let empty = Vec::new();
    let (c, r) = (cadence.as_array().unwrap_or(&empty), render.as_array().unwrap_or(&empty));
    for s in 0..c.len().max(r.len()) {
        let cs = c.get(s);
        let rs = r.get(s);
        md.push_str(&format!(
            "| {s} | {} | {:.0} | {:.2} | {} | {:.1} | {:.1} |\n",
            cs.and_then(|v| v["ticks"].as_u64()).unwrap_or(0),
            cs.and_then(|v| v["max_gap_ms"].as_f64()).unwrap_or(0.0),
            rs.and_then(|v| v["rate"].as_f64()).unwrap_or(0.0),
            rs.and_then(|v| v["stalled_frames"].as_u64()).unwrap_or(0),
            rs.and_then(|v| v["max_step_ticks"].as_f64()).unwrap_or(0.0),
            rs.and_then(|v| v["max_lead_ticks"].as_f64()).unwrap_or(0.0),
        ));
    }
    md
}
