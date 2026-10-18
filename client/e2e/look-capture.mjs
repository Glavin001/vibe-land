// The web side of the look comparison: open /city in headless Chromium, park
// the camera at each e2e/helpers/lookPoses.mjs pose and save the canvas to
// target/look/<label>/<pose>.png. The native side is
// scripts/native-mac.sh look (client/native/look-capture.mjs); look-sheet.mjs
// lays every renderer's captures side by side.
//
//   node e2e/look-capture.mjs --url http://localhost:3003 --label webgl
//   node e2e/look-capture.mjs --url http://localhost:3013 --label webgpu
//
// Needs a city server on the client's proxy target (e.g. the fleet server).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookPoses } from './helpers/lookPoses.mjs';
import { joinDropPose } from './helpers/vehicleQaCore.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:3003');
const label = arg('label', 'webgl');
const out = resolve(import.meta.dirname, '../../target/look', label);
mkdirSync(out, { recursive: true });

// The same window size the native app captures at (native-mac.sh launch).
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

await page.goto(`${url}/city`);
// Click to join, until it takes (the WebGPU renderer initialises later).
for (let i = 0; i < 60; i += 1) {
  await page.mouse.click(800, 450);
  if (await page.evaluate(() => window.__VIBE_E2E__?.snapshot()?.connected === true)) break;
  await page.waitForTimeout(1000);
}
await page.waitForFunction(() => {
  const e2e = window.__VIBE_E2E__;
  return (e2e?.snapshot()?.city?.chunksTotal ?? 0) > 0
    && (e2e.cityStructures?.().length ?? 0) > 0
    && window.__VIBE_CITY_TEX_READY__ === true;
}, null, { timeout: 120_000 });
// DOM overlays off, canvas untouched (e2e/helpers/city.ts hideDomOverlays).
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const ancestors = new Set();
  for (let node = canvas; node; node = node.parentNode) ancestors.add(node);
  document.querySelectorAll('body *').forEach((element) => {
    if (!ancestors.has(element) && !canvas.contains(element)) element.style.visibility = 'hidden';
  });
});
await page.waitForTimeout(2000);

const structures = await page.evaluate(() => window.__VIBE_E2E__.cityStructures());
for (const pose of lookPoses(structures)) {
  if (pose.dropPlayerAt) {
    await page.evaluate((drop) => window.__VIBE_E2E__.dropAt(drop), joinDropPose(pose.dropPlayerAt));
    await page.waitForTimeout(4000);
  }
  await page.evaluate((p) => window.__VIBE_E2E__.setCapturePose({ position: p.position, lookAt: p.lookAt }), pose);
  await page.waitForTimeout(1500);
  const file = `${out}/${pose.name}.png`;
  await page.locator('canvas').first().screenshot({ path: file });
  console.log(`[look] ${label} ${pose.name}: ${file}`);
}
if (errors.length) console.log(`[look] ${label} page errors:\n  ${errors.slice(0, 10).join('\n  ')}`);
await browser.close();
