// The web /city from a parked camera, for comparison with Unreal's VibeCity.Render.Compare (same
// pose, same 1280x720 frame, the same 75° vertical field of view). Joins the match like a player,
// parks the capture camera (window.__VIBE_E2E__.setCapturePose), hides the HUD and saves a PNG.
//
//   node scripts/unreal/compare-web.mjs [--url http://localhost:3003/city?match=citypp-parent]
//     [--cam 0,14,140,0,6,0[,fov]] [--out target/unreal-tests/compare/compare-web.png] [--wait 20]
//
// Runs Chromium headed-off with the GPU (Metal through ANGLE), from client/'s Playwright.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(resolve(root, 'client/package.json'))('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const url = args.url ?? 'http://localhost:3003/city?match=citypp-parent';
const cam = (args.cam ?? '0,14,140,0,6,0').split(',').map(Number);
const out = resolve(root, args.out ?? 'target/unreal-tests/compare/compare-web.png');
const waitS = Number(args.wait ?? 20);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(url);
// "Click anywhere to join" (again until it takes: the first may land before the page listens).
let transport = '';
for (let i = 0; i < 60 && transport !== 'webtransport'; i++) {
  if (i % 5 === 0) await page.mouse.click(640, 360);
  await page.waitForTimeout(1000);
  transport = await page.evaluate(() => window.__VIBE_E2E__?.snapshot?.()?.transport ?? '');
}
if (transport !== 'webtransport') {
  console.error(`compare-web: not connected (${transport}): ${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(waitS * 1000);
await page.evaluate(([px, py, pz, tx, ty, tz, fov]) => {
  window.__VIBE_E2E__.setCapturePose({ position: [px, py, pz], lookAt: [tx, ty, tz], fov: fov || 75 });
  const style = document.createElement('style');
  style.textContent = 'body *:not(canvas){visibility:hidden !important} canvas{visibility:visible !important}';
  document.head.appendChild(style);
}, cam);
await page.waitForTimeout(3000);
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
const grass = await page.evaluate(() => document.body.innerText.match(/Shared grass[^\n]*/)?.[0] ?? '');
console.log(`compare-web: ${out}${grass ? ` (${grass})` : ''}`);
await browser.close();
