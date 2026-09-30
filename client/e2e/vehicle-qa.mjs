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
//                 (the part's drawn geometry centre, not its origin)
//   spinFlicker   loose parts rocking between two orientations
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

// Flip detection online, per car handle: each series keeps only its last two
// distinct samples, so memory is O(parts) however long the run. A flip is
// A -> B -> A among distinct samples: out = |A-B| over `min`, back = |A-C|
// under 30% of it.
function tracker(measure, min) {
  return { a: null, b: null, count: 0, worst: 0, example: null, measure, min,
    push(sample) {
      if (this.b && this.measure(this.b.v, sample.v) < 1e-4) return; // unchanged
      if (this.a && this.b) {
        const out = this.measure(this.a.v, this.b.v), back = this.measure(this.a.v, sample.v);
        if (out > this.min && back < out * 0.3) {
          this.count++; this.first ??= sample.i; this.last = sample.i;
          if (out > this.worst) { this.worst = out; this.example = [this.a, this.b, sample].map((x) => ({ frame: x.i, rigTick: x.rigTick, v: x.v.map((n) => +n.toFixed(3)) })); }
        }
      }
      this.a = this.b; this.b = sample;
    } };
}
const tracks = {};
const bodyTimeline = []; // dynamic bodies (balls, meteors) as drawn, per drain; kept short
let frameCount = 0;
function accumulate(f) {
  const i = frameCount++;
  const t = (tracks[f.id] ??= { frames: 0, maxLoose: 0, car: tracker(dist, 0.1), parts: {}, spins: {}, received: {}, where: {} });
  t.frames++;
  t.car.push({ i, rigTick: f.rigTick, v: f.position });
  for (const [id, p, q] of f.loose) {
    (t.parts[id] ??= tracker(dist, 0.2)).push({ i, rigTick: f.rigTick, v: p });
    if (q) (t.spins[id] ??= tracker(angle, 10)).push({ i, rigTick: f.rigTick, v: q });
    t.where[id] = p;
  }
  // What the client RECEIVED for each detached group (server truth on the
  // wire), so a flip can be placed on the server or in the renderer.
  for (const [part, q] of f.received ?? []) (t.received[part] ??= tracker(angle, 10)).push({ i, rigTick: f.rigTick, v: q });
}
let watchHandles = null; // handles of the scenario's cars, once known
async function drain() {
  for (;;) {
    // Capped batches, rounded in the page: 60 fps x ~1000 loose parts is too
    // much to hand across in one string.
    const batch = await page.evaluate((watch) => {
      const all = globalThis.__VIBE_VEHICLE_TRACE_DONE__ ?? globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
      const take = all.splice(0, 240);
      const r = (v, d) => v.map((x) => Math.round(x * d) / d);
      // Only what changed since the last sample crosses over: the trackers
      // skip unchanged samples anyway, and ~2000 resting parts a frame would
      // otherwise outrun the drain (and the page's 20000-entry trace cap
      // then drops frames).
      const last = (globalThis.__VIBE_QA_LAST__ ??= new Map());
      const changed = (key, v) => { const k = v.join(','); if (last.get(key) === k) return false; last.set(key, k); return true; };
      const world = window.__VIBE_E2E__?.drawnWorld?.();
      const bodies = (world?.bodies ?? []).map((b) => ({ id: b.id, p: r(b.position, 100) }));
      return { bodies, rest: all.length, frames: take.filter((x) => x.kind === 'frame').map((x) => ({ t: x.t, id: x.id, rigTick: x.rigTick, position: r(x.position, 1e4), detached: x.detached,
        loose: (!watch || watch.includes(x.id)) ? (x.drawnLoose ?? []).map((p) => [p.id, r(p.center ?? p.position, 1e4), p.rotation ? r(p.rotation, 1e5) : null])
          .filter(([id, p, q]) => changed(`${x.id}/${id}`, q ? [...p, ...q] : p)) : [],
        received: (!watch || watch.includes(x.id)) ? (x.rigDetached ?? []).filter((d) => d.rotation).map((d) => [d.part, r(d.rotation, 1e5)])
          .filter(([part, q]) => changed(`${x.id}#${part}`, q)) : [] })) };
    }, watchHandles);
    if (batch.bodies.length) { bodyTimeline.push({ frame: frameCount, bodies: batch.bodies }); if (bodyTimeline.length > 400) bodyTimeline.shift(); }
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
  // So does the controls overlay; minimise it.
  await page.getByRole('button', { name: 'Minimize controls overlay' }).click({ timeout: 2000 }).catch(() => {});
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
    } else if (step.joinAt) {
      await join(step.joinAt);
    } else if (step.lookAtPoint) {
      await drive('lookAt', ...step.lookAtPoint);
      await sleep(200);
    } else if (step.aimAt !== undefined) {
      const st = await carState(step.aimAt);
      await drive('lookAt', st.position[0], st.position[1] + (step.up ?? 0.5), st.position[2]);
      await sleep(200);
    } else if (step.fire) {
      const { count = 1, intervalMs = 600, reaim, at } = step.fire;
      for (let i = 0; i < count; i++) {
        if (reaim !== undefined) { const st = await carState(reaim); await drive('lookAt', st.position[0], st.position[1] + 0.5, st.position[2]); }
        if (at) await drive('lookAt', ...at);
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
  // Stop the page recording before the last drain: a page that traces faster
  // than it is drained (two wrecks, ~2000 loose parts a frame) never empties.
  await page.evaluate(() => { globalThis.__VIBE_VEHICLE_TRACE_DONE__ = globalThis.__VIBE_VEHICLE_TRACE__ ?? []; globalThis.__VIBE_VEHICLE_TRACE__ = undefined; }).catch(() => {});
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
const analysis = {};
for (const [handle, t] of Object.entries(tracks)) {
  let partFlips = 0, flipParts = 0, worst = 0, example = null;
  for (const [id, tr] of Object.entries(t.parts)) if (tr.count) { partFlips += tr.count; flipParts++; if (tr.worst > worst) { worst = tr.worst; example = { part: id, samples: tr.example }; } }
  // A part that flips three or more times is rocking between two
  // orientations (what a player sees as a phantom); one flip is a fast
  // tumble caught between frames.
  let spinFlips = 0, spinParts = 0, spinWorst = 0, spinExample = null, rocking = 0, rockingFlips = 0;
  const rockingDetail = [];
  for (const [id, tr] of Object.entries(t.spins)) {
    if (!tr.count) continue;
    spinFlips += tr.count; spinParts++;
    if (tr.worst > spinWorst) { spinWorst = tr.worst; spinExample = { part: id, samples: tr.example }; }
    if (tr.count >= 3) { rocking++; rockingFlips += tr.count; rockingDetail.push({ part: id, flips: tr.count, worstDegrees: +tr.worst.toFixed(1), frames: [tr.first, tr.last], position: t.where[id] }); }
  }
  const received = Object.entries(t.received).filter(([, tr]) => tr.count >= 3)
    .map(([part, tr]) => ({ part: +part, flips: tr.count, worstDegrees: +tr.worst.toFixed(1), frames: [tr.first, tr.last] })).sort((a, b) => b.flips - a.flips);
  analysis[handle] = { frames: t.frames, maxLooseDrawn: Object.keys(t.parts).length,
    receivedSpin: { groups: Object.keys(t.received).length, rockingGroups: received.length, rockingFlips: received.reduce((n, r) => n + r.flips, 0), rocking: received.slice(0, 30) },
    car: { count: t.car.count, worst: +t.car.worst.toFixed(2), example: t.car.example },
    loose: { parts: Object.keys(t.parts).length, flips: partFlips, flipParts, worst: +worst.toFixed(2), example },
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
