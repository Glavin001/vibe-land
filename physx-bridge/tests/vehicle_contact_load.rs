#![cfg(feature = "native-destruction")]
//! The load a destructible car's joints are graded against in a hit must be the
//! impulse the hit gave the car: what changed its momentum, nothing more.
//!
//! A car of six chunks on bonds that cannot break is thrown at 20 m/s into a
//! wall, in the air (no ground, no tyre forces). On every tick, the stress
//! solve's external load on the car -- the trial solve's report (the one that
//! decides what breaks), contact plus constraint input times each chunk's
//! mass, summed -- is compared with the force that changed the car's momentum
//! over the tick, m |dv - g dt| / dt. The car is rigid, so the two are one
//! quantity (Newton's second law); a larger load never acted on the car, yet
//! its joints are graded against it.
//!
//! Walls: a static box, a stage plate wall that cannot break, and the same wall
//! of mortared blocks that the car breaks. Against the first two the load is
//! the momentum change (1.00). Against the breaking wall the trial still holds
//! the struck blocks kinematic -- anchored, infinite mass -- so the car is
//! graded against a dead stop (1227 kN) while the corrected pass, with the
//! blocks freed, gives it 791 kN (1.55x; fails today).
//!
//! Found in the vehicle lab (2026-10-08, server/src/vehicle_testbed.rs
//! `loadBalance`, VIBE_TESTBED_AUDIT=1): the monster truck into the lab's
//! masonry wall took 42.7 MN of contact load on its first tick (the dead stop
//! plus the position bias of 0.36 m of first-tick penetration) against 0.52 MN
//! of measured deceleration, and lost all four wheels; at 10 m/s, 3.2 MN (a
//! dead stop in a tick) against 1.7 MN, 3 wheels off with 35 bonds broken.
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... cargo test -p vibe-land-physx-bridge \
//!   --features native-destruction --test vehicle_contact_load -- --ignored --nocapture --test-threads=1
#[path = "common/stage_env.rs"]
mod stage_env;
use vibe_land_physx_bridge::*;

const CAR: u32 = 0x50000001;
const STRUCTURE: u32 = 200;
const STATIC: u32 = 1;
const VEHICLE: u32 = 16;
/// The wall's group: not in the car's road mask, so its wheels' road sweeps
/// never take the wall for ground (the hit is a contact, as in the lab's walls
/// struck by the bodywork first).
const WALL: u32 = 2;
const DT: f32 = 1.0 / 60.0;
const G: f32 = 9.81;

fn v(x: f32, y: f32, z: f32) -> Vec3 { Vec3::new(x, y, z) }
fn cube(half: Vec3) -> Vec<Vec3> {
    let mut out = Vec::new();
    for x in [-1., 1.] { for y in [-1., 1.] { for z in [-1., 1.] { out.push(v(x * half.x, y * half.y, z * half.z)); } } }
    out
}

/// The car (chassis 800 kg, four 20 kg wheel chunks, a 40 kg engine: 920 kg)
/// at height `y`, and a static wall across its path at z = `wall_z`.
/// The wall: a static PhysX box (`Wall::Static`), or a stage-owned plate on a
/// buried footing (`Wall::Stage`: anchored, so kinematic in the step, as the
/// lab's walls and houses are).
#[derive(Clone, Copy, Debug)]
enum Wall { Static, Stage, Breakable }

