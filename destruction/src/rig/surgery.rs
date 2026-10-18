//! Cutting a building up before you simulate it.
//!
//! "What happens if I take out every column on one side" is a question about a
//! *different building* — one that never had those columns. There is no runtime
//! delete, and there does not need to be: a `ScenePack` is plain owned data, so
//! the experiment is a pack transform followed by an ordinary spin-up.
//!
//! The care needed is entirely bookkeeping. A pack is a bundle of arrays that
//! are parallel by convention — nodes, sizes, colliders, roles, pieces — plus a
//! bond list holding *indices into* those arrays. Drop a node and every array
//! must lose the same slot while every surviving bond is renumbered. Getting
//! that subtly wrong does not crash; it silently builds a structure whose bonds
//! point at the wrong chunks, which then behaves like nonsense physics.

use glam::Vec3;

use crate::scene_pack::{SceneCollider, ScenePack};

/// Which chunks a scenario is talking about.
///
/// Roles come from the pack (`nodeTypes`), authored by whoever built the
/// structure. Selecting "every column" by role rather than by geometry is the
/// difference between a test that survives someone moving a column and one that
/// quietly starts testing empty air.
#[derive(Clone, Debug, Default)]
pub struct NodeSel {
    /// Structural role, exact match: "column", "slab", "foundation", ...
    pub role: Option<String>,
    /// Keep only nodes inside this world-space box (inclusive).
    pub aabb: Option<(Vec3, Vec3)>,
    /// Keep only nodes belonging to these authored pieces.
    pub pieces: Option<Vec<u32>>,
}

impl NodeSel {
    pub fn role(role: &str) -> Self {
        Self {
            role: Some(role.to_string()),
            ..Self::default()
        }
    }

    pub fn within(mut self, low: Vec3, high: Vec3) -> Self {
        self.aabb = Some((low, high));
        self
    }

    pub fn pieces(mut self, pieces: Vec<u32>) -> Self {
        self.pieces = Some(pieces);
        self
    }

    fn matches(&self, pack: &ScenePack, index: usize) -> bool {
        if let Some(role) = &self.role {
            if pack.node_role(index) != role {
                return false;
            }
        }
        if let Some((low, high)) = self.aabb {
            let c = pack.nodes[index].centroid;
            if c.x < low.x || c.y < low.y || c.z < low.z {
                return false;
            }
            if c.x > high.x || c.y > high.y || c.z > high.z {
                return false;
            }
        }
        if let Some(pieces) = &self.pieces {
            match pack.node_pieces.get(index) {
                Some(piece) if pieces.contains(piece) => {}
                _ => return false,
            }
        }
        true
    }
}

/// Node indices matching a selector.
pub fn select_nodes(pack: &ScenePack, sel: &NodeSel) -> Vec<u32> {
    (0..pack.nodes.len())
        .filter(|&index| sel.matches(pack, index))
        .map(|index| index as u32)
        .collect()
}

/// Node indices matching a selector and an arbitrary predicate on the node.
///
/// The escape hatch for scenarios roles cannot express — "every second column
/// along X", "the column nearest this point".
pub fn select_nodes_where(
    pack: &ScenePack,
    sel: &NodeSel,
    mut predicate: impl FnMut(usize, &crate::scene_pack::SceneNode) -> bool,
) -> Vec<u32> {
    (0..pack.nodes.len())
        .filter(|&index| sel.matches(pack, index) && predicate(index, &pack.nodes[index]))
        .map(|index| index as u32)
        .collect()
}

/// The same pack with those nodes never having existed.
///
/// Bonds touching a removed node go with it — that is the point, it is how a
/// destroyed column stops carrying load — and every surviving bond is
/// renumbered onto the compacted node list.
pub fn remove_nodes(pack: &ScenePack, remove: &[u32]) -> ScenePack {
    let mut doomed = vec![false; pack.nodes.len()];
    for &index in remove {
        if let Some(slot) = doomed.get_mut(index as usize) {
            *slot = true;
        }
    }

    let mut remap = vec![u32::MAX; pack.nodes.len()];
    let mut out = ScenePack {
        title: format!("{} (cut)", pack.title),
        version: pack.version,
        stress_limits: pack.stress_limits,
        materials: pack.materials.clone(),
        appearances: pack.appearances.clone(),
        nodes: Vec::new(),
        bonds: Vec::new(),
        node_sizes: Vec::new(),
        node_colliders: Vec::new(),
        node_types: Vec::new(),
        node_pieces: Vec::new(),
    };
    for index in 0..pack.nodes.len() {
        if doomed[index] {
            continue;
        }
        remap[index] = out.nodes.len() as u32;
        out.nodes.push(pack.nodes[index]);
        out.node_sizes.push(pack.node_sizes[index]);
        out.node_colliders.push(pack.node_colliders[index].clone());
        if let Some(role) = pack.node_types.get(index) {
            out.node_types.push(role.clone());
        }
        if let Some(&piece) = pack.node_pieces.get(index) {
            out.node_pieces.push(piece);
        }
    }
    for bond in &pack.bonds {
        let (node0, node1) = (
            remap[bond.node0 as usize],
            remap[bond.node1 as usize],
        );
        if node0 == u32::MAX || node1 == u32::MAX {
            continue;
        }
        let mut kept = *bond;
        kept.node0 = node0;
        kept.node1 = node1;
        out.bonds.push(kept);
    }
    out
}

/// The pack tipped a quarter turn about Z and lifted `height` metres, with its
/// foundations released.
///
/// A quarter turn specifically: it maps axes onto axes, so box half-extents and
/// hull points transform exactly and no collider has to be re-fitted. Arbitrary
/// angles would need real re-cooking, which is why a building meant to be
/// tested lying down is better authored lying down.
///
/// Supports are freed by giving the zero-mass anchors real mass — a pinned
/// foundation would hold the building in mid-air.
///
/// `height` is a translation, not a ground clearance: the structure is lifted
/// by that much from wherever the rotation left it.
pub fn rotated_and_raised(pack: &ScenePack, height: f32) -> ScenePack {
    // (x, y, z) -> (-y, x, z)
    let turn = |v: Vec3| Vec3::new(-v.y, v.x, v.z);
    let mut out = pack.clone();
    out.title = format!("{} (toppled)", pack.title);
    for node in &mut out.nodes {
        node.centroid = turn(node.centroid);
        if node.mass == 0.0 {
            // Density of the reference concrete: an anchor has a real volume,
            // it simply had no weight while it was the thing holding the world.
            node.mass = node.volume * 2400.0;
        }
    }
    for size in &mut out.node_sizes {
        *size = Vec3::new(size.y, size.x, size.z);
    }
    for collider in &mut out.node_colliders {
        match collider {
            SceneCollider::Cuboid { half_extents } => {
                *half_extents = Vec3::new(half_extents.y, half_extents.x, half_extents.z);
            }
            SceneCollider::ConvexHull { points, .. } => {
                for point in points.chunks_exact_mut(3) {
                    let turned = turn(Vec3::new(point[0], point[1], point[2]));
                    point[0] = turned.x;
                    point[1] = turned.y;
                    point[2] = turned.z;
                }
            }
        }
    }
    for bond in &mut out.bonds {
        bond.centroid = turn(bond.centroid);
        bond.normal = turn(bond.normal);
    }

    for node in &mut out.nodes {
        node.centroid.y += height;
    }
    for bond in &mut out.bonds {
        bond.centroid.y += height;
    }
    out
}
