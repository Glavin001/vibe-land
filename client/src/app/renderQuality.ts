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
const CITY_TEXTURES_KEY = 'vibe.render.cityTextures';
const SKY_IBL_KEY = 'vibe.render.skyIbl';
const SKY_DOME_KEY = 'vibe.render.skyDome';
const DPR_CAP_KEY = 'vibe.render.dprCap';
const HERO_TILING_KEY = 'vibe.render.heroTiling';
const SHARE_THRESHOLD_KEY = 'vibe.render.instanceShare';
const SHADOW_MAP_KEY = 'vibe.render.shadowMapSize';

/**
 * Uses of one shard shape below which it stays in its cell's batch.
 *
 * This number is a bet about the MACHINE, and it has now been measured going
 * both ways. A city-wide instanced mesh trades N multi-draw sub-draws for one
 * real draw call; a real draw is CPU submission, a sub-draw is GPU work, and
 * which is dearer depends on the driver:
 *
 *   RTX 4090 / ANGLE Vulkan:  32 wins.  GPU 2.55 ms at 8 -> 0.55 ms at 32.
 *   M3 Max   / ANGLE Metal:    8 wins.  GPU 4.53 ms at 8 -> 7.22 ms at 32,
 *                                       11.72 ms at 64 -- Metal punishes
 *                                       sub-draws hard, in the exact opposite
 *                                       direction.
 *
 * 8, because the M3 is the constrained machine: on the 4090 either value is
 * multiples under budget, on the M3 the difference is 2.7 ms of an 8.33 ms
 * frame. This default has been flipped once already by measuring on the wrong
 * hardware; do not change it again without a perf-sweep report from a machine
 * that is actually near budget. Live-settable so `perfSweep` can price it
 * wherever it runs.
 */
export const DEFAULT_INSTANCE_SHARE_THRESHOLD = 8;

export type QualityTier = 'fast' | 'pretty';

/**
 * How much of the city's surface shader to compile.
 *
 * `full` is 6 texture-array taps per pixel (3 albedo + 3 packed
 * normal/roughness/AO, triplanar), `albedo` is 3, `off` compiles the taps out
 * entirely. A switch, not a uniform, because the point of `off` is to not
 * SAMPLE -- a uniform that multiplied the result by zero would still pay for
 * the fetches, which is the cost being investigated.
 */
export type CityTextureDetail = 'full' | 'albedo' | 'off';

export type RenderQualityState = {
  shadows: boolean;
  tier: QualityTier;
  ao: boolean;
  /**
   * The per-pixel knobs, together in one store because they all have to notify
   * the same listeners: the city rebuilds its material, the scene rebinds its
   * environment, and the canvas resizes.
   *
   * Overrides, all defaulting to "whatever the tier says". They exist so a
   * frame that is GPU-bound can be bisected feature by feature ON THE MACHINE
   * THAT IS SLOW, which is the only place the answer lives -- a fast GPU
   * reports every one of them as free.
   */
  cityTextures: CityTextureDetail;
  skyIbl: boolean;
  skyDome: boolean;
  /** Hard cap on device pixel ratio, or null to follow the tier. */
  dprCap: number | null;
  /** Uses of one shard shape below which it stays in its cell's batch. */
  instanceShareThreshold: number;
  /** The stochastic anti-tiling stack on the city's concrete (PRETTY only). */
  heroTiling: boolean;
  /** Shadow-map edge in texels, or null to follow the tier (2048/1024). */
  shadowMapSize: number | null;
};

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

function readStored<T>(key: string, parse: (raw: string) => T | null): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : parse(raw);
  } catch {
    // See readStoredShadows.
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value);
  } catch {
    // Not fatal -- see readStoredShadows.
  }
}

let shadows: boolean = readStoredShadows() ?? defaultShadows();
let tier: QualityTier = readStoredTier() ?? defaultTier();
let ao: boolean = readStoredAo() ?? defaultAo();
let cityTextures: CityTextureDetail = readStored(CITY_TEXTURES_KEY, (raw) =>
  raw === 'full' || raw === 'albedo' || raw === 'off' ? raw : null) ?? 'full';
