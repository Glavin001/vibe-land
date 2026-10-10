//! Determinism: the same structure solved twice, in two fresh worlds, must
//! give bit-identical bond answers. Floating-point addition is not
//! associative, so a solve that accumulates with atomics in whatever order
//! threads arrive (StressCouplingKernels.cuh atomicAddVec) can differ in the
//! last bits from run to run; iteration amplifies them, and a bond near its
//! capacity then breaks in one run and holds in the other. Small structures
//! schedule the same way every time; the walls here grow until they do not.
//! A bit-identical solve is what makes a bit-exact comparison with a CPU
//! replica of the algorithm possible.

use super::build::*;
use super::cases::Tier;
use super::failure::row;
use super::model::{Config, Graded, Material, Structure};
use super::stage;
use super::{Expectation, Output};

/// An n x n wall of 0.5 m masonry cubes (2000 kg/m^3), each bonded to its
/// right and upper neighbour over the full face, the bottom row fixed.
pub fn wall(n: usize) -> Structure {
    let mut s = Structure::new();
    let m = s.material(Material::unbreakable(10e9));
    let a = 0.5;
    let mass = 2000.0 * a * a * a;
    let mut id = vec![0usize; n * n];
    for j in 0..n {
        for i in 0..n {
            id[j * n + i] = s.chunk(&format!("b{i}_{j}"), [i as f64 * a, (j as f64 + 0.5) * a, 0.0], [a / 2.0; 3], mass);
        }
    }
    for j in 0..n {
        for i in 0..n {
            let c = id[j * n + i];
            if i + 1 < n {
                s.rect_bond(c, id[j * n + i + 1], [(i as f64 + 0.5) * a, (j as f64 + 0.5) * a, 0.0], X, Y, a, Z, a, m);
            }
            if j + 1 < n {
                s.rect_bond(c, id[(j + 1) * n + i], [i as f64 * a, (j + 1) as f64 * a, 0.0], Y, X, a, Z, a, m);
            }
        }
        // The bottom row on its foundation.
    }
    for i in 0..n {
        fixed(&mut s, id[i], [i as f64 * a, 0.0, 0.0], [0.0, -1.0, 0.0], X, Rect { b: a, d: a }, m);
    }
    s
}

fn bits(rows: &[Graded]) -> Vec<u64> {
    rows.iter().flat_map(|g| [g.normal, g.shear, g.bend]).map(f64::to_bits).collect()
}

/// Global equilibrium of a large structure, where the exact model (a dense
/// solve) cannot go: an n x n wall fixed along its base carries its whole
/// weight through its base bonds, sum R = sum m g (Newton's first law). The
/// solve's own tolerance bounds the imbalance: ||r|| <= tol ||b|| gives
/// |sum R - W| <= tol W (Cauchy-Schwarz over the m^-1/2 row weights; PhysX
/// resident_zero_iteration_test.cuh). Up to 8,192 chunks a component is
/// solved by one threadgroup; past it (101 x 101, 10,302 chunks) by the
/// cooperative large-component kernel, which must answer as well.
fn large_equilibrium(config: Config, n: usize, ticks: u32, expected: &[Expectation], out: &mut Output) {
    let name = format!("large/wall-{n}x{n}-equilibrium");
    super::guard(config, &name, expected, out, |out| {
        let s = wall(n);
        let source = "Newton's first law: the base reactions carry the weight; |sum R - W| <= tol W";
        println!("\n{name} -- {} chunks: the base carries the wall's weight\n  {source}", s.chunks.len());
        let solved = stage::solve(&s, ticks, |_| false);
        match super::invariance::vertical_equilibrium(&s, &solved.rows) {
            Some((reaction, weight)) => {
                println!("  {} ticks, converged {} (first at tick {}); base reaction {reaction:.6e} N against the weight {weight:.6e} N ({:.3e} of it)",
                    solved.ticks, solved.converged, solved.converged_at, (reaction - weight).abs() / weight);
                row(config, &name, "base reaction = weight", "sum R = sum m g", source, "N", weight, weight, reaction, weight, expected, out);
                row(config, &name, "the solve converges within the run", "converged", source, "1=yes", 1.0, f64::NAN, if solved.converged { 1.0 } else { 0.0 }, 1.0, expected, out);
            }
            None => println!("  no vertical base bonds to read"),
        }
    });
}

