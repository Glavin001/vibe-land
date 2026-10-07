#![cfg(feature = "native-destruction")]

//! An impactor meets an "effectively infinite wall": the native stage's
//! anchored remnant is kinematic, so whatever a tick's corrected pass meets on
//! it stops the impactor at any force, however little its bonds can carry.
//! Closed-form expectations from momentum and strength, on the GPU stage at
//! the shipping settings (internalCorrectionLimit 1, 64 stress iterations,
//! FP32, unconverged solves continue).
//!
//! The wall: two plates, front and back, touching, each 10 kg and each held
//! to a fixed footing (mass 0) by one weak bond (fatal 100 kPa over 1 cm^2,
//! 10 N in tension; the same in compression and shear). A 1 t steel ball at
//! 20 m/s strikes the front plate square on.
//!
//! What a real wall does (Hibbeler, Dynamics, 15.4: a perfectly plastic
//! impact conserves momentum): the bonds can resist at most F_b = 10 N each,
//! an impulse F_b dt = 0.17 N s a tick against the ball's 20,000 N s, so the
//! ball sweeps both plates along: at worst it shares its momentum with them,
//! m v0 / (m + 2 m_p) = 19.6 m/s. Anything under 0.9 v0 needs a force the
//! plates cannot have exerted.
//!
//! What the stage does with one corrected pass: the trial sees the front
//! plate (kinematic, on the anchored remnant) take the ball, breaks its bond,
//! and rewinds. In the corrected pass the freed front plate is pushed into the
//! back plate -- still anchored, so kinematic -- and the ball stops behind it.
//! The back plate's bond breaks only in the evaluation after the corrected
//! pass, which is applied to the motion already solved, with no further pass.
//!
//! Arms (each its own process; the bridge reads its flags once):
//!   one_plate     the front plate alone: the control
//!   two_plates    both plates
//!   unbreakable   the front plate alone, bonded beyond any load: the
//!                 control, a wall that must stop the ball
//!   grid          load_moves_in_the_corrected_pass, below
//! and the high-fidelity profile's flags pass through from the environment.
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... CARGO_TARGET_DIR=... cargo test \
//!   -p vibe-land-physx-bridge --features native-destruction \
//!   --test infinite_wall -- --ignored --test-threads=1 --nocapture

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, LaunchedBallDesc, NativeConfig, Pose, Quat, StaticBoxDesc, StressMaterialDesc, Vec3,
    World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const GROUP_BALL: u32 = 1 << 3;
const ALL: u32 = u32::MAX;
const BALL: u32 = 0x0300_0001;
const ARM: &str = "INFINITE_WALL_ARM";
const DT: f32 = 1.0 / 60.0;
const V0: f32 = 20.0;
const BALL_MASS: f32 = 1000.0;
const PLATE_MASS: f32 = 10.0;
const Y: f32 = 20.0;

fn identity() -> Quat { Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }

/// The 2 x 2 grid: four 0.5 m plates (10 kg, 0.1 m thick) meeting at the
/// ball's aim point, each held sideways to its own footing beside the grid
/// (out of the ball's path) by one bond. The two on the left are weak (10 N);
/// the two on the right can each carry `STRONG` newtons. Struck at the
/// centre, the trial -- every plate kinematic -- shares the ball's stopping
/// impulse four ways.
const STRONG: f32 = 0.3 * BALL_MASS * V0 / DT;

fn grid() -> (Vec<ChunkNodeDesc>, Vec<ChunkBondDesc>) {
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let node = |i: u32, c: Vec3, h: Vec3, m: f32| ChunkNodeDesc {
        node_index: i, centroid: c, mass: m, volume: 8.0 * h.x * h.y * h.z, geom_kind: 0, half_extents: h, convex_points: Vec::new(), material: 0,
    };
    // Footings left and right (mass 0), 0.5 m wide, clear of the ball (r 0.31).
    nodes.push(node(0, Vec3::new(-0.75, Y, 0.0), Vec3::new(0.25, 0.5, 0.05), 0.0));
    nodes.push(node(1, Vec3::new(0.75, Y, 0.0), Vec3::new(0.25, 0.5, 0.05), 0.0));
    let mut k = 2;
    for (x, footing, material) in [(-0.25f32, 0u32, 0u32), (0.25, 1, 1)] {
        for y in [-0.25f32, 0.25] {
            nodes.push(node(k, Vec3::new(x, Y + y, 0.0), Vec3::new(0.25, 0.25, 0.05), PLATE_MASS));
            let face = if x < 0.0 { -0.5 } else { 0.5 };
            bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: footing, node1: k, centroid: Vec3::new(face, Y + y, 0.0),
                normal: Vec3::new(1.0, 0.0, 0.0), area: 1e-4, material });
            k += 1;
        }
    }
    (nodes, bonds)
}

