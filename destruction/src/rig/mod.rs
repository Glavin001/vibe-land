//! A structural test bench: one building, real physics, questions you can ask.
//!
//! Every scenario worth asserting about a building — "it stands", "cut every
//! second column and it still stands", "cut one whole side and it comes down,
//! but not instantly" — is the same experiment: install a pack, run the clock,
//! watch what moves. Written out longhand each time, that experiment is ~100
//! lines of world setup before the first interesting statement, and the copy in
//! the test file drifts from the copy in the server until they are testing
//! different games.
//!
//! So this is the experiment, once. It is deliberately thin: `spin_up` composes
//! the production scene-assembly path (`city::single_building_scene`) and the
//! production install (`CityDestruction::build`), and the tick loop is the
//! server's own `world.step()` + `post_step`. Nothing here reimplements physics;
//! it only makes the state legible — which chunks moved, which bonds broke,
//! when it stopped.
//!
//! The one thing it adds over the server is *bookkeeping*: `Membership` (shared
//! with the trace recorder) so a test can name a set of chunks and ask where
//! they are, and `StatsTrace` so a test can assert about the shape of a
//! collapse over time rather than a single end-state number.
//!
//! ## Assert like the simulator is nondeterministic, because it is
//!
//! PhysX GPU is not bit-reproducible: the same drop has produced 13.2% and
//! 26.3% of bonds broken on consecutive runs. Assert one-sided bounds ("more
//! than", "within this window") and shapes over time ("it held, then it went",
//! "the failures are ordered"), never a level or a count. Exact stress
//! assertions belong upstream in the deterministic solver tests.

pub mod stress_report;
pub mod surgery;
pub mod trace;

use std::collections::HashMap;
use std::sync::Arc;

use glam::{Quat, Vec3};
use vibe_land_physx_bridge::{
    Pose, Quat as BridgeQuat, StaticBoxDesc, Vec3 as BridgeVec3, World, WorldConfig,
};

use crate::city::single_building_scene;
use crate::city_config::stress_settings;
use crate::manifest::DestructionManifest;
use crate::membership::{ChunkIndex, Membership};
use crate::runtime::{CityDestruction, CityDestructionError};
use crate::scene_pack::ScenePack;

pub use stress_report::{BondStress, StressReport};
pub use surgery::{select_nodes, NodeSel};
pub use trace::{Sample, StatsTrace};

/// A point on the outside of a structure at about a third of its height, aimed
/// inward: where a player standing in the street would actually hit it.
///
/// This has now been got wrong twice, in the same direction both times, and
/// each time the wrong answer looked like a fact about the building rather
/// than about the test:
///
///   1. Aiming at a point computed from the BOUNDING BOX put the shot in mid
///      air, because the parking garage's +X face is its open ramp bay. It
///      broke nothing, which read as "the building is indestructible".
///   2. Aiming at the outermost CHUNK picked a foundation block for the walled
///      city -- fixed, unfracturable, alone, with one chunk inside the blast
///      radius. It broke 7 bonds in a 170,000-bond city, which read the same
///      way. With this aim the same shot breaks 503.
///
/// So the rule is: hit something that can break, with material around it.
/// Skip supports and foundations, take the outer tenth by x, and among those
/// prefer the chunk with the most neighbours inside a blast radius.
///
/// It lives here rather than in a test file because both the audit and the
/// shipping sim gates need it, and when they each had a copy the fix landed in
/// one of them.
pub fn facade_aim(pack: &ScenePack) -> ([f32; 3], [f32; 3]) {
    const BLAST_R: f32 = 2.5;
    let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
    for node in &pack.nodes {
        let c = [node.centroid.x, node.centroid.y, node.centroid.z];
        for a in 0..3 {
            lo[a] = lo[a].min(c[a]);
            hi[a] = hi[a].max(c[a]);
        }
    }
    let band = lo[1] + (hi[1] - lo[1]) * 0.33;
    let span = (hi[1] - lo[1]).max(1e-3);

    let eligible: Vec<usize> = (0..pack.nodes.len())
        .filter(|&i| {
            let n = &pack.nodes[i];
            !n.is_support()
                && pack.node_role(i) != "foundation"
                && (n.centroid.y - band).abs() <= span * 0.08
        })
        .collect();
    if eligible.is_empty() {
        let c = pack.nodes[0].centroid;
        return ([c.x, c.y, c.z], [-1.0, 0.0, 0.0]);
    }

    let mut outer = eligible.clone();
    outer.sort_by(|&a, &b| pack.nodes[b].centroid.x.total_cmp(&pack.nodes[a].centroid.x));
    outer.truncate((outer.len() / 10).max(1));

    let neighbours = |i: usize| {
        let c = pack.nodes[i].centroid;
        eligible
            .iter()
            .filter(|&&j| (pack.nodes[j].centroid - c).length_squared() < BLAST_R * BLAST_R)
            .count()
    };
    let best = outer.iter().copied().max_by_key(|&i| neighbours(i)).unwrap_or(outer[0]);
    let c = pack.nodes[best].centroid;
    ([c.x, c.y, c.z], [-1.0, 0.0, 0.0])
}

