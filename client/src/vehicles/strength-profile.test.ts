import { expect, it } from 'vitest';
// @ts-expect-error Shared asset worker module.
import { jointStrength, structuralBonds, requireConnectedAssembly } from './strength-profile.mjs';

it('keeps structural joints stronger than sacrificial trim without making either unbreakable',()=>{
  const frame=jointStrength('frame','steel'), trim=jointStrength('frame','glass');
  expect(frame.tensionFatal).toBeGreaterThan(trim.tensionFatal);
  for(const material of [frame,trim]) {
    expect(material.tensionFatal).toBeGreaterThan(material.tensionElastic);
    expect(material.shearFatal).toBeGreaterThan(material.shearElastic);
    expect(material.residualAreaFraction).toBe(0);
    expect(Object.values(material).every(Number.isFinite)).toBe(true);
  }
  expect(jointStrength('glass','frame')).toEqual(trim);
  expect(()=>jointStrength('unknown','frame')).toThrow();
});

it('does not qualify a model whose only attachment has zero area',()=>{
  const parts=[{id:'frame',material:'frame'},{id:'trim',material:'glass'}];
  const measured={a:'frame',b:'trim',area:0,normal:null,validatedSurface:false};
  expect(()=>requireConnectedAssembly(parts,structuralBonds(parts,[measured]))).toThrow('disconnected');
  const bonds=structuralBonds(parts,[{...measured,area:.001,normal:[0,1,0],validatedSurface:true}]);
  expect(()=>requireConnectedAssembly(parts,bonds)).not.toThrow();
  expect(()=>requireConnectedAssembly(parts,[{a:'frame',b:'missing'}])).toThrow('unknown part');
});

it('preserves measured area and rejects zero-area contacts as structural joints',()=>{
  const parts=[{id:'a',material:'frame'},{id:'b',material:'steel'}];
  const contact={a:'a',b:'b',area:.002,normal:[1,0,0],validatedSurface:true};
  const bonds=structuralBonds(parts,[contact,{...contact,area:0,validatedSurface:false}]);
  expect(bonds).toHaveLength(1);expect(bonds[0].area).toBe(contact.area);
  expect(bonds[0].strength.tensionFatal*bonds[0].area).toBe(600000);
});
