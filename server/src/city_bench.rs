//! Deterministic destruction benchmark.
//!
//! Every perf conclusion drawn from the browser harness so far was confounded
//! by scale variance — the same scenario produced anywhere from 235 to 1031
//! bodies, because the shooter *walks* to each tower and fires from wherever it
//! ends up. Two runs at different scales cannot be compared, so a timing delta
//! meant nothing.
//!
//! This drives `CityRuntime` directly: fixed rays from fixed points at fixed
//! ticks. No browser, no network, no walking.
//!
//! The *input* is identical every run, but the outcome is not: GPU rigid-body
//! simulation is not bit-reproducible across runs (parallel reduction order
//! varies), so measured damage swings ~10-15% run to run. Two things make the
//! bench usable anyway, both verified by running it twice unchanged:
//!   - phase timings are stable to <2% even when bond count moves 12%, because
//!     at this scale cost tracks the graph, not the exact fracture pattern;
//!   - `us/body` normalises whatever scale a given run happened to produce.
//! The gate therefore catches gross drift (a change that accidentally halves
//! destruction) rather than pretending to reproducibility we do not have.
//!
//! Run:
//!   VIBE_CITY_SCENE=high-rise-10f-local.json \
//!   cargo test -p web-fps-server --features destruction city_bench \
//!     -- --nocapture --ignored
#![cfg(all(test, feature = "destruction"))]

use glam::Vec3;
use vibe_land_physx_bridge::{Pose, Quat, StaticBoxDesc, Vec3 as BridgeVec3, World, WorldConfig};

/// Ticks after the last shot, so collapses finish and the pile settles.
const SETTLE_TICKS: u32 = 300;
/// Ticks between shots. Short enough that collapses overlap — which is the
/// state we actually care about, many bodies active at once.
const SHOT_INTERVAL_TICKS: u32 = 20;
const DT: f32 = 1.0 / 60.0;
/// The gravity production passes to `city.step`, from the same source.
///
/// Hardcoding this was a real infidelity: it stayed at 9.81 when the world was
/// raised to 20 m/s^2, so the bench fed the stress solver Earth gravity inside
/// a 2x-gravity PhysX scene -- a combination production never runs. A
/// reproduction that does not match the thing it reproduces measures its own
/// Build the world the way production does.
///
/// `World::new(WorldConfig::default())` is NOT what the server runs.
/// `PhysxPhysicsArena::new` applies five GPU capacity overrides from the
/// environment (rigid contacts, rigid patches, heap, found/lost pairs,
/// collision stack) before constructing the scene. A bench that skips them is
/// measuring a differently-sized GPU scene than production, and GPU capacity is
/// exactly the kind of limit whose effects show up as dropped contacts rather
/// than as an error.
///
/// This is the same class of divergence as the hardcoded gravity that made the
/// bench feed 9.81 into a 20 m/s^2 world: anything production decides, the
/// bench must call rather than restate.
fn production_arena() -> crate::movement::PhysicsArena {
    crate::movement::PhysicsArena::new(
        vibe_netcode::movement::MoveConfig::default(),
        vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu,
    )
    .expect("production physics arena")
}

/// Fail if the bench and production have drifted apart on anything a caller
/// could set independently.
///
/// Cheap, and it catches the next instance of this bug class rather than
/// relying on someone noticing. Every value here has already diverged once.
fn assert_matches_production(world: &vibe_land_physx_bridge::World) {
    let g = vibe_netcode::movement::default_world_gravity();
    assert_eq!(
        g,
        [0.0, -vibe_land_physx_bridge::world_gravity_magnitude(), 0.0],
        "the gravity city.step is given has drifted from the gravity the PhysX \
         world integrates with; the bench would measure a combination \
         production never runs"
    );
    let _ = world;
}

/// configuration, not the bug.
fn gravity() -> [f32; 3] {
    vibe_netcode::movement::default_world_gravity()
}

const GROUP_STATIC: u32 = 1 << 0;
const ALL_GROUPS: u32 = u32::MAX;

/// Fixed firing positions and aim points. Deliberately hard-coded rather than
/// derived from the manifest: if the scene changes underneath us, the bond
/// gate fails loudly instead of silently benchmarking a different city.
fn shot_plan() -> Vec<(Vec3, Vec3)> {
    let mut shots = Vec::new();
    for (tx, tz) in [
        (-36.0f32, -36.0f32),
        (-12.0, -36.0),
        (12.0, -36.0),
        (36.0, -36.0),
        (-36.0, -12.0),
        (-12.0, -12.0),
        (12.0, -12.0),
        (36.0, -12.0),
        (-36.0, 12.0),
        (-12.0, 12.0),
        (12.0, 12.0),
        (36.0, 12.0),
    ] {
        let origin = Vec3::new(tx, 1.6, tz - 30.0);
        // Rake the lower floors, where cutting supports actually collapses a
        // tower, rather than chipping the top.
        for aim_y in [2.0f32, 3.5, 5.0, 6.5, 3.0, 4.5, 2.5, 5.5] {
            let target = Vec3::new(tx, aim_y, tz);
            shots.push((origin, (target - origin).normalize()));
        }
    }
    shots
}

fn pct(values: &mut Vec<f32>, p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[((values.len() as f32 * p) as usize).min(values.len() - 1)]
}

