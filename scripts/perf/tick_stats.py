#!/usr/bin/env python3
"""Summarise tick-sampler output: per match, overall and by awake-chunk bucket.

    python3 scripts/perf/tick_stats.py <ticks.jsonl>[,<more.jsonl>] [--label L] [--skip-fraction F]
"""
import argparse, json

def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(p / 100 * len(values)))] if values else float('nan')

def bucket(awake):
    return '0' if awake == 0 else '1-9' if awake < 10 else '10-99' if awake < 100 else '100+'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files')
    ap.add_argument('--label', default='')
    ap.add_argument('--skip-fraction', type=float, default=0.0, help='drop this leading fraction of ticks per match')
    a = ap.parse_args()
    rows = [json.loads(line) for f in a.files.split(',') for line in open(f)]
    if a.label:
        print(f'### {a.label}')
    for match in sorted({r['m'] for r in rows}):
        r = [x for x in rows if x['m'] == match]
        r = r[int(len(r) * a.skip_fraction):]
        total = [x['total'] for x in r]
        print(f"  {match:13s} n={len(r):6d} p50 {pct(total,50):5.2f} p90 {pct(total,90):5.2f} p99 {pct(total,99):6.2f}"
              f" max {max(total):7.1f}  >16.7ms {100*sum(t > 16.667 for t in total)/len(r):5.2f}%  >33ms {sum(t > 33.3 for t in total)}")
        groups = {}
        for x in r:
            groups.setdefault(bucket(x['awake']), []).append(x['total'])
        for k in ['0', '1-9', '10-99', '100+']:
            if k in groups:
                g = groups[k]
                print(f"      awake {k:>5}: n={len(g):5d} p50 {pct(g,50):5.2f} p90 {pct(g,90):5.2f} p99 {pct(g,99):6.2f} max {max(g):7.1f}")

if __name__ == '__main__':
    main()
