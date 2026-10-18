// Opt-in frame-rate cap for the city canvas: `?maxFps=N` in the page URL.
//
// Why it exists: when the game server runs on the same Mac, the browser and
// the server's PhysX step share one GPU, and every frame the browser renders
// is GPU time the server's step can queue behind. This is the cheapest
// public-API way for the client to render less. Measured on the M3 Max with
// perf_bench's meteor scenario beside a headless /cityreplay of the
// 2026-09-24 session (scripts/perf/gpu-contention): at the governor's
// resolution floor (1536x1229), ?maxFps=30 removed ~80% of the server's
// post-impact tick excess; at 2844x2275 it removed ~30%; ?maxFps=60 against
// an otherwise ~90 fps client did not measurably help. What matters is the
// share of the GPU the client keeps busy, not the frame rate as such.
//
// Off unless the URL asks for it; nothing changes by default. With a cap,
// the Canvas runs `frameloop="never"` and this module's rAF loop advances
// R3F only when a full cap interval has elapsed, so every useFrame
// subscriber (netcode, replay ticker, governor) runs at the capped rate.

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';

const MIN_FPS = 10;
const MAX_FPS = 240;

/** The cap from `?maxFps=N`, clamped to 10..240, or null (no cap: the default). */
export function frameRateCapFps(search: string = globalThis.location?.search ?? ''): number | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('maxFps');
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;
  const fps = Number(raw);
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, fps));
}

/**
 * Whether a rAF at `now` should render, given the time the next frame is due.
 * Returns the new due time, or null to skip this rAF. `slackMs` absorbs rAF
 * jitter so a 30 fps cap on a 60 Hz display renders every second vsync
 * rather than every third.
 */
export function nextCapDeadline(now: number, due: number, intervalMs: number, slackMs = 1.5): number | null {
  if (now + slackMs < due) return null;
  // Keep the cadence, but never schedule into the past after a stall.
  const next = due + intervalMs;
  return next < now ? now + intervalMs * 0.5 : next;
}

export type FrameCapStats = { fps: number; rendered: number; skipped: number; renderedAtMs: number[] };

declare global {
  interface Window {
    __VIBE_FRAME_CAP__?: FrameCapStats;
  }
}

/**
 * Drives R3F at the capped rate. Mounted by RenderGovernor, so the game and
 * /cityreplay share it. Does nothing without `?maxFps`.
 */
export function useFrameRateCap(): void {
  const advance = useThree((state) => state.advance);
  useEffect(() => {
    const fps = frameRateCapFps();
    if (fps === null) return;
    const interval = 1000 / fps;
    const stats: FrameCapStats = { fps, rendered: 0, skipped: 0, renderedAtMs: [] };
    window.__VIBE_FRAME_CAP__ = stats;
    let due = 0;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const next = nextCapDeadline(now, due, interval);
      if (next === null) {
        stats.skipped += 1;
        return;
      }
      due = next;
      stats.rendered += 1;
      stats.renderedAtMs.push(now);
      if (stats.renderedAtMs.length > 4096) stats.renderedAtMs.splice(0, 2048);
      advance(now, true);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [advance]);
}
