//! The textbook cases: each a structure, and the closed-form answers it is
//! checked against, with the formula and where it comes from.
//!
//! Sources (cited by key in each case):
//!   [Gere]      Gere & Goodno, Mechanics of Materials, 9th ed.
//!   [Hibbeler]  Hibbeler, Structural Analysis, 10th ed.
//!   [Hib-MoM]   Hibbeler, Mechanics of Materials, 10th ed.
//!   [Roark]     Young & Budynas, Roark's Formulas for Stress and Strain, 8th ed.
//!   [Timo]      Timoshenko & Gere, Theory of Elastic Stability, 2nd ed.
//!   [Timo-Goodier] Timoshenko & Goodier, Theory of Elasticity, 3rd ed.
//!
//! Every structure is data: `registry()` lists them with their tier, and
//! `VERIFY_DUMP=dir` writes each as JSON (chunks, bonds, materials, rotation)
//! so other suites (performance) can load the same scenarios.

use super::build::*;
use super::model::{add, norm, normalize, scale, sub, Structure, V3};

pub const G: f64 = 9.81;
/// Engineering tolerance for every check: 1% of the textbook value (or of
/// the case's reference magnitude where the textbook value is zero). Not
/// tuned per case; see docs/verification/README.md for why 1%.
pub const TOL: f64 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tier {
    Quick,
    Full,
}

/// What a check reads from a bond.
#[derive(Clone, Copy, Debug)]
pub enum Q {
    /// Axial force, N (tension +): normal stress x area.
    Axial,
    /// Shear force, N: shear stress x area (no twist on these bonds).
    Shear,
    /// Bending fibre stress, Pa.
    Bend,
    /// Extreme fibre in tension (normal + bending), Pa.
    Tension,
    /// Extreme fibre in compression (bending - normal), Pa.
    Compression,
    /// Torsional shear stress, Pa: the shear stress less the bond's
    /// transverse shear force over its area (known from statics).
    Twist { transverse: f64 },
}

impl Q {
    pub fn unit(&self) -> &'static str {
        match self {
            Q::Axial | Q::Shear => "kN",
            _ => "MPa",
        }
    }
    /// Display scale from SI.
    pub fn display(&self) -> f64 {
        match self {
            Q::Axial | Q::Shear => 1e-3,
            _ => 1e-6,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Check {
    pub label: String,
    pub bond: usize,
    pub q: Q,
    pub textbook: f64,
    pub formula: String,
    /// Denominator of the relative error: |textbook| unless that is zero.
    pub scale: f64,
}

fn check(label: &str, bond: usize, q: Q, textbook: f64, formula: &str) -> Check {
    Check { label: label.into(), bond, q, textbook, formula: formula.into(), scale: textbook.abs() }
}
fn zero(label: &str, bond: usize, q: Q, reference: f64, formula: &str) -> Check {
    Check { label: label.into(), bond, q, textbook: 0.0, formula: formula.into(), scale: reference.abs() }
}

pub struct Statics {
    pub name: String,
    pub title: &'static str,
    pub source: &'static str,
    pub tier: Tier,
    pub structure: Structure,
    pub checks: Vec<Check>,
}

// ---------------------------------------------------------------------------
// Beams

const BEAM: Rect = Rect { b: 0.2, d: 0.4 };

/// Cantilever, L = 4 m in 8 chunks, near-weightless, a 10 t block on its tip.
pub fn cantilever_tip(n: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 4.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, LIGHT, m);
    let root = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let load_mass = 10_000.0;
    let block = s.chunk("load", [l + 0.1, 0.0, 0.0], [0.1, BEAM.d / 2.0, BEAM.b / 2.0], load_mass);
    s.rect_bond(c[n - 1], block, [l, 0.0, 0.0], X, Y, BEAM.d, Z, BEAM.b, m);
    let p = load_mass * G;
    let w = LIGHT * BEAM.area() * G;
    let arm = l + 0.1;
    let sm = BEAM.modulus();
    let mid = b[n / 2 - 1]; // the bond at x = L/2
    let m_root = p * arm + w * l * l / 2.0;
    let m_mid = p * (arm - l / 2.0) + w * (l / 2.0).powi(2) / 2.0;
    Statics {
        name: "cantilever-tip-load".into(),
        title: "Cantilever, point load at the tip",
        source: "[Gere] 4.4, 5.5: M(x) = P (a - x), V = P; sigma = M / S, S = b d^2 / 6",
        tier: Tier::Quick,
        checks: vec![
            check("root bending stress", root, Q::Bend, m_root / sm, "P a / S"),
            check("root shear force", root, Q::Shear, p + w * l, "V = P"),
            zero("root axial force", root, Q::Axial, p, "N = 0"),
            check("midspan bending stress", mid, Q::Bend, m_mid / sm, "P (a - L/2) / S"),
        ],
        structure: s,
    }
}

/// Cantilever under its own weight: concrete, 2400 kg/m^3, g = 9.81. The
/// stale-gravity regression: a stage feeding the solver g = 20 reads 2.04x.
pub fn cantilever_self_weight(n: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 4.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let root = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let w = CONCRETE * BEAM.area() * G;
    let sm = BEAM.modulus();
    let mid = b[n / 2 - 1];
    Statics {
        name: "cantilever-self-weight".into(),
        title: "Cantilever under self-weight (rho = 2400 kg/m3, g = 9.81 m/s2)",
        source: "[Gere] 4.4: w = rho A g, M_root = w L^2 / 2, V_root = w L",
        tier: Tier::Quick,
        checks: vec![
            check("root bending stress", root, Q::Bend, w * l * l / 2.0 / sm, "w L^2 / 2S"),
            check("root shear force", root, Q::Shear, w * l, "w L"),
            check("midspan bending stress", mid, Q::Bend, w * (l / 2.0).powi(2) / 2.0 / sm, "w (L/2)^2 / 2S"),
        ],
        structure: s,
    }
}

/// Simply supported, L = 6 m between a pin and a roller (each 1 cm in from
/// the ends), near-weightless, with a dense chunk at midspan.
pub fn simply_supported_point(n: usize) -> Statics {
    assert!(n % 2 == 1, "a chunk at midspan");
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 6.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, LIGHT, m);
    let midc = c[n / 2];
    let load_mass = 10_000.0;
    s.chunks[midc].mass = load_mass;
    let e = STRIP / 2.0;
    let (_, pin_top, _) = pin_below(&mut s, c[0], e, -BEAM.d / 2.0, BEAM.b, m);
    let (_, roller_top, _) = roller_below(&mut s, c[n - 1], l - e, -BEAM.d / 2.0, BEAM.b, m);
    let p = load_mass * G;
    let loads: Vec<(f64, f64)> = c.iter().map(|&i| (s.chunks[i].center[0], s.chunks[i].mass * G)).collect();
    let a = l / n as f64;
    let xb = l / 2.0 - a / 2.0; // the bond beside the loaded chunk
    let near = b[n / 2 - 1];
    let mm = simple_moment(&loads, e, l - e, xb);
    let span = l - 2.0 * e;
    Statics {
        name: "simply-supported-point".into(),
        title: "Simply supported beam, point load at midspan",
        source: "[Gere] 4.5: R = P/2, M(x) = P x / 2 (x <= L/2), M_max = P L / 4",
        tier: Tier::Quick,
        checks: vec![
            check("left reaction (pin)", pin_top, Q::Axial, -p / 2.0, "R_A = -P/2 (compression)"),
            check("right reaction (roller)", roller_top, Q::Axial, -p / 2.0, "R_B = -P/2"),
            check("bending stress beside the load", near, Q::Bend, mm / BEAM.modulus(), "P x / 2S"),
        ],
        structure: s,
    }
}

