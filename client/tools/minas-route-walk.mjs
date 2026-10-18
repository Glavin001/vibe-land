// Walk both rebuilt Minas Tirith routes with real server-authoritative players.
// No flying, jumping, teleporting, damage, or changes to public settings.
// node client/tools/minas-route-walk.mjs https://127.0.0.1:1111 4433 /tmp/minas-live-routes.json
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
const [origin,udpPort,output='/tmp/minas-live-routes.json']=process.argv.slice(2);
if(!origin||!/^\d+$/.test(udpPort??''))throw Error('Expected HTTPS origin and local UDP port');
const expectedChunks=JSON.parse(readFileSync(new URL('../../destruction/assets/scenes/minas-tirith-rebuilt.json',import.meta.url))).scenario.nodes.length;
const report={ok:false,expectedChunks,routes:[],errors:[]};
const browser=await chromium.launch({headless:true,args:[
  '--no-sandbox','--ignore-certificate-errors','--disable-dev-shm-usage',
  '--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding',
]});
const deadline=setTimeout(async()=>{
  report.errors.push('Traversal deadline exceeded');
  writeFileSync(output,JSON.stringify(report,null,2));
  await browser.close();process.exit(1);
},600000);
async function walk(side) {
  const name=side<0?'left':'right';
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:270}});
  const page=await context.newPage();
  try {
    page.on('pageerror',e=>report.errors.push(`${name}: ${e}`));
    page.on('console',m=>{if(m.text().startsWith('ROUTE '))console.log(m.text());});
    await page.addInitScript(()=>{
      for(const [k,v]of Object.entries({tier:'fast',shadows:'0',ao:'0',cityTextures:'off',skyIbl:'0',skyDome:'0',dprCap:'1'}))localStorage.setItem(`vibe.render.${k}`,v);
    });
    await page.route('**/session-config*',async route=>{
      const response=await route.fetch(),body=await response.json(),url=new URL(body.url);
      if(url.pathname!=='/game')throw Error(`Unexpected WebTransport path: ${url.pathname}`);
      url.hostname='127.0.0.1';url.port=udpPort;body.url=url.toString();
      await route.fulfill({response,json:body});
    });
    await page.goto(`${origin}/city?portal=true&match=city-default`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.__VIBE_E2E__&&!!window.__VIBE_DRIVE__);
    await page.mouse.click(240,135);
    await page.waitForFunction(()=>{
      const s=window.__VIBE_E2E__.snapshot();return s.transport==='webtransport'&&s.city?.bootstraps>0&&s.city?.rendered;
    },null,{timeout:60000});
    return await page.evaluate(async({name,side,expectedChunks})=>{
      const bridge=window.__VIBE_DRIVE__,read=()=>window.__VIBE_E2E__.snapshot();
      const points=[],levels=[],polar=(r,segment)=>[side*r*Math.sin(segment*Math.PI/48),r*Math.cos(segment*Math.PI/48)];
      const line=(p,label=null,floor=null)=>points.push({p,label,floor});
      const arc=(r,a,b)=>{for(let t=a;Math.abs(t-a)<Math.abs(b-a);t+=Math.sign(b-a)*0.5)line(polar(r,t));line(polar(r,b));};
      if(read().city.chunksTotal!==expectedChunks)throw Error('Server is serving a different scene revision');
      const start=read().movementTelemetry.authoritativePosition;
      console.log('ROUTE '+JSON.stringify({name,start,chunks:read().city.chunksTotal}));
      // Approach from the spawn ring, outside every rampart, through this side's gate.
      let bearing=Math.atan2(side*start[0],start[2])*48/Math.PI;
      while(bearing-4.5>48)bearing-=96;
      while(bearing-4.5< -48)bearing+=96;
      line(polar(138,bearing));arc(138,bearing,4.5);
      line(polar(119,4.5));line(polar(107,4.5));arc(107,4.5,22.5);
      line(polar(112.5,22.5),'base',0);
      for(let tier=0;tier<6;tier++) {
        const r=112.5-tier*15,a=tier%2===0?22.5:37.5,b=tier%2===0?37.5:22.5;
        arc(r,a,b);line(polar(r-15,b),`tier-${tier+1}`,(tier+1)*9);
      }
      line([side*2,8],'summit',54);
      bridge.setSprint(false);
      let lastPosition=start,stuck=0;
      try {
        for(let index=0;index<points.length;index++) {
          const target=points[index];
          while(true) {
            const s=read(),p=s.movementTelemetry.authoritativePosition;
            if(s.dead||!s.connected)throw Error(`${name}: player died or disconnected`);
            const dx=target.p[0]-p[0],dz=target.p[1]-p[2],d=Math.hypot(dx,dz);
            if(d<0.55)break;
            const moved=Math.hypot(p[0]-lastPosition[0],p[1]-lastPosition[1],p[2]-lastPosition[2]);
            stuck=moved<0.015?stuck+1:0;lastPosition=p;
            if(stuck>100)throw Error(`${name}: blocked near ${JSON.stringify(p)}, waypoint ${index} ${JSON.stringify(target)}`);
            bridge.look(Math.atan2(dx,dz),0);bridge.move({forward:Math.min(1,d/0.8),durationMs:300});
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          if(target.label) {
            const s=read(),p=s.movementTelemetry.authoritativePosition;
            if(Math.abs((p[1]-0.8)-target.floor)>0.65)throw Error(`${name}: wrong height at ${target.label}: ${p[1]}`);
            const checkpoint={label:target.label,position:p};levels.push(checkpoint);
            console.log('ROUTE '+JSON.stringify({name,...checkpoint}));
          }
        }
        const s=read();
        if(s.city.orphanedChunks||s.city.hashMismatches)throw Error('City state divergence');
        return {name,ok:true,levels,position:s.movementTelemetry.authoritativePosition,chunks:s.city.chunksTotal};
      } finally {bridge.clear();}
    },{name,side,expectedChunks});
  } catch(e) {return {name,ok:false,error:String(e)};}
  finally {await context.close();}
}
try {
  report.routes=await Promise.all([-1,1].map(walk));
  report.ok=report.routes.every(r=>r.ok)&&report.errors.length===0;
} finally {
  clearTimeout(deadline);writeFileSync(output,JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;
