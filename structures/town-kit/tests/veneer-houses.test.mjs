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
 const cut=withoutStuds(pack,metadata,storeys>1?'front-0':'front');
 const front=storeys>1?'front-0':'front',frontStuds=s.nodeTypes.filter((x,i)=>['stud','king-stud','jack-stud','cripple-stud'].includes(x)&&metadata.nodeWalls[i]===front).length;
 assert(frontStuds>20);assert.equal(cut.scenario.nodes.length,s.nodes.length-frontStuds);
});
