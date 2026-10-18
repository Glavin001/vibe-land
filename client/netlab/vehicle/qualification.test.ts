import {describe,it,expect} from 'vitest';
import {evaluateVehicleQuality} from './evaluate';
import {packetSchedule,LINK_CASES} from './schedule';
import {VEHICLE_QUALITY_SCENARIOS} from './scenarios';
import {QUALITY_VERSION,type QualityEvidence,type QualityFrame,type Wheel} from './contracts';
const contract=VEHICLE_QUALITY_SCENARIOS[0];
const pose=(tick:number)=>({position:[0,1,tick/6] as [number,number,number],quaternion:[0,0,0,1] as [number,number,number,number]});
function tape(role:'driver'|'observer'='driver'):QualityEvidence {
  const lag=role==='observer'?6:0;
  return {version:QUALITY_VERSION,scenario:contract.id,role,startTick:12,endTick:251,observerDelayTicks:lag,lostRecords:0,
    source:'analytic-test-oracle-only',frames:Array.from({length:240},(_,i)=>({tick:i+12,reference:pose(i+12-lag),actual:pose(i+12-lag),sourceTick:i+12,frozen:false})),corrections:[],triggers:[]};
}
const verdict=(e:QualityEvidence)=>evaluateVehicleQuality(e,contract).verdict;
const modify=(e:QualityEvidence,fn:(f:QualityFrame,i:number)=>void)=>{e.frames.forEach(fn);return e;};
const failing=(e:QualityEvidence,id:string)=>expect(evaluateVehicleQuality(e,contract).metrics.find(m=>m.id===id)!.value).toBeGreaterThan(evaluateVehicleQuality(e,contract).metrics.find(m=>m.id===id)!.limit);
describe('vehicle quality adversarial oracles',()=>{
  it('passes correct owner and intentionally delayed spectator',()=>{
    expect(verdict(tape())).toBe('pass');expect(verdict(tape('observer'))).toBe('pass');
  });
  it('rejects constant smooth lag; smoothing cannot buy a quality pass',()=>{
    const lagged=modify(tape(),f=>{f.actual=pose(f.tick-6);});
    expect(verdict(lagged)).toBe('fail');failing(lagged,'position-p95');
  });
  it('does not hide a short bad landing in global p95',()=>{
    const spike=modify(tape(),(f,i)=>{if(i>=90&&i<94)f.actual!.position[1]-=1;});
    expect(evaluateVehicleQuality(spike,contract).metrics.find(m=>m.id==='position-p95')?.value).toBe(0);
    failing(spike,'position-max');failing(spike,'worst-second-position-p95');
    expect(evaluateVehicleQuality(spike,contract).metrics.find(m=>m.id==='position-max')?.witnessTick).toBe(102);
  });
  it('detects repeated small rubberband steps even when position remains inside budget',()=>{
    const jitter=modify(tape(),(f,i)=>{f.actual!.position[0]+=i%2?.14:-.14;});
    failing(jitter,'visual-error-step-max');
  });
  it('allows a real impact shared by oracle and presentation',()=>{
    expect(verdict(modify(tape(),(f,i)=>{if(i>=100){f.actual=pose(112);f.reference=pose(112);}}))).toBe('pass');
  });
  it('detects held poses and missing rendering without treating them as absent evidence',()=>{
    const held=modify(tape(),(f,i)=>{if(i>=90&&i<105)f.actual=pose(102);});failing(held,'held-moving-run');
    const missing=modify(tape(),(f,i)=>{if(i===100)f.actual=null;});failing(missing,'missing-render-run');
  });
  it('blocks incomplete, nonfinite, duplicate, out-of-order or wrongly normalized evidence',()=>{
    const truncated=tape();truncated.frames.pop();expect(verdict(truncated)).toBe('blocked');
    const duplicate=tape();duplicate.frames[3].tick=duplicate.frames[2].tick;expect(verdict(duplicate)).toBe('blocked');
    const nan=tape();nan.frames[5].actual!.position[0]=NaN;expect(verdict(nan)).toBe('blocked');
    const badq=tape();badq.frames[5].actual!.quaternion[3]=2;expect(verdict(badq)).toBe('blocked');
    const lost=tape();lost.lostRecords=1;expect(verdict(lost)).toBe('blocked');
  });
  it('is invariant to quaternion sign; rejects actually wrong orientation',()=>{
    const sign=modify(tape(),f=>{f.actual!.quaternion=[0,0,0,-1];});expect(verdict(sign)).toBe('pass');
    const wrong=modify(tape(),f=>{f.actual!.quaternion=[0,.7071067811865476,0,.7071067811865476];});failing(wrong,'orientation-max');
  });
  it('cannot buy spectator smoothness with unlimited extra buffering',()=>{
    const late=tape('observer');late.observerDelayTicks=60;failing(late,'observer-buffer');
  });
  it('marks a scenario with unrecorded contacts/damage as blocked rather than passing a marker',()=>{
    const landing=VEHICLE_QUALITY_SCENARIOS.find(s=>s.id==='crest-landing')!;
    const e=tape();e.scenario=landing.id;
    expect(evaluateVehicleQuality(e,landing).verdict).toBe('blocked');
    expect(evaluateVehicleQuality(e,landing).problems.some(p=>p.includes('landing trigger'))).toBe(true);
  });
  it('detects real clearance failures and ghost traction on a detached wheel',()=>{
    const custom={...contract,required:['clearance','wheels'] as const};
    const wheel:Wheel={attached:true,grounded:true,tractionN:100,travelM:.1};
    const e=modify(tape(),f=>{f.clearanceM=-.1;f.wheels=Array.from({length:4},()=>({...wheel}));f.referenceWheels=Array.from({length:4},()=>({...wheel}));f.referenceWheels[0].attached=false;});
    const report=evaluateVehicleQuality(e,{...custom,required:[...custom.required]});
    expect(report.verdict).toBe('fail');expect(report.metrics.find(m=>m.id==='detached-wheel-traction')?.value).toBe(100);
    expect(report.metrics.find(m=>m.id==='penetration-max')?.value).toBe(.1);
  });
  it('fails a missing response even if the confirmed event is at the end',()=>{
    const e=tape();e.triggers=[{kind:'impact',tick:e.endTick,responseTick:null}];
    expect(evaluateVehicleQuality(e,{...contract,required:['impact']}).verdict).toBe('fail');
  });
  it('detects old topology resurrection after an apparently successful update',()=>{
    const e=modify(tape(),(f,i)=>{f.referenceTopology={generation:1,revision:2,ownerId:1,membershipHash:'wheel-missing'};f.topology={...f.referenceTopology};if(i===100){f.topology.revision=1;f.topology.membershipHash='intact';}});
    e.triggers=[{kind:'topology',tick:12,responseTick:12}];
    expect(evaluateVehicleQuality(e,{...contract,required:['topology']}).metrics.find(m=>m.id==='topology-rollback-run')?.value).toBe(1);
  });
});
describe('integer-tick network schedules',()=>{
  it.each(LINK_CASES)('is byte-repeatable for $id',link=>{
    expect(JSON.stringify(packetSchedule(720,link,42))).toBe(JSON.stringify(packetSchedule(720,link,42)));
    expect(packetSchedule(720,link,42).every(p=>p.arrivalTick>=p.sourceTick&&Number.isInteger(p.arrivalTick))).toBe(true);
  });
  it('varies seed while preserving deterministic tie ordering',()=>{
    const link=LINK_CASES[4];expect(packetSchedule(720,link,42)).not.toEqual(packetSchedule(720,link,7));
    const p=packetSchedule(720,link,42);expect(p.some(p=>p.copy===1)).toBe(true);
    expect(p.some((v,i)=>i>0&&v.sourceTick<p[i-1].sourceTick)).toBe(true);
  });
  it('drops packets during the outage and recovers after it',()=>{
    const p=packetSchedule(720,LINK_CASES[6],42);
    expect(p.filter(p=>p.arrivalTick>=360&&p.arrivalTick<408).every(p=>p.dropped)).toBe(true);
    expect(p.some(p=>p.arrivalTick>=408&&!p.dropped)).toBe(true);
  });
});

