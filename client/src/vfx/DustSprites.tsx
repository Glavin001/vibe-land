// The cheap dust: camera-facing sprites drawn in the scene.
//
// For the FAST tier, touch devices, and any GL that cannot raymarch (no highp,
// or no render-to-3D-texture). Same parcel store and the same selection as
// the volumetric pass; each parcel becomes two soft, noisy discs with a fake
// sphere normal lit by the sun. Depth-tested, so intersections with walls
// are hard -- the accepted look at this tier.

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { renderStats } from '../city/renderStats';
import {
  drawnAtTier,
  fogCullDistance,
  pixelsPerMetre,
  tierFor,
  TIER_STRIDE,
} from './dustLod';
import {
  DustPalette,
  evalParcel,
  newDustEval,
  type DustParcelStore,
} from './dustParcelStore';
import type { DustLighting } from './DustVolumeRenderer';
import { lookTuning, subscribeLookTuning } from '../graphics/lookTuning';

const MAX_SPRITES = 512;
const LAYERS_PER_PARCEL = 2;

const VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute vec2 aSize;
attribute vec4 aParams; // density, seed, fade, erosion
attribute float aTint;
uniform vec3 uRight;
uniform vec3 uUp;
varying vec2 vUv;
varying float vDensity;
varying float vSeed;
varying float vFade;
varying float vErosion;
varying float vTint;
varying float vViewDepth;
void main() {
  vec3 world = aCenter + uRight * (position.x * aSize.x) + uUp * (position.y * aSize.y);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0;
  vDensity = aParams.x;
  vSeed = aParams.y;
  vFade = aParams.z;
  vErosion = aParams.w;
  vTint = aTint;
  vViewDepth = -mv.z;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uAlbedo[3];
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec2 vUv;
varying float vDensity;
varying float vSeed;
varying float vFade;
varying float vErosion;
varying float vTint;
varying float vViewDepth;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.1 + 3.7) * 0.3 + vnoise(p * 4.3 + 9.1) * 0.2;
}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // Small offsets only: a sin-based hash falls apart at large coordinates.
  vec2 np = vUv * 2.5 + fract(vSeed / 251.0) * vec2(7.3, 11.1);
  float n = fbm(np);
  float disc = 1.0 - smoothstep(0.25, 1.0, r);
  float dens = max(0.0, disc * (n * 1.6 - 0.3) - vErosion * n);
  if (dens < 0.003) discard;
  float alpha = clamp(1.0 - exp(-dens * vDensity * 0.9), 0.0, 1.0) * vFade;
  vec3 normal = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r * r))));
  float lit = max(0.0, dot(normal, uSunDirView));
  float shade = 0.4 + 0.6 * n;
  int tint = int(vTint + 0.5);
  vec3 albedo = tint == 1 ? uAlbedo[1] : (tint == 2 ? uAlbedo[2] : uAlbedo[0]);
  vec3 ambient = mix(uGroundColor, uSkyColor, vUv.y * 0.5 + 0.5);
  // Dust scatters light every way: most of the sun reaches the eye from any
  // side, the sphere shading only tips it.
  vec3 col = albedo * (uSunColor * (0.35 + 0.45 * lit) * shade + ambient * (0.5 + 0.5 * shade));
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vViewDepth * vViewDepth);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type DustSpritesProps = {
  store: DustParcelStore;
  lighting: DustLighting;
  wind: { x: number; z: number };
};

const TMP_SPHERE = new THREE.Sphere();
const TMP_PROJ = new THREE.Matrix4();
const FRUSTUM = new THREE.Frustum();
const RIGHT = new THREE.Vector3();
const UP = new THREE.Vector3();
const SUN_VIEW = new THREE.Vector3();

