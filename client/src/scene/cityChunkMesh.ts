// Building the city's draw objects: the decision of WHAT to hand the GPU.
//
// Split out of CityChunksLayer, which is now only the React component and the
// per-frame write loop. The build had grown to 400 lines doing six unrelated
// jobs in one scope, which is exactly the shape of function that acquires a
// seventh.
//
// Every chunk lands in one of three places, and the choice is made per shape,
// not per chunk:
//
//   boxes        -> one InstancedMesh per render cell. Every box is the same
//                   unit cube carrying its extents in the instance matrix, so
//                   a cell is ONE genuine instanced draw.
//   shared hulls -> one InstancedMesh per shape, CITY-WIDE. Only reachable
//                   when the pack was authored with a bounded fracture-pattern
//                   library, so the same shard recurs many times.
//   lone hulls   -> one BatchedMesh per render cell. A shape used once or twice
//                   is not worth a real draw call, and a batch keeps frustum
//                   culling.
//
// The distinction that drove all of this: three renders a BatchedMesh through
// WEBGL_multi_draw and emits one sub-draw RANGE PER INSTANCE, so
// `info.render.calls` reports 1 while the driver executes thousands of
// ~12-triangle draws. Frame cost tracks sub-draws, not triangles and not fill.
// See docs/city-render-subdraws-2026-08-25.md.

import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import { buildBoxGeometry, buildHullGeometry, chunkShape } from '../city/chunkGeometry';
import { partitionSlotsByCell } from '../city/renderScheduling';
import { cityPbrLighting, shadowsEnabled } from '../app/renderQuality';
import { writeInstance, type CityRenderable } from './cityChunkWrite';

const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_COLOR = new THREE.Color();

/**
 * Uses of one shape below which it stays in its cell's batch.
 *
 * A city-wide instanced mesh trades N sub-draws for one REAL draw call, and a
 * real draw call is dearer than a sub-draw -- so the swap only pays above some
 * share, and below it also costs the frustum culling a cell-sized batch keeps.
 *
 * 8 is measured rather than guessed, but only coarsely: at 33k chunks, raising
 * it to 32 cut draw calls 733 -> 124 and moved mean gl.render by 0.09 ms while
 * making the worst heading worse (2.95 -> 3.99 ms). Mean was within noise and
 * the worst case decided it. Worth re-deriving if the shape mix changes a lot.
 */
export const MIN_SHARE_TO_INSTANCE = 8;

export type CityMeshState = {
  /**
   * One entry per drawable object, in build order.
   *
   * three uploads a BatchedMesh's entire matrix texture whenever any instance
   * in it moves -- textures have no partial-update path the way buffers do --
   * and an InstancedMesh re-uploads its whole instance buffer on needsUpdate.
   * A single city-wide object therefore re-uploaded megabytes every frame
   * because one chunk somewhere was falling. Splitting means a patch of city
   * nobody has touched costs nothing.
   */
  renderables: CityRenderable[];
  /**
   * Renderable -> the render cell it was cut from.
   *
   * The distance stride is staggered by upload unit, and a cell has two of
   * them. Keying the stagger on the renderable index would give a cell's box
   * bodies and its hull bodies different phases, rewriting both on frames where
   * neither used to move. Keying on the cell keeps the original property:
   * everything sharing an upload defers together. City-wide shape meshes get
   * synthetic ids past the real cells, since each is its own upload unit.
   */
  cellOfRenderable: Int32Array;
  /** Slot -> index into `renderables`. */
  meshOfSlot: Int32Array;
  /**
   * Slot -> instance id within its own object. BatchedMesh hands out its own
   * ids and InstancedMesh ids are positions in that mesh's slot list; neither
   * promises to match the topology slot.
   */
  instanceIds: Int32Array;
  /** Per-slot render scale: box extents, or 1 for hulls (already metric). */
  scales: Float32Array;
  baseColors: Float32Array;
  /** 1 = hidden (sunk below CHUNK_HIDE_Y_M). */
  hiddenBySlot: Uint8Array;
  /** Consecutive writes below the hide threshold; see CHUNK_HIDE_STREAK. */
  belowStreakBySlot: Uint8Array;
  /** Bounding radius per chunk. */
  radii: Float32Array;
};

