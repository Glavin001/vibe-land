import {Builder} from './geometry.mjs';
import {M} from './materials.mjs';

export const OUTDOOR_PROP_TYPES = [
 'mailbox','wheelie-bin','dumpster','bench','planter','streetlight','street-sign',
 'bike-rack','hydrant','pallet','crate','sandwich-board','low-wall','bollard',
 'road-barrier','bus-shelter','market-stall','carport','scaffold','billboard',
];

// Effective bond thresholds, measured with the playground's 500 kg / 25 m/s
// round. The dumpster already sheds panels; weakening its wheel joints makes
// it break while settling. Glass clips likewise need their full rest strength.
function fractureSeamScale(type,name){
 if(type==='dumpster')return 1;
 if(type==='road-barrier'&&/footing/.test(name))return .00003;
 if(/steel|hydrant/.test(name))return .001;
 if(/footing/.test(name))return .003;
 if(/masonry/.test(name))return .03;
 if(/timber-joint/.test(name))return ['pallet','crate','sandwich-board','market-stall'].includes(type)?.02:.2;
 if(/glass|glazing/.test(name))return 1;
 if(/plastic/.test(name))return .1;
 return .02;
}

/** Physical seams are authored faces, not an intact mesh hiding a collider. */
export function buildOutdoorProp(type,{palette='sage',seed=20260925}={}) {
 if(!OUTDOOR_PROP_TYPES.includes(type))throw Error(`Unknown outdoor prop ${type}`);
 const group=`outdoor-${type}`,b=new Builder(group,{palette,seed,group});
 const material=(source,name,color,density,extra={})=>b.table.push({...b.table[source],name,color,density,...extra})-1;
 const steel=material(M.metal,'painted-outdoor-steel','#526a60',7850,{metalness:.4,roughness:.6});
 const plastic=material(M.appliance,'bin-plastic','#3c584b',950,{metalness:0,roughness:.9});
 const stone=material(M.brick,'garden-masonry','#aa947c',1900);
 const rubber=material(M.fabric,'rubber','#303933',800);
 const red=material(M.metal,'hydrant-red','#a54c37',7200);
 const wood=M.frame;
 const box=(min,max,m=wood,role=type,split=[1,1,1])=>b.box({min,max,material:m,type:role,split});
 const footing=(x,z,r=.15)=>b.box({min:[x-r,-.35,z-r],max:[x+r,0,z+r],material:M.footing,type:'foundation',fixed:true});
 const post=(x,z,h,r=.06,m=wood,anchored=false)=>{if(anchored)footing(x,z,r+.06);box([x-r,0,z-r],[x+r,h,z+r],m,'support',[1,3,1]);};
 const shell=(w,d,h,m,base=.08)=>{
  const t=.025;
  box([-w,base,-d],[w,base+t,d],m,'base',[2,1,1]);
  for(const x of [-w,w-t])box([x,base+t,-d],[x+t,h,d],m,'side',[1,2,1]);
  for(const z of [-d,d-t])box([-w+t,base+t,z],[w-t,h,z+t],m,'panel',[2,2,1]);
  box([-w,h,-d],[w,h+.035,d],m,'lid',[2,1,1]);
 };
 if(type==='mailbox'){
  post(0,0,.95,.055,wood,true);shell(.25,.19,1.23,steel,.95);
  box([.25,1.09,-.07],[.27,1.37,-.035],red,'mail-flag');
 }else if(type==='wheelie-bin'||type==='dumpster'){
  const big=type==='dumpster',w=big?.95:.29,d=big?.55:.32,h=big?1.25:.95;
  shell(w,d,h,big?steel:plastic,.12);
  for(const x of [-w+.08,w-.08])for(const z of [-d+.08,d-.08])box([x-.05,0,z-.06],[x+.05,.12,z+.06],rubber,'wheel');
  box([-w+.08,h+.035,d-.09],[w-.08,h+.075,d-.04],steel,'handle');
 }else if(type==='bench'){
  for(const x of [-.75,.75]){
   for(const z of [-.22,.22])post(x,z,.43,.04,steel);
   box([x-.055,.43,-.29],[x+.055,.48,.29],steel,'seat-rail');
   box([x-.04,.48,.25],[x+.04,1.02,.31],steel,'back-post');
  }
  for(const z of [-.29,-.10,.09])box([-.96,.48,z],[.96,.53,z+.15],wood,'seat-slat',[3,1,1]);
  for(const y of [.65,.85])box([-.96,y,.31],[.96,y+.14,.36],wood,'back-slat',[3,1,1]);
 }else if(type==='planter'){
  box([-.65,0,-.5],[.65,.1,.5],stone,'base',[2,1,2]);
  for(const x of [-.65,.54])box([x,.1,-.5],[x+.11,.65,.5],stone,'planter-wall',[1,2,2]);
  for(const z of [-.5,.39])box([-.54,.1,z],[.54,.65,z+.11],stone,'planter-wall',[3,2,1]);
 }else if(type==='streetlight'||type==='street-sign'||type==='hydrant'||type==='bollard'){
  const h={streetlight:4.4,'street-sign':2.25,hydrant:.8,bollard:.85}[type];
  const r=type==='hydrant'?.12:.055;post(0,0,h,r,type==='hydrant'?red:steel,true);
  if(type==='streetlight'){
   box([-.30,h,-.3],[.30,h+.07,.3],steel,'lamp-base');
   box([-.22,h+.07,-.22],[.22,h+.40,.22],M.glass,'lamp-glass',[2,1,2]);
   box([-.30,h+.40,-.3],[.30,h+.47,.3],steel,'lamp-cap');
  }else if(type==='street-sign')box([-.42,h-.35,-.085],[.42,h+.15,-.055],steel,'sign',[2,2,1]);
  else if(type==='hydrant')for(const x of [-.26,.12])box([x,.42,-.075],[x+.14,.57,.075],red,'hydrant-nozzle');
 }else if(type==='bike-rack'){
  for(const x of [-1,-.35,.35,1]){post(x,0,.72,.035,steel,true);box([x-.035,.72,-.035],[x+.035,.79,.42],steel,'rack-arm');box([x-.035,0,.35],[x+.035,.72,.42],steel,'rack-leg');}
 }else if(type==='pallet'){
  for(const z of [-.45,0,.45])box([-.6,0,z-.045],[.6,.10,z+.045],wood,'runner',[2,1,1]);
  for(const x of [-.6,-.36,-.12,.12,.36])box([x,.10,-.5],[x+.20,.14,.5],wood,'pallet-slat');
 }else if(type==='crate'){
  shell(.45,.4,.78,wood,0);
 }else if(type==='sandwich-board'){
  for(const z of [-.22,.22])for(const x of [-.29,.29])post(x,z,1.02,.025,wood);
  for(const z of [-.25,.245])box([-.34,.20,z],[.34,.98,z+.005],M.dark,'board',[2,2,1]);
  for(const x of [-.29,.29])box([x-.025,1.02,-.25],[x+.025,1.07,.25],steel,'hinge');
 }else if(type==='low-wall'){
  b.box({min:[-1.5,-.2,-.18],max:[1.5,0,.18],material:M.footing,type:'foundation',fixed:true});
  box([-1.5,0,-.15],[1.5,.9,.15],stone,'wall-brick',[6,4,1]);
  box([-1.55,.9,-.19],[1.55,1.0,.19],stone,'wall-cap',[4,1,1]);
 }else if(type==='road-barrier'){
  for(let i=0;i<3;i++)b.piece({axis:'x',lo:-1.5+i,hi:-.5+i,poly:[[0,-.35],[0,.35],[.20,.35],[.65,.12],[.85,.12],[.85,-.12],[.65,-.12],[.20,-.35]],material:M.footing,type:'barrier'});
 }else{
  const w=type==='carport'?2.4:type==='billboard'?2.2:1.8,d=type==='billboard'?.18:type==='scaffold'?.75:1.3;
  const h=type==='billboard'?3.1:type==='scaffold'?2.3:2.5;
  const metal=['scaffold','bus-shelter','billboard'].includes(type),mat=metal?steel:wood,r=.07;
  const zs=type==='billboard'?[0]:[-d,d];
  for(const x of [-w,w])for(const z of zs)post(x,z,h,r,mat,true);
  if(type==='billboard'){
   for(const x of [-w,w])box([x-r,h,-r],[x+r,h+1.65,r],mat,'billboard-post',[1,2,1]);
   box([-w-r,h+.12,-.12],[w+r,h+1.6,-r],M.siding,'advertising-panel',[6,3,1]);
  }else{
   for(const z of [-d,d])box([-w-r,h,z-r],[w+r,h+.14,z+r],mat,'cross-beam',[3,1,1]);
   box([-w-.16,h+.14,-d-.16],[w+.16,h+.21,d+.16],type==='bus-shelter'?steel:wood,type==='scaffold'?'platform':'roof',[4,1,3]);
   if(type==='bus-shelter'){
    box([-w+r,.1,d-.025],[w-r,h,d+.025],M.glass,'shelter-glass',[4,3,1]);
    for(const x of [-w,w])box([x-.025,.1,-d+r],[x+.025,h,d-r],M.glass,'shelter-glass',[1,3,2]);
   }
   if(type==='market-stall'){
    for(const x of [-w,w])box([x-r,.86,-d+r],[x+r,.95,d-r],wood,'counter-rail');
    box([-w-r,.95,-d+r],[w+r,1.02,.1],wood,'counter',[4,1,1]);
   }
   if(type==='scaffold'){
    for(const x of [-w,w])for(const z of [-d,d])box([x-r,h+.21,z-r],[x+r,h+1.15,z+r],steel,'guard-post');
    for(const z of [-d,d])box([-w+r,h+1.0,z-r],[w-r,h+1.08,z+r],steel,'guardrail',[3,1,1]);
   }
  }
 }
 const pack=b.build(),nodes=pack.scenario.nodes;
 // Separate manufactured parts meet through screws, clips, welds or bolts.
 // Keep solid-piece fracture seams at their material strength; connections
 // release first, making a lid or panel meaningfully cheaper than a bollard.
 const connectors=new Map();
 for(const bond of pack.scenario.bonds)if(pack.scenario.nodePieces[bond.node0]!==pack.scenario.nodePieces[bond.node1]){
  if(!connectors.has(bond.m)){
   const source=b.table[bond.m],connection={...source,name:`outdoor-${source.name}-connection`};
   // Preserve elastic conditioning and compression capacity. Reducing these
   // caused intact settling failures; only pull-out and shear strength change.
   for(const key of ['tensionElastic','tensionFatal','shearElastic','shearFatal'])connection[key]*=.1;
   connectors.set(bond.m,b.table.push(connection)-1);
  }
 bond.m=connectors.get(bond.m);
 }
 // Outdoor seams represent mortar, split grain, welds and mounting hardware.
 // Building-grade bulk strength made these small props shrug off the actual
 // 500 kg playground cannon. Tune bonds only: preserve chunk material,
 // density, stiffness and compression support so intact props remain stable.
 const fractureMaterials=new Map();
 for(const bond of pack.scenario.bonds){
  if(!fractureMaterials.has(bond.m)){
   const source=b.table[bond.m];
   const factor=fractureSeamScale(type,source.name);
   const seam={...source,name:`${source.name}-fracture-seam`};
   for(const key of ['tensionElastic','tensionFatal','shearElastic','shearFatal'])seam[key]*=factor;
   fractureMaterials.set(bond.m,b.table.push(seam)-1);
  }
  bond.m=fractureMaterials.get(bond.m);
 }
 const dynamic=nodes.map((n,i)=>[n,i]).filter(([n])=>n.mass>0),top=dynamic.reduce((a,v)=>v[0].centroid.y>a[0].centroid.y?v:a);
 const support=pack.scenario.nodeTypes.map((t,i)=>t==='support'&&nodes[i].centroid.y<.5?i:-1).filter(i=>i>=0);
 const preferred=pack.scenario.nodeTypes.findIndex(t=>({mailbox:'lid','wheelie-bin':'lid',dumpster:'lid',bench:'seat-slat',planter:'planter-wall',streetlight:'lamp-base','street-sign':'sign','bike-rack':'rack-arm',hydrant:'hydrant-nozzle',pallet:'pallet-slat',crate:'lid','sandwich-board':'board','low-wall':'wall-cap',bollard:'support','road-barrier':'barrier','bus-shelter':'shelter-glass','market-stall':'counter',carport:'roof',scaffold:'platform',billboard:'advertising-panel'})[type]===t);
 // Destructive qualification uses a severe impact, like the existing wall
 // review. These are harness shots, not player weapon or vehicle tuning.
 const aimed=(i,downward=true)=>{const p=nodes[i].centroid;return {from:downward?[p.x,p.y+1.2,p.z]:[p.x,p.y,p.z-1.2],to:[p.x,p.y,p.z],momentum:3000000,radius:.16,speed:15,tick:0};};
 return {pack,metadata:{kind:'prop',type,options:{palette,seed,storeys:1,furnished:false},route:[],
  shots:{furniture:[aimed(preferred<0?top[1]:preferred)],collapse:(support.length?support:[dynamic[0][1]]).map((i,k)=>({...aimed(i,false),momentum:1000000,tick:k*15}))},
  shotGroups:{furniture:group,collapse:group},collapseNodes:dynamic.filter(([n])=>n.centroid.y>1.5).map(([,i])=>i),
  gameplay:{resistance:['mailbox','wheelie-bin','sandwich-board','pallet','crate'].includes(type)?'light':['low-wall','road-barrier','bollard','hydrant'].includes(type)?'heavy':'medium',installed:nodes.some(n=>n.mass===0)},
  cameras:{hero:{position:[6,4.2,-7],target:[0,1.1,0]},front:{position:[0,2,-8],target:[0,1,0]}}}};
}
