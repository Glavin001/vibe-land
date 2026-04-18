import init, {
  WasmSimWorld as RawWasmSimWorld,
  WasmClockSync,
  WasmLocalSession as RawWasmLocalSession,
  vehicle_definitions_json as wasmVehicleDefinitionsJson,
} from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
import { installWasmSimWorldCompat } from './compat';

let initialized = false;
let initPromise: Promise<void> | null = null;

export type SharedVehicleDefinition = {
  vehicleType: number;
  key: string;
  name: string;
  chassisHalfExtents: { x: number; y: number; z: number };
  chassisHullVertices: [number, number, number][];
  wheelOffsets: [number, number, number][];
  suspensionRestLengthM: number;
  suspensionTravelM: number;
  wheelRadiusM: number;
};

type RawSharedVehicleDefinition = {
  vehicleType?: number;
  key?: string;
  name?: string;
  chassisHalfExtents?: number[];
  chassisHullVertices?: number[][];
  wheelOffsets?: number[][];
  suspensionRestLengthM?: number;
  suspensionTravelM?: number;
  wheelRadiusM?: number;
};

const FALLBACK_SHARED_VEHICLE_DEFINITIONS: SharedVehicleDefinition[] = [
  {
    vehicleType: 0,
    key: 'delorean',
    name: 'DeLorean',
    chassisHalfExtents: { x: 0.9, y: 0.3, z: 1.8 },
    chassisHullVertices: [
      [-0.9, -0.30, -1.80],
      [-0.9, -0.30, 1.80],
      [-0.9, -0.05, 1.80],
      [-0.9, 0.10, 0.55],
      [-0.9, 0.30, 0.05],
      [-0.9, 0.30, -0.90],
      [-0.9, 0.05, -1.25],
      [-0.9, 0.05, -1.80],
      [0.9, -0.30, -1.80],
      [0.9, -0.30, 1.80],
      [0.9, -0.05, 1.80],
      [0.9, 0.10, 0.55],
      [0.9, 0.30, 0.05],
      [0.9, 0.30, -0.90],
      [0.9, 0.05, -1.25],
      [0.9, 0.05, -1.80],
    ],
    wheelOffsets: [
      [-0.9, 0.0, 1.1],
      [0.9, 0.0, 1.1],
      [-0.9, 0.0, -1.1],
      [0.9, 0.0, -1.1],
    ],
    suspensionRestLengthM: 0.3,
    suspensionTravelM: 0.2,
    wheelRadiusM: 0.35,
  },
  {
    vehicleType: 1,
    key: 'cybertruck',
    name: 'Cybertruck',
    chassisHalfExtents: { x: 0.9, y: 0.3, z: 1.8 },
    chassisHullVertices: [
      [-0.9, -0.30, -1.80],
      [-0.9, -0.30, 1.80],
      [-0.9, 0.02, 1.80],
      [-0.9, 0.18, 1.35],
      [-0.9, 0.36, 0.95],
      [-0.9, 0.31, 0.10],
      [-0.9, 0.21, -0.95],
      [-0.9, 0.10, -1.80],
      [0.9, -0.30, -1.80],
      [0.9, -0.30, 1.80],
      [0.9, 0.02, 1.80],
      [0.9, 0.18, 1.35],
      [0.9, 0.36, 0.95],
      [0.9, 0.31, 0.10],
      [0.9, 0.21, -0.95],
      [0.9, 0.10, -1.80],
    ],
    wheelOffsets: [
      [-0.9, 0.0, 1.1],
      [0.9, 0.0, 1.1],
      [-0.9, 0.0, -1.1],
      [0.9, 0.0, -1.1],
    ],
    suspensionRestLengthM: 0.3,
    suspensionTravelM: 0.2,
    wheelRadiusM: 0.35,
  },
];

export const DEFAULT_SHARED_VEHICLE_TYPE = FALLBACK_SHARED_VEHICLE_DEFINITIONS[0]?.vehicleType ?? 0;

let sharedVehicleDefinitions: SharedVehicleDefinition[] = FALLBACK_SHARED_VEHICLE_DEFINITIONS;
let sharedVehicleDefinitionByType = new Map<number, SharedVehicleDefinition>(
  sharedVehicleDefinitions.map((definition) => [definition.vehicleType, definition]),
);

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