/// Simply supported under self-weight (UDL).
pub fn simply_supported_udl(n: usize) -> Statics {
    assert!(n % 2 == 0, "a bond at midspan");
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 6.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let e = STRIP / 2.0;
    let (_, pin_top, _) = pin_below(&mut s, c[0], e, -BEAM.d / 2.0, BEAM.b, m);
    let (_, roller_top, _) = roller_below(&mut s, c[n - 1], l - e, -BEAM.d / 2.0, BEAM.b, m);
    let w = CONCRETE * BEAM.area() * G;
    let span = l - 2.0 * e;
    let quarter = b[n / 4 - 1];
    let x_quarter = (n / 4) as f64 * l / n as f64;
    Statics {
        name: "simply-supported-udl".into(),
        title: "Simply supported beam, self-weight (UDL)",
        source: "[Gere] 4.5: R = w L / 2, M(x) = w x (L - x) / 2, M_max = w L^2 / 8",
        tier: Tier::Quick,
        checks: vec![
            check("left reaction (pin)", pin_top, Q::Axial, -w * l / 2.0, "R = -w L / 2"),
            check("right reaction (roller)", roller_top, Q::Axial, -w * l / 2.0, "R = -w L / 2"),
            check("midspan bending stress", b[n / 2 - 1], Q::Bend, w * span * span / 8.0 / BEAM.modulus(), "w L^2 / 8S"),
            check("quarter-span bending stress", quarter, Q::Bend, w * (x_quarter - e) * (span - (x_quarter - e)) / 2.0 / BEAM.modulus(), "w x (L - x) / 2S"),
        ],
        structure: s,
    }
}

