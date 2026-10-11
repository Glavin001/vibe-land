/**
 * The per-player destruction stream (city wire 4) in the browser.
 *
 * Everything that decides what is drawn lives in the shared Rust core
 * (perplayer/, compiled to WASM): fracture outcomes applied at their tick,
 * bodies derived from broken bonds and named by their lowest chunk, the
 * predictor and the drawing rule. The server runs the same code to know
 * what this client draws (docs/netcode-lab.md).
 *
 * This class keeps the rest of the city client -- the chunk ledger the
 * renderer, dust and audio read -- by feeding it what the core decided: each
 * fracture becomes an ordinary topology message (promotions, retirements;
 * a removed chunk is a one-chunk island promoted and retired at once), and
 * each frame's body poses are written as presented poses.
 */
import { CityClient } from './cityClient';
import { PKT_CITY_RESYNC_REQUEST } from '../net/sharedConstants';
import { bondCountOf, type LoadedCityManifest } from './manifest';
import type { CityTopology } from './topology';
import type { FractureBatchMessage, TopologyMessage } from './wire';

export const PKT_PP_KEYFRAMES = 132;
export const PKT_PP_EVENTS = 133;
export const PKT_PP_BOOTSTRAP = 134;
export const PKT_PP_ACK = 135;
/** Bit 19 of the serial field: a per-player body (named by its lowest chunk). */
export const PER_PLAYER_SERIAL_BIT = 1 << 19;
/** Serials for removed chunks' one-chunk islands (never a body id). */
const REMOVED_SERIAL_BIT = 1 << 18;

export function perPlayerBodyKey(structure: number, body: number): number {
  return (0x8000_0000 | (structure << 20) | PER_PLAYER_SERIAL_BIT | body) >>> 0;
}

/** The WASM core's surface (perplayer/src/wasm.rs `PerPlayerClient`). */
export interface PerPlayerCore {
  ingest(bytes: Uint8Array, arrivalMs: number): void;
  advance(nowMs: number): number;
  started(): boolean;
  body_poses(): Float32Array;
  drain_changes(): Uint32Array;
  structure_flat(): Uint32Array;
  ack(): Uint32Array;
  render_tick(): number;
  stats_json(): string;
}

/** Flatten a manifest the way the core's constructor reads it. */
/** Floats per node in the core's `nodes` argument. */
const NODE_STRIDE = 11;

export function perPlayerCoreArgs(manifest: LoadedCityManifest['manifest']): {
  ids: Uint32Array;
  poses: Float32Array;
  nodeCounts: Uint32Array;
  bondCounts: Uint32Array;
  nodes: Float32Array;
  bonds: Uint32Array;
} {
  const structures = manifest.structures;
  const ids = new Uint32Array(structures.length);
  const poses = new Float32Array(structures.length * 7);
  const nodeCounts = new Uint32Array(structures.length);
  const bondCounts = new Uint32Array(structures.length);
  const nodes: number[] = [];
  const bonds: number[] = [];
  structures.forEach((s, i) => {
    ids[i] = s.structureId;
    poses.set([...s.worldPosition, ...s.worldRotation], i * 7);
    const n = s.chunks.reduce((m, c) => Math.max(m, c.nodeIndex + 1), 0);
    nodeCounts[i] = n;
    // Per node: rest, mass centre, mass, support, box half extents
    // (perplayer/src/wasm.rs NODE_STRIDE).
    const table = new Float32Array(n * NODE_STRIDE);
    for (const c of s.chunks) {
      const offset = c.massOffset ?? [0, 0, 0];
      table.set(
        [c.centroid[0], c.centroid[1], c.centroid[2],
          c.centroid[0] + offset[0], c.centroid[1] + offset[1], c.centroid[2] + offset[2],
          c.mass, c.support ? 1 : 0,
          (c.size?.[0] ?? 0) / 2, (c.size?.[1] ?? 0) / 2, (c.size?.[2] ?? 0) / 2],
        c.nodeIndex * NODE_STRIDE,
      );
    }
    nodes.push(...table);
    // A JSON manifest (tapes) carries bond objects with their indices; the
    // binary one the live server sends carries only endpoint arrays, indexed
    // by position (manifestBinary.ts). Without them every chunk derives as
    // its own body and no structure hash can match the server's.
    const bondList = s.bonds ?? [];
    let pairs: Uint32Array;
    if (bondList.length === 0 && s.bondNode0 && s.bondNode1) {
      const b = bondCountOf(s);
      pairs = new Uint32Array(b * 2);
      for (let k = 0; k < b; k += 1) {
        pairs[k * 2] = s.bondNode0[k];
        pairs[k * 2 + 1] = s.bondNode1[k];
      }
    } else {
      const b = bondList.reduce((m, bond) => Math.max(m, bond.bondIndex + 1), 0);
      pairs = new Uint32Array(b * 2);
      for (const bond of bondList) pairs.set([bond.node0, bond.node1], bond.bondIndex * 2);
    }
    bondCounts[i] = pairs.length / 2;
    for (let k = 0; k < pairs.length; k += 1) bonds.push(pairs[k]);
  });
  return { ids, poses, nodeCounts, bondCounts, nodes: Float32Array.from(nodes), bonds: Uint32Array.from(bonds) };
}

