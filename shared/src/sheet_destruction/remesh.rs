//! High-performance remesh of dual outer/inner sheet masks.
//!
//! Strategy:
//! - Intact sheets → 12-triangle box (no grid walk)
//! - Damaged sheets → greedy quads for fully-solid dual-squares + marching-squares
//!   only on the hole/perimeter fringe (keeps diagonal ragged edges without
//!   meshing every interior cell)

use super::mask::SheetMask;

#[derive(Clone, Debug, Default)]
pub struct SheetMesh {
    /// XYZ in sheet-local space: X = u, Y = ±thickness/2, Z = v.
    pub positions: Vec<[f32; 3]>,
    pub colors: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

#[inline]
fn solid(mask: &SheetMask, x: i32, y: i32) -> bool {
    mask.in_bounds(x, y) && mask.occupied(x as u16, y as u16)
}

#[inline]
fn ms_case(mask: &SheetMask, x: i32, y: i32) -> u8 {
    let c0 = solid(mask, x, y);
    let c1 = solid(mask, x + 1, y);
    let c2 = solid(mask, x + 1, y + 1);
    let c3 = solid(mask, x, y + 1);
    (c0 as u8) | ((c1 as u8) << 1) | ((c2 as u8) << 2) | ((c3 as u8) << 3)
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

struct MeshBuf {
    positions: Vec<[f32; 3]>,
    colors: Vec<[f32; 3]>,
    indices: Vec<u32>,
    u_max: f32,
    v_max: f32,
    cell: f32,
}

impl MeshBuf {
    fn with_capacity(mask: &SheetMask, tris_hint: usize) -> Self {
        let cell = mask.cell_size;
        Self {
            positions: Vec::with_capacity(tris_hint * 2),
            colors: Vec::with_capacity(tris_hint * 2),
            indices: Vec::with_capacity(tris_hint * 3),
            u_max: mask.width as f32 * cell,
            v_max: mask.height as f32 * cell,
            cell,
        }
    }

    #[inline]
    fn clamp_u(&self, u: f32) -> f32 {
        u.clamp(0.0, self.u_max)
    }
    #[inline]
    fn clamp_v(&self, v: f32) -> f32 {
        v.clamp(0.0, self.v_max)
    }

    fn push_quad(
        &mut self,
        p0: [f32; 3],
        p1: [f32; 3],
        p2: [f32; 3],
        p3: [f32; 3],
        color: [f32; 3],
        flip: bool,
    ) {
        let base = self.positions.len() as u32;
        self.positions.extend_from_slice(&[p0, p1, p2, p3]);
        self.colors
            .extend_from_slice(&[color, color, color, color]);
        if flip {
            self.indices
                .extend_from_slice(&[base, base + 2, base + 1, base, base + 3, base + 2]);
        } else {
            self.indices
                .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }

    fn emit_box(&mut self, thickness: f32, front_c: [f32; 3], back_c: [f32; 3], sleeve_c: [f32; 3]) {
        let half = thickness * 0.5;
        let u1 = self.u_max;
        let v1 = self.v_max;
        // Front
        self.push_quad(
            [0.0, half, 0.0],
            [u1, half, 0.0],
            [u1, half, v1],
            [0.0, half, v1],
            front_c,
            false,
        );
        // Back
        self.push_quad(
            [0.0, -half, 0.0],
            [0.0, -half, v1],
            [u1, -half, v1],
            [u1, -half, 0.0],
            back_c,
            false,
        );
        // Four perimeter sleeves
        self.push_quad(
            [0.0, -half, 0.0],
            [u1, -half, 0.0],
            [u1, half, 0.0],
            [0.0, half, 0.0],
            sleeve_c,
            false,
        );
        self.push_quad(
            [u1, -half, 0.0],
            [u1, -half, v1],
            [u1, half, v1],
            [u1, half, 0.0],
            sleeve_c,
            false,
        );
        self.push_quad(
            [u1, -half, v1],
            [0.0, -half, v1],
            [0.0, half, v1],
            [u1, half, v1],
            sleeve_c,
            false,
        );
        self.push_quad(
            [0.0, -half, v1],
            [0.0, -half, 0.0],
            [0.0, half, 0.0],
            [0.0, half, v1],
            sleeve_c,
            false,
        );
    }

    /// Greedy-mesh dual-squares that are fully solid (case 15). Coordinates are
    /// dual-square indices in `0..w-1` × `0..h-1` covering cell centers.
    fn emit_greedy_full_squares(
        &mut self,
        full: &[bool],
        dual_w: usize,
        dual_h: usize,
        y: f32,
        color: [f32; 3],
        flip: bool,
    ) {
        if dual_w == 0 || dual_h == 0 {
            return;
        }
        let mut visited = vec![false; full.len()];
        for y0 in 0..dual_h {
            let mut x0 = 0usize;
            while x0 < dual_w {
                let idx = y0 * dual_w + x0;
                if !full[idx] || visited[idx] {
                    x0 += 1;
                    continue;
                }
                // Widen in X.
                let mut x1 = x0 + 1;
                while x1 < dual_w {
                    let i = y0 * dual_w + x1;
                    if !full[i] || visited[i] {
                        break;
                    }
                    x1 += 1;
                }
                // Grow in Y while the whole row span stays full.
                let mut y1 = y0 + 1;
                'grow: while y1 < dual_h {
                    for x in x0..x1 {
                        let i = y1 * dual_w + x;
                        if !full[i] || visited[i] {
                            break 'grow;
                        }
                    }
                    y1 += 1;
                }
                for y in y0..y1 {
                    for x in x0..x1 {
                        visited[y * dual_w + x] = true;
                    }
                }
                // Dual square (x,y) covers cell-centers from (x+0.5) to (x+1.5).
                let u0 = self.clamp_u((x0 as f32 + 0.5) * self.cell);
                let u1 = self.clamp_u((x1 as f32 + 0.5) * self.cell);
                let v0 = self.clamp_v((y0 as f32 + 0.5) * self.cell);
                let v1 = self.clamp_v((y1 as f32 + 0.5) * self.cell);
                if (u1 - u0).abs() < 1e-6 || (v1 - v0).abs() < 1e-6 {
                    x0 = x1;
                    continue;
                }
                self.push_quad(
                    [u0, y, v0],
                    [u1, y, v0],
                    [u1, y, v1],
                    [u0, y, v1],
                    color,
                    flip,
                );
                x0 = x1;
            }
        }
    }

    fn emit_ms_partial_and_sleeves(
        &mut self,
        mask: &SheetMask,
        y_face: f32,
        y_sleeve_other: f32,
        face_color: [f32; 3],
        sleeve_color: [f32; 3],
        flip_face: bool,
        emit_sleeves: bool,
        // Optional AND-NOT gate for pocket caps (mask solid && gate empty).
        gate_not: Option<&SheetMask>,
    ) {
        let w = mask.width as i32;
        let h = mask.height as i32;
        for yj in -1..h {
            for xi in -1..w {
                let case = if let Some(g) = gate_not {
                    let mut bits = 0u8;
                    for (bit, (cx, cy)) in
                        [(xi, yj), (xi + 1, yj), (xi + 1, yj + 1), (xi, yj + 1)]
                            .into_iter()
                            .enumerate()
                    {
                        if solid(mask, cx, cy) && !solid(g, cx, cy) {
                            bits |= 1 << bit;
                        }
                    }
                    bits
                } else {
                    ms_case(mask, xi, yj)
                };
                // Full squares are handled by greedy; empty skipped.
                if case == 0 || (gate_not.is_none() && case == 15) {
                    continue;
                }
                let x0 = xi as f32 + 0.5;
                let y0 = yj as f32 + 0.5;

                for ring in case_polygons(case) {
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
                    if uv.len() < 3 {
                        continue;
                    }
                    let base = self.positions.len() as u32;
                    for p in &uv {
                        self.positions.push([p[0], y_face, p[1]]);
                        self.colors.push(face_color);
                    }
                    if flip_face {
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

                if emit_sleeves {
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
                        self.push_quad(
                            [u0, y_face, v0],
                            [u1, y_face, v1],
                            [u1, y_sleeve_other, v1],
                            [u0, y_sleeve_other, v0],
                            sleeve_color,
                            false,
                        );
                    }
                }
            }
        }
    }
}

fn build_full_square_mask(mask: &SheetMask) -> (Vec<bool>, usize, usize) {
    let w = mask.width as i32;
    let h = mask.height as i32;
    // Dual squares between cell centers: (w-1) x (h-1) when w,h >= 1.
    let dual_w = (w - 1).max(0) as usize;
    let dual_h = (h - 1).max(0) as usize;
    let mut full = vec![false; dual_w * dual_h];
    for y in 0..dual_h {
        for x in 0..dual_w {
            if ms_case(mask, x as i32, y as i32) == 15 {
                full[y * dual_w + x] = true;
            }
        }
    }
    (full, dual_w, dual_h)
}

fn masks_identical(a: &SheetMask, b: &SheetMask) -> bool {
    std::ptr::eq(a, b) || a.occupancy_bytes() == b.occupancy_bytes()
}

fn is_fully_solid(mask: &SheetMask) -> bool {
    mask.is_fully_solid()
}

/// Single-mask convenience.
pub fn remesh_sheet(mask: &SheetMask, thickness: f32) -> SheetMesh {
    remesh_sheet_skins(mask, mask, thickness)
}

/// Thick solid from outer + inner masks with tunnel sleeves (optimized).
pub fn remesh_sheet_skins(outer: &SheetMask, inner: &SheetMask, thickness: f32) -> SheetMesh {
    debug_assert_eq!(outer.width, inner.width);
    debug_assert_eq!(outer.height, inner.height);
    if outer.width == 0 || outer.height == 0 {
        return SheetMesh::default();
    }

    let front_c = [1.0, 1.0, 1.0];
    let back_c = [0.22, 0.2, 0.18];
    let sleeve_c = [0.38, 0.34, 0.30];
    let pocket_c = [0.16, 0.14, 0.12];
    let half_t = thickness * 0.5;

    let mut buf = MeshBuf::with_capacity(outer, 64);

    // Fast path: untouched wall → 6 quads.
    if is_fully_solid(outer) && is_fully_solid(inner) {
        buf.emit_box(thickness, front_c, back_c, sleeve_c);
        return SheetMesh {
            positions: buf.positions,
            colors: buf.colors,
            indices: buf.indices,
        };
    }

    // Front: greedy interior + MS fringe.
    let (full_o, dw, dh) = build_full_square_mask(outer);
    buf.emit_greedy_full_squares(&full_o, dw, dh, half_t, front_c, false);
    buf.emit_ms_partial_and_sleeves(
        outer,
        half_t,
        -half_t,
        front_c,
        sleeve_c,
        false,
        true,
        None,
    );

    // Back.
    if masks_identical(outer, inner) {
        // Reuse dual mask; flip to back.
        buf.emit_greedy_full_squares(&full_o, dw, dh, -half_t, back_c, true);
        // Sleeves already emitted from outer; only add back fringe faces (no sleeves).
        buf.emit_ms_partial_and_sleeves(
            inner,
            -half_t,
            half_t,
            back_c,
            sleeve_c,
            true,
            false,
            None,
        );
    } else {
        let (full_i, dw_i, dh_i) = build_full_square_mask(inner);
        buf.emit_greedy_full_squares(&full_i, dw_i, dh_i, -half_t, back_c, true);
        buf.emit_ms_partial_and_sleeves(
            inner,
            -half_t,
            half_t,
            back_c,
            sleeve_c,
            true,
            true,
            None,
        );
        // Blind / step caps (usually small regions).
        buf.emit_ms_partial_and_sleeves(
            inner,
            -half_t,
            half_t,
            pocket_c,
            sleeve_c,
            false,
            false,
            Some(outer),
        );
        buf.emit_ms_partial_and_sleeves(
            outer,
            half_t,
            -half_t,
            pocket_c,
            sleeve_c,
            true,
            false,
            Some(inner),
        );
    }

    SheetMesh {
        positions: buf.positions,
        colors: buf.colors,
        indices: buf.indices,
    }
}

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
    fn intact_sheet_is_tiny_box() {
        let mask = SheetMask::new(200, 140, 0.02);
        let mesh = remesh_sheet(&mask, 0.16);
        // 6 quads → 24 verts, 36 indices.
        assert_eq!(mesh.positions.len(), 24);
        assert_eq!(mesh.indices.len(), 36);
    }

    #[test]
    fn damaged_sheet_far_fewer_tris_than_per_cell() {
        let mut mask = SheetMask::new(80, 60, 0.02);
        for y in 20..30 {
            for x in 30..40 {
                mask.set_occupied(x, y, false);
            }
        }
        let mesh = remesh_sheet(&mask, 0.16);
        // Naive per-cell would be O(width*height*12) indices. We should be << 50k.
        assert!(mesh.indices.len() < 20_000, "indices={}", mesh.indices.len());
        assert!(!mesh.positions.is_empty());
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
        assert!(has_diag);
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
        assert!(sleeve_edges > 0);
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
        let half = 0.06;
        let mut pocket_verts = 0u32;
        for p in &mesh.positions {
            let in_crater = p[0] > 0.08 && p[0] < 0.14 && p[2] > 0.08 && p[2] < 0.14;
            if in_crater && (p[1] + half).abs() < 1e-4 {
                pocket_verts += 1;
            }
        }
        assert!(pocket_verts > 0);
    }
}
