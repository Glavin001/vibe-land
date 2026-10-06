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
/* global FILM_OUT, FILM_FPS, FILM_PREVIEW, FILM_SCENE, FILM_SEQUENCE, FILM_LOCKSTEP, FILM_SEED, __mystralRecordStart, __mystralRecordStop, __mystralRecordStats, __mystralSaveScreenshot */

import { loadPlaces, placeResolver, point, offset } from './places.mjs';
import {
  hold, path, orbit, track, fire, meteor, drive, goto, note, strike, barrage, title, card, slowmo, flash, fade,
  METEOR_FLIGHT_S, timeline, cameraProblems,
} from './shots.mjs';

export {
  hold, path, orbit, track, fire, meteor, drive, goto, note, strike, barrage, title, card, slowmo, flash, fade,
  METEOR_FLIGHT_S, point, offset,
};

// Set by native-mac.sh at bundle time (esbuild --define).
const OUT = typeof FILM_OUT === 'string' && FILM_OUT ? FILM_OUT : '../../target/native-video/film.mp4';
const DEFAULT_FPS = typeof FILM_FPS === 'number' ? FILM_FPS : 30;
const PREVIEW = typeof FILM_PREVIEW === 'boolean' ? FILM_PREVIEW : false;
const DEFAULT_SCENE = typeof FILM_SCENE === 'string' && FILM_SCENE ? FILM_SCENE : 'city';
// Without mystral's recorder: each film frame saved as a PNG, for
// native-mac.sh to put together (slow, but every frame, at film time).
const SEQUENCE = typeof FILM_SEQUENCE === 'boolean' ? FILM_SEQUENCE : false;
// The sim born in lockstep at tick 0 (VIBE_FILM_LOCKSTEP=1): nothing advances
// it but film frames, so a take is the same every time but for GPU physics.
const LOCKSTEP = typeof FILM_LOCKSTEP === 'boolean' ? FILM_LOCKSTEP : false;
/** The film's seed: the server's meteor bearings (VIBE_MATCH_SEED) and the client's Math.random. */
const DEFAULT_SEED = typeof FILM_SEED === 'number' ? FILM_SEED : 1;
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
/**
 * Camera shake from impacts (strike): each shakes a camera within `radius`
 * metres, harder the nearer, dying away over `decay` seconds.
 */
function shaker({ strength = 1, radius = 110, decay = 0.45 } = {}) {
  const impacts = [];
  const wave = (t, phase) => Math.sin(t * 31 + phase) + 0.6 * Math.sin(t * 57 + phase * 1.7) + 0.35 * Math.sin(t * 89 + phase * 2.3);
  return {
    impact(position, at) { impacts.push({ position, at, phase: impacts.length * 2.399 }); },
    apply(pose, t) {
      let amp = 0, phase = 0;
      for (const i of impacts) {
        const age = t - i.at;
        if (age < 0 || age > decay * 5) continue;
        const d = Math.hypot(...pose.position.map((v, k) => v - i.position[k]));
        const near = Math.max(0, 1 - d / radius);
        const a = strength * near * near * Math.exp(-age / decay);
        if (a > amp) { amp = a; phase = i.phase; }
      }
      if (amp < 1e-3) return pose;
      const n = [0, 1, 2].map((k) => wave(t, phase + k * 1.3));
      return {
        position: pose.position.map((v, k) => v + n[k] * amp * 0.22),
        lookAt: pose.lookAt.map((v, k) => v + n[(k + 1) % 3] * amp * 0.9),
      };
    },
  };
}

