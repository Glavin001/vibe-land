import { Builder, nativeColliders } from './geometry.mjs';
import { M } from './materials.mjs';
export const PROP_TYPES=['table','chair','counter','sink','hob','cabinet','shelf','refrigerator','bed','sofa','toilet','bathtub','fence','gate'];
export function buildPropRaw(type,{palette='sage',seed=20260920,omitLeftPost=false}={}) {
 if(!PROP_TYPES.includes(type))throw Error(`Unknown prop ${type}`);
 const b=new Builder(`town-${type}`,{palette,seed,group:`prop-${type}`});
 // A chair's narrower mortise uses half the effective glue/dowel area of
 // the general furniture connection. Solid wood fracture seams are unchanged.
 if(type==='chair'){
  const joint=b.table[M.furnitureJoint];joint.name='chair-mortise-joint';
  for(const key of ['compressionElastic','compressionFatal','tensionElastic','tensionFatal','shearElastic','shearFatal'])joint[key]*=.5;
 }
 const box=(min,max,m=M.oak,role=type,split=[1,1,1])=>b.box({min,max,material:m,type:role,split});
 if(type==='table') {
  box([-.8,.735,-.425],[.8,.795,.425],M.oak,'table-top',[2,1,2]);
  for(const x of [-.69,.69])for(const z of [-.315,.315])box([x-.05,0,z-.05],[x+.05,.735,z+.05],M.oak,'table-leg',[1,2,1]);
 } else if(type==='chair') {
  box([-.25,.415,-.25],[.25,.46,.25],M.oak,'chair-seat',[2,1,1]);
  for(const x of [-.205,.205])for(const z of [-.205,.205])box([x-.02,0,z-.02],[x+.02,.415,z+.02],M.oak,'chair-leg',[1,2,1]);
  for(const x of [-.205,.205])box([x-.035,.46,.18],[x+.035,.90,.25],M.oak,'chair-back-post');
  box([-.17,.67,.20],[.17,.88,.245],M.oak,'chair-back',[2,1,1]);
 } else if(type==='shelf') {
  // An open, symmetric oak rack. Shelves meet the inner faces of four posts.
  for(const x of [-.60,.52])for(const z of [-.30,.22])box([x,0,z],[x+.08,1.82,z+.08],M.oak,'shelf-post',[1,2,1]);
  for(const y of [.15,.66,1.17,1.77])box([-.52,y,-.30],[.52,y+.05,.30],M.oak,'shelf-board',[2,1,1]);
 } else if(['counter','sink','hob','cabinet','refrigerator'].includes(type)) {
  const h=type==='cabinet'||type==='shelf'?1.75:type==='refrigerator'?1.8:.88;
  const m=type==='refrigerator'?M.appliance:M.dark;
  box([-.6,.06,.26],[.6,h,.30],m,`${type}-back`,type==='shelf'?[1,2,1]:[2,2,1]);
  for(const x of [-.6,.56])box([x,0,-.30],[x+.04,h,.26],m,`${type}-side`,[1,2,1]);
  box([-.56,type==='shelf'?0:.06,-.3],[.56,.10,.26],m);
  if(type==='shelf') {
   for(const y of [.45,.9,1.35])box([-.56,y,-.3],[.56,y+.035,.26],M.oak);
  } else {
   for(const x of [-.555,.015])box([x,.11,-.3],[x+.54,h-.065,-.265],m,`${type}-front`,[1,2,1]);
   for(const [x0,x1] of [[-.56,-.555],[.555,.56]])for(const y of [.20,h-.25])box([x0,y,-.30],[x1,y+.08,-.265],M.metal,'cabinet-hinge');
   for(const x of [-.07,.07])box([x-.015,h*.62,-.345],[x+.015,h*.62+.14,-.30],M.metal,'handle');
  }
  const tm=type==='refrigerator'?M.appliance:M.oak;
  if(type==='sink') {
   box([-.6,h,-.32],[-.3,h+.055,.32],tm);box([.3,h,-.32],[.6,h+.055,.32],tm);
   box([-.3,h,-.32],[.3,h+.055,-.20],tm);box([-.3,h,.20],[.3,h+.055,.32],tm);
   box([-.30,h-.14,-.20],[.30,h-.10,.20],M.ceramic,'sink-basin');
   for(const x of [-.30,.27])box([x,h-.10,-.20],[x+.03,h+.055,.20],M.ceramic);
   for(const z of [-.20,.17])box([-.27,h-.10,z],[.27,h+.055,z+.03],M.ceramic);
   box([-.025,h+.055,.24],[.025,h+.27,.29],M.metal,'tap');box([-.025,h+.24,.10],[.025,h+.27,.24],M.metal,'tap');
  } else box([-.6,h,-.32],[.6,h+.055,.32],tm,`${type}-top`,[2,1,1]);
  if(type==='hob')for(const x of [-.29,.29])for(const z of [-.13,.13])box([x-.105,h+.055,z-.09],[x+.105,h+.069,z+.09],M.metal,'hob-ring');
 } else if(type==='bed') {
  for(const x of [-.69,.69])for(const z of [-.90,.90])box([x-.055,0,z-.055],[x+.055,.26,z+.055],M.oak,'bed-leg',[1,2,1]);
  for(const x of [-.8,.64])box([x,.26,-1.05],[x+.16,.35,1.05],M.oak,'bed-rail',[1,1,3]);
  for(const z of [-1.05,.89])box([-.64,.26,z],[.64,.35,z+.16],M.oak,'bed-rail',[2,1,1]);
  for(const z of [-.5,-.05,.4])box([-.64,.30,z],[.64,.35,z+.14],M.oak,'bed-slat',[2,1,1]);
  box([-.78,.35,-1.04],[.78,.54,.95],M.bedding,'mattress',[2,1,2]);
  box([-.8,.35,.99],[.8,1.05,1.05],M.oak,'headboard',[2,2,1]);
  for(const x of [-.40,.40])box([x-.32,.54,.38],[x+.32,.66,.87],M.bedding,'pillow');
 } else if(type==='toilet') {
  box([-.16,0,-.26],[.16,.025,.36],M.ceramic,'toilet-foot');
  for(const x of [-.16,.135])box([x,.025,-.26],[x+.025,.20,.36],M.ceramic,'toilet-pedestal');
  for(const z of [-.26,.335])box([-.135,.025,z],[.135,.20,z+.025],M.ceramic,'toilet-pedestal');
  box([-.22,.20,-.31],[.22,.26,.29],M.ceramic,'toilet-bowl-base',[1,1,2]);
  for(const x of [-.22,.18])box([x,.26,-.31],[x+.04,.43,.22],M.ceramic,'toilet-bowl-side');
  box([-.18,.26,-.31],[.18,.43,-.27],M.ceramic,'toilet-bowl-front');
  for(const z of [.22,.368])box([-.20,.26,z],[.20,.82,z+.022],M.ceramic,'toilet-cistern',[1,2,1]);
  for(const x of [-.20,.178])box([x,.26,.242],[x+.022,.82,.368],M.ceramic,'toilet-cistern');
  box([-.178,.26,.242],[.178,.28,.368],M.ceramic,'toilet-cistern-base');
  box([-.20,.82,.22],[.20,.845,.39],M.ceramic,'toilet-cistern-lid');
  for(const x of [-.225,.17])box([x,.43,-.315],[x+.055,.46,.22],M.trim,'toilet-seat');
  box([-.17,.43,-.315],[.17,.46,-.26],M.trim,'toilet-seat');
 } else if(type==='bathtub') {
  box([-.38,0,-.80],[.38,.07,.80],M.ceramic,'tub-base',[1,1,2]);
  for(const x of [-.38,.345])box([x,.07,-.8],[x+.035,.54,.8],M.ceramic,'tub-side');
  for(const z of [-.8,.765])box([-.345,.07,z],[.345,.54,z+.035],M.ceramic,'tub-end');
  box([-.025,.54,.765],[.025,.70,.80],M.metal,'tub-tap');
  box([-.025,.67,.62],[.025,.70,.765],M.metal,'tub-tap');
 } else if(type==='sofa') {
  for(const x of [-.83,.83])for(const z of [-.3,.3])box([x-.04,0,z-.04],[x+.04,.18,z+.04],M.oak,'sofa-leg');
  box([-1,.18,-.45],[1,.28,.45],M.oak,'sofa-frame',[3,1,1]);
  for(const x of [-1,.88])box([x,.28,-.45],[x+.12,.65,.45],M.fabric,'sofa-arm',[1,2,1]);
  box([-.88,.28,.32],[.88,.87,.45],M.fabric,'sofa-back',[3,1,1]);
  for(let i=0;i<3;i++)box([-.88+i*1.76/3,.28,-.45],[-.88+(i+1)*1.76/3,.48,.32],M.fabric,'sofa-cushion');
 } else {
  const gate=type==='gate';
  for(const x of gate?[-1.2]:(omitLeftPost?[1.2]:[-1.2,1.2])){
   b.box({min:[x-.09,-.35,-.09],max:[x+.09,0,.09],material:M.footing,type:'foundation',fixed:true});
   box([x-.075,0,-.075],[x+.075,1.12,.075],M.trim,'fence-post',[1,2,1]);
   box([x-.10,1.12,-.10],[x+.10,1.17,.10],M.trim,'post-cap');
  }
  const fence=new Builder('section',{palette,group:`prop-${type}`});
  const fb=(min,max,role,split=[1,1,1])=>fence.box({min,max,material:M.trim,type:role,split});
  for(const y of [.25,.78])fb([-1.125,y,-.04],[1.125,y+.075,.04],'fence-rail',[3,1,1]);
  for(let i=0;i<12;i++){
   const x=-1.035+i*.188;
   fb([x-.055,.10,-.075],[x+.055,.96,-.04],'picket',[1,2,1]);
   fence.piece({axis:'z',lo:-.075,hi:-.04,poly:[[x-.055,.96],[x+.055,.96],[x,1.06]],material:M.trim,type:'picket-tip'});
  }
  // Rotate an open gate about its hinge, authoring its actual open collision.
  for(const p of fence.prisms){
   if(!gate)b.piece({...p,material:M.trim,type:'fence'});
   else {
    // Source extrudes Z except boxes, which extrude Y. Transform its vertices
    // by rotating its defining 2D section in the appropriate plane.
    if(p.axis==='y')b.piece({axis:'y',lo:p.lo,hi:p.hi,poly:p.poly.map(([x,z])=>[-1.125+z,x+1.20]),material:M.trim,type:'gate'});
    else b.piece({axis:'x',lo:-1.125+p.lo,hi:-1.125+p.hi,poly:p.poly.map(([x,y])=>[y,x+1.20]),material:M.trim,type:'gate'});
   }
  }
 }
 const target={table:[.55,.765,-.22],chair:[.18,.44,-.18],counter:[.48,.91,-.2],sink:[.45,.91,0],hob:[.48,.91,-.2],cabinet:[.48,1.78,-.2],shelf:[0,1.80,0],refrigerator:[.48,1.83,-.2],bed:[0,.30,-.75],sofa:[0,.22,-.35],toilet:[0,.23,0],bathtub:[.36,.4,-.55],fence:[0,.82,0],gate:[-1.125,.82,1.2]}[type];
 const stronger=['table','chair','counter','hob','cabinet','refrigerator','bathtub'].includes(type);
 const shot=type==='bathtub'?{from:[0,.35,-1.9],to:[0,.35,-.78],momentum:100000,radius:.25,speed:25,tick:0}:type==='chair'?{from:[0,1.5,0],to:[0,.44,0],momentum:40000,radius:.3,speed:36,tick:0}:{from:[target[0],target[1]+.85,target[2]],to:target,momentum:stronger?40000:20000,radius:stronger?.35:.25,speed:stronger?(['counter','hob'].includes(type)?30:40):25,tick:0};
 return {pack:b.build(),metadata:{kind:'prop',type,route:[],shots:{furniture:[shot],fence:[shot]},shotGroups:{furniture:`prop-${type}`,fence:`prop-${type}`}}};
}
// Public props use final native colliders; the building assembles raw props
// first so fixture attachment uses the original exact touching box faces.
export function buildProp(type,options){const result=buildPropRaw(type,options);if(type==='counter'||type==='bathtub')result.pack=nativeColliders(result.pack);return result;}
export const buildTable=o=>buildProp('table',o);
export const buildChair=o=>buildProp('chair',o);
export const buildFence=o=>buildProp('fence',o);
