import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildNeighborhoodLibrary,buildArtDecoCinema,buildFireStation,buildBookStack,buildCinemaSeat,composeScene,validate} from '../src/index.mjs';
import {boundsFor} from '../src/geometry.mjs';
const builders={library:buildNeighborhoodLibrary,cinema:buildArtDecoCinema,station:buildFireStation};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
for(const [name,build]of Object.entries(builders))test(`${name}: deterministic, mirrored, furnished, independently reusable`,()=>{
 const a=build();assert.equal(hash(a.pack),hash(build().pack));
 for(const mirrored of [false,true]){
  const {pack,metadata:m}=mirrored?build({mirrored}):a,s=pack.scenario;
  const result=validate(pack);assert(result.passed,result.errors.join('\n'));
  assert(m.options.storeys<=2);assert(m.entrances.every(e=>e.clearWidth>=1.2));
  for(const room of m.rooms){const [lo,hi]=room.bounds;assert(m.route.some(p=>Math.abs(p.at[1]-lo[1])<.01&&p.at[0]>lo[0]&&p.at[0]<hi[0]&&p.at[2]>lo[2]&&p.at[2]<hi[2]),`missing room ${room.name}`);}
  for(const [mode,g]of Object.entries(m.shotGroups))assert(s.nodeGroups.includes(g),`missing ${mode} target ${g}`);
  for(let i=0;i<s.nodes.length;i++)if(s.nodes[i].mass===0){const c=s.nodeColliders[i];assert(boundsFor(s.nodes[i],c.kind==='shape'?s.shapeLibrary[c.shape]:c)[1][1]<=1e-5);}
 }
 const repeated=composeScene([{pack:a.pack},{pack:a.pack,position:[40,0,0],yaw:90},{pack:a.pack,position:[0,0,40],yaw:270}]);
 const result=validate(repeated);assert(result.passed,result.errors.join('\n'));
 const count=a.pack.scenario.nodes.length;for(const b of repeated.scenario.bonds)assert.equal(Math.floor(b.node0/count),Math.floor(b.node1/count));
 const empty=build({furnished:false});assert(empty.pack.scenario.nodes.length<count);assert(validate(empty.pack).passed);
});
test('small reusable props use modest fragmentation and no fixed nodes',()=>{
 for(const build of [buildBookStack,buildCinemaSeat]){const {pack}=build();assert(validate(pack).passed);assert(pack.scenario.nodes.length<=20);assert(pack.scenario.nodes.every(n=>n.mass>0));}
 const books=buildBookStack().pack.scenario;
 for(const b of books.bonds)assert.equal(books.nodeGroups[b.node0],books.nodeGroups[b.node1],'books rest separately through contact');
});
