import type { WasmSimWorld } from '../wasm/sharedPhysics';

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

type PendingEdit = {
  cmd: BlockEditCmd;     // the edit that was applied optimistically
  prevMaterial: number;  // block material BEFORE the edit (needed to revert)
};

type ChunkState = {
  key: ChunkKey;
  version: number;                      // last server-confirmed version
  blocks: Map<number, number>;          // current (server + optimistic) block data
  blockColliders: Map<number, number>;  // blockIndex → colliderId
  pending: PendingEdit[];               // unacknowledged optimistic edits, FIFO
};

export class ClientVoxelWorld {
  private readonly chunks = new Map<string, ChunkState>();

  constructor(
    private readonly sim: WasmSimWorld,
    private readonly syncColliders = true,
  ) {}

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
    const id = keyToString(key);
    const existing = this.chunks.get(id);
    if (existing && this.syncColliders) {
      for (const colId of existing.blockColliders.values()) {
        this.sim.removeCuboid(colId);
      }
    }

    const chunk: ChunkState = {
      key,
      version: packet.version,
      blocks: new Map<number, number>(),
      blockColliders: new Map<number, number>(),
      pending: [], // full resync clears all pending optimistic edits
    };

    for (const block of packet.blocks) {
      if (block.material === 0) continue;
      const idx = packLocalIndex(block.x, block.y, block.z);
      chunk.blocks.set(idx, block.material);
      if (this.syncColliders) {
        const center = chunkLocalToWorldCenter(key, [block.x, block.y, block.z]);
        const colId = this.sim.addCuboid(center.x, center.y, center.z, 0.5, 0.5, 0.5);
        chunk.blockColliders.set(idx, colId);
      }
    }

