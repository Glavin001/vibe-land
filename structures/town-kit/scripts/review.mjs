import {readArtifact} from './artifacts.mjs';
import {gzipSync} from 'node:zlib';
import {readFileSync,unlinkSync} from 'node:fs';
import {readFile,mkdir,writeFile,open,unlink,copyFile,rename,statfs} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {sourceProvenance} from './provenance.mjs';
import {prepareNativeCache} from './native-cache.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(kit,'../..');
await mkdir(path.join(kit,'out'),{recursive:true});
const asset=process.argv[2]??'victorian-corner',modes=process.argv.slice(3);if(!modes.length)modes.push('stability');
if(!/^[a-z0-9-]+$/.test(asset))throw Error('Invalid asset slug');

// A small intact/traversal case has bounded, sparse recordings. Larger
// assemblies and every damage case keep the full 512 MiB working reserve.
const smallIntact=modes.every(m=>['stability','traverse'].includes(m))&&JSON.parse(await readArtifact(path.join(kit,'out',`${asset}.json`))).scenario.nodes.length<=8000;
const reserveMiB=smallIntact?128:512;
// This is a preflight snapshot; concurrent users can still consume disk space.
const disk=await statfs(kit);const available=disk.bavail*disk.bsize;
if(available<reserveMiB*1024*1024)throw Error(`Native review needs at least ${reserveMiB} MiB free before starting; only ${Math.floor(available/1024/1024)} MiB available. Preserve completed review evidence when making space.`);
const lockPath=path.join(kit,'out/native-review.lock');let lock;
try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));}catch{throw Error('Another town-kit GPU review owns out/native-review.lock; run cases sequentially.');}
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lockPath,'utf8')).pid===process.pid)unlinkSync(lockPath);}catch{}});
const assetPath=path.join(kit,'out',`${asset}.json`);
try{await readFile(assetPath);}catch(e){
 if(e.code!=='ENOENT')throw e;
 const bytes=await readArtifact(assetPath),hash=createHash('sha256').update(bytes).digest('hex');
 await writeFile(assetPath,bytes,{flag:'wx'});
 process.on('exit',()=>{try{if(createHash('sha256').update(readFileSync(assetPath)).digest('hex')===hash)unlinkSync(assetPath);}catch{}});
}
const meta=JSON.parse(await readFile(path.join(kit,'out',`${asset}.meta.json`),'utf8'));
if(!meta.validation?.passed)throw Error('Geometry validation must pass before native review');
const mac=process.platform==='darwin';
const sdk=process.env.PHYSX_DESTRUCTION_SDK??path.resolve(repo,mac?'../PhysX':'../physx-2');
const provenance=JSON.parse(await readFile(path.join(sdk,'out/sdk-artifacts.json'),'utf8'));
const run=(bin,args,env={})=>new Promise((resolve,reject)=>{const p=spawn(bin,args,{cwd:kit,env:{...process.env,...env},stdio:'inherit'});p.on('error',reject);p.on('exit',(code,signal)=>code===0?resolve():reject(Error(`${bin} exited ${code}, signal ${signal}`)));});
const cargoHome=await prepareNativeCache();
await run('cargo',['build','--offline','--locked','--release','--manifest-path','native/Cargo.toml'],{CARGO_HOME:cargoHome,PHYSX_DESTRUCTION_SDK:sdk,...(!mac?{CUDA_HOME:'/usr/local/cuda-12.8'}:{}),CARGO_TARGET_DIR:path.join(kit,'native/target')});
for(const mode of modes){
 if(!['stability','traverse','glazing','wall','furniture','fence','collapse'].includes(mode))throw Error(`Unknown mode ${mode}`);
 const out=path.join(kit,'out/reviews',`${asset}-${mode}`);
 const archive=path.join(kit,'out/reviews/history');await mkdir(archive,{recursive:true});
 try{await rename(out,path.join(archive,`${asset}-${mode}-${Date.now()}`));}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(out,{recursive:true});
 await writeFile(path.join(out,'asset.json.gz'),gzipSync(await readFile(path.join(kit,'out',`${asset}.json`)),{level:3}));await copyFile(path.join(kit,'out',`${asset}.meta.json`),path.join(out,'asset.meta.json'));
 const hardware=mac?execFileSync('system_profiler',['SPDisplaysDataType'],{encoding:'utf8'}).trim():execFileSync('nvidia-smi',['--query-gpu=name,driver_version,memory.used,utilization.gpu','--format=csv,noheader'],{encoding:'utf8'}).trim();
 await writeFile(path.join(out,'provenance.json'),JSON.stringify({assetHash:meta.assetSha256,sdkRevision:provenance.source_revision,sdkContentHash:provenance.source_content_sha256,libraries:provenance.libraries,hardware,authoringSource:meta.provenance,reviewSource:await sourceProvenance(),binarySha256:createHash('sha256').update(await readFile(path.join(kit,'native/target/release/town-kit-review'))).digest('hex'),debrisAssists:{settleTicks:0,freeze:false,parkBelowWorld:false},exclusiveGpu:false,recordedAt:new Date().toISOString(),solver:{iterations:Number(process.env.TOWN_KIT_ITERATIONS??16),contactIterations:process.env.TOWN_KIT_CONTACT_ITERATIONS??'PhysX default',contactOffsetMetres:process.env.TOWN_KIT_CONTACT_OFFSET??'PhysX default',tolerance:1e-5,gravity:9.81,preserveContactPairs:process.env.TOWN_KIT_PRESERVE_CONTACTS!=='0',gpuIslandRepair:process.env.TOWN_KIT_GPU_ISLAND_REPAIR!=='0'}},null,2));
 try{await run(path.join(kit,'native/target/release/town-kit-review'),[`out/${asset}.json`,mode,out],{VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',...(mac?{DYLD_LIBRARY_PATH:`${sdk}/out/install/macos-cumetal/release/lib`}:{LD_LIBRARY_PATH:`${sdk}/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64${process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:''}`})});}catch(e){
  try{await readFile(path.join(out,'report.json'));}catch{await writeFile(path.join(out,'report.json'),JSON.stringify({passed:false,mode,packSha256:meta.assetSha256,error:String(e),interrupted:true},null,2));}
  throw e;
 }
}

await lock.close();await unlink(lockPath);
