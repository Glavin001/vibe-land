// TypeScript mirror of vibe-land/destruction/src/wire.rs — the city
// destruction wire formats. Little-endian throughout. Golden-vector tests in
// wire.test.ts are pinned to the Rust encoder's `#[test]` hex dumps; if either
// side changes, both must change together.

import {
  PKT_CITY_BASELINE,
  PKT_CITY_BOOTSTRAP,
  PKT_CITY_CHUNKS,
  PKT_CITY_DEBRIS,
  PKT_CITY_NACK,
  PKT_CITY_RESYNC_REQUEST,
  PKT_CITY_MANIFEST,
  PKT_CITY_TOPOLOGY,
  PKT_MATCH_STATS,
} from '../net/sharedConstants';
import type { Quat, Vec3 } from './vec';

export const CITY_WIRE_VERSION = 2;
/** Denser reliable-channel layout; identical decoded shapes. */
export const CITY_WIRE_V3 = 3;
export const SUPPORTED_CITY_WIRE_VERSIONS: readonly number[] = [CITY_WIRE_VERSION, CITY_WIRE_V3];

export const RECORD_FLAG_SETTLED_HINT = 0b0000_1000;
export const RECORD_FLAG_KINEMATIC_SUPPORT = 0b0001_0000;
const RECORD_MODE_MASK = 0b0000_0111;

const SECTION_FRACTURE = 0x01;
const SECTION_SETTLE = 0x02;
const SECTION_WAKE = 0x03;

const LINEAR_VELOCITY_QUANTUM = 0.01;
const ANGULAR_VELOCITY_QUANTUM = 0.001;

export enum RecordMode {
  Absolute = 0,
  Delta = 1,
  MotionAbsolute = 2,
  MotionDelta = 3,
  Ballistic = 4,
}

const modeHasVelocity = (mode: RecordMode): boolean =>
  mode === RecordMode.MotionAbsolute ||
  mode === RecordMode.MotionDelta ||
  mode === RecordMode.Ballistic;

const modeIsDelta = (mode: RecordMode): boolean =>
  mode === RecordMode.Delta || mode === RecordMode.MotionDelta;

export interface DecodedBodyRecord {
  bodyEntity: number;
  mode: RecordMode;
  flags: number;
  /** Absolute position, or baseline-relative offset for delta modes (meters). */
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
}

export interface ChunksDatagram {
  sequence: number;
  baselineId: number;
  simTick: number;
  records: DecodedBodyRecord[];
}

export interface IslandPromotionMessage {
  structureId: number;
  islandId: number;
  /** Node indices within the structure, ascending. */
  nodes: number[];
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
}

export interface FractureBatchMessage {
  structureId: number;
  /** Bond indices within the structure, ascending. */
  brokenBondIndices: number[];
  promotions: IslandPromotionMessage[];
  retiredIslandIds: number[];
  /**
   * Chunks physics moved between islands that both already exist. No promotion
   * is issued for these, so the client has to be told or it keeps the chunk on
   * its old body and both islands' centres of mass go wrong.
   */
  migrations: Array<{ node: number; fromIslandSerial: number; toIslandSerial: number }>;
}

export interface SettleMessage {
  structureId: number;
  islandId: number;
  position: Vec3;
  rotation: Quat;
}

export interface TopologyMessage {
  topoSeq: number;
  simTick: number;
  batches: FractureBatchMessage[];
  settled: SettleMessage[];
  wakes: Array<{ structureId: number; islandSerial: number }>;
}

export interface BaselineMessage {
  baselineId: number;
  simTick: number;
  partIndex: number;
  partCount: number;
  records: Array<{ bodyEntity: number; position: Vec3; rotation: Quat }>;
}

export interface BootstrapStructureMessage {
  structureId: number;
  bondCount: number;
  /** Bit i set = bond index i alive. */
  aliveBonds: Uint8Array;
}

export interface BootstrapIslandMessage {
  structureId: number;
  islandId: number;
  nodes: number[];
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  settled: boolean;
}

