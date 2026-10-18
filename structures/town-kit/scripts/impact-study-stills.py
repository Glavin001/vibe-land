#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9", "matplotlib>=3.8"]
# ///
"""Stills of the impact study: what each model breaks, drawn on the house.

    uv run structures/town-kit/scripts/impact-study-stills.py PACK OUT.png RUNS.json... [--options A,E coupled,Ci+E coupled]

One row per scenario, one column per option. Every bond is a dot at its
centroid, seen from the front-left (x along the house, z into it, y up):
grey intact, red broken in the hit, orange broken as the house settled under
gravity afterwards, black crushed chunks. The impactor's path is the blue line.
"""
import argparse, importlib.util, json, pathlib
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('impact_study', HERE / 'impact-study.py')
study = importlib.util.module_from_spec(spec); spec.loader.exec_module(study)


def project(p):
    # A front-left three-quarter view.
    return np.stack([p[:, 0] + 0.45 * p[:, 2], p[:, 1] + 0.30 * p[:, 2]], 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pack'); ap.add_argument('out'); ap.add_argument('runs', nargs='+')
    ap.add_argument('--options', default='A,E coupled,Ci+E coupled')
    ap.add_argument('--scenarios', default='truck,truck-corner,cannonball,meteor,small-0.34')
    ap.add_argument('--title', default='')
    a = ap.parse_args()
    st = study.Structure(a.pack); sc = study.scenarios()
    runs = {}
    for f in a.runs:
        for r in json.load(open(f))['runs']:
            runs[(r['scenario'], r['option'])] = r
    opts = a.options.split(','); scens = a.scenarios.split(',')
    fig, axes = plt.subplots(len(scens), len(opts), figsize=(4.6 * len(opts), 3.3 * len(scens)), squeeze=False)
    pts = project(st.bc)
    for i, name in enumerate(scens):
        for j, opt in enumerate(opts):
            ax = axes[i][j]; ax.set_axis_off(); ax.set_aspect('equal')
            r = runs.get((name, opt))
            ax.scatter(pts[:, 0], pts[:, 1], s=0.6, c='#c8c8c8', lw=0)
            if r is None:
                ax.set_title(f'{name} / {opt}: not run', fontsize=8); continue
            hit = np.array([k for k, t in r['brokenBonds'] if 0 <= t < 999], dtype=int)
            settle = np.array([k for k, t in r['brokenBonds'] if t >= 999], dtype=int)
            if len(settle): ax.scatter(pts[settle, 0], pts[settle, 1], s=1.6, c='#f0a020', lw=0)
            if len(hit): ax.scatter(pts[hit, 0], pts[hit, 1], s=1.6, c='#d02020', lw=0)
            crushed = np.array(r.get('crushedNodes', []), dtype=int)
            if len(crushed):
                cp = project(st.pos[crushed]); ax.scatter(cp[:, 0], cp[:, 1], s=9, c='k', marker='s', lw=0)
            imp = sc[name]
            path = project(np.array([imp.aim - imp.d * 3, imp.aim + imp.d * min(max(r['penetration'], 0.5), 12.5)]))
            ax.plot(path[:, 0], path[:, 1], c='#2060d0', lw=1.2)
            ax.set_title(f"{name} / {opt}: {100 * r['brokenFrac']:.0f}% broken, frame {r['structuralBroken']}, roof held {100 * r['roofHeld']:.0f}%", fontsize=8)
    if a.title: fig.suptitle(a.title, fontsize=10)
    fig.tight_layout(); fig.savefig(a.out, dpi=130)
    print(a.out)


if __name__ == '__main__':
    main()
