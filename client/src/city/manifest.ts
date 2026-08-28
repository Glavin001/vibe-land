// City destruction manifest: fetch, hash-verify, and parse into typed arrays.
//
// The server serves canonical JSON (Content-Encoding: gzip — the browser
// decompresses transparently) content-addressed by the SHA-256 of the raw
// JSON bytes, so the decompressed body hashes to the URL hash.

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
}

export interface ManifestStructure {
  structureId: number;
  worldPosition: [number, number, number];
  worldRotation: [number, number, number, number];
  chunks: ManifestChunk[];
  bonds: ManifestBond[];
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
async function parseCityManifest(
  bytes: ArrayBuffer,
  expectedHashHex: string,
): Promise<LoadedCityManifest> {
  const hashHex = await sha256Hex(bytes);
  if (hashHex !== expectedHashHex) {
    throw new Error(`city manifest hash mismatch: got ${hashHex}, expected ${expectedHashHex}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CityManifest;
  if (manifest.version !== 1) {
    throw new Error(`unsupported city manifest version ${manifest.version}`);
  }
  resolveShapeLibrary(manifest);
  let totalChunks = 0;
  let totalBonds = 0;
  for (const structure of manifest.structures) {
    totalChunks += structure.chunks.length;
    totalBonds += structure.bonds.length;
  }
  return { manifest, hashHex, totalChunks, totalBonds };
}
