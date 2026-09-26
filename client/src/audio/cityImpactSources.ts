import { DustSourceQueue, type DustSource } from '../city/destructionEvents';
import type { DustImpactEvidence } from '../city/dustImpacts';
import { classifyMotionImpact } from './motion';

export interface CityAudioImpact {
  entityId:number; material:number; mass:number; size:number; intensity:number; energy:number;
}
const sourceKey=(source:DustSource)=>`${source.structureId}:${source.simTick}:${source.ordinal}`;

/** Audio observes all city velocity impacts before the visual dust and flyby
 * budgets. Both queued source copies and their optional evidence remain capped. */
export class CityImpactAudioQueue {
  private readonly sources=new DustSourceQueue(512);
  private readonly impacts=new Map<string,CityAudioImpact>();

  pushDestruction(source:DustSource):void {
    // Visual waves include unvalidated motion; audio's regional debris layer
    // instead aggregates the validated impacts below. Release is silent.
    if(source.kind==='fracture'||source.kind==='entry')this.sources.push(source);
  }

  noteImpact(source:DustSource,evidence:DustImpactEvidence,tickRate:number,material:number):void {
    if(!Number.isFinite(tickRate)||tickRate<=0)return;
    const impact=classifyMotionImpact({
      position:evidence.previousPosition,velocity:evidence.previousVelocity,
      mass:evidence.mass,nowMs:evidence.previousTick*1000/tickRate,
    },{
      position:evidence.position,velocity:evidence.velocity,
      mass:evidence.mass,nowMs:evidence.tick*1000/tickRate,
    });
    if(!impact||!this.sources.push(source))return;
    this.impacts.set(sourceKey(source),{...impact,entityId:evidence.entityId,
      material,mass:evidence.mass,size:evidence.size});
  }

  drain(visit:(source:DustSource,impact?:CityAudioImpact)=>void):number {
    const count=this.sources.drain(source=>visit(source,source.kind==='impact'?this.impacts.get(sourceKey(source)):undefined));
    this.impacts.clear();
    return count;
  }

  clear():void {this.sources.clear();this.impacts.clear();}
}
