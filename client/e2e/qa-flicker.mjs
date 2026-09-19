/**
 * Hunt the flicker that only shows up in a big collapse.
 *
 * Reported from play: during a whole-building collapse with thousands of
 * active bodies, chunks flicker for individual frames -- the destruction
 * itself looks right, but some frames show a chunk in the wrong place or not
 * at all. The physics is not in question; this is about what gets drawn.
 *
 * Three mechanisms in this client can do that, and the point of this script is
 * to tell them apart rather than guess:
 *
 *  - the two-writer flicker, which CityChunksLayer already names and probes: a
 *    body drawn while its ledger pose came from the raw streamed writer rather
 *    than the interpolated one, so it is shown roughly an interpolation delay
 *    ahead of everything around it for one frame;
 *  - a correction the presentation layer judged too large to glide and snapped;
 *  - a chunk hidden, unplaced, or orphaned for a frame while its body changes
 *    ownership.
 *
 * All three are counted here, against the same collapse.
 *
 *   node client/e2e/qa-flicker.mjs --shots 24
 *   node client/e2e/qa-flicker.mjs --shots 24 --out /tmp/flicker   # + frame grabs
 */
import { mkdirSync } from 'node:fs';
import { openCity, city, player } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const SHOTS = Number(arg('shots', 24));
/** How far to sweep either side of the building's centre, radians. */
const SWEEP_RAD = Number(arg('sweep', 0.13));
/** How many times to walk across the frontage. */
const PASSES = Number(arg('passes', 3));
/** Aim at the footing, not the facade. */
const BASE_PITCH = Number(arg('pitch', -0.015));
const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const OUT = arg('out', null);
if (OUT) mkdirSync(OUT, { recursive: true });

try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
await new Promise((r) => setTimeout(r, 4000));

const { browser, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  query: arg('query', ''),
});
await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
await page.waitForTimeout(6000);

// The probe is gated on the netlab recorder, because it costs a lookup per
// drawn body per frame. Without it running, the one place the two-writer
// flicker can be observed observes nothing.
await page.evaluate(() => window.__VIBE_RECORDER__.start({
  maxFrames: 20000, maxEvents: 60000, cityEventsPerSecond: 2000,
}));

// Everything into one building, so it comes down rather than being chipped.
// A collapse is what produces the thousands of simultaneously active bodies
// the report is about; scattered hits never get there.
const serverAwake = async () => {
  try {
    const r = await fetch(`${API}/match-stats/${MATCH}`);
    const d = r.ok ? await r.json() : {};
    return [d.city?.awake_bodies ?? 0, d.city?.chunk_bodies ?? 0];
  } catch { return [0, 0]; }
};

const say = async (what) => {
  const c = await city(page);
  const [awake, bodies] = await serverAwake();
  console.log(`  ${what.padEnd(26)} server awake ${String(awake).padStart(6)}/${String(bodies).padStart(6)}`
    + `  client awake chunks ${String(c.chunksAwake ?? 0).padStart(6)}`
    + `  bonds ${String(c.brokenBonds ?? 0).padStart(6)}`
    + `  drawn-jumps ${c.presentedJumpsOver1m ?? 0}`);
  return c;
};

await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
await page.waitForTimeout(400);
const p = await player(page);
const range = Math.hypot(p.position[0], p.position[2]);
await say('before');

let peakAwake = 0;
for (let shot = 0; shot < SHOTS; ++shot) {
  // Walk the aim up the face of the same building rather than sweeping across
  // the skyline: the goal is one structure losing its footing.
  const lift = Math.atan2(0.5 * 9.81 * (range / 60) ** 2, range);
  // Walk the shots ALONG the bottom row of supports, which is how a player
  // actually brings a building down: hold the pitch at the base and sweep the
  // yaw across its width, taking out the footing rather than chipping the
  // facade. Chipping produces rubble and a few hundred moving bodies; taking
  // the supports out produces the collapse the reports are about, with
  // thousands. A 40 m frontage at this range is about +/-0.13 rad.
  const sweep = SWEEP_RAD * Math.sin((shot / SHOTS) * Math.PI * PASSES * 2);
  await page.evaluate(([y, q]) => window.__VIBE_DRIVE__.look(y, q),
    [p.yaw + sweep, BASE_PITCH + lift]);
  await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 140 }));
  await page.waitForTimeout(300);
  const c = await city(page);
  const [awake] = await serverAwake();
  peakAwake = Math.max(peakAwake, awake);
  if (OUT && shot % 4 === 0) {
    await page.screenshot({ path: `${OUT}/shot-${String(shot).padStart(2, '0')}.png` });
  }
}
await page.waitForTimeout(3000);
const after = await say('after the collapse');

// A dead destruction stage looks like a quiet, well-behaved client from here:
// nothing breaks, so nothing flickers, and the run scores perfectly. Two
// measurement passes were lost to that before this check existed.
const rejected = await (async () => {
  try {
    const r = await fetch(`${API}/match-stats/${MATCH}`);
    const d = r.ok ? await r.json() : {};
    return d.spans?.['destruction/native_error_frames']?.v ?? 0;
  } catch { return 0; }
})();
if (rejected > 0 || (after.brokenBonds ?? 0) === 0) {
  console.error(`\nthe destruction stage rejected ${rejected} ticks and the city broke`
    + ` ${after.brokenBonds ?? 0} bonds. Nothing measured here is about rendering.`);
  await browser.close();
  process.exit(1);
}

const drained = await page.evaluate(() => {
  const r = window.__VIBE_RECORDER__;
  const out = r.drainEvents(0, 60000);
  return { events: out.events, lost: out.lostEvents, stop: r.stop() };
});

