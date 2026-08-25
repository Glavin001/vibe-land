//! A scripted, GPU-less `DestructionBackend` for development and CI.
//!
//! Implements the same contract as the PhysX/Blast runtime with a deliberately
//! simple model: damage impulses break bonds within a blast radius, connected
//! components that lose ground support become rigid island bodies with the
//! manifest rest poses intact, islands integrate ballistically against a
//! ground plane, and the settle policy emits definitive at-rest events.
//!
//! This exercises every downstream layer — ledger, encoder, wire, client —
//! with physically plausible (not physically accurate) motion.

use std::collections::HashMap;

use glam::{Quat, Vec3};

use vibe_netcode::destruction_backend::{
    BondDef, ChunkGeometryDef, ChunkNodeDef, ContactStressInput, DestructionBackend,
    DestructionStats, DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
    StressSolverSettings,
};

use crate::encoder::BodySnapshotInput;
use crate::ids;
use crate::manifest::{ChunkGeometry, DestructionManifest};
use crate::settle::{SettleConfig, SettleSample, SettleTracker};
use crate::topology::ChunkComponents;
use crate::types::{FLAG_CONTACT_BEGIN, FLAG_WAKE_EVENT};

/// Impulse magnitude below which a contact does not fracture anything.
const FRACTURE_IMPULSE_THRESHOLD: f32 = 50.0;
/// Structure-local blast radius within which bonds break.
const BLAST_RADIUS_M: f32 = 2.5;

#[derive(Debug)]
pub enum SyntheticError {
    UnknownStructure(u32),
    TooManyIslands(u32),
}

impl std::fmt::Display for SyntheticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownStructure(id) => write!(f, "unknown structure {id}"),
            Self::TooManyIslands(id) => write!(f, "island serial overflow in structure {id}"),
        }
    }
}

impl std::error::Error for SyntheticError {}

struct SynthNode {
    centroid: Vec3,
    mass: f32,
    support: bool,
}

struct SynthIsland {
    nodes: Vec<u32>,
    /// Body pose: island rest frame (structure frame at promotion) -> world.
    position: Vec3,
    rotation: Quat,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    /// Lowest rest-frame point of any member chunk (for ground contact).
    bottom_y: f32,
    on_ground: bool,
    just_promoted: bool,
    just_touched: bool,
    settled: bool,
    total_mass: f32,
}

struct SynthStructure {
    structure_id: u32,
    world_offset: Vec3,
    nodes: Vec<SynthNode>,
    bonds: Vec<(u32, u32, Vec3)>,
    alive: Vec<bool>,
    /// 0 = still part of the supported static structure.
    node_island: Vec<u32>,
    islands: HashMap<u32, SynthIsland>,
    next_serial: u32,
}

pub struct SyntheticDestruction {
    structures: HashMap<u32, SynthStructure>,
    pending: Vec<ContactStressInput>,
    settle: SettleTracker,
    settle_config: SettleConfig,
    tick: u64,
    stats: DestructionStats,
}

impl SyntheticDestruction {
    pub fn new(sim_hz: u32) -> Self {
        Self {
            structures: HashMap::new(),
            pending: Vec::new(),
            settle: SettleTracker::default(),
            settle_config: SettleConfig::validated(sim_hz),
            tick: 0,
            stats: DestructionStats::default(),
        }
    }

    /// Convenience: register every structure in a manifest.
    pub fn from_manifest(manifest: &DestructionManifest, sim_hz: u32) -> Self {
        let mut backend = Self::new(sim_hz);
        for structure in &manifest.structures {
            let nodes: Vec<ChunkNodeDef> = structure
                .chunks
                .iter()
                .map(|chunk| ChunkNodeDef {
                    node_index: chunk.node_index,
                    centroid: chunk.centroid,
                    mass: chunk.mass,
                    volume: chunk.volume,
                    geometry: match &chunk.geometry {
                        ChunkGeometry::Cuboid { half_extents } => ChunkGeometryDef::Cuboid {
                            half_extents: *half_extents,
                        },
                        ChunkGeometry::ConvexHull { points, .. } => ChunkGeometryDef::ConvexHull {
                            points: points
                                .chunks_exact(3)
                                .map(|p| [p[0], p[1], p[2]])
                                .collect(),
                        },
                    },
                })
                .collect();
            let bonds: Vec<BondDef> = structure
                .bonds
                .iter()
                .map(|bond| BondDef {
                    bond_index: bond.bond_index,
                    node0: bond.node0,
                    node1: bond.node1,
                    centroid: bond.centroid,
                    normal: bond.normal,
                    area: bond.area,
                })
                .collect();
            backend
                .register_structure(
                    structure.structure_id,
                    structure.world_position,
                    structure.world_rotation,
                    &nodes,
                    &bonds,
                    StressSolverSettings::default(),
                )
                .expect("manifest registration cannot fail");
        }
        backend
    }

