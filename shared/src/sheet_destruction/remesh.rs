//! Marching-squares remesh of dual outer/inner sheet masks into a thick solid
//! with tunnel sleeves (front + back + caps + lofted hole walls).

use super::mask::SheetMask;

#[derive(Clone, Debug, Default)]
pub struct SheetMesh {
    /// XYZ positions in sheet-local space (U, thickness-centered, V).
    /// Convention: X = u, Y = ±thickness/2, Z = v.
    pub positions: Vec<[f32; 3]>,
    /// RGB vertex colors in 0..1. Front faces stay bright; back/rim/pocket faces
    /// are darkened so holes read as openings.
    pub colors: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

#[inline]
fn solid(mask: &SheetMask, x: i32, y: i32) -> bool {
    mask.in_bounds(x, y) && mask.occupied(x as u16, y as u16)
}

#[inline]
fn ms_point(edge: u8, x0: f32, y0: f32) -> [f32; 2] {
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

fn case_polygons(case: u8) -> &'static [&'static [u8]] {
    match case {
        0 => &[],
        1 => &[&[0, 4, 7]],
        2 => &[&[4, 1, 5]],
        3 => &[&[0, 1, 5, 7]],
        4 => &[&[5, 2, 6]],
        5 => &[&[0, 4, 5, 2, 6, 7]],
        6 => &[&[4, 1, 2, 6]],
        7 => &[&[0, 1, 2, 6, 7]],
        8 => &[&[7, 6, 3]],
        9 => &[&[0, 4, 6, 3]],
        10 => &[&[4, 1, 5, 6, 3, 7]],
        11 => &[&[0, 1, 5, 6, 3]],
        12 => &[&[5, 2, 3, 7]],
        13 => &[&[0, 4, 5, 2, 3]],
        14 => &[&[4, 1, 2, 3, 7]],
        15 => &[&[0, 1, 2, 3]],
        _ => &[],
    }
}

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

fn ms_case(mask: &SheetMask, x: i32, y: i32) -> u8 {
    let c0 = solid(mask, x, y);
    let c1 = solid(mask, x + 1, y);
    let c2 = solid(mask, x + 1, y + 1);
    let c3 = solid(mask, x, y + 1);
    (c0 as u8) | ((c1 as u8) << 1) | ((c2 as u8) << 2) | ((c3 as u8) << 3)
}

struct MeshBuf {
    positions: Vec<[f32; 3]>,
    colors: Vec<[f32; 3]>,
    indices: Vec<u32>,
    u_max: f32,
    v_max: f32,
    cell: f32,
}

impl MeshBuf {
    fn clamp_u(&self, u: f32) -> f32 {
        u.clamp(0.0, self.u_max)
    }
    fn clamp_v(&self, v: f32) -> f32 {
        v.clamp(0.0, self.v_max)
    }

    fn ring_uvs(&self, ring: &[u8], x0: f32, y0: f32) -> Vec<[f32; 2]> {
        let mut uv: Vec<[f32; 2]> = ring
            .iter()
            .map(|&e| {
                let p = ms_point(e, x0, y0);
                [self.clamp_u(p[0] * self.cell), self.clamp_v(p[1] * self.cell)]
            })
            .collect();
        uv.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6);
        if uv.len() >= 3 {
            let first = uv[0];
            let last = *uv.last().unwrap();
            if (first[0] - last[0]).abs() < 1e-6 && (first[1] - last[1]).abs() < 1e-6 {
                uv.pop();
            }
        }
        uv
    }

