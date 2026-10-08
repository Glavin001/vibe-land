//! The structure a textbook case is built from, and an independent f64 solve
//! of it.
//!
//! A structure is rigid chunks joined by bonds, exactly what the native stage
//! is given. Two things are computed here, neither of them by the stage:
//!
//! 1. The bond sections (area, principal second moments, section and polar
//!    moduli, radii of gyration) from each bond's contact polygon, by the same
//!    algorithm as `physx-bridge/include/bond_section.h`.
//! 2. The exact solution of the stage's own discrete model ("the model"), by
//!    the stiffness method in f64: every bond a spring at its face (or at the
//!    chunks' midpoint, see `Rotation::Uniform`), translational stiffness
//!    k = (E / E_ref) max(A, 1e-4) / max(L, 0.05) and a rotational stiffness
//!    that depends on the configuration. The stage's stress solve minimises
//!    the bonds' complementary energy under equilibrium, which is exactly this
//!    frame's elastic answer (see tests/section_rotation.rs).
//!
//! The model separates the two ways a simulated number can differ from the
//! textbook: the chunked discretisation (model vs textbook, deterministic) and
//! the GPU solve in FP32 at production settings (stage vs model).

pub type V3 = [f64; 3];

pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
pub fn normalize(a: V3) -> V3 {
    scale(a, 1.0 / norm(a))
}

/// The stage's reference modulus (30 GPa): stiffness is (E / E_ref) A / L.
pub const REFERENCE_MODULUS: f64 = 30e9;

#[derive(Clone, Debug)]
pub struct Chunk {
    pub name: String,
    pub center: V3,
    /// Box half extents (the box's geometry when `hull` is None; otherwise the
    /// hull's bounding half extents).
    pub half: V3,
    /// Convex hull vertices relative to `center` (symmetric about it, so the
    /// centre of mass is the centre).
    pub hull: Option<Vec<V3>>,
    /// kg; zero is an anchor (a world support).
    pub mass: f64,
}

impl Chunk {
    pub fn volume(&self) -> f64 {
        match &self.hull {
            None => 8.0 * self.half[0] * self.half[1] * self.half[2],
            // Prisms here: area of the cross-section times length is not
            // needed by the stage beyond being positive; the bounding box is
            // an upper bound and only used for density defaults (unused).
            Some(_) => 8.0 * self.half[0] * self.half[1] * self.half[2],
        }
    }
}

/// Material, Pa. Elastic and fatal limits are equal (brittle): the bond holds
/// with no damage up to the limit and fails at it (extStressBondDamage).
#[derive(Clone, Copy, Debug)]
pub struct Material {
    pub modulus: f64,
    pub compression: f64,
    pub tension: f64,
    pub shear: f64,
}

impl Material {
    /// Never fails: statics cases.
    pub fn unbreakable(modulus: f64) -> Self {
        Self { modulus, compression: 1e13, tension: 1e13, shear: 1e13 }
    }
}

#[derive(Clone, Debug)]
pub struct Bond {
    pub a: usize,
    pub b: usize,
    pub centroid: V3,
    pub normal: V3,
    /// The contact patch's corners in 3D (any order); projected onto the
    /// bond plane for the section.
    pub patch: Vec<V3>,
    pub material: usize,
}

#[derive(Clone, Debug)]
pub struct Structure {
    pub chunks: Vec<Chunk>,
    pub bonds: Vec<Bond>,
    pub materials: Vec<Material>,
    /// Structure pose rotation (x, y, z, w): local -> world. Gravity acts
    /// along world -y, so a rotated structure feels it along another of its
    /// own axes (how a lateral load is applied).
    pub rotation: [f64; 4],
    /// Fragment body linear damping; None keeps the game's default (0.25).
    pub linear_damping: Option<f64>,
    /// World position of the structure's origin.
    pub origin: V3,
    /// Chunk crushing per material (empty: none), parallel to `materials`.
    pub crush: Vec<vibe_land_physx_bridge::CrushMaterialDesc>,
    /// Fastener-group twist per material (empty: none), parallel to
    /// `materials`: (radius of gyration, reach) in m, or (0, 0) for a
    /// material that twists on its patch. Read under section rotation
    /// (town-kit materials.mjs fastenerRow; the bridge's twist tables).
    pub twist: Vec<(f64, f64)>,
}

