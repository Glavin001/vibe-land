//! The server-side topology ledger: authoritative alive-bond bitsets, live
//! island membership, and settled poses.
//!
//! Fed by `FractureBatch`/`SettleEvent` streams each tick; produces the
//! late-join/resync `BootstrapMessage`. The client keeps an equivalent ledger
//! (client/src/city/topology.ts) reconstructed purely from the same events —
//! this is the "ledger of globally unique objects" both sides agree on.

use std::collections::HashMap;

use glam::Vec3;

use vibe_netcode::destruction_backend::{FractureBatch, SettleEvent};

use crate::ids;
use crate::manifest::DestructionManifest;
use crate::types::Pose;
use crate::wire::{BootstrapIsland, BootstrapMessage, BootstrapStructure};

/// FNV-1a 32-bit, run as two independently-seeded lanes to make a 64-bit
/// structure hash. Lane A is the standard FNV offset basis; lane B is an
/// arbitrary distinct seed. Chosen over one 64-bit hash because the client
/// computes the same function in JS, where u64 means BigInt and BigInt means
/// paying for it every comparison.
const FNV_PRIME: u32 = 16_777_619;
const FNV_SEED_A: u32 = 0x811c_9dc5;
const FNV_SEED_B: u32 = 0xdead_beef;

#[derive(Clone, Debug)]
pub struct LedgerIsland {
    /// Node indices within the structure, ascending.
    pub nodes: Vec<u32>,
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub settled: bool,
}

#[derive(Clone, Debug)]
struct LedgerStructure {
    bond_count: u32,
    /// Bit `i` set = bond index `i` alive.
    alive_bonds: Vec<u8>,
    islands: HashMap<u32, LedgerIsland>,
}

#[derive(Clone, Debug, Default)]
pub struct CityLedger {
    structures: HashMap<u32, LedgerStructure>,
    broken_bonds_total: u64,
}

impl CityLedger {
    pub fn from_manifest(manifest: &DestructionManifest) -> Self {
        let structures = manifest
            .structures
            .iter()
            .map(|structure| {
                let bond_count = structure.bonds.len() as u32;
                let mut alive_bonds = vec![0_u8; bond_count.div_ceil(8) as usize];
                for bond in &structure.bonds {
                    alive_bonds[(bond.bond_index / 8) as usize] |= 1 << (bond.bond_index % 8);
                }
                (
                    structure.structure_id,
                    LedgerStructure {
                        bond_count,
                        alive_bonds,
                        islands: HashMap::new(),
                    },
                )
            })
            .collect();
        Self {
            structures,
            broken_bonds_total: 0,
        }
    }

    pub fn broken_bonds_total(&self) -> u64 {
        self.broken_bonds_total
    }

    pub fn live_island_count(&self) -> usize {
        self.structures.values().map(|s| s.islands.len()).sum()
    }

    pub fn island(&self, structure_id: u32, serial: u32) -> Option<&LedgerIsland> {
        self.structures.get(&structure_id)?.islands.get(&serial)
    }