/// Propped cantilever: fixed at x = 0, roller at x = L, self-weight.
pub fn propped_cantilever(n: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 6.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let root = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let e = STRIP / 2.0;
    let (_, prop, _) = roller_below(&mut s, c[n - 1], l - e, -BEAM.d / 2.0, BEAM.b, m);
    let w = CONCRETE * BEAM.area() * G;
    let span = l - e;
    // The bond nearest the maximum positive moment at x = 5L/8.
    let a = l / n as f64;
    let k = ((5.0 * span / 8.0) / a).round() as usize;
    let xk = k as f64 * a;
    let r = 3.0 * w * span / 8.0;
    let m_at = |x: f64| r * (span - x) - w * (span - x).powi(2) / 2.0;
    Statics {
        name: "propped-cantilever-udl".into(),
        title: "Propped cantilever, self-weight (indeterminate, 1 degree)",
        source: "[Gere] 10.3 / [Roark] Table 8.1 case 2e: R_prop = 3wL/8, R_fixed = 5wL/8, M_fixed = wL^2/8, M+ = 9wL^2/128 at 5L/8",
        tier: Tier::Quick,
        checks: vec![
            check("prop reaction", prop, Q::Axial, -r, "R = -3 w L / 8"),
            check("fixed-end shear", root, Q::Shear, 5.0 * w * span / 8.0, "5 w L / 8"),
            check("fixed-end bending stress", root, Q::Bend, w * span * span / 8.0 / BEAM.modulus(), "w L^2 / 8S"),
            check("span bending stress near 5L/8", b[k - 1], Q::Bend, m_at(xk).abs() / BEAM.modulus(), "R (L-x) - w (L-x)^2 / 2"),
        ],
        structure: s,
    }
}

/// Fixed-fixed beam under self-weight.
pub fn fixed_fixed_udl(n: usize) -> Statics {
    assert!(n % 2 == 0);
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 6.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let left = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, BEAM, m);
    let right = fixed(&mut s, c[n - 1], [l, 0.0, 0.0], [1.0, 0.0, 0.0], Y, BEAM, m);
    let w = CONCRETE * BEAM.area() * G;
    let sm = BEAM.modulus();
    Statics {
        name: "fixed-fixed-udl".into(),
        title: "Fixed-fixed beam, self-weight (indeterminate, 2 degrees)",
        source: "[Gere] 10.4 / [Roark] Table 8.1 case 2d: M_end = wL^2/12, M_mid = wL^2/24, V_end = wL/2",
        tier: Tier::Quick,
        checks: vec![
            check("left end bending stress", left, Q::Bend, w * l * l / 12.0 / sm, "w L^2 / 12S"),
            check("right end bending stress", right, Q::Bend, w * l * l / 12.0 / sm, "w L^2 / 12S"),
            check("midspan bending stress", b[n / 2 - 1], Q::Bend, w * l * l / 24.0 / sm, "w L^2 / 24S"),
            check("end shear", left, Q::Shear, w * l / 2.0, "w L / 2"),
        ],
        structure: s,
    }
}

/// Fixed-fixed beam, near-weightless, dense chunk at midspan.
pub fn fixed_fixed_point(n: usize) -> Statics {
    assert!(n % 2 == 1);
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let l = 6.0;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, LIGHT, m);
    let left = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, BEAM, m);
    fixed(&mut s, c[n - 1], [l, 0.0, 0.0], [1.0, 0.0, 0.0], Y, BEAM, m);
    let load_mass = 10_000.0;
    s.chunks[c[n / 2]].mass = load_mass;
    let p = load_mass * G;
    let sm = BEAM.modulus();
    let a = l / n as f64;
    let xb = l / 2.0 - a / 2.0;
    Statics {
        name: "fixed-fixed-point".into(),
        title: "Fixed-fixed beam, point load at midspan",
        source: "[Gere] 10.4 / [Roark] Table 8.1 case 1d: M_end = PL/8, M(x) = P x / 2 - P L / 8",
        tier: Tier::Full,
        checks: vec![
            check("end bending stress", left, Q::Bend, p * l / 8.0 / sm, "P L / 8S"),
            check("end shear", left, Q::Shear, p / 2.0, "P / 2"),
            check("bending stress beside the load", b[n / 2 - 1], Q::Bend, (p * xb / 2.0 - p * l / 8.0).abs() / sm, "P x / 2 - P L / 8"),
        ],
        structure: s,
    }
}

/// Two equal spans, continuous over a central roller, self-weight.
pub fn two_span(n: usize) -> Statics {
    assert!(n % 2 == 1, "a chunk centred on the middle support");
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let span = 5.0;
    let l = 2.0 * span;
    let (c, b) = beam(&mut s, "beam", 0.0, l, 0.0, n, BEAM, CONCRETE, m);
    let e = STRIP / 2.0;
    let (_, ra, _) = pin_below(&mut s, c[0], e, -BEAM.d / 2.0, BEAM.b, m);
    let (_, rb, _) = roller_below(&mut s, c[n / 2], span, -BEAM.d / 2.0, BEAM.b, m);
    let (_, rc, _) = roller_below(&mut s, c[n - 1], l - e, -BEAM.d / 2.0, BEAM.b, m);
    let w = CONCRETE * BEAM.area() * G;
    let a = l / n as f64;
    let xb = span - a / 2.0; // bond beside the middle support
    let r_a = 3.0 * w * span / 8.0;
    let m_at = |x: f64| r_a * x - w * x * x / 2.0;
    Statics {
        name: "two-span-continuous".into(),
        title: "Two-span continuous beam, self-weight (indeterminate, 1 degree)",
        source: "[Hibbeler] 10 (force method) / [Roark] Table 8.1: R_B = 10wL/8, R_A = R_C = 3wL/8, M_B = -wL^2/8",
        tier: Tier::Quick,
        checks: vec![
            check("centre reaction", rb, Q::Axial, -10.0 * w * span / 8.0, "R_B = -10 w L / 8"),
            check("end reaction (pin)", ra, Q::Axial, -r_a, "R_A = -3 w L / 8"),
            check("end reaction (roller)", rc, Q::Axial, -r_a, "R_C = -3 w L / 8"),
            check("hogging stress beside the centre support", b[n / 2 - 1], Q::Bend, m_at(xb).abs() / BEAM.modulus(), "3wLx/8 - w x^2/2"),
        ],
        structure: s,
    }
}

