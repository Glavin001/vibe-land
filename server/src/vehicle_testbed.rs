//! Vehicle test bed, headless: every fleet build through the trials of
//! structures/vehicle-lab (lanes of steps, ramps, debris, a rubble pile, a
//! wall and a house; pads for a handbrake turn, the cannonball and the
//! meteor), inside the real city stage -- production arena, the city world,
//! the car registered before the city opens its stage, then per tick the
//! arena step followed by the city step, with the native app's settings
//! (sim-native apply_app_defaults) and the fleet's 64 stress iterations.
//!
//! This only measures. What a car must achieve on each trial, and why, is
//! structures/vehicle-lab/criteria.mjs; `node structures/vehicle-lab/report.mjs
//! <report.json>` judges a report. scripts/vehicle-testbed.sh runs both.
//!
//!   PHYSX_ROOT=../PhysX/out/install/garage-multihull CARGO_TARGET_DIR=target/garage-vehicles \
//!   scripts/perf/gpu-run.sh testbed cargo test --release -p web-fps-server --features native-destruction \
//!     --bin web-fps-server vehicle_testbed -- --ignored --nocapture --test-threads=1
//!
//! VIBE_TESTBED_CARS     garage build ids (default the city fleet)
//! VIBE_TESTBED_TRIALS   trial ids or prefixes (default all)
//! VIBE_TESTBED_LABEL    report name: target/vehicle-testbed/<label>.json (default "report")
//! VIBE_TESTBED_META     the lab meta (default structures/vehicle-lab/out/vehicle-lab.meta.json)
//! VIBE_TESTBED_TRACE=1  a per-tick trace of the car in each run (speed, z, height, jounce)
#![cfg(all(test, feature = "native-destruction"))]

use nalgebra::Vector3;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use vibe_land_shared::constants::BTN_JUMP;
use vibe_land_shared::protocol::InputCmd;

const DT: f32 = 1.0 / 60.0;
const PLAYER: u32 = 42;
/// Ticks the city settles (loose debris comes to rest) before the trial starts.
const SETTLE_TICKS: u32 = 120;
/// Debug readback (every bond, hull and actor of the car) every this many ticks.
const SAMPLE_EVERY: u32 = 5;

/// VIBE_TESTBED_SCENE=town: the trials set in Vibe Town (`scene: 'town'`)
/// instead of the lab's. One scene per process (the city reads its pack once).
fn town() -> bool { std::env::var("VIBE_TESTBED_SCENE").as_deref() == Ok("town") }

fn repo() -> std::path::PathBuf { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }

/// The native app's settings (sim-native city.rs apply_app_defaults), for
/// anything not already set.
fn app_settings() {
    for (name, value) in [
        ("VIBE_GARAGE_VEHICLE_DESTRUCTION", "1"),
        ("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1"),
        ("VIBE_NATIVE_STRESS_FORCE_TOLERANCE", "0.001"),
        ("BLAST_STRESS_INCREMENTAL_MOTION", "1"),
        ("PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "1"),
        ("BLAST_STRESS_BALANCED_OPERATOR", "1"),
        // The lab scene, one instance, every structure at full height.
        ("VIBE_CITY_GRID", "1"),
        ("VIBE_CITY_VARIED_HEIGHTS", "0"),
    ] {
        if std::env::var_os(name).is_none() { std::env::set_var(name, value); }
    }
    if std::env::var_os("VIBE_CITY_SCENE").is_none() {
        let pack = if town() { "structures/vibe-town/out/vibe-town.json" } else { "structures/vehicle-lab/out/vehicle-lab.json" };
        std::env::set_var("VIBE_CITY_SCENE", repo().join(pack));
    }
}

/// Which lab-scene node groups each named structure owns (wall, house).
struct SceneIndex { group_of_node: Vec<String> }
impl SceneIndex {
    fn load() -> Self {
        let path = std::env::var("VIBE_CITY_SCENE").unwrap();
        let pack: Value = serde_json::from_slice(&std::fs::read(&path).expect("lab scene pack")).unwrap();
        let group_of_node = pack["scenario"]["nodeGroups"].as_array().unwrap().iter().map(|g| g.as_str().unwrap_or("").to_string()).collect();
        Self { group_of_node }
    }
}

struct Run<'a> {
    car: &'a str,
    trial: &'a Value,
    geometry: &'a crate::vehicle_assets::PreparedGeometry,
    scene: &'a SceneIndex,
}

/// The car's state from Vehicle2's snapshot.
#[derive(Clone, Copy)]
struct CarState { p: Vector3<f32>, v: Vector3<f32>, w: Vector3<f32>, forward: Vector3<f32>, up: Vector3<f32>, jounce: [f32; 4], on_road: u8, q: nalgebra::UnitQuaternion<f32> }

fn car_state(arena: &mut crate::movement::PhysicsArena, id: u32) -> CarState {
    let world = arena.physx_world_mut().expect("physx");
    let Some(c) = world.vehicle_snapshots().ok().and_then(|v| v.into_iter().find(|c| c.user_id == id)) else {
        return CarState { p: Vector3::zeros(), v: Vector3::zeros(), w: Vector3::zeros(), forward: Vector3::z(), up: Vector3::y(), jounce: [0.; 4], on_road: 0, q: nalgebra::UnitQuaternion::identity() };
    };
    let q = nalgebra::UnitQuaternion::new_normalize(nalgebra::Quaternion::new(c.pose.rotation.w, c.pose.rotation.x, c.pose.rotation.y, c.pose.rotation.z));
    CarState {
        p: Vector3::new(c.pose.position.x, c.pose.position.y, c.pose.position.z),
        v: Vector3::new(c.linear_velocity.x, c.linear_velocity.y, c.linear_velocity.z),
        w: Vector3::new(c.angular_velocity.x, c.angular_velocity.y, c.angular_velocity.z),
        forward: q * Vector3::z(), up: q * Vector3::y(), jounce: c.wheel_jounce, on_road: c.wheels_on_road, q,
    }
}

