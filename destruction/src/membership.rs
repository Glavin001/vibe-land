//! Where every chunk is, right now.
//!
//! A destructible structure is one kinematic body until something breaks it;
//! after that its chunks live on island bodies that come and go. Nothing in the
//! runtime keeps a chunk-to-body map, because nothing in the *server* needs
//! one: the wire carries topology deltas and each client rebuilds the map
//! itself. Anything that wants chunk world positions — a trace recorder, a
//! scenario test asking "did the roof drop" — has to rebuild it the same way.
//!
//! This is that rebuild, factored out of `record_city_trace` so the recorder
//! and the structural rig share one ledger instead of two that can drift. It
//! mirrors the client (`client/src/city/topology.ts`) deliberately: a pose this
//! produces is a pose a client can reproduce.
//!
//! The composition rule, which is the whole reason this is subtle:
//!
//! ```text
//! chunk_world = body_pose ∘ (rest_local − island_com)
//! ```
//!
//! with the intact support body as the one exception — it is created at the
//! structure transform with every shape at its authored local pose, so its
//! offsets are the rest centroids themselves.

use std::collections::{BTreeSet, HashMap};

use glam::{Quat, Vec3};
use vibe_netcode::destruction_backend::DestructionTickOutput;

use crate::ids;
use crate::manifest::DestructionManifest;

/// Manifest chunks flattened into dense indices, with everything the ledger
/// needs to place one: where it rests, what it weighs, and which structure
/// frame it rests in.
pub struct ChunkIndex {
    /// Dense index -> packed chunk id (`ids::chunk_id`).
    global_ids: Vec<u32>,
    /// Dense index -> rest centroid in its structure's frame.
    rest: Vec<Vec3>,
    /// Dense index -> mass. Zero marks a world-support anchor.
    mass: Vec<f32>,
    /// Dense index -> owning structure id.
    structure: Vec<u32>,
    /// Dense index -> its structure's world transform. Needed because the
    /// adapter excludes kinematic bodies from the snapshot stream — an intact
    /// structure never moves, so nothing reports its pose — yet its chunks
    /// still have world positions, and they are exactly this applied to rest.
    structure_pose: Vec<(Vec3, Quat)>,
    by_global: HashMap<u32, u32>,
}

impl ChunkIndex {
    pub fn from_manifest(manifest: &DestructionManifest) -> Self {
        let total: usize = manifest.structures.iter().map(|s| s.chunks.len()).sum();
        let mut index = Self {
            global_ids: Vec::with_capacity(total),
            rest: Vec::with_capacity(total),
            mass: Vec::with_capacity(total),
            structure: Vec::with_capacity(total),
            structure_pose: Vec::with_capacity(total),
            by_global: HashMap::with_capacity(total),
        };
        for structure in &manifest.structures {
            let pose = (
                Vec3::from_array(structure.world_position),
                Quat::from_xyzw(
                    structure.world_rotation[0],
                    structure.world_rotation[1],
                    structure.world_rotation[2],
                    structure.world_rotation[3],
                )
                .normalize(),
            );
            for chunk in &structure.chunks {
                let dense = index.global_ids.len() as u32;
                let global = ids::chunk_id(structure.structure_id, chunk.node_index);
                index.by_global.insert(global, dense);
                index.global_ids.push(global);
                index.rest.push(Vec3::from_array(chunk.centroid));
                index.mass.push(chunk.mass);
                index.structure.push(structure.structure_id);
                index.structure_pose.push(pose);
            }
        }
        index
    }

    pub fn len(&self) -> usize {
        self.global_ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.global_ids.is_empty()
    }

    pub fn dense_of(&self, global_chunk_id: u32) -> Option<u32> {
        self.by_global.get(&global_chunk_id).copied()
    }

    pub fn global_id(&self, dense: u32) -> u32 {
        self.global_ids[dense as usize]
    }

    pub fn rest(&self, dense: u32) -> Vec3 {
        self.rest[dense as usize]
    }

    pub fn mass(&self, dense: u32) -> f32 {
        self.mass[dense as usize]
    }

    pub fn structure(&self, dense: u32) -> u32 {
        self.structure[dense as usize]
    }

    /// World position of a chunk while its structure is still intact.
    pub fn rest_world(&self, dense: u32) -> Vec3 {
        let (position, rotation) = self.structure_pose[dense as usize];
        position + rotation * self.rest[dense as usize]
    }
}

/// Chunk-to-body membership, and each body's centre of mass in structure-rest
/// coordinates.
pub struct Membership {
    body_of: Vec<u32>,
    members: HashMap<u32, BTreeSet<u32>>,
    com: HashMap<u32, Vec3>,
}

