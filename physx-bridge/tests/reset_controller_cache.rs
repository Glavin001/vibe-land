#![cfg(feature = "native-destruction")]

//! A player standing on rubble when the city is reset.
//!
//! The character controller remembers the body it stands on (PhysX CCT
//! `mTouchedActor` / `mTouchedShape`) so it can ride it, and checks that body
//! at the start of the next move by calling `getNbShapes()` on it. PhysX clears
//! that memory through a deletion listener when an actor is released -- but
//! the native stage's fragment bodies are not released that way. `clearStress`
//! hands them straight back to the rigid-dynamic pool
//! (`NpDestructionBodyAllocator::discard`) and no listener hears about it, and
//! the authored chunk shapes the fragments carried are released after it,
//! which never notifies anyone either. So the player's next move made a virtual
//! call through a freed body: the live server died in
//! `CapsuleController::move` on the first move after a `/city-reset`, SIGBUS
//! once and SIGSEGV once (2026-09-24, soak runs 213334 and 215220).
//!
//! This is its own test binary on purpose: before the fix it does not fail, it
//! crashes, and it should not take the rest of the native suite down with it.
//! Run it with and without `VIBE_CITY_NATIVE_REST_SLEEP=1`; the flag is read
//! once per process.

use vibe_land_physx_bridge::{
    CapsulePlayerDesc, ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose,
    Quat, RoundDesc, StaticBoxDesc, StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_PLAYER: u32 = 1 << 2;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;
const GROUND_ID: u32 = 0x1000_0001;
const PLAYER_ID: u32 = 900;
const CAPSULE_HALF_HEIGHT: f32 = 0.5 + 0.4;

fn wall(w: u32, h: u32) -> (Vec<ChunkNodeDesc>, Vec<ChunkBondDesc>) {
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let index = |x: u32, y: u32| y * w + x;
    let x_of = |x: u32| x as f32 - (w as f32 - 1.0) / 2.0;
    for y in 0..h {
        for x in 0..w {
            nodes.push(ChunkNodeDesc {
                node_index: index(x, y),
                centroid: Vec3::new(x_of(x), y as f32 + 0.5, 0.0),
                mass: if y == 0 { 0.0 } else { 400.0 },
                volume: 1.0,
                geom_kind: 0,
                half_extents: Vec3::new(0.48, 0.48, 0.48),
                convex_points: Vec::new(),
            });
        }
    }
    let mut next = 0u32;
    let mut push = |a: u32, b: u32, centroid: Vec3, normal: Vec3| {
        bonds.push(ChunkBondDesc {
            bond_index: next,
            node0: a,
            node1: b,
            centroid,
            normal,
            area: 0.92,
            material: 0,
        });
        next += 1;
    };
    for y in 0..h {
        for x in 0..w {
            if x + 1 < w {
                push(
                    index(x, y),
                    index(x + 1, y),
                    Vec3::new(x_of(x) + 0.5, y as f32 + 0.5, 0.0),
                    Vec3::new(1.0, 0.0, 0.0),
                );
            }
            if y + 1 < h {
                push(
                    index(x, y),
                    index(x, y + 1),
                    Vec3::new(x_of(x), y as f32 + 1.0, 0.0),
                    Vec3::new(0.0, 1.0, 0.0),
                );
            }
        }
    }
    (nodes, bonds)
}

fn settings() -> DestructibleSettings {
    DestructibleSettings {
        max_solver_iterations_per_frame: 2048,
        graph_reduction_level: 0,
        materials: vec![StressMaterialDesc {
            compression_elastic: 250_000.0,
            compression_fatal: 500_000.0,
            tension_elastic: 30_000.0,
            tension_fatal: 60_000.0,
            shear_elastic: 80_000.0,
            shear_fatal: 160_000.0,
            elastic_modulus: 30.0e9,
            residual_area_fraction: 0.0,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        apply_excess_forces: true,
        apply_centrifugal: true,
        excess_force_scale: 0.012,
        linear_damping: 0.25,
        angular_damping: 0.35,
    }
}

fn native_config(chunks: u32) -> NativeConfig {
    NativeConfig {
        max_iterations: 2048,
        tolerance: 1.0e-5,
        warm_start: true,
        damage_rate: 2.0,
        bend_gain_max: 3.0,
        fibre_bending: true,
        reserved_contact_pairs: chunks * 3 / 2,
        preserve_unchanged_contact_pairs: true,
        gpu_island_repair: true,
        verdict_sample_ticks: 1,
    }
}

fn ground(world: &mut World) {
    world
        .add_static_box(StaticBoxDesc {
            entity_id: GROUND_ID,
            user_id: 0,
            pose: Pose { position: Vec3::new(0.0, -0.5, 0.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(40.0, 0.5, 40.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");
}

fn install(world: &mut World, w: u32, h: u32) {
    let (nodes, bonds) = wall(w, h);
    let chunks = nodes.len() as u32;
    world.native_attach().expect("stage attach");
    world
        .native_create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat::IDENTITY },
            &nodes,
            &bonds,
            settings(),
            GROUP_CHUNK,
            ALL,
        )
        .expect("author wall");
    world.step().expect("identity step");
    world.native_configure(native_config(chunks)).expect("configure stage");
}

fn tick(world: &mut World) {
    world.step().expect("step");
    let status = world.native_tick().expect("observe");
    assert_eq!(status.error, 0, "stage error bits {}", status.error);
    let _ = world.native_take_broken_bonds();
    let _ = world.native_take_island_events();
    let _ = world.native_take_chunk_migrations();
}

/// Break a wall and let the pieces come down.
fn rubble(world: &mut World) {
    install(world, 6, 6);
    for _ in 0..5 {
        tick(world);
    }
    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.0, 3.5, 1.2),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 6.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire");
    // Six seconds: long enough for the pieces to land and, with rest sleep on,
    // for a resting neighbourhood to be put to sleep (120-tick windows).
    for _ in 0..360 {
        tick(world);
    }
}

fn player(world: &World) -> vibe_land_physx_bridge::PlayerSnapshot {
    world
        .player_snapshots()
        .expect("players")
        .into_iter()
        .find(|p| p.entity_id == PLAYER_ID)
        .expect("the player is still in the scene")
}

fn add_player(world: &mut World, at: Vec3) {
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: PLAYER_ID,
            user_id: PLAYER_ID,
            position: at,
            cylinder_height: 1.0,
            radius: 0.4,
            step_offset: 0.3,
            contact_offset: 0.05,
            slope_limit_radians: 0.785,
            collision_group: GROUP_PLAYER,
            collision_mask: ALL,
        })
        .expect("player");
}

/// Put the player on top of a fallen piece and walk it down until it stands
/// there. Returns the entity it stands on.
fn stand_on_rubble(world: &mut World) -> u32 {
    let mut pieces: Vec<_> = world
        .native_chunk_body_snapshots()
        .expect("bodies")
        .iter()
        .filter(|b| !b.kinematic && b.position.y > 0.2 && b.position.y < 1.5)
        .map(|b| (b.entity_id, Vec3::new(b.position.x, b.position.y, b.position.z)))
        .collect();
    assert!(!pieces.is_empty(), "the wall left no fallen pieces to stand on");
    // Farthest from the wall's footprint first: a piece lying on open ground.
    pieces.sort_by(|a, b| b.1.z.abs().partial_cmp(&a.1.z.abs()).unwrap());
    for (_, top) in pieces.iter().take(8) {
        let start = Vec3::new(top.x, top.y + 0.5 + CAPSULE_HALF_HEIGHT + 0.3, top.z);
        if world.player_snapshots().expect("players").iter().any(|p| p.entity_id == PLAYER_ID) {
            world.remove_actor(PLAYER_ID).expect("remove player");
        }
        add_player(world, start);
        for _ in 0..30 {
            world.move_player(PLAYER_ID, Vec3::new(0.0, -0.1, 0.0)).expect("move");
            tick(world);
        }
        let p = player(world);
        if p.grounded && p.has_support && p.support_entity_id != GROUND_ID {
            return p.support_entity_id;
        }
    }
    panic!("could not get the player to stand on a fallen piece");
}

/// Reset the city under a player who is standing on a fragment, then move.
#[test]
fn a_player_standing_on_rubble_survives_a_reset() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    rubble(&mut world);
    let support = stand_on_rubble(&mut world);
    eprintln!(
        "standing on entity {support:#x} before the reset (rest sleep {:?})",
        std::env::var("VIBE_CITY_NATIVE_REST_SLEEP").ok()
    );

    // CityRuntime::reset through NativeCityDestruction::clear: clear, then one
    // step of the emptied scene before the next city is authored.
    world.native_clear().expect("clear");
    world.step().expect("step after clear");

    // The first move after the reset is the one that died in production.
    for _ in 0..30 {
        world.move_player(PLAYER_ID, Vec3::new(0.02, -0.1, 0.0)).expect("move after reset");
        world.step().expect("step");
    }
    let p = player(&world);
    assert!(p.grounded, "the player should have dropped to the ground once the rubble went");
    assert!(
        !p.has_support || p.support_entity_id == GROUND_ID,
        "still standing on {:#x} after the city it belonged to was cleared",
        p.support_entity_id
    );

    // And the rebuilt city is playable with the same controller.
    install(&mut world, 6, 6);
    for _ in 0..20 {
        world.move_player(PLAYER_ID, Vec3::new(0.0, -0.1, 0.0)).expect("move in the rebuilt city");
        tick(&mut world);
    }
}

/// The same reset with the player on open ground beside the rubble, pressed
/// against a fallen piece: the controller's cached neighbourhood includes the
/// fragment, but it stands on the static ground.
#[test]
fn a_player_beside_rubble_survives_a_reset() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    rubble(&mut world);
    let piece = world
        .native_chunk_body_snapshots()
        .expect("bodies")
        .iter()
        .filter(|b| !b.kinematic && b.position.y < 1.5)
        .map(|b| Vec3::new(b.position.x, b.position.y, b.position.z))
        .max_by(|a, b| a.z.abs().partial_cmp(&b.z.abs()).unwrap())
        .expect("a fallen piece");
    let side = if piece.z >= 0.0 { 1.0 } else { -1.0 };
    add_player(&mut world, Vec3::new(piece.x, CAPSULE_HALF_HEIGHT + 0.1, piece.z + side * 2.0));
    for _ in 0..40 {
        world.move_player(PLAYER_ID, Vec3::new(0.0, -0.05, -side * 0.05)).expect("move");
        tick(&mut world);
    }

    world.native_clear().expect("clear");
    world.step().expect("step after clear");
    for _ in 0..30 {
        world.move_player(PLAYER_ID, Vec3::new(0.0, -0.05, -side * 0.05)).expect("move after reset");
        world.step().expect("step");
    }
    assert!(player(&world).grounded, "the player should be on the ground");
}