describe('quality data validation',()=>{
 it('blocks a malformed envelope rather than crashing or passing',()=>{
   expect(evaluateVehicleQuality({} as QualityEvidence,contract).verdict).toBe('blocked');
 });
 it('detects accepting an older source after a newer one',()=>{
   const e=tape();e.frames[50].sourceTick=1;failing(e,'accepted-source-rollback');
 });
 it('requires the actual episode, not just valid optional sensor columns',()=>{
   const e=tape();e.frames.forEach(f=>{f.clearanceM=0;});
   expect(evaluateVehicleQuality(e,{...contract,required:['clearance','landing']}).verdict).toBe('blocked');
 });
});

import {compareVehicleQuality,type ComparableReport} from './compare';
describe('non-regression comparisons',()=>{
 const report=():ComparableReport=>({version:QUALITY_VERSION,sourceSha256:'fixed',proxy:{radius:.4},limits:{fixed:true},seeds:[42],cases:[{link:LINK_CASES[0],seed:42,scores:[evaluateVehicleQuality(tape(),contract)]}]});
 it('compares identical reports without using execution time',()=>expect(compareVehicleQuality(report(),report()).noRegressions).toBe(true));
 it('rejects widening thresholds or changing physical setup',()=>{
  const b=report();b.proxy={radius:1};expect(compareVehicleQuality(report(),b).compatible).toBe(false);
  const c=report();c.cases[0].scores[0].metrics[0].limit=99;expect(compareVehicleQuality(report(),c).compatible).toBe(false);
 });
 it('does not average away a single degraded metric',()=>{
  const b=report();b.cases[0].scores[0].metrics[0].value=.1;
  expect(compareVehicleQuality(report(),b).regressions).toHaveLength(1);
 });
 it('rejects omitted cases or missing evidence',()=>{
  const b=report();b.cases=[];expect(compareVehicleQuality(report(),b).noRegressions).toBe(false);
  const c=report();c.cases[0].scores[0].metrics.pop();expect(compareVehicleQuality(report(),c).noRegressions).toBe(false);
 });
});
