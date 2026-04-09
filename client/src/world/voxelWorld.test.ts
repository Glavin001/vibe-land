import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import {
  ClientVoxelWorld,
  worldToChunkAndLocal,
  chunkLocalToWorldCenter,
  CHUNK_SIZE,
} from './voxelWorld';
import type { ChunkFullPacket, ChunkDiffPacket, BlockCell } from '../net/protocol';

beforeAll(() => {
  initWasmForTests();
});

describe('worldToChunkAndLocal', () => {
  it('maps origin to chunk (0,0,0) local (0,0,0)', () => {
    const { chunk, local } = worldToChunkAndLocal(0, 0, 0);
    expect(chunk).toEqual([0, 0, 0]);
    expect(local).toEqual([0, 0, 0]);
  });

  it('maps positive coordinates within first chunk', () => {
    const { chunk, local } = worldToChunkAndLocal(5, 3, 10);
    expect(chunk).toEqual([0, 0, 0]);
    expect(local).toEqual([5, 3, 10]);
  });

  it('maps coordinates at chunk boundary', () => {
    const { chunk, local } = worldToChunkAndLocal(16, 0, 0);
    expect(chunk).toEqual([1, 0, 0]);
    expect(local).toEqual([0, 0, 0]);
  });

  it('maps negative coordinates correctly', () => {
    const { chunk, local } = worldToChunkAndLocal(-1, 0, 0);
    expect(chunk).toEqual([-1, 0, 0]);
    expect(local).toEqual([15, 0, 0]);
  });

  it('maps -16 to chunk (-1,0,0) local (0,0,0)', () => {
    const { chunk, local } = worldToChunkAndLocal(-16, 0, 0);
    expect(chunk).toEqual([-1, 0, 0]);
    expect(local[0] + 0).toBe(0);
    expect(local[1] + 0).toBe(0);
    expect(local[2] + 0).toBe(0);
  });

  it('maps -17 to chunk (-2,0,0) local (15,0,0)', () => {
    const { chunk, local } = worldToChunkAndLocal(-17, 0, 0);
    expect(chunk).toEqual([-2, 0, 0]);
    expect(local).toEqual([15, 0, 0]);
  });

  it('handles all three axes independently', () => {
    const { chunk, local } = worldToChunkAndLocal(20, -5, 33);
    expect(chunk).toEqual([1, -1, 2]);
    expect(local).toEqual([4, 11, 1]);
  });
});

describe('chunkLocalToWorldCenter', () => {
  it('returns center of block at origin chunk', () => {
    const center = chunkLocalToWorldCenter([0, 0, 0], [0, 0, 0]);
    expect(center.x).toBeCloseTo(0.5);
    expect(center.y).toBeCloseTo(0.5);
    expect(center.z).toBeCloseTo(0.5);
  });

  it('returns correct center for offset chunk', () => {
    const center = chunkLocalToWorldCenter([1, 0, 0], [3, 5, 7]);
    expect(center.x).toBeCloseTo(16 + 3 + 0.5);
    expect(center.y).toBeCloseTo(5 + 0.5);
    expect(center.z).toBeCloseTo(7 + 0.5);
  });

  it('returns correct center for negative chunk', () => {
    const center = chunkLocalToWorldCenter([-1, -1, 0], [15, 15, 0]);
    expect(center.x).toBeCloseTo(-16 + 15 + 0.5);
    expect(center.y).toBeCloseTo(-16 + 15 + 0.5);
    expect(center.z).toBeCloseTo(0.5);
  });
});

