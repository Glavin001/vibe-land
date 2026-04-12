use std::fmt;

use nalgebra::{vector, DMatrix, Vector3};
use serde::{Deserialize, Serialize};

use crate::{
    movement::{VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_WHEEL_RADIUS},
};

pub const WORLD_DOCUMENT_VERSION: u32 = 1;
pub const DEFAULT_WORLD_DOCUMENT_JSON: &str = include_str!("../../world/demo-world.world.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldDocument {
    pub version: u32,
    pub meta: WorldMeta,
    pub terrain: WorldTerrain,
    pub static_props: Vec<StaticProp>,
    pub dynamic_entities: Vec<DynamicEntity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMeta {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldTerrain {
    pub grid_size: u16,
    pub half_extent_m: f32,
    pub heights: Vec<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticProp {
    pub id: u32,
    pub kind: StaticPropKind,
    pub position: [f32; 3],
    pub half_extents: [f32; 3],
    #[serde(default)]
    pub material: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StaticPropKind {
    Cuboid,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicEntity {
    pub id: u32,
    pub kind: DynamicEntityKind,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    #[serde(default)]
    pub half_extents: Option<[f32; 3]>,
    #[serde(default)]
    pub radius: Option<f32>,
    #[serde(default)]
    pub vehicle_type: Option<u8>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamicEntityKind {
    Box,
    Ball,
    Vehicle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainBrushMode {
    Raise,
    Lower,
}

#[derive(Debug)]
pub enum WorldDocumentError {
    InvalidTerrainHeights { expected: usize, actual: usize },
    MissingHalfExtents { entity_id: u32 },
    MissingRadius { entity_id: u32 },
}

impl fmt::Display for WorldDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTerrainHeights { expected, actual } => {
                write!(
                    f,
                    "terrain height count mismatch: expected {expected}, got {actual}"
                )
            }
            Self::MissingHalfExtents { entity_id } => {
                write!(f, "dynamic entity {entity_id} missing halfExtents")
            }
            Self::MissingRadius { entity_id } => {
                write!(f, "dynamic entity {entity_id} missing radius")
            }
        }
    }
}

impl std::error::Error for WorldDocumentError {}

pub trait WorldDocumentArena {
    fn add_static_heightfield(
        &mut self,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
    );

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    );

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    );

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32);

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vector3<f32>,
        rotation: [f32; 4],
    );

    fn rebuild_broad_phase(&mut self);
}

impl WorldDocumentArena for crate::local_arena::PhysicsArena {
    fn add_static_heightfield(
        &mut self,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
    ) {
        crate::local_arena::PhysicsArena::add_static_heightfield(self, heights, scale, user_data);
    }

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        half_extents: Vector3<f32>,
        user_data: u128,
    ) {
        crate::local_arena::PhysicsArena::add_static_cuboid(self, center, half_extents, user_data);
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    ) {
        crate::local_arena::PhysicsArena::spawn_dynamic_box_with_id(
            self,
            id,
            position,
            rotation,
            half_extents,
        );
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        crate::local_arena::PhysicsArena::spawn_dynamic_ball_with_id(self, id, position, radius);
    }

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vector3<f32>,
        rotation: [f32; 4],
    ) {
        crate::local_arena::PhysicsArena::spawn_vehicle_with_id(
            self,
            id,
            vehicle_type,
            position,
            rotation,
        );
    }

    fn rebuild_broad_phase(&mut self) {
        crate::local_arena::PhysicsArena::rebuild_broad_phase(self);
    }
}

impl WorldDocument {
    pub fn demo() -> Self {
        serde_json::from_str(DEFAULT_WORLD_DOCUMENT_JSON)
            .expect("default world document asset should deserialize")
    }

    pub fn terrain_matrix(&self) -> Result<DMatrix<f32>, WorldDocumentError> {
        let side = self.terrain.grid_size as usize;
        let expected = side * side;
        let actual = self.terrain.heights.len();
        if actual != expected {
            return Err(WorldDocumentError::InvalidTerrainHeights { expected, actual });
        }
        Ok(DMatrix::from_row_slice(
            side,
            side,
            self.terrain.heights.as_slice(),
        ))
    }

    pub fn terrain_scale(&self) -> Vector3<f32> {
        let side = self.terrain.half_extent_m * 2.0;
        vector![side, 1.0, side]
    }

