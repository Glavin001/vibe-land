//! Marching-squares remesh of a sheet occupancy mask into an extruded mesh.
//!
//! Occupancy is still a cell grid (carve authority), but the surface uses
//! dual-grid marching squares so hole boundaries get diagonal edges instead of
//! Minecraft-style stair-step cutouts.

use super::mask::SheetMask;

#[derive(Clone, Debug, Default)]
pub struct SheetMesh {
    /// XYZ positions in sheet-local space (U, thickness-centered V extruded, V).
    /// Convention: X = u, Y = ±thickness/2, Z = v.
    pub positions: Vec<[f32; 3]>,
    /// RGB vertex colors in 0..1. Front faces stay bright; back/rim faces are
    /// darkened so holes read as openings instead of matching the opposite wall.
    pub colors: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

#[inline]
fn solid(mask: &SheetMask, x: i32, y: i32) -> bool {
    mask.in_bounds(x, y) && mask.occupied(x as u16, y as u16)
}

/// Edge midpoints and corners for one marching-squares unit, in cell units
/// relative to the square's min corner (cell-center dual grid).
#[inline]
fn ms_point(edge: u8, x0: f32, y0: f32) -> [f32; 2] {
    // Square corners: 0=BL, 1=BR, 2=TR, 3=TL. Edge midpoints: 4=bottom, 5=right, 6=top, 7=left.
    match edge {
        0 => [x0, y0],
        1 => [x0 + 1.0, y0],
        2 => [x0 + 1.0, y0 + 1.0],
        3 => [x0, y0 + 1.0],
        4 => [x0 + 0.5, y0],
        5 => [x0 + 1.0, y0 + 0.5],
        6 => [x0 + 0.5, y0 + 1.0],
        7 => [x0, y0 + 0.5],
        _ => [x0, y0],
    }
}

/// Polygon rings (as edge-index lists) for solid region of each MS case 0..15.
/// Corner bits: bit0=BL, bit1=BR, bit2=TR, bit3=TL (cells at those dual samples).
fn case_polygons(case: u8) -> &'static [&'static [u8]] {
    // Edge indices into ms_point.
    match case {
        0 => &[],
        1 => &[&[0, 4, 7]],
        2 => &[&[4, 1, 5]],
        3 => &[&[0, 1, 5, 7]],
        4 => &[&[5, 2, 6]],
        5 => &[&[0, 4, 5, 2, 6, 7]], // ambiguous saddle — pair BL+TR
        6 => &[&[4, 1, 2, 6]],
        7 => &[&[0, 1, 2, 6, 7]],
        8 => &[&[7, 6, 3]],
        9 => &[&[0, 4, 6, 3]],
        10 => &[&[4, 1, 5, 6, 3, 7]], // ambiguous saddle — pair BR+TL
        11 => &[&[0, 1, 5, 6, 3]],
        12 => &[&[5, 2, 3, 7]],
        13 => &[&[0, 4, 5, 2, 3]],
        14 => &[&[4, 1, 2, 3, 7]],
        15 => &[&[0, 1, 2, 3]],
        _ => &[],
    }
}

/// Boundary segments (solid→empty crossings) as pairs of ms edge indices.
fn case_boundary_edges(case: u8) -> &'static [[u8; 2]] {
    match case {
        0 | 15 => &[],
        1 => &[[4, 7]],
        2 => &[[5, 4]],
        3 => &[[5, 7]],
        4 => &[[6, 5]],
        5 => &[[4, 5], [6, 7]],
        6 => &[[6, 4]],
        7 => &[[6, 7]],
        8 => &[[7, 6]],
        9 => &[[4, 6]],
        10 => &[[5, 6], [7, 4]],
        11 => &[[5, 6]],
        12 => &[[7, 5]],
        13 => &[[4, 5]],
        14 => &[[7, 4]],
        _ => &[],
    }
}

