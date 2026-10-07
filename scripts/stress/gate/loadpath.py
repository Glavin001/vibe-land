#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Vertical load crossing a horizontal cut, by the member types joined, front
wall zone only (z < zmax), oracle with real sections and rotational stiffness."""
import sys, os, importlib.util, collections
import numpy as np
spec = importlib.util.spec_from_file_location('ss', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../structures/town-kit/scripts/stress-share.py'))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
path, cut, zmax = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
pack, s, mats, pos, mass = ss.load(path)
sec = ss.bond_sections(s)
J, _ = ss.solve(s, mats, pos, mass, angular='section', sections=sec)
st = ss.stresses(s, mats, J, bending='section', sections=sec, pos=pos)
t = [x.split('@')[0] for x in s['nodeTypes']]
groups = collections.defaultdict(lambda: [0.0, 0, 0.0])
for b, bd in enumerate(s['bonds']):
    i, j = bd['node0'], bd['node1']
    c = np.array([bd['centroid'][k] for k in 'xyz'])
    if c[2] > zmax: continue
    lo, hi = (i, j) if pos[i][1] < pos[j][1] else (j, i)
    if not (pos[lo][1] < cut < pos[hi][1]): continue
    # J acts on node1 (+): the force the lower part exerts upward on the upper
    f = J[b, :3] if hi == bd['node1'] else -J[b, :3]
    key = ' - '.join(sorted((t[lo], t[hi]))) + f"  [{mats[bd['m']]['name']}]"
    g = groups[key]; g[0] += f[1]; g[1] += 1; g[2] = max(g[2], st[b, 0])
total = sum(g[0] for g in groups.values())
print(f'{path.split("/")[-1]}: upward force across y = {cut} m, z < {zmax}: {total / 1000:.2f} kN')
for k, (fy, n, u) in sorted(groups.items(), key=lambda kv: -abs(kv[1][0])):
    if abs(fy) > 0.005 * abs(total):
        print(f'   {fy / 1000:8.2f} kN  {n:4} bonds  max util {u:6.2f}  {k}')
