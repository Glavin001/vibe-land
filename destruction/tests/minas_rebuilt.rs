//! Converge -> become inactive -> skip work -> wake on damage -> resettle.
//! MINAS_MAX_UPDATES bounds failure to converge; it never defines success.
#![cfg(feature = "cuda-stress")]
use std::path::Path;
use vibe_land_destruction::{
    city_config::ShotProfile, equilibrium::EquilibriumSample, rig::Rig,
    scene_pack::load_scene_pack_file,
};

fn sample(rig: &Rig) -> EquilibriumSample {
    EquilibriumSample::capture(&rig.destruction.stats(), rig.destruction.extra_spans())
        .expect("explicit convergence diagnostics must be available")
}

fn converge(rig: &mut Rig, max_updates: u32, pristine: bool) -> EquilibriumSample {
    for update in 0..max_updates {
        rig.step().expect("physics update");
        let state = sample(rig);
        if pristine {
            assert_eq!(
                state.broken_bonds, 0,
                "spontaneous damage at update {update}: {state:?}"
            );
        }
        if state.is_inactive() {
            // Cross a real update boundary and prove that the inactive result
            // is reused. No quiet-period duration or FPS threshold involved.
            rig.step().expect("idle update");
            let next = sample(rig);
            assert!(
                next.skipped_since(&state),
                "inactive structure performed work or changed: {state:?} -> {next:?}"
            );
            return next;
        }
    }
    panic!(
        "did not reach stable, inactive equilibrium within {max_updates} updates: {:?}",
        sample(rig)
    );
}

#[test]
#[ignore = "requires exclusive GPU access; run with --ignored --test-threads=1"]
fn city_converges_skips_work_and_wakes_on_damage() {
    let name = std::env::var("MINAS_TEST_SCENE").unwrap_or("minas-tirith-rebuilt".into());
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    let pack = load_scene_pack_file(&path).expect("scene parses");
    if name == "minas-tirith-rebuilt" {
        for (i, node) in pack.nodes.iter().enumerate() {
            assert_eq!(
                node.is_support(),
                pack.node_role(i) == "foundation",
                "fixed architecture at {i}"
            );
        }
    }
    let max_updates = std::env::var("MINAS_MAX_UPDATES")
        .map(|s| {
            s.parse::<u32>()
                .expect("MINAS_MAX_UPDATES must be a positive integer")
        })
        .unwrap_or(4096);
    assert!(max_updates > 0);
    let mut rig = Rig::spin_up(&pack).expect("physics scene");
    let mut resting = converge(&mut rig, max_updates, true);
    assert!(
        rig.destruction.stats().gpu_stress_structures > 0,
        "gate requires the CUDA stress backend"
    );
    eprintln!("{name} reached intact inactive equilibrium: {resting:?}");
    if name != "minas-tirith-rebuilt" {
        return;
    }

    for role in ["wall", "roof", "road", "tower-wall", "pier", "spire"] {
        let index = pack
            .nodes
            .iter()
            .enumerate()
            .find(|(i, n)| !n.is_support() && pack.node_role(*i) == role)
            .expect("architectural category")
            .0;
        // Earlier destruction can move later targets. Aim at the current
        // position, not the authored position of a piece that may have fallen.
        let c = rig.chunk_positions()[index];
        rig.shot([c.x, c.y, c.z], [0.0, -0.2, -1.0], ShotProfile::city())
            .expect("gameplay shot");
        let mut responded = false;
        for _ in 0..max_updates {
            rig.step().expect("disturbed update");
            let state = sample(&rig);
            if state.resumed_since(&resting) && state.broken_bonds > resting.broken_bonds {
                responded = true;
                break;
            }
        }
        assert!(
            responded,
            "{role}: shot did not both invalidate the cached solve and damage architecture: {:?}",
            sample(&rig)
        );
        resting = converge(&mut rig, max_updates, false);
        eprintln!("{role}: woke, broke and returned to inactive equilibrium: {resting:?}");
    }
}
