"""Diagnostic exterior: boarding spans the frame without a second solid infill layer.

Preserves every siding board and its existing contact bonds. Does not increase
strength, inject damage, alter geometry or remove the load-bearing frame.
"""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
for kind,prefix in [('porch','residential-v1'),('bungalow','matched-v1')]:
 source=root/f'roof-response-{prefix}-{kind}-meteor';p=json.loads((source/'asset.json').read_text());s=p['scenario'];keep=[]
 for i,n in enumerate(s['nodes']):
  c=n['centroid'];size=s['nodeSizes'][i]
  exterior=s['nodeTypes'][i]=='wall-infill' and (abs(c['x'])>4.81 or abs(c['z'])>5.81)
  # Porch-house only: retain the interior stair enclosure for this first control.
  if not exterior:keep.append(i)
 remap={i:j for j,i in enumerate(keep)}
 for key in ['nodes','nodeSizes','nodeColliders','nodeTypes','nodeMaterials','nodePieces','nodeGroups']:s[key]=[s[key][i] for i in keep]
 s['bonds']=[{**b,'node0':remap[b['node0']],'node1':remap[b['node1']]}for b in s['bonds']if b['node0']in remap and b['node1']in remap]
 for phase in ['standard','half']:
  d=root/f'single-skin-{kind}-{phase}';d.mkdir();(d/'asset.json').write_text(json.dumps(p,separators=(',',':')))
  (d/'shot.json').write_text(json.dumps({'position':[9 if phase=='standard'else 9.5,1.5,0],'direction':[-1,0,0],'durationTicks':1800,'sampleTicks':12}))
 print(kind,len(s['nodes']),len(s['bonds']))
