#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["numpy>=1.26", "scipy>=1.11"]
# ///
"""Bonds whose section falls back to the square patch of their area (the
rule of physx-bridge/include/bond_section.h), by material and members."""
import sys, os, importlib.util, collections
spec = importlib.util.spec_from_file_location('ss', os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../structures/town-kit/scripts/stress-share.py'))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
pack, s, mats, pos, mass = ss.load(sys.argv[1])
sec = ss.bond_sections(s)
t = [x.split('@')[0] for x in s['nodeTypes']]
c = collections.Counter(); tot = collections.Counter()
for b, bd in enumerate(s['bonds']):
    k = (mats[bd['m']]['name'], ' - '.join(sorted((t[bd['node0']], t[bd['node1']]))))
    tot[k] += 1
    if sec[b] is None: c[k] += 1
print(f"{sys.argv[1].split('/')[-1]}: {sum(c.values())} of {len(sec)} bonds fall back")
for k, n in c.most_common(10): print(f'   {n:5} of {tot[k]:5}  {k}')
