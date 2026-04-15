//! Destructible structures driven by NVIDIA Blast's stress solver.
//!
//! Wraps [`blast_stress_solver::rapier::DestructibleSet`] and glues it to
//! vibe-land's existing [`SimWorld`](crate::simulation::SimWorld).  Each
//! destructible instance owns an independent solver + a set of Rapier rigid
//! bodies; the rigid bodies are registered into `SimWorld`'s shared
//! `RigidBodySet`/`ColliderSet` so they interact with vehicles, the player
//! capsule, and the rest of the world automatically.
//!
//! This module is gated on
//! `cfg(all(target_arch = "wasm32", feature = "destructibles"))`.
//! The Blast C++ backend is only built for the wasm target, and only
//! when the `destructibles` feature is enabled (which in turn
//! requires the PhysX clone at `third_party/physx/`).  See
//! `shared/Cargo.toml` and `docs/BLAST_INTEGRATION.md`.

use std::collections::HashMap;

use nalgebra::{Isometry3, Quaternion, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::{ImpulseJointSet, MultibodyJointSet, RigidBodyHandle, RigidBodyType};

use blast_stress_solver::rapier::{DestructibleSet, FracturePolicy};
use blast_stress_solver::scenarios::{
    build_tower_scenario, build_wall_scenario, TowerOptions, WallOptions,
};
use blast_stress_solver::types::{SolverSettings, Vec3 as BlastVec3};

use crate::simulation::SimWorld;

/// Solver material constants, mirroring `scaled_solver_settings` in the
/// upstream `blast-stress-demo-rs/src/main.rs`.  These are tuned to be
/// brittle enough that a vehicle collision can reliably crack a wall and
/// topple a tower without driving the solver into degenerate states.
const BASE_COMPRESSION_ELASTIC: f32 = 0.0009;
const BASE_COMPRESSION_FATAL: f32 = 0.0027;
const BASE_TENSION_ELASTIC: f32 = 0.0009;
const BASE_TENSION_FATAL: f32 = 0.0027;
const BASE_SHEAR_ELASTIC: f32 = 0.0012;
const BASE_SHEAR_FATAL: f32 = 0.0036;

/// Material softness — smaller = more brittle.
const WALL_MATERIAL_SCALE: f32 = 1.0;
const TOWER_MATERIAL_SCALE: f32 = 1.0;

/// Stride of [`DestructibleRegistry::chunk_transforms`] in `f32`s:
/// `[destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, active, _pad]`.
pub const CHUNK_TRANSFORM_STRIDE: usize = 11;

fn scaled_solver_settings(material_scale: f32) -> SolverSettings {
    SolverSettings {
        max_solver_iterations_per_frame: 24,
        graph_reduction_level: 0,
        compression_elastic_limit: BASE_COMPRESSION_ELASTIC * material_scale,
        compression_fatal_limit: BASE_COMPRESSION_FATAL * material_scale,
        tension_elastic_limit: BASE_TENSION_ELASTIC * material_scale,
        tension_fatal_limit: BASE_TENSION_FATAL * material_scale,
        shear_elastic_limit: BASE_SHEAR_ELASTIC * material_scale,
        shear_fatal_limit: BASE_SHEAR_FATAL * material_scale,
    }
}

/// Which Blast scenario to build for an instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestructibleKind {
    Wall,
    Tower,
}

/// A single destructible instance placed in the world.  Owns a
/// `DestructibleSet` and the handles of every chunk body it created inside
/// `SimWorld`.
///
/// # Chunk model
///
/// In Blast, an *actor* is a connected subgraph of nodes — before any
/// fracture, every destructible has exactly one actor holding every
/// node.  `DestructibleSet::initialize` therefore spawns a single
/// Rapier rigid body with one collider per node at init time; the
/// collider centroids are the visible bricks.
///
/// `DestructibleInstance` exposes the *node* granularity (one "chunk"
/// per brick) so the client can render each brick independently.  At
/// every [`DestructibleRegistry::step`] we read each node's owning
/// body + local offset and reconstruct the world-space pose.  After a
/// fracture the solver migrates some nodes to new bodies; the same
/// transform query keeps working without any special casing.
pub struct DestructibleInstance {
    pub id: u32,
    pub kind: DestructibleKind,
    pub pose: Isometry3<f32>,
    set: DestructibleSet,
    /// Stable node count captured at spawn time (nodes never go away,
    /// only their body-affiliation changes).
    node_count: u32,
    /// Cached transforms buffer (stride = [`CHUNK_TRANSFORM_STRIDE`]).
    transforms: Vec<f32>,
}

impl DestructibleInstance {
    pub fn chunk_count(&self) -> usize {
        self.node_count as usize
    }
}

