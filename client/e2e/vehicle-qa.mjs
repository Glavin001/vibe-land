// Vehicle QA: replay a player's report against the real stack and judge it.
//
// Drives /city in headless Chromium (Metal) against the local server: resets
// the city, joins beside a car, shoots it (rifle or cannonball), drops
// meteors, gets in a car and steers it to a point. The whole time it records,
// per rendered frame, where each car and every loose part is DRAWN
// (__VIBE_VEHICLE_TRACE__ frame.drawnLoose, read back from the instance
// matrices), and after every step what the server holds for each car
// (/city-vehicle-debug). A scenario ends in checks that pass or fail:
//
//   drawnFlicker  loose parts drawn flipping A -> B -> A between frames
//   carFlicker    the car body drawn flipping A -> B -> A
//   partsOff      at least / at most N parts off a car
//   wheelsOn      a car keeps its wheels (server: wheel parts on the carrier)
//
//   cd client && node e2e/vehicle-qa.mjs <scenario> [--video] [--out dir]
//   node e2e/vehicle-qa.mjs --list
//
// Needs the fleet server (scripts/perf/garage-vehicle-server.sh, port 4001)
// and the dev client (npx vite, port 3003). Scenarios: e2e/vehicle-scenarios.mjs.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join as pathJoin, resolve } from 'node:path';
import { scenarios } from './vehicle-scenarios.mjs';

const CLIENT = process.env.QA_CLIENT ?? 'http://localhost:3003';
const SERVER = process.env.QA_SERVER ?? 'http://localhost:4001';
const MATCH = 'city-default';
const FIRST_CAR_ID = 1001;
const args = process.argv.slice(2);
if (args.includes('--list') || !args[0]) {
  for (const [name, s] of Object.entries(scenarios)) console.log(`${name.padEnd(28)} ${s.description}`);
  process.exit(args[0] ? 0 : 2);
}
const name = args[0];
const scenario = scenarios[name];
if (!scenario) { console.error(`unknown scenario ${name}; --list`); process.exit(2); }
const out = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : `../target/vehicle-qa/${name}`);
mkdirSync(out, { recursive: true });
const video = args.includes('--video');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;

// ---- server ----
const api = async (path, body) => {
  const r = await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const carDebug = (car) => api(`/city-vehicle-debug/${MATCH}?car=${car}`);
/** Server truth for one car: pose, heading, loose parts, which parts are off. */
async function carState(car) {
  const d = await carDebug(car);
  const off = new Set(d.hulls.filter((h) => h.actor !== 0).map((h) => h.part));
  const q = d.vehicle2?.rotation ?? [0, 0, 0, 1];
  // Yaw of the car's +z (forward) axis.
  const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
  return { car, handle: d.handle, position: d.snapshot?.position ?? d.vehicle2?.position, heading: Math.atan2(fx, fz),
    speed: Math.hypot(...(d.vehicle2?.linearVelocity ?? [0, 0, 0])), bodies: d.actors.length, partsOff: [...off].sort((a, b) => a - b),
    wheelMask: d.vehicle?.wheelMask };
}

// ---- browser ----
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 },
  ...(video ? { recordVideo: { dir: out, size: { width: 1280, height: 720 } } } : {}) });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.addInitScript((mode) => {
  try { localStorage.setItem('vibe.city.shotMode', mode); } catch {}
  globalThis.__VIBE_VEHICLE_TRACE__ = [];
}, scenario.shotMode ?? 'rifle');

