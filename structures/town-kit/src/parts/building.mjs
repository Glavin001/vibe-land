import {Builder,composeScene,nativeColliders} from '../geometry.mjs';
import {createEnvelope} from './envelope.mjs';
import {townStaircase} from '../stairs.mjs';
import {buildPropRaw} from '../props.mjs';
import {attachBuiltins,weldFencePosts} from '../attachments.mjs';
import {M} from '../materials.mjs';
export const shot=(from,to,momentum=300000,radius=.35,tick=0,speed=15)=>({from,to,momentum,radius,tick,speed});
/** Repeat impacts through a cladded wall, allowing fragments to move between rounds. */
export function breachShots(fromX,toX,{momentum=200000,radius=.4,z=0}={}){
 const shots=[];
 for(const y of [.55,1.35,2.2])for(let repeat=0;repeat<2;repeat++)shots.push(shot([fromX,y,z],[toX,y,z],momentum,radius,shots.length*60,30));
 return shots;
}
export function building(key,bounds,options={},supportedStoreys=[2]){
 const C={storeys:2,furnished:true,mirrored:false,palette:'sage',...options},b=new Builder(key,C),e=createEnvelope(b,{floorBounds:bounds});
 if(!supportedStoreys.includes(C.storeys))throw Error(`Supported storeys for ${key}: ${supportedStoreys.join(', ')}`);
 const placements=[],rooms=[],route=[],cameras={},entrances=[];const [x0,x1,z0,z1]=bounds;
 const prop=(type,x,y,z,yaw=0,extra={})=>placements.push({pack:buildPropRaw(type,{...C,...extra}).pack,position:[x,y,z],yaw,group:`${type}-${placements.length}`});
 const placeProp=(asset,position,yaw=0)=>placements.push({pack:asset.pack,position,yaw,group:`${asset.metadata?.type??'custom-prop'}-${placements.length}`});
 const point=(name,x,y,z)=>route.push({name,at:[x,y,z]});
 const room=(name,floor,lo,hi,position,target)=>{rooms.push({name,floor,bounds:[lo,hi]});cameras[name]={position,target};};
 const base=()=>{for(const [min,max] of [[[x0,-.45,z0],[x1,0,z0+.25]],[[x0,-.45,z1-.25],[x1,0,z1]],[[x0,-.45,z0+.25],[x0+.25,0,z1-.25]],[[x1-.25,-.45,z0+.25],[x1,0,z1-.25]]])b.box({min,max,material:M.footing,type:'foundation',fixed:true});e.slab(.18);};
 const windowWall=(axis,at,a,c,y,top,openings,material=M.wall,siding=false)=>{if(siding)e.facade(axis,at,a,c,y,top,openings);else {e.wall(axis,at,a,c,y,top,openings,material);for(const o of openings)if(o[2]>y+.1)e.window(axis,at[0],...o);}};
 const door=(x,z,y,width=1.3)=>{e.B([x-width/2,y,z],[x-width/2+.055,y+2.3,z+.85],M.dark,'open-door',[1,3,1]);};
 function stairs(x,z,y0,y1){
  const fp=townStaircase(b,{at:[x,z],y0,y1,material:M.oak});
  e.wall('x',[x-.2,x],z,fp.z1,y0,y1-.18,[],M.plaster,'stair-wall');
  e.wall('x',[fp.x1,fp.x1+.2],z,fp.z1,y0,y1-.18,[],M.plaster,'stair-wall');
  e.wall('z',[fp.z1,fp.z1+.2],x-.2,fp.x1+.2,y0,y1-.18,[],M.plaster,'stair-wall');
  const rise=y1-y0,n=Math.round(rise/2/.18),r=rise/(2*n);
  for(const second of [false,true]){
   const start=second?fp.landingStart:z,dir=second?-1:1,count=second?n:n-1,base=second?y0+rise/2:y0,xx=x+(second?1.315:1.26);
   const h=zz=>base+r+.86+dir*(zz-start)*r/.29;
   const ends=[start,start+dir*count*.29].sort((a,b)=>a-b);
   for(let k=0;k<3;k++){const a=ends[0]+(ends[1]-ends[0])*k/3,c=ends[0]+(ends[1]-ends[0])*(k+1)/3;b.piece({axis:'x',lo:xx-.005,hi:xx+.05,poly:[[h(a),a],[h(c),c],[h(c)+.06,c],[h(a)+.06,a]],material:M.oak,type:'handrail'});}
   for(let i=0;i<count;i+=2){const zz=start+dir*(i+.45)*.29,za=zz-.022,zb=zz+.022;b.piece({axis:'x',lo:xx,hi:xx+.045,poly:[[base+(i+1)*r,za],[base+(i+1)*r,zb],[h(zb),zb],[h(za),za]],material:M.dark,type:'baluster'});}
  }
  const ascent=[{name:'stair-start',at:[x+.685,y0,z-.14]}];
  for(let i=0;i<n-1;i++)ascent.push({name:`stair-a-${i}`,at:[x+.685,y0+(i+1)*r,z+(i+.5)*.29]});
  ascent.push({name:'half-landing-a',at:[x+.685,y0+rise/2,fp.z1-.55]},{name:'half-landing-b',at:[x+1.935,y0+rise/2,fp.z1-.55]});
  for(let i=0;i<n;i++)ascent.push({name:`stair-b-${i}`,at:[x+1.935,y0+rise/2+(i+1)*r,fp.landingStart-(i+.5)*.29]});
  ascent.push({name:'upper-landing',at:[x+1.935,y1,z-.6]});
  cameras.stairs={position:[x+1.95,y0+1.65,z-.9],target:[x+.7,y0+1.7,z+1.6]};
  cameras.landing={position:[x+1.9,y1+1.6,z-.9],target:[x+1,y1-.6,z+1.8]};
  return {...fp,ascent};
 }
 function rail(x0,z0,x1,z1,y){
  const length=Math.hypot(x1-x0,z1-z0),alongX=Math.abs(x1-x0)>Math.abs(z1-z0),lo=[Math.min(x0,x1),Math.min(z0,z1)],hi=[Math.max(x0,x1),Math.max(z0,z1)];
  e.B([lo[0]-.035,y+.96,lo[1]-.035],[hi[0]+.035,y+1.02,hi[1]+.035],M.oak,'guard-rail',alongX?[Math.ceil(length/1.2),1,1]:[1,1,Math.ceil(length/1.2)]);
  const count=Math.ceil(length/.3);for(let i=0;i<=count;i++){const x=x0+(x1-x0)*i/count,z=z0+(z1-z0)*i/count;e.B([x-.022,y,z-.022],[x+.022,y+.96,z+.022],M.dark,'guard-baluster',[1,2,1]);}
 }
 function guard(fp,y){rail(fp.x0-.08,fp.z0-.08,fp.x0-.08,fp.z1+.08,y);rail(fp.x1+.08,fp.z0-.08,fp.x1+.08,fp.z1+.08,y);rail(fp.x0-.08,fp.z1+.15,fp.x1+.08,fp.z1+.15,y);}
 function roof(y,height=1.7){
  const mid=(x0+x1)/2,half=(x1-x0)/2,slope=x=>y+height*(1-Math.abs(x-mid)/half);
  // The ceiling ties the gables to the storey's perimeter bearing walls.
  const ceilingStart=b.s.nodes.length;e.slab(y);for(let i=ceilingStart;i<b.s.nodes.length;i++)b.s.nodeTypes[i]='ceiling';
  for(const z of [z0,z1-.18])for(let x=x0;x<x1-.001;x+=2){const end=Math.min(x+2,x1),poly=[[x,y],[end,y],[end,slope(end)],...(x<mid&&end>mid?[[mid,slope(mid)]]:[]),[x,slope(x)]].filter((p,i,a)=>!a.slice(0,i).some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<1e-6));b.piece({axis:'z',lo:z,hi:z+.18,poly,material:M.siding,type:'gable'});}
  const xs=[x0-.25,...Array.from({length:Math.ceil(half/1.4)-1},(_,i)=>x0+(i+1)*half/Math.ceil(half/1.4)),mid,...Array.from({length:Math.ceil(half/1.4)-1},(_,i)=>mid+(i+1)*half/Math.ceil(half/1.4)),x1+.25];
  for(let i=0;i<xs.length-1;i++)for(let z=z0-.25;z<z1+.249;z+=1.25){const a=xs[i],c=xs[i+1];b.piece({axis:'z',lo:z,hi:Math.min(z+1.25,z1+.25),poly:[[a,slope(a)],[c,slope(c)],[c,slope(c)+.1],[a,slope(a)+.1]],material:M.roof,type:'roof'});}
 }
 function finish(title,shots){
  route.push(...route.slice(0,-1).reverse().map(p=>({...p,name:`return-${p.name}`})));
  Object.assign(cameras,{hero:{position:[x0-12,9,z0-15],target:[0,3.4,0]},front:{position:[0,5,z0-23],target:[0,3,0]},right:{position:[x1+23,6,0],target:[0,3,0]},left:{position:[x0-23,6,0],target:[0,3,0]},rear:{position:[x1+13,9,z1+15],target:[0,3,0]},corner:{position:[x1+13,8,z0-16],target:[0,3,0]},aerial:{position:[-19,24,-20],target:[0,1.5,0]}});
  let pack=attachBuiltins(weldFencePosts(composeScene([{pack:b.build()},...placements],{key,title})));
  const metadata={kind:'building',buildingType:key,options:C,entrances,rooms,route,cameras,shots,shotGroups:{glazing:'building',wall:'building',furniture:'table',fence:'fence',collapse:'building'}};
  if(C.mirrored){pack=composeScene([{pack,mirror:true}],{key:`${key}-mirror`,title});const flip=p=>[-p[0],p[1],p[2]];for(const p of [...route,...entrances])p.at=flip(p.at);for(const c of Object.values(cameras)){c.position=flip(c.position);c.target=flip(c.target);}for(const r of rooms){const [lo,hi]=r.bounds;r.bounds=[[-hi[0],lo[1],lo[2]],[-lo[0],hi[1],hi[2]]];}for(const ss of Object.values(shots))for(const s of ss){s.from=flip(s.from);s.to=flip(s.to);}}
  return {pack:nativeColliders(pack),metadata};
 }
 const collapseShots=()=>{const shots=[];for(const x of [x0+1,x0+(x1-x0)/3,x0+2*(x1-x0)/3,x1-1])for(const side of [-1,1])shots.push(shot([x,1.1,side<0?z0-1.2:z1+1.2],[x,1.1,side<0?z1:z0],300000,.45,shots.length*18));for(const z of [z0+1,0,z1-1])for(const side of [-1,1])shots.push(shot([side<0?x0-1.2:x1+1.2,1.1,z],[side<0?x1:x0,1.1,z],300000,.45,shots.length*18));return shots;};
 return {C,b,...e,base,windowWall,door,prop,point,room,stairs,guard,rail,roof,finish,placeProp,collapseShots,route,cameras,entrances};
}
