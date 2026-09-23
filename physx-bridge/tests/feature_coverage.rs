#![cfg(feature = "gpu")]

//! The PhysX features the game relies on that no other runnable test reached:
//! heightfield contact (rigid bodies, the character controller, the vehicle),
//! the vehicle's suspension-limit constraint row, a car driven over dynamic
//! debris, and teleports. The PhysX fork's native_feature_reference_test holds
//! the same features against the CPU pipeline, sticky tyres included.
//!
//! Written for the Metal port, where each of these runs kernels the demos never
//! launched, and kept platform-neutral so Linux + CUDA runs them too. Every
//! test also requires that PhysX reported no error while it ran: a kernel the
//! GPU cannot launch is logged, not raised, and the scene simply carries on
//! without it -- which is exactly how a missing constraint row looks like a
//! working car. The error counter is per process, so run this file with
//! `--test-threads=1` to keep one test's errors out of another's count.

use vibe_land_physx_bridge::{
    CapsulePlayerDesc, DynamicBoxDesc, DynamicSphereDesc, HeightfieldDesc, LaunchedBallDesc, Pose,
    Quat, StaticBoxDesc, Vec3, VehicleCommands, VehicleDesc, World, WorldConfig,
};

const ALL: u32 = u32::MAX;
const VEHICLE_GROUP: u32 = 1 << 3;
const TERRAIN_ID: u32 = 4;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose { position: Vec3::new(x, y, z), rotation: Quat::IDENTITY }
}

/// Fails the test if PhysX reported any error between construction and drop.
struct NoPhysxErrors {
    before: u32,
}

impl NoPhysxErrors {
    fn new(world: &World) -> Self {
        Self { before: world.stats().expect("stats").gpu_warning_count }
    }

    fn check(&self, world: &World, what: &str) {
        let after = world.stats().expect("stats").gpu_warning_count;
        assert_eq!(after, self.before, "PhysX reported {} error(s) during {what}", after - self.before);
    }
}

/// A square heightfield `side` metres across, centred on the origin, sampled
/// from `height(x, z)` in world metres.
fn terrain(world: &mut World, side: f32, samples_per_side: u32, height: impl Fn(f32, f32) -> f32) {
    let n = samples_per_side;
    let step = side / (n - 1) as f32;
    let origin = -side * 0.5;
    let mut samples = Vec::with_capacity((n * n) as usize);
    // Rows run along x and columns along z.
    for row in 0..n {
        for column in 0..n {
            samples.push(height(origin + row as f32 * step, origin + column as f32 * step));
        }
    }
    world
        .add_heightfield(
            HeightfieldDesc {
                entity_id: TERRAIN_ID,
                user_id: 104,
                pose: pose(origin, 0.0, origin),
                rows: n,
                columns: n,
                height_scale: 0.001,
                row_scale: step,
                column_scale: step,
                friction: 0.8,
                restitution: 0.05,
                collision_group: 1,
                collision_mask: ALL,
            },
            &samples,
        )
        .expect("heightfield");
}

/// A bowl: things placed in it end up at the bottom and stay on the surface.
fn bowl(x: f32, z: f32) -> f32 {
    0.02 * (x * x + z * z)
}

fn body(world: &World, id: u32) -> vibe_land_physx_bridge::BodySnapshot {
    world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == id).expect("body")
}

