//! Failure, gravity and rest: does the stage break the bond the textbook
//! predicts, at the load it predicts and not below it; does a structure that
//! has an alternative load path hold when one support goes, and one that has
//! none fall; does a fragment fall at g; does a structure loaded just under
//! its capacity stand indefinitely.
//!
//! Materials here are brittle (elastic limit = fatal limit), so a bond takes
//! no damage below its limit and fails the tick its graded stress reaches it
//! (extStressBondDamage). The breaking load is found by bisection on the load
//! (a fresh world per trial, the production solver, up to 2 s per trial): the
//! bracket is closed to 0.1%, so "breaks at" means the lowest load that broke
//! and "not before" the highest that stood.

use super::build::*;
use super::cases::{Tier, G, TOL};
use super::model::{self, Config, Material, Structure};
use super::stage;
use super::{classify, Expectation, Output, Row};

/// A failure check's result row.
#[allow(clippy::too_many_arguments)]
fn row(config: Config, case: &str, check: &str, formula: &str, source: &str, unit: &str, textbook: f64, model: f64, stage: f64, scale: f64, expected: &[Expectation], out: &mut Output) {
    let mut r = Row {
        config: config.name.into(),
        case: case.into(),
        check: check.into(),
        formula: formula.into(),
        source: source.into(),
        unit: unit.into(),
        textbook,
        model,
        stage,
        error: (stage - textbook).abs() / scale.max(1e-30),
        solver_error: if model.is_finite() { (stage - model).abs() / scale.max(model.abs()).max(1e-30) } else { f64::NAN },
        tolerance: TOL,
        status: String::new(),
        ticks: 0,
        converged: true,
        accurate_at: None,
    };
    classify(&mut r, expected);
    out.push(r);
}

/// The lowest load (by `make(load)`) that breaks the structure within 2 s,
/// by bisection on a log scale between `lo` and `hi` (lo must stand, hi
/// break), to 0.1%. Returns (load, bonds broken first at that load).
fn breaking_load(make: &dyn Fn(f64) -> Structure, mut lo: f64, mut hi: f64) -> Option<(f64, Vec<u32>, usize)> {
    let ticks = 120;
    if stage::first_break(&make(lo), ticks).is_some() {
        return Some((lo, Vec::new(), 0)); // broke below the bracket
    }
    let (_, mut first, mut trial) = stage::first_break(&make(hi), ticks)?;
    while hi / lo > 1.001 {
        let mid = (lo * hi).sqrt();
        match stage::first_break(&make(mid), ticks) {
            Some((_, b, n)) => {
                hi = mid;
                first = b;
                trial = n;
            }
            None => lo = mid,
        }
    }
    Some((hi, first, trial))
}

/// The model's load for unit graded stress at `bond` (stress per unit load),
/// so the model's breaking load is limit / that.
fn model_stress(make: &dyn Fn(f64) -> Structure, load: f64, bond: usize, config: Config, pick: fn(&model::Graded) -> f64) -> f64 {
    let s = make(load);
    let g = model::model_graded(&s, G, config);
    pick(&g[bond]) / load
}

const BEAM: Rect = Rect { b: 0.2, d: 0.4 };
const COL: Rect = Rect { b: 0.3, d: 0.3 };

/// Cantilever, 2 m in 4 chunks, a load block on its tip; tension limit 10 MPa.
fn cantilever_break(load_mass: f64) -> Structure {
    let mut s = Structure::new();
    let strong_m = strong(&mut s, E_CONCRETE);
    let weak = s.material(Material { modulus: E_CONCRETE, compression: 1e13, tension: 10e6, shear: 1e13 });
    let l = 2.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, 4, BEAM, LIGHT, weak);
    let _ = b;
    fixed(&mut s, c[0], [0.0; 3], [-1.0, 0.0, 0.0], Y, BEAM, weak);
    let block = s.chunk("load", [l + 0.1, 0.0, 0.0], [0.1, BEAM.d / 2.0, BEAM.b / 2.0], load_mass);
    s.rect_bond(c[3], block, [l, 0.0, 0.0], X, Y, BEAM.d, Z, BEAM.b, strong_m);
    s
}

