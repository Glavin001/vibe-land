import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameConnection } from './useGameConnection';
import { usePrediction } from '../physics/usePrediction';
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
} from '../net/protocol';

type FrameDebugCallback = (
  frameTimeMs: number,
  rendererInfo: { render: { calls: number; triangles: number }; memory: { geometries: number; textures: number } },
  network: { pingMs: number; serverTick: number; interpolationDelayMs: number; clockOffsetUs: number; remotePlayers: number },
  physics: { pendingInputs: number; predictionTicks: number; correctionMagnitude: number; physicsStepMs: number },
  position: [number, number, number],
) => void;

type GameWorldProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
  onDebugFrame?: FrameDebugCallback;
  onSnapshot?: () => void;
};

const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

export function GameWorld({ onWelcome, onDisconnect, onDebugFrame, onSnapshot }: GameWorldProps) {
  const prediction = usePrediction();
  const onDebugFrameRef = useRef(onDebugFrame);
  onDebugFrameRef.current = onDebugFrame;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const { stateRef, ready, sendInputs, sendBlockEdit, clientRef } = useGameConnection(
    onWelcome,
    onDisconnect,
    prediction.ready
      ? (ackInputSeq, state) => {
          // Sync dynamic bodies BEFORE reconciliation so that input replay
          // collides with the correct (same-tick) collider positions.
          const bodies = Array.from(stateRef.current.dynamicBodies.values());
          prediction.updateDynamicBodies(bodies);
          prediction.reconcile(ackInputSeq, state);
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
  );
  const { camera, gl } = useThree();

  const keysRef = useRef(new Set<string>());
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const remoteGroupRef = useRef<THREE.Group>(null);
  const remoteMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const dynamicBodyGroupRef = useRef<THREE.Group>(null);
  const dynamicBodyMeshes = useRef<Map<number, THREE.Mesh>>(new Map());
  const logTimer = useRef(0);
  const lastFrameTime = useRef(performance.now());
  const selectedMaterialRef = useRef(2);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.code);
      if (e.code === 'Digit1') selectedMaterialRef.current = 1;
      if (e.code === 'Digit2') selectedMaterialRef.current = 2;
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
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
      if (e.button !== 0 && e.button !== 2) return;

      const direction = aimDirectionFromAngles(yawRef.current, pitchRef.current);
      const hit = prediction.raycastBlocks(
        [camera.position.x, camera.position.y, camera.position.z],
        direction,
        6,
      );
      if (!hit) return;

      if (e.button === 0) {
        if (prediction.getBlockMaterial(hit.removeCell) === 0) return;
        const cmd = prediction.buildBlockEdit(hit.removeCell, BLOCK_REMOVE, 0);
        if (cmd) {
          sendBlockEdit(cmd);
        }
        e.preventDefault();
        return;
      }

      if (prediction.getBlockMaterial(hit.placeCell) !== 0) return;
      const cmd = prediction.buildBlockEdit(hit.placeCell, BLOCK_ADD, selectedMaterialRef.current);
      if (cmd) {
        sendBlockEdit(cmd);
      }
      e.preventDefault();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (document.pointerLockElement === gl.domElement) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('contextmenu', onContextMenu);
    };
  }, [camera, gl, prediction, sendBlockEdit]);

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

    if (prediction.ready) {
      // Prediction owns seq counting, input building, and sending — all in lockstep
      prediction.update(frameDelta, buttons, yawRef.current, pitchRef.current, sendInputs);
    }

    // Camera follows interpolated predicted position (falls back to server-authoritative)
    const predictedPos = prediction.getPosition();
    const pos = predictedPos ?? state.localPosition;
    const eyeHeight = 1.6;
    const yaw = yawRef.current;
    const pitch = pitchRef.current;

    camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
    const lookX = pos[0] + Math.sin(yaw) * Math.cos(pitch);
    const lookY = pos[1] + eyeHeight + Math.sin(pitch);
    const lookZ = pos[2] + Math.cos(yaw) * Math.cos(pitch);
    camera.lookAt(lookX, lookY, lookZ);

    // Debug logging
    logTimer.current++;
    if (logTimer.current % 120 === 0) {
      console.log('[game] local pos:', pos, 'remotePlayers:', state.remotePlayers.size, 'tick:', state.latestServerTick);
    }

    // Debug overlay stats
    if (onDebugFrameRef.current) {
      const client = clientRef.current;
      const physStats = prediction.getDebugStats();
      onDebugFrameRef.current(
        frameDelta * 1000,
        gl.info,
        {
          pingMs: client?.rttMs ?? 0,
          serverTick: state.latestServerTick,
          interpolationDelayMs: state.interpolationDelayMs,
          clockOffsetUs: state.serverClock.getOffsetUs(),
          remotePlayers: state.remotePlayers.size,
        },
        physStats,
        pos as [number, number, number],
      );
    }

    // Update remote player meshes
    const group = remoteGroupRef.current;
    if (!group) return;

    const currentRemote = state.remotePlayers;
    const activeIds = new Set<number>();
    const renderTimeUs = state.serverClock.renderTimeUs(state.interpolationDelayMs * 1000);

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
      playerGroup.position.set(position[0], position[1], position[2]);
      playerGroup.rotation.y = yaw;
    }

    // Remove stale
    for (const [id, mesh] of remoteMeshes.current) {
      if (!activeIds.has(id)) {
        group.remove(mesh);
        remoteMeshes.current.delete(id);
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
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 10]} intensity={1} />
      <hemisphereLight args={[0x8888ff, 0x444422, 0.4]} />

      {prediction.renderBlocks.map((block) => (
        <WorldBlock
          key={block.key}
          position={block.position}
          color={block.color}
        />
      ))}

      {/* Grid lines for spatial reference */}
      <gridHelper args={[48, 48, 0x444444, 0x333333]} position={[0, 0.51, 0]} />

      {/* Remote player group */}
      <group ref={remoteGroupRef} />

      {/* Dynamic body group */}
      <group ref={dynamicBodyGroupRef} />

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

function createPlayerMesh(id: number): THREE.Group {
  const group = new THREE.Group();
  const color = PLAYER_COLORS[id % PLAYER_COLORS.length];

  // Body capsule
  const bodyGeom = new THREE.CapsuleGeometry(0.35, 0.9, 8, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
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
