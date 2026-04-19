//! Destructible structures driven by NVIDIA Blast's stress solver.
//!
//! Wraps [`blast_stress_solver::rapier::DestructibleSet`] and glues it to
//! vibe-land's existing [`SimWorld`](crate::simulation::SimWorld).  Each
//! destructible instance owns an independent solver + a set of Rapier rigid
//! bodies; the rigid bodies are registered into `SimWorld`'s shared
//! `RigidBodySet`/`ColliderSet` so they interact with vehicles, the player
//! capsule, and the rest of the world automatically.
//!
//! This module is gated on `cfg(target_arch = "wasm32")`.  The Blast C++
//! backend is only built for the wasm target.  See `shared/Cargo.toml`
//! and `docs/BLAST_INTEGRATION.md`.

use std::collections::{HashMap, HashSet};

use nalgebra::{Isometry3, Point3, Quaternion, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::{
    ActiveEvents, ActiveHooks, ColliderHandle, CollisionEvent, CollisionEventFlags, ContactPair,
    ImpulseJointSet, MultibodyJointSet, RigidBodyHandle, RigidBodyType,
};
use wasm_bindgen::prelude::*;

use blast_stress_solver::authoring::{build_scenario_from_pieces, BondingOptions, ScenarioPiece};
use blast_stress_solver::rapier::{DebrisCollisionMode, DestructibleSet, FracturePolicy};
use blast_stress_solver::scenarios::{TowerOptions, WallOptions};
use blast_stress_solver::types::{SolverSettings, Vec3 as BlastVec3};
use blast_stress_solver::ScenarioNode;

use crate::destructibles_math::{
    authored_position_to_solver_position, effective_solver_material_scale,
    relative_speed_along_force, DEFAULT_TOWER_MATERIAL_SCALE, DEFAULT_WALL_MATERIAL_SCALE,
    SOLVER_MATERIAL_SCALE_REFERENCE, USER_MATERIAL_SCALE_REFERENCE, USER_TO_SOLVER_SCALE_EXPONENT,
};
use crate::simulation::SimWorld;

// Minimal `console.log` binding — avoids pulling in `web_sys` just for
// a handful of diagnostic lines.  Calls are gated through
// `destructibles_log_enabled()` so production builds can silence them
// without recompiling.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Runtime toggle for destructibles debug logging.  Flipped on by
/// [`set_destructibles_logging`] (exposed via `wasm_api.rs`).  Default
/// off so production users don't see console spam.
static mut DESTRUCTIBLES_LOG_ENABLED: bool = false;

/// Safe getter — wasm is strictly single-threaded so the unsafe access
/// to the static is sound.
#[inline]
pub fn destructibles_log_enabled() -> bool {
    unsafe { DESTRUCTIBLES_LOG_ENABLED }
}

/// Enable/disable destructibles debug logging at runtime.  Called from
/// `WasmSimWorld::setDestructiblesLogging`.
pub fn set_destructibles_log_enabled(enabled: bool) {
    unsafe {
        DESTRUCTIBLES_LOG_ENABLED = enabled;
    }
}

#[inline]
fn dlog(msg: &str) {
    if destructibles_log_enabled() {
        log(msg);
    }
}

/// Solver material constants, mirroring `scaled_solver_settings` in the
/// upstream `blast-stress-demo-rs/src/main.rs`.  These are tuned to be
/// brittle enough that a vehicle collision can reliably crack a wall and
/// topple a tower without driving the solver into degenerate states.
const BASE_COMPRESSION_ELASTIC: f32 = 0.0009;
const BASE_COMPRESSION_FATAL: f32 = 0.0027;
const BASE_TENSION_ELASTIC: f32 = 0.0009;
const BASE_TENSION_FATAL: f32 = 0.0027;
const BASE_SHEAR_ELASTIC: f32 = 0.0012;
const BASE_SHEAR_FATAL: f32 = 0.0036;
// Approximate masonry / concrete-block bulk density. We use this to derive
// per-piece masses from actual chunk volume so fractured debris has a more
// physically coherent mass than the older arbitrary total-mass split.
const WALL_MATERIAL_DENSITY_KG_M3: f32 = 1_800.0;
const TOWER_MATERIAL_DENSITY_KG_M3: f32 = 1_600.0;

/// Material softness used for vibe-land practice destructibles.
///
/// The upstream demo packs use a much larger material scale because
/// they are shot by very heavy projectiles. In vibe-land, copying that
/// value made car impacts stop fracturing entirely, so keep the local
/// practice tuning separate.
const CONTACT_SPLASH_RADIUS: f32 = 2.0;
const CONTACT_FORCE_SCALE: f32 = 1.0;
const MIN_IMPACT_IMPULSE_NS: f32 = 8.0;
const MIN_IMPACT_SPEED_M_S: f32 = 0.5;
const IMPACT_COOLDOWN_SECS: f32 = 0.50;
const MAX_INJECTED_IMPACT_FORCE_N: f32 = 250.0;

/// Stride of [`DestructibleRegistry::chunk_transforms`] in `f32`s:
/// `[destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, present, _pad]`.
pub const CHUNK_TRANSFORM_STRIDE: usize = 11;

#[derive(Clone, Copy, Debug)]
pub struct DestructibleRuntimeConfig {
    pub wall_material_scale: f32,
    pub tower_material_scale: f32,
}

impl Default for DestructibleRuntimeConfig {
    fn default() -> Self {
        Self {
            wall_material_scale: DEFAULT_WALL_MATERIAL_SCALE,
            tower_material_scale: DEFAULT_TOWER_MATERIAL_SCALE,
        }
    }
}

fn scaled_solver_settings(material_scale: f32) -> SolverSettings {
    let material_scale = effective_solver_material_scale(material_scale);
    SolverSettings {
        max_solver_iterations_per_frame: 24,
        graph_reduction_level: 0,
        compression_elastic_limit: BASE_COMPRESSION_ELASTIC * material_scale,
        compression_fatal_limit: BASE_COMPRESSION_FATAL * material_scale,
        tension_elastic_limit: BASE_TENSION_ELASTIC * material_scale,
        tension_fatal_limit: BASE_TENSION_FATAL * material_scale,
        shear_elastic_limit: BASE_SHEAR_ELASTIC * material_scale,
        shear_fatal_limit: BASE_SHEAR_FATAL * material_scale,
    }
}

fn cuboid_triangles(min: BlastVec3, max: BlastVec3) -> Vec<BlastVec3> {
    let p000 = BlastVec3::new(min.x, min.y, min.z);
    let p001 = BlastVec3::new(min.x, min.y, max.z);
    let p010 = BlastVec3::new(min.x, max.y, min.z);
    let p011 = BlastVec3::new(min.x, max.y, max.z);
    let p100 = BlastVec3::new(max.x, min.y, min.z);
    let p101 = BlastVec3::new(max.x, min.y, max.z);
    let p110 = BlastVec3::new(max.x, max.y, min.z);
    let p111 = BlastVec3::new(max.x, max.y, max.z);

    vec![
        p000, p101, p001, p000, p100, p101, p010, p011, p111, p010, p111, p110, p000, p001, p011,
        p000, p011, p010, p100, p110, p111, p100, p111, p101, p000, p010, p110, p000, p110, p100,
        p001, p101, p111, p001, p111, p011,
    ]
}

fn authored_wall_pieces(opts: &WallOptions) -> Vec<ScenarioPiece> {
    let cell_x = opts.span / (opts.span_segments.max(1) as f64);
    let cell_y = opts.height / (opts.height_segments.max(1) as f64);
    let cell_z = opts.thickness / (opts.layers.max(1) as f64);

    let origin_x = -opts.span * 0.5 + 0.5 * cell_x;
    let origin_y = 0.0 + 0.5 * cell_y;
    let origin_z = 0.0;

    let total_nodes = opts.span_segments * opts.height_segments * opts.layers;
    let volume_per_node = cell_x * cell_y * cell_z;
    let mass_per_node = volume_per_node * WALL_MATERIAL_DENSITY_KG_M3 as f64;

    let half = BlastVec3::new(
        (cell_x * 0.5) as f32,
        (cell_y * 0.5) as f32,
        (cell_z * 0.5) as f32,
    );
    let node_size = BlastVec3::new(cell_x as f32, cell_y as f32, cell_z as f32);

    let mut pieces = Vec::with_capacity(total_nodes as usize);
    for ix in 0..opts.span_segments {
        for iy in 0..opts.height_segments {
            for iz in 0..opts.layers {
                let centroid = BlastVec3::new(
                    (origin_x + ix as f64 * cell_x) as f32,
                    (origin_y + iy as f64 * cell_y) as f32,
                    (origin_z + (iz as f64 - (opts.layers - 1) as f64 * 0.5) * cell_z) as f32,
                );
                let min = BlastVec3::new(
                    centroid.x - half.x,
                    centroid.y - half.y,
                    centroid.z - half.z,
                );
                let max = BlastVec3::new(
                    centroid.x + half.x,
                    centroid.y + half.y,
                    centroid.z + half.z,
                );
                let is_support = iy == 0;
                pieces.push(ScenarioPiece {
                    node: ScenarioNode {
                        centroid,
                        mass: if is_support {
                            0.0
                        } else {
                            mass_per_node as f32
                        },
                        volume: if is_support {
                            0.0
                        } else {
                            volume_per_node as f32
                        },
                    },
                    triangles: cuboid_triangles(min, max),
                    bondable: true,
                    node_size: Some(node_size),
                    collider_shape: None,
                });
            }
        }
    }
    pieces
}

fn build_authored_wall_scenario() -> Result<blast_stress_solver::types::ScenarioDesc, String> {
    build_scenario_from_pieces(
        &authored_wall_pieces(&WallOptions::default()),
        &BondingOptions::default(),
    )
    .map_err(|error| format!("failed to auto-bond wall pieces: {error}"))
}

fn authored_tower_pieces(opts: &TowerOptions) -> Vec<ScenarioPiece> {
    let total_rows = opts.stories + 1;
    let volume = (opts.spacing_x * opts.spacing_y * opts.spacing_z) as f32;
    let node_mass = volume as f64 * TOWER_MATERIAL_DENSITY_KG_M3 as f64;

    let half = BlastVec3::new(
        (opts.spacing_x * 0.5) as f32,
        (opts.spacing_y * 0.5) as f32,
        (opts.spacing_z * 0.5) as f32,
    );
    let node_size = BlastVec3::new(
        opts.spacing_x as f32,
        opts.spacing_y as f32,
        opts.spacing_z as f32,
    );

    let mut pieces = Vec::with_capacity((opts.side * total_rows * opts.side) as usize);
    for iz in 0..opts.side {
        for iy in 0..total_rows {
            for ix in 0..opts.side {
                let centroid = BlastVec3::new(
                    ((ix as f64 - (opts.side - 1) as f64 / 2.0) * opts.spacing_x) as f32,
                    ((iy as f64 - 1.0) * opts.spacing_y) as f32,
                    ((iz as f64 - (opts.side - 1) as f64 / 2.0) * opts.spacing_z) as f32,
                );
                let min = BlastVec3::new(
                    centroid.x - half.x,
                    centroid.y - half.y,
                    centroid.z - half.z,
                );
                let max = BlastVec3::new(
                    centroid.x + half.x,
                    centroid.y + half.y,
                    centroid.z + half.z,
                );
                let is_support = iy == 0;
                pieces.push(ScenarioPiece {
                    node: ScenarioNode {
                        centroid,
                        mass: if is_support { 0.0 } else { node_mass as f32 },
                        volume: if is_support { 0.0 } else { volume },
                    },
                    triangles: cuboid_triangles(min, max),
                    bondable: true,
                    node_size: Some(node_size),
                    collider_shape: None,
                });
            }
        }
    }
    pieces
}

fn build_authored_tower_scenario() -> Result<blast_stress_solver::types::ScenarioDesc, String> {
    build_scenario_from_pieces(
        &authored_tower_pieces(&TowerOptions::default()),
        &BondingOptions::default(),
    )
    .map_err(|error| format!("failed to auto-bond tower pieces: {error}"))
}

fn configured_fracture_policy() -> FracturePolicy {
    FracturePolicy {
        // Match the upstream wall/tower demo behavior. Leaving this enabled
        // produced post-split launches with absurd body speeds immediately
        // after fracture in practice mode.
        apply_excess_forces: false,
        ..FracturePolicy::default()
    }
}

fn configured_debris_collision_mode() -> DebrisCollisionMode {
    DebrisCollisionMode::All
}

/// Which Blast scenario to build for an instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DestructibleKind {
    Wall,
    Tower,
}