    /// One hash per structure over what the reliable stream is supposed to
    /// have replicated: the alive-bond bitmap and every dynamic island's
    /// membership (serial + ascending node list). Poses and velocities are
    /// deliberately absent -- they ride the datagram stream and heal on their
    /// own; membership and bonds only heal through a bootstrap.
    ///
    /// This exists because `city_desync_repairs` sat at zero while a client
    /// was visibly desynced: the server can only see the drops it makes
    /// itself, so silent client-side divergence needs the server to publish
    /// what the ledger SHOULD hash to. The client computes the same function
    /// over its own ledger (`structureHashes` in `client/src/city/topology.ts`
    /// -- the two must change together; `hash_vector_is_pinned` pins the
    /// shared test vector).
    ///
    /// Two independent 32-bit FNV-1a lanes packed as (laneA << 32) | laneB.
    /// JS has no cheap u64, so the client compares two u32 reads instead of
    /// paying BigInt on a 2 Hz path.
    pub fn structure_hashes(&self) -> Vec<(u32, u64)> {
        let mut ids: Vec<u32> = self.structures.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter()
            .map(|structure_id| {
                let structure = &self.structures[&structure_id];
                let mut lane_a = FNV_SEED_A;
                let mut lane_b = FNV_SEED_B;
                let mut feed = |byte: u8| {
                    lane_a = (lane_a ^ u32::from(byte)).wrapping_mul(FNV_PRIME);
                    lane_b = (lane_b ^ u32::from(byte)).wrapping_mul(FNV_PRIME);
                };
                for &byte in &structure.alive_bonds {
                    feed(byte);
                }
                let mut serials: Vec<u32> = structure.islands.keys().copied().collect();
                serials.sort_unstable();
                for serial in serials {
                    let island = &structure.islands[&serial];
                    for byte in serial.to_le_bytes() {
                        feed(byte);
                    }
                    for byte in (island.nodes.len() as u32).to_le_bytes() {
                        feed(byte);
                    }
                    // `nodes` is kept ascending by every mutation path; hash
                    // order must not depend on mutation history.
                    debug_assert!(island.nodes.windows(2).all(|w| w[0] < w[1]));
                    for &node in &island.nodes {
                        for byte in node.to_le_bytes() {
                            feed(byte);
                        }
                    }
                }
                (structure_id, (u64::from(lane_a) << 32) | u64::from(lane_b))
            })
            .collect()
    }

    pub fn apply_batch(&mut self, batch: &FractureBatch) {
        let Some(structure) = self.structures.get_mut(&batch.structure_id) else {
            return;
        };
        for &bond_id in &batch.broken_bond_ids {
            let (_, bond_index) = ids::bond_id_parts(bond_id);
            if bond_index < structure.bond_count {
                let byte = (bond_index / 8) as usize;
                let bit = 1 << (bond_index % 8);
                if structure.alive_bonds[byte] & bit != 0 {
                    structure.alive_bonds[byte] &= !bit;
                    self.broken_bonds_total += 1;
                }
            }
        }
        for promotion in &batch.promoted_islands {
            let mut nodes: Vec<u32> = promotion
                .chunks
                .iter()
                .map(|&chunk| ids::chunk_id_parts(chunk).1)
                .collect();
            nodes.sort_unstable();
            // A node joining a new island has left its previous one. The
            // clients drain the losing body when they apply this promotion;
            // the ledger must do the same or its node lists go stale -- and
            // the ledger is what bootstraps late joiners and resyncs, so a
            // stale list here becomes corrupt membership (and a corrupt
            // centre of mass) on every client that ever resynchronises.
            for island in structure.islands.values_mut() {
                island.nodes.retain(|node| !nodes.contains(node));
            }
            structure.islands.insert(
                promotion.island_id,
                LedgerIsland {
                    nodes,
                    pose: Pose {
                        position: Vec3::from_array(promotion.position),
                        rotation: glam::Quat::from_array(promotion.rotation),
                    },
                    linear_velocity: Vec3::from_array(promotion.linear_velocity),
                    angular_velocity: Vec3::from_array(promotion.angular_velocity),
                    settled: false,
                },
            );
        }
        // Chunks physics moved between existing islands, with no promotion.
        // Same staleness consequence as above if skipped -- which it was: the
        // wire carried migrations to clients while the ledger ignored them,
        // so every bootstrap after enough migrations described a city whose
        // membership no client could reconcile.
        for migration in &batch.migrations {
            let node = ids::chunk_id_parts(migration.chunk_id).1;
            if let Some(source) = structure.islands.get_mut(&migration.from_island_id) {
                source.nodes.retain(|&existing| existing != node);
            }
            if let Some(destination) = structure.islands.get_mut(&migration.to_island_id) {
                // Keep ascending order: bootstrap gap-encodes node lists, so
                // an out-of-order insert would corrupt the wire encoding.
                if let Err(index) = destination.nodes.binary_search(&node) {
                    destination.nodes.insert(index, node);
                }
            }
        }
        for &retired in &batch.retired_island_ids {
            structure.islands.remove(&retired);
        }
    }