/// The light ball (arm `light_ball`): the impact study's 100 kg of steel
/// (r 0.146 m) at 60 m/s, against one plate whose bond carries LIGHT_CAP.
const LIGHT_MASS: f32 = 100.0;
const LIGHT_V0: f32 = 60.0;
/// 1 MN: well above the tick's average force (m v (1 + e) / dt = 0.4 MN), far
/// below the hit's Hertz peak (about 19 MN on a 10 GPa plate, over ~1.2 ms).
const LIGHT_CAP: f32 = 1e6;

fn ball() -> (f32, f32) {
    if std::env::var(ARM).as_deref() == Ok("light_ball") { (LIGHT_MASS, LIGHT_V0) } else { (BALL_MASS, V0) }
}

/// Hertz (Johnson, Contact Mechanics, 11.1): an elastic sphere (mass m,
/// radius r, modulus e1) striking a flat of modulus e2 at v: the peak force
/// and the pulse's duration.
fn hertz(m: f32, r: f32, v: f32, e1: f32, e2: f32) -> (f32, f32) {
    let star = 1.0 / ((1.0 - 0.04) / e1 + (1.0 - 0.04) / e2);
    let delta = (15.0 * m * v * v / (16.0 * star * r.sqrt())).powf(0.4);
    (4.0 / 3.0 * star * r.sqrt() * delta.powf(1.5), 2.94 * delta / v)
}

/// The ball's velocity along +z each tick, and bonds broken.
fn strike(plates: u32) -> (Vec<f32>, usize) {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.native_attach().unwrap();
    // Footing (mass 0) under the plates; plates 1 x 1 x 0.1 m standing on it.
    let mut nodes = vec![ChunkNodeDesc {
        node_index: 0, centroid: Vec3::new(0.0, Y - 0.6, 0.05), mass: 0.0, volume: 1.0 * 0.2 * 0.4,
        geom_kind: 0, half_extents: Vec3::new(0.5, 0.1, 0.2), convex_points: Vec::new(), material: 0,
    }];
    let mut bonds = Vec::new();
    for k in 0..if plates == 4 { 0 } else { plates } {
        let z = 0.1 * k as f32;
        nodes.push(ChunkNodeDesc {
            node_index: k + 1, centroid: Vec3::new(0.0, Y, z), mass: PLATE_MASS, volume: 1.0 * 1.0 * 0.1,
            geom_kind: 0, half_extents: Vec3::new(0.5, 0.5, 0.05), convex_points: Vec::new(), material: 0,
        });
        bonds.push(ChunkBondDesc { bond_index: k, node0: 0, node1: k + 1, centroid: Vec3::new(0.0, Y - 0.5, z), normal: Vec3::new(0.0, 1.0, 0.0), area: 1e-4, material: 0 });
    }
    if plates == 4 { (nodes, bonds) = grid(); }
    // The control: one plate that cannot break, a wall that must stop the ball.
    // Its bond is the plate's whole base (0.1 m^2) at 1e13 Pa, so no bending
    // or shear the ball can apply reaches its limit in either profile.
    if std::env::var(ARM).as_deref() == Ok("unbreakable") { bonds[0].material = 2; bonds[0].area = 0.1; }
    if std::env::var(ARM).as_deref() == Ok("light_ball") { bonds[0].material = 3; }
    let material = |fatal: f32| StressMaterialDesc {
        compression_elastic: 0.5 * fatal, compression_fatal: fatal, tension_elastic: 0.5 * fatal, tension_fatal: fatal,
        shear_elastic: 0.5 * fatal, shear_fatal: fatal, elastic_modulus: 10e9, residual_area_fraction: 0.0,
    };
    let settings = DestructibleSettings {
        max_solver_iterations_per_frame: 64,
        // Weak (10 N over 1 cm^2), and the grid's strong plates (STRONG over 1 cm^2).
        materials: vec![material(1e5), material(STRONG / 1e-4), material(1e13), material(LIGHT_CAP / 1e-4)],
        ductile_slip: if std::env::var("VIBE_IMPACT_CAPACITY").as_deref() == Ok("1") { vec![0.0; 4] } else { Vec::new() },
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        linear_damping: 0.0,
        angular_damping: 0.0,
        ..DestructibleSettings::default()
    };
    world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: identity() }, &nodes, &bonds, settings, GROUP_CHUNK, ALL).unwrap();
    world.step().unwrap();
    world.native_configure(NativeConfig {
        max_iterations: 64, tolerance: 1e-3, force_tolerance: 0.0, warm_start: true, damage_rate: 2.0, bend_gain_max: 3.0,
        fibre_bending: true, reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true, gpu_island_repair: true, verdict_sample_ticks: 1,
    }).unwrap();
    for _ in 0..10 { world.step().unwrap(); world.native_tick().unwrap(); }
    // 1 t of steel (7850 kg/m^3): r 0.31 m, its surface 2 cm short of the front plate's face.
    let (mass, v0) = ball();
    let radius = (mass / 7850.0 * 3.0 / (4.0 * std::f32::consts::PI)).cbrt();
    world.launch_dynamic_ball(LaunchedBallDesc {
        entity_id: BALL, user_id: 1, pose: Pose { position: Vec3::new(0.0, Y, -0.05 - radius - 0.02), rotation: identity() },
        radius, mass, linear_velocity: Vec3::new(0.0, 0.0, v0), collision_group: GROUP_BALL, collision_mask: ALL,
    }).unwrap();
    world.native_set_impactor_impedance(BALL, (7850.0f32 * 200e9).sqrt()).unwrap();
    let (mut vz, mut broken) = (Vec::new(), 0usize);
    for t in 0..20 {
        world.step().unwrap();
        let status = world.native_tick().unwrap();
        assert_eq!(status.error, 0, "stage rejected step {t}: {status:?}");
        broken += world.native_take_broken_bonds().unwrap().len();
        let ball = world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == BALL).expect("ball");
        println!("tick {t} vz {:.3} broken {} after-correction {} corrections {}", ball.linear_velocity.z, status.broken_bonds, status.post_correction_broken_bonds, status.correction_passes);
        vz.push(ball.linear_velocity.z);
    }
    (vz, broken)
}

