// All protocol constants are generated from shared/src/constants.rs.
// Regenerate with: node scripts/gen-constants.mjs
export * from './sharedConstants';
import {
  PKT_CLIENT_HELLO,
  PKT_INPUT_BUNDLE,
  PKT_FIRE,
  PKT_BLOCK_EDIT,
  PKT_VEHICLE_ENTER,
  PKT_VEHICLE_EXIT,
  PKT_DEBUG_STATS,
  PKT_WELCOME,
  PKT_SNAPSHOT,
  PKT_SNAPSHOT_V2,
  PKT_SHOT_RESULT,
  PKT_SHOT_TRACE,
  PKT_CHUNK_FULL,
  PKT_CHUNK_DIFF,
  PKT_PLAYER_ROSTER,
  PKT_DYNAMIC_BODY_META,
  PKT_PING,
  PKT_PONG,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
} from './sharedConstants';

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
  clientFireTimeUs: number;
  clientInterpMs: number;
  clientDynamicInterpMs: number;
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
  hp: number;
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
  vxCms: number;
  vyCms: number;
  vzCms: number;
  wxMrads: number;
  wyMrads: number;
  wzMrads: number;
};

export type DynamicBodyStateMeters = {
  id: number;
  shapeType: number;
  position: [number, number, number];
  quaternion: [number, number, number, number]; // x, y, z, w
  halfExtents: [number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
};

export type WelcomePacket = {
  type: 'welcome';
  playerId: number;
  simHz: number;
  snapshotHz: number;
  serverTimeUs: number;
  interpolationDelayMs: number;
};

export type NetVehicleState = {
  id: number;
  vehicleType: number;
  flags: number;
  driverId: number;
  pxMm: number;
  pyMm: number;
  pzMm: number;
  qxSnorm: number;
  qySnorm: number;
  qzSnorm: number;
  qwSnorm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  wxMrads: number;
  wyMrads: number;
  wzMrads: number;
  wheelData: [number, number, number, number];
};

export type VehicleStateMeters = {
  id: number;
  vehicleType: number;
  flags: number;
  driverId: number;
  position: [number, number, number];
  quaternion: [number, number, number, number]; // x, y, z, w
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  wheelData: [number, number, number, number];
};

export type SnapshotPacket = {
  type: 'snapshot';
  serverTimeUs: number;
  serverTick: number;
  ackInputSeq: number;
  playerStates: NetPlayerState[];
  projectileStates: NetProjectileState[];
  dynamicBodyStates: NetDynamicBodyState[];
  vehicleStates: NetVehicleState[];
};

export type PlayerRosterEntry = {
  handle: number;
  playerId: number;
};

export type PlayerRosterPacket = {
  type: 'playerRoster';
  entries: PlayerRosterEntry[];
};

export type DynamicBodyMetaEntry = {
  handle: number;
  bodyId: number;
  shapeType: number;
  halfExtents: [number, number, number];
};

export type DynamicBodyMetaPacket = {
  type: 'dynamicBodyMeta';
  entries: DynamicBodyMetaEntry[];
};

export type SelfPlayerStateV2 = {
  vxCms: number;
  vyCms: number;
  vzCms: number;
  yawI16: number;
  pitchI16: number;
  hp: number;
  flags: number;
};

export type RemotePlayerStateV2 = {
  handle: number;
  dxQ2_5mm: number;
  dyQ2_5mm: number;
  dzQ2_5mm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  yawI16: number;
  pitchI16: number;
  hp: number;
  flags: number;
};

export type DynamicSphereStateV2 = {
  handle: number;
  dxQ2_5mm: number;
  dyQ2_5mm: number;
  dzQ2_5mm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  wxMrads: number;
  wyMrads: number;
  wzMrads: number;
};

export type DynamicBoxStateV2 = {
  handle: number;
  dxQ2_5mm: number;
  dyQ2_5mm: number;
  dzQ2_5mm: number;
  qxSnorm: number;
  qySnorm: number;
  qzSnorm: number;
  qwSnorm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  wxMrads: number;
  wyMrads: number;
  wzMrads: number;
};

export type VehicleStateV2 = {
  handle: number;
  vehicleType: number;
  driverHandle: number;
  flags: number;
  dxQ2_5mm: number;
  dyQ2_5mm: number;
  dzQ2_5mm: number;
  qxSnorm: number;
  qySnorm: number;
  qzSnorm: number;
  qwSnorm: number;
  vxCms: number;
  vyCms: number;
  vzCms: number;
  wxMrads: number;
  wyMrads: number;
  wzMrads: number;
};

export type SnapshotV2Packet = {
  type: 'snapshotV2';
  serverTimeUs: number;
  serverTick: number;
  ackInputSeq: number;
  anchorPxMm: number;
  anchorPyMm: number;
  anchorPzMm: number;
  selfState: SelfPlayerStateV2;
  remotePlayers: RemotePlayerStateV2[];
  sphereStates: DynamicSphereStateV2[];
  boxStates: DynamicBoxStateV2[];
  vehicleStates: VehicleStateV2[];
};

export type ShotResultPacket = {
  type: 'shotResult';
  shotId: number;
  weapon: number;
  confirmed: boolean;
  hitPlayerId: number;
  hitZone: number;
  serverResolution: number;
  serverDynamicBodyId: number;
  serverDynamicHitToiCm: number;
  serverDynamicImpulseCenti: number;
};

export type ShotTracePacket = {
  type: 'shotTrace';
  shooterPlayerId: number;
  shotId: number;
  weapon: number;
  traceKind: number;
  originPxMm: number;
  originPyMm: number;
  originPzMm: number;
  endPxMm: number;
  endPyMm: number;
  endPzMm: number;
};

export type ServerReliablePacket =
  | WelcomePacket
  | ShotResultPacket
  | ShotTracePacket
  | ChunkFullPacket
  | ChunkDiffPacket
  | SnapshotPacket
  | PlayerRosterPacket
  | DynamicBodyMetaPacket
  | ServerPingPacket
  | PongPacket;
export type ServerDatagramPacket = SnapshotPacket | SnapshotV2Packet;

export type ServerPingPacket = { type: 'serverPing'; value: number };
export type PongPacket = { type: 'pong'; value: number };
export type ServerWorldPacket = ChunkFullPacket | ChunkDiffPacket;
export type ServerPacket =
  | WelcomePacket
  | SnapshotPacket
  | SnapshotV2Packet
  | ShotResultPacket
  | ShotTracePacket
  | ChunkFullPacket
  | ChunkDiffPacket
  | PlayerRosterPacket
  | DynamicBodyMetaPacket
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
  hp: number;
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
  const out = new Uint8Array(1 + 2 + 4 + 1 + 8 + 2 + 2 + 2 + 2 + 2);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_FIRE);
  view.setUint16(o, packet.seq & 0xffff, true); o += 2;
  view.setUint32(o, packet.shotId >>> 0, true); o += 4;
  view.setUint8(o++, packet.weapon & 0xff);
  setUint64(view, o, packet.clientFireTimeUs); o += 8;
  view.setUint16(o, packet.clientInterpMs & 0xffff, true); o += 2;
  view.setUint16(o, packet.clientDynamicInterpMs & 0xffff, true); o += 2;
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
      const hitPlayerId = view.getUint32(o, true); o += 4;
      const hitZone = view.getUint8(o++);
      const serverResolution = view.getUint8(o++);
      const serverDynamicBodyId = view.getUint32(o, true); o += 4;
      const serverDynamicHitToiCm = view.getUint16(o, true); o += 2;
      const serverDynamicImpulseCenti = view.getUint16(o, true); o += 2;
      return {
        type: 'shotResult',
        shotId,
        weapon,
        confirmed,
        hitPlayerId,
        hitZone,
        serverResolution,
        serverDynamicBodyId,
        serverDynamicHitToiCm,
        serverDynamicImpulseCenti,
      };
    }
    case PKT_SHOT_TRACE: {
      const shooterPlayerId = view.getUint32(o, true); o += 4;
      const shotId = view.getUint32(o, true); o += 4;
      const weapon = view.getUint8(o++);
      const traceKind = view.getUint8(o++);
      const originPxMm = view.getInt32(o, true); o += 4;
      const originPyMm = view.getInt32(o, true); o += 4;
      const originPzMm = view.getInt32(o, true); o += 4;
      const endPxMm = view.getInt32(o, true); o += 4;
      const endPyMm = view.getInt32(o, true); o += 4;
      const endPzMm = view.getInt32(o, true); o += 4;
      return {
        type: 'shotTrace',
        shooterPlayerId,
        shotId,
        weapon,
        traceKind,
        originPxMm,
        originPyMm,
        originPzMm,
        endPxMm,
        endPyMm,
        endPzMm,
      };
    }
    case PKT_CHUNK_FULL:
      return decodeChunkFullPacket(data);
    case PKT_CHUNK_DIFF:
      return decodeChunkDiffPacket(data);
    case PKT_PLAYER_ROSTER:
      return decodePlayerRosterPacket(view, o);
    case PKT_DYNAMIC_BODY_META:
      return decodeDynamicBodyMetaPacket(view, o);
    case PKT_SNAPSHOT:
      // Snapshots fall back to the reliable stream when too large for a QUIC datagram
      return decodeSnapshotPacket(view, o);
    case PKT_PING:
      return { type: 'serverPing', value: view.getUint32(o, true) };
    case PKT_PONG:
      return { type: 'pong', value: view.getUint32(o, true) };
    default:
      throw new Error(`unknown reliable packet kind: ${kind}`);
  }
}

