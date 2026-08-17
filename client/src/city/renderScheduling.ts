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

/**
 * Edge of a render cell, in metres.
 *
 * A cell is the unit the renderer batches and staggers by. Sized at or above
 * the 40 m stride-1 band so a single cell rarely straddles two stride bands:
 * if it did, the near half would pull the whole cell to stride 1 and the
 * deferral would buy nothing.
 *
 * Smaller cells stagger more finely but multiply draw calls; larger cells
 * approach the city-wide batch this exists to avoid.
 */
export const RENDER_CELL_SIZE_M = 48;

/**
 * Grid-hashes a world XZ position to a cell id.
 *
 * Y is ignored: buildings are vertical, so splitting by height would put a
 * tower's floors in different cells while leaving its footprint whole -- the
 * opposite of what frustum culling and distance striding want.
 *
 * The id interleaves the two axes into one integer via a bijective pairing on
 * the folded (non-negative) cell coordinates, so distinct cells never collide
 * and the value is stable across loads.
 */
export function renderCellOfPosition(x: number, z: number, sizeM = RENDER_CELL_SIZE_M): number {
  const size = sizeM > 0 ? sizeM : RENDER_CELL_SIZE_M;
  const cx = Math.floor((Number.isFinite(x) ? x : 0) / size);
  const cz = Math.floor((Number.isFinite(z) ? z : 0) / size);
  // Fold signed coordinates onto naturals (0,-1,1,-2,... -> 0,1,2,3,...) so the
  // pairing stays collision-free either side of the origin, which the city
  // straddles.
  const fx = cx >= 0 ? cx * 2 : -cx * 2 - 1;
  const fz = cz >= 0 ? cz * 2 : -cz * 2 - 1;
  // Cantor pairing: unique per (fx, fz).
  return ((fx + fz) * (fx + fz + 1)) / 2 + fz;
}

/**
 * Groups slots into render cells by position.
 *
 * `xz` is indexed by slot: `[slot * 2]` is x, `[slot * 2 + 1]` is z.
 *
 * The cell grid is anchored at the group's own minimum corner, not at the world
 * origin. Anchoring globally would let an arbitrary boundary fall through a
 * small building and shatter it into four batches for no benefit -- and which
 * buildings suffered that would depend on where the city grid happened to drop
 * them. Anchored to the group, anything that fits inside a cell is always
 * exactly one batch, and only a group genuinely larger than a cell splits.
 *
 * Returned in ascending cell-id order so mesh indices are deterministic across
 * loads -- the stagger phase is derived from the mesh index, and a phase that
 * reshuffled per session would make render behaviour unreproducible between a
 * measurement run and the run it is compared against.
 */
export function partitionSlotsByCell(
  xz: Float32Array,
  slots: readonly number[],
  sizeM = RENDER_CELL_SIZE_M,
): Map<number, number[]> {
  let minX = Infinity;
  let minZ = Infinity;
  for (const slot of slots) {
    const x = xz[slot * 2];
    const z = xz[slot * 2 + 1];
    if (Number.isFinite(x) && x < minX) minX = x;
    if (Number.isFinite(z) && z < minZ) minZ = z;
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minZ)) minZ = 0;

  const byCell = new Map<number, number[]>();
  for (const slot of slots) {
    const cell = renderCellOfPosition(xz[slot * 2] - minX, xz[slot * 2 + 1] - minZ, sizeM);
    const existing = byCell.get(cell);
    if (existing) {
      existing.push(slot);
    } else {
      byCell.set(cell, [slot]);
    }
  }
  return new Map([...byCell.entries()].sort((a, b) => a[0] - b[0]));
}
