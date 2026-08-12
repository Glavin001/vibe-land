import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GameRuntimeClient } from '../runtime/gameRuntime';

const STRIDE = 14;

type SheetFallingDebrisProps = {
  runtimeRef: React.RefObject<GameRuntimeClient | null>;
};

/**
 * Practice: syncs poses from LocalSession local-only sheet debris bodies
 * (parent hole is forced open before spawn so pieces can fall out).
 */
export function SheetFallingDebris({ runtimeRef }: SheetFallingDebrisProps) {
  const groupRef = useRef<THREE.Group>(null);
  const meshesRef = useRef<Map<number, THREE.Mesh>>(new Map());

  useEffect(() => {
    return () => {
      const group = groupRef.current;
      for (const mesh of meshesRef.current.values()) {
        group?.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      meshesRef.current.clear();
    };
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    const runtime = runtimeRef.current;
    if (!group || !runtime?.getSheetDebrisStates) return;

    const raw = runtime.getSheetDebrisStates();
    const active = new Set<number>();
    if (raw && raw.length >= STRIDE) {
      for (let i = 0; i + STRIDE <= raw.length; i += STRIDE) {
        const id = raw[i] >>> 0;
        active.add(id);
        const hx = raw[i + 1];
        const hy = raw[i + 2];
        const hz = raw[i + 3];
        let mesh = meshesRef.current.get(id);
        if (!mesh) {
          const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
          const material = new THREE.MeshLambertMaterial({
            color: new THREE.Color(raw[i + 11], raw[i + 12], raw[i + 13]),
            flatShading: true,
          });
          mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
          meshesRef.current.set(id, mesh);
        }
        mesh.position.set(raw[i + 4], raw[i + 5], raw[i + 6]);
        mesh.quaternion.set(raw[i + 7], raw[i + 8], raw[i + 9], raw[i + 10]);
      }
    }
    for (const [id, mesh] of meshesRef.current) {
      if (!active.has(id)) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        meshesRef.current.delete(id);
      }
    }
  });

  return <group ref={groupRef} />;
}
