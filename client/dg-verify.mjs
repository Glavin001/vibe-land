// The user's floating-anchor scenario, live: knock rubble loose, let it
// freeze, then collapse the building above onto it. Then walk away.
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
for (let phase = 0; phase < 2; phase++) {
  for (let i = 0; i < 30; i++) {
    const aimY = phase === 0 ? 2.5 : 8 + (i % 5) * 4;
    await page.evaluate(async (y) => {
      const d = window.__VIBE_DRIVE__;
      await Promise.resolve(d.lookAt(-36, y, -36));
      d.fire({ holdMs: 90 });
    }, aimY);
    await page.waitForTimeout(170);
  }
  if (phase === 0) { console.log('base rubble made; freezing (8s)'); await page.waitForTimeout(8000); }
}
console.log('upper collapse done; settling 25 s');
await page.waitForTimeout(25000);
await browser.close();
