//! Marching-squares remesh of a sheet occupancy mask into an extruded mesh.

use super::mask::SheetMask;

#[derive(Clone, Debug, Default)]
pub struct SheetMesh {
    /// XYZ positions in sheet-local space (U, thickness-centered V extruded, V).
    /// Convention: X = u, Y = ±thickness/2, Z = v.
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

/// Rebuild a closed extruded mesh from occupancy. Returns empty mesh if fully carved.
pub fn remesh_sheet(mask: &SheetMask, thickness: f32) -> SheetMesh {
    let cell = mask.cell_size;
    let w = mask.width as usize;
    let h = mask.height as usize;
    if w == 0 || h == 0 {
        return SheetMesh::default();
    }

    // Collect solid quads (one quad per occupied cell) and extrude.
    // Simple, robust, and deterministic — triangle count is fine for hut walls.
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let half_t = thickness * 0.5;

    for y in 0..mask.height {
        for x in 0..mask.width {
            if !mask.occupied(x, y) {
                continue;
            }
            let u0 = x as f32 * cell;
            let u1 = (x + 1) as f32 * cell;
            let v0 = y as f32 * cell;
            let v1 = (y + 1) as f32 * cell;
            let base = positions.len() as u32;

            // Front face ( +Y )
            positions.push([u0, half_t, v0]);
            positions.push([u1, half_t, v0]);
            positions.push([u1, half_t, v1]);
            positions.push([u0, half_t, v1]);
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);

            // Back face ( -Y )
            let b = positions.len() as u32;
            positions.push([u0, -half_t, v0]);
            positions.push([u0, -half_t, v1]);
            positions.push([u1, -half_t, v1]);
            positions.push([u1, -half_t, v0]);
            indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);

            // Side walls only on boundaries / hole edges.
            let neighbors = [
                (x as i32, y as i32 - 1, [u0, -half_t, v0], [u1, -half_t, v0], [u1, half_t, v0], [u0, half_t, v0]), // -v
                (x as i32, y as i32 + 1, [u1, -half_t, v1], [u0, -half_t, v1], [u0, half_t, v1], [u1, half_t, v1]), // +v
                (x as i32 - 1, y as i32, [u0, -half_t, v1], [u0, -half_t, v0], [u0, half_t, v0], [u0, half_t, v1]), // -u
                (x as i32 + 1, y as i32, [u1, -half_t, v0], [u1, -half_t, v1], [u1, half_t, v1], [u1, half_t, v0]), // +u
            ];
            for (nx, ny, p0, p1, p2, p3) in neighbors {
                let exposed = !mask.in_bounds(nx, ny)
                    || !mask.occupied(nx as u16, ny as u16);
                if !exposed {
                    continue;
                }
                let s = positions.len() as u32;
                positions.push(p0);
                positions.push(p1);
                positions.push(p2);
                positions.push(p3);
                indices.extend_from_slice(&[s, s + 1, s + 2, s, s + 2, s + 3]);
            }
        }
    }

    SheetMesh { positions, indices }
}

/// Convert sheet-local mesh into world-space vertices using a frame.
pub fn transform_mesh_to_world(
    mesh: &SheetMesh,
    origin: [f32; 3],
    axis_u: [f32; 3],
    axis_thickness: [f32; 3],
    axis_v: [f32; 3],
) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let positions: Vec<[f32; 3]> = mesh
        .positions
        .iter()
        .map(|p| {
            [
                origin[0] + axis_u[0] * p[0] + axis_thickness[0] * p[1] + axis_v[0] * p[2],
                origin[1] + axis_u[1] * p[0] + axis_thickness[1] * p[1] + axis_v[1] * p[2],
                origin[2] + axis_u[2] * p[0] + axis_thickness[2] * p[1] + axis_v[2] * p[2],
            ]
        })
        .collect();
    let mut tris = Vec::with_capacity(mesh.indices.len() / 3);
    for tri in mesh.indices.chunks_exact(3) {
        tris.push([tri[0], tri[1], tri[2]]);
    }
    (positions, tris)
}
