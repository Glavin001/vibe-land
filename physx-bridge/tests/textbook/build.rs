//! Building blocks for textbook structures: prismatic members cut into box
//! chunks, supports, and loads, in a structure frame with x along the span,
//! y up and z across (the member's width).
//!
//! Supports are authored as real details, because the stage has no notion of
//! a boundary condition, only of chunks and bonds:
//!
//! - **Fixed**: the member's end face bonded over its whole section to an
//!   anchor (a zero-mass chunk). The anchor is a thin plate centred on the
//!   face, so the root bond's spring length is half a segment: the stage
//!   sizes a bond's stiffness by the distance between the chunks' centres
//!   (k = E A / L, and k I / A = E I / L in rotation), and a member cut into
//!   segments of length a is Hencky's bar chain -- joints EI / a inside, and
//!   EI / (a/2) at a fixed end. An anchor whose centre sits further back makes
//!   the fixed end softer than the textbook's.
//! - **Pin**: a short bearing block (2 cm thick) under the member, whose
//!   contact patch is a 2 cm strip across the member's width: it carries any
//!   force but almost no moment, because a bond's rotational stiffness and
//!   moment capacity come from its section, (2 cm)^2 against the member's
//!   depth squared.
//! - **Roller**: a 30 cm pendulum link with such a strip at each end. It
//!   carries the reaction along its length; it resists sideways motion only
//!   through the strips' tiny rotational stiffness over its length.
//!
//! These are what a structural engineer would build to get a pin and a
//! roller, and they work in the stage only when a bond's rotational
//! stiffness comes from its section (VIBE_SECTION_ROTATION=1). In the default
//! solve a bond's rotational stiffness is k Ls^2 for every bond, so a 2 cm
//! strip holds a moment like a full joint: the supports clamp.

use super::model::{Material, Structure, V3};

pub const X: V3 = [1.0, 0.0, 0.0];
pub const Y: V3 = [0.0, 1.0, 0.0];
pub const Z: V3 = [0.0, 0.0, 1.0];

/// Densities (kg/m^3) of real materials, and a near-weightless member for
/// cases about an applied load (its weight is under 1e-5 of the load).
pub const CONCRETE: f64 = 2400.0;
pub const STEEL: f64 = 7850.0;
pub const LIGHT: f64 = 1.0;

/// Moduli, Pa.
pub const E_CONCRETE: f64 = 30e9;
pub const E_STEEL: f64 = 200e9;

/// The support details' dimensions.
pub const STRIP: f64 = 0.02; // a pin's or roller's contact strip, m
pub const BLOCK: f64 = 0.02; // a pin block's height, m
pub const LINK: f64 = 0.30; // a roller link's length, m
pub const PLATE: f64 = 0.01; // an anchor plate's half thickness, m

/// A member's rectangular section: `b` across (z), `d` deep (in the plane of
/// bending, perpendicular to the member's axis).
#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub b: f64,
    pub d: f64,
}

impl Rect {
    pub fn area(&self) -> f64 {
        self.b * self.d
    }
    /// Elastic section modulus for bending in the plane (about z): b d^2 / 6.
    pub fn modulus(&self) -> f64 {
        self.b * self.d * self.d / 6.0
    }
    pub fn inertia(&self) -> f64 {
        self.b * self.d.powi(3) / 12.0
    }
}

/// A horizontal member along x from `x0` to `x1` at height `y` (its
/// centreline), cut into `n` equal chunks bonded end to end. Returns the
/// chunk indices, left to right, and the bond indices between them.
pub fn beam(s: &mut Structure, name: &str, x0: f64, x1: f64, y: f64, n: usize, sec: Rect, density: f64, mat: usize) -> (Vec<usize>, Vec<usize>) {
    let a = (x1 - x0) / n as f64;
    let mut chunks = Vec::new();
    let mut bonds = Vec::new();
    for i in 0..n {
        let cx = x0 + (i as f64 + 0.5) * a;
        let half = [a / 2.0, sec.d / 2.0, sec.b / 2.0];
        let c = s.chunk(&format!("{name}{i}"), [cx, y, 0.0], half, density * a * sec.area());
        if let Some(&prev) = chunks.last() {
            bonds.push(s.rect_bond(prev, c, [x0 + i as f64 * a, y, 0.0], X, Y, sec.d, Z, sec.b, mat));
        }
        chunks.push(c);
    }
    (chunks, bonds)
}

/// A vertical member along y from `y0` to `y1` at `x`, `d` along x.
pub fn column(s: &mut Structure, name: &str, x: f64, y0: f64, y1: f64, n: usize, sec: Rect, density: f64, mat: usize) -> (Vec<usize>, Vec<usize>) {
    let a = (y1 - y0) / n as f64;
    let mut chunks = Vec::new();
    let mut bonds = Vec::new();
    for i in 0..n {
        let cy = y0 + (i as f64 + 0.5) * a;
        let half = [sec.d / 2.0, a / 2.0, sec.b / 2.0];
        let c = s.chunk(&format!("{name}{i}"), [x, cy, 0.0], half, density * a * sec.area());
        if let Some(&prev) = chunks.last() {
            bonds.push(s.rect_bond(prev, c, [x, y0 + i as f64 * a, 0.0], Y, X, sec.d, Z, sec.b, mat));
        }
        chunks.push(c);
    }
    (chunks, bonds)
}

