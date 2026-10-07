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
//! VIBE_TESTBED_START_OFFSET=dx,dz  start the car off its slot (m): how much an outcome depends on the exact pose
//! VIBE_VEHICLE_ROAD_LOG=1  per tick: the bridge's road hits, then the wheels' loads, the car's stress input by
//!                       source, and the scene chunks loading it (anchored or not)
//! VIBE_TESTBED_REPORT_PASSES  which solve that reads (1 the trial, default; 2 the corrected pass)
//! VIBE_TESTBED_WATCH_NODES=a,b  those scene nodes' bonds, per logged tick
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
struct SceneIndex { group_of_node: Vec<String>, nodes: Vec<Value>, materials: Vec<String>, types: Vec<String> }
impl SceneIndex {
    fn load() -> Self {
        let path = std::env::var("VIBE_CITY_SCENE").unwrap();
        let pack: Value = serde_json::from_slice(&std::fs::read(&path).expect("lab scene pack")).unwrap();
        let group_of_node = pack["scenario"]["nodeGroups"].as_array().unwrap().iter().map(|g| g.as_str().unwrap_or("").to_string()).collect();
        let nodes = pack["scenario"]["nodes"].as_array().cloned().unwrap_or_default();
        let materials = pack["scenario"]["nodeMaterials"].as_array().map_or(Vec::new(), |m| m.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect());
        let types = pack["scenario"]["nodeTypes"].as_array().map_or(Vec::new(), |m| m.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect());
        Self { group_of_node, nodes, materials, types }
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
    // The chunks taking the most contact load on this step (kN), for the audit.
    let contacts = |r: &vibe_land_physx_bridge::FfiStressSolveReport| -> Value {
        let mut rows: Vec<(f32, String)> = r.chunks.iter().filter(|c| c.structure_id == structure && (c.node as usize) < geometry.parts.len()).map(|c| {
            let v = &c.contact_linear;
            ((v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * geometry.parts[c.node as usize].mass as f32 / 1e3, geometry.parts[c.node as usize].name.clone())
        }).filter(|r| r.0 > 1.).collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        json!(rows.iter().take(6).map(|(f, n)| format!("{n} {f:.0}")).collect::<Vec<_>>())
    };
    let Ok(d) = arena.vehicle_destruction_debug(id) else { return };
    let mut contacts_logged = false;
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
                    "loadsKN": loads(&geometry.bonds[index as usize].a, &geometry.bonds[index as usize].b),
                    "contactsKN": if contacts_logged { Value::Null } else { contacts_logged = true; report.as_ref().map_or(Value::Null, contacts) }}));
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

/// The brick-veneer house's frame (veneer-houses.mjs STRUCTURAL_TYPES); every
/// other member type is skin, trim or covering.
const FRAME_TYPES: &[&str] = &["foundation", "stud", "king-stud", "jack-stud", "cripple-stud", "junction-stud", "bottom-plate", "top-plate",
    "header", "sill-trimmer", "rim-joist", "ceiling-joist", "floor-joist", "subfloor", "rafter", "ridge-board", "gable-frame"];
const ROOF_TYPES: &[&str] = &["rafter", "ridge-board", "ceiling-joist"];

