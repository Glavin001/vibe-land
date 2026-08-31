#!/usr/bin/env node
/**
 * Drive a real player through /city, demolish it, and record solver
 * performance the whole way.
 *
 * This exists because the interesting destruction regimes are hard to reach
 * any other way: a headless trace can bombard a scene, but only a real client
 * exercises the full tick -- netcode, support-graph ingest, contact processing
 * and readback -- while the stress solver is under load.
 *
 *   node e2e/drive-city-perf.mjs --page https://127.0.0.1:8384 --wt-port 4435
 *
 * Options:
 *   --page <url>        page origin (Caddy).           default https://127.0.0.1:8384
 *   --wt-port <n>       WebTransport container port.   default 4435
 *   --match <id>        match id.                      default city-default
 *   --rounds <n>        sample points.                 default 8
 *   --shots <n>         shots between samples.         default 10
 *   --out <file.json>   write the samples as JSON.
 *   --csv <file.csv>    write the samples as CSV.
 *   --headed            show the browser.
 *
 * FOUR THINGS THAT WILL WASTE YOUR AFTERNOON IF YOU REINVENT THIS:
 *
 * 1. Input goes through `window.__VIBE_DRIVE__`, NOT synthetic mouse events.
 *    Headless Chromium cannot grant pointer lock, so `page.mouse.click()`
 *    reaches nothing and `shotsFired` stays 0 while everything else looks
 *    healthy. The one real click that IS needed is the join gesture at the
 *    viewport centre -- gameplay input and the drive bridge's fire path both
 *    hang off it.
 * 2. `page.waitForFunction(fn, {timeout})` passes your options object as the
 *    page-function ARGUMENT. The signature is (fn, arg, options), so a
 *    timeout given that way is silently ignored and you get the 30 s default.
 * 3. Node's global fetch rejects the dev stack's self-signed certificate, so
 *    every /match-stats call returns null -- which reads as "the server has no
 *    stats" rather than "TLS refused". Handled below.
 * 4. Do NOT gate on the client's `snapshot().city`: it publishes every ~30
 *    frames, and headless swiftshader renders at ~1 fps, so that is a ~30 s
 *    interval. Poll the SERVER's /match-stats instead -- it is per-tick, and
 *    it is where the solver timings live anyway.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

// Trap 3. The dev stack is self-signed by construction; this tool only ever
// talks to a local one.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const PAGE = arg('page', 'https://127.0.0.1:8384');
const WT_PORT = Number(arg('wt-port', 4435));
const MATCH = arg('match', 'city-default');
const ROUNDS = Number(arg('rounds', 8));
const SHOTS = Number(arg('shots', 10));
const OUT_JSON = arg('out', null);
const OUT_CSV = arg('csv', null);
const STATS_URL = `${PAGE}/match-stats/${MATCH}`;

/** Authoritative per-tick telemetry. The client snapshot is far too laggy. */
async function serverStats() {
  const r = await fetch(STATS_URL).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json();
  const s = d.spans || {}, c = d.city || {};
  const span = (k) => (s[k] ? s[k].v : undefined);
  return {
    tick: d.server_tick,
    brokenBonds: c.broken_bonds, islands: c.solver_island_count,
    islandsSkipped: c.solver_islands_skipped, chunkBodies: c.chunk_bodies,
    awakeBodies: c.awake_bodies, overstressed: c.overstressed_bonds,
    stepMs: c.step_ms, stressSolveMs: c.stress_solve_ms,
    gpuStressSolveMs: c.gpu_stress_solve_ms, postStepMs: c.post_step_ms,
    physxStepMs: d.physics_last_step_ms,
    gpuHostWorkMs: span('destruction/gpu_host_work_ms'),
    gpuHostBlockedMs: span('destruction/gpu_host_blocked_ms'),
  };
}

const browser = await chromium.launch({
  headless: !flag('headed'),
  args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });

