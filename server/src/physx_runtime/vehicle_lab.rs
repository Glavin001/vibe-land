//! Vehicle lab: drive destructible cars through declared scenarios and hold
//! them to declared behaviour, measuring enough to see why they did or did not.
//!
//! A scenario is ground + obstacles + a way of driving + events (a cannonball)
//! + what must be true afterwards (`Expect`). Every run records, per tick, the
//! car's speed and deceleration, the Vehicle2 wheel commands, the stress
//! solve's convergence and the most loaded intact bond; and for each bond that
//! breaks an audit: its load the tick before as a fraction of its fatal
//! limits, whether the solve that broke it converged, what the car was
//! touching, how hard it was decelerating and how its wheel loads compared
//! with its static weight -- classified as `unconverged`, `impact`,
//! `wheel-load` or `unexplained`.
//!
//!   PHYSX_ROOT=../PhysX/out/install/garage-multihull CARGO_TARGET_DIR=target/garage-vehicles \
//!   scripts/perf/gpu-run.sh lab env VIBE_VEHICLE_BUILD_FIXTURES=$PWD/target/vehicle-build-fixtures.json \
//!     CUMETAL_CACHE_DIR=$PWD/target/cumetal-cache-vehicles \
//!     cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server \
//!     vehicle_lab -- --ignored --nocapture --test-threads=1
//!
//! VIBE_LAB_CARS (default the city fleet), VIBE_LAB_SCENARIOS (comma list or
//! prefixes, default all), VIBE_LAB_REPORT_ONLY=1 (print, do not assert).
//! Writes target/vehicle-lab/report.json (every run, every tick, every audit).
#![cfg(all(test, feature = "native-destruction"))]

use super::vehicle_destruction_tests::{bond_label, fixtures, hull_points, Hull, Scene, CAR, DT};
use super::{bridge, tests::gpu_test_guard, InputCmd, Vector3, WorldDocumentArena};
use crate::vehicle_assets::{FractureLayout, PreparedGeometry};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug)]
pub enum Ground {
    /// A 200 m square slab, top at y = 0.
    Flat,
    /// The garage proving ground: hills, banks and the washboard lane.
    Course,
}

#[derive(Clone, Copy, Debug)]
pub enum Obstacle {
    /// A 16 m wide, 3 m tall static wall across the road at z.
    Wall { z: f32 },
    /// A static kerb across the road at z.
    Kerb { z: f32, height: f32 },
    /// A loose block (concrete at 2400 kg/m³) at (x, z).
    Block { x: f32, z: f32, half: [f32; 3] },
}

#[derive(Clone, Copy, Debug)]
pub enum Drive {
    /// Nobody in the car.
    Park,
    /// Straight ahead, holding `speed`.
    Straight { speed: f32 },
    /// The course lap: accelerate, then alternate a tight and a wide turn.
    Laps { speed: f32 },
    /// Straight at `speed` until 4 m from the first obstacle, then coast into it.
    Into { speed: f32 },
}

