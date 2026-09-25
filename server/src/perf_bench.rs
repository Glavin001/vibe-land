//! Repeatable server-tick timing for the scenes players actually produce.
//!
//! Each scenario builds the production arena, the city world document, a
//! player and the native destruction stage, then steps it exactly the way
//! `MatchState::tick` does -- `city.pre_step`, `step_vehicles_and_dynamics`,
//! `city.step` -- with fixed inputs at fixed ticks. No browser, no network, no
//! walking to a target, so two runs ask the same question and a timing delta
//! means something. Cost is attributed per tick to the physics step and the
//! city step, and the worst ticks carry the stage's own phase timings.
//!
//! One JSON line per scenario on stderr (`PERF {...}`), plus the worst ticks
//! (`SPIKE {...}`), for scripts to collect and compare:
//!
//!   cargo test -p web-fps-server --release --no-default-features \
//!     --features native-destruction perf_bench -- --ignored --nocapture --test-threads=1
//!
//! `VIBE_PERF_SCENARIOS=a,b` runs a subset. `VIBE_PERF_PACE=1` holds ticks to
//! the server's 60 Hz period (`spin` busy-waits it out). `VIBE_PHYSX_PROFILE=1`
//! adds the engine's own zones to each SPIKE line. For per-kernel GPU time run
//! the whole process with `CUMETAL_TRACE_GPU=1 CUMETAL_PROVENANCE=1
//! VIBE_PERF_MARKERS=1` (CuMetal reads the setting once; tracing un-batches
//! launches, so a traced run is for attribution, not timing).
#![cfg(all(test, feature = "native-destruction"))]

use std::time::Instant;

use glam::Vec3;
use vibe_land_physx_bridge::{DynamicBoxDesc, LaunchedBallDesc, Pose, Quat, Vec3 as BridgeVec3};

const DT: f32 = 1.0 / 60.0;
const BUDGET_MS: f32 = 1000.0 / 60.0;

struct Scene {
    arena: crate::movement::PhysicsArena,
    city: crate::city::CityRuntime,
    tick: u32,
    /// Step markers for CuMetal's commit timeline (`VIBE_PERF_MARKERS=1`).
    markers: bool,
    /// Player 1 walks forward, turning slowly, as a client holding W would.
    walking: bool,
}

/// The clock C++'s steady_clock reads on macOS, so CUMETAL_TRACE_COMMITS lines
/// and these markers share a timebase.
fn monotonic_ns() -> u64 {
    extern "C" {
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }
    const CLOCK_UPTIME_RAW: u32 = 8;
    unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
}

impl Scene {
    fn city() -> Self {
        let mut arena = crate::movement::PhysicsArena::new(
            vibe_netcode::movement::MoveConfig::default(),
            vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu,
        )
        .expect("production physics arena");
        crate::demo_world::seed_world_for_match(&mut arena, crate::city::CITY_MATCH_PREFIX)
            .expect("seed the production city world document");
        arena.spawn_player(1);
        let mut city = {
            let world = arena.physx_world_mut().expect("physx world");
            crate::city::CityRuntime::native(60, world).expect("native city")
        };
        city.add_client(1);
        arena.set_tolerate_rejected_steps(true);
        Self { arena, city, tick: 0, markers: false, walking: false }
    }

    /// One server tick's physics and destruction, in the server's order.
    fn tick(&mut self) -> Tick {
        if self.markers {
            eprintln!("event=begin stage=physics_step frame={} monotonic_ns={}", self.tick, monotonic_ns());
        }
        let started = Instant::now();
        if self.walking {
            let input = vibe_land_shared::protocol::InputCmd {
                seq: self.tick as u16, buttons: 0, move_x: 0, move_y: 127,
                yaw: self.tick as f32 * 0.004, pitch: 0.0,
            };
            let _ = self.arena.simulate_player_tick(1, &input, DT);
        }
        self.city.pre_step(self.arena.physx_world_mut());
        let (_, dyn_ms) = self.arena.step_vehicles_and_dynamics(DT);
        let city_started = Instant::now();
        self.city.drain_demolition(1, self.arena.physx_world_mut());
        let _ = self.city.step(
            self.tick,
            DT,
            vibe_netcode::movement::default_world_gravity(),
            self.arena.physx_world_mut(),
        );
        let city_ms = city_started.elapsed().as_secs_f32() * 1000.0;
        let total_ms = started.elapsed().as_secs_f32() * 1000.0;
        let stats = self.city.stats();
        let engine_zones = zones(self.city.extra_spans());
        let world = self.arena.physx_world_mut().expect("physx world");
        let w = world.stats().expect("world stats");
        let n = world.native_stats().unwrap_or_default();
        let ns = world.native_last_status().unwrap_or_default();
        let t = Tick {
            tick: self.tick,
            total_ms,
            dyn_ms,
            city_ms,
            gpu_wait_ms: w.last_gpu_wait_ms,
            awake_rigid: w.active_dynamic_bodies,
            awake_chunks: stats.awake_chunk_bodies,
            broken_bonds: stats.broken_bonds,
            native: format!(
                "it {} conv {} contacts {} anchors {} clusters {} islands {} passes {} err {}",
                ns.iterations, ns.converged as u8, ns.normal_contacts, ns.friction_anchors,
                ns.cluster_count, ns.stress_island_count, ns.stress_passes, ns.error
            ),
            stage: format!(
                "bridge step {:.1} simulate {:.1} sim_wall {:.1} fetch_call {:.1} controller {:.1} | native readback {:.1} events {:.1}",
                w.last_step_ms, w.last_simulate_ms, w.last_gpu_wait_ms, w.last_fetch_copy_ms,
                w.last_controller_ms, n.readback_ms, n.events_ms
            ) + &engine_zones,
        };
        if self.markers {
            eprintln!("event=end stage=physics_step frame={} monotonic_ns={}", self.tick, monotonic_ns());
        }
        self.tick += 1;
        t
    }