// Per car handle, only what changed: the car's drawn pose, and each loose
// part's drawn position and orientation. Parts at rest cost nothing.
const tracks = {};
const bodyTimeline = []; // dynamic bodies (balls, meteors) as drawn, per drain
let frameCount = 0;
function accumulate(f) {
  const i = frameCount++;
  const t = (tracks[f.id] ??= { frames: 0, maxLoose: 0, car: [], parts: {}, spins: {} });
  t.frames++; t.maxLoose = Math.max(t.maxLoose, f.loose.length);
  if (!t.car.length || dist(t.car.at(-1).p, f.position) > 1e-4) t.car.push({ i, rigTick: f.rigTick, p: f.position });
  for (const [id, p, q] of f.loose) {
    const s = (t.parts[id] ??= []); if (!s.length || dist(s.at(-1).p, p) > 1e-4) s.push({ i, rigTick: f.rigTick, p });
    const r = (t.spins[id] ??= []); if (q && (!r.length || angle(r.at(-1).q, q) > 0.05)) r.push({ i, rigTick: f.rigTick, q });
  }
}
let watchHandles = null; // handles of the scenario's cars, once known
async function drain() {
  for (;;) {
    // Capped batches, rounded in the page: 60 fps x ~1000 loose parts is too
    // much to hand across in one string.
    const batch = await page.evaluate((watch) => {
      const all = globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
      const take = all.splice(0, 240);
      const r = (v, d) => v.map((x) => Math.round(x * d) / d);
      const world = window.__VIBE_E2E__?.drawnWorld?.();
      const bodies = (world?.bodies ?? []).map((b) => ({ id: b.id, p: r(b.position, 100) }));
      return { bodies, rest: all.length, frames: take.filter((x) => x.kind === 'frame').map((x) => ({ t: x.t, id: x.id, rigTick: x.rigTick, position: r(x.position, 1e4), detached: x.detached,
        loose: (!watch || watch.includes(x.id)) ? (x.drawnLoose ?? []).map((p) => [p.id, r(p.position, 1e4), p.rotation ? r(p.rotation, 1e5) : null]) : [] })) };
    }, watchHandles);
    if (batch.bodies.length) bodyTimeline.push({ frame: frameCount, bodies: batch.bodies });
    for (const f of batch.frames) accumulate(f);
    if (batch.rest === 0) break;
  }
}
let draining = true;
const drainer = (async () => { while (draining) { await drain().catch((e) => console.log(`drain: ${e.message}`)); await sleep(100); } })();
const snap = () => page.evaluate(() => window.__VIBE_E2E__?.snapshot());
const drive = (fn, ...a) => page.evaluate(([fn, a]) => window.__VIBE_DRIVE__[fn](...a), [fn, a]);

