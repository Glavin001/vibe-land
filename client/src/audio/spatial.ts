import type { OutputMode } from './settings';
import type { Vec3 } from './model';
export interface Speaker {name:string; angle:number; channel:number;}
// Web Audio 5.1 order and the conventional 7.1 discrete extension. The lab's
// channel test verifies the actual OS/HDMI mapping before trusting surround.
export const SPEAKERS_51: readonly Speaker[]=[{name:'Front left',angle:-30,channel:0},{name:'Front right',angle:30,channel:1},{name:'Center',angle:0,channel:2},{name:'Surround left',angle:-110,channel:4},{name:'Surround right',angle:110,channel:5}];
export const SPEAKERS_71: readonly Speaker[]=[...SPEAKERS_51.slice(0,3),{name:'Back left',angle:-150,channel:4},{name:'Back right',angle:150,channel:5},{name:'Side left',angle:-90,channel:6},{name:'Side right',angle:90,channel:7}];
export const channelCount=(mode:OutputMode):number=>mode==='surround71'?8:mode==='surround51'?6:2;
export function resolveOutput(requested:OutputMode,maxChannels:number):OutputMode {return channelCount(requested)<=maxChannels?requested:'stereo';}
export function speakerGains(azimuth:number,mode:OutputMode):Float32Array {
  const result=new Float32Array(channelCount(mode));
  const speakers=(mode==='surround71'?SPEAKERS_71:SPEAKERS_51).slice().sort((a,b)=>a.angle-b.angle);
  if(result.length===2){const pan=Math.sin(azimuth);result[0]=Math.sqrt((1-pan)/2);result[1]=Math.sqrt((1+pan)/2);return result;}
  let angle=azimuth*180/Math.PI; angle=((angle+180)%360+360)%360-180;
  for(let i=0;i<speakers.length;i++) {
    const a=speakers[i], b=speakers[(i+1)%speakers.length];
    const end=i===speakers.length-1?b.angle+360:b.angle;
    const x=angle<a.angle?angle+360:angle;
    if(x<a.angle||x>end)continue;
    const t=(x-a.angle)/(end-a.angle);
    result[a.channel]=Math.cos(t*Math.PI/2);result[b.channel]=Math.sin(t*Math.PI/2);break;
  }
  return result;
}
export function azimuthOf(position:Vec3,listener:Vec3,forward:Vec3):number {
  const x=position[0]-listener[0],z=position[2]-listener[2];
  // The camera faces -Z at yaw zero; +X is the listener's right.
  const yaw=Math.atan2(forward[0],-forward[2]);
  return Math.atan2(x,-z)-yaw;
}
