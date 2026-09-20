// The city's chunks, composed on the GPU.
//
// A chunk's world pose is `body_pose ∘ body_local_offset` -- the wire
// contract, and what the ledger holds. The renderer used to compose that on
// the CPU for every moving chunk every frame and hand the GPU a matrix per
// chunk: at 20k chunks awake that was 20-40 ms of a frame in composes,
// matrix writes and buffer uploads, and it scaled with the number of CHUNKS
// moving. What actually changes each frame is the BODY poses -- there are
// several chunks per body, and one pose per body is all the stream carries.
//
// So the CPU now writes two small textures and nothing else:
//
//   chunk records  one per slot, rewritten only when the ledger reassigns the
//                  slot's body or offset (a fracture, a migration, a rebase):
//                  [bodyIndex, lx, ly, lz] [qx, qy, qz, qw]
//   body poses     one per body, rewritten when the body moves (the same
//                  distance stride as before decides how often):
//                  [px, py, pz, tint] [qx, qy, qz, qw] [r, g, b, -] [-]
//                  (the colour texel is read only while BODY COLORS is on)
//
// and the vertex shader composes the matrix from the two. Every vertex of the
// merged cell geometry carries its slot id, so a cell is ONE indexed draw in
// every pass however many of its chunks are moving -- the property that took
// the M3's destruction-scaled GPU cost away (a multi-draw sub-draw per woken
// chunk costs ~1.3 us there; see git history for cityShell.ts).
//
// Hiding a chunk that has sunk below the ground is the shader's decision too:
// a composed centre below CHUNK_HIDE_Y_M collapses the chunk to a point.

import * as THREE from 'three';

/**
 * Depth below which a chunk cannot be poking through the flat y=0 ground no
 * matter its size or orientation, so drawing it is pure waste.
 */
export const CHUNK_HIDE_Y_M = -4;

export type CityRenderable = { kind: 'slots'; mesh: CitySlotMesh };

const FLOATS_PER_BODY = 16;
const FLOATS_PER_CHUNK = 8;

function textureSideFor(texels: number): number {
  let size = Math.sqrt(Math.max(4, texels));
  size = Math.ceil(size / 4) * 4;
  return Math.max(size, 4);
}

