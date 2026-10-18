import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from '../../../../client/node_modules/playwright-core/index.mjs';
const root=new URL('../../out/reviews/tape-stalls/',import.meta.url);
const base=process.env.REVIEW_URL??'https://127.0.0.1:1111',label=process.env.REVIEW_LABEL??'deployed';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:800}});
await context.addInitScript(()=>{localStorage.setItem('vibe.render.tier','fast');localStorage.setItem('vibe.render.shadows','0');});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/diag-tape',route=>route.fulfill({body:readFileSync('/root/.codex/attachments/15ca05df-ddcd-4c89-8239-2ce96113e2c1/city-2026-09-21T08-47-01-252Z.vltape'),contentType:'application/octet-stream'}));
await page.goto(base+'/cityreplay?dust=0',{waitUntil:'domcontentloaded'});
await page.evaluate(async()=>{const bytes=new Uint8Array(await(await fetch('/diag-tape')).arrayBuffer());await new Promise((resolve,reject)=>{const r=indexedDB.open('vibe.city.tapes',1);r.onupgradeneeded=()=>r.result.createObjectStore('tapes');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('tapes','readwrite');tx.objectStore('tapes').put(bytes,'last');tx.oncomplete=()=>{db.close();resolve(null)};tx.onerror=()=>reject(tx.error)};});});
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__VIBE_REPLAY__?.ready?.()===true,null,{timeout:120000});
await page.evaluate(async()=>{window.__VIBE_REPLAY__.pause();await window.__VIBE_REPLAY__.seek(53000);window.__VIBE_REPLAY__.setSpeed(0.25);});
await page.waitForTimeout(2000);await page.evaluate(()=>window.__VIBE_REPLAY__.play());
for(const target of [57000,58200,58600,59000,60000]){await page.waitForFunction(t=>window.__VIBE_REPLAY__.timeMs()>=t,target,{timeout:60000});await page.screenshot({path:new URL(`replay-${label}-${target}.png`,root).pathname});console.log(await page.evaluate(()=>({t:window.__VIBE_REPLAY__.timeMs(),frames:window.__VIBE_E2E__?.frameProfile?.().frameMs})));}
await page.evaluate(()=>window.__VIBE_REPLAY__.pause());
writeFileSync(new URL(`browser-${label}-errors.json`,root),JSON.stringify(errors,null,2));await browser.close();
