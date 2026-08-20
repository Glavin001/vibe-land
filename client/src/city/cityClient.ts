// CityClient: owns the manifest, topology ledger, baseline store, and
// per-body presentation tracks. Raw city packets (kinds 119-122) are routed
// here by the transport layer; the render layer reads `sampleBodies` each
// frame and composes chunk matrices.

import type { LoadedCityManifest } from './manifest';
import {
  MotionSnapshot,
  PresentationClass,
  PresentationTrack,
  presentationConfig60Hz,
} from './presentation';
import { CityTopology, bodyKey } from './topology';
import type { Quat, Vec3 } from './vec';
import { qRotate, vAdd } from './vec';
import {
  BaselineMessage,
  ChunksDatagram,
  TopologyMessage,
  RECORD_FLAG_SETTLED_HINT,
  RecordMode,
  decodeBaseline,
  decodeBootstrap,
  decodeChunksDatagram,
  decodeTopology,
  encodeCityResyncRequest,
  decodeCityLanes,
  decodeDebrisHeader,
  encodeCityNack,
  PKT_CITY_LANES,
} from './wire';
import type { DebrisDecoder } from './debrisWasm';
import {
  PKT_CITY_BASELINE,
  PKT_CITY_BOOTSTRAP,
  PKT_CITY_CHUNKS,
  PKT_CITY_DEBRIS,
  PKT_CITY_TOPOLOGY,
} from '../net/sharedConstants';
import { isCitySuspect, isRecording, recordCityEvent } from '../netlab/recorder';

export interface CityClientStats {
  chunksTotal: number;
  chunksAwake: number;
  chunksSettled: number;
  brokenBonds: number;
  orphanedChunks: number;
  orphanedByRetire: number;
  liveIslands: number;
  topoSeqGaps: number;
  datagramsReceived: number;
  recordsApplied: number;
  /** 2 = ranked per-client records; 3 = LiveEncoder debris spans via wasm. */
  wireVersion: number;
  recordsBuffered: number;
  bytesReceived: number;
  bytesPerSecond: number;
  manifestHash: string;
}

interface BodyStreamState {
  track: PresentationTrack;
  lastTick: number;
  settledHint: boolean;
  /** Last pose handed to the renderer, for skipping motionless bodies. */
  lastPresented?: { position: Vec3; rotation: Quat };
}

/**
 * Motion below this is not worth re-composing a matrix for. Well under the
 * codec's own ~5 mm quantisation step, so a body that is genuinely moving is
 * never mistaken for a still one.
 */
const PRESENTATION_EPSILON_M = 1e-4;

export class CityClient {
  readonly topology: CityTopology;
  private readonly bodies: Map<number, BodyStreamState> = new Map();
  private baselineId = 0;
  /**
   * Baseline poses per generation, newest last.
   *
   * A generation is broadcast as several parts, and delta records stamped with
   * it start arriving before the last part does. Keeping the previous
   * generation alive means those in-flight deltas still resolve against the
   * base the server actually used, instead of being dropped for the ~parts
   * window every time a generation rolls over.
   */
  private readonly baselineGenerations: Map<number, Map<number, Vec3>> = new Map();
  /** Records referencing bodies the ledger doesn't know yet (topology in flight). */
  private pendingRecords: ChunksDatagram[] = [];
  private datagramsReceived = 0;
  private recordsApplied = 0;
  private recordsBuffered = 0;
  private bytesReceived = 0;
  private bytesWindow: Array<{ at: number; bytes: number }> = [];
  private latestSimTick = 0;
  private latestSimTickAtMs = 0;
  /** Wire v3: the wasm debris decoder; null means this match speaks v2. */
  private readonly debris: DebrisDecoder | null;
  private readonly simHz: number;
  /** Wire v3: lane -> body entity, from the reliable PKT_CITY_LANES stream. */
  private readonly laneToEntity: Map<number, number> = new Map();
  private readonly entityToLane: Map<number, number> = new Map();
  /** Preallocated sampling buffers -- one FFI call per frame, no garbage. */
  private sampleLanes = new Uint32Array(4096);
  private samplePoses = new Float32Array(4096 * 7);
  private decodeMsWindow: number[] = [];
  /**
   * Tick at which each body was last settled by the reliable channel. Guards
   * the unreliable stream, which has no ordering relationship to it.
   */
  private readonly settledAtTick: Map<number, number> = new Map();
  /** One resync request per divergence, cleared when the bootstrap lands. */
  private resyncRequested = false;
  /**
   * Bodies whose ledger pose changed without a streaming update to carry it
   * to the screen — settles, promotions, migrations, wakes. The render layer
   * repaints only what streams; while the tab is hidden rAF is paused but the
   * reliable channel keeps mutating the ledger, and an island that settles in
   * that window is removed from the streaming set before it is ever sampled
   * again. Without this queue its chunks keep their pre-hide matrices forever
   * (measured: 690 stale chunks on refocus, 28 permanent).
   */
  private repaintAll = false;
  private readonly repaintBodies = new Set<number>();
  /** Whether any bootstrap has established the baseline this session. */
  private bootstrapped = false;

