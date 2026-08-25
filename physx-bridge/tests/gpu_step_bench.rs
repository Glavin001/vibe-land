//! Phase 0: is `fetchResults` GPU solve, or the copy of results back to host?
//!
//! The whole scaling strategy depends on the answer. `fetchResults(true)`
//! reports both as one number, so this sweeps body count with
//! `VIBE_PHYSX_PROFILE_FETCH=1`, which polls `fetchResults(false)` instead of
//! blocking: everything before the call that finally succeeds is GPU wait, and
//! the duration of that successful call is the result copy.
//!
//! Run with:
//!   VIBE_PHYSX_PROFILE_FETCH=1 cargo test -p vibe-land-physx-bridge \
//!     --features destruction --test gpu_step_bench -- --nocapture --ignored
#![cfg(feature = "destruction")]

use vibe_land_physx_bridge::{DynamicBoxDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig};

const GROUP_STATIC: u32 = 1 << 0;
const GROUP_DYNAMIC: u32 = 1 << 1;
const ALL: u32 = GROUP_STATIC | GROUP_DYNAMIC;

/// Drop `count` boxes in a loose grid so they land, pile, and stay in contact —
/// the state a collapsed city is actually in, not a free-fall best case.
fn build_scene(count: u32) -> World {
    let mut world = World::new(WorldConfig::default()).expect("GPU scene");
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 0x1000_0001,
            user_id: 0,
            pose: Pose {
                position: Vec3::new(0.0, -0.5, 0.0),
                rotation: Quat::IDENTITY,
            },
            half_extents: Vec3::new(200.0, 0.5, 200.0),
            collision_group: GROUP_STATIC,
            collision_mask: ALL,
        })
        .expect("ground");

    let side = (count as f32).cbrt().ceil() as u32;
    let mut spawned = 0;
    for x in 0..side {
        for z in 0..side {
            for y in 0..side {
                if spawned >= count {
                    break;
                }
                world
                    .add_dynamic_box(DynamicBoxDesc {
                        entity_id: 0x2000_0000 | spawned,
                        user_id: spawned,
                        pose: Pose {
                            position: Vec3::new(
                                x as f32 * 1.2 - side as f32 * 0.6,
                                0.6 + y as f32 * 1.3,
                                z as f32 * 1.2 - side as f32 * 0.6,
                            ),
                            rotation: Quat::IDENTITY,
                        },
                        half_extents: Vec3::new(0.5, 0.5, 0.5),
                        mass: 40.0,
                        collision_group: GROUP_DYNAMIC,
                        collision_mask: ALL,
                    })
                    .expect("spawn box");
                spawned += 1;
            }
        }
    }
    world
}

fn percentile(values: &mut [f32], p: f32) -> f32 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[((values.len() as f32 * p) as usize).min(values.len() - 1)]
}

#[test]
#[ignore = "benchmark: needs a GPU and burns a core when profiling"]
fn gpu_step_cost_by_body_count() {
    // Value-checked, matching the bridge. `is_ok()` here reported
    // profile_fetch=true for VIBE_PHYSX_PROFILE_FETCH=0 -- the same
    // presence-vs-value bug the bridge itself had, in the one line whose job
    // is to tell you which mode you are measuring.
    let profiling = std::env::var("VIBE_PHYSX_PROFILE_FETCH")
        .map(|value| value != "0")
        .unwrap_or(false);
    println!(
        "\nprofile_fetch={} (set VIBE_PHYSX_PROFILE_FETCH=1 to split wait from copy)",
        profiling
    );
    println!(
        "{:>7}  {:>7}  {:>9}  {:>9}  {:>9}  {:>9}  {:>10}",
        "bodies", "awake", "step_p50", "sim_p50", "fetch_p50", "wait_p50", "copy_p50"
    );

    for count in [500u32, 1000, 2000, 4000] {
        let mut world = build_scene(count);
        // Settle the pile first: measuring free-fall would flatter the result.
        for _ in 0..120 {
            world.step().expect("warmup step");
        }

        let (mut step, mut sim, mut fetch, mut wait, mut copy) =
            (vec![], vec![], vec![], vec![], vec![]);
        let mut awake = 0;
        for _ in 0..180 {
            world.begin_step().expect("begin");
            world.end_step().expect("end");
            let stats = world.stats().expect("stats");
            step.push(stats.last_step_ms);
            sim.push(stats.last_simulate_ms);
            fetch.push(stats.last_fetch_ms);
            wait.push(stats.last_gpu_wait_ms);
            copy.push(stats.last_fetch_copy_ms);
            awake = stats.active_dynamic_bodies;
        }

        println!(
            "{:>7}  {:>7}  {:>9.3}  {:>9.3}  {:>9.3}  {:>9.3}  {:>10.3}",
            count,
            awake,
            percentile(&mut step, 0.5),
            percentile(&mut sim, 0.5),
            percentile(&mut fetch, 0.5),
            percentile(&mut wait, 0.5),
            percentile(&mut copy, 0.5),
        );
    }
    println!(
        "\nwait = GPU still busy; copy = the fetchResults call that returns results.\n\
         If copy dominates, the Direct GPU API is the lever. If wait dominates,\n\
         the ceiling is real solver work and the body budget follows the curve.\n"
    );
}
