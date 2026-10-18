import {chromium} from '../../../client/node_modules/playwright-core/index.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {KIT} from '../src/dependencies.mjs';
const browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>errors.push(String(e)));
 for(const asset of ['bayline-outdoor-baseline','bayline-outdoor-town','outdoor-tree-reuse']){
  await page.goto(`http://127.0.0.1:6174/?asset=${asset}&clean`);
  await page.waitForFunction(()=>window.__TOWN_KIT__?.error||(window.__TOWN_KIT__?.ready&&window.__VIBE_CITY_TEX_READY__),null,{timeout:60000});
  const error=await page.evaluate(()=>window.__TOWN_KIT__.error);if(error)throw Error(error);
  const cameras=asset==='outdoor-tree-reuse'?['hero']:['hero','garden-homes','shopping-row'];
  for(const name of cameras){
   const available=await page.evaluate(name=>{const kit=window.__TOWN_KIT__,cameras=kit.stats().cameras;if(!cameras[name])return false;kit.setCamera(cameras[name]);return true;},name);if(!available)throw Error(`Missing benchmark camera ${name}`);
   const sample=await page.evaluate(async()=>{
    const frames=async(n,collect)=>{let previous=performance.now();const times=[];for(let i=0;i<n;i++){const now=await new Promise(requestAnimationFrame);if(collect)times.push(now-previous);previous=now;}return times;};
    await frames(60,false);const times=await frames(180,true);times.sort((a,b)=>a-b);const {cameras,...stats}=window.__TOWN_KIT__.stats();return {p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],stats};
   });results.push({asset,camera:name,...sample});console.log(JSON.stringify({asset,camera:name,p95:sample.p95,drawCalls:sample.stats.render.calls,outdoor:sample.stats.outdoor}));
  }
 }
}finally{await browser.close();}
const comparisons=results.filter(r=>r.asset==='bayline-outdoor-town').map(r=>{const base=results.find(b=>b.asset==='bayline-outdoor-baseline'&&b.camera===r.camera);return {camera:r.camera,p95Ratio:r.p95/base.p95,withinProvisional15Percent:r.p95<=base.p95*1.15};});
await mkdir(`${KIT}/out/reviews/outdoor-performance`,{recursive:true});
await writeFile(`${KIT}/out/reviews/outdoor-performance/report.json`,JSON.stringify({viewport:[1280,800],exclusiveGpu:false,metric:'requestAnimationFrame interval, 60 warmup + 180 measured frames per fixed camera',results,comparisons,errors,passed:!errors.length&&comparisons.every(c=>c.withinProvisional15Percent)},null,2));
if(errors.length)throw Error(errors.join('\n'));
