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
pub fn row(config: Config, case: &str, check: &str, formula: &str, source: &str, unit: &str, textbook: f64, model: f64, stage: f64, scale: f64, expected: &[Expectation], out: &mut Output) {
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

/// A slender steel strut (0.1 m square, 2.2 m, fixed base, free top: Euler
/// effective length 2L), yield 355 MPa. It buckles at pi^2 E I / (2L)^2 =
/// 850 kN; crushing A f_y is 3.55 MN, 4.2x higher. The stage has rigid chunks
/// and a linear solve (no geometric stiffness), so it cannot buckle: this
/// measures how far past the buckling load it stands (a MODEL gap by design,
/// PHYSICS_COVERAGE.md D).
const STRUT: Rect = Rect { b: 0.1, d: 0.1 };
fn slender_strut(load_mass: f64) -> Structure {
    let mut s = Structure::new();
    let strong_m = strong(&mut s, 200e9);
    let steel = s.material(Material { modulus: 200e9, compression: 355e6, tension: 1e13, shear: 1e13 });
    let h = 2.2;
    let (c, _) = column(&mut s, "strut", 0.0, 0.0, h, 4, STRUT, 7850.0, steel);
    fixed(&mut s, c[0], [0.0; 3], [0.0, -1.0, 0.0], X, STRUT, steel);
    let block = s.chunk("load", [0.0, h + 0.1, 0.0], [0.15, 0.1, 0.15], load_mass);
    s.rect_bond(c[3], block, [0.0, h, 0.0], Y, X, STRUT.d, Z, STRUT.b, strong_m);
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
    // Slender strut: Euler, pi^2 E I / (2 L)^2 (fixed-free).
    let strut_i = STRUT.b * STRUT.d.powi(3) / 12.0;
    let euler = std::f64::consts::PI.powi(2) * 200e9 * strut_i / (2.0 * 2.2f64).powi(2) / G;
    vec![
        Breaking {
            name: "break-slender-strut",
            title: "Slender steel strut loaded until it fails: Euler buckling (the stage crushes instead)",
            source: "[Gere] 11.3 / [Timoshenko & Gere, Elastic Stability] 2.1: P_cr = pi^2 E I / (K L)^2, K = 2 (fixed-free)",
            make: slender_strut,
            predicted: euler,
            bonds: vec![3],
            limit: 355e6,
            pick: |g| g.compression,
            formula: "pi^2 E I / (2L)^2",
        },
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
        // Quick: the cantilever (each bisection is ~12 fresh worlds); full: all.
        if !wanted(c.name, if c.name == "break-cantilever-root" { Tier::Quick } else { Tier::Full }) {
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
        super::guard(config, c.name, expected, out, |out| match breaking_load(&make, c.predicted / 8.0, c.predicted * 8.0) {
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
        });
    }
    if wanted("redundancy", Tier::Quick) {
        super::guard(config, "redundancy", expected, out, |out| redundancy(config, expected, out, false));
    }
    // The same with the supports as links and blocks (light 2 cm chunks between
    // stiff joints, k dt^2/m ~4e5): a robustness case for the impact solve.
    if wanted("redundancy-sliver", Tier::Full) {
        super::guard(config, "redundancy-sliver", expected, out, |out| redundancy(config, expected, out, true));
    }
    if wanted("alternate-path", Tier::Quick) {
        super::guard(config, "alternate-path", expected, out, |out| alternate_path(config, expected, out));
    }
    if wanted("gravity-free-fall", Tier::Quick) {
        super::guard(config, "free-fall", expected, out, |out| free_fall(config, expected, out));
    }
    if wanted("rest-near-capacity", Tier::Full) {
        super::guard(config, "rest-near-capacity", expected, out, |out| rest_near_capacity(config, expected, out));
    }
}

/// Propped cantilever and simply supported beam, each losing the roller --
/// here a hanger from above, made of a material weaker than the reaction it
/// carries, so that once it fails nothing is left under the beam.
/// The propped cantilever has another load path -- the fixed end -- and must
/// hold, as a cantilever (root moment w L^2 / 2); the simply supported beam
/// has none and must fall.
fn redundancy(config: Config, expected: &[Expectation], out: &mut Output, sliver: bool) {
    let tag = if sliver { "-sliver" } else { "" };
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
    let prop_top = if sliver {
        hanger_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak).1
    } else {
        strip_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak)
    };
    let (fell, broken, rows) = watch(&s, 120);
    let beam_broken = broken.iter().filter(|&&b| (b as usize) < prop_top).count();
    println!("  propped: broken bonds {broken:?}, beam fell {fell:.3} m");
    row(config, &format!("redundancy-propped{tag}"), "beam holds after losing its prop", "1 = holds", source, "1=yes", 1.0, f64::NAN, if fell < 0.01 && beam_broken == 0 { 1.0 } else { 0.0 }, 1.0, expected, out);
    if let Some(rows) = rows {
        let model_root = {
            let mut cant = s.clone();
            cant.bonds.truncate(prop_top);
            cant.chunks.truncate(cant.chunks.len() - if sliver { 2 } else { 1 }); // the link (if any) and its anchor
            model::model_graded(&cant, G, config)[root].bend
        };
        row(config, &format!("redundancy-propped{tag}"), "root bending stress, redistributed", "w L^2 / 2S", "[Gere] 4.4", "MPa", w * l * l / 2.0 / BEAM.modulus() * 1e-6, model_root * 1e-6, rows[root].bend * 1e-6, w * l * l / 2.0 / BEAM.modulus() * 1e-6, expected, out);
    }

    // Simply supported.
    let mut s = Structure::new();
    let m = s.material(concrete);
    let (c, _) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    if sliver {
        pin_above(&mut s, c[0], STRIP / 2.0, BEAM.d / 2.0, BEAM.b, m);
    } else {
        strip_above(&mut s, c[0], STRIP / 2.0, BEAM.d / 2.0, BEAM.b, m);
    }
    let weak = link_mat(&mut s, w * l / 2.0);
    if sliver {
        hanger_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak);
    } else {
        strip_above(&mut s, c[n - 1], l - STRIP / 2.0, BEAM.d / 2.0, BEAM.b, weak);
    }
    let (fell, broken, _) = watch(&s, 90);
    println!("  simply supported: broken bonds {broken:?}, beam fell {fell:.3} m");
    row(config, &format!("redundancy-simple{tag}"), "beam falls after losing a support", "1 = falls (> 1 m in 1.5 s)", source, "1=yes", 1.0, f64::NAN, if fell > 1.0 { 1.0 } else { 0.0 }, 1.0, expected, out);
}

