//! PhysX-backed city destruction runtime.
//!
//! Owns the per-match `CityDestruction` state that drives
//! `ExtStressPhysXDestructible` through physx-bridge after each
//! `World::step()` / `fetchResults`.

use std::collections::HashMap;
use std::sync::Arc;

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, Vec3, World,
};
use vibe_netcode::destruction_backend::{
    DestructionStats, DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
    ShapeMigration, StressSolverSettings,
};

use crate::encoder::BodySnapshotInput;
use crate::freeze::{BodySample, FreezeConfig, FreezeTracker};
use crate::ids;
use crate::manifest::{ChunkGeometry, DestructionManifest};
use crate::settle::{SettleConfig, SettleSample, SettleTracker};

pub const GROUP_CHUNK: u32 = 1 << 5;
pub const GROUP_STATIC: u32 = 1 << 0;
pub const GROUP_DYNAMIC: u32 = 1 << 1;
pub const GROUP_PLAYER: u32 = 1 << 2;
pub const GROUP_VEHICLE: u32 = 1 << 3;
pub const GROUP_BATTERY: u32 = 1 << 4;
/// Body origins below this are penetrating the flat city ground (y=0). A
/// chunk resting on the ground keeps its origin above it, so anything under
/// this is sunk, not seated.
pub const GROUND_PENETRATION_FLOOR_M: f32 = -0.25;

/// Slack added to every wake radius, metres. A chunk whose shell only just
/// touches the blast should still be released: the alternative is a visible
/// seam where rubble one centimetre outside the radius stays welded in place.
const WAKE_MARGIN_M: f32 = 0.5;

pub const CHUNK_COLLISION_MASK: u32 =
    GROUP_STATIC | GROUP_DYNAMIC | GROUP_PLAYER | GROUP_VEHICLE | GROUP_BATTERY | GROUP_CHUNK;

#[derive(Debug)]
pub enum CityDestructionError {
    Bridge(String),
    Degraded,
}

impl std::fmt::Display for CityDestructionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bridge(message) => write!(f, "physx destruction bridge: {message}"),
            Self::Degraded => write!(f, "city destruction degraded"),
        }
    }
}

impl std::error::Error for CityDestructionError {}

/// Below this, a chunk body is treated as escaped and parked. Ground level is
/// y=0; nothing legitimate lives below about -2 m (`min_body_y` on a healthy
/// settled city reads ~-0.3). Generous margin so a deep rubble compaction
/// never trips it.
fn kill_floor_y() -> f32 {
    static VALUE: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *VALUE.get_or_init(|| {
        std::env::var("VIBE_CITY_KILL_FLOOR_Y")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(-40.0)
    })
}

pub struct CityDestruction {
    /// Awake-body encoder input, rebuilt once per tick inside `post_step`.
    encoder_input: Vec<BodySnapshotInput>,
    manifest: Arc<DestructionManifest>,
    settle: SettleTracker,
    settle_config: SettleConfig,
    tick: u64,
    stats: DestructionStats,
    degraded: bool,
    /// Fracture-frame resimulation. 0 = off. Each pass rewinds motion and
    /// re-runs simulate+tick when the previous tick split an island, so the
    /// contact that caused the split resolves against the resulting pieces.
    /// `VIBE_CITY_RESIM_PASSES` (default 0 while it is being validated).
    resim_passes: u32,
    last_split_count: u64,
    resim_passes_run: u64,
    resim_captures: u64,
    resim_zero_captures: u64,
    resim_not_needed: u64,
    resim_errors: u64,
    resim_last_error: Option<String>,
    /// Per-body rest state: the settle/wake edges the wire is built on, and
    /// (when enabled) the freeze decisions and spatial index over frozen
    /// rubble. Replaces the old `known_awake` map, which tracked only the
    /// awake bit and so could see the sleep edge but nothing about why a body
    /// kept being woken.
    freeze: FreezeTracker,
    /// Wakes staged between ticks by impacts, drained into the next
    /// `post_step`'s output. Shots are routed outside the tick, so a wake can
    /// be decided when there is no batch open to put it in.
    pending_wakes: Vec<(u32, u32)>,
}

