//! What freezing settled debris actually does to PhysX, measured.
//!
//! The freeze design rests on claims about engine behaviour that are cheaper
//! to measure than to argue about, and each one has a failure mode that would
//! only show up in a live session otherwise:
//!
//! 1. Making a body kinematic must not wake the rest of its contact island.
//!    If it does, freezing a settled pile a batch at a time would wake the
//!    pile it is trying to retire -- the exact 6,065-body cascade the campaign
//!    exists to stop, caused by the fix rather than by a shot.
//! 2. A frozen body must keep its collider, or debris and players fall
//!    through settled rubble.
//! 3. A frozen body must keep its island serial across the round trip. The
//!    adapter uses `kinematic` to mean "structure support actor, serial 0", so
//!    a frozen body that got re-serialised would be retired and re-promoted on
//!    the wire, losing its chunks.
//! 4. Unfreezing must return the body at rest at the pose it was frozen at,
//!    not fire it out of the pile on baked-in interpenetration.
//!
//! These are GPU tests: the scene is GPU-mandatory, so they only run where
//! CUDA and a device are present.

#![cfg(feature = "destruction")]

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, RaycastRequest,
    StaticBoxDesc, StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;
const GRAVITY: Vec3 = Vec3 { x: 0.0, y: -9.81, z: 0.0 };
const DT: f32 = 1.0 / 60.0;

fn node(index: u32, centroid: Vec3, mass: f32) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: index,
        centroid,
        mass,
        volume: 1.0,
        geom_kind: 0,
        half_extents: Vec3::new(0.5, 0.5, 0.5),
        convex_points: Vec::new(),
    }
}

fn bond(index: u32, a: u32, b: u32, centroid: Vec3) -> ChunkBondDesc {
    ChunkBondDesc {
        bond_index: index,
        node0: a,
        node1: b,
        centroid,
        normal: Vec3::new(0.0, 1.0, 0.0),
        area: 1.0,
        material: 0,
    }
}

/// A wall of weakly bonded blocks over a ground plane. Blasting it leaves a
/// pile of touching debris -- one contact island, which is the configuration
/// the whole campaign is about.
fn rubble_world(columns: u32, rows: u32) -> World {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 0x1000_0001,
            user_id: 0,
            pose: Pose { position: Vec3::new(0.0, -0.5, 0.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(40.0, 0.5, 40.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");

    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let mut index = 0u32;
    // Row 0 is the support course: zero mass marks a support node, which the
    // adapter represents with a kinematic actor at serial 0.
    for column in 0..columns {
        let x = column as f32 * 1.05 - (columns as f32 * 0.5);
        nodes.push(node(index, Vec3::new(x, 0.5, 0.0), 0.0));
        index += 1;
    }
    for row in 1..rows {
        for column in 0..columns {
            let x = column as f32 * 1.05 - (columns as f32 * 0.5);
            let y = row as f32 * 1.05 + 0.5;
            nodes.push(node(index, Vec3::new(x, y, 0.0), 120.0));
            let below = index - columns;
            bonds.push(bond(bonds.len() as u32, below, index, Vec3::new(x, y - 0.5, 0.0)));
            if column > 0 {
                bonds.push(bond(
                    bonds.len() as u32,
                    index - 1,
                    index,
                    Vec3::new(x - 0.5, y, 0.0),
                ));
            }
            index += 1;
        }
    }

    let mut settings = DestructibleSettings::default();
    // Weak enough that one blast reduces the wall to loose debris, and
    // uncapped so the pile is as large as the geometry allows -- a body cap
    // silently drops fracture commands and would leave a welded slab instead
    // of the touching pile these tests need.
    settings.materials = vec![StressMaterialDesc {
        compression_elastic: 1.0e-4,
        compression_fatal: 5.0e-4,
        tension_elastic: 1.0e-4,
        tension_fatal: 5.0e-4,
        shear_elastic: -1.0,
        shear_fatal: -1.0,
    }];
    settings.maximum_bodies = 0;
    settings.maximum_fractures_per_actor_per_tick = 0;
    world
        .create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat::IDENTITY },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            ALL,
        )
        .expect("create wall");
    world
}

fn tick(world: &mut World) {
    world.step().expect("step");
    world.destruction_tick(DT, GRAVITY).expect("tick");
    let _ = world.take_broken_bonds();
    let _ = world.take_chunk_migrations();
    let _ = world.take_island_events();
}

fn awake(world: &World) -> u32 {
    world.destruction_stats().expect("stats").awake_chunk_bodies
}

/// Blast the wall down and run until the debris pile is asleep. Returns the
/// entity ids of the sleeping dynamic bodies.
fn settled_pile(world: &mut World, max_ticks: u32) -> Vec<u32> {
    for _ in 0..30 {
        tick(world);
    }
    world
        .apply_destruction_blast(
            Vec3::new(0.0, 3.0, 0.0),
            Vec3::new(0.0, -1.0, 0.2),
            8.0,
            5.0e6,
            6.0,
        )
        .expect("blast");
    for _ in 0..max_ticks {
        tick(world);
        if awake(world) == 0 {
            break;
        }
    }
    world
        .chunk_body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|body| body.sleeping && !body.kinematic)
        .map(|body| body.entity_id)
        .collect()
}

