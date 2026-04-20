import init, {
  WasmSimWorld as RawWasmSimWorld,
  WasmClockSync,
  WasmLocalSession as RawWasmLocalSession,
  player_navigation_profile as wasmPlayerNavigationProfile,
  vehicle_definitions_json as wasmVehicleDefinitionsJson,
} from './pkg/vibe_land_shared.js';
import { provideWasmClockSync } from '../net/interpolation';
import { installWasmSimWorldCompat } from './compat';
import {
  DEFAULT_SHARED_VEHICLE_TYPE,
  type SharedVehicleDefinition,
  getSharedVehicleDefinition,
  getSharedVehicleDefinitions,
  getSharedVehicleDefaultType,
  getSharedVehicleGeometry,
  getSharedVehicleTypeByKey,
  hydrateSharedVehicleDefinitions,
} from './sharedVehicleDefinitions';

let initialized = false;
let initPromise: Promise<void> | null = null;

export type SharedPlayerNavigationProfile = {
  walkableRadius: number;
  walkableHeight: number;
  walkableClimb: number;
  walkableSlopeAngleDegrees: number;
};
let sharedPlayerNavigationProfile: SharedPlayerNavigationProfile | null = null;
type WasmDebugRenderBuffers = {
  vertices: Float32Array;
  colors: Float32Array; // RGB, 3 floats per endpoint
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
  debugRender(modeBits: number): number; // returns vertex (endpoint) count
  debugRenderPositions(): Float32Array; // zero-copy view, valid until next debugRender call
  debugRenderColors(): Float32Array; // zero-copy RGB view, valid until next debugRender call
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

  // ── Client-local ragdoll bodies ──────────────────────────────────────────
  spawnRagdollBody(
    id: number,
    hx: number, hy: number, hz: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    vx: number, vy: number, vz: number,
    wx: number, wy: number, wz: number,
  ): void;
  removeRagdollBody(id: number): void;
  /** Returns [px, py, pz, qx, qy, qz, qw] or empty array. */
  getRagdollBodyState(id: number): Float64Array;
  setRagdollBodyVelocity(
    id: number,
    vx: number, vy: number, vz: number,
    wx: number, wy: number, wz: number,
  ): void;
  createRagdollSphericalJoint(
    jointId: number, b1Id: number, b2Id: number,
    a1x: number, a1y: number, a1z: number,
    a2x: number, a2y: number, a2z: number,
  ): void;
  createRagdollRevoluteJoint(
    jointId: number, b1Id: number, b2Id: number,
    a1x: number, a1y: number, a1z: number,
    a2x: number, a2y: number, a2z: number,
    ax: number, ay: number, az: number,
    limitMin: number, limitMax: number,
  ): void;
  removeRagdollJoint(jointId: number): void;
};
type WasmSimWorldCtor = {
  new (): WasmSimWorldInstance;
  prototype: WasmSimWorldInstance;
};

type WasmLocalSessionInstance = InstanceType<typeof RawWasmLocalSession> & {
  connectBot(botId: number): boolean;
  disconnectBot(botId: number): boolean;
  handleBotPacket(botId: number, bytes: Uint8Array): void;
  setBotMaxSpeed(botId: number, maxSpeed: number): boolean;
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
  queueMelee(
    seq: number,
    swingId: number,
    clientTimeUs: number,
    yaw: number,
    pitch: number,
  ): void;
  enterVehicle(vehicleId: number): void;
  exitVehicle(vehicleId: number): void;
  getSnapshotMeta(): number[];
  getLocalPlayerState(): number[];
  getRemotePlayerStates(): number[];
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
  classifyHitscanPlayer(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    bodyX: number,
    bodyY: number,
    bodyZ: number,
    blockerToi: number,
  ): number[];
  getVehicleDebug(vehicleId: number): number[];
  drainPackets(): Uint8Array;

  // ── Client-local ragdoll bodies ──────────────────────────────────────────
  spawnRagdollBody(
    id: number,
    hx: number, hy: number, hz: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    vx: number, vy: number, vz: number,
    wx: number, wy: number, wz: number,
  ): void;
  removeRagdollBody(id: number): void;
  /** Returns [px, py, pz, qx, qy, qz, qw] or empty array. */
  getRagdollBodyState(id: number): Float64Array;
  setRagdollBodyVelocity(
    id: number,
    vx: number, vy: number, vz: number,
    wx: number, wy: number, wz: number,
  ): void;
  createRagdollSphericalJoint(
    jointId: number, b1Id: number, b2Id: number,
    a1x: number, a1y: number, a1z: number,
    a2x: number, a2y: number, a2z: number,
  ): void;
  createRagdollRevoluteJoint(
    jointId: number, b1Id: number, b2Id: number,
    a1x: number, a1y: number, a1z: number,
    a2x: number, a2y: number, a2z: number,
    ax: number, ay: number, az: number,
    limitMin: number, limitMax: number,
  ): void;
  removeRagdollJoint(jointId: number): void;
};

type WasmLocalSessionCtor = {
  new (worldJson?: string): WasmLocalSessionInstance;
  prototype: WasmLocalSessionInstance;
};

installWasmSimWorldCompat(RawWasmSimWorld);
const WasmSimWorld = RawWasmSimWorld as unknown as WasmSimWorldCtor;
const WasmLocalSession = RawWasmLocalSession as unknown as WasmLocalSessionCtor;

function readSharedPlayerNavigationProfileFromWasm(): SharedPlayerNavigationProfile {
  const raw = wasmPlayerNavigationProfile();
  const profile: SharedPlayerNavigationProfile = {
    walkableRadius: raw[0] ?? 0,
    walkableHeight: raw[1] ?? 0,
    walkableClimb: raw[2] ?? 0,
    walkableSlopeAngleDegrees: raw[3] ?? 0,
  };
  return Object.freeze(profile);
}
export async function initSharedPhysics(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      provideWasmClockSync(WasmClockSync);
      sharedPlayerNavigationProfile = readSharedPlayerNavigationProfileFromWasm();
      hydrateSharedVehicleDefinitions(wasmVehicleDefinitionsJson());
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export function hydrateSharedVehicleGeometryFromLoadedWasm(): void {
  hydrateSharedVehicleDefinitions(wasmVehicleDefinitionsJson());
}

export function hydrateSharedPlayerNavigationProfileFromLoadedWasm(): void {
  sharedPlayerNavigationProfile = readSharedPlayerNavigationProfileFromWasm();
}

export function getSharedPlayerNavigationProfile(): SharedPlayerNavigationProfile {
  if (!sharedPlayerNavigationProfile) {
    throw new Error('Shared physics is not initialized; player navigation profile is unavailable.');
  }
  return sharedPlayerNavigationProfile;
}

export async function getSharedPlayerNavigationProfileAsync(): Promise<SharedPlayerNavigationProfile> {
  await initSharedPhysics();
  return getSharedPlayerNavigationProfile();
}

export { WasmSimWorld, WasmClockSync, WasmLocalSession };
export {
  DEFAULT_SHARED_VEHICLE_TYPE,
  getSharedVehicleDefinition,
  getSharedVehicleDefinitions,
  getSharedVehicleDefaultType,
  getSharedVehicleGeometry,
  getSharedVehicleTypeByKey,
};
export type { WasmDebugRenderBuffers, WasmSimWorldInstance, WasmLocalSessionInstance };
