"""Conservative world AABB separation: positive gaps prove no geometric contact."""
import json,gzip,numpy as np
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'out/reviews/house-cannonball'
for name in ['video-bungalow-meteor','video-porch-house-cannonball']:
 d=root/name;s=json.loads((d/'asset.json').read_text())['scenario']
 with gzip.open(d/'recording.json.gz','rt') as f:frames=json.load(f)['frames']
 f=frames[-1];lo=[];hi=[];ids=[];indices=[]
 for i,p,body in f['poses']:
  c=s['nodeColliders'][i]
  if c['kind']=='shape':c=s['shapeLibrary'][c['shape']]
  if c['kind']=='convex_hull':v=np.array(c['points']).reshape(-1,3)
  else:
   h=np.array([c['halfExtents'][k] for k in ['x','y','z']]);v=np.array([[x,y,z] for x in [-1,1] for y in [-1,1] for z in [-1,1]])*h
  q=np.array(p[3:7]);q=q/np.linalg.norm(q);x,y,z,w=q
  R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
  v=v@R.T+np.array(p[:3]);lo.append(v.min(0));hi.append(v.max(0));ids.append(body);indices.append(i)
 lo=np.array(lo);hi=np.array(hi);ids=np.array(ids);rows=[]
 for b in f['bodies']:
  if b['kinematic']:continue
  own=ids==b['id'];bottom=float(lo[own,1].min())
  if bottom<.1:continue
  gap=min(float(np.sqrt((np.maximum(0,np.maximum(a-hi[~own],lo[~own]-z))**2).sum(1)).min()) for a,z in zip(lo[own],hi[own]))
  if gap>.05:rows.append({'id':b['id'],'bottom':bottom,'gapToOtherGeometry':gap,'body':b,'chunks':[indices[j] for j in np.where(own)[0]],'roles':[s['nodeTypes'][indices[j]] for j in np.where(own)[0]]})
 (d/'suspension.json').write_text(json.dumps(rows,indent=2));print(name,json.dumps(rows))
