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
import { CityTopology, bodyKey, bodyKeyParts } from './topology';
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
  decodeStructureBootstrap,
  decodeTopology,
  decodeTopologyHashes,
  encodeCityResyncRequest,
  decodeCityLanes,
  decodeDebrisHeader,
  encodeCityNack,
  PKT_CITY_LANES,
  PKT_CITY_STRUCTURE_BOOTSTRAP,
  PKT_CITY_TOPO_HASH,
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
import { noteBaseline, noteClientEvent } from './debugReport';
import { addDecodeMs } from './renderStats';

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
  /// Ledger rebuilds this session. Each one is a full restatement of the
  /// world; a climbing count means the client keeps losing agreement with the
  /// server and asking for a fresh copy.
  bootstraps: number;
  /** Seq-aligned ledger-hash comparisons that actually ran. */
  hashChecks: number;
  /** Comparisons that found divergence — the detector firing. */
  hashMismatches: number;
  /** Targeted per-structure repairs applied (vs full bootstraps). */
  structureRepairs: number;
  /// Settles refused because their pose would have teleported the body --
  /// membership disagreement, caught before it could be drawn.
  settleRejects: number;
  /// Topology released by the wall-clock valve, ahead of the pose clock.
  valveApplies: number;
  valveTicksAhead: number;
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

/**
 * Minimum spacing between resync requests.
 *
 * A resync rebuilds the entire ledger, so it is the heaviest repair available
 * and must not be driven at the rate faults are discovered. One bootstrap
 * repairs every outstanding fault at once, so spacing them loses nothing but
 * time.
 */
const RESYNC_MIN_INTERVAL_MS = 3000;

export class CityClient {
  readonly topology: CityTopology;
  private readonly bodies: Map<number, BodyStreamState> = new Map();
  /**
   * Bodies whose next sample might move something -- the per-frame walk.
   *
   * `samplePresentation` used to walk EVERY body every frame, and in a
   * demolished city that is thousands of quiescent islands re-proving each
   * frame that they have not moved: ~2.5 ms of the M3's frame in the
   * post-demolition steady state. A body leaves this set when its track's
   * sample takes the settled fast-path (see `PresentationTrack.lastSampleSettled`
   * for why that is a proof, not a heuristic), and re-enters on exactly the
   * events that can make it move again: a datagram record, or track creation.
   * Settles and retires delete the body outright, which also removes it here.
   */
  private readonly kinetic = new Set<number>();
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
  /** Measured server tick rate (ticks per wall second). The server sheds
   *  sim rate under load (60 -> 20 Hz at heavy demolition); extrapolating
   *  the render clock at a hardcoded 60 made the clock outrun tick
   *  production and snap back ~10 ticks on every re-anchor -- visible as
   *  rubber-banding of flying debris whenever the sim was below 60 Hz. */
  private tickRateEma = 60;
  /** Continuous render clock (tick units); follows the extrapolated anchor
   *  with a ~0.5 s pull so per-packet anchor jitter never steps it. */
  private renderClockTick = -1;
  private renderClockMs = 0;
  /** Wire v3: the wasm debris decoder; null means this match speaks v2. */
  private readonly debris: DebrisDecoder | null;
  private readonly simHz: number;
  /** Wire v3: lane -> body entity, from the reliable PKT_CITY_LANES stream. */
  private readonly laneToEntity: Map<number, number> = new Map();
  private readonly entityToLane: Map<number, number> = new Map();
  /** Previous sampled position per entity (netlab jump diagnostics only). */
  private readonly lastSamplePos: Map<number, [number, number, number]> = new Map();
  /**
   * Wire v3: topology messages held until the debris sample clock reaches
   * their tick, so ledger basis (membership, island COM) and sampled poses
   * describe the same instant. Drained by `sampleDebris`.
   */
  private readonly pendingTopology: { message: TopologyMessage; receivedAtMs: number }[] = [];
  /**
   * Observed span cadence in ticks (EMA of consecutive datagram spanTick
   * deltas). The sampling delay must cover one full flush window plus
   * interpolation margin: the governor stretches flush toward 250 ms under
   * load, and a client still sampling at a fixed 100 ms delay would run
   * ahead of the data and stutter -- the latency the governor spends has to
   * be spent HERE, visibly and smoothly.
   */
  private spanTicksEma = 6;
  private lastSpanTick = -1;
  /**
   * The delay actually applied, slewed toward the target at a bounded rate.
   * Stepping it integerly made the sample clock jump N ticks in one frame --
   * every moving body teleported by delay-delta x velocity simultaneously
   * (measured: 1.4-2.3 m excess steps at each governor transition). Slewing
   * at 0.05 ticks/frame spreads a 100 ms change over ~2 s of imperceptible
   * clock drift.
   */
  private sampleDelaySmooth = 6;
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
  private lastResyncAtMs = -1e9;
  /// Resyncs skipped by the rate limit. Each one is a full world rebuild that
  /// did not happen; the next one repairs whatever they would have.
  resyncsSuppressed = 0;
  /** Seq-aligned hash comparisons performed (the detector actually ran). */
  hashChecks = 0;
  /** Comparisons that found at least one structure diverged. */
  hashMismatches = 0;
  /** Targeted per-structure repairs applied. */
  structureRepairs = 0;
  /**
   * Topology messages released by the wall-clock valve rather than by the
   * sample clock reaching their tick, and how far ahead they were.
   *
   * The valve exists so a stalled pose clock cannot delay fracture forever,
   * but anything it releases is applied AHEAD of the poses on screen, so its
   * absolute poses land as a jump. Non-zero means the pose clock is not
   * keeping up with the reliable channel.
   */
  topologyValveApplies = 0;
  topologyValveTicksAhead = 0;
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
  /** Fold a newest-seen sim tick into the anchor and the tick-rate EMA. */
  private observeSimTick(tick: number): void {
    const now = performance.now();
    if (this.latestSimTickAtMs > 0) {
      const dtS = (now - this.latestSimTickAtMs) / 1000;
      const rate = (tick - this.latestSimTick) / Math.max(1e-3, dtS);
      if (rate > 0.5 && rate < 240) {
        this.tickRateEma += (rate - this.tickRateEma) * 0.1;
      }
    }
    this.latestSimTick = tick;
    this.latestSimTickAtMs = now;
  }

