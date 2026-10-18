//! What broke, derived the same way on both ends.
//!
//! The server sends only the outcome of a fracture: the bonds that broke and
//! the chunks the physics removed. Both ends then derive the bodies with this
//! one implementation, which is pure integer work and identical on every
//! platform:
//!
//! - flood fill over intact bonds, skipping removed chunks;
//! - a component holding a support chunk is the standing structure
//!   (`ANCHORED`);
//! - every other component is one body, named by its lowest chunk.
//!
//! Measured against PhysX's own islands on a 314 s native capture
//! (`derive-check`, docs/netcode-lab.md): no body was split or merged
//! differently, and the only disagreements were chunks the physics removed
//! without breaking their bonds, which the server states as `removed`.

use glam::{Quat, Vec3};
use std::collections::BTreeMap;

/// The body id of chunks in a standing (support-holding) component.
pub const ANCHORED: u32 = u32::MAX;
/// The body id of a chunk the physics removed (crushed, retired).
pub const REMOVED: u32 = u32::MAX - 1;

/// One structure as authored: what the map asset gives both ends.
#[derive(Clone, Debug, Default)]
pub struct StructureDef {
    pub id: u32,
    pub world_position: Vec3,
    pub world_rotation: Quat,
    /// Per node: the geometry origin (`ChunkDef::centroid`), structure frame.
    pub rest: Vec<Vec3>,
    /// Per node: where its mass is centred (`ChunkDef::mass_center`).
    pub mass_center: Vec<Vec3>,
    pub mass: Vec<f32>,
    pub support: Vec<bool>,
    /// Per bond index: its two nodes.
    pub bonds: Vec<(u32, u32)>,
    /// Per node: the chunk box's half extents, structure frame (empty when
    /// unknown: then no ground floor is derived).
    pub half_extents: Vec<Vec3>,
    /// Per node: (neighbour, bond index).
    adjacency: Vec<Vec<(u32, u32)>>,
    /// Per node: bonds to the nearest support, intact (u32::MAX: none).
    /// Steers the search a fracture makes for a support; never decides.
    support_hops: Vec<u32>,
}

impl StructureDef {
    pub fn new(
        id: u32,
        world_position: Vec3,
        world_rotation: Quat,
        rest: Vec<Vec3>,
        mass_center: Vec<Vec3>,
        mass: Vec<f32>,
        support: Vec<bool>,
        bonds: Vec<(u32, u32)>,
    ) -> Self {
        let mut adjacency = vec![Vec::new(); rest.len()];
        for (index, &(a, b)) in bonds.iter().enumerate() {
            if (a as usize) < adjacency.len() && (b as usize) < adjacency.len() {
                adjacency[a as usize].push((b, index as u32));
                adjacency[b as usize].push((a, index as u32));
            }
        }
        // Breadth first from every support at once.
        let mut support_hops = vec![u32::MAX; rest.len()];
        let mut queue: std::collections::VecDeque<u32> = (0..rest.len() as u32).filter(|&n| support[n as usize]).collect();
        for &n in &queue {
            support_hops[n as usize] = 0;
        }
        while let Some(n) = queue.pop_front() {
            for &(other, _) in &adjacency[n as usize] {
                if support_hops[other as usize] == u32::MAX {
                    support_hops[other as usize] = support_hops[n as usize] + 1;
                    queue.push_back(other);
                }
            }
        }
        Self { id, world_position, world_rotation, rest, mass_center, mass, support, bonds, half_extents: Vec::new(), adjacency, support_hops }
    }

    /// With each node's box half extents (`ChunkDef::size` / 2).
    pub fn with_half_extents(mut self, half_extents: Vec<Vec3>) -> Self {
        self.half_extents = half_extents;
        self
    }

    pub fn node_count(&self) -> u32 {
        self.rest.len() as u32
    }

    /// A node's neighbours: (neighbour, bond index).
    pub fn neighbours(&self, node: u32) -> &[(u32, u32)] {
        self.adjacency.get(node as usize).map_or(&[], Vec::as_slice)
    }
}

