// Offline native pose playback at a fixed 15 fps. No network interpolation.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {KIT,REPO} from '../../src/dependencies.mjs';
const {chromium}=await import(pathToFileURL(`${REPO}/client/node_modules/playwright-core/index.mjs`));
const root=`${KIT}/out/reviews/house-cannonball`,lock=`${KIT}/out/impact-video-render.lock`;
await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const captures=[],errors=[];
try{
 for(const name of process.argv.slice(2)){
  const dir=`${root}/${name}`,bytes=await readFile(`${dir}/asset.json`),pack=JSON.parse(bytes),recording=JSON.parse(gunzipSync(await readFile(`${dir}/recording.json.gz`))),report=JSON.parse(await readFile(`${dir}/report.json`)),series=JSON.parse(await readFile(`${dir}/series.json`));
  const previous=new Map();for(const frame of recording.frames){frame.poses=frame.poses.filter(p=>{const text=JSON.stringify(p);if(previous.get(p[0])===text)return false;previous.set(p[0],text);return true;});delete frame.bodies;}
  recording.packHash=createHash('sha256').update(bytes).digest('hex');
  const camera={position:[-19,12,-23],target:[0,2.8,0]},page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(`${name}: ${e}`));page.on('console',m=>{if(m.type()==='error')errors.push(`${name}: ${m.text()}`)});
  await page.route('**/main.ts*',async route=>{const response=await route.fetch();let code=await response.text();code=code.replace(/renderer\.shadowMap\.enabled\s*=\s*true/g,'renderer.shadowMap.enabled = false').replace(/composer\.addPass\(ao\);/g,'').replace(/requestAnimationFrame\(animate\);/g,'');code+='\nwindow.__DIAGNOSTIC_RENDER__ = () => { controls.update(); composer.render(); };';await route.fulfill({response,body:code});});
  await page.route('**/kit/**',async route=>{const u=new URL(route.request().url()).pathname,obj=u.endsWith('/recording.json')?recording:u.endsWith('/report.json')?{passed:report.impact.settledCasePassed,error:'Native pose recording; diagnostic, not release qualification'}:u.endsWith('.meta.json')?{kind:'building',assetSha256:recording.packHash,cameras:{hero:camera}}:pack;await route.fulfill({contentType:'application/json',body:JSON.stringify(obj)});});
  await page.goto(`http://127.0.0.1:6174/?asset=${name}&clean`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__,null,{timeout:60000});
  await page.evaluate(async()=>{await window.__TOWN_KIT__.loadRecording('wall');const label=document.createElement('div');label.id='diagnostic-caption';Object.assign(label.style,{position:'fixed',top:'0',left:'0',right:'0',padding:'12px 18px',background:'#111d',color:'white',font:'16px monospace',zIndex:'1000',whiteSpace:'pre-line'});document.body.append(label);});
  const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','15','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',`${dir}/impact.mp4`],{stdio:['pipe','ignore','pipe']});
  let fferr='';ff.stderr.on('data',x=>fferr+=x);const done=once(ff,'close');
  // One second intact, 30 seconds actual motion, one second final pose.
  for(let f=0;f<480;f++){
   const t=Math.min(30,Math.max(0,(f-15)/15)),s=series[Math.max(0,Math.round(t*60)-1)];
   const encoded=await page.evaluate(async({t,name,s})=>{window.__TOWN_KIT__.seek(t);document.getElementById('diagnostic-caption').textContent=`${name.replace('video-','').replaceAll('-',' ')} | ${t.toFixed(2)} s\nNative poses, 15 fps | awake ${t===0?0:s.awake} | broken ${t===0?0:s.broken} | converged ${t===0?'yes':s.converged?'yes':'NO'}`;window.__DIAGNOSTIC_RENDER__();const source=document.querySelector('canvas');const canvas=window.__VIDEO_CANVAS__??=document.createElement('canvas');canvas.width=960;canvas.height=640;const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0);ctx.fillStyle='#202020';ctx.fillRect(0,0,960,66);ctx.fillStyle='white';ctx.font='16px monospace';document.getElementById('diagnostic-caption').textContent.split('\n').forEach((line,i)=>ctx.fillText(line,18,26+i*23));return canvas.toDataURL('image/jpeg',.82).split(',')[1];},{t,name,s});
   const jpg=Buffer.from(encoded,'base64');
   if(!ff.stdin.write(jpg))await once(ff.stdin,'drain');
   if(f===0||f===465)await writeFile(`${dir}/${f===0?'before':'after'}.jpg`,jpg);
   if(f%120===0)console.log(`${name}: ${f}/480 frames`);
  }
  ff.stdin.end();const [code]=await done;if(code!==0)throw Error(fferr);
  const stats=await page.evaluate(()=>window.__TOWN_KIT__.stats());if(stats.webglError)errors.push(`${name}: WebGL ${stats.webglError}`);
  captures.push({name,video:`${dir}/impact.mp4`,frames:480,fps:15,simulatedSeconds:30,renderer:'software, direct frames, shadows and SSAO disabled',directNativePoses:true,projectileRendered:false});await page.close();
 }
}finally{await browser.close();await unlink(lock);await writeFile(`${root}/video-review.json`,JSON.stringify({captures,errors},null,2));}
if(errors.length)throw Error(errors.join('\n'));
