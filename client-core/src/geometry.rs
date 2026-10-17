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
//! Faces are flat-shaded (each triangle has its own three vertices) and keep the server's order,
//! counter-clockwise seen from outside in the server's right-handed frame, in every target space
//! ([`reverses_winding`]).
//!
//! Texture coordinates are box-projected in metres from the chunk's position in its structure
//! (`centroid + v`), so a wall's texture runs continuously across the chunks that make it up and
//! stays fixed to a chunk when it breaks away. A material scales them by its tile size. They follow
//! the image convention Unreal and Direct3D use (v grows downward in the image): seen from outside,
//! u runs right and v runs down a wall, so textures read upright and unmirrored. Each vertex has a
//! tangent (the direction of +u along its face) and the sign that, with the normal, gives the
//! direction of +v (`v_dir = w · normal × tangent`), for normal maps.

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::{ChunkDef, ChunkGeometry, DestructionManifest};

use crate::coords::Space;
use crate::materials::{Catalog, VlChunkSurface};

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
    /// Per vertex: the unit direction of +u along the face (xyz) and the sign `w` with
    /// `+v direction = w · (normal × tangent)`, in the target space.
    pub tangents: Vec<[f32; 4]>,
    /// Per vertex: the catalog material its face wears (the chunk's floor material on faces that
    /// mostly face up or down, its wall material otherwise). Empty without surfaces.
    pub materials: Vec<u32>,
    /// Per vertex: `uvs` in tiles of that material (metres / its `metres_per_tile`), so a renderer
    /// samples its texture at these directly. Empty without surfaces.
    pub tile_uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
}

impl ChunkMeshes {
    /// Meshes for every chunk of `manifest`, in `space`.
    pub fn build(manifest: &DestructionManifest, space: Space) -> Self {
        Self::build_with_surfaces(manifest, space, None)
    }

