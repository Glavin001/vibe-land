// A cell's lone hulls as ONE draw, however many of them are moving.
//
// The BatchedMesh path drew a cell as a static shell plus one multi-draw
// sub-draw per chunk that had ever moved. Measured on the M3 Max, a sub-draw
// costs ~1.3 us of GPU with the city shader regardless of pixels (cityShell.ts),
// so a collapse with 20k chunks awake was 20k sub-draws in the shadow pass and
// 20k more in the beauty pass: ~50 ms, which is what the reporter's "gpu frame
// 55.9 ms" was. The cost scaled with destruction because the DRAW COUNT did.
//
// Here the cell's geometry is merged once, every vertex carries the index of
// the chunk it belongs to, and the vertex shader fetches that chunk's matrix
// from a texture -- exactly what BatchedMesh does, except the index is a
// vertex attribute rather than gl_DrawID, so the whole cell is a single
// indexed draw in every pass. Moving a chunk is a 64-byte texture write, not
// a new sub-draw. Draw count per frame is a property of the city's size, not
// of how much of it is falling.
//
// The matrices texture uses three's batching layout (four RGBA32F texels per
// instance, sixteen floats contiguous), so `refreshRenderableSphere` reads it
// the same way it reads a BatchedMesh, and hiding is a zero-scale matrix, as
// the InstancedMesh path already does.

import * as THREE from 'three';

/** Where one chunk's vertices landed in the merged geometry. */
export interface SlotVertexRange {
  vertexStart: number;
  vertexCount: number;
}

const SLOT_PARS = `
attribute float cityInstance;
uniform highp sampler2D cityMatrices;
mat4 citySlotMatrix() {
  int size = textureSize( cityMatrices, 0 ).x;
  int j = int( cityInstance ) * 4;
  int x = j % size;
  int y = j / size;
  return mat4(
    texelFetch( cityMatrices, ivec2( x, y ), 0 ),
    texelFetch( cityMatrices, ivec2( x + 1, y ), 0 ),
    texelFetch( cityMatrices, ivec2( x + 2, y ), 0 ),
    texelFetch( cityMatrices, ivec2( x + 3, y ), 0 )
  );
}
`;

/**
 * Teach a material to place each vertex by its chunk's matrix.
 *
 * Wraps whatever `onBeforeCompile` the material already has (the triplanar
 * concrete injects there too) and runs after it, inserting the transform
 * right behind `begin_vertex` / `beginnormal_vertex`, before anything that
 * reads `transformed`. `CITY_SLOTS` is defined so the concrete's vertex body
 * takes its baked-anchor branch, as it does under USE_BATCHING.
 *
 * One material per mesh: the matrices texture is a uniform, and three only
 * re-uploads uniforms when the material changes between draws, so two meshes
 * sharing one material would share one texture.
 */
