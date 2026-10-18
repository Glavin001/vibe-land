// Photograph the authored structures as they appear in the LIVE /city, from
// vantages framed on the city's own bounds.
//
//   node tools/city-structures-shot.mjs [outDir]
//
// tools/city-shot.mjs points the player camera down a fixed heading, which was
// right when the city was a uniform grid and is useless here: three structures
// sit at known but different places, and the interesting one is 40 m off that
// heading. This parks the capture camera instead, which moves the view without
// moving the player -- so streaming, AOI and hitscan carry on from where the
// player actually is.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const GPU_ARGS = [
  '--enable-quic', '--no-sandbox', '--disable-gpu-sandbox', '--ignore-certificate-errors',
  '--allow-insecure-localhost', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
];
const OUT = process.argv[2] ?? 'tools/profiles/city-structures';

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { const t = m.text(); if (/\[city\]/.test(t)) logs.push(t.slice(0, 200)); });

// The server advertises its PUBLIC WebTransport URL, and hairpin NAT to the
// box's own public IP does not work from inside the container — the page loads
// and then simply never connects. Rewrite it to the loopback listener, exactly
// as tools/city-shot.mjs does.
await page.route('**/session-config*', async (route) => {
  const r = await route.fetch();
  const b = JSON.parse(await r.text());
  b.url = 'https://127.0.0.1:4434/game';
  await route.fulfill({
    response: r,
    body: JSON.stringify(b),
    headers: { ...r.headers(), 'content-type': 'application/json' },
  });
});

await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 30000 });
await page.mouse.click(640, 360);
await page.waitForFunction(
  () => { const c = window.__VIBE_E2E__?.snapshot()?.city; return !!c && c.chunksTotal > 0 && c.rendered; },
  { timeout: 90000 },
);
await page.waitForFunction(() => window.__VIBE_CITY_TEX_READY__ === true, { timeout: 60000 });

// Hide every DOM overlay so the frame is the scene, not the stats panel.
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return;
  const ancestors = new Set();
  for (let n = canvas; n; n = n.parentNode) ancestors.add(n);
  document.querySelectorAll('body *').forEach((el) => {
    if (ancestors.has(el) || canvas.contains(el)) return;
    el.style.visibility = 'hidden';
  });
});

const snap = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city);
console.log(`chunks ${snap.chunksTotal} settled ${snap.chunksSettled} awake ${snap.chunksAwake}`);

// The neighbourhood pack's own layout: the tower at the origin, a house either
// side. Hardcoded rather than derived, because the manifest describes one
// structure and cannot say where inside it a building sits.
const SHOTS = [
  { name: 'overview', from: [95, 46, 95], at: [0, 12, 8] },
  { name: 'tower-corner', from: [52, 24, 52], at: [0, 14, 0] },
  { name: 'tower-street', from: [8, 3, 46], at: [0, 12, 0] },
  { name: 'tower-glass', from: [18, 10, 30], at: [0, 12, 12] },
  { name: 'house-1story', from: [-42, 8, 45], at: [-42, 3, 26] },
  { name: 'house-2story', from: [42, 9, 46], at: [42, 4, 26] },
];

await mkdir(OUT, { recursive: true });
for (const shot of SHOTS) {
  await page.evaluate(
    (s) => window.__VIBE_E2E__.setCapturePose({ position: s.from, lookAt: s.at }),
    shot,
  );
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${shot.name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${shot.name.padEnd(13)} -> ${file}`);
}
await page.evaluate(() => window.__VIBE_E2E__.setCapturePose(null));

const p = await page.evaluate(() => window.__VIBE_E2E__.frameProfile());
console.log(`draws ${p.drawCalls}  tris ${p.triangles}  gl ${p.glRenderMs.toFixed(2)}ms  frame ${p.frameTotalMs.toFixed(1)}ms`);
logs.slice(-4).forEach((l) => console.log(l));
await browser.close();
