import {Vector3} from 'three';
import {ConvexHull} from 'three/addons/math/ConvexHull.js';

export const EPS = 1e-9;
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const length=a=>Math.hypot(...a);
const key=v=>v.map(x=>Math.round(x/1e-10)).join(',');
export const unique=points=>[...new Map(points.map(v=>[key(v),v])).values()];
export const boundsOverlap=(a,b,epsilon=0)=>a.min.every((v,i)=>v<=b.max[i]+epsilon&&a.max[i]>=b.min[i]-epsilon);

function orderedFace(points,normal){
 const p=unique(points);if(p.length<3)return [];
 const axis=Math.abs(normal[0])<.8?[1,0,0]:[0,1,0],u=cross(normal,axis),ul=length(u);for(let k=0;k<3;k++)u[k]/=ul;const v=cross(normal,u);
 const mapped=p.map(point=>({point,x:dot(point,u),y:dot(point,v)})).sort((a,b)=>a.x-b.x||a.y-b.y);
 const turn=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 const lo=[],hi=[];for(const a of mapped){while(lo.length>1&&turn(lo.at(-2),lo.at(-1),a)<=1e-16)lo.pop();lo.push(a)}for(const a of [...mapped].reverse()){while(hi.length>1&&turn(hi.at(-2),hi.at(-1),a)<=1e-16)hi.pop();hi.push(a)}lo.pop();hi.pop();return [...lo,...hi].map(a=>a.point);
}
export function planeOf(face){
 let n=null,l=0;for(let i=1;i<face.length-1;i++){const candidate=cross(sub(face[i],face[0]),sub(face[i+1],face[0])),size=length(candidate);if(size>l){l=size;n=candidate}}const span=Math.max(...face.map(v=>length(sub(v,face[0]))));if(l<Math.max(1e-18,span*span*1e-8))return null;for(let k=0;k<3;k++)n[k]/=l;return {n,d:dot(n,face[0])};
}
export function poly(faces){
 faces=faces.filter(f=>f.length>=3);const vertices=unique(faces.flat());if(vertices.length<4)return null;
 const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};for(const v of vertices)for(let k=0;k<3;k++){bounds.min[k]=Math.min(bounds.min[k],v[k]);bounds.max[k]=Math.max(bounds.max[k],v[k])}
 const planes=[];for(const f of faces){const p=planeOf(f);if(p&&!planes.some(q=>dot(p.n,q.n)>1-1e-10&&Math.abs(p.d-q.d)<EPS))planes.push(p)}
 const origin=vertices[0];let volume=0;for(const f of faces)for(let i=1;i<f.length-1;i++)volume+=dot(sub(f[0],origin),cross(sub(f[i],origin),sub(f[i+1],origin)))/6;
 if(volume<1e-20)return null;
 return {faces,vertices,planes,bounds,volume};
}
export function hull(points){
 points=unique(points);if(points.length<4)return null;
 const h=new ConvexHull().setFromPoints(points.map(p=>new Vector3(...p))),groups=[];
 for(const face of h.faces){const n=face.normal.toArray(),d=face.constant;let g=groups.find(g=>dot(g.n,n)>1-1e-10&&Math.abs(g.d-d)<EPS);if(!g){g={n,d,points:[]};groups.push(g)}let edge=face.edge;do{g.points.push(edge.head().point.toArray());edge=edge.next;}while(edge!==face.edge)}
 const result=poly(groups.map(g=>orderedFace(g.points,g.n)));if(result)result.planes=groups.map(g=>({n:g.n,d:g.d}));return result;
}
/** Clip a convex polyhedron to n·x <= d. The cap and the opposite half use
 * exactly the same intersection coordinates, with opposite winding. */
export function clip(a,plane){
 const {n,d}=plane;let min=Infinity,max=-Infinity;for(const v of a.vertices){const s=dot(n,v)-d;min=Math.min(min,s);max=Math.max(max,s)}
 if(max<=EPS)return a;if(min>=-EPS)return null;
 const faces=[],cap=[];
 for(const face of a.faces){const out=[];for(let i=0;i<face.length;i++){
  const A=face[i],B=face[(i+1)%face.length],da=dot(n,A)-d,db=dot(n,B)-d;
  if(da<=0)out.push(A);
  if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db),v=A.map((x,k)=>x+t*(B[k]-x));out.push(v);cap.push(v)}else if(Math.abs(da)<EPS)cap.push(A);
 }const f=unique(out);if(f.length>=3&&planeOf(f))faces.push(f)}
 const f=orderedFace(cap,n);if(f.length>=3)faces.push(f);return poly(faces);
}
export function intersection(a,b){if(!boundsOverlap(a.bounds,b.bounds))return null;let inside=a;for(const plane of b.planes){inside=clip(inside,plane);if(!inside)return null}return inside}

/** Exact convex difference: outside slices are disjoint; all shared boundaries
 * are retained. No concave result is ever relabelled as a convex hull. */
