// Render recorded physics poses and the measured projectile, without network interpolation.
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {chromium} from '../../../../client/node_modules/playwright-core/index.mjs';
const root=new URL('../../out/reviews/house-cannonball/',import.meta.url),out=new URL('../../out/reviews/roof-response/',import.meta.url);
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']}),errors=[];
try{for(const name of process.argv.slice(2)){
 const dir=new URL(name+'/',root),bytes=readFileSync(new URL('asset.json',dir)),pack=JSON.parse(bytes),recording=JSON.parse(gunzipSync(readFileSync(new URL('recording.json.gz',dir)))),series=JSON.parse(readFileSync(new URL('series.json',dir))),report=JSON.parse(readFileSync(new URL('report.json',dir)));
 const times=name.includes('meteor')?[0,2.6,3,5,15,Math.min(60,recording.frames.at(-1).time)]:[0,.2,.4,1,3,6];
 // Still review needs only the frames bracketing each requested time. Keep the
 // original native recording on disk; avoid duplicating a minute of poses in Chromium.
 const selected=new Set();for(const time of times){const index=recording.frames.findIndex(f=>f.time>=time);for(const i of [Math.max(0,index-1),index<0?recording.frames.length-1:index])selected.add(i);}
 recording.frames=recording.frames.filter((_,i)=>selected.has(i));
 recording.packHash=createHash('sha256').update(bytes).digest('hex');
 const camera=process.env.TOWN_KIT_SHOT_CAMERA?JSON.parse(process.env.TOWN_KIT_SHOT_CAMERA):{position:[-21,14,24],target:[0,3,0]},cameraTag=process.env.TOWN_KIT_SHOT_CAMERA?'-'+createHash('sha256').update(JSON.stringify(camera)).digest('hex').slice(0,8):'',page=await browser.newPage({viewport:{width:960,height:640}});page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/main.ts*',async route=>{const response=await route.fetch();let code=await response.text();code=code.replace(/renderer\.shadowMap\.enabled\s*=\s*true/g,'renderer.shadowMap.enabled = false').replace(/composer\.addPass\(ao\);/g,'').replace(/requestAnimationFrame\(animate\);/g,'');code+='\nconst diagnosticBall=new THREE.Mesh(new THREE.SphereGeometry(1,24,16),new THREE.MeshStandardMaterial({color:0xff4d24,roughness:.6})); scene.add(diagnosticBall);window.__NATIVE_SHOT__=(p,r)=>{diagnosticBall.visible=!!p;if(p){diagnosticBall.position.fromArray(p);diagnosticBall.scale.setScalar(r)}controls.update();composer.render();};';await route.fulfill({response,body:code});});
 await page.route('**/kit/**',route=>{const path=new URL(route.request().url()).pathname;const obj=path.endsWith('/recording.json')?recording:path.endsWith('/report.json')?{passed:false,error:'Diagnostic native simulation'}:path.endsWith('.meta.json')?{kind:'building',assetSha256:recording.packHash,cameras:{hero:camera}}:pack;return route.fulfill({contentType:'application/json',body:JSON.stringify(obj)});});
 await page.goto('http://127.0.0.1:6174/?clean&asset='+name,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__,null,{timeout:90000});await page.evaluate(()=>window.__TOWN_KIT__.loadRecording('wall'));
 for(const time of [...new Set(times)]){
  const row=series[Math.max(0,Math.round(time*60)-1)],p=time===0?report.projectile.position:row.projectile?.position;
  const jpg=await page.evaluate(({time,p,r,name,row})=>{window.__TOWN_KIT__.seek(time);window.__NATIVE_SHOT__(p,r);const canvas=document.createElement('canvas');canvas.width=960;canvas.height=640;const c=canvas.getContext('2d');c.drawImage(document.querySelector('canvas'),0,0);c.fillStyle='#172029';c.fillRect(0,0,960,50);c.fillStyle='white';c.font='16px monospace';c.fillText(`${name} | ${time.toFixed(2)} s | broken ${time===0?0:row.broken}`,16,30);return canvas.toDataURL('image/jpeg',.88).split(',')[1];},{time,p,r:report.projectile.radiusM,name,row});
  writeFileSync(new URL(`${name}${cameraTag}-${time}s.jpg`,out),Buffer.from(jpg,'base64'));
 }console.log(name);await page.close();}
}finally{await browser.close();writeFileSync(new URL('native-image-errors.json',out),JSON.stringify(errors));}
