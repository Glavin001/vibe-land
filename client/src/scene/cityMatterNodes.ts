// City chunks wearing a Matter material (graphics/matter), on the WebGPU path.
//
// The field is evaluated in each chunk's REST frame, like the triplanar: a
// shard keeps its grain, veins and aggregate when it breaks off and tumbles.
// Two attributes, written for these cells only (scene/cityChunkMesh.ts
// bakeMatterFrames):
//
//   matterFrame.xyz  rest position relative to the building's origin (metres,
//                    small, so FP32 resolves 0.1 mm steel grooves), plus a
//                    per-board offset for oak so each board is cut from its
//                    own log
//   matterFrame.w    which rest axis is the material's +Y (the oak log, the
//                    steel's brushing): 0 = y, 1 = x, 2 = z
//   tangent          (steel only) across the brushing, in the rest frame;
//                    the vertex stage poses it with the chunk
//
// Only imported behind __WEBGPU__ (registered by graphics/webgpu/install.ts).

import * as THREE from 'three';
import {
  attribute,
  cameraPosition,
  cross,
  normalGeometry,
  positionWorld,
  select,
  tangentLocal,
  vec3,
  vec4,
} from 'three/tsl';

import type { ResolvedMatter } from '../graphics/matter/appearanceMatter';
import { type MatterSpace, createMaterial } from '../graphics/matter/materials';
import type { CityGpuPoses } from './citySlotMesh';
import { quatRotate, slotPoseNodes } from './citySlotNodes';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** What cityChunkMesh.ts hands over on the source material's userData. */
export interface CityMatterSource {
  matter: ResolvedMatter;
  /** The pack's glass: its opacity and colour (glass is drawn tinted by it). */
  opacity: number | null;
  color: string | null;
}

/** Rest -> material axes: a proper rotation taking the chosen rest axis to +Y. */
const toMaterial = (code: Node, v: Node): Node =>
  select(code.lessThan(0.5), v, select(code.lessThan(1.5), vec3(v.y.negate(), v.x, v.z), vec3(v.x, v.z, v.y.negate())));

/** Material -> rest axes (the inverse of toMaterial). */
const toRest = (code: Node, m: Node): Node =>
  select(code.lessThan(0.5), m, select(code.lessThan(1.5), vec3(m.y, m.x.negate(), m.z), vec3(m.x, m.z.negate(), m.y)));

const conjugate = (q: Node): Node => vec4(q.xyz.negate(), q.w);

export function matterSlotMaterial(source: THREE.Material, poses: CityGpuPoses): THREE.Material {
  const { matter, opacity, color } = source.userData.cityMatter as CityMatterSource;
  const kind = matter.recipe.kind;
  const frame: Node = attribute('matterFrame', 'vec4');
  const code: Node = frame.w;

  // Steel's anisotropy runs across the brushing, as the lab's manufacturing
  // tangents do (shapes.ts setManufacturingTangents), posed with the chunk.
  const nodes = slotPoseNodes(
    poses,
    kind === 'steel'
      ? (q: Node) => {
          const n = toMaterial(code, normalGeometry);
          const up = select(n.y.abs().lessThan(0.98), vec3(0, 1, 0), vec3(0, 0, 1));
          tangentLocal.assign(quatRotate(q, toRest(code, cross(n, up).normalize())));
        }
      : undefined,
  );
  const q = nodes.pose;
  const space: MatterSpace = {
    position: toMaterial(code, frame.xyz),
    normal: toMaterial(code, normalGeometry),
    toWorld: (direction: Node) => quatRotate(q, toRest(code, direction)),
    viewDirection: toMaterial(code, quatRotate(conjugate(q), cameraPosition.sub(positionWorld))),
  };
  const handle = createMaterial(matter.recipe, { space, glassLite: true });
  const material = handle.material;
  material.name = `City / ${matter.name}`;
  material.positionNode = nodes.positionNode;
  material.colorNode = (material.colorNode as Node).mul(nodes.tint);
  // A countertop's thickness, not the lab's 18 cm specimen, for the marble's
  // light-through-the-slab term.
  material.userData.physicalThickness = 0.03;
  if (kind === 'glass') {
    material.opacity = opacity ?? 0.5;
    if (color) handle.uniforms.tint.value.set(color);
    material.side = THREE.DoubleSide;
    // As the plain city glass (cityChunkMesh.ts buildGlassMaterial): depth
    // written so the nearest pane wins, one pass for both faces.
    material.depthWrite = true;
    material.forceSinglePass = true;
  }
  nodes.bind(material);
  return material;
}
