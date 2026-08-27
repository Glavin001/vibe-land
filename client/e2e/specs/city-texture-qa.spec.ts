/**
 * Visual capture for the city's concrete, under the scene's real lighting.
 *
 * The claims this covers are perceptual, so the gate is a picture, not a
 * counter. What it captures, in order:
 *
 *   01-block      the building and its neighbours, for per-building material
 *   02-facade     the same wall higher up, for continuity ACROSS chunk seams --
 *                 an intact facade must not read as a mosaic of pre-broken
 *                 panels
 *   03-before     the same wall, camera pinned
 *   04-after      the same wall from the SAME camera, after it is blown open.
 *                 03 vs 04 is the fracture-invariance check: every shard must
 *                 still be showing the texels it showed while embedded
 *   05-rubble     the settled pile, for floor texture on up-facing surfaces
 *   06-fast-tier  the FAST tier, which compiles a different shader entirely
 *
 * The only automatic assertions are the ones a screenshot cannot make: that no
 * shader failed to compile, and that the texture arrays actually arrived. A
 * silently untextured city renders perfectly well in the neutral grey fallback,
 * which is exactly why those two are worth pinning.
 *
 * KNOWN LIMITATION: the framing is spawn-dependent. The spawn point moves by
 * tens of metres between sessions, downtown is a 21 m grid with no gaps worth
 * standing in, and the drive bridge has no teleport -- so depending on where a
 * run starts, the same code yields anything from a good three-quarter view of a
 * tower to a wall at arm's length. The assertions hold either way; the pictures
 * are worth re-running for. Framing this reliably needs a free camera, which is
 * its own piece of work.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-texture-qa
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  aimAt,
  allStructureTargets,
  fireAt,
  hideDomOverlays,
  openCity,
  resetCity,
  waitForCityRendered,
  waitUntilStill,
  walkToward,
} from '../helpers/city';
import { snapshot } from '../helpers/toolkit';

const ENABLED = process.env.E2E_CITY === '1';
const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../texture-qa');

/**
 * Standing distance from the subject's centre.
 *
 * Buildings are about 21 m across, so this is roughly 27 m of open ground --
 * far enough that the whole facade is in frame and a collapse stays on screen,
 * close enough that fog has not washed the surface detail out.
 */
const SUBJECT_RANGE_M = 38;

/**
 * Walk to about `metres` from the nearest building and return WHICH one.
 *
 * Returning the subject is the entire point, and it took several attempts to
 * get here. Spawn distance varies by tens of metres and the scene is fogged, so
 * from a far spawn every shot is a pale silhouette unless the camera closes
 * first. But downtown is a 21 m grid with no gaps worth standing in, so the
 * walk squeezes past other buildings on the way -- and "approach, then aim at
 * whatever is nearest now" reliably ends up nose against one of those instead,
 * photographing an unlit interior. Aiming at the building we came for is the
 * whole difference.
 *
 * The walk target is at GROUND level, because `walkToward` stops on 3D
 * distance: aim it part-way up a tower and it stops that far from the TOP,
 * which is a few metres from the wall, or inside it.
 */
async function approachNearest(
  page: Page,
  targets: Array<[number, number, number]>,
  metres: number,
): Promise<[number, number, number]> {
  const here = (await snapshot(page)).position;
  const nearest = [...targets].sort((a, b) =>
    Math.hypot(a[0] - here[0], a[2] - here[2]) - Math.hypot(b[0] - here[0], b[2] - here[2]))[0];
  if (Math.hypot(nearest[0] - here[0], nearest[2] - here[2]) > metres) {
    await walkToward(page, [nearest[0], 0, nearest[2]], metres, { maxSteps: 25 });
    await waitUntilStill(page);
  }
  await aimAt(page, nearest);
  return nearest;
}

/** Open the city, wait for the real textures, clear the overlays, reset. */
async function openForCapture(page: Page): Promise<Array<[number, number, number]>> {
  await openCity(page);
  await waitForCityRendered(page);
  // Wait for the real sheets rather than photographing the neutral fallback and
  // calling it a texture -- the fallback is a plausible concrete grey, so the
  // difference is invisible in a failing screenshot.
  await page.waitForFunction(
    () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
      .__VIBE_CITY_TEX_READY__ === true,
    { timeout: 60_000 },
  );
  // The server keeps the last run's rubble, and these shots are about intact
  // buildings.
  await resetCity(page);
  await hideDomOverlays(page);
  await page.waitForTimeout(400);
  return allStructureTargets(page, 0.5);
}

// Top level, not inside the describe: video forces a new worker, which
// Playwright refuses to do from a describe group.
test.use({ video: 'on', viewport: { width: 1600, height: 900 } });

test.describe('city concrete textures', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  // Walking in, then levelling a building, does not fit the suite default.
  test.setTimeout(360_000);

  test('captures intact, mid-break and settled concrete', async ({ page }) => {
    const shaderErrors: string[] = [];
    let texturesReady = false;
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('concrete textures ready')) texturesReady = true;
      // three prints program link/compile failures through console.error with
      // the full info log; a GLSL mistake in the injection lands here and
      // nowhere else, because the material still "works" -- it just draws
      // nothing.
      if (/THREE.WebGLProgram|shader|GLSL/i.test(text) && message.type() === 'error') {
        shaderErrors.push(text);
      }
      if (text.includes('concrete textures failed')) shaderErrors.push(text);
    });
    page.on('pageerror', (error) => shaderErrors.push(String(error)));

    const targets = await openForCapture(page);
    const subject = await approachNearest(page, targets, SUBJECT_RANGE_M);

    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '01-block.png') });

    await aimAt(page, [subject[0], subject[1] * 1.4, subject[2]]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS_DIR, '02-facade.png') });

    const aim = await aimAt(page, subject);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS_DIR, '03-before.png') });

    // fireAt re-aims from the live authoritative position before every shot,
    // which is what actually lands hits at this range; the camera is pinned
    // back to the original angles before each capture so 03 and 04 stay
    // comparable frame to frame.
    await fireAt(page, subject, 24, { intervalMs: 150 });
    await page.evaluate(
      ([yaw, pitch]) => (window as any).__VIBE_DRIVE__.look(yaw, pitch),
      [aim.yaw, aim.pitch],
    );
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(SHOTS_DIR, '04-after.png') });

    await fireAt(page, subject, 30, { intervalMs: 150 });
    await page.waitForTimeout(6000);
    await page.evaluate(
      ([yaw, pitch]) => (window as any).__VIBE_DRIVE__.look(yaw, pitch - 0.28),
      [aim.yaw, aim.pitch],
    );
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '05-rubble.png') });

    expect(shaderErrors, shaderErrors.join('\n')).toEqual([]);
    expect(texturesReady, 'never saw "[city] concrete textures ready"').toBe(true);
  });

  // The FAST tier compiles a DIFFERENT shader: Lambert, and the albedo-only
  // injection with no surface array, no normal blend and no roughness. Nothing
  // else exercises it, and a GLSL error there is invisible on a desktop run.
  test('renders the FAST tier variant', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /THREE.WebGLProgram|shader|GLSL/i.test(message.text())) {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => localStorage.setItem('vibe.render.tier', 'fast'));

    const targets = await openForCapture(page);
    await approachNearest(page, targets, SUBJECT_RANGE_M);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '06-fast-tier.png') });

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
