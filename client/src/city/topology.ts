// The client-side topology ledger: the same "ledger of globally unique
// objects" the server keeps, reconstructed purely from reliable topology
// events plus the static manifest.
//
// Chunks live in exactly one body at a time. The intact structure is body
// serial 0 (the kinematic support actor, pose = the structure's world
// transform, never streamed). When an island is promoted, each member chunk's
// body-local offset is derived from its previous body's pose at the promotion
// moment: localOffset = inverse(promotionPose) ∘ chunkWorldPose. Islands are
// rigid, so offsets stay valid until the chunk migrates again.

import type { CityManifest } from './manifest';
import type { BootstrapMessage, TopologyMessage } from './wire';
import { Quat, Vec3, composePose, qIdentity, relativePose, vClone } from './vec';

export const SUPPORT_SERIAL = 0;

/** Stable key for a body across the ledger and kinematic stream. */
export const bodyKey = (structureId: number, islandSerial: number): number =>
  0x8000_0000 + structureId * 0x1_0000 + islandSerial;

export const bodyKeyParts = (key: number): { structureId: number; islandSerial: number } => ({
  structureId: Math.floor((key - 0x8000_0000) / 0x1_0000),
  islandSerial: (key - 0x8000_0000) % 0x1_0000,
});

export interface LedgerBody {
  key: number;
  structureId: number;
  islandSerial: number;
  /** Global chunk index (into the flat chunk arrays) of each member. */
  chunkSlots: number[];
  /** Authoritative pose (updated by stream/topology), body frame -> world. */
  position: Vec3;
  rotation: Quat;
  settled: boolean;
}

export interface CityTopologyStats {
  brokenBonds: number;
  liveIslands: number;
  settledIslands: number;
  topoSeqGaps: number;
}

export class CityTopology {
  /** Flat chunk addressing: slotOf[structureId][nodeIndex] -> global slot. */
  readonly chunkCount: number;
  private readonly slotBase: Map<number, number> = new Map();
  private readonly slotStructure: Uint32Array;
  private readonly slotNode: Uint32Array;

  /** Per-slot current body and body-local offset. */
  readonly chunkBody: Float64Array;
  private readonly localPos: Float32Array;
  private readonly localRot: Float32Array;

  private readonly bodies: Map<number, LedgerBody> = new Map();
  private readonly aliveBonds: Map<number, Uint8Array> = new Map();
  private brokenBonds = 0;
  private lastTopoSeq = 0;
  private topoSeqGaps = 0;
  /** Set when a gap was detected; cleared by bootstrap. */
  needsResync = false;

  constructor(private readonly manifest: CityManifest) {
    let total = 0;
    for (const structure of manifest.structures) {
      this.slotBase.set(structure.structureId, total);
      total += structure.chunks.length;
    }
    this.chunkCount = total;
    this.slotStructure = new Uint32Array(total);
    this.slotNode = new Uint32Array(total);
    this.chunkBody = new Float64Array(total);
    this.localPos = new Float32Array(total * 3);
    this.localRot = new Float32Array(total * 4);
    this.reset();
  }

  /** Reset every chunk to its intact support body with manifest rest poses. */
  reset(): void {
    this.bodies.clear();
    this.aliveBonds.clear();
    this.brokenBonds = 0;
    for (const structure of this.manifest.structures) {
      const base = this.slotBase.get(structure.structureId)!;
      const supportKey = bodyKey(structure.structureId, SUPPORT_SERIAL);
      const slots: number[] = [];
      for (const chunk of structure.chunks) {
        const slot = base + chunk.nodeIndex;
        slots.push(slot);
        this.slotStructure[slot] = structure.structureId;
        this.slotNode[slot] = chunk.nodeIndex;
        this.chunkBody[slot] = supportKey;
        this.localPos[slot * 3] = chunk.centroid[0];
        this.localPos[slot * 3 + 1] = chunk.centroid[1];
        this.localPos[slot * 3 + 2] = chunk.centroid[2];
        this.localRot[slot * 4] = 0;
        this.localRot[slot * 4 + 1] = 0;
        this.localRot[slot * 4 + 2] = 0;
        this.localRot[slot * 4 + 3] = 1;
      }
      this.bodies.set(supportKey, {
        key: supportKey,
        structureId: structure.structureId,
        islandSerial: SUPPORT_SERIAL,
        chunkSlots: slots,
        position: vClone(structure.worldPosition),
        rotation: [...structure.worldRotation] as Quat,
        settled: true,
      });
      const bits = new Uint8Array(Math.ceil(structure.bonds.length / 8));
      bits.fill(0xff);
      // Clear padding bits past bondCount.
      const excess = bits.length * 8 - structure.bonds.length;
      if (excess > 0 && bits.length > 0) {
        bits[bits.length - 1] &= 0xff >>> excess;
      }
      this.aliveBonds.set(structure.structureId, bits);
    }
  }

