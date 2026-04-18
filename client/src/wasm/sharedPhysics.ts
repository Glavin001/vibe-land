import init, {
  WasmSimWorld as RawWasmSimWorld,
  WasmClockSync,
  WasmLocalSession as RawWasmLocalSession,
  vehicle_chassis_half_extents as wasmVehicleChassisHalfExtents,
  vehicle_suspension_rest_length as wasmVehicleSuspensionRestLength,
  vehicle_wheel_offsets as wasmVehicleWheelOffsets,
  vehicle_wheel_radius as wasmVehicleWheelRadius,
} from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
import { installWasmSimWorldCompat } from './compat';

let initialized = false;
let initPromise: Promise<void> | null = null;

export type SharedVehicleGeometry = {
  chassisHalfExtents: { x: number; y: number; z: number };
  wheelOffsets: [number, number, number][];
  suspensionRestLengthM: number;
  wheelRadiusM: number;
};

const FALLBACK_VEHICLE_GEOMETRY: SharedVehicleGeometry = Object.freeze({
  chassisHalfExtents: Object.freeze({ x: 0.9, y: 0.3, z: 1.8 }),
  wheelOffsets: Object.freeze([
    Object.freeze([-0.9, 0.0, 1.1] as [number, number, number]),
    Object.freeze([0.9, 0.0, 1.1] as [number, number, number]),
    Object.freeze([-0.9, 0.0, -1.1] as [number, number, number]),
    Object.freeze([0.9, 0.0, -1.1] as [number, number, number]),
  ]) as [number, number, number][],
  suspensionRestLengthM: 0.3,
  wheelRadiusM: 0.35,
});

let sharedVehicleGeometry: SharedVehicleGeometry = FALLBACK_VEHICLE_GEOMETRY;

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
  pruneVehiclePendingInputsThrough(ackSeq: number): void;
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
};
type WasmSimWorldCtor = {
  new (): WasmSimWorldInstance;
  prototype: WasmSimWorldInstance;
};

type WasmLocalSessionInstance = InstanceType<typeof RawWasmLocalSession> & {
  enqueueInput(
    seq: number,
    buttons: number,
    moveX: number,
    moveY: number,
    yaw: number,
    pitch: number,
  ): void;
  queueFire(
    seq: number,
    shotId: number,
    weapon: number,
    clientFireTimeUs: number,
    clientInterpMs: number,
    clientDynamicInterpMs: number,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): void;
  enterVehicle(vehicleId: number): void;
  exitVehicle(vehicleId: number): void;
  getSnapshotMeta(): number[];
  getLocalPlayerState(): number[];
  getDynamicBodyStates(): number[];
  getVehicleStates(): number[];
  getBatteryStates(): number[];
  castSceneRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxToi: number,
  ): number[];
  getVehicleDebug(vehicleId: number): number[];
};

type WasmLocalSessionCtor = {
  new (worldJson?: string): WasmLocalSessionInstance;
  prototype: WasmLocalSessionInstance;
};

installWasmSimWorldCompat(RawWasmSimWorld);
const WasmSimWorld = RawWasmSimWorld as unknown as WasmSimWorldCtor;
const WasmLocalSession = RawWasmLocalSession as unknown as WasmLocalSessionCtor;

function readSharedVehicleGeometryFromWasm(): SharedVehicleGeometry {
  const halfExtents = Array.from(wasmVehicleChassisHalfExtents());
  const wheelOffsetsFlat = Array.from(wasmVehicleWheelOffsets());
  const wheelOffsets: [number, number, number][] = [];
  for (let i = 0; i < wheelOffsetsFlat.length; i += 3) {
    wheelOffsets.push([
      wheelOffsetsFlat[i] ?? 0,
      wheelOffsetsFlat[i + 1] ?? 0,
      wheelOffsetsFlat[i + 2] ?? 0,
    ]);
  }
  return {
    chassisHalfExtents: {
      x: halfExtents[0] ?? FALLBACK_VEHICLE_GEOMETRY.chassisHalfExtents.x,
      y: halfExtents[1] ?? FALLBACK_VEHICLE_GEOMETRY.chassisHalfExtents.y,
      z: halfExtents[2] ?? FALLBACK_VEHICLE_GEOMETRY.chassisHalfExtents.z,
    },
    wheelOffsets,
    suspensionRestLengthM: wasmVehicleSuspensionRestLength(),
    wheelRadiusM: wasmVehicleWheelRadius(),
  };
}

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      provideWasmClockSync(WasmClockSync);
      sharedVehicleGeometry = readSharedVehicleGeometryFromWasm();
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export function hydrateSharedVehicleGeometryFromLoadedWasm(): void {
  sharedVehicleGeometry = readSharedVehicleGeometryFromWasm();
}

export function getSharedVehicleGeometry(): SharedVehicleGeometry {
  return sharedVehicleGeometry;
}

export { WasmSimWorld, WasmClockSync, WasmLocalSession };
export type { WasmDebugRenderBuffers, WasmSimWorldInstance, WasmLocalSessionInstance };