export async function boot({ scene = DEFAULT_SCENE, fps = DEFAULT_FPS, preview = PREVIEW, place, shake, letterbox, haze, seed = DEFAULT_SEED, settle = 4 } = {}) {
  place ??= placeResolver(await loadPlaces(scene));
  log(`${scene}: ${place.all.length} named places; ${preview ? 'preview' : `${fps} fps -> ${OUT}`}`);
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const driveBridge = await waitFor('the drive bridge', () => globalThis.__VIBE_DRIVE__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 120_000);
  // In lockstep the sim waits at tick 0 for the film; it settles below.
  if (!LOCKSTEP || preview) await waitFor('the simulation', () => (e2e.matchStats()?.server_tick ?? 0) >= 120);
  if (TOWN_KIT_SCENES.has(scene)) {
    const kit = await waitFor('the town-kit details', () => (e2e.townKit?.().ready || e2e.townKit?.().error) && e2e.townKit(), 60_000);
    if (kit.error) log(`town-kit details FAILED: ${kit.error}`);
  }
  if (globalThis.__VIBE_NATIVE_HUD__) globalThis.__VIBE_NATIVE_HUD__.visible = false;
  // `haze`: a light fog (this fraction of play's density, 0.25 at least), for
  // depth and to soften the ground's far edge in high shots.
  if (haze) e2e.setLook({ fogEnabled: true, fogIntensity: Math.max(0.25, haze) });
  // Film mode last, after every wait: once on, film frames run back to back
  // whatever the script is doing (it throws when the sim cannot lockstep).
  // Its frame 1 is a pre-roll clearing what loading left behind (never
  // filmed); then `settle` seconds of frames -- a fixed number of ticks --
  // before anything is filmed, so every take starts from the same world.
  let filmMode = !preview && globalThis.__VIBE_FILM__ ? globalThis.__VIBE_FILM__ : null;
  try { filmMode?.enable({ fps, seed }); } catch (error) { log(`film mode FAILED (${error?.message ?? error}): film time is the wall clock`); filmMode = null; }
  if (!filmMode && !preview && !globalThis.__VIBE_FILM__) log('no film mode (__VIBE_FILM__): film time is the wall clock');
  if (filmMode) {
    for (let k = Math.round(settle * fps) + 1; k > 0; k -= 1) await filmMode.frame();
    const st = filmMode.state();
    log(`film mode: ${fps} fps, seed ${seed}, ${LOCKSTEP ? 'lockstep from tick 0' : `from tick ${st.startTick} (not reproducible: no VIBE_FILM_LOCKSTEP)`}, settled to tick ${st.tick}`);
  }
  // The fleet against the scene's parking spots: a car not where its spot says films an empty driveway.
  const vehicles = e2e.snapshot()?.vehicles ?? [];
  const spots = place.all.filter((p) => p.kind === 'car').map((p) => {
    const d = Math.min(...vehicles.map((v) => Math.hypot(v.position[0] - p.position[0], v.position[2] - p.position[2])));
    return `${p.id} ${Number.isFinite(d) ? `${d.toFixed(1)} m` : '-'}`;
  });
  log(`ready: ${vehicles.length} vehicles${spots.length ? `; nearest to each spot: ${spots.join(', ')}` : ''}`);

  let recording = false, sequence = null;
  const shakes = shaker(shake ?? { strength: 0 });
  // t: the film time (video seconds) of the cue being run; edit(): a line of the cut's edit list.
  const ctx = {
    place, e2e, drive: driveBridge, log, t: 0,
    session: globalThis.__VIBE_NATIVE_SESSION__,
    edit: (e) => log(`edit ${JSON.stringify(e, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v))}`),
    impact: (position, at) => {
      shakes.impact(position, at);
      log(`impact ${JSON.stringify({ at: +at.toFixed(3), position: position.map((v) => +v.toFixed(1)) })}`);
    },
  };

  /**
   * One `stats {json}` line per film frame, for offline analysis
   * (scripts/film/stats.py): the frame's wall-clock costs (film mode's
   * stepMs/renderMs/frameMs when it reports them, else the gap between
   * frames), the sim's (physx, GPU wait, awake bodies), the city's (awake
   * chunks, broken bonds), meteors in flight, the renderer's CPU and draws,
   * the recorder's capture. `f`/`t`: the film frame and video seconds.
   */
  let lastWall = null;
  const round = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : null);
  function logStats(f, t) {
    const wall = Date.now(), wallMs = lastWall == null ? null : wall - lastWall;
    lastWall = wall;
    const fs = filmMode?.state?.() ?? {}, ms = e2e.matchStats?.() ?? {}, city = e2e.snapshot?.()?.city ?? {};
    const prof = e2e.frameProfile?.() ?? {}, rec = typeof __mystralRecordStats === 'function' ? __mystralRecordStats() : {};
    const sim = fs.sim ?? {};
    log(`stats ${JSON.stringify({
      f, t: round(t, 3), tick: fs.tick ?? ms.server_tick ?? null, wallMs: fs.intervalMs != null ? round(fs.intervalMs) : wallMs,
      frameMs: round(fs.frameMs), stepMs: round(fs.stepMs), pumpMs: round(fs.pumpMs), renderMs: round(fs.renderMs), onFrameMs: round(fs.onFrameMs),
      tickMs: round(sim.tickMs), maxTickMs: round(sim.maxTickMs), dynamicsMs: round(sim.dynamicsMs), cityMs: round(sim.cityMs),
      physxMs: round(ms.physics_last_step_ms), gpuWaitMs: round(ms.physics_gpu_wait_ms),
      awake: sim.awakeBodies ?? ms.city?.awake_bodies ?? null, frozen: sim.frozenBodies ?? null,
      chunksAwake: city.chunksAwake ?? null, broken: city.brokenBonds ?? null,
      meteors: e2e.meteors?.().length ?? null, cpuMs: round(prof.cpuFrameMs), draws: prof.drawCalls ?? null,
      captureMs: round(rec.captureMs), frames: rec.frames ?? null,
    })}`);
  }

  /**
   * Start the recording with the frame about to be drawn: in film mode, from
   * inside onFrame (frames before film frame 1 are real-time ones).
   */
  function startRecording() {
    if (typeof __mystralRecordStart === 'function') {
      // The hardware encoder by name skips the recorder's probe; 'auto' if it is missing.
      const clock = filmMode ? 'frame' : 'wall';
      recording = __mystralRecordStart(OUT, { fps, clock, encoder: 'h264_videotoolbox' })
        || __mystralRecordStart(OUT, { fps, clock, encoder: 'auto' });
      const stats = __mystralRecordStats?.() ?? {};
      log(recording ? `recording ${OUT} (${clock} clock, ${fps} fps, ${stats.width}x${stats.height}, ${stats.encoder})`
        : `FAILED to start recording: ${stats.error ?? 'no reason given'}`);
    } else if (SEQUENCE && filmMode) {
      sequence = OUT.replace(/\.mp4$/, '-frames');
      log(`no recorder (__mystralRecordStart): each frame to ${sequence}/`);
    }
  }

  function stopRecording() {
    sequence = null;
    if (!recording) return;
    const stopped = __mystralRecordStop();
    recording = false;
    const stats = __mystralRecordStats?.();
    if (stats) log(`recorded ${stats.frames} frames (${stats.seconds?.toFixed?.(1)} s) of ${stats.presented} presented, ${stats.dropped} dropped, ${stats.duplicated} duplicated, ${stats.encoder}; capture ${stats.captureMs?.toFixed?.(2)} ms, wait ${stats.waitMs?.toFixed?.(2)} ms`);
    log(stopped ? `video: ${OUT}` : `FAILED to finish the video: ${stats?.error ?? 'no reason given'}`);
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

  /**
   * `progress` lines every ~5 s of wall time: % of the film's frames done, the
   * film time, elapsed wall time, the recent rate (film frames per wall
   * second, over the last ~20 s: heavy destruction is slower) and the ETA it
   * gives. Wall time is Date.now: performance.now is film time in film mode.
   */
  function progressMeter(totalFrames) {
    const began = Date.now(), recent = [];
    let lastLog = began;
    const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    return (frame, t) => {
      const now = Date.now();
      recent.push([now, frame]);
      while (recent.length > 2 && now - recent[0][0] > 20_000) recent.shift();
      if (now - lastLog < 5000 && frame < totalFrames) return;
      lastLog = now;
      const [t0, f0] = recent[0], rate = now > t0 ? ((frame - f0) * 1000) / (now - t0) : 0;
      const left = Math.max(0, totalFrames - frame), pct = Math.min(100, (100 * frame) / totalFrames);
      log(`progress ${pct.toFixed(1)}% (frame ${frame}/${totalFrames}, film ${t.toFixed(1)}/${(totalFrames / fps).toFixed(1)} s), `
        + `${clock(now - began)} elapsed, ${rate.toFixed(1)} frames/s, ETA ${rate > 0 ? clock((left / rate) * 1000) : '?'}`);
    };
  }

  /** The shots on film time: cues fire as their time comes, the camera takes each frame's pose. */
  async function runFilm(tl) {
    const progress = progressMeter(Math.round(tl.duration * fps));
    let shown = -1, next = 0, followed = -Infinity;
    if (letterbox) ctx.edit({ type: 'letterbox', ratio: letterbox });
    const step = (t) => {
      while (next < tl.cues.length && tl.cues[next].time <= t) {
        const cue = tl.cues[next++];
        if (cue.first) log(`${Math.max(0, cue.time).toFixed(1)}s ${cue.label}`);
        ctx.t = Math.max(0, cue.time);
        try { cue.run(ctx); } catch (error) { log(`cue ${cue.label} FAILED: ${error?.message ?? error}`); }
      }
      const i = tl.shotAt(t);
      if (i !== shown) { shown = i; const s = tl.shots[i]; log(`shot ${i + 1}/${tl.shots.length} ${s.name} at ${t.toFixed(1)}s`); }
      const pose = tl.poseAt(Math.min(t, tl.duration));
      // player: 'camera' -- the player on the ground under the camera, twice a second.
      if (tl.shots[i].follow && t - followed >= 0.5) {
        followed = t;
        e2e.dropAt({ position: [pose.position[0], 1.2, pose.position[2]], yaw: 0, pitch: 0 });
      }
      e2e.setCapturePose(shakes.apply(pose, t));
      return t >= tl.duration;
    };
    if (filmMode) {
      // All of it inside onFrame: the pose set there lands in that very frame,
      // and frames do not wait for anything else.
      await new Promise((resolve) => {
        let t0 = null, done = false, saved = 0, frames = 0;
        const off = filmMode.onFrame((t) => {
          // The last frame drawn (sequences only): this callback runs before the next.
          if (t0 != null && sequence && !__mystralSaveScreenshot(`${sequence}/${String(saved++).padStart(5, '0')}.png`)) log(`FAILED to save frame ${saved}`);
          // The frame after the last one: stop before it is drawn.
          if (done) { stopRecording(); off(); resolve(); return; }
          if (t0 == null) { t0 = t; startRecording(); log('rolling'); } else logStats(frames - 1, t - t0 - 1 / fps);
          progress(frames, t - t0);
          frames += 1;
          done = step(t - t0);
        });
      });
    } else {
      startRecording();
      log('rolling');
      const t0 = performance.now();
      let frames = 0;
      for (;;) {
        const t = (performance.now() - t0) / 1000;
        if (frames > 0) logStats(frames - 1, t);
        progress(frames, t);
        frames += 1;
        if (step(t)) break;
        await nextFrame();
      }
      stopRecording();
    }
  }

  /**
   * Play the shots and cut. The camera settles on the first pose for
   * `settle` seconds (not filmed) before the recording starts.
   */
  async function play(shots, { settle: hold = 0.5 } = {}) {
    try {
      const tl = timeline(shots).build(ctx);
      log(`${tl.shots.length} shots, ${tl.duration.toFixed(1)} s`);
      for (const problem of cameraProblems(tl, place.all)) log(`  WARNING: ${problem}`);
      if (preview) { await runPreview(tl); await cut(0); return; }
      e2e.setCapturePose(tl.poseAt(0));
      if (filmMode) for (let k = Math.round(hold * fps); k > 0; k -= 1) await filmMode.frame();
      else await sleep(hold * 1000);
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
    if (film.preview) log('preview: cues are listed, not run');
    await film.play(shots);
  } catch (error) {
    log(`FAILED: ${error?.stack ?? error}`);
    setTimeout(() => process.exit(1), 300);
  }
}
