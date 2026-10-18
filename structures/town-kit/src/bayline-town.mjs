import {buildVictorianCorner} from './victorian.mjs';
import {buildPorchHouse} from './porch-house.mjs';
import {buildCornerGrocery} from './corner-grocery.mjs';
import {buildWorkshop} from './workshop.mjs';
import {Builder,composeScene,boundsFor,round} from './geometry.mjs';
import {M} from './materials.mjs';

export const TOWN_KEY='bayline-town';
export const TOWN_LOTS=[
 {id:'juniper-house',builder:'house',position:[-33,0,17],yaw:0,options:{palette:'blue'}},
 {id:'corner-cafe',builder:'cafe',position:[-14,0,16],yaw:0,options:{palette:'sage'}},
 {id:'foundry-workshop',builder:'workshop',position:[14,0,16],yaw:0,options:{}},
 {id:'willow-house',builder:'house',position:[-14,0,-18],yaw:180,options:{palette:'sage',mirrored:true}},
 {id:'corner-grocery',builder:'grocery',position:[14,0,-14],yaw:180,options:{}},
 {id:'amber-house',builder:'house',position:[33,0,-18],yaw:180,options:{palette:'ochre'}},
];
const builders={house:buildPorchHouse,cafe:buildVictorianCorner,grocery:buildCornerGrocery,workshop:buildWorkshop};
export function placementPoint(p,{position=[0,0,0],yaw=0}){
 const c=Math.round(Math.cos(yaw*Math.PI/180)),s=Math.round(Math.sin(yaw*Math.PI/180));
 return [c*p[0]+s*p[2]+position[0],p[1]+position[1],-s*p[0]+c*p[2]+position[2]].map(round);
}
const transformedBounds=(bounds,placement)=>{
 const p=bounds.map(v=>placementPoint(v,placement));return [p[0].map((x,k)=>Math.min(x,p[1][k])),p[0].map((x,k)=>Math.max(x,p[1][k]))];
};
export function buildStreetBlock({housePaths=[[-32.65,-30.95,6,8.88],[-13.65,-11.95,-9.88,-6],[30.95,32.65,-9.88,-6]]}={}){
 const b=new Builder('bayline-streets',{group:'terrain'});
 // Fixed infrastructure stays entirely below grade. Above-ground buildings,
 // fences and furniture retain their authored mass and destruction bonds.
 const asphalt=b.table.push({...b.table[M.footing],name:'asphalt-subgrade',color:'#525a59',textureKey:null,roughness:1})-1;
 const paint=b.table.push({...b.table[M.footing],name:'road-paint',color:'#e8ddac',textureKey:null,roughness:.95})-1;
 const paving=b.table.push({...b.table[M.footing],name:'pale-paving',color:'#c1b9a4',textureKey:'concrete-wall',roughness:1})-1;
 const slab=(x0,x1,z0,z1,material,y0=-.16,y1=0,split=[1,1,1])=>{
  const marking=material===paint;
  if(!marking)b.box({min:[x0,y0,z0],max:[x1,0,z1],material:M.footing,fixed:true,type:'foundation',split});
  b.box({min:[x0,marking?.025:0,z0],max:[x1,marking?.027:material===paving?.06:.025,z1],material,type:marking?'road-marking':material===paving?'paving':'road',split});
 };
 // Three non-overlapping rectangles make the road cross. Thin destructible
 // surfacing bonds to buried subgrade; paint bonds onto that surfacing.
 slab(-52,52,-4,4,asphalt,-.18,-.014,[52,1,4]);
 slab(-4,4,4,36,asphalt,-.18,-.014,[4,1,16]);
 slab(-4,4,-36,-4,asphalt,-.18,-.014,[4,1,16]);
 for(let x=-50;x<52;x+=5)if(Math.abs(x)>7)slab(x,x+2,-.045,.045,paint,-.014,-.002);
 for(let z=-34;z<36;z+=5)if(Math.abs(z)>7)slab(-.045,.045,z,z+2,paint,-.014,-.002);
 for(const side of [-1,1])for(let n=-3;n<=3;n++){
  const near=side<0?-6:4.4;
  slab(near,near+1.6,n-.19,n+.19,paint,-.014,-.002);
  slab(n-.19,n+.19,near,near+1.6,paint,-.014,-.002);
 }
 for(const [z0,z1] of [[4,6],[-6,-4]])for(const [x0,x1] of [[-52,-4],[4,52]])slab(x0,x1,z0,z1,paving,-.15,0,[24,1,1]);
 for(const [x0,x1] of [[-6,-4],[4,6]])for(const [z0,z1] of [[6,36],[-36,-6]])slab(x0,x1,z0,z1,paving,-.15,0,[1,1,15]);
 // Door forecourts meet the public sidewalk. Stop short of masonry and posts.
 slab(-21,-7,6,7.84,paving,-.15,0,[7,1,1]);
 slab(6.9,21.1,6,9.85,paving,-.15,0,[7,1,2]);
 slab(7.8,20.2,-8.85,-6,paving,-.15,0,[6,1,2]);
 // House gates open into a level garden path. No pavement beneath foundations.
 for(const [x0,x1,z0,z1]of housePaths)slab(x0,x1,z0,z1,paving);
 return b.build();
}
export function buildBaylineTown({furnished=true}={}){
 const placements=[],instances=[],entrances=[],rooms=[],route=[],cameras={
  hero:{position:[-59,44,-58],target:[-3,2.5,1]},
  aerial:{position:[49,70,-57],target:[0,0,0]},
  reverse:{position:[54,34,49],target:[-1,3,0]},
  'main-street':{position:[47,3.2,-1.8],target:[-15,3,2]},
  'cafe-corner':{position:[-4,3.3,-1],target:[-14,4,15]},
  'shopping-street':{position:[-1,3,1],target:[14,3,-14]},
  'house-row':{position:[-45,6,-2],target:[-26,3,16]},
  'workshop-yard':{position:[26,4,2],target:[13,2.8,15]},
 };
 let nodeStart=0;
 const addRoute=(name,at)=>route.push({name,at});
 addRoute('town-start',[-45,0,5]);
 for(const lot of TOWN_LOTS){
  const asset=builders[lot.builder]({...lot.options,furnished});
  const sourcePack=asset.pack,pack=structuredClone(sourcePack),m=asset.metadata;
  pack.scenario.nodeGroups=pack.scenario.nodeGroups.map(g=>`${g}@${lot.id}`);
  placements.push({pack,position:lot.position,yaw:lot.yaw});
  const point=p=>placementPoint(p,lot),start=point(m.route[0].at),side=Math.sign(lot.position[2]);
  // Return routes already end at their street start. Each new building is
  // reached via the sidewalk; use the central crosswalk when changing sides.
  if(route.at(-1).at[2]*side<0){addRoute('crosswalk-approach',[0,0,route.at(-1).at[2]>0?5:-5]);addRoute('crosswalk-exit',[0,0,side*5]);}
  addRoute(`${lot.id}/sidewalk`,[start[0],0,side*5]);
  route.push(...m.route.map(p=>({...p,name:`${lot.id}/${p.name}`,at:point(p.at)})));
  addRoute(`${lot.id}/return-sidewalk`,[start[0],0,side*5]);
  entrances.push(...m.entrances.map(p=>({...p,instance:lot.id,name:`${lot.id}/${p.name}`,at:point(p.at)})));
  rooms.push(...m.rooms.map(r=>({...r,instance:lot.id,name:`${lot.id}/${r.name}`,bounds:transformedBounds(r.bounds,lot)})));
  for(const [name,c]of Object.entries(m.cameras))cameras[`${lot.id}-${name}`]={position:point(c.position),target:point(c.target)};
  const bounds=pack.scenario.nodes.map((n,i)=>boundsFor(n,pack.scenario.nodeColliders[i].kind==='shape'?pack.scenario.shapeLibrary[pack.scenario.nodeColliders[i].shape]:pack.scenario.nodeColliders[i]));
  const local=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...bounds.map(b=>b[end][k]))));
  instances.push({...lot,options:m.options,nodeStart,nodeCount:pack.scenario.nodes.length,bondCount:pack.scenario.bonds.length,bounds:transformedBounds(local,lot),sourcePack,shots:m.shots,shotGroups:m.shotGroups});
  nodeStart+=pack.scenario.nodes.length;
 }
 const terrain=buildStreetBlock();placements.push({pack:terrain});
 const pack=composeScene(placements,{key:TOWN_KEY,title:'Bayline Town · Main Street'});
 const target=instances.find(i=>i.id==='foundry-workshop'),point=p=>placementPoint(p,target);
 const shots=Object.fromEntries(Object.entries(target.shots).map(([mode,ss])=>[mode,ss.map(s=>({...s,from:point(s.from),to:point(s.to)}))]));
 const metadata={kind:'scene',sceneLayout:true,buildingType:'town',options:{furnished},bounds:[[-52,-.5,-36],[52,14,36]],instances,entrances,rooms,route,cameras,shots,
  shotGroups:Object.fromEntries(Object.entries(target.shotGroups).filter(([k])=>shots[k]).map(([k,g])=>[k,`${target.sourcePack.scenario.nodeGroups.find(n=>n===g||n.startsWith(g+'-'))??g}@${target.id}`])),
  protectedGroups:[...new Set(pack.scenario.nodeGroups.filter(g=>!g.endsWith(`@${target.id}`)&&g!=='terrain'))],
  infrastructure:{chunks:terrain.scenario.nodes.length,fixed:'Only buried foundations and road/pavement subgrade; highest fixed surface is ground level. Above-grade paving and road surfaces are bonded, destructible pieces.'},
  acceptance:{readyForRelease:false,note:'Experimental composed scene. Building-level collapse and some wall-breach reviews remain unresolved. Combined native review required.'}};
 return {pack,metadata};
}
