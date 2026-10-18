import {Builder,composeScene,boundsFor} from './geometry.mjs';
import {buildOutdoorProp,OUTDOOR_PROP_TYPES} from './outdoor-props.mjs';
import {buildTree,TREE_FAMILIES} from './tree.mjs';
import {composeVisuals} from './outdoor-visuals.mjs';
import {buildBaylineCivicTown} from './bayline-civic-town.mjs';
import {M} from './materials.mjs';

const cache=new Map();
export function outdoorAsset(type,variant=0){const key=`${type}-${variant}`;if(!cache.has(key))cache.set(key,TREE_FAMILIES.includes(type)?buildTree({family:type,variant}):buildOutdoorProp(type));return cache.get(key);}
function finish(placements,key,cameras,extra={}){
 const pack=composeScene(placements,{key,title:`Bayline · ${key.replaceAll('outdoor-','').replaceAll('-',' ')}`});
 const metadata={kind:'scene',sceneLayout:true,buildingType:'outdoor',route:[],shots:{},shotGroups:{},cameras,
  acceptance:{readyForRelease:false,note:'Native stability, destruction and traversal require measured review.'},...extra};
 return {pack,metadata,visuals:composeVisuals(placements,pack),placements};
}
export function buildOutdoorGallery(){
 const placements=[],cameras={hero:{position:[51,37,-52],target:[0,2,6]}};
 const assets=[...TREE_FAMILIES.flatMap(f=>[0,1,2].map(v=>[f,v])),...OUTDOOR_PROP_TYPES.map(t=>[t,0])];
 assets.forEach(([type,variant],i)=>{const position=[(i%5-2)*13,0,Math.floor(i/5)*13-32],asset=outdoorAsset(type,variant),tree=TREE_FAMILIES.includes(type);placements.push({...asset,position,group:`${type}-${variant}@gallery-${i}`});cameras[`${type}-${variant}`]={position:[position[0]+(tree?12:6),tree?9:4,position[2]-(tree?15:7)],target:[position[0],tree?4.5:1.2,position[2]]};});
 return finish(placements,'outdoor-gallery',cameras,{catalog:assets.map(([type,variant])=>({type,variant}))});
}
export function buildTreeReuseFixture(){
 const placements=[];for(let i=0;i<100;i++)placements.push({...outdoorAsset(TREE_FAMILIES[i%5],i%3),position:[(i%10-4.5)*11,0,(Math.floor(i/10)-4.5)*11],yaw:(i%4)*90});
 return finish(placements,'outdoor-tree-reuse',{hero:{position:[70,52,-78],target:[0,3,0]}},{treeCount:100});
}
export const ENCOUNTERS=['residential-run','market-encounter','service-yard'];
export function buildOutdoorEncounter(kind){
 if(!ENCOUNTERS.includes(kind))throw Error(`Unknown encounter ${kind}`);
 const road=new Builder(`lane-${kind}`,{group:'terrain'});
 const asphalt=road.table.push({...road.table[M.footing],name:'outdoor-asphalt',color:'#666e69',textureKey:'asphalt'})-1;
 road.box({min:[-2.5,-.15,-25],max:[2.5,0,25],material:M.footing,type:'foundation',fixed:true,split:[2,1,20]});
 road.box({min:[-2.5,0,-25],max:[2.5,.025,25],material:asphalt,type:'road',split:[2,1,20]});
 const placements=[{pack:road.build()}],add=(type,x,z,yaw=0,y=0,variant=0)=>placements.push({...outdoorAsset(type,variant),position:[x,y,z],yaw,group:`${type}@${kind}-${placements.length}`});
 if(kind==='residential-run'){
  for(let i=0;i<5;i++){const z=i*8-16;add('mailbox',-3.8,z);add('wheelie-bin',-4.8,z+1.3);add('low-wall',5,z,90);}
  add('carport',-9,6);add('shade',-9,-11);add('sapling',3.3,-12);add('ornamental',8,12);add('streetlight',3.5,20);
 }else if(kind==='market-encounter'){
  for(const z of [-10,0,10]){add('market-stall',-7,z,90);add('crate',-6,z+2.5);add('sandwich-board',-3.2,z+1);}
  add('bus-shelter',7,1,270);add('bench',8,-10);add('planter',4,-12);add('planter',4,12);add('dumpster',-10,15);add('street',10,14);add('ornamental',8,-17);add('bike-rack',3.8,19);
 }else{
  add('scaffold',-7,-6);add('billboard',7,4,270);add('dumpster',-7,10);add('road-barrier',4,-13,90);add('hydrant',3.5,18);
  for(let i=0;i<3;i++){add('pallet',-6.6+i*1.6,0);add('crate',-6.6+i*1.6,0,0,.14);add('crate',-6.6+i*1.6,2);}
  add('pallet',-7,-6,0,2.51);add('crate',-7,-6,0,2.65);add('conifer',11,16);
 }
 return finish(placements,`outdoor-${kind}`,{hero:{position:[30,24,-35],target:[0,1,0]},street:{position:[0,1.7,-25],target:[0,1.4,8]},reverse:{position:[-23,12,28],target:[0,2,0]}},
  {route:[{name:'lane-entry',at:[0,0,-23]},{name:'lane-exit',at:[0,0,23]}],gameplay:{laneWidth:5,encounter:kind}});
}

