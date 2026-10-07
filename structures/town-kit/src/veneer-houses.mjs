/**
 * Brick-veneer timber-frame houses, built the way such houses are built, so
 * that how they break follows from how they stand.
 *
 * The load is carried by a structural timber frame (EN 338 C24): a concrete
 * slab on grade, 90 x 45 bottom plates bolted to it, 90 x 45 studs at 600 mm
 * with king and jack studs, built-up headers, sill trimmers and cripples at
 * every opening, a doubled 90 x 90 top plate, 140 x 45 ceiling joists that tie
 * the rafter feet, 190 x 45 rafters on birdsmouth seats, and a 240 x 45 ridge
 * board. Members meet at nailed or bolted joints rated by their fasteners
 * (materials.mjs CONNECTIONS). A stud, a joist or a rafter is two chunks, a
 * plate one per 2.4 m: a member breaks into two or three pieces, not a mesh.
 *
 * The brick is a skin: a 90 mm single-wythe veneer bedded on the slab, its
 * panels (one tie cell, 600 x 405 mm, running bond) joined by mortar
 * (MORTAR_JOINT, EN 1996-1-1 values), standing 50 mm clear of the frame and
 * held to it only by steel wall ties, one per panel at a stud (materials.mjs
 * WALL_TIE: ~0.9 kN). Over an opening the course is carried by a steel angle
 * lintel bearing 150 mm on the brick either side, as one piece. Inside, 13 mm
 * gypsum board screwed to the studs, plates and joists. Neither carries load:
 * knock them off and the frame stands; take out a wall's studs and the roof
 * comes down while the skin and the board just break away.
 *
 * x runs along the house (10 m), z front (-) to back (+), y up. The slab top
 * is y 0.15; the veneer's outer faces are x +-5.0 and z +-3.9.
 */
import {Builder,composeScene,round,v} from './geometry.mjs';
import {M,MORTAR_JOINT,C24,GYPSUM,ROOF_TILE_LAYER,WEATHERBOARD,CONNECTIONS,WALL_TIE,LONG_TERM,BEARING,CRUSH,crushEnabled} from './materials.mjs';
import {cornerReferencedHulls} from './parts/hull-origins.mjs';

/** Sizes, metres. Sawn sizes are the AS 1684 / EN 336 metric ones. */
export const SIZES={
 veneer:.09,cavity:.05,           // 90 mm brick, 50 mm cavity (NHBC 6.2: >= 50 mm with timber frame)
 stud:.045,wall:.09,spacing:.6,   // 90 x 45 studs at 600 mm centres
 plate:.045,topPlate:.09,         // single bottom plate, doubled top plate
 studLength:2.4,                  // 2.4 m studs: a 2.4 m ceiling
 header:.19,                      // 2 / 190 x 45 on edge over openings
 solidHeader:.45,                 // ...built up to the plate (blocking over the lintel) when the gap is under this
 joist:.14,floorJoist:.24,rafter:.19,ridge:.24,
 pitch:22.5,eave:.45,verge:.3,
 drywall:.013,lining:.003,        // 13 mm board, 3 mm joints
 tile:.05,gable:.14,
 course:.405,                     // veneer panel height: one tie row (<= 450 mm)
 panel:.6,                        // veneer panel length: one tie column (stud spacing)
 bearing:.15,                     // lintel bearing each side (AS 3700, BS 5977)
 slab:.15,
 subfloor:.022,
};
const S=SIZES,W=S.stud,D=S.wall,EPS=1e-6;
const range=(a,b)=>Array.from({length:b-a},(_,i)=>a+i);

/** Every timber connection kind, and what each node type is. */
const STUDS=new Set(['stud','king-stud','jack-stud','cripple-stud','junction-stud']);
const HORIZONTAL=new Set(['bottom-plate','top-plate','header','sill-trimmer','rim-joist']);
const TIMBER=new Set([...STUDS,...HORIZONTAL,'ceiling-joist','floor-joist','rafter','ridge-board']);
export const STRUCTURAL_TYPES=['foundation',...STUDS,...HORIZONTAL,'ceiling-joist','floor-joist','subfloor','rafter','ridge-board','gable-frame'];
export const SKIN_TYPES=['brick-veneer','veneer-lintel-course','drywall','ceiling-lining'];
export const COSMETIC_TYPES=[...SKIN_TYPES,'gable-cladding','roof-covering','window-frame','door-frame','glazing'];

function materialsFor(b,crush=false){
 const t=b.table,add=m=>t.push(m)-1,base=t[M.frame];
 const timber=add({...structuredClone(base),name:'stud-timber',color:'#b48a5c',textureKey:'aged-timber',...C24});
 const veneer=add({...structuredClone(t[M.brick]),name:'brick-veneer',color:'#9a5a46',textureKey:'brick',...(crush&&{crush:CRUSH.brickVeneer})});
 const mortar=add({...structuredClone(t[M.brick]),name:'veneer-mortar-joint',...MORTAR_JOINT});
 const drywall=add({...structuredClone(t[M.plaster]),name:'drywall',color:'#ece6d8',textureKey:'white-concrete',...GYPSUM,...(crush&&{crush:CRUSH.gypsum})});
 const tile=add({...structuredClone(t[M.roof]),name:'concrete-roof-tile',color:'#7b4a3c',textureKey:'roof-slate',...ROOF_TILE_LAYER});
 const gable=add({...structuredClone(base),name:'gable-weatherboard',color:'#e4dccb',textureKey:'white-concrete',density:WEATHERBOARD.density*.025/S.gable});
 // Gable-end framing as one panel: 90 x 45 studs at 600 (7.5% of the panel) and noggings.
 const gableFrame=add({...structuredClone(base),name:'gable-frame',color:'#b48a5c',textureKey:'aged-timber',...C24,density:C24.density*(S.stud/S.spacing+.01)});
 const flooring=add({...structuredClone(base),name:'particleboard-flooring',color:'#c4a77d',textureKey:'aged-timber',...C24,density:680,elasticModulus:3e9});
 const tie=add({...structuredClone(base),name:'wall-tie',color:'#9aa3a6',textureKey:'metal',density:7850,residualAreaFraction:0,
  compressionElastic:LONG_TERM*WALL_TIE.compression/WALL_TIE.area,compressionFatal:WALL_TIE.compression/WALL_TIE.area,
  tensionElastic:LONG_TERM*WALL_TIE.tension/WALL_TIE.area,tensionFatal:WALL_TIE.tension/WALL_TIE.area,
  shearElastic:LONG_TERM*WALL_TIE.shear/WALL_TIE.area,shearFatal:WALL_TIE.shear/WALL_TIE.area,
  elasticModulus:WALL_TIE.stiffness*WALL_TIE.length/WALL_TIE.area});
 return {timber,veneer,mortar,drywall,tile,gable,gableFrame,flooring,tie};
}

