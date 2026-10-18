// Functional test, not a GPU performance or destruction qualification.
import { chromium } from '@playwright/test';
import { vehicles, serializeConfiguration } from '../src/vehicles/configuration.mjs';
const url=process.env.GARAGE_URL ?? 'http://127.0.0.1:5561/garage';
const browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors']});
const page=await browser.newPage({viewport:{width:1440,height:900},ignoreHTTPSErrors:true});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const snapshot=()=>page.evaluate(()=>window.__VIBE_E2E__.snapshot());
try {
  await page.goto(url);
  const model=vehicles.find(v=>v.id===(process.env.GARAGE_MODEL??'buggy'));
  if(!model)throw Error('Unknown GARAGE_MODEL');
  await page.getByRole('button').filter({hasText:model.kind}).click();
  if(process.env.GARAGE_CUSTOM==='1') {
    await page.getByRole('slider',{name:'Wheelbase',exact:true}).fill('2.8');
    await page.getByRole('button',{name:'Frame finish #e7ad21',exact:true}).click();
  }
  const expected=await page.evaluate(()=>JSON.parse(localStorage.getItem('vibe-land/garage/configuration-v1')));
  const response=page.waitForResponse(r=>r.url().endsWith('/vehicle-assets/session')&&r.request().method()==='POST',{timeout:330000});
  await page.getByRole('button',{name:'Test drive',exact:true}).click();
  console.log('Requested private test drive');
  const sessionResponse=await response;
  if(!sessionResponse.ok())throw Error(await sessionResponse.text());
  const session=await sessionResponse.json();
  if(serializeConfiguration(session.vehicle.configuration)!==serializeConfiguration(expected))throw Error('Server changed the customized configuration');
  await page.waitForFunction(()=>window.__VIBE_E2E__?.snapshot().playerId>0,null,{timeout:60000});
  await page.waitForFunction(()=>window.__VIBE_E2E__?.snapshot().vehicles.length===1,null,{timeout:20000});
  const joined=await snapshot();
  if(!joined.matchId.startsWith('garage-')||joined.transport!=='webtransport')throw Error('Wrong session or transport');
  await page.waitForFunction(hash=>window.__VIBE_E2E__.drawnWorld()?.vehicles.some(v=>v.assetHash===hash),session.vehicle.assetHash,{timeout:10000});
  console.log('Joined',joined.matchId,joined.vehicles);
  await page.waitForFunction(()=>window.__VIBE_E2E__?.snapshot().nearestVehicleId!==null,null,{timeout:10000});
  await page.evaluate(()=>window.__VIBE_DRIVE__.interact());
  await page.waitForFunction(()=>window.__VIBE_E2E__.snapshot().inVehicle,null,{timeout:10000});
  const before=(await snapshot()).vehicles[0];
  await page.evaluate(()=>window.__VIBE_DRIVE__.move({forward:1,durationMs:3000}));
  await page.waitForTimeout(3300);
  const after=(await snapshot()).vehicles[0];
  const distance=Math.hypot(after.position[0]-before.position[0],after.position[2]-before.position[2]);
  console.log('Drove',JSON.stringify({distance,before,after,errors}));
  if(distance<2||after.driverId!==joined.playerId)throw Error('Custom vehicle did not move under server-controlled throttle');
  await page.screenshot({path:'/tmp/vibe-garage-test-drive.png'});
  await page.evaluate(()=>window.__VIBE_DRIVE__.stop());
  await page.getByRole('button',{name:'Back to garage',exact:false}).click();
  await page.getByRole('heading',{name:'Make it yours.'}).waitFor();
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS: private WebTransport session, enter, drive and return');
} catch(error) {
  console.error('FAIL',error.message,errors);
  await page.screenshot({path:'/tmp/vibe-garage-drive-failure.png'});
  process.exitCode=1;
} finally {await browser.close();}
