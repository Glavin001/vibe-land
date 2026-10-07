//! World gravity has one default, and nothing else carries a copy of it.
//!
//! The Blast destruction path (`destruction.cc`) once read VIBE_WORLD_GRAVITY
//! itself, in two places, each with a default of 20.0. The comment said they
//! were kept in sync with `world_gravity_magnitude()`. They were not: the world
//! moved to 9.81 and those copies stayed at 20. After that, every resting-load
//! reference on that path was 2x the load bodies actually carry. The C++ now
//! reads the scene's gravity.
//!
//! These tests run with no features, so they need neither a Blast checkout nor
//! a GPU. The C++ check reads the sources rather than compiling them.

use vibe_land_physx_bridge::{Vec3, WorldConfig, DEFAULT_WORLD_GRAVITY};

#[test]
fn world_gravity_default_matches_the_player_gravity() {
    assert_eq!(
        DEFAULT_WORLD_GRAVITY,
        vibe_netcode::movement::MoveConfig::default().gravity as f32,
        "the PhysX world and the player fall under different default gravities"
    );
}

#[test]
fn world_config_takes_its_gravity_from_the_one_default() {
    // Only meaningful without an override. With one set, both sides read the
    // same env and the assertion below would test nothing new.
    if std::env::var_os("VIBE_WORLD_GRAVITY").is_some() {
        return;
    }
    assert_eq!(
        WorldConfig::default().gravity,
        Vec3::new(0.0, -DEFAULT_WORLD_GRAVITY, 0.0)
    );
}

#[test]
fn no_native_source_keeps_its_own_world_gravity_default() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut offenders = Vec::new();
    for dir in ["src", "include"] {
        for entry in std::fs::read_dir(root.join(dir)).expect("read source dir") {
            let path = entry.expect("dir entry").path();
            let is_native = matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("cc" | "cpp" | "h" | "hpp")
            );
            if !is_native {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read source");
            for (line, text) in source.lines().enumerate() {
                if text.contains("\"VIBE_WORLD_GRAVITY\"") {
                    offenders.push(format!("{}:{}", path.display(), line + 1));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "native code reads VIBE_WORLD_GRAVITY itself, which means it has a \
         default of its own that can drift from DEFAULT_WORLD_GRAVITY. Read the \
         scene's gravity instead (destruction.cc scene_gravity()):\n  {}",
        offenders.join("\n  ")
    );
}

/// Every Rust crate the server runs takes gravity from the one constant
/// (vibe_netcode::movement::GRAVITY, which DEFAULT_WORLD_GRAVITY and
/// MoveConfig::default() both equal). A literal 9.81 anywhere else in
/// production code is a copy that a change of gravity would miss:
/// docs/verification/FIDELITY_AUDIT.md row G2 found five (warm-start
/// compatibility, rolling resistance, suspension rest load, the lateral
/// limiter, the encoder's extrapolation). Test modules (after the file's first
/// `#[cfg(test)]`), comments and the constant's own definition are exempt.
#[test]
fn no_rust_source_keeps_a_gravity_literal() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut offenders = Vec::new();
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    for dir in ["server/src", "destruction/src", "netcode/src", "physx-bridge/src"] {
        walk(&root.join(dir), &mut files);
    }
    // Whole files compiled only under #[cfg(test)] in their parent module.
    const TEST_ONLY: [&str; 2] = ["physx_runtime/vehicle_destruction_tests.rs", "physx_runtime/vehicle_lab.rs"];
    for path in files {
        if TEST_ONLY.iter().any(|t| path.ends_with(t)) {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read source");
        let production = source.split("#[cfg(test)]").next().unwrap_or("");
        for (line, text) in production.lines().enumerate() {
            let code = text.split("//").next().unwrap_or("");
            if code.contains("9.81") && !code.contains("pub const GRAVITY") && !code.contains("pub const DEFAULT_WORLD_GRAVITY") {
                offenders.push(format!("{}:{}: {}", path.display(), line + 1, text.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "gravity copies (use vibe_netcode::movement::GRAVITY):\n  {}",
        offenders.join("\n  ")
    );
    // The browser cannot import the constant; its extrapolation must equal it.
    let presentation = std::fs::read_to_string(root.join("client/src/city/presentation.ts")).expect("presentation.ts");
    assert!(
        presentation.contains(&format!("gravity: [0, -{}, 0]", vibe_netcode::movement::GRAVITY)),
        "client/src/city/presentation.ts extrapolates under a gravity other than vibe_netcode::movement::GRAVITY"
    );
}

/// VIBE_WORLD_GRAVITY moved only the PhysX scene: the players, the stress
/// loads' reference, the encoder and the vehicles kept 9.81 (audit row G2).
/// Gravity is Earth's; the override is refused rather than half-applied.
#[test]
fn a_gravity_override_is_refused_not_half_applied() {
    if std::env::var("GRAVITY_ARM").is_ok() {
        let _ = vibe_land_physx_bridge::world_gravity_magnitude();
        return;
    }
    let exe = std::env::current_exe().expect("test binary");
    let out = std::process::Command::new(exe)
        .args(["--exact", "a_gravity_override_is_refused_not_half_applied", "--nocapture"])
        .env("GRAVITY_ARM", "1")
        .env("VIBE_WORLD_GRAVITY", "20")
        .output()
        .expect("spawn");
    assert!(!out.status.success(), "VIBE_WORLD_GRAVITY=20 was accepted and would move only the PhysX scene");
    let same = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "a_gravity_override_is_refused_not_half_applied", "--nocapture"])
        .env("GRAVITY_ARM", "1")
        .env("VIBE_WORLD_GRAVITY", "9.81")
        .output()
        .expect("spawn");
    assert!(same.status.success(), "VIBE_WORLD_GRAVITY equal to Earth's must still be accepted");
}
