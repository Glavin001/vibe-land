import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readArtifact} from '../scripts/artifacts.mjs';
import {composeScene,Builder} from '../src/geometry.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('67-building town export contains all nine families and independent placement identities',async()=>{
 const bytes=await readArtifact(new URL('../out/bayline-civic-town.json',import.meta.url).pathname),pack=JSON.parse(bytes);
 const m=JSON.parse(await readFile(new URL('../out/bayline-civic-town.meta.json',import.meta.url),'utf8'));
 assert.equal(sha(bytes),m.assetSha256);assert(m.validation.passed);assert.equal(m.validation.overlapCount,0);
 assert.equal(m.instances.length,67);assert.equal(new Set(m.instances.map(i=>i.id)).size,67);
 assert.equal(new Set(m.instances.map(i=>i.builder)).size,9);
 assert.deepEqual(m.composition.storeyCounts,{'1':22,'2':41,'3':4});
 const s=pack.scenario,owners=new Int16Array(s.nodes.length).fill(-1);
 for(const [index,i]of m.instances.entries()){
  owners.fill(index,i.nodeStart,i.nodeStart+i.nodeCount);
  assert(i.options.storeys<=3);
  for(let n=i.nodeStart;n<i.nodeStart+i.nodeCount;n++)assert(s.nodeGroups[n].endsWith('@'+i.id));
  const route=m.route.filter(p=>p.name.startsWith(i.id+'/'));
  for(const room of m.rooms.filter(r=>r.instance===i.id)){
   const [lo,hi]=room.bounds;
   assert(route.some(p=>Math.abs(p.at[1]-lo[1])<.01&&p.at[0]>lo[0]&&p.at[0]<hi[0]&&p.at[2]>lo[2]&&p.at[2]<hi[2]),`Missing route in ${room.name}`);
  }
 }
 for(const b of s.bonds)assert.equal(owners[b.node0],owners[b.node1]);
 assert.equal(m.acceptance.readyForRelease,false);
});
test('composing a scene above the argument limit preserves piece remapping',()=>{
 const b=new Builder('one');b.box({min:[0,0,0],max:[1,1,1]});const one=b.build(),large=structuredClone(one),count=150000;
 for(const key of ['nodes','nodeColliders','nodeTypes','nodeMaterials','nodeSizes','nodeGroups'])large.scenario[key]=Array(count).fill(one.scenario[key][0]);
 large.scenario.nodePieces=Array.from({length:count},(_,i)=>i);
 const p=composeScene([{pack:large},{pack:one,position:[3,0,0]}]);
 assert.equal(p.scenario.nodes.length,count+1);assert.equal(p.scenario.nodePieces.at(-1),count);assert.equal(p.scenario.nodes.at(-1).centroid.x,3.5);
});