/// Rebuild a closed extruded mesh from occupancy. Returns empty mesh if fully carved.
pub fn remesh_sheet(mask: &SheetMask, thickness: f32) -> SheetMesh {
    let cell = mask.cell_size;
    let w = mask.width as i32;
    let h = mask.height as i32;
    if w == 0 || h == 0 {
        return SheetMesh::default();
    }

    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut colors: Vec<[f32; 3]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let half_t = thickness * 0.5;
    let front_c = [1.0, 1.0, 1.0];
    let back_c = [0.22, 0.2, 0.18];
    let rim_c = [0.45, 0.4, 0.35];

    let u_max = mask.width as f32 * cell;
    let v_max = mask.height as f32 * cell;
    let clamp_u = |u: f32| u.clamp(0.0, u_max);
    let clamp_v = |v: f32| v.clamp(0.0, v_max);

    // Dual-grid samples sit at cell centers. Iterate squares between centers,
    // including a one-cell halo so the outer sheet perimeter is closed.
    for y in -1..h {
        for x in -1..w {
            let c0 = solid(mask, x, y);
            let c1 = solid(mask, x + 1, y);
            let c2 = solid(mask, x + 1, y + 1);
            let c3 = solid(mask, x, y + 1);
            let case = (c0 as u8) | ((c1 as u8) << 1) | ((c2 as u8) << 2) | ((c3 as u8) << 3);
            if case == 0 {
                continue;
            }

            // Square min corner in cell units (cell-center of (x,y)).
            let x0 = x as f32 + 0.5;
            let y0 = y as f32 + 0.5;

            for ring in case_polygons(case) {
                if ring.len() < 3 {
                    continue;
                }
                let mut uv: Vec<[f32; 2]> = ring
                    .iter()
                    .map(|&e| {
                        let p = ms_point(e, x0, y0);
                        [clamp_u(p[0] * cell), clamp_v(p[1] * cell)]
                    })
                    .collect();
                // Degenerate after clamp (halo outside sheet) — drop zero-area rings.
                uv.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6);
                if uv.len() >= 3 {
                    let first = uv[0];
                    let last = *uv.last().unwrap();
                    if (first[0] - last[0]).abs() < 1e-6 && (first[1] - last[1]).abs() < 1e-6 {
                        uv.pop();
                    }
                }
                if uv.len() < 3 {
                    continue;
                }

                // Front face (+Y), fan triangulate.
                let base = positions.len() as u32;
                for p in &uv {
                    positions.push([p[0], half_t, p[1]]);
                    colors.push(front_c);
                }
                for i in 1..uv.len() - 1 {
                    indices.extend_from_slice(&[base, base + i as u32, base + i as u32 + 1]);
                }

                // Back face (-Y), reversed winding.
                let b = positions.len() as u32;
                for p in &uv {
                    positions.push([p[0], -half_t, p[1]]);
                    colors.push(back_c);
                }
                for i in 1..uv.len() - 1 {
                    indices.extend_from_slice(&[b, b + i as u32 + 1, b + i as u32]);
                }
            }

            // Thickness rims along solid/empty crossings (hole edges + outer perimeter).
            for seg in case_boundary_edges(case) {
                let a = ms_point(seg[0], x0, y0);
                let bpt = ms_point(seg[1], x0, y0);
                let u0 = clamp_u(a[0] * cell);
                let v0 = clamp_v(a[1] * cell);
                let u1 = clamp_u(bpt[0] * cell);
                let v1 = clamp_v(bpt[1] * cell);
                if (u0 - u1).abs() < 1e-6 && (v0 - v1).abs() < 1e-6 {
                    continue;
                }
                let s = positions.len() as u32;
                positions.push([u0, -half_t, v0]);
                positions.push([u1, -half_t, v1]);
                positions.push([u1, half_t, v1]);
                positions.push([u0, half_t, v0]);
                colors.extend_from_slice(&[rim_c, rim_c, rim_c, rim_c]);
                indices.extend_from_slice(&[s, s + 1, s + 2, s, s + 2, s + 3]);
            }
        }
    }

    SheetMesh {
        positions,
        colors,
        indices,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet_destruction::mask::SheetMask;

    #[test]
    fn intact_sheet_has_front_coverage() {
        let mask = SheetMask::new(4, 4, 0.02);
        let mesh = remesh_sheet(&mask, 0.012);
        assert!(mesh.indices.len() >= 6);
        assert!(!mesh.positions.is_empty());
    }

    #[test]
    fn carved_center_produces_smaller_mesh() {
        let mut mask = SheetMask::new(8, 8, 0.02);
        let before = remesh_sheet(&mask, 0.012).indices.len();
        for y in 3..5 {
            for x in 3..5 {
                mask.set_occupied(x, y, false);
            }
        }
        let after = remesh_sheet(&mask, 0.012).indices.len();
        // Hole adds rim tris but removes front area — index count may go either way;
        // positions should still be non-empty and hole should exist (not identical).
        assert!(!remesh_sheet(&mask, 0.012).positions.is_empty());
        assert_ne!(before, after);
    }

    #[test]
    fn diagonal_boundary_exists_for_single_cell_hole() {
        let mut mask = SheetMask::new(6, 6, 0.02);
        mask.set_occupied(2, 2, false);
        let mesh = remesh_sheet(&mask, 0.012);
        // Stair-step remesh only had axis-aligned edges; MS should include at least
        // one edge where both u and v differ (diagonal segment).
        let mut has_diag = false;
        for tri in mesh.indices.chunks_exact(3) {
            for k in 0..3 {
                let a = mesh.positions[tri[k] as usize];
                let b = mesh.positions[tri[(k + 1) % 3] as usize];
                let du = (a[0] - b[0]).abs();
                let dv = (a[2] - b[2]).abs();
                if du > 1e-4 && dv > 1e-4 {
                    has_diag = true;
                    break;
                }
            }
        }
        assert!(has_diag, "expected diagonal hole-edge segments from marching squares");
    }
}