/**
 * City chunks shade as PBR only on the PRETTY tier.
 *
 * The city is most of the screen's pixels, and MeshStandardMaterial evaluates
 * full PBR per pixel per light. Lambert is per-light diffuse only, and on flat
 * matte rubble (roughness 0.85, metalness 0.05) the difference is barely a look
 * at all -- but on a fill-bound phone it is a large share of the frame.
 */
export function buildCityMaterial(): THREE.Material {
  return cityPbrLighting()
    ? new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 })
    : new THREE.MeshLambertMaterial();
}

function structureColor(structureId: number): THREE.Color {
  return TMP_COLOR.setHSL(((structureId * 47) % 360) / 360, 0.35, 0.62);
}

type ResolvedShapes = {
  shapeBySlot: Array<ReturnType<typeof chunkShape>>;
  scales: Float32Array;
  radii: Float32Array;
  /**
   * Rest-pose XZ per slot, relative to its own structure's origin.
   *
   * Structure-relative rather than world so the cell grid is anchored to each
   * pack instead of to the world origin. A 12 m building that happened to
   * straddle a world cell boundary would otherwise shatter into four batches
   * for no benefit, and which buildings did that would depend on where the grid
   * dropped them. Anchored per structure, anything smaller than a cell is
   * always exactly one batch, and only a pack genuinely bigger than a cell --
   * the district -- splits.
   */
  localXZ: Float32Array;
};

/**
 * What every chunk draws, and how big.
 *
 * Resolved before anything is allocated because a BatchedMesh has to be sized
 * with its total vertex and index budget up front, which is only knowable once
 * the distinct hulls are known.
 */
function resolveShapes(client: CityClient, count: number): ResolvedShapes {
  const manifest = client.manifest.manifest;
  const scales = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const shapeBySlot = new Array<ReturnType<typeof chunkShape>>(count);
  const localXZ = new Float32Array(count * 2);

  for (const structure of manifest.structures) {
    TMP_QUATERNION.set(
      structure.worldRotation[0],
      structure.worldRotation[1],
      structure.worldRotation[2],
      structure.worldRotation[3],
    );
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      TMP_POSITION.set(chunk.centroid[0], chunk.centroid[1], chunk.centroid[2])
        .applyQuaternion(TMP_QUATERNION);
      localXZ[slot * 2] = TMP_POSITION.x;
      localXZ[slot * 2 + 1] = TMP_POSITION.z;

      const shape = chunkShape(chunk);
      shapeBySlot[slot] = shape;
      if (shape.kind === 'hull') {
        // Hull points are already metric and centroid-relative.
        scales[slot * 3] = 1;
        scales[slot * 3 + 1] = 1;
        scales[slot * 3 + 2] = 1;
      } else {
        scales[slot * 3] = shape.scale[0];
        scales[slot * 3 + 1] = shape.scale[1];
        scales[slot * 3 + 2] = shape.scale[2];
      }
      // The manifest's own bounding radius where it has one; otherwise the box
      // half-diagonal, which bounds the drawn unit cube exactly.
      radii[slot] = chunk.radius > 0
        ? chunk.radius
        : 0.5 * Math.hypot(scales[slot * 3], scales[slot * 3 + 1], scales[slot * 3 + 2]);
    }
  }
  return { shapeBySlot, scales, radii, localXZ };
}

type HullSharing = {
  /** Shape key -> every slot drawing it. */
  slotsOfHullKey: Map<string, number[]>;
  hullPointsOfKey: Map<string, Float32Array>;
  /** Shapes shared widely enough to earn a city-wide instanced mesh. */
  instancedKeys: Set<string>;
  keyOfSlot: Map<number, string>;
};

/**
 * Which hull shapes recur often enough to instance.
 *
 * This is the payoff for authoring a pack with a bounded fracture-pattern
 * library: shards that were one-of-a-kind become a few hundred shapes used tens
 * of times each. Automatic and self-disabling -- against a pack whose shards
 * are all distinct (downtown before pooling: 7,160 hulls, 7,160 shapes) no key
 * clears the threshold, every hull stays in its cell batch, and this costs one
 * pass over the hull slots.
 */
