/**
 * Server packets decoded by the shared Rust decoder (shared/src/net_client.rs), the one the Unreal
 * client links natively, through the shared WASM package. Behind a flag (`?sharedDecode=1` or
 * `VITE_SHARED_DECODE=1`): protocol.ts keeps its own decoders until this one is the default.
 * sharedDecode.test.ts holds the two equal on every SnapshotV2 shape the server sends.
 *
 * The WASM side returns the wire integers (net_client::snapshot_v2_flat); this file builds the
 * same objects decodeSnapshotV2Packet does, with the same unit conversions, so the numbers are
 * bit-identical.
 */
import { coreFlag } from '../core/coreFlags';
import { decode_server_packet_flat, decode_snapshot_v2_flat } from '../wasm/pkg/vibe_land_shared.js';
import {
  PKT_DAMAGE_EVENT,
  PKT_DYNAMIC_BODY_META,
  PKT_LOCAL_PLAYER_ENERGY,
  PKT_PING,
  PKT_PLAYER_ROSTER,
  PKT_PONG,
  PKT_SHOT_FIRED,
  PKT_SHOT_RESULT,
  PKT_WELCOME,
} from './sharedConstants';
import {
  SERVER_TICK_US,
  type ServerReliablePacket,
  SNAPSHOT_V2_REMOVAL_VEHICLE_BIT,
  type DynamicBoxStateV2,
  type DynamicSphereStateV2,
  type RemotePlayerStateV2,
  type SelfPlayerStateV2,
  type SnapshotRemovalV2,
  type SnapshotV2Packet,
  type VehicleStateV2,
} from './protocol';

/** Whether the shared decoder is on: by default; off with `?sharedDecode=0` or `VITE_SHARED_DECODE=0`. */
export function sharedDecodeEnabled(): boolean {
  return coreFlag('sharedDecode', import.meta.env?.VITE_SHARED_DECODE);
}

/** Decode a SnapshotV2 packet (its kind byte first) with the shared decoder. */
export function decodeSnapshotV2Shared(bytes: Uint8Array): SnapshotV2Packet {
  const f = decode_snapshot_v2_flat(bytes);
  let o = 0;
  const serverTick = f[o++];
  const ackInputSeq = f[o++];
  const anchorPxMm = f[o++];
  const anchorPyMm = f[o++];
  const anchorPzMm = f[o++];
  const wall = f[o++];
  const remoteCount = f[o++];
  const sphereCount = f[o++];
  const boxCount = f[o++];
  const vehicleCount = f[o++];
  const removalCount = f[o++];
  const queueDepth = f[o++];
  const queueTarget = f[o++];

  const selfState: SelfPlayerStateV2 = {
    vxCms: f[o],
    vyCms: f[o + 1],
    vzCms: f[o + 2],
    yawI16: f[o + 3],
    pitchI16: f[o + 4],
    hp: f[o + 5],
    flags: f[o + 6],
    supportHandle: f[o + 7],
    supportLocalPosition: [f[o + 8] / 400, f[o + 9] / 400, f[o + 10] / 400],
    supportVelocity: [f[o + 11] / 100, f[o + 12] / 100, f[o + 13] / 100],
    supportFlags: f[o + 14],
    supportAngularVelocity: [f[o + 15] / 1000, f[o + 16] / 1000, f[o + 17] / 1000],
  };
  o += 18;

  const remotePlayers: RemotePlayerStateV2[] = [];
  for (let i = 0; i < remoteCount; i += 1, o += 11) {
    remotePlayers.push({
      handle: f[o],
      dxQ2_5mm: f[o + 1],
      dyQ2_5mm: f[o + 2],
      dzQ2_5mm: f[o + 3],
      vxCms: f[o + 4],
      vyCms: f[o + 5],
      vzCms: f[o + 6],
      yawI16: f[o + 7],
      pitchI16: f[o + 8],
      hp: f[o + 9],
      flags: f[o + 10],
    });
  }
  const sphereStates: DynamicSphereStateV2[] = [];
  for (let i = 0; i < sphereCount; i += 1, o += 10) {
    sphereStates.push({
      handle: f[o],
      dxQ2_5mm: f[o + 1],
      dyQ2_5mm: f[o + 2],
      dzQ2_5mm: f[o + 3],
      vxCms: f[o + 4],
      vyCms: f[o + 5],
      vzCms: f[o + 6],
      wxMrads: f[o + 7],
      wyMrads: f[o + 8],
      wzMrads: f[o + 9],
    });
  }
  const boxStates: DynamicBoxStateV2[] = [];
  for (let i = 0; i < boxCount; i += 1, o += 14) {
    boxStates.push({
      handle: f[o],
      dxQ2_5mm: f[o + 1],
      dyQ2_5mm: f[o + 2],
      dzQ2_5mm: f[o + 3],
      qxSnorm: f[o + 4],
      qySnorm: f[o + 5],
      qzSnorm: f[o + 6],
      qwSnorm: f[o + 7],
      vxCms: f[o + 8],
      vyCms: f[o + 9],
      vzCms: f[o + 10],
      wxMrads: f[o + 11],
      wyMrads: f[o + 12],
      wzMrads: f[o + 13],
    });
  }
  const vehicleStates: VehicleStateV2[] = [];
  for (let i = 0; i < vehicleCount; i += 1, o += 17) {
    vehicleStates.push({
      handle: f[o],
      vehicleType: f[o + 1],
      driverHandle: f[o + 2],
      flags: f[o + 3],
      dxQ2_5mm: f[o + 4],
      dyQ2_5mm: f[o + 5],
      dzQ2_5mm: f[o + 6],
      qxSnorm: f[o + 7],
      qySnorm: f[o + 8],
      qzSnorm: f[o + 9],
      qwSnorm: f[o + 10],
      vxCms: f[o + 11],
      vyCms: f[o + 12],
      vzCms: f[o + 13],
      wxMrads: f[o + 14],
      wyMrads: f[o + 15],
      wzMrads: f[o + 16],
    });
  }
  let removals: SnapshotRemovalV2[] | undefined;
  if (removalCount >= 0) {
    removals = [];
    for (let i = 0; i < removalCount; i += 1, o += 2) {
      const raw = f[o];
      removals.push({
        handle: raw & ~SNAPSHOT_V2_REMOVAL_VEHICLE_BIT & 0xffff,
        vehicle: (raw & SNAPSHOT_V2_REMOVAL_VEHICLE_BIT) !== 0,
        removedTick: serverTick - f[o + 1],
      });
    }
  }

  return {
    type: 'snapshotV2',
    serverTimeUs: serverTick * SERVER_TICK_US,
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
    serverWallUs: wall >= 0 ? wall : null,
    ...(removals ? { removals } : {}),
    ...(queueDepth >= 0 ? { inputQueue: { depth: queueDepth, target: queueTarget } } : {}),
  };
}