fn setup(y: f32, wall_z: f32, speed: f32, wall: Wall) -> World {
    stage_env::product();
    let mut world = World::new(WorldConfig::default()).expect("required real GPU world");
    if let Wall::Static = wall {
        world.add_static_box(StaticBoxDesc {
            entity_id: 1, user_id: 0,
            pose: Pose { position: v(0., y, wall_z), rotation: Quat::IDENTITY },
            half_extents: v(4., 3., 0.25), collision_group: WALL, collision_mask: u32::MAX,
        }).unwrap();
    }
    world.add_vehicle(VehicleDesc {
        entity_id: CAR, user_id: 0, pose: Pose { position: v(0., y, 0.), rotation: Quat::IDENTITY },
        chassis_half_extents: v(0.6, 0.2, 1.3), mass: 920., inertia: v(0., 0., 0.),
        half_track: 0.95, suspension_attachment_y: 0.15, front_axle_z: 1., rear_axle_z: -1.,
        suspension_travel: 0.35, suspension_stiffness: 25000., suspension_damping: 3500.,
        wheel_radius: 0.4, wheel_half_width: 0.15, tyre_friction: 1.,
        front_lateral_stiffness: 45000., rear_lateral_stiffness: 45000., longitudinal_stiffness: 18000.,
        bump_stop_stiffness: 0.0, bump_stop_damping: 0.0, com_offset_y: 0., angular_damping: 0.0,
        max_steer_radians: 0.5, drive_torque: 250., brake_torque: 1500., handbrake_torque: 2200., top_speed: 30.,
        front_wheel_drive: false, rear_wheel_drive: false, sweep_road_queries: true, road_mask: STATIC,
        collision_group: VEHICLE, collision_mask: u32::MAX,
    }).unwrap();
    let positions = [v(0., 0., 0.), v(-0.95, -0.1, 1.), v(0.95, -0.1, 1.), v(-0.95, -0.1, -1.), v(0.95, -0.1, -1.), v(0., 0.4, -0.7)];
    let (mut parts, mut shapes) = (Vec::new(), Vec::new());
    for (i, center) in positions.iter().copied().enumerate() {
        let mass = match i { 0 => 800., 5 => 40., _ => 20. };
        let h = if i == 0 { v(0.6, 0.2, 1.3) } else { v(0.15, 0.15, 0.15) };
        parts.push(VehicleFracturePart {
            part_index: i as u32, mass, volume: 8. * h.x * h.y * h.z, center,
            inertia_diagonal: v(mass * (h.y * h.y + h.z * h.z) / 3., mass * (h.x * h.x + h.z * h.z) / 3., mass * (h.x * h.x + h.y * h.y) / 3.),
            inertia_products: v(0., 0., 0.),
            wheel: if (1..5).contains(&i) { (i - 1) as u8 } else { 255 }, engine: i == 5, drive_wheel: 255,
        });
        shapes.push(VehiclePartShape { part_index: i as u32, position: center, points: cube(h) });
    }
    world.set_vehicle_shapes(CAR, &shapes).unwrap();
    world.native_attach().unwrap();
    if !matches!(wall, Wall::Static) {
        let node = |i: u32, c: Vec3, h: Vec3, m: f32| ChunkNodeDesc { node_index: i, centroid: c, mass: m, volume: 8. * h.x * h.y * h.z,
            geom_kind: 0, half_extents: h, convex_points: Vec::new(), material: 0 };
        // A footing, and on it a wall of 0.5 m masonry blocks (8 wide, 6 high,
        // 0.25 m thick, 2000 kg/m3: 125 kg each), bonded to their neighbours and
        // the footing. Stage: unbreakable; Breakable: mortar a car breaks.
        let mut nodes = vec![node(0, v(0., y - 3.5, wall_z), v(4., 0.5, 0.5), 0.)];
        let mut bonds = Vec::new();
        let id = |i: i32, j: i32| (1 + j * 8 + i) as u32;
        for j in 0..6 { for i in 0..8 {
            nodes.push(node(id(i, j), v(-3.75 + 1.0 * i as f32 * 1.0, y - 2.75 + 1.0 * j as f32 * 1.0, wall_z), v(0.5, 0.5, 0.125), 2000. * 1. * 1. * 0.25));
        } }
        for j in 0..6 { for i in 0..8 {
            let c = v(-3.75 + i as f32, y - 2.75 + j as f32, wall_z);
            if j == 0 { bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: 0, node1: id(i, j), centroid: v(c.x, c.y - 0.5, c.z), normal: v(0., 1., 0.), area: 0.25, material: 0 }); }
            if i < 7 { bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: id(i, j), node1: id(i + 1, j), centroid: v(c.x + 0.5, c.y, c.z), normal: v(1., 0., 0.), area: 0.25, material: 0 }); }
            if j < 5 { bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: id(i, j), node1: id(i, j + 1), centroid: v(c.x, c.y + 0.5, c.z), normal: v(0., 1., 0.), area: 0.25, material: 0 }); }
        } }
        let limit = if matches!(wall, Wall::Breakable) { 0.4e6 } else { 1e13 };
        let mortar = StressMaterialDesc { compression_elastic: limit, compression_fatal: limit, tension_elastic: limit, tension_fatal: limit,
            shear_elastic: limit, shear_fatal: limit, elastic_modulus: 5e9, residual_area_fraction: 0. };
        world.native_create_destructible(0, Pose { position: v(0., 0., 0.), rotation: Quat::IDENTITY }, &nodes, &bonds,
            DestructibleSettings { materials: vec![mortar], linear_damping: 0., angular_damping: 0., ..Default::default() }, WALL, u32::MAX).unwrap();
    }
    let bonds: Vec<_> = (1..positions.len() as u32).map(|i| ChunkBondDesc {
        bond_index: i - 1, node0: 0, node1: i,
        centroid: v(positions[i as usize].x * 0.5, positions[i as usize].y * 0.5, positions[i as usize].z * 0.5),
        normal: if positions[i as usize].x < 0. { v(-1., 0., 0.) } else { v(1., 0., 0.) }, area: 0.01, material: 0,
    }).collect();
    // Bonds that cannot break here: the load, not the verdict, is under test.
    let strong = StressMaterialDesc { compression_elastic: 1e12, compression_fatal: 2e12, tension_elastic: 1e12, tension_fatal: 2e12,
        shear_elastic: 1e12, shear_fatal: 2e12, elastic_modulus: 200e9, residual_area_fraction: 0. };
    world.native_register_vehicle(CAR, STRUCTURE, &parts, &bonds, DestructibleSettings { materials: vec![strong], ..Default::default() }).unwrap();
    // Thrown before the stage is configured: an actor impulse is not a load
    // the stage apportions to chunks, so it is given on the plain step.
    world.apply_impulse(CAR, v(0., 0., 920. * speed)).unwrap();
    world.step().unwrap();
    world.native_configure(NativeConfig {
        max_iterations: 256, tolerance: 1e-3, force_tolerance: 1e-3, warm_start: true, damage_rate: 2., bend_gain_max: 3.,
        fibre_bending: true, reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: false, gpu_island_repair: true, verdict_sample_ticks: 1,
    }).unwrap();
    world.native_set_stress_solve_report(1).unwrap();
    world
}

