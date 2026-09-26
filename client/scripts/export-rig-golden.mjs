// Golden poses for the server rig port (server/src/vehicle_assets/rig.rs).
// node scripts/export-rig-golden.mjs /tmp/vehicle-posed-fixtures.json /tmp/rig-golden [checked-in.json]
// Per model: physical pose deltas from dune/pose-deltas.mjs, and each chunk's
// posed actor-frame mass found by integrating the moved final visual solids.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Matrix4,Vector3} from 'three';
import {decodeModel} from '../src/vehicles/dune/model-codec.mjs';
import {PoseDeltas,motionNames} from '../src/vehicles/dune/pose-deltas.mjs';
import {cornerIds,neutralPose} from '../src/vehicles/dune/vehicle-rig.mjs';
import {meshMassProperties,massPropertiesToActor,combineMassProperties,transformMassProperties} from '../src/vehicles/mass-properties.mjs';

const [fixturesPath,outDir,checkedIn]=process.argv.slice(2);
const models=['buggy','trophy','rally','monster','derby','sprint'];
const fixtures=JSON.parse(readFileSync(fixturesPath,'utf8')).filter(f=>models.includes(f.name));
assert.equal(fixtures.length,models.length,'fixture manifest must contain all six models');
mkdirSync(outDir,{recursive:true});
const linearOf=m=>{const e=m.elements;return [[e[0],e[4],e[8]],[e[1],e[5],e[9]],[e[2],e[6],e[10]]];};
const offsetOf=m=>[m.elements[12],m.elements[13],m.elements[14]];
const toActor=(m,h)=>{const p=new Matrix4().makeTranslation(0,-h,0).multiply(new Matrix4().makeScale(-1,1,-1));return p.clone().multiply(m).multiply(p.invert());};
const frac=x=>x-Math.floor(x);
function poses(definition) {
  const out=[{name:'neutral',inputs:cornerIds.map(()=>[0,0,0])},{name:'spin only',inputs:cornerIds.map((_,c)=>[0,0,1.3+c])}];
  const range=id=>[definition.corners[id].minTravel,definition.corners[id].maxTravel];
  out.push({name:'full droop',inputs:cornerIds.map(id=>[range(id)[0],0,0])});
  out.push({name:'full bump beyond range',inputs:cornerIds.map(id=>[range(id)[1]+.1,0,0])});
  for(const steer of [-.6,.6])for(const end of [0,1])out.push({name:`steer ${steer} at ${end?'bump':'droop'}`,inputs:cornerIds.map(id=>[range(id)[end]*.98,id[0]==='f'?steer:0,.4])});
  for(let i=0;i<10;i++)out.push({name:`mixed ${i}`,inputs:cornerIds.map((id,c)=>{const [lo,hi]=range(id);return [lo+(hi-lo)*frac(i*.37+c*.23),(frac(i*.61+c*.17)-.5)*1.2,i*1.7-c];})});
  out.push({name:'steering wheel override',inputs:cornerIds.map((id,c)=>[.03*c,id[0]==='f'?.2:0,0]),steeringWheel:-1.1});
  return out;
}
const golden=[];
for(const fixture of fixtures){
  const metadata=JSON.parse(readFileSync(fixture.metadataPath,'utf8'));
  const buffer=readFileSync(join(dirname(fixture.metadataPath),'model.bin'));
  const visual=decodeModel(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
  const solids=new Map(visual.parts.map(p=>[p.id,p]));
  assert.ok(metadata.rig?.corners&&metadata.parts.every(p=>p.visuals?.length),`${fixture.name}: metadata predates posed-5`);
  const pd=new PoseDeltas(metadata.rig.parameters),h=metadata.originHeight;
  let worstCenter=0,worstTensor=0,worstVisual=0;
  const records=poses(pd.definition).map(pose=>{
    const input=neutralPose();cornerIds.forEach((id,c)=>{const [travelM,steeringRad,rotationRad]=pose.inputs[c];Object.assign(input.wheels[id],{travelM,steeringRad,rotationRad});});
    if(pose.steeringWheel!==undefined)input.steeringWheelRad=pose.steeringWheel;
    pd.applyPose(input);
    const chunks=metadata.parts.map(part=>{
      const integrated=[],predicted=[];
      for(const vis of part.visuals){
        const solid=solids.get(vis.id),delta=pd.delta(solid.motion),moved=[],x=new Vector3();
        assert.deepEqual(vis.motion?.role??null,solid.motion?.role??null,`${vis.id} binding`);
        for(let i=0;i<solid.position.length;i+=3){x.set(solid.position[i],solid.position[i+1],solid.position[i+2]).applyMatrix4(delta);moved.push(x.x,x.y,x.z);}
        integrated.push(massPropertiesToActor(meshMassProperties(moved,solid.indices,solid.mass),h));
        const actor=toActor(delta,h);predicted.push(transformMassProperties(vis.massProperties,linearOf(actor),offsetOf(actor)));
        const rest=massPropertiesToActor(meshMassProperties(solid.position,solid.indices,solid.mass),h);
        worstVisual=Math.max(worstVisual,Math.hypot(...rest.center.map((v,k)=>v-vis.massProperties.center[k])));
      }
      const a=combineMassProperties(integrated),b=combineMassProperties(predicted);
      worstCenter=Math.max(worstCenter,Math.hypot(...a.center.map((v,k)=>v-b.center[k])));
      worstTensor=Math.max(worstTensor,Math.hypot(...a.inertia.flat().map((v,k)=>v-b.inertia.flat()[k]))/Math.hypot(...a.inertia.flat()));
      return {id:part.id,mass:a.mass,center:a.center,inertia:a.inertia};
    });
    const deltas=Object.fromEntries(cornerIds.map(id=>[id,Object.fromEntries(motionNames.map(n=>[n,pd.corners[id][n].toArray()]))]));
    return {...pose,deltas,steering:pd.steering.toArray(),chunks};
  });
  assert.ok(worstVisual<1e-12,`${fixture.name}: exported solid mass differs from model.bin (${worstVisual})`);
  assert.ok(worstCenter<1e-9&&worstTensor<1e-9,`${fixture.name}: tensor map vs integration ${worstCenter} m, ${worstTensor}`);
  console.log(`${fixture.name}: ${records.length} poses, ${metadata.parts.length} chunks; transform vs integrated centre ${worstCenter.toExponential(2)} m, tensor ${worstTensor.toExponential(2)}`);
  const file=resolve(outDir,`${fixture.name}.rig-golden.json`);
  writeFileSync(file,JSON.stringify({model:fixture.name,metadataPath:fixture.metadataPath,poses:records}));
  golden.push({name:fixture.name,path:file,metadataPath:fixture.metadataPath,records,rig:metadata.rig});
}
writeFileSync(resolve(outDir,'manifest.json'),JSON.stringify(golden.map(({name,path,metadataPath})=>({name,path,metadataPath}))));
// Self-contained deltas-only golden so the server test always runs.
if(checkedIn){const g=golden[0];writeFileSync(checkedIn,JSON.stringify({model:g.name,rig:{corners:g.rig.corners,steering:g.rig.steering},
  poses:g.records.map(({name,inputs,steeringWheel,deltas,steering})=>({name,inputs,steeringWheel,deltas,steering}))}));console.log(`wrote ${checkedIn}`);}