    pub fn sample_terrain_height_at_world_position(&self, x: f32, z: f32) -> f32 {
        self.sample_heightfield_surface_at_world_position(x, z)
    }

    pub fn sample_heightfield_surface_at_world_position(&self, x: f32, z: f32) -> f32 {
        let grid_size = self.terrain.grid_size as usize;
        if grid_size < 2 || self.terrain.heights.is_empty() {
            return 0.0;
        }

        let side = self.terrain.half_extent_m * 2.0;
        if side <= 0.0 {
            return 0.0;
        }

        let max_cell = (grid_size - 2) as f32;
        let max_index = (grid_size - 1) as f32;
        let col = (((x + self.terrain.half_extent_m) / side) * max_index).clamp(0.0, max_index);
        let row = (((z + self.terrain.half_extent_m) / side) * max_index).clamp(0.0, max_index);
        let cell_col = col.floor().min(max_cell) as usize;
        let cell_row = row.floor().min(max_cell) as usize;
        let u = col - cell_col as f32;
        let v = row - cell_row as f32;

        let h00 = self.terrain.heights[cell_row * grid_size + cell_col];
        let h10 = self.terrain.heights[cell_row * grid_size + cell_col + 1];
        let h01 = self.terrain.heights[(cell_row + 1) * grid_size + cell_col];
        let h11 = self.terrain.heights[(cell_row + 1) * grid_size + cell_col + 1];

        if u + v <= 1.0 {
            h00 + (h10 - h00) * u + (h01 - h00) * v
        } else {
            h11 + (h01 - h11) * (1.0 - u) + (h10 - h11) * (1.0 - v)
        }
    }

    pub fn terrain_world_position(&self, row: usize, col: usize) -> (f32, f32) {
        let last = (self.terrain.grid_size.saturating_sub(1)) as f32;
        if last <= 0.0 {
            return (0.0, 0.0);
        }
        let side = self.terrain.half_extent_m * 2.0;
        let x = -self.terrain.half_extent_m + side * (col as f32 / last);
        let z = -self.terrain.half_extent_m + side * (row as f32 / last);
        (x, z)
    }

    pub fn apply_terrain_brush(
        &mut self,
        center_x: f32,
        center_z: f32,
        radius: f32,
        strength: f32,
        mode: TerrainBrushMode,
    ) {
        let grid_size = self.terrain.grid_size as usize;
        if grid_size == 0 || radius <= 0.0 || strength <= 0.0 {
            return;
        }

        let direction = match mode {
            TerrainBrushMode::Raise => 1.0,
            TerrainBrushMode::Lower => -1.0,
        };

        for row in 0..grid_size {
            for col in 0..grid_size {
                let (x, z) = self.terrain_world_position(row, col);
                let distance = ((x - center_x).powi(2) + (z - center_z).powi(2)).sqrt();
                if distance > radius {
                    continue;
                }
                let falloff = 1.0 - distance / radius;
                let delta = strength * falloff * falloff * direction;
                let index = row * grid_size + col;
                self.terrain.heights[index] = (self.terrain.heights[index] + delta).clamp(-10.0, 50.0);
            }
        }
    }

