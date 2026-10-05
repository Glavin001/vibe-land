// Native single-player /city smoke test (scripts/native-mac.sh smoke).
//
// Boots the app bundle, waits for the in-process city to load, aims at the
// nearest building and fires, and passes when the city reports broken bonds
// -- the in-process server simulated the hits (PhysX destruction stage) and
// the client received and decoded the result. Exits 0 on pass, 1 on fail.
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
  log(`PASS: ${e2e.snapshot().shotsFired} shots, broken bonds ${before.brokenBonds} -> ${broke.brokenBonds}, awake chunks ${broke.chunksAwake}`);
  await sleep(2000);
  process.exit(0);
}

run().catch((error) => fail(error && (error.stack || error.message || String(error))));
