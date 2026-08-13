//! City scene assembly: grid layout and per-building variant selection.
//!
//! Mirrors `buildingOffsets` and the variant cycling of
//! /root/workspace/blast-stress-solver/demos/blast-stress-demo/mini_city_main.cpp:
//! an N×N grid at `pitch` meters, heights alternating 3/2/1 floors
//! (variant index `2 - building % 3` with varied heights).

use glam::Vec3;

use crate::scene_pack::{SceneCollider, ScenePack};
use crate::variants::{make_building_variants, BuildingVariant, VariantError};

#[derive(Clone, Copy, Debug)]
pub struct CitySceneDesc {
    pub grid: u32,
    pub pitch_m: f32,
    pub varied_heights: bool,
}

impl Default for CitySceneDesc {
    fn default() -> Self {
        Self {
            grid: 4,
            pitch_m: 18.0,
            varied_heights: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BuildingInstance {
    pub structure_id: u32,
    pub variant_index: usize,
    pub offset: Vec3,
}

#[derive(Clone, Debug)]
pub struct CityScene {
    pub desc: CitySceneDesc,
    pub variants: Vec<BuildingVariant>,
    pub instances: Vec<BuildingInstance>,
}

impl CityScene {
    pub fn variant_for(&self, instance: &BuildingInstance) -> &BuildingVariant {
        &self.variants[instance.variant_index]
    }

    pub fn total_chunks(&self) -> usize {
        self.instances
            .iter()
            .map(|instance| self.variant_for(instance).pack.nodes.len())
            .sum()
    }

    pub fn total_bonds(&self) -> usize {
        self.instances
            .iter()
            .map(|instance| self.variant_for(instance).pack.bonds.len())
            .sum()
    }

    /// Footprint half-extent of the building grid (buildings only, not spawn ring).
    pub fn grid_half_extent_m(&self) -> f32 {
        (self.desc.grid.saturating_sub(1)) as f32 * self.desc.pitch_m * 0.5
    }
}

pub fn building_offsets(grid: u32, pitch: f32) -> Vec<Vec3> {
    let mut offsets = Vec::with_capacity((grid * grid) as usize);
    let half = (grid.saturating_sub(1)) as f32 * pitch * 0.5;
    for row in 0..grid {
        for column in 0..grid {
            offsets.push(Vec3::new(
                -half + column as f32 * pitch,
                0.0,
                -half + row as f32 * pitch,
            ));
        }
    }
    offsets
}

/// Street width between building faces, matching the reference mini-city:
/// `cityPitch = 18 m` around the 8 m-wide fractured tower.
pub const STREET_WIDTH_M: f32 = 10.0;

/// Widest XZ footprint of a pack, from its colliders.
pub fn pack_footprint_m(pack: &ScenePack) -> f32 {
    let mut low = Vec3::splat(f32::INFINITY);
    let mut high = Vec3::splat(f32::NEG_INFINITY);
    for (node, collider) in pack.nodes.iter().zip(&pack.node_colliders) {
        match collider {
            SceneCollider::Cuboid { half_extents } => {
                low = low.min(node.centroid - *half_extents);
                high = high.max(node.centroid + *half_extents);
            }
            SceneCollider::ConvexHull { points } => {
                // The true extent of each vertex. Treating max |p| as a
                // symmetric half-extent inflated the footprint of any hull
                // whose vertices are unevenly spread about its centroid,
                // widening the whole grid pitch for empty air.
                for point in points.chunks_exact(3) {
                    let world = node.centroid + Vec3::new(point[0], point[1], point[2]);
                    low = low.min(world);
                    high = high.max(world);
                }
            }
        }
    }
    if !low.is_finite() || !high.is_finite() {
        return 0.0;
    }
    (high.x - low.x).max(high.z - low.z)
}

/// Grid pitch that leaves a real street around this pack.
///
/// The reference demo hardcodes 18 m, which is correct only for the 8 m-wide
/// fractured tower it ships with. The 18 m-wide high-rise pack at that pitch
/// puts neighbouring facades face to face: PhysX depenetrates the touching
/// panels and the weak infill bonds shear on the first tick, so the city
/// demolishes itself before anyone fires.
pub fn pitch_for_pack(pack: &ScenePack, minimum: f32) -> f32 {
    (pack_footprint_m(pack) + STREET_WIDTH_M).max(minimum)
}

pub fn build_city_scene(
    source: &ScenePack,
    desc: CitySceneDesc,
) -> Result<CityScene, VariantError> {
    let mut desc = desc;
    // Never let an authored pitch place buildings inside each other.
    desc.pitch_m = desc.pitch_m.max(pitch_for_pack(source, 0.0));
    let variants = make_building_variants(source, desc.varied_heights)?;
    let offsets = building_offsets(desc.grid, desc.pitch_m);
    let instances = offsets
        .into_iter()
        .enumerate()
        .map(|(building, offset)| BuildingInstance {
            structure_id: building as u32,
            variant_index: if desc.varied_heights {
                // Cycle 3/2/1 floors: variants are ordered [1f, 2f, 3f].
                (variants.len() - 1) - (building % variants.len())
            } else {
                0
            },
            offset,
        })
        .collect();
    Ok(CityScene {
        desc,
        variants,
        instances,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_is_centered_on_origin() {
        let offsets = building_offsets(4, 18.0);
        assert_eq!(offsets.len(), 16);
        let sum: Vec3 = offsets.iter().copied().sum();
        assert!(sum.length() < 1e-3);
        assert_eq!(offsets[0], Vec3::new(-27.0, 0.0, -27.0));
        assert_eq!(offsets[15], Vec3::new(27.0, 0.0, 27.0));
    }
}
