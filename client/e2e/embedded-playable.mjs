import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const origin=process.env.E2E_EMBEDDED_ORIGIN || 'https://127.0.0.1:8384';
const output=process.env.E2E_EMBEDDED_OUTPUT || '/tmp/vibe-embedded-city/browser';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors','--enable-unsafe-swiftshader','--use-gl=swiftshader']});
const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:960,height:540}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.addInitScript(()=>{
 localStorage.setItem('vibe.render.tier','fast');localStorage.setItem('vibe.render.shadows','false');
 localStorage.setItem('vibe.render.ao','false');
});
try {
 await page.route('**/session-config*',async route=>{
  const response=await route.fetch();const data=await response.json();const url=new URL(data.url);
  assert.equal(url.pathname,'/game','bad advertised WebTransport path');
  url.hostname='127.0.0.1';url.port='4435';data.url=url.toString();
  await route.fulfill({response,json:data});
 });
 await page.goto(`${origin}/city?portal=true&match=city-default`,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>!!window.__VIBE_E2E__,null,{timeout:60000});
 await page.mouse.click(480,270);
 await page.waitForFunction(()=>window.__VIBE_E2E__.snapshot().transport==='webtransport',null,{timeout:60000});
 assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 await page.waitForFunction(()=>window.__VIBE_E2E__.snapshot().city?.chunksTotal>0,null,{timeout:60000});
 const before=await page.evaluate(()=>window.__VIBE_E2E__.snapshot());
 console.log(JSON.stringify({phase:'joined',snapshot:before}));
 await page.screenshot({path:`${output}/before.png`});
 await page.evaluate(()=>window.__VIBE_DRIVE__.lookAt(0,7,0));
 await page.waitForTimeout(1000);
 for(let i=0;i<4;++i) {await page.evaluate(()=>window.__VIBE_DRIVE__.fire({holdMs:150}));await page.waitForTimeout(1200);}
 await page.evaluate(()=>window.__VIBE_DRIVE__.move({strafe:1}));
 await page.waitForTimeout(1000);
 await page.evaluate(()=>window.__VIBE_DRIVE__.stop());
 await page.evaluate(()=>window.__VIBE_DRIVE__.lookAt(0,5,0));
 await page.waitForTimeout(1500);
 const after=await page.evaluate(()=>window.__VIBE_E2E__.snapshot());
 const statsResponse=await page.request.get(`${origin}/match-stats/city-default`);const stats=await statsResponse.json();
 await page.screenshot({path:`${output}/after.png`});
 writeFileSync(`${output}/result.json`,JSON.stringify({before,after,stats,errors},null,2));
 console.log(JSON.stringify({phase:'after-shooting',snapshot:after,stats}));
 assert.equal(after.transport,'webtransport');
 assert.ok(!stats.city?.degraded,'native city entered degraded state');
 assert.ok(stats.city?.broken_bonds>0,'shots did not produce native fractures');
 assert.ok(stats.city?.chunk_bodies>0 && after.city.liveIslands>0,'no fragments reached the renderer');
 assert.ok(stats.spans['destruction/native_corrections_total'].v>0,'correction was never exercised');
 assert.ok(stats.dynamic_body_count>0,'physical projectiles were not registered');
 assert.ok(Math.hypot(...after.position.map((v,i)=>v-before.position[i]))>1,'player did not move');
 assert.equal(after.city.hashMismatches,0);assert.equal(after.city.orphanedChunks,0);
 const settling=[];
 for(let i=0;i<30;++i) {
  await page.waitForTimeout(1000);
  const sample=await (await page.request.get(`${origin}/match-stats/city-default`)).json();
  settling.push({tick:sample.server_tick,city:sample.city});
  writeFileSync(`${output}/settling.json`,JSON.stringify(settling,null,2));
  assert.ok(!sample.city.degraded,'native scene degraded while settling');
  assert.ok(sample.city.min_body_y>-2,'debris fell beneath the ground');
 }
 await page.screenshot({path:`${output}/settled.png`});
 await page.evaluate(()=>document.exitPointerLock());
 await page.getByTestId('city-reset').click();
 await page.waitForFunction(()=>{const c=window.__VIBE_E2E__.snapshot().city;
  return c?.rendered && c.brokenBonds===0 && c.liveIslands===0;
 },null,{timeout:60000});
 const reset=await page.evaluate(()=>window.__VIBE_E2E__.snapshot());
 assert.equal(reset.city.chunksTotal,before.city.chunksTotal);
 assert.equal(reset.city.hashMismatches,0);
 writeFileSync(`${output}/reset.json`,JSON.stringify(reset,null,2));
} finally {writeFileSync(`${output}/errors.json`,JSON.stringify(errors,null,2));await browser.close();}
