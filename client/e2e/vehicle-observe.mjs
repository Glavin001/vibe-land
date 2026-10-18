// Vehicle observe: one player drives a car, another watches it, and the
// watcher's drawing of that car is judged against the server's truth.
//
// Two headless Chromium players on /city against the local server. The
// driver gets in a car (--car, default 13) and weaves down the street; the observer stands
// beside the course and keeps looking at the car. Throughout, the server's
// pose of the car is polled with its tick (/city-vehicle-debug), and every
// frame the observer records where it draws the car and the server tick it
// draws other players' cars at (__VIBE_VEHICLE_TRACE__ frame.drawTick). Each
// drawn frame is compared with the truth at its tick (interpolated between
// polls), and the run's bytes come from /match-stats.
//
//   cd client && QA_CLIENT=http://localhost:3692 QA_SERVER=http://127.0.0.1:6921 \
//     node e2e/vehicle-observe.mjs [--seconds 12] [--out dir]
//
// QA_QUERY adds a query string to both players' page URLs.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join as pathJoin } from 'node:path';
import { joinDropPose } from './helpers/vehicleQaCore.mjs';

const CLIENT = process.env.QA_CLIENT ?? 'http://localhost:3003';
const SERVER = process.env.QA_SERVER ?? 'http://localhost:4001';
const MATCH = 'city-default';
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SECONDS = Number(arg('--seconds', 12));
// Car 13 of Vibe Town's fleet is parked on the main street facing +x.
const CAR = Number(arg('--car', 13));
const STEER = Number(arg('--steer', 0.4));
const out = resolve(arg('--out', '../target/vehicle-observe'));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const note = (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

const api = async (path, body) => {
  const r = await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const carDebug = (car) => api(`/city-vehicle-debug/${MATCH}?car=${car}`);
const stats = () => api(`/match-stats/${MATCH}`).catch(() => null);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
async function player(trace) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  if (trace) await page.addInitScript(() => { globalThis.__VIBE_VEHICLE_TRACE__ = []; });
  const snap = () => page.evaluate(() => window.__VIBE_E2E__?.snapshot());
  const drive = (fn, ...a) => page.evaluate(([fn, a]) => window.__VIBE_DRIVE__[fn](...a), [fn, a]);
  async function join([x, y, z]) {
    await page.goto(`${CLIENT}/city${process.env.QA_QUERY ? `?${process.env.QA_QUERY}` : ''}`);
    for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__VIBE_E2E__)); i++) await sleep(500);
    await page.mouse.click(480, 270);
    for (let i = 0; i < 120; i++) {
      const s = await snap().catch(() => null);
      if (s?.connected && s.playerId > 0) break;
      await sleep(500);
    }
    await page.evaluate((pose) => window.__VIBE_E2E__.dropAt(pose), joinDropPose([x, y, z]));
    for (let i = 0; i < 40; i++) {
      const s = await snap().catch(() => null);
      if (s && Math.hypot(s.position[0] - x, s.position[2] - z) < 3) break;
      await sleep(250);
    }
    const s = await snap();
    note(`player ${s.playerId} at ${s.position.map((v) => v.toFixed(1))}`);
  }
  return { page, snap, drive, join };
}

// The match starts with its first player.
const driver = await player(false);
if (!(await carDebug(0).then(() => true, () => false))) {
  await driver.join([55, 1, 0]);
  for (let i = 0; i < 60 && !(await carDebug(0).then(() => true, () => false)); i++) await sleep(500);
}
await api(`/city-reset/${MATCH}`, {});
await sleep(3000);
const start = await carDebug(CAR);
const handle = start.handle;
const [cx, , cz] = start.vehicle2.position;
await driver.join([cx + 2.5, 1, cz]);
await driver.drive('interact');
await sleep(800);
if ((await driver.snap()).drivenVehicleId == null) throw new Error('the driver could not get in');
note(`driving car ${CAR} (handle ${handle})`);
const observer = await player(true);
await observer.join([cx + 25, 1, cz + 8]);
// A player just joined starts its clocks from its first packets: judge the
// drawing once they have settled.
await sleep(3000);

