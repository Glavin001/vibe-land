// Film mode for the native app: offline, frame-locked rendering.
//
// Off by default; nothing here touches the game until `enable` is called.
// While on, each rendered frame is one film frame of exactly 1/fps seconds:
//
//   1. the virtual clock moves to the frame's time (performance.now() returns
//      it, so three's Clock, R3F's useFrame deltas, animations, particles and
//      the netcode's fixed-step input all advance exactly 1/fps),
//   2. onFrame callbacks run (a film script poses the camera, fires, drops),
//   3. the in-process match advances exactly 60/fps ticks, synchronously
//      (sim-native `step`, a lockstepped match: it does not tick by itself),
//      and its packets are routed to the client,
//   4. the game's frame callbacks run (R3F updates and renders the newest
//      tick, as in play),
//   5. frame() promises resolve.
//
// However long a frame takes on the wall clock -- a heavy collapse, a GPU
// readback for video -- the film's time, the sim and the picture advance
// together, so a recording at `fps` is smooth.
//
// Time: frame N (1, 2, ...) shows the world at t = N / fps film seconds after
// enable, and performance.now() during it is the enable-time reading plus
// t * 1000. Timers (setTimeout/setInterval) stay on the wall clock; a film
// script paces itself with frame()/onFrame instead.
//
// Re-renderable: the same script gives the same film (GPU PhysX aside, which
// is not bit-reproducible). With VIBE_FILM_LOCKSTEP=1 the match is in
// lockstep from tick 0, so enable() finds it at tick 0 however long the load
// took. Frame 1 is a pre-roll that wipes what the load left behind:
//   - the match discards input the client queued before it,
//   - Math.random is a PRNG seeded with `seed` (restored on disable),
//   - R3F's clock and three's node time restart so that elapsedTime is film
//     time (grass and leaf wind, anything keyed on elapsed time),
//   - the game's frame delta for frame 1 is PREROLL_S, which drives every
//     fixed-step accumulator (input, prediction, cosmetic physics) to its
//     catch-up clamp -- the same phase whatever the load's frame times were --
//     and lets load-time particles expire.
// From frame 2 on, every frame delta is exactly 1/fps. Do not record frame 1.

import { inProcessLink, pumpInProcessClients, type InProcessLink } from '../net/inProcessClient';

const SIM_HZ = 60;

export type FilmFrame = { t: number; frame: number; tick: number };
/** The match's costs for the ticks a film frame stepped (sim-native stepStats). */
export type FilmSimStats = {
  ticks: number;
  tickMs: number;
  maxTickMs: number;
  dynamicsMs: number;
  cityMs: number;
  awakeBodies: number;
  frozenBodies: number;
};

/**
 * Wall-clock timings of the last completed film frame (a real clock, not the
 * virtual one): onFrame callbacks, the sim step (60/fps ticks), routing its
 * packets, the game's frame callbacks (R3F update and render, through command
 * submission; the present and any recording readback happen after), the whole
 * frame, and the wall time since the previous film frame started (which does
 * include present, recording and the runtime's own loop).
 */
export type FilmFrameStats = {
  onFrameMs: number;
  stepMs: number;
  pumpMs: number;
  renderMs: number;
  frameMs: number;
  intervalMs: number | null;
  sim: FilmSimStats | null;
};

export type FilmState = {
  active: boolean;
  fps: number;
  frame: number;
  t: number;
  tick: number;
  /** The server tick when the film was enabled (0 with VIBE_FILM_LOCKSTEP=1). */
  startTick: number;
  seed: number;
  /** Math.random draws since frame 1, and a running digest of their values. */
  randomCalls: number;
  randomDigest: number;
} & Partial<FilmFrameStats>;
type FrameCallback = (t: number, frame: number) => void;

export interface FilmApi {
  /**
   * fps 30 or 60 (any divisor of 60). From the next frame on, frames are film
   * frames. seed (u32, default 1) seeds Math.random from frame 1.
   */
  enable(options: { fps: number; seed?: number }): void;
  /** Called at the start of each film frame, before the sim steps and the game renders. */
  onFrame(cb: FrameCallback): () => void;
  /** Resolves after the next frame has been simulated and rendered. */
  frame(): Promise<FilmFrame>;
  /** Film seconds of the current (or last) film frame; 0 before the first. */
  time(): number;
  /** Back to real time: the sim free-runs, the clock follows the wall clock again. */
  disable(): void;
  /** Whether film mode is on. */
  active(): boolean;
  /** The current film state, for checks and logs. */
  state(): FilmState;
}

type Raf = (cb: FrameRequestCallback) => number;
type CancelRaf = (id: number) => void;

const g = globalThis as typeof globalThis & {
  requestAnimationFrame: Raf;
  cancelAnimationFrame: CancelRaf;
  __VIBE_FILM__?: FilmApi;
};

