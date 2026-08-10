//! The destruction manifest: the static, hash-verifiable ledger shared by
//! server and clients.
//!
//! Per building: structure id, world transform, chunk definitions (geometry,
//! rest pose, mass, support flag) and the bond graph. Clients download this
//! once (HTTP, content-addressed by hash) and reconstruct island membership
//! purely from fracture events; the kinematic stream only ever references
//! body entities and this manifest.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::city::CityScene;
use crate::ids;
use crate::scene_pack::SceneCollider;
use crate::variants::collider_bounding_radius;

pub const MANIFEST_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DestructionManifest {
    pub version: u32,
    pub structures: Vec<StructureManifest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructureManifest {
    pub structure_id: u32,
    pub world_position: [f32; 3],
    pub world_rotation: [f32; 4],
    pub chunks: Vec<ChunkDef>,
    pub bonds: Vec<BondDef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChunkDef {
    /// Node index within the structure; the global chunk id is
    /// `ids::chunk_id(structure_id, node_index)`.
    pub node_index: u32,
    /// Rest centroid in structure-local space.
    pub centroid: [f32; 3],
    pub mass: f32,
    pub volume: f32,
    /// Visual box size (full extents) for rendering.
    pub size: [f32; 3],
    pub geometry: ChunkGeometry,
    /// Bounding radius of the collider around the centroid.
    pub radius: f32,
    /// Zero-mass nodes anchor the structure to world support.
    pub support: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChunkGeometry {
    Cuboid { half_extents: [f32; 3] },
    ConvexHull { points: Vec<f32> },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BondDef {
    /// Bond index within the structure; the global bond id is
    /// `ids::bond_id(structure_id, bond_index)`.
    pub bond_index: u32,
    pub node0: u32,
    pub node1: u32,
    pub centroid: [f32; 3],
    pub normal: [f32; 3],
    pub area: f32,
}

impl DestructionManifest {
    pub fn from_city(city: &CityScene) -> Self {
        let structures = city
            .instances
            .iter()
            .map(|instance| {
                let pack = &city.variant_for(instance).pack;
                StructureManifest {
                    structure_id: instance.structure_id,
                    world_position: instance.offset.to_array(),
                    world_rotation: [0.0, 0.0, 0.0, 1.0],
                    chunks: pack
                        .nodes
                        .iter()
                        .enumerate()
                        .map(|(node_index, node)| ChunkDef {
                            node_index: node_index as u32,
                            centroid: node.centroid.to_array(),
                            mass: node.mass,
                            volume: node.volume,
                            size: pack.node_sizes[node_index].to_array(),
                            geometry: match &pack.node_colliders[node_index] {
                                SceneCollider::Cuboid { half_extents } => ChunkGeometry::Cuboid {
                                    half_extents: half_extents.to_array(),
                                },
                                SceneCollider::ConvexHull { points } => ChunkGeometry::ConvexHull {
                                    points: points.clone(),
                                },
                            },
                            radius: collider_bounding_radius(&pack.node_colliders[node_index]),
                            support: node.is_support(),
                        })
                        .collect(),
                    bonds: pack
                        .bonds
                        .iter()
                        .enumerate()
                        .map(|(bond_index, bond)| BondDef {
                            bond_index: bond_index as u32,
                            node0: bond.node0,
                            node1: bond.node1,
                            centroid: bond.centroid.to_array(),
                            normal: bond.normal.to_array(),
                            area: bond.area,
                        })
                        .collect(),
                }
            })
            .collect();
        Self {
            version: MANIFEST_VERSION,
            structures,
        }
    }

    /// Canonical serialized bytes — the payload served over HTTP and the hash
    /// input. serde_json field order is declaration order, so this is stable
    /// for a fixed crate version.
    pub fn to_json_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("manifest serialization cannot fail")
    }

    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.to_json_bytes());
        hasher.finalize().into()
    }

    pub fn hash_hex(&self) -> String {
        self.hash().iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn total_chunks(&self) -> usize {
        self.structures.iter().map(|s| s.chunks.len()).sum()
    }

    pub fn total_bonds(&self) -> usize {
        self.structures.iter().map(|s| s.bonds.len()).sum()
    }

    pub fn structure(&self, structure_id: u32) -> Option<&StructureManifest> {
        self.structures
            .iter()
            .find(|s| s.structure_id == structure_id)
    }

    /// Global chunk ids for one structure, in node order.
    pub fn chunk_ids<'a>(
        &self,
        structure: &'a StructureManifest,
    ) -> impl Iterator<Item = u32> + 'a {
        let structure_id = structure.structure_id;
        structure
            .chunks
            .iter()
            .map(move |chunk| ids::chunk_id(structure_id, chunk.node_index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::city::{build_city_scene, CitySceneDesc};
    use crate::scene_pack::parse_scene_pack;

    fn tiny_pack() -> crate::scene_pack::ScenePack {
        parse_scene_pack(
            r#"{
            "version": 1, "title": "tiny",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 3, "z": 0}, "mass": 10, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 0.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 1.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 2, "node1": 3, "centroid": {"x": 0, "y": 2.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1},
                    {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}
                ],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("tiny pack")
    }

    #[test]
    fn manifest_hash_is_stable_across_builds() {
        let pack = tiny_pack();
        let desc = CitySceneDesc {
            grid: 2,
            pitch_m: 10.0,
            varied_heights: true,
        };
        let a = DestructionManifest::from_city(&build_city_scene(&pack, desc).unwrap());
        let b = DestructionManifest::from_city(&build_city_scene(&pack, desc).unwrap());
        assert_eq!(a.hash(), b.hash());
        assert_eq!(a.hash_hex().len(), 64);
    }

    #[test]
    fn manifest_round_trips_through_json() {
        let pack = tiny_pack();
        let desc = CitySceneDesc {
            grid: 2,
            pitch_m: 10.0,
            varied_heights: false,
        };
        let manifest = DestructionManifest::from_city(&build_city_scene(&pack, desc).unwrap());
        let bytes = manifest.to_json_bytes();
        let back: DestructionManifest = serde_json::from_slice(&bytes).expect("round trip");
        assert_eq!(manifest, back);
        assert_eq!(back.total_chunks(), 16);
    }
}
