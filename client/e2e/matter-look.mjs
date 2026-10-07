// The web side of the Matter material captures: open /city in headless
// Chromium (WebGPU), park the camera at each e2e/helpers/matterPoses.mjs pose
// and save the canvas to target/look/<label>-matter/<pose>.png. The native
// side is scripts/native-mac.sh matter-look.
//
//   node e2e/matter-look.mjs --url http://localhost:3013 --label webgpu [--query matter=0]
//
// Needs a city server on the client's proxy target.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { matterPoses } from './helpers/matterPoses.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:3013');
const label = arg('label', 'webgpu');
const query = arg('query', '');
const out = resolve(import.meta.dirname, '../../target/look', `${label}-matter`);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || /matter|WGSL|shader/i.test(m.text())) console.log(`[page:${m.type()}] ${m.text().slice(0, 400)}`);
});
await page.goto(`${url}/city${query ? `?${query}` : ''}`);
// Click to join, until it takes (the WebGPU renderer initialises later).
for (let i = 0; i < 60; i += 1) {
  await page.mouse.click(800, 450);
  if (await page.evaluate(() => window.__VIBE_E2E__?.snapshot()?.connected === true)) break;
  await page.waitForTimeout(1000);
}
await page.waitForFunction(() => {
  const e2e = window.__VIBE_E2E__;
  return e2e && (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && (e2e.cityMaterials?.().length ?? 0) > 0;
}, null, { timeout: 180_000 });
// DOM overlays off, canvas untouched (as e2e/look-capture.mjs).
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const ancestors = new Set();
  for (let node = canvas; node; node = node.parentNode) ancestors.add(node);
  document.querySelectorAll('body *').forEach((element) => {
    if (!ancestors.has(element) && !canvas.contains(element)) element.style.visibility = 'hidden';
  });
});
await page.waitForTimeout(3000);
const materials = await page.evaluate(() => window.__VIBE_E2E__.cityMaterials());
for (const m of materials) console.log(`material ${m.index} ${m.name}: ${m.worn ? m.look : `triplanar${m.look ? ` (maps to ${m.look})` : ''}`} (${m.chunks} chunks)`);
for (const pose of matterPoses(materials)) {
  await page.evaluate((p) => window.__VIBE_E2E__.setCapturePose({ position: p.position, lookAt: p.lookAt }), pose);
  await page.waitForTimeout(1200);
  const file = resolve(out, `${pose.name}.png`);
  await page.locator('canvas').first().screenshot({ path: file });
  console.log(`${pose.name}: ${file}`);
}
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
