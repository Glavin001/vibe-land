import { clamp, type SoundEvent } from './model';
import type { AudioSettings } from './settings';

export type VoiceRole='impact'|'body'|'detail'|'activity'|'threat'|'continuous';

/** Authored gain staging before the shared output limiter. Size adds body,
 * not merely a pitch change; quiet contacts retain a quiet floor. */
export function eventMix(e:SoundEvent,s:AudioSettings):{hit:number;body:number;detail:number;weight:number} {
  const i=clamp(e.intensity);
  const amount=s.dynamicRange==='night'?1.25*Math.pow(i,.65):s.dynamicRange==='cinematic'?2.2*Math.pow(i,1.65):1.85*Math.pow(i,1.15);
  const weight=e.material==='glass'?0:clamp((Math.log2(1+Math.max(0,e.size))-.55)/1.45)*clamp((i-.2)/.5);
  return {
    hit:amount*s.impact*(1-.28*weight),
    body:amount*weight*.95*s.bass,
    detail:amount*.3*s.detail*(1-.35*weight),
    weight,
  };
}

/** Source extent matters inside a collapse. The gain remains <=1 and drops
 * well below the foreground by the other side of a city block. */
export function sourceAttenuation(distance:number,size=1):number {
  const radius=clamp(size,1,8);
  return 1/Math.pow(1+Math.max(0,distance-radius)/(16+radius*2.5),1.35);
}

/** A fading tail should not block a new wall impact. Sustained emitters are
 * ranked by their current level; finite one-shots lose priority as they age. */
export function voiceImportance(gain:number,distance:number,size:number,ageSeconds:number,role:VoiceRole):number {
  const decay=role==='activity'||role==='continuous'?1:Math.exp(-Math.max(0,ageSeconds)/(role==='body'?.9:.6));
  const roleWeight=role==='detail'?.55:role==='activity'?1.15:1;
  return gain*sourceAttenuation(distance,size)*decay*roleWeight;
}
