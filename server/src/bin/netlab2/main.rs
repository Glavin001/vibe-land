//! Netlab v2: replay frozen server truth from a paired session bundle through
//! the production encoders, a deterministic link and the production client,
//! and score what the client would display. See docs/netlab-v2.md.
//!
//!   netlab2 run      --bundle B --out D [--link recorded|<profile>] [--pace recorded|ideal]
//!                    [--seed N] [--knob k=v]... [--frames recorded|60|120] [--client-root C]
//!   netlab2 stream   (server stage + link only; writes D/lab.vltape)
//!   netlab2 score    --bundle B --out D   (score an existing run)
//!   netlab2 matrix   --bundle B --out D [--links a,b] [--knob-sets 'name:k=v,k=v;name2:...']
//!   netlab2 compare  --a D1 --b D2 [--out D]
//!   netlab2 calibrate --bundle B --out D  (the proxy check; exits 1 when it fails)
//!   netlab2 profiles
//!
//! The production modules are compiled in from their own source files, not
//! copied: see the `#[path]` modules below.

#![allow(dead_code)]

#[path = "../../link_rate.rs"]
mod link_rate;
#[path = "../../protocol.rs"]
mod protocol;
#[path = "../../send_log.rs"]
mod send_log;
#[path = "../../session_capture.rs"]
mod session_capture;
#[path = "../../snapshot_builder.rs"]
mod snapshot_builder;

mod bundle;
mod calibrate;
mod chunks;
#[cfg(test)]
mod fixture_tests;
mod link;
mod report;
mod score;
mod stream;
mod unified;
mod vltape;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::bundle::Bundle;
use crate::link::{Delivery, LinkStats, Profile};
use crate::stream::{Origin, Pace, StreamConfig};
use crate::vltape::TapePacket;

pub const RECORDED: &str = "recorded";

#[derive(Clone, Debug)]
pub struct Args {
    pub command: String,
    pub values: BTreeMap<String, Vec<String>>,
}

impl Args {
    fn parse() -> Self {
        let mut argv = std::env::args().skip(1);
        let command = argv.next().unwrap_or_else(|| "help".into());
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let rest: Vec<String> = argv.collect();
        let mut i = 0;
        while i < rest.len() {
            let key = rest[i].trim_start_matches("--").to_string();
            let value = rest.get(i + 1).filter(|v| !v.starts_with("--")).cloned();
            if value.is_some() {
                i += 2;
            } else {
                i += 1;
            }
            values.entry(key).or_default().push(value.unwrap_or_else(|| "true".into()));
        }
        Self { command, values }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).and_then(|v| v.last()).map(String::as_str)
    }

    pub fn all(&self, key: &str) -> Vec<String> {
        self.values.get(key).cloned().unwrap_or_default()
    }

    pub fn path(&self, key: &str) -> PathBuf {
        PathBuf::from(self.get(key).unwrap_or_else(|| die(&format!("--{key} is required"))))
    }
}

pub fn die(message: &str) -> ! {
    eprintln!("netlab2: {message}");
    std::process::exit(2)
}

/// The worktree the binary was built from (its source tree): defaults for
/// the client root and the profile table.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub fn profiles_path() -> PathBuf {
    repo_root().join("client/netlab/netemProfiles.json")
}

pub fn load_profile(name: &str, file: Option<&str>) -> Profile {
    let path = file.map(PathBuf::from).unwrap_or_else(profiles_path);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| die(&format!("{}: {e}", path.display())));
    let profiles = link::load_profiles(&text).unwrap_or_else(|e| die(&e));
    profiles
        .get(name)
        .cloned()
        .unwrap_or_else(|| die(&format!("unknown link profile {name}; see `netlab2 profiles`")))
}

/// Everything that defines a run besides the bundle: echoed into its report.
#[derive(Clone, Debug, Serialize)]
pub struct RunSpec {
    pub link: String,
    pub profile: Option<Profile>,
    pub pace: Pace,
    pub seed: u64,
    pub knobs: BTreeMap<String, String>,
    pub frames: String,
}

