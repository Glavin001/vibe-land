#![cfg(feature = "native-destruction")]

//! A fastened bearing joint (PxDestructionBondSection::bearingDepth0/1, the
//! bridge's bearing_joint table, town-kit bearingJoint): a 45 x 90 mm stud
//! standing on its plate, end-nailed, with a moment at its foot from two
//! unequal arms. Under compression C and moment M the contact bears at its
//! edge and the nails at its centre carry T = M / (d/2) - C, nothing while
//! M / C < d/2 (statics of a rigid contact; the eccentricity rule of EN
//! 1995-1-1 6.1.5 bearing and of any base plate). The extreme-fibre grading
//! of a glued patch, M / S - C / A, puts tension on the nails the moment the
//! fibre goes past zero (M / C > d/6).
//!
//! Each case runs the same stud twice -- graded as a bearing joint and as a
//! glued patch -- at a tension capacity between the two answers: the bearing
//! joint holds where T < capacity and breaks where T > capacity.
//!
//! VIBE_GPU_SHARED=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test bearing_joint -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World,
    WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const DEPTH: f64 = 0.09; // the stud's 90 mm, across the bending axis
const WIDTH: f64 = 0.045;
const HEIGHT: f64 = 0.5;
const ARM: f64 = 0.1; // each arm's centre from the stud's axis

fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}

/// Does the foot joint break? `left` / `right`: the arms' masses (kg);
/// `capacity`: the foot's tension capacity (Pa over its area).
fn foot_breaks(left: f64, right: f64, capacity: f64, bearing: bool) -> bool {
    stage_env::product();
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let (hd, hw, hh) = (DEPTH / 2.0, WIDTH / 2.0, HEIGHT / 2.0);
    let arm_half = [ARM / 2.0 - hd / 2.0, 0.05, hw];
    let arm_x = hd + arm_half[0];
    // (centre, half extents, mass): plate (anchor), stud, left arm, right arm.
    let chunks = [
        ([0.0, -0.01, 0.0], [0.2, 0.01, 0.1], 0.0),
        ([0.0, hh, 0.0], [hd, hh, hw], 420.0 * DEPTH * WIDTH * HEIGHT),
        ([-arm_x, HEIGHT - 0.05, 0.0], arm_half, left),
        ([arm_x, HEIGHT - 0.05, 0.0], arm_half, right),
    ];
    let nodes: Vec<ChunkNodeDesc> = chunks
        .iter()
        .enumerate()
        .map(|(i, &(c, h, m))| ChunkNodeDesc {
            node_index: i as u32,
            centroid: v3(c),
            mass: m as f32,
            volume: (8.0 * h[0] * h[1] * h[2]) as f32,
            geom_kind: 0,
            half_extents: v3(h),
            convex_points: Vec::new(),
            material: 0,
        })
        .collect();
    let bond = |k: u32, a: u32, b: u32, c: [f64; 3], n: [f64; 3], area: f64, material: u32| ChunkBondDesc {
        bond_index: k, node0: a, node1: b, centroid: v3(c), normal: v3(n), area: area as f32, material,
    };
    let bonds = vec![
        bond(0, 0, 1, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0], DEPTH * WIDTH, 1),
        bond(1, 2, 1, [-hd, HEIGHT - 0.05, 0.0], [1.0, 0.0, 0.0], 0.1 * WIDTH, 0),
        bond(2, 1, 3, [hd, HEIGHT - 0.05, 0.0], [1.0, 0.0, 0.0], 0.1 * WIDTH, 0),
    ];
    let strong = StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 1e12, tension_elastic: 1e12, tension_fatal: 1e12,
        shear_elastic: 1e12, shear_fatal: 1e12, elastic_modulus: 11e9, residual_area_fraction: 0.0,
    };
    let foot = StressMaterialDesc {
        tension_elastic: capacity as f32, tension_fatal: capacity as f32, ..strong
    };
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: 4096,
        materials: vec![strong, foot],
        bearing_joint: if bearing { vec![0.0, 1.0] } else { Vec::new() },
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        ..DestructibleSettings::default()
    };
    world
        .native_create_destructible(0, Pose { position: Vec3::new(0.0, 10.0, 0.0), rotation: Quat::IDENTITY },
            &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK)
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: 4096, tolerance: 1e-6, force_tolerance: 1e-5, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    let mut broke = false;
    for _ in 0..10 {
        world.step().unwrap();
        world.native_tick().unwrap();
        broke |= world.native_take_broken_bonds().unwrap().iter().any(|e| e.bond_id == 0);
        if std::env::var_os("BEARING_TRACE").is_some() {
            for r in world.native_bond_stress_rows(0).unwrap() {
                println!("    tick: bond {} normal {:.0} bend {:.0} shear {:.0} broken {}", r.bond_index, r.stress_normal, r.stress_bend, r.shear, r.broken);
            }
        }
    }
    let rows = world.native_bond_stress_rows(0).unwrap();
    let row = rows.iter().find(|r| r.bond_index == 0);
    if let Some(r) = row {
        println!("  foot ({}, capacity {capacity:.0} Pa): normal {:.0} Pa, bend {:.0} Pa, shear {:.0} Pa, broken {}",
            if bearing { "bearing" } else { "glued" }, r.stress_normal, r.stress_bend, r.shear, r.broken);
    }
    broke || row.map(|r| r.broken).unwrap_or(false)
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_BEARING_JOINTS"]
fn bearing_joint_grades_by_its_fasteners() {
    std::env::set_var("VIBE_SECTION_BENDING", "1");
    let g = -(WorldConfig::default().gravity.y as f64);
    let stud = 420.0 * DEPTH * WIDTH * HEIGHT;
    let (area, s) = (DEPTH * WIDTH, WIDTH * DEPTH * DEPTH / 6.0);
    let arm_x = DEPTH / 2.0 + (ARM / 2.0 - DEPTH / 4.0);
    for (label, left, right) in [("between d/6 and d/2", 7.0, 13.0), ("past the edge", 0.01, 20.0)] {
        let c = (stud + left + right) * g;
        let m = (right - left) * g * arm_x;
        let fibre = (m / s - c / area).max(0.0);
        let nails = (m / (DEPTH / 2.0) - c).max(0.0) / area;
        println!("{label}: C {c:.1} N, M {m:.2} N m (e {:.1} mm): nails {nails:.0} Pa, glued fibre {fibre:.0} Pa", 1e3 * m / c);
        if nails == 0.0 {
            // Bears without loading its nails: holds at any capacity the fibre exceeds.
            let cap = 0.5 * fibre;
            assert!(!foot_breaks(left, right, cap, true), "{label}: the bearing joint broke at {cap:.0} Pa with no load on its nails");
            assert!(foot_breaks(left, right, cap, false), "{label}: the glued patch held at {cap:.0} Pa under a {fibre:.0} Pa fibre");
        } else {
            assert!(foot_breaks(left, right, 0.9 * nails, true), "{label}: the nails held at 0.9 T");
            assert!(!foot_breaks(left, right, 1.1 * nails, true), "{label}: the nails broke at 1.1 T");
            assert!(foot_breaks(left, right, 1.1 * nails, false), "{label}: the glued patch held at 1.1 T (fibre {fibre:.0} Pa)");
        }
    }
}
