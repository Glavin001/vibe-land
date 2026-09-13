// Browser proof that Return to player moves the authoritative body and gravity lands it.
// node client/tools/city-camera-drop-smoke.mjs <https-origin> <local-wt-port> <report.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [origin, udpPort, output] = process.argv.slice(2);
if (!origin || !udpPort || !output) throw Error('Expected origin, local WT port, report path');
const result = { ok: false, phases: [], errors: [], externalUdpVerified: false };
const save = () => writeFileSync(output, JSON.stringify(result, null, 2));
const phase = (name, data = {}) => { result.phases.push({ name, ...data }); save(); console.log(name, JSON.stringify(data)); };
const assert = (yes, message) => { if (!yes) throw Error(message); };
let browser;
save();
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 800, height: 450 } });
  await context.addInitScript(() => {
    for (const [key, value] of Object.entries({ tier: 'fast', shadows: '0', ao: '0', cityTextures: 'off', skyIbl: '0', skyDome: '0', dprCap: '1' })) localStorage.setItem(`vibe.render.${key}`, value);
  });
  await context.route('**/session-config*', async route => {
    const response = await route.fetch(); const json = await response.json(); const url = new URL(json.url);
    assert(url.pathname === '/game', 'Unexpected WT path'); url.hostname = '127.0.0.1'; url.port = udpPort; json.url = url.toString();
    await route.fulfill({ response, json });
  });
  const page = await context.newPage();
  page.on('pageerror', error => { result.errors.push(String(error)); save(); });
  await page.goto(`${origin}/city?portal=true&match=city-default`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const s = window.__VIBE_E2E__?.snapshot(); return s?.transport === 'webtransport' && s.city?.rendered && s.city.chunksTotal > 0;
  }, null, { timeout: 90000 });
  const snap = () => page.evaluate(() => window.__VIBE_E2E__.snapshot());
  const start = await snap(); phase('loaded', { position: start.position, chunks: start.city.chunksTotal });
  const toggle = page.getByTestId('city-flight-toggle');
  await toggle.click(); await page.mouse.click(400, 360);
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.down('Space'); await page.waitForTimeout(1800); await page.keyboard.up('Space');
  await page.keyboard.down('KeyD'); await page.waitForTimeout(600); await page.keyboard.up('KeyD');
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(300);
  const flown = await snap();
  assert(flown.cameraPosition[1] > start.position[1] + 20, 'Did not gain sufficient altitude');
  assert(Math.hypot(flown.position[0] - start.position[0], flown.position[2] - start.position[2]) < 0.5, 'Flying moved the player prematurely');
  assert(Math.hypot(flown.cameraPosition[0] - start.position[0], flown.cameraPosition[2] - start.position[2]) > 3, 'Camera did not move horizontally');
  phase('flying above a new location', { camera: flown.cameraPosition, player: flown.position });
  await toggle.click();
  await page.waitForFunction(target => {
    const s = window.__VIBE_E2E__.snapshot(); const p = s.movementTelemetry.authoritativePosition;
    return Math.hypot(p[0] - target[0], p[2] - target[2]) < 1 && p[1] > target[1] - 10 && p[1] <= target[1] + 1;
  }, flown.cameraPosition, { timeout: 5000 });
  const dropped = await snap();
  assert(dropped.hp === start.hp, 'Returning changed health');
  assert(!dropped.inVehicle, 'Returning left the player in a vehicle');
  phase('authoritative body moved to camera', { position: dropped.position, authoritative: dropped.movementTelemetry.authoritativePosition, camera: dropped.cameraPosition });
  await page.waitForFunction(y => {
    const s = window.__VIBE_E2E__.snapshot(); return s.position[1] < y - 4 && s.velocity[1] < -1 && !s.onGround;
  }, flown.cameraPosition[1], { timeout: 5000 });
  const falling = await snap();
  assert(Math.abs(falling.cameraPosition[1] - falling.position[1] - 0.8) < 0.3, 'Camera is not following the falling body');
  phase('gravity falling', { position: falling.position, velocity: falling.velocity });
  await page.waitForFunction(() => { const s = window.__VIBE_E2E__.snapshot(); return s.onGround && !s.dead; }, null, { timeout: 20000 });
  const landed = await snap();
  assert(landed.position[1] < flown.cameraPosition[1] - 10, 'Player did not land below the drop point');
  assert(Math.hypot(landed.position[0] - flown.cameraPosition[0], landed.position[2] - flown.cameraPosition[2]) < 2, 'Player snapped back to the old location');
  assert(landed.city.chunksTotal === start.city.chunksTotal, 'Lost city chunks');
  for (const key of ['orphanedChunks', 'hashMismatches', 'topoSeqGaps', 'settleRejects', 'structureRepairs']) assert(!landed.city[key], `${key}: ${landed.city[key]}`);
  assert(landed.shotsFired === start.shotsFired, 'Test fired a weapon');
  assert(result.errors.length === 0, 'Browser errors');
  phase('landed at camera location', { position: landed.position, hp: landed.hp, onGround: landed.onGround });
  result.ok = true;
} catch (error) { result.errors.push(String(error)); }
finally { await browser?.close(); save(); }
console.log(JSON.stringify({ ok: result.ok, errors: result.errors }));
process.exit(result.ok ? 0 : 1);
