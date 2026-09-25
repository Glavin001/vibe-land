import { unpack, boundsOverlap, dot, sub, cross, length, planeOf } from './dune/convex.mjs';
const TOLERANCE = 3e-6;
function clipPolygon(polygon, normal, distance) {
 const result=[];
 for(let i=0;i<polygon.length;i++) {
  const a=polygon[i],b=polygon[(i+1)%polygon.length],da=dot(normal,a)-distance,db=dot(normal,b)-distance;
  if(da<=TOLERANCE)result.push(a);
  if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);result.push(a.map((v,k)=>v+t*(b[k]-v)));}
 }
 return result;
}
/** Coplanar face intersection. Edge/point contact has no structural area. */
export function faceContact(a,b) {
 const A=planeOf(a),B=planeOf(b);
 if(!A||!B||dot(A.n,B.n)>-1+1e-6||Math.abs(A.d+B.d)>TOLERANCE)return null;
 let polygon=a;
 for(let i=0;i<b.length&&polygon.length>=3;i++) {
  const edge=sub(b[(i+1)%b.length],b[i]),outward=cross(edge,B.n),size=length(outward);
  if(size<1e-12)continue;
  const normal=outward.map(x=>x/size);polygon=clipPolygon(polygon,normal,dot(normal,b[i]));
 }
 let area=0,weighted=[0,0,0];
 for(let i=1;i<polygon.length-1;i++) {
  const weight=length(cross(sub(polygon[i],polygon[0]),sub(polygon[i+1],polygon[0])))/2;
  area+=weight;for(let k=0;k<3;k++)weighted[k]+=weight*(polygon[0][k]+polygon[i][k]+polygon[i+1][k])/3;
 }
 return area>1e-12?{area,centroid:weighted.map(x=>x/area),normal:A.n}:null;
}
export function deriveBondSurfaces(collision) {
 const parts=new Map(collision.parts.map(p=>[p.id,{...p,hulls:p.shapes.map(s=>unpack(s,p.position))}]));
 return collision.bonds.map(bond=>{
  const a=parts.get(bond.a),b=parts.get(bond.b);let area=0,weighted=[0,0,0],largest=null;
  for(const A of a.hulls)for(const B of b.hulls) {
   if(!A||!B||!boundsOverlap(A.bounds,B.bounds,TOLERANCE))continue;
   for(const fa of A.faces)for(const fb of B.faces) {
    const patch=faceContact(fa,fb);if(!patch)continue;
    area+=patch.area;for(let k=0;k<3;k++)weighted[k]+=patch.area*patch.centroid[k];
    if(!largest||patch.area>largest.area)largest=patch;
   }
  }
  return {...bond,area,centroid:area?weighted.map(x=>x/area):bond.anchor,normal:largest?.normal??null,validatedSurface:!!largest};
 });
}
