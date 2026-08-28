/**
 * Reading the binary city manifest.
 *
 * The manifest is almost all numbers, and as JSON a 47,000-chunk city is 62 MB
 * of text. To get at it a browser had to hold, at the same moment, the
 * compressed bytes, a 62 MB string decoded out of them, and the object graph
 * `JSON.parse` built from that string. On a phone that peak ended the tab
 * before a single triangle was drawn — the page loaded, empty sky was fine, and
 * it died as the city came into view.
 *
 * This reads the numbers as numbers. The wire layout is structure-of-arrays
 * (see `destruction/src/manifest_binary.rs`), so every field is one contiguous
 * run and can be viewed rather than parsed: no intermediate string, no parser,
 * and no transient copy of the whole city.
 *
 * The decoded SHAPE is deliberately identical to what the JSON path produced.
 * Everything downstream — the mesh builder, the topology ledger — keeps reading
 * `structure.chunks[i].centroid` exactly as it did. That is what makes this
 * change reviewable: the format moved, the model did not.
 */
import type {
  CityManifest,
  ManifestBond,
  ManifestChunk,
  ManifestStructure,
  MaterialAppearance,
} from './manifest';

const MAGIC = 0x4d434c56; // "VLCM" little-endian
const FORMAT_VERSION = 1;
const GEOMETRY_CUBOID = 0;
const NO_SHAPE = 0xffffffff;

export function looksBinary(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  return new DataView(bytes).getUint32(0, true) === MAGIC;
}

/**
 * A cursor over the buffer.
 *
 * Typed-array views need their byte offset to be a multiple of the element
 * size, which the writer guarantees by keeping every section 4-byte aligned.
 * `f32Array`/`u32Array` therefore hand back views onto the received bytes with
 * no copy at all; the per-chunk objects below are the only allocation.
 */
class Cursor {
  private at = 0;

  constructor(private readonly buffer: ArrayBuffer) {}

  u32(): number {
    const value = new DataView(this.buffer).getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  f32Array(count: number): Float32Array {
    const view = new Float32Array(this.buffer, this.at, count);
    this.at += count * 4;
    return view;
  }

  u32Array(count: number): Uint32Array {
    const view = new Uint32Array(this.buffer, this.at, count);
    this.at += count * 4;
    return view;
  }

  bytes(count: number): Uint8Array {
    const view = new Uint8Array(this.buffer, this.at, count);
    this.at += count;
    return view;
  }
}

function vec3(source: Float32Array, index: number): [number, number, number] {
  const base = index * 3;
  return [source[base], source[base + 1], source[base + 2]];
}

export function decodeBinaryManifest(bytes: ArrayBuffer): CityManifest {
  if (!looksBinary(bytes)) {
    throw new Error('city manifest is not in the binary format');
  }
  const cursor = new Cursor(bytes);
  cursor.u32(); // magic, already checked
  const format = cursor.u32();
  if (format !== FORMAT_VERSION) {
    throw new Error(`unsupported binary city manifest format ${format}`);
  }
  const version = cursor.u32();
  const structureCount = cursor.u32();
  const materialCount = cursor.u32();
  const shapeCount = cursor.u32();
  const appearanceLength = cursor.u32();

  // The strength table is read by the solver, not the renderer, and the client
  // does not use it; skipped rather than materialised.
  cursor.f32Array(materialCount * 6);

  const shapeLibrary: number[][] = [];
  for (let i = 0; i < shapeCount; i += 1) {
    const length = cursor.u32();
    shapeLibrary.push(Array.from(cursor.f32Array(length)));
  }

  const structures: ManifestStructure[] = [];
  for (let i = 0; i < structureCount; i += 1) {
    structures.push(readStructure(cursor));
  }

  let materialAppearance: MaterialAppearance[] | undefined;
  if (appearanceLength > 0) {
    materialAppearance = JSON.parse(
      new TextDecoder().decode(cursor.bytes(appearanceLength)),
    ) as MaterialAppearance[];
  }

  const manifest: CityManifest = { version, structures };
  if (shapeLibrary.length > 0) manifest.shapeLibrary = shapeLibrary;
  if (materialAppearance) manifest.materialAppearance = materialAppearance;
  return manifest;
}

function readStructure(cursor: Cursor): ManifestStructure {
  const structureId = cursor.u32();
  const position = cursor.f32Array(3);
  const rotation = cursor.f32Array(4);
  const chunkCount = cursor.u32();
  const bondCount = cursor.u32();

  const nodeIndex = cursor.u32Array(chunkCount);
  const centroid = cursor.f32Array(chunkCount * 3);
  const mass = cursor.f32Array(chunkCount);
  const volume = cursor.f32Array(chunkCount);
  const size = cursor.f32Array(chunkCount * 3);
  const radius = cursor.f32Array(chunkCount);
  const material = cursor.u32Array(chunkCount);
  const support = cursor.u32Array(chunkCount);
  const kind = cursor.u32Array(chunkCount);
  const halfExtents = cursor.f32Array(chunkCount * 3);
  const shapeId = cursor.u32Array(chunkCount);
  const pointOffset = cursor.u32Array(chunkCount);
  const pointLength = cursor.u32Array(chunkCount);
  const inlinePoints = cursor.f32Array(cursor.u32());

  const chunks: ManifestChunk[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i += 1) {
    const chunk: ManifestChunk = {
      nodeIndex: nodeIndex[i],
      centroid: vec3(centroid, i),
      mass: mass[i],
      volume: volume[i],
      size: vec3(size, i),
      radius: radius[i],
      support: support[i] !== 0,
      geometry: kind[i] === GEOMETRY_CUBOID
        ? { kind: 'cuboid', halfExtents: vec3(halfExtents, i) }
        : {
          kind: 'convexHull',
          // Empty when the shard names a shape-library entry, exactly as the
          // JSON path had it; `resolveShapeLibrary` fills those in.
          points: pointLength[i] > 0
            ? Array.from(
              inlinePoints.subarray(pointOffset[i], pointOffset[i] + pointLength[i]),
            )
            : [],
          ...(shapeId[i] !== NO_SHAPE ? { shapeId: shapeId[i] } : {}),
        },
    };
    // Omitted rather than zero, matching the JSON the server skips, so nothing
    // downstream can tell the two paths apart.
    if (material[i] !== 0) chunk.material = material[i];
    chunks[i] = chunk;
  }

  const bondIndex = cursor.u32Array(bondCount);
  const node0 = cursor.u32Array(bondCount);
  const node1 = cursor.u32Array(bondCount);
  const bondCentroid = cursor.f32Array(bondCount * 3);
  const normal = cursor.f32Array(bondCount * 3);
  const area = cursor.f32Array(bondCount);
  cursor.u32Array(bondCount); // bond material: solver-side, unused by the client

  const bonds: ManifestBond[] = new Array(bondCount);
  for (let i = 0; i < bondCount; i += 1) {
    bonds[i] = {
      bondIndex: bondIndex[i],
      node0: node0[i],
      node1: node1[i],
      centroid: vec3(bondCentroid, i),
      normal: vec3(normal, i),
      area: area[i],
    };
  }

  return {
    structureId,
    worldPosition: [position[0], position[1], position[2]],
    worldRotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    chunks,
    bonds,
  };
}