impl Structure {
    pub fn new() -> Self {
        Self { chunks: Vec::new(), bonds: Vec::new(), materials: Vec::new(), rotation: [0.0, 0.0, 0.0, 1.0], linear_damping: None, origin: [0.0, 20.0, 0.0], crush: Vec::new(), twist: Vec::new() }
    }
    pub fn material(&mut self, m: Material) -> usize {
        self.materials.push(m);
        self.materials.len() - 1
    }
    pub fn chunk(&mut self, name: &str, center: V3, half: V3, mass: f64) -> usize {
        self.chunks.push(Chunk { name: name.to_string(), center, half, hull: None, mass });
        self.chunks.len() - 1
    }
    pub fn hull_chunk(&mut self, name: &str, center: V3, points: Vec<V3>, mass: f64) -> usize {
        let mut half = [0.0f64; 3];
        for p in &points {
            for k in 0..3 {
                half[k] = half[k].max(p[k].abs());
            }
        }
        self.chunks.push(Chunk { name: name.to_string(), center, half, hull: Some(points), mass });
        self.chunks.len() - 1
    }
    /// A bond whose patch is the rectangle `ext_a` along `axis_a` by `ext_b`
    /// along `axis_b`, centred on `centroid`.
    pub fn rect_bond(&mut self, a: usize, b: usize, centroid: V3, normal: V3, axis_a: V3, ext_a: f64, axis_b: V3, ext_b: f64, material: usize) -> usize {
        let mut patch = Vec::new();
        for (sa, sb) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            patch.push(add(centroid, add(scale(axis_a, sa * ext_a / 2.0), scale(axis_b, sb * ext_b / 2.0))));
        }
        self.bonds.push(Bond { a, b, centroid, normal: normalize(normal), patch, material });
        self.bonds.len() - 1
    }
    pub fn poly_bond(&mut self, a: usize, b: usize, centroid: V3, normal: V3, patch: Vec<V3>, material: usize) -> usize {
        self.bonds.push(Bond { a, b, centroid, normal: normalize(normal), patch, material });
        self.bonds.len() - 1
    }
    pub fn total_mass(&self) -> f64 {
        self.chunks.iter().map(|c| c.mass).sum()
    }
    /// World gravity (0, -g, 0) in the structure's own frame.
    pub fn local_gravity(&self, g: f64) -> V3 {
        let [x, y, z, w] = self.rotation;
        // Rotate (0, -g, 0) by the inverse (conjugate) quaternion.
        rotate([-x, -y, -z, w], [0.0, -g, 0.0])
    }
}

impl Default for Structure {
    fn default() -> Self {
        Self::new()
    }
}

pub fn rotate(q: [f64; 4], v: V3) -> V3 {
    let u = [q[0], q[1], q[2]];
    let s = q[3];
    let t = scale(cross(u, v), 2.0);
    add(add(v, scale(t, s)), cross(u, t))
}

/// The bridge's in-plane basis for a bond normal (bond_section.h `section`).
pub fn plane_basis(n: V3) -> (V3, V3) {
    let n = normalize(n);
    let u = normalize(cross(n, if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] }));
    (u, cross(n, u))
}

/// A bond patch's section, as the stage is given it.
#[derive(Clone, Copy, Debug)]
pub struct Section {
    pub area: f64,
    /// Principal axis e0 (world/local frame) and e1 = n x e0.
    pub e0: V3,
    pub e1: V3,
    /// Elastic section moduli for bending about e0 and e1, polar modulus.
    pub s0: f64,
    pub s1: f64,
    pub zt: f64,
    /// Radii of gyration for rotation about e0, e1 and the normal.
    pub g0: f64,
    pub g1: f64,
    pub gp: f64,
}

