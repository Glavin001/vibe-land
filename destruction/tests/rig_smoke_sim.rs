//! Does the bench itself work?
//!
//! Before any scenario can mean anything, the harness has to be doing what it
//! claims: installing the pack through the production path, stepping the
//! production loop, and — the part with real room for error — tracking where
//! every chunk ended up as bodies split and promote.
//!
//! Deliberately one small house. The structural scenarios that need a
//! purpose-built rig pack live in `rig_scenarios_sim.rs`; this is the
//! plumbing check, and it is kept cheap enough to run beside anything else
//! using the GPU.
//!
//!     cargo test -p vibe-land-destruction --features physx --test rig_smoke_sim
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::rig::surgery::{remove_nodes, select_nodes, NodeSel};
use vibe_land_destruction::rig::{Quiet, Rig, HZ};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

const SMALL: &str = "house-1story";

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// The bench stands a building up, notices it stopped moving, and knows where
/// its chunks are.
#[test]
fn the_bench_can_stand_a_building_up_and_find_its_chunks() {
    let pack = load(SMALL);
    let mut rig = Rig::spin_up(&pack).expect("install");

    let settle = rig.settle_until(Quiet::default(), 8.0).expect("tick");
    assert!(
        settle.rested(),
        "{SMALL} never went quiet in 8 s\n{}",
        rig.trace().report()
    );

    // Chunk positions come from the ledger, not from the pack: this is the
    // part that would silently lie if membership or the pose composition were
    // wrong. An intact structure has not moved, so they must agree with where
    // it was authored.
    let positions = rig.chunk_positions();
    assert_eq!(positions.len(), pack.nodes.len());
    let worst = positions
        .iter()
        .zip(&pack.nodes)
        .map(|(now, node)| (*now - node.centroid).length())
        .fold(0.0f32, f32::max);
    assert!(
        worst < 0.05,
        "a standing building's chunks moved up to {worst:.3} m from where they were authored — \
         the ledger is composing poses wrong"
    );

    // And it says so the other way round too.
    let all: Vec<u32> = (0..pack.nodes.len() as u32).collect();
    assert!(
        rig.median_drop(&all).abs() < 0.05,
        "median drop of a standing building should be ~0"
    );
}

/// Roles select real chunks, and cutting them produces a smaller building whose
/// bonds still make sense.
#[test]
fn surgery_removes_chunks_and_keeps_the_bond_graph_consistent() {
    let pack = load(SMALL);

    let posts = select_nodes(&pack, &NodeSel::role("post"));
    let roles: std::collections::BTreeSet<&str> =
        pack.node_types.iter().map(String::as_str).collect();
    assert!(
        !posts.is_empty(),
        "{SMALL} has no chunks tagged 'post'; it does have {roles:?}"
    );

    let cut = remove_nodes(&pack, &posts);
    assert_eq!(cut.nodes.len(), pack.nodes.len() - posts.len());
    assert_eq!(cut.node_types.len(), cut.nodes.len(), "roles stay parallel");
    assert_eq!(cut.node_pieces.len(), cut.nodes.len(), "pieces stay parallel");
    assert_eq!(cut.node_sizes.len(), cut.nodes.len(), "sizes stay parallel");
    assert_eq!(
        cut.node_colliders.len(),
        cut.nodes.len(),
        "colliders stay parallel"
    );
    assert!(
        cut.bonds.len() < pack.bonds.len(),
        "removing load-bearing chunks must remove their bonds"
    );
    // The renumbering is the part that fails silently: an out-of-range index
    // would be caught, but a WRONG in-range one would just build nonsense.
    for bond in &cut.bonds {
        assert!(
            (bond.node0 as usize) < cut.nodes.len() && (bond.node1 as usize) < cut.nodes.len(),
            "bond references a node that no longer exists"
        );
        assert_ne!(bond.node0, bond.node1, "bond became a self-loop");
    }
    // No surviving chunk kept a role it did not have.
    let survivors: Vec<usize> = (0..pack.nodes.len()).filter(|i| !posts.contains(&(*i as u32))).collect();
    for (new_index, &old_index) in survivors.iter().enumerate() {
        assert_eq!(
            cut.node_role(new_index),
            pack.node_role(old_index),
            "role table slipped out of alignment at {new_index}"
        );
    }

    // And the cut building still installs and runs.
    let mut rig = Rig::spin_up(&cut).expect("install cut pack");
    rig.run_ticks(HZ).expect("tick");
}

/// How long the parking garage actually takes to go quiet.
///
/// Diagnostic for the at-rest gate: `every_structure_stands_under_its_own_weight`
/// gives every structure five seconds, and the garage — flat plates on a sparse
/// grid, the least stiff thing in the set — is the one that sits closest to
/// that edge.
#[test]
fn the_parking_garage_settles() {
    let pack = load("parking-garage");
    let mut rig = Rig::spin_up(&pack).expect("install");
    let settle = rig
        .settle_until(vibe_land_destruction::rig::Quiet { awake_fraction: 0.0, hold_secs: 1.0 }, 20.0)
        .expect("tick");
    eprintln!("[measure] parking-garage settle: {settle:?}, broken {}", rig.broken_bonds());
    eprintln!("{}", rig.trace().report());
    assert!(settle.rested(), "did not settle in 20 s");
    assert_eq!(rig.broken_bonds(), 0, "bonds broke at rest");
}

/// The whole city, standing.
///
/// `authored_structures_sim` proves each building stands alone; this is the
/// scene the server actually serves — all seven at once, 56,595 chunks — and
/// the question it answers is the one that matters before a deploy: does the
/// city hold itself up, or does it quietly eat itself while nobody is
/// connected.
///
/// Ignored by default because it is minutes of GPU and the per-structure tests
/// cover the same ground more cheaply.
#[test]
#[ignore = "heavy: the full skyline scene"]
fn the_whole_skyline_stands() {
    // STANDS_PACK names a different scene, for checking one the server is
    // actually serving rather than the one this test was written against.
    let name = std::env::var("STANDS_PACK").unwrap_or_else(|_| "skyline".into());
    let pack = load(&name);
    let mut rig = Rig::spin_up(&pack).expect("install");
    rig.run_secs(10.0).expect("tick");
    eprintln!(
        "[measure] {name}: {} chunks, {} bonds, {} broken after 10 s\n{}",
        pack.nodes.len(),
        pack.bonds.len(),
        rig.broken_bonds(),
        rig.trace().report()
    );
    let broken = rig.broken_fraction();
    assert!(
        broken < 0.005,
        "the city broke {:.2}% of its own bonds standing still",
        broken * 100.0
    );
}
