import {execFileSync} from 'node:child_process';
import {readArtifact} from './artifacts.mjs';
import { mkdir,writeFile,readFile,rename } from 'node:fs/promises';
import path from 'node:path';
import {sha,sourceProvenance} from './provenance.mjs';
import { pathToFileURL,fileURLToPath } from 'node:url';
const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(kit,'../..');
const {chromium}=await import(pathToFileURL(path.join(repo,'client/node_modules/playwright-core/index.mjs')));
const asset=process.argv[2]??'victorian-corner',mode=process.argv[3]??'',origin=process.env.TOWN_KIT_ORIGIN??'http://127.0.0.1:6174';
const out=path.join(kit,'out/reviews',`${asset}-${mode||'visual'}`);
const imageFormat=process.env.TOWN_KIT_IMAGE_FORMAT??'png';if(!['png','jpeg'].includes(imageFormat))throw Error('Expected png or jpeg');const imageExtension=imageFormat==='jpeg'?'jpg':'png';
if(!mode){
 const history=path.join(kit,'out/reviews/history');await mkdir(history,{recursive:true});
 try{await rename(out,path.join(history,`${asset}-visual-${Date.now()}`));}catch(e){if(e.code!=='ENOENT')throw e;}
}
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'visual-report.json'),JSON.stringify({asset,mode,pending:true,hash:null,captures:[],errors:['Capture incomplete']}));
const renderingBackend=process.env.TOWN_KIT_RENDERER??'gpu';if(!['gpu','software'].includes(renderingBackend))throw Error('Expected gpu or software renderer');
const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--no-sandbox','--disable-gpu-sandbox','--disable-gpu-shader-disk-cache','--use-gl=angle',...(renderingBackend==='software'?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist'])]});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});const errors=[];
 page.on('pageerror',e=>errors.push(e.stack??String(e)));page.on('requestfailed',r=>errors.push(`Request failed: ${r.url()} ${r.failure()?.errorText}`));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`${origin}/?asset=${encodeURIComponent(asset)}&clean`,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__,null,{timeout:60000});
 const stats=await page.evaluate(()=>window.__TOWN_KIT__.stats());
 if(mode){await page.evaluate(mode=>window.__TOWN_KIT__.loadRecording(mode),mode);await page.evaluate(()=>window.__TOWN_KIT__.seek(Number(document.getElementById('timeline').max)));}
 if(stats.webglError)throw Error(`WebGL error ${stats.webglError}`);
 const nativeStatus=mode?await page.evaluate(()=>document.getElementById('status').textContent):null;
 if(nativeStatus?.startsWith('FAIL'))await page.evaluate(()=>{const label=document.createElement('div');label.textContent='WIP · NATIVE REVIEW FAILED';Object.assign(label.style,{position:'fixed',right:'18px',bottom:'18px',background:'#721c19',color:'white',padding:'10px',font:'bold 13px system-ui'});document.body.append(label);});
 let captureCameras=stats.cameras;
 if(mode&&stats.kind==='prop'){await page.evaluate(()=>window.__TOWN_KIT__.frameFragments());captureCameras=await page.evaluate(()=>window.__TOWN_KIT__.damageCameras());}
 if(['wall','glazing','fence'].includes(mode)){
  const metadata=JSON.parse(await readFile(path.join(kit,'out',`${asset}.meta.json`),'utf8')),shot=metadata.shots[mode][0],d=shot.from.map((v,i)=>v-shot.to[i]),length=Math.hypot(...d);
  captureCameras={...captureCameras,'damage-detail':{position:shot.to.map((v,i)=>v+d[i]/length*4),target:shot.to}};
 }
 if(mode==='collapse'&&!captureCameras.cafe)captureCameras={...captureCameras,'rubble-detail':{position:[-9,2.2,-11],target:[0,.6,-1]}};
 const captures=[];
 for(const [name,pose]of Object.entries(captureCameras)){
  if(process.env.TOWN_KIT_CAMERAS&&!process.env.TOWN_KIT_CAMERAS.split(',').includes(name))continue;
  if(mode&&mode!=='furniture'&&!['hero','front','corner','rear','aerial','cafe','courtyard','rubble-detail','damage-detail'].includes(name))continue;
  const captureName=mode==='collapse'&&name==='cafe'?'rubble-detail':name;
  const cameraPose=captureName==='rubble-detail'?{position:[-9,2.2,-11],target:[0,.6,-1]}:pose;
  await page.evaluate(p=>window.__TOWN_KIT__.setCamera(p),cameraPose);await page.waitForTimeout(350);
  await page.screenshot({path:path.join(out,`${captureName}.${imageExtension}`),type:imageFormat,...(imageFormat==='jpeg'?{quality:92}:{})});captures.push(captureName);console.log(`captured ${captureName}`);
 }
 const finalStats=await page.evaluate(()=>window.__TOWN_KIT__.stats());if(finalStats.webglError)errors.push(`WebGL error ${finalStats.webglError}`);
 if(errors.length)throw Error(errors.join('\n'));
 // Release browser buffers/profile before composing and writing review artifacts.
 await browser.close();
 const html=`<!doctype html><style>body{margin:0;padding:20px;background:#192a25;color:#e4e8df;font:14px system-ui}h1{font:28px Georgia}main{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}img{width:100%;display:block}p{margin:6px 0 16px;color:#b7c7ba}</style><h1>Bayline / ${asset} / ${mode||'intact'}</h1><p>${stats.hash} ${nativeStatus??''}</p><main>${captures.map(n=>`<section><img src="${n}.${imageExtension}"><p>${n}</p></section>`).join('')}</main>`;
 await writeFile(path.join(out,'contact-sheet.html'),html);execFileSync('python3',[path.join(kit,'scripts/contact-sheet.py'),out,JSON.stringify(captures),`Bayline / ${asset} / ${mode||'intact'} / ${stats.hash}`]);
 await writeFile(path.join(out,'visual-report.json'),JSON.stringify({asset,mode,imageFormat,renderingBackend,finish:stats.finish,finishTuning:stats.finishTuning,hash:stats.hash,metadataSha256:sha(await readFile(path.join(kit,'out',`${asset}.meta.json`))),recordingSha256:mode?sha(await readArtifact(path.join(out,'recording.json'))):null,provenance:await sourceProvenance(),captures,cameraStrategy:mode&&stats.kind==='prop'?'settled-fragment-bounds':'saved-cameras',cameras:captureCameras,errors,nativeStatus,viewport:[1600,1000]},null,2));console.log(out);
}finally{await browser.close();}
