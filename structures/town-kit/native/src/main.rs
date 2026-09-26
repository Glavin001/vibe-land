//! Independent native-GPU review. No server, city reset, or engine mutations.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, path::Path, time::Instant};
use vibe_land_physx_bridge::*;

type R<T> = Result<T, Box<dyn std::error::Error>>;
#[repr(C)]
#[derive(Default)]
struct ContactSettings { actors:u32, position_min:u32, position_max:u32, velocity_min:u32, velocity_max:u32, shapes:u32, contact_min:f32, contact_max:f32 }
extern "C" {fn town_kit_contact_settings(scene:usize,position:u32,velocity:u32,contact_offset:f32,result:*mut ContactSettings)->u32;}
extern "C" {fn town_kit_round_pose(scene:usize,result:*mut f32)->u32;}

fn f(v: &Value, k: &str) -> f32 { v[k].as_f64().unwrap_or(0.0) as f32 }
fn vec(v: &Value) -> Vec3 { Vec3::new(f(v,"x"), f(v,"y"), f(v,"z")) }
fn av(v: &Value) -> Vec3 { Vec3::new(v[0].as_f64().unwrap() as f32,v[1].as_f64().unwrap() as f32,v[2].as_f64().unwrap() as f32) }
fn arr(v: Vec3) -> [f32;3] { [v.x,v.y,v.z] }
fn flag(name:&str)->bool { std::env::var(name).map(|v|v!="0").unwrap_or(true) }
fn stress_tolerance()->f32 {std::env::var("TOWN_KIT_STRESS_TOLERANCE").ok().and_then(|v|v.parse::<f32>().ok()).filter(|v|v.is_finite()&&*v>0.).unwrap_or(1e-5)}
fn norm(v: Vec3) -> f32 { (v.x*v.x+v.y*v.y+v.z*v.z).sqrt() }

struct Recorder { cannon:bool, frames: Vec<Value>, last: Vec<[f32;7]>, count: usize, entities:Vec<u32>, bodies:HashMap<u32,Value>, body_poses:HashMap<u32,[f32;7]> }
impl Recorder {
 fn new(count: usize) -> Self { Self { cannon:false, frames:vec![],last:vec![[f32::INFINITY;7];count],count,entities:vec![u32::MAX;count],bodies:HashMap::new(),body_poses:HashMap::new() } }
 fn capture(&mut self, world: &World, tick: u32, broken: &[u32]) -> R<()> {
  let bodies=world.native_chunk_body_snapshots()?;
  let rotations:HashMap<_,_>=bodies.iter().map(|b|(b.entity_id,[b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w])).collect();
  let body_poses:HashMap<_,_>=bodies.iter().map(|b|(b.entity_id,[b.position.x,b.position.y,b.position.z,b.rotation.x,b.rotation.y,b.rotation.z,b.rotation.w])).collect();
  // chunk_aim scans the native chunk ledger. Calling it for every stationary
  // building at every frame made town recording quadratic in chunk count.
  // A fracture or body-set change invalidates ownership and forces a full scan.
  let refresh_all=!broken.is_empty()||body_poses.len()!=self.body_poses.len()||body_poses.keys().any(|id|!self.body_poses.contains_key(id));
  let moved:HashSet<_>=body_poses.iter().filter(|(id,p)|self.body_poses.get(id)!=Some(p)).map(|(id,_)|*id).collect();
  let mut changed=vec![];
  for i in 0..self.count {
   if !refresh_all&&self.entities[i]!=u32::MAX&&!moved.contains(&self.entities[i]) {continue;}
   let aim=world.native_chunk_aim(0,i as u32)?;
   if !aim.found { return Err(format!("missing chunk {i} in recording").into()); }
   let q=rotations.get(&aim.entity_id).copied().unwrap_or([0.,0.,0.,1.]);
   let pose=[aim.center.x,aim.center.y,aim.center.z,q[0],q[1],q[2],q[3]].map(|v|(v*10000.).round()/10000.);
   if aim.entity_id!=self.entities[i] || pose.iter().zip(self.last[i]).any(|(a,b)|(a-b).abs()>0.00001) {
    changed.push(json!([i,pose.map(|v|(v as f64*10000.).round()/10000.),aim.entity_id]));self.last[i]=pose;self.entities[i]=aim.entity_id;
   }
  }
  let q=|v:f32|(v as f64*10000.).round()/10000.;
  let current:HashMap<u32,Value>=bodies.iter().map(|b|(b.entity_id,json!({"id":b.entity_id,"island":b.island_id,"position":[q(b.position.x),q(b.position.y),q(b.position.z)],"rotation":[q(b.rotation.x),q(b.rotation.y),q(b.rotation.z),q(b.rotation.w)],"linearVelocity":[q(b.linear_velocity.x),q(b.linear_velocity.y),q(b.linear_velocity.z)],"angularVelocity":[q(b.angular_velocity.x),q(b.angular_velocity.y),q(b.angular_velocity.z)],"sleeping":b.sleeping,"kinematic":b.kinematic}))).collect();
  let changed_bodies:Vec<_>=current.iter().filter(|(id,v)|self.bodies.get(id)!=Some(v)).map(|(_,v)|v.clone()).collect();
  let removed:Vec<_>=self.bodies.keys().filter(|id|!current.contains_key(id)).copied().collect();
  self.frames.push(json!({"time":tick as f32/60.,"poses":changed,"broken":broken,"bodies":changed_bodies,"removedBodies":removed}));
  if self.cannon {let mut round=[0f32;4];
  let found=unsafe{town_kit_round_pose(world.scene_ptr()?,round.as_mut_ptr())}!=0;
  self.frames.last_mut().unwrap()["round"]=if found{json!(round)}else{Value::Null};}
  self.bodies=current;
  self.body_poses=body_poses;
  Ok(())
 }
}

