// The city's standing chunks as fixed colliders for the driven car's
// prediction (vehiclePresentation.ts sweeps the client's static world). The
// server's physics collides the car with every chunk still standing, as the
// chunk's own shape: a cuboid or a convex hull, placed by its structure. A
// client sweeping a flat ground instead draws the car through a wall until
// the server's correction arrives a round trip later.
//
// Standing means part of its structure's support body in the ledger: a
// chunk that broke loose (moving debris) or was removed stops colliding. The
// ledger reports changed chunks (CityTopology.drainCollisionChanges), so a
// fracture touches only its own chunks.
import type { CityManifest, ManifestChunk, ManifestStructure } from '../city/manifest';
import { cuboidHalfExtents, isConvexHullGeometry } from '../city/manifest';
import type { CityTopology } from '../city/topology';

/** Where shapes go: CosmeticPhysicsWorld / WasmSimWorld `setStaticShapes`. */
export interface StaticShapeSink {
  setStaticShapes(keys: Uint32Array, poses: Float32Array, counts: Uint32Array, data: Float32Array): number;
  removeStaticShapes(keys: Uint32Array): void;
}

const rotate = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

/** Chunks packed as `setStaticShapes` takes them. */
export function packChunkShapes(entries: readonly { key: number; structure: ManifestStructure; chunk: ManifestChunk }[]) {
  const keys = new Uint32Array(entries.length);
  const poses = new Float32Array(entries.length * 7);
  const counts = new Uint32Array(entries.length);
  const data: number[] = [];
  entries.forEach(({ key, structure, chunk }, i) => {
    keys[i] = key;
    const at = rotate(structure.worldRotation, chunk.centroid);
    poses.set([structure.worldPosition[0] + at[0], structure.worldPosition[1] + at[1], structure.worldPosition[2] + at[2], ...structure.worldRotation], i * 7);
    const geometry = chunk.geometry;
    if (geometry && isConvexHullGeometry(geometry) && geometry.points.length >= 12) {
      counts[i] = geometry.points.length / 3;
      for (const v of geometry.points) data.push(v);
    } else {
      const half = (geometry && cuboidHalfExtents(geometry)) ?? [chunk.size[0] / 2, chunk.size[1] / 2, chunk.size[2] / 2];
      data.push(half[0], half[1], half[2]);
    }
  });
  return { keys, poses, counts, data: Float32Array.from(data) };
}

/** Every chunk of an intact city, keyed by its place in the manifest. */
export function intactCityShapes(manifest: CityManifest) {
  const entries: { key: number; structure: ManifestStructure; chunk: ManifestChunk }[] = [];
  for (const structure of manifest.structures) for (const chunk of structure.chunks) entries.push({ key: entries.length, structure, chunk });
  return packChunkShapes(entries);
}

export class CityVehicleColliders {
  private readonly loaded: Uint8Array;
  private readonly structures = new Map<number, { structure: ManifestStructure; chunks: Map<number, ManifestChunk> }>();
  private epoch = -1;
  /** Shapes loaded now (for telemetry). */
  count = 0;

  constructor(private readonly sink: StaticShapeSink, manifest: CityManifest, private readonly topology: CityTopology) {
    this.loaded = new Uint8Array(topology.slotCount());
    for (const structure of manifest.structures) {
      this.structures.set(structure.structureId, { structure, chunks: new Map(structure.chunks.map((c) => [c.nodeIndex, c])) });
    }
  }

  /** Bring the colliders in line with the ledger. Cheap when nothing changed. */
  sync(): void {
    const epoch = this.topology.collisionEpoch();
    let slots: Iterable<number>;
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.topology.drainCollisionChanges();
      slots = Array.from({ length: this.loaded.length }, (_, i) => i);
    } else {
      slots = this.topology.drainCollisionChanges();
    }
    const add: { key: number; structure: ManifestStructure; chunk: ManifestChunk }[] = [];
    const remove: number[] = [];
    for (const slot of slots) {
      const standing = this.topology.isStanding(slot);
      if (standing && this.loaded[slot] === 0) {
        const entry = this.structures.get(this.topology.chunkStructure(slot));
        const chunk = entry?.chunks.get(this.topology.chunkNode(slot));
        if (!entry || !chunk) continue;
        add.push({ key: slot, structure: entry.structure, chunk });
        this.loaded[slot] = 1;
      } else if (!standing && this.loaded[slot] === 1) {
        remove.push(slot);
        this.loaded[slot] = 0;
      }
    }
    if (add.length) {
      const packed = packChunkShapes(add);
      this.sink.setStaticShapes(packed.keys, packed.poses, packed.counts, packed.data);
    }
    if (remove.length) this.sink.removeStaticShapes(Uint32Array.from(remove));
    this.count += add.length - remove.length;
  }
}
