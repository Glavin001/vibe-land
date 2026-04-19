use std::collections::HashSet;

use rapier3d::pipeline::{
    DebugColor, DebugRenderBackend, DebugRenderMode, DebugRenderObject, DebugRenderPipeline,
    DebugRenderStyle,
};
use rapier3d::prelude::{
    ColliderSet, ImpulseJointSet, MultibodyJointSet, NarrowPhase, Point, Real, RigidBodyHandle,
    RigidBodySet,
};

pub const DESTRUCTIBLE_BODY_GROUPS_MODE_BIT: u32 = 1 << 30;

#[derive(Clone, Debug, Default)]
pub struct DebugLineBuffers {
    pub vertices: Vec<f32>,
    pub colors: Vec<f32>,
}

struct BufferBackend<'a> {
    vertices: Vec<f32>,
    colors: Vec<f32>,
    destructible_body_handles: Option<&'a HashSet<RigidBodyHandle>>,
    filter_to_destructible_body_groups: bool,
}

impl<'a> BufferBackend<'a> {
    fn new(
        destructible_body_handles: Option<&'a HashSet<RigidBodyHandle>>,
        filter_to_destructible_body_groups: bool,
    ) -> Self {
        Self {
            vertices: Vec::new(),
            colors: Vec::new(),
            destructible_body_handles,
            filter_to_destructible_body_groups,
        }
    }

    fn finish(self) -> DebugLineBuffers {
        DebugLineBuffers {
            vertices: self.vertices,
            colors: self.colors,
        }
    }
}

impl DebugRenderBackend for BufferBackend<'_> {
    fn filter_object(&self, object: DebugRenderObject) -> bool {
        if !self.filter_to_destructible_body_groups {
            return true;
        }
        let Some(body_handles) = self.destructible_body_handles else {
            return true;
        };
        match object {
            DebugRenderObject::Collider(_, collider)
            | DebugRenderObject::ColliderAabb(_, collider, _) => collider
                .parent()
                .is_some_and(|handle| body_handles.contains(&handle)),
            _ => false,
        }
    }

    fn draw_line(
        &mut self,
        object: DebugRenderObject,
        a: Point<Real>,
        b: Point<Real>,
        color: DebugColor,
    ) {
        self.vertices.extend_from_slice(&[
            a.x as f32, a.y as f32, a.z as f32, b.x as f32, b.y as f32, b.z as f32,
        ]);
        let rgba = object_body_handle(object)
            .filter(|handle| {
                self.destructible_body_handles
                    .is_some_and(|body_handles| body_handles.contains(handle))
            })
            .map(debug_body_color_rgba)
            .unwrap_or_else(|| debug_color_to_rgba(color));
        self.colors.extend_from_slice(&rgba);
        self.colors.extend_from_slice(&rgba);
    }
}

pub fn debug_mode_from_bits(mode_bits: u32) -> DebugRenderMode {
    DebugRenderMode::from_bits_truncate(mode_bits & !DESTRUCTIBLE_BODY_GROUPS_MODE_BIT)
}

