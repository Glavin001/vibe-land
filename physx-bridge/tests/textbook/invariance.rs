//! Invariance: the stage's answer cannot depend on how a structure is placed
//! or described, and below capacity it is linear in the load (every mass
//! doubled doubles every answer: superposition). A statics case solved as authored, mirrored (x -> -x), turned
//! a quarter about the vertical ((x, y, z) -> (z, y, -x)), and with every
//! bond's two chunks listed the other way round (its normal reversed) must
//! grade every bond the same: axial and shear force, twist, and the graded
//! normal, shear and bending stresses. Gravity stays world -y, so the loads
//! are the same loads. Orientation bugs live exactly here (an axis swapped, a
//! sign lost on reflection, a bond's ends confused; the bond-normal oracle bug
//! f03cd6e6 was one). Blast orients every bond normal from node 0 to node 1
//! itself (NvBlastExtStressSolver.cpp, "fix normal direction"), so the
//! reversed variant tests that the order of a bond's chunks does not matter
//! (an authored normal of either sign gives the same answer). Mutation check
//! (2026-10-09): turning the chunks but not the bond patches fails 21 of 47.
//!
//! Tolerance: the suite's own (TOL, 1%) of the structure's largest force,
//! stress or twist (largest force times section size), from its exact model:
//! placing a structure differently must not move an answer by as much as the
//! suite accepts as an error. Reflection and relabelling are exact on
//! garage-clean (2026-10-09); a quarter turn sums in another FP32 order and
//! moves answers by up to 0.49% (simply-supported-udl). An orientation bug
//! (a normal read backwards, an axis swapped) moves them by O(1).

use super::cases::{self, Tier, TOL};
use super::failure::row;
use super::model::{Config, Graded, Structure, V3};
use super::stage;
use super::{Expectation, Output};

fn map(s: &Structure, f: impl Fn(V3) -> V3, half: impl Fn(V3) -> V3) -> Structure {
    let mut t = s.clone();
    for c in &mut t.chunks {
        c.center = f(c.center);
        c.half = half(c.half);
        if let Some(h) = &mut c.hull {
            for v in h.iter_mut() {
                *v = f(*v);
            }
        }
    }
    for b in &mut t.bonds {
        b.centroid = f(b.centroid);
        b.normal = f(b.normal);
        for p in &mut b.patch {
            *p = f(*p);
        }
    }
    t
}

pub fn mirrored(s: &Structure) -> Structure {
    map(s, |v| [-v[0], v[1], v[2]], |h| h)
}

pub fn quarter_turn(s: &Structure) -> Structure {
    map(s, |v| [v[2], v[1], -v[0]], |h| [h[2], h[1], h[0]])
}

pub fn bonds_reversed(s: &Structure) -> Structure {
    let mut t = s.clone();
    for b in &mut t.bonds {
        std::mem::swap(&mut b.a, &mut b.b);
        b.normal = [-b.normal[0], -b.normal[1], -b.normal[2]];
    }
    t
}

/// Every chunk twice as heavy: under a linear elastic solve below capacity,
/// every force and stress doubles (superposition).
pub fn masses_doubled(s: &Structure) -> Structure {
    let mut t = s.clone();
    for c in &mut t.chunks {
        c.mass *= 2.0;
    }
    t
}

fn doubled(rows: &[Graded]) -> Vec<Graded> {
    rows.iter().map(|g| Graded {
        normal: 2.0 * g.normal,
        shear: 2.0 * g.shear,
        bend: 2.0 * g.bend,
        tension: 2.0 * g.tension,
        compression: 2.0 * g.compression,
        axial_force: 2.0 * g.axial_force,
        shear_force: 2.0 * g.shear_force,
        twist: 2.0 * g.twist,
    }).collect()
}

fn quantities(g: &Graded) -> [f64; 6] {
    [g.axial_force, g.shear_force, g.twist, g.normal, g.shear, g.bend]
}

