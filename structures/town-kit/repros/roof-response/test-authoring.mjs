import assert from 'node:assert/strict';
import {buildFramedPorchHouse,buildFramedBungalow} from '../../src/framed-houses.mjs';
import {validate} from '../../src/validate.mjs';
import {composeScene} from '../../src/geometry.mjs';
const structural=new Set(['foundation','floor','frame-post','frame-beam','stair','ceiling-joist','roof-rafter','roof-post','roof-ridge']);
for(const impactProfile of ['residential-v1','residential-v2'])for(const build of [buildFramedPorchHouse,buildFramedBungalow])for(const mirrored of [false,true]){
 const options={mirrored,impactProfile},asset=build(options),s=asset.pack.scenario;
 assert.deepEqual(asset,build(options),'Candidate must be deterministic');
 assert(validate(asset.pack).passed,'Candidate geometry is invalid');
 const baseline=build({mirrored});
 assert.deepEqual(asset.metadata.route,baseline.metadata.route,'Navigation changed');
 assert.deepEqual(asset.metadata.rooms,baseline.metadata.rooms,'Room layout changed');
 assert(!s.nodeTypes.includes('ceiling'),'Old solid ceiling barrier retained');
 assert(s.nodeTypes.includes('ceiling-joist')&&s.nodeTypes.includes('ceiling-panel'));
 if(impactProfile==='residential-v2'){
  assert(s.bonds.every(b=>s.nodeTypes[b.node0]!=='siding'||s.nodeTypes[b.node1]!=='siding'||s.nodePieces[b.node0]===s.nodePieces[b.node1]),'Separate boards welded together');
  const adjacency=s.nodes.map(()=>[]);for(const b of s.bonds){adjacency[b.node0].push(b.node1);adjacency[b.node1].push(b.node0);}
  const roots=s.nodes.flatMap((n,i)=>n.mass===0?[i]:[]),supported=new Set(roots);
  for(let k=0;k<roots.length;k++)for(const i of adjacency[roots[k]])if(!supported.has(i)){supported.add(i);roots.push(i);}
  for(let i=0;i<s.nodes.length;i++)if(s.nodeGroups[i]==='building')assert(supported.has(i),`Unattached construction ${s.nodeTypes[i]} ${i}`);
 }
 const adjacent=s.nodes.map(()=>[]),seen=new Set(),queue=[];
 s.nodes.forEach((n,i)=>{if(n.mass===0){assert(n.centroid.y<0,'Exposed fixed anchor');seen.add(i);queue.push(i);}});
 for(const b of s.bonds)if(structural.has(s.nodeTypes[b.node0])&&structural.has(s.nodeTypes[b.node1])){adjacent[b.node0].push(b.node1);adjacent[b.node1].push(b.node0);}
 for(let k=0;k<queue.length;k++)for(const i of adjacent[queue[k]])if(!seen.has(i)){seen.add(i);queue.push(i);}
 for(let i=0;i<s.nodes.length;i++)if(['ceiling-joist','roof-rafter','roof-post','roof-ridge'].includes(s.nodeTypes[i]))assert(seen.has(i),`${s.nodeTypes[i]} ${i} relies on cosmetic support`);
 const duplicate=composeScene([{pack:asset.pack},{pack:asset.pack,position:[26,0,0],yaw:90}]),count=s.nodes.length;
 assert(validate(duplicate).passed);
 assert(duplicate.scenario.bonds.every(b=>Math.floor(b.node0/count)===Math.floor(b.node1/count)));
}
assert.throws(()=>buildFramedPorchHouse({impactProfile:'typo'}),/impactProfile/);
console.log('PASS: both mirrored layouts deterministic and overlap-free; roof frame reaches buried anchors without cosmetic panels; routes unchanged; rotated instances independent.');
