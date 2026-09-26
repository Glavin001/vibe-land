//! Full authored geometry probes. These do not claim moving-suspension fidelity:
//! they isolate real asset registration and material fracture in free fall.
use super::{bridge, tests::gpu_test_guard, PhysxPhysicsArena, Vector3, GROUP_DYNAMIC, ALL_GROUPS};
use crate::vehicle_assets::PreparedGeometry;
use serde_json::json;

const STRUCTURE: u32 = 200;
const MODELS: [&str; 6] = ["buggy", "trophy", "rally", "monster", "derby", "sprint"];

/// Optional native equation recording is process-global and write-once. Keep
/// scenarios separate and restore the caller's environment when a scene ends,
/// including on assertion failure. Callers hold the shared GPU test lock.
struct EquationCapture(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl EquationCapture {
    fn for_scene(model: &str, scenario: &str) -> Self {
        let Some(directory) = std::env::var_os("VIBE_VEHICLE_CAPTURE_DIR") else {
            return Self(Vec::new());
        };
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        let prefix = format!("{scenario}-{model}");
        let values = [
            ("PHYSX_COMPONENT_WORK_OUTPUT", directory.join(format!("{prefix}.components.jsonl")).into_os_string()),
            ("PHYSX_STRESS_PROBLEM_PREFIX", directory.join(prefix).into_os_string()),
            ("PHYSX_STRESS_PROBLEM_SOLVES", "0:200".into()),
        ];
        let saved = values.iter().map(|(key, _)| (*key, std::env::var_os(key))).collect();
        for (key, value) in values { std::env::set_var(key, value); }
        Self(saved)
    }
}
impl Drop for EquationCapture {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            if let Some(value) = value { std::env::set_var(key, value); }
            else { std::env::remove_var(key); }
        }
    }
}

#[test]
fn equation_capture_separates_scenarios_and_restores_environment_on_failure() {
    let _guard = gpu_test_guard();
    let keys = ["VIBE_VEHICLE_CAPTURE_DIR", "PHYSX_COMPONENT_WORK_OUTPUT",
        "PHYSX_STRESS_PROBLEM_PREFIX", "PHYSX_STRESS_PROBLEM_SOLVES"];
    let _restore = EquationCapture(keys.into_iter().map(|key| (key, std::env::var_os(key))).collect());
    std::env::remove_var("VIBE_VEHICLE_CAPTURE_DIR");
    std::env::set_var("PHYSX_COMPONENT_WORK_OUTPUT", "original-components");
    std::env::set_var("PHYSX_STRESS_PROBLEM_PREFIX", "original-prefix");
    std::env::remove_var("PHYSX_STRESS_PROBLEM_SOLVES");
    { let _capture = EquationCapture::for_scene("buggy", "nominal"); }
    assert_eq!(std::env::var("PHYSX_STRESS_PROBLEM_PREFIX").unwrap(), "original-prefix");
    let directory = std::env::temp_dir(); // No recording is performed by this CPU-only test.
    std::env::set_var("VIBE_VEHICLE_CAPTURE_DIR", &directory);
    let mut paths = std::collections::BTreeSet::new();
    for scenario in ["nominal", "heavy", "free-fall"] {
        {
            let _capture = EquationCapture::for_scene("buggy", scenario);
            let path = std::env::var_os("PHYSX_STRESS_PROBLEM_PREFIX").unwrap();
            assert_eq!(std::path::PathBuf::from(&path), directory.join(format!("{scenario}-buggy")));
            assert!(paths.insert(path));
        }
        assert_eq!(std::env::var("PHYSX_COMPONENT_WORK_OUTPUT").unwrap(), "original-components");
        assert_eq!(std::env::var("PHYSX_STRESS_PROBLEM_PREFIX").unwrap(), "original-prefix");
        assert!(std::env::var_os("PHYSX_STRESS_PROBLEM_SOLVES").is_none());
    }
    assert!(std::panic::catch_unwind(|| {
        let _capture = EquationCapture::for_scene("buggy", "interrupted");
        panic!("simulate a failed physics assertion");
    }).is_err());
    assert_eq!(std::env::var("PHYSX_STRESS_PROBLEM_PREFIX").unwrap(), "original-prefix");
    assert!(std::env::var_os("PHYSX_STRESS_PROBLEM_SOLVES").is_none());
}

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
        let _capture = EquationCapture::for_scene(&name, "free-fall");
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
    exercise_authored_impact(crate::garage_bombardment::BALL_MASS, 55., false);
}

/// A separate severe proof load targets the same physical wheel surface. The
/// material law is unchanged, and throttle remains applied after separation.
/// This checks functional loss in free fall, not surviving road handling.
#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn authored_vehicle_heavy_impact_disables_detached_wheel() {
    exercise_authored_impact(300., 120., true);
}

