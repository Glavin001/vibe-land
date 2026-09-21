/** Owned sequential follow-up. Tests a layout correction, never changes strength,
 * gravity, solver tolerance, freezing or the deployed asset. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {validate} from '../src/validate.mjs';
import {hash} from './bundle.mjs';
process.chdir(KIT);
const oldRoot=JSON.parse(readFileSync('out/reviews/building-audit-latest.json')).root;
const audit=JSON.parse(readFileSync(path.join(oldRoot,'audit.json')));
const root=path.resolve(`out/reviews/workshop-table-contact-${Date.now()}`);mkdirSync(root,{recursive:true});
const lock='out/native-review.lock';let acquired=false;
while(!acquired){try{const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,root}));closeSync(fd);acquired=true;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,2000));}}
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
// Pin the same SDK/harness as the original audit; isolate the geometry change.
const binary=path.join(root,'town-kit-review');copyFileSync(path.join(oldRoot,'town-kit-review'),binary);
const report={complete:false,passed:false,change:'Move office table 0.15 m toward the front, off the floor-finish seam; all masses, bonds and strengths unchanged.',sourceAuditSha256:hash(readFileSync(path.join(oldRoot,'audit.json'))),exclusiveGpu:false,results:[]};
const save=()=>writeFileSync(path.join(root,'review.json'),JSON.stringify(report,null,2));save();writeFileSync('out/reviews/workshop-contact-latest.json',JSON.stringify({root}));
const cases=audit.results.filter(r=>r.builder==='workshop').sort((a,b)=>Number(a.passed)-Number(b.passed));
for(const item of cases){
 const source=path.join(oldRoot,`${item.index}-${item.id}`),pack=JSON.parse(readFileSync(path.join(source,'asset.json'))),s=pack.scenario;
 const indices=new Set(s.nodeGroups.flatMap((g,i)=>g===`table-0@${item.id}`?[i]:[]));if(indices.size!==12)throw Error('Unexpected table membership');
 const a=item.yaw*Math.PI/180,delta=[-.15*Math.sin(a),0,-.15*Math.cos(a)];
 const move=p=>{p.x=Math.round((p.x+delta[0])*1e6)/1e6;p.z=Math.round((p.z+delta[2])*1e6)/1e6;};
 for(const i of indices)move(s.nodes[i].centroid);
 for(const b of s.bonds){if(indices.has(b.node0)!==indices.has(b.node1))throw Error('Loose table unexpectedly bonded to construction');if(indices.has(b.node0))move(b.centroid);}
 const validation=validate(pack),dir=path.join(root,item.id);mkdirSync(dir);const file=path.join(dir,'asset.json'),data=JSON.stringify(pack);writeFileSync(file,data);writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({validation,assetSha256:hash(data)}));
 if(!validation.passed)throw Error('Invalid candidate geometry');
 const log=openSync(path.join(dir,'run.log'),'w'),code=await new Promise((resolve,reject)=>{const child=spawn('timeout',['600s',binary,file,'stability',dir],{stdio:['ignore',log,log],env:{...process.env,TOWN_KIT_COMPACT_GPU:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:'/root/workspace/physx-2/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64'}});child.on('error',reject);child.on('exit',resolve);});closeSync(log);
 const output=path.join(dir,'report.json'),native=existsSync(output)?JSON.parse(readFileSync(output)):null;
 const result={id:item.id,delta,code,passed:code===0&&native?.passed===true,native};report.results.push(result);save();console.log(`${item.id}: ${result.passed?'PASS':'FAIL'} ${native?.error??''}`);
}
report.complete=report.results.length===12;report.passed=report.complete&&report.results.every(r=>r.passed);save();console.log(JSON.stringify({root,complete:report.complete,passed:report.passed}));
