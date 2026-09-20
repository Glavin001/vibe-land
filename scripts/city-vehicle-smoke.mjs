// Load /city in a real browser, walk to the nearest car, get in, drive, get
// out, and report what the client saw. Proves the vehicle path end to end:
// the seeded cars arrive over the snapshot stream, the E key resolves the car
// by its wire handle, the driven car moves under thin-authoritative input
// and the driver's own snapshot keeps up with it.
//
//   CITY_URL=https://127.0.0.1:8385/city WT_PORT=4535 node scripts/city-vehicle-smoke.mjs
import { chromium } from 'playwright-core';

const CITY_URL = process.env.CITY_URL ?? 'https://127.0.0.1:6006/city';
const WT_PORT = process.env.WT_PORT ?? '';
// On the GPU, never SwiftShader: the town is 49k chunks and software
// rendering runs the frame loop at 4 fps, which starves the input path and
// reads as "the player will not move". --use-angle=vulkan reaches the NVIDIA
// device in new headless mode; the default and --use-gl=egl silently fall
// back to SwiftShader, so the renderer string is checked and the run fails
// rather than measuring the wrong thing.
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--headless=new', '--use-angle=vulkan', '--ignore-gpu-blocklist',
         '--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const d = gl?.getExtension('WEBGL_debug_renderer_info');
  return gl ? (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no webgl2';
});
console.log('webgl renderer:', renderer);
if (!/nvidia/i.test(renderer) || /swiftshader/i.test(renderer)) {
  console.log('FAIL: headless Chrome is not on the GPU (' + renderer + '); refusing to run on a software renderer');
  await browser.close(); process.exit(3);
}
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text().slice(0, 160)} (${m.location()?.url ?? ''})`); });
page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));

if (WT_PORT) {
  // The container cannot reach its own public address; rewrite host and port
  // only, and keep the advertised path exactly as the server sent it.
  await page.route('**/session-config*', async route => {
    const r = await route.fetch(); const b = JSON.parse(await r.text());
    const u = new URL(b.url); u.hostname = '127.0.0.1'; u.port = WT_PORT; b.url = u.toString();
    await route.fulfill({ response: r, body: JSON.stringify(b),
      headers: { ...r.headers(), 'content-type': 'application/json' } });
  });
}

// The match server loads its scene after the HTTP surface is up; wait until
// it hands out a manifest before joining.
const origin = new URL(CITY_URL).origin;
for (let i = 0; i < 60; i++) {
  const ok = await page.evaluate(async (u) => { try { const r = await fetch(u); const t = await r.text(); return r.ok && t.includes('city_manifest_hash'); } catch { return false; } },
    `${origin}/session-config?match_id=city-default`);
  if (ok) break;
  await page.waitForTimeout(2000);
}
const sep = CITY_URL.includes('?') ? '&' : '?';
const snap = () => page.evaluate(() => window.__VIBE_E2E__.snapshot());
const fail = async (why) => { console.log('FAIL:', why); await finish(1); };
const finish = async (code) => { console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none'); await browser.close(); process.exit(code); };

// The cars are parked by the east and west spawn areas, 80 m past the area of
// interest of the north and south ones, so a player who spawns there never
// sees one. Rejoin until we spawn beside a car.
let connected = false, s = null;
for (let attempt = 1; attempt <= 6 && !connected; attempt++) {
  await page.goto(`${CITY_URL}${sep}portal=true&match=city-default`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__VIBE_E2E__?.snapshot?.()?.connected, null, { timeout: 60000 }).catch(() => {});
  connected = await page.waitForFunction(
    () => (window.__VIBE_E2E__?.snapshot?.()?.vehicles?.length ?? 0) > 0,
    null, { timeout: 12000 },
  ).then(() => true).catch(() => false);
  s = await snap();
  console.log(`join ${attempt}: connected ${s.connected} transport ${s.debugStats?.transport} at ${s.movementTelemetry.authoritativePosition.map(x => x.toFixed(0))}, vehicles in view: ${s.vehicles?.length ?? 0}`);
}
if (!connected) await fail('no vehicle ever arrived in the snapshot stream');

// Walk to the nearest car.
const me = s.movementTelemetry.authoritativePosition;
const car = s.vehicles.map(v => ({ ...v, d: Math.hypot(v.position[0] - me[0], v.position[2] - me[2]) })).sort((a, b) => a.d - b.d)[0];
console.log('nearest car:', car.id, 'at', car.position.map(x => x.toFixed(1)), `${car.d.toFixed(1)} m away, driver ${car.driverId}`);
const walkStart = Date.now();
let lastCar = car, lastD = car.d, lastLog = 0;
while (Date.now() - walkStart < 40000) {
  s = await snap();
  const p = s.movementTelemetry.authoritativePosition;
  lastCar = s.vehicles.find(x => x.id === car.id) ?? lastCar;
  lastD = Math.hypot(lastCar.position[0] - p[0], lastCar.position[2] - p[2]);
  if (Date.now() - lastLog > 2000) { console.log(`  walking: ${lastD.toFixed(1)} m from the car, player at ${p.map(x => x.toFixed(1))}`); lastLog = Date.now(); }
  if (lastD < 3.0) break;
  // Sprint only while far: a sprinting player covers 3 m between two samples
  // and runs straight past the car.
  await page.evaluate(([x, y, z, far]) => { window.__VIBE_DRIVE__.lookAt(x, y, z); window.__VIBE_DRIVE__.setSprint(far); window.__VIBE_DRIVE__.move({ forward: 1, durationMs: 400 }); }, [...lastCar.position, lastD > 12]);
  await page.waitForTimeout(300);
}
await page.evaluate(() => window.__VIBE_DRIVE__.stop());
await page.waitForTimeout(300);
s = await snap();
console.log('near the car: nearestVehicleId', s.nearestVehicleId, 'distance', lastD.toFixed(2));
if (s.nearestVehicleId == null) await fail('never got within interact range of the car');

// Get in.
await page.evaluate(() => window.__VIBE_DRIVE__.interact());
const entered = await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().inVehicle, null, { timeout: 5000 }).then(() => true).catch(() => false);
s = await snap();
console.log('entered:', entered, 'drivenVehicleId', s.drivenVehicleId, 'inVehicle', s.inVehicle ?? s.debugStats?.inVehicle);
if (!entered) await fail('E did not put the player in the car (server rejected VehicleEnter or the handle resolved to nothing)');

// Drive forward for four seconds.
const before = (s.vehicles.find(x => x.id === car.id) ?? lastCar).position;
await page.evaluate(() => window.__VIBE_DRIVE__.move({ forward: 1, durationMs: 4000 }));
// One line a second: the speed profile is what tells a car that accelerated
// from one that hit a house or never woke.
for (let t = 1; t <= 4; t++) {
  await page.waitForTimeout(1000);
  const v = (await snap()).vehicles.find(x => x.id === car.id);
  if (v) console.log(`  t=${t}s car at ${v.position.map(x => x.toFixed(1))} ${v.speedMs.toFixed(1)} m/s`);
}
await page.waitForTimeout(500);
s = await snap();
const after = s.vehicles.find(x => x.id === car.id);
if (!after) await fail('the driven car dropped out of the snapshot');
const driven = Math.hypot(after.position[0] - before[0], after.position[2] - before[2]);
const seated = s.movementTelemetry.authoritativePosition;
const seatedGap = Math.hypot(after.position[0] - seated[0], after.position[2] - seated[2]);
console.log(`drove ${driven.toFixed(1)} m in 4 s, speed now ${after.speedMs.toFixed(1)} m/s, driver ${after.driverId}, seated player ${seatedGap.toFixed(2)} m from the car`);
if (driven < 5) await fail('the car did not move under throttle');
if (seatedGap > 3) await fail('the seated player did not follow the car');

// Get out.
await page.evaluate(() => window.__VIBE_DRIVE__.interact());
const exited = await page.waitForFunction(() => !window.__VIBE_E2E__.snapshot().inVehicle, null, { timeout: 5000 }).then(() => true).catch(() => false);
s = await snap();
console.log('exited:', exited, 'inVehicle', s.inVehicle, 'driver now', s.vehicles.find(x => x.id === car.id)?.driverId);
if (!exited) await fail('E did not get the player out of the car');
console.log('VEHICLE SMOKE PASS');
await finish(0);
