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

/// Read an f32 from the environment, falling back to `default`.
fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}

/// World gravity magnitude, m/s^2. Default 9.81.
///
/// One world, one gravity, and the important half of that is still ONE. This
/// scene once ran the player at 20 and every rigid body at 9.81, so the player
/// was the only reference the eye had and all debris read as falling in slow
/// motion -- an 84 m drop taking 4.1 s instead of 2.9. The fix was to make them
/// agree, and they must keep agreeing: city_bench asserts it, because feeding
/// the stress solver one gravity inside a PhysX scene integrating another is a
/// combination production never runs.
///
/// They now agree at Earth's. The 20 m/s^2 they agreed at before was the Source
/// engine's `sv_gravity 800` convention, adopted because 9.81 felt floaty --
/// which removing linear damping addressed on its own. What it cost was the
/// buildings: every structure here is designed for 9.81, and at 20 a parking
/// deck sits at 99% of its cracking stress with no safety factor, so realistic
/// concrete cracked it under its own weight.
///
/// Override with VIBE_WORLD_GRAVITY (a positive magnitude).
pub fn world_gravity_magnitude() -> f32 {
    // Earth. Must match MoveConfig::default().gravity -- city_bench asserts
    // they agree, because feeding the stress solver one gravity inside a PhysX
    // scene integrating another is a combination production never runs.
    env_f32("VIBE_WORLD_GRAVITY", 9.81).abs()
}

