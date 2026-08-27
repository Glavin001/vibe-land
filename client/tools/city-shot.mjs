// Visual check on the live /city: look at the city, screenshot, print counters.
import { chromium } from 'playwright-core';
const GPU_ARGS = ['--enable-quic','--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors',
  '--allow-insecure-localhost','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan',
  '--ignore-gpu-blocklist','--enable-gpu-rasterization'];
const OUT = process.argv[2] ?? 'tools/profiles/city.png';
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => { const t = m.text(); if (/\[city\]/.test(t)) logs.push(t.slice(0, 300)); });
page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 300)));
await page.route('**/session-config*', async (route) => {
  const r = await route.fetch(); const b = JSON.parse(await r.text());
  b.url = 'https://127.0.0.1:4434/game';
  await route.fulfill({ response: r, body: JSON.stringify(b), headers: { ...r.headers(), 'content-type': 'application/json' } });
});
await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 30000 });
await page.mouse.click(640, 360);
await page.waitForFunction(() => { const c = window.__VIBE_E2E__?.snapshot()?.city; return !!c && c.chunksTotal > 0 && c.rendered; }, { timeout: 90000 });
// Face the city (single structure at the origin; spawn is at +X) and drop the
// panel so the screenshot is the scene, not the overlay.
await page.evaluate(() => window.__VIBE_DRIVE__.look(-1.57, -0.08));

await page.waitForTimeout(5000);
await page.screenshot({ path: OUT });
const p = await page.evaluate(() => window.__VIBE_E2E__.frameProfile());
const c = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city);
console.log(`draws ${p.drawCalls}  tris ${p.triangles}  gl ${p.glRenderMs.toFixed(2)}ms  cpu ${p.cpuFrameMs.toFixed(2)}ms  frame ${p.frameTotalMs.toFixed(1)}ms`);
console.log(`chunks total ${c.chunksTotal} settled ${c.chunksSettled} awake ${c.chunksAwake} unresolved ${p.chunksUnresolved} hidden ${p.chunksHidden}`);
logs.forEach(l => console.log(l));
await browser.close();
