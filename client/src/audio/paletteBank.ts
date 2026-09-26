import { clamp } from './model';
import { paletteClipId,type PaletteCatalog,type PaletteChoice,type PaletteClip,type PaletteSlot } from './soundPalette';
export const PALETTE_REVISION='casting-1';
export class PaletteBank {
  private catalogTask:Promise<PaletteCatalog>|null=null;
  private pending=new Map<string,Promise<AudioBuffer>>();
  private buffers=new Map<string,AudioBuffer>();
  readonly failures=new Map<string,string>();
  catalog:PaletteCatalog|null=null;
  constructor(private ctx:BaseAudioContext){}
  async metadata():Promise<PaletteCatalog>{
    if(!this.catalogTask)this.catalogTask=(async()=>{
      const response=await fetch(`/audio/options/catalog.json?v=${PALETTE_REVISION}`);
      if(!response.ok)throw new Error('Sound options catalog is unavailable');
      const catalog=await response.json() as PaletteCatalog;
      if(!catalog?.clips||typeof catalog.clips!=='object')throw new Error('Invalid sound options catalog');
      this.catalog=catalog;return catalog;
    })().catch(error=>{this.catalogTask=null;throw error;});
    return this.catalogTask;
  }
  get(id:string):AudioBuffer|undefined{return this.buffers.get(id);}
  clip(id:string):PaletteClip|undefined{return this.catalog?.clips[id];}
  async load(slot:PaletteSlot,choice:PaletteChoice):Promise<AudioBuffer>{
    const id=paletteClipId(slot,choice),cached=this.buffers.get(id);if(cached)return cached;
    if(choice==='original')throw new Error('Original recordings belong to the base bank');
    const task=this.pending.get(id);if(task)return task;
    const next=(async()=>{
      const catalog=await this.metadata(),clip=catalog.clips[id];
      if(!clip||!clip.url.startsWith('/audio/options/')||!Number.isFinite(clip.duration)||clip.duration>10)throw new Error(`Sound option unavailable: ${id}`);
      const response=await fetch(`${clip.url}?v=${PALETTE_REVISION}`);if(!response.ok)throw new Error(`Could not load ${id}`);
      const buffer=await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(id,buffer);this.failures.delete(id);return buffer;
    })().catch(error=>{this.failures.set(id,String(error));throw error;}).finally(()=>this.pending.delete(id));
    this.pending.set(id,next);return next;
  }
}
const matchedGains=new WeakMap<AudioBuffer,number>();
/** Compare a fixed reference level using the loudest 400 ms window. A peak
 * ceiling takes precedence for high-crest recordings, preserving transients. */
export function referenceGain(buffer:AudioBuffer):number {
  const cached=matchedGains.get(buffer);if(cached!==undefined)return cached;
  const data=buffer.getChannelData(0),window=Math.min(data.length,Math.max(1,Math.round(buffer.sampleRate*.4)));
  let sum=0,max=0,peak=0;
  for(let i=0;i<data.length;i++){const v=data[i];sum+=v*v;if(i>=window)sum-=data[i-window]**2;peak=Math.max(peak,Math.abs(v));if(i>=window-1)max=Math.max(max,sum/window);}
  const gain=peak>0?Math.min(clamp(.11/Math.max(.0001,Math.sqrt(max)),.1,4),.85/peak):1;
  matchedGains.set(buffer,gain);return gain;
}
