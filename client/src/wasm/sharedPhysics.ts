import init, { WasmSimWorld } from './pkg/vibe_land_shared.js';

let initialized = false;

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  await init();
  initialized = true;
}

export { WasmSimWorld };
