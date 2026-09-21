import {readFileSync,writeFileSync,mkdirSync,copyFileSync,openSync,closeSync,unlinkSync,existsSync,renameSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {inspectSceneBundle} from '../src/scene-binary.mjs';
import {encodeWarmBundle,hash} from './bundle.mjs';
process.chdir(KIT);
const scene=path.resolve('out/bayline-proven-36.vlsp'),bytes=readFileSync(scene),{header}=inspectSceneBundle(bytes);
const resume=process.argv[2];
const root=resume?path.resolve(resume):path.resolve(`out/reviews/proven-36-${Date.now()}`);mkdirSync(root,{recursive:true});
const lock='out/native-review.lock',fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,root}));closeSync(fd);
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lock)).pid===process.pid)unlinkSync(lock);}catch{}});
const sdk='/root/workspace/physx-2',runtimeDir=path.resolve('out/warm-runtime/native-runtime');
const binary=path.join(root,'town-kit-warm-scene-review');if(!resume)copyFileSync('native/target/release/town-kit-warm-scene-review',binary);
const report=resume?JSON.parse(readFileSync(path.join(root,'review.json'))):{passed:false,sceneSha256:hash(bytes),runtimeSha256:hash(readFileSync(`${runtimeDir}/libPhysXDestructionGpuRuntime_64.so`)),binarySha256:hash(readFileSync(binary)),exclusiveGpu:false,cases:[]};
if(report.sceneSha256!==hash(bytes)||report.binarySha256!==hash(readFileSync(binary))||report.runtimeSha256!==hash(readFileSync(`${runtimeDir}/libPhysXDestructionGpuRuntime_64.so`)))throw Error('Resume hashes changed');
const save=()=>writeFileSync(path.join(root,'review.json'),JSON.stringify(report,null,2));save();writeFileSync('out/reviews/proven-36-latest.json',JSON.stringify({root}));
async function run(input,mode){
 const dir=path.join(root,mode);
 const prior=report.cases.find(r=>r.mode===mode&&r.passed);
 if(prior){if(prior.native.sceneSha256!==hash(readFileSync(input)))throw Error('Completed case input changed');return {dir,proof:readFileSync(path.join(dir,'report.json'))};}
 if(existsSync(dir))renameSync(dir,dir+'-interrupted-'+Date.now());
 mkdirSync(dir);const log=openSync(path.join(dir,'run.log'),'w');
 const code=await new Promise((resolve,reject)=>{const child=spawn('timeout',['1200s',binary,input,mode,dir],{stdio:['ignore',log,log],env:{...process.env,VIBE_CITY_NATIVE_VERDICT_SAMPLE_TICKS:'1',VIBE_CITY_NATIVE_STRESS_ITERATIONS:'16',VIBE_CITY_STRESS_LIMIT_SCALE:'1',VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',LD_LIBRARY_PATH:`${runtimeDir}:${sdk}/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64`}});child.on('error',reject);child.on('exit',resolve);});closeSync(log);
 const f=path.join(dir,'report.json'),native=existsSync(f)?JSON.parse(readFileSync(f)):null;
 const row={mode,code,native,passed:code===0&&native?.passed===true};report.cases.push(row);save();console.log(`${mode}: ${row.passed?'PASS':'FAIL'} ${native?.error??''}`);
 if(!row.passed)throw Error(`Review failed: ${dir}`);if(native.runtime.sha256!==report.runtimeSha256)throw Error('Unexpected loaded runtime');
 return {dir,proof:readFileSync(f)};
}
const bake=await run(scene,'bake'),forces=readFileSync(path.join(bake.dir,'forces.f32'));let offset=0;
const structures=header.instances.map((p,instance)=>{const t=header.templates[p.template],r={instance,nodeCount:t.nodeCount,bondCount:t.bondCount,valueOffset:offset,baked:true,evidenceSha256:hash(bake.proof)};offset+=t.bondCount*6;return r;});
const descriptor={version:1,sceneSha256:hash(bytes),runtimeSha256:report.runtimeSha256,sdkProvenanceSha256:hash(readFileSync(`${sdk}/out/sdk-artifacts.json`)),gravity:[0,-9.81,0],timestep:1/60,tolerance:1e-5,complete:true,structures};
const warm=path.join(root,'bayline-proven-36.vlsw');writeFileSync(warm,encodeWarmBundle(bytes,descriptor,forces));
await run(warm,'verify');await run(warm,'damage');
const destination=path.resolve('out/bayline-proven-36.vlsw'),tmp=`${destination}.tmp-${process.pid}`;copyFileSync(warm,tmp);renameSync(tmp,destination);
report.passed=true;report.output=destination;report.bytes=readFileSync(destination).length;report.note='Intact cold/warm and targeted destruction passed; broader traversal and destruction qualification remain separate.';save();console.log(JSON.stringify(report,null,2));
