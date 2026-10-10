#!/usr/bin/env python3
"""Design a "can you tell?" round: pick, from `netlab2 city-pairs --list`
candidates, the trials that teach the most per minute of the inspector's time.

    scripts/netlab/pairs-plan.py CANDIDATE_DIR [CANDIDATE_DIR ...] --out DIR
        [--moments 18] [--nulls 4] [--seed 1]

Each candidate is one 3 s window of one run, with the scorer's penalty in it
by artifact class. The design:

- **Paired moments.** A moment is one window of one condition (capture,
  budget, link) shown for both netcodes, so the netcode comparison is within
  the same scene, camera and instant.
- **Spread over predicted difficulty.** A trial's bin is its penalty on a log
  scale, from about nothing (both clips nearly identical) to a broken scene.
  The threshold where the inspector starts to tell is unknown, so the trials
  cover the whole range (method of constant stimuli), most of them in the
  middle, one or two at each end: the bottom shows whether "the model sees
  something" is visible at all, the top doubles as an attention check.
- **Varied artifacts.** Among moments that fill the same bins, the one whose
  trials are dominated by artifact classes used least so far wins, so the
  answers also inform the classes' relative severity.
- **Spread over captures,** never two overlapping windows of one condition.
- **Controls.** `--nulls` pairs of identical truth clips: the guess rate.

After a round, `scripts/netlab/fit-calibration.py` fits the answers; the next
round should then sample where that fit is least certain.

Writes DIR/<capture>/plan.json (for `netlab2 city-pairs --plan`) and
DIR/design.md (the round, trial by trial, and why).
"""

import argparse
import json
import math
import os
import random
from collections import Counter, defaultdict

# Log10 penalty bins (penalty in the window), lower edges; the first is "about
# nothing" (both clips nearly identical).
EDGES = [-math.inf, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
# How many trials each bin should get per netcode, in proportion: thin at
# both ends, thick in the middle.
WEIGHT = [1, 1, 2, 3, 3, 3, 2, 1]


def bin_of(penalty):
    x = math.log10(penalty) if penalty > 0 else -math.inf
    return max(i for i, e in enumerate(EDGES) if x >= e)


def condition_of(run):
    return run.replace("/shared-v2", "/*").replace("/per-player", "/*")


def dominant(by_class):
    return max(by_class.items(), key=lambda kv: kv[1])[0] if by_class else "none"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--moments", type=int, default=18)
    ap.add_argument("--nulls", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    moments = []
    window_s = None
    for d in args.dirs:
        data = json.load(open(os.path.join(d, "candidates.json")))
        window_s = data["window_s"]
        capture = os.path.basename(d.rstrip("/"))
        by_cond = defaultdict(lambda: defaultdict(list))
        for c in data["candidates"]:
            by_cond[condition_of(c["run"])][c["strategy"]].append(c)
        for cond, strategies in by_cond.items():
            if set(strategies) != {"shared-v2", "per-player"}:
                continue
            # Pair each v2 window with the per-player window nearest in time.
            for a in strategies["shared-v2"]:
                b = min(strategies["per-player"], key=lambda c: abs(c["start_s"] - a["start_s"]))
                if abs(b["start_s"] - a["start_s"]) > 0.5:
                    continue
                moments.append({"capture": capture, "dir": d, "condition": cond, "start_s": a["start_s"], "trials": [a, b]})

    total_weight = sum(WEIGHT)
    target = [w * args.moments / total_weight for w in WEIGHT]
    counts = {s: Counter() for s in ("shared-v2", "per-player")}
    classes = Counter()
    captures = Counter()
    chosen = []

    def gain(m):
        g = 0.0
        for t in m["trials"]:
            b = bin_of(t["penalty"])
            g += max(0.0, target[b] - counts[t["strategy"]][b])
        if g <= 0:
            return -1
        # Ties: the least-used artifact classes, then the least-used capture.
        g += 0.1 * sum(1.0 / (1 + classes[dominant(t["by_class"])]) for t in m["trials"])
        g += 0.05 / (1 + captures[m["capture"]])
        return g

    def overlaps(m):
        return any(c["condition"] == m["condition"] and abs(c["start_s"] - m["start_s"]) < window_s for c in chosen)

    while len(chosen) < args.moments:
        pool = [m for m in moments if not overlaps(m)]
        if not pool:
            break
        best = max(pool, key=lambda m: (gain(m), -m["start_s"]))
        if gain(best) < 0:
            break
        chosen.append(best)
        captures[best["capture"]] += 1
        for t in best["trials"]:
            counts[t["strategy"]][bin_of(t["penalty"])] += 1
            classes[dominant(t["by_class"])] += 1

    rng = random.Random(args.seed)
    plans = defaultdict(list)
    lines = ["# Can-you-tell round: design", "",
             f"{len(chosen)} moments x 2 netcodes + {args.nulls} identical-truth controls "
             f"= {2 * len(chosen) + args.nulls} trials, about {round((2 * len(chosen) + args.nulls) * 9 / 60)} minutes.", "",
             "| id | capture | condition | start s | v2 penalty (bin, class) | per-player penalty (bin, class) |",
             "|---|---|---|---:|---|---|"]
    for k, m in enumerate(chosen):
        cells = []
        for t in m["trials"]:
            tid = f"{m['capture'][:3]}{k:02d}-{'v2' if t['strategy'] == 'shared-v2' else 'pp'}"
            plans[m["dir"]].append({"id": tid, "run": t["run"], "start_s": t["start_s"]})
            cells.append(f"{t['penalty']:.1f} ({bin_of(t['penalty'])}, {dominant(t['by_class'])})")
        cond = m["condition"].split("/nds/")[-1]
        lines.append(f"| {k:02d} | {m['capture']} | {cond} | {m['start_s']:.2f} | {cells[0]} | {cells[1]} |")
    for k in range(args.nulls):
        m = rng.choice(moments)
        t = m["trials"][1]
        plans[m["dir"]].append({"id": f"null{k}", "run": t["run"], "start_s": t["start_s"], "null": True})
        lines.append(f"| null{k} | {m['capture']} | identical truth | {t['start_s']:.2f} | - | - |")
    lines += ["", "Trials per penalty bin (log10 edges " + ", ".join(str(e) for e in EDGES[1:]) + "):", ""]
    for s in ("shared-v2", "per-player"):
        lines.append(f"- {s}: " + ", ".join(f"bin {b}: {counts[s][b]}" for b in range(len(EDGES))))
    lines.append(f"- dominant classes: " + ", ".join(f"{c} {n}" for c, n in classes.most_common()))
    os.makedirs(args.out, exist_ok=True)
    for d, trials in plans.items():
        sub = os.path.join(args.out, os.path.basename(d.rstrip("/")))
        os.makedirs(sub, exist_ok=True)
        json.dump({"trials": trials}, open(os.path.join(sub, "plan.json"), "w"), indent=1)
    open(os.path.join(args.out, "design.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
