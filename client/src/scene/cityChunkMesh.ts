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
import {
  cityPbrLighting,
  cityTextureDetail,
  instanceShareThresholdSetting,
  shadowsEnabled,
} from '../app/renderQuality';
import { writeInstance, type CityRenderable } from './cityChunkWrite';
import { ShellBuilder, retireShellRange } from './cityShell';
import { renderStats } from '../city/renderStats';
import { applyCityTriplanar } from './cityMaterialShader';
import { attachInstanceAnchors, bakeRestAnchors } from './cityTexAnchor';
import { layerCodeForBuilding } from './cityTextures';

const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_COLOR = new THREE.Color();
const IDENTITY_MATRIX = new THREE.Matrix4();

/**
 * Uses of one shape below which it stays in its cell's batch.
 *
 * A city-wide instanced mesh trades N sub-draws for one REAL draw call. Which
 * way that pays is a property of the MACHINE, not of the scene: a real draw is
 * CPU submission, a sub-draw is GPU work, and fps -- the only instrument this
 * had when the threshold was first chosen -- cannot tell those apart.
 *
 * See `DEFAULT_INSTANCE_SHARE_THRESHOLD` in renderQuality for the current value
 * and the measurement behind it. Live-settable, because the answer differs per
 * machine and `perfSweep` prices it on whichever one is complaining.
 */
function minShareToInstance(): number {
  return instanceShareThresholdSetting();
}

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
  /**
   * 1 once the slot's individual instance has taken over from the shell.
   *
   * Set for every slot outside a shell at build, so the wake test in the frame
   * loop is one array read for the common case.
   */
  wokenBySlot: Uint8Array;
  /** Slot -> [start,count] of its triangles inside its cell's shell, or -1. */
  shellIndexStartBySlot: Int32Array;
  shellIndexCountBySlot: Int32Array;
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
  const pbr = cityPbrLighting();
  const material = pbr
    // roughness 1 because the packed surface map now IS the roughness and three
    // multiplies the two. Any constant below 1 would scale every layer towards
    // gloss, which on concrete reads as wet.
    //
    // metalness 0 because concrete is a dielectric. It was a token 0.05 back
    // when nothing indirect could reflect off it; the sky environment map makes
    // specular a term that is actually visible, so being right is now free.
    ? new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 })
    : new THREE.MeshLambertMaterial();
  // Must happen here, on the object that was just constructed. Material.clone()
  // copies no function properties, so a cloned city material would silently
  // lose the injection and render untextured with no error anywhere.
  applyCityTriplanar(material, pbr, cityTextureDetail());
  return material;
}

/**
 * The base a chunk's instance colour starts from.
 *
 * Buildings used to be told apart by a per-structure hue; they are now told
 * apart by which concrete they are made of, which the shader picks per BUILDING
 * (see `resolveBuildingIds`). The colour channel is still written every frame,
 * but only to carry the settled-darkening and the body-state debug palette --
 * and those are MULTIPLIED over the texture (`<color_fragment>` runs after
 * `<map_fragment>`), so the base has to be white or it tints every layer.
 *
 * Kept as a function rather than a constant because it hands back the shared
 * scratch colour, exactly as the per-structure version did.
 */
function chunkBaseColor(): THREE.Color {
  return TMP_COLOR.setRGB(1, 1, 1);
}

/**
 * Slot -> the slot identifying the building it belongs to.
 *
 * A "building" is not a manifest concept. The downtown pack the city actually
 * serves is ONE structure holding 41,050 chunks, so `structureId` names the
 * whole skyline and is useless for telling one tower from the next -- keying
 * concrete on it would give every building in the city the same material.
 *
 * What does separate them is bonds: the fracturer bonds chunks within a
 * building and never between buildings, so a connected component of the bond
 * graph IS a building. Measured on `fractured-downtown-all.json`: 27
 * components, the largest with a 21 x 21 m footprint -- one tower.
 *
 * Union-find with path halving over the whole bond list, which is one pass the
 * manifest parse already pays for elsewhere. Chunks with no bonds are their own
 * component, which is correct: a lone slab is its own little piece of concrete.
 */
