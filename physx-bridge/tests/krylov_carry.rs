#![cfg(feature = "native-destruction")]

//! Krylov carry (PhysX BLAST_STRESS_CARRY_KRYLOV; on by default with per-bond
//! rotational stiffness): a warm-started stress solve of an unchanged
//! component under an unchanged load continues the previous solve's PCG
//! recurrence instead of restarting it every tick.
//!
//! Two properties, on a cantilever of thin joints whose solve with rotational
//! stiffness does not converge within one tick at a 16-iteration cap:
//!
//! 1. The answer is the same. At rest, the carried solve's bond stresses
//!    match a cold solve converged at 4096 iterations, and it converges in no
//!    more ticks than the restarted solve.
//! 2. A changing load disables it. Tick 2 starts from the same warm forces in
//!    a carried and a restarted run (tick 1 is cold in both). Under a static
//!    load its first step differs (the carry engaged: a polynomial step
//!    continuing the recurrence); with a ball landing on the tip it must be
//!    the restarted run's projected steepest-descent step, because the carry
//!    declines a load that moved by more than the solve tolerance.
//!
//! The carry mode is read once per process, so each run is a child process
//! of this test binary (KRYLOV_CHILD).
//!
//! VIBE_GPU_SHARED=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test krylov_carry -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, DynamicSphereDesc, NativeConfig, Pose, Quat,
    StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const SEGMENTS: usize = 12;
const LENGTH: f32 = 0.3; // each segment
const JOINT: f32 = 0.03; // the square joint patch between segments (m)

/// One run: prints `TICK k iterations reason h0 h1` per tick (the beam's solve
/// report) and `ROW bond normal bend shear` for the final bond stresses.
fn child(mode: &str, cap: u32, ticks: u32) {
    let joint = JOINT;
    stage_env::product();
    std::env::set_var("VIBE_SECTION_BENDING", "1");
    std::env::set_var("VIBE_SECTION_ROTATION", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let mut nodes = vec![ChunkNodeDesc {
        node_index: 0,
        centroid: Vec3::new(-0.1, 0.0, 0.0),
        mass: 0.0,
        volume: 0.008,
        geom_kind: 0,
        half_extents: Vec3::new(0.1, 0.1, 0.1),
        convex_points: Vec::new(),
        material: 0,
    }];
    let mut bonds = Vec::new();
    for i in 0..SEGMENTS {
        let x = (i as f32 + 0.5) * LENGTH;
        nodes.push(ChunkNodeDesc {
            node_index: i as u32 + 1,
            centroid: Vec3::new(x, 0.0, 0.0),
            mass: 20.0,
            volume: LENGTH * 0.1 * 0.1,
            geom_kind: 0,
            half_extents: Vec3::new(LENGTH / 2.0, 0.05, 0.05),
            convex_points: Vec::new(),
            material: 0,
        });
        bonds.push(ChunkBondDesc {
            bond_index: i as u32,
            node0: i as u32,
            node1: i as u32 + 1,
            centroid: Vec3::new(i as f32 * LENGTH, 0.0, 0.0),
            normal: Vec3::new(1.0, 0.0, 0.0),
            area: joint * joint,
            material: 0,
        });
    }
    let strong = StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 1e12, tension_elastic: 1e12, tension_fatal: 1e12,
        shear_elastic: 1e12, shear_fatal: 1e12, elastic_modulus: 11e9, residual_area_fraction: 0.0,
    };
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: cap,
        materials: vec![strong],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world
        .native_create_destructible(0, Pose { position: Vec3::new(0.0, 5.0, 0.0), rotation: Quat::IDENTITY },
            &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK)
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: cap, tolerance: 1e-3, force_tolerance: 1e-3, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    world.native_set_stress_solve_report(1).unwrap();
    for k in 0..ticks {
        if mode == "ball" && k == 0 {
            // 40 kg released 5 mm above the tip: it lands in the first ticks,
            // while the beam's solve is still converging.
            world
                .add_dynamic_sphere(DynamicSphereDesc {
                    entity_id: 900, user_id: 900,
                    pose: Pose { position: Vec3::new((SEGMENTS as f32 - 0.5) * LENGTH, 5.0 + 0.05 + 0.1 + 0.005, 0.0), rotation: Quat::IDENTITY },
                    radius: 0.1, mass: 40.0, collision_group: GROUP_CHUNK, collision_mask: GROUP_CHUNK,
                })
                .unwrap();
        }
        world.step().unwrap();
        world.native_tick().unwrap();
        let report = world.native_stress_solve_report().unwrap();
        if let Some(c) = report.components.iter().find(|c| c.anchored && c.chunk_count as usize == SEGMENTS) {
            println!("TICK {k} {} {} {:e} {:e}", c.iterations, c.reason, c.history[0], c.history[1]);
        }
    }
    for r in world.native_bond_stress_rows(0).unwrap() {
        println!("ROW {} {:e} {:e} {:e}", r.bond_index, r.stress_normal, r.stress_bend, r.shear);
    }
}

