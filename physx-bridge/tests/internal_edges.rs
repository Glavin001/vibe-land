#![cfg(feature = "native-destruction")]

//! Internal edges: bodies moving over a surface made of flush chunk boxes.
//!
//! Paving, floor slabs and walls are anchored structures of many box chunks
//! whose faces sit flush against each other: one rigid body, one continuous
//! surface. The narrowphase meets each box alone, so a body crossing the seam
//! between two of them meets the next box's top edge as if it stood proud,
//! along a normal tilted back by the edge, and the solver throws it up and
//! back (the internal-edge problem: Bullet btAdjustInternalEdgeContacts, PhysX
//! triangle-mesh active edges). The stage's PX_DESTRUCTION_INTERNAL_EDGES=1
//! corrects a contact on a box face flush against boxes still in the same body
//! (PxDestructionChunkBox::internalFaces, the bridge's mark_internal_faces).
//!
//! What a real surface does: a body sliding or rolling over flush paving meets
//! no edge, so it moves exactly as on one seamless slab; a real step (a chunk
//! standing 25 mm proud) is an edge and must still be met; and a face exposed
//! at runtime (its covering neighbour broken away) is an edge again.
//!
//! Every lane: 4 x 2 m slabs of asphalt 25 mm thick (480 kg) in two columns,
//! each bonded over its whole face to a fixed subgrade 0.16 m deep (mass 0: a
//! support, so the structure is anchored and kinematic), static ground 1 m
//! below. Gravity 9.81 (WorldConfig), friction 0.5, restitution 0.1.
//!
//! The tolerance is the resolution of a discrete step's resting contact: one
//! tick of gravity, g dt = 0.16 m/s. A body resting on a plane gains at most
//! that each tick and has it removed by the contact.
//!
//! Arms (each its own process; the stage reads PX_DESTRUCTION_INTERNAL_EDGES at
//! configuration and the arms inherit the test's environment, so a profile's
//! flags pass through):
//!   seam_box_seamed / seam_box_seamless    a car-scale box (4.5 x 1.5 x 1.8 m,
//!                                          1.5 t) sliding at 20 m/s along the lane,
//!                                          straddling the lane's long seam
//!   seam_ball_seamed / seam_ball_seamless  a wheel-scale ball (r 0.35 m, 20 kg)
//!                                          launched at 20 m/s down a column
//!   step_ball / step_box                   the second row 25 mm proud
//!   pit_removed / pit_authored / pit_flush the third row bonded to its
//!                                          neighbours by joints too weak for its
//!                                          weight over a pit (it breaks away and
//!                                          falls in), the same lane built without it,
//!                                          and the flush lane
//!
//! VIBE_GPU_SHARED=1 PHYSX_ROOT=... CARGO_TARGET_DIR=... PX_DESTRUCTION_INTERNAL_EDGES=1 \
//!   cargo test -p vibe-land-physx-bridge --features native-destruction \
//!   --test internal_edges -- --ignored --test-threads=1 --nocapture

#[path = "common/stage_env.rs"]
mod stage_env;

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, DynamicBoxDesc, LaunchedBallDesc, NativeConfig, Pose, Quat,
    RaycastRequest, StaticBoxDesc, StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_CHUNK: u32 = 1 << 5;
const GROUP_BODY: u32 = 1 << 3;
const ALL: u32 = u32::MAX;
const BODY: u32 = 0x0300_0001;
const ARM: &str = "INTERNAL_EDGES_ARM";
const DT: f32 = 1.0 / 60.0;
const G: f32 = 9.81;
/// One tick of gravity: the resolution of a discrete step's resting contact.
const TOL: f32 = G * DT;
/// The slabs: 2 m across (x), 4 m along (z), 25 mm thick; rows along z.
const SLAB: [f32; 3] = [1.0, 0.0125, 2.0];
const ROWS: u32 = 10;
const SUBGRADE: f32 = 0.08;
const TOP: f32 = 2.0 * SLAB[1];
const STEP: f32 = 0.025;
const PIT_ROW: u32 = 2;
const BALL_R: f32 = 0.35;

fn identity() -> Quat { Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 } }

#[derive(Clone, Copy, PartialEq)]
enum Lane { Seamed, Seamless, Step, PitRemoved, PitAuthored }

fn row_z(r: u32) -> f32 { 2.0 * SLAB[2] * r as f32 }

