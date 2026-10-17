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