function makeFloatTexture(side: number): { data: Float32Array<ArrayBuffer>; texture: THREE.DataTexture } {
  const data = new Float32Array(new ArrayBuffer(side * side * 4 * 4)) as Float32Array<ArrayBuffer>;
  const texture = new THREE.DataTexture(data, side, side, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return { data, texture };
}

/**
 * The two textures and the bookkeeping that keeps them true.
 *
 * Body indices are handed out as bodies are first written and given back only
 * once the body is gone AND no chunk record points at it any more, so a stale
 * record (a chunk orphaned by a retire, drawn at its last pose until it is
 * adopted -- the same behaviour the CPU path had) can never be read against
 * some other body that inherited the index.
 */
export class CityGpuPoses {
  readonly chunkCount: number;
  readonly chunkData: Float32Array<ArrayBuffer>;
  readonly chunkTexture: THREE.DataTexture;
  bodyData: Float32Array<ArrayBuffer>;
  bodyTexture: THREE.DataTexture;
  bodyCapacity: number;
  /** Slot -> body index its record names, or -1 before its first record. */
  readonly bodyIndexOfSlot: Int32Array;
  /** Slot -> |local offset| + chunk radius: how far a chunk can be from its body's origin. */
  readonly reachOfSlot: Float32Array;
  private readonly indexOfBody = new Map<number, number>();
  private readonly bodyOfIndex: number[] = [];
  private readonly recordsOnIndex: number[] = [];
  private readonly freeIndices: number[] = [];
  /** Indices whose body is gone; released once their record count reaches zero. */
  private readonly retiringIndices = new Set<number>();
  private nextIndex = 0;
  private chunkDirty = false;
  private bodyDirty = false;
  /** Materials hold the body texture as a uniform; a grown texture is a new object. */
  private readonly textureListeners = new Set<(texture: THREE.DataTexture) => void>();
  /** 1 while the debug palette colours bodies, so the shader fetches the colour texel. */
  readonly bodyColoursUniform = { value: 0 };

  constructor(chunkCount: number, radii: Float32Array) {
    this.chunkCount = chunkCount;
    const chunkSide = textureSideFor(chunkCount * (FLOATS_PER_CHUNK / 4));
    const chunk = makeFloatTexture(chunkSide);
    this.chunkData = chunk.data;
    this.chunkTexture = chunk.texture;
    this.bodyCapacity = 4096;
    const body = makeFloatTexture(textureSideFor(this.bodyCapacity * (FLOATS_PER_BODY / 4)));
    this.bodyData = body.data;
    this.bodyTexture = body.texture;
    this.bodyIndexOfSlot = new Int32Array(chunkCount).fill(-1);
    this.reachOfSlot = new Float32Array(chunkCount);
    for (let slot = 0; slot < chunkCount; slot += 1) this.reachOfSlot[slot] = radii[slot];
  }

  /** The index a body writes at, allocating on first sight. */
  bodyIndexFor(key: number): number {
    const existing = this.indexOfBody.get(key);
    if (existing !== undefined) return existing;
    let index: number;
    if (this.freeIndices.length > 0) {
      index = this.freeIndices.pop()!;
    } else {
      index = this.nextIndex;
      this.nextIndex += 1;
      if (index >= this.bodyCapacity) this.growBodies();
    }
    this.indexOfBody.set(key, index);
    this.bodyOfIndex[index] = key;
    this.recordsOnIndex[index] = this.recordsOnIndex[index] ?? 0;
    return index;
  }

  hasBody(key: number): boolean {
    return this.indexOfBody.has(key);
  }

  private growBodies(): void {
    const capacity = this.bodyCapacity * 2;
    const grown = makeFloatTexture(textureSideFor(capacity * (FLOATS_PER_BODY / 4)));
    grown.data.set(this.bodyData.subarray(0, this.bodyCapacity * FLOATS_PER_BODY));
    this.bodyTexture.dispose();
    this.bodyData = grown.data;
    this.bodyTexture = grown.texture;
    this.bodyCapacity = capacity;
    this.bodyDirty = true;
    for (const listener of this.textureListeners) listener(this.bodyTexture);
  }

  onBodyTextureReplaced(listener: (texture: THREE.DataTexture) => void): () => void {
    this.textureListeners.add(listener);
    return () => this.textureListeners.delete(listener);
  }

  /**
   * A body the ledger no longer has. Its index is reused only once no chunk
   * record names it.
   */
  releaseBody(key: number): void {
    const index = this.indexOfBody.get(key);
    if (index === undefined) return;
    this.indexOfBody.delete(key);
    this.bodyOfIndex[index] = -1;
    if ((this.recordsOnIndex[index] ?? 0) > 0) this.retiringIndices.add(index);
    else this.freeIndices.push(index);
  }

  writeBody(
    index: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    tint: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const at = index * FLOATS_PER_BODY;
    const data = this.bodyData;
    data[at] = position[0];
    data[at + 1] = position[1];
    data[at + 2] = position[2];
    data[at + 3] = tint;
    data[at + 4] = rotation[0];
    data[at + 5] = rotation[1];
    data[at + 6] = rotation[2];
    data[at + 7] = rotation[3];
    data[at + 8] = r;
    data[at + 9] = g;
    data[at + 10] = b;
    data[at + 11] = 0;
    this.bodyDirty = true;
  }

  /** Where the body at `index` was last written, for the sphere refresh. */
  bodyPositionAt(index: number, out: Float32Array): void {
    const at = index * FLOATS_PER_BODY;
    out[0] = this.bodyData[at];
    out[1] = this.bodyData[at + 1];
    out[2] = this.bodyData[at + 2];
  }

  writeChunk(
    slot: number,
    bodyIndex: number,
    local: Float32Array,
    localRot: Float32Array,
    radius: number,
  ): void {
    const previous = this.bodyIndexOfSlot[slot];
    if (previous !== bodyIndex) {
      if (previous >= 0) {
        this.recordsOnIndex[previous] -= 1;
        if (this.recordsOnIndex[previous] === 0 && this.retiringIndices.has(previous)) {
          this.retiringIndices.delete(previous);
          this.freeIndices.push(previous);
        }
      }
      this.recordsOnIndex[bodyIndex] = (this.recordsOnIndex[bodyIndex] ?? 0) + 1;
      this.bodyIndexOfSlot[slot] = bodyIndex;
    }
    const at = slot * FLOATS_PER_CHUNK;
    const data = this.chunkData;
    data[at] = bodyIndex;
    data[at + 1] = local[0];
    data[at + 2] = local[1];
    data[at + 3] = local[2];
    data[at + 4] = localRot[0];
    data[at + 5] = localRot[1];
    data[at + 6] = localRot[2];
    data[at + 7] = localRot[3];
    this.reachOfSlot[slot] = Math.sqrt(local[0] * local[0] + local[1] * local[1] + local[2] * local[2]) + radius;
    this.chunkDirty = true;
  }

  /** Composes one chunk's drawn centre on the CPU, exactly as the shader does. Diagnostics only. */
  chunkWorldPositionInto(slot: number, out: Float32Array, at = 0): boolean {
    const index = this.bodyIndexOfSlot[slot];
    if (index < 0) return false;
    const c = slot * FLOATS_PER_CHUNK;
    const b = index * FLOATS_PER_BODY;
    const lx = this.chunkData[c + 1];
    const ly = this.chunkData[c + 2];
    const lz = this.chunkData[c + 3];
    const qx = this.bodyData[b + 4];
    const qy = this.bodyData[b + 5];
    const qz = this.bodyData[b + 6];
    const qw = this.bodyData[b + 7];
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    const cx = qy * lz - qz * ly + qw * lx;
    const cy = qz * lx - qx * lz + qw * ly;
    const cz = qx * ly - qy * lx + qw * lz;
    out[at] = this.bodyData[b] + lx + 2 * (qy * cz - qz * cy);
    out[at + 1] = this.bodyData[b + 1] + ly + 2 * (qz * cx - qx * cz);
    out[at + 2] = this.bodyData[b + 2] + lz + 2 * (qx * cy - qy * cx);
    return true;
  }

  /** Flag whatever changed for upload. Once per frame, after all writes. */
  upload(): void {
    if (this.chunkDirty) {
      this.chunkTexture.needsUpdate = true;
      this.chunkDirty = false;
    }
    if (this.bodyDirty) {
      this.bodyTexture.needsUpdate = true;
      this.bodyDirty = false;
    }
  }

  dispose(): void {
    this.chunkTexture.dispose();
    this.bodyTexture.dispose();
  }
}

const SLOT_PARS = `
attribute float citySlot;
uniform highp sampler2D cityChunks;
uniform highp sampler2D cityBodies;
uniform float cityHideY;
uniform float cityBodyColours;
vec3 vCityTintScratch;
vec4 cityTexel( sampler2D tex, int texel ) {
  int size = textureSize( tex, 0 ).x;
  return texelFetch( tex, ivec2( texel % size, texel / size ), 0 );
}
vec4 cityQuatMul( vec4 a, vec4 b ) {
  return vec4( a.w * b.xyz + b.w * a.xyz + cross( a.xyz, b.xyz ), a.w * b.w - dot( a.xyz, b.xyz ) );
}
vec3 cityQuatRotate( vec4 q, vec3 v ) {
  return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}
mat4 citySlotMatrix() {
  int slot = int( citySlot );
  vec4 record0 = cityTexel( cityChunks, slot * 2 );
  vec4 record1 = cityTexel( cityChunks, slot * 2 + 1 );
  int body = int( record0.x );
  vec4 body0 = cityTexel( cityBodies, body * 4 );
  vec4 body1 = cityTexel( cityBodies, body * 4 + 1 );
  vec4 q = normalize( cityQuatMul( body1, record1 ) );
  vec3 p = body0.xyz + cityQuatRotate( body1, record0.yzw );
  float s = ( p.y < cityHideY || body < 0 ) ? 0.0 : 1.0;
  // The third texel is the debug palette; a dependent fetch per vertex is
  // only paid while BODY COLORS is on.
  vCityTintScratch = cityBodyColours > 0.5
    ? cityTexel( cityBodies, body * 4 + 2 ).rgb * body0.w
    : vec3( body0.w );
  float xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
  float xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
  float wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
  return mat4(
    vec4( ( 1.0 - 2.0 * ( yy + zz ) ) * s, ( 2.0 * ( xy + wz ) ) * s, ( 2.0 * ( xz - wy ) ) * s, 0.0 ),
    vec4( ( 2.0 * ( xy - wz ) ) * s, ( 1.0 - 2.0 * ( xx + zz ) ) * s, ( 2.0 * ( yz + wx ) ) * s, 0.0 ),
    vec4( ( 2.0 * ( xz + wy ) ) * s, ( 2.0 * ( yz - wx ) ) * s, ( 1.0 - 2.0 * ( xx + yy ) ) * s, 0.0 ),
    vec4( p, 1.0 )
  );
}
`;

/**
 * Teach a material to place each vertex by its chunk's composed pose.
 *
 * Wraps whatever `onBeforeCompile` the material already has (the triplanar
 * concrete injects there too) and runs after it, inserting the transform
 * right behind `begin_vertex` / `beginnormal_vertex`, before anything that
 * reads `transformed`. `CITY_SLOTS` is defined so the concrete's vertex body
 * takes its baked-anchor branch, as it did under USE_BATCHING. The body's
 * tint (settled rubble is dimmer; the debug palette colours by body) rides a
 * varying into the fragment shader when the material has one.
 */
const injected = new WeakSet<THREE.Material>();

export function injectSlotTransform(material: THREE.Material, poses: CityGpuPoses): void {
  // The textures are city-wide, so one material serves every cell -- and
  // three then skips the uniform re-upload between consecutive draws of it,
  // which with a material per cell was most of the submit cost.
  if (injected.has(material)) return;
  injected.add(material);
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.defines = { ...(material.defines ?? {}), CITY_SLOTS: '' };
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    const bodies = { value: poses.bodyTexture };
    poses.onBodyTextureReplaced((texture) => { bodies.value = texture; });
    shader.uniforms.cityChunks = { value: poses.chunkTexture };
    shader.uniforms.cityBodies = bodies;
    shader.uniforms.cityHideY = { value: CHUNK_HIDE_Y_M };
    shader.uniforms.cityBodyColours = poses.bodyColoursUniform;
    const shaded = shader.fragmentShader.includes('#include <color_fragment>');
    shader.vertexShader = SLOT_PARS + (shaded ? 'varying vec3 vCityTint;\n' : '') + shader.vertexShader;
    if (shader.vertexShader.includes('#include <beginnormal_vertex>')) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  objectNormal = mat3( citySlotMatrix() ) * objectNormal;',
      );
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed = ( citySlotMatrix() * vec4( transformed, 1.0 ) ).xyz;'
        + (shaded ? '\n  vCityTint = vCityTintScratch;' : ''),
    );
    if (shaded) {
      shader.fragmentShader = 'varying vec3 vCityTint;\n' + shader.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  diffuseColor.rgb *= vCityTint;',
      );
    }
  };
  material.customProgramCacheKey = () => `${previousKey.call(material)}-city-slots-v2`;
}