fn hull2(mut p: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    if p.len() < 3 {
        return p;
    }
    let c2 = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut h: Vec<[f64; 2]> = Vec::new();
    for &q in &p {
        while h.len() >= 2 && c2(h[h.len() - 2], h[h.len() - 1], q) <= 0.0 {
            h.pop();
        }
        h.push(q);
    }
    let t = h.len() + 1;
    for &q in p.iter().rev().skip(1) {
        while h.len() >= t && c2(h[h.len() - 2], h[h.len() - 1], q) <= 0.0 {
            h.pop();
        }
        h.push(q);
    }
    h.pop();
    h
}

/// bond_section.h `section` for an authored patch (geometric area = authored
/// area): principal axes, moduli and radii of gyration.
pub fn section(bond: &Bond) -> Section {
    let n = bond.normal;
    let (u, v) = plane_basis(n);
    let pts: Vec<[f64; 2]> = bond.patch.iter().map(|p| {
        let r = sub(*p, bond.centroid);
        [dot(r, u), dot(r, v)]
    }).collect();
    let p = hull2(pts);
    let (mut a, mut cx, mut cy, mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for i in 0..p.len() {
        let (s, t) = (p[i], p[(i + 1) % p.len()]);
        let w = s[0] * t[1] - t[0] * s[1];
        a += w;
        cx += (s[0] + t[0]) * w;
        cy += (s[1] + t[1]) * w;
        xx += (s[0] * s[0] + s[0] * t[0] + t[0] * t[0]) * w;
        yy += (s[1] * s[1] + s[1] * t[1] + t[1] * t[1]) * w;
        xy += (s[0] * t[1] + 2.0 * s[0] * s[1] + 2.0 * t[0] * t[1] + t[0] * s[1]) * w;
    }
    a *= 0.5;
    cx /= 6.0 * a;
    cy /= 6.0 * a;
    xx = xx / 12.0 - a * cx * cx;
    yy = yy / 12.0 - a * cy * cy;
    xy = xy / 24.0 - a * cx * cy;
    let mut theta = 0.5 * (2.0 * xy).atan2(xx - yy);
    if (xx - yy).abs() <= 1e-6 * (xx + yy) && xy.abs() <= 1e-6 * (xx + yy) {
        let mut best = -1.0;
        for i in 0..p.len() {
            let (s, t) = (p[i], p[(i + 1) % p.len()]);
            let l = (t[0] - s[0]).powi(2) + (t[1] - s[1]).powi(2);
            if l > best {
                best = l;
                theta = (t[1] - s[1]).atan2(t[0] - s[0]);
            }
        }
    }
    let (co, si) = (theta.cos(), theta.sin());
    let lam0 = xx * co * co + 2.0 * xy * co * si + yy * si * si;
    let lam1 = xx * si * si - 2.0 * xy * co * si + yy * co * co;
    let (mut reach0, mut reach1, mut rmax) = (0.0f64, 0.0f64, 0.0f64);
    for q in &p {
        let (x, y) = (q[0] - cx, q[1] - cy);
        reach0 = reach0.max((x * co + y * si).abs());
        reach1 = reach1.max((-x * si + y * co).abs());
        rmax = rmax.max((x * x + y * y).sqrt());
    }
    let e0 = add(scale(u, co), scale(v, si));
    Section {
        area: a,
        e0,
        e1: cross(n, e0),
        s0: lam1 / reach1,
        s1: lam0 / reach0,
        zt: (lam0 + lam1) / rmax,
        g0: (lam1 / a).sqrt(),
        g1: (lam0 / a).sqrt(),
        gp: ((lam0 + lam1) / a).sqrt(),
    }
}

/// The section the stage uses for `b` under `rotation`: under section
/// rotation a fastener-group material twists on its fasteners (polar radius
/// g, twist modulus A g^2 / reach), as the bridge sets it.
pub fn stage_section(s: &Structure, b: &Bond, rotation: Rotation) -> Section {
    let mut sec = section(b);
    if rotation == Rotation::Section {
        if let Some(&(g, reach)) = s.twist.get(b.material) {
            if g > 0.0 && reach > 0.0 {
                sec.gp = g;
                sec.zt = sec.area * g * g / reach;
            }
        }
    }
    sec
}

/// How the stress solve stiffens a bond in rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rotation {
    /// VIBE_SECTION_ROTATION=1: k r^2 about each principal axis and k r_p^2
    /// in twist, sprung at the bond face.
    Section,
    /// The default solve: k Ls^2 about every axis, Ls one length scale for
    /// the whole structure (the mean bond offset), and a bond between two
    /// dynamic chunks sprung at their midpoint.
    Uniform,
}

