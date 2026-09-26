import { clamp, closestPass, distance, physicalIntensity, type AcousticMaterial, type SoundEvent, type Vec3 } from './model';
export interface MotionSample {
  id:string; position:Vec3; velocity:Vec3; nowMs:number; material:AcousticMaterial;
  mass:number; size:number; authoritative?:boolean; impacts?:boolean;
  /** Simulation sample time, when packet arrival jitter differs from motion. */
  sampleTimeMs?:number;
}
interface Track { sample:MotionSample; listener:Vec3; flybyAt:number; impactAt:number; }
/** Cosmetic fallback for streams without contact reports. It never claims
 * to identify the contacted surface or sustained friction from velocity alone. */
export class SoundMotionTracker {
  private tracks=new Map<string,Track>();
  private serial=0;
  note(sample:MotionSample,listener:Vec3,emit:(event:SoundEvent)=>void):void {
    const old=this.tracks.get(sample.id),now=sample.nowMs;
    if(distance(sample.position,listener)>120){this.tracks.delete(sample.id);return;}
    this.tracks.set(sample.id,{sample,listener:[...listener],flybyAt:old?.flybyAt??-Infinity,impactAt:old?.impactAt??-Infinity});
    if(this.tracks.size>1024)this.tracks.delete(this.tracks.keys().next().value!);
    if(!old)return;
    const dt=((sample.sampleTimeMs??now)-(old.sample.sampleTimeMs??old.sample.nowMs))/1000;if(dt<=0||dt>.25)return;
    const speed=Math.hypot(...sample.velocity),previousSpeed=Math.hypot(...old.sample.velocity);
    if(distance(sample.position,old.sample.position)>Math.max(speed,previousSpeed)*dt*1.8+2)return;
    const current=this.tracks.get(sample.id)!;
    const event=(kind:SoundEvent['kind'],position:Vec3,intensity:number,protect=false)=>emit({id:`${sample.id}:${kind}:${++this.serial}`,kind,position,material:sample.material,intensity,size:sample.size,seed:this.serial*997,atMs:now,protected:protect});
    const pass=closestPass(old.sample.position,sample.position,old.listener,listener);
    if(previousSpeed>14&&pass.distance<Math.min(8,2.5+sample.size)&&pass.fraction>0&&pass.fraction<1&&now-old.flybyAt>1200){
      current.flybyAt=now;event('flyby',pass.position,clamp(.35+previousSpeed/180)*(1-pass.distance/12),true);
    }
    const delta=Math.hypot(sample.velocity[0]-old.sample.velocity[0],sample.velocity[1]-old.sample.velocity[1]+9.81*dt,sample.velocity[2]-old.sample.velocity[2]);
    if(sample.impacts!==false&&!sample.authoritative&&previousSpeed>3&&speed<previousSpeed*.85&&delta>3&&now-old.impactAt>220){
      current.impactAt=now;event(sample.size>3&&previousSpeed>20?'collapse':'impact',sample.position,physicalIntensity(sample.mass*delta,sample.mass),sample.size>3);
    }
  }
  clear():void{this.tracks.clear();}
  prune(nowMs:number):void{for(const [id,t] of this.tracks)if(nowMs-t.sample.nowMs>500)this.tracks.delete(id);}
}
