//! Does a stack of boxes actually come to rest?
//!
//! Debris in `/city` is thousands of chunks lying on each other, so stacking is
//! the load case that matters, not loose props. A city left idle for three
//! hours still had 3,564 bodies awake and 71 asleep.
//!
//! The mechanism under test is the **residual velocity floor**. Contact solving
//! is iterative: each pass reduces error but never eliminates it, so an
//! under-iterated stack settles to a non-zero velocity rather than to zero.
//! That matters because it is not a matter of waiting longer -- if velocity
//! asymptotes to a floor above the sleep threshold, the body never sleeps, at
//! any timescale. Raising the sleep threshold past the floor only hides it, and
//! makes a visibly-moving body snap to stationary.
//!
//! These tests are `#[ignore]`d because they need a GPU.
#![cfg(feature = "gpu")]

use vibe_land_physx_bridge::{
    DynamicBoxDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig,
};

const GROUP: u32 = 1 << 5;
const ALL: u32 = u32::MAX;
const DT_HZ: u32 = 60;

/// Half-extent of a stacked box. Roughly the median `/city` chunk.
const HALF: f32 = 0.85;

struct Outcome {
    asleep_pct: f32,
    /// The floor: the fastest still-awake body once things have settled.
    max_speed: f32,
    /// Most-penetrating body relative to the ground plane.
    min_y: f32,
    bodies: usize,
    step_ms: f32,
}

/// A pyramid of boxes: deep contact chains, mutual support, the shape rubble
/// actually takes. A single column would understate the problem -- error
/// accumulates down a stack, so width matters as much as height.
fn build_pile(world: &mut World, layers: u32) -> usize {
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 0,
            pose: Pose { position: Vec3::new(0.0, -1.0, 0.0), rotation: Quat::IDENTITY },
            half_extents: Vec3::new(60.0, 1.0, 60.0),
            collision_group: GROUP,
            collision_mask: ALL,
        })
        .expect("ground");

    let mut id = 100u32;
    let mut count = 0usize;
    let gap = HALF * 2.0 + 0.01;
    for layer in 0..layers {
        let side = layers - layer;
        // Start each layer just clear of the one below, so the pile settles
        // under its own weight rather than starting interpenetrated.
        let y = 0.02 + HALF + layer as f32 * gap;
        for ix in 0..side {
            for iz in 0..side {
                let ox = (ix as f32 - (side as f32 - 1.0) * 0.5) * gap;
                let oz = (iz as f32 - (side as f32 - 1.0) * 0.5) * gap;
                world
                    .add_dynamic_box(DynamicBoxDesc {
                        entity_id: id,
                        user_id: 0,
                        pose: Pose { position: Vec3::new(ox, y, oz), rotation: Quat::IDENTITY },
                        half_extents: Vec3::new(HALF, HALF, HALF),
                        // 2400 kg/m^3 concrete, like a real chunk.
                        mass: (HALF * 2.0).powi(3) * 2400.0,
                        collision_group: GROUP,
                        collision_mask: ALL,
                    })
                    .expect("box");
                id += 1;
                count += 1;
            }
        }
    }
    count
}

