#![cfg(feature = "native-destruction")]

//! Debris hibernation: settled stage fragments frozen in place as kinematic
//! bodies and thawed locally (PxDestructionScene v25,
//! `physx-bridge/src/native_hibernation.cc`).
//!
//! Each test pins one property the design rests on, against the real engine:
//! - opt-in: off, nothing changes;
//! - a freeze moves nothing and wakes nothing;
//! - frozen debris still collides, as an immovable body;
//! - a thaw restores the body's own mass and gravity;
//! - a mover thaws what it is about to hit BEFORE contact, so momentum is
//!   exchanged exactly as if nothing had been frozen;
//! - a disturbance stays local, and a pile freezes again afterwards;
//! - support loss thaws what rested on it (no floating rubble);
//! - a shot/blast query thaws its neighbourhood only;
//! - a fracture of a frozen fragment thaws it inside the stage's transaction;
//! - turning hibernation off, or clearing the city, leaves nothing frozen.
//!
//! Run with the server's stage settings, one test at a time (one GPU):
//!   PX_DESTRUCTION_ALLOW_UNCONVERGED=1 cargo test --release \
//!     -p vibe-land-physx-bridge --features native-destruction \
//!     --test native_hibernation -- --test-threads=1

mod support;

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, DynamicBoxDesc, HibernationConfig,
    NativeConfig, Pose, Quat, RoundDesc, StaticBoxDesc, StressMaterialDesc, Vec3, World,
    WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_DYNAMIC: u32 = 1 << 1;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_DYNAMIC | GROUP_CHUNK;
/// The default wake threshold (native_state.h): sqrt(2 * 0.5 * 9.81 * 0.01).
const WAKE_DV: f32 = 0.31;
/// One rest window (native_state.h kRestWindowTicks).
const WINDOW: u32 = 120;
const BOX: u32 = 0x2000_0001;

fn on() -> HibernationConfig {
    HibernationConfig { enabled: true, wake_dv: WAKE_DV }
}

fn off() -> HibernationConfig {
    HibernationConfig { enabled: false, wake_dv: WAKE_DV }
}

fn world(gravity: f32) -> World {
    let mut config = WorldConfig::default();
    config.gravity = Vec3::new(0.0, gravity, 0.0);
    let mut world = World::new(config).expect("GPU scene");
    if gravity != 0.0 {
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 0x1000_0001,
                user_id: 0,
                pose: Pose { position: Vec3::new(0.0, -0.5, 0.0), rotation: Quat::IDENTITY },
                half_extents: Vec3::new(40.0, 0.5, 40.0),
                collision_group: GROUP_STATIC,
                collision_mask: ALL,
            })
            .expect("ground");
    }
    world
}

fn material(tension: f32) -> StressMaterialDesc {
    StressMaterialDesc {
        compression_elastic: 250_000.0,
        compression_fatal: 500_000.0,
        tension_elastic: tension,
        tension_fatal: tension * 2.0,
        shear_elastic: tension * 2.0,
        shear_fatal: tension * 4.0,
        elastic_modulus: 30.0e9,
        residual_area_fraction: 0.0,
    }
}

fn settings(tension: f32) -> DestructibleSettings {
    DestructibleSettings {
        max_solver_iterations_per_frame: 2048,
        graph_reduction_level: 0,
        materials: vec![material(tension)],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        apply_excess_forces: true,
        apply_centrifugal: true,
        excess_force_scale: 0.012,
        linear_damping: 0.0,
        angular_damping: 0.0,
    }
}

fn native_config(chunks: u32) -> NativeConfig {
    NativeConfig {
        max_iterations: 2048,
        tolerance: 1.0e-5,
        force_tolerance: 0.0,
        warm_start: true,
        damage_rate: 2.0,
        bend_gain_max: 3.0,
        fibre_bending: true,
        reserved_contact_pairs: chunks * 6 + 64,
        preserve_unchanged_contact_pairs: true,
        gpu_island_repair: true,
        verdict_sample_ticks: 1,
    }
}

fn cube(index: u32, centroid: Vec3) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: index,
        centroid,
        mass: 400.0,
        volume: 1.0,
        geom_kind: 0,
        half_extents: Vec3::new(0.48, 0.48, 0.48),
        convex_points: Vec::new(),
    }
}

/// Author `nodes`/`bonds` as structure 0, step once so GPU identities exist,
/// then configure the stage.
fn install(world: &mut World, nodes: &[ChunkNodeDesc], bonds: &[ChunkBondDesc], tension: f32) {
    world.native_attach().expect("stage attach");
    world
        .native_create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat::IDENTITY },
            nodes,
            bonds,
            settings(tension),
            GROUP_CHUNK,
            ALL,
        )
        .expect("author");
    world.step().expect("identity step");
    world.native_configure(native_config(nodes.len() as u32)).expect("configure stage");
}

/// `columns x rows x layers` unbonded cubes stacked on the ground, each its
/// own free fragment: a pile that settles at once and stays put.
fn rubble(world: &mut World, columns: u32, rows: u32, layers: u32) -> Vec<ChunkNodeDesc> {
    let mut nodes = Vec::new();
    for layer in 0..layers {
        for row in 0..rows {
            for column in 0..columns {
                let n = nodes.len() as u32;
                nodes.push(cube(
                    n,
                    Vec3::new(
                        column as f32 - (columns as f32 - 1.0) * 0.5,
                        layer as f32 * 0.98 + 0.5,
                        row as f32 - (rows as f32 - 1.0) * 0.5,
                    ),
                ));
            }
        }
    }
    install(world, &nodes, &[], 30_000.0);
    nodes
}

fn step(world: &mut World) {
    world.step().expect("step");
    let status = world.native_tick().expect("observe");
    assert_eq!(status.error, 0, "engine rejected the step (error bits {})", status.error);
}