/// Alternate load path (progressive collapse): a two-span continuous beam on a
/// pin, a middle roller and an end roller loses the middle one (it crushes at a
/// quarter of its reaction). What is left is one span of 2L, whose midspan
/// moment w (2L)^2 / 8 is four times the two-span hogging moment w L^2 / 8. A
/// beam whose bending capacity is 2.5x that static demand bridges the lost
/// support (it holds even under the guidelines' dynamic increase factor of 2
/// for a sudden loss); one at 0.5x -- still twice the two-span demand, so it
/// stood before -- collapses. The supports are concrete strips, which carry a
/// reaction but not a half-beam as a cantilever (a pin is not a fixed end).
fn alternate_path(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[GSA 2016] Alternate Path Analysis & Design Guidelines 3.2 / [UFC 4-023-03] 3-2 (DIF <= 2): with a support removed the member spans 2L, M = w (2L)^2 / 8";
    println!("\nalternate-path -- a lost middle support: the beam bridges 2L or collapses\n  {source}");
    let span = 5.0;
    let l = 2.0 * span;
    let n = 11; // a chunk centred on the middle support
    let e = STRIP / 2.0;
    let w = CONCRETE * BEAM.area() * G;
    let clear = l - 2.0 * e; // between the pin and the end roller
    let bridged = w * clear * clear / 8.0 / BEAM.modulus();
    let concrete = Material { modulus: E_CONCRETE, compression: 40e6, tension: 8e6, shear: 8e6 };
    for (case, capacity, bridges) in [("alternate-path-bridges", 2.5 * bridged, true), ("alternate-path-collapses", 0.5 * bridged, false)] {
        let mut s = Structure::new();
        let support = s.material(concrete);
        // Only the beam's bending (tension) can fail.
        let m = s.material(Material { modulus: E_CONCRETE, compression: 1e13, tension: capacity, shear: 1e13 });
        let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
        pin_below(&mut s, c[0], e, -BEAM.d / 2.0, BEAM.b, support);
        roller_below(&mut s, c[n - 1], l - e, -BEAM.d / 2.0, BEAM.b, support);
        // The middle roller crushes at a quarter of the two-span reaction 10 w L / 8.
        let weak = s.material(Material { modulus: E_CONCRETE, compression: 0.25 * (10.0 * w * span / 8.0) / (STRIP * BEAM.b), tension: 1e13, shear: 1e13 });
        let (_, middle_top, middle_bottom) = roller_below(&mut s, c[n / 2], span, -BEAM.d / 2.0, BEAM.b, weak);
        // Collapsing, a brittle beam goes in pieces (watch() follows only
        // bodies of 3+ chunks): there, the share of chunks over 1 m down.
        let (fell, broken, rows) = if bridges { watch(&s, 120) } else { let (d, b) = share_fallen(&s, 120); (d, b, None) };
        let lost = broken.contains(&(middle_top as u32)) || broken.contains(&(middle_bottom as u32));
        let beam_broken = broken.iter().filter(|&&x| b.contains(&(x as usize))).count();
        println!("  {case}: support lost {lost}, beam bonds broken {beam_broken} ({broken:?}), {} {fell:.3}", if bridges { "fell (m)" } else { "share of chunks down" });
        if bridges {
            row(config, case, "beam bridges the lost support", "1 = holds (capacity 2.5 w(2L)^2/8S)", source, "1=yes", 1.0, f64::NAN, if lost && fell < 0.01 && beam_broken == 0 { 1.0 } else { 0.0 }, 1.0, expected, out);
            if let Some(rows) = rows {
                // The bond beside midspan, at x = 5a from the beam's end.
                let bond = b[n / 2 - 1];
                let x = l / n as f64 * (n / 2) as f64 - e;
                let textbook = w * x * (clear - x) / 2.0 / BEAM.modulus();
                let mut spanning = s.clone();
                spanning.bonds.truncate(middle_top.min(middle_bottom));
                spanning.chunks.truncate(spanning.chunks.len() - 2); // the middle roller's link and anchor
                let model_bend = model::model_graded(&spanning, G, config)[bond].bend;
                row(config, case, "midspan bending stress over 2L", "w x (2L - x) / 2S", "[Gere] 4.5", "MPa", textbook * 1e-6, model_bend * 1e-6, rows[bond].bend * 1e-6, textbook * 1e-6, expected, out);
            }
        } else {
            row(config, case, "beam collapses over the lost support", "1 = most of it falls (> half its chunks > 1 m down in 2 s; capacity 0.5 w(2L)^2/8S)", source, "1=yes", 1.0, f64::NAN, if lost && fell > 0.5 { 1.0 } else { 0.0 }, 1.0, expected, out);
        }
    }
}

/// Run a structure for `ticks`; return the share of its dynamic chunks whose
/// body ended over 1 m below the pose height, and every bond broken. (Rubble
/// may come to rest on a support that is still standing.)
fn share_fallen(s: &Structure, ticks: u32) -> (f64, Vec<u32>) {
    let mut world = stage::build(s);
    let mut broken_all = Vec::new();
    let (mut fallen, mut total) = (0u32, 0u32);
    let start = 20.0; // the structure's pose height
    stage::run_ticks(&mut world, ticks, |t, _, broken, w| {
        broken_all.extend_from_slice(broken);
        if t == ticks {
            if let Ok(snaps) = w.native_chunk_body_snapshots() {
                for b in snaps.iter().filter(|b| !b.kinematic) {
                    total += b.node_count;
                    if start - b.position.y as f64 > 1.0 {
                        fallen += b.node_count;
                    }
                }
            }
        }
        false
    });
    (if total > 0 { fallen as f64 / total as f64 } else { 0.0 }, broken_all)
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
