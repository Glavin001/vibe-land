import { VehicleInterpolator, type VehicleSample } from '../../src/net/interpolation';
import { VehiclePresentationPredictor, extrapolateVehicle, type Sweep, type VehicleProxy } from '../../src/physics/vehiclePresentation';
import type { InputCmd } from '../../src/net/protocol';
import { HZ, QUALITY_VERSION, type QualityEvidence, type Reconciliation } from './contracts';
import { packetSchedule, type LinkCase } from './schedule';
export interface NativeTrace {world:unknown;frames:{input:InputCmd;sample:VehicleSample}[];}

/** Runs shipping presentation against a pinned authority tape. All receive scheduling
 * and quality timestamps are integer ticks; performance.now() inside the predictor
 * is used only for its diagnostic accounting and is never used in this report. */
export function replayVehicleTrace(trace:NativeTrace,proxy:VehicleProxy,sweep:Sweep,link:LinkCase,seed:number,sequenceOffset=0) {
  if(!Array.isArray(trace.frames)||trace.frames.length<180)throw Error('Need at least 180 native frames');
  const firstTime=trace.frames[0].sample.serverTimeUs;
  trace.frames.forEach((f,i)=>{
    if(Math.abs(f.sample.serverTimeUs-firstTime-i*1e6/HZ)>.01)throw Error(`Native source is not uniform 60 Hz at tick ${i}`);
    if(!f.sample.position.every(Number.isFinite)||!f.sample.quaternion.every(Number.isFinite))throw Error('Invalid native source pose');
  });
  const packets=packetSchedule(trace.frames.length,link,seed);
  const corrections:Reconciliation[]=[];
  let tick=0,cursor=0;
  const driver=new VehiclePresentationPredictor(sweep,event=>{
    if(event.type==='vehicle_reconcile')corrections.push({tick,errorM:event.errorM,angleRad:event.angleRad,hard:event.hard});
  });
  const observer=new VehicleInterpolator();observer.extrapolate=(_,sample,seconds)=>extrapolateVehicle(sample,seconds,proxy,sweep);
  const sample=(i:number)=>({...trace.frames[i].sample,serverTimeUs:i*1e6/HZ});
  const input=(i:number)=>({...trace.frames[i].input,seq:(trace.frames[i].input.seq+sequenceOffset)&65535});
  const sequenceTicks=new Map(trace.frames.map((_,i)=>[input(i).seq,i]));
  // Explicit warm-start; join/bootstrap is a separate scenario requiring a different tape.
  driver.observe(7,sample(0),input(0).seq,proxy,0);observer.push(7,sample(0));
  const base={version:QUALITY_VERSION as typeof QUALITY_VERSION,scenario:'recorded-course',startTick:12,endTick:trace.frames.length-1,
    lostRecords:0,source:'pinned-native-vehicle2-tape',triggers:[]};
  const owner:QualityEvidence={...base,role:'driver',observerDelayTicks:0,frames:[],corrections:[]};
  const remote:QualityEvidence={...base,role:'observer',observerDelayTicks:link.observerDelayTicks,frames:[],corrections:[]};
  for(tick=1;tick<trace.frames.length;tick++) {
    driver.record(7,[input(tick)]);
    while(cursor<packets.length && packets[cursor].arrivalTick<=tick) {
      const p=packets[cursor++];if(p.dropped)continue;
      driver.observe(7,sample(p.sourceTick),input(p.sourceTick).seq,proxy,tick*1000/HZ);
      observer.push(7,sample(p.sourceTick));
    }
    driver.update(1/HZ,tick*1000/HZ);
    const pose=driver.pose(),targetTick=Math.max(0,tick-link.observerDelayTicks);
    const other=observer.sample(7,targetTick*1e6/HZ);
    if(tick>=base.startTick) {
      owner.frames.push({tick,sourceTick:sequenceTicks.get(driver.debug(tick*1000/HZ).ack)??0,actual:pose,reference:sample(tick),frozen:driver.debug(tick*1000/HZ).stalled});
      remote.frames.push({tick,sourceTick:Math.round((observer.latest(7)?.serverTimeUs??0)*HZ/1e6),actual:other,reference:sample(targetTick),frozen:false});
    }
  }
  owner.corrections=corrections.filter(c=>c.tick>=base.startTick);
  return {packets,driver:owner,observer:remote};
}
