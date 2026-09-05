//! Production PhysX -> runtime -> reliable wire coverage for anchored fragments.
#![cfg(feature = "cuda-stress")]

use std::collections::HashSet;
use std::sync::Arc;
use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig};
use vibe_land_destruction::manifest::{
    BondDef, ChunkDef, ChunkGeometry, DestructionManifest, StructureManifest,
};
use vibe_land_destruction::runtime::{CityDestruction, GROUP_CHUNK, GROUP_STATIC};
use vibe_land_destruction::wire::{decode_bootstrap, decode_topology, CITY_WIRE_V3};
use vibe_land_physx_bridge::{Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig};
use vibe_netcode::destruction_backend::{StressMaterial, StressSolverSettings};

fn manifest() -> DestructionManifest {
    let columns = 6u32;
    let mut chunks = Vec::new();
    let mut bonds = Vec::new();
    for row in 0..5 {
        for column in 0..columns {
            let node = row * columns + column;
            let x = column as f32 * 1.05 - columns as f32 * 0.5;
            let y = row as f32 * 1.05 + 0.5;
            chunks.push(ChunkDef {
                node_index: node,
                centroid: [x, y, 0.0],
                mass: if row == 0 { 0.0 } else { 120.0 },
                volume: 1.0,
                size: [1.0; 3],
                geometry: ChunkGeometry::Cuboid {
                    half_extents: [0.5; 3],
                },
                radius: 0.87,
                support: row == 0,
                material: 0,
            });
            if row > 0 {
                bonds.push(BondDef {
                    bond_index: bonds.len() as u32,
                    node0: node - columns,
                    node1: node,
                    centroid: [x, y - 0.5, 0.0],
                    normal: [0.0, 1.0, 0.0],
                    area: 1.0,
                    material: 0,
                });
                if column > 0 {
                    bonds.push(BondDef {
                        bond_index: bonds.len() as u32,
                        node0: node - 1,
                        node1: node,
                        centroid: [x - 0.5, y, 0.0],
                        normal: [0.0, 1.0, 0.0],
                        area: 1.0,
                        material: 0,
                    });
                }
            }
        }
    }
    DestructionManifest {
        version: 1,
        structures: vec![StructureManifest {
            structure_id: 0,
            world_position: [0.0; 3],
            world_rotation: [0.0, 0.0, 0.0, 1.0],
            chunks,
            bonds,
        }],
        materials: vec![],
        material_appearance: vec![],
        shape_library: vec![],
    }
}

#[test]
fn rooted_fragments_reach_live_and_late_join_ledgers_with_their_rest_poses() {
    let manifest = Arc::new(manifest());
    let mut world = World::new(WorldConfig::default()).expect("GPU scene required");
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
            collision_mask: GROUP_STATIC | GROUP_CHUNK,
        })
        .expect("ground");
    let mut settings = StressSolverSettings::default();
    settings.maximum_bodies = 0;
    settings.maximum_fractures_per_actor_per_tick = 0;
    settings.materials = vec![StressMaterial {
        compression_elastic_mpa: 1e-4,
        compression_fatal_mpa: 5e-4,
        tension_elastic_mpa: 1e-4,
        tension_fatal_mpa: 5e-4,
        ..StressMaterial::default()
    }];
    let mut city =
        CityDestruction::build(manifest.clone(), &mut world, settings, 60).expect("city");
    let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
    encoder.set_wire_version(CITY_WIRE_V3);
    let initial = encoder.bootstrap_message(0);
    let mut packets = vec![initial];
    let mut announced = HashSet::from([0u32]);
    let mut rooted_seen = HashSet::new();
    let mut previous_seq = 0;
    for tick in 1..=90 {
        city.pre_step(&mut world);
        world.step().expect("physics");
        let output = city
            .post_step(&mut world, 1.0 / 60.0, [0.0, -9.81, 0.0])
            .expect("destruction");
        encoder.ingest_tick_topology_only(
            tick,
            city.staged_snapshots().expect("snapshots"),
            &output,
            &output.wakes,
        );
        for packet in encoder.take_topology_messages() {
            let message = decode_topology(&packet).expect("decode real topology bytes");
            assert_eq!(message.topo_seq, previous_seq + 1);
            previous_seq = message.topo_seq;
            for batch in &message.batches {
                for promotion in &batch.promoted_islands {
                    assert!(!promotion.chunks.is_empty());
                    announced.insert(promotion.island_id);
                }
                for migration in &batch.migrations {
                    assert!(
                        announced.contains(&migration.to_island_id),
                        "unannounced destination: {migration:?}"
                    );
                }
                for retired in &batch.retired_island_ids {
                    announced.remove(retired);
                }
            }
            packets.push(packet);
        }
        // Every anchor is still standing. Its new real serial must exist in
        // the ledger, be at rest, and carry the correct (non-origin) COM pose.
        let bootstrap = decode_bootstrap(&encoder.bootstrap_message(tick)).expect("late join");
        let mut members = HashSet::new();
        for island in &bootstrap.islands {
            for node in &island.nodes {
                assert!(members.insert(*node), "duplicate node {node}");
            }
            if island.island_id != 0 && island.nodes.iter().any(|&n| n < 6) {
                rooted_seen.insert(island.island_id);
                assert!(
                    island.settled,
                    "rooted fragment is not reliably at rest: {island:?}"
                );
                let mut weighted = glam::Vec3::ZERO;
                let mut mass = 0.0;
                for &node in &island.nodes {
                    let c = &manifest.structures[0].chunks[node as usize];
                    let weight = if c.mass > 0.0 { c.mass } else { 1.0 };
                    weighted += glam::Vec3::from_array(c.centroid) * weight;
                    mass += weight;
                }
                assert!((island.pose.position-weighted/mass).length()<1e-4,
                    "rooted bootstrap COM differs from fixed authored frame: {island:?}, expected={:?}",weighted/mass);
                assert_eq!(island.linear_velocity, glam::Vec3::ZERO);
                assert_eq!(island.angular_velocity, glam::Vec3::ZERO);
            }
        }
        assert_eq!(
            members.len(),
            manifest.structures[0].chunks.len(),
            "late join lost chunks at tick {tick}"
        );
    }
    assert!(!rooted_seen.is_empty(), "no rooted fragment exercised");
    assert_eq!(
        city.stats().rooted_guard_blocks,
        0,
        "wire birth entered the debris freeze path"
    );
    assert!(city.resim_counters().1 > 0, "no same-tick replay exercised");
    if let Ok(path) = std::env::var("VIBE_ROOTED_WIRE_CAPTURE") {
        let final_bootstrap = encoder.bootstrap_message(90);
        let capture = serde_json::json!({"manifest":&*manifest,"packets":packets,"finalBootstrap":final_bootstrap,
            "rooted":rooted_seen,"serverHashes":encoder.ledger().structure_hashes().into_iter().map(|(structure,hash)|
                serde_json::json!({"structureId":structure,"laneA":(hash>>32) as u32,"laneB":hash as u32})).collect::<Vec<_>>()});
        std::fs::write(
            path,
            serde_json::to_vec(&capture).expect("serialize capture"),
        )
        .expect("write capture");
    }
}
