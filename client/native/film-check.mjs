// Film mode (client/src/native/film.ts, scripts/native-mac.sh film-check):
// frame-locked offline rendering. Enables film mode at 30 fps and checks
//
//   ticks     the in-process match advances exactly 2 ticks per film frame
//             (120 frames), and only with frames: over half a second of wall
//             time mid-film, ticks = 2 x frames
//   clock     performance.now() advances exactly 1000/30 ms per frame
//   r3f       R3F's clock and useFrame deltas advance exactly 1/30 s per
//             frame, useFrame runs once per frame, and the game renders as
//             many passes per frame as in real time
//   frame()   resolves once per frame, frames numbered 1, 2, 3, ...
//   onFrame   runs once per frame, before the frame's sim step
//   input     a scripted walk (__VIBE_DRIVE__.move, 1 film second) moves the
//             player, and a cannon shot fired in film breaks bonds
//   disable   back to real time: ticks resume at ~60/s and performance.now()
//             follows the wall clock, continuously
//
// Prints one PASS/FAIL line per check and a VERDICT.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[film-check] ${text}`);
const FPS = 30;
const FRAMES = 120;

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
};

async function run() {
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const drive = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  const film = await waitFor('the film API', () => globalThis.__VIBE_FILM__);
  const store = await waitFor('the R3F store', () => globalThis.__VIBE_NATIVE_STORE__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 90_000);
  await waitFor('the simulation', () => session.currentTick() >= 120, 180_000);
  await sleep(2500);
  const results = [];
  const record = (name, pass, detail) => {
    results.push(pass);
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };

  // Real time before: the match's own rate.
  const rateOver = async (ms) => {
    const t0 = session.currentTick();
    const w0 = Date.now();
    await sleep(ms);
    return ((session.currentTick() - t0) * 1000) / (Date.now() - w0);
  };
  const before = await rateOver(1000);
  log(`real time before: ${before.toFixed(1)} ticks/s`);

  // The game's frames, as a useFrame subscriber sees them (priority 0 keeps
  // R3F's own render), and its render passes (gl.render calls).
  const gl = store.getState().gl;
  const render = gl.render;
  let renders = 0;
  gl.render = function (...args) { renders += 1; return render.apply(this, args); };
  let useFrames = 0;
  const useFrameDeltas = [];
  const unsubscribeR3f = store.getState().internal.subscribe(
    { current: (_state, delta) => { useFrames += 1; useFrameDeltas.push(delta); } }, 0, store);
  const [r0, u0] = [renders, useFrames];
  await sleep(1000);
  const passesPerFrame = (renders - r0) / Math.max(1, useFrames - u0);
  log(`real time: ${useFrames - u0} frames, ${passesPerFrame.toFixed(2)} render passes a frame`);
  useFrameDeltas.length = 0;

  // Aim the cannon at the nearest structure, to fire it in film.
  const bonds = () => e2e.snapshot()?.city?.brokenBonds ?? 0;
  const p0 = e2e.snapshot().position;
  const target = [...e2e.cityStructures()].sort((a, b) =>
    Math.hypot(a.position[0] - p0[0], a.position[2] - p0[2]) - Math.hypot(b.position[0] - p0[0], b.position[2] - p0[2]))[0];
  e2e.setShotMode('cannonball');

  // Film: per frame, what onFrame saw and what frame() resolved with.
  const seen = [];
  let onFrameTick = null;
  const unsubscribe = film.onFrame((t, frame) => {
    onFrameTick = session.currentTick();
    seen.push({ t, frame, now: performance.now(), tickAtStart: onFrameTick, rendersAtStart: renders,
      useFramesAtStart: useFrames, deltasAtStart: useFrameDeltas.length, wall: Date.now() });
    if (frame === 1 && target) drive.lookAt(target.position[0], Math.min(target.top ?? 4, 4), target.position[2]);
    if (frame === 5) drive.fire({ holdMs: 60 });
  });
  film.enable({ fps: FPS });
  const enabledTick = session.currentTick();
  const resolved = [];
  const clockAt = [];
  // The film's first frame, then FRAMES more measured ones.
  for (let i = 0; i <= FRAMES; i += 1) {
    const result = await film.frame();
    resolved.push(result);
    clockAt.push(store.getState().clock.elapsedTime);
  }
  const bondsBeforeIdle = bonds();
  // Frames run on while the script waits; the sim moves only with them.
  const idleFrom = [session.currentTick(), film.state().frame];
  await sleep(500);
  const idleTo = [session.currentTick(), film.state().frame];
  const idleTicks = idleTo[0] - idleFrom[0];
  const idleFrames = idleTo[1] - idleFrom[1];

  // A walk in film time: one film second of W.
  const from = e2e.snapshot().position;
  drive.clear();
  drive.move({ forward: 1, durationMs: 1000 });
  for (let i = 0; i < FPS + 10; i += 1) await film.frame();
  const to = e2e.snapshot().position;
  const walked = Math.hypot(to[0] - from[0], to[2] - from[2]);
  // The shot has had ~5 film seconds by now? give it a few more.
  for (let i = 0; i < FPS * 2; i += 1) await film.frame();
  const brokenInFilm = bonds();
  unsubscribe();
  const lastFilmNow = performance.now();
  const filmState = film.state();
  film.disable();

  // ticks: exactly 2 per frame, the first film frame included.
  const tickSteps = resolved.map((r, i) => r.tick - (i === 0 ? enabledTick : resolved[i - 1].tick));
  const badTicks = tickSteps.filter((d) => d !== 60 / FPS);
  record('ticks', badTicks.length === 0 && resolved.at(-1).tick - enabledTick === (FRAMES + 1) * (60 / FPS),
    `${FRAMES + 1} frames advanced ${resolved.at(-1).tick - enabledTick} ticks (${[...new Set(tickSteps)].join('/')} per frame; want ${60 / FPS})`);
  // onFrame runs before the frame's step: the tick it sees is the previous frame's.
  const preStep = seen.slice(0, FRAMES + 1).every((s, i) => s.tickAtStart === (i === 0 ? enabledTick : resolved[i - 1].tick));
  record('lockstep', idleTicks === idleFrames * (60 / FPS) && preStep,
    `${idleTicks} ticks over ${idleFrames} frames in 500 ms of wall time; onFrame before the step: ${preStep}`);

  const nowSteps = seen.slice(1, FRAMES + 1).map((s, i) => s.now - seen[i].now);
  const nowErr = Math.max(...nowSteps.map((d) => Math.abs(d - 1000 / FPS)));
  record('clock', nowErr < 1e-6, `performance.now() steps ${quantile(nowSteps, 0).toFixed(6)}..${quantile(nowSteps, 1).toFixed(6)} ms (want ${(1000 / FPS).toFixed(6)}, max error ${nowErr.toExponential(1)})`);

  const clockSteps = clockAt.slice(1).map((v, i) => v - clockAt[i]);
  const clockErr = Math.max(...clockSteps.map((d) => Math.abs(d - 1 / FPS)));
  const rendersPerFrame = seen.slice(1, FRAMES + 1).map((s, i) => s.rendersAtStart - seen[i].rendersAtStart);
  const useFramesPerFrame = seen.slice(1, FRAMES + 1).map((s, i) => s.useFramesAtStart - seen[i].useFramesAtStart);
  const deltas = useFrameDeltas.slice(seen[1].deltasAtStart, seen[FRAMES].deltasAtStart);
  const deltaErr = Math.max(...deltas.map((d) => Math.abs(d - 1 / FPS)));
  const passesSame = rendersPerFrame.every((n) => n === Math.round(passesPerFrame));
  record('r3f', clockErr < 1e-6 && deltaErr < 1e-6 && useFramesPerFrame.every((n) => n === 1) && passesSame,
    `R3F clock steps ${quantile(clockSteps, 0).toFixed(6)}..${quantile(clockSteps, 1).toFixed(6)} s (max error ${clockErr.toExponential(1)}); `
    + `useFrame deltas ${quantile(deltas, 0).toFixed(6)}..${quantile(deltas, 1).toFixed(6)} s over ${deltas.length} frames (max error ${deltaErr.toExponential(1)}); `
    + `useFrame calls per frame ${[...new Set(useFramesPerFrame)].join('/')}; render passes per frame ${[...new Set(rendersPerFrame)].join('/')} (real time ${passesPerFrame.toFixed(2)})`);

  const numbered = resolved.every((r, i) => r.frame === i + 1 && Math.abs(r.t - (i + 1) / FPS) < 1e-9);
  const onFrameOnce = seen.slice(0, FRAMES + 1).every((s, i) => s.frame === i + 1);
  record('frame()', numbered && onFrameOnce && resolved.length === FRAMES + 1,
    `${resolved.length} resolutions, frames ${resolved[0].frame}..${resolved.at(-1).frame}, t ${resolved[0].t.toFixed(4)}..${resolved.at(-1).t.toFixed(4)} s; onFrame once per frame: ${onFrameOnce}`);

  record('input', walked > 2 && brokenInFilm > 0,
    `walked ${walked.toFixed(2)} m in 1 film second; ${brokenInFilm} broken bonds after a cannon shot fired at frame 5 (${bondsBeforeIdle} by frame ${FRAMES + 1}${target ? '' : ', no structure to aim at'})`);

  const wallPerFrame = seen.slice(1).map((s, i) => s.wall - seen[i].wall);
  log(`wall time per film frame: median ${quantile(wallPerFrame, 0.5)} ms, p90 ${quantile(wallPerFrame, 0.9)} ms, max ${quantile(wallPerFrame, 1)} ms; film state ${JSON.stringify(filmState)}`);

  // disable: real time again.
  const justAfter = performance.now();
  const n0 = performance.now();
  const w0 = Date.now();
  const after = await rateOver(2000);
  const nowRate = (performance.now() - n0) / (Date.now() - w0);
  record('disable', after > 50 && after < 66 && nowRate > 0.9 && nowRate < 1.1 && justAfter >= lastFilmNow,
    `${after.toFixed(1)} ticks/s after (before: ${before.toFixed(1)}); performance.now() runs at ${nowRate.toFixed(3)}x wall time, continuous from the film (${lastFilmNow.toFixed(1)} -> ${justAfter.toFixed(1)} ms)`);
  gl.render = render;
  unsubscribeR3f();

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
