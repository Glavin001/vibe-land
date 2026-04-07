import * as RAPIER from '@dimforge/rapier3d-compat';

import {
  BLOCK_ADD,
  BLOCK_REMOVE,
  type BlockCell,
  type BlockEditCmd,
  type ChunkDiffPacket,
  type ChunkFullPacket,
} from '../net/protocol';

export const CHUNK_SIZE = 16;

export type ChunkKey = [number, number, number];

export type RenderBlock = {
  key: string;
  position: [number, number, number];
  material: number;
  color: number;
};

type ChunkState = {
  key: ChunkKey;
  version: number;
  blocks: Map<number, number>;
  colliders: RAPIER.ColliderHandle[];
};

export class ClientVoxelWorld {
  private readonly chunks = new Map<string, ChunkState>();

  constructor(private readonly world: RAPIER.World) {}

  getChunkVersion(chunk: ChunkKey): number {
    return this.chunks.get(keyToString(chunk))?.version ?? 0;
  }

  hasChunks(): boolean {
    return this.chunks.size > 0;
  }

  getRenderBlocks(): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    for (const chunk of this.chunks.values()) {
      const chunkId = keyToString(chunk.key);
      for (const [idx, material] of chunk.blocks) {
        if (material === 0) continue;
        const [lx, ly, lz] = unpackLocalIndex(idx);
        const center = chunkLocalToWorldCenter(chunk.key, [lx, ly, lz]);
        blocks.push({
          key: `${chunkId}:${idx}`,
          position: [center.x, center.y, center.z],
          material,
          color: materialToColor(material),
        });
      }
    }
    return blocks;
  }

  applyFullChunk(packet: ChunkFullPacket): void {
    const key = packet.chunk;
    const chunk: ChunkState = {
      key,
      version: packet.version,
      blocks: new Map<number, number>(),
      colliders: [],
    };

    for (const block of packet.blocks) {
      chunk.blocks.set(packLocalIndex(block.x, block.y, block.z), block.material);
    }

    this.setChunk(chunk);
  }

  applyChunkDiff(packet: ChunkDiffPacket): void {
    const id = keyToString(packet.chunk);
    const chunk = this.chunks.get(id) ?? {
      key: packet.chunk,
      version: 0,
      blocks: new Map<number, number>(),
      colliders: [],
    };

    // If the diff skipped versions, the caller should request a fresh full chunk.
    if (packet.version !== chunk.version + 1 && chunk.version !== 0) {
      throw new Error(`Chunk ${id} version mismatch on client: have ${chunk.version}, got ${packet.version}`);
    }

    for (const edit of packet.edits) {
      const idx = packLocalIndex(edit.x, edit.y, edit.z);
      if (edit.op === BLOCK_REMOVE) {
        chunk.blocks.delete(idx);
      } else if (edit.op === BLOCK_ADD) {
        chunk.blocks.set(idx, edit.material);
      }
    }

    chunk.version = packet.version;
    this.setChunk(chunk);
  }

  buildEditRequest(worldX: number, worldY: number, worldZ: number, op: number, material: number): BlockEditCmd {
    const { chunk, local } = worldToChunkAndLocal(worldX, worldY, worldZ);
    return {
      chunk,
      local,
      op,
      material,
      expectedVersion: this.getChunkVersion(chunk),
    };
  }

  getMaterial(worldX: number, worldY: number, worldZ: number): number {
    const { chunk, local } = worldToChunkAndLocal(worldX, worldY, worldZ);
    const state = this.chunks.get(keyToString(chunk));
    if (!state) return 0;
    return state.blocks.get(packLocalIndex(local[0], local[1], local[2])) ?? 0;
  }

  private setChunk(chunk: ChunkState): void {
    const id = keyToString(chunk.key);
    const existing = this.chunks.get(id);
    if (existing) {
      for (const handle of existing.colliders) {
        try {
          this.world.removeCollider(this.world.getCollider(handle), true);
        } catch {
          // noop
        }
      }
    }

    chunk.colliders = [];
    for (const [idx, material] of chunk.blocks) {
      if (material === 0) continue;
      const [lx, ly, lz] = unpackLocalIndex(idx);
      const center = chunkLocalToWorldCenter(chunk.key, [lx, ly, lz]);
      const collider = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setTranslation(center.x, center.y, center.z);
      const handle = this.world.createCollider(collider).handle;
      chunk.colliders.push(handle);
    }

    this.chunks.set(id, chunk);
    // Refresh Rapier's broad-phase/query state after collider rebuilds so KCC sees new chunks immediately.
    this.world.step();
  }
}

export function worldToChunkAndLocal(worldX: number, worldY: number, worldZ: number): { chunk: ChunkKey; local: [number, number, number] } {
  const fx = Math.floor(worldX);
  const fy = Math.floor(worldY);
  const fz = Math.floor(worldZ);
  const chunk: ChunkKey = [divFloor(fx, CHUNK_SIZE), divFloor(fy, CHUNK_SIZE), divFloor(fz, CHUNK_SIZE)];
  const local: [number, number, number] = [modFloor(fx, CHUNK_SIZE), modFloor(fy, CHUNK_SIZE), modFloor(fz, CHUNK_SIZE)];
  return { chunk, local };
}

export function chunkLocalToWorldCenter(chunk: ChunkKey, local: [number, number, number]) {
  return {
    x: chunk[0] * CHUNK_SIZE + local[0] + 0.5,
    y: chunk[1] * CHUNK_SIZE + local[1] + 0.5,
    z: chunk[2] * CHUNK_SIZE + local[2] + 0.5,
  };
}

function keyToString(key: ChunkKey): string {
  return `${key[0]},${key[1]},${key[2]}`;
}

function packLocalIndex(x: number, y: number, z: number): number {
  return ((x & 0x0f) << 8) | ((y & 0x0f) << 4) | (z & 0x0f);
}

function unpackLocalIndex(index: number): [number, number, number] {
  return [
    (index >> 8) & 0x0f,
    (index >> 4) & 0x0f,
    index & 0x0f,
  ];
}

function divFloor(a: number, b: number): number {
  return Math.floor(a / b);
}

function modFloor(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r;
}

function materialToColor(material: number): number {
  switch (material) {
    case 1:
      return 0x556655;
    case 2:
      return 0x887766;
    default:
      return 0x888888;
  }
}
