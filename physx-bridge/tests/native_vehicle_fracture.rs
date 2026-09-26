#![cfg(feature = "native-destruction")]
//! Real Vehicle2 + native GPU stress + physical projectile. The small authored
//! fixture isolates gameplay coupling; it is not a qualification of garage assets.
use vibe_land_physx_bridge::*;
const CAR: u32 = 0x50000001;
const STRUCTURE: u32 = 200;
const STATIC: u32 = 1;
const VEHICLE: u32 = 16;
fn v(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3::new(x, y, z)
}
fn cube(half: Vec3) -> Vec<Vec3> {
    let mut out = Vec::new();
    for x in [-1., 1.] {
        for y in [-1., 1.] {
            for z in [-1., 1.] {
                out.push(v(x * half.x, y * half.y, z * half.z));
            }
        }
    }
    out
}
fn setup(wheel_strength: f32) -> World {
    setup_with_engine_offset(wheel_strength, 0.)
}
fn setup_with_engine_offset(wheel_strength: f32, engine_x: f32) -> World {
    setup_scene(wheel_strength, engine_x, false, false)
}
fn setup_scene(wheel_strength: f32, engine_x: f32, axle: bool, free_fall: bool) -> World {
    let mut world = World::new(WorldConfig::default()).expect("required real GPU world");
    if !free_fall { world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose {
                position: v(0., -0.5, 0.),
                rotation: Quat::IDENTITY,
            },
            half_extents: v(100., 0.5, 100.),
            collision_group: STATIC,
            collision_mask: u32::MAX,
        })
        .unwrap(); }
    world
        .add_vehicle(VehicleDesc {
            entity_id: CAR,
            user_id: 0,
            pose: Pose {
                position: v(0., if free_fall {20.} else {0.9}, 0.),
                rotation: Quat::IDENTITY,
            },
            chassis_half_extents: v(0.6, 0.2, 1.3),
            mass: if axle {940.} else {920.},
            inertia: v(0., 0., 0.),
            half_track: 0.95,
            suspension_attachment_y: 0.15,
            front_axle_z: 1.,
            rear_axle_z: -1.,
            suspension_travel: 0.35,
            suspension_stiffness: 25000.,
            suspension_damping: 3500.,
            wheel_radius: 0.4,
            wheel_half_width: 0.15,
            tyre_friction: 1.,
            front_lateral_stiffness: 45000.,
            rear_lateral_stiffness: 45000.,
            longitudinal_stiffness: 18000.,
            com_offset_y: 0.,
            angular_damping: 0.05,
            max_steer_radians: 0.5,
            drive_torque: 250.,
            brake_torque: 1500.,
            handbrake_torque: 2200.,
            top_speed: 30.,
            front_wheel_drive: false,
            rear_wheel_drive: false,
            sweep_road_queries: true,
            road_mask: STATIC,
            collision_group: VEHICLE,
            collision_mask: u32::MAX,
        })
        .unwrap();
    let mut positions = vec![
        v(0., 0., 0.),
        v(-0.95, -0.1, 1.),
        v(0.95, -0.1, 1.),
        v(-0.95, -0.1, -1.),
        v(0.95, -0.1, -1.),
        v(engine_x, 0.4, -0.7),
    ];
    if axle { positions.push(v(-1.6,0.4,1.)); }
    let mut parts = Vec::new();
    let mut shapes = Vec::new();
    for (i, center) in positions.iter().copied().enumerate() {
        let mass = if i == 0 {
            800.
        } else if i == 5 {
            40.
        } else {
            20.
        };
        let h = if i == 0 {
            v(0.6, 0.2, 1.3)
        } else {
            v(0.15, 0.15, 0.15)
        };
        parts.push(VehicleFracturePart {
            part_index: i as u32,
            mass,
            volume: 8. * h.x * h.y * h.z,
            center,
            inertia_diagonal: v(
                mass * (h.y * h.y + h.z * h.z) / 3.,
                mass * (h.x * h.x + h.z * h.z) / 3.,
                mass * (h.x * h.x + h.y * h.y) / 3.,
            ),
            inertia_products: v(0., 0., 0.),
            wheel: if (1..5).contains(&i) {
                (i - 1) as u8
            } else {
                255
            },
            engine: i == 5,
            drive_wheel: if i==6 {0} else {255},
        });
        // Two chassis hulls still represent one authored chunk and its one
        // measured mass tensor. This also exercises borrowed extra-shape refs.
        if i == 0 {
            for x in [-0.3, 0.3] {
                shapes.push(VehiclePartShape {
                    part_index: 0,
                    position: v(x, 0., 0.),
                    points: cube(v(0.3, h.y, h.z)),
                });
            }
        } else {
            shapes.push(VehiclePartShape {
                part_index: i as u32,
                position: center,
                points: cube(h),
            });
        }
    }
    world.set_vehicle_shapes(CAR, &shapes).unwrap();
    world.native_attach().unwrap();
    let bonds: Vec<_> = (1..positions.len() as u32)
        .map(|i| ChunkBondDesc {
            bond_index: i - 1,
            node0: 0,
            node1: i,
            centroid: v(
                positions[i as usize].x * 0.5,
                positions[i as usize].y * 0.5,
                positions[i as usize].z * 0.5,
            ),
            normal: if positions[i as usize].x < 0. {
                v(-1., 0., 0.)
            } else {
                v(1., 0., 0.)
            },
            area: 0.01,
            material: if i == if axle {6} else {1} { 0 } else { 1 },
        })
        .collect();
    let material = |elastic| StressMaterialDesc {
        compression_elastic: elastic,
        compression_fatal: elastic * 2.,
        tension_elastic: elastic,
        tension_fatal: elastic * 2.,
        shear_elastic: elastic,
        shear_fatal: elastic * 2.,
        elastic_modulus: 70e9,
        residual_area_fraction: 0.,
    };
    world
        .native_register_vehicle(
            CAR,
            STRUCTURE,
            &parts,
            &bonds,
            DestructibleSettings {
                materials: vec![material(wheel_strength), material(1e9)],
                ..Default::default()
            },
        )
        .unwrap();
    world.step().unwrap();
    let configured = world
        .native_configure(NativeConfig {
            max_iterations: 2048,
            tolerance: 1e-5,
            warm_start: true,
            damage_rate: 2.,
            bend_gain_max: 3.,
            fibre_bending: true,
            reserved_contact_pairs: 64,
            preserve_unchanged_contact_pairs: false,
            gpu_island_repair: true,
            verdict_sample_ticks: 1,
        })
        .unwrap();
    assert_eq!(configured.chunks as usize, positions.len());
    assert_eq!(configured.bonds as usize, positions.len()-1);
    world
}

