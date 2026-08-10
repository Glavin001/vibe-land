import { chromium, expect, test, type Page } from '@playwright/test';

import {
  acquirePointerLock,
  holdMove,
  join,
  lookDelta,
  openPlay,
  snapshot,
  waitForSnapshot,
} from '../helpers/toolkit';

const enabled = process.env.E2E_PHYSX_WEBTRANSPORT === '1';

test.describe('PhysX camera-relative movement', () => {
  test.skip(!enabled, 'Set E2E_PHYSX_WEBTRANSPORT=1 against a PhysX GPU server');

  test('WASD follows the camera basis before and after turning', async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      headless: process.env.E2E_HEADFUL !== '1',
      args: [
        '--enable-quic',
        '--no-sandbox',
        '--ignore-certificate-errors',
        '--allow-insecure-localhost',
        '--use-gl=angle',
      ],
    });
    const context = await browser.newContext({
      baseURL: `http://127.0.0.1:${process.env.CLIENT_PORT ?? '5555'}`,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const matchId = process.env.E2E_PHYSX_MATCH_ID
      ?? `flat_vehicle_test-physx-cardinal-${Date.now()}`;
    try {
      await page.addInitScript(() => {
        localStorage.setItem(
          'vibe-land/input-settings',
          JSON.stringify({ meta: { firstRunPromptDismissed: true } }),
        );
      });
      await openPlay(page, matchId);
      const ready = await join(page);
      expect(ready.transport).toBe('webtransport');
      await acquirePointerLock(page);
      await waitUntilSettled(page);

      await assertDirection(page, 'forward');
      await assertDirection(page, 'backward');
      await assertDirection(page, 'left');
      await assertDirection(page, 'right');

      const yawBefore = (await snapshot(page)).cameraYaw;
      await lookDelta(page, 500, 0);
      const yawAfter = (await snapshot(page)).cameraYaw;
      expect(Math.abs(yawAfter - yawBefore)).toBeGreaterThan(0.3);

      await assertDirection(page, 'forward');
      await assertDirection(page, 'right');
    } finally {
      await context.close();
      await browser.close();
    }
  });
});

async function assertDirection(
  page: Page,
  direction: 'forward' | 'backward' | 'left' | 'right',
): Promise<void> {
  await waitUntilSettled(page);
  const before = await snapshot(page);
  await holdMove(page, direction, 1_000);
  const after = await waitForSnapshot(
    page,
    (state) => distanceXZ(
      state.movementTelemetry.authoritativePosition,
      before.movementTelemetry.authoritativePosition,
    ) > 1.5,
    { timeout: 10_000, pollInterval: 50, label: `${direction} authoritative movement` },
  );

  const expected = expectedDirection(before.cameraYaw, direction);
  const dx = after.movementTelemetry.authoritativePosition[0]
    - before.movementTelemetry.authoritativePosition[0];
  const dz = after.movementTelemetry.authoritativePosition[2]
    - before.movementTelemetry.authoritativePosition[2];
  const progress = dx * expected[0] + dz * expected[1];
  const lateral = Math.abs(dx * -expected[1] + dz * expected[0]);

  expect(progress, `${direction} must move along the camera-relative axis`).toBeGreaterThan(1.5);
  expect(lateral, `${direction} must not drift across the camera-relative axis`).toBeLessThan(0.35);
}

async function waitUntilSettled(page: Page): Promise<void> {
  await waitForSnapshot(
    page,
    (state) => {
      const velocity = state.movementTelemetry.authoritativeVelocity;
      const offset = state.movementTelemetry.presentationOffset;
      return Math.hypot(velocity[0], velocity[2]) < 0.15
        && Math.hypot(offset[0], offset[2]) < 0.02;
    },
    { timeout: 10_000, pollInterval: 50, label: 'movement settle' },
  );
}

function expectedDirection(
  yaw: number,
  direction: 'forward' | 'backward' | 'left' | 'right',
): [number, number] {
  const forward: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
  const right: [number, number] = [-Math.cos(yaw), Math.sin(yaw)];
  switch (direction) {
    case 'forward':
      return forward;
    case 'backward':
      return [-forward[0], -forward[1]];
    case 'left':
      return [-right[0], -right[1]];
    case 'right':
      return right;
  }
}

function distanceXZ(
  left: [number, number, number],
  right: [number, number, number],
): number {
  return Math.hypot(left[0] - right[0], left[2] - right[2]);
}
