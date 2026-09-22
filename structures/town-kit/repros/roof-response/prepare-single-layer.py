"""Diagnostic: remove independent siding colliders to isolate the second wall layer."""
import json,copy
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
for kind,prefix in [('porch','residential-v1'),('bungalow','matched-v1')]:
 src=ROOT/f'roof-response-{prefix}-{kind}-meteor';p=json.loads((src/'asset.json').read_text());s=p['scenario']
 keep=[i for i,t in enumerate(s['nodeTypes']) if t!='siding'];remap={i:j for j,i in enumerate(keep)}
 for key in ['nodes','nodeSizes','nodeColliders','nodeTypes','nodeMaterials','nodePieces','nodeGroups']:s[key]=[s[key][i] for i in keep]
 s['bonds']=[{**b,'node0':remap[b['node0']],'node1':remap[b['node1']]} for b in s['bonds'] if b['node0'] in remap and b['node1'] in remap]
 for phase in ['standard','half']:
  d=ROOT/f'wall-single-layer-{kind}-{phase}';d.mkdir()
  (d/'asset.json').write_text(json.dumps(p,separators=(',',':')))
  (d/'shot.json').write_text(json.dumps({'position':[-9 if phase=='standard' else -9.5,1.5,0],'direction':[1,0,0],'sampleTicks':30,'durationTicks':1800}))
 print(kind,len(s['nodes']),len(s['bonds']))
# Exact failing input plus additional shape diagnostics, no geometry changes.
src=ROOT/'roof-response-matched-v1-bungalow-meteor';d=ROOT/'collision-audit-bungalow';d.mkdir()
(d/'asset.json').write_bytes((src/'asset.json').read_bytes());shot=json.loads((src/'shot.json').read_text());shot.update(collisionAudit=True,sampleTicks=6,durationTicks=900);(d/'shot.json').write_text(json.dumps(shot))
