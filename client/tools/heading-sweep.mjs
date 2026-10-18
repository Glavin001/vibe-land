/**
 * Frame cost averaged over a full circle of headings.
 *
 * A single screenshot cannot compare two packs: the player spawns somewhere
 * different every session, and city-wide instanced hulls give up frustum
 * culling, so they lose in a view of nothing and win in a view of everything.
 * Averaging over 12 headings measures the trade instead of one end of it.
 */
import { chromium } from 'playwright-core';
const GPU_ARGS = ['--enable-quic','--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors',
  '--allow-insecure-localhost','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan',
  '--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-gpu-vsync','--disable-frame-rate-limit'];
const LABEL = process.argv[2] ?? 'run';
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const built = [];
page.on('console', m => { const t=m.text(); if (/chunk meshes ready/.test(t)) built.push(t.slice(0,240)); });
await page.route('**/session-config*', async (route) => {
  const r = await route.fetch(); const b = JSON.parse(await r.text());
  b.url = 'https://127.0.0.1:4434/game';
  await route.fulfill({ response: r, body: JSON.stringify(b), headers: { ...r.headers(), 'content-type': 'application/json' } });
});
await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 30000 });
await page.mouse.click(640, 360);
await page.waitForFunction(() => { const c = window.__VIBE_E2E__?.snapshot()?.city; return !!c && c.chunksTotal > 0 && c.rendered; }, { timeout: 90000 });
await page.waitForTimeout(3000);

const rows = [];
for (let i = 0; i < 12; i++) {
  await page.evaluate((yaw) => window.__VIBE_DRIVE__.look(yaw, -0.05), (i / 12) * Math.PI * 2 - Math.PI);
  await page.waitForTimeout(1100);
  const s = await page.evaluate(async () => {
    const out = [];
    await new Promise((res) => { const t = () => { out.push(window.__VIBE_E2E__.frameProfile()); out.length >= 40 ? res() : requestAnimationFrame(t); }; requestAnimationFrame(t); });
    const med = (k) => { const v = out.map(r => r[k] ?? 0).sort((a,b)=>a-b); return v[v.length>>1]; };
    return { gl: med('glRenderMs'), cpu: med('cpuFrameMs'), frame: med('frameTotalMs'), draws: med('drawCalls'), tris: med('triangles') };
  });
  rows.push(s);
}
const mean = (k) => rows.reduce((a,r)=>a+r[k],0)/rows.length;
console.log(`[${LABEL}] over 12 headings: gl ${mean('gl').toFixed(2)}ms  cpu ${mean('cpu').toFixed(2)}ms  frame ${mean('frame').toFixed(2)}ms`
  + `  draws ${mean('draws').toFixed(0)}  tris ${Math.round(mean('tris'))}`);
console.log(`   worst-heading gl ${Math.max(...rows.map(r=>r.gl)).toFixed(2)}ms  best ${Math.min(...rows.map(r=>r.gl)).toFixed(2)}ms`);
built.forEach(l => console.log('   ' + l));
await browser.close();