    pub fn apply_settle(&mut self, settle: &SettleEvent) {
        if let Some(island) = self
            .structures
            .get_mut(&settle.structure_id)
            .and_then(|s| s.islands.get_mut(&settle.island_id))
        {
            island.settled = true;
            island.pose = Pose {
                position: Vec3::from_array(settle.position),
                rotation: glam::Quat::from_array(settle.rotation),
            };
            island.linear_velocity = Vec3::ZERO;
            island.angular_velocity = Vec3::ZERO;
        }
    }

    pub fn apply_wake(&mut self, structure_id: u32, serial: u32) {
        if let Some(island) = self
            .structures
            .get_mut(&structure_id)
            .and_then(|s| s.islands.get_mut(&serial))
        {
            island.settled = false;
        }
    }

    /// Refresh a live island's pose from the kinematic stream so bootstraps
    /// hand late joiners current state.
    /// Motion update for a run of bodies that share a structure.
    ///
    /// The per-body entry point does two nested hash lookups (structure, then
    /// island). Bodies arrive grouped by structure, so the outer one is the
    /// same answer for long runs; this resolves it once and lets the caller
    /// update each island directly.
    pub fn structure_islands_mut(
        &mut self,
        structure_id: u32,
    ) -> Option<&mut HashMap<u32, LedgerIsland>> {
        self.structures
            .get_mut(&structure_id)
            .map(|structure| &mut structure.islands)
    }

    pub fn update_island_motion(
        &mut self,
        body_entity: u32,
        pose: Pose,
        linear_velocity: Vec3,
        angular_velocity: Vec3,
    ) {
        let (structure_id, serial) = ids::body_entity_parts(body_entity);
        if let Some(island) = self
            .structures
            .get_mut(&structure_id)
            .and_then(|s| s.islands.get_mut(&serial))
        {
            island.pose = pose;
            island.linear_velocity = linear_velocity;
            island.angular_velocity = angular_velocity;
        }
    }

    /// Full-state resync for a late joiner.
    ///
    /// `live_motion` supplies each body's CURRENT pose and velocity. The
    /// ledger used to carry its own copy, refreshed for every body on every
    /// tick, and read only here -- a per-tick cost across thousands of bodies
    /// to serve a message sent when someone joins. The caller already tracks
    /// this state, so it is passed in instead.
    /// TEMP DIAGNOSTIC: ledger islands with no live physics body.
    ///
    /// The client renders every ledger island; an island whose body no longer
    /// exists is a phantom -- its chunks freeze at the last streamed pose,
    /// which presents as floating shards and below-ground counts while server
    /// physics is clean.
    pub fn phantom_islands(&self, live_entities: &std::collections::HashSet<u32>) -> (usize, Option<(u32, u32)>) {
        let mut count = 0;
        let mut example = None;
        for (&structure_id, structure) in &self.structures {
            for (&serial, _island) in &structure.islands {
                if serial == 0 {
                    continue; // kinematic support is never streamed
                }
                let entity = crate::ids::body_entity(structure_id, serial);
                if !live_entities.contains(&entity) {
                    count += 1;
                    if example.is_none() {
                        example = Some((structure_id, serial));
                    }
                }
            }
        }
        (count, example)
    }

    pub fn bootstrap(
        &self,
        sim_tick: u32,
        manifest_hash: [u8; 32],
        baseline_id: u16,
        topo_seq: u32,
        live_motion: &dyn Fn(u32, u32) -> Option<(Pose, Vec3, Vec3)>,
    ) -> BootstrapMessage {
        self.bootstrap_filtered(sim_tick, manifest_hash, baseline_id, topo_seq, live_motion, None)
    }