/// The lane as one anchored structure (or two, either side of a pit).
fn build_lane(world: &mut World, lane: Lane) {
    world.add_static_box(StaticBoxDesc { entity_id: 0x0100_0001, user_id: 1, pose: Pose { position: Vec3::new(0.0, -6.0, 0.0), rotation: identity() },
        half_extents: Vec3::new(500.0, 5.0, 500.0), collision_group: GROUP_CHUNK, collision_mask: ALL }).unwrap();
    world.native_attach().unwrap();
    let node = |i: u32, c: Vec3, h: Vec3, m: f32| ChunkNodeDesc { node_index: i, centroid: c, mass: m, volume: 8.0 * h.x * h.y * h.z,
        geom_kind: 0, half_extents: h, convex_points: Vec::new(), material: 0 };
    let slab_mass = 8.0 * SLAB[0] * SLAB[1] * SLAB[2] * 2400.0;
    let (z0, z1) = (row_z(0) - SLAB[2], row_z(ROWS - 1) + SLAB[2]);
    let pit = matches!(lane, Lane::PitRemoved | Lane::PitAuthored);
    let mut nodes = Vec::new();
    let mut bonds: Vec<ChunkBondDesc> = Vec::new();
    // The subgrade: one support, or two either side of the pit (the pit row has none under it).
    let mut supports = Vec::new();
    if pit {
        let (a, b) = (row_z(PIT_ROW) - SLAB[2], row_z(PIT_ROW) + SLAB[2]);
        for (lo, hi) in [(z0, a), (b, z1)] {
            supports.push((nodes.len() as u32, lo, hi));
            nodes.push(node(nodes.len() as u32, Vec3::new(0.0, -SUBGRADE, 0.5 * (lo + hi)), Vec3::new(2.0 * SLAB[0], SUBGRADE, 0.5 * (hi - lo)), 0.0));
        }
    } else {
        supports.push((0, z0, z1));
        nodes.push(node(0, Vec3::new(0.0, -SUBGRADE, 0.5 * (z0 + z1)), Vec3::new(2.0 * SLAB[0], SUBGRADE, 0.5 * (z1 - z0)), 0.0));
    }
    let support_of = |z: f32| supports.iter().find(|s| z > s.1 && z < s.2).map(|s| s.0);
    let mut bond = |bonds: &mut Vec<ChunkBondDesc>, a: u32, b: u32, at: Vec3, n: Vec3, area: f32, material: u32| {
        bonds.push(ChunkBondDesc { bond_index: bonds.len() as u32, node0: a, node1: b, centroid: at, normal: n, area, material });
    };
    if lane == Lane::Seamless {
        let h = Vec3::new(2.0 * SLAB[0], SLAB[1], 0.5 * (z1 - z0));
        nodes.push(node(1, Vec3::new(0.0, SLAB[1], 0.5 * (z0 + z1)), h, 2.0 * ROWS as f32 * slab_mass));
        bond(&mut bonds, 0, 1, Vec3::new(0.0, 0.0, 0.5 * (z0 + z1)), Vec3::new(0.0, 1.0, 0.0), 4.0 * h.x * h.z, 0);
    } else {
        let mut id = vec![[u32::MAX; 2]; ROWS as usize];
        for r in 0..ROWS {
            if lane == Lane::PitAuthored && r == PIT_ROW { continue; }
            for (j, x) in [-SLAB[0], SLAB[0]].iter().enumerate() {
                let i = nodes.len() as u32;
                id[r as usize][j] = i;
                let z = row_z(r);
                // The step: the second row's slabs 25 mm thicker, standing proud.
                let (cy, hy) = if lane == Lane::Step && r == 1 { (0.5 * (TOP + STEP), 0.5 * (TOP + STEP)) } else { (SLAB[1], SLAB[1]) };
                let mass = slab_mass * hy / SLAB[1];
                nodes.push(node(i, Vec3::new(*x, cy, z), Vec3::new(SLAB[0], hy, SLAB[2]), mass));
                if let Some(s) = support_of(z) { bond(&mut bonds, s, i, Vec3::new(*x, 0.0, z), Vec3::new(0.0, 1.0, 0.0), 4.0 * SLAB[0] * SLAB[2], 0); }
            }
        }
        if lane == Lane::PitRemoved {
            // The pit row held only by its joints to its neighbours, each too weak
            // for its weight (material 1: 1 kPa over 0.05 m^2 is 50 N; the slab weighs 4.7 kN).
            let r = PIT_ROW as usize;
            for j in 0..2 {
                let x = if j == 0 { -SLAB[0] } else { SLAB[0] };
                let a = 2.0 * SLAB[0] * TOP;
                bond(&mut bonds, id[r - 1][j], id[r][j], Vec3::new(x, SLAB[1], row_z(PIT_ROW) - SLAB[2]), Vec3::new(0.0, 0.0, 1.0), a, 1);
                bond(&mut bonds, id[r][j], id[r + 1][j], Vec3::new(x, SLAB[1], row_z(PIT_ROW) + SLAB[2]), Vec3::new(0.0, 0.0, 1.0), a, 1);
            }
            bond(&mut bonds, id[r][0], id[r][1], Vec3::new(0.0, SLAB[1], row_z(PIT_ROW)), Vec3::new(1.0, 0.0, 0.0), 2.0 * SLAB[2] * TOP, 1);
        }
    }
    let strong = StressMaterialDesc { compression_elastic: 1e8, compression_fatal: 1e9, tension_elastic: 1.3e7, tension_fatal: 1.3e8,
        shear_elastic: 5e7, shear_fatal: 5e8, elastic_modulus: 30e9, residual_area_fraction: 0.0 };
    let weak = StressMaterialDesc { compression_elastic: 5e2, compression_fatal: 1e3, tension_elastic: 5e2, tension_fatal: 1e3,
        shear_elastic: 5e2, shear_fatal: 1e3, elastic_modulus: 1e9, residual_area_fraction: 0.0 };
    let settings = DestructibleSettings { max_solver_iterations_per_frame: 64, materials: vec![strong, weak], maximum_bodies: 0, maximum_fractures_per_actor_per_tick: 0,
        linear_damping: 0.0, angular_damping: 0.0, ..DestructibleSettings::default() };
    world.native_create_destructible(0, Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: identity() }, &nodes, &bonds, settings, GROUP_CHUNK, ALL).unwrap();
    world.step().unwrap();
    world.native_configure(NativeConfig { max_iterations: 64, tolerance: 1e-3, force_tolerance: 0.0, warm_start: true, damage_rate: 2.0, bend_gain_max: 3.0,
        fibre_bending: true, reserved_contact_pairs: 64, preserve_unchanged_contact_pairs: true, gpu_island_repair: true, verdict_sample_ticks: 1 }).unwrap();
}

