use std::f32::consts::PI;

use vibe_land_shared::world_document::{
    DynamicEntity, DynamicEntityKind, StaticProp, StaticPropKind, WorldDocument,
    WorldDocumentError, WorldMeta, WorldTerrain, WorldTerrainTile,
};

use crate::movement::PhysicsArena;

pub const FLAT_VEHICLE_TEST_MATCH_ID: &str = "flat_vehicle_test";
pub const VEHICLE_BUMPS_TEST_MATCH_ID: &str = "vehicle_bumps_test";
const BENCHMARK_TERRAIN_GRID_SIZE: usize = 129;
const BENCHMARK_TERRAIN_HALF_EXTENT_M: f32 = 256.0;
/// Solid ground slab under the city.
///
/// Sized for where debris actually goes, not for where the buildings are. The
/// grid is only ~36 m half-extent, but a chunk that reaches the slab's edge
/// falls off it and then free-falls forever: nothing slows it, because friction
/// only acts on contact. A measured escapee was at x=-46, z=+1052, y=-2280 --
/// a kilometre out and 2.3 km down, still travelling. The client renders that
/// faithfully, which is what "chunks below ground" has been reporting.
///
/// A static box costs one collider and no per-tick work, so the cheap fix is to
/// make the floor bigger than anything can cross in a match rather than to
/// catch escapees afterwards. Retiring out-of-bounds bodies is still the
/// principled fix and needs the retirement path, which is dead code today.
const CITY_GROUND_HALF_EXTENT_M: f32 = 2000.0;
const CITY_GROUND_THICKNESS_M: f32 = 20.0;

pub fn seed_default_world(arena: &mut PhysicsArena) -> Result<(), WorldDocumentError> {
    let world = WorldDocument::demo();
    world.instantiate(arena)?;
    arena.set_spawn_areas(world.spawn_areas.clone());
    Ok(())
}

pub fn seed_world_for_match(
    arena: &mut PhysicsArena,
    match_id: &str,
) -> Result<(), WorldDocumentError> {
    let world = benchmark_world_document(match_id).unwrap_or_else(WorldDocument::demo);
    world.instantiate(arena)?;
    arena.set_spawn_areas(world.spawn_areas.clone());
    Ok(())
}

fn benchmark_world_document(match_id: &str) -> Option<WorldDocument> {
    if match_id.starts_with(FLAT_VEHICLE_TEST_MATCH_ID) {
        Some(flat_vehicle_benchmark_world())
    } else if match_id.starts_with(VEHICLE_BUMPS_TEST_MATCH_ID) {
        Some(vehicle_bumps_benchmark_world())
    } else if match_id.starts_with(crate::city::CITY_MATCH_PREFIX) {
        Some(city_world())
    } else {
        None
    }
}

/// The city's cars. Well above any u8 snapshot handle, so a client that keys a
/// vehicle by its wire handle can never name a different car by accident.
pub const CITY_VEHICLE_ID_DELOREAN: u32 = 1001;
pub const CITY_VEHICLE_ID_CYBERTRUCK: u32 = 1002;

