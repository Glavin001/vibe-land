import {createEnvelope} from './envelope.mjs';
import {M} from '../materials.mjs';

/** Experimental timber frame. Cosmetic panels have vertical clearance so they
 * cannot provide the bearing surface beneath a beam or structural deck.
 * Posts and headers occupy the wall thickness; openings keep their clear size.
 */
export function createFramedEnvelope(b,{floorBounds}) {
 const plain=createEnvelope(b,{floorBounds}),B=plain.B;
 function wall(axis,at,u0,u1,y0,y1,openings=[],material=M.wall,role='wall') {
  // Siding courses and nonstructural partitions retain the ordinary authoring.
  if(!['wall','interior-wall','stair-wall'].includes(role))return plain.wall(axis,at,u0,u1,y0,y1,openings,material,role);
  const postWidth=Math.min(.18,at[1]-at[0]),beamDepth=.24;
  const posts=[[u0,u0+postWidth],[u1-postWidth,u1],...openings.flatMap(o=>[[o[0]-postWidth,o[0]],[o[1],o[1]+postWidth]])];
  for(let x=u0+2.4;x<u1-postWidth;x+=2.4)if(!openings.some(o=>x<o[1]+postWidth&&x+postWidth>o[0]-postWidth))posts.push([x,x+postWidth]);
  const clipped=posts.map(([a,c])=>[Math.max(a,u0),Math.min(c,u1)]).filter(([a,c])=>c-a>1e-5).sort((a,c)=>a[0]-c[0]);
  const merged=[];for(const p of clipped){const last=merged.at(-1);if(last&&p[0]<=last[1]+1e-5)last[1]=Math.max(last[1],p[1]);else merged.push([...p]);}
  const headers=openings.map(o=>[o[0],o[1],o[3],Math.min(y1-beamDepth,o[3]+.18)]).filter(h=>h[3]-h[2]>1e-5);
  const us=[...new Set([u0,u1,...openings.flatMap(o=>o.slice(0,2)),...merged.flat()])].sort((a,c)=>a-c);
  const box=(a,c,lo,hi,type,key,mat=M.frame)=>{
   const min=axis==='z'?[a,lo,at[0]]:[at[0],lo,a],max=axis==='z'?[c,hi,at[1]]:[at[1],hi,c];
   const split=[1,Math.max(1,Math.ceil((hi-lo)/1.5)),1];split[axis==='z'?0:2]=Math.max(1,Math.ceil((c-a)/(mat===M.frame?2.4:1.2)));
   b.box({min,max,material:mat,type,split,pieceId:key});
  };
  for(const [a,c]of merged)box(a,c,y0,y1-beamDepth,'frame-post',b.pieceId++);
  box(u0,u1,y1-beamDepth,y1,'frame-beam',b.pieceId++);
  for(const h of headers)box(h[0],h[1],h[2],h[3],'frame-beam',b.pieceId++);
  for(let i=0;i<us.length-1;i++){
   const a=us[i],c=us[i+1],u=(a+c)/2;if(merged.some(p=>u>p[0]&&u<p[1]))continue;
   const holes=openings.filter(o=>u>o[0]&&u<o[1]),localHeaders=headers.filter(h=>u>h[0]&&u<h[1]);
   const ys=[...new Set([y0,y1-beamDepth,...holes.flatMap(o=>o.slice(2,4)),...localHeaders.flatMap(h=>h.slice(2,4))])].filter(y=>y>=y0&&y<=y1-beamDepth).sort((a,c)=>a-c);
   for(let j=0;j<ys.length-1;j++){
    const lo=ys[j],hi=ys[j+1],y=(lo+hi)/2;
    if(holes.some(o=>y>o[2]&&y<o[3])||localHeaders.some(h=>y>h[2]&&y<h[3]))continue;
    if(hi-lo>.012)box(a,c,lo+.006,hi-.006,'wall-infill',b.pieceId++,material);
   }
  }
 }
 function facade(axis,at,u0,u1,y0,y1,openings){
  wall(axis,at,u0,u1,y0,y1,openings);
  const outward=at[0]<0?-1:1,face=outward<0?at[0]:at[1],skin=outward<0?[face-.03,face]:[face,face+.03];
  for(let y=y0;y<y1-.001;y+=.19){
   const top=Math.min(y+.176,y1),ys=[...new Set([y,top,...openings.flatMap(o=>o.slice(2,4)).filter(v=>v>y&&v<top)])].sort((a,c)=>a-c);
   for(let j=0;j<ys.length-1;j++){
    const lo=ys[j],hi=ys[j+1],mid=(lo+hi)/2;let spans=[[u0,u1]];
    for(const o of openings)if(mid>o[2]&&mid<o[3])spans=spans.flatMap(([a,c])=>o[1]<=a||o[0]>=c?[[a,c]]:[[a,Math.max(a,o[0])],[Math.min(c,o[1]),c]].filter(([a,c])=>c-a>1e-6));
    for(const [a,c]of spans){const min=axis==='z'?[a,lo,skin[0]]:[skin[0],lo,a],max=axis==='z'?[c,hi,skin[1]]:[skin[1],hi,c],split=axis==='z'?[Math.ceil((c-a)/2.4),1,1]:[1,1,Math.ceil((c-a)/2.4)];B(min,max,M.siding,'siding',split);}
   }
  }
  for(const o of openings)if(o[2]>y0+.1&&o[4]!==false)plain.window(axis,outward<0?face:face-.12,...o);
 }
 function slab(y,opening=null){
  const xs=[floorBounds[0],floorBounds[1],...(opening?[opening.x0,opening.x1]:[])].sort((a,c)=>a-c),zs=[floorBounds[2],floorBounds[3],...(opening?[opening.z0,opening.z1]:[])].sort((a,c)=>a-c);
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<zs.length-1;j++){
   if(opening&&xs[i]>=opening.x0&&xs[i+1]<=opening.x1&&zs[j]>=opening.z0&&zs[j+1]<=opening.z1)continue;
   B([xs[i],y-.18,zs[j]],[xs[i+1],y,zs[j+1]],M.oak,'floor',[Math.ceil((xs[i+1]-xs[i])/1.5),1,Math.ceil((zs[j+1]-zs[j])/1.5)]);
  }
 }
 return {...plain,wall,facade,slab};
}

/** Keep panel attachments weak without weakening the actual frame joints. */
export function frameBondPolicy(pack){
 const s=pack.scenario;
 // Match the reference houses' timber-to-timber structural bonds. Apply only
 // to the skeleton, never to wall panels, siding, glazing or furniture.
 const frame=new Set(['frame-post','frame-beam','floor','ceiling','roof-rafter','roof-ridge','roof-post','stair']);
 for(const bond of s.bonds){
  const a=s.nodeTypes[bond.node0],c=s.nodeTypes[bond.node1];
  if(frame.has(a)&&frame.has(c))bond.m=M.frame;
  if(a.endsWith('-infill')!==c.endsWith('-infill'))bond.m=M.fastener;
 }
 return pack;
}
