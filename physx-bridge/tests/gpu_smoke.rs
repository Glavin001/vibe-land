#![cfg(feature = "gpu")]

use vibe_land_physx_bridge::{
    gpu_support_compiled, CapsulePlayerDesc, DynamicBoxDesc, DynamicSphereDesc, HeightfieldDesc,
    Pose, Quat, RaycastRequest, StaticBoxDesc, Vec3, VehicleDesc, VehicleCommands, World, WorldConfig,
};

const ALL: u32 = u32::MAX;
const VEHICLE_GROUP: u32 = 1 << 3;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::IDENTITY,
    }
}

/// The shared city car: a 600 kg box on four sweeps.
fn smoke_vehicle(entity_id: u32, user_id: u32, pose: Pose) -> VehicleDesc {
    VehicleDesc {
        entity_id,
        user_id,
        pose,
        chassis_half_extents: Vec3::new(0.9, 0.3, 1.8),
        mass: 600.0,
        inertia: Vec3::new(0.0, 0.0, 0.0),
        half_track: 0.9,
        suspension_attachment_y: -0.17,
        front_axle_z: 1.1,
        rear_axle_z: -1.1,
        suspension_travel: 0.2,
        suspension_stiffness: 22_000.0,
        suspension_damping: 3_600.0,
        wheel_radius: 0.35,
        wheel_half_width: 0.15,
        tyre_friction: 1.5,
        front_lateral_stiffness: 0.0,
        rear_lateral_stiffness: 0.0,
        longitudinal_stiffness: 0.0,
        com_offset_y: 0.0,
        angular_damping: 0.0,
        max_steer_radians: 0.5,
        drive_torque: 1_400.0,
        brake_torque: 700.0,
        handbrake_torque: 1_400.0,
        top_speed: 40.0,
        rear_wheel_drive: true,
        sweep_road_queries: true,
        // Its own group, and a road mask without it: the chassis answers
        // scene queries, and the wheels must not stand on their own car.
        road_mask: ALL & !VEHICLE_GROUP,
        collision_group: VEHICLE_GROUP,
        collision_mask: ALL,
    }
}

/// The city car as the server tunes it: all four wheels driven at about half
/// of what a tyre can transmit, tyre stiffness scaled to the 150 kg on each
/// corner, the centre of mass 20 cm below the chassis centre, a little
/// angular damping. The numbers mirror server/src/physx_runtime.rs.
fn tuned_vehicle(entity_id: u32, user_id: u32, pose: Pose) -> VehicleDesc {
    let rest_load = 150.0 * 9.81;
    VehicleDesc {
        tyre_friction: 1.4,
        front_lateral_stiffness: 28.0 * rest_load,
        rear_lateral_stiffness: 32.0 * rest_load,
        longitudinal_stiffness: 12.0 * rest_load,
        com_offset_y: -0.2,
        angular_damping: 0.5,
        drive_torque: 450.0,
        brake_torque: 900.0,
        handbrake_torque: 1_800.0,
        top_speed: 30.0,
        rear_wheel_drive: false,
        ..smoke_vehicle(entity_id, user_id, pose)
    }
}

/// Body-frame reading of a vehicle snapshot: forward speed, lateral speed,
/// the slip angle between where the car points and where it goes, yaw rate,
/// and how upright it is.
struct Motion {
    forward: f32,
    slip_deg: f32,
    yaw_rate: f32,
    up: f32,
}

fn motion(snapshot: &vibe_land_physx_bridge::VehicleSnapshot) -> Motion {
    let q = snapshot.pose.rotation;
    let rotate = |v: [f32; 3]| -> [f32; 3] {
        // q * v * q^-1 for a unit quaternion.
        let (x, y, z, w) = (q.x, q.y, q.z, q.w);
        let (vx, vy, vz) = (v[0], v[1], v[2]);
        let tx = 2.0 * (y * vz - z * vy);
        let ty = 2.0 * (z * vx - x * vz);
        let tz = 2.0 * (x * vy - y * vx);
        [
            vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx),
        ]
    };
    let fwd = rotate([0.0, 0.0, 1.0]);
    let right = rotate([-1.0, 0.0, 0.0]);
    let up = rotate([0.0, 1.0, 0.0]);
    let v = snapshot.linear_velocity;
    let forward = v.x * fwd[0] + v.y * fwd[1] + v.z * fwd[2];
    let lateral = v.x * right[0] + v.y * right[1] + v.z * right[2];
    Motion {
        forward,
        slip_deg: lateral.abs().atan2(forward.abs()).to_degrees(),
        yaw_rate: snapshot.angular_velocity.y,
        up: up[1],
    }
}

/// Drive one car through a scripted command sequence on a big slab and
/// return the worst slip angle and yaw rate seen once it is moving, the
/// lowest "upright" value, the mean yaw rate over the steering window and
/// the peak forward speed.
struct Handling {
    max_slip_deg: f32,
    max_yaw_rate: f32,
    min_up: f32,
    mean_steered_yaw_rate: f32,
    peak_speed: f32,
}

