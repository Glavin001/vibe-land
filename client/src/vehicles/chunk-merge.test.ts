import { describe, expect, it } from 'vitest';
import { mergeLightChunks } from './chunk-merge.mjs';

const part = (id: string, x: number, kg: number, motion: unknown = null, functionality: string | null = null) => ({
  id, name: id, position: [x, 0, 0], rotation: [0, 0, 0, 1], motion, functionality, kg,
  shapes: [{ type: 'convex', position: [0, 0, 0], vertices: [[0, 0, 0]] }], visualIds: [id], sourcePartIds: [id],
  volumeM3: kg / 1000, massKg: kg, bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
});

describe('mergeLightChunks', () => {
  it('moves a light part into its best-bonded same-motion neighbour and re-bases its shapes', () => {
    const parts = [part('frame', 0, 50), part('mount', 2, 0.8), part('bolt', 3, 0.1), part('arm', 4, 3, { corner: 'fl', role: 'lowerArm' })];
    const bonds = [
      { a: 'frame', b: 'mount', area: 0.002 }, { a: 'mount', b: 'bolt', area: 0.001 },
      { a: 'bolt', b: 'arm', area: 0.005 }, { a: 'mount', b: 'arm', area: 0.003 },
    ];
    const { merged } = mergeLightChunks(parts, bonds, (p: { kg: number }) => p.kg, 1);
    // The bolt (0.1 kg) cannot join the moving arm; it joins the mount, then
    // the mount (0.9 kg with the bolt) joins the frame.
    expect(merged.map(m => [m.part, m.into])).toEqual([['bolt', 'mount'], ['mount', 'frame']]);
    expect(parts.map(p => p.id)).toEqual(['frame', 'arm']);
    const frame = parts[0];
    expect(frame.visualIds).toEqual(['frame', 'mount', 'bolt']);
    expect(frame.shapes.map(s => s.position[0])).toEqual([0, 2, 3]);
    // Bonds now run frame - arm only (twice: the mount's and the bolt's).
    expect(bonds.every(b => [b.a, b.b].sort().join() === 'arm,frame')).toBe(true);
  });

  it('leaves a light part alone when nothing moves with it', () => {
    const parts = [part('arm', 0, 3, { corner: 'fl', role: 'lowerArm' }), part('eye', 1, 0.5, { corner: 'fl', role: 'damper' })];
    const bonds = [{ a: 'arm', b: 'eye', area: 0.01 }];
    const r = mergeLightChunks(parts, bonds, (p: { kg: number }) => p.kg, 1);
    expect(r.merged).toEqual([]);
    expect(r.unmerged.map(u => u.part)).toEqual(['eye']);
  });
});
