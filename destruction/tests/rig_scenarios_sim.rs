//! The structural questions, asked of purpose-built rigs.
//!
//! These are the acceptance criteria for "a building behaves like a building":
//!
//!   1. it stands;
//!   2. take out every second column and it still stands;
//!   3. take out every column down one side and the overhang comes down —
//!      but not instantly, and not like glass;
//!   4. a cantilever fails at some length and not before, and the marginal
//!      ones take longer to go than the hopeless ones;
//!   5. something lying on the ground still has weight arriving through
//!      whatever it is touching;
//!   6. a shot does real damage to a column without one shot being the whole
//!      answer.
//!
//! ## Characterize now, enforce later
//!
//! Several of these describe behaviour the simulation does not yet have: rest
//! working stress sits far below the elastic limit, so redistributed load
//! never reaches a threshold and nothing progressive can happen. Writing the
//! assertions first, and running them in a mode that REPORTS instead of
//! failing, gives the physics work a target that is executable rather than
//! prose — and gives us a recorded baseline of what today does.
//!
//! Set `RIG_ENFORCE=1` to turn the aspirational assertions into real ones.
//! Everything not gated is enforced now and must stay green.
//!
//!     cargo test -p vibe-land-destruction --features physx --test rig_scenarios_sim --release
//!
//! ## Assert shapes, not levels
//!
//! PhysX GPU is not bit-reproducible. Every numeric bound here is one-sided
//! and wide, or a statement about ordering over time. Exact stress numbers
//! belong in the deterministic upstream solver tests, not here.
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::city_config::ShotProfile;
use vibe_land_destruction::rig::surgery::{remove_nodes, select_nodes, select_nodes_where, NodeSel};
use vibe_land_destruction::rig::{Quiet, Rig};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

const RIGS: [&str; 7] = [
    "rig-column",
    "rig-portal",
    "rig-cantilever",
    "rig-garage",
    "rig-pane",
    "rig-wall",
    "rig-toppled",
];

