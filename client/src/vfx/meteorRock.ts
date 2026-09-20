// The meteor as an object: a cratered basalt rock with glowing fissures, and
// the embers that stream off it.
//
// Ported from the Meteor Lab studio (`meteor-effect.js`), unminified and split
// from its fire: the fire is a screen-space pass and lives in
// MeteorFireStage; this file is what sits in the scene. The rock is built once
// at unit scale and scaled per meteor, so eight meteors share one 20k-triangle
// geometry and differ only by the seed the fissure shader is given.
//
// Art-directed, not simulated: the colours are tuned, not a blackbody.

import * as THREE from 'three';

/** Shared with the fire pass, so the flames and the fissures agree on grain. */
export const NOISE_GLSL = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float n = 0.53 * noise3(p);
  p = p * 2.03 + vec3(7.1, 3.7, 1.9); n += 0.27 * noise3(p);
  p = p * 2.07 + vec3(5.7, 1.3, 9.1); n += 0.13 * noise3(p);
  n += 0.07 * noise3(p * 2.11);
  return n;
}
`;

function hash(x: number, y: number, z: number): number {
  const p = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return p - Math.floor(p);
}

function noise(x: number, y: number, z: number): number {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  let a = x - X;
  let b = y - Y;
  let c = z - Z;
  a = a * a * (3 - 2 * a);
  b = b * b * (3 - 2 * b);
  c = c * c * (3 - 2 * c);
  const mix = (p: number, q: number, t: number) => p + (q - p) * t;
  return mix(
    mix(mix(hash(X, Y, Z), hash(X + 1, Y, Z), a), mix(hash(X, Y + 1, Z), hash(X + 1, Y + 1, Z), a), b),
    mix(mix(hash(X, Y, Z + 1), hash(X + 1, Y, Z + 1), a), mix(hash(X, Y + 1, Z + 1), hash(X + 1, Y + 1, Z + 1), a), b),
    c,
  );
}

function fractal(x: number, y: number, z: number): number {
  return 0.55 * noise(x, y, z)
    + 0.27 * noise(x * 2.1 + 7, y * 2.1, z * 2.1)
    + 0.12 * noise(x * 4.3, y * 4.3 + 9, z * 4.3)
    + 0.06 * noise(x * 8.7, y * 8.7, z * 8.7 + 3);
}

/** The rock's local-space envelope; the fire pass hollows itself out to it. */
export const ROCK_SCALE: readonly [number, number, number] = [1, 0.91, 0.86];

/**
 * A unit-ish rock: an icosphere displaced by multi-scale noise with a dozen
 * impact pits. `detail` is the icosphere subdivision; 24 is 5,760 triangles,
 * which at the sizes a meteor is seen from is indistinguishable from the
 * studio's 48.
 */
export function buildMeteorGeometry(seed = 42, detail = 24): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const pos = geometry.attributes.position;
  const craters = Array.from({ length: 13 }, (_, i) => ({
    v: new THREE.Vector3(hash(seed, i, 1) - 0.5, hash(seed, i, 2) - 0.5, hash(seed, i, 3) - 0.5).normalize(),
    size: 0.11 + hash(seed, i, 4) * 0.21,
    depth: 0.085 + hash(seed, i, 5) * 0.12,
  }));
  const s = seed * 0.137;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = fractal(x * 2.9 + s, y * 2.9 + s, z * 2.9 + s);
    const detailN = fractal(x * 14 + s, y * 14 + s, z * 14 + s);
    let r = 0.75 + n * 0.62 + (detailN - 0.5) * 0.09;
    for (const c of craters) {
      const d = Math.sqrt((x - c.v.x) ** 2 + (y - c.v.y) ** 2 + (z - c.v.z) ** 2);
      const b = d / c.size;
      r -= Math.exp(-b * b * 3) * c.depth;
      r += Math.exp(-(((b - 1) * 7) ** 2)) * 0.015;
    }
    r += 0.035 * Math.sin(x * 11 + seed) * Math.sin(y * 9 + z * 4);
    pos.setXYZ(i, x * r * ROCK_SCALE[0], y * r * ROCK_SCALE[1], z * r * ROCK_SCALE[2]);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export interface MeteorSurfaceUniforms {
  uTime: { value: number };
  uGlow: { value: number };
  uRough: { value: number };
  uSeed: { value: number };
}

/**
 * Basalt with a warped cellular fissure network that glows. Standard PBR
 * underneath, so the sun and the sky light it like anything else in the
 * scene; the emission is added on top of that.
 */
export function buildMeteorMaterial(): { material: THREE.MeshStandardMaterial; uniforms: MeteorSurfaceUniforms } {
  const uniforms: MeteorSurfaceUniforms = {
    uTime: { value: 0 },
    uGlow: { value: 0.6 },
    uRough: { value: 0.85 },
    uSeed: { value: 42 },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.22 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = 'varying vec3 vRockPosition;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvRockPosition = position;',
    );
    shader.fragmentShader = /* glsl */ `