    /// Queue damage to every chunk within `radius` of a world-space point.
    pub fn apply_explosion(&mut self, center: [f32; 3], radius: f32, impulse: f32) -> u32 {
        let center = Vec3::from_array(center);
        let mut affected = 0;
        let mut contacts = Vec::new();
        for structure in self.structures.values() {
            for (node_index, node) in structure.nodes.iter().enumerate() {
                if node.support || structure.node_island[node_index] != 0 {
                    continue;
                }
                let world = structure.world_offset + node.centroid;
                let offset = world - center;
                let distance = offset.length();
                if distance <= radius {
                    let direction = if distance > 1e-3 {
                        offset / distance
                    } else {
                        Vec3::Y
                    };
                    let falloff = 1.0 - (distance / radius).min(1.0) * 0.5;
                    contacts.push(ContactStressInput {
                        structure_id: structure.structure_id,
                        chunk_id: ids::chunk_id(structure.structure_id, node_index as u32),
                        impulse: (direction * impulse * falloff).to_array(),
                        point: world.to_array(),
                    });
                    affected += 1;
                }
            }
        }
        for contact in contacts {
            self.queue_contact(contact);
        }
        affected
    }

    /// Active-body snapshots for the encoder (awake islands only).
    pub fn body_snapshots(&self) -> Vec<BodySnapshotInput> {
        let mut snapshots = Vec::new();
        let mut structure_ids: Vec<u32> = self.structures.keys().copied().collect();
        structure_ids.sort_unstable();
        for structure_id in structure_ids {
            let structure = &self.structures[&structure_id];
            let mut serials: Vec<u32> = structure.islands.keys().copied().collect();
            serials.sort_unstable();
            for serial in serials {
                let island = &structure.islands[&serial];
                if island.settled {
                    continue;
                }
                let mut flags = 0_u8;
                if island.just_promoted {
                    flags |= FLAG_WAKE_EVENT;
                }
                if island.just_touched {
                    flags |= FLAG_CONTACT_BEGIN;
                }
                snapshots.push(BodySnapshotInput {
                    body_entity: ids::body_entity(structure_id, serial),
                    position: island.position.to_array(),
                    rotation: island.rotation.to_array(),
                    linear_velocity: island.linear_velocity.to_array(),
                    angular_velocity: island.angular_velocity.to_array(),
                    contacts: island.on_ground as u16,
                    flags,
                });
            }
        }
        snapshots
    }
}

impl DestructionBackend for SyntheticDestruction {
    type Error = SyntheticError;

    fn register_structure(
        &mut self,
        structure_id: u32,
        world_position: [f32; 3],
        _world_rotation: [f32; 4],
        nodes: &[ChunkNodeDef],
        bonds: &[BondDef],
        _settings: StressSolverSettings,
    ) -> Result<(), Self::Error> {
        let structure = SynthStructure {
            structure_id,
            world_offset: Vec3::from_array(world_position),
            nodes: nodes
                .iter()
                .map(|node| SynthNode {
                    centroid: Vec3::from_array(node.centroid),
                    mass: node.mass,
                    support: node.mass == 0.0,
                })
                .collect(),
            bonds: bonds
                .iter()
                .map(|bond| (bond.node0, bond.node1, Vec3::from_array(bond.centroid)))
                .collect(),
            alive: vec![true; bonds.len()],
            node_island: vec![0; nodes.len()],
            islands: HashMap::new(),
            next_serial: 1,
        };
        self.structures.insert(structure_id, structure);
        self.stats.structures += 1;
        Ok(())
    }

