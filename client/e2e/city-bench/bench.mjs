// City benchmark driver: scripted headless players destroy /city building by
// building while every client records a paired (client + server) tape.
//
// Normally run by scripts/perf/city-bench.sh, which starts the server and the
// client dev server on their own ports, holds the GPU lock, and analyses the
// result. Standalone:
//
//   OUT=<runDir> CLIENT=http://localhost:3303 API=http://127.0.0.1:4301 \
//     SCENARIO=e2e/city-bench/scenarios/systematic.json CLIENTS=1 \
//     node e2e/city-bench/bench.mjs
//
// Environment: OUT (required), CLIENT, API, MATCH (city-default), SCENARIO,
// CLIENTS (1), BUILDINGS (cap on buildings), INTENSITY (scales shots, meteors
// and demolition rounds; not slot times), SEED, RUN_ID, WATCHDOG_S.
//
// The scenario is a timed plan: every step has a slot (wall seconds). A step
// runs until it is done or its slot ends, and the next step starts when the
// slot ends, so a run takes the same wall time whatever the server does and
// runs can be compared phase by phase. The tape length is the plan's length.
//
// Client 0 is the player that destroys the city. Clients 1..N-1 are
// spectators: they move to a vantage point around each building in turn and
// watch it, so each receives the destruction stream a real bystander would.
// Every client is a headless Chromium rendering through ANGLE/Metal on the
// same GPU as the server.
//
// Writes into OUT: run.json (plan, phases with unix times, sessions, build
// identity, errors), server-stats.jsonl (/match-stats once a second),
// client-<i>-samples.jsonl (the client's own counters once a second),
// client-<i>-drawn.jsonl (what the renderers drew, ~10 Hz, on the tape
// clock). Bundles land in the server's
// VIBE_DEBUG_REPORTS_DIR as session-<RUN_ID>-c<i>/.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { walkTo, driveTo, enterNearest } from '../mac-demo/nav.mjs';