pub fn render_debug_buffers(
    pipeline: &mut DebugRenderPipeline,
    mode_bits: u32,
    bodies: &RigidBodySet,
    colliders: &ColliderSet,
    impulse_joints: &ImpulseJointSet,
    multibody_joints: &MultibodyJointSet,
    narrow_phase: &NarrowPhase,
    destructible_body_handles: Option<&HashSet<RigidBodyHandle>>,
) -> DebugLineBuffers {
    let destructible_groups_only = (mode_bits & DESTRUCTIBLE_BODY_GROUPS_MODE_BIT) != 0;
    pipeline.mode = if destructible_groups_only {
        DebugRenderMode::COLLIDER_SHAPES
    } else {
        debug_mode_from_bits(mode_bits)
    };
    let mut backend = BufferBackend::new(destructible_body_handles, destructible_groups_only);
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

fn object_body_handle(object: DebugRenderObject<'_>) -> Option<RigidBodyHandle> {
    match object {
        DebugRenderObject::RigidBody(handle, _) => Some(handle),
        DebugRenderObject::Collider(_, collider)
        | DebugRenderObject::ColliderAabb(_, collider, _) => collider.parent(),
        _ => None,
    }
}

fn debug_body_color_rgba(handle: RigidBodyHandle) -> [f32; 4] {
    let (index, generation) = handle.into_raw_parts();
    let mixed = index
        .wrapping_mul(0x9e37_79b1)
        .wrapping_add(generation.wrapping_mul(0x85eb_ca6b));
    const DEBUG_BODY_PALETTE: [[f32; 4]; 12] = [
        [0.98, 0.25, 0.27, 1.0],
        [0.10, 0.78, 0.98, 1.0],
        [0.99, 0.82, 0.18, 1.0],
        [0.34, 0.96, 0.38, 1.0],
        [0.84, 0.36, 0.99, 1.0],
        [1.00, 0.53, 0.13, 1.0],
        [0.16, 0.96, 0.78, 1.0],
        [0.99, 0.29, 0.68, 1.0],
        [0.72, 0.98, 0.22, 1.0],
        [0.31, 0.55, 1.00, 1.0],
        [1.00, 0.18, 0.57, 1.0],
        [0.65, 0.48, 1.00, 1.0],
    ];
    DEBUG_BODY_PALETTE[(mixed as usize) % DEBUG_BODY_PALETTE.len()]
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
            None,
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
            None,
        );

        assert!(!buffers.vertices.is_empty(), "expected some debug output");
        assert!(buffers.vertices.iter().all(|v| v.is_finite()));
        assert!(buffers.colors.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn destructible_groups_mode_filters_to_selected_body_and_uses_stable_color() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.spawn_dynamic_box(vector![3.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        arena.step_dynamics(1.0 / 60.0);

        let mut body_handles = arena
            .sim
            .rigid_bodies
            .iter()
            .map(|(handle, _)| handle)
            .collect::<Vec<_>>();
        body_handles.sort_by_key(|handle| {
            let (index, generation) = handle.into_raw_parts();
            (index, generation)
        });
        let selected_body = *body_handles
            .first()
            .expect("expected at least one dynamic body");

        let mut handles = HashSet::new();
        handles.insert(selected_body);

        let mut pipeline = default_debug_pipeline();
        let filtered = render_debug_buffers(
            &mut pipeline,
            DESTRUCTIBLE_BODY_GROUPS_MODE_BIT,
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            Some(&handles),
        );

        let mut full_pipeline = default_debug_pipeline();
        let unfiltered = render_debug_buffers(
            &mut full_pipeline,
            DebugRenderMode::COLLIDER_SHAPES.bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            None,
        );

        assert!(
            !filtered.vertices.is_empty(),
            "expected selected-body lines"
        );
        assert!(filtered.vertices.len() < unfiltered.vertices.len());
        assert_eq!(filtered.colors.len(), (filtered.vertices.len() / 3) * 4);

        let expected = debug_body_color_rgba(selected_body);
        for rgba in filtered.colors.chunks_exact(4) {
            assert!((rgba[0] - expected[0]).abs() < 1.0e-6);
            assert!((rgba[1] - expected[1]).abs() < 1.0e-6);
            assert!((rgba[2] - expected[2]).abs() < 1.0e-6);
            assert!((rgba[3] - expected[3]).abs() < 1.0e-6);
        }
    }

    #[test]
    fn full_mode_keeps_destructible_body_colors_when_handles_are_supplied() {
        let mut arena = DynamicArena::new(MoveConfig::default());
        arena.spawn_dynamic_box(vector![0.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.spawn_dynamic_box(vector![3.0, 2.0, 0.0], vector![0.5, 0.5, 0.5]);
        arena.rebuild_broad_phase();
        arena.step_dynamics(1.0 / 60.0);

        let mut body_handles = arena
            .sim
            .rigid_bodies
            .iter()
            .map(|(handle, _)| handle)
            .collect::<Vec<_>>();
        body_handles.sort_by_key(|handle| {
            let (index, generation) = handle.into_raw_parts();
            (index, generation)
        });
        let selected_body = *body_handles
            .first()
            .expect("expected at least one dynamic body");

        let mut handles = HashSet::new();
        handles.insert(selected_body);

        let mut pipeline = default_debug_pipeline();
        let buffers = render_debug_buffers(
            &mut pipeline,
            DebugRenderMode::all().bits(),
            &arena.sim.rigid_bodies,
            &arena.sim.colliders,
            &arena.impulse_joints,
            &arena.multibody_joints,
            &arena.sim.narrow_phase,
            Some(&handles),
        );

        assert!(
            !buffers.vertices.is_empty(),
            "expected full-mode debug output"
        );
        let expected = debug_body_color_rgba(selected_body);
        assert!(
            buffers.colors.chunks_exact(4).any(|rgba| {
                (rgba[0] - expected[0]).abs() < 1.0e-6
                    && (rgba[1] - expected[1]).abs() < 1.0e-6
                    && (rgba[2] - expected[2]).abs() < 1.0e-6
                    && (rgba[3] - expected[3]).abs() < 1.0e-6
            }),
            "expected highlighted destructible body color to appear in full mode",
        );
    }
}
