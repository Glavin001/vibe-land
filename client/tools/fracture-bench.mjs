// GPU cost of the Fracture Lab's rendering, per scenario and variant.
//
//   bash ../scripts/perf/gpu-run.sh fracture-bench node tools/fracture-bench.mjs
//   node tools/fracture-bench.mjs --variants base,cheap --repeats 3
//   node tools/fracture-bench.mjs --scenarios street-100 --frames 240
//
// The desktop app shares its GPU with the destruction physics, so rendering
// has to be cheap, not merely 120 Hz. This measures it the way the project
// measures GPU work on Apple Silicon:
//   - per-frame GPU time from timestamp queries (every pass: main + shadow),
//     resolved every frame (window.__VIBE_FRACTURE_GPU__), median and p90;
//   - a warm-up per scenario, then variants ROUND-ROBIN across repeats, so
//     a clock ramp reads as noise, not as a difference between variants;
//   - run it under scripts/perf/gpu-run.sh (the main checkout's) so no
//     other GPU job overlaps.
//
// A variant is a set of lab URL parameters. Scenarios fix the camera and the
// specimen. Results go to docs/fracture/bench-<time>.json and a table.

import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const origin = flag('origin', 'http://localhost:3013');
const frames = Number(flag('frames', '180'));
const repeats = Number(flag('repeats', '2'));
const width = Number(flag('width', '1600'));
const height = Number(flag('height', '1000'));
const outDir = path.resolve(flag('out', '../docs/fracture'));

/** Cameras relative to the specimen (info()) or a piece; all poses static. */
const SCENARIOS = {
  // A broken reinforced wall filling the screen: crack faces, rebar, skin.
  'closeup-rc': {
    url: 'specimen=rc-wall&compare=enhanced&mode=radial&amount=0.7&spin=0.25',
    camera: (lab) => {
      const i = Math.floor(lab.stats().pieces / 2);
      const c = lab.pieceCenter(i);
      const r = Math.max(0.12, lab.pieceRadius(i) * 2.4);
      const d = [-0.5, 0.18, 0.45];
      const l = Math.hypot(...d);
      return [c.map((x, k) => x + (d[k] / l) * r), c];
    },
  },
  // An intact concrete face filling the screen: the outer skin alone.
  'face-concrete': {
    url: 'specimen=concrete-wall&compare=enhanced&mode=intact',
    camera: (lab) => {
      const { min, max } = lab.info();
      const t = [(min[0] + max[0]) / 2, 1.4, max[2]];
      return [[t[0] + 0.25, t[1] + 0.1, t[2] + 0.75], t];
    },
  },
  // An intact brick face filling the screen.
  'face-brick': {
    url: 'specimen=brick-wall&compare=enhanced&mode=intact',
    camera: (lab) => {
      const { min, max } = lab.info();
      const t = [(min[0] + max[0]) / 2, 1.2, max[2]];
      return [[t[0] + 0.25, t[1] + 0.1, t[2] + 0.75], t];
    },
  },
  // 100 houses broken, at street level: shading everywhere, detail near.
  'street-100': {
    url: 'pack=veneer-house&copies=100&tiered=1&compare=enhanced&mode=radial&amount=0.3&spin=0.4',
    camera: null,
    waitForTier: true,
  },
  // The same 100 houses from above: far pixels, sub-pixel triangles.
  'overview-100': {
    url: 'pack=veneer-house&copies=100&tiered=1&compare=enhanced&mode=radial&amount=0.3&spin=0.4',
    camera: (lab) => {
      const { min, max } = lab.info();
      const size = [0, 1, 2].map((k) => max[k] - min[k]);
      const cols = 10;
      const pitchX = size[0] * 1.4 + 0.6;
      const pitchZ = Math.max(size[2], 1) * 1.8 + 1.5;
      const wide = Math.max(cols * pitchX, cols * pitchZ);
      const target = [0, 0, -((cols - 1) * pitchZ) / 2];
      return [[target[0], wide * 0.55, target[2] + wide * 0.75], target];
    },
  },
};

