//! The shape of a scripted collapse, as pure manifest arithmetic.
//!
//! A collapse worth studying has to be the *same* collapse every time, and it
//! has to be reproducible in two places: the live server (`/city-demolish`,
//! which fires rounds at a running scene) and the offline recorder
//! (`record-city-trace`, which needs the same attack as a shot tape). Those
//! two grew separate copies of the target maths, and a fixture that does not
//! match what the player sees is worth nothing -- so the maths lives here,
//! once, and both call it.
//!
//! Nothing in this module touches physics. It answers one question -- which
//! chunks to hit, in what order -- from the manifest alone, which is what
//! makes it deterministic and testable without a GPU.

use crate::manifest::DestructionManifest;

/// XZ bin size for the `tallest_footprint` search, in metres.
const FOOTPRINT_CELL_M: f32 = 8.0;

/// How far outside a target chunk a round is spawned, in metres. Far enough
/// not to start inside the collider, near enough that nothing intervenes.
const ROUND_STANDOFF_M: f32 = 1.2;

/// A scripted attack on a building's footing.
#[derive(Clone, Copy, Debug)]
pub struct DemolitionPlan {
    /// World XZ the wedge is measured from.
    pub centre: [f32; 2],
    /// Only chunks within this horizontal distance of `centre` are considered.
    pub radius_m: f32,
    /// Height ceiling for targets, in world Y. The wedge ramps this down.
    pub below_y: f32,
    /// Direction the wedge opens toward, degrees, `atan2(dz, dx)` convention.
    pub heading_deg: f32,
    /// Half-angle of the wedge. Zero means a plain cylindrical cut.
    pub wedge_deg: f32,
    /// Fraction of candidate targets dropped at random, 0..0.95.
    pub jitter: f32,
    /// Cap on queued targets.
    pub max_rounds: usize,
    /// Seed for the jitter. The same seed gives the same collapse.
    pub seed: u64,
}

impl Default for DemolitionPlan {
    fn default() -> Self {
        Self {
            centre: [0.0, 0.0],
            radius_m: 18.0,
            below_y: 12.0,
            heading_deg: 0.0,
            wedge_deg: 0.0,
            jitter: 0.0,
            max_rounds: 256,
            seed: 0x9E3779B97F4A7C15,
        }
    }
}

/// The 8 m XZ cell with the greatest vertical extent, and that extent.
///
/// Used to aim a scripted collapse at "the tallest thing here" without
/// hard-coding coordinates that a scene edit would silently invalidate.
pub fn tallest_footprint(manifest: &DestructionManifest) -> Option<([f32; 2], f32)> {
    let mut cells: std::collections::HashMap<(i32, i32), (f32, f32)> =
        std::collections::HashMap::new();
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            let x = structure.world_position[0] + chunk.centroid[0];
            let y = structure.world_position[1] + chunk.centroid[1];
            let z = structure.world_position[2] + chunk.centroid[2];
            let cell = (
                (x / FOOTPRINT_CELL_M).floor() as i32,
                (z / FOOTPRINT_CELL_M).floor() as i32,
            );
            let entry = cells.entry(cell).or_insert((f32::MAX, f32::MIN));
            entry.0 = entry.0.min(y);
            entry.1 = entry.1.max(y);
        }
    }
    // Ties broken on the cell coordinate, not on hash order.
    //
    // A downtown has several 8 m cells that reach exactly the same height --
    // the same tower spans four of them -- and `max_by` over a HashMap picks
    // whichever the iterator happened to reach last. That is re-randomised per
    // process, so the "same" scenario aimed at a different corner of the
    // building on every run, which makes any A/B between two runs meaningless.
    // Observed: (12,-28), (12,-44), (20,-28) and (12,-36) from four identical
    // invocations.
    let (cell, extent) = cells
        .iter()
        .map(|(cell, (lo, hi))| (*cell, hi - lo))
        .max_by(|a, b| {
            a.1.total_cmp(&b.1)
                .then_with(|| b.0 .0.cmp(&a.0 .0))
                .then_with(|| b.0 .1.cmp(&a.0 .1))
        })?;
    Some((
        [
            (cell.0 as f32 + 0.5) * FOOTPRINT_CELL_M,
            (cell.1 as f32 + 0.5) * FOOTPRINT_CELL_M,
        ],
        extent,
    ))
}