const OUT = process.env.OUT;
if (!OUT) throw new Error('OUT is required');
const CLIENT = process.env.CLIENT ?? 'http://localhost:3303';
const API = process.env.API ?? 'http://127.0.0.1:4301';
const MATCH = process.env.MATCH ?? 'city-default';
const CLIENTS = Math.max(1, Number(process.env.CLIENTS ?? 1));
const SCENARIO_PATH = process.env.SCENARIO ?? new URL('./scenarios/systematic.json', import.meta.url).pathname;
const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, 'utf8'));
const INTENSITY = Number(process.env.INTENSITY ?? scenario.intensity ?? 1);
const SEED = Number(process.env.SEED ?? scenario.seed ?? 1);
const BUILDING_CAP = process.env.BUILDINGS ? Number(process.env.BUILDINGS) : (scenario.buildings?.max ?? Infinity);
const RUN_ID = (process.env.RUN_ID ?? `bench-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 56);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const events = [];
const log = (what, extra) => {
  const line = `[t=${((Date.now() - T0) / 1000).toFixed(1)}s] ${what}`;
  console.log(extra ? `${line} ${JSON.stringify(extra)}` : line);
  events.push({ unixMs: Date.now(), what, ...(extra ? { extra } : {}) });
};
const run = {
  format: 'city-bench-run/1', runId: RUN_ID, startedUnixMs: T0, client: CLIENT, api: API, match: MATCH,
  clients: CLIENTS, scenarioPath: SCENARIO_PATH, scenario, intensity: INTENSITY, seed: SEED,
  plan: [], phases: [], sessions: [], errors: [], events, status: 'running',
};
const writeRun = () => fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(run, null, 1));

// Deterministic randomness: aim jitter, demolition style.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

async function api(pathname, body) {
  const response = await fetch(`${API}${pathname}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} answered ${response.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ── teardown and watchdog ─────────────────────────────────────────────────
const browsers = [];
let finished = false;
async function teardown(status, reason) {
  if (finished) return;
  finished = true;
  run.status = status;
  if (reason) run.failReason = reason;
  run.endedUnixMs = Date.now();
  writeRun();
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
}
function fail(reason) {
  log(`FAIL: ${reason}`);
  run.errors.push(reason);
  return teardown('failed', reason).then(() => process.exit(2));
}
process.on('SIGTERM', () => { void fail('terminated (SIGTERM)'); });
process.on('SIGINT', () => { void fail('interrupted (SIGINT)'); });
process.on('unhandledRejection', (e) => { void fail(`unhandled rejection: ${e?.stack ?? e}`); });

// ── clients ───────────────────────────────────────────────────────────────
async function join(index) {
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  browsers.push(browser);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleLog = path.join(OUT, `client-${index}-console.log`);
  page.on('pageerror', (e) => fs.appendFileSync(consoleLog, `[pageerror] ${String(e).slice(0, 400)}\n`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') fs.appendFileSync(consoleLog, `[${m.type()}] ${m.text().slice(0, 400)}\n`); });
  await page.goto(`${CLIENT}/city`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 90000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 240000 });
  const info = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const s = window.__VIBE_E2E__.snapshot();
    return {
      renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
      userAgent: navigator.userAgent, playerId: s.playerId, position: s.position, transport: s.transport,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  log(`client ${index} joined`, info);
  return { index, browser, context, page, info };
}

const snap = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot());
const onCity = (page) => new URL(page.url()).pathname.startsWith('/city');

// Once a second: the client's own counters (city ledger health, debug stats).
function sampleClient(client, stop) {
  const file = path.join(OUT, `client-${client.index}-samples.jsonl`);
  return (async () => {
    while (!stop.done) {
      const s = await client.page.evaluate(() => {
        const x = window.__VIBE_E2E__.snapshot();
        return {
          tapeMs: window.__VIBE_E2E__.tapeElapsedMs(), position: x.position, dead: x.dead, hp: x.hp,
          inVehicle: x.inVehicle, shotsFired: x.shotsFired, lastShotOutcome: x.lastShotOutcome,
          connected: x.connected, transport: x.transport, debugStats: x.debugStats, city: x.city,
        };
      }).catch((e) => ({ error: String(e).slice(0, 200) }));
      fs.appendFileSync(file, JSON.stringify({ unixMs: Date.now(), ...s }) + '\n');
      await sleep(1000);
    }
  })();
}

// ~10 Hz: what the renderers drew, on the tape clock, for rendered-vs-truth error.
function sampleDrawn(client, stop, hz) {
  const file = path.join(OUT, `client-${client.index}-drawn.jsonl`);
  return (async () => {
    while (!stop.done) {
      const d = await client.page.evaluate(() => window.__VIBE_E2E__.drawnWorld()).catch(() => null);
      if (d && d.tapeMs !== null) fs.appendFileSync(file, JSON.stringify(d) + '\n');
      await sleep(1000 / hz);
    }
  })();
}

// Once a second: the server's match stats (tick ring, physics, destruction level).
function sampleServer(stop) {
  const file = path.join(OUT, 'server-stats.jsonl');
  let lastTick = -1;
  return (async () => {
    while (!stop.done) {
      try {
        const d = await api(`/match-stats/${MATCH}`);
        const ring = (d.tick_ring || []).filter((t) => t.t > lastTick);
        if (ring.length) lastTick = ring[ring.length - 1].t;
        const physics = Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('physics_')));
        const c = d.city || {};
        fs.appendFileSync(file, JSON.stringify({
          unixMs: Date.now(), server_tick: d.server_tick, players: d.player_count, dynamic_bodies: d.dynamic_body_count,
          ...physics,
          city: {
            broken_bonds: c.broken_bonds, chunk_bodies: c.chunk_bodies, awake_bodies: c.awake_bodies,
            sleeping_bodies: c.sleeping_bodies, city_desync_repairs: c.city_desync_repairs,
            bytes_per_sec: c.bytes_per_sec, packets_per_sec: c.packets_per_sec, records_per_sec: c.records_per_sec,
            step_ms: c.step_ms, publish_ms: c.publish_ms, degraded: c.degraded,
          },
          timings: d.timings, network: d.network, load: d.load, tick_ring: ring,
        }) + '\n');
      } catch (e) {
        fs.appendFileSync(file, JSON.stringify({ unixMs: Date.now(), error: String(e).slice(0, 200) }) + '\n');
      }
      await sleep(1000);
    }
  })();
}

// ── the plan ──────────────────────────────────────────────────────────────
function orderBuildings(all, start) {
  const minChunks = scenario.buildings?.minChunks ?? 1;
  const list = all.filter((b) => b.chunks >= minChunks);
  const cx = list.reduce((a, b) => a + b.centre[0], 0) / list.length;
  const cz = list.reduce((a, b) => a + b.centre[2], 0) / list.length;
  const order = scenario.buildings?.order ?? 'ring';
  if (order === 'id') return list.sort((a, b) => a.id - b.id);
  if (order === 'nearest') {
    const out = [];
    let at = [start[0], start[2]];
    const left = [...list];
    while (left.length) {
      left.sort((a, b) => Math.hypot(a.centre[0] - at[0], a.centre[2] - at[1]) - Math.hypot(b.centre[0] - at[0], b.centre[2] - at[1]));
      const next = left.shift();
      out.push(next);
      at = [next.centre[0], next.centre[2]];
    }
    return out;
  }
  // ring: by angle round the city centre, starting at the player's spawn side.
  const a0 = Math.atan2(start[2] - cz, start[0] - cx);
  const ang = (b) => ((Math.atan2(b.centre[2] - cz, b.centre[0] - cx) - a0) % (2 * Math.PI) + 4 * Math.PI) % (2 * Math.PI);
  return list.sort((a, b) => ang(a) - ang(b) || Math.hypot(b.centre[0] - cx, b.centre[2] - cz) - Math.hypot(a.centre[0] - cx, a.centre[2] - cz));
}

