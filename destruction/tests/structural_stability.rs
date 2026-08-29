//! Every structure must stand on its own, quickly, without breaking.
//!
//! One test per structure, named after it, so the runner does what it is good
//! at: `cargo test comp_room` selects, failures report themselves, and a
//! regression fails a build instead of printing into a log nobody reads. The
//! audit itself lives in `vibe_land_destruction::rig::audit`; this file is
//! only the contract.
//!
//! ## The bar
//!
//! A sound structure settles in seconds. That is not an aspiration, it is what
//! the sound ones measured: houses at 0 s, the parking garage at 4, a room at
//! 0, a four-storey stack at 1. So the bar is ten seconds with nothing broken,
//! and a structure needing longer is telling you about itself rather than
//! about the solver.
//!
//! Iterations stay at the shipping 32. Raising them until a building looks
//! stable measures the dial, not the building -- and is not available at
//! runtime anyway: 128 costs 56 ms/tick on a large structure against a 16.7 ms
//! frame.
//!
//! ## Tiers
//!
//! Components and their compositions run BY DEFAULT: seconds each, the units
//! everything else is built from, and the things most worth protecting.
//! Whole buildings are ignored by default because a tower would dominate a
//! routine `cargo test`; run them with `-- --ignored` before shipping a
//! structure change.
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::rig::audit::{audit, Outcome};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

/// Seconds a structure gets before it has failed. Just above the ten-second
/// bar, so a verdict says which side of it the structure fell on.
const BAR_SECS: f32 = 15.0;

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// Assert a structure settles inside the bar, breaking nothing.
///
/// On failure it prints the diagnostic card, because "comp_stack failed" is
/// not actionable and "slab<->wall, 80% of the run, y=4 m" is.
fn assert_stable(name: &str) {
    let pack = load(name);
    let report = audit(&pack, BAR_SECS);

    let why = match &report.outcome {
        Outcome::Converged { at, broke_total } if *broke_total == 0 => {
            assert!(
                *at <= 10.0,
                "{name}: settles, but takes {at:.0} s. The bar is 10 s. Slow \
                 settling is a structural property, not a solver setting -- \
                 something in here is badly conditioned."
            );
            return;
        }
        Outcome::Converged { at, broke_total } => format!(
            "settles at {at:.0} s but sheds {broke_total} bonds getting there; a \
             structure that has to break in order to stand up is not standing up"
        ),
        Outcome::Unresolved { broke_total, last_break_at, .. } => match last_break_at {
            Some(t) => format!(
                "never settles: {broke_total} bonds broken, most recently at {t:.0} s"
            ),
            None => "never settles: nothing broke, but the load never stopped moving".into(),
        },
    };

    let classes: Vec<String> = report
        .class_load
        .iter()
        .map(|(c, n)| format!("{c} ({n})"))
        .collect();
    let worst: Vec<String> = report
        .persistent
        .iter()
        .take(3)
        .map(|(id, h)| {
            format!(
                "{id} {}% of run, mean {:.2}, {} {} at y={:.0}m over {:.3} m2",
                h.hot_samples * 100 / h.seen.max(1),
                h.sum / h.seen as f32,
                h.mode,
                h.class,
                h.height,
                h.area
            )
        })
        .collect();
    panic!(
        "{name}: {why}\n  peak {:.2} -> {:.2}\n  joint classes by time overloaded: {}\n  {}",
        report.early_peak,
        report.late_peak,
        classes.join(", "),
        worst.join("\n  "),
    );
}

// ── components: the units everything else is composed from ──────────────────

#[test]
fn comp_wall_bay_is_stable() { assert_stable("comp-wall-bay"); }

#[test]
fn comp_frame_bay_is_stable() { assert_stable("comp-frame-bay"); }

#[test]
fn comp_room_is_stable() { assert_stable("comp-room"); }

#[test]
fn comp_storey_is_stable() { assert_stable("comp-storey"); }

#[test]
fn comp_stack_is_stable() { assert_stable("comp-stack"); }

// ── composition: stability has to survive repetition ────────────────────────
//
// A bay proven alone has been proven alone. The middle of a row carries its
// neighbours' thrust, which is a different problem.

#[test]
fn wall_bays_compose_in_a_row() {
    for n in [2, 4, 8] {
        assert_stable(&format!("comp-wall-bay-x{n}"));
    }
}

#[test]
fn frame_bays_compose_in_a_row() {
    for n in [2, 4, 8] {
        assert_stable(&format!("comp-frame-bay-x{n}"));
    }
}

// ── whole buildings: slower, so opt in ──────────────────────────────────────

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn house_1story_is_stable() { assert_stable("house-1story"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn house_2story_is_stable() { assert_stable("house-2story"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn villa_savoye_is_stable() { assert_stable("villa-savoye"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn parking_garage_is_stable() { assert_stable("parking-garage"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn park_432_is_stable() { assert_stable("park-432"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn petronas_is_stable() { assert_stable("petronas"); }

#[test]
#[ignore = "slow: run before shipping a structure change"]
fn minas_tirith_is_stable() { assert_stable("minas-tirith"); }
