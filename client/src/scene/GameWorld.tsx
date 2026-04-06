import { useRef, useEffect, useMemo } from 'react';
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
  const remotePlayersRef = useRef<Map<number, THREE.Group>>(new Map());
  const sceneGroupRef = useRef<THREE.Group>(null);

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

  const groundGeom = useMemo(() => new THREE.PlaneGeometry(200, 200), []);
  const groundMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x333333 }), []);

  useFrame((_rootState, delta) => {
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

    // Camera follows local player position from server
    const pos = state.localPosition;
    const eyeHeight = 1.6;
    const yaw = yawRef.current;
    const pitch = pitchRef.current;

    camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
    const lookX = pos[0] + Math.sin(yaw) * Math.cos(pitch);
    const lookY = pos[1] + eyeHeight + Math.sin(pitch);
    const lookZ = pos[2] + Math.cos(yaw) * Math.cos(pitch);
    camera.lookAt(lookX, lookY, lookZ);

    // Update remote player meshes
    const group = sceneGroupRef.current;
    if (!group) return;

    const currentRemote = new Map<number, RemotePlayer>(state.remotePlayers);

    // Remove stale meshes
    for (const [id, mesh] of remotePlayersRef.current) {
      if (!currentRemote.has(id)) {
        group.remove(mesh);
        remotePlayersRef.current.delete(id);
      }
    }

    // Add/update remote players
    for (const [id, rp] of currentRemote) {
      let playerGroup = remotePlayersRef.current.get(id);
      if (!playerGroup) {
        playerGroup = createPlayerMesh(id);
        group.add(playerGroup);
        remotePlayersRef.current.set(id, playerGroup);
      }
      playerGroup.position.set(rp.position[0], rp.position[1], rp.position[2]);
      playerGroup.rotation.y = rp.yaw;
    }
  });

  return (
    <group ref={sceneGroupRef}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[20, 30, 10]} intensity={1} castShadow />
      <hemisphereLight args={[0x8888ff, 0x444422, 0.4]} />

      {/* Ground plane */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.5, 0]} receiveShadow geometry={groundGeom} material={groundMat} />

      {/* Some block pillars matching server demo world */}
      <VoxelFloor />
      <Pillar x={2.5} z={2.5} height={3} />
      <Pillar x={3.5} z={2.5} height={2} />

      {/* Crosshair */}
      <Crosshair />
    </group>
  );
}

function VoxelFloor() {
  const geom = useMemo(() => new THREE.BoxGeometry(16, 1, 16), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x556655 }), []);
  return <mesh geometry={geom} material={mat} position={[0, 0, 0]} receiveShadow />;
}

function Pillar({ x, z, height }: { x: number; z: number; height: number }) {
  const geom = useMemo(() => new THREE.BoxGeometry(1, height, 1), [height]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x887766 }), []);
  return <mesh geometry={geom} material={mat} position={[x, 0.5 + height / 2, z]} castShadow />;
}

function Crosshair() {
  return null; // HUD crosshair is CSS-based below
}

function createPlayerMesh(id: number): THREE.Group {
  const group = new THREE.Group();
  const color = PLAYER_COLORS[id % PLAYER_COLORS.length];

  // Body capsule
  const bodyGeom = new THREE.CapsuleGeometry(0.35, 0.9, 8, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0;
  group.add(body);

  // Head sphere
  const headGeom = new THREE.SphereGeometry(0.2, 12, 8);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffccaa });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.y = 0.7;
  group.add(head);

  // Direction indicator (nose)
  const noseGeom = new THREE.ConeGeometry(0.08, 0.2, 6);
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
  const nose = new THREE.Mesh(noseGeom, noseMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.7, 0.25);
  group.add(nose);

  // Player ID label
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.font = '20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`P${id}`, 64, 24);
  const texture = new THREE.CanvasTexture(canvas);
  const labelMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(labelMat);
  sprite.scale.set(1.0, 0.25, 1);
  sprite.position.y = 1.2;
  group.add(sprite);

  return group;
}
