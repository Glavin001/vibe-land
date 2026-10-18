import { useSyncExternalStore } from 'react';
import { clamp } from './model';
import { DEFAULT_PALETTE, sanitizePalette, type PaletteChoices } from './soundPalette';
export type OutputMode = 'headphones' | 'stereo' | 'surround51' | 'surround71';
export type MixPreset = 'cinematic' | 'natural' | 'clarity';
export type DynamicRange = 'cinematic' | 'balanced' | 'night';
export interface AudioSettings {
  enabled: boolean;
  master: number;
  output: OutputMode;
  preset: MixPreset;
  dynamicRange: DynamicRange;
  impact: number;
  detail: number;
  bass: number;
  space: number;
  flyby: number;
  ringing: number;
  maxVoices: number;
  palette: PaletteChoices;
  acoustics: 'dry'|'reflections';
}
export const MIXES: Record<MixPreset, Pick<AudioSettings, 'impact' | 'detail' | 'bass' | 'space' | 'flyby'>> = {
  cinematic: { impact: 1, detail: .8, bass: .9, space: .65, flyby: 1 },
  natural: { impact: .88, detail: 1, bass: .48, space: .42, flyby: .78 },
  clarity: { impact: .86, detail: .58, bass: .5, space: .3, flyby: 1.1 },
};
export const DEFAULT_AUDIO: AudioSettings = {enabled:true,master:.65,output:'headphones',preset:'cinematic',dynamicRange:'balanced',...MIXES.cinematic,ringing:0,maxVoices:64,palette:{...DEFAULT_PALETTE},acoustics:'dry'};
const KEY='vibe.audio.v1';
export function sanitizeSettings(raw: Partial<AudioSettings>): AudioSettings {
  const s={...DEFAULT_AUDIO,...raw};
  s.output=['headphones','stereo','surround51','surround71'].includes(s.output)?s.output:'headphones';
  s.preset=['cinematic','natural','clarity'].includes(s.preset)?s.preset:'cinematic';
  s.dynamicRange=['cinematic','balanced','night'].includes(s.dynamicRange)?s.dynamicRange:'balanced';
  s.enabled=typeof raw.enabled==='boolean'?raw.enabled:true;
  for(const k of ['master','impact','detail','bass','space','flyby','ringing'] as const) s[k]=clamp(Number(s[k]),0,k==='master'||k==='ringing'?1:1.5);
  s.maxVoices=Math.round(clamp(Number(s.maxVoices),24,96));
  s.palette=sanitizePalette(raw.palette);
  s.acoustics=raw.acoustics==='reflections'?'reflections':'dry';
  return s;
}
function load(): AudioSettings {try{return sanitizeSettings(JSON.parse(localStorage.getItem(KEY)??'{}'));}catch{return {...DEFAULT_AUDIO};}}
let settings=load();
const listeners=new Set<()=>void>();
// The studio opens beside the game. Tuning there must update an existing
// listener without forcing a game reload or writing the preference back.
if(typeof window!=='undefined'){
  const receive=(event:StorageEvent)=>{
    if(event.key!==KEY||event.newValue===null)return;
    try{
      const value=JSON.parse(event.newValue);
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      settings=sanitizeSettings(value);listeners.forEach(fn=>fn());
    }catch{/* Ignore incomplete/invalid cross-tab preferences. */}
  };
  window.addEventListener('storage',receive);
  import.meta.hot?.dispose(()=>window.removeEventListener('storage',receive));
}
export const audioSettings=():AudioSettings=>settings;
export function setAudioSettings(patch:Partial<AudioSettings>):void {
  settings=sanitizeSettings({...settings,...patch});
  try{localStorage.setItem(KEY,JSON.stringify(settings));}catch{/* Session settings still work. */}
  listeners.forEach(fn=>fn());
}
export function setMixPreset(preset:MixPreset):void {setAudioSettings({preset,...MIXES[preset]});}
export function subscribeAudioSettings(fn:()=>void):()=>void {listeners.add(fn);return ()=>listeners.delete(fn);}
export function useAudioSettings():AudioSettings {return useSyncExternalStore(subscribeAudioSettings,audioSettings,audioSettings);}
