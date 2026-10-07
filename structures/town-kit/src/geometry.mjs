import {realCapacitiesEnabled,characteristicLegacy,GLUED_JOINT} from './real-capacities.mjs';
import {faceOverlap} from './contact-overlap.mjs';
import { geometry, prismContact, prismVertices } from './dependencies.mjs';
import { materials, M, crushFor, crushEnabled, concreteFooting } from './materials.mjs';
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
 constructor(key,{palette='sage',seed=20260920,group='building'}={}) {this.key=key;this.table=materials(palette);
  // VIBE_REAL_CAPACITIES=1: the legacy doubled timber/masonry limits as
  // characteristic values, and furniture joints as glued joints (real-capacities.mjs).
  if(realCapacitiesEnabled()){characteristicLegacy(this.table);Object.assign(this.table[M.furnitureJoint],GLUED_JOINT);}this.s=empty();this.prisms=[];this.bounds=[];this.pieceId=0;this.group=group;this.rng=geometry.mulberry32(seed);}
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
  if(fixed&&buriedAnchorsEnabled()){const split=this.buryAnchor({axis,poly,lo,hi,material,type,pieceId,box});if(split!=null)return split;}
  const [u,w,t]=frame[axis],centre=[0,0,0],pc=geometry.polygonCentroid(poly);centre[u]=pc[0];centre[w]=pc[1];centre[t]=(lo+hi)/2;
  const volume=geometry.polygonArea(poly)*(hi-lo);if(!(volume>1e-9))throw Error(`Degenerate ${type}`);
  const prism={axis,poly,lo,hi};const points=prismVertices(prism);
  const mn=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),mx=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
  const size=mx.map((x,i)=>x-mn[i]);const c=box?{kind:'cuboid',halfExtents:v(size.map(x=>x/2))}:{kind:'convex_hull',points:points.flatMap(p=>p.map((x,k)=>round(x-centre[k])))};
  const s=this.s;s.nodes.push({centroid:v(centre),mass:fixed?0:round(volume*this.table[material].density),volume:round(volume),m:material});
  s.nodeSizes.push(v(size));s.nodeColliders.push(c);s.nodeTypes.push(type);s.nodePieces.push(pieceId);s.nodeGroups.push(this.group);s.nodeMaterials.push(this.table[material].name);
  this.prisms.push(prism);this.bounds.push([mn,mx]);return s.nodes.length-1;
 }
 /**
  * TOWN_KIT_BURIED_ANCHORS=1: only the ground is fixed. A fixed piece standing
  * more than ANCHOR_TOLERANCE proud of grade (y = 0 in the builder's frame)
  * becomes a member -- the part above grade in plain concrete (M.concrete),
  * with mass, its bonds and its crushing -- on a fixed anchor at or below
  * grade, bonded across the whole footprint as the paving sits on its
  * subgrade. A mass-0 chunk is kinematic and unbreakable: the veneer house's
  * 0.155 m strip footing threw the meteor up at 40 m/s where crushing concrete
  * allows 9.5 (physx-bridge/tests/infinite_wall.rs meteor_on_a_foundation).
  * A y-extruded piece through grade splits at grade; one wholly above it (a
  * kerb, a deck, a ramp's wedge) gets an anchor 0.1 m deep under its footprint.
  * Returns the member's node, or null to keep the piece fixed.
  */
 buryAnchor({axis,poly,lo,hi,material,type,pieceId,box}) {
  const pts=prismVertices({axis,poly,lo,hi});const ys=pts.map(p=>p[1]),bottom=Math.min(...ys),top=Math.max(...ys);
  if(top<=ANCHOR_TOLERANCE)return null;
  const concrete=M.concrete;
  if(axis==='y'&&bottom<0){
   this.piece({axis,poly,lo,hi:0,material,type,fixed:true,pieceId,box:box&&[box[0],[box[1][0],0,box[1][2]]]});
   return this.piece({axis,poly,lo:0,hi,material:concrete,type,fixed:false,pieceId,box:box&&[[box[0][0],0,box[0][2]],box[1]]});
  }
  // Straddling grade on another axis, or floating above it: left fixed, the lint reports it.
  if(bottom<-ANCHOR_TOLERANCE||bottom>ANCHOR_TOLERANCE)return null;
  const xs=pts.map(p=>p[0]),zs=pts.map(p=>p[2]);
  const node=this.piece({axis,poly,lo,hi,material:concrete,type,fixed:false,pieceId,box});
  this.box({min:[Math.min(...xs),bottom-0.1,Math.min(...zs)],max:[Math.max(...xs),bottom,Math.max(...zs)],material,type:`${type}-anchor`,fixed:true,pieceId:this.pieceId++});
  return node;
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
   }else{
    contact=prismContact(this.prisms[i],this.prisms[j],{maxPenetration:1e-5});
    // Real capacities: a contact cannot be larger than its faces' overlap in the bond plane
    // (a mitred rafter end's bounding face read 3% over its top face, a plumb cut 15% over the
    // ridge board); the native sections take the overlap's shape only when the area fits it.
    if(contact&&realCapacitiesEnabled()){
     const overlap=faceOverlap(prismVertices(this.prisms[i]),prismVertices(this.prisms[j]),contact.centroid,contact.normal);
     if(overlap>1e-7&&overlap<contact.area)contact={...contact,area:overlap};
    }
   }
   if(!contact||contact.area<1e-7)continue;
   const A=s.nodes[i],B=s.nodes[j],normal=[...contact.normal];if(normal.reduce((q,x,k)=>q+x*(a(B.centroid)[k]-a(A.centroid)[k]),0)<0)for(let k=0;k<3;k++)normal[k]*=-1;
   let mat=this.table[A.m].tensionFatal<=this.table[B.m].tensionFatal?A.m:B.m;
   if(s.nodePieces[i]!==s.nodePieces[j]&&[M.frame,M.siding,M.trim,M.dark,M.oak,M.fabric,M.bedding,M.wall].includes(A.m)&&[M.frame,M.siding,M.trim,M.dark,M.oak,M.fabric,M.bedding,M.wall].includes(B.m))mat=M.joint;
   if(mat===M.joint&&this.group.startsWith('prop-')&&!/fence|gate/.test(this.group))mat=M.furnitureJoint;
   if(s.nodeTypes[i]==='siding'||s.nodeTypes[j]==='siding'||s.nodeTypes[i]==='dentil'||s.nodeTypes[j]==='dentil')mat=M.fastener;
   // Masonry on masonry, or bedded on a footing: a mortar joint (materials.mjs MORTAR_JOINT).
   const bed=m=>m===M.footing||m===M.concrete;
   if((A.m===M.brick&&(B.m===M.brick||bed(B.m)))||(B.m===M.brick&&bed(A.m)))mat=M.mortar;
   if((A.m===M.glass)!==(B.m===M.glass))mat=M.glassJoint;
   s.bonds.push({node0:i,node1:j,centroid:v(contact.centroid),normal:v(normal),area:round(contact.area),m:mat});
  }
  return {version:2,key:this.key,title:this.key.replaceAll('-',' '),defaults:{solver:{gravity:-9.81,materials:this.table}},scenario:s};
 }
}

