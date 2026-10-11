// Vehicle measure: one player drives a car through a course while another
// watches, both through the real stack, and both drawings are judged against
// the server's own per-tick record of the car.
//
// The server must run with VIBE_VEHICLE_TAPE=1: it records, per tick, the
// driven car's applied input and its state after the step
// (/city-vehicle-tape, in client/netlab/vehicle/replay.ts's format). That tape
// is the truth here (no polling), and is saved for the deterministic replay
// (scripts/qualify-vehicle-city.mts), where the same drive can be replayed
// through the driver's predictor under any collision world and link.
//
// Measured, per role (limits are docs/vehicle-netcode-quality.md's):
//   driver   drawn vs truth at the tick it is drawn at (its prediction: the
//            acked state plus the inputs replayed since); pops (a frame's
//            step off the truth's step by over 0.20 m); corrections and hard
//            corrections a minute; input-to-drawn latency; and the server's
//            input pipeline (ticks its queue was empty, inputs collapsed).
//   observer drawn vs truth at the car-clock tick it is drawn at; pops.
// Both are split into the 30 ticks after an impact (a tick whose horizontal
// deceleration exceeds what the tyres can (Coulomb: mu g)) and the rest.
//
//   cd client && QA_CLIENT=http://localhost:3692 QA_SERVER=http://127.0.0.1:6921 \
//     node e2e/vehicle-measure.mjs [--course street|wall] [--impair lte] [--seed 1] [--car 13] [--out dir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join as pathJoin } from 'node:path';
import { joinDropPose } from './helpers/vehicleQaCore.mjs';
import { resolveDrivingSetup } from '../src/vehicles/configuration.mjs';

const CLIENT = process.env.QA_CLIENT ?? 'http://localhost:3003';
const SERVER = process.env.QA_SERVER ?? 'http://localhost:4001';
const MATCH = 'city-default';
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const CAR = Number(arg('--car', 13));
const COURSE = arg('--course', 'street');
const IMPAIR = arg('--impair', '');
const SEED = Number(arg('--seed', 1));
const out = resolve(arg('--out', `../target/vehicle-measure/${COURSE}-${IMPAIR || 'clean'}-${SEED}`));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const note = (text) => console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const query = [process.env.QA_QUERY, IMPAIR && `netlab=1&impair=${IMPAIR}&impairSeed=${SEED}`].filter(Boolean).join('&');

const api = async (path, body) => {
  const r = await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const carDebug = (car) => api(`/city-vehicle-debug/${MATCH}?car=${car}`);
const stats = () => api(`/match-stats/${MATCH}`).catch(() => null);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
async function player() {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  await page.addInitScript(() => { globalThis.__VIBE_VEHICLE_TRACE__ = []; });
  const snap = () => page.evaluate(() => window.__VIBE_E2E__?.snapshot());
  const drive = (fn, ...a) => page.evaluate(([fn, a]) => window.__VIBE_DRIVE__[fn](...a), [fn, a]);
  async function join([x, y, z]) {
    await page.goto(`${CLIENT}/city${query ? `?${query}` : ''}`);
    for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__VIBE_E2E__)); i++) await sleep(500);
    await page.mouse.click(480, 270);
    for (let i = 0; i < 160; i++) {
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
    note(`player ${(await snap()).playerId} joined`);
  }
  // The frames of one car (handle) as this page drew them, drained as it runs.
  const frames = [];
  let draining = false;
  let drainer = null;
  const follow = (handle) => {
    draining = true;
    drainer = (async () => {
      while (draining) {
        const batch = await page.evaluate((h) => {
          const all = globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
          return all.splice(0, all.length).filter((x) => x.kind === 'frame' && x.id === h)
            .map((x) => ({ t: x.t, carTick: x.drawTick, drivenTick: x.drivenTick, p: x.position }));
        }, handle).catch(() => []);
        frames.push(...batch);
        await sleep(100);
      }
    })();
  };
  const stop = async () => { draining = false; await drainer; };
  return { page, snap, drive, join, frames, follow, stop };
}

