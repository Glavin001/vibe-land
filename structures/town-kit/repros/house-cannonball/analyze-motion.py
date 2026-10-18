"""Quantify raw native movement; sleeping and convergence are separate signals."""
import json,gzip,math,collections
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
def length(v):return math.sqrt(sum(x*x for x in v))
results=[]
for d in sorted(root.glob('video-*')):
 if not (d/'recording.json.gz').exists():continue
 p=json.loads((d/'asset.json').read_text())['scenario'];r=json.loads((d/'report.json').read_text())
 with gzip.open(d/'recording.json.gz','rt') as f:frames=json.load(f)['frames']
 tracks=collections.defaultdict(list)
 for f in frames:
  for b in f['bodies']:tracks[b['id']].append((f['time'],b))
 last=frames[-1];members=collections.defaultdict(list)
 for i,pose,body in last['poses']:members[body].append(i)
 rows=[]
 for body in last['bodies']:
  if body['kinematic']:continue
  track=[(t,b) for t,b in tracks[body['id']] if t>=20]
  travel=sum(length([b['position'][k]-a['position'][k] for k in range(3)]) for (_,a),(_,b) in zip(track,track[1:]))
  net=length([track[-1][1]['position'][k]-track[0][1]['position'][k] for k in range(3)]) if track else 0
  ranges=[max(b['position'][k] for _,b in track)-min(b['position'][k] for _,b in track) for k in range(3)] if track else []
  rows.append({'id':body['id'],'sleeping':body['sleeping'],'position':body['position'],'speed':length(body['linearVelocity']),'angularSpeed':length(body['angularVelocity']),'travel20to30':travel,'net20to30':net,'range20to30':ranges,'roles':dict(collections.Counter(p['nodeTypes'][i] for i in members[body['id']])),'chunks':members[body['id']]})
 moving=sorted([b for b in rows if not b['sleeping']],key=lambda b:b['travel20to30'],reverse=True)
 result={'name':d.name,'impact':r['impact'],'topMoving':moving[:12],'dynamicBodies':len(rows),'awakeBodies':len(moving),'jitteringBodies':sum(b['travel20to30']>.05 and b['net20to30']<b['travel20to30']*.15 for b in moving)}
 results.append(result);print(json.dumps(result))
(root/'motion-analysis.json').write_text(json.dumps(results,indent=2))