/// Open flat terrain for the destructible city. The buildings themselves live
/// in the destruction runtime (PhysX/Blast or synthetic), not the movement
/// arena; spawn areas ring the 4×4 grid (half extent 27 m + tallest building
/// footprint) so players never spawn inside a structure.
fn city_world() -> WorldDocument {
    let mut world = benchmark_vehicle_world(
        "Destructible City",
        "Flat open world hosting the destructible mini-city grid.",
        BENCHMARK_TERRAIN_GRID_SIZE,
        BENCHMARK_TERRAIN_HALF_EXTENT_M,
        vec![0.0; BENCHMARK_TERRAIN_GRID_SIZE * BENCHMARK_TERRAIN_GRID_SIZE],
    );
    // Two cars, one per vehicle type, parked beside the east and west spawn
    // areas on the ring and facing downtown. The benchmark template parks one
    // at the origin, the centre of the city grid, which once held every chunk
    // in its contact island awake forever; the vehicle SDK now applies its
    // forces with autowake off and wakes only on a throttle or steer intent
    // (physx-2 physx_native_vehicle_parked_sleeps), and the ring keeps a
    // parked car outside every building's fall reach on this axis. The east
    // and west areas rather than north and south because the downtown pack
    // ends 32 m short of the ring on x and 12 m short on z.
    world.dynamic_entities.clear();
    // VIBE_CITY_VEHICLES=0 seeds none: an operator's switch for a match that
    // should not have cars, and the A/B for anything the cars are suspected of.
    let vehicles_enabled = std::env::var("VIBE_CITY_VEHICLES").map_or(true, |v| v != "0");
    let ring = if vehicles_enabled { crate::city::spawn_ring_radius_m() } else { 0.0 };
    // Off the spawn area's 6 m radius so nobody spawns inside a car.
    let cars = [(CITY_VEHICLE_ID_DELOREAN, 0u8, ring, 8.0f32), (CITY_VEHICLE_ID_CYBERTRUCK, 1u8, -ring, -8.0)];
    for (id, vehicle_type, x, z) in cars.into_iter().filter(|_| vehicles_enabled) {
        // +z forward rotated about y to face the origin.
        let yaw = (-x).atan2(-z);
        world.dynamic_entities.push(DynamicEntity {
            id,
            kind: DynamicEntityKind::Vehicle,
            position: [x, 1.0, z],
            rotation: [0.0, (yaw * 0.5).sin(), 0.0, (yaw * 0.5).cos()],
            half_extents: None,
            radius: None,
            vehicle_type: Some(vehicle_type),
            energy: None,
            height: None,
        });
    }
    // No heightfield. The benchmark template lays a flat 129x129 heightfield
    // across a 512 m square, and the slab below is the actual floor; the two
    // were coincident at y=0, so the heightfield was a second collider for
    // the same surface -- one that ENDS at x,z = +-256 m while the world goes
    // on. A body sliding across that edge with its contact still on the
    // heightfield faults the GPU heightfield narrowphase (CUDA 700, context
    // lost, server restart). Measured: a 2 m meteor rolling at a constant
    // 31 m/s was at x = -256.1 and x = -254.6 heading outward on the tick
    // the narrowphase failed, in two traced runs, and the cannonball, which
    // stops in what it hits, never got there in forty shots. The settled
    // rubble ejected at km/s in earlier sessions crosses the same edge in a
    // few ticks. One floor, then: the slab, whose edge is 2 km out.
    world.terrain.tiles.clear();
    // Solid ground under the (now absent) terrain surface.
    //
    // A PhysX heightfield is a surface, not a volume: anything that ends up
    // beneath it keeps going. Debris from a collapse was doing exactly that,
    // reaching -3627 m and still falling at the body velocity clamp, and
    // bodies straddling the surface bounced in and out of it, which reads
    // in-game as chunks vibrating up and down. Neither body ever comes to
    // rest, so they also never sleep, and the match loop keeps simulating,
    // snapshotting and encoding all of them.
    //
    // The city floor is perfectly flat, so a box is the honest collider for
    // it: its top sits at y=0 with the terrain, and it is thick and wide
    // enough that nothing can get underneath.
    world.static_props.push(StaticProp {
        id: 1,
        kind: StaticPropKind::Cuboid,
        position: [0.0, -CITY_GROUND_THICKNESS_M * 0.5, 0.0],
        rotation: [0.0, 0.0, 0.0, 1.0],
        half_extents: [
            CITY_GROUND_HALF_EXTENT_M,
            CITY_GROUND_THICKNESS_M * 0.5,
            CITY_GROUND_HALF_EXTENT_M,
        ],
        material: None,
    });

    // Derived from the scene pack: a wider building pack widens the grid, and a
    // fixed ring would drop players inside a tower.
    let ring = crate::city::spawn_ring_radius_m();
    world.spawn_areas = [[ring, 0.0], [-ring, 0.0], [0.0, ring], [0.0, -ring]]
        .into_iter()
        .enumerate()
        .map(
            |(index, [x, z])| vibe_land_shared::world_document::SpawnArea {
                id: index as u32 + 1,
                position: [x, 0.5, z],
                radius: 6.0,
            },
        )
        .collect();
    world
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
                materials: Vec::new(),
                material_weights: None,
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
            energy: None,
            height: None,
        }],
        spawn_areas: vec![],
    }
}

