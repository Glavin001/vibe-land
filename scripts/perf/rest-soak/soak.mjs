// Long continuous-destruction soak of one live /city server: one headless
// player destroys the city building by building (cannonballs, a fired meteor,
// a meteor via /city-meteor, a footing demolition), drives through the rubble,
// idles, drops a meteor on every pile, resets the city, and repeats until
// DURATION_S has passed. Every cycle runs inside one server capture, so its
// encoder tape has every settle and wake edge with poses: rewake.py checks
// from it whether bodies that were put to sleep wake when hit. Twice per cycle
// a fresh pile gets 28 s to settle, then cannonballs and a meteor.
//
// Run by scripts/perf/rest-soak/run.sh (server + driver under the GPU lock).
//   OUT=<dir> CLIENT=http://localhost:3643 API=http://127.0.0.1:6401 \
//     DURATION_S=1860 node scripts/perf/rest-soak/soak.mjs
//
// Writes into OUT: soak.json (steps, re-wake checks, errors), stats.jsonl
// (/match-stats every second: tick ring, GPU warnings, city counters, every
// destruction/native_* span), client-console.log. Captures land in the
// server's VIBE_DEBUG_REPORTS_DIR as session-<id>/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const CLIENT_DIR = process.env.CLIENT_DIR ?? '/Users/glavin/Development/vibe-land/client';
const require = createRequire(path.join(CLIENT_DIR, 'package.json'));
const { chromium } = require('playwright');
const { walkTo, driveTo, enterNearest } = await import(path.join(CLIENT_DIR, 'e2e/mac-demo/nav.mjs'));

const OUT = process.env.OUT;
if (!OUT) throw new Error('OUT is required');
const CLIENT = process.env.CLIENT ?? 'http://localhost:3643';
const API = process.env.API ?? 'http://127.0.0.1:6401';
const MATCH = process.env.MATCH ?? 'city-default';
const DURATION_S = Number(process.env.DURATION_S ?? 1860);
const MAX_FPS = process.env.MAX_FPS ?? '30';
const SEED = Number(process.env.SEED ?? 1);
const LABEL = (process.env.LABEL ?? 'soak').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 20);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const soak = { label: LABEL, startedUnixMs: T0, durationS: DURATION_S, maxFps: MAX_FPS, steps: [], rewake: [], resets: [], errors: [], status: 'running' };
const write = () => fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify(soak, null, 1));
const log = (what) => console.log(`[t=${((Date.now() - T0) / 1000).toFixed(1)}s] ${what}`);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function api(pathname, body) {
  const response = await fetch(`${API}${pathname}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} answered ${response.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── the server, once a second ─────────────────────────────────────────────
const stop = { done: false };
let latest = null;
function sampleServer() {
  const file = path.join(OUT, 'stats.jsonl');
  let lastTick = -1;
  return (async () => {
    while (!stop.done) {
      try {
        const d = await api(`/match-stats/${MATCH}`);
        latest = d;
        const ring = (d.tick_ring || []).filter((t) => t.t > lastTick);
        if (ring.length) lastTick = ring[ring.length - 1].t;
        const physics = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('physics_')));
        const spans = Object.fromEntries(Object.entries(d.spans || {})
          .filter(([k]) => k.startsWith('destruction/native_')).map(([k, v]) => [k.slice(12), v.v]));
        const c = d.city || {};
        fs.appendFileSync(file, JSON.stringify({
          unixMs: Date.now(), server_tick: d.server_tick, players: d.player_count, ...physics,
          city: { broken_bonds: c.broken_bonds, chunk_bodies: c.chunk_bodies, awake_bodies: c.awake_bodies,
            sleeping_bodies: c.sleeping_bodies, step_ms: c.step_ms, degraded: c.degraded, desync: c.city_desync_repairs },
          spans, tick_ring: ring,
        }) + '\n');
      } catch (e) {
        fs.appendFileSync(file, JSON.stringify({ unixMs: Date.now(), error: String(e).slice(0, 200) }) + '\n');
      }
      await sleep(1000);
    }
  })();
}
const cityNow = () => ({
  tick: latest?.server_tick, awake: latest?.city?.awake_bodies, sleeping: latest?.city?.sleeping_bodies,
  bodies: latest?.city?.chunk_bodies, broken: latest?.city?.broken_bonds,
  restSlept: latest?.spans?.['destruction/native_rest_slept_bodies']?.v,
  wakes: latest?.spans?.['destruction/native_resettled_wakes']?.v,
  errorFrames: latest?.spans?.['destruction/native_error_frames']?.v,
  gpuWarnings: latest?.physics_gpu_warning_count,
});

// ── the player ────────────────────────────────────────────────────────────
let browser = null;
async function join() {
  browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleLog = path.join(OUT, 'client-console.log');
  page.on('pageerror', (e) => fs.appendFileSync(consoleLog, `[pageerror] ${String(e).slice(0, 400)}\n`));
  page.on('console', (m) => { if (m.type() === 'error') fs.appendFileSync(consoleLog, `[${m.type()}] ${m.text().slice(0, 400)}\n`); });
  await page.goto(`${CLIENT}/city?maxFps=${MAX_FPS}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 90000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 240000 });
  return page;
}
const snap = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot());