// ---------------------------------------------------------------------------
// Columns

const COL: Rect = Rect { b: 0.3, d: 0.3 };

/// A column, 3 m in 6 chunks, self-weight and a 20 t block on top.
pub fn axial_column(n: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let h = 3.0;
    let (c, b) = column(&mut s, "col", 0.0, 0.0, h, n, COL, CONCRETE, m);
    let base = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [0.0, -1.0, 0.0], X, COL, m);
    let load_mass = 20_000.0;
    let block = s.chunk("load", [0.0, h + 0.1, 0.0], [COL.d / 2.0, 0.1, COL.b / 2.0], load_mass);
    s.rect_bond(c[n - 1], block, [0.0, h, 0.0], Y, X, COL.d, Z, COL.b, m);
    let p = load_mass * G;
    let w = CONCRETE * COL.area() * G;
    let a = COL.area();
    Statics {
        name: "axial-column".into(),
        title: "Column under axial load and self-weight",
        source: "[Gere] 1.2: sigma = N / A, N(y) = P + w (h - y)",
        tier: Tier::Quick,
        checks: vec![
            check("base axial force", base, Q::Axial, -(p + w * h), "N = -(P + w h)"),
            check("mid-height axial force", b[n / 2 - 1], Q::Axial, -(p + w * h / 2.0), "N = -(P + w h / 2)"),
            zero("base bending stress", base, Q::Bend, (p + w * h) / a, "0 (concentric)"),
        ],
        structure: s,
    }
}

/// A near-weightless column with a 20 t block sitting 0.1 m off its axis:
/// eccentric load, outside the kern (d/6 = 0.05 m), so one face is in
/// tension.
pub fn eccentric_column(n: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let h = 2.0;
    let (c, _) = column(&mut s, "col", 0.0, 0.0, h, n, COL, LIGHT, m);
    let base = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [0.0, -1.0, 0.0], X, COL, m);
    let e = 0.1;
    let load_mass = 20_000.0;
    // The block covers the column's top face and reaches 0.2 m past it on
    // one side: its centre is e off the axis.
    let block = s.chunk("load", [e, h + 0.1, 0.0], [COL.d / 2.0 + e, 0.1, COL.b / 2.0], load_mass);
    s.rect_bond(c[n - 1], block, [0.0, h, 0.0], Y, X, COL.d, Z, COL.b, m);
    let p = load_mass * G;
    let a = COL.area();
    let sm = COL.modulus();
    Statics {
        name: "eccentric-column".into(),
        title: "Column, eccentric load (e = 0.1 m, outside the kern d/6)",
        source: "[Gere] 11.5 / [Hib-MoM] 8.4: sigma = -P/A -/+ P e / S",
        tier: Tier::Quick,
        checks: vec![
            check("base compression fibre", base, Q::Compression, p / a + p * e / sm, "P/A + P e / S"),
            check("base tension fibre", base, Q::Tension, p * e / sm - p / a, "P e / S - P/A"),
            check("base axial force", base, Q::Axial, -p, "N = -P"),
        ],
        structure: s,
    }
}

// ---------------------------------------------------------------------------
// Frames

const FRAME: Rect = Rect { b: 0.2, d: 0.3 };

/// Rotation about z by -90 degrees: the structure's +x points down, so a
/// chunk's weight acts along the frame's +x -- a lateral load.
pub const LATERAL: [f64; 4] = [0.0, 0.0, -std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2];

