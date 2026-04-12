import { useRef, useEffect, useMemo } from 'react';
import { Sky } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameMode } from '../app/gameMode';
import { isPracticeMode } from '../app/gameMode';
import type { CrosshairAimState } from './aimTargeting';
import type { RemotePlayer } from './useGameConnection';
import { useGameConnection } from './useGameConnection';
import { usePredictionWithWorld } from '../physics/usePrediction';
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
  BLOCK_ADD,
  BLOCK_REMOVE,
  FLAG_DEAD,
  FLAG_IN_VEHICLE,
  HIT_ZONE_BODY,
  HIT_ZONE_HEAD,
  WEAPON_HITSCAN,
} from '../net/protocol';
import type { NetVehicleState, VehicleStateMeters } from '../net/protocol';
import { WorldTerrain } from './WorldTerrain';
import { WorldStaticProps } from './WorldStaticProps';
import { DEFAULT_WORLD_DOCUMENT, serializeWorldDocument, type WorldDocument } from '../world/worldDocument';

const VEHICLE_INTERACT_RADIUS = 4.0;
const LOCAL_RIFLE_INTERVAL_MS = 100;
const REMOTE_HIT_FLASH_MS = 180;
const CROSSHAIR_MAX_DISTANCE = 1000;
const PLAYER_EYE_HEIGHT = 0.8;
const LOCAL_SHOT_TRACE_TTL_MS = 90;
const LOCAL_SHOT_TRACE_MAX_DISTANCE = 80;
const LOCAL_SHOT_TRACE_BEAM_RADIUS = 0.015;
const LOCAL_SHOT_TRACE_IMPACT_RADIUS = 0.07;
const CAMERA_PSEUDO_MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.12, -0.35);
const VEHICLE_WHEEL_RADIUS_M = 0.35;
const VEHICLE_WHEEL_VISUAL_STEER_RATE = 18.0;
const LOCAL_VEHICLE_RENDER_PLANAR_RATE = 40.0;
const LOCAL_VEHICLE_RENDER_VERTICAL_RATE = 12.0;
const LOCAL_VEHICLE_RENDER_YAW_RATE = 24.0;
const LOCAL_VEHICLE_RENDER_TILT_RATE = 10.0;

type FrameDebugCallback = (
  frameTimeMs: number,
  rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
  network: { pingMs: number; serverTick: number; interpolationDelayMs: number; clockOffsetUs: number; remotePlayers: number; transport: string; playerId: number },
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
  },
  position: [number, number, number],
  player: { velocity: [number, number, number]; hp: number; localFlags: number },
) => void;