/** Decode the snapshot body starting at byte offset `o` (after the type byte). */
export function decodeSnapshotPacket(view: DataView, o: number): SnapshotPacket {
  const serverTimeUs = getUint64(view, o); o += 8;
  const serverTick = view.getUint32(o, true); o += 4;
  const ackInputSeq = view.getUint16(o, true); o += 2;
  const playerCount = view.getUint16(o, true); o += 2;
  const projectileCount = view.getUint16(o, true); o += 2;
  const dynamicBodyCount = view.getUint16(o, true); o += 2;
  const vehicleCount = view.getUint16(o, true); o += 2;

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
      hp: view.getUint8(o + 26),
      flags: view.getUint16(o + 27, true),
    });
    o += 29;
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
      vxCms: view.getInt16(o + 31, true),
      vyCms: view.getInt16(o + 33, true),
      vzCms: view.getInt16(o + 35, true),
      wxMrads: view.getInt16(o + 37, true),
      wyMrads: view.getInt16(o + 39, true),
      wzMrads: view.getInt16(o + 41, true),
    });
    o += 43;
  }

  const vehicleStates: NetVehicleState[] = [];
  for (let i = 0; i < vehicleCount; i += 1) {
    vehicleStates.push({
      id: view.getUint32(o, true),
      vehicleType: view.getUint8(o + 4),
      flags: view.getUint8(o + 5),
      driverId: view.getUint32(o + 6, true),
      pxMm: view.getInt32(o + 10, true),
      pyMm: view.getInt32(o + 14, true),
      pzMm: view.getInt32(o + 18, true),
      qxSnorm: view.getInt16(o + 22, true),
      qySnorm: view.getInt16(o + 24, true),
      qzSnorm: view.getInt16(o + 26, true),
      qwSnorm: view.getInt16(o + 28, true),
      vxCms: view.getInt16(o + 30, true),
      vyCms: view.getInt16(o + 32, true),
      vzCms: view.getInt16(o + 34, true),
      wxMrads: view.getInt16(o + 36, true),
      wyMrads: view.getInt16(o + 38, true),
      wzMrads: view.getInt16(o + 40, true),
      wheelData: [
        view.getUint16(o + 42, true),
        view.getUint16(o + 44, true),
        view.getUint16(o + 46, true),
        view.getUint16(o + 48, true),
      ],
    });
    o += 50;
  }

  return {
    type: 'snapshot',
    serverTimeUs,
    serverTick,
    ackInputSeq,
    playerStates,
    projectileStates,
    dynamicBodyStates,
    vehicleStates,
  };
}

