//! Flat ground built from boxes, as one static triangle mesh.
//!
//! Roads and paving are authored as boxes: rectangles of asphalt or slabs at a
//! few heights over grade. As separate collision boxes they make the
//! internal-edge problem: a body sliding over the seam between two flush
//! boxes meets the next one's edge and is thrown up and back (Box2D "ghost
//! collisions"; Bullet btAdjustInternalEdgeContacts). In stock PhysX, a ball at
//! 20 m/s left flush static boxes at 5.3 m/s up and a 1.5 t box snagged to a
//! stop, CPU and GPU alike, where one box or one triangle mesh was clean
//! (docs/destruction/INTERNAL_EDGES.md). The standard answer is one mesh whose
//! coplanar neighbours share their edges: PhysX's cooking precomputes which
//! edges are active, and an edge between coplanar triangles is not.
//!
//! The mesh is the boxes' union as height columns (2.5D): the x and z
//! coordinates of every box edge cut the plane into cells (coordinate
//! compression), each cell covered by boxes takes their highest top, and a
//! wall drops from a cell's top to its neighbour's (or to the cell's lowest
//! bottom where nothing covers the neighbour). Every vertex is shared through
//! (x index, z index, height level), and walls are split at every height
//! level present, so the mesh is conforming: no T-junction leaves an edge
//! without its neighbour, which would make it a boundary edge and active.
//! Bottom faces are left out: the ground's own surface is under them.
//! Triangles wind counter-clockwise seen from outside (PhysX's front face).

use std::collections::HashMap;

/// An axis-aligned box: its minimum and maximum corners.
pub type GroundBox = ([f32; 3], [f32; 3]);

/// The mesh: xyz vertex triplets and triangle indices.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroundMesh {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

impl GroundMesh {
    pub fn triangle_count(&self) -> usize { self.indices.len() / 3 }
}

fn sorted_unique(mut v: Vec<f32>) -> Vec<f32> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.dedup();
    v
}

