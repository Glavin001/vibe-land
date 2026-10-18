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

use vibe_land_destruction::rig::audit::{audit, hops_to_ground, Outcome};
use vibe_land_destruction::rig::freshness::assert_pack_fresh;
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

/// The settling budget, scaled to how deep the structure's load path is.
///
/// A flat bar in seconds is really a bar on height. Conjugate gradient moves
/// information about one hop per iteration, so a structure whose farthest
/// chunk is 67 joints from an anchor cannot settle as fast as one at 7,
/// however well either is built -- the parking garage settles in 4 s over 19
/// hops while a taller component stack with FEWER chunks never does.
///
/// So the budget is depth-proportional, fitted to the structures that are
/// sound: 7 hops settling at 0 s and 19 hops at 4 s, with generous slack
/// because the gate is meant to catch buildings that do not settle, not to
/// police the ones that do.
fn settle_budget_secs(hops: u32) -> f32 {
    4.0 + hops as f32 * 0.5
}

/// How long the audit is allowed to run, given the budget.
///
/// This is NOT the bar, and conflating them is a mistake I made and had to
/// unpick. Convergence is defined as ten consecutive seconds of quiet, so the
/// earliest any structure can be DECLARED converged is at ten seconds, and a
/// structure that goes quiet at seven needs seventeen to prove it. Capping at
/// fifteen therefore failed Villa Savoye, which settles at seven and is fine.
///
/// So the cap is the bar plus the quiet window, plus a little slack.


/// Raise the cap for investigation: `AUDIT_MAX_SECS=120 cargo test ...`.
///
/// The gate never wants this -- a structure over the bar has failed and
/// watching it longer does not change that. It is for asking "how long does
/// this actually take", which is a different question and the one that found
/// the delayed collapse in 432 Park.
fn cap_secs(budget: f32) -> f32 {
    std::env::var("AUDIT_MAX_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        // The budget plus the ten-second quiet window convergence needs to be
        // DECLARED, plus slack. Conflating the two once failed Villa Savoye,
        // which settles at seven and is fine.
        .unwrap_or(budget + 14.0)
}

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    // Before anything else: is this pack built from the sources on disk? A
    // failed `node build.mjs` leaves the previous one in place and every
    // number below then describes the wrong building.
    assert_pack_fresh(&path);
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// Assert a structure settles inside the bar, breaking nothing.
///
/// On failure it prints the diagnostic card, because "comp_stack failed" is
/// not actionable and "slab<->wall, 80% of the run, y=4 m" is.
fn assert_stable(name: &str) {
    let pack = load(name);
    let hops = hops_to_ground(&pack);
    let budget = settle_budget_secs(hops);
    let report = audit(&pack, cap_secs(budget));

    let why = match &report.outcome {
        Outcome::Converged { at, broke_total } if *broke_total == 0 => {
            assert!(
                *at <= budget,
                "{name}: settles, but not until {at:.0} s, against a {budget:.0} s \
                 budget for its {hops}-hop load path. Slow settling is a structural \
                 property, not a solver setting -- either something is badly \
                 conditioned, or the load path is longer than it needs to be."
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
    // What actually broke, earliest first. This is the line that says where to
    // look; the persistent list below says what was merely working hard, and
    // they are routinely different joints.
    let broke: Vec<String> = report
        .breaks
        .iter()
        .take(5)
        .map(|b| {
            format!(
                "#{} BROKE at {:.0} s, {} {} at y={:.0}m over {:.3} m2, last seen at {:.2}x",
                b.id, b.at, b.mode, b.class, b.height, b.area, b.last_util
            )
        })
        .collect();
    let broke_line = if broke.is_empty() {
        "  (nothing broke -- the load simply never stopped moving)".to_string()
    } else {
        format!("  {}", broke.join("\n  "))
    };
    panic!(
        "{name}: {why}\n  peak {:.2} -> {:.2}, sag {:.2} m ({})\n{}\n  \
         joint classes by time overloaded: {}\n  {}",
        report.early_peak,
        report.late_peak,
        report.peak_sag,
        if report.sag_role.is_empty() { "-" } else { &report.sag_role },
        broke_line,
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
