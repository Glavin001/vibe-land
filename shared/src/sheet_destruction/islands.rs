//! Flood-fill island culling for thin sheets.
//!
//! Dual-skin walls cull **coupled**: if a patch falls off the outer skin, the
//! inner skin at those UVs falls too (and vice versa). Otherwise cutting free
//! the front leaves a suspended "back cap" that reads as a floating island.

use super::materials::SheetMaterial;
use super::mask::SheetMask;

#[inline]
fn is_perimeter(x: u16, y: u16, w: u16, h: u16) -> bool {
    x == 0 || y == 0 || x + 1 == w || y + 1 == h
}

struct Island {
    cells: Vec<(u16, u16)>,
    anchored: bool,
    area: f32,
}

/// Remove unsupported / undersized components on one mask. Returns cleared cells.
pub fn cull_sheet_islands(mask: &mut SheetMask, mat: &SheetMaterial) -> u32 {
    let cleared = collect_islands_to_drop(mask, mat);
    let n = cleared.len() as u32;
    for (x, y) in cleared {
        mask.set_occupied(x, y, false);
    }
    n
}

fn collect_islands_to_drop(mask: &SheetMask, mat: &SheetMaterial) -> Vec<(u16, u16)> {
    let w = mask.width;
    let h = mask.height;
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let cell_area = mask.cell_size * mask.cell_size;
    let n = mask.cell_count();
    let mut visited = vec![false; n];
    let mut stack: Vec<(u16, u16)> = Vec::new();
    let mut islands: Vec<Island> = Vec::new();

    for y0 in 0..h {
        for x0 in 0..w {
            let start = y0 as usize * w as usize + x0 as usize;
            if visited[start] || !mask.occupied(x0, y0) {
                continue;
            }

            let mut cells: Vec<(u16, u16)> = Vec::new();
            stack.clear();
            stack.push((x0, y0));
            visited[start] = true;
            let mut anchored = false;

            while let Some((x, y)) = stack.pop() {
                cells.push((x, y));
                if is_perimeter(x, y, w, h) {
                    anchored = true;
                }
                let neighbors = [
                    (x as i32 - 1, y as i32),
                    (x as i32 + 1, y as i32),
                    (x as i32, y as i32 - 1),
                    (x as i32, y as i32 + 1),
                ];
                for (nx, ny) in neighbors {
                    if !mask.in_bounds(nx, ny) {
                        continue;
                    }
                    let ux = nx as u16;
                    let uy = ny as u16;
                    let idx = uy as usize * w as usize + ux as usize;
                    if visited[idx] || !mask.occupied(ux, uy) {
                        continue;
                    }
                    visited[idx] = true;
                    stack.push((ux, uy));
                }
            }

            let area = cells.len() as f32 * cell_area;
            islands.push(Island {
                cells,
                anchored,
                area,
            });
        }
    }

    let max_anchored_area = islands
        .iter()
        .filter(|i| i.anchored)
        .map(|i| i.area)
        .fold(0.0_f32, f32::max);

    let mut to_clear = Vec::new();
    for island in &islands {
        let drop = if !island.anchored {
            true
        } else {
            island.area < mat.min_island_area && island.area + 1e-6 < max_anchored_area
        };
        if drop {
            to_clear.extend_from_slice(&island.cells);
        }
    }
    to_clear
}

/// Cull islands on both skins, propagating drops so a fallen front patch also
/// clears the back (and vice versa). Iterates until stable.
pub fn cull_dual_skin_islands(
    outer: &mut SheetMask,
    inner: &mut SheetMask,
    mat: &SheetMaterial,
) -> u32 {
    let mut total = 0u32;
    // A few passes cover cascade: clearing the other skin can free new islands.
    for _ in 0..4 {
        let mut pass = 0u32;

        let drop_outer = collect_islands_to_drop(outer, mat);
        for &(x, y) in &drop_outer {
            if outer.occupied(x, y) {
                outer.set_occupied(x, y, false);
                pass += 1;
            }
            if inner.occupied(x, y) {
                inner.set_occupied(x, y, false);
                pass += 1;
            }
        }

        let drop_inner = collect_islands_to_drop(inner, mat);
        for &(x, y) in &drop_inner {
            if inner.occupied(x, y) {
                inner.set_occupied(x, y, false);
                pass += 1;
            }
            if outer.occupied(x, y) {
                outer.set_occupied(x, y, false);
                pass += 1;
            }
        }

        total += pass;
        if pass == 0 {
            break;
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet_destruction::materials::{lookup_sheet_material, SheetMaterialId};

    #[test]
    fn unsupported_middle_island_is_removed() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(20, 20, mat.cell_size);
        for y in 6..14 {
            for x in 6..14 {
                let on_ring = x == 6 || x == 13 || y == 6 || y == 13;
                if on_ring {
                    mask.set_occupied(x, y, false);
                }
            }
        }
        assert!(mask.occupied(10, 10));
        let cleared = cull_sheet_islands(&mut mask, mat);
        assert!(cleared > 0);
        assert!(!mask.occupied(10, 10));
        assert!(mask.occupied(0, 0));
        assert!(mask.occupied(19, 19));
    }

    #[test]
    fn perimeter_connected_sheet_is_kept() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(16, 16, mat.cell_size);
        for y in 6..10 {
            for x in 6..10 {
                mask.set_occupied(x, y, false);
            }
        }
        let before = mask.occupancy_count();
        let cleared = cull_sheet_islands(&mut mask, mat);
        assert_eq!(cleared, 0);
        assert_eq!(mask.occupancy_count(), before);
    }

    #[test]
    fn tiny_anchored_crumb_is_removed_when_main_body_remains() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(80, 80, mat.cell_size);
        for y in 0..80 {
            for x in 0..80 {
                let in_crumb = x < 2 && y < 2;
                let in_main = x >= 4;
                mask.set_occupied(x, y, in_crumb || in_main);
            }
        }
        assert!(mask.occupied(0, 0));
        assert!(mask.occupied(40, 40));
        let cleared = cull_sheet_islands(&mut mask, mat);
        assert!(cleared >= 4);
        assert!(!mask.occupied(0, 0));
        assert!(mask.occupied(40, 40));
    }

    #[test]
    fn small_sheet_alone_is_not_wiped() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(10, 10, mat.cell_size);
        let before = mask.occupancy_count();
        let cleared = cull_sheet_islands(&mut mask, mat);
        assert_eq!(cleared, 0);
        assert_eq!(mask.occupancy_count(), before);
    }

    #[test]
    fn outer_island_drop_clears_inner_cap() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut outer = SheetMask::new(20, 20, mat.cell_size);
        let mut inner = SheetMask::new(20, 20, mat.cell_size);
        // Ring-cut only the outer skin — classic "front falls, back remains" bug.
        for y in 6..14 {
            for x in 6..14 {
                let on_ring = x == 6 || x == 13 || y == 6 || y == 13;
                if on_ring {
                    outer.set_occupied(x, y, false);
                }
            }
        }
        assert!(outer.occupied(10, 10));
        assert!(inner.occupied(10, 10));
        let cleared = cull_dual_skin_islands(&mut outer, &mut inner, mat);
        assert!(cleared > 0);
        assert!(!outer.occupied(10, 10), "outer island should drop");
        assert!(
            !inner.occupied(10, 10),
            "inner cap under a fallen outer island must drop too"
        );
        assert!(outer.occupied(0, 0));
        assert!(inner.occupied(0, 0));
    }
}