// The match starts with its first player.
const driver = await player();
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
note(`driving car ${CAR} (handle ${handle}), course ${COURSE}, link ${IMPAIR || 'clean'}`);
const observer = await player();
// On the far sidewalk behind the start (the street runs along x, shops from
// |z| = 7 m): never in the car's way, which would be a collision with a player.
await observer.join([cx - 8, 1, -6]);
// Clocks settle from a player's first packets before anything is judged.
await sleep(3000);
await driver.page.evaluate(() => window.__VIBE_RECORDER__?.start({ maxEvents: 200000 }));
driver.follow(handle);
observer.follow(handle);
const before = await stats();
// The server's tape keeps two minutes across runs: this run is what follows.
const tapeFrom = (await api(`/city-vehicle-tape/${MATCH}?car=${CAR}`)).frames.at(-1)?.tick ?? 0;
const t0 = Date.now();

// The course: inputs by time, the same every run.
const STEPS = {
  // Down the main street, weaving gently.
  street: [[2400, 1, 0.4], [1200, 1, -0.4], [1200, 1, 0.4], [1200, 1, -0.4], [1200, 1, 0.4], [1200, 1, -0.4], [1500, 0, 0]],
  // Up to speed, a hard right into the shops, back out, and into the other side.
  wall: [[2200, 1, 0], [600, 1, 1], [1800, 1, 0], [1500, -1, 0], [900, 1, -1], [2000, 1, 0], [1500, 0, 0]],
}[COURSE];
if (!STEPS) throw new Error(`unknown course ${COURSE}`);
for (const [ms, forward, strafe] of STEPS) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const st = await carDebug(CAR).catch(() => null);
    if (st) await observer.drive('lookAt', st.vehicle2.position[0], st.vehicle2.position[1] + 0.5, st.vehicle2.position[2]);
    await driver.drive('move', { forward, strafe, durationMs: 250 });
    await sleep(120);
  }
}
await sleep(1000);
const after = await stats();
await driver.stop();
await observer.stop();
const events = await driver.page.evaluate(() => window.__VIBE_RECORDER__?.drainEvents(0, 200000)?.events ?? []).catch(() => []);
const tape = await api(`/city-vehicle-tape/${MATCH}?car=${CAR}`);
tape.frames = tape.frames.filter((f) => f.tick > tapeFrom);
await browser.close();

// ---- truth ----
const truth = new Map(tape.frames.map((f) => [f.tick, f.sample.position]));
const ticks = tape.frames.map((f) => f.tick);
const truthAt = (tick) => {
  const a = Math.floor(tick), f = tick - a;
  const pa = truth.get(a), pb = truth.get(a + 1);
  if (!pa || !pb) return null;
  return pa.map((v, k) => v + (pb[k] - v) * f);
};
// Impacts: a tick whose horizontal deceleration the tyres cannot give (mu g).
const mu = (() => { try { return resolveDrivingSetup(tape.vehicle.configuration).tyreFriction; } catch { return null; } })();
const impacts = [];
if (mu) {
  for (let i = 2; i < tape.frames.length; i++) {
    const [a, b, c] = [tape.frames[i - 2], tape.frames[i - 1], tape.frames[i]];
    if (c.tick !== b.tick + 1 || b.tick !== a.tick + 1) continue;
    const v = (f) => [f.sample.linearVelocity[0], f.sample.linearVelocity[2]];
    const [v0, v1] = [v(b), v(c)];
    const dv = Math.hypot(v1[0] - v0[0], v1[1] - v0[1]) * 60;
    if (dv > mu * 9.81) impacts.push(c.tick);
  }
}
const nearImpact = (tick) => impacts.some((t) => tick >= t && tick < t + 30);

