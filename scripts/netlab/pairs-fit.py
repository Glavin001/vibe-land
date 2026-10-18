#!/usr/bin/env python3
"""Analyse "can you tell?" answers (netlab2 city-pairs, the study-pairs page).

    scripts/netlab/pairs-fit.py RESPONSES.json [--study study.json]

RESPONSES.json is the page's `responses` collection exported as a JSON list
(or {"documents": [...]}, each with a "data" object). The analysis is fixed
before the data:

1. **Can you tell, per netcode.** The share of trials where the netcode's clip
   was picked as the wrong one ("can't tell" counts as half: what a guess
   earns on average), with an exact (Clopper-Pearson) 95%
   interval. Chance is 50%. The plan's bar for "indistinguishable" is 60%:
   the netcode passes if the interval's upper end is at most 60%; it is
   distinguishable if the lower end is above 50%.
2. **Guess rate.** The identical-truth controls: how often clip A was picked
   (bias), which should be about half.
3. **Does the model predict it?** A logistic fit of correct (1/0) against
   log10 of the scorer's penalty in the window (the trial's magnitude), with
   the 2AFC floor at 50%: P = 0.5 + 0.5 / (1 + exp(-(x - x50) * k)). x50 is
   the penalty at 75% correct, the inspector's threshold in the scorer's
   units. A flat fit means the penalty does not track what is seen.
4. **Rating against penalty.** Mean "how much would it bother you" (0-4) by
   penalty bin: what the quality score's scale has to be fitted to.

Pure Python (no SciPy): the logistic is fitted by Newton's method on the
log-likelihood.
"""

import argparse
import json
import math
from collections import defaultdict


def load(path):
    data = json.load(open(path))
    if isinstance(data, dict):
        data = data.get("documents", data.get("responses", []))
    out = []
    for d in data:
        out.append(d.get("data", d))
    return out


def score(r):
    """1 right, 0 wrong, 0.5 for "can't tell"."""
    return 0.5 if r["correct"] is None else (1.0 if r["correct"] else 0.0)


def clopper_pearson(k, n, alpha=0.05):
    """Exact binomial interval by bisection on the binomial tail."""
    if n == 0:
        return (0.0, 1.0)

    def tail_ge(p):  # P(X >= k)
        return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))

    def tail_le(p):  # P(X <= k)
        return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(0, k + 1))

    def solve(f, target, increasing):
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            if (f(mid) < target) == increasing:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    lower = 0.0 if k == 0 else solve(tail_ge, alpha / 2, True)
    upper = 1.0 if k == n else solve(tail_le, alpha / 2, False)
    return (lower, upper)


def fit_2afc(xs, ys):
    """P = 0.5 + 0.5 * sigmoid((x - x50) * k); returns (x50, k) or None."""
    if len(xs) < 6:
        return None
    a, b = 0.0, 1.0  # logit = a + b x; x50 = -a / b
    for _ in range(100):
        g = [0.0, 0.0]
        h = [[0.0, 0.0], [0.0, 0.0]]
        for x, y in zip(xs, ys):
            s = 1 / (1 + math.exp(-(a + b * x)))
            p = 0.5 + 0.5 * s
            ds = s * (1 - s)
            dp = [0.5 * ds, 0.5 * ds * x]
            w = y / p - (1 - y) / (1 - p) if 0 < p < 1 else 0.0
            for i in range(2):
                g[i] += w * dp[i]
                for j in range(2):
                    h[i][j] -= (y / p**2 + (1 - y) / (1 - p) ** 2) * dp[i] * dp[j]
        det = h[0][0] * h[1][1] - h[0][1] * h[1][0]
        if abs(det) < 1e-12:
            break
        step = [(h[1][1] * g[0] - h[0][1] * g[1]) / det, (-h[1][0] * g[0] + h[0][0] * g[1]) / det]
        a, b = a - step[0], b - step[1]
        if abs(step[0]) + abs(step[1]) < 1e-9:
            break
    if b <= 0:
        return (math.inf, b)
    return (-a / b, b)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("responses")
    args = ap.parse_args()
    rs = [r for r in load(args.responses) if "can you tell" in str(r.get("study", ""))]
    print(f"{len(rs)} answers\n")

    print("## Can you tell, per netcode (picked the netcode's clip)\n")
    print("| netcode | trials | picked it | 95% interval | verdict (bar: 60%) | can't tell |")
    print("|---|---:|---:|---|---|---:|")
    by = defaultdict(list)
    for r in rs:
        by[r["class"]].append(r)
    for cls in sorted(c for c in by if c != "null"):
        n = len(by[cls])
        unsure = sum(1 for r in by[cls] if r["correct"] is None)
        k = round(sum(1 for r in by[cls] if r["correct"]) + 0.5 * unsure)
        lo, hi = clopper_pearson(k, n)
        verdict = "indistinguishable" if hi <= 0.60 else ("distinguishable" if lo > 0.5 else "undecided: more trials")
        print(f"| {cls} | {n} | {100 * k / n:.0f}% | {100 * lo:.0f}-{100 * hi:.0f}% | {verdict} | {unsure} |")

    nulls = by.get("null", [])
    if nulls:
        unsure = sum(1 for r in nulls if r["choice"] == "none")
        picked = [r for r in nulls if r["choice"] != "none"]
        a = sum(1 for r in picked if r["choice"] == "A")
        lo, hi = clopper_pearson(a, len(picked))
        print(f"\nControls (identical clips): can't tell {unsure} of {len(nulls)}; of the rest, picked A {a} of {len(picked)} "
              f"({100 * lo:.0f}-{100 * hi:.0f}%; 50% is no bias).")

    print("\n## Does the scorer's penalty predict it?\n")
    for cls in sorted(c for c in by if c != "null"):
        pts = [(math.log10(max(r["magnitude"], 0.1)), score(r)) for r in by[cls]]
        fit = fit_2afc([p[0] for p in pts], [p[1] for p in pts])
        if fit is None:
            print(f"- {cls}: too few trials to fit")
        elif math.isinf(fit[0]):
            print(f"- {cls}: no rise with penalty (slope {fit[1]:.2f}): the penalty does not track what was seen")
        else:
            print(f"- {cls}: 75% correct at penalty {10 ** fit[0]:.1f} in the window (slope {fit[1]:.2f} per decade)")
    pts = [(math.log10(max(r["magnitude"], 0.1)), score(r)) for r in rs if r["class"] != "null"]
    fit = fit_2afc([p[0] for p in pts], [p[1] for p in pts])
    if fit and not math.isinf(fit[0]):
        print(f"- both netcodes: 75% correct at penalty {10 ** fit[0]:.1f} (slope {fit[1]:.2f} per decade)")

    print("\n## Rating against penalty\n")
    print("| penalty in window | trials | mean rating (0-4) | picked right |")
    print("|---|---:|---:|---:|")
    bins = defaultdict(list)
    for r in rs:
        if r["class"] == "null":
            continue
        b = 0 if r["magnitude"] < 1 else int(math.log10(r["magnitude"])) + 1
        bins[b].append(r)
    labels = {0: "< 1"}
    for b in sorted(bins):
        label = labels.get(b, f"{10 ** (b - 1):g}-{10 ** b:g}")
        rows = bins[b]
        print(f"| {label} | {len(rows)} | {sum(r['rating'] for r in rows) / len(rows):.2f} | "
              f"{100 * sum(score(r) for r in rows) / len(rows):.0f}% |")


if __name__ == "__main__":
    main()
