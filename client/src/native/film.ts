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

import { inProcessLink, pumpInProcessClients, type InProcessLink } from '../net/inProcessClient';

const SIM_HZ = 60;

export type FilmFrame = { t: number; frame: number; tick: number };
type FrameCallback = (t: number, frame: number) => void;

export interface FilmApi {
  /** fps 30 or 60 (any divisor of 60). From the next frame on, frames are film frames. */
  enable(options: { fps: number }): void;
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
  state(): { active: boolean; fps: number; frame: number; t: number; tick: number };
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
  const frame = frameCount + 1;
  const t = frame / fps;
  currentFrame = frame;
  virtualNowMs = originMs + frame * frameMs;
  for (const cb of [...frameCallbacks]) {
    try {
      cb(t, frame);
    } catch (error) {
      console.error('[film] onFrame callback failed', error);
    }
  }
  if (link?.step) lastTick = link.step(ticksPerFrame);
  pumpInProcessClients();
  const callbacks = [...queued.values()];
  queued.clear();
  for (const cb of callbacks) {
    try {
      cb(virtualNowMs);
    } catch (error) {
      console.error('[film] frame callback failed', error);
    }
  }
  frameCount = frame;
  const done = waiters;
  waiters = [];
  const result = { t, frame, tick: lastTick };
  for (const resolve of done) resolve(result);
}

function enable({ fps: requested }: { fps: number }): void {
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
  fps = requested;
  ticksPerFrame = perFrame;
  frameMs = 1000 / fps;
  frameCount = 0;
  currentFrame = 0;
  synced = false;
  // Time stops here: anything rendered before the first film frame sees
  // this instant, and the first film frame is exactly 1/fps after it.
  originMs = realNow() + realOffsetMs;
  virtualNowMs = originMs;
  virtualClock = true;
  // The sim stops ticking by itself (the call waits until the match has).
  lastTick = link.setLockstep(true);
  nativeRaf = g.requestAnimationFrame;
  nativeCancel = g.cancelAnimationFrame;
  g.requestAnimationFrame = filmRaf;
  g.cancelAnimationFrame = filmCancel;
  active = true;
  scheduleDriver();
  console.log(`[film] on: ${fps} fps, ${ticksPerFrame} sim ticks a frame, from tick ${lastTick}`);
}

function disable(): void {
  if (!active) return;
  active = false;
  // The clock carries on from the film's time at real-time rate.
  realOffsetMs = virtualNowMs - realNow();
  virtualClock = false;
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
  state: () => ({ active, fps, frame: frameCount, t: frameCount / fps, tick: lastTick }),
};

/** Publish `globalThis.__VIBE_FILM__` (native/main.tsx). */
export function installFilmApi(): void {
  g.__VIBE_FILM__ = film;
}