/// How a bond's wrench becomes stresses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Grading {
    /// VIBE_SECTION_BENDING=1 (and rotation): the moment at the bond's
    /// centroid over the section's own moduli.
    Section,
    /// Default: moment over area times a gain 6/sqrt(A) capped at
    /// `bend_gain_max` (3), torsion 4.81/sqrt(A) capped likewise; the moment
    /// as the solver reports it (about the chunks' midpoint for a bond
    /// between two dynamic chunks).
    AreaGain,
}

/// The engine configurations the suite runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub name: &'static str,
    pub rotation: Rotation,
    pub grading: Grading,
    /// VIBE_BOND_TRUE_STIFFNESS (implied by VIBE_SECTION_ROTATION): k = E A / L
    /// at the bond's own area and contact length max(distance, sqrt(A)), no
    /// floors; otherwise max(A, 1e-4) / max(distance, 0.05).
    pub true_stiffness: bool,
}

impl Config {
    /// From the process environment, as the bridge reads it.
    pub fn from_env() -> Self {
        let flag = |k: &str| std::env::var(k).map(|v| !v.is_empty() && v.parse::<f64>().map(|x| x != 0.0).unwrap_or(false)).unwrap_or(false);
        // The two engine profiles (scripts/fidelity/*.env): "runtime" is what
        // the game ships, every new capability off; "high-fidelity" has them
        // all on (here the ones the stress solve and grading see: section
        // rotational stiffness, which implies section bending).
        // "section-bending" alone is a diagnostic step between them.
        // The high profile has no impact machinery (AGENTS.md "GPU destruction";
        // docs/destruction/CLEANUP_2026-10-08.md). "+impact" names a run with the
        // retired impact models on (VIBE_IMPACT_CAPACITY, VIBE_IMPACT_STEP), on an
        // SDK that still carries them.
        let impact = flag("VIBE_IMPACT_CAPACITY") || flag("VIBE_IMPACT_STEP");
        let rotation = flag("VIBE_SECTION_ROTATION");
        let true_stiffness = rotation || flag("VIBE_BOND_TRUE_STIFFNESS");
        if rotation {
            let name = if impact { "high-fidelity+impact" } else { "high-fidelity" };
            Config { name, rotation: Rotation::Section, grading: Grading::Section, true_stiffness }
        } else if flag("VIBE_SECTION_BENDING") {
            let name = if impact { "high-fidelity(no-rotation)" } else { "section-bending" };
            Config { name, rotation: Rotation::Uniform, grading: Grading::Section, true_stiffness }
        } else {
            Config { name: if impact { "runtime+impact" } else { "runtime" }, rotation: Rotation::Uniform, grading: Grading::AreaGain, true_stiffness }
        }
    }
}

/// What one bond carries, graded: signed normal stress (tension +), shear
/// stress including twist, bending fibre stress, and the extreme fibres.
#[derive(Clone, Copy, Debug, Default)]
pub struct Graded {
    pub normal: f64,
    pub shear: f64,
    pub bend: f64,
    pub tension: f64,
    pub compression: f64,
    /// The plain force decomposition (not graded): axial force (tension +),
    /// shear force magnitude, twisting moment magnitude.
    pub axial_force: f64,
    pub shear_force: f64,
    pub twist: f64,
}

pub fn fibres(normal: f64, bend: f64) -> (f64, f64) {
    ((normal + bend).max(0.0), (bend - normal).max(0.0))
}

/// The stage's translational bond stiffness (append_bonds, non-vehicle).
pub fn bond_stiffness(s: &Structure, b: &Bond, true_stiffness: bool) -> f64 {
    let ca = s.chunks[b.a].center;
    let cb = s.chunks[b.b].center;
    let distance = norm(sub(ca, cb));
    let e = s.materials[b.material].modulus;
    let area = section(b).area;
    if true_stiffness {
        e / REFERENCE_MODULUS * area / distance.max(area.sqrt())
    } else {
        e / REFERENCE_MODULUS * area.max(1e-4) / distance.max(0.05)
    }
}

