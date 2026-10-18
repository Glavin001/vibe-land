/** Isolated authoring experiment: a 45 mm oak wearing floor on a 135 mm
 * subfloor, preserving the original 180 mm floor height and all loose props.
 * This prevents the support collider lying only 12 mm below the top surface
 * from sharing the table foot's 20 mm contact-offset envelope.
 * Original source files and deployed assets are never rewritten.
 */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {KIT} from '../src/dependencies.mjs';
import {composeScene} from '../src/geometry.mjs';
import {validate} from '../src/validate.mjs';
import {hash} from './bundle.mjs';
process.chdir(KIT);
const auditRoot=JSON.parse(readFileSync('out/reviews/building-audit-latest.json')).root,audit=JSON.parse(readFileSync(path.join(auditRoot,'audit.json')));
const root=path.resolve(`out/reviews/workshop-floor-contact-${Date.now()}`);mkdirSync(root,{recursive:true});
const lock='out/native-review.lock';let acquired=false;
while(!acquired){try{const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,root}));closeSync(fd);acquired=true;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,2000));}}
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
const source=path.join(root,'source');mkdirSync(source);
const originals=['src/parts/envelope.mjs','src/parts/building.mjs','src/workshop.mjs'];
const mapping=new Map(originals.map(f=>[path.resolve(f),path.join(source,path.basename(f))]));
for(const file of originals){let code=readFileSync(file,'utf8');if(file.endsWith('envelope.mjs'))code=code.replaceAll('y-.012','y-.045');
 code=code.replace(/from\s*(['"])(\.[^'"]+)\1/g,(match,quote,rel)=>{const actual=path.resolve(path.dirname(file),rel);return `from '${pathToFileURL(mapping.get(actual)??actual).href}'`;});writeFileSync(mapping.get(path.resolve(file)),code);
}
const {buildWorkshop}=await import(pathToFileURL(path.join(source,'workshop.mjs')).href);
const binary=path.join(root,'town-kit-review');copyFileSync(path.join(auditRoot,'town-kit-review'),binary);
const report={complete:false,passed:false,diagnostic:true,sourceAuditSha256:hash(readFileSync(path.join(auditRoot,'audit.json'))),change:'45 mm floor wearing layer; same total 180 mm slab depth; default table positions, physical settings and strengths',results:[]};
const save=()=>writeFileSync(path.join(root,'review.json'),JSON.stringify(report,null,2));save();writeFileSync('out/reviews/workshop-floor-latest.json',JSON.stringify({root}));
for(const item of audit.results.filter(r=>!r.passed)){
 const asset=buildWorkshop(item.options);asset.pack.scenario.nodeGroups=asset.pack.scenario.nodeGroups.map(g=>`${g}@${item.id}`);
 const pack=composeScene([{pack:asset.pack,position:item.position,yaw:item.yaw}],{key:item.id,title:item.id});
 const validation=validate(pack),dir=path.join(root,item.id);mkdirSync(dir);const file=path.join(dir,'asset.json'),data=JSON.stringify(pack);writeFileSync(file,data);writeFileSync(path.join(dir,'asset.meta.json'),JSON.stringify({validation,assetSha256:hash(data)}));
 if(!validation.passed)throw Error(`Invalid candidate geometry: ${validation.errors.join(';')}`);
 const log=openSync(path.join(dir,'run.log'),'w'),code=await new Promise((resolve,reject)=>{const child=spawn('timeout',['600s',binary,file,'stability',dir],{stdio:['ignore',log,log],env:{...process.env,TOWN_KIT_COMPACT_GPU:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:'/root/workspace/physx-2/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64'}});child.on('error',reject);child.on('exit',resolve);});closeSync(log);
 const output=path.join(dir,'report.json'),native=existsSync(output)?JSON.parse(readFileSync(output)):null;report.results.push({id:item.id,code,passed:code===0&&native?.passed===true,native});save();console.log(`${item.id}: ${report.results.at(-1).passed?'PASS':'FAIL'} ${native?.error??''}`);
}
report.complete=report.results.length===3;report.passed=report.complete&&report.results.every(r=>r.passed);save();console.log(JSON.stringify({root,complete:report.complete,passed:report.passed}));
