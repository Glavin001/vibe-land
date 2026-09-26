import {describe, expect, it} from 'vitest';
// @ts-expect-error shared browser/Node geometry module
import {vehicleFractureGroups, validateWheelOwnership} from './fracture-groups.mjs';

function fixture() {
  const part = (id: string, x: number, extra = {}) => ({id, name: id, position: [x,2,3],
    visualIds: [id, `${id}-detail`], volumeM3: 2, massKg: 4,
    shapes: [{type:'convex', position:[.1,.2,.3], vertices:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]]}],
    bounds: {min:[x,2,3], max:[x+1,3,4]}, ...extra});
  return {parts: [
    part('hub', 1, {motion:{corner:'fl',role:'wheel'}}),
    part('engine', 0, {functionality:'engine'}),
    part('tire', 1.2, {motion:{corner:'fl',role:'wheel'}, source:'cylinder', name:'Front left wheel assembly'}),
    part('axle', .7, {motion:{corner:'fl',role:'axle'}}),
    part('chassis', 0, {functionality:'chassis'}),
  ], bonds: [
    {a:'hub',b:'tire',area:1,centroid:[1,2,3]},
    {a:'hub',b:'axle',area:2,centroid:[2,3,4]},
    {a:'tire',b:'axle',area:3,centroid:[3,4,5]},
    {a:'engine',b:'chassis',area:4,centroid:[4,5,6]},
  ], report:{parts:5,shapes:5,components:1}};
}
describe('functional fracture groups', () => {
  it('rejects swallowed calipers, uprights and other corners in a wheel chunk', () => {
    const wheel={id:'wheel',visualIds:['tire','detail'],motion:{corner:'fl',role:'wheel'}};
    const tire={id:'tire',name:'Tire',motion:{corner:'fl',role:'wheel'}};
    const detail={id:'detail',name:'Tread',motion:{corner:'fl',role:'wheel'}};
    expect(()=>validateWheelOwnership([wheel],[tire,detail])).not.toThrow();
    for(const motion of [{corner:'fl',role:'knuckle'},{corner:'fl',role:'upright'},
      {corner:'fr',role:'wheel'},null]) {
      expect(()=>validateWheelOwnership([wheel],[tire,{...detail,motion}])).toThrow('incompatible');
    }
    expect(()=>validateWheelOwnership([wheel],[tire])).toThrow('incompatible');
  });
  it('preserves all geometry, visual ownership and external parallel bonds without mutating input', () => {
    const original = fixture(), untouched = structuredClone(original);
    const result = vehicleFractureGroups(original);
    expect(original).toEqual(untouched);
    expect(result.parts.map((p: any) => p.id)).toEqual(['chassis','tire','engine','axle']);
    const tire = result.parts[1];
    expect(tire.visualIds).toEqual(['hub','hub-detail','tire','tire-detail']);
    expect(tire.sourcePartIds).toEqual(['hub','tire']);
    expect(tire.volumeM3).toBe(4);
    expect(tire.massKg).toBe(8);
    for (let j = 0; j < 2; j++) {
      const source = original.parts[j === 0 ? 0 : 2];
      const shape = tire.shapes[j];
      expect(shape.vertices).toEqual(source.shapes[0].vertices);
      for (let i = 0; i < 3; i++) {
        expect(tire.position[i]+shape.position[i]).toBeCloseTo(source.position[i]+source.shapes[0].position[i], 12);
      }
    }
    expect(result.bonds).toEqual([
      {...original.bonds[1],a:'tire'}, original.bonds[2], original.bonds[3],
    ]);
    expect(result.report.shapes).toBe(original.report.shapes);
  });
  it('retains each corner separately and never groups suspension or the axle into the wheel', () => {
    const input = fixture();
    const other = structuredClone(input.parts[0]);
    Object.assign(other,{id:'other',visualIds:['other'],motion:{corner:'fr',role:'wheel'}});
    input.parts.push(other);
    const result = vehicleFractureGroups(input);
    expect(result.parts.find((p: any) => p.id === 'other').visualIds).toEqual(['other']);
    expect(result.parts.find((p: any) => p.id === 'axle').motion.role).toBe('axle');
  });
  it('fails on missing or moving chassis, missing engine, and unmapped graph endpoints', () => {
    for (const role of ['chassis','engine']) {
      const input = fixture();
      input.parts = input.parts.filter(p => p.id !== role);
      expect(() => vehicleFractureGroups(input)).toThrow();
    }
    const moving = fixture();
    Object.assign(moving.parts[4],{motion:{role:'axle'}});
    expect(() => vehicleFractureGroups(moving)).toThrow('fixed chassis');
    const unknown = fixture(); unknown.bonds[0].b = 'missing';
    expect(() => vehicleFractureGroups(unknown)).toThrow('endpoint');
  });
});
