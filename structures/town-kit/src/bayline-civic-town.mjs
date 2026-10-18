import {createHash} from 'node:crypto';
import {buildBaylineSmallTown} from './bayline-small-town.mjs';
import {buildNeighborhoodLibrary} from './neighborhood-library.mjs';
import {buildArtDecoCinema} from './art-deco-cinema.mjs';
import {buildFireStation} from './fire-station.mjs';
import {Builder,composeScene,boundsFor} from './geometry.mjs';
import {placementPoint} from './bayline-town.mjs';
import {M} from './materials.mjs';
export const CIVIC_TOWN_KEY='bayline-civic-town';
const sha=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
const civicLots=[
 {id:'civic-library',builder:'library',build:buildNeighborhoodLibrary,position:[-70,0,38],yaw:180,roadZ:56,options:{palette:'sage'},path:{halfWidth:3,end:47.4}},
 {id:'civic-cinema',builder:'cinema',build:buildArtDecoCinema,position:[-50,0,38],yaw:180,roadZ:56,options:{palette:'cream'},path:{halfWidth:2.3,end:47}},
 {id:'civic-fire-station',builder:'fire-station',build:buildFireStation,position:[60,0,38],yaw:180,roadZ:56,options:{palette:'rose'},path:{halfWidth:7,end:45}},
];
const transformBounds=(bounds,lot)=>{const p=bounds.map(v=>placementPoint(v,lot));return [p[0].map((v,k)=>Math.min(v,p[1][k])),p[0].map((v,k)=>Math.max(v,p[1][k]))];};
/** Add a furnished civic promenade to the existing independent 64-lot town. */
export function buildBaylineCivicTown({furnished=true,seed=20260920,assemble=true,resolveAsset=(_name,_options,build)=>build()}={}){
 const base=buildBaylineSmallTown({furnished,seed,assemble,resolveAsset}),m=structuredClone(base.metadata),placements=assemble?[{pack:base.pack}]:[...base.placements],templates=[...base.templates];
 const paving=new Builder('civic-town-forecourts',{group:'terrain'});
 const pavingMaterial=paving.table.push({...paving.table[M.footing],name:'town-paving',color:'#bcb29e',textureKey:'concrete-wall',roughness:1})-1;
 let offset=base.placements.reduce((n,p)=>n+p.pack.scenario.nodes.length,0);
 const last=m.route.at(-1).at;
 m.route.push({name:'civic-promenade/avenue-turn',at:[90,0,last[2]]},{name:'civic-promenade/avenue-arrival',at:[90,0,56]});
 for(const {build,path,...lot}of civicLots){
  const opts={...lot.options,furnished,seed},asset=resolveAsset(lot.builder,opts,()=>build(opts)),a=asset.metadata,pack=assemble?structuredClone(asset.pack):asset.pack,point=p=>placementPoint(p,lot),s=pack.scenario;
  const templateKey=JSON.stringify([lot.builder,{...lot.options,furnished}]),hash=asset.hash??sha(pack);
  templates.push({key:templateKey,...asset,hash});
  if(assemble)s.nodeGroups=s.nodeGroups.map(g=>`${g}@${lot.id}`);
  placements.push({pack,position:lot.position,yaw:lot.yaw,...(!assemble?{groupSuffix:`@${lot.id}`}:{})});
  const bounds=s.nodes.map((n,i)=>boundsFor(n,s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i]));
  const local=[0,1].map(end=>[0,1,2].map(k=>(end?Math.max:Math.min)(...bounds.map(b=>b[end][k]))));
  m.instances.push({...lot,zone:'civic-promenade',templateKey,options:a.options,sourceSha256:hash,nodeStart:offset,nodeCount:s.nodes.length,bondCount:s.bonds.length,bounds:transformBounds(local,lot)});offset+=s.nodes.length;
  m.rooms.push(...a.rooms.map(r=>({...r,name:`${lot.id}/${r.name}`,instance:lot.id,bounds:transformBounds(r.bounds,lot)})));
  m.entrances.push(...a.entrances.map(e=>({...e,name:`${lot.id}/${e.name}`,instance:lot.id,at:point(e.at)})));
  const start=point(a.route[0].at);
  m.route.push({name:`${lot.id}/road`,at:[start[0],0,56]},{name:`${lot.id}/sidewalk`,at:[start[0],0,51]});
  m.route.push(...a.route.map(p=>({...p,name:`${lot.id}/${p.name}`,at:point(p.at)})));
  // Retrace the authored walk to the front instead of cutting through a wall.
  m.route.push(...a.route.slice(0,-1).reverse().map(p=>({...p,name:`${lot.id}/return-${p.name}`,at:point(p.at)})));
  m.route.push({name:`${lot.id}/return-sidewalk`,at:[start[0],0,51]},{name:`${lot.id}/return-road`,at:[start[0],0,56]});
  for(const [name,c]of Object.entries(a.cameras))m.cameras[`${lot.id}-${name}`]={position:point(c.position),target:point(c.target)};
  // Cinema's central path passes between the marquee's independently anchored posts.
  const x=lot.position[0],split=[Math.ceil(path.halfWidth*2/3),1,Math.ceil((50-path.end)/3)];
  paving.box({min:[x-path.halfWidth,-.15,path.end],max:[x+path.halfWidth,0,50],material:M.footing,type:'foundation',fixed:true,split});
  paving.box({min:[x-path.halfWidth,0,path.end],max:[x+path.halfWidth,.06,50],material:pavingMaterial,type:'paving',split});
 }
 placements.push({pack:paving.build()});
 const pack=assemble?composeScene(placements,{key:CIVIC_TOWN_KEY,title:'Bayline · Civic town'}):null;
 m.cameras={...m.cameras,
  hero:{position:[214,220,236],target:[0,0,9]},
  aerial:{position:[-195,235,219],target:[0,0,9]},
  'civic-promenade':{position:[-84,7,62],target:[-49,2.9,42]},
  'library-and-cinema':{position:[-61,10,75],target:[-60,2,39]},
  'fire-station-street':{position:[78,6.5,63],target:[59,3.3,38]},
  'civic-neighborhood':{position:[-112,52,101],target:[-39,1,35]},
 };
 m.preview={fogNear:560,fogFar:850};
 m.composition={...m.composition,buildings:m.instances.length,templateCount:templates.length,buildingFamilies:9,zones:m.instances.reduce((a,i)=>(a[i.zone]=(a[i.zone]??0)+1,a),{}),storeyCounts:m.instances.reduce((a,i)=>(a[i.options.storeys]=(a[i.options.storeys]??0)+1,a),{})};
 m.acceptance={readyForRelease:false,note:'Independent 67-building visual composition. Whole-town native stability, traversal and destruction gates have not passed. Individual civic review limitations remain documented in CIVIC-BUILDINGS.md. This scene does not change /city.'};
 return {pack,metadata:m,templates,placements};
}
