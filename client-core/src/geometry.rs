//! Triangle meshes for every chunk of a city manifest, in the renderer's space.
//!
//! One implementation for both clients (the web builds its own with three.js `ConvexGeometry` today,
//! `client/src/city/chunkGeometry.ts`, and is meant to move onto this). The rules match it: a hull
//! chunk with at least four points is the convex hull of its points; anything else is a box of its
//! authored half extents (a hull too degenerate to span a volume falls back to the box of its
//! authored size, floored at 5 cm as the web does).
//!
//! Each chunk's mesh is in the chunk's frame: its structure's axes, origin at the chunk's `centroid`
//! (where [`crate::frame::VlChunk::rest_pos`] puts it). A standing chunk's vertex is therefore at
//! `rest_pos + rest_quat * v` and a chunk riding a body at `body.pos + body.quat * (local_pos + v)`.
//! Faces are flat-shaded (each triangle has its own three vertices) and wound counter-clockwise
//! seen from outside in the target space's own handedness.
//!
//! Texture coordinates are box-projected in metres from the chunk's position in its structure
//! (`centroid + v`), so a wall's texture runs continuously across the chunks that make it up and
//! stays fixed to a chunk when it breaks away. A material scales them by its tile size.

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::{ChunkDef, ChunkGeometry, DestructionManifest};

use crate::coords::Space;

/// The smallest half extent a fallback box gets (the web's 0.05 m floor on the full size).
const MIN_FALLBACK_HALF_EXTENT_M: f32 = 0.025;

/// Where one chunk's triangles live in a [`ChunkMeshes`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VlMeshRange {
    pub first_vertex: u32,
    pub vertex_count: u32,
    /// Into [`ChunkMeshes::indices`]; the indices are relative to `first_vertex`.
    pub first_index: u32,
    pub index_count: u32,
    /// Index into the manifest's material table (`material_appearance`).
    pub material: u32,
    /// [`VL_MESH_HULL`] when the mesh is the chunk's convex hull, else its box.
    pub flags: u32,
}

pub const VL_MESH_HULL: u32 = 1;

/// Every chunk's mesh, in chunk-table order (structures in manifest order, then their chunks), as
/// flat arrays a renderer can read in place.
#[derive(Clone, Debug, Default)]
pub struct ChunkMeshes {
    pub ranges: Vec<VlMeshRange>,
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// Metres, box-projected in the structure frame.
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
}

impl ChunkMeshes {
    /// Meshes for every chunk of `manifest`, in `space`.
    pub fn build(manifest: &DestructionManifest, space: Space) -> Self {
        let mut out = Self::default();
        let flip = flips_handedness(space);
        let mut scratch = Vec::new();
        for structure in &manifest.structures {
            for chunk in &structure.chunks {
                let hull = server_triangles(chunk, &manifest.shape_library, &mut scratch);
                out.push_chunk(chunk, &scratch, space, flip, hull);
            }
        }
        out
    }

    pub fn chunk_count(&self) -> usize {
        self.ranges.len()
    }

    /// One chunk's vertex positions and its (range-relative) indices.
    pub fn chunk(&self, index: usize) -> Option<(&[[f32; 3]], &[[f32; 3]], &[u32])> {
        let r = self.ranges.get(index)?;
        let v = r.first_vertex as usize..(r.first_vertex + r.vertex_count) as usize;
        let i = r.first_index as usize..(r.first_index + r.index_count) as usize;
        Some((&self.positions[v.clone()], &self.normals[v], &self.indices[i]))
    }

    /// Appends one chunk from its server-space triangles (chunk frame, CCW from outside).
    fn push_chunk(&mut self, chunk: &ChunkDef, triangles: &[[Vec3; 3]], space: Space, flip: bool, hull: bool) {
        let first_vertex = self.positions.len() as u32;
        let first_index = self.indices.len() as u32;
        let centroid = Vec3::from_array(chunk.centroid);
        for (t, tri) in triangles.iter().enumerate() {
            let normal = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
            let target_normal = Vec3::from_array(space.pos(normal)).normalize_or_zero().to_array();
            for corner in tri {
                self.positions.push(space.pos(*corner));
                self.normals.push(target_normal);
                self.uvs.push(box_uv(centroid + *corner, normal));
            }
            let base = (t * 3) as u32;
            if flip {
                self.indices.extend_from_slice(&[base, base + 2, base + 1]);
            } else {
                self.indices.extend_from_slice(&[base, base + 1, base + 2]);
            }
        }
        self.ranges.push(VlMeshRange {
            first_vertex,
            vertex_count: self.positions.len() as u32 - first_vertex,
            first_index,
            index_count: self.indices.len() as u32 - first_index,
            material: chunk.material,
            flags: if hull { VL_MESH_HULL } else { 0 },
        });
    }
}

