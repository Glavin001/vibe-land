import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldDocument, Destructible } from '../world/worldDocument';

/**
 * Stride of the chunk transforms buffer produced by
 * `WasmSimWorld::get_destructible_chunk_transforms`. Must match
 * `CHUNK_TRANSFORM_STRIDE` in `shared/src/destructibles.rs`.
 */
const CHUNK_TRANSFORM_STRIDE = 11;

/**
 * Default half-extents of a single Blast chunk, derived from the scenario
 * options defaults in the blast crate:
 *
 * - Wall (`WallOptions::default`): span=6, height=3, thickness=0.32,
 *   12×6×1 grid → cell size ≈ (0.5, 0.5, 0.32), half ≈ (0.25, 0.25, 0.16).
 * - Tower (`TowerOptions::default`): spacing_{x,y,z}=0.5 → cell (0.5,0.5,0.5),
 *   half (0.25, 0.25, 0.25).
 *
 * Using these fixed sizes for the instanced box mesh avoids a per-frame
 * AABB query through the WASM boundary; the solver already guarantees
 * chunks stay inside their starting cell volumes.
 */
const CHUNK_GEOMETRIES: Record<Destructible['kind'], { size: [number, number, number]; color: number }> = {
  wall: { size: [0.5, 0.5, 0.32], color: 0x9ca3a8 },
  tower: { size: [0.5, 0.5, 0.5], color: 0xb89460 },
};

/**
 * Max chunk count per destructible. Defaults (wall=72 chunks, tower=128)
 * give plenty of headroom for split children created when bonds break.
 */
const MAX_CHUNKS_PER_DESTRUCTIBLE = 512;

type DestructibleChunksProps = {
  world: WorldDocument;
  /**
   * Per-frame getter for the raw WASM chunk transform buffer. The buffer
   * is a flat `Float32Array` with stride `CHUNK_TRANSFORM_STRIDE`:
   *   [destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, present, _pad]
   */
  getChunkTransforms: () => Float32Array;
};

type InstanceGroup = {
  id: number;
  kind: Destructible['kind'];
  mesh: THREE.InstancedMesh;
};

/**
 * Renders every destructible chunk as a single InstancedMesh per
 * destructible instance. Matrices are streamed from the WASM sim each
 * frame; inactive chunks (activeFlag=0) collapse to a zero-scale matrix so
 * the instance still exists in the buffer but draws nothing.
 */
export function DestructibleChunks({ world, getChunkTransforms }: DestructibleChunksProps) {
  const groupsRef = useRef<InstanceGroup[]>([]);
  const tmpMatrix = useMemo(() => new THREE.Matrix4(), []);
  const tmpPosition = useMemo(() => new THREE.Vector3(), []);
  const tmpQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const zeroScale = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const unitScale = useMemo(() => new THREE.Vector3(1, 1, 1), []);

  // Build one InstancedMesh per destructible declared in the world doc.
  // We create them lazily via JSX below so React handles mount/unmount,
  // but we also stash refs to each mesh in `groupsRef` for the frame loop.
  const instancedMeshes = useMemo(() => {
    const meshes = world.destructibles.map((doc) => {
      const geom = CHUNK_GEOMETRIES[doc.kind];
      const box = new THREE.BoxGeometry(...geom.size);
      const material = new THREE.MeshStandardMaterial({
        color: geom.color,
        roughness: 0.85,
        metalness: 0.05,
      });
      const mesh = new THREE.InstancedMesh(box, material, MAX_CHUNKS_PER_DESTRUCTIBLE);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      // Collapse all instances until the first transform update — avoids
      // a single-frame flash of unit-cube instances at the origin.
      for (let i = 0; i < MAX_CHUNKS_PER_DESTRUCTIBLE; i += 1) {
        tmpMatrix.compose(tmpPosition.set(0, 0, 0), tmpQuaternion.set(0, 0, 0, 1), zeroScale);
        mesh.setMatrixAt(i, tmpMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      return { id: doc.id, kind: doc.kind, mesh };
    });
    groupsRef.current = meshes;
    return meshes;
  }, [world.destructibles, tmpMatrix, tmpPosition, tmpQuaternion, zeroScale]);

  useEffect(() => {
    return () => {
      for (const group of instancedMeshes) {
        group.mesh.dispose();
        group.mesh.geometry.dispose();
        if (Array.isArray(group.mesh.material)) {
          group.mesh.material.forEach((m) => m.dispose());
        } else {
          group.mesh.material.dispose();
        }
      }
    };
  }, [instancedMeshes]);

  useFrame(() => {
    const groups = groupsRef.current;
    if (groups.length === 0) return;
    const buffer = getChunkTransforms();
    if (buffer.length === 0) return;

    // Reset all counts each frame — we fill them from the WASM buffer.
    const byId = new Map<number, { group: InstanceGroup; count: number }>();
    for (const group of groups) {
      byId.set(group.id, { group, count: 0 });
    }

    const total = Math.floor(buffer.length / CHUNK_TRANSFORM_STRIDE);
    for (let i = 0; i < total; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      const destructibleId = buffer[base];
      const entry = byId.get(destructibleId);
      if (!entry) continue;
      const slotIndex = entry.count;
      if (slotIndex >= MAX_CHUNKS_PER_DESTRUCTIBLE) continue;

      tmpPosition.set(buffer[base + 2], buffer[base + 3], buffer[base + 4]);
      tmpQuaternion.set(buffer[base + 5], buffer[base + 6], buffer[base + 7], buffer[base + 8]);
      const presentFlag = buffer[base + 9] ?? 0;
      tmpMatrix.compose(tmpPosition, tmpQuaternion, presentFlag > 0 ? unitScale : zeroScale);
      entry.group.mesh.setMatrixAt(slotIndex, tmpMatrix);
      entry.count = slotIndex + 1;
    }

    for (const { group, count } of byId.values()) {
      group.mesh.count = count;
      // Collapse the trailing unused instances to avoid rendering stale
      // matrices when chunks disappear (debris cleanup).
      for (let i = count; i < group.mesh.count; i += 1) {
        tmpMatrix.compose(tmpPosition.set(0, 0, 0), tmpQuaternion.set(0, 0, 0, 1), zeroScale);
        group.mesh.setMatrixAt(i, tmpMatrix);
      }
      group.mesh.instanceMatrix.needsUpdate = true;
    }
  });

  if (instancedMeshes.length === 0) return null;

  return (
    <group>
      {instancedMeshes.map((group) => (
        <primitive key={group.id} object={group.mesh} />
      ))}
    </group>
  );
}
