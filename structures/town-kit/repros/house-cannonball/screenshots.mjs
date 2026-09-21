// Read-only preview of exact compared assets and recorded poses. No staged exports.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const kit=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),repo=path.resolve(kit,'../..'),root=path.join(kit,'out/reviews/house-cannonball');
const {chromium}=await import(pathToFileURL(path.join(repo,'client/node_modules/playwright-core/index.mjs')));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[],captures=[];
try {
 for(const name of process.argv.slice(2).length?process.argv.slice(2):['house-1story','house-2story','bungalow','porch-house']){
 const dir=path.join(root,name),bytes=await readFile(path.join(dir,'asset.json')),pack=JSON.parse(bytes),recording=existsSync(path.join(dir,'recording.json'))?JSON.parse(await readFile(path.join(dir,'recording.json'))):existsSync(path.join(dir,'recording.json.gz'))?JSON.parse(gunzipSync(await readFile(path.join(dir,'recording.json.gz')))):{frames:[]},report=JSON.parse(await readFile(path.join(dir,'report.json')));
 const hash=createHash('sha256').update(bytes).digest('hex');recording.packHash=hash;
 const cameras={hero:{position:[-18,13,-21],target:[0,2,0]},impact:{position:[-18,5,-8],target:[0,2,0]},rear:{position:[16,11,19],target:[0,2,0]}};
 const page=await browser.newPage({viewport:{width:1200,height:850},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/kit/**',async route=>{const u=new URL(route.request().url()).pathname;let obj;if(u.endsWith('/recording.json'))obj=recording;else if(u.endsWith('/report.json'))obj={passed:false,error:'Diagnostic comparison — not a release gate',destruction:{brokenBonds:report.impact?.broken}};else if(u.endsWith('.meta.json'))obj={kind:'building',assetSha256:hash,cameras};else obj=pack;await route.fulfill({contentType:'application/json',body:JSON.stringify(obj)});});
 await page.goto(`http://127.0.0.1:6174/?asset=${name}&clean`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__,null,{timeout:60000});
 await page.evaluate(()=>window.__TOWN_KIT__.loadRecording('wall'));
 for(const t of recording.frames.length>1?[0,.25,1,30]:[0])for(const angle of ['hero','impact']){
 await page.evaluate(({t,camera})=>{window.__TOWN_KIT__.seek(t);window.__TOWN_KIT__.setCamera(camera);},{t,camera:cameras[angle]});await page.waitForTimeout(180);
 const file=path.join(dir,`${angle}-${t}s.jpg`);await page.screenshot({path:file,type:'jpeg',quality:88});captures.push(file);
 }
 const stats=await page.evaluate(()=>window.__TOWN_KIT__.stats());if(stats.webglError)errors.push(`${name}: WebGL ${stats.webglError}`);await page.close();console.log(name);
 }
}finally{await browser.close();}
await writeFile(path.join(root,`visual-review-${Date.now()}.json`),JSON.stringify({captures,errors,renderer:'software',viewport:[1200,850]},null,2));if(errors.length)throw Error(errors.join('\n'));
