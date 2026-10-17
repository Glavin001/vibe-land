//! `--features rubble` is the PhysX-free server: rubble does the physics, and
//! nothing from PhysX, CuMetal, CUDA or Blast is compiled or linked. This test
//! asks cargo for the build's dependency graph and fails if any of it appears,
//! so a feature that quietly starts implying `physx-gpu` is caught here rather
//! than on a machine without the PhysX SDK.

use std::process::Command;

#[test]
fn the_rubble_build_depends_on_no_physx() {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let out = Command::new(cargo)
        .args(["tree", "-p", "web-fps-server", "--features", "rubble", "-e", "normal", "--prefix", "none"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree");
    assert!(out.status.success(), "cargo tree failed: {}", String::from_utf8_lossy(&out.stderr));
    let tree = String::from_utf8_lossy(&out.stdout);
    assert!(tree.contains("vibe-land-rubble-bridge"), "the rubble build lost rubble:\n{tree}");
    let offenders: Vec<&str> = tree
        .lines()
        .filter(|line| {
            let name = line.split_whitespace().next().unwrap_or("");
            name.contains("physx") || name.contains("blast")
        })
        .collect();
    assert!(offenders.is_empty(), "the rubble build pulls in PhysX/Blast: {offenders:?}");
}
