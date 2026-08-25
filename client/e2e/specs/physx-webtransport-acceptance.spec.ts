import { expect, test } from '@playwright/test';

import {
  CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
  PHYSICS_BACKEND_PHYSX_GPU,
} from '../../src/net/sharedConstants';
import {
  holdMove,
  join,
  openPlay,
  snapshot,
  waitForSnapshot,
} from '../helpers/toolkit';

const enabled = process.env.E2E_PHYSX_WEBTRANSPORT === '1';

test.describe('PhysX WebTransport acceptance', () => {
  test.skip(!enabled, 'Set E2E_PHYSX_WEBTRANSPORT=1 against a PhysX GPU server');

  test('streams authoritative multiplayer movement at 60 Hz', async ({ browser }) => {
    const matchId = `flat_vehicle_test-physx-acceptance-${Date.now()}`;
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await Promise.all([openPlay(pageA, matchId), openPlay(pageB, matchId)]);

      const sessionConfig = await pageA.evaluate(async (id) => {
        const response = await fetch(`/session-config?match_id=${encodeURIComponent(id)}`);
        if (!response.ok) {
          throw new Error(`session config failed with HTTP ${response.status}`);
        }
        return response.json();
      }, matchId);
      expect(sessionConfig.physics_backend).toBe(PHYSICS_BACKEND_PHYSX_GPU);
      expect(sessionConfig.client_movement_mode).toBe(CLIENT_MOVEMENT_THIN_AUTHORITATIVE);
      expect(sessionConfig.sim_hz).toBe(60);
      expect(sessionConfig.snapshot_hz).toBe(60);

      const [readyA, readyB] = await Promise.all([
        join(pageA, { timeout: 30_000 }),
        join(pageB, { timeout: 30_000 }),
      ]);
      expect(readyA.transport).toBe('webtransport');
      expect(readyB.transport).toBe('webtransport');
      expect(readyA.playerId).not.toBe(readyB.playerId);

      await Promise.all([
        waitForSnapshot(pageA, (state) => state.remotePlayers.length >= 1, {
          timeout: 30_000,
          label: 'player A sees player B',
        }),
        waitForSnapshot(pageB, (state) => state.remotePlayers.length >= 1, {
          timeout: 30_000,
          label: 'player B sees player A',
        }),
      ]);

      const localBefore = await snapshot(pageA);
      const remoteBefore = (await snapshot(pageB)).remotePlayers.find(
        (player) => player.id === readyA.playerId,
      );
      expect(remoteBefore).toBeDefined();

      await holdMove(pageA, 'forward', 1_200);
      const localAfter = await waitForSnapshot(
        pageA,
        (state) => distance(state.position, localBefore.position) > 0.3,
        { timeout: 30_000, label: 'authoritative local movement' },
      );
      expect(distance(localAfter.position, localBefore.position)).toBeGreaterThan(0.3);

      await waitForSnapshot(
        pageB,
        (state) => {
          const remote = state.remotePlayers.find(
            (player) => player.id === readyA.playerId,
          );
          return Boolean(remote && remoteBefore && distance(remote.position, remoteBefore.position) > 0.2);
        },
        { timeout: 30_000, label: 'remote movement replication' },
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

function distance(
  left: [number, number, number],
  right: [number, number, number],
): number {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}