/**
 * A connection material from CONNECTIONS. Per-joint capacities (N) become
 * stresses over the joint's measured contact area -- the median area of the
 * bonds of that kind, which are all one geometry -- per-area ones are already
 * stresses. Stiffness: the solver's bond stiffness is E A / L (L the chunk
 * centroid distance), so the modulus that makes it the connection's own
 * stiffness k is k L / A, with the kind's median L and A: k from fastener slip
 * (SLIP), or from cross-grain bearing E90 A / t where the joint bears.
 */
function jointMaterial(b,kind,area,length){
 const c=CONNECTIONS[kind],k=c.per==='joint'?1/area:1/(c.perArea??1);
 const f={compression:c.compression,tension:c.tension*k,shear:c.shear*k};
 const perArea=c.bearing?BEARING.elasticModulus/c.bearing:c.per==='joint'?c.slip/area:c.slip/(c.perArea??1);
 const elastic=perArea*length;
 return b.table.push({...structuredClone(b.table[M.frame]),name:`${kind}-joint`,color:'#986d43',textureKey:null,residualAreaFraction:0,elasticModulus:elastic,
  compressionElastic:LONG_TERM*f.compression,compressionFatal:f.compression,tensionElastic:LONG_TERM*f.tension,tensionFatal:f.tension,
  shearElastic:LONG_TERM*f.shear,shearFatal:f.shear})-1;
}

/** The connection kind joining two node types (different pieces). */
function connection(ta,tb,wa,wb){
 // A non-bearing partition stops 25 mm under the ceiling; its top plate meets the wall's end on.
 if(ta==='top-plate'&&tb==='top-plate'&&(/partition/.test(wa)||/partition/.test(wb)))return null;
 // An upper-floor partition stands on the floor and is not fixed to the walls it meets: on a
 // floor that deflects, a partition nailed to stiffer walls at its ends bridges the floor and
 // hangs it from them (its stud-to-plate end nails pulled 1.8x their long-term capacity).
 if(wa&&wb&&wa!==wb&&(/^partition.*-[1-9]$/.test(wa)||/^partition.*-[1-9]$/.test(wb)))return null;
 // Likewise the upper centre wall, on the floor over the lower one, meets the end walls (on the
 // stiffer rim) unfixed: the floor settles under it more than the rim does, and nailed to them
 // its junction laps took three times their long-term capacity on the first tick.
 if(wa&&wb&&wa!==wb&&(/^centre-[1-9]$/.test(wa)||/^centre-[1-9]$/.test(wb)))return null;
 // Bottom plates of walls that meet butt end on, each nailed down on its own, not to each other.
 if(ta==='bottom-plate'&&tb==='bottom-plate'&&wa!==wb)return null;
 const has=(x,y)=>(ta===x&&tb===y)||(ta===y&&tb===x),either=s=>s.has(ta)||s.has(tb),both=s=>s.has(ta)&&s.has(tb),one=t=>ta===t||tb===t;
 const masonry=new Set(['brick-veneer','veneer-lintel-course']);
 if(both(masonry)||(either(masonry)&&one('foundation')))return 'mortar';
 if(one('glazing'))return 'glazing';
 if(one('drywall')||one('ceiling-lining'))return 'drywall-screw';
 // A door jamb stands beside the cut end of the bottom plate; nothing fixes it there.
 if(one('door-frame')&&(one('bottom-plate')||one('foundation')))return null;
 if(one('window-frame')||one('door-frame'))return 'window-fixing';
 if(one('roof-covering'))return 'roof-batten';
 // Gable weatherboards are nailed to the gable studs and the verge rafter; they bear on nothing.
 if(one('gable-cladding'))return has('gable-cladding','rafter')||has('gable-cladding','gable-frame')?'weatherboard':null;
 // The ridge board only locates the rafters: it is not carried on the gable frame's tip.
 if(one('gable-frame'))return one('ridge-board')?null:'gable-stud';
 if(one('subfloor'))return 'flooring-nail';
 if(has('foundation','bottom-plate'))return 'anchor';
 if(either(STUDS)&&either(HORIZONTAL)&&!both(STUDS)&&!both(HORIZONTAL))return 'stud-plate';
 if(has('ceiling-joist','top-plate')||has('floor-joist','top-plate')||has('rim-joist','top-plate'))return 'joist-plate';
 if(has('rafter','top-plate'))return 'rafter-seat';
 if(has('rafter','ceiling-joist'))return 'heel';
 if(has('rafter','ridge-board'))return 'ridge';
 if(has('ceiling-joist','ceiling-joist'))return 'joist-splice';
 if(has('top-plate','top-plate'))return /-[1-9]$/.test(wa)||/-[1-9]$/.test(wb)?'plate-lap-plated':'plate-lap';
 if(both(STUDS))return 'stud-lap';
 if(both(TIMBER))return 'lap';
 throw Error(`No connection for ${ta} - ${tb}`);
}

