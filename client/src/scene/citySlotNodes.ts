// The city's chunk transform on the WebGPU path, in TSL.
//
// The same composition as SLOT_PARS in citySlotMesh.ts, which is GLSL and
// only exists for WebGLRenderer: each vertex carries its chunk's slot, the
// slot's record names its body and the chunk's offset in that body, and the
// world pose is `body_pose ∘ offset`, read from the two pose textures the CPU
// writes. A chunk whose composed centre is below CHUNK_HIDE_Y_M, or whose
// body is gone, collapses to a point.
//
// Only imported behind __WEBGPU__: `three` is three/webgpu in that build.

import * as THREE from 'three';
import {
  Fn,
  attribute,
  cross,
  dot,
  float,
  int,
  ivec2,
  materialColor,
  normalGeometry,
  normalLocal,
  normalize,
  positionGeometry,
  select,
  texture,
  textureSize,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

import { CHUNK_HIDE_Y_M } from '../city/cityPoseStore';
import type { CityGpuPoses } from './citySlotMesh';

// TSL nodes are loosely typed in @types/three 0.170; keep this file honest
// at the call sites rather than fighting the generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const quatMul = (a: Node, b: Node): Node =>
  vec4(
    a.w.mul(b.xyz).add(b.w.mul(a.xyz)).add(cross(a.xyz, b.xyz)),
    a.w.mul(b.w).sub(dot(a.xyz, b.xyz)),
  );

const quatRotate = (q: Node, v: Node): Node =>
  v.add(cross(q.xyz, cross(q.xyz, v).add(q.w.mul(v))).mul(2.0));

const nodeMaterials = new WeakMap<THREE.Material, THREE.Material>();

/**
 * The node material a slot mesh draws with on WebGPU: plain colour (no
 * triplanar textures yet), placed by its chunk's composed pose, tinted by
 * its body (settled rubble is dimmer; the debug palette colours by body).
 * One per source material, shared across cells like the WebGL path.
 */
export function slotNodeMaterial(source: THREE.Material, poses: CityGpuPoses): THREE.Material {
  const cached = nodeMaterials.get(source);
  if (cached) return cached;

  const base = source as THREE.MeshStandardMaterial;
  const transparent = base.transparent && base.opacity < 1;
  const material = new MeshStandardNodeMaterial({
    // The WebGL concrete is white and takes its albedo from the texture
    // array; untextured, it needs a colour of its own.
    color: transparent ? base.color : new THREE.Color(0xb9b3a8),
    roughness: transparent ? base.roughness : 0.92,
    metalness: 0,
    transparent,
    opacity: transparent ? base.opacity : 1,
    depthWrite: !transparent,
    side: base.side,
  });

  // Integer texel fetches: no UV transform (texture() without a uv turns
  // the texture's matrix on, and load() keeps it).
  const chunks = texture(poses.chunkTexture);
  const bodies = texture(poses.bodyTexture);
  chunks.updateMatrix = false;
  bodies.updateMatrix = false;
  poses.onBodyTextureReplaced((next) => {
    bodies.value = next;
  });
  const hideY = uniform(CHUNK_HIDE_Y_M);
  const bodyColours = uniform(poses.bodyColoursUniform.value);
  const tint = varyingProperty('vec3', 'vCityTint');

  const texel = (tex: Node, index: Node): Node => {
    const size = int(textureSize(tex, int(0)).x);
    return tex.load(ivec2(index.mod(size), index.div(size)));
  };

  material.positionNode = Fn(() => {
    const slot = int(attribute('citySlot', 'float'));
    const record0 = texel(chunks, slot.mul(2));
    const record1 = texel(chunks, slot.mul(2).add(1));
    const body = int(record0.x);
    const body0 = texel(bodies, body.mul(4));
    const body1 = texel(bodies, body.mul(4).add(1));
    const q = normalize(quatMul(body1, record1));
    const p = body0.xyz.add(quatRotate(body1, record0.yzw));
    const visible = select(p.y.lessThan(hideY).or(body.lessThan(0)), float(0), float(1));
    tint.assign(
      select(bodyColours.greaterThan(0.5), texel(bodies, body.mul(4).add(2)).rgb.mul(body0.w), vec3(body0.w)),
    );
    normalLocal.assign(quatRotate(q, normalGeometry));
    return quatRotate(q, positionGeometry).mul(visible).add(p);
  })();
  material.colorNode = materialColor.mul(tint);

  // Keep the debug palette switch live: the uniform follows the WebGL one.
  bodyColours.onFrameUpdate(() => poses.bodyColoursUniform.value);

  nodeMaterials.set(source, material);
  return material;
}
