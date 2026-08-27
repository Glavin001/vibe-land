// Reproducible render benchmark for the destructible city path.
//
//   /renderbench?chunks=100000&live=4000&shadows=1&tier=pretty
//
// The scene is generated from a seed (see bench/syntheticCity.ts) rather than
// streamed from the server, and the camera runs a fixed path, so two runs draw
// the same pixels in the same order. That is the whole point: the live /city
// measured 4 and 28 draw calls on consecutive runs at the same heading, which
// is more spread than any optimization worth making.
//
// It reuses the real policy modules -- chunkGeometry for shapes,
// renderScheduling for cell partitioning and distance striding, renderStats for
// the frame breakdown -- so what it measures is the shipping renderer, not a
// model of it. The batch construction below mirrors scene/cityChunkMesh.ts; it
// is deliberately a separate copy, because that builder is welded to CityClient
// and the ledger, and neither exists here.

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { buildSyntheticCity, type SyntheticCity } from '../bench/syntheticCity';
import { buildBoxGeometry, buildHullGeometry } from '../city/chunkGeometry';
import {
  partitionSlotsByCell,
  shouldUpdateThisFrame,
  updateStrideForDistanceSq,
} from '../city/renderScheduling';
import {
  frameStartTime,
  markFrameEndAndSample,
  renderStats,
} from '../city/renderStats';
import {
  antialiasEnabled,
  cityPbrLighting,
  flatToneMapping,
  maxDpr,
  setQualityTier,
  setShadowsEnabled,
  shadowsEnabled,
} from '../app/renderQuality';
import { FrameClock } from '../scene/FrameClock';

const TMP_MATRIX = new THREE.Matrix4();
const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const TMP_AXIS = new THREE.Vector3();
const TMP_COLOR = new THREE.Color();

/**
 * How chunks are handed to the GPU.
 *
 * `batched` is what ships: one BatchedMesh per cell, every shape in one buffer.
 * It reports as a single draw call, but three emits one multi-draw *sub-draw*
 * per instance, so a cell of 2,000 chunks is 2,000 ranges of ~12 triangles.
 *
 * `hybrid` splits on what the real manifest actually contains -- 70% of chunks
 * are boxes sharing one unit cube, and the other 30% are convex hulls that are
 * unique per chunk (measured: 7,160 hulls, 7,160 distinct shapes, zero reuse).
 * Boxes go to an InstancedMesh, which is one genuine instanced draw for the
 * whole cell; hulls keep the BatchedMesh, which is the right tool for shapes
 * that cannot be instanced.
 */
// `pooled` tests the fracture-pool proposal: if shards were drawn from a
// shared library of patterns instead of being unique per chunk, hulls could be
// instanced too -- one InstancedMesh per (cell x pattern) rather than one
// sub-draw per shard. `hulls`/`hullVariants` set the mix and the pool size, so
// the sweep answers "how small can the library be" with a number.
// `pooled-global` removes the ceiling `pooled` hits. Per-cell instancing costs
// cells x patterns REAL draw calls, and a real draw call is dearer than a
// multi-draw sub-draw, so past a few dozen patterns it loses to batching. Keyed
// globally the cost is O(patterns) regardless of city size -- at the price of
// frustum culling, since one pattern's mesh spans the whole map and its sphere
// always intersects.
type BenchMode = 'batched' | 'hybrid' | 'pooled' | 'pooled-global';

type BenchConfig = {
  chunks: number;
  live: number;
  towers?: number;
  hullFraction: number;
  /** Distinct shard shapes available. The pool size the proposal is about. */
  hullVariants: number;
  seed: number;
  mode: BenchMode;
  /** Camera orbit radius as a multiple of the city's half-extent. */
  orbit: number;
  /** Seconds for one full orbit. Fixed so the path is time-parameterised. */
  orbitSeconds: number;
  far: number;
};

