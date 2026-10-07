#![cfg(feature = "native-destruction")]

//! Load sharing that depends on each bond's rotational stiffness, through the
//! native stage, against the stiffness method.
//!
//! A beam of two unequal chunks spans two anchored supports: a deep one at the
//! left (the beam's whole 300 x 100 face) and a shallow bearing at the right
//! (60 x 100). The structure is statically indeterminate, so how the weight
//! splits between shear and bond moments -- and so every bond's bending and
//! twist stress -- depends on how stiff each bond is in rotation as well as in
//! translation. The stage's stress solve is the minimum of the bonds'
//! complementary energy, sum |F|^2/k + M' K_rot^-1 M, which is exactly the
//! elastic answer of a frame of springs: each bond a spring at its face with
//! translational stiffness k = E A / L (the bridge's complianceScale^2) and,
//! from its section, rotational stiffness k I / A about each principal axis of
//! the patch and k I_p / A in twist.
//!
//! Here that frame is solved independently, in f64, by the stiffness method
//! (assemble K = sum G' S G over the chunks' rigid motions, solve K q = f), and
//! the bond wrenches are graded with the stage's own section formula.
//!
//! Two models of the solve, two runs:
//!   VIBE_SECTION_ROTATION=1  each bond's rotational stiffness from its own
//!                            section, its spring at the bond face. The stage
//!                            must match this (the physics).
//!   unset                    today's solve: every bond's rotation weighted by
//!                            one length scale for the whole structure (the
//!                            mean bond offset Ls, k Ls^2 on every axis), and a
//!                            bond between two dynamic chunks sprung at their
//!                            midpoint. The stage must match THIS model, and
//!                            the test prints how far it is from the physics.
//!
//! cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test section_rotation -- --ignored --test-threads=1 --nocapture
//! VIBE_SECTION_ROTATION=1 cargo test ... (same)

#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat,
    StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const MODULUS: f64 = 11e9;
const REFERENCE_MODULUS: f64 = 30e9;

struct Chunk {
    center: [f64; 3],
    half: [f64; 3],
    mass: f64,
}

/// A bond through the face at `centroid` with `normal`; the patch is `bu`
/// along `u` by `bv` along `v` (u x v = normal), centred on the centroid.
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
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}

/// Support L | beam A (1.4 m) | beam B (0.6 m) | bearing R, along +x. The beam
/// is 300 deep (y) by 100 wide (z). The left support takes the whole face; the
/// right bearing is 60 deep, centred, so its patch is 60 x 100. `arm`: a side
/// arm off A's +z face at mid-length, which twists the beam.
fn propped_beam(arm: f64) -> (Vec<Chunk>, Vec<Joint>) {
    let rho = 600.0;
    let (depth, width) = (0.3, 0.1);
    let (hy, hz) = (depth / 2.0, width / 2.0);
    let mass = |h: [f64; 3]| rho * 8.0 * h[0] * h[1] * h[2];
    let along = ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0]); // u x v = +x
    let mut chunks = vec![
        Chunk { center: [-0.25, 0.0, 0.0], half: [0.25, hy, hz], mass: 0.0 },
        Chunk { center: [0.7, 0.0, 0.0], half: [0.7, hy, hz], mass: mass([0.7, hy, hz]) },
        Chunk { center: [1.7, 0.0, 0.0], half: [0.3, hy, hz], mass: mass([0.3, hy, hz]) },
        Chunk { center: [2.2, 0.0, 0.0], half: [0.2, 0.03, hz], mass: 0.0 },
    ];
    let mut joints = vec![
        Joint { a: 0, b: 1, centroid: [0.0, 0.0, 0.0], normal: [1.0, 0.0, 0.0], u: along.0, v: along.1, bu: depth, bv: width },
        Joint { a: 1, b: 2, centroid: [1.4, 0.0, 0.0], normal: [1.0, 0.0, 0.0], u: along.0, v: along.1, bu: depth, bv: width },
        Joint { a: 2, b: 3, centroid: [2.0, 0.0, 0.0], normal: [1.0, 0.0, 0.0], u: along.0, v: along.1, bu: 0.06, bv: width },
    ];
    if arm > 0.0 {
        // 100 long (x), as deep as the beam, off A's +z face at x = 0.7.
        let h = [0.05, hy, arm / 2.0];
        chunks.push(Chunk { center: [0.7, 0.0, hz + arm / 2.0], half: h, mass: mass(h) });
        joints.push(Joint {
            a: 1, b: 4, centroid: [0.7, 0.0, hz], normal: [0.0, 0.0, 1.0],
            u: [1.0, 0.0, 0.0], v: [0.0, 1.0, 0.0], bu: 0.1, bv: depth,
        });
    }
    (chunks, joints)
}

