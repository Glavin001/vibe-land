//! What one GPU simulation step costs, by scene state, with nothing else in the
//! tick. The server's idle budget is decided here: a map with 50-100 bodies
//! lying around has to cost next to nothing, asleep or awake.
//!
//! Every scenario is fixed input and runs in its own fresh world, so two runs of
//! this file are comparable. One JSON line per scenario on stderr, prefixed
//! `STEP_COST`, for scripts to collect.
//!
//!   cargo test -p vibe-land-physx-bridge --features native-destruction \
//!     --release --test step_cost -- --ignored --nocapture --test-threads=1
#![cfg(feature = "gpu")]

use std::time::Instant;
use vibe_land_physx_bridge::{
    CapsulePlayerDesc, DynamicBoxDesc, LaunchedBallDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig,
};

const ALL: u32 = u32::MAX;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose { position: Vec3::new(x, y, z), rotation: Quat::IDENTITY }
}

fn world() -> World {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1, user_id: 1, pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(200.0, 0.5, 200.0), collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
    world
}

/// Boxes resting on the ground in a grid, 1 m apart, not touching each other.
fn resting_boxes(world: &mut World, count: u32) {
    let side = (count as f32).sqrt().ceil() as u32;
    for i in 0..count {
        let (x, z) = ((i % side) as f32 * 1.5 - side as f32 * 0.75, (i / side) as f32 * 1.5 - side as f32 * 0.75);
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: 1000 + i, user_id: 1000 + i, pose: pose(x, 0.5, z),
                half_extents: Vec3::new(0.5, 0.5, 0.5), mass: 20.0, collision_group: 1, collision_mask: ALL,
            })
            .unwrap();
    }
}

/// Balls rolling across the ground: they stay awake for the whole window.
fn rolling_balls(world: &mut World, count: u32) {
    let side = (count as f32).sqrt().ceil() as u32;
    for i in 0..count {
        let (x, z) = ((i % side) as f32 * 2.0 - side as f32, (i / side) as f32 * 2.0 - side as f32);
        let angle = i as f32 * 2.399;
        world
            .launch_dynamic_ball(LaunchedBallDesc {
                entity_id: 5000 + i, user_id: 5000 + i, pose: pose(x, 0.4, z), radius: 0.4, mass: 10.0,
                linear_velocity: Vec3::new(angle.cos() * 2.0, 0.0, angle.sin() * 2.0),
                collision_group: 1, collision_mask: ALL,
            })
            .unwrap();
    }
}

fn add_walker(world: &mut World) {
    world
        .add_capsule_player(CapsulePlayerDesc {
            entity_id: 9, user_id: 9, position: Vec3::new(-30.0, 1.0, -30.0), cylinder_height: 1.1,
            radius: 0.35, step_offset: 0.4, contact_offset: 0.05, slope_limit_radians: 0.8,
            collision_group: 1, collision_mask: ALL,
        })
        .unwrap();
}

struct Samples {
    wall: Vec<f32>,
    step: Vec<f32>,
    gpu_wait: Vec<f32>,
    simulate: Vec<f32>,
    active: Vec<u32>,
}

fn pct(values: &[f32], p: f32) -> f32 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((p / 100.0) * (v.len() - 1) as f32).round() as usize]
}

/// Step `warmup` ticks unmeasured, then `ticks` measured. `each` runs before
/// every step (player movement and the like), inside the measured wall time.
fn measure(world: &mut World, warmup: u32, ticks: u32, mut each: impl FnMut(&mut World, u32)) -> Samples {
    for t in 0..warmup {
        each(world, t);
        world.step().unwrap();
    }
    let mut s = Samples { wall: vec![], step: vec![], gpu_wait: vec![], simulate: vec![], active: vec![] };
    for t in 0..ticks {
        let started = Instant::now();
        each(world, warmup + t);
        world.step().unwrap();
        s.wall.push(started.elapsed().as_secs_f32() * 1000.0);
        let stats = world.stats().unwrap();
        s.step.push(stats.last_step_ms);
        s.gpu_wait.push(stats.last_gpu_wait_ms);
        s.simulate.push(stats.last_simulate_ms);
        s.active.push(stats.active_dynamic_bodies);
    }
    assert_eq!(world.stats().unwrap().gpu_warning_count, 0, "PhysX reported errors");
    s
}

fn report(name: &str, s: &Samples) {
    let active = s.active.iter().sum::<u32>() as f32 / s.active.len() as f32;
    let line = format!(
        "{{\"scenario\":\"{name}\",\"ticks\":{},\"active_avg\":{active:.1},\"wall_p50\":{:.3},\"wall_p90\":{:.3},\"wall_p99\":{:.3},\"wall_max\":{:.3},\"gpu_wait_p50\":{:.3},\"simulate_p50\":{:.3}}}",
        s.wall.len(), pct(&s.wall, 50.0), pct(&s.wall, 90.0), pct(&s.wall, 99.0), pct(&s.wall, 100.0),
        pct(&s.gpu_wait, 50.0), pct(&s.simulate, 50.0),
    );
    eprintln!("STEP_COST {line}");
}

#[test]
#[ignore = "benchmark: needs a GPU"]
fn step_cost_by_scene_state() {
    // Pipeline warm-up in its own world, so first-use costs land nowhere below.
    {
        let mut w = world();
        resting_boxes(&mut w, 20);
        rolling_balls(&mut w, 20);
        add_walker(&mut w);
        let _ = measure(&mut w, 120, 1, |_, _| {});
    }

    let mut w = world();
    report("ground_only", &measure(&mut w, 60, 240, |_, _| {}));

    for count in [50u32, 100, 400] {
        let mut w = world();
        resting_boxes(&mut w, count);
        // Freshly placed: awake while they settle.
        report(&format!("boxes_{count}_settling"), &measure(&mut w, 0, 30, |_, _| {}));
        // Long enough for PhysX's sleep counter to put them all to sleep.
        report(&format!("boxes_{count}_asleep"), &measure(&mut w, 300, 240, |_, _| {}));
    }

    for count in [50u32, 100, 400] {
        let mut w = world();
        rolling_balls(&mut w, count);
        report(&format!("balls_{count}_rolling"), &measure(&mut w, 10, 120, |_, _| {}));
    }

    let mut w = world();
    resting_boxes(&mut w, 100);
    add_walker(&mut w);
    report(
        "boxes_100_asleep_player_walking",
        &measure(&mut w, 300, 240, |w, _| w.move_player(9, Vec3::new(0.08, -0.05, 0.08)).unwrap()),
    );
}
