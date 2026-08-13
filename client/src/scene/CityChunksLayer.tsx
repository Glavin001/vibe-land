// Batched rendering of the destructible city: one THREE.BatchedMesh whose
// per-instance matrix = chunkWorldPose ∘ scale, composed from the streamed
// island-body poses + the manifest ledger.
//
// Intact/settled chunks are written once and frozen; only chunks belonging to
// live streaming bodies are recomposed each frame.
//
// BatchedMesh rather than InstancedMesh because fractured chunks each have
// their own convex hull, and an InstancedMesh can only draw one shape. It
// still costs a single draw call: distinct hulls are uploaded once and reused
// by every instance that shares them, which matters because the city stamps
// one building pack sixteen times. Box chunks all share a single unit-cube
// entry and carry their extents in the instance matrix, exactly as before.

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import { buildBoxGeometry, buildHullGeometry, chunkShape } from '../city/chunkGeometry';
import { shouldUpdateThisFrame, updateStrideForDistanceSq } from '../city/renderScheduling';
import { updateCityE2E } from '../e2eBridge';
import type { CityE2EStats } from '../e2eBridge';

const TMP_MATRIX = new THREE.Matrix4();
const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();

/**
 * Centroid depth below the flat city ground (y=0) that counts as "sunk".
 * Generous: a big slab lying flat still has its centroid above -0.25 m.
 */
const CHUNK_SUNK_Y_M = -0.25;

type CityMeshState = {
  mesh: THREE.BatchedMesh;
  /**
   * BatchedMesh hands out its own instance ids. They happen to be sequential
   * today, but nothing promises they equal the topology slot, so the mapping
   * is kept explicitly rather than assumed.
   */
  instanceIds: Int32Array;
  /** Per-slot render scale: box extents, or 1 for hulls (already metric). */
  scales: Float32Array;
  baseColors: Float32Array;
};

function structureColor(structureId: number): THREE.Color {
  return TMP_COLOR.setHSL(((structureId * 47) % 360) / 360, 0.35, 0.62);
}

function buildMesh(client: CityClient): CityMeshState {
  const manifest = client.manifest.manifest;
  const count = client.topology.chunkCount;

  // Resolve every chunk's shape first: the BatchedMesh has to be sized with
  // the total vertex and index budget up front, which is only knowable once
  // the distinct hulls are known.
  const scales = new Float32Array(count * 3);
  const shapeBySlot = new Array<ReturnType<typeof chunkShape>>(count);
  const hullGeometries = new Map<string, THREE.BufferGeometry>();
  for (const structure of manifest.structures) {
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      const shape = chunkShape(chunk);
      shapeBySlot[slot] = shape;
      if (shape.kind === 'hull') {
        scales[slot * 3] = 1;
        scales[slot * 3 + 1] = 1;
        scales[slot * 3 + 2] = 1;
        if (!hullGeometries.has(shape.key)) {
          hullGeometries.set(shape.key, buildHullGeometry(shape.points));
        }
      } else {
        scales[slot * 3] = shape.scale[0];
        scales[slot * 3 + 1] = shape.scale[1];
        scales[slot * 3 + 2] = shape.scale[2];
      }
    }
  }

  const boxGeometry = buildBoxGeometry();
  let vertexBudget = boxGeometry.attributes.position.count;
  let indexBudget = boxGeometry.index?.count ?? 0;
  for (const geometry of hullGeometries.values()) {
    vertexBudget += geometry.attributes.position.count;
    indexBudget += geometry.index?.count ?? 0;
  }

  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.BatchedMesh(count, vertexBudget, indexBudget, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The city is always around the player and every instance is written from
  // authoritative poses, so culling per instance would cost a pass over
  // thousands of chunks to hide almost nothing.
  mesh.perObjectFrustumCulled = false;
  mesh.sortObjects = false;
  mesh.frustumCulled = false;

  const boxGeometryId = mesh.addGeometry(boxGeometry);
  const hullGeometryIds = new Map<string, number>();
  for (const [key, geometry] of hullGeometries) {
    hullGeometryIds.set(key, mesh.addGeometry(geometry));
  }

  const instanceIds = new Int32Array(count).fill(-1);
  const baseColors = new Float32Array(count * 3);
  for (const structure of manifest.structures) {
    const color = structureColor(structure.structureId);
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      const shape = shapeBySlot[slot];
      const geometryId =
        shape.kind === 'hull' ? (hullGeometryIds.get(shape.key) ?? boxGeometryId) : boxGeometryId;
      instanceIds[slot] = mesh.addInstance(geometryId);
      baseColors[slot * 3] = color.r;
      baseColors[slot * 3 + 1] = color.g;
      baseColors[slot * 3 + 2] = color.b;
      writeInstance(mesh, client, slot, scales, instanceIds);
      mesh.setColorAt(instanceIds[slot], color);
    }
  }

  console.info('[city] batched chunk mesh ready', {
    chunks: count,
    structures: manifest.structures.length,
    hullGeometries: hullGeometries.size,
    vertices: vertexBudget,
  });
  return { mesh, instanceIds, scales, baseColors };
}

