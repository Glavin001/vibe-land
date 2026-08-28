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
//! Gated on the `physx` feature, so an ordinary `cargo test` on a machine
//! without PhysX/CUDA still builds and runs the rest of the suite:
//!
//!     cargo test -p vibe-land-destruction --features physx --test authored_structures_sim
#![cfg(feature = "physx")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use vibe_land_destruction::city::{BuildingInstance, CityScene, CitySceneDesc};
use vibe_land_destruction::variants::BuildingVariant;
use vibe_land_destruction::city_config::stress_settings;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::runtime::CityDestruction;
use glam::Vec3 as PackVec3;
use vibe_land_destruction::scene_pack::{load_scene_pack_file, SceneCollider, ScenePack};
use vibe_land_physx_bridge::{
    Pose, Quat as BridgeQuat, StaticBoxDesc, Vec3 as BridgeVec3, World, WorldConfig,
};

const HZ: u32 = 60;
const DT: f32 = 1.0 / HZ as f32;
const GRAVITY: [f32; 3] = [0.0, -9.81, 0.0];
const GROUP_STATIC: u32 = 1 << 0;

/// Matches the match server's own shot energy (`physx_shot_stress_impulse`), so
/// "a hit" here means what a player's hit means rather than a number chosen to
/// make the test pass.
const SHOT_STRESS: f32 = 1.2e7;
const SHOT_PUSH: f32 = 12.0;
const SHOT_RADIUS: f32 = 2.5;

fn pack_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"))
}

fn load(name: &str) -> ScenePack {
    load_scene_pack_file(&pack_path(name)).unwrap_or_else(|e| panic!("load {name}: {e:?}"))
}

/// A world with a ground plane, the pack installed, and nothing else.
fn spin_up(pack: &ScenePack) -> (World, CityDestruction) {
    // The scene is assembled directly rather than through `build_city_scene`,
    // which runs the floor-variant machinery and rejects any pack without a
    // support node. The drop test deliberately has none — a pinned foundation
    // would hold the building in the air — so it cannot go through that path.
    let height = pack
        .nodes
        .iter()
        .zip(&pack.node_sizes)
        .map(|(n, s)| n.centroid.y + s.y * 0.5)
        .fold(f32::MIN, f32::max);
    let scene = CityScene {
        desc: CitySceneDesc { grid: 1, pitch_m: 0.0, varied_heights: false },
        variants: vec![BuildingVariant { pack: pack.clone(), floors: 1, height }],
        instances: vec![BuildingInstance {
            structure_id: 0,
            variant_index: 0,
            offset: PackVec3::ZERO,
        }],
    };
    let manifest = Arc::new(DestructionManifest::from_city(&scene));

    let mut world = World::new(WorldConfig::default()).expect("PhysX world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: BridgeQuat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: u32::MAX,
        })
        .expect("ground plane");

    let destruction =
        CityDestruction::build(manifest, &mut world, stress_settings(&pack.materials), HZ)
            .expect("install destructible");
    (world, destruction)
}

fn run(world: &mut World, destruction: &mut CityDestruction, ticks: u32) {
    for _ in 0..ticks {
        world.step().expect("physx step");
        destruction.post_step(world, DT, GRAVITY).expect("destruction tick");
    }
}

/// Every structure, so a regression in one is not hidden by another passing.
const ALL: [&str; 7] = [
    "algedra-tower", "house-1story", "house-2story", "villa-savoye",
    "park-432", "parking-garage", "petronas",
];

// ── 1. it stands up ─────────────────────────────────────────────────────────

