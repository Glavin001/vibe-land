import { describe, expect, it } from 'vitest';
import { eventMix, sourceAttenuation, voiceImportance } from './destructionMix';
import { DEFAULT_AUDIO } from './settings';
import type { SoundEvent } from './model';

const event=(size:number,intensity=.7):SoundEvent=>({id:'hit',kind:'impact',material:'stone',position:[0,0,-4],intensity,size,seed:1,atMs:0});
describe('weight and dynamics of destruction',()=>{
  it('gives a falling slab broad body while keeping pebbles small',()=>{
    const pebble=eventMix(event(.12),DEFAULT_AUDIO),slab=eventMix(event(3),DEFAULT_AUDIO);
    expect(pebble.body).toBe(0);
    expect(slab.body).toBeGreaterThan(.8);
    expect(slab.body).toBeGreaterThan(slab.detail*2);
    expect(slab.hit).toBeGreaterThan(.65);
  });
  it('keeps material distinctions and low energy movement quiet',()=>{
    expect(eventMix({...event(4),material:'glass'},DEFAULT_AUDIO).body).toBe(0);
    expect(eventMix(event(4,.05),DEFAULT_AUDIO).body).toBe(0);
    expect(eventMix(event(4,.05),DEFAULT_AUDIO).hit).toBeLessThan(.12);
    expect(eventMix(event(4),{...DEFAULT_AUDIO,bass:0}).body).toBe(0);
  });
  it('preserves a useful dynamic range across presets without changing master volume',()=>{
    for(const dynamicRange of ['cinematic','balanced','night'] as const){
      const s={...DEFAULT_AUDIO,dynamicRange};
      const large=eventMix(event(4,.9),s),small=eventMix(event(.2,.2),s);
      expect(Math.hypot(large.hit,large.body)).toBeGreaterThan(Math.hypot(small.hit,small.body)*2);
    }
  });
  it('lets a large source fill nearby space but still fall off with distance',()=>{
    expect(sourceAttenuation(4,4)).toBeCloseTo(1);
    expect(sourceAttenuation(30,4)).toBeGreaterThan(sourceAttenuation(30,.1));
    expect(sourceAttenuation(150,4)).toBeLessThan(sourceAttenuation(4,4)*.2);
    expect(sourceAttenuation(0,4)).toBe(1);
  });
  it('replaces distant and decayed voices before a fresh nearby impact',()=>{
    expect(voiceImportance(.8,3,2,0,'impact')).toBeGreaterThan(voiceImportance(.8,50,2,0,'impact')*2);
    expect(voiceImportance(.8,3,2,2,'impact')).toBeLessThan(voiceImportance(.8,3,2,0,'impact')*.3);
    expect(voiceImportance(.8,3,2,2,'activity')).toBeCloseTo(voiceImportance(.8,3,2,0,'activity'));
  });
});