/// Whether `space` mirrors the server's right-handed frame (then winding must be reversed to stay
/// counter-clockwise from outside). The sign of the map's determinant on the basis vectors.
pub fn flips_handedness(space: Space) -> bool {
    let col = |v: Vec3| Vec3::from_array(space.pos(v));
    let (x, y, z) = (col(Vec3::X), col(Vec3::Y), col(Vec3::Z));
    x.dot(y.cross(z)) < 0.0
}

/// A chunk's points (resolving a shape-library id), or `None` for a box chunk.
pub fn hull_points<'a>(chunk: &'a ChunkDef, shape_library: &'a [Vec<f32>]) -> Option<&'a [f32]> {
    match &chunk.geometry {
        ChunkGeometry::ConvexHull { points, shape_id } => {
            if !points.is_empty() {
                Some(points)
            } else {
                shape_id.and_then(|id| shape_library.get(id as usize)).map(Vec::as_slice)
            }
        }
        ChunkGeometry::Cuboid { .. } => None,
    }
}

/// The chunk's triangles in server space (chunk frame), counter-clockwise from outside, into
/// `out`. True when they are its convex hull, false for a box.
fn server_triangles(chunk: &ChunkDef, shape_library: &[Vec<f32>], out: &mut Vec<[Vec3; 3]>) -> bool {
    out.clear();
    if let Some(points) = hull_points(chunk, shape_library) {
        if convex_hull_triangles(points, out) {
            return true;
        }
        out.clear();
    }
    let half = match &chunk.geometry {
        ChunkGeometry::Cuboid { half_extents } => Vec3::from_array(*half_extents),
        // A degenerate hull: the box of its authored size, floored as the web floors it.
        ChunkGeometry::ConvexHull { .. } => (Vec3::from_array(chunk.size) * 0.5).max(Vec3::splat(MIN_FALLBACK_HALF_EXTENT_M)),
    };
    box_triangles(half, out);
    false
}

/// The convex hull of flat xyz `points` (parry's quickhull, as `destruction::variants` uses for the
/// hull's centre of mass), oriented outward. False when the points span no volume.
fn convex_hull_triangles(points: &[f32], out: &mut Vec<[Vec3; 3]>) -> bool {
    use rapier3d::na::Point3;
    let input: Vec<Point3<f32>> = points.chunks_exact(3).map(|p| Point3::new(p[0], p[1], p[2])).collect();
    if input.len() < 4 || input.iter().any(|p| !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite())) {
        return false;
    }
    let Ok((vertices, triangles)) = rapier3d::parry::transformation::try_convex_hull(&input) else {
        return false;
    };
    if triangles.len() < 4 {
        return false;
    }
    let v = |i: u32| {
        let p = vertices[i as usize];
        Vec3::new(p.x, p.y, p.z)
    };
    let inside = vertices.iter().fold(Vec3::ZERO, |s, p| s + Vec3::new(p.x, p.y, p.z)) / vertices.len() as f32;
    let mut volume6 = 0.0f32;
    for t in &triangles {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        // Orient each face away from an interior point, whatever parry's convention.
        let tri = if (b - a).cross(c - a).dot(a - inside) >= 0.0 { [a, b, c] } else { [a, c, b] };
        volume6 += (tri[0] - inside).dot((tri[1] - inside).cross(tri[2] - inside));
        out.push(tri);
    }
    volume6 > 0.0
}

/// A box of half extents `h` about the origin: two triangles per face, CCW from outside.
fn box_triangles(h: Vec3, out: &mut Vec<[Vec3; 3]>) {
    // Each face: outward axis, then two in-face axes with u × v = outward.
    let faces = [(Vec3::X, Vec3::Y, Vec3::Z), (Vec3::Y, Vec3::Z, Vec3::X), (Vec3::Z, Vec3::X, Vec3::Y)];
    for (n, u, v) in faces {
        for sign in [1.0f32, -1.0] {
            let (n, u) = (n * sign, u * sign);
            let c = n * h;
            let (du, dv) = (u * h, v * h);
            let (p00, p10, p11, p01) = (c - du - dv, c + du - dv, c + du + dv, c - du + dv);
            out.push([p00, p10, p11]);
            out.push([p00, p11, p01]);
        }
    }
}

