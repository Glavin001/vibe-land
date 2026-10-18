/**
 * The sky must be a pure function of direction.
 *
 * This pins the bug that made the sun visibly jitter on /city while the camera
 * moved. The dome is a small sphere drawn around the camera whose vertex
 * shader hands the fragment an *object-space* direction, which is only the
 * true view ray when the camera is exactly at the dome's centre. The recentre
 * that keeps it there runs in a `useFrame` that r3f schedules before the one
 * that writes the camera -- children subscribe before parents, and everything
 * here is priority 0 -- so every frame sampled the sky from where the camera
 * was on the *previous* frame. On a unit sphere an offset of `d` metres
 * rotates the sampled sky by about `d` radians, and the disc is `pow(s, 1400)`,
 * roughly 1.8 degrees wide: at walking speed that threw the sun a couple of
 * disc-widths per frame and snapped it back the moment you stood still.
 *
 * The invariant below needs no frame synchronisation, which is the point --
 * anything that tried to observe the ordering directly would be racing the
 * thing it was measuring. Translating `position` and `lookAt` by the same
 * vector changes where the camera is and not one thing about where it looks,
 * so every sky pixel must be identical. A dome that lags the camera breaks
 * that immediately, because the lag *is* an offset from the dome centre.
 *
 * Why no existing spec caught it: `parkOutside` sets a static pose, and one
 * frame later the dome has caught up. Every screenshot in the suite is taken
 * with the bug at rest.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:9000 \
 *   npx playwright test --config e2e/playwright.config.ts city-sky-stability
 */
import { expect, test } from '@playwright/test';

import {
  hideDomOverlays,
  openCity,
  parkPose,
  startMovingPose,
  stopMovingPose,
  waitForCityRendered,
} from '../helpers/city';
import { brightCentroid, decodePng, diffImages } from '../helpers/png';
import { DEFAULT_SUN_AZIMUTH_DEG, DEFAULT_SUN_ELEVATION_DEG, sunDirection } from '../../src/graphics/sunSky';

const ENABLED = process.env.E2E_CITY === '1';

const VIEWPORT = { width: 1600, height: 900 };

/**
 * A crop centred on the frame, which is where the sun lands because the camera
 * looks straight down the sun direction. Kept well inside the frame so the
 * disc is the only bright thing in it and the horizon is nowhere near.
 */
const CLIP = {
  x: VIEWPORT.width / 2 - 200,
  y: VIEWPORT.height / 2 - 150,
  width: 400,
  height: 300,
};

/**
 * High above the city and pointed at the sun, so the crop contains sky and
 * nothing else. The sun sits 39.3 degrees up, the vertical half-FOV is 37.5,
 * and the camera is 220 m up -- the horizon is below the bottom edge of the
 * frame and no building can reach into it.
 */
const EYE: [number, number, number] = [0, 220, 0];
const SUN = sunDirection(DEFAULT_SUN_ELEVATION_DEG, DEFAULT_SUN_AZIMUTH_DEG);
const AIM: [number, number, number] = [
  EYE[0] + SUN.x * 100,
  EYE[1] + SUN.y * 100,
  EYE[2] + SUN.z * 100,
];

/**
 * Horizontal, and perpendicular to the sun's azimuth, so the lag rotates the
 * sky sideways and walks the disc across the crop rather than along the view
 * axis where it would barely move.
 *
 * 0.4 m per frame rotates the sampled sky by about 23 degrees on the broken
 * build. The crop is +/-14 degrees, so the disc does not merely shift -- it
 * leaves. That margin is deliberate: a threshold tuned to catch a few degrees
 * of drift would be a threshold that could be tuned back, whereas "the sun is
 * not in the frame at all" cannot be argued with.
 */
const STEP_M = 0.4;
const AZ = (DEFAULT_SUN_AZIMUTH_DEG * Math.PI) / 180;
const STEP: [number, number, number] = [
  Math.cos(AZ) * STEP_M,
  0,
  -Math.sin(AZ) * STEP_M,
];

/**
 * A crop is 120,000 pixels. Rasterising the dome from a different position
 * moves the sky triangles on screen, so the varying is reconstructed from
 * different vertices and a handful of pixels may land a quantisation step
 * apart; a whole-frame rotation is four orders of magnitude past this.
 */
const MAX_DIFFERING_FRACTION = 0.001;

test.use({ viewport: VIEWPORT });

test.describe('city sky stability', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(180_000);

  test('sky pixels are unchanged by translating the camera', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await hideDomOverlays(page);

    await parkPose(page, EYE, AIM);
    await page.waitForTimeout(1500);

    // Determinism guard, first and separately. If the renderer is not stable
    // frame to frame from a fixed pose then nothing below means anything, and
    // this failing says "not deterministic" instead of blaming the sky.
    const staticA = decodePng(await page.screenshot({ clip: CLIP }));
    await page.waitForTimeout(500);
    const staticB = decodePng(await page.screenshot({ clip: CLIP }));
    const staticDiff = diffImages(staticA, staticB);
    expect(
      staticDiff.fractionDiffering,
      `two consecutive static frames disagree on ${staticDiff.differing} of `
        + `${staticDiff.totalPixels} pixels (max channel delta `
        + `${staticDiff.maxChannelDelta}). The renderer is not deterministic from a `
        + 'parked pose, so the moving comparison below cannot be interpreted.',
    ).toBeLessThanOrEqual(MAX_DIFFERING_FRACTION);

    // The sun has to be in the reference crop, or the test proves nothing.
    const reference = brightCentroid(staticA);
    expect(
      reference,
      'no sun disc in the reference crop: the camera is not pointed at the sun, '
        + 'or the sky is not being drawn at all.',
    ).not.toBeNull();

    await startMovingPose(page, { position: EYE, lookAt: AIM, stepPerFrame: STEP });
    // Long enough for the motion to be well established, short enough that the
    // camera has travelled only tens of metres -- it never leaves clear sky.
    await page.waitForTimeout(1200);
    const movingShot = await page.screenshot({ clip: CLIP });
    const framesStepped = await stopMovingPose(page);
    expect(framesStepped, 'the moving-pose rAF loop never ran').toBeGreaterThan(10);

    const moving = decodePng(movingShot);
    const movingCentroid = brightCentroid(moving);
    const movingDiff = diffImages(staticA, moving);

    // Report the disc's displacement, not just a pixel count: a bare diff says
    // the frames disagree, and the thing worth knowing is that the sun moved.
    const displacement = movingCentroid && reference
      ? Math.hypot(movingCentroid.x - reference.x, movingCentroid.y - reference.y)
      : null;

    expect(
      movingDiff.fractionDiffering,
      `translating the camera by ${STEP_M} m/frame along a vector perpendicular to `
        + 'the view changed the sky on '
        + `${movingDiff.differing} of ${movingDiff.totalPixels} pixels `
        + `(max channel delta ${movingDiff.maxChannelDelta}; sun disc `
        + `${displacement === null ? 'left the crop entirely' : `moved ${displacement.toFixed(1)} px`}). `
        + 'The sky is sampled in the dome\'s object space, so it is only correct while '
        + 'the camera sits exactly at the dome centre -- and the recentre runs a frame '
        + 'behind the camera write.',
    ).toBeLessThanOrEqual(MAX_DIFFERING_FRACTION);

    // Stated as its own assertion so a regression that dims or reshapes the
    // disc without rotating the sky cannot pass by keeping the pixel count low.
    expect(movingCentroid, 'the sun disc left the crop while the camera moved').not.toBeNull();
    expect(displacement, 'the sun disc moved while only the camera position changed')
      .toBeLessThanOrEqual(1);
  });
});
