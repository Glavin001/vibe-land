import { chromium } from 'playwright-core';
const A=['--enable-quic','--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors','--allow-insecure-localhost','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist','--disable-gpu-vsync','--disable-frame-rate-limit'];
const b=await chromium.launch({headless:true,args:A});
const p=await b.newPage({ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
await p.route('**/session-config*',async r0=>{const r=await r0.fetch();const j=JSON.parse(await r.text());j.url='https://127.0.0.1:4434/game';await r0.fulfill({response:r,body:JSON.stringify(j),headers:{...r.headers(),'content-type':'application/json'}});});
await p.goto('https://127.0.0.1:6006/city',{waitUntil:'domcontentloaded',timeout:60000});
await p.waitForFunction(()=>!!window.__VIBE_E2E__,{timeout:30000});
await p.mouse.click(640,360);
await p.waitForFunction(()=>{const c=window.__VIBE_E2E__?.snapshot()?.city;return !!c&&c.chunksTotal>0&&c.rendered;},{timeout:90000});
for (const [label, hide] of [['panel visible', false], ['panel hidden (player)', true]]) {
  if (hide) await p.evaluate(()=>document.querySelector('[title="Hide (F9)"]')?.click());
  await p.waitForTimeout(4000);
  const rows = await p.evaluate(async()=>{const o=[];await new Promise(res=>{const t=()=>{o.push(window.__VIBE_E2E__.frameProfile());o.length>=200?res():requestAnimationFrame(t);};requestAnimationFrame(t);});return o;});
  const max = k => Math.max(...rows.map(r=>r[k]??0));
  const p95 = k => {const v=rows.map(r=>r[k]??0).sort((a,b)=>a-b);return v[Math.floor(v.length*0.95)];};
  console.log(`  ${label.padEnd(24)} telemetry max ${max('telemetryMs').toFixed(2)}ms  cityFrame p95 ${p95('cityFrameMs').toFixed(2)}ms  frame p95 ${p95('frameTotalMs').toFixed(2)}ms`);
}
await b.close();
