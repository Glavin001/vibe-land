//! What the authored structures actually DO when simulated.
//!
//! `authored_structures.rs` checks that the packs parse and build; the
//! generator's own `verify.mjs` checks their geometry and a static load model.
//! Neither can answer the questions that decide whether a building is any good
//! to play with, because all three are analyses of a file:
//!
//!   1. does it stand up under its own weight,
//!   2. does shooting the outside take cladding off WITHOUT collapsing it,
//!      while the frame still gives way to a big enough hit, and
//!   3. when it does come down, does it break up?
//!
//! Those are properties of the solver, and the static model is a poor proxy for
//! it: it under-reports stress on a tall frame by roughly 2x, and it passed the
//! stair for weeks while every tread hung over a void. So these run the real
//! thing — PhysX plus the Blast stress solver, the same path the match server
//! takes — and assert on what comes out.
//!
//! The world setup, tick loop and pack surgery live in `destruction::rig`,
//! shared with the scenario suite and the trace recorder, so all three drive
//! the structures through one path. The assertions below are unchanged from
//! when this file built its own world: that is what makes them a check on the
//! harness as well as on the buildings.
//!
//! Gated on the `physx` feature, so an ordinary `cargo test` on a machine
//! without PhysX/CUDA still builds and runs the rest of the suite:
//!
//!     cargo test -p vibe-land-destruction --features physx --test authored_structures_sim
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};

use vibe_land_destruction::city_config::ShotProfile;
use vibe_land_destruction::rig::surgery::rotated_and_raised;
use vibe_land_destruction::rig::{Quiet, Rig, HZ};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack};

/// The city's own shot, so "a hit" here means what a player's hit means rather
/// than a number chosen to make the test pass.
fn shot_profile() -> ShotProfile {
    ShotProfile::city()
}

fn pack_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"))
}

