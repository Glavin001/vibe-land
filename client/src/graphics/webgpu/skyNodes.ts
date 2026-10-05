// The sky dome on the WebGPU path, in TSL: the same sky as the GLSL dome in
// graphics/SkyEnvironment.tsx (its SKY_SHAPE, its live SkyInputs), for
// WebGPURenderer. Registered by @render-backend/install.
//
// The view ray is the camera-to-surface vector, as in the GLSL dome, so the
// sky is a function of direction alone wherever the dome sits.

import * as THREE from 'three';
import { cameraPosition, clamp, dot, float, max, mix, normalize, positionWorld, pow, uniform } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { SKY_SHAPE, type SkyInputs } from '../SkyEnvironment';

// TSL nodes are loosely typed in @types/three 0.170.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GLSL's smoothstep, including edge0 > edge1 (WGSL leaves that undefined). */
function smoothstepAny(edge0: number, edge1: number, x: any): any {
  const t = clamp(x.sub(edge0).div(edge1 - edge0), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}

export function skyNodeMaterial(inputs: SkyInputs, { sunDisc, linear }: { sunDisc: number; linear: boolean }): THREE.Material {
  const sunDir = uniform(inputs.sunDir);
  const zenith = uniform(inputs.zenith);
  const horizon = uniform(inputs.horizon);
  const ground = uniform(inputs.ground);
  const sunColor = uniform(inputs.sunColor);

  const d = normalize((positionWorld as any).sub(cameraPosition));
  const up = clamp(d.y, 0, 1);
  const sky = mix(horizon, zenith, pow(up, SKY_SHAPE.horizonPow));
  const withGround = mix(sky, ground, smoothstepAny(0, SKY_SHAPE.groundFadeY, d.y));
  const s = max(dot(d, sunDir), 0);
  const disc = (sunColor as any).mul(pow(s, SKY_SHAPE.discPow)).mul(SKY_SHAPE.discGain * sunDisc);
  const glow = (sunColor as any).mul(pow(s, SKY_SHAPE.glowPow)).mul(SKY_SHAPE.glowGain);

  const material = new MeshBasicNodeMaterial();
  (material as any).colorNode = (withGround as any).add(disc).add(glow);
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  material.toneMapped = !linear;
  return material;
}
