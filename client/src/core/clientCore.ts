/**
 * The shared client core (client-core, built for the browser by client-core-wasm): the Rust the
 * Unreal client links natively. The web adopts it one module at a time, each behind a flag with a
 * parity test against the TypeScript it replaces; nothing here loads unless a flag asks for it.
 *
 * - `?coreGeometry=1` (or `VITE_CORE_GEOMETRY=1`): chunk hulls from the core's quickhull instead of
 *   three's ConvexGeometry (city/chunkGeometry.ts; parity in clientCore.test.ts).
 */
import init, { convex_hull_triangles } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { provideCoreHullTriangles } from '../city/chunkGeometry';

function flag(urlName: string, envValue: string | undefined): boolean {
  if (envValue === '1') return true;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(urlName) === '1';
  } catch {
    return false;
  }
}

export function coreGeometryEnabled(): boolean {
  return flag('coreGeometry', import.meta.env?.VITE_CORE_GEOMETRY);
}

/** The core's hull for flat xyz points: nine floats per triangle, or undefined. Needs the WASM loaded. */
export function coreHullTriangles(points: Float32Array): Float32Array | undefined {
  const triangles = convex_hull_triangles(points);
  return triangles ?? undefined;
}

let loading: Promise<void> | null = null;

/** Load the core and install what the flags ask for. A no-op when no flag is on. */
export function initClientCore(): Promise<void> {
  if (!coreGeometryEnabled()) return Promise.resolve();
  loading ??= init().then(() => {
    provideCoreHullTriangles(coreHullTriangles);
  });
  return loading;
}