describe('ClientVoxelWorld', () => {
  let sim: WasmSimWorld;

  beforeEach(() => {
    sim = new WasmSimWorld();
  });

  function makeFullChunk(
    chunk: [number, number, number] = [0, 0, 0],
    version = 1,
    blocks?: BlockCell[],
  ): ChunkFullPacket {
    return {
      type: 'chunkFull',
      chunk,
      version,
      blocks: blocks ?? [
        { x: 0, y: 0, z: 0, material: 1 },
        { x: 1, y: 0, z: 0, material: 2 },
      ],
    };
  }

  describe('applyFullChunk', () => {
    it('loads a chunk and reports hasChunks', () => {
      const vw = new ClientVoxelWorld(sim);
      expect(vw.hasChunks()).toBe(false);

      vw.applyFullChunk(makeFullChunk());
      expect(vw.hasChunks()).toBe(true);
    });

    it('stores correct version', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 5));
      expect(vw.getChunkVersion([0, 0, 0])).toBe(5);
    });

    it('overwrites existing chunk data', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 1 },
      ]));
      expect(vw.getMaterial(0, 0, 0)).toBe(1);

      vw.applyFullChunk(makeFullChunk([0, 0, 0], 2, [
        { x: 0, y: 0, z: 0, material: 3 },
      ]));
      expect(vw.getMaterial(0, 0, 0)).toBe(3);
      expect(vw.getChunkVersion([0, 0, 0])).toBe(2);
    });

    it('skips material 0 blocks', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 0 },
        { x: 1, y: 0, z: 0, material: 1 },
      ]));
      // material 0 should not be stored as a block
      expect(vw.getMaterial(0, 0, 0)).toBe(0);
      expect(vw.getMaterial(1, 0, 0)).toBe(1);
    });
  });

  describe('applyChunkDiff', () => {
    it('adds a block to existing chunk', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 1 },
      ]));

      const diff: ChunkDiffPacket = {
        type: 'chunkDiff',
        chunk: [0, 0, 0],
        version: 2,
        edits: [{ x: 1, y: 0, z: 0, op: 1, material: 2 }],
      };
      vw.applyChunkDiff(diff);

      expect(vw.getMaterial(1, 0, 0)).toBe(2);
      expect(vw.getChunkVersion([0, 0, 0])).toBe(2);
    });

    it('removes a block from existing chunk', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 1 },
        { x: 1, y: 0, z: 0, material: 2 },
      ]));

      const diff: ChunkDiffPacket = {
        type: 'chunkDiff',
        chunk: [0, 0, 0],
        version: 2,
        edits: [{ x: 0, y: 0, z: 0, op: 2, material: 0 }],
      };
      vw.applyChunkDiff(diff);

      expect(vw.getMaterial(0, 0, 0)).toBe(0);
      expect(vw.getMaterial(1, 0, 0)).toBe(2);
    });

    it('throws on version mismatch', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1));

      const diff: ChunkDiffPacket = {
        type: 'chunkDiff',
        chunk: [0, 0, 0],
        version: 5,
        edits: [{ x: 0, y: 0, z: 0, op: 1, material: 1 }],
      };

      expect(() => vw.applyChunkDiff(diff)).toThrow('version mismatch');
    });

    it('applies sequential diffs correctly', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, []));

      vw.applyChunkDiff({
        type: 'chunkDiff',
        chunk: [0, 0, 0],
        version: 2,
        edits: [{ x: 0, y: 0, z: 0, op: 1, material: 1 }],
      });

      vw.applyChunkDiff({
        type: 'chunkDiff',
        chunk: [0, 0, 0],
        version: 3,
        edits: [{ x: 1, y: 0, z: 0, op: 1, material: 2 }],
      });

      expect(vw.getMaterial(0, 0, 0)).toBe(1);
      expect(vw.getMaterial(1, 0, 0)).toBe(2);
      expect(vw.getChunkVersion([0, 0, 0])).toBe(3);
    });
  });

  describe('getMaterial', () => {
    it('returns 0 for empty positions', () => {
      const vw = new ClientVoxelWorld(sim);
      expect(vw.getMaterial(0, 0, 0)).toBe(0);
    });

    it('returns 0 for unloaded chunks', () => {
      const vw = new ClientVoxelWorld(sim);
      expect(vw.getMaterial(100, 100, 100)).toBe(0);
    });

    it('returns correct material for placed blocks', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 5, y: 3, z: 7, material: 42 },
      ]));
      expect(vw.getMaterial(5, 3, 7)).toBe(42);
    });

    it('handles negative world coordinates', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk({
        type: 'chunkFull',
        chunk: [-1, 0, 0],
        version: 1,
        blocks: [{ x: 15, y: 0, z: 0, material: 7 }],
      });
      expect(vw.getMaterial(-1, 0, 0)).toBe(7);
    });
  });

  describe('getRenderBlocks', () => {
    it('returns empty array when no chunks loaded', () => {
      const vw = new ClientVoxelWorld(sim);
      expect(vw.getRenderBlocks()).toEqual([]);
    });

    it('returns all non-zero blocks', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 1 },
        { x: 1, y: 0, z: 0, material: 2 },
      ]));

      const blocks = vw.getRenderBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks.every(b => b.material > 0)).toBe(true);
    });

    it('includes world position as center of block', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([1, 0, 0], 1, [
        { x: 3, y: 5, z: 7, material: 1 },
      ]));

      const blocks = vw.getRenderBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].position[0]).toBeCloseTo(16 + 3 + 0.5);
      expect(blocks[0].position[1]).toBeCloseTo(5 + 0.5);
      expect(blocks[0].position[2]).toBeCloseTo(7 + 0.5);
    });

    it('returns blocks from multiple chunks', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 1 },
      ]));
      vw.applyFullChunk(makeFullChunk([1, 0, 0], 1, [
        { x: 0, y: 0, z: 0, material: 2 },
      ]));

      const blocks = vw.getRenderBlocks();
      expect(blocks).toHaveLength(2);
    });
  });

  describe('buildEditRequest', () => {
    it('maps world coords to chunk + local', () => {
      const vw = new ClientVoxelWorld(sim);
      vw.applyFullChunk(makeFullChunk([0, 0, 0], 3));

      const edit = vw.buildEditRequest(5, 3, 7, 1, 2);
      expect(edit.chunk).toEqual([0, 0, 0]);
      expect(edit.local).toEqual([5, 3, 7]);
      expect(edit.op).toBe(1);
      expect(edit.material).toBe(2);
      expect(edit.expectedVersion).toBe(3);
    });

    it('uses version 0 for unloaded chunks', () => {
      const vw = new ClientVoxelWorld(sim);
      const edit = vw.buildEditRequest(100, 0, 0, 1, 1);
      expect(edit.expectedVersion).toBe(0);
    });
  });
});
