"""Controlled diagnostics on exact deployed house geometry; never modifies staged assets."""
import copy, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
FIELDS=['compressionElastic','compressionFatal','tensionElastic','tensionFatal','shearElastic','shearFatal']
FRAME={'frame-post','frame-beam','floor','ceiling','roof-rafter','roof-ridge','roof-post','stair'}
for profile in ['joints','joints-soft-roof','frame-tenth','frame-hundredth']:
 source=ROOT/'rebound-porch-meteor-c1'
 p=json.loads((source/'asset.json').read_text());s=p['scenario'];m=p['defaults']['solver']['materials']
 if profile.startswith('joints'):
  for b in s['bonds']:
   a,c=(s['nodeTypes'][b[k]] for k in ['node0','node1'])
   if a in FRAME and c in FRAME:b['m']=16
   if a in {'roof','porch-roof'} or c in {'roof','porch-roof'}:b['m']=18
 if profile=='joints-soft-roof':
  for k in FIELDS:m[7][k]=m[18][k]
  m[7]['elasticModulus']=m[18]['elasticModulus']
 if profile.startswith('frame-'):
  scale=.1 if profile=='frame-tenth' else .01
  for i in [0,7,9]:
   for k in FIELDS:m[i][k]*=scale
 name='roof-response-'+profile
 d=ROOT/name;d.mkdir(exist_ok=False)
 (d/'asset.json').write_text(json.dumps(p,separators=(',',':')))
 shot=json.loads((source/'shot.json').read_text());shot.update(sampleTicks=60,durationTicks=900)
 (d/'shot.json').write_text(json.dumps(shot))
 (d/'candidate.json').write_text(json.dumps({'source':str(source),'profile':profile,'diagnosticOnly':True}))
 print(name)
