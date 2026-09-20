#![cfg(feature = "gpu")]

//! A body rolling off the edge of a heightfield.
//!
//! The reproducer for the CUDA 700 that took the live /city server down five
//! times in seven minutes on 2026-09-20. The city floor was two coincident
//! colliders: a 2 km slab and, on top of it, the benchmark template's flat
//! 129x129 heightfield spanning +-256 m. A 2 m meteor that bounced off a
//! facade rolled across the plain at a constant 31 m/s, and on the tick its
//! contact crossed x = -256 the GPU heightfield narrowphase faulted. The
//! cannonball never faulted in forty shots because it stops in what it hits.
//!
//! Nothing else here: no destruction stage, no city, one heightfield, one
//! slab, one sphere with a push. Run it under compute-sanitizer to have the
//! faulting kernel name itself instead of the next stream sync:
//!
//! ```text
//! CUDA_HOME=/usr/local/cuda-12.8 compute-sanitizer --tool memcheck \
//!   target/release/deps/heightfield_edge-<hash> --ignored --nocapture
//! ```

use vibe_land_physx_bridge::{
    HeightfieldDesc, LaunchedBallDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig,
};

const ALL: u32 = u32::MAX;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::IDENTITY,
    }
}

/// The city's floor as it was: a flat heightfield over +-256 m on a 2 km slab.
fn floor_with_heightfield(world: &mut World, heightfield: bool) {
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 1,
            pose: pose(0.0, -10.0, 0.0),
            half_extents: Vec3::new(2000.0, 10.0, 2000.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();
    if !heightfield {
        return;
    }
    // Same construction as physx_runtime::add_static_heightfield for the
    // benchmark template: 129 samples across 512 m, all zero, corner pose.
    let n = 129u32;
    let side = 512.0f32;
    let samples = vec![0.0f32; (n * n) as usize];
    world
        .add_heightfield(
            HeightfieldDesc {
                entity_id: 2,
                user_id: 2,
                pose: pose(-side * 0.5, 0.0, -side * 0.5),
                rows: n,
                columns: n,
                height_scale: 0.01,
                row_scale: side / (n - 1) as f32,
                column_scale: side / (n - 1) as f32,
                friction: 0.5,
                restitution: 0.1,
                collision_group: 1,
                collision_mask: ALL,
            },
            &samples,
        )
        .unwrap();
}

fn roll_across_the_edge(heightfield: bool) -> Result<(), String> {
    let mut world = World::new(WorldConfig::default()).map_err(|e| e.to_string())?;
    floor_with_heightfield(&mut world, heightfield);
    // The meteor as measured: 2 m, 110 t, resting on the floor, rolling
    // outward at 31 m/s from 60 m inside the edge. Crosses x = -256 in ~2 s.
    world
        .launch_dynamic_ball(LaunchedBallDesc {
            entity_id: 3,
            user_id: 3,
            pose: pose(-196.0, 2.0, 0.0),
            radius: 2.0,
            mass: 110_000.0,
            linear_velocity: Vec3::new(-31.0, 0.0, 0.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .map_err(|e| e.to_string())?;
    for tick in 0..600 {
        world.step().map_err(|e| format!("tick {tick}: {e}"))?;
        if world.gpu_context_lost() {
            let x = world
                .body_snapshots()
                .ok()
                .and_then(|b| b.into_iter().find(|b| b.entity_id == 3))
                .map(|b| b.pose.position.x);
            return Err(format!("CUDA context lost at tick {tick}, ball x = {x:?}"));
        }
    }
    Ok(())
}

/// With the heightfield: reproduces the fault. Ignored because it takes the
/// GPU context with it, which no other test in the process survives.
#[test]
#[ignore = "takes the CUDA context down; run alone, ideally under compute-sanitizer"]
fn a_ball_rolling_off_a_heightfield_edge_faults_the_gpu() {
    match roll_across_the_edge(true) {
        Ok(()) => println!("no fault: the heightfield edge did not reproduce it here"),
        Err(error) => println!("reproduced: {error}"),
    }
}

/// Without it, the same roll on the slab alone is uneventful.
#[test]
#[ignore = "needs the GPU"]
fn the_same_ball_on_the_slab_alone_is_fine() {
    roll_across_the_edge(false).expect("a sphere rolling on a box");
}