/// What a hit did to the framed house (lane framed-house): its bonds broken,
/// frame against skin, by distance from the impact point, whether its roof and
/// frame still stand, and -- for a car -- which pieces it freed were inside the
/// car's hulls when they were freed (installed where they stood, overlapping it).
struct HouseProbe {
    is_house: Vec<bool>,
    broken_before: BTreeSet<u32>,
    roof_start: Vec<(u32, f32)>,
    anchored: u32,
    inside: BTreeSet<u32>,
    crushed: u32,
}
fn node_centroid(scene: &SceneIndex, i: u32) -> Vector3<f32> {
    let c = &scene.nodes[i as usize]["centroid"];
    Vector3::new(c["x"].as_f64().unwrap_or(0.) as f32, c["y"].as_f64().unwrap_or(0.) as f32, c["z"].as_f64().unwrap_or(0.) as f32)
}
impl HouseProbe {
    fn start(arena: &mut crate::movement::PhysicsArena, scene: &SceneIndex) -> Option<Self> {
        let is_house: Vec<bool> = scene.group_of_node.iter().map(|g| g.starts_with("framed-house")).collect();
        if !is_house.iter().any(|&h| h) { return None; }
        let world = arena.physx_world_mut()?;
        let broken_before = world.native_bond_stress_rows(0).unwrap_or_default().into_iter()
            .filter(|r| (r.remaining_area <= 0.0 || r.broken) && is_house[r.node0 as usize]).map(|r| r.bond_index).collect();
        let mut roof_start = Vec::new();
        for (i, t) in scene.types.iter().enumerate() {
            if is_house[i] && ROOF_TYPES.contains(&t.as_str()) {
                if let Ok(a) = world.native_chunk_aim(0, i as u32) { if a.found { roof_start.push((i as u32, a.center.y)); } }
            }
        }
        Some(Self { is_house, broken_before, roof_start, anchored: vibe_land_physx_bridge::native_entity_id(0, 0), inside: BTreeSet::new(), crushed: 0 })
    }
    /// House pieces no longer on the anchored body whose centre is inside one
    /// of the car's hulls (each hull's box in the car frame).
    fn scan_car(&mut self, arena: &mut crate::movement::PhysicsArena, car: &CarState, hulls: &[([f32; 3], [f32; 3])]) {
        let Some(world) = arena.physx_world_mut() else { return };
        for i in 0..self.is_house.len() {
            if !self.is_house[i] || self.inside.contains(&(i as u32)) { continue; }
            let Ok(a) = world.native_chunk_aim(0, i as u32) else { continue };
            if !a.found || a.entity_id == self.anchored { continue; }
            let local = car.q.inverse() * (Vector3::new(a.center.x, a.center.y, a.center.z) - car.p);
            if hulls.iter().any(|(lo, hi)| (0..3).all(|k| local[k] >= lo[k] && local[k] <= hi[k])) { self.inside.insert(i as u32); }
        }
    }
    fn finish(&self, arena: &mut crate::movement::PhysicsArena, scene: &SceneIndex, impact: Option<Vector3<f32>>) -> Value {
        let world = arena.physx_world_mut().expect("physx");
        let rows = world.native_bond_stress_rows(0).unwrap_or_default();
        let frame = |i: u32| FRAME_TYPES.contains(&scene.types.get(i as usize).map_or("", |s| s.as_str()));
        let (mut total, mut structural_total, mut broken, mut structural) = (0u32, 0u32, 0u32, 0u32);
        let edges = [0f32, 1., 2., 4., 8., 1e9];
        let mut by_distance = [0u32; 5];
        let mut distances = Vec::new();
        for r in &rows {
            if !(self.is_house[r.node0 as usize] && self.is_house[r.node1 as usize]) { continue; }
            total += 1;
            let is_frame = frame(r.node0) && frame(r.node1);
            if is_frame { structural_total += 1; }
            if !(r.remaining_area <= 0.0 || r.broken) || self.broken_before.contains(&r.bond_index) { continue; }
            broken += 1;
            if is_frame { structural += 1; }
            if let Some(p) = impact {
                let d = ((node_centroid(scene, r.node0) + node_centroid(scene, r.node1)) * 0.5 - p).norm();
                distances.push(d);
                by_distance[(0..5).find(|&k| d < edges[k + 1]).unwrap_or(4)] += 1;
            }
        }
        distances.sort_by(f32::total_cmp);
        // Roof: how far its members came down; frame: how much is still on the anchored body.
        let (mut drops, mut gone) = (Vec::new(), 0u32);
        for &(i, y0) in &self.roof_start {
            match world.native_chunk_aim(0, i) { Ok(a) if a.found => drops.push(y0 - a.center.y), _ => gone += 1 }
        }
        drops.sort_by(f32::total_cmp);
        let (mut frame_nodes, mut frame_anchored) = (0u32, 0u32);
        for i in 0..self.is_house.len() as u32 {
            if !self.is_house[i as usize] || !frame(i) || scene.types[i as usize] == "foundation" { continue; }
            frame_nodes += 1;
            if world.native_chunk_aim(0, i).map_or(false, |a| a.found && a.entity_id == self.anchored) { frame_anchored += 1; }
        }
        let mean = |v: &[f32]| if v.is_empty() { 0. } else { v.iter().sum::<f32>() / v.len() as f32 };
        json!({
            "bonds": total, "broken": broken, "brokenFrac": broken as f32 / total.max(1) as f32,
            "structuralBonds": structural_total, "structuralBroken": structural, "cosmeticBroken": broken - structural,
            "byDistance": {"0-1m": by_distance[0], "1-2m": by_distance[1], "2-4m": by_distance[2], "4-8m": by_distance[3], "8m+": by_distance[4]},
            "medianBreakDistance": distances.get(distances.len() / 2),
            "impact": impact.map(|p| [p.x, p.y, p.z]),
            "roofDropMean": mean(&drops), "roofDropMedian": drops.get(drops.len() / 2), "roofMembersDown": drops.iter().filter(|&&d| d > 0.5).count(),
            "roofMembers": self.roof_start.len(), "roofMembersGone": gone,
            "frameAnchoredFrac": frame_anchored as f32 / frame_nodes.max(1) as f32,
            "crushedChunks": self.crushed,
            "freedInsideCar": self.inside.len(),
        })
    }
}