    /// A bootstrap covering only the named structures — the targeted repair a
    /// hash mismatch drives. `None` means every structure (the full bootstrap).
    /// The message shape is identical; the wire kind differs so the client
    /// knows to rebuild the named structures instead of resetting the world.
    pub fn bootstrap_filtered(
        &self,
        sim_tick: u32,
        manifest_hash: [u8; 32],
        baseline_id: u16,
        topo_seq: u32,
        live_motion: &dyn Fn(u32, u32) -> Option<(Pose, Vec3, Vec3)>,
        only: Option<&[u32]>,
    ) -> BootstrapMessage {
        let mut structure_ids: Vec<u32> = self.structures.keys().copied().collect();
        structure_ids.sort_unstable();
        if let Some(only) = only {
            structure_ids.retain(|id| only.contains(id));
        }
        let mut structures = Vec::new();
        let mut islands = Vec::new();
        for structure_id in structure_ids {
            let structure = &self.structures[&structure_id];
            structures.push(BootstrapStructure {
                structure_id,
                bond_count: structure.bond_count,
                alive_bonds: structure.alive_bonds.clone(),
            });
            let mut serials: Vec<u32> = structure.islands.keys().copied().collect();
            serials.sort_unstable();
            for serial in serials {
                let island = &structure.islands[&serial];
                let (pose, linear_velocity, angular_velocity) =
                    live_motion(structure_id, serial).unwrap_or((
                        island.pose,
                        island.linear_velocity,
                        island.angular_velocity,
                    ));
                islands.push(BootstrapIsland {
                    structure_id,
                    island_id: serial as u32,
                    nodes: island.nodes.clone(),
                    pose,
                    linear_velocity,
                    angular_velocity,
                    settled: island.settled,
                });
            }
        }
        BootstrapMessage {
            sim_tick,
            manifest_hash,
            baseline_id,
            topo_seq,
            structures,
            islands,
        }
    }
}

/// Union-find over one structure's chunks, used to derive connected components
/// from an alive-bond bitset (tests + the synthetic backend; the C++ adapter
/// does its own island analysis in production).
pub struct ChunkComponents {
    parent: Vec<u32>,
}

impl ChunkComponents {
    pub fn new(node_count: u32) -> Self {
        Self {
            parent: (0..node_count).collect(),
        }
    }

    pub fn find(&mut self, node: u32) -> u32 {
        let mut root = node;
        while self.parent[root as usize] != root {
            root = self.parent[root as usize];
        }
        let mut current = node;
        while self.parent[current as usize] != root {
            let next = self.parent[current as usize];
            self.parent[current as usize] = root;
            current = next;
        }
        root
    }

