// Non-destructive city camera check. Uses loopback WT routing, not external UDP proof.
// node client/tools/city-flight-smoke.mjs <https-origin> <local-wt-port> <report.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [origin, udpPort, output] = process.argv.slice(2);
if (!origin || !udpPort || !output) throw Error('Expected origin, local WT port, and report path');
const report = { ok: false, phases: [], errors: [], publicUdpVerified: false };
let browser;
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const mark = (name, data = {}) => { report.phases.push({ name, ...data }); save(); console.log(name, JSON.stringify(data)); };
const assert = (condition, message) => { if (!condition) throw Error(message); };
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const faults = ['orphanedChunks', 'hashMismatches', 'topoSeqGaps', 'settleRejects', 'orphanedByRetire', 'structureRepairs'];
save(); // A previous successful report must never survive a failed new run.
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    for (const [k, v] of Object.entries({ tier: 'fast', shadows: '0', ao: '0', cityTextures: 'off', skyIbl: '0', skyDome: '0', dprCap: '1' })) localStorage.setItem(`vibe.render.${k}`, v);
  });
  await context.route('**/session-config*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    const url = new URL(json.url);
    assert(url.pathname === '/game', 'Unexpected WebTransport path');
    url.hostname = '127.0.0.1'; url.port = udpPort; json.url = url.toString();
    await route.fulfill({ response, json });
  });
  const page = await context.newPage();
  page.on('pageerror', error => { report.errors.push(String(error)); save(); });
  await page.goto(`${origin}/city?portal=true&match=city-default`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const s = window.__VIBE_E2E__?.snapshot();
    return s?.transport === 'webtransport' && s.city?.rendered && s.city.chunksTotal > 0 && s.city.bootstraps > 0;
  }, null, { timeout: 90000 });
  const snapshot = () => page.evaluate(() => window.__VIBE_E2E__.snapshot());
  const hold = async (keys, duration) => {
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(duration);
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await page.waitForTimeout(300);
  };
  const loaded = await snapshot();
  assert(await page.evaluate(() => window.crossOriginIsolated), 'Missing cross-origin isolation');
  mark('city loaded', { chunks: loaded.city.chunksTotal, position: loaded.position });
  const toggle = page.getByTestId('city-flight-toggle');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="city-flight-toggle"]')?.getAttribute('aria-pressed') === 'true');
  assert(!await page.evaluate(() => !!document.pointerLockElement), 'UI button captured the mouse');
  await page.mouse.click(400, 360);
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.waitForTimeout(500);
  const start = await snapshot();
  await hold(['Space'], 2000);
  const risen = await snapshot();
  assert(risen.cameraPosition[1] - start.cameraPosition[1] > 5, 'Camera did not rise');
  assert(distance(risen.position, start.position) < 0.5, 'Flight moved the player');
  mark('rise without player movement', { camera: risen.cameraPosition, player: risen.position });
  await hold(['KeyW'], 1200);
  const forward = await snapshot();
  assert(distance(forward.cameraPosition, risen.cameraPosition) > 3, 'Camera did not fly forward');
  await hold(['ShiftLeft', 'Space'], 1500);
  const boosted = await snapshot();
  assert(boosted.cameraPosition[1] - forward.cameraPosition[1] > 10, 'Flight boost did not rise');
  await hold(['KeyC'], 800);
  const descended = await snapshot();
  assert(boosted.cameraPosition[1] - descended.cameraPosition[1] > 2, 'Camera did not descend');
  // Headless Chromium's pointer recentering emits opposite trusted deltas for
  // absolute mouse.move calls. Inject relative deltas through the normal DOM
  // listener; do not claim this checks physical OS mouse behavior.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 600, movementY: 260, bubbles: true })));
  await page.waitForTimeout(700);
  const looked = await snapshot();
  assert(Math.abs(looked.cameraYaw - descended.cameraYaw) > 0.01, 'Mouse look did not turn camera');
  mark('relative mouse input', { beforeYaw: descended.cameraYaw, afterYaw: looked.cameraYaw, syntheticDelta: true });
  await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
  await page.evaluate(() => window.__VIBE_DRIVE__?.move({ forward: 1, durationMs: 600 }));
  await page.waitForTimeout(900);
  const neutral = await snapshot();
  assert(neutral.shotsFired === start.shotsFired, 'Flight fired the grounded weapon');
  assert(distance(neutral.position, start.position) < 0.5, 'Flight allowed agent input to move the player');
  mark('move boost descend look and neutral weapon', { camera: neutral.cameraPosition, yaw: neutral.cameraYaw, pitch: neutral.cameraPitch, shots: neutral.shotsFired });
  // Frame the city for visual review using the same relative-look event path.
  // Derive sensitivity from the earlier input, rather than writing camera state.
  await page.evaluate(sensitivity => {
    const s = window.__VIBE_E2E__.snapshot();
    const [x, y, z] = s.cameraPosition;
    const yaw = Math.atan2(-x, -z);
    const pitch = Math.atan2(30 - y, Math.hypot(x, z));
    document.dispatchEvent(new MouseEvent('mousemove', {
      movementX: (yaw - s.cameraYaw) / sensitivity,
      movementY: (pitch - s.cameraPitch) / sensitivity,
      bubbles: true,
    }));
  }, (looked.cameraYaw - descended.cameraYaw) / 600);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  const slider = page.getByRole('slider', { name: 'Flight speed' });
  await slider.focus();
  await page.keyboard.press('End');
  assert(await slider.inputValue() === '100', 'Speed control failed');
  await page.keyboard.press('n');
  assert(await toggle.getAttribute('aria-pressed') === 'true', 'Shortcut toggled flight while editing speed');
  assert(!await page.evaluate(() => !!document.pointerLockElement), 'Speed control captured the mouse');
  const idle = await snapshot();
  await page.waitForTimeout(700);
  assert(distance((await snapshot()).cameraPosition, idle.cameraPosition) < 0.01, 'Unlocked camera drifted');
  await page.screenshot({ path: output.replace(/\.json$/, '') + '.png' });
  mark('speed control and paused camera');
  await toggle.click();
  await page.waitForTimeout(700);
  const returned = await snapshot();
  assert(await toggle.getAttribute('aria-pressed') === 'false', 'Return button did not disable flight');
  assert(distance(returned.cameraPosition, returned.position) < 3, 'Camera did not return to player');
  await page.keyboard.press('n');
  await page.waitForTimeout(400);
  assert(await toggle.getAttribute('aria-pressed') === 'true', 'N did not enable flight');
  await page.keyboard.press('n');
  await page.waitForTimeout(400);
  assert(await toggle.getAttribute('aria-pressed') === 'false', 'N did not disable flight');
  // Do not click to re-engage here: an on-foot click would fire a weapon.
  await hold(['KeyS'], 1400);
  const walked = await snapshot();
  assert(distance(walked.position, returned.position) > 0.25, 'Player movement did not resume');
  assert(walked.city.chunksTotal === loaded.city.chunksTotal, 'Chunks disappeared');
  for (const key of faults) assert(!walked.city[key], `${key}: ${walked.city[key]}`);
  assert(report.errors.length === 0, 'Browser reported JavaScript errors');
  mark('return shortcut and resumed walking', { position: walked.position, chunks: walked.city.chunksTotal });
  report.ok = true;
} catch (error) {
  report.errors.push(String(error));
} finally {
  await browser?.close();
  save();
}
console.log(JSON.stringify({ ok: report.ok, errors: report.errors }));
process.exit(report.ok ? 0 : 1);
