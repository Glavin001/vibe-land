#![cfg(feature = "native-destruction")]

//! Fudges removed in the high-fidelity profile, each against a closed-form
//! answer, on the native GPU stage at the shipping solver settings.
//! See docs/verification/FIDELITY_AUDIT.md.
//!
//! VIBE_BOND_TRUE_STIFFNESS=1: a bond's stress-solve stiffness is E A / L at
//! its own area and spring length. The runtime floors the area at 1e-4 m^2
//! and the length at 0.05 m. Two statically indeterminate structures, whose
//! load sharing is set by the bonds' relative stiffness, show what the floors
//! cost; a third, where no floor binds, shows the flag changes nothing else:
//!
//! 1. Parallel bars (Gere & Goodno, Mechanics of Materials, 8th ed., 2.4:
//!    bars in parallel share a load in proportion to E A / L, so bars of one
//!    material and length carry one stress, sigma = W / sum A). Three bonds
//!    of one spring length hold a block: 2 cm^2 either side of a 0.4 cm^2
//!    sliver.
//! 2. A bar fixed at both ends, loaded between them (Hibbeler, Mechanics of
//!    Materials, 10th ed., 4.4, Example 4.5: R_A = P L_CB / L, R_B = P L_AC / L).
//!    A block between two anchors whose centres are 3 cm above and 9 cm below
//!    its own: the upper bond carries 3/4 of the weight in tension, the lower
//!    1/4 in compression.
//! 3. The same bar at 30 / 90 cm: no floor binds, and the two profiles must
//!    give the same stresses bit for bit.
//!
//! VIBE_NATIVE_UNCAPPED_SPIN=1: native bodies keep the SDK's numeric range
//! for angular velocity instead of PhysX's default 100 rad/s clamp.
//!
//! 4. A free rod struck off-centre (Hibbeler, Dynamics, 14th ed., 19.2-19.4:
//!    v = J / m, omega = J d / I, so omega / v = m d / I for any impulse, and
//!    omega stays constant once the strike is over). The runtime clips the
//!    spin; uncapped, the rod spins at the textbook's rate.
//!
//! Each profile runs in its own process (the bridge reads its flags once):
//! the test re-executes itself, once as the runtime (which must still show
//! the fudges' answers, so the default is unchanged) and once with
//! VIBE_BOND_TRUE_STIFFNESS=1 VIBE_NATIVE_UNCAPPED_SPIN=1 (which must give
//! the textbook's).
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... CARGO_TARGET_DIR=... cargo test \
//!   -p vibe-land-physx-bridge --features native-destruction \
//!   --test fidelity_audit -- --ignored --test-threads=1 --nocapture

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, RoundDesc, StressMaterialDesc, Vec3,
    World, WorldConfig, DEFAULT_WORLD_GRAVITY,
};

const GROUP_CHUNK: u32 = 1 << 5;
/// Production stress settings (destruction/src/native_runtime.rs, fleet cap).
const STRESS_ITERATIONS: u32 = 64;
const STRESS_TOLERANCE: f32 = 1e-3;
const ARM: &str = "FIDELITY_AUDIT_ARM";
const UP: [f32; 3] = [0.0, 1.0, 0.0];
/// The fixed-fixed bar's bond area: 2 cm square, so its contact length
/// sqrt(A) = 2 cm stays under both spring lengths (the high-fidelity profile
/// takes L = max(distance, sqrt(A)), K. L. Johnson, Contact Mechanics, 3.8).
const BAR_AREA: f32 = 4e-4;

struct Chunk {
    center: [f32; 3],
    half: [f32; 3],
    mass: f32,
}
struct Bond {
    a: u32,
    b: u32,
    centroid: [f32; 3],
    normal: [f32; 3],
    area: f32,
}

fn v(a: [f32; 3]) -> Vec3 {
    Vec3::new(a[0], a[1], a[2])
}

