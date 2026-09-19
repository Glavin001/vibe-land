/**
 * Bring one building down the same way every time, and watch what happens.
 *
 * Driving a collapse by shooting from the browser is neither repeatable nor
 * quick: the spawn ring moves between runs, so the same sixty rounds aimed the
 * same way break anywhere between 900 and 7,700 bonds, and comparing two
 * builds across that spread measures the spread. This asks the server to take
 * a building's footing out instead (POST /city-demolish), which hits the same
 * chunks every time.
 *
 *   node client/e2e/qa-demolish.mjs --video /tmp/collapse
 *   node client/e2e/qa-demolish.mjs --query "ballisticPlausibility=0"
 */
import { mkdirSync, renameSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const VIDEO = arg('video', null);
if (VIDEO) mkdirSync(VIDEO, { recursive: true });

const demolish = (body) => fetch(`${API}/city-demolish/${MATCH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).catch(() => {});

try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
await new Promise((r) => setTimeout(r, 5000));

const { browser, context, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  query: arg('query', ''),
  quiet: true,
  ...(VIDEO ? { recordVideo: VIDEO, viewport: { width: 960, height: 600 } } : {}),
});
await page.waitForTimeout(7000);
await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
await page.waitForTimeout(600);

// Three passes up the footing: the lowest supports first, then higher, which
// is what actually drops a building rather than hollowing it.
// Scale is the whole point: the reports that matter came from sessions with
// 8,500 awake chunks and 27,000 broken bonds, and a single building's footing
// reaches about a tenth of that. So this walks the footing across a block.
const X = Number(arg('x', -36));
const Z = Number(arg('z', -36));
const SPREAD = Number(arg('spread', 40));
const PASSES = Number(arg('passes', 4));
for (let pass = 0; pass < PASSES; ++pass) {
  const t = PASSES === 1 ? 0 : (pass / (PASSES - 1)) * 2 - 1;
  for (const [radius_m, below_y] of [[20, 10], [20, 16], [24, 22]]) {
    await demolish({ x: X + t * SPREAD, z: Z + t * SPREAD, radius_m, below_y, rounds: 400 });
    await page.waitForTimeout(1800);
  }
  const mid = await city(page);
  console.log(`  pass ${pass}: bonds ${mid.brokenBonds} awake ${mid.chunksAwake}`
    + ` islands ${mid.liveIslands}`);
}
await page.waitForTimeout(8000);

const c = await city(page);
const per = (n) => (c.brokenBonds ? (n / c.brokenBonds).toFixed(3) : '?');
console.log(`bonds ${c.brokenBonds}  awake chunks ${c.chunksAwake}  islands ${c.liveIslands}`);
console.log(`implausible ${c.implausibleJumps}  snaps ${c.correctionSnaps}`
  + `  rollbacks ${c.clockRollbacks}  outsideWorld ${c.recordsOutsideWorld}`);
console.log(`drawn steps >1m ${c.presentedJumpsOver1m} (${per(c.presentedJumpsOver1m)}/bond)`
  + `  >4m ${c.presentedJumpsOver4m}  worst ${(c.presentedJumpMaxM ?? 0).toFixed(1)} m`);
console.log(`DRAWN chunk teleports ${c.drawnTeleports} (${per(c.drawnTeleports)}/bond)`
  + `  worst ${(c.drawnTeleportWorstM ?? 0).toFixed(1)} m`
  + `  total ${Math.round(c.drawnTeleportMetres ?? 0)} m`);
console.log(`adoption jumps ${c.adoptionJumps} (${per(c.adoptionJumps)}/bond)`
  + `  worst ${(c.adoptionJumpMaxM ?? 0).toFixed(1)} m`
  + `  total ${Math.round(c.adoptionJumpMetres ?? 0)} m of chunks displaced by re-parenting`);
console.log(`  of which from MIGRATION ${c.adoptionJumpsFromMigration}`
  + ` (${Math.round(c.adoptionJumpMetresFromMigration ?? 0)} m), the rest from promotion`);
console.log(`chunks carried by those steps ${c.presentedJumpChunks}`
  + `  worst single island ${c.presentedJumpWorstChunks} chunks moving`
  + ` ${(c.presentedJumpWorstChunksM ?? 0).toFixed(1)} m`);

const video = page.video();
await context.close();
await browser.close();
if (video) {
  const path = await video.path();
  try { renameSync(path, `${VIDEO}/collapse.webm`); console.log(`video: ${VIDEO}/collapse.webm`); }
  catch { console.log(`video: ${path}`); }
}