/// A single destructible instance placed in the world.  Owns a
/// `DestructibleSet` and the handles of every chunk body it created inside
/// `SimWorld`.
///
/// # Chunk model
///
/// In Blast, an *actor* is a connected subgraph of nodes — before any
/// fracture, every destructible has exactly one actor holding every
/// node.  `DestructibleSet::initialize` therefore spawns a single
/// Rapier rigid body with one collider per node at init time; the
/// collider centroids are the visible bricks.
///
/// `DestructibleInstance` exposes the *node* granularity (one "chunk"
/// per brick) so the client can render each brick independently.  At
/// every [`DestructibleRegistry::step`] we read each node's owning
/// body + local offset and reconstruct the world-space pose.  After a
/// fracture the solver migrates some nodes to new bodies; the same
/// transform query keeps working without any special casing.
pub struct DestructibleInstance {
    pub id: u32,
    pub kind: DestructibleKind,
    pub pose: Isometry3<f32>,
    set: DestructibleSet,
    /// Stable node count captured at spawn time (nodes never go away,
    /// only their body-affiliation changes).
    node_count: u32,
    /// Cached transforms buffer (stride = [`CHUNK_TRANSFORM_STRIDE`]).
    transforms: Vec<f32>,
}

impl DestructibleInstance {
    pub fn chunk_count(&self) -> usize {
        self.node_count as usize
    }
}