export function decodeSnapshotV2Packet(view: DataView, o: number): SnapshotV2Packet {
  const serverTick = view.getUint32(o, true); o += 4;
  const ackInputSeq = view.getUint16(o, true); o += 2;
  const anchorPxMm = view.getInt32(o, true); o += 4;
  const anchorPyMm = view.getInt32(o, true); o += 4;
  const anchorPzMm = view.getInt32(o, true); o += 4;
  const remotePlayerCount = view.getUint8(o++);
  const sphereCount = view.getUint8(o++);
  const boxCount = view.getUint8(o++);
  const vehicleCount = view.getUint8(o++);

  const selfState: SelfPlayerStateV2 = {
    vxCms: view.getInt16(o, true),
    vyCms: view.getInt16(o + 2, true),
    vzCms: view.getInt16(o + 4, true),
    yawI16: view.getInt16(o + 6, true),
    pitchI16: view.getInt16(o + 8, true),
    hp: view.getUint8(o + 10),
    flags: view.getUint8(o + 11),
  };
  o += 12;

  const remotePlayers: RemotePlayerStateV2[] = [];
  for (let i = 0; i < remotePlayerCount; i += 1) {
    remotePlayers.push({
      handle: view.getUint8(o),
      dxQ2_5mm: view.getInt16(o + 1, true),
      dyQ2_5mm: view.getInt16(o + 3, true),
      dzQ2_5mm: view.getInt16(o + 5, true),
      vxCms: view.getInt16(o + 7, true),
      vyCms: view.getInt16(o + 9, true),
      vzCms: view.getInt16(o + 11, true),
      yawI16: view.getInt16(o + 13, true),
      pitchI16: view.getInt16(o + 15, true),
      hp: view.getUint8(o + 17),
      flags: view.getUint8(o + 18),
    });
    o += 19;
  }

  const sphereStates: DynamicSphereStateV2[] = [];
  for (let i = 0; i < sphereCount; i += 1) {
    sphereStates.push({
      handle: view.getUint16(o, true),
      dxQ2_5mm: view.getInt16(o + 2, true),
      dyQ2_5mm: view.getInt16(o + 4, true),
      dzQ2_5mm: view.getInt16(o + 6, true),
      vxCms: view.getInt16(o + 8, true),
      vyCms: view.getInt16(o + 10, true),
      vzCms: view.getInt16(o + 12, true),
      wxMrads: view.getInt16(o + 14, true),
      wyMrads: view.getInt16(o + 16, true),
      wzMrads: view.getInt16(o + 18, true),
    });
    o += 20;
  }

  const boxStates: DynamicBoxStateV2[] = [];
  for (let i = 0; i < boxCount; i += 1) {
    boxStates.push({
      handle: view.getUint16(o, true),
      dxQ2_5mm: view.getInt16(o + 2, true),
      dyQ2_5mm: view.getInt16(o + 4, true),
      dzQ2_5mm: view.getInt16(o + 6, true),
      qxSnorm: view.getInt16(o + 8, true),
      qySnorm: view.getInt16(o + 10, true),
      qzSnorm: view.getInt16(o + 12, true),
      qwSnorm: view.getInt16(o + 14, true),
      vxCms: view.getInt16(o + 16, true),
      vyCms: view.getInt16(o + 18, true),
      vzCms: view.getInt16(o + 20, true),
      wxMrads: view.getInt16(o + 22, true),
      wyMrads: view.getInt16(o + 24, true),
      wzMrads: view.getInt16(o + 26, true),
    });
    o += 28;
  }

  const vehicleStates: VehicleStateV2[] = [];
  for (let i = 0; i < vehicleCount; i += 1) {
    vehicleStates.push({
      handle: view.getUint8(o),
      vehicleType: view.getUint8(o + 1),
      driverHandle: view.getUint8(o + 2),
      flags: view.getUint8(o + 3),
      dxQ2_5mm: view.getInt16(o + 4, true),
      dyQ2_5mm: view.getInt16(o + 6, true),
      dzQ2_5mm: view.getInt16(o + 8, true),
      qxSnorm: view.getInt16(o + 10, true),
      qySnorm: view.getInt16(o + 12, true),
      qzSnorm: view.getInt16(o + 14, true),
      qwSnorm: view.getInt16(o + 16, true),
      vxCms: view.getInt16(o + 18, true),
      vyCms: view.getInt16(o + 20, true),
      vzCms: view.getInt16(o + 22, true),
      wxMrads: view.getInt16(o + 24, true),
      wyMrads: view.getInt16(o + 26, true),
      wzMrads: view.getInt16(o + 28, true),
    });
    o += 30;
  }

  return {
    type: 'snapshotV2',
    serverTimeUs: serverTick * Math.round(1_000_000 / 60),
    serverTick,
    ackInputSeq,
    anchorPxMm,
    anchorPyMm,
    anchorPzMm,
    selfState,
    remotePlayers,
    sphereStates,
    boxStates,
    vehicleStates,
  };
}