/**
 * Decode a reliable server packet (its kind byte first) with the shared decoder: Welcome, ShotResult,
 * ShotFired, DamageEvent, LocalPlayerEnergy, PlayerRoster, DynamicBodyMeta, Ping, Pong. Null for
 * any other kind, which protocol.ts decodes itself.
 */
export function decodeServerPacketShared(bytes: Uint8Array): ServerReliablePacket | null {
  const f = decode_server_packet_flat(bytes);
  if (!f) return null;
  switch (f[0]) {
    case PKT_WELCOME:
      return {
        type: 'welcome',
        playerId: f[1],
        protocolVersion: f[2],
        physicsBackend: f[3],
        clientMovementMode: f[4],
        simHz: f[5],
        snapshotHz: f[6],
        serverTimeUs: f[7],
        interpolationDelayMs: f[8],
      };
    case PKT_SHOT_RESULT:
      return {
        type: 'shotResult',
        shotId: f[1],
        weapon: f[2],
        confirmed: f[3] !== 0,
        hitPlayerId: f[4],
        hitZone: f[5],
        serverResolution: f[6],
        serverDynamicBodyId: f[7],
        serverDynamicHitToiCm: f[8],
        serverDynamicImpulseCenti: f[9],
      };
    case PKT_SHOT_FIRED:
      return {
        type: 'shotFired',
        shooterPlayerId: f[1],
        shotId: f[2],
        weapon: f[3],
        hitKind: f[4],
        hitZone: f[5],
        serverFireTimeUs: f[6],
        originPxMm: f[7],
        originPyMm: f[8],
        originPzMm: f[9],
        endPxMm: f[10],
        endPyMm: f[11],
        endPzMm: f[12],
      };
    case PKT_DAMAGE_EVENT:
      return {
        type: 'damageEvent',
        attackerPlayerId: f[1],
        damageAmount: f[2],
        hitZone: f[3],
        attackerPosition: [f[4] / 1000, f[5] / 1000, f[6] / 1000],
        serverTimeMs: f[7],
      };
    case PKT_LOCAL_PLAYER_ENERGY:
      return { type: 'localPlayerEnergy', energyCenti: f[1] };
    case PKT_PLAYER_ROSTER: {
      const entries = [];
      for (let i = 0, o = 2; i < f[1]; i += 1, o += 2) entries.push({ handle: f[o], playerId: f[o + 1] });
      return { type: 'playerRoster', entries };
    }
    case PKT_DYNAMIC_BODY_META: {
      const entries = [];
      for (let i = 0, o = 2; i < f[1]; i += 1, o += 6) {
        entries.push({
          handle: f[o],
          bodyId: f[o + 1],
          shapeType: f[o + 2],
          halfExtents: [f[o + 3] / 100, f[o + 4] / 100, f[o + 5] / 100] as [number, number, number],
        });
      }
      return { type: 'dynamicBodyMeta', entries };
    }
    case PKT_PING:
      return { type: 'serverPing', value: f[1] };
    case PKT_PONG:
      return { type: 'pong', value: f[1] };
    default:
      return null;
  }
}
