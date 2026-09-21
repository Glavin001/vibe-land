#![cfg(feature = "native-destruction")]

//! End-to-end gameplay checks for PhysX's own GPU destruction stage.
//!
//! These run the real engine: a wall is authored, the stage is configured, and
//! the scene is stepped while a round is fired into it. They assert what a
//! *player* would notice -- the wall breaks, the pieces are announced once
//! each, the ids on the wire mean what the manifest says, and rebuilding the
//! city leaves nothing behind -- rather than that particular functions were
//! called.

use vibe_land_physx_bridge::{
    CapsulePlayerDesc, ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose,
    Quat, RoundDesc, StaticBoxDesc, StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;

/// A wall of 1 m cubes, `w` wide and `h` tall, standing on the ground.
/// The bottom row is authored as support, which is what anchors it.
fn wall(w: u32, h: u32) -> (Vec<ChunkNodeDesc>, Vec<ChunkBondDesc>) {
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let index = |x: u32, y: u32| y * w + x;
    for y in 0..h {
        for x in 0..w {
            nodes.push(ChunkNodeDesc {
                node_index: index(x, y),
                centroid: Vec3::new(x as f32 - (w as f32 - 1.0) / 2.0, y as f32 + 0.5, 0.0),
                // Zero mass is the authoring convention for a world anchor.
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
            let here = index(x, y);
            if x + 1 < w {
                push(
                    here,
                    index(x + 1, y),
                    Vec3::new(x as f32 + 0.5 - (w as f32 - 1.0) / 2.0, y as f32 + 0.5, 0.0),
                    Vec3::new(1.0, 0.0, 0.0),
                );
            }
            if y + 1 < h {
                push(
                    here,
                    index(x, y + 1),
                    Vec3::new(x as f32 - (w as f32 - 1.0) / 2.0, y as f32 + 1.0, 0.0),
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
            // Ordinary brittle masonry, in Pa. Weak enough in tension that an
            // impact breaks it, strong enough in compression that it stands.
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
            entity_id: 0x1000_0001,
            user_id: 0,
            pose: Pose {
                position: Vec3::new(0.0, -0.5, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: Vec3::new(40.0, 0.5, 40.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");
}

/// Author the wall, step once so GPU identities exist, then configure.
fn install(world: &mut World, w: u32, h: u32) -> u32 {
    let (nodes, bonds) = wall(w, h);
    let chunks = nodes.len() as u32;
    world.native_attach().expect("stage attach");
    world
        .native_create_destructible(
            0,
            Pose {
                position: Vec3::new(0.0, 0.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            &nodes,
            &bonds,
            settings(),
            GROUP_CHUNK,
            ALL,
        )
        .expect("author wall");
    world.step().expect("identity step");
    let configured = world
        .native_configure(native_config(chunks))
        .expect("configure stage");
    assert_eq!(configured.chunks, chunks, "stage took every authored chunk");
    assert!(configured.bonds > 0, "stage took the bond graph");
    chunks
}

/// Step the scene and observe, failing on any step the engine rejected.
fn step_and_observe(world: &mut World) -> vibe_land_physx_bridge::NativeStatus {
    world.step().expect("step");
    let status = world.native_tick().expect("observe");
    assert_eq!(
        status.error, 0,
        "engine rejected the step (error bits {})",
        status.error
    );
    // One corrected pass per tick unless VIBE_CITY_NATIVE_CORRECTION_LIMIT
    // raised the budget; never more than the budget either way.
    let limit: u32 = std::env::var("VIBE_CITY_NATIVE_CORRECTION_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    assert!(
        status.correction_passes <= limit,
        "more corrected passes than the budget of {limit}: {}",
        status.correction_passes
    );
    assert_eq!(
        status.stress_passes,
        status.correction_passes + 1,
        "one stress evaluation per solve"
    );
    status
}

#[test]
fn the_wall_stands_until_it_is_hit_and_then_comes_apart() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 6, 6);

    // A wall that holds itself up must not break under its own weight. This is
    // the check that catches a compliance or material error: a structure which
    // demolishes itself before anyone fires is not a physics result, it is a
    // configuration bug, and it is invisible once shooting starts.
    for _ in 0..60 {
        let status = step_and_observe(&mut world);
        assert!(status.converged, "stress solve did not converge at rest");
    }
    let broken_at_rest = world
        .native_take_broken_bonds()
        .expect("drain")
        .len();
    assert_eq!(broken_at_rest, 0, "the wall broke while standing still");

    // Now shoot it. Momentum is a real weapon's, delivered as a real body.
    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.0, 3.5, 1.2),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 3.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire");

    let mut broken = 0usize;
    let mut promoted = 0usize;
    for _ in 0..90 {
        step_and_observe(&mut world);
        broken += world.native_take_broken_bonds().expect("drain").len();
        promoted += world
            .native_take_island_events()
            .expect("drain")
            .iter()
            .filter(|event| event.kind == 0)
            .count();
    }
    assert!(broken > 0, "the round did not break a single bond");
    assert!(promoted > 0, "nothing came loose from the wall");
    assert!(
        world.native_validate_mappings().expect("audit"),
        "GPU ownership and the CPU mirror disagree after fracture"
    );
}

#[test]
fn every_body_is_announced_once_and_keeps_its_identity() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 5, 5);

    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.0, 3.0, 1.2),
            direction: Vec3::new(0.0, -0.2, -1.0),
            momentum_ns: 4.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire");

    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    let mut retired: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for _ in 0..120 {
        step_and_observe(&mut world);
        for event in world.native_take_island_events().expect("drain") {
            let key = (event.structure_id, event.island_id);
            match event.kind {
                0 => {
                    // A promotion may repeat when membership changes -- the
                    // centre-of-mass frame moved, so the client must be told
                    // again -- but a retired id must never come back.
                    assert!(
                        !retired.contains(&key),
                        "island {key:?} was promoted after being retired"
                    );
                    seen.insert(key);
                }
                1 => {
                    assert!(seen.contains(&key), "island {key:?} retired without promotion");
                    retired.insert(key);
                }
                other => panic!("unexpected island event kind {other}"),
            }
        }
    }
    assert!(!seen.is_empty(), "no island was ever promoted");

    // The wire identity the client decodes must be the one the manifest
    // describes. If these two ever disagree every body is silently renamed.
    for (structure, serial) in [(0u32, 0u32), (0, 1), (3, 17), (63, 4_194_303)] {
        assert_eq!(
            vibe_land_physx_bridge::native_entity_id(structure, serial),
            0x8000_0000 | (structure << 20) | serial,
            "entity id layout drifted from ids.rs"
        );
    }
}

#[test]
fn a_rebuilt_city_leaves_nothing_of_the_old_one() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);

    // Three full cycles: the first found a crash in an earlier attempt at this
    // port, where shapes released on reset were still referenced by the
    // broadphase on the next build.
    for cycle in 0..3 {
        install(&mut world, 4, 4);
        world
            .native_fire_round(RoundDesc {
                position: Vec3::new(0.0, 2.5, 1.2),
                direction: Vec3::new(0.0, 0.0, -1.0),
                momentum_ns: 4.0e5,
                radius: 0.4,
                speed: 20.0,
                ttl_ticks: 20,
            })
            .unwrap_or_else(|e| panic!("cycle {cycle}: fire: {e}"));
        for _ in 0..40 {
            step_and_observe(&mut world);
        }
        let _ = world.native_take_broken_bonds();
        let _ = world.native_take_island_events();
        let _ = world.native_take_chunk_migrations();
        world
            .native_clear()
            .unwrap_or_else(|e| panic!("cycle {cycle}: clear: {e}"));
        assert!(
            !world.native_configured().expect("configured"),
            "cycle {cycle}: stage still configured after clear"
        );
        // A step on the emptied scene: anything left over from the old city
        // would still be simulated here.
        world.step().expect("step after clear");
    }
}

/// A shot has to be able to *find* the city.
///
/// Damage starts with a scene query, and a chunk the raycast cannot see is a
/// building that swallows every shot silently: the server reports the shot,
/// the client draws the tracer, and nothing happens. Worth its own test because
/// firing a round directly -- which the other tests do -- skips this entirely.
#[test]
fn a_raycast_finds_the_chunks_the_stage_owns() {
    use vibe_land_physx_bridge::RaycastRequest;

    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 6, 6);
    world.step().expect("step");

    // At a chunk CENTRE, not the wall's midline: with an even number of columns
    // the midline runs down the 4 cm joint between two chunks, and a ray
    // through the gap is a miss for reasons that have nothing to do with
    // filtering.
    let hit = world
        .raycast(RaycastRequest {
            origin: Vec3::new(0.5, 3.5, 6.0),
            direction: Vec3::new(0.0, 0.0, -1.0),
            max_distance: 40.0,
            collision_mask: GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .expect("raycast");
    assert!(
        hit.hit,
        "the raycast passed straight through a wall of stage-owned chunks; \
         every shot at this city would silently miss"
    );
    assert!(
        hit.position.z > 0.0 && hit.position.z < 6.0,
        "hit at an implausible place: {:?}",
        (hit.position.x, hit.position.y, hit.position.z)
    );
}

/// A round carrying a real shot's momentum must be a sane rigid body.
///
/// `/city` calibrates a round at 3e5 N*s, which at the spawn speed is a mass in
/// the tonnes. That is fine -- the reference demo throws a 20,000 kg ball --
/// but only if the body's inertia matches its mass. Build the inertia from a
/// different mass than the one you then set and the result is a body with a
/// mass-to-inertia ratio in the hundreds of thousands, which stays invisible
/// until it touches something and then takes the process with it.
///
/// This fires a production-weight round into a wall and keeps stepping, which
/// is exactly the sequence a player produces with one trigger pull.
#[test]
fn a_production_weight_round_does_not_destabilise_the_scene() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 8, 8);
    for _ in 0..10 {
        step_and_observe(&mut world);
    }

    // A player standing where a player stands when they shoot a wall: close
    // enough that the round is spawned inside their capsule. This is the
    // geometry a trigger pull actually produces, and a round whose inertia does
    // not match its mass turns that overlap into an unbounded depenetration
    // response rather than a shove.
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 900,
            user_id: 900,
            position: Vec3::new(0.5, 1.0, 1.6),
            cylinder_height: 1.0,
            radius: 0.4,
            step_offset: 0.3,
            contact_offset: 0.05,
            slope_limit_radians: 0.785,
            collision_group: 1 << 2,
            collision_mask: ALL,
        })
        .expect("player");
    for _ in 0..5 {
        step_and_observe(&mut world);
    }

    // The /city calibration: 3e5 N*s at the default 20 m/s spawn speed.
    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.5, 3.5, 0.5),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 3.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 6,
        })
        .expect("fire");

    for _ in 0..120 {
        let status = step_and_observe(&mut world);
        assert_eq!(status.error, 0, "the engine rejected a step after the impact");
    }

    // Everything the round touched must still be finite. A degenerate inertia
    // shows up here as coordinates that are not numbers long before it shows up
    // as anything a person would call a physics bug.
    let snapshots = world.native_chunk_body_snapshots().expect("snapshots");
    for snap in snapshots {
        for value in [snap.position.x, snap.position.y, snap.position.z] {
            assert!(
                value.is_finite() && value.abs() < 1.0e6,
                "body {} left the world at {value}",
                snap.entity_id
            );
        }
    }
    assert!(
        world.native_validate_mappings().expect("audit"),
        "GPU ownership and the CPU mirror disagree after a heavy impact"
    );
}

