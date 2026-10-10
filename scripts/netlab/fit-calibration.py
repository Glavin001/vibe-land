#!/usr/bin/env python3
"""Fit the perceptual model's thresholds from calibration study answers
(milestone 5; docs/netcode-lab.md "Truth and calibration").

    scripts/netlab/fit-calibration.py --responses answers.jsonl --study study.json \
        [--label "1 inspector"] [--out model.json]

The study (`netlab2 city-study`) shows the truth and a copy with one
artifact of known magnitude m, in random order, and asks which looked wrong.
With a guess rate of one half and a lapse rate lambda, the chance of
picking the copy is

    P(m) = 0.5 + (0.5 - lambda) * F(m),   F(m) = 1 / (1 + (theta / m)^beta)

where F is the model's own log-logistic detection curve
(`vibe_land_destruction::perception::Psychometric::p_notice`). theta and
beta are fitted per class by maximum likelihood over a log grid (no SciPy);
lambda is fixed at 0.02. theta is where F = 0.5: the artifact seen on half
the trials it could be.

Pixel classes are fitted on the pixels actually shown: a magnitude is on a
1080-line pane of the presented view, and the page records the height the
clip was shown at (`shownHeightPx`) and the screen's (`screenHeightPx`).
The fitted theta is converted back to pane pixels for a game shown full
screen on that screen: theta_pane = theta_shown * 1080 / screenHeightPx.

Severity (how much a noticed artifact costs) comes from the 0-4 rating
given after each trial: the mean rating of trials picked right at or above
the fitted theta, floored at 0.25 so a noticed artifact never costs nothing.

Output: the model JSON `netlab2 city --model` reads, every class the study
did not cover kept at its literature seed, plus a report on stdout.
"""

import argparse
import datetime
import json
import math
import os
import sys

LAPSE = 0.02
PIXEL_UNITS = {"px", "px rms"}


def p_pick(m, theta, beta):
    if m <= 0:
        return 0.5
    f = 1.0 / (1.0 + (theta / m) ** beta)
    return 0.5 + (0.5 - LAPSE) * f


def fit(points):
    """points: [(magnitude, correct bool)] -> (theta, beta, log-likelihood)."""
    mags = [m for m, _ in points if m > 0]
    lo, hi = min(mags) / 4, max(mags) * 4
    best = (None, None, -math.inf)
    for i in range(121):
        theta = lo * (hi / lo) ** (i / 120)
        for j in range(40):
            beta = 0.5 * (16 ** (j / 39))  # 0.5 .. 8
            ll = 0.0
            for m, correct in points:
                p = min(max(p_pick(m, theta, beta), 1e-6), 1 - 1e-6)
                ll += math.log(p if correct else 1 - p)
            if ll > best[2]:
                best = (theta, beta, ll)
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--responses", required=True, help="JSONL (one answer per line), or a directory of the study page's documents as JSON files")
    parser.add_argument("--study", required=True, help="the study.json the answers are for")
    parser.add_argument("--label", default="1 inspector")
    parser.add_argument("--out", default="calibrated-model.json")
    args = parser.parse_args()

    with open(args.study) as f:
        study = json.load(f)
    model = study["model"]
    if os.path.isdir(args.responses):
        # An ArtifactData export (`out_dir`): one JSON document per file.
        answers = []
        for root, _, names in os.walk(args.responses):
            for name in sorted(names):
                if name.endswith(".json"):
                    with open(os.path.join(root, name)) as f:
                        doc = json.load(f)
                    answers.append(doc.get("data", doc))
    else:
        answers = [json.loads(line) for line in open(args.responses) if line.strip()]
    answers = [a for a in answers if a.get("study") == study["format"]]
    by_class = {}
    for a in answers:
        by_class.setdefault(a["class"], []).append(a)

    report = []
    for name, rows in sorted(by_class.items()):
        unit = rows[0]["unit"]
        pixel = unit in PIXEL_UNITS
        screen = sorted(r.get("screenHeightPx") or 1080 for r in rows)[len(rows) // 2]

        def shown(r):
            return r["magnitude"] * (r.get("shownHeightPx") or 1080) / 1080 if pixel else r["magnitude"]

        points = [(shown(r), bool(r["correct"])) for r in rows]
        theta, beta, ll = fit(points)
        theta_model = theta * 1080 / screen if pixel else theta
        noticed = [r["rating"] for r in rows if r["correct"] and shown(r) >= theta]
        severity = max(0.25, sum(noticed) / len(noticed)) if noticed else model["classes"][name]["severity"]
        seed = model["classes"][name]
        model["classes"][name] = {
            "theta": round(theta_model, 4),
            "beta": round(beta, 3),
            "severity": round(severity, 3),
            "unit": unit,
            "source": f"calibration study ({args.label}, {len(rows)} trials, {datetime.date.today()}); seed was theta {seed['theta']}, beta {seed['beta']}, severity {seed['severity']}",
        }
        hits = sum(c for _, c in points)
        report.append(
            f"{name:15s} n={len(rows):3d} picked right {hits / len(rows):5.1%}  theta {theta_model:8.3f} {unit} "
            f"(seed {seed['theta']})  beta {beta:.2f}  severity {severity:.2f} (seed {seed['severity']})  logL {ll:.1f}"
        )
    model["calibration"] = args.label
    with open(args.out, "w") as f:
        json.dump(model, f, indent=2)
    print("\n".join(report))
    print(f"model -> {args.out}")
    if not answers:
        print("no answers matched the study's format", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
