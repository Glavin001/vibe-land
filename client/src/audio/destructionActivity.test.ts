import { describe, expect, it } from 'vitest';
import { DestructionActivity } from './destructionActivity';
import type { SoundEvent } from './model';
const event=(id:number,patch:Partial<SoundEvent>={}):SoundEvent=>({id:String(id),kind:'impact',position:[-3,1,-4],material:'concrete',intensity:.65,size:2,seed:id,atMs:1000,...patch});

describe('bounded spatial destruction activity',()=>{
  it('retains the energy of dense contacts in at most four spatial emitters',()=>{
    const field=new DestructionActivity();
    for(let i=0;i<10000;i++)field.add(event(i,{position:[i%50-25,i%6,i%47-23]}),[0,0,0],1000);
    const beds=field.sample(1000,[0,0,0]);
    expect(field.regionCount).toBeLessThanOrEqual(64);
    expect(beds.length).toBeGreaterThan(0);expect(beds.length).toBeLessThanOrEqual(4);
    expect(beds.every(b=>b.intensity>0&&b.intensity<=1)).toBe(true);
    expect(field.sample(10000,[0,0,0])).toHaveLength(0);
    expect(field.regionCount).toBe(0);
  });
  it('keeps opposite materials in their own positions and follows actual activity',()=>{
    const field=new DestructionActivity();
    for(let i=0;i<12;i++){
      field.add(event(i),[0,0,0],1000);
      field.add(event(i+20,{position:[5,3,4],material:'metal'}),[0,0,0],1000);
    }
    const beds=field.sample(1000,[0,0,0]);expect(beds).toHaveLength(2);
    expect(beds.find(b=>b.material==='metal')!.position).toEqual([5,3,4]);
    expect(beds.find(b=>b.material==='concrete')!.position).toEqual([-3,1,-4]);
    const later=field.sample(2000,[0,0,0]);
    expect(later[0].intensity).toBeLessThan(beds[0].intensity);
    field.clear();expect(field.sample(2010,[0,0,0])).toEqual([]);
  });
  it('does not sound future, stale, duplicate, distant, or non-destruction facts',()=>{
    const field=new DestructionActivity();
    for(let i=0;i<12;i++)field.add(event(i,{atMs:1200}),[0,0,0],1000);
    expect(field.sample(1000,[0,0,0])).toEqual([]);
    expect(field.sample(1200,[0,0,0])).toHaveLength(1);
    const single=new DestructionActivity(),duplicates=new DestructionActivity();
    single.add(event(1),[0,0,0],1000);
    for(let i=0;i<100;i++)duplicates.add(event(1),[0,0,0],1000);
    expect(duplicates.sample(1000,[0,0,0])).toEqual(single.sample(1000,[0,0,0]));
    const silent=new DestructionActivity();
    for(let i=0;i<100;i++){
      silent.add(event(i,{kind:'flyby'}),[0,0,0],1000);
      silent.add(event(i+200,{kind:'shot'}),[0,0,0],1000);
      silent.add(event(i+400,{atMs:0}),[0,0,0],1000);
      silent.add(event(i+600,{position:[300,0,0]}),[0,0,0],1000);
    }
    expect(silent.sample(1000,[0,0,0])).toEqual([]);
  });
  it('does not make one pebble sound like a building and grows with the number of impacts',()=>{
    const quiet=new DestructionActivity(),busy=new DestructionActivity();
    quiet.add(event(1,{size:.1,intensity:.15}),[0,0,0],1000);
    expect(quiet.sample(1000,[0,0,0])).toEqual([]);
    for(let i=0;i<10;i++)busy.add(event(i),[0,0,0],1000);
    const fewer=new DestructionActivity();fewer.add(event(0),[0,0,0],1000);
    expect(busy.sample(1000,[0,0,0])[0].intensity).toBeGreaterThan(fewer.sample(1000,[0,0,0])[0]?.intensity??0);
  });
  it('lets new destruction replace old loud regions kept alive only by quiet contacts',()=>{
    const field=new DestructionActivity(),listener=[0,1.7,0] as const;
    // These separated regions contend for admission in the bounded field.
    // Exercise only public add/sample behavior: historical loudness must not
    // reserve storage forever when the current contacts are nearly silent.
    const old=[
      {material:'concrete' as const,position:[1,1,-39] as const},
      {material:'earth' as const,position:[-19,1,-39] as const},
    ];
    let id=0;
    for(const source of old)field.add(event(id++,{...source,kind:'collapse',intensity:1,size:30}),listener,1000);
    field.sample(1000,listener);
    for(let atMs=1100;atMs<=13000;atMs+=100){
      for(const source of old)field.add(event(id++,{...source,atMs,intensity:.21,size:.01}),listener,atMs);
      field.sample(atMs,listener);
    }
    expect(field.sample(13000,listener)).toEqual([]);
    field.add(event(id++,{atMs:13000,material:'sheet',position:[-49,1,-9],intensity:.8,size:12}),listener,13000);
    expect(field.sample(13000,listener).map(b=>b.material)).toEqual(['sheet']);
  });
  it('stays spatially stable between frames and rejects malformed values',()=>{
    const field=new DestructionActivity();
    for(let i=0;i<30;i++)field.add(event(i,{position:[i%5*11-22,1,-4]}),[0,0,0],1000);
    const first=field.sample(1000,[0,0,0]).map(b=>b.id).sort();
    expect(field.sample(1016,[.1,0,0]).map(b=>b.id).sort()).toEqual(first);
    field.add(event(70,{position:[NaN,0,0]}),[0,0,0],1000);
    field.add(event(71,{size:Infinity}),[0,0,0],1000);
    expect(field.sample(1016,[0,0,0]).every(b=>b.position.every(Number.isFinite)&&Number.isFinite(b.intensity))).toBe(true);
  });
});
