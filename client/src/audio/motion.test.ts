import { describe, expect, it } from 'vitest';
import { classifyMotionImpact, SoundMotionTracker } from './motion';
import { physicalIntensity, type SoundEvent, type Vec3 } from './model';
const body=(position:Vec3,velocity:Vec3,nowMs:number)=>({id:'ball',position,velocity,nowMs,material:'metal' as const,mass:100,size:1});
describe('motion-driven fallback',()=>{
  it('gives heavy chunks a strong material impact at ordinary falling speed',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    tracker.note({...body([4,4,0],[0,-6,0],0),mass:1000,size:3,material:'concrete'},[0,0,0],e=>heard.push(e));
    tracker.note({...body([4,3.7,0],[0,0,0],50),mass:1000,size:3,material:'concrete'},[0,0,0],e=>heard.push(e));
    expect(heard).toEqual([expect.objectContaining({kind:'impact',material:'concrete',size:3,protected:true})]);
    expect(heard[0].intensity).toBeGreaterThan(.8);
    expect(physicalIntensity(2*6,2)).toBeLessThan(.3);
    expect(physicalIntensity(1000*6,1000)).toBeGreaterThan(physicalIntensity(100*6,100));
  });
  it('keeps a slow massive stop audible without treating smooth braking as a collision',()=>{
    const before={...body([3,3,0],[0,-2,0],0),mass:5000,size:3};
    expect(classifyMotionImpact(before,{...before,position:[3,2.9,0],velocity:[0,0,0],nowMs:50})?.intensity).toBeGreaterThan(.75);
    expect(classifyMotionImpact({...before,velocity:[4,0,0]}, {...before,velocity:[2.5,0,0],nowMs:250})).toBeNull();
  });
  it('rejects release, freefall, rising gravity slowdown, rest, stale samples, large gaps and teleports',()=>{
    const a={...body([4,4,0],[0,-6,0],100),mass:1000,size:3};
    const quiet=[
      [{...a,velocity:[0,0,0]}, {...a,velocity:[0,-6,0],nowMs:150}],
      [a,{...a,velocity:[0,-6.4905,0],nowMs:150}],
      [{...a,velocity:[0,4,0]}, {...a,velocity:[0,2.038,0],nowMs:300}],
      [{...a,velocity:[0,0,0]}, {...a,velocity:[0,0,0],nowMs:150}],
      [a,{...a,velocity:[0,0,0],nowMs:90}],
      [a,{...a,velocity:[0,0,0],nowMs:500}],
      [a,{...a,position:[80,0,0],velocity:[0,0,0],nowMs:150}],
    ] as const;
    for(const [before,after] of quiet)expect(classifyMotionImpact(before,after)).toBeNull();
  });
  it('copies mutable render samples and ignores stale packets without losing history',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    const position:[number,number,number]=[4,4,0],velocity:[number,number,number]=[0,-6,0];
    tracker.note({...body(position,velocity,100),sampleTimeMs:100,mass:1000,size:3},[0,0,0],e=>heard.push(e));
    tracker.note({...body([4,4,0],[0,0,0],110),sampleTimeMs:90,mass:1000,size:3},[0,0,0],e=>heard.push(e));
    position[1]=3.7;velocity[1]=0;
    tracker.note({...body(position,velocity,150),sampleTimeMs:150,mass:1000,size:3},[0,0,0],e=>heard.push(e));
    expect(heard.filter(e=>e.kind==='impact')).toHaveLength(1);
  });
  it('retains previous samples across the combined city and ordinary-body budget',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    for(let frame=0;frame<2;frame++)for(let i=0;i<600;i++)tracker.note({
      ...body([i%10,2-frame,-4],frame?[0,0,0]:[0,-15,0],frame*100),id:String(i),
    },[0,0,0],e=>heard.push(e));
    expect(heard.filter(e=>e.kind==='impact')).toHaveLength(600);
  });
  it('detects a swept near miss only once for a pass',()=>{const tracker=new SoundMotionTracker();const heard:SoundEvent[]=[];tracker.note(body([-8,1,0],[160,0,0],0),[0,0,0],e=>heard.push(e));tracker.note(body([8,1,0],[160,0,0],100),[0,0,0],e=>heard.push(e));tracker.note(body([10,1,0],[160,0,0],120),[0,0,0],e=>heard.push(e));expect(heard.filter(e=>e.kind==='flyby')).toHaveLength(1);});
  it('reports the world trajectory and exact closest-pass time for a moving listener',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    tracker.note({...body([4,1,5],[160,0,0],2000),material:'wood',size:4},[10,0,5],e=>heard.push(e));
    tracker.note({...body([20,1,5],[160,0,0],2100),material:'wood',size:4},[12,0,5],e=>heard.push(e));
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({kind:'flyby',material:'wood',size:4,velocity:[160,0,0],missDistance:1,protected:true});
    expect(heard[0].atMs).toBeCloseTo(2000+100*3/7);
    expect(heard[0].position[0]).toBeCloseTo(4+16*3/7);
    expect(heard[0].position.slice(1)).toEqual([1,5]);
  });
  it('uses simulation time for flight speed and presentation time for the closest pass',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    tracker.note({...body([-8,1,0],[160,0,0],5000),sampleTimeMs:1000,material:'sheet',size:.3},[0,0,0],e=>heard.push(e));
    tracker.note({...body([8,1,0],[160,0,0],5050),sampleTimeMs:1100,material:'sheet',size:.3},[0,0,0],e=>heard.push(e));
    expect(heard[0]).toMatchObject({material:'sheet',size:.3,velocity:[160,0,0],position:[0,1,0],atMs:5025,missDistance:1});
  });
  it('does not invent a fast pass when listener and object travel together',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    tracker.note(body([0,1,0],[16,0,0],0),[.05,0,0],e=>heard.push(e));
    tracker.note(body([1.6,1,0],[16,0,0],100),[1.55,0,0],e=>heard.push(e));
    expect(heard).toEqual([]);
  });
  it('does not turn a teleport or gravity into an impact',()=>{const tracker=new SoundMotionTracker();const heard:SoundEvent[]=[];tracker.note(body([0,50,0],[0,-10,0],0),[0,0,0],e=>heard.push(e));tracker.note(body([0,49,0],[0,-11,0],100),[0,0,0],e=>heard.push(e));tracker.note(body([500,2,0],[0,0,0],200),[0,0,0],e=>heard.push(e));expect(heard).toHaveLength(0);});
  it('renders a sudden stop, but lets authoritative contacts take precedence',()=>{for(const authoritative of [true,false]){const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];tracker.note(body([1,2,-4],[0,-15,0],0),[0,0,0],e=>heard.push(e));tracker.note({...body([1,1,-4],[0,0,0],100),authoritative},[0,0,0],e=>heard.push(e));expect(heard.filter(e=>e.kind==='impact')).toHaveLength(authoritative?0:1);}});
});
