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
import { carStateFromDebug, createTraceAnalyzer, evaluateChecks, frameFromTrace, joinDropPose, runScenario } from './helpers/vehicleQaCore.mjs';

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

// ---- server ----
const api = async (path, body) => {
  const r = await fetch(`${SERVER}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
};
const carDebug = (car) => api(`/city-vehicle-debug/${MATCH}?car=${car}`);
/** Server truth for one car (helpers/vehicleQaCore.mjs carStateFromDebug). */
const carState = async (car) => carStateFromDebug(car, await carDebug(car));

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

// Flip detection, analysis and checks: helpers/vehicleQaCore.mjs, shared with
// the native app's runner.
const analyzer = createTraceAnalyzer();
const bodyTimeline = []; // dynamic bodies (balls, meteors) as drawn, per drain; kept short
const accumulate = (f) => analyzer.accumulate(f);
let watchHandles = null; // handles of the scenario's cars, once known
async function drain() {
  for (;;) {
    // Capped batches, rounded in the page: 60 fps x ~1000 loose parts is too
    // much to hand across in one string.
    const batch = await page.evaluate(([watch, frameSource]) => {
      const all = globalThis.__VIBE_VEHICLE_TRACE_DONE__ ?? globalThis.__VIBE_VEHICLE_TRACE__ ?? [];
      const take = all.splice(0, 240);
      // Only what changed since the last sample crosses over: the trackers
      // skip unchanged samples anyway, and ~2000 resting parts a frame would
      // otherwise outrun the drain (and the page's 20000-entry trace cap
      // then drops frames). The mapping is the core's frameFromTrace.
      const last = (globalThis.__VIBE_QA_LAST__ ??= new Map());
      const changed = (key, v) => { const k = v.join(','); if (last.get(key) === k) return false; last.set(key, k); return true; };
      const frameFromTrace = (0, eval)(`(${frameSource})`);
      const r = (v, d) => v.map((x) => Math.round(x * d) / d);
      const world = window.__VIBE_E2E__?.drawnWorld?.();
      const bodies = (world?.bodies ?? []).map((b) => ({ id: b.id, p: r(b.position, 100) }));
      return { bodies, rest: all.length, frames: take.filter((x) => x.kind === 'frame').map((x) => frameFromTrace(x, watch, changed)) };
    }, [watchHandles, frameFromTrace.toString()]);
    if (batch.bodies.length) { bodyTimeline.push({ frame: analyzer.frameCount, bodies: batch.bodies }); if (bodyTimeline.length > 400) bodyTimeline.shift(); }
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

async function join(at) {
  const [x, y, z] = at;
  // A fresh page, then the city camera drop at the join point (the native
  // QA joins with the same drop).
  await page.goto(`${CLIENT}/city`);
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__VIBE_E2E__)); i++) await sleep(500);
  await page.mouse.click(640, 360);
  for (let i = 0; i < 120; i++) {
    const s = await snap().catch(() => null);
    if (s?.connected && s.playerId > 0) break;
    await sleep(500);
  }
  await page.evaluate((pose) => window.__VIBE_E2E__.dropAt(pose), joinDropPose(at));
  for (let i = 0; i < 40; i++) {
    const s = await snap().catch(() => null);
    if (s && Math.hypot(s.position[0] - x, s.position[2] - z) < 3) break;
    await sleep(250);
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

let marks = {};
try {
  // The city match starts with its first player: join once so there is one.
  if (!(await carDebug(0).then(() => true, () => false))) {
    await join([55, 1, 0]);
    for (let i = 0; i < 60 && !(await carDebug(0).then(() => true, () => false)); i++) await sleep(500);
  }
  watchHandles = (await Promise.all((scenario.cars ?? []).map((c) => carState(c)))).map((st) => st.handle);
  ({ marks } = await runScenario(scenario, {
    carState,
    reset: () => api(`/city-reset/${MATCH}`, {}),
    join,
    meteor: ([x, y, z]) => api(`/city-meteor/${MATCH}`, { x, y, z }),
    drive,
    snap,
    note,
    sleep,
    // A picture per step: where the camera is looking is part of the result.
    afterStep: (index) => page.screenshot({ path: pathJoin(out, `step-${String(index).padStart(2, '0')}.jpg`), quality: 70 }).catch(() => {}),
  }, () => analyzer.frameCount));
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
const analysis = analyzer.analyze();
const checks = evaluateChecks(scenario, final, analysis);
const report = { scenario: name, description: scenario.description, checks, final, analysis, log, errors, marks, frames: analyzer.frameCount };
writeFileSync(pathJoin(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(`\n${name}: ${analyzer.frameCount} frames recorded${video ? `, video ${pathJoin(out, 'run.webm')}` : ''}`);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  car ${c.car} ${c.check}: ${c.detail}`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.log(`report ${pathJoin(out, 'report.json')}`);
process.exit(checks.every((c) => c.pass) ? 0 : 1);
