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
