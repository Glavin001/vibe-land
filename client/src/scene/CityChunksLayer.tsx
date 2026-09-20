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
import { SUPPORT_SERIAL, type LedgerBody } from '../city/topology';
import { shouldUpdateThisFrame, updateStrideForDistanceSq } from '../city/renderScheduling';
import {
  cityPbrLighting,
  cityTextureDetail,
  heroTilingEnabled,
  instanceShareThresholdSetting,
  onRenderQualityChange,
  shadowsEnabled,
} from '../app/renderQuality';
import {
  buildCityMesh,
  refreshRenderableSphere,
  writeBodyPose,
  writeChunkRecord,
  type CityMeshState,
} from './cityChunkMesh';
import { loadCityTextures } from './cityTextures';
import { updateCityE2E, updateCityStructuresE2E } from '../e2eBridge';
import { POSE_SOURCES, poseTraceRecord, poseTraceWanted } from '../city/poseTrace';
import { addCitySuspect, isRecording, recordCityEvent, recordCityStats } from '../netlab/recorder';
import {
  drawnTeleportBreakdown,
  drawnTeleportTotals,
  noteAdoptionJump,
  drawCensusTotals,
  noteDrawCensus,
  noteTeleport,
  visibilityTotals,
} from '../city/debugReport';
import {
  bodyDebug,
  bodyDebugColor,
  bodyDebugColorForCode,
  bodyDebugStateCode,
} from '../city/bodyDebugColors';
import { frameStartTime, markFrameEndAndSample, renderStats } from '../city/renderStats';
import { cityDiagnosticsWanted } from '../city/cityDiagnostics';
import { cityTapeRecorder } from '../city/cityTape';
import { dustEnabled } from '../city/dustSettings';
import { CHUNK_SUNK_Y_M, deepestChunkProvenance } from '../city/chunkDiagnostics';

/** Scratch for the visual audit's replicated frustum test. */
const TMP_FRUSTUM = new THREE.Frustum();
const TMP_PROJ = new THREE.Matrix4();
const TMP_SPHERE = new THREE.Sphere();
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
    if (minSlot < 0 || minY < 1.5) continue; // near ground — supported or close enough
    const columnFloor =
      columns.get(columnKey(positions[minSlot * 3], positions[minSlot * 3 + 2])) ?? minY;
    // Nothing beneath it in its own column within 1.5 m → hovering.
    if (minY - columnFloor < 0.01 && minY > 1.5) floating += 1;
  }
  return floating;
}

/**
 * Every chunk's world position, feeding every 2 Hz diagnostic.
 *
 * These numbers used to cost five separate full sweeps -- ground probe,
 * floating-island columns, stale-draw check, island span, island size -- each
 * recomposing all 24k chunk poses through the allocating path, roughly 170k
 * arrays per sweep. They are all functions of the same position array, so it
 * is built once into reused storage and everything else reads it.
 *
 * And it is built a slice at a time: composing 49k poses in one frame was a
 * 7-11 ms hitch twice a second, which is exactly what p95 measures. The sweep
 * now advances by a thirtieth of the city every frame, so a full pass lands
 * every 30 frames -- the telemetry cadence -- at ~0.25 ms a frame, and the
 * 2 Hz block reads the most recently COMPLETED pass. A diagnostic reading a
 * position up to a quarter second old is what a 2 Hz diagnostic always was.
 */
const SWEEP_FRAMES = 30;
const sweepPositions = { data: new Float32Array(0) };
/**
 * World positions of chunks still in their structure's support body, which is
 * kinematic and never moves: composed once per ledger epoch, then copied. In a
 * collapse two thirds of the city is still standing, and composing a pose that
 * cannot have changed was two thirds of the sweep.
 */
const sweepRestWorld = { data: new Float32Array(0), valid: new Uint8Array(0), epoch: -1 };
/** Scratch for the per-frame pose trace; reused so tracing allocates nothing. */
const TRACE_POSE = new Float32Array(7);

type SweepResult = {
  positions: Float32Array;
  columns: Map<number, number>;
  minChunkY: number;
  deepestSlot: number;
  chunksBelowGround: number;
  unresolvedChunkPoses: number;
};

/** The pass in progress (slots below `cursor` are fresh) and the last complete one. */
const sweep = {
  cursor: 0,
  building: { columns: new Map<number, number>(), minChunkY: Infinity, deepestSlot: -1, chunksBelowGround: 0, unresolvedChunkPoses: 0 },
  complete: null as SweepResult | null,
  completeColumns: new Map<number, number>(),
};