fn run(pack:&Value, meta:&Value, mode:&str, report:&mut Value, rec:&mut Recorder) -> R<()> {
 let s=&pack["scenario"];
 let ns=s["nodes"].as_array().ok_or("nodes missing")?;
 let bs=s["bonds"].as_array().ok_or("bonds missing")?;
 let mut nodes=vec![];
 for (i,n) in ns.iter().enumerate() {
  let raw=&s["nodeColliders"][i];let c=if raw["kind"]=="shape" { &s["shapeLibrary"][raw["shape"].as_u64().unwrap() as usize] } else { raw };
  let hull=c["kind"]=="convex_hull";
  nodes.push(ChunkNodeDesc { node_index:i as u32,centroid:vec(&n["centroid"]),mass:f(n,"mass"),volume:f(n,"volume"),geom_kind:if hull {1}else{0},
   half_extents:if hull {Vec3::ZERO}else{vec(&c["halfExtents"])},convex_points:if hull {c["points"].as_array().unwrap().chunks(3).map(|p|Vec3::new(p[0].as_f64().unwrap() as f32,p[1].as_f64().unwrap() as f32,p[2].as_f64().unwrap() as f32)).collect()}else{vec![]} });
 }
 let bonds:Vec<_>=bs.iter().enumerate().map(|(i,b)|ChunkBondDesc {bond_index:i as u32,node0:b["node0"].as_u64().unwrap() as u32,node1:b["node1"].as_u64().unwrap() as u32,centroid:vec(&b["centroid"]),normal:vec(&b["normal"]),area:f(b,"area"),material:b["m"].as_u64().unwrap_or(0) as u32}).collect();
 let materials=pack["defaults"]["solver"]["materials"].as_array().ok_or("materials missing")?.iter().map(|m|StressMaterialDesc {
  compression_elastic:f(m,"compressionElastic"),compression_fatal:f(m,"compressionFatal"),tension_elastic:f(m,"tensionElastic"),tension_fatal:f(m,"tensionFatal"),shear_elastic:f(m,"shearElastic"),shear_fatal:f(m,"shearFatal"),elastic_modulus:f(m,"elasticModulus"),residual_area_fraction:f(m,"residualAreaFraction") }).collect();
 let mut wc=WorldConfig::default();wc.gravity=Vec3::new(0.,-9.81,0.);wc.cpu_threads=2;
 // Optional, explicitly recorded buffer budget for small prefab reviews on
 // a shared GPU. This changes capacity only: gravity, contacts, solver and
 // rejection of unobserved/degraded/capacity-error steps remain unchanged.
 if std::env::var("TOWN_KIT_COMPACT_GPU").as_deref()==Ok("1") {
  wc.gpu_max_rigid_contacts=1_048_576;wc.gpu_max_rigid_patches=1_048_576;
  wc.gpu_heap_capacity=536_870_912;wc.gpu_collision_stack_size=134_217_728;
 }
 // Record the actual capacities, including any explicit review budget.
 report["gpuCapacity"]=json!({"contacts":wc.gpu_max_rigid_contacts,"patches":wc.gpu_max_rigid_patches,"heapBytes":wc.gpu_heap_capacity,"collisionStackBytes":wc.gpu_collision_stack_size});
 let mut world=World::new(wc)?;
 let mask=(1<<0)|(1<<1)|(1<<5);
 let tiled=std::env::var("TOWN_KIT_TILED_GROUND").as_deref()==Ok("1");
 report["ground"]=json!(if tiled {"17 by 17 touching 32 m tiles, depth 4 m"}else{"single 10 km box, depth 1.5 m"});
 if tiled {for x in -8..=8 {for z in -8..=8 {
  world.add_static_box(StaticBoxDesc {entity_id:0x10000001+((x+8)*17+z+8) as u32,user_id:0,pose:Pose{position:Vec3::new(x as f32*32.,-2.,z as f32*32.),rotation:Quat::IDENTITY},half_extents:Vec3::new(16.,2.,16.),collision_group:1,collision_mask:mask})?;
 }}}else{world.add_static_box(StaticBoxDesc { entity_id:0x10000001,user_id:0,pose:Pose{position:Vec3::new(0.,-0.75,0.),rotation:Quat::IDENTITY},half_extents:Vec3::new(5000.,0.75,5000.),collision_group:1,collision_mask:mask })?;}
 world.native_attach()?;
 world.native_create_destructible(0,Pose::default(),&nodes,&bonds,DestructibleSettings {
  max_solver_iterations_per_frame:2048,graph_reduction_level:0,materials,maximum_bodies:0,maximum_fractures_per_actor_per_tick:0,
  apply_excess_forces:true,apply_centrifugal:true,excess_force_scale:0.012,linear_damping:0.25,angular_damping:0.35,
 },1<<5,mask)?;
 let mut contact=ContactSettings::default();
 let requested=std::env::var("TOWN_KIT_CONTACT_ITERATIONS").ok();
 let (position,velocity)=if let Some(raw)=&requested {
  let parts:Vec<_>=raw.split(',').collect();if parts.len()!=2{return Err("contact iterations must be position,velocity".into());}
  let p=parts[0].parse::<u32>()?;let v=parts[1].parse::<u32>()?;
  if p==0||p>255||v==0||v>255{return Err("contact iterations must be in 1..255".into());}(p,v)
 }else{(0,0)};
 let contact_offset=if let Ok(raw)=std::env::var("TOWN_KIT_CONTACT_OFFSET") {let value=raw.parse::<f32>()?;if !value.is_finite()||value<=0.||value>0.1{return Err("contact offset must be in (0, 0.1] metres".into());}value}else{0.};
 // Existing public scene handle; owned by this local World for this entire call.
 if unsafe{town_kit_contact_settings(world.scene_ptr()?,position,velocity,contact_offset,&mut contact)}==0{return Err("contact settings unavailable".into());}
 report["contactSolver"]=json!({"requested":requested,"actors":contact.actors,"positionIterations":[contact.position_min,contact.position_max],"velocityIterations":[contact.velocity_min,contact.velocity_max],"configuredBeforeFirstStep":position>0||contact_offset>0.,"shapes":contact.shapes,"contactOffsetMetres":[contact.contact_min,contact.contact_max],"restOffsetsChanged":false,"sleepSettingsChanged":false});
 world.step()?;
 let native_config=|iterations| NativeConfig {max_iterations:iterations,tolerance:stress_tolerance(),warm_start:true,damage_rate:2.,bend_gain_max:3.,fibre_bending:true,reserved_contact_pairs:(nodes.len()*6).max(4096) as u32,preserve_unchanged_contact_pairs:flag("TOWN_KIT_PRESERVE_CONTACTS"),gpu_island_repair:flag("TOWN_KIT_GPU_ISLAND_REPAIR"),verdict_sample_ticks:1};
 world.native_configure(native_config(std::env::var("TOWN_KIT_ITERATIONS").ok().and_then(|x|x.parse().ok()).unwrap_or(16)))?;
 if std::env::var_os("TOWN_KIT_WARM_IN").is_some() || std::env::var_os("TOWN_KIT_WARM_OUT").is_some() {
  let path=world.native_warm_runtime_path()?;
  report["warmRuntime"]=json!({"sha256":format!("{:x}",Sha256::digest(fs::read(&path)?)),"path":path});
 }
 if let Ok(file)=std::env::var("TOWN_KIT_WARM_IN") {
  let bytes=fs::read(&file)?;
  if bytes.len()!=bonds.len()*24{return Err("warm input length does not match bonds".into());}
  let values:Vec<f32>=bytes.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect();
  // Rejections must leave the initial state usable.
  if world.native_import_warm_start(&values[..values.len()-1]).is_ok(){return Err("short warm input accepted".into());}
  let mut bad=values.clone();bad[0]=f32::NAN;
  if world.native_import_warm_start(&bad).is_ok(){return Err("non-finite warm input accepted".into());}
  world.native_import_warm_start(&values)?;
  if world.native_import_warm_start(&values).is_ok(){return Err("duplicate warm import accepted".into());}
  report["warmStart"]=json!({"imported":true,"values":values.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"invalidInputsRejected":true});
 }
 let mut tick=0u32;let mut quiet=0;let mut idle=0;let mut timings=vec![];let mut all_broken=HashSet::new();
 // Rest is a measured state. 3600 ticks bounds failure; 1800 subsequent ticks
 // prove 30 simulated seconds of intact equilibrium, including loose furniture.
 loop {
  tick+=1;let started=Instant::now();if let Err(e)=world.step(){report["nativeFailure"]=json!(format!("{:?}",world.native_last_status()));return Err(e.into());}let st=world.native_tick()?;timings.push(started.elapsed().as_secs_f64()*1000.);
  report["lastStatus"]=json!({"tick":tick,"frame":st.frame,"error":st.error,"converged":st.converged,"observed":st.observed,"degraded":st.degraded,"iterations":st.iterations});
  if tick==1 {report["firstStep"]=report["lastStatus"].clone();}
  if st.converged&&report["firstConvergedTick"].is_null(){report["firstConvergedTick"]=json!(tick);}
  if st.error!=0||!st.observed||st.degraded||st.missed_frames!=0 { return Err(format!("rejected/unobserved native step: {}",report["lastStatus"]).into()); }
  let broken=world.native_take_broken_bonds()?;
  if !broken.is_empty()||st.broken_bonds>0||st.crushed_chunks>0||st.post_correction_broken_bonds>0 {
   report["spontaneousBonds"]=json!(broken.iter().map(|b|b.bond_id).collect::<Vec<_>>());
   rec.capture(&world,tick,&broken.iter().map(|b|b.bond_id).collect::<Vec<_>>())?;
   return Err(format!("spontaneous destruction at tick {tick}: {} broken, {} crushed",broken.len(),st.crushed_chunks).into());
  }
  let bodies=world.native_chunk_body_snapshots()?;
  let awake=bodies.iter().filter(|b|!b.kinematic&&!b.sleeping).count();
  report["awakeBodies"]=json!(awake);
  if st.converged&&awake==0 {quiet+=1;}else{quiet=0;idle=0;}
  if quiet>=60 {idle+=1;}
  if tick==1||tick%120==0 {rec.capture(&world,tick,&[])?;}
  if tick%300==0 {eprintln!("{mode}: tick={tick} awake={awake} converged={} idle={idle}/1800",st.converged);}
  world.native_take_island_events()?;world.native_take_chunk_migrations()?;
  if idle>=if mode=="cannon" {60}else{1800} {break;}
  if tick>=5400 {return Err("failed to reach and retain intact equilibrium within 90 seconds".into());}
 }
 let idle_ticks=if mode=="cannon" {60}else{1800};
 report["stability"]=json!({"passed":true,"gravity":9.81,"idleSeconds":idle_ticks/60,"equilibriumTick":tick-idle_ticks,"brokenBonds":0,"crushedChunks":0});
 if let Ok(file)=std::env::var("TOWN_KIT_WARM_OUT") {
  let values=world.native_export_warm_start()?;
  if values.len()!=bonds.len()*6||values.iter().any(|v|!v.is_finite()){return Err("invalid native warm export".into());}
  let bytes:Vec<u8>=values.iter().flat_map(|v|v.to_le_bytes()).collect();
  fs::write(&file,&bytes)?;
  if world.native_import_warm_start(&values).is_ok(){return Err("late warm import accepted".into());}
  report["warmExport"]=json!({"file":file,"sha256":format!("{:x}",Sha256::digest(&bytes)),"values":values.len(),"lateImportRejected":true});
 }
 if mode=="traverse" {
  let route=meta["route"].as_array().ok_or("missing traversal route")?;
  let start=av(&route[0]["at"]);let id=0x20000001;
  world.add_capsule_player(CapsulePlayerDesc {entity_id:id,user_id:0,position:Vec3::new(start.x,start.y+0.82,start.z),cylinder_height:0.9,radius:0.35,step_offset:0.55,contact_offset:0.01,slope_limit_radians:45_f32.to_radians(),collision_group:1<<1,collision_mask:mask})?;
  let mut checkpoints=vec![];let mut vertical_speed=0f32;
  for goal in route.iter().skip(1) {
   let g=av(&goal["at"]);let mut reached=false;
   for _ in 0..1800 {
    let snapshot=world.player_snapshots()?[0];let p=snapshot.pose.position;
    let overhead=world.native_raycast_chunk(Vec3::new(p.x,p.y,p.z),Vec3::new(0.,1.,0.),1.30)?;
    if overhead.hit {report["headroomFailure"]=json!({"route":goal,"height":overhead.distance+0.8,"chunk":overhead.chunk_id});return Err("route headroom is below 2.1 metres".into());}
    vertical_speed=if snapshot.grounded {-0.5}else{vertical_speed-9.81/60.};
    let d=Vec3::new(g.x-p.x,0.,g.z-p.z);let dist=norm(d);
    if dist<0.16&&(p.y-0.8-g.y).abs()<0.22 {reached=true;checkpoints.push(json!({"name":goal["name"],"feet":[p.x,p.y-0.8,p.z]}));break;}
    let step=(2.2/60f32).min(dist);
    world.move_player(id,Vec3::new(if dist>0.01{d.x/dist*step}else{0.},vertical_speed/60.,if dist>0.01{d.z/dist*step}else{0.}))?;
    if let Err(e)=world.step(){report["nativeFailure"]=json!(format!("{:?}",world.native_last_status()));return Err(e.into());}let st=world.native_tick()?;tick+=1;
    if st.error!=0||!st.observed||st.degraded||st.missed_frames!=0 {report["blockedAt"]=goal.clone();return Err("native failure during traversal".into());}
    let breaks=world.native_take_broken_bonds()?;if !breaks.is_empty(){report["blockedAt"]=goal.clone();return Err("walking caused structural damage".into());}
    if tick%3==0 {let p=world.player_snapshots()?[0].pose.position;rec.frames.push(json!({"time":tick as f32/60.,"poses":[],"player":arr(p)}));}
    world.native_take_island_events()?;world.native_take_chunk_migrations()?;
   }
   if !reached {report["checkpoints"]=json!(checkpoints);report["blockedAt"]=json!({"target":goal,"player":arr(world.player_snapshots()?[0].pose.position)});return Err(format!("blocked walking to {}",goal["name"]).into());}
  }
  let mut quiet_walk=0;
  for _ in 0..600 {world.step()?;let status=world.native_tick()?;
   if status.error!=0||!status.observed||status.degraded||status.missed_frames!=0||!world.native_take_broken_bonds()?.is_empty(){return Err("native post-walk equilibrium failed".into());}
   if status.converged {quiet_walk+=1;}else{quiet_walk=0;}
   if quiet_walk>=60 {break;}
  }
  if quiet_walk<60{return Err("walking never returned to solver convergence".into());}
  report["traversal"]=json!({"passed":true,"minimumHeadroom":2.1,"capsuleHeight":1.6,"capsuleRadius":0.35,"checkpoints":checkpoints});
 } else if mode!="stability" {
  let shots=meta["shots"][mode].as_array().ok_or("unknown destruction scenario")?;
  let last_shot=shots.iter().map(|s|s["tick"].as_u64().unwrap_or(0) as u32).max().unwrap_or(0);
  let base_tick=tick;let mut pending=vec![];let mut events=vec![];let mut settled=0;let mut unconverged=0;let mut peak_utilisation=0f32;let mut status_samples=vec![];let mut fractures=vec![];let mut peak_rows=HashMap::<u32,f32>::new();
  // A town tour contains spaced, individually aimed cannon shots. Retain the
  // post-impact observation window after the last one rather than silently
  // dropping shots beyond the single-asset 20-second limit.
  if last_shot>35000 {return Err("cannon tour exceeds the 10-minute review budget".into());}
  for frame in 0..if mode=="cannon" {1200u32.max(last_shot+900)}else{3600u32} {
   for shot in shots {
    if shot["tick"].as_u64().unwrap_or(0) as u32!=frame {continue;}
    let p=av(&shot["from"]);let to=av(&shot["to"]);let d=if mode=="cannon" {av(&shot["direction"])}else{Vec3::new(to.x-p.x,to.y-p.y,to.z-p.z)};let len=norm(d);
    let hit=world.native_raycast_chunk(p,Vec3::new(d.x/len,d.y/len,d.z/len),norm(Vec3::new(to.x-p.x,to.y-p.y,to.z-p.z))+2.)?;
    if report["shots"].is_null(){report["shots"]=json!([]);}
    report["shots"].as_array_mut().unwrap().push(json!({"tick":tick,"input":shot,"rayHit":hit.hit,"chunk":hit.chunk_id,"distance":hit.distance}));
    world.native_fire_round(RoundDesc {position:p,direction:Vec3::new(d.x/len,d.y/len,d.z/len),momentum_ns:shot["momentum"].as_f64().unwrap_or(500.) as f32,radius:shot["radius"].as_f64().unwrap_or(0.08) as f32,speed:shot["speed"].as_f64().unwrap_or(8.) as f32,ttl_ticks:if mode=="cannon" {1260}else{180}})?;
    if mode=="cannon" {rec.capture(&world,tick,&[])?;}
   }
   tick+=1;if let Err(e)=world.step(){report["nativeFailure"]=json!(format!("{:?}",world.native_last_status()));return Err(e.into());}let st=world.native_tick()?;
   report["lastStatus"]=json!({"tick":tick,"frame":st.frame,"error":st.error,"converged":st.converged,"observed":st.observed,"degraded":st.degraded});
   if st.error!=0||!st.observed||st.degraded||st.missed_frames!=0 {return Err(format!("native destruction step failed: {}",report["lastStatus"]).into());}
   if !st.converged {unconverged+=1;}
   if frame<120 {for row in world.native_bond_stress_rows(0)? {if row.utilisation.is_finite(){peak_utilisation=peak_utilisation.max(row.utilisation);let peak=peak_rows.entry(row.bond_index).or_insert(0.);*peak=peak.max(row.utilisation);}}}
   let awake=world.native_chunk_body_snapshots()?.iter().filter(|b|!b.kinematic&&!b.sleeping).count();
   report["awakeBodies"]=json!(awake);
   if st.converged&&awake==0 {settled+=1;}else{settled=0;}
   let broken=world.native_take_broken_bonds()?;
   if !broken.is_empty(){fractures.push(json!({"tick":tick,"bonds":broken.iter().map(|b|b.bond_id).collect::<Vec<_>>(),"solverBrokenBonds":st.broken_bonds,"postCorrectionBrokenBonds":st.post_correction_broken_bonds,"crushedChunks":st.crushed_chunks}));}
   for b in broken {all_broken.insert(b.bond_id);pending.push(b.bond_id);}
   for e in world.native_take_island_events()? {events.push(json!({"tick":tick,"island":e.island_id,"kind":e.kind,"chunks":e.chunk_ids}));}
   world.native_take_chunk_migrations()?;
   if frame%60==0 {status_samples.push(json!({"second":frame/60,"converged":st.converged,"iterations":st.iterations,"awakeBodies":awake,"brokenBonds":all_broken.len()}));}
   if frame%600==0 {eprintln!("{mode}: shot timeline {frame}/{} ticks, {} broken bonds",last_shot+900,all_broken.len());}
   let film_stride=if meta["cannonTour"].is_object(){2}else{1};
   if frame%(if mode=="cannon" {film_stride}else if frame<900 {if meta["kind"]=="tree" {1}else{6}}else{30})==0 {rec.capture(&world,tick,&pending)?;pending.clear();}
   if frame>=last_shot+899&&settled>=60 {rec.capture(&world,tick,&pending)?;break;}
  }
  rec.capture(&world,tick,&pending)?;
  report["nativeMappingValid"]=json!(world.native_validate_mappings()?);
  report["destruction"]=json!({"scenario":mode,"brokenBonds":all_broken.len(),"unconvergedTransientTicks":unconverged,"restConvergedTicks":settled,"peakUtilisation":peak_utilisation,"seconds":(tick-base_tick) as f32/60.,"statusSamples":status_samples,"events":events});
  report["destruction"]["fractures"]=json!(fractures);
  report["destruction"]["peakBondUtilisation"]=json!(peak_rows);
  if meta["kind"]=="tree" {
   let mut types=HashMap::<String,usize>::new();
   for &id in &all_broken {let b=&bs[id as usize];let a=b["node0"].as_u64().unwrap() as usize;let c=b["node1"].as_u64().unwrap() as usize;
    let kind=if s["nodeTypes"][a]=="foundation"||s["nodeTypes"][c]=="foundation" {"root"}else if s["nodeTypes"][a]=="trunk"&&s["nodeTypes"][c]=="trunk" {"trunk"}else{"branch"};
    *types.entry(kind.into()).or_default()+=1;
   }
   report["destruction"]["treeFractures"]=json!(types);
   if mode!="cannon" && !meta["fractureReview"].is_null(){
    if types.get("root").copied().unwrap_or(0)>0 {return Err("tree uprooted instead of fracturing above its stump".into());}
    if mode=="furniture"&&types.get("trunk").copied().unwrap_or(0)>0 {return Err("local branch impact also fractured the trunk".into());}
    let expected=if mode=="collapse" {"trunk"}else{"branch"};
    if types.get(expected).copied().unwrap_or(0)==0{return Err(format!("tree review did not fracture a {expected} bond").into());}
   }
  }
  if mode!="cannon" && all_broken.is_empty(){return Err("projectile scenario broke nothing".into());}
  let target_group=meta["shotGroups"][mode].as_str().unwrap_or("building");
  let target_breaks=all_broken.iter().filter(|&&b| {
   ["node0","node1"].iter().any(|key|{let a=bs[b as usize][*key].as_u64().unwrap() as usize;
    s["nodeGroups"][a].as_str().unwrap_or("").contains(target_group)&&(mode!="glazing"||s["nodeTypes"][a]=="glazing")})
  }).count();
  report["destruction"]["targetBrokenBonds"]=json!(target_breaks);
  if mode!="cannon" && target_breaks==0 {return Err(format!("no damage to intended group {target_group}").into());}
  if let Some(groups)=meta["protectedGroups"].as_array(){
   let protected:HashSet<usize>=s["nodeGroups"].as_array().unwrap().iter().enumerate().filter(|(_,g)|groups.contains(g)).map(|(i,_)|i).collect();
   for &b in &all_broken {if protected.contains(&(bs[b as usize]["node0"].as_u64().unwrap() as usize))||protected.contains(&(bs[b as usize]["node1"].as_u64().unwrap() as usize)){return Err("damage crossed into an independent protected instance".into());}}
   let mut max_move=0f32;
   for &i in &protected {let p=world.native_chunk_aim(0,i as u32)?.center;let a=nodes[i].centroid;max_move=max_move.max(norm(Vec3::new(p.x-a.x,p.y-a.y,p.z-a.z)));}
   report["independentInstances"]=json!({"protectedChunks":protected.len(),"maximumMovement":max_move,"brokenBonds":0});
   if max_move>0.02{return Err("protected instance moved during another instance's destruction".into());}
  }
  // A broken bond is not necessarily a traversable wall opening. Probe a
  // one-metre-wide, 2.1-metre-high rectangle through the impacted elevation.
  if mode=="wall" && (meta["buildingType"].is_string() || pack["key"].as_str().unwrap_or("").ends_with("-reuse")) {
   let shot=&shots[0];let from=av(&shot["from"]);let to=av(&shot["to"]);
   let dx=to.x-from.x;let dz=to.z-from.z;let len=(dx*dx+dz*dz).sqrt();
   if len<0.01{return Err("wall breach requires a horizontal impact direction".into());}
   let ux=dx/len;let uz=dz/len;let mut probes=vec![];let mut blocked=0;
   for lateral in [-0.5f32,-0.25,0.,0.25,0.5] {for height in [0.23f32,0.6,1.,1.4,1.85,2.28] {
    let origin=Vec3::new(from.x-uz*lateral,height,from.z+ux*lateral);
    let hit=world.native_raycast_chunk(origin,Vec3::new(ux,0.,uz),len+0.55)?;
    if hit.hit {blocked+=1;}
    probes.push(json!({"origin":arr(origin),"hit":hit.hit,"chunk":hit.chunk_id,"distance":hit.distance}));
   }}
   report["wallOpening"]=json!({"passed":blocked==0,"probeWidthMetres":1.,"floorMetres":0.18,"clearHeightMetres":2.1,"topMetres":2.28,"blockedProbes":blocked,"probes":probes});
   // The ray grid remains a measurement. Ground-level rubble can be stepped
   // over, so prove functional clearance with the actual gameplay capsule.
   report["wallOpening"]["rectangularProbeClear"]=json!(blocked==0);
   report["wallOpening"]["passed"]=json!(false);
   if settled<60{return Err("wall damage did not settle and converge before capsule traversal".into());}
   let player_id=0x20000002;let destination=Vec3::new(to.x+ux*1.1,0.18,to.z+uz*1.1);
   world.add_capsule_player(CapsulePlayerDesc {entity_id:player_id,user_id:0,position:Vec3::new(from.x,0.82,from.z),cylinder_height:0.9,radius:0.35,step_offset:0.55,contact_offset:0.01,slope_limit_radians:45_f32.to_radians(),collision_group:1<<1,collision_mask:mask})?;
   let mut vertical_speed=0f32;let mut crossed=false;
   for _ in 0..600 {
    let snapshot=world.player_snapshots()?[0];let p=snapshot.pose.position;
    let overhead=world.native_raycast_chunk(p,Vec3::new(0.,1.,0.),1.30)?;
    if overhead.hit {report["wallTraversal"]=json!({"passed":false,"headroomMetres":overhead.distance+0.8,"chunk":overhead.chunk_id,"position":arr(p)});return Err("damaged-wall route has less than 2.1 metres headroom".into());}
    let delta=Vec3::new(destination.x-p.x,0.,destination.z-p.z);let distance=norm(delta);
    if distance<0.16&&(p.y-0.8-destination.y).abs()<0.22 {crossed=true;break;}
    vertical_speed=if snapshot.grounded {-0.5}else{vertical_speed-9.81/60.};
    let step=(2.2/60f32).min(distance);
    world.move_player(player_id,Vec3::new(if distance>0.01{delta.x/distance*step}else{0.},vertical_speed/60.,if distance>0.01{delta.z/distance*step}else{0.}))?;
    world.step()?;let status=world.native_tick()?;tick+=1;
    if status.error!=0||!status.observed||status.degraded||status.missed_frames!=0{return Err("native step failed during damaged-wall traversal".into());}
    let broken:Vec<_>=world.native_take_broken_bonds()?.iter().map(|b|b.bond_id).collect();
    if !broken.is_empty(){rec.capture(&world,tick,&broken)?;return Err("walking through the breach caused additional structural damage".into());}
    if tick%3==0 {rec.capture(&world,tick,&[])?;let p=world.player_snapshots()?[0].pose.position;rec.frames.last_mut().unwrap()["player"]=json!(arr(p));}
    world.native_take_island_events()?;world.native_take_chunk_migrations()?;
   }
   report["wallTraversal"]=json!({"passed":crossed,"capsuleRadius":0.35,"capsuleHeight":1.6,"requiredHeadroom":2.1,"jumped":false,"teleported":false,"destination":arr(destination),"finalPosition":arr(world.player_snapshots()?[0].pose.position)});
   if !crossed{return Err("gameplay capsule could not walk through the damaged wall".into());}
   let mut quiet=0;
   for _ in 0..900 {
    world.step()?;let status=world.native_tick()?;tick+=1;
    let breaks=world.native_take_broken_bonds()?;
    if status.error!=0||!status.observed||status.degraded||status.missed_frames!=0||!breaks.is_empty(){return Err("post-breach-walk native equilibrium failed".into());}
    let awake=world.native_chunk_body_snapshots()?.iter().filter(|b|!b.kinematic&&!b.sleeping).count();
    if status.converged&&awake==0 {quiet+=1;}else{quiet=0;}
    world.native_take_island_events()?;world.native_take_chunk_migrations()?;
    if quiet>=60 {break;}
   }
   rec.capture(&world,tick,&[])?;
   if quiet<60{return Err("breach walk did not return to converged physical rest".into());}
   report["wallOpening"]["passed"]=json!(true);report["wallTraversal"]["restConvergedTicks"]=json!(quiet);
  }
  if mode=="collapse" {
   // Single-storey assets have roof collapse, but no upper-floor furnishings.
   // Keep the same drop and convergence requirements; never accept an empty set.
   let single_storey=meta["options"]["storeys"].as_u64()==Some(1);
   let selected=meta["collapseNodes"].as_array();
   let mut drops=vec![];
   for (i,n) in nodes.iter().enumerate().filter(|(i,n)|{
    if let Some(ids)=selected { return n.mass>0. && ids.iter().any(|id|id.as_u64()==Some(*i as u64)); }
    let role=s["nodeTypes"][*i].as_str().unwrap_or("");
    let elevated=if single_storey {n.centroid.y>2.8 && matches!(role,"roof"|"ceiling"|"gable"|"portico-roof")} else {n.centroid.y>5.};
    elevated && s["nodeGroups"][*i].as_str().unwrap_or("")=="building"
   }) {
    let p=world.native_chunk_aim(0,i as u32)?;drops.push(n.centroid.y-p.center.y);
   }
   let fallen=drops.iter().filter(|&&d|d>1.).count();report["destruction"]["upperChunksFallen"]=json!(fallen);
   let mut furnishing_falls=0;
   for (i,n) in nodes.iter().enumerate().filter(|(i,n)|n.centroid.y>3.7 && s["nodeGroups"][*i].as_str().unwrap_or("").starts_with("table-")){
    if n.centroid.y-world.native_chunk_aim(0,i as u32)?.center.y>1. {furnishing_falls+=1;}
   }
   report["destruction"]["furnishingChunksFallen"]=json!(furnishing_falls);
   report["destruction"]["upperChunksTested"]=json!(drops.len());
   report["destruction"]["collapseTarget"]=json!(if single_storey {"roof"} else {"upper-construction"});
   report["destruction"]["upperFurnishingsApplicable"]=json!(!single_storey && meta["options"]["furnished"]==true);
   if !single_storey && meta["options"]["furnished"]==true && furnishing_falls<4 {return Err("upper furnishings did not fall with destroyed floors".into());}
   if drops.is_empty() || fallen<(drops.len()+9)/10 {return Err("support-loss scenario did not produce significant elevated-construction collapse".into());}
  }
  if mode!="cannon" && settled<60 {return Err("damaged assembly did not reach observed, converged physical rest within 60 seconds".into());}
 }
 if !world.native_validate_mappings()? {return Err("native chunk ownership mismatch".into());}
 timings.sort_by(|a,b|a.total_cmp(b));
 report["timing"]=json!({"medianMs":timings[timings.len()/2],"p95Ms":timings[timings.len()*95/100],"samples":timings.len(),"exclusiveGpu":false});
 report["nativeMappingValid"]=json!(true);world.native_clear()?;Ok(())
}

