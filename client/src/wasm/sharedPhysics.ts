import init, { WasmSimWorld as RawWasmSimWorld, WasmClockSync, WasmLocalSession } from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
import { installWasmSimWorldCompat } from './compat';

let initialized = false;
type WasmSimWorldInstance = InstanceType<typeof RawWasmSimWorld> & {
  seedDemoTerrain(): number;
  syncDynamicBody(
    id: number,
    shapeType: number,
    hx: number,
    hy: number,
    hz: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
  ): void;
  getDynamicBodyState(id: number): number[];
  reconcileDynamicBody(
    id: number,
    shapeType: number,
    hx: number,
    hy: number,
    hz: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    vx: number,
    vy: number,
    vz: number,
    wx: number,
    wy: number,
    wz: number,
    posThreshold: number,
    rotThreshold: number,
    hardSnapDistance: number,
    hardSnapRotRad: number,
    correctionTime: number,
  ): boolean;
  castDynamicBodyRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxToi: number,
  ): number[];
  applyDynamicBodyImpulse(
    id: number,
    ix: number,
    iy: number,
    iz: number,
    px: number,
    py: number,
    pz: number,
  ): boolean;
  stepDynamics(dt: number): void;
  getVehicleDebug(id: number): number[];
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
