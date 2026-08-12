//! Coarse collision for destructible sheets.
//!
//! Fine visual masks stay high-res. Collision uses a coarse through-empty grid,
//! a usefulness scalar U, and rare greedy AABB rebuilds — not per-shot trimeshes.
//!
//! Feature flag: `SHEET_COARSE_COLLISION` (default **on**; set `0`/`false`/`off` to disable).

use std::sync::OnceLock;

use super::mask::SheetMask;
use super::registry::SheetUvFrame;

/// Coarse cell size in meters (wall-plane).
pub const COARSE_CELL_M: f32 = 0.30;
/// Rebuild when usefulness or remainder changes by this relative fraction.
pub const USEFULNESS_REBUILD_ALPHA: f32 = 0.20;
/// Fine-cell occupancy below this (both skins) ⇒ coarse cell is through-open.
const THROUGH_OPEN_OCCUPANCY: f32 = 0.45;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CoarseCollisionSnapshot {
    pub usefulness: f32,
    pub remainder: f32,
    pub hole_count: u32,
    pub border_hole_count: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct OrientedWorldCuboid {
    pub center: [f32; 3],
    /// Half-extents in sheet local frame: (U, thickness, V).
    pub half_extents: [f32; 3],
    /// Quaternion xyzw mapping local (+X,+Y,+Z) → (axis_u, axis_thickness, axis_v).
    pub rotation_xyzw: [f32; 4],
}

pub fn sheet_coarse_collision_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        #[cfg(target_arch = "wasm32")]
        {
            // Practice / client WASM: on unless explicitly disabled via a
            // compile-time override is not available — default enabled for preview.
            true
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            match std::env::var("SHEET_COARSE_COLLISION") {
                Ok(v) => {
                    let v = v.trim().to_ascii_lowercase();
                    !matches!(v.as_str(), "0" | "false" | "off" | "no")
                }
                Err(_) => true,
            }
        }
    })
}

fn occupancy_in_rect(mask: &SheetMask, u0: f32, v0: f32, u1: f32, v1: f32) -> f32 {
    let cell = mask.cell_size;
    if cell <= 0.0 || mask.width == 0 || mask.height == 0 {
        return 0.0;
    }
    let x0 = ((u0 / cell).floor() as i32).clamp(0, mask.width as i32 - 1) as u16;
    let y0 = ((v0 / cell).floor() as i32).clamp(0, mask.height as i32 - 1) as u16;
    let x1 = (((u1 / cell).ceil() as i32) - 1).clamp(0, mask.width as i32 - 1) as u16;
    let y1 = (((v1 / cell).ceil() as i32) - 1).clamp(0, mask.height as i32 - 1) as u16;
    if x1 < x0 || y1 < y0 {
        return 0.0;
    }
    let mut solid = 0u32;
    let mut total = 0u32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            total += 1;
            if mask.occupied(x, y) {
                solid += 1;
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        solid as f32 / total as f32
    }
}

struct CoarseGrid {
    w: usize,
    h: usize,
    cell: f32,
    /// true = collision solid (blocks traversal).
    solid: Vec<bool>,
    /// true = through-open (both skins mostly empty).
    open: Vec<bool>,
}

fn build_coarse_grid(outer: &SheetMask, inner: &SheetMask, frame: &SheetUvFrame) -> CoarseGrid {
    let cell = COARSE_CELL_M;
    let w = ((frame.size_u / cell).ceil() as usize).max(1);
    let h = ((frame.size_v / cell).ceil() as usize).max(1);
    let mut solid = vec![false; w * h];
    let mut open = vec![false; w * h];
    for cy in 0..h {
        for cx in 0..w {
            let u0 = cx as f32 * cell;
            let v0 = cy as f32 * cell;
            let u1 = ((cx + 1) as f32 * cell).min(frame.size_u);
            let v1 = ((cy + 1) as f32 * cell).min(frame.size_v);
            let o = occupancy_in_rect(outer, u0, v0, u1, v1);
            let i = occupancy_in_rect(inner, u0, v0, u1, v1);
            let is_open = o < THROUGH_OPEN_OCCUPANCY && i < THROUGH_OPEN_OCCUPANCY;
            open[cy * w + cx] = is_open;
            solid[cy * w + cx] = !is_open;
        }
    }
    CoarseGrid {
        w,
        h,
        cell,
        solid,
        open,
    }
}

