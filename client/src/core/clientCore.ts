/**
 * The shared client core (client-core, built for the browser by client-core-wasm): the Rust the
 * Unreal client links natively. The web adopts it one module at a time, each behind a flag with a
 * parity test against the TypeScript it replaces; nothing here loads unless a flag asks for it.
 *
 * - `?coreGeometry=1` (or `VITE_CORE_GEOMETRY=1`): chunk hulls from the core's quickhull instead of
 *   three's ConvexGeometry (city/chunkGeometry.ts; parity in clientCore.test.ts).
 * - `?coreInput=1` (or `VITE_CORE_INPUT=1`): the 60 Hz input frames from the core's bundler
 *   (runtime/fixedInputBundler.ts; parity in fixedInputBundler.core.test.ts).
 * - `?coreAudio=1` (or `VITE_CORE_AUDIO=1`): each sound event's voices from the core's recipe
 *   (audio/voicePlan.ts; parity in audio/voicePlan.core.test.ts).
 * - `?coreGrass=1`: grass patches from the core, in the grass worker (core/coreFlags.ts).
 */
import init, { convex_hull_triangles, CoreInputBundler, CorePlayerInterpolator } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { provideCorePlayerInterpolator } from '../net/interpolation';
import { provideBinaryManifestDecoder } from '../city/manifestBinary';
import { decodeManifestCore } from '../city/manifestCore';
import { provideCoreHullTriangles } from '../city/chunkGeometry';
import { provideCoreInputBundler } from '../runtime/fixedInputBundler';
import { coreVoicePlan } from '../audio/coreVoicePlan';
import { provideVoicePlanner } from '../audio/voicePlan';

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

export function coreInputEnabled(): boolean {
  return flag('coreInput', import.meta.env?.VITE_CORE_INPUT);
}

export function coreManifestEnabled(): boolean {
  return flag('coreManifest', import.meta.env?.VITE_CORE_MANIFEST);
}

export function corePlayersEnabled(): boolean {
  return flag('corePlayers', import.meta.env?.VITE_CORE_PLAYERS);
}

/** A remote-player interpolator from the core (needs the WASM loaded). */
export function corePlayerInterpolator(maxSamples: number): CorePlayerInterpolator {
  return new CorePlayerInterpolator(maxSamples);
}

export function coreAudioEnabled(): boolean {
  return flag('coreAudio', import.meta.env?.VITE_CORE_AUDIO);
}

/** A bundler from the core (needs the WASM loaded). */
export function coreInputBundler(fixedDtSec: number, maxCatchupSteps: number): CoreInputBundler {
  return new CoreInputBundler(fixedDtSec, maxCatchupSteps);
}

/** The core's hull for flat xyz points: nine floats per triangle, or undefined. Needs the WASM loaded. */
export function coreHullTriangles(points: Float32Array): Float32Array | undefined {
  const triangles = convex_hull_triangles(points);
  return triangles ?? undefined;
}

let loading: Promise<void> | null = null;

/** Load the core and install what the flags ask for. A no-op when no flag is on. */
export function initClientCore(): Promise<void> {
  if (!coreGeometryEnabled() && !coreInputEnabled() && !coreAudioEnabled() && !corePlayersEnabled() && !coreManifestEnabled()) return Promise.resolve();
  loading ??= init().then(() => {
    if (coreGeometryEnabled()) provideCoreHullTriangles(coreHullTriangles);
    if (coreInputEnabled()) provideCoreInputBundler(coreInputBundler);
    if (coreAudioEnabled()) provideVoicePlanner(coreVoicePlan);
    if (corePlayersEnabled()) provideCorePlayerInterpolator(corePlayerInterpolator);
    if (coreManifestEnabled()) provideBinaryManifestDecoder(decodeManifestCore);
  });
  return loading;
}
