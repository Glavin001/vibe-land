import { test, expect } from '@playwright/test';

// Server-independent sound acceptance checks. Run with a client dev server:
// E2E_BASE_URL=http://127.0.0.1:5567 E2E_SKIP_WEB_SERVER=1 npm run e2e -- audio-review.spec.ts
// Tests use real Web Audio, downloaded clips, and MediaRecorder.
test.beforeEach(async ({ page }) => {
  await page.goto('/audio');
  await expect(page.getByRole('heading', { name: 'Feel every close call.' })).toBeVisible();
});

test('applies a listening-room mix to another open game tab without a reload',async({page,context})=>{
  const game=await context.newPage();await game.goto('/practice');
  await game.getByRole('button',{name:'Sound',exact:true}).click();
  await page.getByRole('combobox',{name:'Listening setup'}).selectOption('stereo');
  await expect(game.getByRole('combobox',{name:'Listening setup'})).toHaveValue('stereo');
  await game.close();
});

test('loads the palette and plays, pauses, seeks, and resumes a deterministic scene', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: /The close call Meteor/ }).click();
  const catalog = await (await page.request.get('/audio/destruction/catalog.json')).json();
  const clipCount = Object.keys(catalog.clips).length;
  expect(clipCount).toBeGreaterThan(80);
  await page.getByRole('button', { name: 'Play scene', exact: true }).click();
  const position = page.getByRole('slider', { name: 'Scene position' });
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(600);
  await expect(page.getByRole('region', { name: 'Live audio diagnostics' })).toContainText(`${clipCount} / ${clipCount} clips`);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const pausedAt = await position.inputValue();
  await page.waitForTimeout(200); // Verify the stopped clock across multiple frames.
  await expect(position).toHaveValue(pausedAt);
  await page.getByRole('button', { name: '2.4Impact', exact: true }).click();
  await expect(position).toHaveValue('2300');
  await page.getByRole('button', { name: 'Resume scene', exact: true }).click();
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(2800);
  await expect(page.getByRole('region', { name: 'Live audio diagnostics' })).toContainText('Linked lookahead');
  await expect.poll(async () => (await page.locator('.audio-lab-meters > div').filter({ hasText: 'OUTPUT PEAK' }).locator('strong').innerText()).includes('—')).toBe(false);
  expect(errors).toEqual([]);
});

