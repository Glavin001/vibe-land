use vibe_land_shared::terrain::{
    build_demo_heightfield, demo_ball_pit_wall_cuboids, DEMO_BALL_PIT_X, DEMO_BALL_PIT_Z,
};

use crate::movement::{PhysicsArena, Vec3};

pub fn seed_default_world(arena: &mut PhysicsArena) {
    let (heights, scale) = build_demo_heightfield();
    arena.add_static_heightfield(heights, scale, 0);
    seed_ball_pit(arena);
}

fn seed_ball_pit(arena: &mut PhysicsArena) {
    for (center, half_extents) in demo_ball_pit_wall_cuboids() {
        arena.add_static_cuboid(center, half_extents, 0);
    }

    // Spawn balls above the pit so they settle on the flat terrain inside it.
    let radius = 0.3_f32;
    let inner_min_x = DEMO_BALL_PIT_X + 1.5;
    let inner_min_z = DEMO_BALL_PIT_Z + 1.5;
    let spacing = 0.8;
    let cols = 5;
    let rows = 5;
    let layers = 2;

    for layer in 0..layers {
        for row in 0..rows {
            for col in 0..cols {
                let x = inner_min_x + col as f32 * spacing;
                let y = 2.0 + layer as f32 * 0.8;
                let z = inner_min_z + row as f32 * spacing;
                arena.spawn_dynamic_ball(Vec3::new(x, y, z), radius);
            }
        }
    }
}
