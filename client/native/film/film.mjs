// Film-making for the native app (scripts/native-mac.sh film NAME --scene S).
// A film is a script of ~20 lines (client/native/elm-park-tour.mjs):
//
//   import { shoot, hold, path, orbit, fire, meteor } from './film/film.mjs';
//   shoot({ scene: 'town' }, ({ place }) => [
//     hold({ position: [-215, 75, -135], lookAt: 'elm-park' }, 1.5),
//     path([pose, pose, pose], 12, { name: 'approach' }),
//     orbit({ centre: 'car-5', radius: 7, height: 2.2, from: 36, to: 207 }, 6),
//     hold(pose, 4, { cues: [[0.5, fire({ from, at: place('house', { nearest: [-51, 16] }), shots: 5 })]] }),
//   ]);
//
// shoot() resolves the shots against the scene's named places (failing fast,
// before the game loads), loads the game, waits until the scene is ready to
// film, plays the shots on film time and cuts. Film time comes from the app's
// film mode (__VIBE_FILM__: the sim in lockstep with frames, one film frame
// each) when it has one, else from the wall clock; the recording from
// mystral's recorder (__mystralRecordStart: every presented frame to H.264)
// when it has one; else, in film mode, each frame as a PNG
// (FILM_SEQUENCE) for native-mac.sh to put together, and without film mode
// the script logs `rolling` and `cut` for native-mac.sh to trim a real-time
// --video recording to. Preview (FILM_PREVIEW=1)
// records nothing: it saves one still from the middle of each shot.
/* global FILM_OUT, FILM_FPS, FILM_PREVIEW, FILM_SCENE, FILM_SEQUENCE, __mystralRecordStart, __mystralRecordStop, __mystralRecordStats, __mystralSaveScreenshot */

import { loadPlaces, placeResolver, point, offset } from './places.mjs';
import { hold, path, orbit, track, fire, meteor, drive, goto, note, timeline, cameraProblems } from './shots.mjs';

export { hold, path, orbit, track, fire, meteor, drive, goto, note, point, offset };

// Set by native-mac.sh at bundle time (esbuild --define).
const OUT = typeof FILM_OUT === 'string' && FILM_OUT ? FILM_OUT : '../../target/native-video/film.mp4';
const DEFAULT_FPS = typeof FILM_FPS === 'number' ? FILM_FPS : 30;
const PREVIEW = typeof FILM_PREVIEW === 'boolean' ? FILM_PREVIEW : false;
const DEFAULT_SCENE = typeof FILM_SCENE === 'string' && FILM_SCENE ? FILM_SCENE : 'city';
// Without mystral's recorder: each film frame saved as a PNG, for
// native-mac.sh to put together (slow, but every frame, at film time).
const SEQUENCE = typeof FILM_SEQUENCE === 'boolean' ? FILM_SEQUENCE : false;
/** Scenes with a town-kit details layer (tree leaves), which loads after the city. */
const TOWN_KIT_SCENES = new Set(['town', 'showcase', 'bayline']);

