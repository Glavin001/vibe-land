//! The binary manifest survives a round trip, byte for byte of meaning.
//!
//! A byte-layout bug does not announce itself: it produces a manifest that
//! decodes into plausible nonsense — chunks at the wrong centroids, bonds
//! joining the wrong pair — and the first symptom is a city that looks subtly
//! wrong on someone's screen. Encoding real authored packs and asserting the
//! decode equals the original is the only check that runs before that.

use std::path::{Path, PathBuf};

use vibe_land_destruction::city::{build_city_scene, single_building_scene, CitySceneDesc};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::manifest_binary;
use vibe_land_destruction::scene_pack::load_scene_pack_file;

fn pack_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("assets/scenes/{name}.json"))
}

fn manifest_for(name: &str) -> DestructionManifest {
    let pack = load_scene_pack_file(&pack_path(name)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    DestructionManifest::from_city(&single_building_scene(&pack))
}

#[test]
fn every_authored_manifest_round_trips() {
    for name in ["algedra-tower", "house-1story", "parking-garage", "rig-garage"] {
        if !pack_path(name).exists() {
            continue;
        }
        let manifest = manifest_for(name);
        let bytes = manifest_binary::encode(&manifest);
        assert!(
            manifest_binary::looks_binary(&bytes),
            "{name}: encoded bytes do not carry the magic"
        );
        let decoded = manifest_binary::decode(&bytes)
            .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));
        assert_eq!(decoded, manifest, "{name}: round trip changed the manifest");
    }
}

/// Hull points, shape-library ids and cuboids all coexist in one structure, and
/// each is stored differently. This is the case most likely to be mis-indexed.
#[test]
fn mixed_geometry_survives_the_round_trip() {
    let manifest = manifest_for("algedra-tower");
    let structure = &manifest.structures[0];
    let hulls = structure
        .chunks
        .iter()
        .filter(|c| {
            matches!(
                c.geometry,
                vibe_land_destruction::manifest::ChunkGeometry::ConvexHull { .. }
            )
        })
        .count();
    assert!(hulls > 0, "the tower should have hull chunks");

    let decoded = manifest_binary::decode(&manifest_binary::encode(&manifest)).expect("decode");
    let decoded_structure = &decoded.structures[0];
    for (before, after) in structure.chunks.iter().zip(&decoded_structure.chunks) {
        assert_eq!(before.geometry, after.geometry, "geometry changed");
        assert_eq!(before.centroid, after.centroid, "centroid changed");
    }
    for (before, after) in structure.bonds.iter().zip(&decoded_structure.bonds) {
        assert_eq!((before.node0, before.node1), (after.node0, after.node1));
        assert_eq!(before.normal, after.normal);
    }
}

/// A multi-structure city, so per-structure offsets are exercised rather than
/// the single-structure case where every base offset is zero.
#[test]
fn a_multi_structure_city_round_trips() {
    let pack = load_scene_pack_file(&pack_path("house-2story")).expect("load");
    let scene = build_city_scene(
        &pack,
        CitySceneDesc { grid: 2, pitch_m: 0.0, varied_heights: false },
    )
    .expect("scene");
    let manifest = DestructionManifest::from_city(&scene);
    assert!(manifest.structures.len() > 1, "expected several structures");
    let decoded = manifest_binary::decode(&manifest_binary::encode(&manifest)).expect("decode");
    assert_eq!(decoded, manifest);
}

/// JSON must still be recognisable as not-binary, so a client can tell the two
/// apart by looking rather than by guessing from a version field it cannot
/// reach until after it has parsed.
#[test]
fn json_is_not_mistaken_for_binary() {
    let manifest = manifest_for("house-1story");
    assert!(!manifest_binary::looks_binary(&manifest.to_json_bytes()));
    assert!(manifest_binary::looks_binary(&manifest.to_bytes()));
}

/// The whole point: it has to be dramatically smaller than the text it replaces.
#[test]
fn binary_is_far_smaller_than_json() {
    let manifest = manifest_for("algedra-tower");
    let json = manifest.to_json_bytes().len();
    let binary = manifest.to_bytes().len();
    eprintln!(
        "[measure] algedra-tower manifest: json {:.1} MB, binary {:.1} MB ({:.0}% smaller)",
        json as f64 / 1e6,
        binary as f64 / 1e6,
        (1.0 - binary as f64 / json as f64) * 100.0,
    );
    assert!(
        binary * 2 < json,
        "binary {binary} vs json {json}: not worth the format"
    );
}

/// Write a fixture the TypeScript decoder reads back.
///
/// The encoder and the decoder are in different languages, so nothing else in
/// either test suite covers the seam between them: Rust round-trips against
/// Rust, and the client's tests have no encoder to round-trip against. A byte
/// laid down in the wrong order here is invisible to both and shows up as a
/// city drawn from scrambled numbers.
///
/// Ignored so a normal run does not rewrite a checked-in file; regenerate with
/// `cargo test -p vibe-land-destruction --test manifest_binary -- --ignored write_ts_fixture`.
#[test]
#[ignore = "regenerates a checked-in fixture"]
fn write_ts_fixture() {
    let manifest = manifest_for("rig-column");
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../client/src/city/__fixtures__/manifest-rig-column.bin");
    std::fs::create_dir_all(path.parent().unwrap()).expect("fixture dir");
    std::fs::write(&path, manifest.to_bytes()).expect("write fixture");
    // The expectations the TS test asserts against, so the two cannot drift
    // silently: if the pack is re-authored, this prints the new truth.
    let s = &manifest.structures[0];
    eprintln!(
        "[fixture] chunks={} bonds={} first_centroid={:?} first_bond=({},{}) shapes={}",
        s.chunks.len(),
        s.bonds.len(),
        s.chunks[0].centroid,
        s.bonds[0].node0,
        s.bonds[0].node1,
        manifest.shape_library.len(),
    );
}
