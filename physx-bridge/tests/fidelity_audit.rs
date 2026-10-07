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
    World, WorldConfig, DEFAULT_WORLD_GRAVITY, DynamicBoxDesc, StaticBoxDesc, FIXED_TIMESTEP,
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


/// A 20 cm cube released from rest on a 30 degree incline, friction 0.5 (the
/// world's): distance slid down the slope after `ticks`.
fn incline_slide(ticks: u32) -> f32 {
    let theta = 30f32.to_radians();
    let q = Quat { x: 0.0, y: 0.0, z: (theta / 2.0).sin(), w: (theta / 2.0).cos() };
    // The plane's +x runs uphill, (cos, sin); its normal is (-sin, cos).
    let (t, n) = ([theta.cos(), theta.sin()], [-theta.sin(), theta.cos()]);
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 1,
            pose: Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: q },
            half_extents: Vec3::new(5.0, 0.1, 1.0),
            collision_group: 1,
            collision_mask: u32::MAX,
        })
        .unwrap();
    let lift = 0.1 + 0.1 + 0.0005;
    let start = [n[0] * lift, n[1] * lift];
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 2,
            user_id: 2,
            pose: Pose { position: Vec3::new(start[0], start[1], 0.0), rotation: q },
            half_extents: Vec3::new(0.1, 0.1, 0.1),
            mass: 8.0,
            collision_group: 1,
            collision_mask: u32::MAX,
        })
        .unwrap();
    for _ in 0..ticks {
        world.step().unwrap();
    }
    let b = world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == 2).expect("block");
    let d = [b.pose.position.x - start[0], b.pose.position.y - start[1]];
    -(d[0] * t[0] + d[1] * t[1])
}

/// Scene stabilization (PxSceneFlag::eENABLE_STABILIZATION, on unless
/// VIBE_PHYSX_STABILIZATION=0): PhysX damps and scales gravity on slow bodies
/// in contact. A block sliding from rest is slow for its first second, so it
/// is a measurable fudge. Textbook (Hibbeler, Dynamics, 14th ed., 13.4): a
/// block on an incline steeper than its friction angle accelerates at
/// a = g (sin theta - mu cos theta); s = a t^2 / 2.
#[test]
#[ignore = "requires the GPU PhysX scene"]
fn stabilization_on_an_incline() {
    let ticks = 60u32;
    let time = ticks as f32 * FIXED_TIMESTEP;
    let theta = 30f32.to_radians();
    let a = DEFAULT_WORLD_GRAVITY * (theta.sin() - 0.5 * theta.cos());
    let textbook = 0.5 * a * time * time;
    std::env::remove_var("VIBE_PHYSX_STABILIZATION");
    let on = incline_slide(ticks);
    std::env::set_var("VIBE_PHYSX_STABILIZATION", "0");
    let off = incline_slide(ticks);
    std::env::remove_var("VIBE_PHYSX_STABILIZATION");
    println!("block on a 30 degree incline, mu 0.5, {time:.2} s (Hibbeler 13.4): s = a t^2/2 = {textbook:.4} m");
    println!("  stabilization on (runtime):  {on:.4} m ({:+.1}%)", 100.0 * (on - textbook) / textbook);
    println!("  stabilization off:           {off:.4} m ({:+.1}%)", 100.0 * (off - textbook) / textbook);
    // PhysX patch friction slides ~2% further than Coulomb at mu 0.5 here.
    assert!(((off - textbook) / textbook).abs() < 0.03, "without stabilization the slide is not the textbook's");
    println!("  stabilization changes the slide by {:.2}%", 100.0 * (on - off) / off);
}

