use rapier3d::pipeline::{
    DebugColor, DebugRenderBackend, DebugRenderMode, DebugRenderObject, DebugRenderPipeline,
    DebugRenderStyle,
};
use rapier3d::prelude::{
    ColliderSet, ImpulseJointSet, MultibodyJointSet, NarrowPhase, Point, Real, RigidBodySet,
};

struct BufferBackend<'a> {
    vertices: &'a mut Vec<f32>,
    colors: &'a mut Vec<f32>,
}

impl<'a> DebugRenderBackend for BufferBackend<'a> {
    fn draw_line(
        &mut self,
        _object: DebugRenderObject,
        a: Point<Real>,
        b: Point<Real>,
        color: DebugColor,
    ) {
        self.vertices.extend_from_slice(&[
            a.x as f32, a.y as f32, a.z as f32, b.x as f32, b.y as f32, b.z as f32,
        ]);
        let rgb = debug_color_to_rgb(color);
        self.colors.extend_from_slice(&rgb);
        self.colors.extend_from_slice(&rgb);
    }
}

pub fn debug_mode_from_bits(mode_bits: u32) -> DebugRenderMode {
    DebugRenderMode::from_bits_truncate(mode_bits)
}

/// Renders debug lines into `vertices` and `colors`, clearing them first.
/// Colors are packed as RGB (3 f32 per endpoint), matching the vertices layout.
pub fn render_debug_buffers(
    pipeline: &mut DebugRenderPipeline,
    mode_bits: u32,
    bodies: &RigidBodySet,
    colliders: &ColliderSet,
    impulse_joints: &ImpulseJointSet,
    multibody_joints: &MultibodyJointSet,
    narrow_phase: &NarrowPhase,
    vertices: &mut Vec<f32>,
    colors: &mut Vec<f32>,
) {
    vertices.clear();
    colors.clear();
    pipeline.mode = debug_mode_from_bits(mode_bits);
    let mut backend = BufferBackend { vertices, colors };
    pipeline.render(
        &mut backend,
        bodies,
        colliders,
        impulse_joints,
        multibody_joints,
        narrow_phase,
    );
}

pub fn default_debug_pipeline() -> DebugRenderPipeline {
    DebugRenderPipeline::new(DebugRenderStyle::default(), DebugRenderMode::default())
}

fn debug_color_to_rgb(color: DebugColor) -> [f32; 3] {
    let hue = color[0].rem_euclid(360.0) / 360.0;
    let saturation = color[1].clamp(0.0, 1.0);
    let lightness = color[2].clamp(0.0, 1.0);

    if saturation <= f32::EPSILON {
        return [lightness, lightness, lightness];
    }

    let q = if lightness < 0.5 {
        lightness * (1.0 + saturation)
    } else {
        lightness + saturation - lightness * saturation
    };
    let p = 2.0 * lightness - q;

    [
        hue_to_rgb(p, q, hue + 1.0 / 3.0),
        hue_to_rgb(p, q, hue),
        hue_to_rgb(p, q, hue - 1.0 / 3.0),
    ]
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }

    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 1.0 / 2.0 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::vector;
    use vibe_netcode::physics_arena::DynamicArena;

    use crate::movement::MoveConfig;

    #[test]
    fn hsla_conversion_matches_primary_red() {
        let rgb = debug_color_to_rgb([0.0, 1.0, 0.5, 1.0]);
        assert!((rgb[0] - 1.0).abs() < 1e-5);
        assert!(rgb[1].abs() < 1e-5);
        assert!(rgb[2].abs() < 1e-5);
    }

    #[test]
    fn collider_shape_render_produces_vertices_and_rgb_colors() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![10.0, 0.5, 10.0], 0);
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        arena.step_dynamics(1.0 / 60.0);

        let mut pipeline = default_debug_pipeline();
        let mut vertices = Vec::new();
        let mut colors = Vec::new();
        render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::COLLIDER_SHAPES.bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            &mut vertices,
            &mut colors,
        );

        assert!(!vertices.is_empty(), "expected collider debug vertices");
        assert_eq!(vertices.len() % 3, 0);
        // RGB packing: colors.len() == vertices.len() (3 floats per endpoint)
        assert_eq!(colors.len(), vertices.len());
        assert!(vertices.iter().all(|v| v.is_finite()));
        assert!(colors.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn destructible_only_mode_filters_correctly() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![20.0, 0.5, 20.0], 0);
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        arena.step_dynamics(1.0 / 60.0);

        let mut pipeline = default_debug_pipeline();
        let mut vertices_shapes = Vec::new();
        let mut colors_shapes = Vec::new();
        render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::COLLIDER_SHAPES.bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            &mut vertices_shapes,
            &mut colors_shapes,
        );

        // Render with no bits set — should produce no output
        let mut vertices_none = Vec::new();
        let mut colors_none = Vec::new();
        render_debug_buffers(
            &mut pipeline,
            0,
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            &mut vertices_none,
            &mut colors_none,
        );

        assert!(!vertices_shapes.is_empty(), "shapes mode should produce lines");
        assert!(vertices_none.is_empty(), "mode=0 should produce no lines");
    }

    #[test]
    fn full_debug_render_returns_finite_buffers() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![20.0, 0.5, 20.0], 0);
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        for _ in 0..30 {
            arena.step_dynamics(1.0 / 60.0);
        }

        let mut pipeline = default_debug_pipeline();
        let mut vertices = Vec::new();
        let mut colors = Vec::new();
        render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::all().bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            &mut vertices,
            &mut colors,
        );

        assert!(!vertices.is_empty(), "expected some debug output");
        assert!(vertices.iter().all(|v| v.is_finite()));
        assert!(colors.iter().all(|v| v.is_finite()));
    }
}