/// The solver's length scale for `Rotation::Uniform`.
pub fn length_scale(s: &Structure) -> f64 {
    let (mut sum, mut n) = (0.0, 0.0);
    for b in &s.bonds {
        let (pa, pb) = (s.chunks[b.a].center, s.chunks[b.b].center);
        let (da, db) = (s.chunks[b.a].mass > 0.0, s.chunks[b.b].mass > 0.0);
        let half = 0.5 * norm(sub(pb, pa));
        if da {
            sum += if db { half } else { norm(sub(b.centroid, pa)) };
            n += 1.0;
        }
        if db {
            sum += if da { half } else { norm(sub(b.centroid, pb)) };
            n += 1.0;
        }
    }
    sum / n
}

/// Solve dense A x = b (partial pivoting), f64.
pub fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &k| a[i][c].abs().total_cmp(&a[k][c].abs())).unwrap();
        a.swap(c, p);
        b.swap(c, p);
        assert!(a[c][c].abs() > 1e-300, "singular stiffness (a mechanism in the structure)");
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

/// Per bond: the force on chunk b and the moment about the spring point, and
/// that point.
pub struct Wrench {
    pub force: V3,
    pub moment_at_point: V3,
    pub point: V3,
}

/// The exact elastic answer of the stage's discrete model under gravity `g`
/// (m/s^2, world -y), by the stiffness method.
pub fn solve_model(s: &Structure, g: f64, rotation: Rotation, true_stiffness: bool) -> Vec<Wrench> {
    let mut dof = vec![usize::MAX; s.chunks.len()];
    let mut n = 0;
    for (i, c) in s.chunks.iter().enumerate() {
        if c.mass > 0.0 {
            dof[i] = n;
            n += 6;
        }
    }
    let ls = length_scale(s);
    let springs: Vec<(V3, [[f64; 3]; 3], f64)> = s
        .bonds
        .iter()
        .map(|b| {
            let k = bond_stiffness(s, b, true_stiffness);
            let both = s.chunks[b.a].mass > 0.0 && s.chunks[b.b].mass > 0.0;
            let mut rot = [[0.0; 3]; 3];
            let point = match rotation {
                Rotation::Section => {
                    let sec = stage_section(s, b, rotation);
                    for (axis, r) in [(sec.e0, sec.g0), (sec.e1, sec.g1), (b.normal, sec.gp)] {
                        for i in 0..3 {
                            for j in 0..3 {
                                rot[i][j] += k * r * r * axis[i] * axis[j];
                            }
                        }
                    }
                    b.centroid
                }
                Rotation::Uniform => {
                    for i in 0..3 {
                        rot[i][i] = k * ls * ls;
                    }
                    if both {
                        scale(add(s.chunks[b.a].center, s.chunks[b.b].center), 0.5)
                    } else {
                        b.centroid
                    }
                }
            };
            (point, rot, k)
        })
        .collect();
    // G maps q to the bond's relative motion [phi; delta] (b minus a) at X.
    let gmat = |b: &Bond, x: V3| -> Vec<(usize, [[f64; 6]; 6])> {
        let mut out = Vec::new();
        for (chunk, sign) in [(b.a, -1.0), (b.b, 1.0)] {
            if dof[chunk] == usize::MAX {
                continue;
            }
            let r = sub(x, s.chunks[chunk].center);
            let mut m = [[0.0; 6]; 6];
            for i in 0..3 {
                m[i][3 + i] = sign; // phi from theta
                m[3 + i][i] = sign; // delta from t
            }
            let skew = [[0.0, r[2], -r[1]], [-r[2], 0.0, r[0]], [r[1], -r[0], 0.0]];
            for i in 0..3 {
                for c in 0..3 {
                    m[3 + i][3 + c] = sign * skew[i][c];
                }
            }
            out.push((dof[chunk], m));
        }
        out
    };
    let mut kmat = vec![vec![0.0; n]; n];
    let mut blocks = Vec::new();
    for (b, &(x, rot, k)) in s.bonds.iter().zip(&springs) {
        let g_blocks = gmat(b, x);
        let mut sm = [[0.0; 6]; 6];
        for r in 0..3 {
            for c in 0..3 {
                sm[r][c] = rot[r][c];
            }
            sm[3 + r][3 + r] = k;
        }
        for (da, ma) in &g_blocks {
            for (db, mb) in &g_blocks {
                // ma' S mb
                for i in 0..6 {
                    for j in 0..6 {
                        let mut v = 0.0;
                        for r in 0..6 {
                            if ma[r][i] == 0.0 {
                                continue;
                            }
                            for c in 0..6 {
                                v += ma[r][i] * sm[r][c] * mb[c][j];
                            }
                        }
                        kmat[da + i][db + j] += v;
                    }
                }
            }
        }
        blocks.push((g_blocks, sm));
    }
    let gl = s.local_gravity(g);
    let mut f = vec![0.0; n];
    for (i, c) in s.chunks.iter().enumerate() {
        if c.mass > 0.0 {
            for k in 0..3 {
                f[dof[i] + k] = gl[k] * c.mass;
            }
        }
    }
    let q = solve_dense(kmat, f);
    blocks
        .iter()
        .zip(&springs)
        .map(|((g_blocks, sm), &(x, _, _))| {
            let mut motion = [0.0; 6];
            for (d, m) in g_blocks {
                for r in 0..6 {
                    for c in 0..6 {
                        motion[r] += m[r][c] * q[d + c];
                    }
                }
            }
            let mut w = [0.0; 6];
            for r in 0..6 {
                w[r] = -(0..6).map(|c| sm[r][c] * motion[c]).sum::<f64>();
            }
            Wrench { force: [w[3], w[4], w[5]], moment_at_point: [w[0], w[1], w[2]], point: x }
        })
        .collect()
}

