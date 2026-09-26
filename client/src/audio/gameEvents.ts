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

export function soundFromDestruction(source: DustSource, material: AcousticMaterial): SoundEvent|null {
  // Impacts have their own motion/contact path. A new island on its own is
  // not an audible collision; sounding both doubles every fracture.
  if(source.kind==='impact'||source.kind==='shed')return null;
  const kind=source.kind==='wave'?'collapse':'fracture';
  return {id:`break:${source.structureId}:${source.simTick}:${source.ordinal}:${source.kind}`,
    kind, material, position:[source.x,source.y,source.z],
    intensity:clamp(Math.log1p(source.magnitude)/5.5,.08,1),
    size:Math.max(.2,Math.cbrt(source.magnitude)),
    seed:(Math.imul(source.simTick,997)^Math.imul(source.structureId,65537)^source.ordinal)>>>0,
    atMs:source.atMs};
}
export function contactPresentationTime(tick:number,presentedTick:number,nowMs:number,hz:number):number {
  return nowMs+(Number.isFinite(presentedTick)?clamp((tick-presentedTick)/Math.max(1,hz)*1000,0,250):0);
}
