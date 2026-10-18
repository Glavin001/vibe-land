import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--ignore-certificate-errors','--no-sandbox','--use-gl=swiftshader',
         '--enable-unsafe-swiftshader','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
await page.mouse.click(640, 400);            // join
const connected = await page.waitForFunction(
  () => window.__VIBE_E2E__?.snapshot?.()?.connected === true, null, { timeout: 60000 },
).then(()=>true).catch(()=>false);
console.log('connected:', connected);
const live = await page.waitForFunction(
  () => (window.__VIBE_E2E__?.snapshot?.()?.city?.liveIslands ?? 0) > 0, null, { timeout: 60000 },
).then(()=>true).catch(()=>false);
console.log('city bodies streaming:', live);
// Fire for a while so there is rubble to freeze.
for (let i = 0; i < 60; i++) {
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(120);
}
await page.waitForTimeout(15000);
const snap = await page.evaluate(() => window.__VIBE_E2E__?.snapshot?.()?.city ?? null);
console.log('client city stats:', JSON.stringify(snap).slice(0, 300));
await browser.close();