/// Collection of all destructibles currently in the sim.
///
/// Uses a linear `Vec<DestructibleInstance>` keyed by stable `id` → index
/// so that `Vec` iteration stays cache friendly while lookups are O(n) for
/// the tiny populations we expect (<16 instances in practice).
pub struct DestructibleRegistry {
    instances: Vec<DestructibleInstance>,
    id_to_index: HashMap<u32, usize>,
    /// Aggregated chunk transforms across all instances.  Rebuilt every
    /// frame inside [`DestructibleRegistry::step`].
    transforms: Vec<f32>,
    /// Aggregated fracture event queue (destructible id, chunk id pairs).
    /// Drained by the client via `getDestructibleFractureEvents`.
    fracture_events: Vec<u32>,
}

impl DestructibleRegistry {
    pub fn new() -> Self {
        Self {
            instances: Vec::new(),
            id_to_index: HashMap::new(),
            transforms: Vec::new(),
            fracture_events: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.instances.len()
    }

    pub fn is_empty(&self) -> bool {
        self.instances.is_empty()
    }

    pub fn total_chunk_count(&self) -> usize {
        self.instances.iter().map(|i| i.chunk_count()).sum()
    }

    pub fn get(&self, id: u32) -> Option<&DestructibleInstance> {
        self.id_to_index
            .get(&id)
            .and_then(|idx| self.instances.get(*idx))
    }

    /// Spawn a wall at the given pose.  Returns `true` on success.
    pub fn spawn_wall(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = build_wall_scenario(&WallOptions::default());
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Wall,
            pose,
            scenario,
            WALL_MATERIAL_SCALE,
        )
    }