fn run_arm(arm: &str, env: &[(&str, &str)]) -> String {
    let exe = std::env::current_exe().expect("test binary path");
    let mut command = std::process::Command::new(exe);
    command.args(["--exact", "arm", "--nocapture", "--ignored", "--test-threads=1"]).env(ARM, arm);
    for (k, v) in env { command.env(k, v); }
    let output = command.output().expect("spawn arm");
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "arm {arm} failed:\n{text}");
    text
}

fn reported(text: &str, key: &str) -> f32 {
    text.lines().find_map(|l| l.strip_prefix(&format!("{key}="))).unwrap_or_else(|| panic!("no {key}:\n{text}")).trim().parse().unwrap()
}

/// The meteor (110 t of rock, r 2 m) at 140 m/s, descending at slope 0.3,
/// into static ground (the city's floor is a static box): its velocity each
/// tick [along, up].
fn meteor_on_ground(gap: f32, paved: bool) -> Vec<[f32; 2]> {
    std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
    let paved = paved || matches!(std::env::var(ARM).as_deref(), Ok("meteor_wall" | "meteor_footing"));
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world.add_static_box(StaticBoxDesc { entity_id: 0x0100_0001, user_id: 1, pose: Pose { position: Vec3::new(0.0, -5.16, 0.0), rotation: identity() },
        half_extents: Vec3::new(500.0, 5.0, 500.0), collision_group: GROUP_CHUNK, collision_mask: ALL }).unwrap();
    if paved {
        // The lab's paving (build-lab.mjs): 4 x 4 m slabs of asphalt 25 mm
        // thick (955 kg) on a fixed subgrade 0.16 m deep, each bonded to it
        // over its whole face with the footing's limits -- what the ground is
        // wherever a lane is paved: part of an anchored, kinematic structure.
        world.native_attach().unwrap();
        let node = |i: u32, c: Vec3, h: Vec3, m: f32| ChunkNodeDesc { node_index: i, centroid: c, mass: m, volume: 8.0 * h.x * h.y * h.z,
            geom_kind: 0, half_extents: h, convex_points: Vec::new(), material: 0 };
        let mut nodes = vec![node(0, Vec3::new(0.0, -0.08, 8.0), Vec3::new(6.0, 0.08, 14.0), 0.0)];
        let mut bonds = Vec::new();
        for (k, z) in [-2.0f32, 2.0, 6.0, 10.0, 14.0, 18.0].iter().enumerate() {
            for (j, x) in [-2.0f32, 2.0].iter().enumerate() {
                let i = 1 + 2 * k as u32 + j as u32;
                nodes.push(node(i, Vec3::new(*x, 0.0125, *z), Vec3::new(2.0, 0.0125, 2.0), 955.0));
                bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: 0, node1: i, centroid: Vec3::new(*x, 0.0, *z), normal: Vec3::new(0.0, 1.0, 0.0), area: 15.9, material: 0 });
            }
        }
        // "meteor_wall": a wall standing on the paving: a footing (mass 0,
        // 0.3 m proud of the paving, as the veneer house's) carrying six
        // 1 x 2 x 0.1 m brick panels (380 kg) on brittle bonds, across the
        // meteor's path 20 m on, where it lands.
        // "meteor_footing": the veneer house's strip footing alone (mass 0:
        // a support, kinematic and unbreakable), 0.3 m proud of the paving,
        // 0.6 m wide, across the meteor's path at z 19.7.
        if std::env::var(ARM).as_deref() == Ok("meteor_footing") {
            let f = nodes.len() as u32;
            nodes.push(node(f, Vec3::new(0.0, 0.175, 20.0), Vec3::new(3.0, 0.15, 0.3), 0.0));
        }
        if std::env::var(ARM).as_deref() == Ok("meteor_wall") {
            let f = nodes.len() as u32;
            nodes.push(node(f, Vec3::new(0.0, 0.175, 20.0), Vec3::new(3.0, 0.15, 0.3), 0.0));
            for j in 0..6u32 {
                let i = f + 1 + j;
                let x = -2.5 + j as f32;
                nodes.push(node(i, Vec3::new(x, 1.325, 20.0), Vec3::new(0.5, 1.0, 0.05), 380.0));
                bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: f, node1: i, centroid: Vec3::new(x, 0.325, 20.0), normal: Vec3::new(0.0, 1.0, 0.0), area: 0.1, material: 1 });
                if j > 0 { bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: i - 1, node1: i, centroid: Vec3::new(x - 0.5, 1.325, 20.0), normal: Vec3::new(1.0, 0.0, 0.0), area: 0.2, material: 1 }); }
            }
        }
        let footing = StressMaterialDesc { compression_elastic: 1e8, compression_fatal: 1e9, tension_elastic: 1.3e7, tension_fatal: 1.3e8,
            shear_elastic: 5e7, shear_fatal: 5e8, elastic_modulus: 30e9, residual_area_fraction: 0.0 };
        // Mortared brick: 0.5 MPa in tension, 1 MPa in shear, 10 MPa in compression.
        let brick = StressMaterialDesc { compression_elastic: 5e6, compression_fatal: 1e7, tension_elastic: 2.5e5, tension_fatal: 5e5,
            shear_elastic: 5e5, shear_fatal: 1e6, elastic_modulus: 10e9, residual_area_fraction: 0.0 };
        let settings = DestructibleSettings { max_solver_iterations_per_frame: 64, materials: vec![footing, brick], maximum_bodies: 0, maximum_fractures_per_actor_per_tick: 0,
            linear_damping: 0.0, angular_damping: 0.0, ..DestructibleSettings::default() };
        world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: identity() }, &nodes, &bonds, settings, GROUP_CHUNK, ALL).unwrap();
        world.step().unwrap();
        world.native_configure(NativeConfig { max_iterations: 64, tolerance: 1e-3, force_tolerance: 0.0, warm_start: true, damage_rate: 2.0, bend_gain_max: 3.0,
            fibre_bending: true, reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true, gpu_island_repair: true, verdict_sample_ticks: 1 }).unwrap();
    }
    for _ in 0..5 { world.step().unwrap(); if paved { world.native_tick().unwrap(); } }
    let ground = if paved { 0.025 } else { 0.0 };
    let (mass, radius, speed, slope) = (110_000.0f32, 2.0f32, 140.0f32, 0.3f32);
    let n = (1.0 + slope * slope).sqrt();
    let v = Vec3::new(0.0, -speed * slope / n, speed / n);
    // Its surface `gap` over the ground at the end of the first tick: a gap
    // under one tick's fall (0.67 m) puts it that far short of the ground into
    // it on the next, as a discrete step does wherever the rock happens to be.
    // meteor_wall: it lands against the wall's foot (its centre 2.2 m short of the wall face).
    let z0 = if std::env::var(ARM).as_deref() == Ok("meteor_wall") { 19.95 - radius - 0.2 - v.z * DT } else { 0.0 };
    // meteor_footing: one tick before its lower front meets the footing's top
    // edge (z 19.7, y 0.325) at 45 degrees -- as the film's meteor met the
    // veneer house's -- less `gap` along its path, so the step lands it from
    // just touching to well into the edge.
    let footing = std::env::var(ARM).as_deref() == Ok("meteor_footing");
    let start = if footing {
        let d = radius / 2f32.sqrt();
        let along = (gap * 3.0 + 1.0) * DT;
        Vec3::new(0.0, 0.325 + d - v.y * along, 19.7 - d - v.z * along)
    } else { Vec3::new(0.0, ground + radius + gap - v.y * DT, z0) };
    world.launch_dynamic_ball(LaunchedBallDesc { entity_id: BALL, user_id: 1, pose: Pose { position: start, rotation: identity() },
        radius, mass, linear_velocity: v, collision_group: GROUP_BALL, collision_mask: ALL }).unwrap();
    let mut out = Vec::new();
    for _ in 0..30 {
        world.step().unwrap();
        if paved { let status = world.native_tick().unwrap(); if status.broken_bonds > 0 { println!("paving broke {} bonds", status.broken_bonds); } }
        let ball = world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == BALL).expect("meteor");
        println!("meteor y {:.2} along {:.2} up {:.2}", ball.pose.position.y, ball.linear_velocity.z, ball.linear_velocity.y);
        out.push([ball.linear_velocity.z, ball.linear_velocity.y]);
    }
    out
}

