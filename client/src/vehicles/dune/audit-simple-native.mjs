import RAPIER from '@dimforge/rapier3d-compat';
import {createBuggyPhysics} from './rapier-import.mjs';
import {unpack,boundsOverlap} from './convex.mjs';
let initialized;
/** Validate the analytic cylinders/cuboids after native cooking, independently
 * of their conservative polygon inspection envelopes. */
export async function auditSimpleNative(model){
 initialized??=RAPIER.init();await initialized;const world=new RAPIER.World({x:0,y:0,z:0});
 const assembly=createBuggyPhysics(RAPIER,world,{...model,format:'dune-buggy-physics'},{bodyType:'fixed',bodyGrouping:'parts'});
 try{
  const items=model.parts.flatMap(p=>p.shapes.map((s,i)=>({part:p,shape:s,index:i,collider:assembly.colliders.get(p.id)[i],bounds:unpack(s,p.position).bounds})));
  const bonds=new Map(),primitiveBonds=new Map();let checkedPairs=0,maxPenetration=0;const penetrating=[];
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
   const a=items[i],b=items[j];if(!boundsOverlap(a.bounds,b.bounds,2e-6))continue;checkedPairs++;
   const contact=a.collider.contactCollider(b.collider,2e-6);if(!contact)continue;
   maxPenetration=Math.max(maxPenetration,-contact.distance);
   if(contact.distance < -2e-6)penetrating.push({a:a.part.id,b:b.part.id,depth:-contact.distance,types:[a.shape.type,b.shape.type]});
   if(a.part.id!==b.part.id&&contact.distance<=2e-6){const key=[a.part.id,b.part.id].sort().join('|'),p=contact.point1;bonds.set(key,{a:a.part.id,b:b.part.id,anchor:[p.x,p.y,p.z],separationM:Math.max(0,contact.distance),kind:'native-geometric-contact'});if(a.shape.type!=='convex'||b.shape.type!=='convex')primitiveBonds.set(key,bonds.get(key));}
  }
  const adjacency=new Map(model.parts.map(p=>[p.id,new Set()]));for(const b of bonds.values()){adjacency.get(b.a).add(b.b);adjacency.get(b.b).add(b.a)}
  const seen=new Set(),groups=[];for(const p of model.parts)if(!seen.has(p.id)){const ids=[p.id];seen.add(p.id);for(let i=0;i<ids.length;i++)for(const id of adjacency.get(ids[i]))if(!seen.has(id)){seen.add(id);ids.push(id)}groups.push(ids)}
  return {report:{engine:'Rapier',version:RAPIER.version(),checkedPairs,maxPenetrationM:maxPenetration,penetratingPairs:penetrating.length,primitivePenetratingPairs:penetrating.filter(p=>p.types.some(t=>t!=='convex')).length,examples:penetrating.slice(0,10),components:groups.length,disconnected:groups.slice(1),bonds:bonds.size,contactToleranceM:2e-6},bonds:[...bonds.values()],primitiveBonds:[...primitiveBonds.values()]};
 }finally{assembly.dispose();world.free()}
}

export async function finalizeSimpleColliders(model){
 const native=await auditSimpleNative(model);
 if(native.report.primitivePenetratingPairs)throw Error('Native primitive contact audit failed');
 const bonds=new Map((model.convexBonds??[]).concat(native.primitiveBonds).map(b=>[[b.a,b.b].sort().join('|'),b]));
 const adjacency=new Map(model.parts.map(p=>[p.id,new Set()]));for(const b of bonds.values()){adjacency.get(b.a).add(b.b);adjacency.get(b.b).add(b.a)}
 const seen=new Set(),queue=[model.parts[0].id];seen.add(queue[0]);for(let i=0;i<queue.length;i++)for(const id of adjacency.get(queue[i]))if(!seen.has(id)){seen.add(id);queue.push(id)}
 if(seen.size!==model.parts.length)throw Error('The native primitive contact graph is disconnected');
 model.bonds=[...bonds.values()];delete model.convexBonds;model.report.bonds=bonds.size;model.report.nativePrimitiveAudit=native.report;
 model.report.contactBasis='SAT for convex pairs; native contact queries for analytic primitives. Convex-pair native solver diagnostics are recorded separately.';
 return model;
}
