import {chromium} from '../../../client/node_modules/playwright-core/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
const browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const checked=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:960,height:720}});page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:6174/?asset=outdoor-gallery');
 await page.waitForFunction(()=>window.__TOWN_KIT__?.ready||window.__TOWN_KIT__?.error,null,{timeout:60000});
 const names=await page.locator('#asset option').evaluateAll(options=>options.map(o=>o.value));
 for(const name of names){
  await page.locator('#asset').selectOption(name);
  await page.waitForFunction(()=>window.__TOWN_KIT__.ready||window.__TOWN_KIT__.error,null,{timeout:60000});
  const state=await page.evaluate(()=>({error:window.__TOWN_KIT__.error,chunks:window.__TOWN_KIT__.stats().chunks,title:document.querySelector('#title').textContent}));
  if(state.error||!state.chunks)throw Error(`${name}: ${state.error??'empty scene'}`);checked.push({name,...state});console.log(name,state.chunks);
 }
 for(const missing of ['unbuilt.json','unbuilt.meta.json','reviews/unbuilt-collapse/recording.json']){
  const r=await page.request.get(`http://127.0.0.1:6174/kit/${missing}`);if(r.status()!==404||!(await r.json()).error)throw Error(`Missing ${missing} did not produce a JSON 404`);
 }
 if(errors.length)throw Error(errors.join('\n'));
}finally{
 await browser.close();await mkdir(`${KIT}/out/reviews/preview-assets`,{recursive:true});await writeFile(`${KIT}/out/reviews/preview-assets/report.json`,JSON.stringify({checked,errors},null,2));
}