const boxOverlap=([a,b],[c,d],eps=.001)=>a.every((x,k)=>Math.min(b[k],d[k])-Math.max(x,c[k])>eps);
/** Conservative segment/expanded-box test protects the full existing route. */
export function routeBlocked(bounds,route,clearance=1.05){
 const [lo,hi]=bounds;
 for(let j=1;j<route.length;j++){
  const a=route[j-1].at,b=route[j].at;let enter=0,exit=1;
  if(hi[1]<=Math.min(a[1],b[1])+.1)continue; // walkable pavement / buried footings
  for(let k=0;k<3;k++){
   const low=lo[k]-(k===1?2.1:clearance),high=hi[k]+(k===1?0:clearance),d=b[k]-a[k];
   if(Math.abs(d)<1e-9){if(a[k]<low||a[k]>high){enter=2;break;}}
   else {const t0=(low-a[k])/d,t1=(high-a[k])/d;enter=Math.max(enter,Math.min(t0,t1));exit=Math.min(exit,Math.max(t0,t1));}
  }
  if(enter<=exit)return true;
 }
 return false;
}
function nodeBounds(pack){const s=pack.scenario;return s.nodes.map((n,i)=>boundsFor(n,s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i]));}

export function buildDressedBayline(){
 const base=buildBaylineCivicTown(),placements=[{pack:base.pack}],existing=nodeBounds(base.pack),added=[];
 // Spatial buckets include terrain: installed props cannot occupy buried paving.
 const grid=new Map(),cells=([lo,hi])=>{const keys=[];for(let x=Math.floor(lo[0]/4);x<=Math.floor(hi[0]/4);x++)for(let z=Math.floor(lo[2]/4);z<=Math.floor(hi[2]/4);z++)keys.push(`${x},${z}`);return keys;};
 const insert=bounds=>{for(const b of bounds)for(const key of cells(b)){const list=grid.get(key)??[];list.push(b);grid.set(key,list);}};insert(existing);
 let rejected=0;
 for(const [i,lot]of base.metadata.instances.entries()){
  const x=lot.position[0],z=lot.position[2],side=Math.sign(z-lot.roadZ)||1;
  const residential=lot.zone==='garden';
  const candidates=residential?[[TREE_FAMILIES[i%5],x+7.8,z],[ 'mailbox',x-3,z-side*8.8],['wheelie-bin',x+3.5,z-side*7.8]]:
   [['dumpster',x+4,z+side*8],['crate',x+2,z+side*8],['streetlight',x+8,z-side*8],['sandwich-board',x-2,z-side*7]];
  for(const [type,px,pz]of candidates){
   // Town density uses one baked template per family; all fifteen variants remain
   // available in the gallery. Shared structural shapes matter as much as leaves.
   const asset=outdoorAsset(type,0),position=[px,0,pz],candidate=composeScene([{pack:asset.pack,position}]),bounds=nodeBounds(candidate);
   if(bounds.some(b=>routeBlocked(b,base.metadata.route)||cells(b).some(key=>(grid.get(key)??[]).some(c=>boxOverlap(b,c))))){rejected++;continue;}
   const id=`dressing-${added.length}`,nodeStart=base.pack.scenario.nodes.length+added.reduce((n,a)=>n+a.nodeCount,0);
   placements.push({...asset,position,group:`${type}@${id}`});insert(bounds);added.push({id,type,position,nodeStart,nodeCount:asset.pack.scenario.nodes.length,lot:lot.id});
  }
 }
 const result=finish(placements,'bayline-outdoor-town',{...base.metadata.cameras,
  'garden-dressing':{position:[-137,5,2],target:[-120,2,17]},'street-dressing':{position:[-15,5,-48],target:[10,2,-70]}},
  {...base.metadata,dressing:{added,rejected},acceptance:{readyForRelease:false,note:'New dressed scene; native qualification pending.'}});
 result.metadata.cameras={...base.metadata.cameras,'garden-dressing':{position:[-62,6,2],target:[-47,3,18]},'street-dressing':{position:[-15,5,-48],target:[10,2,-70]}};
 result.baseline={pack:base.pack,metadata:base.metadata};
 return result;
}
