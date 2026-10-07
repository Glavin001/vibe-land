//! Authoring lint for any native destructible (building or vehicle): the
//! stress-convergence checklist (.claude/skills/stress-convergence) as code,
//! run on the exact graph handed to the stage.
//!
//! Each finding says what was measured, the threshold and where it comes from,
//! and the worst examples by name, so a structure can be fixed without
//! re-deriving the analysis. Nothing here runs the solver; convergence itself
//! is judged from the native solve report (see the structure qualification).

use std::collections::BTreeMap;

/// The bridge floors bond stiffness at this area (m²) while strength uses the
/// true area (physx-bridge append_bonds); a smaller interface draws load it
/// cannot carry. Same constant as client strength-profile SOLVER_MIN_BOND_AREA_M2.
pub const SOLVER_MIN_BOND_AREA_M2: f32 = 1e-4;
/// append_bonds' reference modulus and length floor (stiffness weight).
const REFERENCE_MODULUS_PA: f32 = 30e9;
const MIN_WEIGHT_LENGTH_M: f32 = 0.05;
const G: f32 = vibe_netcode::movement::GRAVITY as f32;

#[derive(Clone, Debug)]
pub struct LintNode {
    pub label: String,
    pub position: [f32; 3],
    /// Zero marks an anchored (static) chunk, Blast's convention.
    pub mass: f32,
    /// Principal moments about the chunk's COM, when authored (vehicles).
    pub principal_inertia: Option<[f32; 3]>,
    /// Chunks that move rigidly together (a vehicle's rig binding); a bond
    /// between different groups joins parts that move relative to each other.
    pub group: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LintBond {
    pub a: usize,
    pub b: usize,
    pub area: f32,
    pub centroid: [f32; 3],
    pub modulus: f32,
    pub tension_fatal: f32,
    pub compression_fatal: f32,
    pub shear_fatal: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
pub enum Severity { Info, Warning, Blocker }

#[derive(Clone, Debug, serde::Serialize)]
pub struct Finding {
    pub check: &'static str,
    pub severity: Severity,
    pub summary: String,
    /// Why this threshold: the measurement or rule it comes from.
    pub basis: &'static str,
    pub examples: Vec<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct LintStats {
    pub nodes: usize,
    pub anchored: usize,
    pub bonds: usize,
    pub components: usize,
    pub mass_kg: f64,
    pub area_quantiles_m2: [f32; 5],
    pub stiffness_spread: f32,
    pub max_mass_ratio_across_bond: f32,
    pub sole_attachments: usize,
    pub weakest_sole_attachment_g: f32,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct LintReport {
    pub stats: LintStats,
    pub findings: Vec<Finding>,
}

impl LintReport {
    pub fn blockers(&self) -> usize { self.findings.iter().filter(|f| f.severity == Severity::Blocker).count() }
    /// One line per finding, worst first.
    pub fn card(&self) -> String {
        let mut out = String::new();
        let s = &self.stats;
        out.push_str(&format!("{} chunks ({} anchored), {} bonds, {} component(s), {:.0} kg; bond area median {:.1e} m² (min {:.1e}); stiffness spread {:.1e}; worst mass ratio across a bond {:.0}; {} sole attachment(s), weakest carries {:.0} g of what hangs from it\n",
            s.nodes, s.anchored, s.bonds, s.components, s.mass_kg, s.area_quantiles_m2[2], s.area_quantiles_m2[0], s.stiffness_spread, s.max_mass_ratio_across_bond, s.sole_attachments, s.weakest_sole_attachment_g));
        let mut findings = self.findings.clone();
        findings.sort_by(|a, b| b.severity.cmp(&a.severity));
        for f in &findings {
            out.push_str(&format!("  {:?} {}: {}\n", f.severity, f.check, f.summary));
            for e in f.examples.iter().take(5) { out.push_str(&format!("      {e}\n")); }
        }
        out
    }
}

pub struct LintOptions {
    /// Warn when one bond joins chunks whose masses differ by more than this.
    pub mass_ratio_warning: f32,
    /// Warn when a sole attachment cannot carry this many g of what hangs from it.
    pub sole_attachment_g_warning: f32,
    /// The bridge's contact-length stiffness (length >= sqrt(area)): on for
    /// vehicle structures (VIBE_VEHICLE_BOND_CONTACT_LENGTH, default on), off
    /// for the city (VIBE_BOND_CONTACT_LENGTH, default off). Must match what
    /// append_bonds gives the stage, or the spread reported is not the one solved.
    pub contact_length: bool,
    /// The bridge's VIBE_BOND_TRUE_STIFFNESS (implied by VIBE_SECTION_ROTATION):
    /// bond stiffness E A / L with no area or length floor, so a sliver carries
    /// only its own share and is no longer a blocker (FIDELITY_AUDIT A1, H1).
    pub true_stiffness: bool,
}

/// Whether this process runs the bridge's true bond stiffness (same flags,
/// same reading as physx-bridge native_destruction.cc).
pub fn true_stiffness_from_env() -> bool {
    let on = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<f32>().ok()).is_some_and(|v| v != 0.0);
    on("VIBE_BOND_TRUE_STIFFNESS") || on("VIBE_SECTION_ROTATION")
}

impl Default for LintOptions {
    fn default() -> Self {
        Self { mass_ratio_warning: 100., sole_attachment_g_warning: 10., contact_length: false, true_stiffness: true_stiffness_from_env() }
    }
}

impl LintOptions {
    /// What the bridge uses for vehicle structures.
    pub fn vehicle() -> Self { Self { contact_length: true, ..Self::default() } }
}

fn dist(a: [f32; 3], b: [f32; 3]) -> f32 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt() }

/// The stiffness weight append_bonds gives a bond (before normalisation),
/// with the bridge's contact length when `contact_length`, and without its
/// floors when `true_stiffness`.
pub fn stiffness_weight(nodes: &[LintNode], b: &LintBond, contact_length: bool, true_stiffness: bool) -> f32 {
    let centres = dist(nodes[b.a].position, nodes[b.b].position);
    let area = if true_stiffness { b.area } else { b.area.max(SOLVER_MIN_BOND_AREA_M2) };
    let length = if contact_length { centres.max(area.sqrt()) } else { centres };
    let length = if true_stiffness { length } else { length.max(MIN_WEIGHT_LENGTH_M) };
    let modulus = if b.modulus > 0. { b.modulus / REFERENCE_MODULUS_PA } else { 1. };
    (modulus * area / length).sqrt()
}

/// Bonds whose removal disconnects the graph (Tarjan), by bond index.
fn bridges(n: usize, bonds: &[LintBond]) -> Vec<usize> {
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n];
    for (i, b) in bonds.iter().enumerate() { adj[b.a].push((b.b, i)); adj[b.b].push((b.a, i)); }
    let (mut disc, mut low) = (vec![usize::MAX; n], vec![0usize; n]);
    let mut out = Vec::new();
    let mut time = 0;
    for root in 0..n {
        if disc[root] != usize::MAX { continue; }
        // Iterative DFS: (node, parent edge, next neighbour index).
        let mut stack = vec![(root, usize::MAX, 0usize)];
        disc[root] = time; low[root] = time; time += 1;
        while let Some(&mut (v, parent_edge, ref mut next)) = stack.last_mut() {
            if *next < adj[v].len() {
                let (w, edge) = adj[v][*next];
                *next += 1;
                if edge == parent_edge { continue; }
                if disc[w] == usize::MAX {
                    disc[w] = time; low[w] = time; time += 1;
                    stack.push((w, edge, 0));
                } else { low[v] = low[v].min(disc[w]); }
            } else {
                stack.pop();
                if let Some(&(u, _, _)) = stack.last() {
                    low[u] = low[u].min(low[v]);
                    if low[v] > disc[u] { out.push(parent_edge); }
                }
            }
        }
    }
    out
}

fn components(n: usize, bonds: &[LintBond], skip: Option<usize>) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize { while p[x] != x { p[x] = p[p[x]]; x = p[x]; } x }
    for (i, b) in bonds.iter().enumerate() {
        if Some(i) == skip { continue; }
        let (ra, rb) = (find(&mut parent, b.a), find(&mut parent, b.b));
        if ra != rb { parent[ra] = rb; }
    }
    (0..n).map(|x| find(&mut parent, x)).collect()
}