function buildPlan(buildings) {
  const plan = [];
  const add = (step, phase, building = null) => plan.push({ ...step, phase, building: building?.id ?? null });
  for (const s of scenario.intro ?? []) add(s, 'intro');
  for (const b of buildings) for (const s of scenario.perBuilding ?? []) add(s, `building-${b.id}`, b);
  for (const s of scenario.tail ?? []) add(s, s.phase ?? s.do);
  return plan;
}

const scaled = (n) => Math.max(1, Math.round(n * INTENSITY));

// ── steps (client 0) ──────────────────────────────────────────────────────
const current = { building: null };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const until = (deadline) => Math.max(0, deadline - Date.now());

async function stepWalk(page, step, b, deadline) {
  const s = await snap(page);
  const [cx, , cz] = b.centre;
  const dx = s.position[0] - cx, dz = s.position[2] - cz;
  const d = Math.hypot(dx, dz) || 1;
  const stand = (step.standoffM ?? 10) + b.radius;
  const tx = cx + (dx / d) * stand, tz = cz + (dz / d) * stand;
  const end = await walkTo(page, tx, tz, { within: 3, timeoutMs: until(deadline) });
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [cx, (b.bottom + b.top) / 2, cz]);
  const left = Math.hypot(end.position[0] - tx, end.position[2] - tz);
  return left < 6 ? `at ${left.toFixed(1)} m of the standoff` : `stopped ${left.toFixed(1)} m short`;
}

async function aimAt(page, b) {
  const h = b.bottom + (0.15 + 0.7 * rand()) * (b.top - b.bottom);
  const j = () => (rand() - 0.5) * b.radius * 0.6;
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [b.centre[0] + j(), h, b.centre[2] + j()]);
}

async function stepShots(page, step, b, deadline, mode) {
  await page.evaluate((m) => window.__VIBE_E2E__.setShotMode(m), mode);
  const shots = scaled(step.shots ?? 4);
  const before = (await snap(page)).shotsFired;
  const gap = clamp((until(deadline) - 300) / shots, 700, 2500);
  for (let i = 0; i < shots && Date.now() < deadline - 200; i++) {
    await aimAt(page, b);
    await sleep(200);
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 40 }));
    await sleep(Math.min(gap - 200, until(deadline)));
  }
  const fired = (await snap(page)).shotsFired - before;
  return `${mode}: ${fired}/${shots} fired`;
}

async function stepMeteorAt(page, step, b) {
  const n = scaled(step.count ?? 1);
  const targets = [];
  for (let i = 0; i < n; i++) {
    const r = b.radius * 0.5 * rand(), a = 2 * Math.PI * rand();
    targets.push([b.centre[0] + r * Math.cos(a), step.ground ? 0 : b.top, b.centre[2] + r * Math.sin(a)]);
  }
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [b.centre[0], b.top, b.centre[2]]);
  const reply = await api(`/city-meteor/${MATCH}`, { targets });
  return String(reply);
}

async function stepDemolish(page, step, b) {
  const height = b.top - b.bottom;
  const wedge = step.wedge ?? (rand() < 0.5 ? 0 : 50);
  const request = {
    x: b.centre[0], z: b.centre[2], radius_m: b.radius + 1,
    below_y: Math.max(b.bottom, 0) + clamp(height * (step.cutFraction ?? 0.3), 2, 8),
    rounds: scaled(step.rounds ?? 48), jitter: step.jitter ?? 0.25, per_tick: step.perTick ?? 8,
    wedge_deg: wedge, heading_deg: Math.round(rand() * 360),
  };
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [b.centre[0], b.bottom + height * 0.4, b.centre[2]]);
  const reply = await api(`/city-demolish/${MATCH}`, request);
  return `${reply} ${JSON.stringify(request)}`;
}

