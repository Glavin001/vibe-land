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
import { addCitySuspect, isRecording, recordCityEvent, recordCityStats } from '../netlab/recorder';
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
  /**
   * One batch per structure, not one for the whole city.
   *
   * three uploads a BatchedMesh's entire matrix texture whenever any instance
   * in it moves -- textures have no partial-update path the way buffers do. A
   * single city-wide batch therefore re-uploaded megabytes every frame because
   * one chunk somewhere was falling. Splitting per structure means a building
   * nobody has touched costs nothing.
   */
  meshes: THREE.BatchedMesh[];
  /** Slot -> index into `meshes`. */
  meshOfSlot: Int32Array;
  /**
   * Slot -> instance id within its own mesh. BatchedMesh hands out its own
   * ids, and nothing promises they match the topology slot.
   */
  instanceIds: Int32Array;
  /** Per-slot render scale: box extents, or 1 for hulls (already metric). */
  scales: Float32Array;
  baseColors: Float32Array;
};

/**
 * Keep a bounded window of update costs. Bounded because this runs every frame
 * forever: an unbounded array would be a leak measured in hours.
 */
function recordUpdateMs(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > 240) {
    samples.shift();
  }
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

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

  // One batch per structure. Geometry is rebuilt per structure rather than
  // shared, which costs some memory, but a shared city-wide batch made every
  // frame upload the transforms of every chunk in the city -- see the note on
  // CityMeshState.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
  const meshes: THREE.BatchedMesh[] = [];
  const meshOfSlot = new Int32Array(count).fill(-1);
  const instanceIds = new Int32Array(count).fill(-1);
  const baseColors = new Float32Array(count * 3);
  let totalVertices = 0;

  for (const structure of manifest.structures) {
    const slots = structure.chunks.map((chunk) =>
      client.topology.slotOf(structure.structureId, chunk.nodeIndex),
    );
    // Only the hulls this structure actually uses.
    const localHulls = new Map<string, THREE.BufferGeometry>();
    for (const slot of slots) {
      const shape = shapeBySlot[slot];
      if (shape.kind === 'hull' && !localHulls.has(shape.key)) {
        localHulls.set(shape.key, buildHullGeometry(shape.points));
      }
    }
    const boxGeometry = buildBoxGeometry();
    let vertexBudget = boxGeometry.attributes.position.count;
    let indexBudget = boxGeometry.index?.count ?? 0;
    for (const geometry of localHulls.values()) {
      vertexBudget += geometry.attributes.position.count;
      indexBudget += geometry.index?.count ?? 0;
    }
    totalVertices += vertexBudget;

    const mesh = new THREE.BatchedMesh(slots.length, vertexBudget, indexBudget, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Per-instance culling walks every chunk to decide each one, which is the
    // work we are trying to avoid.
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    // Whole-batch culling, on the other hand, is one sphere test that can drop
    // an entire building. This is only worth anything because batches are per
    // structure: a single city-wide batch always intersects the frustum, which
    // is why culling used to be turned off here.
    mesh.frustumCulled = true;

    const boxGeometryId = mesh.addGeometry(boxGeometry);
    const hullGeometryIds = new Map<string, number>();
    for (const [key, geometry] of localHulls) {
      hullGeometryIds.set(key, mesh.addGeometry(geometry));
    }

    const meshIndex = meshes.length;
    const color = structureColor(structure.structureId);
    for (const slot of slots) {
      const shape = shapeBySlot[slot];
      const geometryId =
        shape.kind === 'hull' ? (hullGeometryIds.get(shape.key) ?? boxGeometryId) : boxGeometryId;
      meshOfSlot[slot] = meshIndex;
      instanceIds[slot] = mesh.addInstance(geometryId);
      baseColors[slot * 3] = color.r;
      baseColors[slot * 3 + 1] = color.g;
      baseColors[slot * 3 + 2] = color.b;
      writeInstance(mesh, client, slot, scales, instanceIds);
      mesh.setColorAt(instanceIds[slot], color);
    }
    meshes.push(mesh);
  }

  console.info('[city] batched chunk meshes ready', {
    chunks: count,
    batches: meshes.length,
    vertices: totalVertices,
  });
  return { meshes, meshOfSlot, instanceIds, scales, baseColors };
}

