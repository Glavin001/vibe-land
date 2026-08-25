// Render-quality switches the player can flip at runtime.
//
// Two knobs. `shadows` came first: the city draws every chunk into the shadow
// map as well as the main pass. Turning it off on an iPhone Pro bought only
// ~4 fps (20-23 -> 24, frame p95 still 45 ms), which measured the shadow pass
// as a minor line item and pointed at everything else the Canvas never gated:
// dpr 2 on a 3x screen, MSAA, ACES tonemapping, a full-screen atmospheric sky
// shader, weather-particle overdraw, and PBR under four lights on every pixel
// of 24,105 chunks. The `tier` knob gates all of those together.
//
// FAST is a look, not a broken PRETTY: flat tonemapping, plain sky colour,
// Lambert-shaded chunks. The split exists so the phone measurement can happen
// on the phone -- the netlab harness runs desktop Chrome at 60-67 fps on this
// same scene and cannot reproduce the problem.

import { useSyncExternalStore } from 'react';

import { isTouchDevice } from '../device';

const SHADOWS_KEY = 'vibe.render.shadows';
const TIER_KEY = 'vibe.render.tier';
const HULL_POOL_KEY = 'vibe.render.hullPool';

export type QualityTier = 'fast' | 'pretty';

export type RenderQualityState = { shadows: boolean; tier: QualityTier; hullPool: number };

/**
 * Fracture-pattern library size, or 0 for the real authored shards.
 *
 * Unlike the other two knobs this one changes what is DRAWN, not how it is lit:
 * hulls are replaced by `n` shared shard shapes so they can be instanced.
 *
 * OFF by default and expected to stay that way. It has been looked at, and any
 * pool turns an undamaged city into what looks like a demolished one -- a
 * wall's shards are cut to fit each other, and swapping one for a stranger of
 * the same size breaks the whole facade, not just the seam. Keep it as a
 * measurement: it shows what instancing the hulls is worth (a lot), which is
 * the argument for doing the pooling at authoring time instead, per panel.
 * See city/hullPool.ts.
 *
 * Cost at each size, measured on the bench at 100k chunks, against the 204 fps
 * the un-pooled build gets: 16 -> 633, 64 -> 679, 256 -> 489, 512 -> 350.
 */
export const HULL_POOL_CHOICES = [0, 16, 64, 256, 512] as const;

type Listener = (state: RenderQualityState) => void;

const listeners = new Set<Listener>();

function defaultShadows(): boolean {
  return !isTouchDevice();
}

function defaultTier(): QualityTier {
  return isTouchDevice() ? 'fast' : 'pretty';
}

function readStoredShadows(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SHADOWS_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Private-mode Safari throws on localStorage access. A device that cannot
    // remember the setting should still be able to toggle it for this session.
  }
  return null;
}

function readStoredTier(): QualityTier | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(TIER_KEY);
    if (raw === 'fast' || raw === 'pretty') return raw;
  } catch {
    // See readStoredShadows.
  }
  return null;
}

function readStoredHullPool(): number | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(HULL_POOL_KEY);
    if (raw == null) return null;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  } catch {
    // See readStoredShadows.
  }
  return null;
}

/**
 * `?hullPool=N` on the URL, for driving a comparison from a harness without
 * having to reach into localStorage first. Read once at module load and takes
 * precedence over the stored value for that session; it is not itself stored,
 * so a plain reload falls back to whatever the panel last selected.
 */
function urlHullPool(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('hullPool');
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

let shadows: boolean = readStoredShadows() ?? defaultShadows();
let tier: QualityTier = readStoredTier() ?? defaultTier();
let hullPool: number = urlHullPool() ?? readStoredHullPool() ?? 0;

function notify(): void {
  const state: RenderQualityState = { shadows, tier, hullPool };
  for (const listener of listeners) listener(state);
}

/** Pattern library size; 0 means draw the authored shards. */
export function hullPoolSize(): number {
  return hullPool;
}

/**
 * Changing this has to rebuild the chunk meshes -- the pool decides which
 * geometry every hull instance points at, which is fixed at build time. The
 * city layer watches for that and rebuilds; it is a second or two, not a
 * reload.
 */
export function setHullPoolSize(next: number): void {
  const value = Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0;
  if (value === hullPool) return;
  hullPool = value;
  try {
    localStorage?.setItem(HULL_POOL_KEY, String(value));
  } catch {
    // Not fatal -- see readStoredShadows.
  }
  notify();
}

/** React view of the pool size. */
export function useHullPoolSize(): number {
  return useSyncExternalStore(subscribe, hullPoolSize, hullPoolSize);
}

export function shadowsEnabled(): boolean {
  return shadows;
}

export function setShadowsEnabled(next: boolean): void {
  if (next === shadows) return;
  shadows = next;
  try {
    localStorage?.setItem(SHADOWS_KEY, next ? '1' : '0');
  } catch {
    // Not fatal -- see readStoredShadows.
  }
  notify();
}

export function qualityTier(): QualityTier {
  return tier;
}

export function setQualityTier(next: QualityTier): void {
  if (next === tier) return;
  tier = next;
  try {
    localStorage?.setItem(TIER_KEY, next);
  } catch {
    // Not fatal.
  }
  notify();
}

// ---------------------------------------------------------------------------
// Flags derived from the tier. Each is its own getter rather than a bag so a
// call site reads as a decision ("skyEnabled()"), and so a future per-flag
// override can slot in behind one getter without touching consumers.
// ---------------------------------------------------------------------------

/**
 * Upper device-pixel-ratio bound for the canvas.
 *
 * R3F's default is 2. On a 3x iPhone the drop to 1.5 removes 44% of the
 * pixels, which multiplies every fill cost below. Runtime-adjustable via
 * three's setPixelRatio, unlike antialias/tonemapping.
 */
export function maxDpr(): number {
  return tier === 'fast' ? 1.5 : 2;
}

/** MSAA. Context-creation-time: a change applies on the next reload. */
export function antialiasEnabled(): boolean {
  return tier === 'pretty';
}

/** ACES filmic off on FAST. Also context-creation-time (r3f `flat`). */
export function flatToneMapping(): boolean {
  return tier === 'fast';
}

/** The drei <Sky> atmospheric dome: a full-screen shader over every sky pixel. */
export function skyEnabled(): boolean {
  return tier === 'pretty';
}

/** Transparent weather particles: pure overdraw on a fill-bound device. */
export function weatherEnabled(): boolean {
  return tier === 'pretty';
}

/**
 * PBR city chunks and the second (fill) directional light. FAST swaps the city
 * to Lambert and drops the extra light, which cheapens every remaining
 * Standard-material pixel as well.
 */
export function cityPbrLighting(): boolean {
  return tier === 'pretty';
}

/** Subscribe to changes; returns an unsubscribe. */
export function onRenderQualityChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the current value came from the player rather than the default. */
export function shadowsAreExplicit(): boolean {
  return readStoredShadows() !== null;
}

function subscribe(callback: () => void): () => void {
  return onRenderQualityChange(callback);
}

/** React view of the tier; re-renders the consumer when it changes. */
export function useQualityTier(): QualityTier {
  return useSyncExternalStore(subscribe, qualityTier, qualityTier);
}

/** React view of the shadows flag. */
export function useShadowsEnabled(): boolean {
  return useSyncExternalStore(subscribe, shadowsEnabled, shadowsEnabled);
}
