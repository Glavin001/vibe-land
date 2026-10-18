import {readArtifact} from './artifacts.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sha,sourceProvenance} from './provenance.mjs';
import {pathToFileURL,fileURLToPath} from 'node:url';
const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(kit,'../..');
const {chromium}=await import(pathToFileURL(path.join(repo,'client/node_modules/playwright-core/index.mjs')));
const asset=process.argv[2]??'victorian-corner',mode=process.argv[3]??'traverse',origin=process.env.TOWN_KIT_ORIGIN??'http://127.0.0.1:6174';
const out=path.join(kit,'out/reviews',`${asset}-${mode}`),r=JSON.parse(await readArtifact(path.join(out,'recording.json'),'utf8'));
const diagnostic=process.argv.includes('--diagnostic');
if(!r.passed&&!diagnostic)throw Error('Failed review: use --diagnostic to export a visibly labelled failure recording');
await mkdir(path.join(out,'video'),{recursive:true});
await writeFile(path.join(out,'video-report.json'),JSON.stringify({asset,mode,passed:false,pending:true,errors:['Video capture incomplete']}));
const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--disable-dev-shm-usage'],args:['--no-sandbox','--disable-gpu-sandbox','--disable-gpu-shader-disk-cache','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:800},recordVideo:{dir:path.join(out,'video'),size:{width:1280,height:800}}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('requestfailed',r=>errors.push(`Request failed: ${r.url()}`));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`${origin}/?asset=${asset}&clean`,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__);
 await page.evaluate(mode=>window.__TOWN_KIT__.loadRecording(mode),mode);
 const previewStats=await page.evaluate(()=>window.__TOWN_KIT__.stats());
 const savedCamera=process.env.TOWN_KIT_VIDEO_CAMERA;if(savedCamera){if(!previewStats.cameras[savedCamera])throw Error('Unknown video camera');await page.evaluate(p=>window.__TOWN_KIT__.setCamera(p),previewStats.cameras[savedCamera]);}
 if(!r.passed)await page.evaluate(()=>{const label=document.createElement('div');label.textContent='DIAGNOSTIC · FAILED NATIVE REVIEW';Object.assign(label.style,{position:'fixed',top:'18px',left:'18px',padding:'12px',background:'#721c19',color:'white',font:'bold 14px system-ui'});document.body.append(label);});
 if(mode!=='traverse')await page.evaluate(()=>{if(window.__TOWN_KIT__.stats().kind==='prop')window.__TOWN_KIT__.trackFragments(true);});
 if(mode==='traverse')await page.evaluate(()=>window.__TOWN_KIT__.followWalker(true));
 const playerTime=r.frames.find(f=>f.player)?.time;
 const begin=mode==='traverse'?(playerTime??0):(r.frames.find(f=>f.broken?.length)?.time??30)-1,end=r.frames.at(-1).time;
 let followingBreach=false;
 const step=Math.max(1/20,(end-begin)/900);
 for(let t=begin;t<=end;t+=step){if(mode==='wall'&&playerTime!=null&&t>=playerTime&&!followingBreach){await page.evaluate(()=>window.__TOWN_KIT__.followWalker(true));followingBreach=true;}await page.evaluate(t=>window.__TOWN_KIT__.seek(t),t);await page.waitForTimeout(50);}
 if(errors.length)throw Error(errors.join('\n'));
 const video=page.video();await page.close();const savedVideo=path.join(out,`${mode}${r.passed?'':'-failed'}.webm`);await video.saveAs(savedVideo);await context.close();
 const captureCache=await video.path();if(path.resolve(captureCache)!==path.resolve(savedVideo)&&sha(await readFile(captureCache))===sha(await readFile(savedVideo)))await video.delete();
 await writeFile(path.join(out,'video-report.json'),JSON.stringify({asset,mode,finish:previewStats.finish,finishTuning:previewStats.finishTuning,passed:r.passed,packHash:r.packHash,recordingSha256:sha(await readArtifact(path.join(out,'recording.json'))),videoSha256:sha(await readFile(path.join(out,`${mode}${r.passed?'':'-failed'}.webm`))),provenance:await sourceProvenance(),errors},null,2));
 console.log(path.join(out,`${mode}${r.passed?'':'-failed'}.webm`));
}finally{await browser.close();}
