import path from 'node:path';
import {readFile,writeFile,mkdir,open,unlink,statfs} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {readArtifact} from './artifacts.mjs';

const invalid=message=>Object.assign(Error(message),{status:400});
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<100);
export function cannonShot(input){
 if(!input||!/^tree-[a-z]+-[0-2]$/.test(input.asset))throw invalid('Choose a built tree for the cannon test.');
 return ballisticRound(input);
}
export function ballisticRound(input){
 if(!vector(input.from)||!vector(input.to))throw invalid('The shot needs finite launch and target positions.');
 const {mass,speed,from,to}=input;
 if(!Number.isFinite(mass)||mass<1||mass>5000||!Number.isFinite(speed)||speed<5||speed>60)throw invalid('Use a ball of 1–5000 kg and a speed of 5–60 m/s.');
 const radius=Math.cbrt(mass/(7850*4/3*Math.PI));
 if(speed>Math.floor(radius*120*.9/5)*5)throw invalid('That ball is too small for this launch speed. Use a heavier ball or lower the speed.');
 const dx=to[0]-from[0],dz=to[2]-from[2],dy=to[1]-from[1],range=Math.hypot(dx,dz);
 if(range<.2||Math.hypot(range,dy)>30||from[1]<.1)throw invalid('Aim from above ground, within 30 metres, and away from a vertical shot.');
 const g=9.81,v2=speed*speed,discriminant=v2*v2-g*(g*range*range+2*dy*v2);
 if(discriminant<0)throw invalid('That target is out of range at this speed. Increase the speed.');
 const angle=Math.atan((v2-Math.sqrt(discriminant))/(g*range));
 const direction=[Math.cos(angle)*dx/range,Math.sin(angle),Math.cos(angle)*dz/range];
 // The bridge offsets the round behind its supplied position by r+0.05.
 // Compensate here so `from` is exactly the physical muzzle position.
 return {tick:30,from:from.map((n,i)=>n+direction[i]*(radius+.05)),to,direction,radius,speed,momentum:mass*speed,mass,muzzle:from};
}

export function cannonApi(kit){
 const root=path.join(kit,'out'),jobs=new Map();let busy=false;
 const lockPath=path.join(root,'native-review.lock');
 async function launch(input){
  const shot=cannonShot(input);
  const bytes=await readArtifact(path.join(root,`${input.asset}.json`));
  const meta=JSON.parse(await readFile(path.join(root,`${input.asset}.meta.json`),'utf8'));
  if(meta.kind!=='tree'||!meta.validation?.passed||meta.previewHidden)throw invalid('This tree is not ready for a cannon test.');
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(hash!==meta.assetSha256)throw invalid('Tree data changed. Rebuild it before firing.');
  const disk=await statfs(root);if(disk.bavail*disk.bsize<128*1024*1024)throw Error('The cannon test needs 128 MiB of free disk space.');
  if(busy)throw Object.assign(Error('Another native shot is running. Wait for it to finish.'),{status:409});
  busy=true;let lock;
  try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,kind:'cannon',started:new Date().toISOString()}));}
  catch(e){busy=false;throw Object.assign(Error('The native solver is busy with another review. Try again when it finishes.'),{status:409});}
  const id=randomUUID(),dir=path.join(root,'cannon',id),job={id,state:'running',asset:input.asset,startedAt:new Date().toISOString()};
  jobs.set(id,job);if(jobs.size>24)jobs.delete(jobs.keys().next().value);
  const release=async()=>{await lock.close();await unlink(lockPath);busy=false;};
  try{
   await mkdir(dir,{recursive:true});
   await writeFile(path.join(dir,'asset.json'),bytes);
   await writeFile(path.join(dir,'asset.meta.json'),JSON.stringify({...meta,shots:{cannon:[shot]}}));
   await writeFile(path.join(dir,'request.json'),JSON.stringify(input));
   const sdk=process.env.PHYSX_DESTRUCTION_SDK??path.resolve(kit,process.platform==='darwin'?'../../../PhysX':'../../../physx-2');
   const binary=path.join(kit,'native/target/release/town-kit-review');
   await writeFile(path.join(dir,'provenance.json'),JSON.stringify({binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),assetSha256:hash,source:'native spherical rigid body contacts → stress solver',massKg:shot.mass,speedMps:shot.speed,radiusMetres:shot.radius},null,2));
   const child=spawn(binary,[path.join(dir,'asset.json'),'cannon',dir],{cwd:kit,env:{...process.env,VIBE_CITY_NATIVE_SETTLE_TICKS:'0',VIBE_CITY_NATIVE_SETTLE_FREEZE:'0',VIBE_CITY_NATIVE_DEBRIS_FLOOR_M:'-inf',...(process.platform==='darwin'?{DYLD_LIBRARY_PATH:`${sdk}/out/install/macos-cumetal/release/lib`}:{LD_LIBRARY_PATH:`${sdk}/physx/bin/linux.x86_64/release:/usr/local/cuda-12.8/lib64`})},stdio:['ignore','pipe','pipe']});
   let log='',launchError;child.stdout.on('data',b=>{log=(log+b).slice(-64000);});child.stderr.on('data',b=>{log=(log+b).slice(-64000);});
   child.on('error',e=>{launchError=e;});
   const timeout=setTimeout(()=>{launchError=Error('Native shot exceeded its 90-second time limit.');child.kill('SIGKILL');},90000);
   child.on('close',async code=>{
    clearTimeout(timeout);
    try{
     await writeFile(path.join(dir,'native.log'),log);
     const report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));
     if(code!==0||!report.passed)throw Error(report.error??launchError?.message??'Native shot failed.');
     Object.assign(job,{state:'complete',base:`/kit/cannon/${id}`,report});
    }catch(e){Object.assign(job,{state:'failed',error:launchError?.message??e.message});}
    finally{job.finishedAt=new Date().toISOString();await release();}
   });
   return job;
  }catch(e){jobs.delete(id);await release();throw e;}
 }
 return async(req,res)=>{
  const send=(status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  try{
   const url=(req.url??'').split('?')[0];
   if(req.method==='GET'&&/^\/jobs\/[a-f0-9-]+$/.test(url)){const job=jobs.get(url.slice(6));return send(job?200:404,job??{error:'Shot not found. Fire a new shot.'});}
   if(req.method!=='POST'||url!=='/jobs')return send(404,{error:'Unknown cannon endpoint.'});
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Fire from the local preview.'});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'Expected a JSON shot.'});
   let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return send(413,{error:'Shot request is too large.'});}
   let input;try{input=JSON.parse(body);}catch{throw invalid('Invalid shot JSON.');}
   return send(202,await launch(input));
  }catch(e){send(e.status??500,{error:e.code==='ENOENT'?'Build this tree and the native cannon harness before firing.':e.message});}
 };
}
