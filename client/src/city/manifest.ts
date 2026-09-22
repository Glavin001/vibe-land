// City destruction manifest: fetch, hash-verify, and decode.
//
// The payload is binary (see `manifestBinary.ts`), gzipped on the wire, and
// content-addressed by the SHA-256 of the decompressed bytes so the body
// hashes to the URL hash. It used to be JSON, which a phone could not afford:
// a 47,000-chunk city ran to 62 MB of text, and reading it meant holding the
// bytes, a string of them and the parsed objects at once.
//
// JSON is still accepted on the read side. A client can outlive the server it
// was built against, and the two formats are told apart by four magic bytes.

import { decodeBinaryManifest, looksBinary } from './manifestBinary';

export interface ChunkGeometryCuboid {
  // Server serde emits camelCase enum tags ("cuboid"); accept both.
  kind: 'Cuboid' | 'cuboid';
  halfExtents: [number, number, number];
  /** Legacy snake_case spelling from servers before the serde variant fix. */
  half_extents?: [number, number, number];
}

export interface ChunkGeometryConvexHull {
  kind: 'ConvexHull' | 'convexHull';
  points: number[];
  /**
   * Shape-library id, when the pack's fracturer bounded its pattern count.
   *
   * Authored identity: the fracturer knew it was stamping cell `c` of pattern
   * `k` onto a panel of a given class, so it named the shape as it cut it. Two
   * chunks with the same id are the same solid, stated rather than deduced --
   * which is what lets the renderer instance them without comparing geometry.
   * Absent on packs whose shards are all one-of-a-kind.
   */
  shapeId?: number;
}

export type ChunkGeometry = ChunkGeometryCuboid | ChunkGeometryConvexHull;

export function isCuboidGeometry(geometry: ChunkGeometry): geometry is ChunkGeometryCuboid {
  return geometry.kind === 'Cuboid' || geometry.kind === 'cuboid';
}

export function isConvexHullGeometry(
  geometry: ChunkGeometry,
): geometry is ChunkGeometryConvexHull {
  return geometry.kind === 'ConvexHull' || geometry.kind === 'convexHull';
}

/**
 * Half extents of a cuboid chunk, or null for any other geometry.
 *
 * Never destructure `geometry.halfExtents` directly: a server that has not
 * picked up the serde per-variant `rename_all` fix serves `half_extents`, and
 * destructuring `undefined` throws and aborts the entire chunk mesh build.
 */
export function cuboidHalfExtents(
  geometry: ChunkGeometry,
): [number, number, number] | null {
  if (!isCuboidGeometry(geometry)) {
    return null;
  }
  const extents = geometry.halfExtents ?? geometry.half_extents;
  return Array.isArray(extents) && extents.length === 3 ? extents : null;
}

export interface ManifestChunk {
  nodeIndex: number;
  centroid: [number, number, number];
  mass: number;
  volume: number;
  size: [number, number, number];
  geometry: ChunkGeometryCuboid | ChunkGeometryConvexHull;
  radius: number;
  support: boolean;
  /**
   * Index into `CityManifest.materialAppearance` — the chunk's OWN material.
   *
   * Absent on every pack that does not author per-node material, which is all
   * of them but the hand-authored structures; the server skips the field when
   * it is 0 so those manifests keep their content hash.
   */
  material?: number;
}

export interface ManifestBond {
  bondIndex: number;
  node0: number;
  node1: number;
  centroid: [number, number, number];
  normal: [number, number, number];
  area: number;
  /** Index into the strength/appearance tables. Absent (= 0) on every pack that does not author it. */
  material?: number;
}

export interface ManifestStructure {
  structureId: number;
  worldPosition: [number, number, number];
  worldRotation: [number, number, number, number];
  chunks: ManifestChunk[];
  /**
   * Bonds as objects. Present only on the legacy JSON path.
   *
   * A city of 190,000 bonds spent tens of megabytes on objects holding two
   * 3-vectors apiece. The binary path supplies every bond field as a typed
   * array view onto the received buffer instead and leaves this undefined;
   * read endpoints through `bondEndpoints` and the rest through
   * `bondGeometry`, which derive and cache the same views on the JSON path.
   */
  bonds?: ManifestBond[];
  bondCount?: number;
  bondNode0?: Uint32Array;
  bondNode1?: Uint32Array;
  /**
   * Where each bond sits, structure-local, xyz per bond. The destruction dust
   * is born here: a broken bond's centroid is the one exact position the wire
   * never carries and the manifest always had.
   */
  bondCentroid?: Float32Array;
  /** Outward face direction per bond, xyz. Dust is seeded a little way along it. */
  bondNormal?: Float32Array;
  /** Contact area, m² (downtown median 0.18). Sum over a break = how much material let go. */
  bondArea?: Float32Array;
  /** Index into `CityManifest.materialStrength` / `materialAppearance`. */
  bondMaterial?: Uint32Array;
}