/// World-space centroids of the chunks the plan attacks, lowest first.
///
/// The wedge cuts only chunks within `wedge_deg` of the heading, and ramps the
/// height limit from full at the wedge's centre line to a quarter at its
/// edges, so the footing comes out as a slope rather than a plane and the
/// building goes over sideways instead of dropping straight down.
///
/// `jitter` discards that fraction at random. This is not cosmetic: a clean
/// cut severs a building into two rigid pieces that fall as two bodies, while
/// a real collapse is hundreds of fractures propagating through a structure
/// that is still partly load-bearing. The second is the regime the streaming
/// artefacts live in, and the first does not reproduce them at all.
///
/// Note the structure's `world_rotation` is not applied, matching the live
/// `/city-demolish` path; every shipped pack places structures axis-aligned.
pub fn wedge_targets(manifest: &DestructionManifest, plan: &DemolitionPlan) -> Vec<[f32; 3]> {
    let mut seed = plan.seed;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as u32 as f32) / (u32::MAX as f32)
    };
    let jitter = plan.jitter.clamp(0.0, 0.95);
    let mut targets: Vec<[f32; 3]> = Vec::new();
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            let world_xyz = [
                structure.world_position[0] + chunk.centroid[0],
                structure.world_position[1] + chunk.centroid[1],
                structure.world_position[2] + chunk.centroid[2],
            ];
            let dx = world_xyz[0] - plan.centre[0];
            let dz = world_xyz[2] - plan.centre[1];
            if dx * dx + dz * dz > plan.radius_m * plan.radius_m {
                continue;
            }
            let mut limit = plan.below_y;
            if plan.wedge_deg > 0.0 {
                let bearing = dz.atan2(dx).to_degrees();
                let mut off = (bearing - plan.heading_deg).rem_euclid(360.0);
                if off > 180.0 {
                    off -= 360.0;
                }
                if off.abs() > plan.wedge_deg {
                    continue;
                }
                let across = 1.0 - (off.abs() / plan.wedge_deg);
                limit = plan.below_y * (0.25 + 0.75 * across);
            }
            if world_xyz[1] > limit {
                continue;
            }
            if jitter > 0.0 && next() < jitter {
                continue;
            }
            targets.push(world_xyz);
        }
    }
    // Lowest first: taking a column out from the bottom is what drops a
    // building; taking it out from the middle leaves the footing standing.
    targets.sort_by(|a, b| a[1].total_cmp(&b[1]));
    targets.truncate(plan.max_rounds);
    targets
}