function advanceChunkSweep(client: CityClient): void {
  const topology = client.topology;
  const count = topology.chunkCount;
  if (sweepPositions.data.length < count * 3) {
    sweepPositions.data = new Float32Array(count * 3);
    sweep.cursor = 0;
    sweep.complete = null;
  }
  const positions = sweepPositions.data;
  const restWorld = sweepRestWorld;
  const epoch = client.ledgerEpoch();
  if (restWorld.data.length < count * 3 || restWorld.epoch !== epoch) {
    if (restWorld.data.length < count * 3) {
      restWorld.data = new Float32Array(count * 3);
      restWorld.valid = new Uint8Array(count);
    } else {
      restWorld.valid.fill(0);
    }
    restWorld.epoch = epoch;
  }
  const building = sweep.building;
  const columns = building.columns;
  if (sweep.cursor === 0) {
    columns.clear();
    building.minChunkY = Infinity;
    building.deepestSlot = -1;
    building.chunksBelowGround = 0;
    building.unresolvedChunkPoses = 0;
  }
  const end = Math.min(count, sweep.cursor + Math.ceil(count / SWEEP_FRAMES));
  // Body lookups are hoisted across a run of slots sharing one body: chunk
  // slots of the same body are contiguous far more often than not, and the
  // Map lookup was previously repeated for every chunk.
  let lastKey = -1;
  let lastBody: LedgerBody | undefined;
  for (let slot = sweep.cursor; slot < end; slot += 1) {
    const key = topology.bodyKeyOf(slot);
    if (key !== lastKey) {
      lastKey = key;
      lastBody = topology.body(key);
    }
    const at = slot * 3;
    const standing = lastBody !== undefined && lastBody.islandSerial === SUPPORT_SERIAL;
    let x: number;
    let y: number;
    let z: number;
    if (standing && restWorld.valid[slot] === 1) {
      x = restWorld.data[at];
      y = restWorld.data[at + 1];
      z = restWorld.data[at + 2];
    } else {
      const resolved = topology.chunkWorldPoseInto(slot, lastBody, TMP_POSE, 0);
      if (!resolved || !Number.isFinite(TMP_POSE[0]) || !Number.isFinite(TMP_POSE[1])
        || !Number.isFinite(TMP_POSE[2])) {
        positions[at] = positions[at + 1] = positions[at + 2] = Number.NaN;
        building.unresolvedChunkPoses += 1;
        continue;
      }
      x = TMP_POSE[0];
      y = TMP_POSE[1];
      z = TMP_POSE[2];
      if (standing) {
        restWorld.data[at] = x;
        restWorld.data[at + 1] = y;
        restWorld.data[at + 2] = z;
        restWorld.valid[slot] = 1;
      }
    }
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
    if (y < building.minChunkY) {
      building.minChunkY = y;
      building.deepestSlot = slot;
    }
    if (y < CHUNK_SUNK_Y_M) building.chunksBelowGround += 1;
    const column = columnKey(x, z);
    const lowest = columns.get(column);
    if (lowest === undefined || y < lowest) columns.set(column, y);
  }
  sweep.cursor = end;
  if (end >= count) {
    // Pass complete: publish it, and swap the column maps so the next pass
    // builds into the one the consumers just stopped reading.
    const published = sweep.completeColumns;
    sweep.completeColumns = building.columns;
    building.columns = published;
    sweep.complete = {
      positions,
      columns: sweep.completeColumns,
      minChunkY: building.minChunkY,
      deepestSlot: building.deepestSlot,
      chunksBelowGround: building.chunksBelowGround,
      unresolvedChunkPoses: building.unresolvedChunkPoses,
    };
    sweep.cursor = 0;
  }
}

/** The most recently completed pass, or null before the first one finishes. */
function completedChunkSweep(): SweepResult | null {
  return sweep.complete;
}

/**
 * Slots whose last DRAWN position disagrees with the ledger.
 *
 * Nothing installs this any more: the GPU composes every chunk from the
 * ledger's own body pose and offset each frame, so the drawn position IS the
 * ledger's, and the only way for them to disagree -- a chunk never marked
 * for a rewrite -- no longer exists. Kept as a seam so the report field stays.
 */
const countStaleDrawnChunks: ((positions: Float32Array, count: number, toleranceM: number)
  => { checked: number; stale: number }) | null = null;

/**
 * Watch every written body pose for single-frame jumps.
 *
 * Chunks are rigid within their body and composed on the GPU from the body's
 * pose, so a chunk teleports exactly when its body's written pose does; the
 * probe reads the body writes and reports against the body's first chunk.
 * Each event carries the causal context of the write -- which body, how long
 * since its last write, and what kind of write -- because a bare step size
 * cannot distinguish "moved 2 m because it was not drawn for 500 ms" from
 * "jumped 2 m between consecutive frames".
 */
type BodyWriteContext = {
  bodyKey: number;
  slot: number;
  settling: boolean;
  bodySettled: boolean;
  source?: string;
  bodySpeed?: number;
  recentlyRebased?: boolean;
};

class BodyTeleportProbe {
  // Indexed by the GPU body index rather than keyed by body: three Map
  // operations per body write were most of the write phase once the per-chunk
  // work was gone. NaN in `previous` marks a body never seen since the reset.
  private previous = new Float32Array(0);
  private lastWriteMs = new Float32Array(0);
  private speedEst = new Float32Array(0);
  private readonly teleportStrikes = new Map<number, number>();

