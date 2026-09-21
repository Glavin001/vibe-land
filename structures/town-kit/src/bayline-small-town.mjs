import {buildVictorianCorner} from './victorian.mjs';
import {buildPorchHouse} from './porch-house.mjs';
import {buildBungalow} from './bungalow.mjs';
import {buildCornerGrocery} from './corner-grocery.mjs';
import {buildWorkshop} from './workshop.mjs';
import {buildStripShop} from './strip-shop.mjs';
import {buildProp} from './props.mjs';
import {Builder,composeScene,boundsFor} from './geometry.mjs';
import {placementPoint} from './bayline-town.mjs';
import {M} from './materials.mjs';
import {createHash} from 'node:crypto';
export const SMALL_TOWN_KEY='bayline-small-town';
const palettes=['blue','sage','ochre','cream','rose','slate'];
const builders={house:buildPorchHouse,bungalow:buildBungalow,cafe:buildVictorianCorner,grocery:buildCornerGrocery,workshop:buildWorkshop,shop:buildStripShop};
const hash=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
export function townLots(){
 const lots=[];let residential=0;
 const add=(zone,type,x,z,roadZ,yaw,options={})=>lots.push({id:`${zone}-${type}-${lots.length+1}`,zone,builder:type,position:[['cafe','grocery'].includes(type)&&x===-102?-102.5:x,0,z],roadZ,yaw,options});
 for(const z of [18,74])for(const x of [-120,-102,-72,-54,-12,6,48,66,108,126]){
  const i=residential++,bungalow=i%3===0;
  add('garden',bungalow?'bungalow':'house',x,z,z===18?0:56,0,{palette:palettes[i%6],mirrored:i%2===1,fence:true,...(bungalow?{porch:i%2?'entry':'full',windowStyle:i%2?'wide':'paired'}:{windowStyle:i%2?'paired':'classic'})});
 }
 for(const x of [-120,-102,108,126]){const i=residential++,bungalow=i===21;add('garden',bungalow?'bungalow':'house',x,38,56,180,{palette:palettes[i%6],mirrored:i%2===1,fence:true,...(bungalow?{porch:'entry',windowStyle:'wide'}:{windowStyle:i%2?'paired':'classic'})});}
 const signs=['BAKERY','BOOKS','CAFE','FLORIST','TOOLS','DELI','MARKET','STUDIO','SALON','REPAIR','GROCER','BANK'];
 for(const center of [-60,60])for(let i=0;i<6;i++)add('high-street','shop',center+(i-2.5)*6.25,-13,0,180,{palette:palettes[i],signText:signs[(center<0?0:6)+i],mirrored:i%2===1});
 for(const [i,x]of [-120,-102,-12,6,108,126].entries())add('civic-centre','cafe',x,-16,0,180,{palette:palettes[(i+1)%6],storeys:[2,2,3,3,2,2][i],mirrored:i%2===1});
 for(const x of [-12,12])add('civic-centre','cafe',x,41,56,180,{palette:x<0?'cream':'sage',storeys:3,mirrored:x>0});
 for(const [i,x]of [-120,-102,-66,-48,-12,6,60,116].entries())add('village-market','grocery',x,98,112,180,{palette:palettes[i%6],brickColor:['#986449','#c3ad8e','#795748','#a57557'][i%4],joineryColor:['#314c45','#79534d','#344a5b','#4b5b43'][i%4],signText:['GROCER','BAKERY','BOOKS','MARKET'][i%4],mirrored:i%2===1});
 for(const z of [-42,-74])for(const [i,x]of [-116,-66,-48,0,60,116].entries())add('foundry','workshop',x,z,-56,z===-42?0:180,{palette:palettes[(i+2)%6],signText:['WORKS','GARAGE','DEPOT','STUDIO','TOOLS','REPAIR'][i],mirrored:i%2===1});
 if(lots.length!==64)throw Error('Expected exactly 64 independent buildings');
 return lots;
}
const AVENUES=[-90,-30,30,90],STREETS=[-56,0,56,112];
function ground(lots,assets){
 const b=new Builder('small-town-streets',{group:'terrain'});
 const asphalt=b.table.push({...b.table[M.footing],name:'asphalt',color:'#525a59',textureKey:null,roughness:1})-1;
 const paving=b.table.push({...b.table[M.footing],name:'town-paving',color:'#bcb29e',textureKey:'concrete-wall',roughness:1})-1;
 const paint=b.table.push({...b.table[M.footing],name:'road-paint',color:'#e8ddac',textureKey:null,roughness:1})-1;
 const slab=(x0,x1,z0,z1,material)=>{
  if(x1-x0<.001||z1-z0<.001)return;
  const split=[Math.ceil((x1-x0)/3),1,Math.ceil((z1-z0)/3)];
  b.box({min:[x0,-.15,z0],max:[x1,0,z1],material:M.footing,type:'foundation',fixed:true,split});
  b.box({min:[x0,0,z0],max:[x1,material===asphalt?.025:.06,z1],material,type:material===asphalt?'road':'paving',split});
 };
 const gaps=(lo,hi,centers,half)=>{const result=[];let at=lo;for(const c of centers){if(c-half>at)result.push([at,c-half]);at=Math.max(at,c+half);}if(at<hi)result.push([at,hi]);return result;};
 // Split crossing rectangles: roads and sidewalks never overlap each other.
 for(const z of STREETS)slab(-140,140,z-4,z+4,asphalt);
 for(const x of AVENUES)for(const [z0,z1]of gaps(-100,118,STREETS,4))slab(x-4,x+4,z0,z1,asphalt);
 for(const z of STREETS)for(const [x0,x1]of gaps(-140,140,AVENUES,4))for(const side of [-1,1])slab(x0,x1,z+side*5-1,z+side*5+1,paving);
 for(const x of AVENUES)for(const [z0,z1]of gaps(-100,118,STREETS,6))for(const side of [-1,1])slab(x+side*5-1,x+side*5+1,z0,z1,paving);
 const mark=(x0,x1,z0,z1)=>b.box({min:[x0,.025,z0],max:[x1,.027,z1],material:paint,type:'road-marking'});
 for(const z of STREETS)for(let x=-138;x<138;x+=5)if(AVENUES.every(v=>Math.abs(x-v)>7))mark(x,x+2,z-.045,z+.045);
 for(const x of AVENUES)for(let z=-98;z<116;z+=5)if(STREETS.every(v=>Math.abs(z-v)>7))mark(x-.045,x+.045,z,z+2);
 for(const x of AVENUES)for(const z of STREETS)for(const side of [-1,1])for(let i=-3;i<=3;i++){
  const d=side<0?-6:4.4;mark(x+d,x+d+1.6,z+i-.19,z+i+.19);mark(x+i-.19,x+i+.19,z+d,z+d+1.6);
 }
 for(const lot of lots){
  const asset=assets.get(lot.templateKey),m=asset.metadata,front=placementPoint(m.entrances[0].at,lot),side=Math.sign(lot.position[2]-lot.roadZ),edge=lot.roadZ+side*6;
  let center=lot.position[0],width=lot.builder==='workshop'?14.2:lot.builder==='cafe'?12.4:lot.builder==='grocery'?12.2:6.25,end=front[2]-side*.16;
  if(['house','bungalow'].includes(lot.builder)){center=placementPoint([lot.options.mirrored?-1.2:1.2,0,-10.8],lot)[0];width=1.7;end=lot.position[2]-side*8.12;}
  // A 10 mm paving expansion joint separates neighboring shop frontages.
  if(lot.builder==='shop')width=6.24;
  slab(center-width/2,center+width/2,Math.min(edge,end),Math.max(edge,end),paving);
 }
 // A quiet garden square between the residential streets and village shops.
 slab(-9,9,82,90,paving);slab(-24,-9,84.5,87.5,paving);slab(9,24,84.5,87.5,paving);
 const placements=[{pack:b.build()}];
 for(const x of [-5,5])for(const z of [84,88]){placements.push({pack:buildProp('table').pack,position:[x,.06,z]});for(const side of [-1,1])placements.push({pack:buildProp('chair').pack,position:[x,.06,z+side*.85],yaw:side<0?180:0});}
 return composeScene(placements,{key:'small-town-ground'});
}
const transformBounds=(bounds,lot)=>{const p=bounds.map(v=>placementPoint(v,lot));return [p[0].map((x,k)=>Math.min(x,p[1][k])),p[0].map((x,k)=>Math.max(x,p[1][k]))];};
export function buildBaylineSmallTown({furnished=true}={}){
 const lots=townLots(),assets=new Map(),placements=[],instances=[],rooms=[],entrances=[],route=[],cameras={
  hero:{position:[-187,151,-164],target:[0,2,5]},aerial:{position:[162,196,-145],target:[0,0,9]},reverse:{position:[179,136,180],target:[0,2,12]},
  'shopping-row':{position:[-80,2.6,-1],target:[-54,2,-9]},'shopping-row-east':{position:[40,2.6,-1],target:[69,2,-9]},
  'main-street':{position:[-133,3,-1.7],target:[0,3,0]},'civic-centre':{position:[-25,4,-2],target:[-2,5,-16]},
  'garden-homes':{position:[-133,3,53],target:[-99,2,72]},'bungalow-lane':{position:[-130,3,2],target:[-110,2,17]},
  'workshop-district':{position:[-128,4,-57],target:[-53,3,-49]},'village-market':{position:[-132,3,110],target:[-72,3,98]},
  'garden-square':{position:[0,4,80.5],target:[0,1,88]},
 };
 let offset=0,previousRoad=null,previousX=-138;
 const add=(name,at)=>route.push({name,at});
 for(const lot of lots){
  lot.templateKey=JSON.stringify([lot.builder,{...lot.options,furnished}]);
  if(!assets.has(lot.templateKey)){const a=builders[lot.builder]({...lot.options,furnished});assets.set(lot.templateKey,{...a,hash:hash(a.pack)});}
  const a=assets.get(lot.templateKey),m=a.metadata,pack=structuredClone(a.pack),point=p=>placementPoint(p,lot);
  pack.scenario.nodeGroups=pack.scenario.nodeGroups.map(g=>`${g}@${lot.id}`);placements.push({pack,position:lot.position,yaw:lot.yaw});
  const start=point(m.route[0].at),side=Math.sign(lot.position[2]-lot.roadZ),sidewalk=lot.roadZ+side*5;
  if(previousRoad!==null&&previousRoad!==lot.roadZ){const via=AVENUES.reduce((a,x)=>Math.abs(x-previousX)<Math.abs(a-previousX)?x:a,AVENUES[0]);add('avenue-turn',[via,0,previousRoad]);add('avenue-arrival',[via,0,lot.roadZ]);}
  add(`${lot.id}/road`,[start[0],0,lot.roadZ]);add(`${lot.id}/sidewalk`,[start[0],0,sidewalk]);
  route.push(...m.route.map(p=>({...p,name:`${lot.id}/${p.name}`,at:point(p.at)})));add(`${lot.id}/return-sidewalk`,[start[0],0,sidewalk]);add(`${lot.id}/return-road`,[start[0],0,lot.roadZ]);previousRoad=lot.roadZ;previousX=start[0];
  entrances.push(...m.entrances.map(e=>({...e,name:`${lot.id}/${e.name}`,instance:lot.id,at:point(e.at)})));
  rooms.push(...m.rooms.map(r=>({...r,name:`${lot.id}/${r.name}`,instance:lot.id,bounds:transformBounds(r.bounds,lot)})));
  for(const [name,c]of Object.entries(m.cameras))cameras[`${lot.id}-${name}`]={position:point(c.position),target:point(c.target)};
  const s=pack.scenario,bs=s.nodes.map((n,i)=>boundsFor(n,s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i]));
  const local=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...bs.map(b=>b[end][k]))));
  instances.push({...lot,options:m.options,sourceSha256:a.hash,nodeStart:offset,nodeCount:s.nodes.length,bondCount:s.bonds.length,bounds:transformBounds(local,lot)});offset+=s.nodes.length;
 }
 placements.push({pack:ground(lots,assets)});
 const pack=composeScene(placements,{key:SMALL_TOWN_KEY,title:'Bayline · A small town'});
 const metadata={kind:'scene',sceneLayout:true,buildingType:'small-town',options:{furnished},bounds:[[-140,-.5,-100],[140,14,118]],instances,rooms,entrances,route,cameras,shots:{},shotGroups:{},
  composition:{buildings:64,extentMetres:[280,218],areaSquareMetres:61040,templateCount:assets.size,maximumStoreys:3,zones:instances.reduce((a,i)=>(a[i.zone]=(a[i.zone]??0)+1,a),{}),storeyCounts:instances.reduce((a,i)=>(a[i.options.storeys??2]=(a[i.options.storeys??2]??0)+1,a),{}),palettes},
  acceptance:{readyForRelease:false,note:'Experimental 64-building town. Geometry/visual review and native acceptance are tracked independently; no idle-cost or complete destruction qualification is implied by independent bond graphs.'}};
 return {pack,metadata,templates:[...assets.entries()].map(([key,a])=>({key,...a}))};
}