export function buildVeneerHouse(options={}){
 const C={storeys:1,palette:'ochre',key:null,crush:crushEnabled(),...options};
 if(![1,2].includes(C.storeys))throw Error('storeys: 1 or 2');
 const key=C.key??(C.storeys===1?'veneer-bungalow':'veneer-house');
 const b=new Builder(key,{palette:C.palette,group:'building'}),MAT=materialsFor(b,C.crush);
 const members=[],wallOf=[],walls={},veneer=[],ties=[];
 const X=5-S.veneer-S.cavity,Z=3.9-S.veneer-S.cavity,Xi=X-D,Zi=Z-D;   // frame outer / inner faces
 const tag=(first,wall)=>{for(let i=first;i<b.s.nodes.length;i++)wallOf[i]=wall;return range(first,b.s.nodes.length);};
 const member=(type,min,max,{material=MAT.timber,split=[1,1,1],wall=null,face=null,pieceId,fixed=false}={})=>{
  const first=b.s.nodes.length,id=b.box({min,max,material,type,split,fixed,...(pieceId!=null&&{pieceId})});
  const m={type,wall,face,min,max,pieceId:id,nodes:tag(first,wall)};members.push(m);return m;
 };
 const prism=(type,axis,lo,hi,poly,{material=MAT.timber,wall=null,pieceId}={})=>{
  const first=b.s.nodes.length,id=b.piece({axis,lo,hi,poly,material,type,...(pieceId!=null&&{pieceId})});
  const m={type,wall,pieceId:id,nodes:tag(first,wall)};members.push(m);return m;
 };
 const nodeBounds=n=>b.bounds[n];

 // ---- slab on grade: the only anchor (fixed, below the house) ----
 member('foundation',[-5,-.3,-3.9],[5,S.slab,3.9],{material:M.footing,split:[4,1,3],fixed:true});

 /** A wall's box from wall coordinates (u along it, y up, p through it). */
 const wallBox=(w,ua,ub,ya,yb,pa=w.at[0],pb=w.at[1])=>w.axis==='x'?[[ua,ya,pa],[ub,yb,pb]]:[[pa,ya,ua],[pb,yb,ub]];
 const split=(w,len,h,along=2.4)=>{const s=[1,h>1.5?2:1,1];s[w.axis==='x'?0:2]=Math.max(1,Math.ceil(len/along-1e-9));return s;};

 /** A stud wall: plates, studs at 600 mm, king/jack studs, headers, trimmers, cripples. */
 function frameWall(w){
  walls[w.name]=w;w.members=[];
  const yBP=w.y0+S.plate,yTP=w.top-S.topPlate,add=(type,ua,ub,ya,yb,opt={})=>{if(ub-ua<EPS||yb-ya<EPS)return;const [mn,mx]=wallBox(w,ua,ub,ya,yb);const m=member(type,mn,mx,{wall:w.name,face:w.face,split:split(w,ub-ua,yb-ya,opt.along),...opt});m.u=[ua,ub];m.y=[ya,yb];w.members.push(m);return m;};
  // Bottom plate, cut at doors.
  let cuts=[[w.u0,w.u1]];for(const o of w.openings.filter(o=>o.kind==='door'))cuts=cuts.flatMap(([a,c])=>o.u1<=a||o.u0>=c?[[a,c]]:[[a,o.u0],[o.u1,c]].filter(([p,q])=>q-p>EPS));
  // A lintel under 0.45 m of the top plate is built up solid to it: cripples that short
  // would be 0.4 kg chunks between 9 kg plates and lintels (lint: mass contrast).
  function headerDepth(o){return yTP-o.y1<=S.solidHeader?yTP-o.y1:Math.min(S.header,yTP-o.y1);}
  const busy=[...w.openings.map(o=>[o.u0-2*W,o.u1+2*W]),...(w.junctions??[]).map(j=>[j.u-j.width/2,j.u+j.width/2])];
  const grid=[];for(let u=w.u0;u<w.u1-2*W-EPS;u+=S.spacing)grid.push(u);grid.push(w.u1-W);
  for(const u of grid){
   if(!busy.some(([a,c])=>u+W>a+EPS&&u<c-EPS)){add('stud',u,u+W,yBP,yTP);continue;}
   for(const o of w.openings)if(u>=o.u0-EPS&&u+W<=o.u1+EPS){
    const head=o.y1+headerDepth(o);if(yTP-head>.03)add('cripple-stud',u,u+W,head,yTP);
    if(o.kind==='window'&&o.y0-W-yBP>.03)add('cripple-stud',u,u+W,yBP,o.y0-W);
   }
  }
  for(const j of w.junctions??[])add('junction-stud',j.u-j.width/2,j.u+j.width/2,yBP,yTP);
  for(const o of w.openings){
   const head=headerDepth(o);
   add('king-stud',o.u0-2*W,o.u0-W,yBP,yTP);add('king-stud',o.u1+W,o.u1+2*W,yBP,yTP);
   add('jack-stud',o.u0-W,o.u0,yBP,o.y1);add('jack-stud',o.u1,o.u1+W,yBP,o.y1);
   add('header',o.u0-W,o.u1+W,o.y1,o.y1+head,{along:1.6});
   if(o.kind==='window')add('sill-trimmer',o.u0,o.u1,o.y0-W,o.y0,{along:1.6});
   fitOpening(w,o);
  }
  // Plates: one member, a seam mid-bay every 2.4 m (where a plate is spliced), so no stud or joist straddles one.
  const upright=w.members.filter(m=>STUDS.has(m.type)).map(m=>m.u),free=u=>{while(upright.some(([p,q])=>u>p-.01&&u<q+.01))u+=.05;return u;};
  // No length under 1.2 m: a short plate is a sub-kilogram chunk under four studs and two anchors.
  const plate=(type,a,c,ya,yb)=>{const pieceId=b.pieceId++,seams=[a];for(let u=w.u0+S.spacing/2+2.4;u<c-1.2;u+=2.4){const f=free(u);if(f>seams.at(-1)+1.2&&f<c-1.2)seams.push(f);}seams.push(c);
   for(let i=0;i<seams.length-1;i++)add(type,seams[i],seams[i+1],ya,yb,{pieceId,along:99});};
  for(const [a,c] of cuts)plate('bottom-plate',a,c,w.y0,yBP);
  plate('top-plate',w.u0,w.u1,yTP,w.top);
 }

 /** Window or door frame in the rough opening; a window has one pane on its sill. */
 function fitOpening(w,o){
  // A frame is packed and screwed at its sides and stands on its sill (or the slab), with a
  // 10 mm gap under the header: the rough opening is that much taller, so a header that
  // deflects never loads the frame or its glass.
  const F=.045,top=o.y1-.01,pid=b.pieceId++,type=o.kind==='window'?'window-frame':'door-frame',at=(ua,ub,ya,yb)=>wallBox(w,ua,ub,ya,yb);
  const part=(ua,ub,ya,yb)=>{const [mn,mx]=at(ua,ub,ya,yb);member(type,mn,mx,{material:M.trim,pieceId:pid,wall:w.name});};
  part(o.u0,o.u1,top-F,top);
  if(o.kind==='window'){part(o.u0,o.u1,o.y0,o.y0+F);part(o.u0,o.u0+F,o.y0+F,top-F);part(o.u1-F,o.u1,o.y0+F,top-F);
   const mid=(w.at[0]+w.at[1])/2,[mn,mx]=wallBox(w,o.u0+F,o.u1-F,o.y0+F,top-F-.006,mid-.003,mid+.003);member('glazing',mn,mx,{material:M.glass,wall:w.name});}
  else{part(o.u0,o.u0+F,o.y0,top-F);part(o.u1-F,o.u1,o.y0,top-F);}
 }

 /** The veneer on one face: courses of tie-cell panels in running bond, lintel courses over openings. */
 function veneerFace(f){
  const rows=Math.round((f.top-f.bottom)/S.course);
  for(const o of f.openings)for(const y of [o.y0,o.y1])if(Math.abs(((y-S.slab)/S.course)-Math.round((y-S.slab)/S.course))>1e-6)throw Error(`${f.wall}: opening edge ${y} off the course grid`);
  for(let r=0;r<rows;r++){
   const ya=f.bottom+r*S.course,yb=ya+S.course;
   let spans=[[f.u0,f.u1]];
   for(const o of f.openings)if(o.y0<yb-EPS&&o.y1>ya+EPS)spans=spans.flatMap(([a,c])=>o.u1<=a||o.u0>=c?[[a,c]]:[[a,o.u0],[o.u1,c]].filter(([p,q])=>q-p>EPS));
   const lintels=f.openings.filter(o=>Math.abs(o.y1-ya)<EPS).map(o=>[o.u0-S.bearing,o.u1+S.bearing]);
   for(const [a,c] of spans){
    let cuts=[a,c];for(let u=f.u0+(r%2?S.panel/2:0);u<c;u+=S.panel)if(u>a+EPS)cuts.push(u);
    cuts=cuts.filter(u=>!lintels.some(([p,q])=>u>p+EPS&&u<q-EPS));for(const [p,q] of lintels)if(p>a+EPS&&p<c-EPS)cuts.push(p),cuts.push(q);
    cuts=[...new Set(cuts.map(round))].sort((x,y)=>x-y);
    // No sliver panels: one narrower than 0.2 m joins its neighbour (unless that is a lintel course).
    let pieces=cuts.slice(0,-1).map((u,i)=>[u,cuts[i+1]]);
    const isLintel=([p,q])=>lintels.some(([s,t])=>p>=s-EPS&&q<=t+EPS);
    for(let i=0;i<pieces.length;i++)if(pieces[i][1]-pieces[i][0]<.2-EPS&&pieces.length>1&&!isLintel(pieces[i])){
     const j=i>0&&!isLintel(pieces[i-1])?i-1:i+1;if(j>=pieces.length||isLintel(pieces[j]))continue;
     pieces[j]=[Math.min(pieces[i][0],pieces[j][0]),Math.max(pieces[i][1],pieces[j][1])];pieces.splice(i,1);i=-1;
    }
    for(const [p,q] of pieces){
     const [mn,mx]=f.axis==='x'?[[p,ya,f.at[0]],[q,yb,f.at[1]]]:[[f.at[0],ya,p],[f.at[1],yb,q]];
     const m=member(isLintel([p,q])?'veneer-lintel-course':'brick-veneer',mn,mx,{material:MAT.veneer,wall:f.wall});
     veneer.push({node:m.nodes[0],u:[p,q],y:[ya,yb],face:f});
    }
   }
  }
 }

 /** Ties: each veneer panel to the studs behind it at mid-panel height (in the floor zone, the rim joist). */
 function tieVeneer(){
  const centre=m=>(m.u[0]+m.u[1])/2;
  for(const p of veneer){
   const f=p.face,yc=(p.y[0]+p.y[1])/2,uc=(p.u[0]+p.u[1])/2,spans=m=>m.y[0]<yc&&m.y[1]>yc;
   // Ties go into studs, never a cripple under 0.5 m (a block of under a kilogram under a 145 kg lintel course).
   const studs=members.filter(m=>m.face===f.wall&&STUDS.has(m.type)&&m.y[1]-m.y[0]>=.5&&spans(m));
   const inside=m=>centre(m)>=p.u[0]-EPS&&(centre(m)<p.u[1]-EPS||p.u[1]>=f.u1-EPS&&centre(m)<=p.u[1]+EPS);
   let hit=studs.filter(inside).map(m=>[m,centre(m)]);
   if(!hit.length)hit=members.filter(m=>m.face===f.wall&&m.type==='rim-joist'&&spans(m)&&m.u[0]<=uc&&m.u[1]>=uc).map(m=>[m,uc]);
   if(!hit.length){const near=studs.map(m=>[Math.abs(centre(m)-uc),m]).sort((x,y)=>x[0]-y[0])[0];if(near&&near[0]<.45)hit=[[near[1],centre(near[1])]];}
   for(const [m,u] of hit){
    const n=m.nodes.find(i=>{const [lo,hi]=nodeBounds(i),k=f.axis==='x'?0:2;return lo[1]<=yc+EPS&&hi[1]>=yc-EPS&&lo[k]<=u+EPS&&hi[k]>=u-EPS;});
    const frameFace=f.out<0?-(f.axis==='x'?Z:X):(f.axis==='x'?Z:X),brickFace=f.out<0?f.at[1]:f.at[0],mid=(frameFace+brickFace)/2;
    const centroid=f.axis==='x'?[u,yc,mid]:[mid,yc,u],normal=[0,0,0];normal[f.axis==='x'?2:0]=-f.out;
    ties.push({node0:p.node,node1:n,centroid:v(centroid),normal:v(normal),area:WALL_TIE.area,m:MAT.tie});
   }
   p.ties=hit.length;
  }
 }

 /** Gypsum board on one face of a wall: full-height sheets, 1.2 m wide, around openings and junctions. */
 function lining(f){
  // Sheet joints fall on stud centrelines, as they are hung (f.origin: the wall's first stud centre).
  const T=f.thickness??S.drywall,g=S.lining/2,cuts=[f.u0,f.u1];for(let u=f.origin+1.2;u<f.u1-.1;u+=1.2)if(u>f.u0+.1)cuts.push(u);
  for(const h of f.holes)for(const u of [h.u0,h.u1])if(u>f.u0+EPS&&u<f.u1-EPS)cuts.push(u);
  const us=[...new Set(cuts.map(round))].sort((x,y)=>x-y);
  for(let i=0;i<us.length-1;i++){
   const a=us[i],c=us[i+1],mid=(a+c)/2;let ys=[[f.y0,f.y1]];
   for(const h of f.holes)if(mid>h.u0&&mid<h.u1)ys=ys.flatMap(([p,q])=>h.y1<=p||h.y0>=q?[[p,q]]:[[p,h.y0],[h.y1,q]].filter(([s,t])=>t-s>.05));
   if(c-a<.05+2*g)continue;
   for(const [p,q] of ys){
    const pa=f.side>0?f.plane:f.plane-T,pb=pa+T,[mn,mx]=f.axis==='x'?[[a+g,p,pa],[c-g,q,pb]]:[[pa,p,a+g],[pb,q,c-g]];
    member(f.type??'drywall',mn,mx,{material:f.material??MAT.drywall,wall:f.wall??null});
   }
  }
 }

 // ---- the storeys ----
 const storeys=[],T=S.drywall;
 let floor=S.slab;
 for(let s=0;s<C.storeys;s++){
  const top=floor+S.plate+S.studLength+S.topPlate,course=y=>S.slab+Math.round((y-S.slab)/S.course)*S.course;
  // Openings sit on the veneer's course grid (sill 0.81 m, head 2.03 m above the floor; doors 2.03 m).
  const sill=course(floor+.81),head=course(floor+2.03),win=(u0,u1)=>({u0,u1,y0:sill,y1:head,kind:'window'}),door=(u0,u1)=>({u0,u1,y0:floor,y1:head,kind:'door'});
  if(s===0&&Math.abs(head-2.175)>1e-6)throw Error('ground-floor head off grid');
  const ground=s===0,y0=floor;
  const tag=n=>`${n}${C.storeys>1?`-${s}`:''}`;
  const front=ground?[win(-4,-2.2),door(1.6,2.5),win(3.3,4.2)]:[win(-4,-2.2),win(-.6,.6),win(3,4.2)];
  const back=ground?[win(-3.8,-2.6),door(-.6,.3),win(2,3.8)]:[win(-3.8,-2.6),win(2,3.8)];
  const side=[win(-2.6,-1.4),win(1.4,2.6)];
  // Partitions on the slab only. Upstairs, on a floor that deflects, a partition is the stiffest
  // thing on it and the floor hangs from it (its studs pulled off their plate at 1.7x their
  // long-term capacity, 2026-10-06): the upper rooms are divided by the centre wall alone.
  const P1=-1.8,P2=1.2,jw=D,parts=ground,J=u=>parts?[{u,width:jw}]:[];
  const spec=[
   {name:tag('front'),face:'front',axis:'x',at:[-Z,-Zi],u0:-X,u1:X,y0,top,openings:front,junctions:J(P1),out:-1},
   {name:tag('back'),face:'back',axis:'x',at:[Zi,Z],u0:-X,u1:X,y0,top,openings:back,junctions:J(P2),out:1},
   {name:tag('left'),face:'left',axis:'z',at:[-X,-Xi],u0:-Zi,u1:Zi,y0,top,openings:side,junctions:[{u:0,width:jw}],out:-1},
   {name:tag('right'),face:'right',axis:'z',at:[Xi,X],u0:-Zi,u1:Zi,y0,top,openings:side.map(o=>({...o,u0:-o.u1,u1:-o.u0})),junctions:[{u:0,width:jw}],out:1},
   {name:tag('centre'),axis:'x',at:[-D/2,D/2],u0:-Xi,u1:Xi,y0,top,openings:[door(-3.4,-2.6),door(2.4,3.2)],junctions:[...J(P1),...J(P2)],bearing:true},
   ...(parts?[{name:tag('partition-front'),axis:'z',at:[P1-D/2,P1+D/2],u0:-Zi,u1:-D/2,y0,top:top-.025,openings:[door(-2.4,-1.6)]},
   {name:tag('partition-back'),axis:'z',at:[P2-D/2,P2+D/2],u0:D/2,u1:Zi,y0,top:top-.025,openings:[door(1.8,2.6)]}]:[]),
  ];
  for(const w of spec)frameWall(w);
  // Gypsum board: exterior walls' inner faces, both faces of the centre wall and partitions.
  const ly0=y0+S.plate+.003,ly1=top-.025,hole=(o)=>({u0:o.u0,u1:o.u1,y0:o.y0,y1:o.y1}),junction=(u,wd=jw)=>parts?[{u0:u-wd/2-S.lining,u1:u+wd/2+S.lining,y0:-1,y1:99}]:[];
  const inner=Zi-T-S.lining,innerX=Xi-T-S.lining;
  lining({axis:'x',plane:-Zi,side:1,u0:-Xi,u1:Xi,origin:-X+W/2,y0:ly0,y1:ly1,wall:spec[0].name,holes:[...front.map(hole),...junction(P1)]});
  lining({axis:'x',plane:Zi,side:-1,u0:-Xi,u1:Xi,origin:-X+W/2,y0:ly0,y1:ly1,wall:spec[1].name,holes:[...back.map(hole),...junction(P2)]});
  lining({axis:'z',plane:-Xi,side:1,u0:-inner,u1:inner,origin:-Zi+W/2,y0:ly0,y1:ly1,wall:spec[2].name,holes:[...spec[2].openings.map(hole),{u0:-jw/2-S.lining,u1:jw/2+S.lining,y0:-1,y1:99}]});
  lining({axis:'z',plane:Xi,side:-1,u0:-inner,u1:inner,origin:-Zi+W/2,y0:ly0,y1:ly1,wall:spec[3].name,holes:[...spec[3].openings.map(hole),{u0:-jw/2-S.lining,u1:jw/2+S.lining,y0:-1,y1:99}]});
  lining({axis:'x',plane:-D/2,side:-1,u0:-innerX,u1:innerX,origin:-Xi+W/2,y0:ly0,y1:ly1,wall:spec[4].name,holes:[...spec[4].openings.map(hole),...junction(P1)]});
  lining({axis:'x',plane:D/2,side:1,u0:-innerX,u1:innerX,origin:-Xi+W/2,y0:ly0,y1:ly1,wall:spec[4].name,holes:[...spec[4].openings.map(hole),...junction(P2)]});
  const pEnd=D/2+T+S.lining;
  if(parts)for(const [x,u0,u1,o] of [[P1,-inner,-pEnd,spec[5].openings],[P2,pEnd,inner,spec[6].openings]])for(const side of [-1,1])
   lining({axis:'z',plane:x+side*D/2,side,u0,u1,origin:(x<0?-Zi:D/2)+W/2,y0:ly0,y1:top-.025,wall:spec[x<0?5:6].name,holes:o.map(hole)});
  storeys.push({floor,top,spec});
  floor=top;
  if(s<C.storeys-1){
   // Platform floor: a doubled rim (2 / 240 x 45 plus the flooring's depth, IRC R502.3) on
   // the top plates, under the upper walls' plates so they bear straight down onto it; 240 x 45
   // joists at 600 framed into it and lapped over the centre wall; 22 mm particleboard inside it.
   const yJ=top+S.floorJoist,yF=yJ+S.subfloor,R=2*W;
   const rim=(min,max,split,face,u)=>{const m=member('rim-joist',min,max,{split,face,wall:`${face}-rim`});m.u=u;m.y=[top,yF];};
   rim([-X,top,-Z],[X,yF,-Z+R],[4,1,1],'front',[-X,X]);rim([-X,top,Z-R],[X,yF,Z],[4,1,1],'back',[-X,X]);
   rim([-X,top,-Z+R],[-X+R,yF,Z-R],[1,1,3],'left',[-Z+R,Z-R]);rim([X-R,top,-Z+R],[X,yF,Z-R],[1,1,3],'right',[-Z+R,Z-R]);
   for(const [k,x] of joistLines().entries())if(k>0&&k<16)for(const [za,zb] of [[-Z+R,0],[0,Z-R]])member('floor-joist',[x,top,za],[x+W,yJ,zb]);
   const fx=[-X+R,X-R],fz=[-Z+R,Z-R];
   // Sheets 2.4 x 1.2, jointed on the centre line (under the centre wall) and every 1.2 m out from it.
   const zc=[fz[0],-2.4,-1.2,0,1.2,2.4,fz[1]];
   for(let x=fx[0];x<fx[1]-EPS;x+=2.4)for(let k=0;k<zc.length-1;k++){const z=zc[k],zb=zc[k+1],xb=Math.min(x+2.4,fx[1]);if(xb-x<.2)continue;member('subfloor',[x+S.lining/2,yJ,z+S.lining/2],[xb-S.lining/2,yF,zb-S.lining/2],{material:MAT.flooring});}
   ceiling(top,'floor-joist');
   floor=yJ+S.subfloor;
  }
 }
 const yTop=storeys.at(-1).top;

 /** Joist and rafter lines: 17 at ~605 mm from gable to gable. */
 function joistLines(){const n=16,step=(2*X-W)/n;return range(0,n+1).map(k=>-X+k*step+(k<n?W:-W));}
 function rafterLines(){const n=16,step=(2*X-W)/n;return range(0,n+1).map(k=>-X+k*step);}
 /** Ceiling lining under the joists of a storey, each side of the centre wall. */
 function ceiling(y,joist){
  const g=S.lining,x0=-Xi+g,x1=Xi-g;
  // Sheet ends on joist centrelines (every fourth joist), as hung.
  const xs=[x0,...joistLines().filter((_,k)=>k%4===0&&k>0&&k<16).map(x=>x+W/2),x1];
  for(const [z0,z1] of [[-Zi+g,-D/2-g],[D/2+g,Zi-g]])for(let i=0;i<xs.length-1;i++)for(let z=z0;z<z1-EPS;z+=1.2){
   const x=xs[i],xb=xs[i+1],zb=Math.min(z+1.2,z1);if(xb-x<.1||zb-z<.1)continue;
   member('ceiling-lining',[x+g/2,y-T,z+g/2],[xb-g/2,y,zb-g/2],{material:MAT.drywall});
  }
 }

 // ---- roof: ceiling joists tie the rafter feet; rafters on birdsmouth seats; ridge board ----
 const pitch=S.pitch*Math.PI/180,t=Math.tan(pitch),dv=S.rafter/Math.cos(pitch);
 const yb=az=>yTop+t*(Zi-az),yt=az=>yb(az)+dv;   // rafter underside / top line at |z| = az (extended past the seat)
 const zr=W/2,zm=(Z+zr)/2;
 // (None at the gables: the gable-end frame stands on that plate.)
 for(const [k,x] of joistLines().entries())if(k>0&&k<16)for(const [za,zb] of [[-Z,0],[0,Z]])member('ceiling-joist',[x,yTop,za],[x+W,yTop+S.joist,zb]);
 ceiling(yTop,'ceiling-joist');
 const verge=new Set();
 for(const [k,x] of rafterLines().entries())for(const sgn of [-1,1]){
  const P=pts=>pts.map(([y,az])=>[y,sgn*az]),pid=b.pieceId++;
  // Seat-and-lower length, upper length: two convex pieces of one rafter. (No tails: the
  // eave's tiles are carried by the lower course strip, whose weight sits over the rafter;
  // a 1.7 kg tail under a 13 kg strip was where the stress solve stalled.)
  const parts=[prism('rafter','x',x,x+W,P([[yTop,Z],[yTop,Zi],[yb(zm),zm],[yt(zm),zm],[yt(Z),Z]]),{pieceId:pid}),
   prism('rafter','x',x,x+W,P([[yb(zm),zm],[yb(zr),zr],[yt(zr),zr],[yt(zm),zm]]),{pieceId:pid})];
  if(k===0||k===16)for(const m of parts)for(const n of m.nodes)verge.add(n);
 }
 // Ridge board: lengths butt-spliced mid-bay between rafters, about every 2.4 m. It only
 // locates the rafters; the rafter pairs and the ceiling-joist ties carry the roof.
 {const lines=rafterLines(),cuts=[-X,...[4,8,12].map(k=>(lines[k]+lines[k+1]+W)/2),X];
  for(let i=0;i<cuts.length-1;i++)member('ridge-board',[cuts[i],yb(zr)-(S.ridge-dv-.004),-zr],[cuts[i+1],yt(zr)-.004,zr]);}
 // Roof covering: tiles on battens, one strip per rafter (mid-bay to mid-bay, the verges
 // overhanging the end rafters) in two lengths matching the rafter's (lower, upper):
 // each piece's weight sits straight over the rafter piece it is battened to.
 const tv=S.tile/Math.cos(pitch),gap=S.lining,lines=rafterLines().map(x=>x+W/2);
 const edges=[-X-S.verge,...lines.slice(0,-1).map((x,k)=>(x+lines[k+1])/2),X+S.verge];
 for(let i=0;i<edges.length-1;i++)for(const sgn of [-1,1])for(const [a,c] of [[Z+S.eave,zm+gap/2],[zm-gap/2,gap/2]]){
  const P=pts=>pts.map(([y,az])=>[y,sgn*az]);
  prism('roof-covering','x',edges[i]+gap/2,edges[i+1]-gap/2,P([[yt(a),a],[yt(c),c],[yt(c)+tv,c],[yt(a)+tv,a]]),{material:MAT.tile});
 }
 // ---- the brick skin, every storey high, on the slab ----
 // The veneer stops a course below the roof covering's underside at its outer face.
 const veneerTop=S.slab+Math.floor((yt(3.9)-.03-S.slab)/S.course)*S.course;
 const faceOpenings=name=>storeys.flatMap((st,s)=>st.spec.find(w=>w.name===(C.storeys>1?`${name}-${s}`:name)).openings);
 const faces=[
  {wall:'front',axis:'x',at:[-3.9,-3.9+S.veneer],u0:-5,u1:5,out:-1},
  {wall:'back',axis:'x',at:[3.9-S.veneer,3.9],u0:-5,u1:5,out:1},
  {wall:'left',axis:'z',at:[-5,-5+S.veneer],u0:-3.9+S.veneer,u1:3.9-S.veneer,out:-1},
  {wall:'right',axis:'z',at:[5-S.veneer,5],u0:-3.9+S.veneer,u1:3.9-S.veneer,out:1},
 ];
 for(const f of faces)veneerFace({...f,openings:faceOpenings(f.wall),bottom:S.slab,top:veneerTop});
 tieVeneer();
 // Gables: a gable-end frame on each side wall's top plate (studs at 600 mm and noggings,
 // one panel per half: it carries the verge rafter), weatherboard on battens over the cavity
 // outside it, flush with the brick, under the verge.
 for(const sx of [-1,1])for(const sgn of [-1,1]){
  const lo=sx<0?-X:Xi,P=pts=>pts.map(([y,az])=>[y,sgn*az]);
  prism('gable-frame','x',lo,lo+D,P([[yTop,Zi],[yTop,zr],[yb(zr),zr]]),{material:MAT.gableFrame});
 }
 const gy0=Math.max(storeys.at(-1).top-S.topPlate+.001,veneerTop+.01);
 for(const sx of [-1,1])for(const sgn of [-1,1]){
  const lo=sx<0?-X-S.gable:X,hi=lo+S.gable,P=pts=>pts.map(([y,az])=>[y,sgn*az]);
  prism('gable-cladding','x',lo,hi,P([[gy0,Z],[gy0,0],[yt(0)-.004,0],[yt(Z)-.004,Z]]),{material:MAT.gable});
 }

 // ---- bonds: contacts as built, each a real connection; ties added ----
 let pack=b.build();
 const s=pack.scenario,kinds=new Map();
 for(const bond of s.bonds){
  const ta=s.nodeTypes[bond.node0],tb=s.nodeTypes[bond.node1];
  if(s.nodePieces[bond.node0]===s.nodePieces[bond.node1])continue;   // within one member: its own material
  let kind=connection(ta,tb,wallOf[bond.node0]??'',wallOf[bond.node1]??'');
  // The birdsmouth's plumb heel cut stands against the plate's outer face; the seat is what is nailed.
  if(kind==='rafter-seat'&&Math.abs(bond.normal.y)<.5)kind=null;
  // A verge rafter lies on its gable frame for its whole length; the ridge board stops against it.
  if(kind==='ridge'&&(verge.has(bond.node0)||verge.has(bond.node1)))kind=null;if(kind===null){bond.drop=true;continue;}bond.kind=kind;if(!kinds.has(kind))kinds.set(kind,[]);kinds.get(kind).push(bond);
 }
 const kindMaterial={mortar:MAT.mortar,glazing:M.glassJoint};
 for(const [kind,list] of kinds){
  if(!(kind in kindMaterial)){
   const median=v=>v.sort((x,y)=>x-y)[v.length>>1],c=i=>s.nodes[i].centroid;
   const area=median(list.map(x=>x.area)),length=median(list.map(x=>Math.hypot(c(x.node0).x-c(x.node1).x,c(x.node0).y-c(x.node1).y,c(x.node0).z-c(x.node1).z)));
   kindMaterial[kind]=kind==='flooring-nail'?jointMaterialFlooring(b,length):jointMaterial(b,kind,area,length);
  }
  for(const bond of list){bond.m=kindMaterial[kind];delete bond.kind;}
 }
 s.bonds=s.bonds.filter(x=>!x.drop);
 s.bonds.push(...ties);
 pack.defaults.solver.materials=b.table;
 pack=cornerReferencedHulls(composeScene([{pack}],{key,title:C.storeys===1?'Brick-veneer bungalow':'Brick-veneer two-storey house'}));
 const counts={};for(const ty of pack.scenario.nodeTypes)counts[ty]=(counts[ty]??0)+1;
 const metadata={
  kind:'building',buildingType:key,options:C,
  structure:{
   system:'brick-veneer timber frame',structuralTypes:STRUCTURAL_TYPES,cosmeticTypes:COSMETIC_TYPES,skinTypes:SKIN_TYPES,
   loadPath:['concrete slab on grade','bottom plates on M12 anchor bolts','studs at 600 mm, king/jack studs and headers at openings','doubled top plate',...(C.storeys>1?['rim and floor joists, particleboard floor','upper storey frame']:[]),'ceiling joists tying the rafter feet (bolted heels)','rafters on birdsmouth seats, ridge board','concrete tiles on battens'],
   skin:'90 mm brick veneer on the slab, 50 mm cavity, one wall tie per 600 x 405 mm panel; 13 mm gypsum board screwed to the frame',
   ties:ties.length,veneerTop,counts,
  },
  nodeWalls:wallOf.map(w=>w??null),
  frontFaceZ:-3.9,backFaceZ:3.9,
  cameras:{hero:{position:[-17,9,-19],target:[0,2.4,0]},front:{position:[0,4,-20],target:[0,2.4,0]}},
 };
 return {pack,metadata};
}

