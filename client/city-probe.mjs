import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--ignore-certificate-errors','--no-sandbox','--use-gl=swiftshader',
         '--enable-unsafe-swiftshader','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0,180)}`));
page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0,180)));
page.on('requestfailed', r => logs.push('REQFAIL ' + r.url().slice(0,110) + ' ' + (r.failure()?.errorText ?? '')));
await page.goto('https://127.0.0.1:6006/city', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e=>logs.push('goto: '+e.message.slice(0,120)));
await page.waitForTimeout(15000);
const state = await page.evaluate(() => ({
  e2e: typeof window.__VIBE_E2E__,
  drive: typeof window.__VIBE_DRIVE__,
  snap: (() => { try { return JSON.stringify(window.__VIBE_E2E__?.snapshot?.() ?? null).slice(0,400); } catch (e) { return 'err '+e; } })(),
  bodyText: document.body.innerText.slice(0, 300),
}));
console.log('E2E:', state.e2e, '| DRIVE:', state.drive);
console.log('snapshot:', state.snap);
console.log('--- visible ---\n' + state.bodyText);
console.log('--- logs ---'); logs.slice(0,16).forEach(l=>console.log(l));
await browser.close();