/** How many bonds a structure has, whichever path delivered it. */
export function bondCountOf(structure: ManifestStructure): number {
  return structure.bondCount ?? structure.bonds?.length ?? 0;
}

/**
 * Bond endpoints as typed arrays.
 *
 * Free on the binary path, which already has them. Derived once and cached on
 * the structure for the JSON path, so a caller does not have to know which it
 * is holding.
 */
export function bondEndpoints(
  structure: ManifestStructure,
): { node0: Uint32Array; node1: Uint32Array } {
  if (!structure.bondNode0 || !structure.bondNode1) {
    const bonds = structure.bonds ?? [];
    const node0 = new Uint32Array(bonds.length);
    const node1 = new Uint32Array(bonds.length);
    for (let i = 0; i < bonds.length; i += 1) {
      node0[i] = bonds[i].node0;
      node1[i] = bonds[i].node1;
    }
    structure.bondNode0 = node0;
    structure.bondNode1 = node1;
    structure.bondCount = bonds.length;
  }
  return { node0: structure.bondNode0, node1: structure.bondNode1 };
}

/**
 * Bond centroid / normal / area / material as typed arrays.
 *
 * Free on the binary path, which keeps them as views onto the received buffer.
 * Derived once and cached on the structure for the JSON path, exactly as
 * `bondEndpoints` does, so no consumer needs to know which it is holding.
 */
export function bondGeometry(
  structure: ManifestStructure,
): { centroid: Float32Array; normal: Float32Array; area: Float32Array; material: Uint32Array } {
  if (
    !structure.bondCentroid
    || !structure.bondNormal
    || !structure.bondArea
    || !structure.bondMaterial
  ) {
    const bonds = structure.bonds ?? [];
    const centroid = new Float32Array(bonds.length * 3);
    const normal = new Float32Array(bonds.length * 3);
    const area = new Float32Array(bonds.length);
    const material = new Uint32Array(bonds.length);
    for (let i = 0; i < bonds.length; i += 1) {
      const bond = bonds[i];
      centroid[i * 3] = bond.centroid[0];
      centroid[i * 3 + 1] = bond.centroid[1];
      centroid[i * 3 + 2] = bond.centroid[2];
      normal[i * 3] = bond.normal[0];
      normal[i * 3 + 1] = bond.normal[1];
      normal[i * 3 + 2] = bond.normal[2];
      area[i] = bond.area;
      material[i] = bond.material ?? 0;
    }
    structure.bondCentroid = centroid;
    structure.bondNormal = normal;
    structure.bondArea = area;
    structure.bondMaterial = material;
  }
  return {
    centroid: structure.bondCentroid,
    normal: structure.bondNormal,
    area: structure.bondArea,
    material: structure.bondMaterial,
  };
}

export interface CityManifest {
  version: number;
  structures: ManifestStructure[];
  /**
   * Distinct shard hulls, stored once and referenced by `geometry.shapeId`.
   *
   * Present when the pack was authored with a bounded fracture-pattern count.
   * `resolveShapeLibrary` folds it back into the chunks at parse time, so
   * nothing downstream has to know it existed.
   */
  shapeLibrary?: number[][];
  /**
   * How each material looks, parallel to the solver's strength table.
   *
   * Advisory and usually absent: the city's own packs are all one concrete and
   * get their variety from hashing a building id into the texture array. An
   * authored structure says what its pieces are made of, which is what lets
   * them be shaded as brick or steel or glass.
   */
  materialAppearance?: MaterialAppearance[];
  /**
   * The solver's strength table, six floats per material in MPa:
   * compression elastic/fatal, tension elastic/fatal, shear elastic/fatal.
   * Parallel to `materialAppearance`. Binary path only; the JSON path never
   * carried it.
   */
  materialStrength?: Float32Array;
}

/** Presence of `opacity` is what marks a material transparent. */
export interface MaterialAppearance {
  name?: string;
  color?: string;
  opacity?: number;
  textureKey?: string;
  roughness?: number;
  metalness?: number;
}