/**
 * Accumulates member geometries, in their own local space, into one buffer,
 * tagging every vertex with its chunk's slot. Scale is baked into the
 * vertices (boxes carry their extents as scale), so every record is unit
 * scale.
 *
 * Callers append each slot's geometry AFTER `bakeRestAnchors` has run on it:
 * the anchor is what the concrete is mapped by, and it is copied verbatim so
 * a chunk shades exactly as the batched path shaded it.
 */
export class SlotGeometryBuilder {
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  private readonly anchors: Float32Array;
  private readonly slots: Float32Array;
  private readonly indices: Uint32Array;
  private vertexCursor = 0;
  private indexCursor = 0;

  constructor(vertexBudget: number, indexBudget: number) {
    this.positions = new Float32Array(vertexBudget * 3);
    this.normals = new Float32Array(vertexBudget * 3);
    this.anchors = new Float32Array(vertexBudget * 4);
    this.slots = new Float32Array(vertexBudget);
    this.indices = new Uint32Array(indexBudget);
  }

  append(geometry: THREE.BufferGeometry, slot: number, sx: number, sy: number, sz: number): void {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const anchor = geometry.getAttribute('cityAnchor');
    const index = geometry.getIndex();
    if (!index) throw new Error('slot members are always indexed (normalizeForBatching)');
    const vertexStart = this.vertexCursor;
    const vertexCount = position.count;
    if (vertexStart + vertexCount > this.slots.length
      || this.indexCursor + index.count > this.indices.length) {
      throw new Error('slot geometry budget exceeded');
    }
    for (let i = 0; i < vertexCount; i += 1) {
      const v = vertexStart + i;
      this.positions[v * 3] = position.getX(i) * sx;
      this.positions[v * 3 + 1] = position.getY(i) * sy;
      this.positions[v * 3 + 2] = position.getZ(i) * sz;
      this.normals[v * 3] = normal.getX(i);
      this.normals[v * 3 + 1] = normal.getY(i);
      this.normals[v * 3 + 2] = normal.getZ(i);
      this.anchors[v * 4] = anchor.getX(i);
      this.anchors[v * 4 + 1] = anchor.getY(i);
      this.anchors[v * 4 + 2] = anchor.getZ(i);
      this.anchors[v * 4 + 3] = anchor.getW(i);
      this.slots[v] = slot;
    }
    for (let i = 0; i < index.count; i += 1) {
      this.indices[this.indexCursor + i] = vertexStart + index.getX(i);
    }
    this.vertexCursor += vertexCount;
    this.indexCursor += index.count;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const n = this.vertexCursor;
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions.subarray(0, n * 3), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals.subarray(0, n * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    geometry.setAttribute('cityAnchor', new THREE.BufferAttribute(this.anchors.subarray(0, n * 4), 4));
    geometry.setAttribute('citySlot', new THREE.BufferAttribute(this.slots.subarray(0, n), 1));
    geometry.setIndex(new THREE.BufferAttribute(this.indices.subarray(0, this.indexCursor), 1));
    return geometry;
  }
}

const TMP_BODY_POS = new Float32Array(3);

/** One cell's chunks: a single draw, culled as a cell. */
export class CitySlotMesh extends THREE.Mesh {
  readonly isCitySlotMesh = true;
  /**
   * Own field, as BatchedMesh and InstancedMesh have: three's frustum test
   * uses an object's sphere when it has one and the geometry's otherwise, and
   * the geometry's would be every chunk piled at the origin.
   */
  boundingSphere: THREE.Sphere | null = null;
  readonly slots: number[];
  private readonly poses: CityGpuPoses;
  /** Centre the sphere grows from: the cell's footprint when it was built. */
  private readonly centre = new THREE.Vector3();

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    depth: THREE.Material,
    poses: CityGpuPoses,
    slots: number[],
  ) {
    super(geometry, material);
    this.poses = poses;
    this.slots = slots;
    injectSlotTransform(material, poses);
    // The shadow pass uses its own depth material and knows nothing about
    // the attribute; without this every moving chunk would shadow from its
    // rest pose. Shared across cells like the surface material.
    injectSlotTransform(depth, poses);
    this.customDepthMaterial = depth;
  }