/** Variants: extra URL parameters. 'base' is the lab as it is. */
const VARIANTS = {
  base: '',
  city: 'skin=city',
  flat: 'rough=0&wear=0',
  shadeoff: 'shading=0',
  nocull: 'cull=0',
  noshadow: 'shadows=0',
  shadow4: 'shadowEvery=4',
};

const scenarios = flag('scenarios', Object.keys(SCENARIOS).join(',')).split(',');
const variants = flag('variants', 'base').split(',');
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);
for (const v of variants) if (VARIANTS[v] === undefined && !v.includes('=')) throw new Error(`unknown variant ${v}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width, height } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e).slice(0, 300)));

async function open(scenario, variant) {
  const spec = SCENARIOS[scenario];
  const extra = VARIANTS[variant] ?? variant;
  await page.goto(`${origin}/fracture-lab?${spec.url}${extra ? `&${extra}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__VIBE_FRACTURE_LAB__?.ready === true && !!window.__VIBE_FRACTURE_GPU__, null, { timeout: 300000 });
  await page.waitForFunction(() => window.__VIBE_CITY_TEX_READY__ === true, null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('button[type=button]')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  if (spec.camera) {
    const [pos, target] = await page.evaluate(`(${spec.camera.toString()})(window.__VIBE_FRACTURE_LAB__)`);
    await page.evaluate(([p, t]) => window.__VIBE_FRACTURE_LAB__.camera(p, t), [pos, target]);
  } else {
    await page.evaluate(() => window.__VIBE_FRACTURE_LAB__.frame());
  }
  // (A variant with no detail radius never builds any.)
  if (spec.waitForTier && !/(^|&)tierRadius=0(&|$)/.test(extra)) {
    await page.waitForFunction(() => {
      const t = window.__VIBE_FRACTURE_LAB__.stats()?.tier;
      return t && t.queue === 0 && t.skinned > 0;
    }, null, { timeout: 120000, polling: 250 });
  }
}

async function sample(n) {
  return page.evaluate((count) => window.__VIBE_FRACTURE_GPU__(count), n);
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: s.length, p10: q(0.1), median: q(0.5), p90: q(0.9), min: s[0] };
};

const results = {};
for (const scenario of scenarios) {
  // Warm-up: shaders compile, textures load, the GPU clock settles.
  await open(scenario, variants[0]);
  await sample(120);
  for (let r = 0; r < repeats; r += 1) {
    for (const variant of variants) {
      await open(scenario, variant);
      await sample(30);
      const ms = await sample(frames);
      const key = `${scenario} | ${variant}`;
      (results[key] ??= []).push(...ms);
      const st = stats(ms);
      console.log(`${scenario.padEnd(14)} ${variant.padEnd(10)} rep ${r + 1}: p10 ${st.p10.toFixed(2)} ms, median ${st.median.toFixed(2)} ms, p90 ${st.p90.toFixed(2)} ms (${st.n} frames)`);
    }
  }
}
await browser.close();

// Other work on the GPU only ever ADDS time: when the machine is shared, p10
// is the figure to compare; the median says how noisy the run was.
console.log('\nscenario       variant                  p10  median    p90   (all repeats)');
const table = {};
for (const [key, ms] of Object.entries(results)) {
  const st = stats(ms);
  table[key] = st;
  const [scenario, variant] = key.split(' | ');
  console.log(`${scenario.padEnd(14)} ${variant.padEnd(22)} ${st.p10.toFixed(2).padStart(6)} ${st.median.toFixed(2).padStart(6)} ${st.p90.toFixed(2).padStart(6)}`);
}
await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify({ width, height, frames, repeats, table }, null, 2));
console.log(`\n${file}`);
if (problems.length) console.error(problems.join('\n'));
