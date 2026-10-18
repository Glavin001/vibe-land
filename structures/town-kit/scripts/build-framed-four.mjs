/** Four independent copies of the two exact deployed/reviewed house templates. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {KIT} from '../src/dependencies.mjs';
import {inspectSceneBundle,decodeSceneBundle,encodeSceneBundle} from '../src/scene-binary.mjs';
import {validate} from '../src/validate.mjs';
import {placementPoint} from '../src/bayline-town.mjs';
const key='bayline-framed-four',input=readFileSync(`${KIT}/out/bayline-framed-36.vlsp`),{header:h,payload}=inspectSceneBundle(input);
const sha=b=>createHash('sha256').update(b).digest();
function localPack(index){
 const inst={...h.instances[index],position:[0,0,0],yaw:0,mirror:false,groupSuffix:'',group:null},t=h.templates[inst.template];
 const json=Buffer.from(JSON.stringify({...h,instances:[inst]})),body=Buffer.concat([json,Buffer.alloc((8-json.length%8)%8),payload]),prefix=Buffer.from(input.subarray(0,64));
 prefix.writeUInt32LE(json.length,8);prefix.writeUInt32LE(t.nodeCount,24);prefix.writeUInt32LE(t.bondCount,28);sha(body).copy(prefix,32);
 return decodeSceneBundle(Buffer.concat([prefix,body])).pack;
}
const packs=[localPack(0),localPack(1)];assert.equal(h.metadata.instances[0].builder,'bungalow');assert.equal(h.metadata.instances[1].builder,'house');
const lots=[{source:0,id:'bungalow-north',position:[-12,0,14],yaw:0},{source:1,id:'house-north',position:[12,0,14],yaw:0},{source:0,id:'bungalow-south',position:[-12,0,-14],yaw:180},{source:1,id:'house-south',position:[12,0,-14],yaw:180}];
const placements=lots.map(l=>({pack:packs[l.source],position:l.position,yaw:l.yaw,group:l.id}));
const instances=[],rooms=[],entrances=[];let offset=0;
for(const l of lots){
 const original=h.metadata.instances[l.source],pack=packs[l.source],point=p=>placementPoint(p.map((n,k)=>n-original.position[k]),l);
 const bounds=b=>{const a=b.map(point);return [0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...a.map(p=>p[k]))));};
 instances.push({...original,id:l.id,position:l.position,yaw:l.yaw,nodeStart:offset,nodeCount:pack.scenario.nodes.length,bondCount:pack.scenario.bonds.length,bounds:bounds(original.bounds)});offset+=pack.scenario.nodes.length;
 for(const e of h.metadata.entrances.filter(e=>e.instance===original.id))entrances.push({...e,name:e.name.replace(original.id,l.id),instance:l.id,at:point(e.at)});
 for(const r of h.metadata.rooms.filter(r=>r.instance===original.id))rooms.push({...r,name:r.name.replace(original.id,l.id),instance:l.id,bounds:bounds(r.bounds)});
}
const metadata={kind:'scene',sceneLayout:true,buildingType:'four-building-review',instances,rooms,entrances,route:[],bounds:[[-18,-.45,-21],[18,9,21]],cameras:{hero:{position:[-43,33,-43],target:[0,2,0]},street:{position:[-28,2,0],target:[8,2,0]}},composition:{buildings:4,bungalows:2,twoStoreyHouses:2},acceptance:{readyForRelease:false,note:'Diagnostic scene: known damaged-state contact/convergence issues remain.'},runtime:{VIBE_CITY_NATIVE_CORRECTION_LIMIT:'1',VIBE_CITY_GRID:'1'}};
const options={key,title:'Bayline · Four framed houses',metadata,provenance:{parentSceneSha256:sha(input).toString('hex'),recipe:'build-framed-four.mjs',recipeSha256:sha(readFileSync(new URL(import.meta.url))).toString('hex'),sourceInstances:[0,1,0,1]}};
const bytes=encodeSceneBundle(placements,options);assert(bytes.equals(encodeSceneBundle(placements,options)));
const decoded=decodeSceneBundle(bytes),validation=validate(decoded.pack);assert(validation.passed,JSON.stringify(validation));
const s=decoded.pack.scenario;assert(s.bonds.every(b=>s.nodeGroups[b.node0]===s.nodeGroups[b.node1]),'Cross-building bonds');assert.equal(new Set(s.nodeGroups).size,4);
const info=inspectSceneBundle(bytes);assert.equal(info.header.templates.length,2);assert.equal(info.header.instances.length,4);
const output=`${KIT}/out/${key}.vlsp`;writeFileSync(output+'.tmp',bytes);renameSync(output+'.tmp',output);
const report={output,bytes:bytes.length,sceneSha256:sha(bytes).toString('hex'),buildings:4,structures:4,templates:2,chunks:info.expandedNodes,bonds:info.expandedBonds,correctionLimit:1,validation};
writeFileSync(`${KIT}/out/${key}.build.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