/// Portal frame with fixed bases: columns h = 3 m at x = 0 and 6 m, beam at
/// y = 3 m, one section throughout, near-weightless, a lateral load H at the
/// left knee (a 10 t knee, the frame turned so its weight acts along +x).
pub fn portal_lateral(nc: usize, nb: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let (h, l) = (3.0, 6.0);
    let d = FRAME.d;
    let (lc, lb) = column(&mut s, "left", 0.0, 0.0, h - d / 2.0, nc, FRAME, LIGHT, m);
    let (rc, rb) = column(&mut s, "right", l, 0.0, h - d / 2.0, nc, FRAME, LIGHT, m);
    let lbase = fixed(&mut s, lc[0], [0.0, 0.0, 0.0], [0.0, -1.0, 0.0], X, FRAME, m);
    let rbase = fixed(&mut s, rc[0], [l, 0.0, 0.0], [0.0, -1.0, 0.0], X, FRAME, m);
    let load_mass = 10_000.0;
    let knee_half = [d / 2.0, d / 2.0, FRAME.b / 2.0];
    let lk = s.chunk("left knee", [0.0, h, 0.0], knee_half, load_mass);
    let rk = s.chunk("right knee", [l, h, 0.0], knee_half, LIGHT * d * d * FRAME.b);
    let ltop = s.rect_bond(lc[nc - 1], lk, [0.0, h - d / 2.0, 0.0], Y, X, d, Z, FRAME.b, m);
    let rtop = s.rect_bond(rc[nc - 1], rk, [l, h - d / 2.0, 0.0], Y, X, d, Z, FRAME.b, m);
    let (bc, _) = beam(&mut s, "beam", d / 2.0, l - d / 2.0, h, nb, FRAME, LIGHT, m);
    s.rect_bond(lk, bc[0], [d / 2.0, h, 0.0], X, Y, d, Z, FRAME.b, m);
    s.rect_bond(bc[nb - 1], rk, [l - d / 2.0, h, 0.0], X, Y, d, Z, FRAME.b, m);
    let _ = (lb, rb);
    s.rotation = LATERAL;
    let hh = load_mass * G;
    let k = (FRAME.inertia() / l) / (FRAME.inertia() / h);
    let m_base = hh * h / 2.0 * (1.0 + 3.0 * k) / (1.0 + 6.0 * k);
    // Column moment is linear, shear H/2: at the top bond y = h - d/2.
    let y_top = h - d / 2.0;
    let m_top = (m_base - hh / 2.0 * y_top).abs();
    let v = (hh * h - 2.0 * m_base) / l;
    let sm = FRAME.modulus();
    Statics {
        name: "portal-frame-lateral".into(),
        title: "Portal frame, fixed bases, lateral load H at beam level",
        source: "[Hibbeler] 11.5 (slope-deflection, sidesway): M_base = (H h / 2)(1 + 3k)/(1 + 6k), k = (I_b/L)/(I_c/h); column shear H/2",
        tier: Tier::Quick,
        checks: vec![
            check("left base bending stress", lbase, Q::Bend, m_base / sm, "(Hh/2)(1+3k)/(1+6k) / S"),
            check("right base bending stress", rbase, Q::Bend, m_base / sm, "(Hh/2)(1+3k)/(1+6k) / S"),
            check("left column-top bending stress", ltop, Q::Bend, m_top / sm, "|M_base - (H/2) y| / S"),
            check("left base shear", lbase, Q::Shear, hh / 2.0, "H / 2"),
            check("right base shear", rbase, Q::Shear, hh / 2.0, "H / 2"),
            check("windward column axial (uplift)", lbase, Q::Axial, v, "(H h - 2 M_base) / L"),
            check("leeward column axial", rbase, Q::Axial, -v, "-(H h - 2 M_base) / L"),
        ]
        .into_iter()
        .chain(std::iter::once(check("right column-top bending stress", rtop, Q::Bend, m_top / sm, "|M_base - (H/2) y| / S")))
        .collect(),
        structure: s,
    }
}

/// Three-hinged frame (a three-hinged arch of straight members): columns
/// pinned at their feet, the beam hinged at midspan; the beam (concrete)
/// carries its own weight, columns near-weightless.
pub fn three_hinged(nc: usize, nb_half: usize) -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let (h, l) = (3.0, 6.0);
    let d = FRAME.d;
    let (lc, lcb) = column(&mut s, "left", 0.0, 0.0, h - d / 2.0, nc, FRAME, LIGHT, m);
    let (rc, _) = column(&mut s, "right", l, 0.0, h - d / 2.0, nc, FRAME, LIGHT, m);
    let (_, lpin, _) = pin_below(&mut s, lc[0], 0.0, 0.0, FRAME.b, m);
    let (_, rpin, _) = pin_below(&mut s, rc[0], l, 0.0, FRAME.b, m);
    let knee_mass = CONCRETE * d * d * FRAME.b;
    let knee_half = [d / 2.0, d / 2.0, FRAME.b / 2.0];
    let lk = s.chunk("left knee", [0.0, h, 0.0], knee_half, knee_mass);
    let rk = s.chunk("right knee", [l, h, 0.0], knee_half, knee_mass);
    let ltop = s.rect_bond(lc[nc - 1], lk, [0.0, h - d / 2.0, 0.0], Y, X, d, Z, FRAME.b, m);
    s.rect_bond(rc[nc - 1], rk, [l, h - d / 2.0, 0.0], Y, X, d, Z, FRAME.b, m);
    let gap = STRIP; // the crown hinge: a 2 cm block, a 2 cm strip each side
    let (lb, lbb) = beam(&mut s, "beam L", d / 2.0, l / 2.0 - gap / 2.0, h, nb_half, FRAME, CONCRETE, m);
    let (rb, _) = beam(&mut s, "beam R", l / 2.0 + gap / 2.0, l - d / 2.0, h, nb_half, FRAME, CONCRETE, m);
    s.rect_bond(lk, lb[0], [d / 2.0, h, 0.0], X, Y, d, Z, FRAME.b, m);
    s.rect_bond(rb[nb_half - 1], rk, [l - d / 2.0, h, 0.0], X, Y, d, Z, FRAME.b, m);
    let crown = s.chunk("crown", [l / 2.0, h, 0.0], [gap / 2.0, STRIP / 2.0, FRAME.b / 2.0], LIGHT * gap * STRIP * FRAME.b);
    s.rect_bond(lb[nb_half - 1], crown, [l / 2.0 - gap / 2.0, h, 0.0], X, Y, STRIP, Z, FRAME.b, m);
    s.rect_bond(crown, rb[0], [l / 2.0 + gap / 2.0, h, 0.0], X, Y, STRIP, Z, FRAME.b, m);
    // H = M0 / h: the simple-beam moment at the crown for the actual loads.
    let loads: Vec<(f64, f64)> = s.chunks.iter().filter(|c| c.mass > 0.0).map(|c| (c.center[0], c.mass * G)).collect();
    let m0 = simple_moment(&loads, 0.0, l, l / 2.0);
    let hh = m0 / h;
    let total: f64 = loads.iter().map(|x| x.1).sum();
    let w = CONCRETE * FRAME.area() * G;
    let _ = lcb;
    let quarter = lbb[nb_half / 2 - 1];
    Statics {
        name: "three-hinged-frame".into(),
        title: "Three-hinged frame (arch), self-weight of the beam",
        source: "[Hibbeler] 5.3 three-hinged arch: H = M0(crown) / h (UDL: w L^2 / 8h), V = W / 2",
        tier: Tier::Quick,
        checks: vec![
            check("left horizontal thrust", lpin, Q::Shear, hh, &format!("M0 / h (w L^2/8h = {:.2} kN)", w * l * l / 8.0 / h / 1e3)),
            check("right horizontal thrust", rpin, Q::Shear, hh, "M0 / h"),
            check("left vertical reaction", lpin, Q::Axial, -total / 2.0, "-W / 2"),
            check("beam axial force (= -H)", quarter, Q::Axial, -hh, "-H"),
            check("column-top bending stress", ltop, Q::Bend, hh * (h - d / 2.0) / FRAME.modulus(), "H (h - d/2) / S"),
        ],
        structure: s,
    }
}