pub fn run_spec(args: &Args) -> (RunSpec, StreamConfig) {
    let link = args.get("link").unwrap_or(RECORDED).to_string();
    let profile = (link != RECORDED).then(|| load_profile(&link, args.get("profiles")));
    let pace = match args.get("pace").unwrap_or("recorded") {
        "recorded" => Pace::Recorded,
        "ideal" => Pace::Ideal,
        other => die(&format!("--pace {other}: recorded|ideal")),
    };
    if link == RECORDED && pace == Pace::Ideal {
        die("the recorded link replays the arrival times of the recorded pace; use --pace recorded with it");
    }
    let seed = args.get("seed").map_or(1, |s| s.parse().unwrap_or_else(|_| die("--seed N")));
    let mut knobs = BTreeMap::new();
    for knob in args.all("knob") {
        for part in knob.split(',').filter(|p| !p.is_empty()) {
            let (k, v) = part.split_once('=').unwrap_or_else(|| die(&format!("--knob {part}: k=v")));
            knobs.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let mut config = stream_config(pace, &knobs);
    // Rate adaptation is on in production; the lab closes the loop on a
    // simulated link (seam S15). The recorded link carries the live
    // server's own decisions, so there it stays open.
    let knob = |key: &str| knobs.get(key).map(|v| v.parse::<f64>().unwrap_or_else(|_| die(&format!("knob {key}={v}: number"))));
    let adapt = knob("city.rate_adapt").map_or(true, |v| v != 0.0);
    if let (Some(profile), true) = (&profile, adapt) {
        config.rate_adapt = Some(stream::RateAdapt {
            profile: profile.clone(),
            seed,
            config: link_rate::RateConfig {
                reliable_queue_ms: knob("city.reliable_queue_ms")
                    .unwrap_or(link_rate::RateConfig::PRODUCTION.reliable_queue_ms),
                reliable_drain_ms: knob("city.reliable_drain_ms")
                    .unwrap_or(link_rate::RateConfig::PRODUCTION.reliable_drain_ms),
                // `city.limited_hz`: the most city sends per second while
                // limited (0: every send the stream makes).
                limited_send_interval_s: knob("city.limited_hz").map_or(
                    link_rate::RateConfig::PRODUCTION.limited_send_interval_s,
                    |hz| if hz > 0.0 { 1.0 / hz } else { 0.0 },
                ),
                ..link_rate::RateConfig::PRODUCTION
            },
            stale_ms: knob("lab.rate_stale_ms").unwrap_or(0.0),
        });
    }
    let frames = args.get("frames").unwrap_or("recorded").to_string();
    (RunSpec { link, profile, pace, seed, knobs, frames }, config)
}

/// The knobs production actually has, by name. See docs/netlab-v2.md.
pub fn stream_config(pace: Pace, knobs: &BTreeMap<String, String>) -> StreamConfig {
    let mut config = StreamConfig { pace, ..Default::default() };
    for (key, value) in knobs {
        let f = || value.parse::<f64>().unwrap_or_else(|_| die(&format!("knob {key}={value}: number")));
        match key.as_str() {
            "snapshot.budget_bytes" => config.snapshot.datagram_target_bytes = f() as usize,
            "snapshot.player_aoi_m" => config.snapshot.player_aoi_radius_m = f() as f32,
            "snapshot.vehicle_aoi_m" => config.snapshot.vehicle_aoi_radius_m = f() as f32,
            "snapshot.dynamic_aoi_m" => config.snapshot.dynamic_aoi_radius_m = f() as f32,
            "snapshot.dynamic_aoi_exit_m" => config.snapshot.dynamic_aoi_exit_radius_m = f() as f32,
            "snapshot.cold_dynamic_refresh_ticks" => config.snapshot.cold_dynamic_refresh_ticks = f() as u32,
            "snapshot.cold_vehicle_refresh_ticks" => config.snapshot.cold_vehicle_refresh_ticks = f() as u32,
            "snapshot.hot_speed_mps" => config.snapshot.hot_linear_speed_mps = f() as f32,
            "snapshot.hot_near_m" => config.snapshot.hot_dynamic_near_radius_m = f() as f32,
            "snapshot.interval_ticks" => config.snapshot_interval_ticks = Some(f() as u32),
            "snapshot.compact_self" => config.snapshot_compact_self = Some(f() != 0.0),
            "snapshot.removals" => config.snapshot_removals = Some(f() != 0.0),
            "snapshot.idle_cold" => config.snapshot_idle_cold = Some(f() != 0.0),
            "snapshot.cold_player_refresh_ticks" => config.snapshot.cold_player_refresh_ticks = f() as u32,
            "city.send_hz" => config.city.send_hz = Some(f() as u32),
            "city.ceiling_bytes" => config.city.ceiling_bytes = Some(f() as usize),
            "city.error_budget_px" => config.city.error_budget_px = Some(f() as f32),
            "city.burst_capacity_sends" => config.city.burst_capacity_sends = Some(f() as u32),
            "city.burst_max_multiple" => config.city.burst_max_multiple = Some(f() as u32),
            "city.baseline_interval_ticks" => config.city.baseline_interval_ticks = Some(f() as u32),
            "city.proximity_m" => config.city.proximity_m = Some(f() as f32),
            // Lab-only, not a production knob: see StreamConfig::recorded_repairs.
            "lab.recorded_repairs" => config.recorded_repairs = f() != 0.0,
            // Read by run_spec: per-link rate adaptation (production: on,
            // `VIBE_CITY_RATE_ADAPT`), and a lab-only feedback delay probe.
            "city.rate_adapt" | "lab.rate_stale_ms" | "city.reliable_queue_ms" | "city.reliable_drain_ms"
            | "city.limited_hz" => {
                f();
            }
            "city.client_model" => config.city.model_client_extrapolation = Some(f() != 0.0),
            "city.ballistic_free_fall" => config.city.ballistic_requires_free_fall = Some(f() != 0.0),
            "city.rest_stride" => config.city.rest_eval_stride = Some(f() as u32),
            "city.linear_motion_mps" => config.city.linear_motion_threshold = Some(f() as f32),
            "city.angular_motion_rps" => config.city.angular_motion_threshold = Some(f() as f32),
            "city.max_moving_age_ticks" => config.city.max_moving_age_ticks = Some(f() as u32),
            "city.contact_target_age_ticks" => config.city.contact_target_age_ticks = Some(f() as u32),
            "city.baseline_lag_ticks" => config.city.baseline_reference_lag_ticks = Some(f() as u32),
            "city.baseline_skip_quiescent" => config.city.baseline_skips_quiescent = Some(f() != 0.0),
            "city.topology_copies" => config.city.topology_datagram_copies = Some(f() as u32),
            "city.innovation_window_ticks" => config.city.innovation_window_ticks = Some(f() as u32),
            "city.max_eval" => {
                // Read once, from the environment, by the encoder itself.
                std::env::set_var("VIBE_CITY_MAX_EVAL", value);
            }
            other => die(&format!("unknown knob {other}; see docs/netlab-v2.md")),
        }
    }
    config
}

#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct LaneTotals {
    pub packets: u64,
    pub bytes: u64,
    pub delivered: u64,
    pub delivered_bytes: u64,
    pub by_fate: BTreeMap<String, u64>,
    /// Queue-to-arrival, ms, delivered packets.
    pub latency_ms: report::Pct,
    pub hol_ms: report::Pct,
}

#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
pub struct StreamReport {
    pub bundle: String,
    pub player: u32,
    #[serde(skip_deserializing)]
    pub spec: Option<RunSpec>,
    /// A re-read report's spec and link stats, as JSON.
    #[serde(skip)]
    pub spec_json: Option<serde_json::Value>,
    #[serde(skip)]
    pub link_json: Option<serde_json::Value>,
    pub warnings: Vec<String>,
    pub clock_offset_ms: f64,
    pub clock_offset_source: String,
    pub duration_s: f64,
    pub stream: stream::StreamStats,
    #[serde(skip_deserializing)]
    pub link: Option<LinkStats>,
    /// Per lane (as queued): what went out and what arrived.
    pub lanes: BTreeMap<String, LaneTotals>,
    /// Per packet kind: bytes/s delivered to the client.
    pub kinds: BTreeMap<String, LaneTotals>,
    pub by_origin: BTreeMap<String, u64>,
}

pub fn kind_name(kind: u8) -> String {
    use vibe_land_shared::constants::*;
    let name = match kind {
        PKT_WELCOME => "welcome",
        PKT_SNAPSHOT => "snapshot_v1",
        PKT_SNAPSHOT_V2 => "snapshot_v2",
        PKT_SHOT_RESULT => "shot_result",
        PKT_CHUNK_FULL => "chunk_full",
        PKT_CHUNK_DIFF => "chunk_diff",
        PKT_PING => "ping",
        PKT_PLAYER_ROSTER => "player_roster",
        PKT_DYNAMIC_BODY_META => "dynamic_body_meta",
        PKT_LOCAL_PLAYER_ENERGY => "local_player_energy",
        PKT_BATTERY_SYNC => "battery_sync",
        PKT_SHOT_FIRED => "shot_fired",
        PKT_DAMAGE_EVENT => "damage_event",
        PKT_CITY_CHUNKS => "city_chunks",
        PKT_CITY_TOPOLOGY => "city_topology",
        PKT_CITY_BASELINE => "city_baseline",
        PKT_CITY_BOOTSTRAP => "city_bootstrap",
        PKT_CITY_MANIFEST => "city_manifest",
        PKT_MATCH_STATS => "match_stats",
        PKT_CITY_DEBRIS => "city_debris",
        PKT_METEOR_LAUNCHED => "meteor_launched",
        128 => "city_topo_hash",
        129 => "city_structure_bootstrap",
        127 => "city_lanes",
        _ => return format!("kind_{kind}"),
    };
    name.to_string()
}

/// Server stage + link: the packets the lab's client receives, as a tape.
pub struct StreamRun {
    pub stream: stream::Stream,
    pub deliveries: Vec<Delivery>,
    pub report: StreamReport,
}

pub fn run_stream(bundle: &Bundle, spec: &RunSpec, config: &StreamConfig, out: &Path) -> std::io::Result<StreamRun> {
    std::fs::create_dir_all(out)?;
    let built = stream::build(bundle, config)?;
    let (deliveries, link_stats) = match &spec.profile {
        None => (link::recorded(bundle, &built.packets), None),
        Some(profile) => {
            let (d, s) = link::simulate(&built.packets, profile, spec.seed);
            (d, Some(s))
        }
    };
    // The tape the client stage replays: the recorded prelude (session state
    // from before the recording, which no server capture covers), then
    // everything that arrived, in arrival order.
    let mut tape_packets: Vec<(f64, u64, TapePacket)> = Vec::new();
    for packet in bundle.tape.packets.iter().filter(|p| p.is_prelude()) {
        tape_packets.push((packet.t_ms, 0, packet.clone()));
    }
    for (packet, delivery) in built.packets.iter().zip(&deliveries) {
        if let Some(arrive) = delivery.arrive_ms {
            tape_packets.push((
                arrive,
                1 + packet.seq,
                TapePacket { t_ms: arrive, channel: delivery.channel, bytes: packet.bytes.clone() },
            ));
        }
    }
    tape_packets.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let packets: Vec<TapePacket> = tape_packets.into_iter().map(|(_, _, p)| p).collect();
    let duration_s = bundle.tape.header["durationMs"].as_f64().unwrap_or(0.0) / 1000.0;
    bundle.tape.write_with_packets(
        &out.join("lab.vltape"),
        &packets,
        serde_json::json!({
            "netlab": {
                "bundle": bundle.dir.display().to_string(),
                "link": spec.link,
                "pace": spec.pace,
                "seed": spec.seed,
                "knobs": spec.knobs,
            }
        }),
    )?;

    let mut report = StreamReport {
        bundle: bundle.dir.display().to_string(),
        player: bundle.player,
        spec: Some(spec.clone()),
        warnings: bundle.warnings.clone(),
        clock_offset_ms: bundle.clock_offset_ms,
        clock_offset_source: bundle.clock_offset_source.clone(),
        duration_s,
        stream: built.stats.clone(),
        link: link_stats,
        ..Default::default()
    };
    let mut lane_lat: BTreeMap<String, (Vec<f32>, Vec<f32>)> = BTreeMap::new();
    let mut kind_lat: BTreeMap<String, (Vec<f32>, Vec<f32>)> = BTreeMap::new();
    for (packet, delivery) in built.packets.iter().zip(&deliveries) {
        let origin = match packet.origin {
            Origin::Lab => "lab",
            Origin::Pass => "pass_through",
            Origin::PrePass => "pre_capture",
        };
        *report.by_origin.entry(origin.into()).or_default() += 1;
        for (map, lat, key) in [
            (&mut report.lanes, &mut lane_lat, packet.lane.name().to_string()),
            (&mut report.kinds, &mut kind_lat, kind_name(packet.kind)),
        ] {
            let totals = map.entry(key.clone()).or_default();
            totals.packets += 1;
            totals.bytes += packet.bytes.len() as u64;
            *totals.by_fate.entry(format!("{:?}", delivery.fate).to_lowercase()).or_default() += 1;
            if let Some(arrive) = delivery.arrive_ms {
                totals.delivered += 1;
                totals.delivered_bytes += packet.bytes.len() as u64;
                let entry = lat.entry(key).or_default();
                entry.0.push((arrive - packet.depart_ms) as f32);
                entry.1.push(delivery.hol_ms as f32);
            }
        }
    }
    for (map, lat) in [(&mut report.lanes, lane_lat), (&mut report.kinds, kind_lat)] {
        for (key, (latency, hol)) in lat {
            if let Some(totals) = map.get_mut(&key) {
                totals.latency_ms = report::Pct::of(latency);
                totals.hol_ms = report::Pct::of(hol);
            }
        }
    }
    std::fs::write(out.join("stream.json"), serde_json::to_vec_pretty(&report)?)?;
    if !built.rate_trace.is_empty() {
        // The rate controller's per-send decisions (seam S15).
        let mut lines = Vec::new();
        for row in &built.rate_trace {
            serde_json::to_writer(&mut lines, row)?;
            lines.push(b'\n');
        }
        std::fs::write(out.join("rate-trace.jsonl"), lines)?;
    }
    Ok(StreamRun { stream: built, deliveries, report })
}

/// The client stage for a bundle: writes the tick timeline the city scorer
/// needs next to the output and passes the city manifest.
pub fn run_client_stage_for(
    bundle: &Bundle,
    tape: &Path,
    out: &Path,
    frames: &str,
    client_root: &Path,
    label: &str,
    pace: Pace,
) -> std::io::Result<()> {
    std::fs::create_dir_all(out)?;
    // The server timeline the stream ran on; the client stage stamps city
    // frames with it and the scorer reads it back for "now".
    std::fs::write(
        out.join("timeline.json"),
        serde_json::to_vec(&score::Timeline::for_pace(bundle, pace).ticks_json())?,
    )?;
    let manifest = bundle
        .city
        .as_ref()
        .map(|city| city.dir.join(vibe_land_destruction::netlab::capture::MANIFEST_FILE))
        .ok_or_else(|| std::io::Error::other("the client stage needs a city capture (manifest)"))?;
    run_client_stage(tape, out, frames, client_root, label, &manifest)
}

/// The client stage: the production client, headless, over `lab.vltape`.
pub fn run_client_stage(
    tape: &Path,
    out: &Path,
    frames: &str,
    client_root: &Path,
    label: &str,
    manifest: &Path,
) -> std::io::Result<()> {
    // The stage script is this checkout's; the client it drives is
    // `client_root`'s (another worktree's, for a before/after compare).
    let script = repo_root().join("client/netlab/v2/clientStage.mts");
    std::fs::create_dir_all(out)?;
    let (tape, out, manifest, client_root) = (
        std::path::absolute(tape)?,
        std::path::absolute(out)?,
        std::path::absolute(manifest)?,
        std::path::absolute(client_root)?,
    );
    let (tape, out, manifest, client_root) =
        (tape.as_path(), out.as_path(), manifest.as_path(), client_root.as_path());
    // Experiments (`--frame-start after`, `--allow-stale-wasm`) pass through.
    let extra: Vec<String> = std::env::var("NETLAB2_CLIENT_ARGS")
        .map(|value| value.split_whitespace().map(String::from).collect())
        .unwrap_or_default();
    let status = Command::new("node")
        .current_dir(client_root)
        .arg("--import")
        .arg("tsx/esm")
        .arg(&script)
        .arg("--tape")
        .arg(tape)
        .arg("--out")
        .arg(out)
        .arg("--frames")
        .arg(frames)
        .arg("--client-root")
        .arg(client_root)
        .arg("--label")
        .arg(label)
        .arg("--manifest")
        .arg(manifest)
        .args(&extra)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other(format!("client stage failed: {status}")));
    }
    Ok(())
}