// Truth: the car's pose by server tick, polled throughout.
const truth = [];
let polling = true;
const poller = (async () => {
  while (polling) {
    const d = await carDebug(CAR).catch(() => null);
    if (d?.vehicle2 && truth.at(-1)?.tick !== d.tick) truth.push({ tick: d.tick, p: d.vehicle2.position });
    await sleep(15);
  }
})();
// Drawn: the observer's frames of this car.
const drawn = [];
let draining = true;
const drainer = (async () => {
  while (draining) {
    const frames = await observer.page.evaluate((h) => {
      const all = globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
      return all.splice(0, all.length).filter((x) => x.kind === 'frame' && x.id === h && x.drawTick != null)
        .map((x) => ({ t: x.t, tick: x.drawTick, p: x.position }));
    }, handle).catch(() => []);
    drawn.push(...frames);
    await sleep(100);
  }
})();
const carsBefore = await stats();
const t0 = Date.now();
// The server's per-client byte rates, sampled through the drive.
const rates = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    await sleep(1000);
    const m = await stats();
    if (m) rates.push({ snapshot: m.network?.snapshot_bytes_per_client?.avg ?? 0, rig: m.network?.rig_bytes_per_client?.avg ?? 0, stream: m.city?.bytes_per_sec ?? 0 });
  }
})();
// Weave: full throttle, steering left and right every 1.2 s.
let side = 1;
while (Date.now() - t0 < SECONDS * 1000) {
  const st = await carDebug(CAR).catch(() => null);
  if (st) await observer.drive('lookAt', st.vehicle2.position[0], st.vehicle2.position[1] + 0.5, st.vehicle2.position[2]);
  await driver.drive('move', { forward: 1, strafe: side * STEER, durationMs: 400 });
  if ((Date.now() - t0) % 2400 < 1200) side = 1; else side = -1;
  await sleep(150);
}
await driver.drive('move', { forward: 0, strafe: 0, durationMs: 50 });
await sleep(1500);
const carsAfter = await stats();
const core = await observer.page.evaluate(() => window.__VIBE_E2E__?.snapshot()?.city?.perPlayer ?? null).catch(() => null);
sampling = false;
await sampler;
polling = false;
draining = false;
await poller;
await drainer;
await browser.close();

// ---- analysis ----
const at = (tick) => {
  let i = truth.findIndex((s) => s.tick >= tick);
  if (i <= 0) return null;
  const a = truth[i - 1], b = truth[i];
  if (b.tick - a.tick > 6) return null; // a gap in the polls: no truth to judge by
  const f = (tick - a.tick) / (b.tick - a.tick);
  return a.p.map((v, k) => v + (b.p[k] - v) * f);
};
const errors = [];
for (const d of drawn) {
  const tp = at(d.tick);
  if (tp) errors.push(Math.hypot(d.p[0] - tp[0], d.p[1] - tp[1], d.p[2] - tp[2]));
}
errors.sort((a, b) => a - b);
const q = (p) => errors[Math.min(errors.length - 1, Math.floor(p * errors.length))] ?? NaN;
// A drawn jump: a frame step that differs from the truth's step over the
// same ticks by more than 0.1 m (the vehicle QA's car-flip distance).
let jumps = 0;
for (let i = 1; i < drawn.length; i++) {
  const [a, b] = [at(drawn[i - 1].tick), at(drawn[i].tick)];
  if (!a || !b) continue;
  const excess = Math.hypot(...drawn[i].p.map((v, k) => v - drawn[i - 1].p[k] - (b[k] - a[k])));
  if (excess > 0.1) jumps++;
}
const speed = truth.length > 1 ? Math.hypot(...truth.at(-1).p.map((v, k) => v - truth[0].p[k])) / ((truth.at(-1).tick - truth[0].tick) / 60) : 0;
const mean = (k) => +(rates.reduce((n, r) => n + r[k], 0) / Math.max(1, rates.length)).toFixed(1);
const report = {
  frames: drawn.length, truthSamples: truth.length, judged: errors.length, meanSpeedMps: +speed.toFixed(1),
  errorM: { p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +(errors.at(-1) ?? NaN).toFixed(3) },
  jumps, seconds: (Date.now() - t0) / 1000,
  // Per client per snapshot (both players), and the per-player stream's
  // bytes a second (every client).
  bytes: { snapshotPerClient: mean('snapshot'), rigPerClient: mean('rig'), streamPerSec: mean('stream') },
  // The car's records in the per-player stream (to the observer: the driver
  // is never sent its own), a second.
  carStream: (() => {
    const s = (Date.now() - t0) / 1000;
    const d = (k) => ((carsAfter?.city?.[k] ?? 0) - (carsBefore?.city?.[k] ?? 0)) / s;
    return { recordsPerSec: +d('pp_car_records').toFixed(1), bytesPerSec: +d('pp_car_bytes').toFixed(0) };
  })(),
  observerCore: core,
};
writeFileSync(pathJoin(out, 'report.json'), JSON.stringify({ ...report, truth, drawn }, null, 1));
console.log(JSON.stringify(report, null, 1));
