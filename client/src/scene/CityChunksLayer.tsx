// Instanced rendering of the destructible city: one THREE.InstancedMesh of
// unit boxes, per-instance matrix = chunkWorldPose ∘ scale(chunkSize),
// composed from the streamed island-body poses + the manifest ledger.
//
// Follows the BodiesTransportLab instanced path (never GameWorld's per-body
// Mesh map): intact/settled chunks are written once and frozen; only chunks
// belonging to live streaming bodies are recomposed each frame.

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import { updateCityE2E } from '../e2eBridge';

const TMP_MATRIX = new THREE.Matrix4();
const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();

type CityMeshState = {
  mesh: THREE.InstancedMesh;
  sizes: Float32Array;
  baseColors: Float32Array;
};

function structureColor(structureId: number): THREE.Color {
  return TMP_COLOR.setHSL(((structureId * 47) % 360) / 360, 0.35, 0.62);
}

function buildMesh(client: CityClient): CityMeshState {
  const manifest = client.manifest.manifest;
  const count = client.topology.chunkCount;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const sizes = new Float32Array(count * 3);
  const baseColors = new Float32Array(count * 3);
  for (const structure of manifest.structures) {
    const color = structureColor(structure.structureId);
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      sizes[slot * 3] = Math.max(0.05, chunk.size[0]);
      sizes[slot * 3 + 1] = Math.max(0.05, chunk.size[1]);
      sizes[slot * 3 + 2] = Math.max(0.05, chunk.size[2]);
      baseColors[slot * 3] = color.r;
      baseColors[slot * 3 + 1] = color.g;
      baseColors[slot * 3 + 2] = color.b;
      writeInstance(mesh, client, slot, sizes, 1);
      mesh.setColorAt(slot, color);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
  return { mesh, sizes, baseColors };
}

function writeInstance(
  mesh: THREE.InstancedMesh,
  client: CityClient,
  slot: number,
  sizes: Float32Array,
  _tint: number,
): void {
  const pose = client.topology.chunkWorldPose(slot);
  TMP_POSITION.set(pose.position[0], pose.position[1], pose.position[2]);
  TMP_QUATERNION.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  TMP_SCALE.set(sizes[slot * 3], sizes[slot * 3 + 1], sizes[slot * 3 + 2]);
  TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
  mesh.setMatrixAt(slot, TMP_MATRIX);
}

export function CityChunksLayer({
  getCityClient,
}: {
  getCityClient: () => CityClient | null;
}): React.JSX.Element {
  const groupRef = useRef<THREE.Group>(null);
  const stateRef = useRef<CityMeshState | null>(null);
  const clientRef = useRef<CityClient | null>(null);
  const dirtyBodiesRef = useRef<Set<number>>(new Set());
  const frameCounterRef = useRef(0);

  useFrame(() => {
    const client = getCityClient();
    const group = groupRef.current;
    if (!client || !group) {
      return;
    }
    if (clientRef.current !== client) {
      // New session/manifest: rebuild the instanced mesh.
      if (stateRef.current) {
        group.remove(stateRef.current.mesh);
        stateRef.current.mesh.geometry.dispose();
        (stateRef.current.mesh.material as THREE.Material).dispose();
      }
      stateRef.current = buildMesh(client);
      clientRef.current = client;
      group.add(stateRef.current.mesh);
      dirtyBodiesRef.current.clear();
    }
    const state = stateRef.current;
    if (!state) {
      return;
    }

    // Publish stats to the e2e bridge (~2 Hz).
    frameCounterRef.current += 1;
    if (frameCounterRef.current % 30 === 0) {
      const stats = client.stats();
      updateCityE2E({
        chunksTotal: stats.chunksTotal,
        chunksAwake: stats.chunksAwake,
        chunksSettled: stats.chunksSettled,
        brokenBonds: stats.brokenBonds,
        liveIslands: stats.liveIslands,
        topoSeqGaps: stats.topoSeqGaps,
        datagramsReceived: stats.datagramsReceived,
        bytesPerSecond: stats.bytesPerSecond,
        manifestHash: stats.manifestHash,
      });
    }

    const live = client.samplePresentation(performance.now());
    // Bodies that streamed last frame but not this one need one final write
    // (their settle pose landed via topology).
    const dirty = dirtyBodiesRef.current;
    for (const key of live) {
      dirty.add(key);
    }
    if (dirty.size === 0) {
      return;
    }
    let wrote = false;
    for (const key of dirty) {
      const body = client.topology.body(key);
      if (!body) {
        dirty.delete(key);
        continue;
      }
      const settledTint = body.settled ? 0.75 : 1;
      for (const slot of body.chunkSlots) {
        writeInstance(state.mesh, client, slot, state.sizes, settledTint);
        TMP_COLOR.setRGB(
          state.baseColors[slot * 3] * settledTint,
          state.baseColors[slot * 3 + 1] * settledTint,
          state.baseColors[slot * 3 + 2] * (body.settled ? 0.75 : 0.9),
        );
        state.mesh.setColorAt(slot, TMP_COLOR);
      }
      if (!live.has(key)) {
        dirty.delete(key); // final settle write done
      }
      wrote = true;
    }
    if (wrote) {
      state.mesh.instanceMatrix.needsUpdate = true;
      if (state.mesh.instanceColor) {
        state.mesh.instanceColor.needsUpdate = true;
      }
    }
  });

  return <group ref={groupRef} />;
}
