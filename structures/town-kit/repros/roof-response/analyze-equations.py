"""Inspect exact captured native equations for tiny, unanchored reproductions.

This reports floating-point cycle closure and the operator's singular values.
It does not replace the native solver or waive its convergence gate.
"""
import argparse,json
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser();p.add_argument('prefix',type=Path);args=p.parse_args()
node=np.dtype([('inertia','<f4',(2,)),('rhs','<f4',(6,)),('residual','<f4',(6,)),('threshold','<f4'),('component','<u4')])
bond=np.dtype([('first','<u4'),('second','<u4'),('offset0','<f4',(3,)),('offset1','<f4',(3,)),('health','<f4'),('scale','<f4'),('warm','<f4',(6,))])
n=np.fromfile(str(args.prefix)+'.nodes.bin',dtype=node);b=np.fromfile(str(args.prefix)+'.bonds.bin',dtype=bond)
assert 0<len(n)<=128 and np.all(n['inertia']>0),'Use a small, fully dynamic component'
assert len(set(n['component']))==1 and np.all(b['health']>0),'Requires one intact component'
positions=[None]*len(n);positions[0]=np.zeros(3)
for _ in range(len(n)):
 for q in b:
  first,second=int(q['first']),int(q['second']);delta=q['offset0'].astype(float)-q['offset1'].astype(float)
  if positions[first] is not None and positions[second] is None:positions[second]=positions[first]+delta
  if positions[second] is not None and positions[first] is None:positions[first]=positions[second]-delta
assert all(x is not None for x in positions)
closure=np.array([positions[int(q['first'])]+q['offset0'].astype(float)-q['offset1'].astype(float)-positions[int(q['second'])] for q in b])
B=np.zeros((6*len(n),6*len(b)))
def skew(v):
 x,y,z=v;return np.array([[0,-z,y],[z,0,-x],[-y,x,0]])
for j,q in enumerate(b):
 for side in [0,1]:
  i=int(q['first' if side==0 else 'second']);block=np.eye(6);block[:3,3:]=-skew(q['offset'+str(side)])
  block[:3]*=float(n[i]['inertia'][0]);block[3:]*=float(n[i]['inertia'][1])
  B[6*i:6*i+6,6*j:6*j+6]=block*float(q['scale'])*(1 if side==0 else -1)
u,values,_=np.linalg.svd(B,full_matrices=False);rhs=n['rhs'].astype(float).ravel()
result={'nodes':len(n),'bonds':len(b),'maximumNormalizedCycleClosure':float(abs(closure).max()),'nonzeroClosureEdges':int(np.any(closure!=0,axis=1).sum()),'smallestSingularValues':values[-10:].tolist(),'rhsComponentsInThoseDirections':(u.T@rhs)[-10:].tolist(),'nativeThreshold':float(n['threshold'][0])}
Path(str(args.prefix)+'.analysis.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
