import { chromium } from 'playwright';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const API = 'http://127.0.0.1:4001';

export async function stats(matchId) {
  try {
    const r = await fetch(`${API}/match-stats/${matchId}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Join a match in headless Chromium rendering through ANGLE/Metal, optionally recording.
export async function open({ path, record, width = 1280, height = 720 }) {
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height },
    ...(record ? { recordVideo: { dir: record, size: { width, height } } } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`http://localhost:3003${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60000 });
  await page.mouse.click(width / 2, height / 2);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 60000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  });
  return { browser, context, page, renderer };
}

// Hide the debug and control-help panels, and add a caption banner the script keeps current.
export async function banner(page, title) {
  await page.evaluate((title) => {
    for (const el of document.querySelectorAll('body *')) {
      const t = el.textContent || '';
      if (el.children.length > 0 && el.getBoundingClientRect().width < 1200 &&
          (t.includes('DOWNLOAD FULL STATS') || t.includes('last used wins') || t.includes('Fly camera'))) {
        el.style.display = 'none';
      }
    }
    const b = document.createElement('div');
    b.id = 'demo-banner';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:10px 16px;'
      + 'background:rgba(0,0,0,.72);color:#fff;font:15px/1.35 Menlo,monospace;pointer-events:none';
    b.innerHTML = `<div style="font-weight:700;font-size:17px">${title}</div><div id="demo-line1"></div><div id="demo-line2"></div>`;
    document.body.appendChild(b);
  }, title);
}

export async function caption(page, line1, line2 = '') {
  await page.evaluate(([a, b]) => {
    const one = document.getElementById('demo-line1'); if (one) one.textContent = a;
    const two = document.getElementById('demo-line2'); if (two) two.textContent = b;
  }, [line1, line2]);
}

// Keep the second caption line on the server's live physics numbers.
export function liveStats(page, matchId, extra = () => '') {
  let stop = false;
  (async () => {
    while (!stop) {
      const s = await stats(matchId);
      if (s) {
        const line = `server: PhysX GPU active=${s.physics_gpu_active}  gpu warnings=${s.physics_gpu_warning_count}`
          + `  step ${Number(s.physics_last_step_ms).toFixed(1)} ms  active bodies ${s.physics_active_dynamic_bodies}`
          + extra(s);
        await page.evaluate((l) => { const el = document.getElementById('demo-line2'); if (el) el.textContent = l; }, line).catch(() => {});
      }
      await sleep(500);
    }
  })();
  return () => { stop = true; };
}

export const snap = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot());
export const drive = (page, fn, arg) => page.evaluate(([f, a]) => new Function('d', 'a', f)(window.__VIBE_DRIVE__, a), [fn.toString().replace(/^[^{]*{/, '').replace(/}\s*$/, ''), arg]);