/// The surface height under (x, z): what a ray down from 2 m meets first.
fn surface(world: &World, x: f32, z: f32) -> f32 {
    let hit = world.raycast(RaycastRequest { origin: Vec3::new(x, 2.0, z), direction: Vec3::new(0.0, -1.0, 0.0), max_distance: 10.0,
        collision_mask: ALL, ignore_entity_id: 0, has_ignore_entity: false }).unwrap();
    if hit.hit { 2.0 - hit.distance } else { f32::NAN }
}

/// One run: the lane, settled; the body placed at rest on its surface at z
/// `start` and sent along +z at `speed`; its [z, along, up, |spin|] each tick.
fn run(lane: Lane, ball: bool, x: f32, start: f32, speed: f32, ticks: u32) -> Vec<[f32; 4]> {
    stage_env::product();
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    build_lane(&mut world, lane);
    // Settle; over the pit, until the pit row has broken away and fallen in.
    for _ in 0..90 { world.step().unwrap(); let s = world.native_tick().unwrap(); if s.broken_bonds > 0 { println!("broke {} bonds", s.broken_bonds); } }
    if matches!(lane, Lane::PitRemoved | Lane::PitAuthored) {
        let floor = surface(&world, SLAB[0], row_z(PIT_ROW));
        println!("pit surface {floor:.3}");
        assert!(floor < -0.5, "the pit row is still in place (surface at {floor:.3} m): the case no longer has a pit");
    }
    let top = surface(&world, x, start);
    assert!((top - TOP).abs() < 1e-3, "the lane's surface at the start is {top:.4}, not {TOP}");
    if ball {
        world.launch_dynamic_ball(LaunchedBallDesc { entity_id: BODY, user_id: 1, pose: Pose { position: Vec3::new(x, TOP + BALL_R, start), rotation: identity() },
            radius: BALL_R, mass: 20.0, linear_velocity: Vec3::new(0.0, 0.0, speed), collision_group: GROUP_BODY, collision_mask: ALL }).unwrap();
    } else {
        let h = Vec3::new(0.9, 0.75, 2.25);
        let mass = 1500.0;
        world.add_dynamic_box(DynamicBoxDesc { entity_id: BODY, user_id: 1, pose: Pose { position: Vec3::new(x, TOP + h.y, start), rotation: identity() },
            half_extents: h, mass, collision_group: GROUP_BODY, collision_mask: ALL }).unwrap();
        world.apply_impulse(BODY, Vec3::new(0.0, 0.0, mass * speed)).unwrap();
    }
    let mut out = Vec::new();
    for _ in 0..ticks {
        world.step().unwrap();
        world.native_tick().unwrap();
        let b = world.body_snapshots().unwrap().into_iter().find(|b| b.entity_id == BODY).expect("body");
        let w = b.angular_velocity;
        out.push([b.pose.position.z, b.linear_velocity.z, b.linear_velocity.y, (w.x * w.x + w.y * w.y + w.z * w.z).sqrt()]);
    }
    out
}