let active = false;
let fps = 30;
let ticksPerFrame = 2;
let frameMs = 1000 / 30;
/** Film frames completed since enable. */
let frameCount = 0;
/** The film frame running or last run (time() is its time). */
let currentFrame = 0;
/**
 * The driver's first run after enable only lines the loop up: a game frame
 * callback registered before enable may still run natively in that batch,
 * and running the held ones as well would draw twice in one frame.
 */
let synced = false;
let lastTick = 0;
let startTick = 0;
let lastStats: FilmFrameStats | null = null;
let lastFrameWallStart: number | null = null;
/** The pre-roll: frame 1's frame delta, longer than any catch-up clamp. */
const PREROLL_S = 5;
let seed = 1;
/** performance.now() at enable, the film's time origin. */
let originMs = 0;
let link: InProcessLink | null = null;

// The clock. Installed on first enable and kept after (as a continuous
// real-time clock) so time never jumps or runs backwards on disable.
let clockInstalled = false;
let virtualClock = false;
let virtualNowMs = 0;
let realOffsetMs = 0;
let realNow: () => number = () => performance.now();

// Math.random while filming: mulberry32, seeded at frame 1.
let nativeRandom: (() => number) | null = null;
let randomState = 0;
let randomCalls = 0;
let randomDigest = 0;

function seededRandom(): number {
  randomState = (randomState + 0x6d2b79f5) | 0;
  let x = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  const bits = (x ^ (x >>> 14)) >>> 0;
  randomCalls += 1;
  randomDigest = (Math.imul(randomDigest, 31) + bits) >>> 0;
  return bits / 4294967296;
}

function seedRandom(): void {
  randomState = seed | 0;
  randomCalls = 0;
  randomDigest = 0;
  if (!nativeRandom) nativeRandom = Math.random;
  Math.random = seededRandom;
}

function restoreRandom(): void {
  if (nativeRandom) Math.random = nativeRandom;
  nativeRandom = null;
}

type ClockLike = { oldTime: number; elapsedTime: number };
type FilmStore = { getState(): { clock?: ClockLike; gl?: { _nodes?: { nodeFrame?: { lastTime?: number; time: number } } } } };

/**
 * Frame 1: the match forgets queued input, Math.random is seeded, and the
 * game's clocks restart on film time with a PREROLL_S frame delta.
 */
function startFilm(t: number): void {
  if (link?.setLockstep) link.setLockstep(true);
  seedRandom();
  const state = (g as { __VIBE_NATIVE_STORE__?: FilmStore }).__VIBE_NATIVE_STORE__?.getState();
  const clock = state?.clock;
  if (clock) {
    clock.oldTime = virtualNowMs - PREROLL_S * 1000;
    clock.elapsedTime = t - PREROLL_S;
  }
  const nodeFrame = state?.gl?._nodes?.nodeFrame;
  if (nodeFrame) {
    nodeFrame.lastTime = virtualNowMs - PREROLL_S * 1000;
    nodeFrame.time = t - PREROLL_S;
  }
}

function installClock(): void {
  if (clockInstalled) return;
  const perf = g.performance;
  realNow = perf.now.bind(perf);
  perf.now = () => (virtualClock ? virtualNowMs : realNow() + realOffsetMs);
  clockInstalled = true;
}

// The frame loop. While active, every requestAnimationFrame callback is held
// here and run by one native rAF (the driver), after the sim has stepped.
let nativeRaf: Raf | null = null;
let nativeCancel: CancelRaf | null = null;
const queued = new Map<number, FrameRequestCallback>();
let nextQueuedId = 1_000_000_000;
let driverId: number | null = null;
const frameCallbacks = new Set<FrameCallback>();
let waiters: Array<(frame: FilmFrame) => void> = [];

function filmRaf(cb: FrameRequestCallback): number {
  const id = nextQueuedId++;
  queued.set(id, cb);
  return id;
}

function filmCancel(id: number): void {
  if (!queued.delete(id)) nativeCancel?.(id);
}

function scheduleDriver(): void {
  if (driverId === null && nativeRaf) driverId = nativeRaf(driver);
}

function driver(): void {
  driverId = null;
  if (!active) return;
  try {
    if (synced) runFilmFrame();
    synced = true;
  } finally {
    if (active) scheduleDriver();
  }
}