pub fn client_root(args: &Args) -> PathBuf {
    args.get("client-root").map(PathBuf::from).unwrap_or_else(|| repo_root().join("client"))
}

fn cmd_stream(args: &Args) {
    let bundle = Bundle::open(&args.path("bundle")).unwrap_or_else(|e| die(&e.to_string()));
    let out = args.path("out");
    let (spec, config) = run_spec(args);
    let run = run_stream(&bundle, &spec, &config, &out).unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", report::stream_summary(&run.report));
    if spec.profile.is_none() {
        let bytes = calibrate::byte_match(&bundle, &run.stream);
        std::fs::write(out.join("calibration-bytes.json"), serde_json::to_vec_pretty(&bytes).unwrap()).unwrap();
        println!("{}", calibrate::byte_match_summary(&bytes));
    }
}

fn cmd_run(args: &Args) {
    let bundle = Bundle::open(&args.path("bundle")).unwrap_or_else(|e| die(&e.to_string()));
    let out = args.path("out");
    let (spec, config) = run_spec(args);
    let run = run_stream(&bundle, &spec, &config, &out).unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", report::stream_summary(&run.report));
    run_client_stage_for(&bundle, &out.join("lab.vltape"), &out, &spec.frames, &client_root(args), "lab", spec.pace)
        .unwrap_or_else(|e| die(&e.to_string()));
    let card = score::score_run(&bundle, &out, &run.report).unwrap_or_else(|e| die(&e.to_string()));
    report::write_run_report(&out, &run.report, &card).unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", report::card_summary(&card));
}

