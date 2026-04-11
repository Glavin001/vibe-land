import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { CrosshairAimState } from './aimTargeting';
import { DemoTerrain } from './DemoTerrain';
import type { RemotePlayer } from './useGameConnection';
import { useGameConnection } from './useGameConnection';
import { usePrediction } from '../physics/usePrediction';
import { buildInputFromState } from './inputBuilder';
import { GameInputManager } from '../input/manager';
import {
  advanceLookAngles,
  advanceVehicleCamera,
  resolveOnFootInput,
  resolveVehicleInput,
  VEHICLE_CAMERA_DEFAULT_PITCH,
} from '../input/resolver';
import type { InputSample } from '../input/types';
import { isShotTraceActive, pickShotTraceIntercept, shotTraceColor, type LocalShotTrace, type RemoteShotHit } from './shotTrace';
import {
  aimDirectionFromAngles,
  BLOCK_ADD,
  BLOCK_REMOVE,
  FLAG_DEAD,
  HIT_ZONE_BODY,
  HIT_ZONE_HEAD,
  WEAPON_HITSCAN,
} from '../net/protocol';
import type { InputCmd, NetVehicleState } from '../net/protocol';

const VEHICLE_INTERACT_RADIUS = 4.0;
const LOCAL_RIFLE_INTERVAL_MS = 100;
const REMOTE_HIT_FLASH_MS = 180;
const CROSSHAIR_MAX_DISTANCE = 1000;
const PLAYER_EYE_HEIGHT = 0.8;
const LOCAL_PREVIEW_INPUT_DT = 1 / 60;
const LOCAL_SHOT_TRACE_TTL_MS = 90;
const LOCAL_SHOT_TRACE_MAX_DISTANCE = 80;
const LOCAL_SHOT_TRACE_BEAM_RADIUS = 0.015;
const LOCAL_SHOT_TRACE_IMPACT_RADIUS = 0.07;
const IS_LOCAL_PREVIEW = import.meta.env.MODE === 'local-preview';
const CAMERA_PSEUDO_MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.12, -0.35);

type FrameDebugCallback = (
  frameTimeMs: number,
  rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
  network: { pingMs: number; serverTick: number; interpolationDelayMs: number; clockOffsetUs: number; remotePlayers: number; transport: string; playerId: number },
  physics: { pendingInputs: number; predictionTicks: number; correctionMagnitude: number; physicsStepMs: number; velocity: [number, number, number] },
  position: [number, number, number],
  player: { velocity: [number, number, number]; hp: number; localFlags: number },
) => void;

type GameWorldProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onAimStateChange?: (state: CrosshairAimState) => void;
  onDebugFrame?: FrameDebugCallback;
  onInputFrame?: (sample: InputSample) => void;
  onSnapshot?: () => void;
};

const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

