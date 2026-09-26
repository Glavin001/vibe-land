import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

function processor() {
  let Processor:any;
  runInNewContext(readFileSync(new URL('../../public/audio/destruction-limiter.js',import.meta.url),'utf8'),{
    AudioWorkletProcessor:class {port={postMessage:()=>{}};},Float32Array,Math,
    registerProcessor:(_name:string,ctor:any)=>{Processor=ctor;},
  });
  return new Processor();
}
describe('shipping multichannel limiter processor',()=>{
  it('bounds repeated overload impulses on all eight channels and preserves their ratio',()=>{
    const p=processor();let peak=0,nonzero=0;
    for(let block=0;block<100;block++){
      const input=Array.from({length:8},(_,c)=>Float32Array.from({length:128},(_,i)=>block<40?(i%37===0?40:2)*((c+1)/8):0));
      const output=Array.from({length:8},()=>new Float32Array(128));
      expect(p.process([input],[output])).toBe(true);
      for(let i=0;i<128;i++){
        for(const channel of output){expect(Number.isFinite(channel[i])).toBe(true);peak=Math.max(peak,Math.abs(channel[i]));}
        if(Math.abs(output[7][i])>.001){nonzero++;expect(output[0][i]/output[7][i]).toBeCloseTo(1/8,5);}
      }
    }
    expect(nonzero).toBeGreaterThan(100);expect(peak).toBeLessThanOrEqual(.890001);
  });
  it('has an exact 256 sample delay and flushes silence after disconnection',()=>{
    const p=processor(),rendered:number[]=[];
    for(let block=0;block<8;block++){
      const output=[new Float32Array(128)];const input=[new Float32Array(128)];
      if(block===0)input[0][0]=.1;
      p.process([block<3?input:[]],[output]);rendered.push(...output[0]);
    }
    expect(rendered.findIndex(n=>n!==0)).toBe(256);
    expect(rendered[256]).toBeCloseTo(.1);expect(rendered.slice(257).every(n=>n===0)).toBe(true);
  });
});
