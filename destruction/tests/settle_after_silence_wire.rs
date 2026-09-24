//! A fragment thrown out of a client's interest settles far from the last pose
//! that client was streamed. Production encoder, production wire, no physics.
//!
//! This pins the server behaviour the client has to accept (to-do item 6 of
//! docs/mac-metal-session-analysis-2026-09-24.md): the per-client interest
//! filter stops streaming a body once it is outside the view and the
//! proximity radius, so the body's motion from there on never reaches that
//! client, and the settle (sent on the reliable stream to everyone) is the
//! first pose it gets since. In both 2026-09-24 sessions the client took
//! every such settle for a membership disagreement and asked for a structure
//! repair: 17 settle rejects, 5 + 9 repairs, on links with no loss.
//!
//! `VIBE_SETTLE_SILENCE_CAPTURE=<path>` writes the packets for the client's
//! test (`client/src/city/settleAfterSilence.test.ts`, fixture
//! `client/src/city/fixtures/settle-after-silence.json`).

use glam::Vec3;
use vibe_land_destruction::encoder::{BodySnapshotInput, ChunkStreamEncoder, EncoderConfig};
use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::{
    BondDef, ChunkDef, ChunkGeometry, DestructionManifest, StructureManifest,
};
use vibe_land_destruction::types::Camera;
use vibe_land_destruction::wire::{decode_chunks_datagram, decode_topology, PKT_CITY_CHUNKS};
use vibe_netcode::destruction_backend::{
    DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
};

const CLIENT: u64 = 1;
const STRUCTURE: u32 = 0;
const ISLAND: u32 = 1;
const FRACTURE_TICK: u32 = 10;
/// The fragment slides away from the camera at this speed until it stops.
const SPEED_MPS: f32 = 50.0;
const STOP_TICK: u32 = 250;
const SETTLE_TICK: u32 = 290;
const LAST_TICK: u32 = 360;

fn manifest() -> DestructionManifest {
    let chunk = |node: u32, y: f32, support: bool| ChunkDef {
        node_index: node,
        centroid: [0.0, y, 0.0],
        mass: if support { 0.0 } else { 100.0 },
        volume: 1.0,
        size: [1.0; 3],
        geometry: ChunkGeometry::Cuboid { half_extents: [0.5; 3] },
        radius: 0.87,
        support,
        material: 0,
    };
    DestructionManifest {
        version: 1,
        structures: vec![StructureManifest {
            structure_id: STRUCTURE,
            world_position: [0.0; 3],
            world_rotation: [0.0, 0.0, 0.0, 1.0],
            chunks: vec![chunk(0, 0.5, true), chunk(1, 1.5, false)],
            bonds: vec![BondDef {
                bond_index: 0,
                node0: 0,
                node1: 1,
                centroid: [0.0, 1.0, 0.0],
                normal: [0.0, 1.0, 0.0],
                area: 1.0,
                material: 0,
            }],
        }],
        materials: vec![],
        material_appearance: vec![],
        shape_library: vec![],
    }
}

/// The fragment's true pose: thrown past the camera along +z, then at rest
/// from `STOP_TICK`, 200 m out.
fn fragment_position(tick: u32) -> [f32; 3] {
    let moving_ticks = tick.min(STOP_TICK).saturating_sub(FRACTURE_TICK) as f32;
    [0.0, 1.5, SPEED_MPS * moving_ticks / 60.0]
}

fn fragment_velocity(tick: u32) -> [f32; 3] {
    if tick < STOP_TICK {
        [0.0, 0.0, SPEED_MPS]
    } else {
        [0.0; 3]
    }
}

/// The client watches the building from 10 m away, looking at it (-z), so
/// the fragment passes behind the camera and out of the proximity radius.
fn camera() -> Camera {
    Camera {
        eye: Vec3::new(0.0, 2.0, 10.0),
        direction: Vec3::NEG_Z,
        fov_degrees: 70.0,
    }
}