    fn emit_surface(
        &mut self,
        mask: &SheetMask,
        y: f32,
        color: [f32; 3],
        // When true, emit with back-face winding (normal toward -thickness).
        flip: bool,
        // If set, only emit where `gate` is also solid (AND).
        gate: Option<&SheetMask>,
        // If true with gate, require gate empty instead (AND NOT).
        gate_not: bool,
    ) {
        let w = mask.width as i32;
        let h = mask.height as i32;
        for yj in -1..h {
            for xi in -1..w {
                let case = if let Some(g) = gate {
                    let mut bits = 0u8;
                    for (bit, (cx, cy)) in [(xi, yj), (xi + 1, yj), (xi + 1, yj + 1), (xi, yj + 1)]
                        .iter()
                        .enumerate()
                    {
                        let a = solid(mask, *cx, *cy);
                        let b = solid(g, *cx, *cy);
                        let ok = if gate_not { a && !b } else { a && b };
                        if ok {
                            bits |= 1 << bit;
                        }
                    }
                    bits
                } else {
                    ms_case(mask, xi, yj)
                };
                if case == 0 {
                    continue;
                }
                let x0 = xi as f32 + 0.5;
                let y0 = yj as f32 + 0.5;
                for ring in case_polygons(case) {
                    let uv = self.ring_uvs(ring, x0, y0);
                    if uv.len() < 3 {
                        continue;
                    }
                    let base = self.positions.len() as u32;
                    for p in &uv {
                        self.positions.push([p[0], y, p[1]]);
                        self.colors.push(color);
                    }
                    if flip {
                        for i in 1..uv.len() - 1 {
                            self.indices.extend_from_slice(&[
                                base,
                                base + i as u32 + 1,
                                base + i as u32,
                            ]);
                        }
                    } else {
                        for i in 1..uv.len() - 1 {
                            self.indices.extend_from_slice(&[
                                base,
                                base + i as u32,
                                base + i as u32 + 1,
                            ]);
                        }
                    }
                }
            }
        }
    }

    fn emit_boundary_sleeves(&mut self, mask: &SheetMask, y_a: f32, y_b: f32, color: [f32; 3]) {
        let w = mask.width as i32;
        let h = mask.height as i32;
        for yj in -1..h {
            for xi in -1..w {
                let case = ms_case(mask, xi, yj);
                if case == 0 || case == 15 {
                    continue;
                }
                let x0 = xi as f32 + 0.5;
                let y0 = yj as f32 + 0.5;
                for seg in case_boundary_edges(case) {
                    let a = ms_point(seg[0], x0, y0);
                    let bpt = ms_point(seg[1], x0, y0);
                    let u0 = self.clamp_u(a[0] * self.cell);
                    let v0 = self.clamp_v(a[1] * self.cell);
                    let u1 = self.clamp_u(bpt[0] * self.cell);
                    let v1 = self.clamp_v(bpt[1] * self.cell);
                    if (u0 - u1).abs() < 1e-6 && (v0 - v1).abs() < 1e-6 {
                        continue;
                    }
                    let s = self.positions.len() as u32;
                    self.positions.push([u0, y_a, v0]);
                    self.positions.push([u1, y_a, v1]);
                    self.positions.push([u1, y_b, v1]);
                    self.positions.push([u0, y_b, v0]);
                    self.colors.extend_from_slice(&[color, color, color, color]);
                    self.indices
                        .extend_from_slice(&[s, s + 1, s + 2, s, s + 2, s + 3]);
                }
            }
        }
    }
}

/// Single-mask convenience: identical outer/inner skins (aligned through-holes).
pub fn remesh_sheet(mask: &SheetMask, thickness: f32) -> SheetMesh {
    remesh_sheet_skins(mask, mask, thickness)
}