    /// Meshes with each face's catalog material and tile coordinates, from `surfaces` (one per
    /// chunk, chunk-table order; `materials::chunk_surfaces`).
    pub fn build_with_surfaces(
        manifest: &DestructionManifest,
        space: Space,
        surfaces: Option<(&[VlChunkSurface], &Catalog)>,
    ) -> Self {
        let mut out = Self::default();
        let flip = reverses_winding(space);
        let mut scratch = Vec::new();
        let mut slot = 0usize;
        for structure in &manifest.structures {
            for chunk in &structure.chunks {
                let hull = server_triangles(chunk, &manifest.shape_library, &mut scratch);
                let surface = surfaces.and_then(|(s, catalog)| s.get(slot).map(|s| (*s, catalog)));
                out.push_chunk_surfaced(chunk, &scratch, space, flip, hull, surface);
                slot += 1;
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
    #[cfg(test)]
    fn push_chunk(&mut self, chunk: &ChunkDef, triangles: &[[Vec3; 3]], space: Space, flip: bool, hull: bool) {
        self.push_chunk_surfaced(chunk, triangles, space, flip, hull, None);
    }

    fn push_chunk_surfaced(
        &mut self,
        chunk: &ChunkDef,
        triangles: &[[Vec3; 3]],
        space: Space,
        flip: bool,
        hull: bool,
        surface: Option<(VlChunkSurface, &Catalog)>,
    ) {
        let first_vertex = self.positions.len() as u32;
        let first_index = self.indices.len() as u32;
        let centroid = Vec3::from_array(chunk.centroid);
        for (t, tri) in triangles.iter().enumerate() {
            let normal = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
            let target_normal = Vec3::from_array(space.pos(normal)).normalize_or_zero().to_array();
            let material = surface.map(|(s, catalog)| {
                let a = normal.abs();
                let id = if a.y >= a.x && a.y >= a.z { s.floor } else { s.wall };
                let tile = catalog.materials.get(id as usize).map_or(1.0, |m| m.metres_per_tile).max(1e-3);
                (u32::from(id), tile)
            });
            let tangent = face_tangent(normal, space);
            for corner in tri {
                let uv = box_uv(centroid + *corner, normal);
                self.positions.push(space.pos(*corner));
                self.normals.push(target_normal);
                self.uvs.push(uv);
                self.tangents.push(tangent);
                if let Some((id, tile)) = material {
                    self.materials.push(id);
                    self.tile_uvs.push([uv[0] / tile, uv[1] / tile]);
                }
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

/// Whether `space` mirrors the server's right-handed frame (the sign of the map's determinant on
/// the basis vectors). Unreal's does.
pub fn flips_handedness(space: Space) -> bool {
    let col = |v: Vec3| Vec3::from_array(space.pos(v));
    let (x, y, z) = (col(Vec3::X), col(Vec3::Y), col(Vec3::Z));
    x.dot(y.cross(z)) < 0.0
}

/// Whether triangles must be re-ordered for `space`'s renderer to treat outward faces as front
/// faces. Never, for the spaces there are: Unreal's mirrored axes and its rasterizer's front-face
/// convention cancel, so the server's order draws outward faces as front faces there. Checked on
/// screen (VibeCity, 2026-10-17): reversed, every chunk drew inside out.
pub fn reverses_winding(space: Space) -> bool {
    match space {
        Space::Server | Space::Unreal => false,
    }
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
pub(crate) fn convex_hull_triangles(points: &[f32], out: &mut Vec<[Vec3; 3]>) -> bool {
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

/// The box projection's axes for a face with server normal `n`: the face's dominant axis is dropped
/// and `(u_dir, v_dir)` are the directions of +u and +v in the structure frame, chosen so that seen
/// from outside u runs right and v runs down (up on a wall is −v), never mirrored.
fn box_axes(n: Vec3) -> (Vec3, Vec3) {
    let a = n.abs();
    if a.y >= a.x && a.y >= a.z {
        // Tops seen from above with −z up the image; bottoms seen from below with +z up.
        if n.y >= 0.0 { (Vec3::X, Vec3::Z) } else { (Vec3::X, Vec3::NEG_Z) }
    } else if a.x >= a.z {
        if n.x >= 0.0 { (Vec3::NEG_Z, Vec3::NEG_Y) } else { (Vec3::Z, Vec3::NEG_Y) }
    } else if n.z >= 0.0 {
        (Vec3::X, Vec3::NEG_Y)
    } else {
        (Vec3::NEG_X, Vec3::NEG_Y)
    }
}

/// Box projection in metres of structure-frame point `p` on a face with normal `n`.
fn box_uv(p: Vec3, n: Vec3) -> [f32; 2] {
    let (u, v) = box_axes(n);
    [p.dot(u), p.dot(v)]
}

/// The face's tangent in `space`: +u projected onto the face, with the sign that recovers +v.
fn face_tangent(n: Vec3, space: Space) -> [f32; 4] {
    let (u, v) = box_axes(n);
    let t = (u - n * n.dot(u)).normalize_or_zero();
    let to = |d: Vec3| Vec3::from_array(space.pos(d)).normalize_or_zero();
    let (nt, tt, vt) = (to(n), to(t), to(v));
    let w = if nt.cross(tt).dot(vt) >= 0.0 { 1.0 } else { -1.0 };
    [tt.x, tt.y, tt.z, w]
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
        ChunkDef {
            node_index: 0,
            centroid: [1.0, 2.0, 3.0],
            mass: 1.0,
            volume: 1.0,
            size,
            geometry,
            radius: 1.0,
            support: false,
            material: 0,
            mass_offset: [0.0; 3],
        }
    }

    fn mesh_of(chunk: &ChunkDef, library: &[Vec<f32>], space: Space) -> (Vec<Vec3>, Vec<u32>, bool) {
        let mut tris = Vec::new();
        let hull = server_triangles(chunk, library, &mut tris);
        let mut m = ChunkMeshes::default();
        m.push_chunk(chunk, &tris, space, reverses_winding(space), hull);
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
    fn unreal_box_keeps_the_server_order_through_the_mirror() {
        assert!(flips_handedness(Space::Unreal));
        assert!(!flips_handedness(Space::Server));
        let c = cuboid([0.5, 1.5, 2.0]);
        let (p, idx, _) = mesh_of(&c, &[], Space::Unreal);
        assert_closed(&p, &idx);
        // Centimetres, in the server's order through a mirror: the right-hand rule now reads the
        // outward faces as inward, so the volume reads −V·100³.
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
        // +z face seen from outside: u = x to the right, v = −y downward.
        assert_eq!(uv_at(&a, shared), [0.5, -0.5]);
    }

    #[test]
    fn tangents_follow_u_and_signs_recover_v_in_both_spaces() {
        // For every face of a hull and a box: the tangent lies in the face, points along +u (the uv
        // increases along it), and w·(n × t) points along +v.
        let pts: Vec<f32> = vec![0.7, 0.0, 0.0, -0.4, 0.1, 0.0, 0.0, 0.9, 0.1, 0.1, -0.6, 0.0, 0.0, 0.0, 0.5, 0.05, 0.1, -0.8];
        for space in [Space::Server, Space::Unreal] {
            for c in [cuboid([0.5, 1.0, 1.5]), chunk(ChunkGeometry::ConvexHull { points: pts.clone(), shape_id: None }, [1.0; 3])] {
                let mut tris = Vec::new();
                let hull = server_triangles(&c, &[], &mut tris);
                let mut m = ChunkMeshes::default();
                m.push_chunk(&c, &tris, space, reverses_winding(space), hull);
                for tri in m.positions.chunks_exact(3).zip(m.tangents.chunks_exact(3)).zip(m.uvs.chunks_exact(3)).zip(m.normals.chunks_exact(3)) {
                    let (((p, tg), uv), n) = tri;
                    let p: Vec<Vec3> = p.iter().map(|v| Vec3::from_array(*v)).collect();
                    let n = Vec3::from_array(n[0]);
                    let t = Vec3::new(tg[0][0], tg[0][1], tg[0][2]);
                    assert!(t.dot(n).abs() < 1e-4, "tangent leaves the face");
                    // Solve the face's uv gradient: d(uv) = J · d(p) over two edges.
                    let (e1, e2) = (p[1] - p[0], p[2] - p[0]);
                    let (du1, du2) = (uv[1][0] - uv[0][0], uv[2][0] - uv[0][0]);
                    let (dv1, dv2) = (uv[1][1] - uv[0][1], uv[2][1] - uv[0][1]);
                    // Gradient of u and v within the face plane.
                    let g = |d1: f32, d2: f32| {
                        let (a, b, c2) = (e1.dot(e1), e1.dot(e2), e2.dot(e2));
                        let det = a * c2 - b * b;
                        let (x, y) = ((d1 * c2 - d2 * b) / det, (d2 * a - d1 * b) / det);
                        e1 * x + e2 * y
                    };
                    let (gu, gv) = (g(du1, du2), g(dv1, dv2));
                    assert!(t.dot(gu) > 0.0, "tangent does not run along +u ({space:?})");
                    let bit = n.cross(t) * tg[0][3];
                    assert!(bit.dot(gv) > 0.0, "w·(n×t) does not run along +v ({space:?})");
                }
            }
        }
    }
}
