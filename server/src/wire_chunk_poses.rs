//! A client must draw every chunk where the server has it.
//!
//! The wire sends an island body's pose in its centre-of-mass frame
//! (native_observation.cc), and a client places each member at
//! `body_pose ∘ (rest_local − island_com)`, computing `island_com` itself from
//! the manifest (topology.ts `restCentreOfMassOf`, mirrored by
//! `membership::ChunkIndex::rest_centre_of_mass`). That only reproduces the
//! server if the client's centre of mass IS the body's: PhysX centres a body on
//! each chunk's real centre of mass (`centroid + hull centerOfMass`), and the
//! town kit measures its sloped hulls from a corner, so a roof tile's mass sits
//! up to a metre from its centroid. Weighing centroids drew the veneer house's
//! roof 0.46 m above the server's the instant it split off -- the roof seen
//! jumping up with a gap above the walls before it fell.
//!
//! These compose every chunk of every dynamic island the client way, from the
//! body snapshot the wire carries and the manifest the client holds, and
//! compare it with the server's own placement of that chunk's shape (actor pose
//! × shape local pose, which is the chunk's centroid: `native_chunk_aim`).
//! Each also composes it the way the client did before mass offsets reached the
//! manifest, so a run shows the error the fix removed.
//!
//! One scene per process (the city scene is read once), so run each by name:
//!
//!   PHYSX_ROOT=../PhysX/out/install/garage-roof CARGO_TARGET_DIR=target/wire-com \
//!   VIBE_GPU_SHARED=1 scripts/perf/gpu-run.sh wire-com cargo test --release -p web-fps-server \
//!     --features native-destruction --lib wire_chunk_poses::<test> -- --ignored --nocapture --exact
//!
//! VIBE_WIRE_POSE_TICKS  ticks to watch after the impact (default 150)
//! VIBE_WIRE_POSE_PACK   another pack in place of the test's own
#![cfg(all(test, feature = "native-destruction"))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use glam::{Quat, Vec3};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::membership::ChunkIndex;

/// Client placement against server placement. A float pose composed at
/// ~10 m from the origin is good to microns; a millimetre is generous.
const AGREE_M: f32 = 1.0e-3;

static SCENE_TAKEN: AtomicBool = AtomicBool::new(false);

fn repo() -> std::path::PathBuf { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }

/// The native app's settings (sim-native city.rs apply_app_defaults), for the
/// pack alone on open ground, as the veneer film runs it.
fn open_scene(pack: &std::path::Path) {
    assert!(!SCENE_TAKEN.swap(true, Ordering::SeqCst),
        "the city scene is read once per process: run each wire_chunk_poses test on its own (--exact)");
    assert!(pack.is_file(), "{}: node structures/town-kit/scripts/build-veneer-houses.mjs", pack.display());
    for (name, value) in [
        ("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1"),
        ("VIBE_NATIVE_STRESS_FORCE_TOLERANCE", "0.001"),
        ("BLAST_STRESS_INCREMENTAL_MOTION", "1"),
        ("PX_DESTRUCTION_INCREMENTAL_TOPOLOGY", "1"),
        ("BLAST_STRESS_BALANCED_OPERATOR", "1"),
        ("VIBE_CITY_GRID", "1"),
        ("VIBE_CITY_VARIED_HEIGHTS", "0"),
        ("VIBE_CITY_VEHICLES", "0"),
        ("VIBE_CITY_DESTRUCTIBLE_VEHICLES", "0"),
    ] {
        if std::env::var_os(name).is_none() { std::env::set_var(name, value); }
    }
    std::env::set_var("VIBE_CITY_SCENE", pack);
    if std::env::var_os("VIBE_DESTRUCTION_ASSET_DIR").is_none() {
        std::env::set_var("VIBE_DESTRUCTION_ASSET_DIR", repo().join("destruction/assets/scenes"));
    }
}

/// Worst disagreement seen, and where.
#[derive(Default, Clone, Copy)]
struct Worst { metres: f32, tick: u32, structure: u32, node: u32, body: u32 }

impl Worst {
    fn see(&mut self, metres: f32, tick: u32, structure: u32, node: u32, body: u32) {
        if metres > self.metres { *self = Worst { metres, tick, structure, node, body }; }
    }
}

