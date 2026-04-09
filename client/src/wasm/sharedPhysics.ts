import init, { WasmSimWorld, WasmClockSync } from '../../pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';

let initialized = false;

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  await init();
  provideWasmClockSync(WasmClockSync);
  initialized = true;
}

export { WasmSimWorld, WasmClockSync };
