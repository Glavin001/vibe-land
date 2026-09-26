//! Full authored geometry probes. These do not claim moving-suspension fidelity:
//! they isolate real asset registration and material fracture in free fall.
use super::{bridge, tests::gpu_test_guard, PhysxPhysicsArena, Vector3, GROUP_DYNAMIC, ALL_GROUPS};
use crate::vehicle_assets::PreparedGeometry;
use serde_json::json;

const STRUCTURE: u32 = 200;
const MODELS: [&str; 6] = ["buggy", "trophy", "rally", "monster", "derby", "sprint"];

fn fixtures() -> Vec<(String, PreparedGeometry)> {
    let fixtures: serde_json::Value = serde_json::from_slice(&std::fs::read(
        std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("fixture manifest")
    ).unwrap()).unwrap();
    let mut result = Vec::new();
    for fixture in fixtures.as_array().unwrap() {
        let name = fixture["name"].as_str().unwrap();
        if !MODELS.contains(&name) { continue; }
        let mut geometry: PreparedGeometry = serde_json::from_slice(
            &std::fs::read(fixture["metadataPath"].as_str().unwrap()).unwrap()
        ).unwrap();
        geometry.driving = Some(serde_json::from_value(fixture["driving"].clone()).unwrap());
        assert!(!result.iter().any(|(n, _)| n == name), "duplicate base model");
        result.push((name.to_owned(), geometry));
    }
    assert_eq!(result.len(), MODELS.len(), "all six drivable base models are required");
    result
}

struct AuthoredScene {
    world: bridge::World,
    entity: u32,
    parts: Vec<bridge::VehicleFracturePart>,
    bonds: Vec<bridge::ChunkBondDesc>,
    hulls: usize,
}

fn prepare(geometry: &PreparedGeometry) -> AuthoredScene {
    let asset = geometry.native_fracture_assembly().unwrap();
    let mut world = bridge::World::new(bridge::WorldConfig::default()).unwrap();
    let desc = PhysxPhysicsArena::vehicle_asset_desc(7, 0, Vector3::new(0.,20.,0.),
        [0., 0.38268343, 0., 0.9238795], Some(geometry));
    world.add_vehicle(desc).unwrap();
    world.set_vehicle_shapes(desc.entity_id, &asset.shapes).unwrap();
    world.native_attach().unwrap();
    world.native_register_vehicle(desc.entity_id, STRUCTURE, &asset.parts, &asset.bonds,
        bridge::DestructibleSettings {materials: asset.materials, ..Default::default()}).unwrap();
    world.step().unwrap(); // Allocate native contact identities before registration.
    let configured = world.native_configure(bridge::NativeConfig {
        max_iterations: 2048, tolerance: 1e-5, warm_start: true, damage_rate: 2.,
        bend_gain_max: 3., fibre_bending: true, reserved_contact_pairs: 4096,
        preserve_unchanged_contact_pairs: false, gpu_island_repair: true,
        verdict_sample_ticks: 1,
    }).unwrap();
    assert_eq!(configured.chunks as usize, asset.parts.len());
    assert_eq!(configured.bonds as usize, asset.bonds.len());
    AuthoredScene { world, entity: desc.entity_id, parts: asset.parts, bonds: asset.bonds, hulls: asset.shapes.len() }
}

fn checked_step(world: &mut bridge::World, label: &str, tick: u32) -> bridge::NativeStatus {
    if let Err(error) = world.step() {
        panic!("{label} tick {tick}: {error}; native {:?}", world.native_tick());
    }
    let status = world.native_tick().unwrap();
    assert_eq!(status.error, 0, "{label} tick {tick}");
    assert!(status.converged, "{label} tick {tick}: stress did not converge");
    assert!(world.native_validate_mappings().unwrap(), "{label} lost hull ownership");
    status
}