/// Column, 3 m in 6 concrete chunks, a block on top; compression limit
/// 1.2 MPa (a lime-mortar masonry pier), so each chunk's weight is ~1% of the
/// base load and the base is the most stressed bond by more than FP32 and the
/// bisection can resolve.
fn column_crush(load_mass: f64) -> Structure {
    let mut s = Structure::new();
    let strong_m = strong(&mut s, E_CONCRETE);
    let weak = s.material(Material { modulus: E_CONCRETE, compression: 1.2e6, tension: 1e13, shear: 1e13 });
    let h = 3.0;
    let (c, _) = column(&mut s, "col", 0.0, 0.0, h, 6, COL, CONCRETE, weak);
    fixed(&mut s, c[0], [0.0; 3], [0.0, -1.0, 0.0], X, COL, weak);
    let block = s.chunk("load", [0.0, h + 0.1, 0.0], [COL.d / 2.0, 0.1, COL.b / 2.0], load_mass);
    s.rect_bond(c[5], block, [0.0, h, 0.0], Y, X, COL.d, Z, COL.b, strong_m);
    s
}

/// Column with a load 0.1 m off its axis; tension limit 1 MPa.
fn eccentric_crack(load_mass: f64) -> Structure {
    let mut s = Structure::new();
    let strong_m = strong(&mut s, E_CONCRETE);
    let weak = s.material(Material { modulus: E_CONCRETE, compression: 1e13, tension: 1e6, shear: 1e13 });
    let h = 2.0;
    let (c, _) = column(&mut s, "col", 0.0, 0.0, h, 4, COL, LIGHT, weak);
    fixed(&mut s, c[0], [0.0; 3], [0.0, -1.0, 0.0], X, COL, weak);
    let block = s.chunk("load", [0.1, h + 0.1, 0.0], [COL.d / 2.0 + 0.1, 0.1, COL.b / 2.0], load_mass);
    s.rect_bond(c[3], block, [0.0, h, 0.0], Y, X, COL.d, Z, COL.b, strong_m);
    s
}

/// Simply supported, 6 m in 9 chunks, dense chunk at midspan; tension 10 MPa.
fn simple_break(load_mass: f64) -> Structure {
    let mut s = Structure::new();
    let strong_m = strong(&mut s, E_CONCRETE);
    let weak = s.material(Material { modulus: E_CONCRETE, compression: 1e13, tension: 10e6, shear: 1e13 });
    let l = 6.0;
    let (c, _) = beam(&mut s, "beam", 0.0, l, 0.0, 9, BEAM, LIGHT, weak);
    s.chunks[c[4]].mass = load_mass;
    let e = STRIP / 2.0;
    pin_below(&mut s, c[0], e, -BEAM.d / 2.0, BEAM.b, strong_m);
    roller_below(&mut s, c[8], l - e, -BEAM.d / 2.0, BEAM.b, strong_m);
    s
}

struct Breaking {
    name: &'static str,
    title: &'static str,
    source: &'static str,
    make: fn(f64) -> Structure,
    /// The textbook breaking load, kg of load mass.
    predicted: f64,
    /// Bonds the textbook says fail first.
    bonds: Vec<usize>,
    limit: f64,
    pick: fn(&model::Graded) -> f64,
    formula: &'static str,
}

