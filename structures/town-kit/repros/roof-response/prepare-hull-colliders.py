"""Equivalent convex-box diagnostics: geometry, mass and bonds are preserved."""
import copy,json,itertools
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
for kind,prefix in [('porch','residential-v1'),('bungalow','matched-v1')]:
 src=ROOT/f'roof-response-{prefix}-{kind}-meteor';p=json.loads((src/'asset.json').read_text());s=p['scenario'];library=s.setdefault('shapeLibrary',[]);count=0
 for i,c in enumerate(s['nodeColliders']):
  if c['kind']!='cuboid':continue
  h=[c['halfExtents'][k] for k in 'xyz']
  if max(h)/min(h)>=90:continue
  points=[v for signs in itertools.product([0,2],repeat=3) for v in [signs[k]*h[k] for k in range(3)]]
  s['nodeColliders'][i]={'kind':'shape','shape':len(library)};library.append({'kind':'convex_hull','points':points})
  for k,half in zip('xyz',h):s['nodes'][i]['centroid'][k]-=half
  count+=1
 print(kind,count)
 for weapon in ['cannonball','meteor']:
  d=ROOT/f'wall-hulls-{kind}-{weapon}';d.mkdir();(d/'asset.json').write_text(json.dumps(p,separators=(',',':')))
  shot=json.loads((src/'shot.json').read_text());shot.update(kind=weapon,position=[-9,1.5,0] if weapon=='cannonball' else [0,2,0],sampleTicks=30,durationTicks=1800)
  (d/'shot.json').write_text(json.dumps(shot))