/// Box projection in metres: drop the axis the face mostly points along, keep the other two,
/// oriented so the texture reads the right way round from outside and "up" stays up on walls.
fn box_uv(p: Vec3, n: Vec3) -> [f32; 2] {
    let a = n.abs();
    if a.y >= a.x && a.y >= a.z {
        [p.x, if n.y >= 0.0 { -p.z } else { p.z }]
    } else if a.x >= a.z {
        [if n.x >= 0.0 { -p.z } else { p.z }, p.y]
    } else {
        [if n.z >= 0.0 { p.x } else { -p.x }, p.y]
    }
}

/// The rotation of a chunk at rest (its structure's), for callers composing poses themselves.
pub fn structure_rotation(world_rotation: [f32; 4]) -> Quat {
    Quat::from_array(world_rotation).normalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cuboid(half: [f32; 3]) -> ChunkDef {
        chunk(ChunkGeometry::Cuboid { half_extents: half }, [half[0] * 2.0, half[1] * 2.0, half[2] * 2.0])
    }

    fn chunk(geometry: ChunkGeometry, size: [f32; 3]) -> ChunkDef {
        serde_json::from_value(serde_json::json!({
            "nodeIndex": 0, "centroid": [1.0, 2.0, 3.0], "size": size, "mass": 1.0, "volume": 1.0,
            "support": false, "geometry": serde_json::to_value(&geometry).unwrap(),
        }))
        .expect("chunk def")
    }

    fn mesh_of(chunk: &ChunkDef, library: &[Vec<f32>], space: Space) -> (Vec<Vec3>, Vec<u32>, bool) {
        let mut tris = Vec::new();
        let hull = server_triangles(chunk, library, &mut tris);
        let mut m = ChunkMeshes::default();
        m.push_chunk(chunk, &tris, space, flips_handedness(space), hull);
        let (p, _, i) = m.chunk(0).unwrap();
        (p.iter().map(|v| Vec3::from_array(*v)).collect(), i.to_vec(), hull)
    }

    /// Signed volume of a closed triangle mesh (positive when wound CCW from outside in a
    /// right-handed frame; in a left-handed one the same outward winding reads negative).
    fn signed_volume(p: &[Vec3], idx: &[u32]) -> f32 {
        idx.chunks_exact(3).map(|t| p[t[0] as usize].dot(p[t[1] as usize].cross(p[t[2] as usize]))).sum::<f32>() / 6.0
    }

    /// Every edge is shared by exactly two triangles, in opposite directions (closed, consistently
    /// oriented). Vertices are welded by position since faces are flat-shaded.
    fn assert_closed(p: &[Vec3], idx: &[u32]) {
        let key = |v: Vec3| ((v.x * 1e4).round() as i64, (v.y * 1e4).round() as i64, (v.z * 1e4).round() as i64);
        let mut edges: HashMap<_, i32> = HashMap::new();
        for t in idx.chunks_exact(3) {
            for k in 0..3 {
                let (a, b) = (key(p[t[k] as usize]), key(p[t[(k + 1) % 3] as usize]));
                *edges.entry((a, b)).or_default() += 1;
            }
        }
        for (&(a, b), &n) in &edges {
            assert_eq!(n, 1, "edge {a:?}->{b:?} used {n} times in one direction");
            assert_eq!(edges.get(&(b, a)), Some(&1), "edge {a:?}->{b:?} has no opposite");
        }
    }

    #[test]
    fn box_is_closed_outward_with_its_exact_volume() {
        let c = cuboid([0.5, 1.5, 2.0]);
        let (p, idx, hull) = mesh_of(&c, &[], Space::Server);
        assert!(!hull);
        assert_eq!(idx.len(), 36);
        assert_closed(&p, &idx);
        let expected = 8.0 * 0.5 * 1.5 * 2.0;
        assert!((signed_volume(&p, &idx) - expected).abs() < 1e-4 * expected);
    }

    #[test]
    fn unreal_box_keeps_outward_winding_in_a_left_handed_frame() {
        assert!(flips_handedness(Space::Unreal));
        assert!(!flips_handedness(Space::Server));
        let c = cuboid([0.5, 1.5, 2.0]);
        let (p, idx, _) = mesh_of(&c, &[], Space::Unreal);
        assert_closed(&p, &idx);
        // Unreal is left-handed and in centimetres: outward winding reads as negative volume ×100³.
        let expected = -8.0 * 0.5 * 1.5 * 2.0 * 1e6;
        assert!((signed_volume(&p, &idx) - expected).abs() < 1e-4 * expected.abs());
    }

    #[test]
    fn hull_volume_matches_parry_and_normals_face_out() {
        // A random-ish convex point cloud (an irregular octahedron plus interior points).
        let pts: Vec<f32> = vec![
            0.7, 0.0, 0.0, -0.4, 0.1, 0.0, 0.0, 0.9, 0.1, 0.1, -0.6, 0.0, 0.0, 0.0, 0.5, 0.05, 0.1, -0.8,
            0.1, 0.1, 0.1, -0.1, 0.0, 0.05,
        ];
        let c = chunk(ChunkGeometry::ConvexHull { points: pts.clone(), shape_id: None }, [1.0, 1.0, 1.0]);
        let (p, idx, hull) = mesh_of(&c, &[], Space::Server);
        assert!(hull);
        assert_closed(&p, &idx);
        let points: Vec<_> = pts.chunks_exact(3).map(|q| rapier3d::na::Point3::new(q[0], q[1], q[2])).collect();
        let parry = rapier3d::parry::shape::ConvexPolyhedron::from_convex_hull(&points).unwrap();
        use rapier3d::parry::shape::Shape;
        let expected = parry.mass_properties(1.0).mass();
        let got = signed_volume(&p, &idx);
        assert!((got - expected).abs() < 1e-4 * expected, "volume {got} vs parry {expected}");
        // Outward normals: each face's normal points away from the hull's interior.
        let centre = p.iter().copied().sum::<Vec3>() / p.len() as f32;
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (p[t[0] as usize], p[t[1] as usize], p[t[2] as usize]);
            assert!((b - a).cross(c - a).dot((a + b + c) / 3.0 - centre) > 0.0);
        }
    }

    #[test]
    fn shape_library_hulls_resolve_and_degenerate_hulls_fall_back_to_their_box() {
        let library = vec![vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]];
        let by_id = chunk(ChunkGeometry::ConvexHull { points: vec![], shape_id: Some(0) }, [1.0, 1.0, 1.0]);
        let (p, idx, hull) = mesh_of(&by_id, &library, Space::Server);
        assert!(hull);
        assert_eq!(idx.len(), 12, "a tetrahedron");
        assert!((signed_volume(&p, &idx) - 1.0 / 6.0).abs() < 1e-5);

        // Coplanar points span no volume: the box of the authored size.
        let flat = chunk(
            ChunkGeometry::ConvexHull { points: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0], shape_id: None },
            [2.0, 0.02, 4.0],
        );
        let (p, idx, hull) = mesh_of(&flat, &[], Space::Server);
        assert!(!hull);
        assert_closed(&p, &idx);
        let expected = 2.0 * 0.05 * 4.0; // y floored at 5 cm
        assert!((signed_volume(&p, &idx) - expected).abs() < 1e-4);
    }

    #[test]
    fn uvs_are_metres_and_continuous_across_neighbouring_chunks() {
        // Two unit boxes side by side along x share the face plane z = +0.5: the same world point
        // on their +z faces must get the same uv.
        let mut a = cuboid([0.5, 0.5, 0.5]);
        let mut b = cuboid([0.5, 0.5, 0.5]);
        a.centroid = [0.0, 0.0, 0.0];
        b.centroid = [1.0, 0.0, 0.0];
        let uv_at = |c: &ChunkDef, world: Vec3| {
            let mut tris = Vec::new();
            server_triangles(c, &[], &mut tris);
            let centroid = Vec3::from_array(c.centroid);
            for t in &tris {
                for v in t {
                    if (centroid + *v - world).length() < 1e-5 && (t[1] - t[0]).cross(t[2] - t[0]).z > 0.0 {
                        return box_uv(centroid + *v, Vec3::Z);
                    }
                }
            }
            panic!("no +z vertex at {world:?}");
        };
        let shared = Vec3::new(0.5, 0.5, 0.5);
        assert_eq!(uv_at(&a, shared), uv_at(&b, shared));
        assert_eq!(uv_at(&a, shared), [0.5, 0.5]);
    }
}