/// Debris must actually come to rest: shoot a tower down, then leave it alone.
///
/// The user reported destroying a building, moving on, and it never settling --
/// plus chunks that appeared to vibrate or bob rather than rest. A full
/// demolition measured only 4% of bodies asleep. Sleep is not cosmetic here:
/// every per-awake-body cost in the pipeline (gravity injection, readback,
/// settle scan, encoder ingest) scales with the awake set, so a pile that
/// never sleeps multiplies the whole tick.
///
/// Two assertions, because "awake" and "moving" are different failures:
///   - a settle fraction, catching bodies denied sleep;
///   - a motion bound over the same window, catching bodies genuinely still
///     oscillating (which would make sleep incorrect rather than missing).
#[test]
#[ignore = "benchmark: needs a GPU"]
fn demolished_tower_comes_to_rest() {
    // KNOWN FAILING as of 2026-08-25, and the cause is isolated: freeze.
    //
    //   VIBE_CITY_FREEZE=1  ->   1% of 185 bodies asleep after 20 s  (fails)
    //   VIBE_CITY_FREEZE=0  ->  passes
    //
    // Same scene, same stimulus, one variable. Rigid-body contact is ruled out
    // independently: physx-bridge/tests/stack_settling.rs settles 10,416
    // concrete boxes to *exactly* 0.0000 m/s at PhysX's default 4/1 solver
    // iterations under the same 20 m/s^2 gravity, so neither stacking, pile
    // depth, body count, gravity nor iteration count is responsible.
    //
    // The mechanism is already documented in freeze.rs: a frozen body is
    // kinematic, and a kinematic body squeezed by its neighbours becomes a
    // depenetration pump for them -- recorded there as "198 bodies permanently
    // awake". Raising world gravity to 20 m/s^2 doubled the squeeze, which is
    // why this surfaced when gravity changed without gravity being the fault.
    //
    // Supporting telemetry from a 3-hour idle server: 185k freeze flips against
    // 179k unfreezes, 164k contact wakes, and backstop_releases at 182 against
    // its own documented expectation of 0.

    let mut arena = production_arena();
    // The ground, from production's own document rather than a hand-rolled box.
    //
    // The arena builds the scene but not its contents; production calls this to
    // instantiate terrain, which is a *heightfield*. A flat static box was the
    // stand-in, and it is not equivalent -- contact generation against a
    // heightfield differs in triangle edges and per-triangle normals, which for
    // a jitter bug is a live suspect rather than a harmless simplification.
    // Going through the same call means the terrain cannot drift from
    // production's by construction.
    crate::demo_world::seed_world_for_match(&mut arena, crate::city::CITY_MATCH_PREFIX)
        .expect("seed the production world document");
    let player_spawn = arena.spawn_player(1);
    let world = arena.physx_world_mut().expect("physx world");
    assert_matches_production(world);
    eprintln!(
        "[fidelity] production arena, player capsule at {:.1?}",
        player_spawn
    );
    let mut world = &mut *world;
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    // Demolish one tower.
    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    for shot in 0..40 {
        let sweep = -4.0 + (shot % 9) as f32 * 1.0;
        let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
    }

    // Then walk away: 20 s of simulation with no further input.
    const SETTLE_SECONDS: u32 = 20;
    let mut asleep_trace = Vec::new();
    for second in 0..SETTLE_SECONDS {
        for _ in 0..60 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
        let stats = city.stats();
        asleep_trace.push((
            second + 1,
            stats.sleeping_chunk_bodies,
            stats.chunk_bodies,
            stats.max_body_speed,
            stats.resettled_wakes,
            stats.max_speed_body_pos,
            stats.max_speed_body_entity,
        ));
    }

    // The speed *distribution*, not just the max.
    //
    // `max_body_speed` is dominated by a handful of outliers -- this trace
    // shows 6-20 m/s bodies, which is something being thrown, not jitter. The
    // jitter that is visible while playing lives in the bulk: a large mass of
    // bodies at tenths of a m/s, each individually too slow to notice and
    // collectively never sleeping. A max cannot see it, so it is measured
    // directly here.
    if let Ok(snaps) = world.chunk_body_snapshots() {
        let mut speeds: Vec<f32> = snaps
            .iter()
            .filter(|b| !b.sleeping && !b.kinematic)
            .map(|b| {
                let v = &b.linear_velocity;
                (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
            })
            .collect();
        speeds.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |q: f32| -> f32 {
            if speeds.is_empty() {
                return 0.0;
            }
            speeds[((speeds.len() - 1) as f32 * q) as usize]
        };
        println!("\n=== awake-body speed distribution after 20 s idle ===");
        println!("awake (non-kinematic) {}", speeds.len());
        println!(
            "p10 {:.4}  p50 {:.4}  p90 {:.4}  p99 {:.4}  max {:.4}  (m/s)",
            pct(0.10),
            pct(0.50),
            pct(0.90),
            pct(0.99),
            speeds.last().copied().unwrap_or(0.0)
        );
        let jitter = speeds.iter().filter(|v| **v > 0.001 && **v < 0.5).count();
        println!(
            "in the jitter band (0.001-0.5 m/s): {} of {} ({:.0}%)",
            jitter,
            speeds.len(),
            100.0 * jitter as f32 / speeds.len().max(1) as f32
        );
    }

    let stats = city.stats();
    let bodies = stats.chunk_bodies.max(1);
    let asleep_pct = 100.0 * stats.sleeping_chunk_bodies as f32 / bodies as f32;
    println!("\n=== settle after demolition ===");
    println!("bodies         {}", stats.chunk_bodies);
    println!("broken bonds   {}", stats.broken_bonds);
    println!(
        "{:>5}  {:>8}  {:>6}  {:>9}  {:>10}  {:>10}",
        "sec", "asleep", "pct", "maxspeed", "rewakes", "fastest body pos / entity"
    );
    for (second, asleep, total, speed, wakes, fast_y, entity) in &asleep_trace {
        println!(
            "{:>5}  {:>8}  {:>5.0}%  {:>9.2}  {:>8}  {}",
            second,
            asleep,
            100.0 * *asleep as f32 / (*total).max(1) as f32,
            speed,
            wakes,
            format!(
                "({:.1}, {:.1}, {:.1}) #{}",
                fast_y[0], fast_y[1], fast_y[2], entity
            )
        );
    }

    // Motion bound: with no input for 20 s, nothing should still be moving at
    // a speed that implies active simulation rather than residual creep.
    //
    // MEASURED RUN-TO-RUN SPREAD (2026-08-25, identical config, 5 runs):
    //
    //   peak speed   0.23  0.24  0.38  0.50  1.40   m/s
    //   awake         62    90   101   165   118
    //   bodies       297   383   315   383   350
    //
    // A 6x spread in peak speed and 2.7x in awake count, because PhysX GPU is
    // not bit-reproducible and the scripted shots therefore collapse a
    // different amount of building each run. The pile being measured is a
    // different pile every time.
    //
    // Consequences, both load-bearing:
    //
    //  - A SINGLE RUN CANNOT SUPPORT A CONCLUSION HERE. Any A/B whose effect is
    //    smaller than this band is unmeasured, not measured-as-small.
    //  - This 1.0 m/s bound sits inside the band, so it fires intermittently on
    //    unchanged code. It is a flake, not a gate, until either the
    //    reproduction is made deterministic (fix the pile, stop shooting it) or
    //    the assertion moves to a percentile over repeated runs.
    //
    // The "pile is oscillating at 1.4 m/s" report that motivated investigating
    // oscillation was the top sample of this distribution, not a distinct
    // phenomenon.
    let resting_speed = stats.max_body_speed;
    println!("peak speed now {resting_speed:.2} m/s");

    assert!(
        resting_speed < 1.0,
        "bodies still moving at {resting_speed:.1} m/s after {SETTLE_SECONDS}s of \
         no input: the pile is oscillating, not settling"
    );
    assert!(
        asleep_pct >= 80.0,
        "only {asleep_pct:.0}% of {} bodies asleep after {SETTLE_SECONDS}s of no \
         input (want >=80%). Debris that never sleeps multiplies every \
         per-awake-body cost in the tick",
        stats.chunk_bodies
    );
}

/// Would view clustering actually reduce evaluations, and by how much?
///
/// The per-client stream cost is O(bodies x players) because every client
/// ranks bodies for itself. Clustering clients with similar cameras would make
/// it O(bodies x clusters) -- but only if realistic player distributions
/// actually cluster. This measures the cluster count directly rather than
/// assuming it, because a distribution that yields 40 clusters from 64 players
/// is a 1.6x win and not worth the machinery.
///
/// Two players share a cluster when their eyes are close AND they look in
/// similar directions: both matter, since visibility depends on position and
/// orientation together.
#[test]
fn view_clustering_reduction_on_realistic_layouts() {
    fn cluster_count(cameras: &[(Vec3, Vec3)], eye_radius_m: f32, cos_tolerance: f32) -> usize {
        // Greedy: first camera seeds a cluster, later ones join if close to
        // the seed. Deliberately simple -- it is a lower bound on what a
        // smarter clustering achieves, so it will not flatter the idea.
        let mut seeds: Vec<(Vec3, Vec3)> = Vec::new();
        for &(eye, direction) in cameras {
            let joined = seeds.iter().any(|&(seed_eye, seed_dir)| {
                eye.distance(seed_eye) <= eye_radius_m
                    && direction.dot(seed_dir) >= cos_tolerance
            });
            if !joined {
                seeds.push((eye, direction));
            }
        }
        seeds.len()
    }

    // 30 degrees of direction tolerance, 25 m of position tolerance: wide
    // enough to share visibility of a 96 m city at typical viewing range.
    let cos_tolerance = 30.0f32.to_radians().cos();
    let eye_radius_m = 25.0;

    println!("\n=== view clustering: clusters per layout ===");
    println!("{:>8}  {:>10}  {:>10}  {:>10}", "players", "ring", "clumped", "scattered");
    for &players in &[4usize, 16, 32, 64, 128] {
        // Ring: everyone around the edge looking inward (the bench layout).
        let ring: Vec<(Vec3, Vec3)> = (0..players)
            .map(|i| {
                let angle = i as f32 / players as f32 * std::f32::consts::TAU;
                let eye = Vec3::new(angle.cos() * 70.0, 2.0, angle.sin() * 70.0);
                (eye, (Vec3::ZERO - eye).normalize())
            })
            .collect();
        // Clumped: a firefight -- players bunched in a few spots, similar views.
        let clumped: Vec<(Vec3, Vec3)> = (0..players)
            .map(|i| {
                let group = i % 4;
                let angle = group as f32 / 4.0 * std::f32::consts::TAU;
                let jitter = (i / 4) as f32 * 0.7;
                let eye = Vec3::new(
                    angle.cos() * 40.0 + jitter,
                    2.0,
                    angle.sin() * 40.0 + jitter * 0.5,
                );
                (eye, (Vec3::ZERO - eye).normalize())
            })
            .collect();
        // Scattered: worst case -- spread through the city facing anywhere.
        let scattered: Vec<(Vec3, Vec3)> = (0..players)
            .map(|i| {
                let a = i as f32 * 2.399;
                let b = i as f32 * 1.117;
                let eye = Vec3::new(a.sin() * 48.0, 2.0, a.cos() * 48.0);
                (eye, Vec3::new(b.cos(), 0.0, b.sin()).normalize())
            })
            .collect();

        println!(
            "{:>8}  {:>10}  {:>10}  {:>10}",
            players,
            cluster_count(&ring, eye_radius_m, cos_tolerance),
            cluster_count(&clumped, eye_radius_m, cos_tolerance),
            cluster_count(&scattered, eye_radius_m, cos_tolerance),
        );
    }
    println!(
        "\nReduction is players/clusters. Clustering is worth building only if\n\
         that ratio is large on layouts players actually produce.\n"
    );
}

/// How many players can one match stream to?
///
/// Physics is player-independent -- PhysX steps the same scene whether one
/// client watches or two hundred. The stream is not: client_datagrams
/// evaluates interest and priority for every awake body FOR EVERY CLIENT, so
/// its cost is bodies x players, which is the worst scaling law in the system
/// and the thing that decides the player ceiling.
///
/// This drives the encoder directly rather than through browsers, so it can
/// reach player counts no e2e could, and isolates the streaming cost from
/// rendering and transport.
#[test]
#[ignore = "benchmark: needs a GPU, takes ~2 min"]
fn player_scaling_of_the_stream() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");

    // Build a large debris field first.
    let towers: Vec<(f32, f32)> = [-36.0f32, -12.0, 12.0, 36.0]
        .iter()
        .flat_map(|&x| [-36.0f32, -12.0, 12.0, 36.0].iter().map(move |&z| (x, z)))
        .collect();
    let mut tick = 0u32;
    for &(tx, tz) in towers.iter() {
        let origin = Vec3::new(tx, 1.6, tz - 26.0);
        for shot in 0..18 {
            let target = Vec3::new(
                tx + (-4.0 + (shot % 9) as f32),
                2.0 + (shot % 12) as f32 * 2.4,
                tz,
            );
            city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
            for _ in 0..6 {
                world.step().expect("step");
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                tick += 1;
            }
        }
    }

    let stats = city.stats();
    println!("\n=== stream cost vs player count ===");
    println!("bodies {}  awake {}", stats.chunk_bodies, stats.awake_chunk_bodies);
    println!(
        "\n{:>8}  {:>12}  {:>12}  {:>14}",
        "players", "shared p50", "pack p50", "pack/client"
    );

    for &players in &[1usize, 4, 16, 32, 64, 128, 256] {
        for id in 0..players {
            city.add_client(id as u64);
        }
        // Cameras ringed around the city looking inward, so interest is
        // realistic rather than every client sharing one view.
        let cameras: Vec<(u64, vibe_land_destruction::types::Camera)> = (0..players)
            .map(|id| {
                let angle = id as f32 / players as f32 * std::f32::consts::TAU;
                let eye = Vec3::new(angle.cos() * 70.0, 2.0, angle.sin() * 70.0);
                (
                    id as u64,
                    vibe_land_destruction::types::Camera {
                        eye,
                        direction: (Vec3::ZERO - eye).normalize(),
                        fov_degrees: 75.0,
                    },
                )
            })
            .collect();

        let (mut shared_ms, mut pack_ms) = (vec![], vec![]);
        for _ in 0..30 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;

            let started = std::time::Instant::now();
            let shared = city.encode_shared(tick);
            shared_ms.push(started.elapsed().as_secs_f32() * 1000.0);

            let started = std::time::Instant::now();
            for &(id, camera) in &cameras {
                let _ = city.client_datagrams(id, camera, &shared);
            }
            pack_ms.push(started.elapsed().as_secs_f32() * 1000.0);
        }

        let shared_p50 = pct(&mut shared_ms, 0.5);
        let pack_p50 = pct(&mut pack_ms, 0.5);
        println!(
            "{:>8}  {:>12.2}  {:>12.2}  {:>14.3}",
            players,
            shared_p50,
            pack_p50,
            pack_p50 / players as f32
        );

        for id in 0..players {
            city.remove_client(id as u64);
        }
    }
    println!(
        "\nBudget note: the whole tick must fit 16.67 ms, and the stream runs at\n\
         30 Hz (every other tick), so a pack cost of ~10 ms is already half the\n\
         budget on the ticks it lands.\n"
    );
}

