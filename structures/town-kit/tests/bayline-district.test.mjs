import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBaylineDistrict} from '../src/bayline-district.mjs';
import {buildBungalow} from '../src/bungalow.mjs';
import {validate} from '../src/validate.mjs';
import {boundsFor} from '../src/geometry.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('four times the town area and building count, with genuinely different heights and facades',()=>{
 const a=buildBaylineDistrict(),b=buildBaylineDistrict();assert.equal(hash(a.pack),hash(b.pack));
 const {pack,metadata:m}=a;assert.equal(m.instances.length,24);assert.equal(m.composition.areaSquareMetres,4*104*72);assert.deepEqual(m.composition.storeyCounts,{'1':4,'2':18,'3':2});assert.equal(m.composition.buildingTypes.length,5);assert.equal(m.composition.palettes.length,6);
 const result=validate(pack);assert(result.passed,result.errors.join('\n'));
 for(const asset of a.templates){const result=validate(asset.pack);assert(result.passed,result.errors.join('\n'));}
 const s=pack.scenario,owner=i=>m.instances.findIndex(a=>i>=a.nodeStart&&i<a.nodeStart+a.nodeCount);
 for(const bond of s.bonds)assert.equal(owner(bond.node0),owner(bond.node1));
 for(const instance of m.instances){
  assert(m.route.some(p=>p.name===`${instance.id}/return-street`));
  for(const room of m.rooms.filter(r=>r.instance===instance.id)){
   const [lo,hi]=room.bounds;
   assert(m.route.some(p=>p.name.startsWith(instance.id+'/')&&Math.abs(p.at[1]-lo[1])<.01&&p.at[0]>lo[0]&&p.at[0]<hi[0]&&p.at[2]>lo[2]&&p.at[2]<hi[2]),`route missing room ${room.name}`);
  }
 }
 for(let i=0;i<s.nodes.length;i++)if(s.nodes[i].mass===0){const c=s.nodeColliders[i];assert(boundsFor(s.nodes[i],c.kind==='shape'?s.shapeLibrary[c.shape]:c)[1][1]<1e-5);}
 assert.equal(s.shapeLibrary.length,new Set(s.shapeLibrary.map(c=>JSON.stringify(c))).size,'deduplicate convex shapes');
});
test('bungalows have usable rooms and two actual porch/window layouts, including mirror versions',()=>{
 const counts=new Set();
 for(const porch of ['full','entry'])for(const windowStyle of ['paired','wide'])for(const mirrored of [false,true]){
  const {pack,metadata}=buildBungalow({porch,windowStyle,mirrored});const result=validate(pack);assert(result.passed,result.errors.join('\n'));
  assert.equal(metadata.options.storeys,1);assert.equal(metadata.rooms.length,4);assert(metadata.entrances.every(e=>e.clearWidth>=1.2));counts.add(pack.scenario.nodes.length);
  assert(!pack.scenario.nodeTypes.some(t=>t.includes('stair')));
 }
 assert.equal(counts.size,4);
});