/// The load-bearing measurement: freezing part of a sleeping pile must not
/// wake the rest of it.
///
/// `setRigidBodyFlag(eKINEMATIC)` is a write to a rigid body, and writes to
/// rigid bodies are exactly what woke the whole city 60 times a second in the
/// identity-stamp regression. If the flip cascaded through the contact island,
/// freezing a pile in batches would be self-defeating.
#[test]
fn freezing_part_of_a_sleeping_pile_leaves_the_rest_asleep() {
    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 20);
    assert!(
        pile.len() >= 4,
        "need a real pile to test against, got {} bodies",
        pile.len()
    );
    assert_eq!(awake(&world), 0, "pile must be fully asleep before freezing");

    // Freeze a single member, the way a batched freeze would.
    let frozen = world.freeze_chunk_bodies(&pile[..1]).expect("freeze");
    assert_eq!(frozen, 1, "one body should have changed state");

    for _ in 0..60 {
        tick(&mut world);
    }
    let stats = world.destruction_stats().expect("stats");
    assert_eq!(
        stats.awake_chunk_bodies, 0,
        "freezing one body woke {} others -- the flip cascades through the \
         contact island, so freezing must be island-coherent",
        stats.awake_chunk_bodies
    );
    assert_eq!(stats.frozen_chunk_bodies, 1);
    assert_eq!(
        stats.frozen_serial_blocks, 0,
        "a frozen body reached a serial-issuing path"
    );
}

/// Freezing the whole pile must retire it from the solver without disturbing
/// it, and must not present as bodies being retired on the wire.
#[test]
fn freezing_a_whole_pile_retires_it_without_losing_identity() {
    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 20);
    assert!(pile.len() >= 4, "need a real pile, got {}", pile.len());

    let before: Vec<(u32, [f32; 3])> = world
        .chunk_body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|body| pile.contains(&body.entity_id))
        .map(|body| {
            (body.entity_id, [body.position.x, body.position.y, body.position.z])
        })
        .collect();

    let frozen = world.freeze_chunk_bodies(&pile).expect("freeze");
    assert_eq!(frozen as usize, pile.len());

    let mut retired = 0;
    let mut promoted = 0;
    for _ in 0..120 {
        world.step().expect("step");
        world.destruction_tick(DT, GRAVITY).expect("tick");
        let _ = world.take_broken_bonds();
        let _ = world.take_chunk_migrations();
        for event in world.take_island_events().expect("islands") {
            match event.kind {
                0 => promoted += 1,
                _ => retired += 1,
            }
        }
    }

    let stats = world.destruction_stats().expect("stats");
    assert_eq!(stats.frozen_chunk_bodies as usize, pile.len());
    assert_eq!(stats.awake_chunk_bodies, 0, "a frozen pile must cost no solver work");
    assert_eq!(
        stats.frozen_serial_blocks, 0,
        "frozen bodies must never re-enter a serial-issuing path"
    );
    // A freeze is not a topology change. If the adapter re-serialised these
    // bodies they would appear as retire/promote pairs, and the client would
    // drop and rebuild their chunks.
    assert_eq!(retired, 0, "freezing must not retire islands");
    assert_eq!(promoted, 0, "freezing must not promote islands");

    // Frozen bodies leave the snapshot stream entirely, which is what stops
    // the encoder paying for them.
    let streamed = world.chunk_body_snapshots().expect("snapshots");
    for (entity, _) in &before {
        assert!(
            !streamed.iter().any(|body| body.entity_id == *entity),
            "frozen body {entity} is still being streamed"
        );
    }
    assert!(
        world.validate_destruction_mappings().expect("validate"),
        "adapter mappings invalid after freezing"
    );
}

