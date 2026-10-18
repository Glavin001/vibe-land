// Where the standing city is, as a voxel volume around the camera, so the
// parcel raymarch can refuse to put dust inside a wall.
//
// Parcels are shapes; they do not know about walls. Their room is clamped
// at birth (dustClearance.ts), but a room is an axis-aligned box and a city
// is not: a puff at a corner, or one that drifted along a wall to a doorway,
// still has part of its box inside masonry. The raymarch samples this
// volume per step and drops the density where the voxel is solid -- Ember's
// "density inside solid voxels is suppressed" -- so from any angle the dust
// stops at the surface.
//
// Half-metre cells over 96 × 32 × 96 m around the camera: 2.4 MB, R8. The
// CPU refills it from the clearance grid's boxes when the camera has moved
// a third of the extent or the standing set changed, at most twice a
// second, and re-uploads the whole texture: a few milliseconds, rarely.

import * as THREE from 'three';

import type { DustClearance } from './dustClearance';

export const OCC_CELL_M = 0.5;
export const OCC_SIZE_X = 192;
export const OCC_SIZE_Y = 96;
export const OCC_SIZE_Z = 192;
/** Rebuild when the camera is this far from the volume's centre. */
const RECENTRE_M = 24;
const MIN_REBUILD_MS = 500;

export class DustOccupancy {
  readonly texture: THREE.Data3DTexture;
  /** World position of the volume's min corner. */
  readonly origin = new THREE.Vector3();
  readonly size = new THREE.Vector3(OCC_SIZE_X * OCC_CELL_M, OCC_SIZE_Y * OCC_CELL_M, OCC_SIZE_Z * OCC_CELL_M);
  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly centre = new THREE.Vector3(Infinity, Infinity, Infinity);
  private lastBuildMs = -Infinity;
  private lastStandingVersion = -1;
  /** Telemetry: rebuilds and the last one's cost. */
  builds = 0;
  lastBuildCostMs = 0;

  constructor(private readonly clearance: DustClearance) {
    this.data = new Uint8Array(new ArrayBuffer(OCC_SIZE_X * OCC_SIZE_Y * OCC_SIZE_Z));
    const texture = new THREE.Data3DTexture(this.data, OCC_SIZE_X, OCC_SIZE_Y, OCC_SIZE_Z);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  /**
   * Refill if the camera has moved far enough or the standing set changed
   * (`standingVersion` is anything that bumps when bonds break; the broken
   * bond count serves). Returns true when it rebuilt.
   */
  update(camera: THREE.Vector3, standingVersion: number, nowMs: number): boolean {
    const moved = camera.distanceTo(this.centre) > RECENTRE_M;
    const changed = standingVersion !== this.lastStandingVersion;
    if (!moved && !changed) return false;
    if (nowMs - this.lastBuildMs < MIN_REBUILD_MS && !moved) return false;
    const started = performance.now();
    this.lastBuildMs = nowMs;
    this.lastStandingVersion = standingVersion;
    // Snap the origin to whole cells so a rebuild never shifts existing walls by a fraction.
    this.centre.copy(camera);
    this.origin.set(
      Math.floor((camera.x - this.size.x / 2) / OCC_CELL_M) * OCC_CELL_M,
      Math.max(-OCC_CELL_M, Math.floor((camera.y - this.size.y / 3) / OCC_CELL_M) * OCC_CELL_M),
      Math.floor((camera.z - this.size.z / 2) / OCC_CELL_M) * OCC_CELL_M,
    );
    const data = this.data;
    data.fill(0);
    const o = this.origin;
    const maxX = o.x + this.size.x;
    const maxY = o.y + this.size.y;
    const maxZ = o.z + this.size.z;
    // The ground. Texel index is (z * H + y) * W + x.
    if (o.y <= 0) {
      const rows = Math.min(OCC_SIZE_Y, Math.ceil((0 - o.y) / OCC_CELL_M) + 1);
      for (let z = 0; z < OCC_SIZE_Z; z += 1) {
        const base = z * OCC_SIZE_Y * OCC_SIZE_X;
        data.fill(255, base, base + rows * OCC_SIZE_X);
      }
    }
    this.clearance.forEachBoxIn(o.x, o.y, o.z, maxX, maxY, maxZ, (box) => {
      if (!this.clearance.standing(box.slot)) return;
      if (box.maxX <= o.x || box.minX >= maxX || box.maxY <= o.y || box.minY >= maxY || box.maxZ <= o.z || box.minZ >= maxZ) return;
      const x0 = Math.max(0, Math.floor((box.minX - o.x) / OCC_CELL_M));
      const x1 = Math.min(OCC_SIZE_X - 1, Math.floor((box.maxX - o.x) / OCC_CELL_M));
      const y0 = Math.max(0, Math.floor((box.minY - o.y) / OCC_CELL_M));
      const y1 = Math.min(OCC_SIZE_Y - 1, Math.floor((box.maxY - o.y) / OCC_CELL_M));
      const z0 = Math.max(0, Math.floor((box.minZ - o.z) / OCC_CELL_M));
      const z1 = Math.min(OCC_SIZE_Z - 1, Math.floor((box.maxZ - o.z) / OCC_CELL_M));
      for (let z = z0; z <= z1; z += 1) {
        const sliceZ = z * OCC_SIZE_Y * OCC_SIZE_X;
        for (let y = y0; y <= y1; y += 1) {
          const row = sliceZ + y * OCC_SIZE_X;
          data.fill(255, row + x0, row + x1 + 1);
        }
      }
    });
    this.texture.needsUpdate = true;
    this.builds += 1;
    this.lastBuildCostMs = performance.now() - started;
    return true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