#[test]
fn observing_the_same_frame_twice_reports_nothing_the_second_time() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 4, 4);

    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.0, 2.5, 1.2),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 4.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire");
    for _ in 0..40 {
        world.step().expect("step");
        let first = world.native_tick().expect("observe");
        assert_eq!(first.error, 0);
        // The tick loop can call this twice in a frame; the second call must
        // not re-deliver the same events, or every break is counted twice.
        let second = world.native_tick().expect("observe again");
        assert!(
            !second.observed,
            "the same frame was observed twice (frame {})",
            second.frame
        );
    }
}

/// A reset rebuilds a city that still breaks.
///
/// `a_rebuilt_city_leaves_nothing_of_the_old_one` proves the scene is left
/// clean. This proves the other half, which is the half that failed in
/// production: that the rebuilt stage actually runs.
///
/// The live server reset its city and the stage came up stuck at frame 0 with
/// error bit 4 and stayed there -- 19,590 consecutive rejected ticks, every
/// later `clearStress` refused, a city that could be neither destroyed nor
/// reset. The cause was the ordering: `CityRuntime::reset` cleared the backend
/// and authored the next city on the following line, and the GPU broadphase
/// was still holding pairs against the shapes that had just been released.
///
/// Note that this test cannot catch that. It passed throughout, without the
/// step, on sixteen chunks: the hazard is the size of what the broadphase
/// holds, and it took a real building coming down to show. The step is here
/// because it is correct, and the bridge refuses to author without it.
#[test]
fn a_reset_rebuilds_a_city_that_still_breaks() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 4, 4);
    for _ in 0..10 {
        step_and_observe(&mut world);
    }

    world.native_clear().expect("clear");
    world.step().expect("the step the rebuild depends on");
    install(&mut world, 4, 4);

    for tick in 0..20 {
        world.step().expect("step");
        let status = world.native_tick().expect("observe");
        assert_eq!(
            status.error, 0,
            "tick {tick} after a rebuild: stage error bits {}",
            status.error
        );
    }

    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.0, 2.5, 1.2),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 4.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire at the rebuilt city");
    for _ in 0..40 {
        step_and_observe(&mut world);
    }
    assert!(
        !world.native_take_broken_bonds().expect("bonds").is_empty(),
        "the rebuilt city absorbed a round without breaking: this is the live \
         failure, where the stage runs but does nothing"
    );

    // And it must still be clearable, or the match is stuck forever.
    world.native_clear().expect("clear after rebuild");
}

