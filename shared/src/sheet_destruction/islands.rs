//! Flood-fill island culling for thin sheets.
//!
//! After a carve, any occupied component that is not anchored to the sheet
//! perimeter is cleared — the "cut around a patch and the middle drops" behavior.
//! Tiny perimeter-anchored crumbs smaller than `min_island_area` are also cleared
//! when a larger anchored piece still remains.

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

/// Remove unsupported / undersized connected components. Returns cells cleared.
pub fn cull_sheet_islands(mask: &mut SheetMask, mat: &SheetMaterial) -> u32 {
    let w = mask.width;
    let h = mask.height;
    if w == 0 || h == 0 {
        return 0;
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
                // 4-connected: diagonal-only contact is not enough to hold.
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

    let mut cleared = 0u32;
    for island in &islands {
        let drop = if !island.anchored {
            // Cut free of the frame — always falls away.
            true
        } else {
            // Anchored crumb: only drop when a larger anchored body remains,
            // so small authored sheets aren't wiped on first hit.
            island.area < mat.min_island_area && island.area + 1e-6 < max_anchored_area
        };
        if !drop {
            continue;
        }
        for (x, y) in &island.cells {
            mask.set_occupied(*x, *y, false);
            cleared += 1;
        }
    }

    cleared
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet_destruction::materials::{lookup_sheet_material, SheetMaterialId};

    #[test]
    fn unsupported_middle_island_is_removed() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(20, 20, mat.cell_size);
        // Carve a ring so the center 4x4 is disconnected from the perimeter.
        for y in 6..14 {
            for x in 6..14 {
                let on_ring = x == 6 || x == 13 || y == 6 || y == 13;
                if on_ring {
                    mask.set_occupied(x, y, false);
                }
            }
        }
        // Center should still be occupied before cull.
        assert!(mask.occupied(10, 10));
        let cleared = cull_sheet_islands(&mut mask, mat);
        assert!(cleared > 0);
        assert!(!mask.occupied(10, 10));
        // Outer frame still attached to perimeter.
        assert!(mask.occupied(0, 0));
        assert!(mask.occupied(19, 19));
    }

    #[test]
    fn perimeter_connected_sheet_is_kept() {
        let mat = lookup_sheet_material(SheetMaterialId::Drywall);
        let mut mask = SheetMask::new(16, 16, mat.cell_size);
        // Punch a simple hole — remaining sheet still perimeter-anchored.
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
        // Large enough that the main body exceeds min_island_area.
        let mut mask = SheetMask::new(80, 80, mat.cell_size);
        // Clear a corridor so a 2x2 crumb on the border is disconnected.
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
}