    /// `VIBE_PERF_PACE=1` holds each tick to the server's 60 Hz period instead
    /// of stepping back to back: an idle GPU between ticks clocks down, and
    /// what a tick costs from cold clocks is what the live server pays.
    fn run(&mut self, ticks: u32) -> Vec<Tick> {
        let pace_mode = std::env::var("VIBE_PERF_PACE").unwrap_or_default();
        let pace = !pace_mode.is_empty() && pace_mode != "0";
        // `spin`: wait out the period busy on the CPU, so only the GPU idles.
        let spin = pace_mode == "spin";
        let period = std::time::Duration::from_secs_f32(DT);
        let mut next = Instant::now();
        (0..ticks)
            .map(|_| {
                let t = self.tick();
                if pace {
                    next += period;
                    let now = Instant::now();
                    if next > now && spin {
                        while Instant::now() < next {
                            std::hint::spin_loop();
                        }
                    } else if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        next = now;
                    }
                }
                t
            })
            .collect()
    }

    /// A measured window: step markers switch on here only
    /// (`VIBE_PERF_MARKERS`), so they bound the ticks a CuMetal trace is
    /// attributed to.
    fn measure(&mut self, ticks: u32) -> Vec<Tick> {
        self.markers = std::env::var("VIBE_PERF_MARKERS").is_ok();
        let ticks = self.run(ticks);
        self.markers = false;
        ticks
    }

    fn world(&mut self) -> &mut vibe_land_physx_bridge::World {
        self.arena.physx_world_mut().expect("physx world")
    }

    /// A cannonball, as the server fires one: a dynamic sphere into the scene.
    fn cannonball(&mut self, from: Vec3, at: Vec3) {
        let dir = (at - from).normalize();
        self.arena
            .launch_ball(
                nalgebra::Vector3::new(from.x, from.y, from.z),
                nalgebra::Vector3::new(dir.x, dir.y, dir.z),
                crate::city::city_ball_radius_m(),
                crate::city::city_ball_mass_kg(),
                crate::city::city_ball_speed_ms(),
                crate::city::city_ball_ttl_ticks(),
            )
            .expect("cannonball launched");
    }

    /// A meteor, as the server fires one: the production tuning's rock
    /// (`MeteorTuning::from_env`, so `VIBE_CITY_METEOR_*` retunes it) from a
    /// planned start with a solved velocity. Returns its id.
    fn meteor(&mut self, start: Vec3, velocity: Vec3) -> u32 {
        let tuning = crate::meteor::MeteorTuning::from_env();
        self.arena
            .launch_meteor(
                nalgebra::Vector3::new(start.x, start.y, start.z),
                nalgebra::Vector3::new(velocity.x, velocity.y, velocity.z),
                tuning.radius_m,
                tuning.mass_kg,
                tuning.ttl_ticks,
            )
            .expect("meteor launched")
    }
}

/// The engine's own zones for this tick (`VIBE_PHYSX_PROFILE=1`), largest
/// first. Summed across calls and threads, and CUDA-event phases mixed in, so
/// they overlap and do not add up to the step.
fn zones(spans: Vec<vibe_land_destruction::types::NamedSpan>) -> String {
    let calls = |name: &str| {
        let key = format!("{name}.calls");
        spans.iter().find(|s| s.kind == 2 && s.name == key).map_or(0.0, |s| s.value)
    };
    let all = std::env::var("VIBE_PERF_ALL_TICKS").is_ok();
    let (floor, limit) = if all { (0.02, 200) } else { (0.3, 16) };
    let mut timed: Vec<_> = spans.iter().filter(|s| (s.kind == 1 || all && s.kind != 2) && s.value >= floor).collect();
    timed.sort_by(|a, b| b.value.total_cmp(&a.value));
    timed.iter().take(limit).map(|s| format!(" | {} {:.1} ({}x)", s.name, s.value, calls(&s.name))).collect()
}

struct Tick {
    tick: u32,
    total_ms: f32,
    dyn_ms: f32,
    city_ms: f32,
    gpu_wait_ms: f32,
    awake_rigid: u32,
    awake_chunks: u32,
    broken_bonds: u32,
    native: String,
    stage: String,
}

fn pct(v: &[f32], p: f32) -> f32 {
    let mut v = v.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((p / 100.0) * (v.len() - 1) as f32).round() as usize]
}

