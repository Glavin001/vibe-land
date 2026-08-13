//! Integration pins against the committed fractured-tower ScenePack.
//!
//! The counts below are the contract asserted by the C++ mini-city demo's
//! `--self-test` (mini_city_main.cpp): drift here means the Rust port of
//! `truncateToFloors` no longer matches the proven scene construction.

use std::path::Path;

use vibe_land_destruction::city::{build_city_scene, CitySceneDesc};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::scene_pack::load_scene_pack_file;
use vibe_land_destruction::variants::{make_building_variants, MAXIMUM_FLOORS};

fn tower() -> vibe_land_destruction::scene_pack::ScenePack {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/scenes/fractured-tower.json");
    load_scene_pack_file(&path).expect("load fractured-tower.json")
}

#[test]
fn variant_counts_match_the_cpp_contract() {
    let pack = tower();
    let variants = make_building_variants(&pack, true).expect("variants");
    assert_eq!(variants.len(), MAXIMUM_FLOORS as usize);

    // Re-pinned 2026-08-13: the asset's centroids were corrected to exact
    // hull volume centroids (they had been authored ~21 cm off, median), and
    // floor truncation slices by centroid Y, so a few nodes legitimately
    // changed floors. The full tower (204/546) is untouched -- only the
    // cutoff moved relative to the corrected centroids.
    let expected = [(86, 213), (145, 365), (204, 546)];
    for (variant, (nodes, bonds)) in variants.iter().zip(expected) {
        assert_eq!(
            variant.pack.nodes.len(),
            nodes,
            "{}-floor node count",
            variant.floors
        );
        assert_eq!(
            variant.pack.bonds.len(),
            bonds,
            "{}-floor bond count",
            variant.floors
        );
        assert_eq!(
            variant.pack.support_node_count(),
            36,
            "{}-floor support nodes",
            variant.floors
        );
        // Connectivity sanity: no orphan nodes (every node touches a bond).
        let mut touched = vec![false; variant.pack.nodes.len()];
        for bond in &variant.pack.bonds {
            touched[bond.node0 as usize] = true;
            touched[bond.node1 as usize] = true;
        }
        assert!(
            touched.iter().all(|&t| t),
            "{}-floor has orphan nodes",
            variant.floors
        );
        // Heights must be strictly increasing with floors.
        assert!(variant.height > 0.0);
    }
    assert!(variants[0].height < variants[1].height);
    assert!(variants[1].height < variants[2].height);
}

#[test]
fn default_city_matches_plan_scale() {
    let pack = tower();
    let city = build_city_scene(&pack, CitySceneDesc::default()).expect("city");
    assert_eq!(city.instances.len(), 16);
    // 16 buildings cycling 3/2/1 floors: 6×204 + 5×148 + 5×83 = 2379 chunks.
    let expected_chunks: usize = city
        .instances
        .iter()
        .map(|i| city.variant_for(i).pack.nodes.len())
        .sum();
    assert_eq!(city.total_chunks(), expected_chunks);
    assert!(
        (2_000..3_400).contains(&city.total_chunks()),
        "total chunks {} outside planned envelope",
        city.total_chunks()
    );
    assert_eq!(city.grid_half_extent_m(), 27.0);

    // The first building (index 0) is a full 3-floor tower.
    assert_eq!(city.variant_for(&city.instances[0]).floors, 3);
}

#[test]
fn manifest_is_stable_and_reasonably_sized() {
    let pack = tower();
    let city = build_city_scene(&pack, CitySceneDesc::default()).expect("city");
    let manifest = DestructionManifest::from_city(&city);
    assert_eq!(manifest.structures.len(), 16);
    assert_eq!(manifest.total_chunks(), city.total_chunks());
    assert_eq!(manifest.total_bonds(), city.total_bonds());

    let again = DestructionManifest::from_city(
        &build_city_scene(&tower(), CitySceneDesc::default()).expect("city"),
    );
    assert_eq!(manifest.hash(), again.hash(), "manifest hash must be stable");

    let bytes = manifest.to_json_bytes();
    assert!(
        bytes.len() < 8 * 1024 * 1024,
        "manifest unexpectedly large: {} bytes",
        bytes.len()
    );
}
