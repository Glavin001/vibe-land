// Cars drive on whatever they stand on (scripts/native-mac.sh drive --scene
// showcase): ground, a structure's paving, static terrain (a ramp).
// A report (2026-10-05): fleet cars that drove on the open ground stopped
// dead on Bayline's roads, which are destructible paving chunks.
//
// The launcher parks one car per surface (DRIVE_SURFACES below, through
// VIBE_CITY_FLEET_SLOTS); for each, the player is dropped beside it, gets in,
// holds the throttle for four seconds, and the server's car pose says how far
// it went.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[drive] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Fleet slot order: must match VIBE_CITY_FLEET_SLOTS in native-mac.sh drive. */
const SURFACES = ['open ground', 'Bayline road paving', 'up the jump kicker (static terrain)'];
const MIN_METRES = 15;

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 90_000);
  await waitFor('the simulation', () => (e2e.matchStats()?.server_tick ?? 0) >= 120, 180_000);
  const carAt = (index) => JSON.parse(session.vehicleDebug(index)).snapshot?.position;
  const results = [];

  for (let index = 0; index < SURFACES.length; index += 1) {
    const start = carAt(index);
    if (!start) { log(`FAIL  ${SURFACES[index]}: no car ${index}`); results.push(false); continue; }
    e2e.dropAt({ position: [start[0], start[1] + 1.5, start[2] + 3.5], yaw: Math.PI, pitch: -0.2 });
    await sleep(2500);
    drive.interact();
    await waitFor(`the player in car ${index}`, () => e2e.snapshot().drivenVehicleId != null, 5000).catch(() => null);
    const inCar = e2e.snapshot().drivenVehicleId != null;
    const from = carAt(index);
    drive.move({ forward: 1, durationMs: 4000 });
    await sleep(4300);
    const to = carAt(index);
    const metres = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const pass = inCar && metres >= MIN_METRES;
    results.push(pass);
    log(`${pass ? 'PASS' : 'FAIL'}  ${SURFACES[index]}: ${metres.toFixed(1)} m in 4 s (in car: ${inCar}; from ${from.map((v) => v.toFixed(1))} to ${to.map((v) => v.toFixed(1))}; want >= ${MIN_METRES} m)`);
    if (e2e.snapshot().drivenVehicleId != null) { drive.interact(); await sleep(1000); }
  }
  const passed = results.filter(Boolean).length;
  log(`${passed}/${results.length} checks passed`);
  log(`VERDICT ${passed === results.length ? 'PASS' : 'FAIL'}`);
  setTimeout(() => process.exit(0), 300);
}

run().catch((error) => {
  log(`FAIL  harness: ${error?.stack ?? error}`);
  log('VERDICT FAIL');
  setTimeout(() => process.exit(1), 300);
});