export interface LoadedCityManifest {
  manifest: CityManifest;
  hashHex: string;
  totalChunks: number;
  totalBonds: number;
}

/**
 * Point every library-referencing chunk at the library's own array.
 *
 * Resolved once here rather than at every read, so `chunkShape` and everything
 * downstream keep seeing an ordinary inline hull.
 *
 * The chunks SHARE the array rather than each getting a copy. That is the whole
 * point: a thousand shards drawing shape 7 hold one points array between them,
 * so the saving is memory as well as download. Nothing mutates chunk geometry
 * after load -- `buildHullGeometry` only reads -- so the sharing is safe.
 *
 * A dangling reference throws. The alternative is a chunk silently drawn and
 * collided as some other shard's shape, which is invisible until someone
 * notices the wrong rubble.
 */
export function resolveShapeLibrary(manifest: CityManifest): void {
  const library = manifest.shapeLibrary;
  if (!library || library.length === 0) return;
  for (const structure of manifest.structures) {
    for (const chunk of structure.chunks) {
      const geometry = chunk.geometry;
      if (!isConvexHullGeometry(geometry)) continue;
      const id = geometry.shapeId;
      if (id === undefined) continue;
      const points = library[id];
      if (!points) {
        throw new Error(
          `city manifest chunk ${chunk.nodeIndex} references shape ${id}, `
            + `library has ${library.length}`,
        );
      }
      geometry.points = points;
    }
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchCityManifest(
  baseUrl: string,
  expectedHashHex: string,
): Promise<LoadedCityManifest> {
  const response = await fetch(`${baseUrl}/city-manifest/${expectedHashHex}`);
  if (!response.ok) {
    throw new Error(`city manifest fetch failed: ${response.status}`);
  }
  return parseCityManifest(await response.arrayBuffer(), expectedHashHex);
}

/**
 * The same manifest, delivered over the game session instead of fetched.
 *
 * A rented GPU box cannot serve this over HTTP to an HTTPS page -- plain HTTP
 * on a random port is mixed content, and its self-signed origin is refused --
 * so the server pushes it down the connection that is already open. Gzipped on
 * the wire because the uncompressed JSON runs to megabytes on a large city.
 */
export async function decodeCityManifestPayload(
  gzipped: Uint8Array,
  expectedHashHex: string,
): Promise<LoadedCityManifest> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompression) {
    throw new Error('DecompressionStream unavailable; cannot read pushed city manifest');
  }
  const stream = new Blob([gzipped as BlobPart]).stream().pipeThrough(new Decompression('gzip'));
  const bytes = await new Response(stream).arrayBuffer();
  return parseCityManifest(bytes, expectedHashHex);
}

/**
 * Verification is deliberately identical for both paths: the manifest is
 * content-addressed, so a mismatched hash means the geometry does not match the
 * simulation and every chunk id that follows would refer to the wrong thing.
 */
/** The same parse from bytes already in hand: offline tape replays. */
export function parseCityManifestBytes(
  bytes: ArrayBuffer,
  expectedHashHex: string,
): Promise<LoadedCityManifest> {
  return parseCityManifest(bytes, expectedHashHex);
}

async function parseCityManifest(
  bytes: ArrayBuffer,
  expectedHashHex: string,
): Promise<LoadedCityManifest> {
  const hashHex = await sha256Hex(bytes);
  if (hashHex !== expectedHashHex) {
    throw new Error(`city manifest hash mismatch: got ${hashHex}, expected ${expectedHashHex}`);
  }
  // Binary is what the server sends now. JSON is still read, because a client
  // can outlive a server it was built against and the two are trivially told
  // apart by their first four bytes -- which is why the format carries a magic
  // rather than a version field that would have to be parsed to be reached.
  const manifest = looksBinary(bytes)
    ? decodeBinaryManifest(bytes)
    : (JSON.parse(new TextDecoder().decode(bytes)) as CityManifest);
  if (manifest.version !== 1) {
    throw new Error(`unsupported city manifest version ${manifest.version}`);
  }
  resolveShapeLibrary(manifest);
  let totalChunks = 0;
  let totalBonds = 0;
  for (const structure of manifest.structures) {
    totalChunks += structure.chunks.length;
    totalBonds += bondCountOf(structure);
  }
  return { manifest, hashHex, totalChunks, totalBonds };
}
