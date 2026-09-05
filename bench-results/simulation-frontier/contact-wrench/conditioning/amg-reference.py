# CPU/double prototype on the exported anchored graph, not a GPU implementation.
from pathlib import Path
exec(Path(__file__).with_name('pcg-reference.py').read_text().split("for name,pre in")[0])
from scipy.sparse import csr_matrix,block_diag
from scipy.linalg import cho_factor,cho_solve
from scipy.sparse.linalg import eigsh
n=len(active);pos=nodes[active,:3]/length;pos-=pos.mean(axis=0)
null=np.zeros((n,6,6));null[:,:3,:3]=np.eye(3);null[:,3:,3:]=np.eye(3)
for i,j,k,sgn in ((0,1,2,-1),(0,2,1,1),(1,0,2,1),(1,2,0,-1),(2,0,1,-1),(2,1,0,1)):
 null[:,3+i,j]=pos[:,k]*sgn
null=(null/D[:,:,None]).reshape(-1,6)
levels=[]; current=A; basis=null
start=time.monotonic()
for level in range(8):
 nb=current.shape[0]//6
 if nb<30:break
 ab=current.tobsr(blocksize=(6,6));br=np.repeat(np.arange(nb),np.diff(ab.indptr));diag=ab.data[ab.indices==br];di=np.linalg.inv(diag)
 invop=block_diag(di,format='csr')
 # Estimate the largest eigenvalue using the symmetric block-whitened matrix.
 chol=np.linalg.cholesky(diag);white=block_diag(np.linalg.inv(chol),format='csr')
 whitened=white@current@white.T
 rho=float(eigsh(whitened,k=1,which='LA',tol=1e-3,return_eigenvectors=False)[0]);omega=1.0/(rho*1.05)
 # Greedy connected aggregates of at most eight block nodes.
 owner=np.full(nb,-1,dtype=np.int64);groups=[]
 for i in range(nb):
  if owner[i]>=0:continue
  group=[i];owner[i]=len(groups);queue=[i]
  while queue and len(group)<8:
   v=queue.pop(0);neighbors=ab.indices[ab.indptr[v]:ab.indptr[v+1]]
   for j in neighbors:
    if owner[j]<0:
     owner[j]=len(groups);group.append(int(j));queue.append(int(j))
     if len(group)==8:break
  groups.append(group)
 row=[];col=[];val=[];coarse_basis=[]
 for i,group in enumerate(groups):
  dofs=(6*np.asarray(group)[:,None]+np.arange(6)).ravel();Q,R=np.linalg.qr(basis[dofs],mode='reduced');coarse_basis.append(R)
  row.append(np.repeat(dofs,6));col.append(np.tile(6*i+np.arange(6),len(dofs)));val.append(Q.ravel())
 tentative=coo_matrix((np.concatenate(val),(np.concatenate(row),np.concatenate(col))),shape=(6*nb,6*len(groups))).tocsr()
 # Smooth the interpolation; exact Galerkin, no coefficient dropping.
 P=tentative-omega*(invop@(current@tentative));nextA=(P.T@current@P).tocsr();nextA=(nextA+nextA.T)*.5
 levels.append((current,invop,omega,P));print('level',level,'blocks',nb,'nnz',current.nnz,'to',len(groups),'rho',rho,flush=True)
 current=nextA;basis=np.vstack(coarse_basis)
coarse_factor=cho_factor(current.toarray());print('setup_seconds',time.monotonic()-start,'coarse',current.shape,flush=True)
def cycle(level,rhs):
 if level==len(levels):return cho_solve(coarse_factor,rhs)
 a,d,w,p=levels[level];x=np.zeros_like(rhs)
 for _ in range(2):x+=w*(d@(rhs-a@x))
 x+=p@cycle(level+1,p.T@(rhs-a@x))
 for _ in range(2):x+=w*(d@(rhs-a@x))
 return x
pre=LinearOperator(A.shape,matvec=lambda rhs:cycle(0,rhs),dtype=np.float64)
it=[0];start=time.monotonic()
def cb(x):
 it[0]+=1
 if it[0] in (1,4,8,16,32,64,128,256):print('amg_pcg',it[0],'force_residual',residual(b-A@x),'seconds',time.monotonic()-start,flush=True)
x,info=cg(A,b,M=pre,rtol=1e-8,atol=0,maxiter=256,callback=cb)
print('amg_pcg end',it[0],info,residual(b-A@x),'seconds',time.monotonic()-start,flush=True)
