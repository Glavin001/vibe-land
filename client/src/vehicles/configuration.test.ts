import { describe, it, expect } from 'vitest';
import { defaultConfiguration, normalizeConfiguration, serializeConfiguration, geometryKey, vehicles, vehicleFields, modelParameters, resolveVehicleGeometry, sourceToActorPoint } from './configuration.mjs';
import { LiveGeometry } from './dune/live-geometry.mjs';

describe('shared vehicle configuration', () => {
 it('round trips every model and retains a unique customized vehicle', () => {
  for (const preset of vehicles) {
   const c=defaultConfiguration(preset.id);
   c.dimensions.wheelbase=2.8; c.finish='#ABCDEF';
   const normalized=normalizeConfiguration(c);
   expect(JSON.parse(serializeConfiguration(normalized))).toEqual(normalized);
   expect(normalized.finish).toBe('#abcdef');
   const resolved=resolveVehicleGeometry(c), source=new LiveGeometry();
   try {
    const model=source.build(modelParameters(c));
    expect(model.parts.length).toBeGreaterThan(900);
    expect(new Set(model.parts.map((p: any)=>p.id)).size).toBe(model.parts.length);
    expect(resolved.wheelCenters[0][2]-resolved.wheelCenters[2][2]).toBeCloseTo(2.8);
    expect(resolved.wheelCenters[1][0]-resolved.wheelCenters[0][0]).toBeCloseTo(c.dimensions.track);
    expect(resolved.suspensionTravel).toBeGreaterThan(0);
   } finally { source.dispose(); }
  }
 });
 it('does not invalidate geometry for a finish change', () => {
  const a=defaultConfiguration(),b={...a,finish:'#112233'};
  expect(geometryKey(a)).toBe(geometryKey(b));
  expect(serializeConfiguration(a)).not.toBe(serializeConfiguration(b));
  expect(geometryKey({...a,dimensions:{...a.dimensions,track:2}})).not.toBe(geometryKey(a));
 });
 it('validates versions, finite dimensions, ranges and unknown fields', () => {
  const c=defaultConfiguration();
  for(const invalid of [null, {...c,version:2}, {...c,model:'unknown'}, {...c,finish:'red'}, {...c,extra:1},
   {...c,dimensions:{...c.dimensions,wheelbase:NaN}}, {...c,dimensions:{...c.dimensions,track:100}},
   {...c,dimensions:{...c.dimensions,arbitraryMass:10}}]) expect(()=>normalizeConfiguration(invalid)).toThrow();
 });
 it('uses the same supported dimensional boundaries as the source generator', () => {
  for(const preset of vehicles) for(const [key,,min,max] of vehicleFields(preset.id)) for(const value of [min,max]) {
   const c=defaultConfiguration(preset.id);c.dimensions[key]=value;
   expect(resolveVehicleGeometry(c).suspensionTravel).toBeGreaterThan(0);
  }
 });
 it('converts with a proper rotation and applies the origin exactly once', () => {
  expect(sourceToActorPoint([1,2,3],.5)).toEqual([-1,1.5,-3]);
  expect(sourceToActorPoint(sourceToActorPoint([1,2,3]))).toEqual([1,2,3]);
 });
});