#[derive(Clone, Copy)]
struct BodyMotionSnapshot {
    position: Isometry3<f32>,
    linvel: Vector3<f32>,
    angvel: Vector3<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct BodyKey(u32, u32);

impl From<RigidBodyHandle> for BodyKey {
    fn from(handle: RigidBodyHandle) -> Self {
        let (index, generation) = handle.into_raw_parts();
        Self(index, generation)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct BodyPairKey(BodyKey, BodyKey);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ImpactCooldownKey {
    pair: BodyPairKey,
    target_body: BodyKey,
}

fn canonical_body_pair_key(body1: RigidBodyHandle, body2: RigidBodyHandle) -> Option<BodyPairKey> {
    if body1 == body2 {
        return None;
    }
    let key1 = BodyKey::from(body1);
    let key2 = BodyKey::from(body2);
    Some(if key1 <= key2 {
        BodyPairKey(key1, key2)
    } else {
        BodyPairKey(key2, key1)
    })
}

/// Collection of all destructibles currently in the sim.
///
/// Uses a linear `Vec<DestructibleInstance>` keyed by stable `id` → index
/// so that `Vec` iteration stays cache friendly while lookups are O(n) for
/// the tiny populations we expect (<16 instances in practice).
pub struct DestructibleRegistry {
    runtime_config: DestructibleRuntimeConfig,
    instances: Vec<DestructibleInstance>,
    id_to_index: HashMap<u32, usize>,
    /// Aggregated chunk transforms across all instances.  Rebuilt every
    /// frame inside [`DestructibleRegistry::step`].
    transforms: Vec<f32>,
    /// Aggregated fracture event queue (destructible id, chunk id pairs).
    /// Drained by the client via `getDestructibleFractureEvents`.
    fracture_events: Vec<u32>,
    /// Monotonic sim clock in seconds — incremented every
    /// [`DestructibleRegistry::step`] by `dt`.  Passed to
    /// `DestructibleSet::mark_body_support_contact` so support-contact
    /// staleness tracking works without the caller having to thread a
    /// clock through.
    sim_time_secs: f32,
    debug_impact_seq: u32,
    debug_impact_processed: u32,
    debug_impact_max_impulse_ns: f32,
    debug_impact_max_speed_m_s: f32,
    debug_impact_max_splash_nodes: u32,
    debug_impact_max_body_node_count: u32,
    debug_impact_max_splash_weight_sum: f32,
    debug_impact_max_estimated_injected_force_n: f32,
    debug_impact_instance_id: u32,
    debug_fracture_seq: u32,
    debug_fracture_instance_id: u32,
    debug_fracture_instance_body_count: u32,
    debug_fractures: u32,
    debug_split_events: u32,
    debug_new_bodies: u32,
    debug_active_bodies: u32,
    debug_post_fracture_max_body_speed_m_s: f32,
    debug_post_fracture_fast_body_count: u32,
    debug_same_instance_dynamic_collision_starts: u32,
    debug_fixed_collision_starts: u32,
    debug_parentless_static_collision_starts: u32,
    debug_dynamic_min_body_y: f32,
    debug_dynamic_min_body_instance_id: u32,
    debug_dynamic_min_body_speed_m_s: f32,
    debug_dynamic_min_body_linvel_y: f32,
    debug_dynamic_min_body_has_support: u32,
    debug_dynamic_min_body_active_contact_pairs: u32,
    debug_dynamic_min_body_same_instance_fixed_contact_pairs: u32,
    debug_dynamic_min_body_parentless_static_contact_pairs: u32,
    debug_current_max_body_speed_m_s: f32,
    debug_current_max_body_speed_instance_id: u32,
    debug_dynamic_min_body_x: f32,
    debug_dynamic_min_body_z: f32,
    debug_dynamic_min_body_max_local_offset_m: f32,
    debug_dynamic_min_body_ccd_enabled: u32,
    pre_step_motion: HashMap<RigidBodyHandle, BodyMotionSnapshot>,
    recent_external_impacts: HashMap<ImpactCooldownKey, f32>,
    debug_contact_events_seen_total: u32,
    debug_contact_events_matching_total: u32,
    debug_contact_events_other_destructible_skipped_total: u32,
    debug_contact_events_below_impulse_skipped_total: u32,
    debug_contact_events_missing_partner_body_skipped_total: u32,
    debug_contact_events_below_speed_skipped_total: u32,
    debug_contact_events_missing_body_or_node_skipped_total: u32,
    debug_contact_events_accepted_total: u32,
    debug_contact_events_max_raw_impulse_ns: f32,
    debug_contact_events_max_partner_speed_m_s: f32,
    debug_contact_events_collision_grace_overrides_total: u32,
    debug_contact_events_cooldown_skipped_total: u32,
    debug_contact_events_force_capped_total: u32,
}

impl DestructibleRegistry {
    pub fn new() -> Self {
        Self::with_runtime_config(DestructibleRuntimeConfig::default())
    }

    pub fn with_runtime_config(runtime_config: DestructibleRuntimeConfig) -> Self {
        Self {
            runtime_config,
            instances: Vec::new(),
            id_to_index: HashMap::new(),
            transforms: Vec::new(),
            fracture_events: Vec::new(),
            sim_time_secs: 0.0,
            debug_impact_seq: 0,
            debug_impact_processed: 0,
            debug_impact_max_impulse_ns: 0.0,
            debug_impact_max_speed_m_s: 0.0,
            debug_impact_max_splash_nodes: 0,
            debug_impact_max_body_node_count: 0,
            debug_impact_max_splash_weight_sum: 0.0,
            debug_impact_max_estimated_injected_force_n: 0.0,
            debug_impact_instance_id: 0,
            debug_fracture_seq: 0,
            debug_fracture_instance_id: 0,
            debug_fracture_instance_body_count: 0,
            debug_fractures: 0,
            debug_split_events: 0,
            debug_new_bodies: 0,
            debug_active_bodies: 0,
            debug_post_fracture_max_body_speed_m_s: 0.0,
            debug_post_fracture_fast_body_count: 0,
            debug_same_instance_dynamic_collision_starts: 0,
            debug_fixed_collision_starts: 0,
            debug_parentless_static_collision_starts: 0,
            debug_dynamic_min_body_y: 0.0,
            debug_dynamic_min_body_instance_id: 0,
            debug_dynamic_min_body_speed_m_s: 0.0,
            debug_dynamic_min_body_linvel_y: 0.0,
            debug_dynamic_min_body_has_support: 0,
            debug_dynamic_min_body_active_contact_pairs: 0,
            debug_dynamic_min_body_same_instance_fixed_contact_pairs: 0,
            debug_dynamic_min_body_parentless_static_contact_pairs: 0,
            debug_current_max_body_speed_m_s: 0.0,
            debug_current_max_body_speed_instance_id: 0,
            debug_dynamic_min_body_x: 0.0,
            debug_dynamic_min_body_z: 0.0,
            debug_dynamic_min_body_max_local_offset_m: 0.0,
            debug_dynamic_min_body_ccd_enabled: 0,
            pre_step_motion: HashMap::new(),
            recent_external_impacts: HashMap::new(),
            debug_contact_events_seen_total: 0,
            debug_contact_events_matching_total: 0,
            debug_contact_events_other_destructible_skipped_total: 0,
            debug_contact_events_below_impulse_skipped_total: 0,
            debug_contact_events_missing_partner_body_skipped_total: 0,
            debug_contact_events_below_speed_skipped_total: 0,
            debug_contact_events_missing_body_or_node_skipped_total: 0,
            debug_contact_events_accepted_total: 0,
            debug_contact_events_max_raw_impulse_ns: 0.0,
            debug_contact_events_max_partner_speed_m_s: 0.0,
            debug_contact_events_collision_grace_overrides_total: 0,
            debug_contact_events_cooldown_skipped_total: 0,
            debug_contact_events_force_capped_total: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.instances.len()
    }

    pub fn is_empty(&self) -> bool {
        self.instances.is_empty()
    }

    pub fn total_chunk_count(&self) -> usize {
        self.instances.iter().map(|i| i.chunk_count()).sum()
    }

    pub fn debug_state_slice(&self) -> [f64; 48] {
        [
            self.debug_impact_seq as f64,
            self.debug_impact_processed as f64,
            self.debug_impact_max_impulse_ns as f64,
            self.debug_impact_max_speed_m_s as f64,
            self.debug_impact_max_splash_nodes as f64,
            self.debug_impact_max_body_node_count as f64,
            self.debug_impact_max_splash_weight_sum as f64,
            self.debug_impact_max_estimated_injected_force_n as f64,
            self.debug_impact_instance_id as f64,
            self.debug_fracture_seq as f64,
            self.debug_fracture_instance_id as f64,
            self.debug_fracture_instance_body_count as f64,
            self.debug_fractures as f64,
            self.debug_split_events as f64,
            self.debug_new_bodies as f64,
            self.debug_active_bodies as f64,
            self.debug_post_fracture_max_body_speed_m_s as f64,
            self.debug_post_fracture_fast_body_count as f64,
            self.debug_same_instance_dynamic_collision_starts as f64,
            self.debug_fixed_collision_starts as f64,
            self.debug_dynamic_min_body_y as f64,
            self.debug_parentless_static_collision_starts as f64,
            self.debug_dynamic_min_body_instance_id as f64,
            self.debug_dynamic_min_body_speed_m_s as f64,
            self.debug_dynamic_min_body_linvel_y as f64,
            self.debug_dynamic_min_body_has_support as f64,
            self.debug_dynamic_min_body_active_contact_pairs as f64,
            self.debug_dynamic_min_body_same_instance_fixed_contact_pairs as f64,
            self.debug_dynamic_min_body_parentless_static_contact_pairs as f64,
            self.debug_current_max_body_speed_m_s as f64,
            self.debug_current_max_body_speed_instance_id as f64,
            self.debug_dynamic_min_body_x as f64,
            self.debug_dynamic_min_body_z as f64,
            self.debug_dynamic_min_body_max_local_offset_m as f64,
            self.debug_dynamic_min_body_ccd_enabled as f64,
            self.debug_contact_events_seen_total as f64,
            self.debug_contact_events_matching_total as f64,
            self.debug_contact_events_other_destructible_skipped_total as f64,
            self.debug_contact_events_below_impulse_skipped_total as f64,
            self.debug_contact_events_missing_partner_body_skipped_total as f64,
            self.debug_contact_events_below_speed_skipped_total as f64,
            self.debug_contact_events_missing_body_or_node_skipped_total as f64,
            self.debug_contact_events_accepted_total as f64,
            self.debug_contact_events_max_raw_impulse_ns as f64,
            self.debug_contact_events_max_partner_speed_m_s as f64,
            self.debug_contact_events_collision_grace_overrides_total as f64,
            self.debug_contact_events_cooldown_skipped_total as f64,
            self.debug_contact_events_force_capped_total as f64,
        ]
    }

    pub fn debug_config_slice(&self) -> [f64; 13] {
        let policy = configured_fracture_policy();
        let debris_collision_mode = configured_debris_collision_mode();
        [
            CONTACT_SPLASH_RADIUS as f64,
            CONTACT_FORCE_SCALE as f64,
            MIN_IMPACT_IMPULSE_NS as f64,
            MIN_IMPACT_SPEED_M_S as f64,
            0.0,
            self.runtime_config.wall_material_scale as f64,
            self.runtime_config.tower_material_scale as f64,
            policy.max_fractures_per_frame as f64,
            policy.max_new_bodies_per_frame as f64,
            if policy.apply_excess_forces { 1.0 } else { 0.0 },
            match debris_collision_mode {
                DebrisCollisionMode::All => 0.0,
                DebrisCollisionMode::NoDebrisPairs => 1.0,
                DebrisCollisionMode::DebrisGroundOnly => 2.0,
                DebrisCollisionMode::DebrisNone => 3.0,
            },
            IMPACT_COOLDOWN_SECS as f64,
            MAX_INJECTED_IMPACT_FORCE_N as f64,
        ]
    }

    pub fn get(&self, id: u32) -> Option<&DestructibleInstance> {
        self.id_to_index
            .get(&id)
            .and_then(|idx| self.instances.get(*idx))
    }

    fn instance_body_handles(instance: &DestructibleInstance) -> HashSet<RigidBodyHandle> {
        let mut seen = HashSet::new();
        for node_index in 0..instance.node_count {
            if let Some(handle) = instance.set.node_body(node_index) {
                seen.insert(handle);
            }
        }
        seen
    }

    pub fn debug_body_handles(&self) -> HashSet<RigidBodyHandle> {
        let mut handles = HashSet::new();
        for instance in &self.instances {
            handles.extend(Self::instance_body_handles(instance));
        }
        handles
    }

    fn sanitize_body_colliders(sim: &mut SimWorld, body_handle: RigidBodyHandle) {
        let collider_handles = sim
            .rigid_bodies
            .get(body_handle)
            .map(|rb| rb.colliders().to_vec())
            .unwrap_or_default();
        for collider_handle in collider_handles {
            let Some(collider) = sim.colliders.get_mut(collider_handle) else {
                continue;
            };
            // Blast enables pair-filter hooks so callers can inject custom
            // Rapier `PhysicsHooks`. vibe-land runs the default `&()` hooks,
            // so keeping these bits set can silently discard contacts in
            // practice mode even though the chunk AABBs look correct.
            let filtered_hooks = collider.active_hooks()
                & !(ActiveHooks::FILTER_CONTACT_PAIRS | ActiveHooks::FILTER_INTERSECTION_PAIR);
            collider.set_active_hooks(filtered_hooks);
            collider.set_active_events(collider.active_events() | ActiveEvents::COLLISION_EVENTS);
        }
    }

    fn sanitize_instance_colliders(instance: &DestructibleInstance, sim: &mut SimWorld) {
        for body_handle in Self::instance_body_handles(instance) {
            Self::sanitize_body_colliders(sim, body_handle);
        }
    }

    fn active_contact_stats_for_body(
        instance: &DestructibleInstance,
        body_handle: RigidBodyHandle,
        sim: &SimWorld,
    ) -> (u32, u32, u32) {
        let Some(body) = sim.rigid_bodies.get(body_handle) else {
            return (0, 0, 0);
        };
        let mut seen_other_colliders = HashSet::new();
        let mut active_contact_pairs = 0u32;
        let mut same_instance_fixed_contact_pairs = 0u32;
        let mut parentless_static_contact_pairs = 0u32;
        for collider_handle in body.colliders() {
            for pair in sim.narrow_phase.contact_pairs_with(*collider_handle) {
                if !pair.has_any_active_contact {
                    continue;
                }
                let other_collider = if pair.collider1 == *collider_handle {
                    pair.collider2
                } else {
                    pair.collider1
                };
                if !seen_other_colliders.insert(other_collider) {
                    continue;
                }
                active_contact_pairs += 1;
                let other_parent = sim.colliders.get(other_collider).and_then(|c| c.parent());
                if other_parent.is_none() {
                    parentless_static_contact_pairs += 1;
                    continue;
                }
                let Some(other_body) = other_parent else {
                    continue;
                };
                let other_is_fixed = sim
                    .rigid_bodies
                    .get(other_body)
                    .map(|body| body.is_fixed())
                    .unwrap_or(false);
                if other_is_fixed && instance.set.collider_node(other_collider).is_some() {
                    same_instance_fixed_contact_pairs += 1;
                }
            }
        }
        (
            active_contact_pairs,
            same_instance_fixed_contact_pairs,
            parentless_static_contact_pairs,
        )
    }

    fn max_local_offset_for_body(
        instance: &DestructibleInstance,
        body_handle: RigidBodyHandle,
    ) -> f32 {
        instance
            .set
            .body_nodes_slice(body_handle)
            .iter()
            .filter_map(|node| instance.set.node_local_offset(*node))
            .map(|offset| (offset.x * offset.x + offset.y * offset.y + offset.z * offset.z).sqrt())
            .fold(0.0_f32, f32::max)
    }

    fn find_instance_node_by_collider(&self, collider: ColliderHandle) -> Option<(usize, u32)> {
        for (idx, inst) in self.instances.iter().enumerate() {
            if let Some(node_index) = inst.set.collider_node(collider) {
                return Some((idx, node_index));
            }
        }
        None
    }

    pub fn begin_physics_step(&mut self, sim: &SimWorld) {
        self.pre_step_motion.clear();
        self.pre_step_motion
            .extend(sim.rigid_bodies.iter().map(|(handle, body)| {
                (
                    handle,
                    BodyMotionSnapshot {
                        position: *body.position(),
                        linvel: *body.linvel(),
                        angvel: *body.angvel(),
                    },
                )
            }));
    }

    fn motion_velocity_at_point(
        snapshot: &BodyMotionSnapshot,
        world_point: Point3<f32>,
    ) -> Vector3<f32> {
        let offset = world_point.coords - snapshot.position.translation.vector;
        snapshot.linvel + snapshot.angvel.cross(&offset)
    }

    fn contact_geometry(
        pair: &ContactPair,
        target_collider: ColliderHandle,
        target_is_second: bool,
        dt: f32,
        sim: &SimWorld,
    ) -> Option<(Point3<f32>, Vector3<f32>, f32)> {
        let total_impulse = pair.total_impulse();
        let total_impulse_mag = pair.total_impulse_magnitude();
        if total_impulse_mag <= 1.0e-6 {
            return None;
        }

        let (manifold, contact) = pair.find_deepest_contact()?;
        let target_local_point = if target_is_second {
            contact.local_p2
        } else {
            contact.local_p1
        };
        let collider = sim.colliders.get(target_collider)?;
        let world_point = collider.position() * target_local_point;
        let force_world = if target_is_second {
            total_impulse / dt
        } else {
            -total_impulse / dt
        };
        let force_world = if force_world.norm_squared() > 1.0e-12 {
            force_world
        } else {
            let normal = if target_is_second {
                manifold.data.normal
            } else {
                -manifold.data.normal
            };
            normal * (total_impulse_mag / dt)
        };
        Some((world_point, force_world, total_impulse_mag))
    }

    fn closing_speed(
        &self,
        world_point: Point3<f32>,
        force_world: Vector3<f32>,
        target_body: RigidBodyHandle,
        other_body: RigidBodyHandle,
        sim: &SimWorld,
    ) -> f32 {
        if let (Some(target_motion), Some(other_motion)) = (
            self.pre_step_motion.get(&target_body),
            self.pre_step_motion.get(&other_body),
        ) {
            let target_velocity = Self::motion_velocity_at_point(target_motion, world_point);
            let other_velocity = Self::motion_velocity_at_point(other_motion, world_point);
            return relative_speed_along_force(force_world, other_velocity - target_velocity);
        }

        let Some(target_rb) = sim.rigid_bodies.get(target_body) else {
            return 0.0;
        };
        let Some(other_rb) = sim.rigid_bodies.get(other_body) else {
            return 0.0;
        };
        let target_velocity = target_rb.velocity_at_point(&world_point);
        let other_velocity = other_rb.velocity_at_point(&world_point);
        relative_speed_along_force(force_world, other_velocity - target_velocity)
    }

    /// Spawn a wall at the given pose.  Returns `true` on success.
    pub fn spawn_wall(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = match build_authored_wall_scenario() {
            Ok(scenario) => scenario,
            Err(error) => {
                dlog(&format!("[destructibles] {error}"));
                return false;
            }
        };
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Wall,
            pose,
            scenario,
            self.runtime_config.wall_material_scale,
        )
    }

    /// Spawn a tower at the given pose.  Returns `true` on success.
    pub fn spawn_tower(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = match build_authored_tower_scenario() {
            Ok(scenario) => scenario,
            Err(error) => {
                dlog(&format!("[destructibles] {error}"));
                return false;
            }
        };
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Tower,
            pose,
            scenario,
            self.runtime_config.tower_material_scale,
        )
    }

    fn spawn_scenario(
        &mut self,
        sim: &mut SimWorld,
        id: u32,
        kind: DestructibleKind,
        pose: Isometry3<f32>,
        scenario: blast_stress_solver::types::ScenarioDesc,
        material_scale: f32,
    ) -> bool {
        if self.id_to_index.contains_key(&id) {
            return false;
        }
        let gravity = BlastVec3::new(0.0, -9.81, 0.0);
        let settings = scaled_solver_settings(material_scale);
        let policy = configured_fracture_policy();
        let debris_collision_mode = configured_debris_collision_mode();

        let Some(mut set) = DestructibleSet::from_scenario(&scenario, settings, gravity, policy)
        else {
            return false;
        };
        // Pin debris to full self-collision so split chunks continue to
        // collide with one another even if the upstream crate's default
        // changes.
        set.set_debris_collision_mode(debris_collision_mode);
        // Pin the split-body behaviour we rely on even if upstream
        // defaults shift: keep fitted child motion, but leave CCD off
        // for debris because the chunk counts here are high and the
        // impact path is already rate-limited.
        set.set_dynamic_body_ccd_enabled(false);
        set.set_split_child_recentering_enabled(true);
        set.set_split_child_velocity_fit_enabled(true);
        // Scenarios are built at origin — after creating the bodies we
        // transform each of them by `pose` so the whole structure ends up
        // at the requested world position/rotation.
        let handles = set.initialize(&mut sim.rigid_bodies, &mut sim.colliders);

        // Blast's scenario builders construct everything at the origin.
        // Translate every owning body into the requested world pose, and
        // wake dynamic bodies so gravity / impact analysis take effect
        // immediately. Also opt every chunk collider into collision
        // events so support-contact tracking sees fixed/support starts.
        for handle in &handles {
            let collider_handles: Vec<ColliderHandle> = {
                let Some(rb) = sim.rigid_bodies.get_mut(*handle) else {
                    continue;
                };
                let local = *rb.position();
                let world = pose * local;
                rb.set_position(world, false);
                if matches!(rb.body_type(), RigidBodyType::Dynamic) {
                    rb.wake_up(true);
                }
                rb.colliders().to_vec()
            };
            for ch in collider_handles {
                if let Some(col) = sim.colliders.get_mut(ch) {
                    let events = col.active_events() | ActiveEvents::COLLISION_EVENTS;
                    col.set_active_events(events);
                }
            }
            Self::sanitize_body_colliders(sim, *handle);
        }

        // Propagate the body positions to collider world poses so that the
        // transform buffer and any same-tick shape-cast queries see the
        // correct positions.
        //
        // DO NOT call sync_broad_phase() here.  sync_broad_phase discards
        // the BroadPhasePairEvent::AddPair events it generates, which
        // pre-registers all adjacent chunk pairs in broad_phase.pairs as
        // Occupied.  Once Occupied, those pairs never emit a new AddPair
        // event — so narrow_phase.register_pairs never receives them and
        // no inter-chunk contact constraints are ever created.
        //
        // Instead, rely on the first pipeline.step() to process Rapier's
        // internal colliders.modified_colliders list (populated by
        // insert_with_parent above).  The pipeline forwards AddPair events
        // to the narrow phase via register_pairs, correctly establishing
        // contact graph edges between adjacent chunks.  After fracture,
        // reparented colliders have ColliderChanges::PARENT set, which
        // causes compute_contacts to re-evaluate their edges with the new
        // (different) parent bodies and resolve the inter-chunk contacts.
        sim.rigid_bodies
            .propagate_modified_body_positions_to_colliders(&mut sim.colliders);

        let node_count = set.solver().node_count();
        let handle_count = handles.len();
        let index = self.instances.len();
        self.id_to_index.insert(id, index);
        self.instances.push(DestructibleInstance {
            id,
            kind,
            pose,
            set,
            node_count,
            transforms: Vec::new(),
        });
        // Build initial transforms immediately so that chunk_transforms_slice()
        // returns non-empty data right after spawn, before the first step() call.
        // This is needed because the JS side may read chunk transforms to build
        // the initial snapshot before the first physics tick fires.
        let initial_transforms = {
            let inst = self.instances.last().unwrap();
            let mut ts = Vec::with_capacity(inst.node_count as usize * CHUNK_TRANSFORM_STRIDE);
            for node_index in 0..inst.node_count {
                let chunk_index = node_index;
                let Some(body_handle) = inst.set.node_body(node_index) else {
                    ts.extend_from_slice(&[
                        inst.id as f32,
                        chunk_index as f32,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0, // present = 0
                        0.0, // pad
                    ]);
                    continue;
                };
                let Some(rb) = sim.rigid_bodies.get(body_handle) else {
                    continue;
                };
                let (wx, wy, wz, ri, rj, rk, rw) = match inst
                    .set
                    .node_collider(node_index)
                    .and_then(|ch| sim.colliders.get(ch))
                {
                    Some(col) => {
                        let p = col.position();
                        (
                            p.translation.vector.x,
                            p.translation.vector.y,
                            p.translation.vector.z,
                            p.rotation.i,
                            p.rotation.j,
                            p.rotation.k,
                            p.rotation.w,
                        )
                    }
                    None => {
                        let off = inst
                            .set
                            .node_local_offset(node_index)
                            .unwrap_or(BlastVec3::new(0.0, 0.0, 0.0));
                        let iso = rb.position();
                        let lp = nalgebra::Point3::new(off.x, off.y, off.z);
                        let wp = iso.transform_point(&lp);
                        (
                            wp.x,
                            wp.y,
                            wp.z,
                            iso.rotation.i,
                            iso.rotation.j,
                            iso.rotation.k,
                            iso.rotation.w,
                        )
                    }
                };
                ts.extend_from_slice(&[
                    inst.id as f32,
                    chunk_index as f32,
                    wx,
                    wy,
                    wz,
                    ri,
                    rj,
                    rk,
                    rw,
                    1.0, // present
                    0.0, // pad
                ]);
            }
            ts
        };
        self.transforms.extend_from_slice(&initial_transforms);
        self.instances.last_mut().unwrap().transforms = initial_transforms;
        dlog(&format!(
            "[destructibles] spawn id={} kind={:?} nodes={} bodies={} pose=({:.2},{:.2},{:.2})",
            id,
            kind,
            node_count,
            handle_count,
            pose.translation.x,
            pose.translation.y,
            pose.translation.z,
        ));
        true
    }

    /// Remove a destructible and free all of its chunk bodies in `SimWorld`.
    pub fn despawn(
        &mut self,
        sim: &mut SimWorld,
        impulse_joints: &mut ImpulseJointSet,
        multibody_joints: &mut MultibodyJointSet,
        id: u32,
    ) -> bool {
        let Some(index) = self.id_to_index.remove(&id) else {
            return false;
        };
        let instance = self.instances.swap_remove(index);
        // Fix up the id_to_index for the instance that was swapped into
        // this slot.
        if index < self.instances.len() {
            let moved_id = self.instances[index].id;
            self.id_to_index.insert(moved_id, index);
        }
        // Collect every unique body currently owning a node — after
        // fractures the nodes may span more bodies than we initialized
        // with, and the tracker's node→body map is authoritative.
        let seen_bodies = Self::instance_body_handles(&instance);
        for handle in &seen_bodies {
            sim.rigid_bodies.remove(
                *handle,
                &mut sim.island_manager,
                &mut sim.colliders,
                impulse_joints,
                multibody_joints,
                true,
            );
        }
        true
    }

    /// Current monotonic sim clock in seconds — incremented every
    /// [`DestructibleRegistry::step`] by the fixed tick `dt`
    /// (`1.0 / 60.0`).  Public so
    /// [`crate::wasm_api::WasmSimWorld::step_vehicle_pipeline`] can pass
    /// a consistent timestamp into
    /// [`DestructibleRegistry::drain_collision_events`] before calling
    /// `step`.
    pub fn sim_time_secs(&self) -> f32 {
        self.sim_time_secs
    }

    /// Advance every destructible one tick, updating chunk transforms and
    /// the fracture event queue.  Must be called after any input-driven
    /// contacts have been applied (i.e. after `step_vehicle_pipeline`).
    pub fn step(
        &mut self,
        sim: &mut SimWorld,
        impulse_joints: &mut ImpulseJointSet,
        multibody_joints: &mut MultibodyJointSet,
    ) {
        const DEBUG_FAST_CHUNK_SPEED_M_S: f32 = 8.0;
        // Fixed sim tick — Rapier default integration uses 1/60s and
        // `step_vehicle_dynamics` substeps from there.  Keeping this in
        // sync keeps the support-contact staleness heuristic well-tuned.
        const FIXED_DT: f32 = 1.0 / 60.0;
        self.sim_time_secs += FIXED_DT;
        self.transforms.clear();
        let mut dynamic_min_body_y = f32::INFINITY;
        let mut dynamic_min_body_instance_id = 0u32;
        let mut dynamic_min_body_ref: Option<(usize, RigidBodyHandle)> = None;
        let mut current_max_body_speed_m_s = 0.0_f32;
        let mut current_max_body_speed_instance_id = 0u32;
        let mut fracture_instance_id = 0u32;
        let mut fracture_instance_body_count = 0u32;
        let mut total_fractures = 0u32;
        let mut total_split_events = 0u32;
        let mut total_new_bodies = 0u32;

        for (inst_idx, instance) in self.instances.iter_mut().enumerate() {
            let step_result = instance.set.step(
                &mut sim.rigid_bodies,
                &mut sim.colliders,
                &mut sim.island_manager,
                impulse_joints,
                multibody_joints,
            );
            Self::sanitize_instance_colliders(instance, sim);

            // After a split, propagate new body poses into collider world
            // positions so the transform buffer is correct for the current
            // tick. Do NOT call sync_broad_phase here: PhysicsPipeline::step
            // runs BEFORE destructibles.step(), so the physics step for this
            // tick is already complete. Calling sync_broad_phase would consume
            // Rapier's internal new-collider event queue and discard the
            // AddPair events, preventing the narrow phase from creating
            // chunk-chunk contact pairs. The next pipeline.step() naturally
            // detects the new colliders and propagates those pairs correctly.
            if step_result.split_events > 0 || step_result.new_bodies > 0 {
                sim.rigid_bodies
                    .propagate_modified_body_positions_to_colliders(&mut sim.colliders);
            }

            if step_result.fractures > 0 || step_result.split_events > 0 {
                fracture_instance_id = instance.id;
                fracture_instance_body_count = Self::instance_body_handles(instance).len() as u32;
                total_fractures += step_result.fractures as u32;
                total_split_events += step_result.split_events as u32;
                total_new_bodies += step_result.new_bodies as u32;
                // Emit a single (destructibleId, fractureCount) event per
                // frame so the client can play feedback without parsing
                // the full split cohort list.
                self.fracture_events.push(instance.id);
                self.fracture_events.push(step_result.fractures as u32);
                dlog(&format!(
                    "[destructibles] FRACTURE id={} kind={:?} fractures={} splits={} new_bodies={} body_count={} wall_scale={:.2} tower_scale={:.2}",
                    instance.id,
                    instance.kind,
                    step_result.fractures,
                    step_result.split_events,
                    step_result.new_bodies,
                    Self::instance_body_handles(instance).len(),
                    self.runtime_config.wall_material_scale,
                    self.runtime_config.tower_material_scale,
                ));
            }

            // Rebuild the per-instance transforms buffer.  We iterate
            // nodes in stable node-index order so chunk indices stay
            // consistent across frames (chunk_index == node_index).
            // World-space pose = owning_body.pose() * local_offset.
            instance.transforms.clear();
            for node_index in 0..instance.node_count {
                let chunk_index = node_index;
                let Some(handle) = instance.set.node_body(node_index) else {
                    // Node has no owning body (destroyed / debris cleaned up).
                    // Emit a placeholder row with `present=0` so the client
                    // can preserve stable chunk indexing while hiding it.
                    instance.transforms.extend_from_slice(&[
                        instance.id as f32,
                        chunk_index as f32,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0, // present
                        0.0, // pad
                    ]);
                    continue;
                };
                let Some(rb) = sim.rigid_bodies.get(handle) else {
                    continue;
                };
                if rb.is_dynamic() {
                    if rb.translation().y < dynamic_min_body_y {
                        dynamic_min_body_y = rb.translation().y;
                        dynamic_min_body_instance_id = instance.id;
                        dynamic_min_body_ref = Some((inst_idx, handle));
                    }
                    let speed = rb.linvel().norm();
                    if speed > current_max_body_speed_m_s {
                        current_max_body_speed_m_s = speed;
                        current_max_body_speed_instance_id = instance.id;
                    }
                }
                let (world_point, rot) = if let Some(collider_handle) =
                    instance.set.node_collider(node_index)
                {
                    if let Some(collider) = sim.colliders.get(collider_handle) {
                        let pose = collider.position();
                        (
                            nalgebra::Point3::new(
                                pose.translation.vector.x,
                                pose.translation.vector.y,
                                pose.translation.vector.z,
                            ),
                            pose.rotation,
                        )
                    } else {
                        let local_offset = instance
                            .set
                            .node_local_offset(node_index)
                            .unwrap_or(BlastVec3::new(0.0, 0.0, 0.0));
                        let body_iso = rb.position();
                        let local_point =
                            nalgebra::Point3::new(local_offset.x, local_offset.y, local_offset.z);
                        (body_iso.transform_point(&local_point), body_iso.rotation)
                    }
                } else {
                    let local_offset = instance
                        .set
                        .node_local_offset(node_index)
                        .unwrap_or(BlastVec3::new(0.0, 0.0, 0.0));
                    let body_iso = rb.position();
                    let local_point =
                        nalgebra::Point3::new(local_offset.x, local_offset.y, local_offset.z);
                    (body_iso.transform_point(&local_point), body_iso.rotation)
                };
                instance.transforms.extend_from_slice(&[
                    instance.id as f32,
                    chunk_index as f32,
                    world_point.x,
                    world_point.y,
                    world_point.z,
                    rot.i,
                    rot.j,
                    rot.k,
                    rot.w,
                    1.0, // present
                    // Bit 0: 1.0 if the owning rigid body is dynamic (post-fracture
                    // debris), 0.0 if fixed (support anchor embedded in terrain).
                    // Used by client spatial metrics to exclude fixed support nodes
                    // from lowestChunkBottomY so anchor nodes intentionally below
                    // ground do not cause the debris-floor check to fail.
                    if rb.is_dynamic() { 1.0 } else { 0.0 },
                ]);
            }
            self.transforms.extend_from_slice(&instance.transforms);

            // Mark chunk colliders as user-modified so the next pipeline.step()
            // includes them in broad_phase.update().
            //
            // Rapier's broad phase only processes user-modified colliders.
            // After the first tick following fracture, newly dynamic chunk
            // bodies are no longer in modified_bodies, so their colliders
            // drop out of local_modified and broad_phase.update() stops
            // checking them for new overlapping pairs.  Upper-row chunks that
            // start high above the ground never receive an AddPair(chunk, ground)
            // event and therefore fall through the floor.
            //
            // Calling get_mut() (which calls ColliderSet::push_once internally)
            // marks the collider with ColliderChanges::MODIFIED and adds it to
            // ColliderSet::modified_colliders.  At the start of the next
            // pipeline.step(), colliders.take_modified() picks these up, they
            // enter local_modified, broad_phase.update() tests their AABBs
            // against the BVH, and once the chunk's AABB reaches the ground
            // AABB an AddPair event fires — permanently registering the pair in
            // the contact graph so the narrow phase can compute contact forces.
            //
            // On split ticks, fixed (support) bodies are also marked: the
            // body_tracker repositions them from their old multi-node centroid
            // to the support-node centroid, but propagate_modified_body_positions_to_colliders
            // updates only world positions without adding colliders to
            // modified_colliders.  The broad phase therefore keeps stale BVH
            // entries for the support colliders, so dynamic chunks fall through
            // them instead of landing on top.  Marking support colliders on the
            // split tick forces one BVH refresh and permanently registers the
            // correct contact pairs.
            let had_split = step_result.split_events > 0 || step_result.new_bodies > 0;
            for node_index in 0..instance.node_count {
                let Some(body_handle) = instance.set.node_body(node_index) else {
                    continue;
                };
                let Some(rb) = sim.rigid_bodies.get(body_handle) else {
                    continue;
                };
                let skip = if rb.is_dynamic() {
                    rb.is_sleeping()
                } else {
                    // Fixed bodies: only refresh on split ticks (they were repositioned).
                    !had_split
                };
                if skip {
                    continue;
                }
                if let Some(ch) = instance.set.node_collider(node_index) {
                    sim.colliders.get_mut(ch);
                }
            }
        }
        if total_fractures > 0 || total_split_events > 0 || total_new_bodies > 0 {
            let mut post_fracture_max_body_speed_m_s = 0.0_f32;
            let mut post_fracture_fast_body_count = 0u32;
            for instance in &self.instances {
                for body_handle in Self::instance_body_handles(instance) {
                    let Some(body) = sim.rigid_bodies.get(body_handle) else {
                        continue;
                    };
                    if !body.is_dynamic() {
                        continue;
                    }
                    let speed = body.linvel().norm();
                    post_fracture_max_body_speed_m_s = post_fracture_max_body_speed_m_s.max(speed);
                    if speed >= DEBUG_FAST_CHUNK_SPEED_M_S {
                        post_fracture_fast_body_count += 1;
                    }
                }
            }
            self.debug_fracture_seq = self.debug_fracture_seq.wrapping_add(1);
            self.debug_fracture_instance_id = fracture_instance_id;
            self.debug_fracture_instance_body_count = fracture_instance_body_count;
            self.debug_fractures = total_fractures;
            self.debug_split_events = total_split_events;
            self.debug_new_bodies = total_new_bodies;
            self.debug_active_bodies = self
                .instances
                .iter()
                .map(|instance| Self::instance_body_handles(instance).len() as u32)
                .sum();
            self.debug_post_fracture_max_body_speed_m_s = post_fracture_max_body_speed_m_s;
            self.debug_post_fracture_fast_body_count = post_fracture_fast_body_count;
        }
        self.debug_dynamic_min_body_y = if dynamic_min_body_y.is_finite() {
            dynamic_min_body_y
        } else {
            0.0
        };
        self.debug_dynamic_min_body_instance_id = dynamic_min_body_instance_id;
        if let Some((inst_idx, body_handle)) = dynamic_min_body_ref {
            let instance = &self.instances[inst_idx];
            if let Some(body) = sim.rigid_bodies.get(body_handle) {
                let (
                    active_contact_pairs,
                    same_instance_fixed_contact_pairs,
                    parentless_static_contact_pairs,
                ) = Self::active_contact_stats_for_body(instance, body_handle, sim);
                self.debug_dynamic_min_body_speed_m_s = body.linvel().norm();
                self.debug_dynamic_min_body_linvel_y = body.linvel().y;
                self.debug_dynamic_min_body_has_support =
                    u32::from(instance.set.body_has_support(body_handle));
                self.debug_dynamic_min_body_active_contact_pairs = active_contact_pairs;
                self.debug_dynamic_min_body_same_instance_fixed_contact_pairs =
                    same_instance_fixed_contact_pairs;
                self.debug_dynamic_min_body_parentless_static_contact_pairs =
                    parentless_static_contact_pairs;
                self.debug_dynamic_min_body_x = body.translation().x;
                self.debug_dynamic_min_body_z = body.translation().z;
                self.debug_dynamic_min_body_max_local_offset_m =
                    Self::max_local_offset_for_body(instance, body_handle);
                self.debug_dynamic_min_body_ccd_enabled = u32::from(body.is_ccd_enabled());
            }
        } else {
            self.debug_dynamic_min_body_speed_m_s = 0.0;
            self.debug_dynamic_min_body_linvel_y = 0.0;
            self.debug_dynamic_min_body_has_support = 0;
            self.debug_dynamic_min_body_active_contact_pairs = 0;
            self.debug_dynamic_min_body_same_instance_fixed_contact_pairs = 0;
            self.debug_dynamic_min_body_parentless_static_contact_pairs = 0;
            self.debug_dynamic_min_body_x = 0.0;
            self.debug_dynamic_min_body_z = 0.0;
            self.debug_dynamic_min_body_max_local_offset_m = 0.0;
            self.debug_dynamic_min_body_ccd_enabled = 0;
        }
        self.debug_current_max_body_speed_m_s = current_max_body_speed_m_s;
        self.debug_current_max_body_speed_instance_id = current_max_body_speed_instance_id;
    }

    /// Analyze Rapier contact pairs after the rigid-body step and inject
    /// accepted external impacts into the owning `DestructibleSet`s as
    /// localized stress loads.
    ///
    /// This mirrors the newer `blast-stress-solver` runtime more closely
    /// than the old `ContactForceEvent` path: impacts are measured from
    /// per-pair total impulse and closing speed at the deepest contact
    /// point, then localized across sibling nodes with the splash kernel.
    pub fn drain_contact_impacts(&mut self, sim: &SimWorld, dt: f32) {
        let dt = dt.max(1.0e-6);
        let mut processed = 0usize;
        let mut max_impulse_ns = 0.0_f32;
        let mut max_speed_m_s = 0.0_f32;
        let mut max_splash_nodes = 0usize;
        let mut max_body_node_count = 0u32;
        let mut max_splash_weight_sum = 0.0_f32;
        let mut max_estimated_injected_force_n = 0.0_f32;
        let mut impact_instance_id = 0u32;

        self.recent_external_impacts
            .retain(|_, started_at| self.sim_time_secs - *started_at <= IMPACT_COOLDOWN_SECS);

        for pair in sim.narrow_phase.contact_pairs() {
            self.debug_contact_events_seen_total =
                self.debug_contact_events_seen_total.saturating_add(1);
            if !pair.has_any_active_contact {
                continue;
            }

            let Some(collider1) = sim.colliders.get(pair.collider1) else {
                continue;
            };
            let Some(collider2) = sim.colliders.get(pair.collider2) else {
                continue;
            };
            let Some(body1) = collider1.parent() else {
                continue;
            };
            let Some(body2) = collider2.parent() else {
                continue;
            };

            let node1 = self.find_instance_node_by_collider(pair.collider1);
            let node2 = self.find_instance_node_by_collider(pair.collider2);
            if node1.is_none() && node2.is_none() {
                continue;
            }

            if let Some((inst_idx, node_index)) = node1 {
                self.debug_contact_events_matching_total =
                    self.debug_contact_events_matching_total.saturating_add(1);
                if node2.is_some() {
                    self.debug_contact_events_other_destructible_skipped_total = self
                        .debug_contact_events_other_destructible_skipped_total
                        .saturating_add(1);
                } else if let Some((world_point, force_world, total_impulse_ns)) =
                    Self::contact_geometry(pair, pair.collider1, false, dt, sim)
                {
                    max_impulse_ns = max_impulse_ns.max(total_impulse_ns);
                    self.debug_contact_events_max_raw_impulse_ns = self
                        .debug_contact_events_max_raw_impulse_ns
                        .max(total_impulse_ns);
                    let closing_speed =
                        self.closing_speed(world_point, force_world, body1, body2, sim);
                    self.debug_contact_events_max_partner_speed_m_s = self
                        .debug_contact_events_max_partner_speed_m_s
                        .max(closing_speed);
                    if total_impulse_ns < MIN_IMPACT_IMPULSE_NS {
                        self.debug_contact_events_below_impulse_skipped_total = self
                            .debug_contact_events_below_impulse_skipped_total
                            .saturating_add(1);
                    } else if closing_speed < MIN_IMPACT_SPEED_M_S {
                        self.debug_contact_events_below_speed_skipped_total = self
                            .debug_contact_events_below_speed_skipped_total
                            .saturating_add(1);
                    } else if let Some(pair_key) = canonical_body_pair_key(body1, body2) {
                        let impact_key = ImpactCooldownKey {
                            pair: pair_key,
                            target_body: BodyKey::from(body1),
                        };
                        if let Some(last_impact_at) = self.recent_external_impacts.get(&impact_key)
                        {
                            if self.sim_time_secs - *last_impact_at <= IMPACT_COOLDOWN_SECS {
                                self.debug_contact_events_cooldown_skipped_total = self
                                    .debug_contact_events_cooldown_skipped_total
                                    .saturating_add(1);
                                continue;
                            }
                        }
                        let Some(target_rb) = sim.rigid_bodies.get(body1) else {
                            self.debug_contact_events_missing_partner_body_skipped_total = self
                                .debug_contact_events_missing_partner_body_skipped_total
                                .saturating_add(1);
                            continue;
                        };
                        let local_point_na =
                            target_rb.position().inverse_transform_point(&world_point);
                        let local_force_na = target_rb.position().rotation.inverse() * force_world;
                        let mut local_force = local_force_na * CONTACT_FORCE_SCALE;
                        let local_force_mag = local_force.norm();
                        if local_force_mag > MAX_INJECTED_IMPACT_FORCE_N
                            && MAX_INJECTED_IMPACT_FORCE_N.is_finite()
                        {
                            local_force *= MAX_INJECTED_IMPACT_FORCE_N / local_force_mag;
                            self.debug_contact_events_force_capped_total = self
                                .debug_contact_events_force_capped_total
                                .saturating_add(1);
                        }
                        if local_force.norm_squared() <= 1.0e-12 {
                            continue;
                        }

                        let inst = &mut self.instances[inst_idx];
                        let Some(body_handle) = inst.set.node_body(node_index) else {
                            self.debug_contact_events_missing_body_or_node_skipped_total = self
                                .debug_contact_events_missing_body_or_node_skipped_total
                                .saturating_add(1);
                            continue;
                        };
                        let hit_local =
                            BlastVec3::new(local_point_na.x, local_point_na.y, local_point_na.z);
                        let body_nodes: Vec<u32> = inst.set.body_nodes_slice(body_handle).to_vec();
                        let mut splash: Vec<(u32, BlastVec3, f32)> =
                            Vec::with_capacity(body_nodes.len());
                        for &other_node in &body_nodes {
                            let Some(other_local) = inst.set.node_local_offset(other_node) else {
                                continue;
                            };
                            let dx = other_local.x - hit_local.x;
                            let dy = other_local.y - hit_local.y;
                            let dz = other_local.z - hit_local.z;
                            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                            if dist > CONTACT_SPLASH_RADIUS {
                                continue;
                            }
                            let falloff = if other_node == node_index {
                                1.0
                            } else {
                                let t = (1.0 - dist / CONTACT_SPLASH_RADIUS).max(0.0);
                                t * t
                            };
                            if falloff > 0.0 {
                                splash.push((other_node, other_local, falloff));
                            }
                        }
                        let splash_weight_sum: f32 =
                            splash.iter().map(|(_, _, falloff)| *falloff).sum();
                        let splash_scale = if splash_weight_sum > 0.0 {
                            1.0 / splash_weight_sum
                        } else {
                            0.0
                        };
                        let estimated_injected_force_n = local_force.norm();
                        max_speed_m_s = max_speed_m_s.max(closing_speed);
                        max_splash_nodes = max_splash_nodes.max(splash.len());
                        max_body_node_count = max_body_node_count.max(body_nodes.len() as u32);
                        max_splash_weight_sum = max_splash_weight_sum.max(splash_weight_sum);
                        max_estimated_injected_force_n =
                            max_estimated_injected_force_n.max(estimated_injected_force_n);
                        impact_instance_id = inst.id;
                        let local_force =
                            BlastVec3::new(local_force.x, local_force.y, local_force.z);
                        for (other_node, other_local, falloff) in splash {
                            let f = BlastVec3::new(
                                local_force.x * splash_scale * falloff,
                                local_force.y * splash_scale * falloff,
                                local_force.z * splash_scale * falloff,
                            );
                            inst.set.add_force(other_node, other_local, f);
                        }
                        self.recent_external_impacts
                            .insert(impact_key, self.sim_time_secs);
                        processed += 1;
                        self.debug_contact_events_accepted_total =
                            self.debug_contact_events_accepted_total.saturating_add(1);
                    }
                }
            }

            if let Some((inst_idx, node_index)) = node2 {
                self.debug_contact_events_matching_total =
                    self.debug_contact_events_matching_total.saturating_add(1);
                if node1.is_some() {
                    self.debug_contact_events_other_destructible_skipped_total = self
                        .debug_contact_events_other_destructible_skipped_total
                        .saturating_add(1);
                } else if let Some((world_point, force_world, total_impulse_ns)) =
                    Self::contact_geometry(pair, pair.collider2, true, dt, sim)
                {
                    max_impulse_ns = max_impulse_ns.max(total_impulse_ns);
                    self.debug_contact_events_max_raw_impulse_ns = self
                        .debug_contact_events_max_raw_impulse_ns
                        .max(total_impulse_ns);
                    let closing_speed =
                        self.closing_speed(world_point, force_world, body2, body1, sim);
                    self.debug_contact_events_max_partner_speed_m_s = self
                        .debug_contact_events_max_partner_speed_m_s
                        .max(closing_speed);
                    if total_impulse_ns < MIN_IMPACT_IMPULSE_NS {
                        self.debug_contact_events_below_impulse_skipped_total = self
                            .debug_contact_events_below_impulse_skipped_total
                            .saturating_add(1);
                    } else if closing_speed < MIN_IMPACT_SPEED_M_S {
                        self.debug_contact_events_below_speed_skipped_total = self
                            .debug_contact_events_below_speed_skipped_total
                            .saturating_add(1);
                    } else if let Some(pair_key) = canonical_body_pair_key(body1, body2) {
                        let impact_key = ImpactCooldownKey {
                            pair: pair_key,
                            target_body: BodyKey::from(body2),
                        };
                        if let Some(last_impact_at) = self.recent_external_impacts.get(&impact_key)
                        {
                            if self.sim_time_secs - *last_impact_at <= IMPACT_COOLDOWN_SECS {
                                self.debug_contact_events_cooldown_skipped_total = self
                                    .debug_contact_events_cooldown_skipped_total
                                    .saturating_add(1);
                                continue;
                            }
                        }
                        let Some(target_rb) = sim.rigid_bodies.get(body2) else {
                            self.debug_contact_events_missing_partner_body_skipped_total = self
                                .debug_contact_events_missing_partner_body_skipped_total
                                .saturating_add(1);
                            continue;
                        };
                        let local_point_na =
                            target_rb.position().inverse_transform_point(&world_point);
                        let local_force_na = target_rb.position().rotation.inverse() * force_world;
                        let mut local_force = local_force_na * CONTACT_FORCE_SCALE;
                        let local_force_mag = local_force.norm();
                        if local_force_mag > MAX_INJECTED_IMPACT_FORCE_N
                            && MAX_INJECTED_IMPACT_FORCE_N.is_finite()
                        {
                            local_force *= MAX_INJECTED_IMPACT_FORCE_N / local_force_mag;
                            self.debug_contact_events_force_capped_total = self
                                .debug_contact_events_force_capped_total
                                .saturating_add(1);
                        }
                        if local_force.norm_squared() <= 1.0e-12 {
                            continue;
                        }

                        let inst = &mut self.instances[inst_idx];
                        let Some(body_handle) = inst.set.node_body(node_index) else {
                            self.debug_contact_events_missing_body_or_node_skipped_total = self
                                .debug_contact_events_missing_body_or_node_skipped_total
                                .saturating_add(1);
                            continue;
                        };
                        let hit_local =
                            BlastVec3::new(local_point_na.x, local_point_na.y, local_point_na.z);
                        let body_nodes: Vec<u32> = inst.set.body_nodes_slice(body_handle).to_vec();
                        let mut splash: Vec<(u32, BlastVec3, f32)> =
                            Vec::with_capacity(body_nodes.len());
                        for &other_node in &body_nodes {
                            let Some(other_local) = inst.set.node_local_offset(other_node) else {
                                continue;
                            };
                            let dx = other_local.x - hit_local.x;
                            let dy = other_local.y - hit_local.y;
                            let dz = other_local.z - hit_local.z;
                            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                            if dist > CONTACT_SPLASH_RADIUS {
                                continue;
                            }
                            let falloff = if other_node == node_index {
                                1.0
                            } else {
                                let t = (1.0 - dist / CONTACT_SPLASH_RADIUS).max(0.0);
                                t * t
                            };
                            if falloff > 0.0 {
                                splash.push((other_node, other_local, falloff));
                            }
                        }
                        let splash_weight_sum: f32 =
                            splash.iter().map(|(_, _, falloff)| *falloff).sum();
                        let splash_scale = if splash_weight_sum > 0.0 {
                            1.0 / splash_weight_sum
                        } else {
                            0.0
                        };
                        let estimated_injected_force_n = local_force.norm();
                        max_speed_m_s = max_speed_m_s.max(closing_speed);
                        max_splash_nodes = max_splash_nodes.max(splash.len());
                        max_body_node_count = max_body_node_count.max(body_nodes.len() as u32);
                        max_splash_weight_sum = max_splash_weight_sum.max(splash_weight_sum);
                        max_estimated_injected_force_n =
                            max_estimated_injected_force_n.max(estimated_injected_force_n);
                        impact_instance_id = inst.id;
                        let local_force =
                            BlastVec3::new(local_force.x, local_force.y, local_force.z);
                        for (other_node, other_local, falloff) in splash {
                            let f = BlastVec3::new(
                                local_force.x * splash_scale * falloff,
                                local_force.y * splash_scale * falloff,
                                local_force.z * splash_scale * falloff,
                            );
                            inst.set.add_force(other_node, other_local, f);
                        }
                        self.recent_external_impacts
                            .insert(impact_key, self.sim_time_secs);
                        processed += 1;
                        self.debug_contact_events_accepted_total =
                            self.debug_contact_events_accepted_total.saturating_add(1);
                    }
                }
            }
        }

        if processed > 0 {
            self.debug_impact_seq = self.debug_impact_seq.wrapping_add(1);
            self.debug_impact_processed = processed as u32;
            self.debug_impact_max_impulse_ns = max_impulse_ns;
            self.debug_impact_max_speed_m_s = max_speed_m_s;
            self.debug_impact_max_splash_nodes = max_splash_nodes as u32;
            self.debug_impact_max_body_node_count = max_body_node_count;
            self.debug_impact_max_splash_weight_sum = max_splash_weight_sum;
            self.debug_impact_max_estimated_injected_force_n = max_estimated_injected_force_n;
            self.debug_impact_instance_id = impact_instance_id;
            dlog(&format!(
                "[destructibles] IMPACT accepted={} impact_seq={} inst={} raw_impulse_ns={:.1} partner_speed_m_s={:.2} injected_force_n={:.1} splash_nodes={} body_nodes={} splash_weight_sum={:.2} contact_seen/matching/accepted={}/{}/{} skipped_impulse/speed/cooldown/other/missing={}/{}/{}/{}/{} grace={} capped={} cooldown_secs={:.2} max_injected_force_n={:.1} wall_scale={:.2} tower_scale={:.2} solver_ref={:.1}@{:.1}x exp={:.1} wall_solver_scale={:.1} tower_solver_scale={:.1}",
                processed,
                self.debug_impact_seq,
                impact_instance_id,
                max_impulse_ns,
                max_speed_m_s,
                max_estimated_injected_force_n,
                max_splash_nodes,
                max_body_node_count,
                max_splash_weight_sum,
                self.debug_contact_events_seen_total,
                self.debug_contact_events_matching_total,
                self.debug_contact_events_accepted_total,
                self.debug_contact_events_below_impulse_skipped_total,
                self.debug_contact_events_below_speed_skipped_total,
                self.debug_contact_events_cooldown_skipped_total,
                self.debug_contact_events_other_destructible_skipped_total,
                self.debug_contact_events_missing_body_or_node_skipped_total
                    .saturating_add(self.debug_contact_events_missing_partner_body_skipped_total),
                self.debug_contact_events_collision_grace_overrides_total,
                self.debug_contact_events_force_capped_total,
                IMPACT_COOLDOWN_SECS,
                MAX_INJECTED_IMPACT_FORCE_N,
                self.runtime_config.wall_material_scale,
                self.runtime_config.tower_material_scale,
                SOLVER_MATERIAL_SCALE_REFERENCE,
                USER_MATERIAL_SCALE_REFERENCE,
                USER_TO_SOLVER_SCALE_EXPONENT,
                effective_solver_material_scale(self.runtime_config.wall_material_scale),
                effective_solver_material_scale(self.runtime_config.tower_material_scale),
            ));
        }
    }

    /// Drain pending Rapier `CollisionEvent`s and update the support-contact
    /// tracker in each `DestructibleSet`.  Mirrors `register_support_contact`
    /// + `drain_collision_events` in the demo (lines 3895–3966): when a
    /// chunk body touches a fixed / support body, call
    /// [`DestructibleSet::mark_body_support_contact`] so the stress solver
    /// knows it has a stable anchor and doesn't prematurely shed static
    /// chunks.
    ///
    /// Like `drain_contact_impacts`, must be called before
    /// [`step`](Self::step).
    pub fn drain_collision_events(
        &mut self,
        sim: &mut SimWorld,
        collision_rx: &std::sync::mpsc::Receiver<CollisionEvent>,
    ) {
        let mut same_instance_dynamic_collision_starts = 0u32;
        let mut fixed_collision_starts = 0u32;
        let mut parentless_static_collision_starts = 0u32;
        while let Ok(event) = collision_rx.try_recv() {
            let CollisionEvent::Started(c1, c2, flags) = event else {
                continue;
            };
            if flags.contains(CollisionEventFlags::SENSOR) {
                continue;
            }
            let c1_parent = sim.colliders.get(c1).and_then(|c| c.parent());
            let c2_parent = sim.colliders.get(c2).and_then(|c| c.parent());
            let c1_other_is_parentless_static = c2_parent.is_none()
                && sim
                    .colliders
                    .get(c2)
                    .map(|collider| !collider.is_sensor())
                    .unwrap_or(false);
            let c2_other_is_parentless_static = c1_parent.is_none()
                && sim
                    .colliders
                    .get(c1)
                    .map(|collider| !collider.is_sensor())
                    .unwrap_or(false);
            let c1_other_is_fixed = c2_parent
                .and_then(|h| sim.rigid_bodies.get(h))
                .map(|body| body.is_fixed())
                .unwrap_or(false);
            let c2_other_is_fixed = c1_parent
                .and_then(|h| sim.rigid_bodies.get(h))
                .map(|body| body.is_fixed())
                .unwrap_or(false);
            for inst in &self.instances {
                if inst.set.collider_node(c1).is_some() && c1_other_is_fixed {
                    fixed_collision_starts += 1;
                    break;
                }
                if inst.set.collider_node(c1).is_some() && c1_other_is_parentless_static {
                    parentless_static_collision_starts += 1;
                    break;
                }
                if inst.set.collider_node(c2).is_some() && c2_other_is_fixed {
                    fixed_collision_starts += 1;
                    break;
                }
                if inst.set.collider_node(c2).is_some() && c2_other_is_parentless_static {
                    parentless_static_collision_starts += 1;
                    break;
                }
                let Some(node1) = inst.set.collider_node(c1) else {
                    continue;
                };
                let Some(node2) = inst.set.collider_node(c2) else {
                    continue;
                };
                let Some(body1) = inst.set.node_body(node1) else {
                    break;
                };
                let Some(body2) = inst.set.node_body(node2) else {
                    break;
                };
                if body1 == body2 {
                    break;
                }
                let both_dynamic = sim
                    .rigid_bodies
                    .get(body1)
                    .map(|body| body.is_dynamic())
                    .unwrap_or(false)
                    && sim
                        .rigid_bodies
                        .get(body2)
                        .map(|body| body.is_dynamic())
                        .unwrap_or(false);
                if both_dynamic {
                    same_instance_dynamic_collision_starts += 1;
                }
                break;
            }
            self.register_support_contact(sim, c1, c2, self.sim_time_secs);
            self.register_support_contact(sim, c2, c1, self.sim_time_secs);
        }
        self.debug_same_instance_dynamic_collision_starts = same_instance_dynamic_collision_starts;
        self.debug_fixed_collision_starts = fixed_collision_starts;
        self.debug_parentless_static_collision_starts = parentless_static_collision_starts;
    }

    fn register_support_contact(
        &mut self,
        sim: &mut SimWorld,
        tracked_collider: ColliderHandle,
        other_collider: ColliderHandle,
        now_secs: f32,
    ) {
        // Find which instance owns `tracked_collider`.
        let mut inst_idx = None;
        let mut node_index = 0u32;
        for (idx, inst) in self.instances.iter().enumerate() {
            if let Some(n) = inst.set.collider_node(tracked_collider) {
                inst_idx = Some(idx);
                node_index = n;
                break;
            }
        }
        let Some(inst_idx) = inst_idx else {
            return;
        };
        let inst = &mut self.instances[inst_idx];
        if inst.set.is_support(node_index) {
            return;
        }
        let Some(body_handle) = inst.set.node_body(node_index) else {
            return;
        };
        // Resolve the other collider's parent and check whether it
        // qualifies as a support (fixed body, or already-supported
        // destructible chunk).
        let other_parent = match sim.colliders.get(other_collider).and_then(|c| c.parent()) {
            Some(p) if p != body_handle => p,
            _ => return,
        };
        let other_is_fixed = sim
            .rigid_bodies
            .get(other_parent)
            .map(|body| body.is_fixed())
            .unwrap_or(false);
        let other_is_support_node = inst
            .set
            .collider_node(other_collider)
            .map(|on| inst.set.is_support(on))
            .unwrap_or(false);
        let other_body_has_support = inst.set.body_has_support(other_parent);
        if !(other_is_fixed || other_is_support_node || other_body_has_support) {
            return;
        }
        inst.set.mark_body_support_contact(
            body_handle,
            now_secs,
            &mut sim.rigid_bodies,
            &mut sim.colliders,
        );
    }

    /// Current aggregated chunk transforms (stride =
    /// [`CHUNK_TRANSFORM_STRIDE`]).  Refreshed each [`step`](Self::step).
    pub fn chunk_transforms_slice(&self) -> &[f32] {
        &self.transforms
    }

    /// Drain all pending fracture events as a flat `[id, count, id, count, ...]`
    /// buffer.
    pub fn drain_fracture_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.fracture_events)
    }