/// The bridge's bond stiffness k = complianceScale^2 (append_bonds, non-vehicle).
/// Today: (E / E_ref) max(A, 1e-4) / max(d, 0.05), d between the chunks'
/// centres. With VIBE_SECTION_ROTATION=1 the stiffness the section is graded
/// with: (E / E_ref) A / max(d_n, sqrt(A)), no floors, d_n the centres'
/// separation along the bond normal (the contact length: a flat contact is
/// E sqrt(A) stiff). The geometric-mean normalisation cancels.
fn stiffness(chunks: &[Chunk], j: &Joint, model: Model) -> f64 {
    let d = norm(sub(chunks[j.a].center, chunks[j.b].center));
    let a = j.bu * j.bv;
    match model {
        Model::Section => MODULUS / REFERENCE_MODULUS * a / dot(j.normal, sub(chunks[j.b].center, chunks[j.a].center)).abs().max(a.sqrt()),
        Model::Uniform => MODULUS / REFERENCE_MODULUS * a.max(1e-4) / d.max(0.05),
    }
}

/// The fidelity audit's A4 case (docs/verification/FIDELITY_AUDIT.md): a 1 t
/// block hung from three anchors by three dynamic, near-weightless 40 mm hangers, 0.5 m long,
/// at x = -0.3, 0, 0.3; bonds of 2, 0.4 (a sliver) and 2 cm^2 at each end.
/// Sprung at the midpoint of two dynamic chunks (today), the outer hangers'
/// springs sit 0.15 m off their bond lines and gain a lever arm; sprung at the
/// bond faces (VIBE_SECTION_ROTATION=1) they do not.
fn hangers() -> (Vec<Chunk>, Vec<Joint>) {
    let mut chunks = vec![Chunk { center: [0.0, 0.0, 0.0], half: [0.5, 0.05, 0.1], mass: 1000.0 }];
    let mut joints = Vec::new();
    for (k, area) in [2e-4, 4e-5, 2e-4].into_iter().enumerate() {
        let x = 0.3 * (k as f64 - 1.0);
        let side = (area as f64).sqrt();
        // 10 g: the textbook's bars are weightless (a soft sliver hanger
        // otherwise passes its own weight down into the block).
        chunks.push(Chunk { center: [x, 0.30, 0.0], half: [0.02, 0.25, 0.02], mass: 0.01 });
        let hanger = chunks.len() - 1;
        chunks.push(Chunk { center: [x, 0.60, 0.0], half: [0.05, 0.05, 0.05], mass: 0.0 });
        let anchor = chunks.len() - 1;
        let (u, v) = ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0]);
        joints.push(Joint { a: 0, b: hanger, centroid: [x, 0.05, 0.0], normal: [0.0, 1.0, 0.0], u, v, bu: side, bv: side });
        joints.push(Joint { a: hanger, b: anchor, centroid: [x, 0.55, 0.0], normal: [0.0, 1.0, 0.0], u, v, bu: side, bv: side });
    }
    (chunks, joints)
}

