use std::fmt;

use nalgebra::{vector, DMatrix};
use serde::{Deserialize, Serialize};

use crate::{
    local_arena::{PhysicsArena, Vec3},
    movement::{VEHICLE_SUSPENSION_REST_LENGTH, VEHICLE_WHEEL_RADIUS},
    terrain::{
        build_demo_heightfield, demo_ball_pit_wall_cuboids, DEMO_BALL_PIT_X,
        DEMO_BALL_PIT_Z,
    },
};

pub const WORLD_DOCUMENT_VERSION: u32 = 1;

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

#[derive(Debug)]
pub enum WorldDocumentError {
    InvalidTerrainHeights {
        expected: usize,
        actual: usize,
    },
    MissingHalfExtents {
        entity_id: u32,
    },
    MissingRadius {
        entity_id: u32,
    },
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

impl WorldDocument {
    pub fn demo() -> Self {
        let (heights, scale) = build_demo_heightfield();
        let mut dynamic_entities = Vec::new();

        let radius = 0.3_f32;
        let inner_min_x = DEMO_BALL_PIT_X + 1.5;
        let inner_min_z = DEMO_BALL_PIT_Z + 1.5;
        let spacing = 0.8;
        let cols = 5;
        let rows = 5;
        let layers = 2;
        let mut next_dynamic_id = 1_u32;

        for layer in 0..layers {
            for row in 0..rows {
                for col in 0..cols {
                    dynamic_entities.push(DynamicEntity {
                        id: next_dynamic_id,
                        kind: DynamicEntityKind::Ball,
                        position: [
                            inner_min_x + col as f32 * spacing,
                            2.0 + layer as f32 * 0.8,
                            inner_min_z + row as f32 * spacing,
                        ],
                        rotation: identity_rotation(),
                        half_extents: None,
                        radius: Some(radius),
                        vehicle_type: None,
                    });
                    next_dynamic_id += 1;
                }
            }
        }

        dynamic_entities.push(DynamicEntity {
            id: 100,
            kind: DynamicEntityKind::Box,
            position: [4.0, 8.0, 4.0],
            rotation: identity_rotation(),
            half_extents: Some([0.5, 0.5, 0.5]),
            radius: None,
            vehicle_type: None,
        });
        dynamic_entities.push(DynamicEntity {
            id: 200,
            kind: DynamicEntityKind::Vehicle,
            position: [8.0, 2.0, 0.0],
            rotation: identity_rotation(),
            half_extents: None,
            radius: None,
            vehicle_type: Some(0),
        });

        Self {
            version: WORLD_DOCUMENT_VERSION,
            meta: WorldMeta {
                name: "Demo World".to_string(),
                description: "Default authored world for practice and godmode".to_string(),
            },
            terrain: WorldTerrain {
                grid_size: heights.nrows() as u16,
                half_extent_m: scale.x * 0.5,
                heights: heights.iter().copied().collect(),
            },
            static_props: demo_ball_pit_wall_cuboids()
                .into_iter()
                .enumerate()
                .map(|(index, (center, half_extents))| StaticProp {
                    id: 1000 + index as u32,
                    kind: StaticPropKind::Cuboid,
                    position: [center.x, center.y, center.z],
                    half_extents: [half_extents.x, half_extents.y, half_extents.z],
                    material: Some("pit-wall".to_string()),
                })
                .collect(),
            dynamic_entities,
        }
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

    pub fn sample_terrain_height_at_world_position(&self, x: f32, z: f32) -> f32 {
        let grid_size = self.terrain.grid_size as usize;
        if grid_size < 2 || self.terrain.heights.is_empty() {
            return 0.0;
        }

        let side = self.terrain.half_extent_m * 2.0;
        if side <= 0.0 {
            return 0.0;
        }

        let max_index = (grid_size - 1) as f32;
        let normalized_col = ((x + self.terrain.half_extent_m) / side).clamp(0.0, 1.0);
        let normalized_row = ((z + self.terrain.half_extent_m) / side).clamp(0.0, 1.0);
        let col = normalized_col * max_index;
        let row = normalized_row * max_index;

        let col0 = col.floor() as usize;
        let row0 = row.floor() as usize;
        let col1 = (col0 + 1).min(grid_size - 1);
        let row1 = (row0 + 1).min(grid_size - 1);
        let tx = col - col0 as f32;
        let tz = row - row0 as f32;

        let h00 = self.terrain.heights[row0 * grid_size + col0];
        let h10 = self.terrain.heights[row0 * grid_size + col1];
        let h01 = self.terrain.heights[row1 * grid_size + col0];
        let h11 = self.terrain.heights[row1 * grid_size + col1];
        let hx0 = lerp(h00, h10, tx);
        let hx1 = lerp(h01, h11, tx);
        lerp(hx0, hx1, tz)
    }

    pub fn instantiate(&self, arena: &mut PhysicsArena) -> Result<(), WorldDocumentError> {
        let heights = self.terrain_matrix()?;
        let side = self.terrain.half_extent_m * 2.0;
        arena.add_static_heightfield(heights, vector![side, 1.0, side], 0);

        for prop in &self.static_props {
            if matches!(prop.kind, StaticPropKind::Cuboid) {
                arena.add_static_cuboid(
                    Vec3::new(prop.position[0], prop.position[1], prop.position[2]),
                    Vec3::new(
                        prop.half_extents[0],
                        prop.half_extents[1],
                        prop.half_extents[2],
                    ),
                    prop.id as u128,
                );
            }
        }

        for entity in &self.dynamic_entities {
            let terrain_y = self.sample_terrain_height_at_world_position(
                entity.position[0],
                entity.position[2],
            );
            match entity.kind {
                DynamicEntityKind::Box => {
                    let half_extents = entity
                        .half_extents
                        .ok_or(WorldDocumentError::MissingHalfExtents {
                            entity_id: entity.id,
                        })?;
                    let spawn_y = entity.position[1].max(terrain_y + half_extents[1] + 0.05);
                    arena.spawn_dynamic_box_with_id(
                        entity.id,
                        Vec3::new(entity.position[0], spawn_y, entity.position[2]),
                        entity.rotation,
                        Vec3::new(half_extents[0], half_extents[1], half_extents[2]),
                    );
                }
                DynamicEntityKind::Ball => {
                    let radius = entity.radius.ok_or(WorldDocumentError::MissingRadius {
                        entity_id: entity.id,
                    })?;
                    let spawn_y = entity.position[1].max(terrain_y + radius + 0.05);
                    arena.spawn_dynamic_ball_with_id(
                        entity.id,
                        Vec3::new(entity.position[0], spawn_y, entity.position[2]),
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
                        Vec3::new(entity.position[0], spawn_y, entity.position[2]),
                        entity.rotation,
                    );
                }
            }
        }

        arena.rebuild_broad_phase();
        Ok(())
    }
}

pub fn identity_rotation() -> [f32; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_arena::MoveConfig;

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
        world.instantiate(&mut arena).expect("instantiate demo world");

        for _ in 0..300 {
            arena.step_vehicles(1.0 / 60.0);
            arena.step_dynamics(1.0 / 60.0);
        }

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot.iter().all(|(_, pos, _, _, _, _, _)| pos[1] > -0.25),
            "one or more dynamic bodies fell through authored terrain: {:?}",
            dynamic_snapshot.iter().map(|(id, pos, _, _, _, _, _)| (*id, pos[1])).collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > -250),
            "one or more vehicles fell through authored terrain: {:?}",
            vehicles.iter().map(|vehicle| (vehicle.id, vehicle.py_mm)).collect::<Vec<_>>()
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
        world.instantiate(&mut arena).expect("instantiate clamped world");

        let dynamic_snapshot = arena.snapshot_dynamic_bodies();
        assert!(
            dynamic_snapshot.iter().all(|(_, pos, _, _, _, _, _)| pos[1] > 4.0),
            "dynamic entities should be clamped above terrain: {:?}",
            dynamic_snapshot.iter().map(|(id, pos, _, _, _, _, _)| (*id, pos[1])).collect::<Vec<_>>()
        );

        let vehicles = arena.snapshot_vehicles();
        assert!(
            vehicles.iter().all(|vehicle| vehicle.py_mm > 4000),
            "vehicles should be clamped above terrain: {:?}",
            vehicles.iter().map(|vehicle| (vehicle.id, vehicle.py_mm)).collect::<Vec<_>>()
        );
    }
}