fn steps(world: &mut World, n: u32) {
    for _ in 0..n {
        step(world);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Row {
    entity: u32,
    position: [f32; 3],
    rotation: [f32; 4],
    sleeping: bool,
    kinematic: bool,
    flags: u32,
}

fn rows(world: &World) -> Vec<Row> {
    world
        .native_chunk_body_snapshots()
        .expect("rows")
        .iter()
        .map(|r| Row {
            entity: r.entity_id,
            position: [r.position.x, r.position.y, r.position.z],
            rotation: [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w],
            sleeping: r.sleeping,
            kinematic: r.kinematic,
            flags: r.flags,
        })
        .collect()
}

fn row(world: &World, entity: u32) -> Row {
    *rows(world).iter().find(|r| r.entity == entity).expect("body row")
}

/// The live centre of chunk `node` and the entity that owns it.
fn chunk(world: &World, node: u32) -> ([f32; 3], u32) {
    let aim = world.native_chunk_aim(0, node).expect("aim");
    assert!(aim.found, "chunk {node} not found");
    ([aim.center.x, aim.center.y, aim.center.z], aim.entity_id)
}

fn frozen(world: &World) -> Vec<u32> {
    let mut out = world.native_frozen_entities().expect("frozen");
    out.sort_unstable();
    out
}

/// Freeze the entity owning each node, skipping any the stage refuses.
/// Returns the nodes whose bodies froze.
fn freeze_nodes(world: &mut World, nodes: &[u32]) -> Vec<u32> {
    let mut done = Vec::new();
    for &node in nodes {
        let entity = chunk(world, node).1;
        if world.native_set_entities_hibernated(&[entity], true).expect("freeze") == 1 {
            done.push(node);
        }
    }
    done
}

fn add_box(world: &mut World, at: Vec3, half: f32, mass: f32) {
    world
        .add_dynamic_box(DynamicBoxDesc {
            entity_id: BOX,
            user_id: 0,
            pose: Pose { position: at, rotation: Quat::IDENTITY },
            half_extents: Vec3::new(half, half, half),
            mass,
            collision_group: GROUP_DYNAMIC,
            collision_mask: ALL,
        })
        .expect("box");
}

fn box_state(world: &World) -> ([f32; 3], [f32; 3]) {
    let s = world
        .body_snapshots()
        .expect("bodies")
        .into_iter()
        .find(|b| b.entity_id == BOX)
        .expect("box row");
    (
        [s.pose.position.x, s.pose.position.y, s.pose.position.z],
        [s.linear_velocity.x, s.linear_velocity.y, s.linear_velocity.z],
    )
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

#[test]
fn off_by_default_nothing_freezes() {
    let mut w = world(-9.81);
    rubble(&mut w, 3, 3, 2);
    steps(&mut w, 5 * WINDOW);
    let stats = w.native_hibernation_stats().expect("stats");
    assert_eq!(stats.frozen, 0);
    assert_eq!(stats.froze_total, 0);
    assert!(frozen(&w).is_empty());
    assert!(rows(&w).iter().all(|r| !r.kinematic), "a fragment reads as anchored");
}

#[test]
fn a_freeze_moves_nothing_and_wakes_nothing() {
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 3, 3, 2);
    steps(&mut w, 60);
    let before: Vec<_> = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
    let rows_before = rows(&w);
    assert!(rows_before.iter().all(|r| r.sleeping), "the pile did not settle");

    // The top-centre cube rests on one cube and carries none.
    let top_centre = 13;
    let done = freeze_nodes(&mut w, &[top_centre]);
    assert_eq!(done, vec![top_centre], "the stage refused a settled free fragment");
    let entity = chunk(&w, top_centre).1;
    steps(&mut w, 2 * WINDOW);

    assert_eq!(frozen(&w), vec![entity]);
    for (n, p) in before.iter().enumerate() {
        assert_eq!(chunk(&w, n as u32).0, *p, "chunk {n} moved across a freeze");
    }
    for r in rows(&w) {
        assert!(r.sleeping, "body {:#x} woke when its neighbour froze", r.entity);
        assert!(!r.kinematic, "body {:#x} reads as an anchored remnant", r.entity);
    }
    assert!(w.native_validate_mappings().expect("audit"), "GPU and CPU ownership disagree");
}

#[test]
fn frozen_debris_still_collides_as_an_immovable_body() {
    let mut w = world(-9.81);
    rubble(&mut w, 3, 3, 1);
    steps(&mut w, 60);
    let centre = 4;
    assert_eq!(freeze_nodes(&mut w, &[centre]), vec![centre]);
    let at = chunk(&w, centre).0;
    // Hibernation is off, so nothing thaws it: a 2-tonne box lands on it.
    add_box(&mut w, Vec3::new(at[0], at[1] + 2.5, at[2]), 0.4, 2000.0);
    steps(&mut w, 180);
    let (p, v) = box_state(&w);
    assert!((p[1] - (at[1] + 0.48 + 0.4)).abs() < 0.03, "box at y {} did not land on the frozen cube", p[1]);
    assert!(v[1].abs() < 0.05, "box still moving: {v:?}");
    assert_eq!(chunk(&w, centre).0, at, "the frozen cube moved under a 2-tonne box");
}

/// Freeze the first of `nodes` whose body the stage accepts as a fragment.
fn freeze_one(world: &mut World, nodes: &[u32]) -> u32 {
    for &node in nodes {
        if freeze_nodes(world, &[node]) == vec![node] {
            return node;
        }
    }
    panic!("no fragment among {nodes:?} froze");
}

/// The x velocity of chunk `node` from its displacement over half a second.
fn chunk_vx(world: &mut World, node: u32) -> f32 {
    let p0 = chunk(world, node).0[0];
    steps(world, 30);
    (chunk(world, node).0[0] - p0) / 0.5
}

/// Zero gravity, one cube and one box closing at 3 m/s: the cleanest possible
/// momentum exchange. Returns the cube's and the box's x velocity afterwards,
/// the approach thaws, and whether the struck cube is thawed.
fn collide(frozen_cube: bool, hibernation: HibernationConfig) -> (f32, f32, u64, bool) {
    let mut w = world(0.0);
    install(&mut w, &[cube(0, Vec3::new(0.0, 5.0, 0.0)), cube(1, Vec3::new(0.0, 5.0, 20.0))], &[], 30_000.0);
    w.native_set_hibernation(hibernation).expect("config");
    steps(&mut w, 30);
    let target = if frozen_cube { freeze_one(&mut w, &[0, 1]) } else { 0 };
    let at = chunk(&w, target).0;
    add_box(&mut w, Vec3::new(at[0] - 3.0, at[1], at[2]), 0.45, 400.0);
    w.apply_impulse(BOX, Vec3::new(1200.0, 0.0, 0.0)).expect("push");
    steps(&mut w, 150);
    let cube_vx = chunk_vx(&mut w, target);
    let (_, v) = box_state(&w);
    let stats = w.native_hibernation_stats().expect("stats");
    let struck_frozen = frozen(&w).contains(&chunk(&w, target).1);
    (cube_vx, v[0], stats.thaw_approach, !struck_frozen)
}

#[test]
fn a_thaw_before_contact_exchanges_momentum_as_if_never_frozen() {
    let (cube_control, box_control, _, _) = collide(false, off());
    let (cube_thawed, box_thawed, approach, struck_thawed) = collide(true, on());
    println!("control: cube {cube_control:.3} box {box_control:.3}; thawed: cube {cube_thawed:.3} box {box_thawed:.3}");
    assert!(approach >= 1, "the approaching box did not thaw the cube");
    assert!(struck_thawed, "the struck cube is still frozen");
    // Equal masses: the control cube carries the box's momentum away.
    assert!(cube_control > 1.0, "control collision did not move the cube: {cube_control}");
    let momentum = |c: f32, b: f32| 400.0 * c + 400.0 * b;
    assert!((momentum(cube_control, box_control) - 1200.0).abs() < 60.0, "control lost momentum");
    assert!((momentum(cube_thawed, box_thawed) - 1200.0).abs() < 60.0, "thawed collision lost momentum");
    assert!((cube_thawed - cube_control).abs() < 0.1, "thawed cube {cube_thawed} differs from control {cube_control}");
    assert!((box_thawed - box_control).abs() < 0.1, "box {box_thawed} differs from control {box_control}");
}

#[test]
fn without_a_thaw_the_frozen_cube_is_a_wall() {
    // The negative control: hibernation off, cube frozen explicitly, so the
    // box meets an immovable body and keeps none of its forward momentum.
    let (cube, box_v, approach, _) = collide(true, off());
    println!("frozen wall: cube {cube:.3} box {box_v:.3}");
    assert_eq!(approach, 0);
    assert!(cube.abs() < 1e-4, "a frozen cube moved: {cube}");
    assert!(box_v <= 0.05, "the box went through or kept going: {box_v}");
}

#[test]
fn a_thawed_body_falls_with_its_own_gravity() {
    let mut w = world(-9.81);
    // Two cubes hanging in the air; freeze the fragment one at once, mid-fall.
    install(&mut w, &[cube(0, Vec3::new(0.0, 12.0, 0.0)), cube(1, Vec3::new(6.0, 12.0, 0.0))], &[], 30_000.0);
    step(&mut w);
    let node = freeze_one(&mut w, &[0, 1]);
    let held = chunk(&w, node).0;
    steps(&mut w, 60);
    assert_eq!(chunk(&w, node).0, held, "a frozen body moved under gravity");
    let entity = chunk(&w, node).1;
    assert_eq!(w.native_set_entities_hibernated(&[entity], false).expect("thaw"), 1);
    steps(&mut w, 30);
    let fell = held[1] - chunk(&w, node).0[1];
    // Free fall from rest for 0.5 s: 1.226 m (no damping in these settings).
    println!("fell {fell:.4} m in 0.5 s");
    assert!((fell - 0.5 * 9.81 * 0.25).abs() < 0.05, "fell {fell} m, expected 1.226");
    assert!(w.native_validate_mappings().expect("audit"));
}

#[test]
fn a_pile_hibernates_on_its_own_without_moving() {
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 3, 3, 2);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60);
    let before: Vec<_> = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
    steps(&mut w, 4 * WINDOW);
    let stats = w.native_hibernation_stats().expect("stats");
    let bodies = rows(&w).len() as u32;
    println!("{stats:?} of {bodies} bodies");
    assert_eq!(stats.frozen, bodies, "not every settled fragment froze");
    assert_eq!(stats.froze_total, stats.frozen as u64);
    for (n, p) in before.iter().enumerate() {
        assert_eq!(chunk(&w, n as u32).0, *p, "chunk {n} moved as the pile froze");
    }
    for r in rows(&w) {
        assert!(r.sleeping && !r.kinematic, "{r:?}");
    }
    assert!(w.native_validate_mappings().expect("audit"));
}