impl Default for WorldConfig {
    fn default() -> Self {
        Self {
            gravity: Vec3::new(0.0, -world_gravity_magnitude(), 0.0),
            cpu_threads: 4,
            // Contact response, which is where debris should actually lose
            // energy -- on impact, not while falling through empty air.
            // Concrete on concrete is roughly 0.6-0.8 friction and barely
            // rebounds. Overridable so the feel can be dialled without a
            // rebuild: VIBE_WORLD_FRICTION, VIBE_WORLD_RESTITUTION.
            static_friction: env_f32("VIBE_WORLD_FRICTION", 0.5),
            dynamic_friction: env_f32("VIBE_WORLD_FRICTION", 0.5),
            restitution: env_f32("VIBE_WORLD_RESTITUTION", 0.1),
            contact_report_threshold: 50.0,
            gpu_max_partitions: 8,
            // Sized for a city coming down, not for a match.
            //
            // These were 2M contacts, 2M patches, a 256 MB heap, 1M found/lost
            // pairs and a 64 MB collision stack -- comfortable for a two-tower
            // collapse and not for eight thousand simultaneously-colliding
            // fragments. Overflowing PhysX's GPU collision stack or pair
            // buffers is not a clean failure: what it produced was an illegal
            // memory access inside GPU narrowphase (`Synchronizing GPU
            // Narrowphase failed! 700`), which poisons the CUDA context for the
            // life of the process. From a player's side that is the match
            // ending mid-collapse, repeatedly, at around 8,700 chunk bodies.
            //
            // Raised well past the observed peak rather than to it. The card
            // has 24 GB and the scene was using 1.8, so headroom was never the
            // constraint -- the numbers had simply never been raised past what
            // a smaller scene needed. Every one is still overridable by its
            // VIBE_PHYSX_GPU_* environment variable.
            gpu_max_rigid_contacts: 8_388_608,
            gpu_max_rigid_patches: 8_388_608,
            gpu_heap_capacity: 2_147_483_648,
            gpu_found_lost_pairs_capacity: 4_194_304,
            gpu_found_lost_aggregate_pairs_capacity: 1_048_576,
            gpu_total_aggregate_pairs_capacity: 4_194_304,
            gpu_collision_stack_size: 536_870_912,
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

/// A heavy sphere thrown into the world along `linear_velocity`.
///
/// See `FfiLaunchedBallDesc`: this is deliberately not `DynamicSphereDesc` with
/// an impulse afterwards, because a prop's damping would start eating the
/// muzzle speed the moment it existed.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct LaunchedBallDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    pub radius: f32,
    pub mass: f32,
    pub linear_velocity: Vec3,
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

/// A PhysX Vehicle SDK car (physx-2's packaged `NativeVehicle`): a rigid
/// chassis box on four raycast/sweep suspensions with a direct-drive
/// transmission. The actor origin is the chassis centre; wheels hang below it.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct VehicleDesc {
    pub entity_id: u32,
    pub user_id: u32,
    pub pose: Pose,
    /// Chassis collision box, centred on the actor origin.
    pub chassis_half_extents: Vec3,
    pub mass: f32,
    /// Mass-space inertia; zero means "derive from the box".
    pub inertia: Vec3,
    /// Wheel hard points in the actor frame: `x` is the half track, `y` the
    /// suspension attachment height, `z` the front and rear axle offsets.
    pub half_track: f32,
    pub suspension_attachment_y: f32,
    pub front_axle_z: f32,
    pub rear_axle_z: f32,
    pub suspension_travel: f32,
    pub suspension_stiffness: f32,
    pub suspension_damping: f32,
    pub wheel_radius: f32,
    pub wheel_half_width: f32,
    pub tyre_friction: f32,
    /// Tyre stiffness in N per radian of slip (lateral) and N per unit of
    /// longitudinal slip; zero keeps the vehicle SDK's reference-car values,
    /// which suit a two-tonne car and not much else. A tyre's grip curve peaks
    /// at roughly friction * load / stiffness radians of slip, so stiffness
    /// wants to scale with the load on the corner.
    pub front_lateral_stiffness: f32,
    pub rear_lateral_stiffness: f32,
    pub longitudinal_stiffness: f32,
    /// Centre of mass below (negative) or above the actor origin, along the
    /// chassis up axis. The wheel hard points stay where they are.
    pub com_offset_y: f32,
    /// PhysX angular damping on the chassis body.
    pub angular_damping: f32,
    pub max_steer_radians: f32,
    /// Torques in N m per wheel; drive torque applies to the driven wheels.
    pub drive_torque: f32,
    pub brake_torque: f32,
    pub handbrake_torque: f32,
    /// The drive response falls to zero at this forward speed (m/s).
    pub top_speed: f32,
    pub rear_wheel_drive: bool,
    /// Sweep a wheel cylinder instead of casting a ray for the road.
    pub sweep_road_queries: bool,
    /// Which collision groups the wheels may stand on.
    pub road_mask: u32,
    pub collision_group: u32,
    pub collision_mask: u32,
}

/// One convex child of an authored vehicle part, in actor coordinates.
#[derive(Clone, Debug)]
pub struct VehiclePartShape {
    pub part_index: u32,
    pub position: Vec3,
    pub points: Vec<Vec3>,
}

/// One frame of driver input for a vehicle. Throttle, brake and handbrake are
/// in `0..=1`, steer in `-1..=1` (positive turns right).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct VehicleCommands {
    pub throttle: f32,
    pub brake: f32,
    pub handbrake: f32,
    pub steer: f32,
    pub reverse: bool,
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
    /// Per wheel, in the vehicle SDK's order: front-left, front-right,
    /// rear-left, rear-right.
    pub wheel_steer: [f32; 4],
    pub wheel_rotation_speed: [f32; 4],
    pub wheel_rotation_angle: [f32; 4],
    pub wheel_jounce: [f32; 4],
    /// Bit `w` set when wheel `w`'s road query found ground.
    pub wheels_on_road: u8,
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
    /// The CUDA context has failed and cannot be recovered in this process.
    ///
    /// Not a rejected step: every later launch fails the same way, so the
    /// scene will never simulate again however many times it is reset. See
    /// LoggingErrorCallback.
    pub gpu_context_lost: bool,
}

/// The last completed step's phases and counts, for per-tick telemetry.
///
/// Everything here was already measured or counted by the step itself; this
/// only copies it out. Unlike [`WorldStats`] it allocates nothing (no spans)
/// and does not fall back to ring means, so each field is this step's own
/// value and it is cheap enough to read every tick.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepPhases {
    /// Vehicle model + character-controller interactions before `simulate`.
    pub controller_ms: f32,
    /// The `simulate()` call: with GPU dynamics this submits the step.
    pub simulate_ms: f32,
    /// `fetchResults`: waiting for the GPU (the destruction stage runs in
    /// here too), PhysX's result copy and our contact callbacks.
    pub fetch_ms: f32,
    /// Our contact callbacks, which run inside `fetch_ms`.
    pub callbacks_ms: f32,
    /// Controller start to fetch end.
    pub step_ms: f32,
    /// Time blocked on the GPU inside the fetch; only measured on sampled
    /// steps (`VIBE_PHYSX_GPU_SAMPLE_TICKS`, 1 in 16 by default) and 0 on the
    /// rest. `gpu_wait_sampled` says which.
    pub gpu_wait_ms: f32,
    pub gpu_wait_sampled: bool,
    pub active_dynamic_bodies: u32,
    /// Broad-phase pairs found and lost this step. (PhysX's discrete
    /// contact-pair count is left out: GPU dynamics never fills it.)
    pub bp_new_pairs: u32,
    pub bp_lost_pairs: u32,
    pub completed_steps: u64,
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
    /// Young's modulus, Pa. Stiffness rather than strength: what decides how
    /// an over-connected structure shares load between parallel paths.
    /// 0 = treat as the 30 GPa concrete reference.
    pub elastic_modulus: f32,
    /// Fraction of original bond area damage will not go below.
    pub residual_area_fraction: f32,
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
                elastic_modulus: 0.0,
                residual_area_fraction: 0.0,
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
    /// 0: dynamic promotion, 1: retirement, 2: rooted creation,
    /// 3: final rooted rest pose after all steps since the previous drain.
    /// Rooted creation announces membership without declaring support dead.
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
    /// Phases that used to be untimed inside the `stress_solve_ms` bracket and
    /// so showed up only as the gap between it and the sum of its parts.
    pub ccd_ms: f32,
    pub support_loads_ms: f32,
    /// Contact pairs resolve_support_loads consumed. `support_loads_ms` scales
    /// with this, not with wall time, so normalise by it when comparing runs.
    pub support_pair_loads: u32,
    pub shape_readback_ms: f32,
    /// The adapter's own per-phase timers, deltaed to per-tick. These
    /// decompose the phases the bridge times from OUTSIDE the adapter:
    /// `begin_ms` ~= contact_processing + gravity, `solve_ms` ~= stress_solve_cpu
    /// + gpu_stress_solve, `end_ms` ~= fracture_topology + mapping_validation.
    /// They were computed every tick and discarded, which left 2-3.5 ms inside
    /// the largest phase in the tick unaccounted for.
    pub blast_contact_processing_ms: f32,
    pub blast_gravity_ms: f32,
    pub blast_stress_solve_cpu_ms: f32,
    pub blast_fracture_topology_ms: f32,
    pub blast_mapping_validation_ms: f32,
    pub blast_fracture_generate_ms: f32,
    pub blast_fracture_prep_ms: f32,
    pub blast_fracture_apply_ms: f32,
    pub blast_fracture_scene_ms: f32,
    pub blast_fracture_rebuild_ms: f32,
    pub blast_sleeping_actors_skipped: u64,
    /// The last two untimed blocks inside the `stress_solve_ms` bracket:
    /// per-slot dispatch (live-slot gather + telemetry read + topology
    /// compare) and the 1-in-30 bond-utilisation scan. With these, the bracket
    /// minus its children is genuinely zero rather than "small enough to round
    /// to 0.00 at two decimals".
    pub slot_dispatch_ms: f32,
    pub bond_sample_ms: f32,
    /// Slot-ticks where topology was unchanged and the event diff was skipped.
    /// The one counter that says whether `events_ms`/`filters_ms: 0.0` means
    /// "the quiet-skip fired" or "the measurement is broken".
    pub quiet_slot_ticks: u64,
    pub contacts_queued: u64,
    pub solver_islands_skipped_accum: u64,
    pub solver_islands_total_accum: u64,
    pub ccd_tracked_bodies: u32,
    pub identity_stamped_bodies: u32,
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
    /// P1b clusters: PxAggregates currently holding frozen bodies, and how
    /// many bodies they hold. frozen_chunk_bodies minus this is the
    /// standalone remainder (fallbacks + measuring mode).
    pub frozen_aggregates: u32,
    pub frozen_aggregate_actors: u32,
    pub freeze_flips: u64,
    pub unfreeze_flips: u64,
    /// Frozen bodies released because dynamic debris struck them: the
    /// engine-driven wake that keeps a frozen pile responding to collapses.
    pub contact_wakes: u64,
    /// Rooted fragments that went dynamic (supporter deaths).
    pub support_promotions: u64,
    /// Freeze/unfreeze calls refused for naming a rooted body. Must stay 0.
    pub rooted_guard_blocks: u64,
    /// Re-sleep writes issued because a kinematic flip woke the flipped
    /// body's contact island as collateral. Counts writes, not confirmed
    /// wakes. Non-zero is normal and means the repair is running; see
    /// `freeze_island_resleep` in destruction.cc.
    pub island_resleep_writes: u64,
    /// Ground-anchored kinematic fragments currently standing.
    pub rooted_chunk_bodies: u32,
    /// Weight-bearing dependency edges currently held by the bridge.
    pub support_edges: u64,
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

/// Where a chunk is, by identity rather than by remembered coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChunkAim {
    pub found: bool,
    pub chunk_id: u32,
    pub structure_id: u32,
    pub entity_id: u32,
    pub center: Vec3,
    pub sleeping: bool,
}

