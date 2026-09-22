"""Reproduce the small idle failure without changing geometry or live services.

Use an unused label. Run CASE with 16 and 128 stress iterations in separate
processes. The shifted ground matches the sofa's original floor elevation.
"""
import argparse, json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('label');args=p.parse_args()
root=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
source=root/'roof-response-matched-v1-bungalow-meteor'
pack=json.loads((source/'asset.json').read_text());s=pack['scenario']
sofa=next(g for g in s['nodeGroups'] if g.startswith('sofa-'))
for kind,group in [('sofa',sofa),('unfurnished','building'),('furnished',None)]:
 for iterations in [16,128]:
  result=json.loads(json.dumps(pack));q=result['scenario']
  if group is not None:
   keep=[i for i,g in enumerate(s['nodeGroups']) if g==group];remap={i:j for j,i in enumerate(keep)}
   for key in ['nodes','nodeSizes','nodeColliders','nodeTypes','nodeMaterials','nodePieces','nodeGroups']:q[key]=[s[key][i] for i in keep]
   q['bonds']=[{**b,'node0':remap[b['node0']],'node1':remap[b['node1']]} for b in s['bonds'] if b['node0'] in remap and b['node1'] in remap]
  name=f'{args.label}-{kind}-{iterations}';dest=root/name;dest.mkdir()
  (dest/'asset.json').write_text(json.dumps(result,separators=(',',':')))
  (dest/'shot.json').write_text(json.dumps({'mode':'idle','groundTop':.18 if kind=='sofa' else 0}))
  print(f'VIBE_CITY_NATIVE_CORRECTION_LIMIT=1 VIBE_CITY_NATIVE_STRESS_ITERATIONS={iterations} python3 structures/town-kit/repros/house-cannonball/run.py {name}')