type GameWorldProps = {
  mode: GameMode;
  worldDocument?: WorldDocument;
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onAimStateChange?: (state: CrosshairAimState) => void;
  onDebugFrame?: FrameDebugCallback;
  onInputFrame?: (sample: InputSample) => void;
  inputFamilyMode?: InputFamilyMode;
  onSnapshot?: () => void;
  rapierDebugModeBits?: number;
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

type LocalVehicleVisualPoseState = {
  vehicleId: number | null;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  euler: THREE.Euler;
};

export function GameWorld({
  mode,
  worldDocument = DEFAULT_WORLD_DOCUMENT,
  onWelcome,
  onDisconnect,
  onAimStateChange,
  onDebugFrame,
  onInputFrame,
  inputFamilyMode = 'auto',
  onSnapshot,
  rapierDebugModeBits = 0,
}: GameWorldProps) {
  const practiceMode = isPracticeMode(mode);
  const worldJson = useMemo(() => serializeWorldDocument(worldDocument), [worldDocument]);
  const prediction = usePredictionWithWorld(mode, worldJson);
  const onDebugFrameRef = useRef(onDebugFrame);
  onDebugFrameRef.current = onDebugFrame;
  const onAimStateChangeRef = useRef(onAimStateChange);
  onAimStateChangeRef.current = onAimStateChange;
  const onInputFrameRef = useRef(onInputFrame);
  onInputFrameRef.current = onInputFrame;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const { stateRef, ready, sendInputs, sendFire, sendBlockEdit, sendVehicleEnter, sendVehicleExit, clientRef } = useGameConnection(
    mode,
    onWelcome,
    onDisconnect,
    practiceMode ? worldJson : undefined,
    prediction.ready
      ? (ackInputSeq, state) => {
          // Sync dynamic bodies BEFORE reconciliation so that input replay
          // collides with the correct (same-tick) collider positions.
          const bodies = Array.from(stateRef.current.dynamicBodies.values());
          prediction.updateDynamicBodies(bodies);
          // Skip player KCC reconcile while driving — player position on server
          // is the chassis position, which would cause a spurious large correction
          // offset on the idle player collider.
          if (!prediction.isInVehicle()) {
            prediction.reconcile(ackInputSeq, state);
          }
        }
      : undefined,
    (packet) => {
      if (packet.type === 'chunkFull' || packet.type === 'chunkDiff') {
        prediction.applyWorldPacket(packet);
      }
      if (packet.type === 'snapshot') {
        onSnapshotRef.current?.();
      }
    },
    prediction.ready ? (vs: NetVehicleState, ackInputSeq: number) => {
      prediction.reconcileVehicle(vs, ackInputSeq);
    } : undefined,
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

  // Vehicle refs
  const vehicleGroupRef = useRef<THREE.Group>(null);
  const vehicleMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const knownVehicleIds = useRef<Set<number>>(new Set());
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

  useFrame((_frameState, delta) => {
    if (!ready) return;
    const state = stateRef.current;

    const now = performance.now();
    const frameDelta = Math.min((now - lastFrameTime.current) / 1000, 0.1);
    lastFrameTime.current = now;
    const client = clientRef.current;
    const localPreviewTransport = client?.transport === 'local-preview';
    const localFlags = client?.localPlayerFlags ?? 0;
    const localDead = (localFlags & FLAG_DEAD) !== 0;
    const localPreviewVehicleEntry = practiceMode && client
      ? [...client.vehicles.entries()].find(([, vs]) => vs.driverId === client.playerId) ?? null
      : null;
    const predictedVehiclePose = prediction.isInVehicle() ? prediction.getVehiclePose() : null;
    const drivenVehicleId = prediction.getDrivenVehicleId();
    const drivenVehicleState = drivenVehicleId != null ? client?.vehicles.get(drivenVehicleId) ?? null : null;
    const localVehicleDebug = drivenVehicleId != null ? prediction.getLocalVehicleDebug(drivenVehicleId) : null;
    const localControlledVehiclePose = predictedVehiclePose
      ?? (localPreviewVehicleEntry
        ? {
            position: localPreviewVehicleEntry[1].position,
            quaternion: localPreviewVehicleEntry[1].quaternion,
          }
        : null);
    let localVehicleVisualPose = localControlledVehiclePose;
    if (localControlledVehiclePose && drivenVehicleId != null) {
      const visualPose = localVehicleVisualPoseRef.current;
      const targetPosition = localControlledVehiclePose.position;
      const targetQuaternion = localControlledVehiclePose.quaternion;
      const targetQuat = new THREE.Quaternion(
        targetQuaternion[0],
        targetQuaternion[1],
        targetQuaternion[2],
        targetQuaternion[3],
      );
      const targetEuler = new THREE.Euler().setFromQuaternion(targetQuat, 'YXZ');
      const speedMs = localVehicleDebug?.speedMs ?? 0;
      const planarRate = LOCAL_VEHICLE_RENDER_PLANAR_RATE;
      const verticalRate = LOCAL_VEHICLE_RENDER_VERTICAL_RATE + Math.min(speedMs * 0.25, 8.0);
      const yawRate = LOCAL_VEHICLE_RENDER_YAW_RATE + Math.min(speedMs * 0.2, 10.0);
      const tiltRate = LOCAL_VEHICLE_RENDER_TILT_RATE + Math.min(speedMs * 0.12, 5.0);
      if (visualPose.vehicleId !== drivenVehicleId) {
        visualPose.vehicleId = drivenVehicleId;
        visualPose.position.set(targetPosition[0], targetPosition[1], targetPosition[2]);
        visualPose.quaternion.copy(targetQuat);
        visualPose.euler.copy(targetEuler);
      } else {
        visualPose.position.x = THREE.MathUtils.damp(visualPose.position.x, targetPosition[0], planarRate, frameDelta);
        visualPose.position.y = THREE.MathUtils.damp(visualPose.position.y, targetPosition[1], verticalRate, frameDelta);
        visualPose.position.z = THREE.MathUtils.damp(visualPose.position.z, targetPosition[2], planarRate, frameDelta);
        visualPose.euler.x = dampAngle(visualPose.euler.x, targetEuler.x, tiltRate, frameDelta);
        visualPose.euler.y = dampAngle(visualPose.euler.y, targetEuler.y, yawRate, frameDelta);
        visualPose.euler.z = dampAngle(visualPose.euler.z, targetEuler.z, tiltRate, frameDelta);
        visualPose.quaternion.setFromEuler(visualPose.euler);
      }
      localVehicleVisualPose = {
        position: [visualPose.position.x, visualPose.position.y, visualPose.position.z],
        quaternion: [visualPose.quaternion.x, visualPose.quaternion.y, visualPose.quaternion.z, visualPose.quaternion.w],
      };
    } else {
      localVehicleVisualPoseRef.current.vehicleId = null;
    }
    const isDrivingNow = localControlledVehiclePose !== null;
    const pointerLocked = document.pointerLockElement === gl.domElement;
    const inputSample = inputManagerRef.current?.sample(frameDelta, pointerLocked, isDrivingNow ? 'vehicle' : 'onFoot', inputFamilyMode)
      ?? { activeFamily: null, action: null, context: isDrivingNow ? 'vehicle' : 'onFoot' as const };
    onInputFrameRef.current?.(inputSample);
    prediction.advanceDynamicBodies(frameDelta, !prediction.isInVehicle());

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

    const resolvedInput = isDrivingNow
      ? resolveVehicleInput(inputSample.action, yawRef.current, pitchRef.current, inputSample.activeFamily)
      : resolveOnFootInput(inputSample.action, yawRef.current, pitchRef.current, inputSample.activeFamily);

    // --- Vehicle spawn/despawn sync ---
    if (client && prediction.ready) {
      const serverVehicles = client.vehicles;
      // Spawn newly seen vehicles into WASM
      for (const [id, vs] of serverVehicles) {
        if (!knownVehicleIds.current.has(id)) {
          knownVehicleIds.current.add(id);
          prediction.spawnVehicle(
            id, vs.vehicleType ?? 0,
            vs.position[0], vs.position[1], vs.position[2],
            vs.quaternion[0], vs.quaternion[1], vs.quaternion[2], vs.quaternion[3],
          );
        }
      }
      // Remove despawned vehicles from WASM
      for (const id of knownVehicleIds.current) {
        if (!serverVehicles.has(id)) {
          knownVehicleIds.current.delete(id);
          prediction.removeVehicle(id);
        }
      }

      const remoteVehicleRenderTimeUs = state.serverClock.renderTimeUs(state.interpolationDelayMs * 1000);
      let syncedRemoteVehicles = false;
      for (const [id, vs] of serverVehicles) {
        if (prediction.isInVehicle() && prediction.getDrivenVehicleId() === id) {
          continue;
        }
        const sample = localPreviewTransport
          ? null
          : client.sampleRemoteVehicle(id, remoteVehicleRenderTimeUs);
        const position = sample?.position ?? vs.position;
        const quaternion = sample?.quaternion ?? vs.quaternion;
        const linearVelocity = sample?.linearVelocity ?? vs.linearVelocity;
        prediction.syncRemoteVehicle(
          id,
          position[0], position[1], position[2],
          quaternion[0], quaternion[1], quaternion[2], quaternion[3],
          linearVelocity[0], linearVelocity[1], linearVelocity[2],
        );
        syncedRemoteVehicles = true;
      }
      if (syncedRemoteVehicles) {
        prediction.syncBroadPhase();
      }
    }

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
              sendVehicleExit(id);
              break;
            }
          }
        }
      } else if (nearestVehicleIdRef.current !== null) {
        const vehicleId = nearestVehicleIdRef.current;
        const vs = client?.vehicles.get(vehicleId);
        if (vs && vs.driverId === 0 && (practiceMode || prediction.ready)) {
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
          sendVehicleEnter(vehicleId, 0);
          // Snap smooth camera to initial vehicle position to avoid lerp-in from player pos
          smoothCamPos.current.set(vs.position[0], vs.position[1] + 2.5, vs.position[2] - 6);
          smoothVehicleFocus.current.set(vs.position[0], vs.position[1] + 1.0, vs.position[2]);
          vehicleCameraYawOffsetRef.current = 0;
          vehicleCameraPitchRef.current = VEHICLE_CAMERA_DEFAULT_PITCH;
          lastVehicleLookAtMsRef.current = now;
        }
      }
    }

    if (prediction.ready) {
      if (prediction.isInVehicle()) {
        // Vehicle prediction — skip player KCC tick
        prediction.updateVehicle(frameDelta, resolvedInput, sendInputs);
      } else {
        // Prediction owns seq counting, input building, and sending — all in lockstep.
        // In practice mode this keeps local motion immediate instead of waiting on
        // the local authoritative snapshots to move the camera.
        prediction.update(frameDelta, resolvedInput, sendInputs);
      }
    }

    const canUseAimActions = !isDrivingNow && !localDead
      && (pointerLocked
        || inputSample.activeFamily === 'gamepad'
        || inputSample.activeFamily === 'touch');

    if (canUseAimActions) {
      if (resolvedInput.firePrimary && client && now >= nextLocalFireMsRef.current) {
        nextLocalFireMsRef.current = now + LOCAL_RIFLE_INTERVAL_MS;
        const fireDir = aimDirectionFromAngles(yawRef.current, pitchRef.current);
        const sceneHit = prediction.raycastScene(
          [camera.position.x, camera.position.y, camera.position.z],
          fireDir,
          CROSSHAIR_MAX_DISTANCE,
        );
        if (lastAimStateRef.current === 'idle') {
          prediction.predictDynamicBodyShot(
            [camera.position.x, camera.position.y, camera.position.z],
            fireDir,
            CROSSHAIR_MAX_DISTANCE,
            sceneHit?.toi ?? null,
          );
        }
        localShotTraceRef.current = createLocalShotTrace(
          camera,
          now,
          fireDir,
          state.remotePlayers,
          state.remoteInterpolator,
          state.serverClock.renderTimeUs(state.interpolationDelayMs * 1000),
          prediction,
        );
        sendFire({
          seq: prediction.getNextSeq(),
          shotId: nextShotIdRef.current++ >>> 0,
          weapon: WEAPON_HITSCAN,
          clientFireTimeUs: client.serverClock.serverNowUs(),
          clientInterpMs: Math.round(state.interpolationDelayMs),
          dir: fireDir,
        });
      }

      if (!practiceMode && (resolvedInput.blockRemovePressed || resolvedInput.blockPlacePressed)) {
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
              sendBlockEdit(cmd);
            }
          } else if (resolvedInput.blockPlacePressed && prediction.getBlockMaterial(hit.placeCell) === 0) {
            const cmd = prediction.buildBlockEdit(hit.placeCell, BLOCK_ADD, selectedMaterialRef.current);
            if (cmd) {
              prediction.applyOptimisticEdit(cmd);
              sendBlockEdit(cmd);
            }
          }
        }
      }
    }

    // Camera follows interpolated predicted position (falls back to server-authoritative)
    const isDriving = isDrivingNow;
    const vehiclePoseForCamera = localVehicleVisualPose;
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
      const eyeHeight = PLAYER_EYE_HEIGHT;
      camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
      const lookX = pos[0] + Math.sin(yaw) * Math.cos(pitch);
      const lookY = pos[1] + eyeHeight + Math.sin(pitch);
      const lookZ = pos[2] + Math.cos(yaw) * Math.cos(pitch);
      camera.lookAt(lookX, lookY, lookZ);
    }

    // Debug logging
    logTimer.current++;
    if (logTimer.current % 120 === 0) {
      console.log('[game] local pos:', pos, 'remotePlayers:', state.remotePlayers.size, 'tick:', state.latestServerTick);
    }

    // Report per-frame debug stats to server (aggregated to 1 Hz)
    const physStats = prediction.getDebugStats();
    client?.accumulateDebugStats(physStats.playerCorrectionMagnitude, physStats.physicsStepMs);

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
        ? Math.hypot(
            localControlledVehiclePose.position[0] - drivenVehicleState.position[0],
            localControlledVehiclePose.position[1] - drivenVehicleState.position[1],
            localControlledVehiclePose.position[2] - drivenVehicleState.position[2],
          )
        : 0;
      onDebugFrameRef.current(
        frameDelta * 1000,
        gl.info,
        {
          pingMs: client?.rttMs ?? 0,
          serverTick: state.latestServerTick,
          interpolationDelayMs: state.interpolationDelayMs,
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

    if (!practiceMode && canUseAimActions) {
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
      const dynamicRenderTimeUs = client?.getRenderTimeUs() ?? 0;
      for (const [id, body] of state.dynamicBodies) {
        activeBodies.add(id);
        const proxyBody = prediction.getDynamicBodyRenderState(id);
        const remoteSample = localPreviewTransport
          ? null
          : client?.sampleRemoteDynamicBody(id, dynamicRenderTimeUs);
        const useProxyBody = prediction.hasRecentDynamicBodyInteraction(id);
        const renderBody = useProxyBody && proxyBody
          ? proxyBody
          : (remoteSample
            ? {
                id,
                shapeType: remoteSample.shapeType,
                position: remoteSample.position,
                quaternion: remoteSample.quaternion,
                halfExtents: remoteSample.halfExtents,
                velocity: remoteSample.velocity,
                angularVelocity: remoteSample.angularVelocity,
              }
            : body);
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
          const sample = localPreviewTransport
            ? null
            : client.sampleRemoteVehicle(id, renderTimeUs);
          vPos = sample?.position ?? vs.position;
          vQuat = sample?.quaternion ?? vs.quaternion;
        }

        vehicleMeshGroup.position.set(vPos[0], vPos[1], vPos[2]);
        vehicleMeshGroup.quaternion.set(vQuat[0], vQuat[1], vQuat[2], vQuat[3]);

        updateVehicleWheelVisuals(vehicleMeshGroup, vs, isLocalVehicle ? localVehicleDebug : null, vPos, vQuat, frameDelta);

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

      {prediction.renderBlocks.map((block) => (
        <WorldBlock
          key={block.key}
          position={block.position}
          color={block.color}
        />
      ))}

      <RapierDebugLines prediction={prediction} modeBits={rapierDebugModeBits} />

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
  prediction,
  modeBits,
}: {
  prediction: ReturnType<typeof usePredictionWithWorld>;
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
    const geometry = geometryRef.current;
    if (!geometry) return;

    if (modeBits === 0) {
      geometry.setDrawRange(0, 0);
      return;
    }

    const buffers = prediction.getDebugRenderBuffers(modeBits);
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
  remotePlayers: Map<number, RemotePlayer>,
  remoteInterpolator: ReturnType<typeof useGameConnection>['stateRef']['current']['remoteInterpolator'],
  renderTimeUs: number,
  prediction: ReturnType<typeof usePredictionWithWorld>,
): LocalShotTrace {
  const aimOrigin: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
  const sceneHit = prediction.raycastScene(aimOrigin, aimDirection, LOCAL_SHOT_TRACE_MAX_DISTANCE);
  const blockerDistance = sceneHit?.toi ?? null;
  const remoteHits: RemoteShotHit[] = [];

  for (const [id, rp] of remotePlayers) {
    const sample = remoteInterpolator.sample(id, renderTimeUs);
    const position = sample?.position ?? rp.position;
    const hit = prediction.classifyHitscanPlayer(aimOrigin, aimDirection, position, blockerDistance);
    if (!hit) continue;
    remoteHits.push({
      distance: hit.distance,
      kind: hit.kind === HIT_ZONE_HEAD ? 'head' : 'body',
    });
  }

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
  group.userData.renderState = {
    lastBodyPosition: null,
    wheels: Array.from({ length: 4 }, () => ({ spinAngle: 0, steerAngle: 0 })),
  } satisfies VehicleRenderState;

  // Chassis body
  const chassisGeom = new THREE.BoxGeometry(1.8, 0.5, 3.6);
  const chassisMat = new THREE.MeshStandardMaterial({ color: 0x888899, roughness: 0.5, metalness: 0.3 });
  const chassis = new THREE.Mesh(chassisGeom, chassisMat);
  chassis.castShadow = true;
  chassis.receiveShadow = true;
  group.add(chassis);

  // Cabin
  const cabinGeom = new THREE.BoxGeometry(1.6, 0.6, 2.0);
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x666677, roughness: 0.5, metalness: 0.2 });
  const cabin = new THREE.Mesh(cabinGeom, cabinMat);
  cabin.position.set(0, 0.55, 0);
  cabin.castShadow = true;
  group.add(cabin);

  // Wheels: FL, FR, RL, RR
  const wheelGeom = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  const wheelPositions: [number, number, number][] = [
    [0.9, -0.15, 1.1],
    [-0.9, -0.15, 1.1],
    [0.9, -0.15, -1.1],
    [-0.9, -0.15, -1.1],
  ];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(...wheelPositions[i]);
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
    wheelState.spinAngle += (fallbackSignedSpeed / VEHICLE_WHEEL_RADIUS_M) * frameDeltaSec;
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

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  const alpha = 1 - Math.exp(-lambda * dt);
  return current + delta * alpha;
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
