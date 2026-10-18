import {M} from '../materials.mjs';

/** Shared physical envelope parts. Openings are actual voids; all added pieces
 * are authored through the same builder and participate in its contact graph.
 * floorBounds is [minimum X, maximum X, minimum Z, maximum Z], in metres. */
export function createEnvelope(b,{floorBounds=[-6,6,-8,8]}={}) {
 const B=(min,max,material=M.frame,type='wall',split=[1,1,1])=>b.box({min,max,material,type,split});
 // Wall segments have actual voids. No hidden collision sheets cover openings.
 function wall(axis,at,u0,u1,y0,y1,openings=[],mat=M.wall,role='wall') {
  const us=[...new Set([u0,u1,...openings.flatMap(o=>[o[0],o[1]])])].sort((a,b)=>a-b);
  const vs=[...new Set([y0,y1,...openings.flatMap(o=>[o[2],o[3]])])].sort((a,b)=>a-b);
  for(let i=0;i<us.length-1;i++)for(let j=0;j<vs.length-1;j++) {
   const u=(us[i]+us[i+1])/2,y=(vs[j]+vs[j+1])/2;
   if(u<u0||u>u1||y<y0||y>y1||openings.some(o=>u>o[0]&&u<o[1]&&y>o[2]&&y<o[3]))continue;
   const min=axis==='z'?[us[i],vs[j],at[0]]:[at[0],vs[j],us[i]],max=axis==='z'?[us[i+1],vs[j+1],at[1]]:[at[1],vs[j+1],us[i+1]];
   const split=[1,Math.ceil((max[1]-min[1])/1.3),1];split[axis==='z'?0:2]=Math.ceil((us[i+1]-us[i])/1.2);
   B(min,max,mat,role,split);
  }
 }
 function window(axis,at,u0,u1,y0,y1) {
  // A sill-supported pane with a head gap cannot become the lintel's support.
  const box=(a,c,m,type='window-frame',split=[1,1,1])=>B(axis==='z'?[a[0],a[1],a[2]]:[a[2],a[1],a[0]],axis==='z'?[c[0],c[1],c[2]]:[c[2],c[1],c[0]],m,type,axis==='z'?split:[split[2],split[1],split[0]]);
  box([u0,y0,at],[u1,y0+.09,at+.12],M.trim,'sill');
  for(const u of [u0,u1-.07])box([u,y0+.09,at],[u+.07,y1,at+.12],M.trim);
  box([u0+.07,y1-.09,at],[u1-.07,y1,at+.12],M.trim,'window-head');
  const mid=(y0+y1)/2;
  box([u0+.07,mid-.025,at+.015],[u1-.07,mid+.025,at+.07],M.trim,'sash');
  for(const [a0,a1] of [[y0+.09,mid-.025],[mid+.025,y1-.10]]) {
   box([u0+.07,a0,at+.055],[u1-.07,a1,at+.061],M.glass,'glazing',[2,1,1]);
  }
 }
 function facade(axis,at,u0,u1,y0,y1,openings) {
  wall(axis,at,u0,u1,y0,y1,openings);
  const outward=at[0]<0?-1:1,face=outward<0?at[0]:at[1];
  const skin=outward<0?[face-.03,face]:[face,face+.03];
  // Individual lap courses supply silhouette and shadow at walking distance.
  for(let y=y0;y<y1-.001;y+=.19)wall(axis,skin,u0,u1,y,Math.min(y+.176,y1),openings,M.siding,'siding');
  for(const o of openings)if(o[2]>y0+.1&&o[4]!==false)window(axis,outward<0?face:face-.12,...o);
 }
 function slab(y,opening=null) {
  const xs=[floorBounds[0],floorBounds[1],...(opening?[opening.x0,opening.x1]:[])].sort((a,b)=>a-b),zs=[floorBounds[2],floorBounds[3],...(opening?[opening.z0,opening.z1]:[])].sort((a,b)=>a-b);
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<zs.length-1;j++){
   if(opening&&xs[i]>=opening.x0&&xs[i+1]<=opening.x1&&zs[j]>=opening.z0&&zs[j+1]<=opening.z1)continue;
   const split=[Math.ceil((xs[i+1]-xs[i])/1.5),1,Math.ceil((zs[j+1]-zs[j])/1.5)];
   B([xs[i],y-.18,zs[j]],[xs[i+1],y-.012,zs[j+1]],M.trim,'floor',split);
   B([xs[i],y-.012,zs[j]],[xs[i+1],y,zs[j+1]],M.oak,'floor-finish',split);
  }
 }
 return {B,wall,window,facade,slab};
}
