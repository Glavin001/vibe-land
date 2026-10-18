#![cfg(feature = "native-destruction")]
//! End-to-end contact kinematics through the actual GPU callback and deferred
//! drain. Run serially on Metal/CUDA with the native PhysX SDK installed.
use vibe_land_physx_bridge::{DynamicBoxDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig};

#[test]
fn contact_audio_distinguishes_impact_slide_and_rest() {
    let mut config = WorldConfig::default();
    config.gpu_max_rigid_contacts = 65536;
    config.gpu_max_rigid_patches = 65536;
    config.gpu_heap_capacity = 64 * 1024 * 1024;
    config.gpu_collision_stack_size = 16 * 1024 * 1024;
    config.gpu_found_lost_pairs_capacity = 65536;
    config.gpu_found_lost_aggregate_pairs_capacity = 65536;
    config.gpu_total_aggregate_pairs_capacity = 65536;
    let mut world = World::new(config).expect("real GPU world");
    world.add_static_box(StaticBoxDesc { entity_id: 1, user_id: 1, pose: Pose { position: Vec3::new(0.,-0.5,0.), rotation: Quat::IDENTITY }, half_extents: Vec3::new(20.,0.5,20.), collision_group: 1, collision_mask: u32::MAX }).unwrap();
    world.add_dynamic_box(DynamicBoxDesc { entity_id: 2, user_id: 2, pose: Pose { position: Vec3::new(0.,3.,0.), rotation: Quat::IDENTITY }, half_extents: Vec3::new(0.5,0.5,0.5), mass: 100., collision_group: 1, collision_mask: u32::MAX }).unwrap();
    let mut peak = 0.0f32;
    let mut resting_peak = 0.0f32;
    let mut impacts = 0;
    for tick in 0..180 {
        world.step().unwrap();
        for contact in world.take_contact_events().unwrap() {
            assert!(contact.normal_speed.is_finite() && contact.tangent_speed.is_finite());
            assert!((contact.effective_mass - 100.).abs() < 0.1);
            let length = (contact.normal.x.powi(2)+contact.normal.y.powi(2)+contact.normal.z.powi(2)).sqrt();
            assert!((length-1.).abs() < 0.01);
            peak = peak.max(contact.normal_speed);
            impacts += usize::from(contact.normal_speed > 0.7);
            if tick > 120 { resting_peak = resting_peak.max(contact.normal_speed); }
        }
    }
    assert!(peak > 2., "a real drop must retain pre-solver speed, saw {peak}");
    assert!(impacts > 0);
    assert!(resting_peak < 0.7, "support load must not sound like an impact: {resting_peak}");
    // Off-centre force starts sliding and rotation. The callback must include
    // angular point motion, even after the solver has begun slowing the box.
    world.apply_impulse_at_point(2, Vec3::new(400.,0.,0.), Vec3::new(0.,1.,0.3)).unwrap();
    let mut tangent_peak = 0.0f32;
    for _ in 0..30 {
        world.step().unwrap();
        for contact in world.take_contact_events().unwrap() { tangent_peak = tangent_peak.max(contact.tangent_speed); }
    }
    assert!(tangent_peak > 0.5, "a sliding/spinning box must report contact speed: {tangent_peak}");
}
