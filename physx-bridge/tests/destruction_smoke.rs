#![cfg(feature = "destruction")]

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, StaticBoxDesc, Vec3, World,
    WorldConfig,
};

fn cuboid_node(index: u32, y: f32, mass: f32) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: index,
        centroid: Vec3::new(0.0, y, 0.0),
        mass,
        volume: 1.0,
        geom_kind: 0,
        half_extents: Vec3::new(0.5, 0.5, 0.5),
        convex_points: Vec::new(),
    }
}

fn bond(index: u32, a: u32, b: u32, y: f32) -> ChunkBondDesc {
    ChunkBondDesc {
        bond_index: index,
        node0: a,
        node1: b,
        centroid: Vec3::new(0.0, y, 0.0),
        normal: Vec3::new(0.0, 1.0, 0.0),
        area: 1.0,
    }
}

#[test]
fn destruction_tower_settles_and_fractures() {
    const GROUP_STATIC: u32 = 1 << 0;
    const GROUP_CHUNK: u32 = 1 << 5;
    const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;

    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 0x1000_0001,
            user_id: 0,
            pose: Pose {
                position: Vec3::new(0.0, -0.5, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: Vec3::new(20.0, 0.5, 20.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");

    let nodes = vec![
        cuboid_node(0, 0.5, 0.0), // support
        cuboid_node(1, 1.5, 200.0),
        cuboid_node(2, 2.5, 200.0),
        cuboid_node(3, 3.5, 200.0),
    ];
    let bonds = vec![
        bond(0, 0, 1, 1.0),
        bond(1, 1, 2, 2.0),
        bond(2, 2, 3, 3.0),
    ];
    let mut settings = DestructibleSettings::default();
    // Soft limits so a large impulse fractures quickly in the smoke test.
    settings.compression_elastic = 1.0e-4;
    settings.compression_fatal = 5.0e-4;
    settings.maximum_bodies = 16;
    settings.maximum_fractures_per_actor_per_tick = 8;

    world
        .create_destructible(
            0,
            Pose {
                position: Vec3::new(0.0, 0.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            ALL,
        )
        .expect("create tower");

    assert!(
        world.validate_destruction_mappings().expect("validate"),
        "adapter mappings invalid after create"
    );

    let gravity = Vec3::new(0.0, -9.81, 0.0);
    // Warm-up: support must remain standing (filter-gap regression).
    for _ in 0..30 {
        world.step().expect("step");
        world.destruction_tick(1.0 / 60.0, gravity).expect("tick");
    }
    let resting = world.chunk_body_snapshots().expect("snapshots");
    assert!(
        resting.iter().all(|b| b.position.y > -0.25),
        "chunks fell through ground: {:?}",
        resting
    );

    let affected = world
        .apply_destruction_explosion(Vec3::new(0.0, 3.5, 0.0), 2.5, 5.0e5)
        .expect("explosion");
    assert!(affected > 0, "explosion hit no shapes");

    let mut saw_break = false;
    let mut saw_promo = false;
    for _ in 0..(60 * 4) {
        world.step().expect("step");
        world.destruction_tick(1.0 / 60.0, gravity).expect("tick");
        let broken = world.take_broken_bonds().expect("bonds");
        let islands = world.take_island_events().expect("islands");
        saw_break |= !broken.is_empty();
        saw_promo |= islands.iter().any(|e| e.kind == 0 && !e.chunk_ids.is_empty());
        if saw_break && saw_promo {
            break;
        }
    }
    assert!(saw_break, "expected broken bonds after explosion");
    assert!(saw_promo, "expected island promotions after explosion");

    let awake = world.chunk_body_snapshots().expect("snapshots");
    assert!(
        !awake.is_empty() || saw_promo,
        "expected dynamic debris bodies after fracture"
    );
    assert!(
        world.validate_destruction_mappings().expect("validate"),
        "adapter mappings invalid after fracture"
    );
}

/// Hitscan against the city must resolve on the real chunk colliders.
///
/// The server used to pick a target by intersecting the shot ray with a
/// per-structure bounding sphere. That sphere is far larger than the building,
/// so the "hit point" landed metres off the facade in open air: shots that
/// visually hit did nothing, shots that visually missed damaged the tower, and
/// once a crater opened the sphere kept reporting hits into the hole forever.
/// A raycast masked to GROUP_CHUNK reports the true surface point instead.
#[test]
fn chunk_raycast_resolves_the_real_surface_and_misses_are_real() {
    use vibe_land_physx_bridge::RaycastRequest;

    const GROUP_STATIC: u32 = 1 << 0;
    const GROUP_CHUNK: u32 = 1 << 5;
    const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;
    const NS_CHUNK: u32 = 0x8000_0000;

    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
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

    // A 1 m column of unit cubes centred on the origin, spanning x,z in [-0.5, 0.5].
    let nodes = vec![
        cuboid_node(0, 0.5, 0.0),
        cuboid_node(1, 1.5, 200.0),
        cuboid_node(2, 2.5, 200.0),
    ];
    let bonds = vec![bond(0, 0, 1, 1.0), bond(1, 1, 2, 2.0)];
    let mut settings = DestructibleSettings::default();
    settings.maximum_bodies = 16;
    world
        .create_destructible(
            3,
            Pose {
                position: Vec3::new(0.0, 0.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            ALL,
        )
        .expect("create tower");

    for _ in 0..10 {
        world.step().expect("step");
        world.destruction_tick(1.0 / 60.0, Vec3::new(0.0, -9.81, 0.0)).expect("tick");
    }

    // Straight at the column from -z: must hit the near face at z = -0.5.
    let hit = world
        .raycast(RaycastRequest {
            origin: Vec3::new(0.0, 1.5, -10.0),
            direction: Vec3::new(0.0, 0.0, 1.0),
            max_distance: 100.0,
            collision_mask: GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .expect("raycast");
    assert!(hit.hit, "ray aimed at the column should hit a chunk");
    assert_eq!(
        hit.entity_id & 0xf000_0000,
        NS_CHUNK,
        "a chunk hit must report a chunk-namespaced entity, got {:#x}",
        hit.entity_id
    );
    assert!(
        (hit.position.z + 0.5).abs() < 0.2,
        "hit should land on the near face (z=-0.5), got z={}",
        hit.position.z
    );
    assert!(
        (hit.distance - 9.5).abs() < 0.3,
        "hit distance should be ~9.5 m, got {}",
        hit.distance
    );

    // Parallel to the column, 5 m to the side: a real miss. The old bounding
    // sphere reported this as a hit.
    let miss = world
        .raycast(RaycastRequest {
            origin: Vec3::new(5.0, 1.5, -10.0),
            direction: Vec3::new(0.0, 0.0, 1.0),
            max_distance: 100.0,
            collision_mask: GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .expect("raycast");
    assert!(!miss.hit, "a shot 5 m wide of the column must miss");

    // Aimed over the top: also a miss.
    let over = world
        .raycast(RaycastRequest {
            origin: Vec3::new(0.0, 8.0, -10.0),
            direction: Vec3::new(0.0, 0.0, 1.0),
            max_distance: 100.0,
            collision_mask: GROUP_CHUNK,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .expect("raycast");
    assert!(!over.hit, "a shot above the column must miss");
}
