import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameConnection, type RemotePlayer } from './useGameConnection';
import { buildInputFromButtons } from './inputBuilder';
import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
} from '../net/protocol';

type GameWorldProps = {
  onWelcome: (id: number) => void;
  onDisconnect: () => void;
};

const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

export function GameWorld({ onWelcome, onDisconnect }: GameWorldProps) {
  const { stateRef, ready, sendInput } = useGameConnection(onWelcome, onDisconnect);
  const { camera, gl } = useThree();

  const keysRef = useRef(new Set<string>());
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const seqRef = useRef(1);
  const remoteGroupRef = useRef<THREE.Group>(null);
  const remoteMeshes = useRef<Map<number, THREE.Group>>(new Map());
  const logTimer = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keysRef.current.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      yawRef.current -= e.movementX * 0.003;
      pitchRef.current = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, pitchRef.current - e.movementY * 0.003),
      );
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
    };
  }, [gl]);

  useFrame(() => {
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

    const seq = (seqRef.current++ & 0xffff);
    const clientTick = Math.floor(performance.now() / (1000 / 60));
    const input = buildInputFromButtons(seq, clientTick, buttons, yawRef.current, pitchRef.current);
    sendInput(input);

    // Camera follows server-authoritative local position
    const pos = state.localPosition;
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

    // Update remote player meshes
    const group = remoteGroupRef.current;
    if (!group) return;

    const currentRemote = state.remotePlayers;
    const activeIds = new Set<number>();

    for (const [id, rp] of currentRemote) {
      activeIds.add(id);
      let playerGroup = remoteMeshes.current.get(id);
      if (!playerGroup) {
        playerGroup = createPlayerMesh(id);
        group.add(playerGroup);
        remoteMeshes.current.set(id, playerGroup);
        console.log('[game] Created mesh for remote player', id);
      }
      playerGroup.position.set(rp.position[0], rp.position[1], rp.position[2]);
      playerGroup.rotation.y = rp.yaw;
    }

    // Remove stale
    for (const [id, mesh] of remoteMeshes.current) {
      if (!activeIds.has(id)) {
        group.remove(mesh);
        remoteMeshes.current.delete(id);
        console.log('[game] Removed mesh for remote player', id);
      }
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 30, 10]} intensity={1} />
      <hemisphereLight args={[0x8888ff, 0x444422, 0.4]} />

      {/* Ground floor - 16x16 block area matching server demo world */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.5, 0]}>
        <planeGeometry args={[16, 16]} />
        <meshStandardMaterial color={0x556655} />
      </mesh>

      {/* Pillar blocks */}
      <BoxBlock x={2.5} y={1.5} z={2.5} h={1} color={0x887766} />
      <BoxBlock x={2.5} y={2.5} z={2.5} h={1} color={0x887766} />
      <BoxBlock x={2.5} y={3.5} z={2.5} h={1} color={0x887766} />
      <BoxBlock x={3.5} y={1.5} z={2.5} h={1} color={0x887766} />
      <BoxBlock x={3.5} y={2.5} z={2.5} h={1} color={0x887766} />

      {/* Grid lines for spatial reference */}
      <gridHelper args={[32, 32, 0x444444, 0x333333]} position={[0, 0.51, 0]} />

      {/* Remote player group */}
      <group ref={remoteGroupRef} />

      {/* Crosshair */}
      <CrosshairHUD />
    </>
  );
}

function BoxBlock({ x, y, z, h, color }: { x: number; y: number; z: number; h: number; color: number }) {
  return (
    <mesh position={[x, y, z]}>
      <boxGeometry args={[1, h, 1]} />
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