function resolveBuildingIds(client: CityClient, count: number): Int32Array {
  const parent = new Int32Array(count);
  for (let slot = 0; slot < count; slot += 1) parent[slot] = slot;
  const find = (slot: number): number => {
    let node = slot;
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  };
  for (const structure of client.manifest.manifest.structures) {
    for (const bond of structure.bonds) {
      const a = find(client.topology.slotOf(structure.structureId, bond.node0));
      const b = find(client.topology.slotOf(structure.structureId, bond.node1));
      if (a !== b) parent[a] = b;
    }
  }
  // Flatten so the anchor pass is a plain array read rather than a walk.
  for (let slot = 0; slot < count; slot += 1) parent[slot] = find(slot);
  return parent;
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
  /**
   * Per slot: the chunk's rest-pose world position, plus its building's packed
   * texture layers in `.w`.
   *
   * This is what the triplanar mapping projects from, and taking it from the
   * REST pose rather than the live one is the whole reason a shard keeps its
   * texture when it breaks off and tumbles.
   */
  anchors: Float32Array;
  /** Distinct bonded components, i.e. how many buildings the concrete spans. */
  buildingCount: number;
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
  const buildingOfSlot = resolveBuildingIds(client, count);
  const scales = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const shapeBySlot = new Array<ReturnType<typeof chunkShape>>(count);
  const localXZ = new Float32Array(count * 2);
  const anchors = new Float32Array(count * 4);
  const buildingCount = new Set(buildingOfSlot).size;
  let rotatedStructures = 0;

  for (const structure of manifest.structures) {
    TMP_QUATERNION.set(
      structure.worldRotation[0],
      structure.worldRotation[1],
      structure.worldRotation[2],
      structure.worldRotation[3],
    );
    // The rest-space mapping has no rotation term: a vertex's texture
    // coordinate is its anchor plus its unrotated local offset. Every pack ever
    // authored stamps buildings with an identity rotation, but the manifest
    // type permits otherwise, and a rotated building would silently texture as
    // though it were axis-aligned rather than fail. Counted, not thrown.
    if (Math.abs(TMP_QUATERNION.w) < 0.999_999) rotatedStructures += 1;
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      TMP_POSITION.set(chunk.centroid[0], chunk.centroid[1], chunk.centroid[2])
        .applyQuaternion(TMP_QUATERNION);
      localXZ[slot * 2] = TMP_POSITION.x;
      localXZ[slot * 2 + 1] = TMP_POSITION.z;
      anchors[slot * 4] = structure.worldPosition[0] + TMP_POSITION.x;
      anchors[slot * 4 + 1] = structure.worldPosition[1] + TMP_POSITION.y;
      anchors[slot * 4 + 2] = structure.worldPosition[2] + TMP_POSITION.z;
      anchors[slot * 4 + 3] = layerCodeForBuilding(buildingOfSlot[slot]);

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
  if (rotatedStructures > 0) {
    console.warn(
      '[city] rest-space texturing assumes an unrotated structure',
      { rotatedStructures },
    );
  }
  return { shapeBySlot, scales, radii, localXZ, anchors, buildingCount };
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
    if (slots.length >= minShareToInstance()) instancedKeys.add(key);
  }
  return { slotsOfHullKey, hullPointsOfKey, instancedKeys, keyOfSlot };
}

