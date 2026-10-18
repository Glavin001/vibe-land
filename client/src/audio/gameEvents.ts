import type { DustSource } from '../city/destructionEvents';
import { clamp, type AcousticMaterial, type SoundEvent } from './model';
import type { ShotFiredPacket } from '../net/protocol';
import { WEAPON_CANNONBALL, WEAPON_METEOR } from '../net/sharedConstants';

export function soundFromShot(packet:ShotFiredPacket,nowMs:number):SoundEvent|null {
  if(packet.weapon===WEAPON_METEOR)return null;
  const cannon=packet.weapon===WEAPON_CANNONBALL;
  return {id:`shot:${packet.shooterPlayerId}:${packet.shotId}`,kind:'shot',material:'metal',
    position:[packet.originPxMm/1000,packet.originPyMm/1000,packet.originPzMm/1000],
    intensity:cannon?.85:.3,size:cannon?1:.1,seed:packet.shotId,atMs:nowMs};
}

export interface DestructionImpact { intensity:number; size:number; }
export function soundFromDestruction(source: DustSource, material: AcousticMaterial, impact?:DestructionImpact): SoundEvent|null {
  // Island release is not a collision. A dust impact is audible only when its
  // physical evidence has also passed the audio motion classifier.
  if(source.kind==='shed'||(source.kind==='impact'&&!impact))return null;
  const kind=source.kind==='impact'?'impact':source.kind==='wave'?'collapse':'fracture';
  const magnitude=Math.max(0,source.magnitude);
  return {id:`break:${source.structureId}:${source.simTick}:${source.ordinal}:${source.kind}`,
    kind, material, position:[source.x,source.y,source.z],
    // Fracture magnitude is three times broken bond area (entry is doubled).
    // It is not mass or impulse. Keep this authoring curve separate from impacts.
    intensity:impact?clamp(impact.intensity):clamp(.12+.86*(1-Math.exp(-Math.sqrt(magnitude)/2.5)),.08,.98),
    size:impact?Math.max(.1,impact.size):Math.max(.2,Math.cbrt(magnitude)),
    seed:(Math.imul(source.simTick,997)^Math.imul(source.structureId,65537)^source.ordinal)>>>0,
    atMs:source.atMs};
}
export function contactPresentationTime(tick:number,presentedTick:number,nowMs:number,hz:number):number {
  return nowMs+(Number.isFinite(presentedTick)?clamp((tick-presentedTick)/Math.max(1,hz)*1000,0,250):0);
}
