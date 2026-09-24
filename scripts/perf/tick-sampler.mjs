// Record every server tick of the named matches from /match-stats tick_ring
// (the ring holds 300 ticks; this polls well inside that).
//   node scripts/perf/tick-sampler.mjs <out.jsonl> city-default [default ...]
import { appendFileSync } from 'node:fs';
const out = process.argv[2];
const matches = process.argv.slice(3);
const seen = Object.fromEntries(matches.map((m) => [m, -1]));
for (;;) {
  for (const m of matches) {
    try {
      const r = await fetch(`http://127.0.0.1:4001/match-stats/${m}`);
      if (!r.ok) continue;
      const d = await r.json();
      const now = Date.now();
      for (const t of d.tick_ring || []) {
        if (t.t > seen[m]) { appendFileSync(out, JSON.stringify({ m, wall: now, ...t, active: d.physics_active_dynamic_bodies, warn: d.physics_gpu_warning_count, players: d.player_count }) + '\n'); seen[m] = t.t; }
      }
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1500));
}
