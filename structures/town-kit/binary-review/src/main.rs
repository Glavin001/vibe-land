use sha2::{Digest, Sha256};
use std::{path::Path, time::Instant};
use vibe_land_destruction::scene_pack::{load_scene_pack_file, SceneCollider, ScenePack};
fn fingerprint(p: &ScenePack) -> String {
    let mut h = Sha256::new();
    h.update(format!(
        "{:?}",
        (
            &p.title,
            p.version,
            &p.materials,
            &p.appearances,
            &p.stress_limits
        )
    ));
    for n in &p.nodes {
        h.update(format!("{:?}", n));
    }
    for b in &p.bonds {
        h.update(format!("{:?}", b));
    }
    for v in &p.node_sizes {
        h.update(format!("{:?}", v));
    }
    for c in &p.node_colliders {
        h.update(format!("{:?}", c));
    }
    h.update(format!("{:?}", (&p.node_types, &p.node_pieces)));
    format!("{:x}", h.finalize())
}
fn compare(a: &ScenePack, b: &ScenePack) {
    assert_eq!(a.nodes.len(), b.nodes.len());
    assert_eq!(a.bonds.len(), b.bonds.len());
    for (i, (x, y)) in a.nodes.iter().zip(&b.nodes).enumerate() {
        assert_eq!(format!("{:?}", x), format!("{:?}", y), "node {i}");
    }
    for (i, (x, y)) in a.bonds.iter().zip(&b.bonds).enumerate() {
        assert_eq!(format!("{:?}", x), format!("{:?}", y), "bond {i}");
    }
    for (i, (x, y)) in a.node_colliders.iter().zip(&b.node_colliders).enumerate() {
        assert_eq!(format!("{:?}", x), format!("{:?}", y), "collider {i}");
    }
    assert_eq!(
        fingerprint(a),
        fingerprint(b),
        "all runtime fields, material/shape IDs and piece identities must agree"
    );
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("compare") => {
            let a = load_scene_pack_file(Path::new(&args[2]))?;
            let b = load_scene_pack_file(Path::new(&args[3]))?;
            compare(&a, &b);
            println!(
                "{}",
                serde_json::json!({"passed":true,"chunks":b.nodes.len(),"bonds":b.bonds.len(),"fingerprint":fingerprint(&b)})
            );
        }
        Some("partition") => {
            let bytes = std::fs::read(&args[2])?;
            let original = vibe_land_destruction::scene_binary::decode(&bytes)?;
            let scene = vibe_land_destruction::scene_binary::decode_city(&bytes)?;
            let mut rebuilt = original.clone();
            rebuilt.nodes.clear(); rebuilt.bonds.clear(); rebuilt.node_sizes.clear();
            rebuilt.node_colliders.clear(); rebuilt.node_types.clear(); rebuilt.node_pieces.clear();
            let descriptor_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
            let descriptor: serde_json::Value = serde_json::from_slice(&bytes[64..64+descriptor_len])?;
            assert_eq!(scene.instances.len(), descriptor["instances"].as_array().unwrap().len(), "one runtime structure per placement");
            let mut body_ids = std::collections::HashSet::new();
            let mut chunk_ids = std::collections::HashSet::new();
            let mut bond_ids = std::collections::HashSet::new();
            let mut counts = Vec::new();
            for instance in &scene.instances {
                let p = &scene.variant_for(instance).pack;
                for serial in [0, 1, vibe_land_destruction::ids::MAX_ISLAND_SERIALS - 1] {
                    let entity = vibe_land_destruction::ids::body_entity(instance.structure_id, serial);
                    assert!(body_ids.insert(entity));
                    assert_eq!(vibe_land_destruction::ids::body_entity_parts(entity), (instance.structure_id, serial));
                }
                let base = rebuilt.nodes.len() as u32;
                counts.push((p.nodes.len(), p.bonds.len()));
                for n in 0..p.nodes.len() {
                    assert!(chunk_ids.insert(vibe_land_destruction::ids::chunk_id(instance.structure_id, n as u32)));
                }
                for (j, bond) in p.bonds.iter().enumerate() {
                    assert!(bond_ids.insert(vibe_land_destruction::ids::bond_id(instance.structure_id, j as u32)));
                    assert!((bond.node0 as usize) < p.nodes.len() && (bond.node1 as usize) < p.nodes.len());
                    let mut b = *bond; b.node0 += base; b.node1 += base; rebuilt.bonds.push(b);
                }
                rebuilt.nodes.extend_from_slice(&p.nodes);
                rebuilt.node_sizes.extend_from_slice(&p.node_sizes);
                rebuilt.node_colliders.extend_from_slice(&p.node_colliders);
                rebuilt.node_types.extend_from_slice(&p.node_types);
                rebuilt.node_pieces.extend_from_slice(&p.node_pieces);
            }
            compare(&original, &rebuilt);
            let manifest = vibe_land_destruction::manifest::DestructionManifest::from_city(&scene);
            assert_eq!(manifest.structures.len(), scene.instances.len());
            println!("{}", serde_json::json!({"passed":true,"structures":counts,"chunks":chunk_ids.len(),"bonds":bond_ids.len(),"fingerprint":fingerprint(&rebuilt)}));
        }
        Some("warm") => {
            let bytes = std::fs::read(&args[2])?;
            let warm = vibe_land_destruction::scene_warm::decode(&bytes)?;
            let cold = vibe_land_destruction::scene_binary::decode(warm.scene)?;
            compare(&cold, &load_scene_pack_file(Path::new(&args[2]))?);
            assert!(warm.compatible(&warm.descriptor.runtime_sha256, [0.,-9.81,0.], 1./60., 1e-5));
            assert!(!warm.compatible("wrong-runtime", [0.,-9.81,0.], 1./60., 1e-5));
            assert!(!warm.compatible(&warm.descriptor.runtime_sha256, [0.,-1.,0.], 1./60., 1e-5));
            assert!(!warm.compatible(&warm.descriptor.runtime_sha256, [0.,-9.81,0.], 1./30., 1e-5));
            let raw: Vec<u8> = warm.values.iter().flat_map(|v| v.to_le_bytes()).collect();
            println!("{}", serde_json::json!({"passed":true,"values":warm.values.len(),
                "sha256":vibe_land_destruction::scene_warm::sha256(&raw),"structures":warm.descriptor.structures.len()}));
        }
        Some("reject") => {
            assert!(load_scene_pack_file(Path::new(&args[2])).is_err());
            println!("rejected malformed bundle");
        }
        Some("measure") => {
            let start = Instant::now();
            let p = load_scene_pack_file(Path::new(&args[2]))?;
            let ms = start.elapsed().as_secs_f64() * 1000.;
            let hulls = p
                .node_colliders
                .iter()
                .filter(|c| matches!(c, SceneCollider::ConvexHull { .. }))
                .count();
            let rss = std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("VmHWM:"))
                        .map(String::from)
                });
            println!(
                "{}",
                serde_json::json!({"bytes":std::fs::metadata(&args[2])?.len(),"loadMilliseconds":ms,"peakMemory":rss,"chunks":p.nodes.len(),"bonds":p.bonds.len(),"hulls":hulls,"fingerprint":fingerprint(&p)})
            );
        }
        _ => return Err("usage: compare JSON VLSP | measure FILE | partition VLSP | reject FILE".into()),
    }
    Ok(())
}