fn breaking_cases() -> Vec<Breaking> {
    // Cantilever: sigma_root = P a / S = f_t (a = 2.1 m to the block's centre).
    let a = 2.1;
    let cant = 10e6 * BEAM.modulus() / a / G;
    // Column: N_base = P + w h = f_c A.
    let w = CONCRETE * COL.area() * G;
    let col = (1.2e6 * COL.area() - w * 3.0) / G;
    // Eccentric: P (e/S - 1/A) = f_t.
    let ecc = 1e6 / (0.1 / COL.modulus() - 1.0 / COL.area()) / G;
    // Simply supported: M at the bonds beside the load = (P/2)(x - e) = f_t S.
    let x = 6.0 / 2.0 - 6.0 / 9.0 / 2.0 - STRIP / 2.0;
    let ss = 10e6 * BEAM.modulus() / (x / 2.0) / G;
    vec![
        Breaking {
            name: "break-cantilever-root",
            title: "Cantilever tip load raised until it breaks: root bond in tension",
            source: "[Gere] 5.5: sigma = P a / S = f_t  =>  P = f_t S / a",
            make: cantilever_break,
            predicted: cant,
            bonds: vec![3],
            limit: 10e6,
            pick: |g| g.tension,
            formula: "f_t S / a",
        },
        Breaking {
            name: "break-column-crush",
            title: "Column load raised until it crushes: base bond in compression",
            source: "[Gere] 1.2: (P + w h) / A = f_c",
            make: column_crush,
            predicted: col,
            bonds: vec![5],
            limit: 1.2e6,
            pick: |g| g.compression,
            formula: "f_c A - w h",
        },
        Breaking {
            name: "break-eccentric-tension",
            title: "Eccentric column load raised until the tension face cracks",
            source: "[Gere] 11.5: P e / S - P / A = f_t",
            make: eccentric_crack,
            predicted: ecc,
            bonds: vec![0, 1, 2, 3], // constant moment P e up the column
            limit: 1e6,
            pick: |g| g.tension,
            formula: "f_t / (e/S - 1/A)",
        },
        Breaking {
            name: "break-simply-supported",
            title: "Simply supported midspan load raised until it breaks beside the load",
            source: "[Gere] 4.5: (P/2) x / S = f_t",
            make: simple_break,
            predicted: ss,
            bonds: vec![3, 4],
            limit: 10e6,
            pick: |g| g.tension,
            formula: "2 f_t S / x",
        },
    ]
}

pub fn run(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    let wanted = |name: &str, tier: Tier| {
        if let Ok(filter) = std::env::var("VERIFY_CASES") {
            if !filter.is_empty() {
                return filter.split(',').any(|f| name.contains(f.trim()));
            }
        }
        tier == Tier::Quick || want == Tier::Full
    };
    if std::env::var("VERIFY_MODEL_ONLY").is_ok_and(|v| v == "1") {
        return;
    }
    for c in breaking_cases() {
        if !wanted(c.name, Tier::Quick) {
            continue;
        }
        println!("\n{} -- {}\n  {}", c.name, c.title, c.source);
        // Which bond is the model's first? Its load for unit stress there.
        let make = |m: f64| (c.make)(m);
        let model_load = {
            let s = make(c.predicted);
            let g = model::model_graded(&s, G, config);
            // Only the bonds of the weak (breakable) material: material 1 in
            // every breaking case; the load blocks and supports are unbreakable.
            let stress = g.iter().zip(&s.bonds).filter(|(_, b)| b.material == 1).map(|(g, _)| (c.pick)(g)).fold(0.0, f64::max);
            if stress > 0.0 { c.predicted * c.limit / stress } else { f64::NAN }
        };
        let _ = model_stress;
        match breaking_load(&make, c.predicted / 8.0, c.predicted * 8.0) {
            Some((load, all, trial)) => {
                // The tick's events come sorted by bond, not by pass; the
                // status says how many broke in the trial evaluation (the
                // load) and how many in the corrected pass after the split.
                let first = all.clone();
                row(config, c.name, "breaking load", c.formula, c.source, "kN", c.predicted * G * 1e-3, model_load * G * 1e-3, load * G * 1e-3, c.predicted * G * 1e-3, expected, out);
                // Bonds whose textbook stress is within twice the bisection's
                // 0.1% bracket of the predicted bond's may break in the same
                // tick: the test cannot tell them apart.
                let exact = model::model_graded(&make(c.predicted), G, Config { name: "textbook", rotation: model::Rotation::Section, grading: model::Grading::Section, true_stiffness: true });
                let peak = c.bonds.iter().map(|&b| (c.pick)(&exact[b])).fold(0.0, f64::max);
                let allowed: Vec<usize> = (0..exact.len()).filter(|&b| (c.pick)(&exact[b]) >= 0.998 * peak && make(c.predicted).bonds[b].material == 1).collect();
                // Right: a predicted bond broke, and the load broke no more
                // bonds than tie with it (the corrected pass's are consequences).
                let right = first.iter().any(|b| c.bonds.contains(&(*b as usize))) && trial <= allowed.len()
                    && (trial < first.len() || first.iter().all(|b| allowed.contains(&(*b as usize))));
                println!("  broken in the first breaking tick {first:?} ({trial} by the load, {} in the corrected pass), predicted {:?} (ties within 0.2%: {allowed:?})", first.len() - trial, c.bonds);
                row(config, c.name, "the predicted bond breaks first", &format!("bond {:?}", c.bonds), c.source, "1=yes", 1.0, f64::NAN, if right { 1.0 } else { 0.0 }, 1.0, expected, out);
            }
            None => {
                row(config, c.name, "breaking load", c.formula, c.source, "kN", c.predicted * G * 1e-3, model_load * G * 1e-3, f64::INFINITY, c.predicted * G * 1e-3, expected, out);
            }
        }
    }
    if wanted("redundancy", Tier::Quick) {
        redundancy(config, expected, out);
    }
    if wanted("gravity-free-fall", Tier::Quick) {
        free_fall(config, expected, out);
    }
    if wanted("rest-near-capacity", Tier::Full) {
        rest_near_capacity(config, expected, out);
    }
}

