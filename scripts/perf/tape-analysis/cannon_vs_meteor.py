#!/usr/bin/env python3
"""Cannonball vs meteor tick cost from the same server run, CPU only.

The paired capture holds meteors only. The cannonball comparison comes from the
debug reports the client filed earlier in the same server run: each report's
server.json carries a 300-tick `tick_ring` (total, dyn_ms, awake per tick), and
the 20 s client tapes beside them carry the topology stream (new bodies per
tick). Fracture sizes per tick come from the server log.

  python3 scripts/perf/tape-analysis/cannon_vs_meteor.py <server.log> <out_dir> \
      <label>=<report dir>[:<decoded tape dir>] ...

A decoded tape dir is decode.ts output (topology.json). Writes
<out_dir>/cannon_vs_meteor.json and cannon_vs_meteor.svg.
"""
import collections
import json
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svgplot  # noqa: E402

ANSI = re.compile(r'\x1b\[[0-9;]*m')
KV = re.compile(r'(\w+)=([^ ]+)')
BUDGET = 1000.0 / 60.0


def main():
    log_path, out = sys.argv[1], sys.argv[2]
    specs = sys.argv[3:]
    os.makedirs(out, exist_ok=True)
    # tick numbers restart with each match; keep the last match's fracture lines
    fract = {}
    last = -1
    for raw in open(log_path, errors='replace'):
        line = ANSI.sub('', raw)
        if 'city stress fracture' in line:
            d = dict(KV.findall(line))
            t = int(d['tick'])
            if t < last - 1000:
                fract = {}
            last = t
            fract[t] = fract.get(t, 0) + int(d['delta_broken'])
    result = {}
    panels = []
    for spec in specs:
        label, rest = spec.split('=', 1)
        report, _, tape = rest.partition(':')
        ring = json.load(open(os.path.join(report, 'server.json')))['tick_ring']
        promos = collections.Counter()
        if tape:
            for x in json.load(open(os.path.join(tape, 'topology.json'))):
                promos[x['tick']] += x['promos']
        split = [r for r in ring if promos[r['t']] > 0]
        brk = [r for r in ring if fract.get(r['t'], 0) > 0 and promos[r['t']] == 0]
        other = [r for r in ring if fract.get(r['t'], 0) == 0 and promos[r['t']] == 0]
        tot = [r['total'] for r in ring]
        result[label] = dict(
            ticks=[ring[0]['t'], ring[-1]['t']],
            awake=[min(r['awake'] for r in ring), max(r['awake'] for r in ring)],
            bonds_broken=sum(fract.get(r['t'], 0) for r in ring),
            max_bonds_one_tick=max(fract.get(r['t'], 0) for r in ring),
            new_bodies=sum(promos[r['t']] for r in ring) if tape else None,
            tick_ms_p50=round(st.median(tot), 1),
            tick_ms_max=round(max(tot), 1),
            ticks_over_budget=sum(1 for x in tot if x > BUDGET),
            excess_s=round(sum(max(0, x - BUDGET) for x in tot) / 1000, 2),
            split_ticks=len(split) if tape else None,
            split_tick_ms_p50=round(st.median(r['total'] for r in split), 1) if split else None,
            split_tick_ms_max=round(max(r['total'] for r in split), 1) if split else None,
            break_only_ticks=len(brk),
            other_tick_ms_p50=round(st.median(r['total'] for r in other), 1) if other else None,
            other_tick_ms_p90=round(sorted(r['total'] for r in other)[int(len(other) * 0.9)], 1) if other else None,
        )
        p = svgplot.Panel('%s: ticks %d-%d (red = split tick)' % (label, ring[0]['t'], ring[-1]['t']), 'ms',
                          ymin=0, ymax=240, height=170)
        xs = [r['t'] - ring[0]['t'] for r in ring]
        p.line(xs, tot, 'tick ms', color='#4b5563', width=0.9)
        p.scatter([r['t'] - ring[0]['t'] for r in split], [r['total'] for r in split], 'split tick', color='#dc2626', r=2.2)
        p.hlines.append((BUDGET, '#16a34a', '16.7 ms'))
        panels.append(p)
    json.dump(result, open(os.path.join(out, 'cannon_vs_meteor.json'), 'w'), indent=1)
    svgplot.render(panels, os.path.join(out, 'cannon_vs_meteor.svg'), 'ticks from the start of the 300-tick ring',
                   title='Same server run: cannonball fractures vs the first meteor', xs_are_shared=False)
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main()
