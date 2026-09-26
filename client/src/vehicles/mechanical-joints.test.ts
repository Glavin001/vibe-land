import {describe, expect, it} from 'vitest';
// @ts-expect-error Shared browser/Node authoring module.
import {mechanicalJoints} from './mechanical-joints.mjs';
// @ts-expect-error Shared browser/Node authoring module.
import {requireConnectedAssembly} from './strength-profile.mjs';

const part = (id: string, role: string, component?: string, corner='fl') =>
  ({id, motion:{role, component, corner}});
const hub=part('hub','wheel','hub'), rotor=part('rotor','wheel','rotor');
const tire=part('tire','wheel'), upright=part('upright','upright');
const axle=part('axle','axle'), caliper=part('caliper','knuckle','caliper');
const contact=(a: string,b: string)=>({a,b,area:.002,normal:[1,0,0],centroid:[1,2,3],validatedSurface:true});

describe('mechanical attachment topology',()=>{
  it.each([
    [hub,upright,'wheel-bearing'], [hub,axle,'drive-spline'],
    [hub,rotor,'wheel-internal'], [hub,tire,'wheel-internal'],
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
    [rotor,upright], [rotor,caliper], [hub,caliper],
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