fn report(track: &[[f32; 4]]) {
    let up = track.iter().map(|t| t[2]).fold(f32::MIN, f32::max);
    let spin = track.iter().map(|t| t[3]).fold(0.0f32, f32::max);
    println!("up_max={up}");
    println!("spin_max={spin}");
    println!("along_end={}", track.last().unwrap()[1]);
    println!("z_end={}", track.last().unwrap()[0]);
}

#[test]
#[ignore = "spawned by the tests below"]
fn arm() {
    let Ok(arm) = std::env::var(ARM) else { return };
    let track = match arm.as_str() {
        "seam_box_seamed" => run(Lane::Seamed, false, 0.0, row_z(0) + 0.5, 20.0, 60),
        "seam_box_seamless" => run(Lane::Seamless, false, 0.0, row_z(0) + 0.5, 20.0, 60),
        "seam_ball_seamed" => run(Lane::Seamed, true, SLAB[0], row_z(0), 20.0, 75),
        "seam_ball_seamless" => run(Lane::Seamless, true, SLAB[0], row_z(0), 20.0, 75),
        // At 5 m/s the ball moves 83 mm a tick, under the 130 mm it needs from
        // first touching the step's edge to its centre over it: the step's edge
        // is met before the ball is past it, as any discrete step meets it.
        "step_ball" => run(Lane::Step, true, SLAB[0], row_z(0), 5.0, 60),
        "step_box" => run(Lane::Step, false, 0.0, row_z(0) - SLAB[2] + 2.3, 5.0, 40),
        "pit_removed" => run(Lane::PitRemoved, true, SLAB[0], row_z(0), 20.0, 45),
        "pit_authored" => run(Lane::PitAuthored, true, SLAB[0], row_z(0), 20.0, 45),
        "pit_flush" => run(Lane::Seamed, true, SLAB[0], row_z(0), 20.0, 45),
        _ => panic!("unknown arm {arm}"),
    };
    for (i, t) in track.iter().enumerate() { println!("tick {i} z {:.3} along {:.3} up {:.3} spin {:.3}", t[0], t[1], t[2], t[3]); }
    report(&track);
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

/// A car-scale box sliding and a wheel-scale ball rolling over flush slabs at
/// road speed move as over one seamless slab: no more lift at the seams than
/// the seamless slab's own, to within one tick of gravity.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn flush_seams_are_no_edges() {
    let mut failures = Vec::new();
    for body in ["box", "ball"] {
        let seamed = run_arm(&format!("seam_{body}_seamed"), &[]);
        let seamless = run_arm(&format!("seam_{body}_seamless"), &[]);
        let (up, up0) = (reported(&seamed, "up_max"), reported(&seamless, "up_max"));
        let (spin, spin0) = (reported(&seamed, "spin_max"), reported(&seamless, "spin_max"));
        let (along, along0) = (reported(&seamed, "along_end"), reported(&seamless, "along_end"));
        println!("{body}: seamed up {up:.3} m/s, spin {spin:.3} rad/s, along {along:.2}; seamless up {up0:.3}, spin {spin0:.3}, along {along0:.2}");
        if up > up0 + TOL { failures.push(format!("{body}: thrown up {up:.3} m/s at the seams, the seamless slab {up0:.3} (+ g dt {TOL:.3})\n{seamed}")); }
        // Along: friction alone slows it on either surface; a seam that catches it takes more.
        if (along - along0).abs() > TOL { failures.push(format!("{body}: along {along:.3} m/s over the seams, {along0:.3} seamless (g dt {TOL:.3})\n{seamed}")); }
    }
    assert!(failures.is_empty(), "the seams acted as edges:\n{}", failures.join("\n"));
}