let skyIbl: boolean = readStored(SKY_IBL_KEY, (raw) => raw === '1') ?? true;
let skyDome: boolean = readStored(SKY_DOME_KEY, (raw) => raw === '1') ?? true;
let dprCap: number | null = readStored(DPR_CAP_KEY, (raw) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
});
let heroTiling: boolean = readStored(HERO_TILING_KEY, (raw) => raw === '1') ?? true;
// Session-only, deliberately. These two have no panel button -- the perf sweep
// is their only writer -- and persisting them is how a user got PINNED to a
// sweep's temporary value: the sweep wrote threshold 32 through this store, the
// default later changed to 8, and their browser kept serving the stale 32 with
// nothing in the UI to say so. A measurement knob must never outlive the
// session that measured with it.
let instanceShareThreshold: number = DEFAULT_INSTANCE_SHARE_THRESHOLD;
let shadowMapSize: number | null = null;

// Purge what previous builds persisted; only the sweep ever wrote these keys,
// so any stored value is contamination from it.
try {
  localStorage?.removeItem(SHARE_THRESHOLD_KEY);
  localStorage?.removeItem(SHADOW_MAP_KEY);
} catch {
  // See readStoredShadows.
}

function notify(): void {
  const state: RenderQualityState = {
    shadows,
    tier,
    ao,
    cityTextures,
    skyIbl,
    skyDome,
    dprCap,
    instanceShareThreshold,
    shadowMapSize,
    heroTiling,
  };
  for (const listener of listeners) listener(state);
}

/** How much of the city's surface shader to compile. FAST never gets the full set. */
export function cityTextureDetail(): CityTextureDetail {
  if (tier === 'fast' && cityTextures === 'full') return 'albedo';
  return cityTextures;
}

export function setCityTextureDetail(next: CityTextureDetail): void {
  if (next === cityTextures) return;
  cityTextures = next;
  store(CITY_TEXTURES_KEY, next);
  notify();
}

/** Whether the sky is baked into an environment map and bound to the scene. */
export function skyIblEnabledSetting(): boolean {
  return skyIbl;
}

export function setSkyIblEnabled(next: boolean): void {
  if (next === skyIbl) return;
  skyIbl = next;
  store(SKY_IBL_KEY, next ? '1' : '0');
  notify();
}

/** Whether the sky DOME is drawn. Independent of the IBL bake above. */
export function skyDomeEnabled(): boolean {
  return skyDome && tier === 'pretty';
}

export function setSkyDomeEnabled(next: boolean): void {
  if (next === skyDome) return;
  skyDome = next;
  store(SKY_DOME_KEY, next ? '1' : '0');
  notify();
}

/**
 * Uses of one shard shape below which it stays in its cell's batch.
 *
 * The whole draw-call/sub-draw trade in one number, and it decides ~300 draw
 * calls: at 8 the pack instances 428 shapes, at 32 it instances 136 and moves
 * 4,850 chunks into multi-draw batches instead.
 *
 * Which way that pays is entirely a property of the machine -- a real draw
 * costs CPU submission, a sub-draw costs GPU -- so it is a setting rather than
 * a constant. The committed 8 was measured on a 4090, where submission is
 * nearly free and the sub-draws dominated; that is the same generalisation
 * that priced this branch's lighting as costless.
 *
 * Changing it rebuilds the city mesh, which is not free -- it is a measurement
 * knob, not something to flip mid-fight.
 */
export function instanceShareThresholdSetting(): number {
  return instanceShareThreshold;
}

export function setInstanceShareThreshold(next: number): void {
  if (!Number.isFinite(next) || next < 1 || next === instanceShareThreshold) return;
  instanceShareThreshold = next;
  notify();
}

/**
 * Shadow-map edge override, or null for the tier default.
 *
 * Exists for the sweep: the M3 report showed shadows costing 2.3 ms of frame
 * with GPU and CPU medians both flat -- the 2048^2 map re-rendering 41k mostly
 * static chunks every frame. A 1024 step prices the cheap half of that trade
 * before anyone designs shadow caching.
 */
export function shadowMapSizeOverride(): number | null {
  return shadowMapSize;
}

export function setShadowMapSize(next: number | null): void {
  if (next === shadowMapSize) return;
  if (next !== null && (!Number.isFinite(next) || next < 256)) return;
  shadowMapSize = next;
  notify();
}

