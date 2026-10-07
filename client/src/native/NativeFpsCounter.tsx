// Performance, drawn in the scene's top-left corner (the native app has no
// DOM): render frames per second, the frame interval, and the frame's work --
// the time from the start of a frame's callbacks to the end of its render,
// less the time spent waiting on the display. At vsync the interval is the
// display's (16.7 ms at 60 Hz) whatever the work, so it says nothing about
// cost; the work does. mystral waits for the display inside the render (the
// surface texture acquire and the present on submit), so those two calls are
// timed and taken out. The GPU's time is the renderer's timestamp queries
// (three's trackTimestamp: each pass timed on the GPU, summed per frame).
// Reading them back blocks in mystral until the GPU is done, so they are read
// every TIMESTAMP_EVERY frames at the START of a frame, when the previous
// frame's GPU work has normally finished; waiting on the GPU after a frame's
// submit instead cost missed frames (~8% vs ~2% in heavy destruction). Then the simulation's tick
// rate and tick cost from the match stats the server sends once a second
// (in-process here, so the server's numbers are this machine's). Text is rasterised on a small 2D canvas (mystral's Skia), read
// back with getImageData into a DataTexture twice a second, and shown on a
// quad in the screen-space overlay (NativeOverlay).

import { addAfterEffect, addEffect, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { useOverlaySize } from './NativeOverlay';

import { getMatchStats } from '../app/connectPhase';

type SimStats = {
  server_tick?: number;
  physics_last_step_ms?: number;
  /** Of the PhysX step, the time spent waiting for the GPU (which rendering shares). */
  physics_gpu_wait_ms?: number;
  city?: { awake_bodies?: number } | null;
  timings?: { total_ms?: { avg?: number; p95?: number; max?: number } };
};

const WIDTH = 820;
const HEIGHT = 80;
const UPDATE_MS = 500;
/** Ticks per second over this much wall time (stats arrive once a second). */
const TPS_WINDOW_MS = 3000;
/** Frames between GPU timestamp readbacks. */
const TIMESTAMP_EVERY = 30;
/** On-screen height of the panel, as a fraction of the view height. */
const SCREEN_HEIGHT = 0.07;
const MARGIN = 0.015;

type Backend = {
  context?: { getCurrentTexture: () => unknown };
  device?: { queue: { submit: (buffers: unknown[]) => void } };
};

/**
 * Report the time spent in the two calls where mystral waits for the display
 * (the surface acquire, and submit, which presents); returns the restore.
 */
function timeDisplayWaits(renderer: unknown, report: (ms: number) => void): () => void {
  const backend = (renderer as { backend?: Backend }).backend;
  const context = backend?.context;
  const queue = backend?.device?.queue;
  if (!context || !queue) return () => {};
  const acquire = context.getCurrentTexture;
  const submit = queue.submit;
  context.getCurrentTexture = function (this: unknown) {
    const started = performance.now();
    try { return acquire.call(this); } finally { report(performance.now() - started); }
  };
  queue.submit = function (this: unknown, buffers: unknown[]) {
    const started = performance.now();
    try { return submit.call(this, buffers); } finally { report(performance.now() - started); }
  };
  return () => {
    context.getCurrentTexture = acquire;
    queue.submit = submit;
  };
}

export function NativeFpsCounter() {
  const size = useOverlaySize();
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const texture = new THREE.DataTexture(new Uint8Array(WIDTH * HEIGHT * 4), WIDTH, HEIGHT, THREE.RGBAFormat);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return { canvas, ctx, texture };
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  const counter = useRef({ frames: 0, since: performance.now(), worstMs: 0, last: performance.now() });
  // The frame's work: from before its callbacks to after its render.
  const work = useRef({ started: 0, waitMs: 0, totalMs: 0, worstMs: 0, frames: 0 });
  // The GPU time of the latest frame read back (null before the first, or without timestamp queries).
  const gpu = useRef<{ countdown: number; ms: number | null }>({ countdown: TIMESTAMP_EVERY, ms: null });
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const restore = timeDisplayWaits(gl, (ms) => { work.current.waitMs += ms; });
    const resolveTimestamps = (gl as { resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> }).resolveTimestampsAsync?.bind(gl);
    const tracking = (gl as { backend?: { trackTimestamp?: boolean } }).backend?.trackTimestamp === true;
    const before = addEffect(() => {
      // Before this frame's work: the GPU timestamps of the frames before it.
      const g = gpu.current;
      if (tracking && resolveTimestamps && --g.countdown <= 0) {
        g.countdown = TIMESTAMP_EVERY;
        void resolveTimestamps('render').then((ms) => {
          if (typeof ms === 'number' && ms > 0) {
            g.ms = ms;
            // For harnesses (client/native/matter-look.mjs): a second reader
            // would race this one for the query set.
            (globalThis as { __VIBE_NATIVE_GPU_MS__?: number }).__VIBE_NATIVE_GPU_MS__ = ms;
          }
        }).catch(() => {});
      }
      work.current.started = performance.now();
      work.current.waitMs = 0;
    });
    const after = addAfterEffect(() => {
      const w = work.current;
      if (w.started === 0) return;
      const ms = performance.now() - w.started - w.waitMs;
      w.totalMs += ms;
      w.worstMs = Math.max(w.worstMs, ms);
      w.frames += 1;
    });
    return () => { before(); after(); restore(); };
  }, [gl]);
  // Each stats packet's tick and the frame it arrived in: ticks per second
  // over TPS_WINDOW_MS, to within a frame's timing at each end.
  const arrivals = useRef<Array<{ tick: number; at: number }>>([]);

  const rate = (value: number, good: number, ok: number) =>
    value >= good ? '#7CFC8A' : value >= ok ? '#FFD166' : '#FF6B6B';

  const draw = (fps: number, workMs: number, workWorstMs: number, gpuMs: number | null) => {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Render: frames per second, mean and worst frame time.
    ctx.font = '26px Menlo, monospace';
    ctx.fillStyle = rate(fps, 55, 30);
    ctx.fillText(`${fps.toFixed(0).padStart(3)} FPS`, 10, 32);
    ctx.font = '17px Menlo, monospace';
    ctx.fillStyle = '#d0d4d8';
    // The frame's CPU work and GPU work. They overlap (the GPU draws one
    // frame while the CPU prepares the next), so without vsync the frame rate
    // is bound by the slower of the two.
    const boundMs = Math.max(workMs, gpuMs ?? 0);
    ctx.fillText(
      `cpu ${workMs.toFixed(1)} ms (max ${workWorstMs.toFixed(1)})  gpu ${gpuMs === null ? '--' : `${gpuMs.toFixed(1)} ms`}`,
      160, 22,
    );
    ctx.fillStyle = '#9fb3c8';
    ctx.fillText(
      `~${(1000 / Math.max(0.1, boundMs)).toFixed(0)} FPS uncapped (${gpuMs === null ? 'cpu only' : gpuMs > workMs ? 'gpu-bound' : 'cpu-bound'})`,
      160, 42,
    );

    // Simulation: ticks per second (from the server tick counter, over the
    // last TPS_WINDOW_MS) and the tick's cost (server timing, mean / p95).
    const stats = getMatchStats() as SimStats | null;
    const seen = arrivals.current;
    const first = seen[0];
    const last = seen[seen.length - 1];
    const hz = first && last && last.at - first.at >= 900 ? ((last.tick - first.tick) * 1000) / (last.at - first.at) : null;
    const tick = stats?.timings?.total_ms;
    ctx.font = '26px Menlo, monospace';
    ctx.fillStyle = hz === null ? '#d0d4d8' : rate(hz, 57, 45);
    ctx.fillText(`${hz === null ? ' --' : hz.toFixed(0).padStart(3)} TPS`, 10, 68);
    ctx.font = '17px Menlo, monospace';
    ctx.fillStyle = '#d0d4d8';
    ctx.fillText(
      tick?.avg !== undefined
        ? `sim ${tick.avg.toFixed(1)} ms  p95 ${(tick.p95 ?? 0).toFixed(1)}  physx ${(stats?.physics_last_step_ms ?? 0).toFixed(1)}`
          + ` (gpu wait ${(stats?.physics_gpu_wait_ms ?? 0).toFixed(1)})  ${stats?.city?.awake_bodies ?? 0} awake`
        : 'sim waiting for stats',
      160,
      66,
    );
    // getImageData rows run top-down; the texture's run bottom-up.
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const target = texture.image.data as Uint8Array;
    const row = WIDTH * 4;
    for (let y = 0; y < HEIGHT; y += 1) {
      target.set(pixels.subarray(y * row, (y + 1) * row), (HEIGHT - 1 - y) * row);
    }
    texture.needsUpdate = true;
  };

  useFrame(() => {
    const now = performance.now();
    const latest = (getMatchStats() as SimStats | null)?.server_tick;
    const seen = arrivals.current;
    if (latest !== undefined && latest !== seen[seen.length - 1]?.tick) {
      if (seen.length && latest < seen[seen.length - 1].tick) seen.length = 0;
      seen.push({ tick: latest, at: now });
      while (seen.length > 2 && now - seen[1].at >= TPS_WINDOW_MS) seen.shift();
    }
    const c = counter.current;
    c.frames += 1;
    c.worstMs = Math.max(c.worstMs, now - c.last);
    c.last = now;
    if (now - c.since >= UPDATE_MS) {
      const w = work.current;
      draw((c.frames * 1000) / (now - c.since), w.totalMs / Math.max(1, w.frames), w.worstMs, gpu.current.ms);
      w.totalMs = 0;
      w.worstMs = 0;
      w.frames = 0;
      c.frames = 0;
      c.worstMs = 0;
      c.since = now;
    }
  });

  // The view's top-left corner, in overlay pixels (origin at the centre).
  const height = size.height * SCREEN_HEIGHT;
  const width = height * (WIDTH / HEIGHT);
  const margin = size.height * MARGIN;
  void canvas;
  return (
    <group position={[-size.width / 2 + margin + width / 2, size.height / 2 - margin - height / 2, 0]} scale={[width, height, 1]}>
      <mesh renderOrder={1001} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} fog={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
