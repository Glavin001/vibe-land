import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DestructionAudio } from './engine';
import type { PaletteChoices } from './soundPalette';

const controls = vi.hoisted(() => ({
  settings: {enabled:true,master:.65,output:'headphones',preset:'cinematic',dynamicRange:'balanced',impact:1,detail:.8,bass:.9,space:.65,flyby:1,ringing:0,maxVoices:24,acoustics:'dry',palette:{} as PaletteChoices},
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
  targetTimes:number[]=[];
  setTargetAtTime(value:number,time=0) { this.value=value; this.targets.push(value); this.targetTimes.push(time); }
  setValueAtTime(value:number) { this.value=value; this.values.push(value); }
  linearRampToValueAtTime(value:number) { this.value=value; }
  exponentialRampToValueAtTime(value:number) { this.value=value; }
  cancelScheduledValues() {}
}
class Node {
  buffer:{tag?:string;duration?:number}|null=null;
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
  sources:Node[]=[]; oscillators:Node[]=[]; convolvers:Node[]=[]; panners:Node[]=[];
  constructor() {Context.all.push(this);}
  advance(seconds:number) {this.currentTime+=seconds;for(const source of this.sources){const stop=source.stop.mock.calls.at(-1);if(stop&&!source.disconnected&&(stop[0]??0)<=this.currentTime)source.onended?.();}}
  resume=vi.fn(async()=>{this.state='running';});
  suspend=vi.fn(async()=>{this.state='suspended';});
  createGain() {return new Node();}
  createBiquadFilter() {return new Node();}
  createWaveShaper() {return new Node();}
  createConvolver() {const node=new Node();this.convolvers.push(node);return node;}
  createChannelSplitter() {return new Node();}
  createChannelMerger() {return new Node();}
  createPanner() {const node=new Node();this.panners.push(node);return node;}
  createOscillator() {const node=new Node();this.oscillators.push(node);return node;}
  createBufferSource() {const node=new Node();this.sources.push(node);return node;}
  createBuffer(channels:number,length:number) {const data=Array.from({length:channels},()=>new Float32Array(length));return {getChannelData:(i:number)=>data[i],duration:length/this.sampleRate,sampleRate:this.sampleRate};}
  async decodeAudioData(bytes:{tag?:string}) {return {...this.createBuffer(1,bytes.tag?.includes('Collapse-')?640:100),tag:bytes.tag};}
}
let engine:DestructionAudio;
const setSettings=(patch:Partial<typeof controls.settings>)=>{controls.settings={...controls.settings,...patch};controls.listeners.forEach(fn=>fn());};
const clipNames=['air','rumble','wind',...Array.from({length:4},(_,i)=>`flyby-${i}`),...Array.from({length:4},(_,i)=>`collapse-${i}`),...['concrete','metal'].flatMap(m=>[`heavy-${m}`,`debris-${m}`,`${m}-scrape`,...Array.from({length:5},(_,i)=>`${m}-impact-${i}`),...Array.from({length:3},(_,i)=>`${m}-fracture-${i}`)])];
const paletteSlots=['masonryImpact','masonryCollapse','metalImpact','metalCollapse','projectileFlyby','debrisFlyby','massiveFlyby'] as const;
const originalPalette=Object.fromEntries(paletteSlots.map(slot=>[slot,'original'])) as PaletteChoices;
function mockFetch(url:string) {
  const options=url.includes('/audio/options/');
  const names=options?paletteSlots.flatMap(slot=>['natural','designed'].map(choice=>`${slot}-${choice}`)):clipNames;
  return Promise.resolve({ok:true,status:200,json:async()=>({clips:Object.fromEntries(names.map(name=>[name,{url:options?`/audio/options/${name}.wav`:`/${name}.ogg`,duration:1,passAtSeconds:.25}]))}),arrayBuffer:async()=>({tag:url})});
}

beforeEach(async()=>{
  vi.resetModules(); Context.all=[];controls.listeners.clear();
  Object.assign(controls.settings,{enabled:true,output:'headphones',maxVoices:24,ringing:0,acoustics:'dry',palette:{...originalPalette}});
  vi.stubGlobal('AudioContext',Context);
  vi.stubGlobal('fetch',vi.fn(mockFetch));
  const {DestructionAudio}=await import('./engine');engine=new DestructionAudio();
});
afterEach(()=>{engine.stop();vi.unstubAllGlobals();});

function emitBatch(kind:'impact'|'flyby',frame:number,count=12) {
  Context.all[0]?.advance(.016);
  const now=performance.now();
  for(let i=0;i<count;i++) engine.emit({id:`${kind}-${frame}-${i}`,kind,material:'concrete',position:[i*6,0,-2],intensity:.3,size:1,seed:i+frame*13,atMs:now});
  engine.update(now);
}

describe('audio renderer resource lifecycle',()=>{
  it('centers a future flyby at its presentation timestamp without adding another approach delay',async()=>{
    await engine.start();const clock=vi.spyOn(performance,'now').mockReturnValue(1000);
    try{
      const ctx=Context.all[0];
      engine.emit({id:'timed-pass',kind:'flyby',material:'metal',position:[0,1,0],velocity:[100,0,0],intensity:.8,size:.3,seed:2,atMs:1030});engine.update(1000);
      ctx.currentTime=1.03;engine.update(1030);
      expect(ctx.panners[0].positionX.value).toBeCloseTo(0,5);
    }finally{clock.mockRestore();}
  });
  it('moves object-specific flybys across the listener and drops their pitch on departure',async()=>{
    setSettings({palette:{...originalPalette,projectileFlyby:'designed',massiveFlyby:'natural'}});await engine.start();
    const ctx=Context.all[0],now=performance.now();
    engine.emit({id:'projectile',kind:'flyby',material:'metal',position:[0,1,0],velocity:[100,0,0],intensity:.8,size:.3,seed:2,atMs:now+30});engine.update(now);
    const source=ctx.sources[0],panner=ctx.panners[0],before=panner.positionX.value,approach=source.playbackRate.value;
    expect(source.buffer?.tag).toContain('projectileFlyby-designed');expect(before).toBeLessThan(0);
    ctx.advance(.1);engine.update(now+100);
    expect(panner.positionX.value).toBeGreaterThan(0);expect(source.playbackRate.value).toBeLessThan(approach);
    engine.stop();engine.emit({id:'meteor',kind:'flyby',material:'stone',position:[0,1,0],velocity:[45,0,0],intensity:.8,size:4,seed:2,atMs:performance.now()});engine.update();
    expect(ctx.sources.at(-1)?.buffer?.tag).toContain('massiveFlyby-natural');
  });
  it('replaces the heavy recipe and rubble bed with chosen masonry recordings',async()=>{
    setSettings({palette:{...originalPalette,masonryImpact:'natural',masonryCollapse:'designed'}});await engine.start();
    const now=performance.now();
    for(let i=0;i<10;i++)engine.emit({id:`brick-${i}`,kind:'impact',material:'concrete',position:[0,0,-3],intensity:.85,size:3,seed:i,atMs:now});engine.update(now);
    const clips=Context.all[0].sources.map(s=>s.buffer?.tag);
    expect(clips.some(s=>s?.includes('masonryImpact-natural'))).toBe(true);
    expect(clips.some(s=>s?.includes('masonryCollapse-designed'))).toBe(true);
    expect(clips.every(s=>s?.includes('/audio/options/'))).toBe(true);
  });
  it('previews without changing selected takes and keeps a finite rubble fade silent during listener updates',async()=>{
    await engine.auditionPalette('masonryCollapse','natural',{reflections:false});
    expect(controls.settings.palette.masonryCollapse).toBe('original');
    const ctx=Context.all[0],source=ctx.sources[0],gain=source.connections[0].connections[0];
    const end=source.stop.mock.calls[0][0];expect(end-source.start.mock.calls[0][0]).toBeCloseTo(6.4);
    ctx.currentTime=end-.02;engine.setListener([1,0,0]);
    expect(gain.gain.targets.at(-1)).toBe(0);
  });
  it('starts dry and applies reflections only when explicitly enabled',async()=>{
    await engine.start();const wet=Context.all[0].convolvers.at(-1)!.connections[0];
    expect(wet.gain.value).toBe(0);setSettings({acoustics:'reflections'});expect(wet.gain.value).toBeGreaterThan(0);
    setSettings({acoustics:'dry'});expect(wet.gain.value).toBe(0);
  });
  it('applies the room toggle during an active reference preview',async()=>{
    await engine.auditionPalette('metalImpact','natural',{reflections:false});
    const wet=Context.all[0].convolvers.at(-1)!.connections[0];expect(wet.gain.value).toBe(0);
    setSettings({acoustics:'reflections'});expect(wet.gain.value).toBeGreaterThan(0);
    setSettings({acoustics:'dry'});expect(wet.gain.value).toBe(0);
  });
  it('does not resurrect a cancelled preview after its recording finishes loading',async()=>{
    await engine.start();let finish!:()=>void;let requested!:()=>void;
    const loading=new Promise<void>(resolve=>{requested=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.includes('masonryImpact-natural.wav')){requested();await new Promise<void>(resolve=>{finish=resolve;});}return mockFetch(url);}));
    const preview=engine.auditionPalette('masonryImpact','natural',{reflections:false});await loading;
    engine.stop();finish();await expect(preview).rejects.toMatchObject({name:'AbortError'});expect(Context.all[0].sources).toHaveLength(0);
  });
  it('uses the current room setting when it changes while a reference recording downloads',async()=>{
    setSettings({acoustics:'reflections'});await engine.start();let finish!:()=>void;let requested!:()=>void;
    const loading=new Promise<void>(resolve=>{requested=resolve;});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.includes('masonryImpact-natural.wav')){requested();await new Promise<void>(resolve=>{finish=resolve;});}return mockFetch(url);}));
    const preview=engine.auditionPalette('masonryImpact','natural',{reflections:true});await loading;
    setSettings({acoustics:'dry'});finish();await preview;
    const wet=Context.all[0].convolvers.at(-1)!.connections[0];expect(wet.gain.value).toBe(0);
  });
  it('retains moving near-miss options when a later protected hit needs a voice',async()=>{
    setSettings({palette:{...originalPalette,projectileFlyby:'designed'}});await engine.start();const now=performance.now();
    engine.emit({id:'near-miss',kind:'flyby',material:'metal',position:[0,1,0],velocity:[100,0,0],intensity:.02,size:.3,seed:1,atMs:now});engine.update(now);
    const flight=Context.all[0].sources[0];expect(flight.buffer?.tag).toContain('projectileFlyby-designed');
    for(let frame=0;frame<4;frame++){Context.all[0].advance(.016);for(let i=0;i<12;i++)engine.emit({id:`protected-${frame}-${i}`,kind:'impact',material:'concrete',position:[0,0,-2],intensity:.8,size:1,seed:i,atMs:now,protected:true});engine.update(now);}
    expect(flight.stop).not.toHaveBeenCalled();
  });
  it('retains surrounding debris beds and fresh heavy hits during dense nearby protected impacts',async()=>{
    await engine.start();
    for(let frame=0;frame<8;frame++){
      Context.all[0].advance(.016);const now=performance.now();
      for(let i=0;i<12;i++)engine.emit({id:`heavy-${frame}-${i}`,kind:'impact',material:'concrete',position:[i%2?-3:3,1,-2],intensity:.85,size:3,seed:i+frame*12,atMs:now,protected:true});
      engine.update(now);
      expect(engine.diagnostics().voices).toBeLessThanOrEqual(24);
      expect(engine.diagnostics().activityEmitters).toBe(2);
    }
    expect(Context.all[0].sources.length).toBeGreaterThan(40);
  });
  it('delays distant debris energy until the same acoustic arrival as its impact',async()=>{
    await engine.start();const now=performance.now();
    for(let i=0;i<10;i++)engine.emit({id:`far-${i}`,kind:'impact',material:'concrete',position:[0,0,-100],intensity:.85,size:3,seed:i,atMs:now});
    engine.update(now);expect(engine.diagnostics().activityEmitters).toBe(0);
    Context.all[0].advance(.1);engine.update(now+100);expect(engine.diagnostics().activityEmitters).toBe(0);
    Context.all[0].advance(.12);engine.update(now+220);expect(engine.diagnostics().activityEmitters).toBe(1);
  });
  it('refreshes occlusion for sustained debris after the listener moves',async()=>{
    await engine.start();const now=performance.now();
    for(let i=0;i<10;i++)engine.emit({id:`occlusion-${i}`,kind:'impact',material:'concrete',position:[0,0,-4],intensity:.85,size:3,seed:i,atMs:now});
    const probe=vi.fn(()=>1);engine.update(now,probe);expect(probe).toHaveBeenCalledTimes(1);
    const bed=Context.all[0].sources.at(-1)!,filter=bed.connections[0];
    const obstructed=filter.frequency.targets.at(-1)!;
    Context.all[0].advance(.1);engine.update(now+100,()=>0);
    expect(filter.frequency.targets.at(-1)).toBeGreaterThan(obstructed*2);
  });
  it('preserves the first transient instead of fading in the hit',async()=>{
    await engine.start();emitBatch('impact',0,1);
    const gain=Context.all[0].sources[0].connections[0].connections[0];
    expect(gain.gain.values.some(value=>value>.15)).toBe(true);
  });
  it('lets a new nearby wall impact replace distant debris at the ordinary voice cap',async()=>{
    await engine.start();emitBatch('impact',0);emitBatch('impact',1);
    Context.all[0].advance(.016);
    const before=Context.all[0].sources.length,now=performance.now();
    engine.emit({id:'wall',kind:'impact',material:'concrete',position:[0,1,-2],intensity:.85,size:4,seed:6,atMs:now});engine.update(now);
    expect(Context.all[0].sources.length).toBeGreaterThan(before+1);
    expect(engine.diagnostics().voices).toBeLessThanOrEqual(24);
  });
  it('fades a replaced voice before its replacement starts and disconnects after it ends',async()=>{
    await engine.start();emitBatch('impact',0);Context.all[0].advance(.016);
    const now=performance.now();
    engine.emit({id:'replacement',kind:'impact',material:'concrete',position:[0,1,-1],intensity:.35,size:.2,seed:6,atMs:now});engine.update(now);
    const context=Context.all[0],retiring=context.sources.find(v=>v.stop.mock.calls.length>0&&!v.disconnected)!;
    expect(retiring).toBeDefined();expect(retiring.connections[0].connections[0].gain.targets.at(-1)).toBe(0);
    expect(retiring.stop.mock.calls.at(-1)![0]).toBeLessThan(context.sources.at(-1)!.start.mock.calls[0][0]);
    context.advance(.01);expect(retiring.disconnected).toBe(true);
  });
  it('starts random-phase loops at zero gain with ramps scheduled at playback time',async()=>{
    await engine.start();engine.continuous({id:'loop',kind:'scrape',material:'concrete',position:[1,0,0],speed:2,intensity:.6});
    const source=Context.all[0].sources[0],gain=source.connections[0].connections[0];
    expect(gain.gain.targetTimes.every(time=>time>=source.start.mock.calls[0][0])).toBe(true);
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