export function GameWorld({ onWelcome, onDisconnect, onAimStateChange, onDebugFrame, onInputFrame, onSnapshot }: GameWorldProps) {
  const prediction = usePrediction();
  const onDebugFrameRef = useRef(onDebugFrame);
  onDebugFrameRef.current = onDebugFrame;
  const onAimStateChangeRef = useRef(onAimStateChange);
  onAimStateChangeRef.current = onAimStateChange;
  const onInputFrameRef = useRef(onInputFrame);
  onInputFrameRef.current = onInputFrame;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const { stateRef, ready, sendInputs, sendFire, sendBlockEdit, sendVehicleEnter, sendVehicleExit, clientRef } = useGameConnection(
    onWelcome,
    onDisconnect,
    !IS_LOCAL_PREVIEW && prediction.ready
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
    !IS_LOCAL_PREVIEW && prediction.ready ? (vs: NetVehicleState, ackInputSeq: number) => {
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
  const localPreviewInputAccumulatorRef = useRef(0);
  const localPreviewNextSeqRef = useRef(1);
  const lastAimStateRef = useRef<CrosshairAimState>('idle');
  const localShotTraceRef = useRef<LocalShotTrace | null>(null);

  // Vehicle refs
  const vehicleGroupRef = useRef<THREE.Group>(null);
  const vehicleMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const knownVehicleIds = useRef<Set<number>>(new Set());
  const nearestVehicleIdRef = useRef<number | null>(null);
  const smoothCamPos = useRef(new THREE.Vector3()); // smoothed chase camera position
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
    const localFlags = client?.localPlayerFlags ?? 0;
    const localDead = (localFlags & FLAG_DEAD) !== 0;
    const localPreviewVehicleEntry = IS_LOCAL_PREVIEW && client
      ? [...client.vehicles.entries()].find(([, vs]) => vs.driverId === client.playerId) ?? null
      : null;
    const predictedVehiclePose = prediction.isInVehicle() ? prediction.getVehiclePose() : null;
    const localControlledVehiclePose = predictedVehiclePose
      ?? (localPreviewVehicleEntry
        ? {
            position: localPreviewVehicleEntry[1].position,
            quaternion: localPreviewVehicleEntry[1].quaternion,
          }
        : null);
    const isDrivingNow = localControlledVehiclePose !== null;
    const pointerLocked = document.pointerLockElement === gl.domElement;
    const inputSample = inputManagerRef.current?.sample(frameDelta, pointerLocked, isDrivingNow ? 'vehicle' : 'onFoot')
      ?? { activeFamily: null, action: null, context: isDrivingNow ? 'vehicle' : 'onFoot' as const };
    onInputFrameRef.current?.(inputSample);

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
    if (!IS_LOCAL_PREVIEW && client && prediction.ready) {
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
    }

    // --- Enter/Exit vehicle on E press ---
    if (resolvedInput.interactPressed) {
      if (isDrivingNow) {
        // Exit current vehicle
        if (!IS_LOCAL_PREVIEW) {
          const vehiclePose = prediction.getVehiclePose();
          prediction.exitVehicle();
          void vehiclePose; // suppress unused warning
        }
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
        if (vs && vs.driverId === 0 && (IS_LOCAL_PREVIEW || prediction.ready)) {
          if (IS_LOCAL_PREVIEW) {
            sendVehicleEnter(vehicleId, 0);
          } else {
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
            vehicleCameraYawOffsetRef.current = 0;
            vehicleCameraPitchRef.current = VEHICLE_CAMERA_DEFAULT_PITCH;
            lastVehicleLookAtMsRef.current = now;
          }
        }
      }
    }

    if (prediction.ready) {
      if (prediction.isInVehicle()) {
        // Vehicle prediction — skip player KCC tick
        prediction.updateVehicle(frameDelta, resolvedInput, sendInputs);
      } else {
        if (IS_LOCAL_PREVIEW) {
          localPreviewInputAccumulatorRef.current += frameDelta;
          const cmds: InputCmd[] = [];
          let steps = 0;
          while (localPreviewInputAccumulatorRef.current >= LOCAL_PREVIEW_INPUT_DT && steps < 4) {
            const seq = localPreviewNextSeqRef.current++ & 0xffff;
            cmds.push(buildInputFromState(seq, 0, resolvedInput));
            localPreviewInputAccumulatorRef.current -= LOCAL_PREVIEW_INPUT_DT;
            steps++;
          }
          if (localPreviewInputAccumulatorRef.current > LOCAL_PREVIEW_INPUT_DT) {
            localPreviewInputAccumulatorRef.current = LOCAL_PREVIEW_INPUT_DT;
          }
          if (cmds.length > 0) {
            sendInputs(cmds);
          }
        } else {
          // Prediction owns seq counting, input building, and sending — all in lockstep
          prediction.update(frameDelta, resolvedInput, sendInputs);
        }
      }
    }

    const canUseAimActions = !isDrivingNow && !localDead && (pointerLocked || inputSample.activeFamily === 'gamepad');

    if (canUseAimActions) {
      if (resolvedInput.firePrimary && client && now >= nextLocalFireMsRef.current) {
        nextLocalFireMsRef.current = now + LOCAL_RIFLE_INTERVAL_MS;
        localShotTraceRef.current = createLocalShotTrace(
          camera,
          now,
          aimDirectionFromAngles(yawRef.current, pitchRef.current),
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
          dir: aimDirectionFromAngles(yawRef.current, pitchRef.current),
        });
      }

      if (!IS_LOCAL_PREVIEW && (resolvedInput.blockRemovePressed || resolvedInput.blockPlacePressed)) {
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
    const vehiclePoseForCamera = localControlledVehiclePose;
    const predictedPos = IS_LOCAL_PREVIEW ? null : prediction.getPosition();
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
      const targetX = chassisPos[0] - Math.sin(orbitYaw) * Math.cos(orbitPitch) * followDistance;
      const targetY = focusY + Math.sin(orbitPitch) * followDistance + 1.0;
      const targetZ = chassisPos[2] - Math.cos(orbitYaw) * Math.cos(orbitPitch) * followDistance;

      const smoothRate = Math.min(frameDelta * 20.0, 1.0);
      smoothCamPos.current.set(
        smoothCamPos.current.x + (targetX - smoothCamPos.current.x) * smoothRate,
        smoothCamPos.current.y + (targetY - smoothCamPos.current.y) * smoothRate,
        smoothCamPos.current.z + (targetZ - smoothCamPos.current.z) * smoothRate,
      );
      camera.position.copy(smoothCamPos.current);
      camera.lookAt(chassisPos[0], focusY, chassisPos[2]);
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
    client?.accumulateDebugStats(physStats.correctionMagnitude, physStats.physicsStepMs);

    updateLocalShotTraceVisuals(
      localShotTraceRef.current,
      now,
      shotTraceBeamRef.current,
      shotTraceImpactRef.current,
    );

    // Debug overlay stats
    if (onDebugFrameRef.current) {
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
        physStats,
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

    if (!IS_LOCAL_PREVIEW && canUseAimActions) {
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
      const position = sample?.position ?? rp.position;
      const yaw = sample?.yaw ?? rp.yaw;
      const hp = sample?.hp ?? rp.hp;
      const replicatedHp = rp.hp;
      const previousHp = remoteLastHpRef.current.get(id);
      if (previousHp != null && replicatedHp < previousHp) {
        remoteHitFlashUntilRef.current.set(id, now + REMOTE_HIT_FLASH_MS);
      }
      remoteLastHpRef.current.set(id, replicatedHp);
      const isDead = ((sample?.flags ?? (rp.hp <= 0 ? FLAG_DEAD : 0)) & FLAG_DEAD) !== 0;
      playerGroup.position.set(position[0], position[1], position[2]);
      playerGroup.rotation.y = yaw;
      const body = playerGroup.getObjectByName('body') as THREE.Mesh | undefined;
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
        let mesh = dynamicBodyMeshes.current.get(id);
        if (!mesh) {
          let geom: THREE.BufferGeometry;
          let mat: THREE.MeshStandardMaterial;
          if (body.shapeType === 1) {
            const radius = body.halfExtents[0];
            geom = new THREE.SphereGeometry(radius, 16, 12);
            mat = new THREE.MeshStandardMaterial({
              color: BALL_COLORS[id % BALL_COLORS.length],
              roughness: 0.4,
              metalness: 0.1,
            });
          } else {
            geom = new THREE.BoxGeometry(
              body.halfExtents[0] * 2,
              body.halfExtents[1] * 2,
              body.halfExtents[2] * 2,
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
          dbGroup.add(mesh);
          dynamicBodyMeshes.current.set(id, mesh);
        }
        // Smoothly interpolate toward server position (like Rocket League / The Finals)
        const lerpRate = 1.0 - Math.pow(0.001, delta);
        mesh.position.lerp(
          new THREE.Vector3(body.position[0], body.position[1], body.position[2]),
          lerpRate,
        );
        const targetQuat = new THREE.Quaternion(
          body.quaternion[0], body.quaternion[1], body.quaternion[2], body.quaternion[3],
        );
        mesh.quaternion.slerp(targetQuat, lerpRate);
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
      const localVehiclePos = localControlledVehiclePose;

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

        const isLocalVehicle = isDrivingNow && localVehiclePos !== null && client.vehicles.get(id)?.driverId === client.playerId;

        let vPos: [number, number, number];
        let vQuat: [number, number, number, number];

        if (isLocalVehicle && localVehiclePos) {
          vPos = localVehiclePos.position;
          vQuat = localVehiclePos.quaternion;
        } else {
          const sample = client.sampleRemoteVehicle(id, renderTimeUs);
          vPos = sample?.position ?? vs.position;
          vQuat = sample?.quaternion ?? vs.quaternion;
        }

        vehicleMeshGroup.position.set(vPos[0], vPos[1], vPos[2]);
        vehicleMeshGroup.quaternion.set(vQuat[0], vQuat[1], vQuat[2], vQuat[3]);

        // Update wheel visuals from wheelData
        const wheelData = vs.wheelData;
        for (let wi = 0; wi < 4 && wi < wheelData.length; wi++) {
          const wheel = vehicleMeshGroup.getObjectByName(`wheel_${wi}`) as THREE.Mesh | undefined;
          if (wheel) {
            const spinAngle = ((wheelData[wi] >> 8) & 0xff) / 255 * Math.PI * 2;
            const steerByte = (wheelData[wi] & 0xff) as number;
            const steer = ((steerByte > 127 ? steerByte - 256 : steerByte) / 127);
            wheel.rotation.x = spinAngle;
            if (wi < 2) wheel.rotation.y = steer * 0.5; // front wheels steer
          }
        }

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
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 10]} intensity={1} />
      <hemisphereLight args={[0x8888ff, 0x444422, 0.4]} />
      {!IS_LOCAL_PREVIEW && <DemoTerrain />}

      {prediction.renderBlocks.map((block) => (
        <WorldBlock
          key={block.key}
          position={block.position}
          color={block.color}
        />
      ))}

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
  prediction: ReturnType<typeof usePrediction>,
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
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(...wheelPositions[i]);
    wheel.name = `wheel_${i}`;
    wheel.castShadow = true;
    group.add(wheel);
  }

  return group;
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
  head.position.y = 0.75;
  group.add(head);

  // Direction indicator
  const noseGeom = new THREE.ConeGeometry(0.1, 0.25, 6);
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
  const nose = new THREE.Mesh(noseGeom, noseMat);
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
