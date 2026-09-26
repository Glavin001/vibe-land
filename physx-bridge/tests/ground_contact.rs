#![cfg(feature = "native-destruction")]

//! Bodies lying on the ground must stay on it while the city fractures.
//!
//! The 2026-09-24 session and the systematic city bench both lost bodies
//! through the floor: cannonballs and meteors that had been rolling on the
//! ground for seconds lost all support in a single tick (vertical velocity
//! 0 -> -g*dt) and free-fell through the 20 m slab. In the bench's world truth
//! every such loss landed on a tick whose physics step took 20-100 ms instead
//! of ~7 ms -- a fracturing tick, where the native stage rewinds and re-solves
//! the scene (its "correction" pass).
//!
//! This reproduces it in isolation: the city's ground slab, six hull walls,
//! balls resting and rolling on the slab 30 m clear of the walls, and one shot
//! per wall. Measured on Metal (PhysX fork package of 2026-09-24, CuMetal):
//!
//! - With the city's two parked cars in the scene, balls resting or rolling on
//!   the slab lose their support in one tick (vy 0.000 -> -0.164), always on a
//!   corrected tick (which ones varies run to run; in one run all four rolling
//!   balls went on the first fracture, tick 71) and fall to y = -300 m.
//! - It happens with `preserve_unchanged_contact_pairs` true (production) and
//!   false (the stage's reference pair lifecycle); with false, 20 fragments
//!   fall through as well.
//! - Without the cars (with or without a player capsule): six corrected ticks,
//!   nothing lost. Parked or driving makes no difference.
//!
//! Root cause (PhysX fork, fixed in fork commit 0ece3f22 on
//! fix/correction-vehicle-ground): a Vehicle SDK car owns
//! wheel shapes that never enter the broad phase (no simulation, trigger or
//! query flag). Two fork paths flagged every shape of a body as having changed
//! broad-phase bounds -- the native sleep commit (its pose write goes through
//! the Direct GPU API `setRigidDynamicGlobalPose` kernel) when a parked car
//! falls asleep, and the corrected re-solve's bounds refresh of every live
//! rigid shape while a car is awake. The GPU SAP then rewrote the endpoint
//! slots of those never-inserted handles, which were the ground's, so the
//! ground's box sorted to the far end of the x axis. Pairs that exist keep
//! their contacts, but the corrected pass refilters resting bodies and
//! fragments and relies on the broad phase to rediscover their pairs with the
//! ground; against the corrupted box it never did, so they lost support. The
//! fix flags only broad-phase shapes, as upstream's own bounds update does.
//!
//! Run with `--test-threads=1` on Metal, like the other GPU tests.

