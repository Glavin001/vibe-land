import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Chunk, Destructible, WorldDocument } from '../world/worldDocument';

/**
 * Stride of the chunk transforms buffer produced by
 * `WasmSimWorld::get_destructible_chunk_transforms`. Must match
 * `CHUNK_TRANSFORM_STRIDE` in `shared/src/destructibles.rs`.
 */
const CHUNK_TRANSFORM_STRIDE = 11;

/**
 * Default half-extents used for the legacy factory destructibles. Size
 * matches the Blast scenario-option defaults:
 *
 * - Wall (`WallOptions::default`): 12×6×1 cells of 0.5×0.5×0.32m → half (0.25,0.25,0.16).
 * - Tower (`TowerOptions::default`): spacing_{x,y,z}=0.5 → half (0.25,0.25,0.25).
 */
const FACTORY_GEOMETRIES = {
  wall: { size: [0.5, 0.5, 0.32] as [number, number, number], color: 0x9ca3a8 },
  tower: { size: [0.5, 0.5, 0.5] as [number, number, number], color: 0xb89460 },
} as const;

const STRUCTURE_COLOR = 0x8c94a0;

/** Max chunk count per InstancedMesh bucket. Matches native MAX_CHUNKS_PER_STRUCTURE. */
const MAX_CHUNKS_PER_BUCKET = 4096;

type DestructibleChunksProps = {
  world: WorldDocument;
  /**
   * Per-frame getter for the raw WASM chunk transform buffer. The buffer
   * is a flat `Float32Array` with stride `CHUNK_TRANSFORM_STRIDE`:
   *   [destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, present, _pad]
   */
  getChunkTransforms: () => Float32Array;
};

/**
 * One instanced-mesh bucket. A single bucket holds instances that share
 * a common geometry (same shape + same size). Factory destructibles use
 * a single uniform bucket. Structures get one bucket per
 * (structureId, shape-key) so boxes / spheres / capsules can each use
 * their own geometry.
 */
type InstanceBucket = {
  destructibleId: number;
  mesh: THREE.InstancedMesh;
  /** Maps `chunkIndex` (from the WASM buffer) → instance slot in `mesh`. */
  chunkIndexToSlot: Map<number, number>;
};

