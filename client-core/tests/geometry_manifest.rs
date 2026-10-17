//! Chunk meshes for whole cities built the way the server builds them, checked against what the
//! manifest says each chunk is: every mesh closed with outward faces, and its volume equal to the
//! chunk's authored `volume` (the volume PhysX cooks, so the drawn chunk is the simulated one).

use std::collections::HashMap;
use std::path::Path;

use glam::Vec3;
use vibe_client_core::coords::Space;
use vibe_client_core::geometry::{ChunkMeshes, VL_MESH_HULL};
use vibe_land_destruction::city::{build_city_scene, CitySceneDesc};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::scene_pack::load_scene_pack_file;

fn city(scene: &str, grid: u32) -> DestructionManifest {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../destruction/assets/scenes").join(scene);
    let pack = load_scene_pack_file(&path).unwrap_or_else(|e| panic!("{scene}: {e}"));
    let desc = CitySceneDesc { grid, ..CitySceneDesc::default() };
    DestructionManifest::from_city(&build_city_scene(&pack, desc).expect("city scene"))
}

struct Report {
    chunks: usize,
    hulls: usize,
    worst_volume_error: f32,
}

/// Checks every chunk of `manifest` in server space and returns how many were hulls.
fn check(manifest: &DestructionManifest) -> Report {
    let meshes = ChunkMeshes::build(manifest, Space::Server);
    let defs: Vec<_> = manifest.structures.iter().flat_map(|s| s.chunks.iter()).collect();
    assert_eq!(meshes.chunk_count(), defs.len(), "one mesh per chunk, in chunk-table order");

    let mut report = Report { chunks: defs.len(), hulls: 0, worst_volume_error: 0.0 };
    for (i, def) in defs.iter().enumerate() {
        let (positions, _, indices) = meshes.chunk(i).unwrap();
        let p: Vec<Vec3> = positions.iter().map(|v| Vec3::from_array(*v)).collect();
        assert!(!indices.is_empty() && indices.len() % 3 == 0, "chunk {i}: no triangles");

        // Closed and consistently wound: every directed edge once, its reverse once.
        let key = |v: Vec3| ((v.x * 1e5).round() as i64, (v.y * 1e5).round() as i64, (v.z * 1e5).round() as i64);
        let mut edges: HashMap<_, i32> = HashMap::new();
        for t in indices.chunks_exact(3) {
            for k in 0..3 {
                *edges.entry((key(p[t[k] as usize]), key(p[t[(k + 1) % 3] as usize]))).or_default() += 1;
            }
        }
        for (&(a, b), &n) in &edges {
            assert!(n == 1 && edges.get(&(b, a)) == Some(&1), "chunk {i}: open or inconsistent edge {a:?}->{b:?}");
        }

        let volume: f32 = indices
            .chunks_exact(3)
            .map(|t| p[t[0] as usize].dot(p[t[1] as usize].cross(p[t[2] as usize])))
            .sum::<f32>()
            / 6.0;
        assert!(volume > 0.0, "chunk {i}: faces point inward (volume {volume})");
        if meshes.ranges[i].flags & VL_MESH_HULL != 0 {
            report.hulls += 1;
        }
        // Relative to the chunk's authored volume; f32 sums over ~100 triangles of metre-scale
        // coordinates carry ~1e-6 relative error each.
        let error = (volume - def.volume).abs() / def.volume.max(f32::MIN_POSITIVE);
        report.worst_volume_error = report.worst_volume_error.max(error);
        assert!(error < 1e-3, "chunk {i} (node {}): mesh volume {volume} vs authored {}", def.node_index, def.volume);
    }
    report
}

#[test]
fn box_city_meshes_match_their_chunks() {
    let r = check(&city("high-rise-3f-local.json", 2));
    assert_eq!(r.hulls, 0, "an all-cuboid pack");
    assert!(r.chunks > 0);
    eprintln!("high-rise-3f-local: {} chunks, worst relative volume error {:.2e}", r.chunks, r.worst_volume_error);
}

#[test]
fn hull_city_meshes_match_their_chunks() {
    let r = check(&city("fractured-downtown.json", 1));
    assert!(r.hulls > 0, "fractured-downtown carries convex hulls");
    eprintln!(
        "fractured-downtown: {} chunks, {} hulls, worst relative volume error {:.2e}",
        r.chunks, r.hulls, r.worst_volume_error
    );
}

