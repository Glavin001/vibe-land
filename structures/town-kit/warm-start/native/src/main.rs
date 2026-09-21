//! Whole-scene native bake/reload review, preserving one structure per placement.
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc, time::Instant};
use vibe_land_destruction::{
    city_config::stress_settings, ids, manifest::DestructionManifest,
    native_runtime::NativeCityDestruction, scene_binary, scene_warm,
};
use vibe_land_physx_bridge::*;
type R<T> = Result<T, Box<dyn std::error::Error>>;

fn save(path: &Path, report: &Value) -> R<()> {
    fs::write(path, serde_json::to_vec_pretty(report)?)?;
    Ok(())
}
fn capture(
    world: &World,
    manifest: &DestructionManifest,
    tick: u32,
    frames: &mut Vec<Value>,
) -> R<()> {
    let bodies = world.native_chunk_body_snapshots()?;
    let mut poses = Vec::new();
    let mut global = 0;
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            let p = world.native_chunk_aim(structure.structure_id, chunk.node_index)?;
            if !p.found {
                return Err("missing chunk pose".into());
            }
            let body = bodies
                .iter()
                .find(|b| b.entity_id == p.entity_id)
                .ok_or("missing chunk body")?;
            let q = &body.rotation;
            poses.push(json!([
                global,
                [p.center.x, p.center.y, p.center.z, q.x, q.y, q.z, q.w],
                p.entity_id
            ]));
            global += 1;
        }
    }
    let bs:Vec<_>=bodies.iter().map(|b|json!({"id":b.entity_id,"island":b.island_id,"position":[b.position.x,b.position.y,b.position.z],"rotation":[b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w],"sleeping":b.sleeping,"kinematic":b.kinematic})).collect();
    frames.push(
        json!({"time":tick as f32/60.,"poses":poses,"bodies":bs,"removedBodies":[],"broken":[]}),
    );
    Ok(())
}
fn run(bytes: &[u8], mode: &str, dir: &Path, report: &mut Value) -> R<()> {
    let scene = scene_binary::decode_city(bytes)?;
    let pack = &scene.variants[0].pack;
    let manifest = Arc::new(DestructionManifest::from_city(&scene));
    let chunks: usize = manifest.structures.iter().map(|s| s.chunks.len()).sum();
    let bonds: usize = manifest.structures.iter().map(|s| s.bonds.len()).sum();
    report["structures"] = json!(manifest.structures.len());
    report["chunks"] = json!(chunks);
    report["bonds"] = json!(bonds);
    let mut config = WorldConfig::default();
    config.gravity = Vec3::new(0., -9.81, 0.);
    config.cpu_threads = 2;
    config.gpu_max_rigid_contacts = 1_048_576;
    config.gpu_max_rigid_patches = 1_048_576;
    config.gpu_heap_capacity = 536_870_912;
    config.gpu_collision_stack_size = 134_217_728;
    let mut world = World::new(config)?;
    world.add_static_box(StaticBoxDesc {
        entity_id: 0x10000001,
        user_id: 0,
        pose: Pose {
            position: Vec3::new(0., -0.75, 0.),
            rotation: Quat::IDENTITY,
        },
        half_extents: Vec3::new(5000., 0.75, 5000.),
        collision_group: 1,
        collision_mask: (1 << 0) | (1 << 1) | (1 << 5),
    })?;
    let _backend = NativeCityDestruction::build(
        manifest.clone(),
        &mut world,
        stress_settings(&pack.materials),
        60,
    )
    .map_err(|e| e.to_string())?;
    let runtime_path = world.native_warm_runtime_path()?;
    let runtime_hash = scene_warm::sha256(&fs::read(&runtime_path)?);
    report["runtime"] = json!({"path":runtime_path,"sha256":runtime_hash});
    if bytes.starts_with(b"VLSW") {
        let warm = scene_warm::decode(bytes)?;
        if !warm.compatible(&runtime_hash, [0., -9.81, 0.], 1. / 60., 1e-5) {
            return Err("warm runtime/settings mismatch".into());
        }
        if !warm.descriptor.complete {
            return Err("whole-scene review requires complete warm coverage".into());
        }
        if world
            .native_import_warm_start(&warm.values[..warm.values.len() - 1])
            .is_ok()
        {
            return Err("short input accepted".into());
        }
        let mut invalid = warm.values.clone();
        invalid[0] = f32::NAN;
        if world.native_import_warm_start(&invalid).is_ok() {
            return Err("non-finite input accepted".into());
        }
        world.native_import_warm_start(&warm.values)?;
        if world.native_import_warm_start(&warm.values).is_ok() {
            return Err("duplicate import accepted".into());
        }
        report["warmImported"] = json!(true);
    } else if mode != "bake" {
        return Err("verify/damage requires a warm binary".into());
    }
    let mut quiet = 0;
    let mut tick = 0;
    let mut frames = Vec::new();
    let mut times = Vec::new();
    let started = Instant::now();
    while quiet < 1860 {
        tick += 1;
        let step = Instant::now();
        world.step()?;
        let s = world.native_tick()?;
        times.push(step.elapsed().as_secs_f64() * 1000.);
        let broken = world.native_take_broken_bonds()?;
        if s.error != 0 || !s.observed || s.degraded || s.missed_frames != 0 {
            return Err(format!("rejected native step: {s:?}").into());
        }
        if !broken.is_empty() || s.broken_bonds != 0 || s.crushed_chunks != 0 {
            return Err("spontaneous destruction".into());
        }
        let bodies = world.native_chunk_body_snapshots()?;
        let awake = bodies
            .iter()
            .filter(|b| !b.kinematic && !b.sleeping)
            .count();
        for b in bodies {
            if ids::body_entity_parts(b.entity_id).0 >= manifest.structures.len() as u32 {
                return Err("body identity mismatch".into());
            }
        }
        if tick == 1 {
            report["firstStep"] =
                json!({"converged":s.converged,"iterations":s.iterations,"milliseconds":times[0]});
        }
        if s.converged && report["firstConvergedTick"].is_null() {
            report["firstConvergedTick"] = json!(tick);
        }
        if s.converged && awake == 0 {
            quiet += 1;
        } else {
            quiet = 0;
        }
        report["lastStep"] = json!({"tick":tick,"converged":s.converged,"iterations":s.iterations,"awake":awake,"quietTicks":quiet});
        if tick == 1 || tick % 600 == 0 {
            capture(&world, &manifest, tick, &mut frames)?;
        }
        world.native_take_island_events()?;
        world.native_take_chunk_migrations()?;
        if tick % 120 == 0 {
            eprintln!("{mode}: {}", report["lastStep"]);
            save(&dir.join("progress.json"), report)?;
        }
        if tick >= 5400 {
            return Err(
                "whole scene failed intact convergence/rest within 90 simulated seconds".into(),
            );
        }
    }
    report["stability"] = json!({"passed":true,"idleSeconds":30,"zeroSpontaneousDamage":true,"equilibriumTick":tick-1860,"wallSeconds":started.elapsed().as_secs_f64()});
    if mode == "bake" {
        let values = world.native_export_warm_start()?;
        if values.len() != bonds * 6 {
            return Err("export bond count".into());
        }
        if world.native_import_warm_start(&values).is_ok() {
            return Err("late import accepted".into());
        }
        let raw: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        fs::write(dir.join("forces.f32"), &raw)?;
        report["warmExport"] = json!({"sha256":scene_warm::sha256(&raw),"values":values.len()});
    }
    if mode == "damage" {
        let i = pack
            .node_types
            .iter()
            .position(|s| s == "table-top")
            .ok_or("no table to test")?;
        let c = pack.nodes[i].centroid;
        world.native_fire_round(RoundDesc {
            position: Vec3::new(c.x, c.y + 0.85, c.z),
            direction: Vec3::new(0., -1., 0.),
            momentum_ns: 40000.,
            radius: 0.3,
            speed: 30.,
            ttl_ticks: 180,
        })?;
        let mut broken = std::collections::HashSet::new();
        let mut rest = 0;
        for step in 1..=3600 {
            world.step()?;
            let s = world.native_tick()?;
            tick += 1;
            if s.error != 0 || !s.observed || s.degraded || s.missed_frames != 0 {
                return Err("rejected damage step".into());
            }
            for b in world.native_take_broken_bonds()? {
                broken.insert(b.bond_id);
                if ids::bond_id_parts(b.bond_id).0 != 0 {
                    return Err("damage reached independent remote building".into());
                }
            }
            let awake = world
                .native_chunk_body_snapshots()?
                .iter()
                .filter(|b| !b.kinematic && !b.sleeping)
                .count();
            if s.converged && awake == 0 {
                rest += 1;
            } else {
                rest = 0;
            }
            if step == 1 || step % 300 == 0 {
                capture(&world, &manifest, tick, &mut frames)?;
            }
            world.native_take_island_events()?;
            world.native_take_chunk_migrations()?;
            if step >= 900 && rest >= 60 {
                break;
            }
        }
        report["destruction"] =
            json!({"brokenBonds":broken.len(),"restTicks":rest,"otherBuildingsDamaged":false});
        if broken.is_empty() || rest < 60 {
            return Err("damage failed to break and return to convergence/rest".into());
        }
    }
    capture(&world, &manifest, tick, &mut frames)?;
    let mut gzip = std::process::Command::new("gzip")
        .arg("-c")
        .stdin(std::process::Stdio::piped())
        .stdout(fs::File::create(dir.join("recording.json.gz"))?)
        .spawn()?;
    serde_json::to_writer(
        gzip.stdin.take().ok_or("gzip stdin")?,
        &json!({"version":1,"bodyEncoding":"delta","frames":frames}),
    )?;
    if !gzip.wait()?.success() {
        return Err("recording compression failed".into());
    }
    times.sort_by(|a, b| a.total_cmp(b));
    report["timing"] = json!({"medianMs":times[times.len()/2],"p95Ms":times[times.len()*95/100],"peakMs":times[times.len()-1],"exclusiveGpu":false});
    if !world.native_validate_mappings()? {
        return Err("native mapping failure".into());
    }
    world.native_clear()?;
    Ok(())
}
fn main() -> R<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("ids") {
        for structure in 0..ids::MAX_STRUCTURES {
            for serial in [0, 1, 65535, ids::MAX_ISLAND_SERIALS - 1] {
                let native = native_entity_id(structure, serial);
                assert_eq!(native, ids::body_entity(structure, serial));
                assert_eq!(ids::body_entity_parts(native), (structure, serial));
            }
        }
        println!("Native/Rust ID parity passed for all 255 structures and serial boundaries");
        return Ok(());
    }

    if args.len() != 4 {
        return Err("usage: SCENE bake|verify|damage OUT".into());
    }
    let bytes = fs::read(&args[1])?;
    let dir = Path::new(&args[3]);
    fs::create_dir_all(dir)?;
    let mut report = json!({"passed":false,"sceneSha256":scene_warm::sha256(&bytes),"mode":args[2],"gravity":9.81,"timestep":1./60.,"tolerance":1e-5,"exclusiveGpu":false});
    match run(&bytes, &args[2], dir, &mut report) {
        Ok(()) => report["passed"] = json!(true),
        Err(e) => report["error"] = json!(e.to_string()),
    };
    save(&dir.join("report.json"), &report)?;
    println!("{report}");
    if report["passed"] != true {
        std::process::exit(1);
    }
    Ok(())
}