/** Per-structure tint for every slot, so a chunk drawn anywhere has a colour. */
function resolveTints(client: CityClient, count: number): Float32Array {
  const baseColors = new Float32Array(count * 3);
  for (const structure of client.manifest.manifest.structures) {
    const tint = chunkBaseColor();
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
  wokenBySlot: Uint8Array;
  shellIndexStartBySlot: Int32Array;
  shellIndexCountBySlot: Int32Array;
  scales: Float32Array;
  anchors: Float32Array;
  baseColors: Float32Array;
  totalVertices: number;
  /**
   * Vertices held by hull batches, against what they would hold if instances of
   * one shape still shared a copy.
   *
   * They no longer can: each instance carries its own baked rest anchor, and
   * since the static shell landed each batch ALSO holds a merged rest-pose copy
   * of every member -- so the ratio is roughly twice the per-instance figure.
   * Watch it per pack; it is memory, not draws.
   */
  hullBatchVertices: number;
  hullBatchSharedVertices: number;
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
  // A fresh unit cube per cell, and it has to stay that way: three's VAO cache
  // is keyed on geometry id with no per-object dimension, so sharing one cube
  // across cells would give every cell the same anchor buffer -- the last one
  // written. Deduplicating it is the obvious future optimisation and it would
  // silently texture the whole city as one block.
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
  attachInstanceAnchors(mesh, slots, sink.anchors, sink.scales);
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
  // One prototype per distinct shape in this cell, reused across every instance
  // of it. The unit cube is minted lazily for the same reason it used to be
  // added unconditionally: `chunkShape` falls back to a box for a malformed
  // hull, and a slot sorted here on its shape kind still has to land somewhere.
  const prototypes = new Map<string, THREE.BufferGeometry>();
  let boxPrototype: THREE.BufferGeometry | null = null;
  const prototypeOf = (slot: number): THREE.BufferGeometry => {
    const shape = shapeBySlot[slot];
    if (shape.kind !== 'hull') {
      boxPrototype = boxPrototype ?? buildBoxGeometry();
      return boxPrototype;
    }
    let geometry = prototypes.get(shape.key);
    if (!geometry) {
      geometry = buildHullGeometry(shape.points);
      prototypes.set(shape.key, geometry);
    }
    return geometry;
  };

  // Budgeted per INSTANCE rather than per shape. Each instance gets its own
  // copy of the vertices because each carries its own baked rest anchor, which
  // is what keeps the whole city on one material -- see cityTexAnchor.
  let vertexBudget = 0;
  let indexBudget = 0;
  for (const slot of slots) {
    const geometry = prototypeOf(slot);
    vertexBudget += geometry.attributes.position.count;
    indexBudget += geometry.index?.count ?? 0;
  }
  sink.totalVertices += vertexBudget;
  sink.hullBatchVertices += vertexBudget;
  for (const geometry of prototypes.values()) {
    sink.hullBatchSharedVertices += geometry.attributes.position.count;
  }
  if (boxPrototype) {
    sink.hullBatchSharedVertices += (boxPrototype as THREE.BufferGeometry)
      .attributes.position.count;
  }

  // Budget doubles: the shell is a full second copy of every member. ~70k
  // verts city-wide for the packs served today -- memory noise, and the trade
  // buys the intact city back ~1,600 sub-draws (see cityShell.ts).
  const mesh = new THREE.BatchedMesh(
    slots.length + 1,
    vertexBudget * 2,
    indexBudget * 2,
    material,
  );
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

  const meshIndex = sink.renderables.length;
  const renderable: CityRenderable = { kind: 'batched', mesh };

  // Two passes so the shell can be the FIRST geometry in the batch, which pins
  // its index range to absolute 0 -- the invariant `retireShellRange` needs.
  const shell = new ShellBuilder();
  for (const slot of slots) {
    const geometry = prototypeOf(slot);
    // Rewrite the prototype's anchor in place: the shell COPIES, so one
    // mutable prototype per shape serves every instance of it.
    bakeRestAnchors(geometry, slot, sink.anchors, sink.scales);
    const range = shell.append(geometry);
    sink.shellIndexStartBySlot[slot] = range.start;
    sink.shellIndexCountBySlot[slot] = range.count;
    sink.wokenBySlot[slot] = 0;
  }
  const shellGeometryId = mesh.addGeometry(shell.build());
  const shellInstanceId = mesh.addInstance(shellGeometryId);
  mesh.setMatrixAt(shellInstanceId, IDENTITY_MATRIX);
  mesh.setColorAt(shellInstanceId, TMP_COLOR.setRGB(1, 1, 1));

  for (const slot of slots) {
    const geometry = prototypeOf(slot);
    // Re-baked unconditionally: prototypes are shared per shape, so after the
    // shell pass a prototype holds whichever slot of its shape came LAST.
    bakeRestAnchors(geometry, slot, sink.anchors, sink.scales);
    const geometryId = mesh.addGeometry(geometry);
    const instanceId = mesh.addInstance(geometryId);
    seatSlot(sink, client, renderable, meshIndex, slot, instanceId, colour);
    // Hidden until the chunk actually moves: a hidden instance is compacted
    // out of the multi-draw entirely, so the intact cell costs ONE sub-draw.
    mesh.setVisibleAt(instanceId, false);
  }
  mesh.computeBoundingSphere();
  sink.renderables.push(renderable);
  sink.cellOfRenderable.push(cell);
  sink.batchCount += 1;
  // The shell. Wakes add live sub-draws at runtime; this counter is the
  // intact-city figure.
  sink.subDraws += 1;
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
    attachInstanceAnchors(mesh, slots, sink.anchors, sink.scales);
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

/**
 * Move one slot from its cell's static shell to its own instance.
 *
 * Idempotent, and a no-op for slots that never had a shell range (boxes,
 * city-wide instanced shapes). Shared by the frame loop's first-movement wake
 * and the post-build sweep below.
 */
export function wakeSlotFromShell(state: CityMeshState, slot: number): void {
  if (state.wokenBySlot[slot]) return;
  state.wokenBySlot[slot] = 1;
  const renderable = state.renderables[state.meshOfSlot[slot]];
  const instanceId = state.instanceIds[slot];
  if (!renderable || renderable.kind !== 'batched' || instanceId < 0) return;
  if (state.shellIndexCountBySlot[slot] <= 0) return;
  retireShellRange(renderable.mesh, {
    start: state.shellIndexStartBySlot[slot],
    count: state.shellIndexCountBySlot[slot],
  });
  renderable.mesh.setVisibleAt(instanceId, true);
}

/**
 * Wake every slot whose body has already left the intact structure.
 *
 * The shell bakes REST poses, but a build does not always happen against an
 * intact city: a threshold or texture-detail change rebuilds mid-game, and a
 * late joiner's first build happens against whatever the server has already
 * demolished. Without this pass, every settled island's chunks would be drawn
 * as the un-broken shell -- ghost buildings standing over their own rubble --
 * until a repaint or bootstrap happened to mark their bodies dirty, which for
 * a settled island is never. Found by a perf report whose mid-rubble rebuild
 * rows drew a suspiciously intact city.
 */
export function wakeBrokenSlots(state: CityMeshState, client: CityClient): number {
  const chunkBody = client.topology.chunkBody;
  let woken = 0;
  for (let slot = 0; slot < chunkBody.length; slot += 1) {
    // Support serial 0 is the intact structure; everything else has broken off.
    if ((chunkBody[slot] & 0x3f_ffff) === 0) continue;
    if (!state.wokenBySlot[slot]) {
      wakeSlotFromShell(state, slot);
      woken += 1;
    }
  }
  return woken;
}

export function buildCityMesh(client: CityClient): CityMeshState {
  const manifest = client.manifest.manifest;
  const count = client.topology.chunkCount;

  const { shapeBySlot, scales, radii, localXZ, anchors, buildingCount }
    = resolveShapes(client, count);
  const sharing = groupHullShapes(shapeBySlot, count);
  const material = buildCityMaterial();

  const sink: BuildSink = {
    renderables: [],
    cellOfRenderable: [],
    meshOfSlot: new Int32Array(count).fill(-1),
    instanceIds: new Int32Array(count).fill(-1),
    hiddenBySlot: new Uint8Array(count),
    belowStreakBySlot: new Uint8Array(count),
    // Every slot starts woken; buildCellHullBatch clears the flag for the
    // slots it folds into a shell.
    wokenBySlot: new Uint8Array(count).fill(1),
    shellIndexStartBySlot: new Int32Array(count).fill(-1),
    shellIndexCountBySlot: new Int32Array(count).fill(0),
    scales,
    anchors,
    baseColors: resolveTints(client, count),
    totalVertices: 0,
    hullBatchVertices: 0,
    hullBatchSharedVertices: 0,
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
    const colour = chunkBaseColor();
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
    // Bonded components, i.e. buildings -- what the concrete is keyed on. One
    // structure can hold the whole skyline, so this is the number that matters.
    buildings: buildingCount,
    instancedCells: sink.instancedCount,
    hullBatches: sink.batchCount,
    // Distinct shard shapes, and how many were shared widely enough to
    // instance. 7,160 shapes for 7,160 shards means nothing can be instanced.
    hullShapes: sharing.slotsOfHullKey.size,
    instancedHullShapes: sharing.instancedKeys.size,
    // Vertices in hull batches, and the multiple over what shape-sharing would
    // have cost. That multiple is the price of per-instance rest anchors.
    hullBatchVertices: sink.hullBatchVertices,
    hullBatchVertexRatio: sink.hullBatchSharedVertices > 0
      ? Number((sink.hullBatchVertices / sink.hullBatchSharedVertices).toFixed(2))
      : 1,
    // Sub-draws, not draw calls: this is the number frame time tracks.
    subDraws: sink.subDraws,
    shareThreshold: minShareToInstance(),
    vertices: sink.totalVertices,
  });

  renderStats.subDraws = sink.subDraws;
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
    wokenBySlot: sink.wokenBySlot,
    shellIndexStartBySlot: sink.shellIndexStartBySlot,
    shellIndexCountBySlot: sink.shellIndexCountBySlot,
  };
}
