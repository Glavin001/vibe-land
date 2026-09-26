import { expect, it } from 'vitest';
import { AcousticOcclusion } from './occlusion';
it('budgets and caches queries, then hears a newly destroyed wall',()=>{
  let wall=true,calls=0;const c=new AcousticOcclusion(()=>{calls++;return wall?{toi:3}:null;});
  expect(c.sample([0,1,0],[10,1,0],100)).toBeGreaterThan(0);
  c.sample([0,1,0],[10,1,0],110);expect(calls).toBe(1);
  wall=false;expect(c.sample([0,1,0],[10,1,0],400)).toBe(0);
  for(let i=0;i<100;i++)c.sample([0,1,0],[20+i*4,1,0],401);
  expect(calls).toBeLessThanOrEqual(7);
});
