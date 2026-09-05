import json,time,sys
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import cg,LinearOperator,lsqr
path=sys.argv[1]
s=json.load(open(path));nodes=np.asarray(s['nodes'],dtype=np.float64);bonds=np.asarray(s['bonds'],dtype=np.float64)
ids=bonds[:,:2].astype(np.int64);dyn=nodes[:,3]>0
used=np.unique(ids);active=used[dyn[used]]; mapping=np.full(len(nodes),-1,dtype=np.int64);mapping[active]=np.arange(len(active))
p0=nodes[ids[:,0],:3];p1=nodes[ids[:,1],:3];d0=dyn[ids[:,0]];d1=dyn[ids[:,1]]
o0=.5*(p1-p0);o1=-o0.copy();o0[~d1]=bonds[~d1,2:5]-p0[~d1];o1[~d1]=-o0[~d1];o1[~d0]=bonds[~d0,2:5]-p1[~d0];o0[~d0]=-o1[~d0]
length=(np.linalg.norm(o0[d0],axis=1).sum()+np.linalg.norm(o1[d1],axis=1).sum())/(d0.sum()+d1.sum())
mass=np.exp(np.log(nodes[dyn,3]).mean()); inv=np.column_stack((np.sqrt(mass*length*length/nodes[active,4]),np.sqrt(mass/nodes[active,3])))
D=np.repeat(inv,3,axis=1);rows=[];cols=[];values=[]
for side,(offset,sign,mask) in enumerate(((o0,1,d0),(o1,-1,d1))):
 bs=np.flatnonzero(mask);ns=mapping[ids[bs,side]];r=offset[bs]/length;scale=bonds[bs,5]*sign
 for axis in range(6):
  rows.append(6*ns+axis);cols.append(6*bs+axis);values.append(D[ns,axis]*scale)
 for i,j,k,sgn in ((0,1,2,1),(0,2,1,-1),(1,0,2,-1),(1,2,0,1),(2,0,1,1),(2,1,0,-1)):
  rows.append(6*ns+i);cols.append(6*bs+3+j);values.append(D[ns,i]*scale*r[:,k]*sgn)
B=coo_matrix((np.concatenate(values),(np.concatenate(rows),np.concatenate(cols))),shape=(6*len(active),6*len(bonds))).tocsr();A=(B@B.T).tocsr()
b=np.zeros((len(active),6));b[:,4]=-s['gravity']/(length*D[:,4]);b=b.ravel()
force_scale=(mass*length/D[:,3:]);force_norm=np.linalg.norm(nodes[active,3]*s['gravity'])
def residual(r):return np.linalg.norm((r.reshape(-1,6)[:,3:]*force_scale).ravel())/force_norm
print('matrix',B.shape,'nodes',len(active),'nnz',A.nnz,'mass range',nodes[active,3].min(),nodes[active,3].max(),'length',length,flush=True)
blocks=A.tobsr(blocksize=(6,6));blockrows=np.repeat(np.arange(len(active)),np.diff(blocks.indptr));diag=blocks.data[blocks.indices==blockrows];assert len(diag)==len(active)
inverse=np.linalg.inv(diag)
M=LinearOperator(A.shape,matvec=lambda r:np.einsum('nij,nj->ni',inverse,r.reshape(-1,6)).ravel(),dtype=np.float64)
for name,pre in [('cg',None),('block_pcg',M)]:
 ticks=[0];t=time.monotonic()
 def cb(x):
  ticks[0]+=1
  if ticks[0] in (1,8,32,64,128,256,512,1024,2048):print(name,ticks[0],'force_residual',residual(b-A@x),'seconds',time.monotonic()-t,flush=True)
 x,info=cg(A,b,M=pre,rtol=1e-8,atol=0,maxiter=2048,callback=cb)
 print(name,'end',ticks[0],info,residual(b-A@x),flush=True)
for iters in (32,128,512):
 t=time.monotonic();x=lsqr(B,b,atol=0,btol=0,iter_lim=iters)[0]
 print('lsqr',iters,'force_residual',residual(b-B@x),'seconds',time.monotonic()-t,flush=True)