#[test]
#[ignore = "spawned by layered_wall"]
fn arm() {
    let Ok(arm) = std::env::var(ARM) else { return };
    if arm.starts_with("meteor_") {
        // Wherever the last step before contact leaves it: 1 cm (inside the
        // contact offset) to 0.6 m up.
        let (mut up, mut along) = (f32::MIN, f32::MAX);
        for gap in [0.01f32, 0.2, 0.4, 0.6] {
            let track = meteor_on_ground(gap, arm == "meteor_paving");
            let u = track.iter().map(|v| v[1]).fold(f32::MIN, f32::max);
            println!("gap {gap}: up {u:.2} along {:.2}", track.last().unwrap()[0]);
            up = up.max(u);
            along = along.min(track.last().unwrap()[0]);
        }
        println!("up_max={up}");
        println!("along_end={along}");
        return;
    }
    let plates = match arm.as_str() { "one_plate" | "unbreakable" | "light_ball" => 1, "grid" => 4, _ => 2 };
    let (vz, broken) = strike(plates);
    println!("v_end={}", vz.last().unwrap());
    println!("v_min={}", vz.iter().copied().fold(f32::MAX, f32::min));
    println!("broken={broken}");
    // After the ball first loses half its speed, the fastest it goes again:
    // nothing in the scene can give it back what it lost.
    let after = vz.iter().position(|&v| v < 0.5 * ball().1).map_or(f32::MIN, |k| vz[k..].iter().copied().fold(f32::MIN, f32::max));
    println!("v_regained={after}");
}