fn drive(desc: VehicleDesc, commands: impl Fn(u32) -> VehicleCommands, ticks: u32) -> Handling {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 101,
            pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(400.0, 0.5, 400.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world.add_vehicle(desc).unwrap();
    let mut out = Handling {
        max_slip_deg: 0.0,
        max_yaw_rate: 0.0,
        min_up: 1.0,
        mean_steered_yaw_rate: 0.0,
        peak_speed: 0.0,
    };
    let mut steered_ticks = 0u32;
    for tick in 0..ticks {
        let cmd = commands(tick);
        world.drive_vehicle(6, cmd).unwrap();
        world.step().unwrap();
        let m = motion(&world.vehicle_snapshots().unwrap()[0]);
        out.min_up = out.min_up.min(m.up);
        out.peak_speed = out.peak_speed.max(m.forward);
        if m.forward.abs() > 3.0 {
            out.max_slip_deg = out.max_slip_deg.max(m.slip_deg);
            out.max_yaw_rate = out.max_yaw_rate.max(m.yaw_rate.abs());
        }
        if cmd.steer != 0.0 {
            out.mean_steered_yaw_rate += m.yaw_rate.abs();
            steered_ticks += 1;
        }
    }
    if steered_ticks > 0 {
        out.mean_steered_yaw_rate /= steered_ticks as f32;
    }
    out
}

/// Full throttle held from rest with a third of the steering from one second
/// in. Under the old rear-drive tune the drive torque alone exceeded what the
/// rear tyres could transmit, so they spun permanently; a spinning tyre has
/// no lateral grip and the first steer input swung the tail out. On the
/// tuned car the drive leaves most of the lateral grip in place and the car
/// simply turns.
#[test]
fn tuned_vehicle_turns_under_full_throttle_without_spinning_out() {
    let script = |tick: u32| VehicleCommands {
        throttle: 1.0,
        steer: if tick >= 60 { 0.3 } else { 0.0 },
        ..VehicleCommands::default()
    };
    let tuned = drive(tuned_vehicle(6, 106, pose(0.0, 0.7, 0.0)), script, 180);
    eprintln!(
        "tuned: slip {:.1} deg, yaw {:.2} rad/s, mean steered yaw {:.2}, up {:.2}, peak {:.1} m/s",
        tuned.max_slip_deg, tuned.max_yaw_rate, tuned.mean_steered_yaw_rate, tuned.min_up, tuned.peak_speed
    );
    assert!(tuned.max_slip_deg < 25.0, "the tuned car slid sideways: {:.1} deg", tuned.max_slip_deg);
    assert!(tuned.max_yaw_rate < 1.2, "the tuned car spun: {:.2} rad/s", tuned.max_yaw_rate);
    assert!(tuned.mean_steered_yaw_rate > 0.25, "the tuned car did not turn: {:.2} rad/s", tuned.mean_steered_yaw_rate);
    assert!(tuned.min_up > 0.9, "the tuned car rolled: up {:.2}", tuned.min_up);
    // Still a quick car: 15 m/s inside two seconds of full throttle.
    let launch = drive(tuned_vehicle(6, 106, pose(0.0, 0.7, 0.0)), |_| VehicleCommands { throttle: 1.0, ..VehicleCommands::default() }, 120);
    assert!(launch.peak_speed > 15.0, "the tuned car is slow: {:.1} m/s after 2 s", launch.peak_speed);

    // The control: the old tune under the same script. Its slip angle is the
    // spin-out the driver reported.
    let old = drive(smoke_vehicle(6, 106, pose(0.0, 0.7, 0.0)), script, 180);
    eprintln!("old rear-drive: slip {:.1} deg, yaw {:.2} rad/s, peak {:.1} m/s", old.max_slip_deg, old.max_yaw_rate, old.peak_speed);
    assert!(old.max_slip_deg > tuned.max_slip_deg + 10.0,
        "the old tune no longer slides more than the new one ({:.1} vs {:.1} deg); the friction-circle explanation needs revisiting",
        old.max_slip_deg, tuned.max_slip_deg);
}

/// The brake pedal at 15 m/s: the tyres, not the pads, are the limit.
#[test]
fn tuned_vehicle_brakes_at_the_tyre_limit() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 101,
            pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(400.0, 0.5, 400.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    world.add_vehicle(tuned_vehicle(6, 106, pose(0.0, 0.7, 0.0))).unwrap();
    let mut speed_at_brake = 0.0;
    for tick in 0..150 {
        let braking = tick >= 120;
        world
            .drive_vehicle(6, VehicleCommands { throttle: if braking { 0.0 } else { 1.0 }, brake: if braking { 1.0 } else { 0.0 }, ..VehicleCommands::default() })
            .unwrap();
        world.step().unwrap();
        if tick == 119 {
            speed_at_brake = motion(&world.vehicle_snapshots().unwrap()[0]).forward;
        }
    }
    let after = motion(&world.vehicle_snapshots().unwrap()[0]).forward;
    let decel = (speed_at_brake - after) / 0.5;
    eprintln!("brake: {speed_at_brake:.1} -> {after:.1} m/s in 0.5 s, {decel:.1} m/s^2");
    assert!(speed_at_brake > 14.0, "not up to speed: {speed_at_brake:.1}");
    assert!(decel > 8.0, "the brakes are weak: {decel:.1} m/s^2");
}

/// Full lock at street speed turns tightly, and full lock at 20 m/s (what a
/// raw command can still ask for; the server narrows the lock with speed)
/// neither rolls the car nor spins it.
#[test]
fn tuned_vehicle_corners_hard_and_stays_on_its_wheels() {
    // ~8 m/s: throttle up, then hold a quarter throttle and full lock.
    let street = drive(
        tuned_vehicle(6, 106, pose(0.0, 0.7, 0.0)),
        |tick| VehicleCommands {
            throttle: if tick < 55 { 1.0 } else { 0.25 },
            steer: if tick >= 55 { 1.0 } else { 0.0 },
            ..VehicleCommands::default()
        },
        175,
    );
    eprintln!(
        "street: mean steered yaw {:.2} rad/s, slip {:.1} deg, up {:.2}, peak {:.1} m/s",
        street.mean_steered_yaw_rate, street.max_slip_deg, street.min_up, street.peak_speed
    );
    assert!(street.mean_steered_yaw_rate > 0.9, "full lock at street speed is too lazy: {:.2} rad/s", street.mean_steered_yaw_rate);
    assert!(street.min_up > 0.9, "rolled at street speed: up {:.2}", street.min_up);

    let fast = drive(
        tuned_vehicle(6, 106, pose(0.0, 0.7, 0.0)),
        |tick| VehicleCommands {
            throttle: if tick < 210 { 1.0 } else { 0.0 },
            steer: if tick >= 210 { 1.0 } else { 0.0 },
            ..VehicleCommands::default()
        },
        300,
    );
    eprintln!(
        "fast: peak {:.1} m/s, slip {:.1} deg, yaw {:.2} rad/s, up {:.2}",
        fast.peak_speed, fast.max_slip_deg, fast.max_yaw_rate, fast.min_up
    );
    assert!(fast.peak_speed > 18.0, "never reached highway speed: {:.1} m/s", fast.peak_speed);
    assert!(fast.min_up > 0.8, "rolled in the fast swerve: up {:.2}", fast.min_up);
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
    world.add_vehicle(smoke_vehicle(6, 106, pose(4.0, 0.7, 0.0))).unwrap();
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
    world
        .drive_vehicle(
            6,
            VehicleCommands {
                // A third throttle, straight: this is a 13 m/s^2 car and two
                // seconds of full throttle takes it off the 20 m ground slab.
                throttle: 0.35,
                steer: 0.0,
                ..VehicleCommands::default()
            },
        )
        .unwrap();
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
    assert_eq!(supported_player.support_entity_id, 7, "players={players:?}; bodies={:?}", world.body_snapshots().unwrap());
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
    let vehicles = world.vehicle_snapshots().unwrap();
    assert_eq!(vehicles.len(), 1);
    // Driven for two seconds on the ground: it moved, and every wheel's road
    // query found the ground.
    assert!(vehicles[0].pose.position.z > 4.0 && vehicles[0].pose.position.z < 10.0,
        "the vehicle did not drive straight ahead: {:?}", vehicles[0].pose);
    assert_eq!(vehicles[0].wheels_on_road, 0b1111);
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


#[test]
fn force_threshold_sums_loads_across_static_supports() {
    let mut config = WorldConfig::default();
    config.contact_report_threshold = 75.0;
    let mut world = World::new(config).expect("GPU scene");
    for (entity_id, x) in [(1, -0.75), (2, 0.75)] {
        world.add_static_box(StaticBoxDesc {
            entity_id,
            user_id: entity_id,
            pose: pose(x, -0.5, 0.0),
            half_extents: Vec3::new(0.5, 0.5, 2.0),
            collision_group: 1,
            collision_mask: ALL,
        }).unwrap();
    }
    world.add_dynamic_box(DynamicBoxDesc {
        entity_id: 3,
        user_id: 3,
        pose: pose(0.0, 0.5, 0.0),
        half_extents: Vec3::new(1.5, 0.5, 0.5),
        mass: 10.0,
        collision_group: 1,
        collision_mask: ALL,
    }).unwrap();
    let mut distributed_reports = 0;
    for _ in 0..16 {
        world.step().unwrap();
        let events = world.take_contact_events().unwrap();
        if events.len() == 2 {
            let impulse_limit = config.contact_report_threshold / 60.0;
            let impulses: Vec<_> = events.iter().map(|event| event.impulse.y.abs()).collect();
            if impulses.iter().all(|impulse| *impulse < impulse_limit)
                && impulses.iter().sum::<f32>() > impulse_limit
            {
                assert!(events.iter().any(|e| e.entity_a == 1 || e.entity_b == 1));
                assert!(events.iter().any(|e| e.entity_a == 2 || e.entity_b == 2));
                distributed_reports += 1;
            }
        }
    }
    assert!(distributed_reports > 0,
        "both supports must report a distributed load that exceeds the threshold only in aggregate");
}
