import { describe, expect, it } from 'vitest';
import { admitBonds, trueBondStiffness } from './bond-admission.mjs';

// A chassis, a panel held by a 2 cm^2 bond and a 0.3 cm^2 graze, and a badge
// whose only link is a 0.1 cm^2 graze.
const assembly = () => [
  { a: 'chassis', b: 'panel', area: 2e-4 },
  { a: 'chassis', b: 'panel2', area: 3e-5 },
  { a: 'panel', b: 'panel2', area: 5e-4 },
  { a: 'chassis', b: 'badge', area: 1e-5 },
];

describe('bond admission', () => {
  it('runtime: drops grazes and raises a sole link to the solver minimum', () => {
    const bonds = assembly();
    const { excluded, mounts } = admitBonds(bonds, { trueStiffness: false });
    expect(excluded.map(b => b.b)).toEqual(['panel2']);
    expect(mounts.map(b => b.b)).toEqual(['badge']);
    expect(bonds.find(b => b.b === 'badge')?.area).toBe(1e-4);
    expect(bonds).toHaveLength(3);
  });
  it('true stiffness: every measured contact at its measured area', () => {
    const bonds = assembly();
    const { excluded, mounts } = admitBonds(bonds, { trueStiffness: true });
    expect(excluded).toEqual([]);
    expect(mounts).toEqual([]);
    expect(bonds.map(b => b.area)).toEqual(assembly().map(b => b.area));
  });
  it('reads the bridge flags', () => {
    expect(trueBondStiffness({})).toBe(false);
    expect(trueBondStiffness({ VIBE_BOND_TRUE_STIFFNESS: '0' })).toBe(false);
    expect(trueBondStiffness({ VIBE_BOND_TRUE_STIFFNESS: '1' })).toBe(true);
    expect(trueBondStiffness({ VIBE_SECTION_ROTATION: '1' })).toBe(true);
  });
});