// ---- scoring ----
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const r3 = (x) => +x.toFixed(3);
function score(frames, tickOf) {
  const judged = frames.map((f) => ({ ...f, tick: tickOf(f) })).filter((f) => f.tick != null && truthAt(f.tick));
  const err = judged.map((f) => { const tp = truthAt(f.tick); return { tick: f.tick, t: f.t, e: Math.hypot(...f.p.map((v, k) => v - tp[k])) }; });
  let pops = 0, worstStep = 0;
  for (let i = 1; i < judged.length; i++) {
    const [a, b] = [truthAt(judged[i - 1].tick), truthAt(judged[i].tick)];
    const excess = Math.hypot(...judged[i].p.map((v, k) => v - judged[i - 1].p[k] - (b[k] - a[k])));
    worstStep = Math.max(worstStep, excess);
    if (excess > 0.2) pops++;
  }
  // Worst one-second window's p95.
  let rolling = 0;
  for (let i = 0; i < err.length; i++) {
    const w = err.filter((x) => x.t >= err[i].t && x.t < err[i].t + 1000).map((x) => x.e);
    if (w.length >= 10) rolling = Math.max(rolling, q(w, 0.95));
  }
  const part = (xs) => ({ n: xs.length, p50: r3(q(xs, 0.5)), p95: r3(q(xs, 0.95)), max: r3(Math.max(0, ...xs)) });
  return {
    frames: frames.length, judged: judged.length,
    errorM: part(err.map((x) => x.e)), worstSecondP95M: r3(rolling),
    afterImpact: part(err.filter((x) => nearImpact(x.tick)).map((x) => x.e)),
    elsewhere: part(err.filter((x) => !nearImpact(x.tick)).map((x) => x.e)),
    pops, worstExtraStepM: r3(worstStep),
  };
}
const minutes = (Date.now() - t0) / 60000;
const corrections = events.filter((e) => e.type === 'vehicle_reconcile');
const presented = events.filter((e) => e.type === 'vehicle_input_presented').map((e) => e.data.delayMs);
const stat = (o, k) => o?.network?.[k] ?? 0;
const speeds = tape.frames.map((f) => Math.hypot(f.sample.linearVelocity[0], f.sample.linearVelocity[2]));
const report = {
  course: COURSE, link: IMPAIR || 'clean', seed: SEED, car: CAR, handle,
  tapeTicks: tape.frames.length, meanSpeedMps: r3(speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length)), maxSpeedMps: r3(Math.max(0, ...speeds)),
  tyreFriction: mu, impacts: impacts.length,
  driver: {
    ...score(driver.frames, (f) => f.drivenTick),
    corrections: { n: corrections.length, p50: r3(q(corrections.map((e) => e.data.errorM), 0.5)), p95: r3(q(corrections.map((e) => e.data.errorM), 0.95)),
      hardPerMin: r3(corrections.filter((e) => e.data.hard).length / minutes) },
    inputToDrawnMs: { n: presented.length, p50: r3(q(presented, 0.5)), p95: r3(q(presented, 0.95)) },
    serverInputs: { starvedPerMin: r3((stat(after, 'vehicle_input_starved') - stat(before, 'vehicle_input_starved')) / minutes),
      collapsedPerMin: r3((stat(after, 'vehicle_inputs_collapsed') - stat(before, 'vehicle_inputs_collapsed')) / minutes),
      skippedPerMin: r3((stat(after, 'vehicle_inputs_skipped') - stat(before, 'vehicle_inputs_skipped')) / minutes),
      meanQueueDepth: r3(tape.frames.reduce((a, f) => a + f.depth, 0) / Math.max(1, tape.frames.length)) },
  },
  observer: score(observer.frames, (f) => f.carTick),
};
writeFileSync(pathJoin(out, 'report.json'), JSON.stringify(report, null, 1));
// The drive, for the deterministic replay.
writeFileSync(pathJoin(out, 'tape.json'), JSON.stringify({ source: 'live /city-vehicle-tape', course: COURSE, link: IMPAIR || 'clean', seed: SEED, car: CAR,
  vehicle: tape.vehicle, frames: tape.frames }));
console.log(JSON.stringify(report, null, 1));