function runFilmFrame(): void {
  const wallStart = realNow();
  const frame = frameCount + 1;
  const t = frame / fps;
  currentFrame = frame;
  virtualNowMs = originMs + frame * frameMs;
  if (frame === 1) startFilm(t);
  for (const cb of [...frameCallbacks]) {
    try {
      cb(t, frame);
    } catch (error) {
      console.error('[film] onFrame callback failed', error);
    }
  }
  const wallStep = realNow();
  if (link?.step) lastTick = link.step(ticksPerFrame);
  const wallPump = realNow();
  pumpInProcessClients();
  const wallRender = realNow();
  const callbacks = [...queued.values()];
  queued.clear();
  for (const cb of callbacks) {
    try {
      cb(virtualNowMs);
    } catch (error) {
      console.error('[film] frame callback failed', error);
    }
  }
  const wallEnd = realNow();
  lastStats = {
    onFrameMs: wallStep - wallStart,
    stepMs: wallPump - wallStep,
    pumpMs: wallRender - wallPump,
    renderMs: wallEnd - wallRender,
    frameMs: wallEnd - wallStart,
    intervalMs: lastFrameWallStart === null ? null : wallStart - lastFrameWallStart,
    sim: link?.stepStats?.() ?? null,
  };
  lastFrameWallStart = wallStart;
  frameCount = frame;
  const done = waiters;
  waiters = [];
  const result = { t, frame, tick: lastTick };
  for (const resolve of done) resolve(result);
}

function enable({ fps: requested, seed: requestedSeed = 1 }: { fps: number; seed?: number }): void {
  if (active) throw new Error('[film] already enabled');
  const perFrame = SIM_HZ / requested;
  if (!Number.isInteger(perFrame) || perFrame < 1) {
    throw new Error(`[film] fps must divide ${SIM_HZ} (30 or 60), got ${requested}`);
  }
  link = inProcessLink();
  if (!link?.setLockstep || !link.step) {
    throw new Error('[film] needs the in-process match with lockstep (rebuild sim-native)');
  }
  installClock();
  if (!Number.isFinite(requestedSeed)) throw new Error(`[film] seed must be a number, got ${requestedSeed}`);
  seed = requestedSeed >>> 0;
  fps = requested;
  ticksPerFrame = perFrame;
  frameMs = 1000 / fps;
  frameCount = 0;
  currentFrame = 0;
  lastStats = null;
  lastFrameWallStart = null;
  synced = false;
  // Time stops here: anything rendered before the first film frame sees
  // this instant, and the first film frame is exactly 1/fps after it.
  originMs = realNow() + realOffsetMs;
  virtualNowMs = originMs;
  virtualClock = true;
  // The sim stops ticking by itself (the call waits until the match has).
  lastTick = link.setLockstep(true);
  startTick = lastTick;
  nativeRaf = g.requestAnimationFrame;
  nativeCancel = g.cancelAnimationFrame;
  g.requestAnimationFrame = filmRaf;
  g.cancelAnimationFrame = filmCancel;
  active = true;
  scheduleDriver();
  console.log(`[film] on: ${fps} fps, ${ticksPerFrame} sim ticks a frame, from tick ${lastTick}, seed ${seed}`);
}

function disable(): void {
  if (!active) return;
  active = false;
  // The clock carries on from the film's time at real-time rate.
  realOffsetMs = virtualNowMs - realNow();
  virtualClock = false;
  restoreRandom();
  if (nativeRaf) g.requestAnimationFrame = nativeRaf;
  if (nativeCancel) g.cancelAnimationFrame = nativeCancel;
  if (driverId !== null) nativeCancel?.(driverId);
  driverId = null;
  // Held frame callbacks go back to the real frame loop.
  const callbacks = [...queued.values()];
  queued.clear();
  for (const cb of callbacks) g.requestAnimationFrame(cb);
  const tick = link?.setLockstep?.(false) ?? lastTick;
  console.log(`[film] off after ${frameCount} frames (${(frameCount / fps).toFixed(2)} s film), tick ${tick}`);
  // Anyone still waiting gets the next real frame.
  const done = waiters;
  waiters = [];
  if (done.length > 0) {
    g.requestAnimationFrame(() => {
      const result = { t: frameCount / fps, frame: frameCount, tick };
      for (const resolve of done) resolve(result);
    });
  }
}

export const film: FilmApi = {
  enable,
  disable,
  onFrame(cb) {
    frameCallbacks.add(cb);
    return () => {
      frameCallbacks.delete(cb);
    };
  },
  frame() {
    return new Promise<FilmFrame>((resolve) => {
      if (active) {
        waiters.push(resolve);
      } else {
        // Not filming: the next real frame.
        g.requestAnimationFrame(() => resolve({ t: frameCount / fps, frame: frameCount, tick: lastTick }));
      }
    });
  },
  time: () => currentFrame / fps,
  active: () => active,
  state: () => ({
    active, fps, frame: frameCount, t: frameCount / fps, tick: lastTick, startTick, seed, randomCalls, randomDigest,
    ...(lastStats ?? {}),
  }),
};

/** Publish `globalThis.__VIBE_FILM__` (native/main.tsx). */
export function installFilmApi(): void {
  g.__VIBE_FILM__ = film;
}
