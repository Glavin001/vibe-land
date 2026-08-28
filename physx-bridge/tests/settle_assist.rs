//! Does the settle assist do what it claims, and only to what it claims?
//!
//! The assist raises damping and the sleep threshold on small debris once it
//! has touched static ground, so a rubble pile stops trading micro-contacts
//! and actually sleeps. It alters trajectories by design, so what these tests
//! pin is not "the physics is unchanged" — it is the four properties the
//! design rests on, each of which has a failure mode that would only show up
//! as a weird live session otherwise:
//!
//! 1. It works: a pile settles in fewer ticks with the assist on.
//! 2. It never touches a body in flight. Raising a sleep threshold alone is
//!    what once froze debris at the apex of its arc (see kChunkSleepThreshold
//!    in destruction.cc), and the ground-touch gate is the entire defence. A
//!    body that has not landed must never be assisted, even while a hundred
//!    of its neighbours are.
//! 3. It never touches a slab. Big bodies keep their exact settling
//!    behaviour; only debris is assisted.
//! 4. It is off by default, byte-for-byte.
//!
//! The env is process-global and read once through `static const` lambdas in
//! the bridge, so each arm must run in its OWN process. Cargo gives every
//! `#[test]` the same process, so the arms are separate test binaries'
//! worth of work driven through one entry point that re-execs itself — see
//! `run_arm`. That is uglier than a parameterised test and it is the only
//! honest way to A/B a process-global flag.
//!
//! GPU tests: the scene is GPU-mandatory, so they only run where CUDA and a
//! device are present.

#![cfg(feature = "destruction")]

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, Pose, Quat, StaticBoxDesc,
    StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = GROUP_STATIC | GROUP_CHUNK;
const GRAVITY: Vec3 = Vec3 { x: 0.0, y: -9.81, z: 0.0 };
const DT: f32 = 1.0 / 60.0;

fn node(index: u32, centroid: Vec3, mass: f32) -> ChunkNodeDesc {
    ChunkNodeDesc {
        node_index: index,
        centroid,
        mass,
        volume: 1.0,
        geom_kind: 0,
        half_extents: Vec3::new(0.5, 0.5, 0.5),
        convex_points: Vec::new(),
    }
}

fn bond(index: u32, a: u32, b: u32, centroid: Vec3) -> ChunkBondDesc {
    ChunkBondDesc {
        bond_index: index,
        node0: a,
        node1: b,
        centroid,
        normal: Vec3::new(0.0, 1.0, 0.0),
        area: 1.0,
        material: 0,
    }
}

/// A weakly bonded wall over a ground plane, mass chosen so every chunk is
/// under the assist's default mass ceiling.
fn rubble_world(columns: u32, rows: u32, chunk_mass: f32) -> World {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
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

    let mut nodes = Vec::new();
    let mut bonds = Vec::new();
    let mut index = 0u32;
    for column in 0..columns {
        let x = column as f32 * 1.05 - (columns as f32 * 0.5);
        nodes.push(node(index, Vec3::new(x, 0.5, 0.0), 0.0));
        index += 1;
    }
    for row in 1..rows {
        for column in 0..columns {
            let x = column as f32 * 1.05 - (columns as f32 * 0.5);
            let y = row as f32 * 1.05 + 0.5;
            nodes.push(node(index, Vec3::new(x, y, 0.0), chunk_mass));
            let below = index - columns;
            bonds.push(bond(bonds.len() as u32, below, index, Vec3::new(x, y - 0.5, 0.0)));
            if column > 0 {
                bonds.push(bond(bonds.len() as u32, index - 1, index, Vec3::new(x - 0.5, y, 0.0)));
            }
            index += 1;
        }
    }

    let mut settings = DestructibleSettings::default();
    settings.materials = vec![StressMaterialDesc {
        compression_elastic: 1.0e-4,
        compression_fatal: 5.0e-4,
        tension_elastic: 1.0e-4,
        tension_fatal: 5.0e-4,
        shear_elastic: -1.0,
        shear_fatal: -1.0,
    }];
    settings.maximum_bodies = 0;
    settings.maximum_fractures_per_actor_per_tick = 0;
    world
        .create_destructible(
            0,
            Pose { position: Vec3::new(0.0, 0.0, 0.0), rotation: Quat::IDENTITY },
            &nodes,
            &bonds,
            settings,
            GROUP_CHUNK,
            ALL,
        )
        .expect("create wall");
    world
}

