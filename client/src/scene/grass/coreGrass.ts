// The web's grass placement from the shared client core (client-core grass.rs, through
// client-core-wasm): the code the Unreal client's meadow runs natively. Behind `?coreGrass=1`;
// parity with generateGrassPatch in coreGrass.test.ts.
import init, { CoreGrassPaint, grass_patch } from '../../wasm/core-pkg/vibe_client_core_wasm.js';
import type { GrassPaintDocument } from './GrassPaint';
import { GRASS_PROFILES, type GrassExclusion, type GrassPatchData, type GrassQuality } from './grassPlacement';

let loading: Promise<boolean> | null = null;

/** Load the core's WASM once (in whichever context generates patches). False if it cannot load. */
export function loadCoreGrass(): Promise<boolean> {
  loading ??= init().then(() => true, () => false);
  return loading;
}

/** `generateGrassPatch` with the core: the same packed patch (needs loadCoreGrass first). */
export function generateCoreGrassPatch(px: number, pz: number, quality: GrassQuality,
  exclusions: readonly GrassExclusion[], paint: GrassPaintDocument): GrassPatchData {
  const boxes = new Float32Array(exclusions.length * 4);
  exclusions.forEach((b, i) => boxes.set([b.minX, b.minZ, b.maxX, b.maxZ], i * 4));
  const corePaint = paint.tiles.length ? new CoreGrassPaint(JSON.stringify(paint)) : undefined;
  const patch = grass_patch(px, pz, GRASS_PROFILES[quality].density, boxes, corePaint);
  const data: GrassPatchData = { roots: patch.roots(), shapes: patch.shapes(), colors: patch.colors(),
    traits: patch.traits(), maxHeight: patch.max_height, count: patch.count };
  patch.free();
  return data;
}
