#![cfg(feature = "embedded-destruction")]
use vibe_land_physx_bridge::*;
fn pose(x:f32,y:f32,z:f32)->Pose {Pose{position:Vec3::new(x,y,z),rotation:Quat::IDENTITY}}
#[test]
fn native_contact_fracture_publishes_once_and_preserves_queries() {
    let mut world=World::new(WorldConfig::default()).expect("real CUDA scene");
    world.add_static_box(StaticBoxDesc{entity_id:1,user_id:0,pose:pose(0.,-0.5,0.),
        half_extents:Vec3::new(20.,0.5,20.),collision_group:1,collision_mask:u32::MAX}).unwrap();
    world.add_capsule_player(CapsulePlayerDesc{entity_id:3,user_id:0,position:Vec3::new(5.,1.5,-2.),
        cylinder_height:1.,radius:0.4,step_offset:0.3,contact_offset:0.05,slope_limit_radians:0.785,
        collision_group:1,collision_mask:u32::MAX}).unwrap();
    let mut nodes=Vec::new();let mut bonds=Vec::new();
    for y in 0..6 {for x in 0..6 {
        let id=y*6+x;
        nodes.push(ChunkNodeDesc{node_index:id,centroid:Vec3::new(x as f32-2.5,y as f32+0.5,0.),
            mass:if y==0{0.}else{20.},volume:0.729,geom_kind:0,half_extents:Vec3::new(0.45,0.45,0.45),convex_points:vec![]});
        for other in [if x>0{Some(id-1)}else{None},if y>0{Some(id-6)}else{None}].into_iter().flatten(){
            let a=nodes[other as usize].centroid;let b=nodes[id as usize].centroid;
            bonds.push(ChunkBondDesc{bond_index:bonds.len() as u32,node0:other,node1:id,
                centroid:Vec3::new((a.x+b.x)*0.5,(a.y+b.y)*0.5,0.),normal:Vec3::new(b.x-a.x,b.y-a.y,0.),area:0.81,material:0});
        }
    }}
    // Imported assets may author either direction. Preserve the physical
    // normal and stable bond ID when canonicalizing endpoints.
    for b in bonds.iter_mut().step_by(2) {
        std::mem::swap(&mut b.node0,&mut b.node1);
        b.normal=Vec3::new(-b.normal.x,-b.normal.y,-b.normal.z);
    }
    let mut settings=DestructibleSettings::default();settings.max_solver_iterations_per_frame=512;
    settings.materials=vec![StressMaterialDesc{compression_elastic:50000.,compression_fatal:100000.,
        tension_elastic:5000.,tension_fatal:10000.,shear_elastic:10000.,shear_fatal:20000.,
        elastic_modulus:30e9,residual_area_fraction:0.}];
    world.create_destructible(0,pose(0.,0.,0.),&nodes,&bonds,settings,32,u32::MAX).unwrap();
    let gravity=Vec3::new(0.,-9.81,0.);
    for _ in 0..5 {world.step().unwrap();world.destruction_tick(1./60.,gravity).unwrap();}
    assert!(world.take_broken_bonds().unwrap().is_empty(),"intact wall broke without impact");
    world.add_dynamic_sphere(DynamicSphereDesc{entity_id:2,user_id:0,pose:pose(0.,3.,-4.),radius:0.6,mass:100.,collision_group:1,collision_mask:u32::MAX}).unwrap();
    world.apply_impulse(2,Vec3::new(0.,0.,3000.)).unwrap();
    let mut broken=std::collections::BTreeSet::new();let mut corrections=0.;let mut promotions=0;
    for _ in 0..120 {
        world.move_player(3,Vec3::new(0.,-0.02,0.01)).unwrap();
        world.step().unwrap();world.destruction_tick(1./60.,gravity).unwrap();
        for e in world.take_broken_bonds().unwrap(){assert!(broken.insert(e.bond_id),"duplicate accepted bond event");}
        promotions+=world.take_island_events().unwrap().iter().filter(|e|e.kind==0).count();
        let stats=world.destruction_stats().unwrap();
        for span in world.take_destruction_spans(){if span.name=="native_correction_passes" {assert!(span.value<=1.);corrections+=span.value;}}
        assert_eq!(stats.unmapped_body_skips,0);
        assert!(world.validate_destruction_mappings().unwrap());
        world.destruction_tick(1./60.,gravity).unwrap();
        assert!(world.take_broken_bonds().unwrap().is_empty(),"observation repeated physical work");
    }
    let hit=world.raycast(RaycastRequest{origin:Vec3::new(-2.5,0.5,-5.),direction:Vec3::new(0.,0.,1.),max_distance:10.,collision_mask:32,ignore_entity_id:0,has_ignore_entity:false}).unwrap();
    assert!(hit.hit,"supported geometry disappeared from CPU queries");
    assert!(!broken.is_empty() && promotions>0 && corrections>0.,"physical impact did not exercise native correction");
    eprintln!("native gameplay: 36 chunks, 60 bonds, one 100 kg projectile at 30 m/s; broken={} corrections={} promotions={}",broken.len(),corrections,promotions);
    world.clear_destructibles().unwrap();
}
