//! Read-only collision queries for bounded browser vehicle presentation.
//! Dynamic gameplay contacts remain authoritative; cosmetic bodies are excluded.
use crate::simulation::SimWorld;
use rapier3d::parry::query::ShapeCastOptions;
use rapier3d::prelude::*;

pub fn sweep_static(
    sim: &SimWorld,
    pose: Isometry<f32>,
    delta: Vector<f32>,
    half_extents: Vector<f32>,
    radius: f32,
) -> Option<[f32; 4]> {
    if !pose
        .translation
        .vector
        .iter()
        .chain(delta.iter())
        .chain(half_extents.iter())
        .all(|v| v.is_finite())
        || half_extents.iter().any(|v| *v <= 0.0)
        || !radius.is_finite()
    {
        return None;
    }
    let queries = sim.broad_phase.as_query_pipeline(
        sim.narrow_phase.query_dispatcher(),
        &sim.rigid_bodies,
        &sim.colliders,
        QueryFilter::only_fixed().exclude_sensors(),
    );
    let shape = if radius > 0.0 {
        SharedShape::ball(radius)
    } else {
        SharedShape::cuboid(half_extents.x, half_extents.y, half_extents.z)
    };
    let (handle, hit) = queries.cast_shape(
        &pose,
        &delta,
        shape.as_ref(),
        ShapeCastOptions {
            max_time_of_impact: 1.0,
            target_distance: 0.002,
            stop_at_penetration: false,
            compute_impact_geometry_on_penetration: true,
        },
    )?;
    let mut normal = *hit.normal1;
    // An approximate wheel/chassis may initially overlap a heightfield because
    // Vehicle2 suspension compression differs from its neutral browser proxy.
    // GJK's t=0 separating normal can then point opposite travel (a fake wall).
    // Recover the actual terrain normal instead of blocking horizontal motion.
    if hit.time_of_impact == 0.0 {
        let collider = &sim.colliders[handle];
        if collider.shape().as_heightfield().is_some() {
            let p = pose.translation.vector;
            let ray = Ray::new(
                point![p.x, p.y + half_extents.y + radius.max(0.0) + 1.0, p.z],
                vector![0.0, -1.0, 0.0],
            );
            if let Some(surface) =
                collider
                    .shape()
                    .cast_ray_and_get_normal(collider.position(), &ray, 100.0, true)
            {
                normal = surface.normal;
            }
        }
    }
    Some([hit.time_of_impact, normal.x, normal.y, normal.z])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movement::MoveConfig;
    use nalgebra::vector;

    #[test]
    fn sweeps_stop_fast_falls_and_walls_but_leave_gaps_open() {
        let mut sim = SimWorld::new(MoveConfig::default());
        sim.add_static_cuboid(vector![0., -0.5, 0.], vector![5., 0.5, 5.], 1);
        sim.add_static_cuboid(vector![4., 2., 0.], vector![0.1, 2., 5.], 2);
        sim.rebuild_broad_phase();
        let hit = sweep_static(
            &sim,
            Isometry::translation(0., 4., 0.),
            vector![0., -10., 0.],
            vector![1., 0.3, 2.],
            0.4,
        )
        .unwrap();
        assert!((hit[0] - 0.3598).abs() < 0.001);
        assert!(hit[2] > 0.99);
        let wall = sweep_static(
            &sim,
            Isometry::translation(0., 2., 0.),
            vector![10., 0., 0.],
            vector![1., 0.3, 2.],
            0.,
        )
        .unwrap();
        assert!((wall[0] - 0.2898).abs() < 0.001);
        assert!(wall[1] < -0.99);
        assert!(sweep_static(
            &sim,
            Isometry::translation(10., 4., 0.),
            vector![0., -10., 0.],
            vector![1., 0.3, 2.],
            0.4
        )
        .is_none());
    }

    #[test]
    fn overlapping_heightfield_proxy_keeps_the_terrain_normal() {
        let mut sim = SimWorld::new(MoveConfig::default());
        let heights = nalgebra::DMatrix::from_fn(9, 9, |row, _col| row as f32 * 0.1);
        sim.add_static_heightfield(vector![0., 0., 0.], heights, vector![8., 1., 8.], 0);
        sim.rebuild_broad_phase();
        let hit = sweep_static(
            &sim,
            Isometry::translation(0., 0.65, 0.),
            vector![0., 0., 0.2],
            vector![1., 0.3, 2.],
            0.35,
        )
        .unwrap();
        assert_eq!(hit[0], 0.0);
        assert!(
            hit[2] > 0.9,
            "overlap must report the surface, not a wall: {hit:?}"
        );
    }

    #[test]
    fn queries_respect_sloped_geometry_and_ignore_cosmetic_dynamic_bodies() {
        let mut sim = SimWorld::new(MoveConfig::default());
        let angle = 0.3f32;
        sim.add_static_cuboid_rotated(
            vector![0., 0., 0.],
            [0., 0., (angle / 2.).sin(), (angle / 2.).cos()],
            vector![5., 0.1, 5.],
            1,
        );
        let body = sim
            .rigid_bodies
            .insert(RigidBodyBuilder::dynamic().translation(vector![0., 3., 0.]));
        sim.colliders
            .insert_with_parent(ColliderBuilder::ball(1.), body, &mut sim.rigid_bodies);
        sim.rebuild_broad_phase();
        let hit = sweep_static(
            &sim,
            Isometry::translation(0., 5., 0.),
            vector![0., -10., 0.],
            vector![1., 1., 1.],
            0.4,
        )
        .unwrap();
        assert!(hit[0] > 0.4, "must skip the dynamic sphere");
        assert!((hit[1] + angle.sin()).abs() < 0.01);
        assert!((hit[2] - angle.cos()).abs() < 0.01);
    }
}
