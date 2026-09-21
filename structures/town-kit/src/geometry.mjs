import { geometry, prismContact, prismVertices } from './dependencies.mjs';
import { materials, M } from './materials.mjs';
export const round=n=>Math.round(n*1e6)/1e6||0;
export const v=a=>({x:round(a[0]),y:round(a[1]),z:round(a[2])});
export const a=v=>[v.x,v.y,v.z];
const frame={x:[1,2,0],y:[0,2,1],z:[0,1,2]};
const empty=()=>({nodes:[],bonds:[],nodeSizes:[],nodeColliders:[],nodeTypes:[],nodeMaterials:[],nodePieces:[],nodeGroups:[]});

export function boundsFor(n,c) {
 const p=a(n.centroid);
 if(c.kind==='cuboid'){const h=a(c.halfExtents);return [p.map((x,i)=>x-h[i]),p.map((x,i)=>x+h[i])];}
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<c.points.length;i++) {const k=i%3,x=c.points[i]+p[k];lo[k]=Math.min(lo[k],x);hi[k]=Math.max(hi[k],x);}return [lo,hi];
}
export function candidates(bounds,cell=2) {
 const buckets=new Map(),pairs=new Set();
 bounds.forEach(([lo,hi],i)=>{for(let x=Math.floor((lo[0]-.001)/cell);x<=Math.floor((hi[0]+.001)/cell);x++)for(let y=Math.floor((lo[1]-.001)/cell);y<=Math.floor((hi[1]+.001)/cell);y++)for(let z=Math.floor((lo[2]-.001)/cell);z<=Math.floor((hi[2]+.001)/cell);z++){
  const key=`${x},${y},${z}`,list=buckets.get(key)??[];for(const j of list)pairs.add(`${j},${i}`);list.push(i);buckets.set(key,list);
 }});return [...pairs].map(p=>p.split(',').map(Number));
}
export class Builder {
 constructor(key,{palette='sage',seed=20260920,group='building'}={}) {this.key=key;this.table=materials(palette);this.s=empty();this.prisms=[];this.bounds=[];this.pieceId=0;this.group=group;this.rng=geometry.mulberry32(seed);}
 box({min,max,material=M.frame,type='frame',fixed=false,split=[1,1,1],pieceId=this.pieceId++}) {
  for(let i=0;i<3;i++) if(!(max[i]>min[i])) throw Error(`Empty ${type}: ${min} / ${max}`);
  for(let x=0;x<split[0];x++)for(let y=0;y<split[1];y++)for(let z=0;z<split[2];z++){
   const q=[x,y,z],lo=min.map((p,i)=>p+(max[i]-p)*q[i]/split[i]),hi=min.map((p,i)=>p+(max[i]-p)*(q[i]+1)/split[i]);
   this.piece({axis:'y',lo:lo[1],hi:hi[1],poly:[[lo[0],lo[2]],[hi[0],lo[2]],[hi[0],hi[2]],[lo[0],hi[2]]],material,type,fixed,pieceId,box:[lo,hi]});
  }return pieceId;
 }
 piece({axis,poly,lo,hi,material=M.frame,type='frame',fixed=false,pieceId=this.pieceId++,box=null}) {
  // Reused stair helpers name a material; local assets use table indices.
  if(typeof material==='string')material=M.frame;
  const [u,w,t]=frame[axis],centre=[0,0,0],pc=geometry.polygonCentroid(poly);centre[u]=pc[0];centre[w]=pc[1];centre[t]=(lo+hi)/2;
  const volume=geometry.polygonArea(poly)*(hi-lo);if(!(volume>1e-9))throw Error(`Degenerate ${type}`);
  const prism={axis,poly,lo,hi};const points=prismVertices(prism);
  const mn=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),mx=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
  const size=mx.map((x,i)=>x-mn[i]);const c=box?{kind:'cuboid',halfExtents:v(size.map(x=>x/2))}:{kind:'convex_hull',points:points.flatMap(p=>p.map((x,k)=>round(x-centre[k])))};
  const s=this.s;s.nodes.push({centroid:v(centre),mass:fixed?0:round(volume*this.table[material].density),volume:round(volume),m:material});
  s.nodeSizes.push(v(size));s.nodeColliders.push(c);s.nodeTypes.push(type);s.nodePieces.push(pieceId);s.nodeGroups.push(this.group);s.nodeMaterials.push(this.table[material].name);
  this.prisms.push(prism);this.bounds.push([mn,mx]);return s.nodes.length-1;
 }
 build() {
  const s=this.s;
  for(const [i,j] of candidates(this.bounds)){
   const [lo,hi]=this.bounds[i],[lo2,hi2]=this.bounds[j];const ov=lo.map((x,k)=>Math.min(hi[k],hi2[k])-Math.max(x,lo2[k]));
   if(ov.some(x=>x<-.00001)||ov.filter(x=>x<=.00001).length>1)continue;
   if(s.nodeGroups[i]!==s.nodeGroups[j])continue;
   let contact;
   if(s.nodeColliders[i].kind==='cuboid'&&s.nodeColliders[j].kind==='cuboid') {
    const k=ov.findIndex(x=>Math.abs(x)<.00001);if(k<0)continue;const axes=[0,1,2].filter(x=>x!==k);const normal=[0,0,0];normal[k]=1;
    contact={area:ov[axes[0]]*ov[axes[1]],normal,centroid:lo.map((x,k)=>(Math.max(x,lo2[k])+Math.min(hi[k],hi2[k]))/2)};
   }else contact=prismContact(this.prisms[i],this.prisms[j],{maxPenetration:1e-5});
   if(!contact||contact.area<1e-7)continue;
   const A=s.nodes[i],B=s.nodes[j],normal=[...contact.normal];if(normal.reduce((q,x,k)=>q+x*(a(B.centroid)[k]-a(A.centroid)[k]),0)<0)for(let k=0;k<3;k++)normal[k]*=-1;
   let mat=this.table[A.m].tensionFatal<=this.table[B.m].tensionFatal?A.m:B.m;
   if(s.nodePieces[i]!==s.nodePieces[j]&&[M.frame,M.siding,M.trim,M.dark,M.oak,M.fabric,M.bedding,M.wall].includes(A.m)&&[M.frame,M.siding,M.trim,M.dark,M.oak,M.fabric,M.bedding,M.wall].includes(B.m))mat=M.joint;
   if(mat===M.joint&&this.group.startsWith('prop-')&&!/fence|gate/.test(this.group))mat=M.furnitureJoint;
   if(s.nodeTypes[i]==='siding'||s.nodeTypes[j]==='siding'||s.nodeTypes[i]==='dentil'||s.nodeTypes[j]==='dentil')mat=M.fastener;
   if((A.m===M.glass)!==(B.m===M.glass))mat=M.glassJoint;
   s.bonds.push({node0:i,node1:j,centroid:v(contact.centroid),normal:v(normal),area:round(contact.area),m:mat});
  }
  return {version:2,key:this.key,title:this.key.replaceAll('-',' '),defaults:{solver:{gravity:-9.81,materials:this.table}},scenario:s};
 }
}

