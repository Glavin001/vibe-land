import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import {
  VIBE_JAM_PORTAL_URL,
  buildPortalRedirectUrl,
  buildReturnPortalUrl,
  readPortalParams,
} from './portalParams';

const PORTAL_TRIGGER_RADIUS_M = 1.6;
const PORTAL_REARM_RADIUS_M = 2.6;

function getCurrentSelfRef(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.host || null;
}

export function Portals({
  runtimeRef,
}: {
  runtimeRef: RefObject<GameRuntimeClient | null>;
}) {
  const params = useMemo(() => readPortalParams(window.location.search), []);
  const selfRef = useMemo(() => getCurrentSelfRef(), []);
  const startActive = params.isFromPortal && params.ref !== null;

  const exitGroupRef = useRef<THREE.Group>(null);
  const startGroupRef = useRef<THREE.Group>(null);
  const exitRingRef = useRef<THREE.Mesh>(null);
  const startRingRef = useRef<THREE.Mesh>(null);
  const triggeredRef = useRef(false);
  const startInitializedRef = useRef(false);
  const exitArmedRef = useRef(false);
  const startArmedRef = useRef(false);

  const tmpVec = useRef(new THREE.Vector3());
  const exitPos = useMemo(() => new THREE.Vector3(8, 1.8, 0), []);
  const startPosRef = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    // Idle spin even before player is ready.
    if (exitRingRef.current) exitRingRef.current.rotation.z += dt * 0.6;
    if (startRingRef.current) startRingRef.current.rotation.z -= dt * 0.6;

    if (triggeredRef.current) return;
    const client = runtimeRef.current;
    if (!client) return;
    const pos = client.getPosition();
    if (!pos) return;
    const player = tmpVec.current.set(pos[0], pos[1], pos[2]);

    // Initialize start portal at the player's first valid position so they
    // appear to spawn out of it. Stays invisible until placed.
    if (startActive && !startInitializedRef.current) {
      startPosRef.current.set(pos[0], pos[1] + 0.4, pos[2]);
      const group = startGroupRef.current;
      if (group) {
        group.position.copy(startPosRef.current);
        group.visible = true;
      }
      startInitializedRef.current = true;
    }

    const dExit = player.distanceTo(exitPos);
    if (!exitArmedRef.current && dExit > PORTAL_REARM_RADIUS_M) {
      exitArmedRef.current = true;
    }
    if (exitArmedRef.current && dExit < PORTAL_TRIGGER_RADIUS_M) {
      triggeredRef.current = true;
      const url = buildPortalRedirectUrl(VIBE_JAM_PORTAL_URL, params.forwarded, selfRef);
      window.location.href = url;
      return;
    }

    if (startActive && startInitializedRef.current && params.ref) {
      const dStart = player.distanceTo(startPosRef.current);
      if (!startArmedRef.current && dStart > PORTAL_REARM_RADIUS_M) {
        startArmedRef.current = true;
      }
      if (startArmedRef.current && dStart < PORTAL_TRIGGER_RADIUS_M) {
        triggeredRef.current = true;
        const url = buildReturnPortalUrl(params.ref, params.forwarded, selfRef);
        window.location.href = url;
      }
    }
  });

  return (
    <>
      <PortalVisual
        groupRef={exitGroupRef}
        ringRef={exitRingRef}
        position={exitPos}
        color="#ff4488"
        emissive="#ff77aa"
        label="Vibe Jam Portal"
      />
      <group
        ref={startGroupRef}
        visible={false}
      >
        {startActive && (
          <PortalVisualBody
            ringRef={startRingRef}
            color="#44ddff"
            emissive="#88eeff"
            label={`Return: ${params.ref ?? ''}`}
          />
        )}
      </group>
    </>
  );
}

type PortalVisualProps = {
  groupRef: RefObject<THREE.Group>;
  ringRef: RefObject<THREE.Mesh>;
  position: THREE.Vector3;
  color: string;
  emissive: string;
  label: string;
};

function PortalVisual({ groupRef, ringRef, position, color, emissive, label }: PortalVisualProps) {
  return (
    <group ref={groupRef} position={position}>
      <PortalVisualBody ringRef={ringRef} color={color} emissive={emissive} label={label} />
    </group>
  );
}

type PortalVisualBodyProps = {
  ringRef: RefObject<THREE.Mesh>;
  color: string;
  emissive: string;
  label: string;
};

function PortalVisualBody({ ringRef, color, emissive, label }: PortalVisualBodyProps) {
  return (
    <>
      <mesh ref={ringRef}>
        <torusGeometry args={[1.4, 0.18, 16, 64]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={1.4}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
      <mesh>
        <circleGeometry args={[1.28, 48]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.55}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight color={emissive} intensity={6} distance={12} decay={1.4} />
      <Html
        position={[0, 1.95, 0]}
        center
        distanceFactor={9}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.7)',
            color: '#fff',
            padding: '4px 10px',
            fontFamily: 'system-ui, sans-serif',
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 4,
            whiteSpace: 'nowrap',
            letterSpacing: 0.4,
          }}
        >
          {label}
        </div>
      </Html>
    </>
  );
}