/// Where to spawn a round for `target`, and which way to drive it.
///
/// Inward, from just outside the chunk toward the building's centre line, so
/// the impulse pushes the footing out from under the load above it.
pub fn round_for_target(target: [f32; 3], centre: [f32; 2]) -> ([f32; 3], [f32; 3]) {
    let (dx, dz) = (target[0] - centre[0], target[2] - centre[1]);
    let length = (dx * dx + dz * dz).sqrt().max(0.001);
    let direction = [-dx / length, 0.0, -dz / length];
    let origin = [
        target[0] - direction[0] * ROUND_STANDOFF_M,
        target[1],
        target[2] - direction[2] * ROUND_STANDOFF_M,
    ];
    (origin, direction)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ChunkDef, ChunkGeometry, DestructionManifest, StructureManifest};

    fn chunk(node_index: u32, centroid: [f32; 3]) -> ChunkDef {
        ChunkDef {
            node_index,
            centroid,
            mass: 1.0,
            volume: 1.0,
            size: [1.0, 1.0, 1.0],
            geometry: ChunkGeometry::Cuboid { half_extents: [0.5, 0.5, 0.5] },
            radius: 0.87,
            support: false,
            material: 0,
        }
    }

    /// A 5x5x5 lattice of unit chunks on the origin, spaced 1 m.
    fn lattice() -> DestructionManifest {
        let mut chunks = Vec::new();
        let mut node = 0;
        for x in 0..5 {
            for y in 0..5 {
                for z in 0..5 {
                    chunks.push(chunk(node, [x as f32, y as f32, z as f32]));
                    node += 1;
                }
            }
        }
        DestructionManifest {
            version: crate::manifest::MANIFEST_VERSION,
            structures: vec![StructureManifest {
                structure_id: 0,
                world_position: [0.0, 0.0, 0.0],
                world_rotation: [0.0, 0.0, 0.0, 1.0],
                chunks,
                bonds: Vec::new(),
            }],
            materials: Vec::new(),
            material_appearance: Vec::new(),
            shape_library: Vec::new(),
        }
    }

    /// The whole point of the fixture: the same plan gives the same collapse.
    #[test]
    fn the_same_plan_selects_the_same_targets() {
        let manifest = lattice();
        let plan = DemolitionPlan {
            centre: [2.0, 2.0],
            radius_m: 4.0,
            below_y: 3.0,
            heading_deg: 30.0,
            wedge_deg: 70.0,
            jitter: 0.4,
            max_rounds: 64,
            ..DemolitionPlan::default()
        };
        let first = wedge_targets(&manifest, &plan);
        let second = wedge_targets(&manifest, &plan);
        assert_eq!(first, second);
        assert!(!first.is_empty(), "a 4 m radius over a 5 m lattice hits something");
    }

    /// Jitter must thin the set without reaching outside it, or "progressive"
    /// destruction would be a different attack rather than a sparser one.
    #[test]
    fn jitter_only_removes_targets() {
        let manifest = lattice();
        let clean = DemolitionPlan {
            centre: [2.0, 2.0],
            radius_m: 4.0,
            below_y: 3.0,
            ..DemolitionPlan::default()
        };
        let jittered = DemolitionPlan { jitter: 0.5, ..clean };
        let all = wedge_targets(&manifest, &clean);
        let some = wedge_targets(&manifest, &jittered);
        assert!(some.len() < all.len(), "{} vs {}", some.len(), all.len());
        for target in &some {
            assert!(all.contains(target), "jitter invented target {target:?}");
        }
    }

    /// The wedge is what makes a building topple instead of pancake, so a
    /// narrow one must leave the far side of the footing untouched.
    #[test]
    fn a_wedge_cuts_one_side_only() {
        let manifest = lattice();
        let plan = DemolitionPlan {
            centre: [2.0, 2.0],
            radius_m: 4.0,
            below_y: 4.0,
            heading_deg: 0.0, // +X
            wedge_deg: 45.0,
            max_rounds: 1024,
            ..DemolitionPlan::default()
        };
        let targets = wedge_targets(&manifest, &plan);
        assert!(!targets.is_empty());
        for target in &targets {
            assert!(
                target[0] >= 2.0,
                "a +X wedge reached behind the centre: {target:?}"
            );
        }
    }

    /// Lowest first, because order is the difference between a collapse and a
    /// hole in the middle of a building that keeps standing.
    #[test]
    fn targets_come_out_bottom_up() {
        let manifest = lattice();
        let targets = wedge_targets(
            &manifest,
            &DemolitionPlan {
                centre: [2.0, 2.0],
                radius_m: 4.0,
                below_y: 4.0,
                max_rounds: 1024,
                ..DemolitionPlan::default()
            },
        );
        for pair in targets.windows(2) {
            assert!(pair[0][1] <= pair[1][1], "{:?} before {:?}", pair[0], pair[1]);
        }
    }

    /// The round is driven inward and starts outside the chunk it targets.
    #[test]
    fn rounds_are_driven_in_toward_the_centre() {
        let (origin, direction) = round_for_target([10.0, 3.0, 0.0], [0.0, 0.0]);
        assert!(direction[0] < 0.0, "a target at +X is pushed toward -X");
        assert!(origin[0] > 10.0, "spawned outside the chunk, on the far side");
        assert_eq!(origin[1], 3.0, "standoff is horizontal only");
        let length = (direction[0] * direction[0] + direction[2] * direction[2]).sqrt();
        assert!((length - 1.0).abs() < 1e-5, "direction must be unit: {length}");
    }

    #[test]
    fn the_tallest_footprint_is_the_tallest_column() {
        let mut manifest = lattice();
        // A spike 40 m up, two cells away from the lattice.
        let spike: Vec<ChunkDef> = (0..40)
            .map(|y| chunk(1000 + y, [24.0, y as f32, 24.0]))
            .collect();
        manifest.structures[0].chunks.extend(spike);
        let (centre, extent) = tallest_footprint(&manifest).expect("non-empty manifest");
        assert!(extent > 30.0, "extent {extent}");
        // x=24 falls in the 8 m cell [24,32), whose centre is 28.
        assert_eq!(centre, [28.0, 28.0], "the spike's own cell, not the lattice's");
    }

    /// The fixture is worthless if it aims somewhere else each run, and a
    /// downtown really does have several cells tied at the same height.
    #[test]
    fn the_tallest_footprint_breaks_ties_deterministically() {
        let mut manifest = lattice();
        // Four cells, all reaching exactly 40 m: the shape of a real tower
        // that spans more than one 8 m bin.
        let mut node = 5000;
        for (cx, cz) in [(24.0, 24.0), (32.0, 24.0), (24.0, 32.0), (32.0, 32.0)] {
            for y in 0..40 {
                manifest.structures[0]
                    .chunks
                    .push(chunk(node, [cx, y as f32, cz]));
                node += 1;
            }
        }
        let first = tallest_footprint(&manifest).expect("non-empty");
        for _ in 0..16 {
            // Rebuild so the internal HashMap is populated in a fresh order.
            let again = tallest_footprint(&lattice_with_tied_towers()).expect("non-empty");
            assert_eq!(again, tallest_footprint(&lattice_with_tied_towers()).unwrap());
            let _ = again;
        }
        assert_eq!(first, tallest_footprint(&manifest).expect("non-empty"));
    }

    fn lattice_with_tied_towers() -> DestructionManifest {
        let mut manifest = lattice();
        let mut node = 5000;
        for (cx, cz) in [(24.0, 24.0), (32.0, 24.0), (24.0, 32.0), (32.0, 32.0)] {
            for y in 0..40 {
                manifest.structures[0]
                    .chunks
                    .push(chunk(node, [cx, y as f32, cz]));
                node += 1;
            }
        }
        manifest
    }
}