const log = [];
const note = (text) => { const line = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`; log.push(line); console.log(line); };
const started = Date.now();
const marks = {}; // step label -> frame index at that point

async function join(at) {
  const [x, y, z] = at;
  await page.goto(`${CLIENT}/city?garageVehicle=${'0'.repeat(64)}&garagePosition=${x},${y},${z}`);
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__VIBE_E2E__)); i++) await sleep(500);
  await page.mouse.click(640, 360);
  for (let i = 0; i < 120; i++) {
    const s = await snap().catch(() => null);
    if (s?.connected && s.playerId > 0 && Math.hypot(s.position[0] - x, s.position[2] - z) < 8) break;
    await sleep(500);
  }
  // The debug panel covers a third of the view; the recording is for looking at.
  const panel = page.locator('[data-testid="city-reset"]');
  if (await panel.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
    await page.keyboard.press('F9');
    await panel.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  }
  const s = await snap();
  note(`joined as player ${s.playerId} at ${s.position.map((v) => v.toFixed(1))}`);
}

async function steerTo(car, target, { maxMs = 15000, speed = 8, arrive = 3 } = {}) {
  const t0 = Date.now();
  let st = await carState(car);
  while (Date.now() - t0 < maxMs) {
    st = await carState(car);
    const dx = target[0] - st.position[0], dz = target[2] - st.position[2];
    if (Math.hypot(dx, dz) < arrive) break;
    let err = Math.atan2(dx, dz) - st.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    // +strafe steers right; heading grows toward +x from +z, i.e. to the car's left.
    const steer = Math.max(-1, Math.min(1, -err * 2));
    const forward = st.speed < speed ? 1 : 0;
    await drive('move', { forward, strafe: steer, durationMs: 200 });
    await sleep(100);
  }
  await drive('move', { forward: 0, strafe: 0, durationMs: 50 });
  return st;
}

const results = {};
try {
  // The city match starts with its first player: join once so there is one.
  if (!(await carDebug(0).then(() => true, () => false))) {
    await join([55, 1, 0]);
    for (let i = 0; i < 60 && !(await carDebug(0).then(() => true, () => false)); i++) await sleep(500);
  }
  let stepIndex = 0;
  watchHandles = (await Promise.all((scenario.cars ?? []).map((c) => carState(c)))).map((st) => st.handle);
  for (const step of scenario.steps) {
    marks[step.label ?? JSON.stringify(step).slice(0, 40)] = frameCount;
    if (step.resetCity) {
      await api(`/city-reset/${MATCH}`, {});
      await sleep(3000);
      note('city reset');
    } else if (step.joinBeside !== undefined) {
      const st = await carState(step.joinBeside);
      const [x, , z] = st.position;
      const off = step.offset ?? [0, 0, -12];
      await join([x + off[0], 1, z + off[2]]);
    } else if (step.aimAt !== undefined) {
      const st = await carState(step.aimAt);
      await drive('lookAt', st.position[0], st.position[1] + (step.up ?? 0.5), st.position[2]);
      await sleep(200);
    } else if (step.fire) {
      const { count = 1, intervalMs = 600, reaim } = step.fire;
      for (let i = 0; i < count; i++) {
        if (reaim !== undefined) { const st = await carState(reaim); await drive('lookAt', st.position[0], st.position[1] + 0.5, st.position[2]); }
        await drive('fire', { holdMs: 60 });
        await sleep(intervalMs);
      }
      note(`fired ${count}`);
    } else if (step.meteor !== undefined) {
      const st = await carState(step.meteor);
      await api(`/city-meteor/${MATCH}`, { x: st.position[0], y: st.position[1], z: st.position[2] });
      note(`meteor on car ${step.meteor}`);
    } else if (step.enter !== undefined) {
      await drive('interact');
      await sleep(800);
      const s = await snap();
      note(`driving vehicle ${s.drivenVehicleId}`);
      if (s.drivenVehicleId == null) throw new Error('could not enter the car');
    } else if (step.driveTo) {
      const target = typeof step.driveTo.to === 'number' ? (await carState(step.driveTo.to)).position : step.driveTo.to;
      const st = await steerTo(step.driveTo.car, target, step.driveTo);
      note(`drove car ${step.driveTo.car} to ${st.position.map((v) => v.toFixed(1))} at ${st.speed.toFixed(1)} m/s`);
    } else if (step.wait) {
      await sleep(step.wait);
    }
    if (step.label) results[step.label] = await Promise.all((scenario.cars ?? []).map(carState));
    // A picture per step: where the camera is looking is part of the result.
    await page.screenshot({ path: pathJoin(out, `step-${String(stepIndex++).padStart(2, '0')}.jpg`), quality: 70 }).catch(() => {});
  }
  await sleep(scenario.settleMs ?? 1500);
} finally {
  draining = false;
  await drainer;
  await drain().catch(() => {});
}
const final = await Promise.all((scenario.cars ?? [0, 1, 2, 3, 4]).map(carState));
await context.close();
await browser.close();
if (video) {
  const webm = readdirSync(out).find((f) => f.endsWith('.webm'));
  if (webm) renameSync(pathJoin(out, webm), pathJoin(out, 'run.webm'));
}

// ---- analysis ----
/** A -> B -> A among distinct drawn positions: the part is shown in two places. */
function flips(series, min = 0.2) {
  let count = 0, worst = 0, example = null;
  for (let k = 1; k + 1 < series.length; k++) {
    const out = dist(series[k - 1].p, series[k].p), back = dist(series[k - 1].p, series[k + 1].p);
    if (out > min && back < out * 0.3) { count++; if (out > worst) { worst = out; example = series.slice(k - 1, k + 2).map((s) => ({ frame: s.i, rigTick: s.rigTick, p: s.p.map((v) => +v.toFixed(2)) })); } }
  }
  return { count, worst: +worst.toFixed(2), example };
}
const analysis = {};
for (const [handle, t] of Object.entries(tracks)) {
  let partFlips = 0, flipParts = 0, worst = 0, example = null;
  for (const [id, s] of Object.entries(t.parts)) { const r = flips(s); if (r.count) { partFlips += r.count; flipParts++; if (r.worst > worst) { worst = r.worst; example = { part: id, ...r.example }; } } }
  // Turning back and forth between two orientations: drawn in two places.
  // A part that flips three or more times is rocking between two
  // orientations (what a player sees as a phantom); one flip is a fast
  // tumble caught between frames.
  let spinFlips = 0, spinParts = 0, spinWorst = 0, spinExample = null, rocking = 0, rockingFlips = 0;
  const rockingDetail = [];
  for (const [id, r] of Object.entries(t.spins)) {
    let n = 0;
    for (let k = 1; k + 1 < r.length; k++) {
      const out = angle(r[k - 1].q, r[k].q), back = angle(r[k - 1].q, r[k + 1].q);
      if (out > 10 && back < out * 0.3) { n++; if (out > spinWorst) { spinWorst = out; spinExample = { part: id, frames: [r[k - 1].i, r[k].i, r[k + 1].i], rigTicks: [r[k - 1].rigTick, r[k].rigTick, r[k + 1].rigTick], degrees: [+out.toFixed(1), +back.toFixed(1)] }; } }
    }
    if (n) { spinFlips += n; spinParts++; }
    if (n >= 3) {
      rocking++; rockingFlips += n;
      // Where it rocked, and the nearest loose body (a ball) at that frame.
      const at = r.find((x, k) => k > 0 && angle(r[k - 1].q, x.q) > 10);
      const pos = t.parts[id]?.find((x) => x.i >= (at?.i ?? 0))?.p ?? t.parts[id]?.at(-1)?.p;
      const near = bodyTimeline.filter((b) => b.frame <= (at?.i ?? 0)).at(-1);
      const nearest = pos && near ? near.bodies.map((b) => ({ id: b.id, m: +dist(b.p, pos).toFixed(2) })).sort((a, b) => a.m - b.m)[0] : null;
      rockingDetail.push({ part: id, flips: n, rigTicks: [r[0].rigTick, r.at(-1).rigTick], position: pos, nearestBody: nearest });
    }
  }
  analysis[handle] = { frames: t.frames, maxLooseDrawn: t.maxLoose, car: flips(t.car, 0.1),
    loose: { parts: Object.keys(t.parts).length, flips: partFlips, flipParts, worst, example },
    spin: { flips: spinFlips, parts: spinParts, rockingParts: rocking, rockingFlips, rocking: rockingDetail, worstDegrees: +spinWorst.toFixed(1), example: spinExample } };
}

const checks = [];
for (const c of scenario.checks ?? []) {
  const st = final.find((s) => s.car === c.car);
  const a = st ? analysis[st.handle] : null;
  let pass, detail;
  if (c.drawnFlicker) {
    const flipsSeen = a?.loose.flips ?? 0;
    pass = flipsSeen <= c.drawnFlicker.max; detail = `${flipsSeen} loose-part flips (max ${c.drawnFlicker.max}), worst ${a?.loose.worst ?? 0} m over ${a?.loose.parts ?? 0} parts`;
  } else if (c.spinFlicker) {
    const n = a?.spin.rockingParts ?? 0; pass = n <= c.spinFlicker.max;
    detail = `${n} loose parts rocking between two orientations (>=3 flips over 10°; max ${c.spinFlicker.max}), ${a?.spin.rockingFlips ?? 0} flips; all flips ${a?.spin.flips ?? 0} on ${a?.spin.parts ?? 0} parts, worst ${a?.spin.worstDegrees ?? 0}°`;
  } else if (c.carFlicker) {
    const n = a?.car.count ?? 0; pass = n <= c.carFlicker.max; detail = `${n} car-body flips (max ${c.carFlicker.max}), worst ${a?.car.worst ?? 0} m`;
  } else if (c.partsOff) {
    const n = st.partsOff.length; pass = (c.partsOff.min ?? 0) <= n && n <= (c.partsOff.max ?? Infinity); detail = `${n} parts off (want ${c.partsOff.min ?? 0}..${c.partsOff.max ?? '∞'})`;
  } else if (c.wheelsOn) {
    pass = st.wheelMask === 15; detail = `wheel mask ${st.wheelMask?.toString(2).padStart(4, '0')} (1111 = all four on the car)`;
  }
  checks.push({ car: c.car, check: Object.keys(c).find((k) => k !== 'car'), pass, detail });
}
const report = { scenario: name, description: scenario.description, checks, final, analysis, log, errors, marks, frames: frameCount };
writeFileSync(pathJoin(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(`\n${name}: ${frameCount} frames recorded${video ? `, video ${pathJoin(out, 'run.webm')}` : ''}`);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  car ${c.car} ${c.check}: ${c.detail}`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.log(`report ${pathJoin(out, 'report.json')}`);
process.exit(checks.every((c) => c.pass) ? 0 : 1);
