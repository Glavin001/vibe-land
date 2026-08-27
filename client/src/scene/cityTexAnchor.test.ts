// The rest-space anchor is what makes the city's concrete survive being blown
// apart, and every claim it rests on is arithmetic that can be checked here
// without a GPU.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildBoxGeometry } from '../city/chunkGeometry';
import { attachInstanceAnchors, bakeRestAnchors } from './cityTexAnchor';
import {
  FLOOR_LAYER_COUNT,
  LAYER_CODE_RADIX,
  WALL_LAYER_COUNT,
  layerCodeForBuilding,
} from './cityTextures';

/** anchors/scales for a single slot, so a case reads as one chunk. */
function oneChunk(
  anchor: [number, number, number, number],
  scale: [number, number, number],
): { anchors: Float32Array; scales: Float32Array } {
  return { anchors: Float32Array.from(anchor), scales: Float32Array.from(scale) };
}

describe('bakeRestAnchors', () => {
  it('writes each vertex at its absolute rest-space position', () => {
    const geometry = buildBoxGeometry();
    const { anchors, scales } = oneChunk([10, 20, 30, 7], [2, 4, 6]);
    bakeRestAnchors(geometry, 0, anchors, scales);

    const position = geometry.getAttribute('position');
    const baked = geometry.getAttribute('cityAnchor');
    for (let i = 0; i < position.count; i += 1) {
      expect(baked.getX(i)).toBeCloseTo(10 + 2 * position.getX(i));
      expect(baked.getY(i)).toBeCloseTo(20 + 4 * position.getY(i));
      expect(baked.getZ(i)).toBeCloseTo(30 + 6 * position.getZ(i));
      expect(baked.getW(i)).toBe(7);
    }
  });

  // The load-bearing property behind reusing one prototype per shape across
  // every instance of it: the second bake must leave nothing of the first.
  it('fully overwrites a previous slot on the same prototype', () => {
    const geometry = buildBoxGeometry();
    bakeRestAnchors(geometry, 0, ...Object.values(oneChunk([10, 20, 30, 7], [2, 4, 6])) as [
      Float32Array,
      Float32Array,
    ]);
    const first = Float32Array.from(geometry.getAttribute('cityAnchor').array);

    const second = oneChunk([-5, 0, 1, 3], [1, 1, 1]);
    bakeRestAnchors(geometry, 0, second.anchors, second.scales);
    const after = geometry.getAttribute('cityAnchor').array as Float32Array;

    expect(Array.from(after)).not.toEqual(Array.from(first));
    const fresh = buildBoxGeometry();
    bakeRestAnchors(fresh, 0, second.anchors, second.scales);
    expect(Array.from(after)).toEqual(Array.from(fresh.getAttribute('cityAnchor').array));
  });

  // The whole point of anchoring in rest space rather than object space: two
  // chunks that touch must agree on the texture coordinate at the seam, or an
  // intact wall reads as a mosaic of pre-shattered panels. Two unit cubes side
  // by side share a face at x = 0.5 in rest space, from both sides.
  it('gives touching chunks the same coordinate at their shared face', () => {
    const anchors = Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0]);
    const scales = Float32Array.from([1, 1, 1, 1, 1, 1]);

    const left = buildBoxGeometry();
    bakeRestAnchors(left, 0, anchors, scales);
    const right = buildBoxGeometry();
    bakeRestAnchors(right, 1, anchors, scales);

    const seam = (geometry: THREE.BufferGeometry, sign: number): number[] => {
      const position = geometry.getAttribute('position');
      const baked = geometry.getAttribute('cityAnchor');
      const out: number[] = [];
      for (let i = 0; i < position.count; i += 1) {
        if (Math.sign(position.getX(i)) === sign) {
          out.push(baked.getX(i), baked.getY(i), baked.getZ(i));
        }
      }
      return out.map((value) => Number(value.toFixed(5)));
    };

    const leftFace = seam(left, 1).sort();
    const rightFace = seam(right, -1).sort();
    expect(leftFace.length).toBeGreaterThan(0);
    expect(leftFace).toEqual(rightFace);
  });
});

describe('attachInstanceAnchors', () => {
  it('lays instances out in instance-id order, exactly count long', () => {
    // Slots deliberately out of order: an instance id is a position in this
    // list, not the slot number, and reading the wrong one would anchor a chunk
    // somewhere else in the city.
    const slots = [2, 0];
    const anchors = Float32Array.from([
      0, 0, 0, 0,
      9, 9, 9, 9,
      5, 6, 7, 8,
    ]);
    const scales = Float32Array.from([1, 1, 1, 2, 2, 2, 3, 4, 5]);
    const mesh = new THREE.InstancedMesh(buildBoxGeometry(), new THREE.MeshBasicMaterial(), 2);

    attachInstanceAnchors(mesh, slots, anchors, scales);

    const anchor = mesh.geometry.getAttribute('cityAnchor');
    const restScale = mesh.geometry.getAttribute('cityRestScale');
    expect(anchor.count).toBe(mesh.count);
    expect(restScale.count).toBe(mesh.count);
    expect([anchor.getX(0), anchor.getY(0), anchor.getZ(0), anchor.getW(0)]).toEqual([5, 6, 7, 8]);
    expect([restScale.getX(0), restScale.getY(0), restScale.getZ(0)]).toEqual([3, 4, 5]);
    expect([anchor.getX(1), anchor.getY(1), anchor.getZ(1), anchor.getW(1)]).toEqual([0, 0, 0, 0]);
  });
});

describe('layerCodeForBuilding', () => {
  const decode = (code: number) => ({
    wall: code % LAYER_CODE_RADIX,
    floor: Math.floor(code / LAYER_CODE_RADIX),
  });

  it('always decodes to a wall layer and a floor layer', () => {
    for (let id = 0; id < 200; id += 1) {
      const { wall, floor } = decode(layerCodeForBuilding(id));
      expect(wall).toBeGreaterThanOrEqual(0);
      expect(wall).toBeLessThan(WALL_LAYER_COUNT);
      expect(floor).toBeGreaterThanOrEqual(WALL_LAYER_COUNT);
      expect(floor).toBeLessThan(WALL_LAYER_COUNT + FLOOR_LAYER_COUNT);
    }
  });

  it('is a pure function of the id, so a rebuild picks the same concrete', () => {
    expect(layerCodeForBuilding(41)).toBe(layerCodeForBuilding(41));
  });

  // Building ids are root slot numbers, which are locally consecutive. A weaker
  // hash would walk the layers in lockstep with the street grid and stripe the
  // city.
  it('does not stripe across neighbouring buildings', () => {
    const walls = new Set<number>();
    for (let id = 0; id < 12; id += 1) walls.add(decode(layerCodeForBuilding(id)).wall);
    expect(walls.size).toBeGreaterThan(1);
    const runs = Array.from({ length: 11 }, (_, i) =>
      decode(layerCodeForBuilding(i)).wall === decode(layerCodeForBuilding(i + 1)).wall);
    expect(runs.every(Boolean)).toBe(false);
  });
});
