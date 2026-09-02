//! What a structure can take, as opposed to what it currently carries.
//!
//! Exploratory rather than a gate: this ramps load until something gives, so
//! it costs minutes and produces a curve to read rather than a pass or a fail.
//! The pass/fail contract lives in structural_stability.rs.
//!
//!     AUDIT_PACKS=comp-room cargo test --test capacity_ramp -- --ignored --nocapture
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::rig::{Rig, HZ};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// How much more than its own weight a structure can carry.
///
/// The rest audit says how hard a thing works standing still. It does not say
/// how much is left, and the obvious shortcut -- headroom = 1/peak -- is wrong
/// four ways: load REDISTRIBUTES when the first joint yields, yield is not
/// failure because a bond past its elastic limit loses area without severing,
/// utilisation is not linear in load, and a structure strong one way can be
/// weak another.
///
/// So this ramps gravity and re-settles at each step, reporting three
/// multipliers rather than one number:
///
///   YIELD     the first joint goes past its elastic limit
///   BREAK     the first bond severs
///   COLLAPSE  it stops reaching equilibrium at all
///
/// The distance between yield and collapse is the ductility margin -- how much
/// warning a structure gives before it goes. A brittle thing has the three
/// numbers on top of each other; a ductile one spreads them out.
///
/// Why gravity rather than a weight on the roof: scaling gravity scales
/// SELF-WEIGHT too, and "how much more of itself can this carry" is exactly
/// what a stack asks of its ground storey. A point load answers a different
/// and less composable question.
///
///     AUDIT_PACKS=comp-room cargo test ... capacity_ramp -- --ignored --nocapture
#[test]
#[ignore = "measurement: minutes per component"]
fn capacity_ramp() {
    let names: Vec<String> = std::env::var("AUDIT_PACKS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| vec!["comp-wall-bay".into()]);
    // Coarse enough to finish, fine enough that the three thresholds usually
    // land in different steps.
    const STEPS: &[f32] = &[1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0];
    // Long enough for the structure to answer at each rung. Components settle
    // in a second or two; this is slack, not a budget.
    const SETTLE_TICKS: u32 = HZ * 6;

    for name in &names {
        let pack = load(name);
        let mut rig = Rig::spin_up(&pack).expect("install");
        let mut yield_at = None;
        let mut break_at = None;
        let mut collapse_at = None;

        println!("\n=== {name} capacity ===");
        for &scale in STEPS {
            rig.set_gravity_scale(scale);
            // Watch DURING the settle, not after it.
            //
            // A bond past its elastic limit loses area until its stress drops
            // back under, so utilisation is self-limiting: sample once at the
            // end of a settle and a structure that spent two seconds at 1.4x
            // reports 0.9 and "nothing past yield". The first version of this
            // ramp did exactly that and reported a masonry wall as unyielding
            // at ten times gravity, which is not a thing masonry does.
            let mut peak: f32 = 0.0;
            let mut over = 0usize;
            for _ in 0..(SETTLE_TICKS / (HZ / 4)) {
                rig.run_ticks(HZ / 4).expect("tick");
                let report = rig.stress_report();
                peak = peak.max(report.bonds.first().map(|b| b.utilisation).unwrap_or(0.0));
                over = over.max(report.over_limit());
            }
            let broken = rig.broken_bonds();

            // Collapse is "cannot hold this at all": a big fraction of the
            // structure gone, rather than a few joints shedding.
            let gone = broken as f32 / pack.bonds.len().max(1) as f32;
            if yield_at.is_none() && over > 0 {
                yield_at = Some(scale);
            }
            if break_at.is_none() && broken > 0 {
                break_at = Some(scale);
            }
            println!(
                "  {scale:>4.1}x gravity: peak {peak:.2}, {over} past yield, {broken} broken ({:.1}%)",
                gone * 100.0
            );
            if gone > 0.02 {
                collapse_at = Some(scale);
                break;
            }
        }

        let show = |v: Option<f32>| match v {
            Some(x) => format!("{x:.1}x"),
            None => "beyond the ramp".to_string(),
        };
        println!(
            "  yields {} | first break {} | collapses {}",
            show(yield_at),
            show(break_at),
            show(collapse_at),
        );
        if let (Some(y), Some(c)) = (yield_at, collapse_at) {
            println!("  ductility margin: {:.1}x between first yield and collapse", c / y);
        }
    }
}