export function subtract(a,b){
 if(!boundsOverlap(a.bounds,b.bounds))return {pieces:[a],removed:0};
 const cut=intersection(a,b);if(!cut||cut.volume<1e-18)return {pieces:[a],removed:0};
 const pieces=[];let inside=a;
 const score=p=>a.vertices.reduce((n,v)=>n+(dot(p.n,v)>p.d+EPS?1:0),0);
 const planes=[...b.planes].sort((p,q)=>score(q)-score(p));
 for(const plane of planes){const outside=clip(inside,{n:plane.n.map(x=>-x),d:-plane.d});if(outside)pieces.push(outside);inside=clip(inside,plane);if(!inside)break}
 return {pieces,removed:cut.volume,anchor:cut.bounds.min.map((x,k)=>(x+cut.bounds.max[k])/2)};
}
export function pack(a,origin=[0,0,0]){
 const center=a.bounds.min.map((x,k)=>(x+a.bounds.max[k])/2);
 let local=hull(a.vertices.map(v=>v.map((x,k)=>Math.fround(x-center[k]))));
 if(local){let index=0;while(local.vertices.length>4&&index<local.vertices.length){const vertex=local.vertices[index],candidate=hull(local.vertices.filter((_,i)=>i!==index));if(candidate&&candidate.planes.every(p=>dot(p.n,vertex)-p.d<2e-7)){local=candidate;}else index++;}}
 if(!local)throw Error('Convex hull collapsed during float32 cooking');
 const lookup=new Map(local.vertices.map((p,i)=>[key(p),i]));
 return {type:'convex',position:center.map((x,k)=>Math.fround(x-origin[k])),vertices:local.vertices,faces:local.faces.map(f=>f.map(v=>lookup.get(key(v))))};
}
export function unpack(shape,origin=[0,0,0]){const vertices=shape.vertices.map(p=>p.map((x,k)=>x+origin[k]+(shape.position?.[k]??0)));return hull(vertices)}

/** Full separating-axis test, including edge cross-products. Returns the minimum
 * signed overlap: positive is penetration, zero is touching, negative is a gap. */
export function sat(a,b){
 if(!boundsOverlap(a.bounds,b.bounds,1e-5))return -Infinity;
 let depth=Infinity;
 const axis=n=>{const l=length(n);if(l<1e-10)return true;let amin=Infinity,amax=-Infinity,bmin=Infinity,bmax=-Infinity;for(const v of a.vertices){const d=dot(n,v)/l;amin=Math.min(amin,d);amax=Math.max(amax,d)}for(const v of b.vertices){const d=dot(n,v)/l;bmin=Math.min(bmin,d);bmax=Math.max(bmax,d)}const overlap=Math.min(amax-bmin,bmax-amin);depth=Math.min(depth,overlap);return overlap>=-2e-6};
 for(const p of [...a.planes,...b.planes])if(!axis(p.n))return depth;
 const edges=p=>{if(p.edges)return p.edges;const result=[];for(const face of p.faces)for(let i=0;i<face.length;i++){const d=sub(face[(i+1)%face.length],face[i]),l=length(d);if(l<1e-10)continue;const n=d.map(x=>x/l);if(!result.some(e=>Math.abs(dot(e,n))>1-1e-9))result.push(n)}p.edges=result;return result};
 for(const x of edges(a))for(const y of edges(b))if(!axis(cross(x,y)))return depth;
 return depth;
}

/** Merge adjacent fragments only when the union is convex and volume-preserving.
 * Matching faces identify candidates; this never fills a concave hole. */
export function mergePieces(input){
 let pieces=input;
 for(let pass=0;pass<16;pass++){
  const buckets=new Map();
  for(let i=0;i<pieces.length;i++)for(const plane of pieces[i].planes){
   const first=plane.n.find(x=>Math.abs(x)>1e-7),sign=first<0?-1:1;
   const key=[...plane.n,plane.d].map(x=>Math.round(x*sign/1e-7)).join(',');
   if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push({i,plane,sign});
  }
  const used=new Set(),merged=[];
  for(const bucket of buckets.values())for(let i=0;i<bucket.length;i++)for(let j=i+1;j<bucket.length;j++){
   const x=bucket[i],y=bucket[j];if(x.sign===y.sign||x.i===y.i||used.has(x.i)||used.has(y.i))continue;
   const a=pieces[x.i],b=pieces[y.i];if(!boundsOverlap(a.bounds,b.bounds,EPS))continue;
   const accepts=(a,b,seam)=>a.planes.every(p=>p===seam||b.vertices.every(v=>dot(p.n,v)<=p.d+2e-9));
   if(!accepts(a,b,x.plane)||!accepts(b,a,y.plane))continue;
   const joined=hull([...a.vertices,...b.vertices]);
   if(!joined||joined.vertices.length>128||joined.faces.length>128||Math.abs(joined.volume-a.volume-b.volume)>Math.max(1e-13,(a.volume+b.volume)*1e-7))continue;
   used.add(x.i);used.add(y.i);merged.push(joined);
  }
  if(!used.size)break;pieces=pieces.filter((_,i)=>!used.has(i)).concat(merged);
 }
 return pieces;
}