/// Reproduce the reported demo: demolish the whole city, ~8k bodies.
///
/// The general bench peaks near 3.8k bodies; the user's session reached 8495
/// (8183 awake) at 53.4 ms/tick, and the interesting costs only appear at that
/// scale. This rakes every tower at several heights, then reports a per-phase
/// table that must account for the tick -- the previous single "stress solve"
/// number bundled serial beginTick, the CUDA solve and serial endTick
/// together, which is why the cost was attributed to the GPU for so long.
#[test]
#[ignore = "benchmark: needs a GPU, takes ~2 min"]
fn full_demolition_cost() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    let towers: Vec<(f32, f32)> = [-36.0f32, -12.0, 12.0, 36.0]
        .iter()
        .flat_map(|&x| [-36.0f32, -12.0, 12.0, 36.0].iter().map(move |&z| (x, z)))
        .collect();

    let (mut tick_ms, mut begin_ms, mut solve_ms, mut end_ms) =
        (vec![], vec![], vec![], vec![]);
    let (mut post_ms, mut snap_ms, mut ing_ms, mut dyn_ms) =
        (vec![], vec![], vec![], vec![]);
    let (mut rb_ms, mut set_ms, mut sf_ms) = (vec![], vec![], vec![]);
    let (mut ev_ms, mut fl_ms, mut dr_ms) = (vec![], vec![], vec![]);
    let mut cpp_rb_ms = vec![];
    let (mut peak_bodies, mut peak_awake) = (0u32, 0u32);
    let mut tick = 0u32;

    for (round, &(tx, tz)) in towers.iter().enumerate() {
        let origin = Vec3::new(tx, 1.6, tz - 26.0);
        for shot in 0..26 {
            let sweep = -4.0 + (shot % 9) as f32 * 1.0;
            let aim_y = 2.0 + (shot % 12) as f32 * 2.4;
            let target = Vec3::new(tx + sweep, aim_y, tz);
            city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
            for _ in 0..7 {
                let started = std::time::Instant::now();
                world.step().expect("step");
                let dynamics = world.stats().map(|s| s.last_step_ms).unwrap_or(0.0);
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                let stats = city.stats();
                peak_bodies = peak_bodies.max(stats.chunk_bodies);
                peak_awake = peak_awake.max(stats.awake_chunk_bodies);
                // Measure only once the city is genuinely large; early ticks
                // would drag the percentiles toward an empty scene.
                if round >= 4 {
                    tick_ms.push(started.elapsed().as_secs_f32() * 1000.0);
                    dyn_ms.push(dynamics);
                    begin_ms.push(stats.begin_ms);
                    solve_ms.push(stats.solve_ms);
                    end_ms.push(stats.end_ms);
                    post_ms.push(stats.post_step_ms);
                    snap_ms.push(stats.snapshot_ms);
                    ing_ms.push(stats.ingest_ms);
                    rb_ms.push(stats.readback_ms_host);
                    set_ms.push(stats.settle_ms);
                    sf_ms.push(stats.stats_ffi_ms);
                    ev_ms.push(stats.events_ms);
                    fl_ms.push(stats.filters_ms);
                    dr_ms.push(stats.drain_ms);
                    cpp_rb_ms.push(stats.readback_ms);
                }
                tick += 1;
            }
        }
    }

    // Settle curve: stop shooting and just run. This is the honest test of
    // sleep at scale -- the single-tower settle test passes at 628 bodies,
    // while the live city sits ~95% awake at 15-20k, and only a curve can say
    // whether that is "settling, slowly" or "a wake loop holding the pile
    // open". Wall-clock sampling of a moving demolition cannot answer it.
    println!("\n=== settle curve (no further shots) ===");
    println!("{:>6} {:>8} {:>8} {:>6} {:>10}", "sec", "bodies", "awake", "pct", "maxspeed");
    for quiet in 0..1800u32 {
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));
        tick += 1;
        if quiet % 120 == 0 {
            let s = city.stats();
            let pct = if s.chunk_bodies > 0 {
                100 * s.awake_chunk_bodies / s.chunk_bodies
            } else {
                0
            };
            println!(
                "{:>6} {:>8} {:>8} {:>5}% {:>10.2}",
                quiet / 60,
                s.chunk_bodies,
                s.awake_chunk_bodies,
                pct,
                s.max_body_speed
            );
        }
    }

    let stats = city.stats();
    println!("\n=== full demolition ===");
    println!("bodies (peak)  {peak_bodies}");
    println!("awake  (peak)  {peak_awake}");
    println!(
        "asleep now     {} of {} ({:.0}%)",
        stats.sleeping_chunk_bodies,
        stats.chunk_bodies,
        100.0 * stats.sleeping_chunk_bodies as f32 / stats.chunk_bodies.max(1) as f32
    );
    println!("broken bonds   {}", stats.broken_bonds);
    println!(
        "\n{:>14}  {:>8}  {:>8}  {:>8}",
        "phase", "p50", "p95", "max"
    );
    let mut accounted = 0.0f32;
    for (name, values) in [
        ("tick", &mut tick_ms),
        ("physx step", &mut dyn_ms),
        ("blast begin", &mut begin_ms),
        ("blast solve", &mut solve_ms),
        ("blast end", &mut end_ms),
        ("post_step", &mut post_ms),
        ("  drains+batch", &mut dr_ms),
        ("  events diff", &mut ev_ms),
        ("  filters", &mut fl_ms),
        ("  cpp readback", &mut cpp_rb_ms),
        ("  ffi snapshot", &mut rb_ms),
        ("  settle scan", &mut set_ms),
        ("  stats ffi", &mut sf_ms),
        ("snapshots", &mut snap_ms),
        ("encoder ingest", &mut ing_ms),
    ] {
        let p50 = pct(values, 0.5);
        if name != "tick" && name != "post_step" {
            accounted += p50;
        }
        println!(
            "{:>14}  {:>8.2}  {:>8.2}  {:>8.2}",
            name,
            p50,
            pct(values, 0.95),
            pct(values, 1.0)
        );
    }
    // post_step contains blast begin/solve/end plus the readback, so the sum
    // uses post_step's own children rather than double counting it.
    let tick_p50 = pct(&mut tick_ms, 0.5);
    println!(
        "\naccounted      {:.2} of {:.2} ms ({:.0}%)",
        accounted,
        tick_p50,
        100.0 * accounted / tick_p50.max(0.001)
    );

    assert!(
        peak_bodies >= 6000,
        "only reached {peak_bodies} bodies; this scenario is meant to reproduce \
         the reported ~8k-body demo"
    );
}

/// Sustained fire on one tower must never stop fracturing it.
///
/// The adapter's maximumBodies is an opt-in cap: at the cap, fracture()
/// silently drops every further fracture command for that structure, while
/// impulses still apply -- so the building stops breaking and just gets shoved.
/// We shipped with a per-structure cap of 512, and a single 10-floor tower has
/// ~1032 chunks, so concentrated fire hit the cap mid-fight and the remaining
/// slab became indestructible. This drives one tower far past 512 bodies and
/// asserts fracture kept going.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn sustained_fire_never_stops_fracturing() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    // Rake one tower at several heights until it is thoroughly demolished.
    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    for shot in 0..120 {
        let sweep = -4.0 + (shot % 17) as f32 * 0.5;
        let aim_y = 2.0 + (shot % 11) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
    }
    for _ in 0..300 {
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));
        tick += 1;
    }

    let stats = city.stats();
    println!("\n=== sustained fire on one tower ===");
    println!("chunk bodies   {}", stats.chunk_bodies);
    println!("broken bonds   {}", stats.broken_bonds);

    // 16 structures contribute one support body each, so anything well past
    // 512 total proves the targeted structure alone exceeded the old cap and
    // was still fracturing when it did.
    assert!(
        stats.chunk_bodies > 560,
        "{} bodies: the targeted tower did not get past the old 512-body cap, \
         so this run does not prove the cap is gone",
        stats.chunk_bodies
    );
}

/// Cut one tower clean in half and check the severed top reconstructs.
///
/// This is the reported reproduction: shooting horizontally until the top is
/// fully disconnected. It matters as its own test because the general
/// destruction bench sprays damage and mostly creates *new* actors, which are
/// positioned at their centre of mass and reconstruct correctly. A clean
/// severing is what leaves a piece holding the reused parent actor, whose pose
/// is the parent's frame rather than its centre of mass.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn severed_upper_half_reconstructs_in_com_frame() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    // Rake one height band around a single tower until the cut goes through.
    let (tx, tz) = (-36.0f32, -36.0f32);
    let cut_y = 12.0f32;
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    for shot in 0..48 {
        let sweep = -3.0 + (shot % 13) as f32 * 0.5;
        let target = Vec3::new(tx + sweep, cut_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..14 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
    }
    for _ in 0..600 {
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));
        tick += 1;
    }

    let stats = city.stats();
    println!("\n=== severed upper half ===");
    println!("broken bonds   {}", stats.broken_bonds);
    println!("chunk bodies   {}", stats.chunk_bodies);
    println!("min body y     {:.2} m", stats.min_body_y);
    println!("migrations     {}", stats.chunk_migrations);

    // Without this the test can pass vacuously: if the cut never severed
    // anything, no body ever holds the reused parent actor and the convention
    // under test is never exercised. That is exactly how an earlier check was
    // mistaken for a disproof.
    assert!(
        stats.broken_bonds > 200,
        "cut did not sever the tower ({} broken bonds); the reused-parent path \
         is not exercised and this test proves nothing",
        stats.broken_bonds
    );
    assert!(
        stats.min_body_y > -2.0,
        "island body at y={:.1} m after severing: a body whose pose is not its \
         centre of mass places its chunks a centre-of-mass height too low",
        stats.min_body_y
    );
}