/// The ball keeps what momentum and the plates' strength leave it.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn layered_wall() {
    let plates = 2.0 * PLATE_MASS;
    let floor = BALL_MASS * V0 / (BALL_MASS + plates);
    println!("closed form: v >= {floor:.2} m/s (perfectly plastic with both plates); bonds resist {:.2} N s a tick", 3.0 * 1e5 * 1e-4 * DT);
    let mut failures = Vec::new();
    for (arm, env) in [("one_plate", vec![]), ("two_plates", vec![]), ("unbreakable", vec![])] {
        let text = run_arm(arm, &env);
        let (end, min, broken) = (reported(&text, "v_end"), reported(&text, "v_min"), reported(&text, "broken"));
        println!("{arm:<14} v_end {end:7.2}  v_min {min:7.2}  bonds broken {broken}");
        let wall = min < 0.9 * V0;
        if arm == "unbreakable" {
            // The control: a plate that cannot break is a wall, and the test must see it.
            assert!(wall, "the unbreakable plate should stop the ball, and the test would not see a wall:\n{text}");
            // Stopped, it stays stopped: a rebound at the restitution, never its speed back.
            let regained = reported(&text, "v_regained");
            if regained > 0.5 * V0 { failures.push(format!("{arm}: after the stop the ball was back at {regained:.2} m/s: momentum from nowhere\n{text}")); }
        } else if wall {
            failures.push(format!("{arm}: the ball fell to {min:.2} m/s (ended {end:.2}); momentum and the bonds' strength allow no less than {floor:.2}\n{text}"));
        }
    }
    assert!(failures.is_empty(), "an infinite wall:\n{}", failures.join("\n"));
}