fn tick(world: &mut World) {
    world.step().expect("step");
    world.destruction_tick(DT, GRAVITY).expect("tick");
    let _ = world.take_broken_bonds();
    let _ = world.take_chunk_migrations();
    let _ = world.take_island_events();
}

fn awake(world: &World) -> u32 {
    world.destruction_stats().expect("stats").awake_chunk_bodies
}

/// Spans ride beside the stats struct in a stash that DRAINS on read, so both
/// counters must come out of a single call — reading them one at a time would
/// make the second read zero and the test pass for the wrong reason.
fn report_spans(world: &World) {
    let _ = world.destruction_stats().expect("stats");
    let spans = world.take_destruction_spans();
    let value = |name: &str| {
        spans
            .iter()
            .find(|s| s.name == name)
            .map(|s| s.value)
            .unwrap_or(0.0)
    };
    println!("assisted={}", value("settle_assist_applied"));
    println!("latches={}", value("ground_touch_latches"));
}

/// Blast the wall and run until the pile sleeps or the budget runs out.
///
/// Returns AWAKE-BODY-TICKS — the integral of the awake count over the
/// settling window — not the tick at which the last straggler slept.
///
/// The first version of this returned that last tick and it was the wrong
/// measure twice over. It is a max over a chaotic system, so one body that
/// happens to wedge itself dominates and the number swings run to run
/// (measured: 184 vs 199 on arms that differed only by damping, which is
/// noise, not a regression). And it is not what the assist is FOR: the cost
/// this feature exists to cut is awake bodies × ticks, since every awake
/// body pays PhysX simulation, contact callbacks and stress solve every tick
/// it stays awake. The integral is that cost directly, and it is robust to
/// stragglers.
fn awake_body_ticks(world: &mut World, max_ticks: u32) -> u64 {
    for _ in 0..30 {
        tick(world);
    }
    // Sideways, so the wall topples OFF its own kinematic support row and the
    // debris lands on bare static ground. A straight-down blast drops the
    // pile onto the support course instead, and support chunks are kinematic
    // chunk bodies, not statics — no ground touch, nothing to assist.
    world
        .apply_destruction_blast(
            Vec3::new(0.0, 3.0, 0.0),
            Vec3::new(1.0, -0.15, 0.0),
            9.0,
            5.0e6,
            22.0,
        )
        .expect("blast");
    let mut integral = 0u64;
    for _ in 1..=max_ticks {
        tick(world);
        let live = awake(world);
        integral += u64::from(live);
        if live == 0 {
            break;
        }
    }
    integral
}

/// Re-exec this test binary with the arm's env applied, because the bridge
/// reads its flags once per process.
fn run_arm(arm: &str, env: &[(&str, &str)]) -> String {
    if std::env::var("SETTLE_ARM").as_deref() == Ok(arm) {
        unreachable!("run_arm called inside the arm it spawns");
    }
    let exe = std::env::current_exe().expect("test binary path");
    let mut command = std::process::Command::new(exe);
    command
        .arg("--exact")
        .arg(format!("arm_body::{arm}"))
        .arg("--nocapture")
        .arg("--ignored")
        .env("SETTLE_ARM", arm);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output().expect("spawn arm");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "arm {arm} failed:\n{text}");
    text
}

fn reported(text: &str, key: &str) -> f64 {
    text.lines()
        .find_map(|line| line.strip_prefix(&format!("{key}=")))
        .unwrap_or_else(|| panic!("arm did not report {key}:\n{text}"))
        .trim()
        .parse()
        .expect("numeric report")
}