const flickers = drained.events.filter((e) => e.type === 'city_flicker');
const buckets = { '0-0.1m': 0, '0.1-0.5m': 0, '0.5-2m': 0, '2m+': 0 };
let worst = 0;
const bodies = new Set();
for (const e of flickers) {
  const d = Number(e.data?.deltaM ?? 0);
  worst = Math.max(worst, d);
  bodies.add(e.data?.body);
  if (d < 0.1) buckets['0-0.1m'] += 1;
  else if (d < 0.5) buckets['0.1-0.5m'] += 1;
  else if (d < 2) buckets['0.5-2m'] += 1;
  else buckets['2m+'] += 1;
}
const others = {};
for (const e of drained.events) {
  if (e.type !== 'city_flicker') others[e.type] = (others[e.type] ?? 0) + 1;
}

// The teleport probe watches the INSTANCE that is drawn, and fires only on a
// step the chunk's own recent speed cannot explain. Its payload says which
// writer produced the pose, whether the body was settling or settled, and how
// long since that chunk was last written -- enough to name the mechanism
// instead of guessing at it.
const teleports = drained.events.filter((e) => e.type === 'city_chunk_teleport');
const tally = (rows, pick) => {
  const out = {};
  for (const r of rows) {
    const k = String(pick(r));
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
};
if (teleports.length) {
  const step = (e) => Number(e.data?.stepM ?? 0);
  // Per broken bond, because how much of a building actually comes down varies
  // by a factor of three on identical shots, and the raw totals vary with it.
  // And split out the settle signature -- a body the ledger has marked settled
  // and stopped streaming -- because that is the population a settle-path
  // change moves, and burying it in the total is how a targeted fix gets
  // scored on everything it did not touch.
  const settleTeleports = teleports.filter(
    (e) => e.data?.settling === true && e.data?.bodySettled === true,
  );
  const bonds = Math.max(1, after.brokenBonds ?? 1);
  console.log(`\ndrawn chunk teleports: ${teleports.length}`
    + ` (${(teleports.length / bonds).toFixed(2)} per broken bond),`
    + ` worst ${Math.max(...teleports.map(step)).toFixed(1)} m`);
  console.log(`  of which on settled bodies: ${settleTeleports.length}`
    + ` (${(settleTeleports.length / bonds).toFixed(3)} per broken bond)`);
  for (const [label, rows] of [
    ['by writer', tally(teleports, (e) => e.data?.source)],
    ['by settling', tally(teleports, (e) => `settling=${e.data?.settling} settled=${e.data?.bodySettled}`)],
    ['by size', tally(teleports, (e) => {
      const d = step(e);
      return d < 1 ? '<1m' : d < 4 ? '1-4m' : d < 32 ? '4-32m' : '32m+';
    })],
    ['by gap since last write', tally(teleports, (e) => {
      const ms = Number(e.data?.sinceLastWriteMs ?? -1);
      return ms < 0 ? 'first write' : ms < 20 ? '<20ms' : ms < 100 ? '20-100ms' : '100ms+';
    })],
  ]) {
    console.log(`  ${label}:`);
    for (const [k, n] of rows) console.log(`    ${String(k).padEnd(34)} ${n}`);
  }
}

const adoptions = drained.events.filter((e) => e.type === 'city_adoption_jump');
if (adoptions.length) {
  const step = (e) => Number(e.data?.stepM ?? 0);
  const sizes = tally(adoptions, (e) => {
    const d = step(e);
    return d < 0.5 ? '<0.5m' : d < 2 ? '0.5-2m' : d < 8 ? '2-8m' : '8m+';
  });
  console.log(`\nadoption jumps (a chunk's pose moving across a topology`
    + ` re-parent): ${adoptions.length}, worst ${Math.max(...adoptions.map(step)).toFixed(1)} m`);
  for (const [k, n] of sizes) console.log(`    ${k.padEnd(10)} ${n}`);
}

console.log(`\npeak awake bodies on the server ${peakAwake}, ${after.brokenBonds ?? 0} bonds broken`);
console.log(`\ntwo-writer flicker: ${flickers.length} draws across ${bodies.size} bodies,`
  + ` worst ${worst.toFixed(2)} m`);
console.log(`  by how far the raw pose was from the interpolated one:`);
for (const [name, n] of Object.entries(buckets)) console.log(`    ${name.padEnd(10)} ${n}`);
console.log(`\nawake chunks ${after.chunksAwake ?? 0}, live islands ${after.liveIslands ?? 0},`
  + ` poses refused as outside the world ${after.recordsOutsideWorld ?? 0}`);
console.log(`correction snaps ${after.correctionSnaps ?? 0}`
  + ` (worst ${(after.presentationAnomalyMaxM ?? 0).toFixed(1)} m),`
  + ` rollbacks ${after.clockRollbacks ?? 0}, implausible ${after.implausibleJumps ?? 0}`);
console.log(`drawn pose steps >1m ${after.presentedJumpsOver1m ?? 0},`
  + ` >4m ${after.presentedJumpsOver4m ?? 0}, worst ${(after.presentedJumpMaxM ?? 0).toFixed(1)} m`);
console.log(`orphaned chunks ${after.orphanedChunks ?? 0},`
  + ` below ground ${after.chunksBelowGround ?? 0}, stale drawn ${after.staleDrawnChunks ?? 0}`);
if (Object.keys(others).length) console.log(`other recorded events:`, others);
if (drained.lost) console.log(`(${drained.lost} events lost to the ring)`);

await browser.close();
