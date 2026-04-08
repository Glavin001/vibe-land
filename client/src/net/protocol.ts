export const PKT_CLIENT_HELLO = 1;
export const PKT_INPUT_BUNDLE = 2;
export const PKT_FIRE = 3;

export const PKT_WELCOME = 101;
export const PKT_SNAPSHOT = 102;
export const PKT_SHOT_RESULT = 103;
export const PKT_CHUNK_FULL = 104;
export const PKT_CHUNK_DIFF = 105;

export const BTN_FORWARD = 1 << 0;
export const BTN_BACK = 1 << 1;
export const BTN_LEFT = 1 << 2;
export const BTN_RIGHT = 1 << 3;
export const BTN_JUMP = 1 << 4;
export const BTN_CROUCH = 1 << 5;
export const BTN_SPRINT = 1 << 6;
export const BTN_SECONDARY_FIRE = 1 << 7;
export const BTN_RELOAD = 1 << 8;

export const FLAG_ON_GROUND = 1 << 0;
export const BLOCK_ADD = 1;
export const BLOCK_REMOVE = 2;

export const WEAPON_HITSCAN = 1;
export const WEAPON_ROCKET = 2;

export type ClientHello = {
  matchId: string;
};

export type InputFrame = {
  seq: number;
  buttons: number;
  moveX: number;
  moveY: number;
  yaw: number;
  pitch: number;
};

export type FireCmd = {
  seq: number;
  shotId: number;
  weapon: number;
  clientInterpMs: number;
  dir: [number, number, number];
};

export type NetPlayerState = {
  id: number;
  pxMm: number;
  pyMm: number;
  pzMm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  yawI16: number;
  pitchI16: number;
  flags: number;
};

export type NetProjectileState = {
  id: number;
  ownerId: number;
  sourceShotId: number;
  kind: number;
  pxMm: number;
  pyMm: number;
  pzMm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
};

export type NetDynamicBodyState = {
  id: number;
  shapeType: number;
  pxMm: number;
  pyMm: number;
  pzMm: number;
  qxSnorm: number;
  qySnorm: number;
  qzSnorm: number;
  qwSnorm: number;
  hxCm: number;
  hyCm: number;
  hzCm: number;
};

export type DynamicBodyStateMeters = {
  id: number;
  shapeType: number;
  position: [number, number, number];
  quaternion: [number, number, number, number]; // x, y, z, w
  halfExtents: [number, number, number];
};

export type WelcomePacket = {
  type: 'welcome';
  playerId: number;
  simHz: number;
  snapshotHz: number;
  serverTimeUs: number;
  interpolationDelayMs: number;
};

export type SnapshotPacket = {
  type: 'snapshot';
  serverTimeUs: number;
  serverTick: number;
  ackInputSeq: number;
  playerStates: NetPlayerState[];
  projectileStates: NetProjectileState[];
  dynamicBodyStates: NetDynamicBodyState[];
};

export type ShotResultPacket = {
  type: 'shotResult';
  shotId: number;
  weapon: number;
  confirmed: boolean;
  hitPlayerId: number;
};

export type ServerReliablePacket = WelcomePacket | ShotResultPacket;
export type ServerDatagramPacket = SnapshotPacket;

export type ServerPingPacket = { type: 'serverPing'; value: number };
export type PongPacket = { type: 'pong'; value: number };
export type ServerWorldPacket = ChunkFullPacket | ChunkDiffPacket;
export type ServerPacket =
  | WelcomePacket
  | SnapshotPacket
  | ShotResultPacket
  | ChunkFullPacket
  | ChunkDiffPacket
  | ServerPingPacket
  | PongPacket;

export type InputCmd = InputFrame;

export type BlockEditCmd = {
  chunk: [number, number, number];
  expectedVersion: number;
  local: [number, number, number];
  op: number;
  material: number;
};

export type BlockCell = {
  x: number;
  y: number;
  z: number;
  material: number;
};

export type BlockEditNet = {
  x: number;
  y: number;
  z: number;
  op: number;
  material: number;
};

export type ChunkFullPacket = {
  type: 'chunkFull';
  chunk: [number, number, number];
  version: number;
  blocks: BlockCell[];
};

export type ChunkDiffPacket = {
  type: 'chunkDiff';
  chunk: [number, number, number];
  version: number;
  edits: BlockEditNet[];
};

export type PlayerStateMeters = {
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  flags: number;
};

export type ProjectileStateMeters = {
  position: [number, number, number];
  velocity: [number, number, number];
  kind: number;
  ownerId: number;
  sourceShotId: number;
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function encodeClientHello(packet: ClientHello): Uint8Array {
  const encodedMatchId = TEXT_ENCODER.encode(packet.matchId);
  const out = new Uint8Array(1 + 2 + encodedMatchId.length);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_CLIENT_HELLO);
  view.setUint16(o, encodedMatchId.length, true);
  o += 2;
  out.set(encodedMatchId, o);
  return out;
}