/// A free two-chunk cluster built with DestructibleSettings::default(), let go
/// from rest: y after n steps of semi-implicit Euler with no damping is
/// g dt^2 n (n + 1) / 2 (free fall, Hibbeler 12.3). The default used to carry
/// linear damping 0.25 / angular 0.35 (FIDELITY_AUDIT F5): air drag on a
/// 1 m, 1 t chunk at 10 m/s is 60 N, 0.006 /s of damping, 40x less.
#[test]
#[ignore = "requires the native GPU destruction SDK"]
fn default_settings_fall_freely() {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let nodes: Vec<ChunkNodeDesc> = [-0.25f32, 0.25]
        .iter()
        .enumerate()
        .map(|(i, &x)| ChunkNodeDesc {
            node_index: i as u32,
            centroid: Vec3::new(x, 0.0, 0.0),
            mass: 500.0,
            volume: 0.125,
            geom_kind: 0,
            half_extents: Vec3::new(0.25, 0.25, 0.25),
            convex_points: Vec::new(),
            material: 0,
        })
        .collect();
    let bonds = [ChunkBondDesc { bond_index: 0, node0: 0, node1: 1, centroid: Vec3::new(0.0, 0.0, 0.0), normal: Vec3::new(1.0, 0.0, 0.0), area: 0.25, material: 0 }];
    let never = 1e13f32;
    let settings = DestructibleSettings {
        materials: vec![StressMaterialDesc {
            compression_elastic: never, compression_fatal: never, tension_elastic: never, tension_fatal: never,
            shear_elastic: never, shear_fatal: never, elastic_modulus: 30e9, residual_area_fraction: 0.0,
        }],
        ..DestructibleSettings::default()
    };
    let start = 100.0f32;
    world
        .native_create_destructible(0, Pose { position: Vec3::new(0.0, start, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }, &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK)
        .unwrap();
    world.step().unwrap();
    configure(&mut world);
    let n = 60u32;
    for _ in 0..n {
        world.step().unwrap();
        world.native_tick().unwrap();
    }
    let body: Vec<f32> = world.native_chunk_body_snapshots().unwrap().iter().filter(|b| !b.kinematic).map(|b| b.position.y).collect();
    assert_eq!(body.len(), 1);
    let dt = FIXED_TIMESTEP;
    // One step ran before configure: n + 1 steps of fall in all.
    let n = n + 1;
    let want = start - DEFAULT_WORLD_GRAVITY * dt * dt * (n * (n + 1)) as f32 / 2.0;
    println!("free fall {n} ticks from {start} m: y {:.4} m, undamped {want:.4} m, drop {:.2}% of the undamped", body[0], 100.0 * (start - body[0]) / (start - want));
    assert!((body[0] - want).abs() < 1e-3 * (start - want), "a default destructible does not fall freely");
}

/// A crushable material (capPressure > 0) without its crush energy or
/// viscosity, or with a strain-rate exponent and no reference rate, is an
/// authoring error. The bridge used to substitute 1.0 silently (FIDELITY_AUDIT
/// C6): a crush energy of 1 J/m^3 against concrete's ~1e6.
#[test]
#[ignore = "requires the native GPU destruction SDK"]
fn crush_parameters_are_required() {
    let try_crush = |energy: f32, viscosity: f32, exponent: f32, reference: f32| {
        let mut world = World::new(WorldConfig::default()).expect("GPU scene");
        world.native_attach().unwrap();
        let nodes: Vec<ChunkNodeDesc> = [-0.25f32, 0.25].iter().enumerate().map(|(i, &x)| ChunkNodeDesc {
            node_index: i as u32, centroid: Vec3::new(x, 0.0, 0.0), mass: if i == 0 { 0.0 } else { 100.0 }, volume: 0.125,
            geom_kind: 0, half_extents: Vec3::new(0.25, 0.25, 0.25), convex_points: Vec::new(), material: 0,
        }).collect();
        let bonds = [ChunkBondDesc { bond_index: 0, node0: 0, node1: 1, centroid: Vec3::new(0.0, 0.0, 0.0), normal: Vec3::new(1.0, 0.0, 0.0), area: 0.25, material: 0 }];
        let settings = DestructibleSettings {
            materials: vec![StressMaterialDesc {
                compression_elastic: 30e6, compression_fatal: 30e6, tension_elastic: 3e6, tension_fatal: 3e6,
                shear_elastic: 4e6, shear_fatal: 4e6, elastic_modulus: 30e9, residual_area_fraction: 0.0,
            }],
            crush: vec![vibe_land_physx_bridge::CrushMaterialDesc {
                cap_pressure: 17e6, cohesion: 4e6, friction_slope: 1.2, crush_energy: energy, crush_viscosity: viscosity,
                strain_rate_exponent: exponent, reference_strain_rate: reference, debris_mass_fraction: 0.0,
                debris_fragment_count: 0, impedance: 0.0,
            }],
            ..DestructibleSettings::default()
        };
        world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 5.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }, &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK).is_ok()
    };
    assert!(try_crush(3.5e6, 5.9e5, 0.0, 0.0), "a complete crush material was refused");
    assert!(!try_crush(0.0, 5.9e5, 0.0, 0.0), "a crush material without crush energy was accepted");
    assert!(!try_crush(3.5e6, 0.0, 0.0, 0.0), "a crush material without viscosity was accepted");
    assert!(!try_crush(3.5e6, 5.9e5, 0.02, 0.0), "a strain-rate exponent without a reference rate was accepted");
}

