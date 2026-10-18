import {describe,expect,it,beforeAll} from 'vitest';
import {Matrix4,Vector3} from 'three';
import Module from 'manifold-3d';
import {defaultConfiguration,modelParameters} from './configuration.mjs';
import {VisualRig} from './dune/visual-rig.mjs';
import {cornerIds,neutralPose} from './dune/vehicle-rig.mjs';
// @ts-expect-error Shared geometry authoring module.
import {PoseDeltas,motionNames,roleMotion} from './dune/pose-deltas.mjs';
// @ts-expect-error Shared geometry authoring module.
import {buildBuggy} from './dune/buggy.mjs';

const models=['buggy','trophy','rally','monster','derby','sprint'];
const at=(m:Matrix4,p:number[]|Vector3)=>(Array.isArray(p)?new Vector3(...p):p.clone()).applyMatrix4(m);
const linearOf=(m:Matrix4)=>{const e=m.elements;return [[e[0],e[4],e[8]],[e[1],e[5],e[9]],[e[2],e[6],e[10]]];};
const offIdentity=(m:Matrix4)=>Math.max(...m.elements.map((x,i)=>Math.abs(x-new Matrix4().elements[i])));
function sweep(pd:any) {
  const poses:any[]=[];
  const h=pd.definition.corners.fl;
  for(const travel of [h.minTravel,-.05,.1,h.maxTravel])for(const steer of [-.5,0,.5])for(const rotation of [0,2.1]){
    const pose=neutralPose();
    for(const id of cornerIds)Object.assign(pose.wheels[id],{travelM:travel,steeringRad:steer,rotationRad:rotation*(id[1]==='l'?1:-1)});
    pose.steeringWheelRad=steer*3;poses.push(pose);
  }
  return poses;
}

describe.each(models)('%s physical suspension motion',model=>{
  const pd=new PoseDeltas(modelParameters(defaultConfiguration(model)));
  it('is exactly the identity at the neutral pose',()=>{
    pd.applyPose(neutralPose());
    for(const id of cornerIds)for(const name of motionNames)expect(offIdentity(pd.corners[id][name]),`${id}/${name}`).toBeLessThan(1e-12);
    expect(offIdentity(pd.steering)).toBeLessThan(1e-12);
  });
  it('keeps every rigid role rigid and keeps mechanical joints coincident',()=>{
    let worstJoint=0,worstPlunge=0;
    for(const pose of sweep(pd)){
      pd.applyPose(pose);
      for(const id of cornerIds){
        const c=pd.corners[id],s=pd.rig.states[id],n=pd.neutral.states[id],h=s.h;
        for(const name of motionNames){
          const L=linearOf(c[name]),e=[0,1,2].flatMap(i=>[0,1,2].map(j=>L[i].reduce((sum:number,_:number,k:number)=>sum+L[k][i]*L[k][j],0)-(i===j?1:0)));
          expect(Math.max(...e.map(Math.abs)),`${id}/${name} orthonormal`).toBeLessThan(1e-12);
          expect(c[name].determinant(),`${id}/${name}`).toBeCloseTo(1,12);
        }
        const joints:[string,Vector3,Vector3][]=[
          ['lower ball joint (arm)',at(c.lowerArm,h.lower),new Vector3(...s.k.lower)],
          ['lower ball joint (knuckle)',at(c.steer,h.lower),new Vector3(...s.k.lower)],
          ['upper ball joint (arm)',at(c.upperArm,h.upper),new Vector3(...s.k.upper)],
          ['upper ball joint (knuckle)',at(c.steer,h.upper),new Vector3(...s.k.upper)],
          ['shock eye on arm',at(c.lowerArm,h.shockBottom),s.bottom],
          ['piston at shock eye',at(c.piston,n.bottom),s.bottom],
          ['damper top mount',at(c.damper,n.top),s.top],
          ['tie rod outer on knuckle',at(c.tieRod,n.tieOuter),at(c.steer,h.tieOuter)],
          ['tie rod inner on rack',at(c.tieRod,n.tieInner),s.tieInner],
          ['hub on knuckle',at(c.wheel,h.hub),at(c.steer,h.hub)],
          ['axle inner joint',at(c.axle,h.axleInner),new Vector3(...h.axleInner)],
        ];
        for(const [name,a,b] of joints){const d=a.distanceTo(b);worstJoint=Math.max(worstJoint,d);expect(d,`${model} ${id} ${name}`).toBeLessThan(1e-9);}
        // A rigid shaft cannot follow the hub exactly (the real CV plunges).
        worstPlunge=Math.max(worstPlunge,at(c.axle,n.hub).distanceTo(s.hub));
      }
    }
    console.log(`${model}: worst joint ${worstJoint.toExponential(2)} m, worst CV plunge ${(worstPlunge*1000).toFixed(2)} mm`);
  });
});

describe('prepared buggy solids under physical and visual motion',()=>{
  let parts:any[]=[];
  const parameters=modelParameters(defaultConfiguration('buggy'));
  beforeAll(async()=>{const wasm=await Module();wasm.setup();parts=buildBuggy(wasm,parameters,()=>{},false,{preview:true}).parts.filter((p:any)=>p.motion);});
  it('uses the visual transform exactly where it is already rigid, and reports beam stretch elsewhere',()=>{
    const pd=new PoseDeltas(parameters),visual=new VisualRig({parameters,parts:[]}),neutral=new VisualRig({parameters,parts:[]});
    const worst:Record<string,number>={};
    for(const pose of sweep(pd)){
      pd.applyPose(pose);visual.applyPose(pose);
      for(const part of parts){
        if(!roleMotion[part.motion.role]&&part.motion.role!=='steering')continue;
        const c=new Vector3().fromArray(part.center),render={motion:part.motion,matrix:new Matrix4().makeTranslation(c.x,c.y,c.z)};
        const v=visual.matrixFor(render).clone().multiply(neutral.matrixFor(render).clone().invert()),p=pd.delta(part.motion);
        let d=0;for(let i=0;i<part.position.length;i+=3){const x=new Vector3(part.position[i],part.position[i+1],part.position[i+2]);d=Math.max(d,x.clone().applyMatrix4(v).distanceTo(x.applyMatrix4(p)));}
        worst[part.motion.role]=Math.max(worst[part.motion.role]??0,d);
      }
    }
    console.log('max vertex distance, visual vs physical (mm):',Object.fromEntries(Object.entries(worst).map(([k,v])=>[k,+(v*1000).toFixed(3)])));
    for(const role of ['hub','wheel','knuckle','steering'])expect(worst[role],role).toBeLessThan(1e-9);
  });
});