export function encodeInputBundle(frames: InputFrame[]): Uint8Array {
  if (frames.length === 0) {
    throw new Error('input bundle cannot be empty');
  }
  if (frames.length > 255) {
    throw new Error('input bundle too large');
  }
  const out = new Uint8Array(1 + 1 + frames.length * 10);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_INPUT_BUNDLE);
  view.setUint8(o++, frames.length);
  for (const frame of frames) {
    view.setUint16(o, frame.seq & 0xffff, true); o += 2;
    view.setUint16(o, frame.buttons & 0xffff, true); o += 2;
    view.setInt8(o++, clampI8(frame.moveX));
    view.setInt8(o++, clampI8(frame.moveY));
    view.setInt16(o, angleToI16(frame.yaw), true); o += 2;
    view.setInt16(o, angleToI16(frame.pitch), true); o += 2;
  }
  return out;
}

export function encodeFirePacket(packet: FireCmd): Uint8Array {
  const out = new Uint8Array(1 + 2 + 4 + 1 + 2 + 2 + 2 + 2);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_FIRE);
  view.setUint16(o, packet.seq & 0xffff, true); o += 2;
  view.setUint32(o, packet.shotId >>> 0, true); o += 4;
  view.setUint8(o++, packet.weapon & 0xff);
  view.setUint16(o, packet.clientInterpMs & 0xffff, true); o += 2;
  view.setInt16(o, f32ToSnorm16(packet.dir[0]), true); o += 2;
  view.setInt16(o, f32ToSnorm16(packet.dir[1]), true); o += 2;
  view.setInt16(o, f32ToSnorm16(packet.dir[2]), true); o += 2;
  return out;
}

export function frameReliablePacket(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

export function decodeServerReliablePacket(data: ArrayBuffer | Uint8Array): ServerReliablePacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const kind = view.getUint8(o++);

  switch (kind) {
    case PKT_WELCOME: {
      const playerId = view.getUint32(o, true); o += 4;
      const simHz = view.getUint16(o, true); o += 2;
      const snapshotHz = view.getUint16(o, true); o += 2;
      const serverTimeUs = getUint64(view, o); o += 8;
      const interpolationDelayMs = view.getUint16(o, true);
      return {
        type: 'welcome',
        playerId,
        simHz,
        snapshotHz,
        serverTimeUs,
        interpolationDelayMs,
      };
    }
    case PKT_SHOT_RESULT: {
      const shotId = view.getUint32(o, true); o += 4;
      const weapon = view.getUint8(o++);
      const confirmed = view.getUint8(o++) !== 0;
      const hitPlayerId = view.getUint32(o, true);
      return {
        type: 'shotResult',
        shotId,
        weapon,
        confirmed,
        hitPlayerId,
      };
    }
    default:
      throw new Error(`unknown reliable packet kind: ${kind}`);
  }
}

export function decodeServerDatagramPacket(data: ArrayBuffer | Uint8Array): ServerDatagramPacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const kind = view.getUint8(o++);

  switch (kind) {
    case PKT_SNAPSHOT: {
      const serverTimeUs = getUint64(view, o); o += 8;
      const serverTick = view.getUint32(o, true); o += 4;
      const ackInputSeq = view.getUint16(o, true); o += 2;
      const playerCount = view.getUint16(o, true); o += 2;
      const projectileCount = view.getUint16(o, true); o += 2;
      const dynamicBodyCount = view.getUint16(o, true); o += 2;

      const playerStates: NetPlayerState[] = [];
      for (let i = 0; i < playerCount; i += 1) {
        playerStates.push({
          id: view.getUint32(o, true),
          pxMm: view.getInt32(o + 4, true),
          pyMm: view.getInt32(o + 8, true),
          pzMm: view.getInt32(o + 12, true),
          vxCms: view.getInt16(o + 16, true),
          vyCms: view.getInt16(o + 18, true),
          vzCms: view.getInt16(o + 20, true),
          yawI16: view.getInt16(o + 22, true),
          pitchI16: view.getInt16(o + 24, true),
          flags: view.getUint16(o + 26, true),
        });
        o += 28;
      }

      const projectileStates: NetProjectileState[] = [];
      for (let i = 0; i < projectileCount; i += 1) {
        projectileStates.push({
          id: view.getUint32(o, true),
          ownerId: view.getUint32(o + 4, true),
          sourceShotId: view.getUint32(o + 8, true),
          kind: view.getUint8(o + 12),
          pxMm: view.getInt32(o + 13, true),
          pyMm: view.getInt32(o + 17, true),
          pzMm: view.getInt32(o + 21, true),
          vxCms: view.getInt16(o + 25, true),
          vyCms: view.getInt16(o + 27, true),
          vzCms: view.getInt16(o + 29, true),
        });
        o += 31;
      }

      const dynamicBodyStates: NetDynamicBodyState[] = [];
      for (let i = 0; i < dynamicBodyCount; i += 1) {
        dynamicBodyStates.push({
          id: view.getUint32(o, true),
          shapeType: view.getUint8(o + 4),
          pxMm: view.getInt32(o + 5, true),
          pyMm: view.getInt32(o + 9, true),
          pzMm: view.getInt32(o + 13, true),
          qxSnorm: view.getInt16(o + 17, true),
          qySnorm: view.getInt16(o + 19, true),
          qzSnorm: view.getInt16(o + 21, true),
          qwSnorm: view.getInt16(o + 23, true),
          hxCm: view.getUint16(o + 25, true),
          hyCm: view.getUint16(o + 27, true),
          hzCm: view.getUint16(o + 29, true),
        });
        o += 31;
      }

      return {
        type: 'snapshot',
        serverTimeUs,
        serverTick,
        ackInputSeq,
        playerStates,
        projectileStates,
        dynamicBodyStates,
      };
    }
    default:
      throw new Error(`unknown datagram packet kind: ${kind}`);
  }
}

