// Lay the look captures side by side: one row per pose, one column per
// renderer (target/look/<label>/<pose>.png), into target/look/sheet.jpg.
//
//   node e2e/look-sheet.mjs [labels, default webgl,webgpu,native] [--width 640]
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../target/look');
const labels = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'webgl,webgpu,native').split(',');
const wi = process.argv.indexOf('--width');
const width = wi >= 0 ? Number(process.argv[wi + 1]) : 640;
const height = Math.round((width * 9) / 16);

const poses = [...new Set(labels.flatMap((l) => (existsSync(`${root}/${l}`) ? readdirSync(`${root}/${l}`) : [])
  .filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))))];
const order = ['overview', 'facade', 'closeup', 'car', 'skyline'];
poses.sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99 || a.localeCompare(b));

const inputs = [];
const filters = [];
let n = 0;
for (const pose of poses) {
  for (const label of labels) {
    const file = `${root}/${label}/${pose}.png`;
    // A missing capture is a black tile, so the grid keeps its columns.
    if (existsSync(file)) inputs.push('-i', file);
    else inputs.push('-f', 'lavfi', '-i', `color=black:s=${width}x${height}`);
    filters.push(`[${n}]scale=${width}:${height}[t${n}]`);
    n += 1;
  }
}
const rows = poses.map((_, r) => `${labels.map((__, c) => `[t${r * labels.length + c}]`).join('')}hstack=${labels.length}[r${r}]`);
const graph = [...filters, ...rows, `${poses.map((_, r) => `[r${r}]`).join('')}vstack=${poses.length}[out]`].join(';');
const out = `${root}/sheet.jpg`;
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', out]);
console.log(`${out}: rows ${poses.join(', ')}; columns ${labels.join(', ')}`);
