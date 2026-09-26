/** Signed tetrahedral integrals of a closed oriented mesh: m, kg, kg m².
 * A nearby reference keeps small parts precise; cavity surfaces subtract mass.
 */
export function meshMassProperties(positions, indices, mass) {
  if (!Number.isFinite(mass) || mass<=0 || positions.length%3 || indices.length%3 || !indices.length) throw Error('Invalid mass or mesh');
  const reference=[positions[0],positions[1],positions[2]],first=[0,0,0],second=Array.from({length:3},()=>[0,0,0]);
  let volume=0;
  for(let t=0;t<indices.length;t+=3) {
    const points=[0,1,2].map(c=>{
      const index=indices[t+c];
      if(!Number.isInteger(index)||index<0||index*3+2>=positions.length)throw Error('Invalid mesh index');
      return reference.map((r,i)=>{const v=positions[index*3+i]-r;if(!Number.isFinite(v))throw Error('Nonfinite vertex');return v;});
    });
    const [a,b,c]=points;
    const v=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    volume+=v;const sum=[0,1,2].map(i=>a[i]+b[i]+c[i]);
    for(let i=0;i<3;i++) {
      first[i]+=v*sum[i]/4;
      for(let j=0;j<3;j++)second[i][j]+=v*(sum[i]*sum[j]+points.reduce((n,p)=>n+p[i]*p[j],0))/20;
    }
  }
  if(!Number.isFinite(volume)||volume<=0)throw Error('Mesh has no positive oriented volume');
  const localCenter=first.map(v=>v/volume);
  const covariance=second.map((row,i)=>row.map((v,j)=>mass*(v/volume-localCenter[i]*localCenter[j])));
  const trace=covariance[0][0]+covariance[1][1]+covariance[2][2];
  const inertia=covariance.map((row,i)=>row.map((v,j)=>(i===j?trace:0)-v));
  if(!inertia.flat().every(Number.isFinite)||inertia.some((row,i)=>row[i]<=0))throw Error('Invalid authored inertia');
  return {mass,volume,center:localCenter.map((v,i)=>v+reference[i]),inertia};
}
/** Parallel-axis theorem, retaining asymmetric products of inertia. */
export function combineMassProperties(parts) {
  const mass=parts.reduce((s,p)=>s+p.mass,0);
  if(!Number.isFinite(mass)||mass<=0)throw Error('Assembly has no mass');
  const center=[0,1,2].map(i=>parts.reduce((s,p)=>s+p.mass*p.center[i],0)/mass);
  const inertia=Array.from({length:3},()=>[0,0,0]);
  for(const p of parts) {
    const d=p.center.map((v,i)=>v-center[i]),r2=d.reduce((s,v)=>s+v*v,0);
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)inertia[i][j]+=p.inertia[i][j]+p.mass*((i===j?r2:0)-d[i]*d[j]);
  }
  return {mass,center,inertia};
}
/** Source-to-actor is a proper Y half-turn: I' = R I R^T. */
export function massPropertiesToActor(p,originHeight) {
  const sign=[-1,1,-1];
  return {...p,center:p.center.map((v,i)=>sign[i]*v-(i===1?originHeight:0)),inertia:p.inertia.map((row,i)=>row.map((v,j)=>sign[i]*sign[j]*v))};
}
/** Mass-preserving affine map x' = L x + t of a solid (rigid motion, axial
 * compression, shear). Mass is unchanged; density follows det L. Exact because
 * the second moment C = ∫ρ(x-c)(x-c)ᵀ maps as L C Lᵀ and I = tr(C)·1 - C.
 */
export function transformMassProperties(p,linear,translation) {
  const L=linear,det=L[0][0]*(L[1][1]*L[2][2]-L[1][2]*L[2][1])-L[0][1]*(L[1][0]*L[2][2]-L[1][2]*L[2][0])+L[0][2]*(L[1][0]*L[2][1]-L[1][1]*L[2][0]);
  if(!Number.isFinite(p.mass)||p.mass<=0||![...L.flat(),...translation,...p.center,...p.inertia.flat()].every(Number.isFinite)||!(det>0))throw Error('Invalid mass transform');
  const half=(p.inertia[0][0]+p.inertia[1][1]+p.inertia[2][2])/2;
  const C=p.inertia.map((row,i)=>row.map((v,j)=>(i===j?half:0)-v));
  const LC=L.map(row=>[0,1,2].map(j=>row.reduce((s,v,k)=>s+v*C[k][j],0)));
  const moved=LC.map(row=>[0,1,2].map(j=>row.reduce((s,v,k)=>s+v*L[j][k],0)));
  const trace=moved[0][0]+moved[1][1]+moved[2][2];
  return {...p,...(p.volume===undefined?{}:{volume:p.volume*det}),
    center:L.map((row,i)=>row.reduce((s,v,k)=>s+v*p.center[k],translation[i])),
    inertia:moved.map((row,i)=>row.map((v,j)=>(i===j?trace:0)-v))};
}
