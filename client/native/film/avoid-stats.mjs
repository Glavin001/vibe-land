#!/usr/bin/env node
// The avoidance planner's success rate on the model (simulate.mjs), over
// seeds and over a plant that is not the model it plans with -- how much of
// the result leans on the model being right. The app's own runs:
// scripts/turning-lab.sh avoid-stats / avoid-late / avoid-blind.
//
//   node client/native/film/avoid-stats.mjs [--seeds 100] [--reveal 2.74] [--hard] [--identified]
import { simulateAvoid } from './simulate.mjs';
import { AVOID, avoidEpisode } from '../../../structures/vehicle-lab/turning.mjs';

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const seeds = arg('seeds', 100), reveal = arg('reveal', Infinity), hard = process.argv.includes('--hard');
const only = process.argv.includes('--identified');
const PLANTS = {
  'as identified': {},
  'curvature -10%': { curvatureGain: 0.9 },
  'curvature +10%': { curvatureGain: 1.1 },
  '+2 ticks of input delay': { extraDelay: 2 },
  'yaw lag x3 (0.21 s)': { yawLag: 0.21 },
  'brakes -25%': { brake: 0.75 },
};

const q = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))];
for (const [name, plant] of Object.entries(PLANTS).slice(0, only ? 1 : undefined)) {
  let clean = 0, rocks = 0, hits = 0;
  const closest = [], lost = [], failures = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    const ep = avoidEpisode(seed, 0, { hard }), { hazards } = ep.avoid;
    const start = { x: ep.slot[0], z: ep.slot[1], psi: 0 };
    const r = await simulateAvoid({ route: ep.avoid.route, speed: AVOID.speed, start, hazards, seconds: ep.seconds, plant, reveal });
    rocks += hazards.length; hits += r.clearances.filter((c) => c < 0).length;
    if (!r.hit) clean += 1; else failures.push(seed);
    closest.push(Math.min(...r.clearances));
    lost.push(AVOID.speed * ep.seconds - r.progress);
  }
  const stalled = lost.filter((m) => m > 60).length;
  console.log(`${name.padEnd(24)} ${clean}/${seeds} runs clean, ${rocks - hits}/${rocks} rocks avoided, ${stalled} stopped short (>60 m behind); closest p10 ${q(closest, 0.1).toFixed(2)} m, median ${q(closest, 0.5).toFixed(2)} m; `
    + `metres lost to the unhindered run: median ${q(lost, 0.5).toFixed(0)}${failures.length ? `; failed seeds ${failures.slice(0, 10).join(' ')}` : ''}`);
}
