use rapier3d::pipeline::{
    DebugColor, DebugRenderBackend, DebugRenderMode, DebugRenderObject, DebugRenderPipeline,
    DebugRenderStyle,
};
use rapier3d::prelude::{
    ColliderSet, ImpulseJointSet, MultibodyJointSet, NarrowPhase, Point, Real, RigidBodySet,
};

#[derive(Clone, Debug, Default)]
pub struct DebugLineBuffers {
    pub vertices: Vec<f32>,
    pub colors: Vec<f32>,
}

struct BufferBackend {
    vertices: Vec<f32>,
    colors: Vec<f32>,
}

impl BufferBackend {
    fn new() -> Self {
        Self {
            vertices: Vec::new(),
            colors: Vec::new(),
        }
    }

    fn finish(self) -> DebugLineBuffers {
        DebugLineBuffers {
            vertices: self.vertices,
            colors: self.colors,
        }
    }
}

impl DebugRenderBackend for BufferBackend {
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
        let rgba = debug_color_to_rgba(color);
        self.colors.extend_from_slice(&rgba);
        self.colors.extend_from_slice(&rgba);
    }
}

pub fn debug_mode_from_bits(mode_bits: u32) -> DebugRenderMode {
    DebugRenderMode::from_bits_truncate(mode_bits)
}

pub fn render_debug_buffers(
    pipeline: &mut DebugRenderPipeline,
    mode_bits: u32,
    bodies: &RigidBodySet,
    colliders: &ColliderSet,
    impulse_joints: &ImpulseJointSet,
    multibody_joints: &MultibodyJointSet,
    narrow_phase: &NarrowPhase,
) -> DebugLineBuffers {
    pipeline.mode = debug_mode_from_bits(mode_bits);
    let mut backend = BufferBackend::new();
    pipeline.render(
        &mut backend,
        bodies,
        colliders,
        impulse_joints,
        multibody_joints,
        narrow_phase,
    );
    backend.finish()
}

pub fn default_debug_pipeline() -> DebugRenderPipeline {
    DebugRenderPipeline::new(DebugRenderStyle::default(), DebugRenderMode::default())
}

fn debug_color_to_rgba(color: DebugColor) -> [f32; 4] {
    let hue = color[0].rem_euclid(360.0) / 360.0;
    let saturation = color[1].clamp(0.0, 1.0);
    let lightness = color[2].clamp(0.0, 1.0);
    let alpha = color[3].clamp(0.0, 1.0);

    if saturation <= f32::EPSILON {
        return [lightness, lightness, lightness, alpha];
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
        alpha,
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
        let rgba = debug_color_to_rgba([0.0, 1.0, 0.5, 1.0]);
        assert!((rgba[0] - 1.0).abs() < 1e-5);
        assert!(rgba[1].abs() < 1e-5);
        assert!(rgba[2].abs() < 1e-5);
        assert!((rgba[3] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn collider_shape_render_produces_vertices_and_rgba_colors() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.add_static_cuboid(vector![0.0, -0.5, 0.0], vector![10.0, 0.5, 10.0], 0);
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        arena.step_dynamics(1.0 / 60.0);

        let mut pipeline = default_debug_pipeline();
        let buffers = render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::COLLIDER_SHAPES.bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
        );

        assert!(
            !buffers.vertices.is_empty(),
            "expected collider debug vertices"
        );
        assert_eq!(buffers.vertices.len() % 3, 0);
        assert_eq!(buffers.colors.len(), (buffers.vertices.len() / 3) * 4);
        assert!(buffers.vertices.iter().all(|v| v.is_finite()));
        assert!(buffers.colors.iter().all(|v| v.is_finite()));
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
        let buffers = render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::all().bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
        );

        assert!(!buffers.vertices.is_empty(), "expected some debug output");
        assert!(buffers.vertices.iter().all(|v| v.is_finite()));
        assert!(buffers.colors.iter().all(|v| v.is_finite()));
    }
}
