//! Building-height variants derived from one ScenePack.
//!
//! Rust port of `truncateToFloors` / `makeBuildingVariants` from
//! /root/workspace/blast-stress-solver/demos/blast-stress-demo/mini_city_main.cpp
//! (2026-08-10). Nodes above the Y cutoff are dropped and bonds are remapped —
//! the result is an actual smaller support graph, not a scaled one. Contract
//! (pinned by tests against the committed fractured-tower.json): 1/2/3-floor
//! variants have 83/148/204 nodes, 209/373/546 bonds, 36 support nodes each.

use crate::scene_pack::{SceneCollider, ScenePack};

pub const MAXIMUM_FLOORS: u32 = 3;

#[derive(Clone, Debug)]
pub struct BuildingVariant {
    pub pack: ScenePack,
    pub floors: u32,
    /// Tallest visual point (centroid.y + half of the visual size), used for
    /// spawn/collision planning and cameras.
    pub height: f32,
}

#[derive(Debug)]
pub enum VariantError {
    InvalidFloorCount { floors: u32, maximum: u32 },
    InvalidTruncation(String),
}

impl std::fmt::Display for VariantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFloorCount { floors, maximum } => {
                write!(f, "invalid building floor count {floors} (max {maximum})")
            }
            Self::InvalidTruncation(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for VariantError {}

pub fn truncate_to_floors(
    source: &ScenePack,
    floors: u32,
    maximum_floors: u32,
) -> Result<ScenePack, VariantError> {
    if floors == 0 || floors > maximum_floors || source.nodes.is_empty() {
        return Err(VariantError::InvalidFloorCount {
            floors,
            maximum: maximum_floors,
        });
    }
    let mut result = ScenePack {
        title: format!("{} {}-floor", source.title, floors),
        stress_limits: source.stress_limits,
        nodes: Vec::new(),
        bonds: Vec::new(),
        node_sizes: Vec::new(),
        node_colliders: Vec::new(),
    };

    let mut minimum_y = source.nodes[0].centroid.y;
    let mut maximum_y = minimum_y;
    for node in &source.nodes {
        minimum_y = minimum_y.min(node.centroid.y);
        maximum_y = maximum_y.max(node.centroid.y);
    }
    let cutoff = if floors == maximum_floors {
        maximum_y + 1.0
    } else {
        minimum_y + (maximum_y - minimum_y) * floors as f32 / maximum_floors as f32
    };

    let mut remap = vec![u32::MAX; source.nodes.len()];
    for (node_index, node) in source.nodes.iter().enumerate() {
        if node.centroid.y <= cutoff {
            remap[node_index] = result.nodes.len() as u32;
            result.nodes.push(*node);
            result.node_sizes.push(source.node_sizes[node_index]);
            result
                .node_colliders
                .push(source.node_colliders[node_index].clone());
        }
    }
    for bond in &source.bonds {
        let (Some(&node0), Some(&node1)) = (
            remap.get(bond.node0 as usize),
            remap.get(bond.node1 as usize),
        ) else {
            continue;
        };
        if node0 == u32::MAX || node1 == u32::MAX {
            continue;
        }
        let mut remapped = *bond;
        remapped.node0 = node0;
        remapped.node1 = node1;
        result.bonds.push(remapped);
    }

    if result.nodes.is_empty()
        || result.bonds.is_empty()
        || !result.nodes.iter().any(|node| node.is_support())
    {
        return Err(VariantError::InvalidTruncation(
            "floor truncation produced an invalid supported structure".to_string(),
        ));
    }
    Ok(result)
}

/// The 1..=MAXIMUM_FLOORS variant ladder (or just the full building when
/// `varied_heights` is false), mirroring `makeBuildingVariants`.
pub fn make_building_variants(
    source: &ScenePack,
    varied_heights: bool,
) -> Result<Vec<BuildingVariant>, VariantError> {
    let first_floor = if varied_heights { 1 } else { MAXIMUM_FLOORS };
    let mut variants = Vec::new();
    for floors in first_floor..=MAXIMUM_FLOORS {
        let pack = truncate_to_floors(source, floors, MAXIMUM_FLOORS)?;
        let mut height = 0.0_f32;
        for (node, size) in pack.nodes.iter().zip(&pack.node_sizes) {
            height = height.max(node.centroid.y + size.y * 0.5);
        }
        variants.push(BuildingVariant {
            pack,
            floors,
            height,
        });
    }
    Ok(variants)
}

/// Bounding radius of one chunk's collider around its centroid, floored the
/// same way the trace contract floors it (0.01 m).
pub fn collider_bounding_radius(collider: &SceneCollider) -> f32 {
    let radius = match collider {
        SceneCollider::Cuboid { half_extents } => half_extents.length(),
        SceneCollider::ConvexHull { points } => points
            .chunks_exact(3)
            .map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
            .fold(0.0_f32, f32::max),
    };
    radius.max(0.01)
}
