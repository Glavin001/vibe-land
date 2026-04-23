//! Brick-grid fracturing for authored destructible structures.
//!
//! Used when `DestructibleDoc::Structure { fractured: true, .. }` is spawned:
//! each authored box chunk is subdivided into an axis-aligned grid of
//! brick-sized sub-chunks so the Blast stress solver can auto-bond them
//! into a rich network. Sphere and capsule chunks pass through unchanged
//! (complex-shape fracturing is out of scope for now).
//!
//! Keep in sync with `fractureChunks` in
//! `client/src/world/destructibleFactory.ts`.

use nalgebra::{Quaternion, UnitQuaternion, Vector3};

use crate::world_document::{ChunkDoc, FRACTURE_BRICK_EDGE_M};

/// Subdivide every box chunk into brick-sized sub-boxes. No sub-brick is
/// smaller than `brick_edge` on any axis. Mass overrides are distributed
/// across sub-bricks so total mass stays constant; anchor/material flags
/// propagate to every sub-brick.
pub fn fracture_chunks(chunks: &[ChunkDoc], brick_edge: f32) -> Vec<ChunkDoc> {
    let mut out = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        match chunk {
            ChunkDoc::Box {
                position,
                rotation,
                half_extents,
                mass,
                material,
                anchor,
            } => {
                let cells_x = (half_extents[0] * 2.0 / brick_edge).floor().max(1.0) as usize;
                let cells_y = (half_extents[1] * 2.0 / brick_edge).floor().max(1.0) as usize;
                let cells_z = (half_extents[2] * 2.0 / brick_edge).floor().max(1.0) as usize;
                if cells_x == 1 && cells_y == 1 && cells_z == 1 {
                    out.push(chunk.clone());
                    continue;
                }
                let cell_hx = half_extents[0] / cells_x as f32;
                let cell_hy = half_extents[1] / cells_y as f32;
                let cell_hz = half_extents[2] / cells_z as f32;
                let rot_unit = UnitQuaternion::from_quaternion(Quaternion::new(
                    rotation[3],
                    rotation[0],
                    rotation[1],
                    rotation[2],
                ));
                let parent_pos = Vector3::new(position[0], position[1], position[2]);
                let total_cells = (cells_x * cells_y * cells_z) as f32;
                let sub_mass = mass.map(|m| m / total_cells);
                for ix in 0..cells_x {
                    for iy in 0..cells_y {
                        for iz in 0..cells_z {
                            let local_center = Vector3::new(
                                -half_extents[0] + cell_hx * (2 * ix + 1) as f32,
                                -half_extents[1] + cell_hy * (2 * iy + 1) as f32,
                                -half_extents[2] + cell_hz * (2 * iz + 1) as f32,
                            );
                            let rotated = rot_unit.transform_vector(&local_center);
                            let world_pos = parent_pos + rotated;
                            out.push(ChunkDoc::Box {
                                position: [world_pos.x, world_pos.y, world_pos.z],
                                rotation: *rotation,
                                half_extents: [cell_hx, cell_hy, cell_hz],
                                mass: sub_mass,
                                material: material.clone(),
                                anchor: *anchor,
                            });
                        }
                    }
                }
            }
            ChunkDoc::Sphere { .. } | ChunkDoc::Capsule { .. } => {
                out.push(chunk.clone());
            }
        }
    }
    out
}

/// Convenience using the default brick edge constant.
pub fn fracture_chunks_default(chunks: &[ChunkDoc]) -> Vec<ChunkDoc> {
    fracture_chunks(chunks, FRACTURE_BRICK_EDGE_M)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_large_box_into_expected_grid() {
        let chunk = ChunkDoc::Box {
            position: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: [0.5, 0.5, 0.125],
            mass: None,
            material: None,
            anchor: false,
        };
        // 1.0 x 1.0 x 0.25  /  0.25  →  4 x 4 x 1  =  16 cells.
        let out = fracture_chunks(&[chunk], 0.25);
        assert_eq!(out.len(), 16);
        for c in &out {
            if let ChunkDoc::Box { half_extents, .. } = c {
                assert!((half_extents[0] - 0.125).abs() < 1e-6);
                assert!((half_extents[1] - 0.125).abs() < 1e-6);
                assert!((half_extents[2] - 0.125).abs() < 1e-6);
            } else {
                panic!("expected box sub-chunk");
            }
        }
    }

    #[test]
    fn preserves_small_box_unchanged() {
        let chunk = ChunkDoc::Box {
            position: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            // All axes < brick_edge → not subdivided.
            half_extents: [0.1, 0.1, 0.1],
            mass: Some(2.0),
            material: None,
            anchor: true,
        };
        let out = fracture_chunks(&[chunk.clone()], 0.25);
        assert_eq!(out.len(), 1);
        match &out[0] {
            ChunkDoc::Box {
                half_extents,
                mass,
                anchor,
                ..
            } => {
                assert_eq!(*half_extents, [0.1, 0.1, 0.1]);
                assert_eq!(*mass, Some(2.0));
                assert!(*anchor);
            }
            _ => panic!("expected box"),
        }
    }

    #[test]
    fn distributes_mass_across_sub_bricks() {
        let chunk = ChunkDoc::Box {
            position: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: [0.25, 0.25, 0.25],
            mass: Some(8.0),
            material: None,
            anchor: false,
        };
        // 0.5 x 0.5 x 0.5 / 0.25 → 2 x 2 x 2 = 8 cells, each 1.0 kg.
        let out = fracture_chunks(&[chunk], 0.25);
        assert_eq!(out.len(), 8);
        for c in &out {
            if let ChunkDoc::Box { mass, .. } = c {
                assert!((mass.unwrap() - 1.0).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn passes_spheres_and_capsules_through_unchanged() {
        let s = ChunkDoc::Sphere {
            position: [1.0, 2.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            radius: 0.5,
            mass: None,
            material: None,
            anchor: false,
        };
        let c = ChunkDoc::Capsule {
            position: [0.0, 0.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            radius: 0.2,
            height: 1.0,
            mass: None,
            material: None,
            anchor: false,
        };
        let out = fracture_chunks(&[s, c], 0.25);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], ChunkDoc::Sphere { .. }));
        assert!(matches!(out[1], ChunkDoc::Capsule { .. }));
    }
}
