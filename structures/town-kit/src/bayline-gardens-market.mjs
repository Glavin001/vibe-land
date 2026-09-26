import {buildBaylineTown,placementPoint} from './bayline-town.mjs';
import {buildOutdoorProp,OUTDOOR_PROP_TYPES} from './outdoor-props.mjs';
import {buildTree} from './tree.mjs';
import {buildProp} from './props.mjs';
import {composeScene} from './geometry.mjs';
import {composeVisuals,assetHash} from './outdoor-visuals.mjs';
import {ballisticRound} from '../scripts/cannon.mjs';
import {PLAYGROUND_CANNON} from './playground-config.mjs';
import {clearTourSightlines} from './tour-sightlines.mjs';
import {dressTownProp} from './town-dressing-visuals.mjs';

export const GARDENS_MARKET_KEY='bayline-town-with-gardens-and-market';

/** A separate authored fork of the original six-building Main Street. */
export function buildBaylineGardensMarket(){
 const base=buildBaylineTown(),placements=[{pack:base.pack}],dressing=[],chapters=[];
 let offset=base.pack.scenario.nodes.length;
 const add=(type,x,z,{yaw=0,variant=0,zone='street',demo=false,y=0}={})=>{
  const tree=['shade','street','ornamental'].includes(type);
  const asset=tree?buildTree({family:type,variant}):dressTownProp(OUTDOOR_PROP_TYPES.includes(type)?buildOutdoorProp(type):buildProp(type),type,dressing.length);
  const placement={...asset,position:[x,y,z],yaw,group:`${type}@gardens-market-${dressing.length}`};
  const item={type,variant,zone,position:placement.position,yaw,nodeStart:offset,nodeCount:asset.pack.scenario.nodes.length};
  dressing.push(item);placements.push(placement);offset+=item.nodeCount;
  if(demo){
   let target=tree?asset.metadata.shots.collapse[0].to:asset.metadata.shots.furniture[0].to;
   if(type==='low-wall')target=[0,.6,0];
   if(type==='market-stall')target=[0,.985,-.6];
   if(type==='bus-shelter')target=[-.9,1.2,1.3];
   if(type==='road-barrier')target=[-1,.72,0];
   if(type==='bike-rack')target=[-1,.55,0];
   const from=[target[0],Math.max(1.65,target[1]),target[2]-6];
   const point=p=>placementPoint(p,placement),at=point(target),origin=point(from);
   const heavy=['bus-shelter','dumpster','road-barrier'].includes(type);
   const shot=ballisticRound({from:origin,to:at,mass:heavy?2000:PLAYGROUND_CANNON.massKg,speed:heavy?35:PLAYGROUND_CANNON.speedMps});
   const direction=[at[0]-origin[0],0,at[2]-origin[2]],length=Math.hypot(...direction);
   chapters.push({...item,title:type.replaceAll('-',' '),shots:tree&&type==='street'?3:2,shot,
    camera:{position:[origin[0]+direction[2]/length*2,origin[1]+1.4,origin[2]-direction[0]/length*2],target:[at[0],tree?at[1]+1.2:at[1],at[2]]}});
  }
 };
 // Juniper's occupied garden: a shaded seat, carport and everyday clutter.
 add('mailbox',-35.8,7.4,{zone:'Juniper garden',demo:true});
 add('wheelie-bin',-29.3,7.3,{zone:'Juniper garden',demo:true});
 add('carport',-44,16,{zone:'Juniper garden',demo:true});
 add('shade',-44,27,{zone:'Juniper garden',demo:true});
 add('bench',-33,26,{zone:'Juniper garden',demo:true});
 add('low-wall',-38,29,{zone:'Juniper garden',demo:true});
 add('low-wall',-34.6,29,{zone:'Juniper garden'});
 add('planter',-30,26,{zone:'Juniper garden',demo:true});
 // The pocket market occupies the open southwest corner, facing Main Street.
 add('market-stall',-42,-15,{yaw:180,zone:'Garden market',demo:true});
 add('market-stall',-33,-15,{yaw:180,zone:'Garden market'});
 add('crate',-39,-17.8,{zone:'Garden market',demo:true});
 add('crate',-31,-18,{zone:'Garden market'});
 add('sandwich-board',-36,-9,{yaw:180,zone:'Garden market',demo:true});
 add('table',-40,-23,{zone:'Garden market',demo:true});
 add('chair',-40,-24,{zone:'Garden market',demo:true});add('chair',-40,-22,{yaw:180,zone:'Garden market'});
 add('table',-33,-23,{zone:'Garden market'});
 add('chair',-33,-24,{zone:'Garden market'});add('chair',-33,-22,{yaw:180,zone:'Garden market'});
 add('ornamental',-26,-27,{variant:1,zone:'Garden market',demo:true});
 add('planter',-29,-10,{zone:'Garden market'});
 add('bus-shelter',-44,-8,{yaw:180,zone:'Market bus stop',demo:true});
 add('bollard',-48.5,-7.3,{zone:'Market bus stop',demo:true});
 add('bollard',-39.5,-7.3,{zone:'Market bus stop'});
 add('streetlight',-49,-11,{zone:'Market bus stop',demo:true});
 add('street-sign',-6.7,8.5,{zone:'Crossroads',demo:true});
 add('streetlight',-23,7.3,{zone:'Cafe frontage'});
 add('streetlight',23,-7.3,{zone:'Grocery frontage'});
 add('bike-rack',24.5,-10,{zone:'Grocery frontage',demo:true});
 add('hydrant',22.2,-7.5,{zone:'Grocery frontage',demo:true});
 add('street',25,-27,{zone:'Amber garden',demo:true});
 add('mailbox',30.6,-7.8,{yaw:180,zone:'Amber garden'});
 add('wheelie-bin',37,-9,{zone:'Amber garden'});
 add('planter',40,-12,{zone:'Amber garden'});
 add('bench',33,-27,{yaw:180,zone:'Amber garden'});
 add('ornamental',-24,-20,{variant:1,zone:'Willow garden'});
 add('mailbox',-17,-7.8,{yaw:180,zone:'Willow garden'});
 add('wheelie-bin',-10.5,-8.4,{zone:'Willow garden'});
 // Workshop work yard: believable loose materials and temporary structures.
 add('scaffold',25,15,{zone:'Foundry yard',demo:true});
 add('dumpster',25,23,{zone:'Foundry yard',demo:true});
 add('pallet',31,21,{zone:'Foundry yard',demo:true});
 add('pallet',33,21,{zone:'Foundry yard'});
 add('crate',31,23,{zone:'Foundry yard'});add('crate',33,23,{zone:'Foundry yard'});
 add('road-barrier',39,27,{zone:'Foundry yard',demo:true});
 add('billboard',43,10,{yaw:180,zone:'Foundry yard',demo:true});
 add('streetlight',23,7.4,{zone:'Foundry yard'});
 add('shade',43,30,{zone:'Foundry yard'});
 const house=base.metadata.instances.find(i=>i.id==='juniper-house');
 const local=house.shots.wall[0].to,target=placementPoint(local,house),from=[target[0]-6,Math.max(1.65,target[1]),target[2]];
 chapters.push({title:'Juniper house · brickwork',type:'house',zone:'Juniper garden',nodeStart:house.nodeStart,nodeCount:house.nodeCount,shots:3,
  shot:ballisticRound({from,to:target,mass:PLAYGROUND_CANNON.massKg,speed:PLAYGROUND_CANNON.speedMps}),camera:{position:[from[0]-2,3.5,from[2]-3],target}});
 const pack=composeScene(placements,{key:GARDENS_MARKET_KEY,title:'Bayline Town with Gardens & Market'});
 // Hit the loose dumpster before nearby scaffold debris can roll it away.
 const dumpster=chapters.splice(chapters.findIndex(c=>c.type==='dumpster'),1)[0];chapters.splice(chapters.findIndex(c=>c.type==='scaffold'),0,dumpster);
 // Film the cafe furniture last, after the street-fixture chapters.
 const furniture=chapters.filter(c=>['table','chair'].includes(c.type));
 for(const c of furniture)chapters.splice(chapters.indexOf(c),1);
 chapters.splice(chapters.length-1,0,...furniture);
 clearTourSightlines(pack,chapters);
 const shots=[];let tick=180;
 for(const c of chapters){c.startTick=tick-45;for(let i=0;i<c.shots;i++)shots.push({...c.shot,tick:tick+i*75});c.endTick=tick+c.shots*75+135;tick=c.endTick+45;}
 const {protectedGroups,instances,...rest}=base.metadata;
 const metadata={...rest,kind:'scene',buildingType:'town',sceneLayout:true,
  sourceScene:{key:base.pack.key,sha256:assetHash(base.pack)},instances:instances.map(({sourcePack,shots,shotGroups,...i})=>i),
  dressing,shots:{cannon:shots},shotGroups:{},cannonTour:{chapters,cannon:PLAYGROUND_CANNON},
  cameras:{...base.metadata.cameras,hero:{position:[-71,48,-64],target:[-2,2,0]},market:{position:[-53,8,-1],target:[-37,1.6,-18]},gardens:{position:[-53,10,0],target:[-35,2.5,19]},yard:{position:[49,8,2],target:[29,2,20]} }};
 return {pack,metadata,visuals:composeVisuals(placements,pack),placements};
}
