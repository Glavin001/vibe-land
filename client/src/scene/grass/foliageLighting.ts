import { Color, DoubleSide, Vector3 } from 'three';
import { skyGradient, sunDirection, sunIntensityFor } from '../../graphics/sunSky';

// Both LODs must participate in scene.environment and use the same leaf response.
export const FOLIAGE_SURFACE = { roughness: 0.88, metalness: 0, side: DoubleSide } as const;
export function foliageLightUniforms() {
  const sun = sunDirection();
  return {
    grassSun: { value: new Vector3(sun.x, sun.y, sun.z) },
    grassSunColor: { value: new Color(skyGradient('#c3d2e2').sunColor).multiplyScalar(sunIntensityFor()) },
  };
}

/** Shared shadow-aware thin-leaf transmission and root occlusion. */
export function foliageLightFragment(color: string, world: string, height: string, dryness: string): string {
  return /* glsl */ `
    vec3 grassView = normalize(cameraPosition - ${world});
    float transmission = pow(max(dot(-grassView, grassSun), 0.0), 3.0);
    if (transmission > 0.005) {
      outgoingLight += ${color} * grassSunColor * transmission * mix(0.42, 0.12, ${dryness})
        * smoothstep(0.05, 0.85, ${height}) * getShadowMask();
    }
    outgoingLight *= mix(0.72, 1.0, smoothstep(0.0, 0.65, ${height}));
  `;
}