/// The largest difference between two solves of the same structure, on the
/// structure's own scales, taken from its exact model (the stage leaves some
/// quantities unread, NaN, and a quantity that is zero up to rounding, such as
/// axial force in a shaft in torsion, must not be measured against its own
/// noise): forces against the largest force, stresses against the largest
/// stress, twist against the largest force times the largest section's size.
/// A quantity read on one side and not the other is a difference of 1.
pub fn worst_difference(s: &Structure, exact: &[Graded], a: &[Graded], b: &[Graded]) -> f64 {
    assert_eq!(a.len(), b.len());
    let max = |f: &dyn Fn(&Graded) -> f64| exact.iter().map(|g| f(g).abs()).filter(|v| v.is_finite()).fold(0.0, f64::max);
    let force = max(&|g| g.axial_force).max(max(&|g| g.shear_force));
    let stress = max(&|g| g.normal).max(max(&|g| g.shear)).max(max(&|g| g.bend));
    let size = s.bonds.iter().map(|bond| super::model::section(bond).area.sqrt()).fold(0.0, f64::max);
    let scales = [force, force, force * size, stress, stress, stress];
    let mut worst = 0.0f64;
    for (x, y) in a.iter().zip(b) {
        let (qx, qy) = (quantities(x), quantities(y));
        for q in 0..6 {
            if qx[q].is_nan() != qy[q].is_nan() {
                worst = worst.max(1.0);
            } else if !qx[q].is_nan() && scales[q] > 0.0 {
                worst = worst.max((qx[q] - qy[q]).abs() / scales[q]);
            }
        }
    }
    worst
}

fn solve(s: &Structure) -> Vec<Graded> {
    stage::solve(s, 600, |_| true).rows
}

pub fn run(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    // Quick: a determinate beam, a fixed root, an indeterminate beam, a frame
    // with hinges, a truss and a shaft in torsion. Full: every unrotated case.
    let quick = ["cantilever-tip-load", "simply-supported-udl", "two-span-continuous", "three-hinged-frame", "pratt-truss", "torsion-round-shaft"];
    for case in cases::registry() {
        let tier = if quick.contains(&case.name.as_str()) { Tier::Quick } else { Tier::Full };
        let name = format!("invariance/{}", case.name);
        if !super::wanted(&name, tier, want) || case.structure.rotation != [0.0, 0.0, 0.0, 1.0] {
            continue;
        }
        super::guard(config, &name, expected, out, |out| {
            println!("\n{name} -- the same answer mirrored, turned and with its bonds reversed");
            let base = solve(&case.structure);
            let exact = super::model::model_graded(&case.structure, cases::G, config);
            if std::env::var_os("VERIFY_VERBOSE").is_some() {
                let again = solve(&case.structure);
                println!("  the same structure solved again: worst difference {:.2e}", worst_difference(&case.structure, &exact, &base, &again));
            }
            for (label, variant) in [
                ("mirrored (x -> -x)", mirrored(&case.structure)),
                ("turned a quarter about the vertical", quarter_turn(&case.structure)),
                ("every bond's chunks reversed", bonds_reversed(&case.structure)),
            ] {
                let other = solve(&variant);
                let worst = worst_difference(&case.structure, &exact, &base, &other);
                println!("  {label}: worst difference {worst:.2e} of the largest value");
                if std::env::var_os("VERIFY_VERBOSE").is_some() && worst > TOL {
                    let (mb, mo) = (super::model::model_graded(&case.structure, cases::G, config), super::model::model_graded(&variant, cases::G, config));
                    let names = ["axial", "shear_force", "twist", "normal", "shear", "bend"];
                    for (i, (x, y)) in base.iter().zip(&other).enumerate() {
                        let (qx, qy, ma, mv) = (quantities(x), quantities(y), quantities(&mb[i]), quantities(&mo[i]));
                        for q in 0..6 {
                            if std::env::var_os("VERIFY_VERBOSE_ALL").is_some() || ((qx[q] - qy[q]).abs() > 1e-3 * qx[q].abs().max(qy[q].abs()).max(1e-9) && (qx[q] - qy[q]).abs() > 1e-6) {
                                println!("    bond {i} {}: stage {:.6e} -> {:.6e}, model {:.6e} -> {:.6e}", names[q], qx[q], qy[q], ma[q], mv[q]);
                            }
                        }
                    }
                }
                row(config, &name, &format!("same bond answers, {label}"), "max |difference| / scale <= 1%", "invariance under reflection, rotation and relabelling", "1=yes", 1.0, f64::NAN, if worst <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
            }
            // Superposition: twice the load, twice every answer (scales: the
            // doubled structure's exact model).
            let heavier = masses_doubled(&case.structure);
            let exact2 = super::model::model_graded(&heavier, cases::G, config);
            let worst = worst_difference(&heavier, &exact2, &doubled(&base), &solve(&heavier));
            println!("  every mass doubled: worst difference from twice the answers {worst:.2e}");
            row(config, &name, "every mass doubled: every answer doubled", "max |difference| / scale <= 1%", "[Gere] 1.8 / [Hibbeler] 4.3: superposition (linear elastic, below capacity)", "1=yes", 1.0, f64::NAN, if worst <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
        });
    }
}
