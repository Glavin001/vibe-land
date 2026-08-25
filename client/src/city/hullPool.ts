// A shared library of fracture-shard shapes, so hulls can be instanced.
//
// Downtown's manifest is 16,945 box chunks and 7,160 convex hulls, and every
// one of those hulls is a DISTINCT shape -- they are all `wall` nodes, Voronoi
// fractured panel by panel, so no two shards are alike. Unique shapes cannot be
// instanced, which is why they are the whole of the renderer's remaining
// per-instance sub-draw cost.
//
// This module answers the question "what if they were not unique". It picks
// `poolSize` representative shards out of the manifest's own set and assigns
// every hull chunk one of them, rescaled to the chunk's own bounding radius so
// nothing changes size. Draw cost then collapses from one sub-draw per shard to
// one instanced draw per pattern.
//
// Deliberately a render-side substitution, not a pipeline change. The pack is
// untouched, the server still simulates the true hulls, and the pool size is a
// live knob -- which is what makes the diversity-versus-cost trade something
// you can look at rather than rebuild for.
//
// THE FIDELITY COST IS SEVERE, AND THIS IS WHY THE DEFAULT IS OFF.
//
// A wall's real shards are a Voronoi partition OF THAT WALL: each one is cut to
// fit its neighbours, and together they tile the panel exactly. That mutual fit
// is the entire reason an undamaged wall reads as flat. Substituting a shard of
// a different shape at the same centroid destroys it, and not subtly -- looked
// at (tools/pool-compare.mjs, pool 64 against exact) an INTACT downtown comes
// out looking pre-demolished, every facade a mess of protruding spikes. It is
// not a seam artifact; it is the whole surface.
//
// So this is an instrument, not a shipping look. It measures exactly what
// instancing the hulls would be worth -- and the answer is a lot, which is what
// makes the idea worth doing PROPERLY. The fidelity-preserving version pools at
// the PANEL level during authoring: precompute N fracture patterns for a wall
// panel, and stamp a whole pattern onto each panel so the shards that land
// together are the ones cut to fit together. The jigsaw survives, and every
// panel using pattern k shares geometry with every other panel using pattern k,
// which is what instancing needs. See docs/city-render-subdraws-2026-08-25.md.
//
// No WebGL here: the selection is plain data so it can be unit tested, the same
// way chunkGeometry is kept apart from the React layer.

/** One shard shape in the library. Points are centroid-relative and metric. */
export type HullPattern = {
  key: string;
  points: Float32Array;
  /** Farthest point from the centroid; what per-chunk scale is derived from. */
  radius: number;
};

export type HullPoolAssignment = {
  patterns: HullPattern[];
  /**
   * Hull slot -> index into `patterns`; -1 for any slot that is not a pooled
   * hull, which includes every box and every slot when pooling is off.
   */
  patternOfSlot: Int32Array;
  /**
   * Uniform render scale for a pooled slot, so the substituted shard occupies
   * the same volume as the shard it replaced. 0 for unpooled slots.
   */
  scaleOfSlot: Float32Array;
};

/** Farthest point from the origin. Hull points are already centroid-relative. */
export function patternRadius(points: Float32Array): number {
  let worst = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const d = Math.hypot(points[i], points[i + 1], points[i + 2]);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Stable per-slot pattern choice.
 *
 * A hash rather than a counter so the assignment does not shift when an
 * unrelated chunk is added, and so two loads of the same manifest produce the
 * same city -- a pool that reshuffled per session would make a look comparison
 * between two pool sizes meaningless.
 */
function mix32(value: number): number {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

export type HullPoolInput = {
  /** Total chunk slots, pooled or not. */
  slotCount: number;
  /** Slots whose authored shape is a convex hull, in any stable order. */
  hullSlots: readonly number[];
  /** The authored shard for a hull slot. */
  shapeOf: (slot: number) => { key: string; points: Float32Array };
  /** Bounding radius of the chunk that occupies this slot. */
  radiusOf: (slot: number) => number;
  /**
   * Patterns to keep. 0 (or less) disables pooling entirely and every slot
   * comes back unassigned, which is the caller's signal to draw the real hulls.
   */
  poolSize: number;
};

/**
 * Chooses the library and assigns it.
 *
 * Patterns are sampled at an even stride through the distinct shards rather
 * than taken from the front. The manifest lists chunks structure by structure
 * and floor by floor, so the first N shards all come from one corner of one
 * building; strided, the library spans the whole city's shard population and
 * keeps its size and shape distribution.
 */
export function buildHullPool(input: HullPoolInput): HullPoolAssignment {
  const patternOfSlot = new Int32Array(input.slotCount).fill(-1);
  const scaleOfSlot = new Float32Array(input.slotCount);
  if (input.poolSize <= 0 || input.hullSlots.length === 0) {
    return { patterns: [], patternOfSlot, scaleOfSlot };
  }

  // Distinct shards, in slot order, so selection is deterministic.
  const distinct: Array<{ key: string; points: Float32Array }> = [];
  const seen = new Set<string>();
  for (const slot of input.hullSlots) {
    const shape = input.shapeOf(slot);
    if (seen.has(shape.key)) continue;
    seen.add(shape.key);
    distinct.push(shape);
  }

  const wanted = Math.min(Math.floor(input.poolSize), distinct.length);
  const patterns: HullPattern[] = [];
  for (let i = 0; i < wanted; i += 1) {
    // Even stride across the distinct set; floor of a rational index so the
    // first and last shards are both reachable.
    const shape = distinct[Math.floor((i * distinct.length) / wanted)];
    const radius = patternRadius(shape.points);
    // A degenerate shard would divide by zero below and blow every chunk that
    // drew it up to infinity. Skip it; the pool is simply one smaller.
    if (!(radius > 0)) continue;
    patterns.push({ key: shape.key, points: shape.points, radius });
  }
  if (patterns.length === 0) {
    return { patterns: [], patternOfSlot, scaleOfSlot };
  }

  for (const slot of input.hullSlots) {
    const index = mix32(slot) % patterns.length;
    patternOfSlot[slot] = index;
    const radius = input.radiusOf(slot);
    // Match the chunk's own size. Falling back to 1 keeps a chunk with no
    // usable radius at the pattern's authored size rather than collapsing it.
    scaleOfSlot[slot] = radius > 0 ? radius / patterns[index].radius : 1;
  }

  return { patterns, patternOfSlot, scaleOfSlot };
}
