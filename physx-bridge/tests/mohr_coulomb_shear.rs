#![cfg(feature = "native-destruction")]

//! Mohr-Coulomb joint shear (VIBE_MOHR_COULOMB_SHEAR=1, PhysX
//! PX_DESTRUCTION_MOHR_COULOMB_SHEAR; FIDELITY_AUDIT C11): an intact mortar
//! joint's shear strength grows with the compression across it.
//!
//! The textbook case is a masonry couplet: one unit on a bed joint, sheared
//! under precompression, as in the EN 1052-3 triplet test. EN 1996-1-1 3.6.2
//! eq. 3.5 gives its strength as f_vk = f_vk0 + 0.4 sigma_d, capped at
//! 0.065 f_b (or f_vlt).
//!
//! Here gravity does both the precompression and the shear. A unit of weight W
//! sits on a joint of area A whose plane is tilted theta from the horizontal.
//! The joint's normal is theta from the vertical, and the unit's centre of mass
//! is directly above the joint's centre, so the joint carries no moment:
//! N = W cos theta (compression) and V = W sin theta.
//! - The joint slides when W sin theta > A min(f_v0 + mu W cos theta / A, cap).
//!   Uncapped, the failure weight is W* = f_v0 A / (sin theta - mu cos theta).
//!   Capped, it is W* = cap A / sin theta.
//! - Each case is built twice, at 0.95 W* and at 1.05 W*. The first must hold
//!   and the second must break: that brackets the failure load against the
//!   closed form to +-5%.
//!
//! The cases, from the stone mortar joint of town-kit materials.mjs
//! (f_vk0 0.15 MPa, mu 0.4, natural stone in M2.5-M9 mortar):
//! - theta 90: pure shear, sigma_c 0. The control: the same with or without
//!   the friction term.
//! - theta 45: sigma_c 0.25 MPa at failure; f_v 0.25, against 0.15 without
//!   friction.
//! - theta 30: sigma_c 0.85 MPa at failure; f_v 0.49.
//! - theta 30 with a cap of 0.3 MPa: the cap binds, and W* = cap A / sin theta.
//!
//! Without the friction term (VIBE_MOHR_COULOMB_SHEAR unset) every joint
//! breaks at f_v0 A / sin theta, so the 0.95 W* units of the 45 and 30 degree
//! cases break and the test fails.
//!
//! VIBE_GPU_SHARED=1 VIBE_MOHR_COULOMB_SHEAR=1 cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test mohr_coulomb_shear -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StressMaterialDesc, Vec3, World,
    WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = u32::MAX;
/// EN 1996-1-1 Table 3.4: natural stone in general-purpose mortar M2.5-M9.
const FV0: f64 = 0.15e6;
/// EN 1996-1-1 3.6.2 eq. 3.5: the friction coefficient of a mortar joint.
const MU: f64 = 0.4;
const AREA: f64 = 0.01; // a 100 x 100 mm bed
const E_MASONRY: f64 = 10.5e9; // stone masonry, E = 1000 f_k (EN 1996-1-1 3.7.2)
const HALF: f64 = 0.05;

fn g() -> f64 {
    -(WorldConfig::default().gravity.y as f64)
}
fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}
fn friction_on() -> bool {
    std::env::var("VIBE_MOHR_COULOMB_SHEAR").map(|v| v == "1").unwrap_or(false)
}
/// The joint: f_v0 in shear, far stronger in tension and compression, so the
/// shear branch alone decides the outcome.
fn joint() -> StressMaterialDesc {
    StressMaterialDesc {
        compression_elastic: 1e9, compression_fatal: 1e9, tension_elastic: 1e9, tension_fatal: 1e9,
        shear_elastic: FV0 as f32, shear_fatal: FV0 as f32, elastic_modulus: E_MASONRY as f32, residual_area_fraction: 0.0,
    }
}

struct Case {
    label: &'static str,
    theta_deg: f64,
    cap: f64, // Pa; 0 uncapped
}
impl Case {
    /// The closed-form failure weight W* (N) and the joint's compression there (Pa).
    fn failure(&self) -> (f64, f64) {
        let t = self.theta_deg.to_radians();
        let (s, c) = (t.sin(), t.cos());
        let mut w = FV0 * AREA / (s - MU * c);
        if self.cap > 0.0 && FV0 + MU * w * c / AREA > self.cap {
            w = self.cap * AREA / s;
        }
        (w, w * c / AREA)
    }
    /// What breaks it without the friction term (N).
    fn failure_without_friction(&self) -> f64 {
        FV0 * AREA / self.theta_deg.to_radians().sin()
    }
}