export interface BootstrapMessage {
  simTick: number;
  manifestHashHex: string;
  baselineId: number;
  topoSeq: number;
  structures: BootstrapStructureMessage[];
  islands: BootstrapIslandMessage[];
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  bytes32(count: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  leb128(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      if (shift >= 32) {
        throw new Error('varint overflow');
      }
      // Bitwise ops in JS are 32-bit signed; use multiplication to stay exact
      // for the high bits (body entities have bit 31 set).
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value >>> 0 === value ? value : value;
      }
      shift += 7;
    }
  }

  i16x3(): Vec3 {
    return [this.i16(), this.i16(), this.i16()];
  }
}

export function decodeQuat32(packed: number): Quat {
  const largest = packed & 3;
  const values: number[] = [0, 0, 0, 0];
  let shift = 2;
  let sum = 0;
  const scale = 511 * Math.SQRT2;
  for (let i = 0; i < 4; i++) {
    if (i === largest) {
      continue;
    }
    const raw = Math.floor(packed / 2 ** shift) & 0x3ff;
    const signed = raw & 0x200 ? raw - 0x400 : raw;
    const value = signed / scale;
    values[i] = value;
    sum += value * value;
    shift += 10;
  }
  values[largest] = Math.sqrt(Math.max(0, 1 - sum));
  const q: Quat = [values[0], values[1], values[2], values[3]];
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length > 0 ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length] : [0, 0, 0, 1];
}

function decodeRegionPosition(region: Vec3, local: Vec3): Vec3 {
  return [
    (region[0] * 32_000 + local[0]) * 0.01,
    (region[1] * 32_000 + local[1]) * 0.01,
    (region[2] * 32_000 + local[2]) * 0.01,
  ];
}

function readPoseAbsolute(reader: Reader): { position: Vec3; rotation: Quat } {
  const region = reader.i16x3();
  const local = reader.i16x3();
  const rotation = decodeQuat32(reader.u32());
  return { position: decodeRegionPosition(region, local), rotation };
}

function readVelocities(reader: Reader): { linear: Vec3; angular: Vec3 } {
  const linearRaw = reader.i16x3();
  const angularRaw = reader.i16x3();
  return {
    linear: [
      linearRaw[0] * LINEAR_VELOCITY_QUANTUM,
      linearRaw[1] * LINEAR_VELOCITY_QUANTUM,
      linearRaw[2] * LINEAR_VELOCITY_QUANTUM,
    ],
    angular: [
      angularRaw[0] * ANGULAR_VELOCITY_QUANTUM,
      angularRaw[1] * ANGULAR_VELOCITY_QUANTUM,
      angularRaw[2] * ANGULAR_VELOCITY_QUANTUM,
    ],
  };
}

/**
 * Reads the two header bytes and returns the wire version.
 *
 * Returning the version rather than asserting one lets a single decoder body
 * branch on layout, which is what keeps v2 and v3 sharing every downstream
 * interface instead of forking the client.
 */
function expectHeader(reader: Reader, expectedKind: number): number {
  const kind = reader.u8();
  if (kind !== expectedKind) {
    throw new Error(`unexpected packet kind ${kind} (wanted ${expectedKind})`);
  }
  const version = reader.u8();
  if (!SUPPORTED_CITY_WIRE_VERSIONS.includes(version)) {
    throw new Error(`unsupported city wire version ${version}`);
  }
  return version;
}

export function decodeChunksDatagram(bytes: Uint8Array): ChunksDatagram {
  const reader = new Reader(bytes);
  expectHeader(reader, PKT_CITY_CHUNKS);
  const sequence = reader.u32();
  const baselineId = reader.u16();
  const simTick = reader.u32();
  const recordCount = reader.u16();
  reader.u16(); // reserved

  const records: DecodedBodyRecord[] = [];
  let previous: number | null = null;
  for (let i = 0; i < recordCount; i++) {
    const tag = reader.u8();
    const mode = (tag & RECORD_MODE_MASK) as RecordMode;
    if (mode > RecordMode.Ballistic) {
      throw new Error(`invalid record mode ${mode}`);
    }
    const flags = tag & ~RECORD_MODE_MASK;
    const idValue = reader.leb128();
    const bodyEntity: number = previous === null ? idValue : previous + idValue;
    previous = bodyEntity;

    let position: Vec3;
    let rotation: Quat;
    if (modeIsDelta(mode)) {
      const delta = reader.i16x3();
      rotation = decodeQuat32(reader.u32());
      position = [delta[0] * 0.01, delta[1] * 0.01, delta[2] * 0.01];
    } else {
      ({ position, rotation } = readPoseAbsolute(reader));
    }
    let linearVelocity: Vec3 = [0, 0, 0];
    let angularVelocity: Vec3 = [0, 0, 0];
    if (modeHasVelocity(mode)) {
      const velocities = readVelocities(reader);
      linearVelocity = velocities.linear;
      angularVelocity = velocities.angular;
    }
    records.push({ bodyEntity, mode, flags, position, rotation, linearVelocity, angularVelocity });
  }
  return { sequence, baselineId, simTick, records };
}

