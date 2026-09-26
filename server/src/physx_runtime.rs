#![cfg(feature = "physx-gpu")]

use std::collections::{HashMap, VecDeque};

use anyhow::{Context, Result};
use nalgebra::{DMatrix, Vector3};
use vibe_land_physx_bridge as bridge;
use vibe_land_shared::{
    constants::{
        BTN_JUMP, BTN_RELOAD, BTN_SPRINT, FLAG_DEAD, FLAG_IN_VEHICLE, FLAG_ON_GROUND,
        FLAG_SPAWN_PROTECTED,
        JUMP_ENERGY_COST, ON_FOOT_IDLE_DRAIN_PER_SEC, ON_FOOT_SPRINT_DRAIN_PER_SEC,
        ON_FOOT_WALK_DRAIN_PER_SEC, SHAPE_BOX, SHAPE_SPHERE, STARTING_ENERGY,
        VEHICLE_INTERACT_RADIUS_M,
    },
    movement::{
        build_wish_dir, input_to_vehicle_cmd, VehicleInputCmd, VEHICLE_DAMAGE_MIN_SPEED_M_S,
        VEHICLE_LETHAL_SPEED_M_S, VEHICLE_MAX_STEER_RAD,
    },
    physics_arena::{MoveConfig, PlayerDamageOutcome, PlayerTickResult},
    protocol::{make_net_vehicle_state, InputCmd, NetVehicleState},
    vehicle::{vehicle_definition, VEHICLE_RESET_FORWARD_M, VEHICLE_RESET_LIFT_M},
    world_document::{
        EffectiveTerrainMaterial, SpawnArea, TerrainMaterialField, WorldDocumentArena,
    },
};
use vibe_netcode::movement::{accelerate, apply_horizontal_friction, Vec3d};

use crate::movement::{PhysicsHealth, PlayerStateSummary, PlayerSupportState};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_DYNAMIC: u32 = 1 << 1;
const GROUP_PLAYER: u32 = 1 << 2;
const GROUP_VEHICLE: u32 = 1 << 3;
const GROUP_BATTERY: u32 = 1 << 4;
const GROUP_CHUNK: u32 = 1 << 5;
pub const ALL_GROUPS: u32 =
    GROUP_STATIC | GROUP_DYNAMIC | GROUP_PLAYER | GROUP_VEHICLE | GROUP_BATTERY | GROUP_CHUNK;

const NS_STATIC: u32 = 0x1000_0000;
const NS_DYNAMIC: u32 = 0x2000_0000;
const NS_PLAYER: u32 = 0x4000_0000;
const NS_VEHICLE: u32 = 0x6000_0000;
const NS_BATTERY: u32 = 0x7000_0000;
const ID_MASK: u32 = 0x0fff_ffff;
/// The namespace half of an entity id. Ids are only unique within one.
const NS_MASK: u32 = 0xf000_0000;

#[derive(Clone)]
struct PlayerState {
    position: Vec3d,
    velocity: Vec3d,
    yaw: f64,
    pitch: f64,
    last_input: InputCmd,
    on_ground: bool,
    hp: u8,
    dead: bool,
    spawn_protected: bool,
    energy: f32,
    controller_present: bool,
    support_entity_id: Option<u32>,
}

struct DynamicMeta {
    half_extents: [f32; 3],
    shape_type: u8,
}

/// Gap between the shooter's eye and the back of a fired ball.
///
/// The player is a capsule about 0.4 m across, so a ball created any closer
/// starts overlapping it and the first thing the solver does is push the
/// player, not the ball.
const MUZZLE_CLEARANCE_M: f32 = 0.6;

/// How many fired balls may exist at once.
///
/// Each one is a real rigid body with real contacts. Twenty-four is a few
/// seconds of sustained fire, which is as far ahead as anyone watches a shot.
const MAX_LIVE_LAUNCHED_BALLS: usize = 24;

/// Which reserved ring of ids a launch draws from.
#[derive(Clone, Copy)]
enum Pool {
    Ball,
    Meteor,
}

/// A ball that was fired as a projectile, and the tick it gets cleaned up on.
///
/// Fired balls are ordinary networked dynamic bodies, so the client already
/// knows how to draw them and nothing new goes on the wire. What they are not
/// is permanent: without a retirement every trigger pull would leave another
/// tonne of steel in the scene forever.
struct LaunchedBall {
    id: u32,
    expires_at: u64,
}

/// Wheel spin and steer in the wire's `u16` per wheel (spin `u8` << 8 | steer
/// `i8`), as the Rapier path encodes it. The vehicle SDK gives a rotation
/// speed, not an angle, so spin here is the speed folded into a phase per
/// tick; the client only turns it into a visual.
fn physx_wheel_data(snapshot: &bridge::VehicleSnapshot) -> [u16; 4] {
    let mut wheel_data = [0u16; 4];
    for (i, slot) in wheel_data.iter_mut().enumerate() {
        let spin = ((snapshot.wheel_rotation_speed[i] / std::f32::consts::TAU / 60.0)
            .fract()
            .abs()
            * 255.0) as u8;
        let steer = (snapshot.wheel_steer[i] / VEHICLE_MAX_STEER_RAD * 127.0).clamp(-127.0, 127.0)
            as i8 as u8;
        *slot = ((spin as u16) << 8) | (steer as u16);
    }
    wheel_data
}

struct VehicleMeta {
    steering_response: f32,
    steering_geometry: Option<(f32, f32, f32)>,
    vehicle_type: u8,
    driver_id: u32,
    latest_input: InputCmd,
    /// The steer the vehicle SDK is being asked for, in `-1..=1` of the full
    /// lock, slewed toward the driver's input each tick.
    steer_command: f32,
    /// Ticks until the next R is honoured, and whether R is currently down.
    reset_cooldown_ticks: u32,
    reset_held: bool,
}

/// The city car's tune on the vehicle SDK. The definition in the shared crate
/// gives the geometry; these are the numbers that decide how it drives.
///
/// A tyre transmits at most friction * load, about 1.4 * 1471 N = 2060 N on
/// a 150 kg corner, and the vehicle SDK's tyre model has a friction circle:
/// drive force spent on longitudinal slip is lateral grip gone. Rapier's
/// controller had no such coupling, so its 4000 N on two rear wheels was
/// harmless there and a permanent wheelspin here, where the first steer
/// input swung the tail out. All four wheels driven at 450 N m (1290 N per
/// tyre, ~60 % of the limit) keeps most of the lateral grip under full
/// throttle and still launches the car to 15 m/s in two seconds.
const PHYSX_VEHICLE_MASS_KG: f32 = 600.0;
const PHYSX_DRIVE_TORQUE_PER_WHEEL_N_M: f32 = 450.0;
const PHYSX_BRAKE_TORQUE_PER_WHEEL_N_M: f32 = 900.0;
const PHYSX_TYRE_FRICTION: f32 = 1.4;
/// Tyre stiffness as a multiple of the corner's rest load, the ratio NVIDIA's
/// reference car uses (21-31); the SDK defaults are absolute values for a
/// two-tonne car, four times too stiff for this one, which put the grip peak
/// at one degree of slip and made cornering a switch rather than a curve.
const PHYSX_FRONT_LATERAL_STIFFNESS_PER_N: f32 = 28.0;
const PHYSX_REAR_LATERAL_STIFFNESS_PER_N: f32 = 32.0;
const PHYSX_LONGITUDINAL_STIFFNESS_PER_N: f32 = 12.0;
/// Centre of mass 20 cm below the chassis centre, 15 cm above the axles.
const PHYSX_COM_OFFSET_Y_M: f32 = -0.2;
/// Rapier parity; settles the yaw after a swerve.
const PHYSX_ANGULAR_DAMPING: f32 = 0.5;
const PHYSX_TOP_SPEED_M_S: f32 = 30.0;
const PHYSX_REVERSE_TOP_SPEED_M_S: f32 = 8.0;
/// Steer slew in full locks per second: 0.2 s to full lock, 0.125 s back.
const STEER_SLEW_IN_PER_S: f32 = 5.0;
const STEER_SLEW_OUT_PER_S: f32 = 8.0;
/// Full lock up to the first speed, tapering to the fraction at the second.
const STEER_FULL_LOCK_BELOW_M_S: f32 = 6.0;
const STEER_MIN_LOCK_ABOVE_M_S: f32 = 28.0;
const STEER_MIN_LOCK_FRACTION: f32 = 0.35;
/// Below this speed the pedals pick the gear; above it the opposite pedal
/// brakes.
const PEDAL_DIRECTION_THRESHOLD_M_S: f32 = 1.0;
const VEHICLE_RESET_COOLDOWN_TICKS: u32 = 60;

/// How much of the full lock the steering may use at this forward speed.
fn steer_lock_fraction(forward_speed: f32) -> f32 {
    let t = ((forward_speed.abs() - STEER_FULL_LOCK_BELOW_M_S)
        / (STEER_MIN_LOCK_ABOVE_M_S - STEER_FULL_LOCK_BELOW_M_S))
        .clamp(0.0, 1.0);
    let smooth = t * t * (3.0 - 2.0 * t);
    1.0 - (1.0 - STEER_MIN_LOCK_FRACTION) * smooth
}

/// The driver's pedals and wheel as the vehicle SDK should see them this
/// tick. Steering is slewed toward the input and narrowed with speed so a
/// digital key is a ramp and full lock at 28 m/s is not on offer; the pedals
/// have the car's semantics, not the gearbox's: S while rolling forward
/// brakes, and only from a standstill does it reverse (and W the mirror).
fn shape_vehicle_commands(
    input: &VehicleInputCmd,
    forward_speed: f32,
    steer_command: &mut f32,
    dt: f32,
) -> bridge::VehicleCommands {
    shape_tuned_vehicle_commands(input, forward_speed, steer_command, dt, 1.0, 1.0)
}

fn shape_tuned_vehicle_commands(
    input: &VehicleInputCmd, forward_speed: f32, steer_command: &mut f32, dt: f32, response: f32, lock_limit: f32,
) -> bridge::VehicleCommands {
    let target = input.steer.clamp(-1.0, 1.0) * steer_lock_fraction(forward_speed).min(lock_limit);
    let rate = if target.abs() > steer_command.abs() {
        STEER_SLEW_IN_PER_S
    } else {
        STEER_SLEW_OUT_PER_S
    };
    let step = rate * response * dt;
    *steer_command += (target - *steer_command).clamp(-step, step);

    let rolling_forward = forward_speed > PEDAL_DIRECTION_THRESHOLD_M_S;
    let rolling_back = forward_speed < -PEDAL_DIRECTION_THRESHOLD_M_S;
    let (mut throttle, brake, reverse) = if rolling_forward && input.reverse > 0.0 && input.throttle <= 0.0 {
        (0.0, input.reverse, false)
    } else if rolling_back && input.throttle > 0.0 && input.reverse <= 0.0 {
        (0.0, input.throttle, true)
    } else {
        let reverse = input.reverse > 0.0 && input.throttle <= 0.0;
        (if reverse { input.reverse } else { input.throttle }, 0.0, reverse)
    };
    // Disengage drive while the handbrake is held. Otherwise the unbraked
    // front axle keeps pulling this AWD vehicle against its locked rear axle.
    if input.handbrake || (reverse && forward_speed < -PHYSX_REVERSE_TOP_SPEED_M_S) {
        throttle = 0.0;
    }
    bridge::VehicleCommands {
        throttle,
        brake,
        handbrake: if input.handbrake { 1.0 } else { 0.0 },
        steer: *steer_command,
        reverse,
    }
}

/// Forward speed and how upright a vehicle is, from its last snapshot.
fn vehicle_heading(snapshot: &bridge::VehicleSnapshot) -> (nalgebra::UnitQuaternion<f32>, f32, f32) {
    let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
        snapshot.pose.rotation.w,
        snapshot.pose.rotation.x,
        snapshot.pose.rotation.y,
        snapshot.pose.rotation.z,
    ));
    let forward = rotation * Vector3::z();
    let up = rotation * Vector3::y();
    let velocity = Vector3::new(
        snapshot.linear_velocity.x,
        snapshot.linear_velocity.y,
        snapshot.linear_velocity.z,
    );
    (rotation, velocity.dot(&forward), up.y)
}

/// Where a reset puts the car: lifted a metre, upright, its planar heading
/// kept, nudged forward so the hull clears whatever it was wedged against.
/// The same numbers as the Rapier `reset_vehicle_body`.
fn vehicle_reset_pose(snapshot: &bridge::VehicleSnapshot) -> bridge::Pose {
    let (rotation, _, _) = vehicle_heading(snapshot);
    let forward = rotation * Vector3::z();
    let planar = Vector3::new(forward.x, 0.0, forward.z);
    let (yaw, nudge) = if planar.norm_squared() > 1e-4 {
        let n = planar.normalize();
        (n.x.atan2(n.z), n * VEHICLE_RESET_FORWARD_M)
    } else {
        (0.0, Vector3::new(0.0, 0.0, VEHICLE_RESET_FORWARD_M))
    };
    let upright = nalgebra::UnitQuaternion::from_axis_angle(&Vector3::y_axis(), yaw);
    pose(
        Vector3::new(
            snapshot.pose.position.x + nudge.x,
            snapshot.pose.position.y + VEHICLE_RESET_LIFT_M,
            snapshot.pose.position.z + nudge.z,
        ),
        [upright.i, upright.j, upright.k, upright.w],
    )
}

struct BatteryState {
    position: [f32; 3],
    energy: f32,
    radius: f32,
    height: f32,
}

/// Rust gameplay adapter over the single-threaded C++ PhysX scene.
pub struct PhysxPhysicsArena {
    /// Whether a step the engine refuses to complete is survivable.
    ///
    /// True only for PhysX's native destruction stage, which documents a
    /// rejected step as an outcome: it declines to publish a step whose stress
    /// solve did not converge. Every other backend treats a failed step as the
    /// engine being broken, where continuing would publish a fiction.
    ///
    /// Set from the backend that is actually running rather than read from the
    /// environment, because the two can disagree -- and when they did, a
    /// rejected step went down the path that reads a scene which never
    /// finished stepping.
    tolerate_rejected_steps: bool,
    world: bridge::World,
    config: MoveConfig,
    players: HashMap<u32, PlayerState>,
    dynamic: HashMap<u32, DynamicMeta>,
    vehicles: HashMap<u32, VehicleMeta>,
    vehicle_of_player: HashMap<u32, u32>,
    batteries: HashMap<u32, BatteryState>,
    spawn_areas: Vec<SpawnArea>,
    runtime_static: HashMap<u64, (u32, u128)>,
    next_static_id: u32,
    next_dynamic_id: u32,
    next_battery_id: u32,
    /// Ids reserved for fired balls, used as a ring.
    ///
    /// Clients learn a dynamic body's handle, shape and size from one metadata
    /// packet sent when they join, and that packet is a full replacement rather
    /// than a delta. A ball given a fresh id at fire time would therefore be
    /// invisible: the snapshot would carry a handle the client has no entry
    /// for, and it would be dropped. Reserving the ids up front means the
    /// metadata every client already has covers every ball the match can fire.
    ball_pool: Vec<u32>,
    ball_cursor: usize,
    /// The meteor's own ring of ids, for the same reason and with its own
    /// metadata: the join-time packet carries one radius per id, and a meteor
    /// through a cannonball's id would be drawn as a cannonball.
    meteor_pool: Vec<u32>,
    meteor_cursor: usize,
    /// Fired balls and meteors, oldest first, with the tick each one retires on.
    launched_balls: VecDeque<LaunchedBall>,
    /// Radius the balls were launched with, for the travel clamp.
    ball_radius_m: f32,
    /// Top of the lowest static surface authored into the world (terrain
    /// sample or static box), if any. The ground bodies are measured against.
    lowest_ground_y: Option<f32>,
    /// Fired balls and meteors through the ground: first-tick forensics and
    /// the retire floor. See `vibe_land_destruction::ground_watch`.
    ball_ground: vibe_land_destruction::ground_watch::GroundWatch,
    /// Each live fired ball's pose, velocity and whether it reported a contact
    /// with static geometry, as of the last step: the "tick before" of a
    /// below-ground report.
    ball_ground_previous: HashMap<u32, ([f32; 3], [f32; 3], bool)>,
    /// Below-ground and retire lines logged; bounded.
    ball_ground_logged: u32,
    /// How many times a ball was held at a surface it would have skipped.
    balls_clamped: u64,
    /// Counts accepted steps, which is what a ball's lifetime is measured in.
    /// Deliberately not the match tick: this is arena bookkeeping and must not
    /// depend on a caller remembering to pass a clock.
    launch_tick: u64,
    material_field: Option<TerrainMaterialField>,
    /// The GPU buffer capacities this scene was created with. Published beside
    /// the high-water marks so utilisation reads as a ratio: with no caps on
    /// body or bond count, overrunning one of these is a real failure mode, and
    /// "1.9M contacts" means nothing without the ceiling next to it.
    gpu_max_rigid_contacts: u32,
    gpu_max_rigid_patches: u32,
    contact_events: Vec<bridge::ContactEvent>,
    audio_contacts_ready: bool,
    cached_body_snapshots: Vec<bridge::BodySnapshot>,
    cached_vehicle_snapshots: Vec<bridge::VehicleSnapshot>,
    snapshots_valid: bool,
    /// Interior of the old single `dynamics_ms` bracket: the three FFI
    /// readbacks after the step, the player refresh, and the vehicle control
    /// loop before it. Without these, `dynamics_ms - physics_last_step_ms` was
    /// a real cost with no name.
    last_readback_ms: f32,
    last_refresh_players_ms: f32,
    last_vehicle_control_ms: f32,
    /// Dispatch cost of the last begin_dynamics(), folded into dynamics_ms by
    /// finish_dynamics() so the split-step path reports the same total the
    /// combined step_vehicles_and_dynamics() does.
    pending_begin_ms: f32,
}