fn run(r: &Run, meta: &Value) -> Value {
    let id = crate::city_fleet::FIRST_ID;
    let trial = r.trial;
    let geometry = r.geometry;
    let slot = trial["slot"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect::<Vec<_>>();
    let (x, z, heading) = (slot[0], slot[1], slot[2].to_radians());
    // VIBE_TESTBED_START_OFFSET=dx,dz: start the car off its slot (metres), to
    // tell an outcome from the exact pose it meets an obstacle in.
    let offset: Vec<f32> = std::env::var("VIBE_TESTBED_START_OFFSET").ok().map(|v| v.split(',').filter_map(|s| s.trim().parse().ok()).collect()).unwrap_or_default();
    let (x, z) = (x + offset.first().copied().unwrap_or(0.), z + offset.get(1).copied().unwrap_or(0.));
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
    // Per tick: [tick, bonds broken (all evaluations), chunks crushed, step ms].
    let mut stage: Vec<[f32; 4]> = Vec::new();
    let mut step = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32, input: Option<&InputCmd>| {
        if let Some(input) = input { arena.simulate_player_tick(PLAYER, input, DT); }
        let t0 = std::time::Instant::now();
        arena.step_vehicles_and_dynamics(DT);
        let _ = city.step(*tick, DT, gravity, arena.physx_world_mut());
        // The native solve report (bit 0: the trial solve that decides what breaks), when auditing.
        // VIBE_TESTBED_REPORT_PASSES: which solves record (bit 0 the trial, bit 1 the corrected one; the last one recorded is read).
        if (auditing() || std::env::var_os("VIBE_VEHICLE_ROAD_LOG").is_some()) && !report_on {
            let passes = std::env::var("VIBE_TESTBED_REPORT_PASSES").ok().and_then(|v| v.parse().ok()).unwrap_or(1u32);
            report_on = arena.physx_world_mut().is_some_and(|w| w.native_set_stress_solve_report(passes).unwrap_or(false));
        }
        step_ms.push(t0.elapsed().as_secs_f32() * 1000.);
        if let Some((status, counts, _)) = city.native_tick_view() {
            solves += 1; if status.converged { converged += 1; }
            stage.push([*tick as f32, status.broken_bonds as f32, status.crushed_chunks as f32, *step_ms.last().unwrap_or(&0.)]);
            // VIBE_TESTBED_STAGE=1: each tick that breaks anything -- in the trial
            // evaluation, the corrected one, and after the motion is final.
            if std::env::var_os("VIBE_TESTBED_STAGE").is_some() && (status.broken_bonds > 0 || status.post_correction_broken_bonds > 0) {
                eprintln!("[stage] tick {} broken {} committed {} after-correction {} corrections {} stress-passes {} iterations {} converged {}",
                    *tick, status.broken_bonds, counts.bonds_broken, status.post_correction_broken_bonds, status.correction_passes, status.stress_passes, status.iterations, status.converged);
            }
        }
        *tick += 1;
    };
    for _ in 0..SETTLE_TICKS { step(&mut arena, &mut city, &mut tick, None); }
    let mut damage = Damage { broken: BTreeMap::new(), parts_off: BTreeSet::new(), wheel_mask: 15, last: HashMap::new(), last_wheels: Vec::new(), audits: Vec::new(), body_mass: [0.; 2] };
    read_damage(&mut arena, id, tick, &mut damage, geometry, 0.);
    let settled_broken = damage.broken.len();
    let scene_before = scene_broken(&mut arena, r.scene);
    let mut house = if trial["id"].as_str().unwrap_or("").contains("framed-house") { HouseProbe::start(&mut arena, r.scene) } else { None };
    // The car's hulls as boxes in its frame (for what the house frees inside it).
    let hulls: Vec<([f32; 3], [f32; 3])> = geometry.parts.iter().flat_map(|p| p.shapes.iter().map(move |sh| {
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for v in &sh.vertices { for k in 0..3 { let x = p.position[k] + sh.position[k] + v[k]; lo[k] = lo[k].min(x); hi[k] = hi[k].max(x); } }
        (lo, hi)
    })).collect();
    let mut house_impact: Option<Vector3<f32>> = None;
    let mut peak_spin_after = 0f32;
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
    // A shot at the scene (attack `shot`): its aim point and direction, and
    // how far past the aim point it got along that direction (the wall face).
    let mut shot: Option<(Vector3<f32>, Vector3<f32>)> = None;
    let (mut shot_past, mut shot_speed_end) = (f32::NEG_INFINITY, 0f32);
    let mut trace = Vec::new();
    let tracing = std::env::var_os("VIBE_TESTBED_TRACE").is_some();
    let heading_of = |f: Vector3<f32>| f.x.atan2(f.z);
    for k in 0..ticks {
        let s = car_state(&mut arena, id);
        let speed = (s.v.x * s.v.x + s.v.z * s.v.z).sqrt();
        top = top.max(speed);
        max_z = max_z.max(s.p.z);
        let t = k as f32 * DT;
        for (name, at) in [("2s", 2.0f32), ("4s", 4.0), ("5s", 5.0), ("8s", 8.0), ("10s", 10.0)] { if (t - at).abs() < DT * 0.5 { speed_at.insert(name.into(), speed); } }
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
        // `shots`: several balls (`mass` kg at the cannonball's speed), each at
        // its `t` at its `target`, from `from` degrees, `distance` out, `slope`.
        if let Some(a) = attack.filter(|a| a["kind"] == "shots") {
            let list = a["shots"].as_array().unwrap();
            while launched < list.len() && list[launched]["t"].as_f64().unwrap() as f32 <= t + 1e-4 {
                let shot_def = &list[launched];
                let f = |k: &str| a[k].as_f64().unwrap_or(0.) as f32;
                let tv: Vec<f32> = shot_def["target"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
                let target = Vector3::new(tv[0], tv[1], tv[2]);
                let bearing = f("from").to_radians();
                let origin = target + Vector3::new(bearing.sin(), f("slope"), bearing.cos()) * f("distance");
                let speed = crate::city::city_ball_speed_ms();
                let tt = (origin - target).norm() / speed;
                let velocity = (target - origin) / tt + Vector3::new(0., 0.5 * 9.81 * tt, 0.);
                let mass = shot_def["mass"].as_f64().unwrap_or(100.) as f32;
                let radius = (mass / crate::city::city_ball_density_kg_m3() * 3. / (4. * std::f32::consts::PI)).cbrt();
                projectile = arena.launch_ball_from_muzzle(origin, velocity, radius, mass, 600).or(projectile);
                if shot.is_none() { shot = Some((target, Vector3::new(-bearing.sin(), 0., -bearing.cos()))); }
                launched += 1;
            }
        }
        if let (Some(a), Some(at)) = (attack.filter(|a| !matches!(a["kind"].as_str(), Some("strikes" | "timeline" | "near" | "shots"))), attack_tick) {
            if k == at {
                match a["kind"].as_str().unwrap() {
                    "shot" => {
                        // The game's cannonball or meteor at a point in the scene
                        // (`target`), from compass bearing `from` (degrees, 0 = +z)
                        // `distance` m out and `slope` m up per metre out.
                        let f = |k: &str| a[k].as_f64().unwrap_or(0.) as f32;
                        let t: Vec<f32> = a["target"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
                        let target = Vector3::new(t[0], t[1], t[2]);
                        let bearing = f("from").to_radians();
                        let out = Vector3::new(bearing.sin(), f("slope"), bearing.cos());
                        let origin = target + out * f("distance");
                        let meteor = a["projectile"] == "meteor";
                        let speed = if meteor { 140. } else { crate::city::city_ball_speed_ms() };
                        let tt = (origin - target).norm() / speed;
                        let velocity = (target - origin) / tt + Vector3::new(0., 0.5 * 9.81 * tt, 0.);
                        projectile = if meteor {
                            let tuning = crate::meteor::MeteorTuning::from_env();
                            arena.launch_meteor(origin, velocity, tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks)
                        } else if let Some(mass) = a["mass"].as_f64().map(|m| m as f32) {
                            // A lighter ball of the cannonball's steel (`mass` kg).
                            let radius = (mass / crate::city::city_ball_density_kg_m3() * 3. / (4. * std::f32::consts::PI)).cbrt();
                            arena.launch_ball_from_muzzle(origin, velocity, radius, mass, 600)
                        } else {
                            arena.launch_ball_from_muzzle(origin, velocity, crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), 600)
                        };
                        shot = Some((target, Vector3::new(-bearing.sin(), 0., -bearing.cos())));
                    }
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
        // VIBE_VEHICLE_ROAD_LOG=1 (the bridge's [road] lines, one per wheel
        // query hit): tag them with the trial tick, and after the step give
        // each wheel's jounce and its Vehicle2 loads (kN: suspension, tyre,
        // suspension-limit/sticky constraint).
        let road_log = std::env::var_os("VIBE_VEHICLE_ROAD_LOG").is_some();
        if road_log { eprintln!("[tick] {k} begin z {:.2} speed {:.2}", s.p.z, speed); }
        step(&mut arena, &mut city, &mut tick, if driving { Some(&input) } else { None });
        if road_log {
            let a = car_state(&mut arena, id);
            let m = |w: &Value, k: &str| (w[k].as_array().map_or(0., |v| v.iter().map(|x| x.as_f64().unwrap_or(0.).powi(2)).sum::<f64>().sqrt()) / 100.).round() / 10.;
            let v = |w: &Value, k: &str| w[k].as_array().map_or(String::new(), |v| v.iter().map(|x| format!("{:.0}", x.as_f64().unwrap_or(0.) / 1e3)).collect::<Vec<_>>().join(","));
            let loads = arena.vehicle_destruction_debug(id).ok().map_or(String::new(), |d| d["wheelLoads"].as_array().into_iter().flatten()
                .map(|w| format!("w{} s{} t{} c{} [{}]", w["wheel"], m(w, "suspension"), m(w, "tire"), m(w, "constraintForce"), v(w, "constraintForce"))).collect::<Vec<_>>().join("  "));
            // The car's stress input summed over its parts, by source (kN): prepared (gravity, Vehicle2's wheel commands), constraint, contact.
            let sources = arena.physx_world_mut().and_then(|w| w.native_stress_solve_report().ok()).map_or(String::new(), |rep| {
                let mut sum = [[0f32; 3]; 3];
                for c in rep.chunks.iter().filter(|c| c.structure_id == 200 && (c.node as usize) < geometry.parts.len()) {
                    let m = geometry.parts[c.node as usize].mass as f32 / 1e3;
                    for (i, v) in [&c.prepared_linear, &c.constraint_linear, &c.contact_linear].into_iter().enumerate() { sum[i][0] += v.x * m; sum[i][1] += v.y * m; sum[i][2] += v.z * m; }
                }
                let mut top: Vec<(f32, String)> = rep.chunks.iter().filter(|c| c.structure_id == 200 && (c.node as usize) < geometry.parts.len()).map(|c| {
                    let (v, m) = (&c.contact_linear, geometry.parts[c.node as usize].mass as f32 / 1e3);
                    ((v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * m, format!("{} ({:.0},{:.0},{:.0})", geometry.parts[c.node as usize].name, v.x * m, v.y * m, v.z * m))
                }).filter(|t| t.0 > 50.).collect();
                top.sort_by(|a, b| b.0.total_cmp(&a.0));
                // The scene chunks taking the most contact load (kN): where, what, and whether anchored (component u32::MAX).
                let mut scene_top: Vec<(f32, String)> = rep.chunks.iter().filter(|c| c.structure_id != 200).filter_map(|c| {
                    let node = r.scene.nodes.get(c.node as usize)?;
                    let m = node["mass"].as_f64().unwrap_or(0.) as f32 / 1e3;
                    let v = &c.contact_linear;
                    let f = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * m;
                    let p = &node["centroid"];
                    Some((f, format!("s{}n{} {} {:.0}kg at {:.2},{:.2},{:.2} {} comp {} ({:.0},{:.0},{:.0})", c.structure_id, c.node, r.scene.materials.get(c.node as usize).map_or("?", |s| s.as_str()),
                        m * 1e3, p["x"].as_f64().unwrap_or(0.), p["y"].as_f64().unwrap_or(0.), p["z"].as_f64().unwrap_or(0.),
                        r.scene.group_of_node.get(c.node as usize).map_or("?", |s| s.as_str()), if c.component == u32::MAX { "anchored".into() } else { c.component.to_string() }, v.x * m, v.y * m, v.z * m)))
                }).filter(|t| t.0 > 50.).collect();
                scene_top.sort_by(|a, b| b.0.total_cmp(&a.0));
                let scene_top = scene_top.iter().take(10).map(|t| t.1.clone()).collect::<Vec<_>>().join("; ");
                format!("scene {scene_top} || prepared {:.0},{:.0},{:.0} constraint {:.0},{:.0},{:.0} contact {:.0},{:.0},{:.0} top {}", sum[0][0], sum[0][1], sum[0][2], sum[1][0], sum[1][1], sum[1][2], sum[2][0], sum[2][1], sum[2][2],
                    top.iter().take(8).map(|t| t.1.clone()).collect::<Vec<_>>().join("; "))
            });
            // VIBE_TESTBED_WATCH_NODES=a,b: those scene nodes' bonds (the last trial solve's stresses, MPa).
            if let Ok(watch) = std::env::var("VIBE_TESTBED_WATCH_NODES") {
                let watch: Vec<u32> = watch.split(',').filter_map(|v| v.trim().parse().ok()).collect();
                if let Some(w) = arena.physx_world_mut() {
                    for row in w.native_bond_stress_rows(0).unwrap_or_default().iter().filter(|b| watch.contains(&b.node0) || watch.contains(&b.node1)) {
                        eprintln!("[bond] {k} {}-{} area {:.3} util {:.2} c {:.2} t {:.2} s {:.2} damage {:.2} remaining {:.3} broken {}", row.node0, row.node1, row.area, row.utilisation,
                            row.compression / 1e6, row.tension / 1e6, row.shear / 1e6, row.damage, row.remaining_area, row.broken);
                    }
                }
            }
            eprintln!("[tick] {k} end w {:.2},{:.2},{:.2} z {:.2} y {:.2} v {:.2},{:.2},{:.2} jounce {:?} | {loads} | kN {sources}", a.w.x, a.w.y, a.w.z, a.p.z, a.p.y, a.v.x, a.v.y, a.v.z, a.jounce);
        }
        let after = car_state(&mut arena, id);
        // The house: where it was hit; for a car, what it freed inside the car
        // over the impact tick and the next five, and how the car spun for 3 s.
        if let Some(h) = house.as_mut() {
            if driving && impact_tick.is_some() {
                let since = k - impact_tick.unwrap();
                if house_impact.is_none() { house_impact = Some(after.p + after.forward * front + Vector3::new(0., 0.0, 0.)); }
                if since <= 5 { h.scan_car(&mut arena, &after, &hulls); }
                if since <= 180 { peak_spin_after = peak_spin_after.max(after.w.norm()); }
            }
        }
        let after = car_state(&mut arena, id);
        let accel_g = prev_v.map_or(0., |pv| (after.v - pv).norm() / DT / 9.81);
        peak_decel = peak_decel.max(accel_g);
        prev_v = Some(after.v);
        if let Some(pid) = projectile {
            if let Some(b) = arena.snapshot_dynamic_bodies().into_iter().find(|b| b.0 == pid) {
                let p = Vector3::new(b.1[0], b.1[1], b.1[2]);
                closest = closest.min((p - after.p).norm());
                if let Some((target, dir)) = shot { shot_past = shot_past.max((p - target).dot(&dir)); }
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
        // First let it come to rest (a cannonball throws a car at 50 m/s): up
        // to 10 s until it has moved under 0.5 m/s for half a second.
        let mut quiet = 0;
        for _ in 0..600 {
            if quiet >= 30 { break; }
            // On the handbrake: with the throttle up a car coasts on undiminished
            // (Vehicle2 here has no rolling resistance or drag: a monster truck
            // thrown at 31 m/s rolled on at 31 m/s for 10 s).
            let mut hold = InputCmd::default();
            hold.buttons |= BTN_JUMP;
            step(&mut arena, &mut city, &mut tick, Some(&hold));
            let s = car_state(&mut arena, id);
            quiet = if (s.v.x * s.v.x + s.v.z * s.v.z).sqrt() < 0.5 { quiet + 1 } else { 0 };
        }
        let mut path = 0f32;
        let from = car_state(&mut arena, id).p;
        let mut last = from;
        for k in 0..reverse + forward {
            let mut input = InputCmd::default();
            if k < reverse { input.move_y = -127; } else { input.move_y = 127; if reverse > 0 { input.move_x = 127; } }
            step(&mut arena, &mut city, &mut tick, Some(&input));
            let p = car_state(&mut arena, id).p;
            path += ((p.x - last.x).powi(2) + (p.z - last.z).powi(2)).sqrt();
            last = p;
        }
        read_damage(&mut arena, id, tick, &mut damage, geometry, 0.);
        // Net displacement driven (a car rocking on the spot covers path, not ground).
        let net = ((last.x - from.x).powi(2) + (last.z - from.z).powi(2)).sqrt();
        drive_away = json!({"metres": net, "path": path, "seconds": (reverse + forward) as f32 * DT, "settled": quiet >= 30});
    }
    let scene_after = scene_broken(&mut arena, r.scene);
    if house.is_some() && house_impact.is_none() { house_impact = shot.map(|(t, _)| t); }
    let house_report = house.as_ref().map(|h| h.finish(&mut arena, r.scene, house_impact));
    let scene_broken_pairs: Vec<[u32; 2]> = if std::env::var_os("VIBE_TESTBED_SCENE_BONDS").is_some() {
        arena.physx_world_mut().expect("physx").native_bond_stress_rows(0).unwrap_or_default().into_iter()
            .filter(|r| r.remaining_area <= 0.0 || r.broken).map(|r| [r.node0, r.node1]).collect()
    } else { Vec::new() };
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
    let drive_state = arena.vehicle_destruction_debug(id).map(|d| json!({"wheelMask": d["vehicle"]["wheelMask"], "driveMask": d["vehicle"]["driveMask"],
        "engineConnected": d["vehicle"]["engineConnected"], "wheelsOnRoad": d["vehicle2"]["wheelsOnRoad"]})).unwrap_or(Value::Null);
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
        "attack": attack.map(|a| json!({"kind": a["kind"], "closest": closest, "endInCarFrame": projectile_end,
            "pastTarget": if shot.is_some() && shot_past.is_finite() { json!(shot_past) } else { Value::Null }})),
        "driveAway": drive_away, "sceneBroken": scene_damage,
    });
    out["audits"] = json!(damage.audits);
    out["bodyMass"] = json!(damage.body_mass);
    out["wheelLoadsEndKN"] = json!(damage.last_wheels);
    out["actorsEnd"] = actors_end;
    out["driveState"] = drive_state;
    out["carrierParts"] = if carrier_parts.len() <= 40 { json!(carrier_parts) } else { json!(carrier_parts.len()) };
    out["converged"] = json!(if solves > 0 { converged as f32 / solves as f32 } else { 0. });
    // VIBE_TESTBED_SCENE_BONDS=1: the scene's broken bonds at the end, as node pairs.
    if std::env::var_os("VIBE_TESTBED_SCENE_BONDS").is_some() { out["sceneBrokenPairs"] = json!(scene_broken_pairs); }
    if let Some(mut h) = house_report {
        // The impact tick: the first after the trial began that broke anything.
        let begin = (SETTLE_TICKS) as f32;
        let first = stage.iter().find(|s| s[0] >= begin && s[1] > 0.);
        let window: Vec<&[f32; 4]> = first.map_or(Vec::new(), |f| stage.iter().filter(|s| s[0] >= f[0] && s[0] < f[0] + 3.).collect());
        h["impactTick"] = json!(first.map(|f| f[0]));
        h["impactStepMs"] = json!(first.map(|f| f[3]));
        h["impactWindowMaxStepMs"] = json!(window.iter().map(|s| s[3]).fold(0f32, f32::max));
        h["crushedChunks"] = json!(stage.iter().filter(|s| s[0] >= begin).map(|s| s[2]).sum::<f32>());
        h["carPeakSpin3s"] = json!(peak_spin_after);
        out["house"] = h;
    }
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
    // VIBE_TESTBED_MASS_SCALE=k: every part's mass and inertia, and the driving
    // setup derived from mass (customization.mjs drivingSetup), scaled together.
    if let Some(k) = env("VIBE_TESTBED_MASS_SCALE") {
        for part in &mut g.parts {
            part.mass *= k; part.mass_properties.mass *= k;
            for row in &mut part.mass_properties.inertia { for x in row { *x *= k; } }
        }
        g.mass *= k as f32; g.mass_properties.mass *= k;
        for row in &mut g.mass_properties.inertia { for x in row { *x *= k; } }
        if let Some(d) = g.driving.as_mut() { d.drive_torque *= k as f32; d.brake_torque *= k as f32; d.spring_stiffness *= k as f32; d.damping *= k as f32; }
    }
    for (bond, (ra, rb)) in g.bonds.iter_mut().zip(roles) {
        let roles = [ra.as_deref(), rb.as_deref()];
        if let Some(k) = env("VIBE_TESTBED_SCALE_WHEEL_MOUNT") { if roles.contains(&Some("wheel")) && roles.contains(&Some("hub")) { scale(&mut bond.strength, k); } }
        if let Some(k) = env("VIBE_TESTBED_SCALE_CORNER") { if roles.iter().any(|r| r.is_some()) { scale(&mut bond.strength, k); } }
        if let Some(k) = env("VIBE_TESTBED_SCALE_ALL") { scale(&mut bond.strength, k); }
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
        // VIBE_TESTBED_REPEAT=n: each trial n times (GPU physics is not
        // bit-reproducible: one run of a crash is one sample).
        let repeat: usize = std::env::var("VIBE_TESTBED_REPEAT").ok().and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
        for trial in trials.iter().flat_map(|t| std::iter::repeat(t).take(repeat)) {
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