pub fn lint(nodes: &[LintNode], bonds: &[LintBond], options: &LintOptions) -> LintReport {
    let n = nodes.len();
    let mut findings = Vec::new();
    let mut stats = LintStats { nodes: n, bonds: bonds.len(), ..Default::default() };
    stats.anchored = nodes.iter().filter(|x| x.mass == 0.).count();
    stats.mass_kg = nodes.iter().map(|x| x.mass as f64).sum();
    let name = |i: usize| nodes[i].label.as_str();
    let bond_name = |b: &LintBond| format!("{} - {}", name(b.a), name(b.b));

    // 1. Interface areas against the solver's stiffness floor.
    let mut areas: Vec<f32> = bonds.iter().map(|b| b.area).collect();
    areas.sort_by(f32::total_cmp);
    if !areas.is_empty() {
        let q = |p: f32| areas[((areas.len() - 1) as f32 * p) as usize];
        stats.area_quantiles_m2 = [q(0.), q(0.1), q(0.5), q(0.9), q(1.)];
    }
    let slivers: Vec<&LintBond> = bonds.iter().filter(|b| b.area < SOLVER_MIN_BOND_AREA_M2).collect();
    if !slivers.is_empty() && options.true_stiffness {
        findings.push(Finding { check: "sliver-bonds", severity: Severity::Info,
            summary: format!("{} bond(s) under {SOLVER_MIN_BOND_AREA_M2:e} m², each stiffened and checked at its true area", slivers.len()),
            basis: "VIBE_BOND_TRUE_STIFFNESS: k = E A / L with no floor, so a sliver carries only its own share (physx-bridge tests/fidelity_audit.rs bond_stiffness_floors)",
            examples: slivers.iter().take(8).map(|b| format!("{} ({:.1e} m²)", bond_name(b), b.area)).collect() });
    } else if !slivers.is_empty() {
        findings.push(Finding { check: "sliver-bonds", severity: Severity::Blocker,
            summary: format!("{} bond(s) below the solver's {SOLVER_MIN_BOND_AREA_M2:e} m² stiffness floor", slivers.len()),
            basis: "append_bonds stiffens a bond at max(area, 1e-4) but checks strength at its true area: a sliver draws load it cannot carry (2026-09-26, 7-8% of vehicle bonds; removing them let trophy and monster drive with zero breaks)",
            examples: slivers.iter().take(8).map(|b| format!("{} ({:.1e} m²)", bond_name(b), b.area)).collect() });
    }

    // 2. Stiffness spread (what the solver's weights make of modulus, area, length).
    let weights: Vec<f32> = bonds.iter().map(|b| stiffness_weight(nodes, b, options.contact_length, options.true_stiffness)).collect();
    if let (Some(lo), Some(hi)) = (weights.iter().cloned().reduce(f32::min), weights.iter().cloned().reduce(f32::max)) {
        stats.stiffness_spread = (hi / lo).powi(2);
    }

    // 3. Mass data: zero/unrealizable inertia, and contrast across one bond.
    let bad_inertia: Vec<String> = nodes.iter().filter_map(|x| x.principal_inertia.and_then(|m| {
        let bad = m.iter().any(|v| !(*v > 0.)) || 2. * m.iter().cloned().fold(0., f32::max) > m.iter().sum::<f32>() * (1. + 1e-4);
        bad.then(|| format!("{} {:?}", x.label, m))
    })).collect();
    if !bad_inertia.is_empty() {
        findings.push(Finding { check: "unrealizable-inertia", severity: Severity::Blocker, summary: format!("{} chunk(s) with a non-positive or unrealizable inertia", bad_inertia.len()),
            basis: "principal moments must be positive and satisfy the triangle inequality", examples: bad_inertia });
    }
    let mut ratios: Vec<(f32, &LintBond)> = bonds.iter().filter(|b| nodes[b.a].mass > 0. && nodes[b.b].mass > 0.)
        .map(|b| (nodes[b.a].mass.max(nodes[b.b].mass) / nodes[b.a].mass.min(nodes[b.b].mass), b)).collect();
    ratios.sort_by(|x, y| y.0.total_cmp(&x.0));
    stats.max_mass_ratio_across_bond = ratios.first().map_or(1., |r| r.0);
    let heavy: Vec<String> = ratios.iter().filter(|r| r.0 > options.mass_ratio_warning).take(8)
        .map(|(r, b)| format!("{:.0}:1 {} ({:.2} kg) - {} ({:.2} kg)", r, name(b.a), nodes[b.a].mass, name(b.b), nodes[b.b].mass)).collect();
    if !heavy.is_empty() {
        findings.push(Finding { check: "mass-contrast", severity: Severity::Warning,
            summary: format!("{} bond(s) join chunks whose masses differ by more than {:.0}:1", ratios.iter().filter(|r| r.0 > options.mass_ratio_warning).count(), options.mass_ratio_warning),
            basis: "a light chunk on a heavy one conditions the stress system badly; merge the light chunk into its neighbour or give it realistic mass", examples: heavy });
    }

    // 4. Connectivity: every chunk must reach the structure (and an anchor, when anchored).
    let comp = components(n, bonds, None);
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, c) in comp.iter().enumerate() { groups.entry(*c).or_default().push(i); }
    stats.components = groups.len();
    if stats.anchored > 0 {
        let floating: Vec<String> = groups.values().filter(|g| g.iter().all(|&i| nodes[i].mass > 0.))
            .map(|g| format!("{} chunk(s) incl. {}", g.len(), name(g[0]))).collect();
        if !floating.is_empty() {
            findings.push(Finding { check: "floating-component", severity: Severity::Blocker, summary: format!("{} component(s) reach no anchor", floating.len()),
                basis: "an anchored structure's free-floating part has no support to push against", examples: floating });
        }
    } else if groups.len() > 1 {
        findings.push(Finding { check: "disconnected", severity: Severity::Blocker, summary: format!("{} separate components in one free structure", groups.len()),
            basis: "one rigid body must be one connected bond graph", examples: groups.values().map(|g| format!("{} chunk(s) incl. {}", g.len(), name(g[0]))).collect() });
    }

    // 5. Sole attachments: how many g of what hangs from each can it carry?
    let sole = bridges(n, bonds);
    stats.sole_attachments = sole.len();
    let mut ratings: Vec<(f32, String)> = Vec::new();
    for &i in &sole {
        let b = &bonds[i];
        let split = components(n, bonds, Some(i));
        let side = |root: usize| -> (f64, bool) {
            let r = split[root];
            let mut m = 0f64; let mut anchored = false;
            for (j, c) in split.iter().enumerate() { if *c == r { m += nodes[j].mass as f64; anchored |= nodes[j].mass == 0.; } }
            (m, anchored)
        };
        let ((ma, aa), (mb, ab)) = (side(b.a), side(b.b));
        // What hangs: the unanchored side, or the lighter one in a free structure.
        let (hanging, from) = if aa && !ab { (mb, b.b) } else if ab && !aa { (ma, b.a) } else if ma <= mb { (ma, b.a) } else { (mb, b.b) };
        if hanging <= 0. { continue; }
        let capacity = b.area * b.tension_fatal.min(b.shear_fatal);
        let g = capacity / (hanging as f32 * G);
        ratings.push((g, format!("{:.0} g: {} ({:.1} kg) hangs by {} ({:.1e} m², {:.0} kN)", g, name(from), hanging, bond_name(b), b.area, capacity / 1000.)));
    }
    ratings.sort_by(|a, b| a.0.total_cmp(&b.0));
    stats.weakest_sole_attachment_g = ratings.first().map_or(f32::INFINITY, |r| r.0);
    let weak: Vec<String> = ratings.iter().filter(|r| r.0 < options.sole_attachment_g_warning).map(|r| r.1.clone()).collect();
    if !weak.is_empty() {
        findings.push(Finding { check: "weak-sole-attachment", severity: Severity::Warning,
            summary: format!("{} part(s) hang by a single interface that fails under {:.0} g of their own weight", weak.len(), options.sole_attachment_g_warning),
            basis: "a sole attachment carries everything that hangs from it; driving and landings reach 5-50 g (vehicle lab, 2026-09-30)", examples: weak });
    }
    if let Some(r) = ratings.first() {
        findings.push(Finding { check: "sole-attachment-margin", severity: Severity::Info, summary: format!("weakest sole attachment: {}", r.1),
            basis: "fatal strength x area over the weight of what hangs from it", examples: ratings.iter().take(5).map(|r| r.1.clone()).collect() });
    }

    // 6. Bonds across motion groups: contacts that are not attachments.
    let moving: Vec<String> = bonds.iter().filter(|b| nodes[b.a].group != nodes[b.b].group)
        .map(|b| format!("{} [{}] - {} [{}]", name(b.a), nodes[b.a].group.as_deref().unwrap_or("body"), name(b.b), nodes[b.b].group.as_deref().unwrap_or("body"))).collect();
    if !moving.is_empty() {
        findings.push(Finding { check: "bond-across-moving-joint", severity: Severity::Warning,
            summary: format!("{} bond(s) join parts that move relative to each other", moving.len()),
            basis: "a rigid bond across a hinge or slider is loaded by the motion the rig imposes, not by the structure (stress-convergence checklist 4)", examples: moving.into_iter().take(8).collect() });
    }

    LintReport { stats, findings }
}

