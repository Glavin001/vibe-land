// Dev-only check for the simple WebGPU path: once a second, walk the scene
// and report every material WebGPURenderer cannot draw as authored --
// ShaderMaterials (GLSL) and onBeforeCompile patches (ignored there). The
// list it prints is what is left to port to TSL.

import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import type * as THREE from 'three';

export function CustomMaterialGuard() {
  const scene = useThree((state) => state.scene);
  const nextCheck = useRef(0);
  const reported = useRef(new Set<string>());
  useFrame(() => {
    const now = performance.now();
    if (now < nextCheck.current) return;
    nextCheck.current = now + 1000;
    scene.traverse((object) => {
      const materials = (object as THREE.Mesh).material;
      if (!materials) return;
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        const shader = (material as THREE.ShaderMaterial).isShaderMaterial;
        const patched = material.onBeforeCompile !== Object.getPrototypeOf(material).onBeforeCompile;
        if (!shader && !patched) continue;
        const key = `${object.name || object.type}:${material.type}:${shader ? 'shader' : 'onBeforeCompile'}`;
        if (reported.current.has(key)) continue;
        reported.current.add(key);
        console.warn(`[webgpu] custom material not drawn as authored: ${key}`, object);
      }
    });
  });
  return null;
}
