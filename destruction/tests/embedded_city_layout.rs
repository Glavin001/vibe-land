//! Authoring/protocol gate for 256 physical buildings within 64 asset IDs.
//! This is a CPU fixture test, not a simulation or performance qualification.
use glam::Vec3;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use vibe_land_destruction::{
    city, ids, manifest::DestructionManifest, manifest_binary, scene_pack::load_scene_pack_file,
};

#[test]
fn four_building_tile_preserves_each_building_and_disconnected_graph() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/scenes");
    let raw_base: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("embedded-penetration.json")).unwrap())
            .unwrap();
    let raw_tile: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("embedded-four-buildings.json")).unwrap())
            .unwrap();
    assert_eq!(
        raw_base["defaults"], raw_tile["defaults"],
        "physical laws changed"
    );
    for key in ["nodeColliders", "nodeSizes", "nodeTypes"] {
        let expected = raw_base["scenario"][key].as_array().unwrap();
        let actual = raw_tile["scenario"][key].as_array().unwrap();
        for building in actual.chunks_exact(444) {
            assert_eq!(building, expected);
        }
    }
    let base = load_scene_pack_file(&root.join("embedded-penetration.json")).unwrap();
    let tile = load_scene_pack_file(&root.join("embedded-four-buildings.json")).unwrap();
    assert_eq!((tile.nodes.len(), tile.bonds.len()), (1776, 3584));
    let mut adjacency = vec![Vec::new(); tile.nodes.len()];
    for bond in &tile.bonds {
        let (a, b) = (bond.node0 as usize, bond.node1 as usize);
        assert_eq!(a / 444, b / 444, "bond crosses buildings");
        adjacency[a].push(b);
        adjacency[b].push(a);
    }
    let mut visited = vec![false; tile.nodes.len()];
    let mut sizes = Vec::new();
    for start in 0..tile.nodes.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let mut todo = vec![start];
        let mut size = 0;
        while let Some(node) = todo.pop() {
            size += 1;
            for &other in &adjacency[node] {
                if !visited[other] {
                    visited[other] = true;
                    todo.push(other);
                }
            }
        }
        sizes.push(size);
    }
    assert_eq!(
        sizes,
        vec![444; 4],
        "must keep four independent motion components"
    );
    for building in 0..4 {
        let offset = Vec3::new(
            if building % 2 == 0 { -8.98 } else { 8.98 },
            0.,
            if building < 2 { -8.98 } else { 8.98 },
        );
        for (node, reference) in tile.nodes[building * 444..(building + 1) * 444]
            .iter()
            .zip(&base.nodes)
        {
            assert!((node.centroid - reference.centroid - offset).length() < 2e-6);
            assert_eq!(node.mass, reference.mass);
            assert_eq!(node.volume, reference.volume);
            assert_eq!(node.material, reference.material);
        }
        for (bond, reference) in tile.bonds[building * 896..(building + 1) * 896]
            .iter()
            .zip(&base.bonds)
        {
            assert_eq!(bond.node0, reference.node0 + building as u32 * 444);
            assert_eq!(bond.node1, reference.node1 + building as u32 * 444);
            assert!((bond.centroid - reference.centroid - offset).length() < 2e-6);
            assert_eq!(bond.normal, reference.normal);
            assert_eq!(bond.area, reference.area);
            assert_eq!(bond.material, reference.material);
        }
    }
}

#[test]
fn full_256_building_city_round_trips_without_identity_aliases() {
    let pack = load_scene_pack_file(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/scenes/embedded-four-buildings.json"),
    )
    .unwrap();
    let scene = city::build_city_scene(
        &pack,
        city::CitySceneDesc {
            grid: 8,
            pitch_m: 0.,
            varied_heights: false,
        },
    )
    .unwrap();
    assert_eq!(scene.instances.len(), 64);
    assert_eq!(
        (scene.total_chunks(), scene.total_bonds()),
        (113664, 229376)
    );
    // Tiles and the buildings inside them must form a regular 16 x 16 city.
    let mut coordinates = BTreeSet::new();
    let mut chunk_ids = HashSet::new();
    let mut bond_ids = HashSet::new();
    let mut body_ids = HashSet::new();
    for instance in &scene.instances {
        for local in [-8.98, 8.98] {
            coordinates.insert(((instance.offset.x + local) * 100.).round() as i32);
        }
        for node in 0..1776 {
            let id = ids::chunk_id(instance.structure_id, node);
            assert!(chunk_ids.insert(id));
            assert_eq!(ids::chunk_id_parts(id), (instance.structure_id, node));
        }
        for bond in 0..3584 {
            let id = ids::bond_id(instance.structure_id, bond);
            assert!(bond_ids.insert(id));
            assert_eq!(ids::bond_id_parts(id), (instance.structure_id, bond));
        }
        for serial in [0, 1, 1776, ids::MAX_ISLAND_SERIALS - 1] {
            let id = ids::body_entity(instance.structure_id, serial);
            assert!(body_ids.insert(id));
            assert_eq!(ids::body_entity_parts(id), (instance.structure_id, serial));
        }
    }
    let coordinates: Vec<_> = coordinates.into_iter().collect();
    assert_eq!(coordinates.len(), 16);
    assert!(coordinates.windows(2).all(|pair| pair[1] - pair[0] == 1796));
    let manifest = DestructionManifest::from_city(&scene);
    let bytes = manifest_binary::encode(&manifest);
    assert_eq!(manifest_binary::decode(&bytes).unwrap(), manifest);
    eprintln!(
        "CPU authoring/wire gate: 256 disconnected buildings, 64 asset instances, \
               113664 chunks, 229376 bonds, binary manifest {} bytes; no physics timing",
        bytes.len()
    );
}
