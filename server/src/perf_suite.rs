//! The performance suite's harness (scripts/perf/suite.sh): one scene per
//! process, stepped exactly as the server steps it, through a fixed plan of
//! phases with fixed inputs at fixed ticks, one line per tick.
//!
//! This only measures. scripts/perf/suite.py writes the plans, runs this under
//! the exclusive GPU lock, and turns the lines into the report.
//!
//!   VIBE_SUITE_PLAN=plan.json PHYSX_ROOT=... CARGO_TARGET_DIR=... \
//!     scripts/perf/gpu-run.sh perf-suite <test binary> perf_suite --ignored --nocapture --test-threads=1
//!
//! The plan (JSON):
//!   {"cars": true,                     the fleet (VIBE_CITY_DESTRUCTIBLE_VEHICLES at
//!                                      VIBE_CITY_FLEET_SLOTS) spawned before the city opens
//!    "charges": "charges.json",        calibration charges (calibration_charges.rs), optional
//!    "phases": [{"name": "idle", "ticks": 240, "record": true,
//!                "drive": {"cars": [0, 3], "throttle": 1.0, "steer": 0.4, "period": 180},
//!                "events": [{"tick": 30, "kind": "cannonball"|"meteor"|"ball",
//!                            "target": [x, y, z], "from": deg, "slope": s, "distance": m,
//!                            "mass": kg (ball)}]}]}
//! A driven car gets a player at phase start (dropped beside it, then in);
//! `drive` holds the throttle and turns the wheel `steer` one way then the
//! other every `period` ticks -- the same inputs every run. An event fires as
//! the vehicle test bed fires an attack `shot` (vehicle_testbed.rs): from
//! compass bearing `from`, `distance` m out and `slope` up per metre, aimed so
//! it arrives at `target` under gravity.
//!
//! Each recorded tick prints `SUITE_TICK {...}` on stderr: the server tick's
//! wall time (player sim, vehicles and dynamics, city step), its parts, the
//! PhysX fetch (where the host waits for the GPU; the exact GPU wait on the
//! bridge's sampled steps), and the stage's counts (stress iterations, whether
//! it converged, stress and correction passes, bonds broken, error bits).
//! Anything the engine prints during the tick (the impact solve's
//! `[impact] pass` lines under PX_DESTRUCTION_IMPACT_LOG=1) comes before the
//! tick's own line on the same stream, so the reader can attach it.
#![cfg(all(test, feature = "native-destruction"))]

use nalgebra::Vector3;
use serde_json::Value;
use std::time::Instant;

const DT: f32 = 1.0 / 60.0;
const FIRST_DRIVER: u32 = 900;