pub(crate) fn flat_vehicle_benchmark_world() -> WorldDocument {
    benchmark_vehicle_world(
        "Flat Vehicle Benchmark",
        "Flat multiplayer world used for deterministic local driver vehicle benchmarks.",
        BENCHMARK_TERRAIN_GRID_SIZE,
        BENCHMARK_TERRAIN_HALF_EXTENT_M,
        vec![0.0; BENCHMARK_TERRAIN_GRID_SIZE * BENCHMARK_TERRAIN_GRID_SIZE],
    )
}

/// One sampled surface is serialized to the client and instantiated as the
/// server heightfield. Keep the starting pad level for every garage wheelbase.
pub(crate) fn garage_test_world() -> WorldDocument {
    const GRID: usize = 257;
    const HALF: f32 = 128.0;
    fn smooth(a: f32, b: f32, value: f32) -> f32 {
        let t = ((value - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }
    let heights = (0..GRID).flat_map(|row| (0..GRID).map(move |col| {
        let x = col as f32 - HALF;
        let z = row as f32 - HALF;
        let pad = smooth(12.0, 24.0, x.hypot(z));
        let edge = 1.0 - smooth(96.0, 116.0, x.abs().max(z.abs()));
        let hills = 2.5 * (1.0 + (x / 19.0).sin() * (z / 23.0).cos());
        let bank = 3.0 * (-((x - 45.0).powi(2) + (z - 45.0).powi(2)) / 500.0).exp();
        // A gently staggered washboard lane flexes left and right suspension
        // independently; its seven-metre waves resolve on the one-metre grid.
        let lane = (1.0 - smooth(4.0, 10.0, x.abs()))
            * smooth(24.0, 32.0, z) * (1.0 - smooth(64.0, 72.0, z));
        let bumps = lane * 0.24 * (z * 2.0 * PI / 7.0 + x * 0.45).sin();
        pad * edge * (hills + bank + bumps)
    })).collect();
    let mut world = benchmark_vehicle_world(
        "Garage proving ground",
        "Rolling hills, banked slopes and an uneven suspension lane around a flat starting pad.",
        GRID, HALF, heights,
    );
    world.dynamic_entities.clear();
    world.spawn_areas = vec![vibe_land_shared::world_document::SpawnArea {
        id: 1, position: [2.5, 1.5, 3.0], radius: 0.1,
    }];
    // Physical, visible perimeter barriers keep driving inside the sampled
    // surface. There is no coincident flat-ground collider under the terrain.
    for (index, (position, half_extents)) in [
        ([120.0, 2.0, 0.0], [1.0, 4.0, 121.0]),
        ([-120.0, 2.0, 0.0], [1.0, 4.0, 121.0]),
        ([0.0, 2.0, 120.0], [119.0, 4.0, 1.0]),
        ([0.0, 2.0, -120.0], [119.0, 4.0, 1.0]),
    ].into_iter().enumerate() {
        world.static_props.push(StaticProp {
            id: index as u32 + 1, kind: StaticPropKind::Cuboid,
            position, rotation: [0.0, 0.0, 0.0, 1.0], half_extents, material: None,
        });
    }
    world
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
    use vibe_land_shared::world_document::SpawnArea;

    #[test]
    fn garage_heightmap_has_level_spawn_and_resolved_driving_features() {
        let world = garage_test_world();
        assert!(world.dynamic_entities.is_empty());
        assert_eq!(world.terrain.tiles.len(), 1);
        let side = usize::from(world.terrain.tile_grid_size);
        let heights = &world.terrain.tiles[0].heights;
        assert_eq!(heights.len(), side * side);
        for z in -8..=8 {
            for x in -8..=8 {
                assert_eq!(world.sample_heightfield_surface_at_world_position(x as f32, z as f32), 0.0);
            }
        }
        let mut max_height = 0.0f32;
        let mut max_slope = 0.0f32;
        for row in 0..side {
            for col in 0..side {
                let h = heights[row * side + col];
                assert!(h.is_finite() && h >= 0.0);
                max_height = max_height.max(h);
                if row + 1 < side && col + 1 < side {
                    let dx = heights[row * side + col + 1] - h;
                    let dz = heights[(row + 1) * side + col] - h;
                    max_slope = max_slope.max(dx.hypot(dz));
                }
            }
        }
        assert!(max_height > 5.0 && max_height < 8.0, "height {max_height}");
        assert!(max_slope < 0.65, "slope {max_slope}");
        assert!((world.sample_heightfield_surface_at_world_position(0.0, 40.0)
            - world.sample_heightfield_surface_at_world_position(0.0, 43.0)).abs() > 0.15);
        // A round trip exercises the exact document sent to the browser.
        let wire = serde_json::to_vec(&world).unwrap();
        let decoded: WorldDocument = serde_json::from_slice(&wire).unwrap();
        assert_eq!(decoded.terrain.tiles[0].heights, *heights);
    }

    #[test]
    fn garage_heightmap_rays_match_serialized_surface() {
        let world = garage_test_world();
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        world.instantiate(&mut arena).expect("garage terrain");
        arena.step_vehicles_and_dynamics(1.0 / 60.0);
        for (x, z) in [(0.0, 3.0), (0.3, 40.7), (2.7, 44.1), (45.3, 45.7), (-80.4, -72.2)] {
            let expected = world.sample_heightfield_surface_at_world_position(x, z);
            let distance = arena.cast_static_world_ray([x, 20.0, z], [0.0, -1.0, 0.0], 30.0, None).unwrap();
            assert!((20.0 - distance - expected).abs() < 0.001, "({x}, {z}): {} vs {expected}", 20.0 - distance);
        }
    }

    #[test]
    fn default_world_bootstrap_matches_expected_multiplayer_counts() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        assert_eq!(arena.counts(), (51, 2, 4));
    }

    #[test]
    fn default_world_stays_within_multiplayer_dynamic_budget() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");

        let (dynamic_count, vehicle_count, _) = arena.counts();
        assert!(
            dynamic_count <= 51,
            "default multiplayer world spawned {} dynamic rigid bodies; keep it at or under 51 to match the authored default world",
            dynamic_count
        );
        assert!(
            vehicle_count <= 2,
            "default multiplayer world spawned {} vehicles; keep it at or under 2",
            vehicle_count
        );
    }

    #[test]
    fn default_world_keeps_entities_supported_after_settling() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
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
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_world_for_match(&mut arena, FLAT_VEHICLE_TEST_MATCH_ID)
            .expect("instantiate flat vehicle benchmark world");

        assert_eq!(arena.counts().0, 0);
        assert_eq!(arena.counts().1, 1);

        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let vehicles = arena.snapshot_vehicles();
        assert_eq!(vehicles.len(), 1);
        assert!(vehicles[0].py_mm > 0);
    }

    #[test]
    fn city_world_parks_two_cars_on_the_ring_outside_the_spawn_areas() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_world_for_match(&mut arena, "city-default").expect("instantiate city world");
        assert_eq!(arena.counts().1, 2);
        let world = city_world();
        let ring = crate::city::spawn_ring_radius_m();
        let mut types = world
            .dynamic_entities
            .iter()
            .filter(|entity| matches!(entity.kind, DynamicEntityKind::Vehicle))
            .map(|entity| {
                // On the x axis of the ring, where the downtown pack ends 32 m
                // short, and clear of every spawn area's radius.
                assert!((entity.position[0].abs() - ring).abs() < 0.5, "{:?}", entity.position);
                for area in &world.spawn_areas {
                    let dx = entity.position[0] - area.position[0];
                    let dz = entity.position[2] - area.position[2];
                    assert!((dx * dx + dz * dz).sqrt() > area.radius, "car {:?} inside spawn area {:?}", entity.position, area);
                }
                assert!(entity.id > 255, "vehicle id {} could collide with a u8 snapshot handle", entity.id);
                entity.vehicle_type.unwrap()
            })
            .collect::<Vec<_>>();
        types.sort_unstable();
        assert_eq!(types, vec![0, 1]);

        // Both rest on the ground box, upright.
        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }
        for vehicle in arena.snapshot_vehicles() {
            assert!(vehicle.py_mm > 0 && vehicle.py_mm < 2_000, "{vehicle:?}");
        }
    }

    #[test]
    fn benchmark_world_prefixes_create_isolated_vehicle_worlds() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_world_for_match(&mut arena, "flat_vehicle_test__run_123")
            .expect("instantiate isolated flat benchmark world");
        assert_eq!(arena.counts().1, 1);

        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_world_for_match(&mut arena, "vehicle_bumps_test__run_123")
            .expect("instantiate isolated bumps benchmark world");
        assert_eq!(arena.counts().1, 1);
    }

    #[test]
    fn vehicle_bumps_benchmark_world_keeps_single_vehicle_supported() {
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_world_for_match(&mut arena, VEHICLE_BUMPS_TEST_MATCH_ID)
            .expect("instantiate vehicle bumps benchmark world");

        assert_eq!(arena.counts().0, 0);
        assert_eq!(arena.counts().1, 1);

        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let vehicles = arena.snapshot_vehicles();
        assert_eq!(vehicles.len(), 1);
        assert!(vehicles[0].py_mm > 0);
    }

    #[test]
    fn seed_world_with_spawn_areas_propagates_areas_to_arena() {
        let area = SpawnArea {
            id: 1,
            position: [30.0, 0.0, -20.0],
            radius: 12.0,
        };
        let world = WorldDocument {
            version: vibe_land_shared::world_document::WORLD_DOCUMENT_VERSION,
            meta: WorldMeta {
                name: "Spawn Test".to_string(),
                description: String::new(),
            },
            terrain: WorldTerrain {
                tile_grid_size: 2,
                tile_half_extent_m: 64.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights: vec![0.0; 4],
                    materials: vec![],
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
            spawn_areas: vec![area],
        };

        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        world.instantiate(&mut arena).expect("instantiate");
        arena.set_spawn_areas(world.spawn_areas.clone());

        assert_eq!(
            arena.spawn_areas().len(),
            1,
            "spawn area should be registered on arena"
        );

        let spawn = arena.spawn_player(1);
        let dx = spawn.x as f32 - 30.0;
        let dz = spawn.z as f32 - (-20.0);
        assert!(
            dx * dx + dz * dz <= 12.0_f32 * 12.0,
            "player spawn ({:.1}, {:.1}) not within area radius 12 of (30, -20)",
            spawn.x,
            spawn.z,
        );
    }

    #[test]
    fn default_world_spawn_areas_are_loaded_and_player_lands_within_one() {
        // trail.world.json defines authored spawn areas; players must spawn inside one.
        let mut arena = PhysicsArena::new_rapier(MoveConfig::default());
        seed_default_world(&mut arena).expect("instantiate default world");
        assert!(
            !arena.spawn_areas().is_empty(),
            "default world should load spawn areas from trail.world.json"
        );
        let spawn = arena.spawn_player(42);
        assert!(
            spawn.y > -1.0,
            "spawn should land above ground, got y={:.2}",
            spawn.y
        );
        let inside_any_area = arena.spawn_areas().iter().any(|area| {
            let dx = spawn.x as f32 - area.position[0];
            let dz = spawn.z as f32 - area.position[2];
            dx * dx + dz * dz <= area.radius * area.radius
        });
        assert!(
            inside_any_area,
            "player spawn ({:.1}, {:.1}) not inside any of the {} spawn areas",
            spawn.x,
            spawn.z,
            arena.spawn_areas().len(),
        );
    }
}