export function DustSprites({ store, lighting, wind }: DustSpritesProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const evals = useMemo(() => newDustEval(), []);
  const order = useMemo(() => ({ slots: new Int32Array(store.capacity), dist: new Float32Array(store.capacity) }), [store]);

  const { geometry, attrs } = useMemo(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(plane.getIndex());
    geometry.setAttribute('position', plane.getAttribute('position'));
    const make = (itemSize: number) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * itemSize), itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    const attrs = { center: make(3), size: make(2), params: make(4), tint: make(1) };
    geometry.setAttribute('aCenter', attrs.center);
    geometry.setAttribute('aSize', attrs.size);
    geometry.setAttribute('aParams', attrs.params);
    geometry.setAttribute('aTint', attrs.tint);
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    return { geometry, attrs };
  }, []);

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uRight: { value: new THREE.Vector3(1, 0, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSkyColor: { value: new THREE.Color() },
      uGroundColor: { value: new THREE.Color() },
      uAlbedo: { value: [
        new THREE.Color(0xb3afa8).convertSRGBToLinear(),
        new THREE.Color(0x8f7250).convertSRGBToLinear(),
        new THREE.Color(0x66686c).convertSRGBToLinear(),
      ] },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
  }), []);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useEffect(() => {
    const u = material.uniforms;
    (u.uSunColor.value as THREE.Color).copy(lighting.sunColor);
    (u.uSkyColor.value as THREE.Color).copy(lighting.skyColor);
    (u.uGroundColor.value as THREE.Color).copy(lighting.groundColor);
  }, [material, lighting]);

  const tuningRef = useRef(lookTuning());
  useEffect(() => subscribeLookTuning((next) => { tuningRef.current = next; }), []);

  useFrame(({ camera, scene }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const started = performance.now();
    const nowMs = started;
    const live = tuningRef.current;
    const tuning = { size: live.dustSize, density: live.dustDensity, lifetime: live.dustLifetime };
    store.sweep(nowMs, tuning.lifetime);
    renderStats.dustParcelsLive = store.liveCount;
    if (store.liveCount === 0) {
      geometry.instanceCount = 0;
      renderStats.dustDrawn = 0;
      renderStats.dustCpuMs = performance.now() - started;
      return;
    }
    const perspective = camera as THREE.PerspectiveCamera;
    const fog = scene.fog as THREE.FogExp2 | null;
    const fogDensity = fog && 'density' in fog ? fog.density : 0;
    const cull = Math.min(perspective.far ?? 200, fogCullDistance(fogDensity));
    const viewportH = 1080;
    const pxPerM = pixelsPerMetre(perspective.fov ?? 75, viewportH);
    TMP_PROJ.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    FRUSTUM.setFromProjectionMatrix(TMP_PROJ);
    const cam = camera.position;
    const e = evals;
    let count = 0;
    for (let slot = 0; slot < store.capacity; slot += 1) {
      if (!store.alive[slot]) continue;
      if (!evalParcel(store, slot, nowMs, wind.x, wind.z, tuning, e)) continue;
      const dx = e.cx - cam.x;
      const dy = e.cy - cam.y;
      const dz = e.cz - cam.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance - e.radius > cull) continue;
      TMP_SPHERE.center.set(e.cx, e.cy, e.cz);
      TMP_SPHERE.radius = e.radius;
      if (!FRUSTUM.intersectsSphere(TMP_SPHERE)) continue;
      if ((e.sx * pxPerM) / Math.max(distance, 1) < 3) continue;
      const tier = tierFor(distance, e.radius);
      if (!drawnAtTier(e.serial, tier)) continue;
      order.slots[count] = slot;
      order.dist[count] = distance;
      count += 1;
    }
    // Back to front. Index sort on a small typed array of candidates.
    const idx = Array.from({ length: count }, (_, i) => i);
    idx.sort((a, b) => order.dist[b] - order.dist[a]);
    const perParcel = LAYERS_PER_PARCEL;
    const maxParcels = Math.floor(MAX_SPRITES / perParcel);
    const start = Math.max(0, idx.length - maxParcels);
    const c = attrs.center.array as Float32Array;
    const s = attrs.size.array as Float32Array;
    const p = attrs.params.array as Float32Array;
    const t = attrs.tint.array as Float32Array;
    let n = 0;
    for (let k = start; k < idx.length; k += 1) {
      const slot = order.slots[idx[k]];
      if (!evalParcel(store, slot, nowMs, wind.x, wind.z, tuning, e)) continue;
      const tier = tierFor(order.dist[idx[k]], e.radius);
      const tint = e.palette === DustPalette.Wood ? 1 : e.palette === DustPalette.Metal ? 2 : 0;
      for (let layer = 0; layer < perParcel; layer += 1) {
        const scale = layer === 0 ? 1 : 0.7;
        const seed = (e.seed >>> (layer * 5)) & 0xffff;
        c[n * 3] = e.cx + ((seed & 7) - 3.5) * 0.08 * e.radius;
        c[n * 3 + 1] = e.cy + (((seed >> 3) & 7) - 3.5) * 0.06 * e.radius;
        c[n * 3 + 2] = e.cz;
        s[n * 2] = e.sx * scale;
        s[n * 2 + 1] = e.sy * scale;
        p[n * 4] = e.density * TIER_STRIDE[tier] * 0.6;
        p[n * 4 + 1] = seed;
        p[n * 4 + 2] = e.fade;
        p[n * 4 + 3] = e.erosion;
        t[n] = tint;
        n += 1;
      }
    }
    geometry.instanceCount = n;
    for (const attr of [attrs.center, attrs.size, attrs.params, attrs.tint]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    const u = material.uniforms;
    camera.matrixWorld.extractBasis(RIGHT, UP, SUN_VIEW);
    (u.uRight.value as THREE.Vector3).copy(RIGHT);
    (u.uUp.value as THREE.Vector3).copy(UP);
    SUN_VIEW.copy(lighting.sunDir).transformDirection(camera.matrixWorldInverse);
    (u.uSunDirView.value as THREE.Vector3).copy(SUN_VIEW);
    if (fog && 'color' in fog) (u.uFogColor.value as THREE.Color).copy(fog.color);
    u.uFogDensity.value = fogDensity;
    renderStats.dustDrawn = n;
    renderStats.dustDrawnHalf = 0;
    renderStats.dustCpuMs = performance.now() - started;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={3}
    />
  );
}
