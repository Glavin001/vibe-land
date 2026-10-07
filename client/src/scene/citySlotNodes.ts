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
import type { CityTriplanarConfig } from './cityMaterialShader';
import { cityTriplanarNodes, restToViewThrough } from './cityMaterialNodes';
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

export const quatRotate = (q: Node, v: Node): Node =>
  v.add(cross(q.xyz, cross(q.xyz, v).add(q.w.mul(v))).mul(2.0));

const nodeMaterials = new WeakMap<THREE.Material, THREE.Material>();

/**
 * A matter material's builder (scene/cityMatterNodes.ts), registered there so
 * this file does not pull the Matter shaders into every WebGPU build that
 * draws a slot mesh.
 */
type MatterSlotFactory = (source: THREE.Material, poses: CityGpuPoses) => THREE.Material;
let matterSlotMaterial: MatterSlotFactory | null = null;
export function registerMatterSlotMaterial(factory: MatterSlotFactory): void {
  matterSlotMaterial = factory;
}

/** What a slot mesh's node material is built from: its chunk's composed pose. */
export interface SlotPoseNodes {
  /** The vertex's posed position (assigns normalLocal, the tint and the pose varyings). */
  positionNode: Node;
  /** The body tint (settled dimming, debug palette), a vertex varying. */
  tint: Node;
  /** The chunk's rest-to-world rotation (quaternion), a vertex varying. */
  pose: Node;
  quatRotate: (q: Node, v: Node) => Node;
  /** Keep the per-frame uniforms live for this material. */
  bind(material: THREE.Material): void;
}

/**
 * The pose composition every slot material shares. `extra(q)` runs in the
 * vertex stage with the chunk's world rotation, for materials that need more
 * of the frame posed (the steel's brushing tangent).
 */
export function slotPoseNodes(poses: CityGpuPoses, extra?: (q: Node) => void): SlotPoseNodes {
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
  // The chunk's rest-to-world rotation, for the fragment's directions.
  const pose = varyingProperty('vec4', 'vCityQuat');

  const texel = (tex: Node, index: Node): Node => {
    const size = int(textureSize(tex, int(0)).x);
    return tex.load(ivec2(index.mod(size), index.div(size)));
  };

  const positionNode = Fn(() => {
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
    pose.assign(q);
    extra?.(q);
    return quatRotate(q, positionGeometry).mul(visible).add(p);
  })();

  return {
    positionNode,
    tint,
    pose,
    quatRotate,
    // Keep the debug palette switch live: the uniform follows the WebGL one.
    bind: () => bodyColours.onFrameUpdate(() => poses.bodyColoursUniform.value),
  };
}

/**
 * The node material a slot mesh draws with on WebGPU: the triplanar
 * concrete (cityMaterialNodes.ts), placed by its chunk's composed pose, tinted by
 * its body (settled rubble is dimmer; the debug palette colours by body).
 * One per source material, shared across cells like the WebGL path. A source
 * carrying a Matter look (userData.cityMatter, scene/cityChunkMesh.ts) draws
 * that instead.
 */
export function slotNodeMaterial(source: THREE.Material, poses: CityGpuPoses): THREE.Material {
  const cached = nodeMaterials.get(source);
  if (cached) return cached;

  if (source.userData.cityMatter && matterSlotMaterial) {
    const material = matterSlotMaterial(source, poses);
    nodeMaterials.set(source, material);
    return material;
  }

  const base = source as THREE.MeshStandardMaterial;
  const transparent = base.transparent && base.opacity < 1;
  const triplanar = source.userData.cityTriplanar as CityTriplanarConfig | undefined;
  const textured = !transparent && !!triplanar && triplanar.detail !== 'off';
  const material = new MeshStandardNodeMaterial({
    // The concrete is white and takes its albedo from the texture array
    // (cityMaterialNodes.ts); untextured, it needs a colour of its own.
    color: transparent ? base.color : textured ? new THREE.Color(0xffffff) : new THREE.Color(0xb9b3a8),
    roughness: transparent ? base.roughness : textured ? 1 : 0.92,
    metalness: 0,
    transparent,
    opacity: transparent ? base.opacity : 1,
    depthWrite: !transparent,
    side: base.side,
  });

  const nodes = slotPoseNodes(poses);
  material.positionNode = nodes.positionNode;
  material.colorNode = materialColor.mul(nodes.tint);
  if (textured && triplanar) {
    const surface = cityTriplanarNodes(triplanar, restToViewThrough(nodes.pose, quatRotate));
    material.colorNode = materialColor.mul(nodes.tint).mul(surface.albedo);
    if (surface.normal) material.normalNode = surface.normal;
    if (surface.roughness) material.roughnessNode = surface.roughness;
    if (surface.occlusion) material.aoNode = surface.occlusion;
  }
  nodes.bind(material);

  nodeMaterials.set(source, material);
  return material;
}
