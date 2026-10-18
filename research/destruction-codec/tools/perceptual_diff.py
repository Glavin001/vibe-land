#!/usr/bin/env python3
"""Perceptual comparison of rendered reconstructions against ground truth.

The codec's `frame_freeze_pct_max` gate has a threshold of exactly zero: one
frozen body in one frame rejects a run. That threshold was assumed, never
validated, and it is what caps motion masking at 2x the base bound. It also
governs anything that defers updates, so it sets the objective for budgeted
selection too. This tool asks whether it is calibrated.

Two families of measure, because a freeze is a *temporal* artifact that a
per-frame spatial metric cannot see:

  spatial  -- per-frame SSIM against truth. Answers "does this frame look
              like the right frame?"
  temporal -- per-frame difference energy, |frame[t] - frame[t-1]|, compared
              between truth and reconstruction. A freeze shows up as
              reconstruction motion energy dropping below truth's: the world
              moved, the render did not. This is the quantity the freeze gate
              is a proxy for.

Reads frames via ffmpeg as raw grayscale, so it needs no video libraries --
numpy and ffmpeg only, matching the repo's dependency posture.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np


def probe_dimensions(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    stream = json.loads(out)["streams"][0]
    return int(stream["width"]), int(stream["height"]), int(stream.get("nb_frames", 0))


def frames(path, width, height, scale):
    """Streams luma frames, optionally downscaled, as float32 arrays in [0,1]."""
    w, h = width // scale, height // scale
    command = ["ffmpeg", "-v", "error", "-i", str(path)]
    if scale != 1:
        command += ["-vf", f"scale={w}:{h}"]
    command += ["-f", "rawvideo", "-pix_fmt", "gray", "-"]
    size = w * h
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    try:
        while True:
            raw = process.stdout.read(size)
            if len(raw) < size:
                return
            yield np.frombuffer(raw, dtype=np.uint8).reshape(h, w).astype(np.float32) / 255.0
    finally:
        process.stdout.close()
        process.wait()


def ssim(a, b):
    """Global SSIM on a pair of frames (single window; we want a per-frame scalar)."""
    c1, c2 = (0.01 ** 2), (0.03 ** 2)
    mu_a, mu_b = a.mean(), b.mean()
    va, vb = a.var(), b.var()
    cov = ((a - mu_a) * (b - mu_b)).mean()
    return ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
        (mu_a**2 + mu_b**2 + c1) * (va + vb + c2)
    )


def tiled_stats(a, b, grid):
    """Per-tile SSIM and motion-relevant stats.

    A freeze on a handful of bodies moves a vanishing fraction of a 1920x1080
    frame, so a whole-frame score cannot resolve it. Tiling localizes the
    comparison: the worst tile is the strongest claim the rendered evidence
    can support about a local artifact.
    """
    h, w = a.shape
    th, tw = h // grid, w // grid
    a = a[: th * grid, : tw * grid].reshape(grid, th, grid, tw).transpose(0, 2, 1, 3)
    b = b[: th * grid, : tw * grid].reshape(grid, th, grid, tw).transpose(0, 2, 1, 3)
    a = a.reshape(grid * grid, -1)
    b = b.reshape(grid * grid, -1)
    c1, c2 = (0.01 ** 2), (0.03 ** 2)
    mu_a, mu_b = a.mean(1), b.mean(1)
    va, vb = a.var(1), b.var(1)
    cov = ((a - mu_a[:, None]) * (b - mu_b[:, None])).mean(1)
    ssim_tiles = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
        (mu_a**2 + mu_b**2 + c1) * (va + vb + c2)
    )
    return ssim_tiles


def compare(truth_path, test_path, scale, grid=16):
    width, height, _ = probe_dimensions(truth_path)
    ssims, truth_motion, test_motion, tile_mins = [], [], [], []
    tile_deficit_max = []
    previous_truth = previous_test = None
    for truth, test in zip(frames(truth_path, width, height, scale),
                           frames(test_path, width, height, scale)):
        ssims.append(ssim(truth, test))
        tile_mins.append(float(tiled_stats(truth, test, grid).min()))
        if previous_truth is not None:
            truth_motion.append(float(np.abs(truth - previous_truth).mean()))
            test_motion.append(float(np.abs(test - previous_test).mean()))
            # Localized freeze rate: among tiles where truth actually moved,
            # what fraction of them did the render move less than half as much?
            # A max-over-tiles deficit saturates -- with 256 tiles there is
            # always one whose test motion is ~0 -- so it cannot discriminate.
            # A *rate* over genuinely-moving tiles is the pixel-domain analogue
            # of the body-level freeze gate.
            h2, w2 = truth.shape
            th2, tw2 = h2 // grid, w2 // grid
            def tile_energy(x):
                x = x[: th2 * grid, : tw2 * grid].reshape(grid, th2, grid, tw2)
                return x.transpose(0, 2, 1, 3).reshape(grid * grid, -1).mean(1)
            te_truth = tile_energy(np.abs(truth - previous_truth))
            te_test = tile_energy(np.abs(test - previous_test))
            active = te_truth > 2e-3
            if active.any():
                stalled = te_test[active] < 0.5 * te_truth[active]
                tile_deficit_max.append(float(stalled.mean()))
        previous_truth, previous_test = truth, test

    ssims = np.array(ssims)
    truth_motion = np.array(truth_motion)
    test_motion = np.array(test_motion)

    # Motion deficit: how much less the reconstruction moved than truth did,
    # as a fraction of truth's motion. Positive means the render under-moved,
    # which is what a freeze looks like on screen.
    active = truth_motion > 1e-5
    deficit = np.zeros_like(truth_motion)
    deficit[active] = (truth_motion[active] - test_motion[active]) / truth_motion[active]

    return {
        "frames": int(len(ssims)),
        "ssim_mean": float(ssims.mean()),
        "ssim_p01": float(np.percentile(ssims, 1)),
        "ssim_min": float(ssims.min()),
        "motion_deficit_mean": float(deficit.mean()),
        "motion_deficit_p99": float(np.percentile(deficit, 99)),
        "motion_deficit_max": float(deficit.max()),
        "truth_motion_mean": float(truth_motion.mean()),
        "test_motion_mean": float(test_motion.mean()),
        "tile_ssim_min": float(np.min(tile_mins)),
        "tile_ssim_p01": float(np.percentile(tile_mins, 1)),
        "tile_stall_rate_mean": float(np.mean(tile_deficit_max)) if tile_deficit_max else 0.0,
        "tile_stall_rate_p99": float(np.percentile(tile_deficit_max, 99)) if tile_deficit_max else 0.0,
        "tile_stall_rate_max": float(np.max(tile_deficit_max)) if tile_deficit_max else 0.0,
        "worst_ssim_frame": int(ssims.argmin()),
        "worst_deficit_frame": int(deficit.argmax()) + 1 if len(deficit) else 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--truth", required=True, type=Path)
    parser.add_argument("--test", required=True, type=Path, action="append",
                        help="repeatable; each is compared against --truth")
    parser.add_argument("--label", type=str, action="append", default=None)
    parser.add_argument("--scale", type=int, default=2,
                        help="integer downscale before scoring (default 2)")
    parser.add_argument("--grid", type=int, default=16,
                        help="tiles per axis for localized scoring (default 16)")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    labels = args.label or [p.stem for p in args.test]
    if len(labels) != len(args.test):
        sys.exit("--label count must match --test count")

    results = {}
    for label, path in zip(labels, args.test):
        results[label] = compare(args.truth, path, args.scale, args.grid)
        r = results[label]
        print(f"{label:26} tile_ssim_min={r['tile_ssim_min']:8.5f}  "
              f"stall_rate mean={r['tile_stall_rate_mean']:.4f} "
              f"p99={r['tile_stall_rate_p99']:.4f} max={r['tile_stall_rate_max']:.4f}")

    if args.out:
        args.out.write_text(json.dumps(results, indent=2))
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