    pub fn union(&mut self, a: u32, b: u32) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.parent[rb as usize] = ra;
        }
    }

    /// Components as sorted node lists, keyed by their smallest node.
    pub fn components(&mut self) -> HashMap<u32, Vec<u32>> {
        let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
        for node in 0..self.parent.len() as u32 {
            let root = self.find(node);
            map.entry(root).or_default().push(node);
        }
        let mut out = HashMap::new();
        for (_, mut nodes) in map {
            nodes.sort_unstable();
            out.insert(nodes[0], nodes);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_netcode::destruction_backend::IslandPromotion;

    use crate::city::{build_city_scene, CitySceneDesc};
    use crate::scene_pack::parse_scene_pack;

    fn manifest() -> DestructionManifest {
        let pack = parse_scene_pack(
            r#"{
            "version": 1, "title": "tiny",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2, "z": 0}, "mass": 10, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 0.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 1.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}
                ],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("pack");
        let city = build_city_scene(
            &pack,
            CitySceneDesc {
                grid: 1,
                pitch_m: 10.0,
                varied_heights: false,
            },
        )
        .expect("city");
        DestructionManifest::from_city(&city)
    }

    #[test]
    fn batches_update_bitsets_and_islands() {
        let manifest = manifest();
        let mut ledger = CityLedger::from_manifest(&manifest);
        let batch = FractureBatch {
            structure_id: 0,
            broken_bond_ids: vec![ids::bond_id(0, 1)],
            migrations: Vec::new(),
            promoted_islands: vec![IslandPromotion {
                structure_id: 0,
                island_id: 1,
                chunks: vec![ids::chunk_id(0, 2)],
                position: [0.0, 2.0, 0.0],
                rotation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity: [1.0, 0.0, 0.0],
                ..Default::default()
            }],
            retired_island_ids: Vec::new(),
        };
        ledger.apply_batch(&batch);
        assert_eq!(ledger.broken_bonds_total(), 1);
        assert_eq!(ledger.live_island_count(), 1);

        // Breaking the same bond twice does not double count.
        ledger.apply_batch(&batch);
        assert_eq!(ledger.broken_bonds_total(), 1);

        let bootstrap = ledger.bootstrap(10, [1; 32], 0, 5, &|_, _| None);
        assert_eq!(bootstrap.structures.len(), 1);
        // Bond 0 alive, bond 1 broken -> bitset 0b0000_0001.
        assert_eq!(bootstrap.structures[0].alive_bonds, vec![0b0000_0001]);
        assert_eq!(bootstrap.islands.len(), 1);
        assert_eq!(bootstrap.islands[0].nodes, vec![2]);
    }

    #[test]
    fn settle_pins_pose_and_wake_reverses() {
        let manifest = manifest();
        let mut ledger = CityLedger::from_manifest(&manifest);
        ledger.apply_batch(&FractureBatch {
            structure_id: 0,
            broken_bond_ids: vec![ids::bond_id(0, 1)],
            promoted_islands: vec![IslandPromotion {
                structure_id: 0,
                island_id: 1,
                chunks: vec![ids::chunk_id(0, 2)],
                ..Default::default()
            }],
            ..Default::default()
        });
        ledger.apply_settle(&SettleEvent {
            structure_id: 0,
            island_id: 1,
            position: [0.5, 0.5, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
        });
        let island = ledger.island(0, 1).expect("island");
        assert!(island.settled);
        assert_eq!(island.pose.position, Vec3::new(0.5, 0.5, 0.0));

        ledger.apply_wake(0, 1);
        assert!(!ledger.island(0, 1).expect("island").settled);
    }

    /// The cross-language hash vector. The client computes the same function
    /// in `client/src/city/topology.ts` (`structureHashes`), whose test pins
    /// these exact lane values over the same state -- if either side's
    /// hashing changes, both tests fail together and both sides must move.
    #[test]
    fn hash_vector_is_pinned() {
        let manifest = manifest();
        let mut ledger = CityLedger::from_manifest(&manifest);
        // Intact: alive bitmap 0b11, no islands.
        assert_eq!(ledger.structure_hashes(), vec![(0, 0x060c_5eb2_7783_8d84)]);
        ledger.apply_batch(&FractureBatch {
            structure_id: 0,
            broken_bond_ids: vec![ids::bond_id(0, 1)],
            promoted_islands: vec![IslandPromotion {
                structure_id: 0,
                island_id: 1,
                chunks: vec![ids::chunk_id(0, 2)],
                ..Default::default()
            }],
            ..Default::default()
        });
        // Bond 1 broken (bitmap 0b01), island serial 1 holding node 2.
        assert_eq!(ledger.structure_hashes(), vec![(0, 0xb97e_54fe_e243_a378)]);
    }

    #[test]
    fn filtered_bootstrap_scopes_to_named_structures() {
        let manifest = manifest();
        let ledger = CityLedger::from_manifest(&manifest);
        let all = ledger.bootstrap_filtered(10, [1; 32], 0, 5, &|_, _| None, None);
        assert_eq!(all.structures.len(), 1);
        let none = ledger.bootstrap_filtered(10, [1; 32], 0, 5, &|_, _| None, Some(&[7]));
        assert!(none.structures.is_empty(), "unknown id must select nothing");
        let scoped = ledger.bootstrap_filtered(10, [1; 32], 0, 5, &|_, _| None, Some(&[0]));
        assert_eq!(scoped.structures.len(), 1);
        assert_eq!(scoped.topo_seq, 5);
    }

    #[test]
    fn union_find_components_follow_alive_bonds() {
        let mut components = ChunkComponents::new(4);
        components.union(0, 1);
        components.union(2, 3);
        let map = components.components();
        assert_eq!(map.len(), 2);
        assert_eq!(map[&0], vec![0, 1]);
        assert_eq!(map[&2], vec![2, 3]);
    }
}