fn load(name: &str) -> ScenePack {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"));
    load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

fn enforcing() -> bool {
    std::env::var("RIG_ENFORCE").is_ok_and(|value| value != "0")
}

/// An assertion the physics work has to make true.
///
/// Fails the test under `RIG_ENFORCE`; otherwise prints what it saw, so a run
/// against today's build is a measurement rather than a wall of failures.
macro_rules! expect_eventually {
    ($cond:expr, $($arg:tt)*) => {{
        let held = $cond;
        if !held {
            if enforcing() {
                panic!($($arg)*);
            } else {
                eprintln!("[characterize] {}", format!($($arg)*));
            }
        }
    }};
}

// ── 1. everything stands ────────────────────────────────────────────────────

/// Enforced now. A rig that cannot hold itself up measures nothing.
#[test]
fn every_rig_stands_under_its_own_weight() {
    for name in RIGS {
        let pack = load(name);
        let mut rig = Rig::spin_up(&pack).expect("install");
        let settle = rig
            .settle_until(
                Quiet {
                    awake_fraction: 0.0,
                    hold_secs: 1.0,
                },
                8.0,
            )
            .expect("tick");
        assert!(
            settle.rested(),
            "{name}: never came to rest in 8 s\n{}",
            rig.trace().report()
        );
        assert_eq!(
            rig.broken_bonds(),
            0,
            "{name}: {} bonds broke under gravity alone — these are small structures with a \
             direct load path, so any break at all is the solver eating itself\n{}",
            rig.broken_bonds(),
            rig.trace().report(),
        );
    }
}

// ── 2 and 3. the parking-garage question ────────────────────────────────────

/// Columns on the far side of the grid from `x`, by role.
fn garage_columns(pack: &ScenePack) -> Vec<u32> {
    select_nodes(pack, &NodeSel::role("column"))
}

/// The top deck, whose descent is what "it collapsed" means here.
fn top_deck(pack: &ScenePack) -> Vec<u32> {
    let highest = pack
        .nodes
        .iter()
        .map(|node| node.centroid.y)
        .fold(f32::MIN, f32::max);
    select_nodes_where(pack, &NodeSel::role("slab"), |_, node| {
        node.centroid.y > highest - 1.0
    })
}

/// Enforced now, as the guard against overshooting the physics fix.
///
/// Half the columns removed is roughly double the load on the survivors. A
/// real frame carries that: it is why buildings have more columns than the
/// minimum. If this ever starts collapsing, the recalibration went too far and
/// the city will be made of sugar glass.
#[test]
fn a_garage_stands_on_every_second_column() {
    let pack = load("rig-garage");
    let columns = garage_columns(&pack);
    assert!(!columns.is_empty(), "rig-garage has no columns tagged");

    // Checkerboard by bay, not by index: index order is emission order, which
    // is not a spatial pattern.
    let cut: Vec<u32> = columns
        .iter()
        .copied()
        .filter(|&index| {
            let c = pack.nodes[index as usize].centroid;
            let bay = |v: f32| (v / 6.0).round() as i32;
            (bay(c.x) + bay(c.z)) % 2 != 0
        })
        .collect();
    assert!(
        cut.len() > columns.len() / 4,
        "checkerboard picked only {} of {} columns",
        cut.len(),
        columns.len()
    );

    let deck = top_deck(&pack);
    let wounded = remove_nodes(&pack, &cut);
    // Roles survive surgery, so the deck can be re-found in the cut pack.
    let deck_after = top_deck(&wounded);
    assert!(!deck_after.is_empty(), "no top deck after the cut");
    let _ = deck;

    let mut rig = Rig::spin_up(&wounded).expect("install");
    rig.run_secs(20.0).expect("tick");

    let drop = rig.median_drop(&deck_after);
    assert!(
        drop < 0.5,
        "removing every second column dropped the top deck {drop:.2} m — a frame that cannot \
         carry double load on the survivors is too weak to be a building\n{}",
        rig.trace().report(),
    );
}

/// The user's exact complaint, as a test.
///
/// Cut every column on one side and the plates there are a huge cantilever off
/// the remaining grid. That has to come down. It also has to come down like
/// concrete: a beat of holding on, then failure, rather than vanishing the
/// instant the columns go.
#[test]
fn a_garage_collapses_when_one_whole_side_is_cut() {
    let pack = load("rig-garage");
    let columns = garage_columns(&pack);
    let cut: Vec<u32> = columns
        .iter()
        .copied()
        .filter(|&index| pack.nodes[index as usize].centroid.x < 0.0)
        .collect();
    assert!(!cut.is_empty(), "no columns on the -X side");

    let wounded = remove_nodes(&pack, &cut);
    let overhang: Vec<u32> = select_nodes_where(&wounded, &NodeSel::role("slab"), |_, node| {
        node.centroid.x < -2.0 && node.centroid.y > 1.0
    });
    assert!(!overhang.is_empty(), "no unsupported slab left after the cut");

    let mut rig = Rig::spin_up(&wounded).expect("install");
    let mut drops: Vec<(f32, f32)> = Vec::new();
    for _ in 0..25 {
        rig.run_secs(1.0).expect("tick");
        drops.push((rig.secs(), rig.median_drop(&overhang)));
    }

    let report = format!(
        "{}\n  overhang drop by second: {}",
        rig.trace().report(),
        drops
            .iter()
            .map(|(t, d)| format!("{t:.0}s={d:.2}m"))
            .collect::<Vec<_>>()
            .join(" ")
    );

    let peak_util = rig
        .trace()
        .samples
        .iter()
        .map(|s| s.bond_utilisation_max)
        .fold(0.0f32, f32::max);
    let peak_overstressed = rig
        .trace()
        .samples
        .iter()
        .map(|s| s.overstressed_bonds)
        .max()
        .unwrap_or(0);
    eprintln!(
        "[measure] garage, one side cut — peak utilisation {peak_util:.2}, up to          {peak_overstressed} bonds overstressed, {} bonds broken",
        rig.broken_bonds()
    );

    let final_drop = drops.last().map(|(_, d)| *d).unwrap_or(0.0);
    expect_eventually!(
        final_drop > 2.0,
        "a floor plate with every column on one side removed dropped only {final_drop:.2} m in \
         25 s — it is standing on nothing\n{report}"
    );

    // Not instantly, either: it should read as a structure losing a fight, not
    // a light switch. Only meaningful once it collapses at all.
    if final_drop > 2.0 {
        let early = drops
            .iter()
            .find(|(t, _)| *t >= 1.0)
            .map(|(_, d)| *d)
            .unwrap_or(0.0);
        expect_eventually!(
            early < 0.5,
            "the overhang had already fallen {early:.2} m one second in — that is glass, not \
             concrete accumulating stress\n{report}"
        );
    }
}

// ── 4. the ductility window ─────────────────────────────────────────────────

/// How far each rung of the ladder has sagged, by role.
fn rung_drops(rig: &Rig, pack: &ScenePack, rungs: usize) -> Vec<f32> {
    (1..=rungs)
        .map(|n| {
            let chunks = select_nodes(pack, &NodeSel::role(&format!("rung-{n}")));
            if chunks.is_empty() {
                0.0
            } else {
                rig.median_drop(&chunks)
            }
        })
        .collect()
}

/// A short cantilever holds, a long one does not, and the ones in between fail
/// in order.
///
/// The ORDERING is the assertion, not the lengths: a suffix of the ladder
/// fails and the rest holds. That survives simulator jitter in a way "rung 4
/// fails at 6.2 s" never could.
#[test]
fn a_cantilever_fails_by_length_and_the_marginal_ones_take_longer() {
    let pack = load("rig-cantilever");
    const RUNGS: usize = 6;
    let mut rig = Rig::spin_up(&pack).expect("install");

    let mut failed_at: Vec<Option<f32>> = vec![None; RUNGS];
    for _ in 0..30 {
        rig.run_secs(1.0).expect("tick");
        let drops = rung_drops(&rig, &pack, RUNGS);
        for (index, drop) in drops.iter().enumerate() {
            if failed_at[index].is_none() && *drop > 1.0 {
                failed_at[index] = Some(rig.secs());
            }
        }
    }

    let drops = rung_drops(&rig, &pack, RUNGS);
    let report = format!(
        "{}\n  rung drop: {}\n  failed at: {:?}",
        rig.trace().report(),
        drops
            .iter()
            .enumerate()
            .map(|(i, d)| format!("{}m={:.2}", i + 1, d))
            .collect::<Vec<_>>()
            .join(" "),
        failed_at,
    );

    eprintln!(
        "[measure] cantilever ladder — drop {} | failed at {}",
        drops
            .iter()
            .enumerate()
            .map(|(i, d)| format!("{}m={:.2}", (i + 1) * 2, d))
            .collect::<Vec<_>>()
            .join(" "),
        failed_at
            .iter()
            .enumerate()
            .map(|(i, t)| match t {
                Some(secs) => format!("{}m={secs:.0}s", (i + 1) * 2),
                None => format!("{}m=held", (i + 1) * 2),
            })
            .collect::<Vec<_>>()
            .join(" "),
    );

    // Enforced now: the shortest cantilever is a 2 m shelf. If that cannot
    // hold, nothing about the ladder is measuring overhang.
    assert!(
        drops[0] < 0.5,
        "the 2 m shelf sagged {:.2} m — the rig is broken, not the physics\n{report}",
        drops[0]
    );

    // Failures form a suffix: no rung fails while a longer one holds.
    let first_failure = failed_at.iter().position(Option::is_some);
    if let Some(first) = first_failure {
        let all_longer_failed = failed_at[first..].iter().all(Option::is_some);
        expect_eventually!(
            all_longer_failed,
            "rung {} failed but a longer one held — failure is not ordered by overhang\n{report}",
            first + 1
        );
    }

    expect_eventually!(
        failed_at[RUNGS - 1].is_some(),
        "the 12 m cantilever never failed in 30 s — a floor slab reaching twelve metres into \
         thin air is holding itself up\n{report}"
    );

    // The window: something nearer its limit should take LONGER to let go than
    // something far past it. That is what stress accumulating over time looks
    // like from outside, and it is the effect that makes a delayed collapse
    // read as a building straining rather than a timer expiring.
    if let (Some(long), Some(marginal)) = (failed_at[RUNGS - 1], failed_at[RUNGS - 3]) {
        expect_eventually!(
            marginal >= long,
            "the 8 m cantilever failed at {marginal:.0}s, before the 12 m one at {long:.0}s — \
             failure time does not track how overloaded a thing is\n{report}"
        );
    }
}

// ── 5. weight still arrives through whatever is touching ────────────────────

/// A slab hanging off a ledge is loaded where it bears, not nowhere.
///
/// This is the toppled-building case in miniature. A structure that is no
/// longer standing on its foundations is not weightless: it rests on
/// something, and that contact is where it should crush.
#[test]
fn a_slab_on_one_ledge_is_loaded_where_it_bears() {
    let pack = load("rig-toppled");
    let mut rig = Rig::spin_up(&pack).expect("install");
    rig.run_secs(15.0).expect("tick");

    let report = rig.trace().report();
    let strained = rig
        .trace()
        .samples
        .iter()
        .any(|sample| sample.bond_utilisation_max > 0.25);
    expect_eventually!(
        strained,
        "a 9 m slab carried on a 1.5 m ledge never exceeded a quarter of its elastic limit \
         anywhere — the overhang is not being felt at all\n{report}"
    );
}

// ── 6. a shot is a real load ────────────────────────────────────────────────

/// A hit on a column does something, and one hit is not the whole story.
///
/// Deliberately not "N shots destroys a column": the shot is a physical event
/// whose effect follows from its energy and the section it hits, and how many
/// it takes is an OUTCOME to be measured. What is asserted is that the outcome
/// is in the band where a weapon is interesting — it damages, and it does not
/// trivially erase.
#[test]
fn a_shot_damages_a_column_without_erasing_it() {
    let pack = load("rig-column");
    let columns = select_nodes(&pack, &NodeSel::role("column"));
    assert!(!columns.is_empty(), "rig-column has no column");

    let target = pack.nodes[columns[0] as usize].centroid;
    let mut rig = Rig::spin_up(&pack).expect("install");
    rig.run_secs(1.0).expect("tick");
    let before = rig.broken_bonds();

    rig.shot(
        [target.x + 2.0, target.y, target.z],
        [-1.0, 0.0, 0.0],
        ShotProfile::city(),
    )
    .expect("shot");
    rig.run_secs(3.0).expect("tick");
    let hit = rig.broken_bonds().saturating_sub(before);

    assert!(
        hit > 0,
        "a direct hit on a concrete column broke nothing\n{}",
        rig.trace().report()
    );
    eprintln!(
        "[measure] one city shot on a {:.2} m column broke {hit} of {} bonds",
        target.y * 2.0,
        pack.bonds.len()
    );
}

// ── the calibration measurement ─────────────────────────────────────────────

/// What fraction of its strength each rig is actually using, standing still.
///
/// This is the number the whole exercise turns on. A structure resting at 4%
/// of its elastic limit has no route to progressive collapse: removing half
/// its supports doubles 4% to 8%, which is still nothing, so load redistributes
/// and nothing anywhere gets closer to failing. Damage only accrues ABOVE the
/// elastic limit, so below it a structure is not merely safe, it is immortal.
///
/// Prints rather than asserts: it is an instrument, and the thing it measures
/// is what the material calibration has to move.
#[test]
fn measure_rest_utilisation() {
    eprintln!("\n  rig                  rest util_max   overstressed");
    for name in RIGS {
        let pack = load(name);
        let mut rig = Rig::spin_up(&pack).expect("install");
        rig.run_secs(5.0).expect("tick");
        let last = rig.trace().last().copied().unwrap_or_default();
        eprintln!(
            "  {name:<20} {:>12.3}   {:>12}",
            last.bond_utilisation_max, last.overstressed_bonds
        );
    }
}

// ── the original complaint, on the shipping building ────────────────────────

/// Cut every column down one side of the REAL parking garage.
///
/// `a_garage_collapses_when_one_whole_side_is_cut` asks this of a purpose-built
/// rig, which is the right place to iterate. This asks it of the building a
/// player actually stands in, which is the thing that was reported: destroy
/// every pillar except the far edge and the deck stays up as though nothing
/// happened.
#[test]
#[ignore = "diagnostic on a shipping building"]
fn the_real_garage_loses_one_side() {
    let pack = load("parking-garage");
    let columns = select_nodes(&pack, &NodeSel::role("column"));
    assert!(!columns.is_empty(), "parking-garage has no columns tagged");

    // Everything on the -X half, which is the "all the pillars on one side"
    // of the report rather than a checkerboard.
    let cut: Vec<u32> = columns
        .iter()
        .copied()
        .filter(|&i| pack.nodes[i as usize].centroid.x < 0.0)
        .collect();
    let wounded = remove_nodes(&pack, &cut);
    let overhang: Vec<u32> = select_nodes_where(&wounded, &NodeSel::role("slab"), |_, node| {
        node.centroid.x < -2.0 && node.centroid.y > 1.0
    });
    assert!(!overhang.is_empty(), "no unsupported deck after the cut");

    let mut rig = Rig::spin_up(&wounded).expect("install");
    let mut drops = Vec::new();
    for _ in 0..25 {
        rig.run_secs(1.0).expect("tick");
        drops.push((rig.secs(), rig.median_drop(&overhang)));
    }
    let report = rig.stress_report();
    eprintln!(
        "[measure] real garage, {} of {} columns cut from the -X side\n  \
         overhang: {}\n  broken bonds {}, {} bonds over their limit",
        cut.len(),
        columns.len(),
        drops
            .iter()
            .filter(|(t, _)| (*t as u32) % 5 == 0)
            .map(|(t, d)| format!("{t:.0}s={d:.2}m"))
            .collect::<Vec<_>>()
            .join(" "),
        rig.broken_bonds(),
        report.over_limit(),
    );
    eprintln!("{}", report.card(&wounded, "real garage, one side cut"));
}
