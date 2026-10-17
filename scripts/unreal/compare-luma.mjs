// Mean linear luminance of matching regions in two same-pose screenshots (compare-web.mjs and
// VibeCity.Render.Compare): sky, horizon band, mid ground, near ground. Prints each and the ratio.
//   node scripts/unreal/compare-luma.mjs web.png unreal.png
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(resolve(root, 'client/package.json'))('playwright');
const [a, b] = process.argv.slice(2).map(p => readFileSync(resolve(p)).toString('base64'));
const regions = { sky: [0.1, 0.02, 0.9, 0.2], horizon: [0.1, 0.42, 0.9, 0.5], mid: [0.1, 0.6, 0.9, 0.7], near: [0.1, 0.82, 0.9, 0.9] };
const browser = await chromium.launch();
const page = await browser.newPage();
const result = await page.evaluate(async ({ a, b, regions }) => {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const measure = async src => {
    const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const out = {};
    for (const [name, [x0, y0, x1, y1]] of Object.entries(regions)) {
      const d = g.getImageData(x0 * c.width, y0 * c.height, (x1 - x0) * c.width, (y1 - y0) * c.height).data;
      let s = 0, r = 0, gg = 0, bb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const R = lin(d[i]), G = lin(d[i + 1]), B = lin(d[i + 2]); s += 0.2126 * R + 0.7152 * G + 0.0722 * B; r += R; gg += G; bb += B; n++; }
      out[name] = { luma: s / n, rgb: [r / n, gg / n, bb / n] };
    }
    return out;
  };
  return { web: await measure(a), unreal: await measure(b) };
}, { a, b, regions });
await browser.close();
for (const name of Object.keys(regions)) {
  const w = result.web[name], u = result.unreal[name];
  const f = v => v.toFixed(3);
  console.log(`${name.padEnd(8)} web ${f(w.luma)} [${w.rgb.map(f)}]  unreal ${f(u.luma)} [${u.rgb.map(f)}]  ratio ${(u.luma / w.luma).toFixed(2)}`);
}