/// Pile depth, overridable so the same test can probe for a scale threshold.
fn layers_from_env(default: u32) -> u32 {
    std::env::var("VIBE_STACK_LAYERS")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn settle(layers: u32, seconds: u32) -> Outcome {
    let mut world = World::new(WorldConfig::default()).expect("GPU world");
    let bodies = build_pile(&mut world, layers);

    let started = std::time::Instant::now();
    let steps = seconds * DT_HZ;
    for _ in 0..steps {
        world.step().expect("step");
    }
    let step_ms = started.elapsed().as_secs_f32() * 1000.0 / steps as f32;

    let snaps = world.body_snapshots().expect("snapshots");
    let dynamic: Vec<_> = snaps.iter().filter(|s| s.entity_id >= 100).collect();
    let asleep = dynamic.iter().filter(|s| s.sleeping).count();
    let max_speed = dynamic
        .iter()
        .filter(|s| !s.sleeping)
        .map(|s| {
            let v = s.linear_velocity;
            (v.x * v.x + v.y * v.y + v.z * v.z).sqrt()
        })
        .fold(0.0f32, f32::max);
    let min_y = dynamic.iter().map(|s| s.pose.position.y).fold(f32::MAX, f32::min);

    Outcome {
        asleep_pct: 100.0 * asleep as f32 / dynamic.len().max(1) as f32,
        max_speed,
        min_y,
        bodies: dynamic.len(),
        step_ms,
    }
}

/// The contract. A pile of concrete boxes, left alone, must come to rest.
///
/// Not "mostly" -- a body still moving after 10 s of no input is a body that
/// will never sleep, and each one multiplies every per-awake-body cost in the
/// tick for the rest of the match.
#[test]
#[ignore = "needs a GPU"]
fn a_pile_of_boxes_comes_to_rest() {
    let o = settle(layers_from_env(6), 10);
    eprintln!(
        "[stack] {} bodies, {:.0}% asleep, max speed {:.4} m/s, min y {:.3} m, {:.2} ms/step",
        o.bodies, o.asleep_pct, o.max_speed, o.min_y, o.step_ms
    );
    assert!(
        o.asleep_pct >= 90.0,
        "only {:.0}% of {} stacked boxes asleep after 10 s. Residual velocity \
         floor is {:.4} m/s -- above the sleep threshold, so these never sleep \
         at any timescale.",
        o.asleep_pct,
        o.bodies,
        o.max_speed
    );
}

/// The floor must be near zero, not merely under whatever threshold is set.
///
/// Asserted separately from sleep because it is the *cause*: sleep percentage
/// can be bought by raising the threshold, this cannot.
#[test]
#[ignore = "needs a GPU"]
fn residual_velocity_settles_to_near_zero() {
    let o = settle(6, 10);
    assert!(
        o.max_speed < 0.05,
        "residual velocity floor is {:.4} m/s after 10 s at rest; expected \
         near zero. A non-zero floor means the contact solver is converging to \
         a wrong answer, not converging slowly.",
        o.max_speed
    );
}

/// Stacked boxes must not sink into the ground.
///
/// Depenetration applies a correction velocity every tick to a body that is
/// already at rest, which is itself a velocity floor no amount of contact
/// iteration removes.
#[test]
#[ignore = "needs a GPU"]
fn stacked_boxes_do_not_sink_into_the_ground() {
    let o = settle(6, 10);
    assert!(
        o.min_y > HALF - 0.05,
        "lowest box centre is {:.3} m, expected about {:.3} m; the pile is \
         penetrating the ground",
        o.min_y,
        HALF
    );
}

/// Where is the knee?
///
/// Not an assertion -- a measurement. Run with --nocapture to read the table
/// and choose iteration counts from settle quality against step cost.
#[test]
#[ignore = "measurement: needs a GPU"]
fn sweep_solver_iterations_for_the_knee() {
    eprintln!("pos/vel  bodies  asleep%   max_speed   min_y     ms/step");
    for (pos, vel) in [(4u32, 1u32), (8, 2), (12, 4), (16, 4), (24, 8), (32, 8)] {
        // Read per body creation, not cached, so the sweep works in-process.
        std::env::set_var("VIBE_PHYSX_POSITION_ITERS", pos.to_string());
        std::env::set_var("VIBE_PHYSX_VELOCITY_ITERS", vel.to_string());
        let o = settle(6, 10);
        eprintln!(
            "{pos:>3}/{vel:<3} {:>7} {:>7.0}% {:>10.4} {:>8.3} {:>10.2}",
            o.bodies, o.asleep_pct, o.max_speed, o.min_y, o.step_ms
        );
    }
    std::env::remove_var("VIBE_PHYSX_POSITION_ITERS");
    std::env::remove_var("VIBE_PHYSX_VELOCITY_ITERS");
}

/// Does the contract hold at city scale?
///
/// `/city` runs ~10,000 chunk bodies, so a result at 1,000 says little about
/// the case that actually matters. These are pyramid layer counts chosen to
/// land near 2k / 5k / 8k / 10k bodies; the tallest is ~53 m, comparable to the
/// district pack's 84 m.
///
/// Asserted rather than merely measured: if a plain box pile stops settling
/// somewhere between 1k and 10k, that is the explanation for the city and it
/// should fail loudly here. If it settles all the way to 10k, the city's
/// awake-body problem is definitively on the destruction path and not in
/// rigid-body contact at all.
#[test]
#[ignore = "measurement: needs a GPU, runs several large piles"]
fn piles_settle_at_city_scale() {
    // 18 -> 2109, 24 -> 4900, 28 -> 7714, 31 -> 10416
    let mut failures = Vec::new();
    eprintln!("layers  bodies  asleep%   max_speed   min_y     ms/step");
    for layers in [18u32, 24, 28, 31] {
        let o = settle(layers, 10);
        eprintln!(
            "{layers:>6} {:>7} {:>7.0}% {:>10.4} {:>8.3} {:>10.2}",
            o.bodies, o.asleep_pct, o.max_speed, o.min_y, o.step_ms
        );
        if o.asleep_pct < 90.0 || o.max_speed >= 0.05 {
            failures.push(format!(
                "{} bodies: {:.0}% asleep, residual {:.4} m/s",
                o.bodies, o.asleep_pct, o.max_speed
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "piles stopped settling as they grew, so contact solving IS the floor \
         after all and the scale threshold is between these sizes: {failures:#?}"
    );
}