/// The production stress configuration (see `solve`).
fn configure(world: &mut World) {
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
}

/// One scene: a static floor tilted by `degrees` about z, and `boxes` 20 cm,
/// 8 kg cubes stacked from its surface (the first kicked along the slope at
/// `kick` m/s once it has rested for 0.5 s). Returns each cube's displacement
/// along the slope (+ downhill) and up the stack after `seconds`, and how
/// many sleep at the end.
fn floor_scene(degrees: f32, boxes: u32, kick: f32, seconds: f32) -> (Vec<[f32; 2]>, usize) {
    let theta = degrees.to_radians();
    let q = Quat { x: 0.0, y: 0.0, z: (theta / 2.0).sin(), w: (theta / 2.0).cos() };
    let (t, n) = ([theta.cos(), theta.sin()], [-theta.sin(), theta.cos()]);
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1, user_id: 1, pose: Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: q },
            half_extents: Vec3::new(5.0, 0.1, 1.0), collision_group: 1, collision_mask: u32::MAX,
        })
        .unwrap();
    let mut starts = Vec::new();
    for k in 0..boxes {
        let lift = 0.1 + 0.1 + 0.2 * k as f32 + 0.0005 * (k + 1) as f32;
        let p = [n[0] * lift, n[1] * lift];
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: 2 + k, user_id: 2 + k, pose: Pose { position: Vec3::new(p[0], p[1], 0.0), rotation: q },
                half_extents: Vec3::new(0.1, 0.1, 0.1), mass: 8.0, collision_group: 1, collision_mask: u32::MAX,
            })
            .unwrap();
        starts.push(p);
    }
    let rest = 30u32;
    let total = (seconds / FIXED_TIMESTEP).round() as u32;
    for i in 0..total {
        if i == rest && kick != 0.0 {
            world.apply_impulse(2, Vec3::new(-t[0] * 8.0 * kick, -t[1] * 8.0 * kick, 0.0)).unwrap();
        }
        world.step().unwrap();
    }
    let snaps = world.body_snapshots().unwrap();
    let mut out = Vec::new();
    let mut sleeping = 0;
    for k in 0..boxes {
        let b = snaps.iter().find(|b| b.entity_id == 2 + k).expect("cube");
        sleeping += b.sleeping as usize;
        let d = [b.pose.position.x - starts[k as usize][0], b.pose.position.y - starts[k as usize][1]];
        out.push([-(d[0] * t[0] + d[1] * t[1]), d[0] * n[0] + d[1] * n[1]]);
    }
    (out, sleeping)
}

