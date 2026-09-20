//! The buildings in a scene, as its bond graph defines them.
//!
//! A scene pack is one flat scenario and the manifest has one structure per
//! grid cell -- the town is a single structure of 49,070 chunks. What a
//! player calls a building is a connected component of the intact bond
//! graph. This enumerates those in world space so a scripted driver can aim
//! at each in turn and a report can say which one a body came from.

use serde::{Deserialize, Serialize};

use crate::manifest::DestructionManifest;
use crate::topology::ChunkComponents;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Building {
    /// Index in the returned list, ordered by structure then smallest node.
    pub id: u32,
    pub structure_id: u32,
    pub chunks: u32,
    /// Chunk-count-weighted centroid, world space.
    pub centre: [f32; 3],
    /// Highest chunk centroid plus its radius, world space.
    pub top: f32,
    /// Lowest chunk centroid minus its radius, world space.
    pub bottom: f32,
    /// Horizontal extent from `centre` to the farthest chunk edge.
    pub radius: f32,
    pub mass: f32,
    /// Smallest node index in the component, structure-local.
    pub root_node: u32,
}

/// Every connected component of every structure with at least
/// `min_chunks` chunks. Isolated single chunks (there are none in an authored
/// pack, but a synthetic one may have them) are skipped by default.
pub fn enumerate(manifest: &DestructionManifest) -> Vec<Building> {
    enumerate_min(manifest, 2)
}

pub fn enumerate_min(manifest: &DestructionManifest, min_chunks: usize) -> Vec<Building> {
    let mut out = Vec::new();
    for structure in &manifest.structures {
        let mut components = ChunkComponents::new(structure.chunks.len() as u32);
        for bond in &structure.bonds {
            components.union(bond.node0, bond.node1);
        }
        let mut groups: Vec<(u32, Vec<u32>)> = components.components().into_iter().collect();
        groups.sort_unstable_by_key(|(root, _)| *root);
        let origin = structure.world_position;
        for (root, nodes) in groups {
            if nodes.len() < min_chunks {
                continue;
            }
            let mut sum = [0.0f64; 3];
            let mut top = f32::MIN;
            let mut bottom = f32::MAX;
            let mut mass = 0.0f32;
            for &node in &nodes {
                let chunk = &structure.chunks[node as usize];
                for axis in 0..3 {
                    sum[axis] += f64::from(origin[axis] + chunk.centroid[axis]);
                }
                top = top.max(origin[1] + chunk.centroid[1] + chunk.radius);
                bottom = bottom.min(origin[1] + chunk.centroid[1] - chunk.radius);
                mass += chunk.mass;
            }
            let count = nodes.len() as f64;
            let centre = [
                (sum[0] / count) as f32,
                (sum[1] / count) as f32,
                (sum[2] / count) as f32,
            ];
            let mut radius = 0.0f32;
            for &node in &nodes {
                let chunk = &structure.chunks[node as usize];
                let dx = origin[0] + chunk.centroid[0] - centre[0];
                let dz = origin[2] + chunk.centroid[2] - centre[2];
                radius = radius.max((dx * dx + dz * dz).sqrt() + chunk.radius);
            }
            out.push(Building {
                id: out.len() as u32,
                structure_id: structure.structure_id,
                chunks: nodes.len() as u32,
                centre,
                top,
                bottom,
                radius,
                mass,
                root_node: root,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{BondDef, ChunkDef, ChunkGeometry, StructureManifest};

    fn chunk(node: u32, x: f32, y: f32) -> ChunkDef {
        ChunkDef {
            node_index: node,
            centroid: [x, y, 0.0],
            mass: 1.0,
            volume: 1.0,
            size: [1.0; 3],
            geometry: ChunkGeometry::Cuboid { half_extents: [0.5; 3] },
            radius: 0.5,
            support: false,
            material: 0,
        }
    }

    fn bond(a: u32, b: u32) -> BondDef {
        BondDef {
            bond_index: 0,
            node0: a,
            node1: b,
            centroid: [0.0; 3],
            normal: [0.0, 1.0, 0.0],
            area: 1.0,
            material: 0,
        }
    }

    /// Two towers in one structure are two buildings, placed in world space.
    #[test]
    fn components_of_the_bond_graph_are_buildings() {
        let manifest: DestructionManifest =
            serde_json::from_str(r#"{"version":1,"structures":[]}"#).expect("manifest");
        let mut manifest = manifest;
        manifest.structures.push(StructureManifest {
            structure_id: 3,
            world_position: [100.0, 0.0, 0.0],
            world_rotation: [0.0, 0.0, 0.0, 1.0],
            chunks: vec![
                chunk(0, 0.0, 0.0),
                chunk(1, 0.0, 1.0),
                chunk(2, 0.0, 2.0),
                chunk(3, 10.0, 0.0),
                chunk(4, 10.0, 1.0),
                chunk(5, 50.0, 0.0),
            ],
            bonds: vec![bond(0, 1), bond(1, 2), bond(3, 4)],
        });
        let buildings = enumerate(&manifest);
        assert_eq!(buildings.len(), 2, "the lone chunk 5 is not a building");
        assert_eq!(buildings[0].chunks, 3);
        assert_eq!(buildings[0].centre, [100.0, 1.0, 0.0]);
        assert_eq!(buildings[0].top, 2.5);
        assert_eq!(buildings[0].bottom, -0.5);
        assert_eq!(buildings[0].structure_id, 3);
        assert_eq!(buildings[1].chunks, 2);
        assert_eq!(buildings[1].centre, [110.0, 0.5, 0.0]);
        assert_eq!(buildings[1].root_node, 3);
    }
}