/// A 2-tonne block dropped from 3 m onto a corner of a settled 6 x 6 x 2
/// pile, frozen or not. Returns every chunk's centre and the block's position
/// two seconds later, the hibernation stats, and the run's world.
#[derive(Clone, Copy, PartialEq)]
enum Pile {
    /// Asleep, never frozen: the reference.
    Asleep,
    /// Never frozen, but awake when struck: every body was frozen and thawed
    /// a few ticks before (an exact round trip, see trace_impact_round_trip),
    /// which leaves it dynamic and awake.
    Awake,
    /// Hibernation on.
    Hibernated,
}

fn drop_on_pile(pile: Pile, nudge: f32) -> (Vec<[f32; 3]>, [f32; 3], World) {
    let hibernate = pile == Pile::Hibernated;
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 6, 6, 2);
    w.native_set_hibernation(if hibernate { on() } else { off() }).expect("config");
    steps(&mut w, 60 + 4 * WINDOW);
    if pile == Pile::Awake {
        let all: Vec<u32> = (0..nodes.len() as u32).collect();
        assert_eq!(freeze_nodes(&mut w, &all).len(), nodes.len());
    }
    if hibernate {
        let all = w.native_hibernation_stats().expect("stats").frozen;
        assert_eq!(all, nodes.len() as u32, "pile did not freeze");
    }
    let corner = chunk(&w, 36).0; // layer 1, row 0, column 0
    add_box(&mut w, Vec3::new(corner[0] + nudge, corner[1] + 3.0, corner[2]), 0.45, 2000.0);
    for t in 0..120 {
        if pile == Pile::Awake && t == 36 {
            let every: Vec<u32> = (0..nodes.len() as u32).map(|n| chunk(&w, n).1).collect();
            w.native_set_entities_hibernated(&every, false).expect("thaw");
        }
        step(&mut w);
    }
    let chunks = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
    (chunks, box_state(&w).0, w)
}