  private ensure(index: number): void {
    if (index * 3 + 2 < this.previous.length) return;
    let size = Math.max(4096, this.previous.length / 3);
    while (size <= index) size *= 2;
    const previous = new Float32Array(size * 3).fill(Number.NaN);
    previous.set(this.previous);
    const lastWriteMs = new Float32Array(size);
    lastWriteMs.set(this.lastWriteMs);
    const speedEst = new Float32Array(size);
    speedEst.set(this.speedEst);
    this.previous = previous;
    this.lastWriteMs = lastWriteMs;
    this.speedEst = speedEst;
  }

  /**
   * A full repaint rewrites every body from a ledger that has just been
   * replaced, so comparing those writes against what was there before
   * measures the bootstrap, not the renderer. Clearing the baseline makes
   * the next write per body a fresh start, which is what it is.
   */
  reset(): void {
    this.previous.fill(Number.NaN);
    this.lastWriteMs.fill(0);
    this.speedEst.fill(0);
  }

  /**
   * `context` is built only for a step big enough to be a teleport: the
   * ledger lookups behind it (pose source, presented speed, rebase sequence)
   * are a few hundred nanoseconds each, and at twenty thousand bodies a frame
   * that was milliseconds spent describing writes nobody would ever read.
   */
  observe(index: number, position: ArrayLike<number>, nowMs: number, context: () => BodyWriteContext): void {
    this.ensure(index);
    const at = index * 3;
    const px = this.previous[at];
    if (!Number.isNaN(px)) {
      const dx = position[0] - px;
      const dy = position[1] - this.previous[at + 1];
      const dz = position[2] - this.previous[at + 2];
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gapSec = Math.max((nowMs - this.lastWriteMs[index]) / 1000, 1 / 240);
      const est = this.speedEst[index];
      this.speedEst[index] = 0.7 * est + 0.3 * (step / gapSec);
      if (step > CHUNK_TELEPORT_M) this.judge(step, gapSec, est, position, nowMs, index, context());
    }
    this.previous[at] = position[0];
    this.previous[at + 1] = position[1];
    this.previous[at + 2] = position[2];
    this.lastWriteMs[index] = nowMs;
  }

  private judge(
    step: number,
    gapSec: number,
    est: number,
    position: ArrayLike<number>,
    nowMs: number,
    index: number,
    ctx: BodyWriteContext,
  ): void {
    {
      // Judge the step against what this body's trajectory can account for,
      // not a flat bound: debris legitimately flies at 40-70 m/s, and a
      // distant body on an 8-frame stride covers multiple metres per write.
      const known = Math.max(est, ctx.bodySpeed ?? 0);
      const explained = 3 * known * gapSec + 0.3;
      if (step > explained) {
        noteTeleport({
          slot: ctx.slot,
          stepM: step,
          body: ctx.bodyKey,
          source: ctx.source ?? 'unknown',
          x: position[0],
          y: position[1],
          z: position[2],
          settling: ctx.settling,
          bodySettled: ctx.bodySettled,
          recentlyRebased: ctx.recentlyRebased,
        });
        recordCityEvent('city_chunk_teleport', {
          slot: ctx.slot,
          stepM: step,
          body: ctx.bodyKey,
          settling: ctx.settling,
          bodySettled: ctx.bodySettled,
          source: ctx.source ?? 'unknown',
          sinceLastWriteMs: Math.round(nowMs - this.lastWriteMs[index]),
          x: position[0],
          y: position[1],
          z: position[2],
        });
        // Repeated teleports on one body: tap its raw record stream so the
        // wire trajectory itself becomes inspectable.
        const strikes = (this.teleportStrikes.get(ctx.bodyKey) ?? 0) + 1;
        this.teleportStrikes.set(ctx.bodyKey, strikes);
        if (strikes === 3) addCitySuspect(ctx.bodyKey);
      }
    }
  }