export function decodeTopology(bytes: Uint8Array): TopologyMessage {
  const reader = new Reader(bytes);
  expectHeader(reader, PKT_CITY_TOPOLOGY);
  const message: TopologyMessage = {
    topoSeq: reader.u32(),
    simTick: reader.u32(),
    batches: [],
    settled: [],
    wakes: [],
  };
  const sectionCount = reader.u16();
  for (let s = 0; s < sectionCount; s++) {
    const section = reader.u8();
    if (section === SECTION_FRACTURE) {
      const structureId = reader.leb128();
      const bondCount = reader.leb128();
      const brokenBondIndices: number[] = [];
      let bond = 0;
      for (let i = 0; i < bondCount; i++) {
        const gap = reader.leb128();
        bond = i === 0 ? gap : bond + gap;
        brokenBondIndices.push(bond);
      }
      const promotionCount = reader.leb128();
      const promotions: IslandPromotionMessage[] = [];
      for (let p = 0; p < promotionCount; p++) {
        const islandId = reader.leb128();
        const nodeCount = reader.leb128();
        const nodes: number[] = [];
        let node = 0;
        for (let i = 0; i < nodeCount; i++) {
          const gap = reader.leb128();
          node = i === 0 ? gap : node + gap;
          nodes.push(node);
        }
        const pose = readPoseAbsolute(reader);
        const velocities = readVelocities(reader);
        promotions.push({
          structureId,
          islandId,
          nodes,
          position: pose.position,
          rotation: pose.rotation,
          linearVelocity: velocities.linear,
          angularVelocity: velocities.angular,
        });
      }
      const retiredCount = reader.leb128();
      const retiredIslandIds: number[] = [];
      for (let i = 0; i < retiredCount; i++) {
        retiredIslandIds.push(reader.leb128());
      }
      const migrationCount = reader.leb128();
      const migrations: Array<{
        node: number;
        fromIslandSerial: number;
        toIslandSerial: number;
      }> = [];
      for (let i = 0; i < migrationCount; i++) {
        migrations.push({
          node: reader.leb128(),
          fromIslandSerial: reader.leb128(),
          toIslandSerial: reader.leb128(),
        });
      }
      message.batches.push({
        structureId,
        brokenBondIndices,
        promotions,
        retiredIslandIds,
        migrations,
      });
    } else if (section === SECTION_SETTLE) {
      const count = reader.leb128();
      for (let i = 0; i < count; i++) {
        const structureId = reader.leb128();
        const islandId = reader.leb128();
        const pose = readPoseAbsolute(reader);
        message.settled.push({
          structureId,
          islandId,
          position: pose.position,
          rotation: pose.rotation,
        });
      }
    } else if (section === SECTION_WAKE) {
      const count = reader.leb128();
      for (let i = 0; i < count; i++) {
        message.wakes.push({ structureId: reader.leb128(), islandSerial: reader.leb128() });
      }
    } else {
      throw new Error(`invalid topology section ${section}`);
    }
  }
  return message;
}

