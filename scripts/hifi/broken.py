#!/usr/bin/env python3
"""Summarise a test bed run's broken scene bonds (VIBE_TESTBED_SCENE_BONDS=1) by structure and material.
   scripts/hifi/broken.py LABEL [PACK.json]"""
import json, sys, collections, os
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
label = sys.argv[1]
run = json.load(open(f'{root}/target/vehicle-testbed/{label}.json'))['runs'][0]
pack = json.load(open(sys.argv[2] if len(sys.argv) > 2 else run.get('scene') or json.load(open(f'{root}/target/vehicle-testbed/{label}.json'))['scene']))
sc = pack['scenario']; g = sc['nodeGroups']; names = [m['name'] for m in pack['defaults']['solver']['materials']]
mat = {}
for b in sc['bonds']: mat[(b['node0'], b['node1'])] = mat[(b['node1'], b['node0'])] = b['m']
pairs = run.get('sceneBrokenPairs', [])
total = collections.Counter(names[b['m']] for b in sc['bonds'] if g[b['node0']].startswith('framed-house'))
print(f"{label}: {len(pairs)} broken at the end; in the trial window {run.get('sceneBroken')}")
print('  by structure:', collections.Counter(g[a].split('@')[0] for a, b in pairs).most_common(5))
fh = collections.Counter(names[mat[(a, b)]] for a, b in pairs if (a, b) in mat and g[a].startswith('framed-house'))
print('  framed-house by material:', ', '.join(f'{k} {v}/{total[k]}' for k, v in fh.most_common(10)))
