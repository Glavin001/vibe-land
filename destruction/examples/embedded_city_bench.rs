//! Headless production-consumer benchmark. Run sequentially on an idle GPU.
//! Usage: embedded_city_bench OUTPUT_DIR TILE_GRID STEPS WAVES
//! One tile = four disconnected 444-chunk / 896-bond buildings. No render/network.
use serde_json::json;
use std::io::{BufWriter, Write};
use std::{collections::HashSet, error::Error, fs, path::Path, sync::Arc, time::Instant};
use vibe_land_destruction::{
    city::{build_city_scene, CitySceneDesc},
    city_config::stress_settings,
    manifest::DestructionManifest,
    runtime::CityDestruction,
    scene_pack::load_scene_pack_file,
};
use vibe_land_physx_bridge::{
    DynamicSphereDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig,
};

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::IDENTITY,
    }
}
fn ms(t: std::time::Duration) -> f64 {
    t.as_secs_f64() * 1000.
}
fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("usage: embedded_city_bench OUTPUT_DIR TILE_GRID STEPS WAVES".into());
    }
    let output = Path::new(&args[1]);
    if output.exists() {
        return Err("output already exists; retain previous evidence".into());
    }
    let grid: u32 = args[2].parse()?;
    let steps: u32 = args[3].parse()?;
    let waves: u32 = args[4].parse()?;
    if !(1..=8).contains(&grid)
        || steps == 0
        || waves > 3
        || (waves > 0 && steps <= 30 + (waves - 1) * 150)
    {
        return Err("grid must be 1..8; 0..3 waves at ticks 30/180/330 must fit the run".into());
    }
    // Freeze the benchmark inputs instead of inheriting a developer's material dials.
    for (key, value) in [
        ("VIBE_PHYSX_DIRECT_GPU", "0"),
        ("VIBE_CITY_FREEZE", "0"),
        ("VIBE_CITY_STRESS_LIMIT_SCALE", "1"),
        ("VIBE_WORLD_GRAVITY", "9.81"),
        ("VIBE_WORLD_FRICTION", "0.5"),
        ("VIBE_WORLD_RESTITUTION", "0.1"),
        ("VIBE_CITY_DEBRIS_LINEAR_DAMPING", "0"),
        ("VIBE_CITY_DEBRIS_ANGULAR_DAMPING", "0"),
    ] {
        std::env::set_var(key, value);
    }
    fs::create_dir_all(output)?;
    let initial = Instant::now();
    let pack = load_scene_pack_file(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/scenes/embedded-four-buildings.json"),
    )?;
    let scene = build_city_scene(
        &pack,
        CitySceneDesc {
            grid,
            pitch_m: 0.,
            varied_heights: false,
        },
    )?;
    let mut commands = vec![Vec::new(); steps as usize];
    for wave in 0..waves {
        for instance in &scene.instances {
            for z in [-8.98, 8.98] {
                for x in [-8.98, 8.98] {
                    // Launch from the street, facing the near facade. All 256 shots are
                    // submitted on the same tick; insertion cost belongs to that tick.
                    commands[(30 + wave * 150) as usize].push(pose(
                        instance.offset.x + x,
                        7.5,
                        instance.offset.z + z - 8.,
                    ));
                }
            }
        }
    }
    let manifest = Arc::new(DestructionManifest::from_city(&scene));
    let mut settings = stress_settings(&pack.materials);
    settings.max_solver_iterations_per_frame = 8192;
    let mut world = World::new(WorldConfig::default())?;
    world.add_static_box(StaticBoxDesc {
        entity_id: 1,
        user_id: 0,
        pose: pose(0., -0.5, 0.),
        half_extents: Vec3::new(2000., 0.5, 2000.),
        collision_group: 1,
        collision_mask: u32::MAX,
    })?;
    let mut destruction = CityDestruction::build(manifest.clone(), &mut world, settings, 60)?;
    let initialization_ms = ms(initial.elapsed());
    let mut rows = Vec::with_capacity(steps as usize);
    // Preserve every accepted row even if a native crash prevents final report
    // generation. A partial JSONL file is evidence, never a passing campaign.
    let mut raw = BufWriter::new(fs::File::create(output.join("steps.jsonl"))?);
    let mut broken = HashSet::new();
    let mut projectile_count = 0u32;
    let mut minimum_com_y = f32::INFINITY;
    // Preserve the command tape even when a later simulation step fails.
    fs::write(output.join("commands.json"),serde_json::to_vec(&commands.iter().enumerate()
        .filter(|(_,shots)|!shots.is_empty()).map(|(tick,shots)|json!({"tick":tick,
          "positions":shots.iter().map(|p|[p.position.x,p.position.y,p.position.z]).collect::<Vec<_>>(),
          "mass":18000,"radius":0.5,"velocity":[0,0,40]})).collect::<Vec<_>>())?)?;
    for tick in 0..steps {
        let start = Instant::now();
        for &shot in &commands[tick as usize] {
            let id = 1000 + projectile_count;
            projectile_count += 1;
            world.add_dynamic_sphere(DynamicSphereDesc {
                entity_id: id,
                user_id: 0,
                pose: shot,
                radius: 0.5,
                mass: 18000.,
                collision_group: 1,
                collision_mask: u32::MAX,
            })?;
            world.apply_impulse(id, Vec3::new(0., 0., 720000.))?;
        }
        destruction.pre_step(&mut world);
        let commands_done = Instant::now();
        world.step()?;
        let physics_done = Instant::now();
        let events = destruction.post_step(&mut world, 1. / 60., [0., -9.81, 0.])?;
        let events_done = Instant::now();
        let stats = destruction.stats();
        let snapshots = destruction.staged_snapshots()?;
        let complete = Instant::now();
        // Audits and JSON/report work are outside the authoritative timer.
        for batch in &events.batches {
            for id in &batch.broken_bond_ids {
                if !broken.insert(*id) {
                    return Err(format!("duplicate committed bond {id} at tick {tick}").into());
                }
            }
        }
        let mut spans = serde_json::Map::new();
        for span in destruction.extra_spans() {
            spans.insert(span.name.clone(), json!(span.value));
        }
        if broken.len() != stats.broken_bonds as usize {
            return Err(format!("committed event/state mismatch at tick {tick}").into());
        }
        if spans.get("native_stress_passes").and_then(|v| v.as_f64())
            != Some(1.0 + stats.resim_passes as f64)
        {
            return Err("missing or duplicate native stress pass".into());
        }
        if stats.resim_passes > 1 {
            return Err("correction limit exceeded".into());
        }
        if tick < 30 && stats.broken_bonds != 0 {
            return Err("unloaded building fractured before first shot".into());
        }
        for body in snapshots {
            if !body.position.iter().all(|v| v.is_finite()) {
                return Err("nonfinite committed pose".into());
            }
            minimum_com_y = minimum_com_y.min(body.position[1]);
        }
        rows.push(json!({"tick":tick,"complete_step_ms":ms(complete-start),
            "commands_and_pre_step_ms":ms(commands_done-start),
            "native_physics_and_destruction_ms":ms(physics_done-commands_done),
            "game_observation_events_ms":ms(events_done-physics_done),
            "accepted_status_and_snapshots_ms":ms(complete-events_done),
            "projectiles":projectile_count,"fragment_bodies":stats.chunk_bodies,
            "awake_fragment_bodies":stats.awake_chunk_bodies,"broken_bonds":stats.broken_bonds,
            "normal_contacts":stats.contacts_processed,"native_corrections":stats.resim_passes,
            "native_counts":spans}));
        serde_json::to_writer(&mut raw, rows.last().unwrap())?;
        raw.write_all(b"\n")?;
        raw.flush()?;
        if tick % 60 == 0 {
            eprintln!(
                "tick {tick}/{steps}, fragments {}, awake {}, broken {}",
                stats.chunk_bodies, stats.awake_chunk_bodies, stats.broken_bonds
            );
        }
    }
    if !world.validate_destruction_mappings()? {
        return Err("invalid final chunk ownership".into());
    }
    if waves > 0 && steps >= 150 && broken.is_empty() {
        return Err("physical bombardment did not break any bonds".into());
    }
    let fields = [
        "complete_step_ms",
        "commands_and_pre_step_ms",
        "native_physics_and_destruction_ms",
        "game_observation_events_ms",
        "accepted_status_and_snapshots_ms",
    ];
    let mut summary = serde_json::Map::new();
    for key in fields {
        let mut values: Vec<_> = rows.iter().map(|r| r[key].as_f64().unwrap()).collect();
        values.sort_by(f64::total_cmp);
        summary.insert(key.into(),json!({"min":values[0],"mean":values.iter().sum::<f64>()/values.len() as f64,
            "p99":values[((values.len() as f64*0.99).ceil() as usize-1).min(values.len()-1)],"max":values[values.len()-1]}));
    }
    let peak = rows
        .iter()
        .max_by(|a, b| {
            a["complete_step_ms"]
                .as_f64()
                .unwrap()
                .total_cmp(&b["complete_step_ms"].as_f64().unwrap())
        })
        .unwrap();
    let report = json!({"schema":1,"status":"complete","backend":"physx_embedded_cuda",
        "direct_gpu_api":false,"sleeping":true,"max_correction":1,"max_stress_passes":2,
        "timestep_seconds":1./60.,"iterations_max":8192,"tolerance":1e-5,
        "asset_instances":grid*grid,"buildings":grid*grid*4,"chunks":scene.total_chunks(),"bonds":scene.total_bonds(),
        "steps":steps,"seconds":steps as f64/60.,"waves":waves,"projectiles":projectile_count,
        "initialization_ms":initialization_ms,"unique_broken_bonds":broken.len(),"minimum_fragment_com_y":minimum_com_y,
        "gate_8ms_misses":rows.iter().filter(|r|r["complete_step_ms"].as_f64().unwrap()>8.).count(),
        "gate_60hz_misses":rows.iter().filter(|r|r["complete_step_ms"].as_f64().unwrap()>1000./60.).count(),
        "timing_scope":"commands + native physics/stress/correction + mandatory game observations/events/snapshots; excludes preparation, rendering, network encoding, audit/report work",
        "qualification":"short integration screen; no endurance or speedup claim; compare only identical command/settings receipts",
        "phases_ms":summary,"peak_step":peak});
    fs::write(output.join("steps.json"), serde_json::to_vec(&rows)?)?;
    fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    let mut md=format!("# Embedded game-consumer bombardment\n\n{} buildings · {} chunks · {} bonds · {} projectiles · {} steps / {:.1} simulated seconds. Direct GPU API off, sleep on, correction ≤1.\n\n{}\n\n| Phase | Owner | Min ms | Mean ms | Max ms |\n|---|---|---:|---:|---:|\n",grid*grid*4,scene.total_chunks(),scene.total_bonds(),projectile_count,steps,steps as f64/60.,report["timing_scope"].as_str().unwrap());
    for (key, label, owner) in [
        (fields[0], "Complete advance", "CPU + GPU"),
        (
            fields[1],
            "Apply physical projectile commands / prepare",
            "CPU submits to PhysX",
        ),
        (
            fields[2],
            "Physics, stress, topology and correction",
            "PhysX CPU tasks + CUDA",
        ),
        (
            fields[3],
            "Consume accepted events and stage game snapshots",
            "CPU + explicit GPU observations",
        ),
        (fields[4], "Obtain staged status/snapshot views", "CPU"),
    ] {
        let p = &report["phases_ms"][key];
        md += &format!(
            "| {label} | {owner} | {:.3} | {:.3} | {:.3} |\n",
            p["min"].as_f64().unwrap(),
            p["mean"].as_f64().unwrap(),
            p["max"].as_f64().unwrap()
        );
    }
    md+=&format!("\nPeak tick: **{}**, {} projectiles, {} fragment bodies / {} awake, {} cumulative broken bonds. Misses: **{}** over 8 ms; **{}** over 16.67 ms. Initialization: {:.1} ms (separate).\n\nPhase maxima occur on potentially different ticks and must not be added. Raw rows retain every step. This is a short screen, not endurance or a comparison against the old backend. It excludes rendering/network encoding and is not a whole-game tick benchmark.\n",peak["tick"],peak["projectiles"],peak["fragment_bodies"],peak["awake_fragment_bodies"],peak["broken_bonds"],report["gate_8ms_misses"],report["gate_60hz_misses"],initialization_ms);
    fs::write(output.join("report.md"), md)?;
    eprintln!("report: {}", output.join("report.md").display());
    Ok(())
}