  constructor(
    readonly manifest: LoadedCityManifest,
    private readonly sendResync: (bytes: Uint8Array) => void,
    v3?: { decoder: DebrisDecoder; simHz?: number },
  ) {
    this.debris = v3?.decoder ?? null;
    this.simHz = v3?.simHz ?? 60;
    this.topology = new CityTopology(manifest.manifest);
    // A body's frame moves when it sheds members. Carry that move through the
    // buffered poses so the smoothing delay cannot render new-frame offsets
    // against poses still stated in the old frame.
    this.topology.onReoffset = (key, deltaLocal) => {
      const state = this.bodies.get(key);
      if (!state) {
        return;
      }
      state.track.rebase(deltaLocal);
      if (state.lastPresented) {
        const worldDelta = qRotate(state.lastPresented.rotation, deltaLocal);
        state.lastPresented.position = vAdd(state.lastPresented.position, worldDelta);
      }
    };
  }

  /** Bootstraps applied this session; a forced resync bumps it on arrival. */
  bootstrapCount = 0;

  /** Ask the server for a fresh bootstrap (measurement / recovery). */
  requestResync(): void {
    this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
  }

  /**
   * Bodies needing a one-shot instance rewrite, drained by the render layer
   * each frame. `all` after a bootstrap/resync (the whole ledger was replaced).
   */
  /**
   * Wire v3: one wasm call fills the pose buffers for every live lane; lanes
   * map to entities through the reliable assignment stream, and poses land in
   * the same ledger slot the v2 path writes. Chains a lost packet poisoned are
   * drained here and nacked upstream, so the heal cost tracks actual loss.
   */
  private sampleDebris(renderTick: number, live: Set<number>): Set<number> {
    const debris = this.debris;
    if (debris === null) {
      return live;
    }
    // The client's interpolation delay, applied exactly as the harness did.
    const sampleTick = Math.max(0, Math.floor(renderTick) - 6);
    if (debris.lane_count() > this.sampleLanes.length) {
      this.sampleLanes = new Uint32Array(this.sampleLanes.length * 2);
      this.samplePoses = new Float32Array(this.sampleLanes.length * 7);
    }
    const filled = debris.sample_into(sampleTick, this.sampleLanes, this.samplePoses);
    for (let index = 0; index < filled; index += 1) {
      const entity = this.laneToEntity.get(this.sampleLanes[index]);
      if (entity === undefined) {
        continue;
      }
      const at = index * 7;
      this.topology.updateBodyPose(
        entity,
        [this.samplePoses[at], this.samplePoses[at + 1], this.samplePoses[at + 2]],
        [
          this.samplePoses[at + 3],
          this.samplePoses[at + 4],
          this.samplePoses[at + 5],
          this.samplePoses[at + 6],
        ],
        'presented',
      );
      live.add(entity);
    }
    const poisoned = debris.drain_poisoned();
    if (poisoned.length > 0) {
      const entities: number[] = [];
      for (const lane of poisoned) {
        const entity = this.laneToEntity.get(lane);
        if (entity !== undefined) {
          entities.push(entity);
        }
      }
      if (entities.length > 0) {
        this.sendResync(encodeCityNack(entities));
      }
    }
    return live;
  }

