//! Invariance: the stage's answer cannot depend on how a structure is placed
//! or described, below capacity it is linear in the load (every mass doubled
//! doubles every answer: superposition), and it scales as dimensional
//! analysis says (twice the size: forces 8x, stresses 2x, twist 16x). The
//! last one is how a grading formula with the wrong units shows: runtime's
//! capped grade fails it on 21 of 23 cases, the exact model with it. A statics case solved as authored, mirrored (x -> -x), turned
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

/// Twice the size, same materials: every length doubled, every chunk 8x the
/// mass (same density). Under self-weight, linear elasticity scales forces by
/// 8 (weight), stresses by 2 (sigma ~ rho g L) and twist by 16 (force x
/// length): dimensional analysis ([Gere] 1.8 / Buckingham Pi).
pub fn twice_the_size(s: &Structure) -> Structure {
    let mut t = map(s, |v| [2.0 * v[0], 2.0 * v[1], 2.0 * v[2]], |h| [2.0 * h[0], 2.0 * h[1], 2.0 * h[2]]);
    // map() turns normals with the points; a normal is a direction.
    for (b, o) in t.bonds.iter_mut().zip(&s.bonds) {
        b.normal = o.normal;
    }
    for c in &mut t.chunks {
        c.mass *= 8.0;
    }
    t
}

