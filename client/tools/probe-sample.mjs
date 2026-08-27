/**
 * Cost of samplePresentation under a real demolition.
 *
 * At rest the sampler is free -- every body is asleep and the epsilon check
 * skips the write -- so measuring an intact city says nothing. This knocks
 * towers down first, then reports `sample` against the awake/asleep split it
 * actually has to walk.
 */
import { chromium } from 'playwright-core';
const A=['--enable-quic','--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors',
  '--allow-insecure-localhost','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan',
  '--ignore-gpu-blocklist','--disable-gpu-vsync','--disable-frame-rate-limit'];
const LABEL = process.argv[2] ?? 'run';
const b = await chromium.launch({ headless: true, args: A });
const p = await b.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
await p.route('**/session-config*', async r0 => { const r = await r0.fetch(); const j = JSON.parse(await r.text());
  j.url='https://127.0.0.1:4434/game';
  await r0.fulfill({ response:r, body:JSON.stringify(j), headers:{...r.headers(),'content-type':'application/json'} }); });
await p.goto('https://127.0.0.1:6006/city',{waitUntil:'domcontentloaded',timeout:60000});
await p.waitForFunction(()=>!!window.__VIBE_E2E__,{timeout:30000});
await p.mouse.click(640,360);
await p.waitForFunction(()=>{const c=window.__VIBE_E2E__?.snapshot()?.city;return !!c&&c.chunksTotal>0&&c.rendered;},{timeout:90000});
// Hide the panel: its 2 Hz sweep is a separate cost and would pollute the read.
await p.evaluate(()=>document.querySelector('[title="Hide (F9)"]')?.click());

const hash = (await p.evaluate(()=>window.__VIBE_E2E__.snapshot().city)).manifestHash;
const targets = await p.evaluate(async h => {
  const m = await (await fetch(`/city-manifest/${h}`)).json();
  return m.structures.map(s=>({n:s.chunks.length,pos:s.worldPosition,
    top:Math.max(...s.chunks.map(c=>c.centroid[1]))}))
    .sort((a,b)=>b.n-a.n).slice(0,5).map(s=>[s.pos[0],(s.pos[1]+s.top)*0.35,s.pos[2]]);
}, hash);
for (const t of targets) {
  for (let i=0;i<10;i++) {
    await p.evaluate(async target => {
      const s = window.__VIBE_E2E__.snapshot();
      const dx=target[0]-s.position[0], dy=target[1]-(s.position[1]+0.8), dz=target[2]-s.position[2];
      window.__VIBE_DRIVE__.look(Math.atan2(dx,dz), Math.atan2(dy, Math.max(1e-4, Math.hypot(dx,dz))));
      await new Promise(r=>setTimeout(r,110));
      window.__VIBE_DRIVE__.fire({holdMs:110});
    }, t);
    await p.waitForTimeout(200);
  }
}
await p.waitForTimeout(6000);
const rows = await p.evaluate(async () => { const o=[];
  await new Promise(res=>{const t=()=>{o.push(window.__VIBE_E2E__.frameProfile());o.length>=300?res():requestAnimationFrame(t);};requestAnimationFrame(t);});
  return o; });
const city = await p.evaluate(()=>window.__VIBE_E2E__.snapshot().city);
const med = k => { const v=rows.map(r=>r[k]??0).sort((a,b)=>a-b); return v[v.length>>1]; };
const p95 = k => { const v=rows.map(r=>r[k]??0).sort((a,b)=>a-b); return v[Math.floor(v.length*0.95)]; };
console.log(`[${LABEL}] sample p50 ${med('sampleMs').toFixed(2)}ms p95 ${p95('sampleMs').toFixed(2)}ms | `
  + `cityFrame p50 ${med('cityFrameMs').toFixed(2)} | cpu p50 ${med('cpuFrameMs').toFixed(2)} | `
  + `frame p95 ${p95('frameTotalMs').toFixed(2)}ms`);
console.log(`   awake ${city.chunksAwake} settled ${city.chunksSettled} bonds ${city.brokenBonds} islands ${city.liveIslands}`);
await b.close();