/// Solve a structure of boxes joined by horizontal bonds (normal +y) under
/// gravity until the stage reports the stress solve converged, and return
/// each bond's normal stress (Pa, tension +).
fn solve(chunks: &[Chunk], bonds: &[Bond]) -> Vec<f32> {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let nodes: Vec<ChunkNodeDesc> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| ChunkNodeDesc {
            node_index: i as u32,
            centroid: v(c.center),
            mass: c.mass,
            volume: 8.0 * c.half[0] * c.half[1] * c.half[2],
            geom_kind: 0,
            half_extents: v(c.half),
            convex_points: Vec::new(),
            material: 0,
        })
        .collect();
    let descs: Vec<ChunkBondDesc> = bonds
        .iter()
        .enumerate()
        .map(|(k, b)| ChunkBondDesc {
            bond_index: k as u32,
            node0: b.a,
            node1: b.b,
            centroid: v(b.centroid),
            normal: v(b.normal),
            area: b.area,
            material: 0,
        })
        .collect();
    // Steel that never yields: a statics case.
    let never = 1e13f32;
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: STRESS_ITERATIONS,
        materials: vec![StressMaterialDesc {
            compression_elastic: never,
            compression_fatal: never,
            tension_elastic: never,
            tension_fatal: never,
            shear_elastic: never,
            shear_fatal: never,
            elastic_modulus: 200e9,
            residual_area_fraction: 0.0,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world
        .native_create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 20.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } },
            &nodes,
            &descs,
            settings,
            GROUP_CHUNK,
            GROUP_CHUNK,
        )
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: STRESS_ITERATIONS,
            tolerance: STRESS_TOLERANCE,
            force_tolerance: 0.0,
            warm_start: true,
            damage_rate: 2.0,
            bend_gain_max: 3.0,
            fibre_bending: true,
            reserved_contact_pairs: 64,
            preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true,
            verdict_sample_ticks: 1,
        })
        .unwrap();
    let mut converged_at = None;
    for t in 1..=600u32 {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        assert!(world.native_take_broken_bonds().unwrap().is_empty(), "a statics case broke bonds");
        if status.converged && status.observed {
            converged_at = Some(t);
            break;
        }
    }
    let t = converged_at.expect("the stress solve converged within 600 ticks");
    let mut rows = world.native_bond_stress_rows(0).unwrap();
    rows.sort_by_key(|r| r.bond_index);
    assert_eq!(rows.len(), bonds.len());
    println!("  converged at tick {t}");
    rows.iter().map(|r| r.stress_normal).collect()
}

/// Case 1: a 1 t block held from above by three bonds of equal spring
/// length (each to its own anchor, centre 0.25 m from the block's), a 2 cm^2
/// pair either side of a 0.4 cm^2 sliver. Supports' bonds are sprung at their
/// centroids, so with the block translating only (symmetry) each bond is a
/// bar of stiffness E A / 0.25 m.
fn parallel_bonds() -> (Vec<Chunk>, Vec<Bond>, [f32; 3]) {
    const BIG: f32 = 2e-4;
    const SLIVER: f32 = 4e-5;
    let areas = [BIG, SLIVER, BIG];
    let mut chunks = vec![Chunk { center: [0.0, 0.0, 0.0], half: [0.5, 0.05, 0.1], mass: 1000.0 }];
    let mut bonds = Vec::new();
    for (i, area) in areas.iter().enumerate() {
        let x = 0.3 * (i as f32 - 1.0);
        let (ax, ay) = (0.15 * (i as f32 - 1.0), (0.25f32 * 0.25 - 0.0225 * (i as f32 - 1.0).abs()).sqrt());
        chunks.push(Chunk { center: [ax, ay, 0.0], half: [0.02, 0.02, 0.02], mass: 0.0 });
        bonds.push(Bond { a: chunks.len() as u32 - 1, b: 0, centroid: [x, 0.05, 0.0], normal: UP, area: *area });
    }
    (chunks, bonds, areas)
}

/// Cases 2 and 3: a 1 t block between two anchors, the upper one `up` above
/// the block's centre and the lower `down` below it. Bond 0 is the upper,
/// bond 1 the lower.
fn fixed_fixed(up: f32, down: f32) -> (Vec<Chunk>, Vec<Bond>) {
    let h = 0.02;
    let chunks = vec![
        Chunk { center: [0.0, 0.0, 0.0], half: [0.05, h, 0.05], mass: 1000.0 },
        Chunk { center: [0.0, up, 0.0], half: [0.05, up - h, 0.05], mass: 0.0 },
        Chunk { center: [0.0, -down, 0.0], half: [0.05, down - h, 0.05], mass: 0.0 },
    ];
    let bonds = vec![
        Bond { a: 1, b: 0, centroid: [0.0, h, 0.0], normal: UP, area: BAR_AREA },
        Bond { a: 0, b: 2, centroid: [0.0, -h, 0.0], normal: UP, area: BAR_AREA },
    ];
    (chunks, bonds)
}