  drainRepaint(): { all: boolean; bodies: number[] } {
    const all = this.repaintAll;
    const bodies = all ? [] : [...this.repaintBodies];
    this.repaintAll = false;
    this.repaintBodies.clear();
    return { all, bodies };
  }

  /** Route one raw server packet (kind 119-122). */
  handlePacket(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    this.bytesReceived += bytes.length;
    const now = performance.now();
    this.bytesWindow.push({ at: now, bytes: bytes.length });
    while (this.bytesWindow.length > 0 && now - this.bytesWindow[0].at > 2000) {
      this.bytesWindow.shift();
    }
    switch (bytes[0]) {
      case PKT_CITY_CHUNKS:
        // A v3 match never ranks poses per client; any stray v2 datagram
        // (e.g. from a mid-deploy server) is ignored rather than mixed in.
        if (this.debris === null) {
          this.handleChunks(decodeChunksDatagram(bytes));
        }
        break;
      case PKT_CITY_DEBRIS: {
        if (this.debris === null) {
          break;
        }
        const started = performance.now();
        const header = decodeDebrisHeader(bytes);
        if (header.spanTick > this.latestSimTick) {
          this.latestSimTick = header.spanTick;
          this.latestSimTickAtMs = performance.now();
        }
        try {
          this.recordsApplied += this.debris.push_payload(
            header.compression,
            bytes.subarray(header.bodyOffset),
          );
        } catch (error) {
          // A malformed datagram is dropped like a lost one; the nack loop
          // and restatement heal whatever it carried.
          recordCityEvent('city_suspect_record', { error: String(error) });
        }
        this.datagramsReceived += 1;
        this.decodeMsWindow.push(performance.now() - started);
        if (this.decodeMsWindow.length > 240) {
          this.decodeMsWindow.shift();
        }
        break;
      }
      case PKT_CITY_LANES: {
        for (const [lane, entity] of decodeCityLanes(bytes)) {
          const previous = this.laneToEntity.get(lane);
          if (previous !== undefined && previous !== entity) {
            this.entityToLane.delete(previous);
            // A recycled lane must not inherit its previous tenant's
            // trajectory (66.8 m single-frame teleports in netlab).
            this.debris?.clear_lane_until(lane, this.latestSimTick);
          }
          this.laneToEntity.set(lane, entity);
          this.entityToLane.set(entity, lane);
        }
        break;
      }
      case PKT_CITY_TOPOLOGY: {
        // The server sends a bootstrap to every joiner before any topology.
        // If topology arrives first, the bootstrap was dropped or lost — and
        // accepting the stream anyway would silently run an INTACT ledger:
        // every pre-join fracture invisible, settled islands never streaming
        // again to correct it. The first live message is the only evidence,
        // so it triggers the resync instead of being applied.
        if (!this.bootstrapped) {
          if (!this.resyncRequested) {
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          }
          break;
        }
        const message = decodeTopology(bytes);
        // Read where the chunks about to be re-parented are drawn, before the
        // ledger moves them.
        this.captureDrawnPoses(message);
        const applied = this.topology.apply(message);
        if (applied) {
          this.seedPromotions(message);
          for (const batch of message.batches) {
            for (const promotion of batch.promotions) {
              this.repaintBodies.add(bodyKey(promotion.structureId, promotion.islandId));
            }
            for (const migration of batch.migrations) {
              this.repaintBodies.add(bodyKey(batch.structureId, migration.fromIslandSerial));
              this.repaintBodies.add(bodyKey(batch.structureId, migration.toIslandSerial));
            }
          }
          for (const settle of message.settled) {
            this.repaintBodies.add(bodyKey(settle.structureId, settle.islandId));
          }
          for (const wake of message.wakes) {
            this.repaintBodies.add(bodyKey(wake.structureId, wake.islandSerial));
          }
          // Settle closes tracks.
          for (const settle of message.settled) {
            const key = bodyKey(settle.structureId, settle.islandId);
            this.bodies.delete(key);
            // Dropping the track also drops its per-body staleness guard, so
            // without this a pre-settle datagram still in flight would look
            // new, overwrite the authoritative rest pose, and stick -- the
            // body is asleep, so no later update ever corrects it. The guard
            // is deliberately NOT cleared on wake: a settle tick only ever
            // moves forward, so it keeps rejecting genuinely older records
            // while letting every post-wake record through.
            this.settledAtTick.set(key, message.simTick);
            // Wire v3: the reliable settle owns the pose from here; an
            // in-flight span must not resurrect the body with stale physics.
            const lane = this.entityToLane.get(key);
            if (lane !== undefined) {
              this.debris?.clear_lane_until(lane, message.simTick);
            }
          }
          // A retired island will never stream again; without this its track
          // is sampled for the rest of the match.
          for (const batch of message.batches) {
            for (const islandId of batch.retiredIslandIds) {
              const key = bodyKey(batch.structureId, islandId);
              this.bodies.delete(key);
              this.settledAtTick.delete(key);
              const lane = this.entityToLane.get(key);
              if (lane !== undefined) {
                this.debris?.clear_lane_until(lane, message.simTick);
                this.entityToLane.delete(key);
                this.laneToEntity.delete(lane);
              }
            }
          }
          this.drainPending();
        }
        // Checked independently of `applied`: a successful apply still sets
        // this when a migration names an island the client does not have, and
        // that chunk stays on the wrong body until a bootstrap replaces it.
        if (this.topology.needsResync && !this.resyncRequested) {
          this.resyncRequested = true;
          this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
        }
        break;
      }
      case PKT_CITY_BASELINE:
        this.handleBaseline(decodeBaseline(bytes));
        break;
      case PKT_CITY_BOOTSTRAP: {
        const message = decodeBootstrap(bytes);
        this.topology.applyBootstrap(message);
        this.bodies.clear();
        this.pendingRecords = [];
        this.settledAtTick.clear();
        this.baselineGenerations.clear();
        this.resyncRequested = false;
        this.bootstrapped = true;
        this.bootstrapCount += 1;
        this.repaintAll = true;
        this.repaintBodies.clear();
        // Bootstrap names the generation in flight. Recording it (empty) means
        // the parts that follow accumulate into it rather than being treated
        // as a rollover that discards what came before.
        this.baselineId = message.baselineId;
        this.baselineGenerations.set(message.baselineId, new Map());
        break;
      }
      default:
        break;
    }
  }

