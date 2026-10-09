//! Differential fuzzing: random structures, each solved by the GPU stage and
//! by the exact model of the stage's own discrete model (model.rs, f64,
//! direct). They must agree: a disagreement is an implementation bug (the
//! GPU code, an optimisation, the CuMetal translation) or a stale model, and
//! no hand-written case has to anticipate it. Every structure comes from a
//! seed; a failing seed is printed so it can be rerun alone
//! (VERIFY_FUZZ_SEED=<seed>) and shrunk into a textbook case.
//!
//! The structures are walls of axis-aligned blocks (the stage takes a bond's
//! section from the chunks' geometry, so blocks keep that exact): a random
//! grid with holes (only blocks connected to the base are kept), random block
//! size, random density per block (some heavy), and up to three materials
//! whose moduli span 200:1, the bottom row fixed to its foundation.

use super::build::*;
use super::cases::{self, Tier, TOL};
use super::failure::row;
use super::invariance::worst_difference;
use super::model::{self, Config, Material, Structure};
use super::stage;
use super::{Expectation, Output};

/// xorshift64*: deterministic, no dependencies.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    fn int(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next() % (hi - lo + 1) as u64) as usize
    }
}

/// A random wall from `seed`; also a one-line description.
pub fn random_wall(seed: u64) -> (Structure, String) {
    let mut r = Rng::new(seed);
    let (nx, ny) = (r.int(2, 8), r.int(2, 8));
    let a = r.range(0.3, 0.8);
    let hole = r.range(0.0, 0.3);
    let mut s = Structure::new();
    let moduli: Vec<f64> = (0..r.int(1, 3)).map(|_| 10f64.powf(r.range(9.0, 11.3))).collect(); // 1 to 200 GPa
    let mats: Vec<usize> = moduli.iter().map(|&e| s.material(Material::unbreakable(e))).collect();
    // Which cells exist: the base row always, the rest unless a hole.
    let mut present = vec![false; nx * ny];
    for j in 0..ny {
        for i in 0..nx {
            present[j * nx + i] = j == 0 || r.unit() >= hole;
        }
    }
    // Keep only cells connected to the base (4-neighbour flood fill).
    let mut keep = vec![false; nx * ny];
    let mut stack: Vec<usize> = (0..nx).collect();
    while let Some(c) = stack.pop() {
        if keep[c] || !present[c] {
            continue;
        }
        keep[c] = true;
        let (i, j) = (c % nx, c / nx);
        if i > 0 { stack.push(c - 1); }
        if i + 1 < nx { stack.push(c + 1); }
        if j > 0 { stack.push(c - nx); }
        if j + 1 < ny { stack.push(c + nx); }
    }
    let mut id = vec![usize::MAX; nx * ny];
    for j in 0..ny {
        for i in 0..nx {
            if !keep[j * nx + i] {
                continue;
            }
            // Density 500-3000 kg/m^3; one block in ten five times heavier.
            let rho = r.range(500.0, 3000.0) * if r.unit() < 0.1 { 5.0 } else { 1.0 };
            id[j * nx + i] = s.chunk(&format!("b{i}_{j}"), [i as f64 * a, (j as f64 + 0.5) * a, 0.0], [a / 2.0; 3], rho * a * a * a);
        }
    }
    for j in 0..ny {
        for i in 0..nx {
            let c = id[j * nx + i];
            if c == usize::MAX {
                continue;
            }
            if i + 1 < nx && id[j * nx + i + 1] != usize::MAX {
                let m = mats[r.int(0, mats.len() - 1)];
                s.rect_bond(c, id[j * nx + i + 1], [(i as f64 + 0.5) * a, (j as f64 + 0.5) * a, 0.0], X, Y, a, Z, a, m);
            }
            if j + 1 < ny && id[(j + 1) * nx + i] != usize::MAX {
                let m = mats[r.int(0, mats.len() - 1)];
                s.rect_bond(c, id[(j + 1) * nx + i], [i as f64 * a, (j + 1) as f64 * a, 0.0], Y, X, a, Z, a, m);
            }
        }
    }
    for i in 0..nx {
        let m = mats[r.int(0, mats.len() - 1)];
        fixed(&mut s, id[i], [i as f64 * a, 0.0, 0.0], [0.0, -1.0, 0.0], X, Rect { b: a, d: a }, m);
    }
    let desc = format!("{nx}x{ny} grid, {} blocks, {} bonds, block {a:.2} m, moduli {:?} GPa", s.chunks.iter().filter(|c| c.mass > 0.0).count(), s.bonds.len(), moduli.iter().map(|e| (e / 1e9 * 10.0).round() / 10.0).collect::<Vec<_>>());
    (s, desc)
}