/** TOWN_KIT_BURIED_ANCHORS=1: fixed pieces above grade become members on buried anchors (Builder.buryAnchor). */
export const buriedAnchorsEnabled=()=>(globalThis.process?.env?.TOWN_KIT_BURIED_ANCHORS??'0')==='1';
/**
 * How far a fixed chunk's top may stand above grade (m): 3 cm, the road
 * surfacing's 25 mm over its subgrade plus a millimetre's rounding. Anything
 * a vehicle, a ball or a meteor can strike above that must be able to break.
 */
export const ANCHOR_TOLERANCE=0.03;
/**
 * Fixed (mass-0) chunks whose top stands above grade (world y = 0) by more
 * than ANCHOR_TOLERANCE: kinematic and unbreakable where something can hit
 * them. [{node, group, type, material, top}].
 */
export function lintAnchors(pack,{grade=0,tolerance=ANCHOR_TOLERANCE}={}) {
 const s=pack.scenario,out=[];
 for(let i=0;i<s.nodes.length;i++){
  if(s.nodes[i].mass>0)continue;
  const top=s.nodes[i].centroid.y+s.nodeSizes[i].y/2;
  if(top>grade+tolerance)out.push({node:i,group:s.nodeGroups[i],type:s.nodeTypes[i],material:s.nodeMaterials[i],top:round(top)});
 }
 return out;
}
/**
 * Buried anchors for packs built elsewhere (the skyline assets' column bases,
 * a tower's 0.6 m plinths): every fixed cuboid standing proud of grade
 * becomes a member as Builder.buryAnchor makes one -- through grade it splits
 * there (its bonds go to the half their centroid is in), wholly above it gets
 * a 0.1 m anchor under its footprint -- with its mass from its material's
 * density; anchor-grade material (`footing`) becomes C30 concrete. Hulls and
 * floating chunks stay, for the lint. In place; returns how many changed.
 */
