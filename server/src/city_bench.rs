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
const GRAVITY: [f32; 3] = [0.0, -9.81, 0.0];

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
            half_extents: BridgeVec3::new(160.0, 10.0, 160.0),
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
            let _ = city.step(tick, DT, GRAVITY, Some(&mut world));
            tick += 1;
        }
    }
    for _ in 0..600 {
        world.step().expect("step");
        let _ = city.step(tick, DT, GRAVITY, Some(&mut world));
        tick += 1;
    }

    let stats = city.stats();
    println!("\n=== severed upper half ===");
    println!("broken bonds   {}", stats.broken_bonds);
    println!("chunk bodies   {}", stats.chunk_bodies);
    println!("min body y     {:.2} m", stats.min_body_y);

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
            half_extents: BridgeVec3::new(160.0, 10.0, 160.0),
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
        let _ = city.step(tick, DT, GRAVITY, Some(&mut world));

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
