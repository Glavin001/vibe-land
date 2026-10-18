import { HZ, LIMITS, QUALITY_VERSION, type QualityEvidence, type QualityMetric, type QualityResult, type ScenarioContract } from './contracts';
import {measureHeightfield} from './heightfield';
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const vector=(v:unknown,n:number):v is number[]=>Array.isArray(v)&&v.length===n&&v.every(finite);
const pose=(p:unknown):boolean=>{
  const value=p as {position?:unknown;quaternion?:unknown}|null;
  return !!value && vector(value.position,3)&&vector(value.quaternion,4)&&Math.abs(Math.hypot(...value.quaternion)-1)<.001;
};
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((v,i)=>v-b[i]));
const angle=(a:number[],b:number[])=>2*Math.acos(Math.min(1,Math.abs(a.reduce((s,v,i)=>s+v*b[i],0))))*180/Math.PI;
const percentile=(values:{value:number;tick:number}[])=>[...values].sort((a,b)=>a.value-b.value||a.tick-b.tick)[Math.max(0,Math.ceil(values.length*.95)-1)];

/** Pure evaluator: no clocks, randomness, GPU, filesystem or scheduling. */
export function evaluateVehicleQuality(e:QualityEvidence, contract:ScenarioContract):QualityResult {
  const problems:string[]=[],metrics:QualityMetric[]=[];
  const result=():QualityResult=>({version:QUALITY_VERSION,scenario:contract.id,role:e.role,
    verdict:problems.length?'blocked':metrics.some(m=>m.value>m.limit)?'fail':'pass',problems,metrics});
  if(!e || !Array.isArray(e.frames)||!Array.isArray(e.corrections)||!Array.isArray(e.triggers)) {
    return {version:QUALITY_VERSION,scenario:contract.id,role:e?.role??'driver',verdict:'blocked',problems:['Malformed evidence envelope'],metrics:[]};
  }
  if(e.version!==QUALITY_VERSION || e.scenario!==contract.id || !['driver','observer'].includes(e.role))problems.push('Schema, role or scenario mismatch');
  if(typeof e.source!=='string' || !e.source || e.lostRecords!==0)problems.push('Missing provenance or lost records');
  if(!Number.isInteger(e.startTick)||!Number.isInteger(e.endTick)||e.startTick<0||e.endTick-e.startTick<120)problems.push('Need at least 120 consecutive evaluation ticks');
  if(!Number.isInteger(e.observerDelayTicks)||e.observerDelayTicks<0 || (e.role==='driver'&&e.observerDelayTicks!==0))problems.push('Invalid comparison timeline');
  if(e.frames.length!==e.endTick-e.startTick+1)problems.push('Incomplete frame coverage');
  for(let i=0;i<e.frames.length;i++) {
    const f=e.frames[i];
    if(!f || f.tick!==e.startTick+i || !pose(f.reference) || (f.actual!==null&&!pose(f.actual))
      || !Number.isInteger(f.sourceTick)||f.sourceTick<0||f.sourceTick>f.tick||typeof f.frozen!=='boolean') {
      problems.push(`Invalid or out-of-order sample at row ${i}`);break;
    }
  }
  for(const c of e.corrections)if(!c || !Number.isInteger(c.tick)||c.tick<e.startTick||c.tick>e.endTick
    ||!finite(c.errorM)||c.errorM<0||!finite(c.angleRad)||c.angleRad<0||typeof c.hard!=='boolean') {
    problems.push('Invalid reconciliation evidence');break;
  }
  if(e.triggers.some(t=>!t || typeof t.kind!=='string' || !Number.isInteger(t.tick)))problems.push('Invalid trigger evidence');
  if(problems.length)return result();
  const measured=e.frames.filter(f=>f.actual!==null);
  function maximum(id:string,values:{value:number;tick:number}[],limit:number,unit:string) {
    if(!values.length)return;
    const worst=values.reduce((a,b)=>b.value>a.value?b:a);
    metrics.push({id,value:worst.value,witnessTick:worst.tick,limit,unit});
  }
  function tail(id:string,values:{value:number;tick:number}[],limit:number,unit:string) {
    if(!values.length)return;
    const p=percentile(values);metrics.push({id,value:p.value,witnessTick:p.tick,limit,unit});
  }
  function longest(id:string,flags:boolean[],limit:number) {
    let length=0,worst=0,at=e.startTick;
    flags.forEach((flag,i)=>{length=flag?length+1:0;if(length>worst){worst=length;at=e.startTick+i-length+1;}});
    metrics.push({id,value:worst,limit,unit:'ticks',witnessTick:at});
  }
  const errors=measured.map(f=>({tick:f.tick,value:distance(f.actual!.position,f.reference.position)}));
  tail('position-p95',errors,LIMITS.positionP95M,'m');
  maximum('position-max',errors,LIMITS.positionMaxM,'m');
  maximum('orientation-max',measured.map(f=>({tick:f.tick,value:angle(f.actual!.quaternion,f.reference.quaternion)})),LIMITS.orientationMaxDeg,'deg');
  // Global p95 can hide a bad landing. Gate the worst complete one-second window too.
  const windows:{tick:number;value:number}[]=[];
  for(let begin=e.startTick;begin+HZ-1<=e.endTick;begin++) {
    const values=errors.filter(v=>v.tick>=begin&&v.tick<begin+HZ);
    if(values.length===HZ)windows.push(percentile(values));
  }
  maximum('worst-second-position-p95',windows,LIMITS.worstSecondPositionP95M,'m');
  const steps:{tick:number;value:number}[]=[],held:boolean[]=[];
  for(let i=0;i<e.frames.length;i++) {
    const f=e.frames[i],p=e.frames[i-1];
    held.push(!!p?.actual&&!!f.actual&&distance(p.reference.position,f.reference.position)>.01&&distance(p.actual.position,f.actual.position)<.001);
    if(p?.actual&&f.actual)steps.push({tick:f.tick,value:Math.hypot(...f.actual.position.map((v,j)=>
      (v-p.actual!.position[j])-(f.reference.position[j]-p.reference.position[j])))});
  }
  maximum('visual-error-step-max',steps,LIMITS.visualErrorStepMaxM,'m/tick');
  longest('missing-render-run',e.frames.map(f=>f.actual===null),0);
  longest('held-moving-run',held,LIMITS.heldRunTicks);
  longest('prediction-frozen-run',e.frames.map(f=>f.frozen),LIMITS.frozenRunTicks);
  longest('accepted-source-rollback',e.frames.map((f,i)=>i>0&&f.sourceTick<e.frames[i-1].sourceTick),0);
  longest('stale-source-run',e.frames.map(f=>f.tick-f.sourceTick>30),LIMITS.staleRunTicks);
  maximum('correction-max',e.corrections.map(c=>({tick:c.tick,value:c.errorM})),LIMITS.correctionMaxM,'m');
  metrics.push({id:'hard-corrections-per-minute',value:e.corrections.filter(c=>c.hard).length*HZ*60/e.frames.length,
    limit:LIMITS.hardCorrectionsPerMinute,unit:'/min',witnessTick:e.corrections.find(c=>c.hard)?.tick??e.startTick});
  if(e.role==='observer')metrics.push({id:'observer-buffer',value:e.observerDelayTicks,limit:LIMITS.observerDelayTicks,unit:'ticks',witnessTick:e.startTick});
  if(contract.required.includes('topology') || contract.required.includes('ownership')) {
    const valid=(t:typeof e.frames[number]['topology'])=>t && Number.isInteger(t.generation)&&Number.isInteger(t.revision)
      &&Number.isInteger(t.ownerId)&&typeof t.membershipHash==='string'&&t.membershipHash.length>0;
    if(e.frames.some(f=>!valid(f.topology)||!valid(f.referenceTopology)))problems.push('Missing authoritative/presented entity generation, owner and topology evidence');
    else {
      longest('topology-mismatch-run',e.frames.map(f=>f.topology!.generation!==f.referenceTopology!.generation
        ||f.topology!.membershipHash!==f.referenceTopology!.membershipHash||f.topology!.ownerId!==f.referenceTopology!.ownerId),2);
      longest('topology-rollback-run',e.frames.map((f,i)=>i>0&&f.topology!.generation===e.frames[i-1].topology!.generation&&f.topology!.revision<e.frames[i-1].topology!.revision),0);
    }
  }
  for(const required of contract.required) {
    if(required==='heightfield') {
      measureHeightfield(e,metrics,problems);
    } else if(required==='clearance') {
      if(e.frames.some(f=>!finite(f.clearanceM))) {problems.push('Missing independent collider clearance samples');continue;}
      maximum('penetration-max',e.frames.map(f=>({tick:f.tick,value:Math.max(0,-f.clearanceM!)})),LIMITS.penetrationMaxM,'m');
      longest('penetration-run',e.frames.map(f=>f.clearanceM! < -LIMITS.penetrationMaxM),LIMITS.penetrationRunTicks);
    } else if(required==='wheels') {
      const wheelValid=(w:NonNullable<typeof e.frames[number]['wheels']>[number])=>w&&typeof w.attached==='boolean'&&typeof w.grounded==='boolean'&&finite(w.tractionN)&&finite(w.travelM);
      if(e.frames.some(f=>!Array.isArray(f.wheels)||f.wheels.length!==4||!f.wheels.every(wheelValid)
        ||!Array.isArray(f.referenceWheels)||f.referenceWheels.length!==4||!f.referenceWheels.every(wheelValid))) {
        problems.push('Missing or invalid four-wheel oracle and presentation samples');continue;
      }
      maximum('detached-wheel-traction',e.frames.map(f=>({tick:f.tick,value:Math.max(0,...f.wheels!.map((w,i)=>!f.referenceWheels![i].attached?Math.abs(w.tractionN):0))})),LIMITS.detachedTractionN,'N');
      longest('wheel-attachment-mismatch-run',e.frames.map(f=>f.wheels!.some((w,i)=>w.attached!==f.referenceWheels![i].attached)),2);
      longest('wheel-contact-mismatch-run',e.frames.map(f=>f.wheels!.some((w,i)=>w.grounded!==f.referenceWheels![i].grounded)),3);
      maximum('suspension-travel-error',e.frames.map(f=>({tick:f.tick,value:Math.max(...f.wheels!.map((w,i)=>Math.abs(w.travelM-f.referenceWheels![i].travelM)))})),LIMITS.wheelTravelErrorM,'m');
    } else {
      const triggers=e.triggers.filter(t=>t.kind===required&&t.tick>=e.startTick&&t.tick<=e.endTick);
      if(!triggers.length){problems.push(`Missing confirmed ${required} trigger (a requested maneuver is not evidence)`);continue;}
      if(triggers.some(t=>!Number.isInteger(t.tick)||(t.responseTick!==null&&(!Number.isInteger(t.responseTick)||t.responseTick<0||t.responseTick>e.endTick)))) {
        problems.push(`Invalid ${required} response tick`);continue;
      }
      maximum(`${required}-response-error`,triggers.map(t=>({tick:t.tick,
        value:t.responseTick===null?e.endTick-t.tick+1:Math.abs(t.responseTick-(t.tick+e.observerDelayTicks))})),contract.responseBudgetTicks,'ticks');
      // An unobserved response must fail even when the trigger happens at the end of the capture.
      if(triggers.some(t=>t.responseTick===null))metrics.push({id:`${required}-missing-response`,value:1,limit:0,unit:'events',witnessTick:triggers.find(t=>t.responseTick===null)!.tick});
    }
  }
  return result();
}
