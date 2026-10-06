// A short film of Vibe Town's Elm Park (RECORD_GPU=1 RECORD_SCRIPT=elm-park-tour
// scripts/native-mac.sh record 120 --scene town): a cinematic camera, no HUD, on
// a timeline -- the approach from the air, a glide down North Street between
// the houses, round a car parked in its driveway, a cannon on one house and a
// meteor on the next, then the pull-back over the park. Logs `[tour] rolling`
// when the first shot starts, so the recording can be trimmed to it.
// Positions: structures/vibe-town/build-town.mjs (streets at z -48, 0, 48;
// lots at x -134 ... -17; the .slots file's driveway cars).

const started = Date.now();
const log = (...args) => console.log(`[tour ${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);

/** Over `ms` of wall time (not a count of steps: a slow frame must not stretch the shot), eased. */
async function over(ms, apply) {
  const begin = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - begin) / ms);
    apply(ease(t));
    if (t >= 1) return;
    await sleep(8);
  }
}

/** Move the camera from one pose to the next. */
const glide = (e2e, from, to, ms) => over(ms, (t) =>
  e2e.setCapturePose({ position: mix(from.position, to.position, t), lookAt: mix(from.lookAt, to.lookAt, t) }));

/** Circle `centre` at `radius` and `height`, from one angle to another (radians), looking at it. */
const orbit = (e2e, centre, radius, height, fromAngle, toAngle, ms) => over(ms, (t) => {
  const a = fromAngle + (toAngle - fromAngle) * t;
  e2e.setCapturePose({
    position: [centre[0] + Math.sin(a) * radius, height, centre[2] + Math.cos(a) * radius],
    lookAt: [centre[0], centre[1], centre[2]],
  });
});

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 120_000);
  await waitFor('the simulation', () => (e2e.matchStats()?.server_tick ?? 0) >= 120);
  await waitFor('the trees', () => e2e.townKit?.().ready || e2e.townKit?.().error, 60_000);
  if (globalThis.__VIBE_NATIVE_HUD__) globalThis.__VIBE_NATIVE_HUD__.visible = false;

  // Settle on the first frame of the film, so the cut starts on it.
  const opening = { position: [-215, 75, -135], lookAt: [-80, 0, -5] };
  e2e.setCapturePose(opening);
  await sleep(2500);
  log('rolling');

  // 1. The approach from the air, swinging north over the park.
  const overPark = { position: [-160, 42, 78], lookAt: [-70, 0, 20] };
  await glide(e2e, opening, overPark, 7000);

  // 2. Down to the street and along North Street (z 48), houses either side.
  const streetStart = { position: [-148, 3.2, 48], lookAt: [-120, 2.6, 48] };
  await glide(e2e, overPark, streetStart, 3000);
  await glide(e2e, streetStart, { position: [-12, 3.2, 47], lookAt: [20, 2.6, 46] }, 9000);

  // 3. Round the car parked in a driveway on Elm Park's north side.
  const car = [-26.3, 0.9, 35];
  await orbit(e2e, car, 7, 2.2, Math.PI * 0.2, Math.PI * 1.15, 6000);

  // 4. A cannon on a house across Main Street, watched from the pavement.
  const house = [-51, 3, 16];
  e2e.dropAt({ position: [-51, 1.2, -2], yaw: 0, pitch: 0 });
  await sleep(600);
  e2e.setShotMode('cannonball');
  const watch = { position: [-36, 3.5, 1], lookAt: [-51, 3, 15] };
  await glide(e2e, { position: [-26, 6, 26], lookAt: car }, watch, 2000);
  const before = e2e.snapshot().city?.brokenBonds ?? 0;
  for (let shot = 0; shot < 5; shot += 1) {
    drive.lookAt(house[0] + (shot - 2) * 1.6, 2 + (shot % 2) * 2, house[2]);
    await sleep(150);
    drive.fire({ holdMs: 60 });
    await sleep(700);
  }
  await sleep(1500);
  log(`cannon: broken bonds ${before} -> ${e2e.snapshot().city?.brokenBonds ?? 0}`);

  // 5. The meteor on the next house along, from further back.
  const target = [-34, 2, 16];
  e2e.setShotMode('meteor');
  await glide(e2e, watch, { position: [-12, 14, -14], lookAt: [-36, 3, 14] }, 1500);
  drive.lookAt(...target);
  await sleep(200);
  drive.fire({ holdMs: 80 });
  await sleep(7000);
  log(`meteor: broken bonds now ${e2e.snapshot().city?.brokenBonds ?? 0}`);
  drive.clear();

  // 6. Pull back over the whole park.
  await glide(e2e, { position: [-12, 14, -14], lookAt: [-36, 3, 14] }, { position: [-70, 70, -120], lookAt: [-72, 0, 5] }, 7000);
  log('cut');
  await sleep(60_000);
}

run().catch((error) => console.error('[tour] FAILED:', error && (error.stack || error.message || String(error))));