const started = Date.now();
// `[film 12.3s] rolling` / `cut`: the shape native-mac.sh trims a --video recording by.
const log = (...args) => console.log(`[film ${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => (typeof requestAnimationFrame === 'function'
  ? new Promise((resolve) => requestAnimationFrame(() => resolve())) : sleep(16));
const fmt = (v) => `[${v.map((c) => c.toFixed(1)).join(', ')}]`;

async function waitFor(what, predicate, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Load the game and wait until the scene can be filmed: the city loaded, the
 * shaders warmed, the simulation running (tick 120) and the town-kit details
 * in. Hides the HUD and turns film mode on. Returns the film: { place, play,
 * cut, e2e, drive, log, fps, preview }.
 */
export async function boot({ scene = DEFAULT_SCENE, fps = DEFAULT_FPS, preview = PREVIEW, place } = {}) {
  place ??= placeResolver(await loadPlaces(scene));
  log(`${scene}: ${place.all.length} named places; ${preview ? 'preview' : `${fps} fps -> ${OUT}`}`);
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const driveBridge = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 120_000);
  await waitFor('the simulation', () => (e2e.matchStats()?.server_tick ?? 0) >= 120);
  if (TOWN_KIT_SCENES.has(scene)) {
    const kit = await waitFor('the town-kit details', () => (e2e.townKit?.().ready || e2e.townKit?.().error) && e2e.townKit(), 60_000);
    if (kit.error) log(`town-kit details FAILED: ${kit.error}`);
  }
  if (globalThis.__VIBE_NATIVE_HUD__) globalThis.__VIBE_NATIVE_HUD__.visible = false;
  // The fleet against the scene's parking spots: a car not where its spot says films an empty driveway.
  const vehicles = e2e.snapshot()?.vehicles ?? [];
  const spots = place.all.filter((p) => p.kind === 'car').map((p) => {
    const d = Math.min(...vehicles.map((v) => Math.hypot(v.position[0] - p.position[0], v.position[2] - p.position[2])));
    return `${p.id} ${Number.isFinite(d) ? `${d.toFixed(1)} m` : '-'}`;
  });
  log(`ready: ${vehicles.length} vehicles${spots.length ? `; nearest to each spot: ${spots.join(', ')}` : ''}`);

  // Film mode last, after every wait: once on, film frames run back to back
  // whatever the script is doing (it throws when the sim cannot lockstep).
  let filmMode = !preview && globalThis.__VIBE_FILM__ ? globalThis.__VIBE_FILM__ : null;
  try { filmMode?.enable({ fps }); } catch (error) { log(`film mode FAILED (${error?.message ?? error}): film time is the wall clock`); filmMode = null; }
  if (!filmMode && !preview && !globalThis.__VIBE_FILM__) log('no film mode (__VIBE_FILM__): film time is the wall clock');
  let recording = false, sequence = null;
  const ctx = { place, e2e, drive: driveBridge, log };

  /**
   * Start the recording with the frame about to be drawn: in film mode, from
   * inside onFrame (frames before film frame 1 are real-time ones).
   */
  function startRecording() {
    if (typeof __mystralRecordStart === 'function') {
      const clock = filmMode ? 'frame' : 'wall';
      recording = __mystralRecordStart(OUT, { fps, clock });
      log(recording ? `recording ${OUT} (${clock} clock, ${fps} fps)` : 'FAILED to start recording');
    } else if (SEQUENCE && filmMode) {
      sequence = OUT.replace(/\.mp4$/, '-frames');
      log(`no recorder (__mystralRecordStart): each frame to ${sequence}/`);
    }
  }

  function stopRecording() {
    sequence = null;
    if (!recording) return;
    const stats = typeof __mystralRecordStats === 'function' ? __mystralRecordStats() : null;
    const stopped = __mystralRecordStop();
    recording = false;
    if (stats) log(`recorded ${stats.frames} frames (${stats.seconds?.toFixed?.(1)} s), ${stats.dropped} dropped, ${stats.duplicated} duplicated, ${stats.encoder}`);
    log(stopped ? `video: ${OUT}` : 'FAILED to finish the video');
  }

  /** Stop recording, hand the clock back and exit. */
  async function cut(code = 0) {
    stopRecording();
    if (filmMode) filmMode.disable();
    driveBridge.clear();
    log('cut');
    setTimeout(() => process.exit(code), 300);
  }

  /** Each shot's middle, as a still, then exit: the film checked in seconds. */
  async function runPreview(tl) {
    const dir = OUT.replace(/\.mp4$/, '-preview');
    for (const cue of tl.cues.filter((c) => c.first)) log(`  cue ${cue.time.toFixed(1)}s: ${cue.label}`);
    for (const [i, s] of tl.shots.entries()) {
      const pose = s.pose(s.duration / 2);
      e2e.setCapturePose(pose);
      for (let k = 0; k < 4; k += 1) await nextFrame();
      await sleep(400);
      const file = `${dir}/${String(i + 1).padStart(2, '0')}-${s.name.replace(/[^a-z0-9-]+/gi, '-')}.png`;
      const saved = __mystralSaveScreenshot(file);
      log(`shot ${i + 1}/${tl.shots.length} ${s.name} ${s.start.toFixed(1)}-${(s.start + s.duration).toFixed(1)}s, mid ${fmt(pose.position)} -> ${fmt(pose.lookAt)}: ${saved ? file : 'FAILED to save'}`);
    }
  }

  /** The shots on film time: cues fire as their time comes, the camera takes each frame's pose. */
  async function runFilm(tl) {
    let shown = -1, next = 0;
    const step = (t) => {
      while (next < tl.cues.length && tl.cues[next].time <= t) {
        const cue = tl.cues[next++];
        if (cue.first) log(`${cue.time.toFixed(1)}s ${cue.label}`);
        try { cue.run(ctx); } catch (error) { log(`cue ${cue.label} FAILED: ${error?.message ?? error}`); }
      }
      const i = tl.shotAt(t);
      if (i !== shown) { shown = i; const s = tl.shots[i]; log(`shot ${i + 1}/${tl.shots.length} ${s.name} at ${t.toFixed(1)}s`); }
      e2e.setCapturePose(tl.poseAt(Math.min(t, tl.duration)));
      return t >= tl.duration;
    };
    if (filmMode) {
      // All of it inside onFrame: the pose set there lands in that very frame,
      // and frames do not wait for anything else.
      await new Promise((resolve) => {
        let t0 = null, done = false, saved = 0;
        const off = filmMode.onFrame((t) => {
          // The last frame drawn (sequences only): this callback runs before the next.
          if (t0 != null && sequence && !__mystralSaveScreenshot(`${sequence}/${String(saved++).padStart(5, '0')}.png`)) log(`FAILED to save frame ${saved}`);
          // The frame after the last one: stop before it is drawn.
          if (done) { stopRecording(); off(); resolve(); return; }
          if (t0 == null) { t0 = t; startRecording(); log('rolling'); }
          done = step(t - t0);
        });
      });
    } else {
      startRecording();
      log('rolling');
      const t0 = performance.now();
      while (!step((performance.now() - t0) / 1000)) await nextFrame();
      stopRecording();
    }
  }

  /**
   * Play the shots and cut. The camera settles on the first pose for
   * `settle` seconds (not filmed) before the recording starts.
   */
  async function play(shots, { settle = 1.5 } = {}) {
    try {
      const tl = timeline(shots).build(ctx);
      log(`${tl.shots.length} shots, ${tl.duration.toFixed(1)} s`);
      for (const problem of cameraProblems(tl, place.all)) log(`  WARNING: ${problem}`);
      if (preview) { await runPreview(tl); await cut(0); return; }
      e2e.setCapturePose(tl.poseAt(0));
      if (filmMode) for (let k = Math.round(settle * fps); k > 0; k -= 1) await filmMode.frame();
      else await sleep(settle * 1000);
      await runFilm(tl);
      await cut(0);
    } catch (error) {
      log(`FAILED: ${error?.stack ?? error}`);
      await cut(1);
    }
  }

  return { scene, fps, preview, place, e2e, drive: driveBridge, log, play, cut };
}

/**
 * A whole film: `script({ place })` returns the shots; they are checked
 * against the scene's places before the game loads, then boot() and play().
 * Any failure logs `[film ...] FAILED` and exits 1.
 */
export async function shoot(options, script) {
  try {
    const scene = options.scene ?? DEFAULT_SCENE;
    const place = placeResolver(await loadPlaces(scene));
    const shots = script({ place });
    const tl = timeline(shots);
    log(`${tl.shots.length} shots, ${tl.duration.toFixed(1)} s: ${tl.shots.map((s) => s.name).join(', ')}`);
    const film = await boot({ ...options, scene, place });
    await film.play(shots);
  } catch (error) {
    log(`FAILED: ${error?.stack ?? error}`);
    setTimeout(() => process.exit(1), 300);
  }
}