/// How far apart two outcomes of the drop are: the block, and the worst chunk.
fn outcome_gap(a: &(Vec<[f32; 3]>, [f32; 3]), b: &(Vec<[f32; 3]>, [f32; 3])) -> (f32, f32) {
    let worst = a.0.iter().zip(&b.0).map(|(x, y)| distance(*x, *y)).fold(0.0f32, f32::max);
    (distance(a.1, b.1), worst)
}

/// What a struck pile does depends on PhysX's own sleep state: the same pile
/// hit while awake lands measurably differently from one hit asleep (at the
/// production 4/1 solver iterations the block ends ~11 cm and the worst cube
/// ~24 cm apart). Hibernation thaws the struck bodies a step or two before
/// contact, so it can differ from the asleep pile by no more than that.
#[test]
fn an_impact_thaws_locally_within_physx_sleep_variance_and_freezes_again() {
    let (c0, b0, _) = drop_on_pile(Pile::Asleep, 0.0);
    let (c1, b1, _) = drop_on_pile(Pile::Asleep, 0.001);
    let (ca, ba, _) = drop_on_pile(Pile::Awake, 0.0);
    let (chunks, block, mut w) = drop_on_pile(Pile::Hibernated, 0.0);
    let asleep = (c0, b0);
    let nudge = outcome_gap(&asleep, &(c1, b1));
    let awake = outcome_gap(&asleep, &(ca, ba));
    let hibernated = outcome_gap(&asleep, &(chunks.clone(), block));
    println!("(block, worst chunk) from the asleep pile: 1 mm nudge {nudge:?}, awake {awake:?}, hibernated {hibernated:?}");
    let stats = w.native_hibernation_stats().expect("stats");
    println!("after impact: {stats:?}");
    let thawed = stats.thaw_approach + stats.thaw_support + stats.thaw_push;
    assert!(thawed >= 1, "the impact thawed nothing");
    assert!(thawed <= 12, "an impact on one corner thawed {thawed} bodies");
    assert!(hibernated.0 <= awake.0.max(0.02), "block {hibernated:?} vs awake {awake:?}");
    assert!(hibernated.1 <= awake.1.max(0.02), "chunks {hibernated:?} vs awake {awake:?}");
    // Away from the impact nothing moved: every cube more than one cube from
    // the struck corner column ends exactly where the asleep pile left it.
    for (n, (a, b)) in chunks.iter().zip(&asleep.0).enumerate() {
        let (x, z) = (n as u32 % 6, (n as u32 / 6) % 6);
        if x >= 2 || z >= 2 {
            assert!(distance(*a, *b) < 0.002, "chunk {n} far from the impact moved {}", distance(*a, *b));
        }
    }
    // The far corner never thawed.
    let far = chunk(&w, 71);
    assert!(frozen(&w).contains(&far.1), "the far corner thawed");
    // It settles and freezes again.
    let all_before = chunks.len() as u32;
    steps(&mut w, 6 * WINDOW);
    let later = w.native_hibernation_stats().expect("stats");
    println!("later: {later:?}");
    assert!(later.frozen >= all_before, "the pile did not freeze again: {} of {all_before}", later.frozen);
    assert!(w.native_validate_mappings().expect("audit"));
}

/// A 100 kg box thrown at 3 m/s so it clips the top edge of a pile's outer
/// cube -- the hit a face-only contact test misses, turning frozen rubble into
/// a wall. Returns the box's final position and every chunk's centre.
fn throw_at_edge(pile: Pile) -> (Vec<[f32; 3]>, [f32; 3], World) {
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 4, 4, 2);
    w.native_set_hibernation(if pile == Pile::Hibernated { on() } else { off() }).expect("config");
    steps(&mut w, 60 + 3 * WINDOW);
    if pile == Pile::Hibernated {
        assert_eq!(w.native_hibernation_stats().expect("stats").frozen as usize, nodes.len());
    }
    if pile == Pile::Awake {
        let all: Vec<u32> = (0..nodes.len() as u32).collect();
        assert_eq!(freeze_nodes(&mut w, &all).len(), nodes.len());
    }
    add_box(&mut w, Vec3::new(-3.5, 2.5, 0.0), 0.3, 100.0);
    w.apply_impulse(BOX, Vec3::new(300.0, 0.0, 0.0)).expect("push");
    for t in 0..180 {
        if pile == Pile::Awake && t == 18 {
            let every: Vec<u32> = (0..nodes.len() as u32).map(|n| chunk(&w, n).1).collect();
            w.native_set_entities_hibernated(&every, false).expect("thaw");
        }
        step(&mut w);
    }
    let chunks = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
    (chunks, box_state(&w).0, w)
}

#[test]
fn a_box_clipping_a_frozen_edge_does_what_it_does_to_an_unfrozen_one() {
    let (c0, b0, _) = throw_at_edge(Pile::Asleep);
    let (ca, ba, _) = throw_at_edge(Pile::Awake);
    let (ch, bh, w) = throw_at_edge(Pile::Hibernated);
    let asleep = (c0, b0);
    let awake = outcome_gap(&asleep, &(ca, ba));
    let hibernated = outcome_gap(&asleep, &(ch, bh));
    let stats = w.native_hibernation_stats().expect("stats");
    println!("box asleep {b0:?} hibernated {bh:?}; gaps (box, worst chunk): awake {awake:?} hibernated {hibernated:?}; {stats:?}");
    assert!(stats.thaw_approach >= 1, "the box reached the pile without thawing it");
    assert!(hibernated.0 <= awake.0.max(0.02), "box {hibernated:?} vs awake {awake:?}");
    assert!(hibernated.1 <= awake.1.max(0.02), "chunks {hibernated:?} vs awake {awake:?}");
}

