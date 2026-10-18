import {mkdir,writeFile,readFile,open} from 'node:fs/promises';
import {readFileSync,unlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {KIT,REPO} from '../src/dependencies.mjs';
import {sha,sourceProvenance} from './provenance.mjs';
const lockPath=path.join(KIT,'out/native-review.lock'),lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,purpose:'finish-comparison'}));await lock.close();process.on('exit',()=>{try{if(JSON.parse(readFileSync(lockPath)).pid===process.pid)unlinkSync(lockPath);}catch{}});
const {chromium}=await import(pathToFileURL(path.join(REPO,'client/node_modules/playwright-core/index.mjs'))),out=path.join(KIT,'out/reviews/finish-study');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});const results=[];
try{
 for(const [asset,room] of [['porch-house','living-dining'],['corner-grocery','flat-living'],['workshop','storage-loft']])for(const finish of ['city','town','fine']){
  const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('requestfailed',r=>errors.push(r.url()));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:6174/?asset=${asset}&clean&finish=${finish}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__,null,{timeout:60000});const stats=await page.evaluate(()=>window.__TOWN_KIT__.stats());
  for(const camera of ['hero',room]){await page.evaluate(p=>window.__TOWN_KIT__.setCamera(p),stats.cameras[camera]);await page.waitForTimeout(350);await page.screenshot({path:path.join(out,`${asset}-${camera}-${finish}.png`)});}
  if(stats.webglError||errors.length)throw Error(JSON.stringify({stats,errors}));results.push({asset,finish,hash:stats.hash,cameras:['hero',room],errors});await page.close();console.log(asset,finish);
 }
 await writeFile(path.join(out,'report.json'),JSON.stringify({passed:true,results,presetSourceHash:sha(await readFile(path.join(KIT,'preview/finishes.ts'))),provenance:await sourceProvenance()},null,2));
}finally{await browser.close();}
