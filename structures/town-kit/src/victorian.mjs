import {createEnvelope} from './parts/envelope.mjs';
import { Builder, composeScene, nativeColliders } from './geometry.mjs';
import { townStaircase as staircase } from './stairs.mjs';
import { weldFencePosts, attachBuiltins } from './attachments.mjs';
import { M } from './materials.mjs';
import { buildPropRaw as buildProp } from './props.mjs';

export function buildVictorianCorner(options={}) {
 const C={storeys:3,mirrored:false,palette:'sage',furnished:true,fence:true,seed:20260920,...options};
 if(![2,3].includes(C.storeys))throw Error('Supported storeys: 2 or 3');
 const b=new Builder('victorian-corner',C),placements=[],rooms=[],route=[],cameras={};
 const {B,wall,window,facade,slab}=createEnvelope(b);
 const ys=[.18,3.78,6.98],roofY=ys[C.storeys-1]+3.2;
 const addRoute=(name,x,y,z)=>route.push({name,at:[x,y,z]});
 const prop=(type,x,y,z,yaw=0,extra={})=>placements.push({pack:buildProp(type,{...C,...extra}).pack,position:[x,y,z],yaw,group:`${type}-${placements.length}`});
 // Continuous foundation strips meet walls through the ground-floor structure.
 for(const [min,max] of [[[-6,-.5,-8],[6,0,-7.65]],[[-6,-.5,7.65],[6,0,8]],[[-6,-.5,-7.65],[-5.65,0,7.65]],[[5.65,-.5,-7.65],[6,0,7.65]],[[-.18,-.5,-7.65],[.18,0,7.65]]])b.box({min,max,material:M.footing,type:'foundation',fixed:true,split:[1,1,1]});
 slab(ys[0]);
 // A masonry plinth protects the siding. Only the buried strips are anchors.
 for(const z of [-8.14,8])B([-6,0,z],[6,.18,z+.14],M.brick,'masonry-base',[12,1,1]);
 for(const x of [-6.14,6])B([x,0,-8],[x+.14,.18,8],M.brick,'masonry-base',[1,1,16]);
 const stairs=[];
 for(let f=0;f<C.storeys-1;f++) {
  const y0=ys[f],y1=ys[f+1];
  const fp=staircase(b,{at:[2.9,-4.8],y0,y1,axis:'z',width:1.25,material:M.oak,newelPost:false,waist:.14});stairs.push(fp);
  slab(y1,fp.void);
  // Two shaft walls and the far wall bear the half-landing. Front stays open.
  wall('x',[2.70,2.9],-4.8,fp.z1,y0,y1-.18,[],M.plaster,'stair-wall');
  wall('x',[5.52,5.72],-4.8,fp.z1,y0,y1-.18,[],M.plaster,'stair-wall');
  wall('z',[fp.z1,fp.z1+.20],2.70,5.72,y0,y1-.18,[],M.plaster,'stair-wall');
  // Continuous rails follow both flights; sloped post heads meet real faces.
  const rise=y1-y0,n=Math.round(rise/2/.18),r=rise/(n*2);
  for(const second of [false,true]){
   const startZ=second?fp.landingStart:-4.8,dir=second?-1:1,count=second?n:n-1;
   const base=second?y0+rise/2:y0,x0=second?4.215:4.16,x1=x0+.045;
   const height=z=>base+r+.86+dir*(z-startZ)*r/.29;
   const ends=[startZ,startZ+dir*count*.29].sort((a,b)=>a-b);
   // Keep the rail in short replaceable timber lengths, with full butt joints.
   for(let k=0;k<3;k++){
    const a=ends[0]+(ends[1]-ends[0])*k/3,c=ends[0]+(ends[1]-ends[0])*(k+1)/3;
    b.piece({axis:'x',lo:x0-.005,hi:x1+.005,poly:[[height(a),a],[height(c),c],[height(c)+.06,c],[height(a)+.06,a]],material:M.oak,type:'handrail'});
   }
   for(let i=0;i<count;i+=2){
    const z=startZ+dir*(i+.45)*.29,za=z-.022,zb=z+.022,baseY=base+(i+1)*r;
    b.piece({axis:'x',lo:x0,hi:x1,poly:[[baseY,za],[baseY,zb],[height(zb),zb],[height(za),za]],material:M.dark,type:'baluster'});
   }
  }
 }
 for(let f=0;f<C.storeys;f++) {
  const y=ys[f],top=f===0?ys[1]-.18:(f+1<C.storeys?ys[f+1]-.18:roofY-.18);
  const front=f===0?[[-5.45,-3.50,y+.55,y+2.75],[-3.1,-1.7,y,y+2.55],[-1.25,1.75,y+.55,y+2.75],[3.8,5,y,y+2.55]]:[[-5,-2.6,y,y+2.65],[-.85,.85,y+.65,y+2.45],[3.65,5.15,y+.65,y+2.45]];
  const back=[[-4.8,-3.2,y+.75,y+2.45],[-.8,.8,y+.75,y+2.45],[3.7,5.1,y+.9,y+2.4]];
  if(f===0)back[1]=[-.7,.7,y,y+2.55];
  facade('z',[-8,-7.82],-6,6,y,top,front);
  facade('z',[7.82,8],-6,6,y,top,back);
  const side=[[-6.6,-4.8,y+.70,y+2.45],[-2.9,-1.1,y+.70,y+2.45],[1.1,2.9,y+.70,y+2.45],[4.8,6.6,y+.70,y+2.45]];
  facade('x',[-6,-5.82],-7.82,7.82,y,top,side);
  facade('x',[5.82,6],-7.82,7.82,y,top,side);
  // Exterior corner boards stop cleanly at floor bands.
  for(const sx of [-1,1])for(const sz of [-1,1]){
   const xr=sx<0?[-6.10,-5.87]:[5.87,6.10],zr=sz<0?[-8.10,-8.03]:[8.03,8.10];
   B([xr[0],y,zr[0]],[xr[1],top,zr[1]],M.trim,'corner-board',[1,3,1]);
   const xx=sx<0?[-6.10,-6.03]:[6.03,6.10],zz=sz<0?[-8.03,-7.87]:[7.87,8.03];
   B([xx[0],y,zz[0]],[xx[1],top,zz[1]],M.trim,'corner-board',[1,3,1]);
  }
  for(const z of [-8.12,8.03])B([-5.87,top-.12,z],[5.87,top,z+.09],M.trim,'cornice',[12,1,1]);
  for(const x of [-6.12,6.03])B([x,top-.12,-7.87],[x+.09,top,7.87],M.trim,'cornice',[1,1,16]);
  // A floor-level band bears on the actual floor edge, distinct from cornice.
  if(f>0)for(const z of [-8.09,8])wall('z',[z,z+.09],-5.87,5.87,y-.18,y,z<0?[[-5,-2.6,y-.18,y]]:[],M.trim,'floor-band');
  if(f>0){
   // A hollow, usable projecting bay, with its own floor and roof.
   B([-5,y-.18,-8.80],[-2.6,y,-8],M.oak,'bay-floor',[2,1,1]);
   facade('z',[-8.80,-8.66],-5,-2.6,y,y+2.65,[[-4.72,-2.88,y+.60,y+2.38]]);
   for(const xx of [-5,-2.74])wall('x',[xx,xx+.14],-8.66,-8,y,y+2.65,[],M.siding,'bay-return');
   B([-5,y+2.65,-8.80],[-2.6,y+2.77,-8.03],M.trim,'bay-canopy',[2,1,1]);
   for(const x of [-4.86,-4.05,-3.24])B([x,y+2.48,-8.88],[x+.16,y+2.65,-8.83],M.trim,'bay-bracket');
  }
  if(f===0){
   wall('z',[2,2.12],-5.82,5.82,y,top,[[.2,1.6,y,y+2.3]],M.plaster,'interior-wall');
   wall('x',[2.4,2.52],2.12,7.82,y,top,[[4,5.2,y,y+2.3]],M.plaster,'interior-wall');
   rooms.push({name:'cafe',floor:f,bounds:[[-5.82,y,-7.82],[2.7,top,2]]},{name:'preparation',floor:f,bounds:[[-5.82,y,2.12],[2.4,top,7.82]]},{name:'store',floor:f,bounds:[[2.52,y,2.12],[5.82,top,7.82]]});
   // Door leaves are visibly open and physically outside the clear opening.
   B([-3.1,y,-7.82],[-3.035,y+2.5,-6.6],M.dark,'open-door',[1,3,2]);
   B([3.8,y,-7.82],[3.865,y+2.5,-6.6],M.dark,'open-door',[1,3,2]);
   B([-.70,y,6.6],[-.635,y+2.5,7.82],M.dark,'open-door',[1,3,2]);
  } else {
   wall('z',[1,1.12],-5.82,5.82,y,top,[[-3,-1.8,y,y+2.3],[1.2,2.4,y,y+2.3]],M.plaster,'interior-wall');
   wall('x',[.6,.72],1.12,7.82,y,top,[],M.plaster,'interior-wall');
   wall('z',[4.5,4.62],.72,5.82,y,top,[[3.4,4.6,y,y+2.3]],M.plaster,'interior-wall');
   for(const [name,lo,hi] of [['living',[-5.82,y,-7.82],[2.7,top,1]],['bedroom',[-5.82,y,1.12],[.6,top,7.82]],['kitchen',[.72,y,1.12],[5.82,top,4.5]],['bathroom',[.72,y,4.62],[5.82,top,7.82]]])rooms.push({name:`${name}-${f}`,floor:f,bounds:[lo,hi]});
   for(const [x,z] of [[-3,1.12],[1.2,1.12],[3.4,4.62]])B([x,y,z],[x+.06,y+2.25,z+1.12],M.trim,'open-door',[1,3,2]);
  }
 }
 // Guard the final-storey opening. Intermediate storeys have shaft walls
 // and their next upward flight; the top storey needs a perimeter guard.
 {
  const opening=stairs.at(-1).void,y=ys[C.storeys-1],left=opening.x0-.075,right=opening.x1+.075,front=opening.z0-.075,rear=opening.z1+.075;
  const railY=y+.96;
  // Top rails meet at butt joints, with no overlapping corner volumes.
  for(const x of [left,right])B([x-.035,railY,front+.035],[x+.035,railY+.06,rear-.035],M.oak,'landing-guard',[1,1,Math.ceil((rear-front-.07)/1.2)]);
  B([left-.035,railY,rear-.035],[right+.035,railY+.06,rear+.035],M.oak,'landing-guard',[3,1,1]);
  // Guard only the lower-flight half; the returning stair stays open.
  const frontEnd=4.14;
  B([left-.035,railY,front-.035],[frontEnd,railY+.06,front+.035],M.oak,'landing-guard',[2,1,1]);
  const posts=new Set();
  const post=(x,z)=>{const key=`${x.toFixed(5)},${z.toFixed(5)}`;if(posts.has(key))return;posts.add(key);B([x-.025,y,z-.025],[x+.025,railY,z+.025],M.dark,'landing-baluster',[1,2,1]);};
  for(const x of [left,right]){const n=Math.ceil((rear-front-.14)/.16);for(let i=0;i<=n;i++)post(x,front+.07+(rear-front-.14)*i/n);}
  {const n=Math.ceil((right-left-.14)/.16);for(let i=0;i<=n;i++)post(left+.07+(right-left-.14)*i/n,rear);}
  {const n=Math.ceil((frontEnd-left-.12)/.16);for(let i=0;i<=n;i++)post(left+.07+(frontEnd-left-.12)*i/n,front);}
 }
 // Finished attic ceiling, cut around the chimney and framed by wall plates.
 const ceilingXs=[-5.82,3,3.7,5.82],ceilingZs=[-7.82,3.6,4.4,7.82];
 for(let i=0;i<3;i++)for(let j=0;j<3;j++)if(!(i===1&&j===1))B([ceilingXs[i],roofY-.18,ceilingZs[j]],[ceilingXs[i+1],roofY,ceilingZs[j+1]],M.trim,'ceiling',[Math.ceil((ceilingXs[i+1]-ceilingXs[i])/1.5),1,Math.ceil((ceilingZs[j+1]-ceilingZs[j])/1.5)]);
 // Eave plates have a sloping top that bears on the roof over a real face.
 for(const side of [-1,1])for(let j=0;j<8;j++){
  const x0=side<0?-6:5.82,x1=side<0?-5.82:6;
  b.piece({axis:'z',lo:-7.82+j*15.64/8,hi:-7.82+(j+1)*15.64/8,poly:[[x0,roofY-.18],[x1,roofY-.18],[x1,roofY+1.7*(1-Math.abs(x1)/6)],[x0,roofY+1.7*(1-Math.abs(x0)/6)]],material:M.frame,type:'eave-plate'});
 }
 for(const z of [-8,7.82])B([-6,roofY-.18,z],[6,roofY,z+.18],M.frame,'gable-plate',[8,1,1]);
 // Lightweight supported gables, and slate sheets split into reusable panels.
 for(const z of [-8,7.82])for(let x=-6;x<6;x+=2){
  const p=[[x,roofY],[x+2,roofY],[x+2,roofY+1.7*(1-Math.abs(x+2)/6)],[x,roofY+1.7*(1-Math.abs(x)/6)]];
  const poly=p.filter((q,i)=>!p.slice(0,i).some(v=>Math.hypot(v[0]-q[0],v[1]-q[1])<1e-7));
  b.piece({axis:'z',lo:z,hi:z+.18,poly,material:M.siding,type:'gable'});
 }
 const xs=[-6.3,-4,-2,0,2,3,3.7,4,6.3],zs=[-8.35,-6,-4,-2,0,2,3.6,4.4,6,8.35];
 const slope=x=>roofY+1.7*(1-Math.abs(x)/6);
 for(let i=0;i<xs.length-1;i++)for(let j=0;j<zs.length-1;j++){
  if(xs[i]===3&&xs[i+1]===3.7&&zs[j]===3.6&&zs[j+1]===4.4)continue;
  const x0=xs[i],x1=xs[i+1];b.piece({axis:'z',lo:zs[j],hi:zs[j+1],poly:[[x0,slope(x0)],[x1,slope(x1)],[x1,slope(x1)+.10],[x0,slope(x0)+.10]],material:M.roof,type:'roof'});
 }
 // Ridge beam and rafters stop at the underside of the slate.
 for(let j=0;j<8;j++)b.piece({axis:'z',lo:-7.82+j*15.64/8,hi:-7.82+(j+1)*15.64/8,poly:[[-.08,roofY+1.4],[.08,roofY+1.4],[.08,roofY+1.7-.08*1.7/6],[0,roofY+1.7],[-.08,roofY+1.7-.08*1.7/6]],material:M.frame,type:'ridge-beam'});
 B([3,ys[C.storeys-1],3.6],[3.7,roofY+2.25,4.4],M.brick,'chimney',[1,Math.ceil((roofY+2.25-ys[C.storeys-1])/.6),1]);
 B([2.95,roofY+2.25,3.55],[3.75,roofY+2.35,4.45],M.brick,'chimney-cap',[2,1,2]);
 // Shop fascia, transom band, and finely spaced dentils.
 B([-5.87,3.1,-8.20],[2.7,3.46,-8.03],M.dark,'shop-fascia',[9,1,1]);
 const letters={B:['110','101','110','101','110'],A:['010','101','111','101','101'],Y:['101','101','010','010','010'],L:['100','100','100','100','111'],I:['111','010','010','010','111'],N:['101','111','111','111','101'],E:['111','100','110','100','111']};
 for(const [letterIndex,letter] of [...'BAYLINE'].entries())for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(letters[letter][row][col]==='1'){
  const x0=.2-letterIndex*.55-(col+1)*.085,x1=.2-letterIndex*.55-col*.085;
  const xx=C.mirrored?[-3.17-x1,-3.17-x0]:[x0,x1];
  B([xx[0],3.16+(4-row)*.046,-8.209],[xx[1],3.16+(5-row)*.046,-8.20],M.trim,'sign-letter');
 }
 for(let x=-5.65;x<5.8;x+=.4)if(x+.12<=-5||x>=-2.6)B([x,roofY-.46,-8.18],[x+.12,roofY-.30,-8.03],M.trim,'dentil');
 const structure=b.build();placements.unshift({pack:structure});
 if(C.furnished){
  for(const x of [-4.3,-.3])for(const z of [-4.7,-1.4]){
   prop('table',x,ys[0],z);prop('chair',x,ys[0],z+.85);prop('chair',x,ys[0],z-.85,180);
  }
  for(const x of [-4.8,-3.6,-2.4])prop('counter',x,ys[0],1.68);
  prop('sink',-4.8,ys[0],7.50);prop('hob',-3.6,ys[0],7.50);prop('refrigerator',-1.8,ys[0],7.50);prop('shelf',5.49,ys[0],6.5,90);
  for(let f=1;f<C.storeys;f++){
   const y=ys[f];prop('sofa',-5.30,y,-3.5,90);prop('table',-.2,y,-1.8);prop('chair',-.2,y,-.95);prop('chair',-.2,y,-2.65,180);
   prop('bed',-3.8,y,5.7);prop('cabinet',-.0,y,6.4,90);
   prop('sink',5.50,y,2.1,90);prop('hob',5.50,y,3.3,90);prop('refrigerator',1.10,y,3.3,270);
   prop('sink',2.0,y,7.5);prop('cabinet',4.7,y,7.5);prop('toilet',4.7,y,6.3);prop('bathtub',1.3,y,5.7);
  }
 }
 if(C.fence){for(const [i,x] of [-4.8,-2.4,2.4,4.8].entries())prop('fence',x,0,12,0,{omitLeftPost:i===1||i===3});for(const x of [-6,6])prop('fence',x,0,10.8,90,{omitLeftPost:true});prop('gate',0,0,12,0,{omitLeftPost:true});}
 let pack=attachBuiltins(weldFencePosts(composeScene(placements,{key:`victorian-${C.storeys}f${C.mirrored?'-mirror':''}`,title:'Bayline · The corner café'})));
 // Ground traversal includes the café, preparation room, store, and rear exit.
 addRoute('street',-2.4,0,-10);addRoute('cafe-entry',-2.4,.18,-7);addRoute('cafe-aisle',-2.4,.18,-5.9);addRoute('cafe-centre',1.9,.18,-5.9);addRoute('cafe-rear',1.9,.18,.8);addRoute('prep-door',.9,.18,1.4);addRoute('preparation',.9,.18,3);addRoute('store-door',1.6,.18,4.6);addRoute('store',3.3,.18,4.6);addRoute('return-prep',1.6,.18,4.6);addRoute('rear-hall',0,.18,5.5);addRoute('rear-exit',0,0,8.8);addRoute('courtyard-gate',0,0,13);addRoute('courtyard-return',0,0,8.8);addRoute('back-inside',0,.18,5.5);addRoute('prep-return',.9,.18,3);addRoute('cafe-return',.9,.18,1.4);addRoute('stair-approach',1.9,.18,-5.6);addRoute('residential-lobby',4.4,.18,-5.6);addRoute('residential-exit',4.4,0,-9.5);addRoute('residential-return',4.4,.18,-5.6);addRoute('stair-lobby',3.58,.18,-5.6);
 for(let f=0;f<C.storeys-1;f++){
  const y=ys[f],rise=ys[f+1]-y,n=Math.round(rise/2/.18),r=rise/(2*n),fp=stairs[f];
  addRoute(`flight-${f}-start`,3.585,y,-4.94);
  for(let i=0;i<n-1;i++)addRoute(`flight-${f}-a-${i}`,3.585,y+(i+1)*r,-4.8+(i+.5)*.29);
  addRoute(`landing-${f}-a`,3.585,y+rise/2,fp.z1-.55);addRoute(`landing-${f}-b`,4.835,y+rise/2,fp.z1-.55);
  for(let i=0;i<n;i++)addRoute(`flight-${f}-b-${i}`,4.835,y+rise/2+(i+1)*r,fp.landingStart-(i+.5)*.29);
  const up=ys[f+1];addRoute(`floor-${f+1}`,4.835,up,-5.25);addRoute('upper-lobby',4.835,up,-5.6);addRoute('living-entry',1.9,up,-5.6);addRoute('living',-2.4,up,-5.6);addRoute('bedroom-door',-2.4,up,.4);addRoute('bedroom',-2.4,up,2);addRoute('bedroom-centre',-1.2,up,3.5);addRoute('bedroom-return',-2.4,up,2);addRoute('living-return',-2.4,up,.4);addRoute('kitchen-approach',1.8,up,.4);addRoute('kitchen',1.8,up,2);addRoute('kitchen-centre',3.6,up,2.5);addRoute('bathroom-door',4,up,4.0);addRoute('bathroom',4,up,5.3);addRoute('bathroom-return',4,up,4);addRoute('kitchen-return',3.6,up,2.5);addRoute('kitchen-out',1.8,up,2);addRoute('living-again',1.8,up,.4);addRoute('lobby-return',1.9,up,-5.6);addRoute('next-flight',3.585,up,-5.6);
 }
 // Walk the verified path backwards to the street, preserving stair elevations.
 route.push(...route.slice(0,-1).reverse().map(p=>({...p,name:`return-${p.name}`})));
 Object.assign(cameras,{hero:{position:[-18,9,-23],target:[0,5,0]},right:{position:[26,7,0],target:[0,5,0]},left:{position:[-26,7,0],target:[0,5,0]},front:{position:[0,7,-28],target:[0,5,0]},corner:{position:[22,9,-24],target:[0,5,0]},rear:{position:[-20,9,24],target:[0,5,2]},aerial:{position:[-21,25,-23],target:[0,3,0]},street:{position:[-12,1.65,-16],target:[-2,4,-7]},detail:{position:[-8,5,-13],target:[-3.8,5,-8.4]},cafe:{position:[1.8,1.83,-6.7],target:[-3,1.1,-1]},prep:{position:[1.7,1.83,3],target:[-3,1,7]},store:{position:[2.9,1.83,3.2],target:[5.3,1.1,6.3]},stairs:{position:[4.7,2,-5.8],target:[3.6,2,-2]},courtyard:{position:[9,2.2,15],target:[0,1,10]}});
 for(let f=1;f<C.storeys;f++){
  const y=ys[f];cameras[`landing-${f}`]={position:[4.9,y+1.5,-5.6],target:[3.5,y+.7,-3.5]};cameras[`living-${f}`]={position:[1.8,y+1.65,-5.5],target:[-3,y+1,-2]};cameras[`bedroom-${f}`]={position:[-1.3,y+1.65,2.2],target:[-3.8,y+.8,5.8]};cameras[`kitchen-${f}`]={position:[1.8,y+1.65,1.8],target:[5.5,y+1,3]};cameras[`bathroom-${f}`]={position:[4.9,y+1.65,5.8],target:[2.1,y+1,7.4]};
 }
 const shot=(from,to,momentum=800,radius=.10,tick=0,speed=8)=>({from,to,momentum,radius,tick,speed});
 // Slow, close shots cannot tunnel through thin glass, tabletops or pickets.
 const shots={glazing:[shot([-4.4,1.7,-8.35],[-4.4,1.7,-7.94],200000,.07,0,6)],wall:[shot([-7,1.3,-3.8],[-5.9,1.3,-3.8],2000000,.25,0,20)],furniture:[shot([-.3,1.7,-1.4],[-.3,.94,-1.4],40000,.3,0,30)],fence:[shot([-3.43,.65,12.6],[-3.43,.65,12],4000,.13,0,8)],collapse:[]};
 for(let i=0;i<8;i++)for(const side of [-1,1])shots.collapse.push(shot([side*7.4,1.1,-6.7+i*1.9],[-side*6,1.1,-6.7+i*1.9],300000,.55,shots.collapse.length*18,15));
 for(let i=0;i<6;i++)for(const side of [-1,1])shots.collapse.push(shot([-5+i*2,1.1,side*9.4],[-5+i*2,1.1,-side*8],300000,.55,shots.collapse.length*18,15));
 // Remove interior bearing paths too: façade impacts alone can leave the
 // shaft and café/service partitions supporting both upper floors.
 const coreShot=(from,to)=>shots.collapse.push(shot(from,to,300000,.55,shots.collapse.length*18,15));
 for(const x of [-4.7,-2.5,-.9,1.8,4.2,5.2])coreShot([x,1.1,3.4],[x,1.1,1.2]);
 for(const z of [2.9,5.8,7.0])coreShot([3.7,1.1,z],[1.2,1.1,z]);
 for(const z of [-4.0,-2.2]){
  coreShot([1.45,1.1,z],[4.2,1.1,z]);
  coreShot([4.95,1.1,z],[6.3,1.1,z]);
 }
 coreShot([4.2,1.1,1.0],[4.2,1.1,-2.0]);
 const entrances=[{name:'cafe',at:[-2.4,.18,-8],clearWidth:1.4},{name:'residential',at:[4.4,.18,-8],clearWidth:1.2},{name:'rear',at:[0,.18,8],clearWidth:1.4}];
 const metadata={kind:'building',options:C,entrances,rooms,route,cameras,shots,shotGroups:{glazing:'building',wall:'building',furniture:'table',fence:'fence',collapse:'building'}};
 if(C.mirrored){
  pack=composeScene([{pack,mirror:true}],{key:pack.key,title:pack.title});
  const reflect=p=>[-p[0],p[1],p[2]];
  for(const p of [...route,...entrances])p.at=reflect(p.at);for(const c of Object.values(cameras)){c.position=reflect(c.position);c.target=reflect(c.target);}for(const ss of Object.values(shots))for(const s of ss){s.from=reflect(s.from);s.to=reflect(s.to);}for(const r of rooms){const [lo,hi]=r.bounds;r.bounds=[[-hi[0],lo[1],lo[2]],[-lo[0],hi[1],hi[2]]];}
 }
 return {pack:nativeColliders(pack),metadata};
}
