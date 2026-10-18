//! Destructible cars in the real city stage (city_fleet), on the GPU.
//!
//! The garage tests run a car alone in its own stage; the city runs it inside
//! the city's native stage with 16 buildings, and a wreck there rocked where
//! the garage's did not (2026-09-30, e2e/vehicle-qa.mjs demo-destruction:
//! 25 monster-truck pieces flipping between two orientations, 1,194 flips).
//! This builds the scene the way the match does -- production arena, the
//! city world document, fleet cars registered before the city opens its
//! stage, then per tick the arena step followed by the city step -- and
//! counts loose pieces that flip A -> B -> A.
//!
//! What it found: thin pieces (frame tubes, 1-5 kg, ~0.0002 kg m^2 about the
//! long axis) wedged between the ground and a building's base or the wreck,
//! pushed out at 2 m/s every tick, rolled about that axis instead of lifting
//! and flipped between two orientations for the whole match. The car's
//! depenetration cap (native_destruction.cc vehicle_depenetration_velocity)
//! fixed it (0.5 m/s); VIBE_VEHICLE_MAX_DEPENETRATION_VELOCITY=2 brings it back.
//!
//!   PHYSX_ROOT=../PhysX/out/install/garage-multihull CARGO_TARGET_DIR=target/garage-vehicles \
//!   VIBE_VEHICLE_BUILD_FIXTURES=$PWD/target/vehicle-build-fixtures.json \
//!   scripts/perf/gpu-run.sh city cargo test --release -p web-fps-server --features native-destruction \
//!     --bin web-fps-server city_fleet_tests -- --ignored --nocapture --test-threads=1
//!
//! VIBE_CITY_FLEET_VARIANT=n for another wreck; VIBE_CITY_TRACE_PART=<part id>
//! (with _FROM, _TICKS) to print that part's body tick by tick.
#![cfg(all(test, feature = "native-destruction"))]

use nalgebra::Vector3;
use std::collections::HashMap;

const DT: f32 = 1.0 / 60.0;

fn fixture(model: &str) -> crate::vehicle_assets::PreparedGeometry {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(
        std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("VIBE_VEHICLE_BUILD_FIXTURES fixture manifest")).unwrap()).unwrap();
    let f = manifest.as_array().unwrap().iter().find(|f| f["name"] == model).expect("fixture");
    let mut geometry: crate::vehicle_assets::PreparedGeometry =
        serde_json::from_slice(&std::fs::read(f["metadataPath"].as_str().unwrap()).unwrap()).unwrap();
    geometry.driving = Some(serde_json::from_value(f["driving"].clone()).unwrap());
    geometry
}

fn angle(a: [f32; 4], b: [f32; 4]) -> f32 {
    2. * (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]).abs().min(1.).acos().to_degrees()
}

/// The monster truck parked on the ring, hit by the city's meteor, then 15 s
/// of rest. VIBE_CITY_FLEET_REST_TICKS (default 900).
#[test]
#[ignore = "requires local GPU, the native-destruction SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn city_wreck_pieces_do_not_rock() {
    city_wreck("monster", 0, Attack::Meteor);
}

/// The buggy in its slot, shot three times 2.5 s apart with the city
/// cannonball from where a player stands 21 m away (the demo-destruction
/// scenario), then 15 s of rest. The live run rocked two loose groups ~850
/// times each, and the client received exactly those rotations.
#[test]
#[ignore = "requires local GPU, the native-destruction SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn city_cannonballed_buggy_pieces_do_not_rock() {
    city_wreck("buggy", 4, Attack::Cannonballs(3));
}

enum Attack { Meteor, Cannonballs(u32) }