function groupHullShapes(shapeBySlot: ResolvedShapes['shapeBySlot'], count: number): HullSharing {
  const slotsOfHullKey = new Map<string, number[]>();
  const hullPointsOfKey = new Map<string, Float32Array>();
  const keyOfSlot = new Map<number, string>();

  for (let slot = 0; slot < count; slot += 1) {
    const shape = shapeBySlot[slot];
    if (!shape || shape.kind !== 'hull') continue;
    keyOfSlot.set(slot, shape.key);
    if (!hullPointsOfKey.has(shape.key)) hullPointsOfKey.set(shape.key, shape.points);
    const existing = slotsOfHullKey.get(shape.key);
    if (existing) existing.push(slot);
    else slotsOfHullKey.set(shape.key, [slot]);
  }

  const instancedKeys = new Set<string>();
  for (const [key, slots] of slotsOfHullKey) {
    if (slots.length >= MIN_SHARE_TO_INSTANCE) instancedKeys.add(key);
  }
  return { slotsOfHullKey, hullPointsOfKey, instancedKeys, keyOfSlot };
}

/** Per-structure tint for every slot, so a chunk drawn anywhere has a colour. */
function resolveTints(client: CityClient, count: number): Float32Array {
  const baseColors = new Float32Array(count * 3);
  for (const structure of client.manifest.manifest.structures) {
    const tint = structureColor(structure.structureId);
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      baseColors[slot * 3] = tint.r;
      baseColors[slot * 3 + 1] = tint.g;
      baseColors[slot * 3 + 2] = tint.b;
    }
  }
  return baseColors;
}

/** Mutable accumulator threaded through the three builders below. */
type BuildSink = {
  renderables: CityRenderable[];
  cellOfRenderable: number[];
  meshOfSlot: Int32Array;
  instanceIds: Int32Array;
  hiddenBySlot: Uint8Array;
  belowStreakBySlot: Uint8Array;
  scales: Float32Array;
  baseColors: Float32Array;
  totalVertices: number;
  batchCount: number;
  instancedCount: number;
  /**
   * Multi-draw sub-draws submitted per frame if everything were visible.
   *
   * The number `info.render.calls` hides, and the one frame time tracks.
   */
  subDraws: number;
};

/** Write a slot's rest pose into whichever object just claimed it. */
function seatSlot(
  sink: BuildSink,
  client: CityClient,
  renderable: CityRenderable,
  meshIndex: number,
  slot: number,
  instanceId: number,
  colour: THREE.Color,
): void {
  sink.meshOfSlot[slot] = meshIndex;
  sink.instanceIds[slot] = instanceId;
  writeInstance(
    renderable,
    client,
    slot,
    client.topology.body(client.topology.bodyKeyOf(slot)),
    sink.scales,
    sink.instanceIds,
    sink.hiddenBySlot,
    sink.belowStreakBySlot,
  );
  renderable.mesh.setColorAt(instanceId, colour);
}