    this.chunks.set(id, chunk);
    if (this.syncColliders) {
      this.sim.rebuildBroadPhase();
    }
  }

  applyChunkDiff(packet: ChunkDiffPacket): void {
    const id = keyToString(packet.chunk);
    const chunk = this.chunks.get(id) ?? {
      key: packet.chunk,
      version: 0,
      blocks: new Map<number, number>(),
      blockColliders: new Map<number, number>(),
      pending: [],
    };

    const expectedVersion = chunk.version + 1;
    if (packet.version !== expectedVersion && chunk.version !== 0) {
      // Version gap — warn and drop. A chunkFull will reconcile.
      console.warn(
        `Chunk ${id} version gap: have ${chunk.version}, got ${packet.version}`,
      );
      return;
    }

    // Fast path: server acknowledged our pending optimistic edit.
    const front = chunk.pending[0];
    if (front !== undefined && diffMatchesPending(packet, front.cmd)) {
      // Already applied locally — just confirm the version.
      chunk.version = packet.version;
      chunk.pending.shift();
      this.chunks.set(id, chunk);
      return;
    }

    // Conflict or foreign edit: revert all pending optimistic edits, then
    // apply the authoritative server diff, then re-apply surviving pending edits.
    this._revertAllPending(chunk);

    for (const edit of packet.edits) {
      const idx = packLocalIndex(edit.x, edit.y, edit.z);
      this._applySingleEdit(chunk, edit.op, idx, [edit.x, edit.y, edit.z], edit.material);
    }
    chunk.version = packet.version;

    // Re-apply surviving pending edits (those not touching server-modified cells).
    const serverCells = new Set(packet.edits.map(e => packLocalIndex(e.x, e.y, e.z)));
    const survivors = chunk.pending.filter(
      p => !serverCells.has(packLocalIndex(p.cmd.local[0], p.cmd.local[1], p.cmd.local[2])),
    );
    chunk.pending = [];
    for (const pe of survivors) {
      const idx = packLocalIndex(pe.cmd.local[0], pe.cmd.local[1], pe.cmd.local[2]);
      const prevMaterial = chunk.blocks.get(idx) ?? 0;
      this._applySingleEdit(chunk, pe.cmd.op, idx, pe.cmd.local, pe.cmd.material);
      chunk.pending.push({ cmd: pe.cmd, prevMaterial });
    }

    this.chunks.set(id, chunk);
    if (this.syncColliders) {
      this.sim.rebuildBroadPhase();
    }
  }

  /**
   * Apply a block edit immediately (optimistic update) and queue it for
   * server acknowledgement.  If the server later sends a conflicting diff,
   * the edit will be reverted automatically.
   *
   * Must be called with the same `cmd` that is sent to the server via
   * `sendBlockEdit`.
   */
  applyOptimisticEdit(cmd: BlockEditCmd): void {
    const id = keyToString(cmd.chunk);
    const chunk = this.chunks.get(id);
    if (!chunk) return; // chunk not loaded — server will send the state when ready

    const idx = packLocalIndex(cmd.local[0], cmd.local[1], cmd.local[2]);
    const prevMaterial = chunk.blocks.get(idx) ?? 0;

    this._applySingleEdit(chunk, cmd.op, idx, cmd.local, cmd.material);
    chunk.pending.push({ cmd, prevMaterial });

    if (this.syncColliders) {
      this.sim.rebuildBroadPhase();
    }
  }

  buildEditRequest(worldX: number, worldY: number, worldZ: number, op: number, material: number): BlockEditCmd {
    const { chunk, local } = worldToChunkAndLocal(worldX, worldY, worldZ);
    const state = this.chunks.get(keyToString(chunk));
    const serverVersion = state?.version ?? 0;
    const pendingCount = state?.pending.length ?? 0;
    return {
      chunk,
      local,
      op,
      material,
      // Account for unacked optimistic edits so the server accepts the command.
      expectedVersion: serverVersion + pendingCount,
    };
  }

  getMaterial(worldX: number, worldY: number, worldZ: number): number {
    const { chunk, local } = worldToChunkAndLocal(worldX, worldY, worldZ);
    const state = this.chunks.get(keyToString(chunk));
    if (!state) return 0;
    return state.blocks.get(packLocalIndex(local[0], local[1], local[2])) ?? 0;
  }

  // ── Private helpers ──────────────────────────────

  private _applySingleEdit(
    chunk: ChunkState,
    op: number,
    idx: number,
    local: [number, number, number],
    material: number,
  ): void {
    if (op === BLOCK_REMOVE) {
      chunk.blocks.delete(idx);
      if (this.syncColliders) {
        const colId = chunk.blockColliders.get(idx);
        if (colId !== undefined) {
          this.sim.removeCuboid(colId);
          chunk.blockColliders.delete(idx);
        }
      }
    } else if (op === BLOCK_ADD) {
      chunk.blocks.set(idx, material);
      if (this.syncColliders && !chunk.blockColliders.has(idx)) {
        const center = chunkLocalToWorldCenter(chunk.key, local);
        const colId = this.sim.addCuboid(center.x, center.y, center.z, 0.5, 0.5, 0.5);
        chunk.blockColliders.set(idx, colId);
      }
    }
  }

  private _revertAllPending(chunk: ChunkState): void {
    for (let i = chunk.pending.length - 1; i >= 0; i--) {
      const { cmd, prevMaterial } = chunk.pending[i];
      const idx = packLocalIndex(cmd.local[0], cmd.local[1], cmd.local[2]);
      if (prevMaterial === 0) {
        // Block did not exist before — remove the optimistically-added block.
        chunk.blocks.delete(idx);
        if (this.syncColliders) {
          const colId = chunk.blockColliders.get(idx);
          if (colId !== undefined) {
            this.sim.removeCuboid(colId);
            chunk.blockColliders.delete(idx);
          }
        }
      } else {
        // Block existed before — restore it.
        chunk.blocks.set(idx, prevMaterial);
        if (this.syncColliders && !chunk.blockColliders.has(idx)) {
          const center = chunkLocalToWorldCenter(chunk.key, cmd.local);
          const colId = this.sim.addCuboid(center.x, center.y, center.z, 0.5, 0.5, 0.5);
          chunk.blockColliders.set(idx, colId);
        }
      }
    }
    chunk.pending = [];
  }
}

// ── Module-level helpers ─────────────────────────

/**
 * Returns true if the server diff is the authoritative confirmation of a
 * single pending optimistic edit (same cell, op, and material).
 */
function diffMatchesPending(packet: ChunkDiffPacket, cmd: BlockEditCmd): boolean {
  if (packet.edits.length !== 1) return false;
  const e = packet.edits[0];
  return (
    e.x === cmd.local[0] &&
    e.y === cmd.local[1] &&
    e.z === cmd.local[2] &&
    e.op === cmd.op &&
    e.material === cmd.material
  );
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