  private handleBaseline(message: BaselineMessage): void {
    let poses = this.baselineGenerations.get(message.baselineId);
    if (!poses) {
      poses = new Map();
      this.baselineGenerations.set(message.baselineId, poses);
      this.baselineId = message.baselineId;
      // Retire by age, not on arrival of a newer generation: the one being
      // replaced still has deltas in flight against it.
      while (this.baselineGenerations.size > 2) {
        const oldest = this.baselineGenerations.keys().next();
        if (oldest.done) {
          break;
        }
        this.baselineGenerations.delete(oldest.value);
      }
    }
    for (const record of message.records) {
      poses.set(record.bodyEntity, record.position);
    }
  }

  private handleChunks(datagram: ChunksDatagram): void {
    this.datagramsReceived += 1;
    // Re-anchoring the clock on a datagram that did not advance the tick --
    // a reordered packet, or the 2nd..Nth of one tick's MTU-split burst --
    // walks render time backwards, which `PresentationTrack.sample` is
    // documented not to accept. Advance the anchor only with the tick.
    if (datagram.simTick > this.latestSimTick) {
      this.latestSimTick = datagram.simTick;
      this.latestSimTickAtMs = performance.now();
    }
    let deferred = false;
    for (const record of datagram.records) {
      if (!this.applyRecord(datagram, record)) {
        deferred = true;
      }
    }
    if (deferred) {
      // Keep the datagram briefly; topology for a fresh promotion may still
      // be in flight on the reliable stream.
      this.pendingRecords.push(datagram);
      if (this.pendingRecords.length > 64) {
        this.pendingRecords.shift();
      }
    }
  }