#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn authored_vehicle_native_registration_and_free_fall() {
    let _guard = gpu_test_guard();
    for (name, geometry) in fixtures() {
        let mut scene = prepare(&geometry);
        let initial = scene.world.vehicle_snapshots().unwrap()[0];
        for tick in 0..30 {
            checked_step(&mut scene.world, &name, tick);
            assert!(scene.world.native_take_broken_bonds().unwrap().is_empty(), "{name} fractured in free fall");
            let state = scene.world.vehicle_snapshots().unwrap()[0];
            assert_eq!(state.wheels_on_road, 0);
            assert!(state.pose.position.y.is_finite());
            assert!((state.pose.position.x-initial.pose.position.x).abs() < 1e-3);
            assert!((state.pose.position.z-initial.pose.position.z).abs() < 1e-3);
        }
        let final_state = scene.world.vehicle_snapshots().unwrap()[0];
        assert!(final_state.pose.position.y < initial.pose.position.y - 1., "{name} did not fall");
        eprintln!("Native authored vehicle {name}: {} chunks, {} hulls, {} bonds, 30 free-fall ticks, no fracture", scene.parts.len(), scene.hulls, scene.bonds.len());
        scene.world.native_clear().unwrap();
        scene.world.remove_actor(scene.entity).unwrap();
    }
}

