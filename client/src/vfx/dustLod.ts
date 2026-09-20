// Which parcels to draw, and how hard to look at each one.
//
// The dust costs GPU time in one currency: volume samples, which is pixels
// covered times steps per pixel. Everything here spends that currency where it
// buys the most picture -- a cloud in the player's face gets 48 steps, one on
// the skyline gets 12 through a half-resolution layer -- and enforces a
// per-frame ceiling, so a hundred buildings coming down at once costs the same
// frame as one. The selection is by stable identity (parcel serial), so what is
// drawn does not flicker as the camera moves.
//
// No three.js in here: every function is pure so the budget arithmetic can be
// unit-tested in node, and the renderer adapts the results.

/**
 * Beyond this distance a fogged volume is indistinguishable from the fog it is
 * drawn over: the exp2 fog has swallowed 97% of it and 97% of what is behind.
 */
export function fogCullDistance(fogDensity: number): number {
  if (!(fogDensity > 0)) return Infinity;
  return Math.sqrt(-Math.log(0.03)) / fogDensity;
}

export type DustTier = 0 | 1 | 2;

/**
 * How many parcels out of each stride are drawn at a tier: every one, one in
 * two, one in six. Each stride divides the next so whatever is drawn far away
 * is still drawn as it comes closer -- a cloud never vanishes on approach.
 */
export const TIER_STRIDE: readonly number[] = [1, 2, 6];
/** Steps per ray at a tier before the projected-size clamp. */
export const TIER_STEPS: readonly number[] = [48, 24, 12];
const NEAR_M = 60;
const MID_M = 140;

/** Near when close OR when big enough to fill the view from where it is. */
export function tierFor(distance: number, radius: number): DustTier {
  if (distance < NEAR_M || distance < radius * 5) return 0;
  if (distance < MID_M) return 1;
  return 2;
}

/** Whether a parcel of this serial is drawn at this tier. Stable across frames. */
export function drawnAtTier(serial: number, tier: DustTier): boolean {
  return serial % TIER_STRIDE[tier] === 0;
}

/**
 * Steps for one parcel: the tier's budget, clamped to what its projected size
 * can show. A cloud that covers 20 pixels does not need 48 samples through it.
 */
export function stepsFor(tier: DustTier, projectedPx: number): number {
  return Math.min(TIER_STEPS[tier], Math.max(8, projectedPx * 0.4));
}

/** Eased so a tier change is a fade of sampling density rather than a pop. */
export function easeSteps(current: number, target: number, dtSeconds: number): number {
  if (current <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dtSeconds * 4));
}

/** Pixels per metre at one metre, for a vertical fov and viewport height. */
export function pixelsPerMetre(fovDeg: number, viewportHeightPx: number): number {
  return viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

export interface DustDrawItem {
  slot: number;
  distance: number;
  /** Projected diameter, px. */
  projectedPx: number;
  tier: DustTier;
  steps: number;
  /** 1 = full-res layer, 0 = half-res layer; between, drawn in both with split fade. */
  layerBlend: number;
  /** Multiplier on density to compensate for stride thinning. */
  densityScale: number;
}

/** Cost of one item in samples: its area, its steps, and a quarter of that for the half-res share. */
function itemCost(item: DustDrawItem, viewportPx: number): number {
  const px = Math.min(item.projectedPx * item.projectedPx, viewportPx);
  const share = item.layerBlend + (1 - item.layerBlend) * 0.25;
  return px * item.steps * share;
}

/**
 * The per-frame ceiling on Σ pixels·steps. Three ways to give, in order:
 * every item's steps scale down together (floor `minSteps`); then items move
 * to the half-res layer from the far end, a quarter of the cost each; then,
 * only if that is still not enough, the farthest are dropped. Returns the
 * estimate after adjustment.
 *
 * 12 M samples is roughly 1.5–2 ms on a 2022 desktop GPU at one trilinear
 * fetch per step; depth termination and early-out make the real count lower.
 * Items are expected sorted near-to-far.
 */
export function applySampleBudget(
  items: DustDrawItem[],
  budget: number,
  viewportPx: number,
  minSteps = 6,
): number {
  let estimate = 0;
  for (const item of items) estimate += itemCost(item, viewportPx);
  if (estimate <= budget) return estimate;
  // Scale the items that can still give, holding the floored ones at the
  // floor. An item that hits the floor stops giving, so the others must give
  // more; a few rounds settle it.
  for (let round = 0; round < 4 && estimate > budget; round += 1) {
    let floored = 0;
    let scalable = 0;
    for (const item of items) {
      const cost = itemCost(item, viewportPx);
      if (item.steps <= minSteps) floored += cost;
      else scalable += cost;
    }
    if (scalable <= 0) break;
    const scale = Math.max(0, budget - floored) / scalable;
    estimate = 0;
    for (const item of items) {
      if (item.steps > minSteps) item.steps = Math.max(minSteps, item.steps * scale);
      estimate += itemCost(item, viewportPx);
    }
  }
  if (estimate <= budget) return estimate;
  // Still over at the floor: demote to half-res from the far end. A crowded
  // collapse is many overlapping clouds, and a quarter-cost cloud beats no
  // cloud.
  for (let i = items.length - 1; i >= 0 && estimate > budget; i -= 1) {
    const item = items[i];
    if (item.layerBlend <= 0) continue;
    estimate -= itemCost(item, viewportPx);
    item.layerBlend = 0;
    // Twice the floor at a quarter of the pixels: half the cost, and the
    // upsample has less grain to smooth.
    item.steps = Math.max(item.steps, minSteps * 2);
    estimate += itemCost(item, viewportPx);
  }
  if (estimate <= budget) return estimate;
  // Still over: shed from the far end. The nearest is never shed: a budget
  // that cannot afford the one cloud in the player's face is a budget that
  // is wrong.
  while (items.length > 1 && estimate > budget) {
    const dropped = items.pop()!;
    estimate -= itemCost(dropped, viewportPx);
  }
  return estimate;
}

/** Surface distance beyond which a parcel goes to the half-res layer, and the blend band. */
export const HALF_RES_DISTANCE_M = 90;
export const HALF_RES_BAND_M = 30;
/**
 * A parcel covering more than this fraction of the viewport also goes
 * half-res. Off (above 1) by default: the jittered march's grain is magnified
 * by the upsample, and up close that grain is the whole picture. The sample
 * budget bounds the near case instead.
 */
export const HALF_RES_COVERAGE = 4;
const HALF_RES_COVERAGE_BAND = 1;

/**
 * 1 = draw natively, 0 = draw in the half-res layer, between = both with the
 * fade split so the handover is invisible. Distance is to the cloud's surface,
 * not its centre, so a big cloud stays sharp on approach.
 */
export function layerBlendFor(
  distance: number,
  radius: number,
  projectedPx: number,
  viewportPx: number,
): number {
  const surface = Math.max(0, distance - radius);
  const byDistance = 1 - clamp01((surface - HALF_RES_DISTANCE_M) / HALF_RES_BAND_M);
  const coverage = (projectedPx * projectedPx) / Math.max(1, viewportPx);
  const byCoverage = 1 - clamp01((coverage - HALF_RES_COVERAGE) / HALF_RES_COVERAGE_BAND);
  return Math.min(byDistance, byCoverage);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Back-to-front, for the over operator. */
export function sortBackToFront(items: DustDrawItem[]): void {
  items.sort((a, b) => b.distance - a.distance);
}
