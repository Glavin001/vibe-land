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

/** Which writer produced a body pose. See `updateBodyPose`. */
export type BodyPoseSource = 'raw' | 'presented' | 'settle' | 'promote' | 'reoffset' | 'bootstrap';

/** Wire position quantum (1 cm); anything below it is encoding dither. */
const POSE_QUANTUM_M = 0.01;
import {
  EPSILON,
  Quat,
  Vec3,
  composePose,
  qIdentity,
  qRotate,
  relativePose,
  vAdd,
  vClone,
  vLength,
} from './vec';

export const SUPPORT_SERIAL = 0;

/** Stable key for a body across the ledger and kinematic stream. */
export const bodyKey = (structureId: number, islandSerial: number): number =>
  0x8000_0000 + structureId * 0x40_0000 + islandSerial;

export const bodyKeyParts = (key: number): { structureId: number; islandSerial: number } => ({
  structureId: Math.floor((key - 0x8000_0000) / 0x40_0000),
  islandSerial: (key - 0x8000_0000) % 0x40_0000,
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
  /**
   * Chunks whose owning body is no longer in the ledger. Must stay 0: an
   * orphaned chunk has no world transform, so anything it renders is a guess.
   */
  orphanedChunks: number;
  /** Cumulative chunks orphaned by a retire, including transient windows. */
  orphanedByRetire: number;
}

/**
 * How far a settle may legitimately move a body.
 *
 * A settling body is where the stream last showed it, give or take the
 * interpolation delay and a distance stride -- debris travels tens of metres
 * per second, so a few metres is normal and generous. Tens of metres is not
 * lag; it is a different frame.
 */
const SETTLE_MAX_DRIFT_M = 10;

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
  /**
   * Manifest rest offset per chunk, in its structure's frame.
   *
   * The adapter builds every chunk shape at its authored local pose and reuses
   * the same shape across body migrations, so an island body's pose is a full
   * transform from structure-rest coordinates to world:
   *   chunkWorld = bodyPose ∘ restLocal
   * That is the canonical body-frame invariant documented in
   * netcode/src/destruction_backend.rs, and it is exactly what
   * `applyBootstrap` uses to rebuild a damaged city for a late joiner.
   */
  private readonly restPos: Float32Array;
  /** Manifest mass per chunk, for reconstructing an island's centre of mass. */
  private readonly restMass: Float32Array;

  private readonly bodies: Map<number, LedgerBody> = new Map();
  private readonly aliveBonds: Map<number, Uint8Array> = new Map();
  private brokenBonds = 0;
  private orphanedByRetire = 0;
  private lastTopoSeq = 0;
  private topoSeqGaps = 0;
  /** Topology messages ignored as already-applied; see apply(). */
  duplicateDrops = 0;
  /** Set when a gap was detected; cleared by bootstrap. */
  needsResync = false;
  /**
   * Structures whose ledger CONTENT is wrong at a known-good stream position —
   * a migration named an island this client was never told about, or a settle
   * pose disagreed with our membership. These repair with a structure-scoped
   * bootstrap; only `needsResync` (a seq gap — the POSITION itself is lost)
   * still demands the full rebuild. The distinction is what broke the
   * 3.0-second full-bootstrap loop: every cascade fault used to escalate to a
   * whole-world repaint, which read as the entire rubble field popping on the
   * resync rate-limiter's exact cadence.
   */
  readonly resyncStructures = new Set<number>();
  /**
   * Settles refused because their pose would have teleported the body.
   *
   * Must be 0. Each one is a body whose membership this client and the server
   * disagree about, caught before it could be drawn in the wrong place.
   */
  settleFrameRejects = 0;
  /**
   * Notified when a body's centre-of-mass frame shifts, with the body-local
   * delta. The pose stream is buffered for smoothing, so whoever holds that
   * buffer has to carry the same shift or it will compose old-frame poses
   * with the new-frame offsets written here.
   */
  onReoffset: ((bodyKey: number, deltaLocal: Vec3) => void) | null = null;

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
    this.restPos = new Float32Array(total * 3);
    this.restMass = new Float32Array(total);
    for (const structure of manifest.structures) {
      const base = this.slotBase.get(structure.structureId)!;
      for (const chunk of structure.chunks) {
        this.restMass[base + chunk.nodeIndex] = chunk.mass;
      }
    }
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
        this.restPos[slot * 3] = chunk.centroid[0];
        this.restPos[slot * 3 + 1] = chunk.centroid[1];
        this.restPos[slot * 3 + 2] = chunk.centroid[2];
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

  /** Ledger body key currently owning this chunk (diagnostics). */
  chunkBodyKey(slot: number): number {
    return this.chunkBody[slot];
  }

  body(key: number): LedgerBody | undefined {
    return this.bodies.get(key);
  }

  allBodies(): IterableIterator<LedgerBody> {
    return this.bodies.values();
  }

  /** Which body a chunk is currently bound to. */
  bodyKeyOf(slot: number): number {
    return this.chunkBody[slot];
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

  /**
   * Same compose, written into caller storage: 7 floats (x,y,z, qx,qy,qz,qw)
   * at `out[at..at+7]`.
   *
   * The allocating form builds two arrays for the local offset, four more
   * inside composePose and a wrapper object -- seven allocations per chunk,
   * per call. That is invisible for one chunk and ruinous for the paths that
   * do it per dirty chunk per frame, or across all 24k slots in the telemetry
   * sweep. `body` is passed in because every caller already holds it, and the
   * Map lookup was being repeated for every chunk of the same body.
   */
  /**
   * Returns false when the chunk's body is missing from the ledger.
   *
   * The allocating form answers that case with the chunk's BODY-LOCAL offset,
   * which is not a world pose at all -- for a structure sited away from the
   * origin it is tens or hundreds of metres from where the chunk belongs. Any
   * caller that draws it puts the chunk somewhere it has never been, which on
   * screen is a hole in the building. A chunk whose body the ledger cannot
   * resolve has no known pose, and the only correct thing to draw is whatever
   * was drawn last, so this reports the failure instead of inventing one.
   */
  chunkWorldPoseInto(
    slot: number,
    body: LedgerBody | undefined,
    out: Float32Array,
    at: number,
  ): boolean {
    // The caller's body is a hint, not the authority. The allocating form
    // always resolved the slot's CURRENT owner, so it was correct even mid
    // migration; taking the caller's word for it instead meant that during a
    // fracture -- exactly when membership is churning -- a chunk could be
    // composed against the body it just LEFT, and get drawn somewhere it is
    // not. On screen that is a hole opening where the building was, with the
    // pieces appearing a moment later once the write path caught up.
    if (body !== undefined && this.chunkBody[slot] !== body.key) {
      body = this.bodies.get(this.chunkBody[slot]);
    }
    const l3 = slot * 3;
    const l4 = slot * 4;
    const lx = this.localPos[l3];
    const ly = this.localPos[l3 + 1];
    const lz = this.localPos[l3 + 2];
    const lqx = this.localRot[l4];
    const lqy = this.localRot[l4 + 1];
    const lqz = this.localRot[l4 + 2];
    const lqw = this.localRot[l4 + 3];
    if (!body) {
      out[at] = lx;
      out[at + 1] = ly;
      out[at + 2] = lz;
      out[at + 3] = lqx;
      out[at + 4] = lqy;
      out[at + 5] = lqz;
      out[at + 6] = lqw;
      return false;
    }
    const bp = body.position;
    const bq = body.rotation;
    const bqx = bq[0];
    const bqy = bq[1];
    const bqz = bq[2];
    const bqw = bq[3];
    // v' = q * v * q^-1, expanded (t = 2 * q_vec x v).
    const tx = 2 * (bqy * lz - bqz * ly);
    const ty = 2 * (bqz * lx - bqx * lz);
    const tz = 2 * (bqx * ly - bqy * lx);
    out[at] = bp[0] + lx + bqw * tx + bqy * tz - bqz * ty;
    out[at + 1] = bp[1] + ly + bqw * ty + bqz * tx - bqx * tz;
    out[at + 2] = bp[2] + lz + bqw * tz + bqx * ty - bqy * tx;
    // Hamilton product, then normalise: the body rotation is streamed and
    // quantised, so the product drifts off the unit sphere without it.
    let rx = bqw * lqx + bqx * lqw + bqy * lqz - bqz * lqy;
    let ry = bqw * lqy - bqx * lqz + bqy * lqw + bqz * lqx;
    let rz = bqw * lqz + bqx * lqy - bqy * lqx + bqz * lqw;
    let rw = bqw * lqw - bqx * lqx - bqy * lqy - bqz * lqz;
    const lengthSq = rx * rx + ry * ry + rz * rz + rw * rw;
    if (!Number.isFinite(lengthSq) || lengthSq <= 1e-6) {
      // Matches qNormalize's degenerate case: identity, not NaN.
      rx = 0;
      ry = 0;
      rz = 0;
      rw = 1;
    } else {
      const inv = 1 / Math.sqrt(lengthSq);
      rx *= inv;
      ry *= inv;
      rz *= inv;
      rw *= inv;
    }
    out[at + 3] = rx;
    out[at + 4] = ry;
    out[at + 5] = rz;
    out[at + 6] = rw;
    return true;
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
    let orphaned = 0;
    for (let slot = 0; slot < this.chunkCount; slot += 1) {
      if (!this.bodies.has(this.chunkBody[slot])) {
        orphaned += 1;
      }
    }
    return {
      brokenBonds: this.brokenBonds,
      liveIslands: live,
      settledIslands: settled,
      topoSeqGaps: this.topoSeqGaps,
      orphanedChunks: orphaned,
      orphanedByRetire: this.orphanedByRetire,
    };
  }

  lastSeq(): number {
    return this.lastTopoSeq;
  }

  /** Applies a reliable topology message. Returns false on a sequence gap. */
  apply(message: TopologyMessage): boolean {
    if (this.lastTopoSeq !== 0 && message.topoSeq !== this.lastTopoSeq + 1) {
      if (message.topoSeq <= this.lastTopoSeq) {
        // Duplicate OR a new world whose sequence restarted below ours. The
        // second case is invisible without this: every message of the fresh
        // world is silently swallowed as "already applied".
        this.duplicateDrops += 1;
        if (this.duplicateDrops === 1 || this.duplicateDrops % 25 === 0) {
          console.warn(
            `[city] topology dropped as duplicate seq=${message.topoSeq} last=${this.lastTopoSeq} drops=${this.duplicateDrops}`,
          );
        }
        return true;
      }
      this.topoSeqGaps += 1;
      this.needsResync = true;
      return false;
    }
    this.lastTopoSeq = message.topoSeq;

    // A chunk is the same physical object before and after a topology batch
    // re-parents it, so its world pose should be continuous across the batch.
    // Displacement here is the fracture discontinuity a player sees as chunks
    // jumping the instant a building breaks.
    let poseBefore: Map<number, Vec3> | null = null;
    if (this.watchPoseSources && this.onAdoptionJump) {
      poseBefore = new Map();
      for (const batch of message.batches) {
        const touched = [
          ...batch.promotions.flatMap((p) => p.nodes),
          ...batch.migrations.map((m) => m.node),
        ];
        for (const node of touched) {
          const slot = this.slotOf(batch.structureId, node);
          if (!poseBefore.has(slot)) {
            poseBefore.set(slot, this.chunkWorldPose(slot).position);
          }
        }
      }
    }

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
      // After promotions: a chunk can be promoted into a new island and then
      // migrate in the same batch, and the server orders it that way.
      for (const migration of batch.migrations ?? []) {
        this.migrateChunk(
          batch.structureId,
          migration.node,
          migration.fromIslandSerial,
          migration.toIslandSerial,
        );
      }
      for (const retired of batch.retiredIslandIds) {
        this.retire(bodyKey(batch.structureId, retired));
      }
    }
    for (const settle of message.settled) {
      const body = this.bodies.get(bodyKey(settle.structureId, settle.islandId));
      if (body) {
        // A settle says a body STOPPED MOVING. The pose it carries is where
        // the body already is -- that is the whole meaning of the event. So a
        // settle pose that relocates the body by tens of metres is not a
        // settle at all: it is proof that the two sides disagree about this
        // body's MEMBERSHIP, because both derive the pose from the centre of
        // mass of their own member set and a mismatched set moves the COM.
        //
        // Applying it anyway composes every member through a frame the offsets
        // were not built for, which is a whole island jumping and coming back
        // -- seen as a fracture-shaped hole opening in a building for a frame.
        // Measured here at 74 m from a message carrying nothing but one settle.
        //
        // So: take the rest state, refuse the impossible pose, and repair the
        // real fault by rebuilding the ledger.
        const drift = Math.hypot(
          settle.position[0] - body.position[0],
          settle.position[1] - body.position[1],
          settle.position[2] - body.position[2],
        );
        body.settled = true;
        if (drift > SETTLE_MAX_DRIFT_M) {
          this.settleFrameRejects += 1;
          // Membership disagreement in ONE structure; the stream position is
          // fine. Structure-scoped repair, not a world rebuild.
          this.resyncStructures.add(settle.structureId);
        } else {
          body.position = vClone(settle.position);
          body.rotation = [...settle.rotation] as Quat;
        }
      }
    }
    for (const wake of message.wakes) {
      const body = this.bodies.get(bodyKey(wake.structureId, wake.islandSerial));
      if (body) {
        body.settled = false;
      }
    }

    if (poseBefore) {
      for (const [slot, before] of poseBefore) {
        const after = this.chunkWorldPose(slot).position;
        const step = Math.hypot(
          after[0] - before[0],
          after[1] - before[1],
          after[2] - before[2],
        );
        if (step > POSE_QUANTUM_M) this.onAdoptionJump?.(slot, step);
      }
    }
    return true;
  }

  /**
   * Updates a live body's authoritative pose.
   *
   * `source` says which writer this is. There are two in normal operation:
   * `raw` (newest streamed pose, written at packet arrival) and `presented`
   * (the interpolated pose, one interpolation delay behind). A body whose
   * writes alternate between them is being drawn at two different times in
   * consecutive frames, which is visible as a flicker — so while recording,
   * alternation with real displacement is reported.
   */
  updateBodyPose(
    key: number,
    position: Vec3,
    rotation: Quat,
    source: BodyPoseSource = 'raw',
  ): void {
    const body = this.bodies.get(key);
    if (!body) return;
    if (this.watchPoseSources) {
      this.observePoseWrite(key, body.position, position, source);
    }
    body.position = vClone(position);
    body.rotation = [...rotation] as Quat;
  }

  /**
   * Records which writer last set each body's pose, and how far that write
   * moved it.
   *
   * Note this alone is NOT an artefact: `samplePresentation` writes every live
   * body once per frame and runs before the renderer reads, so a raw write
   * that lands between frames is normally overwritten before anyone sees it.
   * What matters is the source in effect at the moment the renderer composes
   * the chunk — see `poseSourceOf`, sampled by the render layer.
   */
  private observePoseWrite(
    key: number,
    previousPosition: Vec3,
    nextPosition: Vec3,
    source: BodyPoseSource,
  ): void {
    this.lastPoseSource.set(key, source);
    const dx = nextPosition[0] - previousPosition[0];
    const dy = nextPosition[1] - previousPosition[1];
    const dz = nextPosition[2] - previousPosition[2];
    // The wire quantises position to 1 cm, so anything below that is dither.
    const delta = Math.hypot(dx, dy, dz);
    this.lastPoseDelta.set(key, delta < POSE_QUANTUM_M ? 0 : delta);
  }

  /** Enable pose-source tracking (measurement only; off in normal play). */
  watchPoseSources = false;
  private readonly lastPoseSource = new Map<number, BodyPoseSource>();
  private readonly lastPoseDelta = new Map<number, number>();

  /** Which writer last set this body's pose, and how far that write moved it. */
  poseSourceOf(key: number): { source: BodyPoseSource | undefined; deltaM: number } {
    return { source: this.lastPoseSource.get(key), deltaM: this.lastPoseDelta.get(key) ?? 0 };
  }

  /**
   * Checks the two membership records agree: `chunkBody[slot]` names the body
   * whose `chunkSlots` contains `slot`, and vice versa. They are written
   * independently by promote/migrate/retire, and a divergence leaves "shadow
   * members" — chunks a body still owns by one record but excludes from its
   * centre of mass, so their offsets rot in a dead frame while the body keeps
   * moving. This is the client-side analogue of the server's
   * `duplicate_body_records` check.
   */
  membershipViolations(): number {
    let violations = 0;
    for (let slot = 0; slot < this.chunkCount; slot += 1) {
      const key = this.chunkBody[slot];
      const body = this.bodies.get(key);
      if (!body) continue; // orphan; counted separately by stats()
      if (!body.chunkSlots.includes(slot)) violations += 1;
    }
    for (const [key, body] of this.bodies) {
      for (const slot of body.chunkSlots) {
        if (this.chunkBody[slot] !== key) violations += 1;
      }
    }
    return violations;
  }

  /**
   * Flags islands whose members sit further from each other than the island
   * could physically span — a small island pairing chunks tens of metres apart
   * is membership the client cannot have derived correctly. Ported from the
   * diagnostics that localised the district-scene position corruption.
   */
  diagnoseFrames(maxOffsetM = 5, maxMembers = 2): Array<{ key: number; worstOffsetM: number; members: number }> {
    const suspects: Array<{ key: number; worstOffsetM: number; members: number }> = [];
    for (const [key, body] of this.bodies) {
      if (body.chunkSlots.length === 0 || body.chunkSlots.length > maxMembers) continue;
      let worst = 0;
      for (const slot of body.chunkSlots) {
        const offset = Math.hypot(
          this.localPos[slot * 3],
          this.localPos[slot * 3 + 1],
          this.localPos[slot * 3 + 2],
        );
        if (offset > worst) worst = offset;
      }
      if (worst > maxOffsetM) {
        suspects.push({ key, worstOffsetM: worst, members: body.chunkSlots.length });
      }
    }
    return suspects;
  }

  /** Migration events the ledger could not apply correctly. */
  readonly migrateAnomalies = { missingDestination: 0, emptyDestination: 0 };

  /**
   * Re-parent `nodes` onto an island body and set their body-local offsets.
   *
   * Offsets come from the island's own rest geometry, never from where this
   * client currently believes a chunk is. The adapter re-centres a split child
   * on its centre of mass, so an island body's frame is the structure rest
   * frame translated by the COM of its members — which the manifest pins down
   * exactly (mass + rest centroid per chunk).
   *
   * The old promote path derived offsets as
   * `inverse(promotionPose) ∘ chunkWorldPose(slot)`, which folded in however
   * stale this client's view happened to be. Topology is reliable and
   * immediate, but the parent's kinematic poses are unreliable, rate limited
   * and interest culled, and a chunk re-parented by the physics without a
   * promotion is not tracked at all. A chunk still believed to be resting on
   * its structure (world y ≈ 1.2) while the server had it in an island 10 m up
   * produced a −10.3 m offset; islands are rigid, so that error was frozen in
   * for the rest of the match and the chunk rendered under the floor.
   *
   * Bootstrap and live promotion share this so a late joiner and a client that
   * watched the collapse agree chunk for chunk.
   */
  private adoptIslandMembers(
    structureId: number,
    key: number,
    nodes: number[],
  ): number[] {
    return this.adoptIslandMembersInner(structureId, key, nodes);
  }

  /**
   * Reported when a topology batch moves a chunk's world pose.
   *
   * Measured across the whole batch, not inside adoption: `promote` adopts
   * members before it inserts the body, so mid-adoption the chunk resolves
   * through the missing-body fallback and any reading there is meaningless.
   */
  onAdoptionJump: ((slot: number, stepM: number) => void) | null = null;

  private adoptIslandMembersInner(
    structureId: number,
    key: number,
    nodes: number[],
  ): number[] {
    let comX = 0;
    let comY = 0;
    let comZ = 0;
    let totalWeight = 0;
    for (const node of nodes) {
      const slot = this.slotOf(structureId, node);
      // Support chunks carry mass 0; weight them uniformly so an all-support
      // island still resolves to its geometric centre instead of NaN.
      const weight = this.restMass[slot] > 0 ? this.restMass[slot] : 1;
      comX += this.restPos[slot * 3] * weight;
      comY += this.restPos[slot * 3 + 1] * weight;
      comZ += this.restPos[slot * 3 + 2] * weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) {
      comX /= totalWeight;
      comY /= totalWeight;
      comZ /= totalWeight;
    }

    const slots: number[] = [];
    // Bodies that lost members to this island. Their centre of mass moves when
    // membership shrinks, and the server's pose for them moves with it, so
    // their remaining chunks must be re-offset in the same breath or every one
    // of them jumps by the centre-of-mass delta at the instant of fracture.
    const drained = new Set<LedgerBody>();
    for (const node of nodes) {
      const slot = this.slotOf(structureId, node);
      slots.push(slot);
      const previousBody = this.bodies.get(this.chunkBody[slot]);
      if (previousBody) {
        const index = previousBody.chunkSlots.indexOf(slot);
        if (index >= 0) {
          previousBody.chunkSlots.splice(index, 1);
          drained.add(previousBody);
        }
      }
      this.chunkBody[slot] = key;
      this.localPos[slot * 3] = this.restPos[slot * 3] - comX;
      this.localPos[slot * 3 + 1] = this.restPos[slot * 3 + 1] - comY;
      this.localPos[slot * 3 + 2] = this.restPos[slot * 3 + 2] - comZ;
      this.localRot[slot * 4] = 0;
      this.localRot[slot * 4 + 1] = 0;
      this.localRot[slot * 4 + 2] = 0;
      this.localRot[slot * 4 + 3] = 1;
    }
    for (const body of drained) {
      this.reoffsetBody(body);
    }
    return slots;
  }

  /**
   * Recompute a body's chunk offsets against its current membership.
   *
   * An island body's wire pose is its centre of mass, so when it sheds chunks
   * its pose moves even though the rigid body itself did not: the centre of
   * mass of what remains is somewhere else. Leaving the offsets on the old
   * centre of mass displaces every surviving chunk by that delta the moment a
   * split lands, which reads as the building translating as it fractures.
   *
   * The support body is exempt and must stay exempt: it is never streamed (it
   * is kinematic), so it keeps the structure-origin pose and plain rest
   * offsets that `reset()` gave it.
   */
  /**
   * Move one chunk between two islands that both already exist.
   *
   * Physics reparents chunks without issuing a promotion -- thousands of times
   * over a demolition. Both islands' centres of mass move when it happens, so
   * both have to be re-offset, and the destination's offset for this chunk has
   * to be stated in the destination's frame rather than carried over from the
   * source's.
   */
  private migrateChunk(
    structureId: number,
    node: number,
    fromIslandSerial: number,
    toIslandSerial: number,
  ): void {
    const slot = this.slotOf(structureId, node);
    const destination = this.bodies.get(bodyKey(structureId, toIslandSerial));
    if (!destination) {
      // The destination should have been promoted already. Without it there is
      // nowhere correct to put the chunk, and guessing is what produces
      // chunks composed against the wrong frame. One structure's content is
      // wrong; the stream position is not — structure-scoped repair.
      this.migrateAnomalies.missingDestination += 1;
      this.resyncStructures.add(structureId);
      return;
    }
    // An empty destination has no frame to leave, so `reoffsetBody` would fall
    // back to reading the "old" centre of mass off the chunk that just arrived
    // -- which still carries the SOURCE body's frame. That yields a delta the
    // size of the gap between the two islands, and shifts the destination's
    // pose and its whole buffered track by it. Handled separately below.
    const destinationWasEmpty = destination.chunkSlots.length === 0;
    if (destinationWasEmpty) {
      this.migrateAnomalies.emptyDestination += 1;
    }
    const source = this.bodies.get(bodyKey(structureId, fromIslandSerial));
    // Both frames have to be read before membership changes: afterwards they
    // are no longer recoverable from the members' offsets.
    const sourceOldCom = source ? this.centreOfMass(source) : null;
    const destinationOldCom = this.centreOfMass(destination);
    if (source) {
      const index = source.chunkSlots.indexOf(slot);
      if (index >= 0) {
        source.chunkSlots.splice(index, 1);
      }
    }
    if (!destination.chunkSlots.includes(slot)) {
      destination.chunkSlots.push(slot);
    }
    this.chunkBody[slot] = destination.key;
    this.localRot[slot * 4] = 0;
    this.localRot[slot * 4 + 1] = 0;
    this.localRot[slot * 4 + 2] = 0;
    this.localRot[slot * 4 + 3] = 1;
    // Membership changed on both sides, so both centres of mass moved.
    // reoffsetBody restates every member offset and shifts the body pose to
    // match, which also covers this chunk's new offset.
    if (source) {
      this.reoffsetBody(source, sourceOldCom);
    }
    if (destinationWasEmpty) {
      // With one member the frame is fully determined: the centre of mass is
      // that chunk's own centroid, so its offset is zero. The body's pose is
      // left alone -- it heals on the next streamed record rather than being
      // shifted by a delta recovered from the wrong frame.
      const com = this.centreOfMass(destination);
      this.localPos[slot * 3] = com ? this.restPos[slot * 3] - com[0] : 0;
      this.localPos[slot * 3 + 1] = com ? this.restPos[slot * 3 + 1] - com[1] : 0;
      this.localPos[slot * 3 + 2] = com ? this.restPos[slot * 3 + 2] - com[2] : 0;
    } else {
      this.reoffsetBody(destination, destinationOldCom);
    }
  }

  /**
   * Centre of mass of a body's current members, in structure-rest coordinates.
   */
  private centreOfMass(body: LedgerBody): Vec3 | null {
    let x = 0;
    let y = 0;
    let z = 0;
    let totalWeight = 0;
    for (const slot of body.chunkSlots) {
      const weight = this.restMass[slot] > 0 ? this.restMass[slot] : 1;
      x += this.restPos[slot * 3] * weight;
      y += this.restPos[slot * 3 + 1] * weight;
      z += this.restPos[slot * 3 + 2] * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? [x / totalWeight, y / totalWeight, z / totalWeight] : null;
  }

  /**
   * `knownOldCom` is required when the caller has already changed membership,
   * because the frame is otherwise recovered from a member's current offset --
   * and a chunk that just arrived from another body carries that body's frame.
   */
  private reoffsetBody(body: LedgerBody, knownOldCom?: Vec3 | null): void {
    if (body.islandSerial === SUPPORT_SERIAL || body.chunkSlots.length === 0) {
      return;
    }
    let comX = 0;
    let comY = 0;
    let comZ = 0;
    let totalWeight = 0;
    for (const slot of body.chunkSlots) {
      const weight = this.restMass[slot] > 0 ? this.restMass[slot] : 1;
      comX += this.restPos[slot * 3] * weight;
      comY += this.restPos[slot * 3 + 1] * weight;
      comZ += this.restPos[slot * 3 + 2] * weight;
      totalWeight += weight;
    }
    if (totalWeight <= 0) {
      return;
    }
    comX /= totalWeight;
    comY /= totalWeight;
    comZ /= totalWeight;
    // Every surviving offset is `rest - oldCom`, so any one of them recovers
    // the frame we are leaving. Read it before the loop below overwrites it.
    const anchor = body.chunkSlots[0];
    const oldCom: Vec3 = knownOldCom ?? [
      this.restPos[anchor * 3] - this.localPos[anchor * 3],
      this.restPos[anchor * 3 + 1] - this.localPos[anchor * 3 + 1],
      this.restPos[anchor * 3 + 2] - this.localPos[anchor * 3 + 2],
    ];
    const delta: Vec3 = [comX - oldCom[0], comY - oldCom[1], comZ - oldCom[2]];
    for (const slot of body.chunkSlots) {
      this.localPos[slot * 3] = this.restPos[slot * 3] - comX;
      this.localPos[slot * 3 + 1] = this.restPos[slot * 3 + 1] - comY;
      this.localPos[slot * 3 + 2] = this.restPos[slot * 3 + 2] - comZ;
    }
    if (!delta.every(Number.isFinite) || vLength(delta) <= EPSILON) {
      return;
    }
    // The offsets now describe a frame the streamed pose has not moved to
    // yet. Shift the pose to match so the composed world placement is
    // unchanged by this call, and tell the presentation layer to carry the
    // same shift through its buffer -- otherwise the next several frames
    // render new-frame offsets against old-frame poses.
    const worldDelta = qRotate(body.rotation, delta);
    body.position = vAdd(body.position, worldDelta);
    this.onReoffset?.(body.key, delta);
  }

  private promote(
    structureId: number,
    islandId: number,
    nodes: number[],
    position: Vec3,
    rotation: Quat,
  ): void {
    const key = bodyKey(structureId, islandId);
    const slots = this.adoptIslandMembers(structureId, key, nodes);
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
    // Chunks still pointing at this body become orphans: `chunkWorldPose`
    // has no transform for them. Count every one, cumulatively — a 2 Hz
    // sample of the instantaneous orphan set misses short windows, and a
    // short window is still enough to freeze a wrong matrix on screen.
    for (const slot of body.chunkSlots) {
      if (this.chunkBody[slot] === key) {
        this.orphanedByRetire += 1;
      }
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
    this.resyncStructures.clear();
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
      const slots = this.adoptIslandMembers(island.structureId, key, island.nodes);
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

  /**
   * Rebuild only the structures a scoped bootstrap names, leaving every other
   * structure's ledger — and the stream position — untouched. The caller must
   * have verified `message.topoSeq === lastSeq()`: this repairs content at the
   * position both sides already agree on, it does not move the position.
   */
  applyStructureBootstrap(message: BootstrapMessage): void {
    for (const structureMessage of message.structures) {
      this.resyncStructures.delete(structureMessage.structureId);
      const manifestStructure = this.manifest.structures.find(
        (candidate) => candidate.structureId === structureMessage.structureId,
      );
      if (!manifestStructure) {
        continue;
      }
      const structureId = structureMessage.structureId;
      // Every dynamic body of this structure is about to be restated; the
      // support body is rebuilt to own every chunk again, exactly like
      // `reset()`, and the message's islands then adopt theirs back out.
      for (const key of [...this.bodies.keys()]) {
        if (bodyKeyParts(key).structureId === structureId) {
          this.bodies.delete(key);
        }
      }
      const base = this.slotBase.get(structureId)!;
      const supportKey = bodyKey(structureId, SUPPORT_SERIAL);
      const slots: number[] = [];
      for (const chunk of manifestStructure.chunks) {
        const slot = base + chunk.nodeIndex;
        slots.push(slot);
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
        structureId,
        islandSerial: SUPPORT_SERIAL,
        chunkSlots: slots,
        position: vClone(manifestStructure.worldPosition),
        rotation: [...manifestStructure.worldRotation] as Quat,
        settled: true,
      });
      // The bond bitmap comes straight from the message — the whole point of
      // the repair is that ours was wrong in a way we could not enumerate.
      this.aliveBonds.set(structureId, new Uint8Array(structureMessage.aliveBonds));
    }
    for (const island of message.islands) {
      const key = bodyKey(island.structureId, island.islandId);
      const slots = this.adoptIslandMembers(island.structureId, key, island.nodes);
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
    // Recount rather than patch: the repaired structures' previous counts are
    // exactly what we no longer trust.
    let broken = 0;
    for (const structure of this.manifest.structures) {
      const bits = this.aliveBonds.get(structure.structureId);
      if (!bits) {
        continue;
      }
      for (let i = 0; i < structure.bonds.length; i++) {
        if ((bits[i >> 3] & (1 << (i & 7))) === 0) {
          broken += 1;
        }
      }
    }
    this.brokenBonds = broken;
  }

  /**
   * Per-structure ledger hashes, the client half of the silent-divergence
   * detector. MUST match `CityLedger::structure_hashes` in
   * `destruction/src/topology.rs` byte for byte: two 32-bit FNV-1a lanes over
   * the alive-bond bitmap then each dynamic island as
   * `[serial u32][node_count u32][nodes ascending u32...]`, islands in
   * ascending serial order, all little-endian. The shared test vector lives in
   * both sides' tests.
   */
  structureHashes(): Map<number, { laneA: number; laneB: number }> {
    const FNV_PRIME = 16777619;
    const result = new Map<number, { laneA: number; laneB: number }>();
    for (const structure of this.manifest.structures) {
      const bits = this.aliveBonds.get(structure.structureId);
      if (!bits) {
        continue;
      }
      let laneA = 0x811c9dc5 >>> 0;
      let laneB = 0xdeadbeef >>> 0;
      const feed = (byte: number): void => {
        laneA = Math.imul(laneA ^ byte, FNV_PRIME) >>> 0;
        laneB = Math.imul(laneB ^ byte, FNV_PRIME) >>> 0;
      };
      const feedU32 = (value: number): void => {
        feed(value & 0xff);
        feed((value >>> 8) & 0xff);
        feed((value >>> 16) & 0xff);
        feed((value >>> 24) & 0xff);
      };
      for (const byte of bits) {
        feed(byte);
      }
      const serials: number[] = [];
      for (const body of this.bodies.values()) {
        if (body.structureId === structure.structureId && body.islandSerial !== SUPPORT_SERIAL) {
          serials.push(body.islandSerial);
        }
      }
      serials.sort((a, b) => a - b);
      for (const serial of serials) {
        const body = this.bodies.get(bodyKey(structure.structureId, serial))!;
        feedU32(serial);
        feedU32(body.chunkSlots.length);
        const nodes = body.chunkSlots.map((slot) => this.slotNode[slot]);
        nodes.sort((a, b) => a - b);
        for (const node of nodes) {
          feedU32(node);
        }
      }
      result.set(structure.structureId, { laneA, laneB });
    }
    return result;
  }

  chunkStructure(slot: number): number {
    return this.slotStructure[slot];
  }

  chunkNode(slot: number): number {
    return this.slotNode[slot];
  }
}
