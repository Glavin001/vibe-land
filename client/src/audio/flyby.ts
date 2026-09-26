import { clamp,type SoundEvent,type Vec3 } from './model';
export interface FlybyMotion {point:Vec3;velocity:Vec3;passTime:number;offset:number;rate:number;}
/** Rate at a time relative to the spatial pass. Shared by scheduling and the
 * moving source so changing Doppler does not move the clip's pressure peak. */
function rateAt(motion:FlybyMotion,relativeTime:number,listener:Vec3):number {
  const dt=clamp(relativeTime,-1,1.5);
  const x=motion.point[0]+motion.velocity[0]*dt-listener[0];
  const y=motion.point[1]+motion.velocity[1]*dt-listener[1];
  const z=motion.point[2]+motion.velocity[2]*dt-listener[2];
  const d=Math.max(.2,Math.hypot(x,y,z));
  const radial=(motion.velocity[0]*x+motion.velocity[1]*y+motion.velocity[2]*z)/d;
  return motion.rate*clamp(343/(343+clamp(radial,-180,180)),.68,1.65);
}

/** Composite Simpson integration has a fixed cost per voice, never per sample
 * of the audio buffer. Signed intervals also cover passes that arrived late. */
function samplesBetween(motion:FlybyMotion,from:number,to:number,listener:Vec3):number {
  const steps=64,h=(to-from)/steps;
  let sum=rateAt(motion,from-motion.passTime,listener)+rateAt(motion,to-motion.passTime,listener);
  for(let i=1;i<steps;i++)sum+=(i%2?4:2)*rateAt(motion,from+i*h-motion.passTime,listener);
  return sum*h/3;
}

export function flybyMotion(e:SoundEvent,start:number,clipPass:number,duration:number,fullApproach=false,desiredPassTime?:number,listener:Vec3=[0,0,0]):FlybyMotion|null {
  if(!e.velocity||!e.velocity.every(Number.isFinite)||!e.position.every(Number.isFinite)||!listener.every(Number.isFinite))return null;
  if(!Number.isFinite(start)||!Number.isFinite(clipPass)||!Number.isFinite(duration)||duration<=0||desiredPassTime!==undefined&&!Number.isFinite(desiredPassTime))return null;
  const speed=Math.hypot(...e.velocity);if(speed<1||!Number.isFinite(speed))return null;
  const rate=clamp(.95+Math.log2(speed/35)*.12-Math.log1p(e.size)*.045,.7,1.4);
  const pass=clamp(clipPass,.02,Math.max(.02,duration-.02));
  const motion:FlybyMotion={point:[...e.position],velocity:[...e.velocity],passTime:desiredPassTime??start+.04,offset:0,rate};
  if(fullApproach&&desiredPassTime===undefined){
    // A preview keeps the entire approach. Solve its duration against the
    // varying playback rate, rather than treating the base pitch as a clock.
    let lo=0,hi=pass/(rate*.68);
    for(let i=0;i<18;i++){
      const lead=(lo+hi)/2;motion.passTime=start+lead;
      if(samplesBetween(motion,start,motion.passTime,listener)<pass)lo=lead;else hi=lead;
    }
    motion.passTime=start+(lo+hi)/2;
    return motion;
  }
  // The event timestamp is the pass, not the start of another approach. Seek
  // forward through a late event instead of replaying its already missed peak.
  motion.offset=pass-samplesBetween(motion,start,motion.passTime,listener);
  if(motion.offset<0&&desiredPassTime===undefined)return flybyMotion(e,start,clipPass,duration,true,undefined,listener);
  if(motion.offset<0||motion.offset>=duration)return null;
  return motion;
}
export function flybyPose(motion:FlybyMotion,time:number,listener:Vec3):{position:Vec3;rate:number}{
  const dt=clamp(time-motion.passTime,-1,1.5);
  const position=motion.point.map((v,i)=>v+motion.velocity[i]*dt) as [number,number,number];
  return {position,rate:rateAt(motion,time-motion.passTime,listener)};
}