export function decodeBaseline(bytes: Uint8Array): BaselineMessage {
  const reader = new Reader(bytes);
  expectHeader(reader, PKT_CITY_BASELINE);
  const baselineId = reader.u16();
  const simTick = reader.u32();
  const partIndex = reader.u16();
  const partCount = reader.u16();
  const recordCount = reader.u16();
  const records: BaselineMessage['records'] = [];
  let previous: number | null = null;
  for (let i = 0; i < recordCount; i++) {
    const idValue = reader.leb128();
    const bodyEntity: number = previous === null ? idValue : previous + idValue;
    previous = bodyEntity;
    const pose = readPoseAbsolute(reader);
    records.push({ bodyEntity, position: pose.position, rotation: pose.rotation });
  }
  return { baselineId, simTick, partIndex, partCount, records };
}

export function decodeBootstrap(bytes: Uint8Array): BootstrapMessage {
  return decodeBootstrapKind(bytes, PKT_CITY_BOOTSTRAP);
}

/** Same payload as a full bootstrap; the kind scopes it to the structures it names. */
export function decodeStructureBootstrap(bytes: Uint8Array): BootstrapMessage {
  return decodeBootstrapKind(bytes, PKT_CITY_STRUCTURE_BOOTSTRAP);
}

function decodeBootstrapKind(bytes: Uint8Array, expectedKind: number): BootstrapMessage {
  const reader = new Reader(bytes);
  expectHeader(reader, expectedKind);
  const simTick = reader.u32();
  const hashBytes = reader.bytes32(32);
  const manifestHashHex = Array.from(hashBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const baselineId = reader.u16();
  const topoSeq = reader.u32();

  const structures: BootstrapStructureMessage[] = [];
  const structureCount = reader.leb128();
  for (let s = 0; s < structureCount; s++) {
    const structureId = reader.leb128();
    const bondCount = reader.leb128();
    const byteCount = Math.ceil(bondCount / 8);
    structures.push({
      structureId,
      bondCount,
      aliveBonds: new Uint8Array(reader.bytes32(byteCount)),
    });
  }

  const islands: BootstrapIslandMessage[] = [];
  const islandCount = reader.leb128();
  for (let i = 0; i < islandCount; i++) {
    const structureId = reader.leb128();
    const islandId = reader.leb128();
    const nodeCount = reader.leb128();
    const nodes: number[] = [];
    let node = 0;
    for (let n = 0; n < nodeCount; n++) {
      const gap = reader.leb128();
      node = n === 0 ? gap : node + gap;
      nodes.push(node);
    }
    const pose = readPoseAbsolute(reader);
    const velocities = readVelocities(reader);
    const settled = reader.u8() !== 0;
    islands.push({
      structureId,
      islandId,
      nodes,
      position: pose.position,
      rotation: pose.rotation,
      linearVelocity: velocities.linear,
      angularVelocity: velocities.angular,
      settled,
    });
  }
  return { simTick, manifestHashHex, baselineId, topoSeq, structures, islands };
}

/**
 * `structures` names the structures a hash mismatch implicated; the server
 * replies with a bootstrap scoped to exactly those. Empty (the historical
 * 5-byte packet, byte-identical) means full bootstrap.
 */
export function encodeCityResyncRequest(
  lastTopoSeq: number,
  structures: readonly number[] = [],
): Uint8Array {
  const bytes = new Uint8Array(structures.length === 0 ? 5 : 6 + structures.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PKT_CITY_RESYNC_REQUEST);
  view.setUint32(1, lastTopoSeq >>> 0, true);
  if (structures.length > 0) {
    view.setUint8(5, structures.length);
    structures.forEach((structureId, index) => {
      view.setUint32(6 + index * 4, structureId >>> 0, true);
    });
  }
  return bytes;
}

export interface TopologyHashEntry {
  structureId: number;
  /** High 32 bits of the server's 64-bit hash (lane A), as unsigned. */
  laneA: number;
  /** Low 32 bits (lane B), as unsigned. */
  laneB: number;
}

export interface TopologyHashMessage {
  topoSeq: number;
  hashes: TopologyHashEntry[];
}

/**
 * `[kind][topo_seq u32][count u8]` then `[structure_id u32][hash u64]` each,
 * little-endian. The u64 is read as two u32 lanes (low = B, high = A) so the
 * comparison never touches BigInt.
 */
export function decodeTopologyHashes(bytes: Uint8Array): TopologyHashMessage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PKT_CITY_TOPO_HASH) {
    throw new Error(`unexpected packet kind ${view.getUint8(0)} (wanted ${PKT_CITY_TOPO_HASH})`);
  }
  const topoSeq = view.getUint32(1, true);
  const count = view.getUint8(5);
  if (bytes.byteLength < 6 + count * 12) {
    throw new Error(`short topology hash packet: ${bytes.byteLength} bytes for ${count} entries`);
  }
  const hashes: TopologyHashEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 12;
    hashes.push({
      structureId: view.getUint32(base, true),
      laneB: view.getUint32(base + 4, true),
      laneA: view.getUint32(base + 8, true),
    });
  }
  return { topoSeq, hashes };
}

