// Vehicle part batches on the WebGPU path: LiveAssembly's InstancedMesh
// replaced by a mesh whose instanced geometry carries the matrices as four
// vec4 attributes, drawn by node materials that all share one position/
// normal graph.
//
// Why: three (r182, still in r186) keys an InstancedMesh's shader by the
// object (a TODO in RenderObject.getCacheKey), so every part batch of every
// car built its own shader the first time it was drawn: 227 builds, 5 s of
// stall, when the city fleet came into view. These batches key by material
// and attribute layout instead, so all cars share a handful of shaders that
// the loading screen builds ahead (scene/ShaderWarmup.tsx).
//
// Only imported behind __WEBGPU__; registered by @render-backend/install.

import * as THREE from 'three';
import {
  Fn,
  attribute,
  dot,
  mat3,
  mat4,
  normalGeometry,
  normalLocal,
  normalize,
  positionGeometry,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** One graph for every part material: identical structure, one cache key. */
let sharedPosition: Node = null;
function partPositionNode(): Node {
  sharedPosition ??= Fn(() => {
    const c0: Node = attribute('partMatrix0', 'vec4');
    const c1: Node = attribute('partMatrix1', 'vec4');
    const c2: Node = attribute('partMatrix2', 'vec4');
    const c3: Node = attribute('partMatrix3', 'vec4');
    // As three's InstanceNode: divide by the squared column lengths, so a
    // non-uniform scale still yields the right normal direction.
    const n = (normalGeometry as Node).div(vec3(dot(c0.xyz, c0.xyz), dot(c1.xyz, c1.xyz), dot(c2.xyz, c2.xyz)));
    normalLocal.assign(normalize(mat3(c0.xyz, c1.xyz, c2.xyz).mul(n)));
    return mat4(c0, c1, c2, c3).mul(vec4(positionGeometry, 1)).xyz;
  })();
  return sharedPosition;
}

const nodeMaterials = new WeakMap<THREE.Material, THREE.Material>();

/**
 * The node material drawing a part with `source`'s look. It shares the
 * source's Color object and reads its roughness/metalness, so repainting the
 * source (a body paint) repaints the part.
 */
function partMaterial(source: THREE.Material): THREE.Material {
  if ((source as { isNodeMaterial?: boolean }).isNodeMaterial) return source;
  let material = nodeMaterials.get(source);
  if (material) return material;
  const standard = source as THREE.MeshStandardMaterial;
  const node = new MeshStandardNodeMaterial({ side: standard.side, flatShading: standard.flatShading });
  node.name = `vehicle part (${standard.name || 'palette'})`;
  if (standard.color) node.color = standard.color;
  Object.defineProperty(node, 'roughness', { get: () => standard.roughness ?? 1, set: () => {}, configurable: true });
  Object.defineProperty(node, 'metalness', { get: () => standard.metalness ?? 0, set: () => {}, configurable: true });
  (node as unknown as { positionNode: Node }).positionNode = partPositionNode();
  material = node as unknown as THREE.Material;
  nodeMaterials.set(source, material);
  return material;
}

/** The subset of InstancedMesh that LiveAssembly and VehicleVisual use. */
class PartBatch extends THREE.Mesh {
  readonly isPartBatch = true;
  readonly instanceMatrix: { count: number; array: Float32Array; needsUpdate: boolean; setUsage: (usage: THREE.Usage) => void };
  private readonly matrices: Float32Array;

  constructor(template: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = template.index;
    for (const [name, value] of Object.entries(template.attributes)) geometry.setAttribute(name, value);
    if (!template.boundingSphere) template.computeBoundingSphere();
    geometry.boundingSphere = template.boundingSphere!.clone();
    geometry.boundingBox = template.boundingBox?.clone() ?? null;
    const matrices = new Float32Array(capacity * 16);
    for (let i = 0; i < capacity; i += 1) new THREE.Matrix4().toArray(matrices, i * 16);
    const buffer = new THREE.InstancedInterleavedBuffer(matrices, 16, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    for (let column = 0; column < 4; column += 1) {
      geometry.setAttribute(`partMatrix${column}`, new THREE.InterleavedBufferAttribute(buffer, 4, column * 4));
    }
    geometry.instanceCount = capacity;
    super(geometry, partMaterial(material));
    // Assigning a palette material (VehicleVisual repaints) draws it through
    // its part node material.
    let drawn = this.material as THREE.Material;
    Object.defineProperty(this, 'material', {
      get: () => drawn,
      set: (value: THREE.Material) => { drawn = partMaterial(value); },
      configurable: true,
      enumerable: true,
    });
    this.matrices = matrices;
    this.instanceMatrix = {
      count: capacity,
      array: matrices,
      set needsUpdate(value: boolean) { if (value) buffer.needsUpdate = true; },
      get needsUpdate() { return false; },
      setUsage: (usage) => { buffer.setUsage(usage); },
    };
  }

  // The batch size lives on the geometry (instanceCount). The object itself
  // stays count 1: three treats `object.count > 1` as instanced drawing and
  // keys its shader by the object, the very thing these batches avoid.
  get count(): number { return 1; }
  set count(value: number) { (this.geometry as THREE.InstancedBufferGeometry).instanceCount = value; }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void { matrix.toArray(this.matrices, index * 16); }
  getMatrixAt(index: number, matrix: THREE.Matrix4): void { matrix.fromArray(this.matrices, index * 16); }

  // The template's attributes belong to the vehicle's LiveGeometry: dispose
  // only this batch, as InstancedMesh.dispose() does.
  dispose(): void { this.dispatchEvent({ type: 'dispose' } as never); }
}

export function createPartBatch(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.Mesh {
  return new PartBatch(geometry, material, capacity);
}
