import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {KIT,REPO} from '../../src/dependencies.mjs';
import {buildPorchHouse} from '../../src/porch-house.mjs';
import {buildBungalow} from '../../src/bungalow.mjs';
import {buildFramedPorchHouse,buildFramedBungalow} from '../../src/framed-houses.mjs';
import {validate} from '../../src/validate.mjs';
import {composeScene} from '../../src/geometry.mjs';
const suffix=`legacy-test-${process.pid}`,files=[];
try {
 const oldBuilding=path.join(KIT,'src/parts',`${suffix}.mjs`);files.push(oldBuilding);writeFileSync(oldBuilding,execFileSync('git',['show','HEAD:structures/town-kit/src/parts/building.mjs'],{cwd:REPO}),{flag:'wx'});
 for(const [name,builder]of [['porch-house',buildPorchHouse],['bungalow',buildBungalow]]){
  const f=path.join(KIT,'src',`${suffix}-${name}.mjs`);files.push(f);writeFileSync(f,readFileSync(path.join(KIT,'src',`${name}.mjs`),'utf8').replace("'./parts/building.mjs'",`'./parts/${suffix}.mjs'`),{flag:'wx'});
  const old=await import(pathToFileURL(f));const oldBuilder=name==='porch-house'?old.buildPorchHouse:old.buildBungalow;
  for(const options of [{},{mirrored:true,furnished:false,fence:false}])assert.deepEqual(builder(options),oldBuilder(options),'Legacy asset changed');
 }
}finally{for(const f of files)try{unlinkSync(f);}catch{}}
for(const builder of [buildFramedPorchHouse,buildFramedBungalow])for(const mirrored of [false,true]){
 const a=builder({mirrored}),b=builder({mirrored});assert.deepEqual(a,b,'Nondeterministic authoring');const v=validate(a.pack);assert.equal(v.passed,true,JSON.stringify(v.errors));
 const s=a.pack.scenario;assert(s.nodeTypes.includes('frame-post'));assert(s.nodeTypes.includes('roof-rafter'));assert(!s.nodeTypes.includes('floor-finish'));
 for(const n of s.nodes)if(n.mass===0)assert(n.centroid.y<0,'Exposed fixed anchor');
 for(const bond of s.bonds){const types=[s.nodeTypes[bond.node0],s.nodeTypes[bond.node1]];if(types.includes('wall-infill')&&types.some(t=>['frame-beam','floor','ceiling'].includes(t)))assert(Math.abs(bond.normal.y)<.001,'Cosmetic infill became vertical bearing surface');}
 assert(a.metadata.entrances.every(e=>e.clearWidth>=1));
 const reused=composeScene([{pack:a.pack},{pack:a.pack,position:[26,0,0],yaw:90}]),count=s.nodes.length;assert.equal(reused.scenario.nodes.length,count*2);assert(validate(reused).passed);assert(reused.scenario.bonds.every(b=>Math.floor(b.node0/count)===Math.floor(b.node1/count)),'Placed buildings acquired cross-bonds');
}
console.log('PASS: legacy output unchanged; deterministic mirrored frames; no overlaps; buried anchors; no infill bearing surfaces; unchanged clear entrances. Native qualification remains separate.');