/// One tick: the external load the trial solve graded the car against (N),
/// and the force its measured momentum change needs (N).
struct Tick { load_n: f32, needed_n: f32 }

/// Throw the car at `speed` into the wall and return each tick's summed
/// external load (contact and constraint) and the force its measured momentum
/// change needs.
fn throw(speed: f32, wall: Wall) -> (Vec<Tick>, f32) {
    let mut world = setup(30., 3.5, speed, wall);
    let mass: f32 = 920.;
    let mut out = Vec::new();
    for k in 0..90 {
        let before = world.vehicle_snapshots().unwrap()[0].linear_velocity;
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0);
        let after = world.vehicle_snapshots().unwrap()[0].linear_velocity;
        if k % 10 == 0 && std::env::var_os("CONTACT_LOAD_DEBUG").is_some() { println!("tick {k}: car velocity ({:.2} {:.2} {:.2}), z {:.2}", after.x, after.y, after.z, world.vehicle_snapshots().unwrap()[0].pose.position.z); }
        let report = world.native_stress_solve_report().unwrap();
        let (mut sum, mut chunk_mass) = (v(0., 0., 0.), 0.);
        for c in report.chunks.iter().filter(|c| c.structure_id == STRUCTURE) {
            let m = [800., 20., 20., 20., 20., 40.][c.node as usize];
            let k = v(c.constraint_linear.x * m, c.constraint_linear.y * m, c.constraint_linear.z * m);
            sum = v(sum.x + k.x, sum.y + k.y, sum.z + k.z);
            chunk_mass += m;
            sum = v(sum.x + c.contact_linear.x * m, sum.y + c.contact_linear.y * m, sum.z + c.contact_linear.z * m);
        }
        assert!((chunk_mass - mass).abs() < 1e-3, "the report covers the car's chunks");
        if std::env::var_os("CONTACT_LOAD_DEBUG").is_some() && status.normal_contacts > 0 {
            println!("tick {k}: normal contacts {} corrections {} broken {}", status.normal_contacts, status.correction_passes, status.broken_bonds);
            for c in report.chunks.iter() { println!("   s{} n{} comp {} prep ({:.1} {:.1} {:.1}) cons ({:.1} {:.1} {:.1}) cont ({:.1} {:.1} {:.1})", c.structure_id, c.node, c.component,
                c.prepared_linear.x, c.prepared_linear.y, c.prepared_linear.z, c.constraint_linear.x, c.constraint_linear.y, c.constraint_linear.z, c.contact_linear.x, c.contact_linear.y, c.contact_linear.z); }
        }
        // The car falls freely: its momentum change is gravity's and the contact's.
        let dv = v(after.x - before.x, after.y - before.y + G * DT, after.z - before.z);
        let needed = mass * (dv.x * dv.x + dv.y * dv.y + dv.z * dv.z).sqrt() / DT;
        out.push(Tick { load_n: (sum.x * sum.x + sum.y * sum.y + sum.z * sum.z).sqrt(), needed_n: needed });
    }
    (out, mass)
}

