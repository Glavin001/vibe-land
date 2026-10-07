#![cfg(feature = "native-destruction")]

//! Bond bending and torsion against beam theory, through the native stage.
//!
//! A cantilever of box chunks hangs off an anchored root under gravity. One
//! bond per cross-section makes it statically determinate: whatever the solver
//! does, the wrench across each bond is fixed by statics -- the weight of
//! everything beyond it, about the bond's centroid -- so the stage's reported
//! fibre stress has an independent answer, sigma = M c / I. Chunk lengths are
//! unequal, so the chunks' midpoint (where the solver reports a bond's moment)
//! is not on the bond face, and an arm at the tip twists the beam.
//!
//! The same cross-section area is run deep (a joist on edge) and flat (a
//! plank): beam theory says the plank's bending stress is four times the
//! joist's. The area-only formula, 6/sqrt(A) capped at 3, reads both alike
//! and a tenth of either. VIBE_SECTION_BENDING=1 (set here) must match.
//!
//! cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test section_bending -- --ignored --test-threads=1 --nocapture
//! SECTION_TEST_LEGACY=1 runs the capped formula, to show it fail.

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat,
    StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;

struct Chunk {
    center: [f64; 3],
    half: [f64; 3],
    mass: f64,
}

/// Bond k joins chunk `a` to chunk `b` through the face at `centroid`
/// with `normal`; `width`/`depth` are the section's extents on the two
/// in-plane axes `u`/`v` (u x v = normal).
struct Joint {
    a: usize,
    b: usize,
    centroid: [f64; 3],
    normal: [f64; 3],
    u: [f64; 3],
    v: [f64; 3],
    bu: f64,
    bv: f64,
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}

/// A cantilever along +x off an anchor: segments of the given lengths, section
/// `width` (z) x `depth` (y), and a sideways arm at the tip (along +z).
fn cantilever(lengths: &[f64], width: f64, depth: f64, arm: f64) -> (Vec<Chunk>, Vec<Joint>) {
    let rho = 500.0;
    let (hy, hz) = (depth / 2.0, width / 2.0);
    let mut chunks = vec![Chunk { center: [-0.25, 0.0, 0.0], half: [0.25, hy, hz], mass: 0.0 }];
    let mut joints = Vec::new();
    let mut x = 0.0;
    for &l in lengths {
        let prev = chunks.len() - 1;
        chunks.push(Chunk {
            center: [x + l / 2.0, 0.0, 0.0],
            half: [l / 2.0, hy, hz],
            mass: rho * l * width * depth,
        });
        // Normal +x; in-plane axes: u = z (width), v = x cross z = -y... use
        // u = y (depth) and v = z (width) so u x v = x.
        joints.push(Joint {
            a: prev,
            b: chunks.len() - 1,
            centroid: [x, 0.0, 0.0],
            normal: [1.0, 0.0, 0.0],
            u: [0.0, 1.0, 0.0],
            v: [0.0, 0.0, 1.0],
            bu: depth,
            bv: width,
        });
        x += l;
    }
    if arm > 0.0 {
        // The arm sits on the last segment's +z face, over its last `width` of
        // length, and is as deep as the beam.
        let tip = chunks.len() - 1;
        let cx = x - width / 2.0;
        chunks.push(Chunk {
            center: [cx, 0.0, hz + arm / 2.0],
            half: [width / 2.0, hy, arm / 2.0],
            mass: rho * arm * width * depth,
        });
        joints.push(Joint {
            a: tip,
            b: chunks.len() - 1,
            centroid: [cx, 0.0, hz],
            normal: [0.0, 0.0, 1.0],
            u: [1.0, 0.0, 0.0],
            v: [0.0, 1.0, 0.0],
            bu: width,
            bv: depth,
        });
    }
    (chunks, joints)
}

