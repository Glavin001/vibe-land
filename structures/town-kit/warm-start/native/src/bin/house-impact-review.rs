//! Matched physical city cannonball test; no injected bond damage or debris assists.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::Arc,
    time::Instant,
};
use vibe_land_destruction::{
    city::single_building_scene, city_config::stress_settings, manifest::DestructionManifest,
    native_runtime::NativeCityDestruction, scene_pack::load_scene_pack_file, scene_warm,
};
use vibe_land_physx_bridge::*;
extern "C" {
    fn town_kit_impact_diagnostics(scene: usize, output: *mut u64) -> u32;
}
fn failed_step_diagnostics(w: &World, report: &mut Value) {
    let mut out = [0u64; 8];
    if let Ok(scene) = w.scene_ptr() {
        let error = unsafe { town_kit_impact_diagnostics(scene, out.as_mut_ptr()) };
        report["stressTopologyFailure"] = json!({"cudaError":error,"error":out[0],"initialized":out[1],"generation":out[2],"solvedGeneration":out[3],"rebuilds":out[4],"islands":out[5],"activeBonds":out[6],"activeNodes":out[7],"acceptedSimulation":false});
    }
}
#[allow(dead_code)]
mod meteor { include!(concat!(env!("OUT_DIR"), "/meteor_planner.rs")); }
type R<T> = Result<T, Box<dyn std::error::Error>>;
fn capture(w: &World, m: &DestructionManifest, t: u32) -> R<Value> {
    let bs = w.native_chunk_body_snapshots()?;
    let lookup: HashMap<_, _> = bs.iter().map(|b| (b.entity_id, b)).collect();
    let mut poses = Vec::new();
    for c in &m.structures[0].chunks {
        let a = w.native_chunk_aim(0, c.node_index)?;
        if a.found {
            let b = lookup.get(&a.entity_id).ok_or("missing body")?;
            let q = &b.rotation;
            poses.push(json!([
                c.node_index,
                [a.center.x, a.center.y, a.center.z, q.x, q.y, q.z, q.w],
                a.entity_id
            ]));
        }
    }
    Ok(
        json!({"time":t as f64/60.,"poses":poses,"bodies":bs.iter().map(|b|json!({"id":b.entity_id,"position":[b.position.x,b.position.y,b.position.z],"rotation":[b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w],"sleeping":b.sleeping,"kinematic":b.kinematic,"nodes":b.node_count,"linearVelocity":[b.linear_velocity.x,b.linear_velocity.y,b.linear_velocity.z],"angularVelocity":[b.angular_velocity.x,b.angular_velocity.y,b.angular_velocity.z]})).collect::<Vec<_>>(),"removedBodies":[],"broken":[]}),
    )
}
fn run(asset: &Path, dir: &Path, report: &mut Value) -> R<()> {
    let shot: Value = serde_json::from_slice(&fs::read(dir.join("shot.json"))?)?;
    let ground_top = shot["groundTop"].as_f64().unwrap_or(0.) as f32;
    report["groundTopM"] = json!(ground_top);
    let pack = load_scene_pack_file(asset)?;
    let manifest = Arc::new(DestructionManifest::from_city(&single_building_scene(
        &pack,
    )));
    let mut cfg = WorldConfig::default();
    cfg.gravity = Vec3::new(0., -9.81, 0.);
    cfg.cpu_threads = 2;
    cfg.gpu_max_rigid_contacts = 1_048_576;
    cfg.gpu_max_rigid_patches = 1_048_576;
    cfg.gpu_heap_capacity = 536_870_912;
    cfg.gpu_collision_stack_size = 134_217_728;
    let mut w = World::new(cfg)?;
    w.add_static_box(StaticBoxDesc {
        entity_id: 0x10000001,
        user_id: 0,
        pose: Pose {
            position: Vec3::new(0., ground_top - 0.75, 0.),
            rotation: Quat::IDENTITY,
        },
        half_extents: Vec3::new(500., 0.75, 500.),
        collision_group: 1,
        collision_mask: 63,
    })?;
    let _backend = NativeCityDestruction::build(
        manifest.clone(),
        &mut w,
        stress_settings(&pack.materials),
        60,
    )
    .map_err(|e| e.to_string())?;
    let runtime = w.native_warm_runtime_path()?;
    report["runtime"] = json!({"path":runtime,"sha256":scene_warm::sha256(&fs::read(&runtime)?)});
    report["chunks"] = json!(pack.nodes.len());
    report["bonds"] = json!(pack.bonds.len());
    let mut quiet = 0;
    let mut tick = 0;
    while quiet < 1800 && tick < 5400 {
        tick += 1;
        if let Err(e) = w.step() {
            report["failedNativeStatus"] = json!(format!("{:?}", w.native_tick()));
            failed_step_diagnostics(&w, report);
            return Err(e.into());
        }
        let s = w.native_tick()?;
        if s.error != 0 || !s.observed || s.degraded || s.missed_frames != 0 {
            return Err(format!("intact rejected step {s:?}").into());
        }
        if !w.native_take_broken_bonds()?.is_empty() || s.broken_bonds != 0 || s.crushed_chunks != 0
        {
            return Err(format!("spontaneous destruction at {tick}: {s:?}").into());
        }
        let awake = w
            .native_chunk_body_snapshots()?
            .iter()
            .filter(|b| !b.kinematic && !b.sleeping)
            .count();
        if s.converged && awake == 0 {
            quiet += 1
        } else {
            quiet = 0
        };
        w.native_take_island_events()?;
        w.native_take_chunk_migrations()?;
        if tick % 600 == 0 {
            eprintln!(
                "intact tick {tick} quiet {quiet} awake {awake} converged {}",
                s.converged
            );
        }
    }
    report["intact"] = json!({"passed":quiet>=1800,"ticks":tick,"idleTicks":quiet});
    if quiet < 1800 {
        return Err("intact convergence/rest timeout".into());
    }
    if shot["mode"] == "idle" {
        fs::write(
            dir.join("recording.json"),
            serde_json::to_vec(&json!({"frames":[capture(&w,&manifest,0)?]}))?,
        )?;
        report["completed"] = json!(true);
        return Ok(());
    }
    let sample_ticks = shot["sampleTicks"].as_u64().unwrap_or(0) as u32;
    let duration_ticks = shot["durationTicks"].as_u64().unwrap_or(1800) as u32;
    let start = shot["position"].as_array().ok_or("shot position")?;
    let dirv = shot["direction"].as_array().ok_or("shot direction")?;
    let p: Vec<f32> = start.iter().map(|x| x.as_f64().unwrap() as f32).collect();
    let d: Vec<f32> = dirv.iter().map(|x| x.as_f64().unwrap() as f32).collect();
    let (mass, radius, velocity, p, ttl) = if shot["kind"] == "meteor" {
        let tuning = meteor::MeteorTuning::from_env();
        let target = glam::Vec3::new(p[0], p[1], p[2]);
        let launch = meteor::plan(target, glam::Vec3::new(0., -9.81, 0.), &tuning,
            &mut meteor::Rng::new(shot["seed"].as_u64().unwrap_or(20260921)));
        report["meteorPlan"] = json!({"target":p,"flightTimeS":launch.flight_time_s,"seed":shot["seed"],"source":"server/src/meteor.rs"});
        (tuning.mass_kg, tuning.radius_m, launch.velocity.to_array(), launch.start.to_array().to_vec(), tuning.ttl_ticks)
    } else {
        let mass = 10650f32;
        (mass, (mass / 7850. * 3. / (4. * std::f32::consts::PI)).cbrt(), [d[0]*60., d[1]*60., d[2]*60.], p, 360)
    };
    report["projectile"] = json!({"massKg":mass,"radiusM":radius,"velocity":velocity,"ttlTicks":ttl,"position":p,"api":"launch_dynamic_ball"});
    let mut frames = vec![capture(&w, &manifest, 0)?];
    w.launch_dynamic_ball(LaunchedBallDesc {
        entity_id: 0x200ffff0,
        user_id: 0xffff0,
        pose: Pose {
            position: Vec3::new(p[0], p[1], p[2]),
            rotation: Quat::IDENTITY,
        },
        radius,
        mass,
        linear_velocity: Vec3::new(velocity[0], velocity[1], velocity[2]),
        collision_group: 2,
        collision_mask: 63,
    })?;
    let mut broken = HashSet::new();
    let mut series = Vec::new();
    let mut peak_speed = 0f32;
    let mut max_awake = 0;
    let mut nonconverged = 0;
    let mut escaped = HashSet::new();
    let mut events = Vec::new();
    let mut impact_quiet_ticks = 0u32;
    for t in 1..=duration_ticks {
        let now = Instant::now();
        if let Err(e) = w.step() {
            report["failedNativeStatus"] = json!(format!("{:?}", w.native_tick()));
            failed_step_diagnostics(&w, report);
            return Err(e.into());
        }
        let s = w.native_tick()?;
        let ms = now.elapsed().as_secs_f64() * 1000.;
        if s.error != 0 || !s.observed || s.degraded || s.missed_frames != 0 {
            return Err(format!("damage rejected step {t} {s:?}").into());
        }
        let newly = w.native_take_broken_bonds()?;
        for b in newly {
            broken.insert(b.bond_id);
            events.push(json!({"tick":t,"bond":b.bond_id}));
        }
        let bodies = w.native_chunk_body_snapshots()?;
        let awake = bodies
            .iter()
            .filter(|b| !b.kinematic && !b.sleeping)
            .count();
        let dynamic_nodes: u32 = bodies
            .iter()
            .filter(|b| !b.kinematic)
            .map(|b| b.node_count)
            .sum();
        let mut max_speed = 0f32;
        for b in bodies {
            let v = &b.linear_velocity;
            max_speed = max_speed.max((v.x * v.x + v.y * v.y + v.z * v.z).sqrt());
            if b.position.y < -10. || b.position.x.abs() > 500. || b.position.z.abs() > 500. {
                escaped.insert(b.entity_id);
            }
        }
        peak_speed = peak_speed.max(max_speed);
        max_awake = max_awake.max(awake);
        if !s.converged {
            nonconverged += 1;
        }
        if s.converged && awake == 0 {
            impact_quiet_ticks += 1;
        } else {
            impact_quiet_ticks = 0;
        }
        // Capture the actual rigid projectile every physics tick, including its
        // velocity on each side of contact; visual chunk poses cannot prove a rebound.
        let projectile = w.body_snapshots()?.into_iter().find(|b| b.entity_id == 0x200ffff0)
            .map(|b| json!({"position":[b.pose.position.x,b.pose.position.y,b.pose.position.z],
                "velocity":[b.linear_velocity.x,b.linear_velocity.y,b.linear_velocity.z]}));
        series.push(json!({"projectile":projectile,"tick":t,"ms":ms,"broken":broken.len(),"awake":awake,"dynamicNodes":dynamic_nodes,"bodies":bodies.len(),"speed":max_speed,"converged":s.converged,"iterations":s.iterations,"contacts":s.normal_contacts,"crushed":s.crushed_chunks,"correctionPasses":s.correction_passes,"stressPasses":s.stress_passes}));
        w.native_take_island_events()?;
        w.native_take_chunk_migrations()?;
        if (sample_ticks > 0 && t % sample_ticks == 0) || t == duration_ticks || [1, 6, 15, 30, 60, 120, 300, 600, 1200, 1800].contains(&t) {
            frames.push(capture(&w, &manifest, t)?);
        }
        if t % 120 == 0 || t == 1 {
            eprintln!("impact {}", series.last().unwrap());
        }
        if t == ttl {
            w.remove_actor(0x200ffff0)?;
        }
    }
    report["impact"] = json!({"broken":broken.len(),"peakSpeedMs":peak_speed,"maxAwake":max_awake,"unconvergedTicks":nonconverged,"escapedBodies":escaped.len(),"convergedRestTicks":impact_quiet_ticks,"settledCasePassed":impact_quiet_ticks>=60 && escaped.is_empty() && !broken.is_empty(),"last":series.last()});
    fs::write(dir.join("series.json"), serde_json::to_vec(&series)?)?;
    fs::write(dir.join("events.json"), serde_json::to_vec(&events)?)?;
    fs::write(
        dir.join("recording.json"),
        serde_json::to_vec(&json!({"frames":frames}))?,
    )?;
    report["completed"] = json!(true);
    Ok(())
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let asset = Path::new(&args[1]);
    let dir = Path::new(&args[2]);
    fs::create_dir_all(dir).unwrap();
    let mut report = json!({"completed":false,"exclusiveGpu":false,"assetSha256":scene_warm::sha256(&fs::read(asset).unwrap())});
    if let Err(e) = run(asset, dir, &mut report) {
        report["error"] = json!(e.to_string());
    }
    fs::write(
        dir.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
    if report["completed"] != true {
        std::process::exit(1);
    }
}
