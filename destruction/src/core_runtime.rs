//! `/city` destruction driven by the standardized blast-stress-solver core.
//!
//! The existing [`crate::runtime::CityDestruction`] talks to
//! `ExtStressPhysXDestructible` through a bespoke C++ layer that this crate
//! maintains: snapshot diffing to recover events, hand-rolled island serials,
//! a copied thread pool, a private id bit-layout. All of that is destruction
//! logic living in an application.
//!
//! This drives the same scene through the library's engine-neutral pipeline
//! instead. The library owns split planning, the rigid-motion fit and the
//! topology edit; this module owns only what an application should: which
//! scene to load, where to put it, and handing events onward.
//!
//! It attaches to the PxScene the game already owns — players, vehicles and the
//! city share one scene — so the library borrows rather than creating a second
//! world. It never steps that scene; the game's own loop does.

use std::path::Path;

use blast_stress_solver::backend::PhysicsBackend;
use blast_stress_solver::backends::PhysXWorld;
use blast_stress_solver::ids::{IdLayout, DEFAULT_LAYOUT};
use blast_stress_solver::pipeline::{
    DestructibleConfig, DestructibleSet, DestructionEvent, IslandSerial, StepReport, StructureId,
};
use blast_stress_solver::scenarios::load_scenario_file;
use blast_stress_solver::types::Vec3 as CoreVec3;
use vibe_netcode::destruction_backend::{
    DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent, ShapeMigration,
};

/// Errors that keep the core path from starting.
#[derive(Debug)]
pub enum CoreRuntimeError {
    /// The host scene pointers were null or unusable.
    SceneUnavailable,
    /// The scene pack could not be read or parsed.
    Scene(String),
    /// The backend does not satisfy the core's required contract.
    Contract(String),
    /// The structure could not be instantiated in the scene.
    Attach,
}

impl std::fmt::Display for CoreRuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SceneUnavailable => write!(f, "host PhysX scene unavailable"),
            Self::Scene(e) => write!(f, "scene pack: {e}"),
            Self::Contract(e) => write!(f, "backend contract: {e}"),
            Self::Attach => write!(f, "failed to attach the structure to the scene"),
        }
    }
}

impl std::error::Error for CoreRuntimeError {}

/// One destructible structure running on the library core inside the host scene.
pub struct CoreCityDestruction {
    backend: PhysXWorld,
    set: DestructibleSet<PhysXWorld>,
    layout: IdLayout,
    ticks: u64,
    totals: Totals,
}

/// Island serials wider than the wire's field.
///
/// Reported rather than truncated. Truncating aliases a new island onto a live
/// one, so the client draws two chunk sets with a single pose -- silent, and
/// indistinguishable from a physics bug. See `blast_stress_solver::ids`.
#[derive(Clone, Copy, Debug, Default)]
pub struct IdOverflow {
    pub islands: u64,
    pub chunks: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Totals {
    pub fractures: usize,
    pub splits: usize,
    pub bodies_created: usize,
    pub bodies_retired: usize,
    /// Writes the adapter skipped because the value was already current.
    /// A collapse here is the early warning that a tuning pass has started
    /// waking sleeping bodies for nothing.
    pub writes_elided: usize,
}

impl CoreCityDestruction {
    /// Attach to a scene the host owns.
    ///
    /// `scene` and `physics` come from `World::scene_ptr()` / `physics_ptr()`.
    ///
    /// # Safety
    /// Both must be live PhysX pointers that outlive this object.
    pub unsafe fn attach(
        scene: usize,
        physics: usize,
        scene_pack: &Path,
        gravity: [f32; 3],
    ) -> Result<Self, CoreRuntimeError> {
        if scene == 0 || physics == 0 {
            return Err(CoreRuntimeError::SceneUnavailable);
        }
        let mut backend = PhysXWorld::attach_scene(
            scene as *mut std::ffi::c_void,
            physics as *mut std::ffi::c_void,
            std::ptr::null_mut(),
        )
        .ok_or(CoreRuntimeError::SceneUnavailable)?;

        // Fail here, naming what is missing, rather than three layers deeper.
        backend.check().map_err(|e| CoreRuntimeError::Contract(e.to_string()))?;

        let loaded =
            load_scenario_file(scene_pack).map_err(CoreRuntimeError::Scene)?;
        let cfg = DestructibleConfig {
            gravity: CoreVec3::new(gravity[0], gravity[1], gravity[2]),
            solver: loaded.settings,
            ..Default::default()
        };
        let mut set = DestructibleSet::new();
        set.attach(&mut backend, StructureId(0), &loaded.scenario, cfg)
            .map_err(|_| CoreRuntimeError::Attach)?;

        Ok(Self {
            backend,
            set,
            layout: DEFAULT_LAYOUT,
            ticks: 0,
            totals: Totals::default(),
        })
    }

