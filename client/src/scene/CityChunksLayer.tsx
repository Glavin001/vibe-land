// Batched rendering of the destructible city: per-instance matrix =
// chunkWorldPose ∘ scale, composed from the streamed island-body poses + the
// manifest ledger.
//
// Intact/settled chunks are written once and frozen; only chunks belonging to
// live streaming bodies are recomposed each frame.
//
// Each render cell produces up to two objects, split by what the chunk's shape
// can share:
//
//   boxes -> one InstancedMesh. Every box is the same unit cube carrying its
//            extents in the instance matrix, so the whole cell is ONE genuine
//            instanced draw.
//   hulls -> one BatchedMesh. Fracture shards each have their own convex hull
//            and cannot be instanced; a batch is the only way to draw
//            different shapes from one call.
//
// This used to be BatchedMesh for everything, on the reasoning that a batch is
// "still a single draw call". That reasoning was wrong in the way that
// mattered. three draws a BatchedMesh with WEBGL_multi_draw and emits one
// sub-draw RANGE PER INSTANCE, so `info.render.calls` says 1 while the driver
// executes thousands of ~12-triangle draws. Measured on the bench at 100k
// chunks (tools/renderbench.mjs, /renderbench): 100,352 sub-draws, gl.render
// 15.7 ms, 57 fps. Splitting the boxes out drops it to 30,184 sub-draws,
// gl.render 4.2 ms, 149 fps -- for the same triangle count, at the same
// resolution. The frame cost tracks sub-draws, not triangles and not fill.
//
// The split is worth it because of the real shape mix, which is not what the
// old comment assumed. Downtown's manifest is 16,945 boxes against 7,160
// hulls, and the hulls are 7,160 DISTINCT shapes -- zero reuse, so the "one
// pack stamped sixteen times, dedupe turns thousands into hundreds" premise
// does not hold. Boxes are the 70% that can be instanced; hulls are the 30%
// that genuinely need the batch.

import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import type { LedgerBody } from '../city/topology';
import { shouldUpdateThisFrame, updateStrideForDistanceSq } from '../city/renderScheduling';
import {
  cityPbrLighting,
  cityTextureDetail,
  instanceShareThresholdSetting,
  onRenderQualityChange,
  shadowsEnabled,
} from '../app/renderQuality';
import { buildCityMaterial, buildCityMesh, type CityMeshState } from './cityChunkMesh';
import { loadCityTextures } from './cityTextures';
import {
  setChunkTeleportProbe,
  writeInstance,
  type ChunkWriteContext,
  type CityRenderable,
} from './cityChunkWrite';
import { updateCityE2E } from '../e2eBridge';
import { addCitySuspect, isRecording, recordCityEvent, recordCityStats } from '../netlab/recorder';
import type { CityE2EStats } from '../e2eBridge';
import {
  bodyDebug,
  bodyDebugColor,
  bodyDebugColorForCode,
  bodyDebugStateCode,
} from '../city/bodyDebugColors';
import { frameStartTime, markFrameEndAndSample, renderStats } from '../city/renderStats';
import { cityDiagnosticsWanted } from '../city/cityDiagnostics';

const TMP_MATRIX = new THREE.Matrix4();
const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();
/** Stand-in when the diagnostic sweep is skipped; consumers read length 0. */
const EMPTY_POSITIONS = new Float32Array(0);
/**
 * Scratch for one composed pose in the 2 Hz sweep (x,y,z, qx,qy,qz,qw).
 *
 * Its own, not the write path's: the sweep runs between frames and borrowing
 * that buffer would let a diagnostic clobber a transform mid-write.
 */
const TMP_POSE = new Float32Array(7);

/**
 * Centroid depth below the flat city ground (y=0) that counts as "sunk".
 * Generous: a big slab lying flat still has its centroid above -0.25 m.
 */
const CHUNK_SUNK_Y_M = -0.25;

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

/**
 * Largest believable single-frame move for a chunk, in metres.
 *
 * Debris is speed-clamped server-side at 12 m/s; at 60 fps that is 0.2 m per
 * frame, and a distance-strided chunk accumulates 8 frames of it. 1.5 m leaves
 * headroom above that so only genuine discontinuities are reported.
 */
const CHUNK_TELEPORT_M = 1.5;


