import { describe, expect, it } from 'vitest';
import { applyBotSnapshotState } from './botSnapshot';
import type { ObservedPlayer } from '../bots/types';
import type { PlayerStateMeters, ServerDatagramPacket, ServerReliablePacket } from '../net/protocol';

function makeState(): {
  playerId: number;
  localState: PlayerStateMeters | null;
  remotePlayers: Map<number, ObservedPlayer>;
} {
  return {
    playerId: 7,
    localState: null,
    remotePlayers: new Map<number, ObservedPlayer>([
      [99, {
        id: 99,
        position: [100, 0, 100],
        isDead: false,
      }],
    ]),
  };
}

describe('applyBotSnapshotState', () => {
  it('updates bot state from legacy snapshots', () => {
    const state = makeState();
    const packet: ServerReliablePacket = {
      type: 'snapshot',
      serverTimeUs: 1000,
      serverTick: 10,
      ackInputSeq: 4,
      playerStates: [
        {
          id: 7,
          pxMm: 1000,
          pyMm: 2000,
          pzMm: 3000,
          vxCms: 150,
          vyCms: 0,
          vzCms: -50,
          yawI16: 0,
          pitchI16: 0,
          hp: 90,
          flags: 3,
        },
        {
          id: 8,
          pxMm: 4000,
          pyMm: 1500,
          pzMm: 5000,
          vxCms: 0,
          vyCms: 0,
          vzCms: 0,
          yawI16: 0,
          pitchI16: 0,
          hp: 70,
          flags: 1,
        },
      ],
      projectileStates: [],
      dynamicBodyStates: [],
      vehicleStates: [],
    };

    expect(applyBotSnapshotState(state, packet)).toBe(true);
    expect(state.localState?.position).toEqual([1, 2, 3]);
    expect(state.remotePlayers.size).toBe(1);
    expect(state.remotePlayers.get(8)?.position).toEqual([4, 1.5, 5]);
    expect(state.remotePlayers.get(8)?.velocity).toEqual([0, 0, 0]);
    expect(state.remotePlayers.get(8)?.isDead).toBe(false);
  });

  it('updates bot state from snapshotV2 packets', () => {
    const state = makeState();
    const packet: ServerDatagramPacket = {
      type: 'snapshotV2',
      serverTimeUs: 1000,
      serverTick: 10,
      ackInputSeq: 4,
      anchorPxMm: 10_000,
      anchorPyMm: 2_000,
      anchorPzMm: -4_000,
      selfState: {
        vxCms: 120,
        vyCms: 30,
        vzCms: -60,
        yawI16: 0,
        pitchI16: 0,
        hp: 88,
        flags: 5,
      },
      remotePlayers: [
        {
          handle: 3,
          dxQ2_5mm: 400,
          dyQ2_5mm: 0,
          dzQ2_5mm: -200,
          vxCms: 10,
          vyCms: 0,
          vzCms: 20,
          yawI16: 0,
          pitchI16: 0,
          hp: 60,
          flags: 1,
        },
      ],
      sphereStates: [],
      boxStates: [],
      vehicleStates: [],
    };

    expect(applyBotSnapshotState(state, packet)).toBe(true);
    expect(state.localState?.position).toEqual([10, 2, -4]);
    expect(state.localState?.velocity).toEqual([1.2, 0.3, -0.6]);
    expect(state.remotePlayers.size).toBe(1);
    expect(state.remotePlayers.has(99)).toBe(false);
    expect(state.remotePlayers.get(3)?.position[0]).toBeCloseTo(11);
    expect(state.remotePlayers.get(3)?.position[2]).toBeCloseTo(-4.5);
    expect(state.remotePlayers.get(3)?.velocity).toEqual([0.1, 0, 0.2]);
  });

  it('ignores non-snapshot packets', () => {
    const state = makeState();
    const packet: ServerReliablePacket = {
      type: 'shotResult',
      shotId: 1,
      weapon: 1,
      confirmed: false,
      hitPlayerId: 0,
      hitZone: 0,
      serverResolution: 0,
      serverDynamicBodyId: 0,
      serverDynamicHitToiCm: 0,
      serverDynamicImpulseCenti: 0,
    };

    expect(applyBotSnapshotState(state, packet)).toBe(false);
    expect(state.remotePlayers.has(99)).toBe(true);
  });
});