    /// Add another structure at a world pose. The set shares one backend and
    /// therefore one PxScene, which is what makes a multi-building city one
    /// simulation rather than N isolated ones.
    pub fn attach_structure(
        &mut self,
        structure_id: u32,
        scene_pack: &Path,
        world_position: [f32; 3],
        gravity: [f32; 3],
    ) -> Result<(), CoreRuntimeError> {
        assert!(
            structure_id < self.layout.max_structures(),
            "structure {structure_id} exceeds the id space"
        );
        let loaded = load_scenario_file(scene_pack).map_err(CoreRuntimeError::Scene)?;
        let mut cfg = DestructibleConfig {
            gravity: CoreVec3::new(gravity[0], gravity[1], gravity[2]),
            solver: loaded.settings,
            ..Default::default()
        };
        cfg.world_pose.translation =
            CoreVec3::new(world_position[0], world_position[1], world_position[2]);
        self.set
            .attach(&mut self.backend, StructureId(structure_id), &loaded.scenario, cfg)
            .map_err(|_| CoreRuntimeError::Attach)
    }

    /// Advance the destruction solve. Call **after** the host has stepped its
    /// own scene, exactly like the existing runtime's `post_step`.
    pub fn post_step(&mut self, dt: f32) -> StepReport {
        self.ticks += 1;
        // Injected contact impulses are converted to force with this dt.
        self.backend.note_dt(dt);
        let r = self.set.step(&mut self.backend, dt);
        self.totals.fractures += r.fractures;
        self.totals.splits += r.split_events;
        self.totals.bodies_created += r.bodies_created;
        self.totals.bodies_retired += r.bodies_retired;
        self.totals.writes_elided += r.writes_elided;
        StepReport {
            fractures: r.fractures,
            bond_damage_events: r.bond_damage_events,
            split_events: r.split_events,
            bodies_created: r.bodies_created,
            shapes_reparented: r.shapes_reparented,
            bodies_retired: r.bodies_retired,
            writes_elided: r.writes_elided,
            converged: true,
        }
    }