/**
 * Settled islands hovering in mid-air: lowest chunk well above ground with no
 * chunk of any island beneath its column. The netcode can only show what the
 * ledger holds — if the ledger itself (confirmed against server truth by the
 * resync differential) has floating settled islands, the fault is physics
 * settling, not synchronisation. Coarse XZ hashing keeps the 2 Hz scan cheap.
 */
const FLOATING_CELL_M = 2.5;
/// XZ column key. Integer, not `${qx},${qz}`: the string form built 24k
/// throwaway strings twice a second and hashed them, for a scan whose whole
/// justification was being cheap.
function columnKey(x: number, z: number): number {
  return ((Math.round(x / FLOATING_CELL_M) & 0xffff) << 16)
    | (Math.round(z / FLOATING_CELL_M) & 0xffff);
}

function countFloatingSettledIslands(
  client: CityClient,
  positions: Float32Array,
  columns: Map<number, number>,
): number {
  let floating = 0;
  for (const body of client.topology.allBodies()) {
    if (!body.settled || body.islandSerial === 0 || body.chunkSlots.length === 0) continue;
    let minY = Infinity;
    let minSlot = -1;
    for (const slot of body.chunkSlots) {
      const y = positions[slot * 3 + 1];
      if (y < minY) {
        minY = y;
        minSlot = slot;
      }
    }
    if (minY < 1.5) continue; // near ground — supported or close enough
    const columnFloor =
      columns.get(columnKey(positions[minSlot * 3], positions[minSlot * 3 + 2])) ?? minY;
    // Nothing beneath it in its own column within 1.5 m → hovering.
    if (minY - columnFloor < 0.01 && minY > 1.5) floating += 1;
  }
  return floating;
}

/**
 * One pass over every chunk, feeding every 2 Hz diagnostic.
 *
 * These numbers used to cost five separate full sweeps -- ground probe,
 * floating-island columns, stale-draw check, island span, island size -- each
 * recomposing all 24k chunk poses through the allocating path, roughly 170k
 * arrays per sweep. They are all functions of the same position array, so it
 * is built once into reused storage and everything else reads it.
 */
const sweepPositions = { data: new Float32Array(0) };
const sweepColumns = new Map<number, number>();