    pub fn instantiate<A: WorldDocumentArena>(
        &self,
        arena: &mut A,
    ) -> Result<(), WorldDocumentError> {
        arena.add_static_heightfield(self.terrain_matrix()?, self.terrain_scale(), 0);

        for prop in &self.static_props {
            if matches!(prop.kind, StaticPropKind::Cuboid) {
                arena.add_static_cuboid(
                    Vector3::new(prop.position[0], prop.position[1], prop.position[2]),
                    Vector3::new(
                        prop.half_extents[0],
                        prop.half_extents[1],
                        prop.half_extents[2],
                    ),
                    prop.id as u128,
                );
            }
        }

        // Bootstrap the static world once before spawning dynamic authored entities.
        // Let the first physics step register dynamic colliders naturally instead of
        // folding them into the static rebuild path.
        arena.rebuild_broad_phase();

        for entity in &self.dynamic_entities {
            let terrain_y = self.sample_heightfield_surface_at_world_position(
                entity.position[0],
                entity.position[2],
            );
            match entity.kind {
                DynamicEntityKind::Box => {
                    let half_extents =
                        entity
                            .half_extents
                            .ok_or(WorldDocumentError::MissingHalfExtents {
                                entity_id: entity.id,
                            })?;
                    let spawn_y = entity.position[1].max(terrain_y + half_extents[1] + 0.05);
                    arena.spawn_dynamic_box_with_id(
                        entity.id,
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        entity.rotation,
                        Vector3::new(half_extents[0], half_extents[1], half_extents[2]),
                    );
                }
                DynamicEntityKind::Ball => {
                    let radius = entity.radius.ok_or(WorldDocumentError::MissingRadius {
                        entity_id: entity.id,
                    })?;
                    let spawn_y = entity.position[1].max(terrain_y + radius + 0.05);
                    arena.spawn_dynamic_ball_with_id(
                        entity.id,
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        radius,
                    );
                }
                DynamicEntityKind::Vehicle => {
                    let min_vehicle_y =
                        terrain_y + VEHICLE_SUSPENSION_REST_LENGTH + VEHICLE_WHEEL_RADIUS + 0.2;
                    let spawn_y = entity.position[1].max(min_vehicle_y);
                    arena.spawn_vehicle_with_id(
                        entity.id,
                        entity.vehicle_type.unwrap_or(0),
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        entity.rotation,
                    );
                }
            }
        }
        Ok(())
    }
}

