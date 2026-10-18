// The meteor on the WebGPU path, in TSL: meteorRock.ts's cratered basalt
// with its glowing fissures, its embers, and MeteorFireStage's fire trail --
// each a port of the GLSL, same noise, same constants, same colours.
//
// What differs is how it is drawn, not what it looks like:
// - The rock and the embers are ONE material each for every meteor, with the
//   meteor's own values (seed, glow, clock) as per-object uniforms read from
//   the mesh's userData. A material per meteor would be a node build per
//   meteor -- tens of milliseconds the first time each is drawn, mid-film.
// - The embers are GLSL points; WebGPU points are one pixel, so each is an
//   instanced quad of the size gl_PointSize gave it (1-9 px), one draw per
//   meteor.
// - The fire is not a screen-space pass (WebGPU has no frame pipeline here:
//   CityEnvironment mounts it only on WebGL) but a stack of camera-facing
//   slices through the same envelope the GLSL raymarches, each evaluating
//   the GLSL's density at its own depth, composited back to front by the
//   blender. The scene's depth buffer then hides the fire behind a wall, the
//   ground or the rock, as the GLSL's depth read does, and a camera inside
//   the envelope sees it too. Premultiplied, into the linear HDR target the
//   renderer tone-maps at output, as the GLSL's is. Where the fire lies thin
//   over the rock, close up, it is patchier than the GLSL's: a slice falls
//   in front of the bumpy surface or behind it, where a ray's last step
//   ends on it exactly.
//
// What it costs (2026-10-06, 1280x720): sixteen meteors in the air add
// 0.85 ms of frame JavaScript and draw submission over an empty sky in the
// native app (films/meteor-perf.mjs), 0.6 ms of it the fire and embers; on
// the GPU (Chrome's WebGPU, same Mac) one meteor's fire and embers take
// 0.9-1.1 ms seen from 16-22 m and 1.7 ms from 9 m (rock radius 2 m).
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Discard,
  Fn,
  If,
  Loop,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  modelScale,
  modelViewMatrix,
  normalView,
  normalize,
  positionGeometry,
  positionView,
  pow,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  varying,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  viewportSize,
} from 'three/tsl';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';

import { liveUniform } from '../graphics/webgpu/liveUniform';
import { FIRE_SLICES, type MeteorFireInstance, type MeteorFireUniforms } from './MeteorFireStage';
import { ROCK_SCALE, type MeteorEmberUniforms, type MeteorSurfaceUniforms } from './meteorRock';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
type ObjectFrame = { object?: THREE.Object3D };
/** Fn, for the functions given a layout (the typings lack setLayout). */
const LayoutFn: Node = Fn;

// ------------------------------------------------------------------ noise
// NOISE_GLSL (meteorRock.ts), as WGSL functions rather than inlined.

