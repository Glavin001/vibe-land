/** Opt-in deployment recipe: framed homes + unchanged shops and fixed streets. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {KIT} from '../src/dependencies.mjs';
import {buildFramedPorchHouse,buildFramedBungalow} from '../src/framed-houses.mjs';
import {inspectSceneBundle,decodeSceneBundle,encodeSceneBundle} from '../src/scene-binary.mjs';
import {boundsFor} from '../src/geometry.mjs';
import {placementPoint} from '../src/bayline-town.mjs';
import {validate} from '../src/validate.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
// TOWN_KIT_IMPACT_PROFILE=residential-v2 builds the homes with the thin
// slate/sheathing roof, joisted ceiling, timber joints and single-skin
// boarding that meteors actually penetrate (out/bayline-framed-36-v2.vlsp);
// unset keeps the original 100 mm covering and ceiling deck.
const impactProfile=process.env.TOWN_KIT_IMPACT_PROFILE||null;
const key=impactProfile?`bayline-framed-36-${impactProfile.replace('residential-','')}`:'bayline-framed-36',input=readFileSync(`${KIT}/out/bayline-proven-36-fixedground.vlsp`);
const {header:h,payload}=inspectSceneBundle(input),metadata=structuredClone(h.metadata);
assert.equal(h.instances.length,37);assert.equal(metadata.instances.length,36);
// Decode one original template at its local origin, preserving the binary values.
function originalPack(index){
 const inst={...h.instances[index],position:[0,0,0],yaw:0,mirror:false,groupSuffix:'',group:null},t=h.templates[inst.template];
 const json=Buffer.from(JSON.stringify({...h,instances:[inst]})),body=Buffer.concat([json,Buffer.alloc((8-json.length%8)%8),payload]),prefix=Buffer.from(input.subarray(0,64));
 prefix.writeUInt32LE(json.length,8);prefix.writeUInt32LE(t.nodeCount,24);prefix.writeUInt32LE(t.bondCount,28);Buffer.from(sha(body),'hex').copy(prefix,32);
 return decodeSceneBundle(Buffer.concat([prefix,body])).pack;
}
const placements=[],cache=new Map(),checks=[];let offset=0,replaced=0;
for(let i=0;i<h.instances.length;i++){
 const inst=h.instances[i],lot=metadata.instances[i];let pack;
 if(lot&&['house','bungalow'].includes(lot.builder)){
  const cacheKey=JSON.stringify([lot.builder,impactProfile?{...lot.options,impactProfile}:lot.options]);
  if(!cache.has(cacheKey)){
   const a=(lot.builder==='house'?buildFramedPorchHouse:buildFramedBungalow)(impactProfile?{...lot.options,impactProfile}:lot.options),validation=validate(a.pack);
   assert(validation.passed,JSON.stringify(validation));cache.set(cacheKey,a);checks.push({options:lot.options,builder:lot.builder,validation});
  }
  const a=cache.get(cacheKey);pack=a.pack;replaced++;
  lot.options=a.metadata.options;lot.structure=a.metadata.structure;lot.sourceSha256=sha(JSON.stringify(pack));lot.templateKey=cacheKey;
  const s=pack.scenario,bs=s.nodes.map((n,j)=>boundsFor(n,s.nodeColliders[j].kind==='shape'?s.shapeLibrary[s.nodeColliders[j].shape]:s.nodeColliders[j]));
  const local=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...bs.map(b=>b[end][k]))));
  const world=local.map(p=>placementPoint(p,lot));lot.bounds=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...world.map(p=>p[k]))));
 }else pack=originalPack(i);
 if(lot){lot.nodeStart=offset;lot.nodeCount=pack.scenario.nodes.length;lot.bondCount=pack.scenario.bonds.length;}
 offset+=pack.scenario.nodes.length;
 placements.push({pack,position:inst.position,yaw:inst.yaw,mirror:inst.mirror,groupSuffix:inst.groupSuffix,group:inst.group});
}
assert.equal(replaced,24);
const ground=placements.at(-1).pack.scenario;
for(let i=0;i<ground.nodes.length;i++)if(['foundation','road','paving','road-marking'].includes(ground.nodeTypes[i]))assert.equal(ground.nodes[i].mass,0,'Ground must remain fixed');
metadata.composition={...metadata.composition,buildings:36,framedHomes:24,unchangedShops:12};
metadata.acceptance=impactProfile
 ?{readyForRelease:false,note:`Framed town with the ${impactProfile} homes: 30 mm roof covering, joisted ceiling, timber joints, single-skin boarding. Isolated meteor/cannonball settling qualified 2026-09-22 with the fragment depenetration cap and stabilization off; whole-town qualification is the deployment bench.`}
 :{readyForRelease:false,note:'Experimental framed town. Selected isolated skeletons and intact houses passed; full variant, assembled idle, traversal and damaged-settling qualification remains incomplete. Some rubble cases fail. No old stress warm values are reused.'};
const source=await sourceProvenance(),provenance={recipe:key,parentSceneSha256:sha(input),generatorFingerprint:source.contentHash,vibeRevision:source.vibeRevision,authoringRevision:source.authoringRevision};
const args={key,title:impactProfile?'Bayline · Framed homes (thin roofs) and high street':'Bayline · Framed homes and high street',metadata,provenance};
const bytes=encodeSceneBundle(placements,args);assert(bytes.equals(encodeSceneBundle(placements,args)),'Nondeterministic encoding');
const decoded=decodeSceneBundle(bytes),s=decoded.pack.scenario;
// Binary instance spans are disjoint; verify no bond links two buildings.
let at=0,ba=0;for(const p of placements){const end=at+p.pack.scenario.nodes.length;for(let j=0;j<p.pack.scenario.bonds.length;j++){const b=s.bonds[ba++];assert(b.node0>=at&&b.node0<end&&b.node1>=at&&b.node1<end);}at=end;}
const {header,expandedNodes,expandedBonds}=inspectSceneBundle(bytes),output=`${KIT}/out/${key}.vlsp`;
writeFileSync(output+'.tmp',bytes);renameSync(output+'.tmp',output);
const report={output,sceneSha256:sha(bytes),bytes:bytes.length,buildings:36,structures:37,replacedHomes:replaced,templates:header.templates.length,chunks:expandedNodes,bonds:expandedBonds,fixedGroundNodes:ground.nodes.filter(n=>n.mass===0).length,provenance,acceptance:metadata.acceptance,checks};
writeFileSync(`${KIT}/out/${key}.build.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,checks:checks.map(c=>({builder:c.builder,options:c.options,passed:c.validation.passed}))},null,2));
