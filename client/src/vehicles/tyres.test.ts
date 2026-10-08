import { describe, expect, it } from 'vitest';
import { applyTyreBound, rimShape, TYRES, tyreOf } from './tyres.mjs';

// A road wheel's hull: a 32-gon cylinder along the axle (x), outside radius R, tread width b.
const wheel = (name: string, x: number, R: number, b: number) => {
  const vertices: number[][] = [];
  for (const side of [-b / 2, b / 2]) for (let i = 0; i < 32; i += 1) {
    const a = (i * 2 * Math.PI) / 32;
    vertices.push([side, R * Math.cos(a), R * Math.sin(a)]);
  }
  return { name, position: [x, 0.75, 1.6], shapes: [{ position: [0, 0, 0], vertices }] };
};

describe('tyres in series with the suspension', () => {
  it("bounds a monster truck's tyre at its full-deflection pressure force, p b 2 sqrt(2 R sec)", () => {
    // OD 1.50 m, tread 0.553 m, 1.6 bar, rim 25/66 of the OD: ~148 kN.
    const spec = TYRES.monster;
    const t = tyreOf(wheel('Front left wheel assembly', 1, 0.75, 0.553), spec);
    expect(t.radiusM).toBeCloseTo(0.75, 2);
    expect(t.widthM).toBeCloseTo(0.553, 6);
    expect(t.sectionM).toBeCloseTo(0.75 * (1 - 25 / 66), 2);
    expect(t.maxForceN).toBeCloseTo(1.6e5 * 0.553 * 2 * Math.sqrt(2 * t.radiusM * t.sectionM), 0);
    expect(t.maxForceN / 1e3).toBeGreaterThan(140);
    expect(t.maxForceN / 1e3).toBeLessThan(155);
  });
  it('puts a rim hull inside each road wheel and reports the least bound; other builds get none', () => {
    const parts = [
      wheel('Front left wheel assembly', 1, 0.75, 0.553), wheel('Front right wheel assembly', -1, 0.75, 0.553),
      wheel('Rear left wheel assembly', 1, 0.75, 0.553), wheel('Rear right wheel assembly', -1, 0.74, 0.553),
      { name: 'Chassis', position: [0, 1, 0], shapes: [{ position: [0, 0, 0], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] }] },
    ];
    expect(applyTyreBound('buggy', parts)).toBeNull();
    const tyre = applyTyreBound('monster', parts);
    expect(tyre).not.toBeNull();
    for (const p of parts.slice(0, 4)) {
      expect(p.shapes).toHaveLength(2);
      const rim = p.shapes[1] as ReturnType<typeof rimShape>;
      expect(rim.rim).toBe(true);
      const r = Math.max(...rim.vertices.map((v) => Math.hypot(v[1], v[2])));
      expect(r).toBeLessThan(0.75 * 0.4);
    }
    expect(parts[4].shapes).toHaveLength(1);
    // The smaller rear-right wheel sets the vehicle's bound.
    expect(tyre!.radiusM).toBeCloseTo(0.74, 2);
  });
});