const hash13: Node = LayoutFn(([p0]: Node[]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.yzx.add(33.33)));
  return fract(p.x.add(p.y).mul(p.z));
}).setLayout({ name: 'meteorHash13', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

const noise3: Node = LayoutFn(([p]: Node[]) => {
  const i = floor(p).toVar();
  const f0 = fract(p);
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2))).toVar();
  return mix(
    mix(
      mix(hash13(i), hash13(i.add(vec3(1, 0, 0))), f.x),
      mix(hash13(i.add(vec3(0, 1, 0))), hash13(i.add(vec3(1, 1, 0))), f.x),
      f.y,
    ),
    mix(
      mix(hash13(i.add(vec3(0, 0, 1))), hash13(i.add(vec3(1, 0, 1))), f.x),
      mix(hash13(i.add(vec3(0, 1, 1))), hash13(i.add(vec3(1, 1, 1))), f.x),
      f.y,
    ),
    f.z,
  );
}).setLayout({ name: 'meteorNoise3', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

const fbm: Node = LayoutFn(([p0]: Node[]) => {
  const p = vec3(p0).toVar();
  const n = float(noise3(p)).mul(0.53).toVar();
  p.assign(p.mul(2.03).add(vec3(7.1, 3.7, 1.9)));
  n.addAssign(noise3(p).mul(0.27));
  p.assign(p.mul(2.07).add(vec3(5.7, 1.3, 9.1)));
  n.addAssign(noise3(p).mul(0.13));
  n.addAssign(noise3(p.mul(2.11)).mul(0.07));
  return n;
}).setLayout({ name: 'meteorFbm', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

/** The GLSL cellEdge: distance to the nearest cell point, and to the edge between it and the next. */
const cellEdge: Node = LayoutFn(([p]: Node[]) => {
  const cell = floor(p).toVar();
  const f = fract(p).toVar();
  const a = float(9).toVar();
  const b = float(9).toVar();
  Loop(
    { start: -1, end: 1, condition: '<=', name: 'z' },
    { start: -1, end: 1, condition: '<=', name: 'y' },
    { start: -1, end: 1, condition: '<=', name: 'x' },
    ({ x, y, z }: { x: Node; y: Node; z: Node }) => {
      const k = vec3(float(x), float(y), float(z));
      const c = cell.add(k);
      const h = vec3(hash13(c), hash13(c.add(17)), hash13(c.add(39)));
      const d = length(k.add(h).sub(f)).toVar();
      If(d.lessThan(a), () => {
        b.assign(a);
        a.assign(d);
      }).Else(() => {
        b.assign(min(b, d));
      });
    },
  );
  return vec2(a, b.sub(a));
}).setLayout({ name: 'meteorCellEdge', type: 'vec2', inputs: [{ name: 'p', type: 'vec3' }] });

// ------------------------------------------------------------------- rock

const DEFAULT_SURFACE: MeteorSurfaceUniforms = {
  uTime: { value: 0 }, uGlow: { value: 0.6 }, uRough: { value: 0.85 }, uSeed: { value: 42 },
};
const surfaceOf = (object: THREE.Object3D | undefined): MeteorSurfaceUniforms =>
  (object?.userData?.meteorSurface as MeteorSurfaceUniforms | undefined) ?? DEFAULT_SURFACE;

/**
 * The rock's surface for every meteor (buildMeteorMaterial's GLSL patch):
 * basalt with a warped cellular fissure network that glows, standard PBR
 * underneath. Its values per mesh from `userData.meteorSurface`; a rock
 * without one (a dynamic body drawn as a meteor) takes the GLSL defaults.
 */
export function meteorRockNodeMaterial(): THREE.Material {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.22 }) as Node;
  material.name = 'Meteor rock (TSL)';
  const perObject = (read: (s: MeteorSurfaceUniforms) => number, initial: number): Node =>
    (uniform(initial) as Node).onObjectUpdate(({ object }: ObjectFrame) => read(surfaceOf(object)));
  const uTime = perObject((s) => s.uTime.value, 0);
  const uGlow = perObject((s) => s.uGlow.value, 0.6);
  const uRough = perObject((s) => s.uRough.value, 0.85);
  const uSeed = perObject((s) => s.uSeed.value, 42);

  // vRockPosition: the unit rock's own position, so the fissures ride on it.
  // A node used by several of the slots below is computed once (TSL keeps a
  // node used twice in a temporary).
  const rp: Node = (varying(positionGeometry, 'vRockPosition') as Node).add(uSeed.mul(0.19));
  const macro: Node = fbm(rp.mul(3.5));
  const grain: Node = noise3(rp.mul(115));
  const detail: Node = fbm(rp.mul(32));
  const cells: Node = cellEdge(rp.mul(3.5).add(fbm(rp.mul(5)).mul(0.65)));
  const vein = float(1).sub(smoothstep(0.006, 0.038, cells.y));
  const broken = smoothstep(0.26, 0.62, fbm(rp.mul(6)));
  const cracks: Node = vein.mul(broken);

  const basalt = mix(vec3(0.025, 0.026, 0.028), vec3(0.15, 0.125, 0.095), macro)
    .mul(detail.mul(0.9).add(0.45))
    .add(pow(grain, 12).mul(0.075));
  material.colorNode = basalt.mul(float(1).sub(cracks.mul(0.78)));
  material.roughnessNode = clamp(uRough.add(detail.sub(0.5).mul(0.3)), 0.25, 1);
  // The GLSL's height bump, by screen derivatives of the view position.
  material.normalNode = Fn(() => {
    const height = detail.mul(0.065).add(noise3(rp.mul(110)).mul(0.014)).sub(cells.x.mul(0.025));
    const n = normalView;
    const q0 = dFdx(positionView);
    const q1 = dFdy(positionView);
    const r1 = cross(q1, n);
    const r2 = cross(n, q0);
    const det = dot(q0, r1);
    return normalize(abs(det).mul(n).sub(sign(det).mul(dFdx(height).mul(r1).add(dFdy(height).mul(r2)))));
  })();
  const flicker = sin(uTime.mul(2.5).add(macro.mul(12))).mul(0.08).add(0.92);
  material.emissiveNode = vec3(3.8, 0.22, 0.015).mul(cracks.mul(uGlow).mul(flicker))
    .add(vec3(0.28, 0.025, 0.003).mul(pow(macro, 3)).mul(uGlow));
  return material as THREE.Material;
}

// ----------------------------------------------------------------- embers

const DEFAULT_EMBERS: MeteorEmberUniforms = {
  uTime: { value: 0 }, uAmount: { value: 0 }, uScale: { value: 600 }, uSize: { value: 1 },
};
let emberMaterial: THREE.Material | null = null;

/**
 * The embers' shared material (buildMeteorEmbers' GLSL points): each ember
 * a quad gl_PointSize pixels across, a soft spot fading over its life,
 * additive. Its values per mesh from `userData.meteorEmbers`.
 */
function meteorEmberMaterial(): THREE.Material {
  if (emberMaterial) return emberMaterial;
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as Node;
  material.name = 'Meteor embers (TSL)';
  material.fog = false;
  const embersOf = (object: THREE.Object3D | undefined): MeteorEmberUniforms =>
    (object?.userData?.meteorEmbers as MeteorEmberUniforms | undefined) ?? DEFAULT_EMBERS;
  const perObject = (read: (u: MeteorEmberUniforms) => number, initial: number): Node =>
    (uniform(initial) as Node).onObjectUpdate(({ object }: ObjectFrame) => read(embersOf(object)));
  const uTime = perObject((u) => u.uTime.value, 0);
  const uAmount = perObject((u) => u.uAmount.value, 0);
  const uScale = perObject((u) => u.uScale.value, 600);
  const uSize = perObject((u) => u.uSize.value, 1);

  const vRandom = varyingProperty('float', 'vEmberRandom');
  const vFade = varyingProperty('float', 'vEmberFade');
  const vCorner = varyingProperty('vec2', 'vEmberCorner');
  const centre: Node = attribute('aEmberPosition', 'vec3');
  const random: Node = attribute('aRandom', 'float');

  material.vertexNode = Fn(() => {
    vRandom.assign(random);
    vFade.assign(float(1).sub(fract(uTime.mul(random.mul(0.09).add(0.13)).add(random.mul(7)))));
    vCorner.assign(positionGeometry.xy);
    const mv = modelViewMatrix.mul(vec4(centre, 1));
    const size = clamp(random.mul(0.02).add(0.018).mul(uSize).mul(uScale).div(mv.z.negate()), 1, 9);
    // The GLSL discards an ember past uAmount; here its quad has no area.
    const shown = step(random, uAmount);
    const clip = cameraProjectionMatrix.mul(mv).toVar();
    const offset = positionGeometry.xy.mul(size).div(viewportSize).mul(clip.w).mul(shown);
    return vec4(clip.xy.add(offset), clip.zw);
  })();
  const d = length(vCorner.mul(0.5));
  material.colorNode = vec3(5, 0.55, 0.06).mul(vRandom.add(1));
  material.opacityNode = exp(d.mul(d).mul(-22))
    .mul(smoothstep(0, 0.2, vFade))
    .mul(float(1).sub(smoothstep(0.6, 1, vFade)));
  emberMaterial = material as THREE.Material;
  return emberMaterial;
}

/**
 * One meteor's embers: EMBER_COUNT instanced quads over `positions` and
 * `randoms` (laid out by layoutEmbers), drawn with the shared material.
 */
export function meteorEmberNodes(positions: Float32Array, randoms: Float32Array, uniforms: MeteorEmberUniforms) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  // Unused, but three's vertex stage reads one and warns without it.
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const position = new THREE.InstancedBufferAttribute(positions, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  const random = new THREE.InstancedBufferAttribute(randoms, 1);
  geometry.setAttribute('aEmberPosition', position);
  geometry.setAttribute('aRandom', random);
  geometry.instanceCount = randoms.length;
  const mesh = new THREE.Mesh(geometry, meteorEmberMaterial());
  mesh.userData.meteorEmbers = uniforms;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    object: mesh as THREE.Object3D,
    positions: position as THREE.BufferAttribute,
    randoms: random as THREE.BufferAttribute,
    dispose: () => geometry.dispose(),
  };
}

// ------------------------------------------------------------------- fire

const DEFAULT_FIRE: MeteorFireInstance = {
  center: new THREE.Vector3(),
  direction: new THREE.Vector3(0, 1, 0),
  radiusM: 1,
  airSpeed: 0,
  inverseRock: new THREE.Matrix4(),
  seed: 42,
  intensity: 0,
};

/**
 * The slices one meteor's fire is drawn on: FIRE_SLICES unit quads, the
 * slice index in z, farthest first. Positioned in the vertex stage.
 */
function fireSliceGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(FIRE_SLICES * 4 * 3);
  const index: number[] = [];
  for (let k = 0; k < FIRE_SLICES; k += 1) {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    corners.forEach(([x, y], c) => positions.set([x, y, k], (k * 4 + c) * 3));
    index.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Unused, but three's vertex stage reads one and warns without it.
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(FIRE_SLICES * 4 * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

/**
 * The fire for every meteor: MeteorFireStage's marchMeteor, one sample per
 * slice. A mesh carries its meteor in `userData.meteorFire` and sits at the
 * centre of the envelope the GLSL marches, scaled to its radius
 * (meteorFireEnvelope), so the frustum culls it as a sphere.
 */
export function meteorFireNodeMaterial(shared: MeteorFireUniforms): { material: THREE.Material; geometry: THREE.BufferGeometry } {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // Premultiplied over, as the GLSL composites it.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }) as Node;
  material.name = 'Meteor fire (TSL)';
  material.fog = false;
  const fireOf = (object: THREE.Object3D | undefined): MeteorFireInstance =>
    (object?.userData?.meteorFire as MeteorFireInstance | undefined) ?? DEFAULT_FIRE;
  const centerValue = new THREE.Vector3();
  const directionValue = new THREE.Vector3(0, 1, 0);
  const uCenter: Node = (uniform(centerValue) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).center);
  const uDirection: Node = (uniform(directionValue) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).direction);
  const uRadius: Node = (uniform(1) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).radiusM);
  const uWind: Node = (uniform(0) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).airSpeed);
  const uSeed: Node = (uniform(42) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).seed);
  const uIntensity: Node = (uniform(0) as Node).onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).intensity);
  const uInverseRock: Node = (uniform(new THREE.Matrix4()) as Node)
    .onObjectUpdate(({ object }: ObjectFrame) => fireOf(object).inverseRock);
  const uTime = liveUniform(shared.uTime, 'float');
  const uTurbulence = liveUniform(shared.uTurbulence, 'float');
  const uTrail = liveUniform(shared.uTrail, 'float');

  const vWorld = varyingProperty('vec3', 'vFireWorld');
  const slices = float(FIRE_SLICES);

  // Each slice a disc across the envelope sphere, perpendicular to the view,
  // at its depth: the sphere's cross-section there.
  material.vertexNode = Fn(() => {
    const radius = (modelScale as Node).x;
    const centreView = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const s = positionGeometry.z.add(0.5).mul(2).div(slices).sub(1).mul(radius);
    const disc = sqrt(max(radius.mul(radius).sub(s.mul(s)), 0));
    const view = centreView.add(vec3(positionGeometry.xy.mul(disc), s));
    vWorld.assign(cameraWorldMatrix.mul(vec4(view, 1)).xyz);
    return cameraProjectionMatrix.mul(vec4(view, 1));
  })();

  const fire = Fn(() => {
    const R = uRadius;
    const dir = uDirection;
    // Along the ray, this slice stands for the distance to the next one.
    const ray = normalize(vWorld.sub(cameraPosition)).toVar();
    const forward = normalize(cameraWorldMatrix.mul(vec4(0, 0, -1, 0)).xyz);
    const spacing = (modelScale as Node).x.mul(2).div(slices);
    const stepSize = spacing.div(R).div(max(abs(dot(ray, forward)), 0.05)).toVar();
    // Rock radii, centred on the rock. Not jittered along the ray as the
    // GLSL's first step is: on a slice even a tenth of a step of per-pixel
    // jitter read as grain where the fire lies thin over the rock, and 48
    // slices showed no banding without it (side by side with WebGL, 2026-10-06).
    const world = vWorld;
    const p = world.sub(uCenter).div(R).toVar();
    const trail = uTrail.mul(min(uWind, 50).mul(0.022).add(0.72)).toVar();
    const h = dot(p, dir).toVar();
    If(h.lessThanEqual(-0.95).or(h.greaterThanEqual(trail.add(1.3))).or(uIntensity.lessThanEqual(0)), () => {
      Discard();
    });
    const radial = p.sub(dir.mul(h));
    const rise = max(h, 0);
    const taper = clamp(float(1).sub(max(h.sub(0.25), 0).div(trail.add(0.3))), 0, 1);
    const radius = pow(taper, 0.65).mul(1.05).toVar();
    // Nothing here can reach this far from the axis: the widest wobble and
    // noise the field and the smoke can add (an early out, not a change).
    const reach = float(0.87).mul(rise.mul(0.24).add(0.27)).mul(uTurbulence)
      .add(max(rise.mul(0.2).add(0.82).mul(uTurbulence).mul(0.5).add(0.1), 0.85));
    If(length(radial).greaterThan(radius.add(reach).add(0.05)), () => {
      Discard();
    });
    const speed = uWind.mul(0.05).add(1.1);
    const flow = p.mul(2.6).sub(dir.mul(uTime).mul(speed)).add(vec3(uSeed.mul(0.17))).toVar();
    const curl = vec3(
      noise3(flow.mul(0.68).add(3)),
      noise3(flow.mul(0.71).add(17)),
      noise3(flow.mul(0.73).add(41)),
    ).sub(0.5).toVar();
    const wobble0 = curl.mul(rise.mul(0.24).add(0.27)).mul(uTurbulence);
    const wobble = wobble0.sub(dir.mul(dot(wobble0, dir)));
    const r = length(radial.add(wobble)).toVar();
    const n = fbm(flow.add(curl.mul(uTurbulence).mul(1.8))).toVar();
    const fine = noise3(flow.mul(3.1).sub(dir.mul(uTime).mul(0.9)));
    const field = radius.sub(r).add(n.sub(0.5).mul(rise.mul(0.2).add(0.82)).mul(uTurbulence));
    const envelope = smoothstep(-1, -0.45, h).mul(float(1).sub(smoothstep(trail.mul(0.78), trail.add(0.2), h))).toVar();
    const rockLocal = uInverseRock.mul(vec4(world, 1)).xyz;
    const hollow = smoothstep(0.85, 1.15, length(rockLocal.div(vec3(ROCK_SCALE[0], ROCK_SCALE[1], ROCK_SCALE[2])))).toVar();
    const tongues = smoothstep(0.36, 0.72, n).mul(smoothstep(-0.1, 0.23, field));
    const density = tongues.mul(envelope).mul(hollow).mul(fine.mul(0.65).add(0.65)).mul(uIntensity).toVar();
    const heat = clamp(density.mul(0.92).mul(mix(1, 0.65, smoothstep(0.8, trail, h))), 0, 1).toVar();
    const c1 = mix(vec3(0.7, 0.028, 0.003), vec3(3.2, 0.3, 0.008), smoothstep(0.04, 0.35, heat));
    const c2 = mix(c1, vec3(6, 1.4, 0.09), smoothstep(0.35, 0.75, heat));
    const color = mix(c2, vec3(8, 4.5, 1.4), smoothstep(0.75, 1, heat));
    const alpha = float(1).sub(exp(density.mul(-2.6).mul(stepSize))).toVar();
    const smokeN = noise3(flow.mul(0.7));
    const smoke = smoothstep(0.25, 0.7, h.div(trail))
      .mul(smoothstep(-0.2, 0.5, radius.add(0.25).sub(r).add(smokeN.sub(0.5).mul(0.8))))
      .mul(uTurbulence.mul(0.22).add(0.12))
      .mul(float(1).sub(envelope.mul(0.7)))
      .mul(smoothstep(0, 0.6, h))
      .mul(hollow);
    const sa = float(1).sub(exp(smoke.negate().mul(stepSize)));
    // The step's fire, then its smoke behind it, as the GLSL accumulates them.
    const rgb = color.mul(alpha).add(vec3(0.033, 0.03, 0.029).mul(sa).mul(float(1).sub(alpha)));
    const a = float(1).sub(float(1).sub(alpha).mul(float(1).sub(sa))).toVar();
    If(a.lessThan(1e-4), () => {
      Discard();
    });
    return vec4(rgb, a);
  })();
  material.colorNode = fire.rgb;
  material.opacityNode = fire.a;
  return { material: material as THREE.Material, geometry: fireSliceGeometry() };
}