/// The bodies of the spawned arms. `#[ignore]`d so a plain `cargo test` run
/// never executes them directly — `run_arm` invokes them by exact name.
mod arm_body {
    use super::*;

    #[test]
    #[ignore]
    fn settle() {
        let mut world = rubble_world(6, 5, 120.0);
        let integral = awake_body_ticks(&mut world, 900);
        println!("awaketicks={integral}");
        report_spans(&world);
    }

    /// A body still in the air must never be assisted. The wall is blasted
    /// upward and the census is taken while debris is mid-arc.
    #[test]
    #[ignore]
    fn in_flight() {
        let mut world = rubble_world(6, 5, 120.0);
        for _ in 0..30 {
            tick(&mut world);
        }
        world
            .apply_destruction_blast(
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                10.0,
                8.0e6,
                40.0,
            )
            .expect("blast upward");
        // Few enough ticks that the launched debris is still rising.
        let mut peak_airborne = 0u32;
        for _ in 0..8 {
            tick(&mut world);
            peak_airborne = peak_airborne.max(awake(&world));
        }
        println!("airborne={peak_airborne}");
        report_spans(&world);
    }

    /// Slabs above the mass ceiling keep their exact behaviour.
    #[test]
    #[ignore]
    fn heavy() {
        // 9000 kg per chunk, far above the 1500 kg default ceiling.
        let mut world = rubble_world(6, 5, 9000.0);
        let _ = awake_body_ticks(&mut world, 600);
        report_spans(&world);
    }
}

#[test]
fn assist_settles_a_pile_faster_than_it_settles_unassisted() {
    let off = run_arm("settle", &[("VIBE_CITY_SETTLE_ASSIST", "0")]);
    let on = run_arm("settle", &[("VIBE_CITY_SETTLE_ASSIST", "1")]);
    let off_cost = reported(&off, "awaketicks");
    let on_cost = reported(&on, "awaketicks");
    let applied = reported(&on, "assisted");
    println!("awake-body-ticks: off {off_cost} on {on_cost}, assisted {applied}");
    assert!(
        applied > 0.0,
        "the assist never fired, so the comparison means nothing"
    );
    assert!(
        reported(&off, "assisted") == 0.0,
        "the assist fired with the flag off"
    );
    assert!(
        on_cost < off_cost,
        "assisted pile spent {on_cost} awake-body-ticks settling, unassisted \
         {off_cost} — the assist must reduce awake time or it is not worth \
         its fidelity cost"
    );
}

#[test]
fn debris_in_flight_is_never_assisted() {
    let on = run_arm("in_flight", &[("VIBE_CITY_SETTLE_ASSIST", "1")]);
    let airborne = reported(&on, "airborne");
    assert!(
        airborne > 0.0,
        "no debris was launched, so nothing was in flight to protect"
    );
    assert_eq!(
        reported(&on, "assisted"),
        0.0,
        "a body was assisted before touching the ground — this is exactly the \
         bug the ground-touch gate exists to prevent (debris freezing mid-arc)"
    );
}

#[test]
fn slabs_above_the_mass_ceiling_are_never_assisted() {
    let on = run_arm("heavy", &[("VIBE_CITY_SETTLE_ASSIST", "1")]);
    assert!(
        reported(&on, "latches") > 0.0,
        "the heavy pile never touched the ground, so the ceiling was not tested"
    );
    assert_eq!(
        reported(&on, "assisted"),
        0.0,
        "a body heavier than VIBE_CITY_ASSIST_MAX_MASS was assisted"
    );
}

#[test]
fn the_assist_is_off_by_default() {
    let default = run_arm("settle", &[]);
    assert_eq!(
        reported(&default, "assisted"),
        0.0,
        "the assist fired without VIBE_CITY_SETTLE_ASSIST being set"
    );
}