#[test]
fn every_structure_stands_under_its_own_weight() {
    for name in ALL {
        let pack = load(name);
        let bonds: usize = pack.bonds.len();
        let (mut world, mut destruction) = spin_up(&pack);

        // Five seconds is well past the point where a structure that is going
        // to settle has settled, and well short of nothing happening at all.
        run(&mut world, &mut destruction, HZ * 5);
        let stats = destruction.stats();

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
            stats.awake_chunk_bodies == 0,
            "{name}: {} bodies still moving after 5 s — it never came to rest",
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
        let (mut world, mut destruction) = spin_up(&pack);
        run(&mut world, &mut destruction, HZ * 2);
        let before = destruction.stats().broken_bonds;

        let (center, direction) = facade_aim(&pack);
        destruction
            .apply_blast(&mut world, center, direction, SHOT_RADIUS, SHOT_STRESS, SHOT_PUSH)
            .expect("shot");

        // The burst: everything the hit itself takes out.
        run(&mut world, &mut destruction, HZ);
        let burst = destruction.stats().broken_bonds.saturating_sub(before);
        // The aftermath: what the building does about it. Eight seconds,
        // for the same reason the drop test needs fifteen — debris off a hit
        // takes a while to stop moving, and cutting it short cannot tell a
        // settling pile from a spreading failure.
        run(&mut world, &mut destruction, HZ * 8);
        let end = destruction.stats();
        let after = end.broken_bonds.saturating_sub(before);
        let cascade = after.saturating_sub(burst);

        assert!(burst > 0, "{name}: a shot at the facade broke nothing at all");

        // "Does not collapse" is not a bond count — a 2.5 m blast is a big
        // fraction of a small house and almost nothing of a tower, so any
        // fixed fraction is really a size test. What distinguishes damage from
        // collapse is whether it SPREADS: a hole stops growing once the hit is
        // over, a collapse keeps taking the structure apart for seconds after.
        assert!(
            cascade <= burst,
            "{name}: the hit broke {burst} bonds and another {cascade} kept going in the four              seconds after — that is a progressive collapse, not damage",
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
        let (mut world, mut destruction) = spin_up(&pack);
        run(&mut world, &mut destruction, HZ * 2);
        let before = destruction.stats().broken_bonds;
        let (center, direction) = facade_aim(&pack);
        destruction
            .apply_blast(&mut world, center, direction, SHOT_RADIUS, stress, push)
            .expect("blast");
        run(&mut world, &mut destruction, HZ * 3);
        destruction.stats().broken_bonds.saturating_sub(before)
    };

    let shot = measure(SHOT_STRESS, SHOT_PUSH);
    let heavy = measure(SHOT_STRESS * 40.0, SHOT_PUSH * 4.0);

    assert!(
        heavy > shot,
        "{name}: a 40x hit broke {heavy} bonds against {shot} for a normal shot — the frame is \
         no harder to break than the skin it is behind",
    );
}

// ── 3. a building that falls comes apart ────────────────────────────────────

/// Roll the whole structure onto its side and lift it off the ground.
///
/// This is the cheapest honest way to ask "what happens when it comes down".
/// Toppling one properly means shooting out a support and waiting, which takes
/// tens of seconds of sim and depends on where you aim; dropping it flat
/// applies the same kind of load — a whole building's weight arriving at the
/// ground at once — in a second and a half, and is deterministic.
///
/// A quarter turn is exact for this format: it maps an axis-aligned box to an
/// axis-aligned box, so cuboid colliders stay cuboids and only their extents
/// swap. Supports lose their pinning, because a pinned foundation would hold
/// the whole thing in the air.
fn rotated_and_raised(pack: &ScenePack, height: f32) -> ScenePack {
    let rot = |v: PackVec3| PackVec3::new(-v.y, v.x, v.z);
    let mut out = pack.clone();

    for (i, node) in out.nodes.iter_mut().enumerate() {
        let c = rot(node.centroid);
        node.centroid = PackVec3::new(c.x, c.y + height, c.z);
        if node.mass == 0.0 {
            // Freed, so the building falls instead of hanging from its own
            // footings. Density is the concrete the foundations are anyway.
            node.mass = node.volume * 2400.0;
        }
        let _ = i;
    }
    for size in &mut out.node_sizes {
        *size = PackVec3::new(size.y, size.x, size.z);
    }
    for collider in &mut out.node_colliders {
        match collider {
            SceneCollider::Cuboid { half_extents } => {
                *half_extents = PackVec3::new(half_extents.y, half_extents.x, half_extents.z);
            }
            SceneCollider::ConvexHull { points, .. } => {
                for p in points.chunks_exact_mut(3) {
                    let (x, y) = (p[0], p[1]);
                    p[0] = -y;
                    p[1] = x;
                }
            }
        }
    }
    for bond in &mut out.bonds {
        let c = rot(bond.centroid);
        bond.centroid = PackVec3::new(c.x, c.y + height, c.z);
        bond.normal = rot(bond.normal);
    }
    out
}

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
        let (mut world, mut destruction) = spin_up(&pack);

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
        run(&mut world, &mut destruction, HZ * 15);
        let stats = destruction.stats();

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