/// A 1.0 x 0.04 x 0.4 m slab on three anchored pads 0.04 m thick, at
/// x = -0.4, 0, 0.4: 100 x 100, 8 x 8 and 50 x 50 mm. Three supports make the
/// vertical load sharing depend on each pad's stiffness; the pads' centres are
/// 0.04 m from the slab's, under today's 0.05 m length floor and under the big
/// pads' contact length sqrt(A), and the small pad's 64 mm^2 is under today's
/// 1e-4 m^2 area floor.
fn slab_on_pads() -> (Vec<Chunk>, Vec<Joint>) {
    let rho = 2400.0;
    let mut chunks = vec![Chunk { center: [0.0, 0.0, 0.0], half: [0.5, 0.02, 0.2], mass: rho * 1.0 * 0.04 * 0.4 }];
    let mut joints = Vec::new();
    for (x, side) in [(-0.4, 0.1), (0.0, 0.008), (0.4, 0.05)] {
        chunks.push(Chunk { center: [x, -0.04, 0.0], half: [side / 2.0, 0.02, side / 2.0], mass: 0.0 });
        joints.push(Joint {
            a: 0, b: chunks.len() - 1, centroid: [x, -0.02, 0.0], normal: [0.0, -1.0, 0.0],
            u: [0.0, 0.0, 1.0], v: [1.0, 0.0, 0.0], bu: side, bv: side,
        });
    }
    (chunks, joints)
}

#[derive(Clone, Copy, PartialEq)]
enum Model {
    /// Each bond's own section: k I/A per principal axis, k I_p/A in twist,
    /// sprung at the bond face.
    Section,
    /// Today's solve: k Ls^2 on every axis (Ls the mean bond offset), a bond
    /// between two dynamic chunks sprung at their midpoint.
    Uniform,
}

/// The solver's length scale: the mean distance from each bond's dynamic
/// endpoints to the point its offsets name (the face for a bond to an anchor,
/// the midpoint between two dynamic chunks).
fn length_scale(chunks: &[Chunk], joints: &[Joint]) -> f64 {
    let (mut sum, mut n) = (0.0, 0.0);
    for j in joints {
        let (pa, pb) = (chunks[j.a].center, chunks[j.b].center);
        let (da, db) = (chunks[j.a].mass > 0.0, chunks[j.b].mass > 0.0);
        let half = 0.5 * norm(sub(pb, pa));
        if da {
            sum += if db { half } else { norm(sub(j.centroid, pa)) };
            n += 1.0;
        }
        if db {
            sum += if da { half } else { norm(sub(j.centroid, pb)) };
            n += 1.0;
        }
    }
    sum / n
}

/// Solve dense A x = b (partial pivoting).
fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &k| a[i][c].abs().total_cmp(&a[k][c].abs())).unwrap();
        a.swap(c, p);
        b.swap(c, p);
        assert!(a[c][c].abs() > 1e-300, "singular stiffness");
        for r in c + 1..n {
            let f = a[r][c] / a[c][c];
            if f == 0.0 {
                continue;
            }
            for k in c..n {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let mut s = b[r];
        for k in r + 1..n {
            s -= a[r][k] * x[k];
        }
        x[r] = s / a[r][r];
    }
    x
}