fn city_wreck(model: &str, slot: usize, attack: Attack) {
    let _guard = crate::physx_runtime::tests::gpu_test_guard();
    std::env::set_var("VIBE_GARAGE_VEHICLE_DESTRUCTION", "1");
    std::env::set_var("VIBE_CITY_DESTRUCTIBLE_VEHICLES", "1");
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    // What the city server ships (scripts/perf/garage-vehicle-server.sh): the
    // incremental motion forest and cluster mass properties. Set either to 0 for
    // the full rebuilds.
    for flag in ["BLAST_STRESS_INCREMENTAL_MOTION", "PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "BLAST_STRESS_BALANCED_OPERATOR"] {
        if std::env::var_os(flag).is_none() { std::env::set_var(flag, "1"); }
    }
    let rest: u32 = std::env::var("VIBE_CITY_FLEET_REST_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(900);
    // VIBE_CITY_FLEET_VARIANT=n: another wreck of the same kind (meteor seed
    // 11+n; shots from 1.5 m further along per n), since one pile of debris is
    // one sample.
    let variant: u32 = std::env::var("VIBE_CITY_FLEET_VARIANT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let geometry = fixture(model);
    let mut arena = crate::movement::PhysicsArena::new(vibe_netcode::movement::MoveConfig::default(),
        vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
    crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
    // Where the fleet parks this slot's car, facing downtown (city_fleet SLOTS).
    let (x, z) = crate::city_fleet::slot_position(slot);
    let yaw = (-x).atan2(-z);
    let id = crate::city_fleet::FIRST_ID + slot as u32;
    arena.spawn_prepared_vehicle_at(id, 0, Vector3::new(x, geometry.origin_height as f32 + 0.15, z),
        [0., (yaw * 0.5).sin(), 0., (yaw * 0.5).cos()], &geometry).expect("spawn");
    arena.enable_external_vehicle_destruction(id, &geometry).expect("register");
    let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
    arena.mark_vehicle_destruction_configured();
    let gravity = vibe_netcode::movement::default_world_gravity();
    let mut tick = 0u32;
    let mut step_times: Vec<f32> = Vec::new();
    let mut step = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32| {
        let t0 = std::time::Instant::now();
        arena.step_vehicles_and_dynamics(DT);
        let _ = city.step(*tick, DT, gravity, arena.physx_world_mut());
        step_times.push(t0.elapsed().as_secs_f32() * 1000.);
        *tick += 1;
        trace_part(arena, id, &geometry, *tick);
    };
    for _ in 0..120 { step(&mut arena, &mut city, &mut tick); }
    let impact = match attack {
        Attack::Meteor => {
            let target = glam::Vec3::new(x, 0.5, z);
            let tuning = crate::meteor::MeteorTuning::from_env();
            let g = glam::Vec3::new(gravity[0], gravity[1], gravity[2]);
            let launch = crate::meteor::plan(target, g, &tuning, &mut crate::meteor::Rng::new(11 + variant as u64));
            arena.launch_meteor(Vector3::new(launch.start.x, launch.start.y, launch.start.z),
                Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z), tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks);
            tick + (launch.flight_time_s * 60.) as u32
        }
        Attack::Cannonballs(shots) => {
            let (radius, mass, speed) = (crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), crate::city::city_ball_speed_ms());
            let g = -gravity[1];
            let mut last = tick;
            for shot in 0..shots {
                // The player's muzzle 21 m further out and 8 m to the side, as in the demo.
                let origin = Vector3::new(x + 21., 2.4, z + 8. - 1.5 * variant as f32);
                let target = Vector3::new(x, 0.8, z);
                let t = (target - origin).norm() / speed;
                arena.launch_ball_from_muzzle(origin, (target - origin) / t + Vector3::new(0., 0.5 * g * t, 0.), radius, mass, 600).expect("ball");
                last = tick + (t * 60.) as u32;
                if shot + 1 < shots { for _ in 0..150 { step(&mut arena, &mut city, &mut tick); } }
            }
            last
        }
    };
    // Per loose part: its last two distinct orientations, and flips counted
    // online (A -> B -> A over 10 degrees), after impact + 60 ticks (the
    // blast itself tumbles everything).
    let mut last: HashMap<u16, ([f32; 4], Option<[f32; 4]>)> = HashMap::new();
    let mut flips: HashMap<u16, (u32, u32, u32)> = HashMap::new(); // count, first, last tick
    // Position A -> B -> A over 0.2 m, and which ticks the stage rejected.
    let mut last_pos: HashMap<u16, ([f32; 3], Option<[f32; 3]>)> = HashMap::new();
    let mut jumps: Vec<(u32, u16, f32)> = Vec::new();
    let mut error_ticks: Vec<(u32, u32)> = Vec::new();
    let mut owners: HashMap<u32, HashMap<u16, u64>> = HashMap::new();
    let mut actor_trace: HashMap<u64, Vec<(u32, Vec<f64>, Vec<f64>, bool)>> = HashMap::new();
    let mut max_spin = 0f64;
    let dist = |a: [f32; 3], b: [f32; 3]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    for _ in 0..(impact - tick + 60 + rest) {
        step(&mut arena, &mut city, &mut tick);
        if let Some((status, _, _)) = city.native_tick_view() { if status.error != 0 { error_ticks.push((tick, status.error)); } }
        if tick < impact { continue; }
        // Which body holds each part, around the impact (debug readback: slow).
        if tick < impact + 120 {
            if let Ok(d) = arena.vehicle_destruction_debug(id) {
                let mut m = HashMap::new();
                for h in d["hulls"].as_array().unwrap() { if h["ordinal"] == 0 { m.insert(h["part"].as_u64().unwrap() as u16, h["actor"].as_u64().unwrap_or(u64::MAX)); } }
                owners.insert(tick, m);
                for a in d["actors"].as_array().unwrap() {
                    let w: Vec<f64> = a["angularVelocity"].as_array().map(|x| x.iter().map(|n| n.as_f64().unwrap_or(0.)).collect()).unwrap_or_default();
                    if w.len() == 3 { max_spin = max_spin.max((w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt()); }
                    let f = |v: &serde_json::Value| v.as_array().map(|x| x.iter().map(|n| (n.as_f64().unwrap_or(0.) * 100.).round() / 100.).collect::<Vec<_>>()).unwrap_or_default();
                    let hulls = d["hulls"].as_array().unwrap().iter().filter(|h| h["actor"] == a["actor"]).count() as f64;
                    let mut pose = f(&a["position"]); pose.extend(f(&a["rotation"])); pose.push(hulls);
                    actor_trace.entry(a["actor"].as_u64().unwrap()).or_default().push((tick, f(&a["centerOfMass"]), pose, a["sleeping"].as_bool().unwrap_or(false)));
                }
            }
        }
        for (part, p, _) in arena.vehicle_detached_parts(id) {
            let e = last_pos.entry(part).or_insert((p, None));
            if dist(e.0, p) < 1e-4 { continue; }
            if let Some(a) = e.1 {
                let (out, back) = (dist(a, e.0), dist(a, p));
                if out > 0.2 && back < out * 0.3 { jumps.push((tick, part, out)); }
            }
            *e = (p, Some(e.0));
        }
        if tick < impact + 60 { continue; }
        for (part, _, q) in arena.vehicle_detached_parts(id) {
            let e = last.entry(part).or_insert((q, None));
            if angle(e.0, q) < 0.05 { continue; }
            if let Some(a) = e.1 {
                let (out, back) = (angle(a, e.0), angle(a, q));
                if out > 10. && back < out * 0.3 {
                    let f = flips.entry(part).or_insert((0, tick, tick)); f.0 += 1; f.2 = tick;
                }
            }
            *e = (q, Some(e.0));
        }
    }
    drop(step);
    let mut sorted = step_times.clone(); sorted.sort_by(f32::total_cmp);
    eprintln!("city wreck {model}: step ms median {:.2} p95 {:.2} max {:.1} (idle before attack {:.2})", sorted[sorted.len() / 2], sorted[sorted.len() * 95 / 100],
        sorted[sorted.len() - 1], { let mut idle = step_times[20..120].to_vec(); idle.sort_by(f32::total_cmp); idle[50] });
    let loose = arena.vehicle_detached_parts(id).len();
    let mut rocking: Vec<(u16, (u32, u32, u32))> = flips.into_iter().filter(|(_, f)| f.0 >= 3).collect();
    rocking.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    let named: Vec<String> = rocking.iter().take(10).map(|(p, f)| format!("{} x{} ticks {}..{}", geometry.parts[*p as usize].id, f.0, f.1, f.2)).collect();
    eprintln!("city wreck {model} v{variant}: {loose} loose parts, {} rocking after impact+1 s: {named:?}", rocking.len());
    let now: HashMap<u16, [f32; 3]> = arena.vehicle_detached_parts(id).into_iter().map(|(p, x, _)| (p, x)).collect();
    if let Ok(d) = arena.vehicle_destruction_debug(id) {
        for (p, _) in rocking.iter().take(10) {
            let hull = d["hulls"].as_array().unwrap().iter().find(|h| h["part"] == *p as u64 && h["ordinal"] == 0).cloned().unwrap_or_default();
            let actor = d["actors"].as_array().unwrap().iter().find(|a| a["actor"] == hull["actor"]).cloned().unwrap_or_default();
            eprintln!("  rocking {} origin {:?} body {} com {} mass {} filter {}", geometry.parts[*p as usize].id, now.get(p), hull["actor"], actor["centerOfMass"], actor["mass"], hull["filter"]);
            // What it may be resting against: dynamic bodies (balls) and the car.
            let com: Vec<f32> = actor["centerOfMass"].as_array().map(|x| x.iter().map(|n| n.as_f64().unwrap_or(0.) as f32).collect()).unwrap_or(vec![0.; 3]);
            for b in arena.snapshot_dynamic_bodies() {
                let d = ((b.1[0] - com[0]).powi(2) + (b.1[1] - com[1]).powi(2) + (b.1[2] - com[2]).powi(2)).sqrt();
                if d < 4. { eprintln!("     near dynamic body {} at {:?} ({:.2} m) extents {:?} shape {}", b.0, b.1, d, b.3, b.6); }
            }
            if let Some(car) = arena.snapshot_vehicles().into_iter().find(|c| c.id == id) {
                eprintln!("     car carrier at [{:.2}, {:.2}, {:.2}]", car.px_mm as f32 / 1000., car.py_mm as f32 / 1000., car.pz_mm as f32 / 1000.);
            }
        }
    }
    let err: std::collections::BTreeSet<u32> = error_ticks.iter().map(|e| e.0).collect();
    let near_error = jumps.iter().filter(|j| (j.0.saturating_sub(2)..=j.0 + 1).any(|t| err.contains(&t))).count();
    let mut worst = jumps.clone(); worst.sort_by(|a, b| b.2.total_cmp(&a.2));
    eprintln!("city wreck {model}: impact tick {impact}; {} rejected steps {:?}; {} position A-B-A jumps over 0.2 m ({near_error} within a tick of a rejected step), worst {:?}",
        error_ticks.len(), error_ticks.iter().take(12).collect::<Vec<_>>(), jumps.len(),
        worst.iter().take(5).map(|j| format!("t{} {} {:.2} m", j.0, geometry.parts[j.1 as usize].id, j.2)).collect::<Vec<_>>());
    eprintln!("city wreck {model}: fastest loose body spin in the 2 s after impact {max_spin:.0} rad/s");
    for j in worst.iter().take(2) {
        let own: Vec<String> = (j.0 - 3..=j.0 + 1).map(|t| owners.get(&t).and_then(|m| m.get(&j.1)).map_or("-".into(), |a| a.to_string())).collect();
        eprintln!("  jump t{} {} {:.2} m: owning body at t-3..t+1 = {own:?}", j.0, geometry.parts[j.1 as usize].id, j.2);
        if let Some(actor) = owners.get(&j.0).and_then(|m| m.get(&j.1)) {
            for row in actor_trace.get(actor).into_iter().flatten().filter(|r| r.0 + 4 >= j.0 && r.0 <= j.0 + 3) {
                eprintln!("     body {actor} t{} com {:?} actor pose+rot, hulls {:?}", row.0, row.1, row.2);
            }
        }
    }
    let max: usize = std::env::var("VIBE_CITY_ROCKING_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    assert!(rocking.len() <= max, "{} wreck pieces rock in the city (max {max}): {named:?}", rocking.len());
}

/// VIBE_CITY_TRACE_PART=<part id>: its body, tick by tick, for
/// VIBE_CITY_TRACE_TICKS (default 24) ticks from VIBE_CITY_TRACE_FROM.
fn trace_part(arena: &mut crate::movement::PhysicsArena, id: u32, geometry: &crate::vehicle_assets::PreparedGeometry, tick: u32) {
    let Some(watch) = std::env::var("VIBE_CITY_TRACE_PART").ok().and_then(|n| geometry.parts.iter().position(|p| p.id == n)) else { return };
    let from: u32 = std::env::var("VIBE_CITY_TRACE_FROM").ok().and_then(|v| v.parse().ok()).unwrap_or(900);
    let ticks: u32 = std::env::var("VIBE_CITY_TRACE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(24);
    if !(from..from + ticks).contains(&tick) { return; }
    let d = arena.vehicle_destruction_debug(id).unwrap();
    let hull = d["hulls"].as_array().unwrap().iter().find(|h| h["part"] == watch as u64 && h["ordinal"] == 0).cloned().unwrap_or_default();
    let a = d["actors"].as_array().unwrap().iter().find(|a| a["actor"] == hull["actor"]).cloned().unwrap_or_default();
    let r = |v: &serde_json::Value, k: f64| v.as_array().map(|x| x.iter().map(|n| (n.as_f64().unwrap_or(0.) * k).round() / k).collect::<Vec<_>>()).unwrap_or_default();
    eprintln!("trace t{tick} body {} com {:?} rot {:?} v {:?} w {:?} sleep {} hulls {}", hull["actor"], r(&a["centerOfMass"], 1e4), r(&a["rotation"], 1e3),
        r(&a["linearVelocity"], 1e3), r(&a["angularVelocity"], 1e2), a["sleeping"], d["hulls"].as_array().unwrap().iter().filter(|h| h["actor"] == hull["actor"]).count());
}
