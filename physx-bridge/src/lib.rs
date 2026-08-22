//! Optional in-process PhysX GPU world.
//!
//! Without the `gpu` feature this crate has no native dependencies and every
//! world construction attempt returns [`BridgeError::Unavailable`]. Enabling
//! `gpu` builds the C++ bridge and requires a working CUDA/PhysX GPU scene at
//! runtime; there is deliberately no CPU PhysX fallback.

use std::fmt;

pub const FIXED_TIMESTEP: f32 = 1.0 / 60.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Default for Quat {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Quat {
    pub const IDENTITY: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        w: 1.0,
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct Pose {
    pub position: Vec3,
    pub rotation: Quat,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct WorldConfig {
    pub gravity: Vec3,
    pub cpu_threads: u32,
    pub static_friction: f32,
    pub dynamic_friction: f32,
    pub restitution: f32,
    pub contact_report_threshold: f32,
    pub gpu_max_partitions: u32,
    /// Zero keeps the PhysX default.
    pub gpu_max_rigid_contacts: u32,
    /// Zero keeps the PhysX default.
    pub gpu_max_rigid_patches: u32,
    /// Zero keeps the PhysX default.
    pub gpu_heap_capacity: u32,
    pub gpu_found_lost_pairs_capacity: u32,
    pub gpu_found_lost_aggregate_pairs_capacity: u32,
    pub gpu_total_aggregate_pairs_capacity: u32,
    pub gpu_collision_stack_size: u32,
}

impl Default for WorldConfig {
    fn default() -> Self {
        Self {
            gravity: Vec3::new(0.0, -9.81, 0.0),
            cpu_threads: 4,
            static_friction: 0.5,
            dynamic_friction: 0.5,
            restitution: 0.1,
            contact_report_threshold: 50.0,
            gpu_max_partitions: 8,
            gpu_max_rigid_contacts: 2_097_152,
            gpu_max_rigid_patches: 524_288,
            gpu_heap_capacity: 268_435_456,
            gpu_found_lost_pairs_capacity: 1_048_576,
            gpu_found_lost_aggregate_pairs_capacity: 262_144,
            gpu_total_aggregate_pairs_capacity: 1_048_576,
            gpu_collision_stack_size: 67_108_864,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct StaticBoxDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub half_extents: Vec3,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct HeightfieldDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub rows: u32,
    pub columns: u32,
    pub height_scale: f32,
    pub row_scale: f32,
    pub column_scale: f32,
    pub friction: f32,
    pub restitution: f32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct DynamicBoxDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub half_extents: Vec3,
    pub mass: f32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct DynamicSphereDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub radius: f32,
    pub mass: f32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct CapsulePlayerDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub position: Vec3,
    /// Distance between the capsule's sphere centers.
    pub cylinder_height: f32,
    pub radius: f32,
    pub step_offset: f32,
    pub contact_offset: f32,
    pub slope_limit_radians: f32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct VehicleChassisDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub half_extents: Vec3,
    pub mass: f32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct RaycastRequest {
    pub origin: Vec3,
    pub direction: Vec3,
    pub max_distance: f32,
    pub collision_mask: u32,
    pub ignore_entity_id: u32,
    pub has_ignore_entity: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct RaycastHit {
    pub hit: bool,
    pub entity_id: u32,
    pub user_id: u32,
    pub distance: f32,
    pub position: Vec3,
    pub normal: Vec3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum BodyKind {
    StaticBox = 1,
    Heightfield = 2,
    DynamicBox = 3,
    DynamicSphere = 4,
    VehicleChassis = 5,
}

impl BodyKind {
    #[cfg(feature = "gpu")]
    fn from_ffi(value: u8) -> Self {
        match value {
            1 => Self::StaticBox,
            2 => Self::Heightfield,
            3 => Self::DynamicBox,
            4 => Self::DynamicSphere,
            5 => Self::VehicleChassis,
            _ => unreachable!("C++ returned invalid body kind {value}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct BodySnapshot {
    pub entity_id: u32,
    pub user_id: u32,
    pub kind: BodyKind,
    pub sleeping: bool,
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct PlayerSnapshot {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub velocity: Vec3,
    pub grounded: bool,
    pub support_entity_id: u32,
    pub has_support: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct VehicleSnapshot {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub sleeping: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct WorldStats {
    pub body_count: u32,
    pub player_count: u32,
    pub vehicle_count: u32,
    pub active_dynamic_bodies: u32,
    pub active_kinematic_bodies: u32,
    pub contact_pairs: u32,
    pub gpu_rigid_contact_high_water: u32,
    pub gpu_rigid_patch_high_water: u32,
    pub last_step_ms: f32,
    pub last_controller_ms: f32,
    pub last_simulate_ms: f32,
    pub last_fetch_ms: f32,
    pub last_gpu_wait_ms: f32,
    pub last_fetch_copy_ms: f32,
    pub completed_steps: u64,
    pub gpu_warning_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct ContactEvent {
    pub entity_a: u32,
    pub entity_b: u32,
    pub impulse: Vec3,
    pub point: Vec3,
}

/// One entry of a destructible's stress material table. Strength is authored
/// here; bond area stays pure geometry.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StressMaterialDesc {
    pub compression_elastic: f32,
    pub compression_fatal: f32,
    pub tension_elastic: f32,
    pub tension_fatal: f32,
    pub shear_elastic: f32,
    pub shear_fatal: f32,
}

#[derive(Clone, Debug)]
pub struct DestructibleSettings {
    pub max_solver_iterations_per_frame: u32,
    pub graph_reduction_level: u32,
    pub materials: Vec<StressMaterialDesc>,
    pub maximum_bodies: u32,
    pub maximum_fractures_per_actor_per_tick: u32,
    pub apply_excess_forces: bool,
    pub apply_centrifugal: bool,
    pub excess_force_scale: f32,
    /// Damping on every fracture body. Debris needs more than PhysX's
    /// gameplay-object defaults or a rubble pile jitters forever and, because
    /// PhysX sleeps per contact island, holds its whole pile awake with it.
    pub linear_damping: f32,
    pub angular_damping: f32,
}

impl Default for DestructibleSettings {
    fn default() -> Self {
        Self {
            max_solver_iterations_per_frame: 25,
            graph_reduction_level: 0,
            materials: vec![StressMaterialDesc {
                compression_elastic: 0.008,
                compression_fatal: 0.01,
                tension_elastic: -1.0,
                tension_fatal: -1.0,
                shear_elastic: -1.0,
                shear_fatal: -1.0,
            }],
            maximum_bodies: 48,
            maximum_fractures_per_actor_per_tick: 8,
            apply_excess_forces: true,
            apply_centrifugal: true,
            excess_force_scale: 0.012,
            linear_damping: 0.25,
            angular_damping: 0.35,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChunkNodeDesc {
    pub node_index: u32,
    pub centroid: Vec3,
    pub mass: f32,
    pub volume: f32,
    pub geom_kind: u32,
    pub half_extents: Vec3,
    pub convex_points: Vec<Vec3>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkBondDesc {
    pub bond_index: u32,
    pub node0: u32,
    pub node1: u32,
    pub centroid: Vec3,
    pub normal: Vec3,
    /// Real contact patch (m^2), geometry only.
    pub area: f32,
    /// Index into `DestructibleSettings::materials`; strength lives there.
    pub material: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrokenBondEvent {
    pub structure_id: u32,
    pub bond_id: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkMigrationEvent {
    pub structure_id: u32,
    pub chunk_id: u32,
    pub from_island: u32,
    pub to_island: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IslandBodyEvent {
    pub structure_id: u32,
    pub island_id: u32,
    pub kind: u32,
    pub mass: f32,
    pub position: Vec3,
    pub rotation: Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub chunk_ids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChunkBodySnapshot {
    pub entity_id: u32,
    pub structure_id: u32,
    pub island_id: u32,
    pub position: Vec3,
    pub rotation: Quat,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub sleeping: bool,
    pub kinematic: bool,
    pub node_count: u32,
    pub flags: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DestructionStats {
    pub overstressed_bonds: u32,
    pub contacts_processed: u32,
    pub contacts_dropped: u32,
    pub bond_utilisation_max: f32,
    pub bonds_above_half_utilisation: u32,
    pub structures: u32,
    pub chunk_bodies: u32,
    pub awake_chunk_bodies: u32,
    pub broken_bonds: u32,
    pub stress_solve_ms: f32,
    /// Dynamic bodies dropped from snapshots for lacking an island serial.
    /// Non-zero means the serial tables and the adapter's live bodies disagree.
    pub unmapped_body_skips: u32,
    pub begin_ms: f32,
    pub solve_ms: f32,
    pub end_ms: f32,
    pub readback_ms: f32,
    pub events_ms: f32,
    pub filters_ms: f32,
    pub sleeping_chunk_bodies: u32,
    /// Structures currently solved on the GPU. Zero while the CUDA solver is
    /// compiled in means every graph fell below the bond crossover, or CUDA
    /// init failed and the adapter silently fell back to the CPU solver.
    pub repeated_body_snapshots: u64,
    pub gpu_stress_structures: u32,
    pub gpu_stress_solve_ms: f32,
    /// Contact islands the solver saw, and how many it skipped as settled.
    /// PhysX sleeps per island, so this is the granularity every sleep
    /// decision is really made at -- body counts cannot distinguish one merged
    /// city-block pile from thousands of independent ones.
    pub solver_island_count: u32,
    pub solver_islands_skipped: u32,
    pub sleeping_actors_skipped: u64,
    /// Bodies held kinematic to retire them from the solver, and the flip
    /// counts that produced that level.
    pub frozen_chunk_bodies: u32,
    pub freeze_flips: u64,
    pub unfreeze_flips: u64,
    /// Frozen bodies released because dynamic debris struck them: the
    /// engine-driven wake that keeps a frozen pile responding to collapses.
    pub contact_wakes: u64,
    /// Must stay zero: a frozen body reaching a serial-issuing path would
    /// alias settled rubble onto the structure's kinematic support actor.
    pub frozen_serial_blocks: u64,
    /// Frozen bodies the adapter set dynamic again when they split.
    pub frozen_adapter_releases: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeError {
    Unavailable(String),
    Operation(String),
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "PhysX GPU unavailable: {message}"),
            Self::Operation(message) => write!(f, "PhysX operation failed: {message}"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Returns whether native PhysX support was compiled into this crate.
///
/// This does not claim that CUDA is usable. [`World::new`] performs that
/// runtime validation and fails if a real GPU scene cannot be initialized.
pub const fn gpu_support_compiled() -> bool {
    cfg!(feature = "gpu")
}

pub struct World {
    #[cfg(feature = "gpu")]
    inner: cxx::UniquePtr<ffi::World>,
    #[cfg(not(feature = "gpu"))]
    _stub: (),
}

impl World {
    pub fn new(config: WorldConfig) -> Result<Self, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            let config = ffi::FfiWorldConfig::from(config);
            let inner = ffi::new_world(&config)
                .map_err(|error| BridgeError::Unavailable(error.to_string()))?;
            if inner.is_null() {
                return Err(BridgeError::Unavailable(
                    "native constructor returned a null world".into(),
                ));
            }
            Ok(Self { inner })
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = config;
            Err(stub_unavailable())
        }
    }

    pub fn add_static_box(&mut self, desc: StaticBoxDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_static_box(&desc.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = desc;
            Err(stub_unavailable())
        }
    }

    pub fn add_heightfield(
        &mut self,
        desc: HeightfieldDesc,
        samples: &[f32],
    ) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_heightfield(&desc.into(), samples)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (desc, samples);
            Err(stub_unavailable())
        }
    }

    pub fn add_dynamic_box(&mut self, desc: DynamicBoxDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_dynamic_box(&desc.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = desc;
            Err(stub_unavailable())
        }
    }

    pub fn add_dynamic_sphere(&mut self, desc: DynamicSphereDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_dynamic_sphere(&desc.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = desc;
            Err(stub_unavailable())
        }
    }

    pub fn add_capsule_player(&mut self, desc: CapsulePlayerDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_capsule_player(&desc.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = desc;
            Err(stub_unavailable())
        }
    }

    pub fn add_vehicle_chassis(&mut self, desc: VehicleChassisDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_vehicle_chassis(&desc.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = desc;
            Err(stub_unavailable())
        }
    }

    pub fn remove_actor(&mut self, entity_id: u32) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .remove_actor(entity_id)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = entity_id;
            Err(stub_unavailable())
        }
    }

    pub fn set_user_id(&mut self, entity_id: u32, user_id: u32) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .set_user_id(entity_id, user_id)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, user_id);
            Err(stub_unavailable())
        }
    }

    pub fn apply_impulse(&mut self, entity_id: u32, impulse: Vec3) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .apply_impulse(entity_id, impulse.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, impulse);
            Err(stub_unavailable())
        }
    }

    pub fn apply_impulse_at_point(
        &mut self,
        entity_id: u32,
        impulse: Vec3,
        point: Vec3,
    ) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .apply_impulse_at_point(entity_id, impulse.into(), point.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, impulse, point);
            Err(stub_unavailable())
        }
    }

    pub fn wake_bodies_near(&mut self, center: Vec3, radius: f32) -> Result<u32, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .wake_bodies_near(center.into(), radius)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (center, radius);
            Err(stub_unavailable())
        }
    }

    pub fn drive_vehicle(
        &mut self,
        entity_id: u32,
        throttle: f32,
        steer: f32,
        brake: f32,
    ) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .drive_vehicle(entity_id, throttle, steer, brake)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, throttle, steer, brake);
            Err(stub_unavailable())
        }
    }

    /// Moves a capsule controller before the next fixed simulation step.
    pub fn move_player(&mut self, entity_id: u32, displacement: Vec3) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .move_player(entity_id, displacement.into(), FIXED_TIMESTEP)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, displacement);
            Err(stub_unavailable())
        }
    }

    /// Dispatches the simulation without waiting for it.
    ///
    /// With GPU dynamics this only enqueues work, so the caller can run CPU
    /// work before calling `end_step`. Every `begin_step` must be paired with
    /// exactly one `end_step` before the scene is read or mutated.
    pub fn begin_step(&mut self) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner.pin_mut().begin_step().map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    /// Waits for the dispatched simulation and fetches its results.
    pub fn end_step(&mut self) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner.pin_mut().end_step().map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    /// Advances the scene by exactly 1/60 second.
    pub fn step(&mut self) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner.pin_mut().step().map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    pub fn raycast(&self, request: RaycastRequest) -> Result<RaycastHit, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .raycast(&request.into())
                .map(Into::into)
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = request;
            Err(stub_unavailable())
        }
    }

    pub fn body_snapshots(&self) -> Result<Vec<BodySnapshot>, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            Ok(self
                .inner
                .body_snapshots()
                .map_err(operation_error)?
                .into_iter()
                .map(Into::into)
                .collect())
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    pub fn player_snapshots(&self) -> Result<Vec<PlayerSnapshot>, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            Ok(self
                .inner
                .player_snapshots()
                .map_err(operation_error)?
                .into_iter()
                .map(Into::into)
                .collect())
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    pub fn vehicle_snapshots(&self) -> Result<Vec<VehicleSnapshot>, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            Ok(self
                .inner
                .vehicle_snapshots()
                .map_err(operation_error)?
                .into_iter()
                .map(Into::into)
                .collect())
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    pub fn stats(&self) -> Result<WorldStats, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner.stats().map(Into::into).map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    pub fn take_contact_events(&mut self) -> Result<Vec<ContactEvent>, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            Ok(self
                .inner
                .pin_mut()
                .take_contact_events()
                .map_err(operation_error)?
                .into_iter()
                .map(Into::into)
                .collect())
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    #[cfg(feature = "destruction")]
    pub fn create_destructible(
        &mut self,
        structure_id: u32,
        pose: Pose,
        nodes: &[ChunkNodeDesc],
        bonds: &[ChunkBondDesc],
        settings: DestructibleSettings,
        collision_group: u32,
        collision_mask: u32,
    ) -> Result<(), BridgeError> {
        let ffi_nodes: Vec<ffi::FfiChunkNodeDesc> = nodes.iter().cloned().map(Into::into).collect();
        let ffi_bonds: Vec<ffi::FfiChunkBondDesc> = bonds.iter().cloned().map(Into::into).collect();
        self.inner
            .pin_mut()
            .create_destructible(
                structure_id,
                &pose.into(),
                &ffi_nodes,
                &ffi_bonds,
                &settings.into(),
                collision_group,
                collision_mask,
            )
            .map_err(operation_error)
    }

    /// Release every destructible and its PhysX actors. The caller rebuilds by
    /// re-issuing create_destructible; this is how the city is reset without
    /// restarting the process.
    #[cfg(feature = "destruction")]
    pub fn clear_destructibles(&mut self) -> Result<(), BridgeError> {
        self.inner.pin_mut().clear_destructibles().map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn destruction_tick(&mut self, dt: f32, gravity: Vec3) -> Result<(), BridgeError> {
        self.inner
            .pin_mut()
            .destruction_tick(dt, gravity.into())
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn queue_chunk_damage(
        &mut self,
        structure_id: u32,
        chunk_id: u32,
        impulse: Vec3,
        point: Vec3,
    ) -> Result<(), BridgeError> {
        self.inner
            .pin_mut()
            .queue_chunk_damage(structure_id, chunk_id, impulse.into(), point.into())
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn apply_destruction_explosion(
        &mut self,
        center: Vec3,
        radius: f32,
        impulse_magnitude: f32,
    ) -> Result<u32, BridgeError> {
        self.inner
            .pin_mut()
            .apply_destruction_explosion(center.into(), radius, impulse_magnitude)
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn apply_destruction_blast(
        &mut self,
        center: Vec3,
        direction: Vec3,
        radius: f32,
        stress_impulse: f32,
        push_impulse: f32,
    ) -> Result<u32, BridgeError> {
        self.inner
            .pin_mut()
            .apply_destruction_blast(
                center.into(),
                direction.into(),
                radius,
                stress_impulse,
                push_impulse,
            )
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn take_broken_bonds(&mut self) -> Result<Vec<BrokenBondEvent>, BridgeError> {
        Ok(self
            .inner
            .pin_mut()
            .take_broken_bonds()
            .map_err(operation_error)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    #[cfg(feature = "destruction")]
    pub fn take_chunk_migrations(&mut self) -> Result<Vec<ChunkMigrationEvent>, BridgeError> {
        Ok(self
            .inner
            .pin_mut()
            .take_chunk_migrations()
            .map_err(operation_error)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    #[cfg(feature = "destruction")]
    pub fn take_island_events(&mut self) -> Result<Vec<IslandBodyEvent>, BridgeError> {
        Ok(self
            .inner
            .pin_mut()
            .take_island_events()
            .map_err(operation_error)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// This tick's chunk body snapshots, borrowed from the bridge.
    ///
    /// Borrowed rather than collected: at 10k bodies the previous signature
    /// copied ~760 KB out of C++ and then again into a Rust Vec, every tick.
    /// Valid until the next call.
    #[cfg(feature = "destruction")]
    pub fn chunk_body_snapshots(&self) -> Result<&[ffi::FfiChunkBodySnapshot], BridgeError> {
        self.inner.chunk_body_snapshots().map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn sleep_chunk_body(&mut self, entity_id: u32) -> Result<(), BridgeError> {
        self.inner
            .pin_mut()
            .sleep_chunk_body(entity_id)
            .map_err(operation_error)
    }

    /// Retire settled debris from the rigid-body solver by making it
    /// kinematic, and release it again.
    ///
    /// See `DestructionManager::freeze_chunk_bodies`: a kinematic pile has no
    /// contact island to wake, which is what stops one rifle round costing a
    /// whole city block's simulation. Both calls are idempotent and skip ids
    /// they do not recognise, because the caller's picture of what is live is
    /// a tick old by construction. Returns bodies actually changed.
    #[cfg(feature = "destruction")]
    pub fn freeze_chunk_bodies(&mut self, entity_ids: &[u32]) -> Result<u32, BridgeError> {
        self.inner
            .pin_mut()
            .freeze_chunk_bodies(entity_ids)
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn unfreeze_chunk_bodies(&mut self, entity_ids: &[u32]) -> Result<u32, BridgeError> {
        self.inner
            .pin_mut()
            .unfreeze_chunk_bodies(entity_ids)
            .map_err(operation_error)
    }

    /// Frozen bodies that dynamic debris struck since the last drain.
    ///
    /// The engine's own contact reports are the signal: PhysX wakes a
    /// sleeping body that is hit, but a frozen body is kinematic and has no
    /// sleep state, so this is how "a moving body wakes what it strikes" is
    /// restored for retired rubble. Drained once per tick; the caller
    /// unfreezes the result so the pile responds to a collapse landing on it
    /// instead of behaving like bedrock.
    #[cfg(feature = "destruction")]
    pub fn take_frozen_contact_wakes(&mut self) -> Result<Vec<u32>, BridgeError> {
        self.inner
            .pin_mut()
            .take_frozen_contact_wakes()
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn destruction_stats(&self) -> Result<DestructionStats, BridgeError> {
        self.inner
            .destruction_stats()
            .map(Into::into)
            .map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn validate_destruction_mappings(&self) -> Result<bool, BridgeError> {
        self.inner
            .validate_destruction_mappings()
            .map_err(operation_error)
    }
}

#[cfg(not(feature = "gpu"))]
fn stub_unavailable() -> BridgeError {
    BridgeError::Unavailable("crate was built without feature `gpu`".into())
}

#[cfg(feature = "gpu")]
fn operation_error(error: cxx::Exception) -> BridgeError {
    BridgeError::Operation(error.to_string())
}

#[cfg(feature = "gpu")]
#[cxx::bridge(namespace = "vibe_land::physx_bridge")]
mod ffi {
    struct FfiVec3 {
        x: f32,
        y: f32,
        z: f32,
    }

    struct FfiQuat {
        x: f32,
        y: f32,
        z: f32,
        w: f32,
    }

    struct FfiPose {
        position: FfiVec3,
        rotation: FfiQuat,
    }

    struct FfiWorldConfig {
        gravity: FfiVec3,
        cpu_threads: u32,
        static_friction: f32,
        dynamic_friction: f32,
        restitution: f32,
        contact_report_threshold: f32,
        gpu_max_partitions: u32,
        gpu_max_rigid_contacts: u32,
        gpu_max_rigid_patches: u32,
        gpu_heap_capacity: u32,
        gpu_found_lost_pairs_capacity: u32,
        gpu_found_lost_aggregate_pairs_capacity: u32,
        gpu_total_aggregate_pairs_capacity: u32,
        gpu_collision_stack_size: u32,
    }

    struct FfiStaticBoxDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        half_extents: FfiVec3,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiHeightfieldDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        rows: u32,
        columns: u32,
        height_scale: f32,
        row_scale: f32,
        column_scale: f32,
        friction: f32,
        restitution: f32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiDynamicBoxDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        half_extents: FfiVec3,
        mass: f32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiDynamicSphereDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        radius: f32,
        mass: f32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiCapsulePlayerDesc {
        entity_id: u32,
        user_id: u32,
        position: FfiVec3,
        cylinder_height: f32,
        radius: f32,
        step_offset: f32,
        contact_offset: f32,
        slope_limit_radians: f32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiVehicleChassisDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        half_extents: FfiVec3,
        mass: f32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiRaycastRequest {
        origin: FfiVec3,
        direction: FfiVec3,
        max_distance: f32,
        collision_mask: u32,
        ignore_entity_id: u32,
        has_ignore_entity: bool,
    }

    struct FfiRaycastHit {
        hit: bool,
        entity_id: u32,
        user_id: u32,
        distance: f32,
        position: FfiVec3,
        normal: FfiVec3,
    }

    struct FfiBodySnapshot {
        entity_id: u32,
        user_id: u32,
        kind: u8,
        sleeping: bool,
        pose: FfiPose,
        linear_velocity: FfiVec3,
        angular_velocity: FfiVec3,
    }

    struct FfiPlayerSnapshot {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        velocity: FfiVec3,
        grounded: bool,
        support_entity_id: u32,
        has_support: bool,
    }

    struct FfiVehicleSnapshot {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        linear_velocity: FfiVec3,
        angular_velocity: FfiVec3,
        sleeping: bool,
    }

    struct FfiWorldStats {
        body_count: u32,
        player_count: u32,
        vehicle_count: u32,
        active_dynamic_bodies: u32,
        active_kinematic_bodies: u32,
        contact_pairs: u32,
        gpu_rigid_contact_high_water: u32,
        gpu_rigid_patch_high_water: u32,
        last_step_ms: f32,
        /// Phases of the step. With GPU dynamics `simulate` only dispatches,
        /// so `fetch` carries GPU compute plus result readback.
        last_controller_ms: f32,
        last_simulate_ms: f32,
        last_fetch_ms: f32,
        /// Only populated when VIBE_PHYSX_PROFILE_FETCH=1: time waiting on the
        /// GPU versus the cost of the call that copies results back.
        last_gpu_wait_ms: f32,
        last_fetch_copy_ms: f32,
        completed_steps: u64,
        gpu_warning_count: u32,
    }

    struct FfiContactEvent {
        entity_a: u32,
        entity_b: u32,
        impulse: FfiVec3,
        point: FfiVec3,
    }

    /// One entry of a destructible's stress material table.
    struct FfiStressMaterial {
        compression_elastic: f32,
        compression_fatal: f32,
        tension_elastic: f32,
        tension_fatal: f32,
        shear_elastic: f32,
        shear_fatal: f32,
    }

    struct FfiDestructibleSettings {
        max_solver_iterations_per_frame: u32,
        graph_reduction_level: u32,
        /// Indexed by `FfiChunkBondDesc::material`; must have >= 1 entry.
        materials: Vec<FfiStressMaterial>,
        maximum_bodies: u32,
        maximum_fractures_per_actor_per_tick: u32,
        apply_excess_forces: bool,
        apply_centrifugal: bool,
        excess_force_scale: f32,
        linear_damping: f32,
        angular_damping: f32,
    }

    struct FfiChunkNodeDesc {
        node_index: u32,
        centroid: FfiVec3,
        mass: f32,
        volume: f32,
        /// 0 = cuboid, 1 = convex hull
        geom_kind: u32,
        half_extents: FfiVec3,
        convex_points: Vec<FfiVec3>,
    }

    struct FfiChunkBondDesc {
        bond_index: u32,
        node0: u32,
        node1: u32,
        centroid: FfiVec3,
        normal: FfiVec3,
        area: f32,
        /// Index into `FfiDestructibleSettings::materials`.
        material: u32,
    }

    struct FfiBrokenBondEvent {
        structure_id: u32,
        bond_id: u32,
    }

    struct FfiChunkMigrationEvent {
        structure_id: u32,
        chunk_id: u32,
        from_island: u32,
        to_island: u32,
    }

    struct FfiIslandBodyEvent {
        structure_id: u32,
        island_id: u32,
        /// 0 = promoted, 1 = retired
        kind: u32,
        mass: f32,
        position: FfiVec3,
        rotation: FfiQuat,
        linear_velocity: FfiVec3,
        angular_velocity: FfiVec3,
        chunk_ids: Vec<u32>,
    }

    struct FfiChunkBodySnapshot {
        entity_id: u32,
        structure_id: u32,
        island_id: u32,
        position: FfiVec3,
        rotation: FfiQuat,
        linear_velocity: FfiVec3,
        angular_velocity: FfiVec3,
        sleeping: bool,
        kinematic: bool,
        node_count: u32,
        flags: u32,
    }

    struct FfiDestructionStats {
        overstressed_bonds: u32,
        contacts_processed: u32,
        contacts_dropped: u32,
        bond_utilisation_max: f32,
        bonds_above_half_utilisation: u32,
        structures: u32,
        chunk_bodies: u32,
        awake_chunk_bodies: u32,
        broken_bonds: u32,
        stress_solve_ms: f32,
        /// Dynamic bodies dropped from snapshots for lacking an island serial.
        /// Non-zero means the serial tables disagree with the adapter's live
        /// bodies, which previously aliased ids and killed the match loop.
        unmapped_body_skips: u32,
        /// beginTick + solveTick + endTick (the actual stress solve).
        begin_ms: f32,
        solve_ms: f32,
        end_ms: f32,
        /// GPU->CPU snapshot readback.
        readback_ms: f32,
        /// Membership diffing and event collection.
        events_ms: f32,
        /// Filter/property stamping for new or migrated bodies and shapes.
        filters_ms: f32,
        sleeping_chunk_bodies: u32,
        repeated_body_snapshots: u64,
        gpu_stress_structures: u32,
        gpu_stress_solve_ms: f32,
        /// PhysX contact islands the solver saw, and how many it skipped for
        /// being settled. This is the unit PhysX actually sleeps on, so it is
        /// the number that says whether a rubble field is thousands of
        /// independent islands or one merged block that can only sleep or wake
        /// as a whole. Body counts cannot distinguish those.
        solver_island_count: u32,
        solver_islands_skipped: u32,
        sleeping_actors_skipped: u64,
        /// Bodies the bridge is holding kinematic, out of the solver.
        frozen_chunk_bodies: u32,
        /// Must stay zero: a frozen body reaching a serial-issuing path would
        /// alias settled rubble onto the structure's support actor.
        frozen_serial_blocks: u64,
        /// Frozen bodies the adapter set dynamic again when they split.
        frozen_adapter_releases: u64,
        freeze_flips: u64,
        unfreeze_flips: u64,
        /// Frozen bodies released because dynamic debris struck them.
        contact_wakes: u64,
    }

    unsafe extern "C++" {
        include!("physx_bridge.h");

        type World;

        fn new_world(config: &FfiWorldConfig) -> Result<UniquePtr<World>>;

        fn add_static_box(self: Pin<&mut World>, desc: &FfiStaticBoxDesc) -> Result<()>;
        fn add_heightfield(
            self: Pin<&mut World>,
            desc: &FfiHeightfieldDesc,
            samples: &[f32],
        ) -> Result<()>;
        fn add_dynamic_box(self: Pin<&mut World>, desc: &FfiDynamicBoxDesc) -> Result<()>;
        fn add_dynamic_sphere(self: Pin<&mut World>, desc: &FfiDynamicSphereDesc) -> Result<()>;
        fn add_capsule_player(self: Pin<&mut World>, desc: &FfiCapsulePlayerDesc) -> Result<()>;
        fn add_vehicle_chassis(self: Pin<&mut World>, desc: &FfiVehicleChassisDesc) -> Result<()>;
        fn remove_actor(self: Pin<&mut World>, entity_id: u32) -> Result<()>;
        fn set_user_id(self: Pin<&mut World>, entity_id: u32, user_id: u32) -> Result<()>;
        fn apply_impulse(self: Pin<&mut World>, entity_id: u32, impulse: FfiVec3) -> Result<()>;
        fn apply_impulse_at_point(
            self: Pin<&mut World>,
            entity_id: u32,
            impulse: FfiVec3,
            point: FfiVec3,
        ) -> Result<()>;
        fn wake_bodies_near(self: Pin<&mut World>, center: FfiVec3, radius: f32) -> Result<u32>;
        fn drive_vehicle(
            self: Pin<&mut World>,
            entity_id: u32,
            throttle: f32,
            steer: f32,
            brake: f32,
        ) -> Result<()>;
        fn move_player(
            self: Pin<&mut World>,
            entity_id: u32,
            displacement: FfiVec3,
            elapsed_time: f32,
        ) -> Result<()>;
        fn step(self: Pin<&mut World>) -> Result<()>;
        fn begin_step(self: Pin<&mut World>) -> Result<()>;
        fn end_step(self: Pin<&mut World>) -> Result<()>;

        fn raycast(self: &World, request: &FfiRaycastRequest) -> Result<FfiRaycastHit>;
        fn body_snapshots(self: &World) -> Result<Vec<FfiBodySnapshot>>;
        fn player_snapshots(self: &World) -> Result<Vec<FfiPlayerSnapshot>>;
        fn vehicle_snapshots(self: &World) -> Result<Vec<FfiVehicleSnapshot>>;
        fn stats(self: &World) -> Result<FfiWorldStats>;
        fn take_contact_events(self: Pin<&mut World>) -> Result<Vec<FfiContactEvent>>;

        fn create_destructible(
            self: Pin<&mut World>,
            structure_id: u32,
            pose: &FfiPose,
            nodes: &[FfiChunkNodeDesc],
            bonds: &[FfiChunkBondDesc],
            settings: &FfiDestructibleSettings,
            collision_group: u32,
            collision_mask: u32,
        ) -> Result<()>;
        fn clear_destructibles(self: Pin<&mut World>) -> Result<()>;
        fn destruction_tick(self: Pin<&mut World>, dt: f32, gravity: FfiVec3) -> Result<()>;
        fn queue_chunk_damage(
            self: Pin<&mut World>,
            structure_id: u32,
            chunk_id: u32,
            impulse: FfiVec3,
            point: FfiVec3,
        ) -> Result<()>;
        fn apply_destruction_explosion(
            self: Pin<&mut World>,
            center: FfiVec3,
            radius: f32,
            impulse_magnitude: f32,
        ) -> Result<u32>;
        fn apply_destruction_blast(
            self: Pin<&mut World>,
            center: FfiVec3,
            direction: FfiVec3,
            radius: f32,
            stress_impulse: f32,
            push_impulse: f32,
        ) -> Result<u32>;
        fn take_broken_bonds(self: Pin<&mut World>) -> Result<Vec<FfiBrokenBondEvent>>;
        fn take_chunk_migrations(self: Pin<&mut World>) -> Result<Vec<FfiChunkMigrationEvent>>;
        fn take_island_events(self: Pin<&mut World>) -> Result<Vec<FfiIslandBodyEvent>>;
        fn chunk_body_snapshots(self: &World) -> Result<&[FfiChunkBodySnapshot]>;
        fn sleep_chunk_body(self: Pin<&mut World>, entity_id: u32) -> Result<()>;
        fn freeze_chunk_bodies(self: Pin<&mut World>, entity_ids: &[u32]) -> Result<u32>;
        fn unfreeze_chunk_bodies(self: Pin<&mut World>, entity_ids: &[u32]) -> Result<u32>;
        fn take_frozen_contact_wakes(self: Pin<&mut World>) -> Result<Vec<u32>>;
        fn destruction_stats(self: &World) -> Result<FfiDestructionStats>;
        fn validate_destruction_mappings(self: &World) -> Result<bool>;
    }
}

#[cfg(feature = "gpu")]
macro_rules! impl_ffi_from {
    ($rust:ty, $ffi:ty { $($field:ident),+ $(,)? }) => {
        impl From<$rust> for $ffi {
            fn from(value: $rust) -> Self {
                Self { $($field: value.$field.into()),+ }
            }
        }
    };
}

#[cfg(feature = "gpu")]
impl_ffi_from!(Vec3, ffi::FfiVec3 { x, y, z });
#[cfg(feature = "gpu")]
impl_ffi_from!(Quat, ffi::FfiQuat { x, y, z, w });
#[cfg(feature = "gpu")]
impl_ffi_from!(Pose, ffi::FfiPose { position, rotation });
#[cfg(feature = "gpu")]
impl_ffi_from!(
    WorldConfig,
    ffi::FfiWorldConfig {
        gravity,
        cpu_threads,
        static_friction,
        dynamic_friction,
        restitution,
        contact_report_threshold,
        gpu_max_partitions,
        gpu_max_rigid_contacts,
        gpu_max_rigid_patches,
        gpu_heap_capacity,
        gpu_found_lost_pairs_capacity,
        gpu_found_lost_aggregate_pairs_capacity,
        gpu_total_aggregate_pairs_capacity,
        gpu_collision_stack_size,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    StaticBoxDesc,
    ffi::FfiStaticBoxDesc {
        entity_id,
        user_id,
        pose,
        half_extents,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    HeightfieldDesc,
    ffi::FfiHeightfieldDesc {
        entity_id,
        user_id,
        pose,
        rows,
        columns,
        height_scale,
        row_scale,
        column_scale,
        friction,
        restitution,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    DynamicBoxDesc,
    ffi::FfiDynamicBoxDesc {
        entity_id,
        user_id,
        pose,
        half_extents,
        mass,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    DynamicSphereDesc,
    ffi::FfiDynamicSphereDesc {
        entity_id,
        user_id,
        pose,
        radius,
        mass,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    CapsulePlayerDesc,
    ffi::FfiCapsulePlayerDesc {
        entity_id,
        user_id,
        position,
        cylinder_height,
        radius,
        step_offset,
        contact_offset,
        slope_limit_radians,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    VehicleChassisDesc,
    ffi::FfiVehicleChassisDesc {
        entity_id,
        user_id,
        pose,
        half_extents,
        mass,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    RaycastRequest,
    ffi::FfiRaycastRequest {
        origin,
        direction,
        max_distance,
        collision_mask,
        ignore_entity_id,
        has_ignore_entity,
    }
);

#[cfg(feature = "gpu")]
impl From<ffi::FfiVec3> for Vec3 {
    fn from(value: ffi::FfiVec3) -> Self {
        Self::new(value.x, value.y, value.z)
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiQuat> for Quat {
    fn from(value: ffi::FfiQuat) -> Self {
        Self {
            x: value.x,
            y: value.y,
            z: value.z,
            w: value.w,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiPose> for Pose {
    fn from(value: ffi::FfiPose) -> Self {
        Self {
            position: value.position.into(),
            rotation: value.rotation.into(),
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiRaycastHit> for RaycastHit {
    fn from(value: ffi::FfiRaycastHit) -> Self {
        Self {
            hit: value.hit,
            entity_id: value.entity_id,
            user_id: value.user_id,
            distance: value.distance,
            position: value.position.into(),
            normal: value.normal.into(),
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiBodySnapshot> for BodySnapshot {
    fn from(value: ffi::FfiBodySnapshot) -> Self {
        Self {
            entity_id: value.entity_id,
            user_id: value.user_id,
            kind: BodyKind::from_ffi(value.kind),
            sleeping: value.sleeping,
            pose: value.pose.into(),
            linear_velocity: value.linear_velocity.into(),
            angular_velocity: value.angular_velocity.into(),
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiPlayerSnapshot> for PlayerSnapshot {
    fn from(value: ffi::FfiPlayerSnapshot) -> Self {
        Self {
            entity_id: value.entity_id,
            user_id: value.user_id,
            pose: value.pose.into(),
            velocity: value.velocity.into(),
            grounded: value.grounded,
            support_entity_id: value.support_entity_id,
            has_support: value.has_support,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiVehicleSnapshot> for VehicleSnapshot {
    fn from(value: ffi::FfiVehicleSnapshot) -> Self {
        Self {
            entity_id: value.entity_id,
            user_id: value.user_id,
            pose: value.pose.into(),
            linear_velocity: value.linear_velocity.into(),
            angular_velocity: value.angular_velocity.into(),
            sleeping: value.sleeping,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiWorldStats> for WorldStats {
    fn from(value: ffi::FfiWorldStats) -> Self {
        Self {
            body_count: value.body_count,
            player_count: value.player_count,
            vehicle_count: value.vehicle_count,
            active_dynamic_bodies: value.active_dynamic_bodies,
            active_kinematic_bodies: value.active_kinematic_bodies,
            contact_pairs: value.contact_pairs,
            gpu_rigid_contact_high_water: value.gpu_rigid_contact_high_water,
            gpu_rigid_patch_high_water: value.gpu_rigid_patch_high_water,
            last_step_ms: value.last_step_ms,
            last_controller_ms: value.last_controller_ms,
            last_simulate_ms: value.last_simulate_ms,
            last_fetch_ms: value.last_fetch_ms,
            last_gpu_wait_ms: value.last_gpu_wait_ms,
            last_fetch_copy_ms: value.last_fetch_copy_ms,
            completed_steps: value.completed_steps,
            gpu_warning_count: value.gpu_warning_count,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiContactEvent> for ContactEvent {
    fn from(value: ffi::FfiContactEvent) -> Self {
        Self {
            entity_a: value.entity_a,
            entity_b: value.entity_b,
            impulse: value.impulse.into(),
            point: value.point.into(),
        }
    }
}

#[cfg(feature = "destruction")]
impl From<DestructibleSettings> for ffi::FfiDestructibleSettings {
    fn from(value: DestructibleSettings) -> Self {
        Self {
            max_solver_iterations_per_frame: value.max_solver_iterations_per_frame,
            graph_reduction_level: value.graph_reduction_level,
            materials: value
                .materials
                .into_iter()
                .map(|material| ffi::FfiStressMaterial {
                    compression_elastic: material.compression_elastic,
                    compression_fatal: material.compression_fatal,
                    tension_elastic: material.tension_elastic,
                    tension_fatal: material.tension_fatal,
                    shear_elastic: material.shear_elastic,
                    shear_fatal: material.shear_fatal,
                })
                .collect(),
            maximum_bodies: value.maximum_bodies,
            maximum_fractures_per_actor_per_tick: value.maximum_fractures_per_actor_per_tick,
            apply_excess_forces: value.apply_excess_forces,
            apply_centrifugal: value.apply_centrifugal,
            excess_force_scale: value.excess_force_scale,
            linear_damping: value.linear_damping,
            angular_damping: value.angular_damping,
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ChunkNodeDesc> for ffi::FfiChunkNodeDesc {
    fn from(value: ChunkNodeDesc) -> Self {
        Self {
            node_index: value.node_index,
            centroid: value.centroid.into(),
            mass: value.mass,
            volume: value.volume,
            geom_kind: value.geom_kind,
            half_extents: value.half_extents.into(),
            convex_points: value
                .convex_points
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ChunkBondDesc> for ffi::FfiChunkBondDesc {
    fn from(value: ChunkBondDesc) -> Self {
        Self {
            bond_index: value.bond_index,
            node0: value.node0,
            node1: value.node1,
            centroid: value.centroid.into(),
            normal: value.normal.into(),
            area: value.area,
            material: value.material,
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ffi::FfiBrokenBondEvent> for BrokenBondEvent {
    fn from(value: ffi::FfiBrokenBondEvent) -> Self {
        Self {
            structure_id: value.structure_id,
            bond_id: value.bond_id,
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ffi::FfiChunkMigrationEvent> for ChunkMigrationEvent {
    fn from(value: ffi::FfiChunkMigrationEvent) -> Self {
        Self {
            structure_id: value.structure_id,
            chunk_id: value.chunk_id,
            from_island: value.from_island,
            to_island: value.to_island,
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ffi::FfiIslandBodyEvent> for IslandBodyEvent {
    fn from(value: ffi::FfiIslandBodyEvent) -> Self {
        Self {
            structure_id: value.structure_id,
            island_id: value.island_id,
            kind: value.kind,
            mass: value.mass,
            position: value.position.into(),
            rotation: value.rotation.into(),
            linear_velocity: value.linear_velocity.into(),
            angular_velocity: value.angular_velocity.into(),
            chunk_ids: value.chunk_ids.into_iter().collect(),
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ffi::FfiChunkBodySnapshot> for ChunkBodySnapshot {
    fn from(value: ffi::FfiChunkBodySnapshot) -> Self {
        Self {
            entity_id: value.entity_id,
            structure_id: value.structure_id,
            island_id: value.island_id,
            position: value.position.into(),
            rotation: value.rotation.into(),
            linear_velocity: value.linear_velocity.into(),
            angular_velocity: value.angular_velocity.into(),
            sleeping: value.sleeping,
            kinematic: value.kinematic,
            node_count: value.node_count,
            flags: value.flags,
        }
    }
}

#[cfg(feature = "destruction")]
impl From<ffi::FfiDestructionStats> for DestructionStats {
    fn from(value: ffi::FfiDestructionStats) -> Self {
        Self {
            overstressed_bonds: value.overstressed_bonds,
            contacts_processed: value.contacts_processed,
            contacts_dropped: value.contacts_dropped,
            bond_utilisation_max: value.bond_utilisation_max,
            bonds_above_half_utilisation: value.bonds_above_half_utilisation,
            structures: value.structures,
            chunk_bodies: value.chunk_bodies,
            awake_chunk_bodies: value.awake_chunk_bodies,
            broken_bonds: value.broken_bonds,
            stress_solve_ms: value.stress_solve_ms,
            unmapped_body_skips: value.unmapped_body_skips,
            begin_ms: value.begin_ms,
            solve_ms: value.solve_ms,
            end_ms: value.end_ms,
            readback_ms: value.readback_ms,
            events_ms: value.events_ms,
            filters_ms: value.filters_ms,
            sleeping_chunk_bodies: value.sleeping_chunk_bodies,
            repeated_body_snapshots: value.repeated_body_snapshots,
            gpu_stress_structures: value.gpu_stress_structures,
            gpu_stress_solve_ms: value.gpu_stress_solve_ms,
            solver_island_count: value.solver_island_count,
            solver_islands_skipped: value.solver_islands_skipped,
            sleeping_actors_skipped: value.sleeping_actors_skipped,
            frozen_chunk_bodies: value.frozen_chunk_bodies,
            freeze_flips: value.freeze_flips,
            unfreeze_flips: value.unfreeze_flips,
            contact_wakes: value.contact_wakes,
            frozen_serial_blocks: value.frozen_serial_blocks,
            frozen_adapter_releases: value.frozen_adapter_releases,
        }
    }
}
