import { describe, expect, it } from 'vitest';
// @ts-expect-error shared Node geometry module
import { visualOwners, groupJoints, simplePhysicsShape } from './simple-physics.mjs';

describe('Simple collision assembly',()=>{
 it('maps all tread visuals into one wheel without losing joint interfaces',()=>{
  const owners=visualOwners([{id:'tire',visualIds:['tire','tread','rim']},{id:'hub'}],['tire','tread','rim','hub'].map(id=>({id})));
  const bonds=groupJoints([{a:'tread',b:'tire',area:1},{a:'rim',b:'hub',area:.2,normal:[1,0,0]},{a:'tire',b:'hub',area:.1,normal:[0,1,0]}],owners);
  expect(bonds).toHaveLength(2);
  expect(bonds.map((b:{a:string;b:string})=>[b.a,b.b])).toEqual([['tire','hub'],['tire','hub']]);
  expect(bonds.map((b:{area:number})=>b.area)).toEqual([.2,.1]);
  expect(()=>visualOwners([{id:'a',visualIds:['a','a']}],[{id:'a'}])).toThrow();
  expect(()=>visualOwners([{id:'a'}],[{id:'a'},{id:'b'}])).toThrow();
 });
 it('uses one 64-vertex wheel hull with the configured radius, width and axle',()=>{
  const radius=.4,halfHeight=.18,q=Math.SQRT1_2;
  const shape=simplePhysicsShape({type:'cylinder',radius,halfHeight,position:[1,2,3],rotation:[0,0,-q,q],vertices:[]});
  expect(shape.position).toEqual([-1,2,-3]);
  expect(shape.vertices).toHaveLength(64);
  for(const [x,y,z] of shape.vertices) {
   expect(Math.abs(x)).toBeCloseTo(halfHeight,10);
   expect(Math.hypot(y,z)).toBeCloseTo(radius,10);
  }
  expect(radius*(1-Math.cos(Math.PI/32))).toBeLessThan(.002);
 });
 it('preserves the authored box vertices and rejects oversized inspection envelopes',()=>{
  const vertices=[[-1,-2,-3],[1,-2,-3],[-1,2,-3],[1,2,-3],[-1,-2,3],[1,-2,3],[-1,2,3],[1,2,3]];
  const shape=simplePhysicsShape({type:'cuboid',position:[0,0,0],vertices});
  expect(shape.vertices[0]).toEqual([1,-2,3]);
  expect(()=>simplePhysicsShape({type:'convex',position:[0,0,0],vertices:Array(128).fill([1,1,1])})).toThrow();
 });
});
