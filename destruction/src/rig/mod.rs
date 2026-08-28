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

pub use surgery::{select_nodes, NodeSel};
pub use trace::{Sample, StatsTrace};

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

    pub fn broken_bonds(&self) -> u32 {
        self.destruction.stats().broken_bonds
    }

    pub fn broken_fraction(&self) -> f64 {
        self.broken_bonds() as f64 / self.pack.bonds.len().max(1) as f64
    }
}
