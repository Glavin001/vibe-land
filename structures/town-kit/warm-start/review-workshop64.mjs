// Follow-up for the remaining difficult placement. Both cases are diagnostics:
// one changes only the solve budget, the other changes only floor/table geometry.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {validate} from '../src/validate.mjs';
import {hash} from './bundle.mjs';
process.chdir(KIT);
const auditRoot=JSON.parse(readFileSync('out/reviews/building-audit-latest.json')).root;
const item=JSON.parse(readFileSync(path.join(auditRoot,'audit.json'))).results.find(r=>r.id==='foundry-workshop-64');
const floorRoot=JSON.parse(readFileSync('out/reviews/workshop-floor-latest.json')).root;
const root=path.resolve(`out/reviews/workshop64-followup-${Date.now()}`);mkdirSync(root,{recursive:true});
const lock='out/native-review.lock',fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,root}));closeSync(fd);
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
const binary=path.join(root,'town-kit-review');copyFileSync(path.join(auditRoot,'town-kit-review'),binary);
const report={complete:false,diagnostic:true,productionChanged:false,results:[]};const save=()=>writeFileSync(path.join(root,'review.json'),JSON.stringify(report,null,2));save();writeFileSync('out/reviews/workshop64-latest.json',JSON.stringify({root}));
for(const [name,input,iterations,shift] of [
 ['original-budget32',path.join(auditRoot,`${item.index}-${item.id}/asset.json`),32,false],
 ['floor45-table-shift15',path.join(floorRoot,item.id,'asset.json'),16,true]]){
 const pack=JSON.parse(readFileSync(input)),s=pack.scenario;
 if(shift){const selected=new Set(s.nodeGroups.flatMap((g,i)=>g===`table-0@${item.id}`?[i]:[]));if(selected.size!==12)throw Error('Table membership');
  const angle=item.yaw*Math.PI/180,move=p=>{p.x=Math.round((p.x-.15*Math.sin(angle))*1e6)/1e6;p.z=Math.round((p.z-.15*Math.cos(angle))*1e6)/1e6;};
  for(const i of selected)move(s.nodes[i].centroid);
  for(const b of s.bonds){if(selected.has(b.node0)!==selected.has(b.node1))throw Error('Table is bonded to construction');if(selected.has(b.node0))move(b.centroid);}
 }
 const dir=path.join(root,name);mkdirSync(dir);const file=path.join(dir,'asset.json'),data=JSON.stringify(pack),validation=validate(pack);if(!validation.passed)throw Error('Invalid geometry');writeFileSync(file,data);writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({validation,assetSha256:hash(data)}));
 const log=openSync(path.join(dir,'run.log'),'w'),code=await new Promise((resolve,reject)=>{const child=spawn('timeout',['600s',binary,file,'stability',dir],{stdio:['ignore',log,log],env:{...process.env,TOWN_KIT_ITERATIONS:String(iterations),TOWN_KIT_COMPACT_GPU:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:'/root/workspace/physx-2/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64'}});child.on('error',reject);child.on('exit',resolve);});closeSync(log);
 const f=path.join(dir,'report.json'),native=existsSync(f)?JSON.parse(readFileSync(f)):null;const row={name,iterations,code,native,passed:code===0&&native?.passed===true};report.results.push(row);save();console.log(`${name}: ${row.passed?'PASS':'FAIL'} ${native?.error??''}`);
}
report.complete=true;save();console.log(JSON.stringify({root,complete:true}));