/// A refined copy of a case (`n` chunks per member) for the convergence
/// study: the full tier runs each discretisation-limited case at 2x and 4x
/// the chunk count to show the model converging on the textbook.
fn refined(mut c: Statics, n: usize) -> Statics {
    c.name = format!("{}/n{}", c.name, n);
    c.tier = Tier::Full;
    c
}

pub fn registry() -> Vec<Statics> {
    let mut cases = vec![
        cantilever_tip(8),
        cantilever_self_weight(8),
        simply_supported_point(9),
        simply_supported_udl(12),
        propped_cantilever(12),
        fixed_fixed_udl(12),
        fixed_fixed_point(9),
        two_span(21),
        axial_column(6),
        eccentric_column(4),
        portal_lateral(6, 12),
        three_hinged(6, 6),
        pratt_truss(),
        torsion_round(),
        torsion_square(),
    ];
    cases.extend([
        refined(simply_supported_point(19), 19),
        refined(simply_supported_point(37), 37),
        refined(propped_cantilever(24), 24),
        refined(propped_cantilever(48), 48),
        refined(fixed_fixed_udl(24), 24),
        refined(fixed_fixed_udl(48), 48),
        refined(two_span(41), 41),
        refined(two_span(81), 81),
        refined(portal_lateral(12, 24), 24),
    ]);
    cases
}

// ---------------------------------------------------------------------------
// Trusses and shafts (convex-hull chunks)

/// An oriented box prism as hull points about its centre: `half_len` along
/// `axis`, `hw` along `w`, `hz` along z.
fn prism(axis: V3, w: V3, half_len: f64, hw: f64, hz: f64) -> Vec<V3> {
    let mut pts = Vec::new();
    for sa in [-1.0, 1.0] {
        for sw in [-1.0, 1.0] {
            for sz in [-1.0, 1.0] {
                pts.push(add(add(scale(axis, sa * half_len), scale(w, sw * hw)), [0.0, 0.0, sz * hz]));
            }
        }
    }
    pts
}