/// Thick solid from outer (entry) + inner (exit) masks with tunnel sleeves.
///
/// - Front surface from `outer` at +thickness/2
/// - Back surface from `inner` at -thickness/2
/// - Blind caps where only one skin is open
/// - Sleeve walls lofted along hole/perimeter boundaries
pub fn remesh_sheet_skins(outer: &SheetMask, inner: &SheetMask, thickness: f32) -> SheetMesh {
    assert_eq!(outer.width, inner.width);
    assert_eq!(outer.height, inner.height);
    let cell = outer.cell_size;
    if outer.width == 0 || outer.height == 0 {
        return SheetMesh::default();
    }

    let half_t = thickness * 0.5;
    let front_c = [1.0, 1.0, 1.0];
    let back_c = [0.22, 0.2, 0.18];
    let sleeve_c = [0.38, 0.34, 0.30];
    let pocket_c = [0.16, 0.14, 0.12];

    let mut buf = MeshBuf {
        positions: Vec::new(),
        colors: Vec::new(),
        indices: Vec::new(),
        u_max: outer.width as f32 * cell,
        v_max: outer.height as f32 * cell,
        cell,
    };

    // Exterior faces.
    buf.emit_surface(outer, half_t, front_c, false, None, false);
    buf.emit_surface(inner, -half_t, back_c, true, None, false);

    // Blind / step caps: floor of a front pocket, ceiling of a reverse pocket.
    // outer empty & inner solid → pocket floor at back depth, facing +Y.
    buf.emit_surface(inner, -half_t, pocket_c, false, Some(outer), true);
    // outer solid & inner empty → reverse pocket at front depth, facing -Y.
    buf.emit_surface(outer, half_t, pocket_c, true, Some(inner), true);

    // Tunnel sleeves along both skins' hole/perimeter boundaries.
    buf.emit_boundary_sleeves(outer, half_t, -half_t, sleeve_c);
    // Extra inner sleeves when exit hole differs (taper / offset); skip when identical
    // to avoid doubling coplanar sleeves.
    let identical = outer.occupancy_bytes() == inner.occupancy_bytes();
    if !identical {
        buf.emit_boundary_sleeves(inner, -half_t, half_t, sleeve_c);
    }

    SheetMesh {
        positions: buf.positions,
        colors: buf.colors,
        indices: buf.indices,
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

    #[test]
    fn intact_sheet_has_front_coverage() {
        let mask = SheetMask::new(4, 4, 0.02);
        let mesh = remesh_sheet(&mask, 0.12);
        assert!(mesh.indices.len() >= 6);
        assert!(!mesh.positions.is_empty());
    }

    #[test]
    fn carved_center_produces_smaller_mesh() {
        let mut mask = SheetMask::new(8, 8, 0.02);
        let before = remesh_sheet(&mask, 0.12).indices.len();
        for y in 3..5 {
            for x in 3..5 {
                mask.set_occupied(x, y, false);
            }
        }
        let after = remesh_sheet(&mask, 0.12).indices.len();
        assert!(!remesh_sheet(&mask, 0.12).positions.is_empty());
        assert_ne!(before, after);
    }

    #[test]
    fn diagonal_boundary_exists_for_single_cell_hole() {
        let mut mask = SheetMask::new(6, 6, 0.02);
        mask.set_occupied(2, 2, false);
        let mesh = remesh_sheet(&mask, 0.12);
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

    #[test]
    fn blind_hole_has_pocket_cap_not_through() {
        let mut outer = SheetMask::new(10, 10, 0.02);
        let inner = SheetMask::new(10, 10, 0.02);
        for y in 4..7 {
            for x in 4..7 {
                outer.set_occupied(x, y, false);
            }
        }
        let mesh = remesh_sheet_skins(&outer, &inner, 0.12);
        // Pocket floor verts sit at y = -half_t with the carved UV region still meshed.
        let half = 0.06;
        let mut pocket_verts = 0u32;
        for p in &mesh.positions {
            let in_crater = p[0] > 0.08 && p[0] < 0.14 && p[2] > 0.08 && p[2] < 0.14;
            if in_crater && (p[1] + half).abs() < 1e-4 {
                pocket_verts += 1;
            }
        }
        assert!(pocket_verts > 0, "blind hole should keep a back-depth pocket cap");
    }

    #[test]
    fn through_hole_has_full_thickness_sleeve() {
        let mut outer = SheetMask::new(10, 10, 0.02);
        let mut inner = SheetMask::new(10, 10, 0.02);
        for y in 4..7 {
            for x in 4..7 {
                outer.set_occupied(x, y, false);
                inner.set_occupied(x, y, false);
            }
        }
        let mesh = remesh_sheet_skins(&outer, &inner, 0.12);
        let mut sleeve_edges = 0u32;
        for tri in mesh.indices.chunks_exact(3) {
            for k in 0..3 {
                let a = mesh.positions[tri[k] as usize];
                let b = mesh.positions[tri[(k + 1) % 3] as usize];
                if (a[1] - b[1]).abs() > 0.1 {
                    sleeve_edges += 1;
                }
            }
        }
        assert!(sleeve_edges > 0, "through-hole should have thickness-spanning sleeve edges");
    }
}
