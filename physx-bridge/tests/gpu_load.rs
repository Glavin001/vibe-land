#![cfg(feature = "gpu")]

use vibe_land_physx_bridge::{DynamicBoxDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig};

const ALL: u32 = u32::MAX;

fn pose(x: f32, y: f32, z: f32) -> Pose {
    Pose {
        position: Vec3::new(x, y, z),
        rotation: Quat::IDENTITY,
    }
}

/// Dedicated GPU release gate. Override body/step counts on larger runners.
#[test]
#[ignore = "requires dedicated GPU load-test capacity"]
fn cascade_capacity_has_no_gpu_buffer_warnings() {
    let body_count = std::env::var("VIBE_PHYSX_LOAD_BODIES")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(5_000);
    let step_count = std::env::var("VIBE_PHYSX_LOAD_STEPS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(300);

    let mut world = World::new(WorldConfig::default()).unwrap();
    world
        .add_static_box(StaticBoxDesc {
            entity_id: 1,
            user_id: 1,
            pose: pose(0.0, -0.5, 0.0),
            half_extents: Vec3::new(100.0, 0.5, 100.0),
            collision_group: 1,
            collision_mask: ALL,
        })
        .unwrap();

    for index in 0..body_count {
        let x = (index % 25) as f32 * 0.9 - 11.0;
        let z = ((index / 25) % 25) as f32 * 0.9 - 11.0;
        let y = (index / 625) as f32 * 0.9 + 1.0;
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: index + 2,
                user_id: index,
                pose: pose(x, y, z),
                half_extents: Vec3::new(0.4, 0.4, 0.4),
                mass: 5.0,
                collision_group: 1,
                collision_mask: ALL,
            })
            .unwrap();
    }

    for _ in 0..step_count {
        world.step().unwrap();
        let stats = world.stats().unwrap();
        assert_eq!(
            stats.gpu_warning_count, 0,
            "GPU warning or buffer overflow reported at step {}",
            stats.completed_steps
        );
    }
}