struct Tally {
    /// The client as fixed: each chunk weighs in at its own centre of mass.
    now: Worst,
    /// The client before: centroids weighed as if they were mass centres.
    before: Worst,
    /// Chunk placements compared (chunk-ticks on dynamic islands).
    compared: u64,
    /// Dynamic islands seen at once, at most.
    islands: usize,
    /// The first tick any dynamic island existed.
    first_split: Option<u32>,
    /// The largest dynamic island, the first tick it reached that size: its
    /// member count, the tick, and how far the old client drew it from the
    /// server (world vector, the same for every member).
    largest: (usize, u32, Vec3),
}

/// Compare every chunk of every dynamic island, this tick.
fn compare(world: &vibe_land_physx_bridge::World, manifest: &DestructionManifest, now: &ChunkIndex,
           before: &ChunkIndex, tick: u32, tally: &mut Tally) {
    let snapshots: HashMap<u32, (Vec3, Quat, bool, u32)> = world.native_chunk_body_snapshots().expect("snapshots")
        .iter().map(|s| (s.entity_id, (Vec3::new(s.position.x, s.position.y, s.position.z),
            Quat::from_xyzw(s.rotation.x, s.rotation.y, s.rotation.z, s.rotation.w), s.kinematic, s.island_id))).collect();
    // Membership from the server itself: this measures the frame convention,
    // not the client's bookkeeping of who is in which island.
    let mut members: HashMap<u32, Vec<(u32, u32, u32, Vec3)>> = HashMap::new();
    for structure in &manifest.structures {
        for chunk in &structure.chunks {
            let aim = world.native_chunk_aim(structure.structure_id, chunk.node_index).expect("aim");
            if !aim.found { continue; }
            let global = vibe_land_destruction::ids::chunk_id(structure.structure_id, chunk.node_index);
            let dense = now.dense_of(global).expect("chunk in index");
            members.entry(aim.entity_id).or_default()
                .push((dense, structure.structure_id, chunk.node_index, Vec3::new(aim.center.x, aim.center.y, aim.center.z)));
        }
    }
    let mut islands = 0;
    for (entity, chunks) in &members {
        let Some(&(position, rotation, kinematic, serial)) = snapshots.get(entity) else { continue };
        // The anchored remnant is drawn from the manifest's rest poses and
        // never streamed (native_runtime.rs): not a centre-of-mass frame.
        if kinematic || serial == 0 { continue; }
        islands += 1;
        let com_now = now.rest_centre_of_mass(chunks.iter().map(|c| c.0)).expect("members");
        let com_before = before.rest_centre_of_mass(chunks.iter().map(|c| c.0)).expect("members");
        if chunks.len() > tally.largest.0 {
            tally.largest = (chunks.len(), tick, rotation * (com_now - com_before));
        }
        for &(dense, structure, node, truth) in chunks {
            let rest = now.rest(dense);
            let drawn_now = position + rotation * (rest - com_now);
            let drawn_before = position + rotation * (rest - com_before);
            tally.now.see(drawn_now.distance(truth), tick, structure, node, *entity);
            tally.before.see(drawn_before.distance(truth), tick, structure, node, *entity);
            tally.compared += 1;
        }
    }
    if islands > 0 && tally.first_split.is_none() { tally.first_split = Some(tick); }
    tally.islands = tally.islands.max(islands);
}