/// A frozen pile still has to be solid: debris landing on it must stack, not
/// fall through. This is the property that makes kinematic the right lever and
/// `eDISABLE_SIMULATION` the wrong one.
#[test]
fn frozen_rubble_still_collides() {
    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 20);
    assert!(pile.len() >= 4, "need a real pile, got {}", pile.len());

    let top = world
        .chunk_body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|body| pile.contains(&body.entity_id))
        .map(|body| body.position.y)
        .fold(f32::NEG_INFINITY, f32::max);

    world.freeze_chunk_bodies(&pile).expect("freeze");

    // The collision the pile has to keep is against its shapes, so assert the
    // fact that collision rests on: the frozen shapes are still in the scene,
    // still carry chunk query filter data, and a ray down the pile finds them.
    // A shot that missed frozen rubble, or a player who fell through it,
    // would fail here first.
    let hit = world
        .raycast(RaycastRequest {
            origin: Vec3::new(0.0, top + 10.0, 0.0),
            direction: Vec3::new(0.0, -1.0, 0.0),
            max_distance: 40.0,
            collision_mask: GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .expect("raycast");
    assert!(
        hit.hit,
        "frozen rubble vanished from the scene: a shot at the pile would miss \
         and a player would fall through it"
    );
}

/// The closed loop: freeze, then release, and the body must come back at the
/// pose it was parked at, at rest, with the same identity.
#[test]
fn unfreezing_restores_the_body_at_rest_and_in_place() {
    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 20);
    assert!(pile.len() >= 4, "need a real pile, got {}", pile.len());

    let parked: Vec<(u32, [f32; 3])> = world
        .chunk_body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|body| pile.contains(&body.entity_id))
        .map(|body| (body.entity_id, [body.position.x, body.position.y, body.position.z]))
        .collect();

    world.freeze_chunk_bodies(&pile).expect("freeze");
    for _ in 0..30 {
        tick(&mut world);
    }
    let released = world.unfreeze_chunk_bodies(&pile).expect("unfreeze");
    assert_eq!(released as usize, pile.len());

    // The snapshot buffer is refreshed by the tick, so a released body
    // rejoins the pose stream on the next one -- which is also when the
    // deferred push that released it is applied.
    tick(&mut world);

    let restored = world.chunk_body_snapshots().expect("snapshots");
    for (entity, position) in &parked {
        let body = restored
            .iter()
            .find(|body| body.entity_id == *entity)
            .unwrap_or_else(|| panic!("body {entity} lost its identity across a freeze"));
        let moved = ((body.position.x - position[0]).powi(2)
            + (body.position.y - position[1]).powi(2)
            + (body.position.z - position[2]).powi(2))
        .sqrt();
        assert!(
            moved < 0.05,
            "body {entity} moved {moved:.3} m while frozen; it must be parked exactly"
        );
        let speed = (body.linear_velocity.x.powi(2)
            + body.linear_velocity.y.powi(2)
            + body.linear_velocity.z.powi(2))
        .sqrt();
        assert!(
            speed < 0.5,
            "body {entity} came back at {speed:.2} m/s -- that is the \
             depenetration pop the freeze pose is supposed to avoid"
        );
    }

    let stats = world.destruction_stats().expect("stats");
    assert_eq!(stats.frozen_chunk_bodies, 0);
    assert_eq!(stats.frozen_serial_blocks, 0);
    assert!(
        world.validate_destruction_mappings().expect("validate"),
        "adapter mappings invalid after a freeze/wake cycle"
    );
}