export class PerPlayerCityClient extends CityClient {
  private readonly core: PerPlayerCore;
  private topoSeq = 0;
  private renderTick = -1;
  private epoch = 0;
  private live: Set<number> = new Set();
  private settled: Set<number> = new Set();
  private repaint: Set<number> = new Set();
  private repaintEverything = false;
  /** Lets `requestResync` (and the core's own hash check) through; counts what it kept back. */
  private readonly resyncGate: { open: boolean; gated: number };
  private hashMismatchesSeen = 0;
  private lastHashResyncMs = Number.NEGATIVE_INFINITY;

  constructor(manifest: LoadedCityManifest, sendUpstream: (bytes: Uint8Array) => void, core: PerPlayerCore) {
    // CityClient's v2 checks (topology gaps, settle and migration faults)
    // watch a ledger this class writes itself from the core's decisions, so
    // what they ask for is noise here, and on wire 4 every resync restarts
    // the stream from a bootstrap. Only an explicit request goes up.
    const gate = { open: false, gated: 0 };
    super(manifest, (bytes) => {
      if (bytes[0] === PKT_CITY_RESYNC_REQUEST && !gate.open) {
        gate.gated += 1;
        return;
      }
      sendUpstream(bytes);
    });
    this.resyncGate = gate;
    this.core = core;
  }

  /** A fresh bootstrap from the server (wire 4: the stream restarts). */
  override requestResync(): void {
    this.resyncGate.open = true;
    try {
      super.requestResync();
    } finally {
      this.resyncGate.open = false;
    }
  }

  override handlePacket(bytes: Uint8Array): void {
    const kind = bytes[0];
    if (kind === PKT_PP_KEYFRAMES || kind === PKT_PP_EVENTS || kind === PKT_PP_BOOTSTRAP) {
      // Keyframes always come as datagrams (events and the bootstrap on the
      // reliable stream, events copies aside).
      this.countPacket(bytes, kind === PKT_PP_KEYFRAMES);
      this.core.ingest(bytes, performance.now());
      return;
    }
    super.handlePacket(bytes);
  }

  /** [newest ordinal, mask low, mask high, events through] for the upstream ack, or null. */
  ack(): Uint32Array | null {
    const a = this.core.ack();
    return a.length >= 3 ? a : null;
  }

  override samplePresentation(nowMs: number): Set<number> {
    const r = this.core.advance(nowMs);
    if (Number.isNaN(r) || !this.core.started()) return this.live;
    this.renderTick = r;
    // The core's structure hash disagreed with the server's: ask for a fresh
    // bootstrap, at most once per 3 s while it keeps disagreeing.
    const mismatches = (JSON.parse(this.core.stats_json()) as { hashMismatches?: number }).hashMismatches ?? 0;
    if (mismatches > this.hashMismatchesSeen && nowMs - this.lastHashResyncMs >= 3000) {
      this.hashMismatchesSeen = mismatches;
      this.lastHashResyncMs = nowMs;
      this.requestResync();
    }
    const poses = this.core.body_poses();
    const poseOf = new Map<number, number>();
    for (let i = 0; i < poses.length; i += 10) poseOf.set(perPlayerBodyKey(poses[i], poses[i + 1]), i);
    this.applyChanges(this.core.drain_changes(), poses, poseOf);
    const live = new Set<number>();
    const topology = this.topology as CityTopology;
    for (let i = 0; i < poses.length; i += 10) {
      const key = perPlayerBodyKey(poses[i], poses[i + 1]);
      topology.updateBodyPose(key, [poses[i + 2], poses[i + 3], poses[i + 4]], [poses[i + 5], poses[i + 6], poses[i + 7], poses[i + 8]], 'presented');
      const settled = poses[i + 9] !== 0;
      if (settled) {
        // One last write when it comes to rest, then nothing.
        if (!this.settled.has(key)) {
          this.settled.add(key);
          this.repaint.add(key);
        }
      } else {
        this.settled.delete(key);
        live.add(key);
      }
    }
    this.live = live;
    return live;
  }

