// Flicker in rendered frames, by pixels: something drawn A, B, A on three
// consecutive frames. Steady motion changes pixels one way and does not come
// back; a part drawn in two places alternately does. For frames k, k+1, k+2:
//
//   flicker(pixel) = min(|f_k - f_k+1|, |f_k+1 - f_k+2|) - |f_k - f_k+2|
//
// counted where it exceeds a threshold. Reports the count per frame, the
// worst frame's bounding box, and writes a heat map of it.
//
//   cd client && node e2e/frame-flicker.mjs <dir of consecutive frames> [threshold=40]
// (frames from e2e/tape-frames.mjs, or any numbered png/jpg sequence)
import sharp from 'sharp';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const threshold = Number(process.argv[3] ?? 40);
const W = 640, H = 360;
const files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/.test(f) && !f.startsWith('flicker')).sort();
const frames = [];
for (const f of files) frames.push(await sharp(join(dir, f)).resize(W, H).greyscale().raw().toBuffer());
const rows = [];
let worst = { count: -1 };
for (let k = 0; k + 2 < frames.length; k++) {
  const [a, b, c] = [frames[k], frames[k + 1], frames[k + 2]];
  let count = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
  const heat = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = Math.min(Math.abs(a[i] - b[i]), Math.abs(b[i] - c[i])) - Math.abs(a[i] - c[i]);
    if (v > threshold) {
      count++; heat[i] = 255;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  rows.push({ frame: files[k + 1], flickerPixels: count, box: count ? [x0 * 2, y0 * 2, x1 * 2, y1 * 2] : null });
  if (count > worst.count) worst = { count, frame: files[k + 1], heat };
}
if (worst.heat) await sharp(worst.heat, { raw: { width: W, height: H, channels: 1 } }).png().toFile(join(dir, 'flicker-worst.png'));
const flagged = rows.filter((r) => r.flickerPixels > 50);
writeFileSync(join(dir, 'flicker.json'), JSON.stringify({ threshold, frames: files.length, flagged: flagged.length, rows }, null, 1));
console.log(`${files.length} frames, ${flagged.length} with >50 flicker pixels (threshold ${threshold}); worst ${worst.count} at ${worst.frame}`);
for (const r of rows.sort((p, q) => q.flickerPixels - p.flickerPixels).slice(0, 8)) console.log(`  ${r.frame}: ${r.flickerPixels} px ${r.box ? `box ${r.box}` : ''}`);
