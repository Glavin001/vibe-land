import { describe, expect, it } from 'vitest';
import { SoundMotionTracker } from './motion';
import type { SoundEvent, Vec3 } from './model';
const body=(position:Vec3,velocity:Vec3,nowMs:number)=>({id:'ball',position,velocity,nowMs,material:'metal' as const,mass:100,size:1});
describe('motion-driven fallback',()=>{
  it('retains previous samples across the combined city and ordinary-body budget',()=>{
    const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];
    for(let frame=0;frame<2;frame++)for(let i=0;i<600;i++)tracker.note({
      ...body([i%10,2-frame,-4],frame?[0,0,0]:[0,-15,0],frame*100),id:String(i),
    },[0,0,0],e=>heard.push(e));
    expect(heard.filter(e=>e.kind==='impact')).toHaveLength(600);
  });
  it('detects a swept near miss only once for a pass',()=>{const tracker=new SoundMotionTracker();const heard:SoundEvent[]=[];tracker.note(body([-8,1,0],[160,0,0],0),[0,0,0],e=>heard.push(e));tracker.note(body([8,1,0],[160,0,0],100),[0,0,0],e=>heard.push(e));tracker.note(body([10,1,0],[160,0,0],120),[0,0,0],e=>heard.push(e));expect(heard.filter(e=>e.kind==='flyby')).toHaveLength(1);});
  it('does not turn a teleport or gravity into an impact',()=>{const tracker=new SoundMotionTracker();const heard:SoundEvent[]=[];tracker.note(body([0,50,0],[0,-10,0],0),[0,0,0],e=>heard.push(e));tracker.note(body([0,49,0],[0,-11,0],100),[0,0,0],e=>heard.push(e));tracker.note(body([500,2,0],[0,0,0],200),[0,0,0],e=>heard.push(e));expect(heard).toHaveLength(0);});
  it('renders a sudden stop, but lets authoritative contacts take precedence',()=>{for(const authoritative of [true,false]){const tracker=new SoundMotionTracker(),heard:SoundEvent[]=[];tracker.note(body([1,2,-4],[0,-15,0],0),[0,0,0],e=>heard.push(e));tracker.note({...body([1,1,-4],[0,0,0],100),authoritative},[0,0,0],e=>heard.push(e));expect(heard.filter(e=>e.kind==='impact')).toHaveLength(authoritative?0:1);}});
});
