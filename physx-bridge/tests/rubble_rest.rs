#![cfg(feature = "native-destruction")]

//! Rubble that is at rest must be allowed to sleep.
//!
//! After a systematic city bench every run ended with 437-502 city bodies
//! awake for good. Measured from the bench's world truth (the city encoder
//! tape, every awake body's pose each tick): 95% of those bodies had not moved
//! at all -- pose identical tick to tick for 15 s -- yet they were awake,
//! because PhysX sleeps a whole contact island at once and each island held
//! one or two bodies that never stopped moving. Those bodies were not going
//! anywhere either. Each was a thin chunk (a 0.15 m wall panel, or a 0.22 m
//! floor slab lying on panels) in an exact limit cycle: the same poses
//! repeating every 3, 8 or 24 ticks, 2-27 mm amplitude, zero net drift.
//!
//! The fixtures here are such neighbourhoods cut out of a bench's world
//! truth: the rocking body, every body within 4 m of it as it lay, and
//! everything within 8 m beyond that as static boxes. Each body is authored as
//! its own native destruction structure, so it is a stage-owned body built by
//! the production code path, with production damping and solver settings.
//! The test restarts them at rest and asks whether the neighbourhood sleeps,
//! and where the bodies end up.
//!
//! `#[ignore]`: needs the GPU. Run with `--test-threads=1` on Metal.

use vibe_land_physx_bridge::{
    ChunkBondDesc, ChunkNodeDesc, DestructibleSettings, NativeConfig, Pose, Quat, StaticBoxDesc,
    StressMaterialDesc, Vec3, World, WorldConfig,
};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_CHUNK: u32 = 1 << 5;
const ALL: u32 = u32::MAX;

struct Chunk {
    local: [f32; 3],
    half: [f32; 3],
    mass: f32,
    volume: f32,
}

struct Body {
    name: String,
    position: [f32; 3],
    rotation: [f32; 4],
    chunks: Vec<Chunk>,
}

struct StaticBox {
    centre: [f32; 3],
    rotation: [f32; 4],
    half: [f32; 3],
}

struct Fixture {
    keeper: String,
    bodies: Vec<Body>,
    statics: Vec<StaticBox>,
}

fn load(name: &str) -> Fixture {
    let path = format!("{}/tests/fixtures/rubble/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let mut fixture = Fixture { keeper: String::new(), bodies: Vec::new(), statics: Vec::new() };
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
        let mut words = line.split_whitespace();
        let kind = words.next().unwrap();
        let rest: Vec<&str> = words.collect();
        let f = |i: usize| rest[i].parse::<f32>().unwrap();
        match kind {
            "keeper" => fixture.keeper = rest[0].to_string(),
            "body" => fixture.bodies.push(Body {
                name: rest[0].to_string(),
                position: [f(1), f(2), f(3)],
                rotation: [f(4), f(5), f(6), f(7)],
                chunks: Vec::new(),
            }),
            "chunk" => fixture.bodies.last_mut().unwrap().chunks.push(Chunk {
                local: [f(0), f(1), f(2)],
                half: [f(3), f(4), f(5)],
                mass: f(6),
                volume: f(7),
            }),
            "static" => fixture.statics.push(StaticBox {
                centre: [f(0), f(1), f(2)],
                rotation: [f(3), f(4), f(5), f(6)],
                half: [f(7), f(8), f(9)],
            }),
            other => panic!("unknown fixture line {other}"),
        }
    }
    fixture
}

/// Strong enough that nothing breaks: a fixture body stays the body it was.
fn settings() -> DestructibleSettings {
    DestructibleSettings {
        max_solver_iterations_per_frame: 2048,
        graph_reduction_level: 0,
        materials: vec![StressMaterialDesc {
            compression_elastic: 1.0e12,
            compression_fatal: 2.0e12,
            tension_elastic: 1.0e12,
            tension_fatal: 2.0e12,
            shear_elastic: 1.0e12,
            shear_fatal: 2.0e12,
            elastic_modulus: 30.0e9,
            residual_area_fraction: 0.0,
        }],
        maximum_bodies: 0,
        maximum_fractures_per_actor_per_tick: 0,
        apply_excess_forces: false,
        apply_centrifugal: false,
        excess_force_scale: 0.0,
        // /city's debris damping (`city_config::debris_damping`): none.
        linear_damping: 0.0,
        angular_damping: 0.0,
    }
}

fn quat(q: [f32; 4]) -> Quat {
    Quat { x: q[0], y: q[1], z: q[2], w: q[3] }
}

/// How a neighbourhood played out.
#[derive(Debug)]
struct Outcome {
    /// First tick with every fixture body asleep, if any.
    all_asleep_tick: Option<u32>,
    /// Bodies awake at the end.
    awake_at_end: usize,
    /// The rocking body's path over the last second, and its net displacement.
    keeper_path_m: f32,
    keeper_net_m: f32,
    /// Largest distance any body ended from where the fixture put it, and the
    /// largest rotation.
    max_moved_m: f32,
    max_turned_deg: f32,
    /// Final positions by body name, for comparing arms.
    finals: Vec<(String, [f32; 3], [f32; 4])>,
}

