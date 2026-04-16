import { useRef, useEffect, useMemo, type ReactNode, type RefObject } from 'react';
import { Sky } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameMode } from '../app/gameMode';
import { isPracticeMode } from '../app/gameMode';
import type { InputBindings } from '../input/bindings';
import type { CrosshairAimState } from './aimTargeting';
import type { RemotePlayer } from '../net/netcodeClient';
import { useGameRuntime } from '../runtime/useGameRuntime';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { GameInputManager } from '../input/manager';
import {
  advanceLookAngles,
  advanceVehicleCamera,
  resolveOnFootInput,
  resolveVehicleInput,
  VEHICLE_CAMERA_DEFAULT_PITCH,
} from '../input/resolver';
import type { InputFamilyMode, InputSample } from '../input/types';
import { isShotTraceActive, pickShotTraceIntercept, shotTraceColor, type LocalShotTrace, type RemoteShotHit } from './shotTrace';
import {
  aimDirectionFromAngles,
  BTN_CROUCH,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SPRINT,
  BLOCK_ADD,
  BLOCK_REMOVE,
  FLAG_DEAD,
  FLAG_IN_VEHICLE,
  HIT_ZONE_BODY,
  HIT_ZONE_HEAD,
  RIFLE_FIRE_INTERVAL_MS,
  WEAPON_HITSCAN,
} from '../net/protocol';
import type { NetVehicleState, VehicleStateMeters } from '../net/protocol';
import { netPlayerStateToMeters } from '../net/protocol';
import { createBotBrainState, stepBotBrain, type BotBrainState, type ObservedPlayer } from '../loadtest/brain';
import type { LoadTestScenario, PlayBenchmarkDriverProfile } from '../loadtest/scenario';
import { WorldTerrain } from './WorldTerrain';
import { WorldStaticProps } from './WorldStaticProps';
import {
  DEFAULT_WORLD_DOCUMENT,
  removeVehicleEntitiesFromWorldDocument,
  serializeWorldDocument,
  type WorldDocument,
} from '../world/worldDocument';
import {
  getVehicleChassisHalfExtents,
  getVehicleWheelConnectionOffsets,
  getVehicleWheelRadiusM,
  getVehicleWheelVisualAnchors,
} from './vehicleVisualGeometry';
import {
  resetLocalVehicleMeshPose,
  updateLocalVehicleMeshPose,
  type LocalVehicleVisualPoseState,
} from './vehicleLocalMeshPose';

const VEHICLE_INTERACT_RADIUS = 4.0;
const REMOTE_HIT_FLASH_MS = 180;
const CROSSHAIR_MAX_DISTANCE = 1000;
const PLAYER_EYE_HEIGHT = 0.8;
const LOCAL_SHOT_TRACE_TTL_MS = 90;
const LOCAL_SHOT_TRACE_MAX_DISTANCE = 80;
const LOCAL_SHOT_TRACE_BEAM_RADIUS = 0.015;
const LOCAL_SHOT_TRACE_IMPACT_RADIUS = 0.07;
const CAMERA_PSEUDO_MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.12, -0.35);
const VEHICLE_WHEEL_VISUAL_STEER_RATE = 18.0;

type FrameDebugCallback = (
  frameTimeMs: number,
  rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
  network: {
    pingMs: number;
    serverTick: number;
    interpolationDelayMs: number;
    dynamicBodyInterpolationDelayMs: number;
    clockOffsetUs: number;
    remotePlayers: number;
    transport: string;
    playerId: number;
  },
  debug: { rapierDebugLabel: string; rapierDebugModeBits: number },
  physics: {
    pendingInputs: number;
    predictionTicks: number;
    playerCorrectionMagnitude: number;
    vehicleCorrectionMagnitude: number;
    dynamicGlobalMaxCorrectionMagnitude: number;
    dynamicNearPlayerMaxCorrectionMagnitude: number;
    dynamicInteractiveMaxCorrectionMagnitude: number;
    dynamicOverThresholdCount: number;
    dynamicTrackedBodies: number;
    dynamicInteractiveBodies: number;
    lastDynamicShotBodyId: number;
    lastDynamicShotAgeMs: number;
    vehiclePendingInputs: number;
    vehicleAckSeq: number;
    vehicleLatestLocalSeq: number;
    vehiclePendingInputsAgeMs: number;
    vehicleAckBacklogMs: number;
    vehicleResendWindow: number;
    vehicleReplayErrorM: number;
    vehiclePosErrorM: number;
    vehicleVelErrorMs: number;
    vehicleRotErrorRad: number;
    vehicleCorrectionAgeMs: number;
    physicsStepMs: number;
    velocity: [number, number, number];
  },
  vehicle: {
    id: number;
    driverConfirmed: boolean;
    localSpeedMs: number;
    serverSpeedMs: number;
    posDeltaM: number;
    groundedWheels: number;
    steering: number;
    engineForce: number;
    brake: number;
    meshDeltaM: number;
    meshRotDeltaRad: number;
    meshDeltaRms5sM: number;
    meshDeltaPeak5sM: number;
    restJitterRms5sM: number;
    straightJitterRms5sM: number;
    rawHeaveDeltaRms5sM: number;
    rawHeaveDeltaPeak5sM: number;
    rawPlanarDeltaRms5sM: number;
    rawPlanarDeltaPeak5sM: number;
    rawYawDeltaRms5sRad: number;
    rawYawDeltaPeak5sRad: number;
    rawPitchDeltaRms5sRad: number;
    rawPitchDeltaPeak5sRad: number;
    rawRollDeltaRms5sRad: number;
    rawRollDeltaPeak5sRad: number;
    residualDeltaRms5sM: number;
    residualDeltaPeak5sM: number;
    residualPlanarDeltaRms5sM: number;
    residualPlanarDeltaPeak5sM: number;
    residualHeaveDeltaRms5sM: number;
    residualHeaveDeltaPeak5sM: number;
    residualYawDeltaRms5sRad: number;
    residualYawDeltaPeak5sRad: number;
    residualPitchDeltaRms5sRad: number;
    residualPitchDeltaPeak5sRad: number;
    residualRollDeltaRms5sRad: number;
    residualRollDeltaPeak5sRad: number;
    rawRestHeaveDeltaRms5sM: number;
    rawStraightHeaveDeltaRms5sM: number;
    wheelContactBits: number;
    wheelContactBitChanges5s: number;
    wheelContactNormals: Array<[number, number, number]>;
    wheelContactNormalDeltaRms5sRad: number;
    wheelGroundObjectIds: [number, number, number, number];
    wheelGroundObjectSwitches5s: number;
    suspensionLengths: [number, number, number, number];
    suspensionForces: [number, number, number, number];
    suspensionRelativeVelocities: [number, number, number, number];
    suspensionLengthSpreadM: number;
    suspensionLengthSpreadPeak5sM: number;
    suspensionLengthDeltaRms5sM: number;
    suspensionForceSpreadN: number;
    suspensionForceSpreadPeak5sN: number;
    suspensionForceDeltaRms5sN: number;
    meshFrameDeltaRms5sM: number;
    meshFrameDeltaPeak5sM: number;
    meshFrameRotDeltaRms5sRad: number;
    meshFrameRotDeltaPeak5sRad: number;
    cameraFrameDeltaRms5sM: number;
    cameraFrameDeltaPeak5sM: number;
    cameraFrameRotDeltaRms5sRad: number;
    cameraFrameRotDeltaPeak5sRad: number;
    groundedTransitions5s: number;
    groundedMin5s: number;
    groundedMax5s: number;
    latestAuthDeltaM: number;
    sampledAuthDeltaM: number;
    meshAuthDeltaM: number;
    latestVsSampledAuthDeltaM: number;
    currentAuthDeltaM: number;
    meshCurrentAuthDeltaM: number;
    expectedLeadM: number;
    currentAuthUnexplainedDeltaM: number;
    currentAuthPlanarDeltaM: number;
    currentAuthVerticalDeltaM: number;
    authObservedAgeMs: number;
    authSampleOffsetMs: number;
    authSampleServerDeltaMs: number;
    authCurrentOffsetMs: number;
    predictedAuthDeltaRms5sM: number;
    predictedAuthDeltaPeak5sM: number;
    capture: {
      predictedFrameDeltaM: number;
      predictedPlanarDeltaM: number;
      predictedHeaveDeltaM: number;
      predictedYawDeltaRad: number;
      predictedPitchDeltaRad: number;
      predictedRollDeltaRad: number;
      predictedResidualDeltaM: number;
      predictedResidualPlanarDeltaM: number;
      predictedResidualHeaveDeltaM: number;
      predictedResidualYawDeltaRad: number;
      predictedResidualPitchDeltaRad: number;
      predictedResidualRollDeltaRad: number;
      meshFrameDeltaM: number;
      meshFrameRotDeltaRad: number;
      cameraFrameDeltaM: number;
      cameraFrameRotDeltaRad: number;
      groundedTransitionThisFrame: boolean;
      wheelContactBits: number;
      wheelContactBitChangesThisFrame: number;
      wheelContactNormalDeltaRad: number;
      wheelGroundObjectSwitchesThisFrame: number;
      suspensionLengthSpreadM: number;
      suspensionForceSpreadN: number;
      suspensionLengthDeltaM: number;
      suspensionForceDeltaN: number;
      expectedLeadM: number;
      currentAuthUnexplainedDeltaM: number;
      currentAuthPlanarDeltaM: number;
      currentAuthVerticalDeltaM: number;
      predictedPosition: [number, number, number] | null;
      meshPosition: [number, number, number] | null;
      currentAuthPosition: [number, number, number] | null;
      cameraPosition: [number, number, number];
    };
  },
  telemetry: {
    lastSnapshotGapMs: number;
    snapshotGapP95Ms: number;
    snapshotGapMaxMs: number;
    lastSnapshotSource: string;
    staleSnapshotsDropped: number;
    reliableSnapshotsReceived: number;
    datagramSnapshotsReceived: number;
    localSnapshotsReceived: number;
    directSnapshotsReceived: number;
    playerCorrectionPeak5sM: number;
    vehicleCorrectionPeak5sM: number;
    dynamicCorrectionPeak5sM: number;
    pendingInputsPeak5s: number;
    shotsFired: number;
    shotsPending: number;
    shotAuthoritativeMoves: number;
    shotMismatches: number;
    lastShotOutcome: string;
    lastShotOutcomeAgeMs: number;
    lastShotPredictedBodyId: number;
    lastShotProxyHitBodyId: number;
    lastShotProxyHitToi: number;
    lastShotBlockedByBlocker: boolean;
    lastShotLocalPredictedDeltaM: number;
    lastShotDynamicSampleAgeMs: number;
    lastShotPredictedBodyRecentInteraction: boolean;
    lastShotBlockerDistance: number;
    lastShotRenderedBodyId: number;
    lastShotRenderedBodyToi: number;
    lastShotRenderProxyDeltaM: number;
    lastShotRenderedBodyProxyPresent: boolean;
    lastShotRenderedBodyProxyToi: number;
    lastShotRenderedBodyProxyCenterDeltaM: number;
    lastShotNearestProxyBodyId: number;
    lastShotNearestProxyBodyToi: number;
    lastShotNearestProxyBodyMissDistanceM: number;
    lastShotNearestProxyBodyRadiusM: number;
    lastShotNearestRenderedBodyId: number;
    lastShotNearestRenderedBodyToi: number;
    lastShotNearestRenderedBodyMissDistanceM: number;
    lastShotNearestRenderedBodyRadiusM: number;
    lastShotServerResolution: number;
    lastShotServerDynamicBodyId: number;
    lastShotServerDynamicHitToiM: number;
    lastShotServerDynamicImpulseMag: number;
    recentEvents: string[];
  },
  position: [number, number, number],
  player: { velocity: [number, number, number]; hp: number; localFlags: number },
) => void;

type GameWorldProps = {
  mode: GameMode;
  worldDocument?: WorldDocument;
  onWelcome: (id: number) => void;
  onDisconnect: (reason?: string) => void;
  onAimStateChange?: (state: CrosshairAimState) => void;
  onDebugFrame?: FrameDebugCallback;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  inputBindings: InputBindings;
  onSnapshot?: () => void;
  rapierDebugModeBits?: number;
  benchmarkAutopilot?: {
    enabled: boolean;
    clientIndex: number;
    scenario: LoadTestScenario;
  };
  localRenderSmoothingEnabled?: boolean;
  vehicleSmoothingEnabled?: boolean;
  // Optional children rendered inside the R3F scene. Used by the calibration
  // wizard to inject drill targets (FlickDrill / TrackDrill) into the live
  // firing-range scene, so the player's feel during drills is identical to
  // normal play.
  sceneExtras?: ReactNode;
};

const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

type VehicleWheelVisualState = {
  spinAngle: number;
  steerAngle: number;
};

type VehicleRenderState = {
  lastBodyPosition: [number, number, number] | null;
  wheels: VehicleWheelVisualState[];
};

type VehicleSupportLabelState = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  sprite: THREE.Sprite;
};

type VehicleSupportDebugState = {
  group: THREE.Group;
  rays: THREE.Line[];
  normals: THREE.Line[];
  contacts: THREE.Mesh[];
  labels: VehicleSupportLabelState[];
};

type LocalVehicleMotionState = {
  vehicleId: number | null;
  position: THREE.Vector3;
  euler: THREE.Euler;
  quaternion: THREE.Quaternion;
  groundedWheels: number;
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  wheelContactBits: number;
  suspensionLengths: [number, number, number, number];
  suspensionForces: [number, number, number, number];
  suspensionRelativeVelocities: [number, number, number, number];
  wheelContactNormals: Array<[number, number, number]>;
  wheelGroundObjectIds: [number, number, number, number];
};

type BenchmarkVehicleDriverState = {
  enteredVehicleAtMs: number | null;
  lastEnterPressedAtMs: number | null;
};

function collectRemoteShotHits(
  remotePlayers: Map<number, RemotePlayer>,
  remoteInterpolator: GameRuntimeClient['interpolator'],
  renderTimeUs: number,
  runtime: Pick<GameRuntimeClient, 'classifyHitscanPlayer'>,
  aimOrigin: [number, number, number],
  aimDirection: [number, number, number],
  blockerDistance: number | null,
): RemoteShotHit[] {
  const remoteHits: RemoteShotHit[] = [];
  for (const [id, rp] of remotePlayers) {
    const sample = remoteInterpolator.sample(id, renderTimeUs);
    const position = sample?.position ?? rp.position;
    const hit = runtime.classifyHitscanPlayer(aimOrigin, aimDirection, position, blockerDistance);
    if (!hit) continue;
    remoteHits.push({
      distance: hit.distance,
      kind: hit.kind === HIT_ZONE_HEAD ? 'head' : 'body',
    });
  }
  return remoteHits;
}

function closestRemoteShotDistance(remoteHits: RemoteShotHit[]): number | null {
  let closest = Number.POSITIVE_INFINITY;
  for (const hit of remoteHits) {
    if (hit.distance < closest) {
      closest = hit.distance;
    }
  }
  return Number.isFinite(closest) ? closest : null;
}

