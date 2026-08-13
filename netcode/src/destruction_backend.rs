//! Engine-neutral contract for Blast stress-driven destruction.
//!
//! The native adapter owns Blast families, PhysX shapes, actors, and the
//! post-fetch mutation window. Networking and gameplay only see stable IDs.
//!
//! Revision note (2026-08-10): the original sketch took a serialized Blast
//! asset and split solve/apply into two calls. The real adapter
//! (`ExtStressPhysXDestructible`) builds its `NvBlastAsset` from node/bond
//! descriptors and applies scene mutations inside its own `endTick()`, so
//! registration now takes descriptors and the tick is a single
//! `tick_after_fetch` whose output *describes* what was applied. Settle
//! events (the network-definitive "at rest now" moment) are part of the
//! output.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StressMaterial {
    pub compression_elastic_mpa: f32,
    pub compression_fatal_mpa: f32,
    pub tension_elastic_mpa: f32,
    pub tension_fatal_mpa: f32,
    pub shear_elastic_mpa: f32,
    pub shear_fatal_mpa: f32,
}

impl Default for StressMaterial {
    fn default() -> Self {
        Self {
            compression_elastic_mpa: 0.008,
            compression_fatal_mpa: 0.01,
            tension_elastic_mpa: -1.0,
            tension_fatal_mpa: -1.0,
            shear_elastic_mpa: -1.0,
            shear_fatal_mpa: -1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StressSolverSettings {
    pub max_solver_iterations_per_frame: u32,
    pub graph_reduction_level: u32,
    pub material: StressMaterial,
    /// Per-structure caps mirroring `ExtStressPhysXSettings`.
    pub maximum_bodies: u32,
    pub maximum_fractures_per_actor_per_tick: u32,
    /// Drop fracture commands touching support nodes unless the partner is a
    /// light peelable chunk (facades peel, structure stays locked).
    pub apply_excess_forces: bool,
    pub excess_force_scale: f32,
}

impl Default for StressSolverSettings {
    fn default() -> Self {
        Self {
            max_solver_iterations_per_frame: 25,
            graph_reduction_level: 0,
            material: StressMaterial::default(),
            maximum_bodies: 48,
            maximum_fractures_per_actor_per_tick: 8,
            apply_excess_forces: true,
            excess_force_scale: 0.012,
        }
    }
}

/// One chunk (support-graph node) at registration time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChunkNodeDef {
    /// Node index within the structure (dense 0..N).
    pub node_index: u32,
    /// Rest centroid in structure-local space.
    pub centroid: [f32; 3],
    /// Zero mass marks a world-support anchor node.
    pub mass: f32,
    pub volume: f32,
    pub geometry: ChunkGeometryDef,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChunkGeometryDef {
    Cuboid { half_extents: [f32; 3] },
    ConvexHull { points: Vec<[f32; 3]> },
}

impl Default for ChunkGeometryDef {
    fn default() -> Self {
        Self::Cuboid {
            half_extents: [0.5; 3],
        }
    }
}

/// One bond (support-graph edge) at registration time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BondDef {
    /// Bond index within the structure (dense 0..N).
    pub bond_index: u32,
    pub node0: u32,
    pub node1: u32,
    pub centroid: [f32; 3],
    pub normal: [f32; 3],
    pub area: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContactStressInput {
    pub structure_id: u32,
    pub chunk_id: u32,
    pub impulse: [f32; 3],
    pub point: [f32; 3],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShapeMigration {
    pub chunk_id: u32,
    pub from_island_id: u32,
    pub to_island_id: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IslandPromotion {
    pub structure_id: u32,
    pub island_id: u32,
    pub chunks: Vec<u32>,
    pub mass: f32,
    pub center_of_mass: [f32; 3],
    pub inertia_diagonal: [f32; 3],
    /// Body pose at promotion, in the canonical body frame: the **centre of
    /// mass** frame. The wire pose of every island body maps structure-rest
    /// coordinates *minus that island's centre of mass* to world
    /// (`chunk_world = body_pose ∘ (manifest_rest_local - island_com)`).
    ///
    /// This is a convention backends must normalise to, not one they get for
    /// free. PhysX bodies the Blast adapter creates for a split are positioned
    /// at their centre of mass, so their raw pose already satisfies it; the one
    /// child per split that reuses the parent actor does not, since it keeps
    /// the parent's frame and stores its new centre of mass as a local offset.
    /// Emitting that body's raw pose draws its chunks one centre-of-mass height
    /// too low and makes them orbit as it tumbles. The PhysX backend composes
    /// the local centre of mass in before emitting (see `com_world_position`).
    ///
    /// Clients use manifest rest poses minus the island centre of mass as
    /// body-local offsets — including late joiners with no split history — and
    /// the kinematic stream only ever moves island bodies.
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub split_impulse: [f32; 3],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FractureBatch {
    pub structure_id: u32,
    pub broken_bond_ids: Vec<u32>,
    pub migrations: Vec<ShapeMigration>,
    pub promoted_islands: Vec<IslandPromotion>,
    pub retired_island_ids: Vec<u32>,
}

/// The network-definitive "at rest now" record for one island body.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SettleEvent {
    pub structure_id: u32,
    pub island_id: u32,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DestructionTickOutput {
    pub batches: Vec<FractureBatch>,
    pub settled: Vec<SettleEvent>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
/// Every field here must be assigned from a real measurement.
///
/// `min_body_y` was declared, logged, shown in the overlay and asserted on in
/// two tests while never being assigned anywhere -- it read its f32 Default of
/// 0.0 forever, which is what made "the server holds every body above ground"
/// look measured when it was not. Four more fields (awake_families,
/// solved_nodes, solved_bonds, migration_ms) had the same defect with no
/// consumers at all and were removed. A stat that cannot be produced is worse
/// than no stat: it is a confident wrong answer.
pub struct DestructionStats {
    pub structures: u32,
    pub chunk_bodies: u32,
    pub awake_chunk_bodies: u32,
    pub broken_bonds: u32,
    /// Chunks physics moved between existing islands without a promotion.
    /// These are collected but not yet put on the wire, so a non-zero count
    /// means the client's membership (and therefore every affected island's
    /// centre of mass) has diverged from the server's.
    pub chunk_migrations: u64,
    pub stress_solve_ms: f32,
    /// Settles deferred because the body was still sunk in the ground. A
    /// sleeping body gets no depenetration, so freezing one mid-penetration
    /// strands it below the floor permanently.
    pub settle_deferred_penetrating: u64,
    /// Lowest awake chunk-body origin this tick, in metres. The city ground is
    /// a flat plane at y=0, so a negative value means physics itself has a body
    /// under the floor (as opposed to the client reconstructing one there).
    pub min_body_y: f32,
    /// Dynamic bodies the bridge dropped for lacking an island serial.
    pub unmapped_body_skips: u32,
    /// Full state of the lowest body, for diagnosing escapes: position,
    /// velocity, and the peak speeds seen anywhere this tick.
    pub min_body_pos: [f32; 3],
    pub min_body_vel: [f32; 3],
    /// Fastest body THIS TICK. Lifetime peaks are kept separately: a running
    /// maximum can never come back down, so it cannot answer "is anything
    /// still moving now", which is the question a settle check asks.
    pub max_body_speed: f32,
    pub max_body_angular_speed: f32,
    /// Where the fastest awake body is, so "moving" can be told from "stale
    /// velocity on a body that never changes position".
    pub max_speed_body_pos: [f32; 3],
    pub max_speed_body_entity: u32,
    /// Fastest body seen at any point, for spotting escapes after the fact.
    pub peak_body_speed: f32,
    pub peak_body_angular_speed: f32,
    /// Bodies re-armed for settling after waking back up. Without this they
    /// stayed awake for the rest of the match.
    pub resettled_wakes: u64,
    /// Per-phase breakdown of the native destruction tick.
    /// Serial beginTick across structures (contact/gravity injection).
    pub begin_ms: f32,
    /// Parallel/CUDA solveTick only.
    pub solve_ms: f32,
    /// Serial endTick across structures (fracture + PhysX actor edits).
    pub end_ms: f32,
    /// Host-side stages of the city step, measured in Rust. Previously these
    /// were one undifferentiated "city step" number ~19 ms wide.
    pub post_step_ms: f32,
    /// post_step internals: the snapshot FFI + Vec rebuild, the settle scan,
    /// and the separate destruction_stats FFI call.
    pub readback_ms_host: f32,
    pub settle_ms: f32,
    pub stats_ffi_ms: f32,
    /// The three FFI event drains plus batch assembly.
    pub drain_ms: f32,
    /// The destruction_tick FFI call itself (all C++ phases inside it).
    pub tick_ffi_ms: f32,
    pub snapshot_ms: f32,
    pub ingest_ms: f32,
    pub readback_ms: f32,
    pub events_ms: f32,
    /// Structures whose stress solve is actually running on the GPU. The
    /// adapter falls back to the CPU solver silently when a graph is below the
    /// bond crossover or CUDA init failed, so this distinguishes "GPU
    /// requested" from "GPU running".
    pub gpu_stress_structures: u32,
    pub gpu_stress_solve_ms: f32,
    pub filters_ms: f32,
    pub sleeping_chunk_bodies: u32,
}

/// Runs after PhysX `fetchResults` and before the next `simulate`.
pub trait DestructionBackend {
    type Error: std::error::Error + Send + Sync + 'static;

    /// Register one destructible structure from node/bond descriptors. The
    /// adapter builds the Blast asset and PhysX representation internally.
    fn register_structure(
        &mut self,
        structure_id: u32,
        world_position: [f32; 3],
        world_rotation: [f32; 4],
        nodes: &[ChunkNodeDef],
        bonds: &[BondDef],
        settings: StressSolverSettings,
    ) -> Result<(), Self::Error>;

    /// Queue an external damage impulse (hitscan, explosion, contact) against
    /// a chunk before the next tick.
    fn queue_contact(&mut self, contact: ContactStressInput);

    /// Solve stress, apply fractures and scene mutations in one window, run
    /// the settle policy, and describe everything that happened.
    fn tick_after_fetch(
        &mut self,
        dt: f32,
        gravity: [f32; 3],
    ) -> Result<DestructionTickOutput, Self::Error>;

    fn stats(&self) -> DestructionStats;
}
