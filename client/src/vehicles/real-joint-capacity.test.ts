import { describe, expect, it } from 'vitest';
import { applySectionBound, memberSection } from './real-joint-capacity.mjs';
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
});
