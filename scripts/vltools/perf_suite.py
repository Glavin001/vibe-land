"""`vl perf suite` and `vl perf history`: the declared scenarios, their budgets,
and a history of results keyed by both repositories' revisions.

Budgets live in each scenario (scenarios/perf/<name>.json):

  "budgets": {"0:idle 20s": {"median_ms": 8.0}, "1:meteors 8": {"over_budget_pct": 30}}

A budget is an upper bound on the metric's mean over repetitions. The suite
(scenarios/perf/suite.json: {"scenarios": [...], "reps": 3}) runs every
scenario, checks its budgets, appends one line per scenario to
bench-results/history.jsonl and exits 1 when any budget fails.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from . import perf_scenario, stack

HISTORY = stack.ROOT / "bench-results/history.jsonl"


def check_budgets(scenario, aggregate):
    failures = []
    for step, limits in (scenario.get("budgets") or {}).items():
        if step not in aggregate:
            failures.append(f"{step}: step missing from the run")
            continue
        for metric, limit in limits.items():
            got = aggregate[step].get(metric, {}).get("mean")
            if got is None:
                failures.append(f"{step} {metric}: not measured")
            elif got > limit:
                failures.append(f"{step} {metric}: {got:.2f} > budget {limit}")
    return failures


def append_history(scenario_name, run_dir: Path, meta, aggregate, failures):
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    fp = meta["fingerprint"]
    line = {"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "scenario": scenario_name, "run": str(run_dir),
            "vibe_land": fp.get("vibe_land"), "vibe_land_dirty": fp.get("vibe_land_dirty"), "physx": fp.get("physx"),
            "sdk_revision": fp.get("sdk_revision"), "platform": fp.get("platform"), "reps": meta.get("reps"),
            "budget_failures": failures,
            "steps": {step: {m: v["mean"] for m, v in metrics.items()} for step, metrics in aggregate.items()}}
    with HISTORY.open("a") as f:
        f.write(json.dumps(line, default=float) + "\n")


def suite(args):
    spec = json.loads(Path(args.suite).read_text()) if Path(args.suite).exists() else \
        json.loads((stack.ROOT / "scenarios/perf" / f"{args.suite}.json").read_text())
    names = args.only.split(",") if args.only else spec["scenarios"]
    reps = args.reps or spec.get("reps", 3)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    all_failures = {}
    for name in names:
        out = stack.ROOT / "target/vl/suites" / stamp / name
        run_args = SimpleNamespace(scenario=name, env=None, match="city-default", http_port=args.http_port, wt_port=args.wt_port,
                                   client_port=args.client_port, warmup=10, binary=args.binary, gpu_trace=False, reps=reps,
                                   label=name, out=str(out))
        print(f"\n######## {name} ({reps} reps) -> {out}")
        perf_scenario.run(run_args)
        summary = json.loads((out / "summary.json").read_text())
        meta = json.loads((out / "meta.json").read_text())
        scenario = meta["scenario"]
        failures = check_budgets(scenario, summary["aggregate"])
        append_history(name, out, meta, summary["aggregate"], failures)
        all_failures[name] = failures
        print(("BUDGET FAIL: " + "; ".join(failures)) if failures else "budgets: ok")
    print("\n######## suite")
    for name, failures in all_failures.items():
        print(f"  {'FAIL' if failures else 'ok  '} {name}" + (": " + "; ".join(failures) if failures else ""))
    print(f"history: {HISTORY}")
    if any(all_failures.values()):
        sys.exit(1)


def history(args):
    if not HISTORY.exists():
        raise SystemExit(f"no history yet ({HISTORY})")
    rows = [json.loads(l) for l in HISTORY.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r["scenario"] == args.scenario]
    if not rows:
        raise SystemExit(f"no history for {args.scenario}")
    steps = list(rows[-1]["steps"])
    step = args.step or steps[0]
    metric = args.metric
    print(f"{args.scenario}  step {step}  metric {metric}")
    prev = None
    for r in rows:
        v = r["steps"].get(step, {}).get(metric)
        delta = "" if prev is None or v is None else f"  ({v - prev:+.2f})"
        flag = "  BUDGET FAIL" if r["budget_failures"] else ""
        print(f"  {r['time']}  vibe-land {str(r['vibe_land'])[:9]}{'+' if r['vibe_land_dirty'] else ' '} physx {str(r['physx'])[:9]}  "
              f"{'-' if v is None else f'{v:9.2f}'}{delta}{flag}")
        prev = v if v is not None else prev