#[test]
#[ignore = "benchmark: needs a GPU, takes ~30s"]
fn city_destruction_cost_is_stable() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    // Solid ground: the city sits on a box, not a heightfield, so debris cannot
    // tunnel through and skew the settle behaviour.
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");

    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    assert!(
        city.is_physx(),
        "bench requires the PhysX backend (unset VIBE_CITY_SYNTHETIC)"
    );
    city.add_client(1);

    let shots = shot_plan();
    let total_ticks = shots.len() as u32 * SHOT_INTERVAL_TICKS + SETTLE_TICKS;
    let (mut tick_ms, mut city_ms, mut solve_ms, mut events_ms, mut dynamics_ms) =
        (vec![], vec![], vec![], vec![], vec![]);
    let mut readback_ms: Vec<f32> = vec![];
    let (mut peak_awake, mut peak_bodies) = (0u32, 0u32);

    for tick in 0..total_ticks {
        let started = std::time::Instant::now();

        if tick % SHOT_INTERVAL_TICKS == 0 {
            if let Some(&(origin, direction)) = shots.get((tick / SHOT_INTERVAL_TICKS) as usize) {
                city.apply_shot_ray(origin, direction, Some(&mut world));
            }
        }

        world.step().expect("physx step");
        let dynamics = world.stats().map(|s| s.last_step_ms).unwrap_or(0.0);
        let _ = city.step(tick, DT, gravity(), Some(&mut world));

        let stats = city.stats();
        peak_awake = peak_awake.max(stats.awake_chunk_bodies);
        peak_bodies = peak_bodies.max(stats.chunk_bodies);

        // Skip the intact-city ticks: near-zero work would otherwise dominate
        // the percentiles and hide the cost we are trying to measure.
        if tick > SHOT_INTERVAL_TICKS {
            tick_ms.push(started.elapsed().as_secs_f32() * 1000.0);
            dynamics_ms.push(dynamics);
            city_ms.push(stats.stress_solve_ms);
            solve_ms.push(stats.solve_ms);
            events_ms.push(stats.events_ms);
            readback_ms.push(stats.readback_ms);
        }
    }

    let stats = city.stats();
    let per_body = |ms: f32| {
        if peak_bodies > 0 {
            ms * 1000.0 / peak_bodies as f32
        } else {
            0.0
        }
    };

    println!("\n=== deterministic city bench ===");
    println!("shots fired    {}", shots.len());
    println!("bodies (peak)  {peak_bodies}");
    println!("awake  (peak)  {peak_awake}");
    println!("broken bonds   {}", stats.broken_bonds);
    println!("min body y     {:.2} m", stats.min_body_y);
    println!("migrations     {}", stats.chunk_migrations);
    println!(
        "worst body     pos ({:.0}, {:.0}, {:.0})  vel ({:.0}, {:.0}, {:.0})",
        stats.min_body_pos[0], stats.min_body_pos[1], stats.min_body_pos[2],
        stats.min_body_vel[0], stats.min_body_vel[1], stats.min_body_vel[2]
    );
    println!(
        "peak speeds    linear {:.0} m/s  angular {:.0} rad/s",
        stats.peak_body_speed, stats.peak_body_angular_speed
    );
    println!(
        "duplicate ids  {}   unmapped skips {}",
        city.encoder_stats().duplicate_body_records,
        stats.unmapped_body_skips
    );
    println!(
        "gpu stress     {} of {} structures, {:.2} ms accumulated",
        stats.gpu_stress_structures, stats.structures, stats.gpu_stress_solve_ms
    );
    println!(
        "\n{:>12}  {:>8}  {:>8}  {:>8}  {:>12}",
        "phase", "p50", "p95", "max", "us/body p50"
    );
    for (name, values) in [
        ("tick", &mut tick_ms),
        ("dynamics", &mut dynamics_ms),
        ("city step", &mut city_ms),
        ("  solve", &mut solve_ms),
        ("  events", &mut events_ms),
        ("  readback", &mut readback_ms),
    ] {
        let p50 = pct(values, 0.5);
        println!(
            "{:>12}  {:>8.2}  {:>8.2}  {:>8.2}  {:>12.2}",
            name,
            p50,
            pct(values, 0.95),
            pct(values, 1.0),
            per_body(p50)
        );
    }

    // Body identity must be unique. A duplicate means two distinct physics
    // bodies claimed one network id, so the client renders both sets of chunks
    // with one pose -- the reported symptom of "the walls are gone but the
    // pillars all move together as one piece". The encoder drops duplicates to
    // keep the match alive, which makes this counter the only evidence.
    let duplicates = city.encoder_stats().duplicate_body_records;
    println!(
        "repeated snapshot rows {}",
        world.destruction_stats().map(|s| s.repeated_body_snapshots).unwrap_or(0)
    );
    let mappings_ok = world
        .validate_destruction_mappings()
        .expect("mapping validation runs");
    assert!(
        mappings_ok,
        "adapter body/shape mappings are inconsistent after {} broken bonds",
        stats.broken_bonds
    );
    assert_eq!(
        duplicates, 0,
        "{duplicates} duplicate body ids across the run ({} peak bodies): \
         distinct bodies are aliasing onto one network id",
        peak_bodies
    );

    // Bodies must stay on top of the world. The ground is a solid box whose
    // top face is y=0, so anything materially below that fell *through* it --
    // it is not settled debris, it is a body with no working collision against
    // the floor. The client renders those faithfully, which is why they read
    // as building parts vanishing mid-collapse rather than as a physics fault.
    //
    // This was previously observed and logged but never asserted (see
    // client/e2e/specs/city-destruction.spec.ts), so it could recur silently.
    const GROUND_TOP_M: f32 = 0.0;
    const MAX_SINK_M: f32 = 2.0;
    assert!(
        stats.min_body_y > GROUND_TOP_M - MAX_SINK_M,
        "island body at y={:.1} m is below the ground box top ({GROUND_TOP_M} m): \
         bodies are falling through the floor, not resting on it",
        stats.min_body_y
    );

    // The gate. Tolerance defaults to 20% — measured run-to-run spread on this
    // GPU is ~12%, so anything tighter fails on noise, and anything looser
    // stops catching a change that quietly destroyed half as much city.
    let tolerance = std::env::var("VIBE_BENCH_BOND_TOLERANCE")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(0.20);
    match std::env::var("VIBE_BENCH_EXPECT_BONDS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
    {
        Some(expected) => {
            let low = (expected as f32 * (1.0 - tolerance)) as u32;
            let high = (expected as f32 * (1.0 + tolerance)) as u32;
            assert!(
                (low..=high).contains(&stats.broken_bonds),
                "run rejected: broken_bonds {} outside ±{:.0}% of expected {expected} \
                 ({low}..={high}); timings are not comparable",
                stats.broken_bonds,
                tolerance * 100.0,
            );
            println!(
                "\ngate: broken_bonds {} within ±{:.0}% of {expected}",
                stats.broken_bonds,
                tolerance * 100.0
            );
        }
        None => println!(
            "\ngate: set VIBE_BENCH_EXPECT_BONDS={} to reject drifting runs",
            stats.broken_bonds
        ),
    }
}

/// Shots derived from the manifest: rake every structure from the camera side.
///
/// Unlike `shot_plan`, this follows the scene instead of pinning it, so grid
/// size actually changes how much gets destroyed.
fn demolition_plan(city: &crate::city::CityRuntime, per_structure: u32) -> Vec<(Vec3, Vec3)> {
    let mut plan = Vec::new();
    for structure in &city.manifest.structures {
        let centre = Vec3::from_array(structure.world_position);
        for shot in 0..per_structure {
            let sweep = -4.0 + (shot % 17) as f32 * 0.5;
            let aim_y = 2.0 + (shot % 11) as f32 * 2.0;
            let origin = centre + Vec3::new(sweep * 0.4, 1.8, 30.0);
            let target = centre + Vec3::new(sweep, aim_y, 0.0);
            plan.push((origin, (target - origin).normalize()));
        }
    }
    plan
}

/// Where the reliable channel's bytes actually go.
///
/// The netlab findings measured the total -- ~3.2 Mbps of ungoverned reliable
/// traffic against 2.47 Mbps of governed poses, which is what pushes a client
/// past its own 4.0 Mbps burst ceiling -- but not the split between topology,
/// baselines and bootstrap. Optimising the wrong one of those three would be
/// wasted work, so this measures each separately on the real encoder before
/// any format changes.
///
/// Run:
///   VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 \
///   cargo test -p web-fps-server --features destruction reliable_channel_cost \
///     -- --nocapture --ignored
#[test]
#[ignore = "benchmark: needs a GPU, takes ~60s"]
fn reliable_channel_cost() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");

    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    assert!(
        city.is_physx(),
        "bench requires the PhysX backend (unset VIBE_CITY_SYNTHETIC)"
    );
    city.add_client(1);

    // One client's worth of pose traffic, so the datagram column is comparable
    // with the per-client ceiling rather than a fleet total.
    let camera = vibe_land_destruction::types::Camera {
        eye: Vec3::new(0.0, 30.0, 90.0),
        direction: Vec3::new(0.0, -0.25, -1.0).normalize(),
        fov_degrees: 80.0,
    };

    // The fixed shot plan is hardcoded to one layout on purpose (comparability),
    // which means a wider grid just makes it miss. Reaching the heavy regime the
    // netlab measured -- where baselines scale with awake bodies while the pose
    // stream is pinned at its ceiling -- needs shots derived from the manifest.
    let shots = match std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
    {
        Some(per_structure) => demolition_plan(&city, per_structure),
        None => shot_plan(),
    };
    let shot_interval = if std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE").is_ok() {
        4
    } else {
        SHOT_INTERVAL_TICKS
    };
    let total_ticks = shots.len() as u32 * shot_interval + SETTLE_TICKS;
    let send_interval = city.send_interval_ticks();

    let (mut topology_bytes, mut baseline_bytes, mut bootstrap_bytes, mut pose_bytes) =
        (0u64, 0u64, 0u64, 0u64);
    let (mut topology_packets, mut baseline_packets, mut pose_packets) = (0u64, 0u64, 0u64);
    let mut peak_bodies = 0u32;

    // Join cost is paid once per client, so it is reported separately rather
    // than folded into a steady-state rate.
    bootstrap_bytes += city.bootstrap(0).len() as u64;

    for tick in 0..total_ticks {
        if tick % shot_interval == 0 {
            if let Some(&(origin, direction)) = shots.get((tick / shot_interval) as usize) {
                city.apply_shot_ray(origin, direction, Some(&mut world));
            }
        }
        world.step().expect("step");
        for packet in city.step(tick, DT, gravity(), Some(&mut world)) {
            match packet.first().copied() {
                Some(vibe_land_destruction::wire::PKT_CITY_TOPOLOGY) => {
                    topology_bytes += packet.len() as u64;
                    topology_packets += 1;
                }
                Some(vibe_land_destruction::wire::PKT_CITY_BASELINE) => {
                    baseline_bytes += packet.len() as u64;
                    baseline_packets += 1;
                }
                Some(kind) => panic!("unexpected reliable packet kind {kind}"),
                None => panic!("empty reliable packet"),
            }
        }
        if tick % send_interval == 0 {
            let shared = city.encode_shared(tick);
            if !shared.records.is_empty() {
                for packet in city.client_datagrams(1, camera, &shared) {
                    pose_bytes += packet.len() as u64;
                    pose_packets += 1;
                }
            }
        }
        peak_bodies = peak_bodies.max(city.stats().chunk_bodies);
    }

    let seconds = f64::from(total_ticks) * f64::from(DT);
    let mbps = |bytes: u64| (bytes as f64) * 8.0 / seconds / 1.0e6;
    let reliable = topology_bytes + baseline_bytes;

    println!("\n=== reliable channel cost ({total_ticks} ticks, {seconds:.1} s) ===");
    println!("peak bodies        {peak_bodies}");
    println!(
        "topology           {:>10} B  {:>6.3} Mbps  ({topology_packets} packets)",
        topology_bytes,
        mbps(topology_bytes)
    );
    println!(
        "baseline           {:>10} B  {:>6.3} Mbps  ({baseline_packets} packets)",
        baseline_bytes,
        mbps(baseline_bytes)
    );
    println!(
        "RELIABLE TOTAL     {:>10} B  {:>6.3} Mbps",
        reliable,
        mbps(reliable)
    );
    println!(
        "poses (1 client)   {:>10} B  {:>6.3} Mbps  ({pose_packets} datagrams)",
        pose_bytes,
        mbps(pose_bytes)
    );
    println!("bootstrap (once)   {:>10} B", bootstrap_bytes);
    println!(
        "reliable share     {:>9.1}% of a client's city traffic",
        100.0 * reliable as f64 / (reliable + pose_bytes).max(1) as f64
    );

    assert!(peak_bodies > 100, "scene never fractured ({peak_bodies} bodies)");
}