fn speed(v: Vec3) -> f32 {
    (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
}

/// A box, a sphere and a fast launched ball dropped into a heightfield bowl
/// stay on its surface -- no tunnelling at any tick -- and the box comes to
/// rest. The box's landing is reported as a contact with the terrain.
#[test]
fn rigid_shapes_collide_with_and_rest_on_a_heightfield() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    terrain(&mut world, 32.0, 33, bowl);
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 10, user_id: 110, pose: pose(-4.0, bowl(-4.0, 3.0) + 3.0, 3.0),
            half_extents: Vec3::new(0.5, 0.5, 0.5), mass: 50.0, collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    world
        .add_dynamic_sphere(DynamicSphereDesc {
            entity_id: 11, user_id: 111, pose: pose(5.0, bowl(5.0, -2.0) + 3.0, -2.0),
            radius: 0.5, mass: 20.0, collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    world
        .launch_dynamic_ball(LaunchedBallDesc {
            entity_id: 12, user_id: 112, pose: pose(0.0, 1.5, -6.0),
            radius: 0.4, mass: 30.0, linear_velocity: Vec3::new(0.0, -10.0, 6.0),
            collision_group: 1, collision_mask: ALL,
        })
        .unwrap();

    let mut box_hit_terrain = false;
    for tick in 0..300 {
        world.step().unwrap();
        for event in world.take_contact_events().unwrap() {
            let pair = (event.entity_a, event.entity_b);
            box_hit_terrain |= pair == (10, TERRAIN_ID) || pair == (TERRAIN_ID, 10);
        }
        for (id, radius) in [(10u32, 0.5f32), (11, 0.5), (12, 0.4)] {
            let p = body(&world, id).pose.position;
            let floor = bowl(p.x, p.z);
            // A 12 m/s ball can sink up to one frame's travel into the surface
            // before the contact pushes it back; tunnelling is its centre going
            // under the surface.
            assert!(
                p.y > floor + radius * 0.25,
                "body {id} tunnelled into the heightfield at tick {tick}: y {:.2}, surface {floor:.2}",
                p.y
            );
            assert!(p.x.abs() < 16.0 && p.z.abs() < 16.0, "body {id} left the bowl at tick {tick}: {p:?}");
        }
    }
    let resting = body(&world, 10);
    let p = resting.pose.position;
    assert!(
        p.y < bowl(p.x, p.z) + 0.9,
        "the box is not resting on the surface: y {:.2}, surface {:.2}",
        p.y,
        bowl(p.x, p.z)
    );
    assert!(speed(resting.linear_velocity) < 0.3, "the box never came to rest: {:?}", resting.linear_velocity);
    assert!(box_hit_terrain, "the box's landing on the heightfield was not reported");
    guard.check(&world, "heightfield contact");
}

/// A player walks up a 20 % heightfield ramp, keeps its footing on the terrain
/// and ends up where the ramp says it should be.
#[test]
fn a_player_walks_up_a_heightfield_ramp() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    let ramp = |x: f32, _z: f32| 0.2 * (x + 16.0);
    terrain(&mut world, 32.0, 33, ramp);
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 20, user_id: 120, position: Vec3::new(-12.0, ramp(-12.0, 0.0) + 1.5, 0.0),
            cylinder_height: 1.0, radius: 0.4, step_offset: 0.3, contact_offset: 0.05,
            slope_limit_radians: 0.785, collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    for _ in 0..30 {
        world.move_player(20, Vec3::new(0.0, -0.2, 0.0)).unwrap();
        world.step().unwrap();
    }
    for _ in 0..120 {
        // 6 m/s uphill plus gravity's pull.
        world.move_player(20, Vec3::new(0.1, -0.1, 0.0)).unwrap();
        world.step().unwrap();
    }
    let player = world.player_snapshots().unwrap().into_iter().find(|p| p.entity_id == 20).unwrap();
    let p = player.pose.position;
    // 12 m asked for; the controller loses some of it to the slope.
    assert!(p.x > -6.0, "the player did not climb the ramp: x {:.2}", p.x);
    let surface = ramp(p.x, p.z);
    // Capsule centre: half the cylinder plus the radius above the ground.
    assert!(
        (p.y - (surface + 0.9)).abs() < 0.35,
        "the player is not standing on the ramp: y {:.2}, surface {surface:.2}",
        p.y
    );
    assert!(player.has_support && player.support_entity_id == TERRAIN_ID, "no footing on the terrain: {player:?}");
    guard.check(&world, "a player on a heightfield");
}

/// The city car as the server tunes it (mirrors server/src/physx_runtime.rs).
fn city_car(entity_id: u32, pose: Pose) -> VehicleDesc {
    let rest_load = 150.0 * 9.81;
    VehicleDesc {
        entity_id,
        user_id: 100 + entity_id,
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
        tyre_friction: 1.4,
        front_lateral_stiffness: 28.0 * rest_load,
        rear_lateral_stiffness: 32.0 * rest_load,
        longitudinal_stiffness: 12.0 * rest_load,
        com_offset_y: -0.2,
        angular_damping: 0.5,
        max_steer_radians: 0.5,
        drive_torque: 450.0,
        brake_torque: 900.0,
        handbrake_torque: 1_800.0,
        top_speed: 30.0,
        rear_wheel_drive: false,
        sweep_road_queries: true,
        road_mask: ALL & !VEHICLE_GROUP,
        collision_group: VEHICLE_GROUP,
        collision_mask: ALL,
    }
}

fn slab(world: &mut World, rotation: Quat) {
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1, user_id: 101,
            pose: Pose { position: Vec3::new(0.0, -0.5, 0.0), rotation },
            half_extents: Vec3::new(100.0, 0.5, 100.0),
            collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
}

/// A car dropped from 6 m lands on its suspension limit rather than through
/// it. The limit is a constraint row the GPU solver applies; the spring alone
/// cannot stop this fall, so without the row the wheels travel past full
/// compression and the chassis box rides down onto the ground (centre 0.3 m).
/// Fully compressed, the chassis centre sits at wheel radius plus the
/// attachment offset, 0.52 m.
#[test]
fn a_hard_landing_stops_at_the_suspension_limit() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    slab(&mut world, Quat::IDENTITY);
    world.add_vehicle(city_car(6, pose(0.0, 6.7, 0.0))).unwrap();
    let mut lowest = f32::MAX;
    for _ in 0..240 {
        world.drive_vehicle(6, VehicleCommands::default()).unwrap();
        world.step().unwrap();
        let car = world.vehicle_snapshots().unwrap()[0];
        lowest = lowest.min(car.pose.position.y);
        for jounce in car.wheel_jounce {
            assert!(jounce <= 0.2 + 1e-3, "a wheel travelled past the suspension limit: {jounce:.3}");
        }
    }
    let car = world.vehicle_snapshots().unwrap()[0];
    eprintln!("landing: lowest chassis centre {lowest:.3} m, resting at {:.3} m", car.pose.position.y);
    assert!(lowest > 0.47, "the chassis bottomed out through the suspension limit: {lowest:.3} m");
    assert_eq!(car.wheels_on_road, 0b1111, "not all four wheels on the ground after landing");
    assert!(speed(car.linear_velocity) < 0.2, "the car did not settle: {:?}", car.linear_velocity);
    guard.check(&world, "a hard landing");
}