    /// Step, then hand netcode exactly what it already consumes.
    ///
    /// This is the whole point of the migration. The existing path reconstructs
    /// this output by diffing snapshots of the PhysX scene -- an O(bonds) scan
    /// per tick over 74k bonds, in ~500 lines, to rediscover facts the split
    /// path already knew. Here the pipeline emits them and this function only
    /// renames fields.
    ///
    /// Nothing in netcode changes. It is handed the same
    /// [`DestructionTickOutput`] it was before.
    pub fn post_step_output(&mut self, dt: f32) -> (StepReport, DestructionTickOutput, IdOverflow) {
        let report = self.post_step(dt);
        let mut overflow = IdOverflow::default();

        // Sampled once, before draining, so a settle record carries the pose
        // the body actually came to rest at rather than one a later event moved.
        let mut pose_of: std::collections::HashMap<(u32, u64), ([f32; 3], [f32; 4])> =
            std::collections::HashMap::new();
        for (sid, m) in self.set.island_poses(&self.backend) {
            pose_of.insert(
                (sid.0, m.serial.0),
                (
                    [m.pose.translation.x, m.pose.translation.y, m.pose.translation.z],
                    [m.pose.rotation.x, m.pose.rotation.y, m.pose.rotation.z, m.pose.rotation.w],
                ),
            );
        }

        let layout = self.layout;
        let mut batches: Vec<FractureBatch> = Vec::new();
        let mut settled: Vec<SettleEvent> = Vec::new();
        let mut wakes: Vec<(u32, u32)> = Vec::new();

        // Serials are per-structure and the wire field is 22 bits. Anything
        // wider is dropped and counted, never truncated: truncation aliases a
        // fresh island onto a live one and the client draws both with one pose.
        let mut serial = |s: IslandSerial, overflow: &mut IdOverflow| -> Option<u32> {
            // NONE is a sentinel, not a wide serial. Counting it as an overflow
            // would report one "lost id" per chunk at attach -- 204 on the
            // reference tower -- and bury a real overflow in the noise.
            if s == IslandSerial::NONE {
                return None;
            }
            if layout.serial_fits(s.0) {
                Some(s.0 as u32)
            } else {
                overflow.islands += 1;
                None
            }
        };

        for (sid, event) in self.set.drain_events() {
            let structure_id = sid.0;
            // One batch per structure, appended in the order structures first
            // appear, so each structure's events stay contiguous and in causal
            // order -- the ordering the stream guarantees.
            let idx = match batches.iter().position(|b| b.structure_id == structure_id) {
                Some(i) => i,
                None => {
                    batches.push(FractureBatch {
                        structure_id,
                        ..FractureBatch::default()
                    });
                    batches.len() - 1
                }
            };
            let batch = &mut batches[idx];

            match event {
                DestructionEvent::BondBroken { bond, .. } => {
                    if bond < layout.max_bonds_per_structure() {
                        batch.broken_bond_ids.push(layout.bond_id(structure_id, bond));
                    } else {
                        overflow.chunks += 1;
                    }
                }
                DestructionEvent::ChunkMigrated { chunk, from, to } => {
                    // `from == NONE` is initial placement at attach, not a
                    // migration. The client gets that from the manifest, and
                    // putting it on the wire would send the entire structure
                    // as migrations on the first tick.
                    if from == IslandSerial::NONE {
                        continue;
                    }
                    let (Some(from_island_id), Some(to_island_id)) =
                        (serial(from, &mut overflow), serial(to, &mut overflow))
                    else {
                        continue;
                    };
                    batch.migrations.push(ShapeMigration {
                        chunk_id: layout.chunk_id(structure_id, chunk),
                        from_island_id,
                        to_island_id,
                    });
                }
                DestructionEvent::IslandPromoted {
                    serial: s,
                    pose,
                    linvel,
                    angvel,
                    mass,
                    members,
                    ..
                } => {
                    let Some(island_id) = serial(s, &mut overflow) else { continue };
                    batch.promoted_islands.push(IslandPromotion {
                        structure_id,
                        island_id,
                        chunks: members
                            .iter()
                            .map(|m| layout.chunk_id(structure_id, m.chunk))
                            .collect(),
                        mass,
                        // The pipeline emits COM-frame poses, which is exactly
                        // the convention this field documents as one "backends
                        // must normalise to, not one they get for free".
                        center_of_mass: [pose.translation.x, pose.translation.y, pose.translation.z],
                        position: [pose.translation.x, pose.translation.y, pose.translation.z],
                        rotation: [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w],
                        linear_velocity: [linvel.x, linvel.y, linvel.z],
                        angular_velocity: [angvel.x, angvel.y, angvel.z],
                        // Left zero deliberately. The pipeline does not compute
                        // an inertia tensor or a split impulse, and a fabricated
                        // value is worse than an absent one -- it is a confident
                        // wrong answer. Neither field has a consumer today.
                        inertia_diagonal: [0.0; 3],
                        split_impulse: [0.0; 3],
                    });
                }
                DestructionEvent::IslandRecomposed { serial: s, .. } => {
                    // No wire equivalent: the client rebuilds membership from
                    // migrations and the manifest's rest poses. Recording the
                    // COM shift would need a wire change, which is out of scope
                    // here -- and the migrations that accompany it already tell
                    // the client which chunks moved.
                    let _ = s;
                }
                DestructionEvent::IslandRetired { serial: s } => {
                    if let Some(id) = serial(s, &mut overflow) {
                        batch.retired_island_ids.push(id);
                    }
                }
                DestructionEvent::IslandSettled { serial: s } => {
                    let Some(island_id) = serial(s, &mut overflow) else { continue };
                    let (position, rotation) =
                        pose_of.get(&(structure_id, s.0)).copied().unwrap_or_default();
                    settled.push(SettleEvent { structure_id, island_id, position, rotation });
                }
                DestructionEvent::IslandWoke { serial: s } => {
                    if let Some(id) = serial(s, &mut overflow) {
                        wakes.push((structure_id, id));
                    }
                }
                DestructionEvent::ChunkDestroyed { .. } => {
                    // Crush is not in the core pipeline, so this is never
                    // emitted. Matched explicitly so that when it starts being
                    // emitted, this arm is the thing that has to be written
                    // rather than a wildcard silently swallowing it.
                }
            }
        }

        // Empty batches carry no information and cost wire space.
        batches.retain(|b| {
            !b.broken_bond_ids.is_empty()
                || !b.migrations.is_empty()
                || !b.promoted_islands.is_empty()
                || !b.retired_island_ids.is_empty()
        });

        (report, DestructionTickOutput { batches, settled, wakes }, overflow)
    }