impl Membership {
    /// Everything starts on its structure's intact support body, which is
    /// serial 0 by convention and the only body that exists before the first
    /// fracture.
    pub fn new(index: &ChunkIndex) -> Self {
        let mut body_of = vec![0u32; index.len()];
        let mut members: HashMap<u32, BTreeSet<u32>> = HashMap::new();
        for dense in 0..index.len() as u32 {
            let body = ids::body_entity(index.structure(dense), ids::SUPPORT_ISLAND_SERIAL);
            body_of[dense as usize] = body;
            members.entry(body).or_default().insert(dense);
        }
        let mut this = Self {
            body_of,
            members,
            com: HashMap::new(),
        };
        let bodies: Vec<u32> = this.members.keys().copied().collect();
        for body in bodies {
            this.recompute_com(body, index);
        }
        this
    }

    pub fn body_of(&self, dense: u32) -> u32 {
        self.body_of[dense as usize]
    }

    pub fn members_of(&self, body: u32) -> Option<&BTreeSet<u32>> {
        self.members.get(&body)
    }

    /// Every body and its members. Bodies emptied by promotions are retained
    /// with empty sets rather than pruned, so callers filter.
    pub fn iter_bodies(&self) -> impl Iterator<Item = (u32, &BTreeSet<u32>)> {
        self.members.iter().map(|(body, set)| (*body, set))
    }

    pub fn recompute_com(&mut self, body: u32, index: &ChunkIndex) {
        let Some(set) = self.members.get(&body) else {
            self.com.remove(&body);
            return;
        };
        if set.is_empty() {
            self.com.remove(&body);
            return;
        }
        let mut sum = Vec3::ZERO;
        let mut weight_total = 0.0f32;
        for &dense in set {
            // Support anchors carry zero mass; the client weights them 1 so a
            // body made only of anchors still has a defined frame.
            let mass = index.mass(dense);
            let weight = if mass > 0.0 { mass } else { 1.0 };
            sum += index.rest(dense) * weight;
            weight_total += weight;
        }
        if weight_total > 0.0 {
            self.com.insert(body, sum / weight_total);
        } else {
            self.com.remove(&body);
        }
    }

    pub fn move_chunk(&mut self, dense: u32, to: u32) -> Option<u32> {
        let from = self.body_of[dense as usize];
        if from == to {
            return None;
        }
        if let Some(set) = self.members.get_mut(&from) {
            set.remove(&dense);
        }
        self.members.entry(to).or_default().insert(dense);
        self.body_of[dense as usize] = to;
        Some(from)
    }

    /// Apply one tick's topology deltas, recomputing the centre of mass of
    /// every body whose membership actually changed.
    ///
    /// Call this BEFORE reading poses for the tick: a chunk promoted this tick
    /// must be composed against its NEW body's frame, or it draws one
    /// centre-of-mass height off for exactly one frame.
    pub fn apply_tick(&mut self, output: &DestructionTickOutput, index: &ChunkIndex) {
        let mut touched: BTreeSet<u32> = BTreeSet::new();
        for batch in &output.batches {
            for promotion in &batch.promoted_islands {
                let body = ids::body_entity(promotion.structure_id, promotion.island_id);
                for &chunk in &promotion.chunks {
                    let Some(dense) = index.dense_of(chunk) else {
                        continue;
                    };
                    if let Some(from) = self.move_chunk(dense, body) {
                        touched.insert(from);
                    }
                    touched.insert(body);
                }
            }
            for migration in &batch.migrations {
                let Some(dense) = index.dense_of(migration.chunk_id) else {
                    continue;
                };
                let to = ids::body_entity(batch.structure_id, migration.to_island_id);
                if let Some(from) = self.move_chunk(dense, to) {
                    touched.insert(from);
                }
                touched.insert(to);
            }
        }
        for body in touched {
            self.recompute_com(body, index);
        }
    }

    /// Body-local offset for a chunk, in its body's canonical frame.
    pub fn local_offset(&self, dense: u32, index: &ChunkIndex) -> Vec3 {
        let body = self.body_of[dense as usize];
        let rest = index.rest(dense);
        if ids::body_entity_parts(body).1 == ids::SUPPORT_ISLAND_SERIAL {
            return rest;
        }
        match self.com.get(&body) {
            Some(com) => rest - *com,
            None => rest,
        }
    }

    /// World position of a chunk, given this tick's body poses keyed by entity.
    ///
    /// Falls back to the structure's rest transform when the chunk's body
    /// reported no pose, which is the normal case for an intact structure: its
    /// body is kinematic and the snapshot stream deliberately omits it.
    pub fn chunk_world(
        &self,
        dense: u32,
        index: &ChunkIndex,
        pose_of: &impl Fn(u32) -> Option<(Vec3, Quat)>,
    ) -> Vec3 {
        let body = self.body_of[dense as usize];
        match pose_of(body) {
            Some((position, rotation)) => position + rotation * self.local_offset(dense, index),
            None => index.rest_world(dense),
        }
    }
}