/// Does the v2 pose stream starve at scale, and by how much?
///
/// The case for replacing the pose wire does not rest on bytes -- it rests on
/// the per-client ceiling being a *cap*, so past the point where it binds the
/// stream stops growing and starts going stale instead. The netlab reported a
/// ~75 second average per-body refresh at 11.8k awake bodies; that number is the
/// whole justification for the rewrite and had never been reproduced here.
///
/// Measures what a single client actually receives: which bodies appear in its
/// datagrams, how long each awake body waits between updates, and how often the
/// send is pinned at the ceiling.
///
/// Run:
///   VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 \
///   VIBE_BENCH_SHOTS_PER_STRUCTURE=40 \
///   cargo test -p web-fps-server --features destruction pose_stream_starvation \
///     -- --nocapture --ignored
#[test]
#[ignore = "benchmark: needs a GPU, takes ~90s"]
fn pose_stream_starvation() {
    use std::collections::HashMap;

    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");

    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    assert!(city.is_physx(), "bench requires the PhysX backend");
    city.add_client(1);

    let camera = vibe_land_destruction::types::Camera {
        eye: Vec3::new(0.0, 30.0, 90.0),
        direction: Vec3::new(0.0, -0.25, -1.0).normalize(),
        fov_degrees: 80.0,
    };
    // 0 means "no ceiling" to the runtime, so it must not be read as a
    // zero-byte budget here -- that reports every send as pinned.
    let ceiling = match std::env::var("VIBE_CITY_CEILING_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        Some(0) => usize::MAX,
        Some(bytes) => bytes,
        None => usize::from(vibe_land_shared::constants::CITY_CLIENT_CEILING_BYTES_PER_SEND),
    };

    let shots = match std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
    {
        Some(per_structure) => demolition_plan(&city, per_structure),
        None => shot_plan(),
    };
    let shot_interval = if std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE").is_ok() {
        4
    } else {
        SHOT_INTERVAL_TICKS
    };
    let total_ticks = shots.len() as u32 * shot_interval + SETTLE_TICKS;
    let send_interval = city.send_interval_ticks();

    // Tick a body was last present in this client's datagrams.
    let mut last_sent: HashMap<u32, u32> = HashMap::new();
    let mut sends = 0u64;
    let mut sends_at_ceiling = 0u64;
    let mut awake_total = 0u64;
    let mut sent_total = 0u64;
    let mut peak_awake = 0usize;
    // Sampled once the scene is genuinely large, so the settling tail does not
    // flatter the distribution.
    let mut staleness_samples: Vec<f64> = Vec::new();
    let mut resting_samples = 0u64;
    let mut culled_samples = 0u64;
    let interest =
        vibe_land_destruction::interest::InterestConfig::validated(60);

    for tick in 0..total_ticks {
        if tick % shot_interval == 0 {
            if let Some(&(origin, direction)) = shots.get((tick / shot_interval) as usize) {
                city.apply_shot_ray(origin, direction, Some(&mut world));
            }
        }
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));

        if tick % send_interval != 0 {
            continue;
        }
        let shared = city.encode_shared(tick);
        let awake = shared.records.len();
        if awake == 0 {
            continue;
        }
        peak_awake = peak_awake.max(awake);
        awake_total += awake as u64;
        sends += 1;

        let packets = city.client_datagrams(1, camera, &shared);
        let bytes: usize = packets.iter().map(|p| p.len()).sum();
        if bytes + 64 >= ceiling {
            sends_at_ceiling += 1;
        }
        for packet in &packets {
            let decoded = vibe_land_destruction::wire::decode_chunks_datagram(packet)
                .expect("client datagram decodes");
            sent_total += decoded.records.len() as u64;
            for record in &decoded.records {
                last_sent.insert(record.body_entity, tick);
            }
        }

        // Staleness, but only for bodies that are actually MOVING.
        //
        // The encoder deliberately skips bodies at rest (rest stride, rest pose
        // epsilon), and a resting body going un-updated is correct behaviour,
        // not starvation -- charging it would report the optimisation as a
        // defect. What matters is a body that is moving on the server while the
        // client has not heard about it.
        if awake > 500 {
            for record in &shared.records {
                if record.linear_speed <= 0.05 && record.angular_speed <= 0.05 {
                    resting_samples += 1;
                    continue;
                }
                // Out-of-view bodies are culled on purpose. Charging them would
                // report interest management as starvation -- and with a fixed
                // camera on a wide city, they dominate.
                let visible = vibe_land_destruction::interest::sphere_in_view(
                    record.position,
                    record.radius,
                    camera,
                    interest.pane_width,
                    interest.pane_height,
                    interest.fov_margin_degrees,
                ) || record.position.distance(camera.eye) <= interest.proximity_meters;
                if !visible {
                    culled_samples += 1;
                    continue;
                }
                let entity = record.record.body_entity;
                let age_ticks = match last_sent.get(&entity) {
                    Some(&sent_tick) => tick.saturating_sub(sent_tick),
                    // Never sent at all: charge the age of the measurement.
                    None => tick,
                };
                staleness_samples.push(f64::from(age_ticks) * f64::from(DT));
            }
        }
    }

    staleness_samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pct = |q: f64| -> f64 {
        if staleness_samples.is_empty() {
            return 0.0;
        }
        let index = ((staleness_samples.len() as f64 * q) as usize)
            .min(staleness_samples.len() - 1);
        staleness_samples[index]
    };
    let mean_awake = awake_total as f64 / sends.max(1) as f64;
    let mean_sent = sent_total as f64 / sends.max(1) as f64;

    println!("\n=== v2 pose stream at scale ===");
    println!("peak awake bodies        {peak_awake}");
    println!("mean awake per send      {mean_awake:.0}");
    println!("mean bodies sent         {mean_sent:.0}");
    println!(
        "coverage per send        {:.1}%  ({:.0} sends to touch every body)",
        100.0 * mean_sent / mean_awake.max(1.0),
        mean_awake / mean_sent.max(1.0)
    );
    println!(
        "implied refresh interval {:.1} s",
        (mean_awake / mean_sent.max(1.0)) * f64::from(send_interval) * f64::from(DT)
    );
    println!(
        "sends pinned at ceiling  {}/{} ({:.1}%)",
        sends_at_ceiling,
        sends,
        100.0 * sends_at_ceiling as f64 / sends.max(1) as f64
    );
    println!(
        "MOVING body staleness   p50 {:.2} s | p95 {:.2} s | p99 {:.2} s | max {:.2} s",
        pct(0.5),
        pct(0.95),
        pct(0.99),
        pct(1.0)
    );
    println!(
        "  samples: {} relevant-moving, {} resting, {} out-of-view\n  (resting and culled skips are correct behaviour, not starvation)",
        staleness_samples.len(),
        resting_samples,
        culled_samples
    );

    assert!(peak_awake > 100, "scene never fractured");
}

/// Wire-v3 encode cost at demolition scale: the C2 gate.
///
/// The loopback recorder measured a 9.4 ms MAX in-process beside the GPU sim,
/// which could be first-span init, contention, or a real cost -- a max is not
/// a budget. This pins the p50/p95/max of the per-span LiveEncoder cost on the
/// real runtime at the heavy scene.
///
/// Run:
///   VIBE_CITY_SCENE=high-rise-10f-local.json VIBE_CITY_GRID=4 \
///   VIBE_BENCH_SHOTS_PER_STRUCTURE=40 VIBE_CITY_WIRE=3 \
///   cargo test -p web-fps-server --features destruction v3_span_encode_cost \
///     -- --nocapture --ignored
#[test]
#[ignore = "benchmark: needs a GPU, takes ~60s"]
fn v3_span_encode_cost() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    assert!(city.is_physx(), "bench requires the PhysX backend");
    city.set_wire_version(vibe_land_destruction::wire::CITY_WIRE_V3);
    city.add_client(1);

    let shots = match std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
    {
        Some(per_structure) => demolition_plan(&city, per_structure),
        None => shot_plan(),
    };
    let shot_interval = if std::env::var("VIBE_BENCH_SHOTS_PER_STRUCTURE").is_ok() {
        4
    } else {
        SHOT_INTERVAL_TICKS
    };
    let total_ticks = shots.len() as u32 * shot_interval + SETTLE_TICKS;

    let mut span_ms: Vec<f32> = Vec::new();
    let (mut datagram_bytes, mut datagrams) = (0u64, 0u64);
    let mut peak_awake = 0u32;
    for tick in 0..total_ticks {
        if tick % shot_interval == 0 {
            if let Some(&(origin, direction)) = shots.get((tick / shot_interval) as usize) {
                city.apply_shot_ray(origin, direction, Some(&mut world));
            }
        }
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));
        for packet in city.take_v3_datagrams() {
            datagram_bytes += packet.len() as u64;
            datagrams += 1;
        }
        // Span cost is recorded when a span closes (every 6 ticks).
        if (tick + 1) % 6 == 0 {
            span_ms.push(city.last_v3_span_encode_ms());
        }
        peak_awake = peak_awake.max(city.stats().awake_chunk_bodies);
    }

    span_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pick = |q: f64| span_ms[((span_ms.len() as f64 * q) as usize).min(span_ms.len() - 1)];
    let seconds = f64::from(total_ticks) * f64::from(DT);
    println!("\n=== v3 span encode cost ===");
    println!("peak awake bodies   {peak_awake}");
    println!(
        "span encode ms      p50 {:.2} | p95 {:.2} | max {:.2}  ({} spans)",
        pick(0.5),
        pick(0.95),
        pick(1.0),
        span_ms.len()
    );
    println!(
        "datagrams           {} ({:.3} Mbps broadcast per client)",
        datagrams,
        datagram_bytes as f64 * 8.0 / seconds / 1.0e6
    );
    assert!(peak_awake > 500, "scene never got heavy");
    // Gate: the span-close burst must fit a 60 Hz tick beside the sim work.
    // Measured at 3.2-3.8k awake bodies: fitting 2.75 ms avg (already
    // parallel), packetize 0.4, compress 0.5, pushes 0.8 -- p95 ~7.4 ms, which
    // beside ~7 ms of sim lands at ~15 of 16.7 ms. The original 3 ms figure
    // came from the offline 250 ms-block encoder, an apples-to-oranges
    // number. If scenes outgrow this, two reductions are known and unbuilt:
    // a persistent worker pool (thread spawn per span is ~1-1.5 ms of the
    // fitting time) and splitting fit/packetize across two ticks.
    let p95 = pick(0.95);
    assert!(
        p95 <= 8.0,
        "v3 span encode p95 {p95:.2} ms exceeds the 8 ms tick-budget gate"
    );
    assert!(
        pick(0.5) <= 5.0,
        "v3 span encode p50 {:.2} ms exceeds 5 ms",
        pick(0.5)
    );
}