impl PhysxPhysicsArena {
    /// Installs fixed chassis geometry for the custom-vehicle integration.
    /// This is not yet a destructible vehicle: native stress ownership, moving
    /// part shapes, measured inertia/COM, and trailer constraints are pending.
    /// The garage uses this for private drives; native stress coupling is pending.
    pub fn spawn_vehicle_asset(&mut self, id:u32, vehicle_type:u8, position:Vector3<f32>, rotation:[f32;4], prepared:Option<&crate::vehicle_assets::PreparedGeometry>) -> Result<(), bridge::BridgeError> {
        let tune = prepared.and_then(|p| p.driving.as_ref());
        let desc = Self::vehicle_asset_desc(id, vehicle_type, position, rotation, prepared);
        self.world.add_vehicle(desc)?;
        if let Some(asset) = prepared {
            let shapes: Vec<bridge::VehiclePartShape> = asset.parts.iter().enumerate()
                .filter(|(_, part)| part.motion.is_none())
                .flat_map(|(part_index, part)| part.shapes.iter().map(move |shape| bridge::VehiclePartShape {
                    part_index: part_index as u32,
                    position: bridge::Vec3::new(part.position[0]+shape.position[0], part.position[1]+shape.position[1], part.position[2]+shape.position[2]),
                    points: shape.vertices.iter().map(|p| bridge::Vec3::new(p[0],p[1],p[2])).collect(),
                })).collect();
            if let Err(error) = self.world.set_vehicle_shapes(NS_VEHICLE | (id & ID_MASK), &shapes) {
                let _ = self.world.remove_actor(NS_VEHICLE | (id & ID_MASK));
                return Err(error);
            }
        }
        self.snapshots_valid = false;
        self.vehicles.insert(
            id,
            VehicleMeta {
                steering_response: tune.map(|t| t.steering_response).unwrap_or(1.0),
                steering_geometry: tune.map(|t| ((desc.front_axle_z-desc.rear_axle_z).abs(), t.max_steer_radians, t.tyre_friction)),
                vehicle_type,
                driver_id: 0,
                latest_input: InputCmd::default(),
                steer_command: 0.0,
                reset_cooldown_ticks: 0,
                reset_held: false,
            },
        );
        Ok(())
    }

    /// Shared descriptor for live driving and the full authored-asset native probe.
    fn vehicle_asset_desc(id:u32, vehicle_type:u8, position:Vector3<f32>, rotation:[f32;4], prepared:Option<&crate::vehicle_assets::PreparedGeometry>) -> bridge::VehicleDesc {
        // The shared vehicle definition drives both backends: the same hull
        // extents, wheel hard points, suspension rest and travel and wheel
        // radius the Rapier controller and the client's meshes use. The
        // vehicle SDK measures suspension from the chassis centre, so the
        // attachment sits where the Rapier rest length ends up placing the
        // wheel after its own static compression.
        let tune = prepared.and_then(|p| p.driving.as_ref());
        let definition = vehicle_definition(vehicle_type);
        let [half_x, half_y, half_z] = prepared.map(|p| std::array::from_fn(|i| p.bounds.min[i].abs().max(p.bounds.max[i].abs()).max(0.01))).unwrap_or(definition.chassis_half_extents);
        let [[wheel_x, _, front_z], _, [_, _, rear_z], _] = prepared.map(|p| p.wheel_centers).unwrap_or(definition.wheel_offsets);
        let mass = prepared.map(|p| p.mass).unwrap_or(PHYSX_VEHICLE_MASS_KG);
        let travel = prepared.map(|p| p.suspension_travel).unwrap_or(definition.suspension_travel_m);
        // A quarter of the chassis on each corner; rest compression about a
        // third of the travel, critically damped.
        let sprung = mass / 4.0;
        let rest_load = sprung * 9.81;
        let stiffness = rest_load / prepared.map(|p| p.neutral_jounce).unwrap_or(travel / 3.0);
        let damping = 2.0 * (stiffness * sprung).sqrt();
        bridge::VehicleDesc {
                entity_id: NS_VEHICLE | (id & ID_MASK),
                user_id: id,
                pose: pose(position, rotation),
                chassis_half_extents: bridge::Vec3::new(half_x, half_y, half_z),
                mass,
                inertia: bridge::Vec3::new(0.0, 0.0, 0.0),
                half_track: wheel_x.abs(),
                suspension_attachment_y: prepared.map(|p| p.suspension_attachment_y).unwrap_or(-(definition.suspension_rest_length_m - travel * 2.0 / 3.0)),
                front_axle_z: front_z.max(rear_z),
                rear_axle_z: front_z.min(rear_z),
                suspension_travel: travel,
                suspension_stiffness: tune.map(|t| t.spring_stiffness).unwrap_or(stiffness),
                suspension_damping: tune.map(|t| t.damping).unwrap_or(damping),
                wheel_radius: prepared.map(|p| p.origin_height - 0.25).unwrap_or(definition.wheel_radius_m),
                wheel_half_width: prepared.map(|p| p.wheel_half_width).unwrap_or(0.15),
                tyre_friction: tune.map(|t| t.tyre_friction).unwrap_or(PHYSX_TYRE_FRICTION),
                front_lateral_stiffness: PHYSX_FRONT_LATERAL_STIFFNESS_PER_N * rest_load,
                rear_lateral_stiffness: PHYSX_REAR_LATERAL_STIFFNESS_PER_N * rest_load,
                longitudinal_stiffness: PHYSX_LONGITUDINAL_STIFFNESS_PER_N * rest_load,
                com_offset_y: PHYSX_COM_OFFSET_Y_M,
                angular_damping: PHYSX_ANGULAR_DAMPING,
                max_steer_radians: tune.map(|t| t.max_steer_radians).unwrap_or_else(|| prepared.map(|p| p.max_steer_radians).unwrap_or(VEHICLE_MAX_STEER_RAD)),
                drive_torque: tune.map(|t| t.drive_torque).unwrap_or(PHYSX_DRIVE_TORQUE_PER_WHEEL_N_M * mass / PHYSX_VEHICLE_MASS_KG),
                brake_torque: tune.map(|t| t.brake_torque).unwrap_or(PHYSX_BRAKE_TORQUE_PER_WHEEL_N_M * mass / PHYSX_VEHICLE_MASS_KG),
                handbrake_torque: 2.0 * tune.map(|t| t.brake_torque).unwrap_or(PHYSX_BRAKE_TORQUE_PER_WHEEL_N_M * mass / PHYSX_VEHICLE_MASS_KG),
                top_speed: tune.map(|t| t.top_speed).unwrap_or(PHYSX_TOP_SPEED_M_S),
                front_wheel_drive: tune.is_some_and(|t| t.front_wheel_drive),
                rear_wheel_drive: tune.is_some_and(|t| t.rear_wheel_drive),
                // Sweeps ride a cylinder over rubble; raycasts fall between chunks.
                sweep_road_queries: true,
                road_mask: GROUP_STATIC | GROUP_DYNAMIC | GROUP_CHUNK,
                collision_group: GROUP_VEHICLE,
                collision_mask: ALL_GROUPS,
        }
    }

    pub fn new(config: MoveConfig) -> Result<Self> {
        let mut world_config = bridge::WorldConfig::default();
        world_config.gpu_max_rigid_contacts = env_u32(
            "VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS",
            world_config.gpu_max_rigid_contacts,
        )?;
        world_config.gpu_max_rigid_patches = env_u32(
            "VIBE_PHYSX_GPU_MAX_RIGID_PATCHES",
            world_config.gpu_max_rigid_patches,
        )?;
        world_config.gpu_heap_capacity = env_u32(
            "VIBE_PHYSX_GPU_HEAP_CAPACITY",
            world_config.gpu_heap_capacity,
        )?;
        world_config.gpu_found_lost_pairs_capacity = env_u32(
            "VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY",
            world_config.gpu_found_lost_pairs_capacity,
        )?;
        world_config.gpu_collision_stack_size = env_u32(
            "VIBE_PHYSX_GPU_COLLISION_STACK_SIZE",
            world_config.gpu_collision_stack_size,
        )?;
        let world = bridge::World::new(world_config)
            .context("failed to initialize required PhysX GPU scene")?;
        Ok(Self {
            tolerate_rejected_steps: false,
            world,
            config,
            players: HashMap::new(),
            dynamic: HashMap::new(),
            vehicles: HashMap::new(),
            vehicle_of_player: HashMap::new(),
            batteries: HashMap::new(),
            spawn_areas: Vec::new(),
            runtime_static: HashMap::new(),
            next_static_id: 1,
            next_dynamic_id: 1,
            ball_radius_m: 0.0,
            lowest_ground_y: None,
            ball_ground: vibe_land_destruction::ground_watch::GroundWatch::new(
                None,
                vibe_land_destruction::ground_watch::retire_depth_m(),
            ),
            ball_ground_previous: HashMap::new(),
            ball_ground_logged: 0,
            balls_clamped: 0,
            ball_pool: Vec::new(),
            ball_cursor: 0,
            meteor_pool: Vec::new(),
            meteor_cursor: 0,
            launched_balls: VecDeque::new(),
            launch_tick: 0,
            next_battery_id: 1,
            material_field: None,
            contact_events: Vec::new(),
            audio_contacts_ready: false,
            cached_body_snapshots: Vec::new(),
            cached_vehicle_snapshots: Vec::new(),
            snapshots_valid: false,
            gpu_max_rigid_contacts: world_config.gpu_max_rigid_contacts,
            gpu_max_rigid_patches: world_config.gpu_max_rigid_patches,
            last_readback_ms: 0.0,
            last_refresh_players_ms: 0.0,
            last_vehicle_control_ms: 0.0,
            pending_begin_ms: 0.0,
        })
    }

    fn current_body_snapshots(&self) -> Vec<bridge::BodySnapshot> {
        if self.snapshots_valid {
            self.cached_body_snapshots.clone()
        } else {
            self.world
                .body_snapshots()
                .expect("PhysX body readback failed")
        }
    }

    fn current_vehicle_snapshots(&self) -> Vec<bridge::VehicleSnapshot> {
        if self.snapshots_valid {
            self.cached_vehicle_snapshots.clone()
        } else {
            self.world
                .vehicle_snapshots()
                .expect("PhysX vehicle readback failed")
        }
    }

    pub fn config(&self) -> &MoveConfig {
        &self.config
    }

    #[cfg(feature = "physx-city")]
    pub fn world_mut(&mut self) -> &mut bridge::World {
        &mut self.world
    }

    #[cfg(feature = "physx-city")]
    pub fn world(&self) -> &bridge::World {
        &self.world
    }

    pub fn set_spawn_areas(&mut self, areas: Vec<SpawnArea>) {
        self.spawn_areas = areas;
    }

    pub fn spawn_areas(&self) -> &[SpawnArea] {
        &self.spawn_areas
    }

    fn spawn_position(&self, id: u32) -> Vec3d {
        if let Some(area) = self
            .spawn_areas
            .get(id as usize % self.spawn_areas.len().max(1))
        {
            Vec3d::new(
                area.position[0] as f64,
                area.position[1] as f64 + 1.2,
                area.position[2] as f64,
            )
        } else {
            Vec3d::new((id % 8) as f64 * 1.5, 2.0, ((id / 8) % 8) as f64 * 1.5)
        }
    }

    fn player_bridge_id(id: u32) -> u32 {
        NS_PLAYER | (id & ID_MASK)
    }

    fn add_player_controller(&mut self, id: u32, position: Vec3d) -> Result<()> {
        self.world.add_capsule_player(bridge::CapsulePlayerDesc {
            entity_id: Self::player_bridge_id(id),
            user_id: id,
            position: bridge::Vec3::new(position.x as f32, position.y as f32, position.z as f32),
            cylinder_height: self.config.capsule_half_segment * 2.0,
            radius: self.config.capsule_radius,
            step_offset: self.config.max_step_height,
            contact_offset: self.config.collision_offset.max(0.01),
            slope_limit_radians: self.config.max_slope_radians,
            collision_group: GROUP_PLAYER,
            collision_mask: GROUP_STATIC | GROUP_DYNAMIC | GROUP_VEHICLE | GROUP_CHUNK,
        })?;
        Ok(())
    }

    pub fn spawn_player(&mut self, id: u32) -> Vec3d {
        let position = self.spawn_position(id);
        self.add_player_controller(id, position)
            .expect("PhysX player controller creation failed");
        self.players.insert(
            id,
            PlayerState {
                position,
                velocity: Vec3d::zeros(),
                yaw: 0.0,
                pitch: 0.0,
                last_input: InputCmd::default(),
                on_ground: false,
                hp: 100,
                dead: false,
                spawn_protected: false,
                energy: STARTING_ENERGY,
                controller_present: true,
                support_entity_id: None,
            },
        );
        position
    }

    pub fn remove_player(&mut self, id: u32) {
        if self.players.remove(&id).is_some() {
            let _ = self.world.remove_actor(Self::player_bridge_id(id));
        }
        self.exit_vehicle(id);
    }