/// Pratt truss: 4 panels of 2 m, 2 m deep, steel members 100 x 100 mm
/// (near-weightless), 150 mm gusset cubes at the joints, a 10 t load at each
/// interior bottom joint; pin at the left support, roller at the right.
pub fn pratt_truss() -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_STEEL);
    let (a, h, g, t) = (2.0, 2.0, 0.15, 0.1);
    let load_mass = 10_000.0;
    let mut node = std::collections::HashMap::new();
    for i in 0..=4 {
        let mass = if (1..=3).contains(&i) { load_mass } else { LIGHT * 8.0 * g * g * g };
        node.insert(format!("B{i}"), s.chunk(&format!("B{i}"), [a * i as f64, 0.0, 0.0], [g, g, g], mass));
    }
    for i in 1..=3 {
        node.insert(format!("T{i}"), s.chunk(&format!("T{i}"), [a * i as f64, h, 0.0], [g, g, g], LIGHT * 8.0 * g * g * g));
    }
    let mut member = |s: &mut Structure, from: &str, to: &str| -> (usize, usize) {
        let (na, nb) = (node[from], node[to]);
        let (pa, pb) = (s.chunks[na].center, s.chunks[nb].center);
        let d = sub(pb, pa);
        let len = norm(d);
        let u = normalize(d);
        let w = [-u[1], u[0], 0.0];
        // Axis-aligned members meet the gusset at its face; diagonals 0.1 m
        // from its centre, where the cube's section still covers theirs.
        let inset = if u[0].abs() > 0.99 || u[1].abs() > 0.99 { g } else { 0.1 };
        let (ea, eb) = (add(pa, scale(u, inset)), sub(pb, scale(u, inset)));
        let center = scale(add(ea, eb), 0.5);
        let half_len = (len - 2.0 * inset) / 2.0;
        let mass = LIGHT * 2.0 * half_len * t * t;
        let c = s.hull_chunk(&format!("{from}{to}"), center, prism(u, w, half_len, t / 2.0, t / 2.0), mass);
        let b0 = s.rect_bond(na, c, ea, u, w, t, Z, t, m);
        let b1 = s.rect_bond(c, nb, eb, u, w, t, Z, t, m);
        (b0, b1)
    };
    let end_diag = member(&mut s, "B0", "T1");
    let bottom = member(&mut s, "B1", "B2");
    member(&mut s, "B0", "B1");
    member(&mut s, "B2", "B3");
    member(&mut s, "B3", "B4");
    let top = member(&mut s, "T1", "T2");
    member(&mut s, "T2", "T3");
    let vert = member(&mut s, "B1", "T1");
    let centre = member(&mut s, "B2", "T2");
    member(&mut s, "B3", "T3");
    let diag = member(&mut s, "T1", "B2");
    member(&mut s, "T3", "B2");
    member(&mut s, "T3", "B4");
    let (_, pin, _) = pin_below(&mut s, node["B0"], 0.0, -g, 2.0 * g, m);
    roller_below(&mut s, node["B4"], 4.0 * a, -g, 2.0 * g, m);
    let p = load_mass * G;
    let r2 = std::f64::consts::SQRT_2;
    Statics {
        name: "pratt-truss".into(),
        title: "Pratt truss, 4 panels, panel loads P at the bottom chord",
        source: "[Hibbeler] 3.4 method of joints (pin-jointed): R = 3P/2; end diagonal -R/sin45; chord = M/h",
        tier: Tier::Quick,
        checks: vec![
            check("end diagonal B0-T1", end_diag.0, Q::Axial, -1.5 * r2 * p, "-3P/2 / sin 45 (compression)"),
            check("bottom chord B1-B2", bottom.0, Q::Axial, 1.5 * p, "M(B1)/h = 3P/2"),
            check("top chord T1-T2", top.0, Q::Axial, -2.0 * p, "-M(mid)/h = -2P"),
            check("vertical B1-T1", vert.0, Q::Axial, p, "+P (hanger)"),
            check("diagonal T1-B2", diag.0, Q::Axial, 0.5 * r2 * p, "(R - P) / sin 45"),
            zero("centre vertical B2-T2 (zero-force)", centre.0, Q::Axial, p, "0"),
            check("left support reaction", pin, Q::Axial, -1.5 * p, "-3P/2"),
        ],
        structure: s,
    }
}

/// A 28-sided shaft polygon of circumradius `r` in the (y, z) plane, with
/// the four edges that cross the y and z axes 2% longer than the rest so the
/// section's principal axes (bond_section.h takes the longest edge for an
/// isotropic patch) are y and z for certain.
const SHAFT_SIDES: usize = 28;

fn shaft_polygon(r: f64) -> Vec<[f64; 2]> {
    // 28 sides, 56 hull vertices: under the cooker's 64-vertex limit with
    // room to spare (at 32 sides, 64 vertices, the cooked hull dropped one).
    let per = SHAFT_SIDES / 4;
    let alpha = (90.0f64 / (2 * per) as f64 * 1.02).to_radians();
    let beta = ((90.0f64).to_radians() - 2.0 * alpha) / (2 * (per - 1)) as f64;
    let mut out = Vec::new();
    for q in 0..4 {
        let base = (90.0 * q as f64).to_radians();
        let mut th = base + alpha;
        for _ in 0..per {
            out.push([r * th.cos(), r * th.sin()]);
            th += 2.0 * beta;
        }
        // the eighth vertex lands at base + 90 - alpha (next edge is the
        // long one across the next axis)
    }
    out
}

/// Polygon properties: area, second moment about the in-plane x axis (of
/// the 2D coordinates), polar moment.
fn polygon_props(p: &[[f64; 2]]) -> (f64, f64, f64) {
    let (mut a, mut ixx, mut iyy) = (0.0, 0.0, 0.0);
    for i in 0..p.len() {
        let (s, t) = (p[i], p[(i + 1) % p.len()]);
        let w = s[0] * t[1] - t[0] * s[1];
        a += w;
        ixx += (s[1] * s[1] + s[1] * t[1] + t[1] * t[1]) * w;
        iyy += (s[0] * s[0] + s[0] * t[0] + t[0] * t[0]) * w;
    }
    (a / 2.0, ixx / 12.0, (ixx + iyy) / 12.0)
}