function writeInstance(
  mesh: THREE.BatchedMesh,
  client: CityClient,
  slot: number,
  scales: Float32Array,
  instanceIds: Int32Array,
  probeCtx?: ChunkWriteContext,
): void {
  const instanceId = instanceIds[slot];
  if (instanceId < 0) {
    return;
  }
  const pose = client.topology.chunkWorldPose(slot);
  // Teleport probe: this is the last point every chunk transform passes
  // through, so a jump seen here is a jump the player saw, whatever produced
  // it upstream.
  if (chunkTeleportProbe) chunkTeleportProbe(slot, pose.position, probeCtx);
  TMP_POSITION.set(pose.position[0], pose.position[1], pose.position[2]);
  TMP_QUATERNION.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  TMP_SCALE.set(scales[slot * 3], scales[slot * 3 + 1], scales[slot * 3 + 2]);
  TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
  mesh.setMatrixAt(instanceId, TMP_MATRIX);
}

/**
 * Largest believable single-frame move for a chunk, in metres.
 *
 * Debris is speed-clamped server-side at 12 m/s; at 60 fps that is 0.2 m per
 * frame, and a distance-strided chunk accumulates 8 frames of it. 1.5 m leaves
 * headroom above that so only genuine discontinuities are reported.
 */
const CHUNK_TELEPORT_M = 1.5;

/** Per-write context so a teleport event names its suspect, not just a slot. */
interface ChunkWriteContext {
  bodyKey: number;
  settling: boolean;
  bodySettled: boolean;
}

/**
 * Settled islands hovering in mid-air: lowest chunk well above ground with no
 * chunk of any island beneath its column. The netcode can only show what the
 * ledger holds — if the ledger itself (confirmed against server truth by the
 * resync differential) has floating settled islands, the fault is physics
 * settling, not synchronisation. Coarse XZ hashing keeps the 2 Hz scan cheap.
 */
function countFloatingSettledIslands(client: CityClient): number {
  const topology = client.topology;
  const cell = 2.5;
  const columns = new Map<string, number>();
  const count = topology.chunkCount;
  const poses: Array<{ x: number; y: number; z: number }> = new Array(count);
  for (let slot = 0; slot < count; slot += 1) {
    const pose = topology.chunkWorldPose(slot);
    const p = { x: pose.position[0], y: pose.position[1], z: pose.position[2] };
    poses[slot] = p;
    const key = `${Math.round(p.x / cell)},${Math.round(p.z / cell)}`;
    const lowest = columns.get(key);
    if (lowest === undefined || p.y < lowest) columns.set(key, p.y);
  }
  let floating = 0;
  for (const body of topology.allBodies()) {
    if (!body.settled || body.islandSerial === 0 || body.chunkSlots.length === 0) continue;
    let minY = Infinity;
    let minSlot = -1;
    for (const slot of body.chunkSlots) {
      if (poses[slot].y < minY) {
        minY = poses[slot].y;
        minSlot = slot;
      }
    }
    if (minY < 1.5) continue; // near ground — supported or close enough
    const p = poses[minSlot];
    const key = `${Math.round(p.x / cell)},${Math.round(p.z / cell)}`;
    const columnFloor = columns.get(key) ?? minY;
    // Nothing beneath it in its own column within 1.5 m → hovering.
    if (minY - columnFloor < 0.01 && minY > 1.5) floating += 1;
  }
  return floating;
}

/** Set while recording; see `installChunkTeleportProbe`. */
let chunkTeleportProbe:
  | ((slot: number, position: readonly number[], ctx?: ChunkWriteContext) => void)
  | null = null;

/**
 * Slots whose last DRAWN position disagrees with the ledger by more than
 * `toleranceM`.
 *
 * The ledger is the authority the renderer is supposed to be showing, so a
 * standing disagreement means the screen is stale — a body whose pose changed
 * without anything ever marking its chunks for a rewrite. Nothing else
 * observes this: every other city metric reads the ledger, which is correct
 * even when the screen is not.
 */
let countStaleDrawnChunks: ((client: CityClient, toleranceM: number) => number) | null = null;

/**
 * Watch every written chunk transform for single-frame jumps.
 *
 * Returns a disposer. Positions are held in a preallocated array so the probe
 * costs one compare and three stores per chunk write. Each event carries the
 * causal context of the write — which body, how long since this chunk's last
 * write, and what kind of write — because a bare step size cannot distinguish
 * "moved 2 m because it was not drawn for 500 ms" from "jumped 2 m between
 * consecutive frames", and those have entirely different root causes.
 */