/// The native app's stage settings (sim-native city.rs apply_app_defaults),
/// for anything the plan's environment does not set.
fn app_settings() {
    for (name, value) in [
        ("VIBE_GARAGE_VEHICLE_DESTRUCTION", "1"),
        ("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1"),
        ("VIBE_NATIVE_STRESS_FORCE_TOLERANCE", "0.001"),
        ("BLAST_STRESS_INCREMENTAL_MOTION", "1"),
        ("PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "1"),
        ("BLAST_STRESS_BALANCED_OPERATOR", "1"),
        ("VIBE_CITY_GRID", "1"),
        ("VIBE_CITY_VARIED_HEIGHTS", "0"),
    ] {
        if std::env::var_os(name).is_none() {
            std::env::set_var(name, value);
        }
    }
}

fn f32s(v: &Value) -> Vec<f32> {
    v.as_array().map_or(Vec::new(), |a| a.iter().map(|x| x.as_f64().unwrap_or(0.) as f32).collect())
}

struct Rig {
    arena: crate::movement::PhysicsArena,
    city: crate::city::CityRuntime,
    cars: Vec<u32>,
    tick: u32,
    charges: Option<crate::calibration_charges::Charges>,
    offset: [f32; 3],
}

impl Rig {
    fn open(plan: &Value) -> Self {
        let mut arena = crate::movement::PhysicsArena::new(
            vibe_netcode::movement::MoveConfig::default(),
            vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu,
        )
        .expect("production arena");
        crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
        let mut cars = Vec::new();
        if plan["cars"].as_bool() == Some(true) {
            let builds = crate::city_fleet::requested().expect("cars: VIBE_CITY_DESTRUCTIBLE_VEHICLES names the fleet");
            let fleet = tokio::runtime::Runtime::new().unwrap().block_on(crate::city_fleet::prepare(&builds));
            assert_eq!(fleet.cars.len(), builds.len(), "every fleet car prepared");
            crate::city_fleet::spawn(&mut arena, &fleet);
            cars = fleet.cars.iter().map(|(id, _, _)| *id).collect();
        }
        arena.reserve_ball_pool(8);
        arena.reserve_meteor_pool(4);
        let city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
        assert_eq!(city.backend_name(), "native", "the native destruction stage");
        arena.mark_vehicle_destruction_configured();
        arena.set_tolerate_rejected_steps(true);
        let mut rig = Self { arena, city, cars, tick: 0, charges: None, offset: [0.; 3] };
        if let Some(path) = plan["charges"].as_str() {
            std::env::set_var("VIBE_CALIB_CHARGES", path);
            rig.offset = rig.scene_offset();
            rig.charges = crate::calibration_charges::Charges::from_env();
            let offset = rig.offset;
            // Place the supports; nothing fires before the first tick.
            if let Some(c) = rig.charges.as_mut() {
                c.apply(u32::MAX, offset, rig.arena.physx_world_mut().unwrap());
            }
        }
        rig
    }

    /// Scene to world for a calibration scene: where the stage put its first
    /// anchor (calibration.rs does the same).
    fn scene_offset(&mut self) -> [f32; 3] {
        let path = std::env::var("VIBE_CITY_SCENE").expect("VIBE_CITY_SCENE");
        let pack: Value = serde_json::from_slice(&std::fs::read(&path).expect("scene pack")).expect("scene json");
        let nodes = pack["scenario"]["nodes"].as_array().expect("nodes");
        let anchor = nodes.iter().position(|v| v["mass"].as_f64() == Some(0.0)).expect("an anchor chunk");
        let c = &nodes[anchor]["centroid"];
        let aim = self.arena.physx_world_mut().unwrap().native_chunk_aim(0, anchor as u32).expect("anchor chunk");
        [
            aim.center.x - c["x"].as_f64().unwrap() as f32,
            aim.center.y - c["y"].as_f64().unwrap() as f32,
            aim.center.z - c["z"].as_f64().unwrap() as f32,
        ]
    }

    fn car_pose(&mut self, id: u32) -> Option<(Vector3<f32>, Vector3<f32>)> {
        let world = self.arena.physx_world_mut()?;
        let c = world.vehicle_snapshots().ok()?.into_iter().find(|c| c.user_id == id)?;
        let q = nalgebra::UnitQuaternion::new_normalize(nalgebra::Quaternion::new(
            c.pose.rotation.w, c.pose.rotation.x, c.pose.rotation.y, c.pose.rotation.z));
        Some((Vector3::new(c.pose.position.x, c.pose.position.y, c.pose.position.z), q * Vector3::z()))
    }

    /// One server tick (MatchState::tick's physics and destruction, in its
    /// order), timed as a whole.
    fn tick(&mut self, inputs: &[(u32, vibe_land_shared::protocol::InputCmd)]) -> Value {
        let started = Instant::now();
        for (player, input) in inputs {
            let _ = self.arena.simulate_player_tick(*player, input, DT);
        }
        let player_ms = started.elapsed().as_secs_f32() * 1000.0;
        if let Some(c) = self.charges.as_mut() {
            let offset = self.offset;
            // Calibration ticks count from 1 (calibration.rs).
            c.apply(self.tick + 1, offset, self.arena.physx_world_mut().unwrap());
        }
        self.city.pre_step(self.arena.physx_world_mut());
        let (_, dyn_ms) = self.arena.step_vehicles_and_dynamics(DT);
        let city_started = Instant::now();
        let _ = self.city.step(self.tick, DT, vibe_netcode::movement::default_world_gravity(), self.arena.physx_world_mut());
        let city_ms = city_started.elapsed().as_secs_f32() * 1000.0;
        let total_ms = started.elapsed().as_secs_f32() * 1000.0;
        let (status, counts) = self.city.native_tick_view().map(|(s, c, _)| (s, c)).unwrap_or_default();
        let stats = self.city.stats();
        // This step's own phases (no ring means): the fetch is where the host
        // waits for the GPU (the destruction stage runs inside it); the exact
        // GPU wait is measured on sampled steps only (1 in 16).
        let w = self.arena.physx_world_mut().and_then(|w| w.step_phases().ok()).unwrap_or_default();
        self.tick += 1;
        serde_json::json!({
            "total": total_ms, "player": player_ms, "dyn": dyn_ms, "city": city_ms,
            "fetch": w.fetch_ms, "simulate": w.simulate_ms, "callbacks": w.callbacks_ms,
            "gpu_wait": if w.gpu_wait_sampled { Some(w.gpu_wait_ms) } else { None },
            "it": status.iterations, "conv": status.converged, "passes": status.stress_passes,
            "corr": status.correction_passes, "broken": status.broken_bonds,
            "post_broken": status.post_correction_broken_bonds, "crushed": status.crushed_chunks,
            "committed": counts.bonds_broken, "err": status.error, "islands": status.stress_island_count,
            "contacts": status.normal_contacts, "awake": w.active_dynamic_bodies,
            "awake_chunks": stats.awake_chunk_bodies, "broken_total": stats.broken_bonds,
        })
    }

    /// A shot as the vehicle test bed fires an attack `shot`.
    fn fire(&mut self, e: &Value) {
        let f = |k: &str| e[k].as_f64().unwrap_or(0.) as f32;
        let t = f32s(&e["target"]);
        let target = Vector3::new(t[0], t[1], t[2]) + Vector3::from(self.offset);
        let bearing = f("from").to_radians();
        let origin = target + Vector3::new(bearing.sin(), f("slope"), bearing.cos()) * f("distance");
        let kind = e["kind"].as_str().unwrap_or("cannonball");
        let speed = match kind { "meteor" => 140., _ => crate::city::city_ball_speed_ms() };
        let tt = (origin - target).norm() / speed;
        let velocity = (target - origin) / tt + Vector3::new(0., 0.5 * (vibe_netcode::movement::GRAVITY as f32) * tt, 0.);
        let launched = match kind {
            "meteor" => {
                let tuning = crate::meteor::MeteorTuning::from_env();
                self.arena.launch_meteor(origin, velocity, tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks)
            }
            "ball" => {
                let mass = f("mass");
                let radius = (mass / crate::city::city_ball_density_kg_m3() * 3. / (4. * std::f32::consts::PI)).cbrt();
                self.arena.launch_ball_from_muzzle(origin, velocity, radius, mass, 600)
            }
            "cannonball" => self.arena.launch_ball_from_muzzle(origin, velocity, crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), 600),
            other => panic!("unknown event kind {other}"),
        };
        assert!(launched.is_some(), "{kind} launched");
    }

    /// Put a driver in each of `cars` (indices into the fleet), as the test
    /// bed does: dropped beside the car, ten ticks, then in. The ten ticks are
    /// not recorded.
    fn seat(&mut self, cars: &[usize]) -> Vec<u32> {
        let mut players = Vec::new();
        for &i in cars {
            let id = self.cars[i];
            let player = FIRST_DRIVER + i as u32;
            if self.arena.player_vehicle_id(player) == Some(id) { players.push(player); continue; }
            self.arena.spawn_player(player);
            let (p, _) = self.car_pose(id).expect("car pose");
            let cmd = vibe_land_shared::protocol::CityCameraDropCmd { position: [p.x - 2.5, p.y + 0.5, p.z - 2.5], yaw: 0., pitch: 0. };
            let _ = self.arena.drop_player_from_camera(player, &cmd);
            players.push(player);
        }
        for _ in 0..10 { self.tick(&[]); }
        for (&i, &player) in cars.iter().zip(&players) {
            self.arena.enter_vehicle(player, self.cars[i]);
            assert_eq!(self.arena.player_vehicle_id(player), Some(self.cars[i]), "driver {player} in car {}", self.cars[i]);
        }
        players
    }
}

