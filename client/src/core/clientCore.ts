/**
 * The shared client core (client-core, built for the browser by client-core-wasm): the Rust the
 * Unreal client links natively. The web adopts it one module at a time, each behind a flag with a
 * parity test against the TypeScript it replaces; nothing here loads unless a flag asks for it.
 *
 * - `?coreGeometry=1` (or `VITE_CORE_GEOMETRY=1`): chunk hulls from the core's quickhull instead of
 *   three's ConvexGeometry (city/chunkGeometry.ts; parity in clientCore.test.ts).
 * - `?coreInput=1` (or `VITE_CORE_INPUT=1`): the 60 Hz input frames from the core's bundler
 *   (runtime/fixedInputBundler.ts; parity in fixedInputBundler.core.test.ts).
 * - `?coreAudio=1` (or `VITE_CORE_AUDIO=1`): each sound event's voices from the core's recipe and
 *   the debris beds from the core's (audio/voicePlan.ts, audio/coreActivity.ts; parity in
 *   audio/voicePlan.core.test.ts, audio/coreActivity.test.ts).
 * - `?corePredictor=1` (or `VITE_CORE_PREDICTOR=1`): the local player's presentation lead from the
 *   core (physics/thinAuthoritativePredictor.ts; parity in thinAuthoritativePredictor.core.test.ts).
 * - `?coreStream=1` (or `VITE_CORE_STREAM=1`): the wire 4 city stream built by the core from the
 *   manifest's bytes (city/perPlayerWasm.ts; parity in city/perPlayerWasm.core.test.ts).
 * - `?coreGrass=1`: grass patches from the core, in the grass worker (core/coreFlags.ts).
 */
import init, { convex_hull_triangles, core_city_stream, CoreInputBundler, CorePlayerInterpolator, CorePredictor } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { provideCorePlayerInterpolator } from '../net/interpolation';
import { provideBinaryManifestDecoder } from '../city/manifestBinary';
import { decodeManifestCore } from '../city/manifestCore';
import { provideCoreHullTriangles } from '../city/chunkGeometry';
import { provideCoreInputBundler } from '../runtime/fixedInputBundler';
import { coreVoicePlan } from '../audio/coreVoicePlan';
import { provideVoicePlanner } from '../audio/voicePlan';
import { provideCoreActivity } from '../audio/coreActivity';
import { provideCorePredictor } from '../physics/thinAuthoritativePredictor';
import { provideCoreCityStream } from '../city/perPlayerWasm';
import type { PerPlayerCore } from '../city/perPlayerCityClient';

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

export function corePredictorEnabled(): boolean {
  return flag('corePredictor', import.meta.env?.VITE_CORE_PREDICTOR);
}

/** The local player's predictor from the core (needs the WASM loaded). */
export function corePredictor(): CorePredictor {
  return new CorePredictor();
}

export function coreStreamEnabled(): boolean {
  return flag('coreStream', import.meta.env?.VITE_CORE_STREAM);
}

/** The wire 4 city stream for a binary manifest, built by the core (needs the WASM loaded). */
export function coreCityStream(manifest: Uint8Array, simHz: number, gravityY: number, delayTicks: number): PerPlayerCore {
  return core_city_stream(manifest, simHz, gravityY, delayTicks) as unknown as PerPlayerCore;
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
  if (!coreGeometryEnabled() && !coreInputEnabled() && !coreAudioEnabled() && !corePlayersEnabled() && !coreManifestEnabled() && !corePredictorEnabled() && !coreStreamEnabled()) return Promise.resolve();
  loading ??= init().then(() => {
    if (coreGeometryEnabled()) provideCoreHullTriangles(coreHullTriangles);
    if (coreInputEnabled()) provideCoreInputBundler(coreInputBundler);
    if (coreAudioEnabled()) {
      provideVoicePlanner(coreVoicePlan);
      provideCoreActivity();
    }
    if (corePlayersEnabled()) provideCorePlayerInterpolator(corePlayerInterpolator);
    if (coreManifestEnabled()) provideBinaryManifestDecoder(decodeManifestCore);
    if (corePredictorEnabled()) provideCorePredictor(corePredictor);
    if (coreStreamEnabled()) provideCoreCityStream(coreCityStream);
  });
  return loading;
}