    fn queue_contact(&mut self, contact: ContactStressInput) {
        self.pending.push(contact);
    }

    fn tick_after_fetch(
        &mut self,
        dt: f32,
        gravity: [f32; 3],
    ) -> Result<DestructionTickOutput, Self::Error> {
        self.tick += 1;
        let tick = self.tick;
        let gravity = Vec3::from_array(gravity);
        let mut output = DestructionTickOutput::default();

        // 1. Apply queued damage: break bonds in the blast radius; kick
        //    already-flying islands directly.
        let pending = std::mem::take(&mut self.pending);
        let mut damaged_structures: Vec<u32> = Vec::new();
        let mut broken_by_structure: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut kick_by_structure: HashMap<u32, Vec3> = HashMap::new();
        for contact in pending {
            let Some(structure) = self.structures.get_mut(&contact.structure_id) else {
                continue;
            };
            let impulse = Vec3::from_array(contact.impulse);
            if impulse.length() < FRACTURE_IMPULSE_THRESHOLD {
                continue;
            }
            let (_, node_index) = ids::chunk_id_parts(contact.chunk_id);
            if let Some(&serial) = structure.node_island.get(node_index as usize) {
                if serial != 0 {
                    // Chunk already flying: impulse just perturbs its island.
                    if let Some(island) = structure.islands.get_mut(&serial) {
                        island.linear_velocity += impulse / island.total_mass.max(1.0);
                        island.settled = false;
                        self.settle
                            .wake(ids::body_entity(contact.structure_id, u32::from(serial)), tick);
                    }
                    continue;
                }
            }
            let Some(node) = structure.nodes.get(node_index as usize) else {
                continue;
            };
            let blast_center = node.centroid;
            let broken = broken_by_structure
                .entry(contact.structure_id)
                .or_default();
            for (bond_index, &(_, _, centroid)) in structure.bonds.iter().enumerate() {
                if structure.alive[bond_index]
                    && centroid.distance(blast_center) <= BLAST_RADIUS_M
                {
                    structure.alive[bond_index] = false;
                    broken.push(bond_index as u32);
                }
            }
            *kick_by_structure
                .entry(contact.structure_id)
                .or_insert(Vec3::ZERO) += impulse;
            if !damaged_structures.contains(&contact.structure_id) {
                damaged_structures.push(contact.structure_id);
            }
        }

        // 2. Recompute support components for damaged structures; promote
        //    unsupported components to island bodies.
        for structure_id in damaged_structures {
            let structure = self.structures.get_mut(&structure_id).unwrap();
            let broken = broken_by_structure.remove(&structure_id).unwrap_or_default();
            if broken.is_empty() {
                continue;
            }
            let mut components = ChunkComponents::new(structure.nodes.len() as u32);
            for (bond_index, &(node0, node1, _)) in structure.bonds.iter().enumerate() {
                if structure.alive[bond_index]
                    && structure.node_island[node0 as usize] == 0
                    && structure.node_island[node1 as usize] == 0
                {
                    components.union(node0, node1);
                }
            }
            let mut promotions = Vec::new();
            for (_, nodes) in components.components() {
                // Only components made of still-static nodes are considered.
                if nodes
                    .iter()
                    .any(|&node| structure.node_island[node as usize] != 0)
                {
                    continue;
                }
                let supported = nodes
                    .iter()
                    .any(|&node| structure.nodes[node as usize].support);
                if supported {
                    continue;
                }
                let serial = structure.next_serial;
                structure.next_serial = structure
                    .next_serial
                    .checked_add(1)
                    .ok_or(SyntheticError::TooManyIslands(structure_id))?;
                let mut total_mass = 0.0;
                let mut bottom_y = f32::MAX;
                for &node in &nodes {
                    structure.node_island[node as usize] = serial;
                    total_mass += structure.nodes[node as usize].mass;
                    bottom_y = bottom_y.min(structure.nodes[node as usize].centroid.y - 0.5);
                }
                let kick = kick_by_structure
                    .get(&structure_id)
                    .copied()
                    .unwrap_or(Vec3::ZERO);
                let linear_velocity = kick / total_mass.max(1.0);
                structure.islands.insert(
                    serial,
                    SynthIsland {
                        nodes: nodes.clone(),
                        position: structure.world_offset,
                        rotation: Quat::IDENTITY,
                        linear_velocity,
                        angular_velocity: Vec3::ZERO,
                        bottom_y,
                        on_ground: false,
                        just_promoted: true,
                        just_touched: false,
                        settled: false,
                        total_mass,
                    },
                );
                self.settle
                    .promote(ids::body_entity(structure_id, u32::from(serial)), tick);
                promotions.push(IslandPromotion {
                    structure_id,
                    island_id: serial as u32,
                    chunks: nodes
                        .iter()
                        .map(|&node| ids::chunk_id(structure_id, node))
                        .collect(),
                    mass: total_mass,
                    position: structure.world_offset.to_array(),
                    rotation: Quat::IDENTITY.to_array(),
                    linear_velocity: linear_velocity.to_array(),
                    ..Default::default()
                });
            }
            self.stats.broken_bonds += broken.len() as u32;
            output.batches.push(FractureBatch {
                structure_id,
                broken_bond_ids: broken
                    .iter()
                    .map(|&bond| ids::bond_id(structure_id, bond))
                    .collect(),
                migrations: Vec::new(),
                promoted_islands: promotions,
                retired_island_ids: Vec::new(),
            });
        }

        // 3. Integrate flying islands against the ground plane.
        let mut settle_samples = Vec::new();
        for structure in self.structures.values_mut() {
            for (&serial, island) in structure.islands.iter_mut() {
                island.just_promoted = false;
                island.just_touched = false;
                if island.settled {
                    continue;
                }
                island.linear_velocity += gravity * dt;
                island.position += island.linear_velocity * dt;
                let ground_penetration = -(island.position.y + island.bottom_y);
                if ground_penetration > 0.0 {
                    island.position.y += ground_penetration;
                    if island.linear_velocity.y < 0.0 {
                        island.linear_velocity.y = 0.0;
                    }
                    // Ground friction bleeds horizontal motion.
                    island.linear_velocity.x *= 0.7;
                    island.linear_velocity.z *= 0.7;
                    if !island.on_ground {
                        island.just_touched = true;
                    }
                    island.on_ground = true;
                }
                settle_samples.push(SettleSample {
                    body_entity: ids::body_entity(structure.structure_id, u32::from(serial)),
                    linear_speed: island.linear_velocity.length(),
                    angular_speed: island.angular_velocity.length(),
                });
            }
        }

        // 4. Settle policy → definitive at-rest events.
        for body in self.settle.update(tick, settle_samples, self.settle_config) {
            let (structure_id, serial) = ids::body_entity_parts(body);
            if let Some(island) = self
                .structures
                .get_mut(&structure_id)
                .and_then(|s| s.islands.get_mut(&serial))
            {
                island.settled = true;
                island.linear_velocity = Vec3::ZERO;
                island.angular_velocity = Vec3::ZERO;
                output.settled.push(SettleEvent {
                    structure_id,
                    island_id: serial as u32,
                    position: island.position.to_array(),
                    rotation: island.rotation.to_array(),
                });
            }
        }

        self.stats.awake_chunk_bodies = self
            .structures
            .values()
            .map(|s| s.islands.values().filter(|i| !i.settled).count() as u32)
            .sum();
        self.stats.chunk_bodies = self
            .structures
            .values()
            .map(|s| s.islands.len() as u32)
            .sum();
        Ok(output)
    }

