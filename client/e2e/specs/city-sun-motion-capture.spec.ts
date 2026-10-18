/**
 * Record the sun while the camera moves, so the fix can be judged by eye.
 *
 * Not an assertion -- `city-sky-stability` is the assertion. This exists
 * because the bug is a motion artifact, and the standing preference on this
 * project is that anything a human has to judge gets a video rather than a
 * percentile. A still frame cannot show it at all: the dome catches up one
 * frame after the camera stops, so a screenshot of the broken build taken at
 * rest is indistinguishable from a screenshot of the fixed one.
 *
 * The path is hold / strafe / hold on purpose. Strafing perpendicular to the
 * view is what maximises the visible rotation, and bracketing it with stillness
 * is what makes the artifact legible: on the broken build the sun swings off
 * its mark the instant motion starts, sits at the wrong offset for as long as
 * it lasts, then snaps back when the camera stops. That snap is the "jitter"
 * as reported.
 *
 * Speed is in metres per SECOND here, unlike the assertion spec's per-frame
 * step -- a video has to look like the game, and the size of the artifact at a
 * realistic speed is part of what is being judged.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:9000 \
 *   npx playwright test --config e2e/playwright.config.ts city-sun-motion-capture
 */
import { test } from '@playwright/test';

import { cityBounds, hideDomOverlays, openCity, parkPose, resetCity, waitForCityRendered } from '../helpers/city';
import { DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG } from '../../src/graphics/sunSky';

const ENABLED = process.env.E2E_CITY === '1';

const VIEWPORT = { width: 1280, height: 720 };

/** Metres per second while strafing. A sprint, and well under vehicle speed. */
const SPEED_MPS = 8;
const HOLD_MS = 2200;
const MOVE_MS = 4200;

test.use({
  viewport: VIEWPORT,
  video: { mode: 'on', size: VIEWPORT },
});

test.describe('city sun motion capture', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(180_000);

  test('walks under the sun and records it', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await resetCity(page);
    await hideDomOverlays(page);

    const bounds = await cityBounds(page);
    const az = (DEFAULT_SUN_AZIMUTH_DEG * Math.PI) / 180;
    // Stand on the far side of the city from the sun and look back across it,
    // so the skyline is in the lower half of the frame and gives the eye a
    // fixed reference to judge the sun against. A sun alone on a gradient is
    // much harder to see moving than a sun above a roofline.
    const sunHoriz: [number, number] = [Math.sin(az), Math.cos(az)];
    const standOff = bounds.radiusM + 40;
    const eye: [number, number, number] = [
      bounds.centre[0] - sunHoriz[0] * standOff,
      28,
      bounds.centre[2] - sunHoriz[1] * standOff,
    ];
    // Aim 20 degrees up: the sun is at 39.3, the vertical half-FOV is 37.5, so
    // the disc lands high in the frame with the horizon still visible below.
    const aimPitch = (20 * Math.PI) / 180;
    const aimDir: [number, number, number] = [
      sunHoriz[0] * Math.cos(aimPitch),
      Math.sin(aimPitch),
      sunHoriz[1] * Math.cos(aimPitch),
    ];
    const lookAt: [number, number, number] = [
      eye[0] + aimDir[0] * 100,
      eye[1] + aimDir[1] * 100,
      eye[2] + aimDir[2] * 100,
    ];
    // Strafe: horizontal and perpendicular to the view.
    const strafe: [number, number, number] = [sunHoriz[1], 0, -sunHoriz[0]];

    await parkPose(page, eye, lookAt);
    await page.waitForTimeout(HOLD_MS);

    await page.evaluate(
      (cfg) => new Promise<void>((resolve) => {
        const win = window as unknown as {
          __VIBE_E2E__: { setCapturePose: (p: unknown) => void };
        };
        let start: number | null = null;
        const tick = (now: number) => {
          if (start === null) start = now;
          const elapsed = now - start;
          const travelled = (Math.min(elapsed, cfg.moveMs) / 1000) * cfg.speed;
          win.__VIBE_E2E__.setCapturePose({
            position: cfg.eye.map((v, i) => v + cfg.strafe[i] * travelled),
            lookAt: cfg.lookAt.map((v, i) => v + cfg.strafe[i] * travelled),
          });
          if (elapsed < cfg.moveMs) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      }),
      { eye, lookAt, strafe, speed: SPEED_MPS, moveMs: MOVE_MS },
    );

    // Hold again at the end: the snap-back on the broken build happens here,
    // and it is the single clearest frame-pair in the whole recording.
    await page.waitForTimeout(HOLD_MS);
    await page.evaluate(() => (window as unknown as {
      __VIBE_E2E__: { setCapturePose: (p: unknown) => void };
    }).__VIBE_E2E__.setCapturePose(null));
  });
});