/// Load moved in the corrected pass. Struck at the grid's centre, the trial
/// (all four plates kinematic) shares the stop four ways, about 0.28 m v0 / dt
/// a plate: the weak pair breaks, the strong pair (0.3 m v0 / dt each) holds.
/// In the corrected pass the weak pair is free and the strong pair -- still
/// anchored, so kinematic -- takes the whole stop, twice what its bonds carry.
/// A real grid: the strong pair resists at most 2 x 0.3 m v0 for the tick
/// its bonds hold, and the weak pair's 20 kg takes its share of momentum, so
/// the ball keeps at least (m v0 - 0.6 m v0) / (m + 40 kg) = 7.7 m/s.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn load_moves_in_the_corrected_pass() {
    let floor = (BALL_MASS * V0 - 2.0 * STRONG * DT) / (BALL_MASS + 4.0 * PLATE_MASS);
    let text = run_arm("grid", &[]);
    let (end, min, broken) = (reported(&text, "v_end"), reported(&text, "v_min"), reported(&text, "broken"));
    println!("grid: v_end {end:.2} v_min {min:.2} bonds broken {broken}; closed form v >= {floor:.2} m/s");
    assert!(min >= 0.9 * floor, "an infinite wall: the ball fell to {min:.2} m/s (ended {end:.2}); the strong plates can take it no lower than {floor:.2}\n{text}");
}

/// The tick-averaged load. The stage loads a struck chunk's bonds with the
/// tick's contact impulse spread over the tick, J / dt; a hard impactor
/// delivers it in a pulse a fraction of that long. The 100 kg ball's 6.6 kN s
/// is 0.4 MN averaged over 16.7 ms -- under the bond's 1 MN, so the stage
/// holds -- but about 19 MN over 1.2 ms (Hertz), far over it. The bond can
/// have taken at most LIGHT_CAP over the pulse before it broke, so the ball
/// keeps at least (m v0 - LIGHT_CAP t) / (m + m_plate).
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn impact_pulse() {
    let r = (LIGHT_MASS / 7850.0 * 3.0 / (4.0 * std::f32::consts::PI)).cbrt();
    let (peak, pulse) = hertz(LIGHT_MASS, r, LIGHT_V0, 210e9, 10e9);
    let floor = (LIGHT_MASS * LIGHT_V0 - LIGHT_CAP * pulse) / (LIGHT_MASS + PLATE_MASS);
    let text = run_arm("light_ball", &[]);
    let (end, min) = (reported(&text, "v_end"), reported(&text, "v_min"));
    println!("light ball: v_end {end:.2} v_min {min:.2}; Hertz peak {:.1} MN over {:.2} ms against a {:.1} MN bond: v >= {floor:.2} m/s", peak / 1e6, pulse * 1e3, LIGHT_CAP / 1e6);
    assert!(peak > LIGHT_CAP && LIGHT_MASS * LIGHT_V0 * 1.1 / DT < LIGHT_CAP, "the case no longer separates the pulse from the tick average");
    assert!(min >= 0.9 * floor, "an infinite wall (tick-averaged load): the ball fell to {min:.2} m/s (ended {end:.2}); a bond of {:.1} MN can take it no lower than {floor:.2}\n{text}", LIGHT_CAP / 1e6);
}

