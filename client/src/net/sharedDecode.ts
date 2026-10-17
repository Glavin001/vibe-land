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
import { decode_snapshot_v2_flat } from '../wasm/pkg/vibe_land_shared.js';
import {
  SERVER_TICK_US,
  SNAPSHOT_V2_REMOVAL_VEHICLE_BIT,
  type DynamicBoxStateV2,
  type DynamicSphereStateV2,
  type RemotePlayerStateV2,
  type SelfPlayerStateV2,
  type SnapshotRemovalV2,
  type SnapshotV2Packet,
  type VehicleStateV2,
} from './protocol';

/** Whether the shared decoder is on: `?sharedDecode=1` on the page URL, or `VITE_SHARED_DECODE=1`. */
export function sharedDecodeEnabled(): boolean {
  if (import.meta.env?.VITE_SHARED_DECODE === '1') return true;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('sharedDecode') === '1';
  } catch {
    return false;
  }
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
