/**
 * The city manifest decoded by the shared decoder (destruction/src/manifest_binary.rs, through
 * client-core-wasm `decode_city_manifest`): the decoder the Unreal client's core uses. It builds
 * the same CityManifest manifestBinary.ts does (chunks as objects, bonds as typed arrays, fields
 * omitted where that file omits them), so nothing downstream can tell the two apart
 * (manifestCore.test.ts). Behind `?coreManifest=1` (core/clientCore.ts installs it).
 */
import { decode_city_manifest } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import type { CityManifest, ManifestChunk, ManifestStructure, MaterialAppearance } from './manifest';

const NO_SHAPE = 0xffffffff;

export function decodeManifestCore(bytes: ArrayBuffer): CityManifest {
  const m = decode_city_manifest(new Uint8Array(bytes));
  try {
    const structures: ManifestStructure[] = [];
    for (let s = 0; s < m.structure_count(); s += 1) {
      const place = m.placement(s);
      const f = m.chunk_floats(s);
      const n = m.chunk_ints(s);
      const points = m.chunk_points(s);
      const count = n.length / 6;
      const chunks: ManifestChunk[] = new Array(count);
      let at = 0;
      for (let i = 0; i < count; i += 1) {
        const F = i * 15;
        const N = i * 6;
        const vec = (o: number): [number, number, number] => [f[F + o], f[F + o + 1], f[F + o + 2]];
        const [nodeIndex, material, support, kind, shapeId, pointCount] = [n[N], n[N + 1], n[N + 2], n[N + 3], n[N + 4], n[N + 5]];
        const chunk: ManifestChunk = {
          nodeIndex,
          centroid: vec(0),
          mass: f[F + 3],
          volume: f[F + 4],
          size: vec(5),
          radius: f[F + 8],
          support: support !== 0,
          geometry: kind === 0
            ? { kind: 'cuboid', halfExtents: vec(9) }
            : {
              kind: 'convexHull',
              points: pointCount > 0 ? Array.from(points.subarray(at, at + pointCount)) : [],
              ...(shapeId !== NO_SHAPE ? { shapeId } : {}),
            },
        };
        at += pointCount;
        if (material !== 0) chunk.material = material;
        if (f[F + 12] !== 0 || f[F + 13] !== 0 || f[F + 14] !== 0) chunk.massOffset = vec(12);
        chunks[i] = chunk;
      }
      const bondNode0 = m.bond_node0(s);
      structures.push({
        structureId: m.structure_id(s),
        worldPosition: [place[0], place[1], place[2]],
        worldRotation: [place[3], place[4], place[5], place[6]],
        chunks,
        bondCount: bondNode0.length,
        bondNode0,
        bondNode1: m.bond_node1(s),
        bondCentroid: m.bond_centroid(s),
        bondNormal: m.bond_normal(s),
        bondArea: m.bond_area(s),
        bondMaterial: m.bond_material(s),
      });
    }
    const manifest: CityManifest = { version: m.version(), structures };
    const shapeLibrary: number[][] = [];
    for (let i = 0; i < m.shape_count(); i += 1) shapeLibrary.push(Array.from(m.shape(i)));
    if (shapeLibrary.length > 0) manifest.shapeLibrary = shapeLibrary;
    const appearance = m.appearance_json();
    if (appearance) manifest.materialAppearance = JSON.parse(appearance) as MaterialAppearance[];
    const strength = m.material_strength();
    if (strength.length > 0) manifest.materialStrength = strength;
    return manifest;
  } finally {
    m.free();
  }
}