fn hole_metrics(grid: &CoarseGrid) -> (f32, u32, u32) {
    let n = grid.w * grid.h;
    let mut visited = vec![false; n];
    let mut stack = Vec::new();
    let mut usefulness = 0.0_f32;
    let mut hole_count = 0u32;
    let mut border_hole_count = 0u32;
    let cell_area = grid.cell * grid.cell;

    for y0 in 0..grid.h {
        for x0 in 0..grid.w {
            let start = y0 * grid.w + x0;
            if visited[start] || !grid.open[start] {
                continue;
            }
            stack.clear();
            stack.push((x0, y0));
            visited[start] = true;
            let mut min_x = x0;
            let mut max_x = x0;
            let mut min_y = y0;
            let mut max_y = y0;
            let mut cells = 0u32;
            let mut touches_border = false;

            while let Some((x, y)) = stack.pop() {
                cells += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                if x == 0 || y == 0 || x + 1 == grid.w || y + 1 == grid.h {
                    touches_border = true;
                }
                for (nx, ny) in [
                    (x as i32 - 1, y as i32),
                    (x as i32 + 1, y as i32),
                    (x as i32, y as i32 - 1),
                    (x as i32, y as i32 + 1),
                ] {
                    if nx < 0 || ny < 0 || nx >= grid.w as i32 || ny >= grid.h as i32 {
                        continue;
                    }
                    let ux = nx as usize;
                    let uy = ny as usize;
                    let idx = uy * grid.w + ux;
                    if visited[idx] || !grid.open[idx] {
                        continue;
                    }
                    visited[idx] = true;
                    stack.push((ux, uy));
                }
            }

            hole_count += 1;
            if touches_border {
                border_hole_count += 1;
            }
            let area = cells as f32 * cell_area;
            let bw = (max_x + 1 - min_x) as f32 * grid.cell;
            let bh = (max_y + 1 - min_y) as f32 * grid.cell;
            let aspect = if bw.max(bh) > 1e-6 {
                bw.min(bh) / bw.max(bh)
            } else {
                0.0
            };
            usefulness += area * aspect;
        }
    }
    (usefulness, hole_count, border_hole_count)
}

pub fn compute_collision_snapshot(
    outer: &SheetMask,
    inner: &SheetMask,
    frame: &SheetUvFrame,
) -> CoarseCollisionSnapshot {
    let grid = build_coarse_grid(outer, inner, frame);
    let solid_count = grid.solid.iter().filter(|s| **s).count();
    let total = grid.solid.len().max(1);
    let remainder = solid_count as f32 / total as f32;
    let (usefulness, hole_count, border_hole_count) = hole_metrics(&grid);
    CoarseCollisionSnapshot {
        usefulness,
        remainder,
        hole_count,
        border_hole_count,
    }
}

pub fn should_rebuild_collision(
    prev: &CoarseCollisionSnapshot,
    next: &CoarseCollisionSnapshot,
) -> bool {
    let cell_area = COARSE_CELL_M * COARSE_CELL_M;
    let u_scale = prev.usefulness.max(next.usefulness).max(cell_area);
    let u_rel = (next.usefulness - prev.usefulness).abs() / u_scale;
    let r_scale = prev.remainder.max(next.remainder).max(1e-3);
    let r_rel = (next.remainder - prev.remainder).abs() / r_scale;
    let topo = next.hole_count != prev.hole_count
        || next.border_hole_count != prev.border_hole_count;
    u_rel >= USEFULNESS_REBUILD_ALPHA || r_rel >= USEFULNESS_REBUILD_ALPHA || topo
}