  private drainPending(): void {
    if (this.pendingRecords.length === 0) {
      return;
    }
    const pending = this.pendingRecords;
    this.pendingRecords = [];
    for (const datagram of pending) {
      for (const record of datagram.records) {
        this.applyRecord(datagram, record);
      }
    }
  }

  /** Creates and registers a body's presentation track. */
  private createBodyState(key: number): BodyStreamState {
    const track = new PresentationTrack(presentationConfig60Hz());
    if (isRecording()) {
      track.setAnomalyListener((anomaly) => {
        recordCityEvent(
          anomaly.kind === 'clock_rollback'
            ? 'city_clock_rollback'
            : anomaly.kind === 'correction_snap'
              ? 'city_snap'
              : 'city_implausible_jump',
          {
            body: key,
            magnitude: anomaly.magnitude,
            ...(anomaly.abandonedCorrectionM !== undefined
              ? { abandonedCorrectionM: anomaly.abandonedCorrectionM }
              : {}),
          },
        );
      });
    }
    const state: BodyStreamState = { track, lastTick: 0, settledHint: false };
    this.bodies.set(key, state);
    return state;
  }

  /**
   * Opens a presentation track for every island a fracture just created,
   * anchored to where its chunks are already on screen.
   *
   * Without this a promoted island has no track until its first datagram, so
   * `samplePresentation` never visits it, the render layer never marks it
   * dirty, and its chunks keep the pose of the body they broke off until a
   * record lands -- at which point they jump. Seeding turns that jump into the
   * same bounded glide a late packet gets.
   */
  private seedPromotions(message: TopologyMessage): void {
    if (this.latestSimTickAtMs === 0) {
      // Nothing has been drawn yet, so there is no on-screen pose to hold.
      return;
    }
    const renderTick =
      this.latestSimTick + ((performance.now() - this.latestSimTickAtMs) / 1000) * 60;
    for (const batch of message.batches) {
      for (const promotion of batch.promotions) {
        const key = bodyKey(promotion.structureId, promotion.islandId);
        if (this.bodies.has(key)) {
          // Serial reuse: the existing track reconciles this the usual way.
          continue;
        }
        const body = this.topology.body(key);
        if (!body || body.chunkSlots.length === 0) {
          continue;
        }
        // Solve for the body pose that leaves the anchor chunk exactly where
        // it is being drawn: worldPose = bodyPos + R * localOffset.
        const anchor = body.chunkSlots[0];
        const drawn = this.drawnChunkPose.get(anchor);
        if (!drawn) {
          continue;
        }
        const local = this.topology.chunkLocalOffset(anchor).position;
        const seedRotation = drawn.rotation;
        const worldOffset = qRotate(seedRotation, local);
        const state = this.createBodyState(key);
        state.track.seedPresented(
          {
            position: [
              drawn.position[0] - worldOffset[0],
              drawn.position[1] - worldOffset[1],
              drawn.position[2] - worldOffset[2],
            ],
            rotation: seedRotation,
            linearVelocity: promotion.linearVelocity,
            angularVelocity: promotion.angularVelocity,
          },
          renderTick,
        );
        state.track.push({
          tick: message.simTick,
          position: promotion.position,
          rotation: promotion.rotation,
          linearVelocity: promotion.linearVelocity,
          angularVelocity: promotion.angularVelocity,
          class: PresentationClass.Ballistic,
        });
        state.lastTick = message.simTick;
        if (isRecording()) {
          const seedDelta = Math.hypot(
            drawn.position[0] - worldOffset[0] - promotion.position[0],
            drawn.position[1] - worldOffset[1] - promotion.position[1],
            drawn.position[2] - worldOffset[2] - promotion.position[2],
          );
          recordCityEvent('city_seed', {
            body: key,
            simTick: message.simTick,
            renderTick,
            seedDeltaM: seedDelta,
            members: body.chunkSlots.length,
            speed: Math.hypot(
              promotion.linearVelocity[0],
              promotion.linearVelocity[1],
              promotion.linearVelocity[2],
            ),
          });
        }
      }
    }
  }