fn report(name: &str, ticks: &[Tick]) {
    // Every tick, for plotting and time-series questions.
    if let Ok(dir) = std::env::var("VIBE_PERF_TRACE_DIR") {
        let mut csv = String::from("tick,total_ms,dyn_ms,city_ms,sim_wall_ms,awake_rigid,awake_chunks,broken_bonds\n");
        for t in ticks {
            csv.push_str(&format!(
                "{},{:.3},{:.3},{:.3},{:.3},{},{},{}\n",
                t.tick, t.total_ms, t.dyn_ms, t.city_ms, t.gpu_wait_ms, t.awake_rigid, t.awake_chunks, t.broken_bonds
            ));
        }
        std::fs::write(format!("{dir}/{name}.csv"), csv).expect("write trace");
    }
    let total: Vec<f32> = ticks.iter().map(|t| t.total_ms).collect();
    let dynamics: Vec<f32> = ticks.iter().map(|t| t.dyn_ms).collect();
    let city: Vec<f32> = ticks.iter().map(|t| t.city_ms).collect();
    let over = total.iter().filter(|&&ms| ms > BUDGET_MS).count();
    let awake = ticks.iter().map(|t| t.awake_rigid).max().unwrap_or(0);
    let bonds = ticks.last().map(|t| t.broken_bonds).unwrap_or(0) - ticks.first().map(|t| t.broken_bonds).unwrap_or(0);
    eprintln!(
        "PERF {{\"scenario\":\"{name}\",\"ticks\":{},\"p50\":{:.2},\"p90\":{:.2},\"p99\":{:.2},\"max\":{:.2},\
\"over_budget\":{over},\"dyn_p50\":{:.2},\"dyn_max\":{:.2},\"city_p50\":{:.2},\"city_max\":{:.2},\
\"awake_rigid_max\":{awake},\"bonds_broken\":{bonds}}}",
        ticks.len(),
        pct(&total, 50.0),
        pct(&total, 90.0),
        pct(&total, 99.0),
        pct(&total, 100.0),
        pct(&dynamics, 50.0),
        pct(&dynamics, 100.0),
        pct(&city, 50.0),
        pct(&city, 100.0),
    );
    // Every tick with its stage line (`VIBE_PERF_ALL_TICKS=1`), for step-cost profiling.
    if std::env::var("VIBE_PERF_ALL_TICKS").is_ok() {
        for t in ticks {
            eprintln!(
                "TICK {{\"scenario\":\"{name}\",\"tick\":{},\"total\":{:.2},\"dyn\":{:.2},\"gpu_wait\":{:.2},\"city\":{:.2},\
\"awake_rigid\":{},\"awake_chunks\":{},\"broken_bonds\":{},\"native\":\"{}\",\"stage\":\"{}\"}}",
                t.tick, t.total_ms, t.dyn_ms, t.gpu_wait_ms, t.city_ms, t.awake_rigid, t.awake_chunks, t.broken_bonds, t.native, t.stage
            );
        }
    }
    let mut worst: Vec<&Tick> = ticks.iter().filter(|t| t.total_ms > BUDGET_MS).collect();
    worst.sort_by(|a, b| b.total_ms.partial_cmp(&a.total_ms).unwrap());
    for t in worst.iter().take(8) {
        eprintln!(
            "SPIKE {{\"scenario\":\"{name}\",\"tick\":{},\"total\":{:.1},\"dyn\":{:.1},\"gpu_wait\":{:.1},\"city\":{:.1},\
\"awake_rigid\":{},\"awake_chunks\":{},\"broken_bonds\":{},\"stage\":\"{}\"}}",
            t.tick, t.total_ms, t.dyn_ms, t.gpu_wait_ms, t.city_ms, t.awake_rigid, t.awake_chunks, t.broken_bonds, t.stage
        );
    }
}

