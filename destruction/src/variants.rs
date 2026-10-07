//! Building-height variants derived from one ScenePack.
//!
//! Rust port of `truncateToFloors` / `makeBuildingVariants` from
//! /root/workspace/blast-stress-solver/demos/blast-stress-demo/mini_city_main.cpp
//! (2026-08-10). Nodes above the Y cutoff are dropped and bonds are remapped —
//! the result is an actual smaller support graph, not a scaled one. Contract
//! (pinned by tests against the committed fractured-tower.json): 1/2/3-floor
//! variants have 83/148/204 nodes, 209/373/546 bonds, 36 support nodes each.

use crate::scene_pack::{SceneCollider, ScenePack};

pub const MAXIMUM_FLOORS: u32 = 3;

#[derive(Clone, Debug)]
pub struct BuildingVariant {
    pub pack: ScenePack,
    pub floors: u32,
    /// Tallest visual point (centroid.y + half of the visual size), used for
    /// spawn/collision planning and cameras.
    pub height: f32,
}

#[derive(Debug)]
pub enum VariantError {
    InvalidFloorCount { floors: u32, maximum: u32 },
    InvalidTruncation(String),
}

impl std::fmt::Display for VariantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFloorCount { floors, maximum } => {
                write!(f, "invalid building floor count {floors} (max {maximum})")
            }
            Self::InvalidTruncation(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for VariantError {}

pub fn truncate_to_floors(
    source: &ScenePack,
    floors: u32,
    maximum_floors: u32,
) -> Result<ScenePack, VariantError> {
    if floors == 0 || floors > maximum_floors || source.nodes.is_empty() {
        return Err(VariantError::InvalidFloorCount {
            floors,
            maximum: maximum_floors,
        });
    }
    let mut result = ScenePack {
        title: format!("{} {}-floor", source.title, floors),
        version: source.version,
        stress_limits: source.stress_limits,
        // Truncation drops nodes, never materials: a shorter variant is the
        // same building made of the same things, and bond material indices
        // are copied verbatim so they must keep resolving.
        materials: source.materials.clone(),
        appearances: source.appearances.clone(),
        nodes: Vec::new(),
        bonds: Vec::new(),
        node_sizes: Vec::new(),
        node_colliders: Vec::new(),
        node_types: Vec::new(),
        node_pieces: Vec::new(),
    };

    let mut minimum_y = source.nodes[0].centroid.y;
    let mut maximum_y = minimum_y;
    for node in &source.nodes {
        minimum_y = minimum_y.min(node.centroid.y);
        maximum_y = maximum_y.max(node.centroid.y);
    }
    let cutoff = if floors == maximum_floors {
        maximum_y + 1.0
    } else {
        minimum_y + (maximum_y - minimum_y) * floors as f32 / maximum_floors as f32
    };

    let mut remap = vec![u32::MAX; source.nodes.len()];
    for (node_index, node) in source.nodes.iter().enumerate() {
        if node.centroid.y <= cutoff {
            remap[node_index] = result.nodes.len() as u32;
            result.nodes.push(*node);
            result.node_sizes.push(source.node_sizes[node_index]);
            result
                .node_colliders
                .push(source.node_colliders[node_index].clone());
            // Roles are parallel to nodes, so they truncate with them or they
            // stop meaning anything. Absent stays absent.
            if let Some(role) = source.node_types.get(node_index) {
                result.node_types.push(role.clone());
            }
            if let Some(&piece) = source.node_pieces.get(node_index) {
                result.node_pieces.push(piece);
            }
        }
    }
    for bond in &source.bonds {
        let (Some(&node0), Some(&node1)) = (
            remap.get(bond.node0 as usize),
            remap.get(bond.node1 as usize),
        ) else {
            continue;
        };
        if node0 == u32::MAX || node1 == u32::MAX {
            continue;
        }
        let mut remapped = *bond;
        remapped.node0 = node0;
        remapped.node1 = node1;
        result.bonds.push(remapped);
    }

    if result.nodes.is_empty()
        || result.bonds.is_empty()
        || !result.nodes.iter().any(|node| node.is_support())
    {
        return Err(VariantError::InvalidTruncation(
            "floor truncation produced an invalid supported structure".to_string(),
        ));
    }
    Ok(result)
}

/// The 1..=MAXIMUM_FLOORS variant ladder (or just the full building when
/// `varied_heights` is false), mirroring `makeBuildingVariants`.
pub fn make_building_variants(
    source: &ScenePack,
    varied_heights: bool,
) -> Result<Vec<BuildingVariant>, VariantError> {
    let first_floor = if varied_heights { 1 } else { MAXIMUM_FLOORS };
    let mut variants = Vec::new();
    for floors in first_floor..=MAXIMUM_FLOORS {
        let pack = truncate_to_floors(source, floors, MAXIMUM_FLOORS)?;
        let mut height = 0.0_f32;
        for (node, size) in pack.nodes.iter().zip(&pack.node_sizes) {
            height = height.max(node.centroid.y + size.y * 0.5);
        }
        variants.push(BuildingVariant {
            pack,
            floors,
            height,
        });
    }
    Ok(variants)
}

/// Bounding radius of one chunk's collider around its centroid, floored the
/// same way the trace contract floors it (0.01 m).
pub fn collider_bounding_radius(collider: &SceneCollider) -> f32 {
    let radius = match collider {
        SceneCollider::Cuboid { half_extents } => half_extents.length(),
        SceneCollider::ConvexHull { points, .. } => points
            .chunks_exact(3)
            .map(|p| (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt())
            .fold(0.0_f32, f32::max),
    };
    radius.max(0.01)
}

/// Where a chunk's centre of mass sits relative to its node centroid, in the
/// structure frame: zero for a cuboid, the volume centroid of the convex hull
/// of its points for a hull.
///
/// A node's `centroid` is the ORIGIN its collider points are measured from,
/// not necessarily its centre of mass. The town kit authors sloped pieces
/// (rafters, roof tiles, gables) from an AABB corner (hull-origins.mjs), so a
/// roof tile's mass sits 0.3/0.5/1.2 m from its node centroid. PhysX takes the
/// real one -- the bridge gives each chunk `centroid + PxMassProperties(hull)
/// .centerOfMass` (native_destruction.cc) -- so every island body, and the
/// centre-of-mass frame its wire pose is expressed in, is centred there. A
/// client that weighs centroids instead draws the island displaced by the
/// mass-weighted mean of these offsets the moment it splits off: half a metre
/// up for the veneer house's roof.
///
/// Same polytope as the cooked PhysX hull (the convex hull of the same
/// points), so the same centroid to float precision. Accumulated in f64.
pub fn collider_mass_offset(collider: &SceneCollider) -> glam::Vec3 {
    match collider {
        SceneCollider::Cuboid { .. } => glam::Vec3::ZERO,
        SceneCollider::ConvexHull { points, .. } => hull_mass_offset(points),
    }
}

/// Volume centroid of the convex hull of flat xyz `points`. Zero when the
/// points span no volume (nothing for PhysX to cook, either).
pub fn hull_mass_offset(points: &[f32]) -> glam::Vec3 {
    use rapier3d::na::Point3;
    let input: Vec<Point3<f32>> = points
        .chunks_exact(3)
        .map(|p| Point3::new(p[0], p[1], p[2]))
        .collect();
    if input.len() < 4 {
        return glam::Vec3::ZERO;
    }
    let Ok((vertices, triangles)) = rapier3d::parry::transformation::try_convex_hull(&input) else {
        return glam::Vec3::ZERO;
    };
    let v = |i: u32| {
        let p = vertices[i as usize];
        [f64::from(p.x), f64::from(p.y), f64::from(p.z)]
    };
    let Some(first) = vertices.first() else {
        return glam::Vec3::ZERO;
    };
    let r = [f64::from(first.x), f64::from(first.y), f64::from(first.z)];
    let (mut volume, mut moment) = (0.0f64, [0.0f64; 3]);
    for t in &triangles {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        let (a, b, c) = (
            [a[0] - r[0], a[1] - r[1], a[2] - r[2]],
            [b[0] - r[0], b[1] - r[1], b[2] - r[2]],
            [c[0] - r[0], c[1] - r[1], c[2] - r[2]],
        );
        // Six times the signed volume of the tetrahedron (r, a, b, c).
        let six = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        volume += six;
        for k in 0..3 {
            moment[k] += six * (a[k] + b[k] + c[k]);
        }
    }
    let scale = {
        let extent = vertices
            .iter()
            .flat_map(|p| [p.x - first.x, p.y - first.y, p.z - first.z])
            .fold(0.0f32, |m, x| m.max(x.abs()));
        f64::from(extent.max(f32::MIN_POSITIVE))
    };
    if !(volume.abs() > 1.0e-9 * scale * scale * scale) {
        return glam::Vec3::ZERO;
    }
    // Tetrahedron centroid is (r + a + b + c) / 4, i.e. r + (a+b+c)/4 here.
    glam::Vec3::new(
        (r[0] + moment[0] / (4.0 * volume)) as f32,
        (r[1] + moment[1] / (4.0 * volume)) as f32,
        (r[2] + moment[2] / (4.0 * volume)) as f32,
    )
}

#[cfg(test)]
mod mass_offset_tests {
    use super::*;

    fn close(a: glam::Vec3, b: [f32; 3]) {
        assert!((a - glam::Vec3::from_array(b)).abs().max_element() < 1.0e-5, "{a:?} vs {b:?}");
    }

    #[test]
    fn a_box_measured_from_its_corner_is_centred_at_half_its_extents() {
        let points = [
            0., 0., 0., 1., 0., 0., 0., 0.1, 0., 1., 0.1, 0., 0., 0., 2., 1., 0., 2., 0., 0.1, 2., 1., 0.1, 2.,
        ];
        close(hull_mass_offset(&points), [0.5, 0.05, 1.0]);
    }

    #[test]
    fn a_centred_hull_has_no_offset_and_a_cuboid_never_does() {
        let points = [-1., -1., -1., 1., -1., -1., -1., 1., -1., 1., 1., -1., -1., -1., 1., 1., -1., 1., -1., 1., 1., 1., 1., 1.];
        close(hull_mass_offset(&points), [0.0; 3]);
        let cuboid = SceneCollider::Cuboid { half_extents: glam::Vec3::ONE };
        assert_eq!(collider_mass_offset(&cuboid), glam::Vec3::ZERO);
    }

    /// The volume centroid, not the vertex mean: a sloped roof tile (a sheared
    /// prism, like the town kit's) has more vertices at one end than its mass.
    #[test]
    fn a_tetrahedron_and_a_wedge_take_their_volume_centroids() {
        close(hull_mass_offset(&[0., 0., 0., 4., 0., 0., 0., 4., 0., 0., 0., 4.]), [1.0, 1.0, 1.0]);
        // A wedge: right triangle (0,0),(2,0),(0,3) in xy, extruded 1 in z.
        // Area centroid (2/3, 1), z 0.5; the vertex mean would also say that,
        // so add an interior point that must not move it.
        let wedge = [0., 0., 0., 2., 0., 0., 0., 3., 0., 0., 0., 1., 2., 0., 1., 0., 3., 1., 0.5, 0.5, 0.5];
        close(hull_mass_offset(&wedge), [2.0 / 3.0, 1.0, 0.5]);
    }

    #[test]
    fn degenerate_points_have_no_offset() {
        assert_eq!(hull_mass_offset(&[0., 0., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0.]), glam::Vec3::ZERO);
        assert_eq!(hull_mass_offset(&[]), glam::Vec3::ZERO);
    }
}
