import init, { WasmSimWorld as RawWasmSimWorld, WasmClockSync, WasmLocalSession } from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
import { installWasmSimWorldCompat } from './compat';

let initialized = false;
let initPromise: Promise<void> | null = null;
type WasmDebugRenderBuffers = {
  vertices: Float32Array;
  colors: Float32Array;
};

type WasmSimWorldInstance = InstanceType<typeof RawWasmSimWorld> & {
  seedDemoTerrain(): number;
  loadWorldDocument(worldJson: string): void;
  syncBroadPhase(): void;
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
  getVehiclePendingCount(): number;
  clearPendingInputs(): void;
  debugRender(modeBits: number): WasmDebugRenderBuffers;
  syncRemoteVehicle(
    id: number,
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
  ): void;

  // ── Snap-machine API ────────────────────────────────────────────────
  spawnSnapMachine(
    id: number,
    envelopeJson: string,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void;
  setSnapMachineCollisionEnabled(id: number, enabled: boolean): void;
  removeSnapMachine(id: number): void;
  setLocalSnapMachine(machineId: number): void;
  clearLocalSnapMachine(): void;
  getSnapMachineBodyCount(id: number): number;
  /** \n-delimited list of action channel names in deterministic order. */
  getSnapMachineActionChannels(id: number): string;
  /** Machine display name (from `envelope.metadata.presetName`), empty if unknown. */
  getSnapMachineDisplayName(id: number): string;
  /**
   * Player-facing keyboard bindings for this machine's actions, one row per
   * action as `action\tposKey\tnegKey\tscale`. Empty if the machine is
   * unknown. The TS side parses this into `MachineBinding[]` on enter.
   */
  getSnapMachineBindings(id: number): string;
  /** Flat `[px, py, pz, qx, qy, qz, qw]` per body. */
  getSnapMachineBodyPoses(id: number): Float32Array;
  /** Flat `[index, px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz]` per body. */
  syncRemoteSnapMachine(id: number, bodiesFlat: Float32Array): void;
  tickSnapMachine(
    seq: number,
    channelsIn: Int8Array,
    yaw: number,
    pitch: number,
    dt: number,
  ): void;
  reconcileSnapMachine(
    ackSeq: number,
    bodiesFlat: Float32Array,
    dt: number,
  ): boolean;
  getSnapMachinePendingCount(): number;
};
type WasmSimWorldCtor = {
  new (): WasmSimWorldInstance;
  prototype: WasmSimWorldInstance;
};

installWasmSimWorldCompat(RawWasmSimWorld);
const WasmSimWorld = RawWasmSimWorld as unknown as WasmSimWorldCtor;

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      provideWasmClockSync(WasmClockSync);
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export { WasmSimWorld, WasmClockSync, WasmLocalSession };
export type { WasmDebugRenderBuffers, WasmSimWorldInstance };