/// Propped cantilever and simply supported beam, each losing the roller --
/// here a hanger from above, made of a material weaker than the reaction it
/// carries, so that once it fails nothing is left under the beam.
/// The propped cantilever has another load path -- the fixed end -- and must
/// hold, as a cantilever (root moment w L^2 / 2); the simply supported beam
/// has none and must fall.
fn redundancy(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Hibbeler] 2.4 / 6: an indeterminate structure redistributes; a determinate one with a support removed is a mechanism";
    println!("\nredundancy -- a support removed: indeterminate holds, determinate falls\n  {source}");
    let l = 6.0;
    let n = 12;
    let w = CONCRETE * BEAM.area() * G;
    // The link fails at a quarter of the reaction it would carry.
    let link_mat = |s: &mut Structure, r: f64| s.material(Material { modulus: E_CONCRETE, compression: 1e13, tension: 0.25 * r / (STRIP * BEAM.b), shear: 1e13 });
    // Concrete-like joints: they carry the beam as a cantilever (root
    // w L^2 / 2S = 6.4 MPa) but a 2 cm pin strip cannot carry that moment.
    let concrete = Material { modulus: E_CONCRETE, compression: 40e6, tension: 8e6, shear: 8e6 };

    // Propped cantilever.
    let mut s = Structure::new();
    let m = s.material(concrete);
    let (c, _) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let root = fixed(&mut s, c[0], [0.0; 3], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let weak = link_mat(&mut s, 3.0 * w * l / 8.0);
    let (_, prop_top, _) = hanger_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak);
    let (fell, broken, rows) = watch(&s, 120);
    let beam_broken = broken.iter().filter(|&&b| (b as usize) < prop_top).count();
    println!("  propped: broken bonds {broken:?}, beam fell {fell:.3} m");
    row(config, "redundancy-propped", "beam holds after losing its prop", "1 = holds", source, "1=yes", 1.0, f64::NAN, if fell < 0.01 && beam_broken == 0 { 1.0 } else { 0.0 }, 1.0, expected, out);
    if let Some(rows) = rows {
        let model_root = {
            let mut cant = s.clone();
            cant.bonds.truncate(prop_top);
            cant.chunks.truncate(cant.chunks.len() - 2); // the link and its anchor
            model::model_graded(&cant, G, config)[root].bend
        };
        row(config, "redundancy-propped", "root bending stress, redistributed", "w L^2 / 2S", "[Gere] 4.4", "MPa", w * l * l / 2.0 / BEAM.modulus() * 1e-6, model_root * 1e-6, rows[root].bend * 1e-6, w * l * l / 2.0 / BEAM.modulus() * 1e-6, expected, out);
    }

    // Simply supported.
    let mut s = Structure::new();
    let m = s.material(concrete);
    let (c, _) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    pin_above(&mut s, c[0], STRIP / 2.0, BEAM.d / 2.0, BEAM.b, m);
    let weak = link_mat(&mut s, w * l / 2.0);
    hanger_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak);
    let (fell, broken, _) = watch(&s, 90);
    println!("  simply supported: broken bonds {broken:?}, beam fell {fell:.3} m");
    row(config, "redundancy-simple", "beam falls after losing a support", "1 = falls (> 1 m in 1.5 s)", source, "1=yes", 1.0, f64::NAN, if fell > 1.0 { 1.0 } else { 0.0 }, 1.0, expected, out);
}