/// Zero gravity: a row of four touching cubes struck end-on by an 800 kg box
/// at 6 m/s. Returns each cube's x velocity afterwards and the stats.
fn strike_row(freeze: bool) -> (Vec<f32>, vibe_land_physx_bridge::HibernationStats) {
    let mut w = world(0.0);
    let mut nodes = vec![cube(0, Vec3::new(0.0, 5.0, 30.0))];
    for i in 0..4 {
        nodes.push(cube(i + 1, Vec3::new(i as f32, 5.0, 0.0)));
    }
    install(&mut w, &nodes, &[], 30_000.0);
    w.native_set_hibernation(if freeze { on() } else { off() }).expect("config");
    steps(&mut w, 30);
    if freeze {
        let done = freeze_nodes(&mut w, &[1, 2, 3, 4]);
        assert_eq!(done.len(), 4, "row did not freeze: {done:?}");
    }
    add_box(&mut w, Vec3::new(-3.0, 5.0, 0.0), 0.45, 800.0);
    w.apply_impulse(BOX, Vec3::new(4800.0, 0.0, 0.0)).expect("push");
    steps(&mut w, 120);
    let mut v = Vec::new();
    let p0: Vec<f32> = (1..5).map(|n| chunk(&w, n).0[0]).collect();
    steps(&mut w, 30);
    for (i, n) in (1..5).enumerate() {
        v.push((chunk(&w, n).0[0] - p0[i]) / 0.5);
    }
    (v, w.native_hibernation_stats().expect("stats"))
}

#[test]
fn a_chain_of_frozen_cubes_passes_momentum_on_like_unfrozen_ones() {
    let (control, _) = strike_row(false);
    let (thawed, stats) = strike_row(true);
    println!("control {control:?}\nfrozen  {thawed:?}\n{stats:?}");
    assert!(control[3] > 0.5, "the control row did not carry the impact to its end: {control:?}");
    for (a, b) in thawed.iter().zip(&control) {
        assert!((a - b).abs() < 0.15, "frozen row {thawed:?} differs from control {control:?}");
    }
}

#[test]
fn losing_support_thaws_what_rested_on_it() {
    let mut w = world(-9.81);
    // A column of two cubes and a spare well away from it.
    install(
        &mut w,
        &[
            cube(0, Vec3::new(10.0, 0.5, 10.0)),
            cube(1, Vec3::new(0.0, 0.5, 0.0)),
            cube(2, Vec3::new(0.0, 1.48, 0.0)),
        ],
        &[],
        30_000.0,
    );
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60);
    assert_eq!(freeze_nodes(&mut w, &[1, 2]), vec![1, 2], "column cubes must be fragments");
    let top_at = chunk(&w, 2).0;
    // Knock the bottom cube out at 8 m/s. The box's sweep reaches only the
    // bottom cube; the top must thaw because what holds it up moves.
    add_box(&mut w, Vec3::new(-3.0, 0.5, 0.0), 0.4, 800.0);
    w.apply_impulse(BOX, Vec3::new(6400.0, 0.0, 0.0)).expect("push");
    // Once the box has struck, take it away: only the ground may hold the
    // top cube up now.
    steps(&mut w, 25);
    w.remove_actor(BOX).expect("remove box");
    steps(&mut w, 155);
    let top = chunk(&w, 2).0;
    println!("top from {top_at:?} to {top:?}; {:?}", w.native_hibernation_stats().expect("stats"));
    assert!(top[1] < 1.0, "the top cube is floating at y {}", top[1]);
    assert!(w.native_hibernation_stats().expect("stats").thaw_support >= 1);
    assert!(w.native_validate_mappings().expect("audit"));
}

#[test]
fn a_query_thaws_its_neighbourhood_only() {
    let mut w = world(-9.81);
    rubble(&mut w, 5, 1, 1);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60 + 4 * WINDOW);
    let before = frozen(&w).len();
    assert!(before >= 4);
    // Cubes sit at x = -2..2, 0.04 m apart; a 0.4 m sphere at the last one's
    // centre reaches it alone (the next is 0.52 m away).
    w.wake_bodies_near(Vec3::new(2.0, 0.5, 0.0), 0.4).expect("query");
    let stats = w.native_hibernation_stats().expect("stats");
    assert_eq!(stats.thaw_query, 1, "{stats:?}");
    assert_eq!(frozen(&w).len(), before - 1);
}

#[test]
fn a_fracture_thaws_a_frozen_fragment_inside_the_transaction() {
    let mut w = world(-9.81);
    // A bonded pair lying on the ground, plus a spare cube well away from it.
    // Weak in tension; a round splits it.
    let nodes = [
        cube(0, Vec3::new(10.0, 0.5, 10.0)),
        cube(1, Vec3::new(-0.5, 0.5, 0.0)),
        cube(2, Vec3::new(0.5, 0.5, 0.0)),
    ];
    let bonds = [ChunkBondDesc {
        bond_index: 0,
        node0: 1,
        node1: 2,
        centroid: Vec3::new(0.0, 0.5, 0.0),
        normal: Vec3::new(1.0, 0.0, 0.0),
        area: 0.92,
        material: 0,
    }];
    install(&mut w, &nodes, &bonds, 20_000.0);
    steps(&mut w, 60);
    assert_eq!(chunk(&w, 1).1, chunk(&w, 2).1, "the pair is not one body");
    // Hibernation off: nothing thaws it ahead of the round, so the stage's
    // own transaction is the only way out.
    assert_eq!(freeze_nodes(&mut w, &[1]), vec![1], "the pair did not freeze");
    let mut broken = 0;
    w.native_fire_round(RoundDesc {
        position: Vec3::new(0.5, 0.5, 2.0),
        direction: Vec3::new(0.0, 0.0, -1.0),
        momentum_ns: 4.0e5,
        radius: 0.3,
        speed: 25.0,
        ttl_ticks: 20,
    })
    .expect("fire");
    for _ in 0..90 {
        step(&mut w);
        broken += w.native_take_broken_bonds().expect("drain").len();
    }
    let stats = w.native_hibernation_stats().expect("stats");
    println!("broken {broken}; {stats:?}");
    assert!(broken >= 1, "the round did not split the frozen pair");
    assert_eq!(stats.thaw_topology, 1, "the split did not thaw the fragment");
    assert!(frozen(&w).is_empty());
    assert_ne!(chunk(&w, 1).1, chunk(&w, 2).1, "the halves still share a body");
    for r in rows(&w) {
        assert!(!r.kinematic, "{r:?}");
        assert!(r.position.iter().all(|c| c.is_finite()) && r.position[1] > 0.0, "{r:?}");
    }
    assert!(w.native_validate_mappings().expect("audit"));
}