/// A real step -- the second row 25 mm proud -- is an edge, met as one with the
/// correction on or off: the correction leaves exposed faces alone. And the
/// ball meets it: after the step it cannot still be moving into the edge's
/// normal, so its lift is at least its speed times the edge normal's tangent at
/// the latest it can first touch (centre 83 mm, one tick at 5 m/s, past first
/// touch: 47 mm short of the edge, 0.325 m above it).
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn real_step_is_met() {
    let mut failures = Vec::new();
    for body in ["ball", "box"] {
        let on = run_arm(&format!("step_{body}"), &[("PX_DESTRUCTION_INTERNAL_EDGES", "1")]);
        let off = run_arm(&format!("step_{body}"), &[("PX_DESTRUCTION_INTERNAL_EDGES", "0")]);
        let (up, up_off) = (reported(&on, "up_max"), reported(&off, "up_max"));
        let (along, along_off) = (reported(&on, "along_end"), reported(&off, "along_end"));
        println!("step, {body}: corrected up {up:.3} along {along:.3}; uncorrected up {up_off:.3} along {along_off:.3}");
        if (up - up_off).abs() > TOL || (along - along_off).abs() > TOL {
            failures.push(format!("{body}: the correction changed a real step's contact: up {up:.3} vs {up_off:.3}, along {along:.3} vs {along_off:.3}\n{on}"));
        }
        if body == "ball" {
            let d = (BALL_R * BALL_R - (BALL_R - STEP) * (BALL_R - STEP)).sqrt() - 5.0 * DT;
            let bound = along * d / (BALL_R - STEP);
            println!("  the edge's lift: >= {bound:.3} m/s");
            if up < bound { failures.push(format!("ball: lifted {up:.3} m/s by the step, its edge needs at least {bound:.3}\n{on}")); }
        } else {
            // The box's front meets the step's face square on: it stops there (or
            // climbs it), never passing at speed: at most what friction and the
            // 25 mm climb leave, sqrt(v^2 - 2 g h) less friction's take.
            let bound = (25.0f32 - 2.0 * G * STEP).sqrt();
            if along > bound { failures.push(format!("box: still at {along:.3} m/s along past the step, which stops at most {bound:.3}\n{on}")); }
        }
    }
    assert!(failures.is_empty(), "a real step:\n{}", failures.join("\n"));
}

/// A face exposed at runtime is an edge again. The pit row breaks away from
/// its neighbours under its own weight and falls into the pit; the faces it
/// covered are exposed. A ball crossing the pit meets the far edge exactly as
/// in the lane built with the pit from the start, and not as on flush paving.
#[test]
#[ignore = "requires the GPU and the native-destruction SDK"]
fn exposed_face_is_an_edge() {
    let removed = run_arm("pit_removed", &[]);
    let authored = run_arm("pit_authored", &[]);
    let flush = run_arm("pit_flush", &[]);
    let r = |t: &str| (reported(t, "up_max"), reported(t, "along_end"));
    let ((up, along), (up_a, along_a), (up_f, along_f)) = (r(&removed), r(&authored), r(&flush));
    println!("pit: removed at runtime up {up:.3} along {along:.3}; authored up {up_a:.3} along {along_a:.3}; flush up {up_f:.3} along {along_f:.3}");
    assert!((up_a - up_f).abs() > TOL || (along_a - along_f).abs() > TOL, "the pit's edge changes nothing: the case no longer tests an edge\n{authored}");
    assert!((up - up_a).abs() <= TOL && (along - along_a).abs() <= TOL,
        "the exposed edge was not met as the authored pit's: up {up:.3} vs {up_a:.3}, along {along:.3} vs {along_a:.3}\n{removed}");
}
