#!/usr/bin/env python3
"""Name the bonds of a destruction_impact_capture_replay trigger report
(IMPACT_TRIGGER_REPORT=1: CSV of bonds past the impact solve's capacity in the
elastic solve) from the scene pack: material, the two chunks' types, centroid.

    python3 scripts/impact/trigger-bonds.py REPORT.txt PACK.json CHUNK_BASE
CHUNK_BASE: the pack's first chunk in the stage (the bridge's
'[destruction] sections: structure S (base B)' line)."""
import csv, collections, io, json, sys
report, pack, base = sys.argv[1], json.load(open(sys.argv[2])), int(sys.argv[3])
s = pack['scenario']; mats = pack['defaults']['solver']['materials']; types = s.get('nodeTypes') or []
index = {(min(b['node0'], b['node1']), max(b['node0'], b['node1'])): b for b in s['bonds']}
lines = open(report).read().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith('bond,material'))
print(lines[start - 1])
rows = list(csv.DictReader(io.StringIO('\n'.join(lines[start:]))))
by = collections.Counter()
for r in rows:
    a, b = int(r['chunk0']) - base, int(r['chunk1']) - base
    pb = index.get((min(a, b), max(a, b)))
    name = mats[pb['m']]['name'] if pb else '?'
    ta, tb = (types[a] if 0 <= a < len(types) else '?'), (types[b] if 0 <= b < len(types) else '?')
    by[(name, *sorted((str(ta), str(tb))))] += 1
    r['name'] = name; r['types'] = f'{ta}--{tb}'; r['centroid'] = pb and pb['centroid']
print(f'{len(rows)} bonds; by material and chunk types:')
for k, v in by.most_common(): print(f'  {v:5d}  {k[0]}  ({k[1]} -- {k[2]})')
print('largest utilisations:')
for r in rows[:25]:
    print(f"  bond {r['bond']}: {r['name']} {r['types']} u {r['utilisation']} area {r['area']} S0 {r['S0']} S1 {r['S1']} Zt {r['Zt']} "
          f"N {r['N']} V {r['V']} T {r['T']} M0 {r['M0']} M1 {r['M1']} at {r['centroid']}")