#[test]
#[ignore = "benchmark: needs the GPU (scripts/perf/suite.sh)"]
fn perf_suite() {
    app_settings();
    let plan_path = std::env::var("VIBE_SUITE_PLAN").expect("VIBE_SUITE_PLAN: the plan");
    let plan: Value = serde_json::from_slice(&std::fs::read(&plan_path).expect("plan file")).expect("plan json");
    let started = Instant::now();
    let mut rig = Rig::open(&plan);
    eprintln!("SUITE_SETUP {}", serde_json::json!({"ms": started.elapsed().as_secs_f64() * 1000.0, "cars": rig.cars.len()}));
    for phase in plan["phases"].as_array().expect("phases") {
        let name = phase["name"].as_str().expect("phase name");
        let ticks = phase["ticks"].as_u64().expect("phase ticks") as u32;
        let record = phase["record"].as_bool().unwrap_or(true);
        let drive = &phase["drive"];
        let drivers: Vec<usize> = drive["cars"].as_array().map_or(Vec::new(), |a| a.iter().map(|v| v.as_u64().unwrap() as usize).collect());
        let players = if drivers.is_empty() { Vec::new() } else { rig.seat(&drivers) };
        let events: Vec<&Value> = phase["events"].as_array().map_or(Vec::new(), |a| a.iter().collect());
        let phase_started = Instant::now();
        eprintln!("SUITE_PHASE {}", serde_json::json!({"name": name, "ticks": ticks, "record": record, "tick": rig.tick}));
        for k in 0..ticks {
            for e in events.iter().filter(|e| e["tick"].as_u64() == Some(k as u64)) {
                rig.fire(e);
            }
            let throttle = (drive["throttle"].as_f64().unwrap_or(1.0) * 127.0).round() as i8;
            let period = drive["period"].as_u64().unwrap_or(180).max(1) as u32;
            let steer = drive["steer"].as_f64().unwrap_or(0.0) as f32 * if (k / period) % 2 == 0 { 1.0 } else { -1.0 };
            let inputs: Vec<_> = players.iter().enumerate().map(|(j, &p)| {
                // Alternate cars steer opposite ways, so the fleet spreads out.
                let s = if j % 2 == 0 { steer } else { -steer };
                (p, vibe_land_shared::protocol::InputCmd {
                    seq: rig.tick as u16, buttons: 0, move_x: (s * 127.0).round() as i8, move_y: throttle, yaw: 0.0, pitch: 0.0,
                })
            }).collect();
            let line = rig.tick(&inputs);
            if record {
                eprintln!("SUITE_TICK {}", serde_json::json!({"phase": name, "k": k, "t": line}));
            }
        }
        eprintln!("SUITE_PHASE_END {}", serde_json::json!({"name": name, "ms": phase_started.elapsed().as_secs_f64() * 1000.0}));
        // Drivers step out between phases: the next phase starts parked.
        for p in players { rig.arena.exit_vehicle(p); }
    }
    eprintln!("SUITE_DONE {}", serde_json::json!({"ms": started.elapsed().as_secs_f64() * 1000.0}));
}
