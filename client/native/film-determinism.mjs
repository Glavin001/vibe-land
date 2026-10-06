// One take of a fixed film, for scripts/native-mac.sh film-determinism, which
// runs it twice (VIBE_FILM_LOCKSTEP=1, the same VIBE_MATCH_SEED and film
// seed) and compares the takes.
//
// The take: load at tick 0 (the match in lockstep from its first tick), film
// on at 30 fps, 240 ticks of settle, then a three-shot cannon volley at the
// structure nearest the spawn, and 180 frames for it to fall. It prints what
// the comparison reads, one record per line:
//
//   [film-det] load ...                   what the client had at tick 0
//   [film-det] frame N tick T rnd C D     each film frame: server tick reached,
//                                         Math.random draws so far and digest
//   [film-det] input T p,mx,my,b,yaw,pitch each input frame the match applied
//   [film-det] bonds B                    broken bonds after the volley
//   [film-det] done
//
// Its own checks (PASS/FAIL, VERDICT) cover one take: nothing ticks before
// the film; enable() at tick 0; 2 ticks a frame.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[film-det] ${text}`);
const FPS = 30;
const SEED = typeof FILM_DET_SEED === 'number' ? FILM_DET_SEED : 1; // eslint-disable-line no-undef
const SETTLE_FRAMES = 120; // 240 ticks
const VOLLEY_FRAMES = [10, 40, 70]; // after the settle
const FALL_FRAMES = 180;

async function waitFor(what, predicate, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  const film = await waitFor('the film API', () => globalThis.__VIBE_FILM__);
  const results = [];
  const record = (name, pass, detail) => {
    results.push(pass);
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };

  // Everything a film waits for, with the match standing at tick 0.
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 120_000);
  await sleep(2000);
  const loaded = e2e.snapshot();
  const loadTick = session.currentTick();
  log(`load tick ${loadTick} connected ${loaded.connected} player ${loaded.playerId} chunks ${loaded.city?.chunksTotal} `
    + `position ${loaded.position.map((v) => v.toFixed(2))} vehicles ${loaded.vehicles.length}`);
  record('tick 0', loadTick === 0, `the match is at tick ${loadTick} after the load (VIBE_FILM_LOCKSTEP=1 keeps it at 0)`);

  const ticks = [];
  film.onFrame(() => {});
  film.enable({ fps: FPS, seed: SEED });
  const enabled = film.state();
  record('enable at 0', enabled.startTick === 0, `startTick ${enabled.startTick}, seed ${enabled.seed}`);
  const frameLog = (result) => {
    const state = film.state();
    ticks.push(result.tick);
    log(`frame ${result.frame} tick ${result.tick} rnd ${state.randomCalls} ${state.randomDigest}`);
  };
  for (let i = 0; i < SETTLE_FRAMES; i += 1) frameLog(await film.frame());

  // The volley: the structure nearest the player, three cannonballs.
  const p = e2e.snapshot().position;
  const target = [...e2e.cityStructures()].sort((a, b) =>
    Math.hypot(a.position[0] - p[0], a.position[2] - p[2]) - Math.hypot(b.position[0] - p[0], b.position[2] - p[2])
    || a.structureId - b.structureId)[0];
  log(`player ${p.map((v) => v.toFixed(3))} target ${target?.structureId} at ${target?.position.map((v) => v.toFixed(1))}`);
  e2e.setShotMode('cannonball');
  const unsubscribe = film.onFrame((_t, frame) => {
    const k = frame - SETTLE_FRAMES;
    if (k === 1 && target) drive.lookAt(target.position[0], Math.min(target.top ?? 4, 4), target.position[2]);
    if (VOLLEY_FRAMES.includes(k)) drive.fire({ holdMs: 60 });
  });
  for (let i = 0; i < VOLLEY_FRAMES.at(-1) + FALL_FRAMES; i += 1) frameLog(await film.frame());
  unsubscribe();
  const bonds = e2e.snapshot()?.city?.brokenBonds ?? 0;

  const steps = ticks.map((tick, i) => tick - (i === 0 ? enabled.startTick : ticks[i - 1]));
  record('ticks', steps.every((d) => d === 60 / FPS), `${ticks.length} frames, ${[...new Set(steps)].join('/')} ticks a frame`);

  for (const input of JSON.parse(session.appliedInputs(0))) {
    log(`input ${input.tick} ${input.player},${input.move_x},${input.move_y},${input.buttons},${input.yaw.toFixed(5)},${input.pitch.toFixed(5)}`);
  }
  log(`bonds ${bonds}`);
  film.disable();
  log('done');
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
