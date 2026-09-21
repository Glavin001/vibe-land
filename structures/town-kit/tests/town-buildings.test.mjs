import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPorchHouse,buildCornerGrocery,buildWorkshop,validate,composeScene} from '../src/index.mjs';
const builders={house:buildPorchHouse,grocery:buildCornerGrocery,workshop:buildWorkshop};
test('three distinct town buildings have supported geometry, rooms and real return routes',()=>{
 const counts=[];
 for(const [name,build] of Object.entries(builders)){
  const first=build();assert.deepEqual(first,build(),`${name} must be deterministic`);counts.push(first.pack.scenario.nodes.length);
  for(const mirrored of [false,true])for(const furnished of [false,true]){
   const {pack,metadata}=build({mirrored,furnished});const v=validate(pack);assert(v.passed,`${name}: ${v.errors.join('\n')}`);
   assert(metadata.entrances.every(e=>e.clearWidth>=1.2));assert.equal(metadata.route.at(-1).name,'return-street');
   assert(metadata.route.some(p=>p.name==='half-landing-a'));assert(metadata.route.some(p=>p.name==='upper-landing'));
   for(const room of metadata.rooms){
    const [lo,hi]=room.bounds,c=metadata.cameras[room.name];assert(c,`${name}: missing ${room.name} camera`);
    assert(c.position.every((x,i)=>x>lo[i]&&x<hi[i]),`${name}: camera outside ${room.name}`);
    assert(metadata.route.some(({at})=>Math.abs(at[1]-lo[1])<.01&&at[0]>lo[0]&&at[0]<hi[0]&&at[2]>lo[2]&&at[2]<hi[2]),`${name}: missing route in ${room.name}`);
   }
  }
 }
 assert.equal(new Set(counts).size,3,'distinct layouts must not be recolored duplicates');
});
test('new buildings can be repeatedly placed and quarter-turned independently',()=>{
 for(const build of Object.values(builders)){
  const p=build({furnished:false}).pack,n=p.scenario.nodes.length;
  const scene=composeScene([{pack:p,position:[-25,0,0],yaw:90},{pack:p,position:[25,0,0],yaw:270}]);
  assert(validate(scene).passed);assert(scene.scenario.bonds.every(b=>(b.node0<n)===(b.node1<n)));
  assert(scene.scenario.nodePieces[n]>Math.max(...scene.scenario.nodePieces.slice(0,n)));
 }
});