    fn stats(&self) -> DestructionStats {
        self.stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::{build_city_scene, CitySceneDesc};
    use crate::encoder::{ChunkStreamEncoder, EncoderConfig};
    use crate::scene_pack::parse_scene_pack;
    use crate::types::Camera;

    fn tower_manifest() -> DestructionManifest {
        // A 1x1 "city" of one 4-chunk tower anchored by a support node.
        let pack = parse_scene_pack(
            r#"{
            "version": 1, "title": "tower",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0.5, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1.5, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2.5, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 3.5, "z": 0}, "mass": 10, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 1.0, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 2.0, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 2, "node1": 3, "centroid": {"x": 0, "y": 3.0, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1},
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}
                ],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("pack");
        DestructionManifest::from_city(
            &build_city_scene(
                &pack,
                CitySceneDesc {
                    grid: 1,
                    pitch_m: 10.0,
                    varied_heights: false,
                },
            )
            .expect("city"),
        )
    }

    #[test]
    fn explosion_breaks_bonds_promotes_flies_and_settles() {
        let manifest = tower_manifest();
        let mut backend = SyntheticDestruction::from_manifest(&manifest, 60);
        let dt = 1.0 / 60.0;
        let gravity = [0.0, -9.81, 0.0];

        // No damage -> no events.
        let quiet = backend.tick_after_fetch(dt, gravity).expect("tick");
        assert!(quiet.batches.is_empty());
        assert!(backend.body_snapshots().is_empty());

        // Blast near the top chunk breaks the upper bonds.
        let affected = backend.apply_explosion([0.0, 3.5, 0.0], 3.0, 400.0);
        assert!(affected > 0);
        let output = backend.tick_after_fetch(dt, gravity).expect("tick");
        assert_eq!(output.batches.len(), 1);
        assert!(!output.batches[0].broken_bond_ids.is_empty());
        assert!(!output.batches[0].promoted_islands.is_empty());
        let promoted: usize = output.batches[0]
            .promoted_islands
            .iter()
            .map(|p| p.chunks.len())
            .sum();
        assert!(promoted >= 1);

        // Islands fly, then all settle within the force-sleep deadline.
        let mut settled = Vec::new();
        for _ in 0..(60 * 8) {
            let output = backend.tick_after_fetch(dt, gravity).expect("tick");
            settled.extend(output.settled);
            if backend.body_snapshots().is_empty() {
                break;
            }
        }
        assert!(!settled.is_empty(), "islands must settle");
        assert!(backend.body_snapshots().is_empty(), "settled islands leave the active set");
        // Body poses are offsets from the structure rest frame: an island that
        // fell h meters settles at pose y = -h, bounded by the tallest chunk
        // centroid (3.5 m) and never below the ground clamp.
        for event in &settled {
            assert!(event.position[1] <= 0.01, "island rose: {:?}", event.position);
            assert!(event.position[1] >= -3.51, "island sank: {:?}", event.position);
        }
    }

    #[test]
    fn synthetic_end_to_end_through_the_encoder() {
        let manifest = tower_manifest();
        let mut backend = SyntheticDestruction::from_manifest(&manifest, 60);
        let mut encoder = ChunkStreamEncoder::new(&manifest, EncoderConfig::validated(60));
        encoder.add_client(1);
        let camera = Camera {
            eye: Vec3::new(0.0, 3.0, -15.0),
            direction: Vec3::Z,
            fov_degrees: 70.0,
        };
        let dt = 1.0 / 60.0;
        let gravity = [0.0, -9.81, 0.0];

        backend.apply_explosion([0.0, 3.5, 0.0], 3.0, 400.0);
        let mut datagram_packets = 0;
        let mut topology_messages = 0;
        let mut saw_settle = false;
        for tick in 0..(60 * 6) {
            let output = backend.tick_after_fetch(dt, gravity).expect("tick");
            saw_settle |= !output.settled.is_empty();
            let snapshots = backend.body_snapshots();
            encoder.ingest_tick(tick, &snapshots, &output, &[]);
            topology_messages += encoder.take_topology_messages().len();
            if tick % 2 == 0 {
                encoder.maybe_emit_baseline(tick);
                let shared = encoder.encode_send(tick);
                datagram_packets += encoder.client_datagrams(1, camera, &shared).len();
            }
            if saw_settle {
                break;
            }
        }
        assert!(topology_messages >= 2, "fracture + settle topology expected");
        assert!(datagram_packets > 0, "kinematic stream must flow");
        assert!(saw_settle);

        // A late joiner's bootstrap reflects the final state.
        let bootstrap =
            crate::wire::decode_bootstrap(&encoder.bootstrap_message(999)).expect("bootstrap");
        assert_eq!(bootstrap.manifest_hash, manifest.hash());
        assert!(!bootstrap.islands.is_empty());
        assert!(bootstrap.islands.iter().any(|island| island.settled));
    }
}