fn run(fixture: &Fixture, ticks: u32) -> Outcome {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    // The /city floor: a slab with its top at y = 0.
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 0x1000_0001,
            user_id: 0,
            pose: Pose { position: Vec3::new(0.0, -10.0, 0.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(2000.0, 10.0, 2000.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");
    for (i, s) in fixture.statics.iter().enumerate() {
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 0x1100_0000 + i as u32,
                user_id: 0,
                pose: Pose {
                    position: Vec3::new(s.centre[0], s.centre[1], s.centre[2]),
                    rotation: quat(s.rotation),
                },
                half_extents: Vec3::new(s.half[0], s.half[1], s.half[2]),
                collision_group: GROUP_STATIC,
                collision_mask: ALL,
            })
            .expect("static box");
    }

    world.native_attach().expect("stage attach");
    let mut chunks = 0u32;
    for (id, body) in fixture.bodies.iter().enumerate() {
        let nodes: Vec<ChunkNodeDesc> = body
            .chunks
            .iter()
            .enumerate()
            .map(|(i, c)| ChunkNodeDesc {
                node_index: i as u32,
                centroid: Vec3::new(c.local[0], c.local[1], c.local[2]),
                mass: c.mass,
                volume: c.volume,
                geom_kind: 0,
                half_extents: Vec3::new(c.half[0], c.half[1], c.half[2]),
                convex_points: Vec::new(),
            })
            .collect();
        // A chain holds a multi-chunk body together; its layout is irrelevant
        // because nothing it carries can break.
        let bonds: Vec<ChunkBondDesc> = (1..body.chunks.len())
            .map(|i| {
                let (a, b) = (&body.chunks[i - 1].local, &body.chunks[i].local);
                let d = Vec3::new(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                let len = (d.x * d.x + d.y * d.y + d.z * d.z).sqrt().max(1e-3);
                ChunkBondDesc {
                    bond_index: i as u32 - 1,
                    node0: i as u32 - 1,
                    node1: i as u32,
                    centroid: Vec3::new((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0),
                    normal: Vec3::new(d.x / len, d.y / len, d.z / len),
                    area: 1.0,
                    material: 0,
                }
            })
            .collect();
        chunks += nodes.len() as u32;
        world
            .native_create_destructible(
                id as u32,
                Pose {
                    position: Vec3::new(body.position[0], body.position[1], body.position[2]),
                    rotation: quat(body.rotation),
                },
                &nodes,
                &bonds,
                settings(),
                GROUP_CHUNK,
                ALL,
            )
            .expect("author body");
    }
    world.step().expect("identity step");
    world
        .native_configure(NativeConfig {
            max_iterations: 16,
            tolerance: 1.0e-3,
            warm_start: true,
            damage_rate: 2.0,
            bend_gain_max: 3.0,
            fibre_bending: true,
            reserved_contact_pairs: chunks * 3 / 2,
            preserve_unchanged_contact_pairs: true,
            gpu_island_repair: true,
            verdict_sample_ticks: 60,
        })
        .expect("configure stage");

    let keeper_index = fixture.bodies.iter().position(|b| b.name == fixture.keeper).expect("keeper") as u32;
    let trace = std::env::var("VIBE_RUBBLE_TRACE").is_ok();
    let mut all_asleep_tick = None;
    let mut keeper_trace: Vec<[f32; 3]> = Vec::new();
    let mut awake_at_end = 0;
    let mut finals = Vec::new();
    for tick in 0..ticks {
        world.step().expect("step");
        world.native_tick().expect("native tick");
        let rows = world.native_chunk_body_snapshots().expect("snapshots");
        let awake = rows.iter().filter(|r| !r.kinematic && !r.sleeping).count();
        if awake == 0 && all_asleep_tick.is_none() && tick > 2 {
            all_asleep_tick = Some(tick);
        }
        if let Some(k) = rows.iter().find(|r| r.structure_id == keeper_index) {
            keeper_trace.push([k.position.x, k.position.y, k.position.z]);
            if trace && (300..330).contains(&tick) {
                eprintln!(
                    "RUBBLE_TRACE {tick} p {:.4} {:.4} {:.4} v {:.3} {:.3} {:.3} w {:.3} {:.3} {:.3} q {:.4} {:.4} {:.4} {:.4} awake {awake}",
                    k.position.x, k.position.y, k.position.z, k.linear_velocity.x, k.linear_velocity.y,
                    k.linear_velocity.z, k.angular_velocity.x, k.angular_velocity.y, k.angular_velocity.z,
                    k.rotation.x, k.rotation.y, k.rotation.z, k.rotation.w
                );
            }
        }
        if tick + 1 == ticks {
            awake_at_end = awake;
            for r in rows.iter() {
                let name = fixture.bodies[r.structure_id as usize].name.clone();
                finals.push((
                    name,
                    [r.position.x, r.position.y, r.position.z],
                    [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w],
                ));
            }
        }
    }
    let tail = &keeper_trace[keeper_trace.len().saturating_sub(60)..];
    let dist = |a: &[f32; 3], b: &[f32; 3]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    let keeper_path_m = tail.windows(2).map(|w| dist(&w[0], &w[1])).sum();
    let keeper_net_m = tail.first().zip(tail.last()).map_or(0.0, |(a, b)| dist(a, b));
    let (mut max_moved_m, mut max_turned_deg) = (0.0f32, 0.0f32);
    for (name, p, q) in &finals {
        let body = fixture.bodies.iter().find(|b| &b.name == name).unwrap();
        max_moved_m = max_moved_m.max(dist(p, &body.position));
        let dot = (q[0] * body.rotation[0] + q[1] * body.rotation[1] + q[2] * body.rotation[2] + q[3] * body.rotation[3]).abs();
        max_turned_deg = max_turned_deg.max((2.0 * dot.min(1.0).acos()).to_degrees());
    }
    Outcome { all_asleep_tick, awake_at_end, keeper_path_m, keeper_net_m, max_moved_m, max_turned_deg, finals }
}

fn report(name: &str, outcome: &Outcome) {
    eprintln!(
        "RUBBLE_REST {{\"fixture\":\"{name}\",\"stabilization\":\"{}\",\"rest_sleep\":\"{}\",\"all_asleep_tick\":{},\
\"awake_at_end\":{},\"keeper_path_m\":{:.4},\"keeper_net_m\":{:.4},\"max_moved_m\":{:.4},\"max_turned_deg\":{:.2}}}",
        std::env::var("VIBE_CITY_NATIVE_STABILIZATION_THRESHOLD").unwrap_or_default(),
        std::env::var("VIBE_CITY_NATIVE_REST_SLEEP").unwrap_or_default(),
        outcome.all_asleep_tick.map_or("null".to_string(), |t| t.to_string()),
        outcome.awake_at_end,
        outcome.keeper_path_m,
        outcome.keeper_net_m,
        outcome.max_moved_m,
        outcome.max_turned_deg,
    );
    for (body, p, q) in &outcome.finals {
        eprintln!(
            "RUBBLE_FINAL {name} {body} {:.5} {:.5} {:.5} {:.6} {:.6} {:.6} {:.6}",
            p[0], p[1], p[2], q[0], q[1], q[2], q[3]
        );
    }
}

fn fixtures() -> Vec<&'static str> {
    match std::env::var("VIBE_RUBBLE_FIXTURES") {
        Ok(list) if !list.is_empty() => list.split(',').map(|s| &*Box::leak(s.to_string().into_boxed_str())).collect(),
        _ => vec!["panel-rocking-8tick.txt", "panel-rocking-3tick.txt", "slab-on-panel-24tick.txt"],
    }
}

/// Each fixture, restarted at rest, must be asleep within twelve seconds.
///
/// panel-rocking-8tick is the one that tells: restarted from the bench's
/// truth, its panel takes up the same 8-tick rocking and, without the bridge's
/// rest sleep (`sleep_resting_islands` in native_observation.cc), never
/// sleeps -- measured under 4, 8 or 16 position iterations, 4 velocity
/// iterations, TGS and a 5 cm contact offset alike. With it, the neighbourhood
/// sleeps at tick 479, with no body more than 12 mm from where the bench left it.
/// The other two settle and sleep on their own once restarted (ticks 76 and
/// 712 either way) and are kept as regression cover.
/// The rest sleep is opt-in (`VIBE_CITY_NATIVE_REST_SLEEP=1`); this test turns
/// it on unless the caller set the variable (=0 makes this fail).
#[test]
#[ignore = "needs a GPU"]
fn rubble_neighbourhoods_sleep() {
    if std::env::var_os("VIBE_CITY_NATIVE_REST_SLEEP").is_none() {
        std::env::set_var("VIBE_CITY_NATIVE_REST_SLEEP", "1");
    }
    let mut failures = Vec::new();
    for name in fixtures() {
        let fixture = load(name);
        let outcome = run(&fixture, 900);
        report(name, &outcome);
        match outcome.all_asleep_tick {
            Some(tick) if tick <= 720 => {}
            other => failures.push(format!(
                "{name}: asleep at {other:?} (limit tick 720), {} awake at 15 s, rocking body path {:.3} m in the last second",
                outcome.awake_at_end, outcome.keeper_path_m
            )),
        }
    }
    assert!(failures.is_empty(), "neighbourhoods that did not sleep:\n{}", failures.join("\n"));
}