function readConfig(): BenchConfig {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number): number => {
    const raw = params.get(key);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  // Quality knobs go through the real store so the bench and the game cannot
  // diverge on what "fast" means.
  const tier = params.get('tier');
  if (tier === 'fast' || tier === 'pretty') setQualityTier(tier);
  const shadows = params.get('shadows');
  if (shadows === '0' || shadows === '1') setShadowsEnabled(shadows === '1');
  const mode = params.get('mode');
  return {
    chunks: Math.max(16, num('chunks', 24000)),
    live: Math.max(0, num('live', 0)),
    towers: params.get('towers') ? num('towers', 0) : undefined,
    // 0.3 is the real downtown mix: 7,160 hulls against 16,945 boxes.
    hullFraction: Math.min(1, Math.max(0, num('hulls', 0.3))),
    seed: num('seed', 1),
    mode: mode === 'hybrid' || mode === 'pooled' || mode === 'pooled-global'
      ? mode
      : 'batched',
    hullVariants: Math.max(1, num('hullVariants', 32)),
    orbit: num('orbit', 0.9),
    orbitSeconds: num('orbitSeconds', 40),
    far: num('far', 200),
  };
}

/**
 * One drawable unit. Cells produce a BatchedMesh, an InstancedMesh, or both.
 *
 * The two are kept behind one list so the write loop and the sphere recompute
 * do not branch per chunk -- only per renderable, once.
 */
type Renderable =
  | { kind: 'batched'; mesh: THREE.BatchedMesh }
  | { kind: 'instanced'; mesh: THREE.InstancedMesh };

type BenchMeshState = {
  renderables: Renderable[];
  /** Chunk -> index into `renderables`. */
  meshOfChunk: Int32Array;
  /** Chunk -> instance id within its renderable. */
  instanceIds: Int32Array;
  batches: number;
  instancedMeshes: number;
  /**
   * Multi-draw sub-draws issued per frame if every renderable were visible.
   *
   * The number `info.render.calls` hides: a BatchedMesh reports one call and
   * submits one range per instance. An InstancedMesh reports one call and
   * submits one. This is the counter that actually moved when the frame time
   * did.
   */
  subDraws: number;
  vertices: number;
  buildMs: number;
};

/**
 * Batches the city exactly the way CityChunksLayer does: one BatchedMesh per
 * render cell, whole-batch frustum culling on, per-object culling off, hull
 * geometries added once per cell and shared by every instance that uses them.
 *
 * The per-cell split is the load-bearing part. three re-uploads a BatchedMesh's
 * entire matrix texture when any one instance in it moves, so a city-wide batch
 * would upload megabytes because one chunk somewhere is falling.
 */
