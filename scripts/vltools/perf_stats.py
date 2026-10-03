"""Repetitions and their noise: per-step summaries of a scenario run, aggregated
over repetitions, and comparisons with intervals.

The physics is not bit-reproducible (docs/determinism-and-measurement.md): a
meteor's damage, how much debris stays awake, how many stress iterations the
aftermath needs all vary run to run. The unit of evidence is therefore a
repetition (a fresh server), never a tick; a difference counts only when its
bootstrap interval over repetitions excludes zero.
"""
from __future__ import annotations

import json
import random
import statistics as st
from pathlib import Path

from . import perf_explain as pe

# What a step is summarised by: tick cost, budget, the brackets and phases that
# matter, and the counts that drive them.
KEY_TIMES = ("bracket.dynamics_ms", "bracket.city_ms", "bracket.player_sim_ms", "bracket.vehicle_ms",
             "physx.fetch_ms", "physx.controller_ms", "zone.finish_gpu_wait_ms", "zone.correction_ms",
             "zone.correction_prep_ms", "zone.island_repair_ms", "zone.trial_broadphase_ms", "zone.other_ms")
KEY_COUNTS = ("physx.awake_bodies", "awake_city_bodies", "stage.contacts", "stage.iterations", "stage.corrections",
              "stage.bonds_broken", "stage.bodies_promoted")


def step_summary(ticks):
    totals = sorted(t.get("total_ms") or 0 for t in ticks)
    n = len(totals)
    out = {"ticks": n, "median_ms": st.median(totals), "p95_ms": totals[int(0.95 * (n - 1))], "max_ms": totals[-1],
           "over_budget_pct": 100.0 * sum(1 for x in totals if x > 16.7) / n}
    rows = [pe.times(t) for t in ticks]
    for k in KEY_TIMES:
        vals = [r[k] for r in rows if k in r]
        if vals:
            out[k] = st.median(vals)
    crows = [pe.counts(t) for t in ticks]
    for k in KEY_COUNTS:
        vals = [r[k] for r in crows if k in r]
        if vals:
            out["n." + k] = st.median(vals)
    # Totals over the step, for event counts.
    out["sum.stage.bonds_broken"] = sum(r.get("stage.bonds_broken", 0) for r in crows)
    out["sum.stage.bodies_promoted"] = sum(r.get("stage.bodies_promoted", 0) for r in crows)
    return out


def summarise_rep(rep_dir: Path):
    ticks = pe.load([rep_dir / "ticks.jsonl"])
    marks = json.loads((rep_dir / "steps.json").read_text())
    steps = {}
    for i, m in enumerate(marks):
        part = [t for t in ticks if m["from_tick"] <= t["tick"] <= m["to_tick"]]
        if part:
            steps[f"{i}:{m['step']}"] = step_summary(part)
    return steps


def aggregate(rep_summaries):
    """{step: {metric: {mean, lo, hi, values}}} over repetitions."""
    out = {}
    for step in rep_summaries[0]:
        reps = [r[step] for r in rep_summaries if step in r]
        metrics = set().union(*[set(r) for r in reps])
        out[step] = {}
        for m in sorted(metrics):
            vals = [r[m] for r in reps if m in r]
            out[step][m] = {"mean": st.mean(vals), "lo": min(vals), "hi": max(vals), "values": vals}
    return out


def bootstrap_diff(a, b, n=4000, ci=0.90, seed=1):
    """Interval of mean(b) - mean(a), resampling repetitions."""
    rng = random.Random(seed)
    diffs = sorted(st.mean(rng.choices(b, k=len(b))) - st.mean(rng.choices(a, k=len(a))) for _ in range(n))
    lo, hi = diffs[int((1 - ci) / 2 * n)], diffs[int((1 + ci) / 2 * n) - 1]
    return st.mean(b) - st.mean(a), lo, hi


def print_aggregate(agg, metrics=("median_ms", "p95_ms", "over_budget_pct", "bracket.dynamics_ms", "zone.finish_gpu_wait_ms",
                                  "n.physx.awake_bodies", "n.stage.contacts", "n.stage.iterations")):
    for step, m in agg.items():
        reps = len(next(iter(m.values()))["values"])
        print(f"  {step} ({reps} reps)")
        for k in metrics:
            if k in m:
                v = m[k]
                print(f"    {k:28} {v['mean']:9.2f}   [{v['lo']:.2f} .. {v['hi']:.2f}]")


def compare(a_dir: Path, b_dir: Path, ci=0.90):
    a = json.loads((a_dir / "summary.json").read_text())["aggregate"]
    b = json.loads((b_dir / "summary.json").read_text())["aggregate"]
    out = {}
    print(f"A = {a_dir}\nB = {b_dir}\n(B - A, {int(ci * 100)}% bootstrap interval over repetitions; * = interval excludes 0)")
    na = len(next(iter(next(iter(a.values())).values()))["values"])
    nb = len(next(iter(next(iter(b.values())).values()))["values"])
    if na < 2 or nb < 2:
        print(f"WARNING: {na} vs {nb} repetition(s); with fewer than 2 per side nothing is marked significant (run --reps 3)")
    for step in a:
        if step not in b:
            continue
        print(f"  {step}")
        out[step] = {}
        for m in sorted(set(a[step]) & set(b[step])):
            va, vb = a[step][m]["values"], b[step][m]["values"]
            d, lo, hi = bootstrap_diff(va, vb, ci=ci)
            # One repetition has no spread to resample: no claim either way.
            sig = len(va) >= 2 and len(vb) >= 2 and (lo > 0 or hi < 0)
            out[step][m] = {"delta": d, "lo": lo, "hi": hi, "significant": sig, "a": va, "b": vb}
            if sig or m in ("median_ms", "p95_ms", "over_budget_pct"):
                print(f"    {'*' if sig else ' '} {m:28} {st.mean(va):9.2f} -> {st.mean(vb):9.2f}  {d:+8.2f} [{lo:+.2f} .. {hi:+.2f}]")
    return out
