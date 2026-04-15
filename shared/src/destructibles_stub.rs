//! No-op `DestructibleRegistry` backend used when the `destructibles`
//! Cargo feature is off (i.e. the real NVIDIA Blast stress solver is
//! not available — e.g. on Vercel preview builds that can't run
//! `scripts/setup-blast.sh`).
//!
//! Every method matches the signature of its real counterpart in
//! [`destructibles_real`](super::destructibles_real) so the rest of
//! the shared crate (in particular [`crate::wasm_api`]) compiles
//! unchanged.  Calls simply no-op: `spawn_*` returns `false`, `step`
//! is empty, transforms and fracture events are always empty.  The
//! JS-visible destructibles API still exists on `WasmSimWorld` so the
//! client doesn't throw — it just sees an empty world.
//!
//! See `docs/BLAST_INTEGRATION.md` for the full story.

use nalgebra::{Isometry3, Quaternion, Translation3, UnitQuaternion};
use rapier3d::prelude::{ImpulseJointSet, MultibodyJointSet};

use crate::simulation::SimWorld;

/// Stride of [`DestructibleRegistry::chunk_transforms_slice`] in
/// `f32`s.  Mirrors the real backend so the JS decoder can hard-code
/// it without branching on which backend is active.
pub const CHUNK_TRANSFORM_STRIDE: usize = 11;

/// Which Blast scenario a destructible would be.  Kept so the
/// `World` schema round-trips on both backends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestructibleKind {
    Wall,
    Tower,
}

/// No-op registry.  Owns two empty buffers so that
/// `chunk_transforms_slice` can return a stable reference.
pub struct DestructibleRegistry {
    transforms: Vec<f32>,
    fracture_events: Vec<u32>,
}

impl DestructibleRegistry {
    pub fn new() -> Self {
        Self {
            transforms: Vec::new(),
            fracture_events: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        0
    }

    pub fn is_empty(&self) -> bool {
        true
    }

    pub fn total_chunk_count(&self) -> usize {
        0
    }

    pub fn spawn_wall(&mut self, _sim: &mut SimWorld, _id: u32, _pose: Isometry3<f32>) -> bool {
        false
    }

    pub fn spawn_tower(&mut self, _sim: &mut SimWorld, _id: u32, _pose: Isometry3<f32>) -> bool {
        false
    }

    pub fn despawn(
        &mut self,
        _sim: &mut SimWorld,
        _impulse_joints: &mut ImpulseJointSet,
        _multibody_joints: &mut MultibodyJointSet,
        _id: u32,
    ) -> bool {
        false
    }

    pub fn step(
        &mut self,
        _sim: &mut SimWorld,
        _impulse_joints: &mut ImpulseJointSet,
        _multibody_joints: &mut MultibodyJointSet,
    ) {
    }

    pub fn chunk_transforms_slice(&self) -> &[f32] {
        &self.transforms
    }

    pub fn drain_fracture_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.fracture_events)
    }
}

impl Default for DestructibleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Debug logging toggle — no-op on the stub backend.
pub fn set_destructibles_log_enabled(_enabled: bool) {}

/// Debug logging query — always `false` on the stub backend.
pub fn destructibles_log_enabled() -> bool {
    false
}

/// Same signature as the real backend's helper so callers don't need
/// to branch.
pub fn pose_from_world_doc(position: [f32; 3], rotation: [f32; 4]) -> Isometry3<f32> {
    let translation = Translation3::new(position[0], position[1], position[2]);
    let q = Quaternion::new(rotation[3], rotation[0], rotation[1], rotation[2]);
    let unit = UnitQuaternion::from_quaternion(q);
    Isometry3::from_parts(translation, unit)
}