#[test]
#[ignore = "requires the native-destruction GPU SDK"]
fn a_cars_graded_load_is_the_impulse_that_changed_its_momentum() {
    for (speed, wall) in [(20.0f32, Wall::Breakable), (20.0, Wall::Stage), (5.0, Wall::Stage), (20.0, Wall::Static)] {
        let (ticks, mass) = throw(speed, wall);
        println!("{speed} m/s into a {wall:?} wall");
        let hit: Vec<(usize, &Tick)> = ticks.iter().enumerate().filter(|(_, t)| t.load_n > 0.05 * mass * G || t.needed_n > 0.05 * mass * G).collect();
        assert!(!hit.is_empty(), "the car reached the wall at {speed} m/s");
        // The most any contact can do to it in a tick: stop it dead and send it back at full speed.
        let ceiling = 2.0 * mass * speed / DT;
        let mut worst = 0f32;
        for (k, t) in &hit {
            let ratio = t.load_n / t.needed_n.max(0.05 * mass * G);
            println!("{speed:4.1} m/s tick {k:2}: graded load {:9.1} kN, momentum change needs {:9.1} kN, ratio {ratio:6.2}", t.load_n / 1e3, t.needed_n / 1e3);
            // Tolerance: 10% (the solver's FP32 impulses against the velocity
            // difference) and a quarter of the car's weight (one tick's gravity
            // sampled against a contact that starts or ends mid-tick).
            if t.load_n > 1.1 * t.needed_n + 0.25 * mass * G { worst = worst.max(ratio); }
            assert!(t.load_n <= ceiling, "{speed} m/s tick {k}: a contact load of {:.0} kN is more than reversing the car in a tick ({:.0} kN)", t.load_n / 1e3, ceiling / 1e3);
        }
        let under = hit.iter().map(|(_, t)| t.load_n / t.needed_n.max(0.05 * mass * G)).fold(f32::MAX, f32::min);
        println!("{speed} m/s, {wall:?}: worst ratio past tolerance {worst:.2}, least {under:.2}");
        assert!(worst == 0.0, "{speed} m/s, {wall:?} wall: the car's joints were graded against {worst:.2}x the load that changed its momentum");
    }
}
