import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DestructionAudio } from './engine';

const controls = vi.hoisted(() => ({
  settings: {enabled:true,master:.65,output:'headphones',preset:'cinematic',dynamicRange:'balanced',impact:1,detail:.8,bass:.9,space:.65,flyby:1,ringing:0,maxVoices:24},
  listeners: new Set<() => void>(),
}));
vi.mock('./settings', () => ({
  audioSettings: () => controls.settings,
  subscribeAudioSettings: (fn: () => void) => { controls.listeners.add(fn); return () => controls.listeners.delete(fn); },
}));

class Param {
  value=0;
  targets:number[]=[];
  values:number[]=[];
  setTargetAtTime(value:number) { this.value=value; this.targets.push(value); }
  setValueAtTime(value:number) { this.value=value; this.values.push(value); }
  linearRampToValueAtTime(value:number) { this.value=value; }
  exponentialRampToValueAtTime(value:number) { this.value=value; }
  cancelScheduledValues() {}
}
class Node {
  connections:Node[]=[];
  disconnected=false;
  gain=new Param(); frequency=new Param(); Q=new Param(); playbackRate=new Param();
  positionX=new Param(); positionY=new Param(); positionZ=new Param();
  channelCount=2; channelCountMode='max'; channelInterpretation='speakers';
  start=vi.fn(); stop=vi.fn();
  onended:(() => void)|null=null;
  connect(target:Node) {this.connections.push(target);return target;}
  disconnect() {this.disconnected=true;this.connections=[];}
}
class Context {
  static all:Context[]=[];
  sampleRate=100; currentTime=1; baseLatency=0; outputLatency=0; state='suspended';
  destination=Object.assign(new Node(),{maxChannelCount:8});
  listener=Object.fromEntries(['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(key=>[key,new Param()]));
  audioWorklet={addModule:vi.fn(async()=>{throw new Error('worklet unavailable in mock');})};
  sources:Node[]=[]; oscillators:Node[]=[]; convolvers:Node[]=[];
  constructor() {Context.all.push(this);}
  resume=vi.fn(async()=>{this.state='running';});
  suspend=vi.fn(async()=>{this.state='suspended';});
  createGain() {return new Node();}
  createBiquadFilter() {return new Node();}
  createWaveShaper() {return new Node();}
  createConvolver() {const node=new Node();this.convolvers.push(node);return node;}
  createChannelSplitter() {return new Node();}
  createChannelMerger() {return new Node();}
  createPanner() {return new Node();}
  createOscillator() {const node=new Node();this.oscillators.push(node);return node;}
  createBufferSource() {const node=new Node();this.sources.push(node);return node;}
  createBuffer(channels:number,length:number) {const data=Array.from({length:channels},()=>new Float32Array(length));return {getChannelData:(i:number)=>data[i],duration:length/this.sampleRate};}
  async decodeAudioData() {return this.createBuffer(1,100);}
}
let engine:DestructionAudio;
const setSettings=(patch:Partial<typeof controls.settings>)=>{Object.assign(controls.settings,patch);controls.listeners.forEach(fn=>fn());};
const clipNames=['air','rumble','wind',...Array.from({length:4},(_,i)=>`flyby-${i}`),...Array.from({length:4},(_,i)=>`collapse-${i}`),...['concrete','metal'].flatMap(m=>[`heavy-${m}`,`debris-${m}`,`${m}-scrape`,...Array.from({length:5},(_,i)=>`${m}-impact-${i}`),...Array.from({length:3},(_,i)=>`${m}-fracture-${i}`)])];

beforeEach(async()=>{
  vi.resetModules(); Context.all=[];controls.listeners.clear();
  Object.assign(controls.settings,{enabled:true,output:'headphones',maxVoices:24,ringing:0});
  vi.stubGlobal('AudioContext',Context);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,status:200,json:async()=>({clips:Object.fromEntries(clipNames.map(name=>[name,{url:`/${name}.ogg`,duration:1}]))}),arrayBuffer:async()=>new ArrayBuffer(8)})));
  const {DestructionAudio}=await import('./engine');engine=new DestructionAudio();
});
afterEach(()=>{engine.stop();vi.unstubAllGlobals();});