/// Scene stabilization at rest and at low speed, where PhysX applies it
/// (PxSceneFlag::eENABLE_STABILIZATION: extra damping and reduced gravity on
/// slow bodies in contact). Textbook answers (Hibbeler, Dynamics, 13.4;
/// Statics, 8.2):
/// - a cube kicked at 0.5 m/s across a flat floor, mu 0.5, stops after
///   v^2 / (2 mu g) = 25.5 mm;
/// - a cube at rest on a 20 degree incline (tan 20 = 0.36 < mu) stays put;
/// - a column of five cubes stands still.
#[test]
#[ignore = "requires the GPU PhysX scene"]
fn stabilization_at_rest_and_slow() {
    let run = |stab: bool| {
        if stab { std::env::remove_var("VIBE_PHYSX_STABILIZATION") } else { std::env::set_var("VIBE_PHYSX_STABILIZATION", "0") }
        let slide = floor_scene(0.0, 1, 0.5, 2.0).0[0][0];
        let hold = floor_scene(20.0, 1, 0.0, 3.0).0[0][0];
        let (column, asleep) = floor_scene(0.0, 5, 0.0, 5.0);
        let drift = column.iter().map(|d| (d[0] * d[0]).sqrt().max(0.0)).fold(0.0f32, f32::max);
        let sag = column.iter().map(|d| d[1]).fold(0.0f32, f32::min);
        (slide, hold, drift, sag, asleep)
    };
    let on = run(true);
    let off = run(false);
    std::env::remove_var("VIBE_PHYSX_STABILIZATION");
    let stop = 0.5f32 * 0.5 / (2.0 * 0.5 * DEFAULT_WORLD_GRAVITY);
    println!("kicked cube, 0.5 m/s, mu 0.5: textbook {:.2} mm; stabilization on {:.2} mm, off {:.2} mm", 1e3 * stop, 1e3 * on.0, 1e3 * off.0);
    println!("cube at rest on 20 degrees: on moved {:.3} mm, off {:.3} mm (textbook 0)", 1e3 * on.1, 1e3 * off.1);
    println!("column of 5: horizontal drift on {:.3} mm, off {:.3} mm; settled sag on {:.3} mm, off {:.3} mm; asleep on {}/5, off {}/5",
        1e3 * on.2, 1e3 * off.2, 1e3 * on.3, 1e3 * off.3, on.4, off.4);
    // Stabilization is kept if it moves nothing that slides or holds and
    // leaves the stack no further from standing still than without it. The
    // stack's own error (cm-scale sag and drift for five cubes) is the rigid
    // solver's (VIBE_PHYSX_POSITION_ITERS / VELOCITY_ITERS, PGS), not this flag's.
    assert!((on.0 - off.0).abs() <= 0.01 * off.0.abs(), "stabilization changes a slow slide");
    assert!((on.1 - off.1).abs() <= 1e-4, "stabilization changes a hold on an incline");
    assert!(on.2 <= off.2 + 1e-4 && on.3 >= off.3 - 1e-4, "stabilization leaves the stack further from rest");
}