/// Reset a city that is still coming apart, with a player standing in it.
///
/// `a_rebuilt_city_leaves_nothing_of_the_old_one` clears a small wall that has
/// finished falling, in an otherwise empty scene, and passes. Production does
/// not get to choose its moment: `/city-reset` arrives whenever a player sends
/// it, which in a QA sweep is a few seconds after twelve cannonballs, with
/// hundreds of stage-owned fragments still moving, rounds still alive, and one
/// or two capsule controllers in the scene.
///
/// Done that way the stage dies. It comes up from the rebuild stuck at frame 0
/// with error bit 4 and never recovers, and every later `clearStress` is
/// refused because of that state, so the match can be neither destroyed nor
/// reset for as long as it lives. Observed twice on the live server, 4,560 and
/// 19,590 consecutive rejected ticks, each time on a reset that followed heavy
/// destruction with clients connected.
#[test]
fn a_reset_during_a_collapse_does_not_kill_the_stage() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);

    // A player in the scene for every cycle, as in production. The controller
    // is not stage-owned, so it survives the clear and is still there when the
    // new city is authored around it.
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 900,
            user_id: 900,
            position: Vec3::new(0.5, 1.0, 4.0),
            cylinder_height: 1.0,
            radius: 0.4,
            step_offset: 0.3,
            contact_offset: 0.05,
            slope_limit_radians: 0.785,
            collision_group: 1 << 2,
            collision_mask: ALL,
        })
        .expect("player");

    for cycle in 0..6 {
        install(&mut world, 6, 6);
        for _ in 0..5 {
            world.step().expect("step");
            let _ = world.native_tick().expect("observe");
        }
        world
            .native_fire_round(RoundDesc {
                position: Vec3::new(0.0, 3.5, 1.2),
                direction: Vec3::new(0.0, 0.0, -1.0),
                momentum_ns: 6.0e5,
                radius: 0.4,
                speed: 20.0,
                // Long enough that the round is still in the scene at the clear
                // below, which is the case production hits and the settled
                // cycle test does not.
                ttl_ticks: 60,
            })
            .unwrap_or_else(|e| panic!("cycle {cycle}: fire: {e}"));

        // Mid-collapse on purpose: enough ticks for the wall to break and its
        // fragments to be moving, nowhere near enough for anything to settle.
        for _ in 0..8 {
            world.step().expect("step");
            let status = world.native_tick().expect("observe");
            assert_eq!(status.error, 0, "cycle {cycle}: error before the reset");
        }
        let broken = world.native_take_broken_bonds().expect("bonds").len();
        assert!(broken > 0, "cycle {cycle}: nothing was breaking, so this is not the case under test");
        let _ = world.native_take_island_events();
        let _ = world.native_take_chunk_migrations();

        world
            .native_clear()
            .unwrap_or_else(|e| panic!("cycle {cycle}: clear during collapse: {e}"));
        world.step().expect("step after clear");
    }

    // And the rebuilt city must still run and still break.
    install(&mut world, 6, 6);
    for tick in 0..20 {
        world.step().expect("step");
        let status = world.native_tick().expect("observe");
        assert_eq!(status.error, 0, "tick {tick} after six reset cycles: error bits {}", status.error);
    }
}

/// Authoring a new city before the scene has stepped is refused.
///
/// The refusal is the point: what it prevents is a use-after-free that the GPU
/// broadphase turns into an illegal memory access, and CUDA does not forgive
/// one -- every later launch in the process fails with error 700 and the match
/// is over, with `clearStress` then refusing because of that state so it cannot
/// even be reset. Production did exactly this and lost matches to it.
#[test]
fn authoring_before_the_scene_has_stepped_is_refused() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    ground(&mut world);
    install(&mut world, 4, 4);
    for _ in 0..10 {
        step_and_observe(&mut world);
    }

    world.native_clear().expect("clear");
    let (nodes, bonds) = wall(4, 4);
    let error = world
        .native_create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat::IDENTITY },
            &nodes,
            &bonds,
            settings(),
            GROUP_CHUNK,
            ALL,
        )
        .expect_err("authoring before the broadphase has caught up must be refused");
    assert!(
        error.to_string().contains("step the scene once after native_clear"),
        "unhelpful refusal: {error}"
    );

    // And the refusal is not a dead end: step, and the same authoring works.
    world.step().expect("step");
    install(&mut world, 4, 4);
    for _ in 0..10 {
        step_and_observe(&mut world);
    }
}