fn main() -> R<()> {
 let args:Vec<_>=std::env::args().collect();if args.len()!=4 {return Err("usage: town-kit-review PACK.json stability|traverse|glazing|wall|furniture|fence|collapse OUTPUT_DIR".into());}
 let bytes=fs::read(&args[1])?;let pack:Value=serde_json::from_slice(&bytes)?;
 let meta_path=Path::new(&args[1]).with_extension("meta.json");let meta_bytes=fs::read(meta_path)?;let meta:Value=serde_json::from_slice(&meta_bytes)?;
 let out=Path::new(&args[3]);fs::create_dir_all(out)?;
 let mut report=json!({"passed":false,"pack":args[1],"mode":args[2],"metadataSha256":format!("{:x}",Sha256::digest(&meta_bytes)),"packSha256":format!("{:x}",Sha256::digest(&bytes)),"chunks":pack["scenario"]["nodes"].as_array().unwrap().len(),"bonds":pack["scenario"]["bonds"].as_array().unwrap().len(),"backend":"physx-2-native-gpu","solver":{"maxIterations":std::env::var("TOWN_KIT_ITERATIONS").unwrap_or("16".into()),"tolerance":stress_tolerance(),"warmStart":true,"damageRate":2,"bendGainMax":3,"fibreBending":true,"preserveContactPairs":flag("TOWN_KIT_PRESERVE_CONTACTS"),"gpuIslandRepair":flag("TOWN_KIT_GPU_ISLAND_REPAIR"),"gravity":9.81}});
 let run_started=Instant::now();
 let mut rec=Recorder::new(pack["scenario"]["nodes"].as_array().unwrap().len());
 rec.cannon=args[2]=="cannon";
 match run(&pack,&meta,&args[2],&mut report,&mut rec) {Ok(())=>report["passed"]=json!(true),Err(e)=>report["error"]=json!(e.to_string())};
 report["wallTimeSeconds"]=json!(run_started.elapsed().as_secs_f64());
 // Stream lossless output instead of requiring a second large uncompressed
 // recording on the shared disk. Publish the report only after output succeeds.
 let temporary=out.join("recording.json.gz.tmp");
 let mut gzip=std::process::Command::new("gzip").args(["-n","-3","-c"])
  .stdin(std::process::Stdio::piped()).stdout(fs::File::create(&temporary)?).spawn()?;
 serde_json::to_writer(gzip.stdin.take().ok_or("gzip stdin missing")?,&json!({"version":1,"bodyEncoding":"delta","posePrecisionMetres":0.0001,"packHash":report["packSha256"],"packKey":pack["key"],"passed":report["passed"],"frames":rec.frames}))?;
 if !gzip.wait()?.success(){return Err("Recording compression failed".into());}
 fs::rename(temporary,out.join("recording.json.gz"))?;
 report["recordingEncoding"]=json!("gzip");
 fs::write(out.join("report.json"),serde_json::to_vec_pretty(&report)?)?;
 println!("{}",json!({"passed":report["passed"],"mode":report["mode"],"error":report["error"],"chunks":report["chunks"],"brokenBonds":report["destruction"]["brokenBonds"],"wallTimeSeconds":report["wallTimeSeconds"]}));
 if report["passed"]!=true {std::process::exit(1);}Ok(())
}
