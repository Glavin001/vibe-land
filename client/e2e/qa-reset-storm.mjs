/**
 * Collapse a building, reset, repeat, until the destruction stage gives up.
 *
 * The stage has twice come up from a reset stuck at frame 0 with error bit 4
 * and never produced another frame: a city that cannot be broken and cannot be
 * reset, while every other reading says the server is healthy at 60 Hz. Five
 * headless reproductions failed to trigger it -- mid-collapse resets at
 * production scale with cannonballs in the scene, player churn, thirty cycles
 * -- and all of them were small. The occurrences that did happen followed a
 * REAL collapse: 17,014 broken bonds with 2,414 bodies still in the air.
 *
 * So this drives the browser, which is the only thing that produces a collapse
 * that size, and resets on top of it, and says exactly which cycle broke and
 * what the server looked like when it did.
 *
 *   node client/e2e/qa-reset-storm.mjs --cycles 10 --shots 45
 */
import { openCity, city, player } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const CYCLES = Number(arg('cycles', 10));
const SHOTS = Number(arg('shots', 45));

const stats = async () => {
  try {
    const r = await fetch(`${API}/match-stats/${MATCH}`);
    const d = r.ok ? await r.json() : {};
    return {
      bonds: d.city?.broken_bonds ?? 0,
      bodies: d.city?.chunk_bodies ?? 0,
      awake: d.city?.awake_bodies ?? 0,
      errors: d.spans?.['destruction/native_error_frames']?.v ?? 0,
      bits: d.spans?.['destruction/native_error_bits_last']?.v ?? 0,
      frame: d.spans?.['destruction/native_frame']?.v ?? 0,
    };
  } catch { return null; }
};

const { browser, page } = await openCity({ page: arg('page', 'https://127.0.0.1:1111') });
await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
await page.waitForTimeout(6000);

let broke = null;
for (let cycle = 0; cycle < CYCLES && broke === null; ++cycle) {
  await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
  await page.waitForTimeout(300);
  const p = await player(page);
  const range = Math.hypot(p.position[0], p.position[2]);
  const lift = Math.atan2(0.5 * 9.81 * (range / 60) ** 2, range);

  let peak = 0;
  for (let shot = 0; shot < SHOTS; ++shot) {
    await page.evaluate(([y, q]) => window.__VIBE_DRIVE__.look(y, q),
      [p.yaw + (shot % 5 - 2) * 0.008, -0.01 + 0.006 * (shot % 3) + lift]);
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 140 }));
    await page.waitForTimeout(300);
    const s = await stats();
    if (s) peak = Math.max(peak, s.awake);
  }
  const before = await stats();

  // Reset on top of the collapse, which is when a player presses the button.
  const errorsBefore = before?.errors ?? 0;
  try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
  await page.waitForTimeout(6000);
  const after = await stats();
  const seen = await city(page);

  console.log(`cycle ${cycle}: ${before?.bonds ?? '?'} bonds, peak ${peak} awake`
    + ` -> after reset ${after?.bonds ?? '?'} bonds, ${after?.bodies ?? '?'} bodies,`
    + ` frame ${after?.frame ?? '?'}, rejected +${(after?.errors ?? 0) - errorsBefore}`
    + ` (bits ${after?.bits ?? '?'}), client chunks ${seen.chunksTotal ?? 0}`);

  if ((after?.errors ?? 0) > errorsBefore || (after?.bodies ?? 0) === 0) {
    broke = { cycle, before, after, peak };
  }
}

if (broke) {
  console.log(`\nthe stage stopped on cycle ${broke.cycle}, after a collapse of`
    + ` ${broke.before?.bonds} bonds with ${broke.peak} bodies in the air.`);
  // Does the server get itself back? That is what the automatic rebuild is for,
  // and until now it had only ever been exercised by fault injection.
  for (const wait of [5000, 10000, 20000]) {
    await page.waitForTimeout(wait);
    const s = await stats();
    console.log(`  +${wait / 1000}s: ${s?.bodies ?? '?'} bodies, frame ${s?.frame ?? '?'},`
      + ` rejected ${s?.errors ?? '?'}`);
    if ((s?.bodies ?? 0) > 0 && (s?.frame ?? 0) > 0) {
      console.log('  recovered on its own.');
      break;
    }
  }
} else {
  console.log(`\n${CYCLES} collapse-and-reset cycles with no stage failure.`);
}
await browser.close();