/** Particleboard flooring nailed to joists: like the gypsum, per area (AS 1860.2: nails at 150 mm on edges, 300 mm in the field). */
function jointMaterialFlooring(b,length){
 const area=.3*.045,f={compression:BEARING.compression,tension:NAIL_WITHDRAWAL()/area,shear:770/area};
 return b.table.push({...structuredClone(b.table[M.frame]),name:'flooring-nail-joint',color:'#986d43',textureKey:null,residualAreaFraction:0,elasticModulus:719e3/area*length,
  compressionElastic:LONG_TERM*f.compression,compressionFatal:f.compression,tensionElastic:LONG_TERM*f.tension,tensionFatal:f.tension,shearElastic:LONG_TERM*f.shear,shearFatal:f.shear})-1;
}
const NAIL_WITHDRAWAL=()=>347;

export const buildVeneerBungalow=(options={})=>buildVeneerHouse({...options,storeys:1});
export const buildVeneerTwoStorey=(options={})=>buildVeneerHouse({...options,storeys:2});

/** The pack without the nodes `drop(i)` selects (and their bonds): a variant of the same graph. */
export function withoutNodes(pack,drop){
 const p=structuredClone(pack),s=p.scenario,keep=[],map=new Map();
 for(let i=0;i<s.nodes.length;i++)if(!drop(i)){map.set(i,keep.length);keep.push(i);}
 for(const k of Object.keys(s))if(Array.isArray(s[k])&&s[k].length===pack.scenario.nodes.length&&k!=='bonds')s[k]=keep.map(i=>s[k][i]);
 s.bonds=s.bonds.filter(x=>map.has(x.node0)&&map.has(x.node1)).map(x=>({...x,node0:map.get(x.node0),node1:map.get(x.node1)}));
 return p;
}
/** The frame alone: brick veneer and gypsum board (walls and ceilings) removed. */
export const withoutSkin=pack=>withoutNodes(pack,i=>SKIN_TYPES.includes(pack.scenario.nodeTypes[i]));
/** A wall's load-bearing studs (studs, king, jack and cripple studs) removed; `wall` a name or a list (each storey's). */
export const withoutStuds=(pack,metadata,wall='front')=>{const walls=new Set([wall].flat());return withoutNodes(pack,i=>STUDS.has(pack.scenario.nodeTypes[i])&&pack.scenario.nodeTypes[i]!=='junction-stud'&&walls.has(metadata.nodeWalls[i]));};