fn settle_ticks() -> u32 {
    std::env::var("VIBE_PERF_SETTLE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(400)
}

fn wanted(name: &str) -> bool {
    match std::env::var("VIBE_PERF_SCENARIOS") {
        Ok(list) if !list.is_empty() => list.split(',').any(|s| name.starts_with(s.trim())),
        _ => true,
    }
}

/// A building face near the city's south edge, and a firing point 30 m out.
fn target() -> (Vec3, Vec3) {
    (Vec3::new(-36.0, 1.6, -62.0), Vec3::new(-36.0, 6.0, -36.0))
}

/// The same shot plan every run: six cannonballs, 45 ticks apart, then the
/// collapse and settle.
fn fracture(scene: &mut Scene) -> Vec<Tick> {
    let (from, at) = target();
    scene.markers = std::env::var("VIBE_PERF_MARKERS").is_ok();
    let mut ticks = Vec::new();
    for shot in 0..6 {
        let aim = at + Vec3::new(-3.0 + shot as f32 * 1.2, (shot % 3) as f32 * 2.5, 0.0);
        scene.cannonball(from, aim);
        ticks.extend(scene.run(45));
    }
    ticks.extend(scene.run(settle_ticks()));
    scene.markers = false;
    ticks
}

#[test]
#[ignore = "benchmark: needs a GPU"]
fn perf_bench() {
    // Cold fracture first, in a fresh process: first-use costs are part of
    // what a player sees on a fresh server.
    if wanted("fracture_cold") {
        let mut scene = Scene::city();
        scene.run(120);
        report("fracture_cold", &fracture(&mut scene));
    }

    if wanted("city_idle") {
        let mut scene = Scene::city();
        scene.run(300);
        report("city_idle", &scene.measure(600));
    }

    // Idle includes walking: one player on foot, nothing else moving.
    if wanted("city_walking") {
        let mut scene = Scene::city();
        scene.run(300);
        scene.walking = true;
        scene.run(60);
        report("city_walking", &scene.measure(600));
    }

    if wanted("city_boxes_100") {
        let mut scene = Scene::city();
        let world = scene.world();
        for i in 0..100u32 {
            let (x, z) = (-20.0 + (i % 10) as f32 * 1.6, -80.0 - (i / 10) as f32 * 1.6);
            world
                .add_dynamic_box(DynamicBoxDesc {
                    entity_id: 0x3000_0000 | i, user_id: i,
                    pose: Pose { position: BridgeVec3::new(x, 0.5, z), rotation: Quat::IDENTITY },
                    half_extents: BridgeVec3::new(0.5, 0.5, 0.5), mass: 20.0,
                    collision_group: u32::MAX, collision_mask: u32::MAX,
                })
                .unwrap();
        }
        report("city_boxes_100_settling", &scene.run(60));
        scene.run(300);
        report("city_boxes_100_asleep", &scene.measure(300));
    }

    if wanted("city_balls_100") {
        let mut scene = Scene::city();
        scene.run(120);
        let world = scene.world();
        for i in 0..100u32 {
            let (x, z) = (-20.0 + (i % 10) as f32 * 3.0, -80.0 - (i / 10) as f32 * 3.0);
            let a = i as f32 * 2.399;
            world
                .launch_dynamic_ball(LaunchedBallDesc {
                    entity_id: 0x3100_0000 | i, user_id: i,
                    pose: Pose { position: BridgeVec3::new(x, 0.4, z), rotation: Quat::IDENTITY },
                    radius: 0.4, mass: 10.0,
                    linear_velocity: BridgeVec3::new(a.cos() * 2.0, 0.0, a.sin() * 2.0),
                    collision_group: u32::MAX, collision_mask: u32::MAX,
                })
                .unwrap();
        }
        scene.run(10);
        report("city_balls_100_rolling", &scene.measure(120));
    }

    if wanted("fracture_warm") {
        let mut scene = Scene::city();
        scene.run(120);
        report("fracture_warm", &fracture(&mut scene));
    }

    // After a fracture the debris settles; what is left awake is what an idle
    // match costs for the rest of its life.
    if wanted("debris_idle") {
        let mut scene = Scene::city();
        scene.run(120);
        let (from, at) = target();
        for shot in 0..6 {
            scene.cannonball(from, at + Vec3::new(-3.0 + shot as f32 * 1.2, (shot % 3) as f32 * 2.5, 0.0));
            scene.run(45);
        }
        scene.run(1200);
        report("debris_idle", &scene.measure(std::env::var("VIBE_PERF_IDLE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(300)));
        // What is still awake, and why it does not sleep.
        for b in scene.world().native_chunk_body_snapshots().expect("chunk snapshots").iter().filter(|b| !b.sleeping && !b.kinematic) {
            let (v, w) = (&b.linear_velocity, &b.angular_velocity);
            eprintln!(
                "AWAKE entity {} structure {} island {} nodes {} y {:.2} speed {:.4} m/s spin {:.4} rad/s flags {:#x}",
                b.entity_id, b.structure_id, b.island_id, b.node_count, b.position.y,
                (v.x * v.x + v.y * v.y + v.z * v.z).sqrt(), (w.x * w.x + w.y * w.y + w.z * w.z).sqrt(), b.flags
            );
        }
    }

    // The rubble of that fracture held awake -- bodies lying around that
    // players keep disturbing -- whatever the random fracture left sleeping.
    if wanted("debris_awake") {
        let mut scene = Scene::city();
        scene.run(120);
        let (from, at) = target();
        for shot in 0..6 {
            scene.cannonball(from, at + Vec3::new(-3.0 + shot as f32 * 1.2, (shot % 3) as f32 * 2.5, 0.0));
            scene.run(45);
        }
        scene.run(1200);
        // A ball rolled into the rubble every 10 ticks, from a fixed arc of
        // points, keeps it moving the way players and stray shots do.
        scene.markers = std::env::var("VIBE_PERF_MARKERS").is_ok();
        let ticks: u32 = std::env::var("VIBE_PERF_IDLE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        let mut measured = Vec::new();
        for t in 0..ticks {
            if t % 10 == 0 {
                let k = (t / 10) as f32;
                let (x, z) = (at.x - 8.0 + (k * 1.7) % 16.0, at.z - 14.0);
                scene
                    .world()
                    .launch_dynamic_ball(LaunchedBallDesc {
                        entity_id: 0x3200_0000 | t, user_id: t,
                        pose: Pose { position: BridgeVec3::new(x, 0.6, z), rotation: Quat::IDENTITY },
                        radius: 0.5, mass: 40.0, linear_velocity: BridgeVec3::new(0.0, 0.0, 6.0),
                        collision_group: u32::MAX, collision_mask: u32::MAX,
                    })
                    .expect("ball");
            }
            measured.extend(scene.run(1));
        }
        scene.markers = false;
        report("debris_awake", &measured);
    }

    // The whole city demolished building by building, as the systematic city
    // bench does, then measured at rest and with rubble kept awake: the
    // destruction-active steady state whose fixed per-step cost is the target.
    if wanted("city_rubble") {
        let mut scene = Scene::city();
        scene.run(120);
        let (_, manifest, _) = crate::city::manifest_asset().expect("city manifest");
        let buildings = vibe_land_destruction::buildings::enumerate_min(manifest, 20);
        scene.city.set_demolition_shape(0.0, 50.0, 0.3);
        for b in &buildings {
            let world = scene.arena.physx_world_mut();
            scene.city.demolish_supports([b.centre[0], b.centre[2]], b.radius + 1.0, b.bottom + 4.0, 48, world);
            scene.run(90);
        }
        scene.run(settle_ticks().max(900));
        let ticks: u32 = std::env::var("VIBE_PERF_IDLE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        report("city_rubble_idle", &scene.measure(ticks));
        scene.markers = std::env::var("VIBE_PERF_MARKERS").is_ok();
        let mut measured = Vec::new();
        for t in 0..ticks {
            if t % 5 == 0 {
                let b = &buildings[(t as usize / 5) % buildings.len()];
                let k = (t / 5) as f32;
                let (x, z) = (b.centre[0] - 6.0 + (k * 1.7) % 12.0, b.centre[2] - b.radius - 6.0);
                scene
                    .world()
                    .launch_dynamic_ball(LaunchedBallDesc {
                        entity_id: 0x3300_0000 | t, user_id: t,
                        pose: Pose { position: BridgeVec3::new(x, 0.6, z), rotation: Quat::IDENTITY },
                        radius: 0.5, mass: 40.0, linear_velocity: BridgeVec3::new(0.0, 0.0, 6.0),
                        collision_group: u32::MAX, collision_mask: u32::MAX,
                    })
                    .expect("ball");
            }
            measured.extend(scene.run(1));
        }
        scene.markers = false;
        report("city_rubble_awake", &measured);
    }

    // The live play session's first two meteors (session 20260924-213925-ondf3t,
    // launch ticks 18284 and 18718), replayed with their logged start and
    // velocity: the first into structure 13, the second 434 ticks later into
    // structure 9. Every tick from the first launch is measured, so the flight,
    // the first contact and the recovery are all in the trace. The rock's size
    // follows `VIBE_CITY_METEOR_*`; the velocity is the live one either way.
    // `VIBE_PERF_METEOR_AFTER_TICKS` (default 600) is how long the second
    // impact is followed.
    if wanted("meteor") {
        let mut scene = Scene::city();
        scene.run(120);
        let after: u32 = std::env::var("VIBE_PERF_METEOR_AFTER_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
        scene.markers = std::env::var("VIBE_PERF_MARKERS").is_ok();
        let first = scene.tick;
        scene.meteor(Vec3::new(322.0575, 187.02917, 75.24434), Vec3::new(-122.439, -53.863_537, -9.726_216));
        let mut ticks = scene.run(434);
        scene.meteor(Vec3::new(-53.245_647, 237.35829, 349.71442), Vec3::new(11.497_002, -65.89396, -114.31002));
        ticks.extend(scene.run(173 + after));
        scene.markers = false;
        eprintln!("METEOR {{\"first_launch_tick\":{first},\"second_launch_tick\":{}}}", first + 434);
        report("meteor_pair", &ticks);
    }

    if wanted("rubble_sleep") {
        rubble_sleep();
    }

    if wanted("demolition") {
        let mut scene = Scene::city();
        scene.run(120);
        let (centre, _) = scene.city.tallest_footprint().expect("a tallest building");
        scene.city.set_demolition_shape(0.0, 60.0, 0.0);
        let world = scene.arena.physx_world_mut();
        let queued = scene.city.demolish_supports(centre, 10.0, 8.0, 48, world);
        assert!(queued > 0, "the demolition queued nothing");
        report("demolition", &scene.run(600));
    }
}

/// Tilt of a box body: the smallest angle between any of its axes and world
/// up. Zero is lying on a face or standing square; 54.7 degrees is balanced on
/// a corner. Chunk shapes carry translation-only local poses, so a body's axes
/// are its chunks' box axes.
fn tilt_deg(q: glam::Quat) -> f32 {
    [glam::Vec3::X, glam::Vec3::Y, glam::Vec3::Z]
        .iter()
        .map(|axis| (q * *axis).y.abs().clamp(0.0, 1.0).acos().to_degrees())
        .fold(f32::MAX, f32::min)
}

/// One chunk body row, copied out of the bridge's snapshot table.
struct RubbleRow {
    entity: u32,
    flags: u32,
    sleeping: bool,
    kinematic: bool,
    nodes: u32,
    p: glam::Vec3,
    q: glam::Quat,
}

fn rubble_rows(scene: &mut Scene) -> Vec<RubbleRow> {
    scene
        .world()
        .native_chunk_body_snapshots()
        .expect("chunk snapshots")
        .iter()
        .map(|r| RubbleRow {
            entity: r.entity_id,
            flags: r.flags,
            sleeping: r.sleeping,
            kinematic: r.kinematic,
            nodes: r.node_count,
            p: glam::Vec3::new(r.position.x, r.position.y, r.position.z),
            q: glam::Quat::from_xyzw(r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w).normalize(),
        })
        .collect()
}

fn angle_deg(a: glam::Quat, b: glam::Quat) -> f32 {
    (2.0 * a.dot(b).abs().clamp(0.0, 1.0).acos()).to_degrees()
}

fn pcts(v: &mut Vec<f32>) -> [f32; 5] {
    if v.is_empty() {
        return [0.0; 5];
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let at = |p: f32| v[((p / 100.0) * (v.len() - 1) as f32).round() as usize];
    [at(10.0), at(50.0), at(90.0), at(99.0), at(100.0)]
}

/// Per-body pose history for the rubble scenario.
#[derive(Default)]
struct RubbleTrack {
    /// Last awake poses, newest last, with their tick.
    history: std::collections::VecDeque<(u32, glam::Vec3, glam::Quat)>,
    /// Final-window start pose and path, for bodies awake in that window.
    window_start: Option<(glam::Vec3, glam::Quat)>,
    window_path: f32,
    window_turn: f32,
    window_ticks: u32,
    window_last: Option<(glam::Vec3, glam::Quat)>,
    nodes: u32,
}

/// Rubble that never sleeps, and where rubble comes to rest.
///
/// Attacks every building the way the city bench does -- three cannonballs
/// into the face, a meteor on the roof, then the footing demolished (48
/// rounds, 25% jitter, straight drop and 50-degree wedge alternating), 15 s a
/// building -- then leaves the city alone and watches it settle. What it answers:
///
/// - awake chunk bodies over the settle, the first tick with none awake, and
///   the step cost once nothing is being destroyed (`RUBBLE`, `RUBBLE_SERIES`);
/// - the bodies still awake at the end and whether they are going anywhere:
///   path length against net displacement over the final window (`KEEPER`);
/// - where everything came to rest: heights, tilt (smallest angle between a
///   body axis and world up) and the fraction resting leaned (`REST`), and a
///   per-body CSV (`VIBE_PERF_TRACE_DIR`) for comparing distributions;
/// - whether anything was stopped while it was still moving: each sleep edge's
///   displacement and turn over the 10 ticks before it (`RUBBLE`).
///
/// `VIBE_PERF_RUBBLE_BUILDINGS` caps the buildings (default all),
/// `VIBE_PERF_RUBBLE_SETTLE_TICKS` sets the settle (default 3600).
fn rubble_sleep() {
    let env_u32 = |name: &str, default: u32| {
        std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    let max_buildings = env_u32("VIBE_PERF_RUBBLE_BUILDINGS", 64) as usize;
    let settle_ticks = env_u32("VIBE_PERF_RUBBLE_SETTLE_TICKS", 3600);
    let window = 300u32;
    let label = std::env::var("VIBE_PERF_LABEL").unwrap_or_else(|_| "rubble_sleep".into());

    let (_, manifest, _) = crate::city::manifest_asset().expect("city manifest");
    let mut buildings: Vec<_> = vibe_land_destruction::buildings::enumerate(manifest)
        .into_iter()
        .filter(|b| b.chunks >= 20)
        .collect();
    buildings.sort_by_key(|b| b.id);
    buildings.truncate(max_buildings);

    let mut scene = Scene::city();
    scene.run(120);
    let mut tracks: std::collections::HashMap<u32, RubbleTrack> = Default::default();
    let mut settle_disp: Vec<f32> = Vec::new();
    let mut settle_turn: Vec<f32> = Vec::new();
    let mut settle_edges = 0u32;
    let mut wake_edges = 0u32;
    let mut stopped_moving = 0u32;
    let mut attack_dyn: Vec<f32> = Vec::new();

    // One tick plus the bookkeeping; `phase_start` is the settle's first tick.
    let mut observe = |scene: &mut Scene,
                       tracks: &mut std::collections::HashMap<u32, RubbleTrack>,
                       in_settle: bool,
                       final_window: bool|
     -> Tick {
        let t = scene.run(1).pop().expect("one tick");
        let tick = t.tick;
        let rows = rubble_rows(scene);
        for row in rows.iter().filter(|r| !r.kinematic) {
            let (p, q) = (row.p, row.q);
            let track = tracks.entry(row.entity).or_default();
            track.nodes = row.nodes;
            if row.flags == 1 && in_settle {
                settle_edges += 1;
                // Displacement over the last 10 awake ticks before the edge.
                if let Some(&(t0, p0, q0)) = track.history.iter().rev().nth(9) {
                    if tick - t0 <= 12 {
                        let d = (p - p0).length();
                        let r = angle_deg(q, q0);
                        if d > 0.01 || r > 1.0 {
                            stopped_moving += 1;
                        }
                        settle_disp.push(d);
                        settle_turn.push(r);
                    }
                }
            } else if row.flags == 2 && in_settle {
                wake_edges += 1;
            }
            if !row.sleeping {
                track.history.push_back((tick, p, q));
                while track.history.len() > 11 {
                    track.history.pop_front();
                }
                if final_window {
                    if track.window_start.is_none() {
                        track.window_start = Some((p, q));
                    }
                    if let Some((lp, lq)) = track.window_last {
                        track.window_path += (p - lp).length();
                        track.window_turn += angle_deg(q, lq);
                    }
                    track.window_last = Some((p, q));
                    track.window_ticks += 1;
                }
            }
        }
        t
    };

    // `VIBE_PERF_RUBBLE_SEED` varies the meteors' arcs and the demolition
    // headings: one seed replays identically, so distributions need several.
    let seed = env_u32("VIBE_PERF_RUBBLE_SEED", 0);
    let mut meteor_rng = crate::meteor::Rng::new(0x5eed + u64::from(seed));
    let gravity = {
        let g = vibe_netcode::movement::default_world_gravity();
        Vec3::new(g[0], g[1], g[2])
    };
    for (i, b) in buildings.iter().enumerate() {
        let height = b.top - b.bottom;
        // The bench's attack on each building before the footing goes: three
        // cannonballs into the face from a 10 m standoff, then a meteor on the
        // roof. Rubble from these is what the demolition alone does not make.
        let centre = Vec3::new(b.centre[0], 0.0, b.centre[2]);
        let outward = {
            let flat = Vec3::new(centre.x, 0.0, centre.z);
            if flat.length() > 1.0 { flat.normalize() } else { Vec3::X }
        };
        let from = centre + outward * (b.radius + 10.0) + Vec3::new(0.0, 1.6, 0.0);
        for k in 0..3 {
            let aim = centre + Vec3::new(0.0, b.bottom.max(0.0) + height * (0.2 + 0.25 * k as f32), 0.0);
            scene.cannonball(from, aim);
            for _ in 0..60 {
                attack_dyn.push(observe(&mut scene, &mut tracks, false, false).dyn_ms);
            }
        }
        let tuning = crate::meteor::MeteorTuning::from_env();
        let launch = crate::meteor::plan(Vec3::new(b.centre[0], b.top, b.centre[2]), gravity, &tuning, &mut meteor_rng);
        let _ = scene.arena.launch_meteor(
            nalgebra::Vector3::new(launch.start.x, launch.start.y, launch.start.z),
            nalgebra::Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z),
            tuning.radius_m,
            tuning.mass_kg,
            tuning.ttl_ticks,
        );
        for _ in 0..240 {
            attack_dyn.push(observe(&mut scene, &mut tracks, false, false).dyn_ms);
        }
        let wedge = if i % 2 == 0 { 0.0 } else { 50.0 };
        scene.city.set_demolition_shape(((i as u32 + seed * 7) as f32 * 137.0) % 360.0, wedge, 0.25);
        let world = scene.arena.physx_world_mut();
        let below = b.bottom.max(0.0) + (height * 0.3).clamp(2.0, 8.0);
        scene.city.demolish_supports([b.centre[0], b.centre[2]], b.radius + 1.0, below, 48, world);
        for _ in 0..300 {
            attack_dyn.push(observe(&mut scene, &mut tracks, false, false).dyn_ms);
        }
    }

    let start = scene.tick;
    let mut first_zero: Option<u32> = None;
    let mut min_awake = u32::MAX;
    let mut idle_dyn: Vec<f32> = Vec::new();
    let mut idle_total: Vec<f32> = Vec::new();
    let mut all_dyn: Vec<f32> = Vec::new();
    let mut bucket: Vec<Tick> = Vec::new();
    let mut last_status = scene.world().native_last_status().ok();
    let mut unconverged = 0u32;
    let mut stage_errors = 0u32;
    for k in 0..settle_ticks {
        let final_window = k + window >= settle_ticks;
        let t = observe(&mut scene, &mut tracks, true, final_window);
        if let Ok(status) = scene.world().native_last_status() {
            if status.iterations > 0 && !status.converged {
                unconverged += 1;
            }
            if status.error != 0 {
                stage_errors += 1;
            }
            last_status = Some(status);
        }
        if t.awake_chunks == 0 && first_zero.is_none() {
            first_zero = Some(t.tick - start);
        }
        min_awake = min_awake.min(t.awake_chunks);
        all_dyn.push(t.dyn_ms);
        if k + 600 >= settle_ticks {
            idle_dyn.push(t.dyn_ms);
            idle_total.push(t.total_ms);
        }
        bucket.push(t);
        if bucket.len() == 60 {
            let awake_max = bucket.iter().map(|t| t.awake_chunks).max().unwrap_or(0);
            let awake_min = bucket.iter().map(|t| t.awake_chunks).min().unwrap_or(0);
            let dyn_mean = bucket.iter().map(|t| t.dyn_ms).sum::<f32>() / 60.0;
            eprintln!(
                "RUBBLE_SERIES {{\"label\":\"{label}\",\"s\":{:.0},\"awake_max\":{awake_max},\"awake_min\":{awake_min},\"dyn_mean\":{dyn_mean:.2},\"broken\":{}}}",
                f64::from(k + 1) / 60.0,
                bucket.last().map(|t| t.broken_bonds).unwrap_or(0)
            );
            bucket.clear();
        }
    }

    // The city bench ends with the player sitting in the car it drove, and an
    // occupied car never sleeps. Measured separately so the settled-rubble
    // number above is not confused with the car's.
    let mut car_dyn: Vec<f32> = Vec::new();
    if scene.arena.vehicle_exists(crate::demo_world::CITY_VEHICLE_ID_CYBERTRUCK) {
        scene.arena.enter_vehicle(1, crate::demo_world::CITY_VEHICLE_ID_CYBERTRUCK);
        for _ in 0..60 {
            scene.run(1);
        }
        for _ in 0..300 {
            car_dyn.push(scene.run(1).pop().expect("one tick").dyn_ms);
        }
        scene.arena.exit_vehicle(1);
    }
    let car_d = pcts(&mut car_dyn);
    let rows = rubble_rows(&mut scene);
    let spans = scene.city.extra_spans();
    let span = |name: &str| spans.iter().find(|s| s.name == name).map_or(0.0, |s| s.value);
    let rest_sleep = format!(
        "\"rest_slept_bodies\":{},\"rest_slept_clusters\":{},\"rest_held_clusters\":{},\"rest_rewakes\":{},\"stage_error_frames\":{}",
        span("native_rest_slept_bodies"), span("native_rest_slept_clusters"), span("native_rest_held_clusters"),
        span("native_rest_rewakes"), span("native_error_frames")
    );
    let broken = scene.city.stats().broken_bonds;
    let final_awake = scene.city.stats().awake_chunk_bodies;

    // Where things came to rest: every dynamic chunk body still in the world.
    let mut ys = Vec::new();
    let mut tilts = Vec::new();
    let mut csv = String::from("entity,nodes,sleeping,x,y,z,tilt_deg\n");
    let (mut bodies, mut sleeping, mut gt5, mut gt15, mut flat) = (0u32, 0u32, 0u32, 0u32, 0u32);
    for row in rows.iter().filter(|r| !r.kinematic) {
        let p = row.p;
        if !p.is_finite() || p.y < -3.0 || p.y > 200.0 {
            continue;
        }
        let tilt = tilt_deg(row.q);
        bodies += 1;
        sleeping += u32::from(row.sleeping);
        gt5 += u32::from(tilt > 5.0);
        gt15 += u32::from(tilt > 15.0);
        flat += u32::from(tilt < 2.0);
        ys.push(p.y);
        tilts.push(tilt);
        csv.push_str(&format!(
            "{},{},{},{:.4},{:.4},{:.4},{:.3}\n",
            row.entity, row.nodes, row.sleeping as u8, p.x, p.y, p.z, tilt
        ));
    }
    if let Ok(dir) = std::env::var("VIBE_PERF_TRACE_DIR") {
        std::fs::write(format!("{dir}/{label}-rest.csv"), csv).expect("write rest csv");
    }
    let frac = |n: u32| if bodies == 0 { 0.0 } else { f64::from(n) / f64::from(bodies) };
    let y = pcts(&mut ys);
    let tl = pcts(&mut tilts);
    eprintln!(
        "REST {{\"label\":\"{label}\",\"bodies\":{bodies},\"sleeping\":{sleeping},\"y_p10\":{:.3},\"y_p50\":{:.3},\"y_p90\":{:.3},\"y_p99\":{:.3},\
\"tilt_p10\":{:.2},\"tilt_p50\":{:.2},\"tilt_p90\":{:.2},\"tilt_p99\":{:.2},\"flat_lt2\":{:.4},\"lean_gt5\":{:.4},\"lean_gt15\":{:.4}}}",
        y[0], y[1], y[2], y[3], tl[0], tl[1], tl[2], tl[3], frac(flat), frac(gt5), frac(gt15)
    );

    // What is still awake, and whether it is going anywhere.
    let mut keepers: Vec<(u32, &RubbleTrack)> = tracks
        .iter()
        .filter(|(_, t)| t.window_ticks + 10 >= window)
        .map(|(e, t)| (*e, t))
        .collect();
    let awake_through = keepers.len();
    let still = keepers.iter().filter(|(_, t)| t.window_path < 0.001 && t.window_turn < 0.5).count();
    keepers.sort_by(|a, b| b.1.window_path.total_cmp(&a.1.window_path));
    for (entity, t) in keepers.iter().take(16) {
        let (p0, q0) = t.window_start.unwrap();
        let (p1, q1) = t.window_last.unwrap();
        eprintln!(
            "KEEPER {{\"label\":\"{label}\",\"entity\":\"{entity:#x}\",\"nodes\":{},\"y\":{:.3},\"tilt\":{:.1},\"path_m\":{:.3},\"net_m\":{:.4},\"turn_deg\":{:.1},\"net_turn_deg\":{:.2}}}",
            t.nodes, p1.y, tilt_deg(q1), t.window_path, (p1 - p0).length(), t.window_turn, angle_deg(q0, q1)
        );
    }
    let dp = pcts(&mut settle_disp);
    let tp = pcts(&mut settle_turn);
    let idle_d = pcts(&mut idle_dyn);
    let idle_t = pcts(&mut idle_total);
    let all_d = pcts(&mut all_dyn);
    let attack_d = pcts(&mut attack_dyn);
    eprintln!(
        "RUBBLE {{\"label\":\"{label}\",\"buildings\":{},\"broken_bonds\":{broken},\"bodies\":{bodies},\"settle_s\":{:.0},\
\"first_zero_awake_s\":{},\"min_awake\":{min_awake},\"final_awake\":{final_awake},\"awake_through_window\":{awake_through},\
\"awake_but_still\":{still},\"idle_dyn_p50\":{:.2},\"idle_dyn_p90\":{:.2},\"idle_total_p50\":{:.2},\"idle_total_p90\":{:.2},\
\"settle_dyn_p50\":{:.2},\"settle_dyn_p90\":{:.2},\"attack_dyn_p50\":{:.2},\"attack_dyn_p90\":{:.2},\"occupied_car_dyn_p50\":{:.2},\"occupied_car_dyn_p90\":{:.2},\"unconverged_ticks\":{unconverged},\"last_iterations\":{},\
\"sleep_edges\":{settle_edges},\"wake_edges\":{wake_edges},\"stopped_moving\":{stopped_moving},\"settle_stage_errors\":{stage_errors},{rest_sleep},\
\"edge_disp_p50\":{:.4},\"edge_disp_p99\":{:.4},\"edge_disp_max\":{:.4},\"edge_turn_p99\":{:.2},\"edge_turn_max\":{:.2}}}",
        buildings.len(),
        f64::from(settle_ticks) / 60.0,
        first_zero.map_or("null".to_string(), |t| format!("{:.1}", f64::from(t) / 60.0)),
        idle_d[1], idle_d[2], idle_t[1], idle_t[2], all_d[1], all_d[2], attack_d[1], attack_d[2], car_d[1], car_d[2],
        last_status.map_or(0, |s| s.iterations),
        dp[1], dp[3], dp[4], tp[3], tp[4],
    );
}
