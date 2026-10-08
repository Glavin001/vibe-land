//! Calibration structures (structures/calibration, docs/calibration): standard
//! structures whose behaviour an engineer can predict, run on the real city
//! stage and measured, so a judge can hold the simulation to the prediction.
//!
//! One scene holds every case of a scenario side by side, each its own node
//! group (`case@<id>`): a bridge with no pier out, one out, two out, ... A case
//! is a static alternate-path analysis -- the structure without the removed
//! members from the first tick -- as GSA 2016 / UFC 4-023-03 run one (see
//! docs/calibration/README.md for why that is the engine's own load case).
//! This only measures; structures/calibration/judge.mjs decides.
//!
//!   VIBE_CITY_SCENE=<scene.json> VIBE_CALIB_OUT=<report.json> \
//!   PHYSX_ROOT=... CARGO_TARGET_DIR=... VIBE_GPU_SHARED=1 scripts/perf/gpu-run.sh calib \
//!     cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server \
//!       calibration_run -- --ignored --nocapture --test-threads=1
//!
//! (structures/calibration/run.mjs builds the scene, runs this and judges it.)
//!
//! VIBE_CALIB_TICKS     ticks to run (default 600: 10 s)
//! VIBE_CALIB_SAMPLE    every this many ticks, every chunk's position (default 30)
//! VIBE_CALIB_ROWS_AT   comma list of ticks at which every bond's stress row is kept (default 2,
//!                      the first solve at rest)
//! VIBE_CALIB_WAKE     every this many ticks, wake every body (default 0: never)
//! VIBE_CALIB_TRACE    per tick (the first 20, then every 60): each case's most utilised bond and
//!                      how many of its bonds read zero health or broken
//! VIBE_CALIB_CHARGES   a JSON file: [{"tick": t, "boxes": [[min, max], ...]}, ...] -- static
//!                      supports (plain PhysX boxes, not stage chunks) present from the start and
//!                      removed at `tick`: a charge that takes a member out (structures/calibration
//!                      implosion). Scene coordinates; the harness adds the scene's offset.
//!
//! Report: per case, bonds broken (with the tick and the stresses that broke
//! each), the stage's convergence, chunk positions over time; the stress row of
//! every bond at VIBE_CALIB_ROWS_AT for comparison with the hand calculation.
#![cfg(all(test, feature = "native-destruction"))]

use serde_json::{json, Value};
use std::collections::BTreeMap;

