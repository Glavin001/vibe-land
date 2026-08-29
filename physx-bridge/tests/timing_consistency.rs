//! The bracket map has teeth: parent/child timing relations the stats
//! contract documents are ASSERTED here, so a refactor that breaks the
//! accounting fails in CI instead of quietly producing double-counts.
//!
//! What is deliberately NOT asserted: any comparison of a slot-SUMMED
//! `blast_*_ms` field against a wall-clock parent. Slots run concurrently;
//! that comparison is the trap that nearly bought a CUDA kernel for a
//! ~0.5 ms wall cost, and the field docs now carry the warning. The related
//! sane assertions — slot-MAX spans exist, and max ≤ sum — are here.

#![cfg(feature = "destruction")]

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, StaticBoxDesc,
    StressMaterialDesc, Vec3, World, WorldConfig,
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
        material: 0,
    }
}

#[test]
fn published_timings_stay_consistent_with_their_documented_relations() {
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
        cuboid_node(0, 0.5, 0.0),
        cuboid_node(1, 1.5, 200.0),
        cuboid_node(2, 2.5, 200.0),
        cuboid_node(3, 3.5, 200.0),
    ];
    let bonds = vec![bond(0, 0, 1, 1.0), bond(1, 1, 2, 2.0), bond(2, 2, 3, 3.0)];
    let mut settings = DestructibleSettings::default();
    settings.materials = vec![StressMaterialDesc {
        compression_elastic: 1.0e-4,
        compression_fatal: 5.0e-4,
        tension_elastic: -1.0,
        tension_fatal: -1.0,
        shear_elastic: -1.0,
        shear_fatal: -1.0,
    }];
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

    let gravity = Vec3::new(0.0, -9.81, 0.0);
    // Tolerance is generous: single ticks on a tiny scene are microseconds,
    // where clock granularity dominates. The relations must hold on the SUM
    // over many ticks, which is also how the numbers get consumed.
    let mut wall_children_sum = 0.0f64;
    let mut stress_wall_sum = 0.0f64;
    let mut gravity_sum_total = 0.0f64;
    let mut gravity_slotmax_total = 0.0f64;
    let mut slotmax_seen = false;
    for _ in 0..120 {
        world.step().expect("step");
        world.destruction_tick(1.0 / 60.0, gravity).expect("tick");
        let stats = world.destruction_stats().expect("stats");
        let spans = world.take_destruction_spans();
        stress_wall_sum += f64::from(stats.stress_solve_ms);
        // Serial wall segments of the destruction tick timeline: their sum
        // must not exceed the bracket that contains them.
        wall_children_sum += f64::from(stats.begin_ms)
            + f64::from(stats.solve_ms)
            + f64::from(stats.end_ms)
            + f64::from(stats.readback_ms)
            + f64::from(stats.events_ms)
            + f64::from(stats.filters_ms)
            + f64::from(stats.support_loads_ms)
            + f64::from(stats.ccd_ms)
            + f64::from(stats.slot_dispatch_ms)
            + f64::from(stats.bond_sample_ms)
            + f64::from(stats.shape_readback_ms);
        gravity_sum_total += f64::from(stats.blast_gravity_ms);
        for span in &spans {
            if span.name == "blast_gravity_slotmax_ms" {
                slotmax_seen = true;
                assert_eq!(span.kind, 0, "slot-max spans are wall-kind");
                gravity_slotmax_total += span.value;
            }
        }
    }
    assert!(
        wall_children_sum <= stress_wall_sum * 1.10 + 1.0,
        "wall children ({wall_children_sum:.2} ms summed) exceed their parent \
         stress_solve bracket ({stress_wall_sum:.2} ms) — a bracket refactor \
         double-counted or a child escaped its parent"
    );
    assert!(slotmax_seen, "slot-max spans missing from the channel");
    assert!(
        gravity_slotmax_total <= gravity_sum_total + 0.5,
        "per-slot MAX ({gravity_slotmax_total:.3}) exceeds the slot SUM \
         ({gravity_sum_total:.3}) — the accumulation is broken"
    );
}
