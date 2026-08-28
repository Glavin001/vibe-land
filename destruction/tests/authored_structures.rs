//! The authored ScenePacks parse and build, as the Rust runtime sees them.
//!
//! These three packs are generated in the sibling `blast-stress-solver-2` repo
//! by `structures/build.mjs`, which owns the scene pack format and every piece
//! of authoring machinery. That generator has its own validation
//! (`structures/verify.mjs`: interpenetration, grounding, rest statics), but it
//! runs in Node against the JSON. This is the other half of the contract — that
//! what it emits is something the parser, the material table check and the
//! manifest builder all accept.
//!
//! Cheap and deliberately non-numeric: no chunk counts are pinned, because
//! these packs are meant to be re-authored and a count pin would turn every
//! design tweak into a test failure. What is pinned is the structural
//! invariants the runtime relies on.

use std::path::{Path, PathBuf};

use vibe_land_destruction::city::{build_city_scene, CitySceneDesc};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::scene_pack::{load_scene_pack_file, ScenePack, SceneCollider};

const AUTHORED: [&str; 3] = ["algedra-tower", "house-1story", "house-2story"];

fn pack_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"))
}

fn load(name: &str) -> ScenePack {
    load_scene_pack_file(&pack_path(name)).unwrap_or_else(|e| panic!("load {name}.json: {e:?}"))
}

#[test]
fn authored_packs_parse_as_v2_with_a_material_table() {
    for name in AUTHORED {
        let pack = load(name);
        assert_eq!(pack.version, 2, "{name} must be a v2 pack");
        // A v2 pack without `defaults.solver.materials` is rejected outright by
        // the parser, so reaching here already proves the table exists; this
        // pins that it carries the several materials the structures author
        // rather than collapsing to a single placeholder.
        assert!(
            pack.materials.len() >= 5,
            "{name}: expected the authored material table, got {} entries",
            pack.materials.len()
        );
        for (i, m) in pack.materials.iter().enumerate() {
            assert!(
                m.compression_elastic >= 0.0,
                "{name} material {i}: negative compressionElastic"
            );
            assert!(
                m.compression_fatal >= m.compression_elastic,
                "{name} material {i}: a bond that breaks before it yields is incoherent"
            );
        }
    }
}

#[test]
fn authored_packs_are_anchored_and_internally_consistent() {
    for name in AUTHORED {
        let pack = load(name);
        let n = pack.nodes.len();
        assert_eq!(pack.node_sizes.len(), n, "{name}: nodeSizes out of step");
        assert_eq!(pack.node_colliders.len(), n, "{name}: nodeColliders out of step");

        // Without at least one mass-0 node the structure is pinned to nothing
        // and falls through the world on the first tick.
        let supports = pack.nodes.iter().filter(|node| node.is_support()).count();
        assert!(supports > 0, "{name}: no support nodes");

        for (i, bond) in pack.bonds.iter().enumerate() {
            assert!(
                (bond.node0 as usize) < n && (bond.node1 as usize) < n,
                "{name} bond {i}: node index out of range"
            );
            assert!(bond.area > 0.0, "{name} bond {i}: non-positive area");
            assert!(
                (bond.material as usize) < pack.materials.len(),
                "{name} bond {i}: material {} outside the table",
                bond.material
            );
        }

        // Authored packs carry their geometry inline. They use no shape
        // library, which is a city-scale optimisation for repeated shards.
        for (i, collider) in pack.node_colliders.iter().enumerate() {
            if let SceneCollider::ConvexHull { points, .. } = collider {
                let count = points.len() / 3;
                assert!(
                    count <= 64,
                    "{name} node {i}: hull has {count} points, over PhysX's GPU cook limit of 64"
                );
            }
        }
    }
}

#[test]
fn authored_packs_build_a_manifest() {
    for name in AUTHORED {
        let pack = load(name);
        // One building, no height variants: these are authored structures with
        // a designed silhouette, not a city archetype to be truncated.
        let scene = build_city_scene(
            &pack,
            CitySceneDesc { grid: 1, pitch_m: 0.0, varied_heights: false },
        )
        .unwrap_or_else(|e| panic!("{name}: build_city_scene: {e:?}"));
        let manifest = DestructionManifest::from_city(&scene);
        assert_eq!(manifest.structures.len(), 1, "{name}: expected one structure");
        let structure = &manifest.structures[0];
        assert_eq!(
            structure.chunks.len(),
            pack.nodes.len(),
            "{name}: every node should become a chunk"
        );
        assert!(!structure.bonds.is_empty(), "{name}: manifest has no bonds");
        assert!(
            manifest.materials.len() >= 5,
            "{name}: the authored material table should reach the manifest"
        );
    }
}

/// The new fields must be invisible to every pack that does not author them.
///
/// The manifest is content-addressed by SHA-256 and clients cache it by that
/// hash. `ChunkDef::material` and `DestructionManifest::material_appearance`
/// are both guarded with `skip_serializing_if`, so a pack with no per-node
/// material and no appearance has to serialise to exactly the bytes it did
/// before those fields existed. This asserts the guards actually hold, because
/// getting it wrong invalidates every cached manifest in the field and would
/// otherwise only show up as a mass re-download.
#[test]
fn existing_packs_gain_no_manifest_fields() {
    for name in ["high-rise-3f-local", "fractured-highrise-10f"] {
        let path = pack_path(name);
        if !path.exists() {
            continue;
        }
        let pack = load_scene_pack_file(&path).unwrap_or_else(|e| panic!("load {name}: {e:?}"));
        let scene = build_city_scene(
            &pack,
            CitySceneDesc { grid: 1, pitch_m: 0.0, varied_heights: false },
        )
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let value: serde_json::Value =
            serde_json::to_value(DestructionManifest::from_city(&scene)).expect("serialize");
        // Checked per chunk rather than by substring: `BondDef::material`
        // predates this work and legitimately emits `"material"` on any v2 pack
        // whose bonds are not all material 0.
        for structure in value["structures"].as_array().expect("structures") {
            for chunk in structure["chunks"].as_array().expect("chunks") {
                assert!(
                    chunk.get("material").is_none(),
                    "{name}: a chunk emitted a material field; every existing manifest would rehash"
                );
            }
        }
        assert!(
            value.get("materialAppearance").is_none(),
            "{name}: emitted a materialAppearance table it never authored"
        );
    }
}

/// …and the authored packs must actually carry them, or the renderer has
/// nothing to shade by.
#[test]
fn authored_packs_carry_material_and_appearance() {
    let pack = load("algedra-tower");
    let scene = build_city_scene(
        &pack,
        CitySceneDesc { grid: 1, pitch_m: 0.0, varied_heights: false },
    )
    .expect("build");
    let manifest = DestructionManifest::from_city(&scene);

    assert_eq!(
        manifest.material_appearance.len(),
        manifest.materials.len(),
        "appearance table must be parallel to the strength table"
    );
    let glass = manifest
        .material_appearance
        .iter()
        .find(|a| a.opacity.is_some())
        .expect("the tower authors a transparent material");
    assert!(glass.opacity.unwrap() > 0.0 && glass.opacity.unwrap() < 1.0);

    // More than one distinct chunk material, or grouping by material is moot.
    let distinct: std::collections::BTreeSet<u32> = manifest.structures[0]
        .chunks
        .iter()
        .map(|c| c.material)
        .collect();
    assert!(
        distinct.len() >= 4,
        "expected several chunk materials, got {distinct:?}"
    );
}