  /** The render clock: the newest-tick anchor extrapolated at the MEASURED
   *  tick rate, followed through a bounded pull. A >2 s discontinuity
   *  (join, reset, resync) snaps. */
  private renderTickNow(nowMs: number): number {
    const raw =
      this.latestSimTick + ((nowMs - this.latestSimTickAtMs) / 1000) * this.tickRateEma;
    if (this.renderClockTick < 0 || Math.abs(raw - this.renderClockTick) > 120) {
      this.renderClockTick = raw;
    } else {
      const dt = Math.max(0, (nowMs - this.renderClockMs) / 1000);
      const error = raw - this.renderClockTick;
      this.renderClockTick += dt * this.tickRateEma + error * Math.min(1, dt * 2);
    }
    this.renderClockMs = nowMs;
    return this.renderClockTick;
  }

  private sampleDebris(renderTick: number, live: Set<number>): Set<number> {
    const debris = this.debris;
    if (debris === null) {
      return live;
    }
    // Sampling delay = one observed flush window + interpolation margin, so
    // the sample clock never outruns the span the encoder is still filling.
    // Floor of 6 ticks preserves the fixed-flush behaviour exactly; the
    // applied delay slews toward the target so the clock never jumps.
    const targetDelay = Math.max(6, Math.ceil(this.spanTicksEma) + 3);
    const step = 0.05;
    if (this.sampleDelaySmooth < targetDelay) {
      this.sampleDelaySmooth = Math.min(targetDelay, this.sampleDelaySmooth + step);
    } else if (this.sampleDelaySmooth > targetDelay) {
      this.sampleDelaySmooth = Math.max(targetDelay, this.sampleDelaySmooth - step);
    }
    const sampleTick = Math.max(0, Math.floor(renderTick - this.sampleDelaySmooth));
    // Apply held topology whose tick the sample clock has reached, so a
    // migration's basis change lands in the same frame as the poses that
    // were simulated under it. The wall-clock valve keeps a stalled sample
    // clock (everything parked, no datagrams) from delaying fracture forever.
    const nowMs = performance.now();
    while (this.pendingTopology.length > 0) {
      const head = this.pendingTopology[0];
      if (head.message.simTick > sampleTick && nowMs - head.receivedAtMs < 1000) {
        break;
      }
      // Count the valve firing SEPARATELY from an on-time apply. A message
      // released by the valve is applied ahead of the pose clock, so every
      // absolute pose it carries -- settles especially -- states where a body
      // will be, not where this client is drawing it. For fast debris that is
      // metres per released tick.
      if (head.message.simTick > sampleTick) {
        this.topologyValveApplies += 1;
        this.topologyValveTicksAhead += head.message.simTick - sampleTick;
      }
      this.pendingTopology.shift();
      this.applyTopologyMessage(head.message);
    }
    if (debris.lane_count() > this.sampleLanes.length) {
      this.sampleLanes = new Uint32Array(this.sampleLanes.length * 2);
      this.samplePoses = new Float32Array(this.sampleLanes.length * 7);
    }
    const filled = debris.sample_into(sampleTick, this.sampleLanes, this.samplePoses);
    for (let index = 0; index < filled; index += 1) {
      const lane = this.sampleLanes[index];
      const entity = this.laneToEntity.get(lane);
      if (entity === undefined) {
        continue;
      }
      // Only the entity's current lane may write it. A lane whose records
      // raced ahead of its reliable reassignment, or a stale mapping left by
      // a lane move, would otherwise apply another body's trajectory here.
      if (this.entityToLane.get(entity) !== lane) {
        continue;
      }
      // A settled body is owned by the reliable channel, which carried the
      // authoritative rest pose. The v2 record path has always enforced this
      // (see applyRecord); v3 did not, and v3 is where it matters most,
      // because a parked lane stays SAMPLABLE indefinitely by design. So
      // every frame after a settle the sampled pose overwrote the settled
      // one, the next reliable message put it back, and the body oscillated
      // between the two -- measured as 118 settle disagreements and a 151 m
      // worst displacement per collapse on v3, against 0 and 2.4 m on v2.
      //
      // `clear_lane_until` already tries to stop this at the decoder, but it
      // is conditional on the lane maps agreeing; this is the guard at the
      // point of use, where correctness does not depend on that bookkeeping.
      const settledAt = this.settledAtTick.get(entity);
      if (settledAt !== undefined && sampleTick <= settledAt) {
        continue;
      }
      const at = index * 7;
      // Epoch ordering in the decoder now guarantees a lane's samples belong
      // to its current tenant; the 5 m discontinuity hold that used to guard
      // this spot is gone with it. The jump detector stays as an instrument:
      // any large step it reports is now a REAL defect, not a race.
      if (isRecording()) {
        const prev = this.lastSamplePos.get(entity);
        if (prev) {
          const jump = Math.hypot(
            this.samplePoses[at] - prev[0],
            this.samplePoses[at + 1] - prev[1],
            this.samplePoses[at + 2] - prev[2],
          );
          if (jump > 1.0) {
            recordCityEvent('city_sample_jump', {
              body: entity,
              lane,
              stepM: jump,
              sampleTick,
              prev,
              next: [this.samplePoses[at], this.samplePoses[at + 1], this.samplePoses[at + 2]],
              history: Array.from(debris.lane_history(lane)),
            });
          }
        }
        this.lastSamplePos.set(entity, [
          this.samplePoses[at],
          this.samplePoses[at + 1],
          this.samplePoses[at + 2],
        ]);
      }
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
          this.observeSimTick(header.spanTick);
        }
        try {
          if (this.lastSpanTick >= 0 && header.spanTick > this.lastSpanTick) {
            const delta = header.spanTick - this.lastSpanTick;
            if (delta <= 32) {
              this.spanTicksEma = 0.9 * this.spanTicksEma + 0.1 * delta;
            }
          }
          if (header.spanTick > this.lastSpanTick) {
            this.lastSpanTick = header.spanTick;
          }
          this.recordsApplied += this.debris.push_payload(
            header.compression,
            header.epoch,
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
        const { epoch, entries } = decodeCityLanes(bytes);
        for (const [lane, entity] of entries) {
          const previous = this.laneToEntity.get(lane);
          if (previous !== undefined && previous !== entity) {
            this.entityToLane.delete(previous);
            this.lastSamplePos.delete(previous);
            this.lastSamplePos.delete(entity);
            // Epoch ordering makes lane reuse SOUND: the decoder refuses
            // records from packets stamped before this assignment (the old
            // tenant's), and accepts the new tenant's even when they raced
            // ahead of this reliable message. This replaced a 5 m
            // discontinuity heuristic, a 12-tick hold, and a nack-heal
            // round trip.
            this.debris?.assign_lane(lane, epoch);
          } else if (previous === undefined) {
            // Fresh lane: same rule, so a late packet from a lost earlier
            // tenancy can never leak through.
            this.debris?.assign_lane(lane, epoch);
          }
          // The entity's old lane must stop writing it too: a parked Rest
          // holds a samplable pose indefinitely, so a stale lane->entity
          // entry keeps fighting the new lane every frame.
          const previousLane = this.entityToLane.get(entity);
          if (previousLane !== undefined && previousLane !== lane) {
            this.laneToEntity.delete(previousLane);
            this.debris?.clear_lane_until(previousLane, this.latestSimTick);
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
        // Wire v3: the ledger must not run ahead of the pose stream. Sampled
        // poses are read at renderTick-6, so applying a migration's new
        // membership/COM immediately would compose 100 ms of old-basis poses
        // against the new basis -- measured as meter-scale per-frame chunk
        // teleports. Queue the message and apply it when the sample clock
        // reaches its tick (sampleDebris drains this every frame).
        if (this.debris !== null) {
          this.pendingTopology.push({ message, receivedAtMs: performance.now() });
          break;
        }
        this.applyTopologyMessage(message);
        break;
      }
      case PKT_CITY_BASELINE:
        this.handleBaseline(decodeBaseline(bytes));
        break;
      case PKT_CITY_BOOTSTRAP: {
        const message = decodeBootstrap(bytes);
        this.topology.applyBootstrap(message);
        this.bodies.clear();
        this.kinetic.clear();
        this.pendingRecords = [];
        // Drop every held topology message. A bootstrap is a complete state
        // snapshot, so anything queued before it is stale by construction --
        // and comparing sequence numbers across it is WRONG, because a city
        // reset rebuilds the encoder and restarts the sequence at zero. That
        // comparison (added with the topology hold-back) kept 75 messages of
        // the DESTROYED world, which drained after the bootstrap and dragged
        // lastTopoSeq back up; every message of the fresh world then looked
        // like a duplicate and was silently discarded. The city rendered
        // intact and no shot ever changed it again. Messages that genuinely
        // postdate the bootstrap arrive after it on the ordered reliable
        // channel; the seq-gap resync path covers the same-tick race.
        this.pendingTopology.length = 0;
        // A bootstrap means the world was REPLACED (join, resync, or a city
        // reset). Every lane-keyed thing describes the old world: the server
        // rebuilds its encoder, so lane ids restart from zero and its epoch
        // restarts with them. Keeping the old map silently routes the new
        // world's poses to bodies that no longer exist -- the city renders
        // intact and nothing ever moves again, which is exactly how a reset
        // after heavy damage failed in play.
        this.laneToEntity.clear();
        this.entityToLane.clear();
        this.lastSamplePos.clear();
        this.debris?.reset_all_lanes();
        // Pose-stream clocks belong to the old world too.
        this.lastSpanTick = -1;
        this.spanTicksEma = 6;
        this.sampleDelaySmooth = 6;
        this.renderClockTick = -1;
        this.settledAtTick.clear();
        this.baselineGenerations.clear();
        this.resyncRequested = false;
        this.bootstrapped = true;
        this.bootstrapCount += 1;
        noteClientEvent('bootstrap', { topoSeq: message.topoSeq, simTick: message.simTick });
        this.repaintAll = true;
        this.repaintBodies.clear();
        // Bootstrap names the generation in flight. Recording it (empty) means
        // the parts that follow accumulate into it rather than being treated
        // as a rollover that discards what came before.
        this.baselineId = message.baselineId;
        this.baselineGenerations.set(message.baselineId, new Map());
        break;
      }
      case PKT_CITY_TOPO_HASH: {
        if (!this.bootstrapped) {
          break;
        }
        const message = decodeTopologyHashes(bytes);
        // Only compare at the position the hashes describe. During a cascade
        // (or the v3 hold-back) our applied seq lags the message's and the
        // comparison would be meaningless — the detector targets STEADY
        // divergence, which quiet periods expose within one interval.
        if (message.topoSeq !== this.topology.lastSeq()) {
          break;
        }
        this.hashChecks += 1;
        const local = this.topology.structureHashes();
        const mismatched: number[] = [];
        for (const entry of message.hashes) {
          const ours = local.get(entry.structureId);
          if (ours && (ours.laneA !== entry.laneA || ours.laneB !== entry.laneB)) {
            mismatched.push(entry.structureId);
          }
        }
        if (mismatched.length > 0) {
          this.hashMismatches += 1;
          noteClientEvent('hashMismatch', { structures: mismatched, topoSeq: message.topoSeq });
          const nowMs = performance.now();
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq(), mismatched));
          } else {
            this.resyncsSuppressed += 1;
          }
        }
        break;
      }
      case PKT_CITY_STRUCTURE_BOOTSTRAP: {
        if (!this.bootstrapped) {
          break;
        }
        const message = decodeStructureBootstrap(bytes);
        // The repair restates content at a seq, so the ledger must BE at that
        // seq. Held v3 messages are applied now — a one-frame basis jump on a
        // repair beats comparing state across different positions.
        while (this.pendingTopology.length > 0) {
          this.applyTopologyMessage(this.pendingTopology.shift()!.message);
        }
        if (message.topoSeq !== this.topology.lastSeq()) {
          // A real gap opened between request and repair; only the full path
          // can recover the stream position itself.
          if (!this.resyncRequested) {
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          }
          break;
        }
        this.topology.applyStructureBootstrap(message);
        noteClientEvent('structureRepair', {
          topoSeq: message.topoSeq,
          structures: message.structures.map((structure) => structure.structureId),
        });
        const repaired = new Set(message.structures.map((structure) => structure.structureId));
        for (const key of [...this.bodies.keys()]) {
          if (repaired.has(bodyKeyParts(key).structureId)) {
            this.bodies.delete(key);
            this.kinetic.delete(key);
          }
        }
        this.structureRepairs += 1;
        // Repaint ONLY the repaired structures — restating the whole world
        // here would reintroduce the full-bootstrap pop this path exists to
        // remove. The repaired structures' bodies (support included) cover
        // exactly the slots the repair rewrote.
        for (const body of this.topology.allBodies()) {
          if (repaired.has(body.structureId)) {
            this.repaintBodies.add(body.key);
          }
        }
        break;
      }
      default:
        break;
    }
    // Packet handling runs in the datagram reader's microtasks, between frames
    // -- it never shows up in the frame's CPU span, so it is accumulated here
    // and attributed to the frame that follows it.
    addDecodeMs(performance.now() - now);
  }

  /**
   * Apply one reliable topology message to the ledger, with every side effect
   * (promotion seeding, repaints, settle/retire lane clearing, resync check).
   * Wire v2 calls this on packet arrival; wire v3 defers through
   * `pendingTopology` so the ledger basis never runs ahead of the sampled
   * pose stream.
   */
  private applyTopologyMessage(message: TopologyMessage): void {
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
            this.kinetic.delete(key);
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
            // Both map directions must still agree: this apply runs delayed,
            // and the lane may have been reassigned in the meantime -- a
            // stale clear would gut the NEW tenant's stream.
            const lane = this.entityToLane.get(key);
            if (lane !== undefined && this.laneToEntity.get(lane) === key) {
              this.debris?.clear_lane_until(lane, message.simTick);
            }
          }
          // A retired island will never stream again; without this its track
          // is sampled for the rest of the match.
          for (const batch of message.batches) {
            for (const islandId of batch.retiredIslandIds) {
              const key = bodyKey(batch.structureId, islandId);
              this.bodies.delete(key);
            this.kinetic.delete(key);
              this.settledAtTick.delete(key);
              const lane = this.entityToLane.get(key);
              if (lane !== undefined && this.laneToEntity.get(lane) === key) {
                this.debris?.clear_lane_until(lane, message.simTick);
                this.entityToLane.delete(key);
                this.laneToEntity.delete(lane);
              } else if (lane !== undefined) {
                // Lane already reassigned; just drop the retired entity's map.
                this.entityToLane.delete(key);
              }
            }
          }
          this.drainPending();
        }
        // Checked independently of `applied`: a successful apply still flags
        // faults when a migration names an island the client does not have,
        // and that chunk stays on the wrong body until a repair replaces it.
        //
        // Two tiers, and the split is what broke the 3.0-second popping loop:
        // a seq GAP costs the stream position and only the full bootstrap can
        // recover it — but the cascade-time faults (missing migration
        // destination, settle-frame reject) corrupt ONE structure's content
        // at a position both sides still agree on. Those used to escalate to
        // the full path too: every world rebuild repainted all 96k chunks,
        // and with the faults recurring each collapse, the whole rubble field
        // visibly snapped on the rate-limiter's exact 3.0 s cadence.
        const nowMs = performance.now();
        if (this.topology.needsResync && !this.resyncRequested) {
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.resyncRequested = true;
            this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
          } else {
            this.resyncsSuppressed += 1;
          }
        } else if (this.topology.resyncStructures.size > 0 && !this.resyncRequested) {
          // Same spacing as the full path: the repair covers every fault
          // accumulated by send time, so waiting costs delay, not repair.
          // The set stays populated until the structure bootstrap lands and
          // clears it, so a lost request re-fires on the next interval.
          if (nowMs - this.lastResyncAtMs >= RESYNC_MIN_INTERVAL_MS) {
            this.lastResyncAtMs = nowMs;
            this.sendResync(
              encodeCityResyncRequest(this.topology.lastSeq(), [
                ...this.topology.resyncStructures,
              ]),
            );
          } else {
            this.resyncsSuppressed += 1;
          }
        }
  }

  private handleBaseline(message: BaselineMessage): void {
    noteBaseline(message.baselineId);
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
      this.observeSimTick(datagram.simTick);
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
    this.kinetic.add(key);
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
    const renderTick = this.renderTickNow(performance.now());
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
    // A fresh record can revise the path even for a body that had settled out
    // of the walk; re-admit it before the staleness check, since even a stale
    // record costs one no-op sample and a missed fresh one costs a frozen chunk.
    this.kinetic.add(record.bodyEntity);
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
    const renderTick = this.renderTickNow(nowMs);
    if (this.debris !== null) {
      return this.sampleDebris(renderTick, live);
    }
    // The kinetic set, not the bodies map: a body whose track has settled
    // cannot move without an event that re-adds it, so re-sampling it every
    // frame only re-proves that. Deleting the current entry during Set
    // iteration is defined behaviour in JS.
    for (const key of this.kinetic) {
      const state = this.bodies.get(key);
      if (!state) {
        this.kinetic.delete(key);
        continue;
      }
      const presented = state.track.sample(renderTick);
      if (state.track.lastSampleSettled) {
        this.kinetic.delete(key);
        // Settled means the returned state is the previous sample's object,
        // so the epsilon comparison below would `continue` anyway -- skip it.
        continue;
      }
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
      // Written in place. This used to build an object and two arrays per moved
      // body per frame; during a collapse that is thousands of allocations a
      // frame, and the resulting GC is exactly the kind of periodic stall that
      // shows up as a dropped frame rather than as a higher average. Nothing
      // holds a reference to `lastPresented` -- it is only compared, field by
      // field, a few lines above -- so mutating it is safe.
      if (previous) {
        previous.position[0] = presented.position[0];
        previous.position[1] = presented.position[1];
        previous.position[2] = presented.position[2];
        previous.rotation[0] = presented.rotation[0];
        previous.rotation[1] = presented.rotation[1];
        previous.rotation[2] = presented.rotation[2];
        previous.rotation[3] = presented.rotation[3];
      } else {
        state.lastPresented = {
          position: [presented.position[0], presented.position[1], presented.position[2]],
          rotation: [
            presented.rotation[0],
            presented.rotation[1],
            presented.rotation[2],
            presented.rotation[3],
          ],
        };
      }
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
      bootstraps: this.bootstrapCount,
      settleRejects: this.topology.settleFrameRejects,
      valveApplies: this.topologyValveApplies,
      valveTicksAhead: this.topologyValveTicksAhead,
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
      hashChecks: this.hashChecks,
      hashMismatches: this.hashMismatches,
      structureRepairs: this.structureRepairs,
    };
  }
}

export type { Vec3, Quat };
