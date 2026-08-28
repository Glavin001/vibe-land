//! The destruction manifest: the static, hash-verifiable ledger shared by
//! server and clients.
//!
//! Per building: structure id, world transform, chunk definitions (geometry,
//! rest pose, mass, support flag) and the bond graph. Clients download this
//! once (HTTP, content-addressed by hash) and reconstruct island membership
//! purely from fracture events; the kinematic stream only ever references
//! body entities and this manifest.

use std::collections::BTreeMap;

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
    /// Stress materials, indexed by `BondDef::material`. All structures come
    /// from one pack, so the table is shared rather than repeated per
    /// structure.
    ///
    /// Skipped when empty, which is the case for every v1 pack. That is not a
    /// tidiness choice: manifests are content-addressed, so serialising an
    /// empty table would change the hash of every existing scene and force a
    /// re-fetch for no gain.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<StressMaterialDef>,
    /// Parallel to `materials`, and empty unless the pack authored appearance.
    /// Advisory: nothing in the simulation reads it, the renderer does.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_appearance: Vec<MaterialAppearanceDef>,
    /// Distinct shard hulls, stored once and referenced by `ChunkGeometry`.
    ///
    /// The pack already deduplicates these -- a bounded fracture-pattern count
    /// means the same shard recurs -- but the manifest used to re-inline the
    /// points into every chunk, so what players download did not benefit.
    /// Downtown measured 19.7 MB with the pack at 14.2 MB for the same content.
    ///
    /// Skipped when empty for the same reason `materials` is: manifests are
    /// content-addressed, so emitting an empty field would change the hash of
    /// every existing scene and force a re-fetch for nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shape_library: Vec<Vec<f32>>,
}

/// One entry of the manifest's stress material table.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StressMaterialDef {
    pub compression_elastic: f32,
    pub compression_fatal: f32,
    pub tension_elastic: f32,
    pub tension_fatal: f32,
    pub shear_elastic: f32,
    pub shear_fatal: f32,
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
    /// Index into `DestructionManifest::materials` — the chunk's OWN material,
    /// as opposed to a bond's. Lets the client shade a chunk by what it is made
    /// of instead of by a hash of its building id.
    ///
    /// Skipped when 0 so every pack that authors no per-node material — which
    /// is all of them but the authored structures — hashes exactly as it did
    /// before this field existed. The manifest is content-addressed by SHA-256,
    /// so an unguarded field here would invalidate every client's cached copy.
    #[serde(default, skip_serializing_if = "is_default_material")]
    pub material: u32,
}

/// Collider geometry as served to clients.
///
/// `rename_all` on the enum only renames the *variant tags*; each variant needs
/// its own `rename_all` or its fields stay snake_case. Without the per-variant
/// attribute `Cuboid` serialized as `half_extents`, which the TypeScript client
/// reads as `halfExtents` — it destructured `undefined` and aborted the whole
/// chunk mesh build. `manifest_geometry_keys_are_camel_case` pins this.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ChunkGeometry {
    #[serde(rename_all = "camelCase")]
    Cuboid { half_extents: [f32; 3] },
    #[serde(rename_all = "camelCase")]
    ConvexHull {
        /// Empty when `shape_id` names an entry of `shape_library`, which is
        /// where the points then live. Inline for packs with no library.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        points: Vec<f32>,
        /// Shape-library id from the pack, when the fracturer bounded its
        /// pattern count and named its shards.
        ///
        /// Carried through so the client can group instanceable shards by an
        /// authored identity rather than hashing point arrays to rediscover it.
        /// Skipped when absent so packs without a library hash exactly as they
        /// did before this field existed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape_id: Option<u32>,
    },
}

/// How a material looks. Every field optional; a material that authored none of
/// them serialises to `{}` and is skipped entirely at the table level.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialAppearanceDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Presence of this marks the material transparent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metalness: Option<f32>,
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
    /// Index into `DestructionManifest::materials`. Skipped when 0 so v1
    /// manifests keep hashing exactly as they did before materials existed.
    #[serde(default, skip_serializing_if = "is_default_material")]
    pub material: u32,
}