fn node_type(pack: &std::path::Path) -> Vec<String> {
    let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(pack).unwrap()).unwrap();
    doc["scenario"]["nodeTypes"].as_array().map(|a| a.iter().map(|t| t.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}

/// Run a pack for `rest` ticks, optionally fire the city cannonball into it,
/// then watch `after` ticks, comparing every tick.
fn run(pack: std::path::PathBuf, rest: u32, cannonball: bool) -> Tally {
    let pack = std::env::var_os("VIBE_WIRE_POSE_PACK").map(std::path::PathBuf::from).unwrap_or(pack);
    let _guard = crate::physx_runtime::tests::gpu_test_guard();
    open_scene(&pack);
    let after: u32 = std::env::var("VIBE_WIRE_POSE_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(150);
    let types = node_type(&pack);
    let mut arena = crate::movement::PhysicsArena::new(vibe_netcode::movement::MoveConfig::default(),
        vibe_netcode::physics_backend::PhysicsBackendKind::PhysxGpu).expect("production arena");
    crate::demo_world::seed_world_for_match(&mut arena, "city-default").expect("city world");
    let mut city = crate::city::CityRuntime::open(60, arena.physx_world_mut()).expect("city opens");
    let (_, manifest, _) = crate::city::manifest_asset().expect("city scene asset");
    let now = ChunkIndex::from_manifest(manifest);
    let legacy = {
        let mut m = (**manifest).clone();
        for s in &mut m.structures { for c in &mut s.chunks { c.mass_offset = [0.0; 3]; } }
        ChunkIndex::from_manifest(&m)
    };
    let off_centre = manifest.structures.iter().flat_map(|s| &s.chunks)
        .filter(|c| c.mass_offset.iter().any(|x| x.abs() > 0.01)).count();
    eprintln!("{}: {} chunks, {off_centre} with their mass > 1 cm from their centroid",
        pack.file_name().unwrap().to_string_lossy(), manifest.total_chunks());
    let gravity = vibe_netcode::movement::default_world_gravity();
    let dt = 1.0 / 60.0;
    let mut tally = Tally { now: Worst::default(), before: Worst::default(), compared: 0, islands: 0, first_split: None,
        largest: (0, 0, Vec3::ZERO) };
    let mut tick = 0u32;
    let mut step = |arena: &mut crate::movement::PhysicsArena, city: &mut crate::city::CityRuntime, tick: &mut u32, tally: &mut Tally| {
        arena.step_vehicles_and_dynamics(dt);
        let _ = city.step(*tick, dt, gravity, arena.physx_world_mut());
        compare(arena.physx_world_mut().unwrap(), manifest, &now, &legacy, *tick, tally);
        *tick += 1;
    };
    for _ in 0..rest { step(&mut arena, &mut city, &mut tick, &mut tally); }
    if cannonball {
        let s = &manifest.structures[0];
        let aim = nalgebra::Vector3::new(s.world_position[0], 3.0, s.world_position[2]);
        let origin = aim + nalgebra::Vector3::new(20., 0.5, 0.);
        let speed = crate::city::city_ball_speed_ms();
        let t = 20. / speed;
        arena.launch_ball_from_muzzle(origin, (aim - origin) / t + nalgebra::Vector3::new(0., 0.5 * (vibe_netcode::movement::GRAVITY as f32) * t, 0.),
            crate::city::city_ball_radius_m(), crate::city::city_ball_mass_kg(), 600).expect("ball");
        eprintln!("cannonball fired at tick {tick}");
    }
    for _ in 0..after { step(&mut arena, &mut city, &mut tick, &mut tally); }
    let name = |w: &Worst| format!("{:.6} m at tick {} on {}#{} ({}) of body {:#x}", w.metres, w.tick, w.structure, w.node,
        types.get(w.node as usize).map_or("?", |t| t.as_str()), w.body);
    eprintln!("{} chunk placements on up to {} dynamic islands (first at tick {:?})", tally.compared, tally.islands, tally.first_split);
    eprintln!("  client weighing mass centres (now):  worst {}", name(&tally.now));
    eprintln!("  client weighing centroids (before):  worst {}", name(&tally.before));
    let (n, at, shift) = tally.largest;
    eprintln!("  largest island ({n} chunks, tick {at}) drawn by the old client shifted by ({:+.3}, {:+.3}, {:+.3}) m",
        shift.x, shift.y, shift.z);
    tally
}

/// The veneer two-storey with its front-wall studs removed comes down on its
/// own: the deterministic case of the roof seen jumping up as it split off.
#[test]
#[ignore = "requires local GPU and the native-destruction SDK"]
fn a_studless_house_collapsing_is_drawn_where_the_server_has_it() {
    let pack = repo().join("structures/town-kit/out/veneer-houses/veneer-house--no-front-studs.json");
    let tally = run(pack, 0, false);
    assert!(tally.compared > 0, "nothing split off: the collapse did not happen");
    // Teeth: the old client got this wrong by a visible amount.
    assert!(std::env::var_os("VIBE_WIRE_POSE_PACK").is_some() || tally.before.metres > 0.1,
        "weighing centroids should misplace the off-centre roof; worst only {:.4} m", tally.before.metres);
    assert!(tally.now.metres <= AGREE_M,
        "the client composes chunks {:.4} m from where the server has them", tally.now.metres);
}

/// The city cannonball into the intact veneer two-storey.
#[test]
#[ignore = "requires local GPU and the native-destruction SDK"]
fn a_cannonball_hit_is_drawn_where_the_server_has_it() {
    let pack = repo().join("structures/town-kit/out/veneer-houses/veneer-house.json");
    let tally = run(pack, 60, true);
    assert!(tally.compared > 0, "the cannonball broke nothing off");
    assert!(tally.now.metres <= AGREE_M,
        "the client composes chunks {:.4} m from where the server has them", tally.now.metres);
}