export function injectSlotTransform(material: THREE.Material, texture: THREE.DataTexture): void {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.defines = { ...(material.defines ?? {}), CITY_SLOTS: '' };
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.cityMatrices = { value: texture };
    shader.vertexShader = SLOT_PARS + shader.vertexShader;
    if (shader.vertexShader.includes('#include <beginnormal_vertex>')) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  objectNormal = mat3( citySlotMatrix() ) * objectNormal;',
      );
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed = ( citySlotMatrix() * vec4( transformed, 1.0 ) ).xyz;',
    );
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}-city-slots-v1`;
}

/**
 * Accumulates member geometries, in their own local space, into one buffer,
 * tagging every vertex with its chunk's instance index.
 *
 * Callers append each slot's geometry AFTER `bakeRestAnchors` has run on it:
 * the anchor is what the concrete is mapped by, and it is copied verbatim so
 * a chunk shades exactly as the batched path shaded it.
 */
export class SlotGeometryBuilder {
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly anchors: Float32Array;
  private readonly colors: Float32Array;
  private readonly instances: Float32Array;
  private readonly indices: Uint32Array;
  private vertexCursor = 0;
  private indexCursor = 0;
  readonly ranges: SlotVertexRange[] = [];

  constructor(vertexBudget: number, indexBudget: number) {
    this.positions = new Float32Array(vertexBudget * 3);
    this.normals = new Float32Array(vertexBudget * 3);
    this.anchors = new Float32Array(vertexBudget * 4);
    this.colors = new Float32Array(vertexBudget * 3).fill(1);
    this.instances = new Float32Array(vertexBudget);
    this.indices = new Uint32Array(indexBudget);
  }

  /** Append one chunk as instance `instance`; returns its vertex range. */
  append(geometry: THREE.BufferGeometry, instance: number): SlotVertexRange {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const anchor = geometry.getAttribute('cityAnchor');
    const index = geometry.getIndex();
    if (!index) throw new Error('slot members are always indexed (normalizeForBatching)');
    const vertexStart = this.vertexCursor;
    const vertexCount = position.count;
    if (vertexStart + vertexCount > this.instances.length
      || this.indexCursor + index.count > this.indices.length) {
      throw new Error('slot geometry budget exceeded');
    }
    for (let i = 0; i < vertexCount; i += 1) {
      const v = vertexStart + i;
      this.positions[v * 3] = position.getX(i);
      this.positions[v * 3 + 1] = position.getY(i);
      this.positions[v * 3 + 2] = position.getZ(i);
      this.normals[v * 3] = normal.getX(i);
      this.normals[v * 3 + 1] = normal.getY(i);
      this.normals[v * 3 + 2] = normal.getZ(i);
      this.anchors[v * 4] = anchor.getX(i);
      this.anchors[v * 4 + 1] = anchor.getY(i);
      this.anchors[v * 4 + 2] = anchor.getZ(i);
      this.anchors[v * 4 + 3] = anchor.getW(i);
      this.instances[v] = instance;
    }
    for (let i = 0; i < index.count; i += 1) {
      this.indices[this.indexCursor + i] = vertexStart + index.getX(i);
    }
    this.vertexCursor += vertexCount;
    this.indexCursor += index.count;
    const range = { vertexStart, vertexCount };
    this.ranges[instance] = range;
    return range;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const n = this.vertexCursor;
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions.subarray(0, n * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals.subarray(0, n * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    geometry.setAttribute('cityAnchor', new THREE.BufferAttribute(this.anchors.subarray(0, n * 4), 4));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors.subarray(0, n * 3), 3));
    geometry.setAttribute('cityInstance', new THREE.BufferAttribute(this.instances.subarray(0, n), 1));
    geometry.setIndex(new THREE.BufferAttribute(this.indices.subarray(0, this.indexCursor), 1));
    return geometry;
  }
}

/**
 * The mesh. Same per-instance surface as BatchedMesh / InstancedMesh where the
 * write path touches it -- setMatrixAt, getMatrixAt, setColorAt, instanceCount,
 * computeBoundingSphere -- so cityChunkWrite needs to know nothing about it.
 */
export class CitySlotMesh extends THREE.Mesh {
  readonly isCitySlotMesh = true;
  /**
   * Own field, as BatchedMesh and InstancedMesh have: three's frustum test
   * uses an object's sphere when it has one and the geometry's otherwise, and
   * the geometry's would be every chunk piled at the origin.
   */
  boundingSphere: THREE.Sphere | null = null;
  /** Sixteen floats per instance, three's batching layout. */
  readonly matricesData: Float32Array<ArrayBuffer>;
  readonly matricesTexture: THREE.DataTexture;
  readonly instanceCount: number;
  private readonly ranges: SlotVertexRange[];
  /** Largest chunk radius seated here; the sphere's margin around a position. */
  reach: number;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    ranges: SlotVertexRange[],
    reach: number,
  ) {
    super(geometry, material);
    this.ranges = ranges;
    this.instanceCount = ranges.length;
    this.reach = reach;
    let size = Math.sqrt(Math.max(1, this.instanceCount) * 4);
    size = Math.ceil(size / 4) * 4;
    size = Math.max(size, 4);
    this.matricesData = new Float32Array(new ArrayBuffer(size * size * 4 * 4)) as Float32Array<ArrayBuffer>;
    const texture = new THREE.DataTexture(this.matricesData, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    this.matricesTexture = texture;
    injectSlotTransform(material, texture);
    // The shadow pass uses its own depth material and knows nothing about
    // the attribute; without this every moving chunk would shadow from its
    // rest pose.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    injectSlotTransform(depth, texture);
    this.customDepthMaterial = depth;
  }

  setMatrixAt(instance: number, matrix: THREE.Matrix4): void {
    matrix.toArray(this.matricesData, instance * 16);
    this.matricesTexture.needsUpdate = true;
  }

  getMatrixAt(instance: number, matrix: THREE.Matrix4): THREE.Matrix4 {
    return matrix.fromArray(this.matricesData, instance * 16);
  }

  /** Visibility is the matrix: the write path scales a hidden chunk to zero. */
  setVisibleAt(): void {}

  /** Per-instance tint, baked into the vertex colour of that chunk's range. */
  setColorAt(instance: number, color: THREE.Color): void {
    const range = this.ranges[instance];
    if (!range) return;
    const attribute = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    for (let v = range.vertexStart; v < range.vertexStart + range.vertexCount; v += 1) {
      array[v * 3] = color.r;
      array[v * 3 + 1] = color.g;
      array[v * 3 + 2] = color.b;
    }
    attribute.needsUpdate = true;
  }

  /**
   * From the matrices, not the geometry: the geometry is every chunk in its
   * own local space, all around the origin.
   */
  computeBoundingSphere(): void {
    const sphere = this.boundingSphere ?? (this.boundingSphere = new THREE.Sphere());
    const data = this.matricesData;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.instanceCount; i += 1) {
      const at = i * 16;
      const x = data[at + 12], y = data[at + 13], z = data[at + 14];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) {
      sphere.makeEmpty();
      return;
    }
    sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let radius = 0;
    for (let i = 0; i < this.instanceCount; i += 1) {
      const at = i * 16;
      const dx = data[at + 12] - sphere.center.x;
      const dy = data[at + 13] - sphere.center.y;
      const dz = data[at + 14] - sphere.center.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius) radius = d;
    }
    sphere.radius = radius + this.reach;
  }

  dispose(): void {
    this.matricesTexture.dispose();
    (this.customDepthMaterial as THREE.Material | undefined)?.dispose();
  }
}
