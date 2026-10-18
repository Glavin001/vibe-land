// One session, one viewpoint, every pool size.
//
// Separate runs cannot be compared: the player spawns somewhere different each
// session (two runs landed on opposite sides of the city), and the seams this
// is meant to show are smaller than that difference. Cycling the panel button
// in place keeps the camera fixed and exercises the live rebuild as well.
import { chromium } from 'playwright-core';
const GPU_ARGS = ['--enable-quic','--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors',
  '--allow-insecure-localhost','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan',
  '--ignore-gpu-blocklist','--enable-gpu-rasterization'];
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const built = [];
page.on('console', m => { const t = m.text(); if (/chunk meshes ready/.test(t)) built.push(t.slice(0,220)); });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0,200)));
await page.route('**/session-config*', async (route) => {
  const r = await route.fetch(); const b = JSON.parse(await r.text());
  b.url = 'https://127.0.0.1:4434/game';
  await route.fulfill({ response: r, body: JSON.stringify(b), headers: { ...r.headers(), 'content-type': 'application/json' } });
});
await page.goto('https://127.0.0.1:6006/city?hullPool=0', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 30000 });
await page.mouse.click(640, 360);
await page.waitForFunction(() => { const c = window.__VIBE_E2E__?.snapshot()?.city; return !!c && c.chunksTotal > 0 && c.rendered; }, { timeout: 90000 });

// Shoot from the spawn ring, not from inside the city. Walking in stopped at
// 57 m -- which is inside downtown's 131x153 m footprint, pressed against a
// facade -- and photographed a wall. From the ring the whole skyline frames.
const pos = await page.evaluate(() => window.__VIBE_E2E__.snapshot().position);
await page.evaluate((yaw) => window.__VIBE_DRIVE__.look(yaw, -0.06), Math.atan2(-pos[0], -pos[2]));
await page.waitForTimeout(2500);
console.log(`camera ${pos.map(v=>v.toFixed(1)).join(',')} dist ${Math.hypot(pos[0],pos[2]).toFixed(1)}m`);

for (const want of [0, 16, 64, 256]) {
  // Cycle until the store actually reports the size we want, and confirm the
  // rebuild landed. Clicking blind reported four rows that were really two:
  // draw calls stayed at 40 when 64 patterns should have given ~88.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = await page.evaluate(() => Number(localStorage.getItem('vibe.render.hullPool') ?? 0));
    if (now === want) break;
    // DOM click, not a synthetic mouse click: after the page has requested
    // pointer lock, Playwright's mouse clicks stop reaching the panel and fail
    // silently -- which reported four pool sizes that were really one.
    await page.evaluate(() => document.querySelector('[data-testid="city-hull-pool"]')?.click());
    await page.waitForTimeout(1500);
  }
  const got = await page.evaluate(() => Number(localStorage.getItem('vibe.render.hullPool') ?? 0));
  // The rebuild is a frame-loop teardown; give it time to finish before reading.
  await page.waitForTimeout(4000);
  const label = want === 0 ? 'exact' : String(want);
  await page.screenshot({ path: `tools/profiles/cmp-${label}.png` });
  const prof = await page.evaluate(() => window.__VIBE_E2E__.frameProfile());
  console.log(`  ${label.padEnd(6)} store=${String(got).padStart(3)} draws ${String(prof.drawCalls).padStart(4)}`
    + ` tris ${String(prof.triangles).padStart(7)} gl ${prof.glRenderMs.toFixed(2)}ms cpu ${prof.cpuFrameMs.toFixed(2)}ms`);
}
built.forEach(l => console.log('  ' + l));
await browser.close();
