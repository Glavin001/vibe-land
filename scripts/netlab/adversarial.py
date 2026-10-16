#!/usr/bin/env python3
"""Adversarial search for per-player's worst cases (plan milestone 12).

    scripts/netlab/adversarial.py --out DIR [--trials 24] [--refine 12] [--compare 3]
        [--captures wedge,sustained,meteor-volley] [--jobs 3] [--seed 11]

Random search, then hill climbing, over what the lab can vary without new
truth:
- the capture;
- two players' cameras (facing / flick / pan / strafe / zoom / peek, at
  random distances, heights, bearings, fields of view and timings, aimed
  near the scene's centre);
- the link profile, the budget and the link seed.

The objective is per player's penalty per client-minute, or a failed gate
(which counts as worse than any penalty). Refinement perturbs the worst
configurations found so far. The `--compare` worst are then run with shared
v2 too, so a weakness of per player is read against the incumbent on the
same inputs.

Results: DIR/trials.jsonl (one line per run: config, command, penalty,
gates) and DIR/worst.md.
"""

import argparse
import concurrent.futures
import copy
import json
import math
import os
import random
import subprocess
import sys

NETLAB2 = os.environ.get("NETLAB2", "/Users/glavin/Development/vibe-land/target/nds/release/netlab2")
TRUTH = os.environ.get("NETLAB_TRUTH", "/Users/glavin/Development/vibe-land/target/nds/truth")
LINKS = ["lte", "cable", "poor-mobile", "lossy-wifi", "loss-burst", "congested", "wifi-bad", "cap-1mbit"]
BUDGETS = [256, 512, 1024]
TOLERANCE = {"wedge": 2, "sustained": 1.5, "meteor-volley": 2}


def scene(capture):
    """The scene's centre and half-size from the manifest (chunk boxes)."""
    with open(os.path.join(TRUTH, capture, "capture", "manifest.json")) as f:
        m = json.load(f)
    lo, hi = [1e9] * 3, [-1e9] * 3
    for s in m["structures"]:
        o = s["worldPosition"]
        for c in s["chunks"]:
            for k in range(3):
                h = c["size"][k] / 2
                lo[k] = min(lo[k], o[k] + c["centroid"][k] - h)
                hi[k] = max(hi[k], o[k] + c["centroid"][k] + h)
    centre = [(a + b) / 2 for a, b in zip(lo, hi)]
    return centre, max(hi[0] - lo[0], hi[2] - lo[2]) / 2


def camera(rng, capture):
    centre, half = scene(capture)
    target = [centre[0] + rng.uniform(-half, half) * 0.5, rng.uniform(0, 15), centre[2] + rng.uniform(-half, half) * 0.5]
    dist = rng.uniform(8, 90)
    bearing = rng.uniform(0, 2 * math.pi)
    height = rng.choice([1.6, 1.6, rng.uniform(2, 35)])
    eye = [target[0] + dist * math.sin(bearing), height, target[2] + dist * math.cos(bearing)]
    v = lambda p: ",".join(f"{x:.2f}" for x in p)
    kind = rng.choice(["facing", "flick", "pan", "strafe", "zoom", "peek"])
    fov = rng.choice([80, 80, 60, 40])
    at = rng.uniform(1, 20)
    if kind == "facing":
        return f"facing:target={v(target)};dist={dist:.1f};bearing={math.degrees(bearing):.0f};height={height:.1f};fov={fov}"
    if kind == "flick":
        return f"flick:eye={v(eye)};look={v(target)};at={at:.1f};turn={rng.uniform(90, 180):.0f};ms={rng.uniform(80, 200):.0f};fov={fov}"
    if kind == "pan":
        return f"pan:eye={v(eye)};look={v(target)};rate={rng.uniform(20, 120):.0f};fov={fov}"
    if kind == "strafe":
        return f"strafe:eye={v(eye)};look={v(target)};amp={rng.uniform(1, 6):.1f};period={rng.uniform(1, 4):.1f};fov={fov}"
    if kind == "zoom":
        return f"zoom:eye={v(eye)};look={v(target)};at={at:.1f};ms={rng.uniform(100, 300):.0f};from=80;to={rng.uniform(8, 30):.0f}"
    peek = [eye[0] + rng.uniform(-2, 2), eye[1], eye[2] + rng.uniform(-2, 2)]
    return f"peek:eye={v(eye)};peek={v(peek)};look={v(target)};period={rng.uniform(2, 6):.1f};fov={fov}"


def random_config(rng, captures):
    capture = rng.choice(captures)
    return {
        "capture": capture,
        "cameras": [camera(rng, capture), camera(rng, capture)],
        "link": rng.choice(LINKS),
        "budget": rng.choice(BUDGETS),
        "seed": rng.randrange(1, 1000),
    }


def perturb(rng, config):
    c = copy.deepcopy(config)
    what = rng.choice(["camera", "camera", "link", "budget", "seed"])
    if what == "camera":
        c["cameras"][rng.randrange(2)] = camera(rng, c["capture"])
    elif what == "link":
        c["link"] = rng.choice(LINKS)
    elif what == "budget":
        c["budget"] = rng.choice(BUDGETS)
    else:
        c["seed"] = rng.randrange(1, 1000)
    return c


