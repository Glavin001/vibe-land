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

pub struct CityDestruction {
    /// Awake-body encoder input, rebuilt once per tick inside `post_step`.
    encoder_input: Vec<BodySnapshotInput>,
    manifest: Arc<DestructionManifest>,
    settle: SettleTracker,
    settle_config: SettleConfig,
    tick: u64,
    stats: DestructionStats,
    degraded: bool,
    /// island serials already known so we can detect wakes after settle.
    known_awake: HashMap<u32, bool>,
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
                        ChunkGeometry::ConvexHull { points } => {
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
            known_awake: HashMap::new(),
        })
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
        if let Err(error) =
            world.destruction_tick(dt, Vec3::new(gravity[0], gravity[1], gravity[2]))
        {
            self.degraded = true;
            return Err(CityDestructionError::Bridge(error.to_string()));
        }

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
                self.known_awake.insert(body, true);
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
                self.known_awake.remove(&body);
                batch.retired_island_ids.push(event.island_id);
            }
        }

        let drain_ms = drain_started.elapsed().as_secs_f32() * 1000.0;
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
            if snap.position.y < min_body_y {
                min_body_y = snap.position.y;
                min_pos = [snap.position.x, snap.position.y, snap.position.z];
                min_vel = [
                    snap.linear_velocity.x,
                    snap.linear_velocity.y,
                    snap.linear_velocity.z,
                ];
            }
            // One hash lookup per body, not two: this runs for every body
            // every tick, and with sleep miscalibrated that is ~6000 bodies.
            let entry = self.known_awake.entry(snap.entity_id).or_insert(true);
            let previously = Some(*entry);
            if snap.sleeping {
                if previously != Some(false) {
                    *entry = false;
                    let (structure_id, serial) = ids::body_entity_parts(snap.entity_id);
                    settled.push(SettleEvent {
                        structure_id,
                        island_id: serial as u32,
                        position: [snap.position.x, snap.position.y, snap.position.z],
                        rotation: [
                            snap.rotation.x,
                            snap.rotation.y,
                            snap.rotation.z,
                            snap.rotation.w,
                        ],
                    });
                }
            } else {
                if previously == Some(false) {
                    self.stats.resettled_wakes += 1;
                }
                *entry = true;
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
            self.stats.sleeping_chunk_bodies = bridge_stats.sleeping_chunk_bodies;
            self.stats.overstressed_bonds = bridge_stats.overstressed_bonds;
            self.stats.contacts_processed = bridge_stats.contacts_processed;
            self.stats.contacts_dropped = bridge_stats.contacts_dropped;
            self.stats.bond_utilisation_max = bridge_stats.bond_utilisation_max;
            self.stats.bonds_above_half_utilisation = bridge_stats.bonds_above_half_utilisation;
        }

        Ok(DestructionTickOutput {
            batches: batches.into_values().collect(),
            settled,
        })
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