fn load(name: &str) -> ScenePack {
    load_scene_pack_file(&pack_path(name)).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

fn spin_up(pack: &ScenePack) -> Rig {
    Rig::spin_up(pack).expect("install destructible")
}

/// Every structure, so a regression in one is not hidden by another passing.
const ALL: [&str; 8] = [
    "algedra-tower", "house-1story", "house-2story", "villa-savoye", "minas-tirith",
    "park-432", "parking-garage", "petronas",
];

// ── 1. it stands up ─────────────────────────────────────────────────────────

#[test]
fn every_structure_stands_under_its_own_weight() {
    for name in ALL {
        let pack = load(name);
        let bonds: usize = pack.bonds.len();
        let mut rig = spin_up(&pack);

        // How long settling takes depends on how far anything shed can fall.
        // Five seconds is ample for a house and was ample for every tower here,
        // but Minas Tirith stands 112 m and a chunk let go at the Citadel needs
        // 4.8 s just to reach the ground, then rolls down seven terraces — a
        // flat budget reported a city that was settling perfectly well as one
        // that "never came to rest". Scaled by free-fall time from the top, so
        // the shorter structures are unaffected.
        let top = pack
            .nodes
            .iter()
            .map(|n| n.centroid.y)
            .fold(f32::MIN, f32::max)
            .max(0.0);
        let budget = 5.0 + 2.0 * (2.0 * top / 9.81).sqrt();
        let settle = rig.settle_until(Quiet::default(), budget).expect("tick");
        let stats = rig.destruction.stats();

        // A handful of bonds letting go as the solver finds equilibrium is
        // normal; a structure coming apart is not. One in two hundred is far
        // above what these currently do (zero) and far below a collapse.
        let broken_fraction = stats.broken_bonds as f64 / bonds as f64;
        assert!(
            broken_fraction < 0.005,
            "{name}: {} of {bonds} bonds broke under gravity alone ({:.2}%) — it is collapsing, \
             not settling",
            stats.broken_bonds, broken_fraction * 100.0,
        );
        assert!(
            settle.rested(),
            "{name}: {} bodies still moving after {budget:.0} s — it never came to rest",
            stats.awake_chunk_bodies,
        );
        assert!(
            stats.min_body_y > -1.0,
            "{name}: something fell to y={:.2}, through the ground",
            stats.min_body_y,
        );
    }
}

// ── 2. cladding comes off; the frame does not ───────────────────────────────

/// A point on the outside of the structure, at about a third of its height —
/// where a player standing in the street would actually hit it.
fn facade_aim(pack: &ScenePack) -> ([f32; 3], [f32; 3]) {
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for node in &pack.nodes {
        let c = [node.centroid.x, node.centroid.y, node.centroid.z];
        for a in 0..3 {
            lo[a] = lo[a].min(c[a]);
            hi[a] = hi[a].max(c[a]);
        }
    }
    let band = lo[1] + (hi[1] - lo[1]) * 0.33;

    // Aim at an actual CHUNK on the +X side at about a third of the height,
    // not at a point computed from the bounding box. The parking garage's +X
    // face is its open ramp bay, so a geometric aim put the shot in mid-air and
    // it broke nothing — which read as "the building is indestructible" when it
    // meant "the test missed".
    let mut best = None;
    let mut best_x = f32::MIN;
    for node in &pack.nodes {
        if (node.centroid.y - band).abs() > (hi[1] - lo[1]) * 0.08 {
            continue;
        }
        if node.centroid.x > best_x {
            best_x = node.centroid.x;
            best = Some(node.centroid);
        }
    }
    let c = best.unwrap_or_else(|| pack.nodes[0].centroid);
    ([c.x, c.y, c.z], [-1.0, 0.0, 0.0])
}

#[test]
fn a_shot_damages_the_facade_without_starting_a_collapse() {
    for name in ALL {
        let pack = load(name);
        let mut rig = spin_up(&pack);
        rig.run_ticks(HZ * 2).expect("tick");
        // A CONTROL, measured on this building rather than assumed. Some of
        // these are still settling at two seconds -- the walled city sheds a
        // hundred-odd bonds finding its equilibrium and then stops -- and
        // without a baseline that shedding is indistinguishable from a
        // collapse the shot started. It is not: it happens whether or not
        // anyone fires. So take the building's own rate first, over the same
        // kind of window, and hold the shot to a standard above it.
        let control_start = rig.destruction.stats().broken_bonds;
        rig.run_ticks(HZ * 2).expect("tick");
        let before = rig.destruction.stats().broken_bonds;
        let background_per_sec = (before.saturating_sub(control_start)) as f32 / 2.0;

        let (center, direction) = facade_aim(&pack);
        rig.shot(center, direction, shot_profile()).expect("shot");

        // The burst: everything the hit itself takes out.
        rig.run_ticks(HZ).expect("tick");
        let burst = rig.destruction.stats().broken_bonds.saturating_sub(before);
        // The aftermath: what the building does about it. Eight seconds,
        // for the same reason the drop test needs fifteen — debris off a hit
        // takes a while to stop moving, and cutting it short cannot tell a
        // settling pile from a spreading failure.
        rig.run_ticks(HZ * 8).expect("tick");
        let end = rig.destruction.stats();
        let after = end.broken_bonds.saturating_sub(before);
        let cascade = after.saturating_sub(burst);

        assert!(burst > 0, "{name}: a shot at the facade broke nothing at all");

        // "Does not collapse" is not a bond count — a 2.5 m blast is a big
        // fraction of a small house and almost nothing of a tower, so any
        // fixed fraction is really a size test. What distinguishes damage from
        // collapse is whether it SPREADS: a hole stops growing once the hit is
        // over, a collapse keeps taking the structure apart for seconds after.
        // Nine seconds of aftermath, so the building's own settling accounts
        // for that much of whatever kept breaking.
        let expected_background = (background_per_sec * 9.0).ceil() as u32;
        assert!(
            cascade <= burst + expected_background,
            "{name}: the hit broke {burst} bonds and another {cascade} kept going after,              against {expected_background} expected from this building's own settling              ({background_per_sec}/s measured before the shot) — that is a progressive              collapse, not damage",
        );
        // And it has to come to rest again.
        // Near enough to rest. Not exactly zero: a loosened chunk can sit
        // rocking on the rubble under it for a long time without that meaning
        // anything is still failing.
        let still_moving = end.awake_chunk_bodies as f64 / pack.nodes.len() as f64;
        assert!(
            still_moving < 0.05,
            "{name}: {} of {} bodies still moving 8 s after a single shot — it has not stopped \
             coming apart",
            end.awake_chunk_bodies, pack.nodes.len(),
        );
    }
}

#[test]
fn the_frame_needs_a_bigger_hit_than_the_cladding() {
    // The tower is the case that matters: a concrete frame behind a glass and
    // panel skin, which is exactly the arrangement that should show a
    // difference between grazing the outside and hitting the structure.
    let name = "algedra-tower";
    let pack = load(name);

    let measure = |stress: f32, push: f32| {
        let mut rig = spin_up(&pack);
        rig.run_ticks(HZ * 2).expect("tick");
        let before = rig.destruction.stats().broken_bonds;
        let (center, direction) = facade_aim(&pack);
        let profile = ShotProfile {
            stress_impulse: stress,
            push_speed: push,
            ..shot_profile()
        };
        rig.shot(center, direction, profile).expect("blast");
        rig.run_ticks(HZ * 3).expect("tick");
        rig.destruction.stats().broken_bonds.saturating_sub(before)
    };

    let base = shot_profile();
    let shot = measure(base.stress_impulse, base.push_speed);
    let heavy = measure(base.stress_impulse * 40.0, base.push_speed * 4.0);

    assert!(
        heavy > shot,
        "{name}: a 40x hit broke {heavy} bonds against {shot} for a normal shot — the frame is \
         no harder to break than the skin it is behind",
    );
}

// ── 3. a building that falls comes apart ────────────────────────────────────

/// Rolling a structure onto its side and lifting it off the ground is the
/// cheapest honest way to ask "what happens when it comes down": toppling one
/// properly means shooting out a support and waiting tens of seconds, while
/// dropping it flat applies the same kind of load — a whole building's weight
/// arriving at the ground at once — in a second and a half.
///
/// `rig::surgery::rotated_and_raised` does the transform; see it for why a
/// quarter turn is the only exact one.

#[test]
fn a_dropped_building_breaks_up_instead_of_landing_in_one_piece() {
    // The heavy concrete structures only.
    //
    // Not an oversight, and not a bar quietly lowered until it passed: the
    // stress solver does not break a light FREE body on impact, and the
    // upstream notes say so outright — "an impact on a free object becomes
    // momentum, not internal stress". A dropped building has no supports, so it
    // is exactly that free body, and what tears it apart on landing is its own
    // weight arriving. The tower has 14,658 t of it and comes apart; the
    // two-storey house has 213 t and settles with 23 pieces off it and 4.4% of
    // its bonds gone, however weak its masonry is made. Halving brick, stone
    // and timber moved that by less than a percentage point.
    //
    // So a small light structure needs a different mechanism to shatter — the
    // impulse-threshold damage layer, which exists in the TS/Rapier path and
    // not in this one. Asserting it here would only be asserting that a known
    // gap has not closed.
    for name in ["algedra-tower", "park-432"] {
        let upright = load(name);
        let pack = rotated_and_raised(&upright, 18.0);
        let bonds = pack.bonds.len();
        let chunks = pack.nodes.len();
        let mut rig = spin_up(&pack);

        // Fall, land, and come apart. Fifteen seconds, not five: a concrete
        // building this size is still actively breaking up at six. Measured on
        // the tower — 3.2% of bonds gone at 2 s, 8.2% at 6 s, 26.3% at 14 s,
        // then flat. Stopping at six reads a collapse in progress as a
        // building that survived.
        // Fall, land, and come apart. Fifteen seconds, not five: a concrete
        // building this size is still actively breaking up at six. Measured on
        // the tower — 3.2% of bonds gone at 2 s, 8.2% at 6 s, 26.3% at 14 s,
        // then flat. Stopping at six reads a collapse in progress as a
        // building that survived.
        rig.run_ticks(HZ * 15).expect("tick");
        let stats = rig.destruction.stats();

        // The building has to come apart. A fifth of its bonds is a lot of
        // damage and still far short of total disintegration.
        // 8%, against 13-27% measured across runs. The bar is well under the
        // range on purpose: how a building lands is chaotic and the GPU solver
        // is not bit-deterministic, so the same drop gave 13.2% one run and
        // 26.3% another. What this has to separate is coming apart from not,
        // and "not" was the 6.0% this scored before concrete stopped having a
        // ductility band of 10.
        let broken = stats.broken_bonds as f64 / bonds as f64;
        assert!(
            broken > 0.08,
            "{name}: dropped from 18 m it broke only {} of {bonds} bonds ({:.1}%) — it landed \
             essentially in one piece",
            stats.broken_bonds, broken * 100.0,
        );

        // And it has to come apart into MANY pieces, not two. `chunk_bodies`
        // counts the rigid islands the structure is currently in; one island
        // holding everything is exactly the failure in the screenshot that
        // started this.
        assert!(
            stats.chunk_bodies as f64 > (chunks as f64) * 0.05,
            "{name}: {} rigid bodies out of {chunks} chunks after impact — the debris is a \
             handful of monoliths",
            stats.chunk_bodies,
        );
    }
}
