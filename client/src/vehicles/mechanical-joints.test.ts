import {describe, expect, it} from 'vitest';
// @ts-expect-error Shared browser/Node authoring module.
import {mechanicalJoints,anchorRigJoints,JOINT_NEIGHBOURHOOD_M} from './mechanical-joints.mjs';
import {createRigDefinition} from './dune/vehicle-rig.mjs';
import {defaultConfiguration,modelParameters} from './configuration.mjs';
// @ts-expect-error Shared browser/Node authoring module.
import {requireConnectedAssembly} from './strength-profile.mjs';

const part = (id: string, role: string, component?: string, corner='fl') =>
  ({id, motion:{role, component, corner}});
const hub=part('hub','hub','hub'), rotor=part('rotor','hub','rotor');
const tire=part('tire','wheel'), upright=part('upright','upright');
const axle=part('axle','axle'), caliper=part('caliper','knuckle','caliper');
const contact=(a: string,b: string)=>({a,b,area:.002,normal:[1,0,0],centroid:[1,2,3],validatedSurface:true});

describe('mechanical attachment topology',()=>{
  it.each([
    [hub,upright,'wheel-bearing'], [hub,axle,'drive-spline'],
    [hub,rotor,'hub-internal'], [hub,tire,'wheel-mount'],
    [tire,part('rim','wheel'),'wheel-internal'],
    [caliper,upright,'caliper-mount'],
  ])('retains the measured %s / %s mounting interface in either order', (a,b,attachment)=>{
    for(const [first,second] of [[a,b],[b,a]] as any[][]){
      const surface=contact(first.id,second.id), untouched=structuredClone(surface);
      const result=mechanicalJoints([first,second],[surface]);
      expect(result.excluded).toEqual([]);
      expect(result.joints).toEqual([{...surface,attachment}]);
      expect(surface).toEqual(untouched);
    }
  });
  it.each([
    [rotor,upright], [rotor,caliper], [hub,caliper], [rotor,tire],
    [tire,axle], [tire,upright],
    [hub,part('arm','lowerArm')], [hub,part('eye','shockEye')],
    [hub,part('rod','tieRod')], [hub,part('boot','cvBoot')],
    [tire,part('fender','body')], [caliper,part('arm','upperArm')],
    [hub,part('other-upright','upright',undefined,'fr')],
    [tire,part('other-wheel','wheel',undefined,'fr')],
  ])('does not weld incidental contact between %s and %s', (a,b)=>{
    for(const [first,second] of [[a,b],[b,a]]){
      const result=mechanicalJoints([first,second],[contact(first.id,second.id)]);
      expect(result.joints).toEqual([]);
      expect(result.excluded).toHaveLength(1);
      expect(result.excluded[0].reason).toBeTruthy();
    }
  });
  it('preserves unrelated structural interfaces and never creates a missing mount',()=>{
    const frame={id:'frame'}, engine={id:'engine'};
    const fixed=contact('frame','engine');
    expect(mechanicalJoints([frame,engine],[fixed]).joints).toEqual([{...fixed,attachment:'fixed-contact'}]);
    const result=mechanicalJoints([caliper,rotor],[contact(caliper.id,rotor.id)]);
    expect(()=>requireConnectedAssembly([caliper,rotor],result.joints)).toThrow('disconnected');
    expect(mechanicalJoints([hub,upright],[]).joints).toEqual([]);
    expect(()=>mechanicalJoints([hub],[contact('hub','unknown')])).toThrow('unknown part');
  });
});

describe('rig-anchored joints between relatively moving chunks',()=>{
  const rig=createRigDefinition(modelParameters(defaultConfiguration()));
  const h=rig.corners.fl;
  const chunk=(id:string,role?:string,corner='fl')=>({id,name:id,motion:role?{role,corner}:null});
  const bond=(a:string,b:string,centroid:number[])=>({a,b,visualA:a+'-v',visualB:b+'-v',centroid,normal:[0,1,0],area:1e-4});
  const parts=[chunk('frame'),chunk('arm','lowerArm'),chunk('upright','upright'),chunk('boot','cvBoot'),chunk('axle','axle'),chunk('rear-arm','lowerArm','rl'),chunk('coil','spring')];
  it('moves a bushing interface onto the pivot axis and keeps its measurement',()=>{
    const measured=[h.lowerPivot[0],h.lowerPivot[1]+.02,h.lowerPivot[2]-.1];
    const {bonds,excluded}=anchorRigJoints(parts,[bond('frame','arm',measured)],rig);
    expect(excluded).toEqual([]);
    expect(bonds[0]).toMatchObject({joint:'lower-arm-pivot',measuredCentroid:measured,area:1e-4,normal:[0,1,0]});
    bonds[0].centroid.forEach((v:number,i:number)=>expect(v).toBeCloseTo([h.lowerPivot[0],h.lowerPivot[1],h.lowerPivot[2]-.1][i],12));
  });
  it('anchors a ball joint at its hardpoint',()=>{
    const {bonds}=anchorRigJoints(parts,[bond('arm','upright',[h.lower[0]+.03,h.lower[1],h.lower[2]])],rig);
    expect(bonds[0].joint).toBe('lower-ball-joint');expect(bonds[0].centroid).toEqual(h.lower);
  });
  it('excludes contacts away from the joint, incidental pairs and cross-corner contacts',()=>{
    const far=[h.shockTop[0],h.shockTop[1]-JOINT_NEIGHBOURHOOD_M-.01,h.shockTop[2]];
    const {bonds,excluded}=anchorRigJoints(parts,[bond('frame','coil',far),bond('boot','upright',h.hub),bond('arm','rear-arm',h.lower)],rig);
    expect(bonds).toEqual([]);
    expect(excluded.map(e=>e.reason)).toEqual(['contact-away-from-joint','relative-motion-contact','relative-motion-contact']);
    expect(excluded[0]).toEqual({a:'frame-v',b:'coil-v',reason:'contact-away-from-joint'});
  });
  it('leaves interfaces within one motion untouched, including boots on their shaft',()=>{
    const same=bond('boot','axle',[.3,.4,-1.3]);
    expect(anchorRigJoints(parts,[same],rig)).toEqual({bonds:[same],excluded:[]});
  });
});