async function leaveCar(page) {
  const s = await snap(page);
  if (!s.inVehicle) return;
  await page.evaluate(() => { window.__VIBE_DRIVE__.stop(); window.__VIBE_DRIVE__.interact(); });
  await sleep(1500);
}

async function standOff(page, b, standoffM, deadline) {
  const s = await snap(page);
  const [cx, , cz] = b.centre;
  const dx = s.position[0] - cx, dz = s.position[2] - cz;
  const d = Math.hypot(dx, dz) || 1;
  const stand = standoffM + b.radius;
  const tx = cx + (dx / d) * stand, tz = cz + (dz / d) * stand;
  const end = await walkTo(page, tx, tz, { within: 3, timeoutMs: Math.max(1000, deadline - Date.now()) });
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [cx, (b.bottom + b.top) / 2, cz]);
  return `${Math.hypot(end.position[0] - tx, end.position[2] - tz).toFixed(1)} m from the standoff`;
}

async function shots(page, mode, n, deadline, aim) {
  await page.evaluate((m) => window.__VIBE_E2E__.setShotMode(m), mode);
  const before = (await snap(page)).shotsFired;
  const gap = clamp((deadline - Date.now() - 300) / n, 700, 2500);
  for (let i = 0; i < n && Date.now() < deadline - 200; i++) {
    await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), aim());
    await sleep(200);
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 40 }));
    await sleep(Math.max(0, Math.min(gap - 200, deadline - Date.now())));
  }
  return `${mode} ${(await snap(page)).shotsFired - before}/${n}`;
}

const faceAim = (b) => () => {
  const h = b.bottom + (0.15 + 0.7 * rand()) * (b.top - b.bottom);
  const j = () => (rand() - 0.5) * b.radius * 0.6;
  return [b.centre[0] + j(), h, b.centre[2] + j()];
};

async function demolish(page, b) {
  const height = b.top - b.bottom;
  const request = {
    x: b.centre[0], z: b.centre[2], radius_m: b.radius + 1,
    below_y: Math.max(b.bottom, 0) + clamp(height * 0.3, 2, 8),
    rounds: 48, jitter: 0.25, per_tick: 8,
    wedge_deg: rand() < 0.5 ? 0 : 50, heading_deg: Math.round(rand() * 360),
  };
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [b.centre[0], b.bottom + height * 0.4, b.centre[2]]);
  return String(await api(`/city-demolish/${MATCH}`, request));
}

async function meteorAt(b, ground) {
  const r = b.radius * 0.5 * rand(), a = 2 * Math.PI * rand();
  const target = [b.centre[0] + r * Math.cos(a), ground ? 0 : b.top, b.centre[2] + r * Math.sin(a)];
  return { target, reply: String(await api(`/city-meteor/${MATCH}`, { targets: [target] })) };
}

// A pile that has had time to settle (and, with rest sleep on, to be put to
// sleep) is hit by cannonballs aimed low into it, then by a meteor on it.
async function rewakeCheck(page, b, cycle) {
  const id = `${LABEL}-c${cycle}-b${b.id}`;
  const check = { cycle, building: b.id, centre: b.centre, radius: b.radius, sessionId: `${LABEL}-c${cycle}`, marks: [] };
  const mark = (what, extra = {}) => { check.marks.push({ what, unixMs: Date.now(), ...cityNow(), ...extra }); log(`rewake ${id}: ${what}`); };
  try {
    mark('settle start');
    await sleep(28000);
    mark('before cannon');
    const aim = () => [b.centre[0] + (rand() - 0.5) * 2, 0.8, b.centre[2] + (rand() - 0.5) * 2];
    check.cannon = await shots(page, 'cannonball', 3, Date.now() + 4000, aim);
    mark('after cannon');
    await sleep(8000);
    mark('before meteor');
    const m = { target: [b.centre[0], 0, b.centre[2]] };
    m.reply = String(await api(`/city-meteor/${MATCH}`, { targets: [m.target] }));
    check.meteor = m;
    mark('meteor requested');
    await sleep(12000);
    mark('end');
  } catch (e) {
    check.error = String(e?.message ?? e).slice(0, 300);
    soak.errors.push(`rewake ${id}: ${check.error}`);
  }
  soak.rewake.push(check);
  write();
}