/// What one fracture changed: bodies whose membership changed (new ones
/// included), bodies that no longer exist, and the chunks that moved body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FractureChange {
    pub changed_bodies: Vec<u32>,
    pub retired_bodies: Vec<u32>,
    pub moved_chunks: Vec<u32>,
    /// For each changed body, the body (or ANCHORED) its lowest chunk was on
    /// before: what its first pose derives from.
    pub parent_of: Vec<(u32, u32)>,
}

/// One structure's runtime state.
#[derive(Clone, Debug)]
pub struct StructureState {
    alive: Vec<u64>,
    removed: Vec<u64>,
    body_of: Vec<u32>,
    members: BTreeMap<u32, Vec<u32>>,
}

/// The height of the lowest corner of `boxes` (`floor_boxes`) at a pose.
pub fn lowest_point_of(boxes: &[(Vec3, Vec3)], position: Vec3, rotation: Quat) -> f32 {
    // A box's lowest point below its centre: |R row y| . half.
    let m = glam::Mat3::from_quat(rotation);
    let row_y = Vec3::new(m.x_axis.y, m.y_axis.y, m.z_axis.y).abs();
    boxes.iter().map(|&(offset, half)| (position + rotation * offset).y - row_y.dot(half)).fold(f32::INFINITY, f32::min)
}