/// Everything held up through joint `k`: the chunks reachable from its `b`
/// side without crossing it (the graph is a tree).
fn beyond(joints: &[Joint], k: usize, n: usize) -> Vec<usize> {
    let mut seen = vec![false; n];
    seen[joints[k].a] = true;
    let mut stack = vec![joints[k].b];
    let mut out = Vec::new();
    while let Some(c) = stack.pop() {
        if seen[c] {
            continue;
        }
        seen[c] = true;
        out.push(c);
        for (j, joint) in joints.iter().enumerate() {
            if j == k {
                continue;
            }
            if joint.a == c && !seen[joint.b] {
                stack.push(joint.b);
            }
            if joint.b == c && !seen[joint.a] {
                stack.push(joint.a);
            }
        }
    }
    out
}

/// Beam theory for joint k: (normal stress, shear incl. twist, bending fibre).
/// Bending: sigma = |M_u| / (b_v b_u^2 / 6) + |M_v| / (b_u b_v^2 / 6) (the
/// corner fibre). Twist: the patch's polar modulus, tau = T r_max / I_p.
fn expected(chunks: &[Chunk], joints: &[Joint], k: usize, g: f64) -> (f64, f64, f64) {
    let j = &joints[k];
    let mut force = [0.0; 3];
    let mut moment = [0.0; 3];
    for c in beyond(joints, k, chunks.len()) {
        let f = [0.0, -g * chunks[c].mass, 0.0];
        let r = [chunks[c].center[0] - j.centroid[0], chunks[c].center[1] - j.centroid[1], chunks[c].center[2] - j.centroid[2]];
        let m = cross(r, f);
        for i in 0..3 {
            force[i] += f[i];
            moment[i] += m[i];
        }
    }
    let area = j.bu * j.bv;
    let fn_ = dot(force, j.normal);
    let shear = ((dot(force, force) - fn_ * fn_).max(0.0)).sqrt() / area;
    let (mu, mv, t) = (dot(moment, j.u), dot(moment, j.v), dot(moment, j.normal));
    // Bending about u strains fibres along v (depth b_v): S = b_u b_v^2 / 6.
    let bend = mu.abs() / (j.bu * j.bv * j.bv / 6.0) + mv.abs() / (j.bv * j.bu * j.bu / 6.0);
    let ip = area * (j.bu * j.bu + j.bv * j.bv) / 12.0;
    let rmax = 0.5 * (j.bu * j.bu + j.bv * j.bv).sqrt();
    (fn_ / area, shear + t.abs() * rmax / ip, bend)
}

fn run(chunks: &[Chunk], joints: &[Joint]) -> Vec<(f64, f64, f64)> {
    stage_env::product();
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    let nodes: Vec<ChunkNodeDesc> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| ChunkNodeDesc {
            node_index: i as u32,
            centroid: v3(c.center),
            mass: c.mass as f32,
            volume: (8.0 * c.half[0] * c.half[1] * c.half[2]) as f32,
            geom_kind: 0,
            half_extents: v3(c.half),
            convex_points: Vec::new(),
            material: 0,
        })
        .collect();
    let bonds: Vec<ChunkBondDesc> = joints
        .iter()
        .enumerate()
        .map(|(k, j)| ChunkBondDesc {
            bond_index: k as u32,
            node0: j.a as u32,
            node1: j.b as u32,
            centroid: v3(j.centroid),
            normal: v3(j.normal),
            area: (j.bu * j.bv) as f32,
            material: 0,
        })
        .collect();
    let strong = StressMaterialDesc {
        compression_elastic: 1e12, compression_fatal: 2e12,
        tension_elastic: 1e12, tension_fatal: 2e12,
        shear_elastic: 1e12, shear_fatal: 2e12,
        elastic_modulus: 11e9, residual_area_fraction: 0.0,
    };
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: 4096, graph_reduction_level: 0,
        materials: vec![strong], crush: Vec::new(), ductile_slip: Vec::new(), impact_modulus: Vec::new(), twist_gyration: Vec::new(), twist_reach: Vec::new(), bearing_modulus: Vec::new(), bend_gyration: Vec::new(), bend_section: Vec::new(), bearing_joint: Vec::new(), maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0, apply_excess_forces: true, apply_centrifugal: true,
        excess_force_scale: 0.012, linear_damping: 0.25, angular_damping: 0.35,
    };
    world
        .native_create_destructible(0, Pose { position: Vec3::new(0.0, 10.0, 0.0), rotation: Quat::IDENTITY },
            &nodes, &bonds, settings, GROUP_CHUNK, GROUP_CHUNK)
        .unwrap();
    world.step().unwrap();
    world
        .native_configure(NativeConfig {
            max_iterations: 4096, tolerance: 1e-5,
            // SECTION_TEST_FORCE_TOLERANCE: what-if for the stopping rule.
            force_tolerance: std::env::var("SECTION_TEST_FORCE_TOLERANCE").ok().and_then(|v| v.parse().ok()).unwrap_or(1e-4),
            warm_start: true,
            damage_rate: 2.0, bend_gain_max: 3.0, fibre_bending: true,
            reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true, verdict_sample_ticks: 1,
        })
        .unwrap();
    world.step().unwrap();
    let status = world.native_tick().unwrap();
    assert!(status.error == 0 && status.converged, "solve: {status:?}");
    let mut rows = world.native_bond_stress_rows(0).unwrap();
    rows.sort_by_key(|r| r.bond_index);
    assert_eq!(rows.len(), joints.len());
    rows.iter()
        .map(|r| {
            assert!(r.native_verdict_available && !r.broken);
            (r.stress_normal as f64, r.shear as f64, r.stress_bend as f64)
        })
        .collect()
}