/// The fragment depenetration cap (2 m/s whenever vehicles are registered,
/// native_destruction.cc; FIDELITY_AUDIT F3) on the layered wall and the
/// grid: it must change neither bound.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn fragment_depenetration_cap() {
    let cap = [("VIBE_CITY_NATIVE_FRAGMENT_DEPEN_VELOCITY", "2")];
    let text = run_arm("two_plates", &cap);
    let (end, min) = (reported(&text, "v_end"), reported(&text, "v_min"));
    let floor = BALL_MASS * V0 / (BALL_MASS + 2.0 * PLATE_MASS);
    println!("two plates, fragments capped at 2 m/s: v_end {end:.2} v_min {min:.2} (v >= {floor:.2})");
    assert!(min >= 0.9 * floor, "the depenetration cap made a wall: {min:.2} m/s\n{text}");
}

/// A meteor off static ground (the integration agent's film: the meteor
/// "bounces off the ground behind the house"). It meets the ground at
/// v_n = 140 sin(atan 0.3) = 40.2 m/s; the world's restitution is 0.1, so it
/// may leave it at no more than e v_n = 4.0 m/s upward (Hibbeler, Dynamics,
/// 15.4; a rigid floor -- soil would take more). Faster is energy the contact
/// made, not the collision: discrete steps put the rock a metre into the
/// ground before the contact sees it, and pushing it out at whatever speed
/// that takes is a launch.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn meteor_rebound_off_ground() {
    let vn = 140.0 * (0.3f32).atan().sin();
    let mut failures = Vec::new();
    // Static ground (the city's floor), and paving: slabs on a fixed subgrade, an anchored structure.
    for arm in ["meteor_ground", "meteor_paving", "meteor_wall"] {
        let text = run_arm(arm, &[]);
        let (up, along) = (reported(&text, "up_max"), reported(&text, "along_end"));
        println!("{arm}: up to {up:.1} m/s (e v_n = {:.1}), along {along:.1}", 0.1 * vn);
        if up > 0.1 * vn + 1.0 { failures.push(format!("{arm}: the meteor left at {up:.1} m/s up, restitution allows {:.1}\n{text}", 0.1 * vn)); }
    }
    assert!(failures.is_empty(), "energy from the contact:\n{}", failures.join("\n"));
}

/// The film's meteor (2026-10-07, vehicle-lab-*-071202-final.mp4: "bounces
/// off the ground behind the house"): its track in the wall matrix
/// (wm-veneer-meteor-film) goes from (134 along, -45 up) to (21.6, +40.3) in
/// one tick -- an impulse of 141 m/s x 110 t along a normal 37 degrees up and
/// back, a near-plastic stop on a ramp: the lower front of the rock on the
/// house's strip footing's top edge, a support (mass 0) and so kinematic and
/// unbreakable, 0.155 m proud of the paving. Not its depenetration
/// (VIBE_CITY_BALL_MAX_DEPENETRATION=1 changes nothing) and not the fragment
/// cap (lifted, the same).
///
/// What a concrete edge can do: it crushes. Concrete carries at most its
/// crushing strength, ~30 MPa (EN 1992-1-1 C30), and the face the rock can
/// press on is no taller than the footing stands proud (0.3 m here) and no
/// wider than the rock (2 r = 4 m): at most sigma h 2 r = 36 MN, over a tick
/// 0.6 MN s, which turns 110 t by 5.5 m/s. With its rebound (e v_n = 4.0) the
/// rock leaves the edge no faster than 9.5 m/s upward. A kinematic edge -- a
/// support never breaks or crushes -- throws it up at whatever the ramp gives.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn meteor_on_a_foundation() {
    let text = run_arm("meteor_footing", &[]);
    let up = reported(&text, "up_max");
    let (sigma, proud, r, m) = (30e6f32, 0.3f32, 2.0f32, 110_000.0f32);
    let bound = 0.1 * 140.0 * (0.3f32).atan().sin() + sigma * proud * 2.0 * r * DT / m;
    println!("meteor on the footing: up to {up:.1} m/s; a crushing concrete edge allows {bound:.1}");
    assert!(up <= bound, "an infinite foundation: the footing edge threw the meteor up at {up:.1} m/s, concrete could not exceed {bound:.1}\n{text}");
}