/// Bonds of the car broken so far (health gone or the verdict says so), parts
/// off the car body, and Vehicle2's wheel mask.
struct Damage {
    broken: BTreeMap<u32, u32>, parts_off: BTreeSet<u32>, wheel_mask: u32,
    /// Each intact bond's tension, compression and shear (Pa) and utilisation
    /// at the last sample, and the wheel loads then (kN: suspension, tyre,
    /// corner constraint), for the audit of what broke.
    last: HashMap<u32, [f64; 4]>, last_wheels: Vec<[f64; 3]>,
    audits: Vec<Value>,
    /// The car body's (actor 0's) mass, at the first and the latest sample.
    body_mass: [f64; 2],
}

/// VIBE_TESTBED_AUDIT=1: read the car back every tick and explain each break.
fn auditing() -> bool { std::env::var_os("VIBE_TESTBED_AUDIT").is_some() }

fn read_damage(arena: &mut crate::movement::PhysicsArena, id: u32, tick: u32, damage: &mut Damage, geometry: &crate::vehicle_assets::PreparedGeometry, accel_g: f32) {
    // The breaking step's stress input on both chunks of a bond, by source
    // (kN: prepared -- gravity, rotation, Vehicle2's wheel loads --,
    // constraint, contact): the native solve report, when auditing.
    let report = if auditing() { arena.physx_world_mut().and_then(|w| w.native_stress_solve_report().ok()) } else { None };
    let structure = 200u32; // garage_destruction::STRUCTURE: the first (only) car
    let loads = |a: &str, b: &str| -> Value {
        let Some(r) = &report else { return Value::Null };
        let mut out = serde_json::Map::new();
        for id in [a, b] {
            let Some(node) = geometry.parts.iter().position(|p| p.id == id) else { continue };
            let Some(c) = r.chunks.iter().find(|c| c.structure_id == structure && c.node == node as u32) else { continue };
            let m = geometry.parts[node].mass as f32;
            let f = |v: &vibe_land_physx_bridge::FfiVec3| ((v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * m / 100.).round() / 10.;
            out.insert(geometry.parts[node].name.clone(), json!({"prepared": f(&c.prepared_linear), "constraint": f(&c.constraint_linear), "contact": f(&c.contact_linear)}));
        }
        Value::Object(out)
    };
    let Ok(d) = arena.vehicle_destruction_debug(id) else { return };
    for b in d["bonds"].as_array().into_iter().flatten() {
        let index = b["index"].as_u64().unwrap() as u32;
        let gone = b["remainingArea"].as_f64().is_some_and(|a| a <= 0.0) || b["verdictBroken"].as_bool() == Some(true);
        if gone {
            if !damage.broken.contains_key(&index) && damage.audits.len() < 40 {
                let st = &geometry.bonds[index as usize].strength;
                let before = damage.last.get(&index).copied().unwrap_or_default();
                let r = |v: f64| (v * 1000.).round() / 1000.;
                damage.audits.push(json!({"tick": tick, "bond": index, "parts": bond_parts(geometry, index).0, "area": geometry.bonds[index as usize].area,
                    "beforeFractionOfFatal": [r(before[0] / st.tension_fatal), r(before[1] / st.compression_fatal), r(before[2] / st.shear_fatal)],
                    "utilisationBefore": r(before[3]), "wheelLoadsBeforeKN": damage.last_wheels, "accelG": accel_g,
                    "loadsKN": loads(&geometry.bonds[index as usize].a, &geometry.bonds[index as usize].b)}));
            }
            damage.broken.entry(index).or_insert(tick);
        } else {
            let f = |k: &str| b[k].as_f64().unwrap_or(0.);
            damage.last.insert(index, [f("tension"), f("compression"), f("shear"), f("utilisation")]);
        }
    }
    let m = |w: &Value, k: &str| (w[k].as_array().map_or(0., |v| v.iter().map(|x| x.as_f64().unwrap_or(0.).powi(2)).sum::<f64>().sqrt()) / 100.).round() / 10.;
    damage.last_wheels = d["wheelLoads"].as_array().into_iter().flatten().map(|w| [m(w, "suspension"), m(w, "tire"), m(w, "constraintForce")]).collect();
    for h in d["hulls"].as_array().into_iter().flatten() {
        if h["actor"].as_u64().unwrap_or(0) != 0 { damage.parts_off.insert(h["part"].as_u64().unwrap() as u32); }
    }
    damage.wheel_mask = d["vehicle"]["wheelMask"].as_u64().unwrap_or(15) as u32;
    if let Some(m) = d["actors"].as_array().and_then(|a| a.iter().find(|a| a["actor"] == 0)).and_then(|a| a["mass"].as_f64()) {
        if damage.body_mass[0] == 0. { damage.body_mass[0] = m; }
        damage.body_mass[1] = m;
    }
}

/// Bonds of the city's structure broken so far, by node group.
fn scene_broken(arena: &mut crate::movement::PhysicsArena, scene: &SceneIndex) -> BTreeMap<String, usize> {
    let world = arena.physx_world_mut().expect("physx");
    let mut out = BTreeMap::new();
    for r in world.native_bond_stress_rows(0).unwrap_or_default() {
        if !(r.remaining_area <= 0.0 || r.broken) { continue; }
        let group = scene.group_of_node.get(r.node0 as usize).cloned().unwrap_or_default();
        let key = group.split('@').next().unwrap_or("").to_string();
        *out.entry(if key.is_empty() { "?".into() } else { key }).or_insert(0) += 1;
    }
    out
}

/// A broken bond as "part a -- part b", with whether it holds a wheel corner.
fn bond_parts(geometry: &crate::vehicle_assets::PreparedGeometry, index: u32) -> (String, bool) {
    let b = &geometry.bonds[index as usize];
    let part = |id: &str| geometry.parts.iter().find(|p| p.id == id);
    let corner = |id: &str| part(id).and_then(|p| p.motion.as_ref()).and_then(|m| m.get("corner")).is_some();
    let name = |id: &str| part(id).map_or(id.to_string(), |p| if p.name.is_empty() { p.id.clone() } else { p.name.clone() });
    (format!("{} -- {}", name(&b.a), name(&b.b)), corner(&b.a) || corner(&b.b))
}

/// Ground clearance and approach and departure angles (degrees), measured on
/// the authored hulls at rest: `ride` is the chassis origin's height above
/// the ground. Wheels and hubs are left out (they are the wheels); the angles
/// are from each axle's tyre contact to the lowest-reaching hull point ahead
/// of the front axle or behind the rear one.
fn underbody(geometry: &crate::vehicle_assets::PreparedGeometry, ride: f32) -> Value {
    let (front, rear) = {
        let zs = geometry.wheel_centers.map(|w| w[2]);
        (zs.iter().copied().fold(f32::MIN, f32::max), zs.iter().copied().fold(f32::MAX, f32::min))
    };
    let (mut clearance, mut approach, mut departure) = (f32::MAX, 90f32, 90f32);
    let mut lowest = String::new();
    for part in &geometry.parts {
        let role = part.motion.as_ref().and_then(|m| m.get("role")).and_then(|r| r.as_str()).unwrap_or("");
        if matches!(role, "wheel" | "hub") { continue; }
        for shape in &part.shapes {
            for v in &shape.vertices {
                let y = part.position[1] + shape.position[1] + v[1] + ride;
                let z = part.position[2] + shape.position[2] + v[2];
                if y < clearance { clearance = y; lowest = part.name.clone(); }
                if z > front { approach = approach.min(y.max(0.).atan2(z - front).to_degrees()); }
                if z < rear { departure = departure.min(y.max(0.).atan2(rear - z).to_degrees()); }
            }
        }
    }
    json!({"clearance": clearance, "lowestPart": lowest, "approachDeg": approach, "departureDeg": departure,
        "tyreRadius": geometry.origin_height - 0.25, "wheelbase": front - rear, "suspensionTravel": geometry.suspension_travel})
}

fn ground_y(x: f32, z: f32, meta: &Value) -> f32 {
    // Vibe Town's streets: 2.5 cm of asphalt.
    if town() { return 0.025; }
    // Paved lanes stand 2.5 cm above the city's ground; everything else is y = 0
    // (decks and ramps are not counted: ride height is read on flat ground).
    for lane in meta["lanes"].as_array().unwrap() {
        let lx = lane["x"].as_f64().unwrap() as f32;
        if (x - lx).abs() < 4.0 && lane["paved"].as_bool() == Some(true) && z < meta["startZ"].as_f64().unwrap() as f32 + lane["length"].as_f64().unwrap_or(160.) as f32 { return 0.025; }
    }
    0.0
}

fn run(r: &Run, meta: &Value) -> Value {
    let id = crate::city_fleet::FIRST_ID;
    let trial = r.trial;
    let geometry = r.geometry;
    let slot = trial["slot"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect::<Vec<_>>();
    let (x, z, heading) = (slot[0], slot[1], slot[2].to_radians());
    let mut arena = crate::movement::PhysicsArena::new(vibe_netcode::movement::MoveConfig::default(),
        vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
    crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
    arena.spawn_prepared_vehicle_at(id, 0, Vector3::new(x, geometry.origin_height as f32 + 0.15 + ground_y(x, z, meta), z),
        [0., (heading * 0.5).sin(), 0., (heading * 0.5).cos()], geometry).expect("spawn");
    arena.enable_external_vehicle_destruction(id, geometry).expect("register");
    arena.reserve_ball_pool(4);
    arena.reserve_meteor_pool(2);
    let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
    arena.mark_vehicle_destruction_configured();
    let mut report_on = false;
    let gravity = vibe_netcode::movement::default_world_gravity();
    let mut tick = 0u32;
    let mut step_ms: Vec<f32> = Vec::new();
    let (mut converged, mut solves) = (0u32, 0u32);
    let mut step = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32, input: Option<&InputCmd>| {
        if let Some(input) = input { arena.simulate_player_tick(PLAYER, input, DT); }
        let t0 = std::time::Instant::now();
        arena.step_vehicles_and_dynamics(DT);
        let _ = city.step(*tick, DT, gravity, arena.physx_world_mut());
        // The native solve report (bit 0: the trial solve that decides what breaks), when auditing.
        if auditing() && !report_on { report_on = arena.physx_world_mut().is_some_and(|w| w.native_set_stress_solve_report(1).unwrap_or(false)); }
        step_ms.push(t0.elapsed().as_secs_f32() * 1000.);
        if let Some((status, _, _)) = city.native_tick_view() { solves += 1; if status.converged { converged += 1; } }
        *tick += 1;
    };
    for _ in 0..SETTLE_TICKS { step(&mut arena, &mut city, &mut tick, None); }
    let mut damage = Damage { broken: BTreeMap::new(), parts_off: BTreeSet::new(), wheel_mask: 15, last: HashMap::new(), last_wheels: Vec::new(), audits: Vec::new(), body_mass: [0.; 2] };
    read_damage(&mut arena, id, tick, &mut damage, geometry, 0.);
    let settled_broken = damage.broken.len();
    let scene_before = scene_broken(&mut arena, r.scene);
    let drive = &trial["drive"];
    let kind = drive["kind"].as_str().unwrap();
    let driving = kind != "park" || trial.get("driveAway").is_some();
    if driving {
        arena.spawn_player(PLAYER);
        let s = car_state(&mut arena, id);
        let cmd = vibe_land_shared::protocol::CityCameraDropCmd { position: [s.p.x - 2.5, s.p.y + 0.5, s.p.z - 2.5], yaw: 0., pitch: 0. };
        let _ = arena.drop_player_from_camera(PLAYER, &cmd);
        for _ in 0..10 { step(&mut arena, &mut city, &mut tick, None); }
        arena.enter_vehicle(PLAYER, id);
        assert_eq!(arena.player_vehicle_id(PLAYER), Some(id), "{} {}: could not get in", r.car, trial["id"]);
    }
    let start = car_state(&mut arena, id);
    let ride_start = start.p.y - ground_y(start.p.x, start.p.z, meta);
    let seconds = trial["seconds"].as_f64().unwrap() as f32;
    let ticks = (seconds / DT).round() as u32;
    let goal = trial["goal"].as_f64().map(|g| g as f32);
    let impact_z = trial["impactZ"].as_f64().map(|g| g as f32);
    let front = geometry.bounds.max[2].max(-geometry.bounds.min[2]);
    let target_speed = drive["speed"].as_f64().unwrap_or(0.) as f32;
    let drift_ticks = (drive["seconds"].as_f64().unwrap_or(0.) as f32 / DT).round() as u32;
    let heading0 = Vector3::new(start.forward.x, 0., start.forward.z).normalize();
    let goal_progress = trial["goalProgress"].as_f64().map(|g| g as f32);
    let mut progress_tick = None::<u32>;
    let mut max_progress = 0f32;
    let mut launched = 0usize;
    let attack = trial.get("attack");
    let attack_tick = attack.and_then(|a| a["at"].as_f64()).map(|at| (at as f32 / DT) as u32);
    // Measurements.
    let (mut top, mut max_z, mut stalled, mut peak_decel) = (0f32, start.p.z, 0u32, 0f32);
    let (mut goal_tick, mut impact_speed, mut impact_tick) = (None::<u32>, None::<f32>, None::<u32>);
    let mut speed_at: BTreeMap<String, f32> = BTreeMap::new();
    let mut time_to: BTreeMap<String, Option<f32>> = [("10", None), ("20", None)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    let mut prev_v: Option<Vector3<f32>> = None;
    let (mut min_up, mut airborne) = (1f32, 0u32);
    // Drift.
    let (mut drift_start, mut drift_entry_speed, mut drift_heading0) = (None::<u32>, 0f32, 0f32);
    let (mut peak_yaw, mut peak_slip, mut drift_end_speed, mut drift_heading) = (0f32, 0f32, 0f32, 0f32);
    let mut drift_done = false;
    // Attack.
    let (mut projectile, mut closest) = (None::<u32>, f32::INFINITY);
    let mut trace = Vec::new();
    let tracing = std::env::var_os("VIBE_TESTBED_TRACE").is_some();
    let heading_of = |f: Vector3<f32>| f.x.atan2(f.z);
    for k in 0..ticks {
        let s = car_state(&mut arena, id);
        let speed = (s.v.x * s.v.x + s.v.z * s.v.z).sqrt();
        top = top.max(speed);
        max_z = max_z.max(s.p.z);
        let t = k as f32 * DT;
        for (name, at) in [("2s", 2.0f32), ("4s", 4.0), ("8s", 8.0)] { if (t - at).abs() < DT * 0.5 { speed_at.insert(name.into(), speed); } }
        for (name, v) in [("10", 10.0f32), ("20", 20.0)] { if speed >= v { time_to.entry(name.into()).or_insert(None).get_or_insert(t); } }
        if goal_tick.is_none() && goal.is_some_and(|g| s.p.z >= g) { goal_tick = Some(k); }
        let progress = (s.p - start.p).dot(&heading0);
        max_progress = max_progress.max(progress);
        if progress_tick.is_none() && goal_progress.is_some_and(|g| progress >= g) { progress_tick = Some(k); }
        if impact_tick.is_none() && impact_z.is_some_and(|iz| s.p.z + front >= iz - 0.2) { impact_tick = Some(k); impact_speed = Some(speed); }
        min_up = min_up.min(s.up.y);
        if s.on_road == 0 { airborne += 1; }
        let mut input = InputCmd::default();
        match kind {
            "park" => {}
            "floor" => input.move_y = 127,
            "cruise" => input.move_y = if speed < target_speed { 127 } else { 0 },
            "script" => {
                // [t, forward, strafe]: the latest event at or before now.
                if let Some(e) = drive["events"].as_array().unwrap().iter().filter(|e| e[0].as_f64().unwrap() as f32 <= t + 1e-4).last() {
                    input.move_y = (e[1].as_f64().unwrap() * 127.).round() as i8;
                    input.move_x = (e[2].as_f64().unwrap() * 127.).round() as i8;
                }
            }
            "drift" => {
                if drift_start.is_none() && speed >= target_speed { drift_start = Some(k); drift_entry_speed = speed; drift_heading0 = heading_of(s.forward); }
                match drift_start {
                    None => input.move_y = 127,
                    Some(d) if k < d + drift_ticks => { input.move_x = 127; input.buttons |= BTN_JUMP; }
                    Some(_) => {
                        if !drift_done { drift_done = true; drift_end_speed = speed; drift_heading = (heading_of(s.forward) - drift_heading0).to_degrees(); }
                    }
                }
                if let Some(d) = drift_start {
                    if k >= d && k < d + drift_ticks {
                        peak_yaw = peak_yaw.max(s.w.y.abs());
                        if speed > 2. {
                            let fwd = Vector3::new(s.forward.x, 0., s.forward.z).normalize();
                            let vel = Vector3::new(s.v.x, 0., s.v.z) / speed;
                            peak_slip = peak_slip.max(fwd.dot(&vel).clamp(-1., 1.).acos().to_degrees());
                        }
                    }
                }
            }
            other => panic!("unknown drive {other}"),
        }
        // Stalled: asking for speed, not moving, goal not reached.
        if input.move_y > 0 && speed < 0.5 && goal_tick.is_none() && k > 60 { stalled += 1; }
        // Strikes (the chase's near miss): when the car will be at `carZ` after
        // the meteors' flight, each lane strike is launched as the film does
        // (shots.mjs launchMeteor: 140 m/s, from `from` degrees, `slope` up).
        if let Some(a) = attack.filter(|a| a["kind"] == "strikes") {
            let flight = a["flight"].as_f64().unwrap_or(1.0) as f32;
            if projectile.is_none() && s.p.z + s.v.z * flight >= a["carZ"].as_f64().unwrap() as f32 {
                let slope = a["slope"].as_f64().unwrap_or(0.8) as f32;
                let tuning = crate::meteor::MeteorTuning::from_env();
                let lane = meta["lanes"].as_array().unwrap().iter().find(|l| format!("lane/{}", l["id"].as_str().unwrap()) == trial["at"].as_str().unwrap()).unwrap();
                for strike in lane["obstacle"]["strikes"].as_array().unwrap() {
                    let t: Vec<f32> = strike["target"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
                    let target = Vector3::new(t[0], t[1], t[2]);
                    let bearing = (strike["from"].as_f64().unwrap() as f32).to_radians();
                    let out = 140. * flight / (1. + slope * slope).sqrt();
                    let start = target + Vector3::new(bearing.sin() * out, out * slope, bearing.cos() * out);
                    let tt = (start - target).norm() / 140.;
                    let velocity = (target - start) / tt + Vector3::new(0., 9.81 * tt * 0.5, 0.);
                    projectile = arena.launch_meteor(start, velocity, tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks).or(projectile);
                }
            }
        }
        // A meteor landing near the car (the film's strikeNear): where it will
        // be after the flight at its current velocity, `ahead`/`side` in its
        // frame, from compass bearing `from` (degrees; 0 = +z) at `slope`.
        if let (Some(a), Some(at)) = (attack.filter(|a| a["kind"] == "near"), attack_tick) {
            if k == at {
                let f = |key: &str| a[key].as_f64().unwrap_or(0.) as f32;
                let flight = f("flight");
                let fwd = Vector3::new(s.forward.x, 0., s.forward.z).normalize();
                let right = Vector3::new(fwd.z, 0., -fwd.x);
                let mut target = s.p + Vector3::new(s.v.x, 0., s.v.z) * flight + fwd * f("ahead") + right * f("side");
                let tuning = crate::meteor::MeteorTuning::from_env();
                target.y = f("height");
                // `clip`: instead of a height, the rock's underside crosses the
                // car's centreline `clip` metres below its roof (its highest hull
                // at rest) -- a graze of the cab, the chase's last near miss.
                if let Some(clip) = a["clip"].as_f64() {
                    let roof = geometry.bounds.max[1] + ride_start + ground_y(s.p.x, s.p.z, meta);
                    target.y = roof - clip as f32 + tuning.radius_m - f("side").abs() * f("slope");
                }
                let bearing = f("from").to_radians();
                let slope = f("slope");
                let out = 140. * flight / (1. + slope * slope).sqrt();
                let start = target + Vector3::new(bearing.sin() * out, out * slope, bearing.cos() * out);
                let tt = (start - target).norm() / 140.;
                let velocity = (target - start) / tt + Vector3::new(0., 9.81 * tt * 0.5, 0.);
                projectile = arena.launch_meteor(start, velocity, tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks);
            }
        }
        // A timeline of strikes (a film's): each launched at its `t`.
        if let Some(a) = attack.filter(|a| a["kind"] == "timeline") {
            let strikes = a["strikes"].as_array().unwrap();
            while launched < strikes.len() && strikes[launched]["t"].as_f64().unwrap() as f32 <= t + 1e-4 {
                let strike = &strikes[launched];
                let tuning = crate::meteor::MeteorTuning::from_env();
                let target = { let v: Vec<f32> = strike["target"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect(); Vector3::new(v[0], v[1], v[2]) };
                let (flight, slope) = (strike["flight"].as_f64().unwrap() as f32, strike["slope"].as_f64().unwrap() as f32);
                let bearing = (strike["from"].as_f64().unwrap() as f32).to_radians();
                let out = 140. * flight / (1. + slope * slope).sqrt();
                let start = target + Vector3::new(bearing.sin() * out, out * slope, bearing.cos() * out);
                let tt = (start - target).norm() / 140.;
                let velocity = (target - start) / tt + Vector3::new(0., 9.81 * tt * 0.5, 0.);
                projectile = arena.launch_meteor(start, velocity, tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks).or(projectile);
                launched += 1;
            }
        }
        if let (Some(a), Some(at)) = (attack.filter(|a| !matches!(a["kind"].as_str(), Some("strikes" | "timeline" | "near"))), attack_tick) {
            if k == at {
                match a["kind"].as_str().unwrap() {
                    "cannonball" => {
                        // From 12 m to the car's right, at the chassis' height.
                        let (radius, mass, ball_speed) = (crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), crate::city::city_ball_speed_ms());
                        let right = Vector3::new(s.forward.z, 0., -s.forward.x);
                        let target = s.p;
                        let origin = target + right * 12. + Vector3::new(0., 0.4, 0.);
                        let tt = 12. / ball_speed;
                        projectile = arena.launch_ball_from_muzzle(origin, (target - origin) / tt + Vector3::new(0., 0.5 * 9.81 * tt, 0.), radius, mass, 600);
                    }
                    "debris" => {
                        // A loose chunk thrown at the car (a blast's debris): `mass` kg,
                        // `radius` m, at `speed` m/s from `from` degrees off its nose
                        // (90: from its right), aimed at a wheel centre (`aim`:
                        // wheel index in Vehicle2 order) or at the chassis origin.
                        let f = |k: &str| a[k].as_f64().unwrap_or(0.) as f32;
                        let aim = a["aim"].as_u64().map_or(s.p, |w| s.p + s.q * Vector3::from(geometry.wheel_centers[w as usize]));
                        // `aimPart`: the centre of mass of the first part whose name has it.
                        let aim = a["aimPart"].as_str().and_then(|n| geometry.parts.iter().find(|p| p.name.contains(n)))
                            .map_or(aim, |p| s.p + s.q * Vector3::from(p.mass_properties.center.map(|c| c as f32)));
                        let bearing = f("from").to_radians();
                        let fwd = Vector3::new(s.forward.x, 0., s.forward.z).normalize();
                        let right = Vector3::new(fwd.z, 0., -fwd.x);
                        let dir = fwd * bearing.cos() + right * bearing.sin();
                        let origin = aim + dir * 6.;
                        let tt = 6. / f("speed");
                        projectile = arena.launch_ball_from_muzzle(origin, (aim - origin) / tt + Vector3::new(0., 0.5 * 9.81 * tt, 0.) + s.v, f("radius"), f("mass"), 600);
                    }
                    "meteor" => {
                        let tuning = crate::meteor::MeteorTuning::from_env();
                        let g = glam::Vec3::new(gravity[0], gravity[1], gravity[2]);
                        let launch = crate::meteor::plan(glam::Vec3::new(s.p.x, s.p.y, s.p.z), g, &tuning, &mut crate::meteor::Rng::new(a["seed"].as_u64().unwrap_or(11)));
                        projectile = arena.launch_meteor(Vector3::new(launch.start.x, launch.start.y, launch.start.z),
                            Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z), tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks);
                    }
                    other => panic!("unknown attack {other}"),
                }
            }
        }
        step(&mut arena, &mut city, &mut tick, if driving { Some(&input) } else { None });
        let after = car_state(&mut arena, id);
        let accel_g = prev_v.map_or(0., |pv| (after.v - pv).norm() / DT / 9.81);
        peak_decel = peak_decel.max(accel_g);
        prev_v = Some(after.v);
        if let Some(pid) = projectile {
            if let Some(b) = arena.snapshot_dynamic_bodies().into_iter().find(|b| b.0 == pid) {
                closest = closest.min((Vector3::new(b.1[0], b.1[1], b.1[2]) - after.p).norm());
            }
        }
        if k % SAMPLE_EVERY == 0 || auditing() { read_damage(&mut arena, id, tick, &mut damage, geometry, accel_g); }
        if tracing && (k % 6 == 0 || auditing()) {
            let spin = [after.w.x, after.w.y, after.w.z].map(|w| (w * 100.).round() / 100.);
            trace.push(json!([k, (speed * 100.).round() / 100., (after.p.z * 100.).round() / 100., (after.p.y * 1000.).round() / 1000., after.jounce.map(|j| if j.is_finite() { (j * 1000.).round() / 1000. } else { -1. }), damage.broken.len(), damage.parts_off.len(), damage.wheel_mask, after.on_road, (after.p.x * 100.).round() / 100., spin, (accel_g * 10.).round() / 10.]));
        }
    }
    read_damage(&mut arena, id, tick, &mut damage, geometry, 0.);
    let end = car_state(&mut arena, id);
    // Where the projectile ended, in the car's frame (x right, y up, z forward).
    let projectile_end = projectile.and_then(|pid| arena.snapshot_dynamic_bodies().into_iter().find(|b| b.0 == pid)).map(|b| {
        let local = end.q.inverse() * (Vector3::new(b.1[0], b.1[1], b.1[2]) - end.p);
        [local.x, local.y, local.z].map(|v| (v * 100.).round() / 100.)
    });
    let ride_end = end.p.y - ground_y(end.p.x, end.p.z, meta);
    let broken_in_trial = damage.broken.len();
    // Still drivable? Reverse (if asked), then full throttle on full lock.
    let mut drive_away = Value::Null;
    if let Some(away) = trial.get("driveAway") {
        let reverse = (away["reverse"].as_f64().unwrap_or(0.) as f32 / DT) as u32;
        let forward = (away["seconds"].as_f64().unwrap() as f32 / DT) as u32;
        let mut path = 0f32;
        let mut last = car_state(&mut arena, id).p;
        for k in 0..reverse + forward {
            let mut input = InputCmd::default();
            if k < reverse { input.move_y = -127; } else { input.move_y = 127; if reverse > 0 { input.move_x = 127; } }
            step(&mut arena, &mut city, &mut tick, Some(&input));
            let p = car_state(&mut arena, id).p;
            path += ((p.x - last.x).powi(2) + (p.z - last.z).powi(2)).sqrt();
            last = p;
        }
        read_damage(&mut arena, id, tick, &mut damage, geometry, 0.);
        drive_away = json!({"metres": path, "seconds": (reverse + forward) as f32 * DT});
    }
    let scene_after = scene_broken(&mut arena, r.scene);
    let scene_damage: BTreeMap<String, i64> = scene_after.iter().map(|(k, v)| (k.clone(), *v as i64 - *scene_before.get(k).unwrap_or(&0) as i64)).collect();
    let wheels_lost = (0..4).filter(|w| damage.wheel_mask & (1 << w) == 0).count();
    let mut first: Vec<(u32, u32)> = damage.broken.iter().map(|(b, t)| (*t, *b)).collect();
    first.sort();
    let corner_bonds = damage.broken.keys().filter(|&&b| bond_parts(geometry, b).1).count();
    let first_breaks: Vec<String> = first.iter().take(10).map(|(t, b)| { let (n, c) = bond_parts(geometry, *b); format!("t{} {}{}", t.saturating_sub(SETTLE_TICKS), n, if c { " [corner]" } else { "" }) }).collect();
    drop(step);
    let mut sorted = step_ms.clone();
    sorted.sort_by(f32::total_cmp);
    // The parts still on the carrier (actor 0: what Vehicle2 drives), when few.
    let carrier_parts: Vec<String> = arena.vehicle_destruction_debug(id).map(|d| {
        let mut names: Vec<String> = d["hulls"].as_array().into_iter().flatten().filter(|h| h["actor"] == 0 && h["ordinal"] == 0)
            .map(|h| geometry.parts[h["part"].as_u64().unwrap() as usize].name.clone()).collect();
        names.sort(); names.dedup(); names
    }).unwrap_or_default();
    // Every body of the car at the end: [actor, mass, gravity disabled, asleep, position].
    let actors_end = arena.vehicle_destruction_debug(id).map(|d| json!(d["actors"].as_array().into_iter().flatten()
        .map(|a| json!([a["actor"], a["mass"], a["gravityDisabled"], a["sleeping"], a["position"]])).collect::<Vec<_>>())).unwrap_or(Value::Null);
    drop(city);
    drop(arena);
    let mut out = json!({
        "car": r.car, "trial": trial["id"], "seconds": seconds,
        "bonds": geometry.bonds.len(), "parts": geometry.parts.len(), "mass": geometry.mass, "driving": geometry.driving,
        "brokenAtSettle": settled_broken, "bondsBroken": broken_in_trial - settled_broken.min(broken_in_trial),
        "bondsBrokenAfterDriveAway": damage.broken.len(), "cornerBondsBroken": corner_bonds,
        "partsOff": damage.parts_off.len(), "wheelsLost": wheels_lost, "firstBreaks": first_breaks,
        "topSpeed": top, "speedAt": speed_at, "timeTo": time_to, "maxZ": max_z, "startZ": start.p.z,
        "goal": goal, "goalSeconds": goal_tick.or(progress_tick).map(|t| t as f32 * DT), "progress": max_progress, "goalProgress": goal_progress, "stalledSeconds": stalled as f32 * DT,
        "impactSpeed": impact_speed, "impactSeconds": impact_tick.map(|t| t as f32 * DT), "peakDecelG": peak_decel,
        "rideHeightStart": ride_start, "underbody": underbody(geometry, ride_start), "rideHeightEnd": ride_end, "minUpY": min_up, "airborneSeconds": airborne as f32 * DT,
        "drift": if kind == "drift" { json!({"entrySpeed": drift_entry_speed, "peakYawRate": peak_yaw, "peakSlipDeg": peak_slip,
            "headingChangeDeg": drift_heading, "exitSpeed": drift_end_speed, "speedKept": if drift_entry_speed > 0. { drift_end_speed / drift_entry_speed } else { 0. }}) } else { Value::Null },
        "attack": attack.map(|a| json!({"kind": a["kind"], "closest": closest, "endInCarFrame": projectile_end})),
        "driveAway": drive_away, "sceneBroken": scene_damage,
    });
    out["audits"] = json!(damage.audits);
    out["bodyMass"] = json!(damage.body_mass);
    out["wheelLoadsEndKN"] = json!(damage.last_wheels);
    out["actorsEnd"] = actors_end;
    out["carrierParts"] = if carrier_parts.len() <= 40 { json!(carrier_parts) } else { json!(carrier_parts.len()) };
    out["converged"] = json!(if solves > 0 { converged as f32 / solves as f32 } else { 0. });
    out["stepMs"] = json!({"median": sorted.get(sorted.len() / 2), "p95": sorted.get(sorted.len() * 95 / 100), "max": sorted.last()});
    out["trace"] = json!(trace);
    out
}

/// What-ifs on the prepared car (A/B only; the fix belongs in the authoring):
/// VIBE_TESTBED_SCALE_WHEEL_MOUNT=k multiplies the strength of every bond
/// between a wheel and its hub, VIBE_TESTBED_SCALE_CORNER=k of every bond
/// with a wheel-corner part (wheel, hub, upright, arms, shock, axle) on
/// either side.
fn what_if(geometry: &crate::vehicle_assets::PreparedGeometry) -> crate::vehicle_assets::PreparedGeometry {
    let mut g = geometry.clone();
    let env = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<f64>().ok());
    let role = |id: &str| g.parts.iter().find(|p| p.id == id).and_then(|p| p.motion.as_ref()).and_then(|m| m.get("role")).and_then(|r| r.as_str()).map(str::to_string);
    let roles: Vec<(Option<String>, Option<String>)> = g.bonds.iter().map(|b| (role(&b.a), role(&b.b))).collect();
    let scale = |s: &mut crate::vehicle_assets::AssetBondStrength, k: f64| {
        for v in [&mut s.compression_elastic, &mut s.compression_fatal, &mut s.tension_elastic, &mut s.tension_fatal, &mut s.shear_elastic, &mut s.shear_fatal] { *v *= k; }
    };
    for (bond, (ra, rb)) in g.bonds.iter_mut().zip(roles) {
        let roles = [ra.as_deref(), rb.as_deref()];
        if let Some(k) = env("VIBE_TESTBED_SCALE_WHEEL_MOUNT") { if roles.contains(&Some("wheel")) && roles.contains(&Some("hub")) { scale(&mut bond.strength, k); } }
        if let Some(k) = env("VIBE_TESTBED_SCALE_CORNER") { if roles.iter().any(|r| r.is_some()) { scale(&mut bond.strength, k); } }
    }
    g
}

#[test]
#[ignore = "requires local GPU, the native-destruction SDK and node (prepares the fleet's assets)"]
fn vehicle_testbed() {
    let _guard = crate::physx_runtime::tests::gpu_test_guard();
    app_settings();
    let cars: Vec<String> = std::env::var("VIBE_TESTBED_CARS").map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_else(|_| crate::city_fleet::DEFAULT_FLEET.iter().map(|s| s.to_string()).collect());
    // The fleet's stress iteration cap (native_runtime::stress_iterations).
    std::env::set_var("VIBE_CITY_DESTRUCTIBLE_VEHICLES", cars.join(","));
    let meta_path = std::env::var("VIBE_TESTBED_META").map(std::path::PathBuf::from).unwrap_or_else(|_| repo().join("structures/vehicle-lab/out/vehicle-lab.meta.json"));
    let meta: Value = serde_json::from_slice(&std::fs::read(&meta_path).expect("lab meta: node structures/vehicle-lab/build-lab.mjs")).unwrap();
    let wanted = std::env::var("VIBE_TESTBED_TRIALS").unwrap_or_default();
    let trials: Vec<&Value> = meta["trials"].as_array().unwrap().iter()
        .filter(|t| wanted.is_empty() || wanted.split(',').any(|w| t["id"].as_str().unwrap().starts_with(w.trim())))
        .filter(|t| (t["scene"].as_str() == Some("town")) == town()).collect();
    let scene = SceneIndex::load();
    let fleet = tokio::runtime::Runtime::new().unwrap().block_on(crate::city_fleet::prepare(&cars));
    let mut runs = Vec::new();
    for (_, build, asset) in &fleet.cars {
        let geometry = what_if(&asset.geometry);
        for trial in &trials {
            let started = std::time::Instant::now();
            let result = run(&Run { car: build, trial, geometry: &geometry, scene: &scene }, &meta);
            eprintln!("{build:<8} {:<11} {:>5.1} m/s top  z {:>6.1}  goal {:>5}  stall {:>4.1}s  {:>3} bonds ({} corner) {:>3} parts {} wheels lost  ride {:.2}->{:.2}  scene {:?}  {:.0} s",
                trial["id"].as_str().unwrap(), result["topSpeed"].as_f64().unwrap(), result["maxZ"].as_f64().unwrap(),
                result["goalSeconds"].as_f64().map_or("-".into(), |s| format!("{s:.1}s")), result["stalledSeconds"].as_f64().unwrap(),
                result["bondsBroken"], result["cornerBondsBroken"], result["partsOff"], result["wheelsLost"],
                result["rideHeightStart"].as_f64().unwrap(), result["rideHeightEnd"].as_f64().unwrap(), result["sceneBroken"], started.elapsed().as_secs_f32());
            if let Some(f) = result["firstBreaks"].as_array().filter(|f| !f.is_empty()) {
                eprintln!("{:>20} first breaks: {}", "", f.iter().take(4).map(|s| s.as_str().unwrap()).collect::<Vec<_>>().join("; "));
            }
            runs.push(result);
        }
    }
    let label = std::env::var("VIBE_TESTBED_LABEL").unwrap_or_else(|_| "report".into());
    let dir = repo().join("target/vehicle-testbed");
    std::fs::create_dir_all(&dir).unwrap();
    let env: HashMap<String, String> = std::env::vars().filter(|(k, _)| k.starts_with("VIBE_") || k.starts_with("PX_") || k.starts_with("BLAST_")).collect();
    let report = json!({"label": label, "harness": "headless", "scene": std::env::var("VIBE_CITY_SCENE").unwrap(), "env": env, "runs": runs});
    let path = dir.join(format!("{label}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("report: {}", path.display());
}
