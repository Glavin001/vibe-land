#!/usr/bin/env python3
"""Paired-bootstrap confidence intervals for the head-to-head
(docs/netcode-shared-vs-per-player.md).

    scripts/netlab/seed-ci.py ROOT [ROOT ...] [--captures wedge,sustained,meteor-volley]
        [--a shared-v2] [--b per-player] [--resamples 10000]

Each ROOT holds `<capture>/<strategy>/scorecard.json` for one seed (the
lab's runs with the same --seed). Within a seed the two strategies see the
same cameras and the same link draws, so client k of strategy A pairs with
client k of strategy B. Across seeds the physics replay is identical (one
truth tape); the seeds vary the cameras and the links.

For each capture this resamples the paired clients with replacement and
reports, with 95% percentile intervals:
- the ratio of mean penalties (A / B);
- the mean paired difference (A - B), per client-minute;
- the same for kbit/s, so a quality win is read against its cost.
Deterministic (fixed RNG seed).
"""

import argparse
import json
import os
import random
import sys


def load(root, capture, strategy):
    path = os.path.join(root, capture, strategy, "scorecard.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        card = json.load(f)
    out = []
    for c in card["clients"]:
        p = (c.get("perceptual") or {}).get("penalty_per_minute")
        out.append((p, c["stream"]["kbit_s_mean"]))
    return out


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(q * len(xs))))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("roots", nargs="+")
    ap.add_argument("--captures", default="wedge,sustained,meteor-volley")
    ap.add_argument("--a", default="shared-v2")
    ap.add_argument("--b", default="per-player")
    ap.add_argument("--resamples", type=int, default=10000)
    args = ap.parse_args()
    rng = random.Random(7)
    print(f"| capture | seeds | paired clients | {args.a} penalty | {args.b} penalty | ratio (95% CI) | difference/min (95% CI) | kbit/s ratio (95% CI) |")
    print("|---|---:|---:|---:|---:|---|---|---|")
    for capture in args.captures.split(","):
        pairs, seeds = [], 0
        for root in args.roots:
            a, b = load(root, capture, args.a), load(root, capture, args.b)
            if not a or not b:
                continue
            seeds += 1
            pairs += [(x, y) for x, y in zip(a, b) if x[0] is not None and y[0] is not None]
        if not pairs:
            continue
        n = len(pairs)

        def stats(sample):
            pa = sum(p[0][0] for p in sample) / len(sample)
            pb = sum(p[1][0] for p in sample) / len(sample)
            ka = sum(p[0][1] for p in sample) / len(sample)
            kb = sum(p[1][1] for p in sample) / len(sample)
            return pa / pb if pb else float("inf"), pa - pb, ka / kb if kb else float("inf")

        ratio, diff, kratio = stats(pairs)
        boots = [stats([pairs[rng.randrange(n)] for _ in range(n)]) for _ in range(args.resamples)]
        ci = lambda i: (pct([b[i] for b in boots], 0.025), pct([b[i] for b in boots], 0.975))
        (r0, r1), (d0, d1), (k0, k1) = ci(0), ci(1), ci(2)
        pa = sum(p[0][0] for p in pairs) / n
        pb = sum(p[1][0] for p in pairs) / n
        print(
            f"| {capture} | {seeds} | {n} | {pa:.0f} | {pb:.0f} | {ratio:.2f}x ({r0:.2f}-{r1:.2f}) | "
            f"{diff:.0f} ({d0:.0f} to {d1:.0f}) | {kratio:.3f} ({k0:.3f}-{k1:.3f}) |"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
