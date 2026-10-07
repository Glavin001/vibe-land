// Stills of the Fracture Lab, for the look-adjust-look loop and for review.
//
//   npm run dev:webgpu   (or the client-webgpu launch config, port 3013)
//   node tools/fracture-shot.mjs
//   node tools/fracture-shot.mjs --specimens rc-wall,brick-wall --views split,closeup
//   node tools/fracture-shot.mjs --specimens pack:house-1story --views split
//
// Writes docs/fracture/<specimen>--<view>.png plus docs/fracture/sheet.png, a
// contact sheet of everything taken. Headless Chromium on Metal with WebGPU
// enabled (the flags e2e/look-capture.mjs uses on the Mac).

import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const origin = flag('origin', 'http://localhost:3013');
const outDir = path.resolve(flag('out', '../docs/fracture'));
const specimens = flag('specimens', 'rc-wall,concrete-wall,rc-column,brick-wall,timber-stud,drywall,glass-pane').split(',');
const views = flag('views', 'split,closeup,book,blast').split(',');
const width = Number(flag('width', '1600'));
const height = Number(flag('height', '1000'));

/**
 * Each view is lab state plus a camera rule. Cameras are derived from the
 * specimen (frame) or from a piece's drawn position (closeup), so one view
 * name works for a 4 m wall and a 9 cm stud.
 */
const VIEWS = {
  split: { state: { compare: 'split', mode: 'radial', amount: 0.35, spin: 0.35, bodies: 'visual' }, camera: 'frame' },
  colliders: { state: { compare: 'split', mode: 'radial', amount: 0.35, spin: 0.35, bodies: 'both' }, camera: 'frame' },
  kinds: { state: { compare: 'enhanced', mode: 'radial', amount: 0.45, spin: 0.5, debugKinds: true }, camera: 'frame' },
  closeup: { state: { compare: 'enhanced', mode: 'radial', amount: 0.75, spin: 0.25 }, camera: { piece: 'middle', offset: [-0.5, 0.18, 0.45] } },
  'closeup-today': { state: { compare: 'today', mode: 'radial', amount: 0.75, spin: 0.25 }, camera: { piece: 'middle', offset: [-0.5, 0.18, 0.45] } },
  book: { state: { compare: 'enhanced', mode: 'book', amount: 1, spin: 0 }, camera: 'split' },
  crack: { state: { compare: 'split', mode: 'crack', amount: 0.08, spin: 0 }, camera: 'frame' },
  blast: { state: { compare: 'split', mode: 'blast', blastStrength: 6, timeScale: 1 }, camera: 'frame', settle: 700 },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width, height } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => problems.push(String(e.stack ?? e).slice(0, 800)));

await mkdir(outDir, { recursive: true });
const taken = [];
const report = [];

for (const specimen of specimens) {
  const query = specimen.startsWith('pack:') ? `pack=${specimen.slice(5)}` : `specimen=${specimen}`;
  await page.goto(`${origin}/fracture-lab?${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__VIBE_FRACTURE_LAB__?.ready === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__VIBE_CITY_TEX_READY__ === true, null, { timeout: 60000 }).catch(() => {});
  // Hide the panel: stills are of the scene. The canvas re-measures on resize.
  await page.evaluate(() => document.querySelector('button[type=button]')?.click());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  for (const viewName of views) {
    const view = VIEWS[viewName];
    if (!view) throw new Error(`unknown view ${viewName}`);
    await page.evaluate((state) => window.__VIBE_FRACTURE_LAB__.set({ debugKinds: false, ...state, blastToken: Date.now() }), view.state);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    if (view.camera === 'frame') {
      await page.evaluate(() => window.__VIBE_FRACTURE_LAB__.frame());
    } else if (view.camera === 'split') {
      // Look along the opened split from in front, a little to the + side.
      await page.evaluate(() => {
        const lab = window.__VIBE_FRACTURE_LAB__;
        const { impact, splitNormal, min, max } = lab.info();
        const size = [0, 1, 2].map((k) => max[k] - min[k]);
        const thin = size.indexOf(Math.min(...size));
        const view = [0, 0, 0];
        view[thin === 1 ? 1 : thin] = 1;
        // Scale by the specimen across the split (a wall's width, a stud's depth).
        const across = size.filter((_, k) => Math.abs(splitNormal[k]) < 0.5);
        const reach = Math.max(0.3, Math.min(2.2, Math.max(...across) * 0.45));
        const target = [impact[0], impact[1], impact[2]];
        target[thin] = (min[thin] + max[thin]) / 2;
        const camera = target.map((t, k) => t + view[k] * reach + splitNormal[k] * reach * 0.35 + (k === 1 ? reach * 0.15 : 0));
        lab.camera(camera, target);
      });
    } else {
      await page.evaluate(({ offset }) => {
        const lab = window.__VIBE_FRACTURE_LAB__;
        const pieces = lab.stats()?.pieces ?? 1;
        const i = Math.floor(pieces / 2);
        const c = lab.pieceCenter(i);
        // Stand off a couple of piece radii, in the view's direction.
        const len = Math.hypot(...offset);
        const reach = Math.max(0.12, lab.pieceRadius(i) * 2.4);
        if (c) lab.camera(c.map((x, k) => x + (offset[k] / len) * reach), c);
      }, view.camera);
    }
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), view.settle ?? 500);
    const file = path.join(outDir, `${specimen.replace(':', '-')}--${viewName}.png`);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__VIBE_FRACTURE_LAB__.stats());
    report.push({ specimen, view: viewName, stats });
    taken.push({ file, label: `${specimen} · ${viewName}` });
    console.log(`${path.relative(process.cwd(), file)}  ${stats ? `${stats.frameMs.toFixed(1)} ms frame, GPU ${stats.gpuMs?.toFixed?.(2) ?? 'n/a'} ms, ${stats.triangles} tris` : ''}`);
  }
}

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

// Contact sheet.
const cols = Math.min(views.length, 4);
const tile = 480;
const html = `<html><body style="margin:0;background:#111;color:#ddd;font:13px system-ui">
<div style="display:grid;grid-template-columns:repeat(${cols},${tile}px);gap:6px;padding:6px">
${taken.map((t) => `<figure style="margin:0"><img src="file://${t.file}" style="width:${tile}px;display:block"/><figcaption>${t.label}</figcaption></figure>`).join('\n')}
</div></body></html>`;
const sheetHtml = path.join(outDir, 'sheet.html');
await writeFile(sheetHtml, html);
const sheet = await browser.newPage({ viewport: { width: cols * (tile + 6) + 6, height: 400 } });
await sheet.goto(`file://${sheetHtml}`);
await sheet.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true });

await browser.close();
if (problems.length > 0) {
  console.error(`\n${problems.length} console problem(s):\n${problems.slice(0, 10).join('\n')}`);
  process.exitCode = 1;
}
