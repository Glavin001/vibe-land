// Run under scripts/perf/gpu-run.sh, with the live playground stopped.
// Each fixture must survive intact settling, then physically fracture and move.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {buildOutdoorProp,OUTDOOR_PROP_TYPES} from '../src/outdoor-props.mjs';
import {buildTree} from '../src/tree.mjs';
import {buildPorchHouse} from '../src/porch-house.mjs';
import {ballisticRound} from './cannon.mjs';
import {PLAYGROUND_CANNON,PLAYGROUND_STRESS} from '../src/playground-config.mjs';
const wanted=process.argv.slice(2),all=[...OUTDOOR_PROP_TYPES,'tree-shade-0','tree-street-0','tree-ornamental-1','porch-house'];
const names=wanted.length?wanted:all;
for(const name of names)if(!all.includes(name))throw Error(`Unknown exhibit: ${name}`);
const root=path.join(KIT,'out/cannon-qualification',process.env.TOWN_KIT_CHECK_TAG??'current');await mkdir(root,{recursive:true});
const results=[];
for(const name of names){
 const asset=name==='porch-house'?buildPorchHouse():name.startsWith('tree-')?buildTree({family:name.split('-')[1],variant:Number(name.at(-1))}):buildOutdoorProp(name);
 const {pack,metadata}=asset,s=pack.scenario;
 let target=metadata.shots.furniture[0].to;
 if(name.startsWith('tree-'))target=metadata.shots.collapse[0].to;
 if(name==='low-wall')target=[0,.6,0];
 if(name==='market-stall')target=[0,.985,-.6];
 if(name==='bus-shelter')target=[-1.8,1.2,-1.3];
 if(name==='porch-house')target=metadata.shots.wall[0].to;
 const from=name==='porch-house'?[target[0]-6,Math.max(1.65,target[1]),target[2]]:[target[0],Math.max(1.65,target[1]),target[2]-6];
 const shot=ballisticRound({from,to:target,mass:PLAYGROUND_CANNON.massKg,speed:PLAYGROUND_CANNON.speedMps});
 const count=Number(process.env.TOWN_KIT_CHECK_SHOTS??(['tree-street-0','porch-house'].includes(name)?3:1));
 const meta={...metadata,shots:{cannon:Array.from({length:count},(_,i)=>({...shot,tick:30+i*90}))}};
 const dir=path.join(root,name);await mkdir(dir,{recursive:true});
 const bytes=JSON.stringify(pack);await writeFile(path.join(dir,'asset.json'),bytes);await writeFile(path.join(dir,'asset.meta.json'),JSON.stringify(meta));
 const sdk=process.env.PHYSX_DESTRUCTION_SDK??path.resolve(KIT,'../../../PhysX');
 const env={...process.env,...(process.platform==='darwin'?{DYLD_LIBRARY_PATH:path.join(sdk,'out/install/macos-cumetal/release/lib')}:{}),TOWN_KIT_STRESS_TOLERANCE:String(PLAYGROUND_STRESS.tolerance),TOWN_KIT_ITERATIONS:String(PLAYGROUND_STRESS.iterations),TOWN_KIT_COMPACT_GPU:'1',TOWN_KIT_PRESERVE_CONTACTS:'1',TOWN_KIT_GPU_ISLAND_REPAIR:'1'};
 let log='';const code=await new Promise((resolve,reject)=>{const p=spawn(path.join(KIT,'native/target/release/town-kit-review'),[path.join(dir,'asset.json'),'cannon',dir],{cwd:KIT,env,stdio:['ignore','pipe','pipe']});p.on('error',reject);p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('exit',resolve);});
 await writeFile(path.join(dir,'native.log'),log);
 let report={error:`process exited ${code}`};try{report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));}catch{}
 let moved=0,maxMovement=0;
 if(report.passed){
  const tape=JSON.parse(gunzipSync(await readFile(path.join(dir,'recording.json.gz'))));
  const poses=new Map(),rest=new Map(),broken=new Set();
  for(const frame of tape.frames){for(const [i,p]of frame.poses??[])poses.set(i,p);if(frame.time<report.shots[0].tick/60)for(const [i,p]of poses)rest.set(i,p);for(const b of frame.broken??[])broken.add(b);}
  const affected=new Set([...broken].flatMap(i=>[s.bonds[i].node0,s.bonds[i].node1]));
  for(const i of affected){if(s.nodes[i].mass<=0||!rest.has(i)||!poses.has(i))continue;const a=rest.get(i),b=poses.get(i),distance=Math.hypot(...a.slice(0,3).map((v,k)=>v-b[k]));maxMovement=Math.max(maxMovement,distance);if(distance>.1)moved++;}
 }
 const result={name,passed:code===0&&report.passed&&report.destruction.brokenBonds>0&&moved>0,assetSha256:createHash('sha256').update(bytes).digest('hex'),massKg:shot.mass,speedMps:25,shots:count,brokenBonds:report.destruction?.brokenBonds??0,movedFracturedChunks:moved,maxMovementMetres:maxMovement,error:report.error??null,peakUtilisation:report.destruction?.peakUtilisation};
 results.push(result);console.log(JSON.stringify(result));await writeFile(path.join(root,'report.json'),JSON.stringify({complete:results.length===names.length,passed:results.length===names.length&&results.every(r=>r.passed),cannon:PLAYGROUND_CANNON,solver:PLAYGROUND_STRESS,expected:names,results},null,2));
}
if(results.some(r=>!r.passed))process.exitCode=1;
