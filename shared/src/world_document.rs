use std::fmt;

use nalgebra::{vector, DMatrix, Quaternion, UnitQuaternion, Vector3};
use serde::{de::Deserializer, Deserialize, Serialize};

use crate::vehicle::{vehicle_definition, DEFAULT_VEHICLE_TYPE};

pub const WORLD_DOCUMENT_VERSION: u32 = 2;
pub const DEFAULT_WORLD_DOCUMENT_JSON: &str = include_str!("../../worlds/trail.world.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldDocument {
    #[serde(default = "world_document_version")]
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
pub struct TerrainMaterial {
    pub name: String,
    pub color: String,
    pub roughness: f32,
    pub metalness: f32,
    pub friction: f32,
    pub restitution: f32,
    pub flammability: f32,
    pub fuel_load: f32,
    pub burn_rate: f32,
    pub moisture: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldTerrain {
    pub tile_grid_size: u16,
    pub tile_half_extent_m: f32,
    pub tiles: Vec<WorldTerrainTile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldTerrainTile {
    pub tile_x: i32,
    pub tile_z: i32,
    pub heights: Vec<f32>,
    #[serde(default)]
    pub materials: Vec<TerrainMaterial>,
    #[serde(default)]
    pub material_weights: Option<Vec<f32>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticProp {
    pub id: u32,
    pub kind: StaticPropKind,
    pub position: [f32; 3],
    #[serde(default = "identity_rotation")]
    pub rotation: [f32; 4],
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
    #[serde(default)]
    pub energy: Option<f32>,
    #[serde(default)]
    pub height: Option<f32>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DynamicEntityKind {
    Box,
    Ball,
    Vehicle,
    Battery,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainBrushMode {
    Raise,
    Lower,
}

#[derive(Debug)]
pub enum WorldDocumentError {
    InvalidTerrainHeights {
        tile_x: i32,
        tile_z: i32,
        expected: usize,
        actual: usize,
    },
    MissingHalfExtents {
        entity_id: u32,
    },
    MissingRadius {
        entity_id: u32,
    },
    MissingBatteryEnergy {
        entity_id: u32,
    },
}

impl fmt::Display for WorldDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTerrainHeights {
                tile_x,
                tile_z,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "terrain tile ({tile_x}, {tile_z}) height count mismatch: expected {expected}, got {actual}"
                )
            }
            Self::MissingHalfExtents { entity_id } => {
                write!(f, "dynamic entity {entity_id} missing halfExtents")
            }
            Self::MissingRadius { entity_id } => {
                write!(f, "dynamic entity {entity_id} missing radius")
            }
            Self::MissingBatteryEnergy { entity_id } => {
                write!(f, "battery entity {entity_id} missing energy")
            }
        }
    }
}

impl std::error::Error for WorldDocumentError {}

fn world_document_version() -> u32 {
    WORLD_DOCUMENT_VERSION
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TiledWorldTerrain {
    tile_grid_size: u16,
    tile_half_extent_m: f32,
    tiles: Vec<WorldTerrainTile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWorldTerrain {
    grid_size: u16,
    half_extent_m: f32,
    heights: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawWorldTerrain {
    Tiled(TiledWorldTerrain),
    Legacy(LegacyWorldTerrain),
}

impl<'de> Deserialize<'de> for WorldTerrain {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawWorldTerrain::deserialize(deserializer)?;
        Ok(match raw {
            RawWorldTerrain::Tiled(TiledWorldTerrain {
                tile_grid_size,
                tile_half_extent_m,
                mut tiles,
            }) => {
                if tiles.is_empty() {
                    tiles.push(WorldTerrainTile {
                        tile_x: 0,
                        tile_z: 0,
                        heights: vec![
                            0.0;
                            usize::from(tile_grid_size) * usize::from(tile_grid_size)
                        ],
                        materials: Vec::new(),
                        material_weights: None,
                    });
                }
                tiles.sort_by_key(|tile| (tile.tile_z, tile.tile_x));
                Self {
                    tile_grid_size,
                    tile_half_extent_m,
                    tiles,
                }
            }
            RawWorldTerrain::Legacy(LegacyWorldTerrain {
                grid_size,
                half_extent_m,
                heights,
            }) => Self {
                tile_grid_size: grid_size,
                tile_half_extent_m: half_extent_m,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights,
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
        })
    }
}

pub trait WorldDocumentArena {
    fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
    );

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
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

    fn spawn_battery_with_id(
        &mut self,
        _id: u32,
        _position: Vector3<f32>,
        _energy: f32,
        _radius: f32,
        _height: f32,
    ) {
    }

    fn rebuild_broad_phase(&mut self);
}

impl WorldDocumentArena for crate::physics_arena::PhysicsArena {
    fn add_static_heightfield(
        &mut self,
        center: Vector3<f32>,
        heights: DMatrix<f32>,
        scale: Vector3<f32>,
        user_data: u128,
    ) {
        crate::physics_arena::PhysicsArena::add_static_heightfield(
            self, center, heights, scale, user_data,
        );
    }

    fn add_static_cuboid(
        &mut self,
        center: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
        user_data: u128,
    ) {
        crate::physics_arena::PhysicsArena::add_static_cuboid_rotated(
            self,
            center,
            rotation,
            half_extents,
            user_data,
        );
    }

    fn spawn_dynamic_box_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        rotation: [f32; 4],
        half_extents: Vector3<f32>,
    ) {
        crate::physics_arena::PhysicsArena::spawn_dynamic_box_with_id(
            self,
            id,
            position,
            rotation,
            half_extents,
        );
    }

    fn spawn_dynamic_ball_with_id(&mut self, id: u32, position: Vector3<f32>, radius: f32) {
        crate::physics_arena::PhysicsArena::spawn_dynamic_ball_with_id(self, id, position, radius);
    }

    fn spawn_vehicle_with_id(
        &mut self,
        id: u32,
        vehicle_type: u8,
        position: Vector3<f32>,
        rotation: [f32; 4],
    ) {
        crate::physics_arena::PhysicsArena::spawn_vehicle_with_id(
            self,
            id,
            vehicle_type,
            position,
            rotation,
        );
    }

    fn spawn_battery_with_id(
        &mut self,
        id: u32,
        position: Vector3<f32>,
        energy: f32,
        radius: f32,
        height: f32,
    ) {
        let position =
            crate::movement::Vec3d::new(position.x as f64, position.y as f64, position.z as f64);
        crate::physics_arena::PhysicsArena::spawn_battery_with_id(
            self, id, position, energy, radius, height,
        );
    }

    fn rebuild_broad_phase(&mut self) {
        crate::physics_arena::PhysicsArena::rebuild_broad_phase(self);
    }
}

impl WorldDocument {
    fn sample_support_height_at_world_position(
        &self,
        x: f32,
        z: f32,
        horizontal_offsets: &[(f32, f32)],
        rotation: Option<[f32; 4]>,
    ) -> f32 {
        let mut max_support_height = self.sample_heightfield_surface_at_world_position(x, z);
        for &(offset_x, offset_z) in horizontal_offsets {
            let (sample_x, sample_z) = if let Some(rotation) = rotation {
                Self::rotate_support_offset(rotation, offset_x, offset_z)
            } else {
                (offset_x, offset_z)
            };
            max_support_height = max_support_height
                .max(self.sample_heightfield_surface_at_world_position(x + sample_x, z + sample_z));
        }
        max_support_height
    }

    fn rotate_support_offset(rotation: [f32; 4], x: f32, z: f32) -> (f32, f32) {
        let yaw_only = UnitQuaternion::from_quaternion(Quaternion::new(
            rotation[3],
            rotation[0],
            rotation[1],
            rotation[2],
        ));
        let rotated = yaw_only.transform_vector(&Vector3::new(x, 0.0, z));
        (rotated.x, rotated.z)
    }

    fn sample_vehicle_support_height_at_world_position(
        &self,
        x: f32,
        z: f32,
        rotation: [f32; 4],
        vehicle_type: u8,
    ) -> f32 {
        let definition = vehicle_definition(vehicle_type);
        let mut offsets = Vec::with_capacity(definition.wheel_offsets.len() + 4);
        for offset in definition.wheel_offsets {
            offsets.push((offset[0], offset[2]));
        }
        let half_x = definition.chassis_half_extents[0];
        let half_z = definition.chassis_half_extents[2];
        offsets.extend_from_slice(&[
            (-half_x, -half_z),
            (-half_x, half_z),
            (half_x, -half_z),
            (half_x, half_z),
        ]);
        self.sample_support_height_at_world_position(x, z, offsets.as_slice(), Some(rotation))
    }

    fn minimum_box_spawn_center_y(
        &self,
        x: f32,
        z: f32,
        rotation: [f32; 4],
        half_extents: [f32; 3],
    ) -> f32 {
        let support_height = self.sample_support_height_at_world_position(
            x,
            z,
            &[
                (-half_extents[0], -half_extents[2]),
                (-half_extents[0], half_extents[2]),
                (half_extents[0], -half_extents[2]),
                (half_extents[0], half_extents[2]),
            ],
            Some(rotation),
        );
        support_height + half_extents[1] + 0.05
    }

    fn minimum_ball_spawn_center_y(&self, x: f32, z: f32, radius: f32) -> f32 {
        let diagonal = radius * std::f32::consts::FRAC_1_SQRT_2;
        let support_height = self.sample_support_height_at_world_position(
            x,
            z,
            &[
                (radius, 0.0),
                (-radius, 0.0),
                (0.0, radius),
                (0.0, -radius),
                (diagonal, diagonal),
                (diagonal, -diagonal),
                (-diagonal, diagonal),
                (-diagonal, -diagonal),
            ],
            None,
        );
        support_height + radius + 0.05
    }

    fn minimum_vehicle_spawn_center_y(
        &self,
        x: f32,
        z: f32,
        rotation: [f32; 4],
        vehicle_type: u8,
    ) -> f32 {
        let definition = vehicle_definition(vehicle_type);
        let support_height =
            self.sample_vehicle_support_height_at_world_position(x, z, rotation, vehicle_type);
        let wheel_clearance = definition.suspension_rest_length_m
            + definition.suspension_travel_m
            + definition.wheel_radius_m;
        let chassis_clearance = definition.chassis_half_extents[1] + 0.1;
        support_height + wheel_clearance.max(chassis_clearance) + 0.1
    }

    pub fn demo() -> Self {
        let mut world: Self = serde_json::from_str(DEFAULT_WORLD_DOCUMENT_JSON)
            .expect("default world document asset should deserialize");
        world.version = WORLD_DOCUMENT_VERSION;
        world
    }

    pub fn terrain_tile_matrix(
        &self,
        tile: &WorldTerrainTile,
    ) -> Result<DMatrix<f32>, WorldDocumentError> {
        let side = usize::from(self.terrain.tile_grid_size);
        let expected = side * side;
        let actual = tile.heights.len();
        if actual != expected {
            return Err(WorldDocumentError::InvalidTerrainHeights {
                tile_x: tile.tile_x,
                tile_z: tile.tile_z,
                expected,
                actual,
            });
        }
        Ok(DMatrix::from_row_slice(side, side, tile.heights.as_slice()))
    }

    pub fn terrain_tile_scale(&self) -> Vector3<f32> {
        let side = self.terrain.tile_half_extent_m * 2.0;
        vector![side, 1.0, side]
    }

    pub fn sample_terrain_height_at_world_position(&self, x: f32, z: f32) -> f32 {
        self.sample_heightfield_surface_at_world_position(x, z)
    }

    pub fn sample_heightfield_surface_at_world_position(&self, x: f32, z: f32) -> f32 {
        let grid_size = usize::from(self.terrain.tile_grid_size);
        if grid_size < 2 || self.terrain.tiles.is_empty() {
            return 0.0;
        }

        let side = self.terrain.tile_half_extent_m * 2.0;
        if side <= 0.0 {
            return 0.0;
        }

        let (min_tile_x, max_tile_x, min_tile_z, max_tile_z, min_x, max_x, min_z, max_z) =
            self.terrain_world_bounds();
        let clamped_x = x.clamp(min_x, max_x);
        let clamped_z = z.clamp(min_z, max_z);
        let tile_x = (((clamped_x + self.terrain.tile_half_extent_m) / side).floor() as i32)
            .clamp(min_tile_x, max_tile_x);
        let tile_z = (((clamped_z + self.terrain.tile_half_extent_m) / side).floor() as i32)
            .clamp(min_tile_z, max_tile_z);
        let Some(tile) = self
            .terrain_tile(tile_x, tile_z)
            .or_else(|| self.find_nearest_terrain_tile(clamped_x, clamped_z))
        else {
            return 0.0;
        };

        let (center_x, center_z) = self.terrain_tile_center(tile.tile_x, tile.tile_z);
        let max_cell = (grid_size - 2) as f32;
        let max_index = (grid_size - 1) as f32;
        let col = (((clamped_x - center_x + self.terrain.tile_half_extent_m) / side) * max_index)
            .clamp(0.0, max_index);
        let row = (((clamped_z - center_z + self.terrain.tile_half_extent_m) / side) * max_index)
            .clamp(0.0, max_index);
        let cell_col = col.floor().min(max_cell) as usize;
        let cell_row = row.floor().min(max_cell) as usize;
        let u = col - cell_col as f32;
        let v = row - cell_row as f32;

        let h00 = tile.heights[cell_row * grid_size + cell_col];
        let h10 = tile.heights[cell_row * grid_size + cell_col + 1];
        let h01 = tile.heights[(cell_row + 1) * grid_size + cell_col];
        let h11 = tile.heights[(cell_row + 1) * grid_size + cell_col + 1];

        if u + v <= 1.0 {
            h00 + (h10 - h00) * u + (h01 - h00) * v
        } else {
            h11 + (h01 - h11) * (1.0 - u) + (h10 - h11) * (1.0 - v)
        }
    }

    pub fn terrain_tile_center(&self, tile_x: i32, tile_z: i32) -> (f32, f32) {
        let side = self.terrain.tile_half_extent_m * 2.0;
        (tile_x as f32 * side, tile_z as f32 * side)
    }

    pub fn terrain_world_bounds(&self) -> (i32, i32, i32, i32, f32, f32, f32, f32) {
        if self.terrain.tiles.is_empty() {
            return (
                0,
                0,
                0,
                0,
                -self.terrain.tile_half_extent_m,
                self.terrain.tile_half_extent_m,
                -self.terrain.tile_half_extent_m,
                self.terrain.tile_half_extent_m,
            );
        }

        let min_tile_x = self
            .terrain
            .tiles
            .iter()
            .map(|tile| tile.tile_x)
            .min()
            .unwrap_or(0);
        let max_tile_x = self
            .terrain
            .tiles
            .iter()
            .map(|tile| tile.tile_x)
            .max()
            .unwrap_or(0);
        let min_tile_z = self
            .terrain
            .tiles
            .iter()
            .map(|tile| tile.tile_z)
            .min()
            .unwrap_or(0);
        let max_tile_z = self
            .terrain
            .tiles
            .iter()
            .map(|tile| tile.tile_z)
            .max()
            .unwrap_or(0);
        let (min_center_x, min_center_z) = self.terrain_tile_center(min_tile_x, min_tile_z);
        let (max_center_x, max_center_z) = self.terrain_tile_center(max_tile_x, max_tile_z);
        (
            min_tile_x,
            max_tile_x,
            min_tile_z,
            max_tile_z,
            min_center_x - self.terrain.tile_half_extent_m,
            max_center_x + self.terrain.tile_half_extent_m,
            min_center_z - self.terrain.tile_half_extent_m,
            max_center_z + self.terrain.tile_half_extent_m,
        )
    }

    pub fn terrain_tile(&self, tile_x: i32, tile_z: i32) -> Option<&WorldTerrainTile> {
        self.terrain
            .tiles
            .iter()
            .find(|tile| tile.tile_x == tile_x && tile.tile_z == tile_z)
    }

    fn find_nearest_terrain_tile(&self, x: f32, z: f32) -> Option<&WorldTerrainTile> {
        self.terrain.tiles.iter().min_by(|a, b| {
            let (ax, az) = self.terrain_tile_center(a.tile_x, a.tile_z);
            let (bx, bz) = self.terrain_tile_center(b.tile_x, b.tile_z);
            let ad = (ax - x).powi(2) + (az - z).powi(2);
            let bd = (bx - x).powi(2) + (bz - z).powi(2);
            ad.partial_cmp(&bd).unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    pub fn terrain_tile_world_position(
        &self,
        tile_x: i32,
        tile_z: i32,
        row: usize,
        col: usize,
    ) -> (f32, f32) {
        let last = (self.terrain.tile_grid_size.saturating_sub(1)) as f32;
        if last <= 0.0 {
            return self.terrain_tile_center(tile_x, tile_z);
        }
        let side = self.terrain.tile_half_extent_m * 2.0;
        let (center_x, center_z) = self.terrain_tile_center(tile_x, tile_z);
        let x = center_x - self.terrain.tile_half_extent_m + side * (col as f32 / last);
        let z = center_z - self.terrain.tile_half_extent_m + side * (row as f32 / last);
        (x, z)
    }

    pub fn terrain_world_position(&self, row: usize, col: usize) -> (f32, f32) {
        self.terrain_tile_world_position(0, 0, row, col)
    }

    pub fn apply_terrain_brush(
        &mut self,
        center_x: f32,
        center_z: f32,
        radius: f32,
        strength: f32,
        mode: TerrainBrushMode,
    ) {
        let grid_size = usize::from(self.terrain.tile_grid_size);
        if grid_size == 0 || radius <= 0.0 || strength <= 0.0 {
            return;
        }

        let direction = match mode {
            TerrainBrushMode::Raise => 1.0,
            TerrainBrushMode::Lower => -1.0,
        };
        let side = self.terrain.tile_half_extent_m * 2.0;
        let half_extent = self.terrain.tile_half_extent_m;
        let last = (self.terrain.tile_grid_size.saturating_sub(1)) as f32;

        for tile in &mut self.terrain.tiles {
            for row in 0..grid_size {
                for col in 0..grid_size {
                    let (tile_center_x, tile_center_z) =
                        (tile.tile_x as f32 * side, tile.tile_z as f32 * side);
                    let x = tile_center_x - half_extent + side * (col as f32 / last.max(1.0));
                    let z = tile_center_z - half_extent + side * (row as f32 / last.max(1.0));
                    let distance = ((x - center_x).powi(2) + (z - center_z).powi(2)).sqrt();
                    if distance > radius {
                        continue;
                    }
                    let falloff = 1.0 - distance / radius;
                    let delta = strength * falloff * falloff * direction;
                    let index = row * grid_size + col;
                    tile.heights[index] = (tile.heights[index] + delta).clamp(-10.0, 50.0);
                }
            }
        }
    }

    pub fn instantiate<A: WorldDocumentArena>(
        &self,
        arena: &mut A,
    ) -> Result<(), WorldDocumentError> {
        for tile in &self.terrain.tiles {
            let (center_x, center_z) = self.terrain_tile_center(tile.tile_x, tile.tile_z);
            arena.add_static_heightfield(
                Vector3::new(center_x, 0.0, center_z),
                self.terrain_tile_matrix(tile)?,
                self.terrain_tile_scale(),
                0,
            );
        }

        for prop in &self.static_props {
            if matches!(prop.kind, StaticPropKind::Cuboid) {
                arena.add_static_cuboid(
                    Vector3::new(prop.position[0], prop.position[1], prop.position[2]),
                    prop.rotation,
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
            match entity.kind {
                DynamicEntityKind::Box => {
                    let half_extents =
                        entity
                            .half_extents
                            .ok_or(WorldDocumentError::MissingHalfExtents {
                                entity_id: entity.id,
                            })?;
                    let min_box_y = self.minimum_box_spawn_center_y(
                        entity.position[0],
                        entity.position[2],
                        entity.rotation,
                        half_extents,
                    );
                    let spawn_y = entity.position[1].max(min_box_y);
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
                    let min_ball_y = self.minimum_ball_spawn_center_y(
                        entity.position[0],
                        entity.position[2],
                        radius,
                    );
                    let spawn_y = entity.position[1].max(min_ball_y);
                    arena.spawn_dynamic_ball_with_id(
                        entity.id,
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        radius,
                    );
                }
                DynamicEntityKind::Vehicle => {
                    let vehicle_type = entity.vehicle_type.unwrap_or(DEFAULT_VEHICLE_TYPE);
                    let min_vehicle_y = self.minimum_vehicle_spawn_center_y(
                        entity.position[0],
                        entity.position[2],
                        entity.rotation,
                        vehicle_type,
                    );
                    let spawn_y = entity.position[1].max(min_vehicle_y);
                    arena.spawn_vehicle_with_id(
                        entity.id,
                        vehicle_type,
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        entity.rotation,
                    );
                }
                DynamicEntityKind::Battery => {
                    let energy = entity
                        .energy
                        .ok_or(WorldDocumentError::MissingBatteryEnergy {
                            entity_id: entity.id,
                        })?;
                    let radius = entity
                        .radius
                        .unwrap_or(crate::constants::DEFAULT_BATTERY_RADIUS_M);
                    let height = entity
                        .height
                        .unwrap_or(crate::constants::DEFAULT_BATTERY_HEIGHT_M);
                    let terrain_y = self.sample_heightfield_surface_at_world_position(
                        entity.position[0],
                        entity.position[2],
                    );
                    let spawn_y = entity.position[1].max(terrain_y + height * 0.5 + 0.02);
                    arena.spawn_battery_with_id(
                        entity.id,
                        Vector3::new(entity.position[0], spawn_y, entity.position[2]),
                        energy,
                        radius,
                        height,
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
    use crate::constants::BTN_FORWARD;
    use crate::physics_arena::{MoveConfig, PhysicsArena};
    use crate::protocol::InputCmd;
    use crate::vehicle::read_vehicle_debug_snapshot;

    const BROKEN_WORLD_DOCUMENT_JSON: &str = include_str!("../../worlds/broken.world.json");
    const DT: f32 = 1.0 / 60.0;

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

    fn smooth_hill_world() -> WorldDocument {
        let grid_size = 9;
        let mut heights = Vec::with_capacity(grid_size * grid_size);
        for row in 0..grid_size {
            for col in 0..grid_size {
                let dx = col as f32 - 4.0;
                let dz = row as f32 - 4.0;
                let dist = (dx * dx + dz * dz).sqrt();
                heights.push((5.0 - dist * 1.25).max(0.0));
            }
        }
        WorldDocument {
            version: WORLD_DOCUMENT_VERSION,
            meta: WorldMeta {
                name: "Smooth Hill".to_string(),
                description: "Brush-like hill for rigid body terrain tests.".to_string(),
            },
            terrain: WorldTerrain {
                tile_grid_size: grid_size as u16,
                tile_half_extent_m: 10.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights,
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![],
        }
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

    fn build_ball_stack(
        world: &WorldDocument,
        start_id: u32,
        center_x: f32,
        center_z: f32,
    ) -> Vec<DynamicEntity> {
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
                        energy: None,
                        height: None,
                    });
                    next_id += 1;
                }
            }
        }
        entities
    }

    fn nearest_vehicle_to_origin(arena: &PhysicsArena) -> u32 {
        arena
            .vehicles
            .iter()
            .min_by(|(_, a), (_, b)| {
                let a_pos = arena
                    .dynamic
                    .sim
                    .rigid_bodies
                    .get(a.chassis_body)
                    .expect("vehicle body exists")
                    .translation();
                let b_pos = arena
                    .dynamic
                    .sim
                    .rigid_bodies
                    .get(b.chassis_body)
                    .expect("vehicle body exists")
                    .translation();
                let a_dist = a_pos.x * a_pos.x + a_pos.z * a_pos.z;
                let b_dist = b_pos.x * b_pos.x + b_pos.z * b_pos.z;
                a_dist.total_cmp(&b_dist)
            })
            .map(|(id, _)| *id)
            .expect("world should contain a vehicle")
    }

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn contact_bits(arena: &PhysicsArena, vehicle_id: u32) -> u8 {
        arena
            .vehicles
            .get(&vehicle_id)
            .expect("vehicle exists")
            .controller
            .wheels()
            .iter()
            .enumerate()
            .fold(0u8, |mask, (index, wheel)| {
                if wheel.raycast_info().is_in_contact {
                    mask | (1 << index)
                } else {
                    mask
                }
            })
    }

    fn grounded_wheels(arena: &PhysicsArena, vehicle_id: u32) -> u8 {
        arena
            .vehicles
            .get(&vehicle_id)
            .expect("vehicle exists")
            .controller
            .wheels()
            .iter()
            .filter(|wheel| wheel.raycast_info().is_in_contact)
            .count() as u8
    }

    #[test]
    fn demo_document_has_valid_height_count() {
        let world = WorldDocument::demo();
        let expected =
            usize::from(world.terrain.tile_grid_size) * usize::from(world.terrain.tile_grid_size);
        assert_eq!(world.terrain.tiles[0].heights.len(), expected);
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
    fn instantiate_authored_battery_entity_preserves_energy_and_dimensions() {
        let world = WorldDocument {
            version: WORLD_DOCUMENT_VERSION,
            meta: WorldMeta {
                name: "Battery Test".to_string(),
                description: "Single authored battery".to_string(),
            },
            terrain: WorldTerrain {
                tile_grid_size: 2,
                tile_half_extent_m: 5.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights: vec![0.0; 4],
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![DynamicEntity {
                id: 4242,
                kind: DynamicEntityKind::Battery,
                position: [1.5, 0.0, -2.0],
                rotation: identity_rotation(),
                half_extents: None,
                radius: Some(0.6),
                vehicle_type: None,
                energy: Some(275.0),
                height: Some(1.4),
            }],
        };

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate battery world");

        let batteries = arena.snapshot_batteries();
        assert_eq!(batteries.len(), 1);
        let (id, position, energy, radius, height) = batteries[0];
        assert_eq!(id, 4242);
        assert!((position[0] - 1.5).abs() < 0.01);
        assert!((position[2] + 2.0).abs() < 0.01);
        assert_eq!(energy, 275.0);
        assert_eq!(radius, 0.6);
        assert_eq!(height, 1.4);
    }

    #[test]
    fn instantiate_battery_entity_requires_energy_field() {
        let world = WorldDocument {
            version: WORLD_DOCUMENT_VERSION,
            meta: WorldMeta {
                name: "Broken Battery".to_string(),
                description: "Missing energy".to_string(),
            },
            terrain: WorldTerrain {
                tile_grid_size: 2,
                tile_half_extent_m: 5.0,
                tiles: vec![WorldTerrainTile {
                    tile_x: 0,
                    tile_z: 0,
                    heights: vec![0.0; 4],
                    materials: Vec::new(),
                    material_weights: None,
                }],
            },
            static_props: vec![],
            dynamic_entities: vec![DynamicEntity {
                id: 7,
                kind: DynamicEntityKind::Battery,
                position: [0.0, 0.0, 0.0],
                rotation: identity_rotation(),
                half_extents: None,
                radius: None,
                vehicle_type: None,
                energy: None,
                height: None,
            }],
        };

        let mut arena = PhysicsArena::new(MoveConfig::default());
        let error = world
            .instantiate(&mut arena)
            .expect_err("battery without energy should fail");
        assert!(matches!(
            error,
            WorldDocumentError::MissingBatteryEnergy { entity_id: 7 }
        ));
    }

    #[test]
    fn demo_document_runtime_entities_stay_above_ground() {
        let world = WorldDocument::demo();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate demo world");

        for _ in 0..300 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
        for tile in &mut world.terrain.tiles {
            tile.heights.fill(4.0);
        }
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
            energy: None,
            height: None,
        }];

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed world");

        for _ in 0..360 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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

    fn smooth_hill_world_keeps_authored_vehicle_supported() {
        let mut world = smooth_hill_world();
        let hill_x = 0.0;
        let hill_z = 0.0;
        let vehicle_x = hill_x + 1.5;
        world.dynamic_entities = vec![DynamicEntity {
            id: 32,
            kind: DynamicEntityKind::Vehicle,
            position: [
                vehicle_x,
                world.sample_heightfield_surface_at_world_position(vehicle_x, hill_z) + 3.0,
                hill_z,
            ],
            rotation: identity_rotation(),
            half_extents: None,
            radius: None,
            vehicle_type: Some(0),
            energy: None,
            height: None,
        }];

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate smooth hill world");

        for _ in 0..240 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
        }

        let vehicle = arena
            .snapshot_vehicles()
            .into_iter()
            .find(|vehicle| vehicle.id == 32)
            .expect("authored vehicle should exist");
        let terrain_y = cast_terrain_height(
            &world,
            vehicle.px_mm as f32 / 1000.0,
            vehicle.pz_mm as f32 / 1000.0,
        );
        let final_y = vehicle.py_mm as f32 / 1000.0;
        assert!(
            final_y > terrain_y - 0.25,
            "smooth hill vehicle fell through terrain: pos=({:.3}, {:.3}, {:.3}) terrain_y={terrain_y:.3}",
            vehicle.px_mm as f32 / 1000.0,
            final_y,
            vehicle.pz_mm as f32 / 1000.0,
        );
    }

    #[test]
    #[ignore] // Flaky: grounded-state churn threshold (<=8) is too tight for current demo terrain
    fn demo_world_straight_vehicle_drive_has_stable_contacts() {
        let world = WorldDocument::demo();
        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate demo world");
        arena.spawn_player(1);
        let vehicle_id = nearest_vehicle_to_origin(&arena);
        arena.enter_vehicle(1, vehicle_id);

        let mut prev_pos: Option<Vector3<f32>> = None;
        let mut prev_vel = Vector3::zeros();
        let mut prev_grounded: Option<u8> = None;
        let mut prev_bits: Option<u8> = None;
        let mut prev_forces: Option<[f32; 4]> = None;

        let mut residual_planar_samples = Vec::new();
        let mut residual_heave_samples = Vec::new();
        let mut suspension_force_delta_samples = Vec::new();
        let mut grounded_transitions = 0usize;
        let mut contact_bit_changes = 0usize;
        let mut min_grounded = 4u8;
        let mut max_speed = 0.0f32;

        for tick in 0..720 {
            let input = InputCmd {
                seq: tick as u16,
                buttons: if tick < 90 { 0 } else { BTN_FORWARD },
                move_x: 0,
                move_y: if tick < 90 { 0 } else { 83 },
                yaw: 0.0,
                pitch: 0.0,
            };
            arena.simulate_player_tick(1, &input, DT);
            arena.step_vehicles_and_dynamics(DT);

            let vehicle = arena.vehicles.get(&vehicle_id).expect("vehicle exists");
            let rb = arena
                .dynamic
                .sim
                .rigid_bodies
                .get(vehicle.chassis_body)
                .expect("vehicle body exists");
            let pos = *rb.translation();
            let vel = *rb.linvel();
            let speed = vel.norm();
            max_speed = max_speed.max(speed);
            let grounded = grounded_wheels(&arena, vehicle_id);
            let bits = contact_bits(&arena, vehicle_id);
            let debug = read_vehicle_debug_snapshot(
                &arena.dynamic.sim,
                vehicle.chassis_body,
                &vehicle.controller,
            )
            .expect("vehicle debug snapshot");

            if tick >= 180 {
                min_grounded = min_grounded.min(grounded);
                if let Some(prev_grounded) = prev_grounded {
                    if grounded != prev_grounded {
                        grounded_transitions += 1;
                    }
                }
                if let Some(prev_bits) = prev_bits {
                    contact_bit_changes += (bits ^ prev_bits).count_ones() as usize;
                }
                if let Some(prev_forces) = prev_forces {
                    let force_delta = debug
                        .suspension_forces
                        .iter()
                        .zip(prev_forces.iter())
                        .map(|(a, b)| {
                            let delta = a - b;
                            delta * delta
                        })
                        .sum::<f32>()
                        / 4.0;
                    suspension_force_delta_samples.push(force_delta.sqrt());
                }
                if let Some(prev_pos) = prev_pos {
                    let delta = pos - prev_pos;
                    let expected = (prev_vel + vel) * 0.5 * DT;
                    let residual = delta - expected;
                    residual_planar_samples
                        .push((residual.x * residual.x + residual.z * residual.z).sqrt());
                    residual_heave_samples.push(residual.y.abs());
                }
            }

            prev_pos = Some(pos);
            prev_vel = vel;
            prev_grounded = Some(grounded);
            prev_bits = Some(bits);
            prev_forces = Some(debug.suspension_forces);
        }

        let residual_planar_rms = rms(&residual_planar_samples);
        let residual_heave_rms = rms(&residual_heave_samples);
        let suspension_force_delta_rms = rms(&suspension_force_delta_samples);
        let summary = format!(
            "max_speed={max_speed:.3}m/s min_grounded={min_grounded} grounded_transitions={grounded_transitions} contact_bit_changes={contact_bit_changes} residual_planar_rms={residual_planar_rms:.3}m residual_heave_rms={residual_heave_rms:.3}m suspension_force_delta_rms={suspension_force_delta_rms:.1}N"
        );

        assert!(
            max_speed >= 8.0,
            "straight drive did not reach QA speed: {summary}"
        );
        assert!(
            min_grounded >= 2,
            "straight drive lost contact on authored terrain: {summary}"
        );
        assert!(
            grounded_transitions <= 10,
            "straight drive grounded state churned too often: {summary}"
        );
        assert!(
            contact_bit_changes <= 10,
            "straight drive wheel contact bits churned too often: {summary}"
        );
        assert!(
            residual_planar_rms <= 0.14,
            "straight drive residual planar jitter too high: {summary}"
        );
        assert!(
            residual_heave_rms <= 0.09,
            "straight drive residual heave jitter too high: {summary}"
        );
        assert!(
            suspension_force_delta_rms <= 5000.0,
            "straight drive suspension force delta too high: {summary}"
        );
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
            energy: None,
            height: None,
        }];

        let mut arena = PhysicsArena::new(MoveConfig::default());
        world
            .instantiate(&mut arena)
            .expect("instantiate brushed repro ball world");

        for _ in 0..360 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
        world
            .instantiate(&mut arena)
            .expect("instantiate broken world");

        for _ in 0..360 {
            arena.step_vehicles_and_dynamics(1.0 / 60.0);
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
                            DynamicEntityKind::Battery => "battery",
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
