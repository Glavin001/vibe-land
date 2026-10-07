// A real building from the game's packs as a Fracture Lab specimen.
//
// Reads the ScenePack JSON directly (v1 and v2), like StructureViewer, so the
// lab needs no server. Pieces keep the pack's own colliders; materials come
// from `nodeMaterials`, or the solver material each node names; bond materials
// become joint hints for the contact classifier.

import { pairKey, type FracturePiece } from '../city/fracture/contacts';
import { fractureClassOf, FractureClass } from '../city/fracture/materialClass';
import type { Vec3 } from '../city/fracture/math';
import { polytopeFromBox, polytopeFromPoints } from '../city/fracture/polytope';
import type { Specimen } from '../city/fracture/specimens';
import type { PackCollider, PackMaterial } from '../structures/structurePack';

export interface PackSpecimen extends Specimen {
  bondMaterial: Map<number, string>;
  /** Texture key per piece from the pack's own appearance table, when it has one. */
  textureKeys: Array<string | null>;
}

export const LAB_PACKS = [
  { key: 'high-rise-3f-local', title: 'City high-rise (the /city default)' },
  { key: 'fractured-highrise-10f', title: 'Fractured 10-floor high-rise' },
  { key: 'house-1story', title: 'Brick house, one storey' },
  { key: 'veneer-house', title: 'Town-kit veneer house', dir: 'town-kit' },
  { key: 'rig-wall', title: 'Brick test wall (rig)' },
] as const;
export type LabPackKey = typeof LAB_PACKS[number]['key'];

interface RawPack {
  version: number;
  defaults?: { solver?: { materials?: PackMaterial[] } };
  scenario: {
    nodes: Array<{ centroid: { x: number; y: number; z: number }; m?: number }>;
    nodeColliders: PackCollider[];
    nodeMaterials?: string[];
    shapeLibrary?: PackCollider[];
    bonds?: Array<{ node0: number; node1: number; m?: number }>;
  };
}

function packUrl(key: LabPackKey): string {
  const entry = LAB_PACKS.find((p) => p.key === key)!;
  const dir = 'dir' in entry && entry.dir === 'town-kit'
    ? `${__SCENES_DIR__}/../../../structures/town-kit/out/veneer-houses`
    : __SCENES_DIR__;
  return import.meta.env.DEV ? `/@fs${dir}/${key}.json` : `/scenes/${key}.json`;
}

export async function loadPackSpecimen(key: LabPackKey): Promise<PackSpecimen> {
  const response = await fetch(packUrl(key));
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`pack ${key}: ${response.status} from ${packUrl(key)}`);
  }
  return packToSpecimen(key, (await response.json()) as RawPack);
}

export function packToSpecimen(key: string, pack: RawPack): PackSpecimen {
  const { nodes, nodeColliders, nodeMaterials, shapeLibrary, bonds } = pack.scenario;
  const solverMaterials = pack.defaults?.solver?.materials ?? [];
  const pieces: FracturePiece[] = [];
  const textureKeys: Array<string | null> = [];
  const pieceOfNode = new Int32Array(nodes.length).fill(-1);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  nodes.forEach((node, i) => {
    let collider = nodeColliders[i];
    if (collider?.kind === 'shape') collider = shapeLibrary?.[collider.shape] ?? collider;
    const poly = collider?.kind === 'cuboid'
      ? polytopeFromBox([collider.halfExtents.x, collider.halfExtents.y, collider.halfExtents.z])
      : collider?.kind === 'convex_hull' ? polytopeFromPoints(collider.points) : null;
    if (!poly) return;
    const solver = node.m !== undefined ? solverMaterials[node.m] : undefined;
    const material = nodeMaterials?.[i] ?? solver?.name ?? 'reinforced-concrete';
    const cls = fractureClassOf(material, FractureClass.Reinforced);
    const centroid: Vec3 = [node.centroid.x, node.centroid.y, node.centroid.z];
    // Members are boxes; wood grain runs along their longest side.
    let grainAxis: number | undefined;
    if (cls === FractureClass.Wood) {
      let best = 0;
      for (let k = 1; k < 3; k += 1) {
        const ext = (a: number): number => Math.max(...poly.verts.map((v) => v[a])) - Math.min(...poly.verts.map((v) => v[a]));
        if (ext(k) > ext(best)) best = k;
      }
      grainAxis = best;
    }
    pieceOfNode[i] = pieces.length;
    pieces.push({ centroid, poly, material, cls, grainAxis });
    const named = solverMaterials.find((m) => m.name === material);
    textureKeys.push(named?.textureKey ?? null);
    for (const v of poly.verts) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], v[k] + centroid[k]);
        max[k] = Math.max(max[k], v[k] + centroid[k]);
      }
    }
  });

  const bondMaterial = new Map<number, string>();
  for (const bond of bonds ?? []) {
    const a = pieceOfNode[bond.node0];
    const b = pieceOfNode[bond.node1];
    const name = bond.m !== undefined ? solverMaterials[bond.m]?.name : undefined;
    if (a >= 0 && b >= 0 && name) bondMaterial.set(pairKey(a, b), name);
  }

  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return {
    key, title: LAB_PACKS.find((p) => p.key === key)?.title ?? key, pieces, rebar: [],
    impact: [centre[0], centre[1], max[2]], splitNormal: [1, 0, 0], min, max,
    bondMaterial, textureKeys,
  };
}
