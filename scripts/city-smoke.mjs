// Load /city in a real browser, connect, fire at a building, and report what
// the server's own stats say -- specifically whether freezing engaged.
import { chromium } from 'playwright-core';

const URL = process.env.CITY_URL ?? 'https://127.0.0.1:6006/city';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--use-gl=swiftshader',
         '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 200)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the city stream to actually carry bodies.
const connected = await page.waitForFunction(
  () => (window.__VIBE_E2E__?.snapshot?.()?.city?.liveIslands ?? 0) > 0,
  null, { timeout: 90000 },
).then(() => true).catch(() => false);
console.log('city stream live:', connected);

if (connected) {
  // Shoot for a while via the deterministic drive hook if present, else clicks.
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => {
      const drive = window.__VIBE_DRIVE__;
      if (drive?.shoot) drive.shoot();
      else window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    }).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(4000);
}
console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