// Rewrite only host:port, KEEPING the advertised path. Replacing the whole URL
// would silently repair a malformed one (e.g. a doubled /game from a bad
// WT_PUBLIC_URL) and the check would pass against a server no real client can
// reach. See the city-stack-run skill.
await page.route('**/session-config*', async (route) => {
  const r = await route.fetch();
  const b = JSON.parse(await r.text());
  const u = new URL(b.url);
  u.hostname = '127.0.0.1';
  u.port = String(WT_PORT);
  b.url = u.toString();
  await route.fulfill({ response: r, body: JSON.stringify(b),
    headers: { ...r.headers(), 'content-type': 'application/json' } });
});

await page.goto(`${PAGE}/city`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60_000 });
await page.mouse.click(640, 360);                                   // trap 1: the join gesture
await page.waitForFunction(
  () => ['webtransport', 'websocket'].includes(window.__VIBE_E2E__.snapshot().transport),
  null, { timeout: 60_000 });                                       // trap 2: arg, then options
const opening = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
if (opening.transport !== 'webtransport') {
  console.error(`FAIL transport=${opening.transport}; the city stream is datagram-only, so the world will be empty.`);
  await browser.close();
  process.exit(1);
}
console.log(`connected  transport=${opening.transport}  player=${opening.playerId}`);

let live = null;                                                    // trap 4: poll the server
for (let i = 0; i < 90 && !live; ++i) {
  const s = await serverStats();
  if (s && s.islands > 0) live = s;
  else await page.waitForTimeout(1000);
}
if (!live) {
  console.error('FAIL no city on the server after 90 s (wrong match id, or the manifest never built).');
  await browser.close();
  process.exit(1);
}
console.log(`city live  ${live.chunkBodies} chunk bodies, ${live.islands} islands, ${live.brokenBonds} bonds already broken`);

const rows = [];
async function sample(tag) {
  const s = await serverStats();
  if (!s) return;
  rows.push({ tag, ...s });
  const f = (v) => (v === undefined ? '  n/a' : v.toFixed(2).padStart(6));
  console.log(`  ${tag.padEnd(13)} broken=${String(s.brokenBonds).padStart(7)} islands=${String(s.islands).padStart(5)}`
    + ` awake=${String(s.awakeBodies).padStart(5)} | step=${f(s.stepMs)} stress=${f(s.stressSolveMs)}`
    + ` gpuSolve=${f(s.gpuStressSolveMs)} physx=${f(s.physxStepMs)} ms`);
}

await sample('idle');
await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
await page.waitForTimeout(1500);

// Sweep aim across the skyline so damage spreads over several structures
// rather than boring one hole. Pitch varies so shots land at several heights.
const PITCHES = [0.05, -0.02, 0.12, 0.0];
for (let round = 0; round < ROUNDS; ++round) {
  const yaw = -0.6 + round * 0.15;
  for (let i = 0; i < SHOTS; ++i) {
    await page.evaluate(([y, p]) => window.__VIBE_DRIVE__.look(y, p),
      [yaw + (i - SHOTS / 2) * 0.03, PITCHES[i % PITCHES.length]]);
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 140 }));
    await page.waitForTimeout(200);
  }
  await sample(`shots-${(round + 1) * SHOTS}`);
}
await page.waitForTimeout(6000);
await sample('settled');

const first = rows[0], last = rows.at(-1);
console.log(`\nbonds broken over the run: ${last.brokenBonds - first.brokenBonds}`
  + `  |  islands ${first.islands} -> ${last.islands}`
  + `  |  chunk bodies ${first.chunkBodies} -> ${last.chunkBodies}`);
const solves = rows.map((r) => r.gpuStressSolveMs).filter((v) => v !== undefined).sort((a, b) => a - b);
if (solves.length) {
  console.log(`gpu stress solve: min ${solves[0].toFixed(2)} median `
    + `${solves[solves.length >> 1].toFixed(2)} max ${solves.at(-1).toFixed(2)} ms`);
}

if (OUT_JSON) { writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2)); console.log(`wrote ${OUT_JSON}`); }
if (OUT_CSV) {
  const cols = Object.keys(rows[0]);
  writeFileSync(OUT_CSV, [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n'));
  console.log(`wrote ${OUT_CSV}`);
}
await browser.close();
