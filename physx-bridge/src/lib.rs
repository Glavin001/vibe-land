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
        completed_steps: u64,
        gpu_warning_count: u32,
    }

    struct FfiContactEvent {
        entity_a: u32,
        entity_b: u32,
        impulse: FfiVec3,
        point: FfiVec3,
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

        fn raycast(self: &World, request: &FfiRaycastRequest) -> Result<FfiRaycastHit>;
        fn body_snapshots(self: &World) -> Result<Vec<FfiBodySnapshot>>;
        fn player_snapshots(self: &World) -> Result<Vec<FfiPlayerSnapshot>>;
        fn vehicle_snapshots(self: &World) -> Result<Vec<FfiVehicleSnapshot>>;
        fn stats(self: &World) -> Result<FfiWorldStats>;
        fn take_contact_events(self: Pin<&mut World>) -> Result<Vec<FfiContactEvent>>;
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
