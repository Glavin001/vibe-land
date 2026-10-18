// Extract the exact deployed template geometry, recentered for isolated physics.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectSceneBundle,decodeSceneBundle} from '../../src/scene-binary.mjs';
import {KIT} from '../../src/dependencies.mjs';
const bytes=readFileSync(`${KIT}/out/bayline-framed-36.vlsp`),{header:h,payload}=inspectSceneBundle(bytes);
const sha=b=>createHash('sha256').update(b).digest();
for(const [index,name] of [[0,'bungalow'],[1,'porch-house']]){
 const inst={...h.instances[index],position:[0,0,0],yaw:0,mirror:false,groupSuffix:'',group:null},t=h.templates[inst.template];
 const json=Buffer.from(JSON.stringify({...h,instances:[inst]})),body=Buffer.concat([json,Buffer.alloc((8-json.length%8)%8),payload]),prefix=Buffer.from(bytes.subarray(0,64));
 prefix.writeUInt32LE(json.length,8);prefix.writeUInt32LE(t.nodeCount,24);prefix.writeUInt32LE(t.bondCount,28);sha(body).copy(prefix,32);
 const {pack}=decodeSceneBundle(Buffer.concat([prefix,body]));
 for(const kind of ['cannonball','meteor']){
  const dir=`${KIT}/out/reviews/house-cannonball/video-${name}-${kind}`;mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/asset.json`,JSON.stringify(pack),{flag:'wx'});
  writeFileSync(`${dir}/shot.json`,JSON.stringify({kind,position:kind==='meteor'?[0,2,0]:[-9,1.5,0],direction:[1,0,0],seed:20260921,sampleTicks:4,durationTicks:1800}));
  writeFileSync(`${dir}/source.json`,JSON.stringify({sceneSha256:sha(bytes).toString('hex'),instance:index,lot:h.metadata.instances[index],isolatedAtOrigin:true}));
 }
}
