import {readFileSync,writeFileSync,mkdirSync,copyFileSync,chmodSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {decodeSceneBundle,inspectSceneBundle} from '../src/scene-binary.mjs';
import {validate} from '../src/validate.mjs';
process.chdir(KIT);
const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=readFileSync('out/bayline-civic-town.vlsp'),{header}=inspectSceneBundle(bytes),{pack,metadata}=decodeSceneBundle(bytes);
const resume=process.argv[2];
const root=resume?path.resolve(resume):path.resolve(`out/reviews/building-audit-${Date.now()}`);mkdirSync(root,{recursive:true});
const binary=path.join(root,'town-kit-review');if(!resume){copyFileSync('native/target/release/town-kit-review',binary);chmodSync(binary,0o700);}
const sdk='/root/workspace/physx-2',sdkProvenance=JSON.parse(readFileSync(`${sdk}/out/sdk-artifacts.json`));
const lock='out/native-review.lock';const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,started:new Date().toISOString(),root}));closeSync(fd);
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
const report=resume?JSON.parse(readFileSync(path.join(root,'audit.json'))):{complete:false,passed:false,sceneSha256:hash(bytes),binarySha256:hash(readFileSync(binary)),sdk:sdkProvenance,exclusiveGpu:false,results:[]};
if(report.sceneSha256!==hash(bytes)||report.binarySha256!==hash(readFileSync(binary)))throw Error('Resume input hashes changed');
const save=()=>writeFileSync(path.join(root,'audit.json'),JSON.stringify(report,null,2));save();
writeFileSync('out/reviews/building-audit-latest.json',JSON.stringify({root}));
let ns=0,bs=0;
for(const [index,placement] of header.instances.entries()){
 const t=header.templates[placement.template],ne=ns+t.nodeCount,be=bs+t.bondCount;
 const authored=metadata.instances.find(x=>x.nodeStart===ns&&x.nodeCount===t.nodeCount);
 if(!authored){ns=ne;bs=be;continue;}
 const s=pack.scenario,scenario={};
 for(const k of ['nodes','nodeSizes','nodeTypes','nodePieces','nodeGroups','nodeMaterials'])scenario[k]=s[k].slice(ns,ne);
 scenario.nodeColliders=s.nodeColliders.slice(ns,ne).map(c=>c.kind==='shape'?s.shapeLibrary[c.shape]:c);
 scenario.bonds=s.bonds.slice(bs,be).map(b=>({...b,node0:b.node0-ns,node1:b.node1-ns}));
 const p={version:2,key:authored.id,title:authored.id,defaults:pack.defaults,scenario};ns=ne;bs=be;
 if(report.results.some(r=>r.index===index&&r.exit))continue;
 const validation=validate(p),dir=path.join(root,`${index}-${authored.id}`);mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'asset.json'),data=JSON.stringify(p);writeFileSync(file,data);
 writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({validation,assetSha256:hash(data),instance:authored}));
 const result={index,id:authored.id,builder:authored.builder,options:authored.options,position:placement.position,yaw:placement.yaw,packSha256:hash(data),validation,passed:false};
 report.results.push(result);save();
 if(!validation.passed){console.log(authored.id,'geometry FAILED');continue;}
 const log=openSync(path.join(dir,'run.log'),'w');
 const exit=await new Promise((resolve,reject)=>{const child=spawn('timeout',['600s',binary,file,'stability',dir],{stdio:['ignore',log,log],env:{...process.env,TOWN_KIT_COMPACT_GPU:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:`${sdk}/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64`}});child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});closeSync(log);
 result.exit=exit;const output=path.join(dir,'report.json');if(existsSync(output))result.native=JSON.parse(readFileSync(output));result.passed=exit.code===0&&result.native?.passed===true;save();
 console.log(`${report.results.length}/67 ${authored.id}: ${result.passed?'PASS':'FAIL'} ${result.native?.error??''}`);
 // timeout waits for this native process to exit before the next case; it
 // remains a failed case with no inferred observation or convergence.
}
report.complete=report.results.length===67;report.passed=report.complete&&report.results.every(r=>r.passed);save();
console.log(JSON.stringify({root,complete:report.complete,passed:report.passed,passedCount:report.results.filter(r=>r.passed).length,total:report.results.length}));