/// The structure's own support actor is kinematic by the adapter's design.
/// Unfreezing it would drop a standing building into free fall, so both calls
/// must refuse to touch serial 0.
#[test]
fn the_support_actor_is_never_frozen_or_released() {
    let mut world = rubble_world(6, 5);
    for _ in 0..60 {
        tick(&mut world);
    }
    // Serial 0 of structure 0, packed as ids.rs does it.
    let support = 0x8000_0000u32;
    assert_eq!(world.freeze_chunk_bodies(&[support]).expect("freeze"), 0);
    assert_eq!(world.unfreeze_chunk_bodies(&[support]).expect("unfreeze"), 0);
    let stats = world.destruction_stats().expect("stats");
    assert_eq!(stats.frozen_chunk_bodies, 0);
    assert_eq!(stats.freeze_flips, 0);
    assert_eq!(stats.unfreeze_flips, 0);
}

/// Both calls are given ids from a picture of the world that is at least one
/// tick old, so unknown and duplicate ids are normal input, not errors.
#[test]
fn unknown_and_repeated_ids_are_tolerated() {
    let mut world = rubble_world(4, 3);
    let pile = settled_pile(&mut world, 60 * 20);
    assert!(!pile.is_empty(), "need at least one settled body");

    // Never-existed serial, plus a real one twice.
    let ids = [0x8000_0000u32 | 0x3f_ffff, pile[0], pile[0]];
    let frozen = world.freeze_chunk_bodies(&ids).expect("freeze");
    assert_eq!(frozen, 1, "the duplicate must not double-count");
    assert_eq!(world.destruction_stats().expect("stats").frozen_chunk_bodies, 1);
    // Freezing an already-frozen body is a no-op, not an error.
    assert_eq!(world.freeze_chunk_bodies(&[pile[0]]).expect("freeze"), 0);
    assert_eq!(world.unfreeze_chunk_bodies(&[pile[0]]).expect("unfreeze"), 1);
    assert_eq!(world.unfreeze_chunk_bodies(&[pile[0]]).expect("unfreeze"), 0);
}

/// The user's bug, reproduced: debris landing on frozen rubble must release
/// it, not bounce off it as though it were bedrock.
///
/// Pieces that fell earlier freeze where they landed. A later collapse rains
/// chunks onto them -- and a kinematic body is immovable, so without a
/// release path the falling debris strikes invisible anchors and the
/// collapse visibly "hits itself". PhysX's own rule -- a moving body wakes
/// what it strikes -- has no effect on kinematic bodies, so the bridge
/// listens to the engine's contact reports instead: an impulse well above
/// the striker's resting load releases the frozen body it hit, that tick.
///
/// The striker here is a plain dynamic box dropped from height, deliberately:
/// it goes nowhere near the weapon path or the stress solver, so the only
/// mechanism that can register the hit is the engine's collision detection.
/// This is the pure form of "the collapse lands on old rubble".
#[test]
fn debris_landing_on_frozen_rubble_releases_it_by_contact() {
    use vibe_land_physx_bridge::DynamicBoxDesc;

    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 30);
    assert!(pile.len() >= 4, "need a settled pile, got {} bodies", pile.len());

    let frozen = world.freeze_chunk_bodies(&pile).expect("freeze");
    assert!(frozen > 0);
    let before = world.destruction_stats().expect("stats");
    assert_eq!(before.contact_wakes, 0, "nothing has struck the pile yet");

    // Where the pile actually is, so the drop cannot miss it.
    let top = world
        .chunk_body_snapshots()
        .expect("snapshots")
        .iter()
        .filter(|body| pile.contains(&body.entity_id))
        .map(|body| (body.position.x, body.position.y, body.position.z))
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .expect("pile has members");

    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 0x4000_0001,
            user_id: 0,
            pose: Pose {
                position: Vec3::new(top.0, top.1 + 5.0, top.2),
                rotation: Quat::IDENTITY,
            },
            half_extents: Vec3::new(0.5, 0.5, 0.5),
            mass: 500.0,
            collision_group: GROUP_CHUNK,
            collision_mask: ALL,
        })
        .expect("drop box");
    for _ in 0..(60 * 3) {
        tick(&mut world);
    }

    let after = world.destruction_stats().expect("stats");
    assert!(
        after.contact_wakes > 0,
        "a 500 kg box fell 5 m onto a frozen pile and released nothing: \
         debris is bouncing off kinematic anchors ({} frozen, {} awake)",
        after.frozen_chunk_bodies,
        after.awake_chunk_bodies,
    );
    // And the release is local: an impact does not thaw the whole pile.
    assert!(
        after.frozen_chunk_bodies > 0,
        "one impact released the entire pile"
    );
    assert_eq!(after.frozen_serial_blocks, 0);
    assert!(
        world.validate_destruction_mappings().expect("validate"),
        "mappings invalid after contact wakes"
    );
}