#[test]
fn turning_it_off_or_clearing_leaves_nothing_frozen() {
    let mut w = world(-9.81);
    rubble(&mut w, 3, 3, 1);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60 + 4 * WINDOW);
    let all = frozen(&w).len();
    assert!(all >= 8);
    w.native_set_hibernation(off()).expect("off");
    assert!(frozen(&w).is_empty());
    assert_eq!(w.native_hibernation_stats().expect("stats").thaw_request, all as u64);
    steps(&mut w, 60);
    assert!(rows(&w).iter().all(|r| !r.kinematic));

    // On again, freeze, then clear the city with bodies frozen and rebuild.
    w.native_set_hibernation(on()).expect("on");
    steps(&mut w, 4 * WINDOW);
    assert!(!frozen(&w).is_empty());
    w.native_clear().expect("clear with frozen debris");
    w.step().expect("step after clear");
    rubble(&mut w, 3, 3, 1);
    assert!(frozen(&w).is_empty());
    steps(&mut w, 60 + 4 * WINDOW);
    // The setting survives the rebuild.
    assert!(!frozen(&w).is_empty(), "a rebuilt city stopped hibernating");
    assert!(w.native_validate_mappings().expect("audit"));
}

/// The city's case: debris the stage itself creates by fracture. A wall of
/// hulls anchored to the ground is shot apart; its rubble settles and
/// hibernates; a second shot into the rubble thaws what it reaches, and the
/// stage stays consistent throughout.
#[test]
fn fracture_debris_hibernates_and_a_second_shot_thaws_it() {
    let mut w = world(-9.81);
    let (columns, rows_) = (6u32, 6u32);
    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let index = |x: u32, y: u32| y * columns + x;
    for y in 0..rows_ {
        for x in 0..columns {
            let mut node = cube(index(x, y), Vec3::new(x as f32 - 2.5, y as f32 + 0.5, 0.0));
            // Zero mass is the authoring convention for a world anchor.
            if y == 0 {
                node.mass = 0.0;
            }
            nodes.push(node);
        }
    }
    for y in 0..rows_ {
        for x in 0..columns {
            for (nx, ny, normal) in [(x + 1, y, Vec3::new(1.0, 0.0, 0.0)), (x, y + 1, Vec3::new(0.0, 1.0, 0.0))] {
                if nx < columns && ny < rows_ {
                    let a = nodes[index(x, y) as usize].centroid;
                    let b = nodes[index(nx, ny) as usize].centroid;
                    bonds.push(ChunkBondDesc {
                        bond_index: bonds.len() as u32,
                        node0: index(x, y),
                        node1: index(nx, ny),
                        centroid: Vec3::new((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, 0.0),
                        normal,
                        area: 0.92,
                        material: 0,
                    });
                }
            }
        }
    }
    install(&mut w, &nodes, &bonds, 30_000.0);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 30);
    let shot = |w: &mut World, y: f32| {
        w.native_fire_round(RoundDesc {
            position: Vec3::new(0.0, y, 1.5),
            direction: Vec3::new(0.0, 0.0, -1.0),
            momentum_ns: 4.0e5,
            radius: 0.4,
            speed: 20.0,
            ttl_ticks: 20,
        })
        .expect("fire");
    };
    shot(&mut w, 3.5);
    let mut broken = 0;
    for _ in 0..(8 * WINDOW) {
        step(&mut w);
        broken += w.native_take_broken_bonds().expect("drain").len();
    }
    let settled = w.native_hibernation_stats().expect("stats");
    let fragments = rows(&w).iter().filter(|r| !r.kinematic).count();
    println!("broken {broken}, fragments {fragments}; {settled:?}");
    assert!(broken > 0 && fragments > 1, "the shot made no debris");
    assert!(settled.frozen as usize * 10 >= fragments * 8, "rubble did not hibernate: {} of {fragments}", settled.frozen);
    assert!(w.native_validate_mappings().expect("audit"));

    // Shoot the rubble low down, where it lies.
    shot(&mut w, 0.6);
    for _ in 0..90 {
        step(&mut w);
    }
    let after = w.native_hibernation_stats().expect("stats");
    println!("after the second shot: {after:?}");
    assert!(after.thaw_approach + after.thaw_support > settled.thaw_approach + settled.thaw_support,
        "the second shot thawed nothing");
    assert!(after.frozen > 0, "one shot thawed the whole pile");
    assert!(w.native_validate_mappings().expect("audit"));
    for r in rows(&w) {
        assert!(r.position.iter().all(|c| c.is_finite()) && r.position[1] > -1.0, "{r:?}");
    }
}

#[test]
#[ignore = "diagnostic: which cubes an impact thaws, step by step"]
fn trace_impact_thaws() {
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 6, 6, 2);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60 + 4 * WINDOW);
    let owner: std::collections::HashMap<u32, u32> =
        (0..nodes.len() as u32).map(|n| (chunk(&w, n).1, n)).collect();
    let corner = chunk(&w, 36).0;
    add_box(&mut w, Vec3::new(corner[0], corner[1] + 3.0, corner[2]), 0.45, 2000.0);
    let mut was: std::collections::HashSet<u32> = frozen(&w).into_iter().collect();
    for t in 0..120 {
        step(&mut w);
        let now: std::collections::HashSet<u32> = frozen(&w).into_iter().collect();
        let thawed: Vec<u32> = was.difference(&now).map(|e| owner[e]).collect();
        if !thawed.is_empty() {
            let (p, v) = box_state(&w);
            println!("t{t}: box y {:.2} vy {:.2}; thawed {:?}", p[1], v[1],
                thawed.iter().map(|n| (n, chunk(&w, *n).0.map(|c| (c * 100.0).round() / 100.0))).collect::<Vec<_>>());
            println!("     {:?}", w.native_hibernation_stats().expect("stats"));
        }
        was = now;
    }
}