#[cfg(test)]
thread_local! {
    /// Nodes a fracture looked at (searched or re-derived): the work.
    pub(crate) static WORK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn note_work(_nodes: usize) {
    #[cfg(test)]
    WORK.with(|w| w.set(w.get() + _nodes));
}

fn bit(bits: &[u64], i: u32) -> bool {
    bits[(i / 64) as usize] & (1 << (i % 64)) != 0
}

fn set_bit(bits: &mut [u64], i: u32, on: bool) {
    let word = &mut bits[(i / 64) as usize];
    if on {
        *word |= 1 << (i % 64);
    } else {
        *word &= !(1 << (i % 64));
    }
}

impl StructureState {
    /// Every bond intact, nothing removed.
    pub fn new(def: &StructureDef) -> Self {
        let bonds = def.bonds.len() as u32;
        let nodes = def.node_count();
        let mut alive = vec![0u64; bonds.div_ceil(64) as usize];
        for b in 0..bonds {
            set_bit(&mut alive, b, true);
        }
        let mut state = Self {
            alive,
            removed: vec![0u64; nodes.div_ceil(64) as usize],
            body_of: vec![ANCHORED; nodes as usize],
            members: BTreeMap::new(),
        };
        let all: Vec<u32> = (0..nodes).collect();
        state.rederive(def, &all);
        state
    }

    pub fn bond_alive(&self, bond: u32) -> bool {
        bit(&self.alive, bond)
    }

    pub fn is_removed(&self, node: u32) -> bool {
        bit(&self.removed, node)
    }

    pub fn body_of(&self, node: u32) -> u32 {
        self.body_of[node as usize]
    }

    /// Dynamic bodies and their members (ascending).
    pub fn bodies(&self) -> &BTreeMap<u32, Vec<u32>> {
        &self.members
    }

    pub fn members(&self, body: u32) -> Option<&[u32]> {
        self.members.get(&body).map(Vec::as_slice)
    }

    /// Apply a fracture outcome: `broken` bond indices, `removed` nodes.
    pub fn apply(&mut self, def: &StructureDef, broken: &[u32], removed: &[u32]) -> FractureChange {
        let mut seeds: Vec<u32> = Vec::new();
        for &bond in broken {
            if (bond as usize) < def.bonds.len() && bit(&self.alive, bond) {
                set_bit(&mut self.alive, bond, false);
                let (a, b) = def.bonds[bond as usize];
                seeds.push(a);
                seeds.push(b);
            }
        }
        for &node in removed {
            if node < def.node_count() && !bit(&self.removed, node) {
                set_bit(&mut self.removed, node, true);
                seeds.push(node);
                for &(other, _) in &def.adjacency[node as usize] {
                    seeds.push(other);
                }
            }
        }
        // Everything on a body a seed was on is re-derived (a split can move
        // any of them), except the standing structure: of that, only what
        // no longer reaches a support (the rest stays standing, unchanged).
        let mut region: Vec<u32> = Vec::new();
        let mut in_region = vec![false; def.node_count() as usize];
        let mut standing: Vec<u32> = Vec::new();
        for &seed in &seeds {
            let body = self.body_of[seed as usize];
            let nodes: Vec<u32> = match body {
                ANCHORED if !bit(&self.removed, seed) => {
                    standing.push(seed);
                    continue;
                }
                ANCHORED | REMOVED => vec![seed],
                id => self.members.get(&id).cloned().unwrap_or_else(|| vec![seed]),
            };
            for n in nodes {
                if !in_region[n as usize] {
                    in_region[n as usize] = true;
                    region.push(n);
                }
            }
        }
        for n in self.cut_off(def, &standing) {
            if !in_region[n as usize] {
                in_region[n as usize] = true;
                region.push(n);
            }
        }
        self.rederive(def, &region)
    }

    /// The standing chunks among `seeds`' components that no longer reach a
    /// support: whole components. From each seed, a search over intact bonds
    /// heads for the nearest support (by `support_hops`); reaching one (or a
    /// chunk already found to) proves the component still stands, and
    /// running out of chunks first proves it fell. Either way it looks at no
    /// more than the side it settles, and steered downhill, a standing side
    /// settles in about its height.
    fn cut_off(&self, def: &StructureDef, seeds: &[u32]) -> Vec<u32> {
        use std::cmp::Reverse;
        const UNSEEN: u8 = 0;
        const SEARCHING: u8 = 1;
        const STANDS: u8 = 2;
        const FELL: u8 = 3;
        if seeds.is_empty() {
            return Vec::new();
        }
        let mut mark = vec![UNSEEN; def.node_count() as usize];
        let mut fell: Vec<u32> = Vec::new();
        let mut visited: Vec<u32> = Vec::new();
        let mut frontier: std::collections::BinaryHeap<Reverse<(u32, u32)>> = std::collections::BinaryHeap::new();
        for &seed in seeds {
            if mark[seed as usize] != UNSEEN {
                continue;
            }
            visited.clear();
            frontier.clear();
            mark[seed as usize] = SEARCHING;
            visited.push(seed);
            frontier.push(Reverse((def.support_hops[seed as usize], seed)));
            let mut stands = false;
            'search: while let Some(Reverse((_, node))) = frontier.pop() {
                if def.support.get(node as usize).copied().unwrap_or(false) {
                    stands = true;
                    break;
                }
                for &(other, bond) in &def.adjacency[node as usize] {
                    if !bit(&self.alive, bond) || bit(&self.removed, other) {
                        continue;
                    }
                    match mark[other as usize] {
                        UNSEEN => {
                            mark[other as usize] = SEARCHING;
                            visited.push(other);
                            frontier.push(Reverse((def.support_hops[other as usize], other)));
                        }
                        STANDS => {
                            stands = true;
                            break 'search;
                        }
                        _ => {}
                    }
                }
            }
            note_work(visited.len());
            let outcome = if stands { STANDS } else { FELL };
            for &n in &visited {
                mark[n as usize] = outcome;
            }
            if !stands {
                fell.extend_from_slice(&visited);
            }
        }
        fell
    }

    /// Re-derive the bodies of `region` (a union of whole bodies).
    fn rederive(&mut self, def: &StructureDef, region: &[u32]) -> FractureChange {
        note_work(region.len());
        let mut change = FractureChange::default();
        let before: Vec<(u32, u32)> = region.iter().map(|&n| (n, self.body_of[n as usize])).collect();
        let old_bodies: std::collections::BTreeSet<u32> =
            before.iter().map(|&(_, b)| b).filter(|&b| b != ANCHORED && b != REMOVED).collect();
        for id in &old_bodies {
            self.members.remove(id);
        }
        let mut seen = vec![false; def.node_count() as usize];
        let mut in_region = vec![false; def.node_count() as usize];
        for &n in region {
            in_region[n as usize] = true;
        }
        let mut sorted: Vec<u32> = region.to_vec();
        sorted.sort_unstable();
        let mut new_ids = std::collections::BTreeSet::new();
        for &start in &sorted {
            if seen[start as usize] {
                continue;
            }
            if bit(&self.removed, start) {
                seen[start as usize] = true;
                self.body_of[start as usize] = REMOVED;
                continue;
            }
            // Flood fill over intact bonds among non-removed nodes.
            let mut component = vec![start];
            seen[start as usize] = true;
            let mut i = 0;
            while i < component.len() {
                let node = component[i];
                i += 1;
                for &(other, bond) in &def.adjacency[node as usize] {
                    if !seen[other as usize] && bit(&self.alive, bond) && !bit(&self.removed, other) {
                        // A component never leaves the region: the region is a
                        // union of whole bodies, and bodies are components.
                        debug_assert!(in_region[other as usize], "flood fill left the re-derived region");
                        seen[other as usize] = true;
                        component.push(other);
                    }
                }
            }
            component.sort_unstable();
            let anchored = component.iter().any(|&n| def.support.get(n as usize).copied().unwrap_or(false));
            let id = if anchored { ANCHORED } else { component[0] };
            for &n in &component {
                self.body_of[n as usize] = id;
            }
            if !anchored {
                new_ids.insert(id);
                self.members.insert(id, component);
            }
        }
        for &(node, old) in &before {
            if self.body_of[node as usize] != old {
                change.moved_chunks.push(node);
            }
        }
        for &id in &new_ids {
            let members = &self.members[&id];
            let old_members: Vec<u32> =
                before.iter().filter(|&&(_, b)| b == id).map(|&(n, _)| n).collect();
            if old_members != *members {
                change.changed_bodies.push(id);
                let parent = before.iter().find(|&&(n, _)| n == id).map_or(ANCHORED, |&(_, b)| b);
                change.parent_of.push((id, parent));
            }
        }
        for id in old_bodies {
            if !new_ids.contains(&id) {
                change.retired_bodies.push(id);
            }
        }
        change.moved_chunks.sort_unstable();
        change
    }

    /// The structure hash both ends compare (gate G1): FNV-1a 64 over the
    /// alive bonds, the removed chunks and every chunk's body.
    pub fn hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for &b in bytes {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        for word in &self.alive {
            feed(&word.to_le_bytes());
        }
        for word in &self.removed {
            feed(&word.to_le_bytes());
        }
        for &body in &self.body_of {
            feed(&body.to_le_bytes());
        }
        h
    }

    /// Where a body's mass is centred, structure frame: the mass-weighted
    /// mean of its members' mass centres (the plain mean of their rest
    /// centroids when massless) -- PhysX's rule, and the client's.
    pub fn centre_of_mass(&self, def: &StructureDef, body: u32) -> Vec3 {
        let Some(members) = self.members.get(&body) else {
            return Vec3::ZERO;
        };
        let (mut sum, mut mass, mut plain) = (Vec3::ZERO, 0.0f32, Vec3::ZERO);
        for &n in members {
            let m = def.mass[n as usize];
            if m > 0.0 {
                sum += def.mass_center[n as usize] * m;
                mass += m;
            }
            plain += def.rest[n as usize];
        }
        if mass > 0.0 {
            sum / mass
        } else {
            plain / members.len().max(1) as f32
        }
    }

    /// How far `body`'s centre can fall from `position` (rotation
    /// `rotation`) before its lowest chunk corner reaches the ground at
    /// y = 0: the `Keyframe::floor_drop` both sides derive. None when the
    /// chunk boxes are unknown or the body has no members.
    pub fn floor_drop(&self, def: &StructureDef, body: u32, position: Vec3, rotation: Quat) -> Option<f32> {
        self.lowest_point(def, body, position, rotation).map(|y| y.max(0.0))
    }

    /// The height of `body`'s lowest chunk corner at a pose (negative:
    /// below the ground).
    pub fn lowest_point(&self, def: &StructureDef, body: u32, position: Vec3, rotation: Quat) -> Option<f32> {
        Some(lowest_point_of(&self.floor_boxes(def, body)?, position, rotation))
    }

    /// `body`'s chunk boxes as `lowest_point_of` takes them: each one's
    /// offset from the body's centre of mass and its half extents. They
    /// change only with the body's membership.
    pub fn floor_boxes(&self, def: &StructureDef, body: u32) -> Option<Vec<(Vec3, Vec3)>> {
        let members = self.members.get(&body)?;
        if def.half_extents.len() != def.rest.len() || members.is_empty() {
            return None;
        }
        let com = self.centre_of_mass(def, body);
        Some(members.iter().map(|&n| (def.rest[n as usize] - com, def.half_extents[n as usize])).collect())
    }

    /// `floor_drop` from `floor_boxes`.
    pub fn floor_drop_of(boxes: &[(Vec3, Vec3)], position: Vec3, rotation: Quat) -> f32 {
        lowest_point_of(boxes, position, rotation).max(0.0)
    }

    pub fn alive_bits(&self) -> &[u64] {
        &self.alive
    }

    pub fn removed_bits(&self) -> &[u64] {
        &self.removed
    }

    /// Restore from bitsets (late join), then derive every body.
    pub fn from_bits(def: &StructureDef, alive: Vec<u64>, removed: Vec<u64>) -> Self {
        let nodes = def.node_count();
        let mut state = Self { alive, removed, body_of: vec![ANCHORED; nodes as usize], members: BTreeMap::new() };
        let all: Vec<u32> = (0..nodes).collect();
        state.rederive(def, &all);
        state
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A column: node 0 is a support, 1..n stacked, bond i joins i and i+1.
    pub(crate) fn column(n: u32) -> StructureDef {
        StructureDef::new(
            3,
            Vec3::new(10.0, 0.0, 0.0),
            Quat::IDENTITY,
            (0..n).map(|i| Vec3::new(0.0, i as f32, 0.0)).collect(),
            (0..n).map(|i| Vec3::new(0.0, i as f32, 0.0)).collect(),
            (0..n).map(|i| if i == 0 { 0.0 } else { 10.0 }).collect(),
            (0..n).map(|i| i == 0).collect(),
            (0..n - 1).map(|i| (i, i + 1)).collect(),
        )
    }

    #[test]
    fn an_intact_structure_is_anchored() {
        let def = column(5);
        let state = StructureState::new(&def);
        assert!(state.bodies().is_empty());
        assert!((0..5).all(|n| state.body_of(n) == ANCHORED));
    }

    #[test]
    fn a_break_frees_the_part_above_named_by_its_lowest_chunk() {
        let def = column(6);
        let mut state = StructureState::new(&def);
        let change = state.apply(&def, &[2], &[]);
        // Bond 2 joins 2 and 3: nodes 3..5 fall as body 3.
        assert_eq!(state.members(3), Some(&[3u32, 4, 5][..]));
        assert_eq!(change.changed_bodies, vec![3]);
        assert_eq!(change.parent_of, vec![(3, ANCHORED)]);
        assert_eq!(change.moved_chunks, vec![3, 4, 5]);
        // It breaks again: the piece keeping chunk 3 keeps the id.
        let change = state.apply(&def, &[3], &[]);
        assert_eq!(state.members(3), Some(&[3u32][..]));
        assert_eq!(state.members(4), Some(&[4u32, 5][..]));
        assert_eq!(change.changed_bodies, vec![3, 4]);
        assert_eq!(change.parent_of, vec![(3, 3), (4, 3)]);
        assert!(change.retired_bodies.is_empty());
    }

    #[test]
    fn a_removed_chunk_leaves_its_body_without_a_bond_breaking() {
        let def = column(6);
        let mut state = StructureState::new(&def);
        state.apply(&def, &[2], &[]);
        // Crush chunk 4 (the middle of body 3): 3 and 5 separate.
        let change = state.apply(&def, &[], &[4]);
        assert_eq!(state.body_of(4), REMOVED);
        assert_eq!(state.members(3), Some(&[3u32][..]));
        assert_eq!(state.members(5), Some(&[5u32][..]));
        assert_eq!(change.changed_bodies, vec![3, 5]);
        // Removing the whole body retires it.
        let change = state.apply(&def, &[], &[3]);
        assert_eq!(change.retired_bodies, vec![3]);
    }

    #[test]
    fn both_ends_hash_alike_and_bitsets_restore_the_same_state() {
        let def = column(8);
        let mut a = StructureState::new(&def);
        let mut b = StructureState::new(&def);
        for state in [&mut a, &mut b] {
            state.apply(&def, &[1, 4], &[6]);
        }
        assert_eq!(a.hash(), b.hash());
        let joined = StructureState::from_bits(&def, a.alive_bits().to_vec(), a.removed_bits().to_vec());
        assert_eq!(joined.hash(), a.hash());
        assert_eq!(joined.bodies(), a.bodies());
        let c = StructureState::new(&def);
        assert_ne!(c.hash(), a.hash());
    }

    /// A standing block `nx` x `ny` x `nz`, the bottom layer supports, each
    /// chunk bonded to its six neighbours.
    pub(crate) fn block(nx: u32, ny: u32, nz: u32) -> StructureDef {
        let id = |x: u32, y: u32, z: u32| (y * nz + z) * nx + x;
        let mut rest = Vec::new();
        let mut support = Vec::new();
        for y in 0..ny {
            for z in 0..nz {
                for x in 0..nx {
                    rest.push(Vec3::new(x as f32, y as f32, z as f32));
                    support.push(y == 0);
                }
            }
        }
        let mut bonds = Vec::new();
        for y in 0..ny {
            for z in 0..nz {
                for x in 0..nx {
                    if x + 1 < nx {
                        bonds.push((id(x, y, z), id(x + 1, y, z)));
                    }
                    if y + 1 < ny {
                        bonds.push((id(x, y, z), id(x, y + 1, z)));
                    }
                    if z + 1 < nz {
                        bonds.push((id(x, y, z), id(x, y, z + 1)));
                    }
                }
            }
        }
        let n = rest.len();
        StructureDef::new(5, Vec3::ZERO, Quat::IDENTITY, rest.clone(), rest, vec![1.0; n], support, bonds)
    }

    /// The bonds with exactly one end in `inside`.
    fn cut(def: &StructureDef, inside: impl Fn(Vec3) -> bool) -> Vec<u32> {
        (0..def.bonds.len() as u32)
            .filter(|&b| {
                let (a, c) = def.bonds[b as usize];
                inside(def.rest[a as usize]) != inside(def.rest[c as usize])
            })
            .collect()
    }

    /// The derivation before anchored fractures were searched: every
    /// anchored chunk re-derived whenever one is touched.
    fn apply_everything(state: &mut StructureState, def: &StructureDef, broken: &[u32], removed: &[u32]) -> FractureChange {
        let mut seeds: Vec<u32> = Vec::new();
        for &bond in broken {
            if (bond as usize) < def.bonds.len() && bit(&state.alive, bond) {
                set_bit(&mut state.alive, bond, false);
                let (a, b) = def.bonds[bond as usize];
                seeds.push(a);
                seeds.push(b);
            }
        }
        for &node in removed {
            if node < def.node_count() && !bit(&state.removed, node) {
                set_bit(&mut state.removed, node, true);
                seeds.push(node);
                for &(other, _) in &def.adjacency[node as usize] {
                    seeds.push(other);
                }
            }
        }
        let mut region: Vec<u32> = Vec::new();
        let mut in_region = vec![false; def.node_count() as usize];
        for &seed in &seeds {
            let nodes: Vec<u32> = match state.body_of[seed as usize] {
                ANCHORED => (0..def.node_count()).filter(|&n| state.body_of[n as usize] == ANCHORED).collect(),
                REMOVED => vec![seed],
                id => state.members.get(&id).cloned().unwrap_or_else(|| vec![seed]),
            };
            for n in nodes {
                if !in_region[n as usize] {
                    in_region[n as usize] = true;
                    region.push(n);
                }
            }
        }
        state.rederive(def, &region)
    }

    fn work<T>(f: impl FnOnce() -> T) -> (T, usize) {
        WORK.with(|w| w.set(0));
        let out = f();
        (out, WORK.with(|w| w.get()))
    }

    /// A break in a standing structure of Vibe Town's size (51,200 chunks)
    /// looks at what it can change, not at every standing chunk, and
    /// derives exactly what re-deriving everything does.
    #[test]
    fn a_fracture_in_a_large_standing_structure_looks_only_near_the_break() {
        let def = block(40, 32, 40);
        let (mut state, mut reference) = (StructureState::new(&def), StructureState::new(&def));
        // Fractures, each with the most it may look at: a corner knocked off
        // the top (8 chunks free), one bond in a wall's middle (nothing
        // frees), a slab through a column of the block (nothing frees: the
        // rest holds it), and a chunk crushed out of the middle.
        let steps: Vec<(Vec<u32>, Vec<u32>, usize)> = vec![
            (cut(&def, |p| p.x >= 38.0 && p.y >= 30.0 && p.z >= 38.0), vec![], 400),
            (vec![def.bonds.iter().position(|&(a, b)| a == 20 + 40 * (20 + 40 * 16) && b == a + 1).unwrap() as u32], vec![], 400),
            (cut(&def, |p| p.x < 3.0 && p.z < 3.0 && p.y >= 10.0 && p.y < 12.0), vec![], 2_000),
            (vec![], vec![20 + 40 * (20 + 40 * 16)], 400),
        ];
        for (i, (broken, removed, most)) in steps.into_iter().enumerate() {
            let (change, looked) = work(|| state.apply(&def, &broken, &removed));
            let expected = apply_everything(&mut reference, &def, &broken, &removed);
            assert_eq!(change, expected, "step {i}");
            assert_eq!(state.hash(), reference.hash(), "step {i}");
            assert_eq!(state.bodies(), reference.bodies(), "step {i}");
            assert!(looked <= most, "step {i}: looked at {looked} chunks (at most {most})");
        }
        // Cutting the top 4 layers off frees them: what it frees is the work.
        let broken = cut(&def, |p| p.y >= 28.0);
        let (change, looked) = work(|| state.apply(&def, &broken, &[]));
        assert_eq!(change, apply_everything(&mut reference, &def, &broken, &[]));
        assert_eq!(state.bodies(), reference.bodies());
        assert!(looked <= 3 * 4 * 40 * 40, "looked at {looked}");
    }

    /// Random breaks and crushes, step by step, against re-deriving
    /// everything: identical bodies, changes and hash throughout.
    #[test]
    fn searched_fractures_derive_what_rederiving_everything_does() {
        let def = block(9, 7, 8);
        let mut seed = 0x2545f4914f6cdd1du64;
        let mut rand = move |n: u32| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % u64::from(n)) as u32
        };
        for _ in 0..40 {
            let (mut state, mut reference) = (StructureState::new(&def), StructureState::new(&def));
            for step in 0..30 {
                let broken: Vec<u32> = (0..rand(12)).map(|_| rand(def.bonds.len() as u32)).collect();
                let removed: Vec<u32> = (0..rand(3).saturating_sub(1)).map(|_| rand(def.node_count())).collect();
                let change = state.apply(&def, &broken, &removed);
                assert_eq!(change, apply_everything(&mut reference, &def, &broken, &removed), "step {step}");
                assert_eq!(state.hash(), reference.hash());
                assert_eq!(state.bodies(), reference.bodies());
            }
        }
    }

    #[test]
    fn the_centre_of_mass_weighs_mass_centres() {
        let def = column(6);
        let mut state = StructureState::new(&def);
        state.apply(&def, &[2], &[]);
        assert!((state.centre_of_mass(&def, 3) - Vec3::new(0.0, 4.0, 0.0)).length() < 1e-6);
    }
}