/**
 * The hex-stochastic + macro anti-tiling stack on the city's concrete.
 *
 * A shader VARIANT, not a uniform: off compiles the plain triplanar path, so
 * the A/B (and the perf sweep's pricing of it) compares real programs, not a
 * branch. PRETTY-only -- the stack needs the surface array.
 */
export function heroTilingEnabled(): boolean {
  return heroTiling;
}

export function setHeroTilingEnabled(next: boolean): void {
  if (next === heroTiling) return;
  heroTiling = next;
  store(HERO_TILING_KEY, next ? '1' : '0');
  notify();
}

export function dprCapOverride(): number | null {
  return dprCap;
}

export function setDprCap(next: number | null): void {
  if (next === dprCap) return;
  dprCap = next;
  store(DPR_CAP_KEY, next === null ? '' : String(next));
  notify();
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
  // An explicit cap wins over the tier. Pixel count is the single biggest lever
  // on a fill-bound frame and the one knob whose cost is exactly predictable,
  // so it is worth being able to set directly rather than only as a side effect
  // of the tier.
  if (dprCap !== null) return dprCap;
  // PRETTY was 2. Measured on an M3 Max at a 4112x2396 backing store, dropping
  // it to 1.5 removes 44% of the pixels and 2.08 ms of GPU time -- 32% of the
  // frame's GPU cost, and MORE than the entire triplanar concrete (1.74 ms) or
  // the whole SSAO pass (1.44 ms). It is the cheapest 2 ms available anywhere
  // in this renderer, and 5.5 MPix is still comfortably above native on the
  // Retina panels that report dpr 2.
  return 1.5;
}

/**
 * MSAA. Context-creation-time: a change applies on the next reload.
 *
 * Off whenever SSAO is on, because SSAO renders the scene into its own
 * offscreen target and that target has no sample count -- so the multisampled
 * default framebuffer is allocated, never drawn into except by the composite
 * quad, and resolved every frame for nothing. At 9.85 MPix that is a real cost
 * for an image that is not antialiased either way.
 *
 * The image does not change; the waste goes away. To actually GET antialiasing
 * back with SSAO on, the AO beauty target needs a sample count of its own,
 * which costs rather than saves.
 */
export function antialiasEnabled(): boolean {
  return tier === 'pretty' && !ambientOcclusionEnabled();
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
  return skyIbl;
}

/**
 * The persisted keys, as raw storage entries, and the way to put them back.
 *
 * For the perf sweep. It drives every setting through the same setters the
 * panel uses, and those PERSIST -- so without this, a sweep freezes whatever
 * defaults were current into the reporter's localStorage, and no future
 * default change ever reaches them. The sweep snapshots the raw entries before
 * it starts and writes back exactly what was there -- including the absence of
 * a key, which is what lets the user keep tracking defaults.
 */
const PERSISTED_KEYS = [
  SHADOWS_KEY,
  TIER_KEY,
  AO_KEY,
  CITY_TEXTURES_KEY,
  SKY_IBL_KEY,
  SKY_DOME_KEY,
  DPR_CAP_KEY,
  HERO_TILING_KEY,
] as const;

export function snapshotStoredRenderSettings(): Array<[string, string | null]> {
  try {
    return PERSISTED_KEYS.map((key) => [key, localStorage?.getItem(key) ?? null]);
  } catch {
    return [];
  }
}

export function restoreStoredRenderSettings(snapshot: Array<[string, string | null]>): void {
  try {
    for (const [key, value] of snapshot) {
      if (value === null) localStorage?.removeItem(key);
      else localStorage?.setItem(key, value);
    }
  } catch {
    // See readStoredShadows.
  }
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
export function useShadowMapSizeOverride(): number | null {
  return useSyncExternalStore(subscribe, shadowMapSizeOverride, shadowMapSizeOverride);
}

export function useSkyDomeEnabled(): boolean {
  return useSyncExternalStore(subscribe, skyDomeEnabled, skyDomeEnabled);
}

export function useSkyIblEnabled(): boolean {
  return useSyncExternalStore(subscribe, skyIblEnabled, skyIblEnabled);
}

export function useAmbientOcclusionEnabled(): boolean {
  return useSyncExternalStore(subscribe, ambientOcclusionEnabled, ambientOcclusionEnabled);
}
