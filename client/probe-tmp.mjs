import { chromium } from 'playwright';
const EYE=1.6, aim=(p,t)=>{const dx=t[0]-p[0],dy=t[1]-(p[1]+EYE),dz=t[2]-p[2],h=Math.hypot(dx,dz);
  return {yaw:Math.atan2(dx,dz),pitch:Math.atan2(dy,Math.max(1e-4,h)),distance:Math.hypot(h,dy)};};
const browser = await chromium.launch({args:['--ignore-certificate-errors','--allow-insecure-localhost','--enable-unsafe-swiftshader','--use-gl=swiftshader']});
const ctx = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:1280,height:720}});
const page = await ctx.newPage();
await page.route('**/session-config*', async r0=>{const r=await r0.fetch();const b=JSON.parse(await r.text());
  b.url='https://127.0.0.1:4435/game';
  await r0.fulfill({response:r,body:JSON.stringify(b),headers:{...r.headers(),'content-type':'application/json'}});});
await page.goto(process.argv[2],{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForFunction(()=>!!(window).__VIBE_E2E__,{timeout:30000});
await page.mouse.click(640,360);
const snap=async()=>page.evaluate(()=>(window).__VIBE_E2E__.snapshot());
for(let i=0;i<60;i++){const s=await snap(); if(s.city) break; await page.waitForTimeout(500);}
let s=await snap();
const targets=await page.evaluate(async hash=>{const m=await (await fetch(`/city-manifest/${hash}`)).json();
  return m.structures.map(st=>({n:st.chunks.length,pos:st.worldPosition,top:Math.max(...st.chunks.map(c=>c.centroid[1]))}))
   .sort((a,b)=>b.n-a.n).map(x=>[x.pos[0],x.pos[1]+x.top*0.35,x.pos[2]]);}, s.city.manifestHash);
const target=targets[0];
for(let step=0;step<40;step++){s=await snap();const a=aim(s.position,target);
  if(a.distance<=12) break;
  await page.evaluate(y=>(window).__VIBE_DRIVE__.look(y,0),a.yaw);
  await page.evaluate(()=>(window).__VIBE_DRIVE__.move({forward:1,durationMs:1200}));
  await page.waitForTimeout(1000);}
await page.evaluate(()=>(window).__VIBE_DRIVE__.stop());
for(let i=0;i<50;i++){s=await snap();const a=aim(s.position,target);
  await page.evaluate(([y,p])=>(window).__VIBE_DRIVE__.look(y,p),[a.yaw,a.pitch]);
  await page.waitForTimeout(120);
  await page.evaluate(()=>(window).__VIBE_DRIVE__.fire({holdMs:120}));
  await page.waitForTimeout(280);}
console.log('fired; now idling 90s');
for(const t of [15,30,45,60,75,90]) {
  await page.waitForTimeout(15000);
  const c=(await snap()).city||{};
  console.log(`t+${t}s  awake=${c.chunksAwake}  settled=${c.chunksSettled}  broken=${c.brokenBonds}`);
}
await browser.close();