/// Each bond's wrench on chunk b, about the bond's centroid: (force, moment).
fn frame_wrenches(chunks: &[Chunk], joints: &[Joint], g: f64, model: Model) -> Vec<([f64; 3], [f64; 3])> {
    // Six DOFs per dynamic chunk: translation, then rotation about its centre.
    let mut dof = vec![usize::MAX; chunks.len()];
    let mut n = 0;
    for (i, c) in chunks.iter().enumerate() {
        if c.mass > 0.0 {
            dof[i] = n;
            n += 6;
        }
    }
    let ls = length_scale(chunks, joints);
    // Per bond: the spring's point X, its 3x3 rotational stiffness, its k.
    let springs: Vec<([f64; 3], [[f64; 3]; 3], f64)> = joints
        .iter()
        .map(|j| {
            let k = stiffness(chunks, j, model);
            let (pa, pb) = (chunks[j.a].center, chunks[j.b].center);
            let both = chunks[j.a].mass > 0.0 && chunks[j.b].mass > 0.0;
            let mut rot = [[0.0; 3]; 3];
            let point = match model {
                Model::Section => {
                    // I about u strains fibres along v: bu bv^3 / 12; about v: bv bu^3 / 12.
                    let area = j.bu * j.bv;
                    let (iu, iv) = (j.bu * j.bv.powi(3) / 12.0, j.bv * j.bu.powi(3) / 12.0);
                    for (axis, i) in [(j.u, iu), (j.v, iv), (j.normal, iu + iv)] {
                        for r in 0..3 {
                            for c in 0..3 {
                                rot[r][c] += k * i / area * axis[r] * axis[c];
                            }
                        }
                    }
                    j.centroid
                }
                Model::Uniform => {
                    for r in 0..3 {
                        rot[r][r] = k * ls * ls;
                    }
                    if both { [0.5 * (pa[0] + pb[0]), 0.5 * (pa[1] + pb[1]), 0.5 * (pa[2] + pb[2])] } else { j.centroid }
                }
            };
            (point, rot, k)
        })
        .collect();
    // G maps q to the bond's relative motion [phi; delta] = motion of b - motion of a
    // at X: delta = t + theta x (X - p) = t - [X - p]x theta.
    let gmat = |j: &Joint, x: [f64; 3]| -> Vec<Vec<f64>> {
        let mut gm = vec![vec![0.0; n]; 6];
        for (chunk, sign) in [(j.a, -1.0), (j.b, 1.0)] {
            if dof[chunk] == usize::MAX {
                continue;
            }
            let d = dof[chunk];
            let r = sub(x, chunks[chunk].center);
            for i in 0..3 {
                gm[i][d + 3 + i] += sign; // phi = theta_b - theta_a
                gm[3 + i][d + i] += sign; // delta from t
            }
            // theta x r = -[r]x theta: rows of -[r]x.
            let skew = [[0.0, r[2], -r[1]], [-r[2], 0.0, r[0]], [r[1], -r[0], 0.0]];
            for i in 0..3 {
                for c in 0..3 {
                    gm[3 + i][d + 3 + c] += sign * skew[i][c];
                }
            }
        }
        gm
    };
    let mut kmat = vec![vec![0.0; n]; n];
    let mut gs = Vec::new();
    for (j, &(x, rot, k)) in joints.iter().zip(&springs) {
        let gm = gmat(j, x);
        let mut s = [[0.0; 6]; 6];
        for r in 0..3 {
            for c in 0..3 {
                s[r][c] = rot[r][c];
            }
            s[3 + r][3 + r] = k;
        }
        for a in 0..n {
            for b in 0..n {
                let mut v = 0.0;
                for r in 0..6 {
                    if gm[r][a] == 0.0 {
                        continue;
                    }
                    for c in 0..6 {
                        v += gm[r][a] * s[r][c] * gm[c][b];
                    }
                }
                kmat[a][b] += v;
            }
        }
        gs.push((gm, s));
    }
    let mut f = vec![0.0; n];
    for (i, c) in chunks.iter().enumerate() {
        if c.mass > 0.0 {
            f[dof[i] + 1] = -g * c.mass;
        }
    }
    let q = solve_dense(kmat, f);
    joints
        .iter()
        .zip(&gs)
        .zip(&springs)
        .map(|((j, (gm, s)), &(x, _, _))| {
            let mut motion = [0.0; 6];
            for r in 0..6 {
                motion[r] = (0..n).map(|c| gm[r][c] * q[c]).sum();
            }
            let mut w = [0.0; 6];
            for r in 0..6 {
                w[r] = -(0..6).map(|c| s[r][c] * motion[c]).sum::<f64>();
            }
            let force = [w[3], w[4], w[5]];
            let at_x = [w[0], w[1], w[2]];
            // Moved from X to the centroid: the force at X adds (X - c) x F.
            let shift = cross(sub(x, j.centroid), force);
            (force, [at_x[0] + shift[0], at_x[1] + shift[1], at_x[2] + shift[2]])
        })
        .collect()
}

