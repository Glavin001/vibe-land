import { describe, expect, it } from 'vitest';
import { AudioDirector } from './director';
import { acousticMaterial, closestPass, type SoundEvent } from './model';
import { resolveOutput, speakerGains } from './spatial';
import { sanitizeSettings } from './settings';
const event=(i:number,patch:Partial<SoundEvent>={}):SoundEvent=>({id:String(i),kind:'impact',position:[i%100,0,-10],material:'concrete',intensity:.5,size:1,seed:i,atMs:100,...patch});
describe('perceptual destruction budget',()=>{
  it('reduces a 10,000-contact storm, preserving a close threat',()=>{
    const d=new AudioDirector(128,12);
    for(let i=0;i<10000;i++)d.enqueue(event(i,{position:[i%200,Math.floor(i/200)%20,-40],material:i%2?'wood':'metal'}));
    d.enqueue(event(10001,{kind:'flyby',position:[.3,0,0],protected:true}));
    const heard:SoundEvent[]=[];d.drain(100,e=>heard.push(e));
    expect(d.queued).toBe(0);expect(heard.length).toBeLessThanOrEqual(12);expect(heard[0].kind).toBe('flyby');expect(d.stats.grouped).toBeGreaterThan(0);expect(d.stats.grouped+d.stats.dropped+heard.length).toBe(10001);
  });
  it('retains the strongest late threats without rescoring the full queue per insertion',()=>{
    class CountedDirector extends AudioDirector { evaluations=0; override score(e:SoundEvent):number {this.evaluations++;return super.score(e);} }
    const d=new CountedDirector(256,12);
    for(let i=0;i<10000;i++)d.enqueue(event(i,{position:[0,0,-20],protected:true,intensity:(i+1)/10000}));
    const heard:SoundEvent[]=[];d.drain(100,e=>heard.push(e));
    expect(heard.map(e=>e.id)).toEqual(Array.from({length:12},(_,i)=>String(9999-i)));
    expect(d.evaluations).toBeLessThan(50000);
    expect(d.queued).toBe(0);
  });
  it('updates cached priorities when the listener moves between insertions',()=>{
    const d=new AudioDirector(2,2);
    d.enqueue(event(1,{position:[0,0,0],protected:true}));
    d.enqueue(event(2,{position:[100,0,0],protected:true}));
    d.enqueue(event(3,{position:[1000,0,0],protected:true,intensity:.1}));
    d.listener=[100,0,0];
    d.enqueue(event(4,{position:[100,0,0],protected:true,intensity:.3}));
    const heard:SoundEvent[]=[];d.drain(100,e=>heard.push(e));
    expect(heard.map(e=>e.id)).toEqual(['2','4']);
  });
  it('repairs grouping priorities and keeps event positions independent of input mutation',()=>{
    const d=new AudioDirector(2,2);
    d.enqueue(event(1,{position:[0,0,-1],intensity:.1}));
    d.enqueue(event(2,{position:[6,0,-1],intensity:.6}));
    const strongest=event(3,{position:[0,0,-1],intensity:.95});
    d.enqueue(strongest);
    (strongest.position as [number,number,number])[0]=1000;
    d.enqueue(event(4,{position:[12,0,-1],intensity:.99}));
    const heard:SoundEvent[]=[];d.drain(100,e=>heard.push(e));
    expect(heard.map(e=>e.id)).toEqual(['3','4']);
    expect(heard[0].position).toEqual([0,0,-1]);
    expect(d.stats.grouped).toBe(1);
  });
  it('maintains deterministic ties and valid pending entries across partial drains and clear',()=>{
    const run=()=>{
      const d=new AudioDirector(4,2),heard:string[]=[];
      d.enqueue(event(4,{position:[0,0,0],protected:true}));
      d.enqueue(event(2,{position:[0,0,0],protected:true}));
      d.enqueue(event(8,{position:[0,0,0],protected:true,atMs:500}));
      d.drain(100,e=>heard.push(e.id));expect(d.queued).toBe(1);
      d.enqueue(event(9,{position:[0,0,0],protected:true,atMs:500}));
      d.drain(500,e=>heard.push(e.id));expect(d.queued).toBe(0);
      d.clear();d.enqueue(event(2,{position:[0,0,0],protected:true,atMs:600}));
      d.drain(600,e=>heard.push(e.id));return heard;
    };
    expect(run()).toEqual(['2','4','8','9','2']);expect(run()).toEqual(run());
  });
  it('matches a simple sorted oracle through repeated listener moves and replacements',()=>{
    const d=new AudioDirector(32,12),retained:SoundEvent[]=[];
    for(let i=0;i<2000;i++){
      if(i%113===0)d.listener=[(i*17)%200-100,0,(i*29)%200-100];
      const next=event(i,{protected:true,position:[(i*71)%250-125,0,(i*97)%250-125],intensity:((i*7919)%1000)/1000});
      d.enqueue(next);
      if(retained.length<32)retained.push(next);
      else{
        let weakest=0;
        for(let j=1;j<retained.length;j++)if(d.score(retained[j])<d.score(retained[weakest]))weakest=j;
        if(d.score(next)>d.score(retained[weakest]))retained.splice(weakest,1,next);
      }
    }
    const expected=retained.sort((a,b)=>d.score(b)-d.score(a)||a.seed-b.seed).slice(0,12).map(e=>e.id);
    const actual:string[]=[];d.drain(100,e=>actual.push(e.id));
    expect(actual).toEqual(expected);
  });
  it('drops late packets and rejects duplicate events',()=>{
    const d=new AudioDirector();d.enqueue(event(1));d.drain(100,()=>{});d.enqueue(event(1));d.enqueue(event(2,{atMs:-1000}));d.drain(100,()=>{throw Error('late/duplicate sound');});expect(d.stats.stale).toBe(1);
  });
  it('keeps opposite collapses spatially separate',()=>{
    const d=new AudioDirector();d.enqueue(event(1,{kind:'collapse',position:[-20,0,0]}));d.enqueue(event(2,{kind:'collapse',position:[20,0,0]}));const heard:SoundEvent[]=[];d.drain(100,e=>heard.push(e));expect(heard).toHaveLength(2);
  });
});
describe('spatial output',()=>{
  it('routes cardinal sources and preserves power across speaker gaps',()=>{
    const front=speakerGains(0,'surround51');expect(front[2]).toBeCloseTo(1);expect(front[3]).toBe(0);
    for(let angle=-Math.PI;angle<=Math.PI;angle+=.05)for(const mode of ['stereo','surround51','surround71'] as const){const g=speakerGains(angle,mode);expect([...g].reduce((s,v)=>s+v*v,0)).toBeCloseTo(1,5);expect([...g].every(v=>v>=0)).toBe(true);}
    expect(speakerGains(-Math.PI/2,'surround71')[6]).toBeCloseTo(1);expect(speakerGains(Math.PI/2,'surround71')[7]).toBeCloseTo(1);
  });
  it('falls back explicitly when surround is unavailable',()=>{expect(resolveOutput('surround71',2)).toBe('stereo');expect(resolveOutput('surround51',6)).toBe('surround51');});
  it('detects a flyby that crosses entirely between frames',()=>{const pass=closestPass([-10,1,0],[10,1,0],[0,0,0],[0,0,0]);expect(pass.distance).toBe(1);expect(pass.fraction).toBe(.5);});
});
it('maps authored material character and sanitizes persisted preferences',()=>{
  expect(acousticMaterial('corrugated steel panel')).toBe('sheet');expect(acousticMaterial('oak tree')).toBe('wood');
  const settings=sanitizeSettings({master:Infinity,maxVoices:10000,ringing:-2,output:'broken' as never});expect(settings.master).toBe(0);expect(settings.maxVoices).toBe(96);expect(settings.ringing).toBe(0);expect(settings.output).toBe('headphones');
});