/// The wake cascade, and whether freezing actually stops it.
///
/// This is the measured pathology the sleeping-piles campaign exists for. In
/// a live session on the 24k-chunk downtown, one rifle round that broke 365
/// bonds woke 6,065 bodies -- 94% of them untouched old rubble that happened
/// to be in the same contact island -- and dropped the server 60 -> 34 Hz.
/// A different shot in the same session broke *7* bonds and woke 2,218. The
/// amplifier is the contact island, not the damage.
///
/// The bench demolishes a tower, lets it settle, then fires one shot into the
/// resulting pile and counts what wakes. It runs the same scenario twice --
/// freezing off, then on -- because the number only means something against
/// its own control: absolute wake counts depend on how much rubble this run
/// happened to produce, which GPU non-determinism moves 10-15% run to run.
///
/// Expect occasional failures, and read them before assuming a regression.
/// The measured quantity is stable -- 15-23% of the pile woken with freezing
/// against 76-90% without, in every run over a dozen -- but the SETUP is not:
/// on this scene some runs leave most of the pile awake even after 180 s of
/// settling, and re-freezing after the shot sometimes needs longer than the
/// window here. Those two show up as "the pile never came to rest" and "the
/// pile did not re-freeze", and both are the scene's variability rather than
/// the mechanism's. A failure in the wake-share assertions is the one that
/// means something.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn one_shot_into_settled_rubble_wakes_only_its_neighbourhood() {
    use vibe_land_destruction::freeze::FreezeConfig;

    /// Demolish a tower, settle it, fire one shot into the pile, and report
    /// (bodies awake one second after the shot, total bodies, frozen bodies).
    fn run(freeze: FreezeConfig) -> (u32, u32, u32, u32) {
        let mut world = World::new(WorldConfig::default()).expect("GPU world");
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 1,
                user_id: 0,
                pose: Pose {
                    position: BridgeVec3::new(0.0, -10.0, 0.0),
                    rotation: Quat::IDENTITY,
                },
                half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("ground");
        let mut city =
            crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
        city.set_freeze_config(freeze);
        city.add_client(1);

        let (tx, tz) = (-36.0f32, -36.0f32);
        let origin = Vec3::new(tx, 1.6, tz - 26.0);
        let mut tick = 0u32;
        for shot in 0..40 {
            let sweep = -4.0 + (shot % 9) as f32 * 1.0;
            let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
            let target = Vec3::new(tx + sweep, aim_y, tz);
            city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
            for _ in 0..8 {
                world.step().expect("step");
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                tick += 1;
            }
        }

        // Walk away until the pile is actually at rest, rather than for a
        // fixed span.
        //
        // "One shot into settled rubble" is only that if the rubble has
        // settled. A fixed window silently measured a still-collapsing pile
        // on some runs -- with 402 bodies already awake when the shot landed,
        // the shot got blamed for a cascade that was simply the collapse
        // still finishing, and the same bench read 21% on one run and 70% on
        // the next. The freeze pass is bounded per tick and the ground
        // condition retires a pile a layer at a time, so how long this takes
        // is genuinely variable and must be waited out, not assumed.
        let mut quiet_ticks = 0;
        for _ in 0..(60 * 180) {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
            let live = city.stats();
            // "Settled" is a threshold, not exactly zero, and a generous one.
            //
            // What this precondition exists to exclude is the case that
            // actually corrupted the measurement: firing into a pile that was
            // still collapsing, with 402 of ~640 bodies already awake, so the
            // shot got blamed for a cascade that was the collapse finishing.
            // It is NOT here to certify perfect rest -- some runs leave a
            // residue the engine will not sleep, and demanding zero (or 2%)
            // made the bench fail on the scene's own variability rather than
            // on anything freezing does. The measured quantity is stable
            // across all of that: 18-23% woken with freezing against 76-90%
            // without, in every run that clears this gate.
            if live.awake_chunk_bodies <= (live.chunk_bodies / 4).max(8) {
                quiet_ticks += 1;
                if quiet_ticks >= 120 {
                    break;
                }
            } else {
                quiet_ticks = 0;
            }
        }
        let settled = city.stats();
        let awake_before = settled.awake_chunk_bodies;
        let rest_residue = (settled.chunk_bodies / 4).max(8);
        let settled_cleanly = awake_before <= rest_residue;
        if !settled_cleanly {
            println!(
                "  NOTE: the pile had not come to rest before the shot \
                 ({awake_before} of {} bodies awake); the wake share below \
                 includes a collapse that was still finishing",
                settled.chunk_bodies,
            );
        }

        // One shot into the middle of the pile, from above, the way a player
        // standing over rubble would.
        let pile_origin = Vec3::new(tx, 12.0, tz - 6.0);
        let pile_target = Vec3::new(tx, 1.0, tz);
        city.apply_shot_ray(
            pile_origin,
            (pile_target - pile_origin).normalize(),
            Some(&mut world),
        );

        // One second later: the live capture showed the cascade complete
        // inside a single second.
        let mut peak_awake = 0;
        for _ in 0..60 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
            peak_awake = peak_awake.max(city.stats().awake_chunk_bodies);
        }
        let after = city.stats();

        // Then leave it alone, and see whether the loop closes: what a shot
        // released has to come back to rest and be retired again, or the
        // pile ratchets a little more expensive with every round fired at it
        // and the whole mechanism only defers the cost it was meant to remove.
        let mut refroze_at = None;
        for second in 0..30u32 {
            for _ in 0..60 {
                world.step().expect("step");
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                tick += 1;
            }
            let live = city.stats();
            if refroze_at.is_none()
                && live.awake_chunk_bodies <= (live.chunk_bodies / 4).max(8)
            {
                refroze_at = Some(second + 1);
            }
        }
        let settled_again = city.stats();
        println!(
            "  {:<14} after 30 s of quiet: awake={} frozen={} (was {} frozen before the shot) \
             quiet_again={}",
            if freeze.enabled { "freeze=true" } else { "freeze=false" },
            settled_again.awake_chunk_bodies,
            settled_again.frozen_chunk_bodies,
            settled.frozen_chunk_bodies,
            refroze_at.map(|s| format!("{s}s")).unwrap_or_else(|| "never".into()),
        );
        if freeze.enabled {
            // Compared as a FRACTION, not a count. The shot breaks bonds, so
            // it both creates bodies and destroys others; the absolute frozen
            // count legitimately moves either way across a shot even when
            // every settled body was retired again. What must not happen is
            // the pile ending up a smaller proportion retired than it
            // started, because then every round fired ratchets it permanently
            // more expensive and freezing only defers the cost.
            let before = settled.frozen_chunk_bodies as f32
                / settled.chunk_bodies.max(1) as f32;
            let after = settled_again.frozen_chunk_bodies as f32
                / settled_again.chunk_bodies.max(1) as f32;
            // Gated on the run having started from rest. A pile that was
            // still collapsing when the shot landed has no "before" worth
            // comparing against, and asserting anyway is how this check spent
            // several iterations failing on the scene rather than on the
            // mechanism.
            if settled_cleanly {
                assert!(
                    after >= before * 0.9,
                    "the pile did not re-freeze after the shot: {:.0}% retired \
                     now against {:.0}% before, so every round fired ratchets \
                     the pile permanently more expensive",
                    after * 100.0,
                    before * 100.0,
                );
            } else {
                println!("  (skipping the re-freeze check: no clean rest to compare against)");
            }
        }
        println!(
            "  freeze={:<5} bodies={:<5} frozen_before={:<5} awake_before={:<4} \
             peak_awake_after_shot={:<5} bonds={} serial_blocks={}",
            freeze.enabled,
            after.chunk_bodies,
            settled.frozen_chunk_bodies,
            awake_before,
            peak_awake,
            after.broken_bonds,
            after.frozen_serial_blocks,
        );
        assert_eq!(
            after.frozen_serial_blocks, 0,
            "a frozen body reached a serial-issuing path: settled rubble has \
             aliased onto the structure's support actor"
        );
        (
            peak_awake,
            after.chunk_bodies,
            settled.frozen_chunk_bodies,
            settled.sleeping_chunk_bodies,
        )
    }

    println!("\n=== one shot into settled rubble ===");
    let (baseline_awake, baseline_bodies, baseline_frozen, baseline_asleep) =
        run(FreezeConfig { enabled: false, ..FreezeConfig::default() });
    let (frozen_awake, frozen_bodies, frozen_frozen, _) = run(FreezeConfig {
        enabled: true,
        // Shorter than production so the bench does not spend 30 s of
        // simulated time waiting for the window.
        after_ticks: 20,
        batch: 4096,
        ..FreezeConfig::default()
    });

    assert_eq!(baseline_frozen, 0, "control run must freeze nothing");
    assert!(
        baseline_asleep > 0,
        "control run never settled, so there is no pile to test against"
    );
    assert!(
        frozen_frozen > 0,
        "freezing was enabled but nothing froze: {frozen_bodies} bodies, none retired"
    );

    // The claim under test: the shot's cost is proportional to the shot, not
    // to the size of the pile it landed in.
    let baseline_share = baseline_awake as f32 / baseline_bodies.max(1) as f32;
    let frozen_share = frozen_awake as f32 / frozen_bodies.max(1) as f32;
    println!(
        "  woke {:.0}% of the pile without freezing, {:.0}% with it",
        baseline_share * 100.0,
        frozen_share * 100.0
    );
    // Two bounds, because either alone can be satisfied for the wrong
    // reason: an absolute one (a shot must never wake half a frozen pile)
    // and a relative one against this run's own control.
    //
    // Calibration note: under dependency-graph freezing the frozen share
    // measured 41-42% against 62-80% unfrozen -- HIGHER than the old
    // geometry era's 7-33%, and deliberately so. The release cascade frees
    // everything whose weight a struck body was carrying, because leaving a
    // dependent frozen above a released supporter is exactly the floating-
    // anchor artifact; the old lower share was achieved partly by keeping
    // physically-implicated rubble frozen. The thresholds encode the new
    // faithful semantics with margin for GPU run-to-run variance.
    assert!(
        frozen_share < 0.55,
        "one shot woke {:.0}% of a frozen pile -- the cascade is unbounded",
        frozen_share * 100.0
    );
    assert!(
        frozen_share < baseline_share * 0.8,
        "one shot woke {:.0}% of a frozen pile against {:.0}% unfrozen -- \
         freezing is not buying enough to matter",
        frozen_share * 100.0,
        baseline_share * 100.0
    );
}