varying vec3 vRockPosition;
uniform float uTime, uGlow, uRough, uSeed;
${NOISE_GLSL}
vec2 cellEdge(vec3 p) {
  vec3 cell = floor(p), f = fract(p);
  float a = 9.0, b = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 k = vec3(float(x), float(y), float(z));
    vec3 h = vec3(hash13(cell + k), hash13(cell + k + 17.0), hash13(cell + k + 39.0));
    float d = length(k + h - f);
    if (d < a) { b = a; a = d; } else b = min(b, d);
  }
  return vec2(a, b - a);
}
` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
vec3 rp = vRockPosition + vec3(uSeed * 0.19);
float macro = fbm(rp * 3.5);
float grain = noise3(rp * 115.0);
float detail = fbm(rp * 32.0);
vec2 cells = cellEdge(rp * 3.5 + vec3(fbm(rp * 5.0) * 0.65));
float vein = 1.0 - smoothstep(0.006, 0.038, cells.y);
float broken = smoothstep(0.26, 0.62, fbm(rp * 6.0));
float cracks = vein * broken;
vec3 basalt = mix(vec3(0.025, 0.026, 0.028), vec3(0.15, 0.125, 0.095), macro);
basalt *= 0.45 + detail * 0.9;
basalt += pow(grain, 12.0) * 0.075;
diffuseColor.rgb = basalt * (1.0 - cracks * 0.78);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = clamp(uRough + (detail - 0.5) * 0.3, 0.25, 1.0);',
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `#include <normal_fragment_maps>
{
  float height = detail * 0.065 + noise3(rp * 110.0) * 0.014 - cells.x * 0.025;
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec3 r1 = cross(q1, normal), r2 = cross(normal, q0);
  float det = dot(q0, r1);
  normal = normalize(abs(det) * normal - sign(det) * (dFdx(height) * r1 + dFdy(height) * r2));
}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `#include <emissivemap_fragment>
{
  float flicker = 0.92 + 0.08 * sin(uTime * 2.5 + macro * 12.0);
  float glow = cracks * uGlow * flicker;
  totalEmissiveRadiance = vec3(3.8, 0.22, 0.015) * glow + vec3(0.28, 0.025, 0.003) * pow(macro, 3.0) * uGlow;
}`,
    );
  };
  return { material, uniforms };
}

export interface MeteorEmbers {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  /** Per-particle randoms, four per ember. */
  data: Float32Array;
  dispose(): void;
}

const EMBER_COUNT = 400;

/**
 * Sparks streaming back along the airflow. Positions are laid out on the CPU
 * each frame from the flight direction; the shader only fades and sizes them.
 */
export function buildMeteorEmbers(): MeteorEmbers {
  const data = new Float32Array(EMBER_COUNT * 4);
  const positions = new Float32Array(EMBER_COUNT * 3);
  const randoms = new Float32Array(EMBER_COUNT);
  for (let i = 0; i < EMBER_COUNT; i += 1) {
    for (let j = 0; j < 4; j += 1) data[i * 4 + j] = hash(i, j, 17);
    randoms[i] = hash(i, 9, 5);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uAmount: { value: 0.65 },
      uScale: { value: 600 },
      uSize: { value: 1 },
    },
    vertexShader: /* glsl */ `
attribute float aRandom;
varying float vRandom;
varying float vFade;
uniform float uTime, uScale, uSize;
void main() {
  vRandom = aRandom;
  vFade = 1.0 - fract(uTime * (0.13 + aRandom * 0.09) + aRandom * 7.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp((0.018 + aRandom * 0.02) * uSize * uScale / -mv.z, 1.0, 9.0);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */ `
varying float vRandom, vFade;
uniform float uAmount;
void main() {
  if (vRandom > uAmount) discard;
  float d = length(gl_PointCoord - 0.5);
  float a = exp(-d * d * 22.0) * smoothstep(0.0, 0.2, vFade) * (1.0 - smoothstep(0.6, 1.0, vFade));
  gl_FragColor = vec4(vec3(5.0, 0.55, 0.06) * (1.0 + vRandom), a);
}`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    material,
    data,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

const emberA = new THREE.Vector3();
const emberB = new THREE.Vector3();
const emberUp = new THREE.Vector3(0, 0, 1);

/**
 * Lay the embers out behind the rock along `dir` (unit, the way the flames
 * point: against the motion). `trail` is in rock radii; the positions are in
 * the rock's local frame, which the group scales.
 */
export function layoutEmbers(embers: MeteorEmbers, dir: THREE.Vector3, time: number, trail: number, turbulence: number): void {
  const attr = embers.points.geometry.attributes.position as THREE.BufferAttribute;
  const randoms = embers.points.geometry.attributes.aRandom as THREE.BufferAttribute;
  emberA.crossVectors(dir, Math.abs(dir.z) > 0.9 ? emberB.set(1, 0, 0) : emberUp).normalize();
  emberB.crossVectors(dir, emberA);
  const data = embers.data;
  for (let i = 0; i < attr.count; i += 1) {
    const q = i * 4;
    const rand = randoms.getX(i);
    const life = (time * (0.13 + rand * 0.09) + rand * 7) % 1;
    const theta = data[q] * Math.PI * 2;
    const dist = 0.72 + data[q + 1] * 0.45 + life * 0.9;
    const rise = life * (trail + 2) * (0.75 + data[q + 2] * 0.6);
    const swirl = Math.sin(time * 1.5 + data[q + 3] * 30 + life * 4) * life * turbulence * 0.6;
    const ct = Math.cos(theta) * dist;
    const st = Math.sin(theta) * dist;
    attr.setXYZ(
      i,
      dir.x * rise + emberA.x * ct + emberB.x * st + swirl,
      dir.y * rise + emberA.y * ct + emberB.y * st,
      dir.z * rise + emberA.z * ct + emberB.z * st,
    );
  }
  attr.needsUpdate = true;
}
