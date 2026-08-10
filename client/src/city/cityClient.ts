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
import {
  BaselineMessage,
  ChunksDatagram,
  RECORD_FLAG_SETTLED_HINT,
  RecordMode,
  decodeBaseline,
  decodeBootstrap,
  decodeChunksDatagram,
  decodeTopology,
  encodeCityResyncRequest,
} from './wire';
import {
  PKT_CITY_BASELINE,
  PKT_CITY_BOOTSTRAP,
  PKT_CITY_CHUNKS,
  PKT_CITY_TOPOLOGY,
} from '../net/sharedConstants';

export interface CityClientStats {
  chunksTotal: number;
  chunksAwake: number;
  chunksSettled: number;
  brokenBonds: number;
  liveIslands: number;
  topoSeqGaps: number;
  datagramsReceived: number;
  recordsApplied: number;
  recordsBuffered: number;
  bytesReceived: number;
  bytesPerSecond: number;
  manifestHash: string;
}

interface BodyStreamState {
  track: PresentationTrack;
  lastTick: number;
  settledHint: boolean;
}

export class CityClient {
  readonly topology: CityTopology;
  private readonly bodies: Map<number, BodyStreamState> = new Map();
  private baselineId = 0;
  private readonly baselinePoses: Map<number, Vec3> = new Map();
  /** Records referencing bodies the ledger doesn't know yet (topology in flight). */
  private pendingRecords: ChunksDatagram[] = [];
  private datagramsReceived = 0;
  private recordsApplied = 0;
  private recordsBuffered = 0;
  private bytesReceived = 0;
  private bytesWindow: Array<{ at: number; bytes: number }> = [];
  private latestSimTick = 0;
  private latestSimTickAtMs = 0;

  constructor(
    readonly manifest: LoadedCityManifest,
    private readonly sendResync: (bytes: Uint8Array) => void,
  ) {
    this.topology = new CityTopology(manifest.manifest);
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
        this.handleChunks(decodeChunksDatagram(bytes));
        break;
      case PKT_CITY_TOPOLOGY: {
        const message = decodeTopology(bytes);
        const applied = this.topology.apply(message);
        if (!applied && this.topology.needsResync) {
          this.sendResync(encodeCityResyncRequest(this.topology.lastSeq()));
        } else {
          // Settle closes tracks; wakes re-open them.
          for (const settle of message.settled) {
            const key = bodyKey(settle.structureId, settle.islandId);
            this.bodies.delete(key);
          }
          this.drainPending();
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
        break;
      }
      default:
        break;
    }
  }

  private handleBaseline(message: BaselineMessage): void {
    if (message.baselineId !== this.baselineId) {
      this.baselineId = message.baselineId;
      this.baselinePoses.clear();
    }
    for (const record of message.records) {
      this.baselinePoses.set(record.bodyEntity, record.position);
    }
  }

  private handleChunks(datagram: ChunksDatagram): void {
    this.datagramsReceived += 1;
    this.latestSimTick = Math.max(this.latestSimTick, datagram.simTick);
    this.latestSimTickAtMs = performance.now();
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

  private applyRecord(
    datagram: ChunksDatagram,
    record: ChunksDatagram['records'][number],
  ): boolean {
    const body = this.topology.body(record.bodyEntity);
    if (!body) {
      this.recordsBuffered += 1;
      return false;
    }
    let position: Vec3;
    if (record.mode === RecordMode.Delta || record.mode === RecordMode.MotionDelta) {
      if (datagram.baselineId !== this.baselineId) {
        return true; // stale/unknown baseline generation — drop, absolutes recover
      }
      const baseline = this.baselinePoses.get(record.bodyEntity);
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
      state = {
        track: new PresentationTrack(presentationConfig60Hz()),
        lastTick: 0,
        settledHint: false,
      };
      this.bodies.set(record.bodyEntity, state);
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
    this.topology.updateBodyPose(record.bodyEntity, position, record.rotation);
    this.recordsApplied += 1;
    return true;
  }

  /**
   * Sample every streaming body at the current render time and push the
   * presented pose into the ledger. Returns the set of body keys with live
   * presentation (the render layer recomposes those chunks each frame).
   */
  samplePresentation(nowMs: number): Set<number> {
    const live = new Set<number>();
    if (this.latestSimTickAtMs === 0) {
      return live;
    }
    // Render tick estimate: latest known sim tick + elapsed since it arrived.
    const renderTick = this.latestSimTick + ((nowMs - this.latestSimTickAtMs) / 1000) * 60;
    for (const [key, state] of this.bodies) {
      const presented = state.track.sample(renderTick);
      this.topology.updateBodyPose(key, presented.position, presented.rotation);
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
      datagramsReceived: this.datagramsReceived,
      recordsApplied: this.recordsApplied,
      recordsBuffered: this.recordsBuffered,
      bytesReceived: this.bytesReceived,
      bytesPerSecond: windowSeconds > 0.25 ? windowBytes / windowSeconds : 0,
      manifestHash: this.manifest.hashHex,
    };
  }
}

export type { Vec3, Quat };
