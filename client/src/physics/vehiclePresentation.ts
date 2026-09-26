import {Quaternion, Vector3} from 'three';
import {BTN_JUMP, type InputCmd, type VehicleStateMeters} from '../net/protocol';
import type {VehicleSample} from '../net/interpolation';
import {resolveDrivingSetup, resolveVehicleGeometry} from '../vehicles/configuration.mjs';
import {getSharedVehicleDefinition} from '../wasm/sharedVehicleDefinitions';

type V3 = [number,number,number];
type Q4 = [number,number,number,number];
export type Sweep = (position:readonly number[], quaternion:readonly number[], delta:readonly number[],
  halfExtents:readonly number[], radius?:number)=>{fraction:number;normal:V3}|null;
export type VehicleProxy = {half:V3; wheels:V3[]; radius:number; wheelbase:number;
  acceleration:number; speed:number; grip:number; braking:number; lock:number; response:number};
const DT=1/60;
export const MAX_VEHICLE_LEAD_SEC=.25;
export const MAX_DRIVER_LEAD_SEC=.4;
const MAX_PENDING=128;
const newer=(a:number,b:number)=>a!==b&&((a-b)&0xffff)<0x8000;
const v=(a:readonly number[])=>new Vector3(a[0],a[1],a[2]);
const q=(a:readonly number[])=>new Quaternion(a[0],a[1],a[2],a[3]).normalize();
const a3=(a:Vector3)=>a.toArray() as V3;
const a4=(a:Quaternion)=>a.toArray() as Q4;

/** A bounded approximation, not a second authoritative Vehicle2 simulation. */
export function vehicleProxy(state:VehicleStateMeters):VehicleProxy {
  const config=state.customVehicle?.configuration;
  if(config) {
    const g=resolveVehicleGeometry(config),d=resolveDrivingSetup(config);
    return {half:[config.dimensions.track*.35,.2,config.dimensions.wheelbase*.5],
      wheels:g.wheelCenters as V3[],radius:config.dimensions.tireRadius,wheelbase:config.dimensions.wheelbase,
      acceleration:d.acceleration,speed:d.topSpeed,grip:d.tyreFriction,braking:config.driving.braking,
      lock:d.maxSteerRadians,response:d.steeringResponse};
  }
  const d=getSharedVehicleDefinition(state.vehicleType);
  return {half:[d.chassisHalfExtents.x,d.chassisHalfExtents.y,d.chassisHalfExtents.z],
    wheels:d.wheelOffsets.map(p=>[p[0],-.17-d.suspensionTravelM*2/3,p[2]]),
    radius:d.wheelRadiusM,wheelbase:Math.abs(d.wheelOffsets[0][2]-d.wheelOffsets[2][2]),
    acceleration:8.57,speed:30,grip:1.4,braking:1,lock:.5,response:1};
}

/** Sweeps the chassis and four coarse wheel spheres; up to three contact planes.
 * Never guesses a global floor, so gaps, bridges and ramps remain meaningful. */
