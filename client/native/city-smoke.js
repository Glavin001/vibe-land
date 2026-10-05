// Native single-player /city smoke test (scripts/native-mac.sh smoke).
//
// Boots the app bundle, waits for the in-process city to load, shoots the
// nearest building, then walks to the nearest destructible fleet car and
// shoots that, and passes when both report broken bonds -- the in-process
// server simulated the hits (PhysX destruction stage) and the client received
// and decoded the result. Exits 0 on pass, 1 on fail.
const TIMEOUT_MS = 180_000;
const started = Date.now();
const log = (...args) => console.log('[smoke]', ...args);
const fail = (reason) => { console.error('[smoke] FAIL:', reason); process.exit(1); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate) {
  while (Date.now() - started < TIMEOUT_MS) {
    const value = predicate();
    if (value) return value;
    await sleep(250);
  }
  fail(`timed out waiting for ${what}`);
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);

  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  await waitFor('the city', () => {
    const city = e2e.snapshot()?.city;
    return city && city.chunksTotal > 0 && e2e.cityStructures().length > 0;
  });
  const before = e2e.snapshot().city;
  log(`city loaded in ${((Date.now() - started) / 1000).toFixed(1)}s: ${before.chunksTotal} chunks, ${e2e.cityStructures().length} structures, ${before.brokenBonds} broken bonds`);

  const local = e2e.snapshot().position;
  const target = e2e.cityStructures()
    .map((s) => ({ s, d: Math.hypot(s.position[0] - local[0], s.position[2] - local[2]) }))
    .sort((a, b) => a.d - b.d)[0].s;
  const aim = [target.position[0], Math.min(target.top, local[1] + 2), target.position[2]];
  log(`aiming at structure ${target.structureId} (${target.chunks} chunks) at ${aim.map((v) => v.toFixed(1)).join(', ')}`);
  drive.lookAt(aim[0], aim[1], aim[2]);
  await sleep(500);
  for (let shot = 0; shot < 20; shot += 1) {
    drive.lookAt(aim[0], aim[1], aim[2]);
    drive.fire({ holdMs: 80 });
    await sleep(250);
  }
  const broke = await waitFor('broken bonds after firing', () => {
    const city = e2e.snapshot().city;
    return city && city.brokenBonds > before.brokenBonds ? city : null;
  });
  log(`buildings: ${e2e.snapshot().shotsFired} shots, broken bonds ${before.brokenBonds} -> ${broke.brokenBonds}`);

  // The destructible fleet, as client/e2e/vehicle-qa.mjs's cannonball-wreck
  // checks it: beside a fleet car, four cannonballs 1.5 s apart, and at
  // least five parts must come off. Parts off are what the client received
  // (the car's rig, detached parts), from the renderer's vehicle trace.
  globalThis.__VIBE_VEHICLE_TRACE__ = [];
  e2e.setShotMode('cannonball');
  const vehicles = e2e.snapshot().vehicles ?? [];
  if (vehicles.length === 0) fail('no vehicles in the city');
  const me = e2e.snapshot().position;
  const car = vehicles
    .map((v) => ({ v, d: Math.hypot(v.position[0] - me[0], v.position[2] - me[2]) }))
    .sort((a, b) => a.d - b.d)[0].v;
  log(`walking to car ${car.id} at ${car.position.map((v) => v.toFixed(1)).join(', ')}`);
  for (let step = 0; step < 120; step += 1) {
    const here = e2e.snapshot().position;
    const target = (e2e.snapshot().vehicles ?? []).find((v) => v.id === car.id) ?? car;
    if (Math.hypot(target.position[0] - here[0], target.position[2] - here[2]) < 12) break;
    drive.lookAt(target.position[0], here[1], target.position[2]);
    drive.setSprint(true);
    drive.move({ forward: 1, durationMs: 200 });
    await sleep(150);
  }
  drive.stop();
  drive.setSprint(false);
  await sleep(500);
  const carFrames = () => globalThis.__VIBE_VEHICLE_TRACE__.filter((f) => f.kind === 'frame' && f.id === car.id);
  const latest = () => carFrames().at(-1);
  if (!latest()) fail(`car ${car.id} is not a destructible fleet car (no rig frames)`);
  log(`car ${car.id}: fracture groups ${latest().fractureGroups ? 'loaded' : 'missing'}, ${latest().detached} parts off`);
  for (let shot = 0; shot < 4; shot += 1) {
    const target = (e2e.snapshot().vehicles ?? []).find((v) => v.id === car.id) ?? car;
    drive.lookAt(target.position[0], target.position[1] + 0.5, target.position[2]);
    await sleep(100);
    drive.fire({ holdMs: 80 });
    await sleep(1500);
  }
  await sleep(4000);
  const after = latest();
  log(`car ${car.id} after 4 cannonballs: ${after.detached} parts off, ${after.drawnLoose?.length ?? 0} drawn loose`);
  if (after.detached < 5) fail(`car ${car.id}: ${after.detached} parts off, want >= 5`);
  log(`PASS: buildings ${before.brokenBonds} -> ${broke.brokenBonds} bonds; car ${car.id} lost ${after.detached} parts`);
  await sleep(2000);
  process.exit(0);
}

run().catch((error) => fail(error && (error.stack || error.message || String(error))));
