// Golden poses for the server rig port (server/src/vehicle_assets/rig.rs).
// node scripts/export-rig-golden.mjs ../server/src/vehicle_assets/testdata/rig-golden-buggy.json [model]
// Records the rig definition and the physical pose deltas of dune/pose-deltas.mjs
// over bump, droop, steer, spin and mixed poses, including out-of-range travel.
import {writeFileSync} from 'node:fs';
import {PoseDeltas,motionNames} from '../src/vehicles/dune/pose-deltas.mjs';
import {cornerIds,neutralPose} from '../src/vehicles/dune/vehicle-rig.mjs';
import {defaultConfiguration,modelParameters} from '../src/vehicles/configuration.mjs';

const [output,model='buggy']=process.argv.slice(2);
if(!output)throw Error('usage: export-rig-golden.mjs <output.json> [model]');
const frac=x=>x-Math.floor(x);
const pd=new PoseDeltas(modelParameters(defaultConfiguration(model))),definition=pd.definition;
const range=id=>[definition.corners[id].minTravel,definition.corners[id].maxTravel];
const poses=[{name:'neutral',inputs:cornerIds.map(()=>[0,0,0])},{name:'spin only',inputs:cornerIds.map((_,c)=>[0,0,1.3+c])},
  {name:'full droop',inputs:cornerIds.map(id=>[range(id)[0],0,0])},{name:'full bump beyond range',inputs:cornerIds.map(id=>[range(id)[1]+.1,0,0])}];
for(const steer of [-.6,.6])for(const end of [0,1])poses.push({name:`steer ${steer} at ${end?'bump':'droop'}`,inputs:cornerIds.map(id=>[range(id)[end]*.98,id[0]==='f'?steer:0,.4])});
for(let i=0;i<10;i++)poses.push({name:`mixed ${i}`,inputs:cornerIds.map((id,c)=>{const [lo,hi]=range(id);return [lo+(hi-lo)*frac(i*.37+c*.23),(frac(i*.61+c*.17)-.5)*1.2,i*1.7-c];})});
poses.push({name:'steering wheel override',inputs:cornerIds.map((id,c)=>[.03*c,id[0]==='f'?.2:0,0]),steeringWheel:-1.1});
const records=poses.map(pose=>{
  const input=neutralPose();
  cornerIds.forEach((id,c)=>{const [travelM,steeringRad,rotationRad]=pose.inputs[c];Object.assign(input.wheels[id],{travelM,steeringRad,rotationRad});});
  if(pose.steeringWheel!==undefined)input.steeringWheelRad=pose.steeringWheel;
  pd.applyPose(input);
  return {...pose,deltas:Object.fromEntries(cornerIds.map(id=>[id,Object.fromEntries(motionNames.map(n=>[n,pd.corners[id][n].toArray()]))])),steering:pd.steering.toArray()};
});
writeFileSync(output,JSON.stringify({model,rig:{corners:definition.corners,steering:definition.steering},poses:records}));
console.log(`${model}: ${records.length} poses x ${motionNames.length} motions -> ${output}`);
