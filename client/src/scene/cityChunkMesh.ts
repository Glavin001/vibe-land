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
//   lone hulls   -> one CitySlotMesh per render cell: the cell's geometry
//                   merged, each vertex tagged with its chunk, matrices in a
//                   texture. ONE draw per pass whether none of its chunks are
//                   moving or all of them are. (It replaced a BatchedMesh,
//                   whose per-chunk sub-draws made the Mac's GPU cost scale
//                   with the number of chunks awake; see citySlotMesh.ts.)
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
  heroTilingEnabled,
  shadowsEnabled,
} from '../app/renderQuality';
import { CityGpuPoses, CitySlotMesh, SlotGeometryBuilder, type CityRenderable } from './citySlotMesh';
import type { LedgerBody } from '../city/topology';
import { renderStats } from '../city/renderStats';
import { applyCityTriplanar } from './cityMaterialShader';
import { bakeRestAnchors } from './cityTexAnchor';
import { layerCodeForBuilding, layerCodeForTextureKey } from './cityTextures';
import { bondEndpoints, type MaterialAppearance } from '../city/manifest';

const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_COLOR = new THREE.Color();
const IDENTITY_MATRIX = new THREE.Matrix4();

export type CityMeshState = {
  /** One drawable per render cell (and per material within it), in build order. */
  renderables: CityRenderable[];
  /**
   * Renderable -> the render cell it was cut from. The distance stride is
   * staggered by cell so everything sharing an upload defers together.
   */
  cellOfRenderable: Int32Array;
  /** Slot -> index into `renderables`. */
  meshOfSlot: Int32Array;
  /** Per-slot render scale: box extents, or 1 for hulls (already metric). */
  scales: Float32Array;
  /** Bounding radius per chunk. */
  radii: Float32Array;
  /** The chunk records and body poses the GPU composes from. */
  poses: CityGpuPoses;
  /** Every material the cells share: the concrete, any glass, the shadow depth. */
  materials: THREE.Material[];
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
  applyCityTriplanar(material, pbr, cityTextureDetail(), heroTilingEnabled());
  return material;
}

/**
 * The material for chunks a pack marked transparent.
 *
 * There is no transparency anywhere else in the destructible pipeline — the
 * city's own packs are opaque concrete throughout, and the only other glass in
 * the game is a decorative plane inset into a vehicle. An authored structure
 * that says a piece is glazing needs a second material, because transparency is
 * a property of the material and cannot be carried per instance.
 *
 * Deliberately plain: a flat tint at partial opacity, no transmission and no
 * refraction, both of which cost a render pass and buy nothing at the distance
 * a building is looked at.
 */
function buildGlassMaterial(appearance: MaterialAppearance): THREE.Material {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(appearance.color ?? '#7fb6e0'),
    transparent: true,
    opacity: appearance.opacity ?? 0.5,
    roughness: appearance.roughness ?? 0.06,
    metalness: appearance.metalness ?? 0,
    side: THREE.DoubleSide,
    // Depth IS written, which is unusual for a transparent material. The city
    // draws its chunks in cell batches with no back-to-front ordering between
    // them, so every pane on the far side of a building would otherwise blend
    // through every pane on the near side and a curtain wall five panes deep
    // comes out opaque navy. Writing depth keeps the nearest glass surface,
    // which is what looking at a glazed facade actually gives you.
    depthWrite: true,
    // One pass for both faces. Three's default for a transparent DoubleSide
    // material is two draws per mesh (backs, then fronts), each flagged
    // needsUpdate -- two shader-program lookups per glass draw, every frame.
    // The nearest pane wins here regardless (depth is written), so the
    // ordering the second pass buys is nothing this material can show.
    forceSinglePass: true,
    reflectivity: 0.7,
    envMapIntensity: 2.2,
  });
}

/**
 * Per-slot material index, and which slots are transparent.
 *
 * Absent on every pack that authors no per-node material, in which case every
 * slot is material 0 and nothing is transparent — the existing city path,
 * unchanged.
 */
