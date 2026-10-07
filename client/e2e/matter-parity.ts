// Parity between our Matter port (/materials) and a reference build of the
// Matter lab: photograph every material on every form on both, at the same
// size, and score each pair.
//
//   npx tsx e2e/matter-parity.ts --ours http://localhost:3013/materials \
//       --ref http://127.0.0.1:3024/ [--out ../target/matter-parity] [--kinds oak,steel] [--shapes Sphere,Box]
//
// Each page exposes window.__MATTER_LAB__.snapshot(kind, shape, size) ->
// PNG data URL (ours: graphics/matter/lab.ts; the reference: a scratch Vite
// page over Matter's own lib/ on its own three, outside this repo).
//
// Scores per specimen: mean CIE76 ΔE over the frame, the fraction of pixels
// with ΔE > 5 (a visible difference), and the mean luminance of each side
// (which says darker or brighter, not just different). Writes the images and
// an index.html sheet (reference | ours | ΔE heat map) to --out.

import fs from 'fs';
import path from 'path';
import { chromium, type Page } from '@playwright/test';

import { decodePng, type DecodedPng } from './helpers/png';

const KINDS = ['oak', 'concrete', 'steel', 'marble', 'glass'];
const SHAPES = [
  'Sphere', 'Box', 'Rounded box', 'Cylinder', 'Cone', 'Capsule', 'Torus', 'Torus knot',
  'Dodecahedron', 'Icosahedron', 'Convex hull I', 'Convex hull II', 'Lathed vessel',
  'Extruded arch', 'Compound pedestal', 'Pipe assembly',
];
const SIZE = 400;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
}

const ours = arg('ours');
const ref = arg('ref');
const out = path.resolve(arg('out', '../target/matter-parity'));
const kinds = arg('kinds', KINDS.join(',')).split(',');
const shapes = arg('shapes', SHAPES.join(',')).split(',');

const slug = (kind: string, shape: string) => `${kind}-${shape.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

async function photograph(page: Page, url: string, dir: string) {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as { __MATTER_LAB__?: unknown }).__MATTER_LAB__, null, { timeout: 60_000 });
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of kinds) {
    for (const shape of shapes) {
      const dataUrl = await page.evaluate(
        ([k, s, size]) =>
          (window as unknown as { __MATTER_LAB__: { snapshot(k: string, s: string, n: number): Promise<string> } })
            .__MATTER_LAB__.snapshot(k as string, s as string, size as number),
        [kind, shape, SIZE] as const,
      );
      fs.writeFileSync(path.join(dir, `${slug(kind, shape)}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  }
}

// sRGB 8-bit -> CIE Lab (D65).
function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

interface Score {
  kind: string;
  shape: string;
  meanDeltaE: number;
  visible: number;
  lumRef: number;
  lumOurs: number;
}

function score(kind: string, shape: string, a: DecodedPng, b: DecodedPng, heat: Buffer): Score {
  const n = a.width * a.height;
  let sum = 0;
  let visible = 0;
  let la = 0;
  let lb = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const p = lab(a.data[o], a.data[o + 1], a.data[o + 2]);
    const q = lab(b.data[o], b.data[o + 1], b.data[o + 2]);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    sum += d;
    if (d > 5) visible++;
    la += p[0];
    lb += q[0];
    const v = Math.min(255, d * 12);
    heat[i * 3] = v;
    heat[i * 3 + 1] = v * 0.4;
    heat[i * 3 + 2] = 255 - v;
  }
  return { kind, shape, meanDeltaE: sum / n, visible: visible / n, lumRef: la / n, lumOurs: lb / n };
}

// The heat maps as 24-bit BMP: no encoder needed, and every browser shows it.
function bmp(width: number, height: number, rgb: Buffer): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = 54 + y * row + x * 3;
      buf[d] = rgb[s + 2];
      buf[d + 1] = rgb[s + 1];
      buf[d + 2] = rgb[s];
    }
  }
  return buf;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await photograph(page, ref, path.join(out, 'ref'));
  await photograph(page, ours, path.join(out, 'ours'));
} finally {
  await browser.close();
}

fs.mkdirSync(path.join(out, 'heat'), { recursive: true });
const scores: Score[] = [];
for (const kind of kinds) {
  for (const shape of shapes) {
    const file = `${slug(kind, shape)}.png`;
    const a = decodePng(fs.readFileSync(path.join(out, 'ref', file)));
    const b = decodePng(fs.readFileSync(path.join(out, 'ours', file)));
    const heat = Buffer.alloc(a.width * a.height * 3);
    scores.push(score(kind, shape, a, b, heat));
    fs.writeFileSync(path.join(out, 'heat', `${slug(kind, shape)}.bmp`), bmp(a.width, a.height, heat));
  }
}

const fmt = (s: Score) =>
  `${s.kind.padEnd(9)} ${s.shape.padEnd(18)} ΔE ${s.meanDeltaE.toFixed(2).padStart(6)}  visible ${(s.visible * 100).toFixed(1).padStart(5)}%  L* ref ${s.lumRef.toFixed(1)} ours ${s.lumOurs.toFixed(1)}`;
for (const s of scores) console.log(fmt(s));
console.log('\nper kind (mean ΔE, mean visible %):');
for (const kind of kinds) {
  const k = scores.filter((s) => s.kind === kind);
  const mean = k.reduce((a, s) => a + s.meanDeltaE, 0) / k.length;
  const vis = k.reduce((a, s) => a + s.visible, 0) / k.length;
  console.log(`  ${kind.padEnd(9)} ΔE ${mean.toFixed(2)}  visible ${(vis * 100).toFixed(1)}%`);
}
fs.writeFileSync(path.join(out, 'scores.json'), JSON.stringify(scores, null, 2));
fs.writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Matter parity</title>
<style>body{background:#141616;color:#ddd;font:12px ui-monospace,monospace}td{padding:4px;vertical-align:top}img{width:200px;height:200px}</style>
<table><tr><th>specimen</th><th>reference</th><th>ours</th><th>ΔE</th></tr>
${scores
  .map(
    (s) => `<tr><td>${s.kind}<br>${s.shape}<br>ΔE ${s.meanDeltaE.toFixed(2)}<br>visible ${(s.visible * 100).toFixed(1)}%<br>L* ${s.lumRef.toFixed(1)} / ${s.lumOurs.toFixed(1)}</td>
<td><img src="ref/${slug(s.kind, s.shape)}.png"></td><td><img src="ours/${slug(s.kind, s.shape)}.png"></td><td><img src="heat/${slug(s.kind, s.shape)}.bmp"></td></tr>`,
  )
  .join('\n')}</table>`,
);
console.log(`\nsheet: ${path.join(out, 'index.html')}`);
