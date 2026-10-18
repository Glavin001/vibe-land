// The dust sprites on the WebGPU path, in TSL: DustSprites.tsx's camera-facing
// quads, value-noise discs eroding as they age, a fake sphere normal lit by
// the sun, the sky/ground ambient, the exp2 fog -- from the same uniforms
// holder the GLSL material reads.
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Discard,
  Fn,
  If,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  positionGeometry,
  select,
  sin,
  smoothstep,
  sqrt,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { liveUniform } from '../graphics/webgpu/liveUniform';
import type { DustSpriteUniforms } from './DustSprites';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const hash = (p: Node): Node => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
function vnoise(p: Node): Node {
  const i = floor(p);
  const f0 = fract(p);
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)));
  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x),
    f.y,
  );
}
const fbm = (p: Node): Node =>
  vnoise(p).mul(0.5).add(vnoise(p.mul(2.1).add(3.7)).mul(0.3)).add(vnoise(p.mul(4.3).add(9.1)).mul(0.2));

export function dustSpriteNodeMaterial(u: DustSpriteUniforms): THREE.Material {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  material.fog = false; // the sprites fog themselves, as the GLSL does
  material.name = 'Dust sprites (TSL)';
  const right = liveUniform(u.uRight, 'vec3');
  const up = liveUniform(u.uUp, 'vec3');
  const sunDirView = liveUniform(u.uSunDirView, 'vec3');
  const sunColor = liveUniform(u.uSunColor, 'color');
  const skyColor = liveUniform(u.uSkyColor, 'color');
  const groundColor = liveUniform(u.uGroundColor, 'color');
  const albedo = (u.uAlbedo.value as THREE.Color[]).map((colour) => liveUniform({ value: colour }, 'color'));
  const fogColor = liveUniform(u.uFogColor, 'color');
  const fogDensity = liveUniform(u.uFogDensity, 'float');

  const vUv = varyingProperty('vec2', 'vDustUv');
  const vParams = varyingProperty('vec4', 'vDustParams'); // density, seed, fade, erosion
  const vTint = varyingProperty('float', 'vDustTint');
  const vViewDepth = varyingProperty('float', 'vDustViewDepth');
  const center: Node = attribute('aCenter', 'vec3');
  const size: Node = attribute('aSize', 'vec2');
  const params: Node = attribute('aParams', 'vec4');
  const tint: Node = attribute('aTint', 'float');
  const position: Node = positionGeometry;

  material.positionNode = Fn(() => {
    const world = center.add(right.mul(position.x.mul(size.x))).add(up.mul(position.y.mul(size.y)));
    vUv.assign(position.xy.mul(2));
    vParams.assign(params);
    vTint.assign(tint);
    vViewDepth.assign(modelViewMatrix.mul(vec4(world, 1)).z.negate());
    return world;
  })();

  const shaded = (Fn(() => {
    const r = length(vUv);
    If(r.greaterThan(1), () => {
      Discard();
    });
    // Small offsets only: a sin-based hash falls apart at large coordinates.
    const np = vUv.mul(2.5).add(fract(vParams.y.div(251)).mul(vec2(7.3, 11.1)));
    const n = fbm(np);
    const disc = float(1).sub(smoothstep(0.25, 1, r));
    const dens = max(float(0), disc.mul(n.mul(1.6).sub(0.3)).sub(vParams.w.mul(n)));
    If(dens.lessThan(0.003), () => {
      Discard();
    });
    const alpha = clamp(float(1).sub(exp(dens.mul(vParams.x).mul(0.9).negate())), 0, 1).mul(vParams.z);
    const normal = normalize(vec3(vUv, sqrt(max(float(0), float(1).sub(r.mul(r))))));
    const lit = max(float(0), dot(normal, sunDirView));
    const shade = n.mul(0.6).add(0.4);
    const tintIndex = floor(vTint.add(0.5));
    const base = select(tintIndex.equal(1), albedo[1], select(tintIndex.equal(2), albedo[2], albedo[0]));
    const ambient = mix(groundColor, skyColor, vUv.y.mul(0.5).add(0.5));
    // Dust scatters light every way: the sphere shading only tips it.
    const colour = base.mul(sunColor.mul(lit.mul(0.45).add(0.35)).mul(shade).add(ambient.mul(shade.mul(0.5).add(0.5))));
    const fog = float(1).sub(exp(fogDensity.mul(fogDensity).mul(vViewDepth).mul(vViewDepth).negate()));
    return vec4(mix(colour, fogColor, fog), alpha);
  }) as Node)();
  material.colorNode = shaded.rgb;
  material.opacityNode = shaded.a;
  return material;
}