/// native_gameplay's crush wall: 6 x 6 one-metre masonry blocks (the bottom
/// row anchored) on the ground, made crushable at a tenth of brick's strength
/// with instant comminution, struck by a round. Reports the crush count, how
/// many crushed chunks no longer collide (their mass gone from the world), and
/// the lowest crushed chunk's height 90 ticks on.
fn crush_column() -> (usize, u32, f32) {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 0x1000_0001, user_id: 0, pose: Pose { position: Vec3::new(0.0, -0.5, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } },
            half_extents: Vec3::new(40.0, 0.5, 40.0), collision_group: 1 << 1, collision_mask: u32::MAX,
        })
        .unwrap();
    world.native_attach().unwrap();
    let (w, h) = (6u32, 6u32);
    let index = |x: u32, y: u32| y * w + x;
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    for y in 0..h {
        for x in 0..w {
            nodes.push(ChunkNodeDesc {
                node_index: index(x, y), centroid: Vec3::new(x as f32 - 2.5, y as f32 + 0.5, 0.0),
                mass: if y == 0 { 0.0 } else { 400.0 }, volume: 1.0, geom_kind: 0,
                half_extents: Vec3::new(0.48, 0.48, 0.48), convex_points: Vec::new(), material: 0,
            });
        }
    }
    for y in 0..h {
        for x in 0..w {
            let n = bonds.len() as u32;
            if x + 1 < w {
                bonds.push(ChunkBondDesc { bond_index: n, node0: index(x, y), node1: index(x + 1, y), centroid: Vec3::new(x as f32 - 2.0, y as f32 + 0.5, 0.0), normal: Vec3::new(1.0, 0.0, 0.0), area: 0.92, material: 0 });
            }
            let n = bonds.len() as u32;
            if y + 1 < h {
                bonds.push(ChunkBondDesc { bond_index: n, node0: index(x, y), node1: index(x, y + 1), centroid: Vec3::new(x as f32 - 2.5, y as f32 + 1.0, 0.0), normal: Vec3::new(0.0, 1.0, 0.0), area: 0.92, material: 0 });
            }
        }
    }
    let fc = 0.68e6f32;
    let settings = DestructibleSettings {
        materials: vec![StressMaterialDesc {
            compression_elastic: 250e3, compression_fatal: 500e3, tension_elastic: 30e3, tension_fatal: 60e3,
            shear_elastic: 80e3, shear_fatal: 160e3, elastic_modulus: 30e9, residual_area_fraction: 0.0,
        }],
        crush: vec![vibe_land_physx_bridge::CrushMaterialDesc {
            cap_pressure: 2.5 * fc, cohesion: fc * 0.6, friction_slope: 1.2, crush_energy: 1.0, crush_viscosity: 1.0,
            strain_rate_exponent: 0.0, reference_strain_rate: 1.0, debris_mass_fraction: 0.0, debris_fragment_count: 0, impedance: 0.0,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }, &nodes, &bonds, settings, GROUP_CHUNK, u32::MAX).unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: STRESS_ITERATIONS, tolerance: STRESS_TOLERANCE, force_tolerance: 0.0, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true, reserved_contact_pairs: 54,
            preserve_unchanged_contact_pairs: true, gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    for _ in 0..60 {
        world.step().unwrap();
        world.native_tick().unwrap();
    }
    world
        .native_fire_round(RoundDesc { position: Vec3::new(0.0, 3.5, 1.2), direction: Vec3::new(0.0, 0.0, -1.0), momentum_ns: 3.0e5, radius: 0.4, speed: 20.0, ttl_ticks: 20 })
        .unwrap();
    let mut crushed = Vec::new();
    for _ in 0..90 {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        crushed.extend(world.native_take_crush_events().unwrap());
        world.native_take_broken_bonds().unwrap();
        world.native_take_island_events().unwrap();
    }
    // A crushed chunk whose hull no longer collides cannot be aimed at.
    let gone = crushed.iter().filter(|c| world.native_chunk_aim(0, c.chunk_id & 0xffff).map_or(true, |a| !a.found)).count() as u32;
    let lowest = crushed
        .iter()
        .filter_map(|c| world.native_chunk_aim(0, c.chunk_id & 0xffff).ok().filter(|a| a.found).map(|a| a.center.y))
        .fold(f32::INFINITY, f32::min);
    (crushed.len(), gone, lowest)
}