export function moveVehicle(position:V3, rotation:Q4, delta:V3, proxy:VehicleProxy, sweep:Sweep):{position:V3;normals:V3[]} {
  const at=v(position), remaining=v(delta), rotationQ=q(rotation),normals:V3[]=[];
  const offsets=[new Vector3(),...proxy.wheels.map(p=>v(p).applyQuaternion(rotationQ))];
  for(let iteration=0;iteration<3 && remaining.lengthSq()>1e-12;iteration++) {
    let first:ReturnType<Sweep>=null;
    offsets.forEach((offset,i)=>{
      let hit=sweep(a3(at.clone().add(offset)),rotation,a3(remaining),proxy.half,i===0?0:proxy.radius);
      // Wheels roll over road features using Vehicle2's suspension. A proxy
      // must not turn each tread-height bump into a chassis collision impulse.
      // Guard descending contact vertically; retain authoritative travel up a ramp.
      if(hit && hit.normal[1]>.45) {
        hit=remaining.y<0?{fraction:hit.fraction,normal:[0,1,0]}:null;
      }
      if(hit && Number.isFinite(hit.fraction) && hit.fraction>=0 && hit.fraction<=1
        && v(hit.normal).dot(remaining)<-1e-5
        && !normals.some(n=>v(n).dot(v(hit.normal))>.995) && (!first || hit.fraction<first.fraction)) first=hit;
    });
    const hit=first as ReturnType<Sweep>;
    if(!hit) {at.add(remaining);break;}
    at.addScaledVector(remaining,hit.fraction);
    remaining.multiplyScalar(1-hit.fraction);
    const normal=v(hit.normal).normalize();
    remaining.addScaledVector(normal,-Math.min(0,remaining.dot(normal)));
    normals.push(a3(normal));
  }
  return {position:a3(at),normals};
}

type Motion = {sample:VehicleSample; steering:number};
function step(m:Motion,dt:number,proxy:VehicleProxy,sweep:Sweep,input?:InputCmd):Motion {
  const s=m.sample,rotation=q(s.quaternion),velocity=v(s.linearVelocity);
  // Probe only a few cm: do not glue a jumping car to the road below it.
  const support=moveVehicle(s.position,s.quaternion,[0,-.04,0],proxy,sweep);
  const grounded=support.normals.some(n=>n[1]>.45);
  const forward=new Vector3(0,0,1).applyQuaternion(rotation);
  const speed=velocity.dot(forward);
  let steering=m.steering, angular=v(s.angularVelocity);
  if(input && grounded) {
    const t=Math.min(1,Math.max(0,(Math.abs(speed)-6)/22));
    const lock=1-.65*t*t*(3-2*t);
    const target=-input.moveX/127*lock;
    const slew=(Math.abs(target)>Math.abs(steering)?5:8)*proxy.response*dt;
    steering+=Math.max(-slew,Math.min(slew,target-steering));
    const pedal=input.moveY/127, handbrake=(input.buttons&BTN_JUMP)!==0;
    const braking=handbrake || pedal*speed<0 && Math.abs(speed)>1;
    const acceleration=braking?-Math.sign(speed)*Math.min(Math.abs(speed)/dt,proxy.grip*9.81*(handbrake?.5:proxy.braking))
      :pedal*proxy.acceleration*Math.max(0,1-Math.abs(speed)/(pedal<0?8:proxy.speed));
    velocity.addScaledVector(forward,acceleration*dt);
    // Keep authoritative slip/roll/pitch. Only ease yaw toward the steering model.
    const yaw= Math.max(-proxy.grip*9.81/Math.max(2,Math.abs(speed)),
      Math.min(proxy.grip*9.81/Math.max(2,Math.abs(speed)),speed*Math.tan(steering*proxy.lock)/proxy.wheelbase));
    angular.y+=(yaw-angular.y)*(1-Math.exp(-8*dt));
    const turn=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),angular.y*dt);
    const horizontal=new Vector3(velocity.x,0,velocity.z).applyQuaternion(turn);
    velocity.x=horizontal.x;velocity.z=horizontal.z;
  }
  // A resting Vehicle2 suspension can hold the body a few cm above the neutral
  // proxy. Preserve that support height instead of re-dropping it every packet.
  const gravityDelta=!grounded?9.81*dt:0;
  velocity.y-=gravityDelta;
  const displacement=a3(velocity.clone().multiplyScalar(dt));
  displacement[1]+=gravityDelta*dt*.5;
  const moved=moveVehicle(s.position,s.quaternion,displacement,proxy,sweep);
  for(const n of moved.normals) {
    const normal=v(n);velocity.addScaledVector(normal,-Math.min(0,velocity.dot(normal)));
  }
  const angularVelocity=a3(angular);
  const angle=angular.length()*dt;
  if(angle>0) rotation.premultiply(new Quaternion().setFromAxisAngle(angular.normalize(),angle));
  const safeRotation=a4(rotation);
  return {sample:{...s,serverTimeUs:s.serverTimeUs+dt*1e6,position:moved.position,
    quaternion:safeRotation,linearVelocity:a3(velocity),angularVelocity},steering};
}