/** No implicit bonds between placed assets: loose furniture stays loose. */
export function composeScene(placements,{key='town-kit-scene',title=key}={}) {
 const s=empty(),table=[],tableMap=new Map();let pieceBase=0;
 for(const {pack,position=[0,0,0],yaw=0,mirror=false,group=null} of placements){
  if(![0,90,180,270].includes(yaw))throw Error('yaw must be a quarter turn');
  const r=yaw*Math.PI/180,co=Math.round(Math.cos(r)),si=Math.round(Math.sin(r));
  const rotate=([x,y,z])=>{x*=mirror?-1:1;return [co*x+si*z,y,-si*x+co*z];};
  const point=p=>v(rotate(a(p)).map((x,k)=>x+position[k]));const offset=s.nodes.length;
  const remap=pack.defaults.solver.materials.map(m=>{const k=JSON.stringify(m);if(!tableMap.has(k)){tableMap.set(k,table.length);table.push(structuredClone(m));}return tableMap.get(k);});
  const q=pack.scenario;
  for(let i=0;i<q.nodes.length;i++){
   const n=q.nodes[i];s.nodes.push({...n,centroid:point(n.centroid),m:remap[n.m??0]});
   let c=q.nodeColliders[i];if(c.kind==='shape')c=q.shapeLibrary[c.shape];
   if(c.kind==='cuboid')c={kind:'cuboid',halfExtents:v(rotate(a(c.halfExtents)).map(Math.abs))};
   else c={kind:'convex_hull',points:Array.from({length:c.points.length/3},(_,j)=>rotate(c.points.slice(j*3,j*3+3))).flat().map(round)};
   s.nodeColliders.push(c);s.nodeSizes.push(v(rotate(a(q.nodeSizes[i])).map(Math.abs)));s.nodeTypes.push(q.nodeTypes[i]);s.nodePieces.push(q.nodePieces[i]+pieceBase);s.nodeGroups.push(group??q.nodeGroups[i]);s.nodeMaterials.push(table[remap[n.m??0]].name);
  }
  for(const b of q.bonds)s.bonds.push({...b,node0:b.node0+offset,node1:b.node1+offset,m:remap[b.m??0],centroid:point(b.centroid),normal:v(rotate(a(b.normal)))});
  // Large nested scenes exceed the JavaScript argument limit with a spread.
  pieceBase+=q.nodePieces.reduce((maximum,piece)=>Math.max(maximum,piece),-1)+1;
 }
 // Identity derives from rotated local geometry, never reused untransformed ids.
 const library=[],shapes=new Map();
 s.nodeColliders=s.nodeColliders.map(c=>{if(c.kind!=='convex_hull')return c;const key=JSON.stringify(c.points);if(!shapes.has(key)){shapes.set(key,library.length);library.push(c);}return {kind:'shape',shape:shapes.get(key)};});
 if(library.length)s.shapeLibrary=library;
 return {version:2,key,title,defaults:{solver:{gravity:-9.81,materials:table}},scenario:s};
}

/** Final export representation; authoring contacts are already complete.
 * Counter and bathtub fragments use equivalent eight-corner hulls after native
 * contact testing. Other assets retain their reviewed representation.
 * Keep slender panels as boxes: PhysX rejects GPU hulls at an
 * internal extent/radius ratio of 100; 50 leaves room for cooking tolerances.
 * Mass, surfaces, anchors, piece identity and bonds are unchanged.
 */
export function nativeColliders(pack) {
 const s=pack.scenario;
 s.nodeColliders=s.nodeColliders.map((c,i)=>{
  if(c.kind!=='cuboid'||!/^(?:prop-)?(?:counter|bathtub)(?:-|$)/.test(s.nodeGroups[i]))return c;
  const h=a(c.halfExtents);
  if(Math.max(...h)/Math.min(...h)>50)return c;
  const points=[];
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])points.push(x*h[0],y*h[1],z*h[2]);
  return {kind:'convex_hull',points};
 });
 return composeScene([{pack}],{key:pack.key,title:pack.title});
}