  slotOf(structureId: number, nodeIndex: number): number {
    return (this.slotBase.get(structureId) ?? 0) + nodeIndex;
  }

  body(key: number): LedgerBody | undefined {
    return this.bodies.get(key);
  }

  allBodies(): IterableIterator<LedgerBody> {
    return this.bodies.values();
  }

  chunkLocalOffset(slot: number): { position: Vec3; rotation: Quat } {
    return {
      position: [
        this.localPos[slot * 3],
        this.localPos[slot * 3 + 1],
        this.localPos[slot * 3 + 2],
      ],
      rotation: [
        this.localRot[slot * 4],
        this.localRot[slot * 4 + 1],
        this.localRot[slot * 4 + 2],
        this.localRot[slot * 4 + 3],
      ],
    };
  }

  /** Current world pose of one chunk (bodyPose ∘ localOffset). */
  chunkWorldPose(slot: number): { position: Vec3; rotation: Quat } {
    const body = this.bodies.get(this.chunkBody[slot]);
    const local = this.chunkLocalOffset(slot);
    if (!body) {
      return local;
    }
    return composePose(body.position, body.rotation, local.position, local.rotation);
  }

  stats(): CityTopologyStats {
    let live = 0;
    let settled = 0;
    for (const body of this.bodies.values()) {
      if (body.islandSerial === SUPPORT_SERIAL) {
        continue;
      }
      live += 1;
      if (body.settled) {
        settled += 1;
      }
    }
    return {
      brokenBonds: this.brokenBonds,
      liveIslands: live,
      settledIslands: settled,
      topoSeqGaps: this.topoSeqGaps,
    };
  }

  lastSeq(): number {
    return this.lastTopoSeq;
  }

  /** Applies a reliable topology message. Returns false on a sequence gap. */
  apply(message: TopologyMessage): boolean {
    if (this.lastTopoSeq !== 0 && message.topoSeq !== this.lastTopoSeq + 1) {
      if (message.topoSeq <= this.lastTopoSeq) {
        return true; // duplicate/old — already applied
      }
      this.topoSeqGaps += 1;
      this.needsResync = true;
      return false;
    }
    this.lastTopoSeq = message.topoSeq;

    for (const batch of message.batches) {
      const bits = this.aliveBonds.get(batch.structureId);
      if (bits) {
        for (const bondIndex of batch.brokenBondIndices) {
          const byte = bondIndex >> 3;
          const mask = 1 << (bondIndex & 7);
          if (byte < bits.length && (bits[byte] & mask) !== 0) {
            bits[byte] &= ~mask;
            this.brokenBonds += 1;
          }
        }
      }
      for (const promotion of batch.promotions) {
        this.promote(
          batch.structureId,
          promotion.islandId,
          promotion.nodes,
          promotion.position,
          promotion.rotation,
        );
      }
      for (const retired of batch.retiredIslandIds) {
        this.retire(bodyKey(batch.structureId, retired));
      }
    }
    for (const settle of message.settled) {
      const body = this.bodies.get(bodyKey(settle.structureId, settle.islandId));
      if (body) {
        body.settled = true;
        body.position = vClone(settle.position);
        body.rotation = [...settle.rotation] as Quat;
      }
    }
    for (const wake of message.wakes) {
      const body = this.bodies.get(bodyKey(wake.structureId, wake.islandSerial));
      if (body) {
        body.settled = false;
      }
    }
    return true;
  }