    pub fn drop_player_from_camera(&mut self, id: u32, cmd: &vibe_land_shared::protocol::CityCameraDropCmd) -> bool {
        let Some(previous) = self.players.get(&id).cloned() else { return false; };
        if previous.dead || !cmd.is_valid() { return false; }
        if previous.controller_present && self.world.remove_actor(Self::player_bridge_id(id)).is_err() {
            return false;
        }
        let position = Vec3d::new(f64::from(cmd.position[0]), f64::from(cmd.position[1]), f64::from(cmd.position[2]));
        if self.add_player_controller(id, position).is_err() {
            if previous.controller_present {
                self.add_player_controller(id, previous.position)
                    .expect("failed to restore player controller after rejected camera drop");
            }
            return false;
        }
        // A seated player has no controller. The new controller is already at
        // the destination, so detach ownership without creating an exit one.
        if let Some(vehicle_id) = self.vehicle_of_player.remove(&id) {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                if vehicle.driver_id == id {
                    vehicle.driver_id = 0;
                    vehicle.latest_input = InputCmd::default();
                }
            }
        }
        let state = self.players.get_mut(&id).expect("checked player");
        state.position = position;
        state.velocity = Vec3d::zeros();
        state.yaw = f64::from(cmd.yaw);
        state.pitch = f64::from(cmd.pitch);
        state.last_input = InputCmd { yaw: cmd.yaw, pitch: cmd.pitch, ..InputCmd::default() };
        state.on_ground = false;
        state.controller_present = true;
        state.support_entity_id = None;
        true
    }

    pub fn respawn_player(&mut self, id: u32) -> Option<[f32; 3]> {
        let position = self.spawn_position(id);
        let bridge_id = Self::player_bridge_id(id);
        if self
            .players
            .get(&id)
            .is_some_and(|state| state.controller_present)
        {
            let _ = self.world.remove_actor(bridge_id);
        }
        self.add_player_controller(id, position).ok()?;
        let state = self.players.get_mut(&id)?;
        state.position = position;
        state.velocity = Vec3d::zeros();
        state.hp = 100;
        state.dead = false;
        state.energy = STARTING_ENERGY;
        state.on_ground = false;
        state.controller_present = true;
        Some([position.x as f32, position.y as f32, position.z as f32])
    }

    pub fn simulate_player_tick(
        &mut self,
        id: u32,
        input: &InputCmd,
        dt: f32,
    ) -> Option<PlayerTickResult> {
        let in_vehicle = self.vehicle_of_player.get(&id).copied();
        if let Some(vehicle_id) = in_vehicle {
            if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
                vehicle.latest_input = input.clone();
            }
            if let Some(state) = self.players.get_mut(&id) {
                state.last_input = input.clone();
            }
            return Some(PlayerTickResult::default());
        }

        let state = self.players.get_mut(&id)?;
        if state.dead || !state.controller_present {
            return Some(PlayerTickResult::default());
        }
        state.yaw = input.yaw as f64;
        state.pitch = input.pitch.clamp(-1.55, 1.55) as f64;

        let wish = build_wish_dir(input, state.yaw);
        apply_horizontal_friction(
            &mut state.velocity,
            self.config.friction,
            dt as f64,
            state.on_ground,
        );
        let speed = if input.buttons & BTN_SPRINT != 0 {
            self.config.sprint_speed
        } else {
            self.config.walk_speed
        };
        accelerate(
            &mut state.velocity,
            wish,
            speed,
            if state.on_ground {
                self.config.ground_accel
            } else {
                self.config.air_accel
            },
            dt as f64,
        );
        if input.buttons & BTN_JUMP != 0 && state.on_ground && state.energy >= JUMP_ENERGY_COST {
            state.velocity.y = self.config.jump_speed;
            state.on_ground = false;
        } else if !state.on_ground {
            state.velocity.y -= self.config.gravity * dt as f64;
        } else {
            state.velocity.y = -0.5;
        }
        self.world
            .move_player(
                Self::player_bridge_id(id),
                bridge::Vec3::new(
                    (state.velocity.x * dt as f64) as f32,
                    (state.velocity.y * dt as f64) as f32,
                    (state.velocity.z * dt as f64) as f32,
                ),
            )
            .expect("PhysX CCT move failed");
        state.last_input = input.clone();
        Some(PlayerTickResult::default())
    }

    fn refresh_players(&mut self) {
        let snapshots = self
            .world
            .player_snapshots()
            .expect("PhysX player state readback failed");
        for snapshot in snapshots {
            let Some(state) = self.players.get_mut(&snapshot.user_id) else {
                continue;
            };
            state.position = Vec3d::new(
                snapshot.pose.position.x as f64,
                snapshot.pose.position.y as f64,
                snapshot.pose.position.z as f64,
            );
            state.velocity = Vec3d::new(
                snapshot.velocity.x as f64,
                snapshot.velocity.y as f64,
                snapshot.velocity.z as f64,
            );
            state.on_ground = snapshot.grounded;
            state.support_entity_id = snapshot.has_support.then_some(snapshot.support_entity_id);
        }
        // A seated player has no controller and would otherwise stay at the
        // point they got in: the snapshot anchor, area of interest and lag
        // compensation all read this position, and beyond 82 m of it the
        // driven vehicle itself falls out of the client's snapshot.
        for (&player_id, &vehicle_id) in &self.vehicle_of_player {
            let Some(vehicle) = self
                .cached_vehicle_snapshots
                .iter()
                .find(|snapshot| snapshot.user_id == vehicle_id)
            else {
                continue;
            };
            let Some(state) = self.players.get_mut(&player_id) else {
                continue;
            };
            state.position = Vec3d::new(
                vehicle.pose.position.x as f64,
                vehicle.pose.position.y as f64,
                vehicle.pose.position.z as f64,
            );
            state.velocity = Vec3d::new(
                vehicle.linear_velocity.x as f64,
                vehicle.linear_velocity.y as f64,
                vehicle.linear_velocity.z as f64,
            );
            state.on_ground = false;
            state.support_entity_id = None;
        }
    }

    pub fn snapshot_player(&self, id: u32) -> Option<([f32; 3], [f32; 3], f32, f32, u8, u16)> {
        let state = self.players.get(&id)?;
        let mut flags = 0;
        if state.on_ground {
            flags |= FLAG_ON_GROUND;
        }
        if state.dead {
            flags |= FLAG_DEAD;
        }
        if state.spawn_protected {
            flags |= FLAG_SPAWN_PROTECTED;
        }
        if self.vehicle_of_player.contains_key(&id) {
            flags |= FLAG_IN_VEHICLE;
        }
        Some((
            [
                state.position.x as f32,
                state.position.y as f32,
                state.position.z as f32,
            ],
            [
                state.velocity.x as f32,
                state.velocity.y as f32,
                state.velocity.z as f32,
            ],
            state.yaw as f32,
            state.pitch as f32,
            state.hp,
            flags,
        ))
    }

    pub fn player_state(&self, id: u32) -> Option<PlayerStateSummary> {
        let state = self.players.get(&id)?;
        Some(PlayerStateSummary {
            position: state.position,
            last_input: state.last_input.clone(),
            on_ground: state.on_ground,
            hp: state.hp,
            dead: state.dead,
            energy: state.energy,
        })
    }

    pub fn player_ids(&self) -> Vec<u32> {
        self.players.keys().copied().collect()
    }

    pub fn player_support(&self, id: u32) -> Option<PlayerSupportState> {
        let player = self.players.get(&id)?;
        let bridge_entity_id = player.support_entity_id?;
        let body = self
            .current_body_snapshots()
            .into_iter()
            .find(|body| body.entity_id == bridge_entity_id)?;
        let player_position = nalgebra::Point3::new(
            player.position.x as f32,
            player.position.y as f32,
            player.position.z as f32,
        );
        let support_position = nalgebra::Point3::new(
            body.pose.position.x,
            body.pose.position.y,
            body.pose.position.z,
        );
        let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
            body.pose.rotation.w,
            body.pose.rotation.x,
            body.pose.rotation.y,
            body.pose.rotation.z,
        ));
        let support_to_player = player_position - support_position;
        let local = rotation.inverse_transform_vector(&support_to_player);
        let angular_velocity = Vector3::new(
            body.angular_velocity.x,
            body.angular_velocity.y,
            body.angular_velocity.z,
        );
        let point_velocity = Vector3::new(
            body.linear_velocity.x,
            body.linear_velocity.y,
            body.linear_velocity.z,
        ) + angular_velocity.cross(&support_to_player);
        let is_vehicle = bridge_entity_id & 0xf000_0000 == NS_VEHICLE;
        Some(PlayerSupportState {
            entity_id: body.user_id,
            is_vehicle,
            local_position: local.into(),
            velocity: point_velocity.into(),
            angular_velocity: angular_velocity.into(),
            flags: u8::from(body.sleeping),
        })
    }

    pub fn add_player_energy(&mut self, id: u32, delta: f32) -> Option<f32> {
        let state = self.players.get_mut(&id)?;
        state.energy = (state.energy + delta).max(0.0);
        Some(state.energy)
    }

    pub fn player_energy(&self, id: u32) -> Option<f32> {
        self.players.get(&id).map(|state| state.energy)
    }

    pub fn set_player_dead(&mut self, id: u32, dead: bool) {
        let Some(state) = self.players.get_mut(&id) else {
            return;
        };
        state.dead = dead;
        if dead && state.controller_present {
            let _ = self.world.remove_actor(Self::player_bridge_id(id));
            state.controller_present = false;
        }
    }

    pub fn set_player_spawn_protected(&mut self, id: u32, value: bool) -> bool {
        let Some(state) = self.players.get_mut(&id) else {
            return false;
        };
        state.spawn_protected = value;
        true
    }

    pub fn apply_player_damage(&mut self, id: u32, damage: u8) -> PlayerDamageOutcome {
        let Some(state) = self.players.get_mut(&id) else {
            return PlayerDamageOutcome::Ignored;
        };
        if state.dead || state.spawn_protected {
            return PlayerDamageOutcome::Ignored;
        }
        state.hp = state.hp.saturating_sub(damage);
        if state.hp == 0 {
            PlayerDamageOutcome::Killed
        } else {
            PlayerDamageOutcome::Damaged
        }
    }

    pub fn is_player_in_vehicle(&self, id: u32) -> bool {
        self.vehicle_of_player.contains_key(&id)
    }

    pub fn player_vehicle_id(&self, id: u32) -> Option<u32> {
        self.vehicle_of_player.get(&id).copied()
    }

    pub fn vehicle_exists(&self, id: u32) -> bool {
        self.vehicles.contains_key(&id)
    }

    pub fn enter_vehicle(&mut self, player_id: u32, vehicle_id: u32) {
        let Some(player) = self.players.get(&player_id) else {
            return;
        };
        let Some(vehicle) = self.vehicles.get(&vehicle_id) else {
            return;
        };
        if vehicle.driver_id != 0 && vehicle.driver_id != player_id {
            return;
        }
        if self.vehicle_of_player.get(&player_id) == Some(&vehicle_id) {
            return;
        }
        let Some(vehicle_snapshot) = self
            .current_vehicle_snapshots()
            .into_iter()
            .find(|state| state.user_id == vehicle_id)
        else {
            return;
        };
        let dx = player.position.x as f32 - vehicle_snapshot.pose.position.x;
        let dy = player.position.y as f32 - vehicle_snapshot.pose.position.y;
        let dz = player.position.z as f32 - vehicle_snapshot.pose.position.z;
        if dx * dx + dy * dy + dz * dz > VEHICLE_INTERACT_RADIUS_M * VEHICLE_INTERACT_RADIUS_M {
            return;
        }

        self.exit_vehicle(player_id);
        if let Some(state) = self.players.get_mut(&player_id) {
            if state.controller_present {
                self.world
                    .remove_actor(Self::player_bridge_id(player_id))
                    .expect("failed to remove seated player's PhysX controller");
                state.controller_present = false;
            }
            state.position = Vec3d::new(
                vehicle_snapshot.pose.position.x as f64,
                vehicle_snapshot.pose.position.y as f64,
                vehicle_snapshot.pose.position.z as f64,
            );
            state.velocity = Vec3d::new(
                vehicle_snapshot.linear_velocity.x as f64,
                vehicle_snapshot.linear_velocity.y as f64,
                vehicle_snapshot.linear_velocity.z as f64,
            );
            state.on_ground = false;
            state.support_entity_id = None;
        }
        self.vehicle_of_player.insert(player_id, vehicle_id);
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            vehicle.driver_id = player_id;
        }
    }

    pub fn exit_vehicle(&mut self, player_id: u32) {
        let Some(vehicle_id) = self.vehicle_of_player.remove(&player_id) else {
            return;
        };
        if let Some(vehicle) = self.vehicles.get_mut(&vehicle_id) {
            if vehicle.driver_id == player_id {
                vehicle.driver_id = 0;
            }
        }
        let Some(player) = self.players.get(&player_id) else {
            return;
        };
        if player.dead || player.controller_present {
            return;
        }
        let Some(vehicle_snapshot) = self
            .current_vehicle_snapshots()
            .into_iter()
            .find(|state| state.user_id == vehicle_id)
        else {
            return;
        };
        let rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(
            vehicle_snapshot.pose.rotation.w,
            vehicle_snapshot.pose.rotation.x,
            vehicle_snapshot.pose.rotation.y,
            vehicle_snapshot.pose.rotation.z,
        ));
        let side = rotation.transform_vector(&Vector3::new(1.8, 0.0, 0.0));
        let exit_position = Vec3d::new(
            (vehicle_snapshot.pose.position.x + side.x) as f64,
            (vehicle_snapshot.pose.position.y + 0.5) as f64,
            (vehicle_snapshot.pose.position.z + side.z) as f64,
        );
        self.add_player_controller(player_id, exit_position)
            .expect("failed to restore exited player's PhysX controller");
        if let Some(state) = self.players.get_mut(&player_id) {
            state.position = exit_position;
            state.velocity = Vec3d::new(
                vehicle_snapshot.linear_velocity.x as f64,
                vehicle_snapshot.linear_velocity.y as f64,
                vehicle_snapshot.linear_velocity.z as f64,
            );
            state.controller_present = true;
            state.on_ground = false;
            state.support_entity_id = None;
        }
    }

    pub fn tune_vehicle(&mut self,id:u32,tune:&crate::vehicle_assets::PreparedDriving)->Result<(),String> {
        if !tune.is_valid() {return Err("Invalid vehicle tuning".into());}
        let vehicle=self.vehicles.get_mut(&id).ok_or("Vehicle not found")?;
        self.world.tune_vehicle(NS_VEHICLE | (id & ID_MASK),bridge::VehicleTuning {
            suspension_stiffness:tune.spring_stiffness,suspension_damping:tune.damping,
            tyre_friction:tune.tyre_friction,max_steer_radians:tune.max_steer_radians,
            drive_torque:tune.drive_torque,brake_torque:tune.brake_torque,
            handbrake_torque:2.0*tune.brake_torque,top_speed:tune.top_speed,front_wheel_drive:tune.front_wheel_drive,rear_wheel_drive:tune.rear_wheel_drive,
        }).map_err(|e|e.to_string())?;
        vehicle.steering_response=tune.steering_response;
        if let Some((wheelbase,_,_))=vehicle.steering_geometry {
            vehicle.steering_geometry=Some((wheelbase,tune.max_steer_radians,tune.tyre_friction));
        }
        Ok(())
    }

    fn drive_vehicles(&mut self) {
        let vehicles_started = std::time::Instant::now();
        let dt = 1.0 / f32::from(vibe_land_shared::constants::SIM_HZ);
        for (&id, vehicle) in &mut self.vehicles {
            let entity = NS_VEHICLE | (id & ID_MASK);
            let snapshot = self
                .cached_vehicle_snapshots
                .iter()
                .find(|snapshot| snapshot.user_id == id);
            vehicle.reset_cooldown_ticks = vehicle.reset_cooldown_ticks.saturating_sub(1);
            // The same input mapping as the Rapier controller. A vehicle
            // without a driver sits on its handbrake and nothing else: the
            // vehicle SDK applies nothing and wakes nothing for a car at
            // rest, so a parked car sleeps with the rubble around it, and a
            // player walking into it no longer sends it rolling down the
            // street on free wheels.
            let cmd = if vehicle.driver_id == 0 {
                vehicle.steer_command = 0.0;
                vehicle.reset_held = false;
                bridge::VehicleCommands {
                    handbrake: 1.0,
                    ..bridge::VehicleCommands::default()
                }
            } else {
                let (forward_speed, up) = snapshot
                    .map(|snapshot| {
                        let (_, forward_speed, up) = vehicle_heading(snapshot);
                        (forward_speed, up)
                    })
                    .unwrap_or((0.0, 1.0));
                // R rights a car that is on its roof or stuck, once per press
                // and no more than once a second; a moving, upright car keeps
                // driving so a mis-press costs nothing.
                let reset_down = vehicle.latest_input.buttons & BTN_RELOAD != 0;
                let reset_edge = reset_down && !vehicle.reset_held;
                vehicle.reset_held = reset_down;
                if let Some(snapshot) = snapshot {
                    let stuck = up < 0.5 || forward_speed.abs() < 0.5;
                    if reset_edge && stuck && vehicle.reset_cooldown_ticks == 0 {
                        self.world
                            .reset_vehicle(entity, vehicle_reset_pose(snapshot))
                            .expect("PhysX vehicle reset failed");
                        vehicle.reset_cooldown_ticks = VEHICLE_RESET_COOLDOWN_TICKS;
                        vehicle.steer_command = 0.0;
                    }
                }
                let input = input_to_vehicle_cmd(&vehicle.latest_input);
                // Driver-assist input shaping, not a force/velocity clamp. Limit
                // the requested cornering acceleration before Vehicle2 solves slip.
                let lock_limit = vehicle.steering_geometry.map(|(wheelbase, lock, grip)| {
                    let lateral_accel = (0.65 * grip * 9.81).min(7.5);
                    (lateral_accel * wheelbase / forward_speed.powi(2).max(0.01)).atan() / lock
                }).unwrap_or(1.0).min(1.0);
                shape_tuned_vehicle_commands(&input, forward_speed, &mut vehicle.steer_command, dt, vehicle.steering_response, lock_limit)
            };
            self.world
                .drive_vehicle(entity, cmd)
                .expect("PhysX vehicle control failed");
        }
        self.last_vehicle_control_ms =
            vehicles_started.elapsed().as_secs_f32() * 1000.0;
    }

    /// First half of the split step: scene writes (vehicle drive), then
    /// dispatch the simulation without waiting on it. Pair with exactly one
    /// finish_dynamics(); between the two the scene is mid-simulate and NO
    /// PhysX call may be made — the window exists so the caller can run
    /// scene-free observer work (the deferred city encode/send bundle) inside
    /// the GPU wait instead of after it.
    pub fn begin_dynamics(&mut self) {
        // The city runs the split step, not step_vehicles_and_dynamics, so the
        // lost-context check has to sit on both paths or it sits on neither.
        #[cfg(feature = "native-destruction")]
        if self.world.gpu_context_lost() || pretend_context_lost() {
            exit_on_lost_context();
        }
        self.expire_launched_balls();
        self.clamp_launched_ball_travel(1.0 / f32::from(vibe_land_shared::constants::SIM_HZ));
        self.drive_vehicles();
        let started = std::time::Instant::now();
        self.world
            .begin_step()
            .expect("PhysX GPU simulation begin_step failed");
        self.pending_begin_ms = started.elapsed().as_secs_f32() * 1000.0;
    }

    /// Second half of the split step: wait/fetch, then the same readbacks and
    /// player refresh the combined path runs. Returns (vehicle_ms,
    /// dynamics_ms) shaped exactly like step_vehicles_and_dynamics — the
    /// dispatch cost from begin_dynamics is folded in, and time the caller
    /// spent between the halves is deliberately NOT (it belongs to whatever
    /// the caller overlapped, which reports itself).
    pub fn finish_dynamics(&mut self) -> (f32, f32) {
        let started = std::time::Instant::now();
        let completed = self.world.end_step();
        #[cfg(feature = "native-destruction")]
        if let Err(error) = &completed {
            if self.tolerate_rejected_steps {
                report_rejected_step(&self.world, "end_step", error);
                // Same rule as the unsplit path: no readbacks from a step that
                // did not complete.
                return (
                    self.last_vehicle_control_ms,
                    self.pending_begin_ms + started.elapsed().as_secs_f32() * 1000.0,
                );
            }
        }
        completed.expect("PhysX GPU simulation end_step failed");
        let after_step = std::time::Instant::now();
        self.post_step_readbacks(after_step);
        let ms =
            self.pending_begin_ms + started.elapsed().as_secs_f32() * 1000.0;
        self.pending_begin_ms = 0.0;
        (self.last_vehicle_control_ms, ms)
    }

    pub fn step_vehicles_and_dynamics(&mut self, _dt: f32) -> (f32, f32) {
        self.expire_launched_balls();
        self.clamp_launched_ball_travel(_dt.max(1.0 / f32::from(vibe_land_shared::constants::SIM_HZ)));
        self.drive_vehicles();
        let started = std::time::Instant::now();
        #[cfg(feature = "native-destruction")]
        if self.world.gpu_context_lost() || pretend_context_lost() {
            exit_on_lost_context();
        }
        if let Err(error) = self.world.step() {
            #[cfg(feature = "native-destruction")]
            if self.tolerate_rejected_steps {
                report_rejected_step(&self.world, "step", &error);
                // Nothing after this point may read the scene. A step that did
                // not complete has no results to read: draining contacts and
                // body poses from it is reading half-written state, and the
                // caches from the last accepted step are the only coherent
                // answer available. Returning here keeps them.
                return (
                    self.last_vehicle_control_ms,
                    started.elapsed().as_secs_f32() * 1000.0,
                );
            } else {
                panic!("PhysX GPU simulation step failed: {error}");
            }
            #[cfg(not(feature = "native-destruction"))]
            panic!("PhysX GPU simulation step failed: {error}");
        }
        // `dynamics_ms` used to be ONE bracket around the step and everything
        // below it, so three separate FFI readbacks and the player refresh were
        // folded into a number labelled as the simulation step. Only the step
        // is `physics_last_step_ms`; the difference was unattributed.
        let after_step = std::time::Instant::now();
        self.post_step_readbacks(after_step);
        let ms = started.elapsed().as_secs_f32() * 1000.0;
        // Returned as (vehicle_ms, dynamics_ms). The first was hardcoded 0.0
        // and published as `vehicle_ms`, so the panel showed a real-looking
        // zero for a cost nobody had measured. It is now the actual vehicle
        // control cost, measured above the step.
        (self.last_vehicle_control_ms, ms)
    }

    /// Everything the tick must read back once results are fetched — shared
    /// verbatim by the combined and split step paths so they cannot drift.
    /// Declare that the destruction backend in this scene can legitimately
    /// have a step refused. See `tolerate_rejected_steps`.
    pub fn set_tolerate_rejected_steps(&mut self, tolerate: bool) {
        self.tolerate_rejected_steps = tolerate;
    }

    fn post_step_readbacks(&mut self, after_step: std::time::Instant) {
        self.contact_events = self
            .world
            .take_contact_events()
            .expect("PhysX contact event readback failed");
        self.audio_contacts_ready = true;
        self.cached_body_snapshots = self
            .world
            .body_snapshots()
            .expect("PhysX body readback failed");
        self.cached_vehicle_snapshots = self
            .world
            .vehicle_snapshots()
            .expect("PhysX vehicle readback failed");
        let after_readback = std::time::Instant::now();
        self.last_readback_ms =
            after_readback.duration_since(after_step).as_secs_f32() * 1000.0;
        for body in &self.cached_body_snapshots {
            if body.entity_id & 0xf000_0000 != NS_BATTERY {
                continue;
            }
            if let Some(battery) = self.batteries.get_mut(&body.user_id) {
                battery.position = [
                    body.pose.position.x,
                    body.pose.position.y,
                    body.pose.position.z,
                ];
            }
        }
        self.snapshots_valid = true;
        self.watch_launched_balls_ground();
        let before_players = std::time::Instant::now();
        self.refresh_players();
        self.last_refresh_players_ms =
            before_players.elapsed().as_secs_f32() * 1000.0;
    }

    /// Reuse the existing contact readback. Audio never walks the scene or
    /// performs another GPU synchronization. The reducer bounds extraction.
    pub fn reduce_audio_contacts(&mut self, reducer: &mut crate::contact_audio::ContactAudioReducer, tick: u32) {
        if !std::mem::take(&mut self.audio_contacts_ready) { return; }
        reducer.ingest(tick, self.contact_events.iter().map(|event| crate::contact_audio::ContactSample {
            entity_a: event.entity_a,
            entity_b: event.entity_b,
            position: [event.point.x, event.point.y, event.point.z],
            normal: [event.normal.x, event.normal.y, event.normal.z],
            normal_speed: event.normal_speed,
            tangent_speed: event.tangent_speed,
            impulse: (event.impulse.x.powi(2) + event.impulse.y.powi(2) + event.impulse.z.powi(2)).sqrt(),
            effective_mass: event.effective_mass,
        }));
    }

    pub fn apply_vehicle_player_collisions(&mut self) -> Vec<u32> {
        const PLAYER_IMPACT_MASS_KG: f32 = 80.0;
        let minimum_impulse = VEHICLE_DAMAGE_MIN_SPEED_M_S * PLAYER_IMPACT_MASS_KG;
        let lethal_impulse = VEHICLE_LETHAL_SPEED_M_S * PLAYER_IMPACT_MASS_KG;
        let mut damage_by_player: HashMap<u32, u8> = HashMap::new();

        for event in &self.contact_events {
            let (vehicle_entity, player_entity) = if event.entity_a & 0xf000_0000 == NS_VEHICLE
                && event.entity_b & 0xf000_0000 == NS_PLAYER
            {
                (event.entity_a, event.entity_b)
            } else if event.entity_b & 0xf000_0000 == NS_VEHICLE
                && event.entity_a & 0xf000_0000 == NS_PLAYER
            {
                (event.entity_b, event.entity_a)
            } else {
                continue;
            };
            let vehicle_id = vehicle_entity & ID_MASK;
            let player_id = player_entity & ID_MASK;
            if self.vehicle_of_player.contains_key(&player_id)
                || self
                    .vehicles
                    .get(&vehicle_id)
                    .is_some_and(|vehicle| vehicle.driver_id == player_id)
                || self
                    .players
                    .get(&player_id)
                    .is_none_or(|player| player.dead || player.hp == 0)
            {
                continue;
            }
            let impulse = (event.impulse.x * event.impulse.x
                + event.impulse.y * event.impulse.y
                + event.impulse.z * event.impulse.z)
                .sqrt();
            if impulse < minimum_impulse {
                continue;
            }
            let damage = ((impulse / lethal_impulse).clamp(0.0, 1.0) * 100.0)
                .round()
                .clamp(1.0, 100.0) as u8;
            damage_by_player
                .entry(player_id)
                .and_modify(|existing| *existing = (*existing).max(damage))
                .or_insert(damage);
        }

        let mut killed = Vec::new();
        for (player_id, damage) in damage_by_player {
            if matches!(
                self.apply_player_damage(player_id, damage),
                PlayerDamageOutcome::Killed
            ) {
                killed.push(player_id);
            }
        }
        killed
    }

    pub fn snapshot_dynamic_bodies(
        &self,
    ) -> Vec<(u32, [f32; 3], [f32; 4], [f32; 3], [f32; 3], [f32; 3], u8)> {
        self.current_body_snapshots()
            .into_iter()
            .filter_map(|body| {
                // User ids are only unique WITHIN a namespace: a battery and a
                // dynamic body can both be number 5. Joining on the id alone
                // matched whichever the readback listed first, so a battery's
                // pose could be published under a dynamic body's id and that
                // body would appear frozen wherever the battery stands.
                if body.entity_id & NS_MASK != NS_DYNAMIC {
                    return None;
                }
                let id = body.user_id;
                let meta = self.dynamic.get(&id)?;
                Some((
                    id,
                    [
                        body.pose.position.x,
                        body.pose.position.y,
                        body.pose.position.z,
                    ],
                    [
                        body.pose.rotation.x,
                        body.pose.rotation.y,
                        body.pose.rotation.z,
                        body.pose.rotation.w,
                    ],
                    meta.half_extents,
                    [
                        body.linear_velocity.x,
                        body.linear_velocity.y,
                        body.linear_velocity.z,
                    ],
                    [
                        body.angular_velocity.x,
                        body.angular_velocity.y,
                        body.angular_velocity.z,
                    ],
                    meta.shape_type,
                ))
            })
            .collect()
    }

    pub fn vehicle_rig(&self, id:u32, neutral_jounce:f32) -> Option<[[f32;4];4]> {
        let snapshot = self.current_vehicle_snapshots().into_iter().find(|s|s.user_id == id)?;
        Some(std::array::from_fn(|i| [snapshot.wheel_jounce[i]-neutral_jounce,
            snapshot.wheel_steer[i], snapshot.wheel_rotation_angle[i],
            if snapshot.wheels_on_road & (1 << i) != 0 {1.0} else {0.0}]))
    }

    pub fn snapshot_vehicles(&self) -> Vec<NetVehicleState> {
        self.current_vehicle_snapshots()
            .into_iter()
            .filter_map(|snapshot| {
                let meta = self.vehicles.get(&snapshot.user_id)?;
                Some(make_net_vehicle_state(
                    snapshot.user_id,
                    meta.vehicle_type,
                    0,
                    meta.driver_id,
                    [
                        snapshot.pose.position.x,
                        snapshot.pose.position.y,
                        snapshot.pose.position.z,
                    ],
                    [
                        snapshot.pose.rotation.x,
                        snapshot.pose.rotation.y,
                        snapshot.pose.rotation.z,
                        snapshot.pose.rotation.w,
                    ],
                    [
                        snapshot.linear_velocity.x,
                        snapshot.linear_velocity.y,
                        snapshot.linear_velocity.z,
                    ],
                    [
                        snapshot.angular_velocity.x,
                        snapshot.angular_velocity.y,
                        snapshot.angular_velocity.z,
                    ],
                    physx_wheel_data(&snapshot),
                ))
            })
            .collect()
    }

    pub fn cast_static_world_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        _exclude_player: Option<u32>,
    ) -> Option<f32> {
        let hit = self
            .world
            .raycast(bridge::RaycastRequest {
                origin: array_vec3(origin),
                direction: array_vec3(direction),
                max_distance,
                collision_mask: GROUP_STATIC,
                ignore_entity_id: 0,
                has_ignore_entity: false,
            })
            .ok()?;
        hit.hit.then_some(hit.distance)
    }

    pub fn cast_dynamic_body_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
        _exclude_player: Option<u32>,
    ) -> Option<(u32, f32, [f32; 3])> {
        let hit = self
            .world
            .raycast(bridge::RaycastRequest {
                origin: array_vec3(origin),
                direction: array_vec3(direction),
                max_distance,
                collision_mask: GROUP_DYNAMIC,
                ignore_entity_id: 0,
                has_ignore_entity: false,
            })
            .ok()?;
        hit.hit.then_some((
            hit.user_id,
            hit.distance,
            [hit.normal.x, hit.normal.y, hit.normal.z],
        ))
    }

    pub fn apply_dynamic_body_impulse(
        &mut self,
        id: u32,
        impulse: [f32; 3],
        point: [f32; 3],
    ) -> bool {
        self.world
            .apply_impulse_at_point(
                NS_DYNAMIC | (id & ID_MASK),
                array_vec3(impulse),
                array_vec3(point),
            )
            .is_ok()
    }

    pub fn add_runtime_static_cuboid(
        &mut self,
        token: u64,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    ) {
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        let entity = NS_STATIC | (logical & ID_MASK);
        self.world
            .add_static_box(bridge::StaticBoxDesc {
                entity_id: entity,
                user_id: logical,
                pose: pose(center, [0.0, 0.0, 0.0, 1.0]),
                half_extents: vec3(half_extents),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX runtime static creation failed");
        self.runtime_static.insert(token, (entity, user_data));
    }

    pub fn remove_runtime_collider(&mut self, token: u64) {
        if let Some((entity, _)) = self.runtime_static.remove(&token) {
            let _ = self.world.remove_actor(entity);
        }
    }

    pub fn runtime_collider_user_data(&self, token: u64) -> Option<u128> {
        self.runtime_static
            .get(&token)
            .map(|(_, user_data)| *user_data)
    }

    pub fn wake_bodies_near(&mut self, center: Vector3<f32>, radius: f32) {
        self.world
            .wake_bodies_near(vec3(center), radius)
            .expect("PhysX wake query failed");
    }

    pub fn spawn_dynamic_ball(&mut self, position: Vector3<f32>, radius: f32) -> u32 {
        let id = self.next_dynamic_id;
        self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
        self.spawn_dynamic_ball_with_id(id, position, radius);
        id
    }

    /// Reserve the ids fired balls will use, and return them.
    ///
    /// Called once while the match is being built, so the ids can go into the
    /// dynamic-body metadata every client receives on join. See `ball_pool`.
    pub fn reserve_ball_pool(&mut self, count: usize) -> Vec<u32> {
        for _ in 0..count {
            let id = self.next_dynamic_id;
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
            self.ball_pool.push(id);
        }
        self.ball_pool.clone()
    }

    /// Reserve the ids meteors will use, and return them. See `meteor_pool`.
    pub fn reserve_meteor_pool(&mut self, count: usize) -> Vec<u32> {
        for _ in 0..count {
            let id = self.next_dynamic_id;
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
            self.meteor_pool.push(id);
        }
        self.meteor_pool.clone()
    }

    /// The first solid thing along a ray -- terrain, structure, chunk or loose
    /// body -- as a world point. Players are not solid here: a ray from a
    /// shooter's own eye must not stop on their own capsule.
    pub fn cast_solid_ray_point(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_distance: f32,
    ) -> Option<[f32; 3]> {
        let hit = self
            .world
            .raycast(bridge::RaycastRequest {
                origin: array_vec3(origin),
                direction: array_vec3(direction),
                max_distance,
                collision_mask: GROUP_STATIC | GROUP_DYNAMIC | GROUP_CHUNK,
                ignore_entity_id: 0,
                has_ignore_entity: false,
            })
            .ok()?;
        hit.hit
            .then_some([hit.position.x, hit.position.y, hit.position.z])
    }

    /// Drop a meteor into the scene at `position` with `velocity`, and return
    /// its id.
    ///
    /// The cannonball's mechanism -- a real body whose contacts the stage reads
    /// its loads from -- with two differences: the start is wherever the caller
    /// planned it, not the muzzle, and the velocity is given whole, because it
    /// was solved to pass through a point rather than pointed. See `meteor.rs`.
    pub fn launch_meteor(
        &mut self,
        position: Vector3<f32>,
        velocity: Vector3<f32>,
        radius: f32,
        mass: f32,
        ttl_ticks: u32,
    ) -> Option<u32> {
        if !(velocity.x.is_finite() && velocity.y.is_finite() && velocity.z.is_finite())
            || !(radius > 0.0)
            || !(mass > 0.0)
        {
            return None;
        }
        let id = self.take_pool_id(Pool::Meteor);
        self.launch_body(id, position, velocity, radius, mass, ttl_ticks)
    }

    /// Next id from a ring, retiring whatever still holds it. Without a
    /// reservation (tests, and any caller that has not asked for one) a fresh
    /// id is fine, because nothing is watching over a network.
    fn take_pool_id(&mut self, pool: Pool) -> u32 {
        let (ids, cursor) = match pool {
            Pool::Ball => (&self.ball_pool, &mut self.ball_cursor),
            Pool::Meteor => (&self.meteor_pool, &mut self.meteor_cursor),
        };
        if ids.is_empty() {
            let fresh = self.next_dynamic_id;
            self.next_dynamic_id = self.next_dynamic_id.saturating_add(1);
            return fresh;
        }
        let slot = *cursor % ids.len();
        *cursor = slot.wrapping_add(1);
        let reserved = ids[slot];
        if self.dynamic.contains_key(&reserved) {
            self.retire_launched_ball(reserved);
            self.launched_balls.retain(|ball| ball.id != reserved);
        }
        reserved
    }

    /// The part of a launch that does not care what is being launched.
    fn launch_body(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        velocity: Vector3<f32>,
        radius: f32,
        mass: f32,
        ttl_ticks: u32,
    ) -> Option<u32> {
        let entity = NS_DYNAMIC | (id & ID_MASK);
        if let Err(error) = self.world.launch_dynamic_ball(bridge::LaunchedBallDesc {
            entity_id: entity,
            user_id: id,
            pose: pose(position, [0.0, 0.0, 0.0, 1.0]),
            radius,
            mass,
            linear_velocity: vec3(velocity),
            collision_group: GROUP_DYNAMIC,
            collision_mask: ALL_GROUPS,
        }) {
            tracing::warn!(%error, "ball could not be launched");
            return None;
        }
        self.snapshots_valid = false;
        // A pool id names a new ball now; its ground record starts clean.
        self.ball_ground.forget(entity);
        self.ball_ground_previous.remove(&id);
        self.dynamic.insert(
            id,
            DynamicMeta {
                half_extents: [radius; 3],
                shape_type: SHAPE_SPHERE,
            },
        );
        self.launched_balls.push_back(LaunchedBall {
            id,
            expires_at: self.launch_tick + u64::from(ttl_ticks.max(1)),
        });
        // Bounded, and the bound is enforced by retiring the oldest rather than
        // refusing the newest: a player holding the trigger should keep seeing
        // their shots, and the scene should not grow without limit.
        while self.launched_balls.len() > MAX_LIVE_LAUNCHED_BALLS {
            if let Some(oldest) = self.launched_balls.pop_front() {
                self.retire_launched_ball(oldest.id);
            }
        }
        Some(id)
    }

    pub fn launch_ball_from_muzzle(&mut self, position: Vector3<f32>, velocity: Vector3<f32>, radius:f32, mass:f32, ttl_ticks:u32) -> Option<u32> {
        if !position.iter().chain(velocity.iter()).all(|x|x.is_finite()) || !radius.is_finite() || radius<=0.0 || !mass.is_finite() || mass<=0.0 || ttl_ticks==0 {return None;}
        let id=self.take_pool_id(Pool::Ball);
        self.ball_radius_m=radius;
        self.launch_body(id,position,velocity,radius,mass,ttl_ticks)
    }

    /// Throw a visible ball from `position` along `direction` and return its id.
    ///
    /// This is the shot the engine's own destruction demos fire. It matters
    /// that it is a real body and not an effect: the native stage reads loads
    /// from contacts PhysX solved, so the ball the player watches fly is the
    /// same object that breaks the bonds when it lands. Returns None rather
    /// than panicking on a malformed shot, because the caller is a network
    /// packet.
    pub fn launch_ball(
        &mut self,
        position: Vector3<f32>,
        direction: Vector3<f32>,
        radius: f32,
        mass: f32,
        speed: f32,
        ttl_ticks: u32,
    ) -> Option<u32> {
        let length =
            (direction.x * direction.x + direction.y * direction.y + direction.z * direction.z)
                .sqrt();
        if !length.is_finite()
            || length <= 0.0
            || !(radius > 0.0)
            || !(mass > 0.0)
            || !(speed > 0.0)
        {
            return None;
        }
        let unit = direction / length;
        // Clear of the shooter. A ball spawned inside the player's own capsule
        // resolves by launching the player instead of the ball.
        let muzzle = position + unit * (radius + MUZZLE_CLEARANCE_M);
        let id = self.take_pool_id(Pool::Ball);
        self.ball_radius_m = radius;
        self.launch_body(id, muzzle, unit * speed, radius, mass, ttl_ticks)
    }

    /// How many times a ball has been held at a surface it would have skipped.
    pub fn balls_clamped(&self) -> u64 {
        self.balls_clamped
    }

    /// How many fired balls are currently in the scene.
    pub fn launched_ball_count(&self) -> usize {
        self.launched_balls.len()
    }

    /// Stop a fired ball at the first surface on its path this tick.
    ///
    /// The stage forbids scene CCD, so nothing sweeps a projectile between
    /// steps: a 0.3 m ball at 60 m/s covers a full metre per tick against its
    /// own 0.6 m diameter, and any wall thinner than the difference falls
    /// between two positions and never generates a contact.
    ///
    /// Speculative contacts are the obvious answer and are worse. They do hold
    /// the wall, but a speculative contact does not deliver the impulse the
    /// destruction stage reads its loads from, so the shot that broke 51 bonds
    /// broke none. Measured both ways.
    ///
    /// This instead casts the ball's own path each tick and, when something is
    /// closer than the ball will travel, places it just short of that surface
    /// with its velocity untouched. The next step then resolves an ordinary
    /// contact, at full speed, and the impulse arrives intact.
    fn clamp_launched_ball_travel(&mut self, dt: f32) {
        // Off by default: it fires and it does not work. At 140 m/s it held the
        // ball at the surface twice and the ball still finished 96.7 m past the
        // wall having broken nothing. Placing a ten-tonne body against a wall
        // does not stop it crossing 2.3 m in the next step. Kept behind
        // VIBE_CITY_BALL_SWEEP=1 so the result is reproducible.
        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if !*ENABLED.get_or_init(|| std::env::var("VIBE_CITY_BALL_SWEEP").is_ok_and(|v| v == "1")) {
            return;
        }
        if self.launched_balls.is_empty() || !(dt > 0.0) {
            return;
        }
        let radius = self.ball_radius_m;
        let snapshots = self.current_body_snapshots();
        let mut moves: Vec<(u32, Vector3<f32>)> = Vec::new();
        for ball in &self.launched_balls {
            let entity = NS_DYNAMIC | (ball.id & ID_MASK);
            let Some(body) = snapshots.iter().find(|b| b.entity_id == entity) else {
                continue;
            };
            let velocity = body.linear_velocity;
            let speed = (velocity.x * velocity.x
                + velocity.y * velocity.y
                + velocity.z * velocity.z)
                .sqrt();
            let travel = speed * dt;
            // Only a ball that outruns its own diameter can skip a wall.
            if !(travel > radius * 2.0) {
                continue;
            }
            let origin = body.pose.position;
            let direction = bridge::Vec3::new(
                velocity.x / speed,
                velocity.y / speed,
                velocity.z / speed,
            );
            let hit = self.world.raycast(bridge::RaycastRequest {
                origin,
                direction,
                max_distance: travel + radius,
                collision_mask: ALL_GROUPS,
                ignore_entity_id: entity,
                has_ignore_entity: true,
            });
            let Ok(hit) = hit else { continue };
            if !hit.hit || hit.distance <= radius {
                continue;
            }
            // Just short of the surface, so the contact happens next step.
            let stop = hit.distance - radius;
            if stop >= travel {
                continue;
            }
            moves.push((
                entity,
                Vector3::new(
                    origin.x + direction.x * stop,
                    origin.y + direction.y * stop,
                    origin.z + direction.z * stop,
                ),
            ));
        }
        for (entity, position) in moves {
            if let Err(error) = self
                .world
                .set_body_pose(entity, pose(position, [0.0, 0.0, 0.0, 1.0]))
            {
                tracing::warn!(%error, "could not hold a ball at the surface it was about to skip");
            } else {
                self.balls_clamped = self.balls_clamped.saturating_add(1);
                self.snapshots_valid = false;
            }
        }
    }

    /// Remove fired balls whose lifetime has run out.
    ///
    /// Called before a step rather than after one, so a retired ball is gone
    /// from both the scene and the wire in the same tick. Doing it after the
    /// step would publish one more frame of a body that no longer exists.
    /// Forensics for fired balls and meteors: where each one is and how fast,
    /// at 10 Hz under `VIBE_CITY_BALL_TRACE=1`, and always a warning when one
    /// jumps past 300 m/s or 1.5 km out. The chunk-side detectors in
    /// native_runtime.rs only watch fragment bodies; a projectile that comes
    /// to grief is invisible to them, and a 2 m meteor took the GPU context
    /// with it several times before anything reported where the rock was.
    fn trace_launched_balls(&mut self) {
        if self.launched_balls.is_empty() {
            return;
        }
        static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let verbose =
            *ENABLED.get_or_init(|| std::env::var("VIBE_CITY_BALL_TRACE").is_ok_and(|v| v == "1"));
        let snapshots = self.current_body_snapshots();
        for ball in &self.launched_balls {
            let entity = NS_DYNAMIC | (ball.id & ID_MASK);
            let Some(body) = snapshots.iter().find(|b| b.entity_id == entity) else {
                continue;
            };
            let p = body.pose.position;
            let v = body.linear_velocity;
            let speed = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
            let radius = (p.x * p.x + p.y * p.y + p.z * p.z).sqrt();
            if speed > 300.0 || radius > 1500.0 || !speed.is_finite() {
                tracing::warn!(
                    id = ball.id,
                    tick = self.launch_tick,
                    pos = ?[p.x, p.y, p.z],
                    speed,
                    "fired ball velocity explosion or escape"
                );
            } else if verbose && self.launch_tick % 6 == 0 {
                tracing::info!(
                    id = ball.id,
                    tick = self.launch_tick,
                    pos = ?[p.x, p.y, p.z],
                    speed,
                    sleeping = body.sleeping,
                    "ball trace"
                );
            }
        }
    }

    /// Top of the lowest static surface in the world, if there is any.
    pub fn lowest_ground_y(&self) -> Option<f32> {
        self.lowest_ground_y
    }

    /// Below this a fired ball is retired: a few metres under the lowest
    /// ground (`VIBE_RETIRE_FLOOR_DEPTH_M`, default 5). Negative infinity in a
    /// world with no static geometry.
    pub fn retire_floor_y(&self) -> f32 {
        self.ball_ground.floor_y()
    }

    /// Fired balls and meteors retired at the floor, cumulative.
    pub fn balls_retired_below_floor(&self) -> u64 {
        self.ball_ground.retired_total
    }

    /// Distinct fired balls and meteors seen through the ground, cumulative.
    pub fn balls_below_ground(&self) -> u64 {
        self.ball_ground.below_ground_total
    }

    fn note_ground_surface(&mut self, top_y: f32) {
        if !top_y.is_finite() {
            return;
        }
        let lowest = self.lowest_ground_y.map_or(top_y, |y| y.min(top_y));
        self.lowest_ground_y = Some(lowest);
        self.ball_ground
            .set_ground(Some(lowest), vibe_land_destruction::ground_watch::retire_depth_m());
    }

    /// Fired balls and meteors that went through the ground this step.
    ///
    /// The first tick one is through is logged with what tells the causes
    /// apart: its velocity and the tick before's, whether it reported a contact
    /// with static geometry on either tick, and the native stage's account of
    /// the step (a corrected re-solve is the measured trigger on Metal; see
    /// docs/mac-metal-session-analysis-2026-09-24.md, item 5). One that
    /// crosses the retire floor is retired through the same path as a ball
    /// whose lifetime ran out: removed from the scene and from the snapshot,
    /// which is how every client learns a ball is gone.
    fn watch_launched_balls_ground(&mut self) {
        use vibe_land_destruction::ground_watch::GroundVerdict;
        if self.launched_balls.is_empty() {
            self.ball_ground_previous.clear();
            return;
        }
        let mut retire: Vec<u32> = Vec::new();
        let mut seen: Vec<u32> = Vec::with_capacity(self.launched_balls.len());
        for ball in &self.launched_balls {
            let entity = NS_DYNAMIC | (ball.id & ID_MASK);
            let Some(body) = self.cached_body_snapshots.iter().find(|b| b.entity_id == entity) else {
                continue;
            };
            seen.push(ball.id);
            let p = body.pose.position;
            let v = body.linear_velocity;
            let touching_static = self.contact_events.iter().any(|event| {
                (event.entity_a == entity && event.entity_b & 0xf000_0000 == NS_STATIC)
                    || (event.entity_b == entity && event.entity_a & 0xf000_0000 == NS_STATIC)
            });
            let previous = self.ball_ground_previous.get(&ball.id).copied();
            match self.ball_ground.observe(entity, p.y) {
                GroundVerdict::Above | GroundVerdict::BelowGround { first: false } => {}
                GroundVerdict::BelowGround { first: true } => {
                    if self.ball_ground_logged < 32 {
                        self.ball_ground_logged += 1;
                        let radius = self.dynamic.get(&ball.id).map_or(0.0, |m| m.half_extents[0]);
                        let (from, from_velocity, was_touching) = previous
                            .map(|(pp, pv, t)| (format!("{pp:.2?}"), format!("{pv:.2?}"), t.to_string()))
                            .unwrap_or_else(|| ("unseen".into(), "unseen".into(), "unknown".into()));
                        tracing::warn!(
                            id = ball.id,
                            tick = self.launch_tick,
                            radius,
                            sleeping = body.sleeping,
                            pos = ?[p.x, p.y, p.z],
                            vel = ?[v.x, v.y, v.z],
                            prev_pos = %from,
                            prev_vel = %from_velocity,
                            static_contact_now = touching_static,
                            static_contact_before = %was_touching,
                            stage = %stage_status_summary(&self.world),
                            "fired ball went through the ground"
                        );
                    }
                }
                GroundVerdict::Retire => {
                    if self.ball_ground_logged < 64 {
                        self.ball_ground_logged += 1;
                        tracing::warn!(
                            id = ball.id,
                            tick = self.launch_tick,
                            floor = self.ball_ground.floor_y(),
                            pos = ?[p.x, p.y, p.z],
                            vel = ?[v.x, v.y, v.z],
                            "fired ball retired at the floor under the ground"
                        );
                    }
                    retire.push(ball.id);
                }
            }
            self.ball_ground_previous
                .insert(ball.id, ([p.x, p.y, p.z], [v.x, v.y, v.z], touching_static));
        }
        self.ball_ground_previous.retain(|id, _| seen.contains(id));
        for id in retire {
            self.launched_balls.retain(|ball| ball.id != id);
            self.ball_ground_previous.remove(&id);
            self.retire_launched_ball(id);
        }
    }

    fn expire_launched_balls(&mut self) {
        self.launch_tick = self.launch_tick.saturating_add(1);
        self.trace_launched_balls();
        while self
            .launched_balls
            .front()
            .is_some_and(|ball| ball.expires_at <= self.launch_tick)
        {
            let ball = self.launched_balls.pop_front().expect("checked above");
            self.retire_launched_ball(ball.id);
        }
    }

    fn retire_launched_ball(&mut self, id: u32) {
        // Dropped from the metadata map first: `snapshot_dynamic_bodies` joins
        // on it, so the ball stops being published even if the actor removal
        // is refused for a reason we have not thought of.
        self.dynamic.remove(&id);
        if let Err(error) = self.world.remove_actor(NS_DYNAMIC | (id & ID_MASK)) {
            tracing::warn!(%error, id, "fired ball could not be removed");
        }
        self.snapshots_valid = false;
    }

    pub fn spawn_battery(&mut self, position: Vec3d, energy: f32, radius: f32, height: f32) -> u32 {
        let id = self.next_battery_id;
        self.next_battery_id = self.next_battery_id.saturating_add(1);
        self.spawn_battery_with_id(
            id,
            Vector3::new(position.x as f32, position.y as f32, position.z as f32),
            energy,
            radius,
            height,
        );
        id
    }

    pub fn collect_batteries_for_player(&mut self, player_id: u32) -> Vec<(u32, f32)> {
        let Some(player) = self.players.get(&player_id) else {
            return Vec::new();
        };
        let collected: Vec<u32> = self
            .batteries
            .iter()
            .filter_map(|(&id, battery)| {
                let dx = battery.position[0] - player.position.x as f32;
                let dy = battery.position[1] - player.position.y as f32;
                let dz = battery.position[2] - player.position.z as f32;
                (dx * dx + dy * dy + dz * dz <= 1.5 * 1.5).then_some(id)
            })
            .collect();
        collected
            .into_iter()
            .filter_map(|id| {
                let battery = self.batteries.remove(&id)?;
                let _ = self.world.remove_actor(NS_BATTERY | (id & ID_MASK));
                Some((id, battery.energy))
            })
            .collect()
    }

    pub fn snapshot_batteries(&self) -> Vec<(u32, [f32; 3], f32, f32, f32)> {
        self.batteries
            .iter()
            .map(|(&id, battery)| {
                (
                    id,
                    battery.position,
                    battery.energy,
                    battery.radius,
                    battery.height,
                )
            })
            .collect()
    }

    pub fn apply_on_foot_energy_drain(
        &mut self,
        id: u32,
        previous_input: &InputCmd,
        input: &InputCmd,
        was_on_ground: bool,
        dt: f32,
    ) -> bool {
        let Some(state) = self.players.get_mut(&id) else {
            return false;
        };
        if state.dead || self.vehicle_of_player.contains_key(&id) {
            return false;
        }
        let moving = input.move_x != 0 || input.move_y != 0;
        let rate = if moving && input.buttons & BTN_SPRINT != 0 {
            ON_FOOT_SPRINT_DRAIN_PER_SEC
        } else if moving {
            ON_FOOT_WALK_DRAIN_PER_SEC
        } else {
            ON_FOOT_IDLE_DRAIN_PER_SEC
        };
        let jump_started = was_on_ground
            && input.buttons & BTN_JUMP != 0
            && previous_input.buttons & BTN_JUMP == 0;
        state.energy =
            (state.energy - rate * dt - if jump_started { JUMP_ENERGY_COST } else { 0.0 }).max(0.0);
        state.energy <= 0.0
    }

    pub fn apply_vehicle_energy_drain(&mut self, dt: f32) -> Vec<u32> {
        let mut depleted = Vec::new();
        for &player_id in self.vehicle_of_player.keys() {
            if let Some(player) = self.players.get_mut(&player_id) {
                player.energy = (player.energy - ON_FOOT_IDLE_DRAIN_PER_SEC * dt).max(0.0);
                if player.energy <= 0.0 {
                    depleted.push(player_id);
                }
            }
        }
        depleted
    }

    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.dynamic.len(),
            self.vehicles.len(),
            self.batteries.len(),
        )
    }

    /// Generic named spans stashed by the most recent stats read inside
    /// [`Self::health`]; call AFTER health() for spans of the same read.
    pub fn take_physics_spans(&self) -> Vec<vibe_land_physx_bridge::NamedSpan> {
        self.world.take_world_spans()
    }

    /// The last step's phases from the bridge plus this arena's own
    /// post-step brackets. None if the bridge cannot answer.
    pub fn step_phases(&self) -> Option<crate::movement::StepPhases> {
        let step = self.world.step_phases().ok()?;
        Some(crate::movement::StepPhases {
            controller_ms: step.controller_ms,
            submit_ms: step.simulate_ms,
            fetch_ms: step.fetch_ms,
            callbacks_ms: step.callbacks_ms,
            gpu_wait_ms: step.gpu_wait_sampled.then_some(step.gpu_wait_ms),
            readback_ms: self.last_readback_ms,
            players_ms: self.last_refresh_players_ms,
            awake_bodies: step.active_dynamic_bodies,
            found_pairs: step.bp_new_pairs,
            lost_pairs: step.bp_lost_pairs,
        })
    }

    pub fn health(&self) -> PhysicsHealth {
        let stats = self.world.stats().expect("PhysX stats readback failed");
        PhysicsHealth {
            gpu_active: true,
            gpu_warning_count: stats.gpu_warning_count,
            contact_pairs: stats.contact_pairs,
            active_dynamic_bodies: stats.active_dynamic_bodies,
            last_step_ms: stats.last_step_ms,
            last_controller_ms: stats.last_controller_ms,
            last_simulate_ms: stats.last_simulate_ms,
            last_fetch_ms: stats.last_fetch_ms,
            last_gpu_wait_ms: stats.last_gpu_wait_ms,
            last_fetch_copy_ms: stats.last_fetch_copy_ms,
            last_readback_ms: self.last_readback_ms,
            last_refresh_players_ms: self.last_refresh_players_ms,
            last_vehicle_control_ms: self.last_vehicle_control_ms,
            // Computed in C++ and carried all the way to WorldStats, then
            // dropped here: health() copied 9 of 16 fields. These two are the
            // only warning that a GPU buffer is about to overrun, which is the
            // failure mode a no-caps simulation actually has.
            gpu_rigid_contact_high_water: stats.gpu_rigid_contact_high_water,
            gpu_rigid_patch_high_water: stats.gpu_rigid_patch_high_water,
            gpu_max_rigid_contacts: self.gpu_max_rigid_contacts,
            gpu_max_rigid_patches: self.gpu_max_rigid_patches,
        }
    }

    pub fn awake_dynamic_body_counts(
        &self,
        player_centers: &[[f32; 3]],
        near_radius: f32,
    ) -> (u32, u32) {
        let near_radius_sq = near_radius * near_radius;
        let snapshots = self.current_body_snapshots();
        let mut total = 0;
        let mut near = 0;
        for body in snapshots {
            if body.sleeping || !self.dynamic.contains_key(&body.user_id) {
                continue;
            }
            total += 1;
            if player_centers.iter().any(|center| {
                let dx = body.pose.position.x - center[0];
                let dy = body.pose.position.y - center[1];
                let dz = body.pose.position.z - center[2];
                dx * dx + dy * dy + dz * dz <= near_radius_sq
            }) {
                near += 1;
            }
        }
        (total, near)
    }
}