function minDistance(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

type RenderedDynamicBodyHit = {
  bodyId: number;
  toi: number;
};

type DynamicBodyRayCandidate = {
  bodyId: number;
  toi: number;
  missDistance: number;
  radius: number;
};

function approxBodyRayCandidate(
  origin: [number, number, number],
  direction: [number, number, number],
  position: [number, number, number],
  halfExtents: [number, number, number],
  maxDistance: number,
): DynamicBodyRayCandidate | null {
  const radius = Math.max(halfExtents[0], halfExtents[1], halfExtents[2]);
  const ox = position[0] - origin[0];
  const oy = position[1] - origin[1];
  const oz = position[2] - origin[2];
  const toi = ox * direction[0] + oy * direction[1] + oz * direction[2];
  if (toi < 0 || toi > maxDistance) return null;
  const cx = origin[0] + direction[0] * toi;
  const cy = origin[1] + direction[1] * toi;
  const cz = origin[2] + direction[2] * toi;
  return {
    bodyId: 0,
    toi,
    missDistance: Math.hypot(position[0] - cx, position[1] - cy, position[2] - cz),
    radius,
  };
}

function approxRenderedDynamicBodyHit(
  origin: [number, number, number],
  direction: [number, number, number],
  bodies: Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }>,
  maxDistance: number,
): RenderedDynamicBodyHit | null {
  let best: RenderedDynamicBodyHit | null = null;
  for (const body of bodies) {
    const candidate = approxBodyRayCandidate(
      origin,
      direction,
      body.position,
      body.halfExtents,
      maxDistance,
    );
    if (!candidate || candidate.missDistance > candidate.radius) continue;
    if (!best || candidate.toi < best.toi) {
      best = { bodyId: body.id, toi: candidate.toi };
    }
  }
  return best;
}

function nearestDynamicBodyCandidate(
  origin: [number, number, number],
  direction: [number, number, number],
  bodies: Array<{
    id: number;
    position: [number, number, number];
    halfExtents: [number, number, number];
  }>,
  maxDistance: number,
): DynamicBodyRayCandidate | null {
  let best: DynamicBodyRayCandidate | null = null;
  for (const body of bodies) {
    const candidate = approxBodyRayCandidate(
      origin,
      direction,
      body.position,
      body.halfExtents,
      maxDistance,
    );
    if (!candidate) continue;
    candidate.bodyId = body.id;
    const candidateEdgeDistance = candidate.missDistance - candidate.radius;
    const bestEdgeDistance = best ? best.missDistance - best.radius : Number.POSITIVE_INFINITY;
    if (
      !best
      || candidateEdgeDistance < bestEdgeDistance
      || (Math.abs(candidateEdgeDistance - bestEdgeDistance) < 1e-4 && candidate.toi < best.toi)
    ) {
      best = candidate;
    }
  }
  return best;
}

type TimedScalar = { atMs: number; value: number };

function trimTimedScalars(samples: TimedScalar[], nowMs: number, windowMs = 5000): void {
  while (samples.length > 0 && nowMs - samples[0].atMs > windowMs) {
    samples.shift();
  }
}

function rmsTimedScalars(samples: TimedScalar[]): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample.value * sample.value;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function peakTimedScalars(samples: TimedScalar[]): number {
  let peak = 0;
  for (const sample of samples) {
    if (sample.value > peak) peak = sample.value;
  }
  return peak;
}

function minTimedScalars(samples: TimedScalar[]): number {
  if (samples.length === 0) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    if (sample.value < min) min = sample.value;
  }
  return Number.isFinite(min) ? min : 0;
}

function maxTimedScalars(samples: TimedScalar[]): number {
  if (samples.length === 0) return 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample.value > max) max = sample.value;
  }
  return Number.isFinite(max) ? max : 0;
}

function countTimedScalars(samples: TimedScalar[]): number {
  return samples.length;
}

function popcount8(value: number): number {
  let bits = value & 0xff;
  let count = 0;
  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

function distanceVec3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function spread4(values: readonly [number, number, number, number]): number {
  let min = values[0];
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

function rmsDelta4(
  current: readonly [number, number, number, number],
  previous: readonly [number, number, number, number],
): number {
  let sumSquares = 0;
  for (let index = 0; index < current.length; index += 1) {
    const delta = current[index] - previous[index];
    sumSquares += delta * delta;
  }
  return Math.sqrt(sumSquares / current.length);
}

function wheelContactNormalDelta(
  currentNormals: Array<[number, number, number]>,
  previousNormals: Array<[number, number, number]>,
  currentBits: number,
  previousBits: number,
): number {
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < 4; index += 1) {
    if (((currentBits & previousBits) & (1 << index)) === 0) continue;
    const current = currentNormals[index];
    const previous = previousNormals[index];
    if (!current || !previous) continue;
    const currentLen = Math.hypot(current[0], current[1], current[2]);
    const previousLen = Math.hypot(previous[0], previous[1], previous[2]);
    if (currentLen <= 0.0001 || previousLen <= 0.0001) continue;
    const dot = THREE.MathUtils.clamp(
      (current[0] * previous[0] + current[1] * previous[1] + current[2] * previous[2]) / (currentLen * previousLen),
      -1,
      1,
    );
    const angle = Math.acos(dot);
    sumSquares += angle * angle;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

function wheelGroundObjectSwitches(
  currentIds: readonly [number, number, number, number],
  previousIds: readonly [number, number, number, number],
  currentBits: number,
  previousBits: number,
): number {
  let switches = 0;
  for (let index = 0; index < 4; index += 1) {
    if (((currentBits & previousBits) & (1 << index)) !== 0 && currentIds[index] !== previousIds[index]) {
      switches += 1;
    }
  }
  return switches;
}

function angleDeltaRad(current: number, previous: number): number {
  return THREE.MathUtils.euclideanModulo(current - previous + Math.PI, Math.PI * 2) - Math.PI;
}

function quaternionAngle(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

function clearTimedScalars(...groups: TimedScalar[][]): void {
  for (const group of groups) {
    group.length = 0;
  }
}

function updateLineGeometry(
  line: THREE.Line,
  start: THREE.Vector3,
  end: THREE.Vector3,
  color: number,
): void {
  const geometry = line.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  position.setXYZ(0, start.x, start.y, start.z);
  position.setXYZ(1, end.x, end.y, end.z);
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
  const material = line.material as THREE.LineBasicMaterial;
  material.color.setHex(color);
}

function createVehicleSupportLabel(index: number): VehicleSupportLabelState {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }));
  sprite.name = `wheel_support_label_${index}`;
  sprite.scale.set(1.6, 0.6, 1);
  return { canvas, ctx, texture, sprite };
}

function drawVehicleSupportLabel(
  label: VehicleSupportLabelState,
  title: string,
  contact: boolean,
  suspensionLengthM: number,
  suspensionForceN: number,
  groundObjectId: number,
  contactNormalY: number,
): void {
  const { ctx, canvas, texture } = label;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = contact ? 'rgba(16, 96, 28, 0.82)' : 'rgba(110, 20, 20, 0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.font = 'bold 22px monospace';
  ctx.fillText(title, 12, 26);
  ctx.font = '18px monospace';
  ctx.fillText(`hit ${contact ? '1' : '0'} len ${suspensionLengthM.toFixed(2)}`, 12, 54);
  ctx.fillText(`f ${suspensionForceN.toFixed(0)} g ${groundObjectId} ny ${contactNormalY.toFixed(2)}`, 12, 80);
  texture.needsUpdate = true;
}

function createVehicleSupportDebugState(): VehicleSupportDebugState {
  const group = new THREE.Group();
  group.name = 'vehicle_support_debug';
  const rays: THREE.Line[] = [];
  const normals: THREE.Line[] = [];
  const contacts: THREE.Mesh[] = [];
  const labels: VehicleSupportLabelState[] = [];
  for (let index = 0; index < 4; index += 1) {
    const rayGeometry = new THREE.BufferGeometry();
    rayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({
      color: 0xff3355,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }));
    ray.name = `wheel_support_ray_${index}`;
    group.add(ray);
    rays.push(ray);

    const normalGeometry = new THREE.BufferGeometry();
    normalGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const normal = new THREE.Line(normalGeometry, new THREE.LineBasicMaterial({
      color: 0x44d7ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }));
    normal.name = `wheel_support_normal_${index}`;
    group.add(normal);
    normals.push(normal);

    const contact = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0x33ff88,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    contact.name = `wheel_support_contact_${index}`;
    contact.visible = false;
    group.add(contact);
    contacts.push(contact);

    const label = createVehicleSupportLabel(index);
    group.add(label.sprite);
    labels.push(label);
  }
  return { group, rays, normals, contacts, labels };
}

function updateVehicleSupportDebug(
  vehicleMeshGroup: THREE.Group,
  localVehicleDebug: {
    wheelContactBits: number;
    suspensionLengths: [number, number, number, number];
    suspensionForces: [number, number, number, number];
    wheelHardPoints?: Array<[number, number, number]>;
    wheelContactPoints?: Array<[number, number, number]>;
    wheelContactNormals?: Array<[number, number, number]>;
    wheelGroundObjectIds?: [number, number, number, number];
  } | null,
  enabled: boolean,
): void {
  let debugState = vehicleMeshGroup.userData.supportDebug as VehicleSupportDebugState | undefined;
  if (!debugState) {
    debugState = createVehicleSupportDebugState();
    debugState.group.visible = false;
    vehicleMeshGroup.add(debugState.group);
    vehicleMeshGroup.userData.supportDebug = debugState;
  }

  debugState.group.visible = enabled && localVehicleDebug != null;
  if (!debugState.group.visible || !localVehicleDebug) return;

  const wheelConnectionOffsets = getVehicleWheelConnectionOffsets();
  const wheelRadiusM = getVehicleWheelRadiusM();
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const inverseWorldQuat = vehicleMeshGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
  for (let index = 0; index < 4; index += 1) {
    const [ax, ay, az] = wheelConnectionOffsets[index];
    const suspensionLength = localVehicleDebug.suspensionLengths[index] ?? 0;
    const contact = (localVehicleDebug.wheelContactBits & (1 << index)) !== 0;
    const rayLength = suspensionLength + wheelRadiusM;
    const hardPointWs = localVehicleDebug.wheelHardPoints?.[index];
    const contactPointWs = localVehicleDebug.wheelContactPoints?.[index];
    const contactNormalWs = localVehicleDebug.wheelContactNormals?.[index];
    const start = hardPointWs
      ? vehicleMeshGroup.worldToLocal(new THREE.Vector3(hardPointWs[0], hardPointWs[1], hardPointWs[2]))
      : new THREE.Vector3(ax, ay, az);
    const end = contactPointWs
      ? vehicleMeshGroup.worldToLocal(new THREE.Vector3(contactPointWs[0], contactPointWs[1], contactPointWs[2]))
      : new THREE.Vector3(ax, ay - rayLength, az);
    const contactNormal = contactNormalWs
      ? new THREE.Vector3(contactNormalWs[0], contactNormalWs[1], contactNormalWs[2]).normalize().applyQuaternion(inverseWorldQuat)
      : up;
    const normalY = contactNormalWs?.[1] ?? 0;
    const ray = debugState.rays[index];
    const normal = debugState.normals[index];
    const contactMarker = debugState.contacts[index];
    const label = debugState.labels[index];

    updateLineGeometry(ray, start, end, contact ? 0x22ff77 : 0xff4466);
    ray.visible = true;

    if (contact) {
      updateLineGeometry(normal, end, end.clone().addScaledVector(contactNormal, 0.35), 0x55d8ff);
      normal.visible = true;
      contactMarker.visible = true;
      contactMarker.position.copy(end);
      (contactMarker.material as THREE.MeshBasicMaterial).color.setHex(0x22ff77);
    } else {
      updateLineGeometry(normal, end, end.clone().addScaledVector(down, 0.2), 0xffaa33);
      normal.visible = true;
      contactMarker.visible = true;
      contactMarker.position.copy(end);
      (contactMarker.material as THREE.MeshBasicMaterial).color.setHex(0xff4466);
    }

    drawVehicleSupportLabel(
      label,
      `W${index}`,
      contact,
      suspensionLength,
      localVehicleDebug.suspensionForces[index] ?? 0,
      localVehicleDebug.wheelGroundObjectIds?.[index] ?? 0,
      normalY,
    );
    label.sprite.visible = true;
    label.sprite.position.set(ax, ay + 0.45, az);
  }
}

function resolvedInputFromBotIntent(
  buttons: number,
  yaw: number,
  pitch: number,
  firePrimary: boolean,
): import('../input/types').ResolvedGameInput {
  const moveX =
    ((buttons & BTN_RIGHT) !== 0 ? 1 : 0)
    - ((buttons & BTN_LEFT) !== 0 ? 1 : 0);
  const moveY = (buttons & BTN_FORWARD) !== 0 ? 1 : 0;
  return {
    activeFamily: 'keyboardMouse',
    moveX,
    moveY,
    yaw,
    pitch,
    buttons: buttons & (BTN_JUMP | BTN_SPRINT | BTN_CROUCH),
    firePrimary,
    interactPressed: false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
  };
}

function makeIdleResolvedInput(
  yaw: number,
  pitch: number,
  activeFamily: import('../input/types').ResolvedGameInput['activeFamily'],
): import('../input/types').ResolvedGameInput {
  return {
    activeFamily,
    moveX: 0,
    moveY: 0,
    yaw,
    pitch,
    buttons: 0,
    firePrimary: false,
    interactPressed: false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
  };
}

function resolveVehicleBenchmarkInput(
  state: BenchmarkVehicleDriverState,
  nowMs: number,
  isDriving: boolean,
  nearestVehicleId: number | null,
  yaw: number,
  pitch: number,
  activeFamily: import('../input/types').ResolvedGameInput['activeFamily'],
  driverProfile: PlayBenchmarkDriverProfile,
): import('../input/types').ResolvedGameInput {
  const input = makeIdleResolvedInput(yaw, pitch, activeFamily);
  if (!isDriving) {
    state.enteredVehicleAtMs = null;
    if (
      nearestVehicleId != null
      && (state.lastEnterPressedAtMs == null || nowMs - state.lastEnterPressedAtMs >= 750)
    ) {
      input.interactPressed = true;
      state.lastEnterPressedAtMs = nowMs;
    }
    return input;
  }

  if (state.enteredVehicleAtMs == null) {
    state.enteredVehicleAtMs = nowMs;
  }

  const elapsedS = (nowMs - state.enteredVehicleAtMs) / 1000;
  if (driverProfile === 'straight' || driverProfile === 'straight_fast') {
    if (elapsedS < 1.0) {
      return input;
    }
    input.moveY = driverProfile === 'straight_fast' ? 1.0 : 0.65;
    return input;
  }
  if (elapsedS < 1.0) {
    return input;
  }
  if (elapsedS < 3.0) {
    input.moveY = 0.35;
    return input;
  }
  if (elapsedS < 7.0) {
    input.moveY = 1.0;
    return input;
  }
  if (elapsedS < 9.0) {
    return input;
  }
  if (elapsedS < 11.0) {
    input.moveY = -1.0;
    return input;
  }
  if (elapsedS < 14.0) {
    input.moveX = -0.22;
    input.moveY = 0.8;
    return input;
  }
  if (elapsedS < 17.0) {
    input.moveX = 0.22;
    input.moveY = 0.8;
    return input;
  }
  input.moveY = -0.4;
  return input;
}

