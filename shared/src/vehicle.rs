/// Shared vehicle physics helpers used by both the server-side `PhysicsArena`
/// and the WASM client `WasmSimWorld`.
///
/// Keeping spawn logic and filter construction here ensures the two physics
/// worlds stay byte-for-byte identical — any tuning change made once is
/// automatically reflected in both.
use nalgebra::{point, Isometry3, Vector3};
use rapier3d::control::{DynamicRayCastVehicleController, WheelTuning};
use rapier3d::prelude::*;
use vibe_netcode::sim_world::SimWorld;

use crate::movement::{
    VEHICLE_CHASSIS_DENSITY, VEHICLE_FRICTION_SLIP, VEHICLE_SUSPENSION_DAMPING,
    VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_SUSPENSION_STIFFNESS, VEHICLE_SUSPENSION_TRAVEL,
    VEHICLE_WHEEL_RADIUS,
};

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
    let collider = ColliderBuilder::cuboid(0.9, 0.3, 1.8)
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
    for offset in [
        point![-0.9_f32, 0.0, 1.1],
        point![0.9_f32, 0.0, 1.1],
        point![-0.9_f32, 0.0, -1.1],
        point![0.9_f32, 0.0, -1.1],
    ] {
        controller.add_wheel(
            offset,
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