async function drive(page, destroyed, deadline) {
  const s = await snap(page);
  if (!s.vehicles?.length) return 'no vehicle';
  const me = s.position;
  const dist = (v) => Math.hypot(v.position[0] - me[0], v.position[2] - me[2]);
  const v = s.vehicles.reduce((a, b) => (dist(a) < dist(b) ? a : b));
  await walkTo(page, v.position[0] + 2, v.position[2] + 2, { within: 2.5, timeoutMs: Math.min(20000, deadline - Date.now() - 5000) });
  if (!(await enterNearest(page, v.id))) return `could not enter car ${v.id}`;
  const route = [];
  let at = v.position;
  const left = [...destroyed];
  while (left.length && route.length < 6) {
    left.sort((a, b) => Math.hypot(a.centre[0] - at[0], a.centre[2] - at[2]) - Math.hypot(b.centre[0] - at[0], b.centre[2] - at[2]));
    const b = left.shift();
    route.push([b.centre[0], b.centre[2]]);
    at = b.centre;
  }
  let reached = 0;
  for (const wp of route) {
    if (deadline - Date.now() < 1500) break;
    await driveTo(page, v.id, [wp], { legMs: Math.min(10000, deadline - Date.now() - 500), within: 8 });
    reached++;
  }
  await page.evaluate(() => window.__VIBE_DRIVE__.stop());
  await leaveCar(page);
  return `car ${v.id}: ${reached}/${route.length} waypoints`;
}

async function step(name, slotS, fn) {
  const t0 = Date.now();
  const deadline = t0 + slotS * 1000;
  let note = '', ok = true;
  try {
    note = await Promise.race([fn(deadline), sleep(slotS * 1000 + 5000).then(() => { throw new Error('overran its slot by 5 s'); })]);
  } catch (e) {
    ok = false;
    note = String(e?.message ?? e).slice(0, 300);
    soak.errors.push(`${name}: ${note}`);
  }
  if (Date.now() < deadline) await sleep(deadline - Date.now());
  soak.steps.push({ name, slotS, startUnixMs: t0, endUnixMs: Date.now(), ok, note, ...cityNow() });
  log(`${name}: ${ok ? '' : 'FAILED '}${note}`);
  write();
}

