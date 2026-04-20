import type { ObservedPlayer } from '../bots/types';
import {
  FLAG_DEAD,
  FLAG_IN_VEHICLE,
  i16ToAngle,
  netStateToMeters,
  q2_5mmToMeters,
  type PlayerStateMeters,
  type ServerDatagramPacket,
  type ServerReliablePacket,
} from '../net/protocol';

export type BotSnapshotState = {
  playerId: number;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
};

function applySnapshotV1(state: BotSnapshotState, packet: Extract<ServerReliablePacket | ServerDatagramPacket, { type: 'snapshot' }>): void {
  state.remotePlayers.clear();
  for (const playerState of packet.playerStates) {
    const meters = netStateToMeters(playerState);
    if (playerState.id === state.playerId) {
      state.localState = meters;
    } else {
      state.remotePlayers.set(playerState.id, {
        id: playerState.id,
        position: [meters.position[0], meters.position[1], meters.position[2]],
        isDead: (meters.flags & FLAG_DEAD) !== 0,
        velocity: [meters.velocity[0], meters.velocity[1], meters.velocity[2]],
        isInVehicle: (meters.flags & FLAG_IN_VEHICLE) !== 0,
      });
    }
  }
}

function applySnapshotV2(state: BotSnapshotState, packet: Extract<ServerDatagramPacket, { type: 'snapshotV2' }>): void {
  const anchorPos: [number, number, number] = [
    packet.anchorPxMm / 1000,
    packet.anchorPyMm / 1000,
    packet.anchorPzMm / 1000,
  ];

  state.localState = {
    position: anchorPos,
    velocity: [
      packet.selfState.vxCms / 100,
      packet.selfState.vyCms / 100,
      packet.selfState.vzCms / 100,
    ],
    yaw: i16ToAngle(packet.selfState.yawI16),
    pitch: i16ToAngle(packet.selfState.pitchI16),
    hp: packet.selfState.hp,
    flags: packet.selfState.flags,
  };

  state.remotePlayers.clear();
  for (const player of packet.remotePlayers) {
    const id = player.handle;
    state.remotePlayers.set(id, {
      id,
      position: [
        anchorPos[0] + q2_5mmToMeters(player.dxQ2_5mm),
        anchorPos[1] + q2_5mmToMeters(player.dyQ2_5mm),
        anchorPos[2] + q2_5mmToMeters(player.dzQ2_5mm),
      ],
      isDead: (player.flags & FLAG_DEAD) !== 0,
      velocity: [
        player.vxCms / 100,
        player.vyCms / 100,
        player.vzCms / 100,
      ],
      isInVehicle: (player.flags & FLAG_IN_VEHICLE) !== 0,
    });
  }
}

export function applyBotSnapshotState(
  state: BotSnapshotState,
  packet: ServerReliablePacket | ServerDatagramPacket,
): boolean {
  switch (packet.type) {
    case 'snapshot':
      applySnapshotV1(state, packet);
      return true;
    case 'snapshotV2':
      applySnapshotV2(state, packet);
      return true;
    default:
      return false;
  }
}