function normalizeTriples(
  source: number[][] | undefined,
  fallback: [number, number, number][],
): [number, number, number][] {
  if (!Array.isArray(source) || source.length === 0) {
    return fallback;
  }
  return source.map((triple, index) => [
    triple?.[0] ?? fallback[index]?.[0] ?? 0,
    triple?.[1] ?? fallback[index]?.[1] ?? 0,
    triple?.[2] ?? fallback[index]?.[2] ?? 0,
  ]);
}

function normalizeSharedVehicleDefinition(
  raw: RawSharedVehicleDefinition,
  fallback: SharedVehicleDefinition,
): SharedVehicleDefinition {
  const halfExtents = raw.chassisHalfExtents;
  return {
    vehicleType: Math.trunc(raw.vehicleType ?? fallback.vehicleType),
    key: raw.key ?? fallback.key,
    name: raw.name ?? fallback.name,
    chassisHalfExtents: {
      x: halfExtents?.[0] ?? fallback.chassisHalfExtents.x,
      y: halfExtents?.[1] ?? fallback.chassisHalfExtents.y,
      z: halfExtents?.[2] ?? fallback.chassisHalfExtents.z,
    },
    chassisHullVertices: normalizeTriples(raw.chassisHullVertices, fallback.chassisHullVertices),
    wheelOffsets: normalizeTriples(raw.wheelOffsets, fallback.wheelOffsets),
    suspensionRestLengthM: raw.suspensionRestLengthM ?? fallback.suspensionRestLengthM,
    suspensionTravelM: raw.suspensionTravelM ?? fallback.suspensionTravelM,
    wheelRadiusM: raw.wheelRadiusM ?? fallback.wheelRadiusM,
  };
}

function setSharedVehicleDefinitions(definitions: SharedVehicleDefinition[]): void {
  sharedVehicleDefinitions = definitions.length > 0 ? definitions : FALLBACK_SHARED_VEHICLE_DEFINITIONS;
  sharedVehicleDefinitionByType = new Map(
    sharedVehicleDefinitions.map((definition) => [definition.vehicleType, definition]),
  );
}

function readSharedVehicleDefinitionsFromWasm(): SharedVehicleDefinition[] {
  try {
    const rawDefinitions = JSON.parse(wasmVehicleDefinitionsJson()) as RawSharedVehicleDefinition[];
    if (!Array.isArray(rawDefinitions) || rawDefinitions.length === 0) {
      return FALLBACK_SHARED_VEHICLE_DEFINITIONS;
    }
    return rawDefinitions.map((raw, index) => normalizeSharedVehicleDefinition(
      raw,
      FALLBACK_SHARED_VEHICLE_DEFINITIONS[index] ?? FALLBACK_SHARED_VEHICLE_DEFINITIONS[0],
    ));
  } catch {
    return FALLBACK_SHARED_VEHICLE_DEFINITIONS;
  }
}

export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      provideWasmClockSync(WasmClockSync);
      setSharedVehicleDefinitions(readSharedVehicleDefinitionsFromWasm());
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export function hydrateSharedVehicleGeometryFromLoadedWasm(): void {
  setSharedVehicleDefinitions(readSharedVehicleDefinitionsFromWasm());
}

export function getSharedVehicleDefinitions(): SharedVehicleDefinition[] {
  return sharedVehicleDefinitions;
}

export function getSharedVehicleDefinition(vehicleType?: number | null): SharedVehicleDefinition {
  const resolvedType = Math.trunc(vehicleType ?? DEFAULT_SHARED_VEHICLE_TYPE);
  return sharedVehicleDefinitionByType.get(resolvedType)
    ?? sharedVehicleDefinitionByType.get(DEFAULT_SHARED_VEHICLE_TYPE)
    ?? FALLBACK_SHARED_VEHICLE_DEFINITIONS[0];
}

export function getSharedVehicleTypeByKey(key: string): number | null {
  const match = sharedVehicleDefinitions.find((definition) => definition.key === key);
  return match?.vehicleType ?? null;
}

export function getSharedVehicleDefaultType(): number {
  return DEFAULT_SHARED_VEHICLE_TYPE;
}

export function getSharedVehicleGeometry(): SharedVehicleDefinition {
  return getSharedVehicleDefinition(DEFAULT_SHARED_VEHICLE_TYPE);
}

export { WasmSimWorld, WasmClockSync, WasmLocalSession };
export type { WasmDebugRenderBuffers, WasmSimWorldInstance, WasmLocalSessionInstance };