/// Case 4: a free 1 kg rod, 1 m x 5 cm x 5 cm (two bonded halves), struck
/// broadside 0.4 m from its centre by a 20 kg round at 100 m/s. Returns
/// (|omega_y|, v_z) of the rod for 30 ticks after the strike.
fn struck_rod() -> Vec<(f32, f32)> {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let nodes: Vec<ChunkNodeDesc> = [-0.25f32, 0.25]
        .iter()
        .enumerate()
        .map(|(i, &x)| ChunkNodeDesc {
            node_index: i as u32,
            centroid: Vec3::new(x, 0.0, 0.0),
            mass: 0.5,
            volume: 0.5 * 0.05 * 0.05,
            geom_kind: 0,
            half_extents: Vec3::new(0.25, 0.025, 0.025),
            convex_points: Vec::new(),
            material: 0,
        })
        .collect();
    let bonds = [ChunkBondDesc {
        bond_index: 0,
        node0: 0,
        node1: 1,
        centroid: Vec3::new(0.0, 0.0, 0.0),
        normal: Vec3::new(1.0, 0.0, 0.0),
        area: 0.0025,
        material: 0,
    }];
    let never = 1e13f32;
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: STRESS_ITERATIONS,
        materials: vec![StressMaterialDesc {
            compression_elastic: never,
            compression_fatal: never,
            tension_elastic: never,
            tension_fatal: never,
            shear_elastic: never,
            shear_fatal: never,
            elastic_modulus: 200e9,
            residual_area_fraction: 0.0,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        // The city's debris damping (city_config debris_damping: none).
        linear_damping: 0.0,
        angular_damping: 0.0,
        ..DestructibleSettings::default()
    };
    world
        .native_create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 20.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            GROUP_CHUNK,
        )
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: STRESS_ITERATIONS,
            tolerance: STRESS_TOLERANCE,
            force_tolerance: 0.0,
            warm_start: true,
            damage_rate: 2.0,
            bend_gain_max: 3.0,
            fibre_bending: true,
            reserved_contact_pairs: 64,
            preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true,
            verdict_sample_ticks: 1,
        })
        .unwrap();
    // The round's front starts 1 cm into the rod's -z face (RoundDesc
    // position is the hit point; the bridge seats the sphere radius + 5 cm
    // behind it), so the first step's contact catches it.
    world
        .native_fire_round(RoundDesc {
            position: Vec3::new(0.4, 20.0, -0.025 + 0.06),
            direction: Vec3::new(0.0, 0.0, 1.0),
            momentum_ns: 20.0 * 100.0,
            radius: 0.05,
            speed: 100.0,
            ttl_ticks: 3,
        })
        .unwrap();
    let mut out = Vec::new();
    for t in 0..34 {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        assert!(world.native_take_broken_bonds().unwrap().is_empty(), "the rod broke");
        if t < 4 {
            continue;
        }
        let rods: Vec<(f32, f32)> = world
            .native_chunk_body_snapshots()
            .unwrap()
            .iter()
            .filter(|b| !b.kinematic)
            .map(|b| (b.angular_velocity.y.abs(), b.linear_velocity.z))
            .collect();
        assert_eq!(rods.len(), 1, "one rod body");
        out.push(rods[0]);
    }
    out
}

fn run_arm(arm: &str, env: &[(&str, &str)]) -> String {
    let exe = std::env::current_exe().expect("test binary path");
    let mut command = std::process::Command::new(exe);
    command.args(["--exact", "arm", "--nocapture", "--ignored", "--test-threads=1"]).env(ARM, arm);
    command.env_remove("VIBE_BOND_TRUE_STIFFNESS");
    for (k, val) in env {
        command.env(k, val);
    }
    let output = command.output().expect("spawn arm");
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "arm {arm} failed:\n{text}");
    text
}

fn reported(text: &str, key: &str) -> Vec<f32> {
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{key}=")))
        .unwrap_or_else(|| panic!("arm did not report {key}:\n{text}"));
    line.split(',').map(|x| x.trim().parse().expect("number")).collect()
}

/// One profile's solves; reports raw stresses (exact float text) for the
/// parent to judge.
#[test]
#[ignore = "spawned by bond_stiffness_floors"]
fn arm() {
    if std::env::var(ARM).is_err() {
        return;
    }
    let show = |k: &str, s: &[f32]| println!("{k}={}", s.iter().map(|x| format!("{x:e}")).collect::<Vec<_>>().join(","));
    let (c, b, _) = parallel_bonds();
    show("parallel", &solve(&c, &b));
    let (c, b) = fixed_fixed(0.03, 0.09);
    show("short", &solve(&c, &b));
    let (c, b) = fixed_fixed(0.30, 0.90);
    show("long", &solve(&c, &b));
    let rod = struck_rod();
    show("rod_spin", &rod.iter().map(|r| r.0).collect::<Vec<_>>());
    show("rod_vz", &rod.iter().map(|r| r.1).collect::<Vec<_>>());
}

