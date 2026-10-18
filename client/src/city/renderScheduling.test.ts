// Update-rate scheduling for distant chunks.

import { describe, expect, it } from 'vitest';

import {
  RENDER_CELL_SIZE_M,
  partitionSlotsByCell,
  renderCellOfPosition,
  shouldUpdateThisFrame,
  updateStrideForDistanceSq,
} from './renderScheduling';

describe('updateStrideForDistanceSq', () => {
  it('never defers nearby bodies', () => {
    expect(updateStrideForDistanceSq(0)).toBe(1);
    expect(updateStrideForDistanceSq(39 * 39)).toBe(1);
  });

  it('defers further with distance', () => {
    expect(updateStrideForDistanceSq(50 * 50)).toBe(2);
    expect(updateStrideForDistanceSq(120 * 120)).toBe(4);
    expect(updateStrideForDistanceSq(500 * 500)).toBe(8);
  });

  it('is monotonic, so moving away never means updating more often', () => {
    let previous = 0;
    for (let d = 0; d < 400; d += 5) {
      const stride = updateStrideForDistanceSq(d * d);
      expect(stride).toBeGreaterThanOrEqual(previous);
      previous = stride;
    }
  });

  // NaN fails every `<` comparison, so a naive chain would fall through to the
  // largest stride and defer the chunks nearest the camera -- the exact
  // opposite of the intent.
  it('does not defer on a degenerate distance', () => {
    expect(updateStrideForDistanceSq(Number.NaN)).toBe(1);
    expect(updateStrideForDistanceSq(-1)).toBe(1);
  });
});

describe('shouldUpdateThisFrame', () => {
  it('always updates at stride 1', () => {
    for (let frame = 0; frame < 10; frame++) {
      expect(shouldUpdateThisFrame(frame, 12345, 1)).toBe(true);
    }
  });

  it('updates each body once per stride window', () => {
    for (const key of [0, 7, 2_147_483_649]) {
      const hits = [0, 1, 2, 3].filter((frame) => shouldUpdateThisFrame(frame, key, 4));
      expect(hits).toHaveLength(1);
    }
  });

  // If every deferred body updated on the same frame, the cost would spike
  // periodically rather than flatten -- worse for pacing than not deferring.
  it('spreads bodies across the stride window', () => {
    const frameOfKey = new Set<number>();
    for (let key = 0; key < 64; key++) {
      for (let frame = 0; frame < 8; frame++) {
        if (shouldUpdateThisFrame(frame, key, 8)) {
          frameOfKey.add(frame);
          break;
        }
      }
    }
    expect(frameOfKey.size).toBe(8);
  });
});

describe('renderCellOfPosition', () => {
  it('keeps a cell-sized neighbourhood together', () => {
    const cell = renderCellOfPosition(0, 0);
    expect(renderCellOfPosition(1, 1)).toBe(cell);
    expect(renderCellOfPosition(RENDER_CELL_SIZE_M - 0.01, RENDER_CELL_SIZE_M - 0.01)).toBe(cell);
  });

  it('separates neighbouring cells on both axes', () => {
    const origin = renderCellOfPosition(0, 0);
    expect(renderCellOfPosition(RENDER_CELL_SIZE_M + 1, 0)).not.toBe(origin);
    expect(renderCellOfPosition(0, RENDER_CELL_SIZE_M + 1)).not.toBe(origin);
  });

  // The city straddles the origin, so a hash that folded signed coordinates
  // carelessly would alias a block at -x onto the block at +x and merge two
  // distant batches into one.
  it('does not collide across the origin', () => {
    const seen = new Map<number, string>();
    for (let x = -6; x <= 6; x++) {
      for (let z = -6; z <= 6; z++) {
        const at = `${x},${z}`;
        const cell = renderCellOfPosition(x * RENDER_CELL_SIZE_M, z * RENDER_CELL_SIZE_M);
        expect(seen.has(cell), `${at} collided with ${seen.get(cell)}`).toBe(false);
        seen.set(cell, at);
      }
    }
  });

  it('is stable across calls, so batch order is reproducible between runs', () => {
    expect(renderCellOfPosition(-137.5, 92.25)).toBe(renderCellOfPosition(-137.5, 92.25));
  });

  it('survives a non-finite coordinate rather than producing NaN cells', () => {
    expect(Number.isFinite(renderCellOfPosition(Number.NaN, 0))).toBe(true);
  });
});

describe('partitionSlotsByCell', () => {
  /** A district-sized spread of slots: 289 m x 273 m, like the fractured pack. */
  const district = (): { worldXZ: Float32Array; slots: number[] } => {
    const slots: number[] = [];
    const positions: Array<[number, number]> = [];
    for (let x = -155; x <= 134; x += 8) {
      for (let z = -119; z <= 154; z += 8) {
        positions.push([x, z]);
      }
    }
    const worldXZ = new Float32Array(positions.length * 2);
    positions.forEach(([x, z], slot) => {
      worldXZ[slot * 2] = x;
      worldXZ[slot * 2 + 1] = z;
      slots.push(slot);
    });
    return { worldXZ, slots };
  };

  it('splits a district into many cells instead of one batch', () => {
    const { worldXZ, slots } = district();
    const cells = partitionSlotsByCell(worldXZ, slots);
    // 289/48 x 273/48 ~ 7x6. The exact count depends on where the grid falls;
    // what matters is that it is emphatically not 1.
    expect(cells.size).toBeGreaterThan(20);
  });

  it('places every slot in exactly one cell', () => {
    const { worldXZ, slots } = district();
    const cells = partitionSlotsByCell(worldXZ, slots);
    const placed = [...cells.values()].flat();
    expect(placed).toHaveLength(slots.length);
    expect(new Set(placed).size).toBe(slots.length);
  });

  it('returns cells in a deterministic order', () => {
    const { worldXZ, slots } = district();
    const first = [...partitionSlotsByCell(worldXZ, slots).keys()];
    const second = [...partitionSlotsByCell(worldXZ, slots).keys()];
    expect(first).toEqual(second);
    expect([...first].sort((a, b) => a - b)).toEqual(first);
  });

  // The regression this whole change exists for: with one batch every body
  // shared a stagger phase, so the map froze and jumped in lockstep. Keyed on
  // the batch index instead, deferred work spreads across the stride window.
  it('yields batch keys that spread across the stride window', () => {
    const { worldXZ, slots } = district();
    const batches = [...partitionSlotsByCell(worldXZ, slots).keys()].length;
    const frames = new Set<number>();
    for (let batch = 0; batch < batches; batch++) {
      for (let frame = 0; frame < 8; frame++) {
        if (shouldUpdateThisFrame(frame, batch, 8)) {
          frames.add(frame);
          break;
        }
      }
    }
    expect(frames.size).toBe(8);
  });

  // The 12 m high-rise pack is far smaller than a cell, so it must stay one
  // batch however it sits relative to the grid -- including straddling a
  // boundary, which is where a world-anchored grid would have split it in four.
  it('leaves a building smaller than a cell as one batch, wherever it sits', () => {
    for (const [ox, oz] of [
      [0, 0],
      [-6, -6],
      [RENDER_CELL_SIZE_M, RENDER_CELL_SIZE_M],
      [-137.5, 92.25],
    ]) {
      const xz = new Float32Array([ox, oz, ox + 6, oz + 6, ox + 12, oz + 3, ox + 3, oz + 12]);
      expect(partitionSlotsByCell(xz, [0, 1, 2, 3]).size).toBe(1);
    }
  });
});