impl WorldDocumentArena for PhysxPhysicsArena {
    fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        _user_data: u128,
        material: EffectiveTerrainMaterial,
    ) {
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        let world_rows = heights.nrows();
        let world_columns = heights.ncols();
        assert!(
            world_rows >= 2 && world_columns >= 2,
            "PhysX heightfields require at least 2x2 samples"
        );
        // World documents store row-major samples as [z][x]. PhysX heightfields
        // index rows on +X and columns on +Z, and their actor pose is the minimum
        // X/Z corner rather than the center used by the shared world contract.
        let mut physx_samples = Vec::with_capacity(world_rows * world_columns);
        for x in 0..world_columns {
            for z in 0..world_rows {
                physx_samples.push(heights[(z, x)]);
            }
        }
        let lowest_sample = heights.iter().copied().fold(f32::INFINITY, f32::min);
        self.note_ground_surface(center.y + lowest_sample);
        let corner = Vector3::new(center.x - scale.x * 0.5, center.y, center.z - scale.z * 0.5);
        self.world
            .add_heightfield(
                bridge::HeightfieldDesc {
                    entity_id: NS_STATIC | (logical & ID_MASK),
                    user_id: logical,
                    pose: pose(corner, [0.0, 0.0, 0.0, 1.0]),
                    rows: world_columns as u32,
                    columns: world_rows as u32,
                    height_scale: 0.01,
                    row_scale: scale.x / (world_columns - 1) as f32,
                    column_scale: scale.z / (world_rows - 1) as f32,
                    friction: material.friction,
                    restitution: material.restitution,
                    collision_group: GROUP_STATIC,
                    collision_mask: ALL_GROUPS,
                },
                &physx_samples,
            )
            .expect("PhysX heightfield creation failed");
    }

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
        _user_data: u128,
    ) {
        self.note_ground_surface(center.y + box_top_extent(rotation, half_extents));
        let logical = self.next_static_id;
        self.next_static_id = self.next_static_id.saturating_add(1);
        self.world
            .add_static_box(bridge::StaticBoxDesc {
                entity_id: NS_STATIC | (logical & ID_MASK),
                user_id: logical,
                pose: pose(center, rotation),
                half_extents: vec3(half_extents),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX static box creation failed");
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    ) {
        self.next_dynamic_id = self.next_dynamic_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_box(bridge::DynamicBoxDesc {
                entity_id: NS_DYNAMIC | (id & ID_MASK),
                user_id: id,
                pose: pose(position, rotation),
                half_extents: vec3(half_extents),
                mass: (half_extents.x * half_extents.y * half_extents.z * 8.0).max(1.0),
                collision_group: GROUP_DYNAMIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX dynamic box creation failed");
        self.snapshots_valid = false;
        self.dynamic.insert(
            id,
            DynamicMeta {
                half_extents: half_extents.into(),
                shape_type: SHAPE_BOX,
            },
        );
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        self.next_dynamic_id = self.next_dynamic_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_sphere(bridge::DynamicSphereDesc {
                entity_id: NS_DYNAMIC | (id & ID_MASK),
                user_id: id,
                pose: pose(position, [0.0, 0.0, 0.0, 1.0]),
                radius,
                mass: (4.0 / 3.0 * std::f32::consts::PI * radius.powi(3)).max(0.1),
                collision_group: GROUP_DYNAMIC,
                collision_mask: ALL_GROUPS,
            })
            .expect("PhysX dynamic sphere creation failed");
        self.snapshots_valid = false;
        self.dynamic.insert(
            id,
            DynamicMeta {
                half_extents: [radius; 3],
                shape_type: SHAPE_SPHERE,
            },
        );
    }

    fn spawn_vehicle_with_id(&mut self, id:u32, vehicle_type:u8, position:Vector3<f32>, rotation:[f32;4]) {
        self.spawn_vehicle_asset(id, vehicle_type, position, rotation, None).expect("PhysX vehicle creation failed");
    }

    fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        self.next_battery_id = self.next_battery_id.max(id.saturating_add(1));
        self.world
            .add_dynamic_sphere(bridge::DynamicSphereDesc {
                entity_id: NS_BATTERY | (id & ID_MASK),
                user_id: id,
                pose: pose(position, [0.0, 0.0, 0.0, 1.0]),
                radius: radius.max(height * 0.5),
                mass: 0.25,
                collision_group: GROUP_BATTERY,
                collision_mask: GROUP_STATIC,
            })
            .expect("PhysX battery creation failed");
        self.snapshots_valid = false;
        self.batteries.insert(
            id,
            BatteryState {
                position: position.into(),
                energy,
                radius,
                height,
            },
        );
    }

    fn rebuild_broad_phase(&mut self) {}

    fn set_material_field(&mut self, field: Option<TerrainMaterialField>) {
        self.material_field = field;
    }
}

fn vec3(value: Vector3<f32>) -> bridge::Vec3 {
    bridge::Vec3::new(value.x, value.y, value.z)
}

fn pose(position: Vector3<f32>, rotation: [f32; 4]) -> bridge::Pose {
    bridge::Pose {
        position: vec3(position),
        rotation: bridge::Quat {
            x: rotation[0],
            y: rotation[1],
            z: rotation[2],
            w: rotation[3],
        },
    }
}

fn array_vec3(value: [f32; 3]) -> bridge::Vec3 {
    bridge::Vec3::new(value[0], value[1], value[2])
}

fn env_u32(name: &str, default: u32) -> Result<u32> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .with_context(|| format!("{name} must be an unsigned integer")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("failed to read {name}")),
    }
}

