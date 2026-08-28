/**
 * Loading an authored ScenePack straight into the viewer.
 *
 * This is the pack as it comes out of blast-stress-solver-2's
 * `structures/build.mjs` — the same JSON the Rust server parses, read directly
 * rather than through the DestructionManifest the game normally hands clients.
 * Reading the pack means the viewer needs no server, no PhysX and no manifest
 * hash, which is the point: a structure can be regenerated and looked at in
 * seconds.
 *
 * `nodeMaterials` and `nodeTypes` are additions the authored packs carry and
 * `scene_pack.rs` ignores (it has no `deny_unknown_fields`). They are what let
 * this viewer shade a piece by what it is MADE OF, which the game's own city
 * path cannot do — there, every chunk shares one material and variety comes
 * from hashing the building id into the texture array.
 */
import { LAYER_CODE_RADIX } from '../scene/cityTextures';
import { CITY_TEXTURE_SETS } from '../scene/cityTextureSets.generated';

export type PackVec3 = { x: number; y: number; z: number };

export type PackCollider =
  | { kind: 'cuboid'; halfExtents: PackVec3 }
  | { kind: 'convex_hull'; points: number[] }
  | { kind: 'shape'; shape: number };

export interface PackMaterial {
  name: string;
  compressionElastic: number;
  compressionFatal: number;
  /** Appearance, added by the authoring library. */
  color?: string;
  opacity?: number;
  textureKey?: string | null;
  roughness?: number;
  metalness?: number;
  density?: number;
}

export interface ScenePack {
  version: number;
  key: string;
  title: string;
  defaults?: {
    camera?: { target: PackVec3; distance: number };
    solver?: { materials?: PackMaterial[] };
  };
  scenario: {
    nodes: { centroid: PackVec3; mass: number; volume: number; m?: number }[];
    nodeSizes: PackVec3[];
    nodeColliders: PackCollider[];
    nodeTypes?: string[];
    nodeMaterials?: string[];
    nodePieces?: number[];
    shapeLibrary?: PackCollider[];
  };
}

export async function loadScenePack(name: string): Promise<ScenePack> {
  // `server.fs.allow: ['..']` in vite.config.ts already permits this, so the
  // viewer reads the pack from destruction/assets/scenes with no plugin, no
  // copy into public/, and no megabytes duplicated in the repo.
  const url = `/@fs${SCENES_DIR}/${name}.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`pack "${name}": ${response.status} ${response.statusText} from ${url}`);
  const pack = (await response.json()) as ScenePack;
  if (pack.version !== 2) throw new Error(`pack "${name}": expected version 2, got ${pack.version}`);
  return pack;
}

/** Absolute path to the pack directory, injected by vite.config.ts. */
const SCENES_DIR = __SCENES_DIR__;

/**
 * Texture layer code for a material, in the same packing the city uses:
 * `wall + LAYER_CODE_RADIX * floor`, carried in the w of each vertex anchor.
 *
 * The city derives these by hashing a building id, because all its buildings
 * are the same concrete and the hash is only there to tell them apart. An
 * authored structure knows a piece is brick, so it looks the layer up by name.
 */
export function layerCodeForMaterial(material: PackMaterial | undefined): number {
  const key = material?.textureKey ?? null;
  const wall = key ? indexOfKey(key) : indexOfKey('concrete-wall');
  // Steel reads as metal from every angle, so its floor projection is the metal
  // layer too; everything else takes worn concrete on its up-facing surfaces,
  // which is what a slab top or a broken edge actually looks like.
  const floor = key === 'metal' ? wall : indexOfKey('concrete-floor');
  return wall + LAYER_CODE_RADIX * floor;
}

function indexOfKey(key: string): number {
  const index = CITY_TEXTURE_SETS.findIndex((set) => set.materialKey === key);
  return index >= 0 ? index : 0;
}

/** Bounding box of every node in the pack, for framing the camera. */
export function packBounds(pack: ScenePack): {
  min: [number, number, number];
  max: [number, number, number];
  centre: [number, number, number];
  radiusM: number;
  topM: number;
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { nodes, nodeSizes } = pack.scenario;
  for (let i = 0; i < nodes.length; i += 1) {
    const c = nodes[i].centroid, s = nodeSizes[i];
    const lo = [c.x - s.x / 2, c.y - s.y / 2, c.z - s.z / 2];
    const hi = [c.x + s.x / 2, c.y + s.y / 2, c.z + s.z / 2];
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], lo[a]);
      max[a] = Math.max(max[a], hi[a]);
    }
  }
  const centre: [number, number, number] = [
    (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
  ];
  return {
    min, max, centre,
    radiusM: Math.max(max[0] - min[0], max[2] - min[2]) / 2,
    topM: max[1],
  };
}
