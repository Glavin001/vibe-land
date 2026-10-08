import { describe, expect, it } from 'vitest';
import { applyDuctility, applySectionBound, memberSection, YIELD_RATIO } from './real-joint-capacity.mjs';
import { jointMaterials } from './strength-profile.mjs';

const box = (x: number, y: number, z: number) => ({ position: [0, 0, 0], vertices: [[0, 0, 0], [x, y, z]] });
const steel = jointMaterials.steel;

describe('real joint capacities (section bound)', () => {
  it('a panel lying on a tube holds no more than the tube can', () => {
    // A 2 mm x 1.2 m x 1.6 m steel roof panel (30 kg) on a 1.75 x 0.120 in
    // chromoly cage tube (397 mm2 annulus, 1.2 m long: 3.7 kg): touching over
    // 0.2 m2, the joint's capacity is 300 MPa over the tube's section, not the face.
    const panel = { id: 'p', material: 'frame', mass: 7850 * 0.002 * 1.2 * 1.6, position: [0, 0, 0], shapes: [box(1.6, 0.002, 1.2)] };
    const tube = { id: 't', material: 'frame', mass: 7850 * 397e-6 * 1.2, position: [0, 0, 0], shapes: [box(1.2, 0.0445, 0.0445)] };
    expect(memberSection(tube)).toBeCloseTo(397e-6, 8);
    expect(memberSection(panel)).toBeCloseTo(0.002 * 1.2, 8);
    const bond = { a: 'p', b: 't', area: 0.2, strength: { ...steel } };
    applySectionBound([panel, tube], [bond]);
    expect(bond.strength.tensionFatal * bond.area).toBeCloseTo(steel.tensionFatal * 397e-6, 0);
    expect(bond.strength.tensionFatal * bond.area / 1e3).toBeLessThan(150);
    expect(bond.strength.elasticModulus).toBe(steel.elasticModulus);
  });
  it('a joint smaller than its members keeps its measured capacity, and the wheel studs keep theirs', () => {
    const a = { id: 'a', material: 'frame', mass: 7850 * 0.01 * 1, position: [0, 0, 0], shapes: [box(1, 0.1, 0.1)] };
    const b = { id: 'b', material: 'frame', mass: 7850 * 0.01 * 1, position: [0, 0, 0], shapes: [box(1, 0.1, 0.1)] };
    const small = { a: 'a', b: 'b', area: 0.001, strength: { ...steel } };
    const wheel = { a: 'a', b: 'b', area: 0.5, attachment: 'wheel-mount', strength: { ...jointMaterials.stud } };
    expect(applySectionBound([a, b], [small, wheel])).toHaveLength(0);
    expect(small.strength).toEqual(steel);
    expect(wheel.strength).toEqual(jointMaterials.stud);
  });
  it('metal joints are ductile: elastic to their capacity, slipping A x 5.65 sqrt(S) before they break', () => {
    // EN 1993-1-1 3.2.2: steel elongates >= 15% on the proportional gauge
    // 5.65 sqrt(S0) (EN ISO 6892-1); the bounded joint necks in the tube's 397 mm2.
    const panel = { id: 'p', material: 'frame', mass: 7850 * 0.002 * 1.2 * 1.6, position: [0, 0, 0], shapes: [box(1.6, 0.002, 1.2)] };
    const tube = { id: 't', material: 'frame', mass: 7850 * 397e-6 * 1.2, position: [0, 0, 0], shapes: [box(1.2, 0.0445, 0.0445)] };
    const glass = { id: 'g', material: 'glass', mass: 10, position: [0, 0, 0], shapes: [box(1, 0.005, 1)] };
    const welded = { a: 'p', b: 't', area: 0.2, strength: { ...steel } };
    const glazed = { a: 'g', b: 't', area: 0.01, strength: { ...jointMaterials.glazing } };
    const wheel = { a: 'p', b: 't', area: 38e-4, attachment: 'wheel-mount', strength: { ...jointMaterials.stud } };
    applySectionBound([panel, tube, glass], [welded, glazed, wheel]);
    expect(applyDuctility([panel, tube, glass], [welded, glazed, wheel])).toEqual([welded, wheel]);
    expect(welded.strength.ductileSlip).toBeCloseTo(0.15 * 5.65 * Math.sqrt(397e-6), 6); // 16.9 mm
    expect(welded.strength.tensionElastic).toBe(welded.strength.tensionFatal);
    expect(welded.strength.shearElastic).toBe(welded.strength.shearFatal);
    // Ten M22 10.9 studs (38 cm2): one stud's 3.8 cm2 at ISO 898-1's 9%: ~9.9 mm.
    expect(wheel.strength.ductileSlip).toBeCloseTo(0.09 * 5.65 * Math.sqrt(3.8e-4), 6);
    expect(wheel.strength.tensionFatal).toBe(jointMaterials.stud.tensionFatal);
    // Glass is brittle: no slip, its yield band kept.
    expect(glazed.strength.ductileSlip).toBeUndefined();
    expect(glazed.strength.tensionElastic).toBeLessThan(glazed.strength.tensionFatal);
  });
  it('with the stage static ductility, metal joints yield at f_y / f_u of their capacity (S355, 10.9, 6061-T6)', () => {
    const before = process.env.PX_DESTRUCTION_STATIC_DUCTILE;
    process.env.PX_DESTRUCTION_STATIC_DUCTILE = '1';
    try {
      const a = { id: 'a', material: 'frame', mass: 7850 * 0.01, position: [0, 0, 0], shapes: [box(1, 0.1, 0.1)] };
      const b = { id: 'b', material: 'frame', mass: 7850 * 0.01, position: [0, 0, 0], shapes: [box(1, 0.1, 0.1)] };
      const weld = { a: 'a', b: 'b', area: 0.001, strength: { ...steel } };
      const wheel = { a: 'a', b: 'b', area: 38e-4, attachment: 'wheel-mount', strength: { ...jointMaterials.stud } };
      applyDuctility([a, b], [weld, wheel]);
      expect(YIELD_RATIO.steel).toBeCloseTo(355 / 490, 6);
      expect(weld.strength.tensionElastic / weld.strength.tensionFatal).toBeCloseTo(355 / 490, 6);
      expect(weld.strength.shearElastic / weld.strength.shearFatal).toBeCloseTo(355 / 490, 6);
      expect(wheel.strength.tensionElastic / wheel.strength.tensionFatal).toBeCloseTo(940 / 1040, 6);
      expect(weld.strength.ductileSlip).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.PX_DESTRUCTION_STATIC_DUCTILE; else process.env.PX_DESTRUCTION_STATIC_DUCTILE = before;
    }
  });
});