export function GameWorld({
  mode,
  worldDocument = DEFAULT_WORLD_DOCUMENT,
  onWelcome,
  onDisconnect,
  onAimStateChange,
  onDebugFrame,
  onInputFrame,
  inputFamilyMode = 'auto',
  inputBindings,
  onSnapshot,
  rapierDebugModeBits = 0,
  benchmarkAutopilot,
  localRenderSmoothingEnabled = true,
  vehicleSmoothingEnabled = false,
  sceneExtras,
}: GameWorldProps) {
  const practiceMode = isPracticeMode(mode);
  const worldJson = useMemo(() => serializeWorldDocument(worldDocument), [worldDocument]);
  const predictionWorldJson = useMemo(
    () => practiceMode
      ? worldJson
      : serializeWorldDocument(removeVehicleEntitiesFromWorldDocument(worldDocument)),
    [practiceMode, worldDocument, worldJson],
  );
  const onDebugFrameRef = useRef(onDebugFrame);
  onDebugFrameRef.current = onDebugFrame;
  const onAimStateChangeRef = useRef(onAimStateChange);
  onAimStateChangeRef.current = onAimStateChange;
  const onInputFrameRef = useRef(onInputFrame);
  onInputFrameRef.current = onInputFrame;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const { ready, renderBlocks, runtimeRef } = useGameRuntime(
    mode,
    worldJson,
    predictionWorldJson,
    onWelcome,
    onDisconnect,
    () => onSnapshotRef.current?.(),
    localRenderSmoothingEnabled,
  );
  const { camera, gl } = useThree();

  const inputManagerRef = useRef<GameInputManager | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const remoteGroupRef = useRef<THREE.Group>(null);
  const remoteMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const remoteLastHpRef = useRef<Map<number, number>>(new Map());
  const remoteHitFlashUntilRef = useRef<Map<number, number>>(new Map());
  const dynamicBodyGroupRef = useRef<THREE.Group>(null);
  const dynamicBodyMeshes = useRef<Map<number, THREE.Mesh>>(new Map());
  const logTimer = useRef(0);
  const lastFrameTime = useRef(performance.now());
  const selectedMaterialRef = useRef(2);
  const nextShotIdRef = useRef(1);
  const nextLocalFireMsRef = useRef(0);
  const lastAimStateRef = useRef<CrosshairAimState>('idle');
  const localShotTraceRef = useRef<LocalShotTrace | null>(null);
  const botBrainRef = useRef<BotBrainState | null>(
    benchmarkAutopilot?.enabled
      ? createBotBrainState(benchmarkAutopilot.clientIndex, benchmarkAutopilot.scenario)
      : null,
  );
  const benchmarkVehicleDriverRef = useRef<BenchmarkVehicleDriverState>({
    enteredVehicleAtMs: null,
    lastEnterPressedAtMs: null,
  });
  const vehicleSupportDebugEnabledRef = useRef(false);

  // Vehicle refs
  const vehicleGroupRef = useRef<THREE.Group>(null);
  const vehicleMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const nearestVehicleIdRef = useRef<number | null>(null);
  const smoothCamPos = useRef(new THREE.Vector3()); // smoothed chase camera position
  const smoothVehicleFocus = useRef(new THREE.Vector3()); // smoothed look-at target for vehicle camera
  const localVehicleVisualPoseRef = useRef<LocalVehicleVisualPoseState>({
    vehicleId: null,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
  });
  const vehicleCameraYawOffsetRef = useRef(0);
  const vehicleCameraPitchRef = useRef(VEHICLE_CAMERA_DEFAULT_PITCH);
  const lastVehicleLookAtMsRef = useRef(performance.now());
  const shotTraceBeamRef = useRef<THREE.Mesh>(null);
  const shotTraceImpactRef = useRef<THREE.Mesh>(null);
  const localVehicleMeshDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRestJitterSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleStraightJitterSamplesRef = useRef<TimedScalar[]>([]);
  const localVehiclePredictedAuthDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawHeaveSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawPitchSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawRollSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawPlanarSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawYawSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualPlanarSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualHeaveSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualYawSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualPitchSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleResidualRollSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawRestHeaveSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawStraightHeaveSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleWheelContactBitChangeSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleSuspensionLengthDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleSuspensionForceDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleSuspensionLengthSpreadSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleSuspensionForceSpreadSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleContactNormalDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleGroundObjectSwitchSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleMeshFrameDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleMeshFrameRotSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleCameraFrameDeltaSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleCameraFrameRotSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleGroundedTransitionSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleGroundedSamplesRef = useRef<TimedScalar[]>([]);
  const localVehicleRawJitterStateRef = useRef<LocalVehicleMotionState>({
    vehicleId: null,
    position: new THREE.Vector3(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    quaternion: new THREE.Quaternion(),
    groundedWheels: 0,
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    wheelContactBits: 0,
    suspensionLengths: [0, 0, 0, 0],
    suspensionForces: [0, 0, 0, 0],
    suspensionRelativeVelocities: [0, 0, 0, 0],
    wheelContactNormals: [],
    wheelGroundObjectIds: [0, 0, 0, 0],
  });
  const localVehicleMeshMotionStateRef = useRef<LocalVehicleMotionState>({
    vehicleId: null,
    position: new THREE.Vector3(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    quaternion: new THREE.Quaternion(),
    groundedWheels: 0,
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    wheelContactBits: 0,
    suspensionLengths: [0, 0, 0, 0],
    suspensionForces: [0, 0, 0, 0],
    suspensionRelativeVelocities: [0, 0, 0, 0],
    wheelContactNormals: [],
    wheelGroundObjectIds: [0, 0, 0, 0],
  });
  const localVehicleCameraMotionStateRef = useRef<LocalVehicleMotionState>({
    vehicleId: null,
    position: new THREE.Vector3(),
    euler: new THREE.Euler(0, 0, 0, 'YXZ'),
    quaternion: new THREE.Quaternion(),
    groundedWheels: 0,
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    wheelContactBits: 0,
    suspensionLengths: [0, 0, 0, 0],
    suspensionForces: [0, 0, 0, 0],
    suspensionRelativeVelocities: [0, 0, 0, 0],
    wheelContactNormals: [],
    wheelGroundObjectIds: [0, 0, 0, 0],
  });

  useEffect(() => {
    const manager = new GameInputManager();
    manager.attach();
    inputManagerRef.current = manager;
    return () => {
      manager.detach();
      inputManagerRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    onAimStateChangeRef.current?.('idle');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'F8') {
        event.preventDefault();
        vehicleSupportDebugEnabledRef.current = !vehicleSupportDebugEnabledRef.current;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    botBrainRef.current = benchmarkAutopilot?.enabled
      ? createBotBrainState(benchmarkAutopilot.clientIndex, benchmarkAutopilot.scenario)
      : null;
    benchmarkVehicleDriverRef.current.enteredVehicleAtMs = null;
    benchmarkVehicleDriverRef.current.lastEnterPressedAtMs = null;
  }, [benchmarkAutopilot]);

  useFrame((_frameState, delta) => {
    if (!ready) return;
    const now = performance.now();
    const frameDelta = Math.min((now - lastFrameTime.current) / 1000, 0.1);
    lastFrameTime.current = now;
    const client = runtimeRef.current;
    const state = client?.state;
    if (!client || !state) return;
    const prediction = client;
    const localAuthorityTransport = client?.transport === 'local';
    const localFlags = client?.localPlayerFlags ?? 0;
    const localPlayerStateMeters = client.usesLocalAuthority && client.getPosition()
      ? {
          position: client.getPosition()!,
          velocity: client.getDebugStats().velocity,
        }
      : null;
    const localDead = (localFlags & FLAG_DEAD) !== 0;
    const drivenVehicleId = client?.getDrivenVehicleId() ?? null;
    const drivenVehicleState = drivenVehicleId != null ? client?.vehicles.get(drivenVehicleId) ?? null : null;
    const localVehicleRenderTimeUs = client?.serverClock.renderTimeUs((client?.interpolationDelayMs ?? 0) * 1000) ?? 0;
    const localVehicleNowTimeUs = client?.serverClock.serverNowUs();
    const localVehicleAuthoritativeSample = client && drivenVehicleId != null
      ? client.sampleRemoteVehicle(drivenVehicleId, localVehicleRenderTimeUs)
      : null;
    const localVehicleAuthoritativeNowSample = client && drivenVehicleId != null && localVehicleNowTimeUs != null
      ? client.sampleRemoteVehicle(drivenVehicleId, localVehicleNowTimeUs)
      : null;
    const predictedVehiclePose = client.getVehiclePose();
    const localVehicleDebug = drivenVehicleId != null
      ? client?.getLocalVehicleDebug(drivenVehicleId) ?? null
      : null;
    const localControlledVehiclePose = localAuthorityTransport
      ? (localVehicleAuthoritativeSample
        ? {
            position: localVehicleAuthoritativeSample.position,
            quaternion: localVehicleAuthoritativeSample.quaternion,
          }
        : (drivenVehicleState
          ? {
              position: drivenVehicleState.position,
              quaternion: drivenVehicleState.quaternion,
            }
          : null))
      : predictedVehiclePose;
    const localVehicleCurrentAuthDeltaM = localControlledVehiclePose && localVehicleAuthoritativeNowSample
      ? distanceVec3(localControlledVehiclePose.position, localVehicleAuthoritativeNowSample.position)
      : 0;
    let localVehicleVisualPose = localControlledVehiclePose;
    let localVehicleMeshDeltaM = 0;
    let localVehicleMeshRotDeltaRad = 0;
    let localVehicleRawFrameDeltaM = 0;
    let localVehicleRawPlanarDeltaM = 0;
    let localVehicleRawHeaveDeltaM = 0;
    let localVehicleRawYawDeltaRad = 0;
    let localVehicleRawPitchDeltaRad = 0;
    let localVehicleRawRollDeltaRad = 0;
    let localVehicleResidualFrameDeltaM = 0;
    let localVehicleResidualPlanarDeltaM = 0;
    let localVehicleResidualHeaveDeltaM = 0;
    let localVehicleResidualYawDeltaRad = 0;
    let localVehicleResidualPitchDeltaRad = 0;
    let localVehicleResidualRollDeltaRad = 0;
    let localVehicleMeshFrameDeltaM = 0;
    let localVehicleMeshFrameRotDeltaRad = 0;
    let localVehicleCameraFrameDeltaM = 0;
    let localVehicleCameraFrameRotDeltaRad = 0;
    let localVehicleGroundedTransitionThisFrame = false;
    let localVehicleWheelContactBits = localVehicleDebug?.wheelContactBits ?? 0;
    let localVehicleWheelContactBitChangesThisFrame = 0;
    let localVehicleWheelContactNormalDeltaRad = 0;
    let localVehicleGroundObjectSwitchesThisFrame = 0;
    let localVehicleSuspensionLengths: [number, number, number, number] = localVehicleDebug?.suspensionLengths ?? [0, 0, 0, 0];
    let localVehicleSuspensionForces: [number, number, number, number] = localVehicleDebug?.suspensionForces ?? [0, 0, 0, 0];
    let localVehicleSuspensionRelativeVelocities: [number, number, number, number] = localVehicleDebug?.suspensionRelativeVelocities ?? [0, 0, 0, 0];
    let localVehicleWheelContactNormals = localVehicleDebug?.wheelContactNormals ?? [];
    let localVehicleWheelGroundObjectIds: [number, number, number, number] = localVehicleDebug?.wheelGroundObjectIds ?? [0, 0, 0, 0];
    let localVehicleSuspensionLengthSpreadM = spread4(localVehicleSuspensionLengths);
    let localVehicleSuspensionForceSpreadN = spread4(localVehicleSuspensionForces);
    let localVehicleSuspensionLengthDeltaM = 0;
    let localVehicleSuspensionForceDeltaN = 0;
    if (localControlledVehiclePose && drivenVehicleId != null) {
      if (vehicleSmoothingEnabled) {
        const result = updateLocalVehicleMeshPose(
          localVehicleVisualPoseRef.current,
          drivenVehicleId,
          localControlledVehiclePose,
          frameDelta,
          localVehicleDebug?.speedMs ?? 0,
          localVehicleDebug?.groundedWheels ?? 0,
          localAuthorityTransport ? 'practice' : 'multiplayer',
        );
        localVehicleVisualPose = result.pose;
        localVehicleMeshDeltaM = result.metrics.positionDeltaM;
        localVehicleMeshRotDeltaRad = result.metrics.rotationDeltaRad;
      } else {
        resetLocalVehicleMeshPose(localVehicleVisualPoseRef.current);
        localVehicleVisualPose = localControlledVehiclePose;
      }
    } else {
      resetLocalVehicleMeshPose(localVehicleVisualPoseRef.current);
    }
    const isMultiplayerLocalVehicle = !localAuthorityTransport && predictedVehiclePose != null && drivenVehicleId != null;
    const multiplayerVehiclePose = isMultiplayerLocalVehicle ? localControlledVehiclePose : null;
    if (multiplayerVehiclePose && drivenVehicleId != null) {
      const rawJitterState = localVehicleRawJitterStateRef.current;
      const groundedWheels = localVehicleDebug?.groundedWheels ?? 0;
      const currentLinearVelocity = localVehicleDebug?.linearVelocity ?? [0, 0, 0];
      const currentAngularVelocity = localVehicleDebug?.angularVelocity ?? [0, 0, 0];
      localVehicleWheelContactBits = localVehicleDebug?.wheelContactBits ?? 0;
      localVehicleSuspensionLengths = localVehicleDebug?.suspensionLengths ?? [0, 0, 0, 0];
      localVehicleSuspensionForces = localVehicleDebug?.suspensionForces ?? [0, 0, 0, 0];
      localVehicleSuspensionRelativeVelocities = localVehicleDebug?.suspensionRelativeVelocities ?? [0, 0, 0, 0];
      localVehicleWheelContactNormals = localVehicleDebug?.wheelContactNormals ?? [];
      localVehicleWheelGroundObjectIds = localVehicleDebug?.wheelGroundObjectIds ?? [0, 0, 0, 0];
      localVehicleSuspensionLengthSpreadM = spread4(localVehicleSuspensionLengths);
      localVehicleSuspensionForceSpreadN = spread4(localVehicleSuspensionForces);
      const currentRawQuat = new THREE.Quaternion(
        multiplayerVehiclePose.quaternion[0],
        multiplayerVehiclePose.quaternion[1],
        multiplayerVehiclePose.quaternion[2],
        multiplayerVehiclePose.quaternion[3],
      );
      const currentRawEuler = new THREE.Euler().setFromQuaternion(currentRawQuat, 'YXZ');
      const rawDx = multiplayerVehiclePose.position[0] - rawJitterState.position.x;
      const rawDy = multiplayerVehiclePose.position[1] - rawJitterState.position.y;
      const rawDz = multiplayerVehiclePose.position[2] - rawJitterState.position.z;
      const rawPositionDeltaM = Math.hypot(rawDx, rawDy, rawDz);
      const resetRawJitter = rawJitterState.vehicleId !== drivenVehicleId || rawPositionDeltaM >= 6.0;
      if (resetRawJitter) {
        clearTimedScalars(
          localVehicleRawHeaveSamplesRef.current,
          localVehicleRawPlanarSamplesRef.current,
          localVehicleRawYawSamplesRef.current,
          localVehicleRawPitchSamplesRef.current,
          localVehicleRawRollSamplesRef.current,
          localVehicleResidualSamplesRef.current,
          localVehicleResidualPlanarSamplesRef.current,
          localVehicleResidualHeaveSamplesRef.current,
          localVehicleResidualYawSamplesRef.current,
          localVehicleResidualPitchSamplesRef.current,
          localVehicleResidualRollSamplesRef.current,
          localVehicleRawRestHeaveSamplesRef.current,
          localVehicleRawStraightHeaveSamplesRef.current,
          localVehicleWheelContactBitChangeSamplesRef.current,
          localVehicleSuspensionLengthDeltaSamplesRef.current,
          localVehicleSuspensionForceDeltaSamplesRef.current,
          localVehicleSuspensionLengthSpreadSamplesRef.current,
          localVehicleSuspensionForceSpreadSamplesRef.current,
          localVehicleContactNormalDeltaSamplesRef.current,
          localVehicleGroundObjectSwitchSamplesRef.current,
          localVehicleGroundedTransitionSamplesRef.current,
          localVehicleGroundedSamplesRef.current,
        );
      } else {
        localVehicleRawFrameDeltaM = rawPositionDeltaM;
        localVehicleRawPlanarDeltaM = Math.hypot(rawDx, rawDz);
        localVehicleRawHeaveDeltaM = Math.abs(rawDy);
        localVehicleRawYawDeltaRad = Math.abs(angleDeltaRad(currentRawEuler.y, rawJitterState.euler.y));
        localVehicleRawPitchDeltaRad = Math.abs(angleDeltaRad(currentRawEuler.x, rawJitterState.euler.x));
        localVehicleRawRollDeltaRad = Math.abs(angleDeltaRad(currentRawEuler.z, rawJitterState.euler.z));
        const expectedDx = ((rawJitterState.linearVelocity[0] + currentLinearVelocity[0]) * 0.5) * frameDelta;
        const expectedDy = ((rawJitterState.linearVelocity[1] + currentLinearVelocity[1]) * 0.5) * frameDelta;
        const expectedDz = ((rawJitterState.linearVelocity[2] + currentLinearVelocity[2]) * 0.5) * frameDelta;
        const residualDx = rawDx - expectedDx;
        const residualDy = rawDy - expectedDy;
        const residualDz = rawDz - expectedDz;
        localVehicleResidualFrameDeltaM = Math.hypot(residualDx, residualDy, residualDz);
        localVehicleResidualPlanarDeltaM = Math.hypot(residualDx, residualDz);
        localVehicleResidualHeaveDeltaM = Math.abs(residualDy);
        const expectedYawDelta = ((rawJitterState.angularVelocity[1] + currentAngularVelocity[1]) * 0.5) * frameDelta;
        const expectedPitchDelta = ((rawJitterState.angularVelocity[0] + currentAngularVelocity[0]) * 0.5) * frameDelta;
        const expectedRollDelta = ((rawJitterState.angularVelocity[2] + currentAngularVelocity[2]) * 0.5) * frameDelta;
        localVehicleResidualYawDeltaRad = Math.abs(localVehicleRawYawDeltaRad - expectedYawDelta);
        localVehicleResidualPitchDeltaRad = Math.abs(localVehicleRawPitchDeltaRad - expectedPitchDelta);
        localVehicleResidualRollDeltaRad = Math.abs(localVehicleRawRollDeltaRad - expectedRollDelta);
        localVehicleWheelContactBitChangesThisFrame = popcount8(localVehicleWheelContactBits ^ rawJitterState.wheelContactBits);
        localVehicleWheelContactNormalDeltaRad = wheelContactNormalDelta(
          localVehicleWheelContactNormals,
          rawJitterState.wheelContactNormals,
          localVehicleWheelContactBits,
          rawJitterState.wheelContactBits,
        );
        localVehicleGroundObjectSwitchesThisFrame = wheelGroundObjectSwitches(
          localVehicleWheelGroundObjectIds,
          rawJitterState.wheelGroundObjectIds,
          localVehicleWheelContactBits,
          rawJitterState.wheelContactBits,
        );
        localVehicleSuspensionLengthDeltaM = rmsDelta4(
          localVehicleSuspensionLengths,
          rawJitterState.suspensionLengths,
        );
        localVehicleSuspensionForceDeltaN = rmsDelta4(
          localVehicleSuspensionForces,
          rawJitterState.suspensionForces,
        );
        localVehicleRawHeaveSamplesRef.current.push({ atMs: now, value: localVehicleRawHeaveDeltaM });
        localVehicleRawPlanarSamplesRef.current.push({ atMs: now, value: localVehicleRawPlanarDeltaM });
        localVehicleRawYawSamplesRef.current.push({ atMs: now, value: localVehicleRawYawDeltaRad });
        localVehicleRawPitchSamplesRef.current.push({ atMs: now, value: localVehicleRawPitchDeltaRad });
        localVehicleRawRollSamplesRef.current.push({ atMs: now, value: localVehicleRawRollDeltaRad });
        localVehicleResidualSamplesRef.current.push({ atMs: now, value: localVehicleResidualFrameDeltaM });
        localVehicleResidualPlanarSamplesRef.current.push({ atMs: now, value: localVehicleResidualPlanarDeltaM });
        localVehicleResidualHeaveSamplesRef.current.push({ atMs: now, value: localVehicleResidualHeaveDeltaM });
        localVehicleResidualYawSamplesRef.current.push({ atMs: now, value: localVehicleResidualYawDeltaRad });
        localVehicleResidualPitchSamplesRef.current.push({ atMs: now, value: localVehicleResidualPitchDeltaRad });
        localVehicleResidualRollSamplesRef.current.push({ atMs: now, value: localVehicleResidualRollDeltaRad });
        localVehicleSuspensionLengthSpreadSamplesRef.current.push({ atMs: now, value: localVehicleSuspensionLengthSpreadM });
        localVehicleSuspensionForceSpreadSamplesRef.current.push({ atMs: now, value: localVehicleSuspensionForceSpreadN });
        localVehicleSuspensionLengthDeltaSamplesRef.current.push({ atMs: now, value: localVehicleSuspensionLengthDeltaM });
        localVehicleSuspensionForceDeltaSamplesRef.current.push({ atMs: now, value: localVehicleSuspensionForceDeltaN });
        localVehicleContactNormalDeltaSamplesRef.current.push({ atMs: now, value: localVehicleWheelContactNormalDeltaRad });
        if (localVehicleGroundObjectSwitchesThisFrame > 0) {
          localVehicleGroundObjectSwitchSamplesRef.current.push({
            atMs: now,
            value: localVehicleGroundObjectSwitchesThisFrame,
          });
        }
        trimTimedScalars(localVehicleRawHeaveSamplesRef.current, now);
        trimTimedScalars(localVehicleRawPlanarSamplesRef.current, now);
        trimTimedScalars(localVehicleRawYawSamplesRef.current, now);
        trimTimedScalars(localVehicleRawPitchSamplesRef.current, now);
        trimTimedScalars(localVehicleRawRollSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualPlanarSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualHeaveSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualYawSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualPitchSamplesRef.current, now);
        trimTimedScalars(localVehicleResidualRollSamplesRef.current, now);
        trimTimedScalars(localVehicleSuspensionLengthSpreadSamplesRef.current, now);
        trimTimedScalars(localVehicleSuspensionForceSpreadSamplesRef.current, now);
        trimTimedScalars(localVehicleSuspensionLengthDeltaSamplesRef.current, now);
        trimTimedScalars(localVehicleSuspensionForceDeltaSamplesRef.current, now);
        trimTimedScalars(localVehicleContactNormalDeltaSamplesRef.current, now);
        trimTimedScalars(localVehicleGroundObjectSwitchSamplesRef.current, now);
        if ((localVehicleDebug?.speedMs ?? 0) < 1 && groundedWheels === 4) {
          localVehicleRawRestHeaveSamplesRef.current.push({ atMs: now, value: localVehicleRawHeaveDeltaM });
        }
        trimTimedScalars(localVehicleRawRestHeaveSamplesRef.current, now);
        if (Math.abs(localVehicleDebug?.steering ?? 0) < 0.05 && groundedWheels >= 3) {
          localVehicleRawStraightHeaveSamplesRef.current.push({ atMs: now, value: localVehicleRawHeaveDeltaM });
        }
        trimTimedScalars(localVehicleRawStraightHeaveSamplesRef.current, now);
        if (groundedWheels !== rawJitterState.groundedWheels) {
          localVehicleGroundedTransitionThisFrame = true;
          localVehicleGroundedTransitionSamplesRef.current.push({ atMs: now, value: 1 });
        }
        if (localVehicleWheelContactBitChangesThisFrame > 0) {
          localVehicleWheelContactBitChangeSamplesRef.current.push({
            atMs: now,
            value: localVehicleWheelContactBitChangesThisFrame,
          });
        }
      }
      localVehicleGroundedSamplesRef.current.push({ atMs: now, value: groundedWheels });
      trimTimedScalars(localVehicleGroundedTransitionSamplesRef.current, now);
      trimTimedScalars(localVehicleWheelContactBitChangeSamplesRef.current, now);
      trimTimedScalars(localVehicleGroundedSamplesRef.current, now);
      rawJitterState.vehicleId = drivenVehicleId;
      rawJitterState.position.set(
        multiplayerVehiclePose.position[0],
        multiplayerVehiclePose.position[1],
        multiplayerVehiclePose.position[2],
      );
      rawJitterState.quaternion.copy(currentRawQuat);
      rawJitterState.euler.copy(currentRawEuler);
      rawJitterState.groundedWheels = groundedWheels;
      rawJitterState.linearVelocity = [...currentLinearVelocity] as [number, number, number];
      rawJitterState.angularVelocity = [...currentAngularVelocity] as [number, number, number];
      rawJitterState.wheelContactBits = localVehicleWheelContactBits;
      rawJitterState.suspensionLengths = [...localVehicleSuspensionLengths] as [number, number, number, number];
      rawJitterState.suspensionForces = [...localVehicleSuspensionForces] as [number, number, number, number];
      rawJitterState.suspensionRelativeVelocities = [...localVehicleSuspensionRelativeVelocities] as [number, number, number, number];
      rawJitterState.wheelContactNormals = localVehicleWheelContactNormals.map((normal) => [...normal] as [number, number, number]);
      rawJitterState.wheelGroundObjectIds = [...localVehicleWheelGroundObjectIds] as [number, number, number, number];

      const visualVehiclePose = localVehicleVisualPose ?? multiplayerVehiclePose;
      const meshMotionState = localVehicleMeshMotionStateRef.current;
      const currentMeshQuat = new THREE.Quaternion(
        visualVehiclePose.quaternion[0],
        visualVehiclePose.quaternion[1],
        visualVehiclePose.quaternion[2],
        visualVehiclePose.quaternion[3],
      );
      const currentMeshEuler = new THREE.Euler().setFromQuaternion(currentMeshQuat, 'YXZ');
      const meshFrameDeltaM = meshMotionState.vehicleId === drivenVehicleId
        ? Math.hypot(
            visualVehiclePose.position[0] - meshMotionState.position.x,
            visualVehiclePose.position[1] - meshMotionState.position.y,
            visualVehiclePose.position[2] - meshMotionState.position.z,
          )
        : 0;
      const resetMeshMotion = meshMotionState.vehicleId !== drivenVehicleId || meshFrameDeltaM >= 6.0;
      if (resetMeshMotion) {
        clearTimedScalars(
          localVehicleMeshDeltaSamplesRef.current,
          localVehicleRestJitterSamplesRef.current,
          localVehicleStraightJitterSamplesRef.current,
          localVehicleMeshFrameDeltaSamplesRef.current,
          localVehicleMeshFrameRotSamplesRef.current,
        );
      } else {
        localVehicleMeshFrameDeltaM = meshFrameDeltaM;
        localVehicleMeshFrameRotDeltaRad = quaternionAngle(meshMotionState.quaternion, currentMeshQuat);
        localVehicleMeshDeltaSamplesRef.current.push({ atMs: now, value: localVehicleMeshDeltaM });
        localVehicleMeshFrameDeltaSamplesRef.current.push({ atMs: now, value: localVehicleMeshFrameDeltaM });
        localVehicleMeshFrameRotSamplesRef.current.push({ atMs: now, value: localVehicleMeshFrameRotDeltaRad });
        if ((localVehicleDebug?.speedMs ?? 0) < 1 && (localVehicleDebug?.groundedWheels ?? 0) === 4) {
          localVehicleRestJitterSamplesRef.current.push({ atMs: now, value: localVehicleMeshDeltaM });
        }
        if (Math.abs(localVehicleDebug?.steering ?? 0) < 0.05 && (localVehicleDebug?.groundedWheels ?? 0) >= 3) {
          localVehicleStraightJitterSamplesRef.current.push({ atMs: now, value: localVehicleMeshDeltaM });
        }
      }
      trimTimedScalars(localVehicleMeshDeltaSamplesRef.current, now);
      trimTimedScalars(localVehicleRestJitterSamplesRef.current, now);
      trimTimedScalars(localVehicleStraightJitterSamplesRef.current, now);
      trimTimedScalars(localVehicleMeshFrameDeltaSamplesRef.current, now);
      trimTimedScalars(localVehicleMeshFrameRotSamplesRef.current, now);
      meshMotionState.vehicleId = drivenVehicleId;
      meshMotionState.position.set(
        visualVehiclePose.position[0],
        visualVehiclePose.position[1],
        visualVehiclePose.position[2],
      );
      meshMotionState.quaternion.copy(currentMeshQuat);
      meshMotionState.euler.copy(currentMeshEuler);
      meshMotionState.groundedWheels = groundedWheels;

      if (localVehicleAuthoritativeSample) {
        localVehiclePredictedAuthDeltaSamplesRef.current.push({
          atMs: now,
          value: distanceVec3(multiplayerVehiclePose.position, localVehicleAuthoritativeSample.position),
        });
      }
      trimTimedScalars(localVehicleMeshDeltaSamplesRef.current, now);
      trimTimedScalars(localVehiclePredictedAuthDeltaSamplesRef.current, now);
    } else {
      clearTimedScalars(
        localVehicleMeshDeltaSamplesRef.current,
        localVehicleRestJitterSamplesRef.current,
        localVehicleStraightJitterSamplesRef.current,
        localVehiclePredictedAuthDeltaSamplesRef.current,
        localVehicleRawHeaveSamplesRef.current,
        localVehicleRawPlanarSamplesRef.current,
        localVehicleRawYawSamplesRef.current,
        localVehicleRawPitchSamplesRef.current,
        localVehicleRawRollSamplesRef.current,
        localVehicleResidualSamplesRef.current,
        localVehicleResidualPlanarSamplesRef.current,
        localVehicleResidualHeaveSamplesRef.current,
        localVehicleResidualYawSamplesRef.current,
        localVehicleResidualPitchSamplesRef.current,
        localVehicleResidualRollSamplesRef.current,
        localVehicleRawRestHeaveSamplesRef.current,
        localVehicleRawStraightHeaveSamplesRef.current,
        localVehicleWheelContactBitChangeSamplesRef.current,
        localVehicleSuspensionLengthDeltaSamplesRef.current,
        localVehicleSuspensionForceDeltaSamplesRef.current,
        localVehicleSuspensionLengthSpreadSamplesRef.current,
        localVehicleSuspensionForceSpreadSamplesRef.current,
        localVehicleContactNormalDeltaSamplesRef.current,
        localVehicleGroundObjectSwitchSamplesRef.current,
        localVehicleMeshFrameDeltaSamplesRef.current,
        localVehicleMeshFrameRotSamplesRef.current,
        localVehicleCameraFrameDeltaSamplesRef.current,
        localVehicleCameraFrameRotSamplesRef.current,
        localVehicleGroundedTransitionSamplesRef.current,
        localVehicleGroundedSamplesRef.current,
      );
      localVehicleRawJitterStateRef.current.vehicleId = null;
      localVehicleRawJitterStateRef.current.groundedWheels = 0;
      localVehicleRawJitterStateRef.current.linearVelocity = [0, 0, 0];
      localVehicleRawJitterStateRef.current.angularVelocity = [0, 0, 0];
      localVehicleRawJitterStateRef.current.wheelContactBits = 0;
      localVehicleRawJitterStateRef.current.suspensionLengths = [0, 0, 0, 0];
      localVehicleRawJitterStateRef.current.suspensionForces = [0, 0, 0, 0];
      localVehicleRawJitterStateRef.current.suspensionRelativeVelocities = [0, 0, 0, 0];
      localVehicleRawJitterStateRef.current.wheelContactNormals = [];
      localVehicleRawJitterStateRef.current.wheelGroundObjectIds = [0, 0, 0, 0];
      localVehicleMeshMotionStateRef.current.vehicleId = null;
      localVehicleCameraMotionStateRef.current.vehicleId = null;
    }
    const isDrivingNow = client.isInVehicle();
    const pointerLocked = document.pointerLockElement === gl.domElement;
    const inputSample = inputManagerRef.current?.sample(
      frameDelta,
      pointerLocked,
      isDrivingNow ? 'vehicle' : 'onFoot',
      inputBindings,
      inputFamilyMode,
    )
      ?? { activeFamily: null, action: null, context: isDrivingNow ? 'vehicle' : 'onFoot' as const };
    onInputFrameRef.current?.(inputSample);
    prediction.advanceDynamicBodies(frameDelta, !prediction.isInVehicle());
    const physStats = prediction.getDebugStats();

    if (inputSample.action?.materialSlot1Pressed) selectedMaterialRef.current = 1;
    if (inputSample.action?.materialSlot2Pressed) selectedMaterialRef.current = 2;

    if (isDrivingNow) {
      const updatedCamera = advanceVehicleCamera(
        vehicleCameraYawOffsetRef.current,
        vehicleCameraPitchRef.current,
        inputSample.action,
        now - lastVehicleLookAtMsRef.current,
        frameDelta,
      );
      vehicleCameraYawOffsetRef.current = updatedCamera.orbitYaw;
      vehicleCameraPitchRef.current = updatedCamera.orbitPitch;
      if (updatedCamera.hadLookInput) {
        lastVehicleLookAtMsRef.current = now;
      }
    } else {
      const look = advanceLookAngles(yawRef.current, pitchRef.current, inputSample.action);
      yawRef.current = look.yaw;
      pitchRef.current = look.pitch;
    }

    const vehicleBenchmarkEnabled = benchmarkAutopilot?.enabled
      && benchmarkAutopilot.scenario.playBenchmark?.mode === 'vehicle_driver';
    const botAutopilotEnabled = Boolean(
      benchmarkAutopilot?.enabled
      && benchmarkAutopilot.scenario.playBenchmark?.mode !== 'vehicle_driver'
      && botBrainRef.current
      && !isDrivingNow,
    );
    const autopilotInput = vehicleBenchmarkEnabled
      ? resolveVehicleBenchmarkInput(
          benchmarkVehicleDriverRef.current,
          now,
          isDrivingNow,
          nearestVehicleIdRef.current,
          yawRef.current,
          pitchRef.current,
          inputSample.activeFamily,
          benchmarkAutopilot.scenario.playBenchmark?.driverProfile ?? 'mixed',
        )
      : botAutopilotEnabled
        ? (() => {
          const localPosition = prediction.getPosition() ?? state.localPosition;
          const localState = {
            position: localPosition,
            velocity: physStats.velocity,
            yaw: yawRef.current,
            pitch: pitchRef.current,
            hp: client?.localPlayerHp ?? 100,
            flags: localFlags,
          };
          const remotePlayers: ObservedPlayer[] = Array.from(state.remotePlayers.values()).map((remote) => ({
            id: remote.id,
            state: {
              position: remote.position,
              velocity: [0, 0, 0],
              yaw: remote.yaw,
              pitch: remote.pitch,
              hp: remote.hp,
              flags: remote.hp <= 0 ? FLAG_DEAD : 0,
            },
          }));
          const intent = stepBotBrain(
            botBrainRef.current!,
            benchmarkAutopilot!.scenario,
            localState,
            remotePlayers,
          );
          yawRef.current = intent.yaw;
          pitchRef.current = intent.pitch;
          return resolvedInputFromBotIntent(intent.buttons, intent.yaw, intent.pitch, intent.firePrimary);
        })()
        : null;
    const resolvedInput = autopilotInput ?? (isDrivingNow
      ? resolveVehicleInput(inputSample.action, yawRef.current, pitchRef.current, inputSample.activeFamily)
      : resolveOnFootInput(inputSample.action, yawRef.current, pitchRef.current, inputSample.activeFamily));

    // --- Vehicle spawn/despawn sync ---
    prediction.syncVehicleAuthority();

    // --- Enter/Exit vehicle on E press ---
    if (resolvedInput.interactPressed) {
      if (isDrivingNow) {
        // Exit current vehicle
        const vehiclePose = prediction.getVehiclePose();
        prediction.exitVehicle();
        void vehiclePose; // suppress unused warning
        // Notify server — find which vehicle we're in
        if (client) {
          for (const [id, vs] of client.vehicles) {
            if (vs.driverId === client.playerId) {
              client.sendVehicleExit(id);
              break;
            }
          }
        }
      } else if (nearestVehicleIdRef.current !== null) {
        const vehicleId = nearestVehicleIdRef.current;
        const vs = client.vehicles.get(vehicleId);
        if (vs && vs.driverId === 0) {
          // Enter vehicle — build a NetVehicleState from the VehicleStateMeters
          const initState: NetVehicleState = {
            id: vehicleId,
            pxMm: Math.round(vs.position[0] * 1000),
            pyMm: Math.round(vs.position[1] * 1000),
            pzMm: Math.round(vs.position[2] * 1000),
            qxSnorm: Math.round(vs.quaternion[0] * 32767),
            qySnorm: Math.round(vs.quaternion[1] * 32767),
            qzSnorm: Math.round(vs.quaternion[2] * 32767),
            qwSnorm: Math.round(vs.quaternion[3] * 32767),
            vxCms: Math.round(vs.linearVelocity[0] * 100),
            vyCms: Math.round(vs.linearVelocity[1] * 100),
            vzCms: Math.round(vs.linearVelocity[2] * 100),
            wxMrads: Math.round(vs.angularVelocity[0] * 1000),
            wyMrads: Math.round(vs.angularVelocity[1] * 1000),
            wzMrads: Math.round(vs.angularVelocity[2] * 1000),
            wheelData: vs.wheelData as [number, number, number, number],
            driverId: 0,
            vehicleType: vs.vehicleType ?? 0,
            flags: vs.flags ?? 0,
          };
          prediction.enterVehicle(vehicleId, initState);
          client.sendVehicleEnter(vehicleId, 0);
          // Snap smooth camera to initial vehicle position to avoid lerp-in from player pos
          smoothCamPos.current.set(vs.position[0], vs.position[1] + 2.5, vs.position[2] - 6);
          smoothVehicleFocus.current.set(vs.position[0], vs.position[1] + 1.0, vs.position[2]);
          vehicleCameraYawOffsetRef.current = 0;
          vehicleCameraPitchRef.current = VEHICLE_CAMERA_DEFAULT_PITCH;
          lastVehicleLookAtMsRef.current = now;
        }
      }
    }

    prediction.submitInput(frameDelta, resolvedInput);

    const canUseAimActions = !isDrivingNow && !localDead
      && (
        botAutopilotEnabled
        || pointerLocked
        || inputSample.activeFamily === 'gamepad'
        || inputSample.activeFamily === 'touch'
      );

    if (canUseAimActions) {
      if (resolvedInput.firePrimary && client && now >= nextLocalFireMsRef.current) {
        nextLocalFireMsRef.current = now + RIFLE_FIRE_INTERVAL_MS;
        const fireDir = aimDirectionFromAngles(yawRef.current, pitchRef.current);
        const aimOrigin: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
        const sceneHit = prediction.raycastScene(
          aimOrigin,
          fireDir,
          CROSSHAIR_MAX_DISTANCE,
        );
        const renderTimeUs = state.serverClock.renderTimeUs(state.interpolationDelayMs * 1000);
        const remoteHits = collectRemoteShotHits(
          state.remotePlayers,
          state.remoteInterpolator,
          renderTimeUs,
          prediction,
          aimOrigin,
          fireDir,
          sceneHit?.toi ?? null,
        );
        const blockerDistance = minDistance(sceneHit?.toi ?? null, closestRemoteShotDistance(remoteHits));
        const dynamicShot = prediction.predictDynamicBodyShot(
          aimOrigin,
          fireDir,
          CROSSHAIR_MAX_DISTANCE,
          blockerDistance,
        );
        const renderedBodies = Array.from(state.dynamicBodies.keys()).map((id) => {
          const renderBody = prediction.getRenderedDynamicBodyState(id) ?? {
            id,
            position: state.dynamicBodies.get(id)!.position,
            halfExtents: state.dynamicBodies.get(id)!.halfExtents,
          };
          return {
            id,
            position: renderBody.position,
            halfExtents: renderBody.halfExtents,
          };
        });
        const proxyBodies = prediction.listDynamicBodyProxyStates();
        const renderedHit = approxRenderedDynamicBodyHit(
          aimOrigin,
          fireDir,
          renderedBodies,
          CROSSHAIR_MAX_DISTANCE,
        );
        const nearestRenderedCandidate = nearestDynamicBodyCandidate(
          aimOrigin,
          fireDir,
          renderedBodies,
          CROSSHAIR_MAX_DISTANCE,
        );
        const nearestProxyCandidate = nearestDynamicBodyCandidate(
          aimOrigin,
          fireDir,
          proxyBodies,
          CROSSHAIR_MAX_DISTANCE,
        );
        const renderedHitProxyBody = renderedHit
          ? prediction.getDynamicBodyPhysicsState(renderedHit.bodyId)
          : null;
        let renderProxyDeltaM: number | null = null;
        if (renderedHit && dynamicShot.diagnostic.proxyHitBodyId === renderedHit.bodyId) {
          const renderBody = renderedBodies.find((body) => body.id === renderedHit.bodyId);
          const proxyBody = prediction.getDynamicBodyPhysicsState(renderedHit.bodyId);
          if (renderBody && proxyBody) {
            renderProxyDeltaM = Math.hypot(
              renderBody.position[0] - proxyBody.position[0],
              renderBody.position[1] - proxyBody.position[1],
              renderBody.position[2] - proxyBody.position[2],
            );
          }
        }
        let renderedBodyProxyCenterDeltaM: number | null = null;
        let renderedBodyProxyToi: number | null = null;
        if (renderedHit && renderedHitProxyBody) {
          const renderBody = renderedBodies.find((body) => body.id === renderedHit.bodyId);
          if (renderBody) {
            renderedBodyProxyCenterDeltaM = Math.hypot(
              renderBody.position[0] - renderedHitProxyBody.position[0],
              renderBody.position[1] - renderedHitProxyBody.position[1],
              renderBody.position[2] - renderedHitProxyBody.position[2],
            );
            renderedBodyProxyToi = approxBodyRayCandidate(
              aimOrigin,
              fireDir,
              renderedHitProxyBody.position,
              renderedHitProxyBody.halfExtents,
              CROSSHAIR_MAX_DISTANCE,
            )?.toi ?? null;
          }
        }
        const shotId = nextShotIdRef.current++ >>> 0;
        const targetedBodyId = dynamicShot.bodyId ?? renderedHit?.bodyId ?? null;
        const targetedBodyRecentInteraction = targetedBodyId != null
          ? prediction.hasRecentDynamicBodyInteraction(targetedBodyId)
          : false;
        const dynamicSampleAgeMs = targetedBodyId != null
          ? client.getDynamicBodyObservedAgeMs(targetedBodyId)
          : null;
        const dynamicLagMsForShot = Math.round(Math.max(
          state.dynamicBodyInterpolationDelayMs,
          dynamicSampleAgeMs ?? state.dynamicBodyInterpolationDelayMs,
        ));
        client.recordLocalShotFired(
          shotId,
          {
            predictedDynamicBodyId: dynamicShot.bodyId,
            interpDelayMs: state.interpolationDelayMs,
            dynamicInterpDelayMs: dynamicLagMsForShot,
            blockerDistance,
            proxyHitBodyId: dynamicShot.diagnostic.proxyHitBodyId,
            proxyHitToi: dynamicShot.diagnostic.proxyHitToi,
            blockedByBlocker: dynamicShot.diagnostic.blockedByBlocker,
            localPredictedDeltaM: dynamicShot.diagnostic.localPredictedDeltaM,
            dynamicSampleAgeMs,
            predictedBodyRecentInteraction: targetedBodyRecentInteraction,
            renderedBodyId: renderedHit?.bodyId ?? null,
            renderedBodyToi: renderedHit?.toi ?? null,
            renderProxyDeltaM,
            renderedBodyProxyPresent: Boolean(renderedHit && renderedHitProxyBody),
            renderedBodyProxyToi,
            renderedBodyProxyCenterDeltaM,
            nearestProxyBodyId: nearestProxyCandidate?.bodyId ?? null,
            nearestProxyBodyToi: nearestProxyCandidate?.toi ?? null,
            nearestProxyBodyMissDistanceM: nearestProxyCandidate?.missDistance ?? null,
            nearestProxyBodyRadiusM: nearestProxyCandidate?.radius ?? null,
            nearestRenderedBodyId: nearestRenderedCandidate?.bodyId ?? null,
            nearestRenderedBodyToi: nearestRenderedCandidate?.toi ?? null,
            nearestRenderedBodyMissDistanceM: nearestRenderedCandidate?.missDistance ?? null,
            nearestRenderedBodyRadiusM: nearestRenderedCandidate?.radius ?? null,
          },
        );
        localShotTraceRef.current = createLocalShotTrace(
          camera,
          now,
          fireDir,
          remoteHits,
          sceneHit?.toi ?? null,
        );
        client.sendFire({
          seq: prediction.peekNextInputSeq(),
          shotId,
          weapon: WEAPON_HITSCAN,
          clientFireTimeUs: client.serverClock.serverNowUs(),
          clientInterpMs: Math.round(state.interpolationDelayMs),
          clientDynamicInterpMs: dynamicLagMsForShot,
          dir: fireDir,
        });
      }

      if (prediction.supportsBlockEditing() && (resolvedInput.blockRemovePressed || resolvedInput.blockPlacePressed)) {
        const direction = aimDirectionFromAngles(yawRef.current, pitchRef.current);
        const hit = prediction.raycastBlocks(
          [camera.position.x, camera.position.y, camera.position.z],
          direction,
          6,
        );
        if (hit) {
          if (resolvedInput.blockRemovePressed && prediction.getBlockMaterial(hit.removeCell) !== 0) {
            const cmd = prediction.buildBlockEdit(hit.removeCell, BLOCK_REMOVE, 0);
            if (cmd) {
              prediction.applyOptimisticEdit(cmd);
              client.sendBlockEdit(cmd);
            }
          } else if (resolvedInput.blockPlacePressed && prediction.getBlockMaterial(hit.placeCell) === 0) {
            const cmd = prediction.buildBlockEdit(hit.placeCell, BLOCK_ADD, selectedMaterialRef.current);
            if (cmd) {
              prediction.applyOptimisticEdit(cmd);
              client.sendBlockEdit(cmd);
            }
          }
        }
      }
    }

    // Camera follows interpolated predicted position (falls back to server-authoritative)
    const isDriving = isDrivingNow;
    const vehiclePoseForCamera = localVehicleVisualPose ?? localControlledVehiclePose;
    const predictedPos = prediction.getPosition();
    const pos = predictedPos ?? state.localPosition;
    const yaw = yawRef.current;
    const pitch = pitchRef.current;

    if (isDriving && vehiclePoseForCamera) {
      const chassisPos = vehiclePoseForCamera.position;
      const fullQuat = new THREE.Quaternion(
        vehiclePoseForCamera.quaternion[0],
        vehiclePoseForCamera.quaternion[1],
        vehiclePoseForCamera.quaternion[2],
        vehiclePoseForCamera.quaternion[3],
      );
      const euler = new THREE.Euler().setFromQuaternion(fullQuat, 'YXZ');
      const orbitYaw = euler.y + vehicleCameraYawOffsetRef.current;
      const orbitPitch = vehicleCameraPitchRef.current;
      const focusY = chassisPos[1] + 1.0;
      const followDistance = 6.0;
      if (vehicleSmoothingEnabled) {
        const focusSmoothRate = Math.min(frameDelta * 12.0, 1.0);
        smoothVehicleFocus.current.set(
          smoothVehicleFocus.current.x + (chassisPos[0] - smoothVehicleFocus.current.x) * focusSmoothRate,
          smoothVehicleFocus.current.y + (focusY - smoothVehicleFocus.current.y) * focusSmoothRate,
          smoothVehicleFocus.current.z + (chassisPos[2] - smoothVehicleFocus.current.z) * focusSmoothRate,
        );
        const targetX = smoothVehicleFocus.current.x - Math.sin(orbitYaw) * Math.cos(orbitPitch) * followDistance;
        const targetY = smoothVehicleFocus.current.y + Math.sin(orbitPitch) * followDistance + 1.0;
        const targetZ = smoothVehicleFocus.current.z - Math.cos(orbitYaw) * Math.cos(orbitPitch) * followDistance;

        const smoothRate = Math.min(frameDelta * 18.0, 1.0);
        smoothCamPos.current.set(
          smoothCamPos.current.x + (targetX - smoothCamPos.current.x) * smoothRate,
          smoothCamPos.current.y + (targetY - smoothCamPos.current.y) * smoothRate,
          smoothCamPos.current.z + (targetZ - smoothCamPos.current.z) * smoothRate,
        );
        camera.position.copy(smoothCamPos.current);
        camera.lookAt(smoothVehicleFocus.current);
      } else {
        const focusX = chassisPos[0];
        const focusZ = chassisPos[2];
        const targetX = focusX - Math.sin(orbitYaw) * Math.cos(orbitPitch) * followDistance;
        const targetY = focusY + Math.sin(orbitPitch) * followDistance + 1.0;
        const targetZ = focusZ - Math.cos(orbitYaw) * Math.cos(orbitPitch) * followDistance;
        smoothVehicleFocus.current.set(focusX, focusY, focusZ);
        smoothCamPos.current.set(targetX, targetY, targetZ);
        camera.position.copy(smoothCamPos.current);
        camera.lookAt(focusX, focusY, focusZ);
      }
    } else {
      const eyeHeight = PLAYER_EYE_HEIGHT;
      camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
      const lookX = pos[0] + Math.sin(yaw) * Math.cos(pitch);
      const lookY = pos[1] + eyeHeight + Math.sin(pitch);
      const lookZ = pos[2] + Math.cos(yaw) * Math.cos(pitch);
      camera.lookAt(lookX, lookY, lookZ);
    }

    if (isDriving && drivenVehicleId != null) {
      const cameraMotionState = localVehicleCameraMotionStateRef.current;
      const currentCameraEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      const cameraFrameDeltaM = cameraMotionState.vehicleId === drivenVehicleId
        ? camera.position.distanceTo(cameraMotionState.position)
        : 0;
      const resetCameraMotion = cameraMotionState.vehicleId !== drivenVehicleId || cameraFrameDeltaM >= 12.0;
      if (resetCameraMotion) {
        clearTimedScalars(
          localVehicleCameraFrameDeltaSamplesRef.current,
          localVehicleCameraFrameRotSamplesRef.current,
        );
      } else {
        localVehicleCameraFrameDeltaM = cameraFrameDeltaM;
        localVehicleCameraFrameRotDeltaRad = quaternionAngle(cameraMotionState.quaternion, camera.quaternion);
        localVehicleCameraFrameDeltaSamplesRef.current.push({ atMs: now, value: localVehicleCameraFrameDeltaM });
        localVehicleCameraFrameRotSamplesRef.current.push({ atMs: now, value: localVehicleCameraFrameRotDeltaRad });
      }
      trimTimedScalars(localVehicleCameraFrameDeltaSamplesRef.current, now);
      trimTimedScalars(localVehicleCameraFrameRotSamplesRef.current, now);
      cameraMotionState.vehicleId = drivenVehicleId;
      cameraMotionState.position.copy(camera.position);
      cameraMotionState.quaternion.copy(camera.quaternion);
      cameraMotionState.euler.copy(currentCameraEuler);
    } else {
      clearTimedScalars(
        localVehicleCameraFrameDeltaSamplesRef.current,
        localVehicleCameraFrameRotSamplesRef.current,
      );
      localVehicleCameraMotionStateRef.current.vehicleId = null;
    }

    // Debug logging
    logTimer.current++;
    if (logTimer.current % 120 === 0) {
      console.log('[game] local pos:', pos, 'remotePlayers:', state.remotePlayers.size, 'tick:', state.latestServerTick);
    }

    // Report per-frame debug stats to server (aggregated to 1 Hz)
    client?.accumulateDebugStats(physStats.playerCorrectionMagnitude, physStats.physicsStepMs);
    client?.recordFrameDebugMetrics(
      physStats.playerCorrectionMagnitude,
      physStats.vehicleCorrectionMagnitude,
      physStats.dynamicGlobalMaxCorrectionMagnitude,
      physStats.pendingInputs,
    );

    updateLocalShotTraceVisuals(
      localShotTraceRef.current,
      now,
      shotTraceBeamRef.current,
      shotTraceImpactRef.current,
    );

    // Debug overlay stats
    if (onDebugFrameRef.current) {
      const vehicleServerSpeedMs = drivenVehicleState
        ? Math.hypot(
            drivenVehicleState.linearVelocity[0],
            drivenVehicleState.linearVelocity[1],
            drivenVehicleState.linearVelocity[2],
          )
        : 0;
      const vehiclePosDeltaM = localControlledVehiclePose && drivenVehicleState
        ? distanceVec3(localControlledVehiclePose.position, drivenVehicleState.position)
        : 0;
      const vehicleSampledAuthDeltaM = localControlledVehiclePose && localVehicleAuthoritativeSample
        ? distanceVec3(localControlledVehiclePose.position, localVehicleAuthoritativeSample.position)
        : 0;
      const vehicleMeshAuthDeltaM = localVehicleVisualPose && localVehicleAuthoritativeSample
        ? distanceVec3(localVehicleVisualPose.position, localVehicleAuthoritativeSample.position)
        : 0;
      const vehicleLatestVsSampledAuthDeltaM = drivenVehicleState && localVehicleAuthoritativeSample
        ? distanceVec3(drivenVehicleState.position, localVehicleAuthoritativeSample.position)
        : 0;
      const vehicleMeshCurrentAuthDeltaM = localVehicleVisualPose && localVehicleAuthoritativeNowSample
        ? distanceVec3(localVehicleVisualPose.position, localVehicleAuthoritativeNowSample.position)
        : 0;
      const vehicleAuthObservedAgeMs = client && drivenVehicleId != null
        ? (client.getVehicleObservedAgeMs(drivenVehicleId) ?? -1)
        : -1;
      const vehicleAuthSampleOffsetMs = localVehicleAuthoritativeSample
        ? Math.max(0, (state.serverClock.serverNowUs() - localVehicleAuthoritativeSample.serverTimeUs) / 1000)
        : -1;
      const vehicleAuthSampleServerDeltaMs = vehicleAuthObservedAgeMs >= 0 && vehicleAuthSampleOffsetMs >= 0
        ? vehicleAuthObservedAgeMs - vehicleAuthSampleOffsetMs
        : -1;
      const vehicleAuthCurrentOffsetMs = localVehicleAuthoritativeNowSample && localVehicleNowTimeUs != null
        ? Math.max(0, (localVehicleNowTimeUs - localVehicleAuthoritativeNowSample.serverTimeUs) / 1000)
        : -1;
      const vehicleCurrentAuthPlanarDeltaM = localControlledVehiclePose && localVehicleAuthoritativeNowSample
        ? Math.hypot(
            localControlledVehiclePose.position[0] - localVehicleAuthoritativeNowSample.position[0],
            localControlledVehiclePose.position[2] - localVehicleAuthoritativeNowSample.position[2],
          )
        : 0;
      const vehicleCurrentAuthVerticalDeltaM = localControlledVehiclePose && localVehicleAuthoritativeNowSample
        ? Math.abs(localControlledVehiclePose.position[1] - localVehicleAuthoritativeNowSample.position[1])
        : 0;
      const vehicleExpectedLeadM = localVehicleAuthoritativeNowSample
        ? Math.hypot(
            localVehicleAuthoritativeNowSample.linearVelocity[0],
            localVehicleAuthoritativeNowSample.linearVelocity[1],
            localVehicleAuthoritativeNowSample.linearVelocity[2],
          ) * Math.max(0, physStats.vehicleAckBacklogMs / 1000)
        : 0;
      const vehicleCurrentAuthUnexplainedDeltaM = localControlledVehiclePose && localVehicleAuthoritativeNowSample
        ? (() => {
            const backlogSec = Math.max(0, physStats.vehicleAckBacklogMs / 1000);
            const extrapolatedCurrentAuthPosition: [number, number, number] = [
              localVehicleAuthoritativeNowSample.position[0] + localVehicleAuthoritativeNowSample.linearVelocity[0] * backlogSec,
              localVehicleAuthoritativeNowSample.position[1] + localVehicleAuthoritativeNowSample.linearVelocity[1] * backlogSec,
              localVehicleAuthoritativeNowSample.position[2] + localVehicleAuthoritativeNowSample.linearVelocity[2] * backlogSec,
            ];
            return distanceVec3(localControlledVehiclePose.position, extrapolatedCurrentAuthPosition);
          })()
        : 0;
      onDebugFrameRef.current(
        frameDelta * 1000,
        gl.info,
        {
          pingMs: client?.rttMs ?? 0,
          serverTick: state.latestServerTick,
          interpolationDelayMs: state.interpolationDelayMs,
          dynamicBodyInterpolationDelayMs: client?.dynamicBodyInterpolationDelayMs ?? 0,
          clockOffsetUs: state.serverClock.getOffsetUs(),
          remotePlayers: state.remotePlayers.size,
          transport: client?.transport ?? 'connecting',
          playerId: state.playerId,
        },
        {
          rapierDebugLabel: rapierDebugModeLabel(rapierDebugModeBits),
          rapierDebugModeBits,
        },
        physStats,
        {
          id: drivenVehicleId ?? 0,
          driverConfirmed: Boolean(drivenVehicleState && client && drivenVehicleState.driverId === client.playerId),
          localSpeedMs: localVehicleDebug?.speedMs ?? 0,
          serverSpeedMs: vehicleServerSpeedMs,
          posDeltaM: vehiclePosDeltaM,
          groundedWheels: localVehicleDebug?.groundedWheels ?? 0,
          steering: localVehicleDebug?.steering ?? 0,
          engineForce: localVehicleDebug?.engineForce ?? 0,
          brake: localVehicleDebug?.brake ?? 0,
          meshDeltaM: localVehicleMeshDeltaM,
          meshRotDeltaRad: localVehicleMeshRotDeltaRad,
          meshDeltaRms5sM: rmsTimedScalars(localVehicleMeshDeltaSamplesRef.current),
          meshDeltaPeak5sM: peakTimedScalars(localVehicleMeshDeltaSamplesRef.current),
          restJitterRms5sM: rmsTimedScalars(localVehicleRestJitterSamplesRef.current),
          straightJitterRms5sM: rmsTimedScalars(localVehicleStraightJitterSamplesRef.current),
          rawHeaveDeltaRms5sM: rmsTimedScalars(localVehicleRawHeaveSamplesRef.current),
          rawHeaveDeltaPeak5sM: peakTimedScalars(localVehicleRawHeaveSamplesRef.current),
          rawPlanarDeltaRms5sM: rmsTimedScalars(localVehicleRawPlanarSamplesRef.current),
          rawPlanarDeltaPeak5sM: peakTimedScalars(localVehicleRawPlanarSamplesRef.current),
          rawYawDeltaRms5sRad: rmsTimedScalars(localVehicleRawYawSamplesRef.current),
          rawYawDeltaPeak5sRad: peakTimedScalars(localVehicleRawYawSamplesRef.current),
          rawPitchDeltaRms5sRad: rmsTimedScalars(localVehicleRawPitchSamplesRef.current),
          rawPitchDeltaPeak5sRad: peakTimedScalars(localVehicleRawPitchSamplesRef.current),
          rawRollDeltaRms5sRad: rmsTimedScalars(localVehicleRawRollSamplesRef.current),
          rawRollDeltaPeak5sRad: peakTimedScalars(localVehicleRawRollSamplesRef.current),
          residualDeltaRms5sM: rmsTimedScalars(localVehicleResidualSamplesRef.current),
          residualDeltaPeak5sM: peakTimedScalars(localVehicleResidualSamplesRef.current),
          residualPlanarDeltaRms5sM: rmsTimedScalars(localVehicleResidualPlanarSamplesRef.current),
          residualPlanarDeltaPeak5sM: peakTimedScalars(localVehicleResidualPlanarSamplesRef.current),
          residualHeaveDeltaRms5sM: rmsTimedScalars(localVehicleResidualHeaveSamplesRef.current),
          residualHeaveDeltaPeak5sM: peakTimedScalars(localVehicleResidualHeaveSamplesRef.current),
          residualYawDeltaRms5sRad: rmsTimedScalars(localVehicleResidualYawSamplesRef.current),
          residualYawDeltaPeak5sRad: peakTimedScalars(localVehicleResidualYawSamplesRef.current),
          residualPitchDeltaRms5sRad: rmsTimedScalars(localVehicleResidualPitchSamplesRef.current),
          residualPitchDeltaPeak5sRad: peakTimedScalars(localVehicleResidualPitchSamplesRef.current),
          residualRollDeltaRms5sRad: rmsTimedScalars(localVehicleResidualRollSamplesRef.current),
          residualRollDeltaPeak5sRad: peakTimedScalars(localVehicleResidualRollSamplesRef.current),
          rawRestHeaveDeltaRms5sM: rmsTimedScalars(localVehicleRawRestHeaveSamplesRef.current),
          rawStraightHeaveDeltaRms5sM: rmsTimedScalars(localVehicleRawStraightHeaveSamplesRef.current),
          wheelContactBits: localVehicleWheelContactBits,
          wheelContactBitChanges5s: countTimedScalars(localVehicleWheelContactBitChangeSamplesRef.current),
          wheelContactNormals: localVehicleWheelContactNormals.map((normal) => [...normal] as [number, number, number]),
          wheelContactNormalDeltaRms5sRad: rmsTimedScalars(localVehicleContactNormalDeltaSamplesRef.current),
          wheelGroundObjectIds: [...localVehicleWheelGroundObjectIds] as [number, number, number, number],
          wheelGroundObjectSwitches5s: countTimedScalars(localVehicleGroundObjectSwitchSamplesRef.current),
          suspensionLengths: localVehicleSuspensionLengths,
          suspensionForces: localVehicleSuspensionForces,
          suspensionRelativeVelocities: localVehicleSuspensionRelativeVelocities,
          suspensionLengthSpreadM: localVehicleSuspensionLengthSpreadM,
          suspensionLengthSpreadPeak5sM: peakTimedScalars(localVehicleSuspensionLengthSpreadSamplesRef.current),
          suspensionLengthDeltaRms5sM: rmsTimedScalars(localVehicleSuspensionLengthDeltaSamplesRef.current),
          suspensionForceSpreadN: localVehicleSuspensionForceSpreadN,
          suspensionForceSpreadPeak5sN: peakTimedScalars(localVehicleSuspensionForceSpreadSamplesRef.current),
          suspensionForceDeltaRms5sN: rmsTimedScalars(localVehicleSuspensionForceDeltaSamplesRef.current),
          meshFrameDeltaRms5sM: rmsTimedScalars(localVehicleMeshFrameDeltaSamplesRef.current),
          meshFrameDeltaPeak5sM: peakTimedScalars(localVehicleMeshFrameDeltaSamplesRef.current),
          meshFrameRotDeltaRms5sRad: rmsTimedScalars(localVehicleMeshFrameRotSamplesRef.current),
          meshFrameRotDeltaPeak5sRad: peakTimedScalars(localVehicleMeshFrameRotSamplesRef.current),
          cameraFrameDeltaRms5sM: rmsTimedScalars(localVehicleCameraFrameDeltaSamplesRef.current),
          cameraFrameDeltaPeak5sM: peakTimedScalars(localVehicleCameraFrameDeltaSamplesRef.current),
          cameraFrameRotDeltaRms5sRad: rmsTimedScalars(localVehicleCameraFrameRotSamplesRef.current),
          cameraFrameRotDeltaPeak5sRad: peakTimedScalars(localVehicleCameraFrameRotSamplesRef.current),
          groundedTransitions5s: countTimedScalars(localVehicleGroundedTransitionSamplesRef.current),
          groundedMin5s: minTimedScalars(localVehicleGroundedSamplesRef.current),
          groundedMax5s: maxTimedScalars(localVehicleGroundedSamplesRef.current),
          latestAuthDeltaM: vehiclePosDeltaM,
          sampledAuthDeltaM: vehicleSampledAuthDeltaM,
          meshAuthDeltaM: vehicleMeshAuthDeltaM,
          latestVsSampledAuthDeltaM: vehicleLatestVsSampledAuthDeltaM,
          currentAuthDeltaM: localVehicleCurrentAuthDeltaM,
          meshCurrentAuthDeltaM: vehicleMeshCurrentAuthDeltaM,
          expectedLeadM: vehicleExpectedLeadM,
          currentAuthUnexplainedDeltaM: vehicleCurrentAuthUnexplainedDeltaM,
          currentAuthPlanarDeltaM: vehicleCurrentAuthPlanarDeltaM,
          currentAuthVerticalDeltaM: vehicleCurrentAuthVerticalDeltaM,
          authObservedAgeMs: vehicleAuthObservedAgeMs,
          authSampleOffsetMs: vehicleAuthSampleOffsetMs,
          authSampleServerDeltaMs: vehicleAuthSampleServerDeltaMs,
          authCurrentOffsetMs: vehicleAuthCurrentOffsetMs,
          predictedAuthDeltaRms5sM: rmsTimedScalars(localVehiclePredictedAuthDeltaSamplesRef.current),
          predictedAuthDeltaPeak5sM: peakTimedScalars(localVehiclePredictedAuthDeltaSamplesRef.current),
          capture: {
            predictedFrameDeltaM: localVehicleRawFrameDeltaM,
            predictedPlanarDeltaM: localVehicleRawPlanarDeltaM,
            predictedHeaveDeltaM: localVehicleRawHeaveDeltaM,
            predictedYawDeltaRad: localVehicleRawYawDeltaRad,
            predictedPitchDeltaRad: localVehicleRawPitchDeltaRad,
            predictedRollDeltaRad: localVehicleRawRollDeltaRad,
            predictedResidualDeltaM: localVehicleResidualFrameDeltaM,
            predictedResidualPlanarDeltaM: localVehicleResidualPlanarDeltaM,
            predictedResidualHeaveDeltaM: localVehicleResidualHeaveDeltaM,
            predictedResidualYawDeltaRad: localVehicleResidualYawDeltaRad,
            predictedResidualPitchDeltaRad: localVehicleResidualPitchDeltaRad,
            predictedResidualRollDeltaRad: localVehicleResidualRollDeltaRad,
            meshFrameDeltaM: localVehicleMeshFrameDeltaM,
            meshFrameRotDeltaRad: localVehicleMeshFrameRotDeltaRad,
            cameraFrameDeltaM: localVehicleCameraFrameDeltaM,
            cameraFrameRotDeltaRad: localVehicleCameraFrameRotDeltaRad,
            groundedTransitionThisFrame: localVehicleGroundedTransitionThisFrame,
            wheelContactBits: localVehicleWheelContactBits,
            wheelContactBitChangesThisFrame: localVehicleWheelContactBitChangesThisFrame,
            wheelContactNormalDeltaRad: localVehicleWheelContactNormalDeltaRad,
            wheelGroundObjectSwitchesThisFrame: localVehicleGroundObjectSwitchesThisFrame,
            suspensionLengthSpreadM: localVehicleSuspensionLengthSpreadM,
            suspensionForceSpreadN: localVehicleSuspensionForceSpreadN,
            suspensionLengthDeltaM: localVehicleSuspensionLengthDeltaM,
            suspensionForceDeltaN: localVehicleSuspensionForceDeltaN,
            expectedLeadM: vehicleExpectedLeadM,
            currentAuthUnexplainedDeltaM: vehicleCurrentAuthUnexplainedDeltaM,
            currentAuthPlanarDeltaM: vehicleCurrentAuthPlanarDeltaM,
            currentAuthVerticalDeltaM: vehicleCurrentAuthVerticalDeltaM,
            predictedPosition: localControlledVehiclePose ? [...localControlledVehiclePose.position] as [number, number, number] : null,
            meshPosition: localVehicleVisualPose ? [...localVehicleVisualPose.position] as [number, number, number] : null,
            currentAuthPosition: localVehicleAuthoritativeNowSample ? [...localVehicleAuthoritativeNowSample.position] as [number, number, number] : null,
            cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
          },
        },
        client?.getDebugTelemetrySnapshot() ?? {
          lastSnapshotGapMs: 0,
          snapshotGapP95Ms: 0,
          snapshotGapMaxMs: 0,
          lastSnapshotSource: 'none',
          staleSnapshotsDropped: 0,
          reliableSnapshotsReceived: 0,
          datagramSnapshotsReceived: 0,
          localSnapshotsReceived: 0,
          directSnapshotsReceived: 0,
          playerCorrectionPeak5sM: 0,
          vehicleCorrectionPeak5sM: 0,
          dynamicCorrectionPeak5sM: 0,
          pendingInputsPeak5s: 0,
          shotsFired: 0,
          shotsPending: 0,
          shotAuthoritativeMoves: 0,
          shotMismatches: 0,
          lastShotOutcome: 'none',
          lastShotOutcomeAgeMs: -1,
          lastShotPredictedBodyId: 0,
          lastShotProxyHitBodyId: 0,
          lastShotProxyHitToi: -1,
          lastShotBlockedByBlocker: false,
          lastShotLocalPredictedDeltaM: -1,
          lastShotDynamicSampleAgeMs: -1,
          lastShotPredictedBodyRecentInteraction: false,
          lastShotBlockerDistance: -1,
          lastShotRenderedBodyId: 0,
          lastShotRenderedBodyToi: -1,
          lastShotRenderProxyDeltaM: -1,
          lastShotRenderedBodyProxyPresent: false,
          lastShotRenderedBodyProxyToi: -1,
          lastShotRenderedBodyProxyCenterDeltaM: -1,
          lastShotNearestProxyBodyId: 0,
          lastShotNearestProxyBodyToi: -1,
          lastShotNearestProxyBodyMissDistanceM: -1,
          lastShotNearestProxyBodyRadiusM: -1,
          lastShotNearestRenderedBodyId: 0,
          lastShotNearestRenderedBodyToi: -1,
          lastShotNearestRenderedBodyMissDistanceM: -1,
          lastShotNearestRenderedBodyRadiusM: -1,
          lastShotServerResolution: 0,
          lastShotServerDynamicBodyId: 0,
          lastShotServerDynamicHitToiM: -1,
          lastShotServerDynamicImpulseMag: -1,
          recentEvents: [],
        },
        pos as [number, number, number],
        {
          velocity: physStats.velocity,
          hp: client?.localPlayerHp ?? 100,
          localFlags: client?.localPlayerFlags ?? 0,
        },
      );
    }

    // Update remote player meshes
    const group = remoteGroupRef.current;
    if (!group) return;

    const currentRemote = state.remotePlayers;
    const activeIds = new Set<number>();
    const renderTimeUs = state.serverClock.renderTimeUs(state.interpolationDelayMs * 1000);
    let crosshairAimState: CrosshairAimState = 'idle';
    let closestAimDistance = Number.POSITIVE_INFINITY;

    if (prediction.supportsRemotePlayerHitscan() && canUseAimActions) {
      const aimOrigin: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
      const aimDirection = aimDirectionFromAngles(yawRef.current, pitchRef.current);
      const sceneHit = prediction.raycastScene(aimOrigin, aimDirection, CROSSHAIR_MAX_DISTANCE);
      const blockerDistance = sceneHit?.toi ?? null;

      for (const [id, rp] of currentRemote) {
        const sample = state.remoteInterpolator.sample(id, renderTimeUs);
        const remoteFlags = sample?.flags ?? (rp.hp <= 0 ? FLAG_DEAD : 0);
        if ((remoteFlags & FLAG_DEAD) !== 0) {
          continue;
        }
        const position = sample?.position ?? rp.position;
        const hit = prediction.classifyHitscanPlayer(aimOrigin, aimDirection, position, blockerDistance);
        if (!hit || hit.distance >= closestAimDistance) {
          continue;
        }
        closestAimDistance = hit.distance;
        crosshairAimState = hit.kind === 2 ? 'head' : 'body';
      }
    }

    if (crosshairAimState !== lastAimStateRef.current) {
      lastAimStateRef.current = crosshairAimState;
      onAimStateChangeRef.current?.(crosshairAimState);
    }

    for (const [id, rp] of currentRemote) {
      activeIds.add(id);
      let playerGroup = remoteMeshes.current.get(id);
      if (!playerGroup) {
        playerGroup = createPlayerMesh(id);
        group.add(playerGroup);
        remoteMeshes.current.set(id, playerGroup);
        console.log('[game] Created mesh for remote player', id);
      }
      const sample = state.remoteInterpolator.sample(id, renderTimeUs);
      const remoteFlags = sample?.flags ?? (rp.hp <= 0 ? FLAG_DEAD : 0);
      let position = sample?.position ?? rp.position;
      let yaw = sample?.yaw ?? rp.yaw;
      const hp = sample?.hp ?? rp.hp;
      const replicatedHp = rp.hp;
      const previousHp = remoteLastHpRef.current.get(id);
      if (previousHp != null && replicatedHp < previousHp) {
        remoteHitFlashUntilRef.current.set(id, now + REMOTE_HIT_FLASH_MS);
      }
      remoteLastHpRef.current.set(id, replicatedHp);
      const isDead = (remoteFlags & FLAG_DEAD) !== 0;
      const isInVehicle = (remoteFlags & FLAG_IN_VEHICLE) !== 0;
      if (isInVehicle && client) {
        for (const [vehicleId, vehicleState] of client.vehicles) {
          if (vehicleState.driverId !== id) continue;
          const vehicleSample = client.sampleRemoteVehicle(vehicleId, renderTimeUs);
          const vehiclePosition = vehicleSample?.position ?? vehicleState.position;
          const vehicleQuaternion = vehicleSample?.quaternion ?? vehicleState.quaternion;
          position = [vehiclePosition[0], vehiclePosition[1] + 0.8, vehiclePosition[2]];
          yaw = new THREE.Euler().setFromQuaternion(
            new THREE.Quaternion(
              vehicleQuaternion[0],
              vehicleQuaternion[1],
              vehicleQuaternion[2],
              vehicleQuaternion[3],
            ),
            'YXZ',
          ).y;
          break;
        }
      }
      playerGroup.position.set(position[0], position[1], position[2]);
      playerGroup.rotation.y = yaw;
      const body = playerGroup.getObjectByName('body') as THREE.Mesh | undefined;
      const head = playerGroup.getObjectByName('head');
      const nose = playerGroup.getObjectByName('nose');
      if (body) body.visible = !isInVehicle;
      if (head) head.visible = !isInVehicle;
      if (nose) nose.visible = !isInVehicle;
      if (body && body.material instanceof THREE.MeshStandardMaterial) {
        const baseColor = body.userData.baseColor as THREE.Color | undefined;
        const flashUntil = remoteHitFlashUntilRef.current.get(id) ?? 0;
        const flashAlpha = flashUntil > now ? (flashUntil - now) / REMOTE_HIT_FLASH_MS : 0;
        const flashColor = new THREE.Color(0xfff36b);
        body.material.opacity = isDead ? 0.35 : 1;
        body.material.transparent = isDead;
        if (baseColor) {
          body.material.color.copy(baseColor).lerp(flashColor, flashAlpha);
          body.material.emissive.copy(baseColor).lerp(flashColor, flashAlpha * 0.85);
        }
        body.material.emissiveIntensity = isDead ? 0 : Math.max(hp < 30 ? 0.6 : 0.3, flashAlpha * 1.2);
      }
    }

    // Remove stale
    for (const [id, mesh] of remoteMeshes.current) {
      if (!activeIds.has(id)) {
        group.remove(mesh);
        remoteMeshes.current.delete(id);
        remoteLastHpRef.current.delete(id);
        remoteHitFlashUntilRef.current.delete(id);
        console.log('[game] Removed mesh for remote player', id);
      }
    }

    // Update dynamic body meshes
    const BALL_COLORS = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xff8800, 0x8800ff];
    const dbGroup = dynamicBodyGroupRef.current;
    if (dbGroup) {
      const activeBodies = new Set<number>();
      for (const [id, body] of state.dynamicBodies) {
        activeBodies.add(id);
        const renderBody = prediction.getRenderedDynamicBodyState(id) ?? body;
        let mesh = dynamicBodyMeshes.current.get(id);
        if (!mesh) {
          let geom: THREE.BufferGeometry;
          let mat: THREE.MeshStandardMaterial;
          if (renderBody.shapeType === 1) {
            const radius = renderBody.halfExtents[0];
            geom = new THREE.SphereGeometry(radius, 16, 12);
            mat = new THREE.MeshStandardMaterial({
              color: BALL_COLORS[id % BALL_COLORS.length],
              roughness: 0.4,
              metalness: 0.1,
            });
          } else {
            geom = new THREE.BoxGeometry(
              renderBody.halfExtents[0] * 2,
              renderBody.halfExtents[1] * 2,
              renderBody.halfExtents[2] * 2,
            );
            mat = new THREE.MeshStandardMaterial({
              color: 0xcc6622,
              roughness: 0.6,
              metalness: 0.2,
            });
          }
          mesh = new THREE.Mesh(geom, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.position.set(renderBody.position[0], renderBody.position[1], renderBody.position[2]);
          mesh.quaternion.set(
            renderBody.quaternion[0],
            renderBody.quaternion[1],
            renderBody.quaternion[2],
            renderBody.quaternion[3],
          );
          dbGroup.add(mesh);
          dynamicBodyMeshes.current.set(id, mesh);
        }
        mesh.position.set(renderBody.position[0], renderBody.position[1], renderBody.position[2]);
        mesh.quaternion.set(
          renderBody.quaternion[0],
          renderBody.quaternion[1],
          renderBody.quaternion[2],
          renderBody.quaternion[3],
        );
      }
      // Remove stale dynamic body meshes
      for (const [id, mesh] of dynamicBodyMeshes.current) {
        if (!activeBodies.has(id)) {
          dbGroup.remove(mesh);
          dynamicBodyMeshes.current.delete(id);
        }
      }
    }

    // --- Vehicle rendering ---
    const vGroup = vehicleGroupRef.current;
    if (vGroup && client) {
      const activeVehicleIds = new Set<number>();
      const localVehiclePos = localVehicleVisualPose;

      // Find nearest unoccupied vehicle for proximity indicator
      let nearest: number | null = null;
      let nearestDist = VEHICLE_INTERACT_RADIUS;

      for (const [id, vs] of client.vehicles) {
        activeVehicleIds.add(id);
        let vehicleMeshGroup = vehicleMeshes.current.get(id);
        if (!vehicleMeshGroup) {
          vehicleMeshGroup = createVehicleMesh(id);
          vGroup.add(vehicleMeshGroup);
          vehicleMeshes.current.set(id, vehicleMeshGroup);
        }

        const isLocalVehicle = isDrivingNow && localVehiclePos !== null && drivenVehicleId === id;

        let vPos: [number, number, number];
        let vQuat: [number, number, number, number];

        if (isLocalVehicle && localVehiclePos) {
          vPos = localVehiclePos.position;
          vQuat = localVehiclePos.quaternion;
        } else {
          const sample = localAuthorityTransport
            ? null
            : client.sampleRemoteVehicle(id, renderTimeUs);
          vPos = sample?.position ?? vs.position;
          vQuat = sample?.quaternion ?? vs.quaternion;
        }

        vehicleMeshGroup.position.set(vPos[0], vPos[1], vPos[2]);
        vehicleMeshGroup.quaternion.set(vQuat[0], vQuat[1], vQuat[2], vQuat[3]);

        updateVehicleWheelVisuals(vehicleMeshGroup, vs, isLocalVehicle ? localVehicleDebug : null, vPos, vQuat, frameDelta);
        updateVehicleSupportDebug(
          vehicleMeshGroup,
          isLocalVehicle ? localVehicleDebug : null,
          vehicleSupportDebugEnabledRef.current,
        );

        // Proximity check (only when not driving)
        if (!isDrivingNow && vs.driverId === 0) {
          const dx = vPos[0] - pos[0];
          const dz = vPos[2] - pos[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = id;
          }
        }
      }
      nearestVehicleIdRef.current = nearest;

      // Remove stale vehicle meshes
      for (const [id, mesh] of vehicleMeshes.current) {
        if (!activeVehicleIds.has(id)) {
          vGroup.remove(mesh);
          vehicleMeshes.current.delete(id);
        }
      }
    }
  });

  return (
    <>
      <color attach="background" args={['#d7e3f0']} />
      <fog attach="fog" args={['#d7e3f0', 80, 220]} />
      <Sky
        distance={450000}
        sunPosition={[120, 28, 40]}
        turbidity={7}
        rayleigh={2.2}
        mieCoefficient={0.008}
        mieDirectionalG={0.86}
      />
      <ambientLight intensity={0.18} color={0xfdf6eb} />
      <hemisphereLight args={[0xc3dcff, 0x7f6543, 1.05]} />
      <directionalLight
        castShadow
        position={[48, 42, 18]}
        intensity={2.4}
        color={0xfff2d6}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={180}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-bias={-0.00015}
        shadow-normalBias={0.03}
      />
      <directionalLight position={[-28, 20, -32]} intensity={0.55} color={0xa8c8ff} />
      <WorldTerrain world={worldDocument} />
      <WorldStaticProps world={worldDocument} />

      {renderBlocks.map((block) => (
        <WorldBlock
          key={block.key}
          position={block.position}
          color={block.color}
        />
      ))}

      <RapierDebugLines runtimeRef={runtimeRef} modeBits={rapierDebugModeBits} />

      {/* Remote player group */}
      <group ref={remoteGroupRef} />

      {/* Dynamic body group */}
      <group ref={dynamicBodyGroupRef} />

      {/* Vehicle group */}
      <group ref={vehicleGroupRef} />

      {/* Local shot trace */}
      <mesh ref={shotTraceBeamRef} visible={false}>
        <cylinderGeometry args={[LOCAL_SHOT_TRACE_BEAM_RADIUS, LOCAL_SHOT_TRACE_BEAM_RADIUS, 1, 10]} />
        <meshBasicMaterial transparent depthWrite={false} opacity={0} />
      </mesh>
      <mesh ref={shotTraceImpactRef} visible={false}>
        <sphereGeometry args={[LOCAL_SHOT_TRACE_IMPACT_RADIUS, 12, 10]} />
        <meshBasicMaterial transparent depthWrite={false} opacity={0} />
      </mesh>

      {/* Crosshair */}
      <CrosshairHUD />

      {sceneExtras}
    </>
  );
}

function WorldBlock({
  position,
  color,
}: {
  position: [number, number, number];
  color: number;
}) {
  return (
    <mesh position={position}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

function rapierDebugModeLabel(modeBits: number): string {
  switch (modeBits) {
    case 0:
      return 'off';
    case 0b11:
      return 'shapes';
    case 0b1111:
      return 'joints';
    case 0b1111111:
      return 'full';
    default:
      return `custom(${modeBits})`;
  }
}

function RapierDebugLines({
  runtimeRef,
  modeBits,
}: {
  runtimeRef: RefObject<GameRuntimeClient | null>;
  modeBits: number;
}) {
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const materialRef = useRef<THREE.LineBasicMaterial | null>(null);

  useEffect(() => {
    return () => {
      const geometry = geometryRef.current;
      const material = materialRef.current;
      if (geometry) {
        geometry.dispose();
      }
      if (material) {
        material.dispose();
      }
    };
  }, []);

  useFrame(() => {
    const runtime = runtimeRef.current;
    const geometry = geometryRef.current;
    if (!geometry || !runtime) return;

    if (modeBits === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const buffers = runtime.getDebugRenderBuffers(modeBits);
    if (!buffers) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const positionArray = buffers.vertices;
    const rgbaArray = buffers.colors;
    const rgbArray = new Float32Array((rgbaArray.length / 4) * 3);
    for (let src = 0, dst = 0; src + 3 < rgbaArray.length; src += 4, dst += 3) {
      rgbArray[dst] = rgbaArray[src];
      rgbArray[dst + 1] = rgbaArray[src + 1];
      rgbArray[dst + 2] = rgbaArray[src + 2];
    }

    const positionAttribute = new THREE.Float32BufferAttribute(positionArray, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);

    const colorAttribute = new THREE.Float32BufferAttribute(rgbArray, 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttribute);

    geometry.setDrawRange(0, positionArray.length / 3);
    geometry.computeBoundingSphere();
  });

  return (
    <lineSegments frustumCulled={false} renderOrder={999}>
      <bufferGeometry ref={geometryRef} />
      <lineBasicMaterial ref={materialRef} vertexColors transparent opacity={1} depthWrite={false} />
    </lineSegments>
  );
}

function CrosshairHUD() {
  return null;
}

function createLocalShotTrace(
  camera: THREE.Camera,
  nowMs: number,
  aimDirection: [number, number, number],
  remoteHits: RemoteShotHit[],
  blockerDistance: number | null,
): LocalShotTrace {
  const aimOrigin: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
  const intercept = pickShotTraceIntercept(blockerDistance, remoteHits, LOCAL_SHOT_TRACE_MAX_DISTANCE);
  const pseudoMuzzleOrigin = camera.position.clone().add(CAMERA_PSEUDO_MUZZLE_OFFSET.clone().applyQuaternion(camera.quaternion));
  const end = [
    aimOrigin[0] + aimDirection[0] * intercept.distance,
    aimOrigin[1] + aimDirection[1] * intercept.distance,
    aimOrigin[2] + aimDirection[2] * intercept.distance,
  ] as [number, number, number];

  return {
    origin: [pseudoMuzzleOrigin.x, pseudoMuzzleOrigin.y, pseudoMuzzleOrigin.z],
    end,
    kind: intercept.kind,
    expiresAtMs: nowMs + LOCAL_SHOT_TRACE_TTL_MS,
  };
}

function updateLocalShotTraceVisuals(
  trace: LocalShotTrace | null,
  nowMs: number,
  beam: THREE.Mesh | null,
  impact: THREE.Mesh | null,
) {
  if (!beam || !impact) return;
  if (!isShotTraceActive(trace, nowMs)) {
    beam.visible = false;
    impact.visible = false;
    return;
  }
  if (!trace) {
    beam.visible = false;
    impact.visible = false;
    return;
  }

  const alpha = Math.max(0, (trace.expiresAtMs - nowMs) / LOCAL_SHOT_TRACE_TTL_MS);
  const color = shotTraceColor(trace.kind);
  const origin = new THREE.Vector3(...trace.origin);
  const end = new THREE.Vector3(...trace.end);
  const delta = new THREE.Vector3().subVectors(end, origin);
  const length = Math.max(delta.length(), 0.001);
  const mid = new THREE.Vector3().addVectors(origin, end).multiplyScalar(0.5);
  const direction = delta.normalize();

  beam.visible = true;
  beam.position.copy(mid);
  beam.scale.set(1, length, 1);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  if (beam.material instanceof THREE.MeshBasicMaterial) {
    beam.material.color.setHex(color);
    beam.material.opacity = alpha * 0.9;
  }

  impact.visible = true;
  impact.position.copy(end);
  impact.scale.setScalar(0.85 + alpha * 0.55);
  if (impact.material instanceof THREE.MeshBasicMaterial) {
    impact.material.color.setHex(color);
    impact.material.opacity = alpha;
  }
}

function createVehicleMesh(_id: number): THREE.Group {
  const group = new THREE.Group();
  const wheelVisualAnchors = getVehicleWheelVisualAnchors();
  const chassisHalfExtents = getVehicleChassisHalfExtents();
  group.userData.renderState = {
    lastBodyPosition: null,
    wheels: Array.from({ length: 4 }, () => ({ spinAngle: 0, steerAngle: 0 })),
  } satisfies VehicleRenderState;

  // Match the Rapier chassis cuboid exactly: 0.9 x 0.3 x 1.8 half-extents.
  const chassisGeom = new THREE.BoxGeometry(
    chassisHalfExtents.x * 2,
    chassisHalfExtents.y * 2,
    chassisHalfExtents.z * 2,
  );
  const chassisMat = new THREE.MeshStandardMaterial({ color: 0x6f7684, roughness: 0.58, metalness: 0.22 });
  const chassis = new THREE.Mesh(chassisGeom, chassisMat);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  group.add(chassis);

  // Keep visual detail inside the collider bounds so the mesh reads honestly.
  const roofGeom = new THREE.BoxGeometry(1.2, 0.18, 1.4);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9ba5b4, roughness: 0.46, metalness: 0.18 });
  const roof = new THREE.Mesh(roofGeom, roofMat);
  roof.position.set(0, 0.14, -0.05);
  roof.castShadow = true;
  group.add(roof);

  const noseGeom = new THREE.BoxGeometry(1.0, 0.12, 0.55);
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x9d643d, roughness: 0.6, metalness: 0.14 });
  const nose = new THREE.Mesh(noseGeom, noseMat);
  nose.position.set(0, 0.04, chassisHalfExtents.z - 0.42);
  nose.castShadow = true;
  group.add(nose);

  // Wheels: FL, FR, RL, RR
  const wheelRadiusM = getVehicleWheelRadiusM();
  const wheelGeom = new THREE.CylinderGeometry(wheelRadiusM, wheelRadiusM, 0.3, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(...wheelVisualAnchors[i]);
    pivot.name = `wheel_pivot_${i}`;
    group.add(pivot);

    const spinGroup = new THREE.Group();
    spinGroup.name = `wheel_spin_${i}`;
    pivot.add(spinGroup);

    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.name = `wheel_${i}`;
    wheel.castShadow = true;
    spinGroup.add(wheel);
  }

  return group;
}

function updateVehicleWheelVisuals(
  vehicleMeshGroup: THREE.Group,
  vehicleState: Pick<NetVehicleState, 'wheelData'> | Pick<VehicleStateMeters, 'wheelData'>,
  localVehicleDebug: {
    speedMs: number;
    groundedWheels: number;
    steering: number;
    engineForce: number;
    brake: number;
  } | null,
  position: [number, number, number],
  quaternion: [number, number, number, number],
  frameDeltaSec: number,
): void {
  const renderState = vehicleMeshGroup.userData.renderState as VehicleRenderState | undefined;
  if (!renderState) return;
  const wheelRadiusM = getVehicleWheelRadiusM();

  const bodySpeed = estimateVehicleForwardSpeed(renderState.lastBodyPosition, position, quaternion, frameDeltaSec);
  renderState.lastBodyPosition = [...position];

  const fallbackSignedSpeed = Math.abs(bodySpeed) > 0.05
    ? bodySpeed
    : (localVehicleDebug
      ? Math.sign(localVehicleDebug.engineForce || 1) * localVehicleDebug.speedMs
      : bodySpeed);

  for (let wi = 0; wi < 4 && wi < vehicleState.wheelData.length; wi++) {
    const pivot = vehicleMeshGroup.getObjectByName(`wheel_pivot_${wi}`) as THREE.Group | undefined;
    const spinGroup = vehicleMeshGroup.getObjectByName(`wheel_spin_${wi}`) as THREE.Group | undefined;
    if (!pivot || !spinGroup) continue;

    const wheelState = renderState.wheels[wi];
    const packed = vehicleState.wheelData[wi];
    const steerByte = (packed & 0xff) as number;
    const replicatedSteer = (steerByte > 127 ? steerByte - 256 : steerByte) / 127;
    const targetSteer = wi < 2
      ? ((localVehicleDebug?.steering ?? replicatedSteer) * 0.5)
      : 0;

    wheelState.steerAngle = THREE.MathUtils.damp(
      wheelState.steerAngle,
      targetSteer,
      VEHICLE_WHEEL_VISUAL_STEER_RATE,
      frameDeltaSec,
    );

    // Wheel spin is integrated locally from chassis motion instead of directly
    // snapping to low-rate replicated wheel angles, which causes visible wobble.
    wheelState.spinAngle += (fallbackSignedSpeed / wheelRadiusM) * frameDeltaSec;
    pivot.rotation.y = wheelState.steerAngle;
    spinGroup.rotation.x = wheelState.spinAngle;
  }
}

function estimateVehicleForwardSpeed(
  lastPosition: [number, number, number] | null,
  position: [number, number, number],
  quaternion: [number, number, number, number],
  frameDeltaSec: number,
): number {
  if (!lastPosition || frameDeltaSec <= 0.0001) return 0;
  const forward = new THREE.Vector3(0, 0, 1);
  forward.applyQuaternion(new THREE.Quaternion(
    quaternion[0],
    quaternion[1],
    quaternion[2],
    quaternion[3],
  ));
  const velocity = new THREE.Vector3(
    (position[0] - lastPosition[0]) / frameDeltaSec,
    (position[1] - lastPosition[1]) / frameDeltaSec,
    (position[2] - lastPosition[2]) / frameDeltaSec,
  );
  return velocity.dot(forward);
}

function createPlayerMesh(id: number): THREE.Group {
  const group = new THREE.Group();
  const color = PLAYER_COLORS[id % PLAYER_COLORS.length];

  // Body capsule
  const bodyGeom = new THREE.CapsuleGeometry(0.35, 0.9, 8, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.name = 'body';
  body.userData.baseColor = new THREE.Color(color);
  body.position.y = 0;
  group.add(body);

  // Head
  const headGeom = new THREE.SphereGeometry(0.22, 12, 8);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffccaa });
  const head = new THREE.Mesh(headGeom, headMat);
  head.name = 'head';
  head.position.y = 0.75;
  group.add(head);

  // Direction indicator
  const noseGeom = new THREE.ConeGeometry(0.1, 0.25, 6);
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
  const nose = new THREE.Mesh(noseGeom, noseMat);
  nose.name = 'nose';
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.75, 0.3);
  group.add(nose);

  // Player ID label
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 128, 48);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`P${id}`, 64, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const labelMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(labelMat);
  sprite.scale.set(1.2, 0.45, 1);
  sprite.position.y = 1.4;
  group.add(sprite);

  return group;
}