function sweepChunkPositions(client: CityClient): {
  positions: Float32Array;
  columns: Map<number, number>;
  minChunkY: number;
  deepestSlot: number;
  chunksBelowGround: number;
} {
  const topology = client.topology;
  const count = topology.chunkCount;
  if (sweepPositions.data.length < count * 3) {
    sweepPositions.data = new Float32Array(count * 3);
  }
  const positions = sweepPositions.data;
  const columns = sweepColumns;
  columns.clear();
  let minChunkY = Infinity;
  let deepestSlot = -1;
  let chunksBelowGround = 0;
  // Body lookups are hoisted across a run of slots sharing one body: chunk
  // slots of the same body are contiguous far more often than not, and the
  // Map lookup was previously repeated for every chunk.
  let lastKey = -1;
  let lastBody: LedgerBody | undefined;
  for (let slot = 0; slot < count; slot += 1) {
    const key = topology.bodyKeyOf(slot);
    if (key !== lastKey) {
      lastKey = key;
      lastBody = topology.body(key);
    }
    const at = slot * 3;
    topology.chunkWorldPoseInto(slot, lastBody, TMP_POSE, 0);
    const x = TMP_POSE[0];
    const y = TMP_POSE[1];
    const z = TMP_POSE[2];
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
    if (y < minChunkY) {
      minChunkY = y;
      deepestSlot = slot;
    }
    if (y < CHUNK_SUNK_Y_M) chunksBelowGround += 1;
    const column = columnKey(x, z);
    const lowest = columns.get(column);
    if (lowest === undefined || y < lowest) columns.set(column, y);
  }
  return { positions, columns, minChunkY, deepestSlot, chunksBelowGround };
}

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
  setChunkTeleportProbe((slot, position, ctx) => {
    const base = slot * 3;
    const px = previous[base];
    const nowMs = performance.now();
    // Teleport analysis needs the write's context; stale-detection only needs
    // the position, so the builder's context-free initial writes still register.
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
          source: ctx.source ?? 'unknown',
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
  });
  return () => {
    setChunkTeleportProbe(null);
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
  const bodyDebugVersionRef = useRef(-1);
  const clientRef = useRef<CityClient | null>(null);
  const dirtyBodiesRef = useRef<Set<number>>(new Set());
  const frameCounterRef = useRef(0);
  const lastMigrateAnomaliesRef = useRef({ missingDestination: 0, emptyDestination: 0 });
  const teleportProbeRef = useRef<(() => void) | null>(null);
  const buildFailedForRef = useRef<CityClient | null>(null);
  const updateSamplesRef = useRef<number[]>([]);
  /**
   * Set when a knob changed something that is baked in at build time.
   *
   * Shadows and the material swap apply to live objects, but the pattern pool
   * decides which geometry every hull instance points at, and that is fixed
   * when the mesh is built. The teardown happens in the frame callback rather
   * than here because that is where the scene group is in scope.
   */
  const rebuildRequestedRef = useRef(false);
  /** Which shader variant the live city material was built for. */
  const materialVariantRef = useRef('');
  /** Threshold the live city mesh was built with; see the rebuild below. */
  const builtShareThresholdRef = useRef(-1);

  // Deliberately not awaited anywhere: the arrays exist from the first frame
  // filled with a neutral concrete grey, and the sheets write into them in
  // place when they land. Blocking the city on 5 MB of texture would trade a
  // visible delay for a cosmetic one.
  useEffect(loadCityTextures, []);

  // Applied to the live meshes rather than forcing a rebuild: castShadow is a
  // plain flag on the batch, and the shared material is one object swapped in
  // place. Rebuilding 24k instances to change a boolean would make the toggle
  // feel like a level reload, which defeats using it to A/B fps.
  useEffect(
    () =>
      onRenderQualityChange(({ shadows }) => {
        const renderables = stateRef.current?.renderables ?? [];
        const current = renderables[0]?.mesh.material as THREE.Material | undefined;
        // Both of these change which SHADER the city compiles, so both need a
        // new material rather than a uniform write. Compared against what was
        // last built rather than against the material's class, because the
        // texture detail is not visible from the material object at all.
        const want = `${cityPbrLighting() ? 'pbr' : 'flat'}:${cityTextureDetail()}`;
        const replacement = current && want !== materialVariantRef.current
          ? buildCityMaterial()
          : null;
        if (replacement) materialVariantRef.current = want;
        // The instancing threshold decides which shapes get a city-wide mesh,
        // which is baked in at build time -- a live material swap cannot
        // express it, so the mesh has to be rebuilt.
        if (instanceShareThresholdSetting() !== builtShareThresholdRef.current) {
          rebuildRequestedRef.current = true;
        }
        for (const { mesh } of renderables) {
          mesh.castShadow = shadows;
          mesh.receiveShadow = shadows;
          if (replacement) mesh.material = replacement;
        }
        if (replacement) current?.dispose();
      }),
    [],
  );

  useFrame((frameState) => {
    // Last frame's renderer totals (info.render resets each render pass, so
    // reading here captures the completed frame).
    const cityFrameStartedAt = performance.now();
    renderStats.beforeCityMs = cityFrameStartedAt - frameStartTime();
    markFrameEndAndSample(frameState.gl.info as never);
    renderStats.instanceWrites = 0;
    renderStats.sampleMs = 0;
    renderStats.dirtyWriteMs = 0;
    renderStats.sphereMs = 0;
    // telemetryMs is deliberately NOT reset: it runs once every 30 frames, so
    // the useful figure is the cost of one occurrence, not a zero on the 29
    // frames in between (divide by 30 for its amortised share).
    const client = getCityClient();
    const group = groupRef.current;
    if (!client || !group) {
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
      return;
    }
    if (clientRef.current !== client || rebuildRequestedRef.current) {
      rebuildRequestedRef.current = false;
      if (stateRef.current) {
        for (const { mesh } of stateRef.current.renderables) {
          group.remove(mesh);
          // Both classes own GPU state beyond the geometry -- a BatchedMesh its
          // matrix/colour data textures, an InstancedMesh its instance buffers
          // -- and their own dispose is what releases it.
          mesh.dispose();
          mesh.geometry.dispose();
        }
        const shared = stateRef.current.renderables[0]?.mesh.material as THREE.Material | undefined;
        shared?.dispose();
        stateRef.current = null;
      }
      clientRef.current = client;
      buildFailedForRef.current = null;
      dirtyBodiesRef.current.clear();
    }

    // Body-state debug repaint: when the toggle flips or fresh states arrive
    // (~1 Hz while enabled), repaint EVERY chunk once -- per-frame cost stays
    // zero, and the ordinary dirty-body path keeps freshly-moving bodies
    // correctly colored between refreshes.
    if (stateRef.current && bodyDebugVersionRef.current !== bodyDebug.version) {
      bodyDebugVersionRef.current = bodyDebug.version;
      const state = stateRef.current;
      const chunkBody = client.topology.chunkBody;
      for (let slot = 0; slot < chunkBody.length; slot += 1) {
        const instanceId = state.instanceIds[slot];
        const renderable = state.renderables[state.meshOfSlot[slot]];
        if (instanceId < 0 || !renderable) {
          continue;
        }
        const mesh = renderable.mesh;
        const key = chunkBody[slot];
        // Support serial is 0: intact structure and rooted stumps both live
        // on the client-side support body.
        const isSupport = (key & 0x3f_ffff) === 0;
        const debugColor = bodyDebug.enabled ? bodyDebugColor(key, isSupport) : null;
        if (debugColor) {
          mesh.setColorAt(instanceId, debugColor);
        } else {
          TMP_COLOR.setRGB(
            state.baseColors[slot * 3],
            state.baseColors[slot * 3 + 1],
            state.baseColors[slot * 3 + 2],
          );
          mesh.setColorAt(instanceId, TMP_COLOR);
        }
      }
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
        /// The live ledger, so a probe can wrap `apply` and attribute a jump
        /// to the exact topology message that caused it.
        topology: client.topology,
        /**
         * What is actually IN the mesh versus what the ledger says.
         *
         * Everything else compares the ledger with itself, which cannot see a
         * chunk that is drawn somewhere the ledger never put it -- and "drawn
         * in the wrong place for a frame" is precisely the reported artifact.
         * This reads the instance matrices back out of the drawn objects.
         */
        drawnVsLedger: (): { worst: number; slot: number; over: number } => {
          const meshState = stateRef.current;
          if (!meshState) return { worst: 0, slot: -1, over: 0 };
          let worst = 0;
          let worstSlot = -1;
          let over = 0;
          const count = client.topology.chunkCount;
          for (let slot = 0; slot < count; slot += 1) {
            const instanceId = meshState.instanceIds[slot];
            const renderable = meshState.renderables[meshState.meshOfSlot[slot]];
            if (instanceId < 0 || !renderable) continue;
            if (meshState.hiddenBySlot[slot] === 1) continue;
            renderable.mesh.getMatrixAt(instanceId, TMP_MATRIX);
            const pose = client.topology.chunkWorldPose(slot).position;
            const dx = TMP_MATRIX.elements[12] - pose[0];
            const dy = TMP_MATRIX.elements[13] - pose[1];
            const dz = TMP_MATRIX.elements[14] - pose[2];
            const delta = Math.hypot(dx, dy, dz);
            if (delta > worst) { worst = delta; worstSlot = slot; }
            if (delta > 0.5) over += 1;
          }
          return { worst, slot: worstSlot, over };
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
        stateRef.current = buildCityMesh(client);
        materialVariantRef.current = `${cityPbrLighting() ? 'pbr' : 'flat'}:${cityTextureDetail()}`;
        builtShareThresholdRef.current = instanceShareThresholdSetting();
        for (const { mesh } of stateRef.current.renderables) {
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
      const telemetryStartedAt = performance.now();
      const stats = client.stats();
      const prevBroken = (window as unknown as { __VIBE_CITY_BROKEN__?: number }).__VIBE_CITY_BROKEN__ ?? 0;
      if (stats.brokenBonds > prevBroken) {
        console.info('[city] brokenBonds', prevBroken, '→', stats.brokenBonds, {
          awake: stats.chunksAwake,
          settled: stats.chunksSettled,
        });
      }
      (window as unknown as { __VIBE_CITY_BROKEN__?: number }).__VIBE_CITY_BROKEN__ = stats.brokenBonds;
      // One pass for every position-derived diagnostic below: ground
      // penetration (the server world is a flat plane at y=0, so a chunk
      // centroid below it has sunk into the floor), the floating-island
      // columns, and the island-span AABBs.
      // The sweep composes the world pose of every chunk -- 3.1 ms at
      // downtown's 33,221 -- purely to derive the diagnostics below. It runs
      // only while something is reading them: the panel on screen, the netlab
      // recorder, or a spec that called `__VIBE_E2E__.setDiagnostics(true)`.
      // Unconditionally it was a 3.1 ms spike twice a second for every player,
      // including phones, where the panel is hidden by default.
      const wantSweep = cityDiagnosticsWanted() || recording;
      const sweep = wantSweep ? sweepChunkPositions(client) : null;
      const positions = sweep ? sweep.positions : EMPTY_POSITIONS;
      const minChunkY = sweep ? sweep.minChunkY : 0;
      const chunksBelowGround = sweep ? sweep.chunksBelowGround : 0;
      const deepestSlot = sweep ? sweep.deepestSlot : -1;
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
      // Both consumers below want these, and both used to compute them
      // independently -- so the city-wide stale-chunk sweep ran TWICE per
      // telemetry tick, and the percentile twice with it.
      const staleDrawnChunks = wantSweep && countStaleDrawnChunks
        ? countStaleDrawnChunks(client, 0.5)
        : 0;
      const chunkUpdateP95Ms = percentile(updateSamplesRef.current, 0.95);
      // Island statistics are derived from the sweep's positions, so without a
      // sweep there is nothing to derive them from -- and computing them anyway
      // walked every body and every chunk slot to read an empty array. One pass
      // now, not two, and only when it can produce an answer.
      let largestIslandSpanM = 0;
      let largestIslandChunks = 0;
      if (sweep) {
        for (const body of client.topology.allBodies()) {
          // Excludes the intact support body (serial 0), which is the whole
          // un-fractured structure by definition.
          if (body.islandSerial === 0 || body.chunkSlots.length === 0) continue;
          if (body.chunkSlots.length > largestIslandChunks) {
            largestIslandChunks = body.chunkSlots.length;
          }
          // What the player sees is SIZE, not chunk count: a 5-chunk island of
          // bonded slabs is still a wall-sized panel. Span = longest edge of
          // the island's world AABB.
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (const slot of body.chunkSlots) {
            const at = slot * 3;
            const px = positions[at];
            const py = positions[at + 1];
            const pz = positions[at + 2];
            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (pz < minZ) minZ = pz;
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
            if (pz > maxZ) maxZ = pz;
          }
          const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
          if (span > largestIslandSpanM) largestIslandSpanM = span;
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
        chunkUpdateP95Ms,
        orphanedChunks: stats.orphanedChunks,
        chunksBelowGround,
        minChunkY: Number.isFinite(minChunkY) ? minChunkY : 0,
        // 0.5 m: comfortably above quantisation and strided-motion lag, far
        // below a chunk left at its intact pose while its island has fallen.
        staleDrawnChunks,
        floatingSettledIslands: sweep
          ? countFloatingSettledIslands(client, positions, sweep.columns)
          : 0,
        largestIslandSpanM,
        largestIslandChunks,
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
        chunkUpdateP95Ms,
        orphanedChunks: stats.orphanedChunks,
        orphanedByRetire: stats.orphanedByRetire,
        // Same probe as the netlab line above: the only signal that catches a
        // chunk drawn away from its ledger pose.
        staleDrawnChunks,
        bootstraps: stats.bootstraps,
        settleRejects: stats.settleRejects,
        valveApplies: stats.valveApplies,
        valveTicksAhead: stats.valveTicksAhead,
        deepest,
      });
      renderStats.telemetryMs = performance.now() - telemetryStartedAt;
    }

    const state = stateRef.current;
    if (!state) {
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
      return;
    }

    const sampleStartedAt = performance.now();
    const live = client.samplePresentation(performance.now());
    renderStats.sampleMs = performance.now() - sampleStartedAt;
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
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
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
        // Staggered by CELL, not by body. An upload unit re-sends everything
        // it holds when any one instance in it changes -- a batch its whole
        // transform texture, an instanced mesh its whole matrix buffer -- so
        // bodies sharing one must defer together. Staggering them individually
        // would put at least one write in every unit on every frame and save
        // nothing at all.
        //
        // The key is the cell rather than the renderable, because a cell now
        // holds two objects (its boxes and its hulls) and a body's chunks can
        // sit in both. Keying on the renderable gave those two different
        // phases, which rewrote both on frames where neither used to move.
        //
        // And the cell rather than the structure it came from: those coincide
        // only while one structure means one building; a pack authored as a
        // whole district is a single structure, and keying on it gave every
        // body the same phase, so the entire map deferred and resumed together
        // instead of spreading across the stride window.
        const renderableIndex = state.meshOfSlot[body.chunkSlots[0]];
        const batch = renderableIndex < 0 ? 0 : state.cellOfRenderable[renderableIndex];
        if (!shouldUpdateThisFrame(frame, batch, stride)) {
          continue;
        }
      }
      // A body drawn while its pose came from the raw writer is being shown at
      // the newest streamed tick rather than the interpolated one — roughly an
      // interpolation delay ahead of the frames around it. That is the
      // two-writer flicker, and this is the only place it can be observed,
      // because it depends on what the ledger holds at draw time.
      let writeSource: string | undefined;
      if (recording) {
        const { source, deltaM } = client.topology.poseSourceOf(key);
        writeSource = source;
        if (source === 'raw' && deltaM > 0) {
          recordCityEvent('city_flicker', { body: key, deltaM, settling });
        }
      }
      const settledTint = body.settled ? 0.75 : 1;
      const debugCode = bodyDebug.enabled ? bodyDebugStateCode(key, false) : -1;
      const probeCtx: ChunkWriteContext | undefined = recording
        ? { bodyKey: key, settling, bodySettled: body.settled, source: writeSource }
        : undefined;
      for (const slot of body.chunkSlots) {
        const instanceId = state.instanceIds[slot];
        if (instanceId < 0) {
          continue;
        }
        const renderable = state.renderables[state.meshOfSlot[slot]];
        if (!renderable) {
          continue;
        }
        const mesh = renderable.mesh;
        renderStats.instanceWrites += 1;
        writeInstance(
          renderable,
          client,
          slot,
          body,
          state.scales,
          state.instanceIds,
          state.hiddenBySlot,
          state.belowStreakBySlot,
          probeCtx,
        );
        // Written every dirty frame, deliberately. Skipping writes when the
        // encoded state matched was a real saving and is REVERTED: it changes
        // what ends up in the colour texture as a function of history rather
        // than of current state, and a report of a mis-coloured, patchy city
        // is not worth a millisecond. Re-land it only with a visual check.
        {
          const debugColor = debugCode >= 0 ? bodyDebugColorForCode(debugCode) : null;
          if (debugColor) {
            mesh.setColorAt(instanceId, debugColor);
          } else {
            TMP_COLOR.setRGB(
              state.baseColors[slot * 3] * settledTint,
              state.baseColors[slot * 3 + 1] * settledTint,
              state.baseColors[slot * 3 + 2] * (body.settled ? 0.75 : 0.9),
            );
            mesh.setColorAt(instanceId, TMP_COLOR);
          }
        }
        touchedMeshes.add(state.meshOfSlot[slot]);
      }
      if (!live.has(key)) {
        dirty.delete(key);
      }
    }
    // A batch is culled against its bounding sphere, and debris falls outside
    // the footprint the sphere was built from. Recomputing it for batches that
    // moved keeps a spreading pile from being culled while still on screen.
    //
    // The cheaper scheme (grow the sphere from each written pose, re-tighten
    // one batch every 120 frames) is REVERTED. It is only correct if every
    // growth is seen, and a wrongly small sphere culls a whole batch -- a
    // block of city gone. That is indistinguishable from the report being
    // chased, and unlike the exact recompute it cannot be verified by any
    // counter this client has.
    const writeEndedAt = performance.now();
    renderStats.dirtyWriteMs = writeEndedAt - updateStartedAt;
    for (const index of touchedMeshes) {
      const renderable = state.renderables[index];
      if (!renderable) continue;
      if (renderable.kind === 'instanced') {
        // A BatchedMesh writes into its own data textures and flags them
        // itself; an InstancedMesh writes into plain buffer attributes and does
        // not, so without this the cell's chunks freeze at their build pose.
        renderable.mesh.instanceMatrix.needsUpdate = true;
        if (renderable.mesh.instanceColor) renderable.mesh.instanceColor.needsUpdate = true;
        // A pattern mesh is never sphere-tested (frustumCulled is off, because
        // it spans the map), so recomputing its sphere is pure waste -- and the
        // walk is city-wide, which made it the largest line in the frame until
        // it was skipped.
        if (!renderable.mesh.frustumCulled) continue;
      }
      renderable.mesh.computeBoundingSphere();
    }
    const sphereEndedAt = performance.now();
    renderStats.sphereMs = sphereEndedAt - writeEndedAt;
    recordUpdateMs(updateSamplesRef.current, sphereEndedAt - updateStartedAt);
    renderStats.cityFrameMs = sphereEndedAt - cityFrameStartedAt;
    // Upload bookkeeping is done above, per touched object: BatchedMesh flags
    // its own data textures, InstancedMesh has to be told.
  });

  return <group ref={groupRef} />;
}