#[test]
fn a_settle_after_the_stream_went_silent_is_far_from_the_last_streamed_pose() {
    let manifest = manifest();
    let mut config = EncoderConfig::validated(60);
    // As the server configures it (server/src/city.rs).
    config.interest.proximity_meters = 120.0;
    let mut encoder = ChunkStreamEncoder::new(&manifest, config);
    encoder.add_client(CLIENT);
    let entity = ids::body_entity(STRUCTURE, ISLAND);

    let mut packets: Vec<Vec<u8>> = vec![encoder.bootstrap_message(0)];
    let mut last_streamed: Option<(u32, Vec3, Vec3)> = None;
    let mut settle_pose = None;
    for tick in 1..=LAST_TICK {
        let mut output = DestructionTickOutput::default();
        if tick == FRACTURE_TICK {
            output.batches.push(FractureBatch {
                structure_id: STRUCTURE,
                broken_bond_ids: vec![ids::bond_id(STRUCTURE, 0)],
                promoted_islands: vec![IslandPromotion {
                    structure_id: STRUCTURE,
                    island_id: ISLAND,
                    chunks: vec![ids::chunk_id(STRUCTURE, 1)],
                    position: fragment_position(tick),
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    linear_velocity: fragment_velocity(tick),
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
        if tick == SETTLE_TICK {
            let position = fragment_position(tick);
            settle_pose = Some(Vec3::from_array(position));
            output.settled.push(SettleEvent {
                structure_id: STRUCTURE,
                island_id: ISLAND,
                position,
                rotation: [0.0, 0.0, 0.0, 1.0],
            });
        }
        let active: Vec<BodySnapshotInput> = if (FRACTURE_TICK..SETTLE_TICK).contains(&tick) {
            vec![BodySnapshotInput {
                body_entity: entity,
                position: fragment_position(tick),
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: fragment_velocity(tick),
                angular_velocity: [0.0; 3],
                contacts: u16::from(tick >= STOP_TICK),
                flags: 0,
            }]
        } else {
            Vec::new()
        };
        encoder.ingest_tick(tick, &active, &output, &output.wakes);
        let mut reliable = encoder.take_topology_messages();
        if let Some(baselines) = encoder.maybe_emit_baseline(tick) {
            reliable.extend(baselines);
        }
        if tick % 120 == 0 {
            reliable.push(encoder.topology_hash_message());
        }
        packets.extend(reliable);
        if tick % config.send_interval_ticks.max(1) == 0 {
            let shared = encoder.encode_send(tick);
            for packet in encoder.client_datagrams(CLIENT, camera(), &shared) {
                if packet.first() == Some(&PKT_CITY_CHUNKS) {
                    let datagram = decode_chunks_datagram(&packet).expect("decodable datagram");
                    for record in datagram.records.iter().filter(|r| r.body_entity == entity) {
                        // A delta record's position is baseline-relative; the
                        // pose it states is the truth at its tick.
                        last_streamed = Some((
                            datagram.sim_tick,
                            Vec3::from_array(fragment_position(datagram.sim_tick)),
                            record.linear_velocity,
                        ));
                    }
                }
                packets.push(packet);
            }
        }
    }
    packets.push(encoder.topology_hash_message());

    let settle_pose = settle_pose.expect("settled");
    let (last_tick, last_position, last_velocity) =
        last_streamed.expect("the fragment was streamed while it was in view");
    // The precondition the client has to handle: streaming stopped while the
    // fragment was still moving, long before it settled, far from where it
    // settled.
    assert!(last_velocity.length() > 1.0, "last record at rest: {last_velocity}");
    assert!(last_tick + 60 < STOP_TICK, "streamed until tick {last_tick}");
    assert!(
        last_position.distance(settle_pose) > 50.0,
        "last streamed {last_position} vs settle {settle_pose}"
    );
    // And the settle is on the reliable stream for this client all the same.
    let settles: usize = packets
        .iter()
        .filter_map(|packet| decode_topology(packet).ok())
        .map(|message| message.settled.len())
        .sum();
    assert_eq!(settles, 1);

    if let Ok(path) = std::env::var("VIBE_SETTLE_SILENCE_CAPTURE") {
        let capture = serde_json::json!({
            "source": "destruction/tests/settle_after_silence_wire.rs",
            "manifest": manifest,
            "packets": packets,
            "body": { "structureId": STRUCTURE, "islandId": ISLAND },
            "settlePosition": settle_pose.to_array(),
            "lastStreamed": { "tick": last_tick, "position": last_position.to_array() },
            "serverHashes": encoder.ledger().structure_hashes().into_iter().map(|(structure, hash)| {
                serde_json::json!({"structureId": structure, "laneA": (hash >> 32) as u32, "laneB": hash as u32})
            }).collect::<Vec<_>>(),
        });
        std::fs::write(path, serde_json::to_vec(&capture).expect("serialize capture"))
            .expect("write capture");
    }
}