fn is_default_material(material: &u32) -> bool {
    *material == 0
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
                                SceneCollider::ConvexHull { points, shape_id } => {
                                    ChunkGeometry::ConvexHull {
                                        points: points.clone(),
                                        shape_id: *shape_id,
                                    }
                                }
                            },
                            radius: collider_bounding_radius(&pack.node_colliders[node_index]),
                            support: node.is_support(),
                            material: node.material,
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
                            material: bond.material,
                        })
                        .collect(),
                }
            })
            .collect();
        // Only v2 packs author a table. Emitting one for v1 would rewrite the
        // hash of every existing scene without changing what it describes,
        // since a single implicit material is exactly what v1 already means.
        let materials = city
            .instances
            .first()
            .map(|instance| &city.variant_for(instance).pack)
            .filter(|pack| pack.version >= 2)
            .map(|pack| {
                pack.materials
                    .iter()
                    .map(|limits| StressMaterialDef {
                        compression_elastic: limits.compression_elastic,
                        compression_fatal: limits.compression_fatal,
                        tension_elastic: limits.tension_elastic,
                        tension_fatal: limits.tension_fatal,
                        shear_elastic: limits.shear_elastic,
                        shear_fatal: limits.shear_fatal,
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Appearance rides alongside the strength table, from the same pack.
        // Empty unless something authored it, and skipped at serialisation when
        // empty, so no existing manifest changes shape or hash.
        let material_appearance: Vec<MaterialAppearanceDef> = city
            .instances
            .first()
            .map(|instance| &city.variant_for(instance).pack)
            .filter(|pack| pack.version >= 2)
            .map(|pack| {
                pack.appearances
                    .iter()
                    .map(|a| MaterialAppearanceDef {
                        name: a.name.clone(),
                        color: a.color.clone(),
                        opacity: a.opacity,
                        texture_key: a.texture_key.clone(),
                        roughness: a.roughness,
                        metalness: a.metalness,
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|table: &Vec<MaterialAppearanceDef>| table.iter().any(|a| {
                a.color.is_some() || a.opacity.is_some() || a.texture_key.is_some()
            }))
            .unwrap_or_default();
        // Hoist every shard the pack named into a manifest-level library and
        // drop the inline copy. Packs deduplicate these already; without this
        // the manifest re-inlined them per chunk, so the thing players actually
        // download saw none of the benefit.
        //
        // Keyed on the pack's own `shape_id`, not on the points: the fracturer
        // named each shard as it cut it, and re-deriving identity by comparing
        // geometry is exactly the sweep that authored ids exist to avoid.
        let mut structures: Vec<StructureManifest> = structures;
        let mut shape_library: Vec<Vec<f32>> = Vec::new();
        let mut library_index: BTreeMap<u32, u32> = BTreeMap::new();
        for structure in &mut structures {
            for chunk in &mut structure.chunks {
                let ChunkGeometry::ConvexHull { points, shape_id } = &mut chunk.geometry else {
                    continue;
                };
                let Some(id) = shape_id.as_ref().copied() else { continue };
                let slot = match library_index.get(&id) {
                    Some(slot) => *slot,
                    None => {
                        let slot = shape_library.len() as u32;
                        shape_library.push(std::mem::take(points));
                        library_index.insert(id, slot);
                        slot
                    }
                };
                // Renumbered to the library's own indices: a pack's ids are
                // dense per pack, and a city can stamp several packs.
                *shape_id = Some(slot);
                points.clear();
            }
        }
        Self {
            version: MANIFEST_VERSION,
            structures,
            materials,
            material_appearance,
            shape_library,
        }
    }

    /// Hull points for a chunk, resolving a shape-library reference.
    ///
    /// EVERY consumer must go through this, not `ChunkGeometry::ConvexHull`'s
    /// `points` directly. The manifest is not only the client's artifact: the
    /// server builds its own PhysX destructible from the same document, and
    /// reading the field raw got it an empty buffer for every library-backed
    /// chunk -- "convex node requires points", the city silently unavailable
    /// for the match, and nothing breakable in a destruction game.
    pub fn hull_points<'a>(&'a self, geometry: &'a ChunkGeometry) -> &'a [f32] {
        match geometry {
            ChunkGeometry::Cuboid { .. } => &[],
            ChunkGeometry::ConvexHull { points, shape_id } => {
                if !points.is_empty() {
                    return points;
                }
                shape_id
                    .and_then(|id| self.shape_library.get(id as usize))
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
            }
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

    /// Tripwire for the content-addressing invariant. Manifests are fetched by
    /// hash and cached immutably, so a v1 manifest must serialise to exactly
    /// the bytes it did before materials existed -- otherwise every deployed
    /// scene re-hashes and every client re-downloads a field carrying no
    /// information. The `skip_serializing_if` attributes on
    /// `DestructionManifest::materials` and `BondDef::material` are what make
    /// that true; this is what stops them being "tidied" away.
    #[test]
    fn v1_manifests_do_not_serialise_material_fields() {
        let pack = tiny_pack();
        let desc = CitySceneDesc {
            grid: 2,
            pitch_m: 10.0,
            varied_heights: true,
        };
        let manifest = DestructionManifest::from_city(&build_city_scene(&pack, desc).unwrap());
        assert!(manifest.materials.is_empty(), "a v1 pack authors no table");
        let json = String::from_utf8(manifest.to_json_bytes()).expect("utf8");
        assert!(
            !json.contains("\"materials\""),
            "v1 manifest must not emit a materials table"
        );
        assert!(
            !json.contains("\"material\""),
            "v1 bonds must not emit a material index"
        );
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

    /// Rust-only round-tripping cannot catch a snake_case field leaking into
    /// the wire, because serde reads back whatever it wrote. The TypeScript
    /// client cannot: it reads `halfExtents` literally. Pin the key names.
    #[test]
    fn manifest_geometry_keys_are_camel_case() {
        let cuboid = serde_json::to_value(ChunkGeometry::Cuboid {
            half_extents: [0.5, 1.0, 1.5],
        })
        .expect("serialize cuboid");
        assert_eq!(cuboid["kind"], "cuboid");
        assert_eq!(cuboid["halfExtents"], serde_json::json!([0.5, 1.0, 1.5]));
        assert!(
            cuboid.get("half_extents").is_none(),
            "snake_case half_extents leaked to the wire: {cuboid}"
        );

        let hull = serde_json::to_value(ChunkGeometry::ConvexHull {
            points: vec![0.0, 1.0, 2.0],
            shape_id: None,
        })
        .expect("serialize hull");
        assert_eq!(hull["kind"], "convexHull");
        assert_eq!(hull["points"], serde_json::json!([0.0, 1.0, 2.0]));
        assert!(
            hull.get("shapeId").is_none(),
            "an absent shape id must not appear on the wire, or every pack \
             without a shape library rehashes: {hull}"
        );

        let named = serde_json::to_value(ChunkGeometry::ConvexHull {
            points: vec![0.0, 1.0, 2.0],
            shape_id: Some(7),
        })
        .expect("serialize named hull");
        assert_eq!(named["shapeId"], 7, "shape id must reach the client camelCased");
    }

    /// A library-backed chunk must resolve to real points.
    ///
    /// The server builds its own PhysX destructible from this document, so a
    /// consumer reading `points` raw gets an empty buffer and the city comes up
    /// "unavailable for this match" -- a destruction game with nothing
    /// breakable, and no error anywhere near the change that caused it.
    #[test]
    fn hull_points_resolve_through_the_shape_library() {
        let mut manifest = DestructionManifest {
            version: MANIFEST_VERSION,
            structures: Vec::new(),
            materials: Vec::new(),
            material_appearance: Vec::new(),
            shape_library: vec![vec![1.0, 2.0, 3.0]],
        };
        let referenced = ChunkGeometry::ConvexHull {
            points: Vec::new(),
            shape_id: Some(0),
        };
        assert_eq!(manifest.hull_points(&referenced), &[1.0, 2.0, 3.0]);

        // Inline points still win, so packs without a library are untouched.
        let inline = ChunkGeometry::ConvexHull {
            points: vec![9.0, 9.0, 9.0],
            shape_id: None,
        };
        assert_eq!(manifest.hull_points(&inline), &[9.0, 9.0, 9.0]);

        // A dangling id resolves to nothing rather than panicking; the bridge
        // reports "convex node requires points", which names the real problem.
        manifest.shape_library.clear();
        assert!(manifest.hull_points(&referenced).is_empty());
    }

    /// Every key the client can observe on a real manifest must be camelCase.
    /// Guards the whole document, not just the enum that regressed.
    #[test]
    fn served_manifest_has_no_snake_case_keys() {
        let pack = tiny_pack();
        let desc = CitySceneDesc {
            grid: 2,
            pitch_m: 10.0,
            varied_heights: true,
        };
        let manifest = DestructionManifest::from_city(&build_city_scene(&pack, desc).unwrap());
        let value: serde_json::Value =
            serde_json::from_slice(&manifest.to_json_bytes()).expect("parse");

        fn walk(value: &serde_json::Value, path: &str, offenders: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    for (key, child) in map {
                        if key.contains('_') {
                            offenders.push(format!("{path}.{key}"));
                        }
                        walk(child, &format!("{path}.{key}"), offenders);
                    }
                }
                serde_json::Value::Array(items) => {
                    // Index 0 is representative; arrays here are homogeneous.
                    if let Some(first) = items.first() {
                        walk(first, &format!("{path}[0]"), offenders);
                    }
                }
                _ => {}
            }
        }

        let mut offenders = Vec::new();
        walk(&value, "$", &mut offenders);
        assert!(
            offenders.is_empty(),
            "snake_case keys reached the client wire: {offenders:?}"
        );
    }
}
