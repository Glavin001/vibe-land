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
const AO_KEY = 'vibe.render.ao';

export type QualityTier = 'fast' | 'pretty';

export type RenderQualityState = { shadows: boolean; tier: QualityTier; ao: boolean };

type Listener = (state: RenderQualityState) => void;

const listeners = new Set<Listener>();

function defaultShadows(): boolean {
  return !isTouchDevice();
}

function defaultTier(): QualityTier {
  return isTouchDevice() ? 'fast' : 'pretty';
}

/**
 * SSAO defaults to on wherever the PRETTY tier does. It is a real cost -- an
 * extra full-screen scene pass plus two half-res passes -- so it stays tied to
 * a device that already opted into paying for looks, and gets its own toggle
 * for the same reason shadows do: it is the second-largest fill cost in the
 * frame, and A/B-ing it needs to be one click.
 */
function defaultAo(): boolean {
  return !isTouchDevice();
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

function readStoredAo(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AO_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // See readStoredShadows.
  }
  return null;
}

let shadows: boolean = readStoredShadows() ?? defaultShadows();
let tier: QualityTier = readStoredTier() ?? defaultTier();
let ao: boolean = readStoredAo() ?? defaultAo();

function notify(): void {
  const state: RenderQualityState = { shadows, tier, ao };
  for (const listener of listeners) listener(state);
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

/** Player's SSAO preference. Gated by the tier at the call site. */
export function ambientOcclusionPreferred(): boolean {
  return ao;
}

export function setAmbientOcclusionEnabled(next: boolean): void {
  if (next === ao) return;
  ao = next;
  try {
    localStorage?.setItem(AO_KEY, next ? '1' : '0');
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

/**
 * Screen-space ambient occlusion. PRETTY only, and only if the player has not
 * turned it off: it takes over the render loop with an offscreen scene pass.
 */
export function ambientOcclusionEnabled(): boolean {
  return tier === 'pretty' && ao;
}

/**
 * Sky image-based lighting. On at both tiers -- the prefiltered environment map
 * is sampled like any other env map, which is cheaper than the extra
 * hemisphere+ambient lights it replaces, and it is what stops flat geometry
 * from reading as cardboard. Only the visible sky dome is tier-gated.
 */
export function skyIblEnabled(): boolean {
  return true;
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

/** React view of the effective SSAO flag (tier included). */
export function useAmbientOcclusionEnabled(): boolean {
  return useSyncExternalStore(subscribe, ambientOcclusionEnabled, ambientOcclusionEnabled);
}