function decodePlayerRosterPacket(view: DataView, o: number): PlayerRosterPacket {
  const count = view.getUint8(o++);
  const entries: PlayerRosterEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      handle: view.getUint8(o),
      playerId: view.getUint32(o + 1, true),
    });
    o += 5;
  }
  return { type: 'playerRoster', entries };
}

function decodeDynamicBodyMetaPacket(view: DataView, o: number): DynamicBodyMetaPacket {
  const count = view.getUint16(o, true); o += 2;
  const entries: DynamicBodyMetaEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      handle: view.getUint16(o, true),
      bodyId: view.getUint32(o + 2, true),
      shapeType: view.getUint8(o + 6),
      halfExtents: [
        view.getUint16(o + 7, true) / 100,
        view.getUint16(o + 9, true) / 100,
        view.getUint16(o + 11, true) / 100,
      ],
    });
    o += 13;
  }
  return { type: 'dynamicBodyMeta', entries };
}

export function decodeServerDatagramPacket(data: ArrayBuffer | Uint8Array): ServerDatagramPacket {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const kind = view.getUint8(o++);

  switch (kind) {
    case PKT_SNAPSHOT:
      return decodeSnapshotPacket(view, o);
    case PKT_SNAPSHOT_V2:
      return decodeSnapshotV2Packet(view, o);
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
    hp: state.hp,
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
    velocity: [state.vxCms / 100, state.vyCms / 100, state.vzCms / 100],
    angularVelocity: [state.wxMrads / 1000, state.wyMrads / 1000, state.wzMrads / 1000],
  };
}