fn cmd_score(args: &Args) {
    let bundle = Bundle::open(&args.path("bundle")).unwrap_or_else(|e| die(&e.to_string()));
    let out = args.path("out");
    let stream: StreamReport = report::read_stream_report(&out).unwrap_or_else(|e| die(&e.to_string()));
    let card = score::score_run(&bundle, &out, &stream).unwrap_or_else(|e| die(&e.to_string()));
    report::write_run_report(&out, &stream, &card).unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", report::card_summary(&card));
}

fn main() {
    let args = Args::parse();
    match args.command.as_str() {
        "stream" => cmd_stream(&args),
        "run" => cmd_run(&args),
        "score" => cmd_score(&args),
        "calibrate" => calibrate::cmd_calibrate(&args),
        "matrix" => report::cmd_matrix(&args),
        "compare" => report::cmd_compare(&args),
        "profiles" => {
            let text = std::fs::read_to_string(profiles_path()).unwrap();
            for (name, profile) in link::load_profiles(&text).unwrap() {
                println!("{name:<14} {}", serde_json::to_string(&profile).unwrap());
            }
        }
        _ => {
            eprintln!("{}", include_str!("main.rs").lines().take(14).collect::<Vec<_>>().join("\n"));
            std::process::exit(if args.command == "help" { 0 } else { 2 });
        }
    }
}
