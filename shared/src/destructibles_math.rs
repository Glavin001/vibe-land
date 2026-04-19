use nalgebra::Vector3;

use crate::world_document::DestructibleKind;

pub const DEFAULT_WALL_MATERIAL_SCALE: f32 = 10.0;
pub const DEFAULT_TOWER_MATERIAL_SCALE: f32 = 10.0;
pub const USER_MATERIAL_SCALE_REFERENCE: f32 = 10.0;
pub const SOLVER_MATERIAL_SCALE_REFERENCE: f32 = 10_000.0;
pub const USER_TO_SOLVER_SCALE_EXPONENT: f32 = 6.0;
pub const WALL_AUTHORED_Y_TO_SOLVER_Y_OFFSET_M: f32 = 0.5;
pub const TOWER_AUTHORED_Y_TO_SOLVER_Y_OFFSET_M: f32 = 0.25;

pub fn effective_solver_material_scale(material_scale: f32) -> f32 {
    let clamped = material_scale.max(0.0);
    if clamped <= 0.0 {
        return 0.0;
    }
    SOLVER_MATERIAL_SCALE_REFERENCE
        * (clamped / USER_MATERIAL_SCALE_REFERENCE).powf(USER_TO_SOLVER_SCALE_EXPONENT)
}

pub fn authored_position_to_solver_position(
    kind: DestructibleKind,
    position: [f32; 3],
) -> [f32; 3] {
    let y = position[1]
        - match kind {
            DestructibleKind::Wall => WALL_AUTHORED_Y_TO_SOLVER_Y_OFFSET_M,
            DestructibleKind::Tower => TOWER_AUTHORED_Y_TO_SOLVER_Y_OFFSET_M,
        };
    [position[0], y, position[2]]
}

pub fn relative_speed_along_force(
    force_world: Vector3<f32>,
    relative_velocity: Vector3<f32>,
) -> f32 {
    if force_world.norm_squared() <= 1.0e-12 {
        return relative_velocity.norm();
    }
    let direction = force_world.normalize();
    let projected = relative_velocity.dot(&direction).abs();
    if projected > 1.0e-5 {
        projected
    } else {
        relative_velocity.norm()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_authoring_buries_support_row() {
        let solver = authored_position_to_solver_position(DestructibleKind::Wall, [0.0, 0.0, 8.0]);
        assert_eq!(solver, [0.0, -0.5, 8.0]);
    }

    #[test]
    fn tower_authoring_buries_support_row() {
        let solver =
            authored_position_to_solver_position(DestructibleKind::Tower, [10.0, 0.5, -5.0]);
        assert_eq!(solver, [10.0, 0.25, -5.0]);
    }

    #[test]
    fn solver_scale_curve_keeps_reference_point_and_reaches_demo_scale() {
        assert_eq!(
            effective_solver_material_scale(USER_MATERIAL_SCALE_REFERENCE),
            SOLVER_MATERIAL_SCALE_REFERENCE
        );
        assert_eq!(effective_solver_material_scale(0.0), 0.0);
        assert_eq!(effective_solver_material_scale(100.0), 10_000_000_000.0);
    }

    #[test]
    fn relative_speed_prefers_projection_along_force_direction() {
        let force = Vector3::new(10.0, 0.0, 0.0);
        let relative_velocity = Vector3::new(2.0, 3.0, 0.0);
        assert!((relative_speed_along_force(force, relative_velocity) - 2.0).abs() < 1.0e-6);
    }

    #[test]
    fn relative_speed_falls_back_to_magnitude_when_force_is_zero() {
        let relative_velocity = Vector3::new(2.0, 3.0, 6.0);
        let expected = relative_velocity.norm();
        assert!(
            (relative_speed_along_force(Vector3::zeros(), relative_velocity) - expected).abs()
                < 1.0e-6
        );
    }
}
