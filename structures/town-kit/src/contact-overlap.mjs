/**
 * The area two convex chunks' faces share in their bond plane: each solid's
 * section in the plane (its face resting on it, or where its edges cross it),
 * one clipped by the other. The same construction as the native bridge's
 * bond sections (physx-bridge/include/bond_section.h slice / clip), so an
 * authored contact can be held to it: a contact cannot be larger than its
 * faces' overlap (FIDELITY_AUDIT B3). A face within `tol` of the plane counts.
 */
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const cross2=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);

function hull2(p){
 p=[...p].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);if(p.length<3)return p;
 const h=[];
 for(const q of p){while(h.length>=2&&cross2(h[h.length-2],h[h.length-1],q)<=0)h.pop();h.push(q);}
 const t=h.length+1;
 for(let i=p.length-2;i>=0;i--){const q=p[i];while(h.length>=t&&cross2(h[h.length-2],h[h.length-1],q)<=0)h.pop();h.push(q);}
 h.pop();return h;
}

function slice(pts,c,n,u,v,tol){
 const d=pts.map(p=>dot(sub(p,c),n)),lo=Math.min(...d),hi=Math.max(...d);
 const shift=lo>tol?lo:hi<-tol?hi:0;
 if(shift){c=c.map((x,k)=>x+n[k]*shift);for(let i=0;i<d.length;i++)d[i]-=shift;}
 const q=[],put=p=>{const r=sub(p,c);q.push([dot(r,u),dot(r,v)]);};
 pts.forEach((p,i)=>{if(Math.abs(d[i])<=tol)put(p);});
 for(let i=0;i<pts.length;i++){if(!(d[i]<-tol))continue;
  for(let j=0;j<pts.length;j++){if(!(d[j]>tol))continue;const t=d[i]/(d[i]-d[j]);put(pts[i].map((x,k)=>x+(pts[j][k]-x)*t));}}
 return q.length>=3?hull2(q):[];
}

function clip(a,b){
 for(let k=0;k<b.length&&a.length;k++){
  const e0=b[k],e1=b[(k+1)%b.length],inside=p=>cross2(e0,e1,p)>=-1e-15;
  const cut=(p,q)=>{const dp=cross2(e0,e1,p),dq=cross2(e0,e1,q),t=dp/(dp-dq);return [p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])];};
  const input=a;a=[];
  for(let i=0;i<input.length;i++){const p=input[i],q=input[(i+1)%input.length];
   if(inside(q)){if(!inside(p))a.push(cut(p,q));a.push(q);}else if(inside(p))a.push(cut(p,q));}
 }
 return a;
}

const area2=p=>{let s=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];s+=a[0]*b[1]-b[0]*a[1];}return s/2;};

/** Overlap area (m^2) of two vertex sets' faces in the plane through `centroid` with normal `normal`. */
export function faceOverlap(pointsA,pointsB,centroid,normal,tol=1e-4){
 const len=Math.hypot(...normal);if(!(len>0))return 0;const n=normal.map(x=>x/len);
 let u=cross(n,Math.abs(n[0])<.9?[1,0,0]:[0,1,0]);const ul=Math.hypot(...u);u=u.map(x=>x/ul);const v=cross(n,u);
 const A=slice(pointsA,centroid,n,u,v,tol),B=slice(pointsB,centroid,n,u,v,tol);
 if(A.length<3||B.length<3)return 0;
 const P=clip(A,B);return P.length>=3?Math.max(0,area2(P)):0;
}
