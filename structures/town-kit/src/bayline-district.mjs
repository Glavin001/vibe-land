import {buildVictorianCorner} from './victorian.mjs';
import {buildPorchHouse} from './porch-house.mjs';
import {buildBungalow} from './bungalow.mjs';
import {buildCornerGrocery} from './corner-grocery.mjs';
import {buildWorkshop} from './workshop.mjs';
import {buildProp} from './props.mjs';
import {Builder,composeScene,boundsFor} from './geometry.mjs';
import {TOWN_LOTS,buildStreetBlock,placementPoint} from './bayline-town.mjs';
import {M} from './materials.mjs';
import {createHash} from 'node:crypto';
export const DISTRICT_KEY='bayline-district';
const hash=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
const builders={house:buildPorchHouse,bungalow:buildBungalow,cafe:buildVictorianCorner,grocery:buildCornerGrocery,workshop:buildWorkshop};
const quarters=[
 {name:'old-market',at:[-52,0,-36],colors:['blue','sage','rose'],shop:'GROCER',work:'WORKS',brick:'#986449',floors:3},
 {name:'garden-lanes',at:[52,0,-36],colors:['cream','rose','sage'],shop:'BAKERY',work:'STUDIO',brick:'#c3ad8e',floors:2},
 {name:'willow-crossing',at:[52,0,36],colors:['slate','ochre','cream'],shop:'BOOKS',work:'GARAGE',brick:'#795748',floors:3},
 {name:'foundry-square',at:[-52,0,36],colors:['rose','blue','ochre'],shop:'MARKET',work:'DEPOT',brick:'#a57557',floors:2},
];
export const DISTRICT_LOTS=quarters.flatMap((q,qi)=>TOWN_LOTS.map((source,li)=>{
 const houseIndex=[0,3,5].indexOf(li),bungalow=li===[0,5,3,0][qi];
 const type=bungalow?'bungalow':source.builder;
 let options={...source.options};
 if(houseIndex>=0)options={palette:q.colors[houseIndex],mirrored:(qi+li)%2===1,fence:true,...(bungalow?{porch:qi%2?'entry':'full',windowStyle:qi%2?'wide':'paired'}:{windowStyle:(qi+li)%2?'paired':'classic'})};
 if(type==='cafe')options={palette:q.colors[1],storeys:q.floors,mirrored:qi%2===1};
 if(type==='grocery')options={palette:q.colors[0],brickColor:q.brick,joineryColor:['#314c45','#79534d','#344a5b','#4b5b43'][qi],signText:q.shop,mirrored:qi%2===1};
 if(type==='workshop')options={...(qi?{palette:q.colors[2]}:{}),signText:q.work,mirrored:qi%2===1};
 return {id:`${q.name}-${type}-${li}`,quarter:q.name,builder:type,options,position:source.position.map((n,k)=>n+q.at[k]),yaw:source.yaw};
}));
function square(){
 const b=new Builder('town-square',{group:'terrain'}),paving=b.table.push({...b.table[M.footing],name:'square-paving',color:'#c4bba7',textureKey:null,roughness:1})-1;
 for(const [x0,x1,z0,z1]of [[-9,9,-8,8],[-46,-9,-1.5,1.5],[9,46,-1.5,1.5],[-1.5,1.5,-30,-8],[-1.5,1.5,8,30]]){
  const split=[Math.ceil((x1-x0)/2),1,Math.ceil((z1-z0)/2)];
  b.box({min:[x0,-.15,z0],max:[x1,0,z1],fixed:true,type:'foundation',material:M.footing,split});
  b.box({min:[x0,0,z0],max:[x1,.06,z1],type:'paving',material:paving,split});
 }
 const placements=[{pack:b.build()}];
 for(const x of [-5,5])for(const z of [-4,4]){
  placements.push({pack:buildProp('table').pack,position:[x,.06,z]});
  for(const side of [-1,1])placements.push({pack:buildProp('chair').pack,position:[x,.06,z+side*.85],yaw:side<0?180:0});
 }
 return composeScene(placements,{key:'town-square'});
}
const boundsTransform=(bounds,lot)=>{const p=bounds.map(v=>placementPoint(v,lot));return [p[0].map((x,k)=>Math.min(x,p[1][k])),p[0].map((x,k)=>Math.max(x,p[1][k]))];};
export function buildBaylineDistrict({furnished=true}={}){
 const placements=[],instances=[],rooms=[],entrances=[],route=[],templates=new Map(),cameras={
  hero:{position:[-136,104,-130],target:[-3,1,0]},
  aerial:{position:[104,156,-127],target:[0,0,0]},
  reverse:{position:[139,91,110],target:[0,1,0]},
  'central-square':{position:[0,6,-13],target:[0,1,2]},
  'market-street':{position:[-93,4,-38],target:[-52,3,-32]},
  'garden-street':{position:[98,4,-37],target:[51,3,-31]},
  'willow-street':{position:[97,4,34],target:[48,3,39]},
  'foundry-street':{position:[-97,4,34],target:[-52,3,40]},
 };
 let nodeStart=0;
 const add=(name,at)=>route.push({name,at});
 for(const [qi,q]of quarters.entries()){
  const lots=DISTRICT_LOTS.filter(l=>l.quarter===q.name);
  // Join blocks along the public street centre lines. Every preceding block
  // returns to its intersection, keeping inter-block paths clear of lots.
  add(`${q.name}/intersection`,[q.at[0],0,q.at[2]]);
  for(const lot of lots){
   const options={...lot.options,furnished},templateKey=JSON.stringify([lot.builder,options]);
   if(!templates.has(templateKey)){const asset=builders[lot.builder](options);templates.set(templateKey,{...asset,hash:hash(asset.pack)});}
   const asset=templates.get(templateKey),m=asset.metadata,pack=structuredClone(asset.pack),point=p=>placementPoint(p,lot);
   pack.scenario.nodeGroups=pack.scenario.nodeGroups.map(g=>`${g}@${lot.id}`);
   placements.push({pack,position:lot.position,yaw:lot.yaw});
   const start=point(m.route[0].at),side=Math.sign(lot.position[2]-q.at[2]),sidewalkZ=q.at[2]+side*5;
   // Always leave the street at the reviewed front entrance. Returning to the
   // intersection costs some walking, but cannot cut through a neighbor's lot.
   add(`${lot.id}/crosswalk`,[q.at[0],0,sidewalkZ]);add(`${lot.id}/sidewalk`,[start[0],0,sidewalkZ]);
   route.push(...m.route.map(p=>({...p,name:`${lot.id}/${p.name}`,at:point(p.at)})));
   add(`${lot.id}/return-sidewalk`,[start[0],0,sidewalkZ]);add(`${lot.id}/return-crosswalk`,[q.at[0],0,sidewalkZ]);add(`${lot.id}/intersection`,[q.at[0],0,q.at[2]]);
   entrances.push(...m.entrances.map(e=>({...e,name:`${lot.id}/${e.name}`,instance:lot.id,at:point(e.at)})));
   rooms.push(...m.rooms.map(r=>({...r,name:`${lot.id}/${r.name}`,instance:lot.id,bounds:boundsTransform(r.bounds,lot)})));
   for(const [name,c]of Object.entries(m.cameras))cameras[`${lot.id}-${name}`]={position:point(c.position),target:point(c.target)};
   const s=pack.scenario,bs=s.nodes.map((n,i)=>boundsFor(n,s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i]));
   const local=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...bs.map(b=>b[end][k]))));
   instances.push({...lot,options:m.options,sourceSha256:asset.hash,nodeStart,nodeCount:s.nodes.length,bondCount:s.bonds.length,bounds:boundsTransform(local,lot)});
   nodeStart+=s.nodes.length;
  }
  cameras[q.name]={position:[q.at[0]-36,25,q.at[2]-35],target:[q.at[0],2,q.at[2]]};
 }
 add('square-approach',[-52,0,0]);add('square-west-path',[-44,0,0]);add('central-square',[0,.06,0]);
 for(const q of quarters){
  const housePaths=DISTRICT_LOTS.filter(l=>l.quarter===q.name&&['house','bungalow'].includes(l.builder)).map(l=>{const gate=placementPoint([l.options.mirrored?-1.2:1.2,0,-10.8],l),x=gate[0]-q.at[0],front=l.yaw===0;return [x-.85,x+.85,front?6:l.position[2]-q.at[2]+8.12,front?l.position[2]-q.at[2]-8.12:-6];});
  placements.push({pack:buildStreetBlock({housePaths}),position:q.at});
 }
 placements.push({pack:square()});
 const pack=composeScene(placements,{key:DISTRICT_KEY,title:'Bayline District · Four neighborhoods'});
 const metadata={kind:'scene',sceneLayout:true,buildingType:'district',options:{furnished},bounds:[[-104,-.5,-72],[104,14,72]],instances,rooms,entrances,route,cameras,shots:{},shotGroups:{},
  composition:{buildings:instances.length,quarters:quarters.map(q=>({name:q.name,intersection:q.at})),extentMetres:[208,144],areaSquareMetres:208*144,relativeToFirstScene:4,templateCount:templates.size,buildingTypes:[...new Set(instances.map(i=>i.builder))],storeyCounts:instances.reduce((a,i)=>(a[i.options.storeys??2]=(a[i.options.storeys??2]??0)+1,a),{}),palettes:[...new Set(instances.map(i=>i.options.palette))]},
  acceptance:{readyForRelease:false,note:'Expanded experimental scene: new variants and combined native stability/traversal require review; full-collapse qualification remains open.'}};
 return {pack,metadata,templates:[...templates.entries()].map(([key,a])=>({key,...a}))};
}