function buildBenchMeshes(
  city: SyntheticCity,
  material: THREE.Material,
  mode: BenchMode,
): BenchMeshState {
  const startedAt = performance.now();
  const meshOfChunk = new Int32Array(city.chunkCount).fill(-1);
  const instanceIds = new Int32Array(city.chunkCount).fill(-1);
  const renderables: Renderable[] = [];
  let vertices = 0;
  let batches = 0;
  let instancedMeshes = 0;
  let subDraws = 0;

  const xz = new Float32Array(city.chunkCount * 2);
  for (let i = 0; i < city.chunkCount; i += 1) {
    xz[i * 2] = city.positions[i * 3];
    xz[i * 2 + 1] = city.positions[i * 3 + 2];
  }
  const allSlots: number[] = [];
  for (let i = 0; i < city.chunkCount; i += 1) allSlots.push(i);
  /** Hulls deferred out of the cell loop, for `pooled-global`. */
  const globalHullSlots: number[] = [];

  // Hull geometry is expensive to triangulate (ConvexGeometry runs a full hull
  // per call), so the pool is built once and the per-cell copies clone from it.
  const hullPrototypes = new Map<string, THREE.BufferGeometry>();
  for (const shape of city.shapes) {
    if (shape.kind === 'hull' && !hullPrototypes.has(shape.key)) {
      hullPrototypes.set(shape.key, buildHullGeometry(shape.points));
    }
  }

  /** Rest pose for a chunk, into TMP_MATRIX. */
  const restMatrix = (slot: number): THREE.Matrix4 => {
    TMP_POSITION.set(
      city.positions[slot * 3],
      city.positions[slot * 3 + 1],
      city.positions[slot * 3 + 2],
    );
    TMP_QUATERNION.identity();
    TMP_SCALE.set(city.scales[slot * 3], city.scales[slot * 3 + 1], city.scales[slot * 3 + 2]);
    return TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
  };
  const chunkColor = (slot: number): THREE.Color =>
    TMP_COLOR.setHSL(((slot * 37) % 360) / 360, 0.35, 0.62);

  for (const cellSlots of partitionSlotsByCell(xz, allSlots).values()) {
    // In `batched` every chunk goes to the BatchedMesh, which is what ships.
    // In `hybrid` the boxes are peeled off first: they all share the unit cube,
    // so one InstancedMesh draws the cell's entire box population in a single
    // instanced call instead of one sub-draw each.
    const boxSlots = mode === 'batched'
      ? []
      : cellSlots.filter((slot) => city.shapes[slot].kind === 'box');
    const hullSlots = mode === 'batched'
      ? []
      : cellSlots.filter((slot) => city.shapes[slot].kind !== 'box');
    // `pooled` sends its hulls to per-pattern instanced meshes below; the
    // BatchedMesh then has nothing left to draw.
    const batchSlots = mode === 'batched'
      ? cellSlots
      : (mode === 'pooled' || mode === 'pooled-global' ? [] : hullSlots);
    if (mode === 'pooled-global') {
      for (const slot of hullSlots) globalHullSlots.push(slot);
    }

    if (boxSlots.length > 0) {
      const boxGeometry = buildBoxGeometry();
      vertices += boxGeometry.attributes.position.count;
      const mesh = new THREE.InstancedMesh(boxGeometry, material, boxSlots.length);
      mesh.castShadow = shadowsEnabled();
      mesh.receiveShadow = shadowsEnabled();
      mesh.frustumCulled = true;
      // Written every frame for the live bodies; DynamicDrawUsage tells the
      // driver not to keep re-validating a buffer it knows will change.
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const meshIndex = renderables.length;
      for (let i = 0; i < boxSlots.length; i += 1) {
        const slot = boxSlots[i];
        meshOfChunk[slot] = meshIndex;
        instanceIds[slot] = i;
        mesh.setMatrixAt(i, restMatrix(slot));
        mesh.setColorAt(i, chunkColor(slot));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      renderables.push({ kind: 'instanced', mesh });
      instancedMeshes += 1;
      subDraws += 1;
    }

    if (mode === 'pooled' && hullSlots.length > 0) {
      // One InstancedMesh per (cell x shard pattern). Only reachable if shards
      // come from a shared library -- with a pattern per chunk this degenerates
      // to one single-instance mesh per shard, which is worse than batching,
      // and the sweep over `hullVariants` is what shows where that turns over.
      const byPattern = new Map<string, number[]>();
      for (const slot of hullSlots) {
        const key = city.shapes[slot].kind === 'hull'
          ? (city.shapes[slot] as { key: string }).key
          : 'box';
        const existing = byPattern.get(key);
        if (existing) existing.push(slot);
        else byPattern.set(key, [slot]);
      }
      for (const [key, patternSlots] of byPattern) {
        const geometry = hullPrototypes.get(key)!.clone();
        vertices += geometry.attributes.position.count;
        const mesh = new THREE.InstancedMesh(geometry, material, patternSlots.length);
        mesh.castShadow = shadowsEnabled();
        mesh.receiveShadow = shadowsEnabled();
        mesh.frustumCulled = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const meshIndex = renderables.length;
        for (let i = 0; i < patternSlots.length; i += 1) {
          const slot = patternSlots[i];
          meshOfChunk[slot] = meshIndex;
          instanceIds[slot] = i;
          mesh.setMatrixAt(i, restMatrix(slot));
          mesh.setColorAt(i, chunkColor(slot));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        renderables.push({ kind: 'instanced', mesh });
        instancedMeshes += 1;
        subDraws += 1;
      }
    }

    if (batchSlots.length > 0) {
      const localHulls = new Map<string, THREE.BufferGeometry>();
      for (const slot of batchSlots) {
        const shape = city.shapes[slot];
        if (shape.kind === 'hull' && !localHulls.has(shape.key)) {
          localHulls.set(shape.key, hullPrototypes.get(shape.key)!.clone());
        }
      }
      const boxGeometry = buildBoxGeometry();
      let vertexBudget = boxGeometry.attributes.position.count;
      let indexBudget = boxGeometry.index?.count ?? 0;
      for (const geometry of localHulls.values()) {
        vertexBudget += geometry.attributes.position.count;
        indexBudget += geometry.index?.count ?? 0;
      }
      vertices += vertexBudget;

      const mesh = new THREE.BatchedMesh(batchSlots.length, vertexBudget, indexBudget, material);
      mesh.castShadow = shadowsEnabled();
      mesh.receiveShadow = shadowsEnabled();
      mesh.perObjectFrustumCulled = false;
      mesh.sortObjects = false;
      mesh.frustumCulled = true;

      const boxGeometryId = mesh.addGeometry(boxGeometry);
      const hullGeometryIds = new Map<string, number>();
      for (const [key, geometry] of localHulls) {
        hullGeometryIds.set(key, mesh.addGeometry(geometry));
      }

      const meshIndex = renderables.length;
      for (const slot of batchSlots) {
        const shape = city.shapes[slot];
        const geometryId =
          shape.kind === 'hull' ? (hullGeometryIds.get(shape.key) ?? boxGeometryId) : boxGeometryId;
        meshOfChunk[slot] = meshIndex;
        const instanceId = mesh.addInstance(geometryId);
        instanceIds[slot] = instanceId;
        mesh.setMatrixAt(instanceId, restMatrix(slot));
        mesh.setColorAt(instanceId, chunkColor(slot));
      }
      // Seed the sphere: the write path only grows it, so it needs a correct
      // starting value or a whole cell culls away.
      mesh.computeBoundingSphere();
      renderables.push({ kind: 'batched', mesh });
      batches += 1;
      subDraws += batchSlots.length;
    }
  }

  if (globalHullSlots.length > 0) {
    const byPattern = new Map<string, number[]>();
    for (const slot of globalHullSlots) {
      const shape = city.shapes[slot];
      const key = shape.kind === 'hull' ? shape.key : 'box';
      const existing = byPattern.get(key);
      if (existing) existing.push(slot);
      else byPattern.set(key, [slot]);
    }
    for (const [key, patternSlots] of byPattern) {
      const geometry = hullPrototypes.get(key)!.clone();
      vertices += geometry.attributes.position.count;
      const mesh = new THREE.InstancedMesh(geometry, material, patternSlots.length);
      mesh.castShadow = shadowsEnabled();
      mesh.receiveShadow = shadowsEnabled();
      // Deliberately off: the mesh spans the whole city, so the sphere test can
      // never drop it and would only cost a test per frame to always pass.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const meshIndex = renderables.length;
      for (let i = 0; i < patternSlots.length; i += 1) {
        const slot = patternSlots[i];
        meshOfChunk[slot] = meshIndex;
        instanceIds[slot] = i;
        mesh.setMatrixAt(i, restMatrix(slot));
        mesh.setColorAt(i, chunkColor(slot));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      renderables.push({ kind: 'instanced', mesh });
      instancedMeshes += 1;
      subDraws += 1;
    }
  }

  for (const geometry of hullPrototypes.values()) geometry.dispose();

  return {
    renderables,
    meshOfChunk,
    instanceIds,
    batches,
    instancedMeshes,
    subDraws,
    vertices,
    buildMs: performance.now() - startedAt,
  };
}

type BenchStats = {
  chunks: number;
  batches: number;
  instancedMeshes: number;
  subDraws: number;
  vertices: number;
  buildMs: number;
  liveBodies: number;
  mode: BenchMode;
};

function BenchCity({
  config,
  onStats,
}: {
  config: BenchConfig;
  onStats: (stats: BenchStats) => void;
}): JSX.Element {
  const groupRef = useRef<THREE.Group>(null);
  const stateRef = useRef<BenchMeshState | null>(null);
  const frameRef = useRef(0);
  const dirtyRef = useRef<Int32Array | null>(null);

  const city = useMemo(
    () =>
      buildSyntheticCity({
        chunks: config.chunks,
        towers: config.towers,
        hullFraction: config.hullFraction,
        hullVariants: config.hullVariants,
        seed: config.seed,
      }),
    [config.chunks, config.towers, config.hullFraction, config.hullVariants, config.seed],
  );

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return undefined;
    const material = cityPbrLighting()
      ? new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 })
      : new THREE.MeshLambertMaterial();
    const state = buildBenchMeshes(city, material, config.mode);
    stateRef.current = state;
    for (const renderable of state.renderables) group.add(renderable.mesh);
    // Live bodies are the ones recomposed every frame. Taken from the front of
    // the body list, which is the base of the first towers -- a collapse, not a
    // scatter, and the case where the write loop actually costs something.
    const live = Math.min(config.live, city.bodyCount);
    dirtyRef.current = new Int32Array(live);
    for (let i = 0; i < live; i += 1) dirtyRef.current[i] = i;
    onStats({
      chunks: city.chunkCount,
      batches: state.batches,
      instancedMeshes: state.instancedMeshes,
      subDraws: state.subDraws,
      vertices: state.vertices,
      buildMs: state.buildMs,
      liveBodies: live,
      mode: config.mode,
    });
    return () => {
      for (const renderable of state.renderables) {
        group.remove(renderable.mesh);
        renderable.mesh.dispose();
      }
      material.dispose();
      stateRef.current = null;
    };
  }, [city, config.live, config.mode, onStats]);

  useFrame((frameState) => {
    const cityFrameStartedAt = performance.now();
    renderStats.beforeCityMs = cityFrameStartedAt - frameStartTime();
    renderStats.instanceWrites = 0;
    const state = stateRef.current;
    const dirty = dirtyRef.current;
    if (!state || !dirty || dirty.length === 0) {
      renderStats.cityFrameMs = performance.now() - cityFrameStartedAt;
      markFrameEndAndSample(frameState.gl.info as never);
      return;
    }

    const frame = frameRef.current;
    frameRef.current += 1;
    const camera = frameState.camera.position;
    const elapsed = frameState.clock.elapsedTime;
    const touched = new Set<number>();
    const writeStartedAt = performance.now();

    for (let i = 0; i < dirty.length; i += 1) {
      const body = dirty[i];
      const first = city.bodyStart[body];
      const last = city.bodyStart[body + 1];
      if (last <= first) continue;

      // Distance stride, keyed on the batch rather than the body: a batch
      // re-uploads its whole transform texture if any instance in it moves, so
      // bodies sharing a batch have to defer together or nothing is saved.
      const dx = city.positions[first * 3] - camera.x;
      const dy = city.positions[first * 3 + 1] - camera.y;
      const dz = city.positions[first * 3 + 2] - camera.z;
      const stride = updateStrideForDistanceSq(dx * dx + dy * dy + dz * dz);
      const batch = state.meshOfChunk[first];
      if (!shouldUpdateThisFrame(frame, batch < 0 ? 0 : batch, stride)) continue;

      // A deterministic tumble stands in for the streamed pose. It only has to
      // be a fresh matrix every frame -- what is being measured is the cost of
      // writing it, not where it lands.
      const phase = body * 0.37 + elapsed;
      const drop = Math.min(6, elapsed * 0.6 + (body % 7) * 0.1);
      for (let slot = first; slot < last; slot += 1) {
        const instanceId = state.instanceIds[slot];
        const renderable = state.renderables[state.meshOfChunk[slot]];
        if (instanceId < 0 || !renderable) continue;
        TMP_POSITION.set(
          city.positions[slot * 3] + Math.sin(phase) * 0.4,
          Math.max(0.3, city.positions[slot * 3 + 1] - drop),
          city.positions[slot * 3 + 2] + Math.cos(phase) * 0.4,
        );
        TMP_AXIS.copy(TMP_POSITION).normalize();
        TMP_QUATERNION.setFromAxisAngle(TMP_AXIS, phase);
        TMP_SCALE.set(
          city.scales[slot * 3],
          city.scales[slot * 3 + 1],
          city.scales[slot * 3 + 2],
        );
        TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
        TMP_COLOR.setRGB(0.8, 0.5 + 0.3 * Math.sin(phase), 0.4);
        renderable.mesh.setMatrixAt(instanceId, TMP_MATRIX);
        renderable.mesh.setColorAt(instanceId, TMP_COLOR);
        renderStats.instanceWrites += 1;
        touched.add(state.meshOfChunk[slot]);
      }
    }

    const writeEndedAt = performance.now();
    renderStats.dirtyWriteMs = writeEndedAt - writeStartedAt;
    for (const index of touched) {
      const renderable = state.renderables[index];
      if (!renderable) continue;
      if (renderable.kind === 'instanced') {
        if (!renderable.mesh.frustumCulled) {
          renderable.mesh.instanceMatrix.needsUpdate = true;
          if (renderable.mesh.instanceColor) renderable.mesh.instanceColor.needsUpdate = true;
          continue;
        }
        // Unlike a BatchedMesh's data texture, an instance buffer has a partial
        // upload path -- but three only takes it if the ranges are declared, so
        // the flag alone still re-uploads the whole cell.
        renderable.mesh.instanceMatrix.needsUpdate = true;
        if (renderable.mesh.instanceColor) renderable.mesh.instanceColor.needsUpdate = true;
      }
      renderable.mesh.computeBoundingSphere();
    }
    const sphereEndedAt = performance.now();
    renderStats.sphereMs = sphereEndedAt - writeEndedAt;
    renderStats.cityFrameMs = sphereEndedAt - cityFrameStartedAt;
    markFrameEndAndSample(frameState.gl.info as never);
  });

  return <group ref={groupRef} />;
}

