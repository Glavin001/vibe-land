#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "cvxpy>=1.5", "clarabel>=0.9"]
# ///
"""The loads the impact solve's island carries at the full level (pf: the
trial's chunk loads, the impactor's momentum), by distance from the hit:
which chunks carry what force, against their weight.

    uv run scripts/impact/oracle-loads.py PREFIX-island<id>.bin
"""
import importlib.util, pathlib, sys
import numpy as np
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('oracle_level', HERE / 'oracle-level.py')
ol = importlib.util.module_from_spec(spec); spec.loader.exec_module(ol)
d = ol.load(sys.argv[1]); nn, nl = d['nn'], d['nl']
rb = open(sys.argv[1][:-4] + '.ramp.bin', 'rb').read()
nodes = np.frombuffer(rb, np.float32, 18 * nn, 32).astype(np.float64).reshape(nn, 18)
pb, pf = nodes[:, :6], nodes[:, 6:12]
cb = open(sys.argv[1][:-4] + '.centroids.bin', 'rb').read(); m = int(np.frombuffer(cb, np.uint32, 1, 0)[0])
hit = np.frombuffer(cb, np.float32, 3, 4).astype(np.float64); cen = np.frombuffer(cb, np.float32, 3 * m, 16).astype(np.float64).reshape(m, 3)
pos = {}
for l in range(nl):
    b, c0, c1, flags = d['link_u'][l]
    if flags & ol.CONTACT: continue
    for c in (c0, c1): pos.setdefault(int(c), []).append(cen[int(b)])
rows = []
for n in range(nn):
    c = int(d['node_chunk'][n]); mass = 1.0 / d['node_f'][n, 0]
    if d['node_tensor'][n] or c not in pos: continue
    x = np.mean(pos[c], 0); F = pf[n, :3]; Fb = pb[n, :3]
    rows.append((np.linalg.norm(x - hit), c, mass, np.linalg.norm(F), F, np.linalg.norm(Fb)))
rows.sort(key=lambda r: -r[3])
print(f"{len(rows)} chunks; the largest full-level loads (|pf|) against their weight m g:")
for dist, c, mass, f, F, fb in rows[:25]:
    print(f"  chunk {c}: {dist:.1f} m from the hit, {mass:.3g} kg: |pf| {f:.4g} N = {f / (mass * 9.81):.3g} m g, pf ({F[0]:.3g} {F[1]:.3g} {F[2]:.3g}); |pb| {fb:.4g} N")
bins = [(0, 1), (1, 2), (2, 4), (4, 8), (8, 1e9)]
for lo, hi in bins:
    sel = [r for r in rows if lo <= r[0] < hi]
    over = [r for r in sel if r[3] > 2 * r[2] * 9.81]
    print(f"  {lo}-{hi if hi < 1e9 else ''} m: {len(sel)} chunks, {len(over)} loaded past 2 m g, total |pf| {sum(r[3] for r in sel):.4g} N")
