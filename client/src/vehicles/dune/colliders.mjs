import {simpleRecipe,promoteBox} from './simple-colliders.mjs';
import {ColliderPrimitives} from './collider-primitives.mjs';
import {boundsOverlap,subtract,mergePieces,hull,pack,unpack,sat,dot} from './convex.mjs';
import {materials} from './buggy.mjs';

export const colliderDefaults={segments:12,ringSegments:16,springSegments:80};
export const colliderOptions=fidelity=>fidelity==='simple'?{fidelity:'simple',segments:8,ringSegments:8,springSegments:8}:{...colliderDefaults,segments:fidelity==='detailed'?16:12};
export const colliderKey=(parameters,options=colliderDefaults)=>JSON.stringify([parameters,options]);

export function buildColliders(parameters={},options=colliderDefaults,progress=(phase='',percent=0)=>{},validate=true){
 const started=performance.now(),simple=options.fidelity==='simple',raw=simple?simpleRecipe(parameters):new ColliderPrimitives(options).build(parameters),priority=p=>p.protectedPrimitive?2:Number(/pivot bolt|toggle/.test(p.name)),ordered=[...raw.parts].sort((a,b)=>priority(b)-priority(a));
 const completed=[],byId=new Map(),aliases=new Map();let discardedVolume=0,cuts=0;
 for(let index=0;index<ordered.length;index++){
  const part=ordered[index],pieces=[],owners=new Map();let wasCut=false;
  for(const original of part.pieces){
   let fragments=[original];
   for(const earlier of completed){
    if(!boundsOverlap(original.bounds,earlier.shape.bounds))continue;
    const next=[];
    for(const fragment of fragments){
     const result=subtract(fragment,earlier.shape);if(result.removed){cuts++;wasCut=true;owners.set(earlier.partId,(owners.get(earlier.partId)??0)+result.removed);}
     next.push(...result.pieces);
    }
    fragments=next;if(!fragments.length)break;
   }
   for(const shape of fragments){if(shape.volume<1e-13){discardedVolume+=shape.volume;continue}pieces.push(shape)}
  }
  if(!pieces.length){if(simple&&owners.size){aliases.set(part.id,[...owners].sort((a,b)=>b[1]-a[1])[0][0]);continue;}throw Error(`No collision volume remains for ${part.id}: ${part.name}`);}
  if(pieces.some(p=>p.vertices.length>255||p.faces.length>255))throw Error(`Convex cooking limit exceeded for ${part.name}`);
  byId.set(part.id,{...part,wasCut,pieces:mergePieces(pieces)});for(const shape of part.pieces)completed.push({partId:part.id,shape});
  if(index%50===0)progress('Partitioning collider contacts',Math.round(index/ordered.length*80));
 }
 for(const [id,alias] of aliases){let target=alias;while(aliases.has(target))target=aliases.get(target);byId.get(target).visualIds.push(...raw.parts.find(p=>p.id===id).visualIds);}
 const parts=raw.parts.filter(p=>!aliases.has(p.id)).map(original=>{
  const part=byId.get(original.id);part.pieces=part.pieces.map(p=>hull(p.vertices)).filter(p=>{
   const keep=p&&p.planes.every(plane=>Math.max(...p.vertices.map(v=>plane.d-dot(plane.n,v)))>2e-4);
   if(!keep&&p)discardedVolume+=p.volume;return keep;
  });if(!part.pieces.length)throw Error(`No stable collider remains for ${part.id}`);const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  for(const shape of part.pieces)for(let k=0;k<3;k++){bounds.min[k]=Math.min(bounds.min[k],shape.bounds.min[k]);bounds.max[k]=Math.max(bounds.max[k],shape.bounds.max[k])}
  const origin=bounds.min.map((x,k)=>Math.fround((x+bounds.max[k])/2)),volume=part.pieces.reduce((n,p)=>n+p.volume,0);
  const shapes=part.pieces.map(p=>pack(p,origin));
  if(simple&&shapes.length===1&&part.primitive&&!part.wasCut&&(part.protectedPrimitive||part.primitive.type==='cuboid')){
   const {position,...primitive}=part.primitive;Object.assign(shapes[0],primitive,{position:position.map((x,k)=>Math.fround(x-origin[k]))});
   // Inspection points are relative to the primitive center, unlike packed hulls.
   const proxy=part.pieces[0],lookup=new Map(proxy.vertices.map((v,i)=>[v.join(','),i]));
   shapes[0].vertices=proxy.vertices.map(v=>v.map((x,k)=>Math.fround(x-position[k])));shapes[0].faces=proxy.faces.map(f=>f.map(v=>lookup.get(v.join(','))));
  }
  return {visualIds:part.visualIds,id:part.id,name:part.name,system:part.system,material:part.material,source:part.source,position:origin,rotation:[0,0,0,1],shapes,volumeM3:volume,massKg:volume*materials[part.material].density,bounds};
 });
 const result={version:1,parameters:raw.parameters,options,units:'metres',axes:{up:'+Y',front:'-Z'},parts,bonds:[],report:{visualParts:raw.visualPartCount??parts.length,parts:parts.length,shapes:parts.reduce((n,p)=>n+p.shapes.length,0),triangles:0,maxVertices:Math.max(...completed.map(p=>p.shape.vertices.length)),cuts,discardedVolumeM3:discardedVolume,minFragmentThicknessM:2e-4,buildMs:performance.now()-started},engineHints:{geometry:simple?'primitives-and-convex':'convex-only',contactSkin:0,restOffset:0,contactToleranceM:2e-6,partOrigins:'independent collider-local origins; visual.localTranslation supplied by export bundle',compound:'Keep a connected bonded cluster in one rigid body; retain part IDs on its child convex colliders. Recluster on break. Never create rigid bodies per convex fragment.'}};
 progress('Auditing collider contacts',85);
 let audit=auditColliders(result),repairs=0;
 // Recheck the cooked float32 payload, then repair any remaining numerical
 // intersections against that same payload (not the pre-cooking geometry).
 while(audit.report.penetratingPairs&&repairs<6){
  const pair=audit.report.penetratingExamples[0],a=parts.find(p=>p.id===pair.a),b=parts.find(p=>p.id===pair.b);
  const A=unpack(a.shapes[pair.ai],a.position),B=unpack(b.shapes[pair.bi],b.position),trim=subtract(B,A);
  if(!trim.removed)break;
  const replacements=mergePieces(trim.pieces).filter(s=>s.volume>1e-13).map(s=>pack(s,b.position));
  if(!replacements.length&&b.shapes.length===1)break;
  b.shapes.splice(pair.bi,1,...replacements);repairs++;audit=auditColliders(result);
 }
 if(simple){
  const full=new Map(parts.map(p=>[p.id,p.shapes])),fullBonds=audit.bonds;let fullVolume=0,keptVolume=0;
  for(const part of parts){const ranked=part.shapes.map(shape=>({shape,volume:unpack(shape,part.position).volume})).sort((a,b)=>b.volume-a.volume),total=ranked.reduce((n,s)=>n+s.volume,0);let sum=0;part.shapes=[];
   for(const entry of ranked){part.shapes.push(entry.shape);sum+=entry.volume;if(sum>=total*.9)break;}
   fullVolume+=total;
  }
  audit=auditColliders(result);
  // Restore the affected groups if pruning removes their last physical bond.
  for(let pass=0;audit.report.components>1&&pass<3;pass++){
   for(const component of audit.report.disconnected){const ids=new Set(component),bridges=fullBonds.filter(b=>ids.has(b.a)!==ids.has(b.b));
    bridges.sort((a,b)=>(full.get(a.a).length+full.get(a.b).length)-(full.get(b.a).length+full.get(b.b).length));
    const bridge=bridges[0];if(bridge)for(const id of [bridge.a,bridge.b])parts.find(p=>p.id===id).shapes=full.get(id);
   }
   audit=auditColliders(result);
  }
  if(audit.report.components>1){for(const part of parts)part.shapes=full.get(part.id);audit=auditColliders(result);}
  for(const part of parts)part.shapes=part.shapes.map(promoteBox);audit=auditColliders(result);
  keptVolume=parts.reduce((n,p)=>n+p.shapes.reduce((sum,s)=>sum+unpack(s,p.position).volume,0),0);
  result.report.proxyVolumeRetained=keptVolume/fullVolume;result.report.minimumPartVolumeRetained=.9;
  result.report.detailPolicy='Wheel, spring/damper and steering assemblies use cylinders. Visual details map to shared collision groups. Minor contact fragments are omitted; at least 90% of each partitioned proxy volume is retained.';
 }
 Object.assign(result.report,audit.report);result.bonds=audit.bonds;if(simple)result.convexBonds=audit.convexBonds;result.report.repairs=repairs;result.report.shapes=parts.reduce((n,p)=>n+p.shapes.length,0);result.report.maxVertices=Math.max(...parts.flatMap(p=>p.shapes.map(s=>s.vertices.length)));result.report.shapeTypes=parts.flatMap(p=>p.shapes).reduce((counts,s)=>(counts[s.type]=(counts[s.type]??0)+1,counts),{});result.report.buildMs=performance.now()-started;

 for(const part of parts){part.volumeM3=part.shapes.reduce((n,s)=>n+unpack(s,part.position).volume,0);part.massKg=part.volumeM3*materials[part.material].density;}
 if(parts.some(p=>p.shapes.some(s=>s.vertices.length>255||s.faces.length>255)))throw Error('Convex cooking limit exceeded: '+JSON.stringify(parts.filter(p=>p.shapes.some(s=>s.vertices.length>255||s.faces.length>255)).map(p=>({name:p.name,shapes:p.shapes.map(s=>[s.type,s.vertices.length,s.faces.length])}))));
 if(validate&&result.report.maxConvexViolationM>2e-6)throw Error('A convex hull failed its half-space audit');
 if(validate&&result.report.penetratingPairs>0)throw Error(`Collider audit found ${result.report.penetratingPairs} penetrating pairs`);
 if(validate&&result.report.components!==1){
  const names=result.report.disconnected.flatMap(ids=>ids.map(id=>parts.find(p=>p.id===id)?.name)).filter(Boolean);
  throw Object.assign(Error(`Collider contact graph has ${result.report.components} disconnected components`),{unattachedParts:[...new Set(names)].slice(0,3)});
 }
 progress('Collision model ready',100);return result;
}