fn scaled(rows: &[Graded], force: f64, stress: f64, twist: f64) -> Vec<Graded> {
    rows.iter().map(|g| Graded {
        normal: stress * g.normal,
        shear: stress * g.shear,
        bend: stress * g.bend,
        tension: stress * g.tension,
        compression: stress * g.compression,
        axial_force: force * g.axial_force,
        shear_force: force * g.shear_force,
        twist: twist * g.twist,
    }).collect()
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

/// Global equilibrium (Newton's first law): a structure at rest is held up by
/// its supports with exactly its weight. The vertical reaction on the
/// structure through an anchor bond is its axial force (tension +) times the
/// unit normal pointing from the structure's chunk to the anchor, vertical
/// part: tension pulls the structure toward its anchor, compression pushes it
/// away. Shear's direction is not read, so only structures whose every anchor
/// bond is horizontal (vertical normal) are checked. Returns (sum of the
/// vertical reactions, total weight), or None when not applicable.
pub fn vertical_equilibrium(s: &Structure, rows: &[Graded]) -> Option<(f64, f64)> {
    let mut reaction = 0.0;
    let mut anchored = false;
    for (bond, g) in s.bonds.iter().zip(rows) {
        let (ma, mb) = (s.chunks[bond.a].mass, s.chunks[bond.b].mass);
        if (ma == 0.0) == (mb == 0.0) {
            continue; // both dynamic (internal) or both anchors
        }
        anchored = true;
        if bond.normal[1].abs() < 1.0 - 1e-9 || !g.axial_force.is_finite() {
            return None;
        }
        let (anchor, member) = if ma == 0.0 { (bond.a, bond.b) } else { (bond.b, bond.a) };
        let toward = s.chunks[anchor].center[1] - s.chunks[member].center[1];
        reaction += g.axial_force * toward.signum();
    }
    let weight = s.chunks.iter().map(|c| c.mass).sum::<f64>() * cases::G;
    anchored.then_some((reaction, weight))
}

/// Rotational equilibrium (Newton's first law for rotation): the support
/// reactions' moment about the vertical-plane axes equals the weight's,
/// sum R_i x_i = sum m_i g x_i and the same in z. Joints at the anchors can
/// carry a moment the stage does not read with its sign, so the check applies
/// only where the exact model's reactions balance the weight's moment to a
/// tenth of the tolerance (pins and rollers; not a fixed base). Returns ([reaction moment x, z],
/// [weight moment x, z], scale = weight x the structure's horizontal extent).
pub fn moment_equilibrium(s: &Structure, rows: &[Graded]) -> Option<([f64; 2], [f64; 2], f64)> {
    let mut reaction = [0.0; 2];
    let mut anchored = false;
    for (bond, g) in s.bonds.iter().zip(rows) {
        let (ma, mb) = (s.chunks[bond.a].mass, s.chunks[bond.b].mass);
        if (ma == 0.0) == (mb == 0.0) {
            continue;
        }
        anchored = true;
        if bond.normal[1].abs() < 1.0 - 1e-9 || !g.axial_force.is_finite() {
            return None;
        }
        let (anchor, member) = if ma == 0.0 { (bond.a, bond.b) } else { (bond.b, bond.a) };
        let r = g.axial_force * (s.chunks[anchor].center[1] - s.chunks[member].center[1]).signum();
        reaction[0] += r * bond.centroid[0];
        reaction[1] += r * bond.centroid[2];
    }
    let weight = [
        s.chunks.iter().map(|c| c.mass * cases::G * c.center[0]).sum::<f64>(),
        s.chunks.iter().map(|c| c.mass * cases::G * c.center[2]).sum::<f64>(),
    ];
    let extent = |k: usize| {
        let (lo, hi) = s.chunks.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), c| (lo.min(c.center[k] - c.half[k]), hi.max(c.center[k] + c.half[k])));
        hi - lo
    };
    let scale = s.chunks.iter().map(|c| c.mass).sum::<f64>() * cases::G * extent(0).max(extent(2));
    anchored.then_some((reaction, weight, scale))
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
            // A stage that carries no load (zeros everywhere) would compare
            // equal to itself in every variant: no answer, nothing proved.
            let peak = |rows: &[Graded]| rows.iter().flat_map(|g| [g.normal, g.shear, g.bend]).filter(|v| v.is_finite()).map(f64::abs).fold(0.0, f64::max);
            let answered = peak(&base) >= TOL * peak(&exact);
            if !answered {
                println!("  the stage's largest stress {:.3e} is under 1% of the exact model's {:.3e}: no answer to compare", peak(&base), peak(&exact));
            }
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
                row(config, &name, &format!("same bond answers, {label}"), "max |difference| / scale <= 1%", "invariance under reflection, rotation and relabelling", "1=yes", 1.0, f64::NAN, if answered && worst <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
            }
            if let (Some((stage_r, weight)), Some((model_r, _))) = (vertical_equilibrium(&case.structure, &base), vertical_equilibrium(&case.structure, &exact)) {
                println!("  equilibrium: support reactions {stage_r:.6e} N (exact model {model_r:.6e}) against the weight {weight:.6e} N");
                row(config, &name, "support reactions carry the whole weight", "sum R_y = sum m g", "[Hibbeler] 5.3 / Newton's first law: a body at rest", "kN", weight * 1e-3, model_r * 1e-3, stage_r * 1e-3, weight * 1e-3, expected, out);
            }
            if let (Some((stage_m, weight_m, scale)), Some((model_m, _, _))) = (moment_equilibrium(&case.structure, &base), moment_equilibrium(&case.structure, &exact)) {
                let off = |m: [f64; 2]| (m[0] - weight_m[0]).abs().max((m[1] - weight_m[1]).abs()) / scale;
                // The supports' own moment (unread) must sit a decade under
                // the tolerance so it cannot decide the check: 2 cm pin strips
                // carry ~1e-4 of W x extent, a fixed base ~0.2.
                if off(model_m) <= TOL / 10.0 {
                    println!("  moment equilibrium: reactions {:.6e}, {:.6e} N m (exact model {:.6e}, {:.6e}) against the weight's {:.6e}, {:.6e}", stage_m[0], stage_m[1], model_m[0], model_m[1], weight_m[0], weight_m[1]);
                    row(config, &name, "support reactions balance the weight's moment", "sum R x = sum m g x (about both horizontal axes)", "[Hibbeler] 5.3 / Newton's first law for rotation", "1=yes", 1.0, f64::NAN, if answered && off(stage_m) <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
                    println!("    off by {:.2e} of W x extent", off(stage_m));
                } else {
                    println!("  moment equilibrium: not applicable (the anchors carry moment: the exact model's reactions miss by {:.2e})", off(model_m));
                }
            }
            // Superposition: twice the load, twice every answer (scales: the
            // doubled structure's exact model).
            let heavier = masses_doubled(&case.structure);
            let exact2 = super::model::model_graded(&heavier, cases::G, config);
            let worst = worst_difference(&heavier, &exact2, &doubled(&base), &solve(&heavier));
            println!("  every mass doubled: worst difference from twice the answers {worst:.2e}");
            let bigger = twice_the_size(&case.structure);
            let exact8 = super::model::model_graded(&bigger, cases::G, config);
            let worst8 = worst_difference(&bigger, &exact8, &scaled(&base, 8.0, 2.0, 16.0), &solve(&bigger));
            let model8 = worst_difference(&bigger, &exact8, &scaled(&exact, 8.0, 2.0, 16.0), &exact8);
            println!("  twice the size: worst difference from (8F, 2 sigma, 16T) {worst8:.2e} (exact model {model8:.2e})");
            row(config, &name, "twice the size: forces 8x, stresses 2x, twist 16x", "max |difference| / scale <= 1%", "[Gere] 1.8 / dimensional analysis: sigma ~ rho g L under self-weight", "1=yes", 1.0, if model8 <= TOL { 1.0 } else { 0.0 }, if answered && worst8 <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
            row(config, &name, "every mass doubled: every answer doubled", "max |difference| / scale <= 1%", "[Gere] 1.8 / [Hibbeler] 4.3: superposition (linear elastic, below capacity)", "1=yes", 1.0, f64::NAN, if answered && worst <= TOL { 1.0 } else { 0.0 }, 1.0, expected, out);
        });
    }
}