#[test]
#[ignore = "requires a native GPU destruction SDK with PX_DESTRUCTION_MOHR_COULOMB_SHEAR and VIBE_MOHR_COULOMB_SHEAR=1"]
fn couplet_shear_grows_with_precompression() {
    stage_env::product();
    // The high-fidelity structural model: real sections and their rotational
    // stiffness, short-term strength (brittle at fatal).
    std::env::set_var("VIBE_SECTION_ROTATION", "1");
    std::env::set_var("VIBE_STRENGTH_SHORT_TERM", "1");
    let cases = [
        Case { label: "pure shear (control)", theta_deg: 90.0, cap: 0.0 },
        Case { label: "45 degrees", theta_deg: 45.0, cap: 0.0 },
        Case { label: "30 degrees", theta_deg: 30.0, cap: 0.0 },
        Case { label: "30 degrees, cap 0.3 MPa", theta_deg: 30.0, cap: 0.3e6 },
    ];
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    // Each case twice (0.95 and 1.05 of W*), each its own structure, 2 m apart.
    let mut units = Vec::new();
    for (k, case) in cases.iter().enumerate() {
        let (w, sigma) = case.failure();
        for (j, factor) in [0.95, 1.05].into_iter().enumerate() {
            let id = (2 * k + j) as u32;
            let t = case.theta_deg.to_radians();
            let n = [t.sin(), t.cos(), 0.0];
            let h = 0.2; // the unit's centre of mass, straight above the joint's centre
            let mass = factor * w / g();
            let nodes = [
                // The support below the joint, along its normal.
                ChunkNodeDesc { node_index: 0, centroid: v3([-h * n[0], -h * n[1], 0.0]), mass: 0.0,
                    volume: (8.0 * HALF.powi(3)) as f32, geom_kind: 0, half_extents: v3([HALF; 3]),
                    convex_points: Vec::new(), material: 0 },
                ChunkNodeDesc { node_index: 1, centroid: v3([0.0, h, 0.0]), mass: mass as f32,
                    volume: (8.0 * HALF.powi(3)) as f32, geom_kind: 0, half_extents: v3([HALF; 3]),
                    convex_points: Vec::new(), material: 0 },
            ];
            let bonds = [ChunkBondDesc { bond_index: 0, node0: 0, node1: 1, centroid: v3([0.0, 0.0, 0.0]), normal: v3(n),
                area: AREA as f32, material: 0 }];
            let settings = DestructibleSettings {
                max_solver_iterations_per_frame: 64,
                materials: vec![joint()],
                shear_friction: vec![MU as f32],
                shear_capacity_limit: vec![case.cap as f32],
                maximum_bodies: 0,
                maximum_fractures_per_actor_per_tick: 0,
                ..DestructibleSettings::default()
            };
            world
                .native_create_destructible(id, Pose { position: Vec3::new(2.0 * id as f32, 10.0, 0.0), rotation: Quat::IDENTITY },
                    &nodes, &bonds, settings, GROUP_CHUNK, ALL)
                .unwrap();
            units.push((k, factor, mass, w, sigma));
        }
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
    // The joint's forces as the stage solved them (N, V), before anything breaks.
    let mut first: Vec<Option<(f64, f64)>> = vec![None; units.len()];
    let mut broke = vec![false; units.len()];
    for _ in 0..20 {
        world.step().unwrap();
        world.native_tick().unwrap();
        for e in world.native_take_broken_bonds().unwrap() {
            if let Some(b) = broke.get_mut(e.structure_id as usize) {
                *b = true;
            }
        }
        for (id, f) in first.iter_mut().enumerate() {
            if f.is_none() {
                if let Some(r) = world.native_bond_stress_rows(id as u32).unwrap().first() {
                    let a = r.remaining_area as f64;
                    if !r.broken && a > 0.0 {
                        *f = Some((r.stress_normal as f64 * a, r.shear as f64 * a));
                    }
                }
            }
        }
    }
    println!("Mohr-Coulomb shear {}: f_v0 {} MPa, mu {MU}, A {AREA} m^2", if friction_on() { "on" } else { "OFF" }, FV0 / 1e6);
    let mut failures = Vec::new();
    for (id, &(k, factor, mass, w, sigma)) in units.iter().enumerate() {
        let case = &cases[k];
        let t = case.theta_deg.to_radians();
        let (n, v) = first[id].unwrap_or((f64::NAN, f64::NAN));
        let expect_break = factor > 1.0;
        println!("  {:<26} W {:>8.1} N ({factor:.2} W*, W* {w:.1} N, sigma_c at W* {:.3} MPa; without friction W* {:.1} N): \
                  solved N {n:.1} N (statics {:.1}), V {v:.1} N (statics {:.1}); {}",
            case.label, mass * g(), sigma / 1e6, case.failure_without_friction(), -mass * g() * t.cos(), mass * g() * t.sin(),
            if broke[id] { "BROKE" } else { "held" });
        if broke[id] != expect_break {
            failures.push(format!("{} at {factor:.2} W*: {}", case.label, if broke[id] { "broke" } else { "held" }));
        }
    }
    assert!(failures.is_empty(), "the couplet's shear capacity is not f_v0 A + mu N (capped): {failures:?}");
}
