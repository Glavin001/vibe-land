import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { MATTER_PRESETS } from '../graphics/matter/appearanceMatter';
import { AXIS_CODE, bakeMatterFrames, grainAxisCode } from './cityMatterFrames';

function cell(anchorsPerVertex: number[][]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('cityAnchor', new THREE.BufferAttribute(new Float32Array(anchorsPerVertex.flatMap((a) => [...a, 0])), 4));
  // Every face points +x (a fridge side).
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(anchorsPerVertex.flatMap(() => [1, 0, 0])), 3));
  return g;
}

describe('city Matter frames', () => {
  it('runs the grain along the longest rest axis, or the authored one', () => {
    expect(grainAxisCode('long', 2, 0.05, 0.6)).toBe(AXIS_CODE.x);   // a counter top: along its length
    expect(grainAxisCode('long', 0.6, 1.8, 0.04)).toBe(AXIS_CODE.y); // a fridge side: vertical
    expect(grainAxisCode('long', 0.1, 0.1, 3)).toBe(AXIS_CODE.z);    // a joist
    expect(grainAxisCode('long', 1, 1, 1)).toBe(AXIS_CODE.y);        // ties stand up
    expect(grainAxisCode('x', 0.1, 5, 0.1)).toBe(AXIS_CODE.x);
  });

  it('takes continuous materials relative to a whole-metre building origin, so FP32 keeps fine detail', () => {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    // Two chunks of one building 500 m from the world origin.
    const anchors = new Float32Array([500.4, 2.2, -300.6, 0, 501.4, 2.2, -300.6, 0]);
    const g = cell([[500.0, 2.0, -301.0], [502.0, 2.5, -300.0]]);
    bakeMatterFrames(g, { name: 'marble-countertop', recipe: MATTER_PRESETS['marble-countertop'], axis: 'long' }, [
      { slot: 0, firstVertex: 0, vertexCount: 1, geometry: unit },
      { slot: 1, firstVertex: 1, vertexCount: 1, geometry: unit },
    ], { anchors, scales: new Float32Array([2, 0.05, 0.6, 2, 0.05, 0.6]), buildingOfSlot: new Int32Array([0, 0]) });
    const f = g.getAttribute('matterFrame');
    // Origin (500, 2, -301): small, continuous across the two chunks.
    expect([f.getX(0), f.getY(0), f.getZ(0)].map((v) => +v.toFixed(4))).toEqual([0, 0, 0]);
    expect([f.getX(1), f.getY(1), f.getZ(1)].map((v) => +v.toFixed(4))).toEqual([2, 0.5, 1]);
    expect(f.getW(0)).toBe(AXIS_CODE.x);
    expect(g.getAttribute('tangent')).toBeUndefined();
  });

  it('cuts each wooden board from its own log, and gives steel a tangent to pose', () => {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const anchors = new Float32Array([10, 1, 10, 0, 11, 1, 10, 0]);
    const g = cell([[10, 1, 10], [11, 1, 10]]);
    const slots = [
      { slot: 0, firstVertex: 0, vertexCount: 1, geometry: unit },
      { slot: 1, firstVertex: 1, vertexCount: 1, geometry: unit },
    ];
    const source = { anchors, scales: new Float32Array([0.1, 0.1, 2, 0.1, 0.1, 2]), buildingOfSlot: new Int32Array([0, 0]) };
    bakeMatterFrames(g, { name: 'oak', recipe: MATTER_PRESETS.oak, axis: 'long' }, slots, source);
    const f = g.getAttribute('matterFrame');
    const across = (i: number) => Math.hypot(f.getX(i), f.getY(i));
    for (const i of [0, 1]) {
      // The board's centre sits 12-27 cm off its log's axis (z, the long axis).
      expect(across(i)).toBeGreaterThanOrEqual(0.12 - 1e-6);
      expect(across(i)).toBeLessThanOrEqual(0.27 + 1e-6);
      expect(f.getW(i)).toBe(AXIS_CODE.z);
    }
    expect([f.getX(0), f.getY(0)]).not.toEqual([f.getX(1), f.getY(1)]);

    const s = cell([[10, 1, 10]]);
    bakeMatterFrames(s, { name: 'brushed-steel', recipe: MATTER_PRESETS['brushed-steel'], axis: 'long' }, [slots[0]], source);
    // Across the brushing: the grain runs along z (the long axis), the face
    // looks along x, so the tangent is vertical.
    const t = s.getAttribute('tangent');
    expect(t.itemSize).toBe(4);
    expect([t.getX(0), t.getY(0), t.getZ(0)].map((v) => Math.abs(+v.toFixed(5)))).toEqual([0, 1, 0]);
  });
});
