import { EffectComposer, LUT } from '@react-three/postprocessing';
import { useLoader, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { LUTCubeLoader } from 'three-stdlib';
import { sanitizeSceneForCompatibility } from './renderer/compatibilityMaterialSanitizer';

const DEFAULT_LUT_URL = '/assets/postfx/Bourbon 64.CUBE';

export function PostFX() {
  const lut = useLoader(LUTCubeLoader, DEFAULT_LUT_URL);
  return (
    <EffectComposer multisampling={0}>
      <LUT lut={lut.texture3D} tetrahedralInterpolation />
    </EffectComposer>
  );
}

export function SceneSanitizer() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    sanitizeSceneForCompatibility(scene);
  }, [scene]);
  return null;
}