fn check(label: &str, chunks: &[Chunk], joints: &[Joint]) -> f64 {
    let g = -(WorldConfig::default().gravity.y as f64);
    let got = run(chunks, joints);
    let mut worst = 0.0f64;
    for (k, &(normal, shear, bend)) in got.iter().enumerate() {
        let (en, es, eb) = expected(chunks, joints, k, g);
        let rel = |a: f64, b: f64, scale: f64| (a - b).abs() / scale.max(1e-9);
        let scale = eb.max(es).max(en.abs());
        let errs = [rel(bend, eb, eb.max(1e-3 * scale)), rel(shear, es, es.max(1e-3 * scale)), rel(normal.abs(), en.abs(), scale)];
        println!(
            "{label} bond {k}: bend {bend:.4e} expected {eb:.4e} | shear+twist {shear:.4e} expected {es:.4e} | normal {normal:.3e} expected {en:.3e}"
        );
        worst = worst.max(errs.into_iter().fold(0.0, f64::max));
    }
    println!("{label}: worst relative error {worst:.2e}");
    worst
}

#[test]
#[ignore = "requires real native GPU destruction SDK"]
fn bond_stress_matches_beam_theory() {
    if std::env::var_os("SECTION_TEST_LEGACY").is_none() {
        std::env::set_var("VIBE_SECTION_BENDING", "1");
    }
    let lengths = [0.4, 1.0, 0.4, 0.6];
    // Same area (0.01 m^2), deep and flat: a joist on edge and a plank.
    let (c, j) = cantilever(&lengths, 0.05, 0.2, 0.0);
    let joist = check("joist 50x200", &c, &j);
    let (c, j) = cantilever(&lengths, 0.2, 0.05, 0.0);
    let plank = check("plank 200x50", &c, &j);
    // A sideways arm at the tip: torsion in every beam bond, and biaxial
    // bending at the arm's own joint.
    let (c, j) = cantilever(&lengths, 0.09, 0.09, 0.5);
    let twisted = check("90x90 with arm", &c, &j);
    // FP32 throughout the stage. The residual test stalls near 1e-5 on this
    // slender chain; the solve stops when a step moves the forces by 1e-4 of
    // their size (forceTolerance), and beam theory checks what that leaves.
    for (label, worst) in [("joist", joist), ("plank", plank), ("arm", twisted)] {
        assert!(worst < 2e-3, "{label}: stage stress is {worst:.3} away from beam theory");
    }
}