  private applyChanges(flat: Uint32Array, poses: Float32Array, poseOf: Map<number, number>): void {
    let at = 0;
    const topology = this.topology as CityTopology;
    const promotion = (structureId: number, islandId: number, nodes: number[]) => {
      const i = poseOf.get(perPlayerBodyKey(structureId, islandId & ~PER_PLAYER_SERIAL_BIT));
      return {
        structureId,
        islandId,
        nodes,
        position: (i === undefined ? [0, 0, 0] : [poses[i + 2], poses[i + 3], poses[i + 4]]) as [number, number, number],
        rotation: (i === undefined ? [0, 0, 0, 1] : [poses[i + 5], poses[i + 6], poses[i + 7], poses[i + 8]]) as [number, number, number, number],
        linearVelocity: [0, 0, 0] as [number, number, number],
        angularVelocity: [0, 0, 0] as [number, number, number],
      };
    };
    while (at < flat.length) {
      const kind = flat[at++];
      if (kind === 1) {
        this.rebuildLedger(poses, poseOf);
        continue;
      }
      const tick = flat[at++];
      const structureId = flat[at++];
      const take = () => {
        const n = flat[at++];
        const list = Array.from(flat.subarray(at, at + n));
        at += n;
        return list;
      };
      const broken = take();
      const removed = take();
      const retired = take();
      const changedCount = flat[at++];
      const batch: FractureBatchMessage = { structureId, brokenBondIndices: broken, promotions: [], retiredIslandIds: [], migrations: [] };
      for (let c = 0; c < changedCount; c += 1) {
        const id = flat[at++];
        const members = take();
        batch.promotions.push(promotion(structureId, PER_PLAYER_SERIAL_BIT | id, members));
        this.repaint.add(perPlayerBodyKey(structureId, id));
      }
      for (const node of removed) {
        batch.promotions.push(promotion(structureId, PER_PLAYER_SERIAL_BIT | REMOVED_SERIAL_BIT | node, [node]));
        batch.retiredIslandIds.push(PER_PLAYER_SERIAL_BIT | REMOVED_SERIAL_BIT | node);
      }
      for (const id of retired) batch.retiredIslandIds.push(PER_PLAYER_SERIAL_BIT | id);
      this.topoSeq += 1;
      const message: TopologyMessage = { topoSeq: this.topoSeq, simTick: tick, batches: [batch], settled: [], wakes: [] };
      topology.apply(message);
    }
  }

  /** After a bootstrap: the ledger from the core's whole state. */
  private rebuildLedger(poses: Float32Array, poseOf: Map<number, number>): void {
    const topology = this.topology as CityTopology;
    topology.reset();
    // The ledger keeps its sequence across a reset: carry on from it, or a
    // second bootstrap (resync, reset) would be dropped as a duplicate.
    this.topoSeq += 1;
    const flat = this.core.structure_flat();
    const batches = new Map<number, FractureBatchMessage>();
    const batchOf = (s: number) => {
      let b = batches.get(s);
      if (!b) {
        b = { structureId: s, brokenBondIndices: [], promotions: [], retiredIslandIds: [], migrations: [] };
        batches.set(s, b);
      }
      return b;
    };
    let at = 0;
    while (at < flat.length && flat[at] !== 0xffff_ffff) {
      const s = flat[at];
      const id = flat[at + 1];
      const n = flat[at + 2];
      const members = Array.from(flat.subarray(at + 3, at + 3 + n));
      at += 3 + n;
      const i = poseOf.get(perPlayerBodyKey(s, id));
      batchOf(s).promotions.push({
        structureId: s,
        islandId: PER_PLAYER_SERIAL_BIT | id,
        nodes: members,
        position: i === undefined ? [0, 0, 0] : [poses[i + 2], poses[i + 3], poses[i + 4]],
        rotation: i === undefined ? [0, 0, 0, 1] : [poses[i + 5], poses[i + 6], poses[i + 7], poses[i + 8]],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      });
    }
    at += 1;
    for (; at + 1 < flat.length; at += 2) {
      const island = PER_PLAYER_SERIAL_BIT | REMOVED_SERIAL_BIT | flat[at + 1];
      const b = batchOf(flat[at]);
      b.promotions.push({ structureId: flat[at], islandId: island, nodes: [flat[at + 1]], position: [0, -100, 0], rotation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
      b.retiredIslandIds.push(island);
    }
    topology.apply({ topoSeq: this.topoSeq, simTick: Math.max(0, Math.floor(this.renderTick)), batches: [...batches.values()], settled: [], wakes: [] });
    this.epoch += 1;
    this.repaintEverything = true;
  }

  override liveBodyKeys(): ReadonlySet<number> {
    return this.live;
  }

  override drainRepaint(): { all: boolean; bodies: number[] } {
    const all = this.repaintEverything;
    const bodies = all ? [] : [...this.repaint];
    this.repaintEverything = false;
    this.repaint.clear();
    return { all, bodies };
  }

  override presentationClock(): { renderTick: number; playoutDelayTicks: number } {
    return { renderTick: this.renderTick, playoutDelayTicks: 0 };
  }

  override presentedTick(): number {
    return this.renderTick < 0 ? Number.POSITIVE_INFINITY : this.renderTick;
  }

  override ledgerEpoch(): number {
    return this.epoch;
  }

  override stats(): ReturnType<CityClient['stats']> {
    const base = super.stats();
    const core = JSON.parse(this.core.stats_json()) as Record<string, number>;
    return {
      ...base,
      wireVersion: 4,
      hashChecks: core.hashChecks,
      hashMismatches: core.hashMismatches,
      // The core applies every event at its tick: never early; late ones
      // (arrived after the drawing passed their tick) are counted.
      eventsApplied: core.eventsApplied,
      eventsAppliedEarly: 0,
      eventsAppliedLate: core.eventsLate,
      // The lab's gate G2 reads this name (as the Rust stage writes it).
      eventsLate: core.eventsLate,
      perPlayer: { ...core, resyncsGated: this.resyncGate.gated },
    } as ReturnType<CityClient['stats']>;
  }
}
