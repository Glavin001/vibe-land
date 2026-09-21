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
        _ => return Err("usage: compare JSON VLSP | measure FILE | reject FILE".into()),
    }
    Ok(())
}
