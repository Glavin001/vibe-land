"""Diagnostic attachment hierarchy: siding stays on backing as frame clips release."""
import copy,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
FIELDS=['compressionElastic','compressionFatal','tensionElastic','tensionFatal','shearElastic','shearFatal']
for kind in ['porch','bungalow']:
 src=ROOT/f'roof-response-residential-v1-{kind}-cannonball'
 pack=json.loads((src/'asset.json').read_text());s=pack['scenario'];m=pack['defaults']['solver']['materials'];remap={}
 def scaled(i):
  if i not in remap:
   mat=copy.deepcopy(m[i]);mat['name']+='-diagnostic-panel-clip'
   for field in FIELDS:mat[field]*=.1
   remap[i]=len(m);m.append(mat)
  return remap[i]
 for b in s['bonds']:
  types={s['nodeTypes'][b[k]] for k in ['node0','node1']}
  if types=={'siding','wall-infill'}:b['m']=0
  elif types.intersection({'siding','wall-infill'}):b['m']=scaled(b['m'])
 for phase in ['standard','half']:
  d=ROOT/f'roof-response-cassette-{kind}-{phase}';d.mkdir()
  (d/'asset.json').write_text(json.dumps(pack,separators=(',',':')))
  shot=json.loads((src/'shot.json').read_text());shot['sampleTicks']=30
  if phase=='half':shot['position'][0]-=.5
  (d/'shot.json').write_text(json.dumps(shot))
