/**
 * WASM initialization helper for vitest (Node.js environment).
 * Uses initSync to load the WASM binary synchronously from disk.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initSync, WasmSimWorld } from './pkg/vibe_land_shared.js';

let initialized = false;

export function initWasmForTests(): void {
  if (initialized) return;
  const dir = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(dir, 'pkg', 'vibe_land_shared_bg.wasm');
  const wasmBytes = readFileSync(wasmPath);
  initSync(wasmBytes);
  initialized = true;
}

export { WasmSimWorld };