export function parseFramedReliablePackets(
  existingBuffer: Uint8Array,
  incomingChunk: Uint8Array,
): { buffer: Uint8Array; packets: Uint8Array[] } {
  const merged = concatUint8Arrays(existingBuffer, incomingChunk);
  const packets: Uint8Array[] = [];
  let offset = 0;
  const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);

  while (offset + 4 <= merged.length) {
    const length = view.getUint32(offset, true);
    if (length === 0) {
      throw new Error('invalid zero-length reliable frame');
    }
    if (offset + 4 + length > merged.length) {
      break;
    }
    packets.push(merged.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }

  return {
    buffer: merged.slice(offset),
    packets,
  };
}

export function buildInputFrame(seq: number, buttons: number, yaw: number, pitch: number): InputFrame {
  const moveX = ((buttons & BTN_RIGHT) !== 0 ? 127 : 0) + ((buttons & BTN_LEFT) !== 0 ? -127 : 0);
  const moveY = ((buttons & BTN_FORWARD) !== 0 ? 127 : 0) + ((buttons & BTN_BACK) !== 0 ? -127 : 0);
  return {
    seq: seq & 0xffff,
    buttons: buttons & 0xffff,
    moveX,
    moveY,
    yaw,
    pitch,
  };
}

export function netPlayerStateToMeters(state: NetPlayerState): PlayerStateMeters {
  return {
    position: [mmToMeters(state.pxMm), mmToMeters(state.pyMm), mmToMeters(state.pzMm)],
    velocity: [cmsToMetersPerSecond(state.vxCms), cmsToMetersPerSecond(state.vyCms), cmsToMetersPerSecond(state.vzCms)],
    yaw: i16ToAngle(state.yawI16),
    pitch: i16ToAngle(state.pitchI16),
    flags: state.flags,
  };
}

export function netProjectileStateToMeters(state: NetProjectileState): ProjectileStateMeters {
  return {
    position: [mmToMeters(state.pxMm), mmToMeters(state.pyMm), mmToMeters(state.pzMm)],
    velocity: [cmsToMetersPerSecond(state.vxCms), cmsToMetersPerSecond(state.vyCms), cmsToMetersPerSecond(state.vzCms)],
    kind: state.kind,
    ownerId: state.ownerId,
    sourceShotId: state.sourceShotId,
  };
}

export function netDynamicBodyStateToMeters(state: NetDynamicBodyState): DynamicBodyStateMeters {
  return {
    id: state.id,
    shapeType: state.shapeType,
    position: [mmToMeters(state.pxMm), mmToMeters(state.pyMm), mmToMeters(state.pzMm)],
    quaternion: [
      snorm16ToF32(state.qxSnorm),
      snorm16ToF32(state.qySnorm),
      snorm16ToF32(state.qzSnorm),
      snorm16ToF32(state.qwSnorm),
    ],
    halfExtents: [state.hxCm / 100, state.hyCm / 100, state.hzCm / 100],
  };
}

export function mmToMeters(value: number): number {
  return value / 1000;
}

export function cmsToMetersPerSecond(value: number): number {
  return value / 100;
}

export function metersToMm(value: number): number {
  return Math.round(value * 1000);
}

export function angleToI16(angleRad: number): number {
  const tau = Math.PI * 2;
  const normalized = ((((angleRad % tau) + tau) % tau) / tau) * 65535;
  const u16 = Math.round(normalized) & 0xffff;
  return u16 > 0x7fff ? u16 - 0x10000 : u16;
}