#[test]
#[ignore = "child process of the krylov_carry tests"]
fn krylov_child() {
    let Ok(spec) = std::env::var("KRYLOV_CHILD") else { return };
    let parts: Vec<&str> = spec.split(',').collect();
    child(parts[0], parts[1].parse().unwrap(), parts[2].parse().unwrap());
}

struct Run {
    ticks: Vec<(u32, u32, f64, f64)>, // iterations, reason, h0, h1
    rows: Vec<[f64; 3]>,
}

fn run(mode: &str, cap: u32, ticks: u32, carry: &str) -> Run {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "krylov_child", "--ignored", "--nocapture", "--test-threads=1"])
        .env("KRYLOV_CHILD", format!("{mode},{cap},{ticks}"))
        .env("BLAST_STRESS_CARRY_KRYLOV", carry)
        .output()
        .expect("child run");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "child {mode} cap {cap} carry {carry} failed:\n{text}\n{}", String::from_utf8_lossy(&out.stderr));
    let mut run = Run { ticks: Vec::new(), rows: Vec::new() };
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.first() {
            Some(&"TICK") => run.ticks.push((f[2].parse().unwrap(), f[3].parse().unwrap(), f[4].parse().unwrap(), f[5].parse().unwrap())),
            Some(&"ROW") => run.rows.push([f[2].parse().unwrap(), f[3].parse().unwrap(), f[4].parse().unwrap()]),
            _ => {}
        }
    }
    run
}

/// First tick from which every solve converged (reason 1 or 6, settled).
fn settled_from(run: &Run) -> Option<usize> {
    (0..run.ticks.len()).find(|&k| run.ticks[k..].iter().all(|t| t.1 == 1 || t.1 == 6))
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS"]
fn carried_solve_matches_cold_solve() {
    let truth = run("static", 4096, 3, "0");
    let carried = run("static", 16, 120, "1");
    let restarted = run("static", 16, 120, "0");
    let (c, r) = (settled_from(&carried), settled_from(&restarted));
    println!("converged from tick: carried {c:?}, restarted {r:?} (cap 16)");
    assert_eq!(truth.rows.len(), SEGMENTS);
    let peak = truth.rows.iter().flat_map(|r| r.iter().map(|v| v.abs())).fold(0.0, f64::max);
    let worst = truth.rows.iter().zip(&carried.rows)
        .flat_map(|(t, c)| (0..3).map(move |i| (t[i] - c[i]).abs()))
        .fold(0.0, f64::max) / peak;
    println!("carried vs cold (4096 iterations): largest stress difference {worst:.2e} of the peak {peak:.3e} Pa");
    // Both stop at the force tolerance, 1e-3 of the bond forces.
    assert!(worst <= 5e-3, "the carried solve's stresses differ from the converged answer by {worst:.2e} of the peak");
    let c = c.expect("the carried solve never converged at rest");
    assert!(r.map_or(true, |r| c <= r), "the carried solve converged later ({c}) than the restarted one ({r:?})");
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS"]
fn changing_load_disables_the_carry() {
    // Tick 1 is a cold solve in every run, so tick 2 starts from the same
    // warm forces in a carried and a restarted run, and its first step tells
    // them apart: a projected steepest-descent step restarted, a polynomial
    // step continuing the recurrence when carried.
    let close = |x: f64, y: f64| (x - y).abs() <= 1e-2 * x.abs().max(y.abs());
    let k = 1; // tick 2
    let (carried, restarted) = (run("static", 16, 3, "1"), run("static", 16, 3, "0"));
    let (a, b) = (carried.ticks[k], restarted.ticks[k]);
    println!("static load, tick 2: carried h0 {:.4e} h1 {:.4e}; restarted h0 {:.4e} h1 {:.4e}", a.2, a.3, b.2, b.3);
    assert!(close(a.2, b.2), "tick 2 did not start from the same warm forces");
    assert!(!close(a.3, b.3), "the carry did not engage under a static load (the test would prove nothing)");
    // A ball landing on the tip changes the load: the carry declines it.
    let (carried, restarted) = (run("ball", 16, 3, "1"), run("ball", 16, 3, "0"));
    let (a, b) = (carried.ticks[k], restarted.ticks[k]);
    println!("ball landing, tick 2: carried h0 {:.4e} h1 {:.4e}; restarted h0 {:.4e} h1 {:.4e}", a.2, a.3, b.2, b.3);
    assert!(close(a.2, b.2) && close(a.3, b.3), "the carried run did not restart under a changing load");
}