fn frame_rotation_xyzw(frame: &SheetUvFrame) -> [f32; 4] {
    use nalgebra::{Matrix3, UnitQuaternion, Vector3};
    let u = Vector3::new(frame.axis_u[0], frame.axis_u[1], frame.axis_u[2]);
    let t = Vector3::new(
        frame.axis_thickness[0],
        frame.axis_thickness[1],
        frame.axis_thickness[2],
    );
    // Orthonormalize lightly in case of float drift.
    let u = u.normalize();
    let t = (t - u * t.dot(&u)).normalize();
    let v = u.cross(&t).normalize();
    let m = Matrix3::from_columns(&[u, t, v]);
    let q = UnitQuaternion::from_matrix(&m);
    [q.i, q.j, q.k, q.w]
}

/// Greedy-merge solid coarse cells into oriented world cuboids.
pub fn build_greedy_collision_cuboids(
    outer: &SheetMask,
    inner: &SheetMask,
    frame: &SheetUvFrame,
) -> Vec<OrientedWorldCuboid> {
    let grid = build_coarse_grid(outer, inner, frame);
    if grid.solid.iter().all(|s| !*s) {
        return Vec::new();
    }
    let rot = frame_rotation_xyzw(frame);
    let half_t = frame.thickness * 0.5;
    let mut visited = vec![false; grid.solid.len()];
    let mut out = Vec::new();

    for y0 in 0..grid.h {
        let mut x0 = 0usize;
        while x0 < grid.w {
            let idx = y0 * grid.w + x0;
            if !grid.solid[idx] || visited[idx] {
                x0 += 1;
                continue;
            }
            let mut x1 = x0 + 1;
            while x1 < grid.w {
                let i = y0 * grid.w + x1;
                if !grid.solid[i] || visited[i] {
                    break;
                }
                x1 += 1;
            }
            let mut y1 = y0 + 1;
            'grow: while y1 < grid.h {
                for x in x0..x1 {
                    let i = y1 * grid.w + x;
                    if !grid.solid[i] || visited[i] {
                        break 'grow;
                    }
                }
                y1 += 1;
            }
            for y in y0..y1 {
                for x in x0..x1 {
                    visited[y * grid.w + x] = true;
                }
            }

            let u0 = x0 as f32 * grid.cell;
            let u1 = (x1 as f32 * grid.cell).min(frame.size_u);
            let v0 = y0 as f32 * grid.cell;
            let v1 = (y1 as f32 * grid.cell).min(frame.size_v);
            if u1 - u0 < 1e-4 || v1 - v0 < 1e-4 {
                x0 = x1;
                continue;
            }
            let cu = (u0 + u1) * 0.5;
            let cv = (v0 + v1) * 0.5;
            let center = [
                frame.origin[0] + frame.axis_u[0] * cu + frame.axis_v[0] * cv,
                frame.origin[1] + frame.axis_u[1] * cu + frame.axis_v[1] * cv,
                frame.origin[2] + frame.axis_u[2] * cu + frame.axis_v[2] * cv,
            ];
            out.push(OrientedWorldCuboid {
                center,
                half_extents: [(u1 - u0) * 0.5, half_t, (v1 - v0) * 0.5],
                rotation_xyzw: rot,
            });
            x0 = x1;
        }
    }
    out
}