pub const HZ: u32 = 60;
pub const DT: f32 = 1.0 / HZ as f32;
pub const GRAVITY: [f32; 3] = [0.0, -9.81, 0.0];
const GROUP_STATIC: u32 = 1 << 0;

/// When a rig counts as "at rest".
#[derive(Clone, Copy, Debug)]
pub struct Quiet {
    /// Fraction of chunks still awake that still counts as quiet. Zero demands
    /// total stillness, which small packs do reach.
    pub awake_fraction: f64,
    /// How long it has to stay that way. A structure crosses through quiet on
    /// its way to collapsing — one still frame is not rest.
    pub hold_secs: f32,
}

impl Default for Quiet {
    fn default() -> Self {
        Self {
            awake_fraction: 0.0,
            hold_secs: 1.0,
        }
    }
}

/// Outcome of a settle attempt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Settle {
    /// Went quiet, and stayed quiet, this many seconds in.
    Rested { secs: f32 },
    /// Never went quiet within the budget.
    Restless,
}

impl Settle {
    pub fn rested(self) -> bool {
        matches!(self, Self::Rested { .. })
    }
}

pub struct Rig {
    pub world: World,
    pub destruction: CityDestruction,
    /// The pack as installed, after any surgery. Tests read roles and geometry
    /// off this, so it must be the mutated one, not the file on disk.
    pub pack: ScenePack,
    index: ChunkIndex,
    membership: Membership,
    trace: StatsTrace,
    tick: u32,
    /// Last pose each body reported, kept across ticks.
    ///
    /// The snapshot stream carries only bodies that are awake and dynamic: an
    /// intact structure is kinematic and never appears, and debris drops out
    /// again the moment it settles. Reading it directly therefore says a
    /// collapsed pile is back where it was authored — which is how the garage
    /// scenario measured a two-metre collapse at thirteen seconds and nothing
    /// at all by sixteen. A body that has stopped moving still has a position.
    last_pose: HashMap<u32, (Vec3, Quat)>,
}