/// Random running-bond masonry: courses of blocks 2a long, a high, every
/// other course offset by a; each block bonds to its neighbours in the course
/// and to the two blocks it straddles above, over the half-length patches
/// where they overlap. Chunk centres then sit off the bond normals (unlike a
/// stacked grid), which is where a spring length or lever arm can go wrong.
pub fn random_masonry(seed: u64) -> (Structure, String) {
    let mut r = Rng::new(seed ^ 0xA5A5_5A5A_DEAD_BEEF);
    let (courses, per) = (r.int(2, 7), r.int(2, 5));
    let a = r.range(0.2, 0.4); // block height; length 2a
    let mut s = Structure::new();
    let moduli: Vec<f64> = (0..r.int(1, 3)).map(|_| 10f64.powf(r.range(9.0, 11.3))).collect();
    let mats: Vec<usize> = moduli.iter().map(|&e| s.material(Material::unbreakable(e))).collect();
    // Course j: blocks k = 0..per (+1 on offset courses, the half blocks
    // at the ends kept whole for simplicity: they overhang by a).
    let mut rows: Vec<Vec<(usize, f64)>> = Vec::new(); // (chunk, x of its left end)
    for j in 0..courses {
        let offset = if j % 2 == 1 { -a } else { 0.0 };
        let count = per + usize::from(j % 2 == 1);
        let mut row_ids = Vec::new();
        for k in 0..count {
            let x0 = offset + k as f64 * 2.0 * a;
            let rho = r.range(1500.0, 2600.0) * if r.unit() < 0.1 { 5.0 } else { 1.0 };
            let c = s.chunk(&format!("m{k}_{j}"), [x0 + a, (j as f64 + 0.5) * a, 0.0], [a, a / 2.0, a / 2.0], rho * 2.0 * a * a * a);
            row_ids.push((c, x0));
        }
        rows.push(row_ids);
    }
    for j in 0..courses {
        // Head joints within the course.
        for k in 0..rows[j].len() - 1 {
            let (c0, x0) = rows[j][k];
            let m = mats[r.int(0, mats.len() - 1)];
            s.rect_bond(c0, rows[j][k + 1].0, [x0 + 2.0 * a, (j as f64 + 0.5) * a, 0.0], X, Y, a, Z, a, m);
        }
        // Bed joints to the course above: overlap of [x0, x0 + 2a] with each block above.
        if j + 1 < courses {
            for &(c0, x0) in &rows[j] {
                for &(c1, x1) in &rows[j + 1] {
                    let (lo, hi) = (x0.max(x1), (x0 + 2.0 * a).min(x1 + 2.0 * a));
                    if hi - lo > 1e-9 {
                        let m = mats[r.int(0, mats.len() - 1)];
                        s.rect_bond(c0, c1, [(lo + hi) / 2.0, (j + 1) as f64 * a, 0.0], Y, X, hi - lo, Z, a, m);
                    }
                }
            }
        }
    }
    for &(c, x0) in &rows[0] {
        let m = mats[r.int(0, mats.len() - 1)];
        fixed(&mut s, c, [x0 + a, 0.0, 0.0], [0.0, -1.0, 0.0], X, Rect { b: a, d: 2.0 * a }, m);
    }
    let desc = format!("masonry {courses} courses x {per}, {} blocks, {} bonds, block {:.2} x {a:.2} m, moduli {:?} GPa", s.chunks.iter().filter(|c| c.mass > 0.0).count(), s.bonds.len(), 2.0 * a, moduli.iter().map(|e| (e / 1e9 * 10.0).round() / 10.0).collect::<Vec<_>>());
    (s, desc)
}

pub fn run(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    let seeds: Vec<u64> = match std::env::var("VERIFY_FUZZ_SEED").ok().and_then(|v| v.parse().ok()) {
        Some(seed) => vec![seed],
        None => (1..=if want == Tier::Full { 200 } else { 20 }).collect(),
    };
    let name = "fuzz/random-walls";
    if !super::wanted(name, Tier::Quick, want) {
        return;
    }
    super::guard(config, name, expected, out, |out| {
        println!("\n{name} -- {} seeds, each a random stacked wall and random running-bond masonry, stage against the exact model", seeds.len());
        let mut failing = Vec::new();
        let mut worst_all = 0.0f64;
        for &seed in &seeds {
          for (s, desc) in [random_wall(seed), random_masonry(seed)] {
            let exact = model::model_graded(&s, cases::G, config);
            let stage_rows = stage::solve(&s, 600, |_| true).rows;
            // The model as the stage reads it: the stage leaves shear force
            // and twist unread (NaN).
            let readable: Vec<model::Graded> = exact.iter().zip(&stage_rows).map(|(m, st)| {
                let mut m = *m;
                if st.shear_force.is_nan() { m.shear_force = f64::NAN; }
                if st.twist.is_nan() { m.twist = f64::NAN; }
                if st.axial_force.is_nan() { m.axial_force = f64::NAN; }
                m
            }).collect();
            let worst = worst_difference(&s, &exact, &readable, &stage_rows);
            worst_all = worst_all.max(worst);
            if worst > TOL || std::env::var_os("VERIFY_VERBOSE").is_some() {
                println!("  seed {seed}: {desc}: worst difference {worst:.2e}");
            }
            if worst > TOL {
                failing.push(seed);
            }
          }
        }
        println!("  worst over all seeds {worst_all:.2e}; seeds over 1%: {failing:?}");
        row(config, name, "every random wall and masonry panel: stage = exact model", "max |stage - model| / scale <= 1% for every seed", "differential testing (the stage's own discrete model, f64)", "1=yes", 1.0, f64::NAN, if failing.is_empty() { 1.0 } else { 0.0 }, 1.0, expected, out);
    });
}