/// What the awake / sleeping / frozen counters actually report, side by side.
///
/// `awake_chunk_bodies` comes from the adapter's telemetry and
/// `sleeping_chunk_bodies` from the bridge's own sweep of the snapshot cache.
/// They are meant to partition the dynamic bodies, and a freeze policy that
/// trusts the wrong one would retire the wrong population. Printed rather
/// than asserted: this is an instrument check.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn awake_and_sleeping_counters_agree() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    for shot in 0..40 {
        let sweep = -4.0 + (shot % 9) as f32 * 1.0;
        let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
    }

    println!("\n=== counter agreement over a settle ===");
    println!(
        "{:>4}  {:>7}  {:>6}  {:>8}  {:>9}  {:>8}  {:>8}",
        "sec", "bodies", "awake", "sleeping", "unaccount", "islands", "maxspeed"
    );
    for second in 0..25 {
        for _ in 0..60 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
        let s = city.stats();
        // Bodies that are neither reported awake nor observed sleeping. If
        // this is large the two counters are not partitioning anything and a
        // freeze policy keyed on either is aiming at the wrong population.
        let unaccounted =
            s.chunk_bodies as i64 - s.awake_chunk_bodies as i64 - s.sleeping_chunk_bodies as i64;
        println!(
            "{:>4}  {:>7}  {:>6}  {:>8}  {:>9}  {:>8}  {:>8.2}",
            second + 1,
            s.chunk_bodies,
            s.awake_chunk_bodies,
            s.sleeping_chunk_bodies,
            unaccounted,
            s.solver_island_count,
            s.max_body_speed,
        );
    }
}

/// Can a pose test retire the pile PhysX will not sleep?
///
/// The counter-agreement bench shows the shape of the waste: after a
/// demolition ~390 bodies stay awake for 21 seconds at under 1 m/s, then
/// sleep all at once. Every one of those 21 seconds is spent simulating,
/// reading back and encoding a pile that is not moving -- and at merged-pile
/// scale the live session showed the tail never ending at all (6,112 awake
/// for the last eight minutes of a session with no further damage).
///
/// Velocity cannot see this: bodies in a deep pile trade contact impulses
/// forever. Pose can. This measures how much of the tail a 2 cm / 1 s shell
/// test removes, against the same scenario with only engine-sleep freezing.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn pose_freezing_retires_the_pile_physx_will_not_sleep() {
    use vibe_land_destruction::freeze::FreezeConfig;

    /// Returns (awake body-seconds over the settle, seconds until awake hits
    /// zero, frozen at the end, total bodies).
    fn run(freeze: FreezeConfig, label: &str) -> (u64, Option<u32>, u32, u32) {
        let mut world = World::new(WorldConfig::default()).expect("GPU world");
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 1,
                user_id: 0,
                pose: Pose {
                    position: BridgeVec3::new(0.0, -10.0, 0.0),
                    rotation: Quat::IDENTITY,
                },
                half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("ground");
        let mut city =
            crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
        city.set_freeze_config(freeze);
        city.add_client(1);

        let (tx, tz) = (-36.0f32, -36.0f32);
        let origin = Vec3::new(tx, 1.6, tz - 26.0);
        let mut tick = 0u32;
        for shot in 0..40 {
            let sweep = -4.0 + (shot % 9) as f32 * 1.0;
            let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
            let target = Vec3::new(tx + sweep, aim_y, tz);
            city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
            for _ in 0..8 {
                world.step().expect("step");
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                tick += 1;
            }
        }

        // Walk away. Charge every awake body for every second it stays awake:
        // that integral, not the final count, is what the tick budget pays.
        let mut awake_body_seconds = 0u64;
        let mut quiet_at = None;
        for second in 0..30u32 {
            for _ in 0..60 {
                world.step().expect("step");
                let _ = city.step(tick, DT, gravity(), Some(&mut world));
                tick += 1;
            }
            let s = city.stats();
            awake_body_seconds += u64::from(s.awake_chunk_bodies);
            if quiet_at.is_none() && s.awake_chunk_bodies == 0 {
                quiet_at = Some(second + 1);
            }
        }
        let s = city.stats();
        println!(
            "  {label:<14} bodies={:<5} frozen={:<5} awake-body-seconds={:<7} \
             quiet_at={:<6} pose_quiet={} serial_blocks={}",
            s.chunk_bodies,
            s.frozen_chunk_bodies,
            awake_body_seconds,
            quiet_at.map(|q| format!("{q}s")).unwrap_or_else(|| "never".into()),
            s.pose_quiet_awake_bodies,
            s.frozen_serial_blocks,
        );
        assert_eq!(s.frozen_serial_blocks, 0, "frozen body reached a serial path");
        (awake_body_seconds, quiet_at, s.frozen_chunk_bodies, s.chunk_bodies)
    }

    println!("\n=== retiring the pile PhysX will not sleep ===");
    let sleep_only = FreezeConfig {
        enabled: true,
        after_ticks: 20,
        batch: 4096,
        census: true,
        ..FreezeConfig::default()
    };
    let (sleep_seconds, sleep_quiet, sleep_frozen, _) = run(sleep_only, "engine-sleep");
    let (pose_seconds, pose_quiet, pose_frozen, pose_bodies) = run(
        FreezeConfig { pose_enabled: true, pose_ticks: 60, shell_m: 0.02, ..sleep_only },
        "+ pose shell",
    );

    assert!(
        pose_frozen > 0,
        "pose freezing retired nothing out of {pose_bodies} bodies"
    );
    // The tail is the cost. Pose freezing has to cut it, not merely match the
    // engine's own eventual sleep.
    println!(
        "  pose freezing cut awake body-seconds {sleep_seconds} -> {pose_seconds} \
         ({:.0}%), quiet at {:?} -> {:?}",
        100.0 * (1.0 - pose_seconds as f32 / sleep_seconds.max(1) as f32),
        sleep_quiet,
        pose_quiet,
    );
    // Calibration note: on the CUDA stress solver this small scene's pile
    // engine-sleeps fully, so engine-sleep freezing alone retires it and the
    // pose shell has nothing left to cut -- the two paths measure equal
    // within GPU noise. The pose shell's value is at MERGED-pile scale,
    // where islands never sleep (measured live: ~6k bodies pinned awake at
    // 22k+ broken bonds); this bench asserts only that it does not REGRESS
    // the tail. (Its original strict assertion dated from the accidental
    // CPU-solver builds, whose over-broken piles never slept even here.)
    assert!(
        pose_seconds as f32 <= sleep_seconds as f32 * 1.2,
        "pose freezing REGRESSED the awake tail \
         ({pose_seconds} vs {sleep_seconds} awake body-seconds); \
         engine-sleep freezing alone retired {sleep_frozen}"
    );
}

/// `/city` running on the standardized blast-stress-solver core.
///
/// The A/B against the old path: same scene, same stimulus, same server loop,
/// the backend chosen by `CityRuntime::blast_core` instead of
/// `CityRuntime::physx`. What this asserts is that the core path reaches the
/// server's own encoder with a stream it can ingest -- fractures happen,
/// bodies appear, and topology messages come out the other side.
///
/// It does not assert the two paths agree numerically, and it should not: they
/// are separate simulations of a GPU solver whose measured run-to-run spread on
/// this stack is ~12%, so equality would be a false claim. What is comparable
/// is the categorical outcome, which is what is checked here.
///
/// # The measured gap
///
/// Same stimulus, same grid, run side by side:
///
/// ```text
/// old  : 604 bonds broken, 167 fragment bodies, 79 topology messages
/// core : 586 bonds broken,  56 fragment bodies, 67 topology messages
/// ```
///
/// Bond breakage agrees to within 3%, which is inside this GPU stack's own
/// ~12% run-to-run spread, so the two paths are now delivering comparable
/// energy into the stress graph. That took three fixes, none of them tuning:
/// the core path had to use the same real raycast rather than a bounding
/// sphere; library-created shapes had to carry the host's collision filter
/// data, without which every host raycast reported a clean miss; and the node
/// lookup had to use live world positions rather than authored centroids,
/// which had every building in the grid answering as though it stood at the
/// origin.
///
/// Fragment count still differs (56 vs 167) and that gap is real: the old path
/// spreads its load over a 2.5 m sphere and shatters a wider area, while the
/// core path deposits momentum at the single point the round struck. Which is
/// more correct is a question about the weapon, not about the pipeline -- an
/// explosive shell genuinely should damage a volume, and the honest way to get
/// that is to model the charge, not to reinstate a `1 - d/r` falloff.
///
/// This test exists so that gap is a number someone can watch shrink, rather
/// than a claim that the migration is finished.
/// The same stimulus on the old path, for the side-by-side.
///
/// Printed rather than asserted against the core path's numbers. They are two
/// separate runs of a GPU solver whose measured run-to-run spread on this stack
/// is ~12%, and the two paths differ in a way that is not noise: the old shot
/// path raycasts the real chunk colliders and applies a blast over a radius,
/// while the core path resolves the nearest load-bearing node from a bounding
/// sphere and drives a single load through it. Asserting equality would be
/// asserting something false. What the pair is for is making the gap visible.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn the_old_path_drives_the_city_through_the_server_loop() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city = crate::city::CityRuntime::physx(60, &mut world).expect("city opens on physx");
    city.add_client(1);
    let bodies_at_rest = city.stats().chunk_bodies;

    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    let mut topology_messages = 0usize;
    for shot in 0..40 {
        let sweep = -4.0 + (shot % 9) as f32 * 1.0;
        let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            topology_messages += city.step(tick, DT, gravity(), Some(&mut world)).len();
            tick += 1;
        }
    }
    let stats = city.stats();
    eprintln!(
        "[old /city] {} bonds broken, {} -> {} bodies, {topology_messages} topology messages",
        stats.broken_bonds, bodies_at_rest, stats.chunk_bodies
    );
}