use vibe_land_physx_bridge::{
    CapsulePlayerDesc, ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, LaunchedBallDesc,
    NativeConfig, Pose, Quat, RoundDesc, StaticBoxDesc, StressMaterialDesc, Vec3, VehicleCommands,
    VehicleDesc, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_DYNAMIC: u32 = 1 << 1;
const GROUP_PLAYER: u32 = 1 << 2;
const GROUP_VEHICLE: u32 = 1 << 3;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_DYNAMIC | GROUP_PLAYER | GROUP_VEHICLE | GROUP_CHUNK;
const GROUND: u32 = 0x1000_0001;

/// The /city floor (`server/src/demo_world.rs`): a 4 km square slab, 20 m
/// thick, its top at y = 0.
fn city_ground(world: &mut World) {
    world
        .add_static_box(StaticBoxDesc {
            entity_id: GROUND,
            user_id: 0,
            pose: Pose { position: Vec3::new(0.0, -10.0, 0.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");
}

fn hull_block(seed: u32) -> Vec<Vec3> {
    let (a, b) = (0.48f32, 0.36f32);
    let jitter = |i: u32| {
        ((seed.wrapping_mul(2654435761).wrapping_add(i * 40503) >> 16) % 100) as f32 * 0.0004
    };
    let mut points = Vec::new();
    for (i, &(x, y, z)) in [(a, b, b), (b, a, b), (b, b, a)].iter().enumerate() {
        for sx in [-1.0f32, 1.0] {
            for sy in [-1.0f32, 1.0] {
                for sz in [-1.0f32, 1.0] {
                    let d = 1.0 - jitter(i as u32 * 8 + points.len() as u32);
                    points.push(Vec3::new(sx * x * d, sy * y * d, sz * z * d));
                }
            }
        }
    }
    points
}

/// A wall of 1 m convex-hull chunks, the geometry the production city authors.
fn hull_wall(w: u32, h: u32) -> (Vec<ChunkNodeDesc>, Vec<ChunkBondDesc>) {
    let index = |x: u32, y: u32| y * w + x;
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    for y in 0..h {
        for x in 0..w {
            nodes.push(ChunkNodeDesc {
                node_index: index(x, y),
                centroid: Vec3::new(x as f32 - (w as f32 - 1.0) / 2.0, y as f32 + 0.5, 0.0),
                mass: if y == 0 { 0.0 } else { 400.0 },
                volume: 1.0,
                geom_kind: 1,
                half_extents: Vec3::new(0.48, 0.48, 0.48),
                convex_points: hull_block(index(x, y)),
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
            let cx = x as f32 - (w as f32 - 1.0) / 2.0;
            if x + 1 < w {
                push(index(x, y), index(x + 1, y), Vec3::new(cx + 0.5, y as f32 + 0.5, 0.0), Vec3::new(1.0, 0.0, 0.0));
            }
            if y + 1 < h {
                push(index(x, y), index(x, y + 1), Vec3::new(cx, y as f32 + 1.0, 0.0), Vec3::new(0.0, 1.0, 0.0));
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

/// A ball on the ground: `radius` above the slab, launched with `velocity`
/// (zero for one at rest). Launched balls have no damping, like /city's.
struct Ball {
    entity: u32,
    radius: f32,
}

fn ball(world: &mut World, entity: u32, x: f32, z: f32, radius: f32, velocity: Vec3) -> Ball {
    world
        .launch_dynamic_ball(LaunchedBallDesc {
            entity_id: entity,
            user_id: entity,
            pose: Pose { position: Vec3::new(x, radius, z), rotation: Quat::IDENTITY },
            radius,
            mass: 10_650.0,
            linear_velocity: velocity,
            collision_group: GROUP_DYNAMIC,
            collision_mask: ALL,
        })
        .expect("ball");
    Ball { entity, radius }
}

/// A /city car (`server/src/physx_runtime.rs` tuning), parked.
fn city_car(entity_id: u32, x: f32, z: f32) -> VehicleDesc {
    let rest_load = 150.0 * 9.81;
    VehicleDesc {
        entity_id,
        user_id: 100 + entity_id,
        pose: Pose { position: Vec3::new(x, 1.0, z), rotation: Quat::IDENTITY },
        chassis_half_extents: Vec3::new(0.9, 0.3, 1.8),
        mass: 600.0,
        inertia: Vec3::new(0.0, 0.0, 0.0),
        half_track: 0.9,
        suspension_attachment_y: -0.17,
        front_axle_z: 1.1,
        rear_axle_z: -1.1,
        suspension_travel: 0.2,
        suspension_stiffness: 22_000.0,
        suspension_damping: 3_600.0,
        wheel_radius: 0.35,
        wheel_half_width: 0.15,
        tyre_friction: 1.4,
        front_lateral_stiffness: 28.0 * rest_load,
        rear_lateral_stiffness: 32.0 * rest_load,
        longitudinal_stiffness: 12.0 * rest_load,
        com_offset_y: -0.2,
        angular_damping: 0.5,
        max_steer_radians: 0.5,
        drive_torque: 450.0,
        brake_torque: 900.0,
        handbrake_torque: 1_800.0,
        top_speed: 30.0,
        front_wheel_drive: false,
        rear_wheel_drive: false,
        sweep_road_queries: true,
        road_mask: ALL & !GROUP_VEHICLE,
        collision_group: GROUP_VEHICLE,
        collision_mask: ALL,
    }
}

/// What a run saw.
#[derive(Debug, Default)]
struct Outcome {
    /// Ticks the stage re-solved (a correction pass ran).
    correction_ticks: u32,
    broken_bonds: usize,
    /// First tick each sinking ball was more than 0.25 m into the slab, with
    /// its state then and on the tick before.
    sunk: Vec<String>,
    /// Fragments below y = -1 m at the end.
    chunks_below: Vec<String>,
    /// Each corrected tick, and how many balls were then in reported contact.
    corrections: Vec<String>,
    /// The tick each ball resting on the slab lost its support.
    support_lost: Vec<String>,
    /// Lowest ball centre at the end.
    lowest_ball_y: f32,
}

/// Walls along the x axis, `WALL_SPACING` apart, one structure each.
const WALLS: u32 = 6;
const WALL_SPACING: f32 = 14.0;

fn wall_x(i: u32) -> f32 {
    (i as f32 - (WALLS as f32 - 1.0) / 2.0) * WALL_SPACING
}

/// The scenario, with the stage's pair-reuse option as given.
fn run(preserve_unchanged_contact_pairs: bool, cars: bool, player: bool) -> Outcome {
    run_with(preserve_unchanged_contact_pairs, cars, player, false)
}

/// `driving` keeps the cars awake, circling in place, instead of parked.
fn run_with(preserve_unchanged_contact_pairs: bool, cars: bool, player: bool, driving: bool) -> Outcome {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    city_ground(&mut world);
    // What the /city match has besides the buildings: two parked cars and a
    // player standing on the slab.
    if cars {
        world.add_vehicle(city_car(0x6000_0001, 60.0, 8.0)).expect("car");
        world.add_vehicle(city_car(0x6000_0002, -60.0, -8.0)).expect("car");
    }
    if player {
        world
            .add_capsule_player(CapsulePlayerDesc {
                entity_id: 0x4000_0001,
                user_id: 1,
                position: Vec3::new(0.0, 1.0, 20.0),
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

    let mut chunks = 0u32;
    world.native_attach().expect("stage attach");
    for i in 0..WALLS {
        let (nodes, bonds) = hull_wall(8, 8);
        chunks += nodes.len() as u32;
        world
            .native_create_destructible(
                i,
                Pose { position: Vec3::new(wall_x(i), 0.0, 0.0), rotation: Quat::IDENTITY },
                &nodes,
                &bonds,
                settings(),
                GROUP_CHUNK,
                ALL,
            )
            .expect("author wall");
    }
    world.step().expect("identity step");
    world
        .native_configure(NativeConfig {
            max_iterations: 2048,
            tolerance: 1.0e-5,
            warm_start: true,
            damage_rate: 2.0,
            bend_gain_max: 3.0,
            fibre_bending: true,
            reserved_contact_pairs: chunks * 3 / 2,
            preserve_unchanged_contact_pairs,
            gpu_island_repair: true,
            verdict_sample_ticks: 1,
        })
        .expect("configure stage");

    // Cannonball-sized and meteor-sized balls, resting and rolling, all well
    // clear of the walls: nothing the fractures throw reaches them.
    let mut balls = Vec::new();
    for k in 0..8u32 {
        let x = -45.0 + k as f32 * 13.0;
        let (radius, z) = if k % 2 == 0 { (0.69, 30.0) } else { (2.0, -30.0) };
        let speed = if k % 4 < 2 { 0.0 } else { 2.0 };
        balls.push(ball(&mut world, 0x2000_0001 + k, x, z, radius, Vec3::new(speed, 0.0, 0.0)));
    }

    let mut out = Outcome::default();
    let mut previous: std::collections::HashMap<u32, (Vec3, Vec3, bool)> = Default::default();
    let mut sunk: std::collections::HashSet<u32> = Default::default();
    let mut lost: std::collections::HashSet<u32> = Default::default();
    let mut tick = 0u32;
    let mut observe = |world: &mut World, out: &mut Outcome, tick: u32| {
        if cars {
            for car in [0x6000_0001u32, 0x6000_0002] {
                let commands = if driving {
                    VehicleCommands { throttle: 0.35, steer: 1.0, ..VehicleCommands::default() }
                } else {
                    VehicleCommands::default()
                };
                world.drive_vehicle(car, commands).expect("drive");
            }
        }
        if player {
            world.move_player(0x4000_0001, Vec3::new(0.0, -0.1, 0.0)).expect("player");
        }
        world.step().expect("step");
        let status = world.native_tick().expect("observe");
        assert_eq!(status.error, 0, "tick {tick}: stage rejected the step");
        let corrected = status.correction_passes > 0;
        if corrected {
            out.correction_ticks += 1;
        }
        out.broken_bonds += world.native_take_broken_bonds().expect("bonds").len();
        let _ = world.native_take_island_events();
        let _ = world.native_take_chunk_migrations();
        let contacts = world.take_contact_events().expect("contacts");
        let snapshots = world.body_snapshots().expect("snapshots");
        let mut reporting = 0;
        for b in &balls {
            let touching_ground = contacts.iter().any(|c| {
                (c.entity_a == b.entity && c.entity_b == GROUND)
                    || (c.entity_b == b.entity && c.entity_a == GROUND)
            });
            let Some(s) = snapshots.iter().find(|s| s.entity_id == b.entity) else { continue };
            let p = s.pose.position;
            let v = s.linear_velocity;
            let (pp, pv, was_touching) =
                previous.get(&b.entity).copied().unwrap_or((p, v, touching_ground));
            reporting += usize::from(was_touching && !s.sleeping);
            // The tick support went: at rest on the slab last tick, gravity's
            // whole increment this tick.
            if (pp.y - b.radius).abs() < 0.05 && pv.y.abs() < 0.02 && v.y < -0.12 && lost.insert(b.entity) {
                out.support_lost.push(format!(
                    "ball {:#x} lost support on tick {tick}: vy {:.3} -> {:.3}; this tick corrected: {corrected}",
                    b.entity, pv.y, v.y
                ));
            }
            if p.y < b.radius - 0.25 && sunk.insert(b.entity) {
                out.sunk.push(format!(
                    "ball {:#x} r={} tick {tick} (corrections so far {}): y {:.3} vy {:.3} sleeping {} \
                     ground report {}; tick before y {:.3} vy {:.3} ground report {} (free fall adds {:.3}/tick)",
                    b.entity,
                    b.radius,
                    out.correction_ticks,
                    p.y,
                    v.y,
                    s.sleeping,
                    touching_ground,
                    pp.y,
                    pv.y,
                    was_touching,
                    -9.81f32 / 60.0,
                ));
            }
            previous.insert(b.entity, (p, v, touching_ground));
        }
        if corrected {
            out.corrections.push(format!(
                "tick {tick}: {} corrected pass(es), {} awake balls reporting ground contact the tick before",
                status.correction_passes, reporting
            ));
        }
    };

    // Settle: the balls land and the rolling ones roll.
    for _ in 0..60 {
        observe(&mut world, &mut out, tick);
        tick += 1;
    }
    assert!(out.sunk.is_empty(), "a ball sank before anything fractured: {:#?}", out.sunk);

    // One shot per wall, alternating a /city cannonball (a launched ball,
    // 10.65 t at 60 m/s) with the stage's own round, as the city's cannon and
    // demolition do.
    for i in 0..WALLS {
        let x = wall_x(i);
        if i % 2 == 0 {
            world
                .launch_dynamic_ball(LaunchedBallDesc {
                    entity_id: 0x2000_0100 + i,
                    user_id: 0x100 + i,
                    pose: Pose { position: Vec3::new(x + 0.3, 4.5, 12.0), rotation: Quat::IDENTITY },
                    radius: 0.69,
                    mass: 10_650.0,
                    linear_velocity: Vec3::new(0.0, 0.0, -60.0),
                    collision_group: GROUP_DYNAMIC,
                    collision_mask: ALL,
                })
                .expect("cannonball");
        } else {
            world
                .native_fire_round(RoundDesc {
                    position: Vec3::new(x + 0.3, 4.5, 1.5),
                    direction: Vec3::new(0.0, 0.0, -1.0),
                    momentum_ns: 4.0e5,
                    radius: 0.4,
                    speed: 20.0,
                    ttl_ticks: 30,
                })
                .expect("fire");
        }
        for _ in 0..60 {
            observe(&mut world, &mut out, tick);
            tick += 1;
        }
    }
    // And let the rubble settle on the slab.
    for _ in 0..120 {
        observe(&mut world, &mut out, tick);
        tick += 1;
    }

    out.lowest_ball_y = world
        .body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|s| balls.iter().any(|b| b.entity == s.entity_id))
        .map(|s| s.pose.position.y)
        .fold(f32::MAX, f32::min);
    for snap in world.native_chunk_body_snapshots().expect("chunk snapshots") {
        if snap.position.y < -1.0 {
            out.chunks_below.push(format!(
                "fragment {:#x} ({} chunks) at y {:.2}, vy {:.2}, sleeping {}",
                snap.entity_id, snap.node_count, snap.position.y, snap.linear_velocity.y, snap.sleeping
            ));
        }
    }
    out
}

fn assert_nothing_went_through(out: &Outcome) {
    assert!(out.broken_bonds > 0, "the walls never broke, so this tested nothing");
    assert!(out.correction_ticks > 0, "no fracturing tick was re-solved, so this tested nothing");
    assert!(out.sunk.is_empty(), "bodies lying on the ground fell through it: {:#?}", out.sunk);
    assert!(out.chunks_below.is_empty(), "fragments fell through the ground: {:#?}", out.chunks_below);
}

/// The /city scene as production runs it: the stage configured as
/// `destruction/src/native_runtime.rs` does, two parked cars, a player.
/// Fails on the current PhysX fork; see the module docs.
#[test]
fn bodies_on_the_ground_stay_on_it_while_the_city_fractures() {
    let out = run(true, true, true);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}

/// The same with the stage's reference pair lifecycle
/// (`preserveUnchangedContactPairs = false`): not the experimental pair reuse.
#[test]
fn bodies_on_the_ground_stay_on_it_with_the_reference_pair_lifecycle() {
    let out = run(false, true, true);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}

/// The cars alone are enough.
#[test]
fn bodies_on_the_ground_stay_on_it_with_cars_and_no_player() {
    let out = run(true, true, false);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}

/// Cars driving in circles stay awake through every fracture, so the
/// corrected pass's bounds refresh sees their wheel shapes instead of the
/// sleep commit.
#[test]
fn bodies_on_the_ground_stay_on_it_with_driving_cars() {
    let out = run_with(true, true, false, true);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}

/// Control: the same fractures with no vehicle in the scene lose nothing.
#[test]
fn bodies_on_the_ground_stay_on_it_without_cars() {
    let out = run(true, false, false);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}

/// Control: a player capsule (a kinematic actor with CPU-authored targets) is
/// not the trigger.
#[test]
fn bodies_on_the_ground_stay_on_it_with_a_player_and_no_cars() {
    let out = run(true, false, true);
    eprintln!("{out:#?}");
    assert_nothing_went_through(&out);
}
