import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildVeneerHouse,withoutSkin,withoutStuds,SKIN_TYPES} from '../src/veneer-houses.mjs';
import {validate} from '../src/validate.mjs';
import {WALL_TIE,MORTAR_JOINT} from '../src/materials.mjs';

// The authored graph (no GPU): what the stress-convergence checklist asks of
// it, and that the skin hangs on the frame only by its ties. The GPU half --
// that it stands, stands without its skin and falls without a wall's studs --
// is scripts/qualify-veneer-houses.mjs.
for(const storeys of [1,2])test(`${storeys}-storey brick-veneer house: a frame that carries, a skin that hangs`,()=>{
 const {pack,metadata}=buildVeneerHouse({storeys});
 assert.deepEqual(buildVeneerHouse({storeys}).pack,pack,'deterministic');
 const v=validate(pack);assert(v.passed,v.errors.join('\n'));
 const s=pack.scenario,t=pack.defaults.solver.materials,type=i=>s.nodeTypes[i],mat=b=>t[b.m].name;
 assert(s.bonds.every(b=>b.area>=1e-4),'no bond under the solver stiffness floor (sliver)');
 const masonry=new Set(['brick-veneer','veneer-lintel-course']),veneer=s.nodes.map((_,i)=>i).filter(i=>masonry.has(type(i)));
 // Brick to brick and brick to slab is mortar; brick to anything else is a tie and only a tie.
 for(const b of s.bonds){
  const m0=masonry.has(type(b.node0)),m1=masonry.has(type(b.node1));if(!m0&&!m1)continue;
  if(m0&&m1||type(b.node0)==='foundation'||type(b.node1)==='foundation')assert.equal(mat(b),'veneer-mortar-joint');
  else{assert.equal(mat(b),'wall-tie');assert.equal(b.area,WALL_TIE.area);}
 }
 const tiesOf=new Map();for(const b of s.bonds)if(mat(b)==='wall-tie')tiesOf.set(b.node0,(tiesOf.get(b.node0)??0)+1);
 assert(veneer.every(i=>tiesOf.get(i)>=1),'every veneer panel is tied to the frame');
 const mortar=t.find(m=>m.name==='veneer-mortar-joint');assert.equal(mortar.tensionFatal,MORTAR_JOINT.tensionFatal);
 // Panels are tie cells: ~0.6 x 0.405 m, one tie each (lintel courses span an opening and its bearings).
 for(const i of veneer.filter(i=>type(i)==='brick-veneer')){const z=s.nodeSizes[i],len=Math.max(z.x,z.z);assert(len<=.81&&len>=.19,`panel length ${len}`);}
 // Without the skin, the frame is still one anchored structure.
 const frame=withoutSkin(pack),f=validate(frame);assert(f.passed,f.errors.join('\n'));
 assert(!frame.scenario.nodeTypes.some(x=>SKIN_TYPES.includes(x)));
 assert(frame.scenario.nodeTypes.includes('stud')&&frame.scenario.nodeTypes.includes('rafter'));
 // Without the front wall's studs, nothing carries that side of the roof.
 const front=storeys>1?['front-0','front-1']:['front'],cut=withoutStuds(pack,metadata,front);
 const frontStuds=s.nodeTypes.filter((x,i)=>['stud','king-stud','jack-stud','cripple-stud'].includes(x)&&front.includes(metadata.nodeWalls[i])).length;
 assert(frontStuds>20);assert.equal(cut.scenario.nodes.length,s.nodes.length-frontStuds);
});

// Revision 2 (docs/calibration/house-headers.md): the header and plate load path from the fastening
// schedule, each joint's stiffness at the spring length the stage uses.
test('brick-veneer bungalow, revision 2: headers, plate and joint stiffness as built', async () => {
 const {REVISION_2_CONNECTIONS,DOUBLE_TOP_PLATE}=await import('../src/materials.mjs');
 const {springLength}=await import('../src/veneer-houses.mjs');
 const before=process.env.VIBE_SECTION_ROTATION;process.env.VIBE_SECTION_ROTATION='1';
 let pack,metadata;try{({pack,metadata}=buildVeneerHouse({storeys:1,revision:2}));}finally{if(before===undefined)delete process.env.VIBE_SECTION_ROTATION;else process.env.VIBE_SECTION_ROTATION=before;}
 const v=validate(pack);assert(v.passed,v.errors.join('\n'));
 assert.notDeepEqual(buildVeneerHouse({storeys:1,revision:1}).pack,buildVeneerHouse({storeys:1,revision:2}).pack);
 const s=pack.scenario,t=pack.defaults.solver.materials,type=i=>s.nodeTypes[i],mat=b=>t[b.m].name,pair=b=>[type(b.node0),type(b.node1)].sort().join('/');
 // Header ends on their king studs: 4-8d toe nails; the plate on a header: face nails at 406 mm.
 for(const b of s.bonds){
  if(pair(b)==='header/king-stud')assert.equal(mat(b),'header-king-joint');
  if(pair(b)==='header/top-plate')assert.equal(mat(b),'header-plate-joint');
 }
 const hk=s.bonds.find(b=>mat(b)==='header-king-joint');assert(Math.abs(t[hk.m].shearFatal*hk.area-REVISION_2_CONNECTIONS['header-king'].shear)<1,'a header end holds its toe nails');
 // The plate: cut every two bays (no chunk over 2 m, against revision 1's 2.4 m and more), its strength the plies'.
 const plates=s.nodes.map((_,i)=>i).filter(i=>type(i)==='top-plate');
 assert(plates.every(i=>Math.max(s.nodeSizes[i].x,s.nodeSizes[i].z)<=2),'plate chunks two bays long');
 // Fastened joints in an impact at K_u = 2/3 K_ser (EN 1995-1-1 2.2.2(2)); a bearing joint at its wood's.
 for(const b of s.bonds){const m=t[b.m];if(m.name==='drywall-screw-joint'||m.name==='heel-joint')assert(Math.abs(m.impactElasticModulus/m.elasticModulus-2/3)<1e-9);if(m.bearingElasticModulus)assert(!m.impactElasticModulus,'a bearing joint keeps its wood stiffness');}
 assert(plates.every(i=>t[s.nodes[i].m].tensionFatal===DOUBLE_TOP_PLATE.tensionFatal));
 // Every slip-rated joint's stiffness E A / L at the stage's spring length is its fasteners' (within the
 // quarter-octave bins): a drywall screw row's K_ser per area times its area.
 const dw=s.bonds.filter(b=>mat(b)==='drywall-screw-joint');
 const k=b=>t[b.m].elasticModulus*b.area/Math.max(Math.abs((s.nodes[b.node1].centroid.x-s.nodes[b.node0].centroid.x)*b.normal.x+(s.nodes[b.node1].centroid.y-s.nodes[b.node0].centroid.y)*b.normal.y+(s.nodes[b.node1].centroid.z-s.nodes[b.node0].centroid.z)*b.normal.z),Math.sqrt(b.area));
 for(const b of dw){const want=0.5e6/0.0135*b.area;assert(Math.abs(k(b)/want-1)<0.1,`drywall screw stiffness ${k(b)} vs ${want}`);}
 assert.equal(typeof springLength,'function');
});