/// Nominal gameplay projectile against each complete graph, without terrain.
/// A surface ray establishes a positive pre-contact gap and the intended chunk.
/// No direct fracture command, invented damage impulse, or material override.
#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn authored_vehicle_cannonball_localized_fracture() {
    let _guard = gpu_test_guard();
    let mut reports = Vec::new();
    let mut failures = Vec::new();
    for (name, geometry) in fixtures() {
        // The SDK's optional equation recorder uses write-once paths. Give each
        // scene a distinct path while retaining the complete six-model gate.
        // This test holds the GPU lock and its documented invocation is serial.
        if let Ok(directory) = std::env::var("VIBE_VEHICLE_CAPTURE_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::env::set_var("PHYSX_COMPONENT_WORK_OUTPUT", directory.join(format!("{name}.components.jsonl")));
            std::env::set_var("PHYSX_STRESS_PROBLEM_PREFIX", directory.join(&name));
            std::env::set_var("PHYSX_STRESS_PROBLEM_SOLVES", "0:200");
        }
        let mut scene = prepare(&geometry);
        for tick in 0..30 {
            checked_step(&mut scene.world, &name, tick);
            assert!(scene.world.native_take_broken_bonds().unwrap().is_empty());
        }
        let target = scene.parts.iter().position(|p| p.wheel == 0).unwrap() as u32;
        let car = scene.world.vehicle_snapshots().unwrap()[0];
        let q = car.pose.rotation;
        let rotation = nalgebra::UnitQuaternion::new_normalize(nalgebra::Quaternion::new(q.w,q.x,q.y,q.z));
        let direction = rotation * Vector3::x();
        let aim = scene.world.native_chunk_aim(STRUCTURE, target).unwrap();
        assert!(aim.found);
        let center = Vector3::new(aim.center.x, aim.center.y, aim.center.z);
        let origin = center - direction * 5.;
        let v = |a: Vector3<f32>| bridge::Vec3::new(a.x,a.y,a.z);
        let ray = scene.world.native_raycast_chunk(v(origin),v(direction),10.).unwrap();
        assert!(ray.hit && ray.chunk_id == aim.chunk_id, "{name}: shot is obstructed or misses intended wheel: {ray:?}");
        let point = Vector3::new(ray.position.x,ray.position.y,ray.position.z);
        let position = point - direction * (crate::garage_bombardment::BALL_RADIUS + 0.001);
        let velocity = direction * 55. + Vector3::new(car.linear_velocity.x,car.linear_velocity.y,car.linear_velocity.z);
        scene.world.launch_dynamic_ball(bridge::LaunchedBallDesc {
            entity_id: 2, user_id: 0, pose: bridge::Pose { position: v(position), rotation: bridge::Quat::IDENTITY },
            radius: crate::garage_bombardment::BALL_RADIUS, mass: crate::garage_bombardment::BALL_MASS,
            linear_velocity: v(velocity), collision_group: GROUP_DYNAMIC, collision_mask: ALL_GROUPS,
        }).unwrap();
        let mut broken = std::collections::BTreeSet::new();
        let mut frames = Vec::new();
        let mut impact_verdicts = Vec::new();
        let mut error = None;
        for tick in 0..120 {
            let step = scene.world.step();
            let status = scene.world.native_tick().unwrap();
            if let Err(e) = step { error = Some(format!("tick {tick}: {e}; {status:?}")); break; }
            for event in scene.world.native_take_broken_bonds().unwrap() {
                assert_eq!(event.structure_id, STRUCTURE);
                broken.insert(event.bond_id);
            }
            let chassis = scene.world.native_chunk_aim(STRUCTURE,0).unwrap();
            let corner = scene.world.native_chunk_aim(STRUCTURE,target).unwrap();
            let state = scene.world.vehicle_snapshots().unwrap()[0];
            frames.push(json!({"tick":tick,"contacts":status.normal_contacts,"broken":broken.len(),
                "converged":status.converged,"error":status.error,"targetAttached":corner.entity_id==chassis.entity_id,
                "wheelSpeed":state.wheel_rotation_speed[0],"wheelsOnRoad":state.wheels_on_road}));
            if status.error != 0 || !status.converged { error = Some(format!("tick {tick}: {status:?}")); break; }
            if status.normal_contacts > 0 {
                let rows = scene.world.native_bond_stress_rows(STRUCTURE).unwrap();
                assert_eq!(rows.len(), scene.bonds.len());
                let rows: Vec<_> = rows.iter().map(|row| {
                    assert!(row.native_verdict_available);
                    let strength = &geometry.bonds[row.bond_index as usize].strength;
                    json!({"bond":row.bond_index,"node0":row.node0,"node1":row.node1,
                        "part0":geometry.parts[row.node0 as usize].id,"part1":geometry.parts[row.node1 as usize].id,
                        "area":row.area,"normalPa":row.stress_normal,"bendingPa":row.stress_bend,
                        "compressionPa":row.compression,"tensionPa":row.tension,"shearPa":row.shear,
                        "utilisation":row.utilisation,"damageArea":row.damage,"remainingArea":row.remaining_area,"broken":row.broken,
                        "elasticPa":[strength.compression_elastic,strength.tension_elastic,strength.shear_elastic],
                        "fatalPa":[strength.compression_fatal,strength.tension_fatal,strength.shear_fatal]})
                }).collect();
                impact_verdicts.push(json!({"tick":tick,"bonds":rows}));
            }
            assert!(scene.world.native_validate_mappings().unwrap());
        }
        let row = json!({"model":name,"chunks":scene.parts.len(),"hulls":scene.hulls,"bonds":scene.bonds.len(),
            "target":target,"projectileMassKg":crate::garage_bombardment::BALL_MASS,"speedMps":55.,
            "brokenBonds":broken,"error":error,"frames":frames,"impactVerdicts":impact_verdicts});
        eprintln!("Authored cannon {name}: {} broken / {} bonds; error={error:?}",broken.len(),scene.bonds.len());
        reports.push(row);
        // Persist each model before assertions so a native rejection remains evidence.
        let report = std::env::var("VIBE_VEHICLE_FRACTURE_REPORT").unwrap_or_else(|_| "/tmp/authored-vehicle-cannon.json".into());
        std::fs::write(report,serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
        if let Some(error) = error { failures.push(format!("{name}: {error}")); }
        else if broken.is_empty() { failures.push(format!("{name}: real cannon contact produced no fracture")); }
        else if broken.len() * 4 >= scene.bonds.len() { failures.push(format!("{name}: cannon caused widespread fracture")); }
        scene.world.native_clear().unwrap();
        scene.world.remove_actor(scene.entity).unwrap();
    }
    assert!(failures.is_empty(), "authored vehicle impact failures: {failures:#?}");
}