/// Round shaft in torsion: a 2 m steel shaft (28-sided, R = 0.1 m) fixed at
/// one end, a 1 t lever box at the free end whose weight acts 0.3 m off the
/// shaft's axis: torque T = W e, plus bending and shear from the same W.
pub fn torsion_round() -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_STEEL);
    let (r, l, n) = (0.1, 2.0, 4);
    let poly = shaft_polygon(r);
    let a = l / n as f64;
    let mut chunks = Vec::new();
    let mut bonds = Vec::new();
    let face = |x: f64| poly.iter().map(|q| [x, q[0], q[1]]).collect::<Vec<V3>>();
    for i in 0..n {
        let cx = (i as f64 + 0.5) * a;
        let mut pts = face(-a / 2.0);
        pts.extend(face(a / 2.0));
        let c = s.hull_chunk(&format!("shaft{i}"), [cx, 0.0, 0.0], pts, LIGHT * a * 0.03);
        if let Some(&prev) = chunks.last() {
            bonds.push(s.poly_bond(prev, c, [i as f64 * a, 0.0, 0.0], X, face(i as f64 * a), m));
        }
        chunks.push(c);
    }
    let anchor = s.chunk("anchor", [0.0, 0.0, 0.0], [PLATE, 0.2, 0.2], 0.0);
    let root = s.poly_bond(chunks[0], anchor, [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], face(0.0), m);
    // The lever: a box over the shaft's end face reaching 0.5 m out along +z.
    let (lx, reach) = (0.2, 0.7);
    let lever_mass = 1000.0;
    let lever = s.chunk("lever", [l + lx / 2.0, 0.0, (reach - r) / 2.0], [lx / 2.0, r, (reach + r) / 2.0], lever_mass);
    s.poly_bond(chunks[n - 1], lever, [l, 0.0, 0.0], X, face(l), m);
    let w = lever_mass * G;
    let e = (reach - r) / 2.0;
    let torque = w * e;
    // The section as built: its polar moment and second moment about z.
    let (area, iz, jp) = polygon_props(&poly);
    let c_fibre = poly.iter().map(|q| q[0].abs()).fold(0.0, f64::max); // extreme y
    let _ = area;
    let mid = bonds[n / 2 - 1];
    let arm = l + lx / 2.0;
    Statics {
        name: "torsion-round-shaft".into(),
        title: "Round shaft (28-sided), torque from an offset load",
        source: "[Gere] 3.3 torsion formula tau = T r / J; [Roark] Table A.1 polygon J; sigma = M c / I",
        tier: Tier::Quick,
        checks: vec![
            check("root torsional shear", root, Q::Twist { transverse: w }, torque * r / jp, "T r / J, T = W e"),
            check("mid torsional shear", mid, Q::Twist { transverse: w }, torque * r / jp, "T r / J"),
            check("root bending stress", root, Q::Bend, w * arm * c_fibre / iz, "W a c / I"),
            check("root shear force", root, Q::Shear, w + torque * r / jp * area, "(V + T r A / J): shear stress x A"),
        ],
        structure: s,
    }
}

/// Square shaft in torsion: Saint-Venant's warping solution against the
/// stage's interface (weld-group) torsion modulus I_p / r_max.
pub fn torsion_square() -> Statics {
    let mut s = Structure::new();
    let m = strong(&mut s, E_STEEL);
    let sec = Rect { b: 0.2, d: 0.2 };
    let l = 2.0;
    let n = 4;
    let (c, b) = beam(&mut s, "shaft", 0.0, l, 0.0, n, sec, LIGHT, m);
    let root = fixed(&mut s, c[0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0], Y, sec, m);
    let (lx, reach) = (0.2, 0.7);
    let lever_mass = 1000.0;
    let lever = s.chunk("lever", [l + lx / 2.0, 0.0, (reach - 0.1) / 2.0], [lx / 2.0, 0.1, (reach + 0.1) / 2.0], lever_mass);
    s.rect_bond(c[n - 1], lever, [l, 0.0, 0.0], X, Y, sec.d, Z, sec.b, m);
    let w = lever_mass * G;
    let torque = w * (reach - 0.1) / 2.0;
    let side = sec.b;
    Statics {
        name: "torsion-square-shaft".into(),
        title: "Square shaft, torque from an offset load (Saint-Venant)",
        source: "[Roark] Table 10.1 case 4 / [Timo-Goodier] 109: tau_max = T / (0.208 a^3)",
        tier: Tier::Quick,
        checks: vec![
            check("root torsional shear", root, Q::Twist { transverse: w }, torque / (0.208 * side.powi(3)), "T / (0.208 a^3)"),
            check("mid torsional shear", b[n / 2 - 1], Q::Twist { transverse: w }, torque / (0.208 * side.powi(3)), "T / (0.208 a^3)"),
        ],
        structure: s,
    }
}
