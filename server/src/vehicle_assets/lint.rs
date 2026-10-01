//! A prepared vehicle as the structure lint sees it (destruction::structure_lint).

use super::PreparedGeometry;
use vibe_land_destruction::structure_lint::{lint, LintBond, LintNode, LintOptions, LintReport};

/// Parts become chunks (label = part id and name, group = rig binding
/// corner.role[.component]); bonds carry their authored strength.
pub fn lint_inputs(geometry: &PreparedGeometry) -> (Vec<LintNode>, Vec<LintBond>) {
    let index: std::collections::HashMap<&str, usize> = geometry.parts.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let nodes = geometry.parts.iter().map(|p| {
        let i = p.mass_properties.inertia;
        let tensor = nalgebra::Matrix3::new(i[0][0], i[0][1], i[0][2], i[1][0], i[1][1], i[1][2], i[2][0], i[2][1], i[2][2]);
        let e = nalgebra::SymmetricEigen::new(tensor).eigenvalues;
        let group = p.motion.as_ref().map(|m| {
            let s = |k: &str| m[k].as_str().unwrap_or("").to_string();
            let mut g = format!("{}.{}", s("corner"), s("role"));
            if let Some(c) = m["component"].as_str() { g.push('.'); g.push_str(c); }
            g
        });
        let c = p.mass_properties.center;
        LintNode { label: format!("{} ({})", p.id, p.name), position: [c[0] as f32, c[1] as f32, c[2] as f32], mass: p.mass as f32,
            principal_inertia: Some([e[0] as f32, e[1] as f32, e[2] as f32]), group }
    }).collect();
    let bonds = geometry.bonds.iter().map(|b| LintBond {
        a: index[b.a.as_str()], b: index[b.b.as_str()], area: b.area as f32,
        centroid: [b.centroid[0] as f32, b.centroid[1] as f32, b.centroid[2] as f32], modulus: b.strength.elastic_modulus as f32,
        tension_fatal: b.strength.tension_fatal as f32, compression_fatal: b.strength.compression_fatal as f32, shear_fatal: b.strength.shear_fatal as f32,
    }).collect();
    (nodes, bonds)
}

pub fn lint_vehicle(geometry: &PreparedGeometry) -> LintReport {
    let (nodes, bonds) = lint_inputs(geometry);
    lint(&nodes, &bonds, &LintOptions::vehicle())
}

#[cfg(test)]
mod tests {
    /// Lint every prepared build (no GPU): VIBE_VEHICLE_BUILD_FIXTURES.
    #[test]
    #[ignore = "requires VIBE_VEHICLE_BUILD_FIXTURES"]
    fn lint_vehicle_builds() {
        let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").unwrap()).unwrap()).unwrap();
        for f in manifest.as_array().unwrap() {
            let geometry: super::PreparedGeometry = serde_json::from_slice(&std::fs::read(f["metadataPath"].as_str().unwrap()).unwrap()).unwrap();
            let report = super::lint_vehicle(&geometry);
            eprintln!("== {}: {}", f["name"].as_str().unwrap(), report.card());
        }
    }
}