pub fn run(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    for (n, tier) in [(30usize, Tier::Quick), (60, Tier::Full), (101, Tier::Full)] {
        if super::wanted(&format!("large/wall-{n}x{n}-equilibrium"), tier, want) {
            large_equilibrium(config, n, 600, expected, out);
        }
    }
    if super::wanted("determinism/impact", Tier::Quick, want) {
        impact_twice(config, expected, out);
    }
    // 101 x 101 (10,302 chunks) is past the 8,192-node threshold where the
    // stage switches to its cooperative large-component kernel.
    for (n, tier) in [(10usize, Tier::Quick), (30, Tier::Quick), (60, Tier::Full), (101, Tier::Full)] {
        let name = format!("determinism/wall-{n}x{n}");
        if !super::wanted(&name, tier, want) {
            continue;
        }
        super::guard(config, &name, expected, out, |out| {
            let s = wall(n);
            println!("\n{name} -- {} chunks, {} bonds, solved twice in fresh worlds", s.chunks.len(), s.bonds.len());
            let first = stage::solve(&s, 600, |_| true);
            let second = stage::solve(&s, 600, |_| true);
            let (a, b) = (bits(&first.rows), bits(&second.rows));
            let differing = a.iter().zip(&b).filter(|(x, y)| x != y).count();
            let scale = first.rows.iter().flat_map(|g| [g.normal.abs(), g.shear.abs(), g.bend.abs()]).fold(0.0, f64::max);
            let worst = first.rows.iter().zip(&second.rows)
                .flat_map(|(x, y)| [(x.normal - y.normal).abs(), (x.shear - y.shear).abs(), (x.bend - y.bend).abs()])
                .fold(0.0, f64::max) / scale.max(f64::MIN_POSITIVE);
            println!("  converged at ticks {} and {}; {differing} of {} values differ in their bits; worst difference {worst:.2e} of the largest stress", first.converged_at, second.converged_at, a.len());
            row(config, &name, "the same solve twice: bit-identical", "every graded stress equal to the bit", "determinism (no order-dependent accumulation)", "1=yes", 1.0, f64::NAN, if differing == 0 { 1.0 } else { 0.0 }, 1.0, expected, out);
        });
    }
}

/// The same impact twice: a ball into a 12 x 12 wall on weak joints, in two
/// fresh worlds. PhysX does the dynamics (contacts, integration) and the stage
/// the fractures; every tick's broken bonds and, at the end, every body's
/// position must be identical to the bit for the whole to be deterministic.
/// The first tick that differs names the layer.
pub fn impact_twice(config: Config, expected: &[Expectation], out: &mut Output) {
    let name = "determinism/impact";
    let build = || {
        let n = 12;
        let mut s = wall(n);
        // 1 MPa joints: the wall stands; a 200 kg ball at 15 m/s breaks 111
        // of its 264 bonds into 43 bodies (a partial collapse, many events).
        s.materials[0] = Material { modulus: 10e9, compression: 1e13, tension: 1e6, shear: 1e6 };
        s
    };
    let run = || {
        let s = build();
        let mut world = stage::build(&s);
        super::dynamics::launch_ball(&mut world, 9201, [2.75, 23.0, -2.0], 0.3, 200.0, [0.0, 0.0, 15.0]);
        let mut events: Vec<(u32, Vec<u32>)> = Vec::new();
        stage::run_ticks(&mut world, 90, |t, _, broken, _| {
            if !broken.is_empty() {
                let mut b = broken.to_vec();
                b.sort_unstable();
                events.push((t, b));
            }
            false
        });
        let mut poses: Vec<[u32; 3]> = world.native_chunk_body_snapshots().map(|s| s.iter().map(|b| [b.position.x.to_bits(), b.position.y.to_bits(), b.position.z.to_bits()]).collect()).unwrap_or_default();
        poses.sort_unstable();
        (events, poses)
    };
    super::guard(config, name, expected, out, |out| {
        println!("\n{name} -- a ball into a 12 x 12 wall on weak joints, twice in fresh worlds");
        let (e1, p1) = run();
        let (e2, p2) = run();
        let first_diff = e1.iter().zip(&e2).position(|(a, b)| a != b).map(|i| e1[i].0.min(e2[i].0));
        println!("  run 1: {} breaking ticks, {} bonds, {} bodies; run 2: {} ticks, {} bonds, {} bodies; first differing break tick {first_diff:?}; final poses identical {}",
            e1.len(), e1.iter().map(|e| e.1.len()).sum::<usize>(), p1.len(), e2.len(), e2.iter().map(|e| e.1.len()).sum::<usize>(), p2.len(), p1 == p2);
        row(config, name, "the same impact twice: the same bonds break on the same ticks", "every tick's broken bonds equal", "determinism (dynamics + fracture)", "1=yes", 1.0, f64::NAN, if e1 == e2 { 1.0 } else { 0.0 }, 1.0, expected, out);
        row(config, name, "the same impact twice: bit-identical final poses", "every body's position equal to the bit", "determinism (dynamics + fracture)", "1=yes", 1.0, f64::NAN, if p1 == p2 { 1.0 } else { 0.0 }, 1.0, expected, out);
    });
}