  /** Fix the sphere's centre from where the chunks are now; call once, after the first records. */
  anchorSphere(): void {
    let x = 0, y = 0, z = 0, n = 0;
    for (const slot of this.slots) {
      if (!this.poses.chunkWorldPositionInto(slot, TMP_BODY_POS)) continue;
      x += TMP_BODY_POS[0]; y += TMP_BODY_POS[1]; z += TMP_BODY_POS[2]; n += 1;
    }
    if (n > 0) this.centre.set(x / n, y / n, z / n);
    this.computeBoundingSphere();
  }

  /**
   * A sphere that is never too small: every chunk's body origin plus how far
   * the chunk can be from it, on every call. Reads the body texture the GPU
   * reads, so it describes what is drawn.
   */
  computeBoundingSphere(): void {
    const sphere = this.boundingSphere ?? (this.boundingSphere = new THREE.Sphere());
    sphere.center.copy(this.centre);
    const poses = this.poses;
    let radius = 0;
    let any = false;
    for (const slot of this.slots) {
      const index = poses.bodyIndexOfSlot[slot];
      if (index < 0) continue;
      poses.bodyPositionAt(index, TMP_BODY_POS);
      const dx = TMP_BODY_POS[0] - sphere.center.x;
      const dy = TMP_BODY_POS[1] - sphere.center.y;
      const dz = TMP_BODY_POS[2] - sphere.center.z;
      const need = Math.sqrt(dx * dx + dy * dy + dz * dz) + poses.reachOfSlot[slot];
      if (need > radius) radius = need;
      any = true;
    }
    if (!any) {
      sphere.makeEmpty();
      return;
    }
    sphere.radius = radius;
  }

  /** Materials are shared across cells; the layer disposes them with the mesh state. */
  dispose(): void {}
}
