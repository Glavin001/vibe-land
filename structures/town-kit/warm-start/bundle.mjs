/** VLSW v1: unchanged VLSP plus verified, per-placement physical bond guesses.
 * No GPU pointers, transient bodies, convergence flags or settled certificates.
 */
import {createHash} from 'node:crypto';
import {inspectSceneBundle} from '../src/scene-binary.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const align=n=>Math.ceil(n/8)*8;
const fail=m=>{throw Error(`VLSW: ${m}`);};
const digest=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export function encodeWarmBundle(scene, descriptor, values){
 scene=Buffer.from(scene);values=Buffer.from(values);
 const json=Buffer.from(JSON.stringify(descriptor));
 const out=Buffer.alloc(64+align(json.length)+scene.length+values.length);
 out.write('VLSW');out.writeUInt32LE(1,4);out.writeUInt32LE(json.length,8);
 out.writeUInt32LE(scene.length,12);out.writeUInt32LE(values.length/4,16);
 json.copy(out,64);scene.copy(out,64+align(json.length));values.copy(out,64+align(json.length)+scene.length);
 Buffer.from(hash(out.subarray(64)),'hex').copy(out,32);
 decodeWarmBundle(out);return out;
}
export function decodeWarmBundle(input){
 const bytes=Buffer.from(input);
 if(bytes.length<64||bytes.toString('ascii',0,4)!=='VLSW'||bytes.readUInt32LE(4)!==1)fail('magic/version');
 const d=bytes.readUInt32LE(8),s=bytes.readUInt32LE(12),n=bytes.readUInt32LE(16),start=64+align(d);
 if(d>16*1024*1024||s>512*1024*1024||n>48_000_000||start+s+n*4!==bytes.length)fail('length/bounds');
 if(bytes.subarray(20,32).some(x=>x)||bytes.subarray(64+d,start).some(x=>x))fail('reserved bytes');
 if(hash(bytes.subarray(64))!==bytes.subarray(32,64).toString('hex'))fail('checksum');
 const descriptor=JSON.parse(bytes.toString('utf8',64,64+d)),scene=bytes.subarray(start,start+s),values=bytes.subarray(start+s);
 const {header}=inspectSceneBundle(scene);
 if(descriptor.version!==1||!digest(descriptor.runtimeSha256)||!digest(descriptor.sdkProvenanceSha256)||descriptor.sceneSha256!==hash(scene))fail('provenance');
 if(JSON.stringify(descriptor.gravity)!=='[0,-9.81,0]'||descriptor.timestep!==1/60||descriptor.tolerance!==1e-5)fail('physical settings');
 if(!Array.isArray(descriptor.structures)||descriptor.structures.length!==header.instances.length)fail('placement count');
 let offset=0,covered=0;
 for(const [i,r] of descriptor.structures.entries()){
  const t=header.templates[header.instances[i].template];
  if(!t||!Number.isInteger(t.nodeCount)||t.nodeCount<1||t.nodeCount>65536||!Number.isInteger(t.bondCount)||t.bondCount<0||t.bondCount>1048576)fail('structure bounds');
  if(r.instance!==i||r.nodeCount!==t.nodeCount||r.bondCount!==t.bondCount||r.valueOffset!==offset)fail('placement binding');
  if(r.baked){if(!digest(r.evidenceSha256))fail('missing evidence');covered++;}
  else if(r.baked!==false||r.evidenceSha256!==null)fail('invalid cold placement');
  for(let j=0;j<t.bondCount*6;j++){
   const v=values.readFloatLE((offset+j)*4);
   if(!Number.isFinite(v)||(!r.baked&&v!==0))fail('invalid guess');
  }
  offset+=t.bondCount*6;
 }
 if(offset!==n||descriptor.complete!==(covered===header.instances.length))fail('coverage');
 return {descriptor,scene,values};
}
export {hash};
