// Pixel A/B of the two chunk-render strategies at an identical camera.
//
// The live city cannot do this -- spawn position varies per session, so two
// runs frame different blocks. The bench camera is time-parameterised, so an
// orbit period long enough to be static pins both runs to the same view.
import { chromium } from 'playwright-core';
const GPU_ARGS = ['--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors','--allow-insecure-localhost',
  '--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist','--enable-gpu-rasterization'];
const QUERY = process.argv[2];
const OUT = process.argv[3];
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0,200)));
await page.goto(`https://127.0.0.1:6006/renderbench?${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__VIBE_BENCH__?.ready?.() === true, { timeout: 180000 });
await page.waitForTimeout(5000);
const stats = await page.evaluate(() => window.__VIBE_BENCH__.stats());
await page.screenshot({ path: OUT });
console.log(`${OUT}: mode=${stats.mode} chunks=${stats.chunks} instanced=${stats.instancedMeshes} batches=${stats.batches} subDraws=${stats.subDraws}`);
await browser.close();