/// Phase-0 pin for the dependency-graph freeze design, with the measured
/// results encoded as assertions so a driver/SDK bump that changes them
/// fails loudly.
///
/// MEASURED on this stack (GPU dynamics + GPU broadphase, PhysX 5):
///   - dynamic-vs-dynamic chunk pairs: thousands of threshold reports -- the
///     supporter-edge data source for debris-on-debris is REAL;
///   - dynamic-vs-KINEMATIC (chunk on a rooted stump): reports fire -- the
///     stump-supporter data source is real;
///   - dynamic-vs-STATIC (chunk on the ground): ZERO reports, ever. The GPU
///     threshold stream excludes statics (the header's "CPU only" caveat is
///     real for exactly this class).
///
/// Design consequence, not a compromise: static geometry is IMMUTABLE, so
/// World support needs no invalidation events -- an analytic admission-time
/// test (body bottom at the ground plane / against static geometry) is
/// exactly as correct as a contact report, because no event can ever need to
/// revoke it. Only movable support (other debris, stumps) needs event
/// evidence, and those are precisely the classes that report.
///
/// Also encoded: the ground-reaction damage-sign audit is MOOT (ground pairs
/// never reach route_contact_shape at all), and the chunk-chunk impulse sign
/// is ordering-dependent (eINTERNAL_CONTACTS_ARE_FLIPPED, uncorrected), so
/// support-edge orientation must come from relative COM height, never the
/// sign -- the probe prints the mixed-sign distribution for the record.
#[test]
fn resting_contact_reports_fire_on_gpu_and_the_sign_is_measured() {
    let mut world = rubble_world(6, 5);
    let pile = settled_pile(&mut world, 60 * 30);
    assert!(pile.len() >= 4, "need a settled pile, got {} bodies", pile.len());

    // Wake the pile gently so pairs are simulated again (sleeping pairs do
    // not report -- that is why the supporter map must be sticky).
    world
        .apply_destruction_blast(
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, -1.0, 0.0),
            6.0,
            0.0,
            0.5,
        )
        .expect("nudge");

    let is_chunk = |entity: u32| entity & 0xf000_0000 == 0x8000_0000;
    let mut chunk_chunk = 0u32;
    let mut chunk_static = 0u32;
    let mut chunk_support = 0u32; // vs kinematic support/stump actors
    let mut up = 0u32;
    let mut down = 0u32;

    for _ in 0..90 {
        tick(&mut world);
        for event in world.take_contact_events().expect("events") {
            let a_chunk = is_chunk(event.entity_a);
            let b_chunk = is_chunk(event.entity_b);
            match (a_chunk, b_chunk) {
                (true, true) => {
                    let a_serial = event.entity_a & 0x003f_ffff;
                    let b_serial = event.entity_b & 0x003f_ffff;
                    if a_serial == 0 || b_serial == 0 {
                        chunk_support += 1;
                    } else {
                        chunk_chunk += 1;
                        if event.impulse.y > 0.0 { up += 1 } else { down += 1 }
                    }
                }
                (true, false) | (false, true) => chunk_static += 1,
                _ => {}
            }
        }
    }

    println!(
        "pin: chunk-chunk={chunk_chunk} chunk-stump={chunk_support} chunk-static={chunk_static}"
    );
    println!(
        "chunk-chunk impulse.y sign: +{up} / -{down} (ordering-dependent, unusable for orientation)"
    );

    assert!(
        chunk_chunk > 0,
        "no chunk-chunk threshold reports: the dependency-graph data source is \
         absent on this stack -- use the geometry fallback"
    );
    assert!(
        chunk_support > 0,
        "no chunk-vs-kinematic threshold reports: stump supporter edges have no \
         data source on this stack"
    );
    assert_eq!(
        chunk_static, 0,
        "chunk-vs-static pairs started reporting -- the GPU threshold stream \
         changed behaviour; revisit the analytic World-support rule (it stays \
         correct, but ground edges could now also come from reports)"
    );
}
