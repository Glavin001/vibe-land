/** Dogleg stairs adapted from the read-only authoring library's waist profile.
 * The return flight starts at the front of the half-landing, leaving its whole
 * 1.35 m depth clear for turning. Every upper floor cuts out both full flights.
 */
export function townStaircase(builder,{at:[x,z],y0,y1,width=1.25,material='wood-frame',waist=.14}){
 const run=.29,clearance=.06,landingLen=1.35,n=Math.round((y1-y0)/2/.18),rise=(y1-y0)/(2*n),mid=(y0+y1)/2;
 const box=(a,b,lane,w,lo,hi)=>builder.box({min:[x+lane,lo,z+Math.min(a,b)],max:[x+lane+w,hi,z+Math.max(a,b)],material,type:'stair'});
 const profile=(poly,lane)=>builder.piece({axis:'x',lo:x+lane,hi:x+lane+width,poly:poly.map(([d,y])=>[y,z+d]),material,type:'stair'});
 function flight(start,base,count,lane,dir){
  const d=k=>start+dir*k*run;
  box(d(0),d(1),lane,width,base,base+rise);
  profile([[d(1),base+rise-waist],[d(count),base+count*rise-waist],[d(count),base+count*rise],[d(1),base+rise]],lane);
  for(let k=1;k<count;k++)profile([[d(k),base+k*rise],[d(k+1)-dir*.002,base+(k+1)*rise-.002*rise/run],[d(k),base+(k+1)*rise]],lane);
 }
 const landingStart=(n-1)*run,landingEnd=landingStart+landingLen,well=2*width+2*clearance;
 flight(0,y0,n-1,clearance,1);
 box(landingStart,landingEnd,0,well,mid-rise-waist,mid);
 flight(landingStart,mid,n,clearance+width,-1);
 return {x0:x,x1:x+well,z0:z-run,z1:z+landingEnd,landingStart:z+landingStart,void:{x0:x,x1:x+well,z0:z-run,z1:z+landingEnd}};
}