/// The union of `boxes` (axis-aligned, in one frame) as one conforming mesh.
pub fn from_boxes(boxes: &[GroundBox]) -> GroundMesh {
    if boxes.is_empty() { return GroundMesh::default(); }
    let xs = sorted_unique(boxes.iter().flat_map(|b| [b.0[0], b.1[0]]).collect());
    let zs = sorted_unique(boxes.iter().flat_map(|b| [b.0[2], b.1[2]]).collect());
    let levels = sorted_unique(boxes.iter().flat_map(|b| [b.0[1], b.1[1]]).collect());
    let (nx, nz) = (xs.len() - 1, zs.len() - 1);
    let index = |v: &[f32], x: f32| v.binary_search_by(|p| p.partial_cmp(&x).unwrap()).unwrap();
    let level = |y: f32| index(&levels, y);
    // Each cell's (top, bottom) level, if covered.
    let mut cells: Vec<Option<(usize, usize)>> = vec![None; nx * nz];
    for b in boxes {
        let (i0, i1, k0, k1) = (index(&xs, b.0[0]), index(&xs, b.1[0]), index(&zs, b.0[2]), index(&zs, b.1[2]));
        let (top, bottom) = (level(b.1[1]), level(b.0[1]));
        for i in i0..i1 {
            for k in k0..k1 {
                let c = &mut cells[i * nz + k];
                *c = Some(match *c { Some((t, d)) => (t.max(top), d.min(bottom)), None => (top, bottom) });
            }
        }
    }
    let mut mesh = GroundMesh::default();
    let mut shared: HashMap<(usize, usize, usize), u32> = HashMap::new();
    let mut vertex = |mesh: &mut GroundMesh, i: usize, k: usize, l: usize| -> u32 {
        *shared.entry((i, k, l)).or_insert_with(|| {
            mesh.vertices.extend_from_slice(&[xs[i], levels[l], zs[k]]);
            (mesh.vertices.len() / 3 - 1) as u32
        })
    };
    let cell = |i: isize, k: isize| -> Option<(usize, usize)> {
        if i < 0 || k < 0 || i as usize >= nx || k as usize >= nz { None } else { cells[i as usize * nz + k as usize] }
    };
    for i in 0..nx {
        for k in 0..nz {
            let Some((top, bottom)) = cells[i * nz + k] else { continue };
            // Top face (+y): (i,k) (i,k+1) (i+1,k+1) (i+1,k), counter-clockwise from above.
            let (a, b, c, d) = (vertex(&mut mesh, i, k, top), vertex(&mut mesh, i, k + 1, top), vertex(&mut mesh, i + 1, k + 1, top), vertex(&mut mesh, i + 1, k, top));
            mesh.indices.extend_from_slice(&[a, b, c, a, c, d]);
            // Walls: down to the neighbour's top, or to this cell's bottom where nothing is.
            // (di, dk): the neighbour's direction; the wall's two corners (i, k) indices along it.
            let sides: [((isize, isize), (usize, usize), (usize, usize)); 4] = [
                ((1, 0), (i + 1, k), (i + 1, k + 1)),  // +x
                ((-1, 0), (i, k + 1), (i, k)),         // -x
                ((0, 1), (i + 1, k + 1), (i, k + 1)),  // +z
                ((0, -1), (i, k), (i + 1, k)),         // -z
            ];
            for ((di, dk), p, q) in sides {
                let floor = match cell(i as isize + di, k as isize + dk) { Some((t, _)) => t, None => bottom };
                if floor >= top { continue; }
                // One quad per level band, so every wall vertex is shared.
                for l in floor..top {
                    // p -> q runs clockwise seen from outside (from +x: toward +z), so p, q-up, q faces out.
                    let (p0, q0, q1, p1) = (vertex(&mut mesh, p.0, p.1, l), vertex(&mut mesh, q.0, q.1, l), vertex(&mut mesh, q.0, q.1, l + 1), vertex(&mut mesh, p.0, p.1, l + 1));
                    mesh.indices.extend_from_slice(&[p0, q1, q0, p0, p1, q1]);
                }
            }
        }
    }
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normal(m: &GroundMesh, t: usize) -> [f32; 3] {
        let p = |j: usize| { let i = m.indices[3 * t + j] as usize * 3; [m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]] };
        let (a, b, c) = (p(0), p(1), p(2));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    }

    /// Two flush slabs: one flat top of four triangles over the seam, sharing
    /// the seam's vertices, and walls only around the outside.
    #[test]
    fn flush_slabs_share_their_seam() {
        let m = from_boxes(&[([0.0, 0.0, 0.0], [4.0, 0.025, 4.0]), ([0.0, 0.0, 4.0], [4.0, 0.025, 8.0])]);
        let tops = (0..m.triangle_count()).filter(|&t| normal(&m, t)[1] > 0.0).count();
        assert_eq!(tops, 4);
        // 6 top vertices (3 along z x 2 along x) + 6 at the bottom of the walls.
        assert_eq!(m.vertices.len() / 3, 12);
        // No wall at the seam: every wall triangle lies on the outer boundary.
        for t in 0..m.triangle_count() {
            let n = normal(&m, t);
            if n[1] != 0.0 { continue; }
            let i = m.indices[3 * t] as usize * 3;
            let (x, z) = (m.vertices[i], m.vertices[i + 2]);
            if n[2] != 0.0 { assert!(z == 0.0 || z == 8.0, "a wall inside the union at z {z}"); } else { assert!(x == 0.0 || x == 4.0); }
        }
    }

    /// Every triangle faces out: tops up, walls away from the box they bound.
    #[test]
    fn triangles_face_out() {
        let m = from_boxes(&[([0.0, 0.0, 0.0], [2.0, 0.06, 2.0]), ([2.0, 0.0, 0.0], [4.0, 0.025, 2.0])]);
        for t in 0..m.triangle_count() {
            let n = normal(&m, t);
            let c: Vec<f32> = (0..3).map(|k| (0..3).map(|j| m.vertices[m.indices[3 * t + j] as usize * 3 + k]).sum::<f32>() / 3.0).collect();
            if n[1] != 0.0 { assert!(n[1] > 0.0, "a top facing down"); continue; }
            // A wall's outward side: toward the lower (or empty) neighbour.
            let probe = [c[0] + n[0].signum() * 0.01, c[2] + n[2].signum() * 0.01];
            let inside = |x: f32, z: f32, y: f32| (x > 0.0 && x < 2.0 && z > 0.0 && z < 2.0 && y < 0.06) || (x > 2.0 && x < 4.0 && z > 0.0 && z < 2.0 && y < 0.025);
            assert!(!inside(probe[0], probe[1], c[1]), "wall {t} faces into the solid at {c:?} n {n:?}");
        }
    }

    /// The step between the 60 mm paving and the 25 mm road is a wall of 35 mm,
    /// split at the road's level so the road's top edge shares its vertices.
    #[test]
    fn steps_are_walls() {
        let m = from_boxes(&[([0.0, 0.0, 0.0], [2.0, 0.06, 2.0]), ([2.0, 0.0, 0.0], [4.0, 0.025, 2.0])]);
        let step: Vec<usize> = (0..m.triangle_count()).filter(|&t| {
            let n = normal(&m, t);
            let i = m.indices[3 * t] as usize * 3;
            n[0] > 0.0 && m.vertices[i] == 2.0
        }).collect();
        assert_eq!(step.len(), 2, "one quad from 0.025 to 0.06 at x = 2");
    }
}
