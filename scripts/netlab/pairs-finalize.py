#!/usr/bin/env python3
"""Finish a "can you tell?" round from rendered pairs: keep only trials whose
clips really differ on screen, spread from subtle to clear, and assemble the
study folder with opaque clip names.

    scripts/netlab/pairs-finalize.py RENDER_DIR [RENDER_DIR ...] --out DIR
        [--trials 30] [--min-frames 0.25] [--min-pixels 100] [--tag round1]

Each RENDER_DIR is a `netlab2 city-pairs --plan` output (study.json with each
pair's exact pixel difference, measured before encoding: the renderer is
deterministic, so every differing pixel is the netcode's).

- **Real difference only.** A trial is kept when its clips differ in at least
  `--min-frames` of the frames, by at least `--min-pixels` pixels on average
  in those frames (at the clip's size; 100 px is about one 10 px piece of
  debris at 1280x720). Below that the pair is, for the eye, an identical
  control, which the round already has. Dropped trials are reported: a
  netcode clip pixel-identical to the truth is itself a result.
- **Spread from subtle to clear.** Kept trials are binned by log10 of the
  mean differing pixels per frame and taken round-robin across bins and
  netcodes, so the answers trace detection against an objective, model-free
  measure of how different the clips are.
- **The attention check and the identical controls** from the plan are kept.

Writes DIR/study.json, DIR/clips/<opaque>.mp4, DIR/selection.md.
"""

import argparse
import hashlib
import json
import math
import os
import shutil
from collections import defaultdict


def mean_px(w):
    """Mean differing pixels per differing frame: the edge-tolerant count
    (a 1-2 px shift of a surface is not a difference) when measured."""
    d = w.get("pixel_diff") or {}
    if "shifted_total" in d:
        return d["shifted_total"] / max(d.get("frames_shifted", 0), 1)
    return d.get("pixels_total", 0) / max(d.get("frames_differing", 0), 1)


def frames_share(w):
    d = w.get("pixel_diff") or {}
    key = "frames_shifted" if "frames_shifted" in d else "frames_differing"
    return d.get(key, 0) / max(d.get("frames", 0), 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--min-frames", type=float, default=0.25)
    ap.add_argument("--min-pixels", type=float, default=100.0)
    ap.add_argument("--tag", default="round")
    args = ap.parse_args()

    windows, first = [], None
    for d in args.dirs:
        s = json.load(open(os.path.join(d, "study.json")))
        first = first or s
        for w in s["windows"]:
            w["_dir"] = d
            w["capture_name"] = os.path.basename(d.rstrip("/"))
            windows.append(w)

    nulls = [w for w in windows if w["class"] == "null"]
    tests = [w for w in windows if w["class"] != "null"]
    real = [w for w in tests if frames_share(w) >= args.min_frames and mean_px(w) >= args.min_pixels]
    dropped = [w for w in tests if w not in real]
    # The attention check: the plan's most penalised moment, if it shows.
    catch = max(real, key=lambda w: w["tests"][0]["magnitude"], default=None)

    bins = defaultdict(list)
    for w in real:
        if w is catch:
            continue
        bins[(int(math.floor(math.log10(mean_px(w)) * 2)), w["class"])].append(w)
    for v in bins.values():
        v.sort(key=lambda w: -frames_share(w))
    chosen = [catch] if catch else []
    keys = sorted(bins)
    while len(chosen) < args.trials and any(bins[k] for k in keys):
        for k in keys:
            if bins[k] and len(chosen) < args.trials:
                chosen.append(bins[k].pop(0))

    os.makedirs(os.path.join(args.out, "clips"), exist_ok=True)
    out_windows = []
    for w in chosen + nulls:
        d = w["_dir"]

        def opaque(f):
            n = hashlib.sha256(f"{args.tag}:{d}:{f}".encode()).hexdigest()[:16] + ".mp4"
            shutil.copy(os.path.join(d, "clips", f), os.path.join(args.out, "clips", n))
            return n

        w = dict(w)
        w["truth_clip"] = opaque(w["truth_clip"])
        w["tests"] = [dict(t, clip=opaque(t["clip"])) for t in w["tests"]]
        w["run"] = w["run"].split("/nds/")[-1]
        w.pop("_dir")
        out_windows.append(w)
    study = {k: v for k, v in first.items() if k not in ("windows", "capture")}
    study["windows"] = out_windows
    study["selection"] = {"min_frames": args.min_frames, "min_pixels": args.min_pixels, "tag": args.tag}
    json.dump(study, open(os.path.join(args.out, "study.json"), "w"))

    lines = [f"# Round selection ({args.tag})", "",
             f"{len(tests)} rendered trials; {len(real)} differ on screen (>= {args.min_frames:.0%} of frames, "
             f">= {args.min_pixels:g} px per differing frame); {len(chosen)} kept, plus {len(nulls)} identical controls.", "",
             "| trial | capture | netcode | penalty | frames differing | mean px per differing frame | max px |",
             "|---|---|---|---:|---:|---:|---:|"]
    for w in chosen:
        d = w["pixel_diff"]
        lines.append(f"| {w['id']} | {w['capture_name']} | {w['class'].replace('netcode ', '')} | {w['tests'][0]['magnitude']:.1f} | "
                     f"{frames_share(w):.0%} | {mean_px(w):.0f} | {d.get('shifted_max', d['pixels_max'])} |")
    lines += ["", "Dropped (no real on-screen difference):", ""]
    by_netcode = defaultdict(int)
    for w in dropped:
        by_netcode[w["class"]] += 1
        lines.append(f"- {w['id']} ({w['capture_name']}, {w['class'].replace('netcode ', '')}): "
                     f"{frames_share(w):.0%} of frames, {mean_px(w):.0f} px, penalty {w['tests'][0]['magnitude']:.1f}")
    lines += ["", "Pixel-identical or nearly, by netcode: " + ", ".join(f"{k.replace('netcode ', '')} {v}" for k, v in sorted(by_netcode.items()))]
    open(os.path.join(args.out, "selection.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
