// How often a moving chunk needs its transform recomposed for the renderer.
//
// Recomposing every moving chunk every frame is the client's dominant cost
// once a demolition is large -- tens of thousands of matrix composes, most of
// them for rubble far enough away that a frame's worth of motion is a fraction
// of a pixel. Distant bodies are updated on a stride instead.
//
// This is a render-rate decision only. The authoritative pose is whatever the
// ledger holds; deferring a write delays when a distant chunk is redrawn, it
// never changes where it is.

/**
 * Frames between transform updates for a body this far from the camera.
 *
 * Thresholds are on SQUARED distance so the caller never needs a square root
 * in a loop that runs per moving body per frame.
 *
 * The bands are chosen against on-screen error rather than metres: a chunk
 * falling at 10 m/s moves ~17 cm per frame, and at 90 m that subtends roughly
 * a pixel, so updating every second frame there is invisible. Beyond 180 m the
 * same motion is well under a pixel even at a stride of 8.
 */
export function updateStrideForDistanceSq(distanceSq: number): number {
  if (!(distanceSq > 0)) {
    // NaN or a body sitting on the camera: never defer. Cheap, and NaN
    // failing every comparison below would otherwise fall through to the
    // largest stride, deferring the *nearest* chunks.
    return 1;
  }
  if (distanceSq < 40 * 40) return 1;
  if (distanceSq < 90 * 90) return 2;
  if (distanceSq < 180 * 180) return 4;
  return 8;
}

/**
 * Whether this body's transforms should be rewritten on this frame.
 *
 * Staggered by key so deferred work spreads evenly across frames instead of
 * every distant body landing on the same one, which would trade a steady cost
 * for a periodic spike -- worse for frame pacing than not deferring at all.
 */
export function shouldUpdateThisFrame(frame: number, key: number, stride: number): boolean {
  if (stride <= 1) {
    return true;
  }
  // Key can exceed 2^31 (it encodes structure and island), so keep the
  // modulus on a non-negative value.
  return (frame + Math.abs(key)) % stride === 0;
}