  /**
   * Where each chunk about to be re-parented is currently drawn, captured
   * before the ledger changes. Reused across the topology branch only.
   */
  private readonly drawnChunkPose = new Map<number, { position: Vec3; rotation: Quat }>();

  private captureDrawnPoses(message: TopologyMessage): void {
    this.drawnChunkPose.clear();
    if (this.latestSimTickAtMs === 0) {
      return;
    }
    for (const batch of message.batches) {
      for (const promotion of batch.promotions) {
        for (const node of promotion.nodes) {
          const slot = this.topology.slotOf(promotion.structureId, node);
          if (this.drawnChunkPose.has(slot)) {
            continue;
          }
          const pose = this.topology.chunkWorldPose(slot);
          this.drawnChunkPose.set(slot, {
            position: [pose.position[0], pose.position[1], pose.position[2]],
            rotation: [...pose.rotation] as Quat,
          });
        }
      }
    }
  }

  private applyRecord(
    datagram: ChunksDatagram,
    record: ChunksDatagram['records'][number],
  ): boolean {
    const body = this.topology.body(record.bodyEntity);
    if (!body) {
      this.recordsBuffered += 1;
      return false;
    }
    // The settle arrived on the reliable channel carrying the authoritative
    // rest pose; anything the unreliable stream produced at or before that
    // tick is older news, whether it arrives late or gets replayed from the
    // pending buffer.
    const settledAt = this.settledAtTick.get(record.bodyEntity);
    if (settledAt !== undefined && datagram.simTick <= settledAt) {
      return true;
    }
    let position: Vec3;
    if (record.mode === RecordMode.Delta || record.mode === RecordMode.MotionDelta) {
      const generation = this.baselineGenerations.get(datagram.baselineId);
      if (!generation) {
        return true; // stale/unknown baseline generation — drop, absolutes recover
      }
      const baseline = generation.get(record.bodyEntity);
      if (!baseline) {
        return true;
      }
      position = [
        baseline[0] + record.position[0],
        baseline[1] + record.position[1],
        baseline[2] + record.position[2],
      ];
    } else {
      position = record.position;
    }

    let state = this.bodies.get(record.bodyEntity);
    if (!state) {
      state = this.createBodyState(record.bodyEntity);
    }
    if (datagram.simTick <= state.lastTick) {
      return true; // stale reordered datagram — latest wins
    }
    state.lastTick = datagram.simTick;
    state.settledHint = (record.flags & RECORD_FLAG_SETTLED_HINT) !== 0;
    const snapshot: MotionSnapshot = {
      tick: datagram.simTick,
      position,
      rotation: record.rotation,
      linearVelocity: record.linearVelocity,
      angularVelocity: record.angularVelocity,
      class:
        record.mode === RecordMode.Ballistic
          ? PresentationClass.Ballistic
          : PresentationClass.ContactActive,
    };
    state.track.push(snapshot);
    if (isCitySuspect(record.bodyEntity)) {
      recordCityEvent('city_suspect_record', {
        body: record.bodyEntity,
        tick: datagram.simTick,
        mode: record.mode,
        x: position[0],
        y: position[1],
        z: position[2],
        vx: record.linearVelocity[0],
        vy: record.linearVelocity[1],
        vz: record.linearVelocity[2],
      });
    }
    // Placeholder only: a body that has never been sampled needs SOME ledger
    // pose or its chunks compose against garbage. Once presentation owns the
    // body, writing the raw pose here puts a value ~one interpolation delay
    // AHEAD of everything drawn around it into the shared slot, and whenever
    // that write survives to draw time the chunk visibly leads its island and
    // snaps back — measured live as ~1.7 m alternation at datagram cadence on
    // a perfectly smooth wire trajectory.
    if (!state.lastPresented) {
      this.topology.updateBodyPose(record.bodyEntity, position, record.rotation, 'raw');
    }
    this.recordsApplied += 1;
    return true;
  }