const DT: f32 = 1.0 / 60.0;

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// The native app's stress settings (sim-native city.rs apply_app_defaults),
/// for anything not already set, and the scene alone: one instance, no cars.
fn app_settings() {
    for (name, value) in [
        ("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1"),
        ("VIBE_NATIVE_STRESS_FORCE_TOLERANCE", "0.001"),
        ("BLAST_STRESS_INCREMENTAL_MOTION", "1"),
        ("PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "1"),
        ("BLAST_STRESS_BALANCED_OPERATOR", "1"),
        ("VIBE_CITY_GRID", "1"),
        ("VIBE_CITY_VARIED_HEIGHTS", "0"),
        ("VIBE_CITY_VEHICLES", "0"),
    ] {
        if std::env::var_os(name).is_none() {
            std::env::set_var(name, value);
        }
    }
}

/// A bond's stress row as JSON (the row type is the bridge's private FFI struct).
macro_rules! row_json {
    ($r:expr) => {{
        let r = $r;
        json!({"bond": r.bond_index, "node0": r.node0, "node1": r.node1, "material": r.material, "area": r.area,
            "utilisation": r.utilisation, "compression": r.compression, "tension": r.tension, "shear": r.shear,
            "normal": r.stress_normal, "bend": r.stress_bend, "damage": r.damage, "remaining": r.remaining_area, "broken": r.broken})
    }};
}

#[test]
#[ignore = "requires local GPU and the native-destruction SDK"]
fn calibration_run() {
    let _guard = crate::physx_runtime::tests::gpu_test_guard();
    app_settings();
    let scene = std::env::var("VIBE_CITY_SCENE").expect("VIBE_CITY_SCENE: the calibration scene");
    let out_path = std::env::var("VIBE_CALIB_OUT").expect("VIBE_CALIB_OUT: where the report goes");
    let ticks = env_u32("VIBE_CALIB_TICKS", 600);
    let sample = env_u32("VIBE_CALIB_SAMPLE", 30).max(1);
    let rows_at: Vec<u32> = std::env::var("VIBE_CALIB_ROWS_AT").unwrap_or_else(|_| "2".into())
        .split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let pack: Value = serde_json::from_slice(&std::fs::read(&scene).expect("scene pack")).expect("scene json");
    let s = &pack["scenario"];
    let nodes = s["nodes"].as_array().expect("nodes");
    let n = nodes.len();
    let groups: Vec<String> = s["nodeGroups"].as_array().map_or(vec!["case@0".into(); n], |g| g.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect());
    let case_of = |node: u32| -> String { groups.get(node as usize).map_or("?".into(), |g| g.split_once('@').map_or(g.clone(), |(_, c)| c.to_string())) };
    let anchor = nodes.iter().position(|v| v["mass"].as_f64() == Some(0.0)).expect("an anchor chunk") as u32;
    let centroid = |i: usize| -> [f32; 3] { let c = &nodes[i]["centroid"]; [c["x"].as_f64().unwrap() as f32, c["y"].as_f64().unwrap() as f32, c["z"].as_f64().unwrap() as f32] };

    let mut arena = crate::movement::PhysicsArena::new(vibe_netcode::movement::MoveConfig::default(),
        vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
    crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
    let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
    arena.set_tolerate_rejected_steps(city.backend_name() == "native");
    let gravity = vibe_netcode::movement::default_world_gravity();
    // Scene to world: where the stage put the first anchor (it never moves).
    let offset = {
        let aim = arena.physx_world_mut().unwrap().native_chunk_aim(0, anchor).expect("anchor chunk");
        assert!(aim.found, "anchor chunk {anchor} on the stage");
        let c = centroid(anchor as usize);
        [aim.center.x - c[0], aim.center.y - c[1], aim.center.z - c[2]]
    };

    // Charges (VIBE_CALIB_CHARGES): static supports removed at their tick (calibration_charges.rs).
    let mut charges = crate::calibration_charges::Charges::from_env();
    if let Some(c) = charges.as_mut() { c.apply(0, offset, arena.physx_world_mut().unwrap()); }

    let mut first_broken: BTreeMap<u32, (u32, Value)> = BTreeMap::new();
    let trace = std::env::var_os("VIBE_CALIB_TRACE").is_some();
    let wake = env_u32("VIBE_CALIB_WAKE", 0);
    let pokes: Vec<(u32, [f32; 3], f32, f32)> = std::env::var("VIBE_CALIB_POKES").ok().map(|path| {
        let v: Value = serde_json::from_slice(&std::fs::read(&path).expect("pokes file")).expect("pokes json");
        v.as_array().expect("pokes: a list").iter().map(|p| (p["tick"].as_u64().unwrap() as u32,
            [0, 1, 2].map(|k| p["at"][k].as_f64().unwrap() as f32), p["mass"].as_f64().unwrap_or(5.0) as f32, p["speed"].as_f64().unwrap_or(2.0) as f32)).collect()
    }).unwrap_or_default();
    let mut last_row: BTreeMap<u32, Value> = BTreeMap::new();
    let mut rows_kept: Vec<Value> = Vec::new();
    let mut positions: Vec<Value> = Vec::new();
    let mut unconverged = 0u32;
    let mut fractures: Vec<Value> = Vec::new();
    let mut iterations_max = 0u32;
    let mut errors: BTreeMap<u32, u32> = BTreeMap::new();
    let mut bond_case: BTreeMap<u32, String> = BTreeMap::new();
    let mut bonds_per_case: BTreeMap<String, u32> = BTreeMap::new();
    let snap = |arena: &mut crate::movement::PhysicsArena| -> Vec<f32> {
        let world = arena.physx_world_mut().unwrap();
        let mut p = Vec::with_capacity(3 * n);
        for i in 0..n as u32 {
            match world.native_chunk_aim(0, i) {
                Ok(a) if a.found => { p.extend([a.center.x - offset[0], a.center.y - offset[1], a.center.z - offset[2]]); }
                _ => { p.extend([f32::NAN, f32::NAN, f32::NAN]); }
            }
        }
        p
    };
    positions.push(json!({"tick": 0, "p": snap(&mut arena)}));
    let started = std::time::Instant::now();
    for tick in 1..=ticks {
        if let Some(c) = charges.as_mut() { c.apply(tick, offset, arena.physx_world_mut().unwrap()); }
        // VIBE_CALIB_POKES: a light ball dropped onto each listed point at its tick (is a structure
        // that should move held, or only asleep?): [{"tick", "at": [x, y, z], "mass", "speed"}].
        for p in &pokes {
            if p.0 == tick {
                let at = nalgebra::Vector3::new(p.1[0] + offset[0], p.1[1] + offset[1], p.1[2] + offset[2]);
                let from = at + nalgebra::Vector3::new(0.0, 0.6, 0.0);
                arena.launch_ball_from_muzzle(from, nalgebra::Vector3::new(0.0, -p.3, 0.0), 0.1, p.2, 300);
                eprintln!("[calibration] tick {tick}: poke at {:?}", p.1);
            }
        }
        // VIBE_CALIB_WAKE=N: wake every body every N ticks (is a piece at rest held, or only asleep?).
        if wake > 0 && tick % wake == 0 { arena.physx_world_mut().unwrap().wake_bodies_near(vibe_land_physx_bridge::Vec3::new(offset[0], offset[1], offset[2]), 1.0e4).ok(); }
        if trace && tick == 1 { arena.physx_world_mut().unwrap().native_set_stress_solve_report(1).ok(); }
        arena.step_vehicles_and_dynamics(DT);
        let _ = city.step(tick, DT, gravity, arena.physx_world_mut());
        let world = arena.physx_world_mut().unwrap();
        if trace && (tick <= 4 || tick % 60 == 0) {
            if let Ok(rep) = world.native_stress_solve_report() {
                let mut comps: Vec<String> = Vec::new();
                for c in &rep.components {
                    let chunk = rep.chunks.iter().find(|x| x.component == c.component).map(|x| x.node);
                    comps.push(format!("[{} n{} {} r{} it{} f2 {:.2e}/{:.2e}]", chunk.map_or("?".into(), |n| case_of(n)), c.chunk_count, if c.anchored { "A" } else { "free" }, c.reason, c.iterations, c.final2, c.tolerance2));
                }
                eprintln!("[calibration] tick {tick} solve report: {}", comps.join(" "));
                // The chunks with the largest contact input (m/s^2 of the chunk's stress input).
                let mut by: Vec<(f32, u32, f32, f32)> = rep.chunks.iter().map(|c| { let v = &c.contact_linear; ((v.x * v.x + v.y * v.y + v.z * v.z).sqrt(), c.node, v.y, { let g = &c.prepared_linear; g.y }) }).collect();
                by.sort_by(|a, b| b.0.total_cmp(&a.0));
                eprintln!("[calibration] tick {tick} contact inputs: {}", by.iter().take(6).map(|(m, n, y, g)| format!("{}#{n} |a| {m:.1} y {y:.1} (prepared y {g:.1})", case_of(*n))).collect::<Vec<_>>().join(", "));
            }
        }
        if let Ok(st) = world.native_last_status() {
            // What broke this tick: the trial's verdicts, then the corrected pass's (a cascade within the tick).
            if st.broken_bonds > 0 { fractures.push(json!({"tick": tick, "broken": st.broken_bonds, "postCorrection": st.post_correction_broken_bonds, "passes": st.correction_passes})); }
            if !st.converged { unconverged += 1; }
            iterations_max = iterations_max.max(st.iterations);
            if st.error != 0 { *errors.entry(st.error).or_insert(0) += 1; }
        }
        let rows = world.native_bond_stress_rows(0).unwrap_or_default();
        if bond_case.is_empty() {
            for r in &rows {
                let c = case_of(r.node0);
                bond_case.insert(r.bond_index, c.clone());
                *bonds_per_case.entry(c).or_insert(0) += 1;
            }
        }
        // A bond is broken when its health (remaining area, authored > 0) is gone: the
        // verdict's `broken` flag marks only the evaluation that broke it, and a bond
        // broken by a tick's trial is already at zero health in its corrected pass.
        if trace && (tick <= 20 || tick % 60 == 0) {
            let mut per: BTreeMap<String, (f32, u32, u32)> = BTreeMap::new();
            for r in &rows {
                let e = per.entry(bond_case.get(&r.bond_index).cloned().unwrap_or_default()).or_insert((0., 0, 0));
                e.0 = e.0.max(r.utilisation);
                if r.remaining_area <= 0.0 { e.1 += 1; }
                if r.broken { e.2 += 1; }
            }
            eprintln!("[calibration] tick {tick}: {}", per.iter().map(|(c, (u, z, b))| format!("{c} u {u:.3} zero {z} broken {b}")).collect::<Vec<_>>().join("; "));
        }
        for r in &rows {
            if r.broken || r.remaining_area <= 0.0 {
                if !first_broken.contains_key(&r.bond_index) {
                    let before = last_row.get(&r.bond_index).cloned().unwrap_or(Value::Null);
                    first_broken.insert(r.bond_index, (tick, json!({"at": row_json!(r), "before": before})));
                }
            } else if r.utilisation > 0.3 || last_row.contains_key(&r.bond_index) {
                last_row.insert(r.bond_index, row_json!(r));
            }
        }
        if rows_at.contains(&tick) {
            rows_kept.push(json!({"tick": tick, "rows": rows.iter().map(|r| row_json!(r)).collect::<Vec<_>>()}));
        }
        if tick % sample == 0 || tick == ticks {
            positions.push(json!({"tick": tick, "p": snap(&mut arena)}));
        }
    }
    let seconds = started.elapsed().as_secs_f64();
    // Per case: bonds broken (first tick), what broke.
    let mut cases: BTreeMap<String, Value> = BTreeMap::new();
    for (c, count) in &bonds_per_case {
        cases.insert(c.clone(), json!({"bonds": count, "broken": []}));
    }
    for (bond, (tick, detail)) in &first_broken {
        let c = bond_case.get(bond).cloned().unwrap_or_else(|| "?".into());
        let entry = cases.entry(c).or_insert_with(|| json!({"bonds": 0, "broken": []}));
        entry["broken"].as_array_mut().unwrap().push(json!({"bond": bond, "tick": tick, "detail": detail}));
    }
    let env: serde_json::Map<String, Value> = ["VIBE_SECTION_BENDING", "VIBE_SECTION_ROTATION", "VIBE_IMPACT_CAPACITY",
        "VIBE_CITY_NATIVE_STRESS_ITERATIONS", "VIBE_CITY_NATIVE_STRESS_TOLERANCE"]
        .iter().map(|k| (k.to_string(), json!(std::env::var(k).ok()))).collect();
    let report = json!({
        "scene": scene, "ticks": ticks, "dt": DT, "offset": offset, "nodes": n,
        "physxRoot": std::env::var("PHYSX_ROOT").ok(),
        "env": env,
        "stressIterations": vibe_land_destruction::native_runtime::stress_iterations(),
        "stressTolerance": vibe_land_destruction::native_runtime::stress_tolerance(),
        "unconvergedTicks": unconverged, "iterationsMax": iterations_max, "errors": errors,
        "brokenTotal": first_broken.len(), "wallSeconds": seconds, "fractureTicks": fractures,
        "cases": cases, "rows": rows_kept, "positions": positions,
    });
    std::fs::write(&out_path, serde_json::to_vec(&report).unwrap()).expect("write report");
    eprintln!("[calibration] {} ticks in {seconds:.1} s: {} bonds broken, {unconverged} unconverged ticks, report {out_path}", ticks, first_broken.len());
}