#[test]
#[ignore = "diagnostic: does a freeze/thaw round trip alone change an impact?"]
fn trace_impact_round_trip() {
    // mode 0: control; 1: freeze all, thaw all, drop; 2: freeze all, thaw the
    // corner column just before contact (what the policy does), drop.
    let run = |mode: u32| {
        let mut w = world(-9.81);
        let nodes = rubble(&mut w, 6, 6, 2);
        steps(&mut w, 60 + 4 * WINDOW);
        let before: Vec<[f32; 3]> = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
        let all: Vec<u32> = (0..nodes.len() as u32).collect();
        if mode >= 1 {
            assert_eq!(freeze_nodes(&mut w, &all).len(), nodes.len());
            steps(&mut w, 10);
        }
        if mode == 1 {
            let entities: Vec<u32> = all.iter().map(|n| chunk(&w, *n).1).collect();
            assert_eq!(w.native_set_entities_hibernated(&entities, false).expect("thaw") as usize, nodes.len());
            steps(&mut w, 1);
        }
        let corner = before[36];
        add_box(&mut w, Vec3::new(corner[0], corner[1] + 3.0, corner[2]), 0.45, 2000.0);
        for t in 0..120 {
            if mode == 2 && t == 36 {
                let column = [chunk(&w, 0).1, chunk(&w, 36).1];
                assert_eq!(w.native_set_entities_hibernated(&column, false).expect("thaw"), 2);
            }
            if (mode == 4 && t == 6) || (mode == 5 && t == 30) || (mode == 6 && t == 33) {
                // The corner column, thawed 30 / 6 / 3 ticks ahead of contact.
                let column = [chunk(&w, 0).1, chunk(&w, 36).1];
                assert_eq!(w.native_set_entities_hibernated(&column, false).expect("thaw"), 2);
            }
            if (mode == 7 && t == 30) || (mode == 8 && t == 6) {
                let near: Vec<u32> = [0, 1, 6, 7, 36, 37, 42, 43].iter().map(|n| chunk(&w, *n).1).collect();
                w.native_set_entities_hibernated(&near, false).expect("thaw");
            }
            if mode == 9 && t == 36 {
                let every: Vec<u32> = (0..nodes.len() as u32).map(|n| chunk(&w, n).1).collect();
                w.native_set_entities_hibernated(&every, false).expect("thaw");
            }
            if mode == 3 && t == 36 {
                // The corner column and every cube beside it (both layers).
                let near: Vec<u32> = [0, 1, 6, 7, 36, 37, 42, 43].iter().map(|n| chunk(&w, *n).1).collect();
                w.native_set_entities_hibernated(&near, false).expect("thaw");
            }
            step(&mut w);
        }
        let after: Vec<[f32; 3]> = (0..nodes.len() as u32).map(|n| chunk(&w, n).0).collect();
        (before, after, box_state(&w).0)
    };
    let (b0, a0, box0) = run(0);
    let delta = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]].map(|c| (c * 1000.0).round() / 1000.0);
    println!("control: corner moved {:?}, bottom {:?}, block at {box0:?}", delta(a0[36], b0[36]), delta(a0[0], b0[0]));
    for mode in 1..10 {
        let (_, a, bx) = run(mode);
        println!("mode {mode}: block gap {:.4}; corner moved {:?}, bottom {:?}; worst chunk gap {:.4}",
            distance(bx, box0), delta(a[36], b0[36]), delta(a[0], b0[0]),
            a.iter().zip(&a0).map(|(x, y)| distance(*x, *y)).fold(0.0f32, f32::max));
    }
}

/// What clients see. A frozen body is settled debris on the wire, never an
/// anchored remnant; freezing a body that was moving publishes a settle edge
/// at the pose it froze at, and a thaw publishes a wake edge.
#[test]
fn the_wire_sees_a_freeze_as_a_settle_and_a_thaw_as_a_wake() {
    let mut w = world(-9.81);
    rubble(&mut w, 3, 1, 1);
    steps(&mut w, 60);
    let entity = chunk(&w, 1).1;
    assert!(row(&w, entity).sleeping);

    // Asleep -> frozen: already settled on the wire, so no new edge.
    assert_eq!(w.native_set_entities_hibernated(&[entity], true).expect("freeze"), 1);
    step(&mut w);
    let r = row(&w, entity);
    assert!(r.sleeping && !r.kinematic && r.flags == 0, "{r:?}");

    // Thawed: a wake edge.
    assert_eq!(w.native_set_entities_hibernated(&[entity], false).expect("thaw"), 1);
    step(&mut w);
    let r = row(&w, entity);
    assert!(!r.sleeping && !r.kinematic && r.flags == 2, "{r:?}");

    // Awake -> frozen: a settle edge, at exactly the pose it holds.
    assert_eq!(w.native_set_entities_hibernated(&[entity], true).expect("freeze"), 1);
    let at = chunk(&w, 1).0;
    step(&mut w);
    let r = row(&w, entity);
    assert!(r.sleeping && !r.kinematic && r.flags == 1, "{r:?}");
    steps(&mut w, 30);
    assert_eq!(chunk(&w, 1).0, at);
    let r = row(&w, entity);
    assert!(r.sleeping && r.flags == 0, "{r:?}");
}