/// The car drives across rolling heightfield terrain, rides its wheels over
/// loose boxes, shoves a crate aside with its chassis, and stays on its wheels
/// throughout.
#[test]
fn a_car_drives_over_heightfield_terrain_and_debris() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    let hills = |x: f32, z: f32| 0.25 * (x * 0.35).sin() * (z * 0.3).cos() + 0.25;
    terrain(&mut world, 96.0, 97, hills);
    // 20 cm boxes in both wheel tracks (x = +-0.9), 12 m ahead: low enough to
    // pass under the chassis (its underside rides about 0.6 m above the
    // ground), so the wheels have to climb over them.
    let debris: Vec<(u32, f32, f32)> = (0..3)
        .flat_map(|row| [-0.9f32, 0.9].map(|x| (x, 12.0 + row as f32 * 1.5)))
        .enumerate()
        .map(|(i, (x, z))| (50 + i as u32, x, z))
        .collect();
    for &(id, x, z) in &debris {
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: id, user_id: id,
                pose: pose(x, hills(x, z) + 0.1, z),
                half_extents: Vec3::new(0.1, 0.1, 0.1), mass: 8.0,
                collision_group: 1, collision_mask: ALL,
            })
            .unwrap();
    }
    // A crate taller than the chassis clearance, in the car's path: wheels
    // are suspension queries and never push bodies, the chassis box does.
    const CRATE: u32 = 70;
    let crate_at = (0.5f32, 21.0f32);
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: CRATE, user_id: CRATE,
            pose: pose(crate_at.0, hills(crate_at.0, crate_at.1) + 0.4, crate_at.1),
            half_extents: Vec3::new(0.4, 0.4, 0.4), mass: 20.0,
            collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    world.add_vehicle(city_car(6, pose(0.0, hills(0.0, 0.0) + 0.9, 0.0))).unwrap();
    let mut min_up = 1.0f32;
    let mut grounded_ticks = 0;
    let (mut cruise_height, mut debris_height) = (f32::MAX, f32::MIN);
    for tick in 0..300 {
        let throttle = if tick < 30 { 0.0 } else { 0.5 };
        world.drive_vehicle(6, VehicleCommands { throttle, ..VehicleCommands::default() }).unwrap();
        world.step().unwrap();
        let car = world.vehicle_snapshots().unwrap()[0];
        let q = car.pose.rotation;
        // The chassis up vector's y component.
        min_up = min_up.min(1.0 - 2.0 * (q.x * q.x + q.z * q.z));
        if car.wheels_on_road != 0 {
            grounded_ticks += 1;
        }
        let (z, above) = (car.pose.position.z, car.pose.position.y - hills(car.pose.position.x, car.pose.position.z));
        if (4.0..10.0).contains(&z) {
            cruise_height = cruise_height.min(above);
        } else if (11.0..16.0).contains(&z) {
            debris_height = debris_height.max(above);
        }
        if tick % 20 == 0 {
            eprintln!(
                "tick {tick}: car ({:.1}, {:.2}, {:.1}) wheels {:04b}",
                car.pose.position.x, car.pose.position.y, car.pose.position.z, car.wheels_on_road
            );
        }
    }
    let car = world.vehicle_snapshots().unwrap()[0];
    eprintln!("terrain drive: z {:.1} m, min up {min_up:.2}, grounded {grounded_ticks}/300", car.pose.position.z);
    assert!(car.pose.position.z > 25.0, "the car did not get across the terrain and debris: z {:.1}", car.pose.position.z);
    assert!(min_up > 0.8, "the car rolled over: up {min_up:.2}");
    assert!(grounded_ticks > 270, "the wheels lost the terrain for too long: {grounded_ticks}/300 ticks grounded");
    eprintln!("terrain drive: chassis {cruise_height:.2} m above the terrain cruising, {debris_height:.2} m over the debris");
    assert!(
        debris_height > cruise_height + 0.08,
        "the wheels did not ride over the debris: {debris_height:.2} m vs {cruise_height:.2} m cruising"
    );
    for &(id, x, z) in &debris {
        let p = body(&world, id).pose.position;
        assert!(p.y > hills(p.x, p.z), "debris box {id} fell through the terrain: {p:?}");
        assert!((p.x - x).abs() < 5.0 && (p.z - z).abs() < 5.0, "debris box {id} was flung away: {p:?}");
    }
    let crate_pose = body(&world, CRATE).pose.position;
    let shoved = ((crate_pose.x - crate_at.0).powi(2) + (crate_pose.z - crate_at.1).powi(2)).sqrt();
    eprintln!("terrain drive: the crate was shoved {shoved:.2} m");
    assert!(shoved > 0.5, "the chassis did not push the crate in its path: moved {shoved:.2} m");
    assert!(crate_pose.y > hills(crate_pose.x, crate_pose.z), "the crate fell through the terrain: {crate_pose:?}");
    guard.check(&world, "a drive over terrain and debris");
}

