//! A repeatable structural audit for an authored building.
//!
//! The loop this exists to support: the solver can now tell us a structure
//! never reaches equilibrium, and the per-bond readout can tell us WHERE it is
//! straining. Between them, "this building is wrong" becomes "this joint
//! class, at this height, in this mode, is carrying more than it can" -- which
//! is something an author can act on.
//!
//! It asks four questions, in the order that makes the answers useful:
//!
//!   1. Does it settle?  A sound structure reaches a steady stress state in
//!      about a second. One that never does is not settling slowly, it is
//!      failing -- and every later number is measured mid-collapse.
//!   2. Is anything over its limit standing still?  Nothing should be.
//!   3. Where is the load concentrated?  Means far below maxima mean a few
//!      joints are carrying what the rest is not.
//!   4. Is it still destructible?  A building that survives its own weight by
//!      being indestructible has traded one bug for a worse one, so the audit
//!      fires a shot and insists it does something.
//!
//!     cargo test -p vibe-land-destruction --features cuda-stress \
//!       --test structural_audit --release -- --nocapture
//!
//! AUDIT_PACKS=name,name limits it; default is every authored building.
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::city_config::ShotProfile;
use vibe_land_destruction::rig::{Rig, HZ};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

const DEFAULT_PACKS: &[&str] = &[
    "house-1story", "house-2story", "villa-savoye", "parking-garage",
    "algedra-tower", "park-432", "petronas",
];

/// Ticks a structure gets to reach a steady stress state before we call it
/// unsettled. Sound buildings in this set take 4 to 70.
const SETTLE_BUDGET_TICKS: u32 = 600;

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

struct Audit {
    settled_tick: Option<u32>,
    peak: f32,
    over_limit: usize,
    mean_of_hottest_class: f32,
    hottest_class: String,
    worst: Vec<String>,
    shot_broke: u32,
    bonds: usize,
}

fn audit(name: &str) -> Audit {
    let pack = load(name);
    let mut rig = Rig::spin_up(&pack).expect("install");

    // 1. settle
    let mut last = 0.0f32;
    let mut steady_since: Option<u32> = None;
    let mut settled_tick = None;
    for tick in 1..=SETTLE_BUDGET_TICKS {
        rig.run_ticks(1).expect("tick");
        let peak = rig.stress_report().bonds.first().map(|b| b.utilisation).unwrap_or(0.0);
        if (peak - last).abs() <= 0.01 * last.max(1e-6) {
            match steady_since {
                None => steady_since = Some(tick),
                Some(since) if tick - since >= 30 => { settled_tick = Some(since); break; }
                _ => {}
            }
        } else {
            steady_since = None;
        }
        last = peak;
    }

    // 2-3. where the load is
    let report = rig.stress_report();
    let mut classes: Vec<_> = report.by_role_pair.iter().collect();
    classes.sort_by(|a, b| b.1.max_utilisation.partial_cmp(&a.1.max_utilisation).unwrap());
    let (hottest_class, stats) = classes
        .first()
        .map(|(n, s)| ((*n).clone(), (*s).clone()))
        .unwrap_or_default();
    let worst = report
        .hottest(3)
        .iter()
        .map(|b| {
            format!(
                "{:.2}x {} {}<->{} at y={:.0}m over {:.3}m2",
                b.utilisation,
                b.governing_mode(),
                pack.node_role(b.node0 as usize),
                pack.node_role(b.node1 as usize),
                b.position.y,
                b.area
            )
        })
        .collect();

    // 4. still destructible?
    let before = rig.broken_bonds();
    let (center, direction) = facade_aim(&pack);
    rig.shot(center, direction, ShotProfile::city()).expect("shot");
    rig.run_ticks(HZ * 2).expect("tick");

    Audit {
        settled_tick,
        peak: report.bonds.first().map(|b| b.utilisation).unwrap_or(0.0),
        over_limit: report.over_limit(),
        mean_of_hottest_class: stats.mean_utilisation,
        hottest_class,
        worst,
        shot_broke: rig.broken_bonds().saturating_sub(before),
        bonds: pack.bonds.len(),
    }
}

/// A point on the outside at about a third of the height, aimed inward -- the
/// same aim the shipping sim tests use, so "a hit" means what a player's hit
/// means.
fn facade_aim(pack: &ScenePack) -> ([f32; 3], [f32; 3]) {
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for node in &pack.nodes {
        let c = [node.centroid.x, node.centroid.y, node.centroid.z];
        for a in 0..3 { lo[a] = lo[a].min(c[a]); hi[a] = hi[a].max(c[a]); }
    }
    let band = lo[1] + (hi[1] - lo[1]) * 0.33;
    let mut best = None;
    let mut best_x = f32::MIN;
    for node in &pack.nodes {
        if (node.centroid.y - band).abs() > (hi[1] - lo[1]) * 0.08 { continue; }
        if node.centroid.x > best_x { best_x = node.centroid.x; best = Some(node.centroid); }
    }
    let c = best.unwrap_or_else(|| pack.nodes[0].centroid);
    ([c.x, c.y, c.z], [-1.0, 0.0, 0.0])
}

#[test]
#[ignore = "audit: minutes of GPU across every building"]
fn audit_every_building() {
    let names: Vec<String> = std::env::var("AUDIT_PACKS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| DEFAULT_PACKS.iter().map(|s| s.to_string()).collect());

    println!("\n{:<16} {:>9} {:>7} {:>6} {:>10} {:>8}  {}",
        "building", "settles", "peak", "over", "hot class", "shot", "verdict");
    for name in &names {
        let a = audit(name);
        let settles = match a.settled_tick {
            Some(t) => format!("{:.2}s", t as f32 / 60.0),
            None => "never".to_string(),
        };
        // A verdict, in the order the problems have to be fixed: a structure
        // that never settles is failing, so its other numbers are taken
        // mid-collapse and mean little; one that settles but is overloaded is
        // sound-ish but has hot joints; one that is neither is only good if a
        // shot still does something to it.
        let verdict = if a.settled_tick.is_none() {
            "FAILING - never reaches equilibrium"
        } else if a.over_limit > 0 {
            "OVERLOADED - settles, but joints past yield"
        } else if a.shot_broke == 0 {
            "INDESTRUCTIBLE - sound, but a shot does nothing"
        } else {
            "sound"
        };
        println!("{:<16} {:>9} {:>7.2} {:>6} {:>10} {:>8}  {}",
            name, settles, a.peak, a.over_limit,
            a.hottest_class.chars().take(10).collect::<String>(),
            a.shot_broke, verdict);
        for w in &a.worst {
            println!("{:<16}   worst: {w}", "");
        }
        println!("{:<16}   {} bonds, hottest class mean {:.3}", "", a.bonds, a.mean_of_hottest_class);
    }
}
