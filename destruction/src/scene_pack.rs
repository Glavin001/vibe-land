//! ScenePack v1/v2 parser — the JSON building-asset format produced by the
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
    /// Index into `ScenePack::materials`, from `nodes[].m`.
    ///
    /// v2 assigns material per BOND, which is right for the solver: a joint has
    /// a strength and a bond is a joint. It leaves a renderer with nothing,
    /// because a chunk then has no material of its own and cannot be shaded by
    /// what it is made of. This is the field v3 already defines for picking
    /// crush properties, read here for the same per-chunk purpose. Omitted
    /// means 0, which is what every existing pack means.
    pub material: u32,
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
    /// Real contact patch (m^2). Geometry only -- strength is authored through
    /// `material`, never by scaling area.
    pub area: f32,
    /// Index into `ScenePack::materials`. v1 packs have a single material, so
    /// every bond is 0.
    pub material: u32,
}

#[derive(Clone, Debug)]
pub enum SceneCollider {
    Cuboid { half_extents: Vec3 },
    ConvexHull {
        points: Vec<f32>,
        /// Which entry of the pack's shape library this shard is, when the
        /// fracturer bounded its pattern count and said so.
        ///
        /// Authored identity, not a hash. The fracturer knows it is stamping
        /// cell `c` of pattern `k` onto a panel of a given class, so it can
        /// name the shape before it writes a vertex -- and a consumer can
        /// instance every shard that shares a name without comparing any
        /// geometry. `None` for packs whose shards are all one-of-a-kind, where
        /// there is nothing to share and nothing to name.
        shape_id: Option<u32>,
    },
}

#[derive(Clone, Debug)]
pub struct ScenePack {
    pub title: String,
    /// Source format version. v2 authors a material table; v1 has one global
    /// set of limits, which is normalised into a one-entry table below.
    pub version: u32,
    pub stress_limits: Option<StressLimits>,
    /// Always non-empty after parsing. A structure mixes strengths -- a facade
    /// clip is meant to shed long before the frame does -- and that difference
    /// is authored here rather than by distorting bond areas.
    pub materials: Vec<StressLimits>,
    /// Parallel to `materials`. Empty for a pack that authored no appearance.
    pub appearances: Vec<MaterialAppearance>,
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
    #[serde(default)]
    materials: Option<Vec<LimitsJson>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsJson {
    /// v2 material tables label their entries. Parsed so an unknown field
    /// cannot fail the load; vibe-land has no report surface that needs it.
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
    /// Appearance, all optional and all ignored by the solver.
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    opacity: Option<f32>,
    #[serde(default)]
    texture_key: Option<String>,
    #[serde(default)]
    roughness: Option<f32>,
    #[serde(default)]
    metalness: Option<f32>,
    compression_elastic: f32,
    compression_fatal: f32,
    tension_elastic: f32,
    tension_fatal: f32,
    shear_elastic: f32,
    shear_fatal: f32,
}

/// How a material LOOKS. Advisory: no solver reads any of it.
///
/// Strength and appearance are kept apart deliberately -- `StressLimits` stays
/// `Copy` and six floats wide, which is what the solver wants, while this rides
/// alongside for the renderer. A pack without these fields is no less valid.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MaterialAppearance {
    pub name: Option<String>,
    pub color: Option<String>,
    /// Presence of this is what marks a material transparent.
    pub opacity: Option<f32>,
    pub texture_key: Option<String>,
    pub roughness: Option<f32>,
    pub metalness: Option<f32>,
}