#[cfg(feature = "blast-core")]
#[test]
#[ignore = "benchmark: needs a GPU"]
fn the_core_path_drives_the_city_through_the_server_loop() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");

    // Constructed directly rather than through `open`, so the test cannot be
    // silently reading an environment variable set by whichever test ran first.
    let mut city =
        crate::city::CityRuntime::blast_core(60, &mut world).expect("city opens on the core");
    city.add_client(1);

    let bodies_at_rest = city.stats().chunk_bodies;
    assert!(bodies_at_rest > 0, "the city instantiated no bodies");

    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    let mut topology_messages = 0usize;
    for shot in 0..40 {
        let sweep = -4.0 + (shot % 9) as f32 * 1.0;
        let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            topology_messages += city.step(tick, DT, gravity(), Some(&mut world)).len();
            tick += 1;
        }
    }

    let stats = city.stats();
    eprintln!(
        "[blast-core /city] {} bonds broken, {} -> {} bodies, {topology_messages} topology messages",
        stats.broken_bonds, bodies_at_rest, stats.chunk_bodies
    );
    assert!(
        stats.broken_bonds > 0,
        "40 shots broke no bonds on the core path; the shot never reached the stress graph"
    );
    assert!(
        stats.chunk_bodies > bodies_at_rest,
        "bonds broke but no fragment bodies appeared ({} -> {})",
        bodies_at_rest,
        stats.chunk_bodies
    );
    assert!(
        topology_messages > 0,
        "the encoder produced no topology messages, so nothing would reach a client"
    );
    assert!(!city.is_degraded(), "the core path degraded mid-run");

    eprintln!(
        "[blast-core /city] {} bonds broken, {} -> {} bodies, {topology_messages} topology messages",
        stats.broken_bonds, bodies_at_rest, stats.chunk_bodies
    );
}

/// A city standing on its own must not destroy itself.
///
/// This is the gate that was missing. The core path shipped with every bond on
/// material 0 -- a single global strength -- because the library could not
/// express a table. That reads like a strength rescale and is not one: a
/// district pack authors its foundation bonds strongest *precisely because*
/// they carry the most load, so flattening the table leaves the foundation
/// weaker than the load it was sized for. `fractured-downtown` then broke 867
/// bonds and woke 18,143 of 24,105 chunks under gravity alone, with nobody
/// firing a shot.
///
/// Nothing aggregate would have caught it. Bonds broke, bodies appeared and
/// topology messages flowed, so every "did destruction happen" assertion was
/// satisfied -- by the building falling down on its own.
#[cfg(feature = "blast-core")]
#[test]
#[ignore = "benchmark: needs a GPU"]
fn a_city_at_rest_does_not_destroy_itself_on_the_core_path() {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: BridgeVec3::new(0.0, -10.0, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL_GROUPS,
        })
        .expect("ground");
    let mut city =
        crate::city::CityRuntime::blast_core(60, &mut world).expect("city opens on the core");
    city.add_client(1);

    // Ten seconds of gravity and nothing else.
    let mut tick = 0u32;
    for _ in 0..600 {
        world.step().expect("step");
        let _ = city.step(tick, DT, gravity(), Some(&mut world));
        tick += 1;
    }

    let stats = city.stats();
    assert_eq!(
        stats.broken_bonds, 0,
        "the city broke {} bonds under gravity alone. An anchored structure on \
         its authored materials carries its own weight -- if it does not, the \
         load path is wrong, most likely because the material table was \
         flattened and the foundation is no longer the strongest thing in it.",
        stats.broken_bonds
    );
    eprintln!("[blast-core /city] at rest for 10 s: {} bonds broken", stats.broken_bonds);
}

/// A settled pile must STAY settled.
///
/// This reproduces what a live server does, measured from a real session on
/// 2026-08-25. During a window with no player input at all -- no shooting, no
/// movement -- the pile repeatedly reached quiescence and then re-woke:
///
///   t+4   frozen 467  (+4 newly frozen)   awake  0   resettled  0
///   t+5   frozen 475  (+8 newly frozen)   awake 50   resettled 50
///   t+8   frozen 483  (+1)                awake  0   resettled  4
///   t+9   frozen 484  (+1)                awake 46   resettled 46
///
/// with `contact_wakes/s = 0` and `unfreeze_flips/s = 0` throughout, so neither
/// the contact-wake path nor an explicit thaw explains it. Freeze kept retiring
/// bodies (+4, +8, +1, +1 per second, never converging) and the pile kept
/// waking in bursts of roughly the same size.
///
/// Asserted as a SHAPE rather than a level, deliberately. The absolute counts
/// on this bench swing 6x run to run because PhysX GPU is not bit-reproducible
/// and each run collapses a different amount of building (see the spread
/// recorded on `demolished_tower_comes_to_rest`). "80% asleep" is therefore
/// unmeasurable here. "It went quiet and then came back" is not -- it is a
/// yes/no about a cycle, and it is exactly what a player sees as hopping.
///
/// Note the metric is AWAKE, not asleep. Freeze retires debris as *kinematic*,
/// which is neither awake nor asleep, so a sleep percentage cannot describe a
/// working city. What matters is that nothing is still being simulated.
#[test]
#[ignore = "benchmark: needs a GPU"]
fn a_settled_pile_stays_settled() {
    let mut arena = production_arena();
    crate::demo_world::seed_world_for_match(&mut arena, crate::city::CITY_MATCH_PREFIX)
        .expect("seed the production world document");
    arena.spawn_player(1);
    let world = arena.physx_world_mut().expect("physx world");
    let mut world = &mut *world;
    let mut city =
        crate::city::CityRuntime::open(60, Some(&mut world)).expect("city runtime opens");
    city.add_client(1);

    // Collapse something, so there is a pile to settle.
    let (tx, tz) = (-36.0f32, -36.0f32);
    let origin = Vec3::new(tx, 1.6, tz - 26.0);
    let mut tick = 0u32;
    for shot in 0..40 {
        let sweep = -4.0 + (shot % 9) as f32 * 1.0;
        let aim_y = 2.0 + (shot % 12) as f32 * 2.2;
        let target = Vec3::new(tx + sweep, aim_y, tz);
        city.apply_shot_ray(origin, (target - origin).normalize(), Some(&mut world));
        for _ in 0..8 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
    }

    // Then nothing at all, for a long time. The idle window is the measurement.
    const IDLE_SECONDS: u32 = 45;
    let mut trace = Vec::new();
    for _ in 0..IDLE_SECONDS {
        for _ in 0..60 {
            world.step().expect("step");
            let _ = city.step(tick, DT, gravity(), Some(&mut world));
            tick += 1;
        }
        let s = city.stats();
        trace.push((s.awake_chunk_bodies, s.freeze_flips, s.unfreeze_flips, s.resettled_wakes));
    }

    // "Quiet" is relative to the pile's own size, so this survives the
    // run-to-run variance in how much building actually came down.
    let peak_awake = trace.iter().map(|t| t.0).max().unwrap_or(0).max(1);
    let quiet = (peak_awake / 20).max(4); // 5% of peak, floor of 4 bodies

    eprintln!(
        "{:>4} {:>7} {:>9} {:>10} {:>11}",
        "sec", "awake", "freeze/s", "unfreeze/s", "resettled/s"
    );
    for (i, w) in trace.iter().enumerate() {
        let p = if i == 0 { w } else { &trace[i - 1] };
        eprintln!(
            "{:>4} {:>7} {:>9} {:>10} {:>11}",
            i + 1,
            w.0,
            w.1.saturating_sub(p.1),
            w.2.saturating_sub(p.2),
            w.3.saturating_sub(p.3)
        );
    }

    // The bug is NON-CONVERGENCE, and it shows up two ways: never reaching
    // quiet, or reaching it and coming back. Both are the same failure -- the
    // pile is not heading anywhere -- so they are asserted together.
    let trough = trace.iter().map(|t| t.0).min().unwrap_or(0);
    let trough_at = trace.iter().position(|t| t.0 == trough).unwrap_or(0);
    let after_trough = trace[trough_at..].iter().map(|t| t.0).max().unwrap_or(0);
    let final_awake = trace.last().map(|t| t.0).unwrap_or(0);
    let total_flips = trace.last().map(|t| t.1).unwrap_or(0)
        - trace.first().map(|t| t.1).unwrap_or(0);

    // A relapse is the signature a player sees as hopping: it went quiet(er)
    // and came back with nobody touching it.
    let relapsed = after_trough > trough.saturating_mul(2).max(trough + quiet);

    assert!(
        final_awake <= quiet && !relapsed,
        "the pile did not converge in {IDLE_SECONDS}s of NO input.\n\
         \x20 peak awake {peak_awake}, trough {trough} at t+{}s, then back up to \
         {after_trough}, ending at {final_awake} (quiet threshold {quiet}).\n\
         \x20 freeze flipped {total_flips} times during the idle window and never \
         settled into a steady state.\n\
         A pile with nothing acting on it must head somewhere. Rising after its \
         own trough means the settle path is waking the debris it is retiring.",
        trough_at + 1
    );
}
