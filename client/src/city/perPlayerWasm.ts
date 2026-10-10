/**
 * Loads the per-player client core (perplayer/, wasm-pack `--target web`
 * into src/wasm/perplayer-pkg) and builds one for a manifest.
 */
import init, { initSync, PerPlayerClient } from '../wasm/perplayer-pkg/vibe_land_perplayer.js';
import type { LoadedCityManifest } from './manifest';
import { perPlayerCoreArgs, type PerPlayerCore } from './perPlayerCityClient';

let ready: Promise<void> | null = null;

/** In the browser, fetch and instantiate once; under Node pass the bytes. */
export function initPerPlayerWasm(bytes?: BufferSource): Promise<void> {
  if (bytes) {
    initSync({ module: bytes });
    ready = Promise.resolve();
    return ready;
  }
  ready ??= init().then(() => undefined);
  return ready;
}

/** The world's gravity (vibe_netcode::movement::GRAVITY), m/s^2, down. */
const GRAVITY_Y = -9.81;

export function createPerPlayerCore(
  manifest: LoadedCityManifest,
  simHz = 60,
  delayTicks = 5,
): PerPlayerCore {
  const a = perPlayerCoreArgs(manifest.manifest);
  return new PerPlayerClient(a.ids, a.poses, a.nodeCounts, a.bondCounts, a.nodes, a.bonds, simHz, GRAVITY_Y, delayTicks) as unknown as PerPlayerCore;
}
