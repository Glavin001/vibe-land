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

/// Dump a manifest in both formats, for weighing the decoders against each
/// other. `MANIFEST_DUMP_PACK` names the pack; output goes to /tmp.
#[test]
#[ignore = "measurement tool"]
fn dump_for_measurement() {
    let name = std::env::var("MANIFEST_DUMP_PACK").unwrap_or_else(|_| "algedra-tower".into());
    let manifest = manifest_for(&name);
    std::fs::write("/tmp/manifest-measure.bin", manifest.to_bytes()).expect("bin");
    std::fs::write("/tmp/manifest-measure.json", manifest.to_json_bytes()).expect("json");
    eprintln!(
        "[dump] {name}: binary {:.1} MB, json {:.1} MB, {} chunks, {} bonds",
        manifest.to_bytes().len() as f64 / 1e6,
        manifest.to_json_bytes().len() as f64 / 1e6,
        manifest.total_chunks(),
        manifest.total_bonds(),
    );
}

/// The town kit references every sloped hull from a corner (hull-origins.mjs),
/// so a veneer house's roof tiles, rafters and gables have their mass a metre
/// from their centroids. The manifest has to carry where it actually is --
/// PhysX centres each body there and island poses arrive in that frame -- and
/// the binary format has to keep it.
#[test]
fn veneer_house_hull_mass_offsets_reach_the_manifest_and_survive_the_round_trip() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../structures/town-kit/out/veneer-houses/veneer-house--no-front-studs.json");
    if !path.exists() {
        eprintln!("skipped: {} not built", path.display());
        return;
    }
    let pack = load_scene_pack_file(&path).expect("veneer pack");
    let manifest = DestructionManifest::from_city(&single_building_scene(&pack));
    let chunks = &manifest.structures[0].chunks;
    let off: Vec<_> = chunks
        .iter()
        .filter(|c| c.mass_offset.iter().any(|x| x.abs() > 0.01))
        .collect();
    let worst = off
        .iter()
        .map(|c| glam::Vec3::from_array(c.mass_offset).length())
        .fold(0.0f32, f32::max);
    eprintln!("[veneer] {} of {} chunks have their mass > 1 cm from their centroid (worst {worst:.3} m)", off.len(), chunks.len());
    // Every hull chunk of this pack still carries an exact offset; how many
    // are off-centre depends on the authoring (hull-origins.mjs).
    for c in chunks {
        let expected = vibe_land_destruction::variants::hull_mass_offset(manifest.hull_points(&c.geometry));
        assert!((glam::Vec3::from_array(c.mass_offset) - expected).length() < 1.0e-6, "node {}", c.node_index);
    }
    let decoded = manifest_binary::decode(&manifest_binary::encode(&manifest)).expect("decode");
    assert_eq!(decoded, manifest);
}

/// A manifest in format 1 (no mass offsets) still decodes, with zero offsets:
/// the checked-in TypeScript fixture is one.
#[test]
fn format_one_decodes_with_zero_mass_offsets() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../client/src/city/__fixtures__/manifest-rig-column.bin");
    let bytes = std::fs::read(&path).expect("fixture");
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 1, "fixture is format 1");
    let decoded = manifest_binary::decode(&bytes).expect("decode format 1");
    assert!(decoded.structures[0].chunks.iter().all(|c| c.mass_offset == [0.0; 3]));
}