/**
 * Fixed camera path: a slow orbit at eye height around the city, framed on its
 * own footprint so the same fraction of the scene is on screen at any size.
 *
 * Time-parameterised rather than frame-parameterised. A frame-stepped path
 * would run slower on a slower build and therefore see a different scene,
 * which would make the two runs incomparable in exactly the way this page is
 * meant to prevent.
 */
function BenchCamera({ config, extentM }: { config: BenchConfig; extentM: number }): null {
  const { camera } = useThree();
  useFrame((state) => {
    const radius = Math.max(20, extentM * config.orbit);
    const angle = (state.clock.elapsedTime / config.orbitSeconds) * Math.PI * 2;
    camera.position.set(Math.cos(angle) * radius, 14, Math.sin(angle) * radius);
    camera.lookAt(0, 8, 0);
  }, -900);
  return null;
}

export function RenderBenchPage(): JSX.Element {
  const config = useMemo(readConfig, []);
  const [stats, setStats] = useState<BenchStats | null>(null);
  const [city] = useState(() =>
    buildSyntheticCity({
      chunks: config.chunks,
      towers: config.towers,
      hullFraction: config.hullFraction,
      hullVariants: config.hullVariants,
      seed: config.seed,
    }),
  );

  useEffect(() => {
    // The harness drives the page through this: it needs to know when the
    // meshes exist (building 100k instances is not instant) before it starts
    // sampling, or the first seconds of every run are build cost.
    (window as unknown as { __VIBE_BENCH__?: unknown }).__VIBE_BENCH__ = {
      ready: () => stats != null,
      config: () => ({ ...config }),
      stats: () => (stats ? { ...stats } : null),
      frameProfile: () => ({ ...renderStats }),
    };
  }, [config, stats]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        style={{ width: '100%', height: '100%' }}
        shadows={shadowsEnabled()}
        dpr={[1, maxDpr()]}
        flat={flatToneMapping()}
        gl={{ antialias: antialiasEnabled(), powerPreference: 'high-performance' }}
        camera={{ fov: 75, near: 0.1, far: config.far, position: [0, 14, 60] }}
      >
        <FrameClock />
        <color attach="background" args={['#8fb4d4']} />
        <fog attach="fog" args={['#8fb4d4', config.far * 0.35, config.far]} />
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[60, 90, 40]}
          intensity={1.6}
          castShadow={shadowsEnabled()}
          shadow-mapSize={[2048, 2048]}
        />
        {cityPbrLighting() && <directionalLight position={[-40, 50, -60]} intensity={0.5} />}
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadowsEnabled()}>
          <planeGeometry args={[4000, 4000]} />
          <meshLambertMaterial color="#5c7a4a" />
        </mesh>
        <BenchCamera config={config} extentM={city.extentM} />
        <BenchCity config={config} onStats={setStats} />
      </Canvas>
      <pre
        style={{
          position: 'absolute', top: 8, left: 8, margin: 0, padding: '8px 10px',
          background: 'rgba(0,0,0,0.65)', color: '#cfe', fontSize: 12, lineHeight: 1.4,
          pointerEvents: 'none',
        }}
      >
        {stats
          ? `chunks ${stats.chunks}  batches ${stats.batches}  live bodies ${stats.liveBodies}\n`
            + `verts ${stats.vertices}  build ${stats.buildMs.toFixed(0)} ms  `
            + `tier ${cityPbrLighting() ? 'pretty' : 'fast'}  shadows ${shadowsEnabled() ? 'on' : 'off'}`
          : 'building...'}
      </pre>
    </div>
  );
}