async function stepDrive(page, step, deadline, destroyed) {
  let s = await snap(page);
  if (!s.vehicles?.length) return 'no vehicle in the snapshot';
  const me = s.position;
  const dist = (v) => Math.hypot(v.position[0] - me[0], v.position[2] - me[2]);
  const v = s.vehicles.reduce((a, b) => (dist(a) < dist(b) ? a : b));
  await walkTo(page, v.position[0] + 2, v.position[2] + 2, { within: 2.5, timeoutMs: Math.min(20000, until(deadline) - 5000) });
  if (!(await enterNearest(page, v.id))) return `could not enter car ${v.id} (${dist(v).toFixed(0)} m away)`;
  // Through the rubble: the destroyed buildings' footprints, nearest first, then out.
  const route = [];
  let at = v.position;
  const left = [...destroyed];
  while (left.length && route.length < (step.waypoints ?? 6)) {
    left.sort((a, b) => Math.hypot(a.centre[0] - at[0], a.centre[2] - at[2]) - Math.hypot(b.centre[0] - at[0], b.centre[2] - at[2]));
    const b = left.shift();
    route.push([b.centre[0], b.centre[2]]);
    at = b.centre;
  }
  let reached = 0, maxSpeed = 0;
  for (const wp of route) {
    if (until(deadline) < 1500) break;
    maxSpeed = Math.max(maxSpeed, await driveTo(page, v.id, [wp], { legMs: Math.min(10000, until(deadline) - 500), within: 8 }));
    reached++;
  }
  await page.evaluate(() => window.__VIBE_DRIVE__.stop());
  return `car ${v.id}: ${reached}/${route.length} waypoints, max ${maxSpeed.toFixed(1)} m/s`;
}

