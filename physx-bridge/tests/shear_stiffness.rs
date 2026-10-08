#![cfg(feature = "native-destruction")]

//! Shear stiffness apart from normal stiffness (VIBE_SHEAR_STIFFNESS=1, PhysX
//! PX_DESTRUCTION_SHEAR_STIFFNESS, Blast ExtStressGpuSetBondShearStiffness;
//! FIDELITY_AUDIT D11).
//!
//! A joint is k_n = E A / L stiff along its normal and k_s = G A / L across it.
//! Masonry's G is 0.4 E (EN 1996-1-1 3.8.3); a solid's is E / (2 (1 + nu)).
//! Without this capability the solve gives every bond one stiffness in every
//! direction, so a joint loaded in shear is 1 / 0.4 = 2.5 times too stiff
//! beside one loaded along its normal, and draws that much more of a shared load.
//!
//! The textbook case is load sharing between parallel joints, decided by
//! compatibility. A block is held by four joints of equal area and length,
//! arranged symmetrically so it can only translate. Two are above and below
//! it: gravity loads them along their normals. Two are at its sides: gravity
//! shears them. All four see the block's one vertical displacement d, so the
//! axial pair carries 2 k_n d and the shear pair 2 k_s d:
//!     V_side / N_axial = k_s / k_n = gamma,   N_axial = W / (2 (1 + gamma)) each.
//! With gamma 0.4 (masonry) the sides carry 0.4 of what the axial joints do.
//! With one stiffness per bond they carry the same.
//!
//! The case runs twice: gamma 0.4 (masonry) and gamma 1 / (2 (1 + 0.3)) =
//! 0.385 (a solid with Poisson's ratio 0.3).
//!
//! VIBE_GPU_SHARED=1 VIBE_SHEAR_STIFFNESS=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test shear_stiffness -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World,
    WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = u32::MAX;
const HALF: f64 = 0.1; // the block's half size; each joint a face of it
const MASS: f64 = 500.0;
const E: f64 = 10.5e9; // stone masonry, E = 1000 f_k (EN 1996-1-1 3.7.2)

fn g() -> f64 {
    -(WorldConfig::default().gravity.y as f64)
}
fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}
fn shear_on() -> bool {
    std::env::var("VIBE_SHEAR_STIFFNESS").map(|v| v == "1").unwrap_or(false)
}
fn strong() -> StressMaterialDesc {
    StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 1e12, tension_elastic: 1e12, tension_fatal: 1e12,
        shear_elastic: 1e12, shear_fatal: 1e12, elastic_modulus: E as f32, residual_area_fraction: 0.0,
    }
}
fn node(i: u32, c: [f64; 3], m: f64) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: i, centroid: v3(c), mass: m as f32, volume: (8.0 * HALF.powi(3)) as f32, geom_kind: 0,
        half_extents: v3([HALF; 3]), convex_points: Vec::new(), material: 0,
    }
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_SHEAR_STIFFNESS and VIBE_SHEAR_STIFFNESS=1"]
fn parallel_joints_share_load_by_their_shear_stiffness() {
    stage_env::product();
    // The high-fidelity structural model: real sections and their rotational
    // stiffness (the solve's per-bond rows the shear stiffness extends).
    std::env::set_var("VIBE_SECTION_ROTATION", "1");
    std::env::set_var("VIBE_STRENGTH_SHORT_TERM", "1");
    let cases = [("masonry, G = 0.4 E (EN 1996-1-1 3.8.3)", 0.4f64), ("a solid, nu 0.3: G = E / 2.6", 1.0 / 2.6)];
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let area = (2.0 * HALF) * (2.0 * HALF);
    for (id, (_, gamma)) in cases.iter().enumerate() {
        // The block at the centre; four supports a block's width away, one per side.
        let d = 2.0 * HALF;
        let nodes = [
            node(0, [0.0, 0.0, 0.0], MASS),
            node(1, [0.0, -d, 0.0], 0.0),
            node(2, [0.0, d, 0.0], 0.0),
            node(3, [-d, 0.0, 0.0], 0.0),
            node(4, [d, 0.0, 0.0], 0.0),
        ];
        let bond = |k: u32, other: u32, c: [f64; 3], n: [f64; 3]| ChunkBondDesc {
            bond_index: k, node0: other, node1: 0, centroid: v3(c), normal: v3(n), area: area as f32, material: 0,
        };
        let bonds = [
            bond(0, 1, [0.0, -HALF, 0.0], [0.0, 1.0, 0.0]), // below: axial
            bond(1, 2, [0.0, HALF, 0.0], [0.0, 1.0, 0.0]),  // above: axial
            bond(2, 3, [-HALF, 0.0, 0.0], [1.0, 0.0, 0.0]), // left: shear
            bond(3, 4, [HALF, 0.0, 0.0], [1.0, 0.0, 0.0]),  // right: shear
        ];
        let settings = DestructibleSettings {
            max_solver_iterations_per_frame: 64,
            materials: vec![strong()],
            shear_stiffness_ratio: vec![*gamma as f32], surface_static_friction: Vec::new(), surface_dynamic_friction: Vec::new(), surface_restitution: Vec::new(),
            maximum_bodies: 0,
            maximum_fractures_per_actor_per_tick: 0,
            ..DestructibleSettings::default()
        };
        world
            .native_create_destructible(id as u32, Pose { position: Vec3::new(3.0 * id as f32, 10.0, 0.0), rotation: Quat::IDENTITY },
                &nodes, &bonds, settings, GROUP_CHUNK, ALL)
            .unwrap();
    }
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: 64, tolerance: 1e-3, force_tolerance: 0.0, warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    for _ in 0..10 {
        world.step().unwrap();
        world.native_tick().unwrap();
    }
    let w = MASS * g();
    println!("shear stiffness {}: four joints of {area} m^2 hold a {MASS} kg block ({w:.1} N)", if shear_on() { "on" } else { "OFF" });
    let mut failures = Vec::new();
    for (id, (label, gamma)) in cases.iter().enumerate() {
        let rows = world.native_bond_stress_rows(id as u32).unwrap();
        let force = |bond: u32| -> (f64, f64) {
            let r = rows.iter().find(|r| r.bond_index == bond).expect("bond row");
            let a = r.remaining_area as f64;
            (r.stress_normal as f64 * a, r.shear as f64 * a)
        };
        let (n0, v0) = force(0);
        let (n1, v1) = force(1);
        let (n2, v2) = force(2);
        let (n3, v3s) = force(3);
        let axial = n0.abs() + n1.abs();
        let side = v2 + v3s;
        let ratio = side / axial;
        let expect_axial = w / (1.0 + gamma);
        println!("  {label}: axial joints N {n0:.1} / {n1:.1} N (shear {v0:.2} / {v1:.2}), side joints V {v2:.1} / {v3s:.1} N \
                  (normal {n2:.2} / {n3:.2}); V/N {ratio:.4} against gamma {gamma:.4}; axial pair {axial:.1} N against W/(1+gamma) {expect_axial:.1} N; \
                  total {:.1} N", axial + side);
        if (axial + side - w).abs() > 1e-3 * w {
            failures.push(format!("{label}: the joints carry {:.1} N, the block weighs {w:.1} N", axial + side));
        }
        if (ratio - gamma).abs() > 0.01 * gamma {
            failures.push(format!("{label}: V/N {ratio:.4}, not gamma {gamma:.4}"));
        }
    }
    assert!(failures.is_empty(), "the joints do not share the load by their stiffness: {failures:?}");
}
