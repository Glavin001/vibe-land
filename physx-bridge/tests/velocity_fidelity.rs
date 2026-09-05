#![cfg(feature = "gpu")]

use vibe_land_physx_bridge::{DynamicBoxDesc, Pose, Quat, Vec3, World, WorldConfig};

#[test]
fn torque_impulses_preserve_spin_above_the_physx_default_ceiling() {
    for speed in [50.0_f32, 500.0, -500.0] {
        let mut world = World::new(WorldConfig {
            gravity: Vec3::new(0.0, 0.0, 0.0),
            ..WorldConfig::default()
        })
        .expect("real GPU scene");
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: 1,
                user_id: 1,
                pose: Pose {
                    position: Vec3::new(0.0, 20.0, 0.0),
                    rotation: Quat::IDENTITY,
                },
                half_extents: Vec3::new(0.5, 0.5, 0.5),
                mass: 1.0,
                collision_group: 1,
                collision_mask: u32::MAX,
            })
            .unwrap();
        // Exercise commands after Direct GPU initialization as well as creation.
        world.step().unwrap();
        // Opposed impulses have zero net force and angular impulse I*omega.
        // The unit cube has Izz = m*(width^2 + height^2)/12 = 1/6.
        let impulse = speed / 6.0;
        for sign in [-1.0_f32, 1.0] {
            world
                .apply_impulse_at_point(
                    1,
                    Vec3::new(0.0, sign * impulse, 0.0),
                    Vec3::new(sign * 0.5, 20.0, 0.0),
                )
                .unwrap();
        }
        let mut expected = speed;
        for tick in 1..=12 {
            world.step().unwrap();
            // Account explicitly for this body's existing 0.5/s angular damping.
            // No contact or physical torque acts during the subsequent coast.
            expected *= 1.0 - 0.5 / 60.0;
            let body = world.body_snapshots().unwrap()[0];
            assert!(
                (body.angular_velocity.z - expected).abs() < 0.05,
                "speed={speed} tick={tick}: expected {expected}, measured {:?}",
                body.angular_velocity
            );
            assert!(body.linear_velocity.x.abs() < 1.0e-5);
            assert!(body.linear_velocity.y.abs() < 1.0e-5);
            assert!(body.linear_velocity.z.abs() < 1.0e-5);
            assert!(body.pose.rotation.x.is_finite());
            assert!(body.pose.rotation.y.is_finite());
            assert!(body.pose.rotation.z.is_finite());
            assert!(body.pose.rotation.w.is_finite());
        }
    }
}