function* candidates(shapes,tolerance=2e-6){
 const sorted=[...shapes].sort((a,b)=>a.shape.bounds.min[0]-b.shape.bounds.min[0]);
 for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].shape.bounds.min[0]<=sorted[i].shape.bounds.max[0]+tolerance;j++)if(boundsOverlap(sorted[i].shape.bounds,sorted[j].shape.bounds,tolerance))yield[sorted[i],sorted[j]];
}
export function auditColliders(model,{float32=false}={}){
 const shapes=[];let triangles=0,maxConvexViolation=0;
 for(const part of model.parts)for(let i=0;i<part.shapes.length;i++){
  const s=part.shapes[i];if(!['convex','cylinder','cuboid'].includes(s.type))throw Error('Only primitive or convex shapes are supported by this package');
  const origin=float32?part.position.map(Math.fround):part.position;
  const data=float32?{...s,position:s.position?.map(Math.fround),vertices:s.vertices.map(p=>p.map(Math.fround))}:s;
  const shape=unpack(data,origin);if(!shape||shape.volume<=0)throw Error(`Degenerate hull ${part.id}:${i}`);
  for(const plane of shape.planes)for(const vertex of shape.vertices)maxConvexViolation=Math.max(maxConvexViolation,dot(plane.n,vertex)-plane.d);
  triangles+=shape.faces.reduce((n,f)=>n+f.length-2,0);shapes.push({partId:part.id,index:i,shape,type:s.type});
 }
 let maxPenetration=0,penetratingPairs=0,checkedPairs=0;const penetratingExamples=[];const bonds=new Map(),convexBonds=new Map();
 for(const [a,b] of candidates(shapes)){
  checkedPairs++;const depth=sat(a.shape,b.shape);maxPenetration=Math.max(maxPenetration,depth);
  if(depth>2e-6){penetratingPairs++;if(penetratingExamples.length<20)penetratingExamples.push({a:a.partId,ai:a.index,b:b.partId,bi:b.index,depth})}
  if(a.partId!==b.partId&&depth>=-2e-6){const key=[a.partId,b.partId].sort().join('|');if(!bonds.has(key)){const box={min:a.shape.bounds.min.map((v,k)=>Math.max(v,b.shape.bounds.min[k])),max:a.shape.bounds.max.map((v,k)=>Math.min(v,b.shape.bounds.max[k]))};bonds.set(key,{a:a.partId,b:b.partId,anchor:box.min.map((v,k)=>(v+box.max[k])/2),separationM:Math.max(0,-depth),kind:'geometric-contact'});}if(a.type==='convex'&&b.type==='convex')convexBonds.set(key,bonds.get(key));}
 }
 const adjacency=new Map(model.parts.map(p=>[p.id,new Set()]));for(const b of bonds.values()){adjacency.get(b.a).add(b.b);adjacency.get(b.b).add(b.a)}
 const visited=new Set(),groups=[];for(const p of model.parts)if(!visited.has(p.id)){const group=[p.id];visited.add(p.id);for(let i=0;i<group.length;i++)for(const id of adjacency.get(group[i]))if(!visited.has(id)){visited.add(id);group.push(id)}groups.push(group)}
 return {report:{triangles,checkedPairs,penetratingPairs,penetratingExamples,maxPenetrationM:maxPenetration,maxConvexViolationM:maxConvexViolation,contactToleranceM:2e-6,bonds:bonds.size,components:groups.length,disconnected:groups.slice(1),float32},bonds:[...bonds.values()],convexBonds:[...convexBonds.values()]};
}
