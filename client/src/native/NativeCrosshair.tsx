// The crosshair, drawn in the scene: the web client's is DOM, which the
// native app does not have. A small cross a fixed distance in front of the
// camera, on top of everything.

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

import { nativeHud } from './nativeHud';

const DISTANCE = 0.5;
const ARM = 0.008;
const THICKNESS = 0.0012;

export function NativeCrosshair() {
  const group = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    const node = group.current;
    if (!node) return;
    node.visible = nativeHud.visible;
    node.position.copy(camera.position);
    node.quaternion.copy(camera.quaternion);
    node.translateZ(-DISTANCE);
  });
  return (
    <group ref={group} renderOrder={1000}>
      {[[ARM * 2, THICKNESS], [THICKNESS, ARM * 2]].map(([w, h], i) => (
        <mesh key={i} renderOrder={1000} frustumCulled={false}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.9} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
