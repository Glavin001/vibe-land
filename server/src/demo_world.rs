use std::f32::consts::PI;

use vibe_land_shared::world_document::{
    DynamicEntity, DynamicEntityKind, WorldDocument, WorldDocumentError, WorldMeta, WorldTerrain,
    WorldTerrainTile,
};

use crate::movement::PhysicsArena;

pub const FLAT_VEHICLE_TEST_MATCH_ID: &str = "flat_vehicle_test";
pub const VEHICLE_BUMPS_TEST_MATCH_ID: &str = "vehicle_bumps_test";
const BENCHMARK_TERRAIN_GRID_SIZE: usize = 129;
const BENCHMARK_TERRAIN_HALF_EXTENT_M: f32 = 256.0;

pub fn seed_default_world(arena: &mut PhysicsArena) -> Result<(), WorldDocumentError> {
    WorldDocument::demo().instantiate(arena)
}

pub fn seed_world_for_match(
    arena: &mut PhysicsArena,
    match_id: &str,
) -> Result<(), WorldDocumentError> {
    benchmark_world_document(match_id)
        .unwrap_or_else(WorldDocument::demo)
        .instantiate(arena)
}

fn benchmark_world_document(match_id: &str) -> Option<WorldDocument> {
    if match_id.starts_with(FLAT_VEHICLE_TEST_MATCH_ID) {
        Some(flat_vehicle_benchmark_world())
    } else if match_id.starts_with(VEHICLE_BUMPS_TEST_MATCH_ID) {
        Some(vehicle_bumps_benchmark_world())
    } else {
        None
    }
}

fn benchmark_vehicle_world(
    name: &str,
    description: &str,
    grid_size: usize,
    tile_half_extent_m: f32,
    heights: Vec<f32>,
) -> WorldDocument {
    WorldDocument {
        version: vibe_land_shared::world_document::WORLD_DOCUMENT_VERSION,
        meta: WorldMeta {
            name: name.to_string(),
            description: description.to_string(),
        },
        terrain: WorldTerrain {
            tile_grid_size: grid_size as u16,
            tile_half_extent_m,
            tiles: vec![WorldTerrainTile {
                tile_x: 0,
                tile_z: 0,
                heights,
            }],
        },
        static_props: vec![],
        dynamic_entities: vec![DynamicEntity {
            id: 1,
            kind: DynamicEntityKind::Vehicle,
            position: [0.0, 3.0, 3.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: None,
            radius: None,
            vehicle_type: Some(0),
        }],
    }
}

fn flat_vehicle_benchmark_world() -> WorldDocument {
    benchmark_vehicle_world(
        "Flat Vehicle Benchmark",
        "Flat multiplayer world used for deterministic local driver vehicle benchmarks.",
        BENCHMARK_TERRAIN_GRID_SIZE,
        BENCHMARK_TERRAIN_HALF_EXTENT_M,
        vec![0.0; BENCHMARK_TERRAIN_GRID_SIZE * BENCHMARK_TERRAIN_GRID_SIZE],
    )
}

fn vehicle_bumps_benchmark_world() -> WorldDocument {
    let grid_size = BENCHMARK_TERRAIN_GRID_SIZE;
    let max_index = (grid_size - 1) as f32;
    let half_extent_m = BENCHMARK_TERRAIN_HALF_EXTENT_M;
    let side_m = half_extent_m * 2.0;
    let heights = (0..grid_size)
        .flat_map(|row| {
            (0..grid_size).map(move |col| {
                let world_x = (col as f32 / max_index) * side_m - half_extent_m;
                let world_z = (row as f32 / max_index) * side_m - half_extent_m;
                let track_weight = (1.0 - (world_x.abs() / 6.0)).clamp(0.0, 1.0);
                let bump_envelope = ((world_z - 8.0) / 14.0).clamp(0.0, 1.0);
                let bump_wave = if (8.0..=22.0).contains(&world_z) {
                    ((world_z - 8.0) / 14.0 * PI * 4.0).sin().abs() * 0.35
                } else {
                    0.0
                };
                track_weight * bump_envelope * bump_wave
            })
        })
        .collect();
    benchmark_vehicle_world(
        "Vehicle Bumps Benchmark",
        "Benchmark track with mild bumps for multiplayer vehicle-driver validation.",
        grid_size,
        half_extent_m,
        heights,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::MoveConfig;

    #[test]
    fn default_world_bootstrap_matches_expected_multiplayer_counts() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert_eq!(arena.dynamic.dynamic_bodies.len(), 51);
        assert_eq!(arena.vehicles.len(), 1);
    }

    #[test]
    fn default_world_stays_within_multiplayer_dynamic_budget() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert!(
            arena.dynamic.dynamic_bodies.len() <= 51,
            "default multiplayer world spawned {} dynamic rigid bodies; keep it at or under 51 to match the authored default world",
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
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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

    #[test]
    fn flat_vehicle_benchmark_world_keeps_single_vehicle_supported() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_world_for_match(&mut arena, FLAT_VEHICLE_TEST_MATCH_ID)
            .expect("instantiate flat vehicle benchmark world");

        assert_eq!(arena.dynamic.dynamic_bodies.len(), 0);
        assert_eq!(arena.vehicles.len(), 1);

        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let vehicles = arena.snapshot_vehicles();
        assert_eq!(vehicles.len(), 1);
        assert!(vehicles[0].py_mm > 0);
    }

    #[test]
    fn benchmark_world_prefixes_create_isolated_vehicle_worlds() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_world_for_match(&mut arena, "flat_vehicle_test__run_123")
            .expect("instantiate isolated flat benchmark world");
        assert_eq!(arena.vehicles.len(), 1);

        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_world_for_match(&mut arena, "vehicle_bumps_test__run_123")
            .expect("instantiate isolated bumps benchmark world");
        assert_eq!(arena.vehicles.len(), 1);
    }

    #[test]
    fn vehicle_bumps_benchmark_world_keeps_single_vehicle_supported() {
        let mut arena = PhysicsArena::new(MoveConfig::default());
        seed_world_for_match(&mut arena, VEHICLE_BUMPS_TEST_MATCH_ID)
            .expect("instantiate vehicle bumps benchmark world");

        assert_eq!(arena.dynamic.dynamic_bodies.len(), 0);
        assert_eq!(arena.vehicles.len(), 1);

        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let vehicles = arena.snapshot_vehicles();
        assert_eq!(vehicles.len(), 1);
        assert!(vehicles[0].py_mm > 0);
    }
}