#[derive(Clone, Copy, Debug)]
pub enum Event {
    /// The city cannonball (10.65 t steel at 60 m/s) at the car from 12 m.
    Cannonball { tick: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Expect {
    /// No bond breaks.
    Intact,
    /// All four wheels stay on.
    KeepsWheels,
    /// Something breaks.
    Breaks,
}

pub struct Scenario {
    pub name: &'static str,
    /// Metres above the resting spawn (0: on its wheels).
    pub lift: f32,
    pub why: &'static str,
    pub ground: Ground,
    pub obstacles: &'static [Obstacle],
    pub drive: Drive,
    pub events: &'static [Event],
    pub ticks: u32,
    pub expect: &'static [Expect],
}

/// The behaviour the cars are held to (report 2026-09-30: "they should break
/// when hit by a cannonball or a fast impact with a wall, but not so easily"
/// -- not from rough terrain or a light knock).
pub fn scenarios() -> Vec<Scenario> {
    use Expect::*;
    vec![
        Scenario { lift: 60., name: "airborne", why: "free fall, no ground: only gravity loads the car (the load-balance control for park)", ground: Ground::Flat, obstacles: &[], drive: Drive::Park, events: &[], ticks: 150, expect: &[Intact] },
        Scenario { lift: 0., name: "park", why: "a parked car carries only its own weight", ground: Ground::Flat, obstacles: &[], drive: Drive::Park, events: &[], ticks: 300, expect: &[Intact] },
        Scenario { lift: 0., name: "cruise-20", why: "straight and level at 72 km/h", ground: Ground::Flat, obstacles: &[], drive: Drive::Straight { speed: 20. }, events: &[], ticks: 300, expect: &[Intact] },
        Scenario { lift: 0., name: "course-12", why: "hills, banks and washboard at 43 km/h", ground: Ground::Course, obstacles: &[], drive: Drive::Laps { speed: 12. }, events: &[], ticks: 1200, expect: &[Intact] },
        Scenario { lift: 0., name: "course-18", why: "the course at 65 km/h", ground: Ground::Course, obstacles: &[], drive: Drive::Laps { speed: 18. }, events: &[], ticks: 1200, expect: &[Intact] },
        Scenario { lift: 0., name: "course-25", why: "the course flat out (90 km/h): may dent, keeps its wheels", ground: Ground::Course, obstacles: &[], drive: Drive::Laps { speed: 25. }, events: &[], ticks: 1200, expect: &[KeepsWheels] },
        Scenario { lift: 0., name: "kerb-10", why: "a 12 cm kerb at 36 km/h", ground: Ground::Flat, obstacles: &[Obstacle::Kerb { z: 40., height: 0.12 }], drive: Drive::Straight { speed: 10. }, events: &[], ticks: 360, expect: &[Intact] },
        Scenario { lift: 0., name: "debris-10", why: "12 cm rubble under the wheels at 36 km/h", ground: Ground::Flat,
            obstacles: &[Obstacle::Block { x: -0.9, z: 25., half: [0.2, 0.06, 0.2] }, Obstacle::Block { x: 0.9, z: 30., half: [0.2, 0.06, 0.2] }, Obstacle::Block { x: 0., z: 35., half: [0.25, 0.06, 0.2] }],
            drive: Drive::Straight { speed: 10. }, events: &[], ticks: 360, expect: &[Intact] },
        Scenario { lift: 0., name: "wall-4", why: "a light knock into a wall (14 km/h)", ground: Ground::Flat, obstacles: &[Obstacle::Wall { z: 60. }], drive: Drive::Into { speed: 4. }, events: &[], ticks: 900, expect: &[Intact] },
        Scenario { lift: 0., name: "wall-8", why: "a firm knock (29 km/h): may dent, keeps its wheels", ground: Ground::Flat, obstacles: &[Obstacle::Wall { z: 60. }], drive: Drive::Into { speed: 8. }, events: &[], ticks: 900, expect: &[KeepsWheels] },
        Scenario { lift: 0., name: "wall-12", why: "43 km/h into a wall: measured, no expectation yet", ground: Ground::Flat, obstacles: &[Obstacle::Wall { z: 60. }], drive: Drive::Into { speed: 12. }, events: &[], ticks: 900, expect: &[] },
        Scenario { lift: 0., name: "wall-20", why: "a fast impact (72 km/h) breaks the car", ground: Ground::Flat, obstacles: &[Obstacle::Wall { z: 60. }], drive: Drive::Into { speed: 20. }, events: &[], ticks: 900, expect: &[Breaks] },
        Scenario { lift: 0., name: "cannonball", why: "the city cannonball breaks the car", ground: Ground::Flat, obstacles: &[], drive: Drive::Park, events: &[Event::Cannonball { tick: 60 }], ticks: 300, expect: &[Breaks] },
    ]
}

/// One broken bond, explained.
struct Audit {
    tick: u32,
    bond: String,
    area: f64,
    /// The tick before: tension, compression and shear as fractions of fatal.
    before: [f64; 3],
    /// The bond's utilisation over the five ticks before the break.
    utilisation: Vec<f64>,
    converged: bool,
    iterations: u64,
    decel_g: f32,
    wheel_load_x_static: f32,
    touching: Vec<String>,
    causes: Vec<&'static str>,
    /// The native solve report of the component the bond belonged to on the
    /// breaking step: stop reason, iterations, residual over tolerance.
    solve: String,
    /// Both chunks' stress input on the breaking step, as forces by source.
    loads: String,
    /// Remaining bonded area as a fraction of authored, and the first tick it
    /// took damage: a bond eroded over many ticks fails on an ordinary one.
    remaining: Vec<f64>,
    damaged_since: Option<u32>,
}

/// A chunk's stress input on the last step as forces by source (N): mass x
/// the linear accelerations the solve consumed -- prepared (gravity, rotation,
/// chunk loads such as Vehicle2 wheel commands), constraint, contact.
fn source_forces(report: &vibe_land_physx_bridge::FfiStressSolveReport, node: u32, mass: f32) -> Option<[f32; 3]> {
    let c = report.chunks.iter().find(|c| c.node == node)?;
    let m = |v: &vibe_land_physx_bridge::FfiVec3| (v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * mass;
    Some([m(&c.prepared_linear), m(&c.constraint_linear), m(&c.contact_linear)])
}

/// Which solves of a step the lab records: VIBE_LAB_REPORT_PASSES (bit mask;
/// default 1, the trial solve that decides what breaks -- on a fracturing
/// step the corrected re-solve after the split would hide it).
fn lab_report_passes() -> u32 { std::env::var("VIBE_LAB_REPORT_PASSES").ok().and_then(|v| v.parse().ok()).unwrap_or(1) }

fn ground_y(ground: Ground, x: f32, z: f32, course: &vibe_land_shared::world_document::WorldDocument) -> f32 {
    match ground { Ground::Flat => 0., Ground::Course => course.sample_heightfield_surface_at_world_position(x, z) }
}

fn run(geometry: &PreparedGeometry, layout: &FractureLayout, s: &Scenario) -> Value {
    let course = crate::demo_world::garage_test_world();
    let mut scene = Scene::new_at(geometry, matches!(s.ground, Ground::Course), s.lift);
    if matches!(s.ground, Ground::Flat) {
        scene.arena.set_spawn_areas(vec![vibe_land_shared::world_document::SpawnArea { id: 1, position: [2.5, 1.5, 3.0], radius: 0.1 }]);
    }
    for (i, o) in s.obstacles.iter().enumerate() {
        match *o {
            Obstacle::Wall { z } => WorldDocumentArena::add_static_cuboid(&mut scene.arena, Vector3::new(0., 1.5, z), [0., 0., 0., 1.], Vector3::new(8., 1.5, 0.5), 10 + i as u128),
            Obstacle::Kerb { z, height } => WorldDocumentArena::add_static_cuboid(&mut scene.arena, Vector3::new(0., height * 0.5, z), [0., 0., 0., 1.], Vector3::new(8., height * 0.5, 0.15), 10 + i as u128),
            Obstacle::Block { x, z, half } => {
                let id = 9000 + i as u32;
                scene.arena.world.add_dynamic_box(bridge::DynamicBoxDesc {
                    entity_id: super::NS_DYNAMIC | id, user_id: id,
                    pose: bridge::Pose { position: bridge::Vec3::new(x, half[1] + 0.01, z), rotation: bridge::Quat { x: 0., y: 0., z: 0., w: 1. } },
                    half_extents: bridge::Vec3::new(half[0], half[1], half[2]), mass: 8. * half[0] * half[1] * half[2] * 2400.,
                    collision_group: super::GROUP_DYNAMIC, collision_mask: super::ALL_GROUPS,
                }).unwrap();
            }
        }
    }
    let first_obstacle_z = s.obstacles.iter().find_map(|o| match o { Obstacle::Wall { z } => Some(*z), _ => None });
    let driving = !matches!(s.drive, Drive::Park);
    if driving {
        scene.arena.spawn_player(42);
        for _ in 0..40 { scene.step(); }
        scene.arena.enter_vehicle(42, CAR);
        assert_eq!(scene.arena.player_vehicle_id(42), Some(CAR), "{}: could not get in", s.name);
    }
    let static_corner = geometry.mass * 9.81 / 4.;
    let mut samples = Vec::new();
    let mut audits: Vec<Audit> = Vec::new();
    let mut broken: HashMap<u64, u32> = HashMap::new();
    let mut before: HashMap<u64, (f64, f64, f64)> = HashMap::new();
    let mut history: HashMap<u64, std::collections::VecDeque<f64>> = HashMap::new();
    let mut prev_hulls = Value::Null;
    let mut remaining: HashMap<u64, std::collections::VecDeque<f64>> = HashMap::new();
    let mut damaged_since: HashMap<u64, u32> = HashMap::new();
    let mut last_v: Option<Vector3<f32>> = None;
    let (mut top, mut impact, mut converged, mut peak_decel, mut peak_wheel, mut peak_u) = (0f32, 0f32, 0u32, 0f32, 0f32, 0f64);
    let mut contact_tick = None;
    let mut step_ms: Vec<f32> = Vec::new();
    let mut tally = crate::structure_qualification::SolveTally::default();
    // Peak stress input by source (N) and the part that took it; ticks a
    // wheel sat at the end of its travel (the suspension limit constraint).
    let (mut peak_constraint, mut peak_contact) = ((0f32, String::new()), (0f32, String::new()));
    let mut bottomed = 0u32;
    let mut last_jounce = [0f32; 4];
    let mut before_jounce = [0f32; 4];
    let travel = geometry.suspension_travel as f32;
    let mut report_on = false;
    for tick in 0..s.ticks {
        let car = scene.arena.current_vehicle_snapshots()[0];
        let v = Vector3::new(car.linear_velocity.x, car.linear_velocity.y, car.linear_velocity.z);
        let speed = (v.x * v.x + v.z * v.z).sqrt();
        top = top.max(speed);
        let mut input = InputCmd::default();
        match s.drive {
            Drive::Park => {}
            Drive::Straight { speed: target } => input.move_y = if speed < target { 100 } else { 0 },
            Drive::Laps { speed: target } => {
                input.move_y = if speed < target { 100 } else { 0 };
                if tick >= 150 { input.move_x = if (tick / 180) % 2 == 0 { 60 } else { 35 }; }
            }
            Drive::Into { speed: target } => {
                if contact_tick.is_none() && first_obstacle_z.is_some_and(|z| car.pose.position.z > z - 4.) { impact = speed; contact_tick = Some(tick); }
                input.move_y = if contact_tick.is_none() && speed < target { 100 } else { 0 };
            }
        }
        for e in s.events {
            let Event::Cannonball { tick: at } = *e;
            if tick == at {
                let (radius, mass, ball_speed) = (crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), crate::city::city_ball_speed_ms());
                let target = Vector3::new(car.pose.position.x, car.pose.position.y + 0.3, car.pose.position.z);
                let origin = target + Vector3::new(12., 0.4, 0.);
                let t = 12. / ball_speed;
                scene.arena.launch_ball_from_muzzle(origin, (target - origin) / t + Vector3::new(0., 0.5 * 9.81 * t, 0.), radius, mass, 600).expect("ball");
            }
        }
        if driving { scene.arena.simulate_player_tick(42, &input, DT); }
        let t0 = std::time::Instant::now();
        scene.step();
        step_ms.push(t0.elapsed().as_secs_f32() * 1e3);
        if contact_tick.is_some_and(|t| tick > t + 180) { break; }
        let after_car = scene.arena.current_vehicle_snapshots()[0];
        // A wheel off the ground reports infinite jounce; only a finite one at
        // the end of its travel is bottomed out.
        if after_car.wheel_jounce.iter().any(|j| j.is_finite() && *j >= travel - 0.005) { bottomed += 1; }
        before_jounce = last_jounce;
        last_jounce = after_car.wheel_jounce;
        let after = after_car.linear_velocity;
        let decel_g = last_v.map_or(0., |_| (Vector3::new(after.x, after.y, after.z) - v).norm() / DT / 9.81);
        last_v = Some(v);
        let raw = scene.arena.vehicle_destruction_debug(CAR).unwrap();
        // The native solve report (PxDestructionScene v23): on once the stage
        // is configured, then every step's report folded in.
        let solve_report = if report_on { scene.arena.world.native_stress_solve_report().ok() } else {
            report_on = scene.arena.world.native_set_stress_solve_report(lab_report_passes()).unwrap_or(false); None };
        if let Some(r) = &solve_report {
            tally.ingest(r, |_| true);
            for c in r.chunks.iter().filter(|c| (c.node as usize) < geometry.parts.len()) {
                let m = geometry.parts[c.node as usize].mass as f32;
                let f = |v: &vibe_land_physx_bridge::FfiVec3| (v.x * v.x + v.y * v.y + v.z * v.z).sqrt() * m;
                let (k, t) = (f(&c.constraint_linear), f(&c.contact_linear));
                if k > peak_constraint.0 {
                    let fmt = |js: &[f32; 4]| js.iter().map(|j| if j.is_finite() { format!("{:.2}", j) } else { "air".into() }).collect::<Vec<_>>().join(" ");
                    // The corner constraints' own solved forces this step (PhysX), to
                    // compare with what the stage routed onto the chunk.
                    let own: Vec<String> = raw["wheelLoads"].as_array().unwrap().iter().map(|w| {
                        let f = w["constraintForce"].as_array().map(|v| v.iter().map(|x| x.as_f64().unwrap().powi(2)).sum::<f64>().sqrt()).unwrap_or(0.);
                        format!("w{} {:.0} kN", w["wheel"], f / 1e3)
                    }).collect();
                    peak_constraint = (k, format!("t{} {}, wheel jounce [{}] -> [{}] of {:.2} m; PhysX corner constraint forces: {}", tick + 1, geometry.parts[c.node as usize].id, fmt(&before_jounce), fmt(&last_jounce), travel, own.join(", ")));
                }
                if t > peak_contact.0 { peak_contact = (t, format!("t{} {}", tick + 1, geometry.parts[c.node as usize].id)); }
            }
            if std::env::var_os("VIBE_LAB_REPORT_TRACE").is_some() && tick % 60 == 0 {
                eprintln!("report t{tick}: {} components {:?}, {} chunks", r.components.len(),
                    r.components.iter().take(4).map(|c| (c.component, c.chunk_count, c.reason, c.iterations, c.final2, c.tolerance2)).collect::<Vec<_>>(), r.chunks.len());
            }
        }
        let status = &raw["lastStatus"];
        let ok = status["converged"].as_bool() == Some(true);
        if ok { converged += 1; }
        let wheel = raw["wheelLoads"].as_array().unwrap().iter().map(|w| {
            let m = |k: &str| w[k].as_array().unwrap().iter().map(|x| x.as_f64().unwrap().powi(2)).sum::<f64>().sqrt() as f32;
            m("suspension") + m("tire")
        }).fold(0f32, f32::max);
        peak_wheel = peak_wheel.max(wheel);
        peak_decel = peak_decel.max(decel_g);
        let bonds = raw["bonds"].as_array().unwrap();
        let (mut tick_u, mut tick_bond) = (0f64, 0u64);
        for b in bonds {
            let index = b["index"].as_u64().unwrap();
            if b["broken"].as_bool().unwrap_or(false) {
                if broken.contains_key(&index) { continue; }
                broken.insert(index, tick + 1);
                if audits.len() < 24 {
                    let bond = &geometry.bonds[index as usize];
                    let [ca, cb] = layout.bond_chunks[index as usize];
                    let ids = [geometry.parts[ca as usize].id.as_str(), geometry.parts[cb as usize].id.as_str()];
                    assert!(ids.contains(&bond.a.as_str()) && ids.contains(&bond.b.as_str()), "bond index {index} is not geometry.bonds[{index}]");
                    let st = &bond.strength;
                    let (t, c, sh) = before.get(&index).copied().unwrap_or_default();
                    // What the car was touching on the tick before the break.
                    let hulls: Vec<Hull> = serde_json::from_value(if prev_hulls.is_null() { raw["hulls"].clone() } else { prev_hulls.clone() }).unwrap();
                    let mut touching: Vec<String> = hulls.iter().filter(|h| !h.terrain_excluded).filter_map(|h| {
                        let low = hull_points(geometry, h).map(|p| p.y - ground_y(s.ground, p.x, p.z, &course)).fold(f32::MAX, f32::min);
                        let front = hull_points(geometry, h).map(|p| p.z).fold(f32::MIN, f32::max);
                        let wall = first_obstacle_z.is_some_and(|z| front > z - 0.52);
                        (low < 0.02 || wall).then(|| format!("{}{}", geometry.parts[h.part as usize].id, if wall { "@wall" } else { "@ground" }))
                    }).collect();
                    touching.sort(); touching.dedup();
                    let wheel_x = wheel / static_corner;
                    let mut causes = Vec::new();
                    if !ok { causes.push("unconverged"); }
                    if decel_g > 2. || !touching.is_empty() { causes.push("impact"); }
                    if wheel_x > 3. { causes.push("wheel-load"); }
                    if causes.is_empty() { causes.push("unexplained"); }
                    // The breaking step's component: either end of the bond (a part
                    // that broke off alone has no stress component left).
                    let solve = solve_report.as_ref().and_then(|r| {
                        let component = r.chunks.iter().find(|c| (c.node == ca || c.node == cb) && c.component != u32::MAX)?.component;
                        let c = r.components.iter().find(|c| c.component == component)?;
                        Some(format!("{} after {} iterations, residual {:.1}x tolerance (best {:.1}x at {})", crate::structure_qualification::reason_name(crate::structure_qualification::effective_reason(c)),
                            c.iterations, (c.final2 / c.tolerance2).sqrt(), (c.best2 / c.tolerance2).sqrt(), c.best_iteration))
                    }).unwrap_or_else(|| "no solve report".into());
                    let loads = solve_report.as_ref().map(|r| [ca, cb].iter().filter_map(|&n| {
                        let f = source_forces(r, n, geometry.parts[n as usize].mass as f32)?;
                        Some(format!("{}: wheel/gravity/rotation {:.1} kN, constraint {:.1} kN, contact {:.1} kN", geometry.parts[n as usize].id, f[0] / 1e3, f[1] / 1e3, f[2] / 1e3))
                    }).collect::<Vec<_>>().join("; ")).unwrap_or_default();
                    audits.push(Audit { remaining: remaining.get(&index).map(|h| h.iter().copied().collect()).unwrap_or_default(),
                        damaged_since: damaged_since.get(&index).copied(), loads, solve, tick: tick + 1, bond: bond_label(geometry, layout, index as u32), area: bond.area,
                        before: [t / st.tension_fatal, c / st.compression_fatal, sh / st.shear_fatal],
                        utilisation: history.get(&index).map(|h| h.iter().copied().collect()).unwrap_or_default(),
                        converged: ok, iterations: status["iterations"].as_u64().unwrap_or(0), decel_g, wheel_load_x_static: wheel_x, touching, causes });
                }
            } else {
                let u = b["utilisation"].as_f64().unwrap_or(0.);
                if u > tick_u { tick_u = u; tick_bond = index; }
                before.insert(index, (b["tension"].as_f64().unwrap_or(0.), b["compression"].as_f64().unwrap_or(0.), b["shear"].as_f64().unwrap_or(0.)));
                let h = history.entry(index).or_default();
                h.push_back((u * 1000.).round() / 1000.);
                if h.len() > 5 { h.pop_front(); }
                let left = b["remainingArea"].as_f64().unwrap_or(0.) / geometry.bonds[index as usize].area.max(1e-12);
                if left < 0.9999 { damaged_since.entry(index).or_insert(tick + 1); }
                let r = remaining.entry(index).or_default();
                r.push_back((left * 1000.).round() / 1000.);
                if r.len() > 5 { r.pop_front(); }
            }
        }
        peak_u = peak_u.max(tick_u);
        prev_hulls = raw["hulls"].clone();
        samples.push(json!([tick + 1, (speed * 100.).round() / 100., ok, status["iterations"], (decel_g * 100.).round() / 100., (wheel / static_corner * 100.).round() / 100., (tick_u * 1000.).round() / 1000., tick_bond]));
    }
    let raw = scene.arena.vehicle_destruction_debug(CAR).unwrap();
    // The last step's per-bond stress, for comparing two configurations under
    // identical loads (scripts/perf/compare-bond-loads.py).
    let bond_loads: Vec<Value> = raw["bonds"].as_array().unwrap().iter().filter(|b| !b["broken"].as_bool().unwrap_or(false))
        .map(|b| json!([b["index"], b["utilisation"], b["tension"], b["compression"], b["shear"]])).collect();
    let hulls: Vec<Hull> = serde_json::from_value(raw["hulls"].clone()).unwrap();
    let mut off: Vec<u32> = hulls.iter().filter(|h| h.actor != 0).map(|h| h.part).collect();
    off.sort(); off.dedup();
    let wheels_lost = (0..4).filter(|w| raw["vehicle"]["wheelMask"].as_u64().unwrap_or(15) & (1 << w) == 0).count();
    let mut violations = Vec::new();
    for e in s.expect {
        match e {
            Expect::Intact if !broken.is_empty() => violations.push(format!("expected intact: {} bonds broke", broken.len())),
            Expect::KeepsWheels if wheels_lost > 0 => violations.push(format!("expected to keep its wheels: lost {wheels_lost}")),
            Expect::Breaks if broken.is_empty() => violations.push("expected to break: nothing broke".into()),
            _ => {}
        }
    }
    let steps = samples.len().max(1) as u32;
    let mut sorted_ms = step_ms.clone();
    sorted_ms.sort_by(f32::total_cmp);
    let step_summary = json!({"median": sorted_ms.get(sorted_ms.len() / 2), "p95": sorted_ms.get(sorted_ms.len() * 95 / 100), "max": sorted_ms.last()});
    json!({
        "scenario": s.name, "why": s.why, "expect": s.expect.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>(), "topSpeed": top, "impactSpeed": impact,
        "bondsBroken": broken.len(), "partsOff": off.len(), "wheelsLost": wheels_lost,
        "converged": converged as f32 / steps as f32, "peakDecelG": peak_decel, "peakWheelLoadXStatic": peak_wheel / static_corner,
        "peakUtilisation": peak_u, "violations": violations,
        "stepMs": step_summary,
        "peakConstraintN": peak_constraint.0, "peakConstraintAt": peak_constraint.1, "peakContactN": peak_contact.0, "peakContactAt": peak_contact.1,
        "bottomedTicks": bottomed, "suspensionTravel": travel,
        "audits": audits.iter().map(|a| json!({"tick": a.tick, "bond": a.bond, "area": a.area,
            "beforeFractionOfFatal": {"tension": a.before[0], "compression": a.before[1], "shear": a.before[2]}, "utilisationBefore": a.utilisation,
            "converged": a.converged, "iterations": a.iterations, "decelG": a.decel_g, "wheelLoadXStatic": a.wheel_load_x_static,
            "touching": a.touching, "causes": a.causes, "solve": a.solve, "loads": a.loads,
            "remainingBefore": a.remaining, "damagedSince": a.damaged_since})).collect::<Vec<_>>(),
        "solve": tally.to_json(|_, node| format!("{} ({})", geometry.parts[node as usize].id, geometry.parts[node as usize].name)),
        "bondLoadsColumns": ["index", "utilisation", "tension", "compression", "shear"], "bondLoads": bond_loads,
        "samplesColumns": ["tick", "speed", "converged", "iterations", "decelG", "wheelLoadXStatic", "peakUtilisation", "peakBond"],
        "samples": samples,
    })
}

#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn vehicle_lab() {
    let _guard = gpu_test_guard();
    std::env::set_var("VIBE_DESTRUCTION_MODELS", std::env::var("VIBE_LAB_CARS").unwrap_or(crate::city_fleet::DEFAULT_FLEET.join(",")));
    let wanted = std::env::var("VIBE_LAB_SCENARIOS").unwrap_or_default();
    let chosen: Vec<Scenario> = scenarios().into_iter()
        .filter(|s| wanted.is_empty() || wanted.split(',').any(|w| s.name.starts_with(w.trim()))).collect();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    for (car, geometry) in fixtures() {
        let layout = geometry.validate_vehicle2_fracture_layout().unwrap();
        for s in &chosen {
            let r = run(&geometry, &layout, s);
            for v in r["violations"].as_array().unwrap() { failures.push(format!("{car} {}: {}", s.name, v.as_str().unwrap())); }
            eprintln!("{car:<8} {:<11} {:>5.1} m/s  {:>4} bonds {:>3} parts {} wheels  conv {:>4.0}%  peak {:>4.1} g  wheel {:>4.1}x  {}",
                s.name, r["topSpeed"].as_f64().unwrap(), r["bondsBroken"], r["partsOff"], r["wheelsLost"], r["converged"].as_f64().unwrap() * 100.,
                r["peakDecelG"].as_f64().unwrap(), r["peakWheelLoadXStatic"].as_f64().unwrap(),
                if r["violations"].as_array().unwrap().is_empty() { "ok".to_string() } else { format!("FAIL {}", r["violations"][0].as_str().unwrap()) });
            eprintln!("{:>22} solve: {} | step {:.1} ms median, {:.1} p95, {:.1} max", "", r["solve"]["verdict"].as_str().unwrap_or("-"),
                r["stepMs"]["median"].as_f64().unwrap_or(0.), r["stepMs"]["p95"].as_f64().unwrap_or(0.), r["stepMs"]["max"].as_f64().unwrap_or(0.));
            eprintln!("{:>22} peak loads: constraint {:.0} kN ({}), contact {:.0} kN ({}); a wheel at the end of its {:.2} m travel on {} tick(s)", "",
                r["peakConstraintN"].as_f64().unwrap_or(0.) / 1e3, r["peakConstraintAt"].as_str().unwrap_or("-"), r["peakContactN"].as_f64().unwrap_or(0.) / 1e3,
                r["peakContactAt"].as_str().unwrap_or("-"), r["suspensionTravel"].as_f64().unwrap_or(0.), r["bottomedTicks"]);
            if let Some(h) = r["solve"]["hotChunks"].as_array().filter(|h| !h.is_empty()) {
                eprintln!("{:>22} residual held by: {}", "", h.iter().take(4).map(|c| format!("{} {:.0}%", c["chunk"].as_str().unwrap(), c["share"].as_f64().unwrap() * 100.)).collect::<Vec<_>>().join(", "));
            }
            if let Some(a) = r["audits"].as_array().unwrap().first() {
                let f = &a["beforeFractionOfFatal"];
                eprintln!("{:>22} first break t{} {} ({:.4} m²): tick before at {:.0}% tension, {:.0}% compression, {:.0}% shear of fatal (utilisation {}); {}; {:.1} g; wheels {:.1}x static; touching {:?}",
                    "", a["tick"], a["bond"].as_str().unwrap(), a["area"].as_f64().unwrap(), f["tension"].as_f64().unwrap() * 100., f["compression"].as_f64().unwrap() * 100., f["shear"].as_f64().unwrap() * 100.,
                    a["utilisationBefore"],
                    a["causes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect::<Vec<_>>().join("+"), a["decelG"].as_f64().unwrap(), a["wheelLoadXStatic"].as_f64().unwrap(),
                    a["touching"].as_array().unwrap().iter().take(4).map(|c| c.as_str().unwrap()).collect::<Vec<_>>());
                eprintln!("{:>22} breaking solve: {}", "", a["solve"].as_str().unwrap_or("-"));
                eprintln!("{:>22} loads on that step: {}", "", a["loads"].as_str().unwrap_or("-"));
                eprintln!("{:>22} remaining area before: {} (damaged since tick {})", "", a["remainingBefore"], a["damagedSince"]);
            }
            report.push(json!({"car": car, "mass": geometry.mass, "run": r}));
        }
    }
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/vehicle-lab");
    std::fs::create_dir_all(dir).unwrap();
    let name = std::env::var("VIBE_LAB_REPORT_NAME").unwrap_or("report".into());
    std::fs::write(format!("{dir}/{name}.json"), serde_json::to_vec(&report).unwrap()).unwrap();
    eprintln!("\n{} of {} runs held their expectations; report {dir}/report.json", report.len() - failures.len(), report.len());
    if std::env::var_os("VIBE_LAB_REPORT_ONLY").is_none() { assert!(failures.is_empty(), "vehicle lab expectations failed:\n{}", failures.join("\n")); }
}
