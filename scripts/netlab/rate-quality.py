#!/usr/bin/env python3
"""Rate-quality curves for the city lab: every strategy at every budget on
every capture, one scorecard each, and a table that puts them side by side
(docs/netcode-lab.md).

    scripts/netlab/rate-quality.py run --out DIR [--captures a,b] [--strategies shared-v2,per-player]
        [--budgets 256,512,1024] [--clients 4] [--link lte] [--seed 1] [--jobs 2]
    scripts/netlab/rate-quality.py table --out DIR

A budget B is the spec's burstable bucket: B kbit/s sustained, 3B for up to
3 s, under the link's own rate controller (decision D9). Quality is the
perceptual scorecard's (Q, noticed artifacts per client-minute) plus the
world-space debris error; cost is the bytes each client was actually sent.
BD-rate (the codec comparison) needs the calibrated Q; until then the table
compares at equal budgets.
"""

import argparse
import concurrent.futures
import json
import os
import subprocess
import sys

NETLAB2 = os.environ.get("NETLAB2", "/Users/glavin/Development/vibe-land/target/nds/release/netlab2")
TRUTH = os.environ.get("NETLAB_TRUTH", "/Users/glavin/Development/vibe-land/target/nds/truth")


# Each strategy's own quality knob: the drawn error (px) worth bytes.
QUALITY_KNOB = {"shared-v2": "city.error_budget_px", "per-player": "pp.tolerance_px"}


def run_one(args, capture, strategy, budget, quality=None):
    name = f"b{budget}" if quality is None else f"b{budget}-q{quality}"
    out = os.path.join(args.out, capture, strategy, name)
    if os.path.exists(os.path.join(out, "scorecard.json")) and not args.force:
        return out, "cached"
    os.makedirs(out, exist_ok=True)
    cmd = [
        NETLAB2, "city", "--capture", os.path.join(TRUTH, capture, "capture"), "--out", out,
        "--strategy", strategy, "--clients", str(args.clients), "--link", args.link,
        "--seed", str(args.seed), "--budget-kbps", str(budget),
        "--burst-kbps", str(budget * 3), "--burst-s", "3",
    ]
    if quality is not None:
        cmd += ["--knob", f"{QUALITY_KNOB[strategy]}={quality}"]
    with open(os.path.join(out, "run.log"), "w") as log:
        code = subprocess.call(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=args.repo)
    return out, f"exit {code}"


def cmd_run(args):
    jobs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for capture in args.captures.split(","):
            for strategy in args.strategies.split(","):
                for budget in [int(b) for b in args.budgets.split(",")]:
                    if args.qualities:
                        for q in args.qualities.split(","):
                            jobs.append(pool.submit(run_one, args, capture, strategy, budget, q))
                    else:
                        jobs.append(pool.submit(run_one, args, capture, strategy, budget))
        for job in concurrent.futures.as_completed(jobs):
            out, status = job.result()
            print(f"{status:8s} {out}", flush=True)
    cmd_table(args)


def summarize(card):
    clients = card["clients"]
    debris = [c["all_draws"]["classes"].get("chunk_debris", {}) for c in clients if c.get("all_draws")]
    p99 = [d.get("pos_render_m", {}).get("p99", 0.0) for d in debris]
    classes = {}
    for c in clients:
        for name, cls in (c.get("perceptual") or {}).get("classes", {}).items():
            classes.setdefault(name, []).append(cls["events_at_theta_per_minute"])
    return {
        "kbit_s": card["kbit_s_mean"],
        "max_1s": card["kbit_s_max_1s"],
        "q": card.get("q_mean"),
        "q_min": card.get("q_min"),
        "penalty": card.get("penalty_per_minute_mean"),
        "debris_p99_m": sum(p99) / len(p99) if p99 else None,
        "gates": card["gates"]["pass"],
        "per_min": {k: sum(v) / len(v) for k, v in classes.items()},
    }


