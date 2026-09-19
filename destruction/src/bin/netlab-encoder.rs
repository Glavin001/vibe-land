//! Replay a recorded encoder tape through the chunk stream encoder and report
//! where the bytes went.
//!
//!   netlab-encoder --tape <file> --manifest <manifest.json> [--label name]
//!                  [--ceiling-bytes N] [--max-eval N] [--send-hz N]
//!
//! The point is exact comparison. The GPU destruction sim is not
//! bit-deterministic -- two recordings of the same scripted collapse gave 6,740
//! and 7,052 broken bonds -- so an A/B between two *recordings* cannot
//! attribute a difference to the change under test. Replaying one tape holds
//! the physics byte-identical, so the only thing that varies is the encoder
//! configuration.
//!
//! It is also fast and needs no GPU, which is what makes sweeping a parameter
//! affordable rather than an overnight job.

use std::path::PathBuf;

use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::tape::TapeReader;
use vibe_land_destruction::types::Camera;

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tape_path = PathBuf::from(
        flag("--tape").ok_or("usage: netlab-encoder --tape <file> --manifest <file>")?,
    );
    let manifest_path = PathBuf::from(flag("--manifest").ok_or("--manifest is required")?);
    let label = flag("--label").unwrap_or_else(|| "replay".to_string());

    let manifest: DestructionManifest =
        serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    let mut reader = TapeReader::open(&tape_path)?;
    // A tape recorded against a different scene would replay as a stream of
    // bodies the manifest cannot place, and the audit would be nonsense that
    // looks like a result.
    if reader.manifest_hash != manifest.hash() {
        return Err(format!(
            "tape was recorded against a different manifest: tape {} vs {}",
            hex(&reader.manifest_hash),
            hex(&manifest.hash())
        )
        .into());
    }

    let hz = reader.hz;
    let mut config = EncoderConfig::validated(hz);
    // Mirror CityRuntime::from_parts, exactly as the recorder's own tap does.
    config.send_interval_ticks = (hz / flag("--send-hz").map_or(30, |v| v.parse().unwrap_or(30)))
        .max(1);
    config.interest.proximity_meters = 120.0;
    if let Some(value) = flag("--ceiling-bytes") {
        config.client_ceiling_bytes = value.parse()?;
    }
    if let Some(value) = flag("--error-budget-px") {
        config.error_budget_px = value.parse()?;
    }
    if let Some(value) = flag("--burst-capacity-sends") {
        config.burst_capacity_sends = value.parse()?;
    }
    if let Some(value) = flag("--burst-max-multiple") {
        config.burst_max_multiple = value.parse()?;
    }
    // MAX_EVAL is read from the environment by the encoder itself; setting it
    // here keeps every knob on one command line.
    if let Some(value) = flag("--max-eval") {
        std::env::set_var("VIBE_CITY_MAX_EVAL", value);
    }

    let mut encoder = ChunkStreamEncoder::new(&manifest, config);
    encoder.add_client(1);
    encoder.enable_send_audit();

    // From the tape by default: interest and the pixel error budget are
    // camera-dependent, so replaying from somewhere else would silently be a
    // different question dressed up as a comparison.
    //
    // --camera-eye/--camera-look override it deliberately, for the one
    // comparison where the viewpoint IS the variable (the same collapse seen
    // from close up and from far away). It says so on every line of output, so
    // an overridden run can never be mistaken for the recorded one.
    let recorded = reader.camera;
    let mut camera = Camera {
        eye: glam::Vec3::from_array(recorded.eye),
        direction: glam::Vec3::from_array(recorded.direction).normalize_or_zero(),
        fov_degrees: recorded.fov_degrees,
    };
    let mut camera_overridden = false;
    if let Some(value) = flag("--camera-eye") {
        camera.eye = parse_vec3(&value)?;
        camera_overridden = true;
    }
    if let Some(value) = flag("--camera-look") {
        camera.direction = (parse_vec3(&value)? - camera.eye).normalize_or_zero();
        camera_overridden = true;
    }
    if let Some(value) = flag("--camera-fov") {
        camera.fov_degrees = value.parse()?;
        camera_overridden = true;
    }
    if camera_overridden && camera.direction.length_squared() < 0.5 {
        return Err("--camera-look resolves to the eye position: no view direction".into());
    }

    let started = std::time::Instant::now();
    let mut ticks = 0u32;
    let mut pose_bytes = 0usize;
    let mut reliable_bytes = 0usize;
    let mut datagrams = 0usize;
    reliable_bytes += encoder.bootstrap_message(1).len();
    while let Some(entry) = reader.next_tick()? {
        encoder.ingest_tick(entry.tick, &entry.snapshots, &entry.output, &[]);
        for packet in encoder.take_topology_messages() {
            reliable_bytes += packet.len();
        }
        if let Some(baselines) = encoder.maybe_emit_baseline(entry.tick) {
            for packet in baselines {
                reliable_bytes += packet.len();
            }
        }
        if entry.tick % config.send_interval_ticks == 0 {
            let shared = encoder.encode_send(entry.tick);
            if !shared.records.is_empty() {
                for packet in encoder.client_datagrams(1, camera, &shared) {
                    pose_bytes += packet.len();
                    datagrams += 1;
                }
            }
        }
        ticks += 1;
    }

    let seconds = ticks as f64 / hz as f64;
    let audit = encoder.send_audit().expect("audit enabled");
    println!("--- {label} ---");
    println!(
        "camera{} eye ({:.1}, {:.1}, {:.1}) dir ({:.2}, {:.2}, {:.2}) fov {:.0}",
        if camera_overridden { " OVERRIDDEN" } else { " (recorded)" },
        camera.eye.x, camera.eye.y, camera.eye.z,
        camera.direction.x, camera.direction.y, camera.direction.z,
        camera.fov_degrees,
    );
    println!(
        "ticks {ticks} ({seconds:.1} s) | ceiling {} B | burst {}x{} | max-eval {} | \
         replay {:.2} s",
        config.client_ceiling_bytes,
        config.burst_capacity_sends,
        config.burst_max_multiple,
        std::env::var("VIBE_CITY_MAX_EVAL").unwrap_or_else(|_| "default".into()),
        started.elapsed().as_secs_f32(),
    );
    println!(
        "poses {:.3} Mbps in {datagrams} datagrams | reliable {:.3} Mbps | total {:.3} Mbps",
        pose_bytes as f64 * 8.0 / seconds / 1e6,
        reliable_bytes as f64 * 8.0 / seconds / 1e6,
        (pose_bytes + reliable_bytes) as f64 * 8.0 / seconds / 1e6,
    );
    print!("{}", audit.table(hz as f32));

    if let Some(path) = flag("--json-out") {
        std::fs::write(&path, serde_json::to_vec_pretty(&audit.report())?)?;
        println!("wrote {path}");
    }
    Ok(())
}

/// "x,y,z" -- refused rather than silently partially parsed, because a camera
/// that quietly became the origin would look like a legitimate distant view.
fn parse_vec3(value: &str) -> Result<glam::Vec3, Box<dyn std::error::Error>> {
    let parts: Vec<&str> = value.split(',').map(str::trim).collect();
    if parts.len() != 3 {
        return Err(format!("expected x,y,z but got {value:?}").into());
    }
    Ok(glam::Vec3::new(
        parts[0].parse()?,
        parts[1].parse()?,
        parts[2].parse()?,
    ))
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