function writeInstance(
  mesh: THREE.BatchedMesh,
  client: CityClient,
  slot: number,
  scales: Float32Array,
  instanceIds: Int32Array,
): void {
  const instanceId = instanceIds[slot];
  if (instanceId < 0) {
    return;
  }
  const pose = client.topology.chunkWorldPose(slot);
  TMP_POSITION.set(pose.position[0], pose.position[1], pose.position[2]);
  TMP_QUATERNION.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  TMP_SCALE.set(scales[slot * 3], scales[slot * 3 + 1], scales[slot * 3 + 2]);
  TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
  mesh.setMatrixAt(instanceId, TMP_MATRIX);
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
  const buildFailedForRef = useRef<CityClient | null>(null);

  useFrame((frameState) => {
    const client = getCityClient();
    const group = groupRef.current;
    if (!client || !group) {
      return;
    }
    if (clientRef.current !== client) {
      if (stateRef.current) {
        group.remove(stateRef.current.mesh);
        // BatchedMesh owns the matrix/colour data textures as well as the
        // merged geometry; its own dispose is what releases them.
        stateRef.current.mesh.dispose();
        stateRef.current.mesh.geometry.dispose();
        (stateRef.current.mesh.material as THREE.Material).dispose();
        stateRef.current = null;
      }
      clientRef.current = client;
      buildFailedForRef.current = null;
      dirtyBodiesRef.current.clear();
    }
    if (!stateRef.current && buildFailedForRef.current !== client) {
      // A mesh build failure must not kill the frame loop or hide telemetry:
      // remember the failure, keep publishing stats, and let the session run
      // headless rather than retrying a throwing build every frame.
      try {
        stateRef.current = buildMesh(client);
        group.add(stateRef.current.mesh);
      } catch (error) {
        buildFailedForRef.current = client;
        console.error('[city] chunk mesh build failed; city will not render', error);
      }
    }

    // Telemetry is published before the mesh gate on purpose. It is the only
    // window E2E/QA has into decode, topology and bandwidth, and it must stay
    // observable even when rendering is broken.
    frameCounterRef.current += 1;
    if (frameCounterRef.current % 30 === 0) {
      const stats = client.stats();
      const prevBroken = (window as unknown as { __VIBE_CITY_BROKEN__?: number }).__VIBE_CITY_BROKEN__ ?? 0;
      if (stats.brokenBonds > prevBroken) {
        console.info('[city] brokenBonds', prevBroken, '→', stats.brokenBonds, {
          awake: stats.chunksAwake,
          settled: stats.chunksSettled,
        });
      }
      (window as unknown as { __VIBE_CITY_BROKEN__?: number }).__VIBE_CITY_BROKEN__ = stats.brokenBonds;
      // Ground-penetration probe: the server world is a flat plane at y=0, so
      // any chunk whose centroid sits below it has sunk into the floor. Cheap
      // enough at ~2 Hz over a few thousand chunks, and the only way to see
      // this without eyeballing a screenshot.
      let minChunkY = Infinity;
      let chunksBelowGround = 0;
      let deepestSlot = -1;
      for (let slot = 0; slot < client.topology.chunkCount; slot += 1) {
        const y = client.topology.chunkWorldPose(slot).position[1];
        if (y < minChunkY) {
          minChunkY = y;
          deepestSlot = slot;
        }
        if (y < CHUNK_SUNK_Y_M) chunksBelowGround += 1;
      }
      // Name the offending chunk rather than only counting it. The server is
      // measured to hold every body at y >= 0, so a chunk drawn hundreds of
      // metres down is this client composing a body pose with a local offset
      // wrongly -- and which of the two is wrong is only visible by reporting
      // both.
      let deepest: CityE2EStats['deepest'] = null;
      if (deepestSlot >= 0 && minChunkY < -5) {
        const key = client.topology.bodyKeyOf(deepestSlot);
        const body = client.topology.body(key);
        const offset = client.topology.chunkLocalOffset(deepestSlot).position;
        deepest = {
          slot: deepestSlot,
          structure: client.topology.chunkStructure(deepestSlot),
          node: client.topology.chunkNode(deepestSlot),
          worldY: minChunkY,
          islandSerial: body ? body.islandSerial : null,
          bodyPos: body
            ? [body.position[0], body.position[1], body.position[2]]
            : null,
          bodyMembers: body ? body.chunkSlots.length : 0,
          localOffset: [offset[0], offset[1], offset[2]],
        };
      }
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
        rendered: stateRef.current != null,
        minChunkY: Number.isFinite(minChunkY) ? minChunkY : 0,
        chunksBelowGround,
        orphanedChunks: stats.orphanedChunks,
        orphanedByRetire: stats.orphanedByRetire,
        deepest,
      });
    }

    const state = stateRef.current;
    if (!state) {
      return;
    }

    const live = client.samplePresentation(performance.now());
    const dirty = dirtyBodiesRef.current;
    for (const key of live) {
      dirty.add(key);
    }
    if (dirty.size === 0) {
      return;
    }
    // Rewriting every moving chunk every frame is the client's dominant cost
    // once a demolition is large: tens of thousands of matrix composes, most
    // of them for rubble far enough away that a frame's motion is a fraction
    // of a pixel. Distant bodies are updated on a stride instead, staggered by
    // key so the deferred work spreads across frames rather than spiking on
    // one.
    //
    // This is a render-rate decision only. The authoritative pose is whatever
    // the ledger holds; deferring a write delays when a distant chunk is
    // redrawn, it never changes where it is.
    const camera = frameState.camera.position;
    const frame = frameCounterRef.current;
    for (const key of dirty) {
      const body = client.topology.body(key);
      if (!body) {
        dirty.delete(key);
        continue;
      }
      // A body that stopped moving gets its final write unconditionally.
      // Deferring that one would strand the chunk at its second-to-last pose
      // for good, since no further frame will list it as live.
      const settling = !live.has(key);
      if (!settling) {
        const dx = body.position[0] - camera.x;
        const dy = body.position[1] - camera.y;
        const dz = body.position[2] - camera.z;
        const stride = updateStrideForDistanceSq(dx * dx + dy * dy + dz * dz);
        if (!shouldUpdateThisFrame(frame, key, stride)) {
          continue;
        }
      }
      const settledTint = body.settled ? 0.75 : 1;
      for (const slot of body.chunkSlots) {
        const instanceId = state.instanceIds[slot];
        if (instanceId < 0) {
          continue;
        }
        writeInstance(state.mesh, client, slot, state.scales, state.instanceIds);
        TMP_COLOR.setRGB(
          state.baseColors[slot * 3] * settledTint,
          state.baseColors[slot * 3 + 1] * settledTint,
          state.baseColors[slot * 3 + 2] * (body.settled ? 0.75 : 0.9),
        );
        state.mesh.setColorAt(instanceId, TMP_COLOR);
      }
      if (!live.has(key)) {
        dirty.delete(key);
      }
    }
    // No needsUpdate bookkeeping: BatchedMesh writes matrices and colours
    // straight into its own data textures and flags them itself.
  });

  return <group ref={groupRef} />;
}