/// Half the vertical extent of a box with these half extents, rotated by the
/// quaternion `[x, y, z, w]`: how far its top face (or highest corner) rises
/// above its centre.
fn box_top_extent(rotation: [f32; 4], half_extents: Vector3<f32>) -> f32 {
    let [x, y, z, w] = rotation;
    let norm = (x * x + y * y + z * z + w * w).sqrt();
    if !(norm > 0.0) {
        return half_extents.y;
    }
    let (x, y, z, w) = (x / norm, y / norm, z / norm, w / norm);
    // Second row of the rotation matrix: the world-y component of each local
    // axis.
    let r10 = 2.0 * (x * y + w * z);
    let r11 = 1.0 - 2.0 * (x * x + z * z);
    let r12 = 2.0 * (y * z - w * x);
    r10.abs() * half_extents.x + r11.abs() * half_extents.y + r12.abs() * half_extents.z
}

/// The native stage's account of the last step, for forensics lines.
#[cfg(feature = "native-destruction")]
fn stage_status_summary(world: &bridge::World) -> String {
    match world.native_last_status() {
        Ok(status) if status.frame != 0 => format!(
            "frame {} corrected_passes {} broken_bonds {} error {}",
            status.frame, status.correction_passes, status.broken_bonds, status.error
        ),
        Ok(_) => "no native stage".to_string(),
        Err(error) => format!("unreadable ({error})"),
    }
}

