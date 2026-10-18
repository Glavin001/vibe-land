import { clamp, closestPass, distance, physicalIntensity, type AcousticMaterial, type SoundEvent, type Vec3 } from './model';
export interface MotionSample {
  id:string; position:Vec3; velocity:Vec3; nowMs:number; material:AcousticMaterial;
  mass:number; size:number; authoritative?:boolean; impacts?:boolean;
  /** Simulation sample time, when packet arrival jitter differs from motion. */
  sampleTimeMs?:number;
}
interface Track { sample:MotionSample; listener:Vec3; flybyAt:number; impactAt:number; }
type ImpactSample = Pick<MotionSample,'position'|'velocity'|'nowMs'|'sampleTimeMs'|'mass'|'authoritative'|'impacts'>;
const sampleTime=(s:ImpactSample)=>s.sampleTimeMs??s.nowMs;

/** Evidence shared by ordinary motion and the city's all-body velocity stream.
 * This is a conservative collision proxy, not a contact or material solver. */
export function classifyMotionImpact(previous:ImpactSample,current:ImpactSample):{intensity:number;energy:number}|null {
  if(current.impacts===false||current.authoritative||current.mass<=0||!Number.isFinite(current.mass))return null;
  const dt=(sampleTime(current)-sampleTime(previous))/1000;
  if(!Number.isFinite(dt)||dt<=0||dt>.25)return null;
  if(![...previous.position,...current.position,...previous.velocity,...current.velocity].every(Number.isFinite))return null;
  const before=Math.hypot(...previous.velocity),after=Math.hypot(...current.velocity),heavy=current.mass>=250;
  if(before<(heavy?1.5:3)||after>=before*.85)return null;
  if(distance(previous.position,current.position)>Math.max(before,after)*dt*1.8+2)return null;
  const delta=Math.hypot(current.velocity[0]-previous.velocity[0],current.velocity[1]-previous.velocity[1]+9.81*dt,current.velocity[2]-previous.velocity[2]);
  const rawDelta=Math.hypot(current.velocity[0]-previous.velocity[0],current.velocity[1]-previous.velocity[1],current.velocity[2]-previous.velocity[2]);
  // Remove gravity and demand a sudden change; a long, smooth slowdown or the
  // apex of a ballistic arc is not a crash. Heavy objects may hit audibly at 2 m/s.
  if(Math.min(delta,rawDelta)<Math.max(heavy?1.2:3,(heavy?10:20)*dt))return null;
  const speedLostSquared=before*before-after*after;
  return {energy:.5*current.mass*speedLostSquared,intensity:physicalIntensity(current.mass*Math.sqrt(speedLostSquared),current.mass)};
}
/** Cosmetic fallback for streams without contact reports. It never claims
 * to identify the contacted surface or sustained friction from velocity alone. */
export class SoundMotionTracker {
  private tracks=new Map<string,Track>();
  private serial=0;
  note(sample:MotionSample,listener:Vec3,emit:(event:SoundEvent)=>void):void {
    const old=this.tracks.get(sample.id),now=sample.nowMs;
    if(distance(sample.position,listener)>120){this.tracks.delete(sample.id);return;}
    if(old&&sampleTime(sample)<=sampleTime(old.sample))return;
    this.tracks.set(sample.id,{sample:{...sample,position:[...sample.position],velocity:[...sample.velocity]},listener:[...listener],flybyAt:old?.flybyAt??-Infinity,impactAt:old?.impactAt??-Infinity});
    if(this.tracks.size>1024)this.tracks.delete(this.tracks.keys().next().value!);
    if(!old)return;
    const dt=((sample.sampleTimeMs??now)-(old.sample.sampleTimeMs??old.sample.nowMs))/1000;if(dt<=0||dt>.25)return;
    const speed=Math.hypot(...sample.velocity),previousSpeed=Math.hypot(...old.sample.velocity);
    if(distance(sample.position,old.sample.position)>Math.max(speed,previousSpeed)*dt*1.8+2)return;
    const current=this.tracks.get(sample.id)!;
    const event=(kind:SoundEvent['kind'],position:Vec3,intensity:number,protect=false,flight?:Pick<SoundEvent,'velocity'|'missDistance'|'atMs'>)=>emit({id:`${sample.id}:${kind}:${++this.serial}`,kind,position,material:sample.material,intensity,size:sample.size,seed:this.serial*997,atMs:now,protected:protect,...flight});
    const pass=closestPass(old.sample.position,sample.position,old.listener,listener);
    const velocity:Vec3=[(sample.position[0]-old.sample.position[0])/dt,(sample.position[1]-old.sample.position[1])/dt,(sample.position[2]-old.sample.position[2])/dt];
    const relativeSpeed=Math.hypot(...velocity.map((v,i)=>v-(listener[i]-old.listener[i])/dt));
    if(previousSpeed>14&&relativeSpeed>14&&pass.distance<Math.min(8,2.5+sample.size)&&pass.fraction>0&&pass.fraction<1&&now-old.flybyAt>1200){
      current.flybyAt=now;
      event('flyby',pass.position,clamp(.35+relativeSpeed/180)*(1-pass.distance/12),true,{
        velocity,missDistance:pass.distance,atMs:old.sample.nowMs+(now-old.sample.nowMs)*pass.fraction,
      });
    }
    const impact=classifyMotionImpact(old.sample,sample);
    if(impact&&now-old.impactAt>220){
      current.impactAt=now;event('impact',sample.position,impact.intensity,sample.mass>=500&&impact.energy>=3000&&distance(sample.position,listener)<=25);
    }
  }
  clear():void{this.tracks.clear();}
  prune(nowMs:number):void{for(const [id,t] of this.tracks)if(nowMs-t.sample.nowMs>500)this.tracks.delete(id);}
}