/// Which chunk a ray struck. `hit` false means the ray reached no stage-owned
/// chunk: it was stopped by the ground, by debris, or by nothing at all.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChunkRayHit {
    pub hit: bool,
    pub chunk_id: u32,
    pub structure_id: u32,
    pub entity_id: u32,
    pub distance: f32,
    pub position: Vec3,
    pub normal: Vec3,
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiChunkAim> for ChunkAim {
    fn from(value: ffi::FfiChunkAim) -> Self {
        Self {
            found: value.found,
            chunk_id: value.chunk_id,
            structure_id: value.structure_id,
            entity_id: value.entity_id,
            center: value.center.into(),
            sleeping: value.sleeping,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiChunkRayHit> for ChunkRayHit {
    fn from(value: ffi::FfiChunkRayHit) -> Self {
        Self {
            hit: value.hit,
            chunk_id: value.chunk_id,
            structure_id: value.structure_id,
            entity_id: value.entity_id,
            distance: value.distance,
            position: value.position.into(),
            normal: value.normal.into(),
        }
    }
}

/// One generically-authored metric from the bridge — see `FfiNamedSpan`.
/// Rides BESIDE the Copy stats structs (a Vec on them would break every Copy
/// consumer), stashed per stats call and drained with `take_*_spans`.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedSpan {
    pub name: String,
    pub value: f64,
    /// 0 = wall-clock ms, 1 = slot-summed ms (not comparable to wall
    /// parents), 2 = plain count.
    pub kind: u8,
}

#[cfg(feature = "gpu")]
fn convert_spans(spans: Vec<ffi::FfiNamedSpan>) -> Vec<NamedSpan> {
    spans
        .into_iter()
        .map(|span| NamedSpan {
            name: span.name,
            value: span.value,
            kind: span.kind,
        })
        .collect()
}

pub struct World {
    #[cfg(feature = "gpu")]
    inner: cxx::UniquePtr<ffi::World>,
    /// Spans from the most recent `destruction_stats()` / `stats()` calls.
    /// RefCell because both stats methods take `&self`.
    destruction_spans: std::cell::RefCell<Vec<NamedSpan>>,
    world_spans: std::cell::RefCell<Vec<NamedSpan>>,
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
            Ok(Self {
                inner,
                destruction_spans: std::cell::RefCell::new(Vec::new()),
                world_spans: std::cell::RefCell::new(Vec::new()),
            })
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = config;
            Err(stub_unavailable())
        }
    }

    /// Spans stashed by the most recent `destruction_stats()` call; drained.
    pub fn take_destruction_spans(&self) -> Vec<NamedSpan> {
        std::mem::take(&mut self.destruction_spans.borrow_mut())
    }

    /// Spans stashed by the most recent `stats()` call; drained.
    pub fn take_world_spans(&self) -> Vec<NamedSpan> {
        std::mem::take(&mut self.world_spans.borrow_mut())
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

    /// Move a dynamic body without changing its velocity.
    ///
    /// For stopping a projectile at a surface it would otherwise have skipped
    /// past between ticks. Keeping the velocity is the point: the contact then
    /// resolves normally on the next step and delivers its impulse, which a
    /// speculative contact does not.
    pub fn set_body_pose(&mut self, entity_id: u32, pose: Pose) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .set_body_pose(entity_id, &pose.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, pose);
            Err(stub_unavailable())
        }
    }

    pub fn launch_dynamic_ball(&mut self, desc: LaunchedBallDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .launch_dynamic_ball(&desc.into())
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

    pub fn set_vehicle_shapes(&mut self, entity_id: u32, shapes: &[VehiclePartShape]) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            let shapes: Vec<ffi::FfiVehiclePartShape> = shapes.iter().map(|shape| ffi::FfiVehiclePartShape {
                part_index: shape.part_index,
                position: shape.position.into(),
                points: shape.points.iter().copied().map(Into::into).collect(),
            }).collect();
            self.inner.pin_mut().set_vehicle_shapes(entity_id, &shapes).map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        { let _ = (entity_id, shapes); Err(stub_unavailable()) }
    }

    pub fn add_vehicle(&mut self, desc: VehicleDesc) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .add_vehicle(&desc.into())
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
        commands: VehicleCommands,
    ) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .drive_vehicle(entity_id, &commands.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, commands);
            Err(stub_unavailable())
        }
    }

    /// Re-pose a vehicle at rest: a flipped or wedged car back on its wheels.
    /// Velocities are zeroed and the body woken; the vehicle model reads the
    /// actor's pose afresh on its next step, so nothing else needs resetting.
    pub fn reset_vehicle(&mut self, entity_id: u32, pose: Pose) -> Result<(), BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner
                .pin_mut()
                .reset_vehicle(entity_id, &pose.into())
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            let _ = (entity_id, pose);
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
            self.inner
                .stats()
                .map(|mut ffi_stats| {
                    *self.world_spans.borrow_mut() =
                        convert_spans(std::mem::take(&mut ffi_stats.extra_spans));
                    ffi_stats.into()
                })
                .map_err(operation_error)
        }
        #[cfg(not(feature = "gpu"))]
        {
            Err(stub_unavailable())
        }
    }

    /// The last step's phases and counts (see [`StepPhases`]). Cheap: no
    /// allocation, safe to call every tick outside a step.
    pub fn step_phases(&self) -> Result<StepPhases, BridgeError> {
        #[cfg(feature = "gpu")]
        {
            self.inner.step_phases().map(Into::into).map_err(operation_error)
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
    /// Per-bond stress for one structure, as of the last solve.
    ///
    /// The tick loop's own sampler reduces this to a max and a count, which
    /// says whether anything is overloaded and nothing about where. This is
    /// the readout that can answer where.
    #[cfg(feature = "destruction")]
    pub fn bond_stress_rows(
        &self,
        structure_id: u32,
    ) -> Result<Vec<ffi::FfiBondStressRow>, BridgeError> {
        self.inner
            .bond_stress_rows(structure_id)
            .map_err(operation_error)
    }

    // --- PhysX's own GPU destruction stage -----------------------------------

    /// Attach the stage to this scene. Fails when the linked SDK has none, or
    /// when the scene is configured in a way the stage does not support.
    #[cfg(feature = "native-destruction")]
    pub fn native_attach(&mut self) -> Result<(), BridgeError> {
        self.inner.pin_mut().native_attach().map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    #[allow(clippy::too_many_arguments)]
    pub fn native_create_destructible(
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
            .native_create_destructible(
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

    /// Hand the authored asset to the stage. The scene must already have
    /// completed one step, which is what gives chunks their GPU identities.
    #[cfg(feature = "native-destruction")]
    pub fn native_configure(
        &mut self,
        config: NativeConfig,
    ) -> Result<NativeConfigured, BridgeError> {
        self.inner
            .pin_mut()
            .native_configure(&config.into())
            .map(Into::into)
            .map_err(operation_error)
    }

    /// Identify the already-loaded optional warm-start runtime for cache binding.
    #[cfg(feature = "native-destruction")]
    pub fn native_warm_runtime_path(&mut self) -> Result<String, BridgeError> {
        self.inner.pin_mut().native_warm_runtime_path().map_err(operation_error)
    }

    /// Export a pristine converged iterate as six physical f32 values per bond
    /// (angular xyz, linear xyz), in native creation order. No solver flags.
    #[cfg(feature = "native-destruction")]
    pub fn native_export_warm_start(&mut self) -> Result<Vec<f32>, BridgeError> {
        self.inner.pin_mut().native_export_warm_start().map_err(operation_error)
    }

    /// Seed a freshly configured scene before its first stress step. The next
    /// step performs normal residual verification, contacts and destruction.
    #[cfg(feature = "native-destruction")]
    pub fn native_import_warm_start(&mut self, values: &[f32]) -> Result<(), BridgeError> {
        self.inner.pin_mut().native_import_warm_start(values).map_err(operation_error)
    }

    /// The stage's current status, consuming nothing. Use it to find out why a
    /// step was rejected, since a rejected step is never observed.
    #[cfg(feature = "native-destruction")]
    pub fn native_last_status(&self) -> Result<NativeStatus, BridgeError> {
        self.inner
            .native_last_status()
            .map(Into::into)
            .map_err(operation_error)
    }

    /// Observe the step that just completed.
    #[cfg(feature = "native-destruction")]
    pub fn native_tick(&mut self) -> Result<NativeStatus, BridgeError> {
        self.inner
            .pin_mut()
            .native_tick()
            .map(Into::into)
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_fire_round(&mut self, desc: RoundDesc) -> Result<u32, BridgeError> {
        self.inner
            .pin_mut()
            .native_fire_round(&desc.into())
            .map_err(operation_error)
    }

    /// Where a named chunk is now, so a test can aim at an identity instead of
    /// at coordinates that quietly stop being right.
    #[cfg(feature = "native-destruction")]
    pub fn native_chunk_aim(
        &self,
        structure_id: u32,
        node_index: u32,
    ) -> Result<ChunkAim, BridgeError> {
        self.inner
            .native_chunk_aim(structure_id, node_index)
            .map(Into::into)
            .map_err(operation_error)
    }

    /// Raycast reporting WHICH chunk stopped the ray, or that nothing did.
    #[cfg(feature = "native-destruction")]
    pub fn native_raycast_chunk(
        &self,
        origin: Vec3,
        direction: Vec3,
        max_distance: f32,
    ) -> Result<ChunkRayHit, BridgeError> {
        self.inner
            .native_raycast_chunk(origin.into(), direction.into(), max_distance)
            .map(Into::into)
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_take_broken_bonds(&mut self) -> Result<Vec<BrokenBondEvent>, BridgeError> {
        self.inner
            .pin_mut()
            .native_take_broken_bonds()
            .map(|events| events.into_iter().map(Into::into).collect())
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_take_chunk_migrations(
        &mut self,
    ) -> Result<Vec<ChunkMigrationEvent>, BridgeError> {
        self.inner
            .pin_mut()
            .native_take_chunk_migrations()
            .map(|events| events.into_iter().map(Into::into).collect())
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_take_island_events(&mut self) -> Result<Vec<IslandBodyEvent>, BridgeError> {
        self.inner
            .pin_mut()
            .native_take_island_events()
            .map(|events| events.into_iter().map(Into::into).collect())
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_chunk_body_snapshots(
        &self,
    ) -> Result<&[ffi::FfiChunkBodySnapshot], BridgeError> {
        self.inner.native_chunk_body_snapshots().map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_bond_stress_rows(
        &self,
        structure_id: u32,
    ) -> Result<Vec<ffi::FfiBondStressRow>, BridgeError> {
        self.inner
            .native_bond_stress_rows(structure_id)
            .map_err(operation_error)
    }

    /// Stage statistics. Spans are stashed for `take_native_spans`, mirroring
    /// the Blast path so both backends feed the same telemetry channel.
    #[cfg(feature = "native-destruction")]
    pub fn native_stats(&self) -> Result<DestructionStats, BridgeError> {
        self.inner
            .native_stats()
            .map(|mut ffi_stats| {
                *self.destruction_spans.borrow_mut() =
                    convert_spans(std::mem::take(&mut ffi_stats.extra_spans));
                ffi_stats.into()
            })
            .map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_validate_mappings(&self) -> Result<bool, BridgeError> {
        self.inner.native_validate_mappings().map_err(operation_error)
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_clear(&mut self) -> Result<(), BridgeError> {
        self.inner.pin_mut().native_clear().map_err(operation_error)
    }

    /// True once a CUDA fault has made this process's context unusable.
    ///
    /// One relaxed atomic load, so it is checked every tick rather than only
    /// when a step is rejected: the context can be lost by work that does not
    /// immediately fail a step, and by the time one does the world has already
    /// been served to players as if it were simulating.
    pub fn gpu_context_lost(&self) -> bool {
        #[cfg(feature = "gpu")]
        {
            self.inner.gpu_context_lost()
        }
        #[cfg(not(feature = "gpu"))]
        {
            false
        }
    }

    #[cfg(feature = "native-destruction")]
    pub fn native_configured(&self) -> Result<bool, BridgeError> {
        self.inner.native_configured().map_err(operation_error)
    }

    #[cfg(feature = "gpu")]
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

    /// This tick's weight-bearing dependency updates. The engine's contact
    /// reports are the source: each set replaces one body's supporter list.
    /// The two vecs are a pair (sets index into rows); drain both together.
    #[cfg(feature = "destruction")]
    pub fn take_support_updates(
        &mut self,
    ) -> Result<(Vec<ffi::FfiSupportSet>, Vec<ffi::FfiSupportRow>), BridgeError> {
        let sets = self
            .inner
            .pin_mut()
            .take_support_sets()
            .map_err(operation_error)?;
        let rows = self
            .inner
            .pin_mut()
            .take_support_rows()
            .map_err(operation_error)?;
        Ok((sets, rows))
    }

    #[cfg(feature = "destruction")]
    pub fn destruction_stats(&self) -> Result<DestructionStats, BridgeError> {
        self.inner
            .destruction_stats()
            .map(|mut ffi_stats| {
                *self.destruction_spans.borrow_mut() =
                    convert_spans(std::mem::take(&mut ffi_stats.extra_spans));
                ffi_stats.into()
            })
            .map_err(operation_error)
    }

    /// Cumulative island splits. A tick fractured iff this increased across it.
    #[cfg(feature = "destruction")]
    pub fn split_count(&self) -> Result<u64, BridgeError> {
        self.inner.split_count().map_err(operation_error)
    }

    /// True when a fracture-frame resimulation capture should be taken before
    /// the next `step()`. See DestructionManager::resim_needed.
    #[cfg(feature = "destruction")]
    pub fn resim_needed(&self) -> Result<bool, BridgeError> {
        self.inner.resim_needed().map_err(operation_error)
    }

    /// Capture motion state. Must run outside a step, in the Idle tick phase.
    #[cfg(feature = "destruction")]
    pub fn resim_capture(&mut self) -> Result<u32, BridgeError> {
        self.inner.pin_mut().resim_capture().map_err(operation_error)
    }

    /// Rewind motion to the capture so the step can be re-run against the
    /// already-split pieces. Topology, mass and shapes are kept.
    #[cfg(feature = "destruction")]
    pub fn resim_restore(&mut self) -> Result<bool, BridgeError> {
        self.inner.pin_mut().resim_restore().map_err(operation_error)
    }

    #[cfg(feature = "destruction")]
    pub fn validate_destruction_mappings(&self) -> Result<bool, BridgeError> {
        self.inner
            .validate_destruction_mappings()
            .map_err(operation_error)
    }

    /// Raw `PxScene*` as an integer, for handing this scene to another
    /// subsystem.
    ///
    /// The destructible city, players and vehicles all have to live in one
    /// scene, so the blast-stress-solver core attaches to this rather than
    /// standing up a second world. The pointer is valid for the lifetime of
    /// this `World`.
    #[cfg(feature = "gpu")]
    pub fn scene_ptr(&self) -> Result<usize, BridgeError> {
        self.inner.scene_ptr().map_err(operation_error)
    }

    /// Raw `PxPhysics*` as an integer. See [`scene_ptr`](Self::scene_ptr).
    #[cfg(feature = "gpu")]
    pub fn physics_ptr(&self) -> Result<usize, BridgeError> {
        self.inner.physics_ptr().map_err(operation_error)
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

    /// A heavy sphere thrown into the world, not a prop dropped into it.
    ///
    /// Separate from `FfiDynamicSphereDesc` because the two want opposite
    /// things: a prop gets damping so it stops rolling, a thrown ball must keep
    /// the speed it was launched with and let gravity and contacts decide the
    /// rest.
    struct FfiLaunchedBallDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        radius: f32,
        mass: f32,
        linear_velocity: FfiVec3,
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

    struct FfiVehiclePartShape {
        part_index: u32,
        position: FfiVec3,
        points: Vec<FfiVec3>,
    }

    struct FfiVehicleDesc {
        entity_id: u32,
        user_id: u32,
        pose: FfiPose,
        chassis_half_extents: FfiVec3,
        mass: f32,
        inertia: FfiVec3,
        half_track: f32,
        suspension_attachment_y: f32,
        front_axle_z: f32,
        rear_axle_z: f32,
        suspension_travel: f32,
        suspension_stiffness: f32,
        suspension_damping: f32,
        wheel_radius: f32,
        wheel_half_width: f32,
        tyre_friction: f32,
        front_lateral_stiffness: f32,
        rear_lateral_stiffness: f32,
        longitudinal_stiffness: f32,
        com_offset_y: f32,
        angular_damping: f32,
        max_steer_radians: f32,
        drive_torque: f32,
        brake_torque: f32,
        handbrake_torque: f32,
        top_speed: f32,
        rear_wheel_drive: bool,
        sweep_road_queries: bool,
        road_mask: u32,
        collision_group: u32,
        collision_mask: u32,
    }

    struct FfiVehicleCommands {
        throttle: f32,
        brake: f32,
        handbrake: f32,
        steer: f32,
        reverse: bool,
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
        wheel_steer: [f32; 4],
        wheel_rotation_speed: [f32; 4],
        wheel_rotation_angle: [f32; 4],
        wheel_jounce: [f32; 4],
        wheels_on_road: u8,
    }

    /// See `StepPhases`.
    struct FfiStepPhases {
        controller_ms: f32,
        simulate_ms: f32,
        fetch_ms: f32,
        callbacks_ms: f32,
        step_ms: f32,
        gpu_wait_ms: f32,
        gpu_wait_sampled: bool,
        active_dynamic_bodies: u32,
        bp_new_pairs: u32,
        bp_lost_pairs: u32,
        completed_steps: u64,
    }

    struct FfiWorldStats {
        extra_spans: Vec<FfiNamedSpan>,
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
        gpu_context_lost: bool,
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
        elastic_modulus: f32,
        residual_area_fraction: f32,
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

    /// How the native destruction stage is configured, once, at attach.
    ///
    /// Everything here is a physical or budget choice the caller owns. The
    /// correction limit is not among them: the stage is always configured for
    /// exactly one corrected pass, because zero means it refuses every
    /// membership change and the city can never break.
    struct FfiNativeConfig {
        /// Stress iterations per evaluation. This is physics, not a speed
        /// dial: below convergence the solver reports its residual as stress
        /// and residual breaks bonds, so the stage rejects a step it could not
        /// converge rather than publishing one.
        max_iterations: u32,
        tolerance: f32,
        warm_start: bool,
        damage_rate: f32,
        bend_gain_max: f32,
        fibre_bending: bool,
        /// Contact-pair storage to touch up front, so a first impact does not
        /// page-fault on the simulation thread.
        reserved_contact_pairs: u32,
        preserve_unchanged_contact_pairs: bool,
        gpu_island_repair: bool,
        /// How often the whole-graph bond verdict read runs, in ticks. The
        /// value it produces is published with its age beside it.
        verdict_sample_ticks: u32,
    }

    /// What the stage accepted, so the caller can report the real shape of the
    /// city rather than what it intended to build.
    struct FfiNativeConfigured {
        chunks: u32,
        bonds: u32,
        clusters: u32,
        materials: u32,
        reserved_pairs: u32,
    }

    /// One completed engine step, as the stage describes it.
    struct FfiNativeStatus {
        frame: u64,
        /// Engine error bits. Non-zero means the step was not completed and
        /// nothing was observed from it.
        error: u32,
        iterations: u32,
        converged: bool,
        normal_contacts: u32,
        friction_anchors: u32,
        bond_commands: u32,
        broken_bonds: u32,
        crushed_chunks: u32,
        correction_passes: u32,
        stress_passes: u32,
        post_correction_broken_bonds: u32,
        committed_chunks: u32,
        committed_bonds: u32,
        cluster_count: u32,
        stress_island_count: u32,
        /// False when this frame produced no observation: an error, or a frame
        /// already consumed. Events and snapshots are unchanged in that case.
        observed: bool,
        /// The scene cannot continue (contact lifetime space exhausted). The
        /// city is frozen from here; the match should be reported, not faked.
        degraded: bool,
        missed_frames: u32,
    }

    /// One shot, delivered as a physical body.
    ///
    /// The stage takes loads only from PhysX's own solved contacts, so there is
    /// no force to inject: a hitscan round becomes a real body carrying the
    /// round's momentum for the few ticks it takes to strike. Mass follows from
    /// momentum and speed rather than being chosen.
    /// Where a named chunk is right now, for aiming at it.
    ///
    /// Tests that aim with hardcoded coordinates silently stop hitting the
    /// moment the scene, the spawn or the structure moves, and a shot that
    /// reaches nothing still produces plausible frame times. This makes the
    /// target an identity rather than a guess.
    struct FfiChunkAim {
        found: bool,
        chunk_id: u32,
        structure_id: u32,
        entity_id: u32,
        center: FfiVec3,
        sleeping: bool,
    }

    /// Which chunk a ray actually struck. `hit` false means the ray reached no
    /// stage-owned chunk at all, which is the failure an aiming test exists to
    /// catch.
    struct FfiChunkRayHit {
        hit: bool,
        chunk_id: u32,
        structure_id: u32,
        entity_id: u32,
        distance: f32,
        position: FfiVec3,
        normal: FfiVec3,
    }

    struct FfiRoundDesc {
        position: FfiVec3,
        direction: FfiVec3,
        momentum_ns: f32,
        radius: f32,
        speed: f32,
        ttl_ticks: u32,
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

    /// One generically-authored metric flowing through stats with no
    /// per-field plumbing. Adding a NEW timing used to thread through six
    /// files (bridge header → fill → this bridge ×2 → runtime copy → netcode
    /// struct → server publish) — which is exactly why coverage had holes.
    /// With this channel a new C++ metric is one `span_add(...)` line and it
    /// appears in match-stats, traces and debug reports automatically.
    /// kind: 0 = wall-clock ms, 1 = slot-summed ms (NOT comparable to wall
    /// parents), 2 = plain count.
    struct FfiNamedSpan {
        name: String,
        value: f64,
        kind: u8,
    }

    struct FfiDestructionStats {
        extra_spans: Vec<FfiNamedSpan>,
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
        /// Per-body CCD/depenetration application walk, resolve_support_loads,
        /// and the topology-changed shape readback. Previously untimed inside
        /// the stress_solve_ms bracket.
        ccd_ms: f32,
        support_loads_ms: f32,
        support_pair_loads: u32,
        shape_readback_ms: f32,
        blast_contact_processing_ms: f32,
        blast_gravity_ms: f32,
        blast_stress_solve_cpu_ms: f32,
        blast_fracture_topology_ms: f32,
        blast_mapping_validation_ms: f32,
        blast_fracture_generate_ms: f32,
        blast_fracture_prep_ms: f32,
        blast_fracture_apply_ms: f32,
        blast_fracture_scene_ms: f32,
        blast_fracture_rebuild_ms: f32,
        blast_sleeping_actors_skipped: u64,
        slot_dispatch_ms: f32,
        bond_sample_ms: f32,
        /// Slot-ticks where the topology diff was skipped as quiet.
        quiet_slot_ticks: u64,
        contacts_queued: u64,
        solver_islands_skipped_accum: u64,
        solver_islands_total_accum: u64,
        ccd_tracked_bodies: u32,
        identity_stamped_bodies: u32,
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
        /// P1b: PxAggregates holding frozen bodies, and the bodies in them.
        frozen_aggregates: u32,
        frozen_aggregate_actors: u32,
        /// Must stay zero: a frozen body reaching a serial-issuing path would
        /// alias settled rubble onto the structure's support actor.
        frozen_serial_blocks: u64,
        /// Frozen bodies the adapter set dynamic again when they split.
        frozen_adapter_releases: u64,
        freeze_flips: u64,
        unfreeze_flips: u64,
        /// Frozen bodies released because dynamic debris struck them.
        contact_wakes: u64,
        /// Rooted fragments that lost their last anchored node and went
        /// dynamic (each is a supporter-death for whatever rested on it).
        support_promotions: u64,
        /// Freeze/unfreeze calls that named a rooted body and were refused.
        /// Must stay zero.
        rooted_guard_blocks: u64,
        /// Re-sleep writes issued after a kinematic flip woke its island.
        island_resleep_writes: u64,
        /// Ground-anchored kinematic fragments currently standing.
        rooted_chunk_bodies: u32,
        /// Weight-bearing dependency edges currently held.
        support_edges: u64,
    }

    /// One dependent whose supporter set changed this tick, indexing into
    /// the rows drain. The two drains are a pair; consume them together.
    #[derive(Clone, Copy, Debug)]
    struct FfiSupportSet {
        dependent_entity: u32,
        /// The last tick this body reported ANY contact -- the freshness
        /// stamp freeze admission checks against its quiet window.
        last_report_tick: u64,
        /// Most negative contact separation, metres: deep negative means the
        /// body is squeezed/interpenetrating and must not be frozen (baking
        /// the overlap turns its neighbours into depenetration pumps).
        min_separation: f32,
        first_row: u32,
        row_count: u32,
        /// 1 when the supporter LIST is the one already delivered: only
        /// `min_separation` (and the freshness stamp) moved, and no rows are
        /// attached. The consumer keeps its stored list and updates the
        /// penetration. In a settled pile nearly every touched body reports
        /// an unchanged list every tick, so this is most sets.
        unchanged: u8,
    }

    /// One supporter of a dependent. kind: 0 = World (immutable static),
    /// 1 = Foreign (movable non-debris; blocks freezing), 2 = Rooted (stump,
    /// with the supporting node), 3 = ChunkBody (debris, frozen or dynamic).
    #[derive(Clone, Copy, Debug)]
    struct FfiSupportRow {
        kind: u8,
        supporter_entity: u32,
        supporter_node: u32,
    }

    /// One bond's stress state, for locating what is actually overloaded.
    #[derive(Clone, Copy, Debug)]
    struct FfiBondStressRow {
        bond_index: u32,
        node0: u32,
        node1: u32,
        material: u32,
        area: f32,
        /// Stress over this bond's own material's ELASTIC limit. 1.0 is at the
        /// limit; damage accrues above it and never below.
        utilisation: f32,
        compression: f32,
        tension: f32,
        shear: f32,
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
        fn launch_dynamic_ball(self: Pin<&mut World>, desc: &FfiLaunchedBallDesc) -> Result<()>;
        fn set_body_pose(self: Pin<&mut World>, entity_id: u32, pose: &FfiPose) -> Result<()>;
        fn add_capsule_player(self: Pin<&mut World>, desc: &FfiCapsulePlayerDesc) -> Result<()>;
        fn add_vehicle(self: Pin<&mut World>, desc: &FfiVehicleDesc) -> Result<()>;
        fn set_vehicle_shapes(self: Pin<&mut World>, entity_id: u32, shapes: &[FfiVehiclePartShape]) -> Result<()>;
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
            commands: &FfiVehicleCommands,
        ) -> Result<()>;
        fn reset_vehicle(self: Pin<&mut World>, entity_id: u32, pose: &FfiPose) -> Result<()>;
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
        fn step_phases(self: &World) -> Result<FfiStepPhases>;
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
        fn take_support_sets(self: Pin<&mut World>) -> Result<Vec<FfiSupportSet>>;
        fn take_support_rows(self: Pin<&mut World>) -> Result<Vec<FfiSupportRow>>;
        fn bond_stress_rows(self: &World, structure_id: u32) -> Result<Vec<FfiBondStressRow>>;
        fn destruction_stats(self: &World) -> Result<FfiDestructionStats>;
        fn validate_destruction_mappings(self: &World) -> Result<bool>;
        fn split_count(self: &World) -> Result<u64>;
        fn resim_needed(self: &World) -> Result<bool>;
        fn resim_capture(self: Pin<&mut World>) -> Result<u32>;
        fn resim_restore(self: Pin<&mut World>) -> Result<bool>;

        /// PhysX's own GPU destruction stage. Every call must run outside a
        /// step: the stage is configured and observed between simulates,
        /// never during one.
        fn native_attach(self: Pin<&mut World>) -> Result<()>;
        fn native_create_destructible(
            self: Pin<&mut World>,
            structure_id: u32,
            pose: &FfiPose,
            nodes: &[FfiChunkNodeDesc],
            bonds: &[FfiChunkBondDesc],
            settings: &FfiDestructibleSettings,
            collision_group: u32,
            collision_mask: u32,
        ) -> Result<()>;
        fn native_configure(
            self: Pin<&mut World>,
            config: &FfiNativeConfig,
        ) -> Result<FfiNativeConfigured>;
        fn native_warm_runtime_path(self: Pin<&mut World>) -> Result<String>;
        fn native_export_warm_start(self: Pin<&mut World>) -> Result<Vec<f32>>;
        fn native_import_warm_start(self: Pin<&mut World>, values: &[f32]) -> Result<()>;
        fn native_tick(self: Pin<&mut World>) -> Result<FfiNativeStatus>;
        fn native_last_status(self: &World) -> Result<FfiNativeStatus>;
        fn native_fire_round(self: Pin<&mut World>, desc: &FfiRoundDesc) -> Result<u32>;
        fn native_chunk_aim(self: &World, structure_id: u32, node_index: u32) -> Result<FfiChunkAim>;
        fn native_raycast_chunk(self: &World, origin: FfiVec3, direction: FfiVec3, max_distance: f32) -> Result<FfiChunkRayHit>;
        fn native_take_broken_bonds(self: Pin<&mut World>) -> Result<Vec<FfiBrokenBondEvent>>;
        fn native_take_chunk_migrations(
            self: Pin<&mut World>,
        ) -> Result<Vec<FfiChunkMigrationEvent>>;
        fn native_take_island_events(self: Pin<&mut World>) -> Result<Vec<FfiIslandBodyEvent>>;
        fn native_chunk_body_snapshots(self: &World) -> Result<&[FfiChunkBodySnapshot]>;
        fn native_bond_stress_rows(
            self: &World,
            structure_id: u32,
        ) -> Result<Vec<FfiBondStressRow>>;
        fn native_stats(self: &World) -> Result<FfiDestructionStats>;
        fn native_validate_mappings(self: &World) -> Result<bool>;
        fn native_clear(self: Pin<&mut World>) -> Result<()>;
        fn gpu_context_lost(self: &World) -> bool;
        fn native_configured(self: &World) -> Result<bool>;
        /// Network entity id for a native body, so the Rust id layout and the
        /// C++ mirror can be asserted equal instead of assumed equal.
        fn native_entity_id(structure_id: u32, island_serial: u32) -> u32;

        /// Raw PhysX handles, so the blast-stress-solver core can attach a
        /// backend to this scene instead of creating a second one.
        fn scene_ptr(self: &World) -> Result<usize>;
        fn physics_ptr(self: &World) -> Result<usize>;
    }
}

/// Network entity id for a native destruction body, from the C++ mirror.
///
/// Exposed so a test can assert the mirror and `destruction/src/ids.rs` agree
/// rather than assuming it: if those two ever disagree, every body on the wire
/// is renamed and the client silently draws the wrong chunks.
#[cfg(feature = "native-destruction")]
pub fn native_entity_id(structure_id: u32, island_serial: u32) -> u32 {
    ffi::native_entity_id(structure_id, island_serial)
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
    LaunchedBallDesc,
    ffi::FfiLaunchedBallDesc {
        entity_id,
        user_id,
        pose,
        radius,
        mass,
        linear_velocity,
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
    VehicleDesc,
    ffi::FfiVehicleDesc {
        entity_id,
        user_id,
        pose,
        chassis_half_extents,
        mass,
        inertia,
        half_track,
        suspension_attachment_y,
        front_axle_z,
        rear_axle_z,
        suspension_travel,
        suspension_stiffness,
        suspension_damping,
        wheel_radius,
        wheel_half_width,
        tyre_friction,
        front_lateral_stiffness,
        rear_lateral_stiffness,
        longitudinal_stiffness,
        com_offset_y,
        angular_damping,
        max_steer_radians,
        drive_torque,
        brake_torque,
        handbrake_torque,
        top_speed,
        rear_wheel_drive,
        sweep_road_queries,
        road_mask,
        collision_group,
        collision_mask,
    }
);
#[cfg(feature = "gpu")]
impl_ffi_from!(
    VehicleCommands,
    ffi::FfiVehicleCommands {
        throttle,
        brake,
        handbrake,
        steer,
        reverse,
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
            wheel_steer: value.wheel_steer,
            wheel_rotation_speed: value.wheel_rotation_speed,
            wheel_rotation_angle: value.wheel_rotation_angle,
            wheel_jounce: value.wheel_jounce,
            wheels_on_road: value.wheels_on_road,
        }
    }
}

#[cfg(feature = "gpu")]
impl From<ffi::FfiStepPhases> for StepPhases {
    fn from(v: ffi::FfiStepPhases) -> Self {
        Self {
            controller_ms: v.controller_ms,
            simulate_ms: v.simulate_ms,
            fetch_ms: v.fetch_ms,
            callbacks_ms: v.callbacks_ms,
            step_ms: v.step_ms,
            gpu_wait_ms: v.gpu_wait_ms,
            gpu_wait_sampled: v.gpu_wait_sampled,
            active_dynamic_bodies: v.active_dynamic_bodies,
            bp_new_pairs: v.bp_new_pairs,
            bp_lost_pairs: v.bp_lost_pairs,
            completed_steps: v.completed_steps,
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
            gpu_context_lost: value.gpu_context_lost,
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

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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
                    elastic_modulus: material.elastic_modulus,
                    residual_area_fraction: material.residual_area_fraction,
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

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
impl From<ffi::FfiBrokenBondEvent> for BrokenBondEvent {
    fn from(value: ffi::FfiBrokenBondEvent) -> Self {
        Self {
            structure_id: value.structure_id,
            bond_id: value.bond_id,
        }
    }
}

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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

/// Configuration for PhysX's own destruction stage.
#[cfg(feature = "native-destruction")]
#[derive(Clone, Copy, Debug)]
pub struct NativeConfig {
    pub max_iterations: u32,
    pub tolerance: f32,
    pub warm_start: bool,
    pub damage_rate: f32,
    pub bend_gain_max: f32,
    pub fibre_bending: bool,
    pub reserved_contact_pairs: u32,
    pub preserve_unchanged_contact_pairs: bool,
    pub gpu_island_repair: bool,
    pub verdict_sample_ticks: u32,
}

#[cfg(feature = "native-destruction")]
impl From<NativeConfig> for ffi::FfiNativeConfig {
    fn from(v: NativeConfig) -> Self {
        Self {
            max_iterations: v.max_iterations,
            tolerance: v.tolerance,
            warm_start: v.warm_start,
            damage_rate: v.damage_rate,
            bend_gain_max: v.bend_gain_max,
            fibre_bending: v.fibre_bending,
            reserved_contact_pairs: v.reserved_contact_pairs,
            preserve_unchanged_contact_pairs: v.preserve_unchanged_contact_pairs,
            gpu_island_repair: v.gpu_island_repair,
            verdict_sample_ticks: v.verdict_sample_ticks,
        }
    }
}

/// What the stage accepted at configuration.
#[cfg(feature = "native-destruction")]
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeConfigured {
    pub chunks: u32,
    pub bonds: u32,
    pub clusters: u32,
    pub materials: u32,
    pub reserved_pairs: u32,
}

#[cfg(feature = "native-destruction")]
impl From<ffi::FfiNativeConfigured> for NativeConfigured {
    fn from(v: ffi::FfiNativeConfigured) -> Self {
        Self {
            chunks: v.chunks,
            bonds: v.bonds,
            clusters: v.clusters,
            materials: v.materials,
            reserved_pairs: v.reserved_pairs,
        }
    }
}

/// One completed engine step as the destruction stage describes it.
///
/// `observed` false means this tick produced no events or snapshots -- either
/// the step was rejected (`error` non-zero) or its frame was already consumed.
/// Callers must not treat that as "nothing happened in the world".
#[cfg(feature = "native-destruction")]
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeStatus {
    pub frame: u64,
    pub error: u32,
    pub iterations: u32,
    pub converged: bool,
    pub normal_contacts: u32,
    pub friction_anchors: u32,
    pub bond_commands: u32,
    pub broken_bonds: u32,
    pub crushed_chunks: u32,
    pub correction_passes: u32,
    pub stress_passes: u32,
    pub post_correction_broken_bonds: u32,
    pub committed_chunks: u32,
    pub committed_bonds: u32,
    pub cluster_count: u32,
    pub stress_island_count: u32,
    pub observed: bool,
    pub degraded: bool,
    pub missed_frames: u32,
}

#[cfg(feature = "native-destruction")]
impl From<ffi::FfiNativeStatus> for NativeStatus {
    fn from(v: ffi::FfiNativeStatus) -> Self {
        Self {
            frame: v.frame,
            error: v.error,
            iterations: v.iterations,
            converged: v.converged,
            normal_contacts: v.normal_contacts,
            friction_anchors: v.friction_anchors,
            bond_commands: v.bond_commands,
            broken_bonds: v.broken_bonds,
            crushed_chunks: v.crushed_chunks,
            correction_passes: v.correction_passes,
            stress_passes: v.stress_passes,
            post_correction_broken_bonds: v.post_correction_broken_bonds,
            committed_chunks: v.committed_chunks,
            committed_bonds: v.committed_bonds,
            cluster_count: v.cluster_count,
            stress_island_count: v.stress_island_count,
            observed: v.observed,
            degraded: v.degraded,
            missed_frames: v.missed_frames,
        }
    }
}

/// A shot delivered as a physical body.
#[cfg(feature = "native-destruction")]
#[derive(Clone, Copy, Debug)]
pub struct RoundDesc {
    pub position: Vec3,
    pub direction: Vec3,
    pub momentum_ns: f32,
    pub radius: f32,
    pub speed: f32,
    pub ttl_ticks: u32,
}

#[cfg(feature = "native-destruction")]
impl From<RoundDesc> for ffi::FfiRoundDesc {
    fn from(v: RoundDesc) -> Self {
        Self {
            position: v.position.into(),
            direction: v.direction.into(),
            momentum_ns: v.momentum_ns,
            radius: v.radius,
            speed: v.speed,
            ttl_ticks: v.ttl_ticks,
        }
    }
}

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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

#[cfg(any(feature = "destruction", feature = "native-destruction"))]
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
            ccd_ms: value.ccd_ms,
            support_loads_ms: value.support_loads_ms,
            support_pair_loads: value.support_pair_loads,
            shape_readback_ms: value.shape_readback_ms,
            blast_contact_processing_ms: value.blast_contact_processing_ms,
            blast_gravity_ms: value.blast_gravity_ms,
            blast_stress_solve_cpu_ms: value.blast_stress_solve_cpu_ms,
            blast_fracture_topology_ms: value.blast_fracture_topology_ms,
            blast_mapping_validation_ms: value.blast_mapping_validation_ms,
            blast_fracture_generate_ms: value.blast_fracture_generate_ms,
            blast_fracture_prep_ms: value.blast_fracture_prep_ms,
            blast_fracture_apply_ms: value.blast_fracture_apply_ms,
            blast_fracture_scene_ms: value.blast_fracture_scene_ms,
            blast_fracture_rebuild_ms: value.blast_fracture_rebuild_ms,
            blast_sleeping_actors_skipped: value.blast_sleeping_actors_skipped,
            slot_dispatch_ms: value.slot_dispatch_ms,
            bond_sample_ms: value.bond_sample_ms,
            quiet_slot_ticks: value.quiet_slot_ticks,
            contacts_queued: value.contacts_queued,
            solver_islands_skipped_accum: value.solver_islands_skipped_accum,
            solver_islands_total_accum: value.solver_islands_total_accum,
            ccd_tracked_bodies: value.ccd_tracked_bodies,
            identity_stamped_bodies: value.identity_stamped_bodies,
            sleeping_chunk_bodies: value.sleeping_chunk_bodies,
            repeated_body_snapshots: value.repeated_body_snapshots,
            gpu_stress_structures: value.gpu_stress_structures,
            gpu_stress_solve_ms: value.gpu_stress_solve_ms,
            solver_island_count: value.solver_island_count,
            solver_islands_skipped: value.solver_islands_skipped,
            sleeping_actors_skipped: value.sleeping_actors_skipped,
            frozen_chunk_bodies: value.frozen_chunk_bodies,
            frozen_aggregates: value.frozen_aggregates,
            frozen_aggregate_actors: value.frozen_aggregate_actors,
            freeze_flips: value.freeze_flips,
            unfreeze_flips: value.unfreeze_flips,
            contact_wakes: value.contact_wakes,
            support_promotions: value.support_promotions,
            rooted_guard_blocks: value.rooted_guard_blocks,
            island_resleep_writes: value.island_resleep_writes,
            rooted_chunk_bodies: value.rooted_chunk_bodies,
            support_edges: value.support_edges,
            frozen_serial_blocks: value.frozen_serial_blocks,
            frozen_adapter_releases: value.frozen_adapter_releases,
        }
    }
}

/// Which PhysX SDK this binary was linked against, as `revision @ path`.
///
/// Recorded at build time, because the runtime cannot work it out: both SDKs
/// ship identical library names and `LD_LIBRARY_PATH` beats the embedded
/// rpath. It belongs in `/healthz` and in the startup log for one reason --
/// the libraries in an SDK's output directory are not immutable, and a
/// deployment that quietly picks up a different build of them looks completely
/// healthy from outside. One did, for hours, serving a city that could not be
/// broken at a steady 60 Hz.
pub fn physx_sdk_identity() -> String {
    #[cfg(feature = "native-destruction")]
    {
        format!(
            "{} @ {}",
            option_env!("VIBE_PHYSX_SDK_REVISION").unwrap_or("unrecorded"),
            option_env!("VIBE_PHYSX_SDK_ROOT").unwrap_or("unknown"),
        )
    }
    #[cfg(not(feature = "native-destruction"))]
    {
        "upstream PhysX (no destruction stage)".to_string()
    }
}
