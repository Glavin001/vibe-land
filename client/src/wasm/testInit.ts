/**
 * WASM initialization helper for vitest (Node.js environment).
 * Uses initSync to load the WASM binary synchronously from disk.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSync, WasmSimWorld as RawWasmSimWorld } from './pkg/vibe_land_shared.js';
import { installWasmSimWorldCompat } from './compat';

let initialized = false;
type WasmSimWorldInstance = InstanceType<typeof RawWasmSimWorld> & {
  seedDemoTerrain(): number;
};
type WasmSimWorldCtor = {
  new (): WasmSimWorldInstance;
  prototype: WasmSimWorldInstance;
};

installWasmSimWorldCompat(RawWasmSimWorld);
const WasmSimWorld = RawWasmSimWorld as unknown as WasmSimWorldCtor;

export function initWasmForTests(): void {
  if (initialized) return;
  const dir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(dir, 'pkg', 'vibe_land_shared_bg.wasm');
  const wasmBytes = readFileSync(wasmPath);
  initSync(wasmBytes);
  initialized = true;
}

export { WasmSimWorld };
export type { WasmSimWorldInstance };
