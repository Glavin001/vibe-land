use nalgebra::vector;
use vibe_land_shared::terrain::{
    build_demo_heightfield, demo_ball_pit_wall_cuboids, DEMO_BALL_PIT_X, DEMO_BALL_PIT_Z,
};
use vibe_land_shared::world_document::WorldDocumentError;

use crate::movement::PhysicsArena;

const BALL_RADIUS_M: f32 = 0.3;
const BALL_SPACING_M: f32 = 0.8;
const BALL_COLS: usize = 5;
const BALL_ROWS: usize = 5;
const BALL_LAYERS: usize = 1;
const DEFAULT_VEHICLE_POSITION_M: [f32; 3] = [8.0, 2.0, 0.0];

pub fn seed_default_world(arena: &mut PhysicsArena) -> Result<(), WorldDocumentError> {
    let (heights, scale) = build_demo_heightfield();
    arena.add_static_heightfield(heights, scale, 0);

    for (center, half_extents) in demo_ball_pit_wall_cuboids() {
        arena.add_static_cuboid(center, half_extents, 0);
    }

    let inner_min_x = DEMO_BALL_PIT_X + 1.5;
    let inner_min_z = DEMO_BALL_PIT_Z + 1.5;

    for layer in 0..BALL_LAYERS {
        for row in 0..BALL_ROWS {
            for col in 0..BALL_COLS {
                let x = inner_min_x + col as f32 * BALL_SPACING_M;
                let y = 2.0 + layer as f32 * BALL_SPACING_M;
                let z = inner_min_z + row as f32 * BALL_SPACING_M;
                arena.spawn_dynamic_ball(vector![x, y, z], BALL_RADIUS_M);
            }
        }
    }

    arena.spawn_vehicle(
        0,
        vector![
            DEFAULT_VEHICLE_POSITION_M[0],
            DEFAULT_VEHICLE_POSITION_M[1],
            DEFAULT_VEHICLE_POSITION_M[2]
        ],
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::MoveConfig;

    #[test]
    fn default_world_bootstrap_matches_expected_multiplayer_counts() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert_eq!(arena.dynamic.dynamic_bodies.len(), BALL_COLS * BALL_ROWS * BALL_LAYERS);
        assert_eq!(arena.vehicles.len(), 1);
    }

    #[test]
    fn default_world_stays_within_multiplayer_dynamic_budget() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert!(
            arena.dynamic.dynamic_bodies.len() <= 25,
            "default multiplayer world spawned {} dynamic rigid bodies; keep it at or under 25 to preserve 60 Hz headroom",
            arena.dynamic.dynamic_bodies.len()
        );
        assert!(
            arena.vehicles.len() <= 1,
            "default multiplayer world spawned {} vehicles; keep it at or under 1",
            arena.vehicles.len()
        );
    }

    #[test]
    fn default_world_keeps_entities_supported_after_settling() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        for _ in 0..300 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot
                .iter()
                .all(|(_, pos, _, _, _, _, _)| pos[1] > -0.25),
            "dynamic bodies fell below expected terrain support: {:?}",
            dynamic_snapshot
                .iter()
                .map(|(id, pos, _, _, _, _, _)| (*id, pos[1]))
                .collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > -250),
            "vehicles fell below expected terrain support: {:?}",
            vehicles
                .iter()
                .map(|vehicle| (vehicle.id, vehicle.py_mm))
                .collect::<Vec<_>>()
        );
    }
}
