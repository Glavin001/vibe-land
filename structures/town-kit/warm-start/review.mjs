/** Sequential native bake + reload review for one exact deployed placement.
 * The complete audit remains the authority on town readiness. A passing pilot
 * does not qualify missing placements or the assembled town.
 */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {inspectSceneBundle} from '../src/scene-binary.mjs';
import {encodeWarmBundle,decodeWarmBundle,hash} from './bundle.mjs';
process.chdir(KIT);
const auditRoot=JSON.parse(readFileSync('out/reviews/building-audit-latest.json')).root;
const audit=JSON.parse(readFileSync(path.join(auditRoot,'audit.json')));
const id=process.argv[2]??'garden-bungalow-1',item=audit.results.find(r=>r.id===id);
if(!item?.passed)throw Error('Choose an exact placement with a passing intact audit');
const scene=readFileSync('out/bayline-civic-town.vlsp');if(hash(scene)!==audit.sceneSha256)throw Error('Scene changed since audit');
const root=path.resolve(`out/reviews/warm-${id}-${Date.now()}`);mkdirSync(root,{recursive:true});
const lock='out/native-review.lock',fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,root}));closeSync(fd);
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
const file=path.join(root,'asset.json'),metaFile=path.join(root,'asset.meta.json');
copyFileSync(path.join(auditRoot,`${item.index}-${id}/asset.json`),file);
copyFileSync(path.join(auditRoot,`${item.index}-${id}/asset.meta.json`),metaFile);
const pack=JSON.parse(readFileSync(file)),meta=JSON.parse(readFileSync(metaFile)),s=pack.scenario;
// Impact an actual table from above; the cache must not inhibit changed-load
// solving, breakage, fragment creation or return to converged physical rest.
const table=s.nodeTypes.findIndex(t=>t==='table-top');
if(table>=0){const c=s.nodes[table].centroid;meta.shots={furniture:[{from:[c.x,c.y+.85,c.z],to:[c.x,c.y,c.z],momentum:40000,radius:.3,speed:30,tick:0}]};meta.shotGroups={furniture:s.nodeGroups[table]};}
writeFileSync(metaFile,JSON.stringify(meta));
const sdk='/root/workspace/physx-2',runtimeDir=path.resolve('out/warm-runtime/native-runtime'),runtime=path.join(runtimeDir,'libPhysXDestructionGpuRuntime_64.so');
const binary=path.join(root,'town-kit-review');copyFileSync('native/target/release/town-kit-review',binary);
const report={passed:false,exclusiveGpu:false,sceneSha256:hash(scene),assetSha256:hash(readFileSync(file)),runtimeSha256:hash(readFileSync(runtime)),sdkProvenanceSha256:hash(readFileSync(`${sdk}/out/sdk-artifacts.json`)),sdkPatchSha256:hash(execFileSync('git',['diff','--binary'],{cwd:sdk})),binarySha256:hash(readFileSync(binary)),instance:item.index,id,cases:[]};
const save=()=>writeFileSync(path.join(root,'review.json'),JSON.stringify(report,null,2));save();
writeFileSync('out/reviews/warm-latest.json',JSON.stringify({root}));
async function run(name,mode,extra={}){
 const dir=path.join(root,name);mkdirSync(dir);const log=openSync(path.join(dir,'run.log'),'w');
 const code=await new Promise((resolve,reject)=>{const child=spawn('timeout',['600s',binary,file,mode,dir],{stdio:['ignore',log,log],env:{...process.env,TOWN_KIT_COMPACT_GPU:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:`${runtimeDir}:${sdk}/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64`,...extra}});child.on('error',reject);child.on('exit',resolve);});closeSync(log);
 const out=path.join(dir,'report.json'),native=existsSync(out)?JSON.parse(readFileSync(out)):null;
 const row={name,mode,code,native,passed:code===0&&native?.passed===true};report.cases.push(row);save();console.log(`${id} ${name}: ${row.passed?'PASS':'FAIL'} ${native?.error??''}`);
 if(!row.passed)throw Error(`Native review failed: ${out}`);
 if(native.warmRuntime.sha256!==report.runtimeSha256)throw Error('Unexpected loaded runtime');
 return {native,bytes:readFileSync(out)};
}
const raw=path.join(root,'forces.f32');
const cold=await run('cold','stability',{TOWN_KIT_WARM_OUT:raw});
const {header}=inspectSceneBundle(scene);let offset=0;
const structures=header.instances.map((p,index)=>{const t=header.templates[p.template],r={instance:index,nodeCount:t.nodeCount,bondCount:t.bondCount,valueOffset:offset,baked:index===item.index,evidenceSha256:index===item.index?hash(cold.bytes):null};offset+=t.bondCount*6;return r;});
const values=Buffer.alloc(offset*4),forces=readFileSync(raw);if(forces.length!==structures[item.index].bondCount*24)throw Error('Export length');forces.copy(values,structures[item.index].valueOffset*4);
const descriptor={version:1,sceneSha256:hash(scene),runtimeSha256:report.runtimeSha256,sdkProvenanceSha256:report.sdkProvenanceSha256,gravity:[0,-9.81,0],timestep:1/60,tolerance:1e-5,complete:false,structures};
const bundle=encodeWarmBundle(scene,descriptor,values),fileOut=path.join(root,'pilot-town.vlsw');writeFileSync(fileOut,bundle);
// Verify the independently implemented Rust reader sees identical f32 bits.
const rust=JSON.parse(execFileSync(path.resolve('out/binary-target/release/town-kit-binary-review'),['warm',fileOut],{encoding:'utf8'}));if(rust.sha256!==hash(values))throw Error('Rust warm mismatch');
const decoded=decodeWarmBundle(readFileSync(fileOut)),r=decoded.descriptor.structures[item.index],reload=path.join(root,'reloaded.f32');
writeFileSync(reload,decoded.values.subarray(r.valueOffset*4,(r.valueOffset+r.bondCount*6)*4));
await run('warm','stability',{TOWN_KIT_WARM_IN:reload});
if(table>=0)await run('warm-damage','furniture',{TOWN_KIT_WARM_IN:reload});
report.passed=true;report.bundle=fileOut;report.completeTownQualified=false;save();console.log(JSON.stringify({root,passed:true,bundle:fileOut,completeTownQualified:false}));