def equal_bytes(rows):
    """Each strategy's penalty interpolated at the other's byte rates
    (log-rate, monotone hull): how much better or worse at equal bytes."""
    import math
    out = ["Penalty at equal bytes (log-rate interpolation over each strategy's points; lower is better):", "",
           "| capture | at kbit/s | shared-v2 penalty | per-player penalty |", "|---|---:|---:|---:|"]
    by = {}
    for capture, strategy, _, s in rows:
        if s["penalty"] is None:
            continue
        by.setdefault(capture, {}).setdefault(strategy, []).append((s["kbit_s"], s["penalty"]))
    def at(points, rate):
        points = sorted(points)
        # The best penalty reachable at or below each rate (a monotone hull).
        hull, best = [], float("inf")
        for r, p in points:
            best = min(best, p)
            hull.append((r, best))
        if rate < hull[0][0] or rate > hull[-1][0]:
            return None
        for (r0, p0), (r1, p1) in zip(hull, hull[1:]):
            if r0 <= rate <= r1:
                if r1 == r0:
                    return min(p0, p1)
                t = (math.log(rate) - math.log(r0)) / (math.log(r1) - math.log(r0))
                return math.exp(math.log(max(p0, 1e-6)) * (1 - t) + math.log(max(p1, 1e-6)) * t)
        return hull[-1][1]
    for capture, strategies in sorted(by.items()):
        a, b = strategies.get("shared-v2", []), strategies.get("per-player", [])
        if not a or not b:
            continue
        for rate in sorted({r for r, _ in a + b}):
            pa, pb = at(a, rate), at(b, rate)
            if pa is None or pb is None:
                continue
            out.append(f"| {capture} | {rate:.0f} | {pa:.1f} | {pb:.1f} |")
    return "\n".join(out)


def cmd_table(args):
    rows = []
    for capture in sorted(os.listdir(args.out)):
        cdir = os.path.join(args.out, capture)
        if not os.path.isdir(cdir):
            continue
        for strategy in sorted(os.listdir(cdir)):
            def order(name):
                b, _, q = name[1:].partition("-q")
                return (int(b), float(q) if q else -1.0)
            sdir = os.path.join(cdir, strategy)
            if not os.path.isdir(sdir):
                continue
            runs = [n for n in os.listdir(sdir) if os.path.isdir(os.path.join(sdir, n)) and n.startswith("b")]
            for budget in sorted(runs, key=order):
                path = os.path.join(cdir, strategy, budget, "scorecard.json")
                if not os.path.exists(path):
                    continue
                with open(path) as f:
                    rows.append((capture, strategy, budget[1:], summarize(json.load(f))))
    lines = [
        "| capture | strategy | budget kbit/s (-q px) | sent kbit/s | busiest 1 s | Q mean | penalty/min | debris p99 m | pops/min | screen err/min | gates |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for capture, strategy, budget, s in rows:
        f = lambda v, d=1: "-" if v is None else f"{v:.{d}f}"
        lines.append(
            f"| {capture} | {strategy} | {budget} | {f(s['kbit_s'])} | {f(s['max_1s'], 0)} | {f(s['q'])} | "
            f"{f(s['penalty'])} | {f(s['debris_p99_m'], 3)} | {f(s['per_min'].get('pop'))} | "
            f"{f(s['per_min'].get('screen_error'))} | {'pass' if s['gates'] else 'FAIL'} |"
        )
    lines += ["", equal_bytes(rows)]
    text = "\n".join(lines)
    with open(os.path.join(args.out, "rate-quality.md"), "w") as f:
        f.write(text + "\n")
    print(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--out", required=True)
    run.add_argument("--captures", default="wedge,meteor-volley,sustained")
    run.add_argument("--strategies", default="shared-v2,per-player")
    run.add_argument("--budgets", default="256,512,1024")
    run.add_argument("--clients", type=int, default=4)
    run.add_argument("--link", default="lte")
    run.add_argument("--seed", type=int, default=1)
    run.add_argument("--jobs", type=int, default=2)
    run.add_argument("--force", action="store_true")
    run.add_argument("--qualities", default="", help="each strategy's quality knob values (px), e.g. 0.5,1,2,4,8")
    run.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    table = sub.add_parser("table")
    table.add_argument("--out", required=True)
    args = parser.parse_args()
    {"run": cmd_run, "table": cmd_table}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
