//! Replay a capture (or a bare tape) through the encoder for N clients and
//! write every client's byte stream plus the cost of producing it.
//!
//!   netlab-replay --capture <dir> --out <dir> [--clients N] [--client <spec>]...
//!                 [--profiles none,wifi-bad,lte] [--audit <client-id>]
//!                 [--seed N] [--ceiling-bytes N] [--max-eval N] [--send-hz N]
//!                 [--error-budget-px F] [--no-packets] [--check-stable]
//!
//! `--tape <file> --manifest <file>` replays an older tape with no camera
//! sidecar (its header camera becomes client 1 as `static:`).

use std::path::PathBuf;

use vibe_land_destruction::netlab::cameras::{build_client_set, CameraSpec, ClientSpec};
use vibe_land_destruction::netlab::replay::{self, Knobs, ReplayInput, ReplayOptions};
use vibe_land_destruction::netlab::tape::TapeReader;

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn flags(name: &str) -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut out = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if arg == name {
            if let Some(value) = args.get(index + 1) {
                out.push(value.clone());
            }
        }
    }
    out
}

fn has(name: &str) -> bool {
    std::env::args().any(|arg| arg == name)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(flag("--out").ok_or("--out <dir> is required")?);
    let input = if let Some(dir) = flag("--capture") {
        ReplayInput::from_capture(&PathBuf::from(dir))?
    } else {
        let tape = PathBuf::from(flag("--tape").ok_or("--capture <dir> or --tape <file>")?);
        let manifest = PathBuf::from(flag("--manifest").ok_or("--manifest is required")?);
        ReplayInput::from_tape(&tape, &manifest)?
    };

    let knobs = Knobs {
        send_hz: flag("--send-hz").map(|v| v.parse()).transpose()?,
        ceiling_bytes: flag("--ceiling-bytes").map(|v| v.parse()).transpose()?,
        error_budget_px: flag("--error-budget-px").map(|v| v.parse()).transpose()?,
        burst_capacity_sends: flag("--burst-capacity-sends").map(|v| v.parse()).transpose()?,
        burst_max_multiple: flag("--burst-max-multiple").map(|v| v.parse()).transpose()?,
        max_eval: flag("--max-eval").map(|v| v.parse()).transpose()?,
    };

    let profiles: Vec<String> = flag("--profiles")
        .unwrap_or_else(|| "none".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let seed: u32 = flag("--seed").map_or(Ok(1), |v| v.parse())?;

    let mut clients: Vec<ClientSpec> = Vec::new();
    let explicit = flags("--client");
    if !explicit.is_empty() {
        for (index, text) in explicit.iter().enumerate() {
            let camera = CameraSpec::parse(text)?;
            let id = match camera {
                CameraSpec::Player { id } => u64::from(id),
                _ => 20_000 + index as u64,
            };
            clients.push(ClientSpec {
                id,
                camera,
                profile: profiles[index % profiles.len()].clone(),
            });
        }
    }
    if let Some(count) = flag("--clients") {
        let count: usize = count.parse()?;
        let generated = build_client_set(count, &input.tracks, &input.manifest, &profiles, seed);
        for spec in generated {
            if !clients.iter().any(|c| c.id == spec.id) {
                clients.push(spec);
            }
        }
    }
    if clients.is_empty() {
        // A bare tape: its header camera, as the recorder's own tap used it.
        let reader = TapeReader::open(&input.tape)?;
        let camera = reader.camera;
        let look = [
            camera.eye[0] + camera.direction[0] * 10.0,
            camera.eye[1] + camera.direction[1] * 10.0,
            camera.eye[2] + camera.direction[2] * 10.0,
        ];
        clients.push(ClientSpec {
            id: 1,
            camera: CameraSpec::Static { eye: camera.eye, look, fov: camera.fov_degrees },
            profile: profiles[0].clone(),
        });
    }

    let audit_clients: Vec<u64> = flags("--audit")
        .iter()
        .map(|v| v.parse::<u64>())
        .collect::<Result<_, _>>()?;
    let options = ReplayOptions {
        out_dir: out_dir.clone(),
        clients,
        knobs,
        audit_clients,
        write_packets: !has("--no-packets"),
    };

    let report = replay::run(&input, &options)?;
    print!("{}", replay::summary(&report));
    if let Some(audit) = report.clients.iter().find_map(|c| c.audit.as_ref()) {
        let fall = &audit["fall_latency_ticks"];
        println!(
            "fall latency ticks p50 {} p90 {} p99 {} max {} | unresolved {}",
            fall["p50"], fall["p90"], fall["p99"], fall["max"], audit["unresolved_falls"]
        );
    }

    if has("--check-stable") {
        // Byte-stability is a gate: the same input must produce the same
        // bytes, or a comparison is measuring noise in the encoder.
        let second_dir = out_dir.join("stability-check");
        let second = ReplayOptions {
            out_dir: second_dir.clone(),
            clients: options.clients.clone(),
            knobs: options.knobs.clone(),
            audit_clients: Vec::new(),
            write_packets: true,
        };
        replay::run(&input, &second)?;
        let mut mismatches = 0;
        for client in &report.clients {
            let name = replay::client_dir_name(&client.spec);
            let a = std::fs::read(out_dir.join("pkts").join(&name).join("packets.jsonl"))?;
            let b = std::fs::read(second_dir.join("pkts").join(&name).join("packets.jsonl"))?;
            if a != b {
                mismatches += 1;
                eprintln!("byte-stability FAILED for client {}", client.id);
            }
        }
        let _ = std::fs::remove_dir_all(&second_dir);
        if mismatches > 0 {
            return Err(format!("{mismatches} client stream(s) not byte-stable").into());
        }
        println!("byte-stable: all {} client streams identical across two runs", report.clients.len());
    }
    println!("wrote {}", out_dir.join("replay.json").display());
    Ok(())
}
