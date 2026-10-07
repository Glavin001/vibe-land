// Smoke check for the grass lab (/grass): it loads without page errors, the
// renderer is the one the build asks for, the production grass field reports
// plants, and the canvas draws a picture rather than a flat fill.
//
//   node e2e/grass-lab-smoke.mjs --url http://localhost:3023 [--backend webgpu|webgl] [--out ../target/grass-webgpu.png]
//
// Needs only the client dev server (no game server: the shared-layout fetch
// failing is expected and reported as a note, not an error).
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:3023');
const backend = arg('backend', 'webgpu');
const out = arg('out', null);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const errors = [];
const notes = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const text = m.text();
  // CustomMaterialGuard (dev, WebGPU): a GLSL material WebGPU cannot draw.
  if (/\[webgpu\] custom material/.test(text)) { errors.push(`console: ${text.slice(0, 400)}`); return; }
  if (m.type() !== 'error') return;
  // A missing game server makes the shared grass layout fetch fail (500 from
  // the dev proxy). The lab handles it ("server unavailable"); not a defect.
  if (/Failed to load resource/.test(text) && /500|502|503|504|ECONNREFUSED/.test(text)) { notes.push(text); return; }
  errors.push(`console: ${text.slice(0, 400)}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) notes.push(`${r.status()} ${r.url()}`);
});

const failures = [];
try {
  await page.goto(`${url}/grass`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main.grass-lab canvas', { timeout: 30_000 });
  // The field reports plants twice a second once it renders.
  const plants = await page.waitForFunction(() => {
    const strong = document.querySelector('.grass-lab-metrics strong');
    const text = strong?.textContent ?? '0';
    return text !== '0' && text !== '0k' ? text : null;
  }, null, { timeout: 60_000 }).then((h) => h.jsonValue()).catch(() => null);
  if (!plants) failures.push('grass field never reported any plants');
  await page.waitForTimeout(2000);

  // Exercise the lab: plant a field, drive through it, drop rubble, paint a
  // stroke with the brush (raycast onto the ground), switch quality tiers.
  const click = (name) => page.getByRole('button', { name, exact: true }).click();
  await click('Plant lush');
  await click('Drive through');
  await click('Drop rubble');
  await page.waitForTimeout(3000);
  const pressed = Number(await page.textContent('[data-testid="grass-pressed-area"]').then((t) => parseFloat(t ?? '0')));
  if (!(pressed > 0)) failures.push(`car and rubble pressed no grass (${pressed} m²)`);
  await click('Stop car');
  await click('Paint grass');
  // A different brush from the planted lush field, so the stroke changes it.
  await page.locator('.grass-lab-paint .grass-lab-palette').getByRole('button', { name: 'scorched', exact: true }).click();
  await page.waitForTimeout(500);
  const box = await (await page.$('main.grass-lab canvas')).boundingBox();
  const storage = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  const before = await storage();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * 0.6, { steps: 2 });
  await page.mouse.up();
  const status = await page.textContent('.grass-lab-paint [role="status"]');
  if (!/Draft saved locally/.test(status ?? '') || (await storage()) === before) failures.push(`paint stroke did not change the saved draft (status: ${status})`);
  await click('Finish painting');
  await click('Performance');
  await page.waitForTimeout(1500);
  await click('Full detail');
  await click('Among the blades');
  await page.waitForTimeout(2500);

  const reported = await page.evaluate(() => globalThis.__rendererBackend ?? null);
  if (backend === 'webgpu' && reported !== 'webgpu') failures.push(`__rendererBackend is ${reported}, expected webgpu`);
  if (backend === 'webgl' && reported !== null) failures.push(`__rendererBackend is ${reported} on the WebGL build`);

  const canvas = await page.$('main.grass-lab canvas');
  const png = await canvas.screenshot();
  const { channels } = await sharp(png).stats();
  const spread = channels.slice(0, 3).map((c) => c.stdev);
  const mean = channels.slice(0, 3).map((c) => c.mean);
  // A blank or cleared canvas is one flat colour; the lab view has sky,
  // buildings, terrain and grass.
  if (Math.max(...spread) < 12) failures.push(`canvas looks blank (rgb stdev ${spread.map((v) => v.toFixed(1)).join(', ')})`);
  if (out) {
    const file = resolve(process.cwd(), out);
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    console.log(`screenshot: ${file}`);
  }
  console.log(`backend=${reported} plants=${plants} rgb mean=${mean.map((v) => v.toFixed(0)).join(',')} stdev=${spread.map((v) => v.toFixed(1)).join(',')}`);
} catch (error) {
  failures.push(`check aborted: ${error instanceof Error ? error.message : error}`);
}
await browser.close();

for (const note of notes) console.log(`note: ${note}`);
for (const e of errors) console.log(`error: ${e}`);
for (const f of failures) console.log(`FAIL: ${f}`);
const ok = errors.length === 0 && failures.length === 0;
console.log(ok ? 'PASS /grass' : 'FAIL /grass');
process.exit(ok ? 0 : 1);
