// City destruction manifest: fetch, hash-verify, and parse into typed arrays.
//
// The server serves canonical JSON (Content-Encoding: gzip — the browser
// decompresses transparently) content-addressed by the SHA-256 of the raw
// JSON bytes, so the decompressed body hashes to the URL hash.

export interface ChunkGeometryCuboid {
  kind: 'Cuboid';
  halfExtents: [number, number, number];
}

export interface ChunkGeometryConvexHull {
  kind: 'ConvexHull';
  points: number[];
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
}

export interface LoadedCityManifest {
  manifest: CityManifest;
  hashHex: string;
  totalChunks: number;
  totalBonds: number;
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
  const bytes = await response.arrayBuffer();
  const hashHex = await sha256Hex(bytes);
  if (hashHex !== expectedHashHex) {
    throw new Error(`city manifest hash mismatch: got ${hashHex}, expected ${expectedHashHex}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as CityManifest;
  if (manifest.version !== 1) {
    throw new Error(`unsupported city manifest version ${manifest.version}`);
  }
  let totalChunks = 0;
  let totalBonds = 0;
  for (const structure of manifest.structures) {
    totalChunks += structure.chunks.length;
    totalBonds += structure.bonds.length;
  }
  return { manifest, hashHex, totalChunks, totalBonds };
}