export function netVehicleStateToMeters(state: NetVehicleState): VehicleStateMeters {
  return {
    id: state.id,
    vehicleType: state.vehicleType,
    flags: state.flags,
    driverId: state.driverId,
    position: [mmToMeters(state.pxMm), mmToMeters(state.pyMm), mmToMeters(state.pzMm)],
    quaternion: [
      snorm16ToF32(state.qxSnorm),
      snorm16ToF32(state.qySnorm),
      snorm16ToF32(state.qzSnorm),
      snorm16ToF32(state.qwSnorm),
    ],
    linearVelocity: [
      cmsToMetersPerSecond(state.vxCms),
      cmsToMetersPerSecond(state.vyCms),
      cmsToMetersPerSecond(state.vzCms),
    ],
    angularVelocity: [
      state.wxMrads / 1000,
      state.wyMrads / 1000,
      state.wzMrads / 1000,
    ],
    wheelData: state.wheelData,
  };
}

export function encodeVehicleEnterPacket(vehicleId: number, seat = 0): Uint8Array {
  const out = new Uint8Array(6);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_VEHICLE_ENTER);
  view.setUint32(1, vehicleId >>> 0, true);
  view.setUint8(5, seat & 0xff);
  return out;
}

export function encodeVehicleExitPacket(vehicleId: number): Uint8Array {
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_VEHICLE_EXIT);
  view.setUint32(1, vehicleId >>> 0, true);
  return out;
}

export function mmToMeters(value: number): number {
  return value / 1000;
}

export function q2_5mmToMeters(value: number): number {
  return value * 0.0025;
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

function setUint64(view: DataView, offset: number, value: number): void {
  const normalized = Math.max(0, Math.floor(value));
  const low = normalized >>> 0;
  const high = Math.floor(normalized / 2 ** 32) >>> 0;
  view.setUint32(offset, low, true);
  view.setUint32(offset + 4, high, true);
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
    case PKT_SNAPSHOT_V2:
      return decodeServerDatagramPacket(data);
    case PKT_CHUNK_FULL:
      return decodeChunkFullPacket(data);
    case PKT_CHUNK_DIFF:
      return decodeChunkDiffPacket(data);
    case PKT_PLAYER_ROSTER:
      return decodePlayerRosterPacket(view, 1);
    case PKT_DYNAMIC_BODY_META:
      return decodeDynamicBodyMetaPacket(view, 1);
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

/** Send rolling-average client debug stats to the server (1 Hz). 9 bytes total. */
export function encodeDebugStatsPacket(correctionM: number, physicsStepMs: number): Uint8Array {
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_DEBUG_STATS);
  view.setFloat32(1, correctionM, true);
  view.setFloat32(5, physicsStepMs, true);
  return out;
}

export const netStateToMeters = netPlayerStateToMeters;
