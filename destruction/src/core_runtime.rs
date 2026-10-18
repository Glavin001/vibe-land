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

use blast_stress_solver::backends::PhysXWorld;
use blast_stress_solver::ids::{IdLayout, DEFAULT_LAYOUT, SUPPORT_ISLAND_SERIAL};
use blast_stress_solver::pipeline::{
    DestructibleConfig, DestructibleSet, DestructionEvent, IslandSerial, StepReport, StructureId,
};
use blast_stress_solver::scenarios::load_scenario_file;
use blast_stress_solver::types::Vec3 as CoreVec3;
use crate::encoder::BodySnapshotInput;
use vibe_netcode::destruction_backend::{
    DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent, ShapeMigration,
};

/// Street width left between building footprints.
///
/// Not decoration: with the facades touching, PhysX depenetrates them and the
/// weak infill shears on the first tick, so the city demolishes itself before
/// anyone fires a shot.
const CITY_STREET_CLEARANCE_M: f32 = 6.0;

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
    /// Sleep/wake edges seen in the current tick, so `body_snapshots` can carry
    /// them as flags. Cleared at the start of every `post_step_output`.
    settled_this_tick: std::collections::HashSet<u32>,
    woke_this_tick: std::collections::HashSet<u32>,
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
            settled_this_tick: std::collections::HashSet::new(),
            woke_this_tick: std::collections::HashSet::new(),
            ticks: 0,
            totals: Totals::default(),
        })
    }

    /// Build the whole city grid, the way `/city` actually ships it.
    ///
    /// One scene pack becomes a variant ladder (truncated at floor boundaries)
    /// laid out on a square grid, every building its own structure in one
    /// `DestructibleSet` sharing one PxScene. That last part is what makes a
    /// city one simulation rather than N isolated ones -- debris from one tower
    /// lands on its neighbour.
    ///
    /// The grid pitch is derived from the pack's own footprint rather than
    /// hardcoded. At the C++ demo's fixed 18 m the high-rise's facades touch,
    /// PhysX depenetrates them, the weak infill shears on tick one, and the
    /// city demolishes itself before anyone fires.
    ///
    /// # Safety
    /// As [`Self::attach`].
    pub unsafe fn attach_city(
        scene: usize,
        physics: usize,
        scene_pack: &Path,
        gravity: [f32; 3],
        grid: u32,
        varied_heights: bool,
        collision_group: u32,
        collision_mask: u32,
        stress_limit_scale: f32,
        solver_iterations: u32,
        apply_excess_forces: bool,
        excess_force_scale: f32,
    ) -> Result<Self, CoreRuntimeError> {
        use blast_stress_solver::scene_pack::{
            building_offsets, load_scene_pack_file, make_building_variants, pitch_for_pack,
            solver_settings_for, to_scenario_desc, variant_for_building,
        };

        if scene == 0 || physics == 0 {
            return Err(CoreRuntimeError::SceneUnavailable);
        }
        let mut backend = PhysXWorld::attach_scene(
            scene as *mut std::ffi::c_void,
            physics as *mut std::ffi::c_void,
            std::ptr::null_mut(),
        )
        .ok_or(CoreRuntimeError::SceneUnavailable)?;
        backend.check().map_err(|e| CoreRuntimeError::Contract(e.to_string()))?;

        let pack = load_scene_pack_file(scene_pack)
            .map_err(|e| CoreRuntimeError::Scene(e.to_string()))?;
        let variants = make_building_variants(&pack, varied_heights);
        if variants.is_empty() {
            return Err(CoreRuntimeError::Scene("no building variants".into()));
        }
        let pitch = pitch_for_pack(&pack, CITY_STREET_CLEARANCE_M);
        let offsets = building_offsets(grid, pitch);

        let layout = DEFAULT_LAYOUT;
        if offsets.len() as u32 > layout.max_structures() {
            return Err(CoreRuntimeError::Scene(format!(
                "{} buildings exceeds the {} the id layout can address",
                offsets.len(),
                layout.max_structures()
            )));
        }

        let mut set = DestructibleSet::new();
        for (building, offset) in offsets.iter().enumerate() {
            let variant = &variants[variant_for_building(building, variants.len())];
            // The pack's own authored limits, optionally scaled as a whole.
            // Scaling every limit together is the point: scaling one, or only
            // the first material, changes which failure mode a bond reaches
            // first and so changes how the building comes apart rather than
            // just how easily.
            let mut solver = solver_settings_for(&variant.pack, 0);
            // Iteration count is part of the physics, not a speed dial: below
            // convergence the solver reports residual as stress, and residual
            // breaks bonds. Both backends must run the same count or their
            // fracture counts are not comparable.
            if solver_iterations > 0 {
                solver.max_solver_iterations_per_frame = solver_iterations;
            }
            if stress_limit_scale > 0.0 && (stress_limit_scale - 1.0).abs() > f32::EPSILON {
                solver.compression_elastic_limit *= stress_limit_scale;
                solver.compression_fatal_limit *= stress_limit_scale;
                solver.tension_elastic_limit *= stress_limit_scale;
                solver.tension_fatal_limit *= stress_limit_scale;
                solver.shear_elastic_limit *= stress_limit_scale;
                solver.shear_fatal_limit *= stress_limit_scale;
            }
            // The pack's real table, scaled as a whole. Without this every
            // bond runs on material 0 and the foundation -- authored strongest
            // precisely because it carries the most load -- ends up weaker than
            // the load it was sized for, so the city collapses at rest.
            let materials: Vec<blast_stress_solver::types::StressLimits> = variant
                .pack
                .materials
                .iter()
                .map(|m| {
                    let l = m.limits;
                    let k = if stress_limit_scale > 0.0 { stress_limit_scale } else { 1.0 };
                    blast_stress_solver::types::StressLimits {
                        compression_elastic_limit: l.compression_elastic * k,
                        compression_fatal_limit: l.compression_fatal * k,
                        tension_elastic_limit: l.tension_elastic * k,
                        tension_fatal_limit: l.tension_fatal * k,
                        shear_elastic_limit: l.shear_elastic * k,
                        shear_fatal_limit: l.shear_fatal * k,
                    }
                })
                .collect();
            let mut cfg = DestructibleConfig {
                gravity: CoreVec3::new(gravity[0], gravity[1], gravity[2]),
                materials,
                solver,
                apply_excess_forces,
                excess_force_scale,
                // Without this the host's raycasts cannot see a single chunk,
                // and every shot into the city reports a miss.
                collision_groups: Some(blast_stress_solver::backend::InteractionGroups {
                    memberships: collision_group,
                    filter: collision_mask,
                    entity: layout.body_entity(building as u32, SUPPORT_ISLAND_SERIAL),
                }),
                ..Default::default()
            };
            cfg.world_pose.translation = *offset;
            set.attach(
                &mut backend,
                StructureId(building as u32),
                &to_scenario_desc(&variant.pack),
                cfg,
            )
            .map_err(|_| CoreRuntimeError::Attach)?;
        }

        Ok(Self {
            backend,
            set,
            layout,
            settled_this_tick: std::collections::HashSet::new(),
            woke_this_tick: std::collections::HashSet::new(),
            ticks: 0,
            totals: Totals::default(),
        })
    }

    /// Structures currently in the set.
    pub fn structure_count(&self) -> usize {
        self.set.len()
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
        self.settled_this_tick.clear();
        self.woke_this_tick.clear();

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
                    self.settled_this_tick
                        .insert(layout.body_entity(structure_id, island_id));
                    settled.push(SettleEvent { structure_id, island_id, position, rotation });
                }
                DestructionEvent::IslandWoke { serial: s } => {
                    if let Some(id) = serial(s, &mut overflow) {
                        self.woke_this_tick.insert(layout.body_entity(structure_id, id));
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

    /// The per-tick pose stream the encoder ingests.
    ///
    /// Built from the pipeline's COM-frame island poses, so it composes with
    /// the manifest's rest-local offsets exactly as the wire contract requires.
    ///
    /// `flags` carries what the pipeline actually knows: sleep level, plus the
    /// sleep and wake *edges* from the event stream. `contacts` is left at zero
    /// and `FLAG_CONTACT_BEGIN`/`_END` are never set -- the core does not yet
    /// consume the PhysX contact stream, so there is nothing to report. They
    /// are encoder prioritisation hints rather than correctness inputs, so the
    /// stream stays correct and loses some scheduling quality; that is stated
    /// here rather than papered over with a plausible-looking number.
    pub fn body_snapshots(&self) -> Vec<BodySnapshotInput> {
        self.set
            .island_poses(&self.backend)
            .into_iter()
            .filter_map(|(sid, m)| {
                if !self.layout.serial_fits(m.serial.0) {
                    return None;
                }
                let body_entity = self.layout.body_entity(sid.0, m.serial.0 as u32);
                let mut flags = 0u8;
                if m.sleeping {
                    flags |= crate::types::FLAG_SLEEP;
                }
                if self.settled_this_tick.contains(&body_entity) {
                    flags |= crate::types::FLAG_SLEEP_EVENT;
                }
                if self.woke_this_tick.contains(&body_entity) {
                    flags |= crate::types::FLAG_WAKE_EVENT;
                }
                Some(BodySnapshotInput {
                    body_entity,
                    position: [m.pose.translation.x, m.pose.translation.y, m.pose.translation.z],
                    rotation: [
                        m.pose.rotation.x,
                        m.pose.rotation.y,
                        m.pose.rotation.z,
                        m.pose.rotation.w,
                    ],
                    linear_velocity: [m.linvel.x, m.linvel.y, m.linvel.z],
                    angular_velocity: [m.angvel.x, m.angvel.y, m.angvel.z],
                    contacts: 0,
                    flags,
                })
            })
            .collect()
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
        self.nearest_node_within(world_point, f32::MAX).map(|(_, node)| node)
    }

    /// Nearest load-bearing node across *every* structure, with its owner.
    ///
    /// Searching all structures and taking the global minimum is the point: a
    /// city is a grid, and picking the first structure that happens to have a
    /// node would aim every shot at whichever building was attached first.
    ///
    /// `max_distance` is what lets a shot miss. Without it the nearest node to
    /// a shot into open sky is simply the least distant one in the city.
    pub fn nearest_node_within(
        &self,
        world_point: [f32; 3],
        max_distance: f32,
    ) -> Option<(u32, u32)> {
        let p = CoreVec3::new(world_point[0], world_point[1], world_point[2]);
        let mut best: Option<(u32, u32, f32)> = None;
        for (sid, d) in self.set.iter() {
            let Some((node, distance)) = d.nearest_dynamic_node_within(&self.backend, p, max_distance)
            else {
                continue;
            };
            if best.is_none_or(|(_, _, b)| distance < b) {
                best = Some((sid.0, node, distance));
            }
        }
        best.map(|(sid, node, _)| (sid, node))
    }

    /// Drive a load into the stress graph at a node of a named structure.
    ///
    /// Momentum, not an opaque impulse. A hitscan round deposits `mass * speed`
    /// at the point it strikes; the solver takes a force applied across the
    /// tick, so the exact equivalent of depositing that momentum in one tick is
    /// `momentum / dt`.
    ///
    /// This deliberately has no radius, no falloff and no direction blend. The
    /// path it replaces had all three -- `1 - d/r`, a `0.85 * shot + 0.15 *
    /// radial` mix, and a 0.5 m push of the impact point *inside* the surface
    /// "so a sphere covers material" -- none of which are derived from
    /// anything. Where the round should be more destructive, that is a
    /// statement about the round, and it is made by changing its mass or its
    /// speed.
    pub fn deposit_momentum(
        &mut self,
        structure_id: u32,
        node: u32,
        world_point: [f32; 3],
        direction: [f32; 3],
        momentum_ns: f32,
        dt: f32,
    ) {
        if dt <= 0.0 {
            return;
        }
        let d = CoreVec3::new(direction[0], direction[1], direction[2]);
        let len = d.magnitude();
        if len <= 0.0 {
            return;
        }
        let force = d * (momentum_ns / (len * dt));
        let Some(structure) = self.set.get_mut(StructureId(structure_id)) else {
            return;
        };
        structure.add_force(
            node,
            CoreVec3::new(world_point[0], world_point[1], world_point[2]),
            force,
        );
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
