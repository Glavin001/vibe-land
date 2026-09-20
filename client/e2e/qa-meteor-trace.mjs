/**
 * Browser forensics for one meteor flight: 20 Hz samples of what the layer
 * DREW against the arc and the streamed body, so a rock that visibly rewinds
 * or hangs can be read as numbers instead of described.
 *
 * Usage: node client/e2e/qa-meteor-trace.mjs --page https://127.0.0.1:1111 --wt-port 4433 --out /tmp/trace.json
 *   --impair lte   in-process link impairment (netlab profile), to see what a real link does to the handover
 */
import { writeFileSync } from 'node:fs';
import { openCity } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const impair = arg('impair', null);
const { browser, page } = await openCity({ page: arg('page', 'https://127.0.0.1:1111'), wtPort: arg('wt-port', '4433'), query: impair ? `netlab=1&impair=${impair}` : undefined });
await page.evaluate(() => window.__VIBE_E2E__.setShotMode('meteor'));
await page.waitForTimeout(Number(arg('settle', 9000)));
const lookat = arg('lookat', null);
if (lookat) {
  const [x, y, z] = lookat.split(',').map(Number);
  await page.evaluate(([a, b, c]) => window.__VIBE_DRIVE__.lookAt(a, b, c), [x, y, z]);
} else {
  await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
}
await page.waitForTimeout(500);
await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 40 }));
const t0 = Date.now();
const samples = [];
let bodyId = null;
while (Date.now() - t0 < 12000) {
  const list = await page.evaluate(() => window.__VIBE_E2E__.meteors());
  const f = bodyId == null ? list.find((m) => m.ageS < 3) : list.find((m) => m.bodyId === bodyId);
  if (f) {
    bodyId = f.bodyId;
    samples.push({ tMs: Date.now() - t0, ageS: f.ageS, flightTimeS: f.flightTimeS, drawn: f.drawn, raw: f.raw, rendered: f.rendered, interpDelayMs: f.interpDelayMs, target: f.target });
  } else if (bodyId != null) {
    samples.push({ tMs: Date.now() - t0, gone: true });
    break;
  }
  await page.waitForTimeout(50);
}
writeFileSync(arg('out', 'meteor-trace.json'), JSON.stringify(samples));
const d = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null;
let last = null;
for (const s of samples) {
  if (s.gone) { console.log(`${s.tMs}ms gone`); break; }
  if (!s.drawn) continue;
  const jump = last ? d(s.drawn.position, last.drawn.position) : 0;
  console.log(`${String(s.tMs).padStart(5)}ms age ${s.ageS.toFixed(2)}s ${s.drawn.source.padEnd(6)} drawn=[${s.drawn.position.map((v) => v.toFixed(0))}] arc=[${s.drawn.arc.map((v) => v.toFixed(0))}] ` +
    `raw=${s.raw ? '[' + s.raw.position.map((v) => v.toFixed(0)) + '] |v|=' + Math.hypot(...s.raw.velocity).toFixed(0) : '-'} ` +
    `drawn-arc=${(d(s.drawn.position, s.drawn.arc) ?? 0).toFixed(1)}m step=${jump.toFixed(1)}m interp=${s.interpDelayMs.toFixed(0)}ms`);
  last = s;
}
await browser.close();
