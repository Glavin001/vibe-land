// Destruction QA inside the native macOS app (scripts/native-mac.sh qa).
//
// The same checks the browser QA runs against the fleet server, here against
// the app's in-process city:
//
//   city-play (e2e/city-play-qa.mjs)
//     walk          hold forward 3 s; the authoritative position must move > 2 m
//     meteor        the city's meteor on the nearest building: > 5 bonds within 8 s
//     clientMeteor  the player's own meteor shot at another building: > 5 bonds
//                   within 12 s, and the client must have seen the meteor
//   vehicle scenarios (e2e/vehicle-scenarios.mjs, run by the shared engine in
//   e2e/helpers/vehicleQaCore.mjs, so the checks are vehicle-qa's own): parts
//   off, wheels on, and no drawn flicker / rocking / car flicker.
//
// The scenarios run through nativeScenario.mjs, against the in-process
// session (vehicleDebug / meteor / reset) with the browser QA's joins.
//
// Bundled by native-mac.sh with QA_SCENARIOS (comma list; empty = all).
// Prints PASS/FAIL per check and a final `[qa] VERDICT PASS|FAIL` line.
import { scenarios } from '../e2e/vehicle-scenarios.mjs';
import { runNativeScenario } from './nativeScenario.mjs';

/* global QA_SCENARIOS */
const started = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (text) => console.log(`[qa ${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
const results = [];
const record = (group, check, pass, detail) => {
  results.push({ group, check, pass, detail });
  console.log(`[qa] ${pass ? 'PASS' : 'FAIL'}  ${group} ${check}: ${detail}`);
};

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function finish() {
  const failed = results.filter((r) => !r.pass);
  console.log(`[qa] ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`[qa] VERDICT ${failed.length === 0 && results.length > 0 ? 'PASS' : 'FAIL'}`);
  setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 500);
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  const snap = () => e2e.snapshot();
  await waitFor('the city', () => (snap()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  note(`city loaded: ${snap().city.chunksTotal} chunks, ${e2e.cityStructures().length} structures`);
  await sleep(2000);

  const structuresByDistance = () => {
    const p = snap().position;
    return e2e.cityStructures()
      .map((s) => ({ s, d: Math.hypot(s.position[0] - p[0], s.position[2] - p[2]) }))
      .sort((a, b) => a.d - b.d).map((entry) => entry.s);
  };
  const brokenBonds = () => snap().city?.brokenBonds ?? 0;

  const wanted = (typeof QA_SCENARIOS === 'string' ? QA_SCENARIOS : '').split(',').map((s) => s.trim()).filter(Boolean);
  const runs = (name) => wanted.length === 0 || wanted.includes(name);

  // ---- city-play: walk, meteor, the player's meteor ----
  if (runs('city-play')) {
    const before = snap().position;
    drive.look(drive.status().yaw ?? 0, 0);
    drive.move({ forward: 1, durationMs: 3000 });
    await sleep(3500);
    const after = snap().position;
    const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
    record('city-play', 'walk', moved > 2, `${moved.toFixed(2)} m in 3 s`);

    const target = structuresByDistance()[0];
    const centre = [target.position[0], Math.min(target.top, 6), target.position[2]];
    const b0 = brokenBonds();
    session.meteor(...centre);
    await waitFor('bonds after the meteor', () => brokenBonds() > b0 + 5, 8000).catch(() => null);
    record('city-play', 'meteor', brokenBonds() - b0 > 5, `structure ${target.structureId}: bonds ${b0} -> ${brokenBonds()}`);

    const aim = structuresByDistance().find((s) => Math.hypot(s.position[0] - target.position[0], s.position[2] - target.position[2]) > 20)
      ?? structuresByDistance()[1];
    const b2 = brokenBonds();
    e2e.setShotMode('meteor');
    drive.lookAt(aim.position[0], Math.min(aim.top, 4), aim.position[2]);
    await sleep(400);
    drive.fire({ holdMs: 80 });
    let seen = 0;
    await waitFor('bonds after the player meteor', () => {
      seen = Math.max(seen, e2e.meteors?.().length ?? 0);
      return brokenBonds() > b2 + 5;
    }, 12_000).catch(() => null);
    record('city-play', 'clientMeteor', brokenBonds() - b2 > 5 && seen > 0,
      `structure ${aim.structureId}: bonds ${b2} -> ${brokenBonds()}, meteors seen ${seen}`);
  }

  // ---- vehicle scenarios, through vehicle-qa's own engine ----
  for (const [name, scenario] of Object.entries(scenarios)) {
    // Demo scenarios only when named.
    if (!runs(name) || (name.startsWith('demo-') && !wanted.includes(name))) continue;
    note(`scenario ${name}: ${scenario.description}`);
    let checks;
    try {
      checks = await runNativeScenario(scenario, { e2e, drive, session, note, sleep });
    } catch (error) {
      record(name, 'run', false, String(error && (error.message ?? error)));
      continue;
    }
    for (const c of checks) record(name, `car ${c.car} ${c.check}`, c.pass, c.detail);
  }
  finish();
}

run().catch((error) => {
  record('qa', 'run', false, String(error && (error.stack || error.message || error)));
  finish();
});