#[test]
#[ignore = "requires isolated coherent PhysX ABI 22 GPU SDK with drive mask support"]
fn native_axle_fracture_cuts_only_its_wheel_torque_while_wheel_can_brake() {
    for (strength, expect_fracture) in [(20e6,true),(1e9,false)] {
        let mut world=setup_scene(strength,0.,true,true);
        let mut broken=Vec::new();
        let mut detached=false;
        let mut coast_ticks=0;
        let mut contacted=false;
        for tick in 0..150 {
            world.drive_vehicle(CAR,VehicleCommands { throttle:0.35,..Default::default() }).unwrap();
            if tick==30 {
                let aim=world.native_chunk_aim(STRUCTURE,6).unwrap();
                let ray=world.native_raycast_chunk(v(aim.center.x-0.28,aim.center.y,aim.center.z),v(1.,0.,0.),1.).unwrap();
                assert!(ray.hit && ray.chunk_id==aim.chunk_id);
                let velocity=world.vehicle_snapshots().unwrap()[0].linear_velocity;
                world.launch_dynamic_ball(LaunchedBallDesc {
                    entity_id:2,user_id:0,pose:Pose {position:v(aim.center.x-0.28,aim.center.y,aim.center.z),rotation:Quat::IDENTITY},
                    radius:0.12,mass:300.,linear_velocity:v(30.+velocity.x,velocity.y,velocity.z),
                    collision_group:VEHICLE,collision_mask:u32::MAX,
                }).unwrap();
            }
            let before=world.vehicle_snapshots().unwrap()[0];
            world.step().unwrap();
            let status=world.native_tick().unwrap();
            assert_eq!(status.error,0);
            assert!(status.converged);
            contacted |= status.normal_contacts>0;
            broken.extend(world.native_take_broken_bonds().unwrap());
            if tick<30 {assert!(broken.is_empty());}
            let chassis=world.native_chunk_aim(STRUCTURE,0).unwrap();
            for part in 1..6 {
                assert_eq!(world.native_chunk_aim(STRUCTURE,part).unwrap().entity_id,chassis.entity_id);
            }
            let after=world.vehicle_snapshots().unwrap()[0];
            if detached {
                assert_eq!(after.drive_connection_mask,14);
                assert!(after.wheel_rotation_speed[0].abs()<=before.wheel_rotation_speed[0].abs()+1e-4,
                    "shaftless wheel still accelerates under throttle");
                assert!(after.wheel_rotation_speed[1]>before.wheel_rotation_speed[1],
                    "the other powered wheel must continue accelerating");
                coast_ticks+=1;
            }
            detached |= world.native_chunk_aim(STRUCTURE,6).unwrap().entity_id!=chassis.entity_id;
            assert!(world.native_validate_mappings().unwrap());
        }
        assert!(contacted);
        assert_eq!(detached,expect_fracture);
        assert_eq!(broken.len(),usize::from(expect_fracture));
        if expect_fracture {
            assert!(coast_ticks>30);
            let spinning=world.vehicle_snapshots().unwrap()[0].wheel_rotation_speed[0].abs();
            assert!(spinning>0.1,"shaft loss must not erase the surviving wheel's inertia");
            world.drive_vehicle(CAR,VehicleCommands {brake:1.,..Default::default()}).unwrap();
            for _ in 0..10 {world.step().unwrap();}
            assert!(world.vehicle_snapshots().unwrap()[0].wheel_rotation_speed[0].abs()<spinning*0.1,
                "a surviving wheel must retain its brake");
        } else {assert_eq!(world.vehicle_snapshots().unwrap()[0].drive_connection_mask,15);}
        eprintln!("Vehicle2 axle proof: strength={strength}, broken={}, coasting-wheel ticks={coast_ticks}, wheel retained, brake verified={expect_fracture}",broken.len());
        world.native_clear().unwrap();
        world.remove_actor(CAR).unwrap();
    }
}
#[test]
#[ignore = "requires isolated coherent PhysX ABI 22 GPU SDK"]
fn native_vehicle_accepts_small_authored_com_offsets() {
    // Closed-mesh integration leaves valid sub-nanometre COM components on
    // nominal symmetry planes. Combining them with metre-scale forest offsets
    // must not reject the graph merely because a sum exceeds binary64's
    // significand. Do not round away inputs to make this test pass.
    let mut world = setup_with_engine_offset(1e9, 1e-18);
    for tick in 0..3 {
        if let Err(error) = world.step() {
            panic!("tick {tick}: {error}; native {:?}", world.native_tick());
        }
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0);
        assert!(status.converged);
        assert!(world.native_take_broken_bonds().unwrap().is_empty());
    }
}
#[test]
#[ignore = "requires isolated coherent PhysX ABI 22 GPU SDK"]
fn native_vehicle_survives_driving_then_loses_only_shot_corner() {
    exercise_impact(20e6, true);
    exercise_impact(1e9, false);
}
fn exercise_impact(wheel_strength: f32, expect_fracture: bool) {
    let mut world = setup(wheel_strength);
    let mut broken = Vec::new();
    let mut hit = false;
    let mut missing_ticks = 0;
    for tick in 0..420 {
        world
            .drive_vehicle(
                CAR,
                VehicleCommands {
                    throttle: if tick >= 180 { 0.35 } else { 0. },
                    steer: if tick >= 240 { 0.15 } else { 0. },
                    ..Default::default()
                },
            )
            .unwrap();
        if tick == 300 {
            let aim = world.native_chunk_aim(STRUCTURE, 1).unwrap();
            assert!(aim.found);
            let velocity = world.vehicle_snapshots().unwrap()[0].linear_velocity;
            let ray = world
                .native_raycast_chunk(
                    v(aim.center.x - 0.28, aim.center.y, aim.center.z),
                    v(1., 0., 0.),
                    3.,
                )
                .unwrap();
            assert!(
                ray.hit && ray.chunk_id == aim.chunk_id,
                "shot must target the named corner"
            );
            assert!(
                aim.center.z > 2.,
                "fixture must actually drive before impact"
            );
            // Start at the swept shot's pre-contact position: 30 m/s crosses
            // this tiny fixture collider in one 60 Hz step. The sphere has a
            // positive gap but is inside the contact-generation margin.
            // A deliberately heavy 300 kg proof load separates solver/coupling
            // qualification from tuning the garage's 30 kg cannon gameplay.
            world
                .launch_dynamic_ball(LaunchedBallDesc {
                    entity_id: 2,
                    user_id: 0,
                    pose: Pose {
                        position: v(aim.center.x - 0.28, aim.center.y + 0.01, aim.center.z),
                        rotation: Quat::IDENTITY,
                    },
                    radius: 0.12,
                    mass: 300.,
                    linear_velocity: v(30. + velocity.x, velocity.y, velocity.z),
                    collision_group: VEHICLE,
                    collision_mask: u32::MAX,
                })
                .unwrap();
        }
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "native tick {tick}");
        broken.extend(world.native_take_broken_bonds().unwrap());

        if tick < 300 {
            assert!(broken.is_empty(), "normal driving broke vehicle at {tick}");
        }
        let chassis = world.native_chunk_aim(STRUCTURE, 0).unwrap();
        let corner = world.native_chunk_aim(STRUCTURE, 1).unwrap();
        for other in 2..6 {
            assert_eq!(
                world.native_chunk_aim(STRUCTURE, other).unwrap().entity_id,
                chassis.entity_id,
                "untargeted part {other} broke at {tick}"
            );
        }
        if corner.entity_id != chassis.entity_id {
            if hit {
                let car = world.vehicle_snapshots().unwrap()[0];
                assert_eq!(
                    car.wheel_rotation_speed[0], 0.,
                    "disconnected wheel still driven"
                );
                assert_eq!(
                    car.wheels_on_road & 1,
                    0,
                    "disconnected wheel still queries road"
                );
                missing_ticks += 1;
            }
            hit = true;
        }
    }
    assert_eq!(
        hit, expect_fracture,
        "material-dependent localized fracture"
    );
    assert_eq!(
        broken.len(),
        usize::from(expect_fracture),
        "only the target attachment may break"
    );
    if expect_fracture {
        assert!(
            missing_ticks > 30,
            "detached wheel must remain nonfunctional"
        );
    }
    eprintln!("Vehicle2 GPU: 180 idle + 120 driving + 120 impact ticks; 6 chunks, 5 bonds, 300 kg projectile; strength={wheel_strength}, broken={}, disabled-wheel ticks={missing_ticks}",broken.len());
    assert!(world.native_validate_mappings().unwrap());
    assert!(
        world.remove_actor(CAR).is_err(),
        "removal must not leave native dangling constraints"
    );
    assert!(
        world
            .reset_vehicle(
                CAR,
                Pose {
                    position: v(0., 1., 0.),
                    rotation: Quat::IDENTITY
                }
            )
            .is_err(),
        "reset must not teleport a live fractured graph"
    );
    world.native_clear().unwrap();
    world.remove_actor(CAR).unwrap();
}