def run(out, name, config, strategy):
    d = os.path.join(out, name, strategy)
    cmd = [
        NETLAB2, "city", "--capture", os.path.join(TRUTH, config["capture"], "capture"), "--out", d,
        "--strategy", strategy, "--link", config["link"], "--seed", str(config["seed"]),
        "--budget-kbps", str(config["budget"]), "--burst-kbps", str(config["budget"] * 3), "--burst-s", "3",
    ]
    for cam in config["cameras"]:
        cmd += ["--camera", cam]
    if strategy == "per-player":
        cmd += ["--knob", f"pp.tolerance_px={TOLERANCE[config['capture']]}"]
    os.makedirs(d, exist_ok=True)
    if not os.path.exists(os.path.join(d, "scorecard.json")):
        with open(d + ".log", "w") as log:
            subprocess.call(cmd, stdout=log, stderr=subprocess.STDOUT)
    try:
        with open(os.path.join(d, "scorecard.json")) as f:
            card = json.load(f)
    except (OSError, ValueError):
        return {"name": name, "strategy": strategy, "config": config, "error": True, "command": " ".join(cmd)}
    g = card["gates"]
    return {
        "name": name,
        "strategy": strategy,
        "config": config,
        "command": " ".join(cmd),
        "penalty": card.get("penalty_per_minute_mean"),
        "kbit_s": card["kbit_s_mean"],
        "gates": g["pass"],
        "failed": [k for k in ("g1_hash_mismatches", "g3_clients_over", "g2_events_early", "g5_resurrection_frames", "g4_solid_frames") if g.get(k)],
        "fairness": card.get("fairness"),
    }


def badness(r):
    if r.get("error"):
        return -1
    return (0 if r["gates"] else 1e9) + (r["penalty"] or 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--trials", type=int, default=24)
    ap.add_argument("--refine", type=int, default=12)
    ap.add_argument("--compare", type=int, default=3)
    ap.add_argument("--captures", default="wedge,sustained,meteor-volley")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    captures = args.captures.split(",")
    os.makedirs(args.out, exist_ok=True)
    results = []
    log = open(os.path.join(args.out, "trials.jsonl"), "a")

    def batch(configs, prefix):
        with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
            futures = [pool.submit(run, args.out, f"{prefix}{i:03d}", c, "per-player") for i, c in enumerate(configs)]
            for f in futures:
                r = f.result()
                results.append(r)
                log.write(json.dumps(r) + "\n")
                log.flush()
                print(f"{r['name']} penalty={r.get('penalty')} gates={r.get('gates')} {r['config']['capture']} {r['config']['link']} {r['config']['budget']}", flush=True)

    batch([random_config(rng, captures) for _ in range(args.trials)], "r")
    for round_ in range(max(1, args.refine // args.jobs)):
        worst = sorted([r for r in results if r["strategy"] == "per-player"], key=badness, reverse=True)[: args.jobs]
        batch([perturb(rng, w["config"]) for w in worst], f"h{round_}-")
    worst = sorted([r for r in results if r["strategy"] == "per-player" and not r.get("error")], key=badness, reverse=True)[: args.compare]
    compared = []
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for w, v2 in zip(worst, pool.map(lambda w: run(args.out, w["name"], w["config"], "shared-v2"), worst)):
            log.write(json.dumps(v2) + "\n")
            compared.append((w, v2))
    lines = [
        "# Per-player's worst cases (adversarial search)",
        "",
        f"{len(results)} per-player runs ({args.trials} random, then hill climbing on the worst); the worst {len(compared)} also run with shared v2.",
        "",
        "| run | capture | link | budget | cameras | per-player penalty | gates | shared-v2 penalty | v2 gates |",
        "|---|---|---|---:|---|---:|---|---:|---|",
    ]
    for w, v2 in compared:
        c = w["config"]
        lines.append(
            f"| {w['name']} | {c['capture']} | {c['link']} | {c['budget']} | {' / '.join(x.split(':')[0] for x in c['cameras'])} | "
            f"{w['penalty']:.0f} | {'pass' if w['gates'] else 'fail: ' + ', '.join(w['failed'])} | "
            f"{(v2.get('penalty') or 0):.0f} | {'pass' if v2.get('gates') else 'fail: ' + ', '.join(v2.get('failed', []))} |"
        )
    ok = [r for r in results if not r.get("error")]
    fails = [r for r in ok if not r["gates"]]
    lines += ["", f"Gate failures among per-player runs: {len(fails)} of {len(ok)}."]
    for r in fails[:10]:
        lines.append(f"- {r['name']}: {', '.join(r['failed'])} ({r['config']['capture']}, {r['config']['link']}, {r['config']['budget']} kbit/s)")
    lines += ["", "Commands for the compared runs:", ""]
    for w, _ in compared:
        lines.append(f"    {w['command']}")
    with open(os.path.join(args.out, "worst.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
