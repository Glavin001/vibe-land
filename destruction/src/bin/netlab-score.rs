//! Score a client's presented stream against the tape it was streamed from.
//!
//!   netlab-score --capture <dir> --presented <presented.bin> --client-meta <pkts/<c>/meta.json>
//!                [--window from,to] [--gravity 9.81] [--out <scorecard.json>] [--md <scorecard.md>]
//!
//! `--tape <file> --manifest <file>` for a bare tape; `--camera <spec>`
//! overrides the client's recorded camera spec.

use std::path::PathBuf;

use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::cameras::{CameraSpec, PlayerTracks};
use vibe_land_destruction::netlab::capture::CaptureDir;
use vibe_land_destruction::netlab::score::{markdown, score, ScoreOptions};

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let presented = PathBuf::from(flag("--presented").ok_or("--presented <file> is required")?);
    let (tape, manifest, tracks) = if let Some(dir) = flag("--capture") {
        let capture = CaptureDir::open(&PathBuf::from(&dir))?;
        let manifest: DestructionManifest =
            serde_json::from_slice(&std::fs::read(capture.manifest_path())?)?;
        let tracks = PlayerTracks::from_samples(&capture.cameras()?);
        (capture.tape_path(), manifest, tracks)
    } else {
        let tape = PathBuf::from(flag("--tape").ok_or("--capture <dir> or --tape <file>")?);
        let manifest_path = PathBuf::from(flag("--manifest").ok_or("--manifest is required")?);
        let manifest: DestructionManifest =
            serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
        (tape, manifest, PlayerTracks::default())
    };

    let mut camera: Option<CameraSpec> = None;
    let mut profile = "none".to_string();
    if let Some(meta_path) = flag("--client-meta") {
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path)?)?;
        if let Some(spec) = meta.get("camera") {
            camera = Some(serde_json::from_value(spec.clone())?);
        }
        if let Some(name) = meta.get("profile").and_then(|v| v.as_str()) {
            profile = name.to_string();
        }
    }
    if let Some(spec) = flag("--camera") {
        camera = Some(CameraSpec::parse(&spec)?);
    }
    if let Some(name) = flag("--profile") {
        profile = name;
    }
    let camera = camera.ok_or("need --client-meta or --camera")?;
    let window = match flag("--window") {
        Some(value) => {
            let (from, to) = value.split_once(',').ok_or("--window from,to")?;
            Some((from.trim().parse::<u32>()?, to.trim().parse::<u32>()?))
        }
        None => None,
    };
    let gravity: f32 = flag("--gravity").map_or(Ok(9.81), |v| v.parse())?;
    let dump_worst: usize = flag("--dump-worst").map_or(Ok(0), |v| v.parse())?;

    let started = std::time::Instant::now();
    let card = score(&tape, &manifest, &tracks, &presented, &ScoreOptions { camera, profile, window, gravity, dump_worst })?;
    let md = markdown(&card);
    print!("{md}");
    println!("scored in {:.2} s", started.elapsed().as_secs_f32());
    if let Some(path) = flag("--out") {
        std::fs::write(&path, serde_json::to_vec_pretty(&card)?)?;
    }
    if let Some(path) = flag("--md") {
        std::fs::write(&path, md)?;
    }
    Ok(())
}
