//! Native-server destructible fallback.
//!
//! On the native server the NVIDIA Blast crate is not available (it ships
//! prebuilt wasm32 static libraries only). This module expands every
//! authored destructible into independent dynamic rigid bodies so a
//! structure still falls apart under gravity, just without stress-solver
//! bonding or fracture propagation.
//!
//! Layout of factory `Wall` / `Tower` chunks mirrors the Blast
//! `WallOptions::default` / `TowerOptions::default` scenarios used by the
//! WASM client, so a world that looks identical in single-player and
//! multiplayer spawns the same number of chunks at the same poses. The
//! bottom row of each factory scenario is a fixed support — it becomes a
//! static cuboid here (the implicit `y == 0` support-row rule).
//!
//! Stable body ids follow `(destructible_id << 12) | chunk_index` so
//! snapshots and destructible-level operations stay addressable.

#![cfg(not(target_arch = "wasm32"))]

use nalgebra::{UnitQuaternion, Vector3};

use crate::physics_arena::PhysicsArena;
use crate::world_document::{ChunkDoc, DestructibleKind};

// Mirror of `WallOptions::default()` from the upstream blast-stress-solver
// crate. Keeping these in sync with the WASM build lets authored worlds
// render the same geometry in both single-player and multiplayer.
const WALL_SPAN_M: f32 = 6.0;
const WALL_HEIGHT_M: f32 = 3.0;
const WALL_THICKNESS_M: f32 = 0.32;
const WALL_SPAN_SEGMENTS: usize = 12;
const WALL_HEIGHT_SEGMENTS: usize = 6;
const WALL_LAYERS: usize = 1;

// Mirror of `TowerOptions::default()` (side=4, stories=7, spacing=0.5).
const TOWER_SIDE: usize = 4;
const TOWER_STORIES: usize = 7;
const TOWER_SPACING_X: f32 = 0.5;
const TOWER_SPACING_Y: f32 = 0.5;
const TOWER_SPACING_Z: f32 = 0.5;

/// Returns the chunk list that the Blast wall / tower scenarios would
/// produce, expressed as authored box chunks in the destructible's local
/// frame. Bottom row is marked `anchor = true`.
pub fn factory_chunks_for_fallback(kind: DestructibleKind) -> Vec<ChunkDoc> {
    match kind {
        DestructibleKind::Wall => build_wall_chunks(),
        DestructibleKind::Tower => build_tower_chunks(),
    }
}

fn build_wall_chunks() -> Vec<ChunkDoc> {
    let cell_x = WALL_SPAN_M / WALL_SPAN_SEGMENTS as f32;
    let cell_y = WALL_HEIGHT_M / WALL_HEIGHT_SEGMENTS as f32;
    let cell_z = WALL_THICKNESS_M / WALL_LAYERS as f32;
    let origin_x = -WALL_SPAN_M * 0.5 + cell_x * 0.5;
    let origin_y = cell_y * 0.5;
    let half_extents = [cell_x * 0.5, cell_y * 0.5, cell_z * 0.5];

    let mut out = Vec::with_capacity(WALL_SPAN_SEGMENTS * WALL_HEIGHT_SEGMENTS * WALL_LAYERS);
    for ix in 0..WALL_SPAN_SEGMENTS {
        for iy in 0..WALL_HEIGHT_SEGMENTS {
            for iz in 0..WALL_LAYERS {
                let centroid = [
                    origin_x + ix as f32 * cell_x,
                    origin_y + iy as f32 * cell_y,
                    (iz as f32 - (WALL_LAYERS as f32 - 1.0) * 0.5) * cell_z,
                ];
                out.push(ChunkDoc::Box {
                    position: centroid,
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    half_extents,
                    mass: None,
                    material: None,
                    anchor: iy == 0,
                });
            }
        }
    }
    out
}

fn build_tower_chunks() -> Vec<ChunkDoc> {
    let total_rows = TOWER_STORIES + 1;
    let half_extents = [
        TOWER_SPACING_X * 0.5,
        TOWER_SPACING_Y * 0.5,
        TOWER_SPACING_Z * 0.5,
    ];
    let side_center = (TOWER_SIDE as f32 - 1.0) * 0.5;

    let mut out = Vec::with_capacity(TOWER_SIDE * TOWER_SIDE * total_rows);
    for iz in 0..TOWER_SIDE {
        for iy in 0..total_rows {
            for ix in 0..TOWER_SIDE {
                let centroid = [
                    (ix as f32 - side_center) * TOWER_SPACING_X,
                    (iy as f32 - 1.0) * TOWER_SPACING_Y,
                    (iz as f32 - side_center) * TOWER_SPACING_Z,
                ];
                out.push(ChunkDoc::Box {
                    position: centroid,
                    rotation: [0.0, 0.0, 0.0, 1.0],
                    half_extents,
                    mass: None,
                    material: None,
                    anchor: iy == 0,
                });
            }
        }
    }
    out
}

/// Place a single chunk in the arena: anchor chunks become static
/// cuboids, regular chunks spawn as dynamic rigid bodies. `structure_pos`
/// and `structure_rot` compose onto the chunk's local transform.
pub fn spawn_native_chunk(
    arena: &mut PhysicsArena,
    body_id: u32,
    chunk: &ChunkDoc,
    structure_pos: Vector3<f32>,
    structure_rot: UnitQuaternion<f32>,
    _density: f32,
) {
    let local_pos = chunk.position();
    let chunk_world_pos = structure_pos
        + structure_rot.transform_vector(&Vector3::new(local_pos[0], local_pos[1], local_pos[2]));
    let chunk_local_rot = chunk.rotation();
    let chunk_local_unit = UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        chunk_local_rot[3],
        chunk_local_rot[0],
        chunk_local_rot[1],
        chunk_local_rot[2],
    ));
    let world_rot = structure_rot * chunk_local_unit;
    let world_rot_quat = world_rot.quaternion();
    let world_rot_arr = [
        world_rot_quat.i,
        world_rot_quat.j,
        world_rot_quat.k,
        world_rot_quat.w,
    ];

    if chunk.anchor() {
        // Anchors become static cuboids regardless of shape — the native
        // arena has no frozen-dynamic concept, so sphere/capsule anchors
        // fall back to their tight-fit AABB cuboid.
        let half = chunk.aabb_half_extents();
        arena.add_static_cuboid_rotated(
            chunk_world_pos,
            world_rot_arr,
            Vector3::new(half[0], half[1], half[2]),
            body_id as u128,
        );
        return;
    }

    match chunk {
        ChunkDoc::Box { half_extents, .. } => {
            arena.spawn_dynamic_box_with_id(
                body_id,
                chunk_world_pos,
                world_rot_arr,
                Vector3::new(half_extents[0], half_extents[1], half_extents[2]),
            );
        }
        ChunkDoc::Sphere { radius, .. } => {
            arena.spawn_dynamic_ball_with_id(body_id, chunk_world_pos, *radius);
        }
        ChunkDoc::Capsule { radius, height, .. } => {
            // Native build has no dynamic capsule spawn helper yet, so
            // fall back to a tight-fit dynamic box. This matches the
            // visual AABB used for rendering.
            let half = [*radius, height * 0.5 + *radius, *radius];
            arena.spawn_dynamic_box_with_id(
                body_id,
                chunk_world_pos,
                world_rot_arr,
                Vector3::new(half[0], half[1], half[2]),
            );
        }
    }
}
