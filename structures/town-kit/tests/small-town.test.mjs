import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readArtifact} from '../scripts/artifacts.mjs';
import {buildBaylineSmallTown,townLots} from '../src/bayline-small-town.mjs';
import {buildStripShop} from '../src/strip-shop.mjs';
import {validate} from '../src/validate.mjs';
import {boundsFor} from '../src/geometry.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('64-building export is reproducible, navigationally described, and structurally independent',async()=>{
 const bytes=await readArtifact(new URL('../out/bayline-small-town.json',import.meta.url).pathname);
 const metadata=JSON.parse(await readFile(new URL('../out/bayline-small-town.meta.json',import.meta.url),'utf8'));
 assert.equal(sha(bytes),metadata.assetSha256,'compressed export matches review identity');
 const {pack,metadata:m}=buildBaylineSmallTown();
 assert.equal(sha(JSON.stringify(pack)),metadata.assetSha256,'fresh build matches saved export');
 assert.equal(m.instances.length,64);assert.equal(m.rooms.length,304);
 assert.deepEqual(m.composition.storeyCounts,{'1':20,'2':40,'3':4});
 assert.deepEqual(m.composition.zones,{garden:24,'high-street':12,'civic-centre':8,'village-market':8,foundry:12});
 assert.equal(m.composition.templateCount,39);assert.equal(new Set(townLots().map(l=>l.id)).size,64);
 const result=validate(pack);assert(result.passed,result.errors.join('\n'));assert.equal(result.overlapCount,0);
 const s=pack.scenario,owners=new Int16Array(s.nodes.length).fill(-1);
 for(const [index,instance]of m.instances.entries()){
  assert(instance.options.storeys>=1&&instance.options.storeys<=3);
  owners.fill(index,instance.nodeStart,instance.nodeStart+instance.nodeCount);
  const route=m.route.filter(p=>p.name.startsWith(instance.id+'/'));
  assert(route.some(p=>p.name.endsWith('/return-road')));
  for(const room of m.rooms.filter(r=>r.instance===instance.id)){
   const [lo,hi]=room.bounds;
   assert(route.some(p=>Math.abs(p.at[1]-lo[1])<.01&&p.at[0]>lo[0]&&p.at[0]<hi[0]&&p.at[2]>lo[2]&&p.at[2]<hi[2]),`route missing ${room.name}`);
  }
  assert(m.entrances.filter(e=>e.instance===instance.id).every(e=>e.clearWidth>=1));
  for(let i=instance.nodeStart;i<instance.nodeStart+instance.nodeCount;i++)assert(s.nodeGroups[i].endsWith('@'+instance.id));
 }
 for(const b of s.bonds)assert.equal(owners[b.node0],owners[b.node1],'no cross-building or building/terrain bonds');
 for(let i=0;i<s.nodes.length;i++)if(s.nodes[i].mass===0){const c=s.nodeColliders[i];assert(boundsFor(s.nodes[i],c.kind==='shape'?s.shapeLibrary[c.shape]:c)[1][1]<1e-5,'only buried anchors fixed');}
 assert.equal(s.shapeLibrary.length,new Set(s.shapeLibrary.map(c=>JSON.stringify(c))).size);
});
test('retail and cafe shop modules have valid mirrored geometry and open connected routes',()=>{
 for(const signText of ['BOOKS','CAFE'])for(const mirrored of [false,true]){
  const {pack,metadata:m}=buildStripShop({signText,mirrored});const result=validate(pack);assert(result.passed,result.errors.join('\n'));
  assert.equal(m.options.storeys,1);assert.equal(m.rooms.length,2);assert.equal(m.entrances.length,2);
  assert(m.route.some(p=>p.name==='delivery'));assert(m.route.some(p=>p.name==='stockroom'));
  assert(pack.scenario.nodeTypes.includes('open-door'));assert(pack.scenario.nodeTypes.includes('awning'));
 }
});