/// Every face of every chunk wears a catalog material; top-facing faces wear the chunk's floor
/// material and side faces its wall material.
fn check_surfaces(manifest: &DestructionManifest) -> std::collections::BTreeSet<String> {
    use vibe_client_core::materials::{chunk_surfaces, Catalog};
    let catalog = Catalog::get();
    let surfaces = chunk_surfaces(manifest, catalog);
    let meshes = ChunkMeshes::build_with_surfaces(manifest, Space::Server, Some((&surfaces, catalog)));
    assert_eq!(meshes.materials.len(), meshes.positions.len());
    assert_eq!(meshes.tile_uvs.len(), meshes.positions.len());
    let mut used = std::collections::BTreeSet::new();
    for (i, s) in surfaces.iter().enumerate() {
        let r = meshes.ranges[i];
        for v in r.first_vertex..r.first_vertex + r.vertex_count {
            let (n, m) = (meshes.normals[v as usize], meshes.materials[v as usize]);
            let up = n[1].abs() >= n[0].abs() && n[1].abs() >= n[2].abs();
            assert_eq!(m, u32::from(if up { s.floor } else { s.wall }), "chunk {i} vertex {v}");
            assert!((m as usize) < catalog.ids.len());
            // Tiles as the web draws them: metres / (catalog tile × cityTexScale 2).
            let (uv, tile) = (meshes.uvs[v as usize], meshes.tile_uvs[v as usize]);
            let drawn = catalog.materials[m as usize].metres_per_tile * 2.0;
            assert!((tile[0] * drawn - uv[0]).abs() < 1e-3 && (tile[1] * drawn - uv[1]).abs() < 1e-3, "chunk {i} vertex {v}");
            used.insert(catalog.ids[m as usize].clone());
        }
    }
    used
}

#[test]
fn stock_city_surfaces_follow_the_building_hash() {
    let used = check_surfaces(&city("high-rise-3f-local.json", 4));
    // 16 buildings hashed over 8 wall and 2 floor layers: several distinct walls, and floors.
    assert!(used.iter().filter(|id| id.contains("floor")).count() >= 1, "{used:?}");
    assert!(used.len() >= 4, "{used:?}");
}

#[test]
fn authored_pack_surfaces_follow_texture_keys() {
    // house-1story: brick walls and a concrete slab (texture keys), a wood frame with no texture key
    // (by name: timber), glazing (authored opacity: glass), concrete-wall footings.
    let used = check_surfaces(&city("house-1story.json", 1));
    for id in ["brick", "concrete-floor", "aged-timber", "glass", "concrete-wall"] {
        assert!(used.contains(id), "house-1story should show {id}: {used:?}");
    }
}

/// Sound occlusion (occlusion.ts): a ray through a standing building is blocked, one over the
/// roofs or along open ground is not.
#[test]
fn standing_buildings_block_sound() {
    use vibe_client_core::city::CityStream;
    let manifest = city("high-rise-3f-local.json", 1);
    let stream = CityStream::new(&manifest, 60, Space::Server);
    // The building's bounding box in server space, from its chunks at rest.
    let (mut lo, mut hi) = (glam::Vec3::splat(f32::MAX), glam::Vec3::splat(f32::MIN));
    for s in &manifest.structures {
        let (p, q) = (glam::Vec3::from_array(s.world_position), glam::Quat::from_array(s.world_rotation).normalize());
        for c in &s.chunks {
            let w = p + q * glam::Vec3::from_array(c.centroid);
            lo = lo.min(w);
            hi = hi.max(w);
        }
    }
    let centre = (lo + hi) * 0.5;
    let reach = (hi - lo).length() + 20.0;
    let low = centre.y.min(lo.y + 2.0);
    let through = (glam::Vec3::new(centre.x - reach, low, centre.z), glam::Vec3::new(centre.x + reach, low, centre.z));
    assert!(stream.segment_blocked(through.0, through.1, 0.7), "through the building");
    let over = hi.y + 30.0;
    assert!(!stream.segment_blocked(glam::Vec3::new(through.0.x, over, centre.z), glam::Vec3::new(through.1.x, over, centre.z), 0.7), "over the roof");
    assert!(!stream.segment_blocked(glam::Vec3::new(centre.x + reach, low, centre.z), glam::Vec3::new(centre.x + reach, low, centre.z + 40.0), 0.7), "open ground");
}

/// An import step's city (CityModel, from the manifest bytes alone) is the one a client builds when
/// the manifest arrives: the session's hash, the same chunk table and the same meshes, so baked
/// assets line up chunk for chunk with what the session later breaks.
#[test]
fn city_model_matches_the_client() {
    use sha2::{Digest, Sha256};
    use vibe_client_core::city::{CityModel, CityStream};
    let manifest = city("high-rise-3f-local.json", 2);
    let bytes = vibe_land_destruction::manifest_binary::encode(&manifest);
    let model = CityModel::from_manifest(&bytes, Space::Unreal).expect("model");
    assert_eq!(model.hash, hex::encode(Sha256::digest(&bytes)));
    let stream = CityStream::new(&manifest, 60, Space::Unreal);
    assert_eq!(model.chunks.as_slice(), stream.chunks(), "chunk table");
    let client = vibe_client_core::city::city_tables(&manifest, Space::Unreal).2;
    assert_eq!(model.meshes.positions, client.positions);
    assert_eq!(model.meshes.indices, client.indices);
    assert_eq!(model.meshes.materials, client.materials);
    assert_eq!(model.meshes.ranges.len(), model.chunks.len(), "one mesh per chunk");
}
