import { describe, expect, it } from 'vitest';
import { DustImpactDetector } from '../city/dustImpacts';
import { DustSourceQueue, type DustSource } from '../city/destructionEvents';
import { CityImpactAudioQueue, type CityAudioImpact } from './cityImpactSources';

describe('city impact audio evidence',()=>{
  it('hears a two metre-per-second heavy stop without raising visual dust',()=>{
    const queue=new CityImpactAudioQueue(),detector=new DustImpactDetector(),dust=new DustSourceQueue();
    const observe=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,2);
    detector.noteVelocity(7,0,10,0,3,0,0,-2,0,5000,3,1000,dust,observe);
    expect(detector.noteVelocity(7,0,13,0,2.9,0,0,0,0,5000,3,1050,dust,observe)).toBe(false);
    expect(dust.size()).toBe(0);
    const impacts:CityAudioImpact[]=[];queue.drain((_source,impact)=>{if(impact)impacts.push(impact);});
    expect(impacts).toHaveLength(1);
    expect(impacts[0].intensity).toBeGreaterThan(.75);
  });
  it('keeps small jitter, freefall, ballistic slowing and nonfinite samples quiet at the lower audio threshold',()=>{
    const cases=[
      {before:[0,-1,0],after:[0,0,0],ticks:3},
      {before:[0,-2,0],after:[0,-2.5,0],ticks:3},
      {before:[0,2,0],after:[0,.038,0],ticks:12},
      {before:[0,0,0],after:[0,-2,0],ticks:3},
      {before:[0,-2,0],after:[NaN,0,0],ticks:3},
    ] as const;
    for(const c of cases){
      const queue=new CityImpactAudioQueue(),detector=new DustImpactDetector(),dust=new DustSourceQueue();
      const observe=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,2);
      detector.noteVelocity(7,0,10,0,3,0,...c.before,5000,3,1000,dust,observe);
      detector.noteVelocity(7,0,10+c.ticks,0,2.9,0,...c.after,5000,3,1200,dust,observe);
      expect(queue.drain(()=>{})).toBe(0);
    }
  });
  it('keeps the audio cooldown independent of visual impacts and their source ordinals',()=>{
    const queue=new CityImpactAudioQueue(),withAudio=new DustImpactDetector(),withoutAudio=new DustImpactDetector();
    const a=new DustSourceQueue(),b=new DustSourceQueue();
    const observe=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,2);
    for(const [tick,vy,ms] of [[10,-2,1000],[13,0,1050],[16,-6,1100],[19,0,1150],[31,-2,1350],[34,0,1400]]){
      withAudio.noteVelocity(7,0,tick,0,3,0,0,vy,0,5000,3,ms,a,observe);
      withoutAudio.noteVelocity(7,0,tick,0,3,0,0,vy,0,5000,3,ms,b);
    }
    const visualA:DustSource[]=[],visualB:DustSource[]=[];
    a.drain(s=>visualA.push({...s}));b.drain(s=>visualB.push({...s}));
    expect(visualA).toEqual(visualB);
    expect(visualA.filter(s=>s.kind==='impact')).toHaveLength(1);
    expect(queue.drain(()=>{})).toBe(2);
  });
  it('retains material, mass and exact body identity beyond the visual and flyby budgets',()=>{
    const queue=new CityImpactAudioQueue(),detector=new DustImpactDetector(),dust=new DustSourceQueue(1);
    for(let id=0;id<600;id++){
      const observe=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,id%3);
      detector.noteVelocity(0x80000000+id,3,30,4,4,0,0,-6,0,1000,3,1000,dust,observe);
      detector.noteVelocity(0x80000000+id,3,33,4,3.7,0,0,0,0,1000,3,1050,dust,observe);
    }
    const impacts:CityAudioImpact[]=[];
    expect(queue.drain((_source,impact)=>{if(impact)impacts.push(impact);})).toBe(512);
    expect(impacts[400]).toMatchObject({entityId:0x80000000+400,mass:1000,size:3,material:1});
    expect(impacts[400].intensity).toBeGreaterThan(.8);
    expect(queue.drain(()=>{})).toBe(0);
  });
  it('rejects phantom audio on teleports and long gaps without changing visual detection',()=>{
    for(const tick of [13,100]){
      const queue=new CityImpactAudioQueue(),detector=new DustImpactDetector(),dust=new DustSourceQueue();
      const observe=(source:Parameters<CityImpactAudioQueue['noteImpact']>[0],evidence:Parameters<CityImpactAudioQueue['noteImpact']>[1])=>queue.noteImpact(source,evidence,60,0);
      detector.noteVelocity(7,0,10,0,4,0,0,-8,0,1000,3,1000,dust,observe);
      expect(detector.noteVelocity(7,0,tick,tick===13?80:0,3.6,0,0,0,0,1000,3,1050,dust,observe)).toBe(true);
      expect(queue.drain(()=>{})).toBe(0);
    }
  });
  it('keeps structural breaks but excludes unvalidated impact, release and visual wave sources',()=>{
    const queue=new CityImpactAudioQueue();
    const source:DustSource={kind:'fracture',structureId:1,simTick:30,ordinal:0,x:0,y:0,z:0,nx:0,ny:1,nz:0,vx:0,vy:0,vz:0,magnitude:8,count:1,material:2,atMs:1000};
    for(const kind of ['fracture','entry','impact','shed','wave'] as const)queue.pushDestruction({...source,kind});
    const events:DustSource[]=[];queue.drain(s=>events.push({...s}));
    expect(events.map(s=>s.kind)).toEqual(['fracture','entry']);
    queue.pushDestruction(source);queue.clear();expect(queue.drain(()=>{})).toBe(0);
  });
});