impl Rig {
    /// Install a pack over a ground plane and nothing else.
    pub fn spin_up(pack: &ScenePack) -> Result<Self, CityDestructionError> {
        let scene = single_building_scene(pack);
        let manifest = Arc::new(DestructionManifest::from_city(&scene));

        let mut world = World::new(WorldConfig::default()).expect("PhysX world");
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 1,
                user_id: 0,
                pose: Pose {
                    position: BridgeVec3::new(0.0, -10.0, 0.0),
                    rotation: BridgeQuat::IDENTITY,
                },
                half_extents: BridgeVec3::new(2000.0, 10.0, 2000.0),
                collision_group: GROUP_STATIC,
                collision_mask: u32::MAX,
            })
            .expect("ground plane");

        let destruction = CityDestruction::build(
            Arc::clone(&manifest),
            &mut world,
            stress_settings(&pack.materials),
            HZ,
        )?;
        let index = ChunkIndex::from_manifest(&manifest);
        let membership = Membership::new(&index);
        Ok(Self {
            world,
            destruction,
            pack: pack.clone(),
            index,
            membership,
            trace: StatsTrace::default(),
            tick: 0,
            last_pose: HashMap::new(),
        })
    }

    pub fn secs(&self) -> f32 {
        self.tick as f32 * DT
    }

    /// One tick of the production loop, with the ledger and trace kept current.
    pub fn step(&mut self) -> Result<(), CityDestructionError> {
        self.world.step().expect("physx step");
        let output = self.destruction.post_step(&mut self.world, DT, GRAVITY)?;
        // Before poses are read: a chunk promoted this tick belongs to its new
        // body's frame already.
        self.membership.apply_tick(&output, &self.index);
        self.record_poses();
        self.tick += 1;
        Ok(())
    }

    pub fn run_ticks(&mut self, ticks: u32) -> Result<(), CityDestructionError> {
        for _ in 0..ticks {
            self.step()?;
            self.sample_on_the_second();
        }
        Ok(())
    }

    pub fn run_secs(&mut self, secs: f32) -> Result<(), CityDestructionError> {
        self.run_ticks((secs * HZ as f32).round() as u32)
    }

    /// Run until the structure has been quiet for `quiet.hold_secs`, or give up
    /// after `max_secs`.
    pub fn settle_until(
        &mut self,
        quiet: Quiet,
        max_secs: f32,
    ) -> Result<Settle, CityDestructionError> {
        let chunks = self.pack.nodes.len() as f64;
        let hold_ticks = (quiet.hold_secs * HZ as f32).round() as u32;
        let budget = (max_secs * HZ as f32).round() as u32;
        let mut quiet_for = 0u32;
        for _ in 0..budget {
            self.step()?;
            self.sample_on_the_second();
            let awake = self.destruction.stats().awake_chunk_bodies as f64;
            if awake / chunks.max(1.0) <= quiet.awake_fraction {
                quiet_for += 1;
                if quiet_for >= hold_ticks {
                    return Ok(Settle::Rested { secs: self.secs() });
                }
            } else {
                quiet_for = 0;
            }
        }
        Ok(Settle::Restless)
    }

    fn sample_on_the_second(&mut self) {
        if self.tick % HZ == 0 {
            let stats = self.destruction.stats();
            self.trace.push(Sample::capture(self.secs(), &stats));
        }
    }

    pub fn trace(&self) -> &StatsTrace {
        &self.trace
    }

    /// Remember where every reporting body is, so a body that later goes quiet
    /// does not read as never having moved.
    fn record_poses(&mut self) {
        let Ok(snapshots) = self.world.chunk_body_snapshots() else {
            return;
        };
        for snapshot in snapshots {
            self.last_pose.insert(
                snapshot.entity_id,
                (
                    Vec3::new(
                        snapshot.position.x,
                        snapshot.position.y,
                        snapshot.position.z,
                    ),
                    Quat::from_xyzw(
                        snapshot.rotation.x,
                        snapshot.rotation.y,
                        snapshot.rotation.z,
                        snapshot.rotation.w,
                    ),
                ),
            );
        }
    }

    /// World position of every chunk, by dense index (which is node index for a
    /// single-structure rig).
    pub fn chunk_positions(&self) -> Vec<Vec3> {
        let pose_of = |entity: u32| self.last_pose.get(&entity).copied();
        (0..self.index.len() as u32)
            .map(|dense| self.membership.chunk_world(dense, &self.index, &pose_of))
            .collect()
    }

    /// How far a named set of chunks has descended from where it was authored.
    ///
    /// Median, not mean or min: a collapse is "most of this went down", and a
    /// median is not moved by the one shard that bounced into the street or the
    /// one that is still wedged in place.
    pub fn median_drop(&self, chunks: &[u32]) -> f32 {
        if chunks.is_empty() {
            return 0.0;
        }
        let now = self.chunk_positions();
        let mut drops: Vec<f32> = chunks
            .iter()
            .map(|&dense| self.index.rest_world(dense).y - now[dense as usize].y)
            .collect();
        drops.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        drops[drops.len() / 2]
    }

    /// Fire the production shot pipeline at a point.
    pub fn shot(
        &mut self,
        center: [f32; 3],
        direction: [f32; 3],
        shot: crate::city_config::ShotProfile,
    ) -> Result<(), CityDestructionError> {
        self.destruction.wake_around(&mut self.world, center, shot.push_radius_m)?;
        self.destruction.apply_blast(
            &mut self.world,
            center,
            direction,
            shot.blast_radius_m,
            shot.stress_impulse,
            shot.push_speed,
        )?;
        Ok(())
    }

    /// Per-bond stress from the last solve, joined to the pack's roles.
    ///
    /// This is the surgical instrument: it answers which joint is overloaded,
    /// between which chunks, in which mode and at what height, rather than
    /// whether anything anywhere is.
    pub fn stress_report(&self) -> StressReport {
        let rows = self.world.bond_stress_rows(0).unwrap_or_default();
        let materials: Vec<u32> = rows.iter().map(|r| r.material).collect();
        let bonds: Vec<BondStress> = rows
            .iter()
            .map(|r| {
                let a = self.pack.nodes.get(r.node0 as usize).map(|n| n.centroid);
                let b = self.pack.nodes.get(r.node1 as usize).map(|n| n.centroid);
                BondStress {
                    bond_index: r.bond_index,
                    node0: r.node0,
                    node1: r.node1,
                    utilisation: r.utilisation,
                    compression: r.compression,
                    tension: r.tension,
                    shear: r.shear,
                    area: r.area,
                    position: match (a, b) {
                        (Some(a), Some(b)) => (a + b) * 0.5,
                        _ => Vec3::ZERO,
                    },
                }
            })
            .collect();
        let names: Vec<String> = self
            .pack
            .appearances
            .iter()
            .map(|a| a.name.clone().unwrap_or_default())
            .collect();
        StressReport::from_rows(&self.pack, &bonds, |bond_index| {
            materials
                .get(bond_index as usize)
                .and_then(|m| names.get(*m as usize))
                .filter(|n| !n.is_empty())
                .cloned()
                .unwrap_or_else(|| "unnamed".to_string())
        })
    }

    pub fn broken_bonds(&self) -> u32 {
        self.destruction.stats().broken_bonds
    }

    pub fn broken_fraction(&self) -> f64 {
        self.broken_bonds() as f64 / self.pack.bonds.len().max(1) as f64
    }
}