/**
 * Packets handed through as raw bytes rather than decoded as gameplay packets.
 * Beyond city geometry this now carries the manifest and per-match telemetry,
 * both of which travel on the session because a browser cannot fetch them from
 * a rented box over HTTP.
 */
export function isCityPacketKind(kind: number): boolean {
  return (
    kind === PKT_CITY_CHUNKS ||
    kind === PKT_CITY_TOPOLOGY ||
    kind === PKT_CITY_BASELINE ||
    kind === PKT_CITY_BOOTSTRAP ||
    kind === PKT_CITY_MANIFEST ||
    kind === PKT_MATCH_STATS ||
    kind === PKT_CITY_DEBRIS ||
    kind === PKT_CITY_LANES ||
    kind === PKT_CITY_TOPO_HASH ||
    kind === PKT_CITY_STRUCTURE_BOOTSTRAP
  );
}

/** Reliable lane -> body-entity assignments for the v3 debris stream. */
export const PKT_CITY_LANES = 127;

/** Periodic per-structure ledger hashes; the silent-divergence detector. */
export const PKT_CITY_TOPO_HASH = 128;

/** A bootstrap scoped to the structures it names — the targeted repair. */
export const PKT_CITY_STRUCTURE_BOOTSTRAP = 129;

export type DebrisHeader = {
  spanTick: number;
  /** 0 = raw, 1 = zstd with the shipped v3 dictionary. */
  compression: number;
  /** Lane-map revision at encode time (u8 serial arithmetic). */
  epoch: number;
  /** Offset where the codec payload starts. */
  bodyOffset: number;
};

export function decodeDebrisHeader(bytes: Uint8Array): DebrisHeader {
  if (bytes.length < 8 || bytes[0] !== PKT_CITY_DEBRIS) {
    throw new Error('bad debris datagram');
  }
  if (bytes[1] !== CITY_WIRE_V3) {
    throw new Error(`unsupported debris wire version ${bytes[1]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { spanTick: view.getUint32(2, true), compression: bytes[6], epoch: bytes[7], bodyOffset: 8 };
}

export function decodeCityLanes(bytes: Uint8Array): { epoch: number; entries: Array<[number, number]> } {
  if (bytes.length < 5 || bytes[0] !== PKT_CITY_LANES) {
    throw new Error('bad city lanes packet');
  }
  if (bytes[1] !== CITY_WIRE_V3) {
    throw new Error(`unsupported lanes wire version ${bytes[1]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The lane-map revision these assignments advance the receiver to; each
  // CHANGED lane's assigned epoch becomes this value (unchanged lanes keep
  // theirs, so in-flight packets for them are not spuriously refused).
  const epoch = bytes[2];
  const count = view.getUint16(3, true);
  const entries: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const at = 5 + index * 8;
    entries.push([view.getUint32(at, true), view.getUint32(at + 4, true)]);
  }
  return { epoch, entries };
}

/** Bodies whose chains a lost packet poisoned; the server restates them. */
export function encodeCityNack(bodies: number[]): Uint8Array {
  const count = Math.min(bodies.length, 0xffff);
  const out = new Uint8Array(3 + count * 4);
  out[0] = PKT_CITY_NACK;
  const view = new DataView(out.buffer);
  view.setUint16(1, count, true);
  for (let index = 0; index < count; index += 1) {
    view.setUint32(3 + index * 4, bodies[index] >>> 0, true);
  }
  return out;
}
