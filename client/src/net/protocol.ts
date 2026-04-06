export const PKT_INPUT = 1;
export const PKT_FIRE = 2;
export const PKT_BLOCK_EDIT = 3;
export const PKT_PING = 4;

export const PKT_WELCOME = 101;
export const PKT_SNAPSHOT = 102;
export const PKT_CHUNK_FULL = 103;
export const PKT_CHUNK_DIFF = 104;
export const PKT_SHOT_RESULT = 105;
export const PKT_PONG = 106;
export const PKT_SERVER_PING = 107;

export const BTN_FORWARD = 1 << 0;
export const BTN_BACK = 1 << 1;
export const BTN_LEFT = 1 << 2;
export const BTN_RIGHT = 1 << 3;
export const BTN_JUMP = 1 << 4;
export const BTN_CROUCH = 1 << 5;
export const BTN_SPRINT = 1 << 6;
export const BTN_PRIMARY_FIRE = 1 << 7;
export const BTN_SECONDARY_FIRE = 1 << 8;
export const BTN_RELOAD = 1 << 9;

export const BLOCK_ADD = 1;
export const BLOCK_REMOVE = 2;

export type InputCmd = {
  seq: number;
  clientTick: number;
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
  origin: [number, number, number];
  dir: [number, number, number];
};

export type BlockEditCmd = {
  requestId: number;
  chunk: [number, number, number];
  local: [number, number, number];
  op: number;
  material: number;
  expectedVersion: number;
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
  hp: number;
  flags: number;
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

export type WelcomePacket = {
  type: 'welcome';
  playerId: number;
  simHz: number;
  snapshotHz: number;
  chunkSize: number;
};

export type SnapshotPacket = {
  type: 'snapshot';
  serverTick: number;
  ackInputSeq: number;
  playerStates: NetPlayerState[];
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

export type ShotResultPacket = {
  type: 'shotResult';
  shotId: number;
  hitPlayerId: number;
  damage: number;
  confirmed: boolean;
};

export type PongPacket = {
  type: 'pong';
  value: number;
};

export type ServerPingPacket = {
  type: 'serverPing';
  value: number;
};

export type ServerPacket =
  | WelcomePacket
  | SnapshotPacket
  | ChunkFullPacket
  | ChunkDiffPacket
  | ShotResultPacket
  | PongPacket
  | ServerPingPacket;

export function encodeInputPacket(cmd: InputCmd): Uint8Array {
  const out = new Uint8Array(1 + 2 + 4 + 2 + 1 + 1 + 2 + 2);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_INPUT);
  view.setUint16(o, cmd.seq, true); o += 2;
  view.setUint32(o, cmd.clientTick, true); o += 4;
  view.setUint16(o, cmd.buttons, true); o += 2;
  view.setInt8(o++, clampI8(cmd.moveX));
  view.setInt8(o++, clampI8(cmd.moveY));
  view.setInt16(o, angleToI16(cmd.yaw), true); o += 2;
  view.setInt16(o, angleToI16(cmd.pitch), true);
  return out;
}

export function encodeFirePacket(cmd: FireCmd): Uint8Array {
  const out = new Uint8Array(1 + 2 + 4 + 1 + 2 + 4 * 3 + 2 * 3);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_FIRE);
  view.setUint16(o, cmd.seq, true); o += 2;
  view.setUint32(o, cmd.shotId, true); o += 4;
  view.setUint8(o++, cmd.weapon & 0xff);
  view.setUint16(o, cmd.clientInterpMs, true); o += 2;
  for (const value of cmd.origin) {
    view.setInt32(o, metersToMm(value), true); o += 4;
  }
  for (const value of cmd.dir) {
    view.setInt16(o, f32ToSnorm16(value), true); o += 2;
  }
  return out;
}

export function encodeBlockEditPacket(cmd: BlockEditCmd): Uint8Array {
  const out = new Uint8Array(1 + 4 + 2 * 3 + 3 + 1 + 2 + 4);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_BLOCK_EDIT);
  view.setUint32(o, cmd.requestId, true); o += 4;
  view.setInt16(o, cmd.chunk[0], true); o += 2;
  view.setInt16(o, cmd.chunk[1], true); o += 2;
  view.setInt16(o, cmd.chunk[2], true); o += 2;
  view.setUint8(o++, cmd.local[0]);
  view.setUint8(o++, cmd.local[1]);
  view.setUint8(o++, cmd.local[2]);
  view.setUint8(o++, cmd.op);
  view.setUint16(o, cmd.material, true); o += 2;
  view.setUint32(o, cmd.expectedVersion, true);
  return out;
}

export function encodePingPacket(value: number): Uint8Array {
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_PING);
  view.setUint32(1, value, true);
  return out;
}

