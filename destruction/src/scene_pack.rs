//! ScenePack v1 parser — the JSON building-asset format produced by the
//! blast-stress-solver exporters (fractured-tower.json et al).
//!
//! Schema mirrored from
//! /root/workspace/blast-stress-solver/blast/blast-stress-demo-rs/src/scene_pack.rs
//! (2026-08-10), trimmed to what scene assembly and the manifest need: nodes,
//! bonds, per-node visual sizes, per-node colliders, and solver stress limits.
//! `nodeMeshes` and camera/projectile defaults are intentionally not parsed.

use glam::Vec3;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StressLimits {
    pub compression_elastic: f32,
    pub compression_fatal: f32,
    pub tension_elastic: f32,
    pub tension_fatal: f32,
    pub shear_elastic: f32,
    pub shear_fatal: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct SceneNode {
    pub centroid: Vec3,
    pub mass: f32,
    pub volume: f32,
}

impl SceneNode {
    /// A node with zero mass anchors the structure to world support.
    pub fn is_support(&self) -> bool {
        self.mass == 0.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SceneBond {
    pub node0: u32,
    pub node1: u32,
    pub centroid: Vec3,
    pub normal: Vec3,
    pub area: f32,
}

#[derive(Clone, Debug)]
pub enum SceneCollider {
    Cuboid { half_extents: Vec3 },
    ConvexHull { points: Vec<f32> },
}

#[derive(Clone, Debug)]
pub struct ScenePack {
    pub title: String,
    pub stress_limits: Option<StressLimits>,
    pub nodes: Vec<SceneNode>,
    pub bonds: Vec<SceneBond>,
    /// Visual box size per node (full extents), used for rendering.
    pub node_sizes: Vec<Vec3>,
    pub node_colliders: Vec<SceneCollider>,
}

impl ScenePack {
    pub fn support_node_count(&self) -> usize {
        self.nodes.iter().filter(|node| node.is_support()).count()
    }
}

#[derive(Debug)]
pub enum ScenePackError {
    Json(String),
    UnsupportedVersion(u32),
    CountMismatch(String),
    Invalid(String),
}

impl std::fmt::Display for ScenePackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(message) => write!(f, "invalid scene pack JSON: {message}"),
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported scene pack version {version}")
            }
            Self::CountMismatch(message) | Self::Invalid(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ScenePackError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenePackJson {
    version: u32,
    title: String,
    #[serde(default)]
    defaults: Option<SceneDefaultsJson>,
    scenario: ScenarioJson,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDefaultsJson {
    #[serde(default)]
    solver: Option<SolverDefaultsJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolverDefaultsJson {
    #[serde(default)]
    limits: Option<LimitsJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsJson {
    compression_elastic: f32,
    compression_fatal: f32,
    tension_elastic: f32,
    tension_fatal: f32,
    shear_elastic: f32,
    shear_fatal: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioJson {
    nodes: Vec<ScenarioNodeJson>,
    bonds: Vec<ScenarioBondJson>,
    node_sizes: Vec<Vec3Json>,
    node_colliders: Vec<NodeColliderJson>,
}

#[derive(Deserialize)]
struct ScenarioNodeJson {
    centroid: Vec3Json,
    mass: f32,
    volume: f32,
}

#[derive(Deserialize)]
struct ScenarioBondJson {
    node0: u32,
    node1: u32,
    centroid: Vec3Json,
    normal: Vec3Json,
    area: f32,
}

#[derive(Clone, Copy, Deserialize)]
struct Vec3Json {
    x: f32,
    y: f32,
    z: f32,
}

impl From<Vec3Json> for Vec3 {
    fn from(value: Vec3Json) -> Self {
        Vec3::new(value.x, value.y, value.z)
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum NodeColliderJson {
    Cuboid {
        #[serde(rename = "halfExtents")]
        half_extents: Vec3Json,
    },
    ConvexHull {
        points: Vec<f32>,
    },
}

pub fn parse_scene_pack(payload: &str) -> Result<ScenePack, ScenePackError> {
    let pack: ScenePackJson =
        serde_json::from_str(payload).map_err(|error| ScenePackError::Json(error.to_string()))?;
    if pack.version != 1 {
        return Err(ScenePackError::UnsupportedVersion(pack.version));
    }
    let scenario = pack.scenario;
    if scenario.nodes.len() != scenario.node_sizes.len() {
        return Err(ScenePackError::CountMismatch(format!(
            "scene pack node/size count mismatch: {} nodes vs {} sizes",
            scenario.nodes.len(),
            scenario.node_sizes.len()
        )));
    }
    if scenario.nodes.len() != scenario.node_colliders.len() {
        return Err(ScenePackError::CountMismatch(format!(
            "scene pack node/collider count mismatch: {} nodes vs {} colliders",
            scenario.nodes.len(),
            scenario.node_colliders.len()
        )));
    }
    let node_count = scenario.nodes.len() as u32;
    for bond in &scenario.bonds {
        if bond.node0 >= node_count || bond.node1 >= node_count {
            return Err(ScenePackError::Invalid(format!(
                "bond references node out of range: {} - {} (nodes {})",
                bond.node0, bond.node1, node_count
            )));
        }
    }

    Ok(ScenePack {
        title: pack.title,
        stress_limits: pack
            .defaults
            .and_then(|defaults| defaults.solver)
            .and_then(|solver| solver.limits)
            .map(|limits| StressLimits {
                compression_elastic: limits.compression_elastic,
                compression_fatal: limits.compression_fatal,
                tension_elastic: limits.tension_elastic,
                tension_fatal: limits.tension_fatal,
                shear_elastic: limits.shear_elastic,
                shear_fatal: limits.shear_fatal,
            }),
        nodes: scenario
            .nodes
            .into_iter()
            .map(|node| SceneNode {
                centroid: node.centroid.into(),
                mass: node.mass,
                volume: node.volume,
            })
            .collect(),
        bonds: scenario
            .bonds
            .into_iter()
            .map(|bond| SceneBond {
                node0: bond.node0,
                node1: bond.node1,
                centroid: bond.centroid.into(),
                normal: bond.normal.into(),
                area: bond.area,
            })
            .collect(),
        node_sizes: scenario.node_sizes.into_iter().map(Into::into).collect(),
        node_colliders: scenario
            .node_colliders
            .into_iter()
            .map(|collider| match collider {
                NodeColliderJson::Cuboid { half_extents } => SceneCollider::Cuboid {
                    half_extents: half_extents.into(),
                },
                NodeColliderJson::ConvexHull { points } => SceneCollider::ConvexHull { points },
            })
            .collect(),
    })
}

pub fn load_scene_pack_file(path: &std::path::Path) -> Result<ScenePack, ScenePackError> {
    let payload = std::fs::read_to_string(path).map_err(|error| {
        ScenePackError::Invalid(format!("could not read scene pack {}: {error}", path.display()))
    })?;
    parse_scene_pack(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
        "version": 1,
        "title": "test",
        "defaults": {
            "solver": {
                "limits": {
                    "compressionElastic": 1.0, "compressionFatal": 2.0,
                    "tensionElastic": 3.0, "tensionFatal": 4.0,
                    "shearElastic": 5.0, "shearFatal": 6.0
                }
            }
        },
        "scenario": {
            "nodes": [
                {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1}
            ],
            "bonds": [
                {"node0": 0, "node1": 1,
                 "centroid": {"x": 0, "y": 0.5, "z": 0},
                 "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
            ],
            "nodeSizes": [
                {"x": 1, "y": 1, "z": 1},
                {"x": 1, "y": 1, "z": 1}
            ],
            "nodeColliders": [
                {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                {"kind": "convex_hull", "points": [0,0,0, 1,0,0, 0,1,0, 0,0,1]}
            ]
        }
    }"#;

    #[test]
    fn parses_minimal_pack() {
        let pack = parse_scene_pack(MINIMAL).expect("parse");
        assert_eq!(pack.title, "test");
        assert_eq!(pack.nodes.len(), 2);
        assert_eq!(pack.bonds.len(), 1);
        assert_eq!(pack.support_node_count(), 1);
        let limits = pack.stress_limits.expect("limits");
        assert_eq!(limits.compression_fatal, 2.0);
        assert!(matches!(
            pack.node_colliders[1],
            SceneCollider::ConvexHull { .. }
        ));
    }

    #[test]
    fn rejects_wrong_version() {
        let payload = MINIMAL.replacen("\"version\": 1", "\"version\": 9", 1);
        assert!(matches!(
            parse_scene_pack(&payload),
            Err(ScenePackError::UnsupportedVersion(9))
        ));
    }

    #[test]
    fn rejects_out_of_range_bond() {
        let payload = MINIMAL.replacen("\"node1\": 1", "\"node1\": 7", 1);
        assert!(matches!(
            parse_scene_pack(&payload),
            Err(ScenePackError::Invalid(_))
        ));
    }
}