/// Evaluate whether collision should rebuild; if so, return cuboids and commit snapshot.
pub fn take_collision_rebuild(
    outer: &SheetMask,
    inner: &SheetMask,
    frame: &SheetUvFrame,
    prev: &mut Option<CoarseCollisionSnapshot>,
) -> Option<Vec<OrientedWorldCuboid>> {
    if !sheet_coarse_collision_enabled() {
        return None;
    }
    let next = compute_collision_snapshot(outer, inner, frame);
    let rebuild = match prev {
        None => {
            // First evaluation after damage: only rebuild once usefulness or
            // remainder actually moved off the pristine wall.
            next.usefulness > COARSE_CELL_M * COARSE_CELL_M * 0.5 || next.remainder < 0.999
        }
        Some(p) => should_rebuild_collision(p, &next),
    };
    if !rebuild {
        return None;
    }
    let boxes = build_greedy_collision_cuboids(outer, inner, frame);
    *prev = Some(next);
    Some(boxes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet_destruction::mask::SheetMask;
    use crate::sheet_destruction::registry::SheetUvFrame;

    fn frame(size_u: f32, size_v: f32, thickness: f32) -> SheetUvFrame {
        SheetUvFrame {
            origin: [0.0, 0.0, 0.0],
            axis_u: [1.0, 0.0, 0.0],
            axis_v: [0.0, 0.0, 1.0],
            axis_thickness: [0.0, 1.0, 0.0],
            size_u,
            size_v,
            thickness,
        }
    }

    fn solid_masks(fu: f32, fv: f32, cell: f32) -> (SheetMask, SheetMask) {
        let w = ((fu / cell).round() as u16).max(1);
        let h = ((fv / cell).round() as u16).max(1);
        (SheetMask::new(w, h, cell), SheetMask::new(w, h, cell))
    }

    #[test]
    fn pristine_wall_has_zero_usefulness() {
        let f = frame(4.0, 2.8, 0.16);
        let (o, i) = solid_masks(4.0, 2.8, 0.02);
        let snap = compute_collision_snapshot(&o, &i, &f);
        assert_eq!(snap.hole_count, 0);
        assert!(snap.usefulness < 1e-4);
        assert!(snap.remainder > 0.99);
    }

    #[test]
    fn doorway_increases_usefulness_and_builds_few_boxes() {
        let f = frame(4.0, 2.8, 0.16);
        let (mut o, mut i) = solid_masks(4.0, 2.8, 0.02);
        // Cut a through doorway in the middle.
        for y in 20..100 {
            for x in 60..140 {
                o.set_occupied(x, y, false);
                i.set_occupied(x, y, false);
            }
        }
        let snap = compute_collision_snapshot(&o, &i, &f);
        assert!(snap.hole_count >= 1);
        assert!(snap.usefulness > 0.5);
        let boxes = build_greedy_collision_cuboids(&o, &i, &f);
        assert!(!boxes.is_empty());
        assert!(boxes.len() <= 16, "greedy should keep box count low, got {}", boxes.len());
    }

    #[test]
    fn small_u_change_does_not_rebuild() {
        let prev = CoarseCollisionSnapshot {
            usefulness: 1.0,
            remainder: 0.7,
            hole_count: 1,
            border_hole_count: 0,
        };
        let next = CoarseCollisionSnapshot {
            usefulness: 1.05,
            remainder: 0.69,
            hole_count: 1,
            border_hole_count: 0,
        };
        assert!(!should_rebuild_collision(&prev, &next));
    }

    #[test]
    fn large_u_change_rebuilds() {
        let prev = CoarseCollisionSnapshot {
            usefulness: 1.0,
            remainder: 0.7,
            hole_count: 1,
            border_hole_count: 0,
        };
        let next = CoarseCollisionSnapshot {
            usefulness: 1.3,
            remainder: 0.65,
            hole_count: 1,
            border_hole_count: 0,
        };
        assert!(should_rebuild_collision(&prev, &next));
    }

    #[test]
    fn hole_merge_topology_rebuilds() {
        let prev = CoarseCollisionSnapshot {
            usefulness: 1.0,
            remainder: 0.7,
            hole_count: 2,
            border_hole_count: 0,
        };
        let next = CoarseCollisionSnapshot {
            usefulness: 1.02,
            remainder: 0.7,
            hole_count: 1,
            border_hole_count: 0,
        };
        assert!(should_rebuild_collision(&prev, &next));
    }

    #[test]
    fn take_rebuild_skips_tiny_freckle_then_fires_on_doorway() {
        let f = frame(4.0, 2.8, 0.16);
        let (mut o, mut i) = solid_masks(4.0, 2.8, 0.02);
        // Tiny freckle — should not open a coarse cell enough to rebuild.
        o.set_occupied(100, 70, false);
        i.set_occupied(100, 70, false);
        let mut snap = None;
        assert!(take_collision_rebuild(&o, &i, &f, &mut snap).is_none());
        assert!(snap.is_none());

        for y in 0..100 {
            for x in 60..140 {
                o.set_occupied(x, y, false);
                i.set_occupied(x, y, false);
            }
        }
        let boxes = take_collision_rebuild(&o, &i, &f, &mut snap).expect("doorway rebuild");
        assert!(!boxes.is_empty());
        assert!(snap.is_some());
    }
}