export function decodeServerPacket(data: ArrayBuffer | Uint8Array): ServerPacket {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const kind = view.getUint8(o++);

  switch (kind) {
    case PKT_WELCOME: {
      const playerId = view.getUint32(o, true); o += 4;
      const simHz = view.getUint16(o, true); o += 2;
      const snapshotHz = view.getUint16(o, true); o += 2;
      const chunkSize = view.getUint8(o++);
      return { type: 'welcome', playerId, simHz, snapshotHz, chunkSize };
    }
    case PKT_SNAPSHOT: {
      const serverTick = view.getUint32(o, true); o += 4;
      const ackInputSeq = view.getUint16(o, true); o += 2;
      const count = view.getUint16(o, true); o += 2;
      const playerStates: NetPlayerState[] = [];
      for (let i = 0; i < count; i += 1) {
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
          hp: view.getUint8(o + 26),
          flags: view.getUint16(o + 27, true),
        });
        o += 29;
      }
      return { type: 'snapshot', serverTick, ackInputSeq, playerStates };
    }
    case PKT_CHUNK_FULL: {
      const chunk: [number, number, number] = [view.getInt16(o, true), view.getInt16(o + 2, true), view.getInt16(o + 4, true)];
      o += 6;
      const version = view.getUint32(o, true); o += 4;
      const count = view.getUint16(o, true); o += 2;
      const blocks: BlockCell[] = [];
      for (let i = 0; i < count; i += 1) {
        blocks.push({
          x: view.getUint8(o),
          y: view.getUint8(o + 1),
          z: view.getUint8(o + 2),
          material: view.getUint16(o + 3, true),
        });
        o += 5;
      }
      return { type: 'chunkFull', chunk, version, blocks };
    }
    case PKT_CHUNK_DIFF: {
      const chunk: [number, number, number] = [view.getInt16(o, true), view.getInt16(o + 2, true), view.getInt16(o + 4, true)];
      o += 6;
      const version = view.getUint32(o, true); o += 4;
      const count = view.getUint16(o, true); o += 2;
      const edits: BlockEditNet[] = [];
      for (let i = 0; i < count; i += 1) {
        edits.push({
          x: view.getUint8(o),
          y: view.getUint8(o + 1),
          z: view.getUint8(o + 2),
          op: view.getUint8(o + 3),
          material: view.getUint16(o + 4, true),
        });
        o += 6;
      }
      return { type: 'chunkDiff', chunk, version, edits };
    }
    case PKT_SHOT_RESULT: {
      const shotId = view.getUint32(o, true); o += 4;
      const hitPlayerId = view.getUint32(o, true); o += 4;
      const damage = view.getUint16(o, true); o += 2;
      const confirmed = view.getUint8(o) !== 0;
      return { type: 'shotResult', shotId, hitPlayerId, damage, confirmed };
    }
    case PKT_PONG:
      return { type: 'pong', value: view.getUint32(o, true) };
    case PKT_SERVER_PING:
      return { type: 'serverPing', value: view.getUint32(o, true) };
    default:
      throw new Error(`Unknown server packet kind ${kind}`);
  }
}

export function netStateToMeters(state: NetPlayerState) {
  return {
    id: state.id,
    position: [mmToMeters(state.pxMm), mmToMeters(state.pyMm), mmToMeters(state.pzMm)] as [number, number, number],
    velocity: [cmsI16ToMeters(state.vxCms), cmsI16ToMeters(state.vyCms), cmsI16ToMeters(state.vzCms)] as [number, number, number],
    yaw: i16ToAngle(state.yawI16),
    pitch: i16ToAngle(state.pitchI16),
    hp: state.hp,
    flags: state.flags,
  };
}

export function metersToMm(value: number): number {
  return Math.round(value * 1000);
}

export function mmToMeters(value: number): number {
  return value / 1000;
}

export function metersToCmsI16(value: number): number {
  return Math.round(clamp(value, -327.67, 327.67) * 100);
}

export function cmsI16ToMeters(value: number): number {
  return value / 100;
}

export function angleToI16(angleRad: number): number {
  const normalized = ((angleRad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
  const encoded = Math.round(normalized * 65535) & 0xffff;
  return encoded >= 0x8000 ? encoded - 0x10000 : encoded;
}

export function i16ToAngle(value: number): number {
  const u16 = value < 0 ? value + 0x10000 : value;
  return (u16 / 65535) * (Math.PI * 2);
}

export function f32ToSnorm16(value: number): number {
  return Math.round(clamp(value, -1, 1) * 32767);
}

export function snorm16ToF32(value: number): number {
  return clamp(value / 32767, -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampI8(value: number): number {
  return Math.round(clamp(value, -127, 127));
}
