/**
 * One tall building, knocked over, recorded end to end.
 *
 *   node client/e2e/qa-tower-collapse.mjs --page https://127.0.0.1:1112 \
 *        --wt-port 4434 --api http://127.0.0.1:4018 --out /tmp/tower
 *
 * Earlier recordings were made on the downtown scene, where the tower being
 * felled is behind three other buildings and most of the collapse happens out
 * of shot. A single unobstructed tower is the whole point: what is wrong has
 * to be visible before it can be argued about.
 *
 * Leaves, for the same run:
 *   collapse.webm   what a player saw
 *   poses.json      where chosen chunks were DRAWN, every frame, with the tick
 *   frames.csv      the same as a flat table, one row per chunk per frame
 *   report.json     the full client audit, as SEND REPORT would post it
 *
 * The pose trace is the part a video cannot give: a chunk that jumps is one
 * row that moves metres between consecutive frames, and it can be found by
 * sorting rather than by watching.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4018');
const MATCH = arg('match', 'city-default');
const OUT = arg('out', '/tmp/tower');
const TRACKED = Number(arg('tracked', 400));
const SECONDS = Number(arg('seconds', 25));
mkdirSync(OUT, { recursive: true });

// A fresh tower every run. Without this a second capture starts on the rubble
// of the first -- the run that caught it opened with 3,249 bonds already
// broken and then reported "28 bonds broken" as though nothing had happened.
// Off by default: POST /city-reset does rebuild the tower, and then the
// server process dies seconds later -- observed here, with the reset itself
// logging success ("city reset; re-bootstrapped clients") immediately before
// the process vanished. A fresh process is the reliable reset, which is what
// scripts/netlab/tower-capture.sh does around this script.
if (arg('reset', '0') !== '0') {
  try {
    await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' });
    console.log('reset the city; waiting for it to rebuild');
  } catch { console.log('reset failed; the tower may already be damaged'); }
  await new Promise((resolve) => setTimeout(resolve, 8000));
}

const { browser, context, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1112'),
  wtPort: arg('wt-port', '4434'),
  recordVideo: OUT,
  viewport: { width: 1280, height: 800 },
});
await page.waitForTimeout(7000);

// Overlays cover a third of the frame and are useless when reading pixels
// back. Hidden for the recording only; nothing in the render path changes.
await page.addStyleTag({
  content: `[data-testid="city-stats-overlay"], [data-testid="debug-overlay"],
            [data-testid="city-stats-show"], [data-testid="damage-overlay"]
            { display: none !important; }`,
});
await page.evaluate(() => {
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (el.tagName === 'CANVAS') continue;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 120) el.style.display = 'none';
    }
  }
});

const before = await city(page);
console.log(`chunks ${before.chunksTotal}  bonds broken at start ${before.brokenBonds}`);
if (before.brokenBonds > before.chunksTotal / 20) {
  console.log('WARNING: the tower is already damaged; this capture is not a clean collapse');
}

// Stand well back and look at the tower, so the whole of it stays in frame
// for the entire collapse. The spawn ring puts the camera at its foot.
await page.evaluate(() => window.__VIBE_DRIVE__.move({ forward: -1, durationMs: 5000 }));
await page.waitForTimeout(5200);
const LOOK = [Number(arg('look-x', 0)), Number(arg('look-y', 12)), Number(arg('look-z', 0))];
await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), LOOK);
await page.waitForTimeout(1200);

// Track chunks spread evenly across the whole structure, so the sample covers
// the part that falls and the part that does not.
const armed = await page.evaluate((tracked) => {
  const total = window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0;
  const step = Math.max(1, Math.floor(total / tracked));
  const slots = [];
  for (let slot = 0; slot < total && slots.length < tracked; slot += step) slots.push(slot);
  return window.__VIBE_POSE_TRACE__.arm(slots, 60 * 120);
}, TRACKED);
console.log(`tracing ${armed.slots} chunks for up to ${armed.frames} frames`);

const demolish = (body) => fetch(`${API}/city-demolish/${MATCH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).catch(() => {});

// The recipe: take the footing out in a wedge, progressively and with gaps,
// so it goes over sideways as hundreds of fractures rather than splitting in
// two. per_tick is low on purpose -- a clean instant cut is a different event.
await demolish({
  tallest: true,
  radius_m: Number(arg('radius-m', 12)),
  below_y: Number(arg('below-y', 5)),
  rounds: Number(arg('rounds', 400)),
  wedge_deg: Number(arg('wedge-deg', 60)),
  heading_deg: Number(arg('heading-deg', 0)),
  jitter: Number(arg('jitter', 0.3)),
  per_tick: Number(arg('per-tick', 2)),
});

const started = Date.now();
while (Date.now() - started < SECONDS * 1000) {
  await page.waitForTimeout(2000);
  const c = await city(page);
  console.log(`t+${((Date.now() - started) / 1000).toFixed(0)}s  bonds ${c.brokenBonds}`
    + `  awake ${c.chunksAwake}  islands ${c.liveIslands}`);
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), LOOK);
}

const trace = await page.evaluate(() => window.__VIBE_POSE_TRACE__.drain());
const after = await city(page);
console.log(`\nfinal: bonds ${after.brokenBonds} awake ${after.chunksAwake}`
  + ` islands ${after.liveIslands}`);
console.log(`frames traced ${trace.frames} (dropped ${trace.overflow})`);
console.log('presentation:', `implausible ${after.implausibleJumps}`
  + ` snaps ${after.correctionSnaps} worst ${(after.presentationAnomalyMaxM ?? 0).toFixed(1)} m`
  + ` teleports ${after.drawnTeleports} worst ${(after.drawnTeleportWorstM ?? 0).toFixed(1)} m`
  + ` starved ${after.starvedReadmissions} repairs ${after.structureRepairs}`);

// The biggest single-frame movement of any tracked chunk, which is the thing
// the video shows and the number that can be sorted.
let worst = { metres: 0 };
const slotCount = trace.slots.length;
for (let frame = 1; frame < trace.frames; frame += 1) {
  for (let index = 0; index < slotCount; index += 1) {
    const now = (frame * slotCount + index) * 3;
    const prev = ((frame - 1) * slotCount + index) * 3;
    const dx = trace.positions[now] - trace.positions[prev];
    const dy = trace.positions[now + 1] - trace.positions[prev + 1];
    const dz = trace.positions[now + 2] - trace.positions[prev + 2];
    const metres = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (Number.isFinite(metres) && metres > worst.metres) {
      worst = {
        metres, frame, slot: trace.slots[index],
        tick: trace.ticks[frame], atMs: trace.times[frame],
        from: [trace.positions[prev], trace.positions[prev + 1], trace.positions[prev + 2]],
        to: [trace.positions[now], trace.positions[now + 1], trace.positions[now + 2]],
      };
    }
  }
}
if (worst.metres > 0) {
  console.log(`worst single-frame move: ${worst.metres.toFixed(2)} m`
    + ` slot ${worst.slot} frame ${worst.frame} tick ${worst.tick}`
    + ` at ${(worst.atMs / 1000).toFixed(2)}s into the page`);
}

writeFileSync(`${OUT}/poses.json`, JSON.stringify({ ...trace, worst }));
const rows = ['frame,tick,timeMs,slot,x,y,z'];
for (let frame = 0; frame < trace.frames; frame += 1) {
  for (let index = 0; index < slotCount; index += 1) {
    const at = (frame * slotCount + index) * 3;
    rows.push(`${frame},${trace.ticks[frame]},${trace.times[frame].toFixed(1)},`
      + `${trace.slots[index]},${trace.positions[at]},${trace.positions[at + 1]},`
      + `${trace.positions[at + 2]}`);
  }
}
writeFileSync(`${OUT}/frames.csv`, rows.join('\n'));
const report = await page.evaluate(() => ({
  snapshot: window.__VIBE_E2E__?.snapshot?.() ?? null,
  frameProfile: window.__VIBE_E2E__?.frameProfile?.() ?? null,
}));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const path = await video.path();
  try { renameSync(path, `${OUT}/collapse.webm`); } catch { /* left where it is */ }
}
console.log(`\nout: ${OUT}/collapse.webm ${OUT}/frames.csv ${OUT}/poses.json ${OUT}/report.json`);