    /// Spawn a tower at the given pose.  Returns `true` on success.
    pub fn spawn_tower(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = build_tower_scenario(&TowerOptions::default());
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Tower,
            pose,
            scenario,
            TOWER_MATERIAL_SCALE,
        )
    }

    fn spawn_scenario(
        &mut self,
        sim: &mut SimWorld,
        id: u32,
        kind: DestructibleKind,
        pose: Isometry3<f32>,
        scenario: blast_stress_solver::types::ScenarioDesc,
        material_scale: f32,
    ) -> bool {
        if self.id_to_index.contains_key(&id) {
            return false;
        }
        let gravity = BlastVec3::new(0.0, -9.81, 0.0);
        let settings = scaled_solver_settings(material_scale);
        let policy = FracturePolicy::default();

        let Some(mut set) = DestructibleSet::from_scenario(&scenario, settings, gravity, policy)
        else {
            return false;
        };
        // Scenarios are built at origin — after creating the bodies we
        // transform each of them by `pose` so the whole structure ends up
        // at the requested world position/rotation.
        let handles = set.initialize(&mut sim.rigid_bodies, &mut sim.colliders);

        for handle in &handles {
            let Some(rb) = sim.rigid_bodies.get_mut(*handle) else {
                continue;
            };
            let local = *rb.position();
            let world = pose * local;
            rb.set_position(world, false);
        }

        // Ensure all dynamic chunk bodies are woken so the solver sees
        // gravity / contact forces immediately after spawning.
        for handle in &handles {
            if let Some(rb) = sim.rigid_bodies.get_mut(*handle) {
                if matches!(rb.body_type(), RigidBodyType::Dynamic) {
                    rb.wake_up(true);
                }
            }
        }

        let node_count = set.solver().node_count();
        let transforms_len = node_count as usize * CHUNK_TRANSFORM_STRIDE;
        let index = self.instances.len();
        self.id_to_index.insert(id, index);
        self.instances.push(DestructibleInstance {
            id,
            kind,
            pose,
            set,
            node_count,
            transforms: vec![0.0; transforms_len],
        });
        true
    }

    /// Remove a destructible and free all of its chunk bodies in `SimWorld`.
    pub fn despawn(
        &mut self,
        sim: &mut SimWorld,
        impulse_joints: &mut ImpulseJointSet,
        multibody_joints: &mut MultibodyJointSet,
        id: u32,
    ) -> bool {
        let Some(index) = self.id_to_index.remove(&id) else {
            return false;
        };
        let instance = self.instances.swap_remove(index);
        // Fix up the id_to_index for the instance that was swapped into
        // this slot.
        if index < self.instances.len() {
            let moved_id = self.instances[index].id;
            self.id_to_index.insert(moved_id, index);
        }
        // Collect every unique body currently owning a node — after
        // fractures the nodes may span more bodies than we initialized
        // with, and the tracker's node→body map is authoritative.
        let mut seen_bodies: std::collections::HashSet<RigidBodyHandle> =
            std::collections::HashSet::new();
        for node_index in 0..instance.node_count {
            if let Some(handle) = instance.set.node_body(node_index) {
                seen_bodies.insert(handle);
            }
        }
        for handle in &seen_bodies {
            sim.rigid_bodies.remove(
                *handle,
                &mut sim.island_manager,
                &mut sim.colliders,
                impulse_joints,
                multibody_joints,
                true,
            );
        }
        true
    }

    /// Advance every destructible one tick, updating chunk transforms and
    /// the fracture event queue.  Must be called after any input-driven
    /// contacts have been applied (i.e. after `step_vehicle_pipeline`).
    pub fn step(
        &mut self,
        sim: &mut SimWorld,
        impulse_joints: &mut ImpulseJointSet,
        multibody_joints: &mut MultibodyJointSet,
    ) {
        self.transforms.clear();

        for instance in &mut self.instances {
            let step_result = instance.set.step(
                &mut sim.rigid_bodies,
                &mut sim.colliders,
                &mut sim.island_manager,
                impulse_joints,
                multibody_joints,
            );

            if step_result.fractures > 0 || step_result.split_events > 0 {
                // Emit a single (destructibleId, fractureCount) event per
                // frame so the client can play feedback without parsing
                // the full split cohort list.
                self.fracture_events.push(instance.id);
                self.fracture_events.push(step_result.fractures as u32);
            }

            // Rebuild the per-instance transforms buffer.  We iterate
            // nodes in stable node-index order so chunk indices stay
            // consistent across frames (chunk_index == node_index).
            // World-space pose = owning_body.pose() * local_offset.
            instance.transforms.clear();
            for node_index in 0..instance.node_count {
                let chunk_index = node_index;
                let Some(handle) = instance.set.node_body(node_index) else {
                    // Node has no owning body (destroyed / debris cleaned up).
                    // Emit a row with active=0 so the client can hide it.
                    instance.transforms.extend_from_slice(&[
                        instance.id as f32,
                        chunk_index as f32,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0, // active
                        0.0, // pad
                    ]);
                    continue;
                };
                let Some(rb) = sim.rigid_bodies.get(handle) else {
                    continue;
                };
                let local_offset = instance
                    .set
                    .node_local_offset(node_index)
                    .unwrap_or(BlastVec3::new(0.0, 0.0, 0.0));
                let body_iso = rb.position();
                let local_point =
                    nalgebra::Point3::new(local_offset.x, local_offset.y, local_offset.z);
                let world_point = body_iso.transform_point(&local_point);
                let rot = body_iso.rotation;
                let active = matches!(rb.body_type(), RigidBodyType::Dynamic) && !rb.is_sleeping();
                instance.transforms.extend_from_slice(&[
                    instance.id as f32,
                    chunk_index as f32,
                    world_point.x,
                    world_point.y,
                    world_point.z,
                    rot.i,
                    rot.j,
                    rot.k,
                    rot.w,
                    if active { 1.0 } else { 0.0 },
                    0.0, // pad
                ]);
            }
            self.transforms.extend_from_slice(&instance.transforms);
        }
    }

    /// Current aggregated chunk transforms (stride =
    /// [`CHUNK_TRANSFORM_STRIDE`]).  Refreshed each [`step`](Self::step).
    pub fn chunk_transforms_slice(&self) -> &[f32] {
        &self.transforms
    }

    /// Drain all pending fracture events as a flat `[id, count, id, count, ...]`
    /// buffer.
    pub fn drain_fracture_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.fracture_events)
    }
}

impl Default for DestructibleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: build an [`Isometry3`] from a `[f32; 3]` position and a
/// `[f32; 4]` quaternion (x, y, z, w) as stored in
/// [`crate::world_document::DestructibleDoc`].
pub fn pose_from_world_doc(position: [f32; 3], rotation: [f32; 4]) -> Isometry3<f32> {
    let translation = Translation3::new(position[0], position[1], position[2]);
    // Renormalize to guard against round-trip drift in the JSON → f32
    // pipeline — Blast's chunks are rigid, any non-unit quaternion here
    // shows up as a progressive scaling artifact.
    let q = Quaternion::new(rotation[3], rotation[0], rotation[1], rotation[2]);
    let unit = UnitQuaternion::from_quaternion(q);
    Isometry3::from_parts(translation, unit)
}

#[allow(dead_code)]
fn _assert_sync() {
    fn is_send<T: Send>() {}
    // DestructibleSet is not Send but that's fine — WasmSimWorld is
    // strictly single-threaded.  This function is just a placeholder to
    // document the constraint.
    is_send::<Vector3<f32>>();
}
