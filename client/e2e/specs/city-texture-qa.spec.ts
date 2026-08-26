/**
 * Visual capture for the city's concrete texturing.
 *
 * The claims this change makes are perceptual, so the gate is a picture, not a
 * counter. What it captures, in order:
 *
 *   01-block      a whole building, for per-structure material variety
 *   02-facade     a close wall, for continuity ACROSS chunk seams -- an intact
 *                 facade must not read as a mosaic of pre-shattered panels
 *   03-before     the same wall, camera pinned
 *   04-after      the same wall from the SAME camera, after it is blown open.
 *                 03 vs 04 is the fracture-invariance check: every shard must
 *                 still be showing the texels it showed while embedded
 *   05-rubble     the settled pile, for floor texture on up-facing surfaces
 *
 * The only automatic assertions are the ones a screenshot cannot make: that no
 * shader failed to compile, and that the texture arrays actually arrived. A
 * silently untextured city renders perfectly well in neutral grey, which is
 * exactly why those two are worth pinning.
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
} from '../helpers/city';
import { snapshot } from '../helpers/toolkit';

const ENABLED = process.env.E2E_CITY === '1';
const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../texture-qa');

/** Close enough that individual chunk seams are resolvable on the facade. */
const FACADE_RANGE_M = 24;
/** Far enough back to see a whole building and its neighbours' materials. */
const BLOCK_RANGE_M = 55;
/** Close enough to hit, far enough that the collapse stays in frame. */
const BREAK_RANGE_M = 45;

/**
 * Face whichever structure already stands about `metres` away.
 *
 * Deliberately not "walk to a vantage and turn around": downtown is a dense
 * grid, the drive bridge has no teleport, and backing 70 m out of a block walks
 * straight into the neighbours and stops there -- which frames a wall at
 * point-blank range instead of the building it was aiming at. Choosing a
 * subject at the range wanted needs no movement at all.
 */
async function faceStructureAtRange(
  page: Page,
  targets: Array<[number, number, number]>,
  metres: number,
): Promise<[number, number, number]> {
  const here = (await snapshot(page)).position;
  let best = targets[0];
  let bestError = Infinity;
  for (const target of targets) {
    const error = Math.abs(Math.hypot(target[0] - here[0], target[2] - here[2]) - metres);
    if (error < bestError) {
      bestError = error;
      best = target;
    }
  }
  await aimAt(page, best);
  return best;
}

test.use({ video: 'on', viewport: { width: 1600, height: 900 } });

test.describe('city concrete textures', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  // Walking between three vantages and levelling a building does not fit the
  // suite default timeout.
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

    await openCity(page);
    await waitForCityRendered(page);
    // Wait for the real sheets rather than photographing the neutral fallback
    // fill and calling it a texture -- the fallback is a plausible concrete
    // grey, so the difference is invisible in a failing screenshot.
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );

    // Both overlays cover the lower third and the left column, which is most
    // of what these shots exist to show.
    // The server keeps the last run's rubble, and these shots are about
    // intact buildings.
    await resetCity(page);
    await hideDomOverlays(page);
    await page.waitForTimeout(400);

    const targets = await allStructureTargets(page, 0.5);
    // No walking, deliberately. Downtown is a 21 m grid with no gaps worth
    // standing in, and every attempt to walk to a vantage ends up inside a
    // building photographing an unlit interior. Choosing a subject already at
    // the range wanted keeps the camera wherever the spawn put it, which is
    // outside.
    await faceStructureAtRange(page, targets, BLOCK_RANGE_M);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '01-block.png') });

    // Framed by range rather than walked to: closing to touching distance puts
    // the player INSIDE the building, and an unlit interior photographs as a
    // black rectangle whatever is mapped onto it.
    const near = await faceStructureAtRange(page, targets, FACADE_RANGE_M);
    await aimAt(page, [near[0], near[1] * 0.55, near[2]]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS_DIR, '02-facade.png') });

    const victim = await faceStructureAtRange(page, targets, BREAK_RANGE_M);
    const aim = await aimAt(page, victim);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS_DIR, '03-before.png') });

    // fireAt re-aims from the live authoritative position before every shot,
    // which is what actually lands hits at this range; the camera is pinned
    // back to the original angles before each capture so 03 and 04 stay
    // comparable frame to frame.
    await fireAt(page, victim, 24, { intervalMs: 150 });
    await page.evaluate(
      ([yaw, pitch]) => (window as any).__VIBE_DRIVE__.look(yaw, pitch),
      [aim.yaw, aim.pitch],
    );
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(SHOTS_DIR, '04-after.png') });

    await fireAt(page, victim, 30, { intervalMs: 150 });
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

    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    await hideDomOverlays(page);

    const targets = await allStructureTargets(page, 0.5);
    await faceStructureAtRange(page, targets, BLOCK_RANGE_M);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, '06-fast-tier.png') });

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