#[test]
#[ignore = "requires the native GPU destruction SDK"]
fn bond_stiffness_floors() {
    let runtime = run_arm("runtime", &[]);
    let exact = run_arm("true-stiffness", &[("VIBE_BOND_TRUE_STIFFNESS", "1"), ("VIBE_NATIVE_UNCAPPED_SPIN", "1")]);
    let w = 1000.0 * DEFAULT_WORLD_GRAVITY;
    let rel = |a: f32, b: f32| ((a - b) / b).abs();
    let mut failures = Vec::new();
    let mut check = |what: &str, got: f32, want: f32, tol: f32| {
        let e = rel(got, want);
        println!("  {what:<58} {got:>12.5e} want {want:>12.5e}  err {:.3}%", 100.0 * e);
        if !(e <= tol) {
            failures.push(format!("{what}: {got:e} vs {want:e}"));
        }
    };

    // 1. Parallel bonds. True stiffness: one stress, W / sum A (the
    // textbook). Runtime: the same bars with the sliver's area floored to
    // 1e-4 m^2 (the fudge, documented, unchanged).
    let (_, _, areas) = parallel_bonds();
    let total: f32 = areas.iter().sum();
    let floored: f32 = areas.iter().map(|a| a.max(1e-4)).sum();
    println!("parallel bars (Gere & Goodno 2.4): one stress, sigma = W / sum A");
    let (r, x) = (reported(&runtime, "parallel"), reported(&exact, "parallel"));
    for i in 0..3 {
        check(&format!("runtime: bar {i} (floored: W A_f / sum A_f / A)"), r[i], w * areas[i].max(1e-4) / floored / areas[i], 0.01);
        check(&format!("true stiffness: bar {i} (W / sum A)"), x[i], w / total, 0.01);
    }
    println!("  sliver / outer stress: runtime {:.3} (floored 2.5), true stiffness {:.3} (textbook 1)", r[1] / r[0], x[1] / x[0]);

    // 2. Fixed-fixed bar, centres 3 cm up and 9 cm down.
    let (r, x) = (reported(&runtime, "short"), reported(&exact, "short"));
    let a = BAR_AREA;
    println!("fixed-fixed bar, 3 / 9 cm (Hibbeler 4.4): upper 3/4 W tension, lower 1/4 W compression");
    // Runtime: the 3 cm spring is read as 5 cm, so the upper bond takes
    // (1/0.05) / (1/0.05 + 1/0.09) = 9/14 of the load.
    check("runtime: upper bond share (floored: 9/14)", r[0] * a / w, 9.0 / 14.0, 0.01);
    check("true stiffness: upper bond tension", x[0], 0.75 * w / a, 0.01);
    check("true stiffness: lower bond compression", -x[1], 0.25 * w / a, 0.01);

    // 3. No floor binds: identical bits.
    let (r, x) = (reported(&runtime, "long"), reported(&exact, "long"));
    println!("fixed-fixed bar, 30 / 90 cm: no floor binds, profiles agree bit for bit");
    check("both: upper bond tension", x[0], 0.75 * w / a, 0.01);
    assert_eq!(r, x, "the flag changed a structure no floor touches");

    // 4. Eccentric impact on a free rigid body (Hibbeler, Engineering
    // Mechanics: Dynamics, 14th ed., 19.2-19.4): an impulse J at offset d
    // from the centre of mass gives v = J / m and omega = J d / I, so
    // omega / v = m d / I whatever J was, and with no torque after the strike
    // omega stays constant (Euler's equations about a principal axis).
    let i_y = 2.0 * (0.5 * (0.5f32 * 0.5 + 0.05 * 0.05) / 12.0 + 0.5 * 0.25 * 0.25);
    let ratio = 1.0 * 0.4 / i_y;
    let (rs, rv) = (reported(&runtime, "rod_spin"), reported(&runtime, "rod_vz"));
    let (xs, xv) = (reported(&exact, "rod_spin"), reported(&exact, "rod_vz"));
    println!("struck rod (Hibbeler 19.2-19.4): omega / v = m d / I = {ratio:.4} 1/m");
    let max_r = rs.iter().cloned().fold(0.0f32, f32::max);
    println!("  runtime: peak spin {max_r:.2} rad/s (PhysX's default cap 100)");
    check("runtime: peak spin within PhysX's default cap (<= 100)", max_r.max(100.0), 100.0, 1e-5);
    check("uncapped: omega / v_cm", xs[0] / xv[0], ratio, 0.01);
    check("uncapped: omega 30 ticks later (constant)", xs[xs.len() - 1], xs[0], 1e-3);
    println!("  runtime omega / v_cm = {:.4} ({:.1}% of the textbook's)", rs[0] / rv[0], 100.0 * rs[0] / rv[0] / ratio);
    assert!(xs[0] > 100.0, "the strike did not spin the rod past the cap ({} rad/s): the case shows nothing", xs[0]);

    assert!(failures.is_empty(), "{failures:#?}");
}

