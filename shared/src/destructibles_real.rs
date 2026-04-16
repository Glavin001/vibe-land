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

use nalgebra::{Isometry3, Quaternion, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::{
    ActiveEvents, ActiveHooks, ColliderHandle, CollisionEvent, CollisionEventFlags,
    ContactForceEvent, ImpulseJointSet, MultibodyJointSet, RigidBodyHandle, RigidBodyType,
};
use wasm_bindgen::prelude::*;

use blast_stress_solver::rapier::{DestructibleSet, FracturePolicy};
use blast_stress_solver::scenarios::{
    build_tower_scenario, build_wall_scenario, TowerOptions, WallOptions,
};
use blast_stress_solver::types::{SolverSettings, Vec3 as BlastVec3};

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

/// Material softness used for vibe-land practice destructibles.
///
/// The upstream demo packs use a much larger material scale because
/// they are shot by very heavy projectiles. In vibe-land, copying that
/// value made car impacts stop fracturing entirely, so keep the local
/// practice tuning separate.
const WALL_MATERIAL_SCALE: f32 = 1.0;
const TOWER_MATERIAL_SCALE: f32 = 1.0;
const CONTACT_SPLASH_RADIUS: f32 = 2.0;
const CONTACT_FORCE_SCALE: f32 = 1.0;
const MIN_IMPACT_FORCE_N: f32 = 500.0;
const MIN_IMPACT_SPEED_M_S: f32 = 1.5;

/// Stride of [`DestructibleRegistry::chunk_transforms`] in `f32`s:
/// `[destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, active, _pad]`.
pub const CHUNK_TRANSFORM_STRIDE: usize = 11;

fn scaled_solver_settings(material_scale: f32) -> SolverSettings {
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

fn configured_fracture_policy() -> FracturePolicy {
    FracturePolicy {
        // Match the upstream wall/tower demo behavior. Leaving this enabled
        // produced post-split launches with absurd body speeds immediately
        // after fracture in practice mode.
        apply_excess_forces: false,
        ..FracturePolicy::default()
    }
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

/// Collection of all destructibles currently in the sim.
///
/// Uses a linear `Vec<DestructibleInstance>` keyed by stable `id` → index
/// so that `Vec` iteration stays cache friendly while lookups are O(n) for
/// the tiny populations we expect (<16 instances in practice).
pub struct DestructibleRegistry {
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
    debug_impact_max_force_n: f32,
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
}

impl DestructibleRegistry {
    pub fn new() -> Self {
        Self {
            instances: Vec::new(),
            id_to_index: HashMap::new(),
            transforms: Vec::new(),
            fracture_events: Vec::new(),
            sim_time_secs: 0.0,
            debug_impact_seq: 0,
            debug_impact_processed: 0,
            debug_impact_max_force_n: 0.0,
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

    pub fn debug_state_slice(&self) -> [f64; 35] {
        [
            self.debug_impact_seq as f64,
            self.debug_impact_processed as f64,
            self.debug_impact_max_force_n as f64,
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
        ]
    }

    pub fn debug_config_slice(&self) -> [f64; 9] {
        let policy = configured_fracture_policy();
        [
            CONTACT_SPLASH_RADIUS as f64,
            CONTACT_FORCE_SCALE as f64,
            MIN_IMPACT_FORCE_N as f64,
            MIN_IMPACT_SPEED_M_S as f64,
            WALL_MATERIAL_SCALE as f64,
            TOWER_MATERIAL_SCALE as f64,
            policy.max_fractures_per_frame as f64,
            policy.max_new_bodies_per_frame as f64,
            if policy.apply_excess_forces { 1.0 } else { 0.0 },
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
            collider.set_active_events(
                collider.active_events()
                    | ActiveEvents::CONTACT_FORCE_EVENTS
                    | ActiveEvents::COLLISION_EVENTS,
            );
            collider.set_contact_force_event_threshold(0.0);
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

    /// Spawn a wall at the given pose.  Returns `true` on success.
    pub fn spawn_wall(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = build_wall_scenario(&WallOptions::default());
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Wall,
            pose,
            scenario,
            WALL_MATERIAL_SCALE,
        )
    }

    /// Spawn a tower at the given pose.  Returns `true` on success.
    pub fn spawn_tower(&mut self, sim: &mut SimWorld, id: u32, pose: Isometry3<f32>) -> bool {
        let scenario = build_tower_scenario(&TowerOptions::default());
        self.spawn_scenario(
            sim,
            id,
            DestructibleKind::Tower,
            pose,
            scenario,
            TOWER_MATERIAL_SCALE,
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

        let Some(mut set) = DestructibleSet::from_scenario(&scenario, settings, gravity, policy)
        else {
            return false;
        };
        // Scenarios are built at origin — after creating the bodies we
        // transform each of them by `pose` so the whole structure ends up
        // at the requested world position/rotation.
        let handles = set.initialize(&mut sim.rigid_bodies, &mut sim.colliders);

        // Blast's scenario builders construct everything at the origin.
        // Translate every owning body into the requested world pose, and
        // wake dynamic bodies so gravity / contact forces take effect
        // immediately.  Also opt every chunk collider into
        // `CONTACT_FORCE_EVENTS` so vehicle / ball impacts reach the
        // stress solver via the drain in
        // `DestructibleRegistry::drain_contact_forces`.
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
                    let events = col.active_events() | ActiveEvents::CONTACT_FORCE_EVENTS;
                    col.set_active_events(events);
                    col.set_contact_force_event_threshold(0.0);
                }
            }
            Self::sanitize_body_colliders(sim, *handle);
        }

        // Rapier does *not* propagate a `set_position` on a body to its
        // attached colliders' world positions until the next
        // `pipeline.step()`.  vibe-land's KCC / broad-phase queries run
        // **before** the physics step on the same tick, so without this
        // explicit flush the freshly-spawned chunks remain at origin
        // inside the broad-phase BVH and the player capsule / vehicle /
        // ball walks straight through them.
        //
        // Fix: propagate the body positions to collider world poses,
        // mark every chunk collider as modified, and flush the
        // broad-phase BVH.
        sim.rigid_bodies
            .propagate_modified_body_positions_to_colliders(&mut sim.colliders);
        for handle in &handles {
            if let Some(rb) = sim.rigid_bodies.get(*handle) {
                for ch in rb.colliders() {
                    sim.modified_colliders.push(*ch);
                }
            }
        }
        sim.sync_broad_phase();

        let node_count = set.solver().node_count();
        let transforms_len = node_count as usize * CHUNK_TRANSFORM_STRIDE;
        let handle_count = handles.len();
        let index = self.instances.len();
        self.id_to_index.insert(id, index);
        self.instances.push(DestructibleInstance {
            id,
            kind,
            pose,
            set,
            node_count,
            transforms: vec![0.0; transforms_len],
        });
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

            // Fractures create brand-new rigid bodies + colliders via
            // Blast's split migrator.  Those bodies start out at the
            // correct world pose already (Blast carries the parent pose
            // forward into each child), but the newly-attached
            // colliders still need their AABBs pushed into the
            // broad-phase BVH so contacts with them land this tick.
            if step_result.split_events > 0 || step_result.new_bodies > 0 {
                sim.rigid_bodies
                    .propagate_modified_body_positions_to_colliders(&mut sim.colliders);
                let touched = Self::instance_body_handles(instance);
                for bh in touched {
                    if let Some(rb) = sim.rigid_bodies.get(bh) {
                        for ch in rb.colliders() {
                            sim.modified_colliders.push(*ch);
                        }
                    }
                }
                sim.sync_broad_phase();
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
                    "[destructibles] FRACTURE id={} fractures={} splits={}",
                    instance.id, step_result.fractures, step_result.split_events,
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
                    // Emit a row with active=0 so the client can hide it.
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
                        0.0, // active
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
                let local_offset = instance
                    .set
                    .node_local_offset(node_index)
                    .unwrap_or(BlastVec3::new(0.0, 0.0, 0.0));
                let body_iso = rb.position();
                let local_point =
                    nalgebra::Point3::new(local_offset.x, local_offset.y, local_offset.z);
                let world_point = body_iso.transform_point(&local_point);
                let rot = body_iso.rotation;
                let active = matches!(rb.body_type(), RigidBodyType::Dynamic) && !rb.is_sleeping();
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
                    if active { 1.0 } else { 0.0 },
                    0.0, // pad
                ]);
            }
            self.transforms.extend_from_slice(&instance.transforms);
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
                    post_fracture_max_body_speed_m_s =
                        post_fracture_max_body_speed_m_s.max(speed);
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

    /// Drain pending Rapier `ContactForceEvent`s and inject them into the
    /// appropriate `DestructibleSet` as stress loads via
    /// [`DestructibleSet::add_force`].
    ///
    /// This is how vehicle / ball impacts crack a wall or topple a tower
    /// — without it, walls only break from their own gravity.  The pattern
    /// here mirrors `drain_contact_forces` in
    /// `third_party/physx/blast/blast-stress-demo-rs/src/main.rs` (lines
    /// 3974–4092): for every event, find which destructible owns the
    /// collider, compute the impact force direction from the partner
    /// body's velocity, convert to the chunk body's local frame, and
    /// splash the force across sibling nodes within `SPLASH_RADIUS` using
    /// a quadratic `(1 - d/r)^2` falloff kernel.
    ///
    /// Must be called **before** [`step`](Self::step) so collider→node
    /// lookups still resolve against the pre-step handle map (fractures
    /// inside `step` can invalidate collider handles).
    pub fn drain_contact_forces(
        &mut self,
        sim: &SimWorld,
        contact_rx: &std::sync::mpsc::Receiver<ContactForceEvent>,
    ) {
        // Tuned for vibe-land practice mode (see tests in
        // `client/src/world/destructiblesPhysics.test.ts`). We now keep
        // the total injected stress equal to Rapier's measured contact
        // force and only use the splash kernel to distribute that force
        // across nearby sibling nodes. Earlier revisions multiplied the
        // full contact force across every hit sibling node and then
        // multiplied again by `CONTACT_FORCE_SCALE`, which the runtime
        // logs showed could inflate a ~20 kN bumper hit into >1 MN of
        // injected solver force and launch chunks through the ground.
        //
        // A threshold on `total_force_magnitude` cheaply filters out
        // normal-force resting contacts: a ~0.5 kg ball at rest produces
        // ~5 N, a ~1.5 t vehicle crash produces hundreds of kN, so a
        // 500 N cutoff cleanly separates the two.
        // Belt-and-braces: also require the partner body to be moving.
        // A settled vehicle idling against a wall would otherwise drip
        // stress in via `total_force_magnitude` from gravity on its
        // 1.5 t chassis.
        let mut processed = 0usize;
        let mut max_force_n = 0.0_f32;
        let mut max_speed_m_s = 0.0_f32;
        let mut max_splash_nodes = 0usize;
        let mut max_body_node_count = 0u32;
        let mut max_splash_weight_sum = 0.0_f32;
        let mut max_estimated_injected_force_n = 0.0_f32;
        let mut impact_instance_id = 0u32;
        while let Ok(event) = contact_rx.try_recv() {
            // Locate which destructible instance owns one of the two
            // colliders in the contact pair, and which collider is the
            // "partner" body driving the impact.
            let mut hit: Option<(usize, u32, ColliderHandle)> = None;
            for (idx, inst) in self.instances.iter().enumerate() {
                if let Some(n) = inst.set.collider_node(event.collider2) {
                    hit = Some((idx, n, event.collider1));
                    break;
                }
                if let Some(n) = inst.set.collider_node(event.collider1) {
                    hit = Some((idx, n, event.collider2));
                    break;
                }
            }
            let Some((inst_idx, node_index, other_collider)) = hit else {
                continue;
            };

            // The upstream demo only routes external projectile impacts
            // through contact-force injection. Re-injecting chunk-on-chunk
            // contacts creates a feedback loop after the first split:
            // debris collides, we feed that collision back into Blast as
            // fresh damage, and the structure "explodes" instead of
            // breaking apart.
            if self
                .instances
                .iter()
                .any(|inst| inst.set.collider_node(other_collider).is_some())
            {
                continue;
            }

            // Cheap force-magnitude gate up front: light bodies (balls,
            // player capsules) generate only a few newtons of contact
            // force even at running speed, which is well below the
            // threshold, so their stress is never routed to the solver.
            if event.total_force_magnitude < MIN_IMPACT_FORCE_N {
                continue;
            }

            // Resolve the partner rigid body and require it to be
            // moving meaningfully.  Static / near-stationary partners
            // (resting balls, settled player capsules) are ignored so
            // destructibles don't slowly disintegrate under their own
            // passengers.
            let partner_body_handle = sim.colliders.get(other_collider).and_then(|c| c.parent());
            let Some(partner_body) = partner_body_handle.and_then(|h| sim.rigid_bodies.get(h))
            else {
                continue;
            };
            let partner_linvel = *partner_body.linvel();
            let partner_speed_sq = partner_linvel.norm_squared();
            if partner_speed_sq < MIN_IMPACT_SPEED_M_S * MIN_IMPACT_SPEED_M_S {
                continue;
            }
            let direction = partner_linvel / partner_speed_sq.sqrt();

            let force_world = direction * event.total_force_magnitude;
            let impact_force_n = event.total_force_magnitude;
            let impact_speed_m_s = partner_speed_sq.sqrt();
            let impact_inst_id = self.instances[inst_idx].id;

            let inst = &mut self.instances[inst_idx];
            let Some(body_handle) = inst.set.node_body(node_index) else {
                continue;
            };
            let Some(body) = sim.rigid_bodies.get(body_handle) else {
                continue;
            };
            // Convert force into the body's local frame — the solver
            // expects forces in the same frame as `node_local_offset`.
            let rotation = body.position().rotation;
            let local_force_nalgebra = rotation.inverse() * force_world;
            let local_force = BlastVec3::new(
                local_force_nalgebra.x,
                local_force_nalgebra.y,
                local_force_nalgebra.z,
            );
            let Some(hit_local) = inst.set.node_local_offset(node_index) else {
                continue;
            };

            // Collect sibling nodes + falloff weights up front so we
            // don't re-borrow `inst` mutably while iterating.
            let body_nodes: Vec<u32> = inst.set.body_nodes_slice(body_handle).to_vec();
            let mut splash: Vec<(u32, BlastVec3, f32)> = Vec::with_capacity(body_nodes.len());
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
                if falloff <= 0.0 {
                    continue;
                }
                splash.push((other_node, other_local, falloff));
            }
            let splash_weight_sum: f32 = splash.iter().map(|(_, _, falloff)| *falloff).sum();
            let splash_scale = if splash_weight_sum > 0.0 {
                CONTACT_FORCE_SCALE / splash_weight_sum
            } else {
                0.0
            };
            let estimated_injected_force_n = impact_force_n * CONTACT_FORCE_SCALE;
            max_force_n = max_force_n.max(impact_force_n);
            max_speed_m_s = max_speed_m_s.max(impact_speed_m_s);
            max_splash_nodes = max_splash_nodes.max(splash.len());
            max_body_node_count = max_body_node_count.max(body_nodes.len() as u32);
            max_splash_weight_sum = max_splash_weight_sum.max(splash_weight_sum);
            max_estimated_injected_force_n =
                max_estimated_injected_force_n.max(estimated_injected_force_n);
            impact_instance_id = impact_inst_id;
            for (other_node, other_local, falloff) in splash {
                let f = BlastVec3::new(
                    local_force.x * splash_scale * falloff,
                    local_force.y * splash_scale * falloff,
                    local_force.z * splash_scale * falloff,
                );
                inst.set.add_force(other_node, other_local, f);
            }
            processed += 1;
        }
        if processed > 0 {
            self.debug_impact_seq = self.debug_impact_seq.wrapping_add(1);
            self.debug_impact_processed = processed as u32;
            self.debug_impact_max_force_n = max_force_n;
            self.debug_impact_max_speed_m_s = max_speed_m_s;
            self.debug_impact_max_splash_nodes = max_splash_nodes as u32;
            self.debug_impact_max_body_node_count = max_body_node_count;
            self.debug_impact_max_splash_weight_sum = max_splash_weight_sum;
            self.debug_impact_max_estimated_injected_force_n = max_estimated_injected_force_n;
            self.debug_impact_instance_id = impact_instance_id;
            dlog(&format!(
                "[destructibles] drain_contact_forces processed={}",
                processed
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
    /// Like `drain_contact_forces`, must be called before
    /// [`step`](Self::step).
    pub fn drain_collision_events(
        &mut self,
        sim: &mut SimWorld,
        collision_rx: &std::sync::mpsc::Receiver<CollisionEvent>,
    ) {
        let now = self.sim_time_secs;
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
            self.register_support_contact(sim, c1, c2, now);
            self.register_support_contact(sim, c2, c1, now);
        }
        self.debug_same_instance_dynamic_collision_starts =
            same_instance_dynamic_collision_starts;
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
pub fn pose_from_world_doc(position: [f32; 3], rotation: [f32; 4]) -> Isometry3<f32> {
    let translation = Translation3::new(position[0], position[1], position[2]);
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
