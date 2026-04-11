use nalgebra::{vector, DMatrix, Vector3};

pub const DEMO_TERRAIN_GRID_SIZE: usize = 129;
pub const DEMO_TERRAIN_HALF_EXTENT_M: f32 = 80.0;

pub const DEMO_BALL_PIT_X: f32 = 8.0;
pub const DEMO_BALL_PIT_Z: f32 = 8.0;
pub const DEMO_BALL_PIT_WIDTH_M: f32 = 8.0;
pub const DEMO_BALL_PIT_DEPTH_M: f32 = 8.0;
pub const DEMO_BALL_PIT_WALL_HEIGHT_M: f32 = 3.0;
pub const DEMO_BALL_PIT_WALL_THICKNESS_M: f32 = 0.35;

const DEMO_TERRAIN_FLAT_CENTER_X: f32 = 10.0;
const DEMO_TERRAIN_FLAT_CENTER_Z: f32 = 8.0;
const DEMO_TERRAIN_FLAT_RADIUS_M: f32 = 16.0;
const DEMO_TERRAIN_BLEND_RADIUS_M: f32 = 28.0;

pub fn sample_demo_terrain_height(x: f32, z: f32) -> f32 {
    let base = 0.55 * (x * 0.05).sin()
        + 0.35 * (z * 0.07).cos()
        + 0.18 * ((x + z) * 0.035).sin()
        + 0.12 * ((x - z) * 0.08).cos();

    let dx = x - DEMO_TERRAIN_FLAT_CENTER_X;
    let dz = z - DEMO_TERRAIN_FLAT_CENTER_Z;
    let dist = (dx * dx + dz * dz).sqrt();
    let blend = smoothstep(DEMO_TERRAIN_FLAT_RADIUS_M, DEMO_TERRAIN_BLEND_RADIUS_M, dist);
    (base * blend).clamp(-1.0, 1.0)
}

pub fn build_demo_heightfield() -> (DMatrix<f32>, Vector3<f32>) {
    let side = DEMO_TERRAIN_HALF_EXTENT_M * 2.0;
    let last = (DEMO_TERRAIN_GRID_SIZE - 1) as f32;
    let mut heights = DMatrix::zeros(DEMO_TERRAIN_GRID_SIZE, DEMO_TERRAIN_GRID_SIZE);

    for row in 0..DEMO_TERRAIN_GRID_SIZE {
        let z = -DEMO_TERRAIN_HALF_EXTENT_M + side * (row as f32 / last);
        for col in 0..DEMO_TERRAIN_GRID_SIZE {
            let x = -DEMO_TERRAIN_HALF_EXTENT_M + side * (col as f32 / last);
            heights[(row, col)] = sample_demo_terrain_height(x, z);
        }
    }

    (heights, vector![side, 1.0, side])
}

pub fn demo_ball_pit_wall_cuboids() -> [(Vector3<f32>, Vector3<f32>); 3] {
    let wall_half_h = DEMO_BALL_PIT_WALL_HEIGHT_M * 0.5;
    let wall_thickness = DEMO_BALL_PIT_WALL_THICKNESS_M;
    [
        (
            vector![
                DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M * 0.5 - 0.5,
                wall_half_h,
                DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M - 0.5
            ],
            vector![DEMO_BALL_PIT_WIDTH_M * 0.5, wall_half_h, wall_thickness],
        ),
        (
            vector![
                DEMO_BALL_PIT_X,
                wall_half_h,
                DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5 - 0.5
            ],
            vector![wall_thickness, wall_half_h, DEMO_BALL_PIT_DEPTH_M * 0.5],
        ),
        (
            vector![
                DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M - 1.0,
                wall_half_h,
                DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5 - 0.5
            ],
            vector![wall_thickness, wall_half_h, DEMO_BALL_PIT_DEPTH_M * 0.5],
        ),
    ]
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge1 <= edge0 {
        return 1.0;
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_terrain_stays_subtle() {
        let mut min_height = f32::INFINITY;
        let mut max_height = f32::NEG_INFINITY;
        for row in 0..DEMO_TERRAIN_GRID_SIZE {
            for col in 0..DEMO_TERRAIN_GRID_SIZE {
                let x = -DEMO_TERRAIN_HALF_EXTENT_M
                    + (DEMO_TERRAIN_HALF_EXTENT_M * 2.0) * (col as f32 / (DEMO_TERRAIN_GRID_SIZE - 1) as f32);
                let z = -DEMO_TERRAIN_HALF_EXTENT_M
                    + (DEMO_TERRAIN_HALF_EXTENT_M * 2.0) * (row as f32 / (DEMO_TERRAIN_GRID_SIZE - 1) as f32);
                let h = sample_demo_terrain_height(x, z);
                min_height = min_height.min(h);
                max_height = max_height.max(h);
            }
        }
        assert!(min_height >= -1.01, "terrain min too low: {min_height}");
        assert!(max_height <= 1.01, "terrain max too high: {max_height}");
    }

    #[test]
    fn pit_area_stays_flat() {
        let center_x = DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M * 0.5;
        let center_z = DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5;
        let samples = [
            (center_x, center_z),
            (DEMO_BALL_PIT_X + 1.0, DEMO_BALL_PIT_Z + 1.0),
            (
                DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M - 1.0,
                DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M - 1.0,
            ),
            (0.0, 0.0),
            (14.0, 0.0),
        ];
        for (x, z) in samples {
            let h = sample_demo_terrain_height(x, z);
            assert!(h.abs() <= 0.05, "expected flat terrain near ({x}, {z}), got {h}");
        }
    }
}
