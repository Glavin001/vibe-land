import { AudioDirector } from './director';
import { clamp, distance, seedRandom, type ContinuousSound, type SoundEvent, type Vec3 } from './model';
import { audioSettings, subscribeAudioSettings } from './settings';
import type { AudioSettings, OutputMode } from './settings';
import { azimuthOf, channelCount, resolveOutput, speakerGains } from './spatial';
import { DestructionActivity } from './destructionActivity';
import { eventMix, propagationDelayMs, sourceAttenuation, voiceImportance, type VoiceRole } from './destructionMix';
import { DEFAULT_PALETTE, PALETTE_SLOTS, paletteClipId, paletteSlotFor, type PaletteSlot,type PaletteChoice } from './soundPalette';
import { PaletteBank,referenceGain } from './paletteBank';
import { flybyMotion,flybyPose,type FlybyMotion } from './flyby';

interface Catalog { clips: Record<string,{url:string;duration:number}>; }
interface Voice {
  source:AudioBufferSourceNode; gain:GainNode; filter:BiquadFilterNode;
  nodes:AudioNode[]; panner?:PannerNode; channels?:GainNode[];
  position:Vec3; intensity:number; occlusion:number; protected:boolean;
  end:number; loopId?:string; lastUpdate:number; kind:string; baseRate:number;
  size:number; started:number; role:VoiceRole;
  flight?:FlybyMotion;attackUntil:number;fadeAt?:number;
}
export interface AudioDiagnostics {
  state:string; output:OutputMode; requestedOutput:OutputMode; maxChannels:number;
  voices:number; spatialVoices:number; peakVoices:number; droppedVoices:number;
  loaded:number; total:number; failures:string[]; peak:number; reduction:number;
  updateMs:number; queued:number; received:number; grouped:number; stale:number;
  selected:number; dropped:number; limiter:string; sampleRate:number; latencyMs:number;
  rms:number; activityEmitters:number;
}
const BANK = new Map<string,AudioBuffer>();
let bankLoading:Promise<void>|null=null;
let bankTotal=0;
const bankFailures:string[]=[];
function mono(ctx:BaseAudioContext):GainNode {const n=ctx.createGain();n.channelCount=1;n.channelCountMode='explicit';return n;}
function discrete(ctx:BaseAudioContext,channels:number):GainNode {const n=ctx.createGain();n.channelCount=channels;n.channelCountMode='explicit';n.channelInterpretation='discrete';return n;}
function impulse(ctx:BaseAudioContext):AudioBuffer {
  const result=ctx.createBuffer(2,Math.floor(ctx.sampleRate*1.7),ctx.sampleRate), random=seedRandom(1957);
  for(let c=0;c<2;c++){
    const a=result.getChannelData(c);let low=0;
    for(let i=0;i<a.length;i++){const t=i/ctx.sampleRate;low+=.28*(random()*2-1-low);a[i]=low*.12*Math.exp(-t*4.6)*Math.min(1,t/.025);}
    for(const [s,g] of [[.041,.22],[.079,.13],[.137,.08]])a[Math.floor((s+c*.003)*ctx.sampleRate)]+=g;
  }return result;
}
async function loadBank(ctx:BaseAudioContext):Promise<void>{
  if(bankLoading)return bankLoading;
  bankLoading=(async()=>{
    const response=await fetch('/audio/destruction/catalog.json?v=body-2');if(!response.ok)throw new Error('Sound catalog unavailable');
    const catalog=await response.json() as Catalog, entries=Object.entries(catalog.clips);bankTotal=entries.length;
    let index=0;
    await Promise.all(Array.from({length:6},async()=>{
      while(index<entries.length){const [id,clip]=entries[index++];
        try {const r=await fetch(`${clip.url}?v=body-2`);if(!r.ok)throw new Error(String(r.status));BANK.set(id,await ctx.decodeAudioData(await r.arrayBuffer()));}
        catch{bankFailures.push(id);}
      }
    }));
    if(!BANK.size)throw new Error('No audio clips could be decoded');
  })().catch(error=>{bankLoading=null;throw error;});return bankLoading;
}