/// A fixed end: `chunk`'s face at `face` (outward normal `out`) bonded over
/// the whole section to a thin anchor plate. `along` is the in-plane axis of
/// the section's depth. Returns the bond.
pub fn fixed(s: &mut Structure, chunk: usize, face: V3, out: V3, along: V3, sec: Rect, mat: usize) -> usize {
    let anchor_half = [
        if out[0] != 0.0 { PLATE } else { 0.5 * sec.d.max(sec.b) },
        if out[1] != 0.0 { PLATE } else { 0.5 * sec.d.max(sec.b) },
        if out[2] != 0.0 { PLATE } else { 0.5 * sec.b },
    ];
    let anchor = s.chunk("anchor", face, anchor_half, 0.0);
    s.rect_bond(chunk, anchor, face, out, along, sec.d, Z, sec.b, mat)
}

/// A pin under `chunk` at (x, y_bottom): a bearing block 2 cm high on an
/// anchor plate. Returns (block chunk, bond member-block, bond block-anchor).
pub fn pin_below(s: &mut Structure, chunk: usize, x: f64, y_bottom: f64, width: f64, mat: usize) -> (usize, usize, usize) {
    let block = s.chunk("pin", [x, y_bottom - BLOCK / 2.0, 0.0], [STRIP / 2.0, BLOCK / 2.0, width / 2.0], LIGHT * STRIP * BLOCK * width);
    let top = s.rect_bond(block, chunk, [x, y_bottom, 0.0], Y, X, STRIP, Z, width, mat);
    let yb = y_bottom - BLOCK;
    let anchor = s.chunk("anchor", [x, yb, 0.0], [0.1, PLATE, width / 2.0], 0.0);
    let bottom = s.rect_bond(anchor, block, [x, yb, 0.0], Y, X, STRIP, Z, width, mat);
    (block, top, bottom)
}

/// A roller under `chunk` at (x, y_bottom): a 30 cm pendulum link with a
/// 2 cm strip at each end. Returns (link chunk, bond member-link, bond
/// link-anchor).
pub fn roller_below(s: &mut Structure, chunk: usize, x: f64, y_bottom: f64, width: f64, mat: usize) -> (usize, usize, usize) {
    let link = s.chunk("roller", [x, y_bottom - LINK / 2.0, 0.0], [STRIP / 2.0, LINK / 2.0, width / 2.0], LIGHT * STRIP * LINK * width);
    let top = s.rect_bond(link, chunk, [x, y_bottom, 0.0], Y, X, STRIP, Z, width, mat);
    let yb = y_bottom - LINK;
    let anchor = s.chunk("anchor", [x, yb, 0.0], [0.1, PLATE, width / 2.0], 0.0);
    let bottom = s.rect_bond(anchor, link, [x, yb, 0.0], Y, X, STRIP, Z, width, mat);
    (link, top, bottom)
}

/// Structure materials: one unbreakable material per modulus used.
pub fn strong(s: &mut Structure, modulus: f64) -> usize {
    s.material(Material::unbreakable(modulus))
}

/// The simple-beam moment at `x` for point loads `loads` (x_i, W_i) on a span
/// with supports at `xa` and `xb` (statics of a free body).
pub fn simple_moment(loads: &[(f64, f64)], xa: f64, xb: f64, x: f64) -> f64 {
    let span = xb - xa;
    let rb: f64 = loads.iter().map(|&(xi, w)| w * (xi - xa) / span).sum();
    let ra: f64 = loads.iter().map(|&(_, w)| w).sum::<f64>() - rb;
    let mut m = ra * (x - xa);
    for &(xi, w) in loads {
        if xi < x {
            m -= w * (x - xi);
        }
    }
    m
}

/// A hanger over `chunk` at (x, y_top): a 30 cm link from an anchor above,
/// with a 2 cm strip at each end -- a roller that carries its reaction in
/// tension, so when it fails nothing is left under the member. Returns (link
/// chunk, bond member-link, bond link-anchor).
pub fn hanger_above(s: &mut Structure, chunk: usize, x: f64, y_top: f64, width: f64, mat: usize) -> (usize, usize, usize) {
    let link = s.chunk("hanger", [x, y_top + LINK / 2.0, 0.0], [STRIP / 2.0, LINK / 2.0, width / 2.0], LIGHT * STRIP * LINK * width);
    let bottom = s.rect_bond(chunk, link, [x, y_top, 0.0], Y, X, STRIP, Z, width, mat);
    let yt = y_top + LINK;
    let anchor = s.chunk("anchor", [x, yt, 0.0], [0.1, PLATE, width / 2.0], 0.0);
    let top = s.rect_bond(link, anchor, [x, yt, 0.0], Y, X, STRIP, Z, width, mat);
    (link, bottom, top)
}

/// A pin over `chunk` at (x, y_top): a 2 cm block hung from an anchor plate.
pub fn pin_above(s: &mut Structure, chunk: usize, x: f64, y_top: f64, width: f64, mat: usize) -> (usize, usize, usize) {
    let block = s.chunk("pin", [x, y_top + BLOCK / 2.0, 0.0], [STRIP / 2.0, BLOCK / 2.0, width / 2.0], LIGHT * STRIP * BLOCK * width);
    let bottom = s.rect_bond(chunk, block, [x, y_top, 0.0], Y, X, STRIP, Z, width, mat);
    let yt = y_top + BLOCK;
    let anchor = s.chunk("anchor", [x, yt, 0.0], [0.1, PLATE, width / 2.0], 0.0);
    let top = s.rect_bond(block, anchor, [x, yt, 0.0], Y, X, STRIP, Z, width, mat);
    (block, bottom, top)
}