  /** Updates a live body's authoritative pose from the kinematic stream. */
  updateBodyPose(key: number, position: Vec3, rotation: Quat): void {
    const body = this.bodies.get(key);
    if (body) {
      body.position = vClone(position);
      body.rotation = [...rotation] as Quat;
    }
  }

  private promote(
    structureId: number,
    islandId: number,
    nodes: number[],
    position: Vec3,
    rotation: Quat,
  ): void {
    const key = bodyKey(structureId, islandId);
    const slots: number[] = [];
    for (const node of nodes) {
      const slot = this.slotOf(structureId, node);
      slots.push(slot);
      // Chunk world pose under its previous body, then re-express relative to
      // the new island body's promotion pose.
      const previousKey = this.chunkBody[slot];
      const world = this.chunkWorldPose(slot);
      const local = relativePose(position, rotation, world.position, world.rotation);
      this.chunkBody[slot] = key;
      this.localPos[slot * 3] = local.position[0];
      this.localPos[slot * 3 + 1] = local.position[1];
      this.localPos[slot * 3 + 2] = local.position[2];
      this.localRot[slot * 4] = local.rotation[0];
      this.localRot[slot * 4 + 1] = local.rotation[1];
      this.localRot[slot * 4 + 2] = local.rotation[2];
      this.localRot[slot * 4 + 3] = local.rotation[3];
      // Remove from the previous body's membership.
      const previousBody = this.bodies.get(previousKey);
      if (previousBody) {
        const index = previousBody.chunkSlots.indexOf(slot);
        if (index >= 0) {
          previousBody.chunkSlots.splice(index, 1);
        }
      }
    }
    this.bodies.set(key, {
      key,
      structureId,
      islandSerial: islandId,
      chunkSlots: slots,
      position: vClone(position),
      rotation: [...rotation] as Quat,
      settled: false,
    });
  }

  private retire(key: number): void {
    const body = this.bodies.get(key);
    if (!body) {
      return;
    }
    this.bodies.delete(key);
  }

  /**
   * Rebuilds the whole ledger from a bootstrap message.
   *
   * Canonical body-frame invariant: every island body's wire pose maps
   * structure-rest coordinates to world (`chunkWorld = bodyPose ∘ restLocal`),
   * because each promotion pose equals the parent body's pose at the split
   * instant. Late joiners therefore use manifest rest poses as local offsets
   * directly — no split history required. The live `promote` path computes
   * the same offsets via `relativePose` (exactly rest poses when the
   * invariant holds).
   */
  applyBootstrap(message: BootstrapMessage): void {
    this.reset();
    this.lastTopoSeq = message.topoSeq;
    this.needsResync = false;
    this.brokenBonds = 0;
    for (const structure of message.structures) {
      const bits = this.aliveBonds.get(structure.structureId);
      if (bits) {
        for (let i = 0; i < structure.bondCount; i++) {
          const alive = (structure.aliveBonds[i >> 3] & (1 << (i & 7))) !== 0;
          if (!alive) {
            const byte = i >> 3;
            bits[byte] &= ~(1 << (i & 7));
            this.brokenBonds += 1;
          }
        }
      }
    }
    for (const island of message.islands) {
      const key = bodyKey(island.structureId, island.islandId);
      const slots: number[] = [];
      for (const node of island.nodes) {
        const slot = this.slotOf(island.structureId, node);
        slots.push(slot);
        // Rest local offsets are already in place from reset(); just
        // re-parent the chunk and fix the support body's membership.
        const previousBody = this.bodies.get(this.chunkBody[slot]);
        if (previousBody) {
          const index = previousBody.chunkSlots.indexOf(slot);
          if (index >= 0) {
            previousBody.chunkSlots.splice(index, 1);
          }
        }
        this.chunkBody[slot] = key;
      }
      this.bodies.set(key, {
        key,
        structureId: island.structureId,
        islandSerial: island.islandId,
        chunkSlots: slots,
        position: vClone(island.position),
        rotation: [...island.rotation] as Quat,
        settled: island.settled,
      });
    }
  }

  chunkStructure(slot: number): number {
    return this.slotStructure[slot];
  }

  chunkNode(slot: number): number {
    return this.slotNode[slot];
  }
}