  /**
   * Sample every streaming body at the current render time and push the
   * presented pose into the ledger. Returns the set of body keys with live
   * presentation (the render layer recomposes those chunks each frame).
   */
  /**
   * Returns the bodies that actually moved this frame.
   *
   * Every body is sampled, but a body whose presented pose has not changed is
   * left out of the returned set, so the render layer writes it once more and
   * then stops touching it. Previously every body ever created was reported
   * live every frame: the renderer's dirty set only drops a body when it is
   * absent from this set, so nothing was ever dropped and each frame
   * re-composed the matrix and colour of every chunk of every island in the
   * match. Frame time grew with cumulative destruction and never recovered
   * (measured: 16.7 ms -> 333 ms after four towers, still 333 ms once
   * everything had settled).
   *
   * Tracks are normally closed by SETTLE events, but a body the server never
   * settles must not cost anything per frame either.
   */
  samplePresentation(nowMs: number): Set<number> {
    const live = new Set<number>();
    if (this.latestSimTickAtMs === 0) {
      return live;
    }
    // Render tick estimate: latest known sim tick + elapsed since it arrived.
    const renderTick = this.latestSimTick + ((nowMs - this.latestSimTickAtMs) / 1000) * 60;
    if (this.debris !== null) {
      return this.sampleDebris(renderTick, live);
    }
    for (const [key, state] of this.bodies) {
      const presented = state.track.sample(renderTick);
      const previous = state.lastPresented;
      if (
        previous
        && Math.abs(previous.position[0] - presented.position[0]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.position[1] - presented.position[1]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.position[2] - presented.position[2]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[0] - presented.rotation[0]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[1] - presented.rotation[1]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[2] - presented.rotation[2]) < PRESENTATION_EPSILON_M
        && Math.abs(previous.rotation[3] - presented.rotation[3]) < PRESENTATION_EPSILON_M
      ) {
        continue;
      }
      state.lastPresented = {
        position: [presented.position[0], presented.position[1], presented.position[2]],
        rotation: [
          presented.rotation[0],
          presented.rotation[1],
          presented.rotation[2],
          presented.rotation[3],
        ],
      };
      this.topology.updateBodyPose(key, presented.position, presented.rotation, 'presented');
      live.add(key);
    }
    return live;
  }

  stats(): CityClientStats {
    const topologyStats = this.topology.stats();
    let windowBytes = 0;
    for (const entry of this.bytesWindow) {
      windowBytes += entry.bytes;
    }
    const windowSeconds =
      this.bytesWindow.length > 1
        ? (this.bytesWindow[this.bytesWindow.length - 1].at - this.bytesWindow[0].at) / 1000
        : 0;
    let chunksAwake = 0;
    let chunksSettled = 0;
    for (const body of this.topology.allBodies()) {
      if (body.islandSerial === 0) {
        continue;
      }
      if (body.settled) {
        chunksSettled += body.chunkSlots.length;
      } else {
        chunksAwake += body.chunkSlots.length;
      }
    }
    return {
      chunksTotal: this.topology.chunkCount,
      chunksAwake,
      chunksSettled,
      brokenBonds: topologyStats.brokenBonds,
      liveIslands: topologyStats.liveIslands,
      topoSeqGaps: topologyStats.topoSeqGaps,
      orphanedChunks: topologyStats.orphanedChunks,
      orphanedByRetire: topologyStats.orphanedByRetire,
      datagramsReceived: this.datagramsReceived,
      recordsApplied: this.recordsApplied,
      wireVersion: this.debris === null ? 2 : 3,
      recordsBuffered: this.recordsBuffered,
      bytesReceived: this.bytesReceived,
      bytesPerSecond: windowSeconds > 0.25 ? windowBytes / windowSeconds : 0,
      manifestHash: this.manifest.hashHex,
    };
  }
}

export type { Vec3, Quat };
