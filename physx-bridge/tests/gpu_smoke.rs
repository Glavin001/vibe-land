#![cfg(feature = "gpu")]

use vibe_land_physx_bridge::{
    gpu_support_compiled, CapsulePlayerDesc, DynamicBoxDesc, DynamicSphereDesc, HeightfieldDesc,
    Pose, Quat, RaycastRequest, StaticBoxDesc, Vec3, VehicleChassisDesc, World, WorldConfig,
};

const ALL: u32 = u32::MAX;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::IDENTITY,
    }
}

#[test]
fn gpu_world_smoke_test_requires_real_cuda_scene() {
    assert!(gpu_support_compiled());
    let mut world = World::new(WorldConfig::default())
        .expect("feature `gpu` must fail here unless a real CUDA scene starts");

    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 101,
            pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(10.0, 0.5, 10.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 2,
            user_id: 102,
            pose: pose(-2.0, 3.0, 0.0),
            half_extents: Vec3::new(0.5, 0.5, 0.5),
            mass: 10.0,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_dynamic_sphere(DynamicSphereDesc {
            entity_id: 3,
            user_id: 103,
            pose: pose(0.0, 3.0, 0.0),
            radius: 0.5,
            mass: 5.0,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_heightfield(
            HeightfieldDesc {
                entity_id: 4,
                user_id: 104,
                pose: pose(20.0, 0.0, 0.0),
                rows: 2,
                columns: 2,
                height_scale: 0.01,
                row_scale: 1.0,
                column_scale: 1.0,
                friction: 0.6,
                restitution: 0.1,
                collision_group: 1,
                collision_mask: ALL,
            },
            &[0.0, 0.1, 0.0, 0.1],
        )
        .unwrap();
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 5,
            user_id: 105,
            position: Vec3::new(2.0, 2.0, 0.0),
            cylinder_height: 1.0,
            radius: 0.4,
            step_offset: 0.3,
            contact_offset: 0.05,
            slope_limit_radians: 0.785,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_vehicle_chassis(VehicleChassisDesc {
            entity_id: 6,
            user_id: 106,
            pose: pose(4.0, 2.0, 0.0),
            half_extents: Vec3::new(1.0, 0.4, 2.0),
            mass: 800.0,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 7,
            user_id: 107,
            pose: pose(8.0, 1.0, 0.0),
            half_extents: Vec3::new(2.0, 0.25, 2.0),
            mass: 100.0,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 8,
            user_id: 108,
            position: Vec3::new(8.0, 2.2, 0.0),
            cylinder_height: 1.0,
            radius: 0.4,
            step_offset: 0.3,
            contact_offset: 0.05,
            slope_limit_radians: 0.785,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();

    world.apply_impulse(3, Vec3::new(1.0, 0.0, 0.0)).unwrap();
    world.apply_impulse(7, Vec3::new(100.0, 0.0, 0.0)).unwrap();
    world.drive_vehicle(6, 1.0, 0.25, 0.0).unwrap();
    world.move_player(5, Vec3::new(0.0, -0.25, 0.0)).unwrap();
    for _ in 0..120 {
        world.move_player(8, Vec3::new(0.0, -0.01, 0.0)).unwrap();
        world.step().unwrap();
    }

    let hit = world
        .raycast(RaycastRequest {
            origin: Vec3::new(0.0, 10.0, 0.0),
            direction: Vec3::new(0.0, -1.0, 0.0),
            max_distance: 20.0,
            collision_mask: ALL,
            ignore_entity_id: 0,
            has_ignore_entity: false,
        })
        .unwrap();
    assert!(hit.hit);
    assert_ne!(hit.entity_id, 0);
    assert_eq!(world.body_snapshots().unwrap().len(), 6);
    let players = world.player_snapshots().unwrap();
    assert_eq!(players.len(), 2);
    let supported_player = players.iter().find(|player| player.entity_id == 8).unwrap();
    assert!(supported_player.has_support);
    assert_eq!(supported_player.support_entity_id, 7);
    assert!(
        supported_player.pose.position.x > 8.25,
        "CCT should ride a moving dynamic support"
    );
    let impulse_body = world
        .body_snapshots()
        .unwrap()
        .into_iter()
        .find(|body| body.entity_id == 3)
        .unwrap();
    world
        .apply_impulse_at_point(
            3,
            Vec3::new(0.0, 0.0, 10.0),
            Vec3::new(
                impulse_body.pose.position.x + 0.5,
                impulse_body.pose.position.y,
                impulse_body.pose.position.z,
            ),
        )
        .unwrap();
    world.step().unwrap();
    let impulse_body = world
        .body_snapshots()
        .unwrap()
        .into_iter()
        .find(|body| body.entity_id == 3)
        .unwrap();
    assert!(
        impulse_body.angular_velocity.y.abs() > 0.01,
        "off-center impulses should preserve torque"
    );
    assert_eq!(world.vehicle_snapshots().unwrap().len(), 1);
    assert_eq!(world.stats().unwrap().completed_steps, 121);
    assert!(
        world
            .wake_bodies_near(Vec3::new(0.0, 1.0, 0.0), 5.0)
            .unwrap()
            >= 1,
        "nearby dynamic bodies should be woken after topology edits"
    );
    assert!(
        !world.take_contact_events().unwrap().is_empty(),
        "thresholded contact reports should be available for stress damage"
    );

    world.set_user_id(3, 999).unwrap();
    assert!(world
        .body_snapshots()
        .unwrap()
        .iter()
        .any(|body| body.entity_id == 3 && body.user_id == 999));
    world.remove_actor(2).unwrap();
}

#[test]
fn cct_push_keeps_light_ball_at_realistic_speed() {
    assert!(gpu_support_compiled());
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");

    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 1,
            pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(20.0, 0.5, 20.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();

    // Match the authored pit ball and gameplay CCT dimensions. Constrained
    // capsule climbing must turn this into a side hit rather than stepping
    // over the dynamic sphere.
    let ball_radius: f32 = 0.3;
    let ball_mass = 4.0 / 3.0 * std::f32::consts::PI * ball_radius.powi(3);
    world
        .add_dynamic_sphere(DynamicSphereDesc {
            entity_id: 2,
            user_id: 2,
            pose: pose(1.0, ball_radius, 0.0),
            radius: ball_radius,
            mass: ball_mass.max(0.1),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 3,
            user_id: 3,
            position: Vec3::new(0.0, 1.0, 0.0),
            cylinder_height: 0.9,
            radius: 0.35,
            step_offset: 0.55,
            contact_offset: 0.01,
            slope_limit_radians: 0.785,
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();

    // Settle, then walk into the ball at ~6 m/s for several ticks.
    for _ in 0..30 {
        world.move_player(3, Vec3::new(0.0, -0.02, 0.0)).unwrap();
        world.step().unwrap();
    }
    let mut peak_speed = 0.0_f32;
    for _ in 0..45 {
        world.move_player(3, Vec3::new(0.1, -0.01, 0.0)).unwrap();
        world.step().unwrap();
        let ball = world
            .body_snapshots()
            .unwrap()
            .into_iter()
            .find(|body| body.entity_id == 2)
            .expect("ball snapshot");
        let speed = (ball.linear_velocity.x.powi(2)
            + ball.linear_velocity.y.powi(2)
            + ball.linear_velocity.z.powi(2))
        .sqrt();
        peak_speed = peak_speed.max(speed);
    }

    let ball = world
        .body_snapshots()
        .unwrap()
        .into_iter()
        .find(|body| body.entity_id == 2)
        .expect("ball snapshot");
    let speed = (ball.linear_velocity.x.powi(2)
        + ball.linear_velocity.y.powi(2)
        + ball.linear_velocity.z.powi(2))
    .sqrt();
    assert!(
        ball.pose.position.y > -1.0 && ball.pose.position.y < 4.0,
        "ball should stay near the floor, got y={}",
        ball.pose.position.y
    );
    assert!(
        ball.pose.position.x.abs() < 12.0 && ball.pose.position.z.abs() < 12.0,
        "ball should not be launched off the arena, got ({}, {})",
        ball.pose.position.x,
        ball.pose.position.z
    );
    assert!(
        peak_speed < 12.0,
        "light-ball CCT push should stay realistic, got peak speed={peak_speed}"
    );
    assert!(
        peak_speed > 0.5 && (ball.pose.position.x > 1.15 || speed > 0.05),
        "walking into an authored-size ball should move it; peak={peak_speed}, x={}",
        ball.pose.position.x
    );
}

#[test]
fn multiple_gpu_worlds_share_one_process_runtime() {
    let config = WorldConfig::default();
    let mut first = World::new(config).expect("first GPU scene should initialize");
    let mut second =
        World::new(WorldConfig::default()).expect("second GPU scene should share PxFoundation");

    for (world, entity_offset) in [(&mut first, 0_u32), (&mut second, 100_u32)] {
        world
            .add_static_box(StaticBoxDesc {
                entity_id: entity_offset + 1,
                user_id: entity_offset + 1,
                pose: pose(0.0, -0.5, 0.0),
                half_extents: Vec3::new(4.0, 0.5, 4.0),
                collision_group: 1,
                collision_mask: ALL,
            })
            .unwrap();
        world
            .add_dynamic_sphere(DynamicSphereDesc {
                entity_id: entity_offset + 2,
                user_id: entity_offset + 2,
                pose: pose(0.0, 2.0, 0.0),
                radius: 0.5,
                mass: 2.0,
                collision_group: 1,
                collision_mask: ALL,
            })
            .unwrap();
        world.step().unwrap();
    }

    assert_eq!(first.stats().unwrap().completed_steps, 1);
    assert_eq!(second.stats().unwrap().completed_steps, 1);
}
