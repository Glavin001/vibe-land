/// Shared vehicle physics helpers used by both the server-side `PhysicsArena`
/// and the WASM client `WasmSimWorld`.
///
/// Keeping spawn logic and filter construction here ensures the two physics
/// worlds stay byte-for-byte identical — any tuning change made once is
/// automatically reflected in both.
use nalgebra::{point, Isometry3, UnitQuaternion, Vector3};
use rapier3d::control::{DynamicRayCastVehicleController, WheelTuning};
use rapier3d::prelude::*;
use vibe_netcode::sim_world::SimWorld;
use vibe_netcode::physics_arena::DYNAMIC_SUBSTEPS;

use crate::movement::{
    VEHICLE_CHASSIS_DENSITY, VEHICLE_FRICTION_SLIP, VEHICLE_SUSPENSION_DAMPING,
    VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_SUSPENSION_STIFFNESS, VEHICLE_SUSPENSION_TRAVEL,
    VEHICLE_WHEEL_RADIUS,
};

pub const VEHICLE_CHASSIS_HALF_EXTENTS: [f32; 3] = [0.9, 0.3, 1.8];
pub const VEHICLE_WHEEL_OFFSETS: [[f32; 3]; 4] = [
    [-0.9, 0.0, 1.1],
    [0.9, 0.0, 1.1],
    [-0.9, 0.0, -1.1],
    [0.9, 0.0, -1.1],
];
const VEHICLE_RESET_LIFT_M: f32 = 1.0;

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

/// Step the vehicle rigid-body pipeline for one client prediction tick.
pub fn step_vehicle_dynamics(
    sim: &mut SimWorld,
    gravity: &Vector3<f32>,
    pipeline: &mut PhysicsPipeline,
    impulse_joints: &mut ImpulseJointSet,
    multibody_joints: &mut MultibodyJointSet,
    ccd_solver: &mut CCDSolver,
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
            &(),
        );
    }
}

/// Upright a vehicle in-place while preserving its planar heading.
pub fn reset_vehicle_body(rb: &mut RigidBody) {
    let translation = *rb.translation();
    let rotation = *rb.rotation();
    let forward = rotation * Vector3::z();
    let planar_forward = Vector3::new(forward.x, 0.0, forward.z);
    let yaw = if planar_forward.norm_squared() > 0.0001 {
        planar_forward.x.atan2(planar_forward.z)
    } else {
        0.0
    };
    let upright = UnitQuaternion::from_axis_angle(&Vector3::y_axis(), yaw);

    rb.set_position(
        Isometry3::from_parts(
            nalgebra::Translation3::new(
                translation.x,
                translation.y + VEHICLE_RESET_LIFT_M,
                translation.z,
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
    use crate::movement::{vehicle_wheel_params, MoveConfig};
    use crate::protocol::InputCmd;
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
            let (chassis_body, chassis_collider, controller) = create_vehicle_physics(
                &mut sim,
                Isometry3::translation(0.0, 1.2, 0.0),
            );
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
            let (steering, engine_force, brake) = vehicle_wheel_params(input);
            for (index, wheel) in self.controller.wheels_mut().iter_mut().enumerate() {
                if index < 2 {
                    wheel.steering = steering;
                }
                wheel.engine_force = if index >= 2 { engine_force } else { 0.0 };
                wheel.brake = brake;
            }

            let filter = vehicle_suspension_filter(self.chassis_collider);
            let queries = self.sim.broad_phase.as_query_pipeline_mut(
                self.sim.narrow_phase.query_dispatcher(),
                &mut self.sim.rigid_bodies,
                &mut self.sim.colliders,
                filter,
            );
            self.controller.update_vehicle(DT, queries);
        }

        fn step_client_prediction(&mut self) {
            step_vehicle_dynamics(
                &mut self.sim,
                &self.gravity,
                &mut self.pipeline,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                &mut self.ccd_solver,
                DT,
            );
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
}