fn exercise_authored_impact(projectile_mass: f32, speed: f32, require_wheel_loss: bool) {
    let _guard = gpu_test_guard();
    let mut reports = Vec::new();
    let mut failures = Vec::new();
    for (name, geometry) in fixtures() {
        let _capture = EquationCapture::for_scene(&name, if require_wheel_loss { "heavy" } else { "nominal" });
        let mut scene = prepare(&geometry);
        if require_wheel_loss {
            scene.world.drive_vehicle(scene.entity, bridge::VehicleCommands {
                throttle: 0.5, ..Default::default()
            }).unwrap();
        }
        for tick in 0..30 {
            checked_step(&mut scene.world, &name, tick);
            assert!(scene.world.native_take_broken_bonds().unwrap().is_empty());
        }
        let target = scene.parts.iter().position(|p| p.wheel == 0).unwrap() as u32;
        let car = scene.world.vehicle_snapshots().unwrap()[0];
        if require_wheel_loss {
            assert!(car.wheel_rotation_speed[0].abs()>0.1, "{name}: targeted wheel must be driven before impact");
        }
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
        let velocity = direction * speed + Vector3::new(car.linear_velocity.x,car.linear_velocity.y,car.linear_velocity.z);
        scene.world.launch_dynamic_ball(bridge::LaunchedBallDesc {
            entity_id: 2, user_id: 0, pose: bridge::Pose { position: v(position), rotation: bridge::Quat::IDENTITY },
            radius: crate::garage_bombardment::BALL_RADIUS, mass: projectile_mass,
            linear_velocity: v(velocity), collision_group: GROUP_DYNAMIC, collision_mask: ALL_GROUPS,
        }).unwrap();
        let mut broken = std::collections::BTreeSet::new();
        let mut frames = Vec::new();
        let mut impact_verdicts = Vec::new();
        let mut error = None;
        let mut first_detached = None;
        let mut disabled_ticks = 0;
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
            let attached = corner.entity_id == chassis.entity_id;
            if !attached && first_detached.is_none() { first_detached = Some(tick); }
            if first_detached.is_some_and(|first| tick > first) {
                assert!(!attached, "{name}: detached wheel reattached without repair");
                assert_eq!(state.wheels_on_road & 1, 0, "{name}: detached wheel has road support");
                assert!(state.wheel_rotation_speed[0].abs()<1e-5, "{name}: Vehicle2 still drives detached wheel");
                disabled_ticks += 1;
            }
            frames.push(json!({"tick":tick,"contacts":status.normal_contacts,"broken":broken.len(),
                "converged":status.converged,"iterations":status.iterations,"error":status.error,"targetAttached":corner.entity_id==chassis.entity_id,
                "wheelSpeed":state.wheel_rotation_speed[0],"wheelsOnRoad":state.wheels_on_road,
                "driveConnectionMask":state.drive_connection_mask}));
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
                let ball = scene.world.body_snapshots().unwrap().into_iter()
                    .find(|body| body.entity_id == 2).unwrap();
                impact_verdicts.push(json!({"tick":tick,"bonds":rows,
                    "projectileVelocity":[ball.linear_velocity.x,ball.linear_velocity.y,ball.linear_velocity.z],
                    "chassisVelocity":[state.linear_velocity.x,state.linear_velocity.y,state.linear_velocity.z]}));
            }
            assert!(scene.world.native_validate_mappings().unwrap());
        }
        let row = json!({"model":name,"chunks":scene.parts.len(),"hulls":scene.hulls,"bonds":scene.bonds.len(),
            "target":target,"projectileMassKg":projectile_mass,"speedMps":speed,
            "requiresWheelLoss":require_wheel_loss,"disabledWheelTicks":disabled_ticks,
            "initialProjectileVelocity":[velocity.x,velocity.y,velocity.z],
            "initialChassisVelocity":[car.linear_velocity.x,car.linear_velocity.y,car.linear_velocity.z],
            "brokenBonds":broken,"error":error,"frames":frames,"impactVerdicts":impact_verdicts});
        eprintln!("Authored cannon {name}: {} broken / {} bonds; error={error:?}",broken.len(),scene.bonds.len());
        reports.push(row);
        // Persist each model before assertions so a native rejection remains evidence.
        let mut report = std::path::PathBuf::from(std::env::var("VIBE_VEHICLE_FRACTURE_REPORT")
            .unwrap_or_else(|_| "/tmp/authored-vehicle-cannon.json".into()));
        if require_wheel_loss {
            let stem = report.file_stem().unwrap().to_string_lossy();
            report.set_file_name(format!("{stem}-heavy.json"));
        }
        std::fs::write(report,serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
        if let Some(error) = error { failures.push(format!("{name}: {error}")); }
        else if broken.is_empty() { failures.push(format!("{name}: real cannon contact produced no fracture")); }
        else if broken.len() * 4 >= scene.bonds.len() { failures.push(format!("{name}: cannon caused widespread fracture")); }
        else if require_wheel_loss && disabled_ticks < 30 {
            failures.push(format!("{name}: heavy impact did not produce sustained wheel loss"));
        }
        scene.world.native_clear().unwrap();
        scene.world.remove_actor(scene.entity).unwrap();
    }
    assert!(failures.is_empty(), "authored vehicle impact failures: {failures:#?}");
}