test('presets and saved comparison slots restore settings and replay from the beginning', async ({ page }) => {
  await page.getByRole('button', { name: 'Natural Texture & detail', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Natural Texture & detail', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Save current mix to A', exact: true }).click();
  await page.getByRole('button', { name: 'Clarity Close danger first', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clarity Close danger first', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'A Natural Saved mix', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Natural Texture & detail', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(Number(await page.getByRole('slider', { name: 'Scene position' }).inputValue())).toBeLessThan(1000);
  await page.getByRole('checkbox', { name: 'Game sound On', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Game sound Muted', exact: true })).not.toBeChecked();
  await expect(page.getByRole('meter', { name: 'Active playback voices' })).toHaveAttribute('value', '0');
  await page.reload();
  await expect(page.getByRole('button', { name: 'A Natural Saved mix', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Game sound Muted', exact: true })).not.toBeChecked();
});

test('records a playable stereo clip and exports the exact review configuration', async ({ page }) => {
  await page.getByRole('button', { name: /Small things matter Hollow metal/ }).click();
  await page.getByRole('button', { name: 'Record clip', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Scene position' }).inputValue())).toBeGreaterThan(1700);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  const clip = page.locator('.audio-recorded audio');
  await expect(clip).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => clip.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('textbox', { name: 'Listening notes' }).fill('Keep the hollow resonance; reduce the last rattle.');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review ↓', exact: true }).click();
  const report = await download;
  const stream = await report.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(data).toMatchObject({ type: 'vibe-audio-review', version: 1, scenario: { id: 'mailbox', seed: 2026 }, notes: 'Keep the hollow resonance; reduce the last rattle.' });
  expect(data.settings.maxVoices).toBe(64);
  expect(data.diagnostics.failures).toEqual([]);
  await page.getByLabel('Import mix file').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...data, settings: { ...data.settings, output: 'stereo', master: .42 } })) });
  await expect(page.getByRole('combobox', { name: 'Listening setup' })).toHaveValue('stereo');
  await expect(page.getByRole('slider', { name: 'Master volume' })).toHaveValue('0.42');
});

test('handles ten thousand contacts with a bounded voice count and responsive controls', async ({ page }) => {
  await page.getByRole('button', { name: /Ten thousand contacts Dense debris/ }).click();
  await page.getByRole('button', { name: 'Play scene', exact: true }).click();
  const position = page.getByRole('slider', { name: 'Scene position' });
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(2000);
  for (let i = 0; i < 5; i++) {
    const active = Number(await page.getByRole('meter', { name: 'Active playback voices' }).getAttribute('value'));
    expect(active).toBeLessThanOrEqual(64);
    const peakText = await page.locator('.audio-lab-meters > div').filter({ hasText: 'OUTPUT PEAK' }).locator('strong').innerText();
    if (!peakText.includes('—')) expect(Number.parseFloat(peakText)).toBeLessThan(0);
    await page.getByRole('slider', { name: 'Listener heading' }).press(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  }
  await expect(position).toHaveValue('12500', { timeout: 16000 });
  await expect(page.getByRole('region', { name: 'Live audio diagnostics' })).toContainText('/ 10,000');
  await expect(page.getByRole('button', { name: 'Play scene', exact: true })).toBeEnabled();
});

test('fits a narrow screen and exposes output fallback and channel tests', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Play scene', exact: true }).click();
  await page.getByRole('combobox', { name: 'Listening setup' }).selectOption('surround71');
  await page.getByText('Check speaker routing', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Front left', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Front left', exact: true }).click();
  await expect(page.getByText('Playing front left.', { exact: true })).toBeVisible();
  // Channel availability depends on the actual output device. Either route is
  // valid; the user-facing renderer reports fallback when the device is stereo.
  const fallback = page.getByText(/Your browser currently exposes/);
  if (await fallback.isVisible()) await expect(fallback).toContainText('stereo');
});


test('sound settings are available in the game shell without joining a server', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Sound settings' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Listening setup' })).toBeVisible();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel).not.toBeVisible();
  expect(errors).toEqual([]);
});


test('starts inside the collapse and keeps sustained debris audible through the sequence', async ({ page }) => {
  await expect(page.getByRole('region', { name: 'Scene player' }).getByRole('heading', { name: 'Inside the collapse' })).toBeVisible();
  await page.getByRole('button', { name: 'Play selected scene', exact: true }).click();
  const position = page.getByRole('slider', { name: 'Scene position' });
  const beds = page.locator('.audio-lab-meters > div').filter({ hasText: 'DEBRIS BEDS' }).locator('strong');
  const sustained = page.locator('.audio-lab-meters > div').filter({ hasText: 'SUSTAINED LEVEL' }).locator('strong');
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(6000);
  expect(Number(await beds.innerText())).toBeGreaterThan(0);
  expect(Number(await beds.innerText())).toBeLessThanOrEqual(4);
  expect(await sustained.innerText()).not.toContain('—');
  expect(Number.parseFloat(await sustained.innerText())).toBeLessThan(0);
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(10000);
  expect(await sustained.innerText()).not.toContain('—');
  await page.getByRole('button', { name: 'Distant', exact: true }).click();
  await page.getByRole('button', { name: 'Distant', exact: true }).press('r');
  await expect(page.getByRole('button', { name: 'Distant', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(Number(await position.inputValue())).toBeLessThan(1500);
});

test('compares small and heavy material impacts at the same position and intensity', async ({ page }) => {
  await page.getByRole('button', { name: 'Small object', exact: true }).click();
  await expect(page.getByText('Small concrete · same intensity, six meters ahead.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Heavy object', exact: true }).click();
  await expect(page.getByText('Heavy concrete · same intensity, six meters ahead.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Metal', exact: true }).click();
  await expect(page.getByText('Heavy metal · same intensity, six meters ahead.', { exact: true })).toBeVisible();
});
