import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../../client/node_modules/three/build/three.module.js';
import {buildTree,TREE_FAMILIES} from '../src/tree.mjs';
import {buildOutdoorProp,OUTDOOR_PROP_TYPES} from '../src/outdoor-props.mjs';
import {buildOutdoorEncounter,buildTreeReuseFixture,ENCOUNTERS,routeBlocked} from '../src/outdoor-scenes.mjs';
import {composeVisuals,validateVisuals,assetHash} from '../src/outdoor-visuals.mjs';
import {composeScene,boundsFor} from '../src/geometry.mjs';
import {validate} from '../src/validate.mjs';
import {encodeSceneBundle,decodeSceneBundle} from '../src/scene-binary.mjs';

function connected(s,excluded=new Set()){
 const neighbors=s.nodes.map(()=>[]);s.bonds.forEach((b,i)=>{if(!excluded.has(i)){neighbors[b.node0].push(b.node1);neighbors[b.node1].push(b.node0);}});
 const seen=new Set(),groups=[];for(let i=0;i<s.nodes.length;i++){if(seen.has(i))continue;const group=[],queue=[i];seen.add(i);for(const j of queue){group.push(j);for(const k of neighbors[j])if(!seen.has(k)){seen.add(k);queue.push(k);}}groups.push(group);}return groups;
}
test('every outdoor asset has valid, nonoverlapping physical geometry and grounded support',()=>{
 for(const type of OUTDOOR_PROP_TYPES){const {pack}=buildOutdoorProp(type),v=validate(pack),s=pack.scenario;assert(v.passed,`${type}: ${v.errors}`);
  assert.equal(v.components,type==='bike-rack'?4:1,type);
  for(const group of connected(s))assert(group.some(i=>{const c=s.nodeColliders[i],b=boundsFor(s.nodes[i],c);return b[0][1]<=0;}),`${type} floats`);
  assert(s.bonds.length>0,type);
 }
});
test('tree seeds are deterministic, distinct and bounded; all leaves belong to moving wood',()=>{
 const hashes=new Set();
 for(const family of TREE_FAMILIES)for(let variant=0;variant<3;variant++){
  const asset=buildTree({family,variant}),s=asset.pack.scenario,v=validate(asset.pack);assert(v.passed,v.errors.join('\n'));assert.equal(v.components,1);
  assert(s.nodes.length<=(family==='sapling'?8:40));assert.equal(s.nodes.filter(n=>n.mass===0).length,1);
  const hash=assetHash(asset.pack);assert.equal(hash,assetHash(buildTree({family,variant}).pack));assert(!hashes.has(hash));hashes.add(hash);
  const visuals=composeVisuals([asset],asset.pack);assert(validateVisuals(visuals,asset.pack));
  for(const attachment of visuals.attachments){assert(s.nodes[attachment.owner].mass>0);const counts=attachment.levels.map(l=>l.meshes.reduce((n,id)=>n+visuals.meshes[id].indices.length,0));assert(counts[0]>counts[1]&&counts[1]>counts[2]);}
 }
});
test('severing a limb releases its branch subtree; a trunk cut releases the connected crown',()=>{
 const {pack,visuals}=buildTree(),s=pack.scenario;
 const trunk=s.nodeTypes.map((t,i)=>t==='trunk'?i:-1).filter(i=>i>=0),limb=s.nodeTypes.indexOf('major-limb');
 const joint=s.bonds.findIndex(b=>b.node1===limb),limbGroups=connected(s,new Set([joint]));
 assert.equal(limbGroups.length,2);const detached=limbGroups.find(g=>g.includes(limb));assert.equal(detached.length,3);
 assert(visuals.attachments.some(a=>detached.includes(a.owner)));assert(!detached.some(i=>s.nodes[i].mass===0));
 const cut=s.bonds.findIndex(b=>b.node0===trunk[0]&&b.node1===trunk[1]);
 const groups=connected(s,new Set([cut])),crown=groups.find(g=>g.includes(trunk.at(-1)));
 assert.equal(groups.length,2);assert(!crown.some(i=>s.nodes[i].mass===0));assert(visuals.attachments.every(a=>crown.includes(a.owner)));
});
test('support loss disconnects shelter roof and billboard panels from ground',()=>{
 for(const type of ['bus-shelter','carport','market-stall','billboard','scaffold']){
  const {pack}=buildOutdoorProp(type),s=pack.scenario;
  const cuts=new Set(s.bonds.map((b,i)=>s.nodes[b.node0].mass===0||s.nodes[b.node1].mass===0?i:-1).filter(i=>i>=0));
  const groups=connected(s,cuts);assert(groups.some(g=>g.some(i=>s.nodes[i].centroid.y>2)&&g.every(i=>s.nodes[i].mass>0)),type);
 }
});
test('visual attachment transforms and owners survive rotation, mirroring and nested composition',()=>{
 const a=buildTree({family:'sapling'}),placements=[{...a,position:[10,0,-3],yaw:90,mirror:true},{...a,position:[-8,0,0],yaw:270}];
 const pack=composeScene(placements),visuals=composeVisuals(placements,pack);
 const original=a.visuals.attachments[0],attachment=visuals.attachments[0];assert.equal(attachment.owner,original.owner);
 const old=a.pack.scenario.nodes[original.owner].centroid,newNode=pack.scenario.nodes[attachment.owner].centroid;
 const before=new THREE.Vector3(...original.position).add(new THREE.Vector3(old.x,old.y,old.z));
 const after=new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(attachment.matrix)).add(new THREE.Vector3(newNode.x,newNode.y,newNode.z));
 assert(after.distanceTo(new THREE.Vector3(before.z+10,before.y,before.x-3))<1e-5);
 assert.equal(visuals.attachments[a.visuals.attachments.length].owner,original.owner+a.pack.scenario.nodes.length);
 const nested=composeScene([{pack,yaw:90}]),nestedVisuals=composeVisuals([{pack,visuals,yaw:90}],nested);assert(validateVisuals(nestedVisuals,nested));
 const bad=structuredClone(visuals);bad.physicsSha256='wrong';assert.throws(()=>validateVisuals(bad,pack));
 const owner=structuredClone(visuals);owner.attachments[0].owner=pack.scenario.nodes.length;assert.throws(()=>validateVisuals(owner,pack));
});
test('physics binary round trip preserves outdoor graphs and visual metadata',()=>{
 const asset=buildTree({family:'street'}),visuals=composeVisuals([asset],asset.pack),metadata={visuals:{version:1,file:'tree.visuals.json',sha256:'test-reference'}};
 const decoded=decodeSceneBundle(encodeSceneBundle([asset],{metadata}));
 assert.deepEqual(decoded.metadata.visuals,metadata.visuals);assert.equal(decoded.pack.scenario.nodes.length,asset.pack.scenario.nodes.length);assert.deepEqual(decoded.pack.scenario.bonds,asset.pack.scenario.bonds);
 assert.equal(visuals.attachments[0].owner,asset.visuals.attachments[0].owner);
});
test('all encounter layouts have clear continuous lanes and independent destructible assets',()=>{
 for(const kind of ENCOUNTERS){const a=buildOutdoorEncounter(kind),s=a.pack.scenario,v=validate(a.pack);assert(v.passed,`${kind}: ${v.errors}`);
  assert(s.bonds.every(b=>s.nodeGroups[b.node0]===s.nodeGroups[b.node1]));
  s.nodes.forEach((n,i)=>{const c=s.nodeColliders[i],b=boundsFor(n,c.kind==='shape'?s.shapeLibrary[c.shape]:c);assert(!routeBlocked(b,a.metadata.route,a.metadata.gameplay.laneWidth/2),`${kind} route blocked by ${i}`);});
 }
 assert(routeBlocked([[-.2,0,-.2],[.2,2,.2]],[{at:[-2,0,0]},{at:[2,0,0]}]));
});
test('100-tree fixture reuses 15 visual templates rather than generating meshes per placement',()=>{
 const a=buildTreeReuseFixture();assert.equal(a.placements.length,100);assert.equal(Object.keys(a.visuals.meshes).length,15*6);assert.equal(connected(a.pack.scenario).length,100);
});
