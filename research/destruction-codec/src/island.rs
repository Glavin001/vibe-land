//! Island view over a Blast-model trace: bodies are islands, not chunks.
//!
//! A trace recorded from the stress solver has a property the D6 traces never
//! had: while chunks share an island they are **rigid** with respect to each
//! other. The island only splits when the bond graph actually disconnects, so
//! one pose per island root reproduces every chunk under it, and an untouched
//! structure is a single body no matter how many chunks it was authored from.
//!
//! That makes the hierarchy true by construction rather than by assumption.
//! The old joint hierarchy assumed it and paid for the assumption in per-chunk
//! repairs (24% of child samples) because welded joints are soft; here there is
//! nothing to repair, and if that ever stops being true the artifact gates fail
//! rather than the bitrate quietly rising.
//!
//! Two streams come out of this:
//!
//!   * **pose records** for island roots only, on the existing debris wire,
//!   * **topology records** naming which chunk belongs to which island, which
//!     is small, must be reliable, and is what lets a client rebuild every
//!     non-root chunk for free from the manifest it already downloaded.

use anyhow::Result;
use glam::{Quat, Vec3};

use crate::trace::{Pose, Tick};

/// Worst-case angular step of the wire's 32-bit smallest-three quaternion:
/// two component quanta at scale `511 * sqrt(2)`.
pub const ROTATION_QUANTUM_RAD: f32 = 2.0 / (511.0 * std::f32::consts::SQRT_2);

/// Which island each chunk belongs to, and where it sits inside that island.
///
/// The offsets are derived from the trace at the tick membership changes. On
/// the wire a client does not need them sent: it holds the same pre-fractured
/// manifest the server does, so `rest_local - island_com` reproduces them from
/// the membership alone. Deriving them here keeps the harness honest about
/// *bytes* while still reconstructing exactly what a client would.
pub struct IslandView {
    /// Chunk -> its island's root chunk. A root is its own root.
    pub roots: Vec<u32>,
    local_pos: Vec<Vec3>,
    local_rot: Vec<Quat>,
}

impl IslandView {
    pub fn new(body_count: usize) -> Self {
        Self {
            roots: (0..body_count as u32).collect(),
            local_pos: vec![Vec3::ZERO; body_count],
            local_rot: vec![Quat::IDENTITY; body_count],
        }
    }

    /// Adopt this tick's membership and re-derive offsets for chunks that moved.
    ///
    /// Only chunks whose root actually changed are touched. A chunk that stays
    /// put keeps the offset it was given when it joined, which is what makes
    /// the island rigid on the wire as well as in the simulation.
    pub fn update(&mut self, tick: &Tick) {
        if tick.topology.changed_roots.is_empty() {
            return;
        }
        for &(actor, root) in &tick.topology.changed_roots {
            let (actor, root) = (actor as usize, root as usize);
            if actor >= self.roots.len() || root >= self.roots.len() {
                continue;
            }
            self.roots[actor] = root as u32;
        }
        for &(actor, root) in &tick.topology.changed_roots {
            let (actor, root) = (actor as usize, root as usize);
            if actor >= self.roots.len() || root >= self.roots.len() {
                continue;
            }
            if actor == root {
                self.local_pos[actor] = Vec3::ZERO;
                self.local_rot[actor] = Quat::IDENTITY;
                continue;
            }
            let root_pose = tick.states[root].pose;
            let own = tick.states[actor].pose;
            let inverse = root_pose.rotation.conjugate();
            self.local_pos[actor] = inverse * (own.position - root_pose.position);
            self.local_rot[actor] = (inverse * own.rotation).normalize();
        }
    }

    pub fn is_root(&self, body: usize) -> bool {
        self.roots[body] as usize == body
    }

    pub fn root_of(&self, body: usize) -> usize {
        self.roots[body] as usize
    }

    /// Rebuild a member chunk from its island root's pose.
    pub fn compose(&self, body: usize, root_pose: Pose) -> Pose {
        Pose {
            position: root_pose.position + root_pose.rotation * self.local_pos[body],
            rotation: (root_pose.rotation * self.local_rot[body]).normalize(),
        }
    }

    /// Velocity of a member chunk given its root's motion. A rigid body's point
    /// velocity is `v + w x r`; writing the root's own velocity would understate
    /// a chunk far from the axis.
    pub fn compose_velocity(
        &self,
        body: usize,
        root_pose: Pose,
        linear: Vec3,
        angular: Vec3,
    ) -> Vec3 {
        linear + angular.cross(root_pose.rotation * self.local_pos[body])
    }