function buildInstancedMeshForGeometry(
  geometry: THREE.BufferGeometry,
  color: number,
  capacity: number,
): THREE.InstancedMesh {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function geometryForChunk(chunk: Chunk): THREE.BufferGeometry {
  switch (chunk.shape) {
    case 'box': {
      const he = chunk.halfExtents ?? [0.25, 0.25, 0.25];
      return new THREE.BoxGeometry(he[0] * 2, he[1] * 2, he[2] * 2);
    }
    case 'sphere':
      return new THREE.SphereGeometry(chunk.radius ?? 0.25, 16, 12);
    case 'capsule':
      return new THREE.CapsuleGeometry(chunk.radius ?? 0.25, chunk.height ?? 0.5, 6, 12);
  }
}

/**
 * Renders every destructible chunk as an InstancedMesh. Each frame, the
 * WASM chunk transform buffer is walked and per-chunk matrices are set on
 * the owning bucket. Inactive chunks (present=0) collapse to a zero-scale
 * matrix so the slot stays allocated but draws nothing.
 */
export function DestructibleChunks({ world, getChunkTransforms }: DestructibleChunksProps) {
  const bucketsRef = useRef<InstanceBucket[]>([]);
  const tmpMatrix = useMemo(() => new THREE.Matrix4(), []);
  const tmpPosition = useMemo(() => new THREE.Vector3(), []);
  const tmpQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const zeroScale = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const unitScale = useMemo(() => new THREE.Vector3(1, 1, 1), []);

  const buckets = useMemo<InstanceBucket[]>(() => {
    const result: InstanceBucket[] = [];
    for (const doc of world.destructibles) {
      if (doc.kind !== 'structure') {
        const geom = FACTORY_GEOMETRIES[doc.kind];
        const box = new THREE.BoxGeometry(geom.size[0], geom.size[1], geom.size[2]);
        const mesh = buildInstancedMeshForGeometry(box, geom.color, MAX_CHUNKS_PER_BUCKET);
        // Collapse all instances until the first transform update.
        for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i += 1) {
          tmpMatrix.compose(tmpPosition.set(0, 0, 0), tmpQuaternion.set(0, 0, 0, 1), zeroScale);
          mesh.setMatrixAt(i, tmpMatrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        result.push({
          destructibleId: doc.id,
          mesh,
          chunkIndexToSlot: new Map(),
        });
        continue;
      }
      // Structure: group chunks by a (shape + size) key so each unique
      // geometry gets its own InstancedMesh. Slot order = order within the
      // group (not global chunk index), so we record the mapping.
      const groupByKey = new Map<string, { key: string; indices: number[]; geom: THREE.BufferGeometry }>();
      doc.chunks.forEach((chunk: Chunk, index: number) => {
        const key = chunkGeometryKey(chunk);
        const existing = groupByKey.get(key);
        if (existing) {
          existing.indices.push(index);
        } else {
          groupByKey.set(key, { key, indices: [index], geom: geometryForChunk(chunk) });
        }
      });
      for (const group of groupByKey.values()) {
        const capacity = Math.max(1, group.indices.length);
        const mesh = buildInstancedMeshForGeometry(group.geom, STRUCTURE_COLOR, capacity);
        const slotMap = new Map<number, number>();
        group.indices.forEach((chunkIndex, slot) => {
          slotMap.set(chunkIndex, slot);
          tmpMatrix.compose(tmpPosition.set(0, 0, 0), tmpQuaternion.set(0, 0, 0, 1), zeroScale);
          mesh.setMatrixAt(slot, tmpMatrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        result.push({
          destructibleId: doc.id,
          mesh,
          chunkIndexToSlot: slotMap,
        });
      }
    }
    bucketsRef.current = result;
    return result;
  }, [world.destructibles, tmpMatrix, tmpPosition, tmpQuaternion, zeroScale]);

  useEffect(() => {
    return () => {
      for (const bucket of buckets) {
        bucket.mesh.dispose();
        bucket.mesh.geometry.dispose();
        if (Array.isArray(bucket.mesh.material)) {
          bucket.mesh.material.forEach((m) => m.dispose());
        } else {
          bucket.mesh.material.dispose();
        }
      }
    };
  }, [buckets]);

  useFrame(() => {
    const bucketList = bucketsRef.current;
    if (bucketList.length === 0) return;
    const buffer = getChunkTransforms();
    if (buffer.length === 0) return;

    // Reset per-bucket "written" tracker so we know which slots to zero out.
    const writtenByBucket = new Map<InstanceBucket, Set<number>>();
    for (const bucket of bucketList) writtenByBucket.set(bucket, new Set());

    const total = Math.floor(buffer.length / CHUNK_TRANSFORM_STRIDE);
    for (let i = 0; i < total; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      const destructibleId = buffer[base];
      const chunkIndex = buffer[base + 1];
      // A destructible may have multiple buckets (structure with mixed
      // shapes); pick the one that owns this chunk index.
      let bucket: InstanceBucket | null = null;
      let slot = -1;
      for (const candidate of bucketList) {
        if (candidate.destructibleId !== destructibleId) continue;
        // Factory buckets use an empty slot map and map chunkIndex → chunkIndex.
        if (candidate.chunkIndexToSlot.size === 0) {
          if (chunkIndex < MAX_CHUNKS_PER_BUCKET) {
            bucket = candidate;
            slot = chunkIndex;
          }
          break;
        }
        const mapped = candidate.chunkIndexToSlot.get(chunkIndex);
        if (mapped !== undefined) {
          bucket = candidate;
          slot = mapped;
          break;
        }
      }
      if (!bucket || slot < 0) continue;

      tmpPosition.set(buffer[base + 2], buffer[base + 3], buffer[base + 4]);
      tmpQuaternion.set(buffer[base + 5], buffer[base + 6], buffer[base + 7], buffer[base + 8]);
      const presentFlag = buffer[base + 9] ?? 0;
      tmpMatrix.compose(tmpPosition, tmpQuaternion, presentFlag > 0 ? unitScale : zeroScale);
      bucket.mesh.setMatrixAt(slot, tmpMatrix);
      writtenByBucket.get(bucket)!.add(slot);
    }

    for (const [bucket, written] of writtenByBucket.entries()) {
      const capacity = bucket.mesh.instanceMatrix.count;
      let maxWritten = -1;
      for (const slot of written) if (slot > maxWritten) maxWritten = slot;
      bucket.mesh.count = maxWritten + 1;
      // Zero-scale any slots in the active range that weren't written this
      // frame so stale matrices don't render.
      for (let slot = 0; slot <= maxWritten && slot < capacity; slot += 1) {
        if (written.has(slot)) continue;
        tmpMatrix.compose(tmpPosition.set(0, 0, 0), tmpQuaternion.set(0, 0, 0, 1), zeroScale);
        bucket.mesh.setMatrixAt(slot, tmpMatrix);
      }
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  });

  if (buckets.length === 0) return null;

  return (
    <group>
      {buckets.map((bucket, i) => (
        <primitive key={`${bucket.destructibleId}:${i}`} object={bucket.mesh} />
      ))}
    </group>
  );
}

function chunkGeometryKey(chunk: Chunk): string {
  switch (chunk.shape) {
    case 'box': {
      const he = chunk.halfExtents ?? [0.25, 0.25, 0.25];
      return `box:${he[0]}:${he[1]}:${he[2]}`;
    }
    case 'sphere':
      return `sphere:${chunk.radius ?? 0.25}`;
    case 'capsule':
      return `capsule:${chunk.radius ?? 0.25}:${chunk.height ?? 0.5}`;
  }
}