function resolveChunkMaterials(client: CityClient, count: number): {
  materialOfSlot: Int32Array;
  transparentBySlot: Uint8Array;
  appearance: MaterialAppearance[];
} {
  const manifest = client.manifest.manifest;
  const appearance = manifest.materialAppearance ?? [];
  const materialOfSlot = new Int32Array(count);
  const transparentBySlot = new Uint8Array(count);
  if (appearance.length === 0) {
    return { materialOfSlot, transparentBySlot, appearance };
  }
  for (const structure of manifest.structures) {
    for (const chunk of structure.chunks) {
      const slot = client.topology.slotOf(structure.structureId, chunk.nodeIndex);
      const material = chunk.material ?? 0;
      materialOfSlot[slot] = material;
      if (appearance[material]?.opacity != null) transparentBySlot[slot] = 1;
    }
  }
  return { materialOfSlot, transparentBySlot, appearance };
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
    // Endpoints only: the union-find wants which chunks a bond joins, and a
    // bond's centroid, normal and area are the solver's business.
    const { node0, node1 } = bondEndpoints(structure);
    for (let i = 0; i < node0.length; i += 1) {
      const a = find(client.topology.slotOf(structure.structureId, node0[i]));
      const b = find(client.topology.slotOf(structure.structureId, node1[i]));
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
function resolveShapes(
  client: CityClient,
  count: number,
  materials: ReturnType<typeof resolveChunkMaterials>,
): ResolvedShapes {
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
      // A pack that names its materials picks the texture layer by name; one
      // that does not falls back to hashing the building id, which is the only
      // thing that distinguishes buildings made of identical concrete.
      const appearance = materials.appearance[materials.materialOfSlot[slot]];
      // '' rather than undefined for a material with appearance but no named
      // surface: it still wants a fixed layer, not a hashed one.
      const keyed = materials.appearance.length > 0
        ? layerCodeForTextureKey(appearance?.textureKey ?? '')
        : null;
      anchors[slot * 4 + 3] = keyed ?? layerCodeForBuilding(buildingOfSlot[slot]);

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


/** Mutable accumulator threaded through the cell builder. */
type BuildSink = {
  renderables: CityRenderable[];
  cellOfRenderable: number[];
  meshOfSlot: Int32Array;
  scales: Float32Array;
  radii: Float32Array;
  anchors: Float32Array;
  poses: CityGpuPoses;
  totalVertices: number;
};

const TMP_LOCAL = new Float32Array(3);
const TMP_LOCAL_ROT = new Float32Array(4);

/**
 * Write one chunk's record: which body it rides and where it sits on it.
 * Called at build for every slot and afterwards for every slot the ledger
 * reassigns (`drainSlotChanges`). Returns false when the ledger cannot say
 * which body the chunk is on right now; the caller retries next frame and the
 * chunk keeps drawing where it was, which is the only correct thing to show.
 */
export function writeChunkRecord(state: CityMeshState, client: CityClient, slot: number): boolean {
  const key = client.topology.chunkBody[slot];
  const body = client.topology.body(key);
  if (!body) return false;
  const index = state.poses.bodyIndexFor(key);
  client.topology.localOffsetInto(slot, TMP_LOCAL);
  client.topology.localRotationInto(slot, TMP_LOCAL_ROT);
  state.poses.writeChunk(slot, index, TMP_LOCAL, TMP_LOCAL_ROT, state.radii[slot]);
  return true;
}

/**
 * Write one body's pose as the ledger holds it. `tint` dims settled rubble;
 * the debug palette, when on, colours by body.
 */
export function writeBodyPose(
  state: CityMeshState,
  body: LedgerBody,
  tint: number,
  colour: THREE.Color | null,
): void {
  const index = state.poses.bodyIndexFor(body.key);
  state.poses.writeBody(
    index,
    body.position,
    body.rotation,
    tint,
    colour ? colour.r : 1,
    colour ? colour.g : 1,
    colour ? colour.b : 1,
  );
}

/** One cell (one material): every member merged, one draw. */
function buildCell(
  sink: BuildSink,
  client: CityClient,
  material: THREE.Material,
  depth: THREE.Material,
  shapeBySlot: ResolvedShapes['shapeBySlot'],
  cell: number,
  slots: number[],
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
  let vertexBudget = 0;
  let indexBudget = 0;
  for (const slot of slots) {
    const geometry = prototypeOf(slot);
    vertexBudget += geometry.attributes.position.count;
    indexBudget += geometry.index?.count ?? 0;
  }
  sink.totalVertices += vertexBudget;

  const builder = new SlotGeometryBuilder(vertexBudget, indexBudget);
  const meshIndex = sink.renderables.length;
  for (const slot of slots) {
    const geometry = prototypeOf(slot);
    // Rewrite the prototype's anchor in place: the builder COPIES, so one
    // mutable prototype per shape serves every instance of it. The anchor is
    // rest position plus rest scale times local position, so it is baked
    // before the scale goes into the vertices.
    bakeRestAnchors(geometry, slot, sink.anchors, sink.scales);
    builder.append(geometry, slot, sink.scales[slot * 3], sink.scales[slot * 3 + 1], sink.scales[slot * 3 + 2]);
    sink.meshOfSlot[slot] = meshIndex;
  }
  const mesh = new CitySlotMesh(builder.build(), material, depth, sink.poses, slots);
  mesh.castShadow = shadowsEnabled();
  mesh.receiveShadow = shadowsEnabled();
  // Whole-cell culling is one sphere test that can drop a block. Only worth
  // anything because cells are cell sized: a city-wide mesh always intersects
  // the frustum.
  mesh.frustumCulled = true;
  sink.renderables.push({ kind: 'slots', mesh });
  sink.cellOfRenderable.push(cell);
}

/**
 * Re-derive a cell's culling sphere from where its bodies are now.
 *
 * A cell is culled against its bounding sphere, and debris falls outside the
 * footprint the sphere was built from. Every chunk's body origin plus its
 * reach is visited on every call, so the sphere is conservative for the poses
 * actually drawn, not for a history of them -- a wrongly small sphere culls a
 * whole batch, a block of city gone, and that failure is not verifiable by
 * any counter this client has.
 */
export function refreshRenderableSphere(state: CityMeshState, index: number): void {
  state.renderables[index]?.mesh.computeBoundingSphere();
}

export function buildCityMesh(client: CityClient): CityMeshState {
  const manifest = client.manifest.manifest;
  const count = client.topology.chunkCount;

  const materials = resolveChunkMaterials(client, count);
  const { shapeBySlot, scales, radii, localXZ, anchors }
    = resolveShapes(client, count, materials);
  const poses = new CityGpuPoses(count, radii);

  const sink: BuildSink = {
    renderables: [],
    cellOfRenderable: [],
    meshOfSlot: new Int32Array(count).fill(-1),
    scales,
    radii,
    anchors,
    poses,
    totalVertices: 0,
  };

  // One material per surface KIND for the whole city, not per cell: the pose
  // textures every cell reads are city-wide, so nothing about a material is
  // per cell, and three re-uploads a material's uniforms only when the
  // material changes between draws.
  const concrete = buildCityMaterial();
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const glassByKey = new Map<number, THREE.Material>();
  const materialFor = (key: number): THREE.Material => {
    const glass = key < 0 ? undefined : materials.appearance[key];
    if (!glass || glass.opacity == null) return concrete;
    let built = glassByKey.get(key);
    if (!built) {
      built = buildGlassMaterial(glass);
      glassByKey.set(key, built);
    }
    return built;
  };

  let cellCount = 0;
  for (const structure of manifest.structures) {
    const structureSlots = structure.chunks.map((chunk) =>
      client.topology.slotOf(structure.structureId, chunk.nodeIndex),
    );
    // Cells are cut inside a structure, so a grid of separate buildings still
    // gets at least one mesh per building (each far smaller than a cell) and a
    // district pack gets one per city block.
    for (const slots of partitionSlotsByCell(localXZ, structureSlots).values()) {
      // Cell ids run across structures, so two structures' cells never share a
      // stagger phase just because both were the third cell of their own pack.
      const cell = cellCount;
      cellCount += 1;
      // Split by MATERIAL. Transparency is a property of the material and
      // cannot ride on a vertex, so a cell holding both glazing and concrete
      // gets a mesh of each. Only transparency splits: opaque chunks of every
      // material share one, because which brick or concrete they wear travels
      // in the anchor.
      const byMaterial = new Map<number, number[]>();
      for (const slot of slots) {
        const key = materials.transparentBySlot[slot] ? materials.materialOfSlot[slot] : -1;
        const list = byMaterial.get(key) ?? [];
        list.push(slot);
        byMaterial.set(key, list);
      }
      for (const [key, list] of byMaterial) {
        buildCell(sink, client, materialFor(key), depth, shapeBySlot, cell, list);
      }
    }
  }

  const state: CityMeshState = {
    renderables: sink.renderables,
    cellOfRenderable: Int32Array.from(sink.cellOfRenderable),
    meshOfSlot: sink.meshOfSlot,
    scales,
    radii,
    poses,
    materials: [concrete, depth, ...glassByKey.values()],
  };
  // Every record and every body the ledger has, so the first frame draws the
  // city exactly as the ledger holds it -- intact, or mid-collapse for a late
  // join or a mid-game rebuild.
  for (const body of client.topology.allBodies()) {
    writeBodyPose(state, body, body.settled ? 0.75 : 1, null);
  }
  for (let slot = 0; slot < count; slot += 1) writeChunkRecord(state, client, slot);
  poses.upload();
  for (const { mesh } of state.renderables) mesh.anchorSphere();

  console.info('[city] chunk meshes ready', {
    chunks: count,
    structures: manifest.structures.length,
    cells: cellCount,
    meshes: state.renderables.length,
    vertices: sink.totalVertices,
  });
  renderStats.subDraws = state.renderables.length;
  return state;
}