impl CityDestruction {
    pub fn build(
        manifest: Arc<DestructionManifest>,
        world: &mut World,
        settings: StressSolverSettings,
        sim_hz: u32,
    ) -> Result<Self, CityDestructionError> {
        let ffi_settings = DestructibleSettings {
            max_solver_iterations_per_frame: settings.max_solver_iterations_per_frame,
            graph_reduction_level: settings.graph_reduction_level,
            materials: settings
                .materials
                .iter()
                .map(|material| vibe_land_physx_bridge::StressMaterialDesc {
                    compression_elastic: material.compression_elastic_mpa,
                    compression_fatal: material.compression_fatal_mpa,
                    tension_elastic: material.tension_elastic_mpa,
                    tension_fatal: material.tension_fatal_mpa,
                    shear_elastic: material.shear_elastic_mpa,
                    shear_fatal: material.shear_fatal_mpa,
                })
                .collect(),
            maximum_bodies: settings.maximum_bodies,
            maximum_fractures_per_actor_per_tick: settings.maximum_fractures_per_actor_per_tick,
            apply_excess_forces: settings.apply_excess_forces,
            apply_centrifugal: settings.apply_centrifugal,
            excess_force_scale: settings.excess_force_scale,
            linear_damping: settings.linear_damping,
            angular_damping: settings.angular_damping,
        };

        // Bond materials and the material table arrive by different routes --
        // the table from the scene pack via settings, the indices from the
        // manifest -- so a mismatch is possible in principle. Catching it here
        // turns what would be a C++ abort into an ordinary error.
        let material_count = ffi_settings.materials.len() as u32;
        if let Some(bad) = manifest
            .structures
            .iter()
            .flat_map(|structure| structure.bonds.iter())
            .find(|bond| bond.material >= material_count)
        {
            return Err(CityDestructionError::Bridge(format!(
                "bond material {} out of range ({material_count} materials)",
                bad.material
            )));
        }

        for structure in &manifest.structures {
            let nodes: Vec<ChunkNodeDesc> = structure
                .chunks
                .iter()
                .map(|chunk| {
                    let (geom_kind, half_extents, convex_points) = match &chunk.geometry {
                        ChunkGeometry::Cuboid { half_extents } => (
                            0,
                            Vec3::new(half_extents[0], half_extents[1], half_extents[2]),
                            Vec::new(),
                        ),
                        ChunkGeometry::ConvexHull { .. } => {
                            let points = manifest.hull_points(&chunk.geometry);
                            // Duplicate positions only -- authored point
                            // buffers often repeat corners per face, and the
                            // repeats are byte-identical. This is lossless;
                            // the shape is untouched.
                            //
                            // NO geometric thinning happens here. An earlier
                            // version strided every Nth point to fit the GPU's
                            // 64-vertex hull cap, silently deforming colliders
                            // away from the rendered geometry. The cap is now
                            // enforced where it belongs: the PhysX cooker's
                            // own vertex limit, which computes the optimal
                            // bounded hull when an asset exceeds it.
                            let mut seen = std::collections::HashSet::new();
                            let pts: Vec<Vec3> = points
                                .chunks_exact(3)
                                .filter(|p| {
                                    seen.insert([p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
                                })
                                .map(|p| Vec3::new(p[0], p[1], p[2]))
                                .collect();
                            (1, Vec3::new(0.5, 0.5, 0.5), pts)
                        }
                    };
                    ChunkNodeDesc {
                        node_index: chunk.node_index,
                        centroid: Vec3::new(
                            chunk.centroid[0],
                            chunk.centroid[1],
                            chunk.centroid[2],
                        ),
                        mass: chunk.mass,
                        volume: chunk.volume,
                        geom_kind,
                        half_extents,
                        convex_points,
                    }
                })
                .collect();
            let bonds: Vec<ChunkBondDesc> = structure
                .bonds
                .iter()
                .map(|bond| ChunkBondDesc {
                    bond_index: bond.bond_index,
                    node0: bond.node0,
                    node1: bond.node1,
                    centroid: Vec3::new(bond.centroid[0], bond.centroid[1], bond.centroid[2]),
                    normal: Vec3::new(bond.normal[0], bond.normal[1], bond.normal[2]),
                    area: bond.area,
                    material: bond.material,
                })
                .collect();
            let pose = Pose {
                position: Vec3::new(
                    structure.world_position[0],
                    structure.world_position[1],
                    structure.world_position[2],
                ),
                rotation: Quat {
                    x: structure.world_rotation[0],
                    y: structure.world_rotation[1],
                    z: structure.world_rotation[2],
                    w: structure.world_rotation[3],
                },
            };
            world
                .create_destructible(
                    structure.structure_id,
                    pose,
                    &nodes,
                    &bonds,
                    ffi_settings.clone(),
                    GROUP_CHUNK,
                    CHUNK_COLLISION_MASK,
                )
                .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
        }

        Ok(Self {
            encoder_input: Vec::new(),
            stats: DestructionStats {
                structures: manifest.structures.len() as u32,
                ..DestructionStats::default()
            },
            manifest,
            settle: SettleTracker::default(),
            settle_config: SettleConfig::validated(sim_hz),
            tick: 0,
            degraded: false,
            resim_passes: std::env::var("VIBE_CITY_RESIM_PASSES")
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0),
            last_split_count: 0,
            resim_passes_run: 0,
            resim_captures: 0,
            resim_zero_captures: 0,
            resim_not_needed: 0,
            resim_errors: 0,
            resim_last_error: None,
            freeze: FreezeTracker::new(FreezeConfig::from_env()),
            pending_wakes: Vec::new(),
        })
    }

    /// Override the freeze policy after construction.
    ///
    /// The live server reads it from the environment once, at build. Tests
    /// need to drive both sides of the A/B in one process, where a global
    /// would make the answer depend on test ordering.
    pub fn set_freeze_config(&mut self, config: FreezeConfig) {
        self.freeze = FreezeTracker::new(config);
    }

    pub fn freeze_config(&self) -> FreezeConfig {
        *self.freeze.config()
    }

    pub fn manifest(&self) -> &DestructionManifest {
        &self.manifest
    }

    pub fn degraded(&self) -> bool {
        self.degraded
    }

    pub fn apply_chunk_hit(
        &mut self,
        world: &mut World,
        chunk_id: u32,
        impulse: [f32; 3],
        point: [f32; 3],
    ) -> Result<(), CityDestructionError> {
        if self.degraded {
            return Err(CityDestructionError::Degraded);
        }
        let (structure_id, _) = ids::chunk_id_parts(chunk_id);
        world
            .queue_chunk_damage(
                structure_id,
                chunk_id,
                Vec3::new(impulse[0], impulse[1], impulse[2]),
                Vec3::new(point[0], point[1], point[2]),
            )
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))
    }

    pub fn apply_explosion(
        &mut self,
        world: &mut World,
        center: [f32; 3],
        radius: f32,
        impulse: f32,
    ) -> Result<u32, CityDestructionError> {
        if self.degraded {
            return Err(CityDestructionError::Degraded);
        }
        world
            .apply_destruction_explosion(
                Vec3::new(center[0], center[1], center[2]),
                radius,
                impulse,
            )
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))
    }

    /// Rocket / hitscan blast: directed stress at the impact + PhysX push on debris.
    pub fn apply_blast(
        &mut self,
        world: &mut World,
        center: [f32; 3],
        direction: [f32; 3],
        radius: f32,
        stress_impulse: f32,
        push_impulse: f32,
    ) -> Result<u32, CityDestructionError> {
        if self.degraded {
            return Err(CityDestructionError::Degraded);
        }
        world
            .apply_destruction_blast(
                Vec3::new(center[0], center[1], center[2]),
                Vec3::new(direction[0], direction[1], direction[2]),
                radius,
                stress_impulse,
                push_impulse,
            )
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))
    }

    /// Call after `World::step()`. Runs the Blast stress tick, drains events,
    /// applies settle policy, and returns the network-facing output.
    /// Resim engagement counters: (captures taken, re-passes run).
    ///
    /// Exposed because a resim that silently never captures is indistinguishable
    /// from one that works, except in the frame budget -- and that is the most
    /// expensive possible way to be wrong.
    /// Take the fracture-frame resimulation capture. MUST be called by the
    /// host immediately before `World::step()`.
    ///
    /// It cannot live at the end of post_step, which is where it was first
    /// put: by then the tick has drained `m_contacts` and cleared the
    /// had-forces flag, so `needsResimulationSnapshot()` answers false on every
    /// single tick and the whole mechanism silently does nothing. Measured that
    /// way it reported 0 captures over 360 ticks while appearing to work.
    pub fn pre_step(&mut self, world: &mut World) {
        if self.resim_passes == 0 {
            return;
        }
        // Capture EVERY frame, not only when needsResimulationSnapshot() asks.
        //
        // The library's own driver gates on that predicate only when
        // ExtStressPhysXResimOptions::quietCaptureSkip is set, and it defaults
        // to FALSE -- shouldCapture() returns true immediately. Gating on it
        // produced 96 captures against 221 restores, so a restore could rewind
        // to a capture several frames old instead of to the start of this one.
        match world.resim_capture() {
            Ok(n) if n > 0 => self.resim_captures += 1,
            Ok(_) => self.resim_zero_captures += 1,
            Err(e) => {
                if self.resim_last_error.is_none() {
                    self.resim_last_error = Some(format!("capture: {e}"));
                }
                self.resim_errors += 1;
            }
        }
    }

    pub fn resim_counters(&self) -> (u64, u64) {
        (self.resim_captures, self.resim_passes_run)
    }

    pub fn resim_diagnosis(&self) -> String {
        format!(
            "captures={} zero={} not_needed={} errors={} first_error={:?}",
            self.resim_captures, self.resim_zero_captures, self.resim_not_needed,
            self.resim_errors, self.resim_last_error
        )
    }

    pub fn post_step(
        &mut self,
        world: &mut World,
        dt: f32,
        gravity: [f32; 3],
    ) -> Result<DestructionTickOutput, CityDestructionError> {
        if self.degraded {
            return Err(CityDestructionError::Degraded);
        }
        self.tick += 1;
        let tick = self.tick;
        // Host wall time of the native tick, including the FFI hop and the
        // per-slot dispatch the native counters cannot see. `stress_solve_ms`
        // is the manager's own bracket inside it; the gap between them is real.
        let tick_ffi_started = std::time::Instant::now();
        if let Err(error) =
            world.destruction_tick(dt, Vec3::new(gravity[0], gravity[1], gravity[2]))
        {
            self.degraded = true;
            return Err(CityDestructionError::Bridge(error.to_string()));
        }

        // Fracture-frame resimulation, following the library's own ordering in
        // NvBlastExtStressPhysXResim: capture before simulate, and if the tick
        // that followed fractured, rewind motion and re-run simulate+tick so
        // contacts resolve against the pieces rather than the intact body.
        //
        // Without it a tower striking another resolves its contact against the
        // whole rigid body; the split lands afterwards and the fragments are
        // placed into a world where the impact is already over. That is why a
        // building falling on a building reads softer than it should.
        //
        // Keyed on splits, not broken bonds: a bond can break without the
        // island separating, and it is the separation that changes what the
        // contact should have hit.
        if self.resim_passes > 0 {
            let mut passes = self.resim_passes;
            while passes > 0 {
                let splits = world.split_count().unwrap_or(self.last_split_count);
                if splits <= self.last_split_count {
                    break;
                }
                self.last_split_count = splits;
                if !world.resim_restore().unwrap_or(false) {
                    break; // no capture held -- nothing to rewind to
                }
                if world.step().is_err() {
                    self.degraded = true;
                    return Err(CityDestructionError::Bridge(
                        "resim re-step failed".to_string(),
                    ));
                }
                if let Err(error) =
                    world.destruction_tick(dt, Vec3::new(gravity[0], gravity[1], gravity[2]))
                {
                    self.degraded = true;
                    return Err(CityDestructionError::Bridge(error.to_string()));
                }
                self.resim_passes_run += 1;
                passes -= 1;
            }
            self.last_split_count = world.split_count().unwrap_or(self.last_split_count);
        }
        if false {
            match world.resim_needed() {
                Ok(true) => match world.resim_capture() {
                    Ok(n) if n > 0 => self.resim_captures += 1,
                    Ok(_) => self.resim_zero_captures += 1,
                    Err(e) => {
                        // Loud once. Swallowing this is how resim spent a whole
                        // measurement cycle looking like it worked.
                        if self.resim_last_error.is_none() {
                            self.resim_last_error = Some(format!("capture: {e}"));
                        }
                        self.resim_errors += 1;
                    }
                },
                Ok(false) => self.resim_not_needed += 1,
                Err(e) => {
                    if self.resim_last_error.is_none() {
                        self.resim_last_error = Some(format!("needed: {e}"));
                    }
                    self.resim_errors += 1;
                }
            }
        }
        let tick_ffi_ms = tick_ffi_started.elapsed().as_secs_f32() * 1000.0;

        let drain_started = std::time::Instant::now();
        let broken = world
            .take_broken_bonds()
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
        let migrations = world
            .take_chunk_migrations()
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
        let islands = world
            .take_island_events()
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;

        // Supporter deaths discovered while draining this tick's events:
        // promoted rooted fragments (a stump going dynamic is a supporter
        // death), retired bodies, and nodes migrating off still-standing
        // stumps. Cascaded after `wakes` exists.
        let mut supporter_deaths: Vec<u32> = Vec::new();
        let mut batches: HashMap<u32, FractureBatch> = HashMap::new();
        for event in broken {
            let batch = batches.entry(event.structure_id).or_insert_with(|| FractureBatch {
                structure_id: event.structure_id,
                ..FractureBatch::default()
            });
            batch.broken_bond_ids.push(event.bond_id);
            self.stats.broken_bonds += 1;
        }
        for event in migrations {
            let batch = batches.entry(event.structure_id).or_insert_with(|| FractureBatch {
                structure_id: event.structure_id,
                ..FractureBatch::default()
            });
            self.stats.chunk_migrations += 1;
            // A node leaving a rooted fragment is a node-level supporter
            // death: whatever weight that node carried must re-prove its
            // support. No-op unless the source was actually a rooted
            // supporter some edge named.
            let from_entity = ids::body_entity(event.structure_id, event.from_island);
            let (_, node) = ids::chunk_id_parts(event.chunk_id);
            supporter_deaths.extend(self.freeze.rooted_node_died(from_entity, node));
            batch.migrations.push(ShapeMigration {
                chunk_id: event.chunk_id,
                from_island_id: event.from_island,
                to_island_id: event.to_island,
            });
        }
        for event in islands {
            let batch = batches.entry(event.structure_id).or_insert_with(|| FractureBatch {
                structure_id: event.structure_id,
                ..FractureBatch::default()
            });
            if event.kind == 0 {
                let body = ids::body_entity(event.structure_id, event.island_id);
                self.settle.promote(body, tick);
                // Reach comes from the manifest, so a body's freeze shell is
                // the same shell the wire holds it to.
                let reach = crate::freeze::island_reach(
                    &self.manifest,
                    event.structure_id,
                    &event.chunk_ids,
                );
                self.freeze.promote(body, reach);
                // If this entity was serving as a ROOTED supporter, its
                // promotion means the stump went dynamic: a supporter death
                // for everything leaning on it.
                supporter_deaths.extend(self.freeze.supporter_died(body, true));
                batch.promoted_islands.push(IslandPromotion {
                    structure_id: event.structure_id,
                    island_id: event.island_id,
                    chunks: event.chunk_ids,
                    mass: event.mass,
                    position: [
                        event.position.x,
                        event.position.y,
                        event.position.z,
                    ],
                    rotation: [
                        event.rotation.x,
                        event.rotation.y,
                        event.rotation.z,
                        event.rotation.w,
                    ],
                    linear_velocity: [
                        event.linear_velocity.x,
                        event.linear_velocity.y,
                        event.linear_velocity.z,
                    ],
                    angular_velocity: [
                        event.angular_velocity.x,
                        event.angular_velocity.y,
                        event.angular_velocity.z,
                    ],
                    ..IslandPromotion::default()
                });
            } else {
                let body = ids::body_entity(event.structure_id, event.island_id);
                self.settle.retire(body);
                self.freeze.retire(body);
                // Crushed or merged away: dead as a supporter, whether it was
                // frozen debris or a rooted stump.
                supporter_deaths.extend(self.freeze.supporter_died(body, true));
                batch.retired_island_ids.push(event.island_id);
            }
        }

        let drain_ms = drain_started.elapsed().as_secs_f32() * 1000.0;
        let mut wakes: Vec<(u32, u32)> = std::mem::take(&mut self.pending_wakes);

        // Supporter-set updates from the engine's contact reports: who is
        // holding each body up, refreshed for every body whose set changed
        // during the physics step that just ran.
        if let Ok((sets, rows)) = world.take_support_updates() {
            for set in &sets {
                let start = set.first_row as usize;
                let end = (start + set.row_count as usize).min(rows.len());
                let supporters = rows[start..end]
                    .iter()
                    .map(|row| match row.kind {
                        0 => crate::freeze::Supporter::World,
                        2 => crate::freeze::Supporter::Rooted {
                            entity: row.supporter_entity,
                            node: row.supporter_node,
                        },
                        3 => crate::freeze::Supporter::Body { entity: row.supporter_entity },
                        _ => crate::freeze::Supporter::Foreign,
                    })
                    .collect();
                self.freeze
                    .ingest_support(set.dependent_entity, supporters, set.min_separation);
            }
        }

        // Contact wakes: frozen bodies that dynamic debris struck during the
        // physics step that just ran. This is the engine's own collision
        // detection driving the release -- the equivalent, for frozen rubble,
        // of PhysX waking a sleeping body that gets hit -- and it is what
        // stops a collapse treating previously-frozen pieces as immovable
        // anchors and visibly breaking against them.
        if let Ok(struck) = world.take_frozen_contact_wakes() {
            if !struck.is_empty() {
                // A struck body releases, and everything whose weight it
                // carried follows in the same cascade.
                self.cascade_release(world, struck, &mut wakes, tick);
            }
        }

        // Supporter deaths from this tick's fracture events release their
        // dependents NOW -- same tick as the event, no interval in the loop.
        if !supporter_deaths.is_empty() {
            self.cascade_release(world, supporter_deaths, &mut wakes, tick);
        }

        let readback_started = std::time::Instant::now();
        let snapshots = world
            .chunk_body_snapshots()
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
        let readback_ms_host = readback_started.elapsed().as_secs_f32() * 1000.0;
        let settle_started = std::time::Instant::now();
        // Settling is the adapter's and PhysX's job; we only observe it.
        //
        // Forcing sleep ourselves fought them: you cannot hold one body of an
        // active contact island asleep, so PhysX woke it straight back and the
        // cycle repeated ~650 times a second — which is what made debris judder
        // visibly, and kept ~600 of ~735 bodies awake and being simulated,
        // snapshotted and encoded every tick.
        //
        // A body the engine puts to sleep has genuinely come to rest, and that
        // transition is the network-definitive "at rest now" moment the stream
        // needs.
        let mut settled = Vec::new();
        // Bodies the wire must be told are moving again. Two sources, both
        // below: the adapter flipping a frozen body back when it splits, and
        // spatial wakes staged by an impact since the last tick.
        let mut freeze_candidates = Vec::new();
        let mut adapter_thawed: Vec<u32> = Vec::new();
        self.freeze.begin_tick();

        // Lowest body this tick, over EVERY dynamic body -- sleeping included.
        // This field existed, was logged, asserted on and shown in the overlay,
        // but was never actually computed: it sat at its Default of 0.0
        // forever. That made "the server has every body at y >= 0" a reading of
        // an uninitialised field rather than a measurement, and it is the basis
        // on which below-ground chunks were attributed to the client.
        let mut min_body_y = f32::INFINITY;
        let mut min_pos = [0.0f32; 3];
        let mut min_vel = [0.0f32; 3];
        let mut max_speed = 0.0f32;
        let mut max_speed_pos = [0.0f32; 3];
        let mut max_speed_entity = 0u32;
        // Built here rather than by a second full pass in body_snapshots():
        // that pass re-crossed the FFI boundary, rebuilt a Vec of every body,
        // and re-filtered it, all over data this loop already has in hand.
        let mut encoder_input: Vec<BodySnapshotInput> = Vec::with_capacity(snapshots.len());
        let mut max_angular = 0.0f32;
        // Kill floor. A body that tunnels through the ground during a heavy
        // collapse falls forever at 20 m/s^2; measured live, 24 escapees
        // reached y = -19.6 MILLION metres at ~20 km/s. At that speed each
        // one's speculative-CCD envelope sweeps hundreds of metres of
        // broadphase per tick: the GPU patch buffer overflowed its 524k
        // capacity (547,670 high-water, 2 GPU warnings), PhysX started
        // dropping contacts, and gpu_wait hit 344 ms. Freezing an escapee the
        // tick it crosses the floor parks it kinematic a few metres below
        // ground, where it costs nothing and poisons nothing.
        let kill_floor = kill_floor_y();
        let mut escaped: Vec<u32> = Vec::new();
        for snap in snapshots.iter() {
            if snap.kinematic {
                continue;
            }
            let speed = (snap.linear_velocity.x.powi(2)
                + snap.linear_velocity.y.powi(2)
                + snap.linear_velocity.z.powi(2))
            .sqrt();
            let angular = (snap.angular_velocity.x.powi(2)
                + snap.angular_velocity.y.powi(2)
                + snap.angular_velocity.z.powi(2))
            .sqrt();
            // Speed is measured over AWAKE bodies only: a sleeping body keeps
            // its last velocity in the snapshot, so including them pins the
            // maximum at whatever the last thing to fall was doing -- a frozen
            // constant that reads as perpetual motion and says nothing about
            // whether the pile is at rest. Position, below, still covers every
            // body: a sleeping body stranded underground is precisely the case
            // min_body_y exists to catch.
            if !snap.sleeping {
                if speed > max_speed {
                    max_speed = speed;
                    max_speed_pos = [snap.position.x, snap.position.y, snap.position.z];
                    max_speed_entity = snap.entity_id;
                }
                max_angular = max_angular.max(angular);
            }
            if snap.position.y < kill_floor {
                escaped.push(snap.entity_id);
            }
            if snap.position.y < min_body_y {
                min_body_y = snap.position.y;
                min_pos = [snap.position.x, snap.position.y, snap.position.z];
                min_vel = [
                    snap.linear_velocity.x,
                    snap.linear_velocity.y,
                    snap.linear_velocity.z,
                ];
            }
            // One tracker call per body, and it is the only per-body work in
            // this loop: it runs for every body every tick, and with sleep
            // miscalibrated that is ~6000 bodies.
            let position = [snap.position.x, snap.position.y, snap.position.z];
            let rotation = [
                snap.rotation.x,
                snap.rotation.y,
                snap.rotation.z,
                snap.rotation.w,
            ];
            let observed = self.freeze.observe(BodySample {
                entity: snap.entity_id,
                position,
                rotation,
                sleeping: snap.sleeping,
                tick,
            });
            if observed.settled {
                let (structure_id, serial) = ids::body_entity_parts(snap.entity_id);
                settled.push(SettleEvent {
                    structure_id,
                    island_id: serial as u32,
                    position,
                    rotation,
                });
            }
            if observed.woke {
                self.stats.resettled_wakes += 1;
            }
            if observed.thawed_by_adapter {
                // The adapter set a frozen body dynamic again, which it does
                // when the body splits. The client is still drawing it parked
                // against its settle record, so it has to be told -- and the
                // body stops being a valid supporter, so its dependents are
                // cascaded after this loop.
                let (structure_id, serial) = ids::body_entity_parts(snap.entity_id);
                wakes.push((structure_id, serial));
                adapter_thawed.push(snap.entity_id);
            }
            if let Some(candidate) = observed.freeze {
                freeze_candidates.push(candidate);
            }

            // The encoder only streams awake, non-kinematic bodies.
            if !snap.kinematic && !snap.sleeping {
                encoder_input.push(BodySnapshotInput {
                    body_entity: snap.entity_id,
                    position: [snap.position.x, snap.position.y, snap.position.z],
                    rotation: [
                        snap.rotation.x,
                        snap.rotation.y,
                        snap.rotation.z,
                        snap.rotation.w,
                    ],
                    linear_velocity: [
                        snap.linear_velocity.x,
                        snap.linear_velocity.y,
                        snap.linear_velocity.z,
                    ],
                    angular_velocity: [
                        snap.angular_velocity.x,
                        snap.angular_velocity.y,
                        snap.angular_velocity.z,
                    ],
                    contacts: 0,
                    flags: 0,
                });
            }
        }

        self.encoder_input = encoder_input;

        // Bodies the adapter took back mid-split stopped being valid
        // supporters the moment they went dynamic; their dependents release
        // in the same tick's cascade.
        if !adapter_thawed.is_empty() {
            let mut seeds = Vec::new();
            for entity in adapter_thawed {
                seeds.extend(self.freeze.supporter_died(entity, true));
            }
            if !seeds.is_empty() {
                self.cascade_release(world, seeds, &mut wakes, tick);
            }
        }

        // Freeze pass. Bottom-up: the lowest candidates are the ones whose
        // support is the ground rather than more debris, so freezing them
        // first removes the deep stacked contacts that converge worst and
        // lets the layer above settle in turn.
        if !freeze_candidates.is_empty() {
            // The dependency fold: admit only candidates whose every needed
            // supporter is already immovable (ground, rooted stump, frozen
            // body) or becomes so earlier in this same fold -- a settled
            // stack freezes in one call, dependency-first. Rejected
            // candidates re-fire next tick automatically; no timers.
            let freeze_candidates = self.freeze.plan_freeze_batch(&freeze_candidates);
            if freeze_candidates.is_empty() {
                // Nothing admissible this tick (e.g. everything quiet is
                // resting on still-dynamic debris).
            } else {
            let entities: Vec<u32> =
                freeze_candidates.iter().map(|candidate| candidate.entity).collect();
            match world.freeze_chunk_bodies(&entities) {
                Ok(_) => {
                    for candidate in &freeze_candidates {
                        // A body frozen without ever having been slept by the
                        // engine has never had a settle record: nothing else
                        // will tell the client where it came to rest, and it
                        // is about to vanish from the pose stream.
                        if candidate.needs_settle_record {
                            let (structure_id, serial) =
                                ids::body_entity_parts(candidate.entity);
                            settled.push(SettleEvent {
                                structure_id,
                                island_id: serial,
                                position: candidate.position,
                                rotation: candidate.rotation,
                            });
                        }
                    }
                    self.freeze.mark_frozen(&freeze_candidates);
                }
                Err(_) => {
                    // Freezing is an optimisation; losing it must never take
                    // the match down with it. It also will not fix itself, so
                    // stop rather than re-attempting 60 times a second.
                    self.stats.freeze_failures += 1;
                    self.freeze.disable();
                }
            }
            }
        }

        // Release frozen rubble that has lost whatever was holding it up.
        //
        // Freezing at rest is not the same as freezing when supported: a body
        // can be still while wedged, or resting on debris that later slides
        // away. Kinematic bodies cannot fall, so without this they hang in
        // the air permanently -- measured as floaters resolving to zero
        // without freezing but sticking at 4 with it, and immediately visible
        // to a player. Released bodies fall, land, and freeze again, so the
        // loop closes; the per-entity backoff keeps one that cannot find rest
        // from cycling every sweep.
        let stranded = self.freeze.unsupported_frozen(tick);
        if !stranded.is_empty() {
            // Backstop finds are counted (census.backstop_releases) and mean
            // a release event was missed somewhere upstream -- a tripwire
            // firing, not the mechanism working.
            self.cascade_release(world, stranded, &mut wakes, tick);
        }

        let census = self.freeze.census(tick);
        // Frozen bodies are kinematic, so the snapshot loop above never sees
        // them and min_body_y would silently stop covering them -- on exactly
        // the population that cannot recover, since a kinematic body gets no
        // depenetration and cannot climb out of the floor by itself. Fold
        // them back in. With freezing off the set is empty and this is a
        // no-op, so the number stays comparable across the A/B.
        if census.min_frozen_y.is_finite() {
            min_body_y = min_body_y.min(census.min_frozen_y);
        }
        self.stats.chunk_sleep_events = census.sleep_edges;
        self.stats.chunk_wake_events = census.wake_edges;
        self.stats.pose_quiet_awake_bodies = census.pose_quiet_awake;
        self.stats.unsupported_resting_bodies = census.unsupported_resting;
        self.stats.backstop_releases = census.backstop_releases;

        let settle_ms = settle_started.elapsed().as_secs_f32() * 1000.0;
        let stats_ffi_started = std::time::Instant::now();

        // Assigned unconditionally, NOT inside the `if let Ok(bridge_stats)`
        // block below: these are measured here from the snapshot, and burying
        // them behind an FFI call that can fail (or that an edit can miss)
        // is how a field ends up reporting its Default forever.
        self.stats.min_body_y = if min_body_y.is_finite() { min_body_y } else { 0.0 };
        self.stats.max_body_speed = max_speed;
        self.stats.max_body_angular_speed = max_angular;
        self.stats.max_speed_body_pos = max_speed_pos;
        self.stats.max_speed_body_entity = max_speed_entity;
        self.stats.peak_body_speed = self.stats.peak_body_speed.max(max_speed);
        self.stats.peak_body_angular_speed =
            self.stats.peak_body_angular_speed.max(max_angular);
        self.stats.drain_ms = drain_ms;
        self.stats.tick_ffi_ms = tick_ffi_ms;
        if !escaped.is_empty() {
            match world.freeze_chunk_bodies(&escaped) {
                Ok(parked) => {
                    self.stats.escaped_bodies_parked += u64::from(parked);
                    // eprintln, not a logging crate: this crate carries no
                    // logging dependency, and an escape is rare and serious
                    // enough that stderr is the right loudness.
                    eprintln!(
                        "[destruction] KILL FLOOR: parked {} escaped bodies below y={}",
                        escaped.len(),
                        kill_floor
                    );
                }
                Err(error) => {
                    eprintln!("[destruction] kill floor freeze FAILED: {error}");
                }
            }
        }
        self.stats.min_body_pos = min_pos;
        self.stats.min_body_vel = min_vel;

        if let Ok(bridge_stats) = world.destruction_stats() {
            self.stats.chunk_bodies = bridge_stats.chunk_bodies;
            self.stats.awake_chunk_bodies = bridge_stats.awake_chunk_bodies;
            self.stats.stress_solve_ms = bridge_stats.stress_solve_ms;
            self.stats.unmapped_body_skips = bridge_stats.unmapped_body_skips;
            self.stats.readback_ms_host = readback_ms_host;
            self.stats.settle_ms = settle_ms;
            self.stats.stats_ffi_ms = stats_ffi_started.elapsed().as_secs_f32() * 1000.0;
            self.stats.begin_ms = bridge_stats.begin_ms;
            self.stats.solve_ms = bridge_stats.solve_ms;
            self.stats.end_ms = bridge_stats.end_ms;
            self.stats.readback_ms = bridge_stats.readback_ms;
            self.stats.events_ms = bridge_stats.events_ms;
            self.stats.gpu_stress_structures = bridge_stats.gpu_stress_structures;
            self.stats.gpu_stress_solve_ms = bridge_stats.gpu_stress_solve_ms;
            self.stats.filters_ms = bridge_stats.filters_ms;
            self.stats.ccd_ms = bridge_stats.ccd_ms;
            self.stats.support_loads_ms = bridge_stats.support_loads_ms;
            self.stats.support_pair_loads = bridge_stats.support_pair_loads;
            self.stats.blast_contact_processing_ms = bridge_stats.blast_contact_processing_ms;
            self.stats.blast_gravity_ms = bridge_stats.blast_gravity_ms;
            self.stats.blast_stress_solve_cpu_ms = bridge_stats.blast_stress_solve_cpu_ms;
            self.stats.blast_fracture_topology_ms = bridge_stats.blast_fracture_topology_ms;
            self.stats.blast_mapping_validation_ms = bridge_stats.blast_mapping_validation_ms;
            self.stats.blast_fracture_generate_ms = bridge_stats.blast_fracture_generate_ms;
            self.stats.blast_fracture_prep_ms = bridge_stats.blast_fracture_prep_ms;
            self.stats.blast_fracture_apply_ms = bridge_stats.blast_fracture_apply_ms;
            self.stats.blast_fracture_scene_ms = bridge_stats.blast_fracture_scene_ms;
            self.stats.blast_fracture_rebuild_ms = bridge_stats.blast_fracture_rebuild_ms;
            self.stats.blast_sleeping_actors_skipped = bridge_stats.blast_sleeping_actors_skipped;
            self.stats.slot_dispatch_ms = bridge_stats.slot_dispatch_ms;
            self.stats.bond_sample_ms = bridge_stats.bond_sample_ms;
            self.stats.shape_readback_ms = bridge_stats.shape_readback_ms;
            self.stats.quiet_slot_ticks = bridge_stats.quiet_slot_ticks;
            self.stats.sleeping_chunk_bodies = bridge_stats.sleeping_chunk_bodies;
            self.stats.overstressed_bonds = bridge_stats.overstressed_bonds;
            self.stats.contacts_processed = bridge_stats.contacts_processed;
            self.stats.contacts_dropped = bridge_stats.contacts_dropped;
            self.stats.contacts_queued = bridge_stats.contacts_queued;
            self.stats.solver_islands_skipped_accum = bridge_stats.solver_islands_skipped_accum;
            self.stats.solver_islands_total_accum = bridge_stats.solver_islands_total_accum;
            self.stats.ccd_tracked_bodies = bridge_stats.ccd_tracked_bodies;
            self.stats.identity_stamped_bodies = bridge_stats.identity_stamped_bodies;
            self.stats.bond_utilisation_max = bridge_stats.bond_utilisation_max;
            self.stats.bonds_above_half_utilisation = bridge_stats.bonds_above_half_utilisation;
            self.stats.solver_island_count = bridge_stats.solver_island_count;
            self.stats.solver_islands_skipped = bridge_stats.solver_islands_skipped;
            self.stats.sleeping_actors_skipped = bridge_stats.sleeping_actors_skipped;
            // Freeze levels and flips come from the bridge's own set, not
            // from the tracker's: the two are meant to agree, and reporting
            // the side that actually owns the PhysX flag is what makes a
            // disagreement visible rather than self-confirming.
            self.stats.frozen_chunk_bodies = bridge_stats.frozen_chunk_bodies;
            self.stats.frozen_aggregates = bridge_stats.frozen_aggregates;
            self.stats.frozen_aggregate_actors = bridge_stats.frozen_aggregate_actors;
            self.stats.freeze_flips = bridge_stats.freeze_flips;
            self.stats.unfreeze_flips = bridge_stats.unfreeze_flips;
            self.stats.contact_wakes = bridge_stats.contact_wakes;
            self.stats.support_promotions = bridge_stats.support_promotions;
            self.stats.rooted_guard_blocks = bridge_stats.rooted_guard_blocks;
            self.stats.island_resleep_writes = bridge_stats.island_resleep_writes;
            self.stats.rooted_chunk_bodies = bridge_stats.rooted_chunk_bodies;
            self.stats.support_edges = bridge_stats.support_edges;
            self.stats.frozen_serial_blocks = bridge_stats.frozen_serial_blocks;
            self.stats.frozen_adapter_releases = bridge_stats.frozen_adapter_releases;
        }

        wakes.sort_unstable();
        wakes.dedup();
        Ok(DestructionTickOutput {
            batches: batches.into_values().collect(),
            settled,
            wakes,
        })
    }

    /// Release frozen bodies and chase the dependency cascade to its end,
    /// within this tick.
    ///
    /// Every released body is itself a dead supporter, so its frozen
    /// dependents that lose their last valid support release too -- link by
    /// link, exactly as far as the physical dependency chain reaches, and no
    /// further (a dependent with other live support stays frozen). This is
    /// the event-driven core of the design: no timer ever runs between a
    /// support disappearing and its dependents falling.
    fn cascade_release(
        &mut self,
        world: &mut World,
        seed: Vec<u32>,
        wakes: &mut Vec<(u32, u32)>,
        tick: u64,
    ) {
        let mut queue = seed;
        while !queue.is_empty() {
            queue.sort_unstable();
            queue.dedup();
            if world.unfreeze_chunk_bodies(&queue).is_err() {
                self.stats.freeze_failures += 1;
                return;
            }
            let woken = self.freeze.mark_thawed(&queue, tick);
            let mut next = Vec::new();
            for entity in woken {
                let (structure_id, serial) = ids::body_entity_parts(entity);
                wakes.push((structure_id, serial));
                next.extend(self.freeze.supporter_died(entity, false));
            }
            queue = next;
        }
    }

    /// Wake frozen rubble around an impact, returning how many bodies were
    /// released.
    ///
    /// Spatial, not island-wide, and that is the whole point. The measured
    /// pathology is a single rifle round waking 6,065 bodies because they were
    /// all one contact island; releasing only what the blast actually reaches
    /// makes the cost of a shot proportional to the shot.
    ///
    /// The released bodies come back at rest. The impulse arrives from the
    /// existing deferred push pass on the next tick, by which point they are
    /// dynamic again and no longer skipped for being kinematic.
    pub fn wake_around(
        &mut self,
        world: &mut World,
        center: [f32; 3],
        radius: f32,
    ) -> Result<u32, CityDestructionError> {
        if self.degraded || self.freeze.frozen_count() == 0 {
            return Ok(0);
        }
        let config = *self.freeze.config();
        let reach = (radius * config.wake_radius_scale).max(0.0) + WAKE_MARGIN_M;
        let candidates = self.freeze.frozen_within(center, reach, config.wake_above_m);
        if candidates.is_empty() {
            return Ok(0);
        }
        world
            .unfreeze_chunk_bodies(&candidates)
            .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
        let woken = self.freeze.mark_thawed(&candidates, self.tick);
        let mut count = woken.len() as u32;
        let mut seeds = Vec::new();
        for entity in &woken {
            let (structure_id, serial) = ids::body_entity_parts(*entity);
            self.pending_wakes.push((structure_id, serial));
            seeds.extend(self.freeze.supporter_died(*entity, false));
        }
        // Blast-released bodies were supporters too: their dependents follow
        // in the same cascade, announced through the same pending wakes.
        let mut queue = seeds;
        while !queue.is_empty() {
            queue.sort_unstable();
            queue.dedup();
            world
                .unfreeze_chunk_bodies(&queue)
                .map_err(|error| CityDestructionError::Bridge(error.to_string()))?;
            let released = self.freeze.mark_thawed(&queue, self.tick);
            let mut next = Vec::new();
            for entity in released {
                let (structure_id, serial) = ids::body_entity_parts(entity);
                self.pending_wakes.push((structure_id, serial));
                count += 1;
                next.extend(self.freeze.supporter_died(entity, false));
            }
            queue = next;
        }
        Ok(count)
    }

    /// Per-body freeze-machine states for the debug overlay.
    pub fn debug_body_states(&self) -> Vec<(u32, u8, u32, i32)> {
        self.freeze.debug_states()
    }

    /// Awake bodies for the encoder, captured during `post_step`.
    ///
    /// This used to make a second `chunk_body_snapshots()` call: another FFI
    /// crossing, another full Vec of every body, another filter pass, over
    /// state `post_step` had already walked one line earlier.
    pub fn body_snapshots(
        &self,
        _world: &World,
    ) -> Result<&[BodySnapshotInput], CityDestructionError> {
        if self.degraded {
            return Err(CityDestructionError::Degraded);
        }
        Ok(&self.encoder_input)
    }

    pub fn record_host_timings(&mut self, post_step_ms: f32, snapshot_ms: f32, ingest_ms: f32) {
        self.stats.post_step_ms = post_step_ms;
        self.stats.snapshot_ms = snapshot_ms;
        self.stats.ingest_ms = ingest_ms;
    }

    pub fn stats(&self) -> DestructionStats {
        self.stats
    }
}
