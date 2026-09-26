import { describe, expect, it } from 'vitest';
import { soundFromDestruction, soundFromShot, contactPresentationTime } from './gameEvents';
import { WEAPON_CANNONBALL, WEAPON_METEOR, WEAPON_HITSCAN } from '../net/sharedConstants';
import type { ShotFiredPacket } from '../net/protocol';
import type { DustSource } from '../city/destructionEvents';
const source: DustSource = {kind:'fracture',structureId:2,simTick:120,ordinal:3,x:1,y:2,z:3,nx:0,ny:1,nz:0,vx:0,vy:0,vz:0,magnitude:8,count:4,material:0,atMs:500};
describe('game audio event adapter',()=>{
  it('distinguishes rifle/cannon reports and keeps meteor launches silent',()=>{
    const packet={shooterPlayerId:2,shotId:3,weapon:WEAPON_HITSCAN,originPxMm:1000,originPyMm:2000,originPzMm:3000} as ShotFiredPacket;
    expect(soundFromShot(packet,500)!.size).toBeLessThanOrEqual(.2);
    expect(soundFromShot({...packet,weapon:WEAPON_CANNONBALL},500)!.size).toBeGreaterThan(.2);
    expect(soundFromShot({...packet,weapon:WEAPON_METEOR},500)).toBeNull();
  });
  it('keeps material and presentation time with stable duplicate identity',()=>{
    const e=soundFromDestruction(source,'wood')!;
    expect(e.material).toBe('wood');expect(e.atMs).toBe(500);expect(e.position).toEqual([1,2,3]);
    expect(soundFromDestruction({...source},'wood')!.id).toBe(e.id);
  });
  it('leaves velocity impacts to the independent motion/contact detector',()=>{
    expect(soundFromDestruction({...source,kind:'impact'},'stone')).toBeNull();
    expect(soundFromDestruction({...source,kind:'shed'},'stone')).toBeNull();
    expect(soundFromDestruction({...source,kind:'wave'},'stone')!.kind).toBe('collapse');
  });
  it('renders validated physical impacts with their real size and severity',()=>{
    const e=soundFromDestruction({...source,kind:'impact',magnitude:1.5},'stone',{intensity:.86,size:3})!;
    expect(e).toMatchObject({kind:'impact',material:'stone',intensity:.86,size:3,atMs:500});
  });
  it('makes substantial structural breaks powerful while retaining small-break contrast',()=>{
    expect(soundFromDestruction(source,'concrete')!.intensity).toBeGreaterThan(.65);
    expect(soundFromDestruction({...source,magnitude:.05},'concrete')!.intensity).toBeLessThan(.25);
    expect(soundFromDestruction({...source,magnitude:100},'concrete')!.intensity).toBeGreaterThan(.9);
  });
  it('aligns contacts with the city presentation clock with a bounded wait',()=>{
    expect(contactPresentationTime(130,124,1000,60)).toBe(1100);
    expect(contactPresentationTime(130,Infinity,1000,60)).toBe(1000);
    expect(contactPresentationTime(1000,124,1000,60)).toBe(1250);
  });
});
