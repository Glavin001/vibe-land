// Screenshot an authored structure from a set of useful angles.
//
//   node tools/structure-shot.mjs algedra-tower
//   node tools/structure-shot.mjs house-1story --angles front,street --port 6007
//
// Writes docs/structures/<pack>/<angle>.png, which is what makes the
// generate-look-adjust loop possible: regenerate the pack, re-run this, read
// the images.
//
// The GPU flags are copied verbatim from e2e/helpers/gpuArgs.ts and are not
// optional. Without --use-angle=vulkan Chromium silently falls back to
// SwiftShader, which still renders -- just slowly and with different shading.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const GPU_ARGS = [
  '--enable-quic', '--no-sandbox', '--disable-gpu-sandbox', '--ignore-certificate-errors',
  '--allow-insecure-localhost', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
];

const args = process.argv.slice(2);
const pack = args.find((a) => !a.startsWith('--')) ?? 'algedra-tower';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = flag('port', '6006');
const outDir = flag('out', path.resolve('../docs/structures', pack));

/**
 * Camera poses, derived from the structure's own bounds so the same names frame
 * a 10 m house and a 34 m tower equally well.
 *
 * `standoff` is a multiple of the plan radius, `height` and `aim` fractions of
 * the building's top. Elevation is measured off the ground plane.
 */
const PRESETS = {
  //         standoff  height  aim    bearing (rad, 0 = +Z)
  front:    { standoff: 2.6, height: 0.55, aim: 0.45, bearing: 0 },
  corner:   { standoff: 2.4, height: 0.60, aim: 0.45, bearing: Math.PI * 0.25 },
  street:   { standoff: 1.5, height: 0.06, aim: 0.25, bearing: Math.PI * 0.12 },
  aerial:   { standoff: 2.2, height: 1.60, aim: 0.35, bearing: Math.PI * 0.25 },
  detail:   { standoff: 1.15, height: 0.30, aim: 0.30, bearing: Math.PI * 0.05 },
  back:     { standoff: 2.6, height: 0.55, aim: 0.45, bearing: Math.PI },
};
const angles = (flag('angles', Object.keys(PRESETS).join(','))).split(',');

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));

const url = `https://127.0.0.1:${port}/structure?pack=${encodeURIComponent(pack)}`;
console.log(`loading ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

await page.waitForFunction(() => window.__VIBE_STRUCTURE__ !== undefined, { timeout: 60000 });
const err = await page.evaluate(() => window.__VIBE_STRUCTURE__.error);
if (err) {
  console.error(`pack failed to load: ${err}`);
  await browser.close();
  process.exit(1);
}

// The texture fallback is a plausible concrete grey, so a sheet that has not
// arrived yet is INVISIBLE in the resulting screenshot rather than obvious.
await page.waitForFunction(() => window.__VIBE_CITY_TEX_READY__ === true, { timeout: 60000 });

const stats = await page.evaluate(() => window.__VIBE_STRUCTURE__.stats());
const b = await page.evaluate(() => window.__VIBE_STRUCTURE__.bounds());
console.log(`${stats.nodes} nodes, materials: ${stats.materials.join(', ')}`);
console.log(`bounds radius ${b.radiusM.toFixed(1)} m, top ${b.topM.toFixed(1)} m`);

await mkdir(outDir, { recursive: true });
for (const name of angles) {
  const p = PRESETS[name];
  if (!p) { console.error(`unknown angle "${name}"`); continue; }
  // Framed on the larger of plan radius and half the height. Sizing on plan
  // radius alone put the camera 48 m from a 127 m tower and the shot was a
  // close-up of the middle of it.
  const scale = Math.max(b.radiusM, b.topM * 0.55);
  const dist = scale * p.standoff + 8;
  const pose = {
    position: [
      b.centre[0] + Math.sin(p.bearing) * dist,
      Math.max(1.6, b.topM * p.height),
      b.centre[2] + Math.cos(p.bearing) * dist,
    ],
    target: [b.centre[0], b.topM * p.aim, b.centre[2]],
  };
  await page.evaluate((x) => window.__VIBE_STRUCTURE__.setCamera(x), pose);
  // Two frames: one to apply the pose, one to render it.
  await page.waitForTimeout(400);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${name.padEnd(7)} -> ${file}`);
}

if (problems.length) {
  console.log('\nproblems:');
  for (const p of [...new Set(problems)].slice(0, 10)) console.log(`  ${p}`);
}
await browser.close();