#[cfg(not(feature = "native-destruction"))]
fn stage_status_summary(_world: &bridge::World) -> String {
    "no native stage".to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use super::*;

    pub(super) fn gpu_test_guard() -> MutexGuard<'static, ()> {
        static GPU_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        GPU_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn gpu_world_drives_authoritative_player_and_body_state() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::add_static_cuboid(
            &mut arena,
            Vector3::new(0.0, -0.5, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(20.0, 0.5, 20.0),
            1,
        );
        WorldDocumentArena::spawn_dynamic_ball_with_id(
            &mut arena,
            7,
            Vector3::new(0.0, 4.0, 0.0),
            0.5,
        );
        arena.spawn_player(42);

        for seq in 0..120 {
            let input = InputCmd {
                seq,
                move_y: 127,
                ..InputCmd::default()
            };
            arena.simulate_player_tick(42, &input, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let player = arena.snapshot_player(42).unwrap();
        assert!(player.0[1] > 0.4);
        assert!(player.0[2] > 1.0);
        assert_eq!(arena.snapshot_dynamic_bodies()[0].0, 7);
        assert!(arena.world.stats().unwrap().completed_steps >= 120);
    }

    #[test]
    fn heightfield_adapter_preserves_world_xz_layout_and_spacing() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        let heights = DMatrix::from_row_slice(
            3,
            4,
            &[
                0.0, 1.0, 2.0, 3.0, //
                10.0, 11.0, 12.0, 13.0, //
                20.0, 21.0, 22.0, 23.0,
            ],
        );
        WorldDocumentArena::add_static_heightfield(
            &mut arena,
            Vector3::new(10.0, 0.0, 20.0),
            heights,
            Vector3::new(6.0, 1.0, 4.0),
            1,
            EffectiveTerrainMaterial::DEFAULT,
        );

        let hit_at_11 = arena
            .cast_static_world_ray([9.0, 100.0, 20.0], [0.0, -1.0, 0.0], 200.0, None)
            .expect("first asymmetric terrain sample should be raycastable");
        let hit_at_12 = arena
            .cast_static_world_ray([11.0, 100.0, 20.0], [0.0, -1.0, 0.0], 200.0, None)
            .expect("second asymmetric terrain sample should be raycastable");

        assert!((100.0 - hit_at_11 - 11.0).abs() < 0.02);
        assert!((100.0 - hit_at_12 - 12.0).abs() < 0.02);
    }

    /// Export an authoritative Vehicle2 trace for the browser proxy regression.
    #[test]
    #[ignore = "requires local GPU and VIBE_VEHICLE_NET_TRACE output path"]
    fn export_vehicle_netcode_trace() {
        let _guard=gpu_test_guard();
        let path=std::env::var("VIBE_VEHICLE_NET_TRACE").unwrap();
        let world=crate::demo_world::garage_test_world();
        let mut arena=PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        world.instantiate(&mut arena).unwrap();
        WorldDocumentArena::spawn_vehicle_with_id(&mut arena,7,0,Vector3::new(0.0,1.0,3.0),[0.0,0.0,0.0,1.0]);
        arena.set_spawn_areas(world.spawn_areas.clone());arena.spawn_player(10);arena.enter_vehicle(10,7);
        assert_eq!(arena.player_vehicle_id(10),Some(7));
        arena.world.reset_vehicle(NS_VEHICLE|7,pose(Vector3::new(0.0,4.0,3.0),[0.0,0.0,0.0,1.0])).unwrap();
        let mut frames=Vec::new();
        for tick in 0..720u32 {
            let mut input=InputCmd::default();
            input.move_y=if tick<100 {0} else if tick<550 {90} else {-127};
            if (360..440).contains(&tick) {input.move_x=25;}
            arena.simulate_player_tick(10,&input,1.0/60.0);
            arena.step_vehicles_and_dynamics(1.0/60.0);
            let car=arena.current_vehicle_snapshots()[0];
            let p=car.pose.position;let q=car.pose.rotation;let v=car.linear_velocity;let w=car.angular_velocity;
            frames.push(serde_json::json!({"input":{"seq":tick+1,"clientTick":tick,"moveX":input.move_x,"moveY":input.move_y,"buttons":input.buttons,"yaw":0,"pitch":0},
                "sample":{"serverTimeUs":(tick+1) as f64*1e6/60.0,"position":[p.x,p.y,p.z],"quaternion":[q.x,q.y,q.z,q.w],
                "linearVelocity":[v.x,v.y,v.z],"angularVelocity":[w.x,w.y,w.z],"wheelData":[0,0,0,0],"driverPlayerId":10,"flags":0}}));
        }
        std::fs::write(path,serde_json::to_vec(&serde_json::json!({"world":world,"frames":frames})).unwrap()).unwrap();
    }

    #[test]
    fn garage_heightmap_supports_vehicle2_and_changes_suspension_travel() {
        let _guard = gpu_test_guard();
        let world = crate::demo_world::garage_test_world();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        world.instantiate(&mut arena).unwrap();
        for (x, z) in [(0.3, 40.7), (2.7, 44.1), (45.3, 45.7), (-80.4, -72.2)] {
            let distance = arena.cast_static_world_ray([x, 20.0, z], [0.0, -1.0, 0.0], 30.0, None).unwrap();
            let expected = world.sample_heightfield_surface_at_world_position(x, z);
            assert!((20.0 - distance - expected).abs() < 0.02, "PhysX terrain mismatch at {x},{z}");
        }
        WorldDocumentArena::spawn_vehicle_with_id(&mut arena, 7, 0,
            Vector3::new(0.0, 1.0, 3.0), [0.0, 0.0, 0.0, 1.0]);
        arena.set_spawn_areas(world.spawn_areas.clone());
        arena.spawn_player(10);
        arena.enter_vehicle(10, 7);
        assert_eq!(arena.player_vehicle_id(10), Some(7));
        let mut min_jounce = f32::INFINITY;
        let mut max_jounce = f32::NEG_INFINITY;
        let mut reached_lane = false;
        for tick in 0..900 {
            let snapshot = arena.snapshot_vehicles()[0];
            let z = snapshot.pz_mm as f32 * 0.001;
            let mut input = InputCmd::default();
            input.move_y = if tick < 120 { 0 } else if z < 70.0 { 90 } else { -127 };
            arena.simulate_player_tick(10, &input, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
            let snapshot = arena.current_vehicle_snapshots()[0];
            let p = snapshot.pose.position;
            assert!(p.x.is_finite() && p.y.is_finite() && p.z.is_finite());
            assert!(p.y > world.sample_heightfield_surface_at_world_position(p.x, p.z) - 0.5,
                "vehicle went below terrain at {},{},{}", p.x, p.y, p.z);
            if (32.0..64.0).contains(&p.z) {
                reached_lane = true;
                for jounce in snapshot.wheel_jounce {
                    min_jounce = min_jounce.min(jounce);
                    max_jounce = max_jounce.max(jounce);
                }
            }
            if p.z > 78.0 { break; }
        }
        assert!(reached_lane, "vehicle did not reach the suspension lane");
        assert!(max_jounce - min_jounce > 0.03, "suspension did not respond: {min_jounce}..{max_jounce}");
        eprintln!("Garage heightmap Vehicle2 travel range: {min_jounce}..{max_jounce} m");
    }

    #[test]
    fn dynamic_metadata_uses_shared_wire_shape_constants() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::spawn_dynamic_box_with_id(
            &mut arena,
            1,
            Vector3::new(0.0, 2.0, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(0.5, 0.5, 0.5),
        );
        WorldDocumentArena::spawn_dynamic_ball_with_id(
            &mut arena,
            2,
            Vector3::new(2.0, 2.0, 0.0),
            0.5,
        );

        assert_eq!(arena.dynamic[&1].shape_type, SHAPE_BOX);
        assert_eq!(arena.dynamic[&2].shape_type, SHAPE_SPHERE);
    }

    fn idle_input() -> InputCmd {
        InputCmd::default()
    }

    /// A fired ball that has gone through the ground is retired at the floor a
    /// few metres under it, through the same removal as an expired ball: gone
    /// from the scene and from the snapshot every client reads. Nothing above
    /// the floor is retired -- not a ball resting on the ground, and not one
    /// already under the ground but still above the floor.
    #[test]
    fn a_ball_through_the_ground_is_retired_at_the_floor_and_not_before() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        // A slab 1 m thick, its top at y = 0, so a ball can be placed under it.
        WorldDocumentArena::add_static_cuboid(
            &mut arena,
            Vector3::new(0.0, -0.5, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(50.0, 0.5, 50.0),
            1,
        );
        assert_eq!(arena.lowest_ground_y(), Some(0.0));
        let floor = arena.retire_floor_y();
        let depth = vibe_land_destruction::ground_watch::retire_depth_m();
        assert!((floor + depth).abs() < 1e-5, "floor {floor} is not {depth} m under the ground");

        let resting = arena
            .launch_meteor(Vector3::new(0.0, 0.5, 0.0), Vector3::zeros(), 0.5, 100.0, 100_000)
            .unwrap();
        // Under the slab (bottom at -1 m) and 2 m above the floor, falling.
        let under = arena
            .launch_meteor(Vector3::new(20.0, floor + 2.0, 0.0), Vector3::zeros(), 0.5, 100.0, 100_000)
            .unwrap();
        let ids = |arena: &PhysxPhysicsArena| -> Vec<u32> {
            arena.snapshot_dynamic_bodies().iter().map(|body| body.0).collect()
        };

        // Negative: both are above the floor, so both are kept and published.
        for _ in 0..5 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let live = ids(&arena);
        assert!(live.contains(&resting), "the resting ball was retired: {live:?}");
        assert!(live.contains(&under), "a ball above the floor was retired: {live:?}");
        assert_eq!(arena.balls_retired_below_floor(), 0);
        assert_eq!(arena.balls_below_ground(), 1, "the ball under the slab is through the ground");

        // 2 m of free fall is ~0.64 s. A second is past the floor for certain.
        for _ in 0..60 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let live = ids(&arena);
        assert!(!live.contains(&under), "the ball below the floor is still published: {live:?}");
        assert!(live.contains(&resting), "the resting ball was retired: {live:?}");
        assert_eq!(arena.launched_ball_count(), 1);
        assert_eq!(arena.balls_retired_below_floor(), 1);
        let body = arena
            .world
            .body_snapshots()
            .unwrap()
            .into_iter()
            .find(|body| body.entity_id == NS_DYNAMIC | (resting & ID_MASK))
            .expect("resting ball");
        assert!((body.pose.position.y - 0.5).abs() < 0.05, "the resting ball moved: {:?}", body.pose.position);
        assert!(
            arena.world.body_snapshots().unwrap().iter().all(|b| b.entity_id != NS_DYNAMIC | (under & ID_MASK)),
            "the retired ball is still in the scene"
        );
    }

    #[test]
    fn a_box_top_is_measured_after_its_rotation() {
        let half = Vector3::new(3.0, 0.5, 2.0);
        assert!((box_top_extent([0.0, 0.0, 0.0, 1.0], half) - 0.5).abs() < 1e-5);
        // 90 degrees about z: the local x axis points up.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        assert!((box_top_extent([0.0, 0.0, s, s], half) - 3.0).abs() < 1e-4);
        // 90 degrees about x: the local z axis points up.
        assert!((box_top_extent([s, 0.0, 0.0, s], half) - 2.0).abs() < 1e-4);
        // Yaw alone changes nothing.
        assert!((box_top_extent([0.0, s, 0.0, s], half) - 0.5).abs() < 1e-4);
    }

    #[test]
    fn steering_ramps_and_narrows_with_speed() {
        let dt = 1.0 / 60.0;
        let full_right = VehicleInputCmd { throttle: 0.0, reverse: 0.0, steer: 1.0, handbrake: false };
        let mut steer = 0.0;
        let mut ticks_to_full = 0;
        while steer < 0.999 {
            shape_vehicle_commands(&full_right, 0.0, &mut steer, dt);
            ticks_to_full += 1;
            assert!(ticks_to_full < 30, "steer never reached full lock");
        }
        assert!((10..=15).contains(&ticks_to_full), "full lock took {ticks_to_full} ticks");
        let centre = VehicleInputCmd { steer: 0.0, ..full_right };
        let mut ticks_to_centre = 0;
        while steer > 0.001 {
            shape_vehicle_commands(&centre, 0.0, &mut steer, dt);
            ticks_to_centre += 1;
            assert!(ticks_to_centre < 30, "steer never returned to centre");
        }
        assert!(ticks_to_centre <= 8, "return to centre took {ticks_to_centre} ticks");

        // At speed the same key asks for a fraction of the lock.
        assert!((steer_lock_fraction(0.0) - 1.0).abs() < 1e-6);
        assert!((steer_lock_fraction(6.0) - 1.0).abs() < 1e-6);
        assert!((steer_lock_fraction(28.0) - STEER_MIN_LOCK_FRACTION).abs() < 1e-6);
        assert!((steer_lock_fraction(-28.0) - STEER_MIN_LOCK_FRACTION).abs() < 1e-6);
        let mid = steer_lock_fraction(17.0);
        assert!(mid > STEER_MIN_LOCK_FRACTION && mid < 1.0);
        let mut fast_steer = 0.0;
        for _ in 0..60 {
            shape_vehicle_commands(&full_right, 28.0, &mut fast_steer, dt);
        }
        assert!((fast_steer - STEER_MIN_LOCK_FRACTION).abs() < 1e-4, "lock at 28 m/s: {fast_steer}");
    }

    #[test]
    fn pedals_brake_against_motion_and_reverse_from_rest() {
        let dt = 1.0 / 60.0;
        let mut steer = 0.0;
        let s_key = VehicleInputCmd { throttle: 0.0, reverse: 1.0, steer: 0.0, handbrake: false };
        let w_key = VehicleInputCmd { throttle: 1.0, reverse: 0.0, steer: 0.0, handbrake: false };
        // Rolling forward, S brakes in forward gear.
        let cmd = shape_vehicle_commands(&s_key, 12.0, &mut steer, dt);
        assert_eq!((cmd.throttle, cmd.brake, cmd.reverse), (0.0, 1.0, false));
        // From rest, S reverses.
        let cmd = shape_vehicle_commands(&s_key, 0.2, &mut steer, dt);
        assert_eq!((cmd.throttle, cmd.brake, cmd.reverse), (1.0, 0.0, true));
        // Rolling back, W brakes in reverse gear.
        let cmd = shape_vehicle_commands(&w_key, -5.0, &mut steer, dt);
        assert_eq!((cmd.throttle, cmd.brake, cmd.reverse), (0.0, 1.0, true));
        // Reverse is capped.
        let cmd = shape_vehicle_commands(&s_key, -9.0, &mut steer, dt);
        assert_eq!((cmd.throttle, cmd.reverse), (0.0, true));
        // No pedal: coast, no brake.
        let idle = VehicleInputCmd { throttle: 0.0, reverse: 0.0, steer: 0.0, handbrake: false };
        let cmd = shape_vehicle_commands(&idle, 12.0, &mut steer, dt);
        assert_eq!((cmd.throttle, cmd.brake, cmd.handbrake), (0.0, 0.0, 0.0));
        for mut pedal in [w_key, s_key] {
            pedal.handbrake = true;
            let cmd = shape_vehicle_commands(&pedal, 0.0, &mut steer, dt);
            assert_eq!((cmd.throttle, cmd.handbrake), (0.0, 1.0));
        }
    }

    /// Deterministic impact diagnostic using the production prepared compound,
    /// GPU scene, launch path and contact readback. This is not a fracture gate:
    /// zero registered stress bonds is explicitly reported as unqualified.
    #[cfg(feature = "native-destruction")]
    #[test]
    #[ignore = "requires local GPU and VIBE_VEHICLE_BUILD_FIXTURES; writes VIBE_VEHICLE_IMPACT_REPORT"]
    fn garage_targeted_projectile_probe() {
        let _guard=gpu_test_guard();
        let fixtures:serde_json::Value=serde_json::from_slice(&std::fs::read(
            std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("fixture file")).unwrap()).unwrap();
        let index:usize=std::env::var("VIBE_VEHICLE_IMPACT_BUILD").ok().map(|s|s.parse().unwrap()).unwrap_or(0);
        let fixture=&fixtures[index];
        let bytes=std::fs::read(fixture["metadataPath"].as_str().expect("fixture metadataPath")).unwrap();
        let metadata:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
        let mut geometry:crate::vehicle_assets::PreparedGeometry=serde_json::from_slice(&bytes).unwrap();
        geometry.fracture_layout=Some(geometry.validate_fracture_layout().expect("invalid authored fracture graph"));
        geometry.driving=Some(serde_json::from_value(fixture["driving"].clone()).unwrap());
        let target_id=std::env::var("VIBE_VEHICLE_IMPACT_PART").ok();
        let part=target_id.as_ref().map(|id|geometry.parts.iter().find(|p|&p.id==id).expect("unknown target part"));
        let local=part.map(|p|p.position).unwrap_or([0.0,0.0,0.0]);
        let mut arena=PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::add_static_cuboid(&mut arena,Vector3::new(0.0,-1.0,0.0),
            [0.0,0.0,0.0,1.0],Vector3::new(200.0,1.0,200.0),1);
        arena.spawn_vehicle_asset(7,0,Vector3::new(0.0,geometry.origin_height+0.15,0.0),
            [0.0,0.0,0.0,1.0],Some(&geometry)).unwrap();
        let mut idle_ms=Vec::new();
        for _ in 0..180 {
            let start=std::time::Instant::now();arena.begin_dynamics();arena.finish_dynamics();
            idle_ms.push(start.elapsed().as_secs_f64()*1000.0);
        }
        let before=arena.current_vehicle_snapshots()[0];
        let q=before.pose.rotation;
        let rotation=nalgebra::UnitQuaternion::new_normalize(nalgebra::Quaternion::new(q.w,q.x,q.y,q.z));
        let target=Vector3::new(before.pose.position.x,before.pose.position.y,before.pose.position.z)+rotation*Vector3::from(local);
        let origin=target+Vector3::new(-8.0,0.5,0.0);
        let shot=crate::garage_bombardment::aimed_shot(origin,target,0.18);
        let ball=arena.launch_ball_from_muzzle(shot.origin,shot.velocity,crate::garage_bombardment::BALL_RADIUS,
            crate::garage_bombardment::BALL_MASS,crate::garage_bombardment::BALL_TTL).unwrap();
        let ball_entity=NS_DYNAMIC|ball;
        let mut contacts=Vec::new();let mut impact_ms=Vec::new();let mut trajectory=Vec::new();
        for tick in 0..240 {
            let start=std::time::Instant::now();arena.begin_dynamics();arena.finish_dynamics();
            impact_ms.push(start.elapsed().as_secs_f64()*1000.0);
            for e in &arena.contact_events {
                if (e.entity_a==ball_entity && e.entity_b==(NS_VEHICLE|7)) || (e.entity_b==ball_entity && e.entity_a==(NS_VEHICLE|7)) {
                    contacts.push(serde_json::json!({"tick":tick,"point":[e.point.x,e.point.y,e.point.z],"impulse":[e.impulse.x,e.impulse.y,e.impulse.z]}));
                }
            }
            let car=arena.current_vehicle_snapshots()[0];
            assert!(car.pose.position.x.is_finite() && car.pose.position.y.is_finite());
            trajectory.push(serde_json::json!({"tick":tick,"position":[car.pose.position.x,car.pose.position.y,car.pose.position.z],
                "wheelSpeeds":car.wheel_rotation_speed,"wheelsOnRoad":car.wheels_on_road}));
        }
        let stats=arena.world.native_stats();
        let (structures,broken)=stats.as_ref().map(|s|(s.structures,s.broken_bonds)).unwrap_or((0,0));
        let native_error=stats.as_ref().err().map(ToString::to_string);
        let report=serde_json::json!({"build":fixture["name"],"targetPart":target_id,"target":local,
            "authoredParts":geometry.parts.len(),"authoredBonds":metadata["bondCount"],
            "authoredGraphValidated":geometry.fracture_layout.is_some(),
            "registeredStructures":structures,"brokenBonds":broken,"nativeError":native_error,
            "fractureQualified":false,"qualification":"physical contact probe only; native Vehicle2 constraint ownership is pending",
            "projectile":{"massKg":crate::garage_bombardment::BALL_MASS,"radiusM":crate::garage_bombardment::BALL_RADIUS,
                "origin":[shot.origin.x,shot.origin.y,shot.origin.z],"velocity":[shot.velocity.x,shot.velocity.y,shot.velocity.z]},
            "contacts":contacts,"trajectory":trajectory,"idleCompleteStepMs":idle_ms,"impactCompleteStepMs":impact_ms});
        let path=std::env::var("VIBE_VEHICLE_IMPACT_REPORT").expect("report output path");
        std::fs::write(&path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        eprintln!("vehicle impact probe: {} contacts; report {}",contacts.len(),path);
        assert!(!contacts.is_empty(),"targeted projectile did not contact the vehicle; inspect the report");
        if std::env::var_os("VIBE_VEHICLE_REQUIRE_FRACTURE").is_some() {
            assert!(structures>0 && broken>0,"fracture qualification failed: vehicle has no active native fracture graph");
        }
    }

    #[test]
    #[ignore = "requires native GPU and VIBE_VEHICLE_BUILD_FIXTURES"]
    fn live_tuning_preserves_motion_and_changes_driving() {
        let _guard=gpu_test_guard();
        let fixtures:serde_json::Value=serde_json::from_slice(&std::fs::read(
            std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").unwrap()).unwrap()).unwrap();
        let fixture=&fixtures[0];
        let original:crate::vehicle_assets::PreparedDriving=serde_json::from_value(fixture["driving"].clone()).unwrap();
        let mut geometry:crate::vehicle_assets::PreparedGeometry=serde_json::from_slice(
            &std::fs::read(fixture["metadataPath"].as_str().unwrap()).unwrap()).unwrap();
        geometry.driving=Some(original.clone());
        let mut arena=PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        WorldDocumentArena::add_static_cuboid(&mut arena,Vector3::new(0.0,-1.0,0.0),
            [0.0,0.0,0.0,1.0],Vector3::new(1000.0,1.0,1000.0),1);
        let spawn=arena.spawn_player(10);
        arena.spawn_vehicle_asset(7,0,Vector3::new(spawn.x as f32,geometry.origin_height+0.15,spawn.z as f32),
            [0.0,0.0,0.0,1.0],Some(&geometry)).unwrap();
        arena.enter_vehicle(10,7);
        let run=|arena:&mut PhysxPhysicsArena,ticks:u32,brake:bool| {
            for _ in 0..ticks {
                let mut input=InputCmd::default();input.move_y=127;
                if brake {input.buttons=BTN_JUMP;}
                arena.simulate_player_tick(10,&input,1.0/60.0);
                arena.begin_dynamics();arena.finish_dynamics();
                let car=arena.current_vehicle_snapshots()[0];
                assert!(car.pose.position.y.is_finite() && vehicle_heading(&car).2>0.6);
            }
        };
        run(&mut arena,480,false);
        let before=arena.current_vehicle_snapshots()[0];
        assert!(vehicle_heading(&before).1>20.0);
        let mut tune=original.clone();
        tune.top_speed=12.0;tune.drive_torque*=0.7;tune.brake_torque*=1.2;
        tune.spring_stiffness*=1.3;tune.damping*=0.8;tune.tyre_friction=1.0;
        tune.max_steer_radians*=0.8;tune.rear_wheel_drive=true;tune.steering_response=0.7;
        arena.tune_vehicle(7,&tune).unwrap();
        assert_eq!(arena.current_vehicle_snapshots()[0],before,"tuning must preserve every dynamic state field");
        assert_eq!(arena.player_vehicle_id(10),Some(7));
        let mut invalid=tune.clone();invalid.damping=f32::NAN;
        assert!(arena.tune_vehicle(7,&invalid).is_err());
        assert_eq!(arena.current_vehicle_snapshots()[0],before);
        // Rear-wheel handbraking at the reduced grip needs more than four seconds from 30 m/s.
        run(&mut arena,480,true);
        let stopped=vehicle_heading(&arena.current_vehicle_snapshots()[0]).1;
        assert!(stopped.abs()<0.5,"handbrake after retuning: {stopped}");
        run(&mut arena,600,false);
        let slow=vehicle_heading(&arena.current_vehicle_snapshots()[0]).1;
        assert!(slow>7.0 && slow<13.0,"updated response curve must control speed: {slow}");
        arena.tune_vehicle(7,&original).unwrap();
        run(&mut arena,480,false);
        let fast=vehicle_heading(&arena.current_vehicle_snapshots()[0]).1;
        assert!(fast>24.0,"restoring setup must restore acceleration: {fast}");
        assert_eq!(arena.player_vehicle_id(10),Some(7));
        eprintln!("live tune: preserved moving state; RWD tune {slow:.2} m/s, restored AWD {fast:.2} m/s");
    }

    #[test]
    #[ignore = "prepare fixtures with client/scripts/verify-vehicle-builds.mjs; set VIBE_VEHICLE_BUILD_FIXTURES"]
    fn prepared_garage_builds_drive_turn_and_brake() {
        let _guard = gpu_test_guard();
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture { name: String, metadata_path: String, driving: crate::vehicle_assets::PreparedDriving }
        let path = std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("fixture path");
        let fixtures: Vec<Fixture> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(fixtures.len() >= 11);
        for fixture in fixtures {
            assert!(fixture.driving.is_valid());
            let mut geometry: crate::vehicle_assets::PreparedGeometry = serde_json::from_slice(
                &std::fs::read(fixture.metadata_path).unwrap()).unwrap();
            geometry.driving = Some(fixture.driving.clone());
            let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
            WorldDocumentArena::add_static_cuboid(&mut arena, Vector3::new(0.0,-1.0,0.0),
                [0.0,0.0,0.0,1.0],Vector3::new(1000.0,1.0,1000.0),1);
            let spawn = arena.spawn_player(10);
            arena.spawn_vehicle_asset(7,0,Vector3::new(spawn.x as f32,geometry.origin_height+0.15,spawn.z as f32),
                [0.0,0.0,0.0,1.0],Some(&geometry)).unwrap();
            arena.enter_vehicle(10,7);
            assert_eq!(arena.player_vehicle_id(10),Some(7));
            let mut top_speed=0.0f32;
            for tick in 0..1200 {
                let mut input=InputCmd::default();
                if tick>=120 { input.move_y=127; }
                if (600..900).contains(&tick) {input.move_x=127;}
                if tick>=900 {input.buttons=BTN_JUMP;}
                arena.simulate_player_tick(10,&input,1.0/60.0);
                arena.begin_dynamics(); arena.finish_dynamics();
                let car=arena.current_vehicle_snapshots()[0];
                let (_,speed,up)=vehicle_heading(&car);
                assert!(speed.is_finite() && car.pose.position.y.is_finite(),"{} nonfinite at {tick}",fixture.name);
                assert!(up>0.6,"{} rolled during flat-ground steering at {tick}: {up}",fixture.name);
                assert!(car.pose.position.y>0.0,"{} fell through road",fixture.name);
                if tick<900 {top_speed=top_speed.max(speed);}
                for jounce in car.wheel_jounce {
                    assert!(jounce>=-0.001 && jounce<=geometry.suspension_travel+0.001);
                }
            }
            let car=arena.current_vehicle_snapshots()[0];
            let speed=vehicle_heading(&car).1;
            eprintln!("{}: {:.2} m/s peak -> {:.3} m/s handbrake",fixture.name,top_speed,speed);
            assert!(top_speed>4.0,"{} failed to accelerate",fixture.name);
            assert!(top_speed<fixture.driving.top_speed+2.0,"{} exceeded speed setup",fixture.name);
            assert!(speed.abs()<0.5,"{} failed to brake: {speed}",fixture.name);
        }
    }

    #[test]
    fn handbrake_stops_vehicle_even_with_accelerator_held() {
        let _guard = gpu_test_guard();
        // A standard car and two custom chassis weights exercise the same
        // authoring path as garage assets, without depending on a local cache.
        for (mass, hold_throttle) in [(600.0, false), (600.0, true), (2500.0, true), (10000.0, true)] {
            let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
            WorldDocumentArena::add_static_cuboid(&mut arena,
                Vector3::new(0.0, -1.0, 0.0), [0.0, 0.0, 0.0, 1.0],
                Vector3::new(200.0, 1.0, 200.0), 1);
            // City publication adds a prepared car after simulation has begun,
            // and the city uses the split dispatch/fetch path.
            let step = |arena: &mut PhysxPhysicsArena| {
                if mass == 2500.0 {
                    arena.begin_dynamics();
                    arena.finish_dynamics();
                } else {
                    arena.step_vehicles_and_dynamics(1.0 / 60.0);
                }
            };
            for _ in 0..4 { step(&mut arena); }
            let p = arena.spawn_player(10);
            let definition = vehicle_definition(0);
            let [x, y, z] = definition.chassis_half_extents;
            let vertices: Vec<_> = [-x, x].into_iter().flat_map(|x|
                [-y, y].into_iter().flat_map(move |y| [-z, z].into_iter().map(move |z| [x, y, z]))).collect();
            let travel = definition.suspension_travel_m;
            let box_mass = crate::vehicle_assets::AssetMassProperties {
                mass: mass as f64, center: [0.0; 3],
                inertia: [
                    [(mass * (y*y + z*z) / 3.0) as f64, 0.0, 0.0],
                    [0.0, (mass * (x*x + z*z) / 3.0) as f64, 0.0],
                    [0.0, 0.0, (mass * (x*x + y*y) / 3.0) as f64],
                ],
            };
            let prepared = crate::vehicle_assets::PreparedGeometry {
                driving: None,
                origin_height: definition.wheel_radius_m + 0.25,
                wheel_centers: definition.wheel_offsets,
                suspension_travel: travel,
                neutral_jounce: travel / 3.0,
                suspension_attachment_y: -(definition.suspension_rest_length_m - travel * 2.0 / 3.0),
                wheel_half_width: 0.15,
                max_steer_radians: VEHICLE_MAX_STEER_RAD,
                mass,
                mass_properties: box_mass.clone(), bonds: Vec::new(), fracture_layout: None,
                bounds: crate::vehicle_assets::AssetBounds { min: [-x, -y, -z], max: [x, y, z] },
                parts: vec![crate::vehicle_assets::AssetPart {
                    id: "test-chassis".into(), motion: None, functionality: None, position: [0.0; 3],
                    visual_ids: vec!["test-chassis".into()], mass: mass as f64,
                    volume: (8.0*x*y*z) as f64, mass_properties: box_mass,
                    shapes: vec![crate::vehicle_assets::AssetShape { position: [0.0; 3], vertices }],
                }],
            };
            arena.spawn_vehicle_asset(7, 0, Vector3::new(p.x as f32, p.y as f32, p.z as f32),
                [0.0, 0.0, 0.0, 1.0], if mass == 600.0 { None } else { Some(&prepared) }).unwrap();
            arena.enter_vehicle(10, 7);
            let mut input = InputCmd::default();
            input.move_y = 127;
            for _ in 0..120 {
                arena.simulate_player_tick(10, &input, 1.0 / 60.0);
                step(&mut arena);
            }
            let before = arena.current_vehicle_snapshots()[0];
            let (_, speed_before, _) = vehicle_heading(&before);
            input.move_y = if hold_throttle { 127 } else { 0 };
            input.buttons = BTN_JUMP;
            for _ in 0..240 {
                arena.simulate_player_tick(10, &input, 1.0 / 60.0);
                step(&mut arena);
            }
            let after = arena.current_vehicle_snapshots()[0];
            let (_, speed_after, _) = vehicle_heading(&after);
            eprintln!("Handbrake mass={mass} throttle={hold_throttle}: {speed_before} -> {speed_after} m/s; wheel speeds {:?}", after.wheel_rotation_speed);
            assert!(speed_before > 10.0);
            assert!(speed_after.abs() < 0.5, "handbrake failed with throttle={hold_throttle}: {speed_after} m/s");
            assert!(after.wheel_rotation_speed[2..].iter().all(|speed| speed.abs() < 0.1), "rear wheels did not lock");
            // Releasing Space must restore the accelerator immediately.
            input.buttons = 0;
            input.move_y = 127;
            for _ in 0..60 {
                arena.simulate_player_tick(10, &input, 1.0 / 60.0);
                step(&mut arena);
            }
            assert!(vehicle_heading(&arena.current_vehicle_snapshots()[0]).1 > 5.0);
        }
    }

    #[test]
    fn vehicle_entry_requires_proximity_and_preserves_single_driver_lifecycle() {
        let _guard = gpu_test_guard();
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        // A slab to drive on, its top at y=0.
        WorldDocumentArena::add_static_cuboid(
            &mut arena,
            Vector3::new(0.0, -1.0, 0.0),
            [0.0, 0.0, 0.0, 1.0],
            Vector3::new(200.0, 1.0, 200.0),
            1,
        );
        let player_position = arena.spawn_player(10);
        WorldDocumentArena::spawn_vehicle_with_id(
            &mut arena,
            7,
            0,
            Vector3::new(
                player_position.x as f32,
                player_position.y as f32,
                player_position.z as f32,
            ),
            [0.0, 0.0, 0.0, 1.0],
        );
        arena.spawn_player(11);
        arena.players.get_mut(&11).unwrap().position = Vec3d::new(100.0, 2.0, 100.0);

        arena.enter_vehicle(10, 7);
        assert_eq!(arena.player_vehicle_id(10), Some(7));
        assert!(!arena.players[&10].controller_present);

        arena.enter_vehicle(11, 7);
        assert_eq!(arena.player_vehicle_id(11), None);
        assert_eq!(arena.vehicles[&7].driver_id, 10);

        // Drive: full throttle for two seconds. The vehicle SDK moves the car,
        // the seated player's position follows it (the snapshot anchor and
        // area of interest read that position), and the wheels report spin.
        let start = arena.snapshot_vehicles()[0];
        let mut input = InputCmd::default();
        input.move_y = 127;
        for _ in 0..120 {
            arena.simulate_player_tick(10, &input, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let driven = arena.snapshot_vehicles()[0];
        let travelled = (driven.px_mm - start.px_mm).pow(2) as f64 + (driven.pz_mm - start.pz_mm).pow(2) as f64;
        assert!(travelled.sqrt() > 5_000.0, "the car did not drive: {start:?} -> {driven:?}");
        assert!(driven.wheel_data.iter().any(|w| *w != 0), "wheel data is empty: {driven:?}");
        let seated = arena.player_state(10).unwrap();
        assert!(
            ((seated.position.x * 1000.0) as i32 - driven.px_mm).abs() < 50
                && ((seated.position.z * 1000.0) as i32 - driven.pz_mm).abs() < 50,
            "seated player did not follow the car: {:?} vs {driven:?}",
            seated.position
        );
        let (_, _, _, _, _, flags) = arena.snapshot_player(10).unwrap();
        assert_ne!(flags & FLAG_IN_VEHICLE, 0);

        // S while rolling forward is the brake, not reverse gear: the car
        // slows and keeps its heading instead of fighting its own momentum.
        let mut brake = InputCmd::default();
        brake.move_y = -127;
        let before_brake = arena.current_vehicle_snapshots()[0];
        let (_, speed_before, _) = vehicle_heading(&before_brake);
        // Three quarters of a second: enough to lose most of the speed at
        // the tyre limit, not enough to stop and start reversing.
        for _ in 0..45 {
            arena.simulate_player_tick(10, &brake, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let after_brake = arena.current_vehicle_snapshots()[0];
        let (_, speed_after, _) = vehicle_heading(&after_brake);
        assert!(speed_before > 10.0, "not up to speed before braking: {speed_before}");
        assert!(speed_after < speed_before * 0.6 && speed_after > 0.0,
            "S did not brake the rolling car: {speed_before} -> {speed_after} m/s");

        // Handbrake to a stop before getting out; direct drive has no engine
        // braking and a coasting car is not parked.
        let mut handbrake = InputCmd::default();
        handbrake.buttons |= BTN_JUMP;
        for _ in 0..240 {
            arena.simulate_player_tick(10, &handbrake, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let stopped = arena.snapshot_vehicles()[0];
        assert!(stopped.vx_cms.abs() < 50 && stopped.vz_cms.abs() < 50, "the handbrake did not stop the car: {stopped:?}");

        // R with the car on its roof puts it back on its wheels where it
        // was, facing the way it faced; a second R inside the cooldown, or
        // one while the upright car is moving, does nothing.
        let flipped = arena.current_vehicle_snapshots()[0];
        let (_, _, up_before) = vehicle_heading(&flipped);
        assert!(up_before > 0.9);
        let roof = bridge::Pose {
            position: flipped.pose.position,
            rotation: bridge::Quat { x: 0.0, y: 0.0, z: 1.0, w: 0.0 },
        };
        arena.world.reset_vehicle(NS_VEHICLE | 7, roof).unwrap();
        arena.step_vehicles_and_dynamics(1.0 / 60.0);
        let (_, _, up_flipped) = vehicle_heading(&arena.current_vehicle_snapshots()[0]);
        assert!(up_flipped < -0.9, "the test could not flip the car: up {up_flipped}");
        let mut reset = InputCmd::default();
        reset.buttons |= BTN_RELOAD;
        arena.simulate_player_tick(10, &reset, 1.0 / 60.0);
        arena.step_vehicles_and_dynamics(1.0 / 60.0);
        for _ in 0..60 {
            arena.simulate_player_tick(10, &idle_input(), 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        let righted = arena.current_vehicle_snapshots()[0];
        let (_, _, up_after) = vehicle_heading(&righted);
        assert!(up_after > 0.9, "R did not right the car: up {up_after}");
        assert!((righted.pose.position.x - flipped.pose.position.x).abs() < 1.0
            && (righted.pose.position.z - flipped.pose.position.z).abs() < 1.0,
            "the reset moved the car: {:?} -> {:?}", flipped.pose.position, righted.pose.position);

        arena.exit_vehicle(10);
        assert_eq!(arena.player_vehicle_id(10), None);
        assert!(arena.players[&10].controller_present);
        assert_eq!(arena.vehicles[&7].driver_id, 0);
        // The parked car, with nobody driving it, comes to rest and sleeps.
        let idle = InputCmd::default();
        let mut slept = false;
        for _ in 0..600 {
            arena.simulate_player_tick(10, &idle, 1.0 / 60.0);
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
            if arena.current_vehicle_snapshots()[0].sleeping {
                slept = true;
                break;
            }
        }
        assert!(slept, "the parked car never slept");
    }
}

/// Report a rejected PhysX step instead of taking the match down with it.
///
/// On the native destruction backend a step CAN be rejected. Panicking turns one
/// rejected tick into a dead match, which is strictly worse than a frozen one --
/// and it destroys the only evidence of why. The scene keeps its previous
/// accepted state, so the next tick simply tries again.
///
/// A slow stress solve is no longer one of the reasons. The stage used to fail
/// the whole simulation step when the solve had not converged inside one tick's
/// iteration budget, which is not a fault at all: the solver keeps its
/// warm-started iterate and refines it on the next tick. That check is gone
/// from the engine, so what reaches here is a real fault.
///
/// Every other backend still fails loudly: there, a failed step means the
/// engine itself is broken and continuing would publish a fiction.
/// Claim the CUDA context is lost, for exercising the path that responds to it.
///
/// The real thing cannot be produced on demand any more, which is the point of
/// the fix that stopped producing it. An unreproducible fault still needs its
/// response exercised, or the response is only a belief:
///
///   VIBE_PHYSX_FAKE_CONTEXT_LOST=1
///
/// turns the next rejected step into a process exit, and the supervisor should
/// have the server back inside a few seconds.
/// Leave the process, so the supervisor can provide a working one.
///
/// A lost CUDA context is not a rejected step, and treating it as one is how a
/// match spends 11,876 consecutive ticks serving a world that will never move
/// again. One illegal address or failed allocation anywhere in the device work
/// poisons the context for the life of the process: every later launch fails
/// identically, and no reset, rebuild or scene teardown undoes it. The only
/// repair is a new process, and the supervisor makes one within a few seconds.
#[cfg(feature = "native-destruction")]
fn exit_on_lost_context() -> ! {
    tracing::error!(
        "the CUDA context is lost and cannot be recovered in this process; \
         exiting so the supervisor restarts the server"
    );
    // Flush first: this line is the only explanation anyone gets.
    use std::io::Write;
    let _ = std::io::stderr().flush();
    std::process::exit(70);
}

#[cfg(feature = "native-destruction")]
fn pretend_context_lost() -> bool {
    std::env::var("VIBE_PHYSX_FAKE_CONTEXT_LOST").is_ok_and(|v| v != "0")
}

#[cfg(feature = "native-destruction")]
fn report_rejected_step(world: &vibe_land_physx_bridge::World, phase: &str, error: &dyn std::fmt::Display) {
    use std::sync::atomic::{AtomicU64, Ordering};
    // A lost CUDA context is not a rejected step, and treating it as one is how
    // a match spends 11,876 consecutive ticks serving a world that will never
    // move again. One illegal address or failed allocation anywhere in the
    // device work poisons the context for the life of the process: every later
    // launch fails identically, and no reset, rebuild or scene teardown undoes
    // it. The only repair is a new process, so say so plainly and take one --
    // the supervisor restarts the server, and players reconnect to a city that
    // works instead of one that cannot be broken.
    if world.gpu_context_lost() || pretend_context_lost() {
        tracing::error!(%error, phase, "the step that noticed the lost context");
        exit_on_lost_context();
    }
    static REPORTED: AtomicU64 = AtomicU64::new(0);
    let n = REPORTED.fetch_add(1, Ordering::Relaxed);
    // Bounded: a persistent fault would otherwise fill the log faster than
    // anyone can read it. The exact count stays in the stage's own spans.
    if n < 8 || n % 600 == 0 {
        match world.native_last_status() {
            Ok(status) => tracing::error!(
                %error,
                phase,
                rejected_steps = n + 1,
                error_bits = status.error,
                iterations = status.iterations,
                converged = status.converged,
                "PhysX rejected this step; the city keeps its last accepted state \
                 (error bit 8192 = contact lifetime space exhausted, 32 = topology \
                 transaction, 2 = nonfinite stress)"
            ),
            Err(status_error) => tracing::error!(
                %error, phase, %status_error,
                "PhysX rejected this step and its status could not be read"
            ),
        }
    }
}

#[cfg(all(test, feature = "native-destruction"))]
#[path = "physx_runtime/vehicle_fracture_tests.rs"]
mod vehicle_fracture_tests;