/// Run a structure for `ticks`; return how far its heaviest dynamic body
/// fell (m), every bond broken, and the bond rows at the end (if readable).
fn watch(s: &Structure, ticks: u32) -> (f64, Vec<u32>, Option<Vec<model::Graded>>) {
    let mut world = stage::build(s);
    let mut broken_all = Vec::new();
    let mut lowest = f64::INFINITY;
    let start = 20.0; // the structure's pose height
    let verbose = std::env::var_os("VERIFY_VERBOSE").is_some();
    stage::run_ticks(&mut world, ticks, |t, _, broken, w| {
        broken_all.extend_from_slice(broken);
        if verbose && !broken.is_empty() {
            println!("    tick {t}: broke {broken:?}");
        }
        if verbose && t % 15 == 0 {
            if let Ok(snaps) = w.native_chunk_body_snapshots() {
                for b in snaps.iter() {
                    println!("    tick {t}: body nodes {} kinematic {} sleeping {} y {:.3} vy {:.3}", b.node_count, b.kinematic, b.sleeping, b.position.y, b.linear_velocity.y);
                }
            }
        }
        if let Ok(snaps) = w.native_chunk_body_snapshots() {
            for b in snaps.iter().filter(|b| b.node_count >= 3 && !b.kinematic) {
                lowest = lowest.min(b.position.y as f64);
            }
        }
        false
    });
    let fell = if lowest.is_finite() { (start - lowest).max(0.0) } else { 0.0 };
    let rows = world.native_bond_stress_rows(0).ok().filter(|r| r.len() == s.bonds.len()).map(|_| stage::rows(&world, s.bonds.len()));
    (fell, broken_all, rows)
}

/// A fragment in free fall accelerates at g: not 2g (a doubled gravity, the
/// carrier bug's signature) and not 0 (weightless debris). A cantilever whose
/// tip bond cannot carry the tip's weight drops it; the fragment's vertical
/// velocity is read every tick (linear damping off for this one structure).
fn free_fall(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Gere] / Newton: dv/dt = g = 9.81 m/s2 (semi-implicit Euler: v_n = -g n dt exactly)";
    println!("\ngravity-free-fall -- a broken-off fragment falls at g\n  {source}");
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let weak = s.material(Material { modulus: E_CONCRETE, compression: 1.0, tension: 1.0, shear: 1.0 });
    let (c, _) = beam(&mut s, "beam", 0.0, 2.0, 0.0, 4, BEAM, CONCRETE, m);
    fixed(&mut s, c[0], [0.0; 3], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let tip = s.chunk("tip", [2.25, 0.0, 0.0], [0.25, BEAM.d / 2.0, BEAM.b / 2.0], 500.0);
    s.rect_bond(c[3], tip, [2.0, 0.0, 0.0], X, Y, BEAM.d, Z, BEAM.b, weak);
    s.linear_damping = Some(0.0);
    let mut world = stage::build(&s);
    let mut vy: Vec<f64> = Vec::new();
    stage::run_ticks(&mut world, 40, |_, _, _, w| {
        if let Ok(snaps) = w.native_chunk_body_snapshots() {
            if let Some(b) = snaps.iter().find(|b| b.node_count == 1 && !b.kinematic) {
                vy.push(b.linear_velocity.y as f64);
            }
        }
        false
    });
    // Acceleration over the last 20 ticks of the fall (clear of the split).
    let a = if vy.len() >= 22 { -(vy[vy.len() - 1] - vy[vy.len() - 21]) / (20.0 / 60.0) } else { f64::NAN };
    println!("  fragment samples {}, acceleration {a:.4} m/s2", vy.len());
    row(config, "gravity-free-fall", "fragment acceleration", "g", source, "m/s2", G, G, a, G, expected, out);
}