/// A city structure as the lint sees it: chunks labelled `<structure>#<node>`,
/// support chunks anchored, bonds with their material's limits.
pub fn building_inputs(structure: &crate::manifest::StructureManifest, materials: &[vibe_netcode::destruction_backend::StressMaterial]) -> (Vec<LintNode>, Vec<LintBond>) {
    let index: std::collections::HashMap<u32, usize> = structure.chunks.iter().enumerate().map(|(i, c)| (c.node_index, i)).collect();
    let nodes = structure.chunks.iter().map(|c| LintNode {
        label: format!("{}#{}", structure.structure_id, c.node_index), position: c.centroid,
        mass: if c.support { 0. } else { c.mass }, principal_inertia: None, group: None,
    }).collect();
    let bonds = structure.bonds.iter().map(|b| {
        let m = &materials[b.material as usize];
        LintBond { a: index[&b.node0], b: index[&b.node1], area: b.area, centroid: b.centroid, modulus: m.elastic_modulus_pa,
            tension_fatal: m.tension_fatal_mpa * 1e6, compression_fatal: m.compression_fatal_mpa * 1e6, shear_fatal: m.shear_fatal_mpa * 1e6 }
    }).collect();
    (nodes, bonds)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(label: &str, x: f32, mass: f32) -> LintNode { LintNode { label: label.into(), position: [x, 0., 0.], mass, principal_inertia: None, group: None } }
    fn bond(a: usize, b: usize, area: f32) -> LintBond {
        LintBond { a, b, area, centroid: [0.; 3], modulus: 200e9, tension_fatal: 300e6, compression_fatal: 300e6, shear_fatal: 174e6 }
    }

    #[test]
    fn finds_slivers_bridges_and_floating_parts() {
        let nodes = vec![node("ground", 0., 0.), node("post", 1., 100.), node("sign", 2., 50.), node("loose", 5., 1.)];
        let bonds = vec![bond(0, 1, 0.01), bond(1, 2, 1e-6)];
        let r = lint(&nodes, &bonds, &LintOptions { true_stiffness: false, ..LintOptions::default() });
        let checks: Vec<&str> = r.findings.iter().map(|f| f.check).collect();
        assert!(checks.contains(&"sliver-bonds"), "{checks:?}");
        assert!(checks.contains(&"floating-component"), "{checks:?}");
        assert_eq!(r.stats.sole_attachments, 2);
        // The sign (50 kg) on a 1e-6 m² bond: 174 N / (50 kg * g) < 1 g.
        assert!(r.stats.weakest_sole_attachment_g < 1., "{}", r.stats.weakest_sole_attachment_g);
    }

    /// Under the bridge's true stiffness a sliver is stiffened at its own
    /// area, so it draws only its share: reported, not a blocker, and its
    /// weight is the unfloored sqrt(E/E_ref A / L).
    #[test]
    fn a_sliver_is_not_a_blocker_under_true_stiffness() {
        let nodes = vec![node("ground", 0., 0.), node("post", 1., 100.), node("sign", 1.02, 50.)];
        let bonds = vec![bond(0, 1, 0.01), bond(1, 2, 1e-6)];
        let floored = lint(&nodes, &bonds, &LintOptions { true_stiffness: false, ..LintOptions::default() });
        let exact = lint(&nodes, &bonds, &LintOptions { true_stiffness: true, ..LintOptions::default() });
        let sev = |r: &LintReport| r.findings.iter().find(|f| f.check == "sliver-bonds").map(|f| f.severity);
        assert_eq!(sev(&floored), Some(Severity::Blocker));
        assert_eq!(sev(&exact), Some(Severity::Info));
        let w = stiffness_weight(&nodes, &bonds[1], false, true);
        let want = (200e9f32 / 30e9 * 1e-6 / 0.02).sqrt();
        assert!((w - want).abs() < 1e-6 * want, "{w} vs {want}");
        // Floored: area 1e-4 and length 0.05, sqrt(100 * 0.4) = 6.32x stiffer.
        let ratio = stiffness_weight(&nodes, &bonds[1], false, false) / w;
        assert!((ratio - 40f32.sqrt()).abs() < 1e-3, "{ratio}");
    }

    #[test]
    fn a_ring_has_no_sole_attachment() {
        let nodes = vec![node("a", 0., 1.), node("b", 1., 1.), node("c", 2., 1.)];
        let bonds = vec![bond(0, 1, 0.01), bond(1, 2, 0.01), bond(2, 0, 0.01)];
        let r = lint(&nodes, &bonds, &LintOptions::default());
        assert_eq!(r.stats.sole_attachments, 0);
        assert_eq!(r.stats.components, 1);
    }
}