    /// Diagnostic string describing every destructible instance:
    /// owning-body breakdown, collider count, collider membership/filter
    /// groups, active-hook flags, and world-space AABB.  Used by
    /// `usePrediction` to dump what the chunks actually look like to
    /// Rapier at load time so we can prove (or disprove) that they're
    /// reachable by the query pipeline + contact solver.
    pub fn describe(&self, sim: &SimWorld) -> String {
        use std::collections::HashSet;
        let mut out = String::new();
        for instance in &self.instances {
            let mut body_set: HashSet<RigidBodyHandle> = HashSet::new();
            for node_index in 0..instance.node_count {
                if let Some(h) = instance.set.node_body(node_index) {
                    body_set.insert(h);
                }
            }
            let mut dynamic_bodies = 0usize;
            let mut fixed_bodies = 0usize;
            let mut kinematic_bodies = 0usize;
            let mut collider_count = 0usize;
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            let mut sample_mem = 0u32;
            let mut sample_filter = 0u32;
            let mut sample_hooks = 0u32;
            let mut sampled = false;
            let mut sample_body_pos = [0.0f32; 3];
            for (i, bh) in body_set.iter().enumerate() {
                let Some(rb) = sim.rigid_bodies.get(*bh) else {
                    continue;
                };
                if i == 0 {
                    let t = rb.position().translation;
                    sample_body_pos = [t.x, t.y, t.z];
                }
                match rb.body_type() {
                    RigidBodyType::Dynamic => dynamic_bodies += 1,
                    RigidBodyType::Fixed => fixed_bodies += 1,
                    _ => kinematic_bodies += 1,
                }
                for ch in rb.colliders() {
                    if let Some(col) = sim.colliders.get(*ch) {
                        collider_count += 1;
                        let aabb = col.compute_aabb();
                        if aabb.mins.x < min[0] {
                            min[0] = aabb.mins.x;
                        }
                        if aabb.mins.y < min[1] {
                            min[1] = aabb.mins.y;
                        }
                        if aabb.mins.z < min[2] {
                            min[2] = aabb.mins.z;
                        }
                        if aabb.maxs.x > max[0] {
                            max[0] = aabb.maxs.x;
                        }
                        if aabb.maxs.y > max[1] {
                            max[1] = aabb.maxs.y;
                        }
                        if aabb.maxs.z > max[2] {
                            max[2] = aabb.maxs.z;
                        }
                        if !sampled {
                            sample_mem = col.collision_groups().memberships.bits();
                            sample_filter = col.collision_groups().filter.bits();
                            sample_hooks = col.active_hooks().bits();
                            sampled = true;
                        }
                    }
                }
            }
            out.push_str(&format!(
                "[destructibles] describe id={} kind={:?} bodies={}(dyn={},fix={},kin={}) bodyPos=({:.2},{:.2},{:.2}) colliders={} sampleGroups=mem=0x{:x},filter=0x{:x} hooks=0x{:x} aabb=({:.2},{:.2},{:.2})..({:.2},{:.2},{:.2})\n",
                instance.id,
                instance.kind,
                body_set.len(),
                dynamic_bodies,
                fixed_bodies,
                kinematic_bodies,
                sample_body_pos[0],
                sample_body_pos[1],
                sample_body_pos[2],
                collider_count,
                sample_mem,
                sample_filter,
                sample_hooks,
                min[0],
                min[1],
                min[2],
                max[0],
                max[1],
                max[2],
            ));
        }
        out
    }
}

impl Default for DestructibleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: build an [`Isometry3`] from a `[f32; 3]` position and a
/// `[f32; 4]` quaternion (x, y, z, w) as stored in
/// [`crate::world_document::DestructibleDoc`].
pub fn pose_from_world_doc(
    kind: crate::world_document::DestructibleKind,
    position: [f32; 3],
    rotation: [f32; 4],
) -> Isometry3<f32> {
    let solver_position = authored_position_to_solver_position(kind, position);
    let translation = Translation3::new(solver_position[0], solver_position[1], solver_position[2]);
    // Renormalize to guard against round-trip drift in the JSON → f32
    // pipeline — Blast's chunks are rigid, any non-unit quaternion here
    // shows up as a progressive scaling artifact.
    let q = Quaternion::new(rotation[3], rotation[0], rotation[1], rotation[2]);
    let unit = UnitQuaternion::from_quaternion(q);
    Isometry3::from_parts(translation, unit)
}

#[allow(dead_code)]
fn _assert_sync() {
    fn is_send<T: Send>() {}
    // DestructibleSet is not Send but that's fine — WasmSimWorld is
    // strictly single-threaded.  This function is just a placeholder to
    // document the constraint.
    is_send::<Vector3<f32>>();
}