/** One renderer owns the graph. Gameplay supplies world-space facts only. */
export class DestructionAudio {
  readonly director=new AudioDirector();
  private activity=new DestructionActivity();
  private options:PaletteBank|null=null;
  private paletteSignature='';
  private auditionGeneration=0;
  private roomRevision=0;
  private previewReflections:boolean|null=null;
  context:AudioContext|null=null;
  private master:GainNode|null=null;
  private output:AudioNode|null=null;
  private world:GainNode|null=null;
  private detail:GainNode|null=null;
  private threats:GainNode|null=null;
  private wetInput:GainNode|null=null;
  private wet:GainNode|null=null;
  private reflections:ConvolverNode|null=null;
  private graph:AudioNode[]=[];
  private voices=new Set<Voice>();
  private retiring=new Set<Voice>();
  private activitySlots=0;
  private loops=new Map<string,Voice>();
  private listener:Vec3=[0,0,0];
  private forward:Vec3=[0,0,-1];
  private mode:OutputMode='headphones';
  private lastSettings:AudioSettings=audioSettings();
  private startPromise:Promise<void>|null=null;
  private limiterLoaded=false;
  private lastDuck=-Infinity;
  private lastRing=-Infinity;
  private running=false;
  private recording:MediaRecorder|null=null;
  private recordingNode:MediaStreamAudioDestinationNode|null=null;
  private recordResolve:((blob:Blob)=>void)|null=null;
  private recordingRoutes:AudioNode[]=[];
  private transients=new Map<OscillatorNode,AudioNode[]>();
  private stats={state:'Click to enable sound',peakVoices:0,droppedVoices:0,peak:0,rms:0,reduction:0,updateMs:0,limiter:'pending'};
  constructor(){subscribeAudioSettings(()=>this.applySettings());}

