export const RBWT_HEADER_BYTES = 32;
export const RBWT_RECORD_BYTES = 32;

export interface RbwtPacketMeta {
  packetSequence: number;
  frameSequence: number;
  batchIndex: number;
  batchCount: number;
  recordCount: number;
  serverSendUs: number;
  receiveWallUs: number;
  hash: number;
}

export interface FrameTrace {
  frame: number;
  packet: number;
  hash: number;
  serverSendUs: number;
  receivedAtUs: number;
}

export interface RbwtSnapshot {
  connected: boolean;
  transport: 'direct' | 'moq';
  bodies: number;
  visibleBodies: number;
  latestFrame: number;
  latestPacket: number;
  receivedBytes: number;
  datagrams: number;
  bodyUpdates: number;
  missingPackets: number;
  reorderedPackets: number;
  renderedUpdates: number;
  fps: number;
  frameMs: number;
  clockRttMs: number | null;
  clockOffsetUs: number | null;
  latencyValues: number[];
  traces: FrameTrace[];
}

export class RbwtState {
  readonly positions: Float32Array;
  readonly rotations: Float32Array;
  readonly flags: Uint8Array;
  readonly lastFrame: Uint32Array;
  readonly lastUpdate: Float64Array;
  readonly seen: Uint8Array;
  readonly dirty: Uint8Array;
  readonly dirtyQueue: number[] = [];
  readonly latencyValues: number[] = [];
  readonly traces: FrameTrace[] = [];

  connected = false;
  transport: 'direct' | 'moq' = 'direct';
  visibleBodies = 0;
  latestFrame = -1;
  latestPacket = -1;
  receivedBytes = 0;
  datagrams = 0;
  bodyUpdates = 0;
  missingPackets = 0;
  reorderedPackets = 0;
  renderedUpdates = 0;
  fps = 0;
  frameMs = 0;
  clockRttMs: number | null = null;
  clockOffsetUs: number | null = null;

  constructor(readonly bodies: number) {
    this.positions = new Float32Array(bodies * 3);
    this.rotations = new Float32Array(bodies * 4);
    this.flags = new Uint8Array(bodies);
    this.lastFrame = new Uint32Array(bodies);
    this.lastUpdate = new Float64Array(bodies);
    this.seen = new Uint8Array(bodies);
    this.dirty = new Uint8Array(bodies);
  }

  apply(bytes: Uint8Array, receiveWallUs = Date.now() * 1000): RbwtPacketMeta | null {
    if (
      bytes.byteLength < RBWT_HEADER_BYTES
      || bytes[0] !== 0x52
      || bytes[1] !== 0x42
      || bytes[2] !== 0x57
      || bytes[3] !== 0x54
      || bytes[4] !== 1
    ) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const recordCount = view.getUint16(6, true);
    if (bytes.byteLength !== RBWT_HEADER_BYTES + recordCount * RBWT_RECORD_BYTES) return null;
    const packetSequence = Number(view.getBigUint64(8, true));
    const frameSequence = view.getUint32(16, true);
    const batchIndex = view.getUint16(20, true);
    const batchCount = view.getUint16(22, true);
    const serverSendUs = Number(view.getBigUint64(24, true));
    let applied = 0;

    for (let record = 0; record < recordCount; record += 1) {
      const offset = RBWT_HEADER_BYTES + record * RBWT_RECORD_BYTES;
      const id = view.getUint32(offset, true);
      if (id >= this.bodies) continue;
      if (this.seen[id] && !isNewerFrame(frameSequence, this.lastFrame[id])) continue;
      const p = id * 3;
      const q = id * 4;
      this.positions[p] = view.getFloat32(offset + 4, true);
      this.positions[p + 1] = view.getFloat32(offset + 8, true);
      this.positions[p + 2] = view.getFloat32(offset + 12, true);
      let lengthSquared = 0;
      for (let component = 0; component < 4; component += 1) {
        const value = view.getInt16(offset + 16 + component * 2, true) / 32767;
        this.rotations[q + component] = value;
        lengthSquared += value * value;
      }
      const inverseLength = 1 / Math.sqrt(Math.max(lengthSquared, 1e-12));
      for (let component = 0; component < 4; component += 1) {
        this.rotations[q + component] *= inverseLength;
      }
      this.flags[id] = view.getUint8(offset + 30);
      this.lastFrame[id] = frameSequence;
      this.lastUpdate[id] = performance.now();
      if (!this.seen[id]) {
        this.seen[id] = 1;
        this.visibleBodies += 1;
      }
      if (!this.dirty[id]) {
        this.dirty[id] = 1;
        this.dirtyQueue.push(id);
      }
      applied += 1;
    }

    this.receivedBytes += bytes.byteLength;
    this.datagrams += 1;
    this.bodyUpdates += applied;
    if (this.latestPacket >= 0) {
      if (packetSequence > this.latestPacket) {
        this.missingPackets += Math.max(0, packetSequence - this.latestPacket - 1);
      } else {
        this.reorderedPackets += 1;
      }
    }
    this.latestPacket = Math.max(this.latestPacket, packetSequence);
    this.latestFrame = Math.max(this.latestFrame, frameSequence);

    if (this.clockOffsetUs !== null) {
      const latencyMs = Math.max(0, (receiveWallUs + this.clockOffsetUs - serverSendUs) / 1000);
      if (Number.isFinite(latencyMs) && latencyMs < 10_000) {
        this.latencyValues.push(latencyMs);
        if (this.latencyValues.length > 4096) this.latencyValues.shift();
      }
    }

    const hash = fnv1a(bytes);
    if (batchIndex === 0) {
      this.traces.push({
        frame: frameSequence,
        packet: packetSequence,
        hash,
        serverSendUs,
        receivedAtUs: receiveWallUs,
      });
      if (this.traces.length > 2048) this.traces.shift();
    }
    return {
      packetSequence,
      frameSequence,
      batchIndex,
      batchCount,
      recordCount,
      serverSendUs,
      receiveWallUs,
      hash,
    };
  }

  snapshot(): RbwtSnapshot {
    return {
      connected: this.connected,
      transport: this.transport,
      bodies: this.bodies,
      visibleBodies: this.visibleBodies,
      latestFrame: this.latestFrame,
      latestPacket: this.latestPacket,
      receivedBytes: this.receivedBytes,
      datagrams: this.datagrams,
      bodyUpdates: this.bodyUpdates,
      missingPackets: this.missingPackets,
      reorderedPackets: this.reorderedPackets,
      renderedUpdates: this.renderedUpdates,
      fps: this.fps,
      frameMs: this.frameMs,
      clockRttMs: this.clockRttMs,
      clockOffsetUs: this.clockOffsetUs,
      latencyValues: [...this.latencyValues],
      traces: [...this.traces],
    };
  }
}

export function isNewerFrame(candidate: number, previous: number): boolean {
  const difference = (candidate - previous) >>> 0;
  return difference !== 0 && difference < 0x80000000;
}

export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