export function i16ToAngle(encoded: number): number {
  const u16 = encoded & 0xffff;
  return (u16 / 65535) * Math.PI * 2;
}

export function f32ToSnorm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * 32767);
}

export function snorm16ToF32(value: number): number {
  return Math.max(-1, Math.min(1, value / 32767));
}

export function aimDirectionFromAngles(yaw: number, pitch: number): [number, number, number] {
  const cosPitch = Math.cos(pitch);
  return normalizeVec3([
    Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    Math.cos(yaw) * cosPitch,
  ]);
}

export function normalizeVec3(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= 1e-6) {
    return [0, 0, 1];
  }
  return [value[0] / length, value[1] / length, value[2] / length];
}

export function clampI8(value: number): number {
  return Math.max(-127, Math.min(127, Math.round(value)));
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function getUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 2 ** 32 + low;
}

function decodeChunkFullPacket(data: ArrayBuffer | Uint8Array): ChunkFullPacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const chunk: [number, number, number] = [
    view.getInt16(o, true),
    view.getInt16(o + 2, true),
    view.getInt16(o + 4, true),
  ];
  o += 6;
  const version = view.getUint32(o, true);
  o += 4;
  const blockCount = view.getUint16(o, true);
  o += 2;

  const blocks: BlockCell[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    blocks.push({
      x: view.getUint8(o++),
      y: view.getUint8(o++),
      z: view.getUint8(o++),
      material: view.getUint16(o, true),
    });
    o += 2;
  }

  return {
    type: 'chunkFull',
    chunk,
    version,
    blocks,
  };
}

function decodeChunkDiffPacket(data: ArrayBuffer | Uint8Array): ChunkDiffPacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const chunk: [number, number, number] = [
    view.getInt16(o, true),
    view.getInt16(o + 2, true),
    view.getInt16(o + 4, true),
  ];
  o += 6;
  const version = view.getUint32(o, true);
  o += 4;
  const editCount = view.getUint8(o++);

  const edits: BlockEditNet[] = [];
  for (let i = 0; i < editCount; i += 1) {
    edits.push({
      x: view.getUint8(o++),
      y: view.getUint8(o++),
      z: view.getUint8(o++),
      op: view.getUint8(o++),
      material: view.getUint16(o, true),
    });
    o += 2;
  }

  return {
    type: 'chunkDiff',
    chunk,
    version,
    edits,
  };
}

export function bytesFromHex(hex: string): Uint8Array {
  const normalized = hex.trim().replace(/^0x/, '').toLowerCase();
  if (normalized.length % 2 !== 0) {
    throw new Error('hex string length must be even');
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('invalid hex string');
    }
    out[i] = byte;
  }
  return out;
}

export function stringFromBytes(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

const PKT_PING = 110;
const PKT_PONG = 111;
const PKT_BLOCK_EDIT = 4;

export function decodeServerPacket(data: ArrayBuffer | Uint8Array): ServerPacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);

  switch (kind) {
    case PKT_WELCOME:
    case PKT_SHOT_RESULT:
      return decodeServerReliablePacket(data);
    case PKT_SNAPSHOT:
      return decodeServerDatagramPacket(data);
    case PKT_CHUNK_FULL:
      return decodeChunkFullPacket(data);
    case PKT_CHUNK_DIFF:
      return decodeChunkDiffPacket(data);
    case PKT_PING:
      return { type: 'serverPing', value: view.getUint32(1, true) };
    case PKT_PONG:
      return { type: 'pong', value: view.getUint32(1, true) };
    default:
      throw new Error(`unknown server packet kind: ${kind}`);
  }
}

export function encodeInputPacket(cmd: InputCmd): Uint8Array {
  return encodeInputBundle([cmd]);
}

export function encodeBlockEditPacket(cmd: BlockEditCmd): Uint8Array {
  const out = new Uint8Array(1 + 6 + 4 + 3 + 1 + 2);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_BLOCK_EDIT);
  view.setInt16(o, cmd.chunk[0], true); o += 2;
  view.setInt16(o, cmd.chunk[1], true); o += 2;
  view.setInt16(o, cmd.chunk[2], true); o += 2;
  view.setUint32(o, cmd.expectedVersion, true); o += 4;
  view.setUint8(o++, cmd.local[0]);
  view.setUint8(o++, cmd.local[1]);
  view.setUint8(o++, cmd.local[2]);
  view.setUint8(o++, cmd.op);
  view.setUint16(o, cmd.material, true);
  return out;
}

export function encodePingPacket(nonce: number): Uint8Array {
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_PING);
  view.setUint32(1, nonce >>> 0, true);
  return out;
}

export const netStateToMeters = netPlayerStateToMeters;