/** The cell's boxes: one instanced draw for all of them. */
function buildCellBoxes(
  sink: BuildSink,
  client: CityClient,
  material: THREE.Material,
  cell: number,
  slots: number[],
  colour: THREE.Color,
): void {
  if (slots.length === 0) return;
  const geometry = buildBoxGeometry();
  sink.totalVertices += geometry.attributes.position.count;
  const mesh = new THREE.InstancedMesh(geometry, material, slots.length);
  // Toggleable at runtime: the city is the bulk of the shadow map, and on a
  // phone that second pass is a candidate for the whole frame budget.
  mesh.castShadow = shadowsEnabled();
  mesh.receiveShadow = shadowsEnabled();
  // Whole-cell culling: one sphere test that can drop a whole block.
  mesh.frustumCulled = true;
  // Rewritten every frame for any cell holding a live body.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const meshIndex = sink.renderables.length;
  const renderable: CityRenderable = { kind: 'instanced', mesh };
  for (let i = 0; i < slots.length; i += 1) {
    seatSlot(sink, client, renderable, meshIndex, slots[i], i, colour);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Seed the culling sphere rather than leaving it null for three to compute
  // lazily. The write path only GROWS it, so it needs a correct starting value
  // -- a cell culled against a sphere that never existed is a block of city
  // missing.
  mesh.computeBoundingSphere();
  sink.renderables.push(renderable);
  sink.cellOfRenderable.push(cell);
  sink.instancedCount += 1;
  sink.subDraws += 1;
}

/** The cell's one-off hulls: a batch, which keeps frustum culling. */
function buildCellHullBatch(
  sink: BuildSink,
  client: CityClient,
  material: THREE.Material,
  shapeBySlot: ResolvedShapes['shapeBySlot'],
  cell: number,
  slots: number[],
  colour: THREE.Color,
): void {
  if (slots.length === 0) return;
  const localHulls = new Map<string, THREE.BufferGeometry>();
  for (const slot of slots) {
    const shape = shapeBySlot[slot];
    if (shape.kind === 'hull' && !localHulls.has(shape.key)) {
      localHulls.set(shape.key, buildHullGeometry(shape.points));
    }
  }
  // The unit cube still goes in: `chunkShape` falls back to a box for a
  // malformed hull, and a slot sorted here on its shape kind must have
  // somewhere to land if that fallback fires.
  const boxGeometry = buildBoxGeometry();
  let vertexBudget = boxGeometry.attributes.position.count;
  let indexBudget = boxGeometry.index?.count ?? 0;
  for (const geometry of localHulls.values()) {
    vertexBudget += geometry.attributes.position.count;
    indexBudget += geometry.index?.count ?? 0;
  }
  sink.totalVertices += vertexBudget;

  const mesh = new THREE.BatchedMesh(slots.length, vertexBudget, indexBudget, material);
  mesh.castShadow = shadowsEnabled();
  mesh.receiveShadow = shadowsEnabled();
  // Per-instance culling walks every chunk to decide each one, which is the
  // work we are trying to avoid.
  mesh.perObjectFrustumCulled = false;
  mesh.sortObjects = false;
  // Whole-batch culling is one sphere test that can drop a block. Only worth
  // anything because batches are cell sized: a city-wide batch always
  // intersects the frustum, which is why culling used to be off here.
  mesh.frustumCulled = true;

  const boxGeometryId = mesh.addGeometry(boxGeometry);
  const hullGeometryIds = new Map<string, number>();
  for (const [key, geometry] of localHulls) {
    hullGeometryIds.set(key, mesh.addGeometry(geometry));
  }

  const meshIndex = sink.renderables.length;
  const renderable: CityRenderable = { kind: 'batched', mesh };
  for (const slot of slots) {
    const shape = shapeBySlot[slot];
    const geometryId = shape.kind === 'hull'
      ? (hullGeometryIds.get(shape.key) ?? boxGeometryId)
      : boxGeometryId;
    seatSlot(sink, client, renderable, meshIndex, slot, mesh.addInstance(geometryId), colour);
  }
  mesh.computeBoundingSphere();
  sink.renderables.push(renderable);
  sink.cellOfRenderable.push(cell);
  sink.batchCount += 1;
  sink.subDraws += slots.length;
}

/**
 * Shapes shared across the city: one instanced mesh each, keyed CITY-WIDE.
 *
 * Per-cell keying would cost cells x shapes REAL draw calls and inverts past a
 * few dozen shapes -- measured at 100k chunks, per-cell ran 399 fps at 16
 * shapes but 197 at 32, while city-wide held 633 at 16, 679 at 64 and 489 at
 * 256. City-wide is what makes a large, good-looking shard library affordable.
 *
 * The trade is frustum culling: a shape's mesh spans the map, so its sphere
 * always intersects and every instance is submitted every frame. That is vertex
 * work on ~30-vertex shards, not fill, and measured far cheaper than the
 * sub-draws it replaces.
 */
function buildSharedShapeMeshes(
  sink: BuildSink,
  client: CityClient,
  material: THREE.Material,
  sharing: HullSharing,
  cellCount: number,
): void {
  for (const key of sharing.instancedKeys) {
    const slots = sharing.slotsOfHullKey.get(key) ?? [];
    if (slots.length === 0) continue;
    const geometry = buildHullGeometry(sharing.hullPointsOfKey.get(key)!);
    sink.totalVertices += geometry.attributes.position.count;
    const mesh = new THREE.InstancedMesh(geometry, material, slots.length);
    mesh.castShadow = shadowsEnabled();
    mesh.receiveShadow = shadowsEnabled();
    // Off deliberately -- see above. The frame loop keys on this flag to skip a
    // bounding-sphere recompute that nothing would ever read.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const meshIndex = sink.renderables.length;
    const renderable: CityRenderable = { kind: 'instanced', mesh };
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      seatSlot(sink, client, renderable, meshIndex, slot, i, TMP_COLOR.setRGB(
        sink.baseColors[slot * 3],
        sink.baseColors[slot * 3 + 1],
        sink.baseColors[slot * 3 + 2],
      ));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    sink.renderables.push(renderable);
    // Its own stagger phase, continuing past the real cells: this mesh IS an
    // upload unit, so every body drawing this shape must defer together for the
    // stride to save anything.
    sink.cellOfRenderable.push(cellCount + sink.instancedCount);
    sink.instancedCount += 1;
    sink.subDraws += 1;
  }
}

export function buildCityMesh(client: CityClient): CityMeshState {
  const manifest = client.manifest.manifest;
  const count = client.topology.chunkCount;

  const { shapeBySlot, scales, radii, localXZ } = resolveShapes(client, count);
  const sharing = groupHullShapes(shapeBySlot, count);
  const material = buildCityMaterial();

  const sink: BuildSink = {
    renderables: [],
    cellOfRenderable: [],
    meshOfSlot: new Int32Array(count).fill(-1),
    instanceIds: new Int32Array(count).fill(-1),
    hiddenBySlot: new Uint8Array(count),
    belowStreakBySlot: new Uint8Array(count),
    scales,
    baseColors: resolveTints(client, count),
    totalVertices: 0,
    batchCount: 0,
    instancedCount: 0,
    subDraws: 0,
  };

  let cellCount = 0;
  for (const structure of manifest.structures) {
    const structureSlots = structure.chunks.map((chunk) =>
      client.topology.slotOf(structure.structureId, chunk.nodeIndex),
    );
    // Cells are cut inside a structure, so a grid of separate buildings still
    // gets at least one batch per building (each far smaller than a cell) and a
    // district pack gets one per city block.
    const colour = structureColor(structure.structureId);
    for (const slots of partitionSlotsByCell(localXZ, structureSlots).values()) {
      // Cell ids run across structures, so two structures' cells never share a
      // stagger phase just because both were the third cell of their own pack.
      const cell = cellCount;
      cellCount += 1;
      const boxSlots: number[] = [];
      const hullSlots: number[] = [];
      for (const slot of slots) {
        if (shapeBySlot[slot].kind === 'box') boxSlots.push(slot);
        // A shape drawn city-wide is claimed by that mesh, not this cell.
        else if (!sharing.instancedKeys.has(sharing.keyOfSlot.get(slot) ?? '')) {
          hullSlots.push(slot);
        }
      }
      buildCellBoxes(sink, client, material, cell, boxSlots, colour);
      buildCellHullBatch(sink, client, material, shapeBySlot, cell, hullSlots, colour);
    }
  }

  buildSharedShapeMeshes(sink, client, material, sharing, cellCount);

  console.info('[city] chunk meshes ready', {
    chunks: count,
    structures: manifest.structures.length,
    instancedCells: sink.instancedCount,
    hullBatches: sink.batchCount,
    // Distinct shard shapes, and how many were shared widely enough to
    // instance. 7,160 shapes for 7,160 shards means nothing can be instanced.
    hullShapes: sharing.slotsOfHullKey.size,
    instancedHullShapes: sharing.instancedKeys.size,
    // Sub-draws, not draw calls: this is the number frame time tracks.
    subDraws: sink.subDraws,
    vertices: sink.totalVertices,
  });

  return {
    renderables: sink.renderables,
    cellOfRenderable: Int32Array.from(sink.cellOfRenderable),
    meshOfSlot: sink.meshOfSlot,
    instanceIds: sink.instanceIds,
    scales,
    baseColors: sink.baseColors,
    hiddenBySlot: sink.hiddenBySlot,
    radii,
    belowStreakBySlot: sink.belowStreakBySlot,
  };
}