/// The stage's grading of a wrench about the bond's centroid, with the
/// rectangle's section: (normal, shear + twist, bending fibre).
fn graded(j: &Joint, force: [f64; 3], moment: [f64; 3]) -> (f64, f64, f64) {
    let area = j.bu * j.bv;
    let fn_ = dot(force, j.normal);
    let shear = (dot(force, force) - fn_ * fn_).max(0.0).sqrt() / area;
    let (mu, mv, t) = (dot(moment, j.u), dot(moment, j.v), dot(moment, j.normal));
    let bend = mu.abs() / (j.bu * j.bv * j.bv / 6.0) + mv.abs() / (j.bv * j.bu * j.bu / 6.0);
    let ip = area * (j.bu * j.bu + j.bv * j.bv) / 12.0;
    let rmax = 0.5 * (j.bu * j.bu + j.bv * j.bv).sqrt();
    (fn_ / area, shear + t.abs() * rmax / ip, bend)
}

fn run(chunks: &[Chunk], joints: &[Joint], bend_gain_max: f32) -> Vec<(f64, f64, f64)> {
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
        elastic_modulus: MODULUS as f32, residual_area_fraction: 0.0,
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
            max_iterations: 4096, tolerance: 1e-6, force_tolerance: 1e-5, warm_start: true,
            damage_rate: 2.0, bend_gain_max, fibre_bending: true,
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
    // SECTION_ROTATION_DUMP=path: the exact bits of every bond's exported
    // wrench and graded stresses, appended -- two SDKs' runs diff byte for byte.
    if let Some(path) = std::env::var_os("SECTION_ROTATION_DUMP") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        let forces = world.native_export_warm_start().unwrap();
        writeln!(f, "forces {}", forces.iter().map(|v| format!("{:08x}", v.to_bits())).collect::<Vec<_>>().join(" ")).unwrap();
        for r in &rows {
            writeln!(f, "bond {} {:08x} {:08x} {:08x}", r.bond_index, r.stress_normal.to_bits(), r.shear.to_bits(), r.stress_bend.to_bits()).unwrap();
        }
    }
    rows.iter()
        .map(|r| {
            assert!(r.native_verdict_available && !r.broken);
            (r.stress_normal as f64, r.shear as f64, r.stress_bend as f64)
        })
        .collect()
}

/// Worst error of `got` against `want`, each stress relative to the bond's
/// largest stress (a component near zero is judged against that, not itself).
fn worst(got: &[(f64, f64, f64)], want: &[(f64, f64, f64)]) -> f64 {
    got.iter()
        .zip(want)
        .map(|(&(n, s, b), &(en, es, eb))| {
            let scale = en.abs().max(es).max(eb).max(1e-9);
            [(n.abs() - en.abs()).abs(), (s - es).abs(), (b - eb).abs()].into_iter().fold(0.0, f64::max) / scale
        })
        .fold(0.0, f64::max)
}

fn case(label: &str, chunks: &[Chunk], joints: &[Joint], rotation: bool) -> (f64, f64) {
    let g = -(WorldConfig::default().gravity.y as f64);
    let expect = |model| {
        frame_wrenches(chunks, joints, g, model)
            .into_iter()
            .zip(joints)
            .map(|((f, m), j)| graded(j, f, m))
            .collect::<Vec<_>>()
    };
    let (section, uniform) = (expect(Model::Section), expect(Model::Uniform));
    let got = run(chunks, joints, 3.0);
    println!("{label}: Ls {:.3} m", length_scale(chunks, joints));
    for (k, ((g, s), u)) in got.iter().zip(&section).zip(&uniform).enumerate() {
        println!(
            "  bond {k}: stage normal {:.4e} shear {:.4e} bend {:.4e} | section {:.4e} {:.4e} {:.4e} | uniform {:.4e} {:.4e} {:.4e}",
            g.0, g.1, g.2, s.0, s.1, s.2, u.0, u.1, u.2
        );
    }
    let (to_section, to_uniform) = (worst(&got, &section), worst(&got, &uniform));
    println!(
        "{label} ({}): worst error against the section model {to_section:.2e}, against the uniform model {to_uniform:.2e}; the two models differ by {:.2e}",
        if rotation { "VIBE_SECTION_ROTATION=1" } else { "uniform length scale" },
        worst(&section, &uniform)
    );
    (to_section, to_uniform)
}

