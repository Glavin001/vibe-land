/// Shared vehicle physics helpers used by both the server-side `PhysicsArena`
/// and the WASM client `WasmSimWorld`.
///
/// Keeping spawn logic and filter construction here ensures the two physics
/// worlds stay byte-for-byte identical — any tuning change made once is
/// automatically reflected in both.
use nalgebra::{point, Isometry3, Quaternion, UnitQuaternion, Vector3};
use rapier3d::control::{DynamicRayCastVehicleController, WheelTuning};
use rapier3d::prelude::*;
use vibe_netcode::physics_arena::DYNAMIC_SUBSTEPS;
use vibe_netcode::sim_world::SimWorld;

use crate::constants::BTN_RELOAD;
use crate::movement::{
    vehicle_wheel_params, Vec3d, VEHICLE_CHASSIS_DENSITY, VEHICLE_FRICTION_SLIP,
    VEHICLE_MAX_STEER_RAD, VEHICLE_SUSPENSION_DAMPING, VEHICLE_SUSPENSION_REST_LENGTH,
    VEHICLE_SUSPENSION_STIFFNESS, VEHICLE_SUSPENSION_TRAVEL, VEHICLE_WHEEL_RADIUS,
};
use crate::protocol::{make_net_vehicle_state, InputCmd, NetVehicleState};

pub const VEHICLE_CHASSIS_HALF_EXTENTS: [f32; 3] = [0.9, 0.3, 1.8];
pub const VEHICLE_CONTROLLER_SUBSTEPS: usize = 4;
pub const VEHICLE_WHEEL_OFFSETS: [[f32; 3]; 4] = [
    [-0.9, 0.0, 1.1],
    [0.9, 0.0, 1.1],
    [-0.9, 0.0, -1.1],
    [0.9, 0.0, -1.1],
];
const VEHICLE_RESET_LIFT_M: f32 = 1.0;
/// Nudge along preserved heading so the chassis clears nearby geometry after uprighting.
const VEHICLE_RESET_FORWARD_M: f32 = 0.45;
const VEHICLE_EXIT_SIDE_OFFSET_M: f32 = 2.5;
const VEHICLE_EXIT_UP_OFFSET_M: f32 = 1.0;

/// Spawn a vehicle chassis rigid body + collider + configured wheel controller
/// into `sim`.  Returns `(chassis_body, chassis_collider, controller)`.
///
/// Collision groups:
/// - Chassis: `GROUP_1` membership, filter `GROUP_1 | GROUP_2` — collides with
///   terrain and balls but not the player capsule (`GROUP_3`).
///
/// Callers are responsible for inserting the returned handles into their own
/// vehicle table and marking the chassis as modified if needed (already done
/// here via `sim.modified_colliders`).
pub fn create_vehicle_physics(
    sim: &mut SimWorld,
    pose: Isometry3<f32>,
) -> (
    RigidBodyHandle,
    ColliderHandle,
    DynamicRayCastVehicleController,
) {
    let body = RigidBodyBuilder::dynamic()
        .pose(pose)
        .linear_damping(0.1)
        .angular_damping(0.5)
        .sleeping(false)
        .can_sleep(false)
        .build();
    let chassis_body = sim.rigid_bodies.insert(body);

    // GROUP_1 = terrain/chassis, GROUP_2 = dynamic bodies (balls).
    // Suspension QueryFilter uses GROUP_1 only so the vehicle chassis box
    // pushes balls directly rather than the suspension climbing over them.
    let chassis_groups = InteractionGroups::new(Group::GROUP_1, Group::GROUP_1 | Group::GROUP_2);
    let collider = ColliderBuilder::cuboid(
        VEHICLE_CHASSIS_HALF_EXTENTS[0],
        VEHICLE_CHASSIS_HALF_EXTENTS[1],
        VEHICLE_CHASSIS_HALF_EXTENTS[2],
    )
    .friction(0.3)
    .restitution(0.1)
    .density(VEHICLE_CHASSIS_DENSITY)
    .collision_groups(chassis_groups)
    // Enable contact-force events so the WASM client can route vehicle
    // impacts into the Blast destructibles stress solver.  Threshold 0.0
    // = fire for every contact.  On non-wasm builds (no destructibles
    // feature) the event handler is `&()` so this is a zero-cost flag.
    .active_events(ActiveEvents::CONTACT_FORCE_EVENTS)
    .contact_force_event_threshold(0.0)
    .build();
    let chassis_collider =
        sim.colliders
            .insert_with_parent(collider, chassis_body, &mut sim.rigid_bodies);

    // index_forward_axis = 2 → chassis +Z is forward.
    // Wheel layout: FL, FR, RL, RR  (x = ±0.9, y = 0, z = ±1.1)
    // suspension_dir = -Y (downward), axle_dir = +X (right)
    let mut controller = DynamicRayCastVehicleController::new(chassis_body);
    controller.index_forward_axis = 2;
    let tuning = WheelTuning {
        suspension_stiffness: VEHICLE_SUSPENSION_STIFFNESS,
        suspension_damping: VEHICLE_SUSPENSION_DAMPING,
        friction_slip: VEHICLE_FRICTION_SLIP,
        max_suspension_travel: VEHICLE_SUSPENSION_TRAVEL,
        ..WheelTuning::default()
    };
    for offset in VEHICLE_WHEEL_OFFSETS {
        controller.add_wheel(
            point![offset[0], offset[1], offset[2]],
            -Vector3::y(),
            Vector3::x(),
            VEHICLE_SUSPENSION_REST_LENGTH,
            VEHICLE_WHEEL_RADIUS,
            &tuning,
        );
    }

    sim.modified_colliders.push(chassis_collider);

    (chassis_body, chassis_collider, controller)
}