export function buryPackAnchors(pack) {
 const s=pack.scenario,table=pack.defaults.solver.materials;let changed=0;
 let concrete=table.findIndex(m=>m.name==='concrete-footing');
 const concreteIndex=()=>{if(concrete<0){table.push(concreteFooting());concrete=table.length-1;}return concrete;};
 let piece=s.nodePieces.reduce((m,p)=>Math.max(m,p),-1)+1;
 const n0=s.nodes.length;
 for(let i=0;i<n0;i++){
  const n=s.nodes[i];if(n.mass>0)continue;
  let c=s.nodeColliders[i];if(c.kind==='shape')continue;if(c.kind!=='cuboid')continue;
  const size=a(s.nodeSizes[i]),centre=a(n.centroid),bottom=centre[1]-size[1]/2,top=centre[1]+size[1]/2;
  if(top<=ANCHOR_TOLERANCE||bottom>ANCHOR_TOLERANCE)continue;
  const m=/footing|anchor/.test(table[n.m??0].name)?concreteIndex():(n.m??0);
  const anchorBottom=bottom<0?bottom:bottom-0.1,anchorTop=bottom<0?0:bottom;
  const memberBottom=Math.max(bottom,0);
  // The member: what stands above grade, with mass.
  const mh=[size[0],top-memberBottom,size[2]],mc=[centre[0],(top+memberBottom)/2,centre[2]],vol=mh[0]*mh[1]*mh[2];
  // Skyline materials carry no density: theirs is concrete's (2400 kg/m^3).
  s.nodes[i]={...n,centroid:v(mc),mass:round(vol*(table[m].density??2400)),volume:round(vol),m};
  s.nodeSizes[i]=v(mh);s.nodeColliders[i]={kind:'cuboid',halfExtents:v(mh.map(x=>x/2))};s.nodeMaterials[i]=table[m].name;
  // The anchor, below.
  const ah=[size[0],anchorTop-anchorBottom,size[2]],ac=[centre[0],(anchorTop+anchorBottom)/2,centre[2]];
  const j=s.nodes.length;
  s.nodes.push({centroid:v(ac),mass:0,volume:round(ah[0]*ah[1]*ah[2]),m:n.m??0});s.nodeSizes.push(v(ah));s.nodeColliders.push({kind:'cuboid',halfExtents:v(ah.map(x=>x/2))});
  s.nodeTypes.push(`${s.nodeTypes[i]}-anchor`);s.nodeGroups.push(s.nodeGroups[i]);s.nodePieces.push(piece++);s.nodeMaterials.push(table[n.m??0].name);
  // Its bonds below grade now hold the anchor.
  for(const b of s.bonds)if((b.node0===i||b.node1===i)&&b.centroid.y<anchorTop-1e-6){if(b.node0===i)b.node0=j;else b.node1=j;}
  s.bonds.push({node0:j,node1:i,centroid:v([centre[0],anchorTop,centre[2]]),normal:v([0,1,0]),area:round(size[0]*size[2]),m});
  changed++;
 }
 return changed;
}
/** The lint on a composed scene: a summary line; with buried anchors on, a violation is an error. */
export function checkAnchors(pack) {
 const bad=lintAnchors(pack);if(!bad.length)return bad;
 const groups=[...new Set(bad.map(b=>`${b.group.split('@')[0]}:${b.type}`))];
 const text=`${pack.key}: ${bad.length} fixed chunk(s) above grade (> ${ANCHOR_TOLERANCE} m): ${groups.slice(0,12).join(', ')}${groups.length>12?' ...':''} (highest ${Math.max(...bad.map(b=>b.top))} m)`;
 if(buriedAnchorsEnabled()&&(globalThis.process?.env?.TOWN_KIT_ANCHOR_LINT??'error')==='error')throw Error(`${text}; TOWN_KIT_ANCHOR_LINT=warn to build anyway`);
 console.warn(`[anchor lint] ${text}`);
 return bad;
}

/** No implicit bonds between placed assets: loose furniture stays loose. */
export function composeScene(placements,{key='town-kit-scene',title=key,skipAnchorLint=false}={}) {
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
 // Chunk crushing, opt-in (VIBE_CRUSH=1): each material that crushes by what it is (materials.mjs crushFor).
 if(crushEnabled())for(const m of table)if(!m.crush){const c=crushFor(m.name);if(c)m.crush=structuredClone(c);}
 const pack={version:2,key,title,defaults:{solver:{gravity:-9.81,materials:table}},scenario:s};
 if(!skipAnchorLint&&buriedAnchorsEnabled())buryPackAnchors(pack);
 if(crushEnabled())for(const m of table)if(!m.crush){const c=crushFor(m.name);if(c)m.crush=structuredClone(c);}
 if(!skipAnchorLint)checkAnchors(pack);
 return pack;
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
 return composeScene([{pack}],{key:pack.key,title:pack.title,skipAnchorLint:true});
}
