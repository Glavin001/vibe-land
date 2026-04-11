import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { CrosshairAimState } from './aimTargeting';
import { DemoTerrain } from './DemoTerrain';
import { useGameConnection } from './useGameConnection';
import { usePrediction } from '../physics/usePrediction';
import { buildInputFromButtons } from './inputBuilder';
import {
  aimDirectionFromAngles,
  BLOCK_ADD,
  BLOCK_REMOVE,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
  FLAG_DEAD,
  WEAPON_HITSCAN,
} from '../net/protocol';
import type { InputCmd, NetVehicleState } from '../net/protocol';

const VEHICLE_INTERACT_RADIUS = 4.0;
const LOCAL_RIFLE_INTERVAL_MS = 100;
const REMOTE_HIT_FLASH_MS = 180;
const CROSSHAIR_MAX_DISTANCE = 1000;
const PLAYER_EYE_HEIGHT = 0.8;
const LOCAL_PREVIEW_INPUT_DT = 1 / 60;
const IS_LOCAL_PREVIEW = import.meta.env.MODE === 'local-preview';

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
  onSnapshot?: () => void;
};

const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

export function GameWorld({ onWelcome, onDisconnect, onAimStateChange, onDebugFrame, onSnapshot }: GameWorldProps) {
  const prediction = usePrediction();
  const onDebugFrameRef = useRef(onDebugFrame);
  onDebugFrameRef.current = onDebugFrame;
  const onAimStateChangeRef = useRef(onAimStateChange);
  onAimStateChangeRef.current = onAimStateChange;
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

  const keysRef = useRef(new Set<string>());
  const mouseButtonsRef = useRef(new Set<number>());
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
  const removeBlockLatchRef = useRef(false);
  const placeBlockLatchRef = useRef(false);
  const lastAimStateRef = useRef<CrosshairAimState>('idle');

  // Vehicle refs
  const vehicleGroupRef = useRef<THREE.Group>(null);
  const vehicleMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const knownVehicleIds = useRef<Set<number>>(new Set());
  const nearestVehicleIdRef = useRef<number | null>(null);
  const enterKeyLatchRef = useRef(false); // true when E was pressed and not yet consumed
  const smoothCamPos = useRef(new THREE.Vector3()); // smoothed chase camera position

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.code);
      if (e.code === 'Digit1') selectedMaterialRef.current = 1;
      if (e.code === 'Digit2') selectedMaterialRef.current = 2;
      if (e.code === 'KeyE') enterKeyLatchRef.current = true;
      if (e.code === 'KeyQ') removeBlockLatchRef.current = true;
      if (e.code === 'KeyF') placeBlockLatchRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const onBlur = () => {
      keysRef.current.clear();
      mouseButtonsRef.current.clear();
    };
    const onPointerLockChange = () => {
      if (document.pointerLockElement !== gl.domElement) {
        mouseButtonsRef.current.clear();
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      yawRef.current -= e.movementX * 0.003;
      pitchRef.current = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, pitchRef.current - e.movementY * 0.003),
      );
    };
    const onMouseDown = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      mouseButtonsRef.current.add(e.button);
      if (e.button === 0 || e.button === 2) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      mouseButtonsRef.current.delete(e.button);
    };
    const onContextMenu = (e: MouseEvent) => {
      if (document.pointerLockElement === gl.domElement) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('contextmenu', onContextMenu);
    };
  }, [gl]);

  useEffect(() => () => {
    onAimStateChangeRef.current?.('idle');
  }, []);

  useFrame((_frameState, delta) => {
    if (!ready) return;
    const state = stateRef.current;
    const keys = keysRef.current;

    let buttons = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) buttons |= BTN_FORWARD;
    if (keys.has('KeyS') || keys.has('ArrowDown')) buttons |= BTN_BACK;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) buttons |= BTN_LEFT;
    if (keys.has('KeyD') || keys.has('ArrowRight')) buttons |= BTN_RIGHT;
    if (keys.has('Space')) buttons |= BTN_JUMP;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) buttons |= BTN_SPRINT;

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
    if (enterKeyLatchRef.current) {
      enterKeyLatchRef.current = false;
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
          }
        }
      }
    }

    if (prediction.ready) {
      if (prediction.isInVehicle()) {
        // Vehicle prediction — skip player KCC tick
        prediction.updateVehicle(frameDelta, buttons, yawRef.current, pitchRef.current, sendInputs);
      } else {
        if (IS_LOCAL_PREVIEW) {
          localPreviewInputAccumulatorRef.current += frameDelta;
          const cmds: InputCmd[] = [];
          let steps = 0;
          while (localPreviewInputAccumulatorRef.current >= LOCAL_PREVIEW_INPUT_DT && steps < 4) {
            const seq = localPreviewNextSeqRef.current++ & 0xffff;
            cmds.push(buildInputFromButtons(seq, 0, buttons, yawRef.current, pitchRef.current));
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
          prediction.update(frameDelta, buttons, yawRef.current, pitchRef.current, sendInputs);
        }
      }
    }

    if (!isDrivingNow && !localDead && document.pointerLockElement === gl.domElement) {
      if (mouseButtonsRef.current.has(0) && client && now >= nextLocalFireMsRef.current) {
        nextLocalFireMsRef.current = now + LOCAL_RIFLE_INTERVAL_MS;
        sendFire({
          seq: prediction.getNextSeq(),
          shotId: nextShotIdRef.current++ >>> 0,
          weapon: WEAPON_HITSCAN,
          clientFireTimeUs: client.serverClock.serverNowUs(),
          clientInterpMs: Math.round(state.interpolationDelayMs),
          dir: aimDirectionFromAngles(yawRef.current, pitchRef.current),
        });
      }

      if (!IS_LOCAL_PREVIEW && (removeBlockLatchRef.current || placeBlockLatchRef.current)) {
        const removeRequested = removeBlockLatchRef.current;
        const placeRequested = placeBlockLatchRef.current;
        removeBlockLatchRef.current = false;
        placeBlockLatchRef.current = false;

        const direction = aimDirectionFromAngles(yawRef.current, pitchRef.current);
        const hit = prediction.raycastBlocks(
          [camera.position.x, camera.position.y, camera.position.z],
          direction,
          6,
        );
        if (hit) {
          if (removeRequested && prediction.getBlockMaterial(hit.removeCell) !== 0) {
            const cmd = prediction.buildBlockEdit(hit.removeCell, BLOCK_REMOVE, 0);
            if (cmd) {
              prediction.applyOptimisticEdit(cmd);
              sendBlockEdit(cmd);
            }
          } else if (placeRequested && prediction.getBlockMaterial(hit.placeCell) === 0) {
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
      // Chase camera: yaw-only (no roll/pitch) + position smoothing to absorb
      // suspension bounce and prediction micro-corrections.
      const chassisPos = vehiclePoseForCamera.position;
      const fullQuat = new THREE.Quaternion(
        vehiclePoseForCamera.quaternion[0],
        vehiclePoseForCamera.quaternion[1],
        vehiclePoseForCamera.quaternion[2],
        vehiclePoseForCamera.quaternion[3],
      );
      // Extract only yaw
      const euler = new THREE.Euler().setFromQuaternion(fullQuat, 'YXZ');
      const yawQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0));
      const offset = new THREE.Vector3(0, 2.5, -6);
      offset.applyQuaternion(yawQuat);

      const targetX = chassisPos[0] + offset.x;
      const targetY = chassisPos[1] + offset.y;
      const targetZ = chassisPos[2] + offset.z;

      // Smooth at ~20 Hz effective rate — filters chassis bounce without lag
      const smoothRate = Math.min(frameDelta * 20.0, 1.0);
      smoothCamPos.current.set(
        smoothCamPos.current.x + (targetX - smoothCamPos.current.x) * smoothRate,
        smoothCamPos.current.y + (targetY - smoothCamPos.current.y) * smoothRate,
        smoothCamPos.current.z + (targetZ - smoothCamPos.current.z) * smoothRate,
      );
      camera.position.copy(smoothCamPos.current);
      camera.lookAt(chassisPos[0], chassisPos[1] + 1.0, chassisPos[2]);
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

    if (!IS_LOCAL_PREVIEW && !isDrivingNow && !localDead && document.pointerLockElement === gl.domElement) {
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
