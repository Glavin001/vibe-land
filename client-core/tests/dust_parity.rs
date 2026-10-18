//! The core's dust policy (dust.rs) against the web's (city/dustPolicy.ts): the fixture
//! client/scripts/dust-fixture.mts wrote (seeded sources of every kind, several a tick so the cap
//! drops some, every palette, smoulder ticks between) replayed through the port. Every parcel the
//! TypeScript spawned, in order, the same: seed, shape and palette exactly, numbers to f64
//! rounding of the trigonometry.

use serde_json::Value;
use vibe_client_core::dust::{palette_from_appearance, DustKind, DustPolicy, DustSource, Parcel};

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn kind(name: &str) -> DustKind {
    match name {
        "fracture" => DustKind::Fracture,
        "crush" => DustKind::Crush,
        "impact" => DustKind::Impact,
        "entry" => DustKind::Entry,
        "shed" => DustKind::Shed,
        "wave" => DustKind::Wave,
        other => panic!("kind {other}"),
    }
}

fn same(rust: &[Parcel], web: &[Value], what: &str, worst: &mut f64) {
    assert_eq!(rust.len(), web.len(), "{what}: parcel count");
    for (r, w) in rust.iter().zip(web) {
        assert_eq!(r.seed, w["seed"].as_u64().unwrap() as u32, "{what}: seed");
        assert_eq!(
            r.shape,
            w["shape"].as_u64().unwrap() as u32,
            "{what}: shape"
        );
        assert_eq!(
            r.palette,
            w["palette"].as_u64().unwrap() as u32,
            "{what}: palette"
        );
        let pairs = [
            (r.born_ms, f(&w["bornMs"])),
            (r.position[0], f(&w["x"])),
            (r.position[1], f(&w["y"])),
            (r.position[2], f(&w["z"])),
            (r.velocity[0], f(&w["vx"])),
            (r.velocity[1], f(&w["vy"])),
            (r.velocity[2], f(&w["vz"])),
            (r.radius0, f(&w["radius0"])),
            (r.intensity, f(&w["intensity"])),
        ];
        for (a, b) in pairs {
            let e = (a - b).abs() / b.abs().max(1.0);
            *worst = worst.max(e);
            assert!(e < 1e-9, "{what}: {a} vs {b}");
        }
    }
}

#[test]
fn dust_policy_matches_the_web() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dust_web.json");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).expect("fixture")).unwrap();
    for p in fixture["palettes"].as_array().unwrap() {
        assert_eq!(
            palette_from_appearance(p["name"].as_str(), p["textureKey"].as_str()),
            p["palette"].as_u64().unwrap() as u32,
            "palette of {p}"
        );
    }
    let mut policy = DustPolicy::default();
    let (mut parcels, mut worst, mut emits) = (Vec::new(), 0.0f64, 0);
    for op in fixture["ops"].as_array().unwrap() {
        parcels.clear();
        if let Some(t) = op.get("tick") {
            policy.tick(f(&t["nowMs"]), &mut parcels);
            same(
                &parcels,
                t["parcels"].as_array().unwrap(),
                "smoulder tick",
                &mut worst,
            );
        } else {
            let e = &op["emit"];
            let s = &e["source"];
            let source = DustSource {
                kind: kind(s["kind"].as_str().unwrap()),
                structure: s["structureId"].as_u64().unwrap() as u32,
                tick: s["simTick"].as_u64().unwrap() as u32,
                ordinal: s["ordinal"].as_u64().unwrap() as u32,
                position: [f(&s["x"]), f(&s["y"]), f(&s["z"])],
                normal: [f(&s["nx"]), f(&s["ny"]), f(&s["nz"])],
                velocity: [f(&s["vx"]), f(&s["vy"]), f(&s["vz"])],
                magnitude: f(&s["magnitude"]),
                material: s["material"].as_u64().unwrap() as u32,
                at_ms: f(&s["atMs"]),
            };
            let n = policy.emit(&source, e["palette"].as_u64().unwrap() as u32, &mut parcels);
            assert_eq!(u64::from(n), e["count"].as_u64().unwrap(), "count");
            same(
                &parcels,
                e["parcels"].as_array().unwrap(),
                "emit",
                &mut worst,
            );
            emits += 1;
        }
    }
    let stats = &fixture["stats"];
    assert_eq!(
        policy.stats.emitted,
        stats["emitted"].as_u64().unwrap(),
        "emitted"
    );
    assert_eq!(
        policy.stats.dropped_by_tick_cap,
        stats["droppedByTickCap"].as_u64().unwrap(),
        "dropped by the tick cap"
    );
    assert_eq!(
        policy.stats.dropped_by_palette,
        stats["droppedByPalette"].as_u64().unwrap(),
        "dropped by palette"
    );
    assert_eq!(
        policy.stats.smoulder_cells as u64,
        stats["smoulderCells"].as_u64().unwrap(),
        "smoulder cells"
    );
    eprintln!(
        "dust parity: {emits} sources, {} parcels, worst relative difference {worst:.2e}",
        policy.stats.emitted
    );
}
