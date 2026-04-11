import init, { WasmSimWorld as RawWasmSimWorld, WasmClockSync, WasmLocalSession } from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
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

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  await init();
  provideWasmClockSync(WasmClockSync);
  initialized = true;
}

export { WasmSimWorld, WasmClockSync, WasmLocalSession };
export type { WasmSimWorldInstance };