    /// Shell radius each island root must be encoded to.
    ///
    /// The error bound is a bound on how far ANY point of a body may move, and
    /// an island root carries chunks out at a lever arm: a rotation error small
    /// enough for a 0.5 m chunk becomes centimetres of position error on a
    /// member 20 m away. Encoding a root to its own chunk radius silently
    /// under-constrains the whole island -- measured as 249,831 shell
    /// violations and a p99 reversal of 4.7 before this existed. A root is
    /// therefore bounded by its farthest member's reach.
    pub fn island_radii(&self, chunk_radii: &[f32]) -> Vec<f32> {
        let mut reach = vec![0.0f32; self.roots.len()];
        for body in 0..self.roots.len() {
            let root = self.roots[body] as usize;
            let arm = self.local_pos[body].length() + chunk_radii[body];
            if arm > reach[root] {
                reach[root] = arm;
            }
        }
        let mut out = chunk_radii.to_vec();
        for body in 0..self.roots.len() {
            if self.is_root(body) {
                out[body] = reach[body].max(chunk_radii[body]);
            }
        }
        out
    }

    /// Largest island radius whose members stay inside `shell_m`.
    ///
    /// The wire codes rotation as a 32-bit smallest-three quaternion: 10 bits
    /// per component at scale 511*sqrt(2), so the angular step is about
    /// 2.8 mrad in the worst case. A member at radius r inherits `r * step` of
    /// position error from that single quantum no matter how well the root is
    /// fitted -- it is a floor of the representation, not of the fitter.
    ///
    /// At the 0.5 cm bound this reference is measured against, that caps a
    /// derivable island at ~1.8 m. Bigger islands are still streamed, but their
    /// members carry their own records rather than being derived, which is why
    /// island mode never trades fidelity for the byte win.
    pub fn max_derivable_radius(shell_m: f32) -> f32 {
        shell_m / ROTATION_QUANTUM_RAD
    }

    /// Whether each island may have its members derived from the root.
    pub fn derivable(&self, chunk_radii: &[f32], shell_m: f32) -> Vec<bool> {
        let limit = Self::max_derivable_radius(shell_m);
        self.island_radii(chunk_radii)
            .into_iter()
            .map(|radius| radius <= limit)
            .collect()
    }

    pub fn island_count(&self) -> usize {
        self.roots
            .iter()
            .enumerate()
            .filter(|(index, root)| **root as usize == *index)
            .count()
    }
}

/// One tick's topology delta, as it would go on a reliable track.
#[derive(Clone, Debug, Default)]
pub struct TopologyTickDelta {
    pub tick: u32,
    pub broken_bonds: Vec<u64>,
    /// `(chunk, island root)` -- explicit membership. The client could instead
    /// recompute connected components over the bond graph it already holds, but
    /// physics moves chunks between islands with no bond break at all (762 such
    /// migrations in the 30 s reference), so a graph-derived membership drifts
    /// from the server's while a stated one cannot.
    pub changed_roots: Vec<(u32, u32)>,
}