/// Format-2 fixture with a corner-referenced hull, for the TypeScript decoder.
/// Regenerate with
/// `cargo test -p vibe-land-destruction --test manifest_binary -- --ignored write_ts_mass_offset_fixture`.
#[test]
#[ignore = "regenerates a checked-in fixture"]
fn write_ts_mass_offset_fixture() {
    use vibe_land_destruction::manifest::{BondDef, ChunkDef, ChunkGeometry, StructureManifest};
    let tile = vec![
        0., 0., 0., 1., 0., 0., 0., 0.1, 0., 1., 0.1, 0., 0., 0., 2., 1., 0., 2., 0., 0.1, 2., 1., 0.1, 2.,
    ];
    let offset = vibe_land_destruction::variants::hull_mass_offset(&tile).to_array();
    let manifest = DestructionManifest {
        version: vibe_land_destruction::manifest::MANIFEST_VERSION,
        structures: vec![StructureManifest {
            structure_id: 3,
            world_position: [10.0, 0.0, 0.0],
            world_rotation: [0.0, 0.0, 0.0, 1.0],
            chunks: vec![
                ChunkDef {
                    node_index: 0,
                    centroid: [0.0, 0.5, 0.0],
                    mass: 0.0,
                    volume: 1.0,
                    size: [1.0; 3],
                    geometry: ChunkGeometry::Cuboid { half_extents: [0.5; 3] },
                    radius: 0.87,
                    support: true,
                    material: 0,
                    mass_offset: [0.0; 3],
                },
                ChunkDef {
                    node_index: 1,
                    centroid: [0.0, 3.0, 0.0],
                    mass: 30.0,
                    volume: 0.2,
                    size: [1.0, 0.1, 2.0],
                    geometry: ChunkGeometry::ConvexHull { points: tile, shape_id: None },
                    radius: 2.24,
                    support: false,
                    material: 0,
                    mass_offset: offset,
                },
            ],
            bonds: vec![BondDef {
                bond_index: 0,
                node0: 0,
                node1: 1,
                centroid: [0.0, 1.0, 0.0],
                normal: [0.0, 1.0, 0.0],
                area: 1.0,
                material: 0,
            }],
        }],
        materials: Vec::new(),
        material_appearance: Vec::new(),
        shape_library: Vec::new(),
    };
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../client/src/city/__fixtures__/manifest-mass-offset.bin");
    std::fs::write(&path, manifest.to_bytes()).expect("write fixture");
    eprintln!("[fixture] mass offset {offset:?}");
}

/// Which packs have chunks whose mass is away from their centroid (the case
/// a client weighing centroids drew wrong). A survey, not a gate:
/// `MASS_OFFSET_PACKS` is a colon-separated list of pack paths (default: every
/// pack under destruction/assets/scenes).
#[test]
#[ignore = "survey"]
fn survey_mass_offsets() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let packs: Vec<PathBuf> = match std::env::var("MASS_OFFSET_PACKS") {
        Ok(list) => list.split(':').map(PathBuf::from).collect(),
        Err(_) => {
            let mut v: Vec<PathBuf> = std::fs::read_dir(root.join("assets/scenes"))
                .expect("scenes")
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect();
            v.sort();
            v
        }
    };
    for path in packs {
        let Ok(pack) = load_scene_pack_file(&path) else {
            eprintln!("[survey] {}: not a scene pack", path.display());
            continue;
        };
        let manifest = DestructionManifest::from_city(&single_building_scene(&pack));
        let chunks: Vec<_> = manifest.structures.iter().flat_map(|s| &s.chunks).collect();
        let hulls = chunks
            .iter()
            .filter(|c| matches!(c.geometry, vibe_land_destruction::manifest::ChunkGeometry::ConvexHull { .. }))
            .count();
        let lengths: Vec<f32> = chunks.iter().map(|c| glam::Vec3::from_array(c.mass_offset).length()).collect();
        let over = |m: f32| lengths.iter().filter(|l| **l > m).count();
        let worst = lengths.iter().copied().fold(0.0f32, f32::max);
        eprintln!(
            "[survey] {}: {} chunks, {hulls} hulls; mass > 1 mm from centroid: {}, > 1 cm: {}, > 10 cm: {}; worst {worst:.3} m",
            path.file_name().unwrap().to_string_lossy(),
            chunks.len(),
            over(0.001),
            over(0.01),
            over(0.1),
        );
    }
}
