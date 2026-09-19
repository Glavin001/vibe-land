/**
 * Knock a tall building over and watch it, on video, with the audit running.
 *
 * The recipe is the one that reproduces the artefact in play: take out the
 * bottom layers of a ten-storey-plus tower in a wedge so it goes over
 * sideways, and cut progressively with randomness rather than cleanly, because
 * a clean cut leaves two rigid pieces and the artefact lives in the hundreds
 * of fractures a real collapse produces.
 *
 *   node client/e2e/qa-topple.mjs --out /tmp/topple
 *
 * Leaves a webm, a JSON report written the same way SEND REPORT writes one,
 * and the per-frame audit printed.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const OUT = arg('out', 'topple');
mkdirSync(OUT, { recursive: true });

try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
await new Promise((r) => setTimeout(r, 5000));

const { browser, context, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  query: arg('query', ''),
  quiet: true,
  recordVideo: OUT,
  viewport: { width: 1280, height: 800 },
});
await page.waitForTimeout(7000);
// The debug panel and the controls card cover a third of the viewport, which
// is fine for a player and useless for reading frames back. Hidden for the
// recording only; nothing about the render path changes.
await page.addStyleTag({
  content: `
    [data-testid="city-stats-overlay"], [data-testid="debug-overlay"],
    [data-testid="city-stats-show"], [data-testid="damage-overlay"] {
      display: none !important;
    }
  `,
});
// Belt and braces: anything fixed-position and opaque that is not the canvas.
await page.evaluate(() => {
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const node = el;
    if (node.tagName === 'CANVAS') continue;
    const style = getComputedStyle(node);
    if (style.position === 'fixed' || style.position === 'absolute') {
      const r = node.getBoundingClientRect();
      if (r.width > 200 && r.height > 120) node.style.display = 'none';
    }
  }
});
await page.waitForTimeout(500);

// Stand back and look at the tower, so the whole thing is in frame for the
// entire collapse -- the report being chased is from someone watching it.
const TOWER = [Number(arg('x', 20)), Number(arg('y', 40)), Number(arg('z', -44))];
await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), TOWER);
await page.waitForTimeout(1500);

const demolish = (b) => fetch(`${API}/city-demolish/${MATCH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}).catch(() => {});

// Walk back so the whole tower fits in frame: the spawn ring puts the camera
// among the buildings, where a collapse is mostly occluded by whatever is in
// front of it.
await page.evaluate(() => window.__VIBE_DRIVE__.move({ forward: -1, durationMs: 4000 }));
await page.waitForTimeout(4500);
await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), TOWER);
await page.waitForTimeout(800);

for (let wave = 0; wave < 5; ++wave) {
  await demolish({
    tallest: true, radius_m: 22, below_y: 20 + wave * 8, rounds: 4000,
    wedge_deg: 100, heading_deg: 45, jitter: 0.35, per_tick: 14,
  });
  await page.waitForTimeout(4000);
  const c = await city(page);
  console.log(`wave ${wave}: bonds ${c.brokenBonds} awake ${c.chunksAwake} islands ${c.liveIslands}`);
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), TOWER);
}
await page.waitForTimeout(10000);

const c = await city(page);
console.log(`\nfinal: bonds ${c.brokenBonds} awake ${c.chunksAwake} islands ${c.liveIslands}`);
console.log('visual audit:', JSON.stringify(c.visualAudit));
console.log('visibility  :', JSON.stringify(c.visibilityFlips),
  `hidden ${c.chunksHidden} unhidden ${c.chunksUnhidden}`);
console.log('teleports   :', c.drawnTeleports, JSON.stringify(c.drawnTeleportBy));
console.log('presentation:', `implausible ${c.implausibleJumps} snaps ${c.correctionSnaps}`
  + ` rollbacks ${c.clockRollbacks} refusedReanchors ${c.renderClockReanchorsRefused}`
  + ` starvedReadmissions ${c.starvedReadmissions}`
  + ` repairsGlided ${c.repairBodiesGlided} repairs ${c.structureRepairs}`
  + ` bootstrapSeen ${c.bootstrapPosesSeen} gone ${c.bootstrapPosesGone}`
  + ` glided ${c.bootstrapPosesGlided} snapped ${c.bootstrapPosesSnapped}`
  + ` bootstraps ${c.bootstraps}`);

// The same payload SEND REPORT posts, kept locally so the rings can be read
// without going through the server's folder.
const report = await page.evaluate(() => {
  const w = window;
  return {
    snapshot: w.__VIBE_E2E__?.snapshot?.() ?? null,
    frameProfile: w.__VIBE_E2E__?.frameProfile?.() ?? null,
  };
});
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log(`report: ${OUT}/report.json`);

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const path = await video.path();
  try { renameSync(path, `${OUT}/topple.webm`); console.log(`video: ${OUT}/topple.webm`); }
  catch { console.log(`video: ${path}`); }
}