  async start():Promise<void>{
    if(!this.context){this.context=new AudioContext({latencyHint:'interactive',sampleRate:48000});this.options=new PaletteBank(this.context);}
    // Resume on the gesture's stack, before fetching assets or worklet code.
    const resumed=this.context.resume();
    if(this.startPromise){await resumed;await this.startPromise;await this.warmPalette();return;}
    this.startPromise=(async()=>{
      this.stats.state='Loading sound palette…';await resumed;
      try{await this.context!.audioWorklet.addModule('/audio/destruction-limiter.js?v=body-2');this.limiterLoaded=true;}catch{this.limiterLoaded=false;}
      this.buildGraph();await loadBank(this.context!);await this.warmPalette();
      this.running=true;this.stats.state=bankFailures.length?'Ready · some clips unavailable':'Ready';
    })().catch(error=>{this.stats.state=String(error);this.startPromise=null;throw error;});
    return this.startPromise;
  }
  private async warmPalette():Promise<void>{
    if(!this.options)return;
    const selected=audioSettings().palette??DEFAULT_PALETTE;
    await Promise.allSettled(PALETTE_SLOTS.filter(slot=>selected[slot]!=='original').map(slot=>this.options!.load(slot,selected[slot])));
  }
  private selectedClip(slot:PaletteSlot|null):string|null{
    if(!slot)return null;const choice=(audioSettings().palette??DEFAULT_PALETTE)[slot];
    if(choice==='original')return null;
    const id=paletteClipId(slot,choice);return this.options?.get(id)?id:null;
  }
  private buildGraph():void{
    const ctx=this.context;if(!ctx)return;
    this.stop(false,false);this.graph.forEach(n=>n.disconnect());this.graph=[];
    this.mode=resolveOutput(audioSettings().output,ctx.destination.maxChannelCount||2);
    const channels=channelCount(this.mode);ctx.destination.channelCount=channels;ctx.destination.channelInterpretation='discrete';
    this.master=discrete(ctx,channels);this.world=discrete(ctx,channels);this.threats=discrete(ctx,channels);this.detail=discrete(ctx,channels);
    this.world.connect(this.master);this.threats.connect(this.master);this.detail.connect(this.world);
    if(this.limiterLoaded){
      const limiter=new AudioWorkletNode(ctx,'destruction-limiter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[channels],channelCount:channels,channelCountMode:'explicit',channelInterpretation:'discrete'});
      limiter.port.onmessage=e=>{this.stats.peak=e.data.peak;this.stats.reduction=e.data.reduction;this.stats.rms=e.data.rms??0;};
      this.master.connect(limiter).connect(ctx.destination);this.graph.push(limiter);this.stats.limiter='Linked lookahead';
      this.output=limiter;
    }else{
      // Bounded, multichannel fallback if worklets are unavailable. This is a
      // soft saturation stage, explicitly reported rather than called a limiter.
      const shaper=ctx.createWaveShaper(),curve=new Float32Array(4097);
      for(let i=0;i<curve.length;i++){const x=i/(curve.length-1)*2-1;curve[i]=.89*Math.tanh(x/.89);}
      shaper.curve=curve;shaper.oversample='2x';this.master.connect(shaper).connect(ctx.destination);this.graph.push(shaper);this.stats.limiter='Soft saturation fallback';
      this.output=shaper;
    }
    const convolver=ctx.createConvolver();convolver.buffer=impulse(ctx);convolver.normalize=false;
    this.reflections=convolver;
    this.wetInput=mono(ctx);this.wet=ctx.createGain();this.wetInput.connect(convolver).connect(this.wet);
    if(channels===2)this.wet.connect(this.world);
    else{
      const split=ctx.createChannelSplitter(2),merge=ctx.createChannelMerger(channels);this.wet.connect(split);this.graph.push(split,merge);
      for(const [input,output,amount] of [[0,0,.55],[1,1,.55],[0,4,.5],[1,5,.5],...(channels===8?[[0,6,.35],[1,7,.35]]:[])]){
        const g=mono(ctx);g.gain.value=amount;split.connect(g,input);g.connect(merge,0,output);this.graph.push(g);
      }merge.connect(this.world);
    }
    this.graph.push(this.master,this.world,this.threats,this.detail,this.wetInput,convolver,this.wet);
    if(this.recordingNode)this.connectRecording(this.recordingNode);
    this.applySettings();
  }
  private applySettings():void{
    const next=audioSettings(),ctx=this.context;
    if(next.acoustics!==this.lastSettings.acoustics){this.roomRevision++;this.previewReflections=null;}
    if(ctx&&this.master){
      const mode=resolveOutput(next.output,ctx.destination.maxChannelCount||2);
      if(mode!==this.mode){this.lastSettings=next;this.buildGraph();return;}
      this.master.gain.setTargetAtTime(next.enabled?next.master:0,ctx.currentTime,.03);
      this.wet?.gain.setTargetAtTime((this.previewReflections??(next.acoustics==='reflections'))?next.space*.36:0,ctx.currentTime,.03);
      const signature=JSON.stringify(next.palette);
      if(signature!==this.paletteSignature){this.paletteSignature=signature;void this.warmPalette();}
      if(this.voices.size>next.maxVoices){
        const excess=[...this.voices].sort((a,b)=>Number(a.protected)-Number(b.protected)||a.intensity-b.intensity);
        for(let i=0;i<excess.length-next.maxVoices;i++)this.removeVoice(excess[i]);
      }
      if(!next.enabled)this.stop();
    }
    this.lastSettings=next;
  }
  setListener(position:Vec3,forward:Vec3=[0,0,-1],up:Vec3=[0,1,0]):void{
    if(![...position,...forward,...up].every(Number.isFinite))return;
    this.listener=position;this.forward=forward;this.director.listener=position;
    const ctx=this.context;if(!ctx)return;const l=ctx.listener,t=ctx.currentTime;
    [l.positionX,l.positionY,l.positionZ].forEach((p,i)=>p.setTargetAtTime(position[i],t,.012));
    [l.forwardX,l.forwardY,l.forwardZ].forEach((p,i)=>p.setTargetAtTime(forward[i],t,.012));
    [l.upX,l.upY,l.upZ].forEach((p,i)=>p.setTargetAtTime(up[i],t,.012));
    for(const voice of this.voices)this.placeVoice(voice);
  }
  emit(event:SoundEvent):void{
    if(!audioSettings().enabled||!this.running||this.context?.state!=='running')return;
    this.activity.add({...event,atMs:event.atMs+propagationDelayMs(distance(event.position,this.listener))},this.listener,performance.now());this.director.enqueue(event);
  }
  update(nowMs=performance.now(),occlusionAt?:(position:Vec3)=>number):void{
    const started=performance.now(),ctx=this.context;
    if(!ctx||!this.running||ctx.state!=='running')return;
    const active=this.activity.sample(nowMs,this.listener),ids=new Set(active.map(e=>e.id)),s=audioSettings();
    this.activitySlots=active.length;
    for(const v of this.loops.values())if(v.role==='activity'&&!ids.has(v.loopId!))this.release(v,.14);
    this.director.drain(nowMs,e=>this.play(e));
    for(const e of active){
      const occlusion=clamp(occlusionAt?.(e.position)??e.occlusion);
      let v=this.loops.get(e.id);
      // Density drives a continuous crushing texture, with independent body
      // and texture controls. Four such voices cover the surrounding regions.
      const amount=e.intensity*(s.dynamicRange==='night'?.65:1.25)*(.45*s.detail+.55*s.bass);
      if(amount<.015){if(v)this.release(v,.12);continue;}
      const selected=this.selectedClip(paletteSlotFor('collapse',e.material,5)),clip=selected??`debris-${e.material}`;
      if(v&&v.kind!==clip){this.release(v,.06);v=undefined;}
      if(!v)v=this.voice(clip,e.position,amount,selected?1:.88,false,undefined,e.id,occlusion,5,'activity')??undefined;
      if(v){v.position=e.position;v.intensity=amount;v.occlusion=occlusion;v.lastUpdate=nowMs;this.placeVoice(v);}
    }
    for(const voice of this.voices){
      if(voice.flight)this.placeVoice(voice);
      if(voice.loopId&&nowMs-voice.lastUpdate>220)this.release(voice,.08);
    }
    this.stats.updateMs=performance.now()-started;
  }
  private placeVoice(v:Voice,initial=false):void{
    if(v.end===-Infinity)return;
    const ctx=this.context!;const t=ctx.currentTime;
    if(v.flight){
      const pose=flybyPose(v.flight,Math.max(t,v.started),this.listener);v.position=pose.position;
      if(initial)v.source.playbackRate.setValueAtTime(pose.rate,v.started);
      else if(t>=v.started)v.source.playbackRate.setTargetAtTime(pose.rate,t,.012);
    }
    const d=distance(v.position,this.listener);
    const attenuation=sourceAttenuation(d,v.size),body=v.role==='body'||v.role==='activity';
    const level=v.intensity*attenuation*(1-v.occlusion*(body?.4:.68));
    const cutoff=Math.max(body?1000:650,19000/(1+d*.009)*(1-v.occlusion*.89));
    if(initial&&!v.loopId){
      if(v.attackUntil>0){v.gain.gain.setValueAtTime(0,t);v.gain.gain.setValueAtTime(0,v.started);v.gain.gain.linearRampToValueAtTime(level,v.attackUntil);}
      else v.gain.gain.setValueAtTime(level,t);
      v.filter.frequency.setValueAtTime(cutoff,t);
    }else{if(t>=v.attackUntil&&(v.fadeAt===undefined||t<v.fadeAt))v.gain.gain.setTargetAtTime(level,v.loopId?Math.max(t,v.started):t,v.role==='activity'?.07:.018);v.filter.frequency.setTargetAtTime(cutoff,t,.04);}
    if(v.panner){
      [v.panner.positionX,v.panner.positionY,v.panner.positionZ].forEach((p,i)=>initial?p.setValueAtTime(v.position[i],t):p.setTargetAtTime(v.position[i],t,.012));
    }else if(v.channels){const gains=speakerGains(azimuthOf(v.position,this.listener,this.forward),this.mode);v.channels.forEach((n,i)=>initial?n.gain.setValueAtTime(gains[i],t):n.gain.setTargetAtTime(gains[i],t,.012));}
  }
  private voice(clip:string,position:Vec3,intensity:number,rate:number,isProtected=false,at?:number,loopId?:string,occlusion=0,size=1,role:VoiceRole=loopId?'continuous':'impact',flight?:FlybyMotion):Voice|null{
    const ctx=this.context,s=audioSettings(),buffer=this.options?.get(clip)??BANK.get(clip);
    if(!ctx||!this.master||!buffer||!s.enabled||intensity<.005)return null;
    const beds=[...this.loops.values()].filter(v=>v.role==='activity').length;
    const reserve=Math.max(0,this.activitySlots-beds);
    const limit=role==='activity'?s.maxVoices:isProtected?s.maxVoices-reserve:Math.max(8,s.maxVoices-12);
    if(this.voices.size>=limit){
      const priority=(v:Voice)=>v.end===-Infinity?0:voiceImportance(v.intensity,distance(v.position,this.listener),v.size,ctx.currentTime-v.started,v.role);
      const victim=[...this.voices].filter(v=>v.role!=='activity'&&(!v.protected||((isProtected||role==='activity')&&!v.flight&&!v.kind.startsWith('flyby-')&&!v.kind.includes('Flyby-'))))
        .sort((a,b)=>Number(a.protected)-Number(b.protected)||priority(a)-priority(b))[0];
      const incoming=voiceImportance(intensity,distance(position,this.listener),size,0,role);
      if(!victim||(!isProtected&&incoming<=priority(victim)*1.15)||!this.retireVoice(victim)){this.stats.droppedVoices++;return null;}
    }
    const source=ctx.createBufferSource(),gain=mono(ctx),filter=ctx.createBiquadFilter();
    source.buffer=buffer;source.playbackRate.value=rate;source.loop=Boolean(loopId);
    filter.type='lowpass';filter.Q.value=.45;gain.gain.value=0;
    source.connect(filter).connect(gain);
    const when=Math.max(ctx.currentTime+.006,at??0);
    const v:Voice={source,gain,filter,nodes:[source,filter,gain],position:[...position],intensity,protected:isProtected,end:when+(buffer.duration-(flight?.offset??0))/rate,loopId,lastUpdate:performance.now(),kind:clip,baseRate:rate,occlusion:clamp(occlusion),size,started:when,role,flight,attackUntil:flight?when+.008:0};
    const output=isProtected?this.threats!:role==='detail'?this.detail!:this.world!;
    const spatialCount=[...this.voices].filter(n=>n.panner).length;
    if(this.mode==='headphones'&&spatialCount<(isProtected?28:22)){
      const p=ctx.createPanner();p.panningModel='HRTF';p.distanceModel='inverse';p.rolloffFactor=0;p.refDistance=1;p.maxDistance=10000;
      gain.connect(p).connect(output);v.panner=p;v.nodes.push(p);
    }else{
      const count=channelCount(this.mode),merge=ctx.createChannelMerger(count);v.channels=[];
      for(let c=0;c<count;c++){const g=mono(ctx);g.gain.value=0;gain.connect(g);g.connect(merge,0,c);v.channels.push(g);v.nodes.push(g);}
      merge.connect(output);v.nodes.push(merge);
    }
    const send=mono(ctx);send.gain.value=isProtected?.18:.28;gain.connect(send).connect(this.wetInput!);v.nodes.push(send);
    this.voices.add(v);if(loopId)this.loops.set(loopId,v);
    source.onended=()=>{v.nodes.forEach(n=>n.disconnect());this.voices.delete(v);this.retiring.delete(v);if(loopId&&this.loops.get(loopId)===v)this.loops.delete(loopId);};
    this.placeVoice(v,true);source.start(when,flight?.offset??(loopId?(Math.abs(hash(loopId))%1000)/1000*buffer.duration:0));
    this.stats.peakVoices=Math.max(this.stats.peakVoices,this.voices.size);return v;
  }
  private play(e:SoundEvent):void{
    const ctx=this.context;if(!ctx)return;const s=audioSettings(),r=seedRandom(e.seed),d=distance(e.position,this.listener);
    const intensity=clamp(e.intensity),mix=eventMix(e,s);
    const time=ctx.currentTime+Math.max(0,(e.atMs+propagationDelayMs(d)-performance.now())/1000);
    const rate=clamp(1.04-Math.log1p(Math.max(0,e.size))*.065+(r()-.5)*.13,.57,1.2);
    const variant=Math.floor(r()*5);
    const protectedSound=Boolean(e.protected)||e.kind==='flyby';
    if(e.kind==='flyby'){
      const selected=this.selectedClip(paletteSlotFor('flyby',e.material,e.size)),clip=selected??'flyby-'+variant%4;
      const buffer=this.options?.get(clip)??BANK.get(clip);
      const passTime=ctx.currentTime+(e.atMs+propagationDelayMs(d)-performance.now())/1000;
      const start=Math.max(ctx.currentTime+.006,passTime-.04);
      const flight=flybyMotion(e,start,this.options?.clip(clip)?.passAtSeconds??(.228+variant%4*.015),buffer?.duration??1.15,false,passTime,this.listener)??undefined;
      if(e.velocity&&!flight)return; // A late, exhausted pass must not restart at its beginning.
      this.voice(clip,e.position,(selected ? .2+intensity*1.45 : .15+intensity*.85)*s.flyby,flight?.rate??clamp(rate*1.2,.8,1.5),true,flight?start:time,undefined,e.occlusion,e.size,'threat',flight);
      // Briefly make room in the bright detail only. Heavy impacts and the
      // surrounding collapse keep their weight through the near miss.
      if(d<12&&ctx.currentTime-this.lastDuck>.3){const g=this.detail!.gain;this.lastDuck=ctx.currentTime;g.cancelScheduledValues(ctx.currentTime);g.setValueAtTime(.68,ctx.currentTime);g.setTargetAtTime(1,ctx.currentTime+.08,.12);}
      return;
    }
    const selected=e.kind!=='shot'&&(mix.weight>.25||e.kind==='fracture'||e.kind==='collapse')?this.selectedClip(paletteSlotFor('impact',e.material,e.size)):null;
    if(selected){
      // A cast recording replaces the body recipe; keeping the old synthetic
      // layers underneath would hide the material character being compared.
      this.voice(selected,e.position,mix.hit+mix.body*.55,clamp(rate,.8,1.15),protectedSound,time,undefined,e.occlusion,e.size,'body');
      return;
    }
    if(e.kind==='collapse'||e.kind==='shot'){
      this.voice(e.kind==='shot'?`shot-${e.size<=.2?'rifle':'cannon'}-${variant%3}`:'collapse-'+variant%4,e.position,mix.hit,rate,protectedSound,time,undefined,e.occlusion,e.size);
    }else this.voice(`${e.material}-${e.kind==='fracture'?'fracture-'+variant%3:'impact-'+variant}`,e.position,mix.hit,rate,protectedSound,time,undefined,e.occlusion,e.size);
    if(mix.body>.01&&e.kind!=='shot'){
      this.voice(`heavy-${e.material}`,e.position,mix.body,clamp(rate,.68,1.1),protectedSound,time+.009,undefined,e.occlusion,e.size,'body');
    }
    if(intensity>.4&&e.kind!=='shot')this.voice(`${e.material}-fracture-${(variant+1)%3}`,e.position,mix.detail,rate*1.11,false,time+.025,undefined,e.occlusion,e.size,'detail');
    if((e.kind==='collapse'||intensity>.85)&&s.ringing>0&&d<14&&ctx.currentTime-this.lastRing>5){
      this.lastRing=ctx.currentTime;this.ring(s.ringing*.012);
    }
  }
  private ring(amount:number):void{
    const ctx=this.context!;const o=ctx.createOscillator(),g=mono(ctx);o.frequency.value=2400;g.gain.value=0;
    o.connect(g).connect(this.master!);g.gain.linearRampToValueAtTime(amount,ctx.currentTime+.035);g.gain.exponentialRampToValueAtTime(.00001,ctx.currentTime+.65);this.transients.set(o,[o,g]);o.start();o.stop(ctx.currentTime+.7);o.onended=()=>{o.disconnect();g.disconnect();this.transients.delete(o);};
  }
  continuous(e:ContinuousSound,nowMs=performance.now()):void{
    if(!e.position.every(Number.isFinite)||!Number.isFinite(e.intensity)||!Number.isFinite(e.speed)||!Number.isFinite(nowMs)||e.velocity&&!e.velocity.every(Number.isFinite))return;
    if(!this.running||this.context?.state!=='running'||!audioSettings().enabled||e.intensity<.015||distance(e.position,this.listener)>180)return;
    let v=this.loops.get(e.id);let rate=clamp(.62+e.speed*.045,.55,1.65);
    if(e.kind==='air'&&e.velocity){const d=Math.max(.1,distance(e.position,this.listener));const radial=e.velocity.reduce((sum,value,i)=>sum+value*(e.position[i]-this.listener[i])/d,0);rate=clamp(343/(343+clamp(radial,-170,170)),.65,1.8);}
    if(!v){
      const continuous=[...this.loops.values()].filter(v=>v.role!=='activity');
      if(continuous.length>=10){
        const score=(kind:string,intensity:number,position:Vec3)=>(kind==='air'?2:0)+intensity/(1+distance(position,this.listener));
        const victim=continuous.sort((a,b)=>score(a.kind,a.intensity,a.position)-score(b.kind,b.intensity,b.position))[0];
        if(!victim||score(e.kind,e.intensity*.32,e.position)<=score(victim.kind,victim.intensity,victim.position)*1.25)return;
        if(!this.retireVoice(victim))return;
      }
      const clip=e.kind==='air'?'air':e.kind==='engine'?'rumble':e.kind==='wind'?'wind':`${e.material}-${e.kind==='roll'?'roll':'scrape'}`;
      v=this.voice(clip,e.position,e.intensity*.3,rate,e.kind==='air',undefined,e.id,e.occlusion)??undefined;
    }
    if(v){v.position=e.position;v.lastUpdate=nowMs;v.intensity=clamp(e.intensity)*.32*audioSettings().detail;v.occlusion=clamp(e.occlusion??0);v.source.playbackRate.setTargetAtTime(rate,this.context!.currentTime,.07);this.placeVoice(v);}
  }
  setOcclusion(id:string,amount:number):void{const v=this.loops.get(id);if(v){v.occlusion=clamp(amount);this.placeVoice(v);}}
  private release(v:Voice,seconds=.025):void{
    if(v.end===-Infinity)return;v.end=-Infinity;v.loopId&&this.loops.delete(v.loopId);
    const t=this.context!.currentTime;v.gain.gain.cancelScheduledValues(t);v.gain.gain.setTargetAtTime(0,t,seconds/4);try{v.source.stop(t+seconds);}catch{/* Already stopped. */}
  }
  private retireVoice(v:Voice):boolean{
    // Replacements start at least 6 ms from now. Fade the outgoing source
    // within 5 ms, so it finishes before its replacement begins. Keep a small
    // explicit node reserve until onended performs the disconnect.
    if(this.retiring.size>=8)return false;
    this.release(v,.005);this.voices.delete(v);this.retiring.add(v);return true;
  }
  private removeVoice(v:Voice):void{try{v.source.stop();}catch{}v.nodes.forEach(n=>n.disconnect());this.voices.delete(v);this.retiring.delete(v);if(v.loopId&&this.loops.get(v.loopId)===v)this.loops.delete(v.loopId);}
  stop(clearReflections=true,cancelAudition=true):void{
    if(cancelAudition)this.auditionGeneration++;
    this.previewReflections=null;
    if(this.context)this.wet?.gain.setTargetAtTime(audioSettings().acoustics==='reflections'?audioSettings().space*.36:0,this.context.currentTime,.03);
    this.director.clear();this.activity.clear();this.activitySlots=0;for(const v of [...this.voices,...this.retiring])this.removeVoice(v);
    for(const [source,nodes] of this.transients){try{source.stop();}catch{}nodes.forEach(n=>n.disconnect());}this.transients.clear();
    this.lastDuck=-Infinity;this.lastRing=-Infinity;
    if(this.context&&this.detail){this.detail.gain.cancelScheduledValues(this.context.currentTime);this.detail.gain.value=1;}
    // Replacing the convolution node flushes its internal history. Merely
    // stopping sources would leak the previous mix's decay into an A/B replay.
    if(clearReflections&&this.context&&this.reflections&&this.wetInput&&this.wet){
      const old=this.reflections,next=this.context.createConvolver();
      next.buffer=old.buffer;next.normalize=false;
      this.wetInput.disconnect(old);old.disconnect();this.wetInput.connect(next).connect(this.wet);
      const index=this.graph.indexOf(old);if(index>=0)this.graph[index]=next;
      this.reflections=next;
    }
  }
  async suspend():Promise<void>{this.stop();await this.context?.suspend();}
  async resume():Promise<void>{if(this.running)await this.context?.resume();}
  async auditionPalette(slot:PaletteSlot,choice:PaletteChoice,{reflections}:{reflections:boolean}):Promise<void>{
    this.stop();const generation=++this.auditionGeneration,roomRevision=this.roomRevision;
    await this.start();if(generation!==this.auditionGeneration)throw new DOMException('Preview cancelled','AbortError');
    const clip=paletteClipId(slot,choice);
    const buffer=choice==='original'?BANK.get(clip):await this.options!.load(slot,choice);
    if(generation!==this.auditionGeneration)throw new DOMException('Preview cancelled','AbortError');
    if(!buffer)throw new Error('This sound is unavailable. Please try another take.');
    const ctx=this.context!;
    this.previewReflections=roomRevision===this.roomRevision?reflections:audioSettings().acoustics==='reflections';this.applySettings();
    const flying=slot.endsWith('Flyby'),speed=slot==='projectileFlyby'?100:slot==='massiveFlyby'?45:30;
    const position:Vec3=flying?[this.listener[0],this.listener[1]+1.1,this.listener[2]]:[this.listener[0]+this.forward[0]*6,this.listener[1]-.5,this.listener[2]+this.forward[2]*6];
    const event:SoundEvent={id:'reference',kind:'flyby',position,material:'metal',size:slot==='massiveFlyby'?4:.5,intensity:.8,seed:2026,atMs:performance.now(),velocity:[-this.forward[2]*speed,0,this.forward[0]*speed]};
    const start=ctx.currentTime+.015;
    const flight=flying?flybyMotion(event,start,this.options?.clip(clip)?.passAtSeconds??.25,buffer.duration,true,undefined,this.listener)??undefined:undefined;
    const v=this.voice(clip,position,referenceGain(buffer),flight?.rate??1,true,start,undefined,0,1,'threat',flight);
    if(v&&!flying&&slot.endsWith('Collapse')){
      // The dry reference plays one finite take; it never leaves a loop behind.
      v.attackUntil=start+.02;v.gain.gain.cancelScheduledValues(ctx.currentTime);this.placeVoice(v,true);
      const end=start+buffer.duration;v.fadeAt=end-.05;v.gain.gain.setTargetAtTime(0,v.fadeAt,.012);v.source.stop(end);
    }
  }
  diagnostics():AudioDiagnostics{
    const ctx=this.context,s=audioSettings();return {...this.stats,...this.director.stats,state:ctx?.state==='suspended'?'Sound suspended':this.stats.state,output:this.mode,requestedOutput:s.output,maxChannels:ctx?.destination.maxChannelCount??2,voices:this.voices.size,spatialVoices:[...this.voices].filter(v=>v.panner).length,activityEmitters:[...this.loops.values()].filter(v=>v.role==='activity').length,loaded:BANK.size,total:bankTotal,failures:[...bankFailures,...this.options?.failures.keys()??[]],queued:this.director.queued,sampleRate:ctx?.sampleRate??0,latencyMs:ctx?((ctx.baseLatency??0)+(ctx.outputLatency??0)+256/ctx.sampleRate)*1000:0};
  }
  /** Isolated output routing test bypasses spatial panning, not the limiter. */
  testChannel(channel:number):void{
    const ctx=this.context;if(!ctx||!this.master||ctx.state!=='running'||!audioSettings().enabled||this.transients.size>=8||channel<0||channel>=channelCount(this.mode))return;
    const source=ctx.createOscillator(),gain=mono(ctx),merge=ctx.createChannelMerger(channelCount(this.mode));
    source.frequency.value=channel===3?65:480;source.connect(gain);gain.connect(merge,0,channel);merge.connect(this.master);
    gain.gain.setValueAtTime(0,ctx.currentTime);gain.gain.linearRampToValueAtTime(.12,ctx.currentTime+.03);gain.gain.setTargetAtTime(0,ctx.currentTime+.3,.05);this.transients.set(source,[source,gain,merge]);source.start();source.stop(ctx.currentTime+.6);source.onended=()=>{source.disconnect();gain.disconnect();merge.disconnect();this.transients.delete(source);};
  }
  private connectRecording(node:MediaStreamAudioDestinationNode):void{
    this.recordingRoutes.forEach(n=>n.disconnect());this.recordingRoutes=[];
    if(!this.context||!this.output)return;
    const count=channelCount(this.mode);
    if(count===2){this.output.connect(node);return;}
    // Explicit, normalized stereo review downmix, taken AFTER peak control.
    const split=this.context.createChannelSplitter(count),merge=this.context.createChannelMerger(2);
    this.output.connect(split);this.recordingRoutes.push(split,merge);
    const matrix=count===6?[[1,0],[0,1],[.707,.707],[.25,.25],[.5,0],[0,.5]]:[[1,0],[0,1],[.707,.707],[.25,.25],[.5,0],[0,.5],[.5,0],[0,.5]];
    const scale=count===6?1/2.457:1/2.957;
    matrix.forEach((weights,input)=>weights.forEach((weight,out)=>{if(!weight)return;const g=mono(this.context!);g.gain.value=weight*scale;split.connect(g,input);g.connect(merge,0,out);this.recordingRoutes.push(g);}));
    merge.connect(node);
  }
  beginRecording():boolean{
    const ctx=this.context;if(!ctx||!this.output||this.recording||this.recordingNode||typeof MediaRecorder==='undefined')return false;
    const node=ctx.createMediaStreamDestination();this.recordingNode=node;this.connectRecording(node);
    const type=['audio/webm;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
    const recorder=new MediaRecorder(node.stream,type?{mimeType:type}:undefined),chunks:BlobPart[]=[];
    recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=()=>{try{this.output?.disconnect(node);}catch{}this.recordingRoutes.forEach(n=>n.disconnect());this.recordingRoutes=[];node.stream.getTracks().forEach(t=>t.stop());this.recordResolve?.(new Blob(chunks,{type:recorder.mimeType}));this.recordResolve=null;this.recordingNode=null;};
    this.recording=recorder;recorder.start();return true;
  }
  endRecording():Promise<Blob|null>{if(!this.recording)return Promise.resolve(null);const recorder=this.recording;this.recording=null;return new Promise(resolve=>{this.recordResolve=resolve;recorder.stop();});}
}
function hash(s:string):number{let v=0;for(let i=0;i<s.length;i++)v=Math.imul(v,31)+s.charCodeAt(i)|0;return v;}
let instance:DestructionAudio|undefined;
export const destructionAudio=():DestructionAudio=>instance??=new DestructionAudio();

/** Audio unlock and visibility follow browser policy; hidden tabs never queue
 * a backlog to explode when the player returns. */
export function installAudioLifecycle():()=>void{
  const engine=destructionAudio();
  const unlock=()=>{if(audioSettings().enabled)void engine.start().catch(()=>{});};
  const visible=()=>{if(document.hidden)void engine.suspend();else void engine.resume();};
  window.addEventListener('pointerdown',unlock);window.addEventListener('keydown',unlock);document.addEventListener('visibilitychange',visible);
  return ()=>{window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);document.removeEventListener('visibilitychange',visible);engine.stop();};
}