/// Teleports: a dynamic body moved with set_body_pose lands and rests where it
/// was put, and a flipped car reset onto its wheels settles there upright.
#[test]
fn teleported_bodies_and_reset_vehicles_settle_where_they_are_put() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    slab(&mut world, Quat::IDENTITY);
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: 30, user_id: 130, pose: pose(0.0, 0.5, 0.0),
            half_extents: Vec3::new(0.5, 0.5, 0.5), mass: 20.0, collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    // Upside down.
    let flipped = Pose { position: Vec3::new(10.0, 1.0, 0.0), rotation: Quat { x: 0.0, y: 0.0, z: 1.0, w: 0.0 } };
    world.add_vehicle(city_car(6, flipped)).unwrap();
    for _ in 0..60 {
        world.drive_vehicle(6, VehicleCommands::default()).unwrap();
        world.step().unwrap();
    }
    world.set_body_pose(30, pose(-20.0, 3.0, 5.0)).unwrap();
    world.reset_vehicle(6, pose(-10.0, 0.8, -10.0)).unwrap();
    for _ in 0..180 {
        world.drive_vehicle(6, VehicleCommands::default()).unwrap();
        world.step().unwrap();
    }
    let block = body(&world, 30);
    let p = block.pose.position;
    assert!((p.x + 20.0).abs() < 0.2 && (p.z - 5.0).abs() < 0.2, "the teleported box is not where it was put: {p:?}");
    assert!((p.y - 0.5).abs() < 0.05, "the teleported box is not resting on the slab: y {:.3}", p.y);
    assert!(speed(block.linear_velocity) < 0.05, "the teleported box did not settle");
    let car = world.vehicle_snapshots().unwrap()[0];
    let c = car.pose.position;
    let q = car.pose.rotation;
    assert!((c.x + 10.0).abs() < 0.5 && (c.z + 10.0).abs() < 0.5, "the reset car drifted: {c:?}");
    assert!(1.0 - 2.0 * (q.x * q.x + q.z * q.z) > 0.95, "the reset car is not upright: {q:?}");
    assert_eq!(car.wheels_on_road, 0b1111, "the reset car is not on its wheels");
    guard.check(&world, "teleports and a vehicle reset");
}