  /** A body index about to be reused by another body starts fresh. */
  forget(index: number): void {
    if (index * 3 + 2 >= this.previous.length) return;
    this.previous[index * 3] = Number.NaN;
    this.lastWriteMs[index] = 0;
    this.speedEst[index] = 0;
  }
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
  /** Bootstraps + repairs seen, to spot a ledger the probe cannot compare across. */
  const lastLedgerEpochRef = useRef(-1);
  const lastCamRef = useRef({
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    set: false,
  });
  const teleportProbeRef = useRef<BodyTeleportProbe>(new BodyTeleportProbe());
  /** Set when the debug palette changed; every body is recoloured on the next frame. */
  const repaintBodiesRef = useRef(false);
  /** Slots whose record could not be written yet (their body is not in the ledger). */
  const pendingRecordsRef = useRef<Set<number>>(new Set());
  const recorderProbesRef = useRef(false);
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
        const want = `${cityPbrLighting() ? 'pbr' : 'flat'}:${cityTextureDetail()}:${heroTilingEnabled() ? 'hero' : 'plain'}`;
        // Every cell mesh owns its material (the pose textures ride on it),
        // so a shader variant change is a rebuild rather than a swap.
        if (current && want !== materialVariantRef.current) {
          materialVariantRef.current = want;
          rebuildRequestedRef.current = true;
        }
        // The instancing threshold decides which shapes get a city-wide mesh,
        // which is baked in at build time -- a live material swap cannot
        // express it, so the mesh has to be rebuilt.
        if (instanceShareThresholdSetting() !== builtShareThresholdRef.current) {
          rebuildRequestedRef.current = true;
        }
        for (const { mesh } of renderables) {
          mesh.castShadow = shadows;
          mesh.receiveShadow = shadows;
        }
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
        for (const renderable of stateRef.current.renderables) {
          const { mesh } = renderable;
          group.remove(mesh);
          // Every class owns GPU state beyond the geometry -- a BatchedMesh its
          // matrix/colour data textures, an InstancedMesh its instance buffers,
          // a slot mesh its matrices texture -- and their own dispose is what
          // releases it. A slot mesh also owns its material (the texture rides
          // on it as a uniform); the others share the city material below.
          mesh.dispose();
          mesh.geometry.dispose();
        }
        for (const material of stateRef.current.materials) material.dispose();
        stateRef.current.poses.dispose();
        stateRef.current = null;
      }
      clientRef.current = client;
      buildFailedForRef.current = null;
      dirtyBodiesRef.current.clear();
      // What a harness can aim at, from the manifest the client decoded.
      updateCityStructuresE2E(client.manifest.manifest.structures.map((structure) => ({
        structureId: structure.structureId,
        position: [structure.worldPosition[0], structure.worldPosition[1], structure.worldPosition[2]],
        top: structure.chunks.reduce((top, chunk) => Math.max(top, chunk.centroid[1]), -Infinity),
        chunks: structure.chunks.length,
      })));
    }

    // Body-state debug repaint: when the toggle flips or fresh states arrive
    // (~1 Hz while enabled), every body is rewritten once with its palette
    // colour -- a body pose write is where colour lives now.
    if (stateRef.current && bodyDebugVersionRef.current !== bodyDebug.version) {
      bodyDebugVersionRef.current = bodyDebug.version;
      repaintBodiesRef.current = true;
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
            // Composed on the CPU exactly as the shader composes it, from the
            // records and body poses the GPU reads.
            if (!meshState.poses.chunkWorldPositionInto(slot, TMP_POSE)) continue;
            const pose = client.topology.chunkWorldPose(slot).position;
            const dx = TMP_POSE[0] - pose[0];
            const dy = TMP_POSE[1] - pose[1];
            const dz = TMP_POSE[2] - pose[2];
            const delta = Math.hypot(dx, dy, dz);
            if (delta > worst) { worst = delta; worstSlot = slot; }
            if (delta > 0.5) over += 1;
          }
          return { worst, slot: worstSlot, over };
        },
      };
    }

    // The teleport probe is now ALWAYS installed: SEND REPORT ships its ring
    // from ordinary sessions, and the probe's cost is one compare and three
    // stores per DIRTY chunk write (~1.4k/frame at worst — micrometers next
    // to the sample pass). The recorder-only extras (pose-source tagging,
    // adoption-jump events) stay gated on recording.
    const recording = isRecording();
    const teleportProbe = teleportProbeRef.current;
    // Pose-source tagging and adoption jumps are no longer recorder-only.
    //
    // They were, and it made ordinary sessions unable to answer the one
    // question players actually ask. A SEND REPORT from a real session carried
    // a ring of chunk teleports in which 97% were tagged `unknown`, because the
    // tag is written by this probe and this probe was off; and it carried no
    // adoption jumps at all, because that listener was never installed. The
    // flicker people see happens on their machine, not in a measurement run.
    //
    // The cost is two map writes per body whose pose changed, and a callback
    // that fires only when a re-parent actually moved a chunk. Next to the
    // per-chunk matrix compose happening in the same loop it does not register.
    if (!recorderProbesRef.current) {
      recorderProbesRef.current = true;
      client.topology.watchPoseSources = true;
      client.topology.onAdoptionJump = (slot, stepM) => {
        noteAdoptionJump(slot, stepM);
        recordCityEvent('city_adoption_jump', { slot, stepM });
      };
    }

    if (!stateRef.current && buildFailedForRef.current !== client) {
      // A mesh build failure must not kill the frame loop or hide telemetry:
      // remember the failure, keep publishing stats, and let the session run
      // headless rather than retrying a throwing build every frame.
      try {
        stateRef.current = buildCityMesh(client);
        lastLedgerEpochRef.current = client.ledgerEpoch();
        teleportProbe.reset();
        materialVariantRef.current = `${cityPbrLighting() ? 'pbr' : 'flat'}:${cityTextureDetail()}:${heroTilingEnabled() ? 'hero' : 'plain'}`;
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

    // Per-frame pose trace, for a capture harness only.
    //
    // Deliberately NOT inside the telemetry block below: that runs one frame
    // in thirty, so a trace taken there samples at 2 Hz while claiming to be
    // per-frame -- which is exactly what a jump between consecutive frames
    // would hide. Only the traced slots are composed, so the cost is the
    // sample size rather than the whole city.
    if (poseTraceWanted()) {
      const traceTopology = client.topology;
      poseTraceRecord(
        client.renderClockTickForTrace?.() ?? -1,
        performance.now(),
        (slot, out) => {
          if (slot < 0 || slot >= traceTopology.chunkCount) return false;
          const body = traceTopology.body(traceTopology.bodyKeyOf(slot));
          const resolved = traceTopology.chunkWorldPoseInto(slot, body, TRACE_POSE, 0);
          if (!resolved) return false;
          out[0] = TRACE_POSE[0];
          out[1] = TRACE_POSE[1];
          out[2] = TRACE_POSE[2];
          return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
        },
        // Both terms of the composition, plus which body the chunk is in.
        (slot, terms) => {
          if (slot < 0 || slot >= traceTopology.chunkCount) return;
          const key = traceTopology.bodyKeyOf(slot);
          terms.bodyKey = key;
          const written = traceTopology.poseSourceOf(key).source;
          terms.sourceIndex = written ? POSE_SOURCES.indexOf(written) : -1;
          traceTopology.localOffsetInto(slot, terms.localOffset);
          const body = traceTopology.body(key);
          if (!body) return;
          terms.bodyPosition[0] = body.position[0];
          terms.bodyPosition[1] = body.position[1];
          terms.bodyPosition[2] = body.position[2];
          terms.bodyRotation[0] = body.rotation[0];
          terms.bodyRotation[1] = body.rotation[1];
          terms.bodyRotation[2] = body.rotation[2];
          terms.bodyRotation[3] = body.rotation[3];
        },
      );
    }

    // A slice of the diagnostic position sweep every frame, only while
    // something reads the diagnostics -- the panel, the recorder, a spec.
    if (cityDiagnosticsWanted() || recording) {
      const sweepStartedAt = performance.now();
      advanceChunkSweep(client);
      renderStats.sweepSliceMs = performance.now() - sweepStartedAt;
    } else {
      renderStats.sweepSliceMs = 0;
    }

    if (frameCounterRef.current % 30 === 0) {
      const telemetryStartedAt = performance.now();
      const stats = client.stats();
      cityTapeRecorder.noteAwake(stats.chunksAwake);
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
      const sweep = wantSweep ? completedChunkSweep() : null;
      const positions = sweep ? sweep.positions : EMPTY_POSITIONS;
      const minChunkY = sweep ? sweep.minChunkY : 0;
      const chunksBelowGround = sweep ? sweep.chunksBelowGround : 0;
      const deepestSlot = sweep ? sweep.deepestSlot : -1;
      // Report the same depth range as the counter, with enough information
      // to reconstruct body-pose × local-offset composition. A positive body
      // origin alone does not prove every rotated chunk is above ground.
      const deepest = sweep
        ? deepestChunkProvenance(client.topology, deepestSlot, positions)
        : null;
      const sweepUnixMs = sweep ? Date.now() : null;
      const sweepPerformanceMs = sweep ? performance.now() : null;
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
      const drawnCheck = sweep && countStaleDrawnChunks
        ? countStaleDrawnChunks(positions, client.topology.chunkCount, 0.5)
        : { checked: 0, stale: 0 };
      const staleDrawnChunks = drawnCheck.stale;
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
        sampleDelayTicks: stats.sampleDelayTicks,
        arrivalLatenessTicks: stats.arrivalLatenessTicks,
        arrivalLatenessPeakTicks: stats.arrivalLatenessPeakTicks,
        manifestHash: stats.manifestHash,
        dust: {
          enabled: dustEnabled(),
          sourcesTotal: stats.dustSources,
          parcelsEmitted: renderStats.dustEmitted,
          parcelsLive: renderStats.dustParcelsLive,
          parcelsDrawn: renderStats.dustDrawn + renderStats.dustDrawnHalf,
          dropped: renderStats.dustDropped + stats.dustQueueDropped,
          entries: stats.dustEntries,
          impacts: stats.dustImpacts,
          waves: stats.dustWaves,
        },
        rendered: stateRef.current != null,
        minChunkY: Number.isFinite(minChunkY) ? minChunkY : 0,
        chunksBelowGround,
        chunkUpdateP95Ms,
        orphanedChunks: stats.orphanedChunks,
        orphanedByRetire: stats.orphanedByRetire,
        poseJumpsOver1m: stats.poseJumpsOver1m,
        poseJumpsOver4m: stats.poseJumpsOver4m,
        poseJumpsOver16m: stats.poseJumpsOver16m,
        poseJumpMaxM: stats.poseJumpMaxM,
        presentedJumpsOver1m: stats.presentedJumpsOver1m,
        presentedJumpsOver4m: stats.presentedJumpsOver4m,
        presentedJumpMaxM: stats.presentedJumpMaxM,
        chunksHidden: renderStats.chunksHidden,
        chunksUnhidden: renderStats.chunksUnhidden,
        visibilityFlips: visibilityTotals(),
        // The visual audit: every remaining way a chunk that should be drawn
        // is not. See the block at the end of the frame callback.
        visualAudit: {
          cellsCulled: renderStats.cellsCulled,
          culledLiveChunks: renderStats.culledLiveChunks,
          worstCulledLiveChunks: renderStats.worstCulledLiveChunks,
          worstCulledAabbM: renderStats.worstCulledAabbM,
          shellWakes: renderStats.shellWakes,
          staleLiveBodies: renderStats.staleLiveBodies,
          staleLiveChunks: renderStats.staleLiveChunks,
          chunksUnresolved: renderStats.chunksUnresolved,
          subDraws: renderStats.subDraws,
          instanceWrites: renderStats.instanceWrites,
          ...drawCensusTotals(),
        },
        drawnTeleportBy: drawnTeleportBreakdown(),
        drawnTeleports: drawnTeleportTotals().count,
        drawnTeleportWorstM: drawnTeleportTotals().worstM,
        drawnTeleportMetres: drawnTeleportTotals().metres,
        reoffsets: stats.reoffsets,
        reoffsetMetres: stats.reoffsetMetres,
        adoptionJumps: stats.adoptionJumps,
        adoptionJumpMaxM: stats.adoptionJumpMaxM,
        adoptionJumpMetres: stats.adoptionJumpMetres,
        adoptionJumpsFromMigration: stats.adoptionJumpsFromMigration,
        adoptionJumpMetresFromMigration: stats.adoptionJumpMetresFromMigration,
        presentedJumpChunks: stats.presentedJumpChunks,
        presentedJumpWorstChunks: stats.presentedJumpWorstChunks,
        presentedJumpWorstChunksM: stats.presentedJumpWorstChunksM,
        correctionSnaps: stats.correctionSnaps,
        clockRollbacks: stats.clockRollbacks,
        implausibleJumps: stats.implausibleJumps,
        presentationAnomalyMaxM: stats.presentationAnomalyMaxM,
        recordsOutsideWorld: stats.recordsOutsideWorld,
        renderClockReanchorsRefused: stats.renderClockReanchorsRefused,
        bootstrapPosesSeen: stats.bootstrapPosesSeen,
        bootstrapPosesGone: stats.bootstrapPosesGone,
        bootstrapPosesGlided: stats.bootstrapPosesGlided,
        bootstrapPosesSnapped: stats.bootstrapPosesSnapped,
        repairBodiesGlided: stats.repairBodiesGlided,
        wakeSeeds: stats.wakeSeeds,
        starvedReadmissions: stats.starvedReadmissions,
        settlesRestored: stats.settlesRestored,
        settlesLeftHard: stats.settlesLeftHard,
        promotionsSeen: stats.promotionsSeen,
        promotionsSeeded: stats.promotionsSeeded,
        promotionsSeedSkippedReused: stats.promotionsSeedSkippedReused,
        promotionsSeedSkippedNoBody: stats.promotionsSeedSkippedNoBody,
        promotionsSeedSkippedNoDrawnPose: stats.promotionsSeedSkippedNoDrawnPose,
        promotionsUnseeded: stats.promotionsUnseeded,
        // Same probe as the netlab line above: the only signal that catches a
        // chunk drawn away from its ledger pose.
        staleDrawnChunks,
        bootstraps: stats.bootstraps,
        settleRejects: stats.settleRejects,
        valveApplies: stats.valveApplies,
        valveTicksAhead: stats.valveTicksAhead,
        hashChecks: stats.hashChecks,
        hashMismatches: stats.hashMismatches,
        structureRepairs: stats.structureRepairs,
        deepest,
        diagnosticSweep: {
          performed: sweep !== null,
          capturedAtUnixMs: sweepUnixMs,
          capturedAtPerformanceMs: sweepPerformanceMs,
          topologySeq: client.topology.lastSeq(),
          validChunkPoses: sweep ? client.topology.chunkCount - sweep.unresolvedChunkPoses : 0,
          unresolvedChunkPoses: sweep ? sweep.unresolvedChunkPoses : 0,
          staleDrawProbeInstalled: countStaleDrawnChunks !== null,
          drawnChunkPosesChecked: drawnCheck.checked,
        },
      });
      renderStats.telemetryMs = performance.now() - telemetryStartedAt;
    }

    const state = stateRef.current;
    if (!state) {
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
      return;
    }

    // One stride decision per body per frame, shared by the sampler and the
    // write loop below so the two can never disagree about whether a body is
    // due: a body sampled but not written wastes the sample, and one written
    // but not sampled is drawn a stride late.
    const cameraNow = frameState.camera.position;
    const frameNow = frameCounterRef.current;
    // Staggered by body key. It used to be by cell, because a cell's upload
    // unit re-sent everything it held when any one instance in it changed;
    // the body pose texture is one upload a frame whatever moved, so the
    // stagger is free to spread the work as evenly as it can, and needs no
    // lookup to do it.
    const dueThisFrame = (key: number, at: ArrayLike<number> | null): boolean => {
      if (!at) return true;
      const dx = at[0] - cameraNow.x;
      const dy = at[1] - cameraNow.y;
      const dz = at[2] - cameraNow.z;
      const stride = updateStrideForDistanceSq(dx * dx + dy * dy + dz * dz);
      if (stride <= 1) return true;
      return shouldUpdateThisFrame(frameNow, key, stride);
    };
    const sampleStartedAt = performance.now();
    const live = client.samplePresentation(performance.now(), dueThisFrame);
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
    // The ledger was replaced wholesale; nothing written before it is
    // comparable with anything written after. `repaint.all` catches most of
    // it, and a bootstrap or a structure repair rewrites every body of a
    // structure without necessarily setting it -- which left 24,105 events,
    // one per chunk, in runs that had one, and those runs were the ones that
    // looked catastrophic.
    const ledgerEpoch = client.ledgerEpoch();
    // A ledger replaced wholesale (a bootstrap) or a structure rewritten (a
    // repair) means every chunk record and every body pose is suspect:
    // rewrite them all. Otherwise the ledger names exactly the slots it
    // reassigned since last frame.
    const rebuildRecords = repaint.all || ledgerEpoch !== lastLedgerEpochRef.current;
    if (rebuildRecords) {
      lastLedgerEpochRef.current = ledgerEpoch;
      teleportProbe.reset();
    }
    if (repaint.all || rebuildRecords || repaintBodiesRef.current) {
      for (const body of client.topology.allBodies()) {
        dirty.add(body.key);
      }
    } else {
      for (const key of repaint.bodies) {
        if (client.topology.body(key)) dirty.add(key);
      }
    }
    const repaintBodies = repaintBodiesRef.current;
    repaintBodiesRef.current = false;
    state.poses.bodyColoursUniform.value = bodyDebug.enabled ? 1 : 0;
    // Chunk records: which body each chunk rides and where it sits on it.
    const recordStartedAt = performance.now();
    const touchedMeshes = new Set<number>();
    let recordsWritten = 0;
    if (rebuildRecords) {
      const count = client.topology.chunkCount;
      client.topology.drainSlotChanges();
      pendingRecordsRef.current.clear();
      for (let slot = 0; slot < count; slot += 1) {
        if (!writeChunkRecord(state, client, slot)) pendingRecordsRef.current.add(slot);
        recordsWritten += 1;
      }
      for (let index = 0; index < state.renderables.length; index += 1) touchedMeshes.add(index);
    } else {
      const pending = pendingRecordsRef.current;
      for (const slot of client.topology.drainSlotChanges()) pending.add(slot);
      for (const slot of pending) {
        // A chunk whose body the ledger cannot name yet keeps drawing where
        // it was; try again next frame.
        if (!writeChunkRecord(state, client, slot)) continue;
        pending.delete(slot);
        recordsWritten += 1;
        touchedMeshes.add(state.meshOfSlot[slot]);
      }
    }
    renderStats.recordWrites = recordsWritten;
    renderStats.recordWriteMs = performance.now() - recordStartedAt;

    if (dirty.size === 0 && touchedMeshes.size === 0) {
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
      return;
    }
    // Body poses. Rewriting every moving body every frame is the client's
    // per-frame cost once a demolition is large; distant bodies are written on
    // a stride instead, staggered by cell so the deferred work spreads across
    // frames rather than spiking on one.
    //
    // This is a render-rate decision only. The authoritative pose is whatever
    // the ledger holds; deferring a write delays when a distant body is
    // redrawn, it never changes where it is.
    const updateStartedAt = performance.now();
    const writeNowMs = updateStartedAt;
    // Chunks written this frame per mesh, so a culled cell can say how much
    // live geometry it was holding when it went off screen.
    const liveChunksPerMesh: number[] = [];
    let drawnThisFrame = 0;
    for (const key of dirty) {
      const body = client.topology.body(key);
      if (!body) {
        dirty.delete(key);
        if (state.poses.hasBody(key)) teleportProbe.forget(state.poses.bodyIndexFor(key));
        state.poses.releaseBody(key);
        continue;
      }
      // A body that stopped moving gets its final write unconditionally.
      // Deferring that one would strand it at its second-to-last pose for
      // good, since no further frame will list it as live.
      const settling = !live.has(key);
      if (!settling && !repaintBodies && !dueThisFrame(key, body.position)) {
        continue;
      }
      // A body drawn while its pose came from the raw writer is being shown at
      // the newest streamed tick rather than the interpolated one -- roughly an
      // interpolation delay ahead of the frames around it. That is the
      // two-writer flicker, and this is the only place it can be observed,
      // because it depends on what the ledger holds at draw time. Recorder
      // only: the lookup is per body per frame.
      if (recording) {
        const { source: writeSource, deltaM: writeDeltaM } = client.topology.poseSourceOf(key);
        if (writeSource === 'raw' && writeDeltaM > 0) {
          recordCityEvent('city_flicker', { body: key, deltaM: writeDeltaM, settling });
        }
      }
      const debugCode = bodyDebug.enabled ? bodyDebugStateCode(key, false) : -1;
      const debugColor = debugCode >= 0 ? bodyDebugColorForCode(debugCode) : null;
      // Settled rubble is dimmed, and live debris very slightly warmed, as the
      // per-chunk colour writes used to do.
      const bodyIsSupport = (key & 0x3f_ffff) === 0;
      writeBodyPose(
        state,
        body,
        body.settled ? 0.75 : 1,
        debugColor ?? (body.settled || bodyIsSupport ? null : TMP_COLOR.setRGB(1, 1, 0.9)),
      );
      teleportProbe.observe(state.poses.bodyIndexFor(key), body.position, writeNowMs, () => ({
        bodyKey: key,
        slot: body.chunkSlots[0] ?? -1,
        settling,
        bodySettled: body.settled,
        source: client.topology.poseSourceOf(key).source,
        bodySpeed: client.bodyPresentedSpeed(key),
        // Was this body's island frame rebased in the last few batches? A
        // rebase is supposed to leave every composed world pose untouched.
        recentlyRebased:
          client.topology.currentReoffsetSeq() - client.topology.reoffsetSeqOf(key) < 64
          && client.topology.reoffsetSeqOf(key) >= 0,
      }));
      renderStats.instanceWrites += 1;
      // The cells this body's chunks sit in: their culling spheres follow it.
      // Support serial 0 is the intact structure, at rest by definition; its
      // chunks are not counted as live geometry.
      for (const slot of body.chunkSlots) {
        const meshIndex = state.meshOfSlot[slot];
        if (meshIndex < 0) continue;
        touchedMeshes.add(meshIndex);
        if (!bodyIsSupport) {
          liveChunksPerMesh[meshIndex] = (liveChunksPerMesh[meshIndex] ?? 0) + 1;
          drawnThisFrame += 1;
        }
      }
      if (!live.has(key)) {
        dirty.delete(key);
      }
    }
    state.poses.upload();
    const writeEndedAt = performance.now();
    renderStats.dirtyWriteMs = writeEndedAt - updateStartedAt;
    // A cell is culled against its bounding sphere, and debris falls outside
    // the footprint the sphere was built from. Re-deriving it for cells whose
    // bodies moved keeps a spreading pile from being culled while still on
    // screen. See refreshRenderableSphere for why it is exact-conservative on
    // every call rather than grown from history.
    for (const index of touchedMeshes) {
      refreshRenderableSphere(state, index);
    }

    // ---- Visual audit -------------------------------------------------
    //
    // Everything above decides what ends up on screen, and until now each
    // part of it was instrumented only after it became a suspect. These are
    // the remaining paths by which a chunk that should be drawn is not, or is
    // drawn somewhere it should not be, measured every frame so a report from
    // a live session can answer the question rather than narrow it:
    //
    //   1. hidden below the world            -- chunksHidden / chunksUnhidden
    //   2. culled with the cell it lives in  -- cellsCulled, below
    //   3. still in the shell, or between it and its own instance -- shellWakes
    //   4. deferred by the distance stride   -- staleLiveChunks
    //   5. no instance seated at all         -- chunksUnresolved
    //   6. drawn, but somewhere wrong        -- the teleport probe
    //
    // The frustum test is replicated rather than read back, because three does
    // it inside the renderer and reports nothing. It is one sphere test per
    // cell, and there are a few dozen cells.
    {
      let culled = 0;
      let culledLiveChunks = 0;
      let worstCulled = { body: 0, chunks: 0, aabbM: 0 };
      const cam = frameState.camera;
      cam.updateMatrixWorld();
      TMP_PROJ.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      TMP_FRUSTUM.setFromProjectionMatrix(TMP_PROJ);
      for (let index = 0; index < state.renderables.length; index += 1) {
        const renderable = state.renderables[index];
        if (!renderable || !renderable.mesh.frustumCulled) continue;
        const sphere = renderable.mesh.boundingSphere;
        if (!sphere) continue;
        TMP_SPHERE.copy(sphere).applyMatrix4(renderable.mesh.matrixWorld);
        if (TMP_FRUSTUM.intersectsSphere(TMP_SPHERE)) continue;
        culled += 1;
        // A cell culled while it holds moving chunks is the case worth
        // knowing about: the sphere says it is off screen and the chunks in
        // it may not be.
        const liveHere = liveChunksPerMesh[index] ?? 0;
        if (liveHere > 0) {
          culledLiveChunks += liveHere;
          if (liveHere > worstCulled.chunks) {
            worstCulled = { body: 0, chunks: liveHere, aabbM: sphere.radius * 2 };
          }
        }
      }
      renderStats.cellsCulled = culled;
      renderStats.culledLiveChunks = culledLiveChunks;
      if (culledLiveChunks > renderStats.worstCulledLiveChunks) {
        renderStats.worstCulledLiveChunks = culledLiveChunks;
        renderStats.worstCulledAabbM = worstCulled.aabbM;
      }
      // Camera motion, so a look-away is not mistaken for the city vanishing.
      const camPos = cam.position;
      const moved =
        lastCamRef.current.set
        && (camPos.distanceToSquared(lastCamRef.current.pos) > 0.02
          || cam.quaternion.angleTo(lastCamRef.current.quat) > 0.01);
      lastCamRef.current.pos.copy(camPos);
      lastCamRef.current.quat.copy(cam.quaternion);
      lastCamRef.current.set = true;
      noteDrawCensus(drawnThisFrame, worstCulled, moved);
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
