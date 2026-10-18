import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--ignore-certificate-errors','--no-sandbox','--use-gl=swiftshader',
         '--enable-unsafe-swiftshader','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
await page.mouse.click(640, 400);
await page.waitForFunction(() => window.__VIBE_E2E__?.snapshot?.()?.connected === true, null, { timeout: 60000 });
console.log('connected');

// Demolish: face the city centre and rake the lower floors.
for (let round = 0; round < 5; round++) {
  await page.evaluate(async (r) => {
    const d = window.__VIBE_DRIVE__;
    await d.lookAt(-30 + r * 12, 3 + (r % 3) * 4, -30 + r * 10);
  }, round);
  for (let i = 0; i < 24; i++) {
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 90 }));
    await page.waitForTimeout(160);
  }
}
console.log('done shooting; letting it settle');
await page.waitForTimeout(25000);
await browser.close();
