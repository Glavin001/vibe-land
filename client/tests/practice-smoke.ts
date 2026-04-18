// Smoke test for the /practice (firing range) route.
// Patterned on Kinema's visual-check.ts and pause-pointer-lock.ts (MIT).
// See CREDITS.md at the repo root.

import { test, expect } from '@playwright/test';

test('practice route renders canvas without console errors', async ({ page }) => {
  test.setTimeout(120_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/practice', { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').waitFor({ state: 'visible', timeout: 30_000 });

  // Wait for WebGL context to be created and first frame committed.
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        (canvas as HTMLCanvasElement).getContext('experimental-webgl');
      return Boolean(gl);
    },
    undefined,
    { timeout: 30_000 },
  );

  await page.waitForTimeout(2_000);

  const canvas = await page.locator('canvas').boundingBox();
  expect(canvas).not.toBeNull();
  expect(canvas!.width).toBeGreaterThan(0);
  expect(canvas!.height).toBeGreaterThan(0);

  expect(
    errors,
    `console errors during /practice smoke: ${errors.join(' | ')}`,
  ).toEqual([]);
});
