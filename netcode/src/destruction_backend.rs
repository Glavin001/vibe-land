//! Engine-neutral contract for Blast stress-driven destruction.
//!
//! The native adapter owns Blast families, PhysX shapes, actors, and the
//! post-fetch mutation window. Networking and gameplay only see stable IDs.

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
}

impl Default for StressSolverSettings {
    fn default() -> Self {
        Self {
            max_solver_iterations_per_frame: 25,
            graph_reduction_level: 0,
            material: StressMaterial::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChunkMassProperties {
    pub chunk_id: u32,
    pub mass: f32,
    pub volume: f32,
    pub center_of_mass: [f32; 3],
    pub inertia_diagonal: [f32; 3],
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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DestructionStats {
    pub awake_families: u32,
    pub solved_nodes: u32,
    pub solved_bonds: u32,
    pub broken_bonds: u32,
    pub stress_solve_ms: f32,
    pub migration_ms: f32,
}

/// Runs after PhysX `fetchResults` and before the next `simulate`.
pub trait DestructionBackend {
    type Error: std::error::Error + Send + Sync + 'static;

    fn register_family(
        &mut self,
        structure_id: u32,
        blast_asset: &[u8],
        chunks: &[ChunkMassProperties],
        settings: StressSolverSettings,
    ) -> Result<(), Self::Error>;

    fn queue_contact(&mut self, contact: ContactStressInput);

    /// Solves awake families and returns one batched shape-migration plan.
    fn solve_after_fetch(&mut self, gravity: [f32; 3]) -> Result<Vec<FractureBatch>, Self::Error>;

    /// Executes all detach/attach/add/remove operations in one mutation window.
    fn apply_mutation_window(&mut self, batches: &[FractureBatch]) -> Result<(), Self::Error>;

    fn stats(&self) -> DestructionStats;
}
