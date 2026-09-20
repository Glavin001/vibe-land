// What the fluid pools against: the standing city, voxelized into the brick.
//
// Every chunk still on its structure's support body, or on an island that
// has settled, is a wall or a floor the dust cannot pass. Moving rubble is
// not: it changes every tick, and dust passing through a falling slab is
// invisible next to the slab. Chunks are boxes in their rest frame; the
// world-space box is the rotated box's bounding box, conservative by up to
// a corner, which for a 0.25 m cell is one cell.

import type { CityManifest, ManifestStructure } from '../../city/manifest';
import type { CityTopology } from '../../city/topology';
import { SUPPORT_SERIAL } from '../../city/topology';
import { atlasIndex, type AtlasLayout } from './fluidAtlas';

const pose = new Float32Array(7);

export interface BrickFrame {
  originX: number;
  originY: number;
  originZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

/**
 * Fills `out` (atlas-shaped, one byte per cell) with 1 where a static chunk
 * or the ground is. Returns how many chunks were voxelized.
 */
export function voxelizeStaticChunks(
  topology: CityTopology,
  manifest: CityManifest,
  frame: BrickFrame,
  layout: AtlasLayout,
  out: Uint8Array,
  structureById: Map<number, ManifestStructure> = new Map(manifest.structures.map((s) => [s.structureId, s])),
): number {
  out.fill(0);
  const cellX = frame.sizeX / layout.nx;
  const cellY = frame.sizeY / layout.ny;
  const cellZ = frame.sizeZ / layout.nz;
  // The ground is always solid: a flat plane at y = 0.
  if (frame.originY <= 0) {
    const rows = Math.min(layout.ny, Math.ceil((0 - frame.originY) / cellY) + 1);
    for (let z = 0; z < layout.nz; z += 1) {
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < layout.nx; x += 1) out[atlasIndex(layout, x, y, z)] = 1;
      }
    }
  }
  const maxX = frame.originX + frame.sizeX;
  const maxY = frame.originY + frame.sizeY;
  const maxZ = frame.originZ + frame.sizeZ;
  let voxelized = 0;
  for (let slot = 0; slot < topology.chunkCount; slot += 1) {
    const body = topology.body(topology.chunkBodyKey(slot));
    if (!body || (body.islandSerial !== SUPPORT_SERIAL && !body.settled)) continue;
    if (!topology.chunkWorldPoseInto(slot, body, pose, 0)) continue;
    const structure = structureById.get(topology.chunkStructure(slot));
    if (!structure) continue;
    const chunk = structure.chunks[topology.chunkNode(slot)];
    if (!chunk) continue;
    const hx = chunk.size[0] / 2;
    const hy = chunk.size[1] / 2;
    const hz = chunk.size[2] / 2;
    // World-space half extents of the rotated box: |R| · h.
    const qx = pose[3];
    const qy = pose[4];
    const qz = pose[5];
    const qw = pose[6];
    const r00 = 1 - 2 * (qy * qy + qz * qz);
    const r01 = 2 * (qx * qy - qz * qw);
    const r02 = 2 * (qx * qz + qy * qw);
    const r10 = 2 * (qx * qy + qz * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    const r20 = 2 * (qx * qz - qy * qw);
    const r21 = 2 * (qy * qz + qx * qw);
    const r22 = 1 - 2 * (qx * qx + qy * qy);
    const ex = Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz;
    const ey = Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz;
    const ez = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz;
    const minWx = pose[0] - ex;
    const maxWx = pose[0] + ex;
    const minWy = pose[1] - ey;
    const maxWy = pose[1] + ey;
    const minWz = pose[2] - ez;
    const maxWz = pose[2] + ez;
    if (maxWx <= frame.originX || minWx >= maxX || maxWy <= frame.originY || minWy >= maxY || maxWz <= frame.originZ || minWz >= maxZ) continue;
    const x0 = Math.max(0, Math.floor((minWx - frame.originX) / cellX));
    const x1 = Math.min(layout.nx - 1, Math.floor((maxWx - frame.originX) / cellX));
    const y0 = Math.max(0, Math.floor((minWy - frame.originY) / cellY));
    const y1 = Math.min(layout.ny - 1, Math.floor((maxWy - frame.originY) / cellY));
    const z0 = Math.max(0, Math.floor((minWz - frame.originZ) / cellZ));
    const z1 = Math.min(layout.nz - 1, Math.floor((maxWz - frame.originZ) / cellZ));
    for (let z = z0; z <= z1; z += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) out[atlasIndex(layout, x, y, z)] = 1;
      }
    }
    voxelized += 1;
  }
  return voxelized;
}