function installChunkTeleportProbe(chunkCount: number): () => void {
  const previous = new Float32Array(chunkCount * 3).fill(Number.NaN);
  const lastWriteMs = new Float32Array(chunkCount).fill(Number.NaN);
  /** EMA of each slot's own write-to-write speed, m/s. */
  const speedEst = new Float32Array(chunkCount);
  const teleportStrikes = new Map<number, number>();
  countStaleDrawnChunks = (client, toleranceM) => {
    let stale = 0;
    const count = client.topology.chunkCount;
    for (let slot = 0; slot < count; slot += 1) {
      const base = slot * 3;
      if (Number.isNaN(previous[base])) continue;
      const pose = client.topology.chunkWorldPose(slot);
      const dx = pose.position[0] - previous[base];
      const dy = pose.position[1] - previous[base + 1];
      const dz = pose.position[2] - previous[base + 2];
      if (Math.hypot(dx, dy, dz) > toleranceM) stale += 1;
    }
    return stale;
  };
  chunkTeleportProbe = (slot, position, ctx) => {
    const base = slot * 3;
    const px = previous[base];
    const nowMs = performance.now();
    // Teleport analysis needs the write's context; stale-detection only needs
    // the position, so buildMesh's context-free initial writes still register.
    if (!Number.isNaN(px) && ctx) {
      const dx = position[0] - px;
      const dy = position[1] - previous[base + 1];
      const dz = position[2] - previous[base + 2];
      const step = Math.hypot(dx, dy, dz);
      const gapSec = Math.max((nowMs - lastWriteMs[slot]) / 1000, 1 / 240);
      // Judge the step against this chunk's own recent speed, not a flat
      // bound: debris legitimately flies at 40-70 m/s since the push-speed
      // redesign removed the velocity clamp, and a distant body on an 8-frame
      // stride covers multiple metres per write. A fault is a step the
      // chunk's own trajectory cannot explain.
      const explained = 3 * speedEst[slot] * gapSec + 0.3;
      const anomalous = step > CHUNK_TELEPORT_M && step > explained;
      speedEst[slot] = 0.7 * speedEst[slot] + 0.3 * (step / gapSec);
      if (anomalous) {
        recordCityEvent('city_chunk_teleport', {
          slot,
          stepM: step,
          body: ctx.bodyKey,
          settling: ctx.settling,
          bodySettled: ctx.bodySettled,
          sinceLastWriteMs: Number.isNaN(lastWriteMs[slot])
            ? -1
            : Math.round(nowMs - lastWriteMs[slot]),
          x: position[0],
          y: position[1],
          z: position[2],
        });
        // Repeated teleports on one body: tap its raw record stream so the
        // wire trajectory itself becomes inspectable.
        const strikes = (teleportStrikes.get(ctx.bodyKey) ?? 0) + 1;
        teleportStrikes.set(ctx.bodyKey, strikes);
        if (strikes === 3) addCitySuspect(ctx.bodyKey);
      }
    }
    previous[base] = position[0];
    previous[base + 1] = position[1];
    previous[base + 2] = position[2];
    lastWriteMs[slot] = nowMs;
  };
  return () => {
    chunkTeleportProbe = null;
    countStaleDrawnChunks = null;
  };
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
  const lastMigrateAnomaliesRef = useRef({ missingDestination: 0, emptyDestination: 0 });
  const teleportProbeRef = useRef<(() => void) | null>(null);
  const buildFailedForRef = useRef<CityClient | null>(null);
  const updateSamplesRef = useRef<number[]>([]);

  useFrame((frameState) => {
    const client = getCityClient();
    const group = groupRef.current;
    if (!client || !group) {
      return;
    }
    if (clientRef.current !== client) {
      if (stateRef.current) {
        for (const mesh of stateRef.current.meshes) {
          group.remove(mesh);
        }
        // BatchedMesh owns the matrix/colour data textures as well as the
        // merged geometry; its own dispose is what releases them.
        for (const mesh of stateRef.current.meshes) {
          // BatchedMesh owns its matrix/colour data textures as well as the
          // merged geometry; its own dispose is what releases them.
          mesh.dispose();
          mesh.geometry.dispose();
        }
        const shared = stateRef.current.meshes[0]?.material as THREE.Material | undefined;
        shared?.dispose();
        stateRef.current = null;
      }
      clientRef.current = client;
      buildFailedForRef.current = null;
      dirtyBodiesRef.current.clear();
    }

    // Measurement bridge for the resync differential: snapshot every chunk's
    // ledger pose, force a fresh bootstrap, snapshot again — any chunk that
    // moved was desynced, whatever the streaming-path detectors said. Only
    // installed while recording.
    if (isRecording() && !(window as any).__VIBE_CITY_DEBUG__) {
      (window as any).__VIBE_CITY_DEBUG__ = {
        snapshotLedger: (): number[] => {
          const out: number[] = [];
          const count = client.topology.chunkCount;
          for (let slot = 0; slot < count; slot += 1) {
            const pose = client.topology.chunkWorldPose(slot);
            out.push(pose.position[0], pose.position[1], pose.position[2]);
          }
          return out;
        },
        requestResync: (): void => client.requestResync(),
        bootstrapCount: (): number => client.bootstrapCount,
        /**
         * The biggest live island and where it is right now. A scenario can
         * keep firing at a monolith as it tips and flies, which is the only
         * way to test whether sustained fire actually breaks it down.
         */
        largestIsland: (): { key: number; chunks: number; center: number[] } | null => {
          let best: { key: number; chunks: number } | null = null;
          for (const body of client.topology.allBodies()) {
            if (body.islandSerial === 0) continue;
            if (!best || body.chunkSlots.length > best.chunks) {
              best = { key: body.key, chunks: body.chunkSlots.length };
            }
          }
          if (!best) return null;
          const body = client.topology.body(best.key);
          if (!body) return null;
          let x = 0, y = 0, z = 0;
          for (const slot of body.chunkSlots) {
            const p = client.topology.chunkWorldPose(slot).position;
            x += p[0]; y += p[1]; z += p[2];
          }
          const n = Math.max(1, body.chunkSlots.length);
          return { key: best.key, chunks: best.chunks, center: [x / n, y / n, z / n] };
        },
      };
    }

    // Attach/detach the measurement probes as recording toggles, so a normal
    // session pays one boolean compare per frame and nothing else.
    const recording = isRecording();
    if (recording && !teleportProbeRef.current) {
      teleportProbeRef.current = installChunkTeleportProbe(client.topology.chunkCount);
      client.topology.watchPoseSources = true;
      client.topology.onAdoptionJump = (slot, stepM) => {
        recordCityEvent('city_adoption_jump', { slot, stepM });
      };
    } else if (!recording && teleportProbeRef.current) {
      teleportProbeRef.current();
      teleportProbeRef.current = null;
      client.topology.watchPoseSources = false;
      client.topology.onAdoptionJump = null;
    }

    if (!stateRef.current && buildFailedForRef.current !== client) {
      // A mesh build failure must not kill the frame loop or hide telemetry:
      // remember the failure, keep publishing stats, and let the session run
      // headless rather than retrying a throwing build every frame.
      try {
        stateRef.current = buildMesh(client);
        for (const mesh of stateRef.current.meshes) {
          group.add(mesh);
        }
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
      // Invariant scans. Both walk the ledger, so they ride the existing 2 Hz
      // telemetry cadence rather than running per frame.
      if (isRecording()) {
        const violations = client.topology.membershipViolations();
        if (violations > 0) {
          recordCityEvent('city_membership', { violations });
        }
        for (const suspect of client.topology.diagnoseFrames()) {
          recordCityEvent('city_frame_diag', suspect);
        }
        const anomalies = client.topology.migrateAnomalies;
        if (anomalies.missingDestination > lastMigrateAnomaliesRef.current.missingDestination
          || anomalies.emptyDestination > lastMigrateAnomaliesRef.current.emptyDestination) {
          recordCityEvent('city_migrate_anomaly', {
            missingDestination: anomalies.missingDestination,
            emptyDestination: anomalies.emptyDestination,
          });
          lastMigrateAnomaliesRef.current = { ...anomalies };
        }
      }
      recordCityStats({
        wireVersion: stats.wireVersion,
        chunksTotal: stats.chunksTotal,
        chunksAwake: stats.chunksAwake,
        chunksSettled: stats.chunksSettled,
        brokenBonds: stats.brokenBonds,
        liveIslands: stats.liveIslands,
        topoSeqGaps: stats.topoSeqGaps,
        bytesPerSecond: stats.bytesPerSecond,
        datagramsReceived: stats.datagramsReceived,
        chunkUpdateP95Ms: percentile(updateSamplesRef.current, 0.95),
        orphanedChunks: stats.orphanedChunks,
        chunksBelowGround,
        minChunkY: Number.isFinite(minChunkY) ? minChunkY : 0,
        // 0.5 m: comfortably above quantisation and strided-motion lag, far
        // below a chunk left at its intact pose while its island has fallen.
        staleDrawnChunks: countStaleDrawnChunks ? countStaleDrawnChunks(client, 0.5) : 0,
        floatingSettledIslands: countFloatingSettledIslands(client),
        largestIslandSpanM: (() => {
          // What the player sees is SIZE, not chunk count: a 5-chunk island of
          // bonded slabs is still a wall-sized panel. Span = longest edge of
          // the island's world AABB.
          let span = 0;
          for (const body of client.topology.allBodies()) {
            if (body.islandSerial === 0 || body.chunkSlots.length === 0) continue;
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (const slot of body.chunkSlots) {
              const p = client.topology.chunkWorldPose(slot).position;
              if (p[0] < minX) minX = p[0];
              if (p[1] < minY) minY = p[1];
              if (p[2] < minZ) minZ = p[2];
              if (p[0] > maxX) maxX = p[0];
              if (p[1] > maxY) maxY = p[1];
              if (p[2] > maxZ) maxZ = p[2];
            }
            const s = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
            if (s > span) span = s;
          }
          return span;
        })(),
        largestIslandChunks: (() => {
          // A building half that shots cannot break apart shows up here as a
          // flat line: the biggest island never shrinks however much fire it
          // takes. Excludes the intact support body (serial 0), which is the
          // whole un-fractured structure by definition.
          let largest = 0;
          for (const body of client.topology.allBodies()) {
            if (body.islandSerial === 0) continue;
            if (body.chunkSlots.length > largest) largest = body.chunkSlots.length;
          }
          return largest;
        })(),
      });
      updateCityE2E({
        wireVersion: stats.wireVersion,
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
        chunkUpdateP95Ms: percentile(updateSamplesRef.current, 0.95),
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

    // Ledger mutations that never stream (settles, promotions, migrations —
    // and everything, after a bootstrap) still have to reach the screen. The
    // dirty set only carries streaming bodies, so these ride a separate
    // one-shot queue. Adding to `dirty` (not writing directly) reuses the
    // normal write path; a repainted body that is not live gets the settling
    // final-write and then costs nothing again.
    const repaint = client.drainRepaint();
    if (repaint.all) {
      for (const body of client.topology.allBodies()) {
        dirty.add(body.key);
      }
    } else {
      for (const key of repaint.bodies) {
        if (client.topology.body(key)) dirty.add(key);
      }
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
    const touchedMeshes = new Set<number>();
    const updateStartedAt = performance.now();
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
        // Staggered by STRUCTURE, not by body. A batch re-uploads its whole
        // transform texture if any one instance in it changes, so bodies of
        // one building must defer together -- staggering them individually
        // would put at least one write in every building on every frame and
        // save nothing at all.
        if (!shouldUpdateThisFrame(frame, body.structureId, stride)) {
          continue;
        }
      }
      // A body drawn while its pose came from the raw writer is being shown at
      // the newest streamed tick rather than the interpolated one — roughly an
      // interpolation delay ahead of the frames around it. That is the
      // two-writer flicker, and this is the only place it can be observed,
      // because it depends on what the ledger holds at draw time.
      if (recording) {
        const { source, deltaM } = client.topology.poseSourceOf(key);
        if (source === 'raw' && deltaM > 0) {
          recordCityEvent('city_flicker', { body: key, deltaM, settling });
        }
      }
      const settledTint = body.settled ? 0.75 : 1;
      const probeCtx: ChunkWriteContext | undefined = recording
        ? { bodyKey: key, settling, bodySettled: body.settled }
        : undefined;
      for (const slot of body.chunkSlots) {
        const instanceId = state.instanceIds[slot];
        if (instanceId < 0) {
          continue;
        }
        const mesh = state.meshes[state.meshOfSlot[slot]];
        if (!mesh) {
          continue;
        }
        writeInstance(mesh, client, slot, state.scales, state.instanceIds, probeCtx);
        TMP_COLOR.setRGB(
          state.baseColors[slot * 3] * settledTint,
          state.baseColors[slot * 3 + 1] * settledTint,
          state.baseColors[slot * 3 + 2] * (body.settled ? 0.75 : 0.9),
        );
        mesh.setColorAt(instanceId, TMP_COLOR);
      }
      touchedMeshes.add(state.meshOfSlot[body.chunkSlots[0]] ?? -1);
      if (!live.has(key)) {
        dirty.delete(key);
      }
    }
    // A batch is culled against its bounding sphere, and debris falls outside
    // the footprint the sphere was built from. Recomputing it for batches that
    // moved keeps a spreading pile from being culled while still on screen.
    for (const index of touchedMeshes) {
      state.meshes[index]?.computeBoundingSphere();
    }
    recordUpdateMs(updateSamplesRef.current, performance.now() - updateStartedAt);
    // No needsUpdate bookkeeping: BatchedMesh writes matrices and colours
    // straight into its own data textures and flags them itself.
  });

  return <group ref={groupRef} />;
}