/// Debris hibernation on the rubble neighbourhoods of rubble_rest.rs (rest
/// sleep is off in this process, so nothing else stops them): the
/// rocking body never sleeps natively, so it must be frozen through the awake
/// rest test (no net drift over three windows, inside a 5 cm envelope).
/// Against the same neighbourhood run without hibernation:
/// - every body is asleep or frozen within twelve seconds;
/// - no body ends further from where the bench left it than it does without
///   hibernation, plus the rest envelope (5 cm): freezing moves nothing, it
///   only stops motion, and a body rocking in a limit cycle stops somewhere
///   inside that envelope -- the same contract as rest sleep, which ends the
///   slab fixture at the identical 4.2 cm;
/// - freezing does not cycle: a body still settling may thaw a frozen
///   neighbour, but no body freezes more than twice, and once everything is
///   at rest nothing thaws.
#[test]
fn rubble_neighbourhoods_hibernate() {
    assert_ne!(
        std::env::var("VIBE_CITY_NATIVE_REST_SLEEP").as_deref(),
        Ok("1"),
        "run without rest sleep: this tests hibernation alone"
    );
    let mut failures = Vec::new();
    use support::rubble::{fixtures, load, report, run_with};
    for name in fixtures() {
        let fixture = load(name);
        let baseline = run_with(&fixture, 900, false);
        let outcome = run_with(&fixture, 900, true);
        report(name, &outcome);
        let h = outcome.hibernation;
        eprintln!("RUBBLE_HIBERNATE {name} baseline moved {:.4} m, asleep at {:?}; hibernated moved {:.4} m; {h:?}",
            baseline.max_moved_m, baseline.all_asleep_tick, outcome.max_moved_m);
        match outcome.all_asleep_tick {
            Some(tick) if tick <= 720 => {}
            other => failures.push(format!("{name}: at rest at {other:?} (limit tick 720), {} awake at 15 s", outcome.awake_at_end)),
        }
        if outcome.max_moved_m > baseline.max_moved_m + 0.05 {
            failures.push(format!("{name}: a body ended {:.3} m from the bench, {:.3} m without hibernation",
                outcome.max_moved_m, baseline.max_moved_m));
        }
        let bodies = fixture.bodies.len() as u64;
        if h.froze_total > 2 * bodies {
            failures.push(format!("{name}: {} freezes for {bodies} bodies: {h:?}", h.froze_total));
        }
        if h.thawed_last_step != 0 || outcome.keeper_path_m > 1e-6 {
            failures.push(format!("{name}: still thawing or moving at the end: {h:?}, keeper path {:.4}", outcome.keeper_path_m));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn span(world: &World, name: &str) -> f64 {
    world.native_stats().expect("stats");
    world.take_destruction_spans().into_iter().find(|s| s.name == name).map_or(0.0, |s| s.value)
}

/// Mean wall time of `n` steps (step + observe), in ms.
fn timed_steps(world: &mut World, n: u32) -> f64 {
    let started = std::time::Instant::now();
    steps(world, n);
    started.elapsed().as_secs_f64() * 1000.0 / n as f64
}

#[test]
#[ignore = "diagnostic: what the hibernation passes cost (timings are noisy on a shared GPU)"]
fn cost_of_hibernation_passes() {
    let side = 20u32;
    // Control: the same pile asleep, hibernation off.
    let mut control = world(-9.81);
    rubble(&mut control, side, side, 2);
    steps(&mut control, 2 * WINDOW);
    let asleep_ms = timed_steps(&mut control, 240);
    drop(control);

    let mut w = world(-9.81);
    let nodes = rubble(&mut w, side, side, 2);
    w.native_set_hibernation(on()).expect("config");
    // Step to the first window boundary after the pile sleeps, and read the
    // freeze pass that froze it.
    steps(&mut w, 60);
    let mut freeze_ms = 0.0;
    for _ in 0..2 * WINDOW {
        step(&mut w);
        let frozen_now = w.native_hibernation_stats().expect("stats").frozen;
        if frozen_now as usize == nodes.len() && freeze_ms == 0.0 {
            freeze_ms = span(&w, "native_hibernate_freeze_ms");
        }
    }
    let stats = w.native_hibernation_stats().expect("stats");
    assert_eq!(stats.frozen as usize, nodes.len());
    let frozen_ms = timed_steps(&mut w, 240);

    // Ten boxes rolling across the top of the frozen pile at 3 m/s.
    for i in 0..10u32 {
        w.add_dynamic_box(DynamicBoxDesc {
            entity_id: 0x2100_0000 + i,
            user_id: 0,
            pose: Pose { position: Vec3::new(-11.0, 2.5, i as f32 * 2.0 - 9.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(0.3, 0.3, 0.3),
            mass: 100.0,
            collision_group: GROUP_DYNAMIC,
            collision_mask: ALL,
        })
        .expect("box");
        w.apply_impulse(0x2100_0000 + i, Vec3::new(300.0, 0.0, 0.0)).expect("push");
    }
    step(&mut w);
    for b in w.body_snapshots().expect("bodies").into_iter().filter(|b| b.entity_id >= 0x2100_0000).take(2) {
        println!("after one step: box {:#x} v ({:.2},{:.2},{:.2}) sleeping {}", b.entity_id, b.linear_velocity.x,
            b.linear_velocity.y, b.linear_velocity.z, b.sleeping);
    }
    let (mut thaw_sum, mut thaw_max) = (0.0f64, 0.0f64);
    let started = std::time::Instant::now();
    for _ in 0..240 {
        step(&mut w);
        let t = span(&w, "native_hibernate_thaw_ms");
        thaw_sum += t;
        thaw_max = thaw_max.max(t);
    }
    let rolling_ms = started.elapsed().as_secs_f64() * 1000.0 / 240.0;
    let after = w.native_hibernation_stats().expect("stats");
    println!("pile of {} bodies", nodes.len());
    println!("freeze pass that froze all of them: {freeze_ms:.3} ms");
    println!("idle step: asleep {asleep_ms:.3} ms, frozen {frozen_ms:.3} ms");
    println!("ten boxes rolling over it: step {rolling_ms:.3} ms, thaw test mean {:.4} ms max {thaw_max:.4} ms",
        thaw_sum / 240.0);
    println!("{after:?}");
    for b in w.body_snapshots().expect("bodies").into_iter().filter(|b| b.entity_id >= 0x2100_0000) {
        println!("box {:#x} at ({:.2},{:.2},{:.2}) v ({:.2},{:.2},{:.2})", b.entity_id, b.pose.position.x, b.pose.position.y,
            b.pose.position.z, b.linear_velocity.x, b.linear_velocity.y, b.linear_velocity.z);
    }
}

#[test]
#[ignore = "diagnostic: a box rolled into a frozen pile, tick by tick"]
fn trace_box_into_frozen_pile() {
    let mut w = world(-9.81);
    let nodes = rubble(&mut w, 4, 4, 2);
    w.native_set_hibernation(on()).expect("config");
    steps(&mut w, 60 + 3 * WINDOW);
    assert_eq!(w.native_hibernation_stats().expect("stats").frozen as usize, nodes.len());
    add_box(&mut w, Vec3::new(-3.5, 2.5, 0.0), 0.3, 100.0);
    w.apply_impulse(BOX, Vec3::new(300.0, 0.0, 0.0)).expect("push");
    for t in 0..60 {
        step(&mut w);
        let (p, v) = box_state(&w);
        let h = w.native_hibernation_stats().expect("stats");
        if t % 3 == 0 || h.thawed_last_step > 0 {
            println!("t{t}: box ({:.2},{:.2},{:.2}) v ({:.2},{:.2},{:.2}) frozen {} thawed {}", p[0], p[1], p[2], v[0], v[1], v[2], h.frozen, h.thawed_last_step);
        }
    }
}
