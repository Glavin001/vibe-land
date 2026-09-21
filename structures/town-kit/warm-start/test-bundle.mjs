import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {encodeSceneBundle,inspectSceneBundle} from '../src/scene-binary.mjs';
import {encodeWarmBundle,decodeWarmBundle,hash} from './bundle.mjs';
import {KIT} from '../src/dependencies.mjs';
const root=JSON.parse(readFileSync(`${KIT}/out/reviews/building-audit-latest.json`)).root;
const audit=JSON.parse(readFileSync(`${root}/audit.json`));
const asset=audit.results[0],pack=JSON.parse(readFileSync(`${root}/${asset.index}-${asset.id}/asset.json`));
const scene=encodeSceneBundle([{pack},{pack,position:[40,0,0],yaw:90}]),{header}=inspectSceneBundle(scene);
let offset=0;
const structures=header.instances.map((i,index)=>{const t=header.templates[i.template],r={instance:index,nodeCount:t.nodeCount,bondCount:t.bondCount,valueOffset:offset,baked:index===0,evidenceSha256:index===0?'a'.repeat(64):null};offset+=t.bondCount*6;return r;});
const values=Buffer.alloc(offset*4);for(let i=0;i<structures[0].bondCount*6;i++)values.writeFloatLE((i%37-18)/13,i*4);
const descriptor={version:1,sceneSha256:hash(scene),runtimeSha256:'b'.repeat(64),sdkProvenanceSha256:'c'.repeat(64),gravity:[0,-9.81,0],timestep:1/60,tolerance:1e-5,complete:false,structures};
const bytes=encodeWarmBundle(scene,descriptor,values),decoded=decodeWarmBundle(bytes);
assert.deepEqual(decoded.scene,scene);assert.deepEqual(decoded.values,values);assert.deepEqual(encodeWarmBundle(scene,descriptor,values),bytes);
const dir=`${KIT}/out/reviews/warm-codec`;mkdirSync(dir,{recursive:true});const file=`${dir}/fixture.vlsw`,rust=`${KIT}/out/binary-target/release/town-kit-binary-review`;
writeFileSync(file,bytes);const result=JSON.parse(execFileSync(rust,['warm',file],{encoding:'utf8'}));assert.equal(result.sha256,hash(values));
let rejected=0;
function reject(b){writeFileSync(file,b);assert.throws(()=>decodeWarmBundle(b));execFileSync(rust,['reject',file]);rejected++;}
const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;reject(corrupt);reject(bytes.subarray(0,63));reject(bytes.subarray(0,-1));
function mutate(mutator){const d=structuredClone(descriptor);mutator(d);const json=Buffer.from(JSON.stringify(d)),start=64+Math.ceil(json.length/8)*8,b=Buffer.alloc(start+scene.length+values.length);bytes.copy(b,0,0,64);b.writeUInt32LE(json.length,8);json.copy(b,64);scene.copy(b,start);values.copy(b,start+scene.length);Buffer.from(hash(b.subarray(64)),'hex').copy(b,32);reject(b);}
mutate(d=>d.sceneSha256='d'.repeat(64));mutate(d=>d.structures[0].bondCount++);mutate(d=>d.structures[1].instance=0);mutate(d=>d.complete=true);mutate(d=>d.structures[0].evidenceSha256=null);mutate(d=>d.timestep=1/30);
for(const value of [NaN,Infinity]){const b=Buffer.from(bytes);b.writeFloatLE(value,b.length-values.length);Buffer.from(hash(b.subarray(64)),'hex').copy(b,32);reject(b);}
const cold=Buffer.from(bytes);cold.writeFloatLE(1,cold.length-4);Buffer.from(hash(cold.subarray(64)),'hex').copy(cold,32);reject(cold);
unlinkSync(file);const report={passed:true,codecOnly:true,deterministic:true,crossLanguage:true,invalidCasesRejected:rejected,placements:2,rotationDegrees:90,values:offset};writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));console.log(report);