/// Build the suspension `QueryFilter` for a vehicle step.
///
/// Excludes the chassis collider itself and restricts raycasts to `GROUP_1`
/// (terrain only).  Balls (`GROUP_2`) are intentionally excluded so the
/// chassis box collider pushes them instead of the suspension riding over them.
pub fn vehicle_suspension_filter(chassis_collider: ColliderHandle) -> QueryFilter<'static> {
    QueryFilter::default()
        .exclude_collider(chassis_collider)
        .groups(InteractionGroups::new(Group::GROUP_1, Group::GROUP_1))
}

/// Refresh suspension contacts after a teleport/reconcile without advancing time.
pub fn refresh_vehicle_contacts(
    sim: &mut SimWorld,
    chassis_collider: ColliderHandle,
    controller: &mut DynamicRayCastVehicleController,
) {
    let filter = vehicle_suspension_filter(chassis_collider);
    let queries = sim.broad_phase.as_query_pipeline_mut(
        sim.narrow_phase.query_dispatcher(),
        &mut sim.rigid_bodies,
        &mut sim.colliders,
        filter,
    );
    controller.update_vehicle(0.0, queries);
}

/// Step the vehicle rigid-body pipeline for one client prediction tick.
///
/// `event_handler` is the `EventHandler` passed to `pipeline.step`.  The WASM
/// client passes a `ChannelEventCollector` so contact-force events can be
/// routed into the Blast destructibles stress solver; server-side callers
/// (and the `#[cfg(test)]` rig below) pass `&()` which is a zero-cost no-op.
pub fn step_vehicle_dynamics(
    sim: &mut SimWorld,
    gravity: &Vector3<f32>,
    pipeline: &mut PhysicsPipeline,
    impulse_joints: &mut ImpulseJointSet,
    multibody_joints: &mut MultibodyJointSet,
    ccd_solver: &mut CCDSolver,
    event_handler: &dyn EventHandler,
    dt: f32,
) {
    let substep_dt = dt / DYNAMIC_SUBSTEPS as f32;
    for _ in 0..DYNAMIC_SUBSTEPS {
        let mut params = sim.integration_parameters;
        params.dt = substep_dt;
        pipeline.step(
            gravity,
            &params,
            &mut sim.island_manager,
            &mut sim.broad_phase,
            &mut sim.narrow_phase,
            &mut sim.rigid_bodies,
            &mut sim.colliders,
            impulse_joints,
            multibody_joints,
            ccd_solver,
            &(),
            event_handler,
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleChassisState {
    pub position: [f32; 3],
    pub quaternion: [f32; 4],
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleDebugSnapshot {
    pub speed: f32,
    pub grounded_wheels: u8,
    pub steering: f32,
    pub engine_force: f32,
    pub brake: f32,
    pub linear_velocity: [f32; 3],
    pub angular_velocity: [f32; 3],
    pub wheel_contact_bits: u8,
    pub suspension_lengths: [f32; 4],
    pub suspension_forces: [f32; 4],
    pub suspension_relative_velocities: [f32; 4],
    pub wheel_hard_points: [[f32; 3]; 4],
    pub wheel_contact_points: [[f32; 3]; 4],
    pub wheel_contact_normals: [[f32; 3]; 4],
    pub wheel_ground_object_ids: [u32; 4],
}

/// Apply one input frame to a vehicle controller and update suspension/traction.
///
/// This is the single source of truth for wheel steering, engine force, brake,
/// reset behavior, and the Rapier vehicle-controller query/update call used by
/// the server, local authoritative practice arena, and WASM prediction world.
pub fn apply_vehicle_input_step(
    sim: &mut SimWorld,
    chassis_body: RigidBodyHandle,
    chassis_collider: ColliderHandle,
    controller: &mut DynamicRayCastVehicleController,
    input: &InputCmd,
    dt: f32,
) {
    let reset_requested = input.buttons & BTN_RELOAD != 0;
    let (steering, engine_force, brake) = vehicle_wheel_params(input);

    if reset_requested {
        if let Some(rb) = sim.rigid_bodies.get_mut(chassis_body) {
            reset_vehicle_body(rb);
        }
    }

    for (index, wheel) in controller.wheels_mut().iter_mut().enumerate() {
        if index < 2 {
            wheel.steering = if reset_requested { 0.0 } else { steering };
        }
        wheel.engine_force = if !reset_requested && index >= 2 {
            engine_force
        } else {
            0.0
        };
        wheel.brake = if reset_requested { 0.0 } else { brake };
    }

    let filter = vehicle_suspension_filter(chassis_collider);
    let queries = sim.broad_phase.as_query_pipeline_mut(
        sim.narrow_phase.query_dispatcher(),
        &mut sim.rigid_bodies,
        &mut sim.colliders,
        filter,
    );
    controller.update_vehicle(dt, queries);
}

/// Read the current chassis pose/velocity from the shared simulation world.
pub fn read_vehicle_chassis_state(
    sim: &SimWorld,
    chassis_body: RigidBodyHandle,
) -> Option<VehicleChassisState> {
    let rb = sim.rigid_bodies.get(chassis_body)?;
    let p = rb.translation();
    let q = rb.rotation();
    let lv = rb.linvel();
    let av = rb.angvel();
    Some(VehicleChassisState {
        position: [p.x, p.y, p.z],
        quaternion: [q.i, q.j, q.k, q.w],
        linear_velocity: [lv.x, lv.y, lv.z],
        angular_velocity: [av.x, av.y, av.z],
    })
}

pub fn read_vehicle_debug_snapshot(
    sim: &SimWorld,
    chassis_body: RigidBodyHandle,
    controller: &DynamicRayCastVehicleController,
) -> Option<VehicleDebugSnapshot> {
    let rb = sim.rigid_bodies.get(chassis_body)?;
    let linvel = rb.linvel();
    let angvel = rb.angvel();
    let speed = linvel.norm();
    let mut wheel_contact_bits = 0u8;
    let mut suspension_lengths = [0.0; 4];
    let mut suspension_forces = [0.0; 4];
    let suspension_relative_velocities = [0.0; 4];
    let mut wheel_hard_points = [[0.0; 3]; 4];
    let mut wheel_contact_points = [[0.0; 3]; 4];
    let mut wheel_contact_normals = [[0.0; 3]; 4];
    let mut wheel_ground_object_ids = [0u32; 4];
    let grounded_wheels = controller
        .wheels()
        .iter()
        .enumerate()
        .map(|(index, wheel)| {
            if index < 4 {
                let raycast = wheel.raycast_info();
                if wheel.raycast_info().is_in_contact {
                    wheel_contact_bits |= 1 << index;
                }
                suspension_lengths[index] = raycast.suspension_length;
                suspension_forces[index] = wheel.wheel_suspension_force;
                wheel_hard_points[index] = [
                    raycast.hard_point_ws.x,
                    raycast.hard_point_ws.y,
                    raycast.hard_point_ws.z,
                ];
                wheel_contact_points[index] = [
                    raycast.contact_point_ws.x,
                    raycast.contact_point_ws.y,
                    raycast.contact_point_ws.z,
                ];
                wheel_contact_normals[index] = [
                    raycast.contact_normal_ws.x,
                    raycast.contact_normal_ws.y,
                    raycast.contact_normal_ws.z,
                ];
                wheel_ground_object_ids[index] = raycast
                    .ground_object
                    .map(|handle| handle.into_raw_parts().0.saturating_add(1))
                    .unwrap_or(0);
            }
            wheel.raycast_info().is_in_contact as u8
        })
        .sum();
    let steering = controller
        .wheels()
        .iter()
        .take(2)
        .map(|wheel| wheel.steering)
        .sum::<f32>()
        / 2.0;
    let engine_force = controller
        .wheels()
        .iter()
        .skip(2)
        .map(|wheel| wheel.engine_force)
        .sum::<f32>()
        / 2.0;
    let brake = controller
        .wheels()
        .iter()
        .map(|wheel| wheel.brake)
        .fold(0.0, f32::max);

    Some(VehicleDebugSnapshot {
        speed,
        grounded_wheels,
        steering,
        engine_force,
        brake,
        linear_velocity: [linvel.x, linvel.y, linvel.z],
        angular_velocity: [angvel.x, angvel.y, angvel.z],
        wheel_contact_bits,
        suspension_lengths,
        suspension_forces,
        suspension_relative_velocities,
        wheel_hard_points,
        wheel_contact_points,
        wheel_contact_normals,
        wheel_ground_object_ids,
    })
}

/// Encode the wheel rotation/steering data used by the client vehicle visuals.
pub fn encode_vehicle_wheel_data(controller: &DynamicRayCastVehicleController) -> [u16; 4] {
    let mut wheel_data = [0u16; 4];
    for (i, wheel) in controller.wheels().iter().enumerate().take(4) {
        let spin = ((wheel.rotation / std::f32::consts::TAU).fract().abs() * 255.0) as u8;
        let steer =
            (wheel.steering / VEHICLE_MAX_STEER_RAD * 127.0).clamp(-127.0, 127.0) as i8 as u8;
        wheel_data[i] = ((spin as u16) << 8) | (steer as u16);
    }
    wheel_data
}

/// Build a replicated vehicle snapshot directly from the shared simulation.
pub fn make_vehicle_snapshot(
    sim: &SimWorld,
    id: u32,
    vehicle_type: u8,
    flags: u8,
    driver_id: u32,
    chassis_body: RigidBodyHandle,
    controller: &DynamicRayCastVehicleController,
) -> Option<NetVehicleState> {
    let state = read_vehicle_chassis_state(sim, chassis_body)?;
    Some(make_net_vehicle_state(
        id,
        vehicle_type,
        flags,
        driver_id,
        state.position,
        state.quaternion,
        state.linear_velocity,
        state.angular_velocity,
        encode_vehicle_wheel_data(controller),
    ))
}

/// Compute the player exit position from the current chassis pose.
pub fn vehicle_exit_position(state: &VehicleChassisState) -> Vec3d {
    let rotation = UnitQuaternion::from_quaternion(Quaternion::new(
        state.quaternion[3],
        state.quaternion[0],
        state.quaternion[1],
        state.quaternion[2],
    ));
    let right = rotation * Vector3::x();
    let planar_right = Vector3::new(right.x, 0.0, right.z);
    let side_offset = if planar_right.norm_squared() > 0.0001 {
        planar_right.normalize() * VEHICLE_EXIT_SIDE_OFFSET_M
    } else {
        Vector3::new(VEHICLE_EXIT_SIDE_OFFSET_M, 0.0, 0.0)
    };

    Vec3d::new(
        (state.position[0] + side_offset.x) as f64,
        (state.position[1] + VEHICLE_EXIT_UP_OFFSET_M) as f64,
        (state.position[2] + side_offset.z) as f64,
    )
}

/// Upright a vehicle in-place while preserving its planar heading.
pub fn reset_vehicle_body(rb: &mut RigidBody) {
    let translation = *rb.translation();
    let rotation = *rb.rotation();
    let forward = rotation * Vector3::z();
    let planar_forward = Vector3::new(forward.x, 0.0, forward.z);
    let (yaw, forward_nudge) = if planar_forward.norm_squared() > 0.0001 {
        let n = planar_forward.normalize();
        (n.x.atan2(n.z), n * VEHICLE_RESET_FORWARD_M)
    } else {
        (0.0_f32, Vector3::new(0.0, 0.0, VEHICLE_RESET_FORWARD_M))
    };
    let upright = UnitQuaternion::from_axis_angle(&Vector3::y_axis(), yaw);

    rb.set_position(
        Isometry3::from_parts(
            nalgebra::Translation3::new(
                translation.x + forward_nudge.x,
                translation.y + VEHICLE_RESET_LIFT_M,
                translation.z + forward_nudge.z,
            ),
            upright,
        ),
        true,
    );
    rb.set_linvel(Vector3::zeros(), true);
    rb.set_angvel(Vector3::zeros(), true);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{BTN_FORWARD, BTN_RIGHT};
    use crate::movement::MoveConfig;
    use crate::protocol::InputCmd;
    use nalgebra::{DMatrix, Point3};
    const DT: f32 = 1.0 / 60.0;
    const POSITION_EPSILON_M: f32 = 0.05;
    const ROTATION_EPSILON_RAD: f32 = 0.05;

    struct VehicleRig {
        sim: SimWorld,
        pipeline: PhysicsPipeline,
        impulse_joints: ImpulseJointSet,
        multibody_joints: MultibodyJointSet,
        ccd_solver: CCDSolver,
        gravity: Vector3<f32>,
        chassis_body: RigidBodyHandle,
        chassis_collider: ColliderHandle,
        controller: DynamicRayCastVehicleController,
    }

    impl VehicleRig {
        fn new() -> Self {
            let mut sim = SimWorld::new(MoveConfig::default());
            sim.add_static_cuboid(
                Vector3::new(0.0, -0.5, 0.0),
                Vector3::new(200.0, 0.5, 200.0),
                0,
            );
            let (chassis_body, chassis_collider, controller) =
                create_vehicle_physics(&mut sim, Isometry3::translation(0.0, 1.2, 0.0));
            sim.rebuild_broad_phase();
            Self {
                sim,
                pipeline: PhysicsPipeline::new(),
                impulse_joints: ImpulseJointSet::new(),
                multibody_joints: MultibodyJointSet::new(),
                ccd_solver: CCDSolver::new(),
                gravity: Vector3::new(0.0, -20.0, 0.0),
                chassis_body,
                chassis_collider,
                controller,
            }
        }

        fn with_bump() -> Self {
            let mut rig = Self::new();
            rig.sim
                .add_static_cuboid(Vector3::new(0.0, 0.2, 12.0), Vector3::new(2.5, 0.2, 1.6), 1);
            rig.sim.rebuild_broad_phase();
            rig
        }

        fn with_flat_heightfield() -> Self {
            let mut sim = SimWorld::new(MoveConfig::default());
            sim.add_static_heightfield(
                Vector3::new(0.0, 0.0, 0.0),
                DMatrix::from_element(33, 33, 0.0),
                Vector3::new(512.0, 1.0, 512.0),
                0,
            );
            let (chassis_body, chassis_collider, controller) =
                create_vehicle_physics(&mut sim, Isometry3::translation(0.0, 1.2, 0.0));
            sim.rebuild_broad_phase();
            Self {
                sim,
                pipeline: PhysicsPipeline::new(),
                impulse_joints: ImpulseJointSet::new(),
                multibody_joints: MultibodyJointSet::new(),
                ccd_solver: CCDSolver::new(),
                gravity: Vector3::new(0.0, -20.0, 0.0),
                chassis_body,
                chassis_collider,
                controller,
            }
        }

        fn with_flat_trimesh() -> Self {
            let mut sim = SimWorld::new(MoveConfig::default());
            sim.add_static_trimesh(
                vec![
                    Point3::new(-256.0, 0.0, -256.0),
                    Point3::new(256.0, 0.0, -256.0),
                    Point3::new(-256.0, 0.0, 256.0),
                    Point3::new(256.0, 0.0, 256.0),
                ],
                vec![[0, 2, 1], [2, 3, 1]],
                0,
            );
            let (chassis_body, chassis_collider, controller) =
                create_vehicle_physics(&mut sim, Isometry3::translation(0.0, 1.2, 0.0));
            sim.rebuild_broad_phase();
            Self {
                sim,
                pipeline: PhysicsPipeline::new(),
                impulse_joints: ImpulseJointSet::new(),
                multibody_joints: MultibodyJointSet::new(),
                ccd_solver: CCDSolver::new(),
                gravity: Vector3::new(0.0, -20.0, 0.0),
                chassis_body,
                chassis_collider,
                controller,
            }
        }

        fn apply_input(&mut self, input: &InputCmd) {
            apply_vehicle_input_step(
                &mut self.sim,
                self.chassis_body,
                self.chassis_collider,
                &mut self.controller,
                input,
                DT,
            );
        }

        fn step_client_prediction(&mut self) {
            step_vehicle_dynamics(
                &mut self.sim,
                &self.gravity,
                &mut self.pipeline,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                &mut self.ccd_solver,
                &(),
                DT,
            );
        }

        fn step_client_prediction_with_vehicle_substeps(
            &mut self,
            input: &InputCmd,
            substeps: usize,
        ) {
            let substep_dt = DT / substeps as f32;
            for _ in 0..substeps {
                apply_vehicle_input_step(
                    &mut self.sim,
                    self.chassis_body,
                    self.chassis_collider,
                    &mut self.controller,
                    input,
                    substep_dt,
                );
                step_vehicle_dynamics(
                    &mut self.sim,
                    &self.gravity,
                    &mut self.pipeline,
                    &mut self.impulse_joints,
                    &mut self.multibody_joints,
                    &mut self.ccd_solver,
                    &(),
                    substep_dt,
                );
            }
        }

        fn step_server_reference(&mut self) {
            let substep_dt = DT / DYNAMIC_SUBSTEPS as f32;
            for _ in 0..DYNAMIC_SUBSTEPS {
                let mut params = self.sim.integration_parameters;
                params.dt = substep_dt;
                self.pipeline.step(
                    &self.gravity,
                    &params,
                    &mut self.sim.island_manager,
                    &mut self.sim.broad_phase,
                    &mut self.sim.narrow_phase,
                    &mut self.sim.rigid_bodies,
                    &mut self.sim.colliders,
                    &mut self.impulse_joints,
                    &mut self.multibody_joints,
                    &mut self.ccd_solver,
                    &(),
                    &(),
                );
            }
        }

        fn pose(&self) -> (Vector3<f32>, UnitQuaternion<f32>) {
            let body = self
                .sim
                .rigid_bodies
                .get(self.chassis_body)
                .expect("vehicle chassis body exists");
            (*body.translation(), *body.rotation())
        }

        fn grounded_wheels(&self) -> usize {
            self.controller
                .wheels()
                .iter()
                .filter(|wheel| wheel.raycast_info().is_in_contact)
                .count()
        }
    }

    fn scripted_input(tick: usize) -> InputCmd {
        let buttons = if tick < 150 {
            BTN_FORWARD
        } else if tick < 240 {
            BTN_FORWARD | BTN_RIGHT
        } else {
            0
        };
        InputCmd {
            seq: tick as u16,
            buttons,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    #[test]
    fn client_vehicle_prediction_matches_authoritative_substeps() {
        let mut client = VehicleRig::new();
        let mut server = VehicleRig::new();

        for tick in 0..300 {
            let input = scripted_input(tick);
            client.apply_input(&input);
            server.apply_input(&input);
            client.step_client_prediction();
            server.step_server_reference();
        }

        let (client_pos, client_rot) = client.pose();
        let (server_pos, server_rot) = server.pose();
        let position_delta = (client_pos - server_pos).norm();
        let rotation_delta = client_rot.angle_to(&server_rot);

        assert!(
            position_delta <= POSITION_EPSILON_M,
            "vehicle prediction drifted by {position_delta:.3}m (client={client_pos:?}, server={server_pos:?})"
        );
        assert!(
            rotation_delta <= ROTATION_EPSILON_RAD,
            "vehicle rotation drifted by {rotation_delta:.3}rad"
        );
    }

    #[test]
    fn client_vehicle_prediction_matches_authoritative_substeps_over_bump() {
        let mut client = VehicleRig::with_bump();
        let mut server = VehicleRig::with_bump();

        for tick in 0..300 {
            let input = scripted_input(tick);
            client.apply_input(&input);
            server.apply_input(&input);
            client.step_client_prediction();
            server.step_server_reference();
        }

        let (client_pos, client_rot) = client.pose();
        let (server_pos, server_rot) = server.pose();
        let position_delta = (client_pos - server_pos).norm();
        let rotation_delta = client_rot.angle_to(&server_rot);

        assert!(
            position_delta <= POSITION_EPSILON_M,
            "vehicle bump prediction drifted by {position_delta:.3}m (client={client_pos:?}, server={server_pos:?})"
        );
        assert!(
            rotation_delta <= ROTATION_EPSILON_RAD,
            "vehicle bump rotation drifted by {rotation_delta:.3}rad"
        );
    }

    #[test]
    fn vehicle_snapshot_helper_matches_rigidbody_state() {
        let mut rig = VehicleRig::new();
        let input = scripted_input(0);
        rig.apply_input(&input);
        rig.step_client_prediction();

        let snapshot =
            make_vehicle_snapshot(&rig.sim, 7, 0, 0, 1, rig.chassis_body, &rig.controller)
                .expect("vehicle snapshot");
        let state =
            read_vehicle_chassis_state(&rig.sim, rig.chassis_body).expect("vehicle chassis state");

        assert_eq!(snapshot.id, 7);
        assert_eq!(snapshot.driver_id, 1);
        assert_eq!(
            snapshot.px_mm,
            crate::unit_conv::meters_to_mm(state.position[0])
        );
        assert_eq!(
            snapshot.py_mm,
            crate::unit_conv::meters_to_mm(state.position[1])
        );
        assert_eq!(
            snapshot.pz_mm,
            crate::unit_conv::meters_to_mm(state.position[2])
        );
        assert_eq!(
            snapshot.vx_cms,
            crate::unit_conv::meters_to_cms_i16(state.linear_velocity[0])
        );
        assert_eq!(
            snapshot.vy_cms,
            crate::unit_conv::meters_to_cms_i16(state.linear_velocity[1])
        );
        assert_eq!(
            snapshot.vz_cms,
            crate::unit_conv::meters_to_cms_i16(state.linear_velocity[2])
        );
        assert_eq!(
            snapshot.wheel_data,
            encode_vehicle_wheel_data(&rig.controller)
        );
    }

    #[test]
    fn refreshing_vehicle_contacts_does_not_advance_vehicle_motion() {
        let mut rig = VehicleRig::new();
        let input = InputCmd {
            seq: 1,
            buttons: BTN_FORWARD,
            move_x: 0,
            move_y: 0,
            yaw: 0.0,
            pitch: 0.0,
        };

        rig.apply_input(&input);
        rig.step_client_prediction();

        let (before_pos, before_rot) = rig.pose();
        let before_linvel = *rig
            .sim
            .rigid_bodies
            .get(rig.chassis_body)
            .expect("vehicle chassis body exists")
            .linvel();

        refresh_vehicle_contacts(&mut rig.sim, rig.chassis_collider, &mut rig.controller);

        let (after_pos, after_rot) = rig.pose();
        let after_linvel = *rig
            .sim
            .rigid_bodies
            .get(rig.chassis_body)
            .expect("vehicle chassis body exists")
            .linvel();

        assert!(
            (after_pos - before_pos).norm() <= 0.0001,
            "contact refresh advanced chassis position by {:.6}m",
            (after_pos - before_pos).norm()
        );
        assert!(
            after_rot.angle_to(&before_rot) <= 0.0001,
            "contact refresh changed chassis rotation by {:.6}rad",
            after_rot.angle_to(&before_rot)
        );
        assert!(
            (after_linvel - before_linvel).norm() <= 0.0001,
            "contact refresh changed chassis velocity by {:.6}m/s",
            (after_linvel - before_linvel).norm()
        );
    }

    #[test]
    fn flat_drive_keeps_vehicle_supported_and_limits_heave() {
        let mut rig = VehicleRig::new();
        let mut grounded_samples = Vec::new();
        let mut y_samples = Vec::new();

        for tick in 0..300 {
            let input = if tick < 60 {
                InputCmd {
                    seq: tick as u16,
                    buttons: 0,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            } else {
                InputCmd {
                    seq: tick as u16,
                    buttons: BTN_FORWARD,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            };
            rig.step_client_prediction_with_vehicle_substeps(&input, 4);
            grounded_samples.push(rig.grounded_wheels());
            y_samples.push(rig.pose().0.y);
        }

        let drive_samples = &grounded_samples[120..];
        let min_grounded = *drive_samples.iter().min().unwrap_or(&0);
        let avg_grounded = drive_samples.iter().map(|count| *count as f32).sum::<f32>()
            / drive_samples.len() as f32;
        let drive_y_samples = &y_samples[120..];
        let min_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::INFINITY, f32::min);
        let max_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        let heave_span = max_y - min_y;

        assert!(
            min_grounded >= 2,
            "flat drive lost too much wheel contact: min_grounded={min_grounded}, avg_grounded={avg_grounded:.2}"
        );
        assert!(
            avg_grounded >= 3.0,
            "flat drive average grounded wheels too low: avg_grounded={avg_grounded:.2}, min_grounded={min_grounded}"
        );
        assert!(
            heave_span <= 0.35,
            "flat drive heave span too large: {heave_span:.3}m (min_y={min_y:.3}, max_y={max_y:.3})"
        );
    }

    #[test]
    fn flat_heightfield_drive_limits_contact_churn_and_heave() {
        let mut rig = VehicleRig::with_flat_heightfield();
        let mut grounded_samples = Vec::new();
        let mut y_samples = Vec::new();
        let mut contact_bits = Vec::new();

        for tick in 0..300 {
            let input = if tick < 60 {
                InputCmd {
                    seq: tick as u16,
                    buttons: 0,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            } else {
                InputCmd {
                    seq: tick as u16,
                    buttons: BTN_FORWARD,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            };
            rig.step_client_prediction_with_vehicle_substeps(&input, 4);
            grounded_samples.push(rig.grounded_wheels());
            y_samples.push(rig.pose().0.y);
            let bits =
                rig.controller
                    .wheels()
                    .iter()
                    .enumerate()
                    .fold(0u8, |mask, (index, wheel)| {
                        if wheel.raycast_info().is_in_contact {
                            mask | (1 << index)
                        } else {
                            mask
                        }
                    });
            contact_bits.push(bits);
        }

        let drive_samples = &grounded_samples[120..];
        let min_grounded = *drive_samples.iter().min().unwrap_or(&0);
        let avg_grounded = drive_samples.iter().map(|count| *count as f32).sum::<f32>()
            / drive_samples.len() as f32;
        let drive_y_samples = &y_samples[120..];
        let min_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::INFINITY, f32::min);
        let max_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        let heave_span = max_y - min_y;
        let contact_changes = contact_bits[121..]
            .iter()
            .zip(contact_bits[120..contact_bits.len() - 1].iter())
            .filter(|(curr, prev)| curr != prev)
            .count();

        assert!(
            min_grounded >= 3,
            "flat heightfield drive lost too much wheel contact: min_grounded={min_grounded}, avg_grounded={avg_grounded:.2}"
        );
        assert!(
            avg_grounded >= 3.5,
            "flat heightfield average grounded wheels too low: avg_grounded={avg_grounded:.2}, min_grounded={min_grounded}"
        );
        assert!(
            heave_span <= 0.2,
            "flat heightfield heave span too large: {heave_span:.3}m (min_y={min_y:.3}, max_y={max_y:.3})"
        );
        assert!(
            contact_changes <= 6,
            "flat heightfield contact bits changed too often: {contact_changes}"
        );
    }

    #[test]
    fn flat_trimesh_drive_keeps_vehicle_supported_and_limits_heave() {
        let mut rig = VehicleRig::with_flat_trimesh();
        let mut grounded_samples = Vec::new();
        let mut y_samples = Vec::new();

        for tick in 0..300 {
            let input = if tick < 60 {
                InputCmd {
                    seq: tick as u16,
                    buttons: 0,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            } else {
                InputCmd {
                    seq: tick as u16,
                    buttons: BTN_FORWARD,
                    move_x: 0,
                    move_y: 0,
                    yaw: 0.0,
                    pitch: 0.0,
                }
            };
            rig.apply_input(&input);
            rig.step_client_prediction();
            grounded_samples.push(rig.grounded_wheels());
            y_samples.push(rig.pose().0.y);
        }

        let drive_samples = &grounded_samples[120..];
        let min_grounded = *drive_samples.iter().min().unwrap_or(&0);
        let avg_grounded = drive_samples.iter().map(|count| *count as f32).sum::<f32>()
            / drive_samples.len() as f32;
        let drive_y_samples = &y_samples[120..];
        let min_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::INFINITY, f32::min);
        let max_y = drive_y_samples
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        let heave_span = max_y - min_y;

        assert!(
            min_grounded >= 3,
            "flat trimesh drive lost too much wheel contact: min_grounded={min_grounded}, avg_grounded={avg_grounded:.2}"
        );
        assert!(
            avg_grounded >= 3.5,
            "flat trimesh average grounded wheels too low: avg_grounded={avg_grounded:.2}, min_grounded={min_grounded}"
        );
        assert!(
            heave_span <= 0.2,
            "flat trimesh heave span too large: {heave_span:.3}m (min_y={min_y:.3}, max_y={max_y:.3})"
        );
    }
}
