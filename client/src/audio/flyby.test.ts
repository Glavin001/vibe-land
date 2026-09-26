import {describe,expect,it} from 'vitest';
import {flybyMotion,flybyPose} from './flyby';
import type {SoundEvent} from './model';
const pass:SoundEvent={id:'slab',kind:'flyby',position:[0,3,0],material:'stone',intensity:.8,size:3,velocity:[60,0,0],seed:1,atMs:1000};
const readSamples=(motion:NonNullable<ReturnType<typeof flybyMotion>>,from:number,to:number,listener:readonly[number,number,number])=>{
  let sum=0;const steps=Math.ceil((to-from)/.0001),dt=(to-from)/steps;
  for(let i=0;i<steps;i++)sum+=flybyPose(motion,from+(i+.5)*dt,listener).rate*dt;
  return sum;
};
describe('moving near misses',()=>{
  it('aligns a future pass with the supplied presentation time while accounting for Doppler',()=>{
    const event={...pass,position:[0,1.1,0] as const,velocity:[100,0,0] as const,size:.5};
    const motion=flybyMotion(event,1,.23,.72,false,1.028,[0,0,0])!;
    expect(motion.passTime).toBe(1.028);
    expect(motion.offset+readSamples(motion,1,motion.passTime,[0,0,0])).toBeCloseTo(.23,3);
    expect(flybyPose(motion,motion.passTime,[0,0,0]).position).toEqual(event.position);
  });
  it('begins after the pressure peak for a late event and drops an exhausted pass',()=>{
    const event={...pass,position:[0,1.1,0] as const,velocity:[100,0,0] as const,size:.5};
    const motion=flybyMotion(event,1.04,.23,.72,false,1,[0,0,0])!;
    expect(motion.passTime).toBe(1);
    expect(motion.offset).toBeCloseTo(.23+readSamples(motion,1,1.04,[0,0,0]),3);
    expect(flybyPose(motion,1.04,[0,0,0]).position[0]).toBeCloseTo(4);
    expect(flybyMotion(event,2,.2,.4,false,1,[0,0,0])).toBeNull();
  });
  it.each([30,100,300])('keeps the recorded pressure peak aligned with the moving full preview at %sm/s',speed=>{
    const listener=[100,20,-40] as const;
    const event={...pass,position:[100,21.1,-40] as const,velocity:[speed,0,0] as const,size:.5};
    const motion=flybyMotion(event,1,.23,.72,true,undefined,listener)!;
    const sampleTime=readSamples(motion,1,motion.passTime,listener);
    expect(motion.offset).toBe(0);
    expect(Math.abs(sampleTime-.23)/motion.rate).toBeLessThan(.002);
    expect(flybyPose(motion,motion.passTime,listener).position).toEqual(event.position);
  });
  it('does not depend on the world origin and rejects invalid timing or missing pre-pass samples',()=>{
    const origin=flybyMotion({...pass,position:[0,1.1,0]},1,.23,.72,false,1.03,[0,0,0])!;
    const translated=flybyMotion({...pass,position:[100,21.1,-40]},1,.23,.72,false,1.03,[100,20,-40])!;
    expect(translated.offset).toBeCloseTo(origin.offset);
    expect(flybyMotion(pass,NaN,.23,.72)).toBeNull();
    expect(flybyMotion(pass,1,.23,0)).toBeNull();
    expect(flybyMotion(pass,1,.02,.72,false,1.5)).toBeNull();
  });
  it('crosses the listener at the pressure peak and drops pitch after passing',()=>{
    const motion=flybyMotion(pass,1,.25,1.2,true)!;
    const before=flybyPose(motion,motion.passTime-.15,[0,1.7,0]),after=flybyPose(motion,motion.passTime+.15,[0,1.7,0]);
    expect(before.position[0]).toBeLessThan(0);expect(after.position[0]).toBeGreaterThan(0);
    expect(before.rate).toBeGreaterThan(after.rate);
    expect(flybyPose(motion,motion.passTime,[0,1.7,0]).position).toEqual(pass.position);
  });
  it('keeps a streamed pass responsive and leaves a full approach for previews',()=>{
    const live=flybyMotion(pass,1,.3,1.2)!,preview=flybyMotion(pass,1,.3,1.2,true)!;
    expect(live.passTime-1).toBeCloseTo(.04);expect(live.offset).toBeGreaterThan(.2);
    expect(preview.offset).toBe(0);expect(preview.passTime-1).toBeGreaterThan(.25);
  });
  it('requires real velocity and keeps extreme speeds finite',()=>{
    expect(flybyMotion({...pass,velocity:undefined},1,.2,1)).toBeNull();
    expect(flybyMotion({...pass,velocity:[NaN,0,0]},1,.2,1)).toBeNull();
    const m=flybyMotion({...pass,velocity:[300,0,0]},1,.2,1)!;
    expect(flybyPose(m,1,[0,0,0]).rate).toBeLessThan(2.4);
  });
});