    /// Route one contact from the host's own `onContact`.
    ///
    /// The host keeps its simulation-event callback; PhysX allows only one, and
    /// the game already has players and vehicles on it.
    ///
    /// # Safety
    /// Shape pointers must be live `PxShape*` values from the host scene.
    pub unsafe fn route_contact(
        &mut self,
        shape_a: usize,
        shape_b: usize,
        position: [f32; 3],
        normal: [f32; 3],
        relative_velocity: [f32; 3],
        impulse_magnitude: f32,
        persisting: bool,
    ) -> bool {
        self.backend.inject_contact(
            shape_a as *mut std::ffi::c_void,
            shape_b as *mut std::ffi::c_void,
            CoreVec3::new(position[0], position[1], position[2]),
            CoreVec3::new(normal[0], normal[1], normal[2]),
            CoreVec3::new(relative_velocity[0], relative_velocity[1], relative_velocity[2]),
            impulse_magnitude,
            persisting,
        )
    }

    /// Nearest load-bearing node to a world point — the hitscan/blast lookup.
    ///
    /// Support nodes are skipped: they are world-anchored, so a load aimed at
    /// one is absorbed and nothing ever breaks.
    pub fn nearest_node(&self, world_point: [f32; 3]) -> Option<u32> {
        self.set.iter().find_map(|(_, d)| {
            d.nearest_dynamic_node(CoreVec3::new(world_point[0], world_point[1], world_point[2]))
        })
    }

    /// Drive a load into the stress graph at a node — the hitscan/blast path.
    pub fn apply_force_at_node(&mut self, node: u32, world_point: [f32; 3], force: [f32; 3]) {
        let Some(d) = self.set.get_mut(StructureId(0)) else { return };
        d.add_force(
            node,
            CoreVec3::new(world_point[0], world_point[1], world_point[2]),
            CoreVec3::new(force[0], force[1], force[2]),
        );
    }

    pub fn ticks(&self) -> u64 {
        self.ticks
    }
    pub fn totals(&self) -> Totals {
        self.totals
    }
    /// Live actor count from the solver — the structure's fragmentation.
    pub fn actor_count(&self) -> u32 {
        self.set.actor_count()
    }
    /// Bodies the library manages. Must equal `actor_count`.
    pub fn body_count(&self) -> usize {
        self.set.body_count()
    }
    pub fn gpu_active(&self) -> bool {
        self.backend.gpu_active()
    }
}
