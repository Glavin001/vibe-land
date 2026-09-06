#!/usr/bin/env python3
"""Check retained results; does not run the GPU or contact the city."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent
for name,entry in json.loads((root/'index.json').read_text()).items():
 p=root/name
 assert p.stat().st_size==entry['bytes']
 assert hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256'],name
commands=json.loads((root/'commands.json').read_text())
assert len(commands)==5 and all(c['exit']==c['expected'] for c in commands)
count=0
for command in commands:
 rows=[json.loads(line) for line in (root/(command['name']+'.log')).read_text().splitlines() if line.startswith('{')]
 trials=[r for r in rows if 'trial' in r]
 if command['expected']==0:
  assert len(trials)==4 and all(r['passed'] for r in trials);count+=len(trials)
 else:assert len(trials)==1 and not trials[0]['passed']
assert count==16
small=json.loads((root/'small-oracle-summary.json').read_text())
assert len(small)==12
assert next(r for r in small if r['name']=='released')['negative_controls_rejected']==3
san=(root/'physical-graph-cuda-sanitizer.log').read_text()
assert 'ERROR SUMMARY: 0 errors' in san and '0 bytes leaked in 0 allocations' in san
city=json.loads((root/'city-after-validation.json').read_text())
assert city['binary_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
assert city['settings']['VIBE_PHYSX_DIRECT_GPU']=='1'
print('Verified 16 passing CUDA solves, incomplete-solve rejection, 12 small physical configurations, sanitizer and restored-city evidence.')