/// Crushed mass is conserved (VIBE_CRUSH_CONSERVE_MASS=1, FIDELITY_AUDIT C4):
/// a crushed chunk is comminuted, not annihilated. Its mass, momentum and
/// weight stay in the world as debris with a body of its own (the chunk's
/// hull: the right mass and centre, not the shape of a pile of fines). The
/// runtime retires "dust" (debrisMassFraction 0) from the world.
#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_CRUSH_CORRECTION"]
fn crushed_mass_is_conserved() {
    if std::env::var(ARM).as_deref() == Ok("crush") {
        let (crushed, lost, lowest) = crush_column();
        println!("crushed={crushed}\nlost={lost}\nlowest={lowest}");
        return;
    }
    let arm = |env: &[(&str, &str)]| {
        let mut c = std::process::Command::new(std::env::current_exe().unwrap());
        c.args(["--exact", "crushed_mass_is_conserved", "--nocapture", "--ignored"]).env(ARM, "crush").env_remove("VIBE_CRUSH_CONSERVE_MASS");
        for (k, v) in env {
            c.env(k, v);
        }
        let o = c.output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
        assert!(o.status.success(), "{text}");
        let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap_or_else(|| panic!("{k}:\n{text}")).trim().parse::<f32>().unwrap();
        (get("crushed"), get("lost"), get("lowest"))
    };
    let runtime = arm(&[]);
    let conserve = arm(&[("VIBE_CRUSH_CONSERVE_MASS", "1")]);
    println!("runtime: {} crushed, {} of them gone from the world (no body, no collision)", runtime.0, runtime.1);
    println!("conserve: {} crushed, {} chunks' mass gone; lowest crushed chunk at {:.2} m", conserve.0, conserve.1, conserve.2);
    assert!(runtime.0 > 0.0 && conserve.0 > 0.0, "the round crushed nothing");
    assert_eq!(runtime.1, runtime.0, "the runtime no longer retires dust: update the audit");
    assert_eq!(conserve.1, 0.0, "crushed mass left the world");
    assert!(conserve.2 < 1.0, "crushed debris did not fall to the ground (lowest at {} m)", conserve.2);
}