impl TopologyTickDelta {
    pub fn from_tick(tick: &Tick) -> Option<Self> {
        if tick.topology.broken_edges.is_empty() && tick.topology.changed_roots.is_empty() {
            return None;
        }
        Some(Self {
            tick: tick.index,
            broken_bonds: tick.topology.broken_edges.clone(),
            changed_roots: tick.topology.changed_roots.clone(),
        })
    }
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

/// Encode a run of topology deltas as one compressed block.
///
/// Everything is a sorted delta: ticks against the block start, bond ids and
/// chunk indices against their predecessor, and each chunk's root against the
/// chunk itself -- which is near-zero for the common case of a chunk whose
/// island root is close by in index order.
pub fn encode_topology_block(deltas: &[TopologyTickDelta], first_tick: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write_varint(&mut out, deltas.len() as u64);
    for delta in deltas {
        write_varint(&mut out, (delta.tick - first_tick) as u64);

        let mut bonds = delta.broken_bonds.clone();
        bonds.sort_unstable();
        write_varint(&mut out, bonds.len() as u64);
        let mut previous = 0u64;
        for bond in bonds {
            write_varint(&mut out, bond.wrapping_sub(previous));
            previous = bond;
        }

        let mut roots = delta.changed_roots.clone();
        roots.sort_unstable_by_key(|(chunk, _)| *chunk);
        write_varint(&mut out, roots.len() as u64);
        let mut previous_chunk = 0u32;
        for (chunk, root) in roots {
            write_varint(&mut out, chunk.wrapping_sub(previous_chunk) as u64);
            write_varint(&mut out, zigzag(root as i64 - chunk as i64));
            previous_chunk = chunk;
        }
    }
    Ok(zstd::bulk::compress(&out, 3)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{ActorState, TopologyTick};

    fn state(position: Vec3, rotation: Quat) -> ActorState {
        ActorState {
            pose: Pose { position, rotation },
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            contacts: 0,
            intact_joints: 0,
            flags: 0,
        }
    }

    fn tick_with(states: Vec<ActorState>, changed: Vec<(u32, u32)>) -> Tick {
        Tick {
            index: 0,
            simulation_time: 0.0,
            states,
            contact_pairs: Vec::new(),
            topology: TopologyTick {
                epoch: 1,
                broken_edges: Vec::new(),
                changed_roots: changed,
                island_roots: Vec::new(),
            },
        }
    }

    #[test]
    fn member_recomposes_to_its_recorded_pose() {
        let rotation = Quat::from_rotation_y(0.7);
        let root = state(Vec3::new(1.0, 2.0, 3.0), rotation);
        let member_local = Vec3::new(0.5, -1.5, 0.25);
        let member = state(
            root.pose.position + rotation * member_local,
            rotation * Quat::from_rotation_x(0.2),
        );
        let tick = tick_with(vec![root, member], vec![(0, 0), (1, 0)]);

        let mut view = IslandView::new(2);
        view.update(&tick);

        assert!(view.is_root(0));
        assert!(!view.is_root(1));
        let rebuilt = view.compose(1, root.pose);
        assert!(
            (rebuilt.position - tick.states[1].pose.position).length() < 1e-5,
            "{rebuilt:?} vs {:?}",
            tick.states[1].pose
        );
        assert!(rebuilt.rotation.dot(tick.states[1].pose.rotation).abs() > 0.9999);
    }

    /// The whole point of the model: a rigid island that moves and spins carries
    /// its members exactly, so a member needs no wire records of its own.
    #[test]
    fn member_follows_a_moving_island_with_no_records() {
        let member_local = Vec3::new(2.0, 0.0, 0.0);
        let start = tick_with(
            vec![
                state(Vec3::ZERO, Quat::IDENTITY),
                state(member_local, Quat::IDENTITY),
            ],
            vec![(0, 0), (1, 0)],
        );
        let mut view = IslandView::new(2);
        view.update(&start);

        let moved = Pose {
            position: Vec3::new(10.0, -4.0, 2.0),
            rotation: Quat::from_rotation_z(std::f32::consts::FRAC_PI_2),
        };
        let rebuilt = view.compose(1, moved);
        // Rotated a quarter turn about z, the +x offset becomes +y.
        assert!((rebuilt.position - Vec3::new(10.0, -2.0, 2.0)).length() < 1e-5);
    }

    #[test]
    fn splitting_reassigns_a_member_to_its_own_island() {
        let base = tick_with(
            vec![
                state(Vec3::ZERO, Quat::IDENTITY),
                state(Vec3::new(1.0, 0.0, 0.0), Quat::IDENTITY),
            ],
            vec![(0, 0), (1, 0)],
        );
        let mut view = IslandView::new(2);
        view.update(&base);
        assert_eq!(view.island_count(), 1);

        let split = tick_with(
            vec![
                state(Vec3::ZERO, Quat::IDENTITY),
                state(Vec3::new(4.0, 1.0, 0.0), Quat::IDENTITY),
            ],
            vec![(1, 1)],
        );
        view.update(&split);
        assert_eq!(view.island_count(), 2);
        assert!(view.is_root(1));
        assert_eq!(view.compose(1, split.states[1].pose).position, Vec3::new(4.0, 1.0, 0.0));
    }

    #[test]
    fn a_root_is_bounded_by_its_farthest_member_not_its_own_size() {
        let tick = tick_with(
            vec![
                state(Vec3::ZERO, Quat::IDENTITY),
                state(Vec3::new(20.0, 0.0, 0.0), Quat::IDENTITY),
            ],
            vec![(0, 0), (1, 0)],
        );
        let mut view = IslandView::new(2);
        view.update(&tick);
        let radii = view.island_radii(&[0.5, 0.5]);
        // Root spans out to the member 20 m away, plus that member's own size.
        assert!((radii[0] - 20.5).abs() < 1e-4, "root radius {}", radii[0]);
        // A member keeps its own radius: its error is judged on its own body.
        assert!((radii[1] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn a_big_island_is_not_derivable_at_a_tight_bound() {
        let tick = tick_with(
            vec![
                state(Vec3::ZERO, Quat::IDENTITY),
                state(Vec3::new(30.0, 0.0, 0.0), Quat::IDENTITY),
            ],
            vec![(0, 0), (1, 0)],
        );
        let mut view = IslandView::new(2);
        view.update(&tick);
        // A 30 m island cannot hold 5 mm: one rotation quantum is ~8 cm out there.
        assert!(!view.derivable(&[0.5, 0.5], 0.005)[0]);
        // Loosen the bound past that lever arm and it becomes derivable.
        assert!(view.derivable(&[0.5, 0.5], 0.5)[0]);
    }

    #[test]
    fn topology_block_is_smaller_than_the_raw_pairs() {
        let deltas: Vec<TopologyTickDelta> = (0..40)
            .map(|tick| TopologyTickDelta {
                tick,
                broken_bonds: (0..8).map(|bond| (tick as u64 * 8) + bond).collect(),
                changed_roots: (0..8).map(|chunk| (tick * 8 + chunk, tick * 8)).collect(),
            })
            .collect();
        let encoded = encode_topology_block(&deltas, 0).unwrap();
        // 40 ticks x 8 bonds x 8 B + 40 x 8 pairs x 8 B = 5120 B raw.
        assert!(encoded.len() < 2560, "topology block {} B", encoded.len());
    }

    #[test]
    fn a_quiet_tick_produces_no_topology_record() {
        let quiet = tick_with(vec![state(Vec3::ZERO, Quat::IDENTITY)], Vec::new());
        assert!(TopologyTickDelta::from_tick(&quiet).is_none());
    }
}