#[test]
#[ignore = "requires real native GPU destruction SDK"]
fn bond_rotation_shares_load_by_section() {
    // Real-section grading in both runs: the comparison is the solve.
    // SECTION_TEST_DEFAULT=1: the engine's default path (no section bending),
    // for SECTION_ROTATION_DUMP byte comparisons only; nothing is asserted.
    let default_path = std::env::var_os("SECTION_TEST_DEFAULT").is_some();
    if !default_path {
        std::env::set_var("VIBE_SECTION_BENDING", "1");
    }
    let rotation = std::env::var("VIBE_SECTION_ROTATION").map(|v| v != "0").unwrap_or(false);
    let (c, j) = propped_beam(0.0);
    let planar = case("propped beam", &c, &j, rotation);
    let (c, j) = propped_beam(0.6);
    let arm = case("propped beam with a side arm", &c, &j, rotation);
    let (c, j) = slab_on_pads();
    let pads = case("slab on three pads", &c, &j, rotation);
    let (c, j) = hangers();
    let hung = case("block on three dynamic hangers", &c, &j, rotation);
    if rotation {
        // Textbook (Gere & Goodno 2.4, parallel bars of one length): the block's
        // hangers share its weight in proportion to area, one stress W / sum A.
        let got = run(&c, &j, 3.0);
        let w = 1000.0 * -(WorldConfig::default().gravity.y as f64);
        let want = w / (2e-4 + 4e-5 + 2e-4);
        for k in [0, 2, 4] {
            let e = (got[k].0.abs() - want).abs() / want;
            println!("  hanger {}: lower bond {:.4e} Pa, textbook {want:.4e} ({:.2}%)", k / 2, got[k].0.abs(), 100.0 * e);
            assert!(e < 0.01, "hanger {} is {:.2}% from W / sum A", k / 2, 100.0 * e);
        }
    }
    for (label, (to_section, to_uniform)) in [("planar", planar), ("arm", arm), ("pads", pads), ("hangers", hung)] {
        if default_path {
            continue;
        }
        if rotation {
            assert!(to_section < 2e-3, "{label}: stage is {to_section:.3} away from the section stiffness model");
        } else {
            // Today's solve is the uniform model, and the uniform model is not
            // the physics: shown, not assumed.
            assert!(to_uniform < 2e-3, "{label}: stage is {to_uniform:.3} away from the uniform-length-scale model");
            assert!(to_section > 0.1, "{label}: the uniform length scale should misplace load ({to_section:.3})");
        }
    }
}

/// With real sections no bending gain is capped: the configured
/// bend_gain_max (3 /m everywhere, the old cap) must change nothing.
#[test]
#[ignore = "requires real native GPU destruction SDK"]
fn bend_gain_cap_unused_with_sections() {
    std::env::set_var("VIBE_SECTION_BENDING", "1");
    let (c, j) = propped_beam(0.6);
    let capped = run(&c, &j, 3.0);
    let tiny = run(&c, &j, 0.01);
    let huge = run(&c, &j, 1e6);
    for k in 0..j.len() {
        println!("bond {k}: gain 3 {:?} | 0.01 {:?} | 1e6 {:?}", capped[k], tiny[k], huge[k]);
    }
    assert_eq!(capped, tiny, "bend_gain_max changed a section stress");
    assert_eq!(capped, huge, "bend_gain_max changed a section stress");
}