/// A block hung from an anchor by one 100 cm^2 bond in tension at `ratio` of
/// the bond's short-term strength f (1 MPa), elastic limit 0.6 f (EN 1995-1-1
/// k_mod, the town kit's LONG_TERM) and `residual` area arrest, for `ticks`.
/// Returns (tick it broke or 0, remaining area / area, bond commands on the
/// last tick).
fn hung_block(ratio: f32, residual: f32, ticks: u32) -> (u32, f32, u32) {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let (f, area) = (1.0e6f32, 0.01f32);
    let mass = ratio * f * area / DEFAULT_WORLD_GRAVITY;
    let nodes = [
        ChunkNodeDesc { node_index: 0, centroid: Vec3::new(0.0, 0.3, 0.0), mass: 0.0, volume: 0.02, geom_kind: 0,
            half_extents: Vec3::new(0.1, 0.05, 0.1), convex_points: Vec::new(), material: 0 },
        ChunkNodeDesc { node_index: 1, centroid: Vec3::new(0.0, 0.0, 0.0), mass, volume: 0.04, geom_kind: 0,
            half_extents: Vec3::new(0.1, 0.25, 0.1), convex_points: Vec::new(), material: 0 },
    ];
    let bonds = [ChunkBondDesc { bond_index: 0, node0: 0, node1: 1, centroid: Vec3::new(0.0, 0.25, 0.0), normal: Vec3::new(0.0, 1.0, 0.0), area, material: 0 }];
    let settings = DestructibleSettings {
        materials: vec![StressMaterialDesc {
            compression_elastic: 0.6 * 30e6, compression_fatal: 30e6, tension_elastic: 0.6 * f, tension_fatal: f,
            shear_elastic: 0.6 * 4e6, shear_fatal: 4e6, elastic_modulus: 11e9, residual_area_fraction: residual,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 20.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }, &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK).unwrap();
    world.step().unwrap();
    configure(&mut world);
    let (mut broke, mut commands, mut remaining) = (0, 0, 1.0);
    for t in 1..=ticks {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected the step: {status:?}");
        commands = status.bond_commands;
        if !world.native_take_broken_bonds().unwrap().is_empty() {
            broke = t;
            remaining = 0.0;
            break;
        }
        if let Some(r) = world.native_bond_stress_rows(0).unwrap().first() {
            remaining = r.remaining_area / area;
        }
    }
    (broke, remaining, commands)
}

/// Sub-fatal damage (FIDELITY_AUDIT C1, C2). The runtime loses section at
/// damageRate x (sigma - elastic)/(fatal - elastic) per second (2 /s), and
/// arrests it at residualAreaFraction x A0, where a loaded joint can sit just
/// under fatal forever with a damage command every tick.
///
/// The physical law for the timescale a game runs at, VIBE_STRENGTH_SHORT_TERM=1:
/// duration-of-load (Gerhards 1979, the exponential damage rate model, as in
/// the Wood Handbook FPL-GTR-282 sec. 5): d(alpha)/dt = exp(-a + b sigma/f),
/// a = 43.17, b = 49.75, t in minutes, f the short-term (ramp) strength. Under
/// a constant ratio r the time to failure is exp(a - b r) minutes: r 1.0 ->
/// 0.08 s, 0.9 -> 12 s, 0.85 -> 2.4 min, 0.8 -> 29 min, 0.7 -> 3 days. Brittle
/// materials (masonry, plain concrete, glass) show no rate damage at all on
/// these timescales. So within a session a bond holds whatever it carries
/// below f, undamaged, and breaks at f; the only error is a load held at
/// 0.85-1.0 f for minutes, which the real member would lose. Ductile joints
/// yield through E's ductile slip, not through lost area.
#[test]
#[ignore = "requires the native GPU destruction SDK"]
fn sub_fatal_damage_law() {
    if std::env::var(ARM).as_deref() == Ok("damage") {
        for (k, (r, rho)) in [(0.8f32, 0.0f32), (1.02, 0.0), (0.7, 0.85)].iter().enumerate() {
            let (b, a, c) = hung_block(*r, *rho, 600);
            println!("case{k}={b},{a},{c}");
        }
        return;
    }
    let arm = |env: &[(&str, &str)]| {
        let mut c = std::process::Command::new(std::env::current_exe().unwrap());
        c.args(["--exact", "sub_fatal_damage_law", "--nocapture", "--ignored"]).env(ARM, "damage").env_remove("VIBE_STRENGTH_SHORT_TERM");
        for (k, v) in env {
            c.env(k, v);
        }
        let o = c.output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
        assert!(o.status.success(), "{text}");
        (0..3).map(|k| reported(&text, &format!("case{k}"))).collect::<Vec<_>>()
    };
    let runtime = arm(&[]);
    let short = arm(&[("VIBE_STRENGTH_SHORT_TERM", "1")]);
    let show = |name: &str, r: &[Vec<f32>]| {
        for (k, what) in ["0.80 f, 10 s (Gerhards: holds 29 min)", "1.02 f (breaks at once)", "0.70 f, residual 0.85 (Gerhards: holds 3 days)"].iter().enumerate() {
            let c = &r[k];
            println!("  {name:<10} {what:<48} broke at tick {:>3}  area left {:.3}  commands last tick {}", c[0], c[1], c[2]);
        }
    };
    println!("hung block, one bond in tension (Gerhards 1979; Wood Handbook 5):");
    show("runtime", &runtime);
    show("short-term", &short);
    // The runtime's law, documented (the default is unchanged).
    assert!(runtime[0][0] > 0.0 && runtime[0][0] < 60.0, "runtime no longer breaks 0.8 f within a second");
    assert!(runtime[2][0] == 0.0 && runtime[2][1] < 0.9 && runtime[2][2] > 0.0, "runtime no longer pins under arrest");
    // The physical law.
    assert_eq!(short[0][0], 0.0, "0.8 f broke within 10 s");
    assert_eq!(short[0][1], 1.0, "0.8 f lost section");
    assert!(short[1][0] >= 1.0 && short[1][0] <= 2.0, "1.02 f did not break at once");
    assert_eq!(short[2][0], 0.0, "0.7 f broke");
    assert_eq!(short[2][1], 1.0, "0.7 f lost section");
    assert_eq!(short[2][2], 0.0, "a bond below its strength still commands damage");
    assert!(runtime[1][0] >= 1.0 && runtime[1][0] <= 2.0, "1.02 f did not break at once");
}