/// A settling pile of 1,250 boxes keeps crossing the contact report threshold,
/// so the GPU solver builds force-change events from lost, found and
/// persistent pairs every step. Every reported pair must name bodies that
/// exist, and loaded ground contacts must keep reporting until their boxes
/// sleep. On Metal the persistent-pair masks once raced the write-index scan:
/// persisting pairs went unreported, and larger piles crashed the host on the
/// unwritten slots it read as shape-interaction pointers.
#[test]
fn force_threshold_reports_stay_valid_while_a_pile_settles() {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    let guard = NoPhysxErrors::new(&world);
    slab(&mut world, Quat::IDENTITY);
    const FIRST: u32 = 100;
    const COUNT: u32 = 1_250;
    for index in 0..COUNT {
        let (x, z) = ((index % 25) as f32 * 0.9 - 11.0, ((index / 25) % 25) as f32 * 0.9 - 11.0);
        let y = (index / 625) as f32 * 0.9 + 0.5;
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: FIRST + index, user_id: FIRST + index, pose: pose(x, y, z),
                half_extents: Vec3::new(0.4, 0.4, 0.4), mass: 5.0,
                collision_group: 1, collision_mask: ALL,
            })
            .unwrap();
    }
    let known = |id: u32| id == 1 || (FIRST..FIRST + COUNT).contains(&id);
    let mut reports = 0usize;
    let mut reported = std::collections::HashSet::new();
    let mut ground_reports = std::collections::HashMap::<u32, usize>::new();
    for tick in 0..240 {
        world.step().unwrap();
        for event in world.take_contact_events().unwrap() {
            if event.entity_a == 1 || event.entity_b == 1 {
                *ground_reports.entry(event.entity_a.max(event.entity_b)).or_default() += 1;
            }
            assert!(
                known(event.entity_a) && known(event.entity_b),
                "tick {tick}: a contact report names an unknown body: {} / {}",
                event.entity_a, event.entity_b
            );
            reports += 1;
            reported.extend([event.entity_a, event.entity_b].into_iter().filter(|&id| id != 1));
        }
    }
    // Each bottom-layer box carries the one above it, twice the threshold on
    // its ground contact, so that pair keeps reporting until the box sleeps,
    // which takes about 0.4 s (24 steps) of rest.
    let fewest_ground = (FIRST..FIRST + 625).map(|id| ground_reports.get(&id).copied().unwrap_or(0)).min().unwrap();
    eprintln!(
        "force threshold: {reports} contact reports over 240 steps, {} of {COUNT} boxes, bottom boxes at least {fewest_ground} ground reports",
        reported.len()
    );
    assert_eq!(reported.len(), COUNT as usize, "boxes whose landing was never reported: {} of {COUNT} reported", reported.len());
    assert!(fewest_ground >= 10, "a loaded ground contact stopped reporting before its box slept: {fewest_ground} reports");
    guard.check(&world, "a settling pile's force threshold reports");
}