/// A tower at 95% of its crushing capacity, and a cantilever at 95% of its
/// tension capacity, stand 10 s at the production solver settings: no bond
/// breaks while the warm-started solve converges, and the stress does not
/// creep.
fn rest_near_capacity(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "statics: a structure below its capacity stands; [Gere] 1.2, 5.5";
    println!("\nrest-near-capacity -- 95% of capacity, 10 s\n  {source}");
    // Tower: 10 m of concrete, 20 chunks; base compression = rho g h.
    let h = 10.0;
    let base_stress = CONCRETE * G * h;
    let mut s = Structure::new();
    let m = s.material(Material { modulus: E_CONCRETE, compression: base_stress / 0.95, tension: 1e13, shear: 1e13 });
    let (c, _) = column(&mut s, "tower", 0.0, 0.0, h, 20, COL, CONCRETE, m);
    let base = fixed(&mut s, c[0], [0.0; 3], [0.0, -1.0, 0.0], X, COL, m);
    let (_, broken, rows) = watch(&s, 600);
    row(config, "rest-near-capacity", "tower at 95% of crushing capacity: bonds broken in 10 s", "0", source, "bonds", 0.0, 0.0, broken.len() as f64, 1.0, expected, out);
    if let Some(r) = rows {
        row(config, "rest-near-capacity", "tower base stress after 10 s", "rho g h", source, "MPa", base_stress * 1e-6, base_stress * 1e-6, r[base].compression * 1e-6, base_stress * 1e-6, expected, out);
    }
    // Cantilever: 4 m concrete under self-weight; root tension fibre
    // w L^2 / 2S, limit at 1/0.95 of it.
    let l = 4.0;
    let w = CONCRETE * BEAM.area() * G;
    let probe = {
        let mut p = Structure::new();
        let pm = strong(&mut p, E_CONCRETE);
        let (pc, _) = beam(&mut p, "beam", 0.0, l, 0.0, 8, BEAM, CONCRETE, pm);
        fixed(&mut p, pc[0], [0.0; 3], [-1.0, 0.0, 0.0], Y, BEAM, pm);
        p
    };
    // The capacity is set from the stage's own grading in this configuration
    // (so the test is about rest, not about the grading, which the statics
    // cases check): 95% of the model's root tension.
    let root_tension = model::model_graded(&probe, G, config)[7].tension;
    let mut s = probe.clone();
    s.materials[0] = Material { modulus: E_CONCRETE, compression: 1e13, tension: root_tension / 0.95, shear: 1e13 };
    let (_, broken, rows) = watch(&s, 600);
    row(config, "rest-near-capacity", "cantilever at 95% of tension capacity: bonds broken in 10 s", "0", source, "bonds", 0.0, 0.0, broken.len() as f64, 1.0, expected, out);
    if let Some(r) = rows {
        let textbook = w * l * l / 2.0 / BEAM.modulus();
        row(config, "rest-near-capacity", "cantilever root tension after 10 s", "w L^2 / 2S", source, "MPa", textbook * 1e-6, root_tension * 1e-6, r[7].tension * 1e-6, textbook * 1e-6, expected, out);
    }
}