impl MaterialAppearance {
    /// True when nothing was authored, so the manifest can skip emitting it and
    /// keep hashing exactly as it did before this existed.
    pub fn is_empty(&self) -> bool {
        self.color.is_none()
            && self.opacity.is_none()
            && self.texture_key.is_none()
            && self.roughness.is_none()
            && self.metalness.is_none()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioJson {
    nodes: Vec<ScenarioNodeJson>,
    bonds: Vec<ScenarioBondJson>,
    node_sizes: Vec<Vec3Json>,
    node_colliders: Vec<NodeColliderJson>,
    /// Distinct shard shapes, stored once. Absent on packs exported without a
    /// bounded pattern count, where every shard carries its own points.
    #[serde(default)]
    shape_library: Vec<NodeColliderJson>,
}

#[derive(Deserialize)]
struct ScenarioNodeJson {
    centroid: Vec3Json,
    mass: f32,
    volume: f32,
    /// The node's own material index. Omitted means 0.
    #[serde(default, rename = "m")]
    m: u32,
}

#[derive(Deserialize)]
struct ScenarioBondJson {
    node0: u32,
    node1: u32,
    centroid: Vec3Json,
    normal: Vec3Json,
    area: f32,
    /// Material index. Omitted means 0, which is what every v1 bond uses.
    #[serde(default, rename = "m")]
    m: u32,
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
    /// A reference into `shapeLibrary`. Resolved at parse time so nothing
    /// downstream has to know the difference.
    Shape {
        shape: u32,
    },
}

/// Limits used when a v1 pack authors none. Matches the server-side fallback.
const PLACEHOLDER_LIMITS: StressLimits = StressLimits {
    compression_elastic: 12.0e6,
    compression_fatal: 30.0e6,
    tension_elastic: 1.2e6,
    tension_fatal: 3.0e6,
    shear_elastic: 1.6e6,
    shear_fatal: 4.0e6,
};

fn limits_from(limits: &LimitsJson) -> StressLimits {
    StressLimits {
        compression_elastic: limits.compression_elastic,
        compression_fatal: limits.compression_fatal,
        tension_elastic: limits.tension_elastic,
        tension_fatal: limits.tension_fatal,
        shear_elastic: limits.shear_elastic,
        shear_fatal: limits.shear_fatal,
    }
}

/// A negative tension or shear limit means "same as compression". Resolved
/// once, here, so every consumer downstream sees real numbers -- a sentinel
/// that reached a log or an assertion would read as a nonsensical strength.
fn appearance_from(json: &LimitsJson) -> MaterialAppearance {
    MaterialAppearance {
        name: json.name.clone(),
        color: json.color.clone(),
        opacity: json.opacity,
        texture_key: json.texture_key.clone(),
        roughness: json.roughness,
        metalness: json.metalness,
    }
}

fn resolve_inherited(limits: &StressLimits) -> StressLimits {
    let inherit = |value: f32, fallback: f32| if value < 0.0 { fallback } else { value };
    StressLimits {
        compression_elastic: limits.compression_elastic,
        compression_fatal: limits.compression_fatal,
        tension_elastic: inherit(limits.tension_elastic, limits.compression_elastic),
        tension_fatal: inherit(limits.tension_fatal, limits.compression_fatal),
        shear_elastic: inherit(limits.shear_elastic, limits.compression_elastic),
        shear_fatal: inherit(limits.shear_fatal, limits.compression_fatal),
    }
}

fn validate_material(index: usize, limits: &StressLimits) -> Result<(), ScenePackError> {
    if limits.compression_elastic < 0.0 {
        return Err(ScenePackError::Invalid(format!(
            "material {index} has a negative compression limit; only tension and shear may \
             inherit from compression"
        )));
    }
    // Fatal below elastic would mean a bond breaks before it yields, which is
    // not a weaker material -- it is an incoherent one.
    if limits.compression_fatal < limits.compression_elastic {
        return Err(ScenePackError::Invalid(format!(
            "material {index} has compressionFatal below compressionElastic"
        )));
    }
    Ok(())
}

pub fn parse_scene_pack(payload: &str) -> Result<ScenePack, ScenePackError> {
    let pack: ScenePackJson =
        serde_json::from_str(payload).map_err(|error| ScenePackError::Json(error.to_string()))?;
    if pack.version != 1 && pack.version != 2 {
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
    // Flatten the library once. A dangling reference has to fail here rather
    // than downstream, where the only symptom would be a chunk drawn as some
    // other chunk's shape.
    let mut library_points: Vec<Vec<f32>> = Vec::with_capacity(scenario.shape_library.len());
    for (index, entry) in scenario.shape_library.iter().enumerate() {
        match entry {
            NodeColliderJson::ConvexHull { points } => library_points.push(points.clone()),
            _ => {
                return Err(ScenePackError::Invalid(format!(
                    "shape library entry {index} is not a convex hull"
                )))
            }
        }
    }
    for (index, collider) in scenario.node_colliders.iter().enumerate() {
        if let NodeColliderJson::Shape { shape } = collider {
            if *shape as usize >= library_points.len() {
                return Err(ScenePackError::Invalid(format!(
                    "node {index} references shape {shape}, library has {}",
                    library_points.len()
                )));
            }
        }
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

    let solver = pack.defaults.and_then(|defaults| defaults.solver);
    let authored_limits = solver.as_ref().and_then(|solver| solver.limits.as_ref()).map(limits_from);
    let materials = match pack.version {
        2 => {
            // The table is the whole point of v2: without it a pack that was
            // authored with a weak facade and a strong frame would silently
            // load with one uniform strength.
            let table = solver
                .as_ref()
                .and_then(|solver| solver.materials.as_ref())
                .ok_or_else(|| {
                    ScenePackError::Invalid(
                        "scene pack v2 requires defaults.solver.materials".to_string(),
                    )
                })?;
            if table.is_empty() {
                return Err(ScenePackError::Invalid(
                    "scene pack v2 requires at least one solver material".to_string(),
                ));
            }
            table.iter().map(limits_from).collect::<Vec<_>>()
        }
        // v1 has one global set of limits. Normalising it into a one-entry
        // table means everything downstream sees a single shape.
        _ => vec![authored_limits.unwrap_or(PLACEHOLDER_LIMITS)],
    };
    for (index, material) in materials.iter().enumerate() {
        validate_material(index, material)?;
    }
    let materials: Vec<StressLimits> = materials.iter().map(resolve_inherited).collect();
    let appearances: Vec<MaterialAppearance> = match (pack.version, solver.as_ref()) {
        (2, Some(solver)) => solver
            .materials
            .as_ref()
            .map(|table| table.iter().map(appearance_from).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    // A node's material index has to exist for the same reason a bond's does.
    // v1 packs have no table to index, so any stray value there is not
    // meaningful and is flattened rather than rejected.
    let nodes_material_max = if pack.version >= 2 { materials.len() } else { 1 };
    for (index, node) in scenario.nodes.iter().enumerate() {
        let m = if pack.version >= 2 { node.m } else { 0 };
        if m as usize >= nodes_material_max {
            return Err(ScenePackError::Invalid(format!(
                "node {index} references material {m}, table has {}",
                materials.len()
            )));
        }
    }

    let bonds: Vec<SceneBond> = scenario
        .bonds
        .iter()
        .enumerate()
        .map(|(index, bond)| {
            // v1 packs have no material table, so any stray index is not
            // meaningful; v2 indices must actually exist.
            let material = if pack.version >= 2 { bond.m } else { 0 };
            if material as usize >= materials.len() {
                return Err(ScenePackError::Invalid(format!(
                    "bond {index} references material {material} but the pack has {} materials",
                    materials.len()
                )));
            }
            Ok(SceneBond {
                node0: bond.node0,
                node1: bond.node1,
                centroid: bond.centroid.into(),
                normal: bond.normal.into(),
                area: bond.area,
                material,
            })
        })
        .collect::<Result<_, _>>()?;

    Ok(ScenePack {
        title: pack.title,
        version: pack.version,
        // v2 authors its limits in the table; keep field one exposed here so
        // callers that only want "the" limits still get a sensible answer.
        stress_limits: if pack.version >= 2 {
            materials.first().copied()
        } else {
            authored_limits.map(|limits| resolve_inherited(&limits))
        },
        materials,
        appearances,
        nodes: scenario
            .nodes
            .into_iter()
            .map(|node| SceneNode {
                centroid: node.centroid.into(),
                mass: node.mass,
                volume: node.volume,
                material: if pack.version >= 2 { node.m } else { 0 },
            })
            .collect(),
        bonds,
        node_sizes: scenario.node_sizes.into_iter().map(Into::into).collect(),
        node_colliders: scenario
            .node_colliders
            .into_iter()
            .map(|collider| match collider {
                NodeColliderJson::Cuboid { half_extents } => SceneCollider::Cuboid {
                    half_extents: half_extents.into(),
                },
                NodeColliderJson::ConvexHull { points } => SceneCollider::ConvexHull {
                    points,
                    shape_id: None,
                },
                // Resolved, but the id is KEPT: the points alone would force a
                // consumer back into comparing geometry to rediscover what the
                // pack already stated.
                NodeColliderJson::Shape { shape } => SceneCollider::ConvexHull {
                    points: library_points[shape as usize].clone(),
                    shape_id: Some(shape),
                },
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

    /// v2 of the format: a material table plus per-bond indices into it.
    const V2: &str = r#"{
        "version": 2,
        "title": "v2 test",
        "defaults": {
            "solver": {
                "materials": [
                    {"name": "frame",
                     "compressionElastic": 12.0, "compressionFatal": 30.0,
                     "tensionElastic": 1.2, "tensionFatal": 3.0,
                     "shearElastic": 1.6, "shearFatal": 4.0},
                    {"name": "facade",
                     "compressionElastic": 1.0, "compressionFatal": 2.0,
                     "tensionElastic": -1.0, "tensionFatal": -1.0,
                     "shearElastic": -1.0, "shearFatal": -1.0}
                ]
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
                 "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0, "m": 1},
                {"node0": 1, "node1": 0,
                 "centroid": {"x": 0, "y": 0.5, "z": 0},
                 "normal": {"x": 0, "y": 1, "z": 0}, "area": 2.0}
            ],
            "nodeSizes": [
                {"x": 1, "y": 1, "z": 1},
                {"x": 1, "y": 1, "z": 1}
            ],
            "nodeColliders": [
                {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
            ]
        }
    }"#;

    fn v2_with(mutate: impl Fn(&mut serde_json::Value)) -> String {
        let mut value: serde_json::Value = serde_json::from_str(V2).expect("fixture parses");
        mutate(&mut value);
        value.to_string()
    }

    #[test]
    fn parses_v2_material_table_and_bond_indices() {
        let pack = parse_scene_pack(V2).expect("parse");
        assert_eq!(pack.version, 2);
        assert_eq!(pack.materials.len(), 2);
        assert_eq!(pack.bonds[0].material, 1, "explicit m is honoured");
        assert_eq!(pack.bonds[1].material, 0, "omitted m means the first material");
    }

    /// The facade material authors -1 for tension and shear, meaning "same as
    /// compression". Resolving at parse keeps sentinels out of everything
    /// downstream, where a negative strength would be meaningless.
    #[test]
    fn v2_negative_limits_inherit_compression() {
        let pack = parse_scene_pack(V2).expect("parse");
        let facade = pack.materials[1];
        assert_eq!(facade.tension_elastic, facade.compression_elastic);
        assert_eq!(facade.shear_fatal, facade.compression_fatal);
    }

    /// v1 has no table. Normalising it to one entry means every consumer sees
    /// the same shape regardless of which version authored the pack.
    #[test]
    fn v1_synthesises_a_single_material() {
        let pack = parse_scene_pack(MINIMAL).expect("parse");
        assert_eq!(pack.version, 1);
        assert_eq!(pack.materials.len(), 1);
        assert_eq!(pack.materials[0], pack.stress_limits.expect("limits"));
        assert!(pack.bonds.iter().all(|bond| bond.material == 0));
    }

    #[test]
    fn v1_without_limits_falls_back_to_placeholder() {
        let json = v2_with(|value| {
            value["version"] = serde_json::json!(1);
            value["defaults"] = serde_json::json!({});
        });
        let pack = parse_scene_pack(&json).expect("parse");
        assert_eq!(pack.materials, vec![PLACEHOLDER_LIMITS]);
    }

    /// Without the table a v2 pack would load with one uniform strength,
    /// silently discarding the weak-facade/strong-frame split it was authored
    /// around. Better to refuse than to quietly build the wrong building.
    #[test]
    fn v2_without_materials_is_rejected() {
        let json = v2_with(|value| {
            value["defaults"]["solver"] = serde_json::json!({});
        });
        assert!(parse_scene_pack(&json).is_err());
    }

    #[test]
    fn v2_with_empty_material_table_is_rejected() {
        let json = v2_with(|value| {
            value["defaults"]["solver"]["materials"] = serde_json::json!([]);
        });
        assert!(parse_scene_pack(&json).is_err());
    }

    #[test]
    fn out_of_range_material_index_names_the_bond() {
        let json = v2_with(|value| {
            value["scenario"]["bonds"][1]["m"] = serde_json::json!(7);
        });
        let error = parse_scene_pack(&json).expect_err("should reject");
        let message = error.to_string();
        assert!(message.contains("bond 1"), "message should name the bond: {message}");
        assert!(message.contains('7'), "message should name the index: {message}");
    }

    /// A bond that breaks before it yields is not a weaker material, it is an
    /// incoherent one.
    #[test]
    fn fatal_below_elastic_is_rejected() {
        let json = v2_with(|value| {
            value["defaults"]["solver"]["materials"][0]["compressionFatal"] =
                serde_json::json!(0.5);
        });
        assert!(parse_scene_pack(&json).is_err());
    }

    #[test]
    fn unsupported_versions_are_still_rejected() {
        let json = v2_with(|value| {
            value["version"] = serde_json::json!(9);
        });
        assert!(matches!(
            parse_scene_pack(&json),
            Err(ScenePackError::UnsupportedVersion(9))
        ));
    }

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