pub fn identity_rotation() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_arena::{MoveConfig, PhysicsArena};

    const BROKEN_WORLD_DOCUMENT_JSON: &str = include_str!("../../world/broken.world.json");

    fn apply_demo_brushes(world: &mut WorldDocument) {
        for _ in 0..18 {
            world.apply_terrain_brush(8.0, 8.0, 12.0, 0.12, TerrainBrushMode::Raise);
            world.apply_terrain_brush(0.0, 0.0, 10.0, 0.08, TerrainBrushMode::Raise);
        }
    }

    fn broken_world() -> WorldDocument {
        serde_json::from_str(BROKEN_WORLD_DOCUMENT_JSON)
            .expect("broken world document asset should deserialize")
    }

    fn cast_terrain_height(world: &WorldDocument, x: f32, z: f32) -> f32 {
        let mut terrain_only_world = world.clone();
        terrain_only_world.dynamic_entities.clear();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        terrain_only_world
            .instantiate(&mut arena)
            .expect("instantiate terrain-only world");
        let toi = arena
            .cast_static_world_ray([x, 40.0, z], [0.0, -1.0, 0.0], 100.0, None)
            .expect("ray should hit terrain");
        40.0 - toi
    }

    fn build_ball_stack(world: &WorldDocument, start_id: u32, center_x: f32, center_z: f32) -> Vec<DynamicEntity> {
        let radius = 0.3;
        let spacing = 0.8;
        let cols = 5;
        let rows = 5;
        let layers = 2;
        let inner_min_x = center_x - spacing * ((cols - 1) as f32) * 0.5;
        let inner_min_z = center_z - spacing * ((rows - 1) as f32) * 0.5;

        let mut max_terrain = f32::NEG_INFINITY;
        for layer in 0..layers {
            let _ = layer;
            for row in 0..rows {
                for col in 0..cols {
                    let x = inner_min_x + col as f32 * spacing;
                    let z = inner_min_z + row as f32 * spacing;
                    max_terrain =
                        max_terrain.max(world.sample_heightfield_surface_at_world_position(x, z));
                }
            }
        }

        let base_y = max_terrain + 2.0;
        let mut entities = Vec::with_capacity((cols * rows * layers) as usize);
        let mut next_id = start_id;
        for layer in 0..layers {
            for row in 0..rows {
                for col in 0..cols {
                    let x = inner_min_x + col as f32 * spacing;
                    let z = inner_min_z + row as f32 * spacing;
                    entities.push(DynamicEntity {
                        id: next_id,
                        kind: DynamicEntityKind::Ball,
                        position: [x, base_y + layer as f32 * 0.8, z],
                        rotation: identity_rotation(),
                        half_extents: None,
                        radius: Some(radius),
                        vehicle_type: None,
                    });
                    next_id += 1;
                }
            }
        }
        entities
    }

    #[test]
    fn demo_document_has_valid_height_count() {
        let world = WorldDocument::demo();
        let expected = usize::from(world.terrain.grid_size) * usize::from(world.terrain.grid_size);
        assert_eq!(world.terrain.heights.len(), expected);
    }

    #[test]
    fn demo_document_roundtrips_json() {
        let world = WorldDocument::demo();
        let json = serde_json::to_string(&world).expect("serialize world");
        let decoded: WorldDocument = serde_json::from_str(&json).expect("deserialize world");
        assert_eq!(decoded.version, WORLD_DOCUMENT_VERSION);
        assert_eq!(decoded.dynamic_entities.len(), world.dynamic_entities.len());
    }

    #[test]
    fn demo_document_runtime_entities_stay_above_ground() {
        let world = WorldDocument::demo();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate demo world");

        for _ in 0..300 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot
                .iter()
                .all(|(_, pos, _, _, _, _, _)| pos[1] > -0.25),
            "one or more dynamic bodies fell through authored terrain: {:?}",
            dynamic_snapshot
                .iter()
                .map(|(id, pos, _, _, _, _, _)| (*id, pos[1]))
                .collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > -250),
            "one or more vehicles fell through authored terrain: {:?}",
            vehicles
                .iter()
                .map(|vehicle| (vehicle.id, vehicle.py_mm))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn instantiate_clamps_entities_above_terrain() {
        let mut world = WorldDocument::demo();
        world.terrain.heights.fill(4.0);
        for entity in &mut world.dynamic_entities {
            entity.position[1] = -2.0;
        }

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate clamped world");

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot
                .iter()
                .all(|(_, pos, _, _, _, _, _)| pos[1] > 4.0),
            "dynamic entities should be clamped above terrain: {:?}",
            dynamic_snapshot
                .iter()
                .map(|(id, pos, _, _, _, _, _)| (*id, pos[1]))
                .collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > 4000),
            "vehicles should be clamped above terrain: {:?}",
            vehicles
                .iter()
                .map(|vehicle| (vehicle.id, vehicle.py_mm))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn brushed_demo_world_keeps_a_ball_supported() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);

        world.dynamic_entities = vec![DynamicEntity {
            id: 9001,
            kind: DynamicEntityKind::Ball,
            position: [
                9.5,
                world.sample_heightfield_surface_at_world_position(9.5, 9.5) + 2.0,
                9.5,
            ],
            rotation: identity_rotation(),
            half_extents: None,
            radius: Some(0.5),
            vehicle_type: None,
        }];

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed world");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        let (_, pos, _, _, _, _, _) = dynamic_snapshot
            .iter()
            .find(|(id, _, _, _, _, _, _)| *id == 9001)
            .expect("spawned ball should exist");
        let terrain_y = cast_terrain_height(&world, pos[0], pos[2]);
        assert!(
            pos[1] > terrain_y - 0.25,
            "brushed-world ball fell through terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
            pos[0],
            pos[1],
            pos[2],
        );
    }

    #[test]
    fn brushed_demo_world_raycast_matches_heightfield_surface() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);

        for (x, z) in [(9.5, 9.5), (10.3, 9.5), (11.1, 10.3), (0.0, 0.0)] {
            let expected = world.sample_heightfield_surface_at_world_position(x, z);
            let hit_y = cast_terrain_height(&world, x, z);
            assert!(
                (hit_y - expected).abs() < 0.05,
                "raycast mismatch at ({x}, {z}): hit_y={hit_y:.3} expected={expected:.3}",
            );
        }
    }

    #[test]
    fn brushed_demo_world_keeps_high_ball_stack_supported_in_open_terrain() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);
        world.static_props.clear();
        world.dynamic_entities = build_ball_stack(&world, 10_000, 11.1, 11.1);

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed open-terrain stack");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        for (ball_id, pos, _, _, _, _, _) in dynamic_snapshot {
            let terrain_y = cast_terrain_height(&world, pos[0], pos[2]);
            assert!(
                pos[1] > terrain_y - 0.25,
                "open-terrain stack ball {ball_id} fell through terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
                pos[0],
                pos[1],
                pos[2],
            );
        }
    }

    #[test]
    fn brushed_demo_world_keeps_default_ball_pit_supported() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed default world");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        for (ball_id, pos, _, _, _, _, _) in arena.snapshot_dynamic_bodies() {
            let terrain_y = cast_terrain_height(&world, pos[0], pos[2]);
            assert!(
                pos[1] > terrain_y - 0.25,
                "default pit ball {ball_id} fell through terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
                pos[0],
                pos[1],
                pos[2],
            );
        }
    }

    #[test]
    fn brushed_demo_world_keeps_vehicle_supported() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed default world");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        for vehicle in arena.snapshot_vehicles() {
            let px = vehicle.px_mm as f32 / 1000.0;
            let py = vehicle.py_mm as f32 / 1000.0;
            let pz = vehicle.pz_mm as f32 / 1000.0;
            let terrain_y = cast_terrain_height(&world, px, pz);
            assert!(
                py > terrain_y - 0.25,
                "default brushed vehicle {} fell through terrain: pos=({px:.3}, {py:.3}, {pz:.3}) terrain_y={terrain_y:.3}",
                vehicle.id,
            );
        }
    }

    #[test]
    fn brushed_demo_world_keeps_repro_ball_supported() {
        let mut world = WorldDocument::demo();
        apply_demo_brushes(&mut world);
        world.dynamic_entities = vec![DynamicEntity {
            id: 42_001,
            kind: DynamicEntityKind::Ball,
            position: [9.5, 4.0, 9.5],
            rotation: identity_rotation(),
            half_extents: None,
            radius: Some(0.3),
            vehicle_type: None,
        }];

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed repro ball world");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let body = arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .find(|(id, ..)| *id == 42_001)
            .expect("repro ball should exist");
        let terrain_y = cast_terrain_height(&world, body.1[0], body.1[2]);
        assert!(
            body.1[1] > terrain_y - 0.25,
            "programmatic brushed repro ball fell through terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
            body.1[0],
            body.1[1],
            body.1[2],
        );
    }

    #[test]
    fn broken_world_keeps_authored_dynamics_supported() {
        let world = broken_world();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world.instantiate(&mut arena).expect("instantiate broken world");

        for _ in 0..360 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        for entity in &world.dynamic_entities {
            match entity.kind {
                DynamicEntityKind::Vehicle => {
                    let vehicle = arena
                        .snapshot_vehicles()
                        .into_iter()
                        .find(|vehicle| vehicle.id == entity.id)
                        .expect("authored vehicle should exist");
                    let terrain_y = cast_terrain_height(
                        &world,
                        vehicle.px_mm as f32 / 1000.0,
                        vehicle.pz_mm as f32 / 1000.0,
                    );
                    let final_y = vehicle.py_mm as f32 / 1000.0;
                    assert!(
                        final_y > terrain_y - 0.25,
                        "vehicle {} fell through broken world terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
                        entity.id,
                        vehicle.px_mm as f32 / 1000.0,
                        final_y,
                        vehicle.pz_mm as f32 / 1000.0,
                    );
                }
                _ => {
                    let body = arena
                        .snapshot_dynamic_bodies()
                        .into_iter()
                        .find(|(id, ..)| *id == entity.id)
                        .expect("authored dynamic body should exist");
                    let terrain_y = cast_terrain_height(&world, body.1[0], body.1[2]);
                    assert!(
                        body.1[1] > terrain_y - 0.25,
                        "{} {} fell through broken world terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
                        match entity.kind {
                            DynamicEntityKind::Ball => "ball",
                            DynamicEntityKind::Box => "box",
                            DynamicEntityKind::Vehicle => "vehicle",
                        },
                        entity.id,
                        body.1[0],
                        body.1[1],
                        body.1[2],
                    );
                }
            }
        }
    }

    #[test]
    fn broken_world_reports_upward_terrain_normals_at_repro_points() {
        let world = broken_world();
        let mut terrain_only_world = world.clone();
        terrain_only_world.dynamic_entities.clear();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        terrain_only_world
            .instantiate(&mut arena)
            .expect("instantiate terrain-only broken world");

        for (x, z) in [(9.5_f32, 9.5_f32), (8.0_f32, 0.0_f32), (4.0_f32, 4.0_f32)] {
            let (_toi, normal) = arena
                .dynamic
                .sim
                .cast_ray_and_get_normal([x, 40.0, z], [0.0, -1.0, 0.0], 100.0, None)
                .expect("ray should hit terrain");
            assert!(
                normal[1] > 0.0,
                "terrain normal should point upward at ({x}, {z}), got {:?}",
                normal
            );
        }
    }

}
