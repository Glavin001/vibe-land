// VIBE_REAL_CAPACITIES=1 (real-capacities.mjs), FIDELITY_AUDIT C1, D1, D3, D4, D5.
import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.VIBE_REAL_CAPACITIES='1';
const {buildOutdoorProp}=await import('../src/outdoor-props.mjs');
const {buildTree}=await import('../src/tree.mjs');
const {buildProp}=await import('../src/index.mjs');
const {dressTownProp}=await import('../src/town-dressing-visuals.mjs');
const {REAL_PROP_TYPES,GLUED_JOINT,characteristicLegacy}=await import('../src/real-capacities.mjs');
const {materials}=await import('../src/materials.mjs');
const LIMITS=['compressionElastic','compressionFatal','tensionElastic','tensionFatal','shearElastic','shearFatal'];
const used=pack=>[...new Set(pack.scenario.bonds.map(b=>b.m))].map(i=>pack.defaults.solver.materials[i]);

test('C1/D3: every real outdoor prop joint is real, with no damage-arrest residual',()=>{
 // Vibe Town's props and the audit's list (streetlight, bollard, bench, planter, low-wall).
 for(const type of ['mailbox','bench','planter','streetlight','street-sign','hydrant','bollard','bike-rack','bus-shelter','market-stall','billboard','low-wall']){
  assert.ok(REAL_PROP_TYPES().includes(type),`${type} has real capacities`);
  const {pack}=buildOutdoorProp(type);
  for(const m of used(pack)){
   assert.match(m.name,/-real$/,`${type}: ${m.name} is not a real-capacity joint`);
   assert.equal(m.residualAreaFraction,0,`${type}: ${m.name} keeps residual ${m.residualAreaFraction}`);
   assert.ok(!/fracture-seam|-connection/.test(m.name),`${type}: ${m.name} is a cut seam`);
  }
 }
});

test('C1/D4: trees are green wood with no residual, and say so',()=>{
 for(const family of ['shade','ornamental','street','sapling','conifer']){
  const {pack,metadata}=buildTree({family,variant:0});
  for(const m of used(pack).filter(m=>m.name.includes('wood')||m.name.includes('fibre'))){
   assert.equal(m.residualAreaFraction,0,`${family}: ${m.name}`);
   assert.ok(m.tensionFatal>=30e6,`${family}: ${m.name} tension fatal ${m.tensionFatal}`);
  }
  assert.doesNotMatch(metadata.strengthCalibration,/gameplay/);
 }
});

test('D5: chairs and cafe tables keep their glued joints (no x0.5, no x0.02)',()=>{
 const chair=buildProp('chair').pack;
 assert.ok(!chair.defaults.solver.materials.some(m=>m.name==='chair-mortise-joint'));
 const table=dressTownProp(buildProp('table'),'table',0).pack;
 assert.ok(!used(table).some(m=>/^cafe-/.test(m.name)));
 for(const pack of [chair,table])for(const m of used(pack).filter(m=>m.name==='furniture-joinery'))
  for(const k of ['tensionFatal','shearFatal'])assert.equal(m[k],GLUED_JOINT[k]);
});

test('D1: no legacy doubled timber or masonry limits survive',()=>{
 const legacy=[[36e6,90e6,14.4e6,36e6,10.08e6,25.2e6],[16e6,40e6,1.76e6,4.4e6,3.52e6,8.8e6]];
 const table=materials();characteristicLegacy(table);
 for(const m of table)for(const v of legacy)
  assert.ok(!LIMITS.every((k,i)=>Math.abs(m[k]-v[i])<=1e-6*v[i]),`${m.name} keeps the doubled legacy limits`);
 const frame=table.find(m=>m.name==='structure-timber');
 assert.equal(frame.compressionFatal,21e6);assert.equal(frame.shearFatal,4e6);assert.equal(frame.residualAreaFraction,0);
});

test('Veneer house joints: fastener twist, stud ends bearing at rest and pinned on their nails',async()=>{
 const {buildVeneerHouse}=await import('../src/veneer-houses.mjs');
 const {CONNECTIONS,BEARING,fastenerRow}=await import('../src/materials.mjs');
 const {pack}=buildVeneerHouse({storeys:1});
 const named=n=>pack.defaults.solver.materials.find(m=>m.name===n);
 // One M12 bolt twists on its own section (d / (2 sqrt 2)), not on the 190 x 190 lap.
 const heel=named('heel-joint');
 assert.ok(Math.abs(heel.twistGyration-0.012/(2*Math.SQRT2))<1e-12&&heel.twistReach===0.006);
 // A stud end stands on its plate: the plate's cross-grain bearing (E90 / t), 23x the two nails' slip.
 const stud=named('stud-plate-joint'),side=named('stud-plate-side-joint');
 assert.ok(stud.bearingElasticModulus/stud.elasticModulus>20,`bearing ${stud.bearingElasticModulus} vs slip ${stud.elasticModulus}`);
 // In rotation a pin on its two nails: K_ser sum r^2 at the bearing stiffness, graded at the outer nail.
 const row=fastenerRow(2,0.09-2*5*3.15e-3),c=CONNECTIONS['stud-plate'];
 assert.ok(Math.abs(stud.bendSection-row.gyration**2/row.reach)<1e-12);
 assert.ok(stud.bendGyration<row.gyration/4&&stud.twistGyration===stud.bendGyration);
 assert.equal(BEARING.elasticModulus/c.restBearing>0,true);
 // A stud beside a plate's end does not bear on it: nails only.
 assert.ok(side&&side.bearingElasticModulus===undefined&&side.tensionFatal>0);
 assert.ok(pack.scenario.bonds.some(b=>b.m===pack.defaults.solver.materials.indexOf(side)));
});