export function extrapolateVehicle(sample:VehicleSample,seconds:number,proxy:VehicleProxy,sweep:Sweep):VehicleSample {
  const dt=Math.min(MAX_VEHICLE_LEAD_SEC,Math.max(0,seconds));
  return dt>0?step({sample,steering:0},dt,proxy,sweep).sample:sample;
}

/** Input-ack replay for the owning driver. History is bounded; after a prolonged
 * outage we freeze rather than inventing metres of unconfirmed travel. */
export type VehiclePredictionEvent =
  | {type:'vehicle_reconcile'; vehicleId:number; errorM:number; angleRad:number; hard:boolean; ack:number}
  | {type:'vehicle_input_presented'; vehicleId:number; seq:number; delayMs:number};
export class VehiclePresentationPredictor {
  private id:number|null=null;
  private pending:InputCmd[]=[];
  private base:VehicleSample|null=null;
  private raw:VehicleSample|null=null;
  private offset=new Vector3();
  private rotationOffset=new Quaternion();
  private ack:number|null=null;
  private observedAt=0;
  private steering=0;
  private replayError=0;
  private replayMs=0;
  private frameReplayMs=0;
  private stalled=false;
  private latestSeq=0;
  private proxy:VehicleProxy|null=null;
  private cacheBase:VehicleSample|null=null;
  private cacheMotion:Motion|null=null;
  private cacheCount=0;
  private cacheFirst=-1;
  private inputTimes = new Map<number,number>();
  constructor(private readonly sweep:Sweep, private readonly telemetry?: (event:VehiclePredictionEvent)=>void) {}
  /** Called by the renderer-facing runtime, never by internal reconciliation pose reads. */
  presented(now:number):void {
    if(!this.telemetry || !this.raw || this.stalled || this.id===null)return;
    for(const input of this.pending.slice(0,this.cacheCount)) {
      const sent=this.inputTimes.get(input.seq);
      if(sent!==undefined) {
        this.telemetry({type:'vehicle_input_presented',vehicleId:this.id,seq:input.seq,delayMs:Math.max(0,now-sent)});
        this.inputTimes.delete(input.seq);
      }
    }
  }
  reset():void {this.inputTimes.clear();this.id=null;this.pending=[];this.base=this.raw=null;this.offset.set(0,0,0);this.rotationOffset.identity();this.ack=null;this.steering=0;this.replayError=0;this.replayMs=0;this.latestSeq=0;this.frameReplayMs=0;this.stalled=false;this.cacheBase=this.cacheMotion=null;this.cacheCount=0;}
  record(id:number,inputs:InputCmd[]):void {
    if(this.id!==id) {this.reset();this.id=id;}
    if(inputs.length)this.latestSeq=inputs[inputs.length-1].seq;
    if(this.telemetry) {
      const now=performance.now();
      for(const input of inputs) if(!this.inputTimes.has(input.seq))this.inputTimes.set(input.seq,now);
      while(this.inputTimes.size>MAX_PENDING)this.inputTimes.delete(this.inputTimes.keys().next().value!);
    }
    for(const input of inputs) if(this.ack===null || newer(input.seq,this.ack)) this.pending.push(input);
    if(this.pending.length>MAX_PENDING)this.pending.splice(0,this.pending.length-MAX_PENDING);
  }
  observe(id:number,sample:VehicleSample,ack:number,proxy:VehicleProxy,now:number):void {
    if(this.id!==id) {this.reset();this.id=id;}
    if(this.base && sample.serverTimeUs<=this.base.serverTimeUs)return;
    if(this.ack!==null && ack!==this.ack && !newer(ack,this.ack))return;
    this.raw=this.replay();
    const previous=this.pose();
    this.pending=this.pending.filter(i=>newer(i.seq,ack));
    for(const seq of this.inputTimes.keys()) if(!newer(seq,ack))this.inputTimes.delete(seq);
    this.ack=ack;this.base=sample;this.proxy=proxy;this.observedAt=now;this.stalled=false;
    const speed=v(sample.linearVelocity).length();
    this.steering=speed>1?Math.atan(sample.angularVelocity[1]*proxy.wheelbase/speed)/proxy.lock:0;
    this.raw=this.replay();
    if(previous&&this.raw) {
      this.offset.copy(v(previous.position).sub(v(this.raw.position)));
      this.replayError=this.offset.length();
      // Authoritative impacts/teleports take precedence over visual continuity.
      if(this.offset.length()>.35)this.offset.set(0,0,0);
      this.rotationOffset.copy(q(previous.quaternion).multiply(q(this.raw.quaternion).invert()));
      const angleRad=this.rotationOffset.angleTo(new Quaternion());
      if(angleRad>.5)this.rotationOffset.identity();
      this.telemetry?.({type:'vehicle_reconcile',vehicleId:id,errorM:this.replayError,angleRad,
        hard:this.replayError>.35 || angleRad>.5,ack});
    }
  }
  update(dt:number,now:number):void {
    this.stalled=now-this.observedAt>500;
    if(!this.stalled)this.raw=this.replay();
    this.replayMs=this.frameReplayMs;this.frameReplayMs=0;
    const decay=Math.exp(-Math.max(0,dt)/.08);
    this.offset.multiplyScalar(decay);this.rotationOffset.slerp(new Quaternion(),1-decay);
  }
  private replay():VehicleSample|null {
    if(!this.base||!this.proxy)return null;
    const start=performance.now();
    const inputs=this.pending.slice(0,Math.round(MAX_DRIVER_LEAD_SEC/DT));
    const first=inputs[0]?.seq??-1;
    if(this.cacheBase!==this.base || this.cacheFirst!==first || this.cacheCount>inputs.length) {
      this.cacheBase=this.base;this.cacheFirst=first;this.cacheCount=0;
      this.cacheMotion={sample:this.base,steering:this.steering};
    }
    let motion=this.cacheMotion!;
    for(const input of inputs.slice(this.cacheCount)) motion=step(motion,DT,this.proxy,this.sweep,input);
    this.cacheCount=inputs.length;this.cacheMotion=motion;
    this.frameReplayMs+=performance.now()-start;
    return motion.sample;
  }
  pose(renderLeadSec=0):{position:V3;quaternion:Q4}|null {
    if(!this.raw || !this.proxy)return null;
    // Reconciliation smoothing is swept too: it cannot drag a landed car back
    // through the road or a wall while its old visual error decays.
    const presented=renderLeadSec>0&&!this.stalled?extrapolateVehicle(this.raw,Math.min(DT,renderLeadSec),this.proxy,this.sweep):this.raw;
    const moved=moveVehicle(presented.position,presented.quaternion,a3(this.offset),this.proxy,this.sweep);
    return {position:moved.position,quaternion:a4(this.rotationOffset.clone().multiply(q(presented.quaternion)))};
  }
  debug(now:number) {return {stalled:this.stalled,pending:this.pending.length,ack:this.ack??0,latestSeq:this.latestSeq,
    correction:this.offset.length(),replayError:this.replayError,replayMs:this.replayMs,
    snapshotAge:this.base?Math.max(0,now-this.observedAt):-1};}
  resendWindow():InputCmd[]{return this.pending.slice(-3);}
  get vehicleId():number|null{return this.id;}
  get pendingCount():number{return this.pending.length;}
}