/// Grade one bond's wrench (force on chunk b, moment about `point`) the way
/// the stage does.
pub fn grade(s: &Structure, bond_index: usize, w: &Wrench, grading: Grading, rotation: Rotation, bend_gain_max: f64) -> Graded {
    let b = &s.bonds[bond_index];
    let sec = stage_section(s, b, rotation);
    let area = sec.area;
    let d = sub(s.chunks[b.b].center, s.chunks[b.a].center);
    let n = if dot(b.normal, d) >= 0.0 { b.normal } else { scale(b.normal, -1.0) };
    // Force on b along a->b positive: the bond pushes b away (compression).
    let fn_ = dot(w.force, n);
    let axial = -fn_;
    let ft = norm(sub(w.force, scale(n, fn_)));
    let m_c = add(w.moment_at_point, cross(sub(w.point, b.centroid), w.force));
    let mut g = Graded { normal: axial / area, axial_force: axial, shear_force: ft, twist: dot(m_c, n).abs(), ..Default::default() };
    match grading {
        Grading::Section => {
            g.shear = ft / area + g.twist / sec.zt;
            g.bend = dot(m_c, sec.e0).abs() / sec.s0 + dot(m_c, sec.e1).abs() / sec.s1;
        }
        Grading::AreaGain => {
            let m = w.moment_at_point;
            let mt = dot(m, n);
            let mp = norm(sub(m, scale(n, mt)));
            let a = area.max(1e-6);
            let tg = (4.81 / a.sqrt()).min(bend_gain_max);
            let bg = (6.0 / a.sqrt()).min(bend_gain_max);
            g.shear = ft / area + mt.abs() / area * tg;
            g.bend = mp / area * bg;
        }
    }
    let (t, c) = fibres(g.normal, g.bend);
    g.tension = t;
    g.compression = c;
    g
}

/// The model's graded answer for every bond in `config`.
pub fn model_graded(s: &Structure, g: f64, config: Config) -> Vec<Graded> {
    let w = solve_model(s, g, config.rotation, config.true_stiffness);
    (0..s.bonds.len()).map(|k| grade(s, k, &w[k], config.grading, config.rotation, 3.0)).collect()
}