// Spectators: stand off each target building from their own side, and watch.
async function spectate(client, stop) {
  let watching = null;
  const angle = (2 * Math.PI * client.index) / CLIENTS;
  while (!stop.done) {
    const b = current.building;
    if (b && b !== watching && onCity(client.page)) {
      watching = b;
      const stand = b.radius + 25;
      const tx = b.centre[0] + stand * Math.cos(angle), tz = b.centre[2] + stand * Math.sin(angle);
      await walkTo(client.page, tx, tz, { within: 4, timeoutMs: 12000 }).catch(() => {});
    }
    if (watching && onCity(client.page)) {
      await client.page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z),
        [watching.centre[0], (watching.bottom + watching.top) / 2, watching.centre[2]]).catch(() => {});
    }
    await sleep(1000);
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const WATCHDOG_S = Number(process.env.WATCHDOG_S ?? 0);
try {
  const health = await fetch(`${API}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) await fail(`server not answering at ${API}/healthz`);
  const allBuildings = await api('/city-buildings');
  run.buildingsAll = allBuildings;
  log(`city has ${allBuildings.length} buildings`);

  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(await join(i));
  run.clientInfo = clients.map((c) => ({ index: c.index, ...c.info }));
  const player = clients[0];
  const s0 = await snap(player.page);
  const order = orderBuildings(allBuildings, s0.position).slice(0, BUILDING_CAP);
  run.buildings = order.map((b) => b.id);
  const byId = new Map(order.map((b) => [b.id, b]));
  const plan = buildPlan(order);
  run.plan = plan;
  const plannedS = plan.reduce((a, s) => a + s.slotS, 0);
  const tapeS = Math.ceil(plannedS + (scenario.tapeMarginS ?? 3));
  run.plannedSeconds = plannedS;
  run.tapeSeconds = tapeS;
  log(`plan: ${plan.length} steps over ${order.length} buildings, ${plannedS.toFixed(0)} s; tape ${tapeS} s`);

  // Warm up: the joins, the manifest, the first frames, the GPU pipelines.
  await sleep((scenario.warmupS ?? 5) * 1000);
  try { run.statsAtStart = await api(`/match-stats/${MATCH}`); } catch (e) { run.errors.push(`stats at start: ${e}`); }
  writeRun();

  const watchdogS = WATCHDOG_S || tapeS + 240;
  const watchdog = setTimeout(() => { void fail(`watchdog: run exceeded ${watchdogS} s`); }, watchdogS * 1000);

  const stop = { done: false };
  const samplers = [sampleServer(stop)];
  for (const c of clients) {
    samplers.push(sampleClient(c, stop));
    samplers.push(sampleDrawn(c, stop, c.index === 0 ? 10 : 4));
  }
  // Paired tapes on every client: each opens (or joins) the one server capture.
  const recordings = clients.map((c) => {
    const sessionId = `${RUN_ID}-c${c.index}`;
    run.sessions.push({ client: c.index, sessionId });
    return c.page.evaluate(([s, id]) => window.__VIBE_E2E__.recordTape(s, { upload: true, paired: true, sessionId: id }), [tapeS, sessionId])
      .then((header) => ({ client: c.index, header }))
      .catch((e) => ({ client: c.index, error: String(e).slice(0, 300) }));
  });
  for (const c of clients) {
    await c.page.waitForFunction(() => window.__VIBE_E2E__.tapeElapsedMs() !== null, null, { timeout: 15000 })
      .catch(() => fail(`client ${c.index}: the tape did not start`));
  }
  run.recordStartUnixMs = Date.now();
  log('recording');
  const spectators = clients.slice(1).map((c) => spectate(c, stop));

  const destroyed = [];
  for (const [i, step] of plan.entries()) {
    const b = step.building === null ? null : byId.get(step.building);
    if (b) current.building = b;
    const t0 = Date.now();
    const deadline = t0 + step.slotS * 1000;
    let note = '', ok = true;
    try {
      if (!onCity(player.page)) throw new Error(`the player's page left /city: ${player.page.url()}`);
      const work = (async () => {
        switch (step.do) {
          case 'idle': case 'settle': return 'idle';
          case 'walk': return stepWalk(player.page, step, b, deadline);
          case 'cannon': return stepShots(player.page, step, b, deadline, 'cannonball');
          case 'meteorShot': return stepShots(player.page, step, b, deadline, 'meteor');
          case 'meteorAt': return stepMeteorAt(player.page, step, b);
          case 'demolish': destroyed.push(b); return stepDemolish(player.page, step, b);
          case 'drive': return stepDrive(player.page, step, deadline, destroyed.length ? destroyed : order);
          default: throw new Error(`unknown step ${step.do}`);
        }
      })();
      note = await Promise.race([work, sleep(step.slotS * 1000 + 3000).then(() => { throw new Error('step overran its slot by 3 s'); })]);
    } catch (e) {
      ok = false;
      note = String(e?.message ?? e).slice(0, 300);
      run.errors.push(`step ${i} ${step.do}: ${note}`);
      if (/left \/city/.test(note)) { run.phases.push({ i, ...step, startUnixMs: t0, endUnixMs: Date.now(), ok, note }); await fail(note); }
      await player.page.evaluate(() => window.__VIBE_DRIVE__.stop()).catch(() => {});
    }
    const t1 = Date.now();
    if (t1 < deadline) await sleep(deadline - t1);
    const phase = { i, phase: step.phase, do: step.do, building: step.building, slotS: step.slotS, startUnixMs: t0, workEndUnixMs: t1, endUnixMs: Date.now(), ok, note };
    run.phases.push(phase);
    log(`${step.phase} ${step.do}: ${ok ? '' : 'FAILED '}${note}`);
    writeRun();
  }
  const results = await Promise.all(recordings);
  run.recordEndUnixMs = Date.now();
  stop.done = true;
  await Promise.all([...samplers, ...spectators]);
  clearTimeout(watchdog);
  for (const r of results) {
    const session = run.sessions.find((s) => s.client === r.client);
    if (r.error || !r.header) {
      session.error = r.error ?? 'recordTape returned null (tape or pairing failed)';
      run.errors.push(`client ${r.client}: ${session.error}`);
      continue;
    }
    const h = r.header;
    Object.assign(session, {
      uploadFolder: h.uploadFolder, uploadPaired: h.uploadPaired, pairingState: h.pairing?.state,
      durationMs: h.durationMs, packets: h.packets, frames: h.frames, manifestHash: h.manifestHash,
    });
    if (!h.uploadPaired) run.errors.push(`client ${r.client}: tape not paired (${h.pairing?.state} ${h.pairing?.error ?? ''})`);
  }
  try { run.statsAtEnd = await api(`/match-stats/${MATCH}`); } catch (e) { run.errors.push(`stats at end: ${e}`); }
  // Final client counters, once more after the tape.
  run.clientFinal = [];
  for (const c of clients) run.clientFinal.push(await snap(c.page).then((s) => ({ index: c.index, city: s.city, debugStats: s.debugStats })).catch((e) => ({ index: c.index, error: String(e) })));
  const paired = run.sessions.filter((s) => s.uploadPaired).length;
  if (paired === 0) await fail('no client produced a paired session bundle');
  await teardown(run.errors.length ? 'completed-with-errors' : 'ok');
  log(`done: ${paired}/${CLIENTS} paired bundles, ${run.errors.length} errors`);
  process.exit(0);
} catch (e) {
  await fail(`driver error: ${e?.stack ?? e}`);
}
