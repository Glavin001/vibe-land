import {describe, expect, it} from 'vitest';
import {defaultConfiguration, normalizeConfiguration, geometryKey, resolveDrivingSetup, resolveVehicleGeometry, serializeConfiguration, drivingFields} from './configuration.mjs';
import {garageBuilds} from './builds.mjs';
import {VehicleVisual} from './VehicleVisual';

describe('personalized Vehicle2 builds',()=>{
  it('imports legacy configurations without invalidating existing geometry',()=>{
    const c=defaultConfiguration('rally');
    const legacy={version:1,generatorVersion:c.generatorVersion,model:c.model,dimensions:c.dimensions,finish:'#ABCDEF'};
    const migrated=normalizeConfiguration(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.appearance.body).toBe('#abcdef');
    expect(geometryKey(migrated)).toBe(JSON.stringify({...legacy,finish:undefined}));
    expect(normalizeConfiguration(JSON.parse(serializeConfiguration(migrated)))).toEqual(migrated);
  });
  it('preserves geometry when changing paint or personality, but changes shared identity',()=>{
    const base=defaultConfiguration();
    const custom={...base,appearance:{...base.appearance,body:'#123456'},driving:{...base.driving,drivetrain:'rwd' as const,topSpeed:20}};
    expect(geometryKey(custom)).toBe(geometryKey(base));
    expect(serializeConfiguration(custom)).not.toBe(serializeConfiguration(base));
    const visual=new VehicleVisual(base);
    try {
      visual.configure(custom);
      const body=visual.group.children.find((m:any)=>m.userData.system==='Body'&&m.userData.material==='frame') as any;
      expect(body.material.color.getHexString()).toBe('123456');
      const wheel=visual.group.children.find((m:any)=>m.userData.system==='Wheels'&&m.userData.material==='alloy') as any;
      expect(wheel.material).not.toBe(body.material);
    } finally {visual.dispose();}
  });
  it('offers distinct builds with valid linkage, force budgets and suspension settings',()=>{
    expect(garageBuilds.length).toBe(12);
    expect(new Set(garageBuilds.map(b=>serializeConfiguration(b.configuration))).size).toBe(12);
    for(const build of garageBuilds) {
      const c=normalizeConfiguration(build.configuration),g=resolveVehicleGeometry(c),d=resolveDrivingSetup(c,2400);
      const driven=d.rearWheelDrive||d.frontWheelDrive?2:4;
      expect(d.driveTorque*driven/c.dimensions.tireRadius).toBeCloseTo(2400*d.acceleration);
      expect(d.driveTorque/c.dimensions.tireRadius).toBeLessThanOrEqual(.8*d.tyreFriction*2400*9.81/4+1e-6);
      expect(d.damping/(2*Math.sqrt(d.springStiffness*600))).toBeCloseTo(c.driving.dampingRatio);
      const restCompression=600*9.81/d.springStiffness;
      expect(restCompression).toBeGreaterThan(0);
      expect(restCompression).toBeLessThan(g.suspensionTravel);
      expect(d.maxSteerRadians).toBeLessThanOrEqual(g.maxSteerRadians);
    }
  });
  it('drives only the selected axle with a two-wheel traction budget and unchanged geometry',()=>{
    const base=defaultConfiguration();
    for(const drivetrain of ['awd','fwd','rwd'] as const) {
      const config=normalizeConfiguration({...base,driving:{...base.driving,drivetrain}});
      const d=resolveDrivingSetup(config,600), driven=drivetrain==='awd'?4:2;
      expect(d.frontWheelDrive).toBe(drivetrain==='fwd');
      expect(d.rearWheelDrive).toBe(drivetrain==='rwd');
      expect(d.driveTorque*driven/config.dimensions.tireRadius).toBeCloseTo(600*d.acceleration);
      expect(d.acceleration).toBeCloseTo(Math.min(base.driving.acceleration,.8*base.driving.grip*9.81*driven/4));
      expect(geometryKey(config)).toBe(geometryKey(base));
      expect(normalizeConfiguration(JSON.parse(serializeConfiguration(config)))).toEqual(config);
    }
  });
  it('rejects missing, out of range, nonfinite and unknown tuning fields',()=>{
    const c=defaultConfiguration();
    for(const [key,,min,max] of drivingFields) for(const value of [NaN,Infinity,min-.01,max+.01,'1']) {
      expect(()=>normalizeConfiguration({...c,driving:{...c.driving,[key]:value}})).toThrow();
    }
    for(const driving of [null,{}, {...c.driving,drivetrain:'4wd'}, {...c.driving,cheat:1}]) expect(()=>normalizeConfiguration({...c,driving})).toThrow();
    expect(()=>normalizeConfiguration({...c,appearance:{...c.appearance,paint:'chrome'}})).toThrow();
    expect(()=>normalizeConfiguration({...c,appearance:{...c.appearance,wheels:'red'}})).toThrow();
  });
});