function emitBatch(kind:'impact'|'flyby',frame:number,count=12) {
  const now=performance.now();
  for(let i=0;i<count;i++) engine.emit({id:`${kind}-${frame}-${i}`,kind,material:'concrete',position:[i*6,0,-2],intensity:.3,size:1,seed:i+frame*13,atMs:now});
  engine.update(now);
}

describe('audio renderer resource lifecycle',()=>{
  it('preserves the first transient instead of fading in the hit',async()=>{
    await engine.start();emitBatch('impact',0,1);
    const gain=Context.all[0].sources[0].connections[0].connections[0];
    expect(gain.gain.values.some(value=>value>.15)).toBe(true);
  });
  it('lets a new nearby wall impact replace distant debris at the ordinary voice cap',async()=>{
    await engine.start();emitBatch('impact',0);emitBatch('impact',1);
    const before=Context.all[0].sources.length,now=performance.now();
    engine.emit({id:'wall',kind:'impact',material:'concrete',position:[0,1,-2],intensity:.85,size:4,seed:6,atMs:now});engine.update(now);
    expect(Context.all[0].sources.length).toBeGreaterThan(before+1);
    expect(engine.diagnostics().voices).toBeLessThanOrEqual(12);
  });
  it('does not turn down the main collapse bus when a collapse happens',async()=>{
    await engine.start();const now=performance.now();
    engine.emit({id:'collapse',kind:'collapse',material:'concrete',position:[0,1,-2],intensity:1,size:6,seed:6,atMs:now});engine.update(now);
    const mainGain=Context.all[0].sources[0].connections[0].connections[0];
    const bus=mainGain.connections[0].connections[0];
    expect(bus.gain.values.some(value=>value>0&&value<1)).toBe(false);
  });
  it('keeps dense destruction present as bounded material beds after event reduction',async()=>{
    await engine.start();const now=performance.now();
    for(let i=0;i<10000;i++)engine.emit({id:`rubble-${i}`,kind:'impact',material:i%2?'metal':'concrete',position:[i%2?-3:3,1,-2],intensity:.6,size:2,seed:i,atMs:now});
    engine.update(now);
    expect(engine.diagnostics().activityEmitters).toBe(2);
    expect(engine.diagnostics().voices).toBeLessThanOrEqual(12);
    engine.stop();expect(engine.diagnostics().activityEmitters).toBe(0);
  });
  it('clears the old reflection tail before a replay or A/B restart',async()=>{
    await engine.start();const old=Context.all[0].convolvers[0];
    expect(old.disconnected).toBe(false);engine.stop();
    expect(old.disconnected).toBe(true);
    expect(Context.all[0].convolvers.length).toBe(2);
  });
  it('lets a new near miss replace a protected impact when all voices are occupied',async()=>{
    await engine.start();const now=performance.now();
    for(let frame=0;frame<2;frame++){
      for(let i=0;i<12;i++)engine.emit({id:`hero-${frame}-${i}`,kind:'impact',material:'concrete',position:[0,0,-5],intensity:.3,size:1,seed:i,atMs:now,protected:true});
      engine.update(now);
    }
    expect(engine.diagnostics().voices).toBe(24);
    const before=Context.all[0].sources.length;emitBatch('flyby',99,1);
    expect(Context.all[0].sources.length).toBe(before+1);
    expect(engine.diagnostics().voices).toBe(24);
  });
  it('allows approaching air to replace a quieter friction emitter at the loop cap',async()=>{
    await engine.start();
    for(let i=0;i<10;i++)engine.continuous({id:`floor-${i}`,kind:'scrape',material:'concrete',position:[50,0,-50],speed:2,intensity:.2});
    const before=Context.all[0].sources.length;
    engine.continuous({id:'incoming',kind:'air',material:'metal',position:[2,1,-3],speed:60,intensity:.9});
    expect(Context.all[0].sources.length).toBe(before+1);
    expect(engine.diagnostics().voices).toBe(10);
  });
  it('applies a smaller voice budget immediately to an already busy mix',async()=>{
    setSettings({maxVoices:64});await engine.start();
    for(let frame=0;frame<5;frame++)emitBatch('impact',frame);
    expect(engine.diagnostics().voices).toBeGreaterThan(24);
    setSettings({maxVoices:24});
    expect(engine.diagnostics().voices).toBeLessThanOrEqual(24);
  });
  it('unlocks once and shares a concurrent palette load',async()=>{
    await Promise.all([engine.start(),engine.start()]);
    expect(Context.all).toHaveLength(1);
    expect(Context.all[0].audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(engine.diagnostics().loaded).toBe(clipNames.length);
    expect(engine.diagnostics().limiter).toBe('Soft saturation fallback');
  });
  it('reserves voices for threats and enforces the hard total and spatial caps',async()=>{
    await engine.start();
    emitBatch('impact',0);emitBatch('impact',1);
    expect(engine.diagnostics().voices).toBeLessThanOrEqual(12);
    emitBatch('flyby',2);emitBatch('flyby',3);
    expect(engine.diagnostics().voices).toBe(24);
    expect(engine.diagnostics().spatialVoices).toBeLessThanOrEqual(28);
    expect(engine.diagnostics().droppedVoices).toBeGreaterThan(0);
    expect(Context.all[0].sources.every(source=>source.start.mock.calls.length===1)).toBe(true);
    engine.stop();
    expect(engine.diagnostics().voices).toBe(0);
    expect(Context.all[0].sources.every(source=>source.stop.mock.calls.length>0&&source.disconnected)).toBe(true);
  });
  it('bounds continuous sources and clears both queued and playing effects on mute',async()=>{
    await engine.start();
    for(let i=0;i<50;i++)engine.continuous({id:String(i),kind:'scrape',material:'concrete',position:[0,0,0],speed:2,intensity:.5});
    expect(engine.diagnostics().voices).toBe(10);
    engine.emit({id:'future',kind:'impact',material:'concrete',position:[0,0,0],intensity:.5,size:1,seed:1,atMs:performance.now()+1000});
    expect(engine.diagnostics().queued).toBe(1);
    setSettings({enabled:false});
    expect(engine.diagnostics().voices).toBe(0);
    expect(engine.diagnostics().queued).toBe(0);
    engine.continuous({id:'muted',kind:'scrape',material:'concrete',position:[0,0,0],speed:2,intensity:.5});
    emitBatch('flyby',9);
    expect(engine.diagnostics().voices).toBe(0);
  });
  it('does not rebuild a backlog while the browser has suspended audio',async()=>{
    await engine.start();emitBatch('flyby',0);await engine.suspend();
    engine.emit({id:'hidden',kind:'impact',material:'concrete',position:[0,0,0],intensity:.5,size:1,seed:1,atMs:performance.now()});
    engine.continuous({id:'hidden-loop',kind:'scrape',material:'concrete',position:[0,0,0],speed:2,intensity:.5});
    expect(engine.diagnostics().voices).toBe(0);
    expect(engine.diagnostics().queued).toBe(0);
    await engine.resume();engine.update();
    expect(engine.diagnostics().voices).toBe(0);
  });
  it('keeps an expired loop silent when listener updates arrive before onended',async()=>{
    await engine.start();const now=performance.now();
    engine.continuous({id:'settling',kind:'scrape',material:'concrete',position:[0,0,0],speed:2,intensity:.5},now);
    const source=Context.all[0].sources[0];
    const gain=source.connections[0].connections[0];
    engine.update(now+500);
    expect(gain.gain.targets.at(-1)).toBe(0);
    engine.setListener([1,0,0]);
    expect(gain.gain.targets.at(-1)).toBe(0);
    expect(source.stop).toHaveBeenCalledTimes(1);
  });
  it('stops channel audition oscillators when the user stops audio',async()=>{
    await engine.start();engine.testChannel(0);
    const source=Context.all[0].oscillators[0];
    const calls=source.stop.mock.calls.length;
    engine.stop();
    expect(source.stop.mock.calls.length).toBeGreaterThan(calls);
    expect(source.disconnected).toBe(true);
  });
});
