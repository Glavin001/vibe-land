// How much room a cloud has: the distance from a point to the nearest
// standing chunk along each axis.
//
// Parcels are analytic shapes; they do not collide. Without this a puff born
// in a room grows straight through its walls and is seen from the street
// as a cloud hanging out of an intact facade. So at birth each parcel asks
// how far it may reach along −x +x −y +y −z +z before hitting something,
// and the store clamps its box and its drift to that room.
//
// A grid of chunk bounding boxes at their rest poses (built once per
// manifest, 4 m cells), consulted with the ledger at query time so a wall
// that has fallen no longer counts. Six axis rays, a few cells each; a few
// hundred box tests per birth, at most 32 births a tick.

import type { CityManifest } from '../city/manifest';
import type { CityTopology } from '../city/topology';
import { SUPPORT_SERIAL } from '../city/topology';

const CELL_M = 4;
/** Beyond this a cloud is in open air as far as its room goes. */
export const CLEARANCE_MAX_M = 16;
/** The ray must pass through the box's cross-section by at least this margin to count. */
const OVERLAP_MARGIN_M = 0.35;

export interface GridBox {
  slot: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function fold(v: number): number {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

function cellKey(cx: number, cy: number, cz: number): number {
  return (fold(cx) * 4096 + fold(cy)) * 4096 + fold(cz);
}

export class DustClearance {
  private readonly cells = new Map<number, GridBox[]>();

  constructor(
    private readonly topology: CityTopology,
    manifest: CityManifest,
  ) {
    for (const structure of manifest.structures) {
      const [qx, qy, qz, qw] = structure.worldRotation;
      const r00 = 1 - 2 * (qy * qy + qz * qz);
      const r01 = 2 * (qx * qy - qz * qw);
      const r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw);
      const r11 = 1 - 2 * (qx * qx + qz * qz);
      const r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw);
      const r21 = 2 * (qy * qz + qx * qw);
      const r22 = 1 - 2 * (qx * qx + qy * qy);
      const [wx, wy, wz] = structure.worldPosition;
      for (const chunk of structure.chunks) {
        const [cx, cy, cz] = chunk.centroid;
        const x = wx + r00 * cx + r01 * cy + r02 * cz;
        const y = wy + r10 * cx + r11 * cy + r12 * cz;
        const z = wz + r20 * cx + r21 * cy + r22 * cz;
        const hx = chunk.size[0] / 2;
        const hy = chunk.size[1] / 2;
        const hz = chunk.size[2] / 2;
        const ex = Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz;
        const ey = Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz;
        const ez = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz;
        const box: GridBox = {
          slot: topology.slotOf(structure.structureId, chunk.nodeIndex),
          minX: x - ex, minY: y - ey, minZ: z - ez, maxX: x + ex, maxY: y + ey, maxZ: z + ez,
        };
        const x0 = Math.floor(box.minX / CELL_M);
        const x1 = Math.floor(box.maxX / CELL_M);
        const y0 = Math.floor(box.minY / CELL_M);
        const y1 = Math.floor(box.maxY / CELL_M);
        const z0 = Math.floor(box.minZ / CELL_M);
        const z1 = Math.floor(box.maxZ / CELL_M);
        for (let gz = z0; gz <= z1; gz += 1) {
          for (let gy = y0; gy <= y1; gy += 1) {
            for (let gx = x0; gx <= x1; gx += 1) {
              const key = cellKey(gx, gy, gz);
              let list = this.cells.get(key);
              if (!list) {
                list = [];
                this.cells.set(key, list);
              }
              list.push(box);
            }
          }
        }
      }
    }
  }

  /** Every box whose grid cell range touches the world-space range, standing or not. */
  forEachBoxIn(
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
    visit: (box: GridBox) => void,
  ): void {
    const seen = new Set<number>();
    const x0 = Math.floor(minX / CELL_M);
    const x1 = Math.floor(maxX / CELL_M);
    const y0 = Math.floor(minY / CELL_M);
    const y1 = Math.floor(maxY / CELL_M);
    const z0 = Math.floor(minZ / CELL_M);
    const z1 = Math.floor(maxZ / CELL_M);
    for (let gz = z0; gz <= z1; gz += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        for (let gx = x0; gx <= x1; gx += 1) {
          const list = this.cells.get(cellKey(gx, gy, gz));
          if (!list) continue;
          for (const box of list) {
            if (seen.has(box.slot)) continue;
            seen.add(box.slot);
            visit(box);
          }
        }
      }
    }
  }

  /** Whether the chunk is still standing: on its support body, or settled. */
  standing(slot: number): boolean {
    const body = this.topology.body(this.topology.chunkBodyKey(slot));
    return !!body && (body.islandSerial === SUPPORT_SERIAL || body.settled);
  }

  /**
   * Fills out[0..6) with the clearance along −x +x −y +y −z +z from the
   * point, capped at CLEARANCE_MAX_M. The ground is a floor at y = 0.
   */
  clearanceAt(x: number, y: number, z: number, out: number[] | Float32Array): void {
    out[0] = CLEARANCE_MAX_M;
    out[1] = CLEARANCE_MAX_M;
    out[2] = Math.max(0, y);
    out[3] = CLEARANCE_MAX_M;
    out[4] = CLEARANCE_MAX_M;
    out[5] = CLEARANCE_MAX_M;
    const cells = Math.ceil(CLEARANCE_MAX_M / CELL_M);
    const gx = Math.floor(x / CELL_M);
    const gy = Math.floor(y / CELL_M);
    const gz = Math.floor(z / CELL_M);
    const m = OVERLAP_MARGIN_M;
    // Inside a standing chunk there is no room at all.
    let inside = false;
    this.scan(cellKey(gx, gy, gz), (b) => {
      if (b.minX < x && b.maxX > x && b.minY < y && b.maxY > y && b.minZ < z && b.maxZ > z) inside = true;
    });
    if (inside) {
      out.fill(0);
      return;
    }
    for (let step = -cells; step <= cells; step += 1) {
      // Along x: cells (gx+step, gy, gz); along y: (gx, gy+step, gz); along z.
      this.scan(cellKey(gx + step, gy, gz), (b) => {
        if (b.minY + m > y || b.maxY - m < y || b.minZ + m > z || b.maxZ - m < z) return;
        if (b.maxX <= x) out[0] = Math.min(out[0], x - b.maxX);
        else if (b.minX >= x) out[1] = Math.min(out[1], b.minX - x);
      });
      this.scan(cellKey(gx, gy + step, gz), (b) => {
        if (b.minX + m > x || b.maxX - m < x || b.minZ + m > z || b.maxZ - m < z) return;
        if (b.maxY <= y) out[2] = Math.min(out[2], y - b.maxY);
        else if (b.minY >= y) out[3] = Math.min(out[3], b.minY - y);
      });
      this.scan(cellKey(gx, gy, gz + step), (b) => {
        if (b.minX + m > x || b.maxX - m < x || b.minY + m > y || b.maxY - m < y) return;
        if (b.maxZ <= z) out[4] = Math.min(out[4], z - b.maxZ);
        else if (b.minZ >= z) out[5] = Math.min(out[5], b.minZ - z);
      });
    }
  }

  private scan(key: number, visit: (box: GridBox) => void): void {
    const list = this.cells.get(key);
    if (!list) return;
    for (const box of list) {
      if (this.standing(box.slot)) visit(box);
    }
  }
}
