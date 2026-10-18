import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildVictorianCorner,buildProp,PROP_TYPES,composeScene,validate} from '../src/index.mjs';
import {boundsFor} from '../src/geometry.mjs';
const hash=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
test('deterministic authoring and physical variant geometry',()=>{
 const a=buildVictorianCorner();assert.equal(hash(a),hash(buildVictorianCorner()));
 for(const storeys of [2,3])for(const mirrored of [false,true])for(const palette of ['sage','blue','ochre']){
  const {pack,metadata}=buildVictorianCorner({storeys,mirrored,palette});const v=validate(pack);assert.equal(v.passed,true,v.errors.join('\n'));
  assert.equal(metadata.rooms.length,3+4*(storeys-1));
  // Conservative sphere/AABB clearance also covers convex stairs. Shot origins
  // must not begin inside intact construction or furnishings.
  const s=pack.scenario,bounds=s.nodes.map((n,i)=>{const c=s.nodeColliders[i];return boundsFor(n,c.kind==='shape'?s.shapeLibrary[c.shape]:c);});
  for(const [mode,shots] of Object.entries(metadata.shots))for(const [j,shot] of shots.entries())for(const [i,[lo,hi]] of bounds.entries()){
   const distanceSquared=shot.from.reduce((sum,x,k)=>sum+Math.max(lo[k]-x,0,x-hi[k])**2,0);
   assert(distanceSquared>=shot.radius**2-1e-6,`${mode} shot ${j} starts in ${s.nodeTypes[i]} ${i}`);
  }

  for(const room of metadata.rooms){
   const camera=metadata.cameras[room.name==='preparation'?'prep':room.name];
   assert(camera,`Missing room camera: ${room.name}`);
   const [lo,hi]=room.bounds;
   assert(camera.position.every((v,i)=>v>lo[i]&&v<hi[i]),`Room camera outside ${room.name}`);
   assert(metadata.route.some(({at})=>Math.abs(at[1]-lo[1])<.01&&at[0]>lo[0]&&at[0]<hi[0]&&at[2]>lo[2]&&at[2]<hi[2]),`No walking checkpoint inside ${room.name}`);
  }
  assert(metadata.route.some(p=>p.at[1]>3));assert.equal(metadata.route.at(-1).name,'return-street');
  assert.equal(pack.scenario.nodes.filter(n=>n.mass===0).length,13);
 }
 for(const furnished of [false,true])for(const fence of [false,true]){
  const {pack}=buildVictorianCorner({storeys:2,furnished,fence});const v=validate(pack);assert(v.passed,v.errors.join('\n'));
 }
});
test('all props form a single connected, supported assembly',()=>{
 for(const type of PROP_TYPES){const {pack}=buildProp(type),v=validate(pack);assert(v.passed,v.errors.join('\n'));assert.equal(v.components,1,type);}
 const s=buildProp('table').pack.scenario;
 assert.equal(s.nodeTypes.filter(t=>t==='table-top').length,4);
 assert.equal(s.nodeTypes.filter(t=>t==='table-leg').length,8);
});
test('repeated quarter turns remap identity, material, geometry and bonds',()=>{
 const a=buildProp('gate',{palette:'sage'}).pack,b=buildProp('table',{palette:'blue'}).pack;
 const p=composeScene([{pack:a,position:[-5,0,0],yaw:90},{pack:b,position:[5,0,0],yaw:270}]);
 assert(validate(p).passed);const s=p.scenario,n=a.scenario.nodes.length;
 assert.equal(s.nodes.length,n+b.scenario.nodes.length);
 assert(s.bonds.every(e=>(e.node0<n)===(e.node1<n)),'separate assets cannot share bonds');
 assert(s.nodePieces[n]>Math.max(...s.nodePieces.slice(0,n)));
 for(let i=0;i<n;i++){
  const before=a.scenario.nodes[i].centroid,after=s.nodes[i].centroid;
  assert(Math.abs(after.x-(before.z-5))<1e-5);assert(Math.abs(after.z+before.x)<1e-5);
 }
 const r=composeScene([{pack:composeScene([{pack:a,mirror:true}]),mirror:true}]);
 assert.deepEqual(r.scenario.nodes,a.scenario.nodes);
 assert.deepEqual(r.scenario.bonds,a.scenario.bonds);
});
test('validator rejects an unsupported architectural island and above-ground anchors',()=>{
 const p=buildProp('table').pack;p.scenario.nodeGroups.fill('building');assert(!validate(p).passed);
 const q=buildProp('table').pack;q.scenario.nodes[0].mass=0;assert(validate(q).errors.some(e=>e.includes('above-ground anchor')));
});
