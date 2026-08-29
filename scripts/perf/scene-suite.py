#!/usr/bin/env python3
"""Analysis for the fractured-downtown performance suite.

Two things here are deliberate and were learned the hard way on this box:

* Cost is reported as MEDIAN and p95, never as a mean. A destruction tick
  distribution has a long tail (peaks of 90-170 ms against a 16.7 ms budget)
  and a mean silently blends the tail into the steady state, so a change that
  only moves the tail and a change that only moves the floor look identical.

* WORK is reported next to COST and checked first. Two identical 25 s runs of
  this scene diverge up to 22% in live bonds -- the sim is chaotic and the
  divergence originates in PhysX's GPU contact generation, not in our code. So
  a raw time difference between two heavy runs means nothing until the work
  counters agree; when they do not, the per-unit-work columns are the only
  honest comparison.
"""
import csv, math, statistics, sys, json
from math import comb

# Column name -> what it is. Cost columns are timings; work columns are counts
# that must match before a cost comparison is meaningful.
COST = ["cpu_ms", "stress_solve", "physx_step", "cb_drain", "gpu_solve", "cpu_solve"]
WORK = ["bonds", "awake", "contacts_q", "bodies"]


def load(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def col(rows, name, skip=0):
    out = []
    for r in rows[skip:]:
        v = r.get(name)
        if v is None or v == "":
            continue
        try:
            out.append(float(v))
        except ValueError:
            pass
    return out


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


def summarize(path, settle=60):
    """Per-scenario stats. `settle` drops the settle ticks so scene load and
    the first-contact transient do not contaminate the steady-state numbers."""
    rows = load(path)
    out = {"ticks": len(rows)}
    for c in COST:
        v = col(rows, c, skip=settle)
        if v:
            out[c] = {"p50": pct(v, 0.5), "p95": pct(v, 0.95), "max": max(v),
                      "total": sum(v)}
    for w in WORK:
        v = col(rows, w, skip=settle)
        if v:
            out[w] = {"final": v[-1], "peak": max(v), "integral": sum(v)}
    # Cost per unit work: the only cross-run-comparable cost on a chaotic scene.
    awake = col(rows, "awake", skip=settle)
    cpu = col(rows, "cpu_ms", skip=settle)
    body_ticks = sum(awake)
    if body_ticks > 0 and cpu:
        out["us_per_awake_body"] = 1000.0 * sum(cpu) / body_ticks
    return out


def fmt_report(results):
    lines = []
    lines.append("| scenario | ticks | cpu p50 | cpu p95 | cpu max | stress p50 "
                 "| physx p50 | cb_drain p50 | peak awake | bonds broken | µs/awake body |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for name, s in results.items():
        def g(k, f="p50"):
            return f"{s[k][f]:.2f}" if k in s else "-"
        lines.append(
            f"| {name} | {s['ticks']} | {g('cpu_ms')} | {g('cpu_ms','p95')} | "
            f"{g('cpu_ms','max')} | {g('stress_solve')} | {g('physx_step')} | "
            f"{g('cb_drain')} | "
            f"{s['awake']['peak']:.0f} | {s['bonds']['final']:.0f} | "
            f"{s.get('us_per_awake_body', 0):.2f} |")
    return "\n".join(lines)


def sign_test(deltas):
    """Two-sided sign test. With no real effect each pair is a coin flip, so
    this is what stops 'B won 7 of 10' from being read as a result."""
    n = len(deltas)
    if n == 0:
        return 1.0, 0
    wins = sum(1 for d in deltas if d < 0)
    k = max(wins, n - wins)
    p = min(1.0, 2.0 * sum(comb(n, i) for i in range(k, n + 1)) / 2 ** n)
    return p, wins


def ab(a_paths, b_paths, settle=60):
    a = [summarize(p, settle) for p in a_paths]
    b = [summarize(p, settle) for p in b_paths]
    n = min(len(a), len(b))
    out = []
    # Work check first -- see module docstring.
    for w in WORK:
        av = [x[w]["integral"] for x in a[:n] if w in x]
        bv = [x[w]["integral"] for x in b[:n] if w in x]
        if av and bv:
            am, bm = statistics.median(av), statistics.median(bv)
            drift = 100.0 * (bm - am) / am if am else 0.0
            if abs(drift) > 2.0:
                out.append(f"  ! work differs: {w} median A={am:.0f} B={bm:.0f} "
                           f"({drift:+.1f}%) -- cost comparison is suspect")
    for c in COST:
        av = [x[c]["p50"] for x in a[:n] if c in x]
        bv = [x[c]["p50"] for x in b[:n] if c in x]
        if len(av) < n or len(bv) < n or not av:
            continue
        deltas = [y - x for x, y in zip(av, bv)]
        pctd = [100.0 * d / x for d, x in zip(deltas, av) if x]
        if not pctd:
            continue
        p, wins = sign_test(deltas)
        verdict = ("B faster" if wins > n - wins else "A faster") if p < 0.05 \
            else "no call"
        out.append(f"  {c:14s} A={statistics.median(av):8.3f} "
                   f"B={statistics.median(bv):8.3f}  "
                   f"delta {statistics.median(pctd):+6.2f}%  "
                   f"B wins {wins}/{n}  p={p:.3f}  {verdict}")
    return "\n".join(out)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "report":
        results = {}
        for spec in sys.argv[2:]:
            name, path = spec.split("=", 1)
            results[name] = summarize(path)
        print(fmt_report(results))
        print()
        print(json.dumps(results, indent=1))
    elif mode == "ab":
        split = sys.argv.index("--")
        print(ab(sys.argv[2:split], sys.argv[split + 1:]))