// ── main ──────────────────────────────────────────────────────────────────
process.on('SIGTERM', async () => { soak.status = 'terminated'; write(); await browser?.close().catch(() => {}); process.exit(2); });
process.on('unhandledRejection', (e) => { soak.errors.push(`unhandled: ${e?.stack ?? e}`); write(); });
const elapsedS = () => (Date.now() - T0) / 1000;
try {
  const all = await api('/city-buildings');
  const page = await join();
  log('player joined');
  const sampler = sampleServer();
  await sleep(6000);
  const s0 = await snap(page);
  soak.spawn = s0.position;
  const list = all.filter((b) => b.chunks >= 20);
  const cx = list.reduce((a, b) => a + b.centre[0], 0) / list.length;
  const cz = list.reduce((a, b) => a + b.centre[2], 0) / list.length;
  const a0 = Math.atan2(s0.position[2] - cz, s0.position[0] - cx);
  const ang = (b) => ((Math.atan2(b.centre[2] - cz, b.centre[0] - cx) - a0) % (2 * Math.PI) + 4 * Math.PI) % (2 * Math.PI);
  const order = list.sort((a, b) => ang(a) - ang(b)).slice(0, 16);
  soak.buildings = order.map((b) => b.id);
  soak.soakStartUnixMs = Date.now();
  const soakElapsed = () => (Date.now() - soak.soakStartUnixMs) / 1000;
  let cycle = 0;
  outer: while (soakElapsed() < DURATION_S) {
    cycle += 1;
    const destroyed = [];
    await leaveCar(page).catch(() => {});
    const capture = { cycle, sessionId: `${LABEL}-c${cycle}`, startUnixMs: Date.now() };
    try { capture.start = await api(`/match-stats/${MATCH}/session/${capture.sessionId}/start`, {}); } catch (e) { capture.startError = String(e).slice(0, 200); soak.errors.push(`capture c${cycle}: ${capture.startError}`); }
    soak.captures = soak.captures ?? [];
    soak.captures.push(capture);
    const stopCapture = async () => {
      if (capture.stopUnixMs) return;
      capture.stopUnixMs = Date.now();
      try { capture.stop = await api(`/match-stats/${MATCH}/session/${capture.sessionId}/stop`, {}); } catch (e) { capture.stopError = String(e).slice(0, 200); soak.errors.push(`capture stop c${cycle}: ${capture.stopError}`); }
      write();
    };
    await step(`c${cycle} intro idle`, 5, async () => 'idle');
    for (const [k, b] of order.entries()) {
      if (soakElapsed() >= DURATION_S) { await stopCapture(); break outer; }
      const tag = `c${cycle} b${b.id}`;
      await step(`${tag} walk`, 6, (d) => standOff(page, b, 10, d));
      await step(`${tag} cannon`, 4, (d) => shots(page, 'cannonball', 3, d, faceAim(b)));
      await step(`${tag} meteorShot`, 2, (d) => shots(page, 'meteor', 1, d, faceAim(b)));
      await step(`${tag} meteorAt`, 1, async () => JSON.stringify(await meteorAt(b, false)));
      await step(`${tag} demolish`, 5, () => demolish(page, b));
      destroyed.push(b);
      if (k === 3 || k === 10) await rewakeCheck(page, b, cycle);
    }
    if (soakElapsed() >= DURATION_S) { await stopCapture(); break; }
    await step(`c${cycle} drive`, 25, (d) => drive(page, destroyed, d));
    await step(`c${cycle} idle`, 40, async () => 'idle');
    // A meteor on every pile, one a second, after 40 s of rest.
    await step(`c${cycle} barrage`, 30, async () => {
      const sent = [];
      for (const b of destroyed) {
        const target = [b.centre[0], 0, b.centre[2]];
        sent.push({ building: b.id, target, unixMs: Date.now(), reply: String(await api(`/city-meteor/${MATCH}`, { targets: [target] })) });
        await sleep(1000);
      }
      soak.barrages = soak.barrages ?? [];
      soak.barrages.push({ cycle, sent });
      return `${sent.length} meteors`;
    });
    await stopCapture();
    if (soakElapsed() >= DURATION_S) break;
    // Off the rubble before the reset. This was the workaround for the crash
    // in CapsuleController::move (SIGBUS, 2026-09-24 21:50) when the player's
    // controller still held a fragment the reset freed; the bridge now clears
    // it (forget_released_city_bodies), and reset-soak.mjs covers resetting
    // with the player on the rubble. Kept so this soak's cycles stay comparable.
    await leaveCar(page).catch(() => {});
    await step(`c${cycle} to spawn`, 25, (d) => walkTo(page, s0.position[0], s0.position[2], { within: 3, timeoutMs: Math.max(1000, d - Date.now() - 3000) })
      .then((end) => `${Math.hypot(end.position[0] - s0.position[0], end.position[2] - s0.position[2]).toFixed(1)} m from spawn`));
    const before = cityNow();
    await step(`c${cycle} reset`, 20, async () => String(await api(`/city-reset/${MATCH}`, {})));
    soak.resets.push({ cycle, before, after: cityNow(), unixMs: Date.now() });
  }
  await leaveCar(page).catch(() => {});
  await step('final idle', 45, async () => 'idle');
  soak.endedUnixMs = Date.now();
  stop.done = true;
  await sampler;
  soak.status = soak.errors.length ? 'completed-with-errors' : 'ok';
  write();
  await browser.close().catch(() => {});
  log(`done after ${elapsedS().toFixed(0)} s, ${cycle} cycles, ${soak.errors.length} errors`);
  process.exit(0);
} catch (e) {
  soak.status = 'failed';
  soak.errors.push(`driver: ${e?.stack ?? e}`);
  write();
  log(`FAIL ${e?.stack ?? e}`);
  await browser?.close().catch(() => {});
  process.exit(2);
}
