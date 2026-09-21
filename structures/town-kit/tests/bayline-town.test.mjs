import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildBaylineTown,TOWN_LOTS,placementPoint} from '../src/bayline-town.mjs';
import {boundsFor} from '../src/geometry.mjs';
import {validate} from '../src/validate.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('town is deterministic, collision-free, and preserves independent destructible instances',()=>{
 const {pack,metadata}=buildBaylineTown();
 assert.equal(hash(pack),hash(buildBaylineTown().pack));
 const result=validate(pack);assert(result.passed,result.errors.join('\n'));
 assert.equal(metadata.instances.length,6);assert.equal(metadata.rooms.length,36);
 const owner=i=>metadata.instances.findIndex(a=>i>=a.nodeStart&&i<a.nodeStart+a.nodeCount);
 for(const bond of pack.scenario.bonds)assert.equal(owner(bond.node0),owner(bond.node1),'bond must not join independent lots or terrain');
 const s=pack.scenario;
 s.nodes.forEach((node,i)=>{
  if(node.mass)return;
  const c=s.nodeColliders[i],bounds=boundsFor(node,c.kind==='shape'?s.shapeLibrary[c.shape]:c);
  assert(bounds[1][1]<=1e-5,'all fixed geometry stays below ground');
 });
 for(const type of ['road','paving','road-marking'])assert(s.nodeTypes.some((t,i)=>t===type&&s.nodes[i].mass>0),`${type} must have physical mass`);
 for(const lot of TOWN_LOTS){
  const instance=metadata.instances.find(i=>i.id===lot.id);
  const source=instance.sourcePack.scenario;
  const n=s.nodes[instance.nodeStart];
  assert.deepEqual([n.centroid.x,n.centroid.y,n.centroid.z],placementPoint(Object.values(source.nodes[0].centroid),lot));
  assert.equal(instance.bondCount,source.bonds.length);
  assert(metadata.route.some(p=>p.name===`${lot.id}/return-street`));
  assert(metadata.entrances.filter(e=>e.instance===lot.id).every(e=>e.clearWidth>=1.2));
  for(const room of metadata.rooms.filter(r=>r.instance===lot.id)){
   const [lo,hi]=room.bounds;
   assert(metadata.route.some(p=>p.name.startsWith(lot.id+'/')&&Math.abs(p.at[1]-lo[1])<.01&&p.at[0]>lo[0]&&p.at[0]<hi[0]&&p.at[2]>lo[2]&&p.at[2]<hi[2]),`missing room route: ${room.name}`);
  }
 }
 for(const group of Object.values(metadata.shotGroups))assert(s.nodeGroups.some(g=>g.includes(group)),`missing damage target: ${group}`);
 assert(metadata.route.some(p=>p.name==='crosswalk-exit'));
 assert.equal(metadata.acceptance.readyForRelease,false);
});
