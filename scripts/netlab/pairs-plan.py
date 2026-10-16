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
- **Action throughout.** Only moments where debris visibly moves on screen
  in at least 80% of the frames, from whichever of the run's players' views
  shows the most of it: a window that is mostly an empty view wastes the
  inspector's attention.
- **Hard.** A trial's bin is its penalty on a log scale. The trials go to
  the subtle middle, where telling is in doubt; none to the near-identical
  bottom (the identical controls cover it), and one obvious attention check.
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
# How many trials each bin should get per netcode, in proportion: the
# inspector's time goes to the subtle middle, where "can I tell?" is in
# doubt. Nothing at the near-identical bottom (the identical controls cover
# it) and nothing at the broken top but one attention check (`--catches`).
WEIGHT = [0, 1, 3, 3, 3, 2, 1, 0]
# A moment must show visible action (debris moving on screen, by
# `netlab2 city-pairs --list`) in at least this share of its frames.
MIN_ACTION = 0.8


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
    ap.add_argument("--catches", type=int, default=1, help="obvious trials kept as attention checks")
    ap.add_argument("--min-action", type=float, default=MIN_ACTION)
    args = ap.parse_args()

    moments = []
    window_s = None
    for d in args.dirs:
        data = json.load(open(os.path.join(d, "candidates.json")))
        window_s = data["window_s"]
        capture = os.path.basename(d.rstrip("/"))
        by_cond = defaultdict(lambda: defaultdict(list))
        for c in data["candidates"]:
            by_cond[(condition_of(c["run"]), c.get("client", 1))][c["strategy"]].append(c)
        for cond, strategies in by_cond.items():
            if set(strategies) != {"shared-v2", "per-player"}:
                continue
            # Pair each v2 window with the per-player window nearest in time.
            for a in strategies["shared-v2"]:
                b = min(strategies["per-player"], key=lambda c: abs(c["start_s"] - a["start_s"]))
                if abs(b["start_s"] - a["start_s"]) > 0.5:
                    continue
                action = min(a.get("action_frames", 1.0), b.get("action_frames", 1.0))
                if action < args.min_action:
                    continue
                area = min(a.get("moving_area_px2", 0.0), b.get("moving_area_px2", 0.0))
                moments.append({"capture": capture, "dir": d, "condition": cond, "start_s": a["start_s"], "trials": [a, b],
                                "action": action, "area": area})

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
        # Then the most visible action (log screen area of moving debris).
        g += 0.02 * math.log10(1 + m["area"])
        return g

    def overlaps(m):
        # Never the same scene twice: one capture's windows from one view never
        # overlap in time (runs at other budgets show the same collapse from
        # the same camera), nor one condition's from any view.
        return any(
            abs(c["start_s"] - m["start_s"]) < window_s
            and (c["condition"][0] == m["condition"][0] or (c["capture"] == m["capture"] and c["condition"][1] == m["condition"][1]))
            for c in chosen
        )

    # Attention checks first: the most obvious moments with action.
    for m in sorted(moments, key=lambda m: -max(t["penalty"] for t in m["trials"]))[: args.catches]:
        chosen.append(m)
        captures[m["capture"]] += 1

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
             f"= {2 * len(chosen) + args.nulls} trials, about {round((2 * len(chosen) + args.nulls) * (2 * window_s + 4) / 60)} minutes "
             f"(two {window_s:g} s clips and about 4 s to answer each).", "",
             "| id | capture | condition | start s | v2 penalty (bin, class) | per-player penalty (bin, class) |",
             "|---|---|---|---:|---|---|"]
    for k, m in enumerate(chosen):
        cells = []
        for t in m["trials"]:
            tid = f"{m['capture'][:3]}{k:02d}-{'v2' if t['strategy'] == 'shared-v2' else 'pp'}"
            plans[m["dir"]].append({"id": tid, "run": t["run"], "start_s": t["start_s"], "client": t.get("client", 1)})
            cells.append(f"{t['penalty']:.1f} ({bin_of(t['penalty'])}, {dominant(t['by_class'])})")
        cond = f"{m['condition'][0].split('/nds/')[-1]} c{m['condition'][1]} (action {m['action']:.0%}, {m['area']:.0f} px2)"
        lines.append(f"| {k:02d} | {m['capture']} | {cond} | {m['start_s']:.2f} | {cells[0]} | {cells[1]} |")
    # Controls from the busiest moments, one per capture in turn, never two
    # of one condition's windows overlapping.
    picked = []
    caps = sorted({m["capture"] for m in moments})
    rng.shuffle(caps)
    for k in range(args.nulls):
        cap = caps[k % len(caps)]
        pool = [m for m in moments if m["capture"] == cap and not overlaps(m)
                and all(not (p["condition"][1] == m["condition"][1] and abs(p["start_s"] - m["start_s"]) < window_s) for p in picked)]
        if not pool:
            continue
        busy = sorted(pool, key=lambda m: -m["area"])[:10]
        m = rng.choice(busy)
        picked.append(m)
        t = m["trials"][1]
        plans[m["dir"]].append({"id": f"null{k}", "run": t["run"], "start_s": t["start_s"], "null": True, "client": t.get("client", 1)})
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
